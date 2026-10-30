// Procedural 1979 Dodge Charger body — built in the chassis frame (origin = CoM, forward = -Z).
import * as THREE from '../vendor/three.module.min.js';

export const PAINTS = {
  red: { name: 'Charger Red', color: 0x7a0910 },
  black: { name: 'Tuxedo Black', color: 0x0c0c0f },
  orange: { name: 'Hemi Orange', color: 0xe0530d },
  green: { name: 'Sublime', color: 0x58b51c },
  blue: { name: 'B5 Blue', color: 0x1f5fb8 },
  white: { name: 'Bright White', color: 0xe8e8e4 },
};

function extrudeProfile(points, depth, bevel) {
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

export class CarModel {
  constructor(vehicle, envMap) {
    this.vehicle = vehicle;
    const spec = vehicle.spec;
    const cg = spec.cgHeight;
    const Y = (h) => h - cg;   // ground height → chassis-local Y
    const zf = vehicle.frontAxleZ, zr = vehicle.rearAxleZ;
    const zF = vehicle.bodyZFront, zR = vehicle.bodyZRear;

    this.root = new THREE.Group();     // follows the physics body
    this.body = new THREE.Group();     // visual pitch/roll on top
    this.root.add(this.body);

    this.paint = new THREE.MeshPhysicalMaterial({
      color: PAINTS.red.color, metalness: 0.3, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.06, envMap,
      envMapIntensity: 0.55,
    });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, metalness: 1, roughness: 0.12, envMap });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.75, metalness: 0.2 });
    const vinyl = new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.9 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0d141c, metalness: 0.9, roughness: 0.05, envMap, envMapIntensity: 1.4,
    });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.3 });
    this.reverseMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.9 });

    const add = (geo, mat, x = 0, y = 0, z = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      this.body.add(m);
      return m;
    };

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
    add(extrudeProfile(lower, spec.width, 0.07), this.paint);

    // ---- Greenhouse (glass) + formal roof
    const cabinW = 1.5;
    add(extrudeProfile([[-0.12, Y(0.92)], [0.66, Y(1.33)], [1.32, Y(1.345)], [1.98, Y(0.94)]], cabinW, 0.03), glass);
    // Body-coloured wide C-pillars (opera-window look)
    add(extrudeProfile([[1.15, Y(1.345)], [1.33, Y(1.352)], [1.99, Y(0.945)], [1.42, Y(0.945)]], cabinW + 0.04, 0.02), this.paint);
    // Landau vinyl roof
    add(extrudeProfile([[0.6, Y(1.31)], [0.68, Y(1.362)], [1.32, Y(1.37)], [1.5, Y(1.24)], [1.2, Y(1.32)]], cabinW + 0.06, 0.015), vinyl);
    // A-pillars
    for (const s of [-1, 1]) {
      const p = add(new THREE.BoxGeometry(0.06, 0.88, 0.07), this.paint, s * 0.735, Y(1.125), 0.27);
      p.rotation.x = Math.atan2(0.78, 0.41);   // follow the windshield rake
    }

    // ---- Hood: power bulge + 6-71 blower with scoop
    add(new THREE.BoxGeometry(0.75, 0.05, 1.6), this.paint, 0, Y(0.92), -1.15);
    add(new THREE.BoxGeometry(0.46, 0.2, 0.62), chrome, 0, Y(1.05), -1.0);
    for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(0.48, 0.018, 0.64), black, 0, Y(0.98 + i * 0.035), -1.0, false);
    const scoop = add(new THREE.BoxGeometry(0.42, 0.16, 0.5), black, 0, Y(1.23), -1.04);
    scoop.rotation.x = 0.06;
    add(new THREE.BoxGeometry(0.36, 0.1, 0.02), new THREE.MeshBasicMaterial({ color: 0x020202 }), 0, Y(1.24), -1.3, false);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.13, 0.03), chrome, s * 0.1, Y(1.24), -1.3, false);

    // ---- Front end
    add(new THREE.BoxGeometry(1.62, 0.3, 0.06), black, 0, Y(0.62), zF - 0.02);
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
    add(new THREE.BoxGeometry(1.7, 0.16, 0.05), this.tailMat, 0, Y(0.72), zR + 0.07, false);
    add(new THREE.BoxGeometry(0.2, 0.08, 0.05), this.reverseMat, 0, Y(0.72), zR + 0.08, false);
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
    // Underbody shadow plane & chassis
    add(new THREE.BoxGeometry(spec.width - 0.2, 0.08, spec.length - 1.1), black, 0, Y(0.25), (zF + zR) / 2, false);

    // ---- Wheels (Magnum 500 style), placed by physics each frame
    this.wheels = [];
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.85 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9cacc, metalness: 1, roughness: 0.22, envMap });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x8b0000, metalness: 0.6, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      const w = rear ? spec.tyreWidthRear : spec.tyreWidthFront;
      const r = spec.wheelRadius;
      const outer = new THREE.Group();   // steering + position
      const spin = new THREE.Group();    // rolling
      outer.add(spin);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28, 1, true), tyreMat);
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      spin.add(tyre);
      // raised white letters band
      const band = new THREE.Mesh(new THREE.RingGeometry(r * 0.66, r * 0.995, 28), wallMat);
      const band2 = band.clone();
      band.rotation.y = Math.PI / 2; band.position.x = w / 2;
      band2.rotation.y = -Math.PI / 2; band2.position.x = -w / 2;
      spin.add(band, band2);
      const side = i % 2 === 0 ? -1 : 1;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.66, r * 0.66, w * 0.9, 20), rimMat);
      barrel.rotation.z = Math.PI / 2;
      spin.add(barrel);
      const face = side * (w / 2 + 0.003);
      for (let k = 0; k < 5; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, r * 0.52, 0.07), rimMat);
        spoke.position.set(face, 0, 0);
        spoke.geometry.translate(0, r * 0.3, 0);
        spoke.rotation.x = k * Math.PI * 2 / 5;
        spin.add(spoke);
      }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 14), capMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = face + side * 0.01;
      spin.add(cap);
      const dish = new THREE.Mesh(new THREE.RingGeometry(r * 0.58, r * 0.66, 24), rimMat);
      dish.rotation.y = side * Math.PI / 2;
      dish.position.x = face;
      spin.add(dish);
      this.root.add(outer);
      this.wheels.push({ outer, spin, angle: 0 });
    }

    // Visual suspension feel
    this.pitch = 0;
    this.roll = 0;
    this._prevVel = new THREE.Vector3();
    this._acc = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qInv = new THREE.Quaternion();
  }

  setPaint(key) {
    const p = PAINTS[key] || PAINTS.red;
    this.paint.color.setHex(p.color);
  }

  sync(dt) {
    const v = this.vehicle, b = v.body;
    this.root.position.set(b.position.x, b.position.y, b.position.z);
    this.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.root.updateMatrixWorld();

    // Body pitch / roll from local acceleration (exaggerates weight transfer)
    if (dt > 0) {
      const vel = this._acc.set(b.velocity.x, b.velocity.y, b.velocity.z);
      const acc = vel.clone().sub(this._prevVel).divideScalar(dt);
      this._prevVel.copy(vel);
      this._qInv.copy(this.root.quaternion).invert();
      acc.applyQuaternion(this._qInv);
      const aLong = -acc.z, aLat = acc.x;
      const k = Math.min(1, dt * 6);
      this.pitch += (THREE.MathUtils.clamp(aLong * 0.0055, -0.06, 0.05) - this.pitch) * k;
      this.roll += (THREE.MathUtils.clamp(aLat * 0.0065, -0.07, 0.07) - this.roll) * k;
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

    // Lights
    const braking = v.brakeInput > 0.05;
    this.tailMat.emissiveIntensity = braking ? 2.4 : 0.35;
    this.reverseMat.emissiveIntensity = v.drivetrain.gear === -1 ? 2 : 0;
  }
}
