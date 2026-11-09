// Procedural car bodies (1979 Dodge Charger here, the GT-R and Sentra in bodies.js) — built in the
// chassis frame (origin = CoM, forward = -Z), plus wheels, contact shadow and exhaust flames.
import * as THREE from '../vendor/three.module.min.js';
import { rng, flakeNormalMap, contactShadowTexture } from './textures.js';
import { mergeByMaterial } from './merge.js';
import { extrudeProfile, buildGTR, buildSentra, grilleTexture } from './bodies.js';

// Wheel styles: spokes on the rim face, materials, centre cap and (optional) brake calipers
const UP = new THREE.Vector3(0, 1, 0);
const CHARGER_RIM = { spokes: 5, spokeW: 0.07, spokeT: 0.03, color: 0xd4d5d8, rough: 0.16, cap: 0x8b0000, dish: true };

// metal = metallic-flake content of the base coat (solid colours are low)
export const PAINTS = {
  red: { name: 'Charger Red', color: 0x8e0a12, metal: 0.18, rough: 0.4 },
  black: { name: 'Tuxedo Black', color: 0x0a0a0d, metal: 0.25, rough: 0.22 },
  orange: { name: 'Hemi Orange', color: 0xe0530d, metal: 0.15, rough: 0.38 },
  green: { name: 'Sublime', color: 0x58b51c, metal: 0.15, rough: 0.38 },
  blue: { name: 'B5 Blue', color: 0x1f5fb8, metal: 0.6, rough: 0.32 },
  white: { name: 'Bright White', color: 0xe8e8e4, metal: 0.05, rough: 0.4 },
};

