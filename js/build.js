// Garage build → engine model, drivetrain and tyre spec. Pure math (no DOM) so the dyno, the
// drag-strip simulation and the driving physics all use exactly the same numbers.
import { Drivetrain } from './drivetrain.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const PSI_ATM = 14.7;
const HP = 745.7;   // W per mechanical hp

/** The car as it ships: a 426-ci (7.0 L) blown Hemi V8 making ~700 hp. */
export const STOCK = Object.freeze({
  bore: 108, stroke: 95.3, cr: 9.0, cyl: 8, layout: 'V',
  induction: 'sc', boost: 8,
  trans: 'manual', gears: [2.95, 1.94, 1.34, 1.0, 0.8], final: 3.23,
  tireFront: 225, tireRear: 275, tireDia: 27.0, tier: 'stock', voice: 'hemi', engine: 'piston', fuel: 'gas',
});

export const LIMITS = {
  bore: [50, 160, 0.5], stroke: [35, 170, 0.5], cr: [6.5, 15, 0.1], boost: [3, 70, 0.5],
  cyl: [1, 24, 1], rotors: [1, 6, 1], rotorCc: [400, 1000, 10],
  gear: [0.5, 4.5, 0.01], final: [1.5, 12, 0.01],
  tireFront: [185, 335, 5], tireRear: [195, 355, 5], tireDia: [24, 30, 0.1],
};
export const CYLINDERS = Array.from({ length: 24 }, (_, i) => i + 1);
export const RADIAL_CYL = [3, 5, 7, 9, 14, 18, 28];
export const ENGINE_TYPES = { piston: 'Piston', rotary: 'Wankel rotary', radial: 'Radial' };
// Fuels: extra knock margin (effective CR), energy per charge (BMEP ×), wear per second at full
// load (nitromethane eats an engine in ~20 s of wide-open throttle), throttle response (s)
export const FUELS = {
  gas: { name: 'Gasoline', short: 'Gas', knock: 0, k: 1, wear: 0, tau: 0.045 },
  e85: { name: 'E85', short: 'E85', knock: 3.5, k: 1.06, wear: 0, tau: 0.045 },
  methanol: { name: 'Methanol', short: 'Methanol', knock: 9, k: 1.14, wear: 0, tau: 0.04 },
  nitro: { name: 'Nitromethane', short: 'Nitro', knock: 40, k: 4.0, wear: 1 / 20, tau: 0.016 },
};
export const LAYOUTS = { V: 'V-engine', B: 'Boxer', I: 'Inline' };
export const INDUCTION = { na: 'Naturally aspirated', turbo: 'Turbocharged', sc: 'Supercharged', twin: 'Twincharged' };
// rating: input torque (Nm) the box survives. Street boxes scale with the car (transK: a Sentra's CVT
// is not a Charger's 5-speed); the drag boxes are built for any engine.
// cut: drive is interrupted for shiftTime (clutch / ignition cut). The Lenco is a planetary box:
// each gear is a clutch pack, so it shifts with no lift, no cut and no clutch — 0 ms.
export const TRANS = {
  manual: { name: 'Manual', short: 'Manual', shiftTime: 0.25, gears: [2.95, 1.94, 1.34, 1.0, 0.8], final: 3.23, rating: 2100 },
  auto: { name: 'Automatic', short: 'Auto', shiftTime: 0.35, gears: [2.74, 1.54, 1.0, 0.8, 0.68], final: 3.23, rating: 1300 },
  dct: { name: 'Sequential DCT', short: 'DCT', shiftTime: 0.08, gears: [3.1, 2.1, 1.55, 1.2, 0.95], final: 3.55, rating: 1500 },
  drag: { name: 'Heavy-duty drag box', short: 'HD drag', shiftTime: 0.04, gears: [2.6, 1.8, 1.35, 1.1, 1.0], final: 4.1, rating: 7000, strong: true },
  lenco: { name: 'Lenco planetary', short: 'Lenco', shiftTime: 0, gears: [2.55, 1.82, 1.38, 1.13, 1.0], final: 3.0, rating: 12000, strong: true },
};

