/* =====================================================================
   Trazza — Cronómetro de pista (MVP PWA)
   GPS del móvil (~1 Hz) + detección de meta por cruce de segmento
   con interpolación temporal sub-muestra.
   ===================================================================== */
'use strict';

/* ----------------------------- Config / estado ----------------------------- */
const DEFAULTS = {
  gateWidth: 30,   // m (ancho total de la línea de meta)
  minLap: 20,      // s (vuelta mínima para descartar dobles cruces)
  units: 'kmh',
  sound: true,
  haptic: true,
  wakelock: true,
  sim: false,
};

const TRACK_PRESETS = [
  { id:'cartagena', name:'Circuito de Cartagena', sub:'Meta recta principal', lat:37.6444, lon:-1.0352 },
];

const LS_SETTINGS = 'trazza.settings.v1';
const LS_SESSIONS = 'trazza.sessions.v1';
const LS_METAS    = 'trazza.metas.v1';

let settings = loadJSON(LS_SETTINGS, DEFAULTS);
settings = Object.assign({}, DEFAULTS, settings);
settings.sim = false; // el modo demo nunca persiste: arranca siempre con GPS real

// estado en vivo de la sesión
const live = {
  running:false,
  gate:null,          // { lat, lon, hx, hy, nx, ny, origin } ver buildGate()
  gateName:'Meta',
  prevFix:null,       // {lat,lon,t,acc,spd}
  lastCrossT:null,    // timestamp (ms) del último cruce
  lapStartT:null,
  lapNum:0,
  laps:[],            // [{n, ms, t}]
  best:null,          // ms
  track:[],           // crudo: {t,lat,lon,acc,spd}
  speedMax:0,         // m/s
  startedAt:null,
  watchId:null,
  wakeLock:null,
  rafId:null,
};