function buildCharger(c) {
  const { add, Y, spec, zf, zr, zF, zR, paint, chrome, black, vinyl, glass, tailMat, reverseMat, headMat, interior } = c;
  // ---- Lower body (side profile with wheel arches)
  const ar = 0.44, hub = spec.wheelRadius;
  const lower = [
    [zF + 0.05, Y(0.24)],
    [zf - ar, Y(0.24)], [zf - ar, Y(hub)], { arc: [zf, Y(hub), ar] }, [zf + ar, Y(0.24)],
    [zr - ar, Y(0.24)], [zr - ar, Y(hub)], { arc: [zr, Y(hub), ar] }, [zr + ar, Y(0.24)],
    [zR - 0.08, Y(0.27)], [zR, Y(0.42)], [zR, Y(0.86)], [zR - 0.06, Y(0.93)],
    [1.78, Y(0.955)], [-0.15, Y(0.93)], [zF + 0.2, Y(0.85)], [zF + 0.02, Y(0.79)],
    [zF - 0.03, Y(0.62)], [zF, Y(0.3)],
  ];
  add(extrudeProfile(lower, spec.width, 0.07), paint);

  // ---- Cabin interior (seen through the glass): seats, headrests, dash, rear deck
  const trim = c.trim;
  const inside = (geo, x, y, z) => { const m = new THREE.Mesh(geo, trim); m.position.set(x, y, z); interior.add(m); return m; };
  for (const s of [-1, 1]) {
    inside(new THREE.BoxGeometry(0.5, 0.12, 0.5), s * 0.36, Y(0.62), 0.78);
    const back = inside(new THREE.BoxGeometry(0.5, 0.62, 0.12), s * 0.36, Y(0.95), 1.06);
    back.rotation.x = -0.22;
    inside(new THREE.BoxGeometry(0.26, 0.2, 0.1), s * 0.36, Y(1.32), 1.13);
  }
  inside(new THREE.BoxGeometry(1.4, 0.4, 0.55), 0, Y(1.0), 1.55);           // rear seat back
  inside(new THREE.BoxGeometry(1.5, 0.12, 0.42), 0, Y(0.95), -0.02);        // dashboard
  inside(new THREE.BoxGeometry(1.5, 0.05, 0.6), 0, Y(0.96), 1.78);          // parcel shelf
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 24), trim);
  wheel.position.set(-0.36, Y(1.02), 0.25); wheel.rotation.x = -1.1;
  interior.add(wheel);

  // ---- Greenhouse (glass) + formal roof
  const cabinW = 1.5;
  const greenhouse = add(extrudeProfile([[-0.12, Y(0.92)], [0.66, Y(1.33)], [1.32, Y(1.345)], [1.98, Y(0.94)]], cabinW, 0.03), glass);
  greenhouse.castShadow = true;
  greenhouse.renderOrder = 2;
  // Body-coloured wide C-pillars (opera-window look)
  add(extrudeProfile([[1.15, Y(1.345)], [1.33, Y(1.352)], [1.99, Y(0.945)], [1.42, Y(0.945)]], cabinW + 0.04, 0.02), paint);
  // Landau vinyl roof
  add(extrudeProfile([[0.6, Y(1.31)], [0.68, Y(1.362)], [1.32, Y(1.37)], [1.5, Y(1.24)], [1.2, Y(1.32)]], cabinW + 0.06, 0.015), vinyl);
  // A-pillars
  for (const s of [-1, 1]) {
    const p = add(new THREE.BoxGeometry(0.06, 0.88, 0.07), paint, s * 0.735, Y(1.125), 0.27);
    p.rotation.x = Math.atan2(0.78, 0.41);   // follow the windshield rake
  }

  // ---- Hood: power bulge, plus the 6-71 blower and scoop when the build has a supercharger
  add(new THREE.BoxGeometry(0.75, 0.05, 1.6), paint, 0, Y(0.92), -1.15);
  if (spec.blower !== false) {
    add(new THREE.BoxGeometry(0.46, 0.2, 0.62), chrome, 0, Y(1.05), -1.0);
    for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(0.48, 0.018, 0.64), black, 0, Y(0.98 + i * 0.035), -1.0, false);
    const scoop = add(new THREE.BoxGeometry(0.42, 0.16, 0.5), black, 0, Y(1.23), -1.04);
    scoop.rotation.x = 0.06;
    add(new THREE.BoxGeometry(0.36, 0.1, 0.02), new THREE.MeshBasicMaterial({ color: 0x020202 }), 0, Y(1.24), -1.3, false);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.13, 0.03), chrome, s * 0.1, Y(1.24), -1.3, false);
  } else {
    // NA / turbo: a low shaker-style scoop on the bulge
    const sh = add(new THREE.BoxGeometry(0.5, 0.09, 0.55), black, 0, Y(1.0), -1.1);
    sh.rotation.x = 0.04;
    add(new THREE.BoxGeometry(0.4, 0.06, 0.02), new THREE.MeshBasicMaterial({ color: 0x020202 }), 0, Y(1.01), -1.38, false);
  }

  // ---- Front end
  // Egg-crate grille (chrome bars over black), quad lamps in chrome bezels
  const eggCrate = new THREE.MeshStandardMaterial({ map: grilleTexture('bars', '#c9ccd1'), metalness: 0.9, roughness: 0.25, envMap: c.envMap });
  eggCrate.map.repeat.set(6, 1);
  add(new THREE.BoxGeometry(1.62, 0.3, 0.06), eggCrate, 0, Y(0.62), zF - 0.02);
  for (let i = 0; i < 7; i++) add(new THREE.BoxGeometry(1.6, 0.012, 0.02), chrome, 0, Y(0.5 + i * 0.04), zF - 0.05, false);
  add(new THREE.BoxGeometry(1.7, 0.03, 0.05), chrome, 0, Y(0.785), zF - 0.03, false);
  for (const s of [-1, 1]) for (const k of [0.56, 0.78]) {
    add(new THREE.BoxGeometry(0.18, 0.13, 0.04), headMat, s * k, Y(0.66), zF - 0.06, false);
    add(new THREE.BoxGeometry(0.21, 0.16, 0.03), chrome, s * k, Y(0.66), zF - 0.045, false);
  }
  add(new THREE.BoxGeometry(spec.width + 0.02, 0.17, 0.2), chrome, 0, Y(0.37), zF - 0.06);
  add(new THREE.BoxGeometry(1.5, 0.1, 0.1), black, 0, Y(0.26), zF + 0.1);

  // ---- Rear end
  // (body bevel pushes the tail panel out by ~6 cm)
  add(new THREE.BoxGeometry(1.7, 0.16, 0.05), tailMat, 0, Y(0.72), zR + 0.07, false);
  add(new THREE.BoxGeometry(0.2, 0.08, 0.05), reverseMat, 0, Y(0.72), zR + 0.08, false);
  add(new THREE.BoxGeometry(1.74, 0.03, 0.06), chrome, 0, Y(0.815), zR + 0.07, false);
  add(new THREE.BoxGeometry(1.74, 0.03, 0.06), chrome, 0, Y(0.625), zR + 0.07, false);
  add(new THREE.BoxGeometry(spec.width + 0.02, 0.17, 0.2), chrome, 0, Y(0.4), zR + 0.06);
  for (const s of [-1, 1]) {
    const tip = add(new THREE.CylinderGeometry(0.05, 0.05, 0.25, 12), chrome, s * 0.62, Y(0.25), zR - 0.02, false);
    tip.rotation.x = Math.PI / 2;
    add(new THREE.CircleGeometry(0.04, 12), new THREE.MeshBasicMaterial({ color: 0x050505 }), s * 0.62, Y(0.25), zR + 0.106, false);
  }

  // ---- Side details: chrome beltline trim, mirrors, door seam
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.015, 0.025, 4.6), chrome, s * (spec.width / 2 + 0.005), Y(0.66), 0.35, false);
    add(new THREE.BoxGeometry(0.01, 0.55, 0.012), black, s * (spec.width / 2 + 0.004), Y(0.6), 0.3, false);
    const mir = add(new THREE.BoxGeometry(0.08, 0.08, 0.13), chrome, s * 0.95, Y(1.0), 0.05);
    mir.rotation.y = s * 0.2;
  }
  return { exhausts: [[-0.62, 0.25, zR + 0.1], [0.62, 0.25, zR + 0.1]] };
}

