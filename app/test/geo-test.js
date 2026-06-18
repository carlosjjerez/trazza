// Test aislado de la geometría de detección de meta (copiado de app.js)
const R=6378137;
function projFactory(lat0,lon0){const cos0=Math.cos(lat0*Math.PI/180);return{toXY(lat,lon){return{x:(lon-lon0)*Math.PI/180*R*cos0,y:(lat-lat0)*Math.PI/180*R};}};}
function buildGate(lat,lon,headingRad,width){const origin=projFactory(lat,lon);const hx=Math.sin(headingRad),hy=Math.cos(headingRad);const px=-hy,py=hx;const half=width/2;return{lat,lon,origin,width,hx,hy,ax:px*half,ay:py*half,bx:-px*half,by:-py*half};}
function gateCrossing(gate,p0,p1){const A={x:gate.ax,y:gate.ay},B={x:gate.bx,y:gate.by};const P=gate.origin.toXY(p0.lat,p0.lon);const Q=gate.origin.toXY(p1.lat,p1.lon);const mvx=Q.x-P.x,mvy=Q.y-P.y;if(mvx*gate.hx+mvy*gate.hy<=0)return null;const r={x:Q.x-P.x,y:Q.y-P.y};const s={x:B.x-A.x,y:B.y-A.y};const denom=r.x*s.y-r.y*s.x;if(Math.abs(denom)<1e-9)return null;const qp={x:A.x-P.x,y:A.y-P.y};const t=(qp.x*s.y-qp.y*s.x)/denom;const u=(qp.x*r.y-qp.y*r.x)/denom;if(t<0||t>=1||u<0||u>1)return null;return t;}

// metros -> desplazamiento en lat/lon alrededor de un origen
function offset(lat,lon,east,north){const dLat=north/R*180/Math.PI;const dLon=east/(R*Math.cos(lat*Math.PI/180))*180/Math.PI;return{lat:lat+dLat,lon:lon+dLon};}

const CLAT=37.6444,CLON=-1.0352;
let pass=0,fail=0;
function ok(name,cond){ if(cond){pass++;/*console.log('  ok',name)*/}else{fail++;console.log('  FAIL',name);} }

// CASO 1: meta orientada hacia el norte (heading=0). El piloto va hacia el norte y cruza.
// gate perpendicular = línea E-W. Punto antes a 5m sur, después 5m norte, centrado en X.
{
  const g=buildGate(CLAT,CLON,0,30);
  const p0={...offset(CLAT,CLON,0,-5),t:1000};
  const p1={...offset(CLAT,CLON,0,5),t:2000};
  const t=gateCrossing(g,p0,p1);
  ok('cruce N detectado', t!==null);
  ok('interpolación ~0.5', t!==null && Math.abs(t-0.5)<0.02);
  const crossT=p0.t+t*(p1.t-p0.t);
  ok('tiempo interpolado ~1500ms', Math.abs(crossT-1500)<40);
}

// CASO 2: sentido contrario (va hacia el sur) -> NO debe contar
{
  const g=buildGate(CLAT,CLON,0,30);
  const p0={...offset(CLAT,CLON,0,5),t:1000};
  const p1={...offset(CLAT,CLON,0,-5),t:2000};
  ok('sentido contrario ignorado', gateCrossing(g,p0,p1)===null);
}

// CASO 3: pasa por un lado fuera del ancho (a 30m al este, ancho 30 -> medio=15) -> no cuenta
{
  const g=buildGate(CLAT,CLON,0,30);
  const p0={...offset(CLAT,CLON,30,-5),t:1000};
  const p1={...offset(CLAT,CLON,30,5),t:2000};
  ok('fuera del ancho ignorado', gateCrossing(g,p0,p1)===null);
}

// CASO 4: dentro del ancho pero cerca del borde (12m este, medio=15) -> cuenta
{
  const g=buildGate(CLAT,CLON,0,30);
  const p0={...offset(CLAT,CLON,12,-5),t:1000};
  const p1={...offset(CLAT,CLON,12,5),t:2000};
  ok('borde dentro cuenta', gateCrossing(g,p0,p1)!==null);
}

// CASO 5: interpolación asimétrica (1m antes, 9m después) -> t pequeño
{
  const g=buildGate(CLAT,CLON,0,30);
  const p0={...offset(CLAT,CLON,0,-1),t:0};
  const p1={...offset(CLAT,CLON,0,9),t:1000};
  const t=gateCrossing(g,p0,p1);
  ok('interpolación asimétrica t~0.1', t!==null && Math.abs(t-0.1)<0.02);
}

// CASO 6: meta orientada al este (heading=90°), piloto va hacia el este
{
  const g=buildGate(CLAT,CLON,Math.PI/2,30);
  const p0={...offset(CLAT,CLON,-5,0),t:0};
  const p1={...offset(CLAT,CLON,5,0),t:1000};
  ok('cruce E detectado', gateCrossing(g,p0,p1)!==null);
  // ir al norte (paralelo a la línea de marcha? heading E, línea N-S) NO cruza la línea
  const q0={...offset(CLAT,CLON,0,-5),t:0}, q1={...offset(CLAT,CLON,0,5),t:1000};
  ok('paralelo no cruza', gateCrossing(g,q0,q1)===null);
}

// CASO 7: simulación de vuelta completa - varias muestras, un solo cruce
{
  const g=buildGate(CLAT,CLON,0,30);
  let crossings=0;
  // trayectoria sur->norte en pasos de ~3m/muestra de -9 a +9
  let prev=null;
  for(let n=-9;n<=9;n+=3){
    const p={...offset(CLAT,CLON,0,n),t:n*100};
    if(prev){ if(gateCrossing(g,prev,p)!==null) crossings++; }
    prev=p;
  }
  ok('un solo cruce en la pasada', crossings===1);
}

console.log(`\nGEO TESTS: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
