// 1979 Dodge Charger (B-body) — real-world dimensions, tuned 700 HP Hemi.
// Units: meters, kilograms, seconds, newtons, radians. Car forward = -Z, right = +X, up = +Y.

const IN = 0.0254;

export const SPEC = {
  // Body (factory 1979 Charger SE figures)
  length: 215.8 * IN,        // 5.481 m
  width: 77.1 * IN,          // 1.958 m
  height: 53.2 * IN,         // 1.351 m
  wheelbase: 115.0 * IN,     // 2.921 m
  trackFront: 61.2 * IN,     // 1.554 m
  trackRear: 62.0 * IN,      // 1.575 m
  frontOverhang: 1.05,
  mass: 1770,                // ~3,900 lb with driver & fuel
  frontWeight: 0.56,         // nose-heavy cast-iron V8
  cgHeight: 0.53,
  inertia: { pitch: 3900, yaw: 4300, roll: 780 },

  // Tyres: P225/70R15 front, P275/60R15 rear (same rolling radius)
  wheelRadius: 0.343,
  tyreWidthFront: 0.225,
  tyreWidthRear: 0.275,
  tyreMu: 1.2,               // sticky street/strip radials

  // Suspension (soft '70s muscle car)
  suspensionRestLength: 0.32,
  suspensionStiffness: 26,
  dampingCompression: 3.4,
  dampingRelaxation: 2.6,
  rollInfluence: 0.09,
  // Lateral grip limits. The rear must out-grip the front: cannon's tyres saturate at tiny slip
  // angles, so the axle that lets go first decides the balance. Rear-first (the old 1.08 / 1.00)
  // meant built-in oversteer and a yaw that kept growing at speed; front-first = stable understeer.
  // Power oversteer still comes from wheelspin eating rear grip (see vehicle.js).
  frictionSlipFront: 1.15,
  frictionSlipRear: 1.25,

  // Engine — 7.2L Hemi, built to 700 hp @ 6200 rpm
  idleRpm: 850,
  redlineRpm: 6500,
  limiterRpm: 6800,
  stallRpm: 420,
  engineInertia: 0.30,
  // [rpm, full-load torque Nm]
  torqueCurve: [
    [0, 0], [500, 330], [800, 430], [1500, 570], [2500, 730], [3500, 850],
    [4600, 910], [5500, 885], [6200, 804], [6800, 700], [7400, 470],
  ],

  // Drivetrain — long-legged 5-speed, 3.23 rear axle, Sure-Grip diff
  gears: [2.95, 1.94, 1.34, 1.00, 0.80],
  reverse: 3.00,
  finalDrive: 3.23,
  drivetrainEfficiency: 0.88,
  clutchMaxTorque: 1650,
  rearAxleInertia: 2.6,      // both rear wheels + axle + driveshaft

  // Brakes — discs front, drums rear, no ABS
  maxBrakeForce: 17500,
  brakeBiasFront: 0.66,
  handbrakeTorque: 4200,
  wheelieTorque: 30000,      // N·m nose-up on an all-out launch (see vehicle.js)     // N·m on the rear axle: locks the rears at any speed

  // Aero / resistance
  dragCoefficient: 0.46,
  frontalArea: 2.15,
  rollingResistance: 0.013,

  // Steering
  maxSteer: 0.70,            // ~40° lock at the road wheel
  steerSpeedFalloff: 24,     // m/s at which available lock halves
};

export const PHYSICS_DT = 1 / 120;

// Shown in the menu so it's easy to confirm which version a phone is running (sw.js VERSION matches).
export const BUILD = 10;

// Car body vs barriers: frictionless and barely bouncy, so the car glances off and slides along
// the wall instead of snagging, spinning round or stopping dead.
export const WALL_CONTACT = { friction: 0, restitution: 0.05 };
