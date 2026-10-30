// Trackside scenery: instanced trees (pines + broadleaf, wind sway), 3D grass tufts,
// a distant forest belt, layered mountain ridges and Sarit's billboards.
import * as THREE from '../vendor/three.module.min.js';
import { billboardTexture, BILLBOARD_ASPECT, heartShape, tuftTexture } from './textures.js';
import { mergeByMaterial } from './merge.js';

const UP = new THREE.Vector3(0, 1, 0);
export const windUniforms = { uTime: { value: 0 } };

// Distance LOD: each chunk shows its detailed mesh near the camera, a cheap one (or nothing) further out
const lodChunks = [];
export function updateLOD(camPos) {
  for (const c of lodChunks) {
    const d2 = (c.x - camPos.x) ** 2 + (c.z - camPos.z) ** 2;
    const near = d2 < c.r2;
    c.hi.visible = near;
    if (c.lo) c.lo.visible = !near;
  }
}

function hash3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Displace vertices by a position hash so seams stay closed. */
function jitter(geo, amount, droop = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (hash3(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100)) - 0.5) * 2 * amount;
    p.setXYZ(i, x * k, y + (hash3(z * 7, x * 7, 1) - 0.5) * amount + (Math.hypot(x, z) > 0.5 ? -droop : 0), z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Merge geometries into one non-indexed geometry with baked vertex colours. */
function merge(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color, shade } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      pos.push(x, y, z);
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      const k = shade ? shade(x, y, z, n.getY(i)) : 1;
      col.push(color.r * k, color.g * k, color.b * k);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function pineGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.36, 3.4, 7);
  trunk.translate(0, 1.7, 0);
  parts.push({ geo: trunk, color: new THREE.Color(0x4a3526) });
  const tiers = [[3.1, 4.4, 3.0], [2.4, 3.8, 5.3], [1.6, 3.2, 7.4], [0.8, 2.4, 9.4]];
  const leaf = new THREE.Color(0x2c4a26);
  for (const [r, h, y] of tiers) {
    const cone = jitter(new THREE.ConeGeometry(r, h, 8, 2), 0.16, 0.35);
    cone.translate(0, y + h / 2 - 0.6, 0);
    parts.push({
      geo: cone, color: leaf,
      shade: (x, yy, z, ny) => 0.55 + 0.35 * THREE.MathUtils.clamp((yy - y + 0.6) / h, 0, 1) + 0.2 * Math.max(ny, 0),
    });
  }
  return merge(parts);
}

function pineLowGeometry() {
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3.4, 4);
  trunk.translate(0, 1.7, 0);
  const cone = new THREE.ConeGeometry(2.8, 9.5, 7);
  cone.translate(0, 7.2, 0);
  return merge([{ geo: trunk, color: new THREE.Color(0x4a3526) },
    { geo: cone, color: new THREE.Color(0x2c4a26), shade: (x, y) => 0.6 + 0.04 * (y - 2.5) }]);
}

function broadleafLowGeometry() {
  const trunk = new THREE.CylinderGeometry(0.2, 0.4, 4.4, 4);
  trunk.translate(0, 2.2, 0);
  const crown = jitter(new THREE.IcosahedronGeometry(3, 0), 0.12);
  crown.scale(1.05, 0.95, 1.05); crown.translate(0, 6, 0);
  return merge([{ geo: trunk, color: new THREE.Color(0x56402d) },
    { geo: crown, color: new THREE.Color(0x46682a), shade: (x, y, z, ny) => 0.6 + 0.3 * Math.max(ny, 0) }]);
}

function broadleafGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.2, 0.4, 4, 7);
  trunk.translate(0, 2, 0);
  parts.push({ geo: trunk, color: new THREE.Color(0x56402d) });
  for (const [s, b] of [[1, 0.6], [-1, 0.4]]) {
    const br = new THREE.CylinderGeometry(0.08, 0.14, 2.2, 5);
    br.translate(0, 1.1, 0); br.rotateZ(s * b); br.translate(0, 2.6, 0);
    parts.push({ geo: br, color: new THREE.Color(0x56402d) });
  }
  const blobs = [[0, 6.3, 0, 2.7], [1.7, 5.4, 0.5, 2.1], [-1.6, 5.6, -0.3, 2.2], [0.1, 5.3, -1.7, 2], [-0.2, 7.6, 0.6, 1.8]];
  const leaf = new THREE.Color(0x46682a);
  for (const [x, y, z, r] of blobs) {
    const g = jitter(new THREE.IcosahedronGeometry(r, 1), 0.22);
    g.translate(x, y, z);
    parts.push({ geo: g, color: leaf, shade: (xx, yy, zz, ny) => 0.5 + 0.12 * (yy - 4) + 0.25 * Math.max(ny, 0) });
  }
  return merge(parts);
}

