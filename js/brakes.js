// Brake system: pad/disc compounds, a one-lump disc temperature model (fade), and a straight-line
// stopping simulation. Pure math, shared by the garage numbers and the driving physics.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// mu: friction vs street pads. Fade: friction falls off linearly from fadeStart to fadeEnd (°C)
// down to fadeMin. cold: friction below coldT (race pads and carbon want heat). heatCap: J/K of the
// whole brake set (carbon-ceramic discs are big and survive far more heat, but heat up faster).
export const BRAKES = {
  street: { name: 'Street', mu: 1.0, fadeStart: 420, fadeEnd: 700, fadeMin: 0.5, coldT: 0, cold: 1, heatCap: 26000 },
  racing: { name: 'Racing', mu: 1.28, fadeStart: 620, fadeEnd: 920, fadeMin: 0.62, coldT: 120, cold: 0.88, heatCap: 30000 },
  carbon: { name: 'Carbon-ceramic', mu: 1.45, fadeStart: 950, fadeEnd: 1250, fadeMin: 0.75, coldT: 180, cold: 0.85, heatCap: 24000 },
};
export const BRAKE_LIMITS = { pressure: [0.6, 1.4, 0.05], bias: [0.5, 0.8, 0.01] };
export const AMBIENT = 30;

/** Friction multiplier at disc temperature T. */
export function brakeFade(c, T) {
  let f = 1;
  if (T > c.fadeStart) f = 1 - (1 - c.fadeMin) * clamp((T - c.fadeStart) / (c.fadeEnd - c.fadeStart), 0, 1);
  if (c.coldT && T < c.coldT) f *= c.cold + (1 - c.cold) * T / c.coldT;
  return f;
}

/** Advance the disc temperature: heat in from braking power (W), out to the air (more at speed). */
export function brakeHeat(c, T, power, speed, dt) {
  const cool = (T - AMBIENT) * (0.018 + 0.0022 * Math.abs(speed));
  return T + (power / c.heatCap - cool) * dt;
}

/**
 * Straight-line stop from v0 (m/s) at full pedal: per-axle brake force (pressure, bias, compound,
 * fade) capped by each axle's tyre grip under weight transfer, plus drag and rolling resistance.
 * Returns { dist (m), time (s), temp (°C at the end) }.
 */
export function stopDistance(spec, v0, T0 = 120) {
  const c = BRAKES[spec.brakeCompound] || BRAKES.street;
  const g = 9.81, dt = 1 / 240, m = spec.mass, L = spec.wheelbase;
  const mu = spec.tyreMu;
  let v = v0, x = 0, t = 0, a = 0, T = T0;
  while (v > 0.05 && t < 60) {
    const f = brakeFade(c, T);
    const Fb = spec.maxBrakeForce * f;
    const dN = m * a * spec.cgHeight / L;                     // load moves forward under braking
    const Nf = m * g * spec.frontWeight + dN, Nr = Math.max(0, m * g * (1 - spec.frontWeight) - dN);
    // Front axle limited by grip (ABS keeps it at the peak; without ABS a locked wheel slides at ~85 %)
    const lock = spec.abs ? 1 : 0.85;
    const ff = Fb * spec.brakeBiasFront, fr = Fb * (1 - spec.brakeBiasFront);
    const Ff = ff > mu * Nf ? mu * Nf * lock : ff, Fr = fr > mu * Nr ? mu * Nr * lock : fr;
    const drag = 0.5 * 1.225 * spec.dragCoefficient * spec.frontalArea * v * v + spec.rollingResistance * m * g;
    a = (Ff + Fr + drag) / m;
    T = brakeHeat(c, T, (Ff + Fr) * v, v, dt);
    v -= a * dt; x += Math.max(0, v) * dt; t += dt;
  }
  return { dist: x, time: t, temp: T };
}
