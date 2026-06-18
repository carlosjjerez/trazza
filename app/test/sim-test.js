// Test end-to-end del modo demo con el detector real:
// el bucle del simulador (mismo modelo que sim.js) pasado por LapDetector.
const D = require('../detect.js');
const { LapDetector } = D;
const R = D.R;

const CART={lat:37.6444,lon:-1.0352};
const A=200,B=110,DURS=[45,43.6,44.4,46.1,43.9,45.3];
function offset(lat,lon,e,n){return{lat:lat+n/R*180/Math.PI, lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI};}

const det=new LapDetector({lat:CART.lat,lon:CART.lon,radius:30,minLapMs:20000});
let theta=-0.6, lapIdx=0, laps=[];
for(let s=0;s<240;s++){
  const x=B*(Math.cos(theta)-1), y=A*Math.sin(theta);
  const ll=offset(CART.lat,CART.lon,x,y);
  const ev=det.update({lat:ll.lat,lon:ll.lon,t:s*1000});
  if(ev && ev.kind==='lap') laps.push(ev.lapMs/1000);
  const dur=DURS[lapIdx%DURS.length];
  const before=Math.floor(theta/(2*Math.PI)); theta+=2*Math.PI/dur;
  if(Math.floor(theta/(2*Math.PI))>before) lapIdx++;
}

let pass=0,fail=0;
function ok(n,c){ if(c)pass++; else{fail++; console.log('  FAIL',n);} }
ok('registra >=4 vueltas', laps.length>=4);
laps.forEach((lt,i)=>ok(`vuelta ${i+1} ~objetivo (${lt.toFixed(2)}s)`, DURS.some(d=>Math.abs(d-lt)<2.5)));
ok('hay variación entre vueltas', (Math.max(...laps)-Math.min(...laps))>0.3);

console.log('Vueltas detectadas:', laps.map(x=>x.toFixed(2)).join(', '));
console.log(`\nSIM TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
