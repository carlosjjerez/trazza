/* =====================================================================
   Trazza — app (rediseño function-first)
   GPS del móvil (~1 Hz) -> detección de vueltas por aproximación a la meta
   (TrazzaDetect) + delta predictivo por distancia + mini-mapa + export.
   ===================================================================== */
'use strict';

const DEFAULTS = { radius:30, minLap:20, sectors:3, units:'kmh', sound:true, haptic:true, wakelock:true, sim:false };

// Convierte puntos de control en metros (E,N) relativos a un origen en un
// trazado cerrado denso [lat,lon]. NOTA: el trazado de Cartagena es una
// APROXIMACIÓN para el demo y la previsualización; la coordenada de meta y la
// longitud (3506 m) sí son reales. En pista, el mapa usa tu traza GPS real.
function metersToLatLon(lat0,lon0,e,n){ return [lat0+n/111320, lon0+e/(111320*Math.cos(lat0*Math.PI/180))]; }
function makeOutline(lat0,lon0,ctrl,scale){
  scale=scale||1;
  const c=ctrl.map(p=>[p[0]*scale,p[1]*scale]);
  const pts=c.concat([c[0]]); const out=[];
  for(let i=0;i<pts.length-1;i++){
    const [x0,y0]=pts[i], [x1,y1]=pts[i+1];
    const d=Math.hypot(x1-x0,y1-y0), steps=Math.max(1,Math.round(d/12));
    for(let k=0;k<steps;k++){ const f=k/steps; out.push(metersToLatLon(lat0,lon0,x0+(x1-x0)*f,y0+(y1-y0)*f)); }
  }
  out.push(metersToLatLon(lat0,lon0,c[0][0],c[0][1]));
  return out;
}
// puntos de control aproximados (forma de circuito técnico, no el Cartagena exacto)
const CART_CTRL=[
  [0,0],[0,640],[40,760],[170,820],[300,795],[385,680],
  [400,535],[330,430],[385,300],[505,210],[520,55],[440,-45],
  [300,-25],[235,-150],[300,-260],[200,-345],[40,-335],[-60,-235],
  [-165,-265],[-285,-200],[-305,-60],[-245,80],[-300,245],[-220,365],
  [-60,385],[-25,180],[0,-190]
];
const CART = { lat:37.6444, lon:-1.0352 };
// escala el trazado aprox. a ~3.5 km (longitud real) para velocidades realistas
const CART_OUTLINE = makeOutline(CART.lat, CART.lon, CART_CTRL, 0.75);

// Circuito de maniobras (conos) reconstruido desde las cotas del dibujo:
// 90 m de largo (40 recta + slalom 7×4 + 22), 11 m de ancho (carriles ±2,5),
// slalom amplitud 3, recta inferior 60, sección F (10/8/12) amplitud ~1,3.
// Geometría RELATIVA en metros [x,y] con la meta/salida en (0,0).
function genManiobras(){
  const pts=[]; const topY=2.5, botY=-2.5, r=2.5;
  const push=(x,y)=>pts.push([x,y]);
  for(let x=90;x>=50;x-=2) push(x,topY);                                   // recta C (40)
  for(let x=50;x>=22;x-=1) push(x, topY+3*Math.sin((50-x)/7*Math.PI));     // slalom 7×4 (amp 3)
  for(let x=22;x>=0;x-=2) push(x,topY);                                    // recta (22)
  for(let a=Math.PI/12;a<Math.PI;a+=Math.PI/12) push(-r*Math.sin(a), r*Math.cos(a)); // U izq
  for(let x=0;x<=60;x+=2) push(x,botY);                                    // recta D (60)
  for(let x=60;x<=78;x+=1) push(x, botY+1.3*Math.sin((x-60)/6*Math.PI));   // sección F (amp 1,3)
  for(let x=78;x<=90;x+=2) push(x,botY);
  for(let a=Math.PI/12;a<Math.PI;a+=Math.PI/12) push(90+r*Math.sin(a), -r*Math.cos(a)); // U der
  // traslada para que la salida (90,topY) sea el origen (0,0)
  return pts.map(([x,y])=>[x-90, y-topY]);
}
function relLength(rel){ let L=0; for(let i=1;i<rel.length;i++){ L+=Math.hypot(rel[i][0]-rel[i-1][0], rel[i][1]-rel[i-1][1]); } return L; }
const MANIOBRAS_REL = genManiobras();
const MANIOBRAS_LEN = relLength(MANIOBRAS_REL);