// Engine build tiers. strength: how hard the block can be pushed, as a multiple of the car's own
// factory cylinder pressure (BMEP), with an absolute floor in bar; past it the engine is damaged
// and soon blows. Better tiers also breathe better (tq), take more boost before knocking (race
// fuel, methanol), rev higher (piston speed, lighter valvetrain) and survive the limiter longer.
export const TIERS = {
  stock: { antiLag: 0, spool: 0, name: 'Stock block', short: 'Stock', strength: 1.6, floorBar: 20, tq: 1, knock: 0, piston: 20.6, valve: 1, kg: 0, heat: 6 },
  forged: { antiLag: 0, spool: 0, name: 'Forged internals', short: 'Forged', strength: 2.5, floorBar: 32, tq: 1.0, knock: 0, piston: 21.5, valve: 1.04, kg: 6, heat: 8 },
  race: { antiLag: 0.6, spool: -0.06, name: 'Race engine', short: 'Race', strength: 3.8, floorBar: 48, tq: 1.12, knock: 19, piston: 23, valve: 1.1, kg: 12, heat: 10 },
  promod: { antiLag: 1, spool: -0.16, name: 'Pro Mod billet', short: 'Pro Mod', strength: 6.5, floorBar: 85, tq: 1.35, knock: 30, piston: 25, valve: 1.18, kg: 30, heat: 12 },
  // Pneumatic valve springs and tiny, light pistons: 18,000+ rpm, a narrow peaky power band
  f1: { antiLag: 1, spool: -0.1, name: 'F1 (pneumatic valves)', short: 'F1', strength: 3.5, floorBar: 45, tq: 1.1, knock: 17, piston: 26, valve: 2.3, kg: -10, heat: 15, cap: 20000, peaky: true, idle: 4000 },
  // Top Fuel: forged-billet everything, built to survive ~11,000 hp for a few seconds at a time
  topfuel: { antiLag: 1, spool: 0, name: 'Top Fuel', short: 'Top Fuel', strength: 14, floorBar: 300, tq: 1.45, knock: 0, piston: 30, valve: 1.15, kg: 80, heat: 5, cap: 9000, idle: 2000 },
};

/** Which cylinder counts each layout can be built with (real-world configurations). */
export function layoutAllows(layout, cyl) {
  if (layout === 'I') return cyl <= 14;          // single-cylinder up to a ship-style straight-14
  return cyl >= 2 && cyl % 2 === 0;              // V and boxer: two equal banks (V2 … V24, flat-2 … flat-24)
}

/** Clamp every field into range and repair impossible combinations. */
export function sanitize(b, stock = STOCK) {
  const o = { ...stock, ...(b || {}) };
  for (const k of ['bore', 'stroke', 'cr', 'boost', 'final', 'tireFront', 'tireRear', 'tireDia']) {
    const [lo, hi] = LIMITS[k];
    o[k] = clamp(Number.isFinite(+o[k]) ? +o[k] : stock[k], lo, hi);
  }
  if (!ENGINE_TYPES[o.engine]) o.engine = 'piston';
  if (!FUELS[o.fuel]) o.fuel = 'gas';
  o.rotors = clamp(Math.round(+o.rotors || 2), 1, 6);
  o.rotorCc = clamp(+o.rotorCc || 654, LIMITS.rotorCc[0], LIMITS.rotorCc[1]);
  if (!CYLINDERS.includes(+o.cyl) && !RADIAL_CYL.includes(+o.cyl)) o.cyl = stock.cyl; else o.cyl = +o.cyl;
  if (o.engine === 'radial') { if (!RADIAL_CYL.includes(o.cyl)) o.cyl = 9; o.layout = 'R'; }
  else {
    if (o.cyl > 24) o.cyl = 24;
    if (!LAYOUTS[o.layout]) o.layout = stock.layout === 'R' ? 'V' : stock.layout;
    if (!layoutAllows(o.layout, o.cyl)) o.layout = o.cyl % 2 || o.cyl < 2 ? 'I' : 'V';
  }
  if (!INDUCTION[o.induction]) o.induction = stock.induction;
  if (!TRANS[o.trans]) o.trans = stock.trans;
  if (!TIERS[o.tier]) o.tier = 'stock';
  const g = Array.isArray(o.gears) && o.gears.length === 5 ? o.gears : TRANS[o.trans].gears;
  o.gears = g.map((x, i) => clamp(Number.isFinite(+x) ? +x : TRANS[o.trans].gears[i], LIMITS.gear[0], LIMITS.gear[1]));
  return o;
}

