/* =====================================================================
   Trazza — app (rediseño function-first)
   GPS del móvil (~1 Hz) -> detección de vueltas por aproximación a la meta
   (TrazzaDetect) + delta predictivo por distancia + mini-mapa + export.
   ===================================================================== */
'use strict';

const DEFAULTS = { radius:30, minLap:20, units:'kmh', sound:true, haptic:true, wakelock:true, sim:false };
const TRACK_PRESETS = [
  { id:'cartagena', name:'Circuito de Cartagena', sub:'Recta principal', lat:37.6444, lon:-1.0352 },
];
const LS_SETTINGS='trazza.settings.v2', LS_SESSIONS='trazza.sessions.v2', LS_METAS='trazza.metas.v2';

let settings = Object.assign({}, DEFAULTS, loadJSON(LS_SETTINGS, {}));
settings.sim = false; // el modo demo nunca persiste

let selectedMeta = null;   // {lat,lon,name}
let viewingSessionId = null;

const live = {
  running:false, gate:null, detector:null,
  laps:[], best:null, bestProfile:null,
  lapStartT:null, lapNum:0, cumDist:0, samples:[], prevFix:null,
  track:[], speedMax:0, startedAt:null, rafId:null, wakeLock:null,
};
let metaTrack = []; // traza reciente para el mini-mapa de meta

/* ----------------------------- utils ----------------------------- */
function loadJSON(k,f){ try{ const v=JSON.parse(localStorage.getItem(k)); return v??f; }catch(e){ return f; } }
function saveJSON(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
function $(s,r=document){ return r.querySelector(s); }
function $all(s,r=document){ return [...r.querySelectorAll(s)]; }
function toast(m,ms=2200){ const t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),ms); }

function fmtLap(ms){
  if(ms==null||!isFinite(ms)) return '--';
  const neg=ms<0; ms=Math.abs(ms);
  const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000), mil=Math.floor(ms%1000);
  return (neg?'-':'')+m+':'+String(s).padStart(2,'0')+'.'+String(mil).padStart(3,'0');
}
function splitLap(ms){ const f=fmtLap(ms); const i=f.lastIndexOf('.'); return i<0?{main:f,ms:''}:{main:f.slice(0,i),ms:f.slice(i)}; }
function fmtDelta(ms){ const s=ms/1000; return (s>=0?'+':'−')+Math.abs(s).toFixed(2).replace('.',','); }
function speedFactor(){ return settings.units==='mph'?2.23694:3.6; }
function speedUnit(){ return settings.units==='mph'?'mph':'km/h'; }
function fmtSpeed(mps){ return mps==null?'--':Math.round(mps*speedFactor()); }

/* ----------------------------- GPS manager ----------------------------- */
const GPS = {
  watchId:null, active:false, usingSim:false, last:null, hz:0, lastT:null,
  start(){
    if(this.active && this.usingSim===!!settings.sim) return;
    this.stop();
    this.usingSim = !!settings.sim;
    this.active = true;
    if(settings.sim && window.TrazzaSim){
      window.TrazzaSim.start(f=>this.handle(f));
    } else if('geolocation' in navigator){
      this.watchId = navigator.geolocation.watchPosition(
        p=>this.handle(this.toFix(p)),
        e=>this.error(e),
        { enableHighAccuracy:true, maximumAge:0, timeout:15000 }
      );
    } else {
      toast('Este dispositivo no tiene GPS');
    }
  },
  stop(){
    if(window.TrazzaSim && window.TrazzaSim.active) window.TrazzaSim.stop();
    if(this.watchId!=null){ navigator.geolocation.clearWatch(this.watchId); this.watchId=null; }
    this.active=false;
  },
  toFix(p){ const c=p.coords; return { lat:c.latitude, lon:c.longitude, t:p.timestamp||Date.now(),
    acc:c.accuracy, spd:(c.speed!=null&&c.speed>=0)?c.speed:null }; },
  handle(fix){
    const now=fix.t;
    if(this.lastT){ const dt=(now-this.lastT)/1000; if(dt>0) this.hz = this.hz?0.7*this.hz+0.3*(1/dt):1/dt; }
    this.lastT=now; this.last=fix;
    updateGpsUI(fix);
    if(live.running) liveFix(fix);
    if($('#screen-meta').classList.contains('active')){
      metaTrack.push(fix); if(metaTrack.length>80) metaTrack.shift();
      drawMetaMap();
    }
    refreshStartState();
  },
  error(e){
    let m='Error de GPS';
    if(e.code===1) m='Permiso de ubicación denegado';
    else if(e.code===2) m='Sin señal GPS';
    else if(e.code===3) m='GPS sin respuesta';
    setPill('#gps-pill', 'bad', 'ERROR'); $('#gps-hint').textContent=m; toast(m);
  },
};

