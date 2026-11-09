// Appli Charpente du Léon – logique de l'application
'use strict';

const VERSION = '1.19.1';
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
  if (versionEnAttente) setTimeout(appliquerMiseAJourSiPossible, 300);
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
// Sur le PC, la même protection passe par Windows Hello (visage par la caméra, empreinte ou code PIN).
const nomVerrou = () => (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'Face ID' : 'Windows Hello');

async function faceIdDisponible() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

async function activerFaceId() {
  if (!(await faceIdDisponible())) { toast(`${nomVerrou()} n'est pas disponible sur cet appareil.`, 'erreur'); return; }
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
    toast(`${nomVerrou()} activé 🔒`, 'ok');
  } catch (e) {
    toast(`${nomVerrou()} non activé (${e.message})`, 'erreur');
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
  try { await verifierFaceId(); } catch { toast(`${nomVerrou()} : non reconnu.`, 'erreur'); return; }
  localStorage.removeItem('faceid-id');
  toast(`${nomVerrou()} désactivé`, 'ok');
  dessinerSecurite();
}

function verrouiller() {
  securite.verrouillee = true;
  document.body.classList.add('verrouillee');
  $('#verrou-message').textContent = 'Tes chantiers et tes documents sont protégés.';
  $('#btn-deverrouiller').textContent = `Déverrouiller avec ${nomVerrou()}`;
  $('#btn-reinitialiser').textContent = `${nomVerrou()} ne marche plus ?`;
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
async function appelServeur(donnees, delai = DELAI_SERVEUR_MS) {
  const appairage = donnees.action === 'appairer';
  if (!appairage && !reglages.ok()) throw new Error('Appareil pas encore appairé (Plus › Réglages)');
  const corps = appairage ? JSON.stringify(donnees) : await signer(donnees);
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), delai);
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

// Les chantiers finalisés (terminés, facturés et payés) et archivés ne sont plus dans l'appli (règle de Jean-Phi du
// 09/11) : le serveur 1.9 ne les envoie plus, et on les écarte aussi d'une ancienne liste gardée sur l'appareil.
const STATUTS_HORS_APPLI = ['Finalisé', 'Archivé'];
const listeChantiers = () => lireJson('chantiers', []).filter((c) => c && typeof c === 'object' && !STATUTS_HORS_APPLI.includes(statutDe(c.statut)));

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
  majBoutonRdv();
  majBoutonReleve();
  // La liste des chantiers est rechargée avec l'accueil (au démarrage, puis au plus toutes les 5 min) : un chantier
  // créé ailleurs (rendez-vous, assistant, ProGBat) ou remis en route apparaît sans passer par l'onglet Chantiers.
  rafraichirChantiers().then(() => { if (ecranCourant === 'chantiers') dessinerChantiers(); }).catch(() => {});
  if (!/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) || innerWidth >= 1100) {
    // Sur le PC, la même appli s'installe depuis Edge.
    $('#bandeau-installer strong').textContent = "Installe l'appli sur ce PC";
    $('#bandeau-installer p').innerHTML = "Dans Edge, clique sur l'icône <b>« Installer »</b> au bout de la barre d'adresse (ou menu ··· › Applications › Installer cette appli).";
  }
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
    // Toucher un rendez-vous de l'agenda démarre la visite avec le nom et le lieu déjà remplis.
    return el('li', { class: 'cliquable', onclick: () => { if (confirm(`Démarrer le rendez-vous « ${e.titre} » ?`)) demarrerRdv(e); } },
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
  for (const p of doc.pages) {
    if (p.type !== 'image' || !p.source) continue;
    const brute = await traiterImage(p.source, scan);
    if (p.formes?.length) { p.base = brute; p.data = await rendreAnnotations(brute, p.formes); } else p.data = brute;
  }
  dessinerPages();
}