// ---------------------------------------------------------------- engine model
// Full-load brake torque = BMEP × displacement / 4π, with
//  • BMEP from a naturally aspirated baseline, the compression ratio's Otto-cycle efficiency and
//    a volumetric-efficiency curve shaped by bore/stroke (over-square engines peak higher),
//  • boost as a pressure ratio (charge-cooled, ^0.85) with each device's own rpm behaviour:
//    a Roots blower boosts from idle but costs crank power; a turbo spools up late (bigger
//    boost / smaller engine = more lag) but is almost free; twincharging blends the two,
//  • knock: effective compression = CR × PR^(1/γ). Past ~15.5 the ECU must retard timing.
// Redline comes from mean piston speed (stroke) and valvetrain mass (bore), both raised by the tier.
const BMEP_NA = 12.35e5;        // Pa, a healthy street/strip NA engine
const KNOCK_CR = 15.5;         // effective CR an intercooled engine tolerates on pump fuel (E85 tunes set knockCR)

function otto(cr) { return 1 - Math.pow(cr, -0.3); }

export function engineModel(input, stock = STOCK) {
  const b = sanitize(input, stock);
  const tier = TIERS[b.tier], fuel = FUELS[b.fuel];
  const rotary = b.engine === 'rotary', radial = b.engine === 'radial';
  const boreM = b.bore / 1000, strokeM = b.stroke / 1000;
  // Displacement as a four-stroke sees it. A Wankel's chambers fire once per shaft turn, so each
  // rotor counts twice its chamber volume (a 1.3 L 13B breathes like a 2.6 L piston engine).
  const disp = rotary ? b.rotors * b.rotorCc * 1e-6 * 2 : b.cyl * Math.PI / 4 * boreM * boreM * strokeM;   // m³
  const dispL = disp * 1000;
  const rodRatio = b.bore / b.stroke;
  // Rev limits: piston speed (stroke) and valvetrain (bore); radials are slow-turning aero engines;
  // a rotary has no valves at all — apex seals and port timing set its (very high) ceiling
  const cap = tier.cap || 10500;
  let redline;
  if (rotary) redline = Math.min(8500 * Math.pow(654 / b.rotorCc, 0.25) * Math.sqrt(tier.valve), cap + 1500);
  else if (radial) redline = Math.min(13 * 60 / (2 * strokeM) * tier.valve, 4500);
  else redline = Math.min(tier.piston * 60 / (2 * strokeM), 9500 * Math.pow(86 / b.bore, 0.6) * tier.valve, cap);
  redline = Math.round(redline / 100) * 100;
  const limiter = redline + 300;
  // Volumetric efficiency vs x = rpm / redline: where the torque peaks and how fast it falls away
  // below the peak. Radials are all low-down torque; rotaries and F1 engines are peaky.
  const xp = radial ? 0.42 : rotary ? 0.8 : tier.peaky ? 0.84 : clamp(0.71 + 0.22 * (rodRatio - 1.133), 0.55, 0.85);
  const lowK = radial ? 0.7 : rotary ? 2.1 : tier.peaky ? 1.8 : 1.25;
  const ve = (x) => {
    if (x <= xp) return Math.max(0.12, 1 - lowK * Math.pow(xp - x, 1.63));
    const d = x - xp, v = 1 - 2.3 * Math.pow(d, 2.2);
    return Math.max(0.05, x > limiter / redline ? v - 3 * (x - limiter / redline) : v);
  };
  // Boost (pressure ratio − 1) vs x
  const PR = 1 + b.boost / PSI_ATM;
  // Bigger boost = bigger turbine = later spool; race tiers run ball-bearing turbos and anti-lag
  const spoolStart = clamp(0.2 + 0.011 * Math.min(b.boost, 25) + 0.004 * Math.max(0, b.boost - 25) - 0.025 * (dispL - 3) + tier.spool + (b.spool || 0), 0.12, 0.6);
  const turbo = (x) => (PR - 1) * smooth(spoolStart, spoolStart + 0.22, x);
  const blower = (x) => (PR - 1) * clamp(0.5 + 1.6 * x, 0, 1);
  const boostAt = (x) => {
    switch (b.induction) {
      case 'turbo': return turbo(x);
      case 'sc': return blower(x);
      case 'twin': return Math.max(blower(x) * 0.6 * (1 - smooth(spoolStart, spoolStart + 0.22, x)), turbo(x));
      default: return 0;
    }
  };
  const lossAt = (x, bst) => {
    // Crank power to drive the compressor (blower) or exhaust back-pressure (turbo)
    if (b.induction === 'sc') return Math.min(0.2, 0.13 * bst * x);   // (a huge blower still takes no more than ~20 %)
    if (b.induction === 'twin') return 0.13 * bst * x * (1 - smooth(spoolStart, spoolStart + 0.22, x)) * 0.6 + 0.03 * bst;
    if (b.induction === 'turbo') return 0.03 * bst;
    return 0;
  };
  // Small cylinders breathe and burn a bit better per litre; more cylinders = more friction.
  // A rotary's long, moving combustion chamber burns less efficiently.
  const nComb = rotary ? b.rotors : b.cyl;
  const perCylL = dispL / nComb;
  const sizeK = (1 + 0.05 * clamp(0.875 - perCylL, -0.5, 0.5)) * (rotary ? 0.86 : 1);
  const fricK = 1 - 0.006 * clamp(nComb - 8, -8, 16) - (b.layout === 'B' ? -0.01 : 0);
  const eta = otto(b.cr) / otto(10);
  const torqueAt = (rpm) => {
    const x = rpm / redline;
    const bst = boostAt(x);
    const prx = 1 + bst;
    const crEff = b.cr * Math.pow(prx, 1 / 1.3);
    const kcr = Math.max(b.knockCR || KNOCK_CR, tier.knock) + fuel.knock;
    const knock = crEff > kcr ? Math.max(0.55, 1 - 0.07 * (crEff - kcr)) : 1;
    // tq: per-car calibration (cam, head and ECU quality the bore/stroke model can't see)
    const t = BMEP_NA * disp / (4 * Math.PI) * eta * sizeK * fricK * ve(x) * Math.pow(prx, 0.85) * (1 - lossAt(x, bst)) * knock * (b.tq || 1) * tier.tq * fuel.k;
    return { t: Math.max(0, t), pr: prx, knock, over: crEff - kcr };
  };
  // Tabulate (the drivetrain interpolates this table)
  const curve = [], boostCurve = [];
  let peakT = 0, peakTRpm = 0, peakP = 0, peakPRpm = 0, minKnock = 1, maxOver = -99;
  const top = limiter + 600;
  for (let rpm = 0; rpm <= top + 1; rpm += 100) {
    const r = rpm === 0 ? 0 : torqueAt(rpm);
    const t = rpm === 0 ? 0 : r.t * (rpm < 500 ? rpm / 500 : 1);
    curve.push([rpm, Math.round(t * 10) / 10]);
    boostCurve.push([rpm, rpm === 0 ? 1 : Math.round(r.pr * 1000) / 1000]);
    if (rpm > 0) { minKnock = Math.min(minKnock, r.knock); maxOver = Math.max(maxOver, r.over); }
    if (rpm <= limiter) {
      if (t > peakT) { peakT = t; peakTRpm = rpm; }
      const p = t * rpm * Math.PI / 30;
      if (p > peakP) { peakP = p; peakPRpm = rpm; }
    }
  }
  // Engine mass: block + per-litre + per-cylinder, layout, induction hardware
  const layoutK = { V: 1, I: 0.96, B: 1.04, R: 0.9 }[b.layout] || 1;
  const indKg = { na: 0, turbo: 28, sc: 32, twin: 55 }[b.induction] * Math.max(1, Math.sqrt(dispL / 7));
  const mass = Math.max(40, (rotary ? 40 + 34 * b.rotors : (60 + 22 * dispL + 8 * b.cyl) * layoutK) + indKg + tier.kg);
  return {
    build: b, disp, dispL, ci: dispL * 61.0237, redline, limiter, curve, boostCurve,
    peakTorque: peakT, peakTorqueRpm: peakTRpm, peakHp: peakP / HP, peakHpRpm: peakPRpm,
    boostPeakPsi: b.induction === 'na' ? 0 : (PR - 1) * PSI_ATM, knockLimited: minKnock < 0.97, knockLoss: 1 - minKnock,
    // > 0: so far past the knock limit that retarding the timing can't save it (it will blow)
    detonation: Math.max(0, maxOver - 2.5),
    mass, idleRpm: tier.idle || (radial ? 600 : rotary ? 1000 : perCylL < 0.5 ? 950 : 850),
    inertia: Math.max(0.03, 0.3 * Math.pow(dispL / 6.98, 0.8) * (b.layout === 'B' ? 0.95 : 1) * (rotary ? 0.55 : tier.peaky ? 0.45 : 1)),
    frictionScale: Math.pow(dispL / 6.98, 0.85) * (1 + 0.01 * clamp(nComb - 8, -8, 16)) * (rotary ? 0.8 : 1),
    name: engineName(b), throttleTau: fuel.tau, fuelWear: fuel.wear,
    turbo: b.induction === 'turbo' || b.induction === 'twin',
    blower: b.induction === 'sc' || b.induction === 'twin',
  };
}

