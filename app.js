// Appli Charpente du Léon – logique de l'application
'use strict';

const VERSION = '1.7.0';
const TAILLE_MAX_PX = 2000;        // côté le plus long d'une page après compression
const QUALITE_JPEG = 0.72;
const TAILLE_MAX_PDF = 15 * 1024 * 1024;
const NB_DERNIERS = 6;
const RAYON_CHANTIER_M = 400;      // même valeur que sur le serveur Google
const SEUIL_RAFALES = 50;          // km/h : au-delà, levage déconseillé
const DELAI_SERVEUR_MS = 45000;
const ATELIER = { lat: 48.6644, lon: -4.1006, nom: 'Cléder (atelier)' };
// Mêmes étapes que dans ProGBat (le serveur les recopie de ProGBat). « Archivé » : caché partout.
const STATUTS = ['Devis en attente', 'Devis accepté', 'En cours', 'Finalisé'];
const ANCIENS_STATUTS = { 'À venir': 'Devis accepté', 'Terminé': 'Finalisé' };
const statutDe = (s) => ANCIENS_STATUTS[s] || s || 'En cours';
const STATUTS_COURTS = { 'Devis en attente': 'Devis ⏳', 'Devis accepté': 'Accepté', 'En cours': 'En cours', 'Finalisé': 'Finalisé' };
const DELAI_VERROU_MS = 2 * 60000; // retour dans l'appli après 2 minutes ailleurs : Face ID redemandé

// ===================== Stockage local =====================
// Les réglages simples (interrupteurs, identifiant de l'appareil) restent en clair dans localStorage.
// Les données (chantiers, fiches clients, tâches, agenda…) sont dans un « coffre » chiffré en AES-GCM
// 256 bits, dont la clé non exportable est gardée par l'iPhone (IndexedDB, protégée par le trousseau).
function lire(cle, defaut = null) {
  try { const v = localStorage.getItem(cle); return v === null ? defaut : v; } catch { return defaut; }
}
function ecrire(cle, valeur) {
  try { localStorage.setItem(cle, valeur); } catch { /* stockage plein ou indisponible */ }
}

let coffre = {};
function lireJson(cle, defaut) {
  const v = coffre[cle];
  return v === undefined || v === null ? defaut : structuredClone(v);
}
function ecrireJson(cle, v) {
  coffre[cle] = v === undefined ? null : structuredClone(v);
  sauverCoffreBientot();
}

let minuteurCoffre = null;
function sauverCoffreBientot() {
  clearTimeout(minuteurCoffre);
  minuteurCoffre = setTimeout(sauverCoffre, 300);
}

async function sauverCoffre() {
  clearTimeout(minuteurCoffre);
  if (!securite.cleDonnees) return;
  ecrire('coffre', JSON.stringify(await chiffrer(JSON.stringify(coffre))));
}

async function ouvrirCoffre() {
  const brut = lire('coffre');
  if (brut) {
    try { coffre = JSON.parse(await dechiffrer(JSON.parse(brut))); } catch (e) { console.warn('Coffre illisible, on repart de zéro', e); coffre = {}; }
  }
  // Passage de la 1.3 : les données étaient en clair dans localStorage, on les range dans le coffre.
  let migre = false;
  for (const cle of Object.keys(localStorage)) {
    const v = localStorage.getItem(cle);
    if (cle === 'coffre' || !/^[[{]/.test(v || '')) continue;
    try { coffre[cle] = JSON.parse(v); localStorage.removeItem(cle); migre = true; } catch { /* pas du JSON */ }
  }
  if (migre) await sauverCoffre();
}

// ===================== Chiffrement =====================
function enBase64(tampon) {
  const octets = new Uint8Array(tampon);
  let s = '';
  for (let i = 0; i < octets.length; i += 0x8000) s += String.fromCharCode.apply(null, octets.subarray(i, i + 0x8000));
  return btoa(s);
}
const deBase64 = (texte) => Uint8Array.from(atob(texte), (c) => c.charCodeAt(0));
const enBase64Url = (t) => enBase64(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deBase64Url = (t) => deBase64(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
const aleatoire = (n) => crypto.getRandomValues(new Uint8Array(n));

async function chiffrer(texte) {
  const iv = aleatoire(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, securite.cleDonnees, new TextEncoder().encode(texte));
  return { iv: enBase64(iv), data: enBase64(data) };
}

async function dechiffrer({ iv, data }) {
  const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deBase64(iv) }, securite.cleDonnees, deBase64(data));
  return new TextDecoder().decode(clair);
}

// L'adresse du serveur n'est pas secrète : sans la clé d'un appareil appairé, il ne répond à rien.
const URL_SERVEUR = 'https://script.google.com/macros/s/AKfycbyKMQw7wS_GB3t2WpaudSEm9tP9LGqs0yrj1bQD5uyOVOVMXc9Ebhz2IgoEWHJsXpCD/exec';

// Retrouve l'adresse du serveur dans un texte collé (lien réécrit par Gmail, espaces, retour à la ligne…).
function nettoyerUrl(texte) {
  let t = String(texte || '').replace(/\s+/g, '');
  try { t = decodeURIComponent(t); } catch { /* texte non encodé */ }
  const m = t.match(/https:\/\/script\.google\.com\/macros\/(?:u\/\d+\/)?s\/([\w-]+)\/exec/);
  return m ? `https://script.google.com/macros/s/${m[1]}/exec` : '';
}

// Code secret de l'appli 1.3 (12 caractères 0-9 A-F), servi une seule fois pour l'appairage automatique.
function ancienCode() {
  const t = String(lire('reglage-code', '')).replace(/\s+/g, '').toUpperCase();
  return (t.match(/[0-9A-F]{12}/) || [''])[0];
}

const reglages = {
  get url() { return nettoyerUrl(lire('reglage-url')) || URL_SERVEUR; },
  get appareil() { return lire('appareil-id', ''); },
  ok() { return this.url.startsWith('https://') && !!this.appareil && !!securite.cleAppareil; },
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

// ===================== File d'attente hors ligne et clés (IndexedDB) =====================
const BASE = 'charpente-du-leon';
const MAGASIN = 'envois';
const MAGASIN_CLES = 'cles';
let basePromesse = null;

function ouvrirBase() {
  basePromesse ??= new Promise((resoudre, rejeter) => {
    const req = indexedDB.open(BASE, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MAGASIN)) db.createObjectStore(MAGASIN, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MAGASIN_CLES)) db.createObjectStore(MAGASIN_CLES);
    };
    req.onsuccess = () => resoudre(req.result);
    req.onerror = () => rejeter(req.error);
  });
  return basePromesse;
}

async function fileAction(mode, fn, magasin = MAGASIN) {
  const db = await ouvrirBase();
  return new Promise((resoudre, rejeter) => {
    const tx = db.transaction(magasin, mode);
    const req = fn(tx.objectStore(magasin));
    tx.oncomplete = () => resoudre(req && req.result);
    tx.onerror = () => rejeter(tx.error);
  });
}

// Chaque envoi en attente (photos de factures comprises) est chiffré avant d'être gardé.
async function fileAjouter(envoi) {
  const { iv, data } = await chiffrer(JSON.stringify(envoi));
  return fileAction('readwrite', (s) => s.put({ id: envoi.id, cree: envoi.cree, iv, data }));
}
const fileRetirer = (id) => fileAction('readwrite', (s) => s.delete(id));
const fileCompter = () => fileAction('readonly', (s) => s.count());

async function fileTout() {
  if (!securite.cleDonnees) throw new Error('Clés pas encore chargées');
  const lignes = (await fileAction('readonly', (s) => s.getAll())).sort((a, b) => a.cree - b.cree);
  const envois = [];
  for (const l of lignes) {
    if (!l.data) { envois.push(l); continue; } // gardé en clair par l'appli 1.3
    try { envois.push(JSON.parse(await dechiffrer(l))); } catch (e) {
      console.warn('Envoi illisible, retiré', l.id, e);
      await fileRetirer(l.id);
    }
  }
  return envois;
}

const cleLire = (nom) => fileAction('readonly', (s) => s.get(nom), MAGASIN_CLES);
const cleEcrire = (nom, cle) => fileAction('readwrite', (s) => s.put(cle, nom), MAGASIN_CLES);

const nouvelId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ===================== Sécurité de l'appareil =====================
// Clé d'appareil (HMAC) : signe chaque requête, le serveur refuse tout ce qui n'est pas signé.
// Clé de données (AES) : chiffre le coffre et la file d'attente. Les deux sont non exportables :
// même un script qui lirait le stockage du téléphone ne pourrait pas les recopier.
const securite = { cleAppareil: null, cleDonnees: null, verrouillee: false, cacheDepuis: 0 };
let demarree = false;

async function chargerCles() {
  securite.cleAppareil = (await cleLire('appareil')) || null;
  let donnees = await cleLire('donnees');
  if (!donnees) {
    donnees = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await cleEcrire('donnees', donnees);
  }
  securite.cleDonnees = donnees;
  if (!securite.cleAppareil) localStorage.removeItem('appareil-id');
}

async function signer(donnees) {
  const charge = JSON.stringify({ ...donnees, t: Date.now(), n: enBase64(aleatoire(16)) });
  const sig = await crypto.subtle.sign('HMAC', securite.cleAppareil, new TextEncoder().encode(charge));
  return JSON.stringify({ appareil: reglages.appareil, charge, sig: enBase64(sig) });
}

const surIos = () => /iPhone|iPad/.test(navigator.userAgent);
// Sur l'iPhone, Safari et l'appli de l'écran d'accueil ont chacun leur stockage, donc leur propre clé :
// le nom les distingue dans la liste des appareils autorisés.
const nomAppareil = () => `${/iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Ordinateur'} de Jean-Phi · ${estInstallee() ? 'appli' : 'navigateur'}`;