/* ----------------------------- UI de GPS ----------------------------- */
function accClass(acc){ return acc<=8?'ok':acc<=20?'wait':'bad'; }
function accLabel(acc){ return acc<=8?'FIX BUENO':acc<=20?'FIX DÉBIL':'FIX POBRE'; }
function setPill(sel, cls, text){ const p=$(sel); if(!p) return; p.className=p.className.replace(/\b(ok|wait|bad)\b/g,'').trim()+' '+cls; $('span',p).textContent=text; }

function updateGpsUI(fix){
  const c=accClass(fix.acc);
  setPill('#gps-pill', c, accLabel(fix.acc));
  $('#gps-acc').textContent=fix.acc.toFixed(1);
  $('#gps-hz').textContent=(GPS.hz?GPS.hz.toFixed(1):'--')+' Hz';
  $('#gps-spd').textContent=fmtSpeed(fix.spd)+' '+speedUnit();
  $('#gps-hint').textContent = fix.acc<=8 ? 'Señal lista para cronometrar' : fix.acc<=20 ? 'Señal aceptable, mejor esperar' : 'Señal pobre, espera a cielo abierto';
  // pill del HUD
  const hp=$('#hud-gps'); if(hp){ hp.className='fixpill sm '+c; $('#hud-gps-text').textContent='±'+fix.acc.toFixed(1)+' m'; }
}

function refreshStartState(){
  const btn=$('#btn-start'), reason=$('#start-reason');
  let ok=true, msg='';
  if(!GPS.last){ ok=false; msg='Esperando señal GPS…'; }
  else if(GPS.last.acc>30){ ok=false; msg='Señal GPS débil (±'+GPS.last.acc.toFixed(0)+' m)'; }
  else if(!selectedMeta){ ok=false; msg='Marca o elige una meta'; }
  else { msg='Listo · '+selectedMeta.name; }
  btn.disabled=!ok; reason.textContent=msg;
  // botón marcar (pantalla meta)
  const mh=$('#btn-mark-here'), mr=$('#mark-reason');
  if(mh){ const can=GPS.last && GPS.last.acc<=25; mh.disabled=!can;
    mr.textContent = !GPS.last?'Esperando señal GPS…':(GPS.last.acc>25?'Señal débil (±'+GPS.last.acc.toFixed(0)+' m)':'Ponte sobre la línea y marca'); }
}

/* ----------------------------- Wake lock / avisos ----------------------------- */
async function acquireWake(){ if(!settings.wakelock) return; try{ if('wakeLock' in navigator) live.wakeLock=await navigator.wakeLock.request('screen'); }catch(e){} }
async function releaseWake(){ try{ if(live.wakeLock){ await live.wakeLock.release(); live.wakeLock=null; } }catch(e){} }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&live.running) acquireWake(); });