function dessinerPages() {
  const zone = $('#pages');
  if (!doc.pages.length) {
    zone.replaceChildren(el('div', { class: 'pages-vide' }, doc.action === 'chantier' ? 'Aucune photo pour l\'instant' : 'Aucune page pour l\'instant'));
  } else {
    zone.replaceChildren(...doc.pages.map((p, i) => el('div', { class: 'page' },
      p.type === 'pdf' ? el('div', { class: 'pdf' }, `📄\n${p.nom}`)
        : el('button', { class: 'page-image', 'aria-label': `Dessiner sur la page ${i + 1}`, onclick: () => ouvrirAnnotation(i) },
          el('img', { src: p.data, alt: `Page ${i + 1}` })),
      el('span', { class: 'num' }, doc.action === 'chantier' ? `${i + 1}` : `Page ${i + 1}`),
      p.formes?.length ? el('span', { class: 'annote' }, '✏️') : null,
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
  $('#astuce-annoter').classList.toggle('cache', !doc.pages.some((p) => p.type === 'image'));
}

// ===================== Dessiner sur une photo =====================
// Flèche, cote, cercle, trait ou texte, pour montrer un défaut ou une mesure. Les dessins sont gardés à part
// (la photo d'origine aussi) : on peut les reprendre, et ils survivent au passage en mode scan.
const COULEURS_ANNOT = ['#ff3b30', '#ffcc00', '#ffffff', '#0a84ff'];
const annot = { index: -1, img: null, formes: [], outil: 'fleche', couleur: COULEURS_ANNOT[0], enCours: null, image: 0, precedent: '' };

function chargerDataUrl(src) {
  return new Promise((ok, ko) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => ko(new Error('Photo illisible'));
    i.src = src;
  });
}

const epaisseurTrait = (c) => Math.max(4, Math.round(Math.max(c.width, c.height) / 125));

// Texte sur une pastille sombre : lisible sur n'importe quel fond.
function etiquette(ctx, texte, x, y, ep, couleur) {
  ctx.save();
  ctx.shadowBlur = 0;
  const taille = ep * 6;
  ctx.font = `700 ${taille}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const l = ctx.measureText(texte).width + taille * 0.9, h = taille * 1.45;
  ctx.fillStyle = 'rgba(0,0,0,.7)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - l / 2, y - h / 2, l, h, h / 2); else ctx.rect(x - l / 2, y - h / 2, l, h);
  ctx.fill();
  ctx.fillStyle = couleur;
  ctx.fillText(texte, x, y + taille * 0.04);
  ctx.restore();
}

function dessinerForme(ctx, f, ep) {
  ctx.save();
  ctx.strokeStyle = f.couleur;
  ctx.lineWidth = ep;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = ep * 1.2;
  const pointe = (de, vers) => {
    const ang = Math.atan2(vers.y - de.y, vers.x - de.x), l = ep * 4.5;
    ctx.beginPath();
    ctx.moveTo(vers.x - l * Math.cos(ang - 0.45), vers.y - l * Math.sin(ang - 0.45));
    ctx.lineTo(vers.x, vers.y);
    ctx.lineTo(vers.x - l * Math.cos(ang + 0.45), vers.y - l * Math.sin(ang + 0.45));
    ctx.stroke();
  };
  if (f.type === 'trait') {
    ctx.beginPath();
    f.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  } else if (f.type === 'fleche' || f.type === 'cote') {
    ctx.beginPath();
    ctx.moveTo(f.a.x, f.a.y);
    ctx.lineTo(f.b.x, f.b.y);
    ctx.stroke();
    pointe(f.a, f.b);
    if (f.type === 'cote') {
      pointe(f.b, f.a);
      // Traits de rappel aux deux bouts, comme sur un plan.
      const ang = Math.atan2(f.b.y - f.a.y, f.b.x - f.a.x) + Math.PI / 2, l = ep * 3.5;
      for (const p of [f.a, f.b]) {
        ctx.beginPath();
        ctx.moveTo(p.x - l * Math.cos(ang), p.y - l * Math.sin(ang));
        ctx.lineTo(p.x + l * Math.cos(ang), p.y + l * Math.sin(ang));
        ctx.stroke();
      }
      if (f.texte) etiquette(ctx, f.texte, (f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2, ep, f.couleur);
    }
  } else if (f.type === 'cercle') {
    ctx.beginPath();
    ctx.ellipse((f.a.x + f.b.x) / 2, (f.a.y + f.b.y) / 2, Math.abs(f.b.x - f.a.x) / 2 + 1, Math.abs(f.b.y - f.a.y) / 2 + 1, 0, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (f.type === 'texte') {
    etiquette(ctx, f.texte, f.a.x, f.a.y, ep, f.couleur);
  }
  ctx.restore();
}

// Photo d'origine + dessins → nouvelle photo (sert aussi quand le mode scan est changé après coup).
async function rendreAnnotations(dataUrl, formes) {
  const img = await chargerDataUrl(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const ep = epaisseurTrait(c);
  for (const f of formes) dessinerForme(ctx, f, ep);
  return c.toDataURL('image/jpeg', QUALITE_JPEG);
}

async function ouvrirAnnotation(index) {
  const p = doc.pages[index];
  if (!p || p.type !== 'image') return;
  try { annot.img = await chargerDataUrl(p.base || p.data); } catch (e) { toast(e.message, 'erreur'); return; }
  annot.index = index;
  annot.formes = structuredClone(p.formes || []);
  annot.enCours = null;
  const c = $('#annot-canvas');
  c.width = annot.img.width;
  c.height = annot.img.height;
  annot.precedent = ecranPrecedent;
  afficher('annoter');
  redessinerAnnotation();
}

function redessinerAnnotation() {
  const c = $('#annot-canvas');
  if (!annot.img) return;
  const ctx = c.getContext('2d');
  const ep = epaisseurTrait(c);
  ctx.drawImage(annot.img, 0, 0);
  for (const f of annot.formes) dessinerForme(ctx, f, ep);
  if (annot.enCours) dessinerForme(ctx, annot.enCours, ep);
  $('#annot-defaire').disabled = !annot.formes.length;
}

function pointAnnotation(ev) {
  const c = $('#annot-canvas'), r = c.getBoundingClientRect();
  return { x: Math.round((ev.clientX - r.left) * c.width / r.width), y: Math.round((ev.clientY - r.top) * c.height / r.height) };
}

function annotDebut(ev) {
  ev.preventDefault();
  const p = pointAnnotation(ev);
  if (annot.outil === 'texte') {
    const t = prompt('Texte à écrire sur la photo :');
    if (t && t.trim()) annot.formes.push({ type: 'texte', couleur: annot.couleur, a: p, texte: t.trim().slice(0, 60) });
    redessinerAnnotation();
    return;
  }
  try { ev.target.setPointerCapture(ev.pointerId); } catch { /* sans importance */ }
  annot.enCours = annot.outil === 'trait'
    ? { type: 'trait', couleur: annot.couleur, pts: [p] }
    : { type: annot.outil, couleur: annot.couleur, a: p, b: p };
}

function annotMouvement(ev) {
  if (!annot.enCours) return;
  ev.preventDefault();
  const p = pointAnnotation(ev);
  if (annot.enCours.type === 'trait') annot.enCours.pts.push(p); else annot.enCours.b = p;
  if (!annot.image) annot.image = requestAnimationFrame(() => { annot.image = 0; redessinerAnnotation(); });
}

function annotFin() {
  const f = annot.enCours;
  annot.enCours = null;
  if (!f) return;
  const min = epaisseurTrait($('#annot-canvas')) * 3;
  const assezGrand = f.type === 'trait' ? f.pts.length > 2 : Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) > min;
  if (assezGrand) {
    if (f.type === 'cote') {
      redessinerAnnotation();
      const t = prompt('La mesure (ex. 2,40 m) :', '');
      if (t === null) { redessinerAnnotation(); return; }
      f.texte = t.trim().slice(0, 30);
    }
    annot.formes.push(f);
  }
  redessinerAnnotation();
}

function choisirOutil(outil) {
  annot.outil = outil;
  ecrire('annot-outil', outil);
  for (const b of $$('#annot-outils [data-outil]')) b.classList.toggle('active', b.dataset.outil === outil);
}

function choisirCouleur(couleur) {
  annot.couleur = couleur;
  ecrire('annot-couleur', couleur);
  for (const b of $$('#annot-couleurs [data-couleur]')) b.classList.toggle('active', b.dataset.couleur === couleur);
}

function fermerAnnotation() {
  annot.img = null;
  annot.formes = [];
  annot.enCours = null;
  afficher('document');
  ecranPrecedent = annot.precedent; // « Annuler » du document ramène toujours là d'où il venait
  dessinerPages();
}

function validerAnnotation() {
  const p = doc.pages[annot.index];
  if (p && annot.img) {
    if (annot.formes.length) {
      p.base = p.base || p.data;
      p.formes = annot.formes;
      p.data = $('#annot-canvas').toDataURL('image/jpeg', QUALITE_JPEG);
    } else if (p.base) {
      p.data = p.base;
      delete p.base;
      delete p.formes;
    }
  }
  fermerAnnotation();
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

// « Tous » montre tous les chantiers de l'appli (les finalisés n'y sont plus).
const dansFiltre = (c, filtre) => (filtre ? statutDe(c.statut) === filtre : true);

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
  ficheDepuisRdv = false;
  $('#fiche-retour').textContent = '‹ Chantiers';
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

// ===================== Téléphone, adresse, code postal, ville =====================
const RE_TEL = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/;
function formaterTel(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+33')) d = `0${d.slice(3)}`;
  return /^0\d{9}$/.test(d) ? d.replace(/(\d{2})(?=\d)/g, '$1 ') : String(t || '').trim();
}
// « Jean Le Gall 06 88 82 50 41 » tapé dans Client : le numéro passe dans Téléphone (demande de Jean-Phi, 09/11).
function separerTelephone(client, tel) {
  const texte = String(client || '');
  const m = texte.match(RE_TEL);
  if (!m) return { client: texte.trim(), tel: tel ? formaterTel(tel) : '' };
  const reste = texte.replace(m[0], ' ').replace(/\b(t[ée]l[ée]?(phone)?|port(able)?|mobile)\s*[.:]?\s*/gi, ' ')
    .replace(/^[\s,;:/–-]+|[\s,;:/–-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return { client: reste, tel: tel ? formaterTel(tel) : formaterTel(m[0]) };
}
// « 7 Poulscavennou, 29233 Cléder » ↔ { rue, cp, ville }
function separerAdresse(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(.*?)[,\s]*\b(\d{5})\s+(.+)$/);
  return m ? { rue: m[1].trim(), cp: m[2], ville: m[3].trim() } : { rue: t, cp: '', ville: '' };
}
const joindreAdresse = (rue, cp, ville) => [String(rue || '').trim(), [cp, ville].map((x) => String(x || '').trim()).filter(Boolean).join(' ')]
  .filter(Boolean).join(', ');

// Propose l'adresse en tapant (Base adresse nationale), la ville d'après le code postal (une seule = remplie,
// plusieurs = au choix) et le code postal d'après la ville. quandChange(pos) : pos = { lat, lon } si une adresse
// proposée a été choisie, null sinon (position inconnue).
function brancherAdresse(p, quandChange) {
  const rue = $(`#${p}-adresse`), cp = $(`#${p}-cp`), ville = $(`#${p}-ville`);
  const listeA = $(`#${p}-adresse-propositions`), listeV = $(`#${p}-ville-propositions`);
  let minuteur = 0, demande = 0;
  const fermer = (l) => { l.classList.add('cache'); l.replaceChildren(); };
  const proposer = (l, items) => {
    if (!items.length) { fermer(l); return; }
    l.replaceChildren(...items.map(({ texte, petit, choisir }) => el('li', {}, el('button', {
      type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => { fermer(l); choisir(); },
    }, el('span', {}, texte), petit ? el('small', {}, petit) : null))));
    l.classList.remove('cache');
  };
  const chercher = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  rue.addEventListener('input', () => {
    quandChange(null);
    clearTimeout(minuteur);
    const q = rue.value.trim();
    if (q.length < 4 || !navigator.onLine) { fermer(listeA); return; }
    minuteur = setTimeout(async () => {
      const n = ++demande;
      const params = { q: ville.value && !q.includes(ville.value) ? `${q} ${ville.value}` : q, autocomplete: 1, limit: 5 };
      if (/^\d{5}$/.test(cp.value)) params.postcode = cp.value;
      if (dernierePosition && Date.now() - dernierePosition.quand < 3600000) Object.assign(params, { lat: dernierePosition.lat.toFixed(4), lon: dernierePosition.lon.toFixed(4) });
      try {
        const j = await chercher(`https://data.geopf.fr/geocodage/search?${new URLSearchParams(params)}`);
        if (n !== demande || document.activeElement !== rue) return;
        proposer(listeA, (j.features || []).map((f) => {
          const pr = f.properties;
          return { texte: pr.type === 'municipality' ? pr.city : pr.name, petit: `${pr.postcode} ${pr.city}`, choisir: () => {
            rue.value = pr.type === 'municipality' ? '' : pr.name;
            cp.value = pr.postcode || '';
            ville.value = pr.city || '';
            fermer(listeV);
            const [lon, lat] = f.geometry?.coordinates || [];
            quandChange(pr.type === 'municipality' ? null : { lat, lon });
          } };
        }));
      } catch { /* hors ligne ou service lent : on tape à la main */ }
    }, 250);
  });
  cp.addEventListener('input', async () => {
    cp.value = cp.value.replace(/\D/g, '').slice(0, 5);
    quandChange(null);
    if (cp.value.length !== 5) { fermer(listeV); return; }
    try {
      const communes = (await chercher(`https://geo.api.gouv.fr/communes?codePostal=${cp.value}&fields=nom`))
        .map((c) => c.nom).sort((a, b) => a.localeCompare(b, 'fr'));
      if (communes.length === 1) { ville.value = communes[0]; fermer(listeV); quandChange(null); }
      else if (communes.length > 1 && !communes.includes(ville.value)) {
        ville.value = '';
        proposer(listeV, communes.map((nom) => ({ texte: nom, choisir: () => { ville.value = nom; quandChange(null); } })));
      } else if (!communes.length) toast(`Aucune commune pour le code postal ${cp.value}.`, 'erreur');
    } catch { /* hors ligne */ }
  });
  ville.addEventListener('input', () => {
    quandChange(null);
    clearTimeout(minuteur);
    const q = ville.value.trim();
    if (q.length < 3 || /^\d{5}$/.test(cp.value)) { fermer(listeV); return; }
    minuteur = setTimeout(async () => {
      const n = ++demande;
      try {
        const communes = await chercher(`https://geo.api.gouv.fr/communes?${new URLSearchParams({ nom: q, fields: 'nom,codesPostaux,departement', boost: 'population', limit: 6 })}`);
        if (n !== demande || document.activeElement !== ville) return;
        proposer(listeV, communes.flatMap((c) => (c.codesPostaux || []).slice(0, 3).map((code) => ({
          texte: c.nom, petit: `${code}${c.departement ? ` · ${c.departement.nom}` : ''}`,
          choisir: () => { ville.value = c.nom; cp.value = code; quandChange(null); },
        }))).slice(0, 6));
      } catch { /* hors ligne */ }
    }, 250);
  });
  for (const [champ, liste] of [[rue, listeA], [cp, listeV], [ville, listeV]]) {
    champ.addEventListener('blur', () => setTimeout(() => fermer(liste), 250));
  }
}

// Client : un numéro tapé dedans part dans Téléphone ; Téléphone : mis en forme « 06 88 82 50 41 ».
function brancherClientTel(champClient, champTel, quandChange) {
  champClient.addEventListener('change', () => {
    const s = separerTelephone(champClient.value, champTel.value);
    if (s.client === champClient.value && s.tel === champTel.value) return;
    const deplace = !champTel.value && s.tel;
    champClient.value = s.client;
    champTel.value = s.tel;
    quandChange();
    if (deplace) toast('Numéro rangé dans « Téléphone » ✅', 'ok');
  });
  champTel.addEventListener('change', () => { champTel.value = formaterTel(champTel.value); quandChange(); });
}

let fichePos = null;
let ficheDepuisRdv = false;
function dessinerFiche(f) {
  ficheCourante = f;
  fichePos = null;
  // Numéro tapé dans Client par le passé : on le range tout seul dans Téléphone (une fois).
  if (!f.telephone && RE_TEL.test(f.client || '')) {
    const s = separerTelephone(f.client, '');
    f.client = s.client; f.telephone = s.tel;
    mettreEnFile([{ action: 'majChantier', chantier: f.nom, client: s.client, telephone: s.tel }]);
  }
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
  const a = separerAdresse(f.adresse);
  $('#fiche-adresse').value = a.rue;
  $('#fiche-cp').value = a.cp;
  $('#fiche-ville').value = a.ville;
  $('#fiche-devis').value = f.devisHT ? String(f.devisHT).replace('.', ',') : '';

  const blocs = [];
  if (f.argent) blocs.push(carteRentabilite(f.argent));
  if (f.evenements?.length) {
    blocs.push(el('section', { class: 'carte' }, el('h2', {}, '📅 Prochains rendez-vous'),
      el('ul', { class: 'liste-simple' }, ...f.evenements.map((e) => el('li', {},
        el('div', { class: 'agenda-texte' }, el('div', {}, e.titre), el('small', {}, jourLisible(e.debut, e.journee))))))));
  }
  // Relevés gardés en données : on les rouvre pour corriger une cote, changer le bac ou la couleur, refaire la feuille.
  if (f.releves?.length) {
    blocs.push(el('section', { class: 'carte rubrique releves-fiche' }, el('h2', {}, '📏 Relevés à reprendre', el('span', { class: 'nb' }, String(f.releves.length))),
      ...f.releves.map((r) => {
        const b = el('button', { class: 'fichier' }, el('span', {}, '📏'), el('span', { class: 'fichier-texte' },
          el('span', {}, r.titre), el('small', {}, [new Date(r.maj).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }), r.resume].filter(Boolean).join(' · '))),
          el('span', { class: 'ouvrir' }, 'Ouvrir ›'));
        b.onclick = () => ouvrirReleveSauve(f.nom, r.id, b);
        return b;
      })));
  }
  const icones = { 'Plans': '📐', 'Devis & contrat': '📝', 'Achats': '🧾', 'Photos': '📷', 'Divers': '📎' };
  const ordre = ['Photos', 'Plans', 'Devis & contrat', 'Achats', 'Divers'];
  for (const titre of ordre) {
    const r = f.rubriques.find((x) => x.titre === titre);
    if (!r) continue;
    const bloc = el('section', { class: 'carte rubrique' },
      el('h2', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, `${icones[r.titre] || '📁'} ${r.titre}`), el('span', { class: 'nb' }, String(r.total))));
    if (r.vignettes?.length) {
      bloc.append(grillePhotos(f, ficheDepuisRdv && V.actif));
      bloc.append(el('p', { class: 'discret aide-mesurer' }, 'Touche une photo pour mesurer dessus ou la voir en grand.'));
      bloc.append(el('button', { class: 'photos-gros petit', type: 'button', onclick: () => ouvrirPhotos(f.nom, () => afficher('fiche')) },
        el('span', {}, '📷'), 'Prendre ou ajouter des photos'));
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

// Rouvre un relevé rangé (données gardées par le serveur) pour le retravailler ; « Ranger » le réenregistre au même endroit.
async function ouvrirReleveSauve(chantier, id, bouton, depuisRdv = false) {
  const enCours = R.actif && (R.elements.length || Object.values(R.gabarit.saisis || {}).some(Boolean));
  if (enCours && R.id !== id && !confirm('Un autre relevé est en cours. L\'ouvrir quand même ? Celui en cours sera remplacé.')) return;
  const texte = bouton?.querySelector('.ouvrir');
  if (texte) texte.textContent = 'Ouverture…';
  try {
    const r = await appelServeur({ action: 'lireReleve', chantier, id }, 60000);
    remplirSelectChantiers($('#releve-chantier'), chantier, '— Choisir le chantier —');
    afficher('releve');
    await demarrerReleve({ ...r.releve, id, chantier, depuisRdv: (depuisRdv || ficheDepuisRdv) && !!V.actif, photoEnvoyee: true });
    toast('Relevé rouvert : corrige ce qu\'il faut, puis refais la feuille ✅', 'ok');
  } catch (e) {
    toast(`Relevé impossible à ouvrir : ${e.message}`, 'erreur');
  } finally { if (texte) texte.textContent = 'Ouvrir ›'; }
}

// Photo déjà rangée dans le chantier (prise avant, ou importée) : on fait le relevé dessus comme sur une photo neuve.
// Claude propose les cotes à prendre, Jean-Phi les tape, règle la zone de travaux, puis « Ranger » garde le relevé.
async function mesurerPhotoChantier(chantier, v, bouton, depuisRdv = false) {
  const enCours = R.actif && (R.elements.length || Object.values(R.gabarit?.saisis || {}).some(Boolean));
  if (enCours && !confirm('Un relevé est en cours. Le remplacer par un relevé sur cette photo ?')) return;
  const texte = bouton.innerHTML;
  bouton.disabled = true; bouton.textContent = '⏳ J\'ouvre la photo…';
  try {
    const r = await appelServeur({ action: 'photoChantier', chantier, id: v.id }, 90000);
    const binaire = atob(r.data);
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
    const data = await traiterImage(new Blob([octets], { type: r.type || 'image/jpeg' }), false);
    afficher('releve');
    await demarrerReleve({ mode: 'photo', photo: data, elements: [], chantier, photoEnvoyee: true, facade: '',
      depuisRdv: (depuisRdv || ficheDepuisRdv) && !!V.actif });
    sauverBrouillonReleve();
    analyserPhotoReleve();
    toast('Photo ouverte : donne le nom de la façade ; Claude cherche les mesures à prendre…', 'ok');
  } catch (e) {
    toast(`Photo impossible à ouvrir : ${e.message}`, 'erreur');
  } finally { bouton.disabled = false; bouton.innerHTML = texte; }
}

// ===================== Photos du chantier (1.18) =====================
// Demande de Jean-Phi (09/11) : « il faut que ce soit très intuitif ». Un seul écran pour les photos d'un chantier :
// 3 gros boutons (prendre, galerie, notes papier) et les photos ; toucher une photo → Mesurer dessus ou la voir en grand.
// L'accueil, la fiche et le rendez-vous mènent tous ici ou montrent la même grille.
const P = { chantier: '', fiche: null, enCours: '', retour: null, locales: [] };

function ouvrirPhotos(chantier = '', retour = null) {
  P.retour = retour;
  if (chantier !== P.chantier) { P.fiche = null; P.locales = []; }
  P.chantier = chantier || P.chantier || '';
  remplirSelectChantiers($('#photos-chantier'), P.chantier, '— Choisis le chantier —');
  $('#photos-retour').textContent = retour ? '‹ Retour' : '‹ Accueil';
  $('#photos-gps').textContent = '';
  afficher('photos');
  dessinerPhotos();
  if (P.chantier) chargerPhotos(P.chantier);
  else localiserPhotos();
  rafraichirChantiers().then(() => { if (ecranCourant === 'photos') remplirSelectChantiers($('#photos-chantier'), P.chantier, '— Choisis le chantier —'); }).catch(() => {});
}

async function localiserPhotos() {
  const gps = $('#photos-gps');
  gps.textContent = '📍 Je cherche sur quel chantier tu es…';
  const pos = await obtenirPosition();
  if (P.chantier || ecranCourant !== 'photos') { gps.textContent = ''; return; }
  const proche = pos && chantierLePlusProche(pos);
  if (proche) {
    P.chantier = proche.nom;
    $('#photos-chantier').value = proche.nom;
    gps.textContent = `📍 Tu es sur ${proche.nom} (${distanceLisible(proche.distance)})`;
    chargerPhotos(proche.nom);
  } else gps.textContent = '👆 Choisis le chantier dans la liste.';
}

function chargerPhotos(nom) {
  if (P.enCours === nom) return;
  if (!navigator.onLine || !reglages.ok()) { dessinerPhotos(); return; }
  P.enCours = nom;
  dessinerPhotos();
  appelServeur({ action: 'fiche', chantier: nom }, 60000).then((r) => {
    if (P.chantier === nom) { P.fiche = r.fiche; P.locales = []; }
    const { rubriques, ...reste } = r.fiche;
    ecrireJson(`fiche:${nom}`, { ...reste, rubriques: rubriques.map(({ vignettes, ...x }) => x) });
    if (rdvFiche?.nom === nom || (V.actif && V.chantier === nom)) rdvFiche = r.fiche;
  }).catch((e) => toast(`Photos indisponibles : ${e.message}`, 'erreur'))
    .finally(() => { P.enCours = ''; if (ecranCourant === 'photos' && P.chantier === nom) dessinerPhotos(); });
}

function dessinerPhotos() {
  const grille = $('#photos-grille'), plus = $('#photos-plus');
  for (const b of $$('.photos-actions button')) b.disabled = !P.chantier;
  if (!P.chantier) { grille.replaceChildren(); plus.replaceChildren(); return; }
  const f = P.fiche?.nom === P.chantier ? P.fiche : null;
  const photos = f?.rubriques.find((r) => r.titre === 'Photos');
  const tuiles = P.locales.map((src) => el('div', { class: 'photo-tuile envoi' }, el('img', { src, alt: 'Photo en cours d\'envoi' }), el('span', { class: 'photo-etat' }, '⏫ envoi…')));
  if (f) tuiles.push(...grillePhotos(f, P.retour === ouvrirRdv).children);
  if (!tuiles.length) {
    grille.replaceChildren(el('p', { class: 'etat-vide' }, P.enCours ? '⏳ Je charge les photos…' : !navigator.onLine ? '📡 Pas de réseau : les photos s\'afficheront dès que possible.' : 'Pas encore de photo : touche « Prendre une photo » ou « Ajouter de ma galerie ».'));
  } else grille.replaceChildren(...tuiles);
  plus.replaceChildren();
  if (photos && photos.total > (photos.vignettes?.length || 0)) {
    plus.append(el('a', { class: 'lien photos-toutes', href: photos.url, target: '_blank', rel: 'noopener' }, `📁 Voir les ${photos.total} photos dans Drive ›`));
  }
}

// Grille de photos (vignettes du serveur) : toucher une photo ouvre le choix « Mesurer » / « Voir en grand ».
function grillePhotos(f, depuisRdv = false) {
  const photos = f.rubriques.find((r) => r.titre === 'Photos');
  return el('div', { class: 'photos-grille' }, ...(photos?.vignettes || []).map((v) => {
    const t = el('button', { class: 'photo-tuile', type: 'button', 'aria-label': 'Photo : mesurer ou voir en grand' },
      el('img', { src: `data:image/jpeg;base64,${v.data}`, alt: '', loading: 'lazy' }), el('span', { class: 'photo-etat' }, '📏 Mesurer'));
    t.onclick = () => choisirPhoto(f.nom, v, depuisRdv);
    return t;
  }));
}

function choisirPhoto(chantier, v, depuisRdv) {
  const boite = $('#photos-choix');
  $('#photos-choix-img').src = `data:image/jpeg;base64,${v.data}`;
  $('#photos-choix-voir').href = v.url;
  const mesurer = $('#photos-choix-mesurer');
  mesurer.disabled = !v.id;
  mesurer.onclick = async () => {
    await mesurerPhotoChantier(chantier, v, mesurer, depuisRdv || !!(V.actif && P.retour === ouvrirRdv));
    if (ecranCourant === 'releve') boite.classList.add('cache');
  };
  boite.classList.remove('cache');
}

// Envoi direct dans « 04 Photos » (ou « 02 Devis & contrat » pour les notes papier), comme dans le rendez-vous.
async function envoyerPhotosChantier(fichiers, notesPapier, depuisGalerie) {
  const chantier = P.chantier;
  if (!chantier) { toast('Choisis d\'abord le chantier.', 'erreur'); $('#photos-chantier').focus(); return; }
  if (!fichiers.length) return;
  if (fichiers.length > 1) toast(`${fichiers.length} ${notesPapier ? 'pages' : 'photos'} en cours d'envoi…`);
  let partis = true;
  for (const f of fichiers) {
    try {
      const data = await traiterImage(f, notesPapier);
      if (!notesPapier) { P.locales.unshift(data); dessinerPhotos(); }
      const envoi = { action: 'chantier', docId: nouvelId(), date: new Date(depuisGalerie && f.lastModified ? f.lastModified : Date.now()).toISOString(),
        total: 1, page: 1, type: '', chantier, note: notesPapier ? 'Notes papier' : (depuisGalerie ? 'Photo ajoutée de la galerie' : 'Photo de chantier'),
        fichier: { mime: 'image/jpeg', data: data.split(',')[1] } };
      if (notesPapier) Object.assign(envoi, { rubrique: '02 Devis & contrat', prefixe: 'Notes' });
      if (!depuisGalerie && dernierePosition && Date.now() - dernierePosition.quand < 600000) Object.assign(envoi, { lat: dernierePosition.lat, lon: dernierePosition.lon });
      if (V.actif && V.chantier === chantier) { if (notesPapier) V.notes++; else V.photos++; sauverRdv(); }
      const { tousPartis } = await mettreEnFile([envoi]);
      partis = partis && tousPartis;
    } catch (e) { toast(e.message, 'erreur'); }
  }
  toast(partis ? (notesPapier ? 'Notes rangées dans le chantier ✅' : 'Photos rangées dans le chantier ✅') : 'Gardées : elles partiront dès qu\'il y aura du réseau.', partis ? 'ok' : '');
  if (partis && !notesPapier) { P.fiche = null; chargerPhotos(chantier); }
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
  // Un chantier archivé ou finalisé disparaît de l'appli (le serveur ne l'envoie plus).
  const sort = STATUTS_HORS_APPLI.includes(statut);
  ecrireJson('chantiers', sort ? liste.filter((x) => x.nom !== nom) : liste);
  await mettreEnFile([{ action: 'majChantier', chantier: nom, statut }]);
  toast(statut === 'Archivé' ? `${nom} archivé` : sort ? `${nom} finalisé : il sort de l'appli (il reste dans ProGBat et Drive)` : `Statut : ${statut}`, 'ok');
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
  const s = separerTelephone($('#fiche-client').value, $('#fiche-tel').value);
  const maj = { client: s.client, telephone: s.tel, adresse: joindreAdresse($('#fiche-adresse').value, $('#fiche-cp').value, $('#fiche-ville').value), devisHT };
  Object.assign(ficheCourante, maj, { devisHT: devisHT || null });
  if (fichePos) { Object.assign(maj, fichePos); Object.assign(ficheCourante, fichePos); }
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

// ===================== Relevé de mesures sur photo =====================
// Une ou plusieurs cotes mesurées sur place (Mesure, mètre, laser) donnent l'échelle ; tout le reste se mesure sur la
// photo. Avec une mesure horizontale et une verticale, l'échelle est calculée dans les deux sens (photo prise d'en bas).
const OUVRAGES = {
  bardage: [['lame', 'Largeur de lame (mm)', 150], ['joint', 'Joint (mm)', 10], ['lisses', 'Entraxe des lisses (cm)', 60],
    ['fixations', 'Fixations par croisement', 2], ['chute', 'Chute (%)', 10]],
  couverture: [['liteaux', 'Entraxe des liteaux (cm)', 32], ['chevrons', 'Entraxe des chevrons (cm)', 60],
    ['unites', 'Ardoises ou tuiles au m²', 0], ['surface', 'Surface (m², 0 = toiture calculée)', 0], ['chute', 'Chute (%)', 10]],
  // Plaques ondulées (type Everite 5 ondes 93 × 150) : surface utile = (largeur − recouvrement latéral) × (longueur − recouvrement en bout).
  plaques: [['largeur', 'Largeur plaque (cm)', 93], ['longueur', 'Longueur plaque (cm)', 150],
    ['recLat', 'Recouvrement latéral (cm)', 5], ['recBout', 'Recouvrement en bout (cm)', 14],
    ['surface', 'Surface (m², 0 = toiture calculée)', 0], ['chute', 'Chute (%)', 5]],
  // Bac acier de Jean-Phi : Coverbac 3.45R 1000 (largeur utile 1 000 mm), 0,63 mm, RAL 7016 + feutre, chez Belmet
  // (commande atelier n° 2698036, mai 2026), plaques à longueur avec 10 cm de débord en bas de pente.
  bac: [['couleur', 'Couleur (RAL, au choix du client)', 'RAL 7016'], ['utile', 'Largeur utile (mm)', 1000], ['debordBas', 'Débord bas de pente (cm)', 10], ['eclairantes', 'Plaques éclairantes (nombre)', 0],
    ['cavaliers', 'Cavaliers au m²', 4.5], ['coutures', 'Vis de couture au m²', 2.2]],
  // Bardage en bac de Jean-Phi : MUREXTER noir sablé RAL 9005 chez Belmet (chantier Mevel, juin 2026), largeur utile
  // 1 070 mm (à faire confirmer par Belmet), plaques verticales, vis 4,8 × 35.
  bacmur: [['couleur', 'Couleur (RAL, au choix du client)', 'RAL 9005'], ['utile', 'Largeur utile (mm)', 1070], ['marge', 'Marge sur la longueur (cm)', 5], ['eclairantes', 'Plaques éclairantes (nombre)', 0],
    ['vis', 'Vis 4,8 × 35 au m²', 4], ['coutures', 'Vis de couture au m²', 1.5]],
  aucun: [],
};
const NOMS_OUVRAGES = { bardage: 'Bardage bois', couverture: 'Couverture', plaques: 'Plaques ondulées', bac: 'Bac acier – toiture',
  bacmur: 'Bac acier – bardage', aucun: 'Surfaces' };

// Haut de la surface (y le plus petit, en mètres) sur une verticale x : intersection avec les bords du polygone.
function hautSurface(pts, x) {
  let haut = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((a.x - x) * (b.x - x) > 0 || a.x === b.x) continue;
    const y = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    haut = Math.min(haut, y);
  }
  return haut;
}

// Calepinage du bac acier : la liste des plaques (longueurs arrondies aux 5 cm au-dessus), regroupées.
function regrouperPlaques(longueurs) {
  const n = {};
  for (const l of longueurs) { const k = (Math.ceil(l * 20 - 1e-6) / 20).toFixed(2); n[k] = (n[k] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[0] - a[0]).map(([l, c]) => `${c} × ${l.replace('.', ',')} m`).join(' · ');
}

function calepinageBac(p, usage) {
  const u = (Number(p.utile) || 1000) / 1000, deb = (Number(p.debordBas) || 0) / 100;
  const lignes = [];
  let surface = 0, nb = 0;
  if (usage === 'toiture') {
    if (!(R.mode === 'saisie' && R.pans?.length)) {
      return [['Calepinage de toiture', 'tape la longueur du bâtiment (relevé « J\'ai mes mesures »)']];
    }
    // Toiture : un rang de plaques par pan, chaque plaque fait le rampant + le débord bas.
    let closoir = 0, rives = 0;
    for (const pan of R.pans) {
      const n = Math.ceil(pan.long / u - 1e-6), l = pan.r + deb;
      lignes.push([`${pan.nom} : ${n} plaques`, regrouperPlaques(new Array(n).fill(l))]);
      surface += n * u * l; nb += n; closoir += pan.long; rives += 2 * l;
    }
    lignes.push(['Closoir mousse bas de pente', `${fmtM(closoir)} ml`], ['Bandes de rive', `${fmtM(rives)} ml (${Math.ceil(rives / 3)} × 3 m)`]);
    if (R.pans.length === 2) lignes.push(['Faîtière', `${fmtM(R.pans[0].long)} ml (${Math.ceil(R.pans[0].long / 3)} × 3 m)`]);
  } else {
    // Façade (bardage en bac) : des plaques verticales de gauche à droite ; au-dessus d'une porte ou d'un portail
    // (ouverture qui part du sol), la plaque s'arrête au linteau.
    const s = echelleReleve();
    const surf = R.elements.find((e) => e.type === 'surface');
    if (!s || !surf) return [];
    // Zone de travaux : seule la partie dans la zone est calepinée ; les angles ne comptent que sur un vrai coin du bâtiment.
    const r = rectZone(s);
    const pts = ptsZone(surf, s, r);
    if (pts.length < 3) return [['Calepinage', 'la zone de travaux ne touche pas la façade']];
    const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), sol = Math.max(...pts.map((q) => q.y));
    // Porte ou portail qui descend jusqu'en bas de la partie bardée : la plaque s'arrête au linteau.
    const portes = R.elements.filter((e) => e.type === 'ouverture').map((e) => {
      const pied = etenduePied(e, s);
      const linteau = e.projetH > 0 ? pied.sol - e.projetH : Math.min(...e.pts.map((q) => versM(q, s).y));
      return { ...pied, linteau };
    }).filter((o) => o.sol > sol - 0.25);
    const longueurs = [];
    for (let xa = x0; xa < x1 - 0.02; xa += u) {
      const xb = Math.min(xa + u, x1);
      const xs = [xa, xb, ...pts.filter((q) => q.x > xa && q.x < xb).map((q) => q.x)];
      const haut = Math.min(...xs.map((x) => hautSurface(pts, Math.min(Math.max(x, x0 + 1e-6), x1 - 1e-6))));
      let l = sol - haut;
      const porte = portes.find((o) => o.x0 <= xa + 0.05 && o.x1 >= xb - 0.05);
      if (porte) l -= Math.max(0, sol - Math.max(porte.linteau, haut));
      if (l > 0.05) longueurs.push(l + (Number(p.marge) || 0) / 100);
    }
    const coinG = !r || r.xa <= r.X0 + 0.01, coinD = !r || r.xb >= r.X1 - 0.01;
    const angles = (coinG ? sol - hautSurface(pts, x0 + 1e-6) : 0) + (coinD ? sol - hautSurface(pts, x1 - 1e-6) : 0);
    nb = longueurs.length;
    surface = longueurs.reduce((t, l) => t + l * u, 0);
    lignes.push([`${r ? 'Zone de travaux' : 'Façade'} : ${nb} plaques`, regrouperPlaques(longueurs)]);
    lignes.push([r && !(r.yb >= r.sol - 0.01) ? 'Raccord bas (bavette)' : 'Bavette / closoir bas', `${fmtM(x1 - x0)} ml`]);
    if (angles > 0) lignes.push([`Angles (${coinG && coinD ? '2 côtés' : '1 côté'})`, `${fmtM(angles)} ml`]);
    if (r && r.ya > r.sommet + 0.01 && pts.some((q) => Math.abs(q.y - r.ya) < 0.001)) lignes.push(['Raccord haut (avec l\'existant)', `${fmtM(x1 - x0)} ml`]);
    if (r && !(coinG && coinD)) lignes.push(['Raccord avec l\'existant', `${fmtM((coinG ? 0 : sol - hautSurface(pts, x0 + 1e-6)) + (coinD ? 0 : sol - hautSurface(pts, x1 - 1e-6)))} ml (profil de jonction)`]);
    if (Number(p.marge)) lignes.push(['Marge comprise dans les longueurs', `${p.marge} cm par plaque`]);
  }
  const ecl = Math.min(Number(p.eclairantes) || 0, nb);
  if (ecl) lignes.push(['Dont plaques éclairantes', `${ecl}`]);
  const dizaine = (x) => fmtNb(Math.ceil(x / 10) * 10);
  if (usage === 'toiture') {
    lignes.unshift(['Bac acier', `Coverbac 3.45R · utile ${fmtNb(u * 1000)} mm · 0,63 mm · ${p.couleur || 'couleur à choisir'} + feutre (Belmet)`]);
    lignes.push(['Surface de bac', `${fmtNb(surface, 2)} m²`]);
    lignes.push(['Cavaliers 3 en 1', `≈ ${dizaine(surface * (Number(p.cavaliers) || 4.5))}`]);
  } else {
    lignes.unshift(['Bac acier', `MUREXTER · utile ${fmtNb(u * 1000)} mm · ${p.couleur || 'couleur à choisir'} (Belmet, largeur à confirmer)`]);
    lignes.push(['Surface de bac', `${fmtNb(surface, 2)} m²`]);
    lignes.push(['Vis 4,8 × 35', `≈ ${dizaine(surface * (Number(p.vis) || 4))}`]);
  }
  lignes.push(['Vis de couture', `≈ ${dizaine(surface * (Number(p.coutures) || 2))}`]);
  return lignes;
}
// mode « saisie » : formes et mesures tapées, l'appli calcule le reste ; mode « photo » : on mesure sur la photo.
const R = { mode: 'saisie', photo: '', img: null, elements: [], outil: 'cote', enCours: null, glisse: null, loupe: null, historique: [],
  ouvrage: 'bardage', params: {}, image: 0, feuilles: [], minuteur: null,
  echelleFixe: null, lineaires: [], toiture: 0, incomplet: [], alertes: [],
  gabarit: { type: 'pignon', saisis: {}, ouvertures: [] }, zone: { actif: false, depuis: 'gauche', de: 0, a: 0, bas: 0, haut: 0 },
  travaux: [], compris: '', suiteAutreMur: null };

const fmtM = (n) => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
const fmtNb = (n, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

// « 4,35 » → 4.35 m ; « 435 cm » → 4.35 ; « 4350 mm » → 4.35. Vide → 0. Illisible → null.
function lireMesure(texte) {
  const t = String(texte || '').trim().toLowerCase()
    .replace(/millim[eè]tres?/g, 'mm').replace(/centim[eè]tres?/g, 'cm').replace(/m[eè]tres?/g, 'm')
    .replace(/virgule/g, ',').replace(/\s/g, '').replace(',', '.');
  if (!t) return 0;
  // « 12 m 50 » ou « 12m5 » (dictée ou saisie rapide) → 12,50 m.
  const mm = t.match(/^(\d+)m(\d{1,3})$/);
  if (mm) return Number(mm[1]) + Number(mm[2]) / 10 ** mm[2].length;
  const m = t.match(/^(\d+(?:\.\d+)?)(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'mm' ? n / 1000 : m[2] === 'cm' ? n / 100 : n;
}

// Échelle (mètres par pixel de la photo), horizontale et verticale, d'après les cotes mesurées sur place.
// ---------- Redressement de la perspective (photo prise de biais) ----------
// Les 4 coins du mur trouvés par Claude + la largeur et la ou les hauteurs mesurées donnent une homographie :
// chaque point de la photo est replacé à sa vraie position sur le mur, en mètres.
function homographie(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Élimination de Gauss avec pivot partiel.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
const appliquerH = (h, p) => {
  const w = h[6] * p.x + h[7] * p.y + 1;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
};
// Point de la photo → mètres sur le mur (perspective redressée, ou simple échelle).
const versM = (p, s) => (s.H ? appliquerH(s.H, p) : { x: p.x * s.sx, y: p.y * s.sy });
// L'inverse : un point du mur (en mètres) → sa place sur la photo (pour y dessiner la zone de travaux).
function versPx(m, s) {
  if (!s.H) return { x: m.x / s.sx, y: m.y / s.sy };
  const [a, b, c, d, e, f, g, h] = s.H;
  // Inverse de la matrice 3 × 3 [[a b c] [d e f] [g h 1]] (comatrice).
  const A = e - f * h, B = c * h - b, C = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  const w = G * m.x + Hh * m.y + I;
  return { x: (A * m.x + B * m.y + C) / w, y: (D * m.x + E * m.y + F) / w };
}

function echellePerspective() {
  const rep = R.analyse?.repere;
  if (!rep?.coins) return null;
  const cote = (l) => R.elements.find((e) => e.type === 'cote' && e.lettre && e.lettre === String(l || '').toUpperCase());
  const L = cote(rep.cote_largeur)?.valeur, hg = cote(rep.cote_hauteur_gauche)?.valeur;
  if (!(L > 0 && hg > 0)) return null;
  const hdMesuree = cote(rep.cote_hauteur_droite)?.valeur;
  const hd = hdMesuree > 0 ? hdMesuree : hg;
  // Repère du mur : x vers la droite, y vers le bas (comme la photo), pied du mur à y = 0.
  const H = homographie(rep.coins, [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: -hd }, { x: 0, y: -hg }]);
  if (!H || !H.every(Number.isFinite)) return null;
  const s = { H, perspective: true, hauteurDroiteSupposee: !(hdMesuree > 0), sx: L / Math.max(1, Math.hypot(rep.coins[1].x - rep.coins[0].x, rep.coins[1].y - rep.coins[0].y)) };
  s.sy = s.sx;
  // Contrôle : les autres cotes mesurées, comparées à la photo redressée.
  const autres = R.elements.filter((e) => e.type === 'cote' && e.valeur > 0 && ![rep.cote_largeur, rep.cote_hauteur_gauche, rep.cote_hauteur_droite].includes(e.lettre));
  s.refs = R.elements.filter((e) => e.type === 'cote' && e.valeur > 0).length;
  s.ecart = autres.reduce((m, e) => Math.max(m, Math.abs(longueurM(e.a, e.b, s) - e.valeur) / e.valeur), 0);
  s.controles = autres.length;
  return s;
}

function echelleReleve() {
  if (R.mode === 'saisie') return R.echelleFixe;
  const persp = echellePerspective();
  if (persp) return persp;
  const refs = R.elements.filter((e) => e.type === 'cote' && e.valeur > 0)
    .map((e) => ({ dx: e.b.x - e.a.x, dy: e.b.y - e.a.y, L: e.valeur }))
    .filter((r) => Math.hypot(r.dx, r.dy) > 2);
  if (!refs.length) return null;
  const iso = refs.reduce((s, r) => s + r.L / Math.hypot(r.dx, r.dy), 0) / refs.length;
  let sx = iso, sy = iso, deuxSens = false;
  if (refs.length >= 2) {
    // Moindres carrés sur sx² et sy² : L² = sx²·dx² + sy²·dy² pour chaque cote mesurée.
    let a = 0, b = 0, c = 0, p = 0, q = 0;
    for (const r of refs) {
      const X = r.dx * r.dx, Y = r.dy * r.dy, L2 = r.L * r.L;
      a += X * X; b += X * Y; c += Y * Y; p += L2 * X; q += L2 * Y;
    }
    const det = a * c - b * b;
    if (a > 0 && c > 0 && det / (a * c) > 0.1) {
      const u = (p * c - b * q) / det, v = (a * q - b * p) / det;
      if (u > 0 && v > 0 && Math.sqrt(u / v) < 2.5 && Math.sqrt(v / u) < 2.5) { sx = Math.sqrt(u); sy = Math.sqrt(v); deuxSens = true; }
    }
  }
  let ecart = 0;
  for (const r of refs) ecart = Math.max(ecart, Math.abs(Math.hypot(r.dx * sx, r.dy * sy) - r.L) / r.L);
  return { sx, sy, refs: refs.length, ecart, deuxSens };
}

const longueurM = (a, b, s) => { const p = versM(a, s), q = versM(b, s); return Math.hypot(q.x - p.x, q.y - p.y); };
const airePx = (pts) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]; return t + p.x * q.y - q.x * p.y; }, 0)) / 2;
const aireM2 = (pts, s) => airePx(pts.map((p) => versM(p, s)));
const centre = (pts) => ({ x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length });
// Où écrire le nom d'une surface : le point de la surface le plus éloigné des bords, des ouvertures et des cotes
// (le centre tombe souvent dans l'ouverture d'un pignon).
function pointEtiquette(e) {
  const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const segments = [];
  for (const x of R.elements) {
    if (x.type === 'cote') segments.push([x.a, x.b]);
    else x.pts.forEach((p, i) => segments.push([p, x.pts[(i + 1) % x.pts.length]]));
  }
  const autres = R.elements.filter((x) => x !== e && x.type !== 'cote' && airePx(x.pts) < airePx(e.pts));
  let meilleur = centre(e.pts), score = -1;
  for (let i = 1; i < 24; i++) {
    for (let j = 1; j < 24; j++) {
      const p = { x: x0 + (x1 - x0) * i / 24, y: y0 + (y1 - y0) * j / 24 };
      if (!dansPolygone(p, e.pts) || autres.some((x) => dansPolygone(p, x.pts))) continue;
      const d = Math.min(...segments.map(([a, b]) => distanceSegment(p, a, b)));
      if (d > score) { score = d; meilleur = p; }
    }
  }
  return meilleur;
}

const valeurCote = (e, s) => (e.inconnu ? null : e.valeur > 0 ? e.valeur : s ? longueurM(e.a, e.b, s) : null);
const texteValeur = (e, s) => { const v = valeurCote(e, s); return v == null ? '?' : `${e.suppose ? '≈ ' : ''}${fmtM(v)}${e.valeur > 0 ? ' ✓' : ''}`; };
const texteCote = (e, s) => (e.inconnu ? '?' : e.valeur > 0 ? `${fmtM(e.valeur)} ✓` : s ? `${R.mode === 'saisie' ? '' : '≈ '}${fmtM(longueurM(e.a, e.b, s))}` : '? m');
const nomElement = (e) => e.nom || (e.type === 'cote' ? 'Cote' : e.type === 'ouverture' ? 'Ouverture' : 'Surface');

// Ouverture modifiée par le projet (ex. bardage descendu plus bas) : après travaux, il ne reste qu'un rectangle de
// même largeur, posé au sol, de la nouvelle hauteur. Le bardage gagne la différence.
function etenduePied(e, s) {
  const m = e.pts.map((p) => versM(p, s));
  const xs = m.map((p) => p.x), ys = m.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), sol: Math.max(...ys) };
}
// ---------- Zone de travaux : une partie du mur seulement ----------
// Le bâtiment entier reste dessiné ; seules les surfaces dans la zone comptent dans le métré et les quantités.
// Les distances se prennent au pied du mur depuis le coin (gauche ou droit), les hauteurs depuis le sol.
const zoneVide = () => ({ actif: false, depuis: 'gauche', de: 0, a: 0, bas: 0, haut: 0 });
function rectZone(s) {
  const z = R.zone;
  if (!z?.actif || !s) return null;
  const pts = R.elements.filter((e) => e.type === 'surface').flatMap((e) => e.pts.map((p) => versM(p, s)));
  if (!pts.length) return null;
  const X0 = Math.min(...pts.map((p) => p.x)), X1 = Math.max(...pts.map((p) => p.x));
  const sol = Math.max(...pts.map((p) => p.y)), sommet = Math.min(...pts.map((p) => p.y));
  const L = X1 - X0;
  const de = Math.min(Math.max(Number(z.de) || 0, 0), L), a = Number(z.a) > 0 ? Math.min(Number(z.a), L) : L;
  if (a - de < 0.01) return null;
  const [xa, xb] = z.depuis === 'droite' ? [X1 - a, X1 - de] : [X0 + de, X0 + a];
  const yb = sol - Math.max(Number(z.bas) || 0, 0);
  const ya = Number(z.haut) > 0 ? Math.max(sol - Number(z.haut), sommet) : sommet;
  if (yb - ya < 0.01) return null;
  return { xa, xb, ya, yb, X0, X1, sol, sommet, de, a, entiere: !(Number(z.bas) > 0) && !(Number(z.haut) > 0) };
}
// Découpe d'un polygone (en mètres) par un rectangle (Sutherland-Hodgman, bord par bord).
function couperRect(pts, r) {
  const bords = [[(p) => p.x >= r.xa, (p, q) => ({ x: r.xa, y: p.y + (q.y - p.y) * (r.xa - p.x) / (q.x - p.x) })],
    [(p) => p.x <= r.xb, (p, q) => ({ x: r.xb, y: p.y + (q.y - p.y) * (r.xb - p.x) / (q.x - p.x) })],
    [(p) => p.y >= r.ya, (p, q) => ({ x: p.x + (q.x - p.x) * (r.ya - p.y) / (q.y - p.y), y: r.ya })],
    [(p) => p.y <= r.yb, (p, q) => ({ x: p.x + (q.x - p.x) * (r.yb - p.y) / (q.y - p.y), y: r.yb })]];
  let sortie = pts;
  for (const [dedans, inter] of bords) {
    const entree = sortie;
    sortie = [];
    entree.forEach((q, i) => {
      const p = entree[(i + entree.length - 1) % entree.length];
      if (dedans(q)) { if (!dedans(p)) sortie.push(inter(p, q)); sortie.push(q); } else if (dedans(p)) sortie.push(inter(p, q));
    });
    if (!sortie.length) break;
  }
  return sortie;
}
const SANS_LIMITE = 1e6;
const ptsZone = (e, s, r) => { const m = e.pts.map((p) => versM(p, s)); return r ? couperRect(m, r) : m; };
const aireSurface = (e, s, r = rectZone(s)) => airePx(ptsZone(e, s, r));
// Ouverture : ce qui est retiré (dans la zone) ; avec un projet, seulement la partie sous la nouvelle hauteur.
const aireOuverture = (e, s, r = rectZone(s)) => {
  let m = ptsZone(e, s, r);
  if (e.projetH > 0) { const { sol } = etenduePied(e, s); m = couperRect(m, { xa: -SANS_LIMITE, xb: SANS_LIMITE, ya: sol - e.projetH, yb: SANS_LIMITE }); }
  return airePx(m);
};
const aireOuvertureActuelle = (e, s, r = rectZone(s)) => airePx(ptsZone(e, s, r));
const aireAff = (e, s) => (e.type === 'ouverture' ? aireOuverture(e, s) : aireSurface(e, s));
const texteOuverture = (e, s) => (e.projetH > 0
  ? `− ${fmtNb(aireOuverture(e, s), 2)} m² après travaux (aujourd'hui ${fmtNb(aireOuvertureActuelle(e, s), 2)})`
  : `− ${fmtNb(aireOuverture(e, s), 2)} m²`);