const TRACK_PRESETS = [
  { id:'cartagena', name:'Circuito de Cartagena', sub:'Recta principal · 3.506 m', lat:CART.lat, lon:CART.lon, length:3506, outline:CART_OUTLINE },
  { id:'maniobras', name:'Circuito de maniobras', template:true, relative:MANIOBRAS_REL, length:Math.round(MANIOBRAS_LEN) },
];
const LS_SETTINGS='trazza.settings.v2', LS_SESSIONS='trazza.sessions.v2', LS_METAS='trazza.metas.v2', LS_CIRCUITS='trazza.circuits.v1';

let settings = Object.assign({}, DEFAULTS, loadJSON(LS_SETTINGS, {}));
settings.sim = false; // el modo demo nunca persiste

let selectedMeta = null;   // {lat,lon,name}
let viewingSessionId = null;

const live = {
  running:false, gate:null, detector:null,
  laps:[], best:null, bestProfile:null,
  lapStartT:null, lapNum:0, cumDist:0, samples:[], prevFix:null,
  track:[], speedMax:0, startedAt:null, rafId:null, wakeLock:null,
  // sectores
  nSectors:3, refDist:null, crossTimes:[], curSectorIdx:0, lastSplitT:0, curSectors:[], bestSectors:[],
};
let metaTrack = []; // traza reciente para el mini-mapa de meta
const builder = { mode:'record', recording:false, points:[], started:false };

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
function fmtSecShort(ms){ if(ms==null||!isFinite(ms)) return '—'; return ms<60000 ? (ms/1000).toFixed(2).replace('.',',') : fmtLap(ms); }
function sectorClass(delta){ if(delta==null) return ''; const s=delta/1000; return s<=-0.02?'good':s>=0.5?'bad':s>=0.05?'warn':'good'; }
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
    if($('#screen-builder').classList.contains('active')) builderFix(fix);
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
    nSectors:settings.sectors, refDist:null, crossTimes:[], curSectorIdx:0, lastSplitT:0, curSectors:[], bestSectors:[],
  });
  // referencia para sectores en vivo desde la vuelta 1:
  //  - demo con trazado: longitud del trazado dibujado (coherente con el mapa)
  //  - pista real con circuito conocido: longitud oficial (p. ej. Cartagena)
  if(settings.sim && selectedMeta.outline) live.refDist=TrazzaDetect.buildPath(selectedMeta.outline).length;
  else if(selectedMeta.length) live.refDist=selectedMeta.length;
  renderSectorStrip(settings.sectors);
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
    updateLiveSectors(elapsed);
  }
  live.prevFix=fix;

  // mapa en vivo (circuito + posición moviéndose)
  drawHudMap();

  // detección de cruce
  const ev=live.detector.update(fix);
  if(ev) onCrossing(ev);
}

function onCrossing(ev){
  if(ev.kind==='start'){
    startLapState(ev.t, 1);
    live.crossTimes=[ev.t];
    $('#hud-lapnum').textContent='VUELTA 01';
    haptic(60); beep('lap'); toast('¡Cronómetro en marcha!');
    return;
  }
  // cierra vuelta
  const lapMs=ev.lapMs;
  live.samples.push({ d:live.cumDist, t:lapMs });
  live.crossTimes.push(ev.t);

  // referencia de distancia: la fija la primera vuelta completa
  if(live.refDist==null && live.cumDist>0) live.refDist=live.cumDist;
  // sectores de la vuelta cerrada
  const secs = TrazzaDetect.sectorSplits(live.samples, live.refDist||live.cumDist, live.nSectors) || [];
  secs.forEach((s,i)=>{ if(live.bestSectors[i]==null || s<live.bestSectors[i]) live.bestSectors[i]=s; });

  const isBest = live.best==null || lapMs<live.best;
  live.laps.push({ n:ev.lapNum, ms:lapMs, sectors:secs });
  if(isBest){ live.best=lapMs; live.bestProfile=live.samples.slice(); }

  flashHud(); haptic(isBest?[60,40,60]:80); beep(isBest?'best':'lap');
  toast((isBest?'¡Mejor vuelta! ':'Vuelta '+ev.lapNum+' · ')+fmtLap(lapMs), 2600);

  // muestra los sectores recién cerrados (con color vs mejor sector)
  showLapSectors(secs);

  // siguiente vuelta
  startLapState(ev.t, ev.lapNum+1);
  $('#hud-lapnum').textContent='VUELTA '+String(live.lapNum).padStart(2,'0');
  renderHudLastBest();
  persistSession(false);
}

function startLapState(t, lapNum){
  live.lapStartT=t; live.lapNum=lapNum; live.cumDist=0; live.samples=[{d:0,t:0}];
  live.curSectorIdx=0; live.lastSplitT=0; live.curSectors=[];
}

