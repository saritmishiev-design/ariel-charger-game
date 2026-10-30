import * as THREE from '../vendor/three.module.min.js';
import * as CANNON from '../vendor/cannon-es.js';
import { SPEC, PHYSICS_DT } from './config.js';
import { Vehicle } from './vehicle.js';
import { CarModel, PAINTS } from './carModel.js';
import { Track, ROAD_HALF } from './track.js';
import { Controls } from './controls.js';
import { AudioEngine } from './audio.js';
import { HUD, fmtTime } from './hud.js';
import { TyreSmoke, SkidMarks } from './effects.js';
import { Sky, makeEnvMap, SUN_DIR, HORIZON } from './sky.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------- Settings ----------------
const DEFAULTS = { units: 'kmh', steer: 'tilt', tilt: 28, tcs: true, auto: false, paint: 'red', volume: 0.9, cam: 0, gfx: 'high' };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('charger.settings') || '{}') }; } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem('charger.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };
let bestLap = null;
try { bestLap = parseFloat(localStorage.getItem('charger.best')) || null; } catch (e) { /* ignore */ }

// ---------------- Renderer & scene ----------------
const HIGH = settings.gfx !== 'low';
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, HIGH ? 1.75 : 1.1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Fog is blended after tone mapping, so it takes the sky's display-space horizon colour as-is
scene.fog = new THREE.Fog(HORIZON.clone(), 350, 3200);
// near = 0.25: keeps enough depth precision for the road ribbon to sit 2 cm above the grass
const camera = new THREE.PerspectiveCamera(62, 1, 0.25, 6000);

// Image-based lighting from the sky: every PBR surface picks up sky/horizon reflections
const envMap = makeEnvMap(renderer);
scene.environment = envMap;
const sky = new Sky(scene, settings.gfx);

// Sun: warm late-afternoon key light with soft PCF shadows; sky fill comes from the environment
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x3d4a24, 0.35));
const sun = new THREE.DirectionalLight(0xffe6c4, 3.2);
sun.castShadow = true;
const SHADOW_SIZE = HIGH ? 2048 : 1024, SHADOW_HALF = HIGH ? 42 : 30;
sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
const sc = sun.shadow.camera;
sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF; sc.near = 1; sc.far = 320;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// ---------------- Physics ----------------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 10;
world.allowSleep = false;
const materials = {
  ground: new CANNON.Material('ground'),
  chassis: new CANNON.Material('chassis'),
  wall: new CANNON.Material('wall'),
};
world.addContactMaterial(new CANNON.ContactMaterial(materials.chassis, materials.wall, { friction: 0.12, restitution: 0.18 }));
world.addContactMaterial(new CANNON.ContactMaterial(materials.chassis, materials.ground, { friction: 0.45, restitution: 0.02 }));
const groundBody = new CANNON.Body({ mass: 0, material: materials.ground });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

const track = new Track(scene, world, materials, settings.gfx);
const vehicle = new Vehicle(world, SPEC, materials);
const car = new CarModel(vehicle, envMap);
scene.add(car.root, car.contact);
car.setPaint(settings.paint);

const smoke = new TyreSmoke(scene);
const skids = new SkidMarks(scene);

// ---------------- Audio / HUD / Controls ----------------
const audio = new AudioEngine();
const hud = new HUD();
hud.units = settings.units;

const haptic = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } };

const controls = new Controls({
  onGear: (g) => {
    // Pedal input reaches the drivetrain on the next physics tick — sync it now
    const d = vehicle.drivetrain;
    d.clutchPedal = Math.max(d.clutchPedal, controls.clutchNow());
    return d.requestGear(g, vehicle.speed);
  },
  onIgnition: () => crank(),
  haptic,
});