// « de 0,00 à 6,00 m depuis la gauche, jusqu'à 3,00 m de haut · 6,00 × 3,00 m »
function texteZone(r) {
  if (!r) return '';
  const z = R.zone;
  const haut = Number(z.bas) > 0 || Number(z.haut) > 0
    ? `, de ${fmtM(r.sol - r.yb)} à ${fmtM(r.sol - r.ya)} m de haut` : ', toute la hauteur';
  return `de ${fmtM(r.de)} à ${fmtM(r.a)} m depuis le coin ${z.depuis === 'droite' ? 'droit' : 'gauche'}${haut} (${fmtM(r.xb - r.xa)} m de large)`;
}

function metreReleve(s = echelleReleve()) {
  const r = rectZone(s);
  const cotes = R.elements.filter((e) => e.type === 'cote');
  const surfaces = R.elements.filter((e) => e.type === 'surface');
  // Avec une zone, les ouvertures hors zone ne comptent pas.
  const ouvertures = R.elements.filter((e) => e.type === 'ouverture' && (!r || aireOuvertureActuelle(e, s, r) > 0.005));
  const brut = s ? surfaces.reduce((t, e) => t + aireSurface(e, s, r), 0) : 0;
  const deduit = s ? ouvertures.reduce((t, e) => t + aireOuverture(e, s, r), 0) : 0;
  const gain = s ? ouvertures.filter((e) => e.projetH > 0).reduce((t, e) => t + aireOuvertureActuelle(e, s, r) - aireOuverture(e, s, r), 0) : 0;
  const entier = r ? surfaces.reduce((t, e) => t + aireM2(e.pts, s), 0) : 0;
  return { cotes, surfaces, ouvertures, brut, deduit, gain, net: Math.max(0, brut - deduit), toiture: R.mode === 'saisie' ? R.toiture : 0, zone: r, entier };
}

function quantitesReleve(m) {
  const p = { ...Object.fromEntries((OUVRAGES[R.ouvrage] || []).map(([k, , v]) => [k, v])), ...(R.params[R.ouvrage] || {}) };
  const f = 1 + (Number(p.chute) || 0) / 100;
  const lignes = [];
  if (R.ouvrage === 'bac') {
    const t = calepinageBac(p, 'toiture');
    return m.zone ? [['⚠ Zone de travaux', 'pour la toiture, tape seulement la longueur à refaire'], ...t] : t;
  }
  if (R.ouvrage === 'bacmur') return m.brut ? calepinageBac(p, 'facade') : [];
  // Bardage : la surface nette du mur. Couverture et plaques : la surface tapée, sinon la toiture calculée.
  const net = R.ouvrage === 'bardage' || R.ouvrage === 'aucun' ? m.net : Number(p.surface) > 0 ? Number(p.surface) : m.toiture || m.net;
  if (net && R.ouvrage !== 'bardage' && R.ouvrage !== 'aucun') lignes.push(['Surface prise en compte', `${fmtNb(net, 2)} m²`]);
  if (!net) return lignes;
  if (R.ouvrage === 'bardage') {
    const pas = ((Number(p.lame) || 150) + (Number(p.joint) || 0)) / 1000;
    const lisses = (Number(p.lisses) || 60) / 100;
    lignes.push([`Lames de ${p.lame} mm`, `${fmtNb(Math.ceil(net / pas * f))} ml`]);
    lignes.push([`Lisses (entraxe ${p.lisses} cm)`, `${fmtNb(Math.ceil(net / lisses * f))} ml`]);
    lignes.push(['Fixations inox', `≈ ${fmtNb(Math.ceil(net / pas / lisses * (Number(p.fixations) || 2) * f / 10) * 10)}`]);
  } else if (R.ouvrage === 'couverture') {
    lignes.push(['Écran sous-toiture (recouvrements compris)', `${fmtNb(net * 1.1 * f, 1)} m²`]);
    lignes.push([`Liteaux (entraxe ${p.liteaux} cm)`, `${fmtNb(Math.ceil(net / ((Number(p.liteaux) || 32) / 100) * f))} ml`]);
    lignes.push([`Contre-liteaux (chevrons à ${p.chevrons} cm)`, `${fmtNb(Math.ceil(net / ((Number(p.chevrons) || 60) / 100) * f))} ml`]);
    if (Number(p.unites) > 0) lignes.push([`Ardoises ou tuiles (${p.unites} au m²)`, fmtNb(Math.ceil(net * Number(p.unites) * f))]);
  } else if (R.ouvrage === 'plaques') {
    const utile = Math.max(0.01, ((Number(p.largeur) || 93) - (Number(p.recLat) || 0)) / 100) * Math.max(0.01, ((Number(p.longueur) || 150) - (Number(p.recBout) || 0)) / 100);
    lignes.push([`Plaques ${p.largeur} × ${p.longueur} (${fmtNb(utile, 2)} m² utiles)`, fmtNb(Math.ceil(net / utile * f))]);
    lignes.push(['⚠ Amiante probable', 'repérage avant travaux']);
  }
  return lignes;
}

// ---------- Ouverture, photo, brouillon ----------
async function ouvrirReleve(chantier = '') {
  remplirSelectChantiers($('#releve-chantier'), chantier, '— Choisir le chantier —');
  afficher('releve');
  if (R.actif) { if (chantier) $('#releve-chantier').value = chantier; if (R.mode === 'photo') redessinerReleve(); majReleve(false); return; }
  $('#releve-depart').classList.remove('cache');
  $('#releve-travail').classList.add('cache');
  $('#releve-reprendre').classList.add('cache');
  brouillonLire().then((b) => $('#releve-reprendre').classList.toggle('cache', !b));
}

// Photo choisie : en mode saisie, elle est seulement jointe à la feuille ; sinon on mesure dessus.
async function photoReleve(fichier, mode = 'photo') {
  if (!fichier) return;
  try {
    const data = await traiterImage(fichier, false);
    if (mode === 'saisie') {
      R.photo = data;
      R.img = await chargerDataUrl(data);
      majPhotoJointe();
      sauverBrouillonReleve();
      return;
    }
    // Mur suivant (« Ajouter un autre mur ») : même chantier et même ouvrage, nouveau relevé, façade à nommer.
    const suite = R.suiteAutreMur;
    R.suiteAutreMur = null;
    await demarrerReleve(suite ? { ...suite, mode: 'photo', photo: data, elements: [], facade: '' }
      : { mode: 'photo', photo: data, elements: [], chantier: $('#releve-chantier').value, depuisRdv: R.depuisRdv, facade: $('#releve-facade').value });
    nommerFacadeParBoussole();
    envoyerPhotoReleve();
    analyserPhotoReleve();
  } catch (e) { toast(e.message, 'erreur'); }
}

// ---------- Boussole : quelle façade est photographiée ? ----------
// Le téléphone vise la façade : s'il pointe vers le nord, on photographie la façade sud (celle qui regarde le sud).
const boussole = { cap: null, quand: 0, active: false };
function activerBoussole() {
  if (boussole.active) return;
  const ecouter = () => {
    boussole.active = true;
    window.addEventListener('deviceorientation', (e) => {
      const cap = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
      if (cap != null && (e.webkitCompassAccuracy == null || e.webkitCompassAccuracy >= 0)) { boussole.cap = cap; boussole.quand = Date.now(); }
    });
  };
  // iPhone : l'autorisation « Mouvement et orientation » doit être demandée pendant le geste de l'utilisateur.
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') ecouter(); }).catch(() => {});
  } else if ('ondeviceorientation' in window) ecouter();
}
const DIRECTIONS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
function orientationFacade() {
  if (boussole.cap == null || Date.now() - boussole.quand > 10000) return '';
  const exposition = (boussole.cap + 180) % 360;
  return `Façade ${DIRECTIONS[Math.round(exposition / 45) % 8]}`;
}
// Au retour de l'appareil photo, le téléphone vise encore la façade : on lit la boussole une seconde après.
function nommerFacadeParBoussole() {
  setTimeout(() => {
    const nom = orientationFacade();
    const champ = $('#releve-facade');
    if (nom && !champ.value.trim()) { champ.value = nom; sauverBrouillonReleve(); toast(`🧭 ${nom} (d'après la boussole)`, 'ok'); }
  }, 1200);
}

// ---------- Claude regarde la photo et propose les cotes à prendre (A, B, C…) ----------
async function analyserPhotoReleve() {
  if (!R.img) return;
  const aide = $('#releve-aide');
  if (!navigator.onLine || !reglages.ok()) {
    aide.className = 'releve-aide';
    aide.textContent = 'Pas de réseau : Claude ne peut pas regarder la photo. Trace les cotes à la main (outil Cote).';
    return;
  }
  R.analyseEnCours = true;
  aide.className = 'releve-aide analyse';
  aide.textContent = '🔍 Claude regarde ta photo et prépare les cotes à prendre… (10 à 30 secondes)';
  try {
    // Image réduite (1 568 points au plus) : c'est la taille que Claude regarde vraiment.
    const k = Math.min(1, 1568 / Math.max(R.img.width, R.img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(R.img.width * k);
    c.height = Math.round(R.img.height * k);
    c.getContext('2d').drawImage(R.img, 0, 0, c.width, c.height);
    const res = await appelServeur({ action: 'analyserPhoto', image: c.toDataURL('image/jpeg', 0.82).split(',')[1],
      largeur: c.width, hauteur: c.height, indice: $('#releve-chantier').value || '' }, 120000);
    R.analyseEnCours = false;
    appliquerAnalyse(res.analyse, 1 / k);
  } catch (e) {
    aide.className = 'releve-aide';
    aide.textContent = `Analyse impossible (${e.message}). Tu peux tracer les cotes à la main avec l'outil Cote.`;
  } finally {
    R.analyseEnCours = false;
  }
}

function appliquerAnalyse(a, f = 1) {
  const P = (p) => ({ x: Math.round(p.x * f), y: Math.round(p.y * f) });
  sauverHistorique();
  const els = [];
  const nomForme = { pignon: 'Pignon', appentis: 'Appentis', mur: 'Mur', 'pan de toit': 'Pan de toit' }[a.forme] || 'Surface';
  if (a.contour?.length >= 3) els.push({ type: 'surface', nom: nomForme, pts: a.contour.map(P) });
  for (const o of a.ouvertures || []) if (o.contour?.length >= 3) els.push({ type: 'ouverture', nom: o.nom, pts: o.contour.map(P) });
  for (const c of a.cotes || []) {
    els.push({ type: 'cote', lettre: String(c.lettre).toUpperCase().slice(0, 2), nom: c.nom, consigne: c.consigne, sens: c.sens,
      a: P(c.a), b: P(c.b), valeur: 0, court: true });
  }
  R.elements = els;
  const r = a.repere;
  R.analyse = { forme: a.forme, description: a.description, remarques: a.remarques,
    repere: r && r.bas_gauche ? { coins: [r.bas_gauche, r.bas_droit, r.haut_droit, r.haut_gauche].map(P),
      cote_largeur: String(r.cote_largeur || '').toUpperCase(), cote_hauteur_gauche: String(r.cote_hauteur_gauche || '').toUpperCase(),
      cote_hauteur_droite: String(r.cote_hauteur_droite || '').toUpperCase() } : null };
  choisirOutilReleve('modifier');
  redessinerReleve();
  dessinerPanneauCotes();
  majReleve();
  setTimeout(() => $('#releve-cotes-liste input')?.focus(), 400);
}

// Liste A, B, C… : on touche une case, puis on vise au laser (mode clavier) ou on tape ; « Entrée » passe à la suivante.
function dessinerPanneauCotes() {
  const cotes = R.elements.filter((e) => e.type === 'cote' && e.lettre);
  $('#releve-cotes').classList.toggle('cache', !cotes.length);
  // Pendant la prise des mesures, la photo reste fixée en haut de l'écran.
  $('#ecran-releve').classList.toggle('saisie-cotes', cotes.length > 0);
  if (!cotes.length) return;
  $('#releve-cotes-analyse').textContent = [R.analyse?.description, R.analyse?.remarques].filter(Boolean).join(' ');
  $('#releve-cotes-liste').replaceChildren(...cotes.map((e, i) => {
    const input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: i < cotes.length - 1 ? 'next' : 'done',
      value: e.valeur ? String(e.valeur).replace('.', ',') : '', 'aria-label': `Mesure ${e.lettre}` });
    let minuteur = null;
    input.oninput = () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => {
        const v = lireMesure(input.value);
        e.valeur = v && v > 0 ? v : 0;
        input.classList.toggle('erreur', v === null);
        redessinerReleve();
        majReleve();
      }, 150);
    };
    input.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== 'Tab') return;
      ev.preventDefault();
      input.oninput();
      const suivants = $$('#releve-cotes-liste input');
      const suivant = suivants[suivants.indexOf(input) + 1];
      if (suivant) suivant.focus(); else input.blur();
    };
    input.onfocus = () => { R.coteVisee = e; redessinerReleve(); };
    return el('div', { class: 'cote-ligne' },
      el('span', { class: 'lettre' }, e.lettre),
      el('div', { class: 'cote-texte' }, el('strong', {}, e.nom), el('small', {}, e.consigne || '')),
      el('div', { class: 'cote-saisie' }, input, el('small', { class: 'calcul' }, '')));
  }));
}

function majPanneauCotes(s) {
  const cotes = R.elements.filter((e) => e.type === 'cote' && e.lettre);
  $$('#releve-cotes-liste .cote-ligne').forEach((ligne, i) => {
    const e = cotes[i];
    if (!e) return;
    const petit = ligne.querySelector('.calcul');
    petit.textContent = !e.valeur && s ? `≈ ${fmtM(longueurM(e.a, e.b, s))} d'après la photo` : '';
    ligne.classList.toggle('remplie', e.valeur > 0);
  });
}

// Dictée : « A douze trente, B deux quinze… ». Les formes simples sont lues sur le téléphone, le reste par Claude.
function lireDicteeLocale(texte, lettres) {
  const t = ` ${String(texte).toLowerCase().replace(/virgule/g, ',').replace(/(\d)\s*,\s*(\d)/g, '$1,$2').replace(/m[eè]tres?/g, ' m ')} `;
  const trouve = {};
  const re = /[\s,;.:]([a-h])\s*[:=]?\s*(\d+)(?:[.,](\d+)|\s*m\s*(\d{1,2})(?!\d))?/g;
  let m;
  while ((m = re.exec(t))) {
    const lettre = m[1].toUpperCase();
    if (!lettres.includes(lettre)) continue;
    let v = null;
    if (m[3]) v = Number(`${m[2]}.${m[3]}`);
    else if (m[4]) v = Number(m[2]) + Number(m[4].padEnd(2, '0')) / 100;
    if (v != null && v > 0 && v < 200) trouve[lettre] = v;
  }
  return trouve;
}

async function lireDictee() {
  const texte = $('#releve-dictee').value.trim();
  if (!texte) { toast('Dicte d\'abord tes mesures.', 'erreur'); return; }
  const cotes = R.elements.filter((e) => e.type === 'cote' && e.lettre);
  const lettres = cotes.map((e) => e.lettre);
  let trouve = lireDicteeLocale(texte, lettres);
  let doute = '';
  if (Object.keys(trouve).length < lettres.length && navigator.onLine && reglages.ok()) {
    $('#releve-lire').textContent = 'Lecture…';
    try {
      const r = await appelServeur({ action: 'lireMesures', texte, cotes: cotes.map((e) => ({ lettre: e.lettre, nom: e.nom })) }, 60000);
      trouve = {};
      for (const x of r.mesures || []) if (lettres.includes(String(x.lettre).toUpperCase()) && x.metres > 0) trouve[String(x.lettre).toUpperCase()] = x.metres;
      doute = r.doute || '';
    } catch (e) { toast(`Lecture par Claude impossible : ${e.message}`, 'erreur'); }
    $('#releve-lire').textContent = 'Lire la dictée';
  }
  if (!Object.keys(trouve).length) { toast('Je n\'ai trouvé aucune mesure dans la dictée.', 'erreur'); return; }
  sauverHistorique();
  for (const e of cotes) if (trouve[e.lettre]) e.valeur = trouve[e.lettre];
  dessinerPanneauCotes();
  redessinerReleve();
  majReleve();
  toast(`${Object.keys(trouve).length} mesure(s) lue(s) ✅${doute ? ` · ${doute}` : ''}`, 'ok');
}

// ---------- Dictée intelligente (1.19) ----------
// Jean-Phi dicte tout d'un coup : ses mesures ET ce que veut le client. Claude comprend et propose les réglages
// (mesures, ouvrage, couleur, plaques éclairantes, ouverture réduite, partie à faire, travaux en plus, questions à poser).
// Rien n'est appliqué sans lui : chaque proposition est une case cochée qu'il peut décocher.
const FORMES_ANALYSE = { pignon: 'pignon', appentis: 'appentis', mur: 'mur', 'pan de toit': 'pan' };
const formeReleve = () => (R.mode === 'saisie' ? R.gabarit.type : FORMES_ANALYSE[R.analyse?.forme] || 'mur');

// Les « cotes » que la dictée peut remplir : les lettres A, B… sur photo, les cases de la forme en saisie.
function cotesDictables() {
  if (R.mode === 'saisie') {
    return GABARITS[R.gabarit.type].map(([cle, nom]) => ({ lettre: cle, nom: estPente(cle) ? `${nom} (en degrés)` : nom, valeur: R.gabarit.saisis[cle] || '' }));
  }
  return R.elements.filter((e) => e.type === 'cote' && e.lettre).map((e) => ({ lettre: e.lettre, nom: e.nom, valeur: e.valeur > 0 ? e.valeur : '' }));
}

function ouverturesDictables() {
  if (R.mode === 'saisie') return R.gabarit.ouvertures.map((ov, i) => ({ nom: ov.nom || `Ouverture ${i + 1}`, ref: i }));
  return R.elements.filter((e) => e.type === 'ouverture').map((e) => ({ nom: nomElement(e), ref: R.elements.indexOf(e) }));
}

async function comprendreDictee() {
  const texte = $('#releve-dictee').value.trim();
  if (!texte) { toast('Dicte ou écris d\'abord ce que tu veux.', 'erreur'); $('#releve-dictee').focus(); return; }
  if (!navigator.onLine || !reglages.ok()) {
    if (R.mode === 'photo') { lireDictee(); return; }
    toast('Pas de réseau : Claude ne peut pas lire la dictée. Tape tes mesures dans les cases.', 'erreur'); return;
  }
  const bouton = $('#releve-lire');
  bouton.disabled = true; bouton.textContent = '✨ Claude réfléchit…';
  const cotes = cotesDictables();
  const ouvertures = ouverturesDictables();
  try {
    const r = await appelServeur({ action: 'comprendreDictee', texte, cotes, ouvertures: ouvertures.map((o) => o.nom),
      forme: NOMS_GABARITS[formeReleve()] || 'mur', description: R.analyse?.description || '', ouvrageActuel: R.ouvrage,
      ouvrages: NOMS_OUVRAGES, couleurActuelle: R.params[R.ouvrage]?.couleur || '', metre: texteMetre() }, 90000);
    afficherPropositions(r.comprehension || r, cotes, ouvertures);
  } catch (e) {
    // Serveur pas encore à jour (ou Claude indisponible) : on lit au moins les mesures.
    console.warn('comprendreDictee', e);
    if (R.mode === 'photo') { toast('Lecture simple des mesures (Claude indisponible pour le reste).'); await lireDictee(); }
    else toast(`Claude indisponible : ${e.message}`, 'erreur');
  } finally { bouton.disabled = false; bouton.textContent = '✨ Comprendre'; }
}

function afficherPropositions(c, cotes, ouvertures) {
  const zone = $('#releve-propositions');
  const props = []; // { texte, appliquer }
  const fmt = (v) => fmtNb(v, 2);
  for (const m of c.mesures || []) {
    const cote = cotes.find((x) => x.lettre.toLowerCase() === String(m.lettre).toLowerCase());
    const v = Number(m.valeur);
    if (!cote || !(v > 0)) continue;
    const pente = R.mode === 'saisie' && estPente(cote.lettre);
    const actuelle = lireMesure(String(cote.valeur)) || Number(cote.valeur) || 0;
    if (!pente && Math.abs(actuelle - v) < 0.005) continue;
    props.push({ texte: `${R.mode === 'photo' ? `${cote.lettre} · ` : ''}${cote.nom.replace(' (en degrés)', '')} : ${pente ? `${fmtNb(v, 1)}°` : `${fmt(v)} m`}${actuelle ? ` (au lieu de ${fmt(actuelle)})` : ''}`,
      appliquer: () => {
        if (R.mode === 'saisie') R.gabarit.saisis[cote.lettre] = pente ? `${String(v).replace('.', ',')}°` : String(v).replace('.', ',');
        else { const e = R.elements.find((x) => x.type === 'cote' && x.lettre === cote.lettre); if (e) e.valeur = v; }
      } });
  }
  if (c.ouvrage && OUVRAGES[c.ouvrage] && c.ouvrage !== R.ouvrage) {
    props.push({ texte: `Ouvrage : ${NOMS_OUVRAGES[c.ouvrage]}`, appliquer: () => { R.ouvrage = c.ouvrage; $('#releve-ouvrage').value = c.ouvrage; } });
  }
  if (c.couleur) {
    props.push({ texte: `Couleur : ${c.couleur}`, appliquer: () => {
      const o = R.ouvrage; if ((OUVRAGES[o] || []).some(([k]) => k === 'couleur')) R.params[o] = { ...(R.params[o] || {}), couleur: c.couleur };
    } });
  }
  if (Number.isInteger(c.eclairantes) && c.eclairantes >= 0) {
    props.push({ texte: `Plaques éclairantes : ${c.eclairantes}`, appliquer: () => {
      const o = R.ouvrage; if ((OUVRAGES[o] || []).some(([k]) => k === 'eclairantes')) R.params[o] = { ...(R.params[o] || {}), eclairantes: c.eclairantes };
    } });
  }
  for (const ov of c.ouvertures || []) {
    const cible = ouvertures.find((o) => o.nom.toLowerCase() === String(ov.nom).toLowerCase()) || (ouvertures.length === 1 ? ouvertures[0] : null);
    const h = Number(ov.hauteurApresTravaux);
    if (!cible || !(h > 0)) continue;
    props.push({ texte: `${cible.nom} : bardage jusqu'à ${fmt(h)} m du sol après travaux${ov.raison ? ` (${ov.raison})` : ''}`, appliquer: () => {
      if (R.mode === 'saisie') R.gabarit.ouvertures[cible.ref].p = String(h).replace('.', ',');
      else if (R.elements[cible.ref]) R.elements[cible.ref].projetH = h;
    } });
  }
  const z = c.zone;
  if (z?.active && (z.a > 0 || z.haut > 0 || z.de > 0 || z.bas > 0)) {
    const morceaux = [z.de >= 0 || z.a > 0 ? `de ${fmt(Math.max(z.de, 0))} à ${z.a > 0 ? `${fmt(z.a)} m` : 'la fin'} depuis le coin ${z.depuis === 'droite' ? 'droit' : 'gauche'}` : '',
      z.bas > 0 || z.haut > 0 ? `hauteur ${fmt(Math.max(z.bas, 0))} → ${z.haut > 0 ? `${fmt(z.haut)} m` : 'en haut'}` : ''].filter(Boolean);
    props.push({ texte: `Seulement une partie : ${morceaux.join(', ')}`, appliquer: () => {
      R.zone = { ...zoneVide(), actif: true, depuis: z.depuis === 'droite' ? 'droite' : 'gauche',
        de: z.de > 0 ? z.de : 0, a: z.a > 0 ? z.a : 0, bas: z.bas > 0 ? z.bas : 0, haut: z.haut > 0 ? z.haut : 0 };
      $('#zone-actif').checked = true; $('#zone-champs').classList.remove('cache');
    } });
  }
  for (const t of c.travaux || []) {
    if (!t.libelle) continue;
    const q = Number(t.quantite) > 0 ? `${fmtNb(Number(t.quantite), 2)} ${t.unite || ''}`.trim() : (t.unite ? `? ${t.unite}` : '');
    props.push({ texte: `Travaux : ${t.libelle}${q ? ` — ${q}` : ''}`, appliquer: () => {
      R.travaux = [...(R.travaux || []).filter((x) => x.libelle !== t.libelle), { libelle: t.libelle, quantite: Number(t.quantite) || 0, unite: t.unite || '' }];
    } });
  }

  const cases = props.map((p) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = true;
    return { p, cb, li: el('label', { class: 'proposition' }, cb, el('span', {}, p.texte)) };
  });
  const blocs = [];
  if (c.compris) blocs.push(el('p', { class: 'compris' }, el('b', {}, '🧠 J\'ai compris : '), c.compris));
  if (cases.length) {
    blocs.push(el('p', { class: 'etiquette' }, 'Je te propose (décoche ce qui ne va pas) :'), ...cases.map((x) => x.li));
    const appliquer = el('button', { class: 'btn principal', type: 'button' }, `✓ Appliquer (${cases.length})`);
    appliquer.onclick = () => {
      sauverHistorique();
      let n = 0;
      for (const x of cases) if (x.cb.checked) { x.p.appliquer(); n++; }
      R.compris = c.compris || R.compris || '';
      apresDictee();
      zone.replaceChildren(el('p', { class: 'compris ok' }, `✅ ${n} réglage${n > 1 ? 's' : ''} appliqué${n > 1 ? 's' : ''}. Tout est repris sur la feuille et dans le rendez-vous.`),
        ...(c.questions || []).length ? [el('p', { class: 'etiquette' }, '❓ À demander au client :'), ...c.questions.map((q) => el('p', { class: 'question' }, `• ${q}`))] : []);
      toast(`${n} réglage${n > 1 ? 's' : ''} appliqué${n > 1 ? 's' : ''} ✅`, 'ok');
    };
    blocs.push(appliquer);
  } else blocs.push(el('p', { class: 'discret' }, 'Rien à changer : tout ce que tu as dit est déjà dans le relevé. Ton texte est gardé comme note.'));
  if ((c.questions || []).length) blocs.push(el('p', { class: 'etiquette' }, '❓ À demander au client :'), ...c.questions.map((q) => el('p', { class: 'question' }, `• ${q}`)));
  if (!cases.length) { R.compris = c.compris || R.compris || ''; sauverBrouillonReleve(); }
  zone.replaceChildren(...blocs);
  zone.classList.remove('cache');
  zone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function apresDictee() {
  $('#releve-ouvrage').value = R.ouvrage;
  dessinerParamsReleve();
  remplirCarteZone();
  if (R.mode === 'saisie') { dessinerChampsSaisie(); dessinerOuvertures(); }
  else { dessinerPanneauCotes(); redessinerReleve(); }
  majReleve();
  sauverBrouillonReleve();
}

