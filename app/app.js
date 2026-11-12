/* =====================================================================
   Trazza — app (rediseño function-first)
   GPS del móvil (~1 Hz) -> detección de vueltas por aproximación a la meta
   (TrazzaDetect) + delta predictivo por distancia + mini-mapa + export.
   ===================================================================== */
'use strict';

const DEFAULTS = { radius:30, minLap:20, sectors:3, units:'kmh', sound:true, haptic:true, wakelock:true, sim:false, imu:false };

function metersToLatLon(lat0,lon0,e,n){ return [lat0+n/111320, lon0+e/(111320*Math.cos(lat0*Math.PI/180))]; }
// Trazado REAL del Circuito de Cartagena (OpenStreetMap, lat/lon reales): forma
// exacta, lazo cerrado que empieza en la línea de meta, longitud 3.497 m.
const CART_T = window.CART_TRACK;
const CART = { lat:CART_T.finish.lat, lon:CART_T.finish.lon };
const CART_OUTLINE = CART_T.outline;

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
  { id:'cartagena', name:'Circuito de Cartagena', sub:'Trazado real (OSM) · 3.497 m', lat:CART.lat, lon:CART.lon, length:CART_T.length, outline:CART_OUTLINE },
  { id:'maniobras', name:'Circuito de maniobras', template:true, relative:MANIOBRAS_REL, length:Math.round(MANIOBRAS_LEN) },
];
const LS_SETTINGS='trazza.settings.v2', LS_SESSIONS='trazza.sessions.v2', LS_METAS='trazza.metas.v2', LS_CIRCUITS='trazza.circuits.v1', LS_RECORDS='trazza.records.v1', LS_REMINDERS='trazza.reminders.v1';

// Recordatorios por vuelta: [{lap, text}]. Se configuran antes de la tanda y
// saltan en el HUD al entrar en esa vuelta.
function loadReminders(){ return loadJSON(LS_REMINDERS, []).filter(r=>r&&r.lap>=1&&r.text); }
function saveReminders(arr){ saveJSON(LS_REMINDERS, arr.slice(0,20)); }
function renderReminders(){
  const list=$('#rem-list'); if(!list) return;
  const rems=loadReminders().sort((a,b)=>a.lap-b.lap);
  list.innerHTML='';
  $('#rem-empty').hidden = rems.length>0;
  $('#rem-count').textContent = rems.length ? rems.length+(rems.length===1?' aviso':' avisos') : '';
  rems.forEach((r,i)=>{
    const el=document.createElement('div'); el.className='rem-item';
    el.innerHTML=`<span class="lap">V${r.lap}</span><span class="tx">${esc(r.text)}</span><button class="del" aria-label="Borrar">✕</button>`;
    el.querySelector('.del').addEventListener('click',()=>{ const a=loadReminders().sort((x,y)=>x.lap-y.lap); a.splice(i,1); saveReminders(a); renderReminders(); });
    list.appendChild(el);
  });
}
function addReminderFromInputs(){
  const lapEl=$('#rem-lap'), txEl=$('#rem-text');
  const lap=parseInt(lapEl.value,10), text=(txEl.value||'').trim();
  if(!lap||lap<1){ toast('Indica el número de vuelta'); lapEl.focus(); return; }
  if(!text){ toast('Escribe el recordatorio'); txEl.focus(); return; }
  const a=loadReminders(); a.push({ lap, text }); saveReminders(a);
  lapEl.value=''; txEl.value=''; renderReminders(); toast('Recordatorio añadido · vuelta '+lap); haptic(30);
}

// Récord histórico (PB) por circuito: identificado por nombre + coords de meta.
function recordKey(m){ if(!m||m.lat==null||m.lon==null) return null; const n=(m.name||'meta').trim().toLowerCase(); return n+'@'+(+m.lat).toFixed(4)+','+(+m.lon).toFixed(4); }
function loadRecords(){ return loadJSON(LS_RECORDS, {}); }
function loadRecord(k){ if(!k) return null; return loadRecords()[k] || null; }
function saveRecord(k, rec){ if(!k) return; const r=loadRecords(); r[k]=rec; saveJSON(LS_RECORDS, r); }

let settings = Object.assign({}, DEFAULTS, loadJSON(LS_SETTINGS, {}));
settings.sim = false; // el modo demo nunca persiste

let selectedMeta = null;   // {lat,lon,name}
let viewingSessionId = null;
let curSummary = null;     // sesión mostrada en resumen (base del análisis)
let sumColorMode = 'spd';  // coloreado del mapa de resumen: 'spd' | 'lean'

