import * as THREE from '../vendor/three.module.min.js';
import * as CANNON from '../vendor/cannon-es.js';
import { PHYSICS_DT, WALL_CONTACT, BUILD } from './config.js';
import { Vehicle } from './vehicle.js';
import { CarModel, PAINTS } from './carModel.js';
import { Track, TERRAIN_GROUP, DRAG_LENGTH } from './track.js';
import { Controls } from './controls.js';
import { AudioEngine } from './audio.js';
import { HUD, fmtTime } from './hud.js';
import { TyreSmoke, SkidMarks } from './effects.js';
import { Sky, makeEnvMap, SUN_DIR, HORIZON } from './sky.js';
import { STOCK, TRANS, sanitize } from './build.js';
import { Garage } from './garage.js';
import { CARS, TRACKS, sanitizeSetup, carSpec, carSummary } from './cars.js';
import { PreGame } from './pregame.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------- Settings ----------------
const DEFAULTS = { units: 'kmh', steer: 'tilt', tilt: 32, tcs: true, auto: false, paint: 'red', volume: 0.9, cam: 0, gfx: 'high', tiltV: 5 };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('charger.settings') || '{}') }; } catch (e) { /* private mode */ }
// Tilt calibration changed (v5): move any saved value onto the new scale once
if (settings.tiltV !== DEFAULTS.tiltV) { settings.tilt = DEFAULTS.tilt; settings.tiltV = DEFAULTS.tiltV; }
const saveSettings = () => { try { localStorage.setItem('charger.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ---------------- Setup: track, car, tunes (picked in the pre-game garage) ----------------
let setup = sanitizeSetup(null);
try { setup = sanitizeSetup(JSON.parse(localStorage.getItem('charger.setup') || 'null')); } catch (e) { /* defaults */ }
const saveSetup = () => { try { localStorage.setItem('charger.setup', JSON.stringify(setup)); } catch (e) { /* ignore */ } };
// The Charger's engine-builder build (Garage & Dyno)
let build = sanitize(STOCK);
try { build = sanitize(JSON.parse(localStorage.getItem('charger.build') || 'null')); } catch (e) { /* defaults */ }

// Best lap / best ET per track and car (the old single best lap belonged to the classic Charger)
const bestKey = () => `charger.best.${setup.track}.${setup.car}`;
try {
  const old = localStorage.getItem('charger.best');
  if (old && !localStorage.getItem('charger.best.classic.charger')) localStorage.setItem('charger.best.classic.charger', old);
} catch (e) { /* ignore */ }
let bestLap = null;
const loadBest = () => { try { bestLap = parseFloat(localStorage.getItem(bestKey())) || null; } catch (e) { bestLap = null; } };

// Filled in by prepareSpec() / buildWorld() once the player hits RACE
let SPEC = null, ENGINE = null, CAR_BUILD = null, SEQ = false;
let track = null, vehicle = null, car = null, smoke = null, skids = null, built = false;
const COCKPIT_EYE = new THREE.Vector3(), HOOD_EYE = new THREE.Vector3();

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
// Box tests, not bounding spheres: the barrier bodies are long chains of panels whose bounding
// sphere (centred on the world origin) would put every one of them in contact with the car
world.broadphase.useBoundingBoxes = true;
world.solver.iterations = 10;
world.allowSleep = false;
const materials = {
  ground: new CANNON.Material('ground'),
  chassis: new CANNON.Material('chassis'),
  wall: new CANNON.Material('wall'),
};
world.addContactMaterial(new CANNON.ContactMaterial(materials.chassis, materials.wall, WALL_CONTACT));
world.addContactMaterial(new CANNON.ContactMaterial(materials.chassis, materials.ground, { friction: 0.45, restitution: 0.02 }));

const SMOKE_RATE = HIGH ? 85 : 55;   // puffs per second per driven tyre at full wheelspin
const smokeAcc = [0, 0, 0, 0];

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
    if (SPEC.transType === 'auto') d.autoDrive = g > 0;   // any forward gear on an automatic = D
    return d.requestGear(g, vehicle.speed);
  },
  onIgnition: () => crank(),
  haptic,
});

function applySettings() {
  if (vehicle) {
    vehicle.drivetrain.tractionControl = settings.tcs;
    // Sequential, DCT, drag and automatic boxes run their own clutch
    vehicle.drivetrain.autoClutch = settings.auto || SEQ;
  }
  controls.steerMode = settings.steer;
  controls.tiltRange = settings.tilt;
  hud.units = settings.units;
  audio.setVolume(settings.volume);
  if (car) car.setPaint(settings.paint);
  document.body.classList.toggle('touch-steer', settings.steer === 'touch');
  document.body.classList.toggle('auto-clutch', settings.auto || SEQ);
  document.body.classList.toggle('seq', SEQ);
  $('clutch-note').textContent = SEQ ? `(automatic with the ${TRANS[SPEC.transType].name} box)` : '';
  $('tcs-note').textContent = SPEC ? `(raw ${Math.round(ENGINE.peakHp)} hp)` : '';
  saveSettings();
}

