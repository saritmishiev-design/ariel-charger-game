// Tyre smoke (GPU points) and skid marks (ring-buffer ribbon).
import * as THREE from '../vendor/three.module.min.js';

export class TyreSmoke {
  constructor(scene, max = 220) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; varying float vA; uniform float scale;
        void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c,c);
        if (d > 0.25) discard; float a = vA * smoothstep(0.25, 0.0, d);
        gl_FragColor = vec4(vec3(0.86,0.86,0.88), a); }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  setViewportHeight(h) { this.points.material.uniforms.scale.value = h * 0.9; }

  emit(x, y, z, vx, vz, intensity) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3] = vx * 0.25 + (Math.random() - 0.5) * 1.2;
    this.vel[i * 3 + 1] = 0.5 + Math.random() * 0.9;
    this.vel[i * 3 + 2] = vz * 0.25 + (Math.random() - 0.5) * 1.2;
    this.life[i] = 1.6 + Math.random() * 1.4;
    this.age[i] = 0;
    this.size[i] = 0.6;
    this.alpha[i] = 0.38 * intensity;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      const drag = Math.max(0, 1 - dt * 1.6);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = 0.6 + t * 4.5;
      this.alpha[i] *= t > 0.6 ? Math.max(0, 1 - dt * 2.5) : 1;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
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
