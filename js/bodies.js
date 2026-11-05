// Procedural bodies for the modern cars (Nissan GT-R R35, 2023 Nissan Sentra), built like the
// Charger: an extruded side profile with wheel arches, then shaped in plan view (tapered nose and
// tail, tumblehome) so they read as rounded modern shapes, plus lights, grille and trim.
// Profile heights are above the ground; z runs from the nose (zF) back to the tail (zR).
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

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Plan-view shaping: pull the sides in toward the nose and tail (rounded corners) and above the
 * shoulder line (tumblehome). Only moves X, so the side profile stays exact.
 */
function shape(geo, { zF, zR, nose = 0.16, tail = 0.1, noseLen = 0.7, tailLen = 0.5, yShoulder, tumble = 0.07, yTop }) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const kN = smooth(zF + noseLen, zF, z) * nose;          // 0 behind the nose section, `nose` at the tip
    const kT = smooth(zR - tailLen, zR, z) * tail;
    const kU = smooth(yShoulder, yTop, y) * tumble;
    p.setX(i, x * (1 - kN - kT - kU));
  }
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ Nissan GT-R (R35), tuned
export const GTR_RIM = { spokes: 6, split: true, spokeW: 0.035, spokeT: 0.03, color: 0x34363b, rough: 0.28, cap: 0x111111, rimK: 0.74, caliper: 0xd4a017 };