/* ----------------------------- Utilidades ----------------------------- */
function loadJSON(k, fallback){ try{ const v=JSON.parse(localStorage.getItem(k)); return v??fallback; }catch(e){ return fallback; } }
function saveJSON(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
function $(sel,root=document){ return root.querySelector(sel); }
function $all(sel,root=document){ return [...root.querySelectorAll(sel)]; }

function toast(msg, ms=2200){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'), ms);
}

// tiempo en formato m:ss.mmm
function fmtLap(ms){
  if(ms==null||!isFinite(ms)) return '--';
  const neg = ms<0; ms=Math.abs(ms);
  const m=Math.floor(ms/60000);
  const s=Math.floor((ms%60000)/1000);
  const mil=Math.floor(ms%1000);
  return (neg?'-':'')+m+':'+String(s).padStart(2,'0')+'.'+String(mil).padStart(3,'0');
}
// separa en parte principal y milésimas para el HUD (color distinto)
function splitLap(ms){
  const full=fmtLap(ms);
  const i=full.lastIndexOf('.');
  if(i<0) return {main:full, ms:''};
  return { main:full.slice(0,i), ms:full.slice(i) };
}
function fmtDelta(ms){
  const s=ms/1000;
  return (s>=0?'+':'−')+Math.abs(s).toFixed(2).replace('.',',');
}

/* ----------------------------- Geometría ----------------------------- */
// Proyección local equirectangular a metros alrededor de un origen.
const R = 6378137; // radio terrestre (m)
function projFactory(lat0, lon0){
  const cos0 = Math.cos(lat0*Math.PI/180);
  return {
    toXY(lat,lon){
      return {
        x:(lon-lon0)*Math.PI/180*R*cos0,
        y:(lat-lat0)*Math.PI/180*R,
      };
    }
  };
}
function haversine(aLat,aLon,bLat,bLon){
  const dLat=(bLat-aLat)*Math.PI/180, dLon=(bLon-aLon)*Math.PI/180;
  const la1=aLat*Math.PI/180, la2=bLat*Math.PI/180;
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

/* Construye la línea de meta (gate) a partir de un punto y un rumbo.
   La línea es perpendicular al sentido de marcha, centrada en (lat,lon),
   con semiancho = width/2. Guardamos:
     origin: proyección local
     (hx,hy): vector unitario del sentido de marcha (normal de la línea)
     (ax,ay)..(bx,by): extremos del segmento en metros
*/
function buildGate(lat, lon, headingRad, width){
  const origin = projFactory(lat, lon);
  // sentido de marcha (unitario)
  const hx=Math.sin(headingRad), hy=Math.cos(headingRad);
  // perpendicular (línea de meta)
  const px=-hy, py=hx;
  const half=width/2;
  return {
    lat, lon, origin, width,
    hx, hy,                       // normal de la línea = sentido de marcha
    ax:px*half, ay:py*half,       // extremo A (en metros, centro en 0,0)
    bx:-px*half, by:-py*half,     // extremo B
  };
}

/* ¿El segmento P0->P1 cruza la línea de meta?  Devuelve la fracción t∈[0,1]
   a lo largo de P0->P1 donde ocurre el cruce, o null. Solo cuenta cruces
   en el sentido de marcha correcto (producto escalar con la normal > 0). */
function gateCrossing(gate, p0, p1){
  const A={x:gate.ax,y:gate.ay}, B={x:gate.bx,y:gate.by};
  const P=gate.origin.toXY(p0.lat,p0.lon);
  const Q=gate.origin.toXY(p1.lat,p1.lon);

  // dirección del movimiento debe ir en el sentido de marcha
  const mvx=Q.x-P.x, mvy=Q.y-P.y;
  if(mvx*gate.hx + mvy*gate.hy <= 0) return null;

  // intersección de segmentos PQ y AB
  const r={x:Q.x-P.x, y:Q.y-P.y};
  const s={x:B.x-A.x, y:B.y-A.y};
  const denom = r.x*s.y - r.y*s.x;
  if(Math.abs(denom) < 1e-9) return null; // paralelos
  const qp={x:A.x-P.x, y:A.y-P.y};
  const t = (qp.x*s.y - qp.y*s.x)/denom;  // a lo largo de PQ
  const u = (qp.x*r.y - qp.y*r.x)/denom;  // a lo largo de AB
  // intervalo medio abierto en t: si una muestra cae justo en la línea se
  // cuenta solo en el segmento siguiente, evitando dobles cruces.
  if(t<0||t>=1||u<0||u>1) return null;
  return t;
}

/* ----------------------------- GPS ----------------------------- */
let gpsLastT=null, gpsHz=0;
function startGPS(onFix){
  // Modo demo: el simulador alimenta los fixes en vez del GPS real.
  if(settings.sim && window.TrazzaSim){ window.TrazzaSim.start(onFix); return; }
  if(!('geolocation' in navigator)){ toast('Este dispositivo no tiene GPS disponible'); return; }
  live.watchId = navigator.geolocation.watchPosition(
    (pos)=>{
      const c=pos.coords;
      const now=pos.timestamp||Date.now();
      if(gpsLastT){ const dt=(now-gpsLastT)/1000; if(dt>0) gpsHz=0.7*gpsHz+0.3*(1/dt); }
      gpsLastT=now;
      onFix({
        lat:c.latitude, lon:c.longitude, t:now,
        acc:c.accuracy, spd:(c.speed!=null && c.speed>=0)?c.speed:null,
        hdg:(c.heading!=null && !isNaN(c.heading))?c.heading:null,
      });
    },
    (err)=>{ onGpsError(err); },
    { enableHighAccuracy:true, maximumAge:0, timeout:15000 }
  );
}
function stopGPS(){
  if(window.TrazzaSim && window.TrazzaSim.active) window.TrazzaSim.stop();
  if(live.watchId!=null){ navigator.geolocation.clearWatch(live.watchId); live.watchId=null; }
}

function onGpsError(err){
  let msg='Error de GPS';
  if(err.code===1) msg='Permiso de ubicación denegado';
  else if(err.code===2) msg='Sin señal GPS';
  else if(err.code===3) msg='GPS sin respuesta';
  setHomeBanner('err', msg);
  setFixState('bad', 'ERROR');
  toast(msg);
}

/* ----------------------------- Wake Lock ----------------------------- */
async function acquireWakeLock(){
  if(!settings.wakelock) return;
  try{
    if('wakeLock' in navigator){ live.wakeLock = await navigator.wakeLock.request('screen'); }
  }catch(e){}
}
async function releaseWakeLock(){ try{ if(live.wakeLock){ await live.wakeLock.release(); live.wakeLock=null; } }catch(e){} }
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible' && live.running) acquireWakeLock();
});