let reconnaissance = null;
function dicterMesures() {
  const zone = $('#releve-dictee'), bouton = $('#releve-micro');
  if (reconnaissance) { reconnaissance.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { zone.focus(); toast('Touche le micro 🎤 du clavier pour dicter.'); return; }
  try {
    const r = new SR();
    r.lang = 'fr-FR';
    r.interimResults = true;
    r.continuous = true;
    const debut = zone.value ? `${zone.value} ` : '';
    r.onresult = (ev) => { zone.value = debut + [...ev.results].map((x) => x[0].transcript).join(' '); };
    r.onerror = () => { zone.focus(); };
    r.onend = () => { reconnaissance = null; bouton.textContent = '🎤 Dicter'; if (zone.value.trim()) comprendreDictee(); };
    r.start();
    reconnaissance = r;
    bouton.textContent = '⏹ J\'ai fini';
  } catch { zone.focus(); toast('Touche le micro 🎤 du clavier pour dicter.'); }
}

// Pignon trouvé par Claude : égouts, faîtage, rampants et pentes se déduisent du contour une fois l'échelle connue.
function lineairesDepuisContour(s) {
  const surf = R.elements.find((e) => e.type === 'surface');
  if (!s || !surf || R.analyse?.forme !== 'pignon' || surf.pts.length !== 5) return [];
  const [p0, p1, p2, p3, p4] = surf.pts;
  const pente = (a, b) => { const m = versM(a, s), n = versM(b, s); return Math.atan2(Math.abs(m.y - n.y), Math.abs(m.x - n.x)); };
  const sol = (versM(p0, s).y + versM(p4, s).y) / 2;
  return [
    ['Égout gauche', `${fmtM(longueurM(p0, p1, s))} m`],
    ['Égout droit', `${fmtM(longueurM(p4, p3, s))} m`],
    ['Faîtage (hauteur)', `${fmtM(sol - versM(p2, s).y)} m`],
    ['Rampant gauche', `${fmtM(longueurM(p1, p2, s))} m`],
    ['Rampant droit', `${fmtM(longueurM(p2, p3, s))} m`],
    ['Pente gauche', afficherChamp('p', pente(p1, p2))],
    ['Pente droite', afficherChamp('p', pente(p2, p3))],
  ];
}

async function demarrerReleve(b) {
  R.mode = b.mode || 'photo';
  R.actif = true;
  R.photo = b.photo || '';
  R.img = R.photo ? await chargerDataUrl(R.photo) : null;
  R.elements = b.elements || [];
  R.historique = [];
  R.enCours = null;
  R.echelleFixe = null;
  R.incomplet = [];
  R.alertes = [];
  R.lineaires = [];
  R.toiture = 0;
  if (b.ouvrage) R.ouvrage = b.ouvrage;
  if (b.params) R.params = b.params;
  if (b.gabarit) R.gabarit = b.gabarit;
  R.analyse = b.analyse || null;
  R.coteVisee = null;
  R.photoEnvoyee = !!b.photoEnvoyee;
  R.depuisRdv = !!b.depuisRdv;
  R.id = b.id || nouvelId();
  R.zone = { ...zoneVide(), ...(b.zone || {}) };
  remplirCarteZone();
  $('#releve-facade').value = b.facade || '';
  $('#releve-dictee').value = b.dictee || '';
  R.compris = b.compris || '';
  R.travaux = Array.isArray(b.travaux) ? b.travaux : [];
  $('#releve-propositions').classList.add('cache');
  if (R.mode === 'photo') {
    const c = $('#releve-canvas');
    c.width = R.img.width;
    c.height = R.img.height;
  }
  if (b.chantier) remplirSelectChantiers($('#releve-chantier'), b.chantier, '— Choisir le chantier —');
  $('#releve-depart').classList.add('cache');
  $('#releve-travail').classList.remove('cache');
  $('#releve-zone-photo').classList.toggle('cache', R.mode !== 'photo');
  $('#releve-zone-saisie').classList.toggle('cache', R.mode !== 'saisie');
  $('#releve-titre').textContent = R.mode === 'saisie' ? 'Relevé' : 'Relevé sur photo';
  $('#releve-ouvrage').value = R.ouvrage;
  dessinerParamsReleve();
  if (R.mode === 'saisie') {
    choisirGabarit(R.gabarit.type, false);
    majPhotoJointe();
  } else {
    choisirOutilReleve(R.elements.length ? R.outil : 'cote');
    dessinerPanneauCotes();
    redessinerReleve();
  }
  majReleve(false);
}

// Le relevé en cours est gardé (chiffré) dans la base de l'iPhone, assez grande pour la photo : si l'iPhone
// ferme l'appli pendant qu'on mesure, rien n'est perdu et le relevé se rouvre tout seul.
const CLE_BROUILLON = 'releve-brouillon';
async function brouillonLire() {
  try {
    const enreg = await cleLire(CLE_BROUILLON);
    if (enreg) return JSON.parse(await dechiffrer(enreg));
  } catch (e) { console.warn('Brouillon illisible', e); }
  // Ancienne place (1.9 et 1.10) : localStorage.
  try { const v = lire(CLE_BROUILLON); if (v) return JSON.parse(await dechiffrer(JSON.parse(v))); } catch { /* rien */ }
  return null;
}
function brouillonEffacer() {
  try { localStorage.removeItem(CLE_BROUILLON); } catch { /* rien */ }
  return fileAction('readwrite', (s) => s.delete(CLE_BROUILLON), MAGASIN_CLES).catch(() => {});
}
// Tout le relevé (de quoi le rouvrir tel quel) : gardé dans l'iPhone pendant le travail, et dans le dossier du chantier
// quand on range la feuille, pour le retravailler sur le PC.
const etatReleve = () => ({ id: R.id, mode: R.mode, photo: R.photo, elements: R.mode === 'photo' ? R.elements : [], gabarit: R.gabarit,
  analyse: R.analyse, chantier: $('#releve-chantier').value, ouvrage: R.ouvrage, params: R.params, date: Date.now(),
  photoEnvoyee: !!R.photoEnvoyee, depuisRdv: !!R.depuisRdv, facade: $('#releve-facade').value, zone: R.zone,
  dictee: $('#releve-dictee').value, compris: R.compris || '', travaux: R.travaux || [] });

async function sauverBrouillonMaintenant() {
  clearTimeout(R.minuteur);
  if (!R.actif || !securite.cleDonnees) return;
  try {
    await cleEcrire(CLE_BROUILLON, await chiffrer(JSON.stringify(etatReleve())));
    try { localStorage.removeItem(CLE_BROUILLON); } catch { /* rien */ }
  } catch (e) { console.warn('Brouillon du relevé non gardé', e); }
}
function sauverBrouillonReleve() {
  clearTimeout(R.minuteur);
  R.minuteur = setTimeout(sauverBrouillonMaintenant, 400);
}

async function reprendreReleve(b = null) {
  b = b || await brouillonLire();
  if (!b) { toast('Aucun relevé en cours.', 'erreur'); $('#releve-reprendre').classList.add('cache'); return; }
  try { await demarrerReleve(b); } catch (e) {
    console.warn(e);
    toast('Relevé en cours illisible.', 'erreur');
    brouillonEffacer();
    $('#releve-reprendre').classList.add('cache');
  }
}

// Au démarrage, l'appli s'ouvre toujours sur l'accueil (demande de Jean-Phi du 09/11) : un relevé ou un rendez-vous
// en cours se reprend par son bouton en tête de l'accueil. Seule exception, sur l'iPhone : s'il a été touché il y a
// moins de 10 minutes, c'est qu'on est en plein rendez-vous (l'iPhone a fermé l'appli pendant une photo ou une
// discussion avec le client), et on y revient directement.
const REPRISE_AUTO_MS = 10 * 60000;
async function rouvrirReleveRecent() {
  const b = await brouillonLire();
  const rdv = lireJson('rdv-en-cours', null);
  if (rdv?.actif) Object.assign(V, rdv);
  if (!surIos()) return;
  if (b && Date.now() - (b.date || 0) < REPRISE_AUTO_MS) { await ouvrirReleveEnCours(b); return; }
  if (rdv?.actif && Date.now() - (rdv.maj || rdv.debut) < REPRISE_AUTO_MS) { ouvrirRdv(); toast('Ton rendez-vous en cours a été retrouvé ✅', 'ok'); }
}

async function ouvrirReleveEnCours(b = null) {
  b = b || await brouillonLire();
  if (!b) { toast('Aucun relevé en cours.', 'erreur'); majBoutonReleve(); return; }
  remplirSelectChantiers($('#releve-chantier'), b.chantier || '', '— Choisir le chantier —');
  afficher('releve');
  await reprendreReleve(b);
  toast('Ton relevé en cours a été retrouvé ✅', 'ok');
}

// Accueil : un relevé commencé (brouillon gardé) se reprend par ce bouton.
async function majBoutonReleve() {
  const bouton = $('#btn-releve-encours');
  const b = await brouillonLire().catch(() => null);
  bouton.classList.toggle('cache', !b);
  if (!b) return;
  const quand = new Date(b.date || Date.now());
  const jour = quand.toDateString() === new Date().toDateString() ? '' : `le ${quand.toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' })} `;
  bouton.querySelector('.sous-titre').textContent = [b.chantier || 'Chantier à choisir', b.facade || '',
    `modifié ${jour}à ${quand.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`].filter(Boolean).join(' · ');
}

function nouveauReleve() {
  const enCours = R.elements.length || Object.values(R.gabarit.saisis).some(Boolean);
  if (R.actif && enCours && !confirm('Commencer un nouveau relevé ? Celui en cours sera effacé.')) return;
  R.actif = false;
  R.photo = '';
  R.img = null;
  R.elements = [];
  R.gabarit = { type: 'pignon', saisis: {}, ouvertures: [] };
  R.zone = zoneVide();
  R.analyse = null;
  R.travaux = [];
  R.compris = '';
  $('#releve-facade').value = '';
  $('#releve-dictee').value = '';
  $('#releve-propositions').classList.add('cache');
  brouillonEffacer();
  ouvrirReleve($('#releve-chantier').value);
}

// ---------- Saisie des mesures : la forme est proposée, l'appli calcule ce qui manque ----------
const GABARITS = {
  pignon: [['L', 'Largeur'], ['hG', 'Égout gauche (hauteur)'], ['hD', 'Égout droit (hauteur)'], ['hF', 'Faîtage (hauteur)'],
    ['rG', 'Rampant gauche'], ['rD', 'Rampant droit'], ['pG', 'Pente gauche (° ou %)'], ['pD', 'Pente droite (° ou %)'],
    ['xF', 'Faîtage depuis la gauche'], ['long', 'Longueur du bâtiment'], ['debord', 'Débord de toit (le long de la pente)']],
  appentis: [['L', 'Largeur'], ['hB', 'Hauteur côté bas'], ['hH', 'Hauteur côté haut'], ['r', 'Rampant'], ['p', 'Pente (° ou %)'],
    ['long', 'Longueur du bâtiment'], ['debord', 'Débord de toit (le long de la pente)']],
  mur: [['L', 'Longueur'], ['H', 'Hauteur']],
  pan: [['r', 'Rampant (égout → faîtage)'], ['long', 'Longueur du pan'], ['p', 'Pente (° ou %)'], ['portee', 'Portée horizontale']],
  // Forme à créer : largeur au sol, hauteurs aux deux coins, puis les points du haut (g.points).
  libre: [['L', 'Largeur au sol'], ['hG', 'Hauteur au coin gauche'], ['hD', 'Hauteur au coin droit'], ['long', 'Longueur du bâtiment (facultatif)']],
};
const NOMS_GABARITS = { pignon: 'Pignon', appentis: 'Appentis', mur: 'Mur', pan: 'Pan de toit', libre: 'Forme libre' };

// Points du haut d'une forme libre, en mètres, triés de gauche à droite (ordre de saisie gardé à x égal).
function pointsLibres(g) {
  return (g.points || []).map((p, i) => ({ i, x: lireMesure(p.x), h: lireMesure(p.h) }))
    .filter((p) => p.x != null && p.x >= 0 && p.h != null && p.h > 0)
    .sort((a, b) => a.x - b.x || a.i - b.i);
}
const estPente = (cle) => /^p[GD]?$/.test(cle);
const RAD_DEG = 180 / Math.PI;

function lireChamp(cle, texte) {
  if (!estPente(cle)) { const v = lireMesure(texte); return v > 0 ? v : null; }
  const t = String(texte || '').replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t.replace(/[%°]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return t.endsWith('%') ? Math.atan(n / 100) : n / RAD_DEG;
}
const afficherChamp = (cle, v) => (estPente(cle) ? `${fmtNb(v * RAD_DEG, 1)}° (${fmtNb(Math.tan(v) * 100, 0)} %)` : `${fmtM(v)} m`);

// Un versant : égout e, faîtage f, avancée horizontale x, rampant r, pente p. Deux valeurs suffisent pour les autres.
function resoudrePan(s) {
  const k = (v) => v != null && Number.isFinite(v);
  for (let n = 0; n < 8; n++) {
    let change = false;
    const poser = (c, v) => { if (!k(s[c]) && Number.isFinite(v) && v > 0) { s[c] = v; change = true; } };
    if (k(s.e) && k(s.f)) poser('dh', s.f - s.e);
    if (k(s.dh) && k(s.f)) poser('e', s.f - s.dh);
    if (k(s.dh) && k(s.e)) poser('f', s.e + s.dh);
    const { x, dh, r, p } = s;
    if (k(x) && k(dh)) { poser('r', Math.hypot(x, dh)); poser('p', Math.atan2(dh, x)); }
    if (k(x) && k(r) && r > x) { poser('dh', Math.sqrt(r * r - x * x)); poser('p', Math.acos(x / r)); }
    if (k(x) && k(p)) { poser('dh', x * Math.tan(p)); poser('r', x / Math.cos(p)); }
    if (k(dh) && k(r) && r > dh) { poser('x', Math.sqrt(r * r - dh * dh)); poser('p', Math.asin(dh / r)); }
    if (k(dh) && k(p)) { poser('x', dh / Math.tan(p)); poser('r', dh / Math.sin(p)); }
    if (k(r) && k(p)) { poser('x', r * Math.cos(p)); poser('dh', r * Math.sin(p)); }
    if (!change) break;
  }
  return s;
}

function resoudreGabarit() {
  const g = R.gabarit;
  const saisi = {};
  for (const [cle] of GABARITS[g.type]) { const v = lireChamp(cle, g.saisis[cle]); if (v != null) saisi[cle] = v; }
  const v = { ...saisi }, origine = {}, alertes = [], supposes = {};
  for (const cle of Object.keys(saisi)) origine[cle] = 'saisi';
  const poser = (cle, val) => {
    if (v[cle] == null && Number.isFinite(val) && val > 0) { v[cle] = val; origine[cle] = supposes[cle] ? 'supposé' : 'calculé'; }
  };
  const ecart = (nom, tape, calcule, pente = false) => {
    if (tape == null || calcule == null) return;
    const d = Math.abs(tape - calcule);
    if (pente ? d * RAD_DEG > 1 : d > 0.03) {
      alertes.push(pente
        ? `${nom} : tu as tapé ${fmtNb(tape * RAD_DEG, 1)}°, les autres mesures donnent ${fmtNb(calcule * RAD_DEG, 1)}°`
        : `${nom} : tu as tapé ${fmtM(tape)}, les autres mesures donnent ${fmtM(calcule)} (écart de ${fmtNb(d * 100, 0)} cm)`);
    }
  };

  if (g.type === 'pignon') {
    const G = { e: v.hG, f: v.hF, x: v.xF, r: v.rG, p: v.pG };
    const D = { e: v.hD, f: v.hF, r: v.rD, p: v.pD };
    const passe = () => {
      for (let i = 0; i < 6; i++) {
        resoudrePan(G); resoudrePan(D);
        if (G.f != null && D.f == null) D.f = G.f;
        if (D.f != null && G.f == null) G.f = D.f;
        if (v.L != null && G.x != null && D.x == null) D.x = v.L - G.x;
        if (v.L != null && D.x != null && G.x == null) G.x = v.L - D.x;
      }
    };
    passe();
    // Ce qui manque encore : hypothèses de bon sens, signalées comme « supposées ».
    if (G.x == null && D.x == null && v.L != null) { G.x = D.x = v.L / 2; supposes.xF = 'faîtage au milieu'; passe(); }
    if (D.e == null && G.e != null) { D.e = G.e; supposes.hD = 'comme l\'égout gauche'; passe(); }
    if (G.e == null && D.e != null) { G.e = D.e; supposes.hG = 'comme l\'égout droit'; passe(); }
    if (G.p == null && D.p != null && G.x == null) { G.p = D.p; supposes.pG = 'comme la pente droite'; passe(); }
    if (D.p == null && G.p != null && D.x == null) { D.p = G.p; supposes.pD = 'comme la pente gauche'; passe(); }
    if (v.L == null && G.x != null && D.x != null) poser('L', G.x + D.x);
    for (const [cle, val] of [['hG', G.e], ['hD', D.e], ['hF', G.f ?? D.f], ['xF', G.x]]) poser(cle, val);
    if (saisi.L != null && G.x != null && D.x != null) ecart('Largeur', saisi.L, G.x + D.x);
    // Rampants et pentes : on refait le calcul avec la forme dessinée (faîtage à xF, murs à 0 et L).
    if (v.L != null && v.xF != null && v.hG != null && v.hD != null && v.hF != null) {
      const geo = { rG: Math.hypot(v.xF, v.hF - v.hG), rD: Math.hypot(v.L - v.xF, v.hF - v.hD),
        pG: Math.atan2(v.hF - v.hG, v.xF), pD: Math.atan2(v.hF - v.hD, v.L - v.xF) };
      ecart('Rampant gauche', saisi.rG, geo.rG); ecart('Rampant droit', saisi.rD, geo.rD);
      ecart('Pente gauche', saisi.pG, geo.pG, true); ecart('Pente droite', saisi.pD, geo.pD, true);
      for (const cle of ['rG', 'rD', 'pG', 'pD']) poser(cle, geo[cle]);
    }
  } else if (g.type === 'appentis') {
    const S = resoudrePan({ e: v.hB, f: v.hH, x: v.L, r: v.r, p: v.p });
    for (const [cle, val] of [['L', S.x], ['hB', S.e], ['hH', S.f], ['r', S.r], ['p', S.p]]) poser(cle, val);
    if (v.L != null && v.hB != null && v.hH != null) {
      ecart('Rampant', saisi.r, Math.hypot(v.L, v.hH - v.hB));
      ecart('Pente', saisi.p, Math.atan2(v.hH - v.hB, v.L), true);
    }
  } else if (g.type === 'pan') {
    const S = resoudrePan({ x: v.portee, r: v.r, p: v.p });
    for (const [cle, val] of [['portee', S.x], ['r', S.r], ['p', S.p]]) poser(cle, val);
  } else if (g.type === 'libre') {
    if (v.hD == null && v.hG != null) { supposes.hD = 'comme le coin gauche'; poser('hD', v.hG); }
    if (v.hG == null && v.hD != null) { supposes.hG = 'comme le coin droit'; poser('hG', v.hD); }
    const pts = pointsLibres(g);
    if (v.L != null) {
      for (const p of pts) if (p.x > v.L + 0.005) alertes.push(`Point à ${fmtM(p.x)} m : plus loin que la largeur (${fmtM(v.L)} m)`);
    }
  }
  return { v, origine, alertes, supposes };
}

// Formes et cotes en mètres → éléments du relevé (1 m = 100 points, y vers le bas comme sur une photo).
function construireSaisie(sol) {
  const g = R.gabarit, v = sol.v, o = sol.origine;
  const els = [], manque = [], lin = [];
  const req = (cle, nom) => { if (v[cle] == null) manque.push(nom); };
  let haut = 0;
  const pts = [];
  const cotes = [];
  // Valeurs pour dessiner même si tout n'est pas connu (le dessin reste « proposé »).
  const d = { ...v };
  const cote = (nom, a, b, cle) => cotes.push({ nom, a, b, cle });

  if (g.type === 'pignon') {
    ['L', 'hG', 'hD', 'hF'].forEach((c, i) => req(c, ['la largeur', 'l\'égout gauche', 'l\'égout droit', 'la hauteur au faîtage (ou un rampant, ou une pente)'][i]));
    d.L ??= 10; d.hG ??= d.hD ?? 3; d.hD ??= d.hG; d.xF ??= d.L / 2;
    d.hF ??= Math.max(d.hG, d.hD) + d.xF * Math.tan(25 / RAD_DEG);
    pts.push([0, 0], [0, d.hG], [d.xF, d.hF], [d.L, d.hD], [d.L, 0]);
    haut = d.hF;
    const off = 0.7;
    cote('Largeur', [0, -off], [d.L, -off], 'L');
    cote('Égout G', [-off, 0], [-off, d.hG], 'hG');
    cote('Égout D', [d.L + off, 0], [d.L + off, d.hD], 'hD');
    cote('Faîtage', [d.xF, 0], [d.xF, d.hF], 'hF');
    const decale = (a, b) => { const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const nx = -(b[1] - a[1]) / n * off, ny = (b[0] - a[0]) / n * off; return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]]; };
    cote('Rampant G', ...decale([0, d.hG], [d.xF, d.hF]), 'rG');
    cote('Rampant D', ...decale([d.xF, d.hF], [d.L, d.hD]), 'rD');
    if (!manque.length) {
      const deb = v.debord || 0;
      const rives = v.rG + v.rD + 2 * deb;
      lin.push(['Pente gauche', afficherChamp('pG', v.pG)], ['Pente droite', afficherChamp('pD', v.pD)]);
      lin.push(['Rives (un pignon)', `${fmtM(rives)} ml`]);
      if (v.long) {
        lin.push(['Faîtage (longueur)', `${fmtM(v.long)} ml`], ['Gouttières (2 côtés)', `${fmtM(2 * v.long)} ml`]);
        R.toiture = rives * v.long;
        R.pans = [{ nom: 'Pan gauche', r: v.rG + deb, long: v.long }, { nom: 'Pan droit', r: v.rD + deb, long: v.long }];
      }
    }
  } else if (g.type === 'appentis') {
    req('L', 'la largeur'); req('hB', 'la hauteur côté bas'); req('hH', 'la hauteur côté haut (ou le rampant, ou la pente)');
    d.L ??= 6; d.hB ??= 2.5; d.hH ??= d.hB + d.L * Math.tan(15 / RAD_DEG);
    pts.push([0, 0], [0, d.hB], [d.L, d.hH], [d.L, 0]);
    haut = Math.max(d.hB, d.hH);
    const off = 0.7;
    cote('Largeur', [0, -off], [d.L, -off], 'L');
    cote('Côté bas', [-off, 0], [-off, d.hB], 'hB');
    cote('Côté haut', [d.L + off, 0], [d.L + off, d.hH], 'hH');
    const n = Math.hypot(d.L, d.hH - d.hB) || 1;
    const nx = -(d.hH - d.hB) / n * off, ny = d.L / n * off;
    cote('Rampant', [nx, d.hB + ny], [d.L + nx, d.hH + ny], 'r');
    if (!manque.length) {
      const deb = v.debord || 0;
      lin.push(['Pente', afficherChamp('p', v.p)], ['Rive', `${fmtM(v.r + deb)} ml`]);
      if (v.long) { lin.push(['Gouttière', `${fmtM(v.long)} ml`]); R.toiture = (v.r + deb) * v.long; R.pans = [{ nom: 'Pan', r: v.r + deb, long: v.long }]; }
    }
  } else if (g.type === 'mur') {
    req('L', 'la longueur'); req('H', 'la hauteur');
    d.L ??= 10; d.H ??= 3;
    pts.push([0, 0], [0, d.H], [d.L, d.H], [d.L, 0]);
    haut = d.H;
    cote('Longueur', [0, -0.7], [d.L, -0.7], 'L');
    cote('Hauteur', [-0.7, 0], [-0.7, d.H], 'H');
  } else if (g.type === 'libre') {
    req('L', 'la largeur au sol'); req('hG', 'la hauteur au coin gauche');
    d.L ??= 10; d.hG ??= 3; d.hD ??= d.hG;
    const hauts = pointsLibres(g).filter((p) => p.x <= d.L + 0.005);
    pts.push([0, 0], [0, d.hG], ...hauts.map((p) => [p.x, p.h]), [d.L, d.hD], [d.L, 0]);
    haut = Math.max(d.hG, d.hD, ...hauts.map((p) => p.h));
    const off = 0.7;
    cote('Largeur', [0, -off], [d.L, -off], 'L');
    cote('Coin G', [-off, 0], [-off, d.hG], 'hG');
    cote('Coin D', [d.L + off, 0], [d.L + off, d.hD], 'hD');
    hauts.forEach((p, k) => {
      const cle = `pt${k}`;
      v[cle] = p.h; o[cle] = 'saisi';
      if (p.x > 0.05 && p.x < d.L - 0.05) cote(`Point ${k + 1} (à ${fmtM(p.x)})`, [p.x, 0], [p.x, p.h], cle);
    });
    if (!manque.length) {
      // Longueur du haut (rives, acrotère, couvertine) : somme des segments du contour supérieur.
      let dessus = 0;
      const sommet = pts.slice(1, -1);
      for (let k = 1; k < sommet.length; k++) dessus += Math.hypot(sommet[k][0] - sommet[k - 1][0], sommet[k][1] - sommet[k - 1][1]);
      lin.push(['Longueur du haut (rives)', `${fmtM(dessus)} ml`]);
      if (v.long) lin.push(['Longueur du bâtiment', `${fmtM(v.long)} ml`]);
    }
  } else {
    req('r', 'le rampant (ou la portée et la pente)'); req('long', 'la longueur du pan');
    d.r ??= 6; d.long ??= 10;
    pts.push([0, 0], [0, d.r], [d.long, d.r], [d.long, 0]);
    haut = d.r;
    cote('Longueur', [0, -0.7], [d.long, -0.7], 'long');
    cote('Rampant', [-0.7, 0], [-0.7, d.r], 'r');
    if (!manque.length && v.p) lin.push(['Pente', afficherChamp('p', v.p)]);
    if (!manque.length) R.pans = [{ nom: 'Pan', r: v.r, long: v.long }];
  }

  // Ouvertures : largeur × hauteur, ou surface seule ; à gauche, à la distance tapée, sinon centrée.
  const largeurTotale = g.type === 'pan' ? d.long : d.L;
  const ouvertures = [];
  g.ouvertures.forEach((ov, i) => {
    let l = lireMesure(ov.l) || 0, h = lireMesure(ov.h) || 0;
    const s = lireMesure(ov.s) || 0;
    const nom = ov.nom || `Ouverture ${i + 1}`;
    if (s && l && !h) h = s / l;
    if (s && h && !l) l = s / h;
    const libre = s && !l && !h;
    if (libre) { l = h = Math.sqrt(s); }
    if (!l || !h) { manque.push(`les dimensions de « ${nom} »`); return; }
    const x = ov.x !== '' && ov.x != null && lireMesure(ov.x) != null ? lireMesure(ov.x) : (largeurTotale - l) / 2;
    ouvertures.push({ nom, x, l, h, libre, lTape: lireMesure(ov.l) || 0, hTape: lireMesure(ov.h) || 0, projetH: lireMesure(ov.p) || 0 });
  });

  // Passage en points (y inversé).
  const H0 = haut + 1.5;
  const P = ([x, y]) => ({ x: Math.round(x * 100), y: Math.round((H0 - y) * 100) });
  els.push({ type: 'surface', nom: NOMS_GABARITS[g.type], pts: pts.map(P) });
  for (const c of cotes) {
    els.push({ type: 'cote', nom: c.nom, a: P(c.a), b: P(c.b), valeur: o[c.cle] === 'saisi' ? v[c.cle] : 0,
      inconnu: v[c.cle] == null, suppose: o[c.cle] === 'supposé' });
  }
  for (const ov of ouvertures) {
    els.push({ type: 'ouverture', nom: ov.nom, projetH: ov.projetH, pts: [[ov.x, 0], [ov.x, ov.h], [ov.x + ov.l, ov.h], [ov.x + ov.l, 0]].map(P) });
    if (!ov.libre) {
      els.push({ type: 'cote', nom: `${ov.nom} (largeur)`, court: true, a: P([ov.x, 0.35]), b: P([ov.x + ov.l, 0.35]), valeur: ov.lTape });
      els.push({ type: 'cote', nom: `${ov.nom} (hauteur)`, court: true, a: P([ov.x + 0.35, 0]), b: P([ov.x + 0.35, ov.h]), valeur: ov.hTape });
    }
  }
  R.elements = els;
  R.echelleFixe = { sx: 0.01, sy: 0.01, refs: Object.keys(o).filter((c) => o[c] === 'saisi').length, ecart: 0, deuxSens: true, fixe: true };
  R.incomplet = manque;
  R.alertes = sol.alertes;
  R.lineaires = lin;
}

