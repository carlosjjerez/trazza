/* Trazza service worker — app shell offline-first.
   Importante para la pista: una vez abierta la app con conexión, el crono
   funciona sin red. */
const CACHE = 'trazza-v2';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './sim.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', (e)=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);

  // Same-origin: cache-first con relleno de caché.
  if(url.origin===location.origin){
    e.respondWith(
      caches.match(req).then(hit=> hit || fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(()=> caches.match('./index.html')))
    );
    return;
  }

  // Fuentes de Google: cachea oportunistamente para uso offline.
  if(url.host.includes('fonts.googleapis.com') || url.host.includes('fonts.gstatic.com')){
    e.respondWith(
      caches.match(req).then(hit=> hit || fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(()=>hit))
    );
  }
});