/** Physics spec for a build, derived from the base spec of the car it goes in (stock = that car's factory build). */
export function deriveSpec(base, input, stock = STOCK) {
  const b = sanitize(input, stock);
  const e = engineModel(b, stock);
  const stockEngine = engineModel(stock, stock);
  // Mass and weight distribution: the engine sits ~90 % over the front axle
  const mass = base.mass - stockEngine.mass + e.mass;
  const frontKg = base.mass * base.frontWeight - stockEngine.mass * 0.9 + e.mass * 0.9;
  const r = b.tireDia * 0.0254 / 2;
  const t = TRANS[b.trans];
  const gripF = Math.pow(b.tireFront / stock.tireFront, 0.22);
  const gripR = Math.pow(b.tireRear / stock.tireRear, 0.22);
  const r0 = stock.tireDia * 0.0254 / 2;
  return {
    mass,
    frontWeight: clamp(frontKg / mass, 0.45, 0.66),
    cgHeight: base.cgHeight - (b.layout === 'B' ? 0.02 : 0),
    wheelRadius: r,
    tyreWidthFront: b.tireFront / 1000,
    tyreWidthRear: b.tireRear / 1000,
    tyreMu: base.tyreMu * (base.drive === 'FWD' ? gripF : gripR),   // drive traction (driven tyres)
    frictionSlipFront: base.frictionSlipFront * gripF,    // cornering grip per axle
    frictionSlipRear: base.frictionSlipRear * gripR,
    rollingResistance: base.rollingResistance * Math.sqrt((b.tireFront + b.tireRear) / (stock.tireFront + stock.tireRear)),
    rearAxleInertia: base.rearAxleInertia * Math.pow(r / r0, 2) * (b.tireRear / stock.tireRear),
    idleRpm: e.idleRpm, redlineRpm: e.redline, limiterRpm: e.limiter,
    engineInertia: e.inertia, frictionScale: e.frictionScale,
    torqueCurve: e.curve, boostCurve: e.turbo ? e.boostCurve : null,
    clutchMaxTorque: Math.max(base.clutchMaxTorque, e.peakTorque * 1.8),
    gears: b.gears.slice(), finalDrive: b.final,
    transType: b.trans, shiftTime: t.shiftTime,
    induction: b.induction, cylinders: b.cyl, layout: b.layout,
    blower: e.blower, turbo: e.turbo,
    // Component limits (drivetrain.js breaks things past these)
    tier: b.tier, blockTorque: blockTorque(e, stockEngine), limiterHeat: TIERS[b.tier].heat, detonation: e.detonation,
    antiLag: e.turbo ? TIERS[b.tier].antiLag : 0,
    // Launch-control two-step: where the engine has torque to launch on (a radial: low; an F1: 10,000+)
    launchRpm: Math.round(Math.min(Math.max(3500, e.peakTorqueRpm * 0.6), e.redline * 0.7) / 100) * 100,
    throttleTau: e.throttleTau, fuelWear: e.fuelWear, fuel: b.fuel, engineType: b.engine, engineName: e.name,
    dispL: e.dispL, engineMass: e.mass, rotors: b.rotors, voice: engineVoice(b), boostPeak: b.induction === 'na' ? 0 : b.boost,
    transRating: t.strong ? t.rating : t.rating * (base.transK || 1),
  };
}

