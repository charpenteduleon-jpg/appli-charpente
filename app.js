// Appli Charpente du Léon – logique de l'application
'use strict';

const VERSION = '1.2.0';
const TAILLE_MAX_PX = 2000;        // côté le plus long d'une page après compression
const QUALITE_JPEG = 0.72;
const TAILLE_MAX_PDF = 15 * 1024 * 1024;
const NB_DERNIERS = 6;
const RAYON_CHANTIER_M = 400;      // même valeur que sur le serveur Google
const SEUIL_RAFALES = 50;          // km/h : au-delà, levage déconseillé
const DELAI_SERVEUR_MS = 45000;
const ATELIER = { lat: 48.6644, lon: -4.1006, nom: 'Cléder (atelier)' };
const STATUTS = ['À venir', 'En cours', 'Terminé', 'Archivé'];

// ===================== Stockage local =====================
function lire(cle, defaut = null) {
  try { const v = localStorage.getItem(cle); return v === null ? defaut : v; } catch { return defaut; }
}
function ecrire(cle, valeur) {
  try { localStorage.setItem(cle, valeur); } catch { /* stockage plein ou indisponible */ }
}
function lireJson(cle, defaut) {
  try { return JSON.parse(lire(cle)) ?? defaut; } catch { return defaut; }
}
const ecrireJson = (cle, v) => ecrire(cle, JSON.stringify(v));

const reglages = {
  get url() { return lire('reglage-url') || ''; },
  get code() { return lire('reglage-code') || ''; },
  ok() { return this.url.startsWith('https://') && this.code.length > 0; },
};

const estInstallee = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ===================== Écran et navigation =====================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (balise, attrs = {}, ...enfants) => {
  const e = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of enfants) if (c !== null && c !== undefined) e.append(c);
  return e;
};

let ongletCourant = 'accueil';
let ecranCourant = 'accueil';
let ecranPrecedent = 'accueil';

function afficher(nom) {
  if (nom !== ecranCourant) ecranPrecedent = ecranCourant;
  ecranCourant = nom;
  for (const e of $$('.ecran')) e.classList.toggle('cache', e.id !== `ecran-${nom}`);
  const ecran = $(`#ecran-${nom}`);
  const onglet = ecran?.dataset.onglet;
  if (onglet) {
    ongletCourant = onglet;
    for (const b of $$('.barre-onglets [data-onglet-vers]')) b.classList.toggle('active', b.dataset.ongletVers === onglet);
  }
  document.body.classList.toggle('sans-barre', ecran?.classList.contains('plein'));
  window.scrollTo(0, 0);
}

function ouvrirOnglet(nom) {
  if (nom === 'accueil') { afficher('accueil'); rafraichirAccueil(); }
  else if (nom === 'chantiers') ouvrirChantiers();
  else if (nom === 'taches') ouvrirTaches();
  else afficher(nom);
}

function retourOnglet() { ouvrirOnglet(ongletCourant); }

let toastMinuteur = null;
function toast(message, genre = '') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${genre}`;
  clearTimeout(toastMinuteur);
  toastMinuteur = setTimeout(() => t.classList.add('cache'), 3500);
}

// ===================== File d'attente hors ligne (IndexedDB) =====================
const BASE = 'charpente-du-leon';
const MAGASIN = 'envois';
let basePromesse = null;

function ouvrirBase() {
  basePromesse ??= new Promise((resoudre, rejeter) => {
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MAGASIN, { keyPath: 'id' });
    req.onsuccess = () => resoudre(req.result);
    req.onerror = () => rejeter(req.error);
  });
  return basePromesse;
}

async function fileAction(mode, fn) {
  const db = await ouvrirBase();
  return new Promise((resoudre, rejeter) => {
    const tx = db.transaction(MAGASIN, mode);
    const req = fn(tx.objectStore(MAGASIN));
    tx.oncomplete = () => resoudre(req && req.result);
    tx.onerror = () => rejeter(tx.error);
  });
}
const fileAjouter = (envoi) => fileAction('readwrite', (s) => s.put(envoi));
const fileRetirer = (id) => fileAction('readwrite', (s) => s.delete(id));
const fileTout = async () => (await fileAction('readonly', (s) => s.getAll())).sort((a, b) => a.cree - b.cree);

const nouvelId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ===================== Serveur Google =====================
async function appelServeur(donnees) {
  if (!reglages.ok()) throw new Error('Réglages incomplets');
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), DELAI_SERVEUR_MS);
  try {
    const reponse = await fetch(reglages.url, {
      method: 'POST',
      // text/plain évite la requête préalable que Google Apps Script ne sait pas traiter
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...donnees, code: reglages.code }),
      redirect: 'follow',
      signal: controle.signal,
    });
    if (!reponse.ok) throw new Error(`Serveur : erreur ${reponse.status}`);
    const json = await reponse.json();
    if (!json.ok) {
      // Le serveur a bien reçu mais refuse : inutile de réessayer (sauf code secret, à corriger dans les réglages)
      const err = new Error(json.erreur || 'Erreur du serveur');
      err.definitive = json.erreur !== 'Code secret incorrect';
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Le serveur met trop de temps à répondre');
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

// Lecture avec cache : affiche tout de suite la dernière valeur connue, puis la met à jour.
async function lireAvecCache(cle, action, extraire, rendu) {
  const enCache = lireJson(cle, null);
  if (enCache !== null) rendu(enCache, true);
  if (!navigator.onLine || !reglages.ok()) { if (enCache === null) rendu(null, true); return; }
  try {
    const res = await appelServeur(action);
    const valeur = extraire(res);
    ecrireJson(cle, valeur);
    rendu(valeur, false);
  } catch (e) {
    console.warn(`Lecture ${cle} impossible`, e);
    if (enCache === null) rendu(null, false, e);
  }
}

// ===================== Envois =====================
let envoiEnCours = false;
const progression = { total: 0, faits: 0 };

async function mettreEnFile(envois) {
  for (const e of envois) await fileAjouter({ ...e, id: e.id || nouvelId(), cree: Date.now() });
  const avant = (await fileTout()).length;
  await viderFile();
  const apres = (await fileTout()).length;
  return { tousPartis: apres === 0, partis: avant - apres };
}

async function viderFile() {
  if (envoiEnCours) return;
  if (!navigator.onLine || !reglages.ok()) { await majEnvois(); return; }
  envoiEnCours = true;
  try {
    const envois = await fileTout();
    progression.total = envois.length;
    progression.faits = 0;
    await majEnvois();
    for (const envoi of envois) {
      try {
        const res = await appelServeur(envoi);
        await fileRetirer(envoi.id);
        noterEnvoi(envoi, res);
      } catch (e) {
        if (e.definitive) {
          await fileRetirer(envoi.id);
          noterEnvoi(envoi, {}, `⚠️ ${e.message}`);
          toast(`Envoi refusé : ${e.message}`, 'erreur');
        } else {
          console.warn('Envoi reporté', envoi.id, e);
          break; // on réessaiera plus tard, dans l'ordre
        }
      }
      progression.faits++;
      await majEnvois();
    }
  } finally {
    envoiEnCours = false;
    progression.total = 0;
    await majEnvois();
  }
}

function noterEnvoi(envoi, res, probleme = '') {
  // Un document de plusieurs pages ne compte qu'une fois, à sa dernière page.
  if ((envoi.action === 'depot' || envoi.action === 'chantier') && envoi.page && envoi.page < envoi.total && !probleme) return;
  const libelles = {
    depot: '📄 Document', chantier: '🏗️ Photos', note: '🎙️ Note', majTache: '✅ Fait', majChantier: '✏️ Chantier',
  };
  let libelle = libelles[envoi.action] || envoi.action;
  if (envoi.type) libelle += ` · ${envoi.type}`;
  const chantier = envoi.chantier || (envoi.action === 'chantier' ? res.nom : '');
  if (chantier) libelle += ` · ${chantier}`;
  if (envoi.action === 'majTache' || envoi.action === 'majChantier') return; // pas utile dans l'historique
  const derniers = lireJson('derniers', []);
  derniers.unshift({ libelle, probleme, quand: Date.now() });
  ecrireJson('derniers', derniers.slice(0, NB_DERNIERS));
}

async function majEnvois() {
  const enAttente = (await fileTout()).length;
  const derniers = lireJson('derniers', []);
  $('#envois').classList.toggle('cache', enAttente === 0 && derniers.length === 0);

  const enCours = envoiEnCours && progression.total > 0;
  $('#progression').classList.toggle('cache', !enCours);
  $('#progression-barre').style.width = enCours ? `${Math.round((progression.faits / progression.total) * 100)}%` : '0';
  $('#file-attente-texte').textContent = enCours
    ? `Envoi en cours… ${progression.faits}/${progression.total}`
    : enAttente ? `⏳ ${enAttente} envoi${enAttente > 1 ? 's' : ''} en attente de réseau` : '';
  $('#btn-renvoyer').classList.toggle('cache', enCours || enAttente === 0);

  const ul = $('#derniers-liste');
  ul.replaceChildren(...derniers.map((d) =>
    el('li', {}, el('span', {}, `${d.libelle}${d.probleme ? ' ' + d.probleme : ''}`), el('span', { class: 'quand' }, quandLisible(d.quand)))));
  majEtat();
}

function majEtat() {
  const etat = $('#etat');
  if (!reglages.ok()) { etat.textContent = 'À configurer : Plus › Réglages'; etat.className = 'etat hors'; }
  else if (!navigator.onLine) { etat.textContent = 'Hors ligne : tout est gardé et partira plus tard'; etat.className = 'etat hors'; }
  else { etat.textContent = 'Connecté'; etat.className = 'etat ok'; }
}

// ===================== Dates =====================
function quandLisible(ms) {
  const d = new Date(ms);
  const auj = new Date();
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === auj.toDateString()) return `aujourd'hui ${heure}`;
  const hier = new Date(auj); hier.setDate(auj.getDate() - 1);
  if (d.toDateString() === hier.toDateString()) return `hier ${heure}`;
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${heure}`;
}

function jourLisible(ms, journee) {
  const d = new Date(ms);
  const auj = new Date();
  const demain = new Date(auj); demain.setDate(auj.getDate() + 1);
  const heure = journee ? 'toute la journée' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === auj.toDateString()) return `Aujourd'hui · ${heure}`;
  if (d.toDateString() === demain.toDateString()) return `Demain · ${heure}`;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' })} · ${heure}`;
}