export function buildGTR(c) {
  const { add, Y, spec, zf, zr, zF, zR, paint, black, glass, trim, tailMat, reverseMat, headMat, interior, envMap } = c;
  const u = (d) => zf + d;              // distance behind the front axle → chassis z
  const ar = 0.43, hub = spec.wheelRadius, W = spec.width;
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMap });
  const titanium = new THREE.MeshStandardMaterial({ color: 0x8a7f9a, metalness: 1, roughness: 0.25, envMap });
  const nose = zF - 0.06, tail = zR + 0.065;   // the body's bevel pushes its end faces out ~6 cm

  // Lower body: low nose, long hood, high shoulder, short ducktail
  const lower = [
    [zF + 0.12, Y(0.2)],
    [zf - ar, Y(0.2)], [zf - ar, Y(hub)], { arc: [zf, Y(hub), ar] }, [zf + ar, Y(0.2)],
    [zr - ar, Y(0.2)], [zr - ar, Y(hub)], { arc: [zr, Y(hub), ar] }, [zr + ar, Y(0.2)],
    [zR - 0.1, Y(0.24)], [zR, Y(0.42)], [zR + 0.01, Y(0.9)], [zR - 0.03, Y(1.03)],
    [u(3.3), Y(1.02)], [u(2.2), Y(0.99)], [u(0.55), Y(0.93)], [u(0.0), Y(0.85)],
    [zF + 0.12, Y(0.71)], [zF, Y(0.62)], [zF - 0.01, Y(0.4)],
  ];
  add(shape(extrudeProfile(lower, W, 0.08), { zF, zR, nose: 0.2, noseLen: 0.8, tail: 0.08, tailLen: 0.45, yShoulder: Y(0.86), yTop: Y(1.04), tumble: 0.05 }), paint);

  // Greenhouse: fastback glass + body-colour roof and thick C-pillars
  const cabinW = 1.36;
  const gh = add(shape(extrudeProfile([[u(0.5), Y(0.92)], [u(1.27), Y(1.355)], [u(2.05), Y(1.35)], [u(3.28), Y(1.0)]], cabinW, 0.03),
    { zF, zR, nose: 0, tail: 0, yShoulder: Y(1.0), yTop: Y(1.36), tumble: 0.12 }), glass);
  gh.renderOrder = 2;
  add(shape(extrudeProfile([[u(1.18), Y(1.345)], [u(1.3), Y(1.372)], [u(2.05), Y(1.367)], [u(2.4), Y(1.27)], [u(2.1), Y(1.33)]], cabinW + 0.03, 0.02),
    { zF, zR, nose: 0, tail: 0, yShoulder: Y(1.25), yTop: Y(1.37), tumble: 0.12 }), paint);
  for (const s of [-1, 1]) {
    // C-pillar (the R35's big sail panel) on each side, leaving the rear window open
    const cp = add(extrudeProfile([[u(1.9), Y(1.35)], [u(2.15), Y(1.345)], [u(3.27), Y(1.0)], [u(2.55), Y(0.99)]], 0.1, 0.01), paint, s * (cabinW / 2 - 0.08), 0, 0);
    cp.rotation.z = s * 0.1;
    const ap = add(new THREE.BoxGeometry(0.06, 0.55, 0.07), paint, s * 0.64, Y(1.14), u(0.88));
    ap.rotation.x = Math.atan2(0.77, 0.43);
  }

  // Hood: centre power bulge and two vents
  add(new THREE.BoxGeometry(0.62, 0.04, 1.0), paint, 0, Y(0.885), u(-0.05));
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.16, 0.012, 0.3), black, s * 0.38, Y(0.875), u(0.05), false);

  // Front: big trapezoid grille, low splitter, boomerang LED headlights
  add(new THREE.BoxGeometry(0.86, 0.26, 0.06), black, 0, Y(0.5), nose);
  add(new THREE.BoxGeometry(0.9, 0.02, 0.07), new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 1, roughness: 0.2, envMap }), 0, Y(0.64), nose, false);
  add(new THREE.BoxGeometry(W - 0.3, 0.05, 0.22), carbon, 0, Y(0.2), zF + 0.02);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.26, 0.16, 0.05), black, s * 0.56, Y(0.38), nose + 0.02);           // side intakes
    const hl = add(new THREE.BoxGeometry(0.34, 0.08, 0.2), headMat, s * 0.54, Y(0.72), zF + 0.16, false);
    hl.rotation.set(-0.35, s * 0.32, s * 0.12);
    const drl = add(new THREE.BoxGeometry(0.03, 0.12, 0.03), headMat, s * 0.44, Y(0.6), nose + 0.01, false);
    drl.rotation.z = s * 0.6;
    // fender gills behind the front wheels
    for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.01, 0.025, 0.24), black, s * (W / 2 - 0.02), Y(0.72 - k * 0.05), zf + 0.55, false);
    // mirrors, door handles
    const mir = add(new THREE.BoxGeometry(0.1, 0.08, 0.16), paint, s * 0.95, Y(1.0), u(0.72));
    mir.rotation.y = s * 0.25;
    add(new THREE.BoxGeometry(0.012, 0.03, 0.16), black, s * (W / 2 - 0.035), Y(0.86), u(1.75), false);
    // side skirt
    add(new THREE.BoxGeometry(0.06, 0.07, spec.wheelbase - 0.9), carbon, s * (W / 2 - 0.04), Y(0.22), (zf + zr) / 2, false);
  }

  // Rear: four round tail lights, diffuser, quad titanium exhaust, carbon wing
  const ring = new THREE.RingGeometry(0.075, 0.11, 24);
  const lens = new THREE.MeshPhysicalMaterial({ color: 0x220000, roughness: 0.2, clearcoat: 1, envMap });
  for (const x of [-0.62, -0.4, 0.4, 0.62]) {
    add(ring, tailMat, x, Y(0.86), tail + 0.004, false);
    add(new THREE.CircleGeometry(0.075, 20), lens, x, Y(0.86), tail + 0.002, false);
  }
  add(new THREE.BoxGeometry(0.18, 0.05, 0.03), reverseMat, 0, Y(0.62), tail, false);
  add(new THREE.BoxGeometry(W - 0.3, 0.14, 0.18), carbon, 0, Y(0.29), zR - 0.0);
  for (let k = -3; k <= 3; k++) add(new THREE.BoxGeometry(0.015, 0.12, 0.25), carbon, k * 0.13, Y(0.26), zR - 0.02, false);
  const exhausts = [];
  for (const x of [-0.62, -0.47, 0.47, 0.62]) {
    const tip = add(new THREE.CylinderGeometry(0.048, 0.048, 0.2, 14), titanium, x, Y(0.3), tail - 0.07, false);
    tip.rotation.x = Math.PI / 2;
    add(new THREE.CircleGeometry(0.038, 12), new THREE.MeshBasicMaterial({ color: 0x050505 }), x, Y(0.3), tail + 0.031, false);
    exhausts.push([x, 0.3, tail + 0.04]);
  }
  add(new THREE.BoxGeometry(1.62, 0.025, 0.3), carbon, 0, Y(1.27), zR - 0.28);                    // wing
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.02, 0.2, 0.32), carbon, s * 0.81, Y(1.24), zR - 0.28);              // end plates
    add(new THREE.BoxGeometry(0.04, 0.24, 0.08), carbon, s * 0.5, Y(1.14), zR - 0.26);              // stands
  }

  cabin(interior, trim, Y, u, { seatU: 1.95, dashU: 0.8, wheelU: 1.45, seatX: 0.37, hip: 0.5 });
  return { exhausts, rim: GTR_RIM };
}