/* ----------------------------- Avisos ----------------------------- */
let audioCtx=null;
function beep(kind){
  if(!settings.sound) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type='square';
    o.frequency.value = kind==='best' ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+0.22);
    o.start(); o.stop(audioCtx.currentTime+0.24);
    if(kind==='best'){ // doble pitido
      const o2=audioCtx.createOscillator(), g2=audioCtx.createGain();
      o2.connect(g2); g2.connect(audioCtx.destination); o2.type='square'; o2.frequency.value=1760;
      g2.gain.setValueAtTime(0.0001, audioCtx.currentTime+0.26);
      g2.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime+0.27);
      g2.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime+0.5);
      o2.start(audioCtx.currentTime+0.26); o2.stop(audioCtx.currentTime+0.52);
    }
  }catch(e){}
}
function haptic(ms){ if(settings.haptic && navigator.vibrate) navigator.vibrate(ms); }

/* ----------------------------- Navegación ----------------------------- */
function show(id){
  $all('.screen').forEach(s=>s.classList.remove('active'));
  $('#screen-'+id).classList.add('active');
}

/* ----------------------------- GPS de configuración (pre-sesión) ----------------------------- */
let configFix=null, configWatch=false;
function setHomeBanner(state, text){
  const b=$('#gps-banner');
  b.className='gps-banner '+(state==='ok'?'banner-ok':state==='err'?'banner-err':'banner-wait');
  $('#gps-banner-text').textContent=text;
}
function setFixState(state, text){
  const el=$('#meta-gps-card .fix-state');
  if(!el) return;
  el.className='fix-state '+(state==='ok'?'ok':state==='wait'?'wait':state==='bad'?'bad':'');
  $('#meta-fix-text').textContent=text;
}

function startConfigGPS(){
  if(configWatch) return;
  configWatch=true;
  setHomeBanner('wait','GPS · buscando señal…');
  startGPS((fix)=>{
    configFix=fix;
    // banner home
    setHomeBanner('ok', `GPS activo · ±${fix.acc.toFixed(0)} m`);
    // tarjeta meta
    const good = fix.acc<=8, ok = fix.acc<=20;
    setFixState(good?'ok':ok?'wait':'bad', good?'FIX LISTO':ok?'FIX DÉBIL':'FIX POBRE');
    $('#meta-acc').textContent='±'+fix.acc.toFixed(1);
    $('#meta-hz').textContent=(gpsHz>0?gpsHz.toFixed(1):'--')+' Hz';
    $('#meta-speed').textContent=fmtSpeed(fix.spd)+' '+speedUnit();
    $('#btn-mark-meta').disabled=false;
  });
}

/* ----------------------------- Velocidad / unidades ----------------------------- */
function speedUnit(){ return settings.units==='mph'?'mph':'km/h'; }
function speedFactor(){ return settings.units==='mph'?2.23694:3.6; }
function fmtSpeed(mps){ if(mps==null) return '--'; return Math.round(mps*speedFactor()); }

