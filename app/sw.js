/* Trazza ya NO usa service worker.
   Este stub se auto-desinstala: limpia cachés antiguas, deja de interceptar
   (no hay handler 'fetch') y se da de baja. Sirve para sanar los móviles que
   tuvieran instalada una versión anterior con el bug de redirecciones de iOS.
   Cuando el navegador busca actualización de sw.js, recibe esto y se cura. */
self.addEventListener('install', ()=> self.skipWaiting());

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    try{
      const keys = await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
    }catch(err){}
    try{ await self.registration.unregister(); }catch(err){}
    try{
      const clients = await self.clients.matchAll({ type:'window' });
      clients.forEach(c=> c.navigate(c.url));
    }catch(err){}
  })());
});
/* sin 'fetch': nunca intercepta navegaciones -> imposible el error de iOS */
