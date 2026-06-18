// Pruebas del núcleo de detección (closest-approach + interpolación + sentido)
const D = require('../detect.js');
const { LapDetector, interpProfile, projFactory } = D;
const R = D.R;

const CLAT=37.6444, CLON=-1.0352;
function offset(lat,lon,e,n){return{lat:lat+n/R*180/Math.PI, lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI};}

let pass=0, fail=0;
function ok(name,cond){ if(cond)pass++; else{fail++; console.log('  FAIL', name);} }
function near(a,b,tol){ return Math.abs(a-b)<=tol; }

// Helper: pasa una lista de fixes por el detector y recoge eventos
function run(det, fixes){
  const evs=[];
  for(const f of fixes){ const e=det.update(f); if(e) evs.push(e); }
  const fe=det.flush(); if(fe) evs.push(fe);
  return evs;
}

// ---- CASO 1: pasada recta a velocidad media, fix justo encima ----
{
  const det=new LapDetector({lat:CLAT,lon:CLON,radius:30,minLapMs:20000});
  // va hacia el norte, ~20 m/s; muestras a -40,-20,0,+20,+40 m
  const fixes=[-40,-20,0,20,40].map((n,i)=>({...offset(CLAT,CLON,0,n), t:i*1000}));
  const evs=run(det,fixes);
  ok('1: detecta primer cruce (start)', evs.length===1 && evs[0].kind==='start');
  ok('1: tiempo de cruce ~2000ms (en la meta)', evs.length && near(evs[0].t,2000,60));
}

// ---- CASO 2: ALTA VELOCIDAD, ningún fix cae dentro del radio ----
// 70 m/s (252 km/h), muestras a -35 y +35 m (ninguna dentro de radio 30),
// pero el SEGMENTO pasa por 0 -> debe detectarse igualmente.
{
  const det=new LapDetector({lat:CLAT,lon:CLON,radius:30,minLapMs:20000});
  const fixes=[-105,-35,35,105].map((n,i)=>({...offset(CLAT,CLON,0,n), t:i*1000}));
  const evs=run(det,fixes);
  ok('2: detecta a alta velocidad sin fix dentro del radio', evs.length===1 && evs[0].kind==='start');
  // cruce entre -35 (t=1000) y +35 (t=2000): mitad -> ~1500ms
  ok('2: interpolación ~1500ms', evs.length && near(evs[0].t,1500,60));
}

// ---- CASO 3: bloqueo de sentido: ida cuenta, vuelta NO ----
{
  const det=new LapDetector({lat:CLAT,lon:CLON,radius:30,minLapMs:5000});
  // ida hacia el norte (cruce 1, start)
  const ida=[-40,-10,20,50].map((n,i)=>({...offset(CLAT,CLON,0,n), t:i*1000}));
  // vuelta hacia el sur, 100 s después (supera minLap) -> NO debe contar
  const vuelta=[50,20,-10,-40].map((n,i)=>({...offset(CLAT,CLON,0,n), t:100000+i*1000}));
  const evs=run(det,[...ida,...vuelta]);
  ok('3: solo el sentido correcto cuenta', evs.length===1 && evs[0].kind==='start');
}

// ---- CASO 4: anti-rebote (dos aproximaciones muy seguidas = 1 vuelta) ----
{
  const det=new LapDetector({lat:CLAT,lon:CLON,radius:30,minLapMs:20000});
  // primer cruce
  const a=[-40,-10,20,50].map((n,i)=>({...offset(CLAT,CLON,0,n), t:i*1000}));
  // segundo cruce 8 s después (< minLap 20s) -> descartado
  const b=[-40,-10,20,50].map((n,i)=>({...offset(CLAT,CLON,0,n), t:8000+i*1000}));
  const evs=run(det,[...a,...b]);
  ok('4: rebote dentro de minLap descartado', evs.length===1);
}

// ---- CASO 5: vuelta completa real (bucle) genera tiempos correctos ----
{
  const det=new LapDetector({lat:CLAT,lon:CLON,radius:30,minLapMs:20000});
  // bucle elíptico alrededor de la meta, ~45 s/vuelta, 1 Hz, varias vueltas
  const A=200,B=110;
  const fixes=[]; let theta=-0.6, t=0;
  for(let s=0;s<200;s++){
    const x=B*(Math.cos(theta)-1), y=A*Math.sin(theta);
    fixes.push({...offset(CLAT,CLON,x,y), t:s*1000});
    theta += 2*Math.PI/45;
  }
  const evs=run(det,fixes);
  const laps=evs.filter(e=>e.kind==='lap').map(e=>e.lapMs/1000);
  ok('5: registra >=3 vueltas', laps.length>=3);
  ok('5: vueltas ~45 s', laps.every(lt=>near(lt,45,2.5)));
  console.log('   vueltas bucle:', laps.map(x=>x.toFixed(2)).join(', '));
}

// ---- CASO 6: interpProfile (delta por distancia) ----
{
  const prof=[{d:0,t:0},{d:100,t:5000},{d:200,t:9000}];
  ok('6: interp en 0', interpProfile(prof,0)===0);
  ok('6: interp medio (50m -> 2500ms)', near(interpProfile(prof,50),2500,1));
  ok('6: interp 150m -> 7000ms', near(interpProfile(prof,150),7000,1));
  ok('6: clamp por debajo', interpProfile(prof,-10)===0);
  ok('6: clamp por encima', interpProfile(prof,999)===9000);
}

console.log(`\nDETECT TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