const live = {
  running:false, gate:null, detector:null,
  laps:[], best:null, bestProfile:null,
  lapStartT:null, lapNum:0, cumDist:0, samples:[], prevFix:null,
  track:[], speedMax:0, startedAt:null, rafId:null, wakeLock:null,
  peaks:null,  // picos de inclinación/G de la tanda (si hay sensores)
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
// modo track: tiempo en curso con décimas (M:SS.d) y tiempo de tanda (M:SS)
function fmtTenths(ms){ if(ms==null||ms<0) ms=0; const t=Math.floor(ms/100), te=t%10, tot=Math.floor(t/10); return Math.floor(tot/60)+':'+String(tot%60).padStart(2,'0')+'.'+te; }
function fmtMMSS(ms){ if(ms==null||ms<0) ms=0; const s=Math.floor(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
// delta a pantalla completa vs la vuelta rápida: verde si vas más rápido, rojo si más lento
function setTrackDelta(ms){
  const tm=$('#track-mode'), d=$('#tk-delta'); if(!tm||!d) return;
  tm.classList.remove('faster','slower');
  if(ms==null){ d.textContent='—'; return; }
  if(ms<-20) tm.classList.add('faster'); else if(ms>20) tm.classList.add('slower');
  d.textContent=fmtDelta(ms);
}
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

/* ----------------------------- IMU: inclinación + G ----------------------------- */
// Lean angle y fuerzas G con el acelerómetro/giroscopio DEL PROPIO MÓVIL
// (DeviceMotion ~60 Hz). Sin hardware externo. Núcleo en sensors.js.
//
// ⚠️ MAPEO DE EJES DeviceMotion -> marco de la MOTO: depende de cómo quede el
//    móvil en el soporte. Supuesto por defecto (ajustar probando en moto real):
//    móvil VERTICAL en el depósito, pantalla hacia el piloto, borde superior
//    hacia delante. Entonces:
//      - tumbar izq/der (roll) ≈ rotationRate.beta           (°/s)
//      - aLat (lateral)        ≈ accelerationIncludingGravity.x
//      - aLon (acel/frenada)   ≈ accelerationIncludingGravity.y
//      - aVert (vertical)      ≈ accelerationIncludingGravity.z
// Estas constantes están aisladas aquí para poder calibrarlas en pista.
const IMU_AXES = { rollRate:'beta', aLat:'x', aLon:'y', aVert:'z', rollSign:1 };

const IMU = {
  active:false, available:false, permission:'unknown',
  filter:null, calib:null, calibrating:false, calBuf:null,
  last:{ lean:0, g:null }, lastT:null, _handler:null, _calTimer:null,
  supported(){ return typeof window!=='undefined' && typeof window.DeviceMotionEvent!=='undefined'; },
  needsPermission(){ return this.supported() && typeof window.DeviceMotionEvent.requestPermission==='function'; },
  async requestPermission(){
    if(!this.supported()) return 'unsupported';
    if(!this.needsPermission()){ this.permission='granted'; return 'granted'; }
    try{ const r=await window.DeviceMotionEvent.requestPermission(); this.permission=r; return r; }
    catch(e){ this.permission='denied'; return 'denied'; }
  },
  // arranca la escucha + calibración corta (moto recta y parada ~1,6 s)
  start(){
    if(!settings.imu || !this.supported() || this.permission==='denied') { this.active=false; return; }
    this.stop();
    this.filter=TrazzaSensors.createLeanFilter();
    this.calib=null; this.calibrating=true; this.calBuf=TrazzaSensors.makeCalibrator();
    this.lastT=null; this.last={ lean:0, g:null }; this.available=false;
    this._handler=(e)=>this._onMotion(e);
    window.addEventListener('devicemotion', this._handler, true);
    this._calTimer=setTimeout(()=>this._finishCalib(), 1600);
    this.active=true;
    toast('Calibrando sensores · mantén la moto recta', 1600);
  },
  stop(){
    if(this._handler){ window.removeEventListener('devicemotion', this._handler, true); this._handler=null; }
    if(this._calTimer){ clearTimeout(this._calTimer); this._calTimer=null; }
    this.active=false; this.calibrating=false;
  },
  _finishCalib(){
    this.calibrating=false;
    const c=this.calBuf && this.calBuf.finish(); if(c) this.calib=c;
    if(this.filter) this.filter.reset(0);
    if(this.available) toast('Sensores listos · 0° en recto', 1300);
  },
  _onMotion(e){
    const ag=e.accelerationIncludingGravity, rr=e.rotationRate;
    if(!ag || !rr){ return; }                 // navegador sin datos reales
    this.available=true;
    const ax=ag[IMU_AXES.aLat]||0, ay=ag[IMU_AXES.aLon]||0, az=ag[IMU_AXES.aVert]||0;
    const rawRoll=(rr[IMU_AXES.rollRate]||0)*IMU_AXES.rollSign;
    if(this.calibrating){
      this.calBuf.add({ ax, ay, az, gx:rawRoll, gy:0, gz:0 });
      if(this.calBuf.count>=60) this._finishCalib();   // ~1 s a 60 Hz; el timer es respaldo
      return;
    }
    const now=(e.timeStamp!=null?e.timeStamp:(typeof performance!=='undefined'?performance.now():Date.now()));
    let dt=this.lastT!=null ? (now-this.lastT)/1000 : 0; this.lastT=now;
    if(!(dt>0) || dt>0.5) dt=0.016;            // protege de saltos/pausas
    const bias=this.calib?this.calib.gyroBias.x:0;
    const lean=this.filter.update(dt, rawRoll-bias, ax, az, Math.hypot(ax,ay,az));
    const g=TrazzaSensors.gForces(ax, ay, az);
    this.last={ lean, g };
    if(live.running && live.peaks) live.peaks.push(lean, g);
    renderImuHud(lean, g);
  }
};

let _imuHudT=0;
function renderImuHud(lean, g){
  const now=(typeof performance!=='undefined'?performance.now():Date.now());
  if(now-_imuHudT<90) return; _imuHudT=now;   // ~11 fps, suficiente y barato
  const le=$('#hud-lean'); if(le) le.textContent=Math.round(Math.abs(lean))+'°';
  const ls=$('#hud-lean-side'); if(ls) ls.textContent = Math.abs(lean)<3?'—':(lean<0?'IZQ':'DER');
  const ge=$('#hud-g'); if(ge && g) ge.textContent=(g.horiz||0).toFixed(1);
}

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
    bikeId: preSession?preSession.bikeId:null, bikeName: preSession?preSession.bikeName:null,
    setupId: preSession?preSession.setupId:null, setupName: preSession?preSession.setupName:null,
  });
  // referencia para sectores en vivo desde la vuelta 1:
  //  - demo con trazado: longitud del trazado dibujado (coherente con el mapa)
  //  - pista real con circuito conocido: longitud oficial (p. ej. Cartagena)
  if(settings.sim && selectedMeta.outline) live.refDist=TrazzaDetect.buildPath(selectedMeta.outline).length;
  else if(selectedMeta.length) live.refDist=selectedMeta.length;
  // récord histórico del circuito: referencia del delta desde la vuelta 1
  live.recordKey = recordKey(selectedMeta);
  const rec = loadRecord(live.recordKey);
  live.record = rec ? { bestMs:rec.bestMs, profile:rec.profile||null, sectors:rec.sectors||null, date:rec.date } : null;
  live.refProfile = live.record && live.record.profile ? live.record.profile : null;
  live.refMs = live.record ? live.record.bestMs : null;
  live.newRecord = false;
  const dk=$('#hud-delta .kicker'); if(dk) dk.textContent = live.record ? 'Delta · predictivo vs récord' : 'Delta · predictivo vs mejor';
  // recordatorios de esta tanda (copia, para no afectar a ediciones posteriores)
  live.reminders = loadReminders();
  live.firedReminders = {};
  hideHudReminder();
  renderSectorStrip(settings.sectors);
  viewingSessionId=null;
  resetHud();
  show('hud');
  acquireWake();
  if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume();
  // sensores (inclinación + G) si están activados y disponibles
  live.peaks = (settings.imu && IMU.supported()) ? TrazzaSensors.makePeaks() : null;
  { const tel=$('#hud-telemetry'); if(tel) tel.hidden = !live.peaks; }
  IMU.start();
  GPS.start(); // asegura modo correcto (real/sim)
  startClock();
  toast('A pista. El crono arranca en tu primer paso por meta', 2800);
}