// ---------------- Game state ----------------
const state = {
  started: false, paused: true, camMode: settings.cam | 0,
  lap: 0, lapStart: null, lastLap: null, sector: 0, trackIndex: -1,
  upsideTimer: 0, offroad: false, time: 0, simTime: 0, speedFx: 0,
};
const CAM_MODES = ['chase', 'cockpit', 'hood'];
const CAM_LABELS = { chase: 'CHASE', cockpit: 'COCKPIT', hood: 'HOOD' };
const CAM_NAMES = { chase: 'Chase cam', cockpit: 'Cockpit view', hood: 'Hood / bumper cam' };
// Eye points (COCKPIT_EYE, HOOD_EYE) are in the car body's frame (origin = centre of mass,
// forward = -Z), set per car in buildWorld()
const COCKPIT_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.06);
function setCam(i, announce = true) {
  state.camMode = ((i % CAM_MODES.length) + CAM_MODES.length) % CAM_MODES.length;
  camInit = false;
  const mode = CAM_MODES[state.camMode];
  $('cam-label').textContent = CAM_LABELS[mode];
  if (announce) hud.toast(CAM_NAMES[mode], 1.1);
  settings.cam = state.camMode; saveSettings();
}

let handbrakeOn = false;

// ---------------- Nitrous ----------------
const NOS_BURN = 3.5;      // seconds of spray in a full bottle
const NOS_REFILL = 20;     // seconds to refill from empty
const nos = { charge: 1, armed: false, spraying: false, idle: 0, fx: 0, spit: 0 };
function toggleNos() {
  if (!vehicle.drivetrain.running) { hud.toast('Start the engine first', 1.4); return; }
  if (!nos.armed && nos.charge < 0.08) { hud.toast('NOS bottle refilling…', 1.4); return; }
  nos.armed = !nos.armed;
  haptic(nos.armed ? [20, 30, 20] : 15);
  if (nos.armed) hud.toast('NOS ARMED — floor it!', 1.3);
}
function updateNos(dt, input) {
  const d = vehicle.drivetrain;
  nos.spraying = nos.armed && d.running && d.gear > 0 && input.throttle > 0.6;
  if (nos.spraying) {
    nos.charge = Math.max(0, nos.charge - dt / NOS_BURN);
    nos.idle = 0;
    if (nos.charge === 0) { nos.armed = false; nos.spraying = false; hud.toast('NOS empty', 1.2); }
  } else if (!nos.armed && (nos.idle += dt) > 1.5) nos.charge = Math.min(1, nos.charge + dt / NOS_REFILL);
  d.nitrous = nos.spraying ? 1 : 0;
  nos.fx += ((nos.spraying ? 1 : 0) - nos.fx) * Math.min(1, dt * (nos.spraying ? 7 : 3));
  // Short flame spits on the limiter / overrun crackle
  if (d.limiterCut && Math.random() < 0.25) nos.spit = 0.55 + Math.random() * 0.3;
  nos.spit *= Math.max(0, 1 - dt * 14);
  car.flame = Math.max(nos.fx, nos.spit);
  if (nos.spraying && Math.random() < dt * 8) haptic(8);
}
let nosUi = '';
function syncNosUi() {
  const btn = $('btn-nos');
  const st = nos.spraying ? 'spraying' : nos.armed ? 'armed' : nos.charge < 0.08 ? 'empty' : 'ready';
  btn.style.setProperty('--nos', nos.charge.toFixed(3));
  if (st !== nosUi) {
    nosUi = st;
    btn.className = st;
    $('nos-state').textContent = { spraying: 'BOOST', armed: 'ARMED', empty: 'FILLING', ready: nos.charge > 0.99 ? 'READY' : 'FILLING' }[st];
  } else if (st === 'ready' && nos.charge > 0.99 && $('nos-state').textContent !== 'READY') $('nos-state').textContent = 'READY';
  $('speedfx').classList.toggle('on', nos.fx > 0.35);
}

function placeAtStart() {
  // Drag strip: front wheels just behind the start line; circuits: on the grid behind the lap line
  const sp = track.spawn(track.isDrag ? -vehicle.frontAxleZ + 0.3 : 14);
  if (track.isDrag) {
    // Spawn points are 2 m apart: slide along the strip so the front wheels sit exactly 0.3 m short of the line
    const t = track.tangents[track.startIndex], s0 = track.along(sp.x, sp.z) + (-vehicle.frontAxleZ);
    const k = -0.3 - s0;
    sp.x += t.x * k; sp.z += t.z * k;
  }
  vehicle.reset(sp.x, sp.y, sp.z, sp.heading);
  state.trackIndex = sp.index;
  camInit = false;   // snap the camera instead of swooping across the map
}
function resetCar() {
  if (track.isDrag) {
    placeAtStart();
    dragReset();
    hud.toast('Staged — select a gear, wait for green', 1.8);
  } else {
    const sp = track.spawnAt(state.trackIndex >= 0 ? state.trackIndex : 0);
    vehicle.reset(sp.x, sp.y, sp.z, sp.heading);
    camInit = false;
    hud.toast('Car reset — select a gear', 1.6);
  }
  vehicle.drivetrain.requestGear(0, 0);
  vehicle.drivetrain.autoDrive = false;
  controls.forceNeutral();
  skids.last = [null, null, null, null];
}

