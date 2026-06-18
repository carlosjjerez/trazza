// Test end-to-end del modo demo: el bucle del simulador pasado por la
// detección de meta (cruce + interpolación + debounce de vuelta mínima).
const R=6378137;
function projFactory(lat0,lon0){const c=Math.cos(lat0*Math.PI/180);return{toXY(lat,lon){return{x:(lon-lon0)*Math.PI/180*R*c,y:(lat-lat0)*Math.PI/180*R};}};}
function buildGate(lat,lon,h,w){const o=projFactory(lat,lon);const hx=Math.sin(h),hy=Math.cos(h);const px=-hy,py=hx,half=w/2;return{lat,lon,origin:o,width:w,hx,hy,ax:px*half,ay:py*half,bx:-px*half,by:-py*half};}
function gateCrossing(g,p0,p1){const A={x:g.ax,y:g.ay},B={x:g.bx,y:g.by};const P=g.origin.toXY(p0.lat,p0.lon),Q=g.origin.toXY(p1.lat,p1.lon);const mvx=Q.x-P.x,mvy=Q.y-P.y;if(mvx*g.hx+mvy*g.hy<=0)return null;const r={x:Q.x-P.x,y:Q.y-P.y},s={x:B.x-A.x,y:B.y-A.y};const den=r.x*s.y-r.y*s.x;if(Math.abs(den)<1e-9)return null;const qp={x:A.x-P.x,y:A.y-P.y};const t=(qp.x*s.y-qp.y*s.x)/den,u=(qp.x*r.y-qp.y*r.x)/den;if(t<0||t>=1||u<0||u>1)return null;return t;}
function offset(lat,lon,e,n){return{lat:lat+n/R*180/Math.PI,lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI};}

// --- parámetros del simulador (deben coincidir con sim.js) ---
const A=200,B=110,DURS=[45,43.6,44.4,46.1,43.9,45.3];
const CART={lat:37.6444,lon:-1.0352};
const gate=buildGate(CART.lat,CART.lon,0,30); // meta norte, igual que preset Cartagena
const h=Math.atan2(gate.hx,gate.hy);
const ae=Math.sin(h),an=Math.cos(h),ce=Math.cos(h),cn=-Math.sin(h);

function simPos(theta){
  const x=B*(Math.cos(theta)-1), y=A*Math.sin(theta);
  const east=x*ce+y*ae, north=x*cn+y*an;
  return offset(gate.lat,gate.lon,east,north);
}

// --- corre el simulador 240 s a 1 Hz y detecta vueltas ---
const minLap=20*1000;
let theta=-0.8, lapCount=0, prev=null, t=0;
let lastCrossT=null, laps=[];
const SECONDS=240;
for(let sec=0; sec<SECONDS; sec++){
  const now=sec*1000;
  const ll=simPos(theta);
  const fix={lat:ll.lat,lon:ll.lon,t:now};
  if(prev){
    const frac=gateCrossing(gate,prev,fix);
    if(frac!=null){
      const crossT=prev.t+frac*(fix.t-prev.t);
      if(lastCrossT==null){ lastCrossT=crossT; }
      else if(crossT-lastCrossT>=minLap){ laps.push((crossT-lastCrossT)/1000); lastCrossT=crossT; }
    }
  }
  prev=fix;
  // avanza theta
  const dur=DURS[lapCount%DURS.length], dtheta=2*Math.PI/dur;
  const before=Math.floor(theta/(2*Math.PI));
  theta+=dtheta;
  if(Math.floor(theta/(2*Math.PI))>before) lapCount++;
}

let pass=0,fail=0;
function ok(n,c){ if(c){pass++;}else{fail++;console.log('  FAIL',n);} }

ok('registra varias vueltas (>=4)', laps.length>=4);
// cada vuelta detectada debe parecerse a una duración objetivo (±2.5 s)
laps.forEach((lt,i)=>{
  const near=DURS.some(d=>Math.abs(d-lt)<2.5);
  ok('vuelta '+(i+1)+' ~objetivo ('+lt.toFixed(2)+'s)', near);
});
// las vueltas no son todas idénticas (hay variación -> delta/mejor tienen sentido)
const spread=Math.max(...laps)-Math.min(...laps);
ok('hay variación entre vueltas', spread>0.3);

console.log('Vueltas detectadas:', laps.map(x=>x.toFixed(2)).join(', '));
console.log(`\nSIM TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
