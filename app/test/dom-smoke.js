// Smoke test con jsdom: arranca la app real, simula GPS y una sesión completa.
// Requiere jsdom (dev):  cd app && npm i jsdom && node test/dom-smoke.js
// Si jsdom no está instalado, se omite sin fallar.
const fs=require('fs'), path=require('path');
let JSDOM;
try{ JSDOM=require('jsdom').JSDOM; }catch(e){ console.log('DOM SMOKE: omitido (instala jsdom con `npm i jsdom`)'); process.exit(0); }

const APP=path.join(__dirname,'..');
let html=fs.readFileSync(path.join(APP,'index.html'),'utf8');
html=html.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');

const dom=new JSDOM(html,{ url:'https://localhost/', pretendToBeVisual:true, runScripts:'outside-only' });
const { window }=dom;
global.window=window; global.document=window.document; global.navigator=window.navigator;

let success=null;
window.navigator.geolocation={ watchPosition:(s)=>{ success=s; return 1; }, clearWatch:()=>{} };
window.confirm=()=>true; window.alert=()=>{};
window.HTMLCanvasElement.prototype.getContext=()=>null;

for(const f of ['detect.js','cartagena-track.js','sim.js','app.js']) window.eval(fs.readFileSync(path.join(APP,f),'utf8'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const R=6378137, CART={lat:37.6444,lon:-1.0352};
function offset(lat,lon,e,n){return{lat:lat+n/R*180/Math.PI,lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI};}
function feed(lat,lon,acc,t,spd){ success({ coords:{latitude:lat,longitude:lon,accuracy:acc,speed:spd==null?null:spd,heading:null}, timestamp:t }); }
function click(sel){ const el=window.document.querySelector(sel); if(!el) throw new Error('no element '+sel); el.dispatchEvent(new window.Event('click',{bubbles:true})); }
function txt(sel){ return window.document.querySelector(sel).textContent; }

let pass=0,fail=0; const ok=(n,c)=>{ if(c)pass++; else{fail++; console.log('  FAIL',n);} };

let t=1_000_000;
for(let i=0;i<3;i++){ feed(CART.lat,CART.lon,4,t,1); t+=1000; }
ok('GPS card muestra precisión', txt('#gps-acc')!=='--');

click('#meta-card'); click('#btn-mark-here'); click('#btn-confirm-meta');
ok('meta seleccionada en home', txt('#meta-name').trim()!=='Sin meta');
ok('botón salir habilitado', window.document.querySelector('#btn-start').disabled===false);

click('#btn-start');
ok('pantalla HUD activa', window.document.querySelector('#screen-hud').classList.contains('active'));

const A=200,B=110,DURS=[45,44,46,43.5];
let theta=-0.6, lapIdx=0;
for(let s=0;s<170;s++){
  const x=B*(Math.cos(theta)-1), y=A*Math.sin(theta);
  const ll=offset(CART.lat,CART.lon,x,y);
  feed(ll.lat,ll.lon,3,t,40); t+=1000;
  const dur=DURS[lapIdx%DURS.length];
  const before=Math.floor(theta/(2*Math.PI)); theta+=2*Math.PI/dur;
  if(Math.floor(theta/(2*Math.PI))>before) lapIdx++;
}
ok('mejor vuelta en HUD', txt('#hud-best').trim()!=='--');
ok('última vuelta en HUD', txt('#hud-last').trim()!=='--');
ok('contador de vuelta avanzó', txt('#hud-lapnum')!=='VUELTA 00');
ok('velocidad máx > 0 en HUD', parseInt(txt('#hud-spdmax'))>0);
ok('strip de 3 sectores en HUD', window.document.querySelectorAll('#hud-sectors .sec').length===3);
ok('algún sector con tiempo', [...window.document.querySelectorAll('#hud-sectors .sd')].some(e=>e.textContent.trim()!=='—'));

click('#btn-stop');
ok('pantalla resumen activa', window.document.querySelector('#screen-summary').classList.contains('active'));
const count=parseInt(txt('#sum-count'));
ok('resumen cuenta >=2 vueltas ('+count+')', count>=2);
ok('resumen mejor vuelta válida', txt('#sum-best').trim()!=='--');
ok('resumen vuelta óptima válida', txt('#sum-opt').trim()!=='--');
ok('resumen muestra chips de sector', window.document.querySelectorAll('#sum-laps .lap-secs .sc').length>0);

// ---- Récord histórico (PB) por circuito ----
let recs=JSON.parse(window.localStorage.getItem('trazza.records.v1')||'{}');
ok('récord guardado tras la 1ª sesión', Object.keys(recs).length>=1);
ok('banner de récord visible en resumen', window.document.querySelector('#sum-record').hidden===false);
const firstRecMs = recs[Object.keys(recs)[0]].bestMs;
// 2ª sesión más rápida en la misma meta -> debe batir el récord
click('[data-go="home"]'); click('#meta-card');
feed(CART.lat,CART.lon,4,t,0); t+=1000;                 // vuelve a la misma meta
click('#btn-mark-here'); click('#btn-confirm-meta'); click('#btn-start');
{ const A=200,B=110,DURS=[40,39.5]; let theta=-0.6,lapIdx=0;
  for(let s=0;s<150;s++){ const x=B*(Math.cos(theta)-1),y=A*Math.sin(theta); const ll=offset(CART.lat,CART.lon,x,y);
    feed(ll.lat,ll.lon,3,t,45); t+=1000;
    const dur=DURS[lapIdx%DURS.length]; const before=Math.floor(theta/(2*Math.PI)); theta+=2*Math.PI/dur; if(Math.floor(theta/(2*Math.PI))>before) lapIdx++; } }
click('#btn-stop');
ok('2ª sesión marca NUEVO récord', window.document.querySelector('#sum-record').className.indexOf('new')>=0);
ok('banner indica mejora vs anterior', txt('#sum-record').includes('vs anterior'));
recs=JSON.parse(window.localStorage.getItem('trazza.records.v1')||'{}');
ok('récord actualizado a la mejor marca', recs[Object.keys(recs)[0]].bestMs < firstRecMs);

// ---- Zoom del trazado en el resumen ----
const sm=window.document.querySelector('#sum-map');
window.document.querySelector('#zoom-in').dispatchEvent(new window.Event('click',{bubbles:true}));
ok('botón + acerca el trazado', !!sm._view && sm._view.zoom>1);
window.document.querySelector('#zoom-in').dispatchEvent(new window.Event('click',{bubbles:true}));
const z2=sm._view.zoom;
ok('segundo + sigue acercando', z2>1.3);
window.document.querySelector('#zoom-reset').dispatchEvent(new window.Event('click',{bubbles:true}));
ok('botón reset vuelve a zoom 1', sm._view.zoom===1 && sm._view.panX===0);

click('[data-go="home"]');
ok('sesión listada en home', window.document.querySelectorAll('#session-list .sess').length>=1);

// ---- Constructor de circuito (punto a punto) + mapa del HUD ----
const qsActive=s=>window.document.querySelector(s).classList.contains('active');
click('#meta-card');
click('#btn-create-circuit');
ok('pantalla constructor activa', qsActive('#screen-builder'));
click('#bld-mode button[data-mode="manual"]');
feed(CART.lat,CART.lon,4,t,1); t+=1000; click('#btn-pin');            // meta
for(const [e,n] of [[60,0],[60,60],[0,60],[0,5]]){ const ll=offset(CART.lat,CART.lon,e,n); feed(ll.lat,ll.lon,4,t,5); t+=1000; click('#btn-pin'); }
ok('constructor cuenta >=5 puntos', parseInt(txt('#bld-points'))>=5);
window.prompt=()=>'Circuito Test';
click('#btn-save-circuit');
ok('vuelve a meta tras guardar', qsActive('#screen-meta'));
ok('confirmar habilitado tras guardar', window.document.querySelector('#btn-confirm-meta').disabled===false);
ok('circuito en lista guardadas', window.document.querySelectorAll('#saved-list .preset').length>=1);
click('#btn-confirm-meta');
ok('meta seleccionada = circuito', txt('#meta-name').includes('Circuito'));
click('#btn-start');
ok('HUD tiene mapa en vivo', !!window.document.querySelector('#hud-map'));
feed(CART.lat,CART.lon,4,t,10); t+=1000;
ok('sigue en HUD tras fix (mapa no rompe)', qsActive('#screen-hud'));
click('#btn-stop');

// ---- Plantilla "Circuito de maniobras" (se ancla en tu posición) ----
click('[data-go="home"]');
click('#meta-card');
const presetEls=[...window.document.querySelectorAll('#preset-list .preset')];
ok('preset plantilla maniobras presente', presetEls.some(e=>e.textContent.toLowerCase().includes('maniobras')));
feed(CART.lat,CART.lon,4,t,1); t+=1000;
presetEls.find(e=>e.textContent.toLowerCase().includes('maniobras')).dispatchEvent(new window.Event('click',{bubbles:true}));
ok('plantilla anclada habilita confirmar', window.document.querySelector('#btn-confirm-meta').disabled===false);
click('#btn-confirm-meta');
ok('meta = circuito de maniobras', txt('#meta-name').toLowerCase().includes('maniobras'));

console.log('\nresumen mejor:', txt('#sum-best'), '| vueltas:', count);
console.log(`DOM SMOKE: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