/* ----------------------------- Marcar meta ----------------------------- */
function markMetaHere(){
  if(!configFix){ toast('Esperando señal GPS…'); return; }
  // rumbo: usa heading del GPS si existe; si no, el del último movimiento
  let heading = (configFix.hdg!=null) ? configFix.hdg*Math.PI/180 : null;
  if(heading==null && live.prevFix){
    const o=projFactory(live.prevFix.lat,live.prevFix.lon);
    const p=o.toXY(configFix.lat,configFix.lon);
    heading=Math.atan2(p.x,p.y);
  }
  if(heading==null) heading=0; // sin rumbo: línea N-S, válida si cruzas E-W
  const gate=buildGate(configFix.lat, configFix.lon, heading, settings.gateWidth);
  selectGate(gate, 'Meta marcada', true);
  toast('Meta fijada en tu posición');
  haptic(40);
}

let pendingGate=null, pendingName='Meta';
function selectGate(gate, name, saveAsRecent){
  pendingGate=gate; pendingName=name;
  $('#btn-start-from-meta').disabled=false;
  // resalta preset si corresponde
  $all('.preset-item').forEach(el=>el.classList.remove('sel'));
  if(saveAsRecent){
    const metas=loadJSON(LS_METAS,[]);
    metas.unshift({name, lat:gate.lat, lon:gate.lon, heading:Math.atan2(gate.hx,gate.hy), width:gate.width, at:Date.now()});
    saveJSON(LS_METAS, metas.slice(0,8));
  }
}

