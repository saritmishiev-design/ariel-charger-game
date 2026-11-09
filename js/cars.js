// Car line-up, tracks and the "lite" garage tunes. Pure data + math (no DOM): the pre-game menu,
// its performance bars and the driving physics all read the same spec from here.
import { SPEC as CHARGER_SPEC } from './config.js';
import { STOCK, sanitize, engineModel, deriveSpec, dragRun, topSpeed, LIMITS } from './build.js';

const IN = 0.0254;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Scale the engine model so the factory build makes exactly `hp` (cams/heads/ECU the model can't see). */
function calibrated(build, hp) {
  const raw = engineModel({ ...build, tq: 1 }, build);
  return Object.freeze({ ...build, tq: hp / raw.peakHp });
}

export const CARS = {
  charger: {
    name: "1979 Dodge Charger", short: 'CHARGER', tag: '700 HP · RWD · BLOWN HEMI V8',
    blurb: 'Drift-happy muscle. Skinny tyres, big lope, the rear always wants to come round.',
    base: { ...CHARGER_SPEC, drive: 'RWD', model: 'charger', audio: 'hemi', powerSlide: true, turnInAssist: 1.6,
      eye: [-0.36, 1.19, 2.1], hood: [0, 1.03, -0.7], transK: 1 },
    build: STOCK,
    tt: { boostAdd: 6, crMax: 9.5 },
    longK: 0.93,                  // stock gearing is already near-ideal for top speed
  },

  gtr: {
    name: 'Nissan GT-R', short: 'GT-R', tag: '800 HP · AWD · V6 TWIN-TURBO',
    blurb: 'Tuned R35. All-wheel drive, huge grip and a brutal launch. Listen for the turbo flutter.',
    base: {
      ...CHARGER_SPEC,
      length: 4.71, width: 1.895, height: 1.37, wheelbase: 2.78, trackFront: 1.59, trackRear: 1.60,
      frontOverhang: 0.98, mass: 1840, frontWeight: 0.54, cgHeight: 0.47,
      inertia: { pitch: 3100, yaw: 3500, roll: 640 },
      tyreMu: 1.45,
      suspensionRestLength: 0.27, suspensionStiffness: 36, dampingCompression: 4.4, dampingRelaxation: 3.4, rollInfluence: 0.05,
      // Lateral grip ≈ frictionSlip × tyreMu: ~1.7 g, the rear out-grips the front so it stays planted
      frictionSlipFront: 1.17, frictionSlipRear: 1.3,
      drivetrainEfficiency: 0.84, clutchMaxTorque: 1600, rearAxleInertia: 4.4,   // all four wheels + both diffs
      transK: 1.35,                                                              // GR6 dual-clutch: a strong box
      maxBrakeForce: 26000, brakeBiasFront: 0.6, handbrakeTorque: 3600, wheelieTorque: 0,
      dragCoefficient: 0.27, frontalArea: 2.2, rollingResistance: 0.012,
      maxSteer: 0.64, steerSpeedFalloff: 27,
      drive: 'AWD', model: 'gtr', audio: 'vr38', powerSlide: false, turnInAssist: 1.9,
      eye: [-0.37, 1.1, 1.72], hood: [0, 0.98, -0.62],
    },
    build: calibrated({
      bore: 95.5, stroke: 88.4, cr: 9.0, cyl: 6, layout: 'V', induction: 'turbo', boost: 20, knockCR: 19.5,
      trans: 'dct', gears: [3.4, 2.1, 1.5, 1.1, 0.82], final: 3.7,
      tireFront: 255, tireRear: 285, tireDia: 28.0,
    }, 800),
    tt: { boostAdd: 6, crMax: 9.0, label: 'Big twin turbos' },
  },

  sentra: {
    name: '2023 Nissan Sentra SV', short: 'SENTRA', tag: '149 HP · FWD · 2.0 L INLINE-4',
    blurb: "Ariel's real car. Front-wheel drive, all-season tyres, a CVT and a lot of understeer.",
    base: {
      ...CHARGER_SPEC,
      length: 4.641, width: 1.815, height: 1.447, wheelbase: 2.712, trackFront: 1.565, trackRear: 1.57,
      frontOverhang: 0.93, mass: 1420, frontWeight: 0.62, cgHeight: 0.55,
      inertia: { pitch: 2300, yaw: 2500, roll: 520 },
      tyreMu: 0.95,
      suspensionRestLength: 0.3, suspensionStiffness: 24, dampingCompression: 3.0, dampingRelaxation: 2.3, rollInfluence: 0.12,
      // Fronts let go long before the rears: safe, heavy understeer
      frictionSlipFront: 0.9, frictionSlipRear: 1.18,
      drivetrainEfficiency: 0.86, clutchMaxTorque: 450, rearAxleInertia: 1.6,      // front axle (driven)
      transK: 0.4,                                                                 // an economy CVT
      maxBrakeForce: 12500, brakeBiasFront: 0.7, handbrakeTorque: 2600, wheelieTorque: 0,
      dragCoefficient: 0.29, frontalArea: 2.2, rollingResistance: 0.011,
      maxSteer: 0.6, steerSpeedFalloff: 20,
      drive: 'FWD', model: 'sentra', audio: 'mr20', powerSlide: false, turnInAssist: 0.75,
      eye: [-0.37, 1.18, 1.7], hood: [0, 1.06, -0.55],
    },
    build: calibrated({
      bore: 84, stroke: 90.1, cr: 11.2, cyl: 4, layout: 'I', induction: 'na', boost: 8,
      // CVT modelled as a 5-step automatic; the top step is short, so it runs out of revs near 200 km/h
      trans: 'auto', gears: [2.65, 1.7, 1.28, 1.07, 0.98], final: 4.4,
      tireFront: 205, tireRear: 205, tireDia: 25.7,
    }, 149),
    tt: { boostAdd: 9, crMax: 9.3 },
  },
};

export const TRACKS = {
  classic: { name: 'Classic Track', sub: 'ARIEL RACEWAY · 3.6 KM', blurb: 'The original: fast sweepers, a chicane and two hairpins.' },
  ring: { name: 'Nürburgring Lite', sub: 'NÜRBURGRING LITE · 7.1 KM', blurb: 'Long, fast and hilly: crests, compressions, a Karussell and a 1.6 km straight.' },
  drag: { name: '1/4 Mile Drag Strip', sub: 'QUARTER-MILE DRAG STRIP', blurb: 'Stage at the line, watch the tree, run 402 m against the clock.' },
};

export const TUNES = {
  turbo: { label: 'Forced induction', options: [['stock', 'Stock'], ['tt', 'Twin turbo']] },
  final: { label: 'Final drive', options: [['short', 'Short'], ['stock', 'Stock'], ['long', 'Long']] },
  tires: { label: 'Tyres', options: [['street', 'Street'], ['slicks', 'Slicks'], ['drag', 'Drag slicks']] },
  susp: { label: 'Suspension', options: [['stock', 'Stock'], ['lowered', 'Lowered']] },
};
export const TUNE_DEFAULT = { turbo: 'stock', final: 'stock', tires: 'street', susp: 'stock' };

export const SETUP_DEFAULT = { track: 'classic', car: 'charger', tunes: {} };

/** Repair a saved setup (unknown ids → defaults). */
export function sanitizeSetup(s) {
  const o = { ...SETUP_DEFAULT, ...(s || {}) };
  if (!TRACKS[o.track]) o.track = SETUP_DEFAULT.track;
  if (!CARS[o.car]) o.car = SETUP_DEFAULT.car;
  const tunes = {};
  for (const id of Object.keys(CARS)) {
    const t = { ...TUNE_DEFAULT, ...((o.tunes || {})[id] || {}) };
    for (const [k, def] of Object.entries(TUNES)) if (!def.options.some(([v]) => v === t[k])) t[k] = TUNE_DEFAULT[k];
    tunes[id] = t;
  }
  o.tunes = tunes;
  return o;
}

/** Twin-turbo kit: an existing turbo build gets bigger turbos, anything else is converted (CR dropped for boost). */
function twinTurbo(b, kit) {
  const o = { ...b };
  if (o.induction === 'turbo' || o.induction === 'twin') o.boost = Math.min(LIMITS.boost[1], o.boost + kit.boostAdd);
  else { o.boost = Math.min(LIMITS.boost[1], (o.induction === 'na' ? 6 : o.boost) + kit.boostAdd); o.induction = 'turbo'; }
  o.cr = Math.min(o.cr, kit.crMax);
  return o;
}

/**
 * Full physics spec for a car with its tunes.
 * @param custom  this car's engine-builder build (null = factory engine)
 */
export function carSpec(carId, tune = TUNE_DEFAULT, custom = null) {
  const car = CARS[carId] || CARS.charger;
  const stock = car.build;
  let b = sanitize(custom || stock, stock);
  if (tune.turbo === 'tt') b = twinTurbo(b, car.tt);
  if (tune.final === 'short') b.final = clamp(b.final * 1.16, LIMITS.final[0], LIMITS.final[1]);
  if (tune.final === 'long') b.final = clamp(b.final * (car.longK || 0.86), LIMITS.final[0], LIMITS.final[1]);
  const spec = { ...car.base, ...deriveSpec(car.base, b, stock), inertia: { ...car.base.inertia } };
  spec.tyreType = 'street';
  spec.rideDrop = 0;
  spec.rollVisual = 1;
  if (tune.tires === 'slicks') {
    // Racing slicks: +30 % grip — traction and (through tyreMu) cornering on both axles, balance kept
    spec.tyreMu *= 1.3;
    spec.rollingResistance *= 1.08;
    spec.tyreType = 'slick';
  }
  if (tune.tires === 'drag') {
    // Drag slicks: soft, wrinkly, huge contact patch — enormous straight-line bite, modest in corners
    spec.tyreMu *= 1.12;
    spec.driveMuK = 2.6;
    spec.rollingResistance *= 1.15;
    spec.tyreType = 'drag';
  }
  // Big power: stiffer springs and dampers keep the body off the bump stops under a violent launch
  // (and a little more wheelie authority for the rear-drive cars)
  const stockT = engineModel(stock, stock).peakTorque;
  const e0 = engineModel(b, stock);
  const pk = clamp(Math.sqrt(e0.peakTorque / stockT), 1, 2.2);
  if (pk > 1.05) {
    spec.suspensionStiffness *= pk;
    spec.dampingCompression *= pk;
    spec.dampingRelaxation *= pk;
    spec.inertia.pitch *= Math.min(1.6, pk);
  }
  if (tune.susp === 'lowered') {
    // Lowering springs: body drops ~45 mm, stiffer and better damped, far less roll and load transfer
    spec.rideDrop = 0.045;
    spec.cgHeight -= 0.035;
    spec.suspensionRestLength -= 0.03;
    spec.suspensionStiffness *= 1.4;
    spec.dampingCompression *= 1.3;
    spec.dampingRelaxation *= 1.3;
    spec.rollInfluence *= 0.55;
    spec.frictionSlipFront *= 1.04;
    spec.frictionSlipRear *= 1.04;
    spec.rollVisual = 0.55;
  }
  return { car, spec, build: b, engine: e0 };
}

/** Will it survive? Peak cylinder pressure vs the block, launch shock (clutch capacity) vs the gearbox. */
export function limits(spec, engine) {
  const eng = engine.peakTorque / spec.blockTorque;
  const trans = engine.peakTorque / spec.transRating;
  return {
    eng, trans,
    engineLevel: eng > 1.02 || engine.detonation > 0 ? 'blow' : eng > 0.9 ? 'edge' : 'ok',
    transLevel: trans > 1.05 ? 'break' : trans > 0.9 ? 'edge' : 'ok',
  };
}

/**
 * Acceleration ratings (m/s², averaged 20–200 km/h), at each speed: `best` = the strongest gear's
 * pull, `inGear` = the average pull over every gear usable there (1,500 rpm to the redline) — how
 * hard the car pulls in whatever gear you happen to be in. Both are capped by what the driven tyres
 * can put down, minus drag. Unlike a timed run they aren't blurred by shift timing, so shorter
 * gearing, more boost and stickier tyres always show up.
 */
function accelPotential(spec) {
  const g = 9.81, c = spec.torqueCurve, tq = (rpm) => c[Math.min(c.length - 1, Math.max(0, Math.round(rpm / 100)))][1];
  const driveShare = spec.drive === 'AWD' ? 1 : spec.drive === 'FWD' ? spec.frontWeight : 1 - spec.frontWeight;
  const traction = spec.tyreMu * spec.mass * g * driveShare * (spec.drive === 'FWD' ? 0.92 : spec.drive === 'AWD' ? 1 : 1.08);
  let best = 0, inGear = 0, n = 0;
  for (let v = 5.5; v <= 55.6; v += 2.5) {
    const drag = 0.5 * 1.225 * spec.dragCoefficient * spec.frontalArea * v * v + spec.rollingResistance * spec.mass * g;
    let b = 0, gs = 0, gn = 0;
    spec.gears.forEach((gr, i) => {
      const G = gr * spec.finalDrive;
      let rpm = v / spec.wheelRadius * G * 30 / Math.PI;
      if (rpm > spec.redlineRpm || (rpm < 1500 && i > 0)) return;
      rpm = Math.max(rpm, 3000);   // 1st from a standstill: slipping the clutch
      const a = Math.max(0, Math.min(tq(rpm) * G * spec.drivetrainEfficiency / spec.wheelRadius, traction) - drag) / spec.mass;
      b = Math.max(b, a); gs += a; gn++;
    });
    best += b; inGear += gn ? gs / gn : 0; n++;
  }
  return { best: best / n, inGear: inGear / n };
}

/** Numbers behind the garage's performance bars. */
export function performance(spec, engine) {
  const run = dragRun(spec, 30, { failures: false });
  // Cornering grip in g: cannon's lateral limit is frictionSlip × tyreMu per axle
  const grip = (0.55 * spec.frictionSlipFront + 0.45 * spec.frictionSlipRear) * spec.tyreMu;
  const acc = accelPotential(spec);
  return {
    hp: engine.peakHp, torque: engine.peakTorque, t100: run.t100, quarter: run.quarter, top: topSpeed(spec), grip, acc,
    bars: {
      // Power on a log scale so a 149 hp Sentra and a 3,000 hp Pro Mod both read
      hp: clamp(Math.log(engine.peakHp / 80) / Math.log(4000 / 80), 0.03, 1),
      // Launch (timed 0–100), the strongest-gear pull and the in-gear pull, equally weighted
      accel: clamp(((run.t100 ? clamp((11 - run.t100) / 9.4, 0, 1) : 0) + clamp((acc.best - 1) / 13, 0, 1) + clamp((acc.inGear - 0.8) / 8, 0, 1)) / 3, 0.03, 1),
      top: clamp((topSpeed(spec) - 120) / (450 - 120), 0.03, 1),
      grip: clamp((grip - 0.6) / (2.4 - 0.6), 0.03, 1),
    },
  };
}

/** e.g. "800 HP · AWD · V6 TWIN-TURBO · DCT" */
export function carSummary(carId, engine, build) {
  const car = CARS[carId];
  const lay = build.layout === 'B' ? 'FLAT-' : build.layout === 'I' ? 'I' : 'V';
  const ind = { na: 'NA', turbo: 'TURBO', sc: 'BLOWN', twin: 'TWINCHARGED' }[build.induction];
  return `${Math.round(engine.peakHp)} HP · ${car.base.drive} · ${engine.dispL.toFixed(1)} L ${lay}${build.cyl} ${ind}`;
}
