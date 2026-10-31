// Cannon-es raycast vehicle wrapped around the custom drivetrain.
import * as CANNON from '../vendor/cannon-es.js';
import { Drivetrain } from './drivetrain.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class Vehicle {
  constructor(world, spec, materials) {
    this.spec = spec;
    this.world = world;
    this.drivetrain = new Drivetrain(spec);

    const L = spec.wheelbase;
    this.frontAxleZ = -(1 - spec.frontWeight) * L;   // CoM sits closer to the front axle
    this.rearAxleZ = spec.frontWeight * L;
    const zFront = this.frontAxleZ - spec.frontOverhang;
    const zRear = zFront + spec.length;
    this.bodyZFront = zFront;
    this.bodyZRear = zRear;

    const body = new CANNON.Body({ mass: spec.mass, material: materials.chassis });
    // Lower body: 0.25 m → 0.90 m above ground
    const lowerH = 0.65, lowerY = 0.25 + lowerH / 2 - spec.cgHeight;
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(spec.width / 2, lowerH / 2, spec.length / 2)),
      new CANNON.Vec3(0, lowerY, (zFront + zRear) / 2),
    );
    // Greenhouse
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.72, 0.22, 0.95)),
      new CANNON.Vec3(0, 1.12 - spec.cgHeight, zFront + 0.6 * spec.length),
    );
    const I = spec.inertia;
    body.inertia.set(I.pitch, I.yaw, I.roll);
    body.invInertia.set(1 / I.pitch, 1 / I.yaw, 1 / I.roll);
    body.updateInertiaWorld(true);
    body.linearDamping = 0;
    body.angularDamping = 0.06;
    body.allowSleep = false;
    this.body = body;

    const vehicle = new CANNON.RaycastVehicle({
      chassisBody: body, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2,
    });

    // Wheel hub height: chassis connection placed so that the static ride height
    // puts wheel centres at tyre radius above the ground.
    const staticCompression = 9.81 / (4 * spec.suspensionStiffness);
    const restLen = spec.suspensionRestLength;
    const hubY = spec.wheelRadius - spec.cgHeight;
    const connY = hubY + (restLen - staticCompression);
    const base = {
      radius: spec.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(1, 0, 0),
      suspensionStiffness: spec.suspensionStiffness,
      suspensionRestLength: restLen,
      dampingRelaxation: spec.dampingRelaxation,
      dampingCompression: spec.dampingCompression,
      maxSuspensionForce: 1e6,
      maxSuspensionTravel: 0.22,
      rollInfluence: spec.rollInfluence,
    };
    const tf = spec.trackFront / 2, tr = spec.trackRear / 2;
    const pts = [
      [-tf, this.frontAxleZ, spec.frictionSlipFront],
      [tf, this.frontAxleZ, spec.frictionSlipFront],
      [-tr, this.rearAxleZ, spec.frictionSlipRear],
      [tr, this.rearAxleZ, spec.frictionSlipRear],
    ];
    for (const [x, z, fs] of pts) {
      vehicle.addWheel({ ...base, frictionSlip: fs, chassisConnectionPointLocal: new CANNON.Vec3(x, connY, z) });
    }
    vehicle.addToWorld(world);
    this.vehicle = vehicle;

    this.steer = 0;            // road-wheel angle (rad), + = left
    this.speed = 0;            // forward m/s
    this.lateralSlip = 0;      // rear lateral slip m/s
    this.rearLoose = 0;        // 0..0.6 rear lateral grip lost to wheelspin
    this.slideAngle = 0;       // body slip angle, degrees
    this.frontSlide = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.surfaceMu = 1;
    this.surfaceDrag = 1;
    this.brakeInput = 0;
    this.wallTimer = 0;
    this.wheelie = 0;          // 0..1 wheelie drive this step
    this.wheelieAmt = 0;
    this.pitch = 0;            // nose-up angle (rad)        // seconds since/while scraping a barrier: stabilises the slide
    this._fwd = new CANNON.Vec3();
    this._right = new CANNON.Vec3();
    this._tmp = new CANNON.Vec3();
  }

  get rpm() { return this.drivetrain.rpm; }

  /** Called on contact with a barrier (impact speed m/s). */
  wallHit(v) {
    this.wallTimer = Math.max(this.wallTimer, 0.5 + Math.min(0.7, v * 0.05));
    this.drivetrain.antiStall = 3;
  }

  /** Place the car at a world position with a heading (rad about Y). */
  reset(x, y, z, heading) {
    const b = this.body;
    b.position.set(x, y + this.spec.cgHeight + 0.15, z);
    b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.force.setZero();
    b.torque.setZero();
    this.drivetrain.wheelW = 0;
    this.steer = 0;
  }

  /**
   * @param input { throttle, brake, clutch, steer(-1..1, + = left) }
   */
  update(dt, input) {
    const s = this.spec, dtn = this.drivetrain, b = this.body, wi = this.vehicle.wheelInfos;

    b.quaternion.vmult(this._fwd.set(0, 0, -1), this._fwd);
    b.quaternion.vmult(this._right.set(1, 0, 0), this._right);
    const v = b.velocity.dot(this._fwd);
    const vLat = b.velocity.dot(this._right);
    this.speed = v;

    // --- Steering: speed-sensitive lock + rate limit, Ackermann geometry.
    // At speed, full lock is capped at ~3× the angle for limit cornering: enough to bite hard and
    // scrub speed into a hairpin, not enough to throw the car into a spin. While sliding, extra
    // lock is released for counter-steer.
    const vv = Math.max(Math.abs(v), 1);
    const gripLock = 3.0 * s.wheelbase * s.tyreMu * this.surfaceMu * 9.81 / (vv * vv);
    // Counter-steer = steering toward where the car is actually travelling (+ steer is left, + vLat is right)
    const counter = input.steer * vLat < 0 && Math.abs(v) > 4;
    const counterRoom = counter ? Math.min(0.3, Math.atan2(Math.abs(vLat), Math.abs(v))) : 0;
    const lock = Math.min(s.maxSteer / (1 + (v / s.steerSpeedFalloff) ** 2), Math.max(0.04, gripLock)) + counterRoom;
    const target = clamp(input.steer, -1, 1) * lock;
    const rate = 2.4 * dt;
    this.steer += clamp(target - this.steer, -rate, rate);
    const d = this.steer;
    if (Math.abs(d) > 1e-4) {
      const R = s.wheelbase / Math.tan(Math.abs(d));
      const inner = Math.atan(s.wheelbase / (R - s.trackFront / 2));
      const outer = Math.atan(s.wheelbase / (R + s.trackFront / 2));
      const sg = Math.sign(d);
      // + steer = left turn → left wheel (0) is the inner one
      this.vehicle.setSteeringValue(sg > 0 ? inner : -outer, 0);
      this.vehicle.setSteeringValue(sg > 0 ? outer : -inner, 1);
    } else {
      this.vehicle.setSteeringValue(0, 0);
      this.vehicle.setSteeringValue(0, 1);
    }

    // Turn-in assist: when the car is turning less than the front wheels ask for (understeer),
    // help the nose rotate toward that yaw rate. Capped at a 1.6 g-equivalent rate and never
    // pushes past the request, so it can't spin the car; it switches off while sliding.
    if (Math.abs(v) > 4 && Math.abs(d) > 0.01 && this.rearLoose < 0.15) {
      const want = v * Math.tan(d) / s.wheelbase;
      const cap = 1.6 * 9.81 / Math.abs(v);
      const target = clamp(want, -cap, cap);
      const yaw = b.angularVelocity.y;
      if (Math.sign(target) === Math.sign(want) && Math.abs(yaw) < Math.abs(target) && Math.sign(yaw || target) === Math.sign(target)) {
        b.angularVelocity.y += (target - yaw) * Math.min(1, dt * 3.5);
      }
    }

    // --- Drivetrain → rear tyres
    dtn.throttleInput = input.throttle;
    dtn.brakeInput = input.brake;
    this.brakeInput = input.brake;
    dtn.clutchPedal = input.clutch;
    dtn.handbrake = input.handbrake ? 1 : 0;
    const Nl = wi[2].raycastResult.body ? wi[2].suspensionForce : 0;
    const Nr = wi[3].raycastResult.body ? wi[3].suspensionForce : 0;
    const N = Nl + Nr;
    const mu = s.tyreMu * this.surfaceMu;
    const F = dtn.step(dt, v, N, mu);
    if (N > 1) {
      this.vehicle.applyEngineForce(F * Nl / N, 2);
      this.vehicle.applyEngineForce(F * Nr / N, 3);
    } else {
      this.vehicle.applyEngineForce(0, 2);
      this.vehicle.applyEngineForce(0, 3);
    }

    // Wheelspin / lock-up eats rear lateral grip → power oversteer. The fall-off is progressive
    // and never below ~40 %, so a spinning rear steps out into a slide rather than snapping round.
    const sl = Math.abs(dtn.slip);
    const latFactor = Math.max(0.45, 1 / (1 + Math.pow(Math.max(0, sl - 0.08) * 2.0, 1.5)));
    // Hand brake: locked rears slide sideways easily → the tail swings out into a drift
    const hb = dtn.handbrake && Math.abs(v) > 3 ? 0.5 : 1;
    wi[2].frictionSlip = wi[3].frictionSlip = s.frictionSlipRear * mu * latFactor * hb;
    this.rearLoose = 1 - latFactor * hb;

    // Drift feel: extra yaw damping while the rear is loose makes the rotation build gradually
    // (holdable with throttle and counter-steer instead of an instant spin)
    if (this.rearLoose > 0.02) b.angularVelocity.y *= Math.max(0, 1 - this.rearLoose * (hb < 1 ? 1.8 : 3.2) * dt);

    // Wheelie: a launch-control or nitrous start puts so much torque through the rears that the
    // nose rears up and the front wheels leave the ground for a moment. Pitch-up torque scales
    // with drive force, fades with speed and is capped near 6° so the car always comes back down.
    const boost = Math.max(dtn.launchTimer > 0 ? 1 : 0, dtn.nitrousAmt);
    let wl = boost * clamp((F - 7000) / 9000, 0, 1) * clamp(1 - Math.abs(v) / 17, 0, 1);
    b.quaternion.vmult(this._tmp.set(0, 0, -1), this._tmp);
    const pitch = Math.asin(clamp(this._tmp.y, -1, 1));
    this.pitch = pitch;
    wl *= clamp((0.1 - pitch) / 0.07, 0, 1);                 // soft cap: eases off from ~2° to ~6°
    this.wheelieAmt += (wl - this.wheelieAmt) * Math.min(1, dt * 6);   // ramp in/out, no jolts
    this.wheelie = this.wheelieAmt;
    if (this.wheelieAmt > 0.01 || pitch > 0.02) {
      // Pitch-rate damping while the nose is up, so it settles back down instead of slamming
      b.quaternion.vmult(this._right.set(1, 0, 0), this._right);
      const pitchRate = b.angularVelocity.dot(this._right);
      const T = s.wheelieTorque * this.wheelieAmt - 9000 * pitchRate * (pitch > 0.01 ? 1 : 0);
      b.quaternion.vmult(this._tmp.set(T, 0, 0), this._tmp);
      b.torque.vadd(this._tmp, b.torque);
    }

    // With traction control on, trim the throttle once the slide angle gets excessive
    const slideAngle = Math.abs(v) > 4 ? Math.atan2(Math.abs(vLat), Math.abs(v)) * 57.3 : 0;
    this.slideAngle = slideAngle;
    dtn.stabilityCut = dtn.tractionControl ? clamp((slideAngle - 28) / 22, 0, 0.75) : 0;
    wi[0].frictionSlip = wi[1].frictionSlip = s.frictionSlipFront * mu;

    // Front disc brakes (cannon brake value is an impulse per step)
    const fb = input.brake * s.maxBrakeForce * s.brakeBiasFront * 0.5 * dt;
    this.vehicle.setBrake(fb, 0);
    this.vehicle.setBrake(fb, 1);
    this.vehicle.setBrake(0, 2);
    this.vehicle.setBrake(0, 3);

    // --- Aero drag + rolling resistance
    const vel = b.velocity;
    const sp = vel.length();
    if (sp > 0.05) {
      const grounded = wi.some(w => w.raycastResult.body);
      const drag = 0.5 * 1.225 * s.dragCoefficient * s.frontalArea * sp * sp;
      const roll = grounded ? s.rollingResistance * this.surfaceDrag * s.mass * 9.81 * Math.min(1, sp / 0.5) : 0;
      const k = -(drag + roll) / sp;
      b.applyForce(this._tmp.set(vel.x * k, vel.y * k * 0.2, vel.z * k));
    }

    // Scraping a wall: damp the spin the impact induces so the car straightens up and slides along it
    if (this.wallTimer > 0) {
      this.wallTimer -= dt;
      const k = Math.max(0, 1 - 6 * dt);
      b.angularVelocity.y *= k;
      b.angularVelocity.x *= k; b.angularVelocity.z *= k;
    }

    // Telemetry for audio/effects
    this.lateralSlip = Math.abs(vLat);
    this.frontSlide = (wi[0].sliding || wi[1].sliding) ? 1 : 0;

    // Visual wheel spin rates
    const fw = v / s.wheelRadius;
    this.wheelSpin[0] = this.wheelSpin[1] = input.brake > 0.85 && Math.abs(v) < 0.3 ? 0 : fw;
    this.wheelSpin[2] = this.wheelSpin[3] = dtn.wheelW;
  }

  /** Grip loss metric 0..1 for tyre squeal & smoke. */
  tyreScrub() {
    const longi = Math.min(1, Math.max(0, Math.abs(this.drivetrain.slip) - 0.08) * 2.5);
    const lat = Math.min(1, Math.max(0, this.lateralSlip - 1.6) / 5);
    return Math.max(longi, lat * Math.min(1, Math.abs(this.speed) / 6));
  }

  isUpsideDown() {
    const up = this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    return up.y < 0.3;
  }
}
