// Procedural sky dome (gradient + Mie glow + drifting fbm clouds + sun disc) and the
// matching image-based-lighting environment map used for paint, chrome and glass.
import * as THREE from '../vendor/three.module.min.js';

// Late-afternoon sun: low enough for long, soft shadows and warm reflections.
export const SUN_DIR = new THREE.Vector3(0.5, 0.42, 0.45).normalize();
export const HORIZON = new THREE.Color(0.74, 0.83, 0.92);

const VERT = `varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // always on the far plane
}`;

const FRAG = `uniform vec3 sunDir; uniform vec3 horizon; uniform float time; uniform float envMode;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < OCTAVES; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y, h = clamp(y, 0.0, 1.0);
  float sd = max(dot(d, sunDir), 0.0);
  vec3 zenith = vec3(0.09, 0.30, 0.70);
  vec3 col = mix(horizon, zenith, pow(h, 0.42));
  col = mix(col, vec3(0.97, 0.90, 0.80), pow(1.0 - h, 10.0) * 0.55 * (0.4 + 0.6 * sd));  // warm haze near the sun
  col += vec3(1.0, 0.82, 0.55) * (pow(sd, 7.0) * 0.22 + pow(sd, 90.0) * 0.6);          // Mie glow

  if (y > 0.0) {
    vec2 uv = d.xz / (y + 0.09) * 1.4 + vec2(time * 0.010, time * 0.004);
    float n = fbm(uv);
    float c = smoothstep(0.52, 0.86, n) * smoothstep(0.05, 0.32, y);           // thin out toward the horizon
    float lit = clamp((n - fbm(uv + sunDir.xz * 0.12)) * 3.0 + 0.55, 0.0, 1.0);  // cheap self-shadowing
    vec3 cloud = mix(vec3(0.60, 0.64, 0.72), vec3(1.0, 0.98, 0.95), lit);
    cloud += vec3(1.0, 0.8, 0.5) * pow(sd, 5.0) * 0.4;                            // silver lining
    cloud = mix(col * 1.08, cloud, smoothstep(0.05, 0.5, y));                     // aerial perspective
    col = mix(col, cloud, c * 0.88);
  }
  col += vec3(14.0, 11.0, 7.5) * smoothstep(0.99935, 0.99975, sd);              // sun disc

  if (envMode > 0.5) {
    // Reflection-only: a ragged tree line and grass below the horizon
    float az = atan(d.z, d.x);
    float tl = 0.012 + 0.05 * noise(vec2(az * 9.0, 0.0)) + 0.02 * noise(vec2(az * 31.0, 3.0));
    if (y < tl) col = mix(vec3(0.07, 0.11, 0.06), vec3(0.16, 0.2, 0.12), clamp(y / tl, 0.0, 1.0));
    if (y < 0.0) col = mix(vec3(0.20, 0.28, 0.12), vec3(0.16, 0.16, 0.17), clamp(-y * 3.0, 0.0, 1.0));
  } else if (y < 0.0) col = mix(horizon * 0.9, vec3(0.30, 0.36, 0.26), clamp(-y * 4.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

function skyMaterial(octaves, envMode) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    defines: { OCTAVES: octaves },
    uniforms: {
      sunDir: { value: SUN_DIR }, horizon: { value: HORIZON }, time: { value: 0 }, envMode: { value: envMode ? 1 : 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
  });
}

export class Sky {
  constructor(scene, quality = 'high') {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMaterial(quality === 'high' ? 5 : 3, false));
    // Drawn after the opaque scene at depth = far plane, so cloud noise only runs on visible sky pixels
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt, camera) {
    this.mesh.material.uniforms.time.value += dt;
    this.mesh.position.copy(camera.position);   // infinitely far away
  }
}

/** Prefiltered environment for PBR materials. */
export function makeEnvMap(renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const mat = skyMaterial(5, true);
  mat.toneMapped = true;
  env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), mat));
  const tex = pm.fromScene(env, 0.015, 0.1, 200).texture;
  pm.dispose();
  return tex;
}