function liveFix(fix){
  // guarda el fix + instantánea de sensores (1 Hz: no infla localStorage)
  const pt={ t:fix.t, lat:fix.lat, lon:fix.lon, acc:fix.acc, spd:fix.spd };
  if(live.peaks && IMU.available && IMU.last){
    pt.lean=Math.round(IMU.last.lean*10)/10;
    if(IMU.last.g) pt.g=Math.round((IMU.last.g.horiz||0)*100)/100;
  }
  live.track.push(pt);
  if(fix.spd!=null) live.speedMax=Math.max(live.speedMax, fix.spd);
  $('#hud-spd').textContent=fmtSpeed(fix.spd);
  $('#hud-spdmax').textContent=fmtSpeed(live.speedMax);

  // distancia acumulada de la vuelta (con filtro de ruido)
  if(live.prevFix && live.lapStartT!=null){
    const d=TrazzaDetect.haversine(live.prevFix.lat,live.prevFix.lon,fix.lat,fix.lon);
    if(d>1.5){ live.cumDist+=d; }
    const elapsed=fix.t-live.lapStartT;
    live.samples.push({ d:live.cumDist, t:elapsed });
    if(live.refProfile){
      const ref=TrazzaDetect.interpProfile(live.refProfile, live.cumDist);
      if(ref!=null){ setDelta(elapsed-ref); setTrackDelta(elapsed-ref); }  // delta y color en vivo
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
    checkReminders(1);
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
  const prevRefMs = live.refMs;
  live.laps.push({ n:ev.lapNum, ms:lapMs, sectors:secs });
  if(isBest){ live.best=lapMs; live.bestProfile=live.samples.slice(); }
  // la referencia del delta es la vuelta más rápida conocida (récord o sesión)
  if(live.refMs==null || lapMs<live.refMs){ live.refMs=lapMs; live.refProfile=live.samples.slice(); }
  // modo track: delta final de la vuelta vs la vuelta rápida previa
  setTrackDelta(prevRefMs!=null ? lapMs-prevRefMs : null);
  // ¿récord histórico del circuito? (sólo si ya había uno previo que batir)
  let isRecord=false, improved=0;
  if(live.record && lapMs<live.record.bestMs){ isRecord=true; live.newRecord=true; improved=live.record.bestMs-lapMs; live.record.bestMs=lapMs; }

  flashHud(); haptic(isRecord?[90,50,90,50,140]:isBest?[60,40,60]:80); beep(isBest||isRecord?'best':'lap');
  if(isRecord) toast('🏁 ¡RÉCORD DEL CIRCUITO! '+fmtLap(lapMs)+'  ('+fmtDelta(-improved)+')', 3400);
  else toast((isBest?'¡Mejor vuelta! ':'Vuelta '+ev.lapNum+' · ')+fmtLap(lapMs), 2600);

  // muestra los sectores recién cerrados (con color vs mejor sector)
  showLapSectors(secs);

  // siguiente vuelta
  startLapState(ev.t, ev.lapNum+1);
  $('#hud-lapnum').textContent='VUELTA '+String(live.lapNum).padStart(2,'0');
  renderHudLastBest();
  checkReminders(live.lapNum);
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
    // modo track: delta acumulado al cruzar el sector vs la vuelta rápida
    if(live.refProfile){ const ref=TrazzaDetect.interpProfile(live.refProfile, boundary); if(ref!=null) setTrackDelta(splitT-ref); }
    live.lastSplitT=splitT;
    live.curSectorIdx++;
  }
  highlightSector(live.curSectorIdx);
}

function renderHudLastBest(){
  const last=live.laps.length?live.laps[live.laps.length-1].ms:null;
  const sl=splitLap(last); $('#hud-last').innerHTML = last==null?'--':`${sl.main}<span class="ms">${sl.ms}</span>`;
  const sb=splitLap(live.best); $('#hud-best').innerHTML = live.best==null?'--':`${sb.main}<span class="ms">${sb.ms}</span>`;
  // modo track
  $('#tk-laps').textContent = live.laps.length;
  $('#tk-last').textContent = last==null?'--':fmtLap(last);
  $('#tk-best').textContent = live.best==null?'--':fmtLap(live.best);
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

/* ---- recordatorios por vuelta (aviso en el HUD) ---- */
let hudRemTimer=null;
function checkReminders(n){
  if(!live.reminders || !live.reminders.length) return;
  const due=live.reminders.filter(r=>r.lap===n && !live.firedReminders[r.lap+'|'+r.text]);
  if(!due.length) return;
  due.forEach(r=>{ live.firedReminders[r.lap+'|'+r.text]=true; });
  showHudReminder(n, due.map(r=>r.text));
  haptic([120,60,120]); beep('best');
}
function showHudReminder(lap, texts){
  const el=$('#hud-reminder'); if(!el) return;
  el.innerHTML=`<button class="rx" aria-label="Cerrar">✕</button><span class="rk">RECORDATORIO · VUELTA ${lap}</span>`
    + texts.map(t=>`<span class="rt">${esc(t)}</span>`).join('');
  el.hidden=false;
  el.querySelector('.rx').addEventListener('click', hideHudReminder);
  if(hudRemTimer) clearTimeout(hudRemTimer);
  hudRemTimer=setTimeout(hideHudReminder, 9000);
}
function hideHudReminder(){ const el=$('#hud-reminder'); if(el) el.hidden=true; if(hudRemTimer){ clearTimeout(hudRemTimer); hudRemTimer=null; } }
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
  // modo track
  $('#tk-laps').textContent='0'; $('#tk-elapsed').textContent='0:00';
  $('#tk-last').textContent='--'; $('#tk-best').textContent='--';
  $('#tk-cur').textContent='0:00.0'; setTrackDelta(null);
}
function flashHud(){ const h=$('#screen-hud'); h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash'); }
function startClock(){
  cancelAnimationFrame(live.rafId);
  const tick=()=>{
    if(!live.running) return;
    if(live.lapStartT!=null){ const cur=Date.now()-live.lapStartT; const sl=splitLap(cur); $('#hud-cur').innerHTML=`${sl.main}<span class="ms">${sl.ms}</span>`; $('#tk-cur').textContent=fmtTenths(cur); }
    if(live.startedAt!=null) $('#tk-elapsed').textContent=fmtMMSS(Date.now()-live.startedAt);
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
  IMU.stop();
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
  // distancia recorrida de la tanda (para «km en pista» del resumen de inicio)
  if(finalize){
    let dm=0; const tr=live.track;
    for(let i=1;i<tr.length;i++) dm+=TrazzaDetect.haversine(tr[i-1].lat,tr[i-1].lon,tr[i].lat,tr[i].lon);
    data.distM=Math.round(dm);
  }
  // telemetría de sensores (inclinación/G) si la tanda la registró
  if(live.peaks && (live.peaks.leanL||live.peaks.leanR||live.peaks.gHoriz)){
    data.imu={ leanL:Math.round(live.peaks.leanL), leanR:Math.round(live.peaks.leanR),
               gHoriz:Math.round(live.peaks.gHoriz*100)/100, gLon:Math.round(live.peaks.gLon*100)/100 };
  }
  // moto y reglaje de la tanda (garaje)
  if(live.bikeId){ data.bikeId=live.bikeId; data.bikeName=live.bikeName||null; data.setupName=live.setupName||null; }
  // al cerrar: suma horas de motor a la moto usada
  if(finalize && live.bikeId){
    const bikes=loadBikes(), b=bikes.find(x=>x.id===live.bikeId);
    if(b){ b.engineHours=TrazzaGarage.addEngineHours(b, TrazzaGarage.sessionHours(data)).engineHours; saveBikes(bikes); }
  }
  // récord histórico del circuito (se consolida al cerrar la sesión)
  if(finalize && live.recordKey){
    const stored = loadRecord(live.recordKey);            // PB previo a esta sesión
    data.recordKey = live.recordKey;
    data.prevRecordMs = stored ? stored.bestMs : null;
    data.isRecord = live.best!=null && (stored==null || live.best<stored.bestMs);
    if(data.isRecord){
      saveRecord(live.recordKey, { bestMs:live.best, profile:live.bestProfile||null, sectors:live.bestSectors.slice(), date:Date.now(), name:live.gate.name });
      data.recordMs = live.best;
    } else { data.recordMs = stored ? stored.bestMs : (live.best||null); }
  }
  currentId=data.id;
  const i=sessions.findIndex(s=>s.id===data.id);
  if(i>=0) sessions[i]=data; else sessions.unshift(data);
  saveJSON(LS_SESSIONS, sessions.slice(0,30));
  if(finalize) currentId=null;
  return data;
}
function renderSessions(){
  const list=$('#session-list'), sessions=loadJSON(LS_SESSIONS,[]);
  renderHomeDashboard(sessions);
  if(!sessions.length){ list.innerHTML='<div class="empty">Aún no tienes sesiones. Sal a pista y marca tu primera vuelta.</div>'; return; }
  list.innerHTML='';
  sessions.forEach(s=>{
    const d=new Date(s.startedAt);
    const date=d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'}).toUpperCase().replace('.','');
    const km = s.distM!=null ? (s.distM/1000).toFixed(1) : '–';
    const bike = s.bikeName ? `<span class="sess-bike">${esc(s.bikeName)}</span>` : '';
    const el=document.createElement('div'); el.className='sess';
    el.innerHTML=`<div class="top"><div class="nm">${esc(s.name)}${bike}</div><div class="dt">${date}</div></div>
      <div class="st">
        <div><span class="k">Mejor</span><div class="v green">${fmtLap(s.best)}</div></div>
        <div><span class="k">Vueltas</span><div class="v">${s.laps.length}</div></div>
        <div><span class="k">Km</span><div class="v">${km}</div></div>
      </div>`;
    el.addEventListener('click',()=>{ renderSummary(s); show('summary'); });
    list.appendChild(el);
  });
}
// Resumen de inicio: sesiones, vueltas, km en pista y mejor récord global.
function renderHomeDashboard(sessions){
  const el=$('#home-dash'); if(!el) return;
  sessions = sessions || loadJSON(LS_SESSIONS,[]);
  if(!sessions.length){ el.hidden=true; return; }
  el.hidden=false;
  let laps=0, dist=0;
  sessions.forEach(s=>{ laps+=(s.laps?s.laps.length:0); dist+=(s.distM||0); });
  $('#dash-sessions').textContent=sessions.length;
  $('#dash-laps').textContent=laps;
  $('#dash-km').textContent=(dist/1000).toFixed(1);
  let best=null; const recs=loadRecords();
  Object.keys(recs).forEach(k=>{ const r=recs[k]; if(r&&r.bestMs!=null&&(best==null||r.bestMs<best)) best=r.bestMs; });
  $('#dash-record').textContent = best!=null ? fmtLap(best) : '--';
}
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderSummary(s){
  if(!s) return; viewingSessionId=s.id; curSummary=s;
  $('#sum-title').textContent=s.name;
  $('#sum-best').textContent=fmtLap(s.best);
  const valid=s.laps.filter(l=>l.ms>0);
  const avg=valid.length?valid.reduce((a,l)=>a+l.ms,0)/valid.length:null;
  $('#sum-avg').textContent=fmtLap(avg);
  $('#sum-count').textContent=s.laps.length;
  $('#sum-vmax').textContent=(s.speedMaxKmh!=null?Math.round(s.speedMaxKmh*(settings.units==='mph'?0.621371:1)):'--')+' '+speedUnit();
  $('#sum-opt').textContent = s.optimal!=null ? fmtLap(s.optimal) : '--';
  // telemetría de sensores (inclinación / G máx) si la tanda la registró
  const imuBox=$('#sum-imu');
  if(imuBox){
    if(s.imu){
      imuBox.hidden=false;
      $('#sum-lean').textContent=Math.max(s.imu.leanL,s.imu.leanR)+'°';
      $('#sum-lean-lr').textContent='IZQ '+s.imu.leanL+'° · DER '+s.imu.leanR+'°';
      $('#sum-g').textContent=(s.imu.gHoriz||0).toFixed(1).replace('.',',')+' g';
    } else imuBox.hidden=true;
  }

  // banner de récord del circuito
  const rb=$('#sum-record');
  if(rb){
    if(s.recordMs==null){ rb.hidden=true; rb.className='record'; }
    else if(s.isRecord){
      rb.hidden=false; rb.className='record new';
      const vs = s.prevRecordMs!=null ? ` · ${fmtDelta(s.recordMs-s.prevRecordMs)} vs anterior` : ' · primer récord';
      rb.innerHTML=`<span class="tag">🏁 NUEVO RÉCORD</span><span class="t">${fmtLap(s.recordMs)}</span><span class="d">${esc(vs)}</span>`;
    } else {
      rb.hidden=false; rb.className='record';
      const gap = s.best!=null ? ` · a ${fmtDelta(s.best-s.recordMs)} de tu récord` : '';
      rb.innerHTML=`<span class="tag">RÉCORD DEL CIRCUITO</span><span class="t">${fmtLap(s.recordMs)}</span><span class="d">${esc(gap)}</span>`;
    }
  }

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
  // toggle de color del mapa: velocidad / inclinación (solo si hay lean)
  const hasLean=(s.track||[]).some(p=>p.lean!=null);
  sumColorMode='spd';
  const cm=$('#sum-colormode'); if(cm){ cm.hidden=!hasLean; $all('#sum-colormode button').forEach(b=>b.classList.toggle('on', b.dataset.cm==='spd')); }
  updateMapLegend('spd');
  const sm=$('#sum-map');
  if(sm){ sm._view={zoom:1,panX:0,panY:0}; attachMapZoom(sm, ()=>drawSummaryMap(sm, s)); }
  requestAnimationFrame(()=>drawSummaryMap(sm, s));
}
function updateMapLegend(mode){
  const el=$('#sum-legend'); if(!el) return;
  if(mode==='lean'){
    el.innerHTML='<span><i class="lg" style="background:#1FE0C8"></i>Suave</span>'
      +'<span><i class="lg" style="background:#FF9E1B"></i>Medio</span>'
      +'<span><i class="lg" style="background:#FF3B30"></i>Al límite</span>'
      +'<span><i class="lg" style="background:rgba(138,147,166,.5)"></i>Resto</span>';
  } else {
    el.innerHTML='<span><i class="lg" style="background:#FF3B30"></i>Lento</span>'
      +'<span><i class="lg" style="background:#FF9E1B"></i>Medio</span>'
      +'<span><i class="lg" style="background:#1FE0C8"></i>Rápido</span>'
      +'<span><i class="lg" style="background:rgba(138,147,166,.5)"></i>Resto</span>';
  }
}

/* ----------------------------- Análisis de tanda ----------------------------- */
// Toque Trazza: narrativa primero (dónde está la vuelta), honestidad de datos,
// y todo por DISTANCIA recorrida (coherente con el delta predictivo).
let anProfiles=null;            // [{n, ms, profile:[{d,t,spd}]}]
let anSel={ a:null, b:null };   // nº de vuelta A/B
const pad2=n=>String(n).padStart(2,'0');
const capFirst=s=>s.charAt(0).toUpperCase()+s.slice(1);

// reconstruye el perfil por distancia de cada vuelta desde el track + crossTimes
function buildLapProfiles(s){
  if(!s || !s.track || !s.track.length || !s.crossTimes || s.crossTimes.length<2) return [];
  const segs=TrazzaAnalyze.segmentLaps(s.track, s.crossTimes);
  return segs.map((seg,i)=>{
    const lap=s.laps[i]||null;
    return { n: lap?lap.n:seg.n, ms: lap?lap.ms:(seg.t1-seg.t0), profile: TrazzaAnalyze.lapProfile(seg.points) };
  }).filter(x=>x.profile.length>=2);
}

function openAnalysis(s){
  if(!s) return;
  curSummary=s;
  anProfiles=buildLapProfiles(s);
  $('#an-title').textContent='Análisis · '+(s.name||'tanda');
  if(anProfiles.length<1){ renderAnalysisEmpty(); show('analysis'); return; }
  const byMs=anProfiles.slice().sort((a,b)=>a.ms-b.ms);
  anSel.a=byMs[0].n; anSel.b=(byMs[1]||byMs[0]).n;
  fillLapSelectors();
  show('analysis');
  renderAnalysis();                         // narrativa + tabla (síncrono)
  requestAnimationFrame(renderAnalysis);    // redibuja las gráficas con el tamaño ya aplicado
}

function renderAnalysisEmpty(){
  $('#an-narr').innerHTML='<div class="an-empty">Esta tanda no guardó telemetría (sesión antigua o sin track GPS). Las nuevas tandas con esta versión traerán el análisis completo.</div>';
  $('#an-a').innerHTML=''; $('#an-b').innerHTML=''; $('#an-laps').innerHTML='';
  ['#an-delta','#an-speed'].forEach(id=>{ const c=$(id); if(c&&c.getContext){ const x=c.getContext('2d'); x&&x.clearRect(0,0,c.width,c.height);} });
}

function fillLapSelectors(){
  const html=anProfiles.slice().sort((a,b)=>a.n-b.n)
    .map(p=>`<option value="${p.n}">V${pad2(p.n)} · ${fmtLap(p.ms)}</option>`).join('');
  const a=$('#an-a'), b=$('#an-b');
  a.innerHTML=html; b.innerHTML=html; a.value=anSel.a; b.value=anSel.b;
  a.onchange=()=>{ anSel.a=+a.value; renderAnalysis(); };
  b.onchange=()=>{ anSel.b=+b.value; renderAnalysis(); };
}
const profOf=n=>{ const p=anProfiles&&anProfiles.find(x=>x.n===n); return p?p.profile:null; };

function renderAnalysis(){
  const pa=profOf(anSel.a), pb=profOf(anSel.b);
  const la=anProfiles.find(x=>x.n===anSel.a), lb=anProfiles.find(x=>x.n===anSel.b);
  const nSec=curSummary.nSectors||3;
  const gl=(pa&&pb)?TrazzaAnalyze.gainLossBySector(pa,pb,nSec):[];
  const dd=(pa&&pb)?TrazzaAnalyze.deltaByDistance(pa,pb,160):[];
  const totalMs=dd.length&&dd[dd.length-1].dt!=null ? dd[dd.length-1].dt : (la&&lb?(la.ms-lb.ms):null);
  renderNarrative(la,lb,gl,totalMs);
  drawDeltaChart($('#an-delta'), dd);
  drawSpeedChart($('#an-speed'), dd);
  // inclinación por distancia: solo si alguna de las dos vueltas tiene lean
  const hasLean = dd.some(p=>p.leanA!=null || p.leanB!=null);
  const lw=$('#an-lean-wrap'); if(lw) lw.hidden=!hasLean;
  if(hasLean) drawLeanChart($('#an-lean'), dd);
  renderAnalysisLaps();
}

function renderNarrative(la,lb,gl,totalMs){
  const box=$('#an-narr'); if(!la||!lb){ box.innerHTML='<div class="an-empty">Elige dos vueltas para comparar.</div>'; return; }
  const same=la.n===lb.n;
  let head;
  if(same){
    head=`<div class="an-head one"><div><span class="k cyan">Vuelta ${pad2(la.n)}</span><span class="an-hero cyan">${fmtLap(la.ms)}</span></div><div class="an-note">Elige una vuelta distinta en B para comparar.</div></div>`;
  } else {
    const cls=totalMs<0?'good':(totalMs>0?'bad':'flat');
    head=`<div class="an-head">
      <div class="an-side"><span class="k cyan">A · V${pad2(la.n)}</span><span class="an-hero cyan">${fmtLap(la.ms)}</span></div>
      <div class="an-net ${cls}"><b>${fmtDelta(totalMs)}</b><small>A frente a B</small></div>
      <div class="an-side r"><span class="k amber">B · V${pad2(lb.n)}</span><span class="an-hero amber">${fmtLap(lb.ms)}</span></div>
    </div>`;
  }
  let chips='';
  if(gl.length && !same){
    chips='<div class="an-sec-row">'+gl.map(g=>{
      const c=g.dt<-10?'good':(g.dt>10?'bad':'flat');   // ±10 ms ≈ ruido GPS 1 Hz
      return `<span class="an-sec ${c}"><b>S${g.sector}</b>${fmtDelta(g.dt)}</span>`;
    }).join('')+'</div>';
    const worst=gl.slice().sort((a,b)=>b.dt-a.dt)[0];    // mayor pérdida (dt+)
    const best=gl.slice().sort((a,b)=>a.dt-b.dt)[0];     // mayor ganancia (dt−)
    const parts=[];
    if(worst&&worst.dt>10) parts.push(`donde más tiempo dejas es el <b>Sector ${worst.sector}</b> (${fmtDelta(worst.dt)})`);
    if(best&&best.dt<-10) parts.push(`donde más ganas es el <b>Sector ${best.sector}</b> (${fmtDelta(best.dt)})`);
    chips += parts.length
      ? '<p class="an-line">'+capFirst(parts.join(', y '))+'.</p>'
      : '<p class="an-line">Vueltas muy parejas: las diferencias caben dentro del ruido del GPS.</p>';
  }
  box.innerHTML=head+chips;
}

// base común de canvas de gráfica (DPR + rectángulo de dibujo)
function chartBase(canvas){
  if(!canvas) return null;
  const dpr=window.devicePixelRatio||1, W=canvas.clientWidth, H=canvas.clientHeight;
  if(!W||!H) return null;
  canvas.width=W*dpr; canvas.height=H*dpr;
  const ctx=canvas.getContext&&canvas.getContext('2d'); if(!ctx) return null;
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const padc={l:36,r:12,t:12,b:16}, pw=W-padc.l-padc.r, ph=H-padc.t-padc.b;
  return { ctx, W, H, pad:padc, pw, ph };
}
function emptyChart(B,msg){ if(!B)return; B.ctx.fillStyle='#8A93A6'; B.ctx.font='600 12px Inter,sans-serif'; B.ctx.textAlign='center'; B.ctx.fillText(msg,B.W/2,B.H/2); }

// delta por distancia: área verde (A por delante) / roja (A pierde) alrededor de 0
function drawDeltaChart(canvas, dd){
  const B=chartBase(canvas); if(!B) return;
  if(!dd||dd.length<2){ emptyChart(B,'Sin datos para comparar'); return; }
  const {ctx,pad,pw,ph}=B, L=dd[dd.length-1].d||1;
  let maxAbs=200; dd.forEach(p=>{ if(p.dt!=null) maxAbs=Math.max(maxAbs,Math.abs(p.dt)); });
  const X=d=>pad.l+(d/L)*pw, Y=v=>pad.t+ph/2-(v/maxAbs)*(ph/2);
  for(let i=1;i<dd.length;i++){ const a=dd[i-1],b=dd[i]; if(a.dt==null||b.dt==null)continue;
    ctx.beginPath(); ctx.moveTo(X(a.d),Y(0)); ctx.lineTo(X(a.d),Y(a.dt)); ctx.lineTo(X(b.d),Y(b.dt)); ctx.lineTo(X(b.d),Y(0)); ctx.closePath();
    ctx.fillStyle=((a.dt+b.dt)/2<0)?'rgba(182,255,26,.22)':'rgba(255,59,48,.22)'; ctx.fill(); }
  ctx.strokeStyle='rgba(138,147,166,.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(pad.l,Y(0)); ctx.lineTo(pad.l+pw,Y(0)); ctx.stroke();
  ctx.beginPath(); dd.forEach((p,i)=>{ if(p.dt==null)return; const x=X(p.d),y=Y(p.dt); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.strokeStyle='#F5F7FA'; ctx.lineWidth=1.6; ctx.lineJoin='round'; ctx.stroke();
  ctx.fillStyle='#8A93A6'; ctx.font='600 10px Saira,sans-serif'; ctx.textAlign='left';
  ctx.fillText('+'+(maxAbs/1000).toFixed(2).replace('.',','), 2, Y(maxAbs)+8);
  ctx.fillText('0', 2, Y(0)+3);
  ctx.fillText('−'+(maxAbs/1000).toFixed(2).replace('.',','), 2, Y(-maxAbs));
  const end=dd[dd.length-1].dt;
  if(end!=null){ ctx.textAlign='right'; ctx.font='700 12px Saira,sans-serif'; ctx.fillStyle=end<0?'#B6FF1A':'#FF3B30'; ctx.fillText(fmtDelta(end), pad.l+pw, Y(0)-6); }
}

// velocidad por distancia: A (cian) sobre B (ámbar)
function drawSpeedChart(canvas, dd){
  const B=chartBase(canvas); if(!B) return;
  if(!dd||dd.length<2){ emptyChart(B,'Sin datos'); return; }
  const {ctx,pad,pw,ph}=B, L=dd[dd.length-1].d||1;
  let vmax=0; dd.forEach(p=>{ if(p.spdA!=null)vmax=Math.max(vmax,p.spdA); if(p.spdB!=null)vmax=Math.max(vmax,p.spdB); });
  if(vmax<=0){ emptyChart(B,'Esta tanda no guardó velocidad'); return; }
  const f=speedFactor(), X=d=>pad.l+(d/L)*pw, Y=v=>pad.t+ph-(v/vmax)*ph;
  ctx.strokeStyle='rgba(138,147,166,.14)'; ctx.lineWidth=1;
  [0.5,1].forEach(fr=>{ const y=Y(vmax*fr); ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(pad.l+pw,y); ctx.stroke(); });
  const line=(key,color)=>{ ctx.beginPath(); let on=false; dd.forEach(p=>{ const v=p[key]; if(v==null)return; const x=X(p.d),y=Y(v); on?ctx.lineTo(x,y):ctx.moveTo(x,y); on=true; }); ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.lineJoin='round'; ctx.stroke(); };
  line('spdB','#FF9E1B'); line('spdA','#1FE0C8');
  ctx.fillStyle='#8A93A6'; ctx.font='600 10px Saira,sans-serif'; ctx.textAlign='left';
  ctx.fillText(Math.round(vmax*f)+'', 2, Y(vmax)+8);
  ctx.fillText('0', 2, Y(0)-1);
  ctx.textAlign='right'; ctx.fillText(Math.round(L)+' m', pad.l+pw, pad.t+ph+13);
}

// inclinación por distancia: izquierda (arriba) / derecha (abajo), A cian / B ámbar
function drawLeanChart(canvas, dd){
  const B=chartBase(canvas); if(!B) return;
  if(!dd||dd.length<2){ emptyChart(B,'Sin datos'); return; }
  const {ctx,pad,pw,ph}=B, L=dd[dd.length-1].d||1;
  let lmax=20; dd.forEach(p=>{ if(p.leanA!=null)lmax=Math.max(lmax,Math.abs(p.leanA)); if(p.leanB!=null)lmax=Math.max(lmax,Math.abs(p.leanB)); });
  const X=d=>pad.l+(d/L)*pw, Y=v=>pad.t+ph/2-(v/lmax)*(ph/2);
  ctx.strokeStyle='rgba(138,147,166,.25)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(pad.l,Y(0)); ctx.lineTo(pad.l+pw,Y(0)); ctx.stroke();
  const line=(key,color)=>{ ctx.beginPath(); let on=false; dd.forEach(p=>{ const v=p[key]; if(v==null)return; const x=X(p.d),y=Y(v); on?ctx.lineTo(x,y):ctx.moveTo(x,y); on=true; }); ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.lineJoin='round'; ctx.stroke(); };
  line('leanB','#FF9E1B'); line('leanA','#1FE0C8');
  ctx.fillStyle='#8A93A6'; ctx.font='600 10px Saira,sans-serif'; ctx.textAlign='left';
  ctx.fillText('DER '+Math.round(lmax)+'°', 2, Y(lmax)+8);
  ctx.fillText('IZQ '+Math.round(lmax)+'°', 2, Y(-lmax));
}

function renderAnalysisLaps(){
  const s=curSummary, best=s.bestSectors||[], wrap=$('#an-laps'); wrap.innerHTML='';
  s.laps.forEach(l=>{
    const isBest=l.ms===s.best, selA=l.n===anSel.a, selB=l.n===anSel.b;
    let cls='best',txt='MEJOR';
    if(!isBest){ const sec=(l.ms-s.best)/1000; txt='+'+sec.toFixed(2).replace('.',','); cls=sec>=1?'worse':'close'; }
    let secsHtml='';
    if(l.sectors&&l.sectors.length){
      secsHtml='<div class="lap-secs">'+l.sectors.map((sv,i)=>{
        const d=best[i]!=null?sv-best[i]:null, isB=best[i]!=null&&Math.abs(sv-best[i])<1e-6;
        return `<span class="sc ${isB?'good':sectorClass(d)}">S${i+1} ${fmtSecShort(sv)}</span>`;
      }).join('')+'</div>';
    }
    const tag=selA?'<span class="an-tag cyan">A</span>':selB?'<span class="an-tag amber">B</span>':'';
    const row=document.createElement('div'); row.className='lap'+(isBest?' best':'')+(selA?' selA':'')+(selB?' selB':'');
    row.innerHTML=`<div class="lap-top"><span class="ln">${pad2(l.n)}${tag}</span><div class="rt"><span class="lt">${fmtLap(l.ms)}</span><span class="dl ${cls}">${txt}</span></div></div>${secsHtml}`;
    row.addEventListener('click',()=>{ if(l.n!==anSel.b){ anSel.a=l.n; $('#an-a').value=anSel.a; renderAnalysis(); } });
    wrap.appendChild(row);
  });
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
function setupCanvas(canvas, allPts, view){
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
  // transform de vista (zoom/pan), centrado en el canvas
  const z=(view&&view.zoom)||1, px=(view&&view.panX)||0, py=(view&&view.panY)||0, cx=W/2, cy=H/2;
  return { ctx, W, H, k, scale:scale*z, zoom:z,
    toPx:p=>{ const bx=offX+(p.lon*k-minX)*scale, by=H-(offY+(p.lat-minY)*scale);
      return { x:(bx-cx)*z+cx+px, y:(by-cy)*z+cy+py }; } };
}
// Zoom/pan en un canvas de mapa: rueda, arrastrar, pellizco (móvil) y doble toque para reset.
function attachMapZoom(canvas, redraw){
  if(!canvas || canvas._zoomBound){ if(canvas) canvas._redraw=redraw; return; }
  canvas._zoomBound=true; canvas._redraw=redraw;
  const v=()=>canvas._view||(canvas._view={zoom:1,panX:0,panY:0});
  const MIN=1, MAX=10;
  const draw=()=>{ const o=v(), W=canvas.clientWidth,H=canvas.clientHeight;
    const mx=W*(o.zoom-1)/2, my=H*(o.zoom-1)/2;                 // límites de paneo
    o.panX=Math.max(-mx,Math.min(mx,o.panX)); o.panY=Math.max(-my,Math.min(my,o.panY));
    (canvas._redraw||redraw)(); };
  const rel=(cx,cy)=>{ const r=canvas.getBoundingClientRect(); return [cx-r.left-r.width/2, cy-r.top-r.height/2]; };
  const zoomAt=(rx,ry,factor)=>{ const o=v(); const nz=Math.max(MIN,Math.min(MAX,o.zoom*factor)); const k=nz/o.zoom;
    o.panX=rx-(rx-o.panX)*k; o.panY=ry-(ry-o.panY)*k; o.zoom=nz; draw(); };
  const reset=()=>{ canvas._view={zoom:1,panX:0,panY:0}; draw(); };
  canvas._zoomReset=reset; canvas._zoomBtn=(f)=>zoomAt(0,0,f);
  canvas.addEventListener('wheel',e=>{ e.preventDefault(); const [rx,ry]=rel(e.clientX,e.clientY); zoomAt(rx,ry,e.deltaY<0?1.18:1/1.18); },{passive:false});
  canvas.addEventListener('dblclick',e=>{ e.preventDefault(); reset(); });
  // arrastrar con ratón
  let drag=null;
  canvas.addEventListener('mousedown',e=>{ drag={x:e.clientX,y:e.clientY}; });
  window.addEventListener('mousemove',e=>{ if(!drag)return; const o=v(); o.panX+=e.clientX-drag.x; o.panY+=e.clientY-drag.y; drag={x:e.clientX,y:e.clientY}; draw(); });
  window.addEventListener('mouseup',()=>{ drag=null; });
  // táctil: 1 dedo paneo, 2 dedos pellizco
  let tPan=null, tDist=0, lastTap=0;
  const dist=(a,b)=>Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
  canvas.addEventListener('touchstart',e=>{
    if(e.touches.length===1){ const now=Date.now(); if(now-lastTap<300){ reset(); lastTap=0; } else lastTap=now; tPan={x:e.touches[0].clientX,y:e.touches[0].clientY}; }
    else if(e.touches.length===2){ tDist=dist(e.touches[0],e.touches[1]); tPan=null; }
  },{passive:true});
  canvas.addEventListener('touchmove',e=>{
    if(e.touches.length===2){ e.preventDefault(); const nd=dist(e.touches[0],e.touches[1]);
      const mx=(e.touches[0].clientX+e.touches[1].clientX)/2, my=(e.touches[0].clientY+e.touches[1].clientY)/2;
      const [rx,ry]=rel(mx,my); if(tDist>0) zoomAt(rx,ry,nd/tDist); tDist=nd; }
    else if(e.touches.length===1 && tPan){ const o=v(); o.panX+=e.touches[0].clientX-tPan.x; o.panY+=e.touches[0].clientY-tPan.y; tPan={x:e.touches[0].clientX,y:e.touches[0].clientY}; draw(); }
  },{passive:false});
  canvas.addEventListener('touchend',e=>{ if(e.touches.length===0){ tPan=null; tDist=0; } });
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
  const P=setupCanvas(canvas, track.concat(s.gate?[s.gate]:[]), canvas._view); if(!P) return;
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
  // modo de color: velocidad (por defecto) o inclinación (|lean|) si hay sensores
  const mode = (sumColorMode==='lean' && seg.some(p=>p.lean!=null)) ? 'lean' : 'spd';
  let vmin, vmax;
  if(mode==='lean'){ const vs=seg.map(p=>p.lean!=null?Math.abs(p.lean):null).filter(v=>v!=null); vmin=0; vmax=vs.length?Math.max(...vs):1; }
  else { const vs=seg.map(p=>p.spd).filter(v=>v!=null); vmin=vs.length?Math.min(...vs):0; vmax=vs.length?Math.max(...vs):1; }
  const rng=(vmax-vmin)||1;
  for(let i=1;i<seg.length;i++){
    const a=P.toPx(seg[i-1]), b=P.toPx(seg[i]);
    const raw = mode==='lean' ? (seg[i].lean!=null?Math.abs(seg[i].lean):vmin) : (seg[i].spd!=null?seg[i].spd:vmin);
    const frac=(raw-vmin)/rng;
    P.ctx.beginPath(); P.ctx.moveTo(a.x,a.y); P.ctx.lineTo(b.x,b.y);
    P.ctx.strokeStyle=speedColor(mode==='lean'?(1-frac):frac); P.ctx.lineWidth=3.5; P.ctx.lineJoin='round'; P.ctx.lineCap='round'; P.ctx.stroke();
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
  const rec=loadRecord(recordKey(selectedMeta));
  const recTxt = rec ? ` · 🏁 récord ${fmtLap(rec.bestMs)}` : '';
  $('#meta-sub').textContent=`${selectedMeta.lat.toFixed(5)}, ${selectedMeta.lon.toFixed(5)} · radio ${settings.radius} m${recTxt}`;
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
    if(k==='imu' && settings.imu){
      IMU.requestPermission().then(r=>{
        if(r==='unsupported') toast('Este móvil no expone sensores de movimiento',2800);
        else if(r==='denied') toast('Permiso de sensores denegado',2800);
        else toast('Inclinación y G activados · se calibra al salir a pista',3000);
      });
    }
  }));
  $('#btn-clear').addEventListener('click',()=>{ if(confirm('¿Borrar TODAS las sesiones? No se puede deshacer.')){ localStorage.removeItem(LS_SESSIONS); renderSessions(); toast('Sesiones borradas'); } });
  $('#btn-clear-records').addEventListener('click',()=>{ if(confirm('¿Borrar todos los récords de circuito (PB)?')){ localStorage.removeItem(LS_RECORDS); toast('Récords borrados'); } });
}

/* ----------------------------- Garaje ----------------------------- */
const LS_BIKES='trazza.bikes.v1', LS_PRESESSION='trazza.presession.v1';
const BIKE_CATS=['Supersport','Superbike','Naked','Trail','2T','Clásica','Scooter','Otra'];
function loadBikes(){ return loadJSON(LS_BIKES, []); }
function saveBikes(a){ saveJSON(LS_BIKES, a); }
function bikeById(id){ return loadBikes().find(b=>b.id===id)||null; }
let preSession = loadJSON(LS_PRESESSION, null);  // {bikeId,bikeName,setupId,setupName}
let viewingBikeId=null, editingBikeId=null, editingSetupId=null;
function savePreSession(){ saveJSON(LS_PRESESSION, preSession); renderBikeCard(); }

function renderBikeCard(){
  const nm=$('#bike-card-name'), sub=$('#bike-card-sub'); if(!nm) return;
  if(preSession && preSession.bikeId && bikeById(preSession.bikeId)){
    nm.textContent=preSession.bikeName||'Moto';
    sub.textContent = preSession.setupName ? ('Reglaje: '+preSession.setupName) : 'Sin reglaje · toca para elegir';
  } else { nm.textContent='Sin moto'; sub.textContent='Elige moto y reglaje para la tanda (opcional)'; }
}
function bikeSpecLine(b){
  const bits=[]; const mm=[b.make,b.model].filter(Boolean).join(' '); if(mm) bits.push(mm);
  if(b.cc) bits.push(b.cc+' cc'); if(b.cv) bits.push(b.cv+' CV'); if(b.category) bits.push(b.category);
  return bits.join(' · ')||'Moto';
}
function numOrNull(v){ v=(''+(v==null?'':v)).trim(); if(!v) return null; const n=+v; return isFinite(n)?n:null; }

function openGarage(){ renderGarage(); show('garage'); }
function renderGarage(){
  const list=$('#bike-list'), bikes=loadBikes();
  $('#garage-empty').hidden = bikes.length>0;
  list.innerHTML='';
  bikes.forEach(b=>{
    const due=(b.maint||[]).filter(m=>TrazzaGarage.maintStatus(m, b.engineHours).due).length;
    const el=document.createElement('button'); el.className='card row-card';
    el.innerHTML=`<div><div class="row-title">${esc(b.name)}</div>
      <div class="row-sub">${esc(bikeSpecLine(b))} · ${(+b.engineHours||0).toFixed(1)} h motor</div></div>
      ${due?`<span class="maint-badge">${due}</span>`:'<svg class="chev" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A93A6" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>'}`;
    el.addEventListener('click',()=>openBike(b.id));
    list.appendChild(el);
  });
}

function openBike(id){ viewingBikeId=id; renderBike(); show('bike'); }
function renderBike(){
  const b=bikeById(viewingBikeId); if(!b){ openGarage(); return; }
  $('#bike-title').textContent=b.name; $('#bike-name2').textContent=b.name;
  $('#bike-specs').textContent=bikeSpecLine(b)+(b.kg?(' · '+b.kg+' kg'):'');
  $('#bike-hours').textContent=(+b.engineHours||0).toFixed(1)+' h';
  const maint=b.maint||[];
  const due=maint.filter(m=>TrazzaGarage.maintStatus(m, b.engineHours).due).length;
  $('#bike-maint-count').textContent = due? (due+' por hacer') : 'al día';
  const mw=$('#bike-maint'); mw.innerHTML='';
  maint.forEach(m=>{
    const st=TrazzaGarage.maintStatus(m, b.engineHours), pct=Math.round(st.frac*100);
    const cls=st.due?'bad':st.frac>=0.8?'warn':'ok';
    const rem=st.due?'¡toca!':('faltan '+st.remaining.toFixed(1)+' h');
    const row=document.createElement('div'); row.className='maint';
    row.innerHTML=`<div class="maint-top"><span class="ml">${esc(m.label)}</span><span class="mr ${cls}">${rem}</span></div>
      <div class="mbar"><i class="${cls}" style="width:${pct}%"></i></div>
      <div class="maint-bot"><span>cada ${m.intervalH} h</span><button class="mini-done" type="button">Hecho</button></div>`;
    row.querySelector('.mini-done').addEventListener('click',()=>markMaintDone(b.id, m.id));
    mw.appendChild(row);
  });
  const sw=$('#bike-setups'); sw.innerHTML='';
  const setups=b.setups||[];
  if(!setups.length) sw.innerHTML='<div class="empty">Sin reglajes. Añade uno para guardar clics y comparar tiempos.</div>';
  setups.forEach(s=>{
    const row=document.createElement('div'); row.className='card row-card setup-row';
    row.innerHTML=`<div><div class="row-title sm">${esc(s.name)}</div><div class="row-sub">${esc(setupSummary(s))}</div></div>
      <button class="mini-use" type="button">Usar</button>`;
    row.addEventListener('click',(e)=>{ if(e.target.closest('.mini-use')) return; openSetupEdit(b.id, s.id); });
    row.querySelector('.mini-use').addEventListener('click',(e)=>{ e.stopPropagation(); usePreSession(b, s); });
    sw.appendChild(row);
  });
  const bw=$('#bike-best'); bw.innerHTML='';
  const rows=TrazzaGarage.bestSetups(loadJSON(LS_SESSIONS,[]), b.id);
  if(!rows.length) bw.innerHTML='<div class="empty">Aún no hay tiempos con esta moto.</div>';
  rows.forEach(r=>{
    const el=document.createElement('div'); el.className='best-row';
    el.innerHTML=`<div><div class="br-c">${esc(r.circuit)}</div><div class="br-s">${esc(r.setup)}</div></div><div class="br-t green">${fmtLap(r.bestMs)}</div>`;
    bw.appendChild(el);
  });
}
function setupSummary(s){
  const f=s.fields||{}, bits=[];
  if(f.presDel!=null||f.presTra!=null) bits.push('pres '+(f.presDel!=null?f.presDel:'–')+'/'+(f.presTra!=null?f.presTra:'–'));
  if(f.altTra!=null) bits.push('alt tras '+f.altTra);
  if(s.notes) bits.push(s.notes);
  return bits.join(' · ')||'Ficha de reglaje';
}
function markMaintDone(bikeId, mid){
  const bikes=loadBikes(), b=bikes.find(x=>x.id===bikeId); if(!b) return;
  const m=(b.maint||[]).find(x=>x.id===mid); if(!m) return;
  m.lastH=+b.engineHours||0; saveBikes(bikes); renderBike(); toast(m.label+' · al día'); haptic(30);
}
function usePreSession(b, setup){
  preSession={ bikeId:b.id, bikeName:b.name, setupId:setup?setup.id:null, setupName:setup?setup.name:null };
  savePreSession(); toast('Usarás '+b.name+(setup?(' · '+setup.name):'')+' en la tanda', 2600);
  show('home'); refreshStartState();
}

function formRow(label,type,id,val,ph){
  const v = (val!=null && val!=='') ? esc(String(val)) : '';
  return `<label class="frow"><span>${label}</span><input type="${type}" id="${id}" value="${v}" placeholder="${ph||''}" ${type==='number'?'inputmode="decimal"':''}></label>`;
}
function openBikeEdit(id){
  editingBikeId=id||null; const b=id?bikeById(id):null;
  $('#bike-edit-title').textContent = b?'Editar moto':'Nueva moto';
  const cats=BIKE_CATS.map(c=>`<option value="${c}" ${b&&b.category===c?'selected':''}>${c}</option>`).join('');
  $('#bike-form').innerHTML=
    formRow('Nombre','text','f-name',b?b.name:'', 'Mi Panigale')+
    formRow('Marca','text','f-make',b?b.make:'', 'Ducati')+
    formRow('Modelo','text','f-model',b?b.model:'', 'Panigale V4 S')+
    formRow('Cilindrada (cc)','number','f-cc',b?b.cc:'', '1103')+
    formRow('Potencia (CV)','number','f-cv',b?b.cv:'', '215')+
    formRow('Peso (kg)','number','f-kg',b?b.kg:'', '195')+
    `<label class="frow"><span>Categoría</span><select id="f-cat">${cats}</select></label>`+
    formRow('Horas de motor','number','f-hours',b?b.engineHours:'0', '0');
  show('bike-edit');
}
function saveBike(){
  const name=($('#f-name').value||'').trim(); if(!name){ toast('Pon un nombre a la moto'); return; }
  const bikes=loadBikes();
  let b=editingBikeId? bikes.find(x=>x.id===editingBikeId):null;
  const data={ name, make:($('#f-make').value||'').trim(), model:($('#f-model').value||'').trim(),
    cc:numOrNull($('#f-cc').value), cv:numOrNull($('#f-cv').value), kg:numOrNull($('#f-kg').value),
    category:$('#f-cat').value, engineHours:Math.max(0, +($('#f-hours').value)||0) };
  if(b){ Object.assign(b, data); }
  else { b=Object.assign({ id:'b'+Date.now() }, data, { maint:TrazzaGarage.defaultMaintenance(), setups:[] }); bikes.unshift(b); }
  saveBikes(bikes); viewingBikeId=b.id; renderBikeCard(); openBike(b.id); toast('Moto guardada');
}
function delBike(){
  if(!viewingBikeId) return;
  if(!confirm('¿Borrar esta moto y sus reglajes?')) return;
  saveBikes(loadBikes().filter(b=>b.id!==viewingBikeId));
  if(preSession && preSession.bikeId===viewingBikeId){ preSession=null; savePreSession(); }
  openGarage(); toast('Moto borrada');
}

function openSetupEdit(bikeId, setupId){
  editingBikeId=bikeId; editingSetupId=setupId||null;
  const b=bikeById(bikeId); const s=setupId?(b.setups||[]).find(x=>x.id===setupId):null;
  $('#setup-title').textContent = s?'Editar reglaje':'Nuevo reglaje';
  $('#setup-del').style.visibility = s?'visible':'hidden';
  const f=s&&s.fields?s.fields:{};
  const fieldRows=TrazzaGarage.SETUP_FIELDS.map(ff=>formRow(ff.label+' ('+ff.unit+')','number','sf-'+ff.id, f[ff.id]!=null?f[ff.id]:'', '')).join('');
  $('#setup-form').innerHTML=
    formRow('Nombre','text','s-name', s?s.name:'', 'Cheste B (+2 mm trasera)')+
    `<label class="frow"><span>Notas</span><textarea id="s-notes" rows="2" placeholder="Más altura detrás, mejor en la 1 y la 2">${s&&s.notes?esc(s.notes):''}</textarea></label>`+
    fieldRows;
  show('setup-edit');
}
function saveSetup(){
  const name=($('#s-name').value||'').trim(); if(!name){ toast('Pon un nombre al reglaje'); return; }
  const bikes=loadBikes(), b=bikes.find(x=>x.id===editingBikeId); if(!b){ openGarage(); return; }
  b.setups=b.setups||[];
  const fields={}; TrazzaGarage.SETUP_FIELDS.forEach(ff=>{ const v=numOrNull($('#sf-'+ff.id).value); if(v!=null) fields[ff.id]=v; });
  const notes=($('#s-notes').value||'').trim();
  let s=editingSetupId? b.setups.find(x=>x.id===editingSetupId):null;
  if(s){ s.name=name; s.notes=notes; s.fields=fields; }
  else { s={ id:'r'+Date.now(), name, notes, fields }; b.setups.push(s); }
  saveBikes(bikes); openBike(b.id); toast('Reglaje guardado');
}
function delSetup(){
  const bikes=loadBikes(), b=bikes.find(x=>x.id===editingBikeId); if(!b) return;
  if(!editingSetupId){ openBike(b.id); return; }
  if(!confirm('¿Borrar este reglaje?')) return;
  b.setups=(b.setups||[]).filter(x=>x.id!==editingSetupId);
  if(preSession && preSession.setupId===editingSetupId){ preSession.setupId=null; preSession.setupName=null; savePreSession(); }
  saveBikes(bikes); openBike(b.id); toast('Reglaje borrado');
}

/* ----------------------------- Navegación / init ----------------------------- */
function show(id){ $all('.screen').forEach(s=>s.classList.remove('active')); $('#screen-'+id).classList.add('active'); }

function init(){
  $all('[data-go]').forEach(b=>b.addEventListener('click',()=>{ const d=b.dataset.go; if(d==='home'){ renderSessions(); renderReminders(); renderBikeCard(); } if(d==='meta'){ renderPresets(); renderSaved(); } show(d); }));
  $('#rem-add-btn').addEventListener('click', addReminderFromInputs);
  $('#rem-text').addEventListener('keydown',e=>{ if(e.key==='Enter') addReminderFromInputs(); });
  $('#rem-lap').addEventListener('keydown',e=>{ if(e.key==='Enter') $('#rem-text').focus(); });
  renderReminders();
  $('#btn-settings').addEventListener('click',()=>{ renderSettings(); show('settings'); });
  $('#gps-card').addEventListener('click',()=>GPS.start());
  $('#meta-card').addEventListener('click',()=>{ metaTrack=[]; renderPresets(); renderSaved(); show('meta'); GPS.start(); requestAnimationFrame(drawMetaMap); });
  $('#btn-mark-here').addEventListener('click', markHere);
  const sm=$('#sum-map');
  $('#zoom-in') && $('#zoom-in').addEventListener('click',()=>sm._zoomBtn&&sm._zoomBtn(1.4));
  $('#zoom-out') && $('#zoom-out').addEventListener('click',()=>sm._zoomBtn&&sm._zoomBtn(1/1.4));
  $('#zoom-reset') && $('#zoom-reset').addEventListener('click',()=>sm._zoomReset&&sm._zoomReset());
  $all('#sum-colormode button').forEach(b=>b.addEventListener('click',()=>{
    sumColorMode=b.dataset.cm; $all('#sum-colormode button').forEach(x=>x.classList.toggle('on', x===b));
    updateMapLegend(sumColorMode); if(sm && sm._redraw) sm._redraw(); else if(curSummary) drawSummaryMap(sm, curSummary);
  }));
  $('#btn-create-circuit').addEventListener('click', openBuilder);
  $all('#bld-mode button').forEach(b=>b.addEventListener('click',()=>setBuilderMode(b.dataset.mode)));
  $('#btn-rec-toggle').addEventListener('click', recToggle);
  $('#btn-pin').addEventListener('click', pinPoint);
  $('#btn-undo').addEventListener('click', undoPoint);
  $('#btn-save-circuit').addEventListener('click', saveCircuit);
  $('#btn-confirm-meta').addEventListener('click', confirmMeta);
  $('#btn-start').addEventListener('click', ()=>{
    // iOS exige pedir permiso de sensores DENTRO de un gesto de usuario. No
    // esperamos la promesa para no aplazar el arranque: la escucha se engancha
    // ya y los eventos llegan en cuanto se concede.
    if(settings.imu && IMU.supported() && IMU.permission==='unknown') IMU.requestPermission();
    startSession();
  });
  $('#btn-stop').addEventListener('click',()=>{ if(confirm('¿Terminar la sesión?')) stopSession(); });
  $('#tk-stop').addEventListener('click',()=>{ if(confirm('¿Terminar la sesión?')) stopSession(); });
  $('#btn-del-session').addEventListener('click',()=>{
    if(!viewingSessionId) return;
    if(confirm('¿Borrar esta sesión?')){ const s=loadJSON(LS_SESSIONS,[]).filter(x=>x.id!==viewingSessionId); saveJSON(LS_SESSIONS,s); renderSessions(); show('home'); toast('Sesión borrada'); }
  });
  $('#btn-analyze').addEventListener('click',()=>{ if(curSummary) openAnalysis(curSummary); });
  $('#an-back').addEventListener('click',()=>{ if(curSummary){ renderSummary(curSummary); } show('summary'); });
  // garaje
  $('#bike-card').addEventListener('click', openGarage);
  $('#btn-add-bike').addEventListener('click',()=>openBikeEdit(null));
  $('#bike-back').addEventListener('click', openGarage);
  $('#bike-edit').addEventListener('click',()=>openBikeEdit(viewingBikeId));
  $('#bike-edit-back').addEventListener('click',()=>{ if(editingBikeId) openBike(editingBikeId); else openGarage(); });
  $('#btn-save-bike').addEventListener('click', saveBike);
  $('#btn-del-bike').addEventListener('click', delBike);
  $('#btn-use-bike').addEventListener('click',()=>{ const b=bikeById(viewingBikeId); if(b) usePreSession(b, null); });
  $('#btn-add-setup').addEventListener('click',()=>openSetupEdit(viewingBikeId, null));
  $('#setup-back').addEventListener('click',()=>openBike(editingBikeId));
  $('#btn-save-setup').addEventListener('click', saveSetup);
  $('#setup-del').addEventListener('click', delSetup);
  renderBikeCard();

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
