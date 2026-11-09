// Procedural bodies for the modern cars (Nissan GT-R R35, 2023 Nissan Sentra): lofted shells with
// lights, grilles and trim, plus the extrusion helper the Charger's slab-sided body uses.
// Heights are above the ground; z runs from the nose (zF) back to the tail (zR).
import * as THREE from '../vendor/three.module.min.js';

export function extrudeProfile(points, depth, bevel) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.arc) shape.absarc(p.arc[0], p.arc[1], p.arc[2], Math.PI, 0, true);
    else shape.lineTo(p[0], p[1]);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 3, curveSegments: 18,
  });
  geo.translate(0, 0, -(depth - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2);   // shape X → car Z, extrusion → car X
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ lofted bodies
// The modern cars are lofted: a cross-section is defined at a handful of key stations along the
// car (heights above the ground, half-widths), interpolated smoothly every 4 cm and skinned. That
// gives rounded shoulders, tumblehome, a tapered nose and tail and fender bulges. Wheel arches are
// cut by raising the section's bottom edge around each wheel; a dark open tube is the wheel well.

/** Catmull-Rom through key values ks (sorted by k[0]) at position x, for field f. */
function interp(keys, x, f) {
  let i = 0;
  while (i < keys.length - 2 && x > keys[i + 1].u) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const t = Math.min(1, Math.max(0, (x - k1.u) / (k2.u - k1.u)));
  const p0 = k0[f], p1 = k1[f], p2 = k2[f], p3 = k3[f];
  // Catmull-Rom, then clamped between the two neighbours so it never overshoots
  const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  return Math.min(Math.max(p1, p2), Math.max(Math.min(p1, p2), v));
}

/**
 * Skin rings of [x, y] (right half, bottom centre → top centre; mirrored for the left) taken at
 * chassis z positions. matFor(segment, ringEdge) picks a material key per quad.
 * Returns { key: BufferGeometry }.
 */
function skin(rings, zs, matFor, caps = true) {
  const half = rings[0].length, M = half * 2 - 2;          // full ring (centres not duplicated)
  const full = rings.map(r => [...r, ...r.slice(1, -1).reverse().map(([x, y]) => [-x, y])]);
  const pos = [];
  full.forEach((ring, i) => ring.forEach(([x, y]) => pos.push(x, y, zs[i])));
  const idx = {};
  const push = (key, ...v) => (idx[key] || (idx[key] = [])).push(...v);
  for (let i = 0; i < full.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + (j + 1) % M, c = (i + 1) * M + j, d = (i + 1) * M + (j + 1) % M;
      const edge = j < half - 1 ? j : M - 1 - j;          // mirror edge index for the left side
      push(matFor(i, edge), a, b, c, b, d, c);
    }
  }
  const out = {};
  const geoFor = (list, extra = []) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos.concat(extra), 3));
    g.setIndex(list);
    g.computeVertexNormals();
    return g;
  };
  for (const [key, list] of Object.entries(idx)) out[key] = geoFor(list);
  if (caps) {
    // Flat end caps (nose and tail faces): fan from each end ring's centre
    const n0 = pos.length / 3, extra = [];
    const capIdx = [];
    [[0, 1], [full.length - 1, -1]].forEach(([i, dir], c) => {
      const ring = full[i];
      const cx = 0, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      extra.push(cx, cy, zs[i]);
      const ci = n0 + c;
      for (let j = 0; j < M; j++) {
        const a = i * M + j, b = i * M + (j + 1) % M;
        if (dir > 0) capIdx.push(ci, a, b); else capIdx.push(ci, b, a);
      }
    });
    out.cap = geoFor(capIdx, extra);
  }
  return out;
}

/**
 * Body shell: keys = [{ u, yb, ys, yt, yc, wb, ws, wt }] (u = metres behind the front axle; bottom,
 * shoulder (widest) and top-edge heights, top-centre crown; half-widths at the bottom, shoulder
 * and top edge). arches = [[u, radius]].
 */
