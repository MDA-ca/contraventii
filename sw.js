/* Service worker – păstrează aplicația pentru lucru fără internet. Versiunea se schimbă automat la fiecare actualizare. */
const V='8e703296a3';
const CACHE='contraventii-'+V;
const SHELL=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(new Request(u,{cache:'reload'}))))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.indexOf('contraventii-')===0&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
/* din cache imediat; în fundal, dacă e internet, se reîmprospătează */
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url); if(u.origin!==location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c=>{
    const hit=(await c.match(r,{ignoreSearch:true}))||(r.mode==='navigate'?await c.match('index.html'):null);
    const net=fetch(r).then(res=>{ if(res&&res.ok&&res.type==='basic') c.put(r,res.clone()); return res; }).catch(()=>null);
    if(hit){ e.waitUntil(net); return hit; }
    return (await net)||new Response('Fără internet și fără copie salvată.',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
  }));
});
