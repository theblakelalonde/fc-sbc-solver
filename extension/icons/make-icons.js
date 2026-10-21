// Draws the extension icons (16, 48, 128 px PNGs) with no dependencies: a green rounded square,
// a white card and a checkmark. Run from extension/: node icons/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 48, 128];
const SAMPLES = 4; // supersampling per axis (anti-aliasing)

const GREEN_TOP = [61, 220, 132];
const GREEN_BOTTOM = [28, 138, 81];
const WHITE = [255, 255, 255];
const CHECK = [24, 120, 70];

// Signed distance to a rounded rectangle centred at (cx, cy) with half-size (hx, hy), radius r.
function roundedRect(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance to a segment from (ax, ay) to (bx, by).
function segment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t);
}

// Colour (RGBA) at a point in unit coordinates, top-left (0, 0) to bottom-right (1, 1).
function shade(x, y) {
  if (roundedRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  const check = Math.min(segment(x, y, 0.36, 0.52, 0.47, 0.63), segment(x, y, 0.47, 0.63, 0.66, 0.39));
  if (check < 0.075) return [...CHECK, 255];
  if (roundedRect(x, y, 0.5, 0.5, 0.23, 0.34, 0.08) <= 0) return [...WHITE, 255];
  const g = GREEN_TOP.map((c, i) => Math.round(c + (GREEN_BOTTOM[i] - c) * y));
  return [...g, 255];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0, 0];
      for (let sj = 0; sj < SAMPLES; sj++) {
        for (let si = 0; si < SAMPLES; si++) {
          const [r, g, b, a] = shade((i + (si + 0.5) / SAMPLES) / size, (j + (sj + 0.5) / SAMPLES) / size);
          acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a;
        }
      }
      const o = (j * size + i) * 4;
      const n = SAMPLES * SAMPLES;
      px[o + 3] = Math.round(acc[3] / n);
      for (let c = 0; c < 3; c++) px[o + c] = acc[3] ? Math.round(acc[c] / acc[3]) : 0;
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) rgba.copy(rows, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const size of SIZES) {
  const file = path.join(__dirname, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log("wrote", file);
}
