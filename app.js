/* ══════════════ 상태 ══════════════ */
const state={cfg:null,adminOk:false,adminTab:'place',adminAdd:'',staff:'',country:'',site:'',hqUrl:'',hqKey:'',lang:'ko',big:false,
             syncing:false,syncErr:'',lastSync:'',
             records:[],roster:[],draft:null,step:0,view:'setup'};

const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pad4=n=>String(n).padStart(4,'0');
const p2=n=>String(n).padStart(2,'0');
const norm=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,' ');
const t=k=>{const v=S[k];return v?(state.lang==='en'?v[1]:v[0]):k;};
const f=(k,map)=>{let s=t(k);for(const p in map)s=s.split(p).join(map[p]);return s;};
const ov=(field,v)=>state.lang==='en'?((OPT_EN[field]||{})[v]||v):v;
const nm=o=>o?(state.lang==='en'?o.en:o.ko):'';
const siteName=c=>nm(allSites().find(s=>s.code===c));
const countryName=c=>nm(allCountries().find(x=>x.code===c));

/* ══════════════ 관리자 설정 ══════════════
   기본 목록(data.js)에 관리자가 더한 항목을 합치고, 꺼둔 항목을 걸러냅니다.
   기본 목록 자체는 건드리지 않으므로 언제든 초기화할 수 있습니다. */
const newCfg=()=>({rev:0,pin:(typeof ADMIN!=='undefined'&&ADMIN.pin)||'2026',
  off:{countries:[],sites:[]},add:{countries:[],sites:[]}});
const allCountries=()=>COUNTRIES.concat(state.cfg.add.countries);
const allSites=()=>SITES.concat(state.cfg.add.sites);
const onCountries=()=>allCountries().filter(c=>!state.cfg.off.countries.includes(c.code));
const onSites=()=>allSites().filter(s=>!state.cfg.off.sites.includes(s.code));
const saveCfg=()=>DB.put('kv',state.cfg,'config');

/* 현지 시각 기준 — toISOString()은 UTC라 시차가 있는 사업장에서 날짜가 틀어집니다 */
const today=()=>{const n=new Date();return `${n.getFullYear()}-${p2(n.getMonth()+1)}-${p2(n.getDate())}`;};
const age=dob=>dob?Math.floor((Date.now()-new Date(dob))/31557600000):null;
const d=()=>state.draft;

function toast(m){const el=$('toast');el.textContent=m;el.classList.add('show');
  clearTimeout(toast._t);toast._t=setTimeout(()=>el.classList.remove('show'),2800);}

/* 기기에서 만드는 고유 기록ID — 이 값으로 본부가 같은 건인지 알아봅니다 */
const uuid=()=>(self.crypto&&crypto.randomUUID)?crypto.randomUUID()
  :'r-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);

/* ══════════════ 저장소 (IndexedDB) ══════════════
   기기에 그대로 남습니다. 탭을 닫아도, 배터리가 나가도 유지됩니다. */
const DB=(()=>{
  let db=null;
  const open=()=>new Promise((res,rej)=>{
    const r=indexedDB.open('childIntake',2);
    r.onupgradeneeded=e=>{const x=e.target.result,tx=e.target.transaction;
      if(!x.objectStoreNames.contains('kv'))x.createObjectStore('kv');
      if(!x.objectStoreNames.contains('roster'))x.createObjectStore('roster',{keyPath:'아동코드'});
      if(!x.objectStoreNames.contains('records')){
        x.createObjectStore('records',{keyPath:'_id'});
      }else if(tx.objectStore('records').keyPath!=='_id'){
        /* v1 → v2 : 기존 등록분을 기록ID 기준으로 옮깁니다 */
        const old=tx.objectStore('records').getAll();
        old.onsuccess=()=>{const rows=old.result||[];
          x.deleteObjectStore('records');
          const ns=x.createObjectStore('records',{keyPath:'_id'});
          rows.forEach(r=>{if(!r._id)r._id=uuid();if(!r._sync)r._sync='pending';ns.put(r);});};
      }};
    r.onsuccess=e=>{db=e.target.result;res(db);};
    r.onerror=()=>rej(r.error);});
  const tx=(store,mode,fn)=>new Promise((res,rej)=>{
    const t=db.transaction(store,mode),s=t.objectStore(store);
    const req=fn(s);let val;
    if(req&&'result'in req)req.onsuccess=()=>{val=req.result;};
    t.oncomplete=()=>res(val);
    t.onerror=t.onabort=()=>rej(t.error);});
  return{
    open,
    get:(store,key)=>tx(store,'readonly',s=>s.get(key)),
    all:store=>tx(store,'readonly',s=>s.getAll()),
    put:(store,val,key)=>tx(store,'readwrite',s=>s.put(val,key)),
    del:(store,key)=>tx(store,'readwrite',s=>s.delete(key)),
    clear:store=>tx(store,'readwrite',s=>s.clear()),
    bulk:(store,vals)=>tx(store,'readwrite',s=>{vals.forEach(v=>s.put(v));})
  };
})();

const settings=()=>({staff:state.staff,country:state.country,site:state.site,
                     hqUrl:state.hqUrl,hqKey:state.hqKey,lastSync:state.lastSync,
                     lang:state.lang,big:state.big});
const saveSettings=()=>DB.put('kv',settings(),'settings');

let draftTimer=null;
function saveDraft(now){
  clearTimeout(draftTimer);
  const go=()=>{ if(!state.draft)return;
    DB.put('kv',{step:state.step,data:state.draft},'draft').then(()=>{
      const el=$('savedTag'); if(el){el.textContent=t('autosaved');
        clearTimeout(saveDraft._t);saveDraft._t=setTimeout(()=>{if(el)el.textContent='';},1600);}});};
  now?go():draftTimer=setTimeout(go,450);
}
const dropDraft=()=>{clearTimeout(draftTimer);state.draft=null;return DB.del('kv','draft');};

/* ══════════════ 사진 ══════════════ */
const urls=new WeakMap();
function src(blob){ if(!blob)return'';
  if(!urls.has(blob))urls.set(blob,URL.createObjectURL(blob));
  return urls.get(blob); }

function loadImg(file){return new Promise((res,rej)=>{const u=URL.createObjectURL(file);
  const i=new Image();i.onload=()=>{URL.revokeObjectURL(u);res(i);};
  i.onerror=()=>{URL.revokeObjectURL(u);rej();};i.src=u;});}

/* 세로로 찍은 사진이 눕지 않도록 EXIF 방향을 반영합니다 */
async function compress(file,max=1000){
  let img;
  try{ img=await createImageBitmap(file,{imageOrientation:'from-image'}); }
  catch(e){ try{ img=await loadImg(file); }catch(_){ return null; } }
  const w=img.width,h=img.height,s=Math.min(1,max/Math.max(w,h));
  const c=document.createElement('canvas');
  c.width=Math.round(w*s);c.height=Math.round(h*s);
  c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  if(img.close)img.close();
  return new Promise(res=>c.toBlob(res,'image/jpeg',0.72));
}

/* ══════════════ 중복 감지 ══════════════
   강한 의심 : 아동 이름 + 생년월일 + 성별 모두 일치
   약한 의심 : 같은 사업장 + 생년월일 일치 (형제자매·쌍둥이)
   이 기기 등록분과 불러온 본부 명단을 함께 대조합니다. */