// ===================== Position GPS =====================
let dernierePosition = lireJson('position', null); // { lat, lon, precision, quand }

function obtenirPosition() {
  return new Promise((resoudre) => {
    if (!('geolocation' in navigator)) { resoudre(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        dernierePosition = { lat: p.coords.latitude, lon: p.coords.longitude, precision: Math.round(p.coords.accuracy), quand: Date.now() };
        ecrireJson('position', dernierePosition);
        resoudre(dernierePosition);
      },
      () => resoudre(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function distanceM(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function distanceLisible(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

const listeChantiers = () => lireJson('chantiers', []).filter((c) => c && typeof c === 'object');

function chantierLePlusProche(pos) {
  let meilleur = null;
  for (const c of listeChantiers()) {
    if (c.lat == null || c.lon == null || c.statut === 'Archivé') continue;
    const d = distanceM(pos.lat, pos.lon, c.lat, c.lon);
    if (d <= RAYON_CHANTIER_M && (!meilleur || d < meilleur.distance)) meilleur = { nom: c.nom, distance: d };
  }
  return meilleur;
}

// ===================== Accueil « Aujourd'hui » =====================
function rafraichirAccueil() {
  const maintenant = new Date();
  $('#accueil-date').textContent = maintenant.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const h = maintenant.getHours();
  $('#accueil-bonjour').textContent = h < 18 ? 'Bonjour Jean-Phi' : 'Bonsoir Jean-Phi';
  $('#bandeau-installer').classList.toggle('cache', estInstallee() || lire('bandeau-installer-ferme') === '1');
  majEnvois();
  chargerMeteo();
  lireAvecCache('agenda', { action: 'agenda' }, (r) => r.evenements, dessinerAgenda);
  chargerTaches();
}

// --- Météo (Open-Meteo, gratuit et sans clé) ---
const METEO = [
  [[0], '☀️', 'Ensoleillé'], [[1, 2], '🌤️', 'Éclaircies'], [[3], '☁️', 'Couvert'], [[45, 48], '🌫️', 'Brouillard'],
  [[51, 53, 55, 56, 57], '🌦️', 'Bruine'], [[61, 63, 65, 66, 67], '🌧️', 'Pluie'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Neige'],
  [[80, 81, 82], '🌧️', 'Averses'], [[95, 96, 99], '⛈️', 'Orage'],
];
const ciel = (code) => METEO.find(([codes]) => codes.includes(code)) || [[], '🌡️', ''];

async function chargerMeteo() {
  const enCache = lireJson('meteo', null);
  if (enCache) dessinerMeteo(enCache);
  if (enCache && Date.now() - enCache.quand < 20 * 60000) return;
  if (!navigator.onLine) return;
  const pos = (dernierePosition && Date.now() - dernierePosition.quand < 3600000) ? dernierePosition : (await obtenirPosition()) || null;
  const lieu = pos || ATELIER;
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lieu.lat.toFixed(4), longitude: lieu.lon.toFixed(4),
    current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m',
    hourly: 'wind_gusts_10m,precipitation_probability',
    daily: 'wind_gusts_10m_max,temperature_2m_max,temperature_2m_min',
    forecast_days: '2', timezone: 'Europe/Paris',
  });
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Météo : ${r.status}`);
    const m = await r.json();
    const proche = pos ? chantierLePlusProche(pos) : null;
    const donnees = { quand: Date.now(), lieu: proche ? proche.nom : pos ? 'Ta position' : ATELIER.nom, m };
    ecrireJson('meteo', donnees);
    dessinerMeteo(donnees);
  } catch (e) {
    console.warn('Météo indisponible', e);
    if (!enCache) $('#meteo-contenu').replaceWith(el('p', { id: 'meteo-contenu', class: 'discret' }, 'Météo indisponible pour le moment.'));
  }
}

function dessinerMeteo({ lieu, m }) {
  const [, ico, libelle] = ciel(m.current.weather_code);
  $('#meteo-lieu').textContent = lieu;
  const maintenant = Date.now();
  const heures = m.hourly.time.map((t, i) => ({ t: new Date(t).getTime(), rafale: m.hourly.wind_gusts_10m[i], pluie: m.hourly.precipitation_probability[i] }));
  const finJournee = new Date(); finJournee.setHours(20, 0, 0, 0);
  const reste = heures.filter((h) => h.t >= maintenant - 3600000 && h.t <= finJournee.getTime());
  const pic = reste.reduce((max, h) => (h.rafale > (max?.rafale ?? -1) ? h : max), null);
  const pluie6h = Math.max(0, ...heures.filter((h) => h.t >= maintenant && h.t <= maintenant + 6 * 3600000).map((h) => h.pluie ?? 0));
  const demainRafales = Math.round(m.daily.wind_gusts_10m_max[1]);

  const bloc = el('div', { id: 'meteo-contenu' },
    el('div', { class: 'meteo' },
      el('span', { class: 'meteo-ico' }, ico),
      el('span', { class: 'meteo-temp' }, `${Math.round(m.current.temperature_2m)}°`),
      el('div', { class: 'meteo-detail' },
        el('div', {}, `${libelle} · ${Math.round(m.daily.temperature_2m_min[0])}° / ${Math.round(m.daily.temperature_2m_max[0])}°`),
        el('div', {}, `Vent ${Math.round(m.current.wind_speed_10m)} km/h · rafales ${Math.round(m.current.wind_gusts_10m)} km/h`),
        el('div', {}, `Pluie dans les 6 h : ${pluie6h} %`))));
  if (pic && pic.rafale >= SEUIL_RAFALES) {
    const h = new Date(pic.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    bloc.append(el('div', { class: 'alerte' }, `⚠️ Rafales jusqu'à ${Math.round(pic.rafale)} km/h vers ${h} : levage déconseillé`));
  } else if (demainRafales >= SEUIL_RAFALES) {
    bloc.append(el('div', { class: 'alerte' }, `⚠️ Demain : rafales jusqu'à ${demainRafales} km/h`));
  } else {
    bloc.append(el('div', { class: 'alerte ok' }, `✓ Vent calme pour le levage aujourd'hui (demain rafales ${demainRafales} km/h)`));
  }
  $('#meteo-contenu').replaceWith(bloc);
}

// --- Agenda ---
function dessinerAgenda(evenements, depuisCache, erreur) {
  const ul = $('#agenda-liste');
  if (!evenements) {
    ul.replaceChildren(el('li', { class: 'vide' }, reglages.ok() ? (erreur ? 'Agenda indisponible pour le moment.' : 'Chargement…') : 'Connecte le serveur pour voir ton agenda.'));
    return;
  }
  const aVenir = evenements.filter((e) => e.fin > Date.now()).slice(0, 3);
  if (!aVenir.length) { ul.replaceChildren(el('li', { class: 'vide' }, 'Rien de prévu dans les 7 jours.')); return; }
  ul.replaceChildren(...aVenir.map((e) => {
    const d = new Date(e.debut);
    return el('li', {},
      el('div', { class: 'agenda-date' }, el('small', {}, d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')), el('b', {}, String(d.getDate()))),
      el('div', { class: 'agenda-texte' }, el('div', {}, e.titre), el('small', {}, `${jourLisible(e.debut, e.journee)}${e.lieu ? ' · ' + e.lieu : ''}`)));
  }));
}

// ===================== Photos : compression et mode scan =====================
async function chargerImage(fichier) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(fichier, { imageOrientation: 'from-image' }); } catch { /* repli ci-dessous */ }
  }
  return new Promise((resoudre, rejeter) => {
    const img = new Image();
    const url = URL.createObjectURL(fichier);
    img.onload = () => { URL.revokeObjectURL(url); resoudre(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rejeter(new Error('Photo illisible')); };
    img.src = url;
  });
}

async function traiterImage(fichier, scan) {
  const img = await chargerImage(fichier);
  const larg = img.width, haut = img.height;
  const echelle = Math.min(1, TAILLE_MAX_PX / Math.max(larg, haut));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(larg * echelle);
  canvas.height = Math.round(haut * echelle);
  const ctx = canvas.getContext('2d', { willReadFrequently: scan });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();
  if (scan) appliquerScan(ctx, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', scan ? 0.68 : QUALITE_JPEG);
}

// Effet « scanner » : niveaux de gris + étirement du contraste (2 % les plus sombres → noir, 2 % les plus clairs → blanc).
function appliquerScan(ctx, l, h) {
  const image = ctx.getImageData(0, 0, l, h);
  const p = image.data;
  const histo = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) {
    const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0;
    p[i] = g; histo[g]++;
  }
  const n = p.length / 4;
  let bas = 0, haut = 255, cumul = 0;
  for (let v = 0; v < 256; v++) { cumul += histo[v]; if (cumul > n * 0.02) { bas = v; break; } }
  cumul = 0;
  for (let v = 255; v >= 0; v--) { cumul += histo[v]; if (cumul > n * 0.02) { haut = v; break; } }
  const plage = Math.max(1, haut - bas);
  const table = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.min(1, Math.max(0, (v - bas) / plage));
    table[v] = 255 * Math.pow(x, 0.85); // léger éclaircissement des gris pour un fond bien blanc
  }
  for (let i = 0; i < p.length; i += 4) { const g = table[p[i]]; p[i] = p[i + 1] = p[i + 2] = g; }
  ctx.putImageData(image, 0, 0);
}

// Tampon façon « preuve de chantier » : bandeau en bas de la photo avec le chantier, la date et l'heure.
function tamponner(dataUrl, texte) {
  return new Promise((resoudre) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const taille = Math.max(16, Math.round(c.width / 38));
      const hauteur = Math.round(taille * 2.1);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, c.height - hauteur, c.width, hauteur);
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${taille}px -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(texte, Math.round(taille * 0.7), c.height - hauteur / 2, c.width - taille * 1.4);
      resoudre(c.toDataURL('image/jpeg', QUALITE_JPEG));
    };
    img.onerror = () => resoudre(dataUrl);
    img.src = dataUrl;
  });
}

function lireFichier(fichier) {
  return new Promise((resoudre, rejeter) => {
    const r = new FileReader();
    r.onload = () => resoudre(r.result);
    r.onerror = () => rejeter(new Error('Fichier illisible'));
    r.readAsDataURL(fichier);
  });
}

// ===================== Écran document (dépôt ou photos de chantier) =====================
const doc = { action: 'depot', pages: [], type: '', position: null };

function nouveauDocument(action, chantierChoisi = '', ouvrirAppareil = true) {
  doc.action = action;
  doc.pages = [];
  doc.type = '';
  doc.position = null;
  const chantier = action === 'chantier';
  $('#doc-titre').textContent = chantier ? 'Photos de chantier' : 'Nouveau document';
  $('#btn-ajouter-page').textContent = chantier ? '📷 Prendre une photo' : '📷 Prendre en photo';
  $('#bloc-scan').classList.toggle('cache', chantier);
  $('#bloc-type').classList.toggle('cache', chantier);
  $('#bloc-tampon').classList.toggle('cache', !chantier);
  $('#tampon').checked = lire('tampon', '1') === '1';
  $('#mode-scan').checked = lire('mode-scan', '1') === '1';
  $('#chantier-facultatif').textContent = chantier ? '' : '(facultatif)';
  $('#doc-note').value = '';
  $('#chantier-libre').value = '';
  for (const b of $$('#types-doc .puce')) b.classList.remove('active');
  dessinerPages();
  remplirSelectChantiers($('#chantier-select'), chantierChoisi, chantier ? '— Choisir le chantier —' : '— Aucun —');
  afficher('document');
  if (ouvrirAppareil) $('#photo-input').click(); // ouvre directement l'appareil photo (doit rester dans le geste)
  localiserPourDocument(chantierChoisi);
  rafraichirChantiers().then(() => remplirSelectChantiers($('#chantier-select'), $('#chantier-select').value || chantierChoisi,
    chantier ? '— Choisir le chantier —' : '— Aucun —'));
}

async function localiserPourDocument(chantierChoisi) {
  const etat = $('#gps-etat');
  etat.className = 'gps';
  etat.textContent = '📍 Recherche de ta position…';
  const pos = await obtenirPosition();
  doc.position = pos;
  if (!pos) {
    etat.textContent = doc.action === 'chantier' && !chantierChoisi ? '📍 Position indisponible : choisis le chantier.' : '';
    return;
  }
  if (chantierChoisi) { etat.className = 'gps trouve'; etat.textContent = `📍 Position notée pour ${chantierChoisi}`; return; }
  const proche = chantierLePlusProche(pos);
  if (proche) {
    $('#chantier-select').value = proche.nom;
    etat.className = 'gps trouve';
    etat.textContent = `📍 Tu es sur ${proche.nom} (${distanceLisible(proche.distance)})`;
  } else {
    etat.textContent = doc.action === 'chantier' ? '📍 Chantier inconnu ici : choisis-le, je retiendrai l\'endroit.' : '';
  }
}

async function ajouterFichiers(fichiers) {
  const scan = doc.action === 'depot' && $('#mode-scan').checked;
  for (const f of fichiers) {
    try {
      if (f.type === 'application/pdf') {
        if (f.size > TAILLE_MAX_PDF) { toast('PDF trop lourd (15 Mo maximum).', 'erreur'); continue; }
        doc.pages.push({ type: 'pdf', nom: f.name, data: await lireFichier(f) });
      } else {
        doc.pages.push({ type: 'image', source: f, data: await traiterImage(f, scan) });
      }
    } catch (e) { toast(e.message, 'erreur'); }
    dessinerPages();
  }
}

async function retraiterPages() {
  const scan = $('#mode-scan').checked;
  ecrire('mode-scan', scan ? '1' : '0');
  for (const p of doc.pages) if (p.type === 'image' && p.source) p.data = await traiterImage(p.source, scan);
  dessinerPages();
}

function dessinerPages() {
  const zone = $('#pages');
  if (!doc.pages.length) {
    zone.replaceChildren(el('div', { class: 'pages-vide' }, doc.action === 'chantier' ? 'Aucune photo pour l\'instant' : 'Aucune page pour l\'instant'));
  } else {
    zone.replaceChildren(...doc.pages.map((p, i) => el('div', { class: 'page' },
      p.type === 'pdf' ? el('div', { class: 'pdf' }, `📄\n${p.nom}`) : el('img', { src: p.data, alt: `Page ${i + 1}` }),
      el('span', { class: 'num' }, doc.action === 'chantier' ? `${i + 1}` : `Page ${i + 1}`),
      el('button', { class: 'suppr', 'aria-label': 'Retirer', onclick: () => { doc.pages.splice(i, 1); dessinerPages(); } }, '×'))));
  }
  const n = doc.pages.length;
  $('#btn-envoyer-doc').disabled = n === 0;
  $('#btn-envoyer-doc').textContent = n > 1 ? `Ajouter (${n} ${doc.action === 'chantier' ? 'photos' : 'pages'})` : 'Ajouter';
}

async function envoyerDocument() {
  const chantierSaisi = $('#chantier-libre').value.trim() || $('#chantier-select').value;
  if (doc.action === 'chantier' && !chantierSaisi) { toast('Choisis le chantier (ou tape son nom).', 'erreur'); return; }
  $('#btn-envoyer-doc').disabled = true;
  const pos = doc.position;
  const commun = {
    action: doc.action, docId: nouvelId(), date: new Date().toISOString(), total: doc.pages.length,
    type: doc.type, chantier: chantierSaisi, note: $('#doc-note').value.trim(),
    ...(pos ? { lat: pos.lat, lon: pos.lon, precision: pos.precision } : {}),
  };
  if (doc.action === 'chantier' && $('#tampon').checked) {
    const quand = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    for (const p of doc.pages) if (p.type === 'image') p.data = await tamponner(p.data, `${chantierSaisi} · ${quand} · Charpente du Léon`);
  }
  const envois = doc.pages.map((p, i) => ({
    ...commun, page: i + 1,
    fichier: { mime: p.type === 'pdf' ? 'application/pdf' : 'image/jpeg', data: p.data.split(',')[1] },
  }));
  // Chantier choisi à un endroit inconnu : on retient sa position tout de suite sur le téléphone aussi.
  if (doc.action === 'chantier' && pos) {
    const liste = listeChantiers();
    const c = liste.find((x) => x.nom === chantierSaisi);
    if (c && c.lat == null) { c.lat = pos.lat; c.lon = pos.lon; ecrireJson('chantiers', liste); }
  }
  doc.pages = [];
  ouvrirOnglet('accueil');
  toast('Envoi en cours…');
  const { tousPartis } = await mettreEnFile(envois);
  if (tousPartis) toast(doc.action === 'chantier' ? 'Photos rangées ✅' : 'Document reçu ✅ Je m\'en occupe.', 'ok');
  else if (!reglages.ok()) toast('Gardé sur le téléphone. Configure le serveur dans Plus › Réglages.', 'erreur');
  else toast('Pas de réseau : gardé, il partira tout seul.');
}

// ===================== Chantiers =====================
async function rafraichirChantiers() {
  if (!navigator.onLine || !reglages.ok()) return listeChantiers();
  try {
    const res = await appelServeur({ action: 'chantiers' });
    ecrireJson('chantiers', res.chantiers);
    return res.chantiers;
  } catch (e) {
    console.warn('Liste des chantiers indisponible', e);
    return listeChantiers();
  }
}

function remplirSelectChantiers(select, choisi, premier) {
  const options = [el('option', { value: '' }, premier)];
  for (const c of listeChantiers()) {
    const o = el('option', { value: c.nom }, c.nom);
    if (c.nom === choisi) o.selected = true;
    options.push(o);
  }
  if (choisi && !listeChantiers().some((c) => c.nom === choisi)) options.push(Object.assign(el('option', { value: choisi }, choisi), { selected: true }));
  select.replaceChildren(...options);
}

let filtreStatut = '';
let triDistance = false;

async function ouvrirChantiers() {
  afficher('chantiers');
  dessinerChantiers();
  await rafraichirChantiers();
  dessinerChantiers();
}

const COULEURS = ['#1c4587', '#1f9d55', '#e67e22', '#8e44ad', '#c0392b', '#16a085', '#2c3e50', '#d35400'];
const couleurDe = (texte) => COULEURS[[...texte].reduce((s, c) => s + c.charCodeAt(0), 0) % COULEURS.length];
const initiales = (nom) => nom.split(/[\s-]+/).filter((m) => /^[A-Za-zÀ-ÿ]/.test(m)).slice(0, 2).map((m) => m[0].toUpperCase()).join('');
const classeStatut = (s) => ({ 'En cours': 'en-cours', 'À venir': 'a-venir', 'Terminé': 'termine' }[s] || '');

function dessinerChantiers() {
  const filtre = $('#chantiers-recherche').value.trim().toLowerCase();
  const pos = triDistance ? dernierePosition : null;
  const elements = listeChantiers()
    .filter((c) => !filtreStatut || c.statut === filtreStatut)
    .filter((c) => !filtre || `${c.nom} ${c.client}`.toLowerCase().includes(filtre))
    .map((c) => ({ ...c, distance: pos && c.lat != null ? distanceM(pos.lat, pos.lon, c.lat, c.lon) : null }));
  if (pos) elements.sort((a, b) => (a.distance ?? 1e12) - (b.distance ?? 1e12));

  const ul = $('#chantiers-liste');
  if (!elements.length) {
    ul.replaceChildren(el('li', { class: 'etat-vide' }, el('span', {}, '🏗️'),
      !reglages.ok() ? 'Connecte d\'abord le serveur (Plus › Réglages).' : filtre || filtreStatut ? 'Aucun chantier ne correspond.' : 'Aucun chantier pour l\'instant.'));
    return;
  }
  ul.replaceChildren(...elements.map((c) => el('li', { class: classeStatut(c.statut) },
    el('button', { onclick: () => ouvrirFiche(c.nom) },
      el('span', { class: 'avatar', style: `background:${couleurDe(c.nom)}` }, initiales(c.nom) || '🏗️'),
      el('span', { class: 'corps' }, el('div', { class: 'nom' }, c.nom), el('div', { class: 'info' }, c.client || ' ')),
      el('span', { class: 'droite' },
        c.statut ? el('span', { class: `statut ${classeStatut(c.statut)}` }, c.statut) : null,
        c.distance != null ? el('span', { class: 'dist' }, distanceLisible(c.distance)) : null)))));
}

let ficheCourante = null;

async function ouvrirFiche(nom) {
  ficheCourante = { nom };
  $('#fiche-titre').textContent = nom;
  $('#fiche-sous-titre').textContent = '';
  $('#fiche-infos').open = false;
  $('#fiche-contenu').replaceChildren(el('div', { class: 'carte squelette', style: 'height:120px' }), el('div', { class: 'carte squelette', style: 'height:90px' }));
  afficher('fiche');
  lireAvecCache(`fiche:${nom}`, { action: 'fiche', chantier: nom }, (r) => {
    // On garde la fiche sans les vignettes (trop lourdes pour le stockage du téléphone).
    const { rubriques, ...reste } = r.fiche;
    ficheEnMemoire = r.fiche;
    return { ...reste, rubriques: rubriques.map(({ vignettes, ...x }) => x) };
  }, (fiche, depuisCache, erreur) => {
    if (ficheCourante?.nom !== nom) return;
    if (!fiche) {
      $('#fiche-contenu').replaceChildren(el('p', { class: 'etat-vide' }, el('span', {}, '📡'),
        !reglages.ok() ? 'Connecte d\'abord le serveur (Plus › Réglages).' : erreur ? `Fiche indisponible : ${erreur.message}` : 'Pas de réseau : la fiche s\'affichera dès que possible.'));
      return;
    }
    dessinerFiche(!depuisCache && ficheEnMemoire ? ficheEnMemoire : fiche);
  });
}
let ficheEnMemoire = null;

function dessinerFiche(f) {
  ficheCourante = f;
  $('#fiche-sous-titre').textContent = [f.client, f.adresse].filter(Boolean).join(' · ') || 'Complète les infos du chantier ci-dessous';
  $('#fiche-drive').href = f.dossier;
  const tel = (f.telephone || '').replace(/[^\d+]/g, '');
  $('#fiche-appeler').classList.toggle('cache', !tel);
  if (tel) $('#fiche-appeler').href = `tel:${tel}`;
  const itin = $('#fiche-itineraire');
  itin.classList.toggle('cache', f.lat == null && !f.adresse);
  if (f.lat != null || f.adresse) itin.href = `https://maps.apple.com/?daddr=${f.lat != null ? `${f.lat},${f.lon}` : encodeURIComponent(f.adresse)}`;

  $('#fiche-statut').replaceChildren(...(f.statuts || STATUTS).map((s) =>
    el('button', { class: s === f.statut ? 'active' : '', onclick: () => changerStatut(s) }, s)));
  $('#fiche-client').value = f.client || '';
  $('#fiche-tel').value = f.telephone || '';
  $('#fiche-adresse').value = f.adresse || '';

  const blocs = [];
  if (f.evenements?.length) {
    blocs.push(el('section', { class: 'carte' }, el('h2', {}, '📅 Prochains rendez-vous'),
      el('ul', { class: 'liste-simple' }, ...f.evenements.map((e) => el('li', {},
        el('div', { class: 'agenda-texte' }, el('div', {}, e.titre), el('small', {}, jourLisible(e.debut, e.journee))))))));
  }
  const icones = { 'Plans': '📐', 'Devis & contrat': '📝', 'Achats': '🧾', 'Photos': '📷', 'Divers': '📎' };
  const ordre = ['Photos', 'Plans', 'Devis & contrat', 'Achats', 'Divers'];
  for (const titre of ordre) {
    const r = f.rubriques.find((x) => x.titre === titre);
    if (!r) continue;
    const bloc = el('section', { class: 'carte rubrique' },
      el('h2', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, `${icones[r.titre] || '📁'} ${r.titre}`), el('span', { class: 'nb' }, String(r.total))));
    if (r.vignettes?.length) {
      bloc.append(el('div', { class: 'vignettes' }, ...r.vignettes.map((v) =>
        el('a', { href: v.url, target: '_blank', rel: 'noopener' }, el('img', { src: `data:image/jpeg;base64,${v.data}`, alt: 'Photo du chantier', loading: 'lazy' })))));
    } else if (r.fichiers.length) {
      for (const fi of r.fichiers.slice(0, 8)) {
        bloc.append(el('a', { class: 'fichier', href: fi.url, target: '_blank', rel: 'noopener' },
          el('span', {}, fi.type === 'application/pdf' ? '📄' : fi.type?.startsWith('image/') ? '🖼️' : '📎'), el('span', {}, fi.nom)));
      }
      if (r.total > 8) bloc.append(el('a', { class: 'fichier', href: r.url, target: '_blank', rel: 'noopener' }, el('span', {}, '…'), el('span', {}, `Voir les ${r.total}`)));
    } else {
      bloc.append(el('p', { class: 'discret' }, titre === 'Photos' ? 'Pas encore de photo : touche 📷 Photos.' : 'Rien pour l\'instant.'));
    }
    blocs.push(bloc);
  }
  const notes = el('section', { class: 'carte' }, el('h2', {}, '🎙️ Notes'));
  if (f.notes?.length) {
    notes.append(el('ul', { class: 'liste-simple' }, ...f.notes.map((n) =>
      el('li', {}, el('div', { class: 'agenda-texte' }, el('div', { style: 'white-space:normal' }, n.texte), el('small', {}, `${n.date} · ${n.type}${n.statut === 'Fait' ? ' · fait' : ''}`))))));
  } else {
    notes.append(el('p', { class: 'discret' }, 'Aucune note : touche 🎙️ Note.'));
  }
  blocs.push(notes);
  $('#fiche-contenu').replaceChildren(...blocs);
}