function crank() {
  const r = vehicle.drivetrain.start();
  if (r === 'clutch') hud.toast('Press the CLUTCH (or select N) to start', 2.2);
}

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
  audio.setInterior(mode === 'cockpit');
  car.interior.visible = mode !== 'hood';   // seats, dash and wheel show in chase and cockpit views
  const nosFov = nos.fx * 12;                // NOS: the world rushes at you
  // Sense of speed above 120 km/h: wider FOV, edge blur (in frame()) and a gentle road buzz
  const kmh = speed * 3.6;
  const sTarget = clamp((kmh - 120) / 110, 0, 1);
  state.speedFx += (sTarget * sTarget * (3 - 2 * sTarget) - state.speedFx) * Math.min(1, dt * 2.5);
  const sfx = state.speedFx;
  const tt = state.time;
  const buzzX = (Math.sin(tt * 53) * 0.6 + Math.sin(tt * 31.7) * 0.4) * sfx;
  const buzzY = (Math.sin(tt * 47.3) * 0.6 + Math.sin(tt * 23.1) * 0.4) * sfx;

  if (mode !== 'chase') {
    const q = car.body.getWorldQuaternion(new THREE.Quaternion());
    const eye = (mode === 'cockpit' ? COCKPIT_EYE : HOOD_EYE).clone().applyQuaternion(q).add(p);
    camera.position.copy(eye);
    if (mode === 'cockpit') q.multiply(COCKPIT_TILT);
    camera.quaternion.slerp(q, camInit ? 1 - Math.exp(-dt * 18) : 1);
    const shake = nos.fx * 0.006;
    camera.position.x += (Math.random() - 0.5) * shake + buzzX * 0.006;
    camera.position.y += (Math.random() - 0.5) * shake + buzzY * 0.008;
    camera.fov = (mode === 'cockpit' ? 66 : 70) + speed * 0.08 + nosFov + sfx * 9;
    camInit = true;
  } else {
    const dist = 6.6, height = 2.0;
    const desired = new THREE.Vector3().copy(p).addScaledVector(fwd, -dist).add(new THREE.Vector3(0, height, 0));
    const look = new THREE.Vector3().copy(p).addScaledVector(fwd, 4).add(new THREE.Vector3(0, 0.7, 0));
    if (!camInit) { camPos.copy(desired); camLook.copy(look); camInit = true; }
    camPos.lerp(desired, 1 - Math.exp(-dt * 7));
    camLook.lerp(look, 1 - Math.exp(-dt * 12));
    const gy = track.height(camPos.x, camPos.z);
    if (camPos.y < gy + 0.6) camPos.y = gy + 0.6;
    camera.position.copy(camPos);
    // Engine shake near redline
    const shake = Math.pow(clamp(vehicle.rpm / SPEC.limiterRpm, 0, 1), 4) * 0.025 * (vehicle.drivetrain.load + 0.2) + nos.fx * 0.03;
    camera.position.x += (Math.random() - 0.5) * shake + buzzX * 0.035;
    camera.position.y += (Math.random() - 0.5) * shake + buzzY * 0.03;
    camera.lookAt(camLook);
    camera.fov = 60 + Math.min(18, speed * 0.2) + nosFov + sfx * 12;
  }
  camera.updateProjectionMatrix();

  // Shadow camera follows the car, centred a little ahead and snapped to whole texels (no shimmer)
  const texel = (SHADOW_HALF * 2) / SHADOW_SIZE;
  const c = tmpS.copy(p).addScaledVector(fwd, SHADOW_HALF * 0.45);
  c.x = Math.round(c.x / texel) * texel; c.z = Math.round(c.z / texel) * texel; c.y = track.height(c.x, c.z);
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
          try { localStorage.setItem(bestKey(), String(lt)); } catch (e) { /* ignore */ }
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
function showLapBanner(drag = false) {
  const el = $('lap-banner');
  el.querySelector('p').innerHTML = drag
    ? "<b>Great run!</b> But don't forget your wife, Sarit, is your real ultimate prize."
    : "<b>Great lap!</b> But don't forget your wife, Sarit, is your real ultimate prize.";
  el.classList.remove('show');
  void el.offsetWidth;   // restart the animation
  el.classList.add('show');
  haptic([30, 60, 30]);
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 7000);   // matches the 7 s CSS animation
}

