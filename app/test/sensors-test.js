// Pruebas del núcleo de SENSORES (lean por filtro complementario, G, calibración).
const S = require('../sensors.js');
const G = S.G;

let pass=0, fail=0;
function ok(name,cond){ if(cond)pass++; else{fail++; console.log('  FAIL', name);} }
function near(a,b,tol){ return a!=null && Math.abs(a-b)<=tol; }

// ---- lean: integración pura del giroscopio cuando el acelerómetro no es fiable ----
{
  const f=S.createLeanFilter();
  // |a| = 2 g (plena curva/baches) -> el gate cierra y solo cuenta el giroscopio
  const aLat=0, aVert=2*G; // amag=2g
  for(let i=0;i<10;i++) f.update(0.1, 30, aLat, aVert, 2*G); // 30°/s · 1 s
  ok('lean: integra el giroscopio (~30° tras 1 s)', near(f.value, 30, 0.5));
}

// ---- lean: en reposo tumbado, el acelerómetro fija el ángulo absoluto ----
{
  const f=S.createLeanFilter();
  const th=20*Math.PI/180;
  const aLat=G*Math.sin(th), aVert=G*Math.cos(th); // |a|=g (gate abierto)
  f.update(0.05, 0, aLat, aVert, G);
  ok('lean: el acelerómetro ancla ~20° en reposo', near(f.value, 20, 0.5));
}

// ---- lean: el giroscopio con sesgo NO deriva sin control (lo acota el acel.) ----
{
  const f=S.createLeanFilter();
  // sesgo constante de 5°/s, pero la moto está recta (acel. vertical = g)
  for(let i=0;i<500;i++) f.update(0.02, 5, 0, G, G); // 10 s
  ok('lean: la deriva queda acotada (<10°, no 50°)', f.value<10 && f.value>0);
}

// ---- G: lateral/longitudinal en múltiplos de g ----
{
  const g1=S.gForces(G, 0, G);           // 1 g lateral
  ok('G: lateral 1 g', near(g1.lat,1,1e-6));
  ok('G: horizontal 1 g', near(g1.horiz,1,1e-6));
  const g2=S.gForces(0, -G*0.5, G);      // frenada 0,5 g
  ok('G: longitudinal −0,5 g', near(g2.lon,-0.5,1e-6));
  const g3=S.gForces(G, G, G);           // lat+lon
  ok('G: módulo horizontal = √2 g', near(g3.horiz, Math.SQRT2, 1e-6));
}

// ---- corrección por neumático: por defecto no toca; con geometría reduce ----
{
  ok('tyre: por defecto no corrige', S.tyreCorrect(50)===50);
  const c=S.tyreCorrect(50,{tyreR:0.06, cogH:0.6}); // k=1-0.1=0.9
  ok('tyre: reduce con geometría', near(c, 45, 1e-6));
}

// ---- calibrador: promedia gravedad y sesgo del giroscopio ----
{
  const cal=S.makeCalibrator();
  for(let i=0;i<50;i++) cal.add({ ax:0, ay:0, az:G+ (Math.random()-0.5)*0.02, gx:0.3, gy:-0.2, gz:0.1 });
  const r=cal.finish();
  ok('calib: usa todas las muestras', r.n===50);
  ok('calib: gravedad ≈ (0,0,g)', near(r.grav.z, G, 0.05) && near(r.grav.x,0,0.05));
  ok('calib: |g| ≈ 9.8', near(r.gmag, G, 0.05));
  ok('calib: up unitario hacia z', near(r.up.z, 1, 0.01));
  ok('calib: sesgo del giroscopio promediado', near(r.gyroBias.x,0.3,1e-6) && near(r.gyroBias.y,-0.2,1e-6));
}

// ---- picos: inclinación por lado y G ----
{
  const p=S.makePeaks();
  p.push(-30, {horiz:1.1, lon:-0.8});
  p.push( 45, {horiz:0.9, lon:0.3});
  p.push(-20, {horiz:1.3, lon:0.1});
  ok('picos: máx izquierda', p.leanL===30);
  ok('picos: máx derecha', p.leanR===45);
  ok('picos: G horizontal máx', near(p.gHoriz,1.3,1e-9));
  ok('picos: G long máx (abs)', near(p.gLon,0.8,1e-9));
}

console.log(`\nSENSORS TESTS: ${pass} pass, ${fail} fail`);
if(fail) process.exit(1);
