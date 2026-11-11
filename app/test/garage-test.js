// Pruebas del núcleo del GARAJE (mantenimiento por horas, horas de sesión,
// acumulación de horas de motor, mejor tiempo por reglaje).
const Gg = require('../garage.js');

let pass=0, fail=0;
function ok(name,cond){ if(cond)pass++; else{fail++; console.log('  FAIL', name);} }
function near(a,b,tol){ return a!=null && Math.abs(a-b)<=tol; }

// ---- defaults ----
{
  const m=Gg.defaultMaintenance();
  ok('maint: hay checklist por defecto', m.length>=5);
  ok('maint: cada elemento arranca con lastH=0', m.every(x=>x.lastH===0));
  ok('setup: hay campos de reglaje', Gg.SETUP_FIELDS.length>=6);
}

// ---- maintStatus ----
{
  const item={ id:'aceite', intervalH:15, lastH:0 };
  let st=Gg.maintStatus(item, 0);
  ok('maint: a 0 h, 15 restantes, no toca', near(st.remaining,15,1e-9) && st.due===false && near(st.frac,0,1e-9));
  st=Gg.maintStatus(item, 10);
  ok('maint: a 10 h, 5 restantes, frac 2/3', near(st.remaining,5,1e-9) && near(st.frac,10/15,1e-6));
  st=Gg.maintStatus(item, 15);
  ok('maint: a 15 h, toca (due)', st.due===true && near(st.remaining,0,1e-9) && st.frac===1);
  st=Gg.maintStatus(item, 20);
  ok('maint: pasado, remaining negativo y due', st.due===true && st.remaining<0 && st.frac===1);
  // tras servicio: lastH sube al total actual
  st=Gg.maintStatus({ id:'aceite', intervalH:15, lastH:20 }, 22);
  ok('maint: tras servicio cuenta desde lastH', near(st.used,2,1e-9) && near(st.remaining,13,1e-9) && st.due===false);
}

// ---- sessionHours ----
{
  // 10 vueltas de 100 s = 1000 s ≈ 0,2778 h
  const laps=Array.from({length:10},(_,i)=>({n:i+1,ms:100000}));
  ok('horas: usa tiempo en pista (vueltas)', near(Gg.sessionHours({laps}), 1000/3600, 1e-6));
  // sin vueltas -> reloj de pared
  ok('horas: sin vueltas usa reloj de pared', near(Gg.sessionHours({laps:[], startedAt:0, endedAt:1800000}), 0.5, 1e-9));
  // cap de 2 h
  ok('horas: cap a 2 h', Gg.sessionHours({laps:[], startedAt:0, endedAt:10*3600000})===2);
  ok('horas: sin datos -> 0', Gg.sessionHours({})===0);
}

// ---- addEngineHours ----
{
  const b={ id:'b1', engineHours:3.5 };
  const b2=Gg.addEngineHours(b, 0.28);
  ok('horas: suma inmutable', b.engineHours===3.5 && near(b2.engineHours,3.78,1e-9));
  const b0=Gg.addEngineHours({id:'x'}, 1.2);
  ok('horas: parte de 0 si no había', near(b0.engineHours,1.2,1e-9));
}

// ---- bestSetups ----
{
  const sessions=[
    { bikeId:'b1', name:'Cartagena', setupName:'Base',   best:103000, startedAt:1 },
    { bikeId:'b1', name:'Cartagena', setupName:'Base',   best:102000, startedAt:2 }, // mejora
    { bikeId:'b1', name:'Cartagena', setupName:'Cheste', best:101500, startedAt:3 },
    { bikeId:'b1', name:'Jerez',     setupName:'Base',   best:120000, startedAt:4 },
    { bikeId:'b2', name:'Cartagena', setupName:'Base',   best:99000,  startedAt:5 }, // otra moto
    { bikeId:'b1', name:'Cartagena', setupName:'Base',   best:null,   startedAt:6 }, // sin tiempo
  ];
  const rows=Gg.bestSetups(sessions, 'b1');
  ok('reglajes: no mezcla otras motos', rows.every(r=>r.bestMs!==99000));
  const base=rows.find(r=>r.circuit==='Cartagena' && r.setup==='Base');
  ok('reglajes: mejor de (Cartagena, Base) = 1:42.0', base && base.bestMs===102000);
  ok('reglajes: separa reglajes del mismo circuito', rows.filter(r=>r.circuit==='Cartagena').length===2);
  ok('reglajes: incluye otros circuitos', rows.some(r=>r.circuit==='Jerez'));
}

// ---- totalHoursFromSessions ----
{
  const sessions=[
    { bikeId:'b1', laps:[{ms:100000},{ms:100000}] }, // 200 s
    { bikeId:'b1', laps:[{ms:100000}] },             // 100 s
    { bikeId:'b2', laps:[{ms:100000}] },
  ];
  ok('total horas: solo de la moto', near(Gg.totalHoursFromSessions(sessions,'b1'), 300/3600, 1e-6));
}

console.log(`\nGARAGE TESTS: ${pass} pass, ${fail} fail`);
if(fail) process.exit(1);