function findDup(x){
  const strong=[],weak=[];
  const pool=state.records.map(r=>({r,src:'dev'})).concat(state.roster.map(r=>({r,src:'hq'})));
  pool.forEach(({r,src})=>{
    if(r._id&&r._id===x._id)return;
    const sameName=x.현지어이름&&norm(r.현지어이름)===norm(x.현지어이름);
    const sameDob =x.생년월일&&r.생년월일===x.생년월일;
    const sameSex =x.성별&&r.성별===x.성별;
    if(sameName&&sameDob&&sameSex)strong.push({r,src});
    else if(sameDob&&r.사업장코드===x.사업장코드)weak.push({r,src});
  });
  return{strong,weak};
}
function dupCard({r,src:from}){
  const img=r._face?`<img src="${src(r._face)}" alt="">`:`<div class="no">${t('noPhoto')}</div>`;
  const a=age(r.생년월일);
  const badge=from==='hq'?`<span class="src hq">${t('srcHq')}</span>`:`<span class="src dev">${t('srcDev')}</span>`;
  return `<div class="dupcard">${img}<div class="dupcard-m">
    <div class="dupcard-n">${esc(r.현지어이름||'—')}${badge}</div>
    <div class="dupcard-c">${esc(r.아동코드||t('codePending'))}</div>
    <div class="dupcard-d">${esc(r.생년월일)}${a!==null?` · ${a}${t('yrs')}`:''} · ${esc(ov('성별',r.성별))}</div>
  </div></div>`;
}
function dupHTML(){
  const x=d(),{strong,weak}=findDup(x);
  if(strong.length){
    return `<div class="dup strong">
      <h3>${t('dupStrong')}</h3><p>${f('dupStrongBody',{'%n':strong.length})}</p>
      ${strong.map(dupCard).join('')}
      <div class="field" style="margin:14px 0 0">
        <p class="lbl">${t('dupResult')} <span class="req">*</span></p>
        <div class="chips" data-c="중복확인">
          ${L.중복확인.map(v=>`<button type="button" class="chip wide" data-v="${esc(v)}" aria-pressed="${x.중복확인===v}">${esc(ov('중복확인',v))}</button>`).join('')}
        </div><p class="err" id="e_중복확인"></p></div>
      <div class="field" style="margin:0">
        <label class="lbl" for="f_중복확인메모">${t('dupNote')} <span class="req">*</span></label>
        <p class="hint">${t('dupNoteHint')}</p>
        <textarea id="f_중복확인메모" data-k="중복확인메모" placeholder="${esc(t('dupNotePh'))}">${esc(x.중복확인메모)}</textarea>
        <p class="err" id="e_중복확인메모"></p></div></div>`;
  }
  if(weak.length){
    return `<div class="dup weak"><h3>${t('dupWeak')}</h3>
      <p>${f('dupWeakBody',{'%n':weak.length})}</p>${weak.map(dupCard).join('')}</div>`;
  }
  return '';
}

/* ══════════════ 초안 ══════════════ */
function newDraft(){
  const x={};MASTER_COLS.forEach(k=>x[k]='');
  /* 아동코드와 연번은 비워둡니다. 본부 서버가 도착 순서대로 부여합니다.
     기록ID는 기기가 만드는 고유값으로, 재전송해도 시트에 줄이 겹치지 않게 해줍니다. */
  Object.assign(x,{_id:uuid(),_createdAt:new Date().toISOString(),아동코드:'',연번:'',
    국가코드:state.country,사업장코드:state.site,
    등록일:today(),등록담당자:state.staff,상태:'전송대기'});
  x._sync='draft';
  x._face=null;x._full=null;x._cons=null;
  x._guide={solo:false,face:false,light:false,dress:false,bg:false};
  x._qc={};
  return x;
}

/* ══════════════ 화면 전환 ══════════════ */
function show(view){
  state.view=view;
  ['vHome','vStep','vExport'].forEach(v=>$(v).classList.add('hidden'));
  $('bar').classList.add('hidden');
  if(view==='step'){$('vStep').classList.remove('hidden');$('bar').classList.remove('hidden');}
  else if(view==='export')$('vExport').classList.remove('hidden');
  else $('vHome').classList.remove('hidden');
  render();
}
function render(){
  topbar();
  if(state.view==='setup')return renderSetup();
  if(state.view==='home')return renderHome();
  if(state.view==='step')return renderStep();
  if(state.view==='export')return renderExport();
  if(state.view==='import')return renderImport();
  if(state.view==='admin')return renderAdmin();
}
function topbar(){
  $('tbCode').textContent=state.site?`${state.country} · ${state.site}`:t('noSite');
  $('tbName').textContent=state.site
    ? (state.lang==='en'?`${siteName(state.site)}${t('siteSuffix')}`:`${countryName(state.country)} ${siteName(state.site)} ${t('siteSuffix')}`)
    : t('appName');
  $('btnLang').textContent=state.lang==='en'?'한국어':'EN';
  $('btnSize').setAttribute('aria-label',t('bigText'));
  $('offline').classList.toggle('hidden',navigator.onLine);
  $('offline').textContent=t('offline');
  const pend=Sync.pending().length;
  const bar=$('warnbar');
  if(!state.records.length){bar.classList.add('hidden');}
  else{bar.classList.remove('hidden');bar.classList.toggle('ok',pend===0);
    bar.innerHTML=pend?f('warnPend2',{'%n':pend}):t('warnOk2');}
}

/* ══════════════ 시작 설정 ══════════════ */
function renderSetup(){
  $('vHome').innerHTML=`
    <p class="eyebrow">${t('setupEyebrow')}</p><h1>${t('setupTitle')}</h1>
    <p class="lede">${t('setupLede')}</p>
    <div class="field"><label class="lbl" for="sStaff">${t('staff')} <span class="req">*</span></label>
      <input type="text" id="sStaff" value="${esc(state.staff)}" placeholder="${state.lang==='en'?'Seoyeon Kim':'김서연'}"></div>
    <div class="field"><label class="lbl" for="sCountry">${t('country')} <span class="req">*</span></label>
      <select id="sCountry"><option value="">${t('choose')}</option>
      ${onCountries().map(c=>`<option value="${c.code}" ${state.country===c.code?'selected':''}>${nm(c)} (${c.code})</option>`).join('')}</select></div>
    <div class="field"><label class="lbl" for="sSite">${t('site')} <span class="req">*</span></label>
      <select id="sSite"></select></div>
    <div class="field"><label class="lbl" for="sUrl">${t('hqUrl')}</label>
      <p class="hint">${t('hqUrlHint')}</p>
      <input type="text" id="sUrl" value="${esc(state.hqUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></div>
    <div class="field"><label class="lbl" for="sKey">${t('hqKey')}</label>
      <input type="text" id="sKey" value="${esc(state.hqKey)}" placeholder="${esc(t('hqKeyPh'))}">
      <button class="ghost mt8" id="bTest">${t('hqTest')}</button>
      <p class="hint mt8" id="testOut"></p></div>
    <p class="err" id="eSetup"></p>
    <button class="primary" id="bGo">${t('startBtn')}</button>
    ${isStandalone()?`<p class="hint mt16">${t('instAlready')}</p>`
      :`<div class="mt16"><button class="ghost jade" id="bInstAgain">${t('instAgain')}</button>
         <p class="hint mt8">${t('instAgainHint')}</p></div>
       <div id="instHelp"></div>`}`;
  const fill=()=>{const cc=$('sCountry').value;
    $('sSite').innerHTML=cc?`<option value="">${t('choose')}</option>`+
      onSites().filter(s=>s.country===cc).map(s=>`<option value="${s.code}" ${state.site===s.code?'selected':''}>${nm(s)} (${s.code})</option>`).join('')
      :`<option value="">${t('chooseCountryFirst')}</option>`;};
  fill();$('sCountry').onchange=fill;
  const again=$('bInstAgain');
  if(again)again.onclick=()=>{state.instHide=false;installAsk(again);};
  $('bGo').onclick=async()=>{
    const st=$('sStaff').value.trim(),c=$('sCountry').value,s=$('sSite').value;
    if(!st||!c||!s){const e=$('eSetup');e.textContent=t('setupErr');e.classList.add('show');return;}
    state.staff=st;state.country=c;state.site=s;
    state.hqUrl=$('sUrl').value.trim();state.hqKey=$('sKey').value.trim();
    await saveSettings();show('home');
    if(state.hqUrl)Sync.roster().catch(()=>{});};
  $('bTest').onclick=async()=>{
    const url=$('sUrl').value.trim(),out=$('testOut');
    if(!url){out.textContent=t('hqNoUrl');return;}
    out.textContent=t('hqTesting');
    try{await Sync.test(url,$('sKey').value.trim());out.textContent='✓ '+t('hqOk');}
    catch(e){out.textContent='✗ '+t('hqFail')+' ('+(e.message||e)+')';}};
}