async function changerStatut(statut) {
  if (!ficheCourante?.nom) return;
  ficheCourante.statut = statut;
  for (const b of $$('#fiche-statut button')) b.classList.toggle('active', b.textContent === statut);
  const liste = listeChantiers();
  const c = liste.find((x) => x.nom === ficheCourante.nom);
  if (c) { c.statut = statut; ecrireJson('chantiers', liste); }
  await mettreEnFile([{ action: 'majChantier', chantier: ficheCourante.nom, statut }]);
  toast(`Statut : ${statut}`, 'ok');
}

async function enregistrerInfosChantier() {
  if (!ficheCourante?.nom) return;
  const maj = { client: $('#fiche-client').value.trim(), telephone: $('#fiche-tel').value.trim(), adresse: $('#fiche-adresse').value.trim() };
  Object.assign(ficheCourante, maj);
  const liste = listeChantiers();
  const c = liste.find((x) => x.nom === ficheCourante.nom);
  if (c) { c.client = maj.client; ecrireJson('chantiers', liste); }
  await mettreEnFile([{ action: 'majChantier', chantier: ficheCourante.nom, ...maj }]);
  $('#fiche-infos').open = false;
  dessinerFiche(ficheCourante);
  toast('Infos enregistrées ✅', 'ok');
}

