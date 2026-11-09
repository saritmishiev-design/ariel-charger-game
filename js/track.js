// Tracks: road ribbon, curbs, barriers (visual + physics), ground/terrain and scenery for
//  - "classic": Ariel Raceway, the original flat 3.6 km circuit,
//  - "ring":    Nürburgring Lite, 7.4 km over hills (a heightfield for physics, displaced ground mesh),
//  - "drag":    a flat quarter-mile drag strip with a Christmas tree, distance boards and a timing board.
import * as THREE from '../vendor/three.module.min.js';
import * as CANNON from '../vendor/cannon-es.js';
import { rng, asphaltTextures, skidTexture, grassTextures } from './textures.js';
import { mergeByMaterial } from './merge.js';
import { buildTrees, buildGrassTufts, buildMountains, buildBillboards, windUniforms, updateLOD } from './scenery.js';

// "Ariel Raceway" — 3.6 km: long main straight, fast sweepers, a tight chicane,
// a long back straight, a heavy-braking hairpin, esses and a final hairpin.
const LAYOUT = [
  [-330, 0], [0, 0], [380, 0], [500, -25], [570, -110], [560, -220], [470, -285],
  [380, -260], [320, -320], [350, -430], [290, -530], [170, -565], [-50, -565],
  [-320, -565], [-480, -555], [-575, -490], [-590, -390], [-525, -320], [-400, -312],
  [-300, -255], [-320, -180], [-430, -145], [-505, -140], [-555, -118], [-572, -70],
  [-552, -22], [-500, 0],
];

// "Nürburgring Lite" — 7.4 km: Hatzenbach-style esses up a hill, a Flugplatz crest, a plunging
// Fuchsröhre, a hairpin valley, Kesselchen climb, a Karussell and a 1.75 km Döttinger Höhe straight.
const RING = [
  [-300, 0], [0, 0], [300, 0], [420, -40], [455, -150], [400, -250], [450, -340], [400, -430], [430, -560],
  [520, -700], [540, -860], [480, -980], [520, -1080], [460, -1180], [330, -1250], [180, -1270], [80, -1220],
  [0, -1290], [-150, -1320], [-260, -1250], [-300, -1120], [-260, -980], [-330, -900], [-420, -960], [-440, -1100],
  [-520, -1260], [-640, -1330], [-760, -1300], [-860, -1360], [-1000, -1300], [-1150, -1240], [-1300, -1300],
  [-1450, -1260], [-1560, -1150], [-1620, -980], [-1610, -800], [-1680, -700], [-1770, -640], [-1780, -545],
  [-1700, -505], [-1590, -470], [-1500, -330], [-1520, -160], [-1440, -40], [-1200, 0], [-800, 0],
];
// Terrain = sum of Gaussian hills [height m, x, z, sigma m]: ~70 m of relief, grades up to ~12 %
const RING_HILLS = [
  [30, 470, -750, 260], [-28, 330, -1300, 230], [-30, -300, -1000, 230], [38, -1200, -1150, 350],
  [24, -1700, -620, 220], [12, -900, -1350, 200], [-7, -800, 60, 260], [5, -1350, 30, 200],
];

export const DRAG_LENGTH = 402.336;   // 1/4 mile in metres
const DRAG_RUNUP = 90, DRAG_SHUTDOWN = 900;

const DEFS = {
  classic: {
    layout: LAYOUT, closed: true, half: 7, seed: 1979, gantry: 'ARIEL RACEWAY  ·  START / FINISH',
    stands: [[180, 1, 90], [360, 1, 110], [550, 1, 90]], pit: [330, -1],
    clear: [[-400, 430, -70, 200]],
  },
  ring: {
    layout: RING, closed: true, half: 6.5, seed: 1927, gantry: 'NÜRBURGRING LITE  ·  START / FINISH',
    hills: RING_HILLS, stands: [[140, 1, 90], [300, 1, 110]], pit: [230, -1],
    clear: [[-420, 520, -70, 200]],
  },
  drag: {
    layout: [[-DRAG_RUNUP, 0], [DRAG_LENGTH + DRAG_SHUTDOWN, 0]], closed: false, half: 6.5, seed: 1320,
    gantry: 'QUARTER MILE  ·  FINISH', drag: true,
    stands: [[40, 1, 100], [40, -1, 100], [400, 1, 90]], pit: null,
    clear: [[-160, DRAG_LENGTH + DRAG_SHUTDOWN + 60, -75, 75]],
  },
};