/* ══════════════ 홈 ══════════════ */
function renderHome(){
  if(!state.site)return renderSetup();
  const unsent=Sync.pending().length;
  const dr=state.draft;
  $('vHome').innerHTML=`
    <p class="eyebrow">${t('homeEyebrow')}</p><h1>${t('homeTitle')}</h1>
    <p class="lede">${t('homeLede')}</p>
    ${dr?`<div class="resume"><h3>${t('resumeTitle')}</h3>
      <p>${f('resumeBody',{'%c':esc(dr.현지어이름||t('noName')),'%s':state.step+1})}</p>
      <div class="two"><button class="primary" id="bResume">${t('resumeGo')}</button>
      <button class="ghost rust" id="bDrop">${t('resumeDrop')}</button></div></div>`:''}
    ${instCard()}
    <div class="stats">
      <div class="stat a"><div class="stat-n">${state.records.length}</div><div class="stat-l">${t('statSaved')}</div></div>
      <div class="stat ${unsent?'warn':'b'}"><div class="stat-n">${unsent}</div><div class="stat-l">${t('statUnsent')}</div></div>
    </div>
    <button class="primary" id="bNew">${t('newChild')}</button>
    ${state.hqUrl
      ? `<div class="mt10"><button class="ghost jade" id="bSync" ${unsent?'':'disabled'}>
           ${state.syncing?t('syncing'):f('syncBtn',{'%n':unsent})}</button></div>
         ${state.syncErr?`<p class="hint mt8" style="color:var(--rust)">${esc(state.syncErr)}</p>`:''}
         ${state.lastSync?`<p class="hint mt8">${f('lastSync',{'%d':state.lastSync})}</p>`:''}`
      : `<p class="hint mt10">${t('noHqUrl')}</p>`}
    <div class="mt8"><button class="ghost" id="bExp">${t('exportBtn')}</button></div>
    <div class="mt8"><button class="ghost" id="bImp">${t('importBtn')}</button></div>
    ${state.roster.length?`<p class="hint mt8">${f('rosterLoaded',{'%n':state.roster.length,'%d':state.rosterDate||''})}</p>`:''}
    <div class="mt8"><button class="ghost" id="bSetup">${t('changeSetup')}</button></div>
    <div class="mt8"><button class="ghost" id="bAdmin">${t('adminBtn')}</button></div>
    <div class="list-h"><h2>${t('recordList')}</h2><span>${state.records.length}</span></div><div id="rl"></div>`;

  $('rl').innerHTML=state.records.length?state.records.slice().reverse().map(r=>`
    <div class="row">${r._face?`<img class="thumb" src="${src(r._face)}" alt="">`:`<div class="thumb"></div>`}
      <div class="row-m"><div class="row-n">${esc(r.현지어이름||'—')}</div>
      <div class="row-c">${esc(r.아동코드||t('codePending'))}</div></div>
      <span class="tag ${r._sync==='sent'?'out':'pend'}">${r._sync==='sent'?t('tagSent'):t('tagWaiting')}</span></div>`).join('')
    :`<div class="empty">${t('emptyList')}</div>`;

  if(dr){
    $('bResume').onclick=()=>show('step');
    $('bDrop').onclick=async()=>{await dropDraft();toast(t('drafted'));render();};
  }
  bindInstall();
  $('bNew').onclick=async()=>{
    if(state.draft)await dropDraft();
    state.draft=newDraft();state.step=0;saveDraft(true);show('step');};
  $('bExp').onclick=()=>{if(!state.records.length)return toast(t('noRecords'));show('export');};
  const sb=$('bSync');
  if(sb)sb.onclick=()=>runSync(true);
  $('bImp').onclick=()=>{state.view='import';render();};
  $('bSetup').onclick=()=>{state.view='setup';render();};
  $('bAdmin').onclick=()=>{state.adminTab='place';state.adminAdd='';state.view='admin';render();};
}

/* ══════════════ 명단 불러오기 ══════════════ */
function parseCSV(text){
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; } else cell+=c; }
    else if(c==='"')q=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\r'){}
    else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=c;}
  if(cell!==''||row.length){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(v=>v!==''));
}
function renderImport(){
  $('vHome').innerHTML=`
    <p class="eyebrow">${t('expEyebrow')}</p><h1>${t('impTitle')}</h1>
    <p class="lede">${t('impBody')}</p>
    <div class="exp"><p>${t('impCols')}</p>
      <button class="ghost jade" id="iPick">${t('impPick')}</button></div>
    ${state.roster.length?`<div class="mt10"><button class="ghost rust" id="iClear">${t('rosterClear')} (${state.roster.length})</button></div>`:''}
    <div class="mt16"><button class="ghost" id="iBack">${t('backBtn')}</button></div>`;
  $('iPick').onclick=()=>$('fCsv').click();
  $('iBack').onclick=()=>show('home');
  const c=$('iClear');
  if(c)c.onclick=async()=>{await DB.clear('roster');state.roster=[];toast(t('rosterCleared'));render();};
}
async function importCSV(file){
  try{
    const rows=parseCSV(await file.text());
    if(rows.length<2)throw 0;
    const head=rows[0].map(h=>h.trim()),idx=k=>head.indexOf(k);
    const iName=idx('현지어이름'),iDob=idx('생년월일');
    if(iName<0||iDob<0)throw 0;
    const iCode=idx('아동코드'),iSex=idx('성별'),iSite=idx('사업장코드');
    const out=rows.slice(1).map((r,n)=>({
      아동코드:(iCode>=0?r[iCode]:'')||`HQ-${n+1}`,
      현지어이름:r[iName]||'',생년월일:r[iDob]||'',성별:iSex>=0?r[iSex]:'',
      사업장코드:iSite>=0?r[iSite]:''
    })).filter(r=>r.현지어이름||r.생년월일);
    if(!out.length)throw 0;
    await DB.bulk('roster',out);
    state.roster=await DB.all('roster');
    state.rosterDate=today();
    await DB.put('kv',state.rosterDate,'rosterDate');
    toast(f('impDone',{'%n':out.length}));show('home');
  }catch(e){toast(t('impFail'));}
}

/* ══════════════ 바탕화면에 추가 ══════════════
   안드로이드 크롬은 브라우저가 설치 기회를 넘겨줍니다(beforeinstallprompt).
   아이폰 사파리는 그 기능이 없어 직접 하는 방법을 그림처럼 안내합니다. */
let installEvt=null;
const isStandalone=()=>
  (self.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||
  (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const showInstall=()=>!isStandalone()&&!state.instHide;

window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();installEvt=e;
  if(state.view==='home')renderHome();
});
window.addEventListener('appinstalled',()=>{
  installEvt=null;state.instHide=true;
  toast(t('instDone'));
  if(state.view==='home')renderHome();
});

function instCard(){
  if(!showInstall())return '';
  return `<div class="install" id="instCard">
    <h3>${t('instTitle')}</h3>
    <p>${t('instBody')}</p>
    <div class="two">
      <button class="primary" id="bInst">${t('instBtn')}</button>
      <button class="ghost" id="bInstLater">${t('instLater')}</button>
    </div>
    <div id="instHelp"></div></div>`;
}
async function installAsk(btn){
  /* 브라우저가 설치 기회를 넘겨준 경우 — 버튼 한 번으로 끝납니다 */
  if(installEvt){
    installEvt.prompt();
    const r=await installEvt.userChoice.catch(()=>null);
    installEvt=null;
    if(r&&r.outcome==='accepted'){state.instHide=true;toast(t('instDone'));}
    return render();
  }
  /* 아이폰이거나 지원하지 않는 브라우저 — 직접 하는 방법을 보여줍니다 */
  const ios=isIOS(),box=$('instHelp');
  if(box)box.innerHTML=`<div class="insthelp">
    <h4>${t(ios?'instIosTitle':'instEtcTitle')}</h4>
    ${(ios?['instIos1','instIos2','instIos3']:['instEtc1','instEtc2'])
      .map(k=>`<p>${t(k)}</p>`).join('')}
    ${ios?`<p class="note">${t('instIosNote')}</p>`:''}
  </div>`;
  if(btn)btn.disabled=true;
}
function bindInstall(){
  const b=$('bInst'); if(!b)return;
  $('bInstLater').onclick=()=>{state.instHide=true;renderHome();};
  b.onclick=()=>installAsk(b);
}