function choisirGabarit(type, maj = true) {
  R.gabarit.type = type;
  for (const b of $$('#gabarit-types [data-gabarit]')) b.classList.toggle('active', b.dataset.gabarit === type);
  // Ouvrage proposé : toiture → plaques/couverture ; murs → bardage.
  if (maj && type === 'pan' && R.ouvrage === 'bardage') R.ouvrage = 'plaques';
  $('#releve-ouvrage').value = R.ouvrage;
  dessinerParamsReleve();
  dessinerChampsSaisie();
  dessinerOuvertures();
  if (maj) majReleve();
}

function dessinerChampsSaisie() {
  const g = R.gabarit;
  $('#gabarit-champs').replaceChildren(...GABARITS[g.type].map(([cle, libelle]) => {
    const input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', id: `saisie-${cle}`, value: g.saisis[cle] || '' });
    input.oninput = () => { g.saisis[cle] = input.value; majReleve(); };
    return el('div', { class: 'champ champ-saisie', 'data-cle': cle },
      el('label', { for: `saisie-${cle}` }, libelle), input, el('small', { class: 'calcul' }, ''));
  }));
  dessinerPointsLibres();
}

function dessinerPointsLibres() {
  const g = R.gabarit;
  const libre = g.type === 'libre';
  $('#gabarit-points-bloc').classList.toggle('cache', !libre);
  if (!libre) return;
  g.points ||= [];
  $('#gabarit-points').replaceChildren(...g.points.map((p, i) => {
    const champ = (cle, libelle, ph) => {
      const input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: ph, value: p[cle] || '' });
      input.oninput = () => { p[cle] = input.value; majReleve(); };
      return el('div', { class: 'champ' }, el('label', {}, libelle), input);
    };
    return el('div', { class: 'ouverture-saisie point-libre' },
      el('div', { class: 'ouverture-entete' }, el('strong', {}, `Point ${i + 1}`),
        el('button', { class: 'lien', 'aria-label': 'Retirer', onclick: () => { g.points.splice(i, 1); dessinerPointsLibres(); majReleve(); } }, '🗑️')),
      el('div', { class: 'deux-champs' }, champ('x', 'Depuis le coin gauche', 'ex. 4,20'), champ('h', 'Hauteur', 'ex. 5,80')));
  }));
}

function dessinerOuvertures() {
  const g = R.gabarit;
  // « Ce mur a des ouvertures » : coché seulement s'il y en a (demande de Jean-Phi : un mur peut ne pas en avoir).
  const avec = g.ouvertures.length > 0 || !!g.avecOuvertures;
  $('#gabarit-avec-ouvertures').checked = avec;
  $('#gabarit-ouvertures-bloc').classList.toggle('cache', !avec);
  $('#gabarit-ouvertures').replaceChildren(...g.ouvertures.map((ov, i) => {
    const champ = (cle, libelle, ph) => {
      const input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: ph, value: ov[cle] || '' });
      input.oninput = () => { ov[cle] = input.value; majReleve(); };
      return el('div', { class: 'champ' }, el('label', {}, libelle), input);
    };
    const nom = el('input', { type: 'text', class: 'nom-ouverture', value: ov.nom || '', placeholder: `Ouverture ${i + 1}` });
    nom.oninput = () => { ov.nom = nom.value.trim(); majReleve(); };
    return el('div', { class: 'ouverture-saisie' },
      el('div', { class: 'ouverture-entete' }, nom,
        el('button', { class: 'lien', 'aria-label': 'Retirer', onclick: () => { g.ouvertures.splice(i, 1); dessinerOuvertures(); majReleve(); } }, '🗑️')),
      el('div', { class: 'deux-champs' }, champ('l', 'Largeur', 'ex. 5,70'), champ('h', 'Hauteur', 'ex. 3,15'),
        champ('x', 'Depuis la gauche', 'centrée'), champ('s', 'ou surface (m²)', 'forme libre'),
        champ('p', 'Hauteur après travaux', 'si elle change')));
  }));
}

function majPhotoJointe() {
  const zone = $('#gabarit-photo-vignette');
  zone.replaceChildren(...(R.photo ? [el('img', { src: R.photo, alt: 'Photo jointe' }),
    el('button', { class: 'suppr', 'aria-label': 'Retirer la photo', onclick: () => { R.photo = ''; R.img = null; majPhotoJointe(); sauverBrouillonReleve(); } }, '×')] : []));
  $('#gabarit-photo').textContent = R.photo ? '📷 Changer la photo' : '📷 Joindre une photo (facultatif)';
}

function majSaisie(sauver = true) {
  R.toiture = 0;
  R.pans = [];
  const sol = resoudreGabarit();
  construireSaisie(sol);
  const s = R.echelleFixe;
  const m = metreReleve(s);

  // Ce que l'appli a calculé s'affiche en gris dans les cases vides.
  for (const div of $$('#gabarit-champs .champ-saisie')) {
    const cle = div.dataset.cle;
    const o = sol.origine[cle];
    const val = sol.v[cle];
    const input = div.querySelector('input');
    const petit = div.querySelector('.calcul');
    div.classList.toggle('calcule', o === 'calculé');
    div.classList.toggle('suppose', o === 'supposé');
    input.placeholder = o && o !== 'saisi' ? afficherChamp(cle, val).replace(' m', '') : cle === 'debord' ? '0' : '';
    petit.textContent = o === 'calculé' ? `= ${afficherChamp(cle, val)} calculé` : o === 'supposé' ? `≈ ${afficherChamp(cle, val)} supposé (${sol.supposes[cle]})` : '';
  }

  const c = $('#gabarit-apercu');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  dessinerPlan(ctx, { x: 0, y: 0, w: c.width, h: c.height }, s, 1.35);

  const aide = $('#gabarit-aide');
  if (R.incomplet.length) {
    aide.className = 'releve-aide';
    aide.textContent = `Tape ce que tu as mesuré. Il manque encore : ${R.incomplet.join(', ')}.`;
  } else if (R.alertes.length) {
    aide.className = 'releve-aide';
    aide.replaceChildren(el('strong', {}, '⚠ Des mesures ne collent pas entre elles :'), ...R.alertes.map((a) => el('div', {}, `• ${a}`)));
  } else {
    aide.className = 'releve-aide ok';
    aide.textContent = '✓ Tout est calculé. Les cases grises sont les valeurs trouvées par l\'appli.';
  }

  const lignes = [];
  if (!R.incomplet.length) {
    for (const e of [...m.surfaces, ...m.ouvertures]) {
      lignes.push(el('li', {}, el('span', {}, nomElement(e), e.type === 'ouverture' ? el('small', {}, ' à déduire') : null),
        el('b', {}, `${e.type === 'ouverture' ? '− ' : ''}${fmtNb(aireAff(e, s), 2)} m²${e.projetH > 0 ? ' après travaux' : ''}`)));
    }
    if (m.gain > 0) lignes.push(el('li', {}, el('span', {}, 'Bardage en plus', el('small', {}, ' ouvertures réduites')), el('b', {}, `+ ${fmtNb(m.gain, 2)} m²`)));
    if (m.zone) lignes.push(...lignesZoneListe(m));
    if (m.ouvertures.length || m.zone) lignes.push(el('li', { class: 'total' }, el('span', {}, m.gain > 0 ? 'Surface nette après travaux' : 'Surface nette'), el('b', {}, `${fmtNb(m.net, 2)} m²`)));
    if (m.toiture) lignes.push(el('li', {}, el('span', {}, 'Surface de toiture'), el('b', {}, `${fmtNb(m.toiture, 2)} m²`)));
    for (const [a, b] of R.lineaires) lignes.push(el('li', {}, el('span', {}, a), el('b', {}, b)));
  }
  $('#releve-liste').replaceChildren(...(lignes.length ? lignes : [el('li', { class: 'vide' }, 'Les surfaces s\'afficheront dès que les mesures seront complètes.')]));
  if (R.incomplet.length) { majCarteZone(); $('#releve-quantites').replaceChildren(el('li', { class: 'vide' }, 'Complète les mesures pour avoir les quantités.')); dessinerTravaux(null); }
  else dessinerQuantites(m, 'Pas de quantité pour l\'instant.');
  $('#releve-envoyer').disabled = !!R.incomplet.length;
  if (sauver) sauverBrouillonReleve();
}

// ---------- Dessin ----------
const epReleve = (c) => Math.max(3, Math.round(Math.max(c.width, c.height) / 230));

function dessinerReleveSur(ctx, ep, s) {
  for (const e of R.elements) {
    if (e.type === 'cote') continue;
    tracerSurface(ctx, e.pts, e.type, ep, true);
    const pe = pointEtiquette(e);
    // Ouvertures : petite étiquette (surface seule), pour ne pas cacher la photo.
    if (s && e.type === 'ouverture') etiquette(ctx, `− ${fmtNb(aireAff(e, s), 2)} m²${e.projetH > 0 ? ' (projet)' : ''}`, pe.x, pe.y, ep * 0.5, '#ff9f97');
    else if (s) etiquette(ctx, `${nomElement(e)} · ${fmtNb(aireAff(e, s), 1)} m²`, pe.x, pe.y, ep * 0.8, e.type === 'ouverture' ? '#ff9f97' : '#cfe0ff');
  }
  // Zone de travaux sur la photo : cadre orange (redressé si la photo est de biais).
  const r = rectZone(s);
  if (r) {
    const coins = [[r.xa, r.yb], [r.xb, r.yb], [r.xb, r.ya], [r.xa, r.ya]].map(([x, y]) => versPx({ x, y }, s));
    ctx.save();
    ctx.beginPath();
    coins.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,159,10,.18)';
    ctx.fill();
    ctx.strokeStyle = '#ff9f0a';
    ctx.lineWidth = ep * 1.2;
    ctx.setLineDash([ep * 4, ep * 2]);
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = ep;
    ctx.stroke();
    ctx.restore();
    // Étiquette en haut de la zone, à l'intérieur (les cotes de largeur sont en général en bas).
    const haut = { x: (coins[2].x + coins[3].x) / 2, y: (coins[2].y + coins[3].y) / 2 };
    etiquette(ctx, `Zone de travaux · ${fmtM(r.xb - r.xa)} m`, haut.x, haut.y + ep * 6, ep * 0.8, '#ffd60a');
  }
  for (const e of R.elements) {
    if (e.type !== 'cote') continue;
    // Cote proposée : sa lettre (A, B…) devant ; celle que l'on mesure en ce moment est en vert, plus épaisse.
    const visee = R.coteVisee === e && !e.valeur;
    const texte = e.lettre ? `${e.lettre}  ${e.valeur > 0 || s ? texteCote(e, s) : '?'}` : texteCote(e, s);
    dessinerForme(ctx, { type: 'cote', couleur: visee ? '#30d158' : e.valeur > 0 ? '#ffcc00' : '#ffffff', a: e.a, b: e.b, texte }, visee ? ep * 1.4 : ep);
    pointsReleve(ctx, [e.a, e.b], ep);
  }
  const ec = R.enCours;
  if (ec?.type === 'cote') dessinerForme(ctx, { type: 'cote', couleur: '#ffcc00', a: ec.a, b: ec.b, texte: s ? `≈ ${fmtM(longueurM(ec.a, ec.b, s))}` : '' }, ep);
  if (ec?.pts) tracerSurface(ctx, ec.pts, ec.type, ep, false);
}

function tracerSurface(ctx, pts, type, ep, ferme) {
  if (!pts.length) return;
  ctx.save();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (ferme) ctx.closePath();
  const ouverture = type === 'ouverture';
  if (ferme) { ctx.fillStyle = ouverture ? 'rgba(255,69,58,.22)' : 'rgba(47,111,235,.25)'; ctx.fill(); }
  ctx.strokeStyle = ouverture ? '#ff453a' : '#4d8dff';
  ctx.lineWidth = ep;
  ctx.lineJoin = 'round';
  if (ouverture) ctx.setLineDash([ep * 3, ep * 2]);
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = ep;
  ctx.stroke();
  ctx.restore();
  pointsReleve(ctx, pts, ep, !ferme);
}

function pointsReleve(ctx, pts, ep, premierEnEvidence = false) {
  ctx.save();
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, ep * (premierEnEvidence && i === 0 && pts.length >= 3 ? 2.6 : 1.5), 0, 2 * Math.PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = ep * 0.6;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  });
  ctx.restore();
}

function redessinerReleve() {
  const c = $('#releve-canvas');
  if (!R.img || R.mode !== 'photo') return;
  const ctx = c.getContext('2d');
  ctx.drawImage(R.img, 0, 0);
  dessinerReleveSur(ctx, epReleve(c), echelleReleve());
  if (R.loupe) montrerLoupe(R.loupe);
}

function planifierDessinReleve() {
  if (!R.image) R.image = requestAnimationFrame(() => { R.image = 0; redessinerReleve(); });
}

// Loupe : le doigt cache le point visé, on le montre agrandi 3 fois dans un coin.
function montrerLoupe(p) {
  const c = $('#releve-canvas'), l = $('#releve-loupe');
  // La loupe fait 120 points à l'écran : elle montre un carré de 40 points de la photo affichée (zoom × 3).
  const k = c.getBoundingClientRect().width / c.width;
  const src = 40 / Math.max(k, 0.0001);
  const ctx = l.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, l.width, l.height);
  ctx.drawImage(c, p.x - src / 2, p.y - src / 2, src, src, 0, 0, l.width, l.height);
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(l.width / 2, l.height / 2 - 18); ctx.lineTo(l.width / 2, l.height / 2 + 18);
  ctx.moveTo(l.width / 2 - 18, l.height / 2); ctx.lineTo(l.width / 2 + 18, l.height / 2);
  ctx.stroke();
  l.classList.remove('cache');
  l.classList.toggle('a-droite', p.x < c.width / 2);
}

function cacherLoupe() { R.loupe = null; $('#releve-loupe').classList.add('cache'); }

// ---------- Doigt sur la photo ----------
function pointReleve(ev) {
  const c = $('#releve-canvas'), r = c.getBoundingClientRect();
  return { x: Math.round((ev.clientX - r.left) * c.width / r.width), y: Math.round((ev.clientY - r.top) * c.height / r.height) };
}
const toleranceReleve = (ecranPx = 24) => { const c = $('#releve-canvas'); return ecranPx * c.width / c.getBoundingClientRect().width; };

function sauverHistorique() {
  R.historique.push(JSON.stringify(R.elements));
  if (R.historique.length > 60) R.historique.shift();
}

function sommetProche(p) {
  const tol = toleranceReleve();
  let meilleur = null;
  for (const e of R.elements) {
    const sommets = e.type === 'cote' ? [['a', e.a], ['b', e.b]] : e.pts.map((q, i) => [i, q]);
    for (const [cle, q] of sommets) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < tol && (!meilleur || d < meilleur.d)) meilleur = { e, cle, d };
    }
  }
  return meilleur;
}

function distanceSegment(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

function dansPolygone(p, pts) {
  let dedans = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].y > p.y) !== (pts[j].y > p.y) && p.x < (pts[j].x - pts[i].x) * (p.y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) dedans = !dedans;
  }
  return dedans;
}

function elementSous(p) {
  const tol = toleranceReleve(20);
  const cote = R.elements.filter((e) => e.type === 'cote').map((e) => ({ e, d: distanceSegment(p, e.a, e.b) }))
    .filter((x) => x.d < tol).sort((x, y) => x.d - y.d)[0];
  if (cote) return cote.e;
  return R.elements.filter((e) => e.type !== 'cote' && dansPolygone(p, e.pts)).sort((x, y) => airePx(x.pts) - airePx(y.pts))[0] || null;
}

function releveDebut(ev) {
  ev.preventDefault();
  const p = pointReleve(ev);
  const capturer = () => { try { ev.target.setPointerCapture(ev.pointerId); } catch { /* sans importance */ } };
  if (R.outil === 'modifier') {
    const s = sommetProche(p);
    if (s) { sauverHistorique(); R.glisse = s; R.loupe = p; capturer(); planifierDessinReleve(); return; }
    const e = elementSous(p);
    if (e) ouvrirSelection(e); else fermerSelection();
    return;
  }
  if (R.outil === 'cote') {
    R.enCours = { type: 'cote', a: p, b: p };
  } else {
    if (!R.enCours?.pts || R.enCours.type !== R.outil) R.enCours = { type: R.outil, pts: [] };
    const pts = R.enCours.pts;
    if (pts.length >= 3 && Math.hypot(pts[0].x - p.x, pts[0].y - p.y) < toleranceReleve()) { fermerSurface(); return; }
    pts.push(p);
    R.enCours.mobile = true;
  }
  R.loupe = p;
  capturer();
  planifierDessinReleve();
}

function releveMouvement(ev) {
  const actif = R.glisse || R.enCours?.type === 'cote' || R.enCours?.mobile;
  if (!actif) return;
  ev.preventDefault();
  const p = pointReleve(ev);
  if (R.glisse) {
    const { e, cle } = R.glisse;
    if (e.type === 'cote') e[cle] = p; else e.pts[cle] = p;
  } else if (R.enCours.type === 'cote') R.enCours.b = p;
  else R.enCours.pts[R.enCours.pts.length - 1] = p;
  R.loupe = p;
  planifierDessinReleve();
}

function releveFin() {
  cacherLoupe();
  if (R.glisse) { R.glisse = null; redessinerReleve(); majReleve(); return; }
  const ec = R.enCours;
  if (!ec) return;
  if (ec.type === 'cote') {
    R.enCours = null;
    if (Math.hypot(ec.b.x - ec.a.x, ec.b.y - ec.a.y) < toleranceReleve(18)) { redessinerReleve(); return; }
    redessinerReleve();
    const premiere = !echelleReleve();
    const t = prompt(premiere
      ? 'Tape la vraie mesure de cette cote, prise sur place (ex. 4,35). Elle sert d\'échelle pour tout le reste.'
      : 'Mesure prise sur place ? Tape-la (ex. 2,60). Laisse vide pour la calculer sur la photo.', '');
    if (t === null) { redessinerReleve(); return; }
    const v = lireMesure(t);
    if (v === null) { toast('Mesure illisible (ex. 4,35 ou 435 cm).', 'erreur'); redessinerReleve(); return; }
    sauverHistorique();
    R.elements.push({ type: 'cote', a: ec.a, b: ec.b, valeur: v || 0, nom: '' });
    if (premiere && !v) toast('Il faut au moins une cote mesurée sur place pour avoir l\'échelle.', 'erreur');
  } else {
    ec.mobile = false;
  }
  redessinerReleve();
  majReleve();
}

function fermerSurface() {
  const ec = R.enCours;
  if (!ec?.pts || ec.pts.length < 3) return;
  sauverHistorique();
  const n = R.elements.filter((e) => e.type === ec.type).length + 1;
  R.elements.push({ type: ec.type, pts: ec.pts, nom: `${ec.type === 'ouverture' ? 'Ouverture' : 'Surface'} ${n}` });
  R.enCours = null;
  redessinerReleve();
  majReleve();
}

function defaireReleve() {
  if (R.enCours?.pts?.length) { R.enCours.pts.pop(); if (!R.enCours.pts.length) R.enCours = null; }
  else if (R.historique.length) R.elements = JSON.parse(R.historique.pop());
  fermerSelection();
  redessinerReleve();
  majReleve();
}

function choisirOutilReleve(outil) {
  if (R.enCours && R.enCours.type !== outil) R.enCours = null;
  R.outil = outil;
  for (const b of $$('#releve-outils [data-outil]')) b.classList.toggle('active', b.dataset.outil === outil);
  fermerSelection();
  redessinerReleve();
  majReleve(false);
}

// ---------- Modifier une cote ou une surface ----------
let selectionReleve = null;
function ouvrirSelection(e) {
  selectionReleve = e;
  const s = echelleReleve();
  const zone = $('#releve-selection');
  const titre = e.type === 'cote' ? `${nomElement(e)} · ${texteCote(e, s)}` : `${nomElement(e)}${s ? ` · ${e.type === 'ouverture' ? texteOuverture(e, s) : `${fmtNb(aireM2(e.pts, s), 2)} m²`}` : ''}`;
  const boutons = [];
  if (e.type === 'cote') {
    boutons.push(el('button', { class: 'btn-petit', onclick: () => {
      const t = prompt('Mesure prise sur place (vide = calculée sur la photo) :', e.valeur ? String(e.valeur).replace('.', ',') : '');
      if (t === null) return;
      const v = lireMesure(t);
      if (v === null) { toast('Mesure illisible.', 'erreur'); return; }
      sauverHistorique(); e.valeur = v || 0; apresModif();
    } }, '📏 Mesure'));
  } else {
    boutons.push(el('button', { class: 'btn-petit', onclick: () => {
      sauverHistorique(); e.type = e.type === 'ouverture' ? 'surface' : 'ouverture';
      e.nom = e.nom.replace(/^(Surface|Ouverture)/, e.type === 'ouverture' ? 'Ouverture' : 'Surface'); apresModif();
    } }, e.type === 'ouverture' ? '⇄ Compter' : '⇄ Déduire'));
    // Le client veut changer l'ouverture (ex. bardage descendu plus bas) : nouvelle hauteur après travaux.
    if (e.type === 'ouverture') {
      boutons.push(el('button', { class: 'btn-petit', onclick: () => {
        const t = prompt('Après travaux, quelle hauteur gardera cette ouverture (du sol, en m) ?\nEx. 2,50 si le bardage descend jusqu\'à 2,50 m du sol.\nLaisse vide si elle ne change pas.',
          e.projetH ? String(e.projetH).replace('.', ',') : '');
        if (t === null) return;
        const v = lireMesure(t);
        if (v === null) { toast('Hauteur illisible (ex. 2,50).', 'erreur'); return; }
        sauverHistorique(); e.projetH = v || 0; apresModif();
      } }, e.projetH > 0 ? `📐 Projet : ${fmtM(e.projetH)} m` : '📐 Après travaux'));
    }
  }
  boutons.push(el('button', { class: 'btn-petit', onclick: () => {
    const t = prompt('Nom (ex. Faîtage, Pignon nord, Porte) :', e.nom || '');
    if (t === null) return;
    sauverHistorique(); e.nom = t.trim().slice(0, 30); apresModif();
  } }, '🏷️ Nommer'));
  boutons.push(el('button', { class: 'btn-petit danger', onclick: () => {
    sauverHistorique(); R.elements = R.elements.filter((x) => x !== e); apresModif();
  } }, '🗑️'));
  zone.replaceChildren(el('strong', {}, titre), el('div', { class: 'selection-boutons' }, ...boutons),
    el('button', { class: 'fermer', 'aria-label': 'Fermer', onclick: fermerSelection }, '×'));
  zone.classList.remove('cache');
}
function apresModif() { const e = selectionReleve; fermerSelection(); redessinerReleve(); majReleve(); if (e && R.elements.includes(e)) ouvrirSelection(e); }
function fermerSelection() { selectionReleve = null; $('#releve-selection')?.classList.add('cache'); }