function loftBody({ keys, arches, Y, zf, hub, step = 0.04 }) {
  const u0 = keys[0].u, u1 = keys[keys.length - 1].u;
  const rings = [], zs = [];
  for (let k = 0; ; k++) {
    const uu = Math.min(u1, u0 + k * step);
    const f = (n) => interp(keys, uu, n);
    let yb = f('yb'), ys = f('ys');
    const yt = f('yt'), yc = f('yc'), wb = f('wb'), ws = f('ws'), wt = f('wt');
    for (const [au, R] of arches) {
      const d = uu - au;
      if (Math.abs(d) < R) yb = Math.max(yb, hub + Math.sqrt(R * R - d * d));
    }
    ys = Math.max(ys, yb + 0.06);
    const yr = Math.min(ys - 0.03, yb + 0.12);
    rings.push([
      [0, yb], [wb - 0.05, yb], [wb, yb + 0.035], [wb + (ws - wb) * 0.8, yr], [ws, ys],
      [ws - (ws - wt) * 0.35, ys + (yt - ys) * 0.55], [ws - (ws - wt) * 0.75, yt - 0.012], [wt, yt],
      [wt * 0.55, yt + (yc - yt) * 0.75], [0, yc],
    ].map(([x, y]) => [x, Y(y)]));
    zs.push(zf + uu);
    if (uu >= u1) break;
  }
  // Rocker (the lowest band) in black plastic, the rest in paint
  return skin(rings, zs, (i, e) => (e <= 1 ? 'trim' : 'paint'));
}

/**
 * Greenhouse: keys = [{ u, yb, yt, yc, wb, wt }]. The roof between roofU, the pillars and rails are
 * paint; side windows and screens glass; the C-pillar zone (side, u > cpU) uses cpMat.
 */
function loftCabin({ keys, Y, zf, roof: [r0, r1], cpU, bU, step = 0.04 }) {
  const u0 = keys[0].u, u1 = keys[keys.length - 1].u;
  const rings = [], zs = [], us = [];
  for (let k = 0; ; k++) {
    const uu = Math.min(u1, u0 + k * step);
    const f = (n) => interp(keys, uu, n);
    const yb = f('yb'), yt = Math.max(yb + 0.005, f('yt')), yc = Math.max(yt, f('yc')), wb = f('wb'), wt = f('wt');
    const bulge = 0.02 * Math.min(1, (yt - yb) / 0.3);
    rings.push([
      [0, yb - 0.03], [wb, yb - 0.03], [wb, yb], [(wb + wt) / 2 + bulge, yb + (yt - yb) * 0.55],
      [wt + 0.012, yt - Math.min(0.03, (yt - yb) * 0.15)], [wt, yt], [wt * 0.5, yt + (yc - yt) * 0.8], [0, yc],
    ].map(([x, y]) => [x, Y(y)]));
    zs.push(zf + uu); us.push(uu);
    if (uu >= u1) break;
  }
  return skin(rings, zs, (i, e) => {
    const uu = (us[i] + us[i + 1]) / 2;
    if (e <= 1) return 'paint';                                   // hidden base
    if (e === 4) return 'paint';                                  // A-pillar → roof rail → C-pillar edge
    if (e >= 5) return uu > r0 && uu < r1 ? 'paint' : 'glass';    // roof panel vs screens
    if (uu > cpU) return 'cpillar';
    if (Math.abs(uu - bU) < 0.05) return 'bpillar';
    return 'glass';                                               // side windows
  }, false);
}