const BODIES = { charger: buildCharger, gtr: buildGTR, sentra: buildSentra };

export class CarModel {
  constructor(vehicle, envMap) {
    this.vehicle = vehicle;
    const spec = vehicle.spec;
    const cg = spec.cgHeight;
    const drop = spec.rideDrop || 0;   // lowering springs: the body sits lower round the wheels
    const Y = (h) => h - drop - cg;    // ground height → chassis-local Y
    const zf = vehicle.frontAxleZ, zr = vehicle.rearAxleZ;
    const zF = vehicle.bodyZFront, zR = vehicle.bodyZRear;

    this.root = new THREE.Group();     // follows the physics body
    this.body = new THREE.Group();     // visual pitch/roll on top
    this.root.add(this.body);

    // Two-layer automotive paint: flaked metallic base coat under a glossy clear coat
    this.paint = new THREE.MeshPhysicalMaterial({
      color: PAINTS.red.color, metalness: 0.55, roughness: 0.34,
      normalMap: flakeNormalMap(rng(77)), normalScale: new THREE.Vector2(0.35, 0.35),
      clearcoat: 1, clearcoatRoughness: 0.025, envMap, envMapIntensity: 0.8,
    });
    const chrome = new THREE.MeshPhysicalMaterial({ color: 0xf2f2f4, metalness: 1, roughness: 0.06, envMap, envMapIntensity: 1.2 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.6, metalness: 0.2, envMap });
    const vinyl = new THREE.MeshPhysicalMaterial({ color: 0x0e0e0f, roughness: 0.75, sheen: 0.4, sheenRoughness: 0.6, envMap });
    // Tinted safety glass: a dielectric with Fresnel reflections, see-through to the cabin
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x0b1116, metalness: 0, roughness: 0.02, ior: 1.52, specularIntensity: 1, envMap, envMapIntensity: 1.6,
      transparent: true, opacity: 0.84, depthWrite: false,
    });
    this.tailMat = new THREE.MeshPhysicalMaterial({ color: 0x5a0000, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.15, clearcoat: 1, envMap });
    this.reverseMat = new THREE.MeshPhysicalMaterial({ color: 0xcccccc, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.15, clearcoat: 1, envMap });
    const headMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.9, roughness: 0.1, clearcoat: 1, envMap });

    const add = (geo, mat, x = 0, y = 0, z = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      m.receiveShadow = true;
      this.body.add(m);
      return m;
    };

    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.85 });
    this.interior = new THREE.Group();
    this.body.add(this.interior);
    const ctx = {
      add, Y, spec, zf, zr, zF, zR, paint: this.paint, chrome, black, vinyl, glass, trim,
      tailMat: this.tailMat, reverseMat: this.reverseMat, headMat, interior: this.interior, envMap,
    };
    const built = (BODIES[spec.model] || buildCharger)(ctx);
    const rim = built.rim || CHARGER_RIM;

    // Wheel wells: a dark open tube in each arch, so you never see body colour (or daylight) round the tyres
    const wellMat = new THREE.MeshStandardMaterial({ color: 0x070708, roughness: 0.95, side: THREE.DoubleSide });
    const archR = built.arch || 0.44;
    for (const z of [zf, zr]) {
      const well = add(new THREE.CylinderGeometry(archR - 0.012, archR - 0.012, spec.width - 0.06, 24, 1, true), wellMat, 0, Y(spec.wheelRadius), z, false);
      well.rotation.z = Math.PI / 2;
    }

    // Underbody shadow plane & chassis
    add(new THREE.BoxGeometry(spec.width - 0.2, 0.08, spec.length - 1.1), black, 0, Y(0.25), (zF + zR) / 2, false);

    // ---- Wheels (style per car), placed by physics each frame
    this.wheels = [];
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.88, envMap, envMapIntensity: 0.4 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.8, envMap, envMapIntensity: 0.4 });
    const rimMat = new THREE.MeshStandardMaterial({ color: rim.color, metalness: 1, roughness: rim.rough, envMap });
    const capMat = new THREE.MeshPhysicalMaterial({ color: rim.cap, metalness: 0.6, roughness: 0.3, clearcoat: 1, envMap });
    const slickMat = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.6, emissive: 0x332a00 });
    const caliperMat = rim.caliper ? new THREE.MeshPhysicalMaterial({ color: rim.caliper, roughness: 0.35, clearcoat: 1, envMap }) : null;
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      const w = rear ? spec.tyreWidthRear : spec.tyreWidthFront;
      const r = spec.wheelRadius;
      const rr = r * (rim.rimK || 0.66);   // rim radius (low-profile tyres = bigger rims)
      const outer = new THREE.Group();   // steering + position
      const spin = new THREE.Group();    // rolling
      outer.add(spin);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28, 1, true), tyreMat);
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      spin.add(tyre);
      // sidewalls
      const band = new THREE.Mesh(new THREE.RingGeometry(rr, r * 0.995, 28), wallMat);
      const band2 = band.clone();
      band.rotation.y = Math.PI / 2; band.position.x = w / 2;
      band2.rotation.y = -Math.PI / 2; band2.position.x = -w / 2;
      spin.add(band, band2);
      const side = i % 2 === 0 ? -1 : 1;
      if (spec.tyreType === 'slick') {
        // Racing slicks: the compound stripe on the sidewall
        const stripe = new THREE.Mesh(new THREE.RingGeometry(rr + (r - rr) * 0.45, rr + (r - rr) * 0.6, 28), slickMat);
        stripe.rotation.y = side * Math.PI / 2; stripe.position.x = side * (w / 2 + 0.002);
        spin.add(stripe);
      }
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, w * 0.9, 20), rimMat);
      barrel.rotation.z = Math.PI / 2;
      spin.add(barrel);
      const face = side * (w / 2 + 0.003);
      for (let k = 0; k < rim.spokes; k++) {
        for (const tw of rim.split ? [-0.09, 0.09] : [0]) {
          const spoke = new THREE.Mesh(new THREE.BoxGeometry(rim.spokeT, rr * 0.8, rim.spokeW), rimMat);
          spoke.position.set(face, 0, 0);
          spoke.geometry.translate(0, rr * 0.46, 0);
          spoke.rotation.x = k * Math.PI * 2 / rim.spokes + tw;
          spin.add(spoke);
        }
      }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(rr * 0.24, rr * 0.24, 0.03, 14), capMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = face + side * 0.01;
      spin.add(cap);
      if (rim.dish) {
        const dish = new THREE.Mesh(new THREE.RingGeometry(rr * 0.88, rr, 24), rimMat);
        dish.rotation.y = side * Math.PI / 2;
        dish.position.x = face;
        spin.add(dish);
      } else {
        const lip = new THREE.Mesh(new THREE.TorusGeometry(rr * 0.97, 0.012, 6, 32), rimMat);
        lip.rotation.y = Math.PI / 2; lip.position.x = face;
        spin.add(lip);
      }
      if (caliperMat) {
        // Big brake caliper behind the spokes (doesn't spin)
        const cal = new THREE.Mesh(new THREE.BoxGeometry(0.07, rr * 0.5, rr * 0.32), caliperMat);
        cal.position.set(side * (w / 2 - 0.06), rr * 0.55, rr * 0.4);
        cal.rotation.x = -0.6;
        outer.add(cal);
      }
      mergeByMaterial(spin);
      this.root.add(outer);
      this.wheels.push({ outer, spin, angle: 0 });
    }
    mergeByMaterial(this.body);
    mergeByMaterial(this.interior);

    // Soft contact shadow / ambient occlusion on the ground under the car (added to the scene by main)
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.width + 0.7, spec.length + 0.9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.9,
        polygonOffset: true, polygonOffsetFactor: -4, color: 0x000000 }),
    );
    this.contact.renderOrder = 1;
    this.contactCenterZ = (zF + zR) / 2;

    // Exhaust flames (nitrous, and short spits on the limiter): additive cones out of each tail pipe
    this.flameMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, amt: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float time; uniform float amt; varying vec2 vUv;
        void main() {
          float v = vUv.y;                                   // 0 at the pipe, 1 at the tip
          vec3 col = mix(vec3(0.45, 0.65, 1.7), vec3(1.8, 0.85, 0.25), smoothstep(0.05, 0.4, v));
          col = mix(col, vec3(1.2, 0.3, 0.05), smoothstep(0.55, 1.0, v));
          float lick = 0.65 + 0.35 * sin(time * 70.0 + vUv.x * 25.0 + v * 9.0);
          float a = pow(1.0 - v, 1.4) * lick * amt;
          gl_FragColor = vec4(col * a, a);
        }`,
    });
    const flameGeo = new THREE.ConeGeometry(0.075, 1, 14, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    this.flames = [];
    for (const [x, h, z] of built.exhausts) {
      const f = new THREE.Mesh(flameGeo, this.flameMat);
      f.position.set(x, Y(h), z);
      f.renderOrder = 6;
      f.frustumCulled = false;
      f.visible = false;
      this.body.add(f);
      this.flames.push(f);
    }
    this.flame = 0;   // 0..1, set by the game each frame

    // Visual suspension feel
    this.pitch = 0;
    this.roll = 0;
    this._prevVel = new THREE.Vector3();
    this._acc = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qInv = new THREE.Quaternion();
    this._n = new THREE.Vector3();
    this._wc = new THREE.Vector3();
    this._groundN = new THREE.Vector3(0, 1, 0);
    this._groundY = 0;
    this._qYaw = new THREE.Quaternion();
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.red;
    this.paint.color.setHex(p.color);
    this.paint.metalness = p.metal;
    this.paint.roughness = p.rough;
  }

  sync(dt) {
    const v = this.vehicle, b = v.body;
    this.root.position.set(b.position.x, b.position.y, b.position.z);
    this.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.root.updateMatrixWorld();

    // Contact shadow follows yaw, lies on the ground under the wheels (tilted with the slope on
    // hilly tracks) and fades as the car leaves the ground
    const yaw = Math.atan2(2 * (b.quaternion.x * b.quaternion.z + b.quaternion.w * b.quaternion.y),
      1 - 2 * (b.quaternion.x * b.quaternion.x + b.quaternion.y * b.quaternion.y));
    const cz = this.contactCenterZ;
    const wis = v.vehicle.wheelInfos;
    let n = 0, gy = 0;
    const nrm = this._n.set(0, 0, 0);
    for (const w of wis) {
      if (!w.raycastResult.body) continue;
      gy += w.raycastResult.hitPointWorld.y;
      const hn = w.raycastResult.hitNormalWorld;
      nrm.x += hn.x; nrm.y += hn.y; nrm.z += hn.z;
      n++;
    }
    if (n) { this._groundY = gy / n; this._groundN.copy(nrm.normalize()); }
    const cx = b.position.x + Math.sin(yaw) * cz, czw = b.position.z + Math.cos(yaw) * cz;
    const gN = this._groundN;
    // Height at the shadow centre on the (locally planar) ground through the wheel contacts
    const wc = this._wc.set(0, 0, 0);
    if (n) { for (const w of wis) if (w.raycastResult.body) wc.add(w.raycastResult.hitPointWorld); wc.divideScalar(n); } else wc.set(cx, this._groundY, czw);
    const yC = wc.y - (gN.x * (cx - wc.x) + gN.z * (czw - wc.z)) / Math.max(0.3, gN.y);
    this.contact.position.set(cx + gN.x * 0.035, yC + gN.y * 0.035, czw + gN.z * 0.035);
    this.contact.quaternion.setFromUnitVectors(UP, gN).multiply(this._qYaw.setFromAxisAngle(UP, yaw));
    const air = Math.max(0, b.position.y - this._groundY - this.vehicle.spec.cgHeight - 0.05);
    this.contact.material.opacity = 0.9 * Math.max(0, 1 - air * 1.5);

    // Body pitch / roll from local acceleration (exaggerates weight transfer)
    if (dt > 0) {
      const vel = this._acc.set(b.velocity.x, b.velocity.y, b.velocity.z);
      const acc = vel.clone().sub(this._prevVel).divideScalar(dt);
      this._prevVel.copy(vel);
      this._qInv.copy(this.root.quaternion).invert();
      acc.applyQuaternion(this._qInv);
      const aLong = -acc.z, aLat = acc.x;
      const k = Math.min(1, dt * 6);
      const rv = this.vehicle.spec.rollVisual || 1;   // lowered: stiffer, much less body roll
      this.pitch += (THREE.MathUtils.clamp(aLong * 0.0055 * rv, -0.06, 0.05) - this.pitch) * k;
      this.roll += (THREE.MathUtils.clamp(aLat * 0.0065 * rv, -0.07, 0.07) - this.roll) * k;
      this.body.rotation.set(this.pitch, 0, this.roll);
    }

    // Wheels
    const wi = v.vehicle.wheelInfos;
    for (let i = 0; i < 4; i++) {
      v.vehicle.updateWheelTransform(i);
      const t = wi[i].worldTransform.position;
      const w = this.wheels[i];
      const local = new THREE.Vector3(t.x, t.y, t.z);
      this.root.worldToLocal(local);
      w.outer.position.copy(local);
      w.outer.rotation.set(0, i < 2 ? wi[i].steering : 0, 0);
      w.angle -= v.wheelSpin[i] * dt;
      w.spin.rotation.x = w.angle;
    }

    // Exhaust flames: flicker in length and width every frame
    const fl = this.flame;
    this.flameMat.uniforms.amt.value = fl;
    this.flameMat.uniforms.time.value += dt;
    for (const f of this.flames) {
      f.visible = fl > 0.02;
      if (f.visible) {
        const w = 0.8 + Math.random() * 0.6;
        f.scale.set(w, w, (0.55 + Math.random() * 0.9) * (0.4 + 0.8 * fl));
      }
    }

    // Lights
    const braking = v.brakeInput > 0.05;
    this.tailMat.emissiveIntensity = braking ? 2.4 : 0.35;
    this.reverseMat.emissiveIntensity = v.drivetrain.gear === -1 ? 2 : 0;
  }
}