function windMaterial(params, strength) {
  const mat = new THREE.MeshStandardMaterial(params);
  mat.customProgramCacheKey = () => `wind${strength}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windUniforms.uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
      #else
        vec3 ip = vec3(0.0);
      #endif
      float sway = sin(uTime * 1.4 + ip.x * 0.05 + ip.z * 0.07) + 0.4 * sin(uTime * 2.9 + ip.z * 0.13);
      float hgt = max(transformed.y, 0.0);
      transformed.x += sway * ${strength.toFixed(4)} * hgt * hgt;
      transformed.z += sway * ${(strength * 0.5).toFixed(4)} * hgt * hgt;`);
  };
  return mat;
}

/** Split instances into spatial cells so frustum culling (and the shadow pass) can skip them. */
function chunked(group, geo, mat, items, cell, opts = {}) {
  // opts.lod = { dist, geo? }: beyond dist from the chunk centre swap to lod.geo (or hide)
  const cells = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.x / cell)},${Math.floor(it.z / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(it);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const meshes = [];
  const build = (g, list, cast) => {
    const mesh = new THREE.InstancedMesh(g, mat, list.length);
    list.forEach((it, i) => {
      q.setFromAxisAngle(UP, it.rot);
      m4.compose(p.set(it.x, it.y || 0, it.z), q, s.set(it.sx, it.sy, it.sx));
      mesh.setMatrixAt(i, m4);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = !!opts.receive;
    mesh.computeBoundingSphere();
    group.add(mesh);
    return mesh;
  };
  for (const list of cells.values()) {
    const hi = build(geo, list, !!opts.cast);
    meshes.push(hi);
    if (opts.lod) {
      const lo = opts.lod.geo ? build(opts.lod.geo, list, false) : null;
      const cx = list.reduce((a, it) => a + it.x, 0) / list.length, cz = list.reduce((a, it) => a + it.z, 0) / list.length;
      const r = opts.lod.dist + cell * 0.7;
      lodChunks.push({ x: cx, z: cz, r2: r * r, hi, lo });
    }
  }
  return meshes;
}

export function buildTrees(track, group, rand, quality, keepClear = []) {
  const pines = [], broad = [];
  const count = quality === 'high' ? 900 : 600;
  const c = new THREE.Color();
  let tries = 0;
  while (pines.length + broad.length < count && tries++ < 30000) {
    const x = -950 + rand() * 1800, z = -950 + rand() * 1300;
    if (!track.clearOfTrack(x, z, 26)) continue;
    if (z > -40 && z < 75 && x > -370 && x < 430) continue; // keep the grandstand/pit area open
    if (keepClear.some(b => b.clear.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 28 * 28))) continue;   // don't hide the billboards
    const k = 0.75 + rand() * 0.7;
    const it = {
      x, z, rot: rand() * 6.28, sx: k, sy: k * (0.85 + rand() * 0.4),
      color: c.setHSL(0.22 + rand() * 0.08, 0.25 + rand() * 0.25, 0.7 + rand() * 0.28).clone(),
    };
    // Pines in clusters toward the far side, broadleaf elsewhere
    (Math.sin(x * 0.008) + Math.cos(z * 0.011) > 0.2 ? pines : broad).push(it);
  }
  const trunkMat = { vertexColors: true, roughness: 0.92, metalness: 0 };
  const lod = quality === 'high' ? 260 : 170;
  chunked(group, pineGeometry(), windMaterial(trunkMat, 0.0016), pines, 150, { cast: true, receive: true, lod: { dist: lod, geo: pineLowGeometry() } });
  chunked(group, broadleafGeometry(), windMaterial(trunkMat, 0.0022), broad, 150, { cast: true, receive: true, lod: { dist: lod, geo: broadleafLowGeometry() } });

  // Distant forest belt (cheap cones) to close the horizon
  const far = [];
  const cx = 0, cz = -280;
  for (let i = 0; i < (quality === 'high' ? 2600 : 1400); i++) {
    const a = rand() * Math.PI * 2, r = 1150 + rand() * 450;
    const k = 1.4 + rand() * 1.6;
    far.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, rot: rand() * 6, sx: k, sy: k * (0.8 + rand() * 0.6),
      color: new THREE.Color().setHSL(0.27 + rand() * 0.06, 0.3, 0.13 + rand() * 0.07) });
  }
  const farGeo = new THREE.ConeGeometry(3, 12, 6);
  farGeo.translate(0, 5.5, 0);
  chunked(group, farGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), far, 1100);
}