/* sectores en vivo: al pasar cada frontera de distancia, cierra el sector */
function updateLiveSectors(elapsed){
  if(!live.refDist || live.nSectors<2) return;
  while(live.curSectorIdx < live.nSectors-1){
    const boundary=((live.curSectorIdx+1)/live.nSectors)*live.refDist;
    if(live.cumDist < boundary) break;
    const splitT=TrazzaDetect.interpProfile(live.samples, boundary);
    const secT=splitT-live.lastSplitT;
    live.curSectors[live.curSectorIdx]=secT;
    paintSector(live.curSectorIdx, secT);
    live.lastSplitT=splitT;
    live.curSectorIdx++;
  }
  highlightSector(live.curSectorIdx);
}

function renderHudLastBest(){
  const last=live.laps.length?live.laps[live.laps.length-1].ms:null;
  const sl=splitLap(last); $('#hud-last').innerHTML = last==null?'--':`${sl.main}<span class="ms">${sl.ms}</span>`;
  const sb=splitLap(live.best); $('#hud-best').innerHTML = live.best==null?'--':`${sb.main}<span class="ms">${sb.ms}</span>`;
}

/* ---- sectores en el HUD ---- */
function renderSectorStrip(n){
  const wrap=$('#hud-sectors'); if(!wrap) return; wrap.innerHTML='';
  for(let i=0;i<n;i++){ const d=document.createElement('div'); d.className='sec'; d.dataset.i=i;
    d.innerHTML=`<span class="sl">S${i+1}</span><span class="sd">—</span>`; wrap.appendChild(d); }
}
function paintSector(i, secT){
  const cell=$(`#hud-sectors .sec[data-i="${i}"]`); if(!cell) return;
  const best=live.bestSectors[i];
  const delta = best!=null ? secT-best : null;
  cell.querySelector('.sd').textContent=fmtSecShort(secT);
  cell.classList.remove('good','warn','bad');
  const cls=sectorClass(delta); if(cls) cell.classList.add(cls);
}
function highlightSector(idx){ $all('#hud-sectors .sec').forEach((c,i)=>c.classList.toggle('cur', i===idx)); }
function showLapSectors(secs){ secs.forEach((s,i)=>paintSector(i,s)); highlightSector(-1); }
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
  $all('#hud-sectors .sec').forEach(c=>{ c.classList.remove('good','warn','bad','cur'); const sd=c.querySelector('.sd'); if(sd) sd.textContent='—'; });
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
  const optimal = (live.bestSectors.length===live.nSectors && live.bestSectors.every(x=>x!=null))
    ? live.bestSectors.reduce((a,b)=>a+b,0) : null;
  const data={
    id: currentId || ('s'+live.startedAt),
    name: live.gate.name, startedAt: live.startedAt, endedAt: finalize?Date.now():null,
    laps: live.laps.map(l=>({n:l.n, ms:l.ms, sectors:l.sectors||null})), best: live.best,
    nSectors: live.nSectors, bestSectors: live.bestSectors.slice(), optimal,
    speedMaxKmh: Math.round(live.speedMax*3.6),
    gate:{ lat:live.gate.lat, lon:live.gate.lon }, crossTimes: live.crossTimes.slice(), track: live.track,
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
  $('#sum-opt').textContent = s.optimal!=null ? fmtLap(s.optimal) : '--';

  const best=s.bestSectors||[];
  const wrap=$('#sum-laps'); wrap.innerHTML='';
  if(!s.laps.length) wrap.innerHTML='<div class="empty">No se registraron vueltas completas. Revisa la posición de la meta.</div>';
  s.laps.forEach(l=>{
    const isBest=l.ms===s.best, delta=l.ms-s.best;
    let cls='best',txt='MEJOR';
    if(!isBest){ const sec=delta/1000; txt='+'+sec.toFixed(2); cls=sec>=1?'worse':'close'; }
    let secsHtml='';
    if(l.sectors && l.sectors.length){
      secsHtml='<div class="lap-secs">'+l.sectors.map((sv,i)=>{
        const d = best[i]!=null ? sv-best[i] : null;
        const isBestSec = best[i]!=null && Math.abs(sv-best[i])<1e-6;
        const c = isBestSec ? 'good' : sectorClass(d);
        return `<span class="sc ${c}">S${i+1} ${fmtSecShort(sv)}</span>`;
      }).join('')+'</div>';
    }
    const row=document.createElement('div'); row.className='lap'+(isBest?' best':'');
    row.innerHTML=`<div class="lap-top"><span class="ln">${String(l.n).padStart(2,'0')}</span><div class="rt"><span class="lt">${fmtLap(l.ms)}</span><span class="dl ${cls}">${txt}</span></div></div>${secsHtml}`;
    wrap.appendChild(row);
  });

  $('#btn-csv').onclick=()=>exportCSV(s);
  $('#btn-gpx').onclick=()=>exportGPX(s);
  requestAnimationFrame(()=>drawSummaryMap($('#sum-map'), s));
}

