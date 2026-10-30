// Closed circuit: road ribbon, curbs, barriers (visual + physics), scenery.
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

export const ROAD_HALF = 7;
const CURB_W = 1.3;
const WALL_OFFSET = 16;
const SPACING = 2;

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
  constructor(scene, world, materials, quality = 'high') {
    this.scene = scene;
    const curve = new THREE.CatmullRomCurve3(LAYOUT.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
    this.curve = curve;
    this.length = curve.getLength();
    const N = Math.round(this.length / SPACING);
    this.N = N;
    this.ds = this.length / N;

    this.points = [];
    this.tangents = [];
    this.rights = [];
    this.curvature = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u).setY(0).normalize();
      this.points.push(p);
      this.tangents.push(t);
      this.rights.push(new THREE.Vector3(-t.z, 0, t.x));
    }
    for (let i = 0; i < N; i++) {
      const a = this.tangents[(i - 2 + N) % N], b = this.tangents[(i + 2) % N];
      const cross = a.x * b.z - a.z * b.x;
      this.curvature[i] = Math.asin(Math.max(-1, Math.min(1, cross))) / (4 * this.ds);
    }

    this.rand = rng(1979);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.buildGround();
    this.buildRoad();
    this.buildCurbs();
    this.buildWalls(world, materials);
    this.buildStartLine();
    this.buildScenery();
    this.billboards = buildBillboards(this, this.group);
    buildTrees(this, this.group, this.rand, quality, this.billboards.spots);
    buildGrassTufts(this, this.group, this.rand, quality);
    buildMountains(this.group, this.rand);
    this.time = 0;
  }

  update(dt, camera) {
    this.time += dt;
    windUniforms.uTime.value = this.time;
    this.billboards.update(dt, this.time);
    updateLOD(camera.position);
  }

  /** Spawn transform: on the grid a little behind the start line. */
  spawn(back = 12) {
    const i = (this.N - Math.round(back / this.ds)) % this.N;
    const p = this.points[i], t = this.tangents[i];
    return { x: p.x, y: 0, z: p.z, heading: Math.atan2(-t.x, -t.z), index: i };
  }

  spawnAt(index) {
    const i = ((index % this.N) + this.N) % this.N;
    const p = this.points[i], t = this.tangents[i];
    return { x: p.x, y: 0, z: p.z, heading: Math.atan2(-t.x, -t.z), index: i };
  }

  /** Nearest centreline sample around a hint index. */
  query(x, z, hint = -1) {
    const N = this.N;
    let best = -1, bestD = Infinity;
    const scan = (from, to, step) => {
      for (let k = from; k <= to; k += step) {
        const i = ((k % N) + N) % N;
        const p = this.points[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    };
    if (hint >= 0) scan(hint - 40, hint + 40, 1);
    if (hint < 0 || bestD > 60 * 60) { bestD = Infinity; scan(0, N - 1, 4); scan(best - 6, best + 6, 1); }
    const p = this.points[best], r = this.rights[best];
    const lateral = (x - p.x) * r.x + (z - p.z) * r.z;
    return { index: best, lateral, dist: Math.abs(lateral) };
  }

  buildGround() {
    const { map, macro } = grassTextures(this.rand);
    map.repeat.set(260, 260);
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
    // Break up tiling with two layers of low-frequency colour variation
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.macroMap = { value: macro };
      sh.fragmentShader = 'uniform sampler2D macroMap;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        vec3 macA = texture2D(macroMap, vMapUv * 0.0371).rgb;
        vec3 macB = texture2D(macroMap, vMapUv * 0.0083 + 0.31).rgb;
        diffuseColor.rgb *= macA * macB * 1.6;`);
    };
    // Subdivided: one giant triangle pair loses depth precision against the road on many GPUs
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000, 64, 64), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  ribbon(offsetA, offsetB, y, vScale, mask = null) {
    // Build a strip between two lateral offsets along the centreline.
    const N = this.N;
    const pos = [], uv = [], idx = [];
    let dist = 0, vi = 0;
    for (let i = 0; i <= N; i++) {
      const k = i % N;
      const p = this.points[k], r = this.rights[k];
      pos.push(p.x + r.x * offsetA, y, p.z + r.z * offsetA, p.x + r.x * offsetB, y, p.z + r.z * offsetB);
      uv.push(0, dist / vScale, 1, dist / vScale);
      if (i > 0 && (!mask || mask(k))) {
        // Wind counter-clockwise seen from above so the strip faces up
        if (offsetA < offsetB) idx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
        else idx.push(vi - 2, vi, vi - 1, vi - 1, vi, vi + 1);
      }
      vi += 2;
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
    const tex = asphaltTextures(this.rand);
    const road = new THREE.Mesh(
      this.ribbon(-ROAD_HALF, ROAD_HALF, 0.02, ROAD_HALF * 2),
      new THREE.MeshStandardMaterial({
        map: tex.map, roughnessMap: tex.roughnessMap, bumpMap: tex.bumpMap, bumpScale: 1.2, roughness: 1, metalness: 0,
        envMapIntensity: 0.7,
      }),
    );
    road.receiveShadow = true;
    this.group.add(road);

    // Rubber laid down in the braking zones before every real corner
    const N = this.N, brake = new Uint8Array(N), TH = 1 / 160;
    for (let i = 0; i < N; i++) {
      const c = Math.abs(this.curvature[i]) > TH, p = Math.abs(this.curvature[(i - 1 + N) % N]) > TH;
      if (c && !p) for (let k = -70; k <= 12; k++) brake[(i + k + N) % N] = 1;
    }
    const skid = new THREE.Mesh(
      this.ribbon(-ROAD_HALF + 0.6, ROAD_HALF - 0.6, 0.026, 44, (k) => brake[k]),
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
      const m = new THREE.Mesh(this.ribbon(s * (ROAD_HALF + CURB_W), s * (ROAD_HALF + CURB_W + 2.2), 0.012, 4), verge);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  buildCurbs() {
    const N = this.N;
    const corner = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (Math.abs(this.curvature[i]) > 1 / 320) {
        for (let k = -6; k <= 6; k++) corner[(i + k + N) % N] = 1;
      }
    }
    const pos = [], col = [];
    const red = new THREE.Color(0xc8102e), white = new THREE.Color(0xf2f2f2);
    for (const side of [-1, 1]) {
      const a = side * ROAD_HALF, b = side * (ROAD_HALF + CURB_W);
      for (let i = 0; i < N; i++) {
        if (!corner[i]) continue;
        const j = (i + 1) % N;
        const p0 = this.points[i], r0 = this.rights[i], p1 = this.points[j], r1 = this.rights[j];
        const c = (i >> 1) % 2 ? red : white;
        const v = [
          [p0.x + r0.x * a, 0.045, p0.z + r0.z * a], [p0.x + r0.x * b, 0.025, p0.z + r0.z * b],
          [p1.x + r1.x * a, 0.045, p1.z + r1.z * a], [p1.x + r1.x * b, 0.025, p1.z + r1.z * b],
        ];
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
    const N = this.N, m2 = minDist * minDist;
    for (let i = 0; i < N; i += 2) {
      if (skipNear >= 0) {
        const sep = Math.min(Math.abs(i - skipNear), N - Math.abs(i - skipNear));
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
    for (const side of [-1, 1]) {
      let prev = null;
      for (let i = 0; i <= N; i += step) {
        const k = i % N;
        const p = this.points[k], r = this.rights[k];
        const x = p.x + r.x * side * WALL_OFFSET, z = p.z + r.z * side * WALL_OFFSET;
        const ok = this.clearOfTrack(x, z, WALL_OFFSET - 0.5, k);
        const cur = ok ? { x, z } : null;
        if (prev && cur) transforms.push([prev, cur, (i / step) % 2]);
        prev = cur;
      }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1 });
    const inst = new THREE.InstancedMesh(geo, mat, transforms.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const red = new THREE.Color(0xb3202a), white = new THREE.Color(0xe9e9e9);
    const body = new CANNON.Body({ mass: 0, material: materials.wall });
    transforms.forEach(([a, b, alt], n) => {
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) + 0.05;
      const ang = Math.atan2(dx, dz);
      q.setFromAxisAngle(up, ang);
      ps.set((a.x + b.x) / 2, 0.45, (a.z + b.z) / 2);
      sc.set(0.6, 0.9, len);
      m4.compose(ps, q, sc);
      inst.setMatrixAt(n, m4);
      inst.setColorAt(n, alt ? red : white);
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(0.3, 0.9, len / 2)),
        new CANNON.Vec3(ps.x, 0.9, ps.z),
        new CANNON.Quaternion(q.x, q.y, q.z, q.w),
      );
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    this.group.add(inst);
    world.addBody(body);
  }

  buildStartLine() {
    const tex = canvasTexture(128, 32, (ctx, w, h) => {
      const s = h / 4;
      for (let y = 0; y < 4; y++) for (let x = 0; x < w / s; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * s, y * s, s, s);
      }
    });
    const p = this.points[0], t = this.tangents[0];
    const heading = Math.atan2(t.x, t.z);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    line.rotation.order = 'YXZ';
    line.rotation.set(-Math.PI / 2, heading, 0);
    line.position.set(p.x, 0.03, p.z);
    this.group.add(line);

    // Gantry
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2d33, metalness: 0.7, roughness: 0.4 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), metal);
      post.position.set(s * (ROAD_HALF + 2.5), 3.5, 0);
      post.castShadow = true;
      g.add(post);
    }
    const beamTex = canvasTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#121214'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff7a00'; ctx.font = 'bold 40px Impact, Arial Black, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('ARIEL RACEWAY  ·  START / FINISH', w / 2, h / 2 + 2);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 6, 1.6, 0.5), [
      metal, metal, metal, metal,
      new THREE.MeshBasicMaterial({ map: beamTex }), new THREE.MeshBasicMaterial({ map: beamTex }),
    ]);
    beam.position.y = 7;
    g.add(beam);
    g.position.set(p.x, 0, p.z);
    // Posts sit along local X: rotate so local X = track right vector
    g.rotation.y = Math.atan2(-this.rights[0].z, this.rights[0].x);
    this.group.add(g);
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
    const placeAlong = (index, side, dist, obj) => {
      const p = this.points[index], r = this.rights[index], t = this.tangents[index];
      obj.position.set(p.x + r.x * side * dist, 0, p.z + r.z * side * dist);
      // local +X points away from the track
      obj.rotation.y = Math.atan2(t.x, t.z) + (side > 0 ? Math.PI : 0);
      this.group.add(obj);
    };
    const stepMats = [concrete, standMat, standMat, concrete, concrete, concrete];
    const mkStand = (len) => {
      const g = new THREE.Group();
      const rows = 8;
      for (let i = 0; i < rows; i++) {
        const hgt = 1 + i * 1.1;
        const step = new THREE.Mesh(new THREE.BoxGeometry(1.6, hgt, len), stepMats);
        step.position.set(i * 1.6 + 1, hgt / 2, 0);
        g.add(step);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, rows * 1.4 + 3, len), concrete);
      back.position.set(rows * 1.6 + 1, (rows * 1.4 + 3) / 2, 0);
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
    const idx = (x) => this.query(x, 0).index;
    placeAlong(idx(-150), 1, WALL_OFFSET + 3, mkStand(90));
    placeAlong(idx(30), 1, WALL_OFFSET + 3, mkStand(110));
    placeAlong(idx(220), 1, WALL_OFFSET + 3, mkStand(90));

    // Pit building on the inside of the main straight
    const pitTex = canvasTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#e4e4e0'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = '#2b3a4a'; ctx.fillRect(i * 32 + 4, 10, 24, 44);
        ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(i * 32 + 4, 10, 10, 44);
      }
    }, 4, 1);
    const pit = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 240), [
      new THREE.MeshStandardMaterial({ map: pitTex, roughness: 0.3 }), new THREE.MeshStandardMaterial({ map: pitTex, roughness: 0.3 }),
      roofMat, concrete, concrete, concrete,
    ]);
    pit.position.y = 2.5;
    pit.castShadow = true;
    const pitG = new THREE.Group();
    pitG.add(pit);
    placeAlong(idx(0), -1, WALL_OFFSET + 5, pitG);
  }
}
