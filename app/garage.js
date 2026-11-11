/* =====================================================================
   Trazza — núcleo del GARAJE (puro, testeable)
   Motos, mantenimiento por HORAS DE MOTOR, fichas de reglaje y mejor tiempo
   por reglaje/circuito. Solo datos locales (localStorage); sin DOM.
   require-able desde Node y cubierto por tests.
   ===================================================================== */
(function(global){
  'use strict';

  // Checklist de mantenimiento por defecto (intervalos en HORAS DE MOTOR).
  const DEFAULT_MAINT = [
    { id:'aceite',     label:'Aceite y filtro',        intervalH:15 },
    { id:'transmision',label:'Cadena y transmisión',   intervalH:10 },
    { id:'pastillas',  label:'Pastillas de freno',     intervalH:12 },
    { id:'liquido',    label:'Líquido de frenos',      intervalH:30 },
    { id:'horquilla',  label:'Revisión de horquilla',  intervalH:20 },
    { id:'valvulas',   label:'Holgura de válvulas',    intervalH:60 },
  ];
  function defaultMaintenance(){ return DEFAULT_MAINT.map(m=>({ ...m, lastH:0 })); }

  // Campos de una ficha de reglaje (numéricos; se guardan tal cual).
  const SETUP_FIELDS = [
    { id:'preDel',  label:'Precarga delantera',   unit:'clics' },
    { id:'compDel', label:'Compresión delantera', unit:'clics' },
    { id:'rebDel',  label:'Rebote delantero',     unit:'clics' },
    { id:'altDel',  label:'Altura delantera',     unit:'mm' },
    { id:'preTra',  label:'Precarga trasera',     unit:'clics' },
    { id:'compTra', label:'Compresión trasera',   unit:'clics' },
    { id:'rebTra',  label:'Rebote trasero',       unit:'clics' },
    { id:'altTra',  label:'Altura trasera',       unit:'mm' },
    { id:'presDel', label:'Presión delantera',    unit:'bar' },
    { id:'presTra', label:'Presión trasera',      unit:'bar' },
  ];

  /* Estado de un elemento de mantenimiento dado el total de horas de motor.
     used = horas desde el último servicio; remaining = las que faltan;
     frac = fracción del intervalo consumida (0..1); due = toca ya. */
  function maintStatus(item, engineHours){
    const interval = item && item.intervalH>0 ? item.intervalH : 0;
    const used = Math.max(0, (engineHours||0) - (item && item.lastH||0));
    const remaining = interval - used;
    const frac = interval>0 ? Math.max(0, Math.min(1, used/interval)) : 0;
    return { used, remaining, frac, due: interval>0 && remaining<=0 };
  }

  /* Horas de motor que aporta una sesión. Preferimos el TIEMPO EN PISTA real
     (suma de vueltas válidas); si no hay vueltas, el reloj de pared de la tanda.
     Cap de seguridad: una tanda no suma más de 2 h (evita datos corruptos). */
  function sessionHours(s){
    if(!s) return 0;
    const lapMs = (s.laps||[]).filter(l=>l && l.ms>0).reduce((a,l)=>a+l.ms, 0);
    let ms = lapMs>0 ? lapMs : ((s.endedAt!=null && s.startedAt!=null) ? (s.endedAt - s.startedAt) : 0);
    if(!(ms>0)) return 0;
    return Math.min(2, ms/3600000);
  }

  // Suma horas de motor a una moto (inmutable). Redondea a centésimas.
  function addEngineHours(bike, hours){
    const h = (bike && bike.engineHours || 0) + (hours||0);
    return Object.assign({}, bike, { engineHours: Math.round(h*100)/100 });
  }

  /* Mejor tiempo por (circuito, reglaje) para una moto, a partir de las
     sesiones. Devuelve filas ordenadas por circuito y luego por tiempo. */
  function bestSetups(sessions, bikeId){
    const map = {};
    (sessions||[]).forEach(s=>{
      if(!s || s.bikeId!==bikeId || s.best==null) return;
      const circuit = s.name || '—';
      const setup = s.setupName || 'Sin reglaje';
      const key = circuit + '||' + setup;
      if(!map[key] || s.best < map[key].bestMs){
        map[key] = { circuit, setup, bestMs:s.best, date:s.startedAt||0 };
      }
    });
    return Object.keys(map).map(k=>map[k])
      .sort((a,b)=> a.circuit.localeCompare(b.circuit) || a.bestMs-b.bestMs);
  }

  /* Total de horas de motor que deberían acumularse por las sesiones de una
     moto (útil para recalcular si hiciera falta). */
  function totalHoursFromSessions(sessions, bikeId){
    return (sessions||[]).filter(s=>s && s.bikeId===bikeId)
      .reduce((a,s)=> a + sessionHours(s), 0);
  }

  const api = { DEFAULT_MAINT, SETUP_FIELDS, defaultMaintenance, maintStatus,
                sessionHours, addEngineHours, bestSetups, totalHoursFromSessions };
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  global.TrazzaGarage=api;
})(typeof self!=='undefined' ? self : globalThis);
