// Engine + clutch + 5-speed gearbox + rear axle with tyre slip.
// Pure math (no rendering) so it can be unit-tested in Node.

const RAD2RPM = 60 / (2 * Math.PI);
const RPM2RAD = 1 / RAD2RPM;
const SUBSTEPS = 4;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Simplified Pacejka longitudinal curve, peak ~ slip 0.17
const B = 10, C = 1.45;
function pac(s) { return Math.sin(C * Math.atan(B * s)); }
function pacSlope(s) {
  const a = Math.atan(B * s);
  return Math.cos(C * a) * C * B / (1 + B * B * s * s);
}

export class Drivetrain {
  constructor(spec) {
    this.spec = spec;
    this.engineW = 0;          // crank rad/s
    this.wheelW = 0;           // rear axle rad/s
    this.gear = 0;             // -1 = R, 0 = N, 1..5
    this.running = false;
    this.starterTime = 0;

    // inputs
    this.throttleInput = 0;
    this.brakeInput = 0;
    this.clutchPedal = 0;      // 1 = fully pressed (disengaged)

    // options
    this.tractionControl = false;
    this.autoClutch = false;

    // state / telemetry
    this.throttle = 0;
    this.tcsFactor = 1;
    this.limiterCut = false;
    this.cutAmount = 0;        // soft rev-limiter spark cut 0..1
    this.powerSlide = 0;       // 0..1: 1st/2nd at full throttle — rear breaks loose
    this.stabilityCut = 0;     // set by the vehicle: throttle trimmed when the slide gets too big (TCS on)
    this.nitrous = 0;          // input: 1 while the NOS solenoids are open
    this.nitrousAmt = 0;       // smoothed 0..1
    this.load = 0;             // effective combustion load 0..1 (for audio)
    this.engineTorque = 0;
    this.slip = 0;
    this.force = 0;
    this.clutchEngage = 1;
    this.clutchSlipping = false;
    this.shiftTimer = 0;
    this.events = [];
  }

  get rpm() { return this.engineW * RAD2RPM; }

  ratio(g = this.gear) {
    const s = this.spec;
    if (g === 0) return 0;
    if (g === -1) return -s.reverse * s.finalDrive;
    return s.gears[g - 1] * s.finalDrive;
  }