export function buildGrassTufts(track, group, rand, quality) {
  const n = quality === 'high' ? 9000 : 3500;
  const items = [];
  const tint = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = (rand() * track.N) | 0;
    const side = rand() < 0.5 ? -1 : 1;
    const lat = 10.8 + rand() * 4.6;
    const p = track.points[k], r = track.rights[k], t = track.tangents[k];
    const along = (rand() - 0.5) * track.ds;
    const x = p.x + r.x * side * lat + t.x * along, z = p.z + r.z * side * lat + t.z * along;
    if (!track.clearOfTrack(x, z, 10.6, k)) continue;
    const s = 0.5 + rand() * 0.6;
    items.push({ x, z, rot: rand() * 6.28, sx: s, sy: s * (0.7 + rand() * 0.6), color: tint.setHSL(0.22 + rand() * 0.06, 0.5, 0.72 + rand() * 0.26).clone() });
  }
  // Three crossed quads
  const quads = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(1.1, 0.6);
    g.translate(0, 0.3, 0);
    g.rotateY(i * Math.PI / 3);
    quads.push(g.toNonIndexed());
  }
  const pos = [], uv = [], nor = [];
  for (const g of quads) {
    pos.push(...g.attributes.position.array);
    uv.push(...g.attributes.uv.array);
    for (let i = 0; i < g.attributes.position.count; i++) nor.push(0, 1, 0);   // lit like the ground
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const mat = windMaterial({ map: tuftTexture(rand), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }, 0.25);
  chunked(group, geo, mat, items, 90, { receive: true, lod: { dist: quality === 'high' ? 150 : 90 } });
}