// ===================== À faire =====================
// Les tâches cochées ou ajoutées hors ligne s'affichent tout de suite, avant l'accord du serveur.
const tachesLocales = () => lireJson('taches-locales', []);
const tachesFaites = () => new Set(lireJson('taches-faites', []));

function tachesAffichees() {
  const faites = tachesFaites();
  const serveur = (lireJson('taches', []) || []).filter((t) => !faites.has(t.texte));
  const locales = tachesLocales().filter((t) => !faites.has(t.texte) && !serveur.some((s) => s.texte === t.texte));
  return [...locales, ...serveur];
}

function chargerTaches() {
  majTachesAffichage();
  lireAvecCache('taches', { action: 'taches' }, (r) => r.taches, () => {
    // Nettoyage : ce que le serveur connaît n'a plus besoin d'être gardé en local.
    const serveur = lireJson('taches', []) || [];
    ecrireJson('taches-locales', tachesLocales().filter((t) => !serveur.some((s) => s.texte === t.texte)));
    ecrireJson('taches-faites', [...tachesFaites()].filter((texte) => serveur.some((s) => s.texte === texte)));
    majTachesAffichage();
  });
}

function majTachesAffichage() {
  const taches = tachesAffichees();
  const n = taches.length;
  const pastille = $('#pastille-taches');
  pastille.textContent = n > 9 ? '9+' : String(n);
  pastille.classList.toggle('cache', n === 0);
  if ('setAppBadge' in navigator) {
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  // Résumé sur l'accueil
  $('#accueil-taches').replaceChildren(...(n
    ? taches.slice(0, 3).map((t) => el('li', {}, el('span', {}, '○'), el('span', {}, t.texte)))
    : [el('li', { class: 'vide' }, 'Rien à faire pour l\'instant 👍')]));
  // Liste complète
  if (ecranCourant === 'taches') dessinerTaches(taches);
}

function ouvrirTaches() {
  afficher('taches');
  dessinerTaches(tachesAffichees());
  chargerTaches();
}

function dessinerTaches(taches) {
  const ul = $('#taches-liste');
  if (!taches.length) {
    ul.replaceChildren(el('li', { class: 'etat-vide', style: 'box-shadow:none;background:none;display:block' }, el('span', {}, '🎉'), 'Tout est fait !'));
    return;
  }
  ul.replaceChildren(...taches.map((t) => {
    const li = el('li', {});
    const caseBtn = el('button', { class: 'case', 'aria-label': 'Marquer comme fait' });
    caseBtn.onclick = async () => {
      caseBtn.classList.add('cochee');
      li.classList.add('fait');
      ecrireJson('taches-faites', [...tachesFaites(), t.texte]);
      setTimeout(majTachesAffichage, 300);
      await mettreEnFile([{ action: 'majTache', ligne: t.ligne || 0, texte: t.texte, statut: 'Fait' }]);
    };
    li.append(caseBtn, el('div', {}, el('div', { class: 'texte' }, t.texte),
      el('small', {}, [t.chantier, t.date, t.locale ? '⏳ en attente d\'envoi' : ''].filter(Boolean).join(' · '))));
    return li;
  }));
}

async function ajouterTache() {
  const champ = $('#tache-nouvelle');
  const texte = champ.value.trim();
  if (!texte) return;
  champ.value = '';
  const date = new Date().toISOString();
  ecrireJson('taches-locales', [{ texte, date: new Date().toLocaleDateString('fr-FR'), locale: true }, ...tachesLocales()]);
  majTachesAffichage();
  await mettreEnFile([{ action: 'note', texte, type: 'À faire', date }]);
  chargerTaches();
}

// ===================== Notes =====================
let typeNote = 'À faire';

function ouvrirNote(chantier = '') {
  $('#note-texte').value = '';
  typeNote = 'À faire';
  for (const b of $$('#types-note .puce')) b.classList.toggle('active', b.dataset.type === typeNote);
  remplirSelectChantiers($('#note-chantier'), chantier, '— Aucun —');
  afficher('note');
  setTimeout(() => $('#note-texte').focus(), 250);
}

async function envoyerNote() {
  const texte = $('#note-texte').value.trim();
  if (!texte) { toast('Écris ou dicte ta note.', 'erreur'); return; }
  const chantier = $('#note-chantier').value;
  const date = new Date().toISOString();
  if (typeNote === 'À faire') {
    ecrireJson('taches-locales', [{ texte, chantier, date: new Date().toLocaleDateString('fr-FR'), locale: true }, ...tachesLocales()]);
  }
  const retour = ecranPrecedent === 'fiche' ? 'fiche' : null;
  if (retour) afficher('fiche'); else ouvrirOnglet(ongletCourant);
  majTachesAffichage();
  const { tousPartis } = await mettreEnFile([{ action: 'note', texte, type: typeNote, chantier, date }]);
  toast(tousPartis ? 'Note enregistrée ✅' : 'Note gardée, elle partira dès que possible.', tousPartis ? 'ok' : '');
}

// ===================== Point du jour =====================
function ouvrirPoint() {
  afficher('point');
  chargerPoint();
}

function chargerPoint() {
  $('#btn-actualiser-point').textContent = 'Chargement…';
  lireAvecCache('point', { action: 'point' }, (r) => r.point && { ...r.point, date: new Date(r.point.date).getTime() }, (p, depuisCache, erreur) => {
    if (!depuisCache || erreur) $('#btn-actualiser-point').textContent = 'Actualiser';
    if (!p) {
      $('#point-date').textContent = '';
      $('#point-contenu').textContent = !reglages.ok() ? 'Connecte d\'abord le serveur (Plus › Réglages).' : erreur ? `Point indisponible : ${erreur.message}` : 'Pas encore de point disponible.';
      return;
    }
    $('#point-date').textContent = `${p.sujet} · ${quandLisible(p.date)}`;
    $('#point-contenu').textContent = p.texte;
  });
  if (!navigator.onLine || !reglages.ok()) $('#btn-actualiser-point').textContent = 'Actualiser';
}

// ===================== Demander à Claude =====================
function ouvrirClaude() {
  const texte = $('#claude-texte').value.trim();
  // L'appli Claude s'ouvre si elle est installée (lien universel claude.ai).
  window.location.href = texte ? `https://claude.ai/new?q=${encodeURIComponent(texte)}` : 'https://claude.ai/new';
}

// ===================== Calculs de charpente =====================
const nombre = (sel) => { const v = parseFloat(String($(sel).value).replace(',', '.')); return Number.isFinite(v) ? v : null; };
const fr = (v, dec = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const RAD = Math.PI / 180;

function calculerPente(source) {
  if (source === 'pct') {
    const pct = nombre('#calc-pct');
    $('#calc-deg').value = pct === null ? '' : fr(Math.atan(pct / 100) / RAD, 1);
  } else {
    const deg = nombre('#calc-deg');
    $('#calc-pct').value = deg === null || deg >= 90 ? '' : fr(Math.tan(deg * RAD) * 100, 1);
  }
}

function calculerRampant() {
  const portee = nombre('#calc-portee'), pente = nombre('#calc-pente');
  const debord = nombre('#calc-debord') ?? 0, longueur = nombre('#calc-long');
  const ul = $('#calc-resultats');
  if (portee === null || pente === null || pente <= 0 || pente >= 90) {
    ul.replaceChildren(el('li', {}, el('span', { class: 'discret' }, 'Renseigne la portée et la pente.')));
    return;
  }
  const demi = portee / 2;
  const hauteur = demi * Math.tan(pente * RAD);
  const rampant = demi / Math.cos(pente * RAD);
  const rampantDebord = (demi + debord) / Math.cos(pente * RAD);
  const lignes = [
    ['Hauteur sous faîtage', `${fr(hauteur)} m`],
    ['Rampant (sans débord)', `${fr(rampant)} m`],
    ['Longueur de chevron', `${fr(rampantDebord)} m`],
    ['Pente', `${fr(Math.tan(pente * RAD) * 100, 0)} %`],
  ];
  if (longueur !== null) {
    const surface = 2 * longueur * rampantDebord;
    lignes.push(['Surface couverture (2 pans)', `${fr(surface, 1)} m²`], ['Avec 10 % de chutes', `${fr(surface * 1.1, 1)} m²`]);
  }
  ul.replaceChildren(...lignes.map(([a, b]) => el('li', {}, el('span', {}, a), el('b', {}, b))));
}

// ===================== Réglages et autorisations =====================
function ouvrirReglages() {
  $('#reglage-url').value = reglages.url;
  $('#reglage-code').value = reglages.code;
  afficher('reglages');
  dessinerAutorisations();
}

function enregistrerReglages() {
  ecrire('reglage-url', $('#reglage-url').value.trim());
  ecrire('reglage-code', $('#reglage-code').value.trim());
}

async function testerConnexion() {
  enregistrerReglages();
  const b = $('#btn-tester');
  b.textContent = 'Test…';
  try {
    const res = await appelServeur({ action: 'ping' });
    toast(`Connexion OK ✅ ${res.compte || ''}`, 'ok');
    viderFile();
    rafraichirChantiers();
  } catch (e) {
    toast(`Échec : ${e.message}`, 'erreur');
  } finally {
    b.textContent = 'Tester';
  }
}

async function etatPosition() {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p) return p.state; // granted, denied, prompt
  } catch { /* API absente */ }
  return dernierePosition ? 'granted' : 'prompt';
}