let audioCtx=null;
function beep(kind){
  if(!settings.sound) return;
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const mk=(freq,t0,t1)=>{ const o=audioCtx.createOscillator(),g=audioCtx.createGain(); o.connect(g);g.connect(audioCtx.destination);
      o.type='square'; o.frequency.value=freq;
      g.gain.setValueAtTime(0.0001,audioCtx.currentTime+t0); g.gain.exponentialRampToValueAtTime(0.25,audioCtx.currentTime+t0+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+t1); o.start(audioCtx.currentTime+t0); o.stop(audioCtx.currentTime+t1+0.02); };
    mk(kind==='best'?1320:880,0,0.22);
    if(kind==='best') mk(1760,0.26,0.5);
  }catch(e){}
}
function haptic(p){ if(settings.haptic&&navigator.vibrate) navigator.vibrate(p); }

/* ----------------------------- Sesión en vivo ----------------------------- */
function startSession(){
  if(!selectedMeta){ toast('Marca o elige una meta'); return; }
  if(!GPS.last){ toast('Esperando GPS'); return; }
  Object.assign(live,{
    running:true, gate:{...selectedMeta},
    detector:new TrazzaDetect.LapDetector({ lat:selectedMeta.lat, lon:selectedMeta.lon, radius:settings.radius, minLapMs:settings.minLap*1000 }),
    laps:[], best:null, bestProfile:null,
    lapStartT:null, lapNum:0, cumDist:0, samples:[{d:0,t:0}], prevFix:null,
    track:[], speedMax:0, startedAt:Date.now(),
  });
  viewingSessionId=null;
  resetHud();
  show('hud');
  acquireWake();
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
  GPS.start(); // asegura modo correcto (real/sim)
  startClock();
  toast('A pista. El crono arranca en tu primer paso por meta', 2800);
}

function liveFix(fix){
  live.track.push({ t:fix.t, lat:fix.lat, lon:fix.lon, acc:fix.acc, spd:fix.spd });
  if(fix.spd!=null) live.speedMax=Math.max(live.speedMax, fix.spd);
  $('#hud-spd').textContent=fmtSpeed(fix.spd);
  $('#hud-spdmax').textContent=fmtSpeed(live.speedMax);

  // distancia acumulada de la vuelta (con filtro de ruido)
  if(live.prevFix && live.lapStartT!=null){
    const d=TrazzaDetect.haversine(live.prevFix.lat,live.prevFix.lon,fix.lat,fix.lon);
    if(d>1.5){ live.cumDist+=d; }
    const elapsed=fix.t-live.lapStartT;
    live.samples.push({ d:live.cumDist, t:elapsed });
    if(live.bestProfile){
      const ref=TrazzaDetect.interpProfile(live.bestProfile, live.cumDist);
      if(ref!=null) setDelta(elapsed-ref);
    }
  }
  live.prevFix=fix;

  // detección de cruce
  const ev=live.detector.update(fix);
  if(ev) onCrossing(ev);
}

function onCrossing(ev){
  if(ev.kind==='start'){
    live.lapStartT=ev.t; live.lapNum=1; live.cumDist=0; live.samples=[{d:0,t:0}];
    $('#hud-lapnum').textContent='VUELTA 01';
    haptic(60); beep('lap'); toast('¡Cronómetro en marcha!');
    return;
  }
  // cierra vuelta
  const lapMs=ev.lapMs;
  // finaliza perfil de la vuelta cerrada
  live.samples.push({ d:live.cumDist, t:lapMs });
  const isBest = live.best==null || lapMs<live.best;
  live.laps.push({ n:ev.lapNum, ms:lapMs });
  if(isBest){ live.best=lapMs; live.bestProfile=live.samples.slice(); }

  flashHud(); haptic(isBest?[60,40,60]:80); beep(isBest?'best':'lap');
  toast((isBest?'¡Mejor vuelta! ':'Vuelta '+ev.lapNum+' · ')+fmtLap(lapMs), 2600);

  // siguiente vuelta
  live.lapStartT=ev.t; live.lapNum=ev.lapNum+1; live.cumDist=0; live.samples=[{d:0,t:0}];
  $('#hud-lapnum').textContent='VUELTA '+String(live.lapNum).padStart(2,'0');
  renderHudLastBest();
  persistSession(false);
}

