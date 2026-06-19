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

for(const f of ['detect.js','sim.js','app.js']) window.eval(fs.readFileSync(path.join(APP,f),'utf8'));
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

click('[data-go="home"]');
ok('sesión listada en home', window.document.querySelectorAll('#session-list .sess').length>=1);

console.log('\nresumen mejor:', txt('#sum-best'), '| vueltas:', count);
console.log(`DOM SMOKE: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