function applySettings() {
  vehicle.drivetrain.tractionControl = settings.tcs;
  vehicle.drivetrain.autoClutch = settings.auto;
  controls.steerMode = settings.steer;
  controls.tiltRange = settings.tilt;
  hud.units = settings.units;
  audio.setVolume(settings.volume);
  car.setPaint(settings.paint);
  document.body.classList.toggle('touch-steer', settings.steer === 'touch');
  document.body.classList.toggle('auto-clutch', settings.auto);
  saveSettings();
}

// ---------------- Game state ----------------
const state = {
  started: false, paused: true, camMode: settings.cam | 0,
  lap: 0, lapStart: null, lastLap: null, sector: 0, trackIndex: -1,
  upsideTimer: 0, offroad: false, time: 0,
};
const CAM_MODES = ['chase', 'far', 'hood'];

function placeAtStart() {
  const sp = track.spawn(14);
  vehicle.reset(sp.x, sp.y, sp.z, sp.heading);
  state.trackIndex = sp.index;
}
function resetCar() {
  const sp = track.spawnAt(state.trackIndex >= 0 ? state.trackIndex : 0);
  vehicle.reset(sp.x, sp.y, sp.z, sp.heading);
  vehicle.drivetrain.requestGear(0, 0);
  controls.forceNeutral();
  skids.last = [null, null, null, null];
  hud.toast('Car reset — select a gear', 1.6);
}
placeAtStart();

function crank() {
  const r = vehicle.drivetrain.start();
  if (r === 'clutch') hud.toast('Press the CLUTCH (or select N) to start', 2.2);
}

// Collisions → sound + haptics
vehicle.body.addEventListener('collide', (e) => {
  const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
  if (v > 1.5 && e.body !== groundBody) {
    audio.impact(v / 14);
    haptic(Math.min(80, 15 + v * 4));
  }
});

// ---------------- Camera ----------------
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camInit = false;
const tmpV = new THREE.Vector3(), tmpF = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();

function updateCamera(dt) {
  const b = vehicle.body;
  const p = tmpV.set(b.position.x, b.position.y, b.position.z);
  tmpQ.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  const fwd = tmpF.set(0, 0, -1).applyQuaternion(tmpQ);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const mode = CAM_MODES[state.camMode];
  const speed = Math.abs(vehicle.speed);
  audio.setInterior(mode === 'hood');
  car.interior.visible = mode !== 'hood';   // the cabin is for the outside views; hood cam looks over it

  if (mode === 'hood') {
    const eye = new THREE.Vector3(-0.36, 0.64, 0.7).applyQuaternion(car.body.getWorldQuaternion(new THREE.Quaternion())).add(p);
    camera.position.copy(eye);
    const q = car.body.getWorldQuaternion(new THREE.Quaternion());
    camera.quaternion.slerp(q, camInit ? 1 - Math.exp(-dt * 18) : 1);
    camera.fov = 70 + speed * 0.08;
    camInit = true;
  } else {
    const dist = mode === 'far' ? 10.5 : 6.6, height = mode === 'far' ? 3.4 : 2.0;
    const desired = new THREE.Vector3().copy(p).addScaledVector(fwd, -dist).add(new THREE.Vector3(0, height, 0));
    const look = new THREE.Vector3().copy(p).addScaledVector(fwd, 4).add(new THREE.Vector3(0, 0.7, 0));
    if (!camInit) { camPos.copy(desired); camLook.copy(look); camInit = true; }
    camPos.lerp(desired, 1 - Math.exp(-dt * 7));
    camLook.lerp(look, 1 - Math.exp(-dt * 12));
    if (camPos.y < 0.6) camPos.y = 0.6;
    camera.position.copy(camPos);
    // Engine shake near redline
    const shake = Math.pow(clamp(vehicle.rpm / 6800, 0, 1), 4) * 0.025 * (vehicle.drivetrain.load + 0.2);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(camLook);
    camera.fov = 60 + Math.min(18, speed * 0.2);
  }
  camera.updateProjectionMatrix();

  // Shadow camera follows the car, centred a little ahead and snapped to whole texels (no shimmer)
  const texel = (SHADOW_HALF * 2) / SHADOW_SIZE;
  const c = tmpS.copy(p).addScaledVector(fwd, SHADOW_HALF * 0.45);
  c.x = Math.round(c.x / texel) * texel; c.z = Math.round(c.z / texel) * texel; c.y = 0;
  sun.position.copy(c).addScaledVector(SUN_DIR, 150);
  sun.target.position.copy(c);
}

