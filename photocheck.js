/* ══════════════════════════════════════════════════════════════
   사진 자동 점검 — 전부 휴대폰 안에서 처리됩니다. 사진은 어디로도 전송되지 않습니다.
   흔들림 · 밝기 · 역광 : 픽셀 계산
   얼굴 · 구도            : pico.js (MIT, github.com/nenadmarkus/picojs)
   ══════════════════════════════════════════════════════════════ */
const PhotoCheck=(function(){

const W=480;              /* 점검용 축소 폭 — 기기가 달라도 같은 기준으로 재기 위해 고정 */
let classify=null,loading=null;

/* ── 캐스케이드 적재 ── */
function init(url){
  if(classify)return Promise.resolve(true);
  if(loading)return loading;
  loading=fetch(url||'facefinder').then(r=>r.arrayBuffer())
    .then(b=>{classify=pico.unpack_cascade(new Int8Array(b));return true;})
    .catch(()=>{classify=null;return false;});
  return loading;
}
function initFromBytes(buf){try{classify=pico.unpack_cascade(new Int8Array(buf));return true;}
  catch(e){classify=null;return false;}}
const faceReady=()=>!!classify;

/* ── 픽셀 계산 (순수 함수 — 테스트 대상) ── */
function gray(data,w,h){
  const g=new Uint8Array(w*h);
  for(let i=0,p=0;i<g.length;i++,p+=4)
    g[i]=(data[p]*306+data[p+1]*601+data[p+2]*117)>>10;
  return g;
}

/* 라플라시안 분산 = 초점/흔들림 지표. 어두운 사진에서 과소평가되지 않도록
   화면 대비(표준편차)로 정규화한 값을 함께 씁니다. */
function sharpness(g,w,h){
  let s=0,s2=0,n=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    const v=4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w];
    s+=v;s2+=v*v;n++;
  }
  const varLap=s2/n-(s/n)*(s/n);
  let m=0,m2=0;
  for(let i=0;i<g.length;i++){m+=g[i];m2+=g[i]*g[i];}
  m/=g.length;
  const std=Math.sqrt(Math.max(0,m2/g.length-m*m));
  /* 대비 대비 선명도 — 저조도 사진을 흔들림으로 오판하지 않게 합니다 */
  const rel=varLap/Math.max(1,std*std);
  return {varLap:+varLap.toFixed(1),std:+std.toFixed(1),rel:+rel.toFixed(4)};
}

function exposure(g,w,h){
  let sum=0,dark=0,bright=0;
  for(let i=0;i<g.length;i++){const v=g[i];sum+=v;if(v<24)dark++;if(v>247)bright++;}
  const n=g.length,mean=sum/n;
  /* 가운데(피사체)와 가장자리(배경) 밝기 차 → 역광 판정 */
  const cx=w/2,cy=h*0.45,rx=w*0.30,ry=h*0.36;
  let cs=0,cn=0,bs=0,bn=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const dx=(x-cx)/rx,dy=(y-cy)/ry,v=g[y*w+x];
    if(dx*dx+dy*dy<=1){cs+=v;cn++;}else{bs+=v;bn++;}
  }
  const center=cn?cs/cn:mean,border=bn?bs/bn:mean;
  return {mean:+mean.toFixed(1),dark:+(dark/n).toFixed(3),bright:+(bright/n).toFixed(3),
          center:+center.toFixed(1),border:+border.toFixed(1),gap:+(border-center).toFixed(1)};
}

/* pico 의 캐스케이드는 똑바로 선 정면 얼굴만 찾습니다. 손으로 찍은 사진은 대부분
   조금씩 기울어 있으므로, 못 찾으면 이미지를 돌려가며 다시 찾습니다. */
function rotate(g,w,h,deg){
  const out=new Uint8Array(w*h),a=-deg*Math.PI/180,
        co=Math.cos(a),si=Math.sin(a),cx=w/2,cy=h/2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const dx=x-cx,dy=y-cy;
    const sx=Math.round(cx+dx*co-dy*si),sy=Math.round(cy+dx*si+dy*co);
    out[y*w+x]=(sx>=0&&sx<w&&sy>=0&&sy<h)?g[sy*w+sx]:128;
  }
  return out;
}
function detect(g,w,h,minRatio,qmin){
  const img={pixels:g,nrows:h,ncols:w,ldim:w};
  const params={shiftfactor:0.1,minsize:Math.round(Math.min(w,h)*(minRatio||0.10)),
                maxsize:Math.round(Math.min(w,h)*1.0),scalefactor:1.1};
  return pico.cluster_detections(pico.run_cascade(img,classify,params),0.2)
    .filter(d=>d[3]>qmin).map(d=>({y:d[0],x:d[1],size:d[2],q:+d[3].toFixed(1)}));
}
function faces(g,w,h,minRatio,qmin){
  if(!classify)return null;
  const q=qmin===undefined?40:qmin;
  for(const deg of [0,18,-18,36,-36]){
    const src=deg?rotate(g,w,h,deg):g;
    let ds=detect(src,w,h,minRatio,q);
    if(!ds.length)continue;
    if(deg){ /* 찾은 좌표를 원래 사진 기준으로 되돌립니다 */
      const a=deg*Math.PI/180,co=Math.cos(a),si=Math.sin(a),cx=w/2,cy=h/2;
      ds=ds.map(f=>{const dx=f.x-cx,dy=f.y-cy;
        return {...f,x:cx+dx*co-dy*si,y:cy+dx*si+dy*co,tilt:deg};});
    }
    return ds.sort((a,b)=>b.size-a.size);
  }
  return [];
}