function renderPresets(){
  const list=$('#track-presets'); list.innerHTML='';
  const metas=loadJSON(LS_METAS,[]);
  const items=[
    ...metas.slice(0,3).map(m=>({...m, sub:'Meta guardada'})),
    ...TRACK_PRESETS,
  ];
  items.forEach(it=>{
    const div=document.createElement('div');
    div.className='preset-item';
    div.innerHTML=`<div><div class="p-name">${it.name}</div><div class="p-sub">${it.sub||'Meta'}</div></div>
      <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 6 L15 12 L9 18" fill="none" stroke="#8A93A6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
    div.addEventListener('click',()=>{
      const heading = it.heading!=null ? it.heading : 0;
      const gate=buildGate(it.lat, it.lon, heading, settings.gateWidth);
      selectGate(gate, it.name, false);
      $all('.preset-item').forEach(el=>el.classList.remove('sel'));
      div.classList.add('sel');
      toast(`Meta: ${it.name}`);
    });
    list.appendChild(div);
  });
}

/* ----------------------------- Sesión en vivo ----------------------------- */
function startSession(){
  if(!pendingGate){ toast('Marca o elige una meta primero'); return; }
  Object.assign(live, {
    running:true, gate:pendingGate, gateName:pendingName,
    prevFix:null, lastCrossT:null, lapStartT:null, lapNum:0,
    laps:[], best:null, track:[], speedMax:0, startedAt:Date.now(),
  });
  show('hud');
  acquireWakeLock();
  resetHud();
  // el GPS ya está corriendo desde configuración; redirigimos el handler
  stopGPS(); configWatch=false;
  startGPS(onLiveFix);
  startHudClock();
}

function onLiveFix(fix){
  // log crudo
  live.track.push({t:fix.t, lat:fix.lat, lon:fix.lon, acc:fix.acc, spd:fix.spd});

  // velocidad
  if(fix.spd!=null){ live.speedMax=Math.max(live.speedMax, fix.spd); }

  // chip GPS
  updateGpsChip(fix.acc);

  // detección de cruce de meta
  if(live.prevFix && live.gate){
    const t = gateCrossing(live.gate, live.prevFix, fix);
    if(t!=null){
      const crossT = live.prevFix.t + t*(fix.t - live.prevFix.t); // interpolación temporal
      registerCrossing(crossT);
    }
  }
  live.prevFix=fix;

  // datos de velocidad en HUD
  $('#hud-speed').textContent=fmtSpeed(fix.spd);
  $('#hud-speed-max').textContent=fmtSpeed(live.speedMax);
}

function registerCrossing(crossT){
  if(live.lastCrossT==null){
    // primer cruce: arranca la vuelta 1
    live.lastCrossT=crossT; live.lapStartT=crossT; live.lapNum=1;
    $('#hud-lap-num').textContent='Vuelta '+String(live.lapNum).padStart(2,'0');
    toast('¡Cronómetro en marcha!'); haptic(60); beep('lap');
    return;
  }
  const lapMs = crossT - live.lastCrossT;
  if(lapMs < settings.minLap*1000) return; // descarta doble cruce / rebote

  // cierra vuelta
  const n=live.lapNum;
  const isBest = (live.best==null || lapMs<live.best);
  live.laps.push({n, ms:lapMs, t:crossT});
  if(isBest) live.best=lapMs;

  // feedback
  flashHud();
  haptic(isBest?[60,40,60]:80);
  beep(isBest?'best':'lap');
  toast((isBest?'¡Mejor vuelta! ':'Vuelta '+n+' · ')+fmtLap(lapMs), 2600);

  // siguiente vuelta
  live.lastCrossT=crossT; live.lapStartT=crossT; live.lapNum=n+1;
  $('#hud-lap-num').textContent='Vuelta '+String(live.lapNum).padStart(2,'0');

  renderHudLastBest();
  persistLiveSession();
}

function updateGpsChip(acc){
  const chip=$('#hud-gps-chip');
  chip.classList.remove('bad','warn');
  if(acc>20) chip.classList.add('bad');
  else if(acc>8) chip.classList.add('warn');
  $('#hud-gps-text').textContent='GPS ±'+acc.toFixed(1)+' m';
}

function flashHud(){ const h=$('#screen-hud'); h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash'); }

function resetHud(){
  $('#hud-cur-time').innerHTML='0:00<span class="ms">.000</span>';
  $('#hud-lap-num').textContent='Vuelta 00';
  $('#hud-last').innerHTML='--';
  $('#hud-best').innerHTML='--';
  $('#hud-speed').textContent='0';
  $('#hud-speed-max').textContent='0';
  setDelta(null);
}
function renderHudLastBest(){
  const last=live.laps.length?live.laps[live.laps.length-1].ms:null;
  const sl=splitLap(last); $('#hud-last').innerHTML = last==null?'--':`${sl.main}<span class="ms">${sl.ms}</span>`;
  const sb=splitLap(live.best); $('#hud-best').innerHTML = live.best==null?'--':`${sb.main}<span class="ms">${sb.ms}</span>`;
}
function setDelta(ms){
  const card=$('#hud-delta-card'), val=$('#hud-delta-val'), arrow=$('#hud-delta-arrow');
  card.classList.remove('good','bad');
  if(ms==null){ val.textContent='--'; val.style.color='var(--niebla)'; arrow.querySelector('path').setAttribute('fill','#8A93A6'); return; }
  val.textContent=fmtDelta(ms);
  if(ms<0){ card.classList.add('good'); val.style.color='var(--hiviz)'; arrow.querySelector('path').setAttribute('d','M12 5 L20 18 L4 18 Z'); arrow.querySelector('path').setAttribute('fill','#B6FF1A'); }
  else { card.classList.add('bad'); val.style.color='var(--rojo)'; arrow.querySelector('path').setAttribute('d','M12 19 L20 6 L4 6 Z'); arrow.querySelector('path').setAttribute('fill','#FF3B30'); }
}

// reloj del HUD: vuelta en curso + delta proyectado contra la mejor
function startHudClock(){
  cancelAnimationFrame(live.rafId);
  const tick=()=>{
    if(!live.running) return;
    if(live.lapStartT!=null){
      const cur=Date.now()-live.lapStartT;
      const sl=splitLap(cur);
      $('#hud-cur-time').innerHTML=`${sl.main}<span class="ms">${sl.ms}</span>`;
      // delta en vivo: solo cuando ya superamos la mejor (proyección simple)
      if(live.best!=null){ setDelta(cur>live.best ? cur-live.best : (live.laps.length?live.laps[live.laps.length-1].ms-live.best:null)); }
    }
    live.rafId=requestAnimationFrame(tick);
  };
  live.rafId=requestAnimationFrame(tick);
}

function stopSession(){
  if(!live.running) return;
  live.running=false;
  cancelAnimationFrame(live.rafId);
  stopGPS(); releaseWakeLock();
  const saved=persistLiveSession(true);
  renderSummary(saved);
  show('summary');
}

/* ----------------------------- Persistencia de sesiones ----------------------------- */
let currentSessionId=null;
function persistLiveSession(finalize){
  const sessions=loadJSON(LS_SESSIONS,[]);
  const data={
    id: currentSessionId || ('s'+live.startedAt),
    name: live.gateName,
    startedAt: live.startedAt,
    endedAt: finalize?Date.now():null,
    laps: live.laps.map(l=>({n:l.n, ms:l.ms})),
    best: live.best,
    speedMaxKmh: Math.round(live.speedMax*3.6),
    gate: { lat:live.gate.lat, lon:live.gate.lon, width:live.gate.width },
    track: live.track,
  };
  currentSessionId=data.id;
  const i=sessions.findIndex(s=>s.id===data.id);
  if(i>=0) sessions[i]=data; else sessions.unshift(data);
  saveJSON(LS_SESSIONS, sessions);
  if(finalize) currentSessionId=null;
  return data;
}

function renderSessions(){
  const list=$('#session-list'); const sessions=loadJSON(LS_SESSIONS,[]);
  if(!sessions.length){ list.innerHTML='<div class="empty-hint">Aún no tienes sesiones. Sal a pista y marca tu primera vuelta.</div>'; return; }
  list.innerHTML='';
  sessions.forEach(s=>{
    const d=new Date(s.startedAt);
    const date=d.toLocaleDateString('es-ES',{day:'2-digit',month:'short'}).toUpperCase().replace('.','');
    const div=document.createElement('div'); div.className='session-item';
    div.innerHTML=`<div class="si-top"><div class="si-name">${s.name}</div><div class="si-date">${date}</div></div>
      <div class="si-stats">
        <div><div class="k">Mejor</div><div class="v green">${fmtLap(s.best)}</div></div>
        <div><div class="k">Vueltas</div><div class="v">${s.laps.length}</div></div>
      </div>`;
    div.addEventListener('click',()=>{ renderSummary(s); show('summary'); });
    list.appendChild(div);
  });
}

function renderSummary(s){
  if(!s) return;
  $('#summary-title').textContent=s.name;
  $('#summary-best').textContent=fmtLap(s.best);
  const valid=s.laps.filter(l=>l.ms>0);
  const avg = valid.length ? valid.reduce((a,l)=>a+l.ms,0)/valid.length : null;
  $('#summary-avg').textContent=fmtLap(avg);
  $('#summary-count').textContent=s.laps.length;

  const wrap=$('#summary-laps'); wrap.innerHTML='';
  if(!s.laps.length){ wrap.innerHTML='<div class="empty-hint">No se registraron vueltas completas. Revisa la posición de la meta.</div>'; }
  s.laps.forEach(l=>{
    const isBest=l.ms===s.best;
    const delta=l.ms-s.best;
    let dCls='best', dTxt='MEJOR';
    if(!isBest){ const sec=delta/1000; dTxt='+'+sec.toFixed(2); dCls = sec>=1?'worse':'close'; }
    const row=document.createElement('div'); row.className='lap-row'+(isBest?' best':'');
    row.innerHTML=`<span class="ln">${String(l.n).padStart(2,'0')}</span>
      <div class="rt"><span class="lt">${fmtLap(l.ms)}</span><span class="dl ${dCls}">${dTxt}</span></div>`;
    wrap.appendChild(row);
  });

  $('#btn-export-csv').onclick=()=>exportCSV(s);
  $('#btn-export-gpx').onclick=()=>exportGPX(s);
}

/* ----------------------------- Exportar ----------------------------- */
function download(filename, text, type){
  const blob=new Blob([text],{type:type||'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
}
function slug(s){ return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }

function exportCSV(s){
  const d=new Date(s.startedAt).toISOString().slice(0,16).replace(/[:T]/g,'-');
  let csv='vuelta,tiempo_ms,tiempo,delta_ms,mejor\n';
  s.laps.forEach(l=>{ csv+=`${l.n},${Math.round(l.ms)},"${fmtLap(l.ms)}",${Math.round(l.ms-s.best)},${l.ms===s.best?'1':'0'}\n`; });
  download(`trazza-${slug(s.name)}-${d}-vueltas.csv`, csv, 'text/csv');
  toast('CSV de vueltas descargado');
}
function exportGPX(s){
  const d=new Date(s.startedAt).toISOString().slice(0,16).replace(/[:T]/g,'-');
  let gpx=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trazza" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${s.name}</name><trkseg>\n`;
  (s.track||[]).forEach(p=>{
    gpx+=`<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time>`;
    if(p.spd!=null) gpx+=`<extensions><speed>${p.spd}</speed></extensions>`;
    gpx+=`</trkpt>\n`;
  });
  gpx+=`</trkseg></trk>\n</gpx>\n`;
  download(`trazza-${slug(s.name)}-${d}-track.gpx`, gpx, 'application/gpx+xml');
  toast('Track GPX descargado');
}

/* ----------------------------- Ajustes UI ----------------------------- */
function renderSettings(){
  $('#set-width').textContent=settings.gateWidth+' m';
  $('#set-minlap').textContent=settings.minLap+' s';
  $all('#units-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.units===settings.units));
  $all('.switch[data-toggle]').forEach(b=>b.classList.toggle('on', !!settings[b.dataset.toggle]));
}
function applySettingsHandlers(){
  $all('.stepper button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.step, d=+b.dataset.d;
    if(k==='width'){ settings.gateWidth=Math.min(60,Math.max(6, settings.gateWidth+d*2)); }
    if(k==='minlap'){ settings.minLap=Math.min(120,Math.max(5, settings.minLap+d*5)); }
    saveJSON(LS_SETTINGS,settings); renderSettings();
  }));
  $all('#units-toggle button').forEach(b=>b.addEventListener('click',()=>{ settings.units=b.dataset.units; saveJSON(LS_SETTINGS,settings); renderSettings(); }));
  $all('.switch[data-toggle]').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.toggle; settings[k]=!settings[k]; saveJSON(LS_SETTINGS,settings); renderSettings();
    if(k==='sim') toast(settings.sim ? 'Modo demo activado · GPS simulado' : 'Modo demo desactivado · GPS real', 2600);
  }));
  $('#btn-clear-data').addEventListener('click',()=>{
    if(confirm('¿Borrar TODAS las sesiones guardadas? No se puede deshacer.')){
      localStorage.removeItem(LS_SESSIONS); renderSessions(); toast('Sesiones borradas');
    }
  });
}

/* ----------------------------- Wiring ----------------------------- */
function init(){
  // navegación
  $all('[data-go]').forEach(b=>b.addEventListener('click',()=>{
    const dest=b.dataset.go;
    if(dest==='home'){ renderSessions(); renderPresets(); }
    show(dest);
  }));
  $('#btn-open-settings').addEventListener('click',()=>{ renderSettings(); show('settings'); });

  $('#btn-new-session').addEventListener('click',()=>{
    show('meta'); renderPresets(); startConfigGPS();
  });
  $('#gps-banner').addEventListener('click', startConfigGPS);
  $('#btn-mark-meta').addEventListener('click', markMetaHere);
  $('#btn-start-from-meta').addEventListener('click', startSession);
  $('#btn-stop-session').addEventListener('click',()=>{
    if(confirm('¿Terminar la sesión?')) stopSession();
  });

  $('#btn-mark-meta').disabled=true;

  applySettingsHandlers();
  renderSessions();
  renderPresets();
  renderSettings();

  // registra service worker
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