// ---------------- Drag strip: Christmas tree + timing ----------------
// Stage with the front wheels just behind the line, engine running and a gear in: the ambers count
// down 0.5 s apart, then green. The clock starts when the front wheels cross the start line and
// stops at 402.336 m (interpolated between physics steps, so it's good to the millisecond).
const DRAG_SPLITS = [['60 FT', 18.288], ['330 FT', 100.584], ['1/8 MILE', 201.168], ['1000 FT', 304.8]];
const drag = {
  phase: 'idle', staged: 0, treeT: 0, greenAt: null, startT: null, along: 0, splits: [], rt: null,
  foul: false, runs: 0, lastEt: null, result: null, tree: { stage: false, amber: 0, green: false, red: false },
};
const _fa = new THREE.Vector3(), _faQ = new THREE.Quaternion();
function frontAlong() {
  const b = vehicle.body;
  _faQ.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  _fa.set(0, 0, vehicle.frontAxleZ).applyQuaternion(_faQ);
  return track.along(b.position.x + _fa.x, b.position.z + _fa.z);
}
function dragReset() {
  Object.assign(drag, { phase: 'idle', staged: 0, greenAt: null, startT: null, splits: [], rt: null, foul: false, result: null });
  drag.along = frontAlong();
  drag.tree = { stage: false, amber: 0, green: false, red: false };
  $('drag-result').classList.remove('show');
}
function dragStep() {
  const t = state.simTime, pa = drag.along, a = frontAlong(), d = vehicle.drivetrain;
  drag.along = a;
  const cross = (thr) => (pa < thr && a >= thr ? t - PHYSICS_DT * (a - thr) / Math.max(1e-6, a - pa) : null);
  const T = drag.tree;
  const inStage = a > -1.5 && a <= 0.05;
  if (drag.phase === 'idle' || drag.phase === 'tree' || drag.phase === 'green') {
    const ready = inStage && Math.abs(vehicle.speed) < 0.5 && d.running && d.gear > 0;
    if (drag.phase === 'idle') {
      T.stage = inStage;
      T.green = T.red = false; T.amber = 0;
      drag.staged = ready ? drag.staged + PHYSICS_DT : 0;
      if (drag.staged > 0.7) { drag.phase = 'tree'; drag.treeT = t; }
    } else if (drag.phase === 'tree') {
      const e = t - drag.treeT;
      T.amber = Math.min(3, Math.floor(e / 0.5) + 1);
      if (e >= 1.5) { drag.phase = 'green'; drag.greenAt = drag.treeT + 1.5; T.amber = 0; T.green = true; }
      if (a < -2.5) drag.phase = 'idle';     // rolled back out of the beams
    }
    const tc = cross(0);
    if (tc != null) {
      drag.foul = drag.phase === 'tree';    // left before the green: red light
      drag.rt = drag.greenAt != null ? tc - drag.greenAt : null;
      if (drag.foul) { T.red = true; T.amber = 0; }
      drag.startT = tc; drag.splits = []; drag.phase = 'run';
    }
  } else if (drag.phase === 'run') {
    for (const [label, dist] of DRAG_SPLITS) {
      if (drag.splits.some(x => x[0] === label)) continue;
      const c = cross(dist);
      if (c != null) drag.splits.push([label, c - drag.startT]);
    }
    const fin = cross(DRAG_LENGTH);
    if (fin != null) {
      drag.phase = 'done';
      drag.result = { et: fin - drag.startT, trap: Math.abs(vehicle.speed), rt: drag.rt, foul: drag.foul, splits: drag.splits.slice(), shown: false };
    } else if (t - drag.startT > 90 || a < -3) dragReset();
  }
}
const fmtSpeed = (ms) => (settings.units === 'mph' ? `${(ms * 2.23694).toFixed(1)} MPH` : `${(ms * 3.6).toFixed(1)} KM/H`);
function dragFrame() {
  const T = drag.tree;
  track.setTree(T);
  const lamps = document.querySelectorAll('#dragtree i');
  lamps.forEach((l, i) => l.classList.toggle('on', i === 0 ? T.stage : i <= 3 ? T.amber >= i : i === 4 ? T.green : T.red));
  const r = drag.result;
  if (!r || r.shown) return;
  r.shown = true;
  drag.runs++;
  drag.lastEt = r.et;
  let best = false;
  if (!r.foul && (!bestLap || r.et < bestLap)) {
    bestLap = r.et; best = true;
    try { localStorage.setItem(bestKey(), String(r.et)); } catch (e) { /* ignore */ }
  }
  track.setTimingBoard({ et: r.et, trap: fmtSpeed(r.trap) });
  const res = $('drag-result');
  res.innerHTML = `<h4>${r.foul ? '<span class="red">RED LIGHT</span>' : best ? 'NEW BEST' : `RUN ${drag.runs}`}</h4>
    <div class="dr-et"><b>${r.et.toFixed(3)}</b><small>s</small></div><div class="dr-trap">${fmtSpeed(r.trap)}</div>
    <ul>${r.rt != null ? `<li><span>REACTION</span><b>${r.rt.toFixed(3)}</b></li>` : ''}${r.splits.map(([l, v]) => `<li><span>${l}</span><b>${v.toFixed(3)}</b></li>`).join('')}</ul>
    <p>Tap ↺ RESET to stage again</p>`;
  res.classList.add('show');
  haptic([30, 60, 30]);
  if (!r.foul) showLapBanner(true);
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
      case 'launchArmed': haptic([15, 25, 15]); hud.toast('LAUNCH CONTROL · 3,500 RPM — release BRAKE to go!', 2.5); break;
      case 'launch': haptic(40); hud.toast('LAUNCH!', 0.9); break;
      case 'bov': audio.blowOff(vehicle.drivetrain.boostPsi / 15); break;
      case 'denied': haptic([20, 40, 20]); hud.toast('Stop the car to change direction', 1.4); break;
      default: break;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!built) return;

  if (!state.paused) {
    const input = controls.read(dt);
    input.handbrake = handbrakeOn || controls.keys.has('h') ? 1 : 0;
    tick(dt, input);
  }

  car.sync(state.paused ? 0 : dt);
  if (!state.debugCam) updateCamera(dt);
  track.update(dt, camera);
  sky.update(dt, camera);
  renderer.render(scene, camera);
  // Edge motion blur: full strength for NOS, a subtler version from raw speed (skipped in Battery saver)
  const blurAmt = Math.max(nos.fx, HIGH ? state.speedFx * 0.5 : 0);
  if (blurAmt > 0.02 && !state.paused) speedBlur(blurAmt);
}

