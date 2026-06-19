/* =====================================================================
   Trazza — Simulador de GPS (modo demo)
   Emite fixes sintéticos a ~1 Hz para ver el HUD y la detección sin pista.
     - Sin sesión: posición casi fija (meta elegida o Cartagena) para marcar.
     - En sesión con TRAZADO (outline): recorre el circuito real-ish pasando
       por la meta una vez por vuelta.
     - En sesión sin trazado: óvalo alrededor de la meta.
   ===================================================================== */
(function(){
  'use strict';
  const R=6378137;
  const CART=(window.CART_TRACK&&window.CART_TRACK.finish)||{ lat:37.6444, lon:-1.0352 };
  const A=200, B=110;                          // óvalo de respaldo (m)
  const DURS=[45,43.6,44.4,46.1,43.9,45.3];    // s/vuelta del óvalo de respaldo
  const VARF=[1,0.985,1.02,0.99,1.01,0.975];   // variación por vuelta
  // duración realista según longitud del trazado (grande ~rápido, corto ~lento).
  // L/36 ≈ ritmo de track-day (Cartagena ~1:46); corto se queda en el mínimo.
  function durFor(L, idx){ return Math.max(30, Math.min(150, L/36)) * VARF[idx%VARF.length]; }

  function offset(lat,lon,e,n){ return { lat:lat+n/R*180/Math.PI, lon:lon+e/(R*Math.cos(lat*Math.PI/180))*180/Math.PI }; }
  function haversine(aLat,aLon,bLat,bLon){ const dLat=(bLat-aLat)*Math.PI/180,dLon=(bLon-aLon)*Math.PI/180,la1=aLat*Math.PI/180,la2=bLat*Math.PI/180;
    const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

  function center(){
    try{ if(typeof live!=='undefined' && live.running && live.gate) return live.gate; }catch(e){}
    try{ if(typeof selectedMeta!=='undefined' && selectedMeta) return selectedMeta; }catch(e){}
    return CART;
  }
  function inSession(){ try{ return typeof live!=='undefined' && live.running; }catch(e){ return false; } }

  const Sim={
    active:false, onFix:null, timer:null, theta:-0.6, s:0, lapIdx:0, prev:null, t0:0, path:null, pathRef:null,
    start(onFix){ this.onFix=onFix; this.active=true; this.theta=-0.6; this.s=-40; this.lapIdx=0; this.prev=null; this.t0=Date.now(); this.path=null; this.pathRef=null;
      this.tick(); this.timer=setInterval(()=>this.tick(),1000); },
    stop(){ this.active=false; if(this.timer){ clearInterval(this.timer); this.timer=null; } },
    tick(){
      const now=Date.now(); const c=center(); let ll, acc, session=inSession();
      if(session && c.outline && window.TrazzaDetect){
        // recorrer el trazado a velocidad variable (frena en curvas)
        if(this.pathRef!==c.outline){ this.path=window.TrazzaDetect.buildPath(c.outline); this.pathRef=c.outline; if(this.s<0) this.s=-Math.min(40, this.path.length*0.1); }
        const L=this.path.length, dur=durFor(L, this.lapIdx), base=L/dur;
        const frac=(((this.s%L)+L)%L)/L;
        const step=base*(1+0.4*Math.sin(frac*2*Math.PI*3)); // 3 zonas rápidas/lentas
        const before=Math.floor(this.s/L);
        this.s+=step;
        if(Math.floor(this.s/L)>before) this.lapIdx++;
        ll=window.TrazzaDetect.pointAt(this.path, this.s);
        acc=2.5+Math.random()*2;
      } else if(session){
        const dur=DURS[this.lapIdx%DURS.length];
        // óvalo de respaldo
        const x=B*(Math.cos(this.theta)-1), y=A*Math.sin(this.theta);
        ll=offset(c.lat,c.lon,x,y); acc=2.5+Math.random()*2;
        const before=Math.floor(this.theta/(2*Math.PI)); this.theta+=2*Math.PI/dur;
        if(Math.floor(this.theta/(2*Math.PI))>before) this.lapIdx++;
      } else {
        // configuración: casi parado, rumbo norte
        const ph=((now-this.t0)/1000)%20, creep=ph<10?ph:20-ph;
        ll=offset(c.lat,c.lon,0,creep); acc=3.0;
      }
      let spd=session?null:1.0;
      if(this.prev){ spd=haversine(this.prev.lat,this.prev.lon,ll.lat,ll.lon)/1.0; }
      this.prev=ll;
      this.onFix({ lat:ll.lat, lon:ll.lon, t:now, acc, spd });
    },
  };
  window.TrazzaSim=Sim;
})();