/* ----------------------------- Export ----------------------------- */
function download(name,text,type){ const b=new Blob([text],{type:type||'text/plain'}); const u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(u);a.remove();},500); }
function slug(s){ return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function exportCSV(s){
  const d=new Date(s.startedAt).toISOString().slice(0,16).replace(/[:T]/g,'-');
  const n=s.nSectors||0;
  const secCols=Array.from({length:n},(_,i)=>`sector${i+1}_ms`).join(',');
  let csv='vuelta,tiempo_ms,tiempo,delta_ms,mejor'+(n?','+secCols:'')+'\n';
  s.laps.forEach(l=>{
    let row=`${l.n},${Math.round(l.ms)},"${fmtLap(l.ms)}",${Math.round(l.ms-s.best)},${l.ms===s.best?'1':'0'}`;
    if(n){ for(let i=0;i<n;i++){ const v=l.sectors&&l.sectors[i]!=null?Math.round(l.sectors[i]):''; row+=','+v; } }
    csv+=row+'\n';
  });
  if(s.optimal!=null) csv+=`óptima,${Math.round(s.optimal)},"${fmtLap(s.optimal)}",,${''}`+(n?','+(s.bestSectors||[]).map(x=>x!=null?Math.round(x):'').join(','):'')+'\n';
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
// prepara canvas + proyección que encuadra todos los puntos
function setupCanvas(canvas, allPts){
  const dpr=window.devicePixelRatio||1;
  const W=canvas.clientWidth, H=canvas.clientHeight;
  if(!W||!H) return null;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext && canvas.getContext('2d'); if(!ctx) return null;
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  if(!allPts.length) return null;
  const lat0=allPts.reduce((s,p)=>s+p.lat,0)/allPts.length, k=Math.cos(lat0*Math.PI/180);
  let minX=Math.min(...allPts.map(p=>p.lon*k)), maxX=Math.max(...allPts.map(p=>p.lon*k));
  let minY=Math.min(...allPts.map(p=>p.lat)),     maxY=Math.max(...allPts.map(p=>p.lat));
  const minSpan=0.0016;
  if(maxX-minX<minSpan*k){ const c=(maxX+minX)/2; minX=c-minSpan*k/2; maxX=c+minSpan*k/2; }
  if(maxY-minY<minSpan){ const c=(maxY+minY)/2; minY=c-minSpan/2; maxY=c+minSpan/2; }
  const pad=22, spanX=maxX-minX, spanY=maxY-minY;
  const scale=Math.min((W-2*pad)/spanX,(H-2*pad)/spanY);
  const offX=(W-spanX*scale)/2, offY=(H-spanY*scale)/2;
  return { ctx, W, H, k, scale,
    toPx:p=>({ x:offX+(p.lon*k-minX)*scale, y:H-(offY+(p.lat-minY)*scale) }) };
}
function strokeLine(ctx, toPx, pts, color, width){
  if(pts.length<2) return; ctx.beginPath();
  pts.forEach((p,i)=>{ const q=toPx(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y); });
  ctx.strokeStyle=color; ctx.lineWidth=width; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
}
function drawFinish(ctx, toPx, finish, radiusM, scale){
  if(!finish) return; const f=toPx(finish); const rpx=(radiusM/111320)*scale;
  ctx.beginPath(); ctx.arc(f.x,f.y,Math.max(rpx,5),0,2*Math.PI); ctx.strokeStyle='rgba(31,224,200,.55)'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(f.x,f.y,6,0,2*Math.PI); ctx.fillStyle='#B6FF1A'; ctx.fill();
  ctx.fillStyle='#B6FF1A'; ctx.font='700 11px Saira, sans-serif'; ctx.textAlign='center'; ctx.fillText('META', f.x, f.y-10);
}
// marca los puntos donde se toma el tiempo de sector (a k/n de la distancia)
function placeSectorMarkers(P, pts, n){
  if(!pts || pts.length<2 || n<2) return;
  let total=0; const cum=[0];
  for(let i=1;i<pts.length;i++){ total+=TrazzaDetect.haversine(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon); cum.push(total); }
  if(!total) return;
  const ctx=P.ctx;
  for(let kk=1;kk<n;kk++){
    const target=(kk/n)*total; let i=1; while(i<cum.length && cum[i]<target) i++; if(i>=cum.length) i=cum.length-1;
    const a=pts[i-1], b=pts[i], seg=(cum[i]-cum[i-1])||1, f=(target-cum[i-1])/seg;
    const q=P.toPx({lat:a.lat+(b.lat-a.lat)*f, lon:a.lon+(b.lon-a.lon)*f});
    ctx.beginPath(); ctx.arc(q.x,q.y,5,0,2*Math.PI); ctx.fillStyle='#FF9E1B'; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle='#0E0F12'; ctx.stroke();
    ctx.fillStyle='#FF9E1B'; ctx.font='700 11px Saira, sans-serif'; ctx.textAlign='center'; ctx.fillText('S'+(kk+1), q.x, q.y-9);
  }
}
// color por velocidad: lento (rojo) -> medio (ámbar) -> rápido (cian)
function speedColor(frac){
  frac=Math.max(0,Math.min(1,frac));
  const stops=[[255,59,48],[255,158,27],[31,224,200]];
  const seg=frac<0.5?0:1, t=frac<0.5?frac/0.5:(frac-0.5)/0.5;
  const a=stops[seg], b=stops[seg+1];
  return `rgb(${Math.round(a[0]+(b[0]-a[0])*t)},${Math.round(a[1]+(b[1]-a[1])*t)},${Math.round(a[2]+(b[2]-a[2])*t)})`;
}

// mapa EN VIVO del HUD: trazado del circuito + tu posición moviéndose
function drawHudMap(){
  const canvas=$('#hud-map'); if(!canvas) return;
  const outline = live.gate && live.gate.outline ? live.gate.outline.map(p=>({lat:p[0],lon:p[1]})) : null;
  const trail = live.track.map(p=>({lat:p.lat,lon:p.lon}));
  const pos = live.prevFix || (GPS.last?{lat:GPS.last.lat,lon:GPS.last.lon}:null);
  const all=(outline||[]).concat(trail); if(live.gate) all.push(live.gate); if(pos) all.push(pos);
  const P=setupCanvas(canvas, all); if(!P) return;
  if(outline){ strokeLine(P.ctx, P.toPx, outline, 'rgba(138,147,166,.45)', 2); placeSectorMarkers(P, outline, live.nSectors); }
  else { placeSectorMarkers(P, trail, live.nSectors); }
  strokeLine(P.ctx, P.toPx, trail, '#1FE0C8', 2.5);
  drawFinish(P.ctx, P.toPx, live.gate, settings.radius, P.scale);
  if(pos){ const c=P.toPx(pos); P.ctx.beginPath(); P.ctx.arc(c.x,c.y,6,0,2*Math.PI);
    P.ctx.fillStyle='#F5F7FA'; P.ctx.fill(); P.ctx.lineWidth=2; P.ctx.strokeStyle='#0E0F12'; P.ctx.stroke(); }
}

// mapa simple (meta): traza + meta + posición actual
function drawMap(canvas, pts, finish, radiusM){
  if(!canvas) return;
  const all=pts.slice(); if(finish) all.push(finish);
  const P=setupCanvas(canvas, all); if(!P) return;
  strokeLine(P.ctx, P.toPx, pts, '#1FE0C8', 2.5);
  drawFinish(P.ctx, P.toPx, finish, radiusM, P.scale);
  if(pts.length){ const c=P.toPx(pts[pts.length-1]); P.ctx.beginPath(); P.ctx.arc(c.x,c.y,6,0,2*Math.PI);
    P.ctx.fillStyle='#F5F7FA'; P.ctx.fill(); P.ctx.lineWidth=2; P.ctx.strokeStyle='#0E0F12'; P.ctx.stroke(); }
}
function drawMetaMap(){
  const m=selectedMeta;
  if(m && m.outline){
    const pts=m.outline.map(p=>({lat:p[0],lon:p[1]}));
    const P=setupCanvas($('#meta-map'), pts); if(!P) return;
    strokeLine(P.ctx, P.toPx, pts, '#1FE0C8', 2.5);
    placeSectorMarkers(P, pts, settings.sectors);
    drawFinish(P.ctx, P.toPx, {lat:m.lat,lon:m.lon}, settings.radius, P.scale);
    if(GPS.last){ const c=P.toPx({lat:GPS.last.lat,lon:GPS.last.lon}); P.ctx.beginPath(); P.ctx.arc(c.x,c.y,6,0,2*Math.PI);
      P.ctx.fillStyle='#F5F7FA'; P.ctx.fill(); P.ctx.lineWidth=2; P.ctx.strokeStyle='#0E0F12'; P.ctx.stroke(); }
    return;
  }
  const finish = m || (GPS.last?{lat:GPS.last.lat,lon:GPS.last.lon}:null);
  drawMap($('#meta-map'), metaTrack.map(f=>({lat:f.lat,lon:f.lon})), finish, settings.radius);
}

// mapa de resumen: track completo atenuado + MEJOR vuelta coloreada por velocidad
function drawSummaryMap(canvas, s){
  if(!canvas) return;
  const track=s.track||[];
  const P=setupCanvas(canvas, track.concat(s.gate?[s.gate]:[])); if(!P) return;
  // track completo (atenuado)
  strokeLine(P.ctx, P.toPx, track, 'rgba(138,147,166,.35)', 2);
  // segmento de la mejor vuelta
  const bestLap = s.laps.find(l=>l.ms===s.best);
  let seg=track;
  if(bestLap && s.crossTimes && s.crossTimes.length>=2){
    const idx=s.laps.indexOf(bestLap);
    const t0=s.crossTimes[idx], t1=s.crossTimes[idx+1];
    if(t0!=null && t1!=null) seg=track.filter(p=>p.t>=t0 && p.t<=t1);
  }
  // rango de velocidad para normalizar el color
  const spds=seg.map(p=>p.spd).filter(v=>v!=null);
  const vmin=spds.length?Math.min(...spds):0, vmax=spds.length?Math.max(...spds):1, rng=(vmax-vmin)||1;
  for(let i=1;i<seg.length;i++){
    const a=P.toPx(seg[i-1]), b=P.toPx(seg[i]);
    const v=seg[i].spd!=null?seg[i].spd:vmin;
    P.ctx.beginPath(); P.ctx.moveTo(a.x,a.y); P.ctx.lineTo(b.x,b.y);
    P.ctx.strokeStyle=speedColor((v-vmin)/rng); P.ctx.lineWidth=3.5; P.ctx.lineJoin='round'; P.ctx.lineCap='round'; P.ctx.stroke();
  }
  // puntos de sector sobre la mejor vuelta
  placeSectorMarkers(P, seg.map(p=>({lat:p.lat,lon:p.lon})), s.nSectors||0);
  drawFinish(P.ctx, P.toPx, s.gate, settings.radius, P.scale);
}

/* ----------------------------- Meta (marcar / elegir) ----------------------------- */
let pendingTemplate=null;
// coloca una plantilla (geometría relativa en metros) en una posición real
function anchorTemplateAt(p, lat, lon){
  const outline=p.relative.map(([x,y])=>metersToLatLon(lat,lon,x,y));
  const length=TrazzaDetect.buildPath(outline).length;
  selectedMeta={ lat, lon, name:p.name, outline, length };
  $('#btn-confirm-meta').disabled=false; drawMetaMap();
}
function selectTemplate(p){
  pendingTemplate=p;
  if(GPS.last){ anchorTemplateAt(p, GPS.last.lat, GPS.last.lon); toast(p.name+' colocado en tu posición'); }
  else toast('Esperando GPS para colocar el circuito');
}
function markHere(){
  if(!GPS.last){ toast('Esperando GPS'); return; }
  if(pendingTemplate){ anchorTemplateAt(pendingTemplate, GPS.last.lat, GPS.last.lon); toast('Circuito recolocado en tu posición'); haptic(40); return; }
  selectedMeta={ lat:GPS.last.lat, lon:GPS.last.lon, name:'Mi posición' };
  const metas=loadJSON(LS_METAS,[]); metas.unshift({...selectedMeta, name:'Meta '+new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}), at:Date.now()});
  saveJSON(LS_METAS, metas.slice(0,8));
  $('#btn-confirm-meta').disabled=false; renderSaved(); drawMetaMap();
  toast('Meta marcada en tu posición'); haptic(40);
}
function chooseMeta(m, name){ pendingTemplate=null; selectedMeta={ lat:m.lat, lon:m.lon, name:name||m.name, length:m.length||null, outline:m.outline||null }; $('#btn-confirm-meta').disabled=false; drawMetaMap(); }
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
    const sub = p.template ? `plantilla · ${p.length} m · se coloca en tu posición`
                           : `${esc(p.sub)} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    el.innerHTML=`<div><div class="nm">${esc(p.name)}</div><div class="sub">${sub}</div></div>
      <svg class="tick" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B6FF1A" stroke-width="2.4"><path d="M5 12l5 5 9-9"/></svg>`;
    el.addEventListener('click',()=>{ if(p.template) selectTemplate(p); else chooseMeta(p,p.name); $all('.preset').forEach(e=>e.classList.remove('sel')); el.classList.add('sel'); });
    list.appendChild(el);
  });
}
function renderSaved(){
  const list=$('#saved-list'), circuits=loadJSON(LS_CIRCUITS,[]), metas=loadJSON(LS_METAS,[]);
  $('#saved-divider').hidden = (circuits.length+metas.length)===0;
  list.innerHTML='';
  circuits.forEach(c=>{
    const el=document.createElement('div'); el.className='preset';
    el.innerHTML=`<div><div class="nm">${esc(c.name)}</div><div class="sub">circuito · ${(c.length/1000).toFixed(2).replace('.',',')} km · ${c.outline.length} pts</div></div>
      <button class="mini-del" data-id="${c.id}" aria-label="Borrar">✕</button>`;
    el.addEventListener('click',(e)=>{ if(e.target.closest('.mini-del')) return; chooseMeta(c,c.name); });
    el.querySelector('.mini-del').addEventListener('click',(e)=>{ e.stopPropagation();
      if(confirm('¿Borrar este circuito?')){ saveJSON(LS_CIRCUITS, loadJSON(LS_CIRCUITS,[]).filter(x=>x.id!==c.id)); renderSaved(); } });
    list.appendChild(el);
  });
  metas.forEach(m=>{
    const el=document.createElement('div'); el.className='preset';
    el.innerHTML=`<div><div class="nm">${esc(m.name)}</div><div class="sub">meta · ${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}</div></div>
      <svg class="tick" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B6FF1A" stroke-width="2.4"><path d="M5 12l5 5 9-9"/></svg>`;
    el.addEventListener('click',()=>{ chooseMeta(m,m.name); });
    list.appendChild(el);
  });
}