/** One frame of game logic (physics, timing, effects, sound, HUD) — everything but rendering. */
function tick(dt, input) {
  state.time += dt;
  $('btn-hb').classList.toggle('on', !!input.handbrake);
  updateNos(dt, input);

  // Surface under the car
  const b = vehicle.body;
  const q = track.query(b.position.x, b.position.z, state.trackIndex);
  const edge = track.half + 1.3;
  if (q.dist < edge) { vehicle.surfaceMu = 1; vehicle.surfaceDrag = 1; state.offroad = false; }
  else if (q.dist < edge + 2.2) { vehicle.surfaceMu = 0.85; vehicle.surfaceDrag = 2.5; state.offroad = true; }
  else { vehicle.surfaceMu = 0.62; vehicle.surfaceDrag = 7; state.offroad = true; }
  if (!track.isDrag) updateLap(q.index); else state.trackIndex = q.index;

  acc += dt;
  let steps = 0;
  while (acc >= PHYSICS_DT && steps < 8) {
    vehicle.update(PHYSICS_DT, input);
    world.step(PHYSICS_DT);
    state.simTime += PHYSICS_DT;
    if (track.isDrag) dragStep();
    acc -= PHYSICS_DT;
    steps++;
  }
  if (steps === 8) acc = 0;
  processEvents();
  if (track.isDrag) dragFrame();

  // Auto-recover if upside down, or somehow outside the barriers / below the ground
  if (vehicle.isUpsideDown()) {
    state.upsideTimer += dt;
    if (state.upsideTimer > 2.5) { state.upsideTimer = 0; resetCar(); }
  } else state.upsideTimer = 0;
  if (q.dist > 60 || b.position.y < track.height(b.position.x, b.position.z) - 3) resetCar();

  // Tyre smoke & skid marks
  const scrub = vehicle.tyreScrub();
  const wi = vehicle.vehicle.wheelInfos;
  const longSlip = Math.abs(vehicle.drivetrain.slip);
  const rx = Math.cos(Math.atan2(b.velocity.x, b.velocity.z)), rz = -Math.sin(Math.atan2(b.velocity.x, b.velocity.z));
  // Spinning rears throw smoke backwards (opposite the car's nose)
  tmpQ.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  const nose = tmpF.set(0, 0, -1).applyQuaternion(tmpQ);
  const spinDir = Math.sign(vehicle.drivetrain.wheelW || 1);
  const smokeAmt = clamp(Math.max((longSlip - 0.18) * 1.5, (scrub - 0.5) * 2), 0, 1);
  for (let i = 0; i < 4; i++) {
    const w = wi[i];
    if (!w.raycastResult.body) { skids.add(i, 0, 0, 0, 0, 0, 0); continue; }
    const hp = w.raycastResult.hitPointWorld;
    const driven = vehicle.driven.includes(i);
    // Driven tyres mark (and smoke) from wheelspin, the hand-braked rears from locking, the others from sliding
    const strength = driven || (i >= 2 && handbrakeOn) ? scrub : (w.sliding ? Math.min(1, vehicle.lateralSlip / 6) : 0);
    const onTarmac = !state.offroad;
    skids.add(i, hp.x, hp.z, rx, rz, i >= 2 ? SPEC.tyreWidthRear : SPEC.tyreWidthFront, onTarmac ? strength : 0, hp.y);
    if (driven && onTarmac && smokeAmt > 0) {
      // Rate-based emission so the cloud density doesn't depend on frame rate (AWD: shared by 4 tyres)
      smokeAcc[i] += dt * SMOKE_RATE * (0.35 + 0.65 * smokeAmt) * (vehicle.driven.length > 2 ? 0.6 : 1);
      while (smokeAcc[i] >= 1) {
        smokeAcc[i] -= 1;
        smoke.emit(hp.x, hp.y + 0.25, hp.z, b.velocity.x, b.velocity.z, 0.45 + 0.55 * smokeAmt, -nose.x * spinDir, -nose.z * spinDir);
      }
    } else smokeAcc[i] = 0;
  }
  smoke.update(dt);

  const d = vehicle.drivetrain;
  audio.update({
    nitrous: nos.fx,
    rpm: d.rpm, load: d.running ? d.load : 0, throttle: d.throttle, running: d.running,
    cut: d.limiterCut, speed: vehicle.speed, scrub, offroad: state.offroad,
    slideAngle: vehicle.slideAngle, slipSpeed: Math.abs(d.wheelW * SPEC.wheelRadius - vehicle.speed),
    gear: d.gear, shaftRpm: d.wheelW * SPEC.finalDrive * 60 / (2 * Math.PI),
    spool: d.spool, boostPsi: d.boostPsi,
  });
  hud.update(track.isDrag ? {
    dt, rpm: d.rpm, speed: vehicle.speed, gear: d.gear, running: d.running, cranking: d.starterTime > 0,
    lapTime: drag.phase === 'run' ? state.simTime - drag.startT : drag.lastEt,
    lastLap: drag.lastEt, bestLap, lap: drag.runs, autoDrive: d.autoDrive,
  } : {
    dt, rpm: d.rpm, speed: vehicle.speed, gear: d.gear, running: d.running, cranking: d.starterTime > 0,
    lapTime: state.lapStart != null ? state.time - state.lapStart : null,
    lastLap: state.lastLap, bestLap, lap: state.lap, autoDrive: d.autoDrive,
  });
  updateProgress();
  syncNosUi();
}