// ---------- Liste des mesures et quantitatif ----------
function majReleve(sauver = true) {
  if (R.mode === 'saisie') { majSaisie(sauver); return; }
  const s = echelleReleve();
  const m = metreReleve(s);
  const aide = $('#releve-aide');
  const enSurface = R.outil === 'surface' || R.outil === 'ouverture';
  const proposees = R.elements.filter((e) => e.type === 'cote' && e.lettre);
  R.lineaires = lineairesDepuisContour(s);
  majPanneauCotes(s);
  if (R.analyseEnCours) { /* le message d'attente reste affiché */ }
  else if (proposees.length && !s) aide.textContent = `Prends les mesures ${proposees.map((e) => e.lettre).join(', ')} : touche une case puis vise au laser (ou tape, ou dicte). Dès la première, tout se calcule.`;
  else if (proposees.length && s) {
    const controle = s.perspective ? (s.controles ? ` Contrôle : écart max ${fmtNb(s.ecart * 100, 1)} % entre tes autres mesures et la photo.` : '')
      : (s.refs >= 3 ? ` Écart max entre tes mesures et la photo : ${fmtNb(s.ecart * 100, 1)} %.` : '');
    const persp = s.perspective ? `✓ Perspective redressée${s.hauteurDroiteSupposee ? ` (hauteur à droite supposée égale à gauche : mesure ${R.analyse.repere.cote_hauteur_droite || 'la hauteur à droite'} si la photo est de biais)` : ''}. ` : '✓ Échelle trouvée. ';
    aide.textContent = proposees.some((e) => !e.valeur)
      ? `${persp}Les cases vides montrent la valeur d'après la photo : mesure-les pour contrôler.${controle}`
      : `${persp}Toutes les mesures sont prises.${controle} Tu peux créer la feuille.`;
  }
  else if (!s) aide.textContent = '① Tire une cote sur quelque chose que tu as mesuré sur place (avec Mesure ou au mètre), puis tape sa mesure : elle donne l\'échelle.';
  else if (enSurface) aide.textContent = R.outil === 'surface' ? 'Touche les coins de la surface un par un (la loupe aide), puis « Fermer la surface ».' : 'Touche les coins de l\'ouverture à déduire, puis « Fermer ».';
  else if (R.outil === 'modifier') aide.textContent = 'Fais glisser un point pour l\'ajuster, ou touche une cote ou une surface pour la modifier.';
  else if (s.refs === 1) aide.textContent = '✓ Échelle prise sur 1 mesure. Ajoute une 2e mesure dans l\'autre sens (verticale si la 1re est horizontale) : plus précis.';
  else aide.textContent = `✓ Échelle sur ${s.refs} mesures${s.deuxSens ? ' (dans les deux sens)' : ''}${s.refs >= 3 ? ` · écart max ${fmtNb(s.ecart * 100, 1)} %` : ''}. Tire les autres cotes.`;
  aide.classList.toggle('ok', !!s && !enSurface && (R.outil !== 'modifier' || proposees.length > 0));
  aide.classList.toggle('analyse', !!R.analyseEnCours);

  const n = R.enCours?.pts?.length || 0;
  const bf = $('#releve-fermer-surface');
  bf.classList.toggle('cache', !(enSurface && n >= 3));
  bf.textContent = R.outil === 'ouverture' ? '✓ Fermer l\'ouverture' : '✓ Fermer la surface';

  const lignes = [];
  m.cotes.forEach((e, i) => {
    const li = el('li', { class: 'cliquable' }, el('span', {}, `${e.lettre ? `${e.lettre} · ` : ''}${e.nom || `Cote ${i + 1}`}`, e.valeur > 0 ? el('small', {}, ' mesurée') : null),
      el('b', { class: e.valeur > 0 ? 'mesuree' : '' }, s || e.valeur ? `${fmtM(valeurCote(e, s))} m` : '?'));
    li.onclick = () => { choisirOutilReleve('modifier'); ouvrirSelection(e); };
    lignes.push(li);
  });
  for (const e of [...m.surfaces, ...m.ouvertures]) {
    const li = el('li', { class: 'cliquable' }, el('span', {}, nomElement(e), e.type === 'ouverture' ? el('small', {}, ' à déduire') : null),
      el('b', {}, s ? `${e.type === 'ouverture' ? '− ' : ''}${fmtNb(aireAff(e, s), 2)} m²${e.projetH > 0 ? ' après travaux' : ''}` : '?'));
    li.onclick = () => { choisirOutilReleve('modifier'); ouvrirSelection(e); };
    lignes.push(li);
  }
  if (s && m.gain > 0) lignes.push(el('li', {}, el('span', {}, 'Bardage en plus', el('small', {}, ' ouvertures réduites')), el('b', {}, `+ ${fmtNb(m.gain, 2)} m²`)));
  if (s && m.zone) lignes.push(...lignesZoneListe(m));
  if (s && m.surfaces.length) lignes.push(el('li', { class: 'total' }, el('span', {}, m.gain > 0 ? 'Surface nette après travaux' : 'Surface nette'), el('b', {}, `${fmtNb(m.net, 2)} m²`)));
  for (const [a, b] of R.lineaires) lignes.push(el('li', {}, el('span', {}, a, el('small', {}, ' calculé')), el('b', {}, b)));
  $('#releve-liste').replaceChildren(...(lignes.length ? lignes : [el('li', { class: 'vide' }, 'Pas encore de mesure.')]));

  dessinerQuantites(m, 'Trace une surface (et ses ouvertures) pour avoir les quantités.');
  $('#releve-envoyer').disabled = !s || !R.elements.length;
  if (sauver) sauverBrouillonReleve();
}

// Lignes du métré quand seule une partie du bâtiment est à faire.
function lignesZoneListe(m) {
  return [el('li', { class: 'zone' }, el('span', {}, '🎯 Zone de travaux', el('small', {}, ` ${fmtM(m.zone.xb - m.zone.xa)} × ${fmtM(m.zone.yb - m.zone.ya)} m max`)), el('b', {}, `${fmtNb(m.brut, 2)} m²`)),
    el('li', {}, el('span', {}, 'Bâtiment entier', el('small', {}, ' pour info, non compté')), el('b', { class: 'discret' }, `${fmtNb(m.entier, 2)} m²`))];
}

// Carte « Zone de travaux » : les champs suivent R.zone ; le résumé dit ce qui est compté.
function majCarteZone(s = echelleReleve()) {
  const z = R.zone;
  $('#zone-actif').checked = !!z.actif;
  $('#zone-champs').classList.toggle('cache', !z.actif);
  const r = rectZone(s);
  const resume = $('#zone-resume');
  if (!z.actif) return;
  if (!s) { resume.className = 'releve-aide'; resume.textContent = 'La zone se calculera dès que l\'échelle sera connue.'; return; }
  if (!r) { resume.className = 'releve-aide'; resume.textContent = 'Indique au moins « À » (la fin de la partie à faire), ou une hauteur.'; return; }
  resume.className = 'releve-aide ok';
  resume.textContent = `✓ Comptée : ${texteZone(r)}. Le reste du bâtiment est grisé et n'entre pas dans les quantités.`;
}
function remplirCarteZone() {
  const z = R.zone;
  $('#zone-depuis').value = z.depuis || 'gauche';
  for (const k of ['de', 'a', 'bas', 'haut']) $(`#zone-${k}`).value = Number(z[k]) > 0 ? fmtM(Number(z[k])) : '';
  majCarteZone();
}

function dessinerQuantites(m, vide) {
  majCarteZone();
  const q = quantitesReleve(m);
  $('#releve-quantites').replaceChildren(...(q.length
    ? q.map(([l, v]) => el('li', {}, el('span', {}, l), el('b', {}, v)))
    : [el('li', { class: 'vide' }, R.ouvrage === 'aucun' ? 'Les surfaces sont dans la liste au-dessus.' : vide)]));
  dessinerTravaux(m);
}

// ---------- Travaux en plus (1.19.1) : ajoutés à la main ou par la dictée, repris sur la feuille et dans le devis ----------
// Quantité proposée d'après le métré quand c'est évident (surface nette pour une dépose, rives…).
const TRAVAUX_COURANTS = [
  ['Dépose et évacuation du bardage existant', 'm²', (m) => m.net],
  ['Reprise de l\'empoutrement', 'ml', () => 0],
  ['Remplacement de plaques fibro-ciment (Everite)', 'u', () => 0],
  ['Désamiantage (plaques fibro-ciment)', 'm²', () => 0],
  ['Fourniture et pose de gouttières', 'ml', () => 0],
  ['Descentes d\'eaux pluviales', 'u', () => 0],
  ['Habillage des rives', 'ml', () => { const r = R.lineaires.find(([a]) => /rive/i.test(a)); return r ? parseFloat(String(r[1]).replace(/\s/g, '').replace(',', '.')) || 0 : 0; }],
  ['Bavette / habillage de l\'ouverture', 'ml', () => 0],
  ['Nacelle / échafaudage', 'forfait', () => 1],
  ['Évacuation des déchets', 'forfait', () => 1],
];

function ajouterTravail(libelle, quantite, unite) {
  libelle = String(libelle || '').trim();
  if (!libelle) return;
  R.travaux = [...(R.travaux || []).filter((x) => x.libelle !== libelle), { libelle, quantite: Number(quantite) || 0, unite: unite || '' }];
  majReleve();
  toast(`🔧 Ajouté : ${libelle}`, 'ok');
}

function dessinerTravaux(m) {
  const liste = R.travaux || [];
  $('#travaux-puces').replaceChildren(...TRAVAUX_COURANTS.filter(([l]) => !liste.some((t) => t.libelle === l)).map(([l, u, q]) =>
    el('button', { class: 'puce', type: 'button', onclick: () => { const v = q(m || {}); ajouterTravail(l, v > 0 ? Math.round(v * 100) / 100 : 0, u); } }, `＋ ${l}`)));
  $('#travaux-liste').replaceChildren(...liste.map((t, i) => {
    const qte = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '?', value: t.quantite > 0 ? String(t.quantite).replace('.', ',') : '' });
    qte.onchange = () => { t.quantite = lireMesure(qte.value) || 0; majReleve(); };
    return el('li', {}, el('span', { class: 'travail-nom' }, t.libelle), qte, el('span', { class: 'travail-unite' }, t.unite || ''),
      el('button', { class: 'lien', type: 'button', 'aria-label': `Retirer ${t.libelle}`, onclick: () => { R.travaux.splice(i, 1); majReleve(); } }, '×'));
  }));
}

function dessinerParamsReleve() {
  const vals = R.params[R.ouvrage] || {};
  $('#releve-params').replaceChildren(...(OUVRAGES[R.ouvrage] || []).map(([cle, libelle, defaut]) => {
    // La couleur est du texte (« 7016 », « gris anthracite »…), au choix du client ; le reste, des nombres.
    const texte = typeof defaut === 'string';
    const input = el('input', { type: 'text', inputmode: texte ? 'text' : 'decimal', value: String(vals[cle] ?? defaut).replace('.', texte ? '.' : ',') });
    input.oninput = () => {
      const v = texte ? input.value.trim() : Number(input.value.replace(',', '.'));
      if (!texte && !Number.isFinite(v)) return;
      R.params[R.ouvrage] = { ...(R.params[R.ouvrage] || {}), [cle]: v };
      majReleve();
    };
    return el('div', { class: 'champ' }, el('label', {}, libelle), input);
  }));
}

function texteMetre() {
  const s = echelleReleve();
  const m = metreReleve(s);
  const chantier = $('#releve-chantier').value;
  const facade = $('#releve-facade').value.trim();
  const l = [`Relevé${chantier ? ` – ${chantier}` : ''}${facade ? ` – ${facade}` : ''} – ${new Date().toLocaleDateString('fr-FR')}`, ''];
  m.cotes.forEach((e, i) => l.push(`${e.nom || `Cote ${i + 1}`} : ${texteValeur(e, s).replace(' ✓', '')} m${e.valeur > 0 ? ' (mesurée)' : e.suppose ? ' (supposée)' : R.mode === 'saisie' ? ' (calculée)' : ' (sur photo)'}`));
  for (const e of m.surfaces) l.push(`${nomElement(e)} : ${fmtNb(aireSurface(e, s), 2)} m²${m.zone ? ' (dans la zone)' : ''}`);
  for (const e of m.ouvertures) l.push(`${nomElement(e)} : ${texteOuverture(e, s)}${e.projetH > 0 ? ` – nouvelle hauteur ${fmtM(e.projetH)} m (projet du client)` : ''}`);
  if (m.gain > 0) l.push(`Bardage en plus (ouvertures réduites) : ${fmtNb(m.gain, 2)} m²`);
  if (m.zone) l.push(`Zone de travaux (seule partie comptée) : ${texteZone(m.zone)} = ${fmtNb(m.brut, 2)} m² · bâtiment entier ${fmtNb(m.entier, 2)} m² pour info`);
  if (m.surfaces.length) l.push(`Surface nette${m.zone ? ' de la zone' : ''}${m.gain > 0 ? ' après travaux' : ''} : ${fmtNb(m.net, 2)} m²`);
  if (m.toiture) l.push(`Surface de toiture : ${fmtNb(m.toiture, 2)} m²`);
  for (const [a, b] of R.lineaires) l.push(`${a} : ${b}`);
  if (R.mode === 'saisie') for (const a of R.alertes) l.push(`⚠ ${a}`);
  const q = quantitesReleve(m);
  if (q.length) { l.push('', `${NOMS_OUVRAGES[R.ouvrage]} :`); for (const [a, b] of q) l.push(`- ${a} : ${b}`); }
  const tr = travauxReleve();
  if (tr.length) { l.push('', 'Travaux demandés :'); for (const [a, b] of tr) l.push(`- ${a}${b ? ` : ${b}` : ''}`); }
  if (R.compris) l.push('', `Ce que veut le client : ${R.compris}`);
  return l.join('\n');
}

// Travaux en plus retenus depuis la dictée (dépose, empoutrement, gouttières…) : [libellé, quantité].
function travauxReleve() {
  return (R.travaux || []).map((t) => [t.libelle, t.quantite > 0 ? `${fmtNb(t.quantite, 2)} ${t.unite || ''}`.trim() : (t.unite ? `? ${t.unite}` : '')]);
}

// ---------- Feuille de relevé (2 pages : esquisse cotée + photo cotée) ----------
function bandeauFeuille(ctx, W, titre) {
  ctx.fillStyle = '#23376d';
  ctx.fillRect(0, 0, W, 150);
  ctx.fillStyle = '#d5ac83';
  ctx.fillRect(0, 150, W, 6);
  ctx.fillStyle = '#fff';
  ctx.font = '800 50px -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('CHARPENTE du Léon', 60, 78);
  ctx.fillStyle = '#e9d9c6';
  ctx.font = '500 32px -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(titre, 60, 124);
  ctx.textAlign = 'right';
  ctx.fillText(new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }), W - 60, 124);
  ctx.textAlign = 'left';
}

function piedFeuille(ctx, W, H, texte) {
  ctx.fillStyle = '#f2f3f7';
  ctx.fillRect(0, H - 90, W, 90);
  ctx.fillStyle = '#55596a';
  ctx.font = '400 26px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(texte, 60, H - 38);
}

function coteSurPlan(ctx, A, B, texte, mesuree, f = 1, inconnu = false) {
  const ang = Math.atan2(B.y - A.y, B.x - A.x);
  ctx.save();
  ctx.strokeStyle = inconnu ? '#d63c2f' : '#23376d';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 3 * f;
  ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
  for (const [P, sens] of [[A, 1], [B, -1]]) {
    ctx.beginPath();
    ctx.moveTo(P.x, P.y);
    ctx.lineTo(P.x + sens * 22 * f * Math.cos(ang - 0.35), P.y + sens * 22 * f * Math.sin(ang - 0.35));
    ctx.lineTo(P.x + sens * 22 * f * Math.cos(ang + 0.35), P.y + sens * 22 * f * Math.sin(ang + 0.35));
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(P.x - 16 * f * Math.cos(ang + Math.PI / 2), P.y - 16 * f * Math.sin(ang + Math.PI / 2));
    ctx.lineTo(P.x + 16 * f * Math.cos(ang + Math.PI / 2), P.y + 16 * f * Math.sin(ang + Math.PI / 2));
    ctx.stroke();
  }
  // Texte posé sur la cote, dans le sens de lecture.
  let a = ang;
  if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
  ctx.translate((A.x + B.x) / 2, (A.y + B.y) / 2);
  ctx.rotate(a);
  ctx.font = `700 ${30 * f}px -apple-system, "Segoe UI", sans-serif`;
  const l = ctx.measureText(texte).width + 22 * f;
  ctx.fillStyle = inconnu ? '#fde8e6' : mesuree ? '#fff4dc' : '#fff';
  ctx.strokeStyle = inconnu ? '#d63c2f' : mesuree ? '#b8956b' : '#c7cbd6';
  ctx.lineWidth = 2 * f;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-l / 2, -21 * f, l, 42 * f, 21 * f); else ctx.rect(-l / 2, -21 * f, l, 42 * f);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = inconnu ? '#d63c2f' : '#23376d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(texte, 0, 1);
  ctx.restore();
}

function motifBardage(ctx) {
  const m = document.createElement('canvas');
  m.width = 18; m.height = 18;
  const c = m.getContext('2d');
  c.fillStyle = '#eef1f6'; c.fillRect(0, 0, 18, 18);
  c.fillStyle = '#b9c2d3'; c.fillRect(0, 0, 2, 18);
  return ctx.createPattern(m, 'repeat');
}

function pageEsquisse(s, m) {
  const W = 2400, H = 1700;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const chantier = $('#releve-chantier').value;
  const facade = $('#releve-facade').value.trim();
  bandeauFeuille(ctx, W, `Relevé de mesures${chantier ? ` · ${chantier}` : ''}${facade ? ` · ${facade}` : ''}`);

  dessinerPlan(ctx, { x: 60, y: 200, w: 1500, h: 1380 }, s, 1);

  // Colonne de droite : mesures, surfaces, quantités.
  let y = 230;
  const X = 1640, XD = W - 60;
  const titre = (t) => {
    ctx.fillStyle = '#b8956b'; ctx.font = '800 26px -apple-system, "Segoe UI", sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(t.toUpperCase(), X, y); y += 18;
    ctx.fillStyle = '#e3e3e8'; ctx.fillRect(X, y, XD - X, 2); y += 40;
  };
  const ligne = (a, b, gras = false) => {
    if (y > H - 130) return;
    ctx.font = `700 28px -apple-system, "Segoe UI", sans-serif`;
    const largeurB = ctx.measureText(b).width;
    ctx.fillStyle = '#1c1c1e'; ctx.font = `${gras ? 700 : 400} 28px -apple-system, "Segoe UI", sans-serif`; ctx.textAlign = 'left';
    // Valeur longue (ex. la référence du bac) : elle passe sur la ligne d'en dessous au lieu de chevaucher le libellé.
    const surDeuxLignes = ctx.measureText(a).width + largeurB + 30 > XD - X;
    let texteA = a;
    while (ctx.measureText(texteA).width > (surDeuxLignes ? XD - X : 470) && texteA.length > 4) texteA = texteA.slice(0, -2);
    ctx.fillText(texteA === a ? a : `${texteA}…`, X, y);
    if (surDeuxLignes) y += 38;
    ctx.font = `700 ${largeurB > XD - X ? 22 : 28}px -apple-system, "Segoe UI", sans-serif`; ctx.textAlign = 'right'; ctx.fillStyle = '#23376d';
    ctx.fillText(b, XD, y); y += 44;
  };
  titre('Cotes');
  m.cotes.forEach((e, i) => ligne(`${e.lettre ? `${e.lettre} · ` : ''}${e.nom || `Cote ${i + 1}`}${e.valeur > 0 ? ' ✓' : e.suppose ? ' (supposé)' : ''}`, `${texteValeur(e, s).replace(' ✓', '').replace('≈ ', '')} m`));
  if (m.surfaces.length || m.ouvertures.length) {
    y += 16; titre('Surfaces');
    for (const e of [...m.surfaces, ...m.ouvertures]) ligne(nomElement(e), `${e.type === 'ouverture' ? '− ' : ''}${fmtNb(aireAff(e, s), 2)} m²${e.projetH > 0 ? ' après travaux' : ''}`);
    if (m.gain > 0) ligne('Bardage en plus (ouvertures réduites)', `+ ${fmtNb(m.gain, 2)} m²`);
    if (m.zone) ligne('Bâtiment entier (non compté)', `${fmtNb(m.entier, 2)} m²`);
    if (m.surfaces.length) ligne(`Surface nette${m.zone ? ' de la zone' : ''}${m.gain > 0 ? ' après travaux' : ''}`, `${fmtNb(m.net, 2)} m²`, true);
  }
  if (m.zone) {
    y += 16; titre('Partie traitée');
    ligne('Largeur', `${fmtM(m.zone.xb - m.zone.xa)} m`);
    ligne(`Depuis le coin ${R.zone.depuis === 'droite' ? 'droit' : 'gauche'}`, `${fmtM(m.zone.de)} → ${fmtM(m.zone.a)} m`);
    ligne('Hauteur depuis le sol', `${fmtM(m.zone.sol - m.zone.yb)} → ${fmtM(m.zone.sol - m.zone.ya)} m`);
  }
  if (R.lineaires.length || m.toiture) {
    y += 16; titre(R.mode === 'saisie' ? 'Toiture et linéaires' : 'Calculé d\'après la photo');
    if (m.toiture) ligne('Surface de toiture', `${fmtNb(m.toiture, 2)} m²`);
    for (const [a, b] of R.lineaires) ligne(a, b);
  }
  const q = quantitesReleve(m);
  if (q.length) { y += 16; titre(NOMS_OUVRAGES[R.ouvrage]); for (const [a, b] of q) ligne(a, b); }
  const tr = travauxReleve();
  if (tr.length) { y += 16; titre('Travaux demandés'); for (const [a, b] of tr) ligne(a, b); }

  piedFeuille(ctx, W, H, R.mode === 'saisie'
    ? `✓ = mesuré sur place · autres cotes calculées par l'appli${R.alertes.length ? ' · ⚠ certaines mesures ne collent pas entre elles, à revérifier' : ''} · à confirmer avant commande`
    : s.perspective
      ? `✓ = mesuré sur place · autres cotes calculées sur la photo, perspective redressée${s.controles ? ` (contrôle : écart max ${fmtNb(s.ecart * 100, 1)} %)` : ''} · à confirmer avant commande`
      : `✓ = mesuré sur place · autres cotes calculées sur la photo (échelle sur ${s.refs} mesure${s.refs > 1 ? 's' : ''}${s.refs >= 3 ? `, écart max ${fmtNb(s.ecart * 100, 1)} %` : ''}) · à confirmer avant commande`);
  return c.toDataURL('image/jpeg', 0.86);
}

// Dessin propre (esquisse cotée) dans une zone du canevas : sert à la feuille et à l'aperçu de la saisie.
// f grossit les traits et les textes (aperçu sur le téléphone).
function dessinerPlan(ctx, zone, s, f = 1) {
  const tous = R.elements.flatMap((e) => (e.type === 'cote' ? [e.a, e.b] : e.pts)).map((p) => versM(p, s));
  if (!tous.length) return;
  const minX = Math.min(...tous.map((p) => p.x)), maxX = Math.max(...tous.map((p) => p.x));
  const minY = Math.min(...tous.map((p) => p.y)), maxY = Math.max(...tous.map((p) => p.y));
  const k = Math.min((zone.w - 130 * f) / Math.max(maxX - minX, 0.01), (zone.h - 90 * f) / Math.max(maxY - minY, 0.01));
  const ox = zone.x + (zone.w - (maxX - minX) * k) / 2, oy = zone.y + (zone.h - (maxY - minY) * k) / 2;
  const P = (p) => { const m = versM(p, s); return { x: ox + (m.x - minX) * k, y: oy + (m.y - minY) * k }; };
  const P2 = (xm, ym) => ({ x: ox + (xm - minX) * k, y: oy + (ym - minY) * k }); // point déjà en mètres

  const motif = motifBardage(ctx);
  for (const type of ['surface', 'ouverture']) {
    for (const e of R.elements.filter((x) => x.type === type)) {
      ctx.save();
      ctx.beginPath();
      e.pts.map(P).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = type === 'ouverture' ? '#fff' : motif;
      ctx.fill();
      ctx.strokeStyle = '#23376d';
      ctx.lineWidth = (type === 'ouverture' ? 3 : 5) * f;
      if (type === 'ouverture') ctx.setLineDash([16 * f, 10 * f]);
      ctx.stroke();
      ctx.restore();
      // Projet : la partie de l'ouverture qui sera bardée (au-dessus de la nouvelle hauteur) est hachurée en vert.
      if (type === 'ouverture' && e.projetH > 0) {
        const { x0, x1, sol } = etenduePied(e, s);
        const a = P2(x0, sol - e.projetH), b = P2(x1, sol);
        ctx.save();
        ctx.beginPath();
        e.pts.map(P).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = 'rgba(31,157,85,.18)';
        ctx.fillRect(a.x - 2, 0, b.x - a.x + 4, a.y);
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = '#1f9d55';
        ctx.lineWidth = 4 * f;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y); ctx.stroke();
        ctx.fillStyle = '#1f9d55';
        ctx.font = `700 ${22 * f}px -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`bardage jusqu'à ${fmtM(e.projetH)} m du sol`, (a.x + b.x) / 2, a.y - 6 * f);
        ctx.restore();
      }
    }
  }
  // Zone de travaux : le reste du bâtiment est voilé de blanc, la zone entourée en orange avec ses mesures.
  const r = rectZone(s);
  if (r) {
    const a = P2(r.xa, r.ya), b = P2(r.xb, r.yb);
    ctx.save();
    ctx.beginPath();
    for (const e of R.elements.filter((x) => x.type === 'surface')) {
      e.pts.map(P).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    }
    ctx.clip();
    ctx.beginPath();
    ctx.rect(zone.x, zone.y, zone.w, zone.h);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.fill('evenodd');
    ctx.fillStyle = 'rgba(232,131,58,.10)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#e8833a';
    ctx.lineWidth = 6 * f;
    ctx.setLineDash([22 * f, 10 * f]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
    const aireZone = R.elements.filter((x) => x.type === 'surface').reduce((t, e) => t + aireSurface(e, s, r), 0);
    const texte = `Zone de travaux · ${fmtM(r.xb - r.xa)} m · ${fmtNb(aireZone, 2)} m²`;
    ctx.font = `800 ${26 * f}px -apple-system, "Segoe UI", sans-serif`;
    const l = ctx.measureText(texte).width + 24 * f;
    // Pastille en haut, à l'intérieur de la zone (les cotes du bâtiment sont autour, à l'extérieur).
    const cx = Math.min(Math.max((a.x + b.x) / 2, zone.x + l / 2), zone.x + zone.w - l / 2);
    const cy = a.y + 30 * f;
    ctx.fillStyle = '#e8833a';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx - l / 2, cy - 20 * f, l, 40 * f, 20 * f); else ctx.rect(cx - l / 2, cy - 20 * f, l, 40 * f);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(texte, cx, cy + 1);
    ctx.restore();
  }

  const complet = !R.incomplet.length;
  // Avec une zone, la surface est écrite dans la pastille de la zone : pas d'étiquette dans la partie grisée.
  for (const e of R.elements.filter((x) => x.type !== 'cote' && !(r && x.type === 'surface'))) {
    const cc = P(pointEtiquette(e));
    ctx.fillStyle = e.type === 'ouverture' ? '#a33a2f' : '#23376d';
    ctx.font = `600 ${28 * f}px -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Petite ouverture (le nom ne tient pas dedans) : surface seule, le nom est dans le tableau.
    const xs = e.pts.map((p) => versM(p, s).x);
    const largeurPx = (Math.max(...xs) - Math.min(...xs)) * k;
    if (e.type === 'ouverture' && largeurPx < ctx.measureText(nomElement(e)).width + 10 * f) {
      ctx.font = `400 ${22 * f}px -apple-system, "Segoe UI", sans-serif`;
      ctx.fillText(complet && !e.inconnu ? `− ${fmtNb(aireAff(e, s), 2)}` : '?', cc.x, cc.y);
      continue;
    }
    ctx.fillText(nomElement(e), cc.x, cc.y - 18 * f);
    ctx.font = `400 ${26 * f}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(complet && !e.inconnu ? `${e.type === 'ouverture' ? '− ' : ''}${fmtNb(aireAff(e, s), 2)} m²${e.projetH > 0 ? ' après travaux' : ''}` : '? m²', cc.x, cc.y + 18 * f);
  }
  for (const e of R.elements.filter((x) => x.type === 'cote')) {
    coteSurPlan(ctx, P(e.a), P(e.b), `${e.lettre ? `${e.lettre} ` : ''}${e.nom && !e.court ? `${e.nom} ` : ''}${texteValeur(e, s)}`, e.valeur > 0, f, e.inconnu);
  }
}