/** Canvas texture for grille meshes: 'honeycomb' or 'bars'. */
export function grilleTexture(kind, color = '#9aa0a8') {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#050506'; g.fillRect(0, 0, S, S);
  g.strokeStyle = color; g.lineWidth = kind === 'bars' ? 5 : 3;
  if (kind === 'bars') for (let y = 8; y < S; y += 21) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
  else {
    const r = 11;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 7; col++) {
      const x = col * r * 1.75 + (row % 2) * r * 0.87, y = row * r * 1.5;
      g.beginPath();
      for (let k = 0; k <= 6; k++) { const a = Math.PI / 3 * k + Math.PI / 6; g.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9); }
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function addLoft(add, parts, mats) {
  const meshes = [];
  for (const [key, geo] of Object.entries(parts)) {
    const m = add(geo, mats[key] || mats.paint);
    if (mats[key] && mats[key].transparent) m.renderOrder = 2;
    meshes.push(m);
  }
  return meshes;
}

/** Light cluster: dark housing with bright emitters set into it, facing along `dir` (z sign). */
function lamp(add, mat, housing, { x, y, z, w, h, d = 0.05, ry = 0, rx = 0, rz = 0 }) {
  const hs = add(new THREE.BoxGeometry(w + 0.02, h + 0.02, d), housing, x, y, z, false);
  const em = add(new THREE.BoxGeometry(w, h, d + 0.012), mat, x, y, z, false);
  for (const m of [hs, em]) m.rotation.set(rx, ry, rz);
  return em;
}

// ------------------------------------------------------------------ Nissan GT-R (R35), tuned
export const GTR_RIM = { spokes: 6, split: true, spokeW: 0.035, spokeT: 0.03, color: 0x34363b, rough: 0.28, cap: 0x111111, rimK: 0.74, caliper: 0xd4a017 };

export function buildGTR(c) {
  const { add, Y, spec, zf, zr, zF, zR, paint, black, glass, trim, tailMat, reverseMat, headMat, interior, envMap } = c;
  const u = (d) => zf + d;              // distance behind the front axle → chassis z
  const L = spec.wheelbase, hub = spec.wheelRadius, W = spec.width / 2;
  const uF = zF - zf, uR = zR - zf;
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMap });
  const titanium = new THREE.MeshStandardMaterial({ color: 0x8a7f9a, metalness: 1, roughness: 0.25, envMap });
  const housing = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.8, roughness: 0.3, envMap });
  const grille = new THREE.MeshStandardMaterial({ map: grilleTexture('honeycomb', '#7d838c'), metalness: 0.6, roughness: 0.4, envMap });
  grille.map.repeat.set(4, 1.4);
  const mats = { paint, trim: carbon, cap: paint, glass, cpillar: paint, bpillar: black };

  // Body: low wide nose, fender humps either side of a lower bonnet, flat flanks, high hips, ducktail
  const B = (uu, yb, ys, yt, yc, wb, ws, wt) => ({ u: uu, yb, ys, yt, yc, wb: wb * W, ws: ws * W, wt: wt * W });
  addLoft(add, loftBody({
    Y, zf, hub, arches: [[0, 0.44], [L, 0.44]], keys: [
      B(uF, 0.27, 0.46, 0.6, 0.62, 0.84, 0.88, 0.64),
      B(uF + 0.07, 0.2, 0.5, 0.67, 0.69, 0.9, 0.95, 0.74),
      B(uF + 0.4, 0.19, 0.6, 0.77, 0.76, 0.95, 0.995, 0.8),
      B(0, 0.19, 0.67, 0.86, 0.82, 0.96, 1.0, 0.8),
      B(0.55, 0.19, 0.72, 0.92, 0.91, 0.97, 0.995, 0.76),
      B(1.5, 0.19, 0.74, 0.96, 0.96, 0.97, 0.985, 0.74),
      B(2.35, 0.2, 0.77, 0.99, 0.99, 0.97, 1.0, 0.77),
      B(L, 0.2, 0.78, 1.0, 1.0, 0.97, 1.0, 0.78),
      B(uR - 0.3, 0.24, 0.8, 1.02, 1.03, 0.93, 0.97, 0.75),
      B(uR - 0.05, 0.28, 0.79, 1.045, 1.05, 0.86, 0.92, 0.7),
      B(uR, 0.36, 0.74, 1.0, 1.0, 0.8, 0.85, 0.64),
    ],
  }), mats);
  // Greenhouse: steep screen, long flat roof, the R35's thick kinked C-pillar ("shark fin")
  const G = (uu, yb, yt, yc, wb, wt) => ({ u: uu, yb, yt, yc, wb, wt });
  addLoft(add, loftCabin({
    Y, zf, roof: [1.22, 2.08], cpU: 2.12, bU: 1.62, keys: [
      G(0.5, 0.915, 0.92, 0.92, 0.72, 0.7), G(0.9, 0.935, 1.17, 1.19, 0.73, 0.62), G(1.27, 0.95, 1.335, 1.365, 0.73, 0.57),
      G(2.0, 0.97, 1.335, 1.36, 0.74, 0.57), G(2.6, 0.985, 1.2, 1.22, 0.74, 0.62), G(3.3, 1.01, 1.02, 1.03, 0.69, 0.66),
    ],
  }), mats);

  // Hood: two creases running back from the headlights, centre vents
  for (const s of [-1, 1]) {
    const cr = add(new THREE.BoxGeometry(0.02, 0.02, 1.2), paint, s * 0.42, Y(0.84), u(-0.3));
    cr.rotation.x = -0.09;
    add(new THREE.BoxGeometry(0.16, 0.012, 0.28), black, s * 0.2, Y(0.86), u(0.15), false);
  }

  // Front: the big trapezoid grille, chrome surround, side intakes, splitter, boomerang LED lights
  const nose = zF - 0.004;
  add(new THREE.BoxGeometry(0.84, 0.22, 0.03), grille, 0, Y(0.43), nose, false);
  add(new THREE.BoxGeometry(0.9, 0.025, 0.04), titanium, 0, Y(0.555), nose, false);
  for (const s of [-1, 1]) {
    const side = add(new THREE.BoxGeometry(0.025, 0.24, 0.04), titanium, s * 0.44, Y(0.43), nose, false);
    side.rotation.z = s * 0.25;
    add(new THREE.BoxGeometry(0.22, 0.13, 0.03), grille, s * 0.6, Y(0.36), zF + 0.03, false);           // side intakes
    // Headlight: long boomerang running up the fender, three LED "lightning" blades
    const hl = lamp(add, headMat, housing, { x: s * 0.58, y: Y(0.63), z: zF + 0.13, w: 0.36, h: 0.06, d: 0.12, ry: s * 0.4, rx: -0.25 });
    for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.012, 0.05, 0.05), headMat, s * (0.5 + k * 0.06), Y(0.625), zF + 0.08 + k * 0.03, false);
    add(new THREE.BoxGeometry(0.03, 0.14, 0.02), headMat, s * 0.36, Y(0.4), nose, false);                // DRL strip
    hl.castShadow = false;
    // Fender vent behind the front wheel, mirrors, flush door handle, side skirt
    for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.012, 0.022, 0.26 - k * 0.04), black, s * (W - 0.005), Y(0.74 - k * 0.045), zf + 0.6, false);
    const mir = add(new THREE.BoxGeometry(0.1, 0.075, 0.17), paint, s * 0.95, Y(1.0), u(0.78));
    mir.rotation.y = s * 0.25;
    add(new THREE.BoxGeometry(0.012, 0.025, 0.16), titanium, s * (W - 0.003), Y(0.9), u(1.85), false);
  }
  add(new THREE.BoxGeometry(W * 2 - 0.2, 0.035, 0.24), carbon, 0, Y(0.2), zF + 0.08);

  // Rear: four round tail lights, diffuser, quad titanium exhaust, carbon wing
  const tail = zR + 0.004;
  const ring = new THREE.RingGeometry(0.06, 0.095, 24), lens = new THREE.MeshPhysicalMaterial({ color: 0x220000, roughness: 0.2, clearcoat: 1, envMap });
  for (const x of [-0.6, -0.39, 0.39, 0.6]) {
    add(ring, tailMat, x, Y(0.87), tail + 0.002, false);
    add(new THREE.CircleGeometry(0.06, 20), lens, x, Y(0.87), tail + 0.001, false);
  }
  add(new THREE.BoxGeometry(0.16, 0.04, 0.02), reverseMat, 0, Y(0.66), tail, false);
  add(new THREE.BoxGeometry(0.42, 0.13, 0.015), black, 0, Y(0.62), tail, false);                       // plate recess
  add(new THREE.BoxGeometry(W * 2 - 0.3, 0.15, 0.14), carbon, 0, Y(0.31), zR - 0.04);
  for (let k = -3; k <= 3; k++) add(new THREE.BoxGeometry(0.015, 0.11, 0.24), carbon, k * 0.13, Y(0.27), zR - 0.06, false);
  const exhausts = [];
  for (const x of [-0.62, -0.47, 0.47, 0.62]) {
    const tip = add(new THREE.CylinderGeometry(0.046, 0.046, 0.2, 14), titanium, x, Y(0.31), zR - 0.04, false);
    tip.rotation.x = Math.PI / 2;
    add(new THREE.CircleGeometry(0.036, 12), new THREE.MeshBasicMaterial({ color: 0x050505 }), x, Y(0.31), zR + 0.062, false);
    exhausts.push([x, 0.31, zR + 0.07]);
  }
  add(new THREE.BoxGeometry(1.6, 0.022, 0.3), carbon, 0, Y(1.27), zR - 0.28);                           // wing
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.02, 0.2, 0.32), carbon, s * 0.8, Y(1.24), zR - 0.28);
    add(new THREE.BoxGeometry(0.04, 0.24, 0.08), carbon, s * 0.5, Y(1.15), zR - 0.26);
  }

  cabin(interior, trim, Y, u, { seatU: 1.95, dashU: 0.8, wheelU: 1.45, seatX: 0.37, hip: 0.5 });
  return { exhausts, rim: GTR_RIM, arch: 0.44 };
}

