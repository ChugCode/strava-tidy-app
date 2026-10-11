// Dependency-free PNG icon generator. Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [15, 23, 42], ACCENT = [59, 130, 246], WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Route polyline in unit coordinates (kept inside the maskable safe zone, central 80%).
const ROUTE = [[0.26, 0.68], [0.40, 0.42], [0.54, 0.58], [0.74, 0.30]];

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
const cov = (d, r) => Math.max(0, Math.min(1, r - d + 0.5)); // 1px antialias ramp

function render(size, { rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22, lineW = size * 0.055, dotR = size * 0.05;
  const pts = ROUTE.map(([x, y]) => [x * size, y * size]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let alpha = 1;
      if (rounded) {
        const qx = Math.max(Math.abs(cx - size / 2) - (size / 2 - radius), 0);
        const qy = Math.max(Math.abs(cy - size / 2) - (size / 2 - radius), 0);
        alpha = cov(Math.hypot(qx, qy), radius);
      }
      let col = BG;
      let d = Infinity;
      for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(cx, cy, pts[i - 1], pts[i]));
      const line = cov(d, lineW);
      if (line > 0) col = col.map((c, k) => c + (ACCENT[k] - c) * line);
      const dd = Math.hypot(cx - pts[pts.length - 1][0], cy - pts[pts.length - 1][1]);
      const dot = cov(dd, dotR);
      if (dot > 0) col = col.map((c, k) => c + (WHITE[k] - c) * dot);
      const o = (y * size + x) * 4;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

const dir = new URL('../icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(new URL(`icon-${size}.png`, dir), encodePng(size, render(size, { rounded: true })));
  writeFileSync(new URL(`maskable-${size}.png`, dir), encodePng(size, render(size, { rounded: false })));
}
writeFileSync(new URL('apple-touch-icon.png', dir), encodePng(180, render(180, { rounded: false })));
console.log('icons written');
