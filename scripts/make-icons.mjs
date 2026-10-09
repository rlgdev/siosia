// Rasterises the Siosia icon (same geometry as public/icons/icon.svg) into the PWA PNGs without
// any image library: signed-distance shapes, 4×4 supersampling, PNG via zlib. Run: npm run icons
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x14, 0x16, 0x1a], WHITE = [255, 255, 255], GREEN = [0x3f, 0xbf, 0x8f];
const rad = (d) => (d * Math.PI) / 180;

// Arc distance in a 512-unit design space. Angles are math angles (y up), ranges inclusive.
function arcDist(px, py, cx, cy, r, from, to) {
  const dx = px - cx, dy = cy - py;
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const inRange = (x) => { for (const k of [-360, 0, 360]) if (x + k >= from && x + k <= to) return true; return false; };
  if (inRange(a)) return Math.abs(Math.hypot(dx, dy) - r);
  const e = (deg) => Math.hypot(px - (cx + r * Math.cos(rad(deg))), py - (cy - r * Math.sin(rad(deg))));
  return Math.min(e(from), e(to));
}

function sample(x, y, maskable) {
  // maskable: full-bleed background, artwork scaled into the 80% safe zone
  if (maskable) { x = 256 + (x - 256) / 0.8; y = 256 + (y - 256) / 0.8; }
  else {
    const r = 104, qx = Math.max(Math.abs(x - 256) - (256 - r), 0), qy = Math.max(Math.abs(y - 256) - (256 - r), 0);
    if (Math.hypot(qx, qy) > r) return null; // transparent corner
  }
  const s = Math.min(arcDist(x, y, 256, 184, 72, 20, 270), arcDist(x, y, 256, 328, 72, -160, 90));
  if (s <= 22) return WHITE;
  if (Math.hypot(x - 382, y - 398) <= 24) return GREEN;
  return BG;
}

function render(size, maskable) {
  const ss = 4, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) {
    raw[j * (size * 4 + 1)] = 0;
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
        const c = sample(((i + (si + 0.5) / ss) / size) * 512, ((j + (sj + 0.5) / ss) / size) * 512, maskable);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const o = j * (size * 4 + 1) + 1 + i * 4, n = ss * ss;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, raw);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

writeFileSync("public/icons/icon-192.png", render(192, false));
writeFileSync("public/icons/icon-512.png", render(512, false));
writeFileSync("public/icons/icon-maskable-512.png", render(512, true));
console.log("icons written");