const etatNotifications = () => ('Notification' in window ? Notification.permission : 'indisponible');

async function demanderAutorisation(quoi) {
  if (quoi === 'position') {
    const pos = await obtenirPosition();
    toast(pos ? 'Position autorisée ✅' : 'Position refusée : voir Réglages de l\'iPhone.', pos ? 'ok' : 'erreur');
  } else if (quoi === 'notifications') {
    if (!('Notification' in window)) {
      toast(estInstallee() ? 'Notifications non disponibles sur cet iPhone (iOS 16.4 minimum).' : 'Installe d\'abord l\'appli sur l\'écran d\'accueil.', 'erreur');
      return;
    }
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? 'Notifications autorisées ✅' : 'Notifications refusées.', r === 'granted' ? 'ok' : 'erreur');
    majTachesAffichage();
  }
  dessinerAutorisations();
  majBienvenue();
}

async function dessinerAutorisations() {
  const libelle = { granted: ['Autorisée', 'ok'], denied: ['Refusée', 'non'], prompt: ['À autoriser', ''], default: ['À autoriser', ''], indisponible: ['Installe l\'appli d\'abord', ''] };
  const pos = await etatPosition();
  const notif = etatNotifications();
  let persistant = false;
  try { persistant = await navigator.storage?.persisted?.(); } catch { /* ignoré */ }
  const ligne = (ico, texte, etat, action) => el('li', {}, el('button', { onclick: action || null },
    el('span', {}, ico), texte, el('b', { class: `valeur ${etat[1]}` }, etat[0])));
  $('#autorisations').replaceChildren(
    ligne('📲', 'Appli installée', estInstallee() ? ['Oui', 'ok'] : ['Non (Safari)', 'non']),
    ligne('📍', 'Position', libelle[pos] || libelle.prompt, () => demanderAutorisation('position')),
    ligne('🔔', 'Notifications (pastille)', libelle[notif] || libelle.prompt, () => demanderAutorisation('notifications')),
    ligne('📷', 'Appareil photo', ['Demandé au 1er dépôt', '']),
    ligne('💾', 'Données gardées par l\'iPhone', persistant ? ['Oui', 'ok'] : ['Normal', '']),
  );
}

