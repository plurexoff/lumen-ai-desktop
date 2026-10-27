// Generates build/icon.ico + public/icon.ico from the in-app workspace logo:
// a rounded tile with the 145deg #bea9f8 -> #7662c9 gradient and a bold white "L"
// (.workspace-logo in src/styles.css). Pure Node — no image dependencies.
// Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor for antialiasing

const cA = [0xbe, 0xa9, 0xf8]; // gradient start (top-left)
const cB = [0x76, 0x62, 0xc9]; // gradient end   (bottom-right)
const ANGLE = (145 * Math.PI) / 180; // CSS linear-gradient angle
const dx = Math.sin(ANGLE), dy = -Math.cos(ANGLE);
const range = Math.abs(dx) + Math.abs(dy);

function lerp(a, b, t) { return a + (b - a) * t; }

// Signed distance to a rounded box centered at (0,0) with half-size h and radius r.
function sdRoundBox(x, y, h, r) {
  const qx = Math.abs(x) - h + r, qy = Math.abs(y) - h + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const N = size * SS;
  const px = new Float64Array(size * size * 4);
  const radius = 0.29 * N;        // 8px on a 27px tile, like the UI
  const margin = 0;               // full-bleed tile
  const half = N / 2 - margin;

  // Bold "L" proportions relative to the tile side (matches 14px Manrope on 27px).
  const lh = 0.38 * N;            // glyph height
  const lw = 0.115 * N;           // stem thickness
  const gw = lw + 0.20 * N;       // total glyph width (stem + arm)
  const lx = (N - gw) / 2, ly = (N - lh) / 2;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = sdRoundBox(x - N / 2 + 0.5, y - N / 2 + 0.5, half, radius);
      if (d > 0.5) continue; // outside the tile
      // 145deg gradient projection, 0 = top-left (#bea9f8), 1 = bottom-right (#7662c9)
      const t = Math.min(1, Math.max(0, 0.5 + ((x + 0.5 - N / 2) * dx + (y + 0.5 - N / 2) * dy) / (range * N)));
      let r = lerp(cA[0], cB[0], t), g = lerp(cA[1], cB[1], t), b = lerp(cA[2], cB[2], t);
      // White "L": stem + bottom arm
      const inL = (x >= lx && x < lx + lw && y >= ly && y < ly + lh)
               || (x >= lx && x < lx + gw && y >= ly + lh - lw && y < ly + lh);
      if (inL) { r = g = b = 255; }
      const a = Math.min(1, Math.max(0, 0.5 - d));
      const o = (Math.floor(y / SS) * size + Math.floor(x / SS)) * 4;
      px[o] += r * a; px[o + 1] += g * a; px[o + 2] += b * a; px[o + 3] += 255 * a;
    }
  }
  // Box-downsample SSxSS -> 1
  const out = Buffer.alloc(size * size * 4);
  const div = SS * SS;
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.round(px[i * 4 + c] / div);
  }
  return out;
}

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function png(rgba, size) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((size) => png(render(size), size));
let offset = 6 + 16 * SIZES.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
const entries = SIZES.map((size, i) => {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size; e[1] = size === 256 ? 0 : size;
  e[4] = 1; e[5] = 0;                       // planes
  e.writeUInt16LE(32, 6);                   // bpp
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
const ico = Buffer.concat([header, ...entries, ...images]);

for (const rel of ['build/icon.ico', 'public/icon.ico']) {
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, ico);
  console.log(`${rel}  (${SIZES.join('/') } px, ${ico.length} bytes)`);
}
// Large PNG preview for manual inspection / future reuse.
writeFileSync(join(root, 'build/icon.png'), images[images.length - 1]);
console.log('build/icon.png (256 px preview)');
