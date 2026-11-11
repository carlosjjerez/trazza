// Pruebas del núcleo de ANÁLISIS de tanda (segmentar, perfil por distancia,
// remuestreo, delta por distancia, reparto por sectores, constancia).
const A = require('../analyze.js');

let pass=0, fail=0;
function ok(name,cond){ if(cond)pass++; else{fail++; console.log('  FAIL', name);} }
function near(a,b,tol){ return a!=null && b!=null && Math.abs(a-b)<=tol; }

// Pista sintética: tramo recto hacia el norte, velocidad constante.
// Construimos un track a ~1 Hz y dos "vueltas" con tiempos de cruce.
const R = 6378137;
const CLAT=37.6444, CLON=-1.0352;
function north(lat, m){ return lat + (m/R)*180/Math.PI; }

// ---- segmentLaps ----
{
  // track de 0..20 s; cruces en t=2000 (inicio), 12000 (fin v1), 22000(no llega)
  const track=[];
  for(let i=0;i<=20;i++) track.push({ t:i*1000, lat:north(CLAT,i*20), lon:CLON, spd:20 });
  const laps=A.segmentLaps(track, [2000, 12000]);
  ok('seg: una vuelta', laps.length===1);
  ok('seg: numerada n=1', laps.length && laps[0].n===1);
  ok('seg: recorta por tiempo', laps.length && laps[0].points.every(p=>p.t>=2000 && p.t<=12000));
  ok('seg: sin cruces -> vacío', A.segmentLaps(track, [2000]).length===0);
}

// ---- lapProfile: distancia acumulada y tiempo relativo ----
{
  const pts=[]; for(let i=0;i<=10;i++) pts.push({ t:1000+i*1000, lat:north(CLAT,i*20), lon:CLON, spd:20 });
  const prof=A.lapProfile(pts);
  ok('perfil: primer punto d=0 t=0', prof[0].d===0 && prof[0].t===0);
  ok('perfil: t relativo al inicio', near(prof[10].t, 10000, 1));
  ok('perfil: distancia ~200 m (10×20)', near(prof[10].d, 200, 2));
  // filtro de ruido: un salto < 1.5 m no suma distancia
  const noisy=[{t:0,lat:CLAT,lon:CLON,spd:0},{t:1000,lat:north(CLAT,1),lon:CLON,spd:0}];
  ok('perfil: ignora micro-saltos (<1.5 m)', A.lapProfile(noisy)[1].d===0);
}

// ---- resampleByDistance: rejilla uniforme ----
{
  const pts=[]; for(let i=0;i<=10;i++) pts.push({ t:i*1000, lat:north(CLAT,i*20), lon:CLON, spd:20 });
  const prof=A.lapProfile(pts);           // 200 m, 10 s
  const rs=A.resampleByDistance(prof, 5);
  ok('resample: nPoints respetado', rs.length===5);
  ok('resample: d0=0 y dN=total', rs[0].d===0 && near(rs[4].d,200,1e-6));
  ok('resample: tiempo medio ~5 s a mitad', near(rs[2].t, 5000, 50));
}

// ---- deltaByDistance: A más rápida => dt negativo ----
{
  // A: 20 m/s (rápida); B: 16 m/s (lenta). Misma distancia 200 m.
  const mk=(v)=>{ const p=[]; const n=Math.round(200/v); for(let i=0;i<=n;i++) p.push({t:i*1000,lat:north(CLAT,i*v),lon:CLON,spd:v}); return A.lapProfile(p); };
  const pa=mk(20), pb=mk(16);
  const dd=A.deltaByDistance(pa, pb, 50);
  const mid=dd[Math.floor(dd.length/2)];
  ok('delta: A (rápida) va por delante -> dt<0', mid.dt<0);
  ok('delta: usa rejilla común', dd.length===50 && dd[0].d===0);
}

// ---- gainLossBySector: suma de sectores ~ delta total ----
{
  const mk=(v)=>{ const p=[]; const n=Math.round(300/v); for(let i=0;i<=n;i++) p.push({t:i*1000,lat:north(CLAT,i*v),lon:CLON,spd:v}); return A.lapProfile(p); };
  const pa=mk(20), pb=mk(15);
  const gl=A.gainLossBySector(pa, pb, 3);
  ok('g/l: 3 sectores', gl.length===3);
  const sum=gl.reduce((a,s)=>a+s.dt,0);
  // delta total al final = t_A(L) - t_B(L) sobre la longitud común
  const total=A.deltaByDistance(pa,pb,2).slice(-1)[0].dt;
  ok('g/l: suma de sectores ≈ delta total', near(sum, total, 50));
  ok('g/l: todos los sectores favorables a A (dt<0)', gl.every(s=>s.dt<0));
}

// ---- consistency ----
{
  const c=A.consistency([100000,100000,100000]);
  ok('const: sd 0 si todas iguales', c.sd===0 && c.cv===0);
  const c2=A.consistency([100000,102000,98000, -1, 0]);
  ok('const: ignora inválidas', c2.count===3);
  ok('const: media correcta', near(c2.mean,100000,1));
  ok('const: sd>0 con dispersión', c2.sd>0);
}

// ---- peakSpeed ----
{
  const prof=[{d:0,spd:10},{d:50,spd:40},{d:100,spd:25}];
  const pk=A.peakSpeed(prof);
  ok('peak: velocidad máx', pk.spd===40 && pk.d===50);
}

console.log(`\nANALYZE TESTS: ${pass} pass, ${fail} fail`);
if(fail) process.exit(1);