async function viderDonnees() {
  const enAttente = (await fileTout()).length;
  if (enAttente) { toast(`Impossible : ${enAttente} envoi(s) pas encore partis.`, 'erreur'); return; }
  for (const cle of Object.keys(localStorage)) {
    if (!cle.startsWith('reglage-') && cle !== 'bienvenue-ok') localStorage.removeItem(cle);
  }
  toast('Cache effacé ✅', 'ok');
}

// ===================== Bienvenue =====================
function ouvrirBienvenue() {
  afficher('bienvenue');
  majBienvenue();
}

async function majBienvenue() {
  $('#etape-installer').classList.toggle('ok', estInstallee());
  $('#etape-serveur').classList.toggle('ok', reglages.ok());
  $('#etape-position').classList.toggle('ok', (await etatPosition()) === 'granted');
  $('#etape-notifications').classList.toggle('ok', etatNotifications() === 'granted');
}

// ===================== Mises à jour de l'appli =====================
function surveillerMisesAJour() {
  if (!('serviceWorker' in navigator)) return;
  const avaitControleur = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (avaitControleur) $('#bandeau-maj').classList.remove('cache');
  });
}

// ===================== Branchements =====================
document.addEventListener('DOMContentLoaded', () => {
  $('#version').textContent = `Charpente du Léon · version ${VERSION}`;

  // Navigation
  for (const b of $$('[data-onglet-vers]')) b.onclick = () => ouvrirOnglet(b.dataset.ongletVers);
  for (const b of $$('[data-retour]')) b.onclick = retourOnglet;
  for (const b of $$('[data-retour-vers]')) b.onclick = () => ouvrirOnglet(b.dataset.retourVers);
  for (const b of $$('[data-annuler]')) b.onclick = () => (ecranPrecedent === 'fiche' ? afficher('fiche') : retourOnglet());
  for (const b of $$('[data-ferme]')) b.onclick = () => { $(`#${b.dataset.ferme}`).classList.add('cache'); ecrire(`${b.dataset.ferme}-ferme`, '1'); };
  for (const b of $$('[data-ouvre]')) {
    b.onclick = () => {
      const cible = b.dataset.ouvre;
      if (cible === 'chantier') nouveauDocument('chantier');
      else if (cible === 'note') ouvrirNote();
      else if (cible === 'point') ouvrirPoint();
      else if (cible === 'reglages') ouvrirReglages();
      else if (cible === 'bienvenue') ouvrirBienvenue();
      else if (cible === 'calculs') { afficher('calculs'); calculerRampant(); }
      else afficher(cible);
    };
  }
  $('#btn-deposer').onclick = () => nouveauDocument('depot');
  $('#onglet-deposer').onclick = () => nouveauDocument('depot');

  // Document
  $('#photo-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; ajouterFichiers(f); };
  $('#galerie-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; ajouterFichiers(f); };
  $('#btn-ajouter-page').onclick = () => $('#photo-input').click();
  $('#btn-galerie').onclick = () => $('#galerie-input').click();
  $('#mode-scan').onchange = retraiterPages;
  for (const b of $$('#types-doc .puce')) {
    b.onclick = () => {
      doc.type = doc.type === b.dataset.type ? '' : b.dataset.type;
      for (const x of $$('#types-doc .puce')) x.classList.toggle('active', x.dataset.type === doc.type);
    };
  }
  $('#btn-envoyer-doc').onclick = envoyerDocument;

  // Chantiers
  $('#chantiers-recherche').oninput = dessinerChantiers;
  for (const b of $$('#filtres-statut [data-statut]')) {
    b.onclick = () => {
      filtreStatut = b.dataset.statut;
      for (const x of $$('#filtres-statut [data-statut]')) x.classList.toggle('active', x === b);
      dessinerChantiers();
    };
  }
  $('#btn-pres-de-moi').onclick = async () => {
    const b = $('#btn-pres-de-moi');
    if (triDistance) { triDistance = false; b.classList.remove('active'); dessinerChantiers(); return; }
    b.textContent = '📍 Localisation…';
    const pos = await obtenirPosition();
    b.textContent = '📍 Près de moi';
    if (!pos) { toast('Position indisponible (autorise la localisation).', 'erreur'); return; }
    triDistance = true;
    b.classList.add('active');
    dessinerChantiers();
  };
  $('#fiche-photo').onclick = () => nouveauDocument('chantier', ficheCourante?.nom || '');
  $('#fiche-note').onclick = () => ouvrirNote(ficheCourante?.nom || '');
  $('#fiche-enregistrer').onclick = enregistrerInfosChantier;

  // À faire
  $('#btn-ajouter-tache').onclick = ajouterTache;
  $('#tache-nouvelle').onkeydown = (e) => { if (e.key === 'Enter') ajouterTache(); };

  // Notes
  for (const b of $$('#types-note .puce')) {
    b.onclick = () => { typeNote = b.dataset.type; for (const x of $$('#types-note .puce')) x.classList.toggle('active', x === b); };
  }
  $('#btn-envoyer-note').onclick = envoyerNote;

  // Calculs
  $('#calc-pct').oninput = () => calculerPente('pct');
  $('#calc-deg').oninput = () => calculerPente('deg');
  for (const id of ['#calc-portee', '#calc-pente', '#calc-debord', '#calc-long']) $(id).oninput = calculerRampant;
  $('#tampon').onchange = () => ecrire('tampon', $('#tampon').checked ? '1' : '0');

  // Point, Claude
  $('#btn-actualiser-point').onclick = chargerPoint;
  $('#btn-ouvrir-claude').onclick = ouvrirClaude;
  for (const b of $$('[data-question]')) b.onclick = () => { $('#claude-texte').value = b.dataset.question; };

  // Réglages
  $('#btn-tester').onclick = testerConnexion;
  $('#btn-enregistrer-reglages').onclick = () => { enregistrerReglages(); toast('Réglages enregistrés', 'ok'); viderFile(); majEtat(); };
  $('#btn-vider').onclick = viderDonnees;
  for (const b of $$('[data-autoriser]')) b.onclick = () => demanderAutorisation(b.dataset.autoriser);
  $('#btn-commencer').onclick = () => { ecrire('bienvenue-ok', '1'); ouvrirOnglet('accueil'); };

  // Réseau et retour dans l'appli
  $('#btn-renvoyer').onclick = viderFile;
  $('#btn-maj').onclick = () => location.reload();
  window.addEventListener('online', () => { viderFile(); majEtat(); });
  window.addEventListener('offline', majEtat);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    viderFile();
    if (ecranCourant === 'accueil') rafraichirAccueil();
  });
  setInterval(() => { if (!document.hidden) viderFile(); }, 60000);

  // Demande à l'iPhone de ne pas effacer les données de l'appli (envois en attente)
  navigator.storage?.persist?.().catch(() => {});
  surveillerMisesAJour();

  if (lire('bienvenue-ok') !== '1') ouvrirBienvenue();
  else ouvrirOnglet('accueil');
  viderFile();
});