function renderHudLastBest(){
  const last=live.laps.length?live.laps[live.laps.length-1].ms:null;
  const sl=splitLap(last); $('#hud-last').innerHTML = last==null?'--':`${sl.main}<span class="ms">${sl.ms}</span>`;
  const sb=splitLap(live.best); $('#hud-best').innerHTML = live.best==null?'--':`${sb.main}<span class="ms">${sb.ms}</span>`;
}
function setDelta(ms){
  const card=$('#hud-delta'), num=$('#hud-delta-num');
  card.classList.remove('good','bad'); num.classList.remove('good','bad');
  if(ms==null){ num.textContent='--'; return; }
  num.textContent=fmtDelta(ms);
  if(ms<0){ card.classList.add('good'); num.classList.add('good'); }
  else { card.classList.add('bad'); num.classList.add('bad'); }
}
function resetHud(){
  $('#hud-cur').innerHTML='0:00<span class="ms">.000</span>';
  $('#hud-lapnum').textContent='VUELTA 00';
  $('#hud-last').innerHTML='--'; $('#hud-best').innerHTML='--';
  $('#hud-spd').textContent='0'; $('#hud-spdmax').textContent='0';
  $('#hud-spd-unit').textContent=speedUnit().toUpperCase();
  setDelta(null);
}
function flashHud(){ const h=$('#screen-hud'); h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash'); }
function startClock(){
  cancelAnimationFrame(live.rafId);
  const tick=()=>{
    if(!live.running) return;
    if(live.lapStartT!=null){ const sl=splitLap(Date.now()-live.lapStartT); $('#hud-cur').innerHTML=`${sl.main}<span class="ms">${sl.ms}</span>`; }
    live.rafId=requestAnimationFrame(tick);
  };
  live.rafId=requestAnimationFrame(tick);
}

function stopSession(){
  if(!live.running) return;
  const ev=live.detector && live.detector.flush(); if(ev) onCrossing(ev);
  live.running=false;
  cancelAnimationFrame(live.rafId);
  releaseWake();
  const saved=persistSession(true);
  renderSummary(saved); show('summary');
}

/* ----------------------------- Persistencia ----------------------------- */
let currentId=null;
function persistSession(finalize){
  const sessions=loadJSON(LS_SESSIONS,[]);
  const data={
    id: currentId || ('s'+live.startedAt),
    name: live.gate.name, startedAt: live.startedAt, endedAt: finalize?Date.now():null,
    laps: live.laps.map(l=>({n:l.n, ms:l.ms})), best: live.best,
    speedMaxKmh: Math.round(live.speedMax*3.6),
    gate:{ lat:live.gate.lat, lon:live.gate.lon }, track: live.track,
  };
  currentId=data.id;
  const i=sessions.findIndex(s=>s.id===data.id);
  if(i>=0) sessions[i]=data; else sessions.unshift(data);
  saveJSON(LS_SESSIONS, sessions.slice(0,30));
  if(finalize) currentId=null;
  return data;
}
function renderSessions(){
  const list=$('#session-list'), sessions=loadJSON(LS_SESSIONS,[]);
  if(!sessions.length){ list.innerHTML='<div class="empty">Aún no tienes sesiones. Sal a pista y marca tu primera vuelta.</div>'; return; }
  list.innerHTML='';
  sessions.forEach(s=>{
    const d=new Date(s.startedAt);
    const date=d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'}).toUpperCase().replace('.','');
    const el=document.createElement('div'); el.className='sess';
    el.innerHTML=`<div class="top"><div class="nm">${esc(s.name)}</div><div class="dt">${date}</div></div>
      <div class="st"><div><span class="k">Mejor</span><div class="v green">${fmtLap(s.best)}</div></div>
      <div><span class="k">Vueltas</span><div class="v">${s.laps.length}</div></div></div>`;
    el.addEventListener('click',()=>{ renderSummary(s); show('summary'); });
    list.appendChild(el);
  });
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderSummary(s){
  if(!s) return; viewingSessionId=s.id;
  $('#sum-title').textContent=s.name;
  $('#sum-best').textContent=fmtLap(s.best);
  const valid=s.laps.filter(l=>l.ms>0);
  const avg=valid.length?valid.reduce((a,l)=>a+l.ms,0)/valid.length:null;
  $('#sum-avg').textContent=fmtLap(avg);
  $('#sum-count').textContent=s.laps.length;
  $('#sum-vmax').textContent=(s.speedMaxKmh!=null?Math.round(s.speedMaxKmh*(settings.units==='mph'?0.621371:1)):'--')+' '+speedUnit();

  const wrap=$('#sum-laps'); wrap.innerHTML='';
  if(!s.laps.length) wrap.innerHTML='<div class="empty">No se registraron vueltas completas. Revisa la posición de la meta.</div>';
  s.laps.forEach(l=>{
    const isBest=l.ms===s.best, delta=l.ms-s.best;
    let cls='best',txt='MEJOR';
    if(!isBest){ const sec=delta/1000; txt='+'+sec.toFixed(2); cls=sec>=1?'worse':'close'; }
    const row=document.createElement('div'); row.className='lap'+(isBest?' best':'');
    row.innerHTML=`<span class="ln">${String(l.n).padStart(2,'0')}</span><div class="rt"><span class="lt">${fmtLap(l.ms)}</span><span class="dl ${cls}">${txt}</span></div>`;
    wrap.appendChild(row);
  });

  $('#btn-csv').onclick=()=>exportCSV(s);
  $('#btn-gpx').onclick=()=>exportGPX(s);
  requestAnimationFrame(()=>drawMap($('#sum-map'), (s.track||[]), s.gate, settings.radius));
}

/* ----------------------------- Export ----------------------------- */
function download(name,text,type){ const b=new Blob([text],{type:type||'text/plain'}); const u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(u);a.remove();},500); }
function slug(s){ return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function exportCSV(s){
  const d=new Date(s.startedAt).toISOString().slice(0,16).replace(/[:T]/g,'-');
  let csv='vuelta,tiempo_ms,tiempo,delta_ms,mejor\n';
  s.laps.forEach(l=>{ csv+=`${l.n},${Math.round(l.ms)},"${fmtLap(l.ms)}",${Math.round(l.ms-s.best)},${l.ms===s.best?'1':'0'}\n`; });
  download(`trazza-${slug(s.name)}-${d}-vueltas.csv`,csv,'text/csv'); toast('CSV descargado');
}
function exportGPX(s){
  const d=new Date(s.startedAt).toISOString().slice(0,16).replace(/[:T]/g,'-');
  let g=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trazza" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(s.name)}</name><trkseg>\n`;
  (s.track||[]).forEach(p=>{ g+=`<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time>`; if(p.spd!=null) g+=`<extensions><speed>${p.spd}</speed></extensions>`; g+=`</trkpt>\n`; });
  g+=`</trkseg></trk>\n</gpx>\n`;
  download(`trazza-${slug(s.name)}-${d}-track.gpx`,g,'application/gpx+xml'); toast('GPX descargado');
}

/* ----------------------------- Mini-mapa ----------------------------- */
function drawMap(canvas, pts, finish, radiusM){
  if(!canvas) return;
  const dpr=window.devicePixelRatio||1;
  const W=canvas.clientWidth, H=canvas.clientHeight;
  if(!W||!H) return;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext && canvas.getContext('2d'); if(!ctx) return;
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);

  const all=pts.slice(); if(finish) all.push(finish);
  if(!all.length) return;
  const lat0=all.reduce((s,p)=>s+p.lat,0)/all.length, k=Math.cos(lat0*Math.PI/180);
  let minX=Math.min(...all.map(p=>p.lon*k)), maxX=Math.max(...all.map(p=>p.lon*k));
  let minY=Math.min(...all.map(p=>p.lat)),     maxY=Math.max(...all.map(p=>p.lat));
  const minSpan=0.0016;
  if(maxX-minX<minSpan*k){ const c=(maxX+minX)/2; minX=c-minSpan*k/2; maxX=c+minSpan*k/2; }
  if(maxY-minY<minSpan){ const c=(maxY+minY)/2; minY=c-minSpan/2; maxY=c+minSpan/2; }
  const pad=22, spanX=maxX-minX, spanY=maxY-minY;
  const scale=Math.min((W-2*pad)/spanX,(H-2*pad)/spanY);
  const offX=(W-spanX*scale)/2, offY=(H-spanY*scale)/2;
  const toPx=p=>({ x:offX+(p.lon*k-minX)*scale, y:H-(offY+(p.lat-minY)*scale) });

  if(pts.length>1){ ctx.beginPath(); pts.forEach((p,i)=>{ const q=toPx(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y); });
    ctx.strokeStyle='#1FE0C8'; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); }
  if(finish){ const f=toPx(finish); const rpx=(radiusM/111320)*scale;
    ctx.beginPath(); ctx.arc(f.x,f.y,Math.max(rpx,5),0,2*Math.PI); ctx.strokeStyle='rgba(31,224,200,.55)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(f.x,f.y,6,0,2*Math.PI); ctx.fillStyle='#B6FF1A'; ctx.fill(); }
  if(pts.length){ const c=toPx(pts[pts.length-1]); ctx.beginPath(); ctx.arc(c.x,c.y,6,0,2*Math.PI);
    ctx.fillStyle='#F5F7FA'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='#0E0F12'; ctx.stroke(); }
}
function drawMetaMap(){
  const finish = selectedMeta || (GPS.last?{lat:GPS.last.lat,lon:GPS.last.lon}:null);
  drawMap($('#meta-map'), metaTrack.map(f=>({lat:f.lat,lon:f.lon})), finish, settings.radius);
}