// ------------------------------------------------------------------ 2023 Nissan Sentra SV
export const SENTRA_RIM = { spokes: 5, split: true, spokeW: 0.04, spokeT: 0.025, color: 0xc9ccd1, rough: 0.2, cap: 0x2a2c30, rimK: 0.62 };

export function buildSentra(c) {
  const { add, Y, spec, zf, zr, zF, zR, paint, chrome, black, glass, trim, tailMat, reverseMat, headMat, interior, envMap } = c;
  const u = (d) => zf + d;
  const ar = 0.41, hub = spec.wheelRadius, W = spec.width;
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.1, clearcoat: 1, envMap });
  const nose = zF - 0.06, tail = zR + 0.065;   // the body's bevel pushes its end faces out ~6 cm

  // Sedan: tall nose, short hood, high deck lid
  const lower = [
    [zF + 0.1, Y(0.24)],
    [zf - ar, Y(0.24)], [zf - ar, Y(hub)], { arc: [zf, Y(hub), ar] }, [zf + ar, Y(0.24)],
    [zr - ar, Y(0.25)], [zr - ar, Y(hub)], { arc: [zr, Y(hub), ar] }, [zr + ar, Y(0.25)],
    [zR - 0.1, Y(0.3)], [zR, Y(0.47)], [zR + 0.01, Y(0.94)], [zR - 0.05, Y(1.07)],
    [u(3.25), Y(1.08)], [u(2.3), Y(1.04)], [u(0.62), Y(0.99)], [u(0.0), Y(0.93)],
    [zF + 0.14, Y(0.82)], [zF, Y(0.72)], [zF - 0.01, Y(0.42)],
  ];
  add(shape(extrudeProfile(lower, W, 0.08), { zF, zR, nose: 0.16, noseLen: 0.7, tail: 0.07, tailLen: 0.4, yShoulder: Y(0.92), yTop: Y(1.08), tumble: 0.045 }), paint);

  // Greenhouse: fastback-style sedan roof with a black "floating" C-pillar
  const cabinW = 1.34;
  const gh = add(shape(extrudeProfile([[u(0.56), Y(0.98)], [u(1.4), Y(1.43)], [u(2.3), Y(1.43)], [u(3.12), Y(1.06)]], cabinW, 0.03),
    { zF, zR, nose: 0, tail: 0, yShoulder: Y(1.05), yTop: Y(1.44), tumble: 0.12 }), glass);
  gh.renderOrder = 2;
  add(shape(extrudeProfile([[u(1.3), Y(1.42)], [u(1.42), Y(1.447)], [u(2.3), Y(1.445)], [u(2.6), Y(1.35)], [u(2.35), Y(1.41)]], cabinW + 0.03, 0.02),
    { zF, zR, nose: 0, tail: 0, yShoulder: Y(1.3), yTop: Y(1.45), tumble: 0.12 }), paint);
  for (const s of [-1, 1]) {
    const cp = add(extrudeProfile([[u(2.25), Y(1.43)], [u(2.45), Y(1.42)], [u(3.11), Y(1.07)], [u(2.8), Y(1.05)]], 0.08, 0.01), gloss, s * (cabinW / 2 - 0.07), 0, 0);
    cp.rotation.z = s * 0.1;
    const ap = add(new THREE.BoxGeometry(0.055, 0.56, 0.065), black, s * 0.63, Y(1.21), u(0.98));
    ap.rotation.x = Math.atan2(0.84, 0.45);
    const bp = add(new THREE.BoxGeometry(0.05, 0.42, 0.06), black, s * 0.66, Y(1.2), u(1.85));   // B-pillar
    bp.rotation.x = -0.05;
  }

  // Front: V-motion grille (black mesh, chrome V), slim headlights, fog-light pods
  add(new THREE.BoxGeometry(0.92, 0.3, 0.05), gloss, 0, Y(0.56), nose);
  for (const s of [-1, 1]) {
    const v = add(new THREE.BoxGeometry(0.46, 0.035, 0.04), chrome, s * 0.22, Y(0.52), nose - 0.015, false);
    v.rotation.z = s * 0.42;
    const hl = add(new THREE.BoxGeometry(0.36, 0.065, 0.2), headMat, s * 0.52, Y(0.79), zF + 0.13, false);
    hl.rotation.set(-0.25, s * 0.28, s * -0.12);
    add(new THREE.BoxGeometry(0.18, 0.07, 0.04), black, s * 0.56, Y(0.36), nose + 0.02);
    const mir = add(new THREE.BoxGeometry(0.1, 0.09, 0.15), gloss, s * 0.94, Y(1.06), u(0.82));
    mir.rotation.y = s * 0.22;
    for (const du of [1.3, 2.2]) add(new THREE.BoxGeometry(0.012, 0.03, 0.15), chrome, s * (W / 2 - 0.035), Y(0.93), u(du), false);
  }
  add(new THREE.BoxGeometry(W - 0.4, 0.08, 0.12), black, 0, Y(0.27), zF + 0.06);

  // Rear: wide boomerang tail lights, chrome strip, plate recess, one small hidden exhaust
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.44, 0.09, 0.05), tailMat, s * 0.56, Y(0.93), tail, false);
    const lo = add(new THREE.BoxGeometry(0.2, 0.05, 0.05), tailMat, s * 0.7, Y(0.86), tail - 0.005, false);
    lo.rotation.z = s * 0.4;
  }
  add(new THREE.BoxGeometry(0.7, 0.025, 0.04), chrome, 0, Y(0.94), tail + 0.005, false);
  add(new THREE.BoxGeometry(0.52, 0.2, 0.03), black, 0, Y(0.67), tail, false);
  add(new THREE.BoxGeometry(0.12, 0.05, 0.03), reverseMat, 0, Y(0.53), tail + 0.005, false);
  add(new THREE.BoxGeometry(W - 0.4, 0.1, 0.14), black, 0, Y(0.32), zR + 0.01);
  const tip = add(new THREE.CylinderGeometry(0.035, 0.035, 0.15, 12), chrome, -0.5, Y(0.29), tail - 0.05, false);
  tip.rotation.x = Math.PI / 2;

  cabin(interior, trim, Y, u, { seatU: 1.95, dashU: 0.85, wheelU: 1.45, seatX: 0.38, hip: 0.56, rear: 2.75 });
  return { exhausts: [[-0.5, 0.29, tail + 0.03]], rim: SENTRA_RIM };
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