// La clé est tirée au hasard sur le téléphone et envoyée une seule fois au serveur, avec le code d'appairage.
async function appairer(code, nom = nomAppareil()) {
  const brute = aleatoire(32);
  const cle = await crypto.subtle.importKey('raw', brute, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const res = await appelServeur({ action: 'appairer', code, nom, cle: enBase64(brute) });
  brute.fill(0);
  await cleEcrire('appareil', cle);
  securite.cleAppareil = cle;
  ecrire('appareil-id', res.appareil);
  ecrire('appareil-nom', res.nom);
  localStorage.removeItem('reglage-code');
  return res;
}

// Passage de la 1.3 : l'ancien code secret sert une fois à appairer l'iPhone, puis le serveur l'efface.
async function appairageAutomatique() {
  const ancien = ancienCode();
  if (reglages.appareil || !ancien || !navigator.onLine) return;
  try {
    await appairer(ancien);
    toast('🔒 Appli sécurisée : ton iPhone a maintenant sa propre clé.', 'ok');
    majEtat();
    if (ecranCourant === 'accueil') rafraichirAccueil();
  } catch (e) {
    console.warn('Appairage automatique impossible', e);
    if (e.refus) localStorage.removeItem('reglage-code'); // code déjà utilisé : il faudra un code d'appairage
  }
}

// --- Face ID : l'appli s'ouvre seulement après reconnaissance du visage (clé d'accès de l'iPhone) ---
const faceIdActif = () => !!lire('faceid-id');

async function faceIdDisponible() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

async function activerFaceId() {
  if (!(await faceIdDisponible())) { toast('Face ID n\'est pas disponible sur cet appareil.', 'erreur'); return; }
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Charpente du Léon', id: location.hostname },
      user: { id: aleatoire(16), name: 'Jean-Phi', displayName: 'Jean-Phi' },
      challenge: aleatoire(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    } });
    ecrire('faceid-id', enBase64Url(cred.rawId));
    $('#bandeau-faceid').classList.add('cache');
    toast('Face ID activé 🔒', 'ok');
  } catch (e) {
    toast(`Face ID non activé (${e.message})`, 'erreur');
  }
  dessinerSecurite();
}

async function verifierFaceId() {
  await navigator.credentials.get({ publicKey: {
    challenge: aleatoire(32), rpId: location.hostname, timeout: 60000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: deBase64Url(lire('faceid-id')) }],
  } });
}

async function desactiverFaceId() {
  try { await verifierFaceId(); } catch { toast('Face ID non reconnu.', 'erreur'); return; }
  localStorage.removeItem('faceid-id');
  toast('Face ID désactivé', 'ok');
  dessinerSecurite();
}

function verrouiller() {
  securite.verrouillee = true;
  document.body.classList.add('verrouillee');
  $('#verrou-message').textContent = 'Tes chantiers et tes documents sont protégés.';
  $('#verrou').classList.remove('cache');
  setTimeout(() => { if (!document.hidden) deverrouiller(true); }, 400);
}

async function deverrouiller(automatique = false) {
  const b = $('#btn-deverrouiller');
  if (b.disabled) return;
  b.disabled = true;
  try {
    await verifierFaceId();
    securite.verrouillee = false;
    document.body.classList.remove('verrouillee', 'masque');
    $('#verrou').classList.add('cache');
    if (!demarree) await demarrer();
    else { viderFile(); if (ecranCourant === 'accueil') rafraichirAccueil(); }
  } catch (e) {
    // Safari peut refuser l'ouverture automatique de Face ID : il suffit alors de toucher le bouton.
    if (!automatique) $('#verrou-message').textContent = 'Visage non reconnu : réessaie.';
  } finally {
    b.disabled = false;
  }
}

// Face ID perdu : on efface tout ce que l'appli garde sur ce téléphone. Rien ne fuit, il faudra seulement
// un nouveau code d'appairage (Claude le donne).
async function reinitialiserAppli() {
  if (!confirm('Effacer l\'appli de ce téléphone (données, clé, envois en attente) ? Il faudra un nouveau code d\'appairage, à demander à Claude.')) return;
  localStorage.clear();
  await fileAction('readwrite', (s) => s.clear(), MAGASIN_CLES);
  await fileAction('readwrite', (s) => s.clear());
  location.reload();
}

// --- Alerte : le serveur signale les tentatives d'accès refusées jusqu'à ce que Jean-Phi touche « Vu » ---
function majAlerteSecurite(alerte) {
  $('#bandeau-securite').classList.toggle('cache', !alerte);
  if (!alerte) return;
  $('#bandeau-securite-texte').textContent = `${alerte.refus} tentative${alerte.refus > 1 ? 's' : ''} refusée${alerte.refus > 1 ? 's' : ''}, la dernière ${quandLisible(alerte.dernier)} (${alerte.motif}). Détail dans le « Journal de sécurité » sur Drive.`;
}

// ===================== Serveur Google =====================
async function appelServeur(donnees) {
  const appairage = donnees.action === 'appairer';
  if (!appairage && !reglages.ok()) throw new Error('Appareil pas encore appairé (Plus › Réglages)');
  const corps = appairage ? JSON.stringify(donnees) : await signer(donnees);
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), DELAI_SERVEUR_MS);
  try {
    const reponse = await fetch(reglages.url, {
      method: 'POST',
      // text/plain évite la requête préalable que Google Apps Script ne sait pas traiter
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: corps,
      redirect: 'follow',
      signal: controle.signal,
    });
    if (!reponse.ok) throw new Error(`Serveur : erreur ${reponse.status}`);
    const json = await reponse.json();
    if (!json.ok) {
      // Refus de sécurité : l'envoi est gardé (il repartira après un nouvel appairage).
      // Autre refus : le serveur a bien reçu, inutile de réessayer.
      const err = new Error(json.erreur || 'Erreur du serveur');
      err.refus = !!json.refus;
      err.definitive = !json.refus;
      if (json.refus && /Appareil inconnu/.test(json.erreur)) { localStorage.removeItem('appareil-id'); securite.cleAppareil = null; majEtat(); }
      throw err;
    }
    if (!appairage) majAlerteSecurite(json.alerte);
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Le serveur met trop de temps à répondre');
    // Safari dit seulement « Load failed » quand il n'arrive pas à joindre le serveur
    if (e instanceof TypeError) throw new Error(`Serveur injoignable (${e.message})`);
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
  const avant = await fileCompter();
  await viderFile();
  const apres = await fileCompter();
  return { tousPartis: apres === 0, partis: avant - apres };
}

async function viderFile() {
  if (envoiEnCours || !demarree || securite.verrouillee) return;
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
    pointer: '⏱️ Heures', majEquipe: '👷 Équipe',
  };
  if (envoi.action === 'pointer') {
    envoi = { ...envoi, type: dateDeIso(envoi.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) };
  }
  let libelle = libelles[envoi.action] || envoi.action;
  if (envoi.type) libelle += ` · ${envoi.type}`;
  const chantier = envoi.chantier || (envoi.action === 'chantier' ? res.nom : '');
  if (chantier) libelle += ` · ${chantier}`;
  if (envoi.action === 'majTache' || envoi.action === 'majChantier') return; // pas utile dans l'historique
  const derniers = lireJson('derniers', []);
  derniers.unshift({ libelle, probleme, quand: Date.now() });
  ecrireJson('derniers', derniers.slice(0, NB_DERNIERS));
  if (!probleme && (envoi.action === 'depot' || envoi.action === 'chantier')) majJournee(true);
}

