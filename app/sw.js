/* Trazza service worker — app shell offline-first, a prueba de redirecciones.
   Importante para la pista: una vez abierta la app con conexión, el crono
   funciona sin red. */
const CACHE = 'trazza-v3';
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
  e.waitUntil((async()=>{
    const c = await caches.open(CACHE);
    // redirect:'follow' + copia limpia: nunca guardamos respuestas redirigidas
    await Promise.all(SHELL.map(async (u)=>{
      try{
        const res = await fetch(u, { cache:'reload', redirect:'follow' });
        if(res.ok) await c.put(u, res);
      }catch(err){/* offline en install: se rellena luego */}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);

  // NAVEGACIONES: red primero (evita servir respuestas redirigidas cacheadas);
  // si no hay red, sirve la shell cacheada (200, sin redirección).
  if(req.mode === 'navigate'){
    e.respondWith((async()=>{
      try{
        return await fetch(req);
      }catch(err){
        const c = await caches.open(CACHE);
        return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Mismo origen (css/js/iconos): cache-first con relleno.
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
