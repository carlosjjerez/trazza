/* =====================================================================
   Trazza — Simulador de GPS (modo demo)
   Emite fixes sintéticos a ~1 Hz para ver el HUD y la detección de vueltas
   sin salir a pista. Se activa en Ajustes → Pruebas.
     - Sin sesión: posición casi fija (Cartagena o la meta elegida) para poder
       marcar/elegir meta.
     - En sesión: bucle elíptico alrededor de la meta, pasando por ella una vez
       por vuelta (~45 s, con variación).
   El modelo de detección es por aproximación al PUNTO, así que el bucle no
   necesita rumbo de línea.
   ===================================================================== */
(function(){
  'use strict';
  const R=6378137;
  const CART={ lat:37.6444, lon:-1.0352 };
  const A=200, B=110;                         // semiejes del óvalo (m)
  const DURS=[45,43.6,44.4,46.1,43.9,45.3];   // s por vuelta (varía)

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
    active:false, onFix:null, timer:null, theta:-0.6, lapIdx:0, prev:null, t0:0,
    start(onFix){ this.onFix=onFix; this.active=true; this.theta=-0.6; this.lapIdx=0; this.prev=null; this.t0=Date.now();
      this.tick(); this.timer=setInterval(()=>this.tick(),1000); },
    stop(){ this.active=false; if(this.timer){ clearInterval(this.timer); this.timer=null; } },
    tick(){
      const now=Date.now(); const c=center(); let ll, acc, session=inSession();
      if(session){
        const x=B*(Math.cos(this.theta)-1), y=A*Math.sin(this.theta); // pasa por el centro en theta=0
        ll=offset(c.lat,c.lon,x,y); acc=2.5+Math.random()*2;
        const dur=DURS[this.lapIdx%DURS.length], dtheta=2*Math.PI/dur;
        const before=Math.floor(this.theta/(2*Math.PI)); this.theta+=dtheta;
        if(Math.floor(this.theta/(2*Math.PI))>before) this.lapIdx++;
      } else {
        const ph=((now-this.t0)/1000)%20, creep=ph<10?ph:20-ph; // 0..10 m suave
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