  fullTorque(rpm) {
    const c = this.spec.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const [r0, t0] = c[i - 1], [r1, t1] = c[i];
        return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
      }
    }
    return c[c.length - 1][1];
  }

  friction(rpm) {
    if (rpm <= 0) return 0;
    const k = rpm / 1000;
    return 22 + 11 * k + 1.3 * k * k;   // pumping + mechanical losses (engine braking)
  }

  pedalEngagement() {
    return 1 - smoothstep(0.25, 0.8, this.clutchPedal);
  }

  start() {
    if (this.running || this.starterTime > 0) return 'busy';
    if (this.gear !== 0 && this.pedalEngagement() > 0.3 && !this.autoClutch) return 'clutch';
    this.starterTime = 0.75;
    this.events.push('starter');
    return 'ok';
  }

  // Returns true if the gear engaged, false if it ground.
  requestGear(g, speed) {
    if (g === this.gear) return true;
    if (g === 0) {
      this.gear = 0;
      this.events.push('neutral');
      return true;
    }
    if (g === -1 && speed < -1.5) { /* already rolling backwards: fine */ }
    else if (g === -1 && speed > 1.5) { this.events.push('grind'); return false; }
    else if (g > 0 && speed < -2.5) { this.events.push('grind'); return false; }

    const disengaged = this.autoClutch || this.pedalEngagement() < 0.2;
    if (!disengaged) {
      // Clutchless shift only if revs are matched to the new gear.
      const target = Math.abs(this.wheelW * this.ratio(g)) * RAD2RPM;
      if (!this.running || Math.abs(this.rpm - target) > 380) {
        this.events.push('grind');
        return false;
      }
    }
    const up = g > this.gear;
    this.gear = g;
    if (this.autoClutch) this.shiftTimer = 0.2;
    this.events.push(up ? 'shiftUp' : 'shiftDown');
    return true;
  }

  tyre(w, v, N, mu) {
    const r = this.spec.wheelRadius;
    const denom = Math.max(Math.abs(v), 3);
    const s = (w * r - v) / denom;
    const muN = mu * N;
    return {
      s,
      F: muN * pac(s),
      D: Math.max(0, muN * pacSlope(s) * r / denom),
    };
  }

  autoEngagement(dt) {
    if (this.shiftTimer > 0) { this.shiftTimer -= dt; return 0; }
    if (this.gear === 0) return 0;
    const boxRpm = Math.abs(this.wheelW * this.ratio()) * RAD2RPM;
    if (boxRpm > 1500) return 1;
    // Slipping launch: engage as revs build
    return clamp((this.rpm - 950) / 1300, 0, 1) * (this.throttle > 0.05 ? 1 : 0.0);
  }

  /**
   * Advance the drivetrain.
   * @param dt     step length
   * @param v      forward speed of the rear axle (m/s)
   * @param N      total normal load on rear tyres (N)
   * @param mu     surface friction multiplier
   * @returns rear longitudinal tyre force (N, + = forward)
   */
  step(dt, v, N, mu) {
    const s = this.spec;
    const r = s.wheelRadius;
    const Ie = s.engineInertia;
    const Iw = s.rearAxleInertia;
    const eff = s.drivetrainEfficiency;

    // Power slide: flooring it in 1st or 2nd lights up the rears. Near the limiter the torque
    // kick breaks traction outright, so the revs hang on the limiter with the tyres spinning
    // instead of bouncing off it.
    const lowGearWot = this.running && this.gear > 0 && this.gear <= 2 && this.throttleInput > 0.85;
    const nearLimiter = this.rpm > s.limiterRpm - 900;
    const slideTarget = lowGearWot ? (nearLimiter ? 1 : 0.6) : 0;
    this.powerSlide += (slideTarget - this.powerSlide) * Math.min(1, dt * (slideTarget > this.powerSlide ? 5 : 2.5));

    // Traction control (optional). In a low-gear power slide it lets the tyres spin up to a
    // drift-friendly slip instead of shutting the slide down.
    const slipLimit = 0.16 + this.powerSlide * 0.42;
    const floor = 0.12 + this.powerSlide * 0.2;
    if (this.tractionControl && this.gear > 0 && this.slip > slipLimit && this.rpm > 1800) {
      this.tcsFactor = Math.max(floor, this.tcsFactor - dt * 7);
    } else {
      this.tcsFactor = Math.min(1, this.tcsFactor + dt * 2.5);
    }
    // Throttle body response
    const target = this.throttleInput * this.tcsFactor * (1 - this.stabilityCut);
    this.throttle += (target - this.throttle) * Math.min(1, dt / 0.045);

    const engage = this.autoClutch ? this.autoEngagement(dt) : this.pedalEngagement();
    this.clutchEngage = engage;
    const Tcap = s.clutchMaxTorque * Math.pow(engage, 1.4);
    const G = this.ratio();
    const brakeT = this.brakeInput * s.maxBrakeForce * (1 - s.brakeBiasFront) * r;

    // The torque kick breaks the rears loose; once they're spinning, full grip returns so the
    // spinning tyres still drive the car forward through the slide
    const muDrive = mu * (1 - 0.3 * this.powerSlide * clamp(1 - Math.abs(this.slip) / 0.35, 0, 1));
    // Nitrous: a big wet shot, ~+55 % torque (≈ +380 hp at the peak), only with the engine lit
    this.nitrousAmt += ((this.running ? this.nitrous : 0) - this.nitrousAmt) * Math.min(1, dt / 0.08);
    const nosMul = 1 + 0.55 * this.nitrousAmt;
    const h = dt / SUBSTEPS;
    let Fsum = 0, loadSum = 0, slipSum = 0, Tsum = 0;
    let slipping = false;

    for (let i = 0; i < SUBSTEPS; i++) {
      const rpm = this.engineW * RAD2RPM;
      let Te, load = 0;

      if (this.running) {
        const idleThr = clamp(0.035 + (s.idleRpm - rpm) * 0.0011, 0, 0.45);
        let thr = Math.max(this.throttle, idleThr);
        // Soft limiter: progressive spark cut over the last ~160 rpm
        const cutAmt = clamp((rpm - (s.limiterRpm - 140)) / 160, 0, 1);
        if (cutAmt > 0.45 && !this.limiterCut) { this.limiterCut = true; this.events.push('limiter'); }
        else if (cutAmt < 0.1) this.limiterCut = false;
        this.cutAmount = cutAmt;
        thr *= 1 - cutAmt;
        Te = this.fullTorque(rpm) * thr * nosMul - this.friction(rpm) * (1 - thr);
        load = thr;
      } else {
        Te = -this.friction(rpm) - (rpm > 1 ? 25 : 0);
        if (this.starterTime > 0) Te += rpm < 260 ? 150 : 40;
      }

      const tyre = this.tyre(this.wheelW, v, N, muDrive);
      let locked = false;

      if (G === 0 || Tcap < 1) {
        this.engineW += h * Te / Ie;
        this.wheelW += h * (-r * tyre.F) / (Iw + h * r * tyre.D);
      } else {
        const Ic = Iw + Ie * G * G;
        const w0 = (Iw * this.wheelW + Ie * G * this.engineW) / Ic;
        const w1 = w0 + h * (Te * G * eff - r * tyre.F) / (Ic + h * r * tyre.D);
        const Tc = Te - Ie * (w1 * G - this.engineW) / h;
        if (Math.abs(Tc) <= Tcap) {
          locked = true;
          this.wheelW = w1;
          this.engineW = w1 * G;
        } else {
          slipping = true;
          const slipDir = Math.sign(this.engineW - this.wheelW * G) || Math.sign(Tc);
          const Tcl = slipDir * Tcap;
          this.engineW += h * (Te - Tcl) / Ie;
          this.wheelW += h * (Tcl * G * eff - r * tyre.F) / (Iw + h * r * tyre.D);
        }
      }

      // Rear drum brakes (Coulomb friction on the axle)
      if (brakeT > 0) {
        const I = locked ? Iw + Ie * G * G : Iw;
        const dw = brakeT * h / I;
        if (Math.abs(this.wheelW) <= dw) this.wheelW = 0;
        else this.wheelW -= Math.sign(this.wheelW) * dw;
        if (locked) this.engineW = this.wheelW * G;
      }

      if (this.engineW < 0) {
        this.engineW = 0;
        if (locked && G !== 0) this.wheelW = 0;
      }

      if (this.running && this.engineW * RAD2RPM < s.stallRpm) {
        this.running = false;
        this.limiterCut = false;
        this.events.push('stall');
      }

      const out = this.tyre(this.wheelW, v, N, muDrive);
      Fsum += out.F;
      slipSum += out.s;
      loadSum += load;
      Tsum += Te;
    }

    if (this.starterTime > 0) {
      this.starterTime -= dt;
      if (this.starterTime <= 0) {
        if (this.rpm > 150) {
          this.running = true;
          this.engineW = Math.max(this.engineW, 520 * RPM2RAD);
          this.events.push('ignition');
        } else {
          this.events.push('starterFail');
        }
      }
    }

    this.clutchSlipping = slipping;
    this.force = Fsum / SUBSTEPS;
    this.slip = slipSum / SUBSTEPS;
    this.load = loadSum / SUBSTEPS;
    this.engineTorque = Tsum / SUBSTEPS;
    return this.force;
  }
}

export { RAD2RPM, RPM2RAD };
