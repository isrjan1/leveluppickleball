const C='pb-v7.2';
const SHELL=['./','icon-192.png','icon.svg','manifest.webmanifest','vendor/qrcode.min.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r0=e.request,u=new URL(r0.url);
  if(r0.method!=='GET'||u.origin!==location.origin||u.pathname==='/api'||u.pathname.startsWith('/api/'))return;
  // navigations share one cache entry so /?ci=CODE links don't fill the cache
  const key=r0.mode==='navigate'?'./':r0;
  e.respondWith(fetch(r0).then(r=>{
    if(r.ok){const c=r.clone();e.waitUntil(caches.open(C).then(x=>x.put(key,c)).catch(()=>{}))}
    return r;
  }).catch(()=>caches.match(key).then(m=>m||caches.match('./'))));
});