/** Torque (Nm) the block survives at full load: the tier's cylinder-pressure limit × displacement. */
export function blockTorque(e, stockEngine) {
  const T = TIERS[e.build.tier];
  const stockBmep = stockEngine.peakTorque * 4 * Math.PI / stockEngine.disp;
  return Math.max(T.strength * stockBmep, T.floorBar * 1e5) * e.disp / (4 * Math.PI);
}

/**
 * Top speed (km/h) where the best gear's pull (up to the rev limiter) meets drag + rolling
 * resistance on a level road — the same forces the car feels on track.
 */
export function topSpeed(spec) {
  const c = spec.torqueCurve, g = 9.81;
  const tq = (rpm) => { const i = Math.min(c.length - 2, Math.floor(rpm / 100)); const [r0, t0] = c[i], [r1, t1] = c[i + 1]; return t0 + (t1 - t0) * clamp((rpm - r0) / (r1 - r0), 0, 1); };
  const Ndrive = spec.mass * g * (spec.drive === 'AWD' ? 1 : spec.drive === 'FWD' ? spec.frontWeight : 1 - spec.frontWeight);
  const surplus = (v) => {
    let best = 0;
    for (const gr of spec.gears) {
      const G = gr * spec.finalDrive, rpm0 = v / spec.wheelRadius * G * 30 / Math.PI;
      // The driven tyres creep a few % faster than the road (Pacejka slope ≈ 14.5 per unit slip)
      const F0 = tq(rpm0) * G * spec.drivetrainEfficiency / spec.wheelRadius;
      const rpm = rpm0 * (1 + Math.min(0.04, Math.max(0, F0) / (spec.tyreMu * (spec.driveMuK || 1) * Ndrive * 14.5)));
      if (rpm > spec.limiterRpm) continue;
      best = Math.max(best, tq(rpm) * G * spec.drivetrainEfficiency / spec.wheelRadius);
    }
    return best - 0.5 * 1.225 * spec.dragCoefficient * spec.frontalArea * v * v - spec.rollingResistance * spec.mass * g;
  };
  let v = 5;
  while (v < 200 && surplus(v + 0.5) > 0) v += 0.5;
  for (let k = 0; k < 30; k++) { const m = v + 0.25; if (surplus(m) > 0) v = m; else break; }
  let lo = v, hi = v + 0.5;
  for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (surplus(m) > 0) lo = m; else hi = m; }
  return lo * 3.6;
}