/* ----------------------------- Meta (marcar / elegir) ----------------------------- */
function markHere(){
  if(!GPS.last){ toast('Esperando GPS'); return; }
  selectedMeta={ lat:GPS.last.lat, lon:GPS.last.lon, name:'Mi posición' };
  const metas=loadJSON(LS_METAS,[]); metas.unshift({...selectedMeta, name:'Meta '+new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}), at:Date.now()});
  saveJSON(LS_METAS, metas.slice(0,8));
  $('#btn-confirm-meta').disabled=false; renderSaved(); drawMetaMap();
  toast('Meta marcada en tu posición'); haptic(40);
}
function chooseMeta(m, name){ selectedMeta={ lat:m.lat, lon:m.lon, name:name||m.name }; $('#btn-confirm-meta').disabled=false; drawMetaMap(); }
function confirmMeta(){
  if(!selectedMeta){ toast('Elige o marca una meta'); return; }
  $('#meta-name').textContent=selectedMeta.name;
  $('#meta-sub').textContent=`${selectedMeta.lat.toFixed(5)}, ${selectedMeta.lon.toFixed(5)} · radio ${settings.radius} m`;
  refreshStartState(); show('home'); toast('Meta seleccionada');
}
function renderPresets(){
  const list=$('#preset-list'); list.innerHTML='';
  TRACK_PRESETS.forEach(p=>{
    const el=document.createElement('div'); el.className='preset'+(selectedMeta&&selectedMeta.name===p.name?' sel':'');
    el.innerHTML=`<div><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.sub)} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div></div>
      <svg class="tick" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B6FF1A" stroke-width="2.4"><path d="M5 12l5 5 9-9"/></svg>`;
    el.addEventListener('click',()=>{ chooseMeta(p,p.name); markSelectedPreset(); });
    list.appendChild(el);
  });
}
function renderSaved(){
  const list=$('#saved-list'), metas=loadJSON(LS_METAS,[]);
  $('#saved-divider').hidden = metas.length===0;
  list.innerHTML='';
  metas.forEach(m=>{
    const el=document.createElement('div'); el.className='preset';
    el.innerHTML=`<div><div class="nm">${esc(m.name)}</div><div class="sub">${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}</div></div>
      <svg class="tick" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B6FF1A" stroke-width="2.4"><path d="M5 12l5 5 9-9"/></svg>`;
    el.addEventListener('click',()=>{ chooseMeta(m,m.name); });
    list.appendChild(el);
  });
}
function markSelectedPreset(){ $all('.preset').forEach(e=>e.classList.remove('sel')); }