// ---------------- Lap progress ----------------
let progShown = -1;
function updateProgress() {
  const N = track.N;
  const frac = track.isDrag
    ? clamp(drag.along / DRAG_LENGTH, 0, 1)
    : state.lapStart == null ? 0 : clamp(state.trackIndex / N, 0, 1);
  const pct = Math.floor(frac * 100);
  if (Math.abs(frac - progShown) < 0.002) return;
  progShown = frac;
  $('prog-fill').style.width = `${(frac * 100).toFixed(1)}%`;
  $('prog-car').style.left = `${(frac * 100).toFixed(1)}%`;
  $('prog-pct').textContent = `${pct}%`;
  const left = (1 - frac) * (track.isDrag ? DRAG_LENGTH : track.length);
  $('prog-left').textContent = settings.units === 'mph'
    ? `${(left / 1609.34).toFixed(2)} MI TO GO` : left >= 1000 ? `${(left / 1000).toFixed(2)} KM TO GO` : `${Math.round(left)} M TO GO`;
}

// ---------------- NOS speed blur (radial blur of the finished frame) ----------------
const blur = {
  tex: null, pos: new THREE.Vector2(0, 0),
  cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  scene: new THREE.Scene(),
  mat: new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { tFrame: { value: null }, strength: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tFrame; uniform float strength; varying vec2 vUv;
      void main() {
        vec2 c = vec2(0.5, 0.47), d = vUv - c;
        float amt = strength * smoothstep(0.06, 0.55, length(d)) * 0.16;   // sharp centre, streaked edges
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 10; i++) acc += texture2D(tFrame, c + d * (1.0 - amt * float(i) / 9.0)).rgb;
        gl_FragColor = vec4(acc / 10.0, 1.0);
      }`,
  }),
};
blur.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blur.mat));
function speedBlur(strength) {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  if (!blur.tex || blur.tex.image.width !== w || blur.tex.image.height !== h) {
    if (blur.tex) blur.tex.dispose();
    blur.tex = new THREE.FramebufferTexture(w, h);
    blur.tex.minFilter = blur.tex.magFilter = THREE.LinearFilter;
    blur.mat.uniforms.tFrame.value = blur.tex;
  }
  renderer.copyFramebufferToTexture(blur.pos, blur.tex);
  blur.mat.uniforms.strength.value = strength;
  const ac = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(blur.scene, blur.cam);
  renderer.autoClear = ac;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (smoke) smoke.setViewportHeight(h * renderer.getPixelRatio());
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
  $('btn-go').addEventListener('click', () => { if (built) onGo(); else closeSettings(); });
  $('btn-calibrate').addEventListener('click', () => { controls.calibrate(); hud.toast('Steering centred', 1.2); });
  $('btn-restart').addEventListener('click', () => {
    placeAtStart(); vehicle.drivetrain.requestGear(0, 0); vehicle.drivetrain.autoDrive = false; controls.forceNeutral(); skids.clear();
    state.lap = 0; state.lapStart = null; state.sector = 0; state.lastLap = null;
    nos.armed = false; nos.charge = 1;
    if (track.isDrag) dragReset();
    onGo();
  });
  // Back to the pre-game garage: the world is built for one car and track, so start a fresh page
  $('btn-garage').addEventListener('click', () => { saveSetup(); location.reload(); });
  $('btn-pause').addEventListener('click', () => pause(true));
  $('btn-cam').addEventListener('click', () => setCam(state.camMode + 1));
  $('btn-nos').addEventListener('pointerdown', (e) => { e.preventDefault(); toggleNos(); });
  // Hand brake: hold to pull (multi-touch safe: tracks its own pointers)
  const hbBtn = $('btn-hb'), hbPtrs = new Set();
  const hbSet = () => { const was = handbrakeOn; handbrakeOn = hbPtrs.size > 0; if (handbrakeOn && !was) haptic(20); };
  hbBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); hbPtrs.add(e.pointerId); hbBtn.setPointerCapture?.(e.pointerId); hbSet(); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hbBtn.addEventListener(ev, (e) => { hbPtrs.delete(e.pointerId); hbSet(); });
  setCam(state.camMode, false);
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
  $('best-lap').textContent = bestLap ? (track && track.isDrag ? `${bestLap.toFixed(3)} s` : fmtTime(bestLap)) : '—';
}

// Settings page opened from the pre-game garage (before the world exists)
function openSettings() {
  pregame.hide();
  $('btn-go').textContent = '‹ BACK TO GARAGE';
  $('menu-title').innerHTML = 'GAME <span>SETTINGS</span>';
  menu.classList.add('show', 'pregame-settings');
  syncMenu();
}
function closeSettings() {
  menu.classList.remove('show', 'pregame-settings');
  pregame.show();
}

/** Cheap part of the session build: the physics spec, so the engine sound can be configured in the gesture. */
function prepareSpec() {
  const cs = carSpec(setup.car, setup.tunes[setup.car], build);
  SPEC = cs.spec; ENGINE = cs.engine; CAR_BUILD = cs.build;
  SEQ = SPEC.transType !== 'manual';
  audio.configure({ cyl: SPEC.cylinders, layout: SPEC.layout, blower: SPEC.blower, turbo: SPEC.turbo, profile: SPEC.audio });
}

/** Build the track, car, effects and HUD for the chosen setup (once per page load). */
function buildWorld() {
  if (TRACKS[setup.track] && setup.track === 'ring') materials.terrainGroup = TERRAIN_GROUP;
  track = new Track(scene, world, materials, settings.gfx, setup.track);
  vehicle = new Vehicle(world, SPEC, materials);
  car = new CarModel(vehicle, envMap);
  scene.add(car.root, car.contact);
  smoke = new TyreSmoke(scene, HIGH ? 700 : 360, SUN_DIR);
  smoke.setViewportHeight(window.innerHeight * renderer.getPixelRatio());
  skids = new SkidMarks(scene);
  // Driver's eye and the hood cam, from the car's own measurements (ground height, metres behind the front axle)
  const y0 = -SPEC.cgHeight - (SPEC.rideDrop || 0);
  COCKPIT_EYE.set(SPEC.eye[0], y0 + SPEC.eye[1], vehicle.frontAxleZ + SPEC.eye[2]);
  HOOD_EYE.set(SPEC.hood[0], y0 + SPEC.hood[1], vehicle.frontAxleZ + SPEC.hood[2]);
  hud.setRange(SPEC.redlineRpm);
  // Collisions → sound + haptics
  vehicle.body.addEventListener('collide', (e) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    const ground = track.isGround(e.body);
    if (!ground) vehicle.wallHit(v);
    if (v > 1.5 && !ground) {
      audio.impact(v / 14);
      haptic(Math.min(80, 15 + v * 4));
    }
  });
  loadBest();
  document.body.classList.toggle('drag', track.isDrag);
  if (track.isDrag) {
    $('lap-label').textContent = 'RUN';
    $('last-label').textContent = 'LAST ET';
    $('best-label').textContent = 'BEST ET';
    $('prog-label').textContent = 'RUN';
    hud.fmt = (t) => (t == null || !isFinite(t) ? '--.---' : `${t.toFixed(3)} s`);
  }
  $('menu-sub').textContent = TRACKS[setup.track].sub;
  $('build-badge').textContent = `${carSummary(setup.car, ENGINE, CAR_BUILD)} · ${TRANS[CAR_BUILD.trans].name.toUpperCase()}`;
  $('menu-title').innerHTML = `ARIEL'S <span>${CARS[setup.car].short}</span>`;
  placeAtStart();
  if (track.isDrag) dragReset();
  applySettings();
  built = true;
  window.__game = { vehicle, state, audio, controls, track, camera, car, renderer, smoke, nos, drag, SPEC, tick, seqShift };
}

