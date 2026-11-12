/* Genera los PNG del icono Trazza sin dependencias (solo zlib de Node).
   Rasteriza: fondo redondeado #0E0F12 + marca "trazada" blanca + ápice verde. */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const POLY = [[14,30],[50,104],[122,40],[116,46],[56,90],[40,26]]; // viewBox 128
const DOT = { cx:51, cy:99, r:13 };
const BG = [0x0E,0x0F,0x12], WHITE=[0xF5,0xF7,0xFA], GREEN=[0xB6,0xFF,0x1A];

function inPoly(x,y,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function inRoundRect(x,y,w,h,r){
  if(x<0||y<0||x>=w||y>=h) return false;
  const cx=Math.min(Math.max(x,r),w-r), cy=Math.min(Math.max(y,r),h-r);
  const dx=x-cx, dy=y-cy;
  return dx*dx+dy*dy <= r*r;
}

function sampleFg(x,y){ // x,y en espacio 128; devuelve color o null (transparente al fg)
  if(inPoly(x,y,POLY)) {
    const dx=x-DOT.cx, dy=y-DOT.cy;
    if(dx*dx+dy*dy<=DOT.r*DOT.r) return GREEN;
    return WHITE;
  }
  const dx=x-DOT.cx, dy=y-DOT.cy;
  if(dx*dx+dy*dy<=DOT.r*DOT.r) return GREEN;
  return null;
}

function render(size, maskable){
  const sf=size/512;
  const radius = (maskable?0:112)*sf;          // maskable: fondo cuadrado completo
  const pad = maskable?0.16:0;                  // zona segura maskable: marca más pequeña
  // transform de la marca: en icon.svg → translate(64,64) scale(3) sobre 512
  const scale = 3*sf*(1-pad*2*0);               // mantenemos escala base
  const offX = 64*sf + (maskable? size*pad*0.5 : 0);
  const offY = 64*sf + (maskable? size*pad*0.5 : 0);
  const fgScale = 3*sf*(maskable?0.78:1);
  const fgOff = maskable ? size*0.13 : 64*sf;

  const SS=3; // supersampling
  const buf=Buffer.alloc(size*size*4);
  for(let py=0;py<size;py++){
    for(let px=0;px<size;px++){
      let r=0,g=0,b=0,a=0;
      for(let sy=0;sy<SS;sy++) for(let sx=0;sx<SS;sx++){
        const fx=px+(sx+0.5)/SS, fy=py+(sy+0.5)/SS;
        // fondo
        let cr,cg,cb,ca;
        const bgIn = maskable ? true : inRoundRect(fx,fy,size,size,radius);
        if(bgIn){ cr=BG[0];cg=BG[1];cb=BG[2];ca=255; } else { cr=0;cg=0;cb=0;ca=0; }
        // marca
        const mx=(fx-fgOff)/fgScale, my=(fy-fgOff)/fgScale;
        const col=sampleFg(mx,my);
        if(col && ca===255){ cr=col[0];cg=col[1];cb=col[2]; }
        r+=cr;g+=cg;b+=cb;a+=ca;
      }
      const n=SS*SS, i=(py*size+px)*4;
      buf[i]=Math.round(r/n); buf[i+1]=Math.round(g/n); buf[i+2]=Math.round(b/n); buf[i+3]=Math.round(a/n);
    }
  }
  return buf;
}

/* ---- codificador PNG mínimo ---- */
function crc32(buf){
  let c=~0;
  for(let i=0;i<buf.length;i++){ c^=buf[i]; for(let k=0;k<8;k++) c = (c>>>1) ^ (0xEDB88320 & -(c&1)); }
  return ~c>>>0;
}
function chunk(type, data){
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length,0);
  const t=Buffer.from(type,'ascii');
  const crc=Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t,data])),0);
  return Buffer.concat([len,t,data,crc]);
}
function encodePNG(rgba, size){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const raw=Buffer.alloc(size*(size*4+1));
  for(let y=0;y<size;y++){ raw[y*(size*4+1)]=0; rgba.copy(raw, y*(size*4+1)+1, y*size*4, (y+1)*size*4); }
  const idat=zlib.deflateSync(raw,{level:9});
  return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
}

const out=__dirname;
const targets=[
  ['icon-192.png',192,false],
  ['icon-512.png',512,false],
  ['icon-180.png',180,false],
  ['icon-maskable-512.png',512,true],
];
for(const [name,size,mask] of targets){
  const png=encodePNG(render(size,mask), size);
  fs.writeFileSync(path.join(out,name), png);
  console.log('escrito', name, png.length, 'bytes');
}