/* ══════════════ 직원용 설치 링크 ══════════════
   본부 주소와 전송키를 링크 하나에 담습니다. 직원은 열기만 하면 됩니다.
   주소창에 키가 남지 않도록, 읽어서 저장한 뒤 곧바로 지웁니다. */
const b64e=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o))))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64d=t=>JSON.parse(decodeURIComponent(escape(
  atob(t.replace(/-/g,'+').replace(/_/g,'/')))));

function setupLink(){
  return location.origin+location.pathname+'#setup='+b64e({u:state.hqUrl,k:state.hqKey});
}
/* 링크로 들어온 경우 — 설정을 심고 주소를 깨끗하게 만듭니다 */
async function readSetupLink(){
  const m=/[#&]setup=([A-Za-z0-9\-_]+)/.exec(location.hash||'');
  if(!m)return false;
  history.replaceState(null,'',location.pathname+location.search);
  try{
    const o=b64d(m[1]);
    if(!o||!o.u)return false;
    state.hqUrl=o.u;state.hqKey=o.k||'';
    await saveSettings();
    toast(t('linkApplied'));
    return true;
  }catch(e){return false;}
}

/* ══════════════════════════════════════════════════════════════
   관리자 페이지
   국가·사업장 목록과 등록 항목의 사용 여부를 정합니다.
   기본 목록은 그대로 두고 '꺼둔 것'과 '더한 것'만 저장하므로
   언제든 초기화하면 처음 상태로 돌아갑니다.
   ══════════════════════════════════════════════════════════════ */
const usedCountries=()=>new Set(state.records.map(r=>r.국가코드).concat(state.roster.map(r=>r.국가코드)));
const usedSites=()=>new Set(state.records.map(r=>r.사업장코드).concat(state.roster.map(r=>r.사업장코드)));

function renderAdmin(){
  if(!state.adminOk)return renderAdminLock();
  const tab=state.adminTab;
  $('vHome').innerHTML=`
    <p class="eyebrow">${t('adminEyebrow')}</p><h1>${t('adminTitle')}</h1>
    <p class="lede">${state.hqUrl?t('pubBody'):t('adminNote')}</p>
    <div class="scope" style="margin-bottom:18px">
      <button id="tP" aria-pressed="${tab==='place'}">${t('tabPlace')}</button>
      <button id="tE" aria-pressed="${tab==='etc'}">${t('tabEtc')}</button>
    </div>
    <div id="adminBody"></div>
    <div class="mt16"><button class="ghost" id="aLock">${t('adminLock')}</button></div>`;
  $('tP').onclick=()=>{state.adminTab='place';state.adminAdd='';render();};
  $('tE').onclick=()=>{state.adminTab='etc';state.adminAdd='';render();};
  $('aLock').onclick=()=>{state.adminOk=false;show('home');};
  ({place:adminPlace,etc:adminEtc})[tab]();
}

function renderAdminLock(){
  $('vHome').innerHTML=`
    <p class="eyebrow">${t('adminEyebrow')}</p><h1>${t('adminTitle')}</h1>
    <p class="lede">${t('adminPinAsk')}</p>
    <div class="field"><label class="lbl" for="aPin">${t('adminPin')}</label>
      <input type="password" id="aPin" inputmode="numeric"></div>
    <p class="err" id="ePin"></p>
    <button class="primary" id="aGo">${t('adminEnter')}</button>
    <div class="mt10"><button class="ghost" id="aBack">${t('backBtn')}</button></div>`;
  const go=()=>{
    if($('aPin').value===state.cfg.pin){state.adminOk=true;render();}
    else{const e=$('ePin');e.textContent=t('adminWrong');e.classList.add('show');}};
  $('aGo').onclick=go;
  $('aPin').onkeydown=e=>{if(e.key==='Enter')go();};
  $('aBack').onclick=()=>show('home');
}

/* ── 국가·사업장 ── */
function adminPlace(){
  const offC=state.cfg.off.countries, offS=state.cfg.off.sites;
  const addedC=state.cfg.add.countries.map(c=>c.code), addedS=state.cfg.add.sites.map(s=>s.code);
  const uC=usedCountries(), uS=usedSites();
  const row=(o,isOff,added,used,type)=>`
    <div class="arow ${isOff?'off':''}">
      <div class="arow-m">
        <div class="arow-n">${esc(nm(o))} ${added?`<span class="src dev">${t('addedMark')}</span>`:''}</div>
        <div class="arow-c">${esc(o.code)}${type==='site'?' · '+esc(countryName(o.country)):''}</div>
      </div>
      <button type="button" class="tog ${isOff?'':'on'}" data-tg="${type}:${o.code}">
        ${isOff?t('notUse'):t('inUse')}</button>
      ${added&&!used?`<button type="button" class="del" data-rm="${type}:${o.code}">${t('removeItem')}</button>`:''}
    </div>`;

  $('adminBody').innerHTML=`
    ${state.hqUrl?`<p class="hint" style="margin-bottom:12px">${t('fromHq')}</p>`:''}
    <div class="list-h"><h2>${t('cList')}</h2><span>${onCountries().length} / ${allCountries().length}</span></div>
    ${allCountries().map(c=>row(c,offC.includes(c.code),addedC.includes(c.code),uC.has(c.code),'country')).join('')}
    ${state.adminAdd==='country'?addForm('country'):`<button class="ghost mt8" id="addC">${t('addCountry')}</button>`}

    <div class="list-h"><h2>${t('sList')}</h2><span>${onSites().length} / ${allSites().length}</span></div>
    ${allSites().map(s=>row(s,offS.includes(s.code),addedS.includes(s.code),uS.has(s.code),'site')).join('')}
    ${state.adminAdd==='site'?addForm('site'):`<button class="ghost mt8" id="addS">${t('addSite')}</button>`}`;

  const bc=$('addC'); if(bc)bc.onclick=()=>{state.adminAdd='country';render();};
  const bs=$('addS'); if(bs)bs.onclick=()=>{state.adminAdd='site';render();};
  bindAddForm();

  $('adminBody').querySelectorAll('[data-tg]').forEach(el=>{
    el.onclick=async()=>{
      const [type,code]=el.dataset.tg.split(':');
      const list=type==='country'?state.cfg.off.countries:state.cfg.off.sites;
      const i=list.indexOf(code);
      if(i<0)list.push(code); else list.splice(i,1);
      /* 국가를 끄면 그 나라 사업장도 함께 꺼둡니다 */
      if(type==='country'&&i<0)allSites().filter(s=>s.country===code)
        .forEach(s=>{if(!state.cfg.off.sites.includes(s.code))state.cfg.off.sites.push(s.code);});
      await saveCfg();
      if(type==='site'&&code===state.site&&i<0)toast(t('offWarn'));
      render();};});

  $('adminBody').querySelectorAll('[data-rm]').forEach(el=>{
    el.onclick=async()=>{
      const [type,code]=el.dataset.rm.split(':');
      const used=type==='country'?usedCountries():usedSites();
      if(used.has(code))return toast(t('cantRemove'));
      const arr=type==='country'?state.cfg.add.countries:state.cfg.add.sites;
      const i=arr.findIndex(o=>o.code===code);
      if(i>=0)arr.splice(i,1);
      await saveCfg();render();};});
}

function addForm(type){
  return `<div class="exp mt8">
    <div class="field"><label class="lbl" for="nCode">${t('fCode')}</label>
      <p class="hint">${t('fCodeHint')}</p>
      <input type="text" id="nCode" maxlength="4" placeholder="${type==='country'?'RWA':'KGL'}"></div>
    ${type==='site'?`<div class="field"><label class="lbl" for="nCountry">${t('fCountry')}</label>
      <select id="nCountry">${onCountries().map(c=>`<option value="${c.code}">${nm(c)} (${c.code})</option>`).join('')}</select></div>`:''}
    <div class="field"><label class="lbl" for="nKo">${t('fKo')}</label>
      <input type="text" id="nKo"></div>
    <div class="field"><label class="lbl" for="nEn">${t('fEn')}</label>
      <input type="text" id="nEn"></div>
    <p class="err" id="eAdd"></p>
    <div class="qc-btns"><button class="primary" id="nOk" data-add="${type}">${t('addOk')}</button>
      <button class="ghost" id="nNo">${t('cancel')}</button></div></div>`;
}
function bindAddForm(){
  const ok=$('nOk'); if(!ok)return;
  $('nNo').onclick=()=>{state.adminAdd='';render();};
  ok.onclick=async()=>{
    const type=ok.dataset.add;
    const code=$('nCode').value.trim().toUpperCase(),
          ko=$('nKo').value.trim(), en=$('nEn').value.trim()||ko;
    const e=$('eAdd');
    const bad=m=>{e.textContent=m;e.classList.add('show');};
    if(!/^[A-Z]{2,4}$/.test(code))return bad(t('errCode'));
    if(allCountries().concat(allSites()).some(o=>o.code===code))return bad(t('errDupCode'));
    if(!ko)return bad(t('errName'));
    if(type==='country')state.cfg.add.countries.push({code,ko,en});
    else state.cfg.add.sites.push({code,country:$('nCountry').value,ko,en});
    await saveCfg();
    state.adminAdd='';toast(t('adminSaved'));render();};
}

/* ── 관리 ── */
function adminEtc(){
  $('adminBody').innerHTML=`
    <div class="exp"><h3>${t('pubTitle')}</h3>
      <p>${state.hqUrl?t('pubBody'):t('pubNoUrl')}</p>
      <p class="qc-note">${f('revNow',{'%n':state.cfg.rev||0})}</p>
      <button class="ghost jade" id="cPub" ${state.hqUrl?'':'disabled'}>${t('pubBtn')}</button>
      <div class="mt8"><button class="ghost" id="cPull" ${state.hqUrl?'':'disabled'}>${t('pullBtn')}</button></div>
    </div>
    <div class="exp"><h3>${t('pinChange')}</h3>
      <input type="text" id="pNew" placeholder="${esc(t('pinNew'))}">
      <p class="err" id="ePNew"></p>
      <button class="ghost jade mt8" id="pSave">${t('adminEnter')}</button></div>
    <div class="exp"><h3>${t('linkTitle')}</h3>
      <p>${state.hqUrl?t('linkBody'):t('linkNoUrl')}</p>
      <button class="ghost jade" id="lMake" ${state.hqUrl?'':'disabled'}>${t('linkMake')}</button>
      <div id="linkOut"></div></div>
    <div class="exp"><h3>${t('cfgExport')}</h3>
      <p>${t('adminNote')}</p>
      <button class="ghost jade" id="cOut">${t('cfgExport')}</button></div>
    <div class="exp"><h3>${t('cfgImport')}</h3>
      <button class="ghost jade" id="cIn">${t('cfgImport')}</button></div>
    <div class="exp"><h3>${t('cfgReset')}</h3>
      <p>${t('cfgResetAsk')}</p>
      <button class="ghost rust" id="cRst">${t('cfgReset')}</button></div>`;
  const lm=$('lMake');
  if(lm)lm.onclick=()=>{
    const url=setupLink();
    $('linkOut').innerHTML=`
      <div class="linkbox">${esc(url)}</div>
      <div class="qc-btns"><button class="ghost jade" id="lCopy">${t('linkCopy')}</button></div>
      <div class="qrbox" id="qr"></div>
      <p class="qc-note">${t('linkQr')} ${t('linkPrint')}</p>
      <div class="safeguard" style="margin-top:10px">${t('linkWarn')}</div>`;
    try{
      const q=qrcode(0,'M');q.addData(url);q.make();
      $('qr').innerHTML=q.createSvgTag({scalable:true});
    }catch(e){$('qr').textContent='QR: '+e.message;}
    $('lCopy').onclick=async()=>{
      try{await navigator.clipboard.writeText(url);toast(t('linkCopied'));}
      catch(e){const r=document.createRange();r.selectNodeContents($('linkOut').firstElementChild);
        const sel=getSelection();sel.removeAllRanges();sel.addRange(r);}};
  };
  const pub=$('cPub');
  if(pub)pub.onclick=async()=>{
    const pin=prompt(t('pubAsk'));
    if(pin===null)return;
    pub.disabled=true;
    const r=await Sync.pushConfig(pin).catch(e=>({ok:false,error:String(e)}));
    pub.disabled=false;
    if(r&&r.ok)toast(f('pubDone',{'%n':r.rev}));
    else toast(f('pubFail',{'%e':(r&&r.error)||'?'}));
    render();};
  const pull=$('cPull');
  if(pull)pull.onclick=async()=>{
    const ch=await Sync.pullConfig().catch(()=>false);
    toast(ch?t('pullDone'):t('pullSame'));render();};
  $('pSave').onclick=async()=>{
    const v=$('pNew').value.trim();
    if(v.length<4){const e=$('ePNew');e.textContent=t('pinShort');e.classList.add('show');return;}
    state.cfg.pin=v;await saveCfg();toast(t('pinSaved'));render();};
  $('cOut').onclick=()=>dl('아동등록앱_설정.json',
    new Blob([JSON.stringify({_설정:'child-intake',...state.cfg},null,2)],{type:'application/json'}));
  $('cIn').onclick=()=>$('fCfg').click();
  $('cRst').onclick=async()=>{
    state.cfg=newCfg();await saveCfg();toast(t('cfgResetOk'));render();};
}
async function importCfg(file){
  try{
    const o=JSON.parse(await file.text());
    if(o._설정!=='child-intake')throw 0;
    state.cfg={...newCfg(),...o};delete state.cfg._설정;
    await saveCfg();toast(t('cfgImported'));render();
  }catch(e){toast(t('cfgBad'));}
}

/* ══════════════ 단계 ══════════════ */
function renderStep(){
  const key=STEPS[state.step];
  $('rail').innerHTML=STEPS.map((_,i)=>`<div class="${i<state.step?'done':i===state.step?'now':''}"></div>`).join('');
  $('stepNo').innerHTML=f('stepOf',{'%a':state.step+1,'%b':STEPS.length})+`<span class="saved" id="savedTag"></span>`;
  $('stepTitle').textContent=t('st_'+key);
  $('stepLede').textContent=t('st_'+key+'_l');
  $('btnBack').textContent=t('back');
  $('btnNext').textContent=state.step===STEPS.length-1?t('finish'):t('next');
  $('stepBody').innerHTML=({basic:sBasic,photo:sPhoto,family:sFamily,edu:sEdu,story:sStory,consent:sConsent})[key]();
  bindIn($('stepBody'));
  ['현지어이름','생년월일'].forEach(k=>{const el=$('f_'+k);if(el)el.onblur=refreshDup;});
  window.scrollTo({top:0,behavior:'instant'});
}

function txt(k,label,o={}){return `<div class="field">
  <label class="lbl" for="f_${k}">${label}${o.req?' <span class="req">*</span>':''}</label>
  ${o.hint?`<p class="hint">${o.hint}</p>`:''}
  <input type="${o.type||'text'}" id="f_${k}" data-k="${k}" value="${esc(d()[k])}" placeholder="${esc(o.ph||'')}">
  <p class="err" id="e_${k}"></p></div>`;}
function area(k,label,o={}){return `<div class="field">
  <label class="lbl" for="f_${k}">${label}${o.req?' <span class="req">*</span>':''}</label>
  ${o.hint?`<p class="hint">${o.hint}</p>`:''}
  <textarea id="f_${k}" data-k="${k}" placeholder="${esc(o.ph||'')}">${esc(d()[k])}</textarea>
  <p class="err" id="e_${k}"></p></div>`;}
function chips(k,label,o={}){return `<div class="field">
  <p class="lbl">${label}${o.req?' <span class="req">*</span>':''}</p>
  ${o.hint?`<p class="hint">${o.hint}</p>`:''}
  <div class="chips" data-c="${k}">${L[k].map(v=>`<button type="button" class="chip" data-v="${esc(v)}" aria-pressed="${d()[k]===v}">${esc(ov(k,v))}</button>`).join('')}</div>
  <p class="err" id="e_${k}"></p></div>`;}
/* 여러 개를 함께 고르는 선택지 — 값은 쉼표로 이어 붙여 한 칸에 저장합니다 */
const mvals=k=>String(d()[k]||'').split(',').map(v=>v.trim()).filter(Boolean);
function multi(k,label,o={}){
  const on=mvals(k);
  return `<div class="field">
  <p class="lbl">${label}${o.req?' <span class="req">*</span>':''}</p>
  ${o.hint?`<p class="hint">${o.hint}</p>`:''}
  <div class="chips" data-m="${k}">${L[k].map(v=>`<button type="button" class="chip" data-v="${esc(v)}" aria-pressed="${on.includes(v)}">${esc(ov(k,v))}</button>`).join('')}</div>
  <p class="err" id="e_${k}"></p></div>`;}
function shot(id,fld,title,sub,ar){return d()[fld]
  ? `<div class="shot filled" style="aspect-ratio:${ar}"><img src="${src(d()[fld])}" alt="">
     <button class="retake" data-s="${id}">${t('retake')}</button></div>`
  : `<button type="button" class="shot" style="aspect-ratio:${ar}" data-s="${id}">
     <span class="shot-i">📷</span><span class="shot-t">${title}</span><span class="shot-s">${sub}</span></button>`;}

/* ── 사진 자동 점검 결과 ── */
const QC_KIND={_face:'face',_full:'full',_cons:'cons'};
const QC_SHOT={_face:'face',_full:'full',_cons:'cons'};
const qcMsg=it=>S['qc_'+it.id+'_'+it.level]?t('qc_'+it.id+'_'+it.level):t('qc_'+it.id);
function qcBox(fld){
  const q=(d()._qc||{})[fld];
  if(!q)return '';
  if(q.busy)return `<div class="qc busy">${t('qcChecking')}</div>`;
  if(q.worst==='ok')return `<div class="qc ok">✓ ${t('qcOk')}</div>`;
  return `<div class="qc ${q.worst==='bad'?'bad':'warn'}">
    <h4>${t(q.worst==='bad'?'qcBadTitle':'qcWarnTitle')}</h4>
    <ul>${q.items.map(i=>`<li>${qcMsg(i)}</li>`).join('')}</ul>
    ${q.accepted?`<p class="qc-acc">✓ ${t('qcAccepted')}</p>`
      :`<div class="qc-btns">
          <button type="button" class="ghost rust" data-s="${QC_SHOT[fld]}">${t('qcRetake')}</button>
          <button type="button" class="ghost" data-qa="${fld}">${t('qcAccept')}</button>
        </div>`}
    <p class="qc-note">${t('qcPrivacy')}</p></div>`;
}
async function runCheck(fld,blob){
  const own=()=>d()&&d()[fld]===blob;
  d()._qc=d()._qc||{};d()._qc[fld]={busy:true};
  if(state.view==='step')renderStep();
  let r;
  try{r=await PhotoCheck.analyse(blob,QC_KIND[fld]);}
  catch(e){r={worst:'ok',items:[]};}
  if(!own())return;
  d()._qc[fld]={worst:r.worst,items:r.items.map(i=>({id:i.id,level:i.level})),accepted:false};
  saveDraft(true);
  if(state.view==='step')renderStep();
}
/* 시트 비고에 남길 한 줄 요약 (본부가 검수 때 봅니다) */
function qcNote(r,fld){
  const q=(r._qc||{})[fld];
  if(!q||q.busy)return '';
  if(q.worst==='ok')return '자동점검 통과';
  return '자동점검 '+(q.worst==='bad'?'경고':'주의')+': '+q.items.map(i=>i.id).join('/')
       +(q.accepted?' (담당자 확인 후 사용)':'');
}

function sBasic(){
  return `<div class="codebox"><p>${t('assigned')}</p><b>${t('codePending')}</b>
      <small>${t('assignedNote')}</small></div><div id="dupBox">${dupHTML()}</div>`
   + txt('현지어이름',t('localName'),{req:true,hint:t('localNameHint'),ph:t('localNamePh')})
   + chips('성별',t('sex'),{req:true})
   + txt('생년월일',t('dob'),{req:true,type:'date'})
   + `<label class="check ${d().생년월일추정==='예'?'on':''}" data-f="생년월일추정" style="margin:-6px 0 16px">
        <input type="checkbox" ${d().생년월일추정==='예'?'checked':''}><span>${t('dobEst')}</span></label>`
   + chips('출생등록',t('birthReg'),{req:true});
}
function sPhoto(){
  const g=['solo','face','light','dress','bg'];
  return shot('face','_face',t('shotFace'),t('shotFaceSub'),'3/4')
   + qcBox('_face')
   + `<p class="err" id="e_face"></p>
      <div class="mt10">${shot('full','_full',t('shotFull'),t('shotFullSub'),'3/4')}${qcBox('_full')}</div>
      <div class="guide"><h3>${t('guideTitle')}</h3><p>${t('guideSub')}</p>
        ${g.map(k=>`<label class="check ${d()._guide[k]?'on':''}" data-g="${k}">
          <input type="checkbox" ${d()._guide[k]?'checked':''}><span>${t('g_'+k)}</span></label>`).join('')}
        <p class="err" id="e_guide"></p></div>
      <div class="safeguard">${t('safeguard')}</div>`;
}
function sFamily(){
  return txt('동거가족수',t('household'),{req:true,type:'number',ph:'5'})
   + txt('가족구성',t('familyMake'),{req:true,hint:t('familyMakeHint'),ph:t('familyMakePh')});
}
function sEdu(){
  const att=d().취학여부==='다니고있음';
  const dis=d().건강상태==='장애';
  return chips('취학여부',t('inSchool'),{req:true})
   + (att?txt('학교명',t('schoolName'),{req:true,ph:t('schoolNamePh')})
        + txt('학년',t('grade'),{req:true,ph:t('gradePh')}):'')
   + chips('건강상태',t('health'),{req:true})
   + (dis?multi('장애명',t('disability'),{req:true,hint:t('disabilityHint')}):'')
   + txt('신장',t('height'),{req:true,type:'number',ph:'120'})
   + txt('체중',t('weight'),{req:true,type:'number',ph:'25'});
}
function sStory(){
  return txt('장래희망',t('dream'),{req:true,ph:t('dreamPh')})
   + txt('좋아하는과목',t('subject'),{req:true,ph:t('subjectPh')})
   + txt('좋아하는색깔',t('color'),{req:true,ph:t('colorPh')})
   + txt('취미',t('hobby'),{req:true,ph:t('hobbyPh')});
}
function sConsent(){
  const x=d();
  const gaps=[[!x._face,t('shotFace')],[!x.현지어이름,t('localName')],[!x.생년월일,t('dob')],
              [!x.장래희망,t('dream')],[!x.가족구성,t('familyMake')]]
    .filter(a=>a[0]).map(a=>f('gapItem',{'%s':a[1]}));
  const a=age(x.생년월일),v=(val,fb)=>val?esc(val):`<span class="gap">${fb}</span>`;
  const school=x.취학여부==='다니고있음'
    ? [x.학교명,x.학년].filter(Boolean).join(' · ') : ov('취학여부',x.취학여부);
  const health=x.건강상태==='장애'
    ? mvals('장애명').map(v=>ov('장애명',v)).join(', ') : ov('건강상태',x.건강상태);
  return `<p class="eyebrow">${t('previewEyebrow')}</p>
    <div class="pcard">
      <div class="pc-top"><span>${t('profile')}</span><b>${esc(x.아동코드||t('codePending'))}</b></div>
      <div class="pc-body">
        ${x._face?`<img class="pc-photo" src="${src(x._face)}" alt="">`:`<div class="pc-photo gap">${t('noPhotoBox')}</div>`}
        <div style="min-width:0;flex:1">
          <div class="pc-name">${v(x.현지어이름,t('noName'))}</div>
          <div class="pc-sub">${countryName(x.국가코드)}${a!==null?` · ${a}${t('yrs')}`:''}</div>
          <dl class="dl">
            <div><dt>${t('fDream')}</dt><dd>${v(x.장래희망,t('blank'))}</dd></div>
            <div><dt>${t('fSchool')}</dt><dd>${v(school,t('blank'))}</dd></div>
            <div><dt>${t('fFamily')}</dt><dd>${v(x.가족구성,t('blank'))}</dd></div>
            <div><dt>${t('fHealth')}</dt><dd>${v(health,t('blank'))}</dd></div>
          </dl></div></div>
    </div>
    ${gaps.length?`<ul class="gaps">${gaps.map(g=>`<li>${g}</li>`).join('')}</ul>`:''}
    <h2 style="margin:24px 0 4px">${t('consentTitle')}</h2>
    <p class="hint" style="margin-bottom:12px">${t('consentSub')}</p>
    ${shot('cons','_cons',t('shotCons'),t('shotConsSub'),'16/10')}
    ${qcBox('_cons')}
    <p class="err" id="e_cons"></p>
    <div class="mt10">
    ${[['보호자동의','c_guardian'],['아동동의','c_child'],['활용동의','c_use']]
      .map(([k,s])=>`<label class="check ${x[k]==='예'?'on':''}" data-f="${k}">
        <input type="checkbox" ${x[k]==='예'?'checked':''}><span>${t(s)}</span></label>`).join('')}
    </div><p class="err" id="e_consent"></p>`;
}

function refreshDup(){const box=$('dupBox');if(!box)return;box.innerHTML=dupHTML();bindIn(box);}

function bindIn(root){
  root.querySelectorAll('[data-k]').forEach(el=>{
    el.oninput=e=>{d()[e.target.dataset.k]=e.target.value;e.target.classList.remove('invalid');
      const x=$('e_'+e.target.dataset.k);if(x)x.classList.remove('show');saveDraft();};});
  root.querySelectorAll('[data-c]').forEach(box=>{
    box.onclick=e=>{const b=e.target.closest('.chip');if(!b)return;
      const k=box.dataset.c;d()[k]=b.dataset.v;
      box.querySelectorAll('.chip').forEach(c=>c.setAttribute('aria-pressed',c===b));
      const x=$('e_'+k);if(x)x.classList.remove('show');saveDraft();
      if(k==='취학여부'||k==='건강상태')return renderStep();
      if(k==='성별')refreshDup();};});
  root.querySelectorAll('[data-m]').forEach(box=>{
    box.onclick=e=>{const b=e.target.closest('.chip');if(!b)return;
      const k=box.dataset.m,v=b.dataset.v;
      const on=String(d()[k]||'').split(',').map(x=>x.trim()).filter(Boolean);
      const i=on.indexOf(v);
      if(i<0)on.push(v);else on.splice(i,1);
      d()[k]=on.join(', ');
      b.setAttribute('aria-pressed',i<0);
      const x=$('e_'+k);if(x)x.classList.remove('show');saveDraft();};});
  root.querySelectorAll('[data-g]').forEach(el=>{
    el.onchange=e=>{d()._guide[el.dataset.g]=e.target.checked;
      el.classList.toggle('on',e.target.checked);$('e_guide').classList.remove('show');saveDraft();};});
  root.querySelectorAll('[data-f]').forEach(el=>{
    el.onchange=e=>{d()[el.dataset.f]=e.target.checked?'예':'아니오';
      el.classList.toggle('on',e.target.checked);
      const x=$('e_consent');if(x)x.classList.remove('show');saveDraft();};});
  root.querySelectorAll('[data-qa]').forEach(el=>{
    el.onclick=()=>{const q=(d()._qc||{})[el.dataset.qa];if(!q)return;
      q.accepted=true;saveDraft(true);renderStep();};});
  root.querySelectorAll('[data-s]').forEach(el=>{
    el.onclick=()=>({face:$('fFace'),full:$('fFull'),cons:$('fCons')})[el.dataset.s].click();});
}

/* ══════════════ 검증 ══════════════ */
/* 심각 판정은 다시 찍거나 담당자가 명시적으로 승인해야 넘어갑니다 */
function qcCleared(fld){const q=(d()._qc||{})[fld];
  return !q||q.busy||q.worst!=='bad'||q.accepted;}
function fail(k,m){const el=$('f_'+k);if(el)el.classList.add('invalid');
  const e=$('e_'+k);if(e){e.textContent=m;e.classList.add('show');}}
function validate(){
  const x=d();let ok=true;
  const need=ks=>ks.forEach(k=>{if(!String(x[k]||'').trim()){fail(k,t('errRequired'));ok=false;}});
  const num=ks=>ks.forEach(k=>{const v=String(x[k]||'').trim();
    if(v&&!(Number(v)>0)){fail(k,t('errNumber'));ok=false;}});
  switch(STEPS[state.step]){
    case 'basic':
      need(['현지어이름','성별','생년월일','출생등록']);
      refreshDup();
      if(findDup(x).strong.length){
        if(x.중복확인===L.중복확인[1])return'stop';
        if(x.중복확인!==L.중복확인[0]){
          const e=$('e_중복확인');if(e){e.textContent=t('dupErrPick');e.classList.add('show');}ok=false;}
        if(!x.중복확인메모){fail('중복확인메모',t('dupErrNote'));ok=false;}
      }
      break;
    case 'photo':
      if(!x._face){const e=$('e_face');e.textContent=t('errFace');e.classList.add('show');ok=false;}
      else if(!qcCleared('_face')){const e=$('e_face');e.textContent=t('qcBlocked');e.classList.add('show');ok=false;}
      if(!Object.values(x._guide).every(Boolean)){
        const e=$('e_guide');e.textContent=t('errGuide');e.classList.add('show');ok=false;}
      break;
    case 'family':
      need(['동거가족수','가족구성']);num(['동거가족수']);break;
    case 'edu':
      need(['취학여부','건강상태','신장','체중']);
      num(['신장','체중']);
      if(x.취학여부==='다니고있음')need(['학교명','학년']);
      /* 건강상태가 '장애'면 유형을 반드시 골라야 합니다 */
      if(x.건강상태==='장애'&&!mvals('장애명').length){
        const e=$('e_장애명');if(e){e.textContent=t('errDisability');e.classList.add('show');}ok=false;}
      break;
    case 'story':
      need(['장래희망','좋아하는과목','좋아하는색깔','취미']);break;
    case 'consent':
      if(!x._cons){const e=$('e_cons');e.textContent=t('errCons');e.classList.add('show');ok=false;}
      else if(!qcCleared('_cons')){const e=$('e_cons');e.textContent=t('qcBlocked');e.classList.add('show');ok=false;}
      if(!(x.보호자동의==='예'&&x.아동동의==='예'&&x.활용동의==='예')){
        const e=$('e_consent');e.textContent=t('errConsent');e.classList.add('show');ok=false;}
      break;
  }
  if(!ok)toast(t('errFix'));
  return ok;
}

async function finishChild(){
  const x=d();
  if(!x.생년월일추정)x.생년월일추정='아니오';
  if(x.취학여부!=='다니고있음'){x.학교명='';x.학년='';}
  if(x.건강상태!=='장애')x.장애명='';
  /* 아동코드·연번·사진파일명은 본부가 도착 순서대로 부여합니다 */
  x.아동코드='';x.연번='';x.대표사진='';x.동의서사진='';
  x._exp=null;x._sync='pending';
  await DB.put('records',x);
  state.records.push(x);
  await dropDraft();
  toast(f('savedLocal',{'%n':esc(x.현지어이름||'')}));
  show('home');
  runSync(false);
}

/* 전송 실행 — manual=true 면 결과를 사용자에게 알립니다 */
async function runSync(manual){
  if(!state.hqUrl){if(manual)toast(t('hqNotSet'));return;}
  if(Sync.isRunning())return;
  if(!Sync.pending().length){if(manual)toast(t('syncNothing'));return;}
  if(!navigator.onLine){if(manual)toast(t('syncOffline'));return;}
  state.syncing=true;if(state.view==='home')renderHome();
  const r=await Sync.run({onProgress:(i,n)=>{const b=$('bSync');
    if(b)b.textContent=f('syncProgress',{'%i':i,'%n':n});}});
  state.syncing=false;
  if(state.view==='home')renderHome();
  if(!r)return;
  if(r.sent&&!r.failed)toast(f('syncDone',{'%n':r.sent}));
  else if(r.failed)toast(f('syncPartial',{'%s':r.sent,'%f':r.failed}));
}

/* ══════════════ 백업 내려받기 ══════════════ */
const fileBase=r=>r.아동코드||('임시-'+String(r._id||'').slice(0,8));
function photoRows(r){
  const day=r.등록일.replace(/-/g,''),base=fileBase(r),out=[];let n=1;
  const add=(type,sfx,note)=>out.push({사진ID:`${base}-P${String(n++).padStart(3,'0')}`,
    아동코드:r.아동코드,촬영일:r.등록일,사진유형:type,
    사진파일:`${base}_${day}_${sfx}.jpg`,촬영자:r.등록담당자,촬영기준확인:'예',비고:note||''});
  const j=(base,fld)=>[base,qcNote(r,fld)].filter(Boolean).join(' · ');
  if(r._face)add('신규-상반신','face',j('신규수급 등록 시 촬영','_face'));
  if(r._full)add('신규-전신','full',j('','_full'));
  if(r._cons)add('동의서','consent',j('보호자 서명본','_cons'));
  return out;
}
function csv(cols,rows){
  const q=v=>{v=v==null?'':String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
  return '\uFEFF'+[cols.join(',')].concat(rows.map(r=>cols.map(c=>q(r[c])).join(','))).join('\r\n');
}
function dl(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);}

function renderExport(){
  const list=state.records,photos=list.flatMap(photoRows);
  $('vExport').innerHTML=`
    <p class="eyebrow">${t('expEyebrow')}</p><h1>${t('backupTitle')}</h1>
    <p class="lede">${t('backupLede')}</p>
    <p class="hint">${f('expCount',{'%n':list.length,'%p':photos.length})}</p>
    <div class="exp"><h3>${t('exp1')}</h3><p>${t('exp1b')}</p>
      <button class="ghost jade" id="e1">${t('exp1c')}</button></div>
    <div class="exp"><h3>${t('exp2')}</h3><p>${t('exp2b')}</p>
      <button class="ghost jade" id="e2">${t('exp2c')}</button></div>
    <div class="exp"><h3>${t('exp3')}</h3><p>${t('exp3b')}</p>
      <button class="ghost jade" id="e3">${f('exp3c',{'%p':photos.length})}</button></div>
    <div class="mt16"><button class="ghost" id="eBack">${t('backBtn')}</button></div>`;
  $('e1').onclick=()=>{if(!list.length)return toast(t('noRecords'));
    dl('아동마스터.csv',new Blob([csv(MASTER_COLS,list)],{type:'text/csv;charset=utf-8'}));};
  $('e2').onclick=()=>{if(!list.length)return toast(t('noRecords'));
    dl('사진.csv',new Blob([csv(PHOTO_COLS,photos)],{type:'text/csv;charset=utf-8'}));};
  $('e3').onclick=async()=>{
    if(!photos.length)return toast(t('noRecords'));
    toast(t('zipping'));
    const zip=new JSZip();
    list.forEach(r=>{const day=r.등록일.replace(/-/g,'');
      const key=fileBase(r);
      [['_face','face'],['_full','full'],['_cons','consent']].forEach(([k,sf])=>{
        if(r[k])zip.file(`${key}_${day}_${sf}.jpg`,r[k]);});});
    dl('사진.zip',await zip.generateAsync({type:'blob'}));};
  $('eBack').onclick=()=>show('home');
}

/* ══════════════ 상단·하단 버튼 ══════════════ */
$('btnBack').onclick=async()=>{
  if(state.step===0){await dropDraft();return show('home');}
  state.step--;saveDraft(true);renderStep();};
$('btnNext').onclick=async()=>{
  const v=validate();
  if(v==='stop'){await dropDraft();toast(t('dupStop'));return show('home');}
  if(!v)return;
  if(state.step<STEPS.length-1){state.step++;saveDraft(true);return renderStep();}
  finishChild();};
$('btnSize').onclick=()=>{state.big=!state.big;
  document.documentElement.style.setProperty('--fs',state.big?'1.18':'1');
  $('btnSize').setAttribute('aria-pressed',state.big);saveSettings();};
$('btnLang').onclick=()=>{state.lang=state.lang==='en'?'ko':'en';
  document.documentElement.lang=state.lang;saveSettings();render();};

[['fFace','_face'],['fFull','_full'],['fCons','_cons']].forEach(([id,fld])=>{
  $(id).onchange=async e=>{const file=e.target.files[0];if(!file)return;
    const b=await compress(file);e.target.value='';
    if(!b)return toast(t('photoFail'));
    d()[fld]=b;saveDraft(true);renderStep();runCheck(fld,b);};});
$('fCfg').onchange=e=>{const f=e.target.files[0];if(f)importCfg(f);e.target.value='';};
$('fCsv').onchange=e=>{const file=e.target.files[0];if(file)importCSV(file);e.target.value='';};

window.addEventListener('online',()=>{topbar();runSync(false);});
window.addEventListener('offline',topbar);

/* ══════════════ 시작 ══════════════ */
(async function init(){
  if(location.protocol==='file:'){
    document.body.innerHTML='<div style="padding:28px;font-family:sans-serif;line-height:1.6">'+
      '<h2>웹 주소로 열어주세요</h2><p>파일을 두 번 눌러 여는 방식(file://)에서는 브라우저가 저장 기능을 막습니다. '+
      'GitHub Pages 등에 올린 주소로 접속한 뒤 홈 화면에 추가해 사용하세요.</p></div>';
    return;
  }
  try{await DB.open();}
  catch(e){alert('저장소를 열 수 없습니다. 브라우저의 시크릿 모드를 끄고 다시 열어주세요.');return;}

  state.cfg={...newCfg(),...((await DB.get('kv','config'))||{})};
  const s=await DB.get('kv','settings');
  if(s)Object.assign(state,s);
  await readSetupLink();
  /* data.js 의 SERVER 에 값을 넣어두면 직원이 주소를 입력하지 않아도 됩니다 */
  if(!state.hqUrl&&typeof SERVER!=='undefined'&&SERVER.url){
    state.hqUrl=SERVER.url;state.hqKey=SERVER.key||'';}
  document.documentElement.lang=state.lang;
  if(state.big){document.documentElement.style.setProperty('--fs','1.18');
    $('btnSize').setAttribute('aria-pressed','true');}

  const ord=r=>r._createdAt||(r.등록일+' '+(r._id||''));
  state.records=((await DB.all('records'))||[]).sort((a,b)=>ord(a)<ord(b)?-1:1);
  state.roster=(await DB.all('roster'))||[];
  state.rosterDate=(await DB.get('kv','rosterDate'))||'';

  const dr=await DB.get('kv','draft');
  if(dr&&dr.data){state.draft=dr.data;state.step=dr.step||0;}

  show(state.site?'home':'setup');

  if(state.hqUrl&&navigator.onLine)
    Sync.pullConfig().then(ch=>{if(ch&&state.view!=='step')render();}).catch(()=>{});
  if(typeof PhotoCheck!=='undefined')PhotoCheck.init('facefinder');
  if(state.hqUrl&&navigator.onLine)setTimeout(()=>runSync(false),1500);
  if(navigator.storage&&navigator.storage.persist)navigator.storage.persist();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