/* ----------------------------- Constructor de circuito ----------------------------- */
function openBuilder(){
  builder.mode='record'; builder.recording=false; builder.points=[]; builder.started=false;
  $all('#bld-mode button').forEach(b=>b.classList.toggle('on', b.dataset.mode==='record'));
  $('#bld-record').hidden=false; $('#bld-manual').hidden=true;
  $('#btn-rec-toggle').classList.remove('rec-on'); $('#btn-rec-toggle').querySelector('span').textContent='Empezar a grabar';
  updateBuilderUI();
  show('builder'); GPS.start(); requestAnimationFrame(drawBuilderMap);
}
function setBuilderMode(mode){
  if(builder.recording) return; // no cambiar mientras grabas
  builder.mode=mode; builder.points=[]; builder.started=false;
  $all('#bld-mode button').forEach(b=>b.classList.toggle('on', b.dataset.mode===mode));
  $('#bld-record').hidden = mode!=='record';
  $('#bld-manual').hidden = mode!=='manual';
  updateBuilderUI(); drawBuilderMap();
}
function builderFix(fix){
  $('#bld-gps').textContent='±'+fix.acc.toFixed(1)+' m';
  if(builder.mode==='record' && builder.recording){
    if(TrazzaDetect.appendIfMoved(builder.points, fix.lat, fix.lon, 5)) { /* añadido */ }
  }
  updateBuilderUI(); drawBuilderMap();
}
function recToggle(){
  if(!builder.recording){
    if(!GPS.last){ toast('Esperando GPS'); return; }
    builder.recording=true; builder.started=true; builder.points=[[GPS.last.lat,GPS.last.lon]];
    $('#btn-rec-toggle').classList.add('rec-on'); $('#btn-rec-toggle').querySelector('span').textContent='Detener grabación';
    toast('Grabando… da una vuelta y vuelve a meta'); haptic(50);
  } else {
    builder.recording=false;
    $('#btn-rec-toggle').classList.remove('rec-on'); $('#btn-rec-toggle').querySelector('span').textContent='Empezar a grabar';
    toast('Grabación detenida');
  }
  updateBuilderUI();
}
function pinPoint(){
  if(!GPS.last){ toast('Esperando GPS'); return; }
  if(!builder.started){ builder.points=[[GPS.last.lat,GPS.last.lon]]; builder.started=true; toast('Meta fijada · ahora añade puntos'); }
  else { builder.points.push([GPS.last.lat,GPS.last.lon]); toast('Punto '+builder.points.length); }
  haptic(40); updateBuilderUI(); drawBuilderMap();
}
function undoPoint(){ if(builder.points.length>1){ builder.points.pop(); updateBuilderUI(); drawBuilderMap(); } }
function builderLength(){ return builder.points.length>1 ? TrazzaDetect.buildPath(builder.points.map(p=>p)).length : 0; }
function updateBuilderUI(){
  $('#bld-points').textContent=builder.points.length;
  $('#bld-dist').textContent=Math.round(builderLength())+' m';
  $('#btn-rec-toggle').disabled = !GPS.last;
  const can = GPS.last && GPS.last.acc<=25;
  $('#btn-pin').disabled=!can;
  $('#btn-pin').querySelector('span').textContent = builder.started ? 'Añadir punto' : 'Fijar meta aquí';
  $('#btn-undo').disabled = builder.points.length<=1;
  // guardar: al menos 4 puntos y no estar grabando
  $('#btn-save-circuit').disabled = builder.points.length<4 || builder.recording;
}
function saveCircuit(){
  if(builder.points.length<4){ toast('Necesitas más puntos'); return; }
  if(builder.recording) recToggle();
  // cierra el bucle volviendo a la meta
  const pts=builder.points.slice();
  const first=pts[0], last=pts[pts.length-1];
  if(TrazzaDetect.haversine(first[0],first[1],last[0],last[1])>3) pts.push([first[0],first[1]]);
  const length=TrazzaDetect.buildPath(pts).length;
  const def='Circuito '+new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'short'});
  const name=(prompt('Nombre del circuito:', def)||def).trim().slice(0,40);
  const circuit={ id:'c'+Date.now(), name, lat:first[0], lon:first[1], outline:pts, length, createdAt:Date.now() };
  const circuits=loadJSON(LS_CIRCUITS,[]); circuits.unshift(circuit); saveJSON(LS_CIRCUITS, circuits.slice(0,30));
  selectedMeta={ lat:circuit.lat, lon:circuit.lon, name:circuit.name, length:circuit.length, outline:circuit.outline };
  $('#btn-confirm-meta').disabled=false;
  toast('Circuito guardado · '+name); haptic([60,40,60]);
  renderSaved(); show('meta'); drawMetaMap();
}
function drawBuilderMap(){
  const pts=builder.points.map(p=>({lat:p[0],lon:p[1]}));
  const all=pts.slice(); if(GPS.last) all.push({lat:GPS.last.lat,lon:GPS.last.lon});
  const P=setupCanvas($('#builder-map'), all); if(!P) return;
  strokeLine(P.ctx, P.toPx, pts, '#1FE0C8', 2.5);
  if(pts.length) drawFinish(P.ctx, P.toPx, pts[0], settings.radius, P.scale);  // meta = primer punto
  if(GPS.last){ const c=P.toPx({lat:GPS.last.lat,lon:GPS.last.lon}); P.ctx.beginPath(); P.ctx.arc(c.x,c.y,6,0,2*Math.PI);
    P.ctx.fillStyle='#F5F7FA'; P.ctx.fill(); P.ctx.lineWidth=2; P.ctx.strokeStyle='#0E0F12'; P.ctx.stroke(); }
}

