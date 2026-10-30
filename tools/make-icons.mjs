// Generates the PWA PNG icons (tachometer badge) with no dependencies.
// Usage: node tools/make-icons.mjs
import fs from 'fs';
import zlib from 'zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shade one sample in unit coords (0..1). Returns [r,g,b,a].
function shade(u, v, { maskable, rounded }) {
  const x = u - 0.5, y = v - 0.5;
  // background
  if (rounded) {
    const r = 0.2, ax = Math.abs(x) - (0.5 - r), ay = Math.abs(y) - (0.5 - r);
    if (ax > 0 && ay > 0 && ax * ax + ay * ay > r * r) return [0, 0, 0, 0];
  }
  const s = maskable ? 0.78 : 1;      // keep content in the maskable safe zone
  const X = x / s, Y = y / s, d = Math.hypot(X, Y);
  const glow = Math.max(0, 1 - Math.hypot(x, y + 0.25) * 1.6);
  let c = [12 + glow * 70, 12 + glow * 26, 14, 255];
  const ang = Math.atan2(Y, X);                  // -π..π, 0 = right, +π/2 = down
  let a = ang < 0 ? ang + Math.PI * 2 : ang;     // 0..2π
  // gauge sweeps from 135° (down-left) clockwise through top to 45° (down-right)
  let t = (a - Math.PI * 0.75) / (Math.PI * 1.5);
  if (t < 0) t += 4 / 3;
  const inSweep = t >= 0 && t <= 1;
  // bezel
  if (d > 0.4 && d < 0.43) c = [200, 200, 205, 255];
  // ring
  if (inSweep && d > 0.3 && d < 0.37) c = t > 0.8 ? [230, 25, 35, 255] : [235, 232, 225, 255];
  // ticks
  if (inSweep && d > 0.25 && d < 0.3) {
    const k = t * 8, f = Math.abs(k - Math.round(k));
    if (f < 0.07) c = t > 0.8 ? [230, 25, 35, 255] : [235, 232, 225, 255];
  }
  // needle at ~ 85% (near redline)
  const na = Math.PI * 0.75 + Math.PI * 1.5 * 0.86;
  const nx = Math.cos(na), ny = Math.sin(na);
  const along = X * nx + Y * ny, perp = Math.abs(-X * ny + Y * nx);
  if (along > -0.06 && along < 0.36 && perp < 0.022 * (1 - along * 1.2)) c = [255, 122, 0, 255];
  if (d < 0.065) c = [40, 40, 44, 255];
  if (d < 0.03) c = [255, 122, 0, 255];
  // "700" bar under centre: three chunky blocks
  if (Y > 0.14 && Y < 0.22 && Math.abs(X) < 0.16) {
    const bx = (X + 0.16) / 0.32 * 3, cell = Math.floor(bx), fx = bx - cell, fy = (Y - 0.14) / 0.08;
    // 7, 0, 0 as tiny segment glyphs
    let on = false;
    if (cell === 0) on = fy < 0.28 || (fx > 0.62 && fx < 0.88);
    else on = (fx > 0.12 && fx < 0.88) && (fy < 0.28 || fy > 0.72 || fx < 0.36 || fx > 0.64);
    if (on && fx > 0.1 && fx < 0.9) c = [255, 179, 71, 255];
  }
  return c;
}

function render(size, opts) {
  const ss = 4, buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const o = (py * size + px) * 4;
    buf[o] = a ? r / a : 0; buf[o + 1] = a ? g / a : 0; buf[o + 2] = a ? b / a : 0; buf[o + 3] = a / (ss * ss);
  }
  return png(size, size, buf);
}

const out = new URL('../icons/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(new URL('icon-192.png', out), render(192, { rounded: true }));
fs.writeFileSync(new URL('icon-512.png', out), render(512, { rounded: true }));
fs.writeFileSync(new URL('maskable-512.png', out), render(512, { maskable: true }));
fs.writeFileSync(new URL('apple-touch-icon.png', out), render(180, { maskable: true }));
console.log('icons written');