/** Road speed (km/h) at the redline in each gear. */
export function shiftSpeeds(spec) {
  return spec.gears.map(g => spec.redlineRpm / 60 * 2 * Math.PI * spec.wheelRadius / (g * spec.finalDrive) * 3.6);
}

/** Cornering balance from the per-axle grip limits (1 = neutral). >1 understeer-safe, <1 oversteer. */
export function balance(spec) {
  return spec.frictionSlipRear / spec.frictionSlipFront;
}

/**
 * Straight-line run with the real drivetrain model: launch control, shifts at the limiter with the
 * transmission's own shift time, aero drag, rolling resistance and weight transfer.
 * Returns { t100, t200, quarter: { t, kmh }, top, curveTrace }.
 */
export function dragRun(spec, maxTime = 60, { failures = true } = {}) {
  const s = { ...spec };
  if (!failures) { s.blockTorque = 0; s.transRating = 0; s.limiterHeat = 0; }
  const d = new Drivetrain(s);
  const dt = 1 / 120, g = 9.81;
  d.tractionControl = true;
  d.autoClutch = s.transType !== 'manual' || s.launchRpm > 3500;   // (a peaky engine needs the clutch slipped)
  d.running = true;
  d.engineW = s.idleRpm * Math.PI / 30;
  const L = s.wheelbase || 2.921;
  // Load on the driven tyres: weight transfer to the rear helps RWD, hurts FWD, AWD uses all four
  const driveLoad = (acc) => {
    const st = s.mass * g, dT = s.mass * acc * s.cgHeight / L;
    if (s.drive === 'AWD') return st;
    if (s.drive === 'FWD') return Math.max(0, st * s.frontWeight - dT);
    return Math.max(0, st * (1 - s.frontWeight) + dT);
  };
  let failure = null;
  let v = 0, x = 0, t = 0, a = 0, t100 = null, t200 = null, quarter = null, top = 0, shiftAt = -1, stillTop = 0;
  d.gear = 1;
  if (s.transType === 'auto') d.autoDrive = true;
  // Arm launch control for 1 s
  d.brakeInput = 1; d.throttleInput = 1; d.clutchPedal = 0;
  for (let i = 0; i < 120; i++) d.step(dt, 0, driveLoad(0), s.tyreMu * (s.driveMuK || 1));
  d.brakeInput = 0;
  const trace = [];
  while (t < maxTime) {
    // Manual-style shifting at the limiter for every non-automatic box
    // (shift on road-speed rpm: during a launch the engine sits on the limiter while the clutch slips)
    const roadRpm = v / s.wheelRadius * s.gears[d.gear - 1] * s.finalDrive * 30 / Math.PI;
    if (s.transType !== 'auto' && d.gear < 5 && roadRpm > s.redlineRpm - 50 && shiftAt < 0) {
      shiftAt = t;
      if (s.transType === 'manual') { d.clutchPedal = 1; d.throttleInput = 0; } else d.requestGear(d.gear + 1, v);
    }
    if (shiftAt >= 0 && s.transType === 'manual') {
      if (t - shiftAt > s.shiftTime * 0.5 && d.clutchPedal === 1 && d.gear < 5 && d.throttleInput === 0) { d.requestGear(d.gear + 1, v); d.throttleInput = 0.0001; }
      if (t - shiftAt > s.shiftTime) { d.clutchPedal = Math.max(0, 1 - (t - shiftAt - s.shiftTime) / 0.12); d.throttleInput = 1; if (d.clutchPedal === 0) shiftAt = -1; }
    } else if (shiftAt >= 0 && t - shiftAt > s.shiftTime + 0.05) shiftAt = -1;
    const F = d.step(dt, v, driveLoad(a), s.tyreMu * (s.driveMuK || 1));
    const drag = 0.5 * 1.225 * s.dragCoefficient * s.frontalArea * v * v;
    const roll = s.rollingResistance * s.mass * g * (v > 0.1 ? 1 : 0);
    a = (F - drag - roll) / s.mass;
    v = Math.max(0, v + a * dt); x += v * dt; t += dt;
    const kmh = v * 3.6;
    if (!t100 && kmh >= 100) t100 = t;
    if (!t200 && kmh >= 200) t200 = t;
    if (!quarter && x >= 402.3) quarter = { t, kmh };
    if (kmh > top + 0.05) { top = kmh; stillTop = 0; } else if ((stillTop += dt) > 3 && quarter) break;
    if (Math.round(t / dt) % 6 === 0) trace.push([t, kmh, d.gear]);
    d.events.length = 0;
    if ((d.blown || d.transBroken) && !failure) failure = { t, kmh, what: d.blown ? 'engine' : 'trans', cause: d.blowCause };
    if (failure && t - failure.t > 1.5) break;
  }
  return { t100, t200, quarter, top, trace, failure };
}