function pagePhoto(s) {
  const W = 2400, H = 1700;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const chantier = $('#releve-chantier').value;
  const saisie = R.mode === 'saisie';
  bandeauFeuille(ctx, W, `${saisie ? 'Photo' : 'Photo cotée'}${chantier ? ` · ${chantier}` : ''}`);
  const tmp = document.createElement('canvas');
  tmp.width = R.img.width; tmp.height = R.img.height;
  const t = tmp.getContext('2d');
  t.drawImage(R.img, 0, 0);
  if (!saisie) dessinerReleveSur(t, epReleve(tmp), s);
  const zone = { x: 60, y: 190, w: W - 120, h: H - 190 - 120 };
  const k = Math.min(zone.w / tmp.width, zone.h / tmp.height);
  const w = tmp.width * k, h = tmp.height * k;
  ctx.drawImage(tmp, zone.x + (zone.w - w) / 2, zone.y + (zone.h - h) / 2, w, h);
  piedFeuille(ctx, W, H, saisie ? 'Photo prise sur place' : 'Jaune ✓ : mesuré sur place · blanc ≈ : calculé sur la photo · bleu : surfaces · rouge : ouvertures déduites');
  return c.toDataURL('image/jpeg', 0.82);
}

function creerFeuille() {
  const s = echelleReleve();
  if (!s) { toast('Il faut au moins une cote mesurée sur place.', 'erreur'); return; }
  if (!R.elements.length) return;
  if (R.incomplet.length) { toast(`Il manque : ${R.incomplet.join(', ')}.`, 'erreur'); return; }
  R.feuilles = [pageEsquisse(s, metreReleve(s)), ...(R.img ? [pagePhoto(s)] : [])];
  $('#feuille-pages').replaceChildren(...R.feuilles.map((d, i) => el('img', { src: d, alt: `Page ${i + 1} de la feuille de relevé` })));
  $('#feuille-ranger').disabled = false;
  afficher('feuille');
}

async function rangerFeuille() {
  const chantier = $('#releve-chantier').value;
  if (!chantier) { toast('Choisis le chantier en bas du relevé.', 'erreur'); afficher('releve'); return; }
  $('#feuille-ranger').disabled = true;
  const commun = { action: 'chantier', docId: nouvelId(), date: new Date().toISOString(), total: R.feuilles.length, type: '', chantier,
    note: 'Relevé de mesures', rubrique: '01 Plans', prefixe: 'Releve' };
  const envois = R.feuilles.map((d, i) => ({ ...commun, page: i + 1, fichier: { mime: 'image/jpeg', data: d.split(',')[1] } }));
  envoyerPhotoReleve(); // la photo d'origine aussi, si elle n'est pas déjà partie
  // Les données du relevé partent aussi : on pourra le rouvrir et le corriger (sur le PC par exemple).
  envois.push(envoiSauverReleve(chantier));
  const { tousPartis } = await mettreEnFile(envois);
  brouillonEffacer(); // la feuille est rangée (ou dans la file d'envoi) : plus besoin de rouvrir ce relevé au démarrage
  toast(tousPartis ? `Relevé rangé dans ${chantier} ✅` : 'Pas de réseau : le relevé partira tout seul.', tousPartis ? 'ok' : '');
  if (R.depuisRdv && V.actif) {
    V.releves.push(texteMetre());
    sauverRdv();
    R.depuisRdv = false;
    R.actif = false;
    ouvrirRdv();
  }
}

// Données complètes du relevé, rangées dans « 01 Plans/Relevés (données) » : retravaillable depuis la fiche du chantier.
function envoiSauverReleve(chantier) {
  const s = echelleReleve(), m = s ? metreReleve(s) : {};
  const facade = $('#releve-facade').value.trim();
  return { action: 'sauverReleve', id: R.id, chantier, date: Date.now(),
    titre: facade || (R.mode === 'saisie' ? NOMS_GABARITS[R.gabarit.type] || 'Relevé' : 'Relevé sur photo'),
    resume: [NOMS_OUVRAGES[R.ouvrage], m.brut ? `${fmtNb(m.net, 2)} m² nets` : '', m.zone ? 'zone de travaux' : '',
      R.incomplet?.length ? 'à compléter' : ''].filter(Boolean).join(' · '),
    releve: { ...etatReleve(), chantier, depuisRdv: false } };
}

// « 💾 Enregistrer » (demande de Jean-Phi) : le relevé est gardé dans le chantier tel quel, même incomplet, et se
// reprend quand il veut (fiche du chantier › Relevés à reprendre), sur l'iPhone ou le PC. Le brouillon local reste.
async function enregistrerReleve(quitter = true) {
  const chantier = $('#releve-chantier').value;
  if (!chantier) {
    toast('Choisis d\'abord le chantier (en bas) pour l\'y enregistrer.', 'erreur');
    $('#releve-chantier').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#releve-chantier').focus();
    return false;
  }
  await sauverBrouillonMaintenant();
  envoyerPhotoReleve();
  const { tousPartis } = await mettreEnFile([envoiSauverReleve(chantier)]);
  const titre = $('#releve-facade').value.trim() || NOMS_GABARITS[R.gabarit.type] || 'Relevé';
  if (R.depuisRdv && V.actif) {
    const ligne = `${titre} (enregistré, à reprendre) : ${texteMetre().split('\n')[0] || ''}`;
    V.releves = [...(V.releves || []).filter((x) => !String(x).startsWith(`${titre} (enregistré`)), ligne];
    sauverRdv();
  }
  toast(tousPartis ? `💾 « ${titre} » enregistré dans ${chantier} · fiche › Relevés à reprendre` : '💾 Gardé sur l\'appareil : il partira dans le chantier dès que le réseau revient.', tousPartis ? 'ok' : '');
  if (!quitter) return true;
  if (R.depuisRdv && V.actif) { ouvrirRdv(); return true; }
  ouvrirOnglet('accueil');
  majBoutonReleve();
  return true;
}

// « ➕ Ajouter un autre mur ou pignon » : on enregistre celui-ci, puis on choisit le suivant (avec photo, forme
// toute faite — celle qu'on vient de faire est proposée en premier — ou forme à créer). Même chantier, même ouvrage.
async function autreMur() {
  const chantier = $('#releve-chantier').value;
  const enCours = R.elements.length || Object.values(R.gabarit.saisis).some(Boolean);
  if (enCours && chantier && !(await enregistrerReleve(false))) return;
  if (enCours && !chantier && !confirm('Ce relevé n\'a pas de chantier : il reste seulement sur l\'appareil et sera remplacé. Continuer ?')) return;
  const actuelle = formeReleve();
  const suite = { chantier, depuisRdv: R.depuisRdv, ouvrage: R.ouvrage, params: R.params };
  const fermer = () => fond.remove();
  const lancer = async (type) => {
    fermer();
    await demarrerReleve({ ...suite, mode: 'saisie', id: nouvelId(), facade: '',
      gabarit: { type, saisis: {}, ouvertures: [], avecOuvertures: false, points: type === 'libre' ? [{ x: '', h: '' }] : [] } });
    sauverBrouillonReleve();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => $('#releve-facade').focus(), 300);
    toast('Nouveau mur : donne-lui un nom (ex. « Pignon est ») puis tape tes mesures.', 'ok');
  };
  const photo = (galerie) => {
    fermer();
    R.suiteAutreMur = suite;
    $(galerie ? '#releve-galerie-input' : '#releve-input').click();
    if (!galerie) activerBoussole();
  };
  const ordre = [actuelle, ...['pignon', 'mur', 'appentis', 'pan'].filter((t) => t !== actuelle && t !== 'libre')];
  const dessins = { pignon: '⌂', appentis: '◺', mur: '▭', pan: '▱', libre: '✏️' };
  const formes = ordre.filter((t) => t !== 'libre').map((t) => el('button', { class: `forme-choix${t === actuelle ? ' conseille' : ''}`, type: 'button', onclick: () => lancer(t) },
    el('span', { class: 'forme-dessin' }, dessins[t]), el('b', {}, NOMS_GABARITS[t]), t === actuelle ? el('small', {}, 'comme celui-ci') : ''));
  const fond = el('div', { class: 'modale-fond', onclick: (ev) => { if (ev.target === fond) fermer(); } },
    el('div', { class: 'modale autre-mur', role: 'dialog', 'aria-label': 'Ajouter un autre mur' },
      el('h2', {}, '➕ Mur ou pignon suivant'),
      chantier ? el('p', { class: 'discret petit-texte' }, `Le relevé précédent est enregistré dans ${chantier}.`) : '',
      el('p', { class: 'etiquette' }, 'Avec une photo'),
      el('div', { class: 'deux-boutons' },
        el('button', { class: 'btn secondaire', type: 'button', onclick: () => photo(false) }, '📷 Prendre une photo'),
        el('button', { class: 'btn secondaire', type: 'button', onclick: () => photo(true) }, '🖼️ De ma galerie')),
      el('p', { class: 'etiquette' }, 'Sans photo : choisis la forme'),
      el('div', { class: 'formes-grille' }, ...formes,
        el('button', { class: `forme-choix${actuelle === 'libre' ? ' conseille' : ''}`, type: 'button', onclick: () => lancer('libre') },
          el('span', { class: 'forme-dessin' }, dessins.libre), el('b', {}, 'Forme à créer'), el('small', {}, actuelle === 'libre' ? 'comme celui-ci' : 'point par point'))),
      el('button', { class: 'lien', type: 'button', onclick: fermer }, 'Annuler')));
  document.body.append(fond);
}

// La photo du relevé est gardée dans le chantier (« 04 Photos ») dès que le chantier est connu : pas besoin d'y retourner.
function envoyerPhotoReleve() {
  const chantier = $('#releve-chantier').value;
  if (!R.photo || R.photoEnvoyee || !chantier) return;
  R.photoEnvoyee = true;
  mettreEnFile([{ action: 'chantier', docId: nouvelId(), date: new Date().toISOString(), total: 1, page: 1, type: '', chantier,
    note: 'Photo du relevé', fichier: { mime: 'image/jpeg', data: R.photo.split(',')[1] } }]);
}

// ===================== Rendez-vous client =====================
// Point de départ d'une visite : le client, puis photos, mesures, notes papier et dictée, tout rangé au fur et à
// mesure dans le chantier. « Préparer le devis » envoie le compte rendu ; l'assistant prépare le brouillon ProGBat.
const TRAVAUX = ['Charpente neuve', 'Rénovation charpente', 'Couverture', 'Désamiantage', 'Bardage', 'Ossature bois',
  'Extension', 'Zinguerie', 'Isolation', 'Menuiseries / Velux', 'Terrasse / carport', 'Autre'];
const V = { actif: false };

function rdvVide(ev = null) {
  return { actif: true, debut: Date.now(), type: 'nouveau', chantier: '', nom: ev?.titre || '', client: '', tel: '', adresse: ev?.lieu || '',
    email: '', travaux: [], dictee: '', budget: '', delai: '', photos: 0, notes: 0, releves: [], chantierEnvoye: false, evenement: ev?.titre || '' };
}

function sauverRdv() { if (V.actif) { V.maj = Date.now(); ecrireJson('rdv-en-cours', { ...V }); } }

// Abandonner : le rendez-vous n'est plus rouvert ; ce qui est déjà parti (photos, notes, relevés) reste dans le chantier.
function abandonnerRdv() {
  if (!confirm('Abandonner ce rendez-vous ?\nLes photos, notes et relevés déjà envoyés restent dans le chantier. Aucun devis ne sera préparé.')) return;
  V.actif = false;
  ecrireJson('rdv-en-cours', null);
  ouvrirOnglet('accueil');
  toast('Rendez-vous abandonné', 'ok');
}

