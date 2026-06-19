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

// ---- CASO 7: sectores por distancia ----
{
  const { sectorSplits } = D;
  // vuelta de 300 m en 30 s a ritmo constante -> 3 sectores de 10 s
  const samples=[]; for(let i=0;i<=30;i++) samples.push({d:i*10, t:i*1000});
  const s=sectorSplits(samples, 300, 3);
  ok('7: 3 sectores', s && s.length===3);
  ok('7: cada sector ~10 s', s.every(x=>near(x,10000,50)));
  ok('7: suman la vuelta', near(s.reduce((a,b)=>a+b,0), 30000, 1));
  // ritmo variable: rápido al inicio (40m en sector si refDist/3=100? probamos no uniforme)
  const s2=sectorSplits([{d:0,t:0},{d:100,t:4000},{d:200,t:9000},{d:300,t:15000}], 300, 3);
  ok('7: variable s1<s2<s3', s2[0]<s2[1] && s2[1]<s2[2]);
}

// ---- CASO 8: trayectoria (buildPath / pointAt) ----
{
  const { buildPath, pointAt } = D;
  // cuadrado de 100 m de lado alrededor de Cartagena
  const o=(e,n)=>offset(CLAT,CLON,e,n);
  const sq=[[CLAT,CLON],[o(100,0).lat,o(100,0).lon],[o(100,100).lat,o(100,100).lon],[o(0,100).lat,o(0,100).lon]];
  const path=buildPath(sq);
  ok('8: longitud ~300 m (sin cerrar)', near(path.length,300,5));
  const mid=pointAt(path,50); // a 50 m: mitad del primer lado (este)
  const dd=D.haversine(CLAT,CLON,mid.lat,mid.lon);
  ok('8: punto a 50 m está a ~50 m del inicio', near(dd,50,3));
  const wrap=pointAt(path, path.length+25); // envoltura modular
  const dd2=D.haversine(CLAT,CLON,wrap.lat,wrap.lon);
  ok('8: envoltura modular (s>L)', near(dd2,25,3));
}

// ---- CASO 9: sectores EN VIVO (se cierran durante la vuelta, no al final) ----
{
  const { interpProfile } = D;
  const refDist=300, n=3;            // 3 sectores de 100 m
  const samples=[{d:0,t:0}];
  let curIdx=0, lastSplit=0; const closed=[];
  for(let i=1;i<=30;i++){            // vuelta de 300 m en 30 s, 1 Hz
    const cum=i*10, t=i*1000; samples.push({d:cum,t});
    while(curIdx<n-1){
      const b=((curIdx+1)/n)*refDist; if(cum<b) break;
      const splitT=interpProfile(samples,b);
      closed.push({ idx:curIdx, sampleT:t, secT:splitT-lastSplit }); lastSplit=splitT; curIdx++;
    }
  }
  ok('9: sector 1 cierra a mitad de vuelta (no al final)', closed[0] && closed[0].sampleT<=11000);
  ok('9: sector 1 ~10 s', closed[0] && near(closed[0].secT,10000,100));
  ok('9: se cierran n-1 sectores en vivo', closed.length===n-1);
}

// ---- CASO 10: grabar trazado (appendIfMoved filtra ruido) ----
{
  const { appendIfMoved } = D;
  const pts=[];
  appendIfMoved(pts, CLAT, CLON, 5);                       // primer punto
  const j=offset(CLAT,CLON,2,0);                           // +2 m: ruido, no añade
  const added2=appendIfMoved(pts, j.lat, j.lon, 5);
  const f=offset(CLAT,CLON,20,0);                          // +20 m: añade
  const added3=appendIfMoved(pts, f.lat, f.lon, 5);
  ok('10: primer punto añadido', pts.length>=1);
  ok('10: ruido <minGap descartado', added2===false);
  ok('10: movimiento >minGap añadido', added3===true && pts.length===2);
}

console.log(`\nDETECT TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
