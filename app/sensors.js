/* =====================================================================
   Trazza — núcleo de SENSORES del móvil (puro, testeable)
   Inclinación (lean angle) y fuerzas G a partir del IMU del PROPIO teléfono
   (acelerómetro + giroscopio, DeviceMotion ~60 Hz). SIN hardware externo.

   Honestidad de datos (y lo que hace la competencia, p. ej. Lap360):
   el acelerómetro SOLO no mide la inclinación real en curva, porque la fuerza
   centrífuga se suma a la gravedad. Por eso el lean se estima con un FILTRO
   COMPLEMENTARIO: el giroscopio integra el giro (rápido y sin sesgo de curva)
   y el acelerómetro solo corrige la deriva CUANDO la aceleración total es
   cercana a 1 g (tramos estables), nunca en plena curva.

   Este módulo es AGNÓSTICO de ejes: recibe magnitudes ya resueltas al marco de
   la moto (rollRate, aLat, aVert...). El mapeo DeviceMotion→moto (que depende
   del soporte) vive en la app y se calibra. Así el núcleo se testea sin DOM.
   require-able desde Node.
   ===================================================================== */
(function(global){
  'use strict';
  const G = 9.80665;                       // gravedad estándar (m/s²)
  const DEG = 180/Math.PI;

  /* Filtro complementario para el ángulo de inclinación.
     Estado: lean (grados). update() mezcla:
       - leanGyro = lean + rollRate·dt            (integración del giroscopio)
       - leanAcc  = atan2(aLat, aVert)            (gravedad, solo si |a|≈1 g)
     alpha alto (0.98) = confía sobre todo en el giroscopio; el acelerómetro
     solo "ancla" para que no derive. gate = fracción de desvío de 1 g tolerada
     para fiarse del acelerómetro (en curva |a|>1 g => se ignora). */
  function createLeanFilter(opts){
    opts=opts||{};
    const alpha = opts.alpha!=null?opts.alpha:0.98;
    const gate  = opts.accelGateFrac!=null?opts.accelGateFrac:0.18;
    const g     = opts.g||G;
    let lean = 0, inited=false;
    return {
      get value(){ return lean; },
      reset(v){ lean = v||0; inited=false; },
      /* dt en s; rollRateDeg en grados/s; aLat/aVert en m/s² (marco moto);
         amag opcional = módulo del acelerómetro (si no, se usa hypot(aLat,aVert)). */
      update(dt, rollRateDeg, aLat, aVert, amag){
        if(!(dt>0)) return lean;
        const mag = amag!=null ? amag : Math.hypot(aLat, aVert);
        const leanGyro = lean + rollRateDeg*dt;
        if(mag>0 && Math.abs(mag-g)/g <= gate){
          const leanAcc = Math.atan2(aLat, aVert)*DEG;
          lean = inited ? (alpha*leanGyro + (1-alpha)*leanAcc) : leanAcc;
          inited = true;
        } else {
          lean = leanGyro;               // en curva: solo giroscopio
          inited = true;
        }
        return lean;
      }
    };
  }

  /* Fuerzas G en el marco de la moto, ya sin gravedad en el plano horizontal.
     aLat = aceleración lateral, aLon = longitudinal (acel/frenada), aVert con
     gravedad incluida. Devuelve múltiplos de g. */
  function gForces(aLat, aLon, aVert, g){
    g = g||G;
    return {
      lat: aLat/g,
      lon: aLon/g,
      // módulo horizontal (lo que "tira" al piloto en curva+frenada)
      horiz: Math.hypot(aLat, aLon)/g,
      vert: (aVert!=null? aVert/g : null),
    };
  }

  /* Corrección por ancho de neumático: el punto de contacto se desplaza al
     tumbar, así que el chasis (y el móvil) se inclina algo MÁS que la línea
     que une los contactos. Modelo simple y honesto: para un radio de sección
     de neumático r y una altura del centro de gravedad h, el ángulo real del
     conjunto es algo menor que el medido por el móvil fijado al chasis.
     Por defecto NO corrige (factor 1): no prometemos precisión que no tenemos.
     Si se pasa {tyreR, cogH}, aplica una reducción geométrica aproximada. */
  function tyreCorrect(leanDeg, opts){
    if(!opts || !opts.tyreR || !opts.cogH) return leanDeg;
    const k = Math.max(0, 1 - opts.tyreR/opts.cogH);   // 0..1
    return leanDeg * k;
  }

  /* Calibrador del soporte: acumula muestras con la moto RECTA y PARADA y
     calcula el sesgo del giroscopio y el vector gravedad en reposo (para
     resolver después el marco de la moto). */
  function makeCalibrator(){
    let n=0, g={x:0,y:0,z:0}, w={x:0,y:0,z:0};
    return {
      get count(){ return n; },
      add(s){ // s: {ax,ay,az, gx,gy,gz}
        n++;
        g.x+=s.ax||0; g.y+=s.ay||0; g.z+=s.az||0;
        w.x+=s.gx||0; w.y+=s.gy||0; w.z+=s.gz||0;
      },
      finish(){
        if(!n) return null;
        const grav={ x:g.x/n, y:g.y/n, z:g.z/n };
        const gyroBias={ x:w.x/n, y:w.y/n, z:w.z/n };
        const gmag=Math.hypot(grav.x,grav.y,grav.z)||G;
        return { n, grav, gyroBias, gmag,
                 up:{ x:grav.x/gmag, y:grav.y/gmag, z:grav.z/gmag } };
      }
    };
  }

  /* Seguimiento de máximos de una tanda/vuelta: inclinación por lado y G. */
  function makePeaks(){
    return { leanL:0, leanR:0, gHoriz:0, gLon:0,
      push(lean, g){
        if(lean<0) this.leanL=Math.max(this.leanL, -lean);
        else       this.leanR=Math.max(this.leanR,  lean);
        if(g){ if(g.horiz!=null) this.gHoriz=Math.max(this.gHoriz, g.horiz);
               if(g.lon!=null)   this.gLon=Math.max(this.gLon, Math.abs(g.lon)); }
      },
      reset(){ this.leanL=this.leanR=this.gHoriz=this.gLon=0; }
    };
  }

  const api={ G, createLeanFilter, gForces, tyreCorrect, makeCalibrator, makePeaks };
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  global.TrazzaSensors=api;
})(typeof self!=='undefined' ? self : globalThis);
