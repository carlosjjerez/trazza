/* =====================================================================
   Trazza — núcleo de detección de vueltas (puro, testeable)
   Modelo orientado a función: la meta es un PUNTO con un radio de captura.
   Una vuelta se cierra en el momento de MÁXIMA APROXIMACIÓN al punto a lo
   largo de la trayectoria (no requiere rumbo de la línea), con:
     - interpolación sub-muestra (punto-a-segmento) -> tiempo exacto
     - bloqueo de sentido (descarta pasos en dirección contraria / boxes)
     - vuelta mínima (anti-rebote)
   Funciona igual con GPS del móvil (~1 Hz) que con hardware a 10 Hz.
   ===================================================================== */
(function(global){
  'use strict';
  const R = 6378137; // radio terrestre (m)

  function projFactory(lat0, lon0){
    const cos0 = Math.cos(lat0*Math.PI/180);
    return { toXY(lat, lon){
      return { x:(lon-lon0)*Math.PI/180*R*cos0, y:(lat-lat0)*Math.PI/180*R };
    }};
  }

  function haversine(aLat,aLon,bLat,bLon){
    const dLat=(bLat-aLat)*Math.PI/180, dLon=(bLon-aLon)*Math.PI/180;
    const la1=aLat*Math.PI/180, la2=bLat*Math.PI/180;
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(h));
  }

  // diferencia angular mínima entre dos rumbos (rad)
  function angDiff(a,b){ let d=Math.abs(a-b)%(2*Math.PI); if(d>Math.PI) d=2*Math.PI-d; return d; }

  /* Aproximación punto-a-segmento: distancia mínima del punto de meta (origen
     de la proyección) al segmento p0->p1. Devuelve la fracción tau∈[0,1] del
     segmento donde se da esa mínima, la distancia, y el rumbo del segmento.
     null si el segmento es demasiado corto (parado) o no se acerca al radio. */
  function segApproach(proj, p0, p1, radius){
    const P0=proj.toXY(p0.lat,p0.lon);
    const P1=proj.toXY(p1.lat,p1.lon);
    const dx=P1.x-P0.x, dy=P1.y-P0.y;
    const len2=dx*dx+dy*dy;
    if(len2 < 4) return null;                 // <2 m de avance: ignorar (parado)
    let tau = -(P0.x*dx + P0.y*dy)/len2;      // F=(0,0) -> proyección de -P0 sobre dir
    if(tau<0) tau=0; else if(tau>1) tau=1;
    const cx=P0.x+tau*dx, cy=P0.y+tau*dy;
    const dmin=Math.hypot(cx,cy);
    if(dmin>=radius) return null;
    return { tau, dmin, bearing:Math.atan2(dx,dy) };
  }

  // interpola el tiempo del perfil mejor-vuelta [{d,t}] en la distancia d
  function interpProfile(profile, d){
    if(!profile || !profile.length) return null;
    if(d<=profile[0].d) return profile[0].t;
    const n=profile.length;
    if(d>=profile[n-1].d) return profile[n-1].t;
    // búsqueda lineal (perfiles cortos, ~1 Hz)
    for(let i=1;i<n;i++){
      if(profile[i].d>=d){
        const a=profile[i-1], b=profile[i];
        const f=(d-a.d)/((b.d-a.d)||1);
        return a.t + f*(b.t-a.t);
      }
    }
    return profile[n-1].t;
  }

  /* Detector de cruces de meta. Acumula candidatos durante un "paso" (fixes
     consecutivos dentro del radio) y, al terminar el paso, elige el de menor
     distancia (la aproximación real) para máxima precisión también a alta
     velocidad, donde puede que ningún fix caiga dentro del radio. */
  class LapDetector{
    constructor(opts){
      this.proj = projFactory(opts.lat, opts.lon);
      this.radius = opts.radius;
      this.minLapMs = opts.minLapMs;
      this.dirTol = (opts.dirTolDeg!=null?opts.dirTolDeg:70)*Math.PI/180;
      this.prev = null;
      this.lockedBearing = null;
      this.lastCrossT = null;
      this.pass = [];          // candidatos del paso actual
      this.lapNum = 0;
    }

    // procesa un fix {lat,lon,t}; devuelve evento o null
    update(fix){
      let ev=null;
      if(this.prev){
        const c=segApproach(this.proj, this.prev, fix, this.radius);
        if(c){
          const crossT=this.prev.t + c.tau*(fix.t-this.prev.t);
          this.pass.push({ crossT, dmin:c.dmin, bearing:c.bearing });
        } else if(this.pass.length){
          ev=this._finalizePass();
        }
      }
      this.prev=fix;
      return ev;
    }

    // por si la sesión termina con un paso a medio cerrar
    flush(){ return this.pass.length ? this._finalizePass() : null; }

    _finalizePass(){
      // mejor candidato = menor distancia a meta
      let best=this.pass[0];
      for(const c of this.pass) if(c.dmin<best.dmin) best=c;
      this.pass=[];

      // bloqueo de sentido: descarta pasos en dirección contraria
      if(this.lockedBearing!=null && angDiff(best.bearing,this.lockedBearing)>this.dirTol) return null;
      // anti-rebote
      if(this.lastCrossT!=null && (best.crossT-this.lastCrossT)<this.minLapMs) return null;

      if(this.lastCrossT==null){
        this.lockedBearing=best.bearing;
        this.lastCrossT=best.crossT;
        this.lapNum=1;
        return { kind:'start', t:best.crossT, lapNum:1 };
      }
      const lapMs=best.crossT-this.lastCrossT;
      this.lastCrossT=best.crossT;
      const n=this.lapNum;
      this.lapNum=n+1;
      return { kind:'lap', t:best.crossT, lapMs, lapNum:n };
    }
  }

  const api={ R, projFactory, haversine, angDiff, segApproach, interpProfile, LapDetector };
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  global.TrazzaDetect=api;
})(typeof self!=='undefined' ? self : globalThis);
