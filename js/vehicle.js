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
    this.frontSlide = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.surfaceMu = 1;
    this.surfaceDrag = 1;
    this.brakeInput = 0;
    this._fwd = new CANNON.Vec3();
    this._right = new CANNON.Vec3();
    this._tmp = new CANNON.Vec3();
  }

  get rpm() { return this.drivetrain.rpm; }

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

    // --- Steering: speed-sensitive lock + rate limit, Ackermann geometry
    const lock = s.maxSteer / (1 + (v / s.steerSpeedFalloff) ** 2);
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

    // --- Drivetrain → rear tyres
    dtn.throttleInput = input.throttle;
    dtn.brakeInput = input.brake;
    this.brakeInput = input.brake;
    dtn.clutchPedal = input.clutch;
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

    // Wheelspin / lock-up kills rear lateral grip → power oversteer
    const sl = Math.abs(dtn.slip);
    const latFactor = sl < 0.12 ? 1 : Math.max(0.3, 1 - (sl - 0.12) * 1.7);
    wi[2].frictionSlip = wi[3].frictionSlip = s.frictionSlipRear * mu * latFactor;
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