// ------------------------------------------------------------------ 2023 Nissan Sentra SV
export const SENTRA_RIM = { spokes: 5, split: true, spokeW: 0.04, spokeT: 0.025, color: 0xc9ccd1, rough: 0.2, cap: 0x2a2c30, rimK: 0.62 };

export function buildSentra(c) {
  const { add, Y, spec, zf, zr, zF, zR, paint, chrome, black, glass, trim, tailMat, reverseMat, headMat, interior, envMap } = c;
  const u = (d) => zf + d;
  const L = spec.wheelbase, hub = spec.wheelRadius, W = spec.width / 2;
  const uF = zF - zf, uR = zR - zf;
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.1, clearcoat: 1, envMap });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.7, envMap });
  const housing = new THREE.MeshStandardMaterial({ color: 0x1b1d21, metalness: 0.7, roughness: 0.3, envMap });
  const grille = new THREE.MeshStandardMaterial({ map: grilleTexture('honeycomb', '#3a3e45'), metalness: 0.4, roughness: 0.45, envMap });
  grille.map.repeat.set(5, 1.6);
  const mats = { paint, trim: plastic, cap: paint, glass, cpillar: gloss, bpillar: gloss };

  // Body: tall blunt nose, short hood rising to the screen, a crisp shoulder line, high deck
  const B = (uu, yb, ys, yt, yc, wb, ws, wt) => ({ u: uu, yb, ys, yt, yc, wb: wb * W, ws: ws * W, wt: wt * W });
  addLoft(add, loftBody({
    Y, zf, hub, arches: [[0, 0.42], [L, 0.42]], keys: [
      B(uF, 0.3, 0.55, 0.74, 0.76, 0.86, 0.9, 0.66),
      B(uF + 0.07, 0.25, 0.6, 0.8, 0.82, 0.92, 0.96, 0.74),
      B(uF + 0.45, 0.24, 0.7, 0.88, 0.9, 0.96, 0.995, 0.8),
      B(0, 0.24, 0.75, 0.93, 0.94, 0.97, 1.0, 0.82),
      B(0.62, 0.24, 0.81, 0.99, 1.0, 0.97, 1.0, 0.82),
      B(1.6, 0.25, 0.84, 1.02, 1.03, 0.97, 0.995, 0.81),
      B(L, 0.25, 0.87, 1.06, 1.07, 0.97, 1.0, 0.83),
      B(uR - 0.3, 0.27, 0.89, 1.08, 1.1, 0.95, 0.99, 0.81),
      B(uR - 0.04, 0.32, 0.87, 1.08, 1.1, 0.88, 0.93, 0.76),
      B(uR, 0.44, 0.82, 1.04, 1.05, 0.8, 0.86, 0.68),
    ],
  }), mats);
  const G = (uu, yb, yt, yc, wb, wt) => ({ u: uu, yb, yt, yc, wb, wt });
  addLoft(add, loftCabin({
    Y, zf, roof: [1.38, 2.36], cpU: 2.45, bU: 1.88, keys: [
      G(0.56, 0.985, 0.99, 0.99, 0.74, 0.72), G(1.0, 1.0, 1.24, 1.26, 0.75, 0.65), G(1.42, 1.01, 1.42, 1.45, 0.75, 0.6),
      G(2.3, 1.035, 1.42, 1.45, 0.76, 0.6), G(2.75, 1.05, 1.28, 1.3, 0.76, 0.64), G(3.14, 1.07, 1.075, 1.08, 0.72, 0.68),
    ],
  }), mats);
  // Chrome beltline and window surround (the SV's chrome trim)
  for (const s of [-1, 1]) {
    const bl = add(new THREE.BoxGeometry(0.012, 0.015, 1.95), chrome, s * 0.765, Y(1.02), u(1.75), false);
    bl.rotation.x = -0.012;
  }

  // Front: big V-motion grille — honeycomb mesh framed by a chrome V — slim LED headlights
  const nose = zF - 0.004;
  add(new THREE.BoxGeometry(0.82, 0.24, 0.03), grille, 0, Y(0.53), nose, false);
  add(new THREE.BoxGeometry(0.5, 0.06, 0.03), gloss, 0, Y(0.36), nose, false);                        // lower intake
  for (const s of [-1, 1]) {
    const v = add(new THREE.BoxGeometry(0.46, 0.035, 0.04), chrome, s * 0.2, Y(0.46), nose - 0.006, false);
    v.rotation.z = s * 0.45;
    add(new THREE.BoxGeometry(0.03, 0.18, 0.04), chrome, s * 0.41, Y(0.57), nose - 0.006, false);
    lamp(add, headMat, housing, { x: s * 0.58, y: Y(0.74), z: zF + 0.11, w: 0.38, h: 0.055, d: 0.1, ry: s * 0.32, rx: -0.15, rz: s * -0.08 });
    add(new THREE.BoxGeometry(0.2, 0.02, 0.02), headMat, s * 0.58, Y(0.72), nose + 0.02, false);         // DRL
    add(new THREE.BoxGeometry(0.16, 0.08, 0.03), gloss, s * 0.6, Y(0.38), nose + 0.03, false);           // fog-light pods
    const mir = add(new THREE.BoxGeometry(0.1, 0.09, 0.15), gloss, s * 0.94, Y(1.06), u(0.86));
    mir.rotation.y = s * 0.22;
    for (const du of [1.35, 2.2]) add(new THREE.BoxGeometry(0.012, 0.03, 0.15), chrome, s * (W - 0.008), Y(0.93), u(du), false);
  }
  add(new THREE.BoxGeometry(W * 2 - 0.35, 0.06, 0.12), plastic, 0, Y(0.27), zF + 0.08);

  // Rear: wide boomerang tail lights across the deck lid, chrome strip, plate, hidden exhaust
  const tail = zR + 0.004;
  for (const s of [-1, 1]) {
    lamp(add, tailMat, housing, { x: s * 0.52, y: Y(0.93), z: tail - 0.01, w: 0.4, h: 0.075, d: 0.03 });
    const lo = add(new THREE.BoxGeometry(0.2, 0.045, 0.03), tailMat, s * 0.73, Y(0.87), zR - 0.01, false);
    lo.rotation.z = s * 0.45;
  }
  add(new THREE.BoxGeometry(0.66, 0.022, 0.025), chrome, 0, Y(0.95), tail, false);
  add(new THREE.BoxGeometry(0.5, 0.18, 0.015), black, 0, Y(0.7), tail, false);
  add(new THREE.BoxGeometry(0.12, 0.045, 0.02), reverseMat, 0, Y(0.56), tail, false);
  add(new THREE.BoxGeometry(W * 2 - 0.4, 0.09, 0.12), plastic, 0, Y(0.36), zR - 0.04);
  const tip = add(new THREE.CylinderGeometry(0.033, 0.033, 0.15, 12), chrome, -0.5, Y(0.3), zR - 0.06, false);
  tip.rotation.x = Math.PI / 2;

  cabin(interior, trim, Y, u, { seatU: 1.95, dashU: 0.85, wheelU: 1.45, seatX: 0.38, hip: 0.56, rear: 2.75 });
  return { exhausts: [[-0.5, 0.3, zR + 0.02]], rim: SENTRA_RIM, arch: 0.42 };
}

/** Seats, dash and steering wheel (seen through the glass and in the cockpit view). */
function cabin(group, trim, Y, u, { seatU, dashU, wheelU, seatX, hip, rear = 0 }) {
  const inside = (geo, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, trim); m.position.set(x, y, z); m.rotation.x = rx; group.add(m); return m; };
  for (const s of [-1, 1]) {
    inside(new THREE.BoxGeometry(0.5, 0.12, 0.5), s * seatX, Y(hip), u(seatU) - 0.05);
    inside(new THREE.BoxGeometry(0.5, 0.62, 0.12), s * seatX, Y(hip + 0.33), u(seatU) + 0.24, -0.22);
    inside(new THREE.BoxGeometry(0.26, 0.2, 0.1), s * seatX, Y(hip + 0.7), u(seatU) + 0.32);
  }
  if (rear) inside(new THREE.BoxGeometry(1.3, 0.4, 0.5), 0, Y(hip + 0.35), u(rear));
  inside(new THREE.BoxGeometry(1.45, 0.14, 0.45), 0, Y(hip + 0.4), u(dashU));
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.022, 8, 24), trim);
  wheel.position.set(-seatX, Y(hip + 0.42), u(wheelU)); wheel.rotation.x = -1.15;
  group.add(wheel);
}
