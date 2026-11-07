// Service worker : garde l'appli disponible même sans réseau.
// Changer CACHE à chaque nouvelle version pour que l'iPhone récupère les fichiers à jour.
const CACHE = 'charpente-v1.16.0';
const FICHIERS = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icone.svg', 'icone-180.png', 'icone-512.png',
  'logo.svg', 'logo-blanc.svg'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  // Les appels au serveur Google ne passent jamais par le cache.
  if (ev.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Réseau d'abord (pour avoir la dernière version), cache si pas de réseau. « no-cache » : le navigateur revérifie
  // chaque fichier auprès de GitHub au lieu de reprendre une copie de moins de 10 minutes (sinon la page et le code
  // pouvaient être de deux versions différentes juste après une mise à jour).
  const requete = ev.request.mode === 'navigate' ? new Request(ev.request.url, { cache: 'no-cache' }) : new Request(ev.request, { cache: 'no-cache' });
  ev.respondWith(
    fetch(requete)
      .then((rep) => {
        const copie = rep.clone();
        caches.open(CACHE).then((c) => c.put(ev.request, copie));
        return rep;
      })
      .catch(() => caches.match(ev.request))
  );
});
