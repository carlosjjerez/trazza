/* =====================================================================
   Trazza — núcleo de ANÁLISIS de tanda (puro, testeable)
   A partir del track crudo de la sesión [{t,lat,lon,spd}] y los tiempos
   de cruce de meta (crossTimes), reconstruye las vueltas y produce lo
   que necesita la pantalla de análisis:
     - segmentar el track en vueltas
     - perfil de vuelta por DISTANCIA (coherente con el delta de Trazza,
       que siempre va por distancia recorrida, no por tiempo)
     - remuestreo a rejilla de distancia uniforme (para comparar dos
       vueltas sobre el mismo eje X)
     - delta por distancia entre dos vueltas (verde ganas / rojo pierdes)
     - reparto de ese delta por sectores (narrativa «dónde ganas/pierdes»)
     - constancia (desviación de tus tiempos)
   Honestidad de datos: el móvil da ~1 Hz; esto trabaja en DÉCIMAS, no
   centésimas. No inventa precisión que la fuente no da.
   Sin dependencias de DOM: require-able desde Node y cubierto por tests.
   ===================================================================== */
(function(global){
  'use strict';

  // haversine: reutiliza el del núcleo de detección si está; si no, propio.
  const D = (typeof require!=='undefined' && typeof module!=='undefined')
    ? (function(){ try{ return require('./detect.js'); }catch(e){ return null; } })()
    : (global.TrazzaDetect||null);
  const R = 6378137;
  const haversine = (D && D.haversine) ? D.haversine : function(aLat,aLon,bLat,bLon){
    const dLat=(bLat-aLat)*Math.PI/180, dLon=(bLon-aLon)*Math.PI/180;
    const la1=aLat*Math.PI/180, la2=bLat*Math.PI/180;
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(h));
  };

  /* Segmenta el track por los tiempos de cruce. crossTimes = [inicio, cierre
     vuelta1, cierre vuelta2, ...]; la vuelta k son los puntos con
     crossTimes[k] <= t <= crossTimes[k+1]. Devuelve [{n, t0, t1, points}]. */
  function segmentLaps(track, crossTimes){
    if(!track || !crossTimes || crossTimes.length<2) return [];
    const out=[];
    for(let k=0;k<crossTimes.length-1;k++){
      const t0=crossTimes[k], t1=crossTimes[k+1];
      if(t0==null || t1==null || t1<=t0) continue;
      const points=track.filter(p=>p.t>=t0 && p.t<=t1);
      if(points.length>=2) out.push({ n:k+1, t0, t1, points });
    }
    return out;
  }

  /* Perfil por distancia de una vuelta: distancia acumulada (con el mismo
     filtro de ruido que el crono en vivo: ignora saltos < 1.5 m), tiempo
     relativo al inicio de la vuelta, velocidad, y coordenadas. */
  function lapProfile(points, opts){
    opts=opts||{};
    const minGap = opts.minGap!=null ? opts.minGap : 1.5;
    if(!points || points.length<2) return [];
    const t0=points[0].t;
    let cum=0;
    const mk=(p,d,t)=>({ d, t, spd:p.spd!=null?p.spd:null, lean:p.lean!=null?p.lean:null, g:p.g!=null?p.g:null, lat:p.lat, lon:p.lon });
    const prof=[ mk(points[0], 0, 0) ];
    for(let i=1;i<points.length;i++){
      const d=haversine(points[i-1].lat,points[i-1].lon,points[i].lat,points[i].lon);
      if(d>minGap) cum+=d;
      prof.push( mk(points[i], cum, points[i].t-t0) );
    }
    return prof;
  }

  // interpola linealmente un campo del perfil (por distancia d)
  function interpAt(prof, d, field){
    if(!prof || !prof.length) return null;
    if(d<=prof[0].d) return prof[0][field];
    const n=prof.length;
    if(d>=prof[n-1].d) return prof[n-1][field];
    for(let i=1;i<n;i++){
      if(prof[i].d>=d){
        const a=prof[i-1], b=prof[i];
        const va=a[field], vb=b[field];
        if(va==null) return vb; if(vb==null) return va;
        const f=(d-a.d)/((b.d-a.d)||1);
        return va + f*(vb-va);
      }
    }
    return prof[n-1][field];
  }

  /* Remuestrea el perfil a nPoints sobre una rejilla de distancia uniforme
     [0, totalD]. Si totalD no se da, usa la distancia final del perfil. */
  function resampleByDistance(prof, nPoints, totalD){
    if(!prof || prof.length<2) return [];
    const L = totalD!=null ? totalD : prof[prof.length-1].d;
    if(!(L>0)) return [];
    const n=Math.max(2, nPoints|0);
    const out=[];
    for(let i=0;i<n;i++){
      const d=(i/(n-1))*L;
      out.push({ d, t:interpAt(prof,d,'t'), spd:interpAt(prof,d,'spd') });
    }
    return out;
  }

  /* Delta por distancia A vs B: tiempo(A)-tiempo(B) en cada distancia de una
     rejilla común. Negativo = A más rápida (ganas, verde). Usa la MENOR de
     las dos longitudes para no extrapolar. Devuelve [{d, dt, spdA, spdB}]. */
  function deltaByDistance(profA, profB, nPoints){
    if(!profA || profA.length<2 || !profB || profB.length<2) return [];
    const LA=profA[profA.length-1].d, LB=profB[profB.length-1].d;
    const L=Math.min(LA,LB); if(!(L>0)) return [];
    const n=Math.max(2, nPoints||120);
    const out=[];
    for(let i=0;i<n;i++){
      const d=(i/(n-1))*L;
      const tA=interpAt(profA,d,'t'), tB=interpAt(profB,d,'t');
      out.push({ d, dt:(tA!=null&&tB!=null)?(tA-tB):null,
        spdA:interpAt(profA,d,'spd'), spdB:interpAt(profB,d,'spd'),
        leanA:interpAt(profA,d,'lean'), leanB:interpAt(profB,d,'lean') });
    }
    return out;
  }

  /* Reparte el delta A-vs-B por n sectores de igual distancia: cuánto tiempo
     ganas/pierdes en cada tramo. Devuelve [{sector, dt, dFrom, dTo}] donde dt
     es el delta ACUMULADO ganado en ese sector (diferencia de deltas en los
     bordes). Base para la narrativa «dónde está la vuelta». */
  function gainLossBySector(profA, profB, nSectors){
    const n=Math.max(1, nSectors|0);
    const LA=profA&&profA.length?profA[profA.length-1].d:0;
    const LB=profB&&profB.length?profB[profB.length-1].d:0;
    const L=Math.min(LA,LB); if(!(L>0)) return [];
    const deltaAt=(d)=>{ const tA=interpAt(profA,d,'t'), tB=interpAt(profB,d,'t'); return (tA!=null&&tB!=null)?(tA-tB):null; };
    const out=[]; let prevD=0, prevDelta=deltaAt(0)||0;
    for(let i=1;i<=n;i++){
      const d=(i/n)*L; const delta=deltaAt(d);
      const seg=(delta!=null?delta:prevDelta)-prevDelta;
      out.push({ sector:i, dt:seg, dFrom:prevD, dTo:d });
      prevD=d; if(delta!=null) prevDelta=delta;
    }
    return out;
  }

  /* Constancia: media, desviación típica y coeficiente de variación de un
     array de tiempos de vuelta (ms). Ignora no-positivos (vueltas inválidas).
     sd baja = pilotaje constante. */
  function consistency(lapMs){
    const v=(lapMs||[]).filter(x=>typeof x==='number' && x>0);
    if(!v.length) return { count:0, mean:null, sd:null, cv:null };
    const mean=v.reduce((a,b)=>a+b,0)/v.length;
    const varc=v.reduce((a,b)=>a+(b-mean)*(b-mean),0)/v.length;
    const sd=Math.sqrt(varc);
    return { count:v.length, mean, sd, cv: mean>0 ? sd/mean : null };
  }

  /* Velocidad máxima del perfil (m/s) y su distancia. */
  function peakSpeed(prof){
    let best=null;
    (prof||[]).forEach(p=>{ if(p.spd!=null && (best==null || p.spd>best.spd)) best={ spd:p.spd, d:p.d }; });
    return best;
  }

  /* Detecta las CURVAS de una vuelta a partir del perfil de velocidad: cada
     mínimo local de velocidad con prominencia suficiente es el vértice de una
     curva; la curva va del pico de velocidad anterior al siguiente. Por curva
     devuelve velocidades de entrada/mínima/salida, inclinación máx, punto de
     frenada (donde empieza a caer la velocidad) y tiempo del tramo.
     Todo por DISTANCIA. opts.promFrac = prominencia mínima (fracción del rango
     de velocidad) para que un mínimo cuente como curva (por defecto 0.12). */
  function corners(profile, opts){
    opts=opts||{};
    const prom = opts.promFrac!=null?opts.promFrac:0.12;
    const win  = opts.smoothWin!=null?opts.smoothWin:3;
    const n = profile?profile.length:0; if(n<5) return [];
    const d=profile.map(p=>p.d), v=profile.map(p=>p.spd!=null?p.spd:null);
    if(v.some(x=>x==null)) return [];               // sin velocidad fiable, no hay curvas
    // suavizado (media móvil) para no detectar ruido del GPS como curvas
    const h=Math.max(0,(win-1)>>1);
    const vs=v.map((_,i)=>{ let s=0,c=0; for(let j=-h;j<=h;j++){ const k=i+j; if(k>=0&&k<n){s+=v[k];c++;} } return s/c; });
    let vmin=Infinity, vmax=-Infinity; vs.forEach(x=>{ vmin=Math.min(vmin,x); vmax=Math.max(vmax,x); });
    const minProm=prom*((vmax-vmin)||1);
    const peaks=[], valleys=[];
    for(let i=1;i<n-1;i++){
      if(vs[i]<vs[i-1] && vs[i]<=vs[i+1]) valleys.push(i);
      else if(vs[i]>vs[i-1] && vs[i]>=vs[i+1]) peaks.push(i);
    }
    const out=[];
    valleys.forEach(k=>{
      let left=0; peaks.forEach(p=>{ if(p<k) left=p; });
      let right=n-1; for(let pi=peaks.length-1;pi>=0;pi--){ if(peaks[pi]>k) right=peaks[pi]; }
      const vEntry=vs[left], vExit=vs[right], vMin=vs[k];
      if((Math.min(vEntry,vExit)-vMin) < minProm) return;     // no frenas lo bastante: recta, no curva
      let brake=left; for(let i=left;i<=k;i++){ if(vs[i] < vEntry-0.5){ brake=i; break; } }
      let maxLean=0, hasLean=false;
      for(let i=left;i<=right;i++){ const L=profile[i].lean; if(L!=null){ hasLean=true; maxLean=Math.max(maxLean, Math.abs(L)); } }
      out.push({ iApex:k, dStart:d[left], dApex:d[k], dEnd:d[right], dBrake:d[brake],
        vEntry, vMin, vExit, maxLean: hasLean?maxLean:null, tSeg: profile[right].t-profile[left].t });
    });
    // descarta curvas solapadas (mismo tramo): quédate con la de menor vMin
    out.sort((a,b)=>a.dStart-b.dStart);
    const merged=[];
    out.forEach(c=>{ const last=merged[merged.length-1];
      if(last && c.dStart < last.dEnd){ if(c.vMin < last.vMin) merged[merged.length-1]=c; }
      else merged.push(c); });
    return merged;
  }

  /* Delta de tiempo de una ventana de distancia [dFrom,dTo] entre dos perfiles
     (A menos B). Útil para comparar una curva A contra la misma zona en B. */
  function windowDelta(profA, profB, dFrom, dTo){
    const tA = interpAt(profA,dTo,'t') - interpAt(profA,dFrom,'t');
    const tB = interpAt(profB,dTo,'t') - interpAt(profB,dFrom,'t');
    return (tA!=null && tB!=null) ? (tA - tB) : null;
  }

  const api={ segmentLaps, lapProfile, interpAt, resampleByDistance, deltaByDistance, gainLossBySector, consistency, peakSpeed, corners, windowDelta };
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  global.TrazzaAnalyze=api;
})(typeof self!=='undefined' ? self : globalThis);