export function buildMountains(group, rand) {
  const cx = 0, cz = -280;
  // Sky horizon colour (display space) converted to linear so the ridges fade into it exactly
  const haze = new THREE.Color().setRGB(0.74, 0.83, 0.92, THREE.SRGBColorSpace);
  const layers = [
    { R: 2550, base: 120, amp: 520, freq: [2, 6, 13], rock: 0x56657a, high: 0x7a8798, snow: 440, haze: 0.3 },
    { R: 1900, base: 30, amp: 170, freq: [4, 9, 21], rock: 0x2f4630, high: 0x4f6450, snow: 1e9, haze: 0.12 },
  ];
  const ROWS = 7;
  for (const L of layers) {
    const segs = 240, pos = [], col = [], idx = [];
    const ph = [rand() * 6, rand() * 6, rand() * 6];
    const rock = new THREE.Color(L.rock), high = new THREE.Color(L.high), snow = new THREE.Color(0xeef2f6), c = new THREE.Color();
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * Math.PI * 2;
      const n = Math.abs(Math.sin(a * L.freq[0] + ph[0])) * 0.55 + Math.abs(Math.sin(a * L.freq[1] + ph[1])) * 0.3 +
        Math.abs(Math.sin(a * L.freq[2] + ph[2])) * 0.15;
      const h = L.base + L.amp * n * n;
      const snowLine = L.snow + Math.sin(a * 37) * 25;
      const x = Math.cos(a), z = Math.sin(a);
      for (let r = 0; r <= ROWS; r++) {
        const t = r / ROWS, y = -30 + (h + 30) * t;
        // Slight bulge so ridges read as volumes, not flat cut-outs
        const R = L.R + (1 - t) * (1 - t) * 120;
        pos.push(cx + x * R, y, cz + z * R);
        c.copy(rock).lerp(high, THREE.MathUtils.clamp(y / (L.base + L.amp), 0, 1));
        if (y > snowLine) c.lerp(snow, THREE.MathUtils.clamp((y - snowLine) / 60, 0, 1));
        c.lerp(haze, L.haze + (1 - t) * 0.12);
        col.push(c.r, c.g, c.b);
      }
      if (i < segs) {
        for (let r = 0; r < ROWS; r++) {
          const v = i * (ROWS + 1) + r, w = v + ROWS + 1;
          idx.push(v, v + 1, w, v + 1, w + 1, w);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    m.frustumCulled = false;
    group.add(m);
  }
}

/** Sarit's billboards, alternating messages, just off the outside of each bend and turned to face the approach. */
export function buildBillboards(track, group) {
  // Big enough to read at speed on a phone: 44 m × 22 m face, bottom edge 2.5 m up (clear of the 0.9 m walls)
  const W = 44, H = W / BILLBOARD_ASPECT, POST = 2.5, HEART = 7;
  const faces = {
    sentra: billboardTexture('sentra'),
    sarit: billboardTexture('sarit'),
  };
  const frame = new THREE.MeshStandardMaterial({ color: 0x2a2c31, metalness: 0.7, roughness: 0.45 });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x8a8d93, metalness: 0.5, roughness: 0.6 });
  const faceMat = (t) => new THREE.MeshStandardMaterial({
    map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.55, metalness: 0,
  });
  const mats = { sentra: faceMat(faces.sentra), sarit: faceMat(faces.sarit) };
  const heartGeo = new THREE.ExtrudeGeometry(heartShape(), { depth: 0.35, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.08, bevelSegments: 4, curveSegments: 20 });
  heartGeo.center();
  const heartMat = new THREE.MeshPhysicalMaterial({ color: 0xd0103a, emissive: 0x700018, emissiveIntensity: 0.6, roughness: 0.25, clearcoat: 1, metalness: 0.1 });
  const hearts = [], spots = [];

  // Corner entries: where a straight ends and the bend begins
  const N = track.N, TH = 1 / 160, entries = [];
  for (let i = 0; i < N; i++) {
    if (Math.abs(track.curvature[i]) > TH && Math.abs(track.curvature[(i - 1 + N) % N]) <= TH) entries.push(i);
  }
  let n = 0;
  for (const e of entries) {
    const kA = (e - 25 + N) % N;
    const t = track.tangents[kA], r = track.rights[kA], p = track.points[e];
    // The driver's eye on the approach, ~120 m before the bend: the board turns to face it
    const eye = track.points[(e - 60 + N) % N];
    const outward = track.curvature[(e + 10) % N] > 0 ? -1 : 1;
    let placed = false;
    // Off to the outside so it sits beside the HUD cluster, not behind it at the vanishing point
    for (const side of [outward, -outward]) {
      for (const L of [34, 42, 50]) {
        for (let D = 0; D <= 80 && !placed; D += 10) {
          const x = p.x + t.x * D + r.x * side * L, z = p.z + t.z * D + r.z * side * L;
          let nx = eye.x - x, nz = eye.z - z;
          const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
          const ax = nz, az = -nx;   // board's long axis
          if (z > -70 && x > -400 && x < 300) continue;   // grandstands and pit building
          if (spots.some(o => (o.x - x) ** 2 + (o.z - z) ** 2 < 230 * 230)) continue;
          // Every part of the face and legs stays at least 19 m from the centreline (3 m behind the barriers)
          const ok = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1].every(f => track.clearOfTrack(x + ax * f * (W / 2 + 1), z + az * f * (W / 2 + 1), 19));
          if (!ok) continue;
          const kind = n % 2 === 0 ? 'sentra' : 'sarit';
          const g = new THREE.Group();
          const board = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, H + 0.6, 0.4), [frame, frame, frame, frame, mats[kind], backMat]);
          board.position.y = POST + H / 2;
          board.castShadow = true; board.receiveShadow = true;
          g.add(board);
          // Four steel legs from the ground up behind the face (nothing sits below y = 0)
          const legH = POST + H * 0.75;
          for (const s of [-0.75, -0.25, 0.25, 0.75]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, legH, 0.9), frame);
            post.position.set(s * W * 0.5, legH / 2, -0.75);
            post.castShadow = true;
            g.add(post);
          }
          // Floodlights along the top edge
          for (let i = -4; i <= 4; i++) {
            const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 0.6), frame);
            lamp.position.set(i * W / 9, POST + H + 0.8, 0.8);
            g.add(lamp);
          }
          if (kind === 'sarit') {
            const heart = new THREE.Mesh(heartGeo, heartMat);
            heart.scale.setScalar(HEART);
            heart.position.set(0, POST + H + 0.6 + HEART * 0.7, 0);
            heart.castShadow = true;
            g.add(heart);
            hearts.push(heart);
          }
          mergeByMaterial(g);
          g.position.set(x, 0, z);
          g.rotation.y = Math.atan2(nx, nz);
          group.add(g);
          // Keep trees out of the board and its sightline back to the track
          const clear = [0, 18, 36].map(d => ({ x: x + nx * d, z: z + nz * d }));
          spots.push({ x, z, kind, index: e, nx, nz, clear });
          placed = true;
          n++;
        }
        if (placed) break;
      }
      if (placed) break;
    }
  }
  return {
    count: n, spots,
    update(dt, time) {
      for (const h of hearts) {
        h.rotation.y += dt * 1.2;
        const beat = Math.max(0, Math.sin(time * 5)) ** 8;   // heartbeat pulse
        h.scale.setScalar(HEART * (1 + beat * 0.12));
      }
    },
  };
}
