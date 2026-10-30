// Tyre smoke (instanced, sun-shaded billboards) and skid marks (ring-buffer ribbon).
import * as THREE from '../vendor/three.module.min.js';

function puffTexture() {
  // Soft, lumpy smoke puff: overlapping blurred blobs; R = density detail, A = coverage
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = r() * S * 0.2;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, rad = S * (0.14 + r() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const v = 190 + r() * 65;
    g.addColorStop(0, `rgba(${v},${v},${v},0.42)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Billowing 3D tyre smoke: camera-facing, rotating, sun-shaded puffs (instanced quads). */
export class TyreSmoke {
  constructor(scene, max = 700, sunDir = new THREE.Vector3(0.5, 0.42, 0.45).normalize()) {
    this.max = max;
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max).fill(1e9);
    this.spin = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.peak = new Float32Array(max);
    this.next = 0;

    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    g.setAttribute('uv', quad.attributes.uv);
    const attr = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = attr(3); this.aSize = attr(1); this.aAlpha = attr(1); this.aRot = attr(1);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iSize', this.aSize);
    g.setAttribute('iAlpha', this.aAlpha);
    g.setAttribute('iRot', this.aRot);
    g.instanceCount = max;
    this.geo = g;

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: puffTexture() }, sunDir: { value: sunDir } },
      vertexShader: `attribute vec3 iPos; attribute float iSize; attribute float iAlpha; attribute float iRot;
        varying vec2 vUv; varying float vA; varying vec2 vLight;
        uniform vec3 sunDir;
        void main() {
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(iRot), s = sin(iRot);
          vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSize;
          vec3 wp = iPos + camR * p.x + camU * p.y;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          // Fade puffs that would fill the screen right in front of the lens
          vA = iAlpha * smoothstep(0.8, 3.0, -mv.z);
          vUv = uv;
          // Direction toward the sun in sprite space, for one-sided lighting
          vec2 sl = vec2(dot(sunDir, camR), dot(sunDir, camU));
          vLight = vec2(c * sl.x + s * sl.y, -s * sl.x + c * sl.y);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vA; varying vec2 vLight;
        void main() {
          vec4 t = texture2D(map, vUv);
          float a = t.a * vA;
          if (a < 0.004) discard;
          float lit = clamp(0.55 + dot(vUv - 0.5, vLight) * 1.1 + (t.r - 0.85) * 0.8, 0.0, 1.0);
          vec3 col = mix(vec3(0.50, 0.52, 0.56), vec3(0.97, 0.95, 0.92), lit);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  setViewportHeight() { /* world-space quads: nothing to do */ }

  /** Spawn one puff at a tyre contact. (tx, tz) is the direction the tyre throws it. */
  emit(x, y, z, vx, vz, intensity, tx = 0, tz = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const P = this.aPos.array;
    P[i * 3] = x + (Math.random() - 0.5) * 0.35;
    P[i * 3 + 1] = y + Math.random() * 0.15;
    P[i * 3 + 2] = z + (Math.random() - 0.5) * 0.35;
    const throwV = 2 + Math.random() * 3;
    this.vel[i * 3] = vx * 0.35 + tx * throwV + (Math.random() - 0.5) * 1.6;
    this.vel[i * 3 + 1] = 0.8 + Math.random() * 1.0;
    this.vel[i * 3 + 2] = vz * 0.35 + tz * throwV + (Math.random() - 0.5) * 1.6;
    this.life[i] = 2.2 + Math.random() * 1.8;
    this.age[i] = 0;
    this.spin[i] = (Math.random() - 0.5) * 0.9;
    this.aRot.array[i] = Math.random() * 6.28;
    this.grow[i] = 5 + Math.random() * 4;              // final diameter, metres
    this.peak[i] = (0.5 + Math.random() * 0.2) * intensity;
  }

  update(dt) {
    const P = this.aPos.array, S = this.aSize.array, A = this.aAlpha.array, R = this.aRot.array, V = this.vel;
    const drag = Math.max(0, 1 - dt * 1.8);
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) { S[i] = 0; A[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      V[i * 3] *= drag; V[i * 3 + 2] *= drag;
      V[i * 3 + 1] = V[i * 3 + 1] * Math.max(0, 1 - dt * 0.9) + dt * 0.15;   // warm smoke keeps rising slowly
      P[i * 3] += (V[i * 3] + 0.35) * dt;                                      // light breeze
      P[i * 3 + 1] += V[i * 3 + 1] * dt;
      P[i * 3 + 2] += (V[i * 3 + 2] + 0.2) * dt;
      R[i] += this.spin[i] * dt;
      S[i] = 0.7 + (this.grow[i] - 0.7) * (1 - Math.pow(1 - t, 2.2));      // fast billow, then slow spread
      A[i] = this.peak[i] * Math.min(1, t * 8) * Math.pow(1 - t, 1.4);
    }
    this.aPos.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = this.aRot.needsUpdate = true;
  }
}

export class SkidMarks {
  constructor(scene, maxSegments = 1600) {
    this.max = maxSegments;
    this.pos = new Float32Array(maxSegments * 4 * 3);
    this.alpha = new Float32Array(maxSegments * 4);
    const idx = new Uint32Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const v = s * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.03,0.03,0.03, vA); }',
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.next = 0;
    this.last = [null, null, null, null];
  }

  /** Feed the contact point of wheel i; strength 0 breaks the trail. */
  add(i, x, z, rx, rz, width, strength) {
    if (strength <= 0.05) { this.last[i] = null; return; }
    const prev = this.last[i];
    const cur = { x, z, rx, rz, a: Math.min(0.55, strength * 0.6) };
    if (prev) {
      const d = Math.hypot(x - prev.x, z - prev.z);
      if (d < 0.25) return;
      if (d < 3) {
        const s = this.next;
        this.next = (this.next + 1) % this.max;
        const hw = width / 2, y = 0.035;
        const P = this.pos, o = s * 12;
        P[o] = prev.x - prev.rx * hw; P[o + 1] = y; P[o + 2] = prev.z - prev.rz * hw;
        P[o + 3] = prev.x + prev.rx * hw; P[o + 4] = y; P[o + 5] = prev.z + prev.rz * hw;
        P[o + 6] = x - rx * hw; P[o + 7] = y; P[o + 8] = z - rz * hw;
        P[o + 9] = x + rx * hw; P[o + 10] = y; P[o + 11] = z + rz * hw;
        this.alpha.set([prev.a, prev.a, cur.a, cur.a], s * 4);
        this.geo.attributes.position.needsUpdate = true;
        this.geo.attributes.alpha.needsUpdate = true;
      }
    }
    this.last[i] = cur;
  }

  clear() {
    this.alpha.fill(0);
    this.geo.attributes.alpha.needsUpdate = true;
    this.last = [null, null, null, null];
  }
}
