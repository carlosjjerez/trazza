/* =====================================================================
   Trazza — Simulador de GPS (modo demo)
   Alimenta fixes sintéticos a ~1 Hz para ver el HUD y la detección de
   vueltas funcionando sin salir a pista. Se activa en Ajustes → Pruebas.

   - En configuración (sin sesión): emite una posición en Cartagena con
     leve avance al norte, para poder "Marcar meta aquí" o usar el preset.
   - En sesión: recorre un circuito ovalado alrededor de la meta activa,
     cruzándola en el sentido correcto una vez por vuelta.
   ===================================================================== */
(function(){
  'use strict';
  const R = 6378137;
  const CART = { lat:37.6444, lon:-1.0352 };

  // Geometría del óvalo (en metros, marco de pista): semiejes y vueltas
  const A = 200;            // semieje a lo largo de la recta de meta
  const B = 110;            // semieje transversal
  const DURS = [45, 43.6, 44.4, 46.1, 43.9, 45.3]; // s por vuelta (varía un poco)

  function offset(lat, lon, east, north){
    const dLat = north / R * 180/Math.PI;
    const dLon = east / (R * Math.cos(lat*Math.PI/180)) * 180/Math.PI;
    return { lat: lat + dLat, lon: lon + dLon };
  }
  function haversine(aLat,aLon,bLat,bLon){
    const dLat=(bLat-aLat)*Math.PI/180, dLon=(bLon-aLon)*Math.PI/180;
    const la1=aLat*Math.PI/180, la2=bLat*Math.PI/180;
    const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(h));
  }
  function bearing(aLat,aLon,bLat,bLon){
    const y=Math.sin((bLon-aLon)*Math.PI/180)*Math.cos(bLat*Math.PI/180);
    const x=Math.cos(aLat*Math.PI/180)*Math.sin(bLat*Math.PI/180)
          - Math.sin(aLat*Math.PI/180)*Math.cos(bLat*Math.PI/180)*Math.cos((bLon-aLon)*Math.PI/180);
    return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
  }

  const Sim = {
    active:false, onFix:null, timer:null, theta:0, lapCount:0, prevLL:null, t0:0,

    start(onFix){
      this.onFix = onFix;
      this.active = true;
      this.theta = -0.8;          // arranca un poco antes de la línea
      this.lapCount = 0;
      this.prevLL = null;
      this.t0 = Date.now();
      this.tick();                // primer fix inmediato
      this.timer = setInterval(()=>this.tick(), 1000);
    },

    stop(){
      this.active = false;
      if(this.timer){ clearInterval(this.timer); this.timer=null; }
    },

    inSession(){
      try { return typeof live !== 'undefined' && live.running && live.gate; }
      catch(e){ return false; }
    },

    tick(){
      const now = Date.now();
      let ll, spd=null, hdg=null, acc, session=this.inSession();

      if(session){
        // ---- modo circuito: óvalo alrededor de la meta ----
        const g = live.gate;
        const h = Math.atan2(g.hx, g.hy);          // rumbo de paso por meta
        // posición en marco de pista (x: transversal, y: a lo largo del rumbo)
        // elipse de centro (-B, 0): pasa por la meta (0,0) en theta=0 con
        // velocidad en el sentido de marcha (+y).
        const x = B * (Math.cos(this.theta) - 1);
        const y = A * Math.sin(this.theta);
        // marco pista -> este/norte
        const ae=Math.sin(h), an=Math.cos(h);      // unit a lo largo del rumbo
        const ce=Math.cos(h), cn=-Math.sin(h);     // unit transversal (derecha)
        const east  = x*ce + y*ae;
        const north = x*cn + y*an;
        ll = offset(g.lat, g.lon, east, north);
        acc = 2.5 + Math.random()*2;

        // avanza theta según la duración de la vuelta actual
        const dur = DURS[this.lapCount % DURS.length];
        const dtheta = 2*Math.PI / dur;
        const before = Math.floor(this.theta / (2*Math.PI));
        this.theta += dtheta;
        if(Math.floor(this.theta / (2*Math.PI)) > before) this.lapCount++;
      } else {
        // ---- modo configuración: casi parado en Cartagena, rumbo norte ----
        // onda triangular suave (0→10→0 m) para no teletransportar la posición
        const ph = ((now - this.t0)/1000) % 20;
        const creep = ph < 10 ? ph : 20 - ph;
        ll = offset(CART.lat, CART.lon, 0, creep);
        acc = 3.0; hdg = 0; spd = 1.0;
      }

      // en sesión, velocidad y rumbo reales a partir del paso anterior
      if(session && this.prevLL){
        const d = haversine(this.prevLL.lat, this.prevLL.lon, ll.lat, ll.lon);
        spd = d / 1.0;                                   // dt = 1 s
        hdg = bearing(this.prevLL.lat, this.prevLL.lon, ll.lat, ll.lon);
      }
      this.prevLL = ll;

      // refleja ~1 Hz en el indicador de frecuencia del HUD/meta
      try { gpsHz = 1.0; gpsLastT = now; } catch(e){}

      this.onFix({ lat:ll.lat, lon:ll.lon, t:now, acc, spd, hdg });
    },
  };

  window.TrazzaSim = Sim;
})();