// ---------------- Lap timing ----------------
function updateLap(idx) {
  const N = track.N, prev = state.trackIndex;
  if (prev >= 0) {
    if (idx > N * 0.3 && idx < N * 0.4) state.sector |= 1;
    if (idx > N * 0.65 && idx < N * 0.75) state.sector |= 2;
    const crossed = prev > N * 0.9 && idx < N * 0.1;
    if (crossed) {
      const now = state.time;
      if (state.lapStart != null && state.sector === 3) {
        const lt = now - state.lapStart;
        state.lastLap = lt;
        if (!bestLap || lt < bestLap) {
          bestLap = lt;
          try { localStorage.setItem('charger.best', String(lt)); } catch (e) { /* ignore */ }
          hud.toast(`NEW BEST  ${fmtTime(lt)}`, 3);
        } else hud.toast(`LAP  ${fmtTime(lt)}`, 2.5);
        state.lap++;
        showLapBanner();
      } else if (state.lapStart == null) {
        state.lap = 1;
      }
      if (state.lapStart == null || state.sector === 3) {
        state.lapStart = now;
        state.sector = 0;
      }
    }
  }
  state.trackIndex = idx;
}

// Every completed lap: a 4-second reminder of the real prize
let bannerTimer = null;
function showLapBanner() {
  const el = $('lap-banner');
  el.classList.remove('show');
  void el.offsetWidth;   // restart the animation
  el.classList.add('show');
  haptic([30, 60, 30]);
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ---------------- Main loop ----------------
let last = performance.now();
let acc = 0;
const evMsgs = {
  stall: 'STALLED — clutch in & tap START',
  starterFail: 'Engine didn\'t catch — try again',
};

function processEvents() {
  const ev = vehicle.drivetrain.events;
  while (ev.length) {
    const e = ev.shift();
    switch (e) {
      case 'starter': audio.starter(0.75); break;
      case 'ignition': audio.ignition(); haptic(40); break;
      case 'stall': audio.stall(); haptic([60, 40, 60]); hud.toast(evMsgs.stall, 2.5); break;
      case 'starterFail': hud.toast(evMsgs.starterFail, 2); break;
      case 'shiftUp': audio.shift(true); break;
      case 'shiftDown': audio.shift(false); break;
      case 'grind': audio.grind(); if (!settings.auto) hud.toast('GRIND! Use the clutch', 1.4); break;
      case 'limiter': haptic(12); break;
      default: break;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!state.paused) {
    state.time += dt;
    const input = controls.read(dt);

    // Surface under the car
    const b = vehicle.body;
    const q = track.query(b.position.x, b.position.z, state.trackIndex);
    const edge = ROAD_HALF + 1.3;
    if (q.dist < edge) { vehicle.surfaceMu = 1; vehicle.surfaceDrag = 1; state.offroad = false; }
    else if (q.dist < edge + 2.2) { vehicle.surfaceMu = 0.85; vehicle.surfaceDrag = 2.5; state.offroad = true; }
    else { vehicle.surfaceMu = 0.62; vehicle.surfaceDrag = 7; state.offroad = true; }
    updateLap(q.index);

    acc += dt;
    let steps = 0;
    while (acc >= PHYSICS_DT && steps < 8) {
      vehicle.update(PHYSICS_DT, input);
      world.step(PHYSICS_DT);
      acc -= PHYSICS_DT;
      steps++;
    }
    if (steps === 8) acc = 0;
    processEvents();

    // Auto-recover if upside down
    if (vehicle.isUpsideDown()) {
      state.upsideTimer += dt;
      if (state.upsideTimer > 2.5) { state.upsideTimer = 0; resetCar(); }
    } else state.upsideTimer = 0;

    // Tyre smoke & skid marks
    const scrub = vehicle.tyreScrub();
    const wi = vehicle.vehicle.wheelInfos;
    const longSlip = Math.abs(vehicle.drivetrain.slip);
    const rx = Math.cos(Math.atan2(b.velocity.x, b.velocity.z)), rz = -Math.sin(Math.atan2(b.velocity.x, b.velocity.z));
    for (let i = 0; i < 4; i++) {
      const w = wi[i];
      if (!w.raycastResult.body) { skids.add(i, 0, 0, 0, 0, 0, 0); continue; }
      const hp = w.raycastResult.hitPointWorld;
      const rear = i >= 2;
      const strength = rear ? scrub : (w.sliding ? Math.min(1, vehicle.lateralSlip / 6) : 0);
      const onTarmac = !state.offroad;
      skids.add(i, hp.x, hp.z, rx, rz, rear ? SPEC.tyreWidthRear : SPEC.tyreWidthFront, onTarmac ? strength : 0);
      if (rear && onTarmac && (longSlip > 0.25 || scrub > 0.55) && Math.random() < 0.9) {
        smoke.emit(hp.x, 0.3, hp.z, b.velocity.x, b.velocity.z, clamp(scrub * 1.2, 0.3, 1));
      }
    }
    smoke.update(dt);

    const d = vehicle.drivetrain;
    audio.update({
      rpm: d.rpm, load: d.running ? d.load : 0, throttle: d.throttle, running: d.running,
      cut: d.limiterCut, speed: vehicle.speed, scrub, offroad: state.offroad,
      gear: d.gear, shaftRpm: d.wheelW * SPEC.finalDrive * 60 / (2 * Math.PI),
    });
    hud.update({
      dt, rpm: d.rpm, speed: vehicle.speed, gear: d.gear, running: d.running, cranking: d.starterTime > 0,
      lapTime: state.lapStart != null ? state.time - state.lapStart : null,
      lastLap: state.lastLap, bestLap, lap: state.lap,
    });
  }

  car.sync(state.paused ? 0 : dt);
  if (!state.debugCam) updateCamera(dt);
  track.update(dt, camera);
  sky.update(dt, camera);
  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  smoke.setViewportHeight(h * renderer.getPixelRatio());
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
resize();
requestAnimationFrame(frame);

// ---------------- Menus ----------------
const menu = $('menu');
let wakeLock = null;

function buildMenu() {
  const sw = $('swatches');
  for (const [key, p] of Object.entries(PAINTS)) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
    b.title = p.name;
    b.setAttribute('aria-label', p.name);
    b.dataset.key = key;
    b.addEventListener('click', () => { settings.paint = key; syncMenu(); applySettings(); });
    sw.appendChild(b);
  }
  const seg = (id, key, parse = (v) => v) => {
    $(id).querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      settings[key] = parse(btn.dataset.v); syncMenu(); applySettings();
    }));
  };
  seg('set-steer', 'steer');
  seg('set-units', 'units');
  seg('set-tcs', 'tcs', (v) => v === '1');
  seg('set-auto', 'auto', (v) => v === '1');
  $('set-gfx').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    if (settings.gfx === btn.dataset.v) return;
    settings.gfx = btn.dataset.v; saveSettings();
    location.reload();   // scenery density and shadow resolution are set at load
  }));
  $('btn-settings').addEventListener('click', () => menu.classList.toggle('show-settings'));
  $('set-tilt').addEventListener('input', (e) => { settings.tilt = +e.target.value; applySettings(); });
  $('set-vol').addEventListener('input', (e) => { settings.volume = +e.target.value; applySettings(); });
  $('btn-go').addEventListener('click', onGo);
  $('btn-calibrate').addEventListener('click', () => { controls.calibrate(); hud.toast('Steering centred', 1.2); });
  $('btn-restart').addEventListener('click', () => {
    placeAtStart(); vehicle.drivetrain.requestGear(0, 0); controls.forceNeutral(); skids.clear();
    state.lap = 0; state.lapStart = null; state.sector = 0; state.lastLap = null;
    onGo();
  });
  $('btn-pause').addEventListener('click', () => pause(true));
  $('btn-cam').addEventListener('click', () => {
    state.camMode = (state.camMode + 1) % CAM_MODES.length; camInit = false;
    settings.cam = state.camMode; saveSettings();
  });
  $('btn-reset').addEventListener('click', resetCar);
  $('btn-start').addEventListener('click', crank);
  $('btn-center').addEventListener('click', () => { controls.calibrate(); hud.toast('Steering centred', 1.2); });
  syncMenu();
}

