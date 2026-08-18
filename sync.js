/* ══════════════════════════════════════════════════════════════
   본부 전송 — 아동코드는 본부(Apps Script)가 도착 순서대로 부여합니다.
   · 등록은 항상 오프라인으로 끝납니다. 전송은 그 뒤의 별개 단계입니다.
   · 같은 건을 몇 번 보내도 기록ID로 알아보고 한 줄만 남습니다.
   · 실패해도 데이터는 폰에 그대로 남아 다음 기회에 다시 보냅니다.
   ══════════════════════════════════════════════════════════════ */
const Sync=(function(){

let running=false;

const b64=blob=>new Promise((res,rej)=>{
  const r=new FileReader();
  r.onload=()=>res(String(r.result).split(',')[1]||'');
  r.onerror=()=>rej(new Error('photo'));
  r.readAsDataURL(blob);
});

/* 사진과 내부 필드(_로 시작)를 뺀 순수 데이터만 보냅니다 */
function payload(r){
  const out={};
  MASTER_COLS.forEach(k=>{if(k!=='아동코드'&&k!=='연번')out[k]=r[k]||'';});
  out.기록ID=r._id;
  out.국가코드=r.국가코드;out.사업장코드=r.사업장코드;
  return out;
}

async function post(url,body){
  const res=await fetch(url,{method:'POST',redirect:'follow',
    headers:{'Content-Type':'text/plain;charset=utf-8'},   /* Apps Script 는 preflight 를 못 받습니다 */
    body:JSON.stringify(body)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const j=await res.json();
  if(!j||j.ok!==true)throw new Error((j&&j.error)||'서버 오류');
  return j;
}

async function sendOne(rec,url,key){
  const photos={};
  if(rec._face)photos.face=await b64(rec._face);
  if(rec._full)photos.full=await b64(rec._full);
  if(rec._cons)photos.consent=await b64(rec._cons);
  const j=await post(url,{action:'record',key,record:payload(rec),photos,
                          qc:qcSummary(rec)});
  rec.아동코드=j.아동코드||'';
  rec.연번=j.연번||'';
  rec.상태=j.상태||rec.상태;
  rec.대표사진=j.대표사진||'';
  rec.동의서사진=j.동의서사진||'';
  rec._sync='sent';
  rec._sentAt=new Date().toISOString();
  return rec;
}

function qcSummary(r){
  const out={};
  ['_face','_full','_cons'].forEach(f=>{const n=qcNote(r,f);if(n)out[f.slice(1)]=n;});
  return out;
}

const pending=()=>state.records.filter(r=>r._sync!=='sent');

/* 대기열을 한 건씩 보냅니다. 한 건이 실패해도 나머지는 계속 시도합니다. */
async function run(opts){
  const o=opts||{};
  if(running)return null;
  if(!state.hqUrl)return null;
  const queue=pending();
  if(!queue.length&&!o.rosterOnly)return {sent:0,failed:0};
  running=true;state.syncing=true;state.syncErr='';
  if(o.onProgress)o.onProgress(0,queue.length);
  let sent=0,failed=0,lastErr='';
  for(let i=0;i<queue.length;i++){
    try{
      await sendOne(queue[i],state.hqUrl,state.hqKey);
      await DB.put('records',queue[i]);
      sent++;
    }catch(e){failed++;lastErr=e.message||String(e);
      queue[i]._sync='error';queue[i]._syncErr=lastErr;}
    if(o.onProgress)o.onProgress(i+1,queue.length);
  }
  try{await roster();}catch(e){}
  running=false;state.syncing=false;state.syncErr=failed?lastErr:'';
  state.lastSync=today();
  await saveSettings();
  return {sent,failed,error:lastErr};
}

/* 전송하는 김에 사업장 명단을 받아와 오프라인 중복 검사에 씁니다 */
async function roster(){
  if(!state.hqUrl)return 0;
  const j=await post(state.hqUrl,{action:'roster',key:state.hqKey,site:state.site});
  const rows=(j.roster||[]).filter(r=>r.현지어이름||r.생년월일);
  if(!rows.length)return 0;
  await DB.clear('roster');
  await DB.bulk('roster',rows.map((r,i)=>({아동코드:r.아동코드||('HQ-'+i),
    현지어이름:r.현지어이름||'',생년월일:r.생년월일||'',성별:r.성별||'',
    사업장코드:r.사업장코드||''})));
  state.roster=(await DB.all('roster'))||[];
  state.rosterDate=today();
  await DB.put('kv',state.rosterDate,'rosterDate');
  return rows.length;
}

async function test(url,key){
  const j=await post(url,{action:'ping',key});
  return j.site||j.sheet||'ok';
}

return {run,roster,pending,test,isRunning:()=>running};
})();