async function majEnvois() {
  const enAttente = await fileCompter();
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
  if (!reglages.ok()) { etat.textContent = 'À appairer : Plus › Réglages'; etat.className = 'etat hors'; }
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

// Économie de batterie : le GPS précis ne sert que pour reconnaître un chantier (photo, document,
// « Près de moi ») ; la météo se contente du réseau. Une position de moins de 2 minutes est réutilisée.
function obtenirPosition(precise = true) {
  return new Promise((resoudre) => {
    if (!('geolocation' in navigator)) { resoudre(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        dernierePosition = { lat: p.coords.latitude, lon: p.coords.longitude, precision: Math.round(p.coords.accuracy), quand: Date.now() };
        ecrireJson('position', dernierePosition);
        resoudre(dernierePosition);
      },
      () => resoudre(null),
      { enableHighAccuracy: precise, timeout: 10000, maximumAge: precise ? 120000 : 900000 }
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
let accueilLu = 0;
function rafraichirAccueil() {
  accueilLu = Date.now();
  const maintenant = new Date();
  $('#accueil-date').textContent = maintenant.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const h = maintenant.getHours();
  $('#accueil-bonjour').textContent = h < 18 ? 'Bonjour Jean-Phi' : 'Bonsoir Jean-Phi';
  $('#bandeau-installer').classList.toggle('cache', estInstallee() || lire('bandeau-installer-ferme') === '1');
  majBandeauFaceId();
  majEnvois();
  chargerMeteo();
  lireAvecCache('agenda', { action: 'agenda' }, (r) => r.evenements, dessinerAgenda);
  chargerTaches();
  majAccueilHeures();
  chargerHeures();
}

// --- Météo (Open-Meteo, gratuit et sans clé) ---
const METEO = [
  [[0], '☀️', 'Ensoleillé'], [[1, 2], '🌤️', 'Éclaircies'], [[3], '☁️', 'Couvert'], [[45, 48], '🌫️', 'Brouillard'],
  [[51, 53, 55, 56, 57], '🌦️', 'Bruine'], [[61, 63, 65, 66, 67], '🌧️', 'Pluie'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Neige'],
  [[80, 81, 82], '🌧️', 'Averses'], [[95, 96, 99], '⛈️', 'Orage'],
];
const ciel = (code) => METEO.find(([codes]) => codes.includes(code)) || [[], '🌡️', ''];

// Sur iPhone, l'appli installée oublie l'autorisation de position à chaque ouverture : la demander ici
// ferait apparaître la fenêtre « … souhaite utiliser votre position » à chaque lancement. La météo
// utilise donc la dernière position connue (photo, « Près de moi »…) ou l'atelier, et le bouton 📍 Ici.
async function positionPourMeteo(demander) {
  const age = dernierePosition ? Date.now() - dernierePosition.quand : Infinity;
  if (!demander && age < 3600000) return dernierePosition;
  let etat = '';
  try { etat = (await navigator.permissions?.query({ name: 'geolocation' }))?.state || ''; } catch { /* API absente */ }
  if (demander || etat === 'granted') return (await obtenirPosition(false)) || (age < 12 * 3600000 ? dernierePosition : null);
  return age < 12 * 3600000 ? dernierePosition : null;
}

async function chargerMeteo(demander = false) {
  const enCache = lireJson('meteo', null);
  if (enCache) dessinerMeteo(enCache);
  if (!demander && enCache && Date.now() - enCache.quand < 30 * 60000) return; // Météo-France recalcule toutes les heures
  if (!navigator.onLine) return;
  const pos = await positionPourMeteo(demander);
  const lieu = pos || ATELIER;
  // Modèles de Météo-France (AROME 1,3 km à courte échéance, puis ARPÈGE) : les plus fiables en Bretagne,
  // surtout pour les rafales. Ils donnent la pluie en millimètres, pas en pourcentage.
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lieu.lat.toFixed(4), longitude: lieu.lon.toFixed(4), models: 'meteofrance_seamless',
    current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
    hourly: 'wind_gusts_10m,precipitation',
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

function dessinerMeteo({ lieu, m, quand: majMeteo }) {
  const [, ico, libelle] = ciel(m.current.weather_code);
  $('#meteo-lieu').textContent = lieu;
  // Fond de la carte selon le ciel du moment.
  const code = m.current.weather_code;
  $('#carte-meteo').dataset.ciel = m.current.is_day === 0 ? 'nuit'
    : code >= 95 ? 'orage' : (code >= 51 && code <= 67) || (code >= 80 && code <= 82) ? 'pluie'
    : (code >= 71 && code <= 77) || code === 85 || code === 86 ? 'neige' : code <= 1 ? 'soleil' : 'nuage';
  const maintenant = Date.now();
  const mm = m.hourly.precipitation || [];
  const heures = m.hourly.time.map((t, i) => ({ t: new Date(t).getTime(), rafale: m.hourly.wind_gusts_10m[i], pluie: mm[i] ?? 0 }));
  const finJournee = new Date(); finJournee.setHours(20, 0, 0, 0);
  const reste = heures.filter((h) => h.t >= maintenant - 3600000 && h.t <= finJournee.getTime());
  const pic = reste.reduce((max, h) => (h.rafale > (max?.rafale ?? -1) ? h : max), null);
  const six = heures.filter((h) => h.t >= maintenant - 3600000 && h.t <= maintenant + 6 * 3600000);
  const total6h = six.reduce((s, h) => s + h.pluie, 0);
  const premiere = six.find((h) => h.pluie >= 0.2);
  const texteDePluie = !premiere
    ? (total6h >= 0.1 ? 'Quelques gouttes possibles d\'ici 6 h' : 'Pas de pluie d\'ici 6 h')
    : `Pluie ${premiere.t <= maintenant ? 'en ce moment' : `vers ${new Date(premiere.t).getHours()} h`} · ${total6h.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} mm sur 6 h`;
  const demainRafales = Math.round(m.daily.wind_gusts_10m_max[1]);

  const bloc = el('div', { id: 'meteo-contenu' },
    el('div', { class: 'meteo' },
      el('span', { class: 'meteo-ico' }, ico),
      el('span', { class: 'meteo-temp' }, `${Math.round(m.current.temperature_2m)}°`),
      el('div', { class: 'meteo-detail' },
        el('div', {}, `${libelle} · ${Math.round(m.daily.temperature_2m_min[0])}° / ${Math.round(m.daily.temperature_2m_max[0])}°`),
        el('div', {}, `Vent ${Math.round(m.current.wind_speed_10m)} km/h · rafales ${Math.round(m.current.wind_gusts_10m)} km/h`),
        el('div', {}, texteDePluie))));
  if (pic && pic.rafale >= SEUIL_RAFALES) {
    const h = new Date(pic.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    bloc.append(el('div', { class: 'alerte' }, `⚠️ Rafales jusqu'à ${Math.round(pic.rafale)} km/h vers ${h} : levage déconseillé`));
  } else if (demainRafales >= SEUIL_RAFALES) {
    bloc.append(el('div', { class: 'alerte' }, `⚠️ Demain : rafales jusqu'à ${demainRafales} km/h`));
  } else {
    bloc.append(el('div', { class: 'alerte ok' }, `✓ Vent calme pour le levage aujourd'hui (demain rafales ${demainRafales} km/h)`));
  }
  bloc.append(el('p', { class: 'source-meteo' }, `Météo-France · mise à jour à ${new Date(majMeteo).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`));
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
      el('button', { class: 'suppr', 'aria-label': 'Retirer', onclick: () => { doc.pages.splice(i, 1); dessinerPages(); } }, '×'))),
      // Case « + » juste après la dernière page : un doigt pour photographier la page suivante.
      el('button', { class: 'page-plus', 'aria-label': doc.action === 'chantier' ? 'Ajouter une photo' : 'Ajouter une page',
        onclick: () => $('#photo-input').click() },
        el('span', { class: 'plus' }, '+'), doc.action === 'chantier' ? 'Photo' : `Page ${doc.pages.length + 1}`));
  }
  const n = doc.pages.length;
  const chantier = doc.action === 'chantier';
  $('#btn-ajouter-page').textContent = n === 0
    ? (chantier ? '📷 Prendre une photo' : '📷 Prendre en photo')
    : (chantier ? '📷 Encore une photo' : '📷 Ajouter une page');
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

// ===================== Import de la galerie =====================
// Les photos choisies restent dans la galerie : l'appli en envoie une copie réduite, rangée dans le chantier
// le plus proche de l'endroit de la prise de vue (si l'iPhone a laissé la position), à la date de la prise de vue.
const RAYON_IMPORT_M = 150;
const imp = { photos: [], chantierParDefaut: '' };

// Date de prise de vue et position GPS lues dans l'EXIF d'une photo JPEG (les 256 premiers Ko suffisent).
async function lireExif(fichier) {
  const res = { date: null, lat: null, lon: null };
  try {
    const v = new DataView(await fichier.slice(0, 262144).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return res;
    let o = 2;
    while (o + 10 < v.byteLength) {
      const marqueur = v.getUint16(o);
      if (marqueur === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { lireTiff(v, o + 10, res); break; } // « Exif »
      if ((marqueur & 0xFF00) !== 0xFF00 || marqueur === 0xFFDA) break;
      o += 2 + v.getUint16(o + 2);
    }
  } catch (e) { console.warn('EXIF illisible', e); }
  return res;
}

function lireTiff(v, base, res) {
  const le = v.getUint16(base) === 0x4949;
  const u16 = (p) => v.getUint16(base + p, le);
  const u32 = (p) => v.getUint32(base + p, le);
  const entrees = (ifd) => {
    const t = {};
    for (let i = 0; i < u16(ifd); i++) { const e = ifd + 2 + i * 12; t[u16(e)] = { nb: u32(e + 4), val: e + 8 }; }
    return t;
  };
  const texte = (e) => {
    const p = e.nb > 4 ? u32(e.val) : e.val;
    let s = '';
    for (let i = 0; i < e.nb - 1; i++) s += String.fromCharCode(v.getUint8(base + p + i));
    return s;
  };
  const degres = (e) => {
    const p = u32(e.val);
    const r = (i) => u32(p + i * 8) / (u32(p + i * 8 + 4) || 1);
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const ifd0 = entrees(u32(4));
  const exif = ifd0[0x8769] ? entrees(u32(ifd0[0x8769].val)) : {};
  const brut = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
  const m = brut && texte(brut).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) res.date = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const gps = ifd0[0x8825] ? entrees(u32(ifd0[0x8825].val)) : null;
  if (gps && gps[2] && gps[4]) {
    const ref = (n, defaut) => (gps[n] ? String.fromCharCode(v.getUint8(base + gps[n].val)) : defaut);
    res.lat = degres(gps[2]) * (ref(1, 'N') === 'S' ? -1 : 1);
    res.lon = degres(gps[4]) * (ref(3, 'E') === 'W' ? -1 : 1);
    if (!res.lat && !res.lon) res.lat = res.lon = null;
  }
}

function chantierDePhoto(lat, lon) {
  let meilleur = null;
  for (const c of listeChantiers()) {
    if (c.lat == null || c.lon == null) continue;
    const d = distanceM(lat, lon, c.lat, c.lon);
    if (d <= RAYON_IMPORT_M && (!meilleur || d < meilleur.d)) meilleur = { nom: c.nom, d };
  }
  return meilleur ? meilleur.nom : '';
}

function ouvrirImport(chantier = '') {
  for (const p of imp.photos) URL.revokeObjectURL(p.vignette);
  imp.photos = [];
  imp.chantierParDefaut = chantier;
  dessinerImport();
  afficher('import');
  $('#import-input').click(); // ouvre directement la galerie (doit rester dans le geste)
  rafraichirChantiers().then(dessinerImport);
}

async function choisirImport(fichiers) {
  $('#import-etat').textContent = `Lecture de ${fichiers.length} photo${fichiers.length > 1 ? 's' : ''}…`;
  for (const f of fichiers) {
    const exif = await lireExif(f);
    const situee = exif.lat != null;
    imp.photos.push({
      fichier: f, date: exif.date || f.lastModified || Date.now(), lat: exif.lat, lon: exif.lon, situee,
      // Position connue mais loin de tout chantier : à choisir. Sans position : le chantier d'où l'on vient.
      chantier: situee ? chantierDePhoto(exif.lat, exif.lon) : imp.chantierParDefaut,
      vignette: URL.createObjectURL(f),
    });
  }
  dessinerImport();
}

function dessinerImport() {
  const groupes = new Map();
  for (const p of imp.photos.sort((a, b) => a.date - b.date)) {
    if (!groupes.has(p.chantier)) groupes.set(p.chantier, []);
    groupes.get(p.chantier).push(p);
  }
  const situees = imp.photos.filter((p) => p.situee).length;
  $('#import-etat').textContent = imp.photos.length
    ? `${imp.photos.length} photo${imp.photos.length > 1 ? 's' : ''} · ${situees} avec leur position${situees ? ' (📍)' : ' : choisis le chantier'}`
    : '';
  const ordre = [...groupes.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  $('#import-groupes').replaceChildren(...ordre.map((nom) => {
    const photos = groupes.get(nom);
    const select = el('select', { onchange: (e) => { for (const p of photos) p.chantier = e.target.value; dessinerImport(); } });
    remplirSelectChantiers(select, nom, '— Ne pas importer —');
    return el('section', { class: 'carte groupe-import' },
      el('div', { class: 'carte-entete' }, el('h2', {}, nom ? `🏗️ ${nom}` : '❓ Chantier à choisir'), el('span', { class: 'discret' }, String(photos.length))),
      select,
      el('div', { class: 'vignettes' }, ...photos.map((p) => el('div', { class: 'vignette-import' },
        el('img', { src: p.vignette, alt: '', loading: 'lazy' }),
        el('small', {}, `${new Date(p.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' })}${p.situee ? ' 📍' : ''}`),
        el('button', { class: 'suppr', 'aria-label': 'Retirer', onclick: () => { URL.revokeObjectURL(p.vignette); imp.photos.splice(imp.photos.indexOf(p), 1); dessinerImport(); } }, '×')))));
  }));
  const n = imp.photos.filter((p) => p.chantier).length;
  $('#btn-import-envoyer').disabled = n === 0;
  $('#btn-import-envoyer').textContent = n ? `Importer ${n} photo${n > 1 ? 's' : ''}` : 'Importer';
}

async function envoyerImport() {
  const aEnvoyer = imp.photos.filter((p) => p.chantier);
  if (!aEnvoyer.length) return;
  if (!reglages.ok()) { toast('Appaire d\'abord cet iPhone (Plus › Réglages › Sécurité).', 'erreur'); return; }
  const b = $('#btn-import-envoyer');
  b.disabled = true;
  let prets = 0;
  for (const p of aEnvoyer) {
    b.textContent = `Préparation ${prets + 1}/${aEnvoyer.length}…`;
    try {
      const data = await traiterImage(p.fichier, false);
      // Nom du fichier sur Drive = date de prise de vue : une photo déjà importée n'est pas doublée.
      await fileAjouter({
        id: nouvelId(), cree: Date.now(), action: 'chantier', docId: nouvelId(), page: 1, total: 1,
        date: new Date(p.date).toISOString(), chantier: p.chantier, type: '', note: 'Importée de la galerie',
        ...(p.situee ? { lat: p.lat, lon: p.lon } : {}),
        fichier: { mime: 'image/jpeg', data: data.split(',')[1] },
      });
      prets++;
    } catch (e) { console.warn('Photo non préparée', e); }
  }
  for (const p of imp.photos) URL.revokeObjectURL(p.vignette);
  imp.photos = [];
  ouvrirOnglet('accueil');
  toast(`${prets} photo${prets > 1 ? 's' : ''} en cours d'envoi…`);
  await viderFile();
  const reste = await fileCompter();
  toast(reste ? `Pas de réseau : ${reste} envoi(s) partiront tout seuls.` : 'Photos rangées dans les chantiers ✅', reste ? '' : 'ok');
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
const classeStatut = (s) => ({ 'En cours': 'en-cours', 'Devis accepté': 'a-venir', 'Devis en attente': 'devis-attente', 'Finalisé': 'termine' }[statutDe(s)] || '');

// « Tous » montre tout sauf les chantiers finalisés, qui ont leur propre onglet.
const dansFiltre = (c, filtre) => (filtre ? statutDe(c.statut) === filtre : statutDe(c.statut) !== 'Finalisé');

function majCompteursStatut() {
  const liste = listeChantiers();
  for (const b of $$('#filtres-statut [data-statut]')) {
    if (!b.dataset.libelle) b.dataset.libelle = b.textContent;
    const n = liste.filter((c) => dansFiltre(c, b.dataset.statut)).length;
    b.textContent = liste.length ? `${b.dataset.libelle} · ${n}` : b.dataset.libelle;
  }
}

function dessinerChantiers() {
  majCompteursStatut();
  const filtre = $('#chantiers-recherche').value.trim().toLowerCase();
  const pos = triDistance ? dernierePosition : null;
  const elements = listeChantiers()
    .map((c) => ({ ...c, statut: statutDe(c.statut) }))
    .filter((c) => dansFiltre(c, filtreStatut))
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

  $('#fiche-statut').replaceChildren(...STATUTS.map((s) =>
    el('button', { class: s === statutDe(f.statut) ? 'active' : '', 'data-statut': s, onclick: () => changerStatut(s) }, STATUTS_COURTS[s])));
  $('#fiche-client').value = f.client || '';
  $('#fiche-tel').value = f.telephone || '';
  $('#fiche-adresse').value = f.adresse || '';
  $('#fiche-devis').value = f.devisHT ? String(f.devisHT).replace('.', ',') : '';

  const blocs = [];
  if (f.argent) blocs.push(carteRentabilite(f.argent));
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
      if (r.total > r.vignettes.length) bloc.append(lienDossier(r));
    } else if (r.fichiers.length) {
      const NB_VISIBLES = 6;
      r.fichiers.slice(0, NB_VISIBLES).forEach((fi) => bloc.append(lienFichier(fi)));
      const suite = r.fichiers.slice(NB_VISIBLES);
      if (suite.length) {
        const bouton = el('button', { class: 'fichier tout-voir' }, el('span', {}, '▾'), el('span', {}, `Tout voir (${r.total})`));
        bouton.onclick = () => {
          bouton.replaceWith(...suite.map(lienFichier));
          if (r.total > r.fichiers.length) bloc.append(lienDossier(r));
        };
        bloc.append(bouton);
      }
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

// Un document du dossier chantier : nom sans la date du mail (affichée à part), ouvert dans Drive.
function lienFichier(fi) {
  const icone = fi.type === 'application/pdf' ? '📄' : fi.type?.startsWith('image/') ? '🖼️' : '📎';
  const nom = fi.nom.replace(/^\d{4}-\d{2}-\d{2}[ _]/, '');
  const date = new Date(fi.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  return el('a', { class: 'fichier', href: fi.url, target: '_blank', rel: 'noopener' },
    el('span', {}, icone), el('span', { class: 'fichier-texte' }, el('span', {}, nom), el('small', {}, date)));
}

const lienDossier = (r) => el('a', { class: 'fichier', href: r.url, target: '_blank', rel: 'noopener' },
  el('span', {}, '📁'), el('span', {}, `Ouvrir le dossier (${r.total})`));

async function changerStatut(statut) {
  if (!ficheCourante?.nom) return;
  const nom = ficheCourante.nom;
  ficheCourante.statut = statut;
  for (const b of $$('#fiche-statut button')) b.classList.toggle('active', b.dataset.statut === statut);
  const liste = listeChantiers();
  const c = liste.find((x) => x.nom === nom);
  if (c) c.statut = statut;
  // Un chantier archivé disparaît de l'appli (le serveur ne l'envoie plus).
  ecrireJson('chantiers', statut === 'Archivé' ? liste.filter((x) => x.nom !== nom) : liste);
  await mettreEnFile([{ action: 'majChantier', chantier: nom, statut }]);
  toast(statut === 'Archivé' ? `${nom} archivé` : `Statut : ${statut}`, 'ok');
}

async function archiverChantier() {
  if (!ficheCourante?.nom) return;
  if (!confirm(`Archiver « ${ficheCourante.nom} » ? Il n'apparaîtra plus dans l'appli (il reste dans Drive et dans le registre).`)) return;
  await changerStatut('Archivé');
  ouvrirOnglet('chantiers');
}

// Montant tapé « 12 450,50 € » → 12450.5 ; vide → '' (efface le montant).
function lireMontant(texte) {
  const t = String(texte || '').replace(/[\s €]/g, '').replace(',', '.');
  if (!t) return '';
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

async function enregistrerInfosChantier() {
  if (!ficheCourante?.nom) return;
  const devisHT = lireMontant($('#fiche-devis').value);
  if (devisHT === null) { toast('Montant du devis incorrect (ex. 12 450,50).', 'erreur'); return; }
  const maj = { client: $('#fiche-client').value.trim(), telephone: $('#fiche-tel').value.trim(), adresse: $('#fiche-adresse').value.trim(), devisHT };
  Object.assign(ficheCourante, maj, { devisHT: devisHT || null });
  if (ficheCourante.argent) recalculerArgent(ficheCourante.argent, devisHT || null);
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
      if (caseBtn.classList.contains('cochee')) return;
      caseBtn.classList.add('cochee');
      setTimeout(() => li.classList.add('fait'), 350); // le temps de voir la coche rebondir
      ecrireJson('taches-faites', [...tachesFaites(), t.texte]);
      compterFait();
      setTimeout(majTachesAffichage, 700);
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

// ===================== Ma journée : anneaux, série, fête =====================
// Trois objectifs simples, comme les anneaux d'activité de l'Apple Watch : les heures pointées, au moins un
// document ou une photo déposé, et trois choses cochées. Tout est calculé sur le téléphone, sans réseau.
const OBJECTIF_TACHES = 3;
const CIRCONF = { 'anneau-heures': 2 * Math.PI * 52, 'anneau-depot': 2 * Math.PI * 39, 'anneau-tache': 2 * Math.PI * 26 };

function faitsDuJour() {
  const f = lireJson('faits-du-jour', null);
  return f && f.date === jourIso(new Date()) ? f.n : 0;
}
function compterFait() {
  ecrireJson('faits-du-jour', { date: jourIso(new Date()), n: faitsDuJour() + 1 });
  majJournee(true);
}

function depotsDuJour() {
  const auj = new Date().toDateString();
  return lireJson('derniers', []).filter((d) => !d.probleme && /^(📄|🏗️)/.test(d.libelle) && new Date(d.quand).toDateString() === auj).length;
}

// Série : jours ouvrés (lundi à samedi) d'affilée avec des heures pointées, en comptant aujourd'hui s'il l'est.
function serieDeJours() {
  const jours = new Set(toutesHeures().map((h) => h.date));
  let n = 0;
  let d = new Date();
  if (!jours.has(jourIso(d))) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    if (d.getDay() !== 0) {
      if (!jours.has(jourIso(d))) break;
      n++;
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function majJournee(celebrer = false) {
  const progres = {
    'anneau-heures': heuresDuJour(jourIso(new Date())).length ? 1 : 0,
    'anneau-depot': Math.min(depotsDuJour(), 1),
    'anneau-tache': Math.min(faitsDuJour() / OBJECTIF_TACHES, 1),
  };
  for (const [id, p] of Object.entries(progres)) {
    const c = $(`#${id}`);
    c.style.strokeDasharray = `${CIRCONF[id]}`;
    c.style.strokeDashoffset = `${CIRCONF[id] * (1 - p)}`;
  }
  $('#obj-heures').classList.toggle('fait', progres['anneau-heures'] === 1);
  $('#obj-depot').classList.toggle('fait', progres['anneau-depot'] === 1);
  $('#obj-tache').classList.toggle('fait', progres['anneau-tache'] === 1);
  const n = Math.min(faitsDuJour(), OBJECTIF_TACHES);
  $('#obj-tache-texte').textContent = n >= OBJECTIF_TACHES ? `${OBJECTIF_TACHES} choses faites` : `${n}/${OBJECTIF_TACHES} choses faites`;
  const score = Object.values(progres).filter((p) => p === 1).length;
  $('#anneaux-score').textContent = score === 3 ? '✓' : `${score}/3`;

  const serie = serieDeJours();
  $('#serie').textContent = serie >= 2 ? `🔥 ${serie} jours pointés d'affilée` : serie === 1 ? '🔥 Série lancée : pointe aussi demain' : 'Pointe ta journée ce soir pour lancer une série 🔥';

  // Journée bouclée : une seule fête par jour.
  if (score === 3 && celebrer && lire('journee-fetee') !== jourIso(new Date())) {
    ecrire('journee-fetee', jourIso(new Date()));
    setTimeout(() => { feter(); toast('Journée bouclée 💪 Bravo Jean-Phi !', 'ok'); }, 400);
  }
}

// Petits confettis aux couleurs du logo (pas d'animation si l'iPhone est réglé sur « Réduire les animations »).
function feter() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const zone = $('#confettis');
  const couleurs = ['#d5ac83', '#a88867', '#23376d', '#34c759', '#7fb2ff', '#ffffff'];
  const morceaux = Array.from({ length: 46 }, () => {
    const s = el('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = couleurs[Math.floor(Math.random() * couleurs.length)];
    s.style.animationDelay = `${Math.random() * 0.25}s`;
    s.style.animationDuration = `${1.1 + Math.random() * 0.8}s`;
    s.style.setProperty('--derive', `${(Math.random() - 0.5) * 160}px`);
    s.style.setProperty('--tour', `${(Math.random() - 0.5) * 900}deg`);
    return s;
  });
  zone.replaceChildren(...morceaux);
  setTimeout(() => zone.replaceChildren(), 2300);
}

// ===================== Heures de l'équipe =====================
// Jean-Phi pointe le soir pour toute l'équipe : une ligne par compagnon et par chantier.
// Hors ligne, la journée est gardée sur le téléphone (« heures-locales ») et part dès que possible.
const JOURNEE_H = 8;
const PAS_H = 0.5;
const jourIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateDeIso = (s) => { const [a, m, j] = s.split('-').map(Number); return new Date(a, m - 1, j, 12); };
const decalerJour = (iso, n) => { const d = dateDeIso(iso); d.setDate(d.getDate() + n); return jourIso(d); };
const majuscule = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const heuresLisibles = (h) => `${(Math.round(h * 100) / 100).toLocaleString('fr-FR')} h`;
const euros = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;

const equipeListe = () => (lireJson('equipe', []) || []).filter((p) => p && p.nom);
const heuresLocales = () => lireJson('heures-locales', {}) || {};
const pointage = { date: '', lignes: [], modifie: false, mois: '' };

// Heures connues : celles du serveur, remplacées jour par jour par celles pas encore envoyées.
function toutesHeures() {
  const locales = heuresLocales();
  const serveur = (lireJson('heures', []) || []).filter((h) => !locales[h.date]);
  return [...serveur, ...Object.entries(locales).flatMap(([date, lignes]) => lignes.map((l) => ({ ...l, date })))];
}
const heuresDuJour = (date) => toutesHeures().filter((h) => h.date === date);

function chargerHeures(ensuite) {
  const d = new Date();
  const du = jourIso(new Date(d.getFullYear(), d.getMonth() - 2, 1)); // les 3 derniers mois
  lireAvecCache('heures', { action: 'heures', du }, (r) => r.heures, async (v, depuisCache) => {
    // Le serveur a répondu après l'envoi de tout ce qui attendait : la copie locale ne sert plus.
    if (!depuisCache && v && (await fileCompter()) === 0) ecrireJson('heures-locales', {});
    majAccueilHeures();
    ensuite?.();
  });
}

function majAccueilHeures() {
  const auj = heuresDuJour(jourIso(new Date()));
  const total = auj.reduce((s, h) => s + h.heures, 0);
  const personnes = new Set(auj.map((h) => h.compagnon)).size;
  const chantiers = [...new Set(auj.map((h) => h.chantier))];
  $('#accueil-heures').textContent = auj.length
    ? `${personnes} personne${personnes > 1 ? 's' : ''} · ${heuresLisibles(total)} · ${chantiers.slice(0, 2).join(', ')}${chantiers.length > 2 ? '…' : ''}`
    : new Date().getHours() >= 16 ? 'Pas encore pointées : touche pour pointer' : 'Pas encore pointées';
  $('#carte-heures').classList.toggle('a-faire', !auj.length && new Date().getHours() >= 16);
  majJournee();
}

// Chantiers proposés dans les listes : ceux qui ne sont pas finalisés, plus celui déjà choisi.
function remplirSelectChantiersActifs(select, choisi, premier) {
  const actifs = listeChantiers().filter((c) => !['Finalisé', 'Archivé'].includes(statutDe(c.statut)));
  const options = [el('option', { value: '' }, premier), ...actifs.map((c) => el('option', { value: c.nom }, c.nom))];
  if (choisi && !actifs.some((c) => c.nom === choisi)) options.push(el('option', { value: choisi }, choisi));
  select.replaceChildren(...options);
  select.value = choisi || '';
}

// Chantier proposé pour un compagnon : celui de son dernier pointage, sinon celui où se trouve Jean-Phi.
function chantierProposePour(nom, date) {
  const avant = toutesHeures().filter((h) => h.compagnon === nom && h.date < date).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (avant.length) return avant[0].chantier;
  const proche = dernierePosition ? chantierLePlusProche(dernierePosition) : null;
  return proche ? proche.nom : '';
}

function ouvrirHeures(date = jourIso(new Date())) {
  pointage.date = date;
  pointage.mois = date.slice(0, 7);
  afficher('heures');
  preparerJour();
  const rafraichir = () => { if (ecranCourant === 'heures' && !pointage.modifie) preparerJour(); else { dessinerSemaine(); dessinerRecap(); } };
  lireAvecCache('equipe', { action: 'equipe' }, (r) => r.equipe, rafraichir);
  chargerHeures(rafraichir);
  rafraichirChantiers().then(rafraichir);
}

function changerJour(n) {
  if (pointage.modifie && !confirm('La journée affichée n\'est pas enregistrée. Changer de jour quand même ?')) return;
  pointage.date = decalerJour(pointage.date, n);
  preparerJour();
}

function preparerJour() {
  pointage.modifie = false;
  $('#heures-date').textContent = majuscule(dateDeIso(pointage.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
  const lignes = heuresDuJour(pointage.date).map((h) => ({ compagnon: h.compagnon, chantier: h.chantier, heures: h.heures }));
  for (const p of equipeListe().filter((x) => x.actif !== false)) {
    if (!lignes.some((l) => l.compagnon === p.nom)) lignes.push({ compagnon: p.nom, chantier: chantierProposePour(p.nom, pointage.date), heures: 0 });
  }
  pointage.lignes = lignes;
  remplirSelectChantiersActifs($('#heures-chantier-tous'), '', '— Choisir le chantier —');
  dessinerLignesHeures();
  dessinerSemaine();
  dessinerRecap();
}

function modifierPointage() {
  pointage.modifie = true;
  dessinerLignesHeures();
}

function dessinerLignesHeures() {
  const zone = $('#heures-lignes');
  const noms = [...new Set(pointage.lignes.map((l) => l.compagnon))];
  if (!noms.length) {
    zone.replaceChildren(el('section', { class: 'carte etat-vide' }, el('span', {}, '👷'),
      'Ajoute d\'abord ton équipe : nom et coût horaire de chacun.',
      el('button', { class: 'btn secondaire', onclick: ouvrirEquipe }, '👷 Mon équipe')));
    $('#btn-pointer').disabled = true;
    return;
  }
  $('#btn-pointer').disabled = false;
  zone.replaceChildren(...noms.map((nom) => {
    const indices = pointage.lignes.map((l, i) => (l.compagnon === nom ? i : -1)).filter((i) => i >= 0);
    const total = indices.reduce((s, i) => s + pointage.lignes[i].heures, 0);
    const carte = el('section', { class: `carte compagnon${total ? '' : ' absent'}` },
      el('div', { class: 'carte-entete' }, el('h2', {}, nom), el('span', { class: 'total-compagnon' }, total ? heuresLisibles(total) : 'pas pointé')));
    for (const i of indices) {
      const l = pointage.lignes[i];
      const select = el('select', { 'aria-label': `Chantier de ${nom}` });
      remplirSelectChantiersActifs(select, l.chantier, '— Chantier —');
      select.onchange = () => { l.chantier = select.value; pointage.modifie = true; };
      const champ = el('input', { type: 'text', inputmode: 'decimal', value: l.heures ? String(l.heures).replace('.', ',') : '', placeholder: '0', 'aria-label': `Heures de ${nom}` });
      champ.onchange = () => { const v = parseFloat(champ.value.replace(',', '.')); l.heures = Number.isFinite(v) ? Math.min(Math.max(Math.round(v * 4) / 4, 0), 24) : 0; modifierPointage(); };
      const pas = (n) => () => { l.heures = Math.min(Math.max(l.heures + n, 0), 24); modifierPointage(); };
      carte.append(el('div', { class: 'ligne-heure' }, select,
        el('div', { class: 'pas' },
          el('button', { 'aria-label': 'Moins', onclick: pas(-PAS_H) }, '−'), champ, el('button', { 'aria-label': 'Plus', onclick: pas(PAS_H) }, '+')),
        indices.length > 1 ? el('button', { class: 'retirer', 'aria-label': 'Retirer ce chantier', onclick: () => { pointage.lignes.splice(i, 1); modifierPointage(); } }, '×') : null));
    }
    const premier = pointage.lignes[indices[0]];
    const regler = (h) => () => {
      premier.heures = h;
      if (!h) for (const i of indices.slice(1).reverse()) pointage.lignes.splice(i, 1);
      modifierPointage();
    };
    carte.append(el('div', { class: 'puces raccourcis' },
      el('button', { class: 'puce', onclick: regler(JOURNEE_H) }, `Journée (${JOURNEE_H} h)`),
      el('button', { class: 'puce', onclick: regler(JOURNEE_H / 2) }, '½ journée'),
      el('button', { class: 'puce', onclick: regler(0) }, 'Absent'),
      el('button', { class: 'puce', onclick: () => { pointage.lignes.splice(indices[indices.length - 1] + 1, 0, { compagnon: nom, chantier: '', heures: 0 }); modifierPointage(); } }, '＋ Autre chantier')));
    return carte;
  }));
}

// « Tout le monde au même endroit » : le chantier choisi et/ou la journée pour chacun.
function pourTous(champ, valeur) {
  const vus = new Set();
  for (const l of pointage.lignes) {
    if (vus.has(l.compagnon)) continue; // seulement la première ligne de chacun
    vus.add(l.compagnon);
    l[champ] = valeur;
  }
  modifierPointage();
}

async function enregistrerJournee() {
  const lignes = pointage.lignes.filter((l) => l.heures > 0).map(({ compagnon, chantier, heures }) => ({ compagnon, chantier, heures }));
  const sansChantier = lignes.find((l) => !l.chantier);
  if (sansChantier) { toast(`Choisis le chantier de ${sansChantier.compagnon}.`, 'erreur'); return; }
  if (!lignes.length && !heuresDuJour(pointage.date).length) { toast('Personne n\'est pointé ce jour-là.', 'erreur'); return; }
  const locales = heuresLocales();
  locales[pointage.date] = lignes;
  ecrireJson('heures-locales', locales);
  pointage.modifie = false;
  const total = lignes.reduce((s, l) => s + l.heures, 0);
  dessinerLignesHeures();
  dessinerSemaine();
  dessinerRecap();
  majAccueilHeures();
  $('#btn-pointer').disabled = true;
  if (total && pointage.date === jourIso(new Date())) { feter(); majJournee(true); }
  const { tousPartis } = await mettreEnFile([{ action: 'pointer', date: pointage.date, lignes }]);
  $('#btn-pointer').disabled = false;
  toast(tousPartis ? `Journée enregistrée ✅ ${heuresLisibles(total)}` : 'Journée gardée sur le téléphone : elle partira dès que possible.', tousPartis ? 'ok' : '');
}

function dessinerSemaine() {
  const d = dateDeIso(pointage.date);
  const lundi = decalerJour(pointage.date, -((d.getDay() + 6) % 7));
  const jours = Array.from({ length: 6 }, (_, i) => decalerJour(lundi, i)); // du lundi au samedi
  const heures = toutesHeures();
  let totalSemaine = 0;
  $('#heures-semaine').replaceChildren(...jours.map((jour) => {
    const duJour = heures.filter((h) => h.date === jour);
    const total = duJour.reduce((s, h) => s + h.heures, 0);
    totalSemaine += total;
    const libelle = majuscule(dateDeIso(jour).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }));
    return el('li', { class: `jour-semaine${jour === pointage.date ? ' actif' : ''}`, onclick: () => { if (jour !== pointage.date) changerJour(Math.round((dateDeIso(jour) - dateDeIso(pointage.date)) / 864e5)); } },
      el('span', {}, libelle, duJour.length ? el('small', {}, ` · ${[...new Set(duJour.map((h) => h.chantier))].join(', ')}`) : null),
      el('b', {}, total ? heuresLisibles(total) : '—'));
  }));
  $('#heures-semaine-total').textContent = totalSemaine ? `${heuresLisibles(totalSemaine)} au total` : '';
}

// --- Récap du mois (pour la paie, Nelly) ---
const recapCache = {}; // mois plus anciens que 3 mois, lus à la demande

async function heuresDuMois(mois) {
  const d = new Date();
  const debutCache = jourIso(new Date(d.getFullYear(), d.getMonth() - 2, 1)).slice(0, 7);
  if (mois >= debutCache) return toutesHeures().filter((h) => h.date.startsWith(mois));
  if (recapCache[mois]) return recapCache[mois];
  const [a, m] = mois.split('-').map(Number);
  const res = await appelServeur({ action: 'heures', du: `${mois}-01`, au: jourIso(new Date(a, m, 0)) });
  recapCache[mois] = res.heures;
  return res.heures;
}

function decalerMois(n) {
  const [a, m] = pointage.mois.split('-').map(Number);
  const d = new Date(a, m - 1 + n, 1);
  pointage.mois = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  dessinerRecap();
}

const nomDuMois = (mois) => { const [a, m] = mois.split('-').map(Number); return new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };

async function dessinerRecap() {
  const mois = pointage.mois || jourIso(new Date()).slice(0, 7);
  $('#recap-mois').textContent = nomDuMois(mois);
  let heures;
  try { heures = await heuresDuMois(mois); } catch (e) {
    $('#recap-liste').replaceChildren(el('li', {}, el('span', { class: 'discret' }, `Indisponible : ${e.message}`)));
    return;
  }
  if (mois !== pointage.mois) return; // l'utilisateur a changé de mois entre-temps
  const parCompagnon = {};
  const parChantier = {};
  for (const h of heures) {
    const p = parCompagnon[h.compagnon] || (parCompagnon[h.compagnon] = { heures: 0, jours: new Set() });
    p.heures += h.heures;
    p.jours.add(h.date);
    parChantier[h.chantier] = (parChantier[h.chantier] || 0) + h.heures;
  }
  const noms = Object.keys(parCompagnon).sort((a, b) => a.localeCompare(b, 'fr'));
  if (!noms.length) {
    $('#recap-liste').replaceChildren(el('li', {}, el('span', { class: 'discret' }, 'Aucune heure pointée ce mois-ci.')));
    $('#btn-copier-recap').disabled = true;
    return;
  }
  $('#btn-copier-recap').disabled = false;
  $('#recap-liste').replaceChildren(
    ...noms.map((n) => el('li', {}, el('span', {}, n, el('small', {}, ` · ${parCompagnon[n].jours.size} jour${parCompagnon[n].jours.size > 1 ? 's' : ''}`)), el('b', {}, heuresLisibles(parCompagnon[n].heures)))),
    el('li', { class: 'sous-titre-liste' }, el('span', {}, 'Par chantier')),
    ...Object.entries(parChantier).sort((a, b) => b[1] - a[1]).map(([c, h]) => el('li', {}, el('span', {}, c), el('b', {}, heuresLisibles(h)))));
  pointage.recap = { mois, heures, noms };
}

// Texte pour Nelly (COGEP) : total et détail jour par jour de chaque compagnon.
async function copierRecap() {
  const r = pointage.recap;
  if (!r) return;
  const lignes = [`Heures de ${nomDuMois(r.mois)} – SARL Charpente du Léon`, ''];
  for (const n of r.noms) {
    const siennes = r.heures.filter((h) => h.compagnon === n).sort((a, b) => (a.date < b.date ? -1 : 1));
    const parJour = {};
    for (const h of siennes) parJour[h.date] = (parJour[h.date] || 0) + h.heures;
    const total = siennes.reduce((s, h) => s + h.heures, 0);
    lignes.push(`${n} : ${heuresLisibles(total)} sur ${Object.keys(parJour).length} jours`);
    lignes.push(Object.entries(parJour).map(([j, h]) => `${dateDeIso(j).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${heuresLisibles(h)}`).join(' · '));
    lignes.push('');
  }
  try {
    await navigator.clipboard.writeText(lignes.join('\n'));
    toast('Récap copié : colle-le dans un mail à Nelly.', 'ok');
  } catch {
    toast('Copie impossible sur cet appareil.', 'erreur');
  }
}

// --- Équipe ---
let equipeEdition = [];

function ouvrirEquipe() {
  equipeEdition = equipeListe().map((p) => ({ ...p }));
  if (!equipeEdition.length) equipeEdition.push({ nom: '', cout: '', actif: true });
  afficher('equipe');
  dessinerEquipe();
}

function dessinerEquipe() {
  $('#equipe-liste').replaceChildren(...equipeEdition.map((p, i) => {
    const nom = el('input', { type: 'text', value: p.nom || '', placeholder: 'Prénom Nom', autocomplete: 'off', 'aria-label': 'Nom' });
    nom.oninput = () => { p.nom = nom.value; };
    const cout = el('input', { type: 'text', inputmode: 'decimal', value: p.cout ? String(p.cout).replace('.', ',') : '', placeholder: '35', 'aria-label': 'Coût horaire chargé' });
    cout.oninput = () => { p.cout = parseFloat(cout.value.replace(',', '.')) || ''; };
    const actif = el('input', { type: 'checkbox' });
    actif.checked = p.actif !== false;
    actif.onchange = () => { p.actif = actif.checked; };
    return el('section', { class: 'carte equipier' },
      el('div', { class: 'champ' }, el('label', {}, 'Nom'), nom),
      el('div', { class: 'equipier-bas' },
        el('div', { class: 'champ' }, el('label', {}, 'Coût horaire chargé (€)'), cout),
        el('div', { class: 'champ' }, el('label', {}, 'À pointer'), el('label', { class: 'interrupteur' }, actif, el('span'))),
        el('button', { class: 'retirer', 'aria-label': 'Retirer', onclick: () => { equipeEdition.splice(i, 1); dessinerEquipe(); } }, '×')));
  }));
}

async function enregistrerEquipe() {
  const equipe = equipeEdition
    .map((p) => ({ nom: String(p.nom || '').trim(), cout: Number(p.cout) || 0, actif: p.actif !== false }))
    .filter((p) => p.nom);
  const noms = equipe.map((p) => p.nom.toLowerCase());
  if (noms.some((n, i) => noms.indexOf(n) !== i)) { toast('Deux personnes ont le même nom.', 'erreur'); return; }
  if (equipe.some((p) => !p.cout)) { toast('Mets le coût horaire de chacun (35 € si tu ne sais pas).', 'erreur'); return; }
  ecrireJson('equipe', equipe);
  const { tousPartis } = await mettreEnFile([{ action: 'majEquipe', equipe }]);
  toast(tousPartis ? 'Équipe enregistrée ✅' : 'Équipe gardée : elle partira dès que possible.', tousPartis ? 'ok' : '');
  ouvrirHeures(pointage.date || jourIso(new Date()));
}

// ===================== Rentabilité =====================
// Dépensé = achats du chantier (registre des factures) + heures pointées × coût horaire de chacun.
// Jauge : dépensé / devis HT. Vert sous 75 %, orange jusqu'à 95 %, rouge au-delà.
const niveauRenta = (ratio) => (ratio == null ? 'gris' : ratio < 0.75 ? 'vert' : ratio < 0.95 ? 'orange' : 'rouge');
const jaugeRenta = (ratio) => el('div', { class: `jauge ${niveauRenta(ratio)}`, role: 'img', 'aria-label': ratio == null ? 'Devis inconnu' : `${Math.round(ratio * 100)} % du devis dépensé` },
  el('span', { style: `width:${ratio == null ? 0 : Math.min(ratio, 1) * 100}%` }));

function recalculerArgent(a, devisHT) {
  a.devisHT = devisHT;
  a.marge = devisHT ? Math.round((devisHT - a.depense) * 100) / 100 : null;
  a.ratio = devisHT ? a.depense / devisHT : null;
}

function carteRentabilite(a) {
  const carte = el('section', { class: 'carte rentabilite' },
    el('div', { class: 'carte-entete' }, el('h2', {}, '💶 Rentabilité'),
      a.ratio != null ? el('span', { class: `pourcent ${niveauRenta(a.ratio)}` }, `${Math.round(a.ratio * 100)} % dépensé`) : null),
    jaugeRenta(a.ratio));
  const lignes = [
    ['Devis HT', a.devisHT ? euros(a.devisHT) : '—'],
    [`Achats${a.nbAchats ? ` (${a.nbAchats} facture${a.nbAchats > 1 ? 's' : ''})` : ''}`, euros(a.achatsHT)],
    [`Main-d'œuvre (${heuresLisibles(a.heures)})`, euros(a.mainOeuvre)],
    ['Dépensé', euros(a.depense)],
  ];
  if (a.marge != null) lignes.push([a.marge >= 0 ? 'Reste sur le devis' : 'Dépassement', euros(Math.abs(a.marge))]);
  carte.append(el('ul', { class: 'resultats' }, ...lignes.map(([t, v], i) =>
    el('li', { class: i === lignes.length - 1 && a.marge != null ? `marge ${a.marge >= 0 ? 'positive' : 'negative'}` : '' }, el('span', {}, t), el('b', {}, v)))));
  if (!a.devisHT) carte.append(el('p', { class: 'discret' }, 'Montant du devis pas encore connu : je le lis dans ProGBat, ou mets-le dans « Infos du chantier ».'));
  if (a.parCompagnon?.length) carte.append(el('p', { class: 'discret' }, a.parCompagnon.map((p) => `${p.nom} ${heuresLisibles(p.heures)}`).join(' · ')));
  return carte;
}

let filtreRenta = 'actifs';

function ouvrirRentabilite() {
  afficher('rentabilite');
  lireAvecCache('rentabilites', { action: 'rentabilites' }, (r) => r.chantiers, dessinerRentabilite);
}

function dessinerRentabilite(liste, depuisCache, erreur) {
  if (!liste) {
    $('#renta-liste').replaceChildren(el('li', { class: 'etat-vide' }, el('span', {}, '📡'),
      erreur ? `Indisponible : ${erreur.message}` : depuisCache ? 'Chargement…' : 'Pas de réseau pour l\'instant.'));
    $('#renta-total').replaceChildren();
    return;
  }
  const choisis = liste
    .map((c) => ({ ...c, statut: statutDe(c.statut) }))
    .filter((c) => (filtreRenta === 'tous' ? true : filtreRenta === 'Finalisé' ? c.statut === 'Finalisé' : ['En cours', 'Devis accepté'].includes(c.statut)))
    .sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || b.depense - a.depense);
  const avecDevis = choisis.filter((c) => c.devisHT);
  const devis = avecDevis.reduce((s, c) => s + c.devisHT, 0);
  const depense = avecDevis.reduce((s, c) => s + c.depense, 0);
  $('#renta-total').replaceChildren(el('section', { class: 'carte rentabilite' },
    el('div', { class: 'carte-entete' }, el('h2', {}, `${choisis.length} chantier${choisis.length > 1 ? 's' : ''}`),
      el('span', { class: 'discret' }, `${avecDevis.length} avec devis connu`)),
    jaugeRenta(devis ? depense / devis : null),
    el('ul', { class: 'resultats' },
      el('li', {}, el('span', {}, 'Devis HT'), el('b', {}, euros(devis))),
      el('li', {}, el('span', {}, 'Dépensé'), el('b', {}, euros(depense))),
      el('li', { class: `marge ${devis - depense >= 0 ? 'positive' : 'negative'}` }, el('span', {}, 'Reste'), el('b', {}, euros(devis - depense))))));
  if (!choisis.length) { $('#renta-liste').replaceChildren(el('li', { class: 'etat-vide' }, 'Aucun chantier ici.')); return; }
  $('#renta-liste').replaceChildren(...choisis.map((c) => el('li', { class: classeStatut(c.statut) },
    el('button', { class: 'ligne-renta', onclick: () => ouvrirFiche(c.nom) },
      el('span', { class: 'corps' },
        el('div', { class: 'nom' }, c.nom),
        el('div', { class: 'info' }, c.devisHT ? `Devis ${euros(c.devisHT)} · dépensé ${euros(c.depense)}` : `Devis inconnu · dépensé ${euros(c.depense)}`),
        jaugeRenta(c.ratio)),
      el('span', { class: 'droite' },
        c.marge != null ? el('b', { class: `montant ${c.marge >= 0 ? 'positif' : 'negatif'}` }, `${c.marge >= 0 ? '+' : '−'}${euros(Math.abs(c.marge))}`) : el('span', { class: 'discret' }, '—'),
        c.ratio != null ? el('small', {}, `${Math.round(c.ratio * 100)} %`) : null)))));
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
  afficher('reglages');
  dessinerSecurite();
  dessinerAutorisations();
}

function enregistrerReglages() {
  ecrire('reglage-url', nettoyerUrl($('#reglage-url').value));
  $('#reglage-url').value = reglages.url;
}

async function majBandeauFaceId() {
  const proposer = reglages.ok() && !faceIdActif() && lire('bandeau-faceid-ferme') !== '1' && await faceIdDisponible();
  $('#bandeau-faceid').classList.toggle('cache', !proposer);
}

async function dessinerSecurite() {
  const appaire = reglages.ok();
  const dansSafari = surIos() && !estInstallee();
  $('#securite-appareil').textContent = appaire
    ? `✅ ${lire('appareil-nom', 'Cet appareil')} est appairé : ses demandes sont signées avec sa propre clé.`
    : dansSafari
      ? '⚠️ Ici c\'est Safari. Ouvre l\'appli depuis son icône sur l\'écran d\'accueil pour l\'appairer.'
      : '⚠️ Cet appareil n\'est pas encore appairé. Tape le code d\'appairage donné par Claude.';
  $('#bloc-appairage').classList.toggle('cache', appaire || dansSafari);
  const dispo = await faceIdDisponible();
  const actif = faceIdActif();
  $('#securite-options').replaceChildren(el('li', {}, el('button', { onclick: actif ? desactiverFaceId : activerFaceId },
    el('span', {}, '🔒'), 'Face ID à l\'ouverture',
    el('b', { class: `valeur ${actif ? 'ok' : ''}` }, actif ? 'Activé' : dispo ? 'Activer' : 'Indisponible'))));
  const ul = $('#appareils-liste');
  if (!appaire || !navigator.onLine) { ul.replaceChildren(el('li', {}, el('div', { class: 'ligne' }, el('span', {}, '📱'), appaire ? 'Hors ligne' : '—'))); return; }
  try {
    const { appareils } = await appelServeur({ action: 'appareils' });
    ul.replaceChildren(...appareils.map((a) => el('li', {}, el('div', { class: 'ligne' },
      el('span', {}, a.moi ? '📱' : '💻'),
      el('div', {}, el('div', {}, `${a.nom}${a.moi ? ' (celui-ci)' : ''}`), el('small', { class: 'discret' }, `appairé ${quandLisible(a.cree)} · vu ${quandLisible(a.vu)}`)),
      a.moi ? null : el('button', { class: 'btn-petit valeur', onclick: () => retirerAppareil(a) }, 'Retirer')))));
  } catch (e) {
    ul.replaceChildren(el('li', {}, el('div', { class: 'ligne' }, el('span', {}, '⚠️'), `Liste indisponible : ${e.message}`)));
  }
}

async function retirerAppareil(a) {
  if (!confirm(`Retirer « ${a.nom} », appairé ${quandLisible(a.cree)} ? Ce n'est pas cet appareil-ci : il ne pourra plus rien lire ni envoyer.`)) return;
  try {
    await appelServeur({ action: 'retirerAppareil', cible: a.id });
    toast(`${a.nom} retiré ✅`, 'ok');
  } catch (e) { toast(e.message, 'erreur'); }
  dessinerSecurite();
}

async function appairerAvecCode() {
  if (surIos() && !estInstallee()) { toast('Ouvre l\'appli depuis son icône pour l\'appairer (pas Safari).', 'erreur'); return; }
  const code = $('#reglage-appairage').value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length < 12) { toast('Le code d\'appairage fait 16 caractères.', 'erreur'); return; }
  const b = $('#btn-appairer');
  b.disabled = true;
  try {
    await appairer(code);
    $('#reglage-appairage').value = '';
    toast('Appareil appairé ✅', 'ok');
    majEtat();
    viderFile();
    rafraichirChantiers();
  } catch (e) {
    toast(`Échec : ${e.message}`, 'erreur');
  } finally {
    b.disabled = false;
    dessinerSecurite();
  }
}

async function securiteVu() {
  $('#bandeau-securite').classList.add('cache');
  try { await appelServeur({ action: 'securiteVu' }); } catch (e) { console.warn('Alerte non acquittée', e); }
}

// Après un échec : le serveur répond-il à une simple lecture ? Sépare « réseau / adresse » de « envoi bloqué ».
async function diagnosticServeur() {
  if (!navigator.onLine) return 'L\'iPhone est hors ligne.';
  try {
    const r = await fetch(reglages.url);
    const j = await r.json();
    return j.ok ? 'Le serveur répond en lecture, seul l\'envoi échoue.' : `Lecture : erreur ${r.status}.`;
  } catch (e) {
    return `Lecture impossible aussi (${e.message}).`;
  }
}

async function testerConnexion() {
  enregistrerReglages();
  const b = $('#btn-tester');
  const diag = $('#reglage-diagnostic');
  if (!reglages.ok()) {
    diag.textContent = '⚠️ Appairage d\'abord : tape le code d\'appairage dans « Sécurité », en haut de cette page.';
    $('#securite-appareil').scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!$('#bloc-appairage').classList.contains('cache')) setTimeout(() => $('#reglage-appairage').focus(), 400);
    return;
  }
  b.textContent = 'Test…';
  diag.textContent = '';
  try {
    const res = await appelServeur({ action: 'ping' });
    toast(`Connexion OK ✅ ${res.compte || ''}`, 'ok');
    diag.textContent = `Connexion OK · ${res.compte || ''} · ${res.appareil || ''} · serveur ${res.version || '?'} · appli ${VERSION}`;
    viderFile();
    rafraichirChantiers();
  } catch (e) {
    toast(`Échec : ${e.message}`, 'erreur');
    diag.textContent = `❌ ${e.message} ${await diagnosticServeur()} · appli ${VERSION}`;
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
  const enAttente = await fileCompter();
  if (enAttente) { toast(`Impossible : ${enAttente} envoi(s) pas encore partis.`, 'erreur'); return; }
  coffre = {};
  await sauverCoffre();
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
      else if (cible === 'import') ouvrirImport();
      else if (cible === 'bienvenue') ouvrirBienvenue();
      else if (cible === 'calculs') { afficher('calculs'); calculerRampant(); }
      else if (cible === 'heures') ouvrirHeures();
      else if (cible === 'rentabilite') ouvrirRentabilite();
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

  // Import de la galerie
  $('#import-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; choisirImport(f); };
  $('#btn-import-choisir').onclick = () => $('#import-input').click();
  $('#btn-import-envoyer').onclick = envoyerImport;

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
  $('#fiche-galerie').onclick = () => ouvrirImport(ficheCourante?.nom || '');
  $('#fiche-note').onclick = () => ouvrirNote(ficheCourante?.nom || '');
  $('#fiche-enregistrer').onclick = enregistrerInfosChantier;
  $('#fiche-archiver').onclick = archiverChantier;

  $('#meteo-localiser').onclick = async () => {
    const b = $('#meteo-localiser');
    b.textContent = '📍 …';
    await chargerMeteo(true);
    b.textContent = '📍 Ici';
  };

  // Heures, équipe, rentabilité
  $('#carte-heures').onclick = () => ouvrirHeures();
  $('#heures-avant').onclick = () => changerJour(-1);
  $('#heures-apres').onclick = () => changerJour(1);
  $('#heures-chantier-tous').onchange = (e) => { if (e.target.value) pourTous('chantier', e.target.value); };
  $('#heures-journee-tous').onclick = () => pourTous('heures', JOURNEE_H);
  $('#btn-pointer').onclick = enregistrerJournee;
  $('#recap-avant').onclick = () => decalerMois(-1);
  $('#recap-apres').onclick = () => decalerMois(1);
  $('#btn-copier-recap').onclick = copierRecap;
  $('#btn-equipe').onclick = ouvrirEquipe;
  $('#equipe-retour').onclick = () => ouvrirHeures(pointage.date || jourIso(new Date()));
  $('#btn-ajouter-compagnon').onclick = () => { equipeEdition.push({ nom: '', cout: '', actif: true }); dessinerEquipe(); };
  $('#btn-enregistrer-equipe').onclick = enregistrerEquipe;
  for (const b of $$('#renta-filtres [data-filtre]')) {
    b.onclick = () => {
      filtreRenta = b.dataset.filtre;
      for (const x of $$('#renta-filtres [data-filtre]')) x.classList.toggle('active', x === b);
      dessinerRentabilite(lireJson('rentabilites', null), true);
    };
  }

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

  // Sécurité
  $('#btn-deverrouiller').onclick = () => deverrouiller();
  $('#btn-reinitialiser').onclick = reinitialiserAppli;
  $('#btn-activer-faceid').onclick = activerFaceId;
  $('#btn-securite-vu').onclick = securiteVu;
  $('#btn-appairer').onclick = appairerAvecCode;

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
    if (document.hidden) {
      // Flou pour l'aperçu du sélecteur d'applis, coffre enregistré tout de suite.
      securite.cacheDepuis = Date.now();
      if (faceIdActif()) document.body.classList.add('masque');
      sauverCoffre();
      return;
    }
    document.body.classList.remove('masque');
    if (faceIdActif() && demarree && !securite.verrouillee && Date.now() - securite.cacheDepuis > DELAI_VERROU_MS) { verrouiller(); return; }
    if (!demarree || securite.verrouillee) return;
    viderFile();
    // Économie de batterie : l'accueil ne relit le serveur que si la dernière lecture date de plus de 5 minutes.
    if (ecranCourant === 'accueil' && Date.now() - accueilLu > 5 * 60000) rafraichirAccueil();
  });
  // Envois en attente : on réessaie toutes les 5 minutes, et seulement s'il y en a (le retour du réseau relance aussi).
  setInterval(async () => { if (!document.hidden && !envoiEnCours && (await fileCompter()) > 0) viderFile(); }, 5 * 60000);

  // Demande à l'iPhone de ne pas effacer les données de l'appli (envois en attente)
  navigator.storage?.persist?.().catch(() => {});
  surveillerMisesAJour();

  // Avec Face ID, rien n'est déchiffré avant la reconnaissance du visage.
  if (faceIdActif()) verrouiller();
  else demarrer();
});

async function demarrer() {
  await chargerCles();
  await ouvrirCoffre();
  demarree = true;
  dernierePosition = lireJson('position', null);
  if (lire('bienvenue-ok') !== '1') ouvrirBienvenue();
  else ouvrirOnglet('accueil');
  await appairageAutomatique();
  viderFile();
}
