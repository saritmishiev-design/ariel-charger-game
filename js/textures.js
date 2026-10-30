// Procedural canvas textures: asphalt (colour/roughness/bump), grass, skid marks,
// grass tufts, billboards, car-paint flakes and the contact shadow.
import * as THREE from '../vendor/three.module.min.js';

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function toTexture(c, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/** Tileable value-noise fbm sampled on a w×h grid; returns Float32Array in 0..1. */
export function fbmField(w, h, rand, cells = 8, octaves = 4) {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = cells << o, cy = Math.max(1, Math.round(cells * h / w)) << o;
    const g = new Float32Array(cx * cy);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    for (let y = 0; y < h; y++) {
      const fy = y / h * cy, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      const y0 = iy % cy, y1 = (iy + 1) % cy;
      for (let x = 0; x < w; x++) {
        const fx = x / w * cx, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % cx, x1 = (ix + 1) % cx;
        const a = g[y0 * cx + x0], b = g[y0 * cx + x1], c = g[y1 * cx + x0], d = g[y1 * cx + x1];
        out[y * w + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Asphalt across the full road width (u = 0..1 edge to edge), tiling along v.
 * Returns { map, roughnessMap, bumpMap }.
 */
export function asphaltTextures(rand, size = 512) {
  const w = size, h = size;
  const col = canvas(w, h), rough = canvas(w, h), bump = canvas(w, h);
  const cc = col.getContext('2d'), rc = rough.getContext('2d'), bc = bump.getContext('2d');
  const ci = cc.createImageData(w, h), ri = rc.createImageData(w, h), bi = bc.createImageData(w, h);
  const blotch = fbmField(w, h, rand, 4, 4);
  const fine = fbmField(w, h, rand, 64, 2);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, u = x / w;
    const stone = rand();
    let v = 0.2 + (blotch[i] - 0.5) * 0.09 + (fine[i] - 0.5) * 0.08 + (stone - 0.5) * 0.11;
    if (stone > 0.985) v += 0.16;                     // bright aggregate chips
    if (stone < 0.02) v -= 0.06;
    // Rubbered-in wheel paths along the racing line
    const lane = Math.exp(-(((u - 0.32) / 0.06) ** 2)) + Math.exp(-(((u - 0.68) / 0.06) ** 2));
    v -= lane * 0.045 * (0.6 + blotch[i]);
    let r = 0.9 - lane * 0.12 + (stone - 0.5) * 0.12;
    const p = i * 4;
    const g = Math.max(0, Math.min(1, v)) * 255;
    ci.data[p] = g * 0.98; ci.data[p + 1] = g; ci.data[p + 2] = g * 1.04; ci.data[p + 3] = 255;
    ri.data[p] = ri.data[p + 1] = ri.data[p + 2] = Math.max(0, Math.min(1, r)) * 255; ri.data[p + 3] = 255;
    bi.data[p] = bi.data[p + 1] = bi.data[p + 2] = Math.max(0, Math.min(1, 0.5 + (stone - 0.5) * 0.6 + (fine[i] - 0.5) * 0.5)) * 255;
    bi.data[p + 3] = 255;
  }
  cc.putImageData(ci, 0, 0); rc.putImageData(ri, 0, 0); bc.putImageData(bi, 0, 0);

  // Repair patches and sealed cracks ("tar snakes": darker and glossier)
  for (let k = 0; k < 4; k++) {
    const px = (0.15 + rand() * 0.6) * w, py = rand() * h, pw = (0.08 + rand() * 0.2) * w, ph = (0.1 + rand() * 0.25) * h;
    const shade = rand() < 0.5 ? 'rgba(10,10,12,0.16)' : 'rgba(255,255,255,0.05)';
    for (const dy of [-h, 0, h]) { cc.fillStyle = shade; cc.fillRect(px, py + dy, pw, ph); }
  }
  for (let k = 0; k < 9; k++) {
    let x = rand() * w, y = rand() * h, a = rand() * Math.PI * 2;
    const pts = [[x, y]];
    for (let s = 0; s < 40; s++) { a += (rand() - 0.5) * 0.9; x += Math.cos(a) * 5; y += Math.sin(a) * 5; pts.push([x, y]); }
    for (const dy of [-h, 0, h]) {
      for (const [ctx, style, lw] of [[cc, 'rgba(8,8,9,0.55)', 2.2], [rc, 'rgba(175,175,175,0.9)', 2.6], [bc, 'rgba(80,80,80,0.8)', 2]]) {
        ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.lineJoin = 'round';
        ctx.beginPath(); pts.forEach(([px, py], n) => (n ? ctx.lineTo(px, py + dy) : ctx.moveTo(px, py + dy))); ctx.stroke();
      }
    }
  }

  // Worn white edge lines
  const line = Math.round(w * 0.014);
  for (const x0 of [line * 1.4, w - line * 2.4]) {
    for (let y = 0; y < h; y += 2) {
      cc.fillStyle = `rgba(236,236,228,${0.78 + rand() * 0.2})`;
      cc.fillRect(x0, y, line, 2);
      rc.fillStyle = 'rgba(150,150,150,1)'; rc.fillRect(x0, y, line, 2);
      bc.fillStyle = 'rgba(170,170,170,1)'; bc.fillRect(x0, y, line, 2);
    }
  }

  return {
    map: toTexture(col),
    roughnessMap: toTexture(rough, { srgb: false }),
    bumpMap: toTexture(bump, { srgb: false }),
  };
}

/** Pre-laid rubber from heavy braking: long dark streaks, alpha only. */
export function skidTexture(rand) {
  const w = 256, h = 1024, c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  for (let k = 0; k < 7; k++) {
    const lane = rand() < 0.5 ? 0.32 : 0.68;
    const x = (lane + (rand() - 0.5) * 0.18) * w, track = w * 0.12;
    const y0 = rand() * h * 0.5, len = h * (0.25 + rand() * 0.5), a = 0.18 + rand() * 0.3, drift = (rand() - 0.5) * 30;
    for (const off of [-track / 2, track / 2]) {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.25, `rgba(0,0,0,${a})`);
      g.addColorStop(0.85, `rgba(0,0,0,${a * 1.2})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 5 + rand() * 3;
      ctx.beginPath(); ctx.moveTo(x + off, y0);
      ctx.quadraticCurveTo(x + off + drift * 0.3, y0 + len / 2, x + off + drift, y0 + len); ctx.stroke();
    }
  }
  return toTexture(c);
}

export function grassTextures(rand) {
  const w = 512, h = 512, c = canvas(w, h), ctx = c.getContext('2d');
  const base = fbmField(w, h, rand, 8, 4);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = base[i], s = rand();
    img.data[i * 4] = 52 + n * 40 + s * 14;
    img.data[i * 4 + 1] = 86 + n * 52 + s * 18;
    img.data[i * 4 + 2] = 30 + n * 16;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Blades: thousands of short strokes in varied greens/straw, wrapped for tiling
  for (let i = 0; i < 22000; i++) {
    const x = rand() * w, y = rand() * h, len = 2 + rand() * 6, a = -Math.PI / 2 + (rand() - 0.5) * 1.1;
    const hue = 70 + rand() * 40, light = 18 + rand() * 26, sat = 35 + rand() * 30;
    ctx.strokeStyle = rand() < 0.06 ? `hsla(48,40%,${45 + rand() * 15}%,0.7)` : `hsla(${hue},${sat}%,${light}%,0.75)`;
    ctx.lineWidth = 0.8 + rand() * 0.8;
    for (const [ox, oy] of [[0, 0], [x > w - 8 ? -w : 0, y < 8 ? h : 0]]) {
      ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len); ctx.stroke();
    }
  }
  for (let i = 0; i < 260; i++) {   // soil specks and clover
    ctx.fillStyle = rand() < 0.6 ? 'rgba(80,62,40,0.5)' : 'rgba(150,170,80,0.5)';
    ctx.beginPath(); ctx.arc(rand() * w, rand() * h, 0.8 + rand() * 1.8, 0, 7); ctx.fill();
  }
  // Large-scale variation (sampled at a different scale in the ground shader)
  const mw = 256, macro = canvas(mw, mw), mctx = macro.getContext('2d');
  const mf = fbmField(mw, mw, rand, 4, 5), mimg = mctx.createImageData(mw, mw);
  for (let i = 0; i < mw * mw; i++) {
    const v = mf[i];
    mimg.data[i * 4] = 200 + (v - 0.5) * 160 + Math.max(0, v - 0.62) * 300;   // dry patches → warmer
    mimg.data[i * 4 + 1] = 210 + (v - 0.5) * 120;
    mimg.data[i * 4 + 2] = 190 + (v - 0.5) * 60;
    mimg.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(mimg, 0, 0);
  return { map: toTexture(c), macro: toTexture(macro, { srgb: false }) };
}

/** Alpha-tested blades for 3D grass tufts. */
export function tuftTexture(rand) {
  const w = 128, h = 128, c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    const x = 8 + rand() * (w - 16), top = 10 + rand() * 70, bend = (rand() - 0.5) * 40;
    const g = ctx.createLinearGradient(0, h, 0, top);
    g.addColorStop(0, 'hsl(95,40%,22%)'); g.addColorStop(1, `hsl(${75 + rand() * 25},${45 + rand() * 20}%,${38 + rand() * 18}%)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x - 2.5, h); ctx.quadraticCurveTo(x + bend * 0.4, (h + top) / 2, x + bend, top);
    ctx.quadraticCurveTo(x + bend * 0.4 + 1, (h + top) / 2, x + 2.5, h); ctx.fill();
  }
  return toTexture(c, { aniso: 2 });
}

function heartPath(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.35);
  ctx.bezierCurveTo(cx - s * 0.05, cy + s * 0.3, cx - s * 0.55, cy - s * 0.05, cx - s * 0.5, cy - s * 0.3);
  ctx.bezierCurveTo(cx - s * 0.45, cy - s * 0.6, cx - s * 0.05, cy - s * 0.6, cx, cy - s * 0.32);
  ctx.bezierCurveTo(cx + s * 0.05, cy - s * 0.6, cx + s * 0.45, cy - s * 0.6, cx + s * 0.5, cy - s * 0.3);
  ctx.bezierCurveTo(cx + s * 0.55, cy - s * 0.05, cx + s * 0.05, cy + s * 0.3, cx, cy + s * 0.35);
  ctx.closePath();
}

export function heartShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.35);
  s.bezierCurveTo(-0.05, -0.3, -0.55, 0.05, -0.5, 0.3);
  s.bezierCurveTo(-0.45, 0.6, -0.05, 0.6, 0, 0.32);
  s.bezierCurveTo(0.05, 0.6, 0.45, 0.6, 0.5, 0.3);
  s.bezierCurveTo(0.55, 0.05, 0.05, -0.3, 0, -0.35);
  return s;
}

function fitText(ctx, text, maxW, size, font) {
  let s = size;
  do { ctx.font = `${font} ${s}px Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 10);
}

/** 1024×384 billboard faces. kind: 'sentra' | 'sarit' */
export function billboardTexture(kind) {
  const w = 1024, h = 384, c = canvas(w, h), ctx = c.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (kind === 'sentra') {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#111114'); g.addColorStop(1, '#2a1406');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff7a00'; ctx.fillRect(0, 0, w, 16); ctx.fillRect(0, h - 16, w, 16);
    // racing stripes
    ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = '#ff7a00';
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(w - 330 + i * 60, 16); ctx.lineTo(w - 290 + i * 60, 16); ctx.lineTo(w - 420 + i * 60, h - 16); ctx.lineTo(w - 460 + i * 60, h - 16); ctx.fill(); }
    ctx.restore();
    fitText(ctx, 'ENJOY THE 700HP!', w - 80, 128, 'italic 900');
    const tg = ctx.createLinearGradient(0, 40, 0, 170);
    tg.addColorStop(0, '#ffe0a8'); tg.addColorStop(0.55, '#ff8a1a'); tg.addColorStop(1, '#c84800');
    ctx.fillStyle = tg; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 5;
    ctx.fillText('ENJOY THE 700HP!', w / 2, 112);
    ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#f4f1ea';
    fitText(ctx, 'But don\'t forget you drive a', w - 120, 54, '700');
    ctx.fillText('But don\'t forget you drive a', w / 2, 232);
    fitText(ctx, 'Nissan Sentra in real life.', w - 120, 62, '900');
    ctx.fillStyle = '#ffd08a';
    ctx.fillText('Nissan Sentra in real life.', w / 2, 300);
  } else {
    const g = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, w * 0.6);
    g.addColorStop(0, '#ff5c8a'); g.addColorStop(1, '#a3123f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.16; ctx.fillStyle = '#fff';
    const r = rng(14);
    for (let i = 0; i < 26; i++) { heartPath(ctx, r() * w, r() * h, 30 + r() * 60); ctx.fill(); }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 10; ctx.strokeRect(18, 18, w - 36, h - 36);
    ctx.shadowColor = 'rgba(80,0,20,0.6)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#fff';
    fitText(ctx, 'Love, your wife', w - 140, 92, 'italic 700');
    ctx.fillText('Love, your wife', w / 2, 120);
    fitText(ctx, 'Sarit', 600, 176, 'italic 900');
    const tw = ctx.measureText('Sarit').width;
    ctx.fillText('Sarit', w / 2 - 70, 262);
    ctx.fillStyle = '#ffe3ea';
    heartPath(ctx, w / 2 - 70 + tw / 2 + 110, 262, 170); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#e8143f';
    heartPath(ctx, w / 2 - 70 + tw / 2 + 110, 264, 140); ctx.fill();
  }
  const t = toTexture(c, { aniso: 8 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Tangent-space normal noise for metallic flake sparkle under the clear coat. */
export function flakeNormalMap(rand) {
  const s = 256, c = canvas(s, s), ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const a = rand() * Math.PI * 2, m = rand() * 0.6;
    img.data[i * 4] = 128 + Math.cos(a) * m * 127;
    img.data[i * 4 + 1] = 128 + Math.sin(a) * m * 127;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false, repeat: [6, 6] });
}

/** Soft ambient-occlusion blob for under the car. */
export function contactShadowTexture() {
  const w = 128, h = 256, c = canvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.filter = 'blur(10px)';
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(24, 22, w - 48, h - 44, 30); else ctx.rect(24, 22, w - 48, h - 44);
  ctx.fill();
  ctx.filter = 'none';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