/* ----------------------------- Ajustes ----------------------------- */
function renderSettings(){
  $('#set-radius').textContent=settings.radius+' m';
  $('#set-minlap').textContent=settings.minLap+' s';
  $all('#units button').forEach(b=>b.classList.toggle('on', b.dataset.units===settings.units));
  $all('.sw[data-toggle]').forEach(b=>b.classList.toggle('on', !!settings[b.dataset.toggle]));
}
function wireSettings(){
  $all('.stepper button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.step, d=+b.dataset.d;
    if(k==='radius') settings.radius=Math.min(60,Math.max(15, settings.radius+d*5));
    if(k==='minlap') settings.minLap=Math.min(120,Math.max(5, settings.minLap+d*5));
    saveJSON(LS_SETTINGS,settings); renderSettings();
  }));
  $all('#units button').forEach(b=>b.addEventListener('click',()=>{ settings.units=b.dataset.units; saveJSON(LS_SETTINGS,settings); renderSettings(); }));
  $all('.sw[data-toggle]').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.toggle; settings[k]=!settings[k]; saveJSON(LS_SETTINGS,settings); renderSettings();
    if(k==='sim'){ toast(settings.sim?'Modo demo activado · GPS simulado':'Modo demo desactivado · GPS real',2600); GPS.start(); }
  }));
  $('#btn-clear').addEventListener('click',()=>{ if(confirm('¿Borrar TODAS las sesiones? No se puede deshacer.')){ localStorage.removeItem(LS_SESSIONS); renderSessions(); toast('Sesiones borradas'); } });
}