function syncMenu() {
  document.querySelectorAll('.swatch').forEach(b => b.classList.toggle('on', b.dataset.key === settings.paint));
  const segSet = (id, val) => $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
  segSet('set-steer', settings.steer);
  segSet('set-units', settings.units);
  segSet('set-tcs', settings.tcs ? '1' : '0');
  segSet('set-auto', settings.auto ? '1' : '0');
  segSet('set-gfx', settings.gfx);
  $('set-tilt').value = settings.tilt;
  $('set-vol').value = settings.volume;
  $('best-lap').textContent = bestLap ? fmtTime(bestLap) : '—';
}

async function onGo() {
  // Everything here must start inside the user gesture (iOS)
  const tilt = Controls.requestTiltPermission();
  const snd = audio.init();
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen && !window.matchMedia('(display-mode: fullscreen)').matches) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    } else screen.orientation?.lock?.('landscape').catch(() => {});
  } catch (e) { /* not supported */ }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* optional */ }

  const tiltOk = await tilt;
  try { await snd; } catch (e) { console.warn('audio init failed', e); }
  applySettings();
  menu.classList.remove('show', 'show-settings');
  document.body.classList.add('playing');
  state.paused = false;
  audio.resume();
  last = performance.now();

  if (settings.steer === 'tilt') {
    if (!tiltOk) hud.toast('Tilt not available — switched to touch steering', 2.5);
    if (!tiltOk) { settings.steer = 'touch'; applySettings(); syncMenu(); }
    setTimeout(() => { if (controls.tiltSeen) controls.calibrate(); }, 350);
  }
  if (!state.started) {
    state.started = true;
    setTimeout(() => {
      crank();
      hud.toast(settings.auto ? 'Tap 1 on the shifter, then GAS' : 'CLUTCH in → shift to 1 → ease off the clutch with GAS', 4);
    }, 400);
  }
}

function pause(on) {
  if (on) {
    state.paused = true;
    $('btn-go').textContent = 'RESUME';
    $('menu-sub').textContent = 'PAUSED';
    menu.classList.add('show', 'paused');
    document.body.classList.remove('playing');
    syncMenu();
    audio.suspend();
  } else onGo();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.started && !state.paused) pause(true);
  if (!document.hidden && wakeLock && wakeLock.released && state.started && !state.paused) {
    navigator.wakeLock?.request('screen').then(w => { wakeLock = w; }).catch(() => {});
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.started) pause(!state.paused);
  if (e.key.toLowerCase() === 'c' && !state.paused) { state.camMode = (state.camMode + 1) % CAM_MODES.length; camInit = false; }
  if (e.key.toLowerCase() === 't' && !state.paused) resetCar();
});
// Block page gestures (pinch zoom, pull-to-refresh, long-press menus) while playing
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('playing')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

buildMenu();
applySettings();
$('loading').classList.add('hide');

// ---------------- PWA ----------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Debug handle (handy from the browser console)
window.__game = { vehicle, state, audio, controls, track, camera, car, renderer };