/** RACE: everything that needs the tap (audio unlock, tilt permission, fullscreen) first, then build. */
async function race() {
  saveSetup();
  pregame.hide();
  prepareSpec();
  const loading = $('loading');
  loading.querySelector('p').textContent = `Building ${TRACKS[setup.track].name}…`;
  loading.classList.remove('hide');
  const go = onGo(true);
  // Let the loading screen paint before the (synchronous) world build
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
  try { buildWorld(); } catch (e) { console.error(e); loading.querySelector('p').textContent = 'Something went wrong building the track — please reload'; throw e; }
  loading.classList.add('hide');
  await go;
}

async function onGo(fromRace = false) {
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
  // RACE: wait for the world (built right after this gesture work was kicked off)
  while (fromRace && !built) await new Promise(r => setTimeout(r, 30));
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
      const hint = SPEC.transType === 'auto' ? 'Tap ▲ for D, then GAS'
        : SEQ ? 'Tap ▲ for 1st, then GAS'
          : settings.auto ? 'Tap 1 on the shifter, then GAS' : 'CLUTCH in → shift to 1 → ease off the clutch with GAS';
      hud.toast(track.isDrag ? `Staged at the line. ${hint} on the green (BRAKE + GAS = launch control)` : hint, 4.5);
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
  if (e.key.toLowerCase() === 'c' && !state.paused) setCam(state.camMode + 1);
  if (e.key.toLowerCase() === 'x' && !state.paused) toggleNos();
  if (SEQ && !state.paused && !e.repeat && (e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 'q')) seqShift(e.key.toLowerCase() === 'e' ? 1 : -1);
  if (e.key.toLowerCase() === 't' && !state.paused) resetCar();
});
// Block page gestures (pinch zoom, pull-to-refresh, long-press menus) while playing
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('playing')) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------------- Sequential / automatic shifting ----------------
function seqShift(dir) {
  const d = vehicle.drivetrain, g = d.gear, sp = vehicle.speed;
  let ok = true;
  if (SPEC.transType === 'auto') {
    // R ← N → D (the box picks 1-5 itself in D)
    if (dir > 0) { if (g === -1) ok = d.requestGear(0, sp); else if (g === 0) { ok = d.requestGear(1, sp); if (ok) d.autoDrive = true; } }
    else if (d.autoDrive || g > 0) { d.autoDrive = false; d.requestGear(0, sp); }
    else if (g === 0) ok = d.requestGear(-1, sp);
  } else if (dir > 0) {
    if (g === -1) ok = d.requestGear(0, sp); else if (g < 5) ok = d.requestGear(g + 1, sp);
  } else if (g > 1) ok = d.requestGear(g - 1, sp);
  else if (g === 1) ok = d.requestGear(0, sp);
  else if (g === 0) ok = d.requestGear(-1, sp);
  haptic(ok ? 12 : [20, 40, 20]);
  syncSeqLabels();
}
function syncSeqLabels() {
  if (!SEQ || !vehicle) return;
  const d = vehicle.drivetrain, g = d.gear;
  const name = (x) => (x === -1 ? 'R' : x === 0 ? 'N' : SPEC.transType === 'auto' ? 'D' : String(x));
  const up = SPEC.transType === 'auto' ? (g === -1 ? 0 : 1) : Math.min(5, g + 1);
  const down = SPEC.transType === 'auto' ? (d.autoDrive || g > 0 ? 0 : -1) : Math.max(-1, g - 1);
  $('seq-up-l').textContent = g >= 5 || (SPEC.transType === 'auto' && d.autoDrive) ? '—' : name(up);
  $('seq-down-l').textContent = g === -1 ? '—' : name(down);
}
for (const [id, dir] of [['seq-up', 1], ['seq-down', -1]]) {
  $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); seqShift(dir); });
}
setInterval(syncSeqLabels, 250);

// ---------------- Pre-game garage & the Charger's engine builder ----------------
const pregame = new PreGame({
  setup, custom: build,
  onChange: () => saveSetup(),
  onRace: () => race(),
  onSettings: () => openSettings(),
  onEngine: () => { pregame.hide(); garage.show(); },
});
const garage = new Garage({
  baseSpec: CARS.charger.base,
  current: build,
  onApply: (b, changed) => {
    if (changed) {
      build = sanitize(b);
      try { localStorage.setItem('charger.build', JSON.stringify(build)); } catch (e) { /* private mode: this session only */ }
      pregame.setCustom(build);
    }
    garage.hide();
    race();   // DRIVE: straight onto the track with the new engine
  },
  onClose: () => pregame.show(),
});

buildMenu();
applySettings();
$('loading').classList.add('hide');
pregame.show();

// ---------------- PWA ----------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // When a new version takes over, reload once (only if an older one was running and we're in the menu)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    if (!state.started || state.paused) location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  });
}
$('build').textContent = `BUILD ${BUILD}`;
$('pg-build').textContent = `BUILD ${BUILD}`;

// Debug handle (handy from the browser console); buildWorld() replaces it with the full set
window.__game = { state, audio, controls, camera, renderer, pregame, setup };
