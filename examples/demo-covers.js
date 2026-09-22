"use strict";

// Dependency-free synthetic illustration generator. No remote imagery is used.
const { deflateSync } = require("node:zlib");
function png(name) {
  const width = 800, height = 600;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  const colors = { paper: [240, 232, 211], ink: [31, 51, 48], red: [208, 89, 57], blue: [66, 95, 148], pale: [196, 205, 196], white: [250, 247, 238] };
  const rgb = value => colors[value] || value;
  function pixel(x, y, color) { if (x < 0 || y < 0 || x >= width || y >= height) return; const p = y * (width * 3 + 1) + 1 + x * 3; const c = rgb(color); pixels[p] = c[0]; pixels[p+1] = c[1]; pixels[p+2] = c[2]; }
  function rect(x, y, w, h, color) { for (let j = y; j < y+h; j++) for (let i = x; i < x+w; i++) pixel(i, j, color); }
  function circle(x, y, r, color) { for (let j = y-r; j <= y+r; j++) for (let i = x-r; i <= x+r; i++) if ((i-x)**2+(j-y)**2 <= r*r) pixel(i, j, color); }
  rect(0, 0, width, height, "paper");
  if (name === "editorial") {
    rect(45, 42, 710, 516, "white"); rect(78, 76, 288, 12, "ink"); rect(78, 111, 205, 9, "ink");
    rect(78, 168, 290, 264, "blue"); circle(223, 300, 106, "paper"); rect(223, 194, 145, 238, "red");
    for(let n=0;n<10;n++) rect(408, 170+n*23, n%3===0?245:280, 5, "pale");
    for(let n=0;n<3;n++) rect(78, 478+n*18, 200-n*28, 5, "ink"); rect(408, 470, 280, 45, "ink");
  } else if (name === "chart") {
    rect(0,0,800,600,"ink"); for(let i=0;i<5;i++) rect(95,115+i*85,610,1,"pale");
    [120,185,140,260,320,380].forEach((v,i)=>rect(120+i*95,500-v,55,v,i===5?"red":"paper"));
    circle(645,90,22,"red");
  } else if (name === "materials" || name === "palette") {
    rect(0,0,800,600,"pale"); rect(52,55,310,480,"paper"); rect(402,55,345,205,"ink"); rect(402,298,155,237,"red"); rect(592,298,155,237,"blue");
    for(let i=0;i<18;i++) rect(74,90+i*23,255,1,[219,209,186]); circle(571,157,70,"pale");
  } else if (name === "space") {
    rect(0,0,800,600,[211,199,175]); rect(78,0,114,600,[238,226,204]); rect(613,0,105,600,[238,226,204]);
    circle(400,275,164,"ink"); rect(236,275,329,325,"ink"); circle(400,285,112,[163,179,175]); rect(288,285,225,315,[163,179,175]);
    for(let y=430;y<600;y++) rect(288-(y-430),y,225+(y-430)*2,1,[225,214,191]);
  } else if (name === "index") {
    rect(0,0,800,600,"blue"); for(let y=0;y<3;y++) for(let x=0;x<4;x++) { rect(60+x*175,55+y*170,145,140,"white"); circle(133+x*175,109+y*170,32,(x+y)%3===0?"red":"pale"); rect(81+x*175,163+y*170,101,5,"ink"); }
  } else {
    rect(0,0,800,600,"red"); circle(400,300,230,"paper"); circle(400,300,158,"ink"); circle(400,300,86,"red");
    for(let i=0;i<7;i++) rect(45+i*19,50,6,190,"paper"); rect(560,410,190,125,"ink");
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width,0); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR",header), chunk("IDAT",deflateSync(pixels)), chunk("IEND",Buffer.alloc(0))]);
}
function chunk(type, bytes) {
  const name=Buffer.from(type), data=Buffer.concat([name,bytes]), output=Buffer.alloc(bytes.length+12);
  output.writeUInt32BE(bytes.length); data.copy(output,4); let crc=0xffffffff;
  for(const byte of data) { crc ^= byte; for(let k=0;k<8;k++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  output.writeUInt32BE((crc^0xffffffff)>>>0,output.length-4); return output;
}
module.exports = { png };
