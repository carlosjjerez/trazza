// Test del modo demo con el detector real, en dos modos:
//  A) óvalo de respaldo (meta sin trazado)
//  B) recorriendo el trazado de Cartagena (mismo modelo que sim.js)
const D = require('../detect.js');
const { LapDetector } = D;
const R = D.R;
const CART={lat:37.6444,lon:-1.0352};
function offset(lat,lon,e,n){return{lat:lat+n/R*180/Math.PI, lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI};}
let pass=0,fail=0; const ok=(n,c)=>{ if(c)pass++; else{fail++; console.log('  FAIL',n);} };
const near=(a,b,t)=>Math.abs(a-b)<=t;

/* ---- A) óvalo ---- */
{
  const A=200,B=110,DURS=[45,43.6,44.4,46.1,43.9,45.3];
  const det=new LapDetector({lat:CART.lat,lon:CART.lon,radius:30,minLapMs:20000});
  let theta=-0.6, lapIdx=0, laps=[];
  for(let s=0;s<240;s++){
    const x=B*(Math.cos(theta)-1), y=A*Math.sin(theta);
    const ll=offset(CART.lat,CART.lon,x,y);
    const ev=det.update({lat:ll.lat,lon:ll.lon,t:s*1000});
    if(ev&&ev.kind==='lap') laps.push(ev.lapMs/1000);
    const dur=DURS[lapIdx%DURS.length];
    const before=Math.floor(theta/(2*Math.PI)); theta+=2*Math.PI/dur;
    if(Math.floor(theta/(2*Math.PI))>before) lapIdx++;
  }
  ok('A: óvalo registra >=4 vueltas', laps.length>=4);
  ok('A: vueltas ~objetivo', laps.every(lt=>[45,43.6,44.4,46.1,43.9,45.3].some(d=>near(d,lt,2.5))));
}

/* ---- B) trazado de Cartagena (replica makeOutline + sim.js) ---- */
{
  function m2ll(la,lo,e,n){ return [la+n/111320, lo+e/(111320*Math.cos(la*Math.PI/180))]; }
  function makeOutline(la,lo,ctrl,scale){ const c=ctrl.map(p=>[p[0]*scale,p[1]*scale]); const pts=c.concat([c[0]]); const out=[];
    for(let i=0;i<pts.length-1;i++){const[x0,y0]=pts[i],[x1,y1]=pts[i+1];const d=Math.hypot(x1-x0,y1-y0),st=Math.max(1,Math.round(d/12));
      for(let k=0;k<st;k++){const f=k/st;out.push(m2ll(la,lo,x0+(x1-x0)*f,y0+(y1-y0)*f));}}
    out.push(m2ll(la,lo,c[0][0],c[0][1])); return out; }
  const CART_CTRL=[[0,0],[0,640],[40,760],[170,820],[300,795],[385,680],[400,535],[330,430],[385,300],[505,210],[520,55],[440,-45],[300,-25],[235,-150],[300,-260],[200,-345],[40,-335],[-60,-235],[-165,-265],[-285,-200],[-305,-60],[-245,80],[-300,245],[-220,365],[-60,385],[-25,180],[0,-190]];
  const outline=makeOutline(CART.lat,CART.lon,CART_CTRL,0.75);
  const path=D.buildPath(outline);
  ok('B: longitud del trazado ~3.5 km', near(path.length,3506,400));

  const OUT_DURS=[103,100,106,101,104,99];
  const det=new LapDetector({lat:outline[0][0],lon:outline[0][1],radius:30,minLapMs:20000});
  let s=-40, lapIdx=0, laps=[];
  for(let t=0;t<400;t++){
    const dur=OUT_DURS[lapIdx%OUT_DURS.length], L=path.length, base=L/dur;
    const frac=(((s%L)+L)%L)/L, step=base*(1+0.4*Math.sin(frac*2*Math.PI*3));
    const p=D.pointAt(path,s);
    const ev=det.update({lat:p.lat,lon:p.lon,t:t*1000});
    if(ev&&ev.kind==='lap') laps.push(ev.lapMs/1000);
    const before=Math.floor(s/L); s+=step; if(Math.floor(s/L)>before) lapIdx++;
  }
  ok('B: trazado registra >=2 vueltas', laps.length>=2);
  ok('B: vueltas realistas (~1:50, no 0:45 ni absurdo)', laps.every(lt=>lt>90 && lt<130));
  console.log('   vueltas trazado:', laps.map(x=>x.toFixed(1)).join(', '), '| longitud m:', Math.round(path.length));
}

console.log(`\nSIM TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