/** Centreline as [x, z] samples, for the garage's track maps. */
export function trackOutline(id, n = 220) {
  const def = DEFS[id] || DEFS.classic;
  const pts = def.layout.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = def.closed ? new THREE.CatmullRomCurve3(pts, true, 'centripetal') : new THREE.LineCurve3(pts[0], pts[1]);
  return Array.from({ length: n }, (_, i) => { const p = curve.getPointAt(i / (def.closed ? n : n - 1)); return [p.x, p.z]; });
}

export const ROAD_HALF = 7;
const CURB_W = 1.3;
const WALL_OFFSET = 16;
const SPACING = 2;
const WALL_CHUNK = 24;          // barrier panels per physics body
export const TERRAIN_GROUP = 2;   // collision group of the heightfield (see vehicle.js)

function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function noiseFill(ctx, w, h, base, spread, rand, dots = 9000) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < dots; i++) {
    const v = (rand() - 0.5) * spread;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v)})`;
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

export class Track {
  /** carInfo { hp, sentra }: the spawned car, for the billboard text. */
  constructor(scene, world, materials, quality = 'high', id = 'classic', carInfo = { hp: 700, sentra: false }) {
    const def = DEFS[id] || DEFS.classic;
    this.id = DEFS[id] ? id : 'classic';
    this.def = def;
    this.scene = scene;
    this.closed = def.closed;
    this.isDrag = !!def.drag;
    this.half = def.half;
    this.hills = def.hills || null;
    const pts = def.layout.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = this.closed ? new THREE.CatmullRomCurve3(pts, true, 'centripetal') : new THREE.LineCurve3(pts[0], pts[1]);
    curve.arcLengthDivisions = Math.max(200, def.layout.length * 60);
    this.curve = curve;
    this.length = curve.getLength();
    const N = Math.round(this.length / SPACING);
    this.N = N;
    this.ds = this.length / N;
    this.count = this.closed ? N : N + 1;   // samples (an open strip includes its far end)

    this.points = [];
    this.tangents = [];
    this.rights = [];
    this.curvature = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const u = i / N;
      const p = curve.getPointAt(Math.min(1, u));
      const t = curve.getTangentAt(Math.min(1, u)).setY(0).normalize();
      p.y = this.height(p.x, p.z);
      this.points.push(p);
      this.tangents.push(t);
      this.rights.push(new THREE.Vector3(-t.z, 0, t.x));
    }
    if (this.closed) {
      for (let i = 0; i < N; i++) {
        const a = this.tangents[(i - 2 + N) % N], b = this.tangents[(i + 2) % N];
        const cross = a.x * b.z - a.z * b.x;
        this.curvature[i] = Math.asin(Math.max(-1, Math.min(1, cross))) / (4 * this.ds);
      }
    }
    // Start / finish: lap line at sample 0; on the drag strip the start line is after the run-up
    this.startIndex = this.isDrag ? Math.round(DRAG_RUNUP / this.ds) : 0;
    this.finishIndex = this.isDrag ? Math.round((DRAG_RUNUP + DRAG_LENGTH) / this.ds) : 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of this.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    this.bounds = { minX, maxX, minZ, maxZ, cx, cz, R: Math.max(maxX - minX, maxZ - minZ, 900) / 2 + 60 };
    this.clearZones = def.clear;

    this.rand = rng(def.seed);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.buildGround(world, materials, quality);
    this.buildRoad();
    this.buildCurbs();
    this.buildWalls(world, materials);
    this.buildStartLine();
    this.buildScenery();
    if (this.isDrag) this.buildDragStrip();
    this.billboards = buildBillboards(this, this.group, carInfo);
    buildTrees(this, this.group, this.rand, quality, this.billboards.spots);
    buildGrassTufts(this, this.group, this.rand, quality);
    buildMountains(this.group, this.rand, this.bounds);
    this.time = 0;
  }

  /** Ground height (m) at a world position. */
  height(x, z) {
    const H = this.hills;
    if (!H) return 0;
    let h = 0;
    for (let i = 0; i < H.length; i++) {
      const [A, cx, cz, s] = H[i];
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < 25 * s * s) h += A * Math.exp(-d2 / (2 * s * s));
    }
    return h;
  }

  /** Is this point inside one of the open areas (grandstands, pits, the drag strip apron)? */
  inClearZone(x, z, pad = 0) {
    return this.clearZones.some(([x0, x1, z0, z1]) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad);
  }

  wrap(i) {
    return this.closed ? ((i % this.N) + this.N) % this.N : Math.max(0, Math.min(this.count - 1, i));
  }

  update(dt, camera) {
    this.time += dt;
    windUniforms.uTime.value = this.time;
    this.billboards.update(dt, this.time);
    if (this.dragUpdate) this.dragUpdate(dt);
    updateLOD(camera.position);
  }

  /** Spawn transform: on the grid a little behind the start line. */
  spawn(back = 12) {
    return this.spawnAt(this.startIndex - Math.round(back / this.ds));
  }

  spawnAt(index) {
    const i = this.wrap(index);
    const p = this.points[i], t = this.tangents[i];
    return { x: p.x, y: p.y, z: p.z, heading: Math.atan2(-t.x, -t.z), index: i };
  }

  /** Nearest centreline sample around a hint index. */
  query(x, z, hint = -1) {
    let best = -1, bestD = Infinity;
    const scan = (from, to, step) => {
      for (let k = from; k <= to; k += step) {
        const i = this.wrap(k);
        const p = this.points[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    };
    if (hint >= 0) scan(hint - 40, hint + 40, 1);
    if (hint < 0 || bestD > 60 * 60) { bestD = Infinity; scan(0, this.count - 1, 4); scan(best - 6, best + 6, 1); }
    const p = this.points[best], r = this.rights[best];
    const lateral = (x - p.x) * r.x + (z - p.z) * r.z;
    return { index: best, lateral, dist: Math.abs(lateral) };
  }

  /** Distance travelled along the strip/lap from the start line (m, + = past it). */
  along(x, z) {
    const p = this.points[this.startIndex], t = this.tangents[this.startIndex];
    return (x - p.x) * t.x + (z - p.z) * t.z;
  }

  buildGround(world, materials, quality) {
    const { map, macro } = grassTextures(this.rand);
    const SIZE = this.hills ? 6400 : 5000;
    map.repeat.set(SIZE / 19.2, SIZE / 19.2);
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
    // Break up tiling with two layers of low-frequency colour variation
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.macroMap = { value: macro };
      sh.fragmentShader = 'uniform sampler2D macroMap;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        vec3 macA = texture2D(macroMap, vMapUv * 0.0371).rgb;
        vec3 macB = texture2D(macroMap, vMapUv * 0.0083 + 0.31).rgb;
        diffuseColor.rgb *= macA * macB * 1.6;`);
    };
    const { cx, cz } = this.bounds;
    if (!this.hills) {
      // Subdivided: one giant triangle pair loses depth precision against the road on many GPUs
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE, 64, 64), mat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(this.isDrag ? cx : 0, -0.03, 0);
      ground.receiveShadow = true;
      this.group.add(ground);
      const body = new CANNON.Body({ mass: 0, material: materials.ground });
      body.addShape(new CANNON.Plane());
      body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      world.addBody(body);
      this.groundBodies = [body];
      return;
    }

    // Hills: displaced grid for the eye (sunk a little below the true surface so the coarse
    // triangles never poke through the road) and a 4 m heightfield for the physics
    const SEG = quality === 'high' ? 256 : 180;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const cell = SIZE / SEG, sink = 0.04 + 1.1e-3 * cell * cell / 8;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      pos.setXYZ(i, x, this.height(x, z) - sink, z);
    }
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.group.add(ground);

    const ES = 4, M = 90;
    const x0 = Math.floor((this.bounds.minX - M) / ES) * ES, x1 = this.bounds.maxX + M;
    const zTop = Math.ceil((this.bounds.maxZ + M) / ES) * ES, z1 = this.bounds.minZ - M;
    const nx = Math.ceil((x1 - x0) / ES) + 1, nz = Math.ceil((zTop - z1) / ES) + 1;
    const data = [];
    for (let i = 0; i < nx; i++) {
      const col = new Array(nz);
      for (let j = 0; j < nz; j++) col[j] = this.height(x0 + i * ES, zTop - j * ES);
      data.push(col);
    }
    const hf = new CANNON.Heightfield(data, { elementSize: ES });
    hf.cacheEnabled = false;            // a lap visits ~10k cells: caching pillars would leak memory
    hf.collisionFilterGroup = TERRAIN_GROUP;
    const body = new CANNON.Body({ mass: 0, material: materials.ground });
    body.addShape(hf);
    // Heightfield is built in its local XY plane with heights along +Z: lay it flat (local Z → world Y)
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    body.position.set(x0, 0, zTop);
    world.addBody(body);
    // Safety net well below the lowest valley, in case a car ever ends up outside the heightfield
    const net = new CANNON.Body({ mass: 0, material: materials.ground });
    net.addShape(new CANNON.Plane());
    net.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    net.position.set(0, -60, 0);
    world.addBody(net);
    this.groundBodies = [body, net];
  }

  isGround(body) { return this.groundBodies.includes(body); }

  ribbon(offsetA, offsetB, y, vScale, mask = null, segs = 1) {
    // Build a strip between two lateral offsets along the centreline. On hills each vertex sits on
    // the terrain, and the strip is split across its width so it follows the camber.
    if (this.hills) segs = Math.max(segs, Math.ceil(Math.abs(offsetB - offsetA) / 3.5));
    const N = this.N, cols = segs + 1;
    const pos = [], uv = [], idx = [];
    let dist = 0, vi = 0;
    const rows = this.closed ? N + 1 : this.count;
    for (let i = 0; i < rows; i++) {
      const k = this.closed ? i % N : i;
      const p = this.points[k], r = this.rights[k];
      for (let c = 0; c < cols; c++) {
        const o = offsetA + (offsetB - offsetA) * c / segs;
        const x = p.x + r.x * o, z = p.z + r.z * o;
        pos.push(x, this.height(x, z) + y, z);
        uv.push(c / segs, dist / vScale);
      }
      if (i > 0 && (!mask || mask(k))) {
        for (let c = 0; c < segs; c++) {
          const a = vi - cols + c, b = a + 1, d = vi + c, e = d + 1;
          // Wind counter-clockwise seen from above so the strip faces up
          if (offsetA < offsetB) idx.push(a, b, d, b, e, d);
          else idx.push(a, d, b, b, d, e);
        }
      }
      vi += cols;
      dist += this.ds;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  buildRoad() {
    const H = this.half;
    const tex = asphaltTextures(this.rand);
    const road = new THREE.Mesh(
      this.ribbon(-H, H, 0.02, H * 2),
      new THREE.MeshStandardMaterial({
        map: tex.map, roughnessMap: tex.roughnessMap, bumpMap: tex.bumpMap, bumpScale: 1.2, roughness: 1, metalness: 0,
        envMapIntensity: 0.7,
      }),
    );
    road.receiveShadow = true;
    this.group.add(road);

    // Rubber laid down in the braking zones before every real corner (and the drag strip's launch pad)
    const C = this.count, N = this.N, brake = new Uint8Array(C), TH = 1 / 160;
    if (this.closed) {
      for (let i = 0; i < N; i++) {
        const c = Math.abs(this.curvature[i]) > TH, p = Math.abs(this.curvature[(i - 1 + N) % N]) > TH;
        if (c && !p) for (let k = -70; k <= 12; k++) brake[(i + k + N) % N] = 1;
      }
    } else for (let i = this.startIndex - 3; i < this.startIndex + 60; i++) brake[i] = 1;
    const skid = new THREE.Mesh(
      this.ribbon(-H + 0.6, H - 0.6, 0.026, 44, (k) => brake[k]),
      new THREE.MeshStandardMaterial({
        map: skidTexture(this.rand), transparent: true, depthWrite: false, roughness: 0.75,
        polygonOffset: true, polygonOffsetFactor: -2,
      }),
    );
    skid.receiveShadow = true;
    this.group.add(skid);

    // Run-off: dusty gravel verge just outside the curbs
    const gravel = canvasTexture(128, 128, (ctx, w, h) => noiseFill(ctx, w, h, '#8f8670', 0.35, this.rand, 9000), 1, 1);
    const verge = new THREE.MeshStandardMaterial({ map: gravel, roughness: 1 });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(this.ribbon(s * (H + CURB_W), s * (H + CURB_W + 2.2), 0.012, 4), verge);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  buildCurbs() {
    if (!this.closed) return;
    const N = this.N, H = this.half;
    const corner = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (Math.abs(this.curvature[i]) > 1 / 320) {
        for (let k = -6; k <= 6; k++) corner[(i + k + N) % N] = 1;
      }
    }
    const pos = [], col = [];
    const red = new THREE.Color(0xc8102e), white = new THREE.Color(0xf2f2f2);
    const at = (p, r, o, y) => { const x = p.x + r.x * o, z = p.z + r.z * o; return [x, this.height(x, z) + y, z]; };
    for (const side of [-1, 1]) {
      const a = side * H, b = side * (H + CURB_W);
      for (let i = 0; i < N; i++) {
        if (!corner[i]) continue;
        const j = (i + 1) % N;
        const p0 = this.points[i], r0 = this.rights[i], p1 = this.points[j], r1 = this.rights[j];
        const c = (i >> 1) % 2 ? red : white;
        const v = [at(p0, r0, a, 0.045), at(p0, r0, b, 0.025), at(p1, r1, a, 0.045), at(p1, r1, b, 0.025)];
        const order = side > 0 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2];
        for (const o of order) { pos.push(...v[o]); col.push(c.r, c.g, c.b); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6 }));
    m.receiveShadow = true;
    this.group.add(m);
  }

  /** True if a point is safely away from every other part of the track. */
  clearOfTrack(x, z, minDist, skipNear = -1) {
    const C = this.count, N = this.N, m2 = minDist * minDist;
    for (let i = 0; i < C; i += 2) {
      if (skipNear >= 0) {
        const d = Math.abs(i - skipNear);
        const sep = this.closed ? Math.min(d, N - d) : d;
        if (sep < 3) continue;
      }
      const p = this.points[i];
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < m2) return false;
    }
    return true;
  }

  buildWalls(world, materials) {
    const N = this.N;
    const step = 4;                     // 8 m panels
    const transforms = [];
    const off = this.isDrag ? this.half + 3 : WALL_OFFSET;
    const ends = [];
    for (const side of [-1, 1]) {
      let prev = null;
      const last = this.closed ? N : this.count - 1;
      for (let i = 0; i <= last; i += step) {
        const k = this.closed ? i % N : Math.min(i, this.count - 1);
        const p = this.points[k], r = this.rights[k];
        const x = p.x + r.x * side * off, z = p.z + r.z * side * off;
        const ok = this.isDrag || this.clearOfTrack(x, z, off - 0.5, k);
        const cur = ok ? { x, y: this.height(x, z), z } : null;
        if (prev && cur) transforms.push([prev, cur, (i / step) % 2]);
        prev = cur;
        if (!this.closed && (i === 0 || i + step > last)) ends.push(cur);
      }
    }
    if (!this.closed) {
      // Close the strip: a barrier behind the start and a catch wall at the end of the shutdown area
      transforms.push([ends[0], ends[2], 1], [ends[1], ends[3], 1]);
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1 });
    const inst = new THREE.InstancedMesh(geo, mat, transforms.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const dir = new THREE.Vector3(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), rot = new THREE.Matrix4();
    this._wp = new THREE.Vector3();
    const red = new THREE.Color(this.isDrag ? 0x8c8f96 : 0xb3202a), white = new THREE.Color(0xe9e9e9);
    // Split the barrier into bodies of ~40 panels so the broadphase and wheel raycasts skip far ones
    let body = null;
    transforms.forEach(([a, b, alt], n) => {
      if (n % WALL_CHUNK === 0) { body = new CANNON.Body({ mass: 0, material: materials.wall }); world.addBody(body); }
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz) + 0.05;
      // Follow the slope along the panel (local Z), stay upright across it (local X horizontal)
      dir.set(dx, dy, dz).normalize();
      ax.set(dir.z, 0, -dir.x).normalize();
      ay.crossVectors(dir, ax);
      q.setFromRotationMatrix(rot.makeBasis(ax, ay, dir));
      ps.set((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.45, (a.z + b.z) / 2);
      // Drawn reaching 0.25 m into the ground: the coarse terrain mesh sits a little below the true surface
      sc.set(0.6, 0.9 + (this.hills ? 0.25 : 0), len);
      m4.compose(this._wp.copy(ps).addScaledVector(ay, this.hills ? -0.125 : 0), q, sc);
      inst.setMatrixAt(n, m4);
      inst.setColorAt(n, alt ? red : white);
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(0.3, 0.9, len / 2)),
        new CANNON.Vec3(ps.x, ps.y + 0.45, ps.z),
        new CANNON.Quaternion(q.x, q.y, q.z, q.w),
      );
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    this.group.add(inst);
  }

  buildStartLine() {
    const H = this.half;
    const tex = canvasTexture(128, 32, (ctx, w, h) => {
      const s = h / 4;
      for (let y = 0; y < 4; y++) for (let x = 0; x < w / s; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * s, y * s, s, s);
      }
    });
    const lineAt = (index, map, depth) => {
      const p = this.points[index], t = this.tangents[index];
      const heading = Math.atan2(t.x, t.z);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, depth), new THREE.MeshStandardMaterial({ map, roughness: 0.7 }));
      line.rotation.order = 'YXZ';
      line.rotation.set(-Math.PI / 2, heading, 0);
      line.position.set(p.x, p.y + 0.03, p.z);
      this.group.add(line);
    };
    // Lap line (closed tracks) or the drag strip's finish line
    const gantryIndex = this.isDrag ? this.finishIndex : 0;
    lineAt(gantryIndex, tex, 1.6);
    if (this.isDrag) {
      const white = canvasTexture(8, 8, (ctx, w, h) => { ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, w, h); });
      lineAt(this.startIndex, white, 0.3);
    }

    // Gantry
    const p = this.points[gantryIndex];
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2d33, metalness: 0.7, roughness: 0.4 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), metal);
      post.position.set(s * (H + 2.5), 3.5, 0);
      post.castShadow = true;
      g.add(post);
    }
    const text = this.def.gantry;
    const beamTex = canvasTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#121214'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff7a00'; ctx.font = `bold ${text.length > 30 ? 36 : 40}px Impact, Arial Black, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + 2);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(H * 2 + 6, 1.6, 0.5), [
      metal, metal, metal, metal,
      new THREE.MeshBasicMaterial({ map: beamTex }), new THREE.MeshBasicMaterial({ map: beamTex }),
    ]);
    beam.position.y = 7;
    g.add(beam);
    g.position.set(p.x, p.y, p.z);
    // Posts sit along local X: rotate so local X = track right vector
    const r = this.rights[gantryIndex];
    g.rotation.y = Math.atan2(-r.z, r.x);
    this.group.add(g);
  }

  /** Place an object beside the track: local +X points away from it, sitting on the ground. */
  placeAlong(index, side, dist, obj) {
    const p = this.points[index], r = this.rights[index], t = this.tangents[index];
    const x = p.x + r.x * side * dist, z = p.z + r.z * side * dist;
    obj.position.set(x, this.height(x, z), z);
    obj.rotation.y = Math.atan2(t.x, t.z) + (side > 0 ? Math.PI : 0);
    this.group.add(obj);
  }

  buildScenery() {
    const rand = this.rand;
    // Grandstands along the outside of the main straight
    const crowd = canvasTexture(256, 128, (ctx, w, h) => {
      ctx.fillStyle = '#2a2d36'; ctx.fillRect(0, 0, w, h);
      const cols = ['#c0392b', '#f1c40f', '#ecf0f1', '#2980b9', '#e67e22', '#27ae60', '#8e44ad', '#111'];
      for (let row = 0; row < 16; row++) for (let i = 0; i < 64; i++) {
        if (rand() < 0.15) continue;
        ctx.fillStyle = cols[(rand() * cols.length) | 0];
        ctx.fillRect(i * 4 + rand(), row * 8 + 2, 3, 4);
        ctx.fillStyle = '#d9b48f';
        ctx.fillRect(i * 4 + 0.5, row * 8, 2, 2);
      }
    }, 6, 1);
    const standMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.92 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xd8dadf, roughness: 0.4, metalness: 0.6 });
    this.mats = { concrete, roofMat };
    const stepMats = [concrete, standMat, standMat, concrete, concrete, concrete];
    const mkStand = (len) => {
      const g = new THREE.Group();
      const rows = 8;
      for (let i = 0; i < rows; i++) {
        const hgt = 1 + i * 1.1;
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.6, hgt + 2, len), stepMats);
        step.position.set(i * 1.6 + 1, hgt / 2 - 1, 0);   // extends 2 m into the ground (slopes)
        g.add(step);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, rows * 1.4 + 5, len), concrete);
      back.position.set(rows * 1.6 + 1, (rows * 1.4 + 3) / 2 - 1, 0);
      g.add(back);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(rows * 1.6 + 4, 0.4, len + 2), roofMat);
      roof.position.set(rows * 0.8 + 1, rows * 1.4 + 3, 0);
      roof.rotation.z = -0.06;
      roof.castShadow = true;
      g.add(roof);
      g.traverse(o => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = true; } });
      mergeByMaterial(g);
      return g;
    };
    const at = (along) => this.wrap(this.startIndex + Math.round(along / this.ds));
    const off = (this.isDrag ? this.half + 3 : WALL_OFFSET) + 3;
    for (const [along, side, len] of this.def.stands) this.placeAlong(at(along), side, off, mkStand(len));

    if (!this.def.pit) return;
    // Pit building on the inside of the main straight
    const pitTex = canvasTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#e4e4e0'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = '#2b3a4a'; ctx.fillRect(i * 32 + 4, 10, 24, 44);
        ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(i * 32 + 4, 10, 10, 44);
      }
    }, 4, 1);
    const pit = new THREE.Mesh(new THREE.BoxGeometry(6, 7, 240), [
      new THREE.MeshStandardMaterial({ map: pitTex, roughness: 0.3 }), new THREE.MeshStandardMaterial({ map: pitTex, roughness: 0.3 }),
      roofMat, concrete, concrete, concrete,
    ]);
    pit.position.y = 1.5;
    pit.castShadow = true;
    const pitG = new THREE.Group();
    pitG.add(pit);
    this.placeAlong(at(this.def.pit[0]), this.def.pit[1], WALL_OFFSET + 5, pitG);
  }

  // ---------------------------------------------------------------- drag strip furniture
  buildDragStrip() {
    const H = this.half;
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2d33, metalness: 0.7, roughness: 0.4 });
    // Lane edge lines and a dashed centre guide line
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 });
    const p0 = this.points[0], t = this.tangents[0], heading = Math.atan2(t.x, t.z);
    const len = this.length;
    for (const o of [-H + 0.4, H - 0.4]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.18, len), lineMat);
      m.rotation.order = 'YXZ'; m.rotation.set(-Math.PI / 2, heading, 0);
      const r = this.rights[0];
      m.position.set(p0.x + t.x * len / 2 + r.x * o, 0.028, p0.z + t.z * len / 2 + r.z * o);
      this.group.add(m);
    }

    // Distance boards: 60 ft, 330 ft, 1/8 mile, 1000 ft, finish
    const sign = (label, along, side = -1) => {
      const tex = canvasTexture(256, 128, (ctx, w, h) => {
        ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, w - 12, h - 12);
        ctx.fillStyle = '#ffd400'; ctx.font = 'bold 56px Impact, Arial Black, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, w / 2, h / 2 + 4);
      });
      const g = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 4), [new THREE.MeshBasicMaterial({ map: tex }), new THREE.MeshBasicMaterial({ map: tex }), metal, metal, metal, metal]);
      board.position.set(0, 3.2, 0);
      g.add(board);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.4, 0.25), metal);
      post.position.y = 1.2;
      g.add(post);
      const i = this.wrap(this.startIndex + Math.round(along / this.ds));
      this.placeAlong(i, side, H + 3.6, g);
      g.rotation.y += Math.PI / 2;   // face the approaching car
    };
    sign('60 FT', 18.29); sign('330 FT', 100.58); sign('1/8 MILE', 201.17); sign('1000 FT', 304.8); sign('1/4 MILE', DRAG_LENGTH);
    sign('SHUTDOWN', DRAG_LENGTH + 120, 1);

    // Christmas tree: between the lanes' edge, a little ahead of the start line, facing the driver
    const tree = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 0.3), metal);
    pole.position.y = 1.3;
    tree.add(pole);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.9, 0.35), metal);
    housing.position.y = 3.6;
    tree.add(housing);
    const bulb = (color) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 0.05, roughness: 0.3 });
    const lamps = { stage: [], amber: [], green: [], red: [] };
    const rows = [['stage', 0xfff6c8, 4.75], ['stage', 0xfff6c8, 4.5], ['amber', 0xffa000, 4.1], ['amber', 0xffa000, 3.6], ['amber', 0xffa000, 3.1], ['green', 0x22ff44, 2.6], ['red', 0xff1010, 2.15]];
    const lampGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16).rotateX(Math.PI / 2);
    for (const [kind, color, y] of rows) {
      const m = bulb(color);
      for (const x of [-0.22, 0.22]) {
        const l = new THREE.Mesh(lampGeo, m);
        l.position.set(x, y, -0.2);
        tree.add(l);
      }
      lamps[kind].push(m);
    }
    const sIdx = this.startIndex + Math.round(9 / this.ds);
    this.placeAlong(sIdx, -1, H + 1.2, tree);
    tree.rotation.y += Math.PI / 2;
    this.treeLamps = lamps;

    // Timing tower past the finish: shows the last ET and trap speed (canvas texture, redrawn per run)
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const boardTex = new THREE.CanvasTexture(c);
    boardTex.colorSpace = THREE.SRGBColorSpace;
    this.timing = { canvas: c, tex: boardTex };
    this.setTimingBoard(null);
    const tower = new THREE.Group();
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 8), [new THREE.MeshBasicMaterial({ map: boardTex }), new THREE.MeshBasicMaterial({ map: boardTex }), metal, metal, metal, metal]);
    face.position.y = 7.5;
    tower.add(face);
    for (const z of [-3, 3]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5.5, 0.4), metal);
      leg.position.set(0, 2.75, z);
      tower.add(leg);
    }
    this.placeAlong(this.wrap(this.finishIndex + Math.round(40 / this.ds)), 1, H + 6, tower);
    tower.rotation.y += Math.PI / 2;
  }

  /** Tree lamps: { stage, amber (0-3 lit), green, red } */
  setTree(state) {
    if (!this.treeLamps) return;
    const L = this.treeLamps, on = (m, v) => { m.emissiveIntensity = v ? 3 : 0.05; };
    L.stage.forEach(m => on(m, state.stage));
    L.amber.forEach((m, i) => on(m, state.amber > i));
    on(L.green[0], state.green);
    on(L.red[0], state.red);
  }

  setTimingBoard(run) {
    if (!this.timing) return;
    const { canvas: c, tex } = this.timing, g = c.getContext('2d');
    g.fillStyle = '#070708'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#333'; g.lineWidth = 6; g.strokeRect(3, 3, c.width - 6, c.height - 6);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ff7a00'; g.font = 'bold 30px Impact, Arial Black, sans-serif';
    g.fillText('ELAPSED TIME', c.width / 2, 34);
    g.fillStyle = '#ff2a1a'; g.font = 'bold 110px "Courier New", monospace';
    g.fillText(run ? run.et.toFixed(3) : '--.---', c.width / 2, 120);
    g.fillStyle = '#ffd400'; g.font = 'bold 44px "Courier New", monospace';
    g.fillText(run ? run.trap : '--- KM/H', c.width / 2, 210);
    tex.needsUpdate = true;
  }
}