/* ----------------------------- Ajustes ----------------------------- */
function renderSettings(){
  $('#set-radius').textContent=settings.radius+' m';
  $('#set-minlap').textContent=settings.minLap+' s';
  $('#set-sectors').textContent=settings.sectors;
  $all('#units button').forEach(b=>b.classList.toggle('on', b.dataset.units===settings.units));
  $all('.sw[data-toggle]').forEach(b=>b.classList.toggle('on', !!settings[b.dataset.toggle]));
}
function wireSettings(){
  $all('.stepper button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.step, d=+b.dataset.d;
    if(k==='radius') settings.radius=Math.min(60,Math.max(15, settings.radius+d*5));
    if(k==='minlap') settings.minLap=Math.min(120,Math.max(5, settings.minLap+d*5));
    if(k==='sectors') settings.sectors=Math.min(5,Math.max(1, settings.sectors+d));
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
  $all('[data-go]').forEach(b=>b.addEventListener('click',()=>{ const d=b.dataset.go; if(d==='home'){ renderSessions(); } if(d==='meta'){ renderPresets(); renderSaved(); } show(d); }));
  $('#btn-settings').addEventListener('click',()=>{ renderSettings(); show('settings'); });
  $('#gps-card').addEventListener('click',()=>GPS.start());
  $('#meta-card').addEventListener('click',()=>{ metaTrack=[]; renderPresets(); renderSaved(); show('meta'); GPS.start(); requestAnimationFrame(drawMetaMap); });
  $('#btn-mark-here').addEventListener('click', markHere);
  $('#btn-create-circuit').addEventListener('click', openBuilder);
  $all('#bld-mode button').forEach(b=>b.addEventListener('click',()=>setBuilderMode(b.dataset.mode)));
  $('#btn-rec-toggle').addEventListener('click', recToggle);
  $('#btn-pin').addEventListener('click', pinPoint);
  $('#btn-undo').addEventListener('click', undoPoint);
  $('#btn-save-circuit').addEventListener('click', saveCircuit);
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