/**
 * Which synth voice an engine gets: the exotic archetypes have their own, a car's factory engine
 * keeps its voice wherever it's swapped (b.voice), anything else sounds like a big American V8.
 */
export function engineVoice(b) {
  if (b.engine === 'rotary') return 'rotary';
  if (b.engine === 'radial') return 'radial';
  if (b.fuel === 'nitro') return 'topfuel';
  if (b.tier === 'f1') return 'f1';
  if (b.cyl >= 14) return 'turbine';
  return b.voice || null;
}

/** e.g. "V24", "3-ROTOR", "18-CYL RADIAL", "FLAT-6", "I1" */
export function engineName(b) {
  if (b.engine === 'rotary') return `${b.rotors}-ROTOR`;
  if (b.engine === 'radial') return `${b.cyl}-CYL RADIAL`;
  return `${b.layout === 'B' ? 'FLAT-' : b.layout === 'I' ? 'I' : 'V'}${b.cyl}`;
}

/** One-line summary for menus, e.g. "712 HP · 7.0 L V8 · BLOWN". */
export function summary(e) {
  const tag = { na: 'NA', turbo: 'TURBO', sc: 'BLOWN', twin: 'TWINCHARGED' }[e.build.induction];
  return `${Math.round(e.peakHp)} HP · ${e.dispL.toFixed(1)} L ${engineName(e.build)} · ${tag}`;
}