// Accueil : un rendez-vous commencé se reprend par le bouton du haut.
function majBoutonRdv() {
  const rdv = lireJson('rdv-en-cours', null);
  const enCours = !!rdv?.actif;
  const b = $('#btn-rdv');
  b.querySelector('.titre').textContent = enCours ? 'Reprendre le rendez-vous' : 'Rendez-vous client';
  b.querySelector('.sous-titre').textContent = enCours
    ? `${rdv.nom || rdv.chantier || 'Client'} · commencé à ${new Date(rdv.debut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : 'Client, photos, mesures, notes : tout pour le devis';
}

function demarrerRdv(ev = null) {
  const enCours = lireJson('rdv-en-cours', null);
  if (enCours?.actif && !ev && !confirm('Un rendez-vous est déjà en cours. Le reprendre ?\n(Annuler = en commencer un nouveau)')) {
    Object.assign(V, rdvVide(ev));
  } else if (enCours?.actif && !ev) {
    Object.assign(V, enCours);
  } else {
    Object.assign(V, rdvVide(ev));
    // Rendez-vous de l'agenda : on cherche si le chantier existe déjà.
    if (ev) {
      const titre = normaliser(ev.titre);
      const c = listeChantiers().find((x) => titre.includes(normaliser(x.nom)) || normaliser(x.nom).includes(titre));
      if (c) { V.type = 'existant'; V.chantier = c.nom; }
    }
  }
  sauverRdv();
  ouvrirRdv();
}

let rdvListeRelue = 0;
// Fiche complète (avec les vignettes) du chantier choisi dans le rendez-vous, gardée en mémoire seulement.
let rdvFiche = null, rdvFicheEnCours = '';
function chargerFicheRdv(nom) {
  if (rdvFicheEnCours === nom || !navigator.onLine || !reglages.ok()) return;
  rdvFicheEnCours = nom;
  const zone = $('#rdv-deja');
  zone.classList.remove('cache');
  zone.replaceChildren(el('p', { class: 'discret' }, '⏳ Je regarde ce que le chantier contient déjà…'));
  appelServeur({ action: 'fiche', chantier: nom }, 60000).then((r) => {
    rdvFiche = r.fiche;
    const { rubriques, ...reste } = r.fiche;
    ecrireJson(`fiche:${nom}`, { ...reste, rubriques: rubriques.map(({ vignettes, ...x }) => x) });
  }).catch((e) => {
    if (V.chantier === nom) zone.replaceChildren(el('p', { class: 'discret' }, `Contenu du chantier indisponible : ${e.message}`));
  }).finally(() => {
    rdvFicheEnCours = '';
    if (ecranCourant === 'rdv' && V.chantier === nom) { dessinerDejaRdv(); majRdv(); }
  });
}

function dessinerDejaRdv() {
  const zone = $('#rdv-deja');
  const f = V.type === 'existant' && rdvFiche?.nom === V.chantier ? rdvFiche : null;
  if (!f) { if (!rdvFicheEnCours) zone.classList.add('cache'); return; }
  const rub = (t) => f.rubriques.find((r) => r.titre === t) || { total: 0, fichiers: [] };
  const photos = rub('Photos');
  const notes = rub('Devis & contrat').fichiers.filter((x) => /^Notes-RDV|^\d{4}-\d{2}-\d{2}.*\.(jpe?g|png|pdf)$/i.test(x.nom) || x.type?.startsWith('image/'));
  const blocs = [el('h3', {}, '📂 Déjà dans ce chantier'),
    el('button', { class: 'photos-gros principal', type: 'button', onclick: () => ouvrirPhotos(f.nom, ouvrirRdv) },
      el('span', {}, '📷'), `Photos du chantier (${photos.total}) : prendre, galerie, mesurer`)];
  if (photos.vignettes?.length) {
    blocs.push(grillePhotos(f, true));
    blocs.push(el('p', { class: 'discret aide-mesurer' }, 'Touche une photo pour mesurer dessus ou la voir en grand.'));
  }
  if (notes.length) blocs.push(el('div', { class: 'deja-liste' }, el('small', { class: 'etiquette' }, '📝 Notes et documents'), ...notes.slice(0, 6).map(lienFichier)));
  if (f.releves?.length) {
    blocs.push(el('div', { class: 'deja-liste' }, el('small', { class: 'etiquette' }, '📏 Relevés à reprendre'), ...f.releves.map((r) => {
      const b = el('button', { class: 'fichier', type: 'button' }, el('span', {}, '📏'), el('span', { class: 'fichier-texte' }, el('span', {}, r.titre), el('small', {}, r.resume || '')), el('span', { class: 'ouvrir' }, 'Ouvrir ›'));
      b.onclick = () => ouvrirReleveSauve(f.nom, r.id, b, true);
      return b;
    })));
  }
  const plans = rub('Plans').fichiers.filter((x) => !/^Releve/i.test(x.nom) || !f.releves?.length);
  if (plans.length) blocs.push(el('div', { class: 'deja-liste' }, el('small', { class: 'etiquette' }, '📐 Plans et feuilles de relevé'), ...plans.slice(0, 6).map(lienFichier)));
  zone.replaceChildren(...blocs);
  zone.classList.remove('cache');
}

function ouvrirRdv() {
  remplirSelectChantiers($('#rdv-chantier-select'), V.chantier, '— Choisir le chantier —');
  // La liste « Chantier existant » vient de l'appareil : on la recharge (au plus une fois par minute) pour y voir
  // aussi un chantier tout juste créé (cas de Le Gall, 09/11).
  if (Date.now() - rdvListeRelue > 60000) {
    rdvListeRelue = Date.now();
    rafraichirChantiers().then(() => { if (ecranCourant === 'rdv') remplirSelectChantiers($('#rdv-chantier-select'), V.chantier, '— Choisir le chantier —'); });
  }
  for (const b of $$('#rdv-type [data-type]')) b.classList.toggle('active', b.dataset.type === V.type);
  $('#rdv-existant').classList.toggle('cache', V.type !== 'existant');
  $('#rdv-nouveau').classList.toggle('cache', V.type !== 'nouveau');
  // Chantier existant : on reprend ce que la fiche connaît déjà.
  const ficheRdv = V.type === 'existant' && V.chantier ? lireJson(`fiche:${V.chantier}`, null) : null;
  if (V.type === 'existant' && V.chantier) {
    const c = listeChantiers().find((x) => x.nom === V.chantier) || {};
    if (!V.client) V.client = c.client || ficheRdv?.client || '';
    if (!V.tel) V.tel = ficheRdv?.telephone || '';
    if (!V.adresse) V.adresse = ficheRdv?.adresse || '';
  }
  Object.assign(V, (({ client, tel }) => ({ client, tel }))(separerTelephone(V.client, V.tel)));
  for (const [id, cle] of [['#rdv-nom', 'nom'], ['#rdv-client', 'client'], ['#rdv-tel', 'tel'],
    ['#rdv-email', 'email'], ['#rdv-dictee', 'dictee'], ['#rdv-budget', 'budget'], ['#rdv-delai', 'delai']]) $(id).value = V[cle] || '';
  const a = separerAdresse(V.adresse);
  $('#rdv-adresse').value = a.rue; $('#rdv-cp').value = a.cp; $('#rdv-ville').value = a.ville;
  // Ce que le chantier contient déjà (photos, notes papier, relevés) : affiché dans le rendez-vous.
  $('#rdv-voir-fiche').classList.toggle('cache', !(V.type === 'existant' && V.chantier));
  dessinerDejaRdv();
  if (V.type === 'existant' && V.chantier && rdvFiche?.nom !== V.chantier) chargerFicheRdv(V.chantier);
  $('#rdv-travaux').replaceChildren(...TRAVAUX.map((t) => {
    const b = el('button', { class: `puce${V.travaux.includes(t) ? ' active' : ''}` }, t);
    b.onclick = () => {
      V.travaux = V.travaux.includes(t) ? V.travaux.filter((x) => x !== t) : [...V.travaux, t];
      b.classList.toggle('active');
      sauverRdv();
    };
    return b;
  }));
  majRdv();
  afficher('rdv');
}

const chantierRdv = () => (V.type === 'existant' ? V.chantier : V.nom.trim());

function majRdv() {
  $('#rdv-heure').textContent = `commencé à ${new Date(V.debut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const dejaPhotos = V.type === 'existant' && rdvFiche?.nom === V.chantier ? (rdvFiche.rubriques.find((r) => r.titre === 'Photos')?.total || 0) : 0;
  $('#rdv-compte-photos').textContent = [V.photos ? `${V.photos} aujourd'hui` : (dejaPhotos ? '' : 'aucune'), dejaPhotos ? `${dejaPhotos} déjà` : ''].filter(Boolean).join(' · ');
  $('#rdv-compte-notes').textContent = V.notes ? `${V.notes} page${V.notes > 1 ? 's' : ''}` : 'aucune';
  $('#rdv-compte-releves').textContent = V.releves.length ? `${V.releves.length} fait${V.releves.length > 1 ? 's' : ''}` : 'aucun';
  $('#rdv-releves').replaceChildren(...(V.releves.length
    ? V.releves.map((t) => el('li', {}, el('span', { class: 'releve-resume' }, t.split('\n').filter(Boolean).slice(1, 4).join(' · '))))
    : [el('li', { class: 'vide' }, 'Touche « Mesures » pour faire un relevé.')]));
  $('#rdv-terminer').disabled = !chantierRdv();
}

// Le chantier doit exister (dossier Drive) avant la première photo : on l'annonce une seule fois au serveur.
function assurerChantierRdv() {
  const nom = chantierRdv();
  if (!nom) {
    toast(V.type === 'existant' ? 'Choisis d\'abord le chantier.' : 'Tape d\'abord le nom du chantier (ex. Dupont Plouescat).', 'erreur');
    (V.type === 'existant' ? $('#rdv-chantier-select') : $('#rdv-nom')).focus();
    return null;
  }
  if (!V.chantierEnvoye) {
    const maj = { action: 'majChantier', chantier: nom, creer: true, client: V.client, telephone: V.tel, adresse: V.adresse, lat: V.lat, lon: V.lon };
    if (V.type === 'nouveau') maj.statut = 'Devis en attente';
    mettreEnFile([maj]);
    V.chantierEnvoye = true;
    if (V.type === 'nouveau' && !listeChantiers().some((c) => c.nom === nom)) {
      ecrireJson('chantiers', [...listeChantiers(), { nom, client: V.client, statut: 'Devis en attente' }]);
    }
    sauverRdv();
  }
  return nom;
}

// Photos ou notes déjà dans la galerie (prises avant le rendez-vous, ou envoyées par le client) : plusieurs d'un coup.
async function galerieRdv(fichiers, notesPapier) {
  if (!fichiers.length || !assurerChantierRdv()) return;
  if (fichiers.length > 1) toast(`${fichiers.length} ${notesPapier ? 'pages' : 'photos'} en cours d'envoi…`);
  for (const f of fichiers) await photoRdv(f, notesPapier, true);
  // Les photos ajoutées apparaissent dans « Déjà dans ce chantier » (avec « 📏 Mesurer »).
  if (V.type === 'existant' && V.chantier) { rdvFiche = null; chargerFicheRdv(V.chantier); }
}

async function photoRdv(fichier, notesPapier, depuisGalerie = false) {
  const chantier = assurerChantierRdv();
  if (!chantier || !fichier) return;
  try {
    const data = await traiterImage(fichier, notesPapier);
    // La boussole ne vaut que pour une photo prise à l'instant, pas pour une photo de la galerie.
    const facade = notesPapier || depuisGalerie ? '' : orientationFacade();
    const envoi = { action: 'chantier', docId: nouvelId(), date: new Date().toISOString(), total: 1, page: 1, type: '', chantier,
      note: notesPapier ? 'Notes papier du rendez-vous' : `Photo du rendez-vous${facade ? ` – ${facade}` : ''}`,
      fichier: { mime: 'image/jpeg', data: data.split(',')[1] } };
    if (notesPapier) Object.assign(envoi, { rubrique: '02 Devis & contrat', prefixe: 'Notes-RDV' });
    if (notesPapier) V.notes++; else V.photos++;
    sauverRdv();
    majRdv();
    const { tousPartis } = await mettreEnFile([envoi]);
    toast(tousPartis ? (notesPapier ? 'Notes rangées ✅' : 'Photo rangée ✅') : 'Gardée : elle partira dès qu\'il y aura du réseau.', tousPartis ? 'ok' : '');
  } catch (e) { toast(e.message, 'erreur'); }
}

function mesuresRdv() {
  const chantier = assurerChantierRdv();
  if (!chantier) return;
  R.actif = false;
  R.photo = '';
  R.img = null;
  R.elements = [];
  R.analyse = null;
  R.photoEnvoyee = false;
  R.depuisRdv = true;
  $('#releve-facade').value = '';
  ouvrirReleve(chantier);
}

let dicteeRdv = null;
function dicterRdv() {
  const zone = $('#rdv-dictee'), bouton = $('#rdv-micro');
  if (dicteeRdv) { dicteeRdv.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { zone.focus(); toast('Touche le micro 🎤 du clavier pour dicter.'); return; }
  try {
    const r = new SR();
    r.lang = 'fr-FR';
    r.interimResults = true;
    r.continuous = true;
    const debut = zone.value ? `${zone.value}\n` : '';
    r.onresult = (ev) => { zone.value = debut + [...ev.results].map((x) => x[0].transcript).join(' '); V.dictee = zone.value; };
    r.onerror = () => zone.focus();
    r.onend = () => { dicteeRdv = null; bouton.textContent = '🎤 Dicter'; V.dictee = zone.value; sauverRdv(); };
    r.start();
    dicteeRdv = r;
    bouton.textContent = '⏹ J\'ai fini';
  } catch { zone.focus(); toast('Touche le micro 🎤 du clavier pour dicter.'); }
}

function texteRdv() {
  const nom = chantierRdv();
  const l = [
    `Rendez-vous du ${new Date(V.debut).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}`,
    `Chantier : ${nom}${V.type === 'nouveau' ? ' (nouveau client)' : ''}`,
    `Client : ${V.client || '—'} · Tél. : ${V.tel || '—'} · E-mail : ${V.email || '—'}`,
    `Adresse : ${V.adresse || '—'}`,
    V.evenement ? `Rendez-vous de l'agenda : ${V.evenement}` : '',
    '',
    `Travaux : ${V.travaux.join(', ') || '—'}`,
    `Budget du client : ${V.budget || '—'} · Délai souhaité : ${V.delai || '—'}`,
    '',
    'Ce que veut le client (dictée de Jean-Phi, telle quelle) :',
    V.dictee || '—',
    '',
    `Photos : ${V.photos} (dans « 04 Photos ») · Notes papier : ${V.notes} page(s) (dans « 02 Devis & contrat », fichiers « Notes-RDV »)`,
  ];
  V.releves.forEach((t, i) => l.push('', `Relevé ${i + 1} :`, t));
  return l.filter((x) => x !== null).join('\n');
}

async function terminerRdv() {
  const nom = assurerChantierRdv();
  if (!nom) return;
  if (!V.dictee.trim() && !V.travaux.length && !V.releves.length && !V.notes &&
    !confirm('Rien n\'a été dicté, coché ou mesuré. Envoyer quand même ?')) return;
  const resume = `${nom} : ${V.travaux.join(', ') || 'travaux à préciser'}`;
  const majInfos = { action: 'majChantier', chantier: nom, creer: true, client: V.client, telephone: V.tel, adresse: V.adresse, lat: V.lat, lon: V.lon };
  const { tousPartis } = await mettreEnFile([majInfos,
    { action: 'visite', chantier: nom, texte: texteRdv(), resume, date: new Date(V.debut).toISOString() }]);
  V.actif = false;
  ecrireJson('rdv-en-cours', null);
  ouvrirOnglet('accueil');
  toast(tousPartis ? 'Rendez-vous envoyé ✅ Je prépare le brouillon du devis.' : 'Gardé : il partira dès qu\'il y aura du réseau.', tousPartis ? 'ok' : '');
}

async function partagerFeuille() {
  const fichiers = R.feuilles.map((d, i) => new File([deBase64(d.split(',')[1])], `Releve-${i + 1}.jpg`, { type: 'image/jpeg' }));
  if (navigator.canShare?.({ files: fichiers })) {
    try { await navigator.share({ files: fichiers, title: 'Relevé de mesures', text: texteMetre() }); } catch { /* partage annulé */ }
  } else toast('Partage indisponible sur cet appareil.', 'erreur');
}

async function copierMetre() {
  try { await navigator.clipboard.writeText(texteMetre()); toast('Métré copié 📋', 'ok'); } catch { toast('Copie impossible.', 'erreur'); }
}

// ===================== Recherche globale =====================
// Tout ce que le téléphone connaît déjà (marche sans réseau) : chantiers, clients, adresses, documents et notes
// des fiches ouvertes, choses à faire, rendez-vous. Sans accents ni majuscules, tous les mots doivent y être.
const sansAccent = (c) => (c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()[0] || c.toLowerCase());
const normaliser = (t) => [...String(t || '')].map(sansAccent).join('');
const motsDe = (t) => normaliser(t).split(/[\s,;'’]+/).filter((m) => m.length > 0);
const correspond = (texte, mots) => { const n = normaliser(texte); return mots.every((m) => n.includes(m)); };

// Met en évidence les mots trouvés (la normalisation garde un caractère pour un caractère).
function surligner(texte, mots) {
  texte = String(texte || '');
  const n = normaliser(texte);
  const marques = new Array(texte.length).fill(false);
  for (const m of mots) {
    let i = n.indexOf(m);
    while (i >= 0) { for (let k = i; k < i + m.length; k++) marques[k] = true; i = n.indexOf(m, i + m.length); }
  }
  const frag = document.createDocumentFragment();
  let i = 0;
  const chars = [...texte];
  // [...texte] et texte.length diffèrent pour les émojis : on travaille sur les caractères visibles.
  if (chars.length !== texte.length) { frag.append(texte); return frag; }
  while (i < chars.length) {
    let j = i;
    while (j < chars.length && marques[j] === marques[i]) j++;
    const morceau = chars.slice(i, j).join('');
    frag.append(marques[i] ? el('mark', {}, morceau) : morceau);
    i = j;
  }
  return frag;
}

function fichesEnCache() {
  return Object.keys(coffre).filter((k) => k.startsWith('fiche:')).map((k) => lireJson(k, null)).filter((f) => f && f.nom);
}

function ouvrirRecherche() {
  afficher('recherche');
  $('#recherche-texte').value = '';
  dessinerRecherche();
  // La recherche fouille la liste gardée sur l'appareil : on la recharge pour trouver aussi un chantier tout juste créé.
  rafraichirChantiers().then(() => { if (ecranCourant === 'recherche') dessinerRecherche(); });
  setTimeout(() => $('#recherche-texte').focus(), 50);
}

function noterRecherche(texte) {
  const t = texte.trim();
  if (t.length < 2) return;
  ecrireJson('recherches', [t, ...lireJson('recherches', []).filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 6));
}

function dessinerRecherche() {
  const zone = $('#recherche-resultats');
  const texte = $('#recherche-texte').value;
  const mots = motsDe(texte);
  const fiches = fichesEnCache();
  if (!mots.length) {
    const recentes = lireJson('recherches', []);
    zone.replaceChildren(
      recentes.length ? el('section', { class: 'carte' }, el('h2', {}, 'Recherches récentes'),
        el('div', { class: 'puces' }, ...recentes.map((r) => el('button', { class: 'puce', onclick: () => { $('#recherche-texte').value = r; dessinerRecherche(); } }, r)))) : null,
      el('p', { class: 'discret centre petit-texte' },
        `Cherche dans tes ${listeChantiers().length} chantiers, les choses à faire, l'agenda, et les documents et notes des ${fiches.length} fiches déjà ouvertes sur le téléphone. Marche sans réseau.`));
    return;
  }
  const groupes = [];
  const ficheDe = Object.fromEntries(fiches.map((f) => [f.nom, f]));

  const chantiers = listeChantiers().filter((c) => {
    const f = ficheDe[c.nom] || {};
    return correspond([c.nom, c.client, f.adresse, f.telephone, statutDe(c.statut)].join(' '), mots);
  }).slice(0, 12);
  if (chantiers.length) {
    groupes.push(['🏗️ Chantiers', chantiers.map((c) => {
      const f = ficheDe[c.nom] || {};
      const tel = (f.telephone || '').replace(/[^\d+]/g, '');
      return el('li', { class: `resultat ${classeStatut(c.statut)}` },
        el('button', { class: 'resultat-corps', onclick: () => { noterRecherche(texte); ouvrirFiche(c.nom); } },
          el('span', { class: 'avatar', style: `background:${couleurDe(c.nom)}` }, initiales(c.nom) || '🏗️'),
          el('span', { class: 'corps' }, el('div', { class: 'nom' }, surligner(c.nom, mots)),
            el('div', { class: 'info' }, surligner([c.client, f.adresse].filter(Boolean).join(' · ') || statutDe(c.statut), mots)))),
        tel ? el('a', { class: 'resultat-appel', href: `tel:${tel}`, 'aria-label': `Appeler ${c.client || c.nom}` }, '📞') : null);
    })]);
  }

  const docs = [];
  const notes = [];
  for (const f of fiches) {
    for (const r of f.rubriques || []) {
      for (const fi of r.fichiers || []) if (correspond(`${fi.nom} ${r.titre}`, mots)) docs.push({ ...fi, chantier: f.nom });
    }
    for (const n of f.notes || []) if (correspond(n.texte, mots)) notes.push({ ...n, chantier: f.nom });
  }
  if (docs.length) {
    docs.sort((a, b) => new Date(b.date) - new Date(a.date));
    groupes.push(['📄 Documents', docs.slice(0, 15).map((fi) => {
      const icone = fi.type === 'application/pdf' ? '📄' : fi.type?.startsWith('image/') ? '🖼️' : '📎';
      const date = fi.date ? new Date(fi.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      return el('li', { class: 'resultat' }, el('a', { class: 'resultat-corps', href: fi.url, target: '_blank', rel: 'noopener', onclick: () => noterRecherche(texte) },
        el('span', { class: 'resultat-ico' }, icone),
        el('span', { class: 'corps' }, el('div', { class: 'nom' }, surligner(fi.nom.replace(/^\d{4}-\d{2}-\d{2}[ _]/, ''), mots)),
          el('div', { class: 'info' }, [fi.chantier, date].filter(Boolean).join(' · ')))));
    })]);
  }
  if (notes.length) {
    groupes.push(['🎙️ Notes', notes.slice(0, 10).map((n) => el('li', { class: 'resultat' },
      el('button', { class: 'resultat-corps', onclick: () => { noterRecherche(texte); ouvrirFiche(n.chantier); } },
        el('span', { class: 'resultat-ico' }, n.type === 'Idée' ? '💡' : n.type === 'Info' ? 'ℹ️' : '✅'),
        el('span', { class: 'corps' }, el('div', { class: 'nom long' }, surligner(n.texte, mots)), el('div', { class: 'info' }, `${n.chantier} · ${n.date}`)))))]);
  }

  const taches = tachesAffichees().filter((t) => correspond(`${t.texte} ${t.chantier || ''}`, mots)).slice(0, 10);
  if (taches.length) {
    groupes.push(['✅ À faire', taches.map((t) => el('li', { class: 'resultat' },
      el('button', { class: 'resultat-corps', onclick: () => { noterRecherche(texte); ouvrirOnglet('taches'); } },
        el('span', { class: 'resultat-ico' }, '○'),
        el('span', { class: 'corps' }, el('div', { class: 'nom long' }, surligner(t.texte, mots)), el('div', { class: 'info' }, [t.chantier, t.date].filter(Boolean).join(' · ') || ' ')))))]);
  }

  const rdv = (lireJson('agenda', []) || []).filter((e) => correspond(`${e.titre} ${e.lieu || ''}`, mots)).slice(0, 8);
  if (rdv.length) {
    groupes.push(['📅 Rendez-vous', rdv.map((e) => el('li', { class: 'resultat' },
      el('div', { class: 'resultat-corps' }, el('span', { class: 'resultat-ico' }, '📅'),
        el('span', { class: 'corps' }, el('div', { class: 'nom' }, surligner(e.titre, mots)), el('div', { class: 'info' }, `${jourLisible(e.debut, e.journee)}${e.lieu ? ' · ' + e.lieu : ''}`)))))]);
  }

  if (!groupes.length) {
    zone.replaceChildren(el('p', { class: 'etat-vide' }, el('span', {}, '🔍'), `Rien trouvé pour « ${texte.trim()} ».`),
      el('p', { class: 'discret centre petit-texte' }, 'Les documents d\'un chantier sont cherchés une fois sa fiche ouverte sur le téléphone.'));
    return;
  }
  zone.replaceChildren(...groupes.map(([titre, lignes]) => el('section', { class: 'groupe-resultats' },
    el('h3', { class: 'titre-section' }, `${titre} · ${lignes.length}`), el('ul', { class: 'liste-cartes' }, ...lignes))));
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
  $('#bandeau-faceid strong').textContent = `🔒 Protège l'appli avec ${nomVerrou()}`;
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
    el('span', {}, '🔒'), `${nomVerrou()} à l'ouverture`,
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

// L'iPhone ne ferme presque jamais vraiment l'appli : il la remet sur la dernière page vue, sans rien relire, donc une
// nouvelle version n'était jamais prise (07/11). À chaque retour dans l'appli, on regarde la version publiée ; si elle
// est plus récente, on recharge tout de suite quand on est sur un écran de consultation, sinon dès qu'on y revient
// (jamais au milieu d'un relevé, d'un rendez-vous ou d'un document en cours).
const ECRANS_SANS_SAISIE = ['accueil', 'chantiers', 'fiche', 'taches', 'plus', 'recherche', 'point', 'rentabilite', 'calculs', 'equipe'];
let majVerifieeA = 0;
let versionEnAttente = null;
function versionPlusRecente(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
async function verifierNouvelleVersion() {
  if (!navigator.onLine || Date.now() - majVerifieeA < 60000) return;
  majVerifieeA = Date.now();
  try {
    const rep = await fetch(`index.html?maj=${Date.now()}`, { cache: 'no-store' });
    if (!rep.ok) return;
    const m = (await rep.text()).match(/name="version-appli" content="([^"]+)"/);
    if (m && versionPlusRecente(m[1], VERSION)) { versionEnAttente = m[1]; appliquerMiseAJourSiPossible(); }
  } catch { /* hors ligne : on verra au prochain retour */ }
}
function appliquerMiseAJourSiPossible() {
  if (!versionEnAttente || !demarree || securite.verrouillee || document.hidden) return;
  if (!ECRANS_SANS_SAISIE.includes(ecranCourant) || R.actif || envoiEnCours) return;
  const v = versionEnAttente;
  versionEnAttente = null;
  try { if (sessionStorage.getItem('maj-tentee') === v) return; sessionStorage.setItem('maj-tentee', v); } catch { /* rien */ }
  toast(`Mise à jour de l'appli (version ${v})…`, 'ok');
  sauverCoffre();
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {}).finally(() => setTimeout(() => location.reload(), 800));
}

// ===================== Branchements =====================
document.addEventListener('DOMContentLoaded', () => {
  // Juste après une mise à jour, l'iPhone peut garder l'ancienne page avec le nouveau code : des boutons manquent et
  // plus rien ne répond (bug du rendez-vous le 07/11). Dans ce cas, on recharge une fois pour tout reprendre à jour.
  const versionPage = document.querySelector('meta[name="version-appli"]')?.content;
  if (versionPage !== VERSION) {
    let dejaRecharge = false;
    try { dejaRecharge = sessionStorage.getItem('recharge-version') === VERSION; sessionStorage.setItem('recharge-version', VERSION); } catch { /* rien */ }
    if (!dejaRecharge) { location.reload(); return; }
  }
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
      else if (cible === 'photos') ouvrirPhotos();
      else if (cible === 'note') ouvrirNote();
      else if (cible === 'point') ouvrirPoint();
      else if (cible === 'reglages') ouvrirReglages();
      else if (cible === 'import') ouvrirImport();
      else if (cible === 'bienvenue') ouvrirBienvenue();
      else if (cible === 'calculs') { afficher('calculs'); calculerRampant(); }
      else if (cible === 'heures') ouvrirHeures();
      else if (cible === 'rentabilite') ouvrirRentabilite();
      else if (cible === 'releve') ouvrirReleve();
      else afficher(cible);
    };
  }
  $('#btn-deposer').onclick = () => nouveauDocument('depot');
  // Photos du chantier
  $('#btn-photos').onclick = () => ouvrirPhotos();
  $('#photos-retour').onclick = () => { $('#photos-choix').classList.add('cache'); if (P.retour) P.retour(); else ouvrirOnglet('accueil'); };
  $('#photos-chantier').onchange = (e) => { P.chantier = e.target.value; P.fiche = null; P.locales = []; $('#photos-gps').textContent = ''; dessinerPhotos(); if (P.chantier) chargerPhotos(P.chantier); };
  $('#photos-prendre').onclick = () => { $('#photos-prendre-input').click(); activerBoussole(); };
  $('#photos-galerie').onclick = () => $('#photos-galerie-input').click();
  $('#photos-notes').onclick = () => $('#photos-notes-input').click();
  $('#photos-prendre-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; envoyerPhotosChantier(f, false, false); };
  $('#photos-galerie-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; envoyerPhotosChantier(f, false, true); };
  $('#photos-notes-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; envoyerPhotosChantier(f, true, false); };
  $('#photos-choix-fermer').onclick = () => $('#photos-choix').classList.add('cache');
  $('#photos-choix').onclick = (e) => { if (e.target.id === 'photos-choix') e.currentTarget.classList.add('cache'); };
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

  // Dessiner sur une photo
  const toile = $('#annot-canvas');
  toile.onpointerdown = annotDebut;
  toile.onpointermove = annotMouvement;
  toile.onpointerup = annotFin;
  toile.onpointercancel = () => { annot.enCours = null; redessinerAnnotation(); };
  for (const b of $$('#annot-outils [data-outil]')) b.onclick = () => choisirOutil(b.dataset.outil);
  for (const b of $$('#annot-couleurs [data-couleur]')) b.onclick = () => choisirCouleur(b.dataset.couleur);
  choisirOutil(lire('annot-outil', 'fleche'));
  choisirCouleur(COULEURS_ANNOT.includes(lire('annot-couleur')) ? lire('annot-couleur') : COULEURS_ANNOT[0]);
  $('#annot-defaire').onclick = () => { annot.formes.pop(); redessinerAnnotation(); };
  $('#annot-fermer').onclick = fermerAnnotation;
  $('#annot-valider').onclick = validerAnnotation;

  // Recherche globale
  $('#btn-chercher').onclick = ouvrirRecherche;
  $('#recherche-texte').oninput = dessinerRecherche;
  $('#recherche-texte').onkeydown = (e) => { if (e.key === 'Enter') { noterRecherche(e.target.value); e.target.blur(); } };
  $('#recherche-fermer').onclick = () => ouvrirOnglet('accueil');

  // Relevé de mesures
  // L'appareil photo s'ouvre d'abord ; la boussole est demandée au début du rendez-vous (sa demande d'autorisation
  // empêchait l'appareil photo de s'ouvrir sur l'iPhone).
  $('#releve-photo').onclick = () => { R.suiteAutreMur = null; $('#releve-input').click(); activerBoussole(); };
  $('#releve-facade').oninput = () => sauverBrouillonReleve();
  $('#releve-galerie').onclick = () => { R.suiteAutreMur = null; $('#releve-galerie-input').click(); };
  for (const id of ['#releve-input', '#releve-galerie-input']) {
    $(id).onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; photoReleve(f); };
  }
  $('#releve-reprendre').onclick = () => reprendreReleve();
  $('#releve-micro').onclick = dicterMesures;
  // Clavier ouvert : le bouton du bas se cache pour ne pas couvrir la case qu'on remplit.
  $('#ecran-releve').addEventListener('focusin', (e) => { if (e.target.matches('input, textarea')) document.body.classList.add('clavier'); });
  $('#ecran-releve').addEventListener('focusout', () => setTimeout(() => {
    if (!document.activeElement?.matches?.('#ecran-releve input, #ecran-releve textarea')) document.body.classList.remove('clavier');
  }, 100));
  $('#releve-lire').onclick = comprendreDictee;
  $('#releve-dictee').oninput = () => sauverBrouillonReleve();
  $('#releve-enregistrer').onclick = () => enregistrerReleve(true);
  $('#releve-autre-mur').onclick = autreMur;
  $('#gabarit-avec-ouvertures').onchange = (ev) => {
    const g = R.gabarit;
    if (ev.target.checked) {
      g.avecOuvertures = true;
      if (!g.ouvertures.length) g.ouvertures.push({ nom: '', l: '', h: '', x: '', s: '' });
    } else if (g.ouvertures.some((o) => o.l || o.h || o.s) && !confirm('Retirer les ouvertures de ce mur ?')) {
      ev.target.checked = true; return;
    } else { g.ouvertures = []; g.avecOuvertures = false; }
    dessinerOuvertures();
    majReleve();
  };
  $('#travaux-ajouter').onclick = () => {
    const l = $('#travaux-libelle');
    if (!l.value.trim()) { l.focus(); toast('Écris le travail à ajouter.', 'erreur'); return; }
    ajouterTravail(l.value, lireMesure($('#travaux-quantite').value) || 0, $('#travaux-unite').value);
    l.value = ''; $('#travaux-quantite').value = '';
  };
  $('#travaux-libelle').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#travaux-ajouter').click(); } };
  $('#gabarit-ajouter-point').onclick = () => { (R.gabarit.points ||= []).push({ x: '', h: '' }); dessinerPointsLibres(); majReleve(); };
  $('#releve-reanalyser').onclick = () => {
    if (R.elements.some((e) => e.valeur > 0) && !confirm('Refaire l\'analyse ? Les mesures déjà tapées seront effacées.')) return;
    analyserPhotoReleve();
  };
  $('#releve-saisie').onclick = () => demarrerReleve({ mode: 'saisie', chantier: $('#releve-chantier').value, depuisRdv: R.depuisRdv,
    gabarit: { type: 'pignon', saisis: {}, ouvertures: [] } });
  for (const b of $$('#gabarit-types [data-gabarit]')) b.onclick = () => choisirGabarit(b.dataset.gabarit);
  $('#gabarit-ajouter-ouverture').onclick = () => { R.gabarit.ouvertures.push({ nom: '', l: '', h: '', x: '', s: '' }); dessinerOuvertures(); majReleve(); };
  $('#gabarit-photo').onclick = () => $('#gabarit-photo-input').click();
  $('#gabarit-photo-input').onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; photoReleve(f, 'saisie'); };
  const toileReleve = $('#releve-canvas');
  toileReleve.onpointerdown = releveDebut;
  toileReleve.onpointermove = releveMouvement;
  toileReleve.onpointerup = releveFin;
  toileReleve.onpointercancel = () => { cacherLoupe(); R.glisse = null; if (R.enCours?.type === 'cote') R.enCours = null; redessinerReleve(); };
  for (const b of $$('#releve-outils [data-outil]')) b.onclick = () => choisirOutilReleve(b.dataset.outil);
  $('#releve-defaire').onclick = defaireReleve;
  $('#releve-fermer-surface').onclick = fermerSurface;
  {
    $('#releve-ouvrage').onchange = (ev) => {
      R.ouvrage = ev.target.value;
      dessinerParamsReleve();
      majReleve();
    };
  }
  // Zone de travaux : seulement une partie du bâtiment.
  $('#zone-actif').onchange = (ev) => {
    R.zone.actif = ev.target.checked;
    if (R.zone.actif) setTimeout(() => $('#zone-a').focus(), 50);
    if (R.mode === 'photo') redessinerReleve();
    majReleve();
  };
  $('#zone-depuis').onchange = (ev) => { R.zone.depuis = ev.target.value; if (R.mode === 'photo') redessinerReleve(); majReleve(); };
  for (const k of ['de', 'a', 'bas', 'haut']) {
    const champ = $(`#zone-${k}`);
    champ.oninput = () => {
      const v = lireMesure(champ.value);
      if (v == null) return;
      R.zone[k] = v;
      if (R.mode === 'photo') redessinerReleve();
      majReleve();
    };
    champ.onkeydown = (ev) => { // Entrée = case suivante (télémètre en mode clavier)
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const ordre = ['de', 'a', 'bas', 'haut'], i = ordre.indexOf(k);
      if (i < 3) $(`#zone-${ordre[i + 1]}`).focus(); else champ.blur();
    };
  }
  $('#releve-chantier').onchange = () => { envoyerPhotoReleve(); sauverBrouillonReleve(); };
  $('#releve-fermer').onclick = () => {
    if (R.depuisRdv && V.actif) { ouvrirRdv(); return; }
    if (ecranPrecedent === 'fiche') afficher('fiche'); else retourOnglet();
  };

  // Rendez-vous client
  $('#btn-rdv').onclick = () => { activerBoussole(); demarrerRdv(); };
  $('#btn-releve-encours').onclick = () => ouvrirReleveEnCours();
  $('#rdv-fermer').onclick = () => { sauverRdv(); ouvrirOnglet('accueil'); };
  for (const b of $$('#rdv-type [data-type]')) {
    b.onclick = () => { V.type = b.dataset.type; V.chantierEnvoye = false; sauverRdv(); ouvrirRdv(); };
  }
  $('#rdv-chantier-select').onchange = (e) => {
    V.chantier = e.target.value; V.chantierEnvoye = false; V.client = V.tel = V.adresse = ''; V.lat = V.lon = null; sauverRdv(); ouvrirRdv();
  };
  $('#rdv-voir-fiche').onclick = () => {
    if (!V.chantier) return;
    sauverRdv(); ouvrirFiche(V.chantier);
    ficheDepuisRdv = true; $('#fiche-retour').textContent = '‹ Rendez-vous';
  };
  $('#fiche-retour').onclick = () => {
    if (ficheDepuisRdv && V.actif) { ficheDepuisRdv = false; $('#fiche-retour').textContent = '‹ Chantiers'; ouvrirRdv(); }
    else ouvrirOnglet('chantiers');
  };
  for (const [id, cle] of [['#rdv-nom', 'nom'], ['#rdv-client', 'client'], ['#rdv-tel', 'tel'],
    ['#rdv-email', 'email'], ['#rdv-dictee', 'dictee'], ['#rdv-budget', 'budget'], ['#rdv-delai', 'delai']]) {
    $(id).oninput = (e) => { V[cle] = e.target.value; if (cle === 'nom') V.chantierEnvoye = false; sauverRdv(); majRdv(); };
  }
  brancherClientTel($('#rdv-client'), $('#rdv-tel'), () => { V.client = $('#rdv-client').value; V.tel = $('#rdv-tel').value; sauverRdv(); });
  brancherAdresse('rdv', (pos) => {
    V.adresse = joindreAdresse($('#rdv-adresse').value, $('#rdv-cp').value, $('#rdv-ville').value);
    V.lat = pos ? pos.lat : null; V.lon = pos ? pos.lon : null;
    sauverRdv();
  });
  brancherClientTel($('#fiche-client'), $('#fiche-tel'), () => {});
  brancherAdresse('fiche', (pos) => { fichePos = pos ? { lat: pos.lat, lon: pos.lon } : null; });
  $('#rdv-photo').onclick = () => { if (assurerChantierRdv()) { $('#rdv-photo-input').click(); activerBoussole(); } };
  $('#rdv-notes').onclick = () => { if (assurerChantierRdv()) $('#rdv-notes-input').click(); };
  $('#rdv-photo-input').onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; photoRdv(f, false); };
  $('#rdv-notes-input').onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; photoRdv(f, true); };
  $('#rdv-galerie').onclick = () => { if (assurerChantierRdv()) $('#rdv-galerie-input').click(); };
  $('#rdv-notes-galerie').onclick = () => { if (assurerChantierRdv()) $('#rdv-notes-galerie-input').click(); };
  $('#rdv-galerie-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; galerieRdv(f, false); };
  $('#rdv-notes-galerie-input').onchange = (ev) => { const f = [...ev.target.files]; ev.target.value = ''; galerieRdv(f, true); };
  $('#rdv-mesures').onclick = mesuresRdv;
  $('#rdv-micro').onclick = dicterRdv;
  $('#rdv-terminer').onclick = terminerRdv;
  $('#rdv-abandonner').onclick = abandonnerRdv;
  $('#releve-nouveau').onclick = nouveauReleve;
  $('#releve-envoyer').onclick = creerFeuille;
  $('#feuille-retour').onclick = () => afficher('releve');
  $('#feuille-ranger').onclick = rangerFeuille;
  $('#feuille-partager').onclick = partagerFeuille;
  $('#feuille-copier').onclick = copierMetre;
  $('#fiche-releve').onclick = () => ouvrirReleve(ficheCourante?.nom || '');

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
  $('#fiche-photo').onclick = () => ouvrirPhotos(ficheCourante?.nom || '', () => afficher('fiche'));
  $('#fiche-galerie').onclick = () => { ouvrirPhotos(ficheCourante?.nom || '', () => afficher('fiche')); if (ficheCourante?.nom) $('#photos-galerie-input').click(); };
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
      if (R.actif) sauverBrouillonMaintenant(); // l'iPhone peut fermer l'appli pendant qu'on mesure ailleurs
      return;
    }
    document.body.classList.remove('masque');
    if (faceIdActif() && demarree && !securite.verrouillee && Date.now() - securite.cacheDepuis > DELAI_VERROU_MS) { verrouiller(); return; }
    if (!demarree || securite.verrouillee) return;
    verifierNouvelleVersion();
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
  else { ouvrirOnglet('accueil'); rouvrirReleveRecent().catch(() => {}); }
  await appairageAutomatique();
  viderFile();
  verifierNouvelleVersion();
}