/* ----------------------------- Navegación / init ----------------------------- */
function show(id){ $all('.screen').forEach(s=>s.classList.remove('active')); $('#screen-'+id).classList.add('active'); }

function init(){
  $all('[data-go]').forEach(b=>b.addEventListener('click',()=>{ const d=b.dataset.go; if(d==='home'){ renderSessions(); } show(d); }));
  $('#btn-settings').addEventListener('click',()=>{ renderSettings(); show('settings'); });
  $('#gps-card').addEventListener('click',()=>GPS.start());
  $('#meta-card').addEventListener('click',()=>{ metaTrack=[]; renderPresets(); renderSaved(); show('meta'); GPS.start(); requestAnimationFrame(drawMetaMap); });
  $('#btn-mark-here').addEventListener('click', markHere);
  $('#btn-confirm-meta').addEventListener('click', confirmMeta);
  $('#btn-start').addEventListener('click', startSession);
  $('#btn-stop').addEventListener('click',()=>{ if(confirm('¿Terminar la sesión?')) stopSession(); });
  $('#btn-del-session').addEventListener('click',()=>{
    if(!viewingSessionId) return;
    if(confirm('¿Borrar esta sesión?')){ const s=loadJSON(LS_SESSIONS,[]).filter(x=>x.id!==viewingSessionId); saveJSON(LS_SESSIONS,s); renderSessions(); show('home'); toast('Sesión borrada'); }
  });

  wireSettings();
  renderSettings();
  renderSessions();
  refreshStartState();

  // sin service worker: desinstala cualquiera anterior y limpia cachés (auto-sanado)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister())).catch(()=>{});
    if(window.caches) caches.keys().then(ks=>ks.forEach(k=>caches.delete(k))).catch(()=>{});
  }

  GPS.start(); // pide ubicación al abrir
}
document.addEventListener('DOMContentLoaded', init);