/* 구도 — 얼굴 크기와 위치로 상반신 여부를 판단합니다 */
function framing(fs,w,h,kind){
  if(!fs||!fs.length)return null;
  const f=fs[0],ratio=f.size/h,
        cxr=f.x/w, cyr=f.y/h,
        cropTop=f.y-f.size/2<-f.size*0.10,
        cropSide=f.x-f.size/2<-f.size*0.10||f.x+f.size/2>w+f.size*0.10;
  let fit='ok';
  if(kind==='full'){ if(ratio>0.45)fit='close'; }
  else{ if(ratio<0.16)fit='far'; else if(ratio>0.62)fit='close'; }
  return {ratio:+ratio.toFixed(3),cx:+cxr.toFixed(2),cy:+cyr.toFixed(2),
          fit,cropTop,cropSide,offCenter:cxr<0.20||cxr>0.80,low:cyr>0.72};
}

/* ── 종합 판정 ──
   반환 items: [{id, level:'bad'|'warn'|'ok'}] — 문구는 앱에서 붙입니다. */
function judge(m,kind){
  const it=[],add=(id,level)=>it.push({id,level});
  const ex=m.exposure,sh=m.sharpness;

  const darkBad=ex.mean<52||ex.dark>0.42;
  if(darkBad)add('dark','bad');
  else if(ex.mean<72)add('dark','warn');
  else if(ex.mean>212||ex.bright>0.28)add('bright','warn');

  /* 대비가 거의 없는 사진 = 렌즈가 가려졌거나 아무것도 찍히지 않은 상태.
     어두운 사진은 위에서 이미 잡았으므로 중복해서 알리지 않습니다. */
  if(sh.std<15){ if(!darkBad)add('lowcontrast','bad'); }
  else if(sh.rel<0.022)add('blur','bad');
  else if(sh.rel<0.045)add('blur','warn');

  if(ex.gap>42)add('backlit','bad');
  else if(ex.gap>26)add('backlit','warn');

  if(kind!=='cons'){
    if(!m.faceReady)add('noengine','warn');
    else if(!m.faces.length)add('noface','warn');
    else{
      if(m.faces.length>1)add('manyfaces','warn');
      const fr=m.framing;
      if(fr.fit==='far')add('far','warn');
      else if(fr.fit==='close')add('close','warn');
      if(fr.cropTop)add('croptop','warn');
      else if(fr.cropSide)add('cropside','warn');
      if(fr.offCenter||fr.low)add('offcenter','warn');
    }
  }
  const lv=it.map(i=>i.level);
  return {items:it.filter(i=>i.level!=='ok'),
          worst:lv.includes('bad')?'bad':lv.includes('warn')?'warn':'ok'};
}

function measure(g,w,h,kind){
  const m={sharpness:sharpness(g,w,h),exposure:exposure(g,w,h),faceReady:faceReady()};
  m.faces=kind==='cons'?[]:(faces(g,w,h,kind==='full'?0.07:0.10)||[]);
  m.framing=framing(m.faces,w,h,kind);
  return m;
}

/* ── 브라우저용 진입점 ── */
async function analyse(blob,kind){
  let img;
  try{img=await createImageBitmap(blob);}
  catch(e){
    img=await new Promise((res,rej)=>{const u=URL.createObjectURL(blob),i=new Image();
      i.onload=()=>{URL.revokeObjectURL(u);res(i);};i.onerror=rej;i.src=u;});
  }
  const s=Math.min(1,W/Math.max(img.width,img.height));
  const w=Math.max(1,Math.round(img.width*s)),h=Math.max(1,Math.round(img.height*s));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const cx=c.getContext('2d',{willReadFrequently:true});
  cx.drawImage(img,0,0,w,h);
  if(img.close)img.close();
  const g=gray(cx.getImageData(0,0,w,h).data,w,h);
  const m=measure(g,w,h,kind);
  const j=judge(m,kind);
  return {...j,measure:m,size:{w,h}};
}

return {init,initFromBytes,analyse,faceReady,_p:{gray,sharpness,exposure,faces,framing,judge,measure}};
})();
