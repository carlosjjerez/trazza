/* Trazza service worker — app shell offline, a prueba de redirecciones en iOS.
   Safari rechaza navegaciones cuya respuesta venga de una redirección
   (redirected:true u opaqueredirect). Por eso SIEMPRE reconstruimos una
   respuesta limpia con new Response(), tanto al precachear como al navegar. */
const CACHE = 'trazza-v4';
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

// fetch que sigue redirecciones y devuelve una respuesta SIN la marca de
// redirección (clave para que Safari la acepte en una navegación).
async function cleanFetch(url){
  const res = await fetch(url, { redirect:'follow', cache:'no-store' });
  const body = await res.blob();
  return new Response(body, { status:res.status, statusText:res.statusText, headers:res.headers });
}

self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (u)=>{
      try{ const r = await cleanFetch(u); if(r.ok) await c.put(u, r); }catch(err){}
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

  // NAVEGACIONES: red con respuesta reconstruida (limpia); si falla, shell
  // cacheada (también limpia). Nunca devolvemos una respuesta redirigida.
  if(req.mode === 'navigate'){
    e.respondWith((async()=>{
      try{
        const r = await cleanFetch(req.url);
        const copy = r.clone();
        caches.open(CACHE).then(c=>c.put('./index.html', copy)).catch(()=>{});
        return r;
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
