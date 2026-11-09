// Engine + clutch + 5-speed gearbox + driven axle with tyre slip (rear, front or both for AWD).
// Pure math (no rendering) so it can be unit-tested in Node.

const RAD2RPM = 60 / (2 * Math.PI);
const RPM2RAD = 1 / RAD2RPM;
const SUBSTEPS = 4;
const LAUNCH_RPM = 3500;      // launch-control two-step
const LAUNCH_SLIP = 0.12;     // target rear slip during a launch: just past peak grip

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
    this.antiStall = 0;        // seconds of anti-stall protection left (set on wall impacts)
    this.handbrake = 0;        // input: 1 while the hand brake is pulled
    this.launchArmed = false;  // holding BRAKE + GAS at a standstill in 1st
    this.launchTimer = 0;      // seconds of launch assistance left after the brake is released
    this.launchClutch = 0;     // automated clutch ramp during the launch
    this.launchFactor = 1;     // launch traction controller throttle multiplier
    this.autoDrive = false;    // automatic transmission in D: the box picks gears 1-5 itself
    this.spool = 0;            // turbo spool 0..1 (lags the throttle)
    this.boostPsi = 0;         // current boost for the HUD/audio
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
    this.repair();
  }

  /** Fresh engine and gearbox (a new run). */
  repair() {
    this.blown = false;        // engine destroyed: no restart this run
    this.blowCause = '';
    this.transBroken = false;  // gearbox shredded: no drive, the engine revs freely
    this.engineDamage = 0;     // 0..1 (blows at 1)
    this.transDamage = 0;
    this.heat = 0;             // seconds held at/over the redline (cools when below)
    this.transLoad = 0;        // filtered torque through the gearbox (Nm)
    this.stress = { engine: 0, heat: 0, trans: 0 };
  }

  blow(cause) {
    if (this.blown) return;
    this.blown = true;
    this.blowCause = cause;
    this.running = false;
    this.limiterCut = false;
    this.starterTime = 0;
    this.events.push('blown');
  }

  get rpm() { return this.engineW * RAD2RPM; }

  ratio(g = this.gear) {
    const s = this.spec;
    if (g === 0 || this.transBroken) return 0;
    if (g === -1) return -s.reverse * s.finalDrive;
    return s.gears[g - 1] * s.finalDrive;
  }

  fullTorque(rpm) {
    const c = this.spec.torqueCurve;
    if (rpm <= c[0][0]) return c[0][1];
    // Garage builds tabulate every 100 rpm: index directly
    if (c.length > 20 && c[1][0] === 100) {
      const i = Math.min(c.length - 2, Math.floor(rpm / 100));
      const [r0, t0] = c[i], [r1, t1] = c[i + 1];
      return t0 + (t1 - t0) * clamp((rpm - r0) / (r1 - r0), 0, 1);
    }
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
    return (22 + 11 * k + 1.3 * k * k) * (this.spec.frictionScale || 1);   // pumping + mechanical losses
  }

  /** Steady-state boost pressure ratio at this rpm (turbo builds only). */
  boostPR(rpm) {
    const c = this.spec.boostCurve;
    if (!c) return 1;
    const i = Math.min(c.length - 2, Math.max(0, Math.floor(rpm / 100)));
    const [r0, p0] = c[i], [r1, p1] = c[i + 1];
    return p0 + (p1 - p0) * clamp((rpm - r0) / (r1 - r0), 0, 1);
  }

  get sequential() { return this.spec.transType && this.spec.transType !== 'manual'; }

  pedalEngagement() {
    return 1 - smoothstep(0.25, 0.8, this.clutchPedal);
  }

  start() {
    if (this.blown) { this.events.push('blownStart'); return 'blown'; }
    if (this.running || this.starterTime > 0) return 'busy';
    if (this.gear !== 0 && this.pedalEngagement() > 0.3 && !this.autoClutch) return 'clutch';
    this.starterTime = 0.75;
    this.events.push('starter');
    return 'ok';
  }

  // Returns true if the gear engaged, false if it ground.
  requestGear(g, speed) {
    if (this.transBroken) { this.events.push('noGears'); return false; }
    if (g === this.gear) return true;
    if (g === 0) {
      this.gear = 0;
      this.events.push('neutral');
      return true;
    }
    if (g === -1 && speed < -1.5) { /* already rolling backwards: fine */ }
    else if (g === -1 && speed > 1.5) { this.events.push('grind'); return false; }
    else if (g > 0 && speed < -2.5) { this.events.push('grind'); return false; }

    if (this.sequential) {
      // Sequential / automatic boxes: no grinding — the gearbox controller handles the clutch.
      // Shifts interrupt drive for the box's shift time (DCT ~80 ms, air-shifted drag box ~40 ms).
      // The controller refuses reverse while rolling forward (and vice versa).
      if ((g === -1 && speed > 1.5) || (g > 0 && speed < -1.5)) { this.events.push('denied'); return false; }
      const up = g > this.gear;
      if (this.gear > 0 && g > 0) this.shiftTimer = this.spec.shiftTime ?? 0.1;   // Lenco: 0, no cut at all
      this.gear = g;
      this.events.push(up ? 'shiftUp' : 'shiftDown');
      return true;
    }
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
    // Launch control: BRAKE + GAS at a standstill in 1st arms a 3,500 rpm two-step with the clutch
    // held open automatically; releasing the brake dumps the clutch over ~0.25 s while a slip
    // controller keeps the rears right at peak grip (max bite, minimal wasted wheelspin).
    const still = Math.abs(v) < 1.2;
    if (this.running && this.gear === 1 && still && this.brakeInput > 0.5 && this.throttleInput > 0.5 && !this.handbrake) {
      if (!this.launchArmed) { this.launchArmed = true; this.events.push('launchArmed'); }
    } else if (this.launchArmed) {
      this.launchArmed = false;
      if (this.running && this.gear === 1 && this.brakeInput <= 0.5 && this.throttleInput > 0.5) {
        this.launchTimer = 2.5; this.launchClutch = 0.3; this.launchFactor = 1;
        this.events.push('launch');
      }
    }
    if (this.launchTimer > 0) {
      this.launchTimer -= dt;
      if (this.throttleInput < 0.4 || this.brakeInput > 0.3 || this.gear < 1 || this.gear > 2) this.launchTimer = 0;
      // Closed loop on rear slip: the clutch feeds in only as much torque as the tyres can take
      // (and backs off if the revs sag), the throttle trims any excess
      const err = this.slip - LAUNCH_SLIP;
      if (err > 0) this.launchClutch = Math.max(0.15, this.launchClutch - dt * 8 * Math.min(1, err / 0.2));
      else if (this.rpm > 2600) this.launchClutch = Math.min(1, this.launchClutch + dt * 3.5);
      if (this.rpm < 2200) this.launchClutch = Math.max(0.15, this.launchClutch - dt * 4);
      if (err > 0.05) this.launchFactor = Math.max(0.3, this.launchFactor - dt * 6 * Math.min(1, err / 0.3));
      else this.launchFactor = Math.min(1, this.launchFactor + dt * 2.5);
    } else this.launchFactor = 1;
    const launching = this.launchTimer > 0;

    // Automatic gearbox: shift points move with throttle (short-shifts when cruising, holds to the
    // redline flat out), kick-down when the driver floors it, back to 1st when stopping
    if (this.autoCool > 0) this.autoCool -= dt;
    if (this.autoDrive && this.running && this.gear >= 1 && this.shiftTimer <= 0 && !this.launchArmed && !(this.autoCool > 0)) {
      // Decide on road speed (spinning tyres or an open clutch would fool an rpm reading)
      const roadRpm = (g) => Math.abs(v) / s.wheelRadius * s.gears[g - 1] * s.finalDrive * RAD2RPM;
      const thr = this.throttleInput, red = s.redlineRpm, rpm = roadRpm(this.gear);
      const up = 2300 + (red - 150 - 2300) * Math.pow(thr, 1.4);
      const lowerRpm = this.gear > 1 ? roadRpm(this.gear - 1) : Infinity;
      const wantDown = rpm < 1150 + 1500 * thr || (thr > 0.85 && lowerRpm < red * 0.8);
      if (this.gear < 5 && rpm > up) { this.requestGear(this.gear + 1, v); this.autoCool = 0.8; }
      else if (this.gear > 1 && wantDown && lowerRpm < up - 700) { this.requestGear(this.gear - 1, v); this.autoCool = 0.6; }
    }

    // Turbo spool lags the throttle (blow-off valve vents when you lift on boost)
    if (s.boostCurve) {
      const want = this.running && this.gear !== 0 ? clamp(this.throttleInput * 1.3 - 0.15, 0, 1) : 0;
      const before = this.spool;
      this.spool += (want - this.spool) * Math.min(1, dt / (want > this.spool ? 0.55 : 0.18));
      if (before > 0.55 && this.throttleInput < 0.15 && !this.bovLatch) { this.bovLatch = true; this.events.push('bov'); }
      if (this.throttleInput > 0.5) this.bovLatch = false;
      this.boostPsi = (this.boostPR(this.rpm) - 1) * this.spool * 14.7;
    }

    const lowGearWot = s.powerSlide !== false && this.running && this.gear > 0 && this.gear <= 2 && this.throttleInput > 0.85 && !launching;
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
    const target = this.throttleInput * (launching ? this.launchFactor : this.tcsFactor) * (1 - this.stabilityCut);
    this.throttle += (target - this.throttle) * Math.min(1, dt / 0.045);

    let engage = this.autoClutch ? this.autoEngagement(dt) : this.pedalEngagement();
    // Anti-stall after a hit: slip the clutch automatically so a sudden stop can't kill the engine
    // Stays latched while the revs are still low in gear, so a car left stopped against the wall idles
    // (and can pull away on the slipping clutch) until the driver is moving again.
    if (this.antiStall > 0) {
      this.antiStall -= dt;
      if (this.running && this.gear !== 0) {
        engage = Math.min(engage, clamp((this.rpm - 600) / 450, 0, 1));
        if (this.rpm < 1100) this.antiStall = Math.max(this.antiStall, 0.5);
      }
    }
    if (this.launchArmed) engage = 0;
    else if (launching) engage = this.launchClutch;
    // Hand brake: the clutch opens automatically so locking the rears never stalls the engine
    if (this.handbrake && this.gear !== 0) { engage = 0; this.antiStall = Math.max(this.antiStall, 1); }
    this.clutchEngage = engage;
    const Tcap = s.clutchMaxTorque * Math.pow(engage, 1.4);
    const G = this.ratio();
    // Service brakes on the driven axle (the vehicle brakes the other one); the hand brake works on
    // this axle only when it is the rear one (RWD) — on AWD it just opens the clutch
    const brakeShare = s.drive === 'AWD' ? 1 : s.drive === 'FWD' ? s.brakeBiasFront : 1 - s.brakeBiasFront;
    const brakeT = this.brakeInput * s.maxBrakeForce * brakeShare * r + this.handbrake * s.handbrakeTorque * (s.drive && s.drive !== 'RWD' ? 0 : 1);

    // The torque kick breaks the rears loose; once they're spinning, full grip returns so the
    // spinning tyres still drive the car forward through the slide
    const muDrive = mu * (1 - 0.3 * this.powerSlide * clamp(1 - Math.abs(this.slip) / 0.35, 0, 1));
    // Nitrous: a big wet shot, ~+55 % torque (≈ +380 hp at the peak), only with the engine lit
    this.nitrousAmt += ((this.running ? this.nitrous : 0) - this.nitrousAmt) * Math.min(1, dt / 0.08);
    const nosMul = 1 + 0.55 * this.nitrousAmt;
    const h = dt / SUBSTEPS;
    let Fsum = 0, loadSum = 0, slipSum = 0, Tsum = 0;
    let slipping = false, engStress = 0, comb = 0, demand = 0;

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
        if (this.launchArmed) thr = clamp((LAUNCH_RPM - rpm) / 300, 0, 1);   // two-step
        if (this.sequential && this.shiftTimer > 0) thr = 0;                    // ignition cut mid-shift
        // Turbo lag: only the spooled fraction of the steady-state boost is available
        let lag = 1;
        if (s.boostCurve) {
          const pr = this.boostPR(rpm);
          // Anti-lag (race tiers): on the two-step and through the launch the turbos are kept lit,
          // so full boost is there the moment the clutch bites
          const al = s.antiLag && (this.launchArmed || launching) ? s.antiLag : 0;
          const prA = Math.max(pr, 1 + (this.boostPR(s.redlineRpm * 0.85) - 1) * al);
          lag = Math.pow((1 + (prA - 1) * Math.max(this.spool, al)) / pr, 0.85);
        }
        comb = this.fullTorque(rpm) * lag * thr;
        // What the driver's foot asks for (before traction control and the limiter trim it)
        demand = this.launchArmed ? 0 : this.fullTorque(rpm) * lag * this.throttleInput;
        Te = comb * nosMul - this.friction(rpm) * (1 - thr);
        load = thr;
        // Cylinder pressure past what the block is built for: damage builds fast and the
        // engine lets go (the nitrous kit comes with its own fuel and timing: not counted)
        if (s.blockTorque) {
          const r = comb / s.blockTorque;
          engStress = Math.max(engStress, r);
          if (r > 1) this.engineDamage += h * (r - 1) * 2.5;
        }
        // Detonation: far more boost than the fuel and compression can take — the ECU can pull
        // timing only so far before the pistons start to melt
        if (s.detonation) this.engineDamage += h * s.detonation * 0.3 * thr * (s.boostCurve ? this.spool : 1);
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
        let Tbox;
        if (Math.abs(Tc) <= Tcap) {
          locked = true;
          this.wheelW = w1;
          this.engineW = w1 * G;
          Tbox = Math.abs(Tc);
        } else {
          slipping = true;
          const slipDir = Math.sign(this.engineW - this.wheelW * G) || Math.sign(Tc);
          const Tcl = slipDir * Tcap;
          this.engineW += h * (Te - Tcl) / Ie;
          this.wheelW += h * (Tcl * G * eff - r * tyre.F) / (Iw + h * r * tyre.D);
          Tbox = Tcap;
        }
        // Torque through the gearbox (40 ms average, so a single-step spike doesn't count):
        // past its rating the gears are damaged, far past it they shear outright
        // The engine's full torque slams through the gears as the clutch bites, whether or not the
        // tyres can use it (a clutch grabs long before it is fully home): that launch shock is what
        // breaks a street box behind a huge engine
        Tbox = Math.max(Tbox, demand * nosMul * Math.min(1, engage * 3));
        this.transLoad += (Tbox - this.transLoad) * Math.min(1, h / 0.04);
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

      if (G === 0 || Tcap < 1) this.transLoad *= Math.max(0, 1 - h / 0.04);
      if (s.transRating && !this.transBroken) {
        const tr = this.transLoad / s.transRating;
        if (tr > 1) this.transDamage += h * (tr - 1) * 5;
        if (this.transDamage >= 1 || tr > 1.5) {
          this.transBroken = true;
          this.transLoad = 0;
          this.events.push('transBroken');
        }
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

    // Engine limits: block strength, time on the limiter, mechanical over-rev (a missed shift)
    if (this.running) {
      const rpmNow = this.rpm;
      // Heat builds only while bouncing off the rev limiter (or beyond it)
      // (not in top gear: running out of revs at top speed is the car's speed limit, not abuse)
      if ((this.cutAmount > 0.2 || rpmNow > s.limiterRpm) && this.gear !== 5) this.heat += dt;
      else this.heat = Math.max(0, this.heat - dt);
      if (this.engineDamage >= 1) this.blow('pressure');
      else if (s.limiterHeat && this.heat > s.limiterHeat) this.blow('heat');
      else if (rpmNow > s.limiterRpm * 1.25) this.blow('overrev');
    }
    const st = this.stress;
    st.engine = Math.max(engStress, st.engine - dt * 1.5);
    st.heat = s.limiterHeat ? this.heat / s.limiterHeat : 0;
    st.trans = s.transRating ? this.transLoad / s.transRating : 0;

    this.clutchSlipping = slipping;
    this.force = Fsum / SUBSTEPS;
    this.slip = slipSum / SUBSTEPS;
    this.load = loadSum / SUBSTEPS;
    this.engineTorque = Tsum / SUBSTEPS;
    return this.force;
  }
}

export { RAD2RPM, RPM2RAD };
