/* 오프라인 캐시 — 파일을 고치면 CACHE 이름의 숫자를 올려주세요. */
const CACHE='child-intake-v9';
const FILES=['./','./index.html','./app.css','./config.js','./data.js','./sync.js','./app.js',
             './vendor-jszip.min.js','./vendor-pico.js','./vendor-qrcode.js','./photocheck.js','./facefinder',
             './manifest.webmanifest',
             './icons/icon-192.png','./icons/icon-512.png','./icons/icon-180.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
/* 캐시 우선 — 인터넷이 없어도 즉시 뜨고, 있을 때 조용히 새 버전을 받아둡니다. */
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(caches.match(e.request).then(hit=>{
    const net=fetch(e.request).then(res=>{
      if(res&&res.status===200&&res.type==='basic')
        caches.open(CACHE).then(c=>c.put(e.request,res.clone()));
      return res;
    }).catch(()=>hit);
    return hit||net;
  }));
});
