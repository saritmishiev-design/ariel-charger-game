// Touch pedals, H-pattern shifter, tilt steering (DeviceOrientation), touch wheel & keyboard.
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// Shifter slots: [column, row(-1 top / +1 bottom)] → gear
const SLOTS = [
  { gear: 1, col: 0, row: -1 }, { gear: 2, col: 0, row: 1 },
  { gear: 3, col: 1, row: -1 }, { gear: 4, col: 1, row: 1 },
  { gear: 5, col: 2, row: -1 }, { gear: -1, col: 2, row: 1 },
];

export class Controls {
  constructor({ onGear, onIgnition, haptic }) {
    this.onGear = onGear;
    this.onIgnition = onIgnition;
    this.haptic = haptic || (() => {});
    this.pedals = { gas: 0, brake: 0, clutch: 0 };
    this.keys = new Set();
    this.steerMode = 'tilt';
    this.tiltRange = 40;          // degrees of phone rotation for full lock
    this.tiltDeadzone = 5;        // ±5° around centre does nothing (kills hand tremor and bumps)
    this.tiltCenter = 0;
    this.tiltRaw = 0;
    this.tiltSmooth = 0;          // filtered steering output, -1..1
    this.tiltSeen = false;
    this.touchSteer = 0;
    this.keySteer = 0;
    this.enabled = true;

    this.bindPedal('gas');
    this.bindPedal('brake');
    this.bindPedal('clutch');
    this.bindShifter();
    this.bindWheel();
    this.bindKeyboard();
    window.addEventListener('deviceorientation', (e) => this.onOrientation(e));
  }

  // ---------------- Tilt ----------------
  static async requestTiltPermission() {
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const r = await DOE.requestPermission();
        return r === 'granted';
      }
      return !!DOE;
    } catch (e) { return false; }
  }

  onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    const d2r = Math.PI / 180;
    const b = e.beta * d2r, g = e.gamma * d2r;
    // Earth "up" expressed in device coordinates (W3C Z-X'-Y'' Euler angles)
    const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b);
    const ang = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * d2r;
    // Rotate into screen coordinates
    const sx = ux * Math.cos(ang) - uy * Math.sin(ang);
    const sy = ux * Math.sin(ang) + uy * Math.cos(ang);
    if (Math.hypot(sx, sy) < 0.15) return;   // phone lying flat: keep last value
    // Angle of "up" within the screen plane: rotating the phone clockwise (steer right) → negative
    this.tiltRaw = Math.atan2(sx, sy) / d2r;
    this.tiltSeen = true;
  }

  calibrate() { this.tiltCenter = this.tiltRaw; this.tiltSmooth = 0; }

  // ---------------- Pedals ----------------
  bindPedal(name) {
    const el = document.getElementById(`pedal-${name}`);
    const fill = el.querySelector('.fill');
    const ptrs = new Map();
    const valueFor = (ev) => {
      const r = el.getBoundingClientRect();
      const rel = clamp((ev.clientY - r.top) / r.height, 0, 1);
      // Upper part of the pedal feathers it, the lower 35 % is flat-out
      return clamp(0.3 + 0.7 * rel / 0.65, 0.3, 1);
    };
    const update = () => {
      let v = 0;
      for (const x of ptrs.values()) v = Math.max(v, x);
      this.pedals[name] = v;
      fill.style.transform = `scaleY(${v})`;
      el.classList.toggle('down', v > 0);
    };
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      ptrs.set(ev.pointerId, valueFor(ev));
      if (name === 'clutch') this.haptic(8);
      update();
    });
    el.addEventListener('pointermove', (ev) => {
      if (!ptrs.has(ev.pointerId)) return;
      ptrs.set(ev.pointerId, valueFor(ev));
      update();
    });
    const end = (ev) => { ptrs.delete(ev.pointerId); update(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  // ---------------- Shifter ----------------
  bindShifter() {
    const el = document.getElementById('shifter');
    const knob = document.getElementById('knob');
    this.shifterEl = el;
    this.knobEl = knob;
    const st = { mode: 'neutral', col: 1, x: 0.5, y: 0.5, ptr: null, dragOff: [0, 0] };
    this.shift = st;
    const colX = (c) => (c * 2 + 1) / 6;
    const TOP = 0.16, BOT = 0.84, MID = 0.5;

    const render = () => {
      knob.style.left = `${st.x * 100}%`;
      knob.style.top = `${st.y * 100}%`;
    };
    this.renderKnob = render;

    const slotAt = () => {
      if (st.mode !== 'column') return 0;
      if (st.y <= TOP + 0.1) return SLOTS.find(s => s.col === st.col && s.row === -1).gear;
      if (st.y >= BOT - 0.1) return SLOTS.find(s => s.col === st.col && s.row === 1).gear;
      return 0;
    };

    const applyGear = () => {
      const g = slotAt();
      if (g === this.currentGear) return;
      const ok = this.onGear(g);
      if (ok) {
        this.currentGear = g;
        if (g !== 0) this.haptic(18);
      } else {
        // Grind: knob kicked back out of the gate
        st.y = g === -1 || SLOTS.find(s => s.gear === g).row === 1 ? MID + 0.12 : MID - 0.12;
        el.classList.remove('grind'); void el.offsetWidth; el.classList.add('grind');
        this.haptic([30, 20, 30, 20, 30]);
        if (this.currentGear !== 0) { this.onGear(0); this.currentGear = 0; }
        st.ptr = null;
      }
      render();
    };

    const move = (nx, ny) => {
      if (st.mode === 'neutral') {
        st.x = clamp(nx, colX(0), colX(2));
        st.y = MID;
        let best = 0, bd = 9;
        for (let c = 0; c < 3; c++) { const d = Math.abs(st.x - colX(c)); if (d < bd) { bd = d; best = c; } }
        if (Math.abs(ny - MID) > 0.1 && bd < 0.14) {
          st.mode = 'column'; st.col = best; st.x = colX(best);
        }
      }
      if (st.mode === 'column') {
        st.x = colX(st.col);
        st.y = clamp(ny, TOP, BOT);
        if (Math.abs(st.y - MID) < 0.06 && Math.abs(nx - colX(st.col)) > 0.09) {
          st.mode = 'neutral'; st.y = MID; st.x = clamp(nx, colX(0), colX(2));
        }
      }
      render();
      applyGear();
    };
    this.moveKnob = move;

    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const nx = (ev.clientX - r.left) / r.width, ny = (ev.clientY - r.top) / r.height;
      const kd = Math.hypot((nx - st.x) * r.width, (ny - st.y) * r.height);
      el.setPointerCapture(ev.pointerId);
      st.ptr = ev.pointerId;
      if (kd > 42) {
        // Tap-to-shift: jump through neutral straight into the touched slot
        const slot = SLOTS.reduce((a, s) => {
          const d = Math.hypot(nx - colX(s.col), ny - (s.row < 0 ? TOP : BOT));
          return d < a.d ? { s, d } : a;
        }, { s: null, d: 9 });
        if (slot.d < 0.22) {
          st.mode = 'neutral'; st.y = MID;
          if (this.currentGear !== 0) { this.onGear(0); this.currentGear = 0; }
          move(colX(slot.s.col), MID);
          move(colX(slot.s.col), slot.s.row < 0 ? TOP : BOT);
          st.dragOff = [0, 0];
          return;
        }
        if (Math.abs(ny - MID) < 0.15) { st.mode = 'neutral'; move(nx, MID); }
      }
      st.dragOff = [st.x - nx, st.y - ny];
    });
    el.addEventListener('pointermove', (ev) => {
      if (st.ptr !== ev.pointerId) return;
      const r = el.getBoundingClientRect();
      move((ev.clientX - r.left) / r.width + st.dragOff[0], (ev.clientY - r.top) / r.height + st.dragOff[1]);
    });
    const end = (ev) => {
      if (st.ptr !== ev.pointerId) return;
      st.ptr = null;
      if (st.mode === 'column' && slotAt() === 0) { st.y = MID; render(); }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    this.currentGear = 0;
    render();
  }

  /** Programmatic shift (keyboard): positions the knob too. */
  selectGear(g) {
    const st = this.shift;
    const colX = (c) => (c * 2 + 1) / 6;
    if (this.currentGear !== 0) { this.onGear(0); this.currentGear = 0; }
    st.mode = 'neutral'; st.y = 0.5;
    if (g === 0) { this.renderKnob(); return; }
    const s = SLOTS.find(x => x.gear === g);
    this.moveKnob(colX(s.col), 0.5);
    this.moveKnob(colX(s.col), s.row < 0 ? 0.16 : 0.84);
  }

  /** Force knob to neutral (e.g. after reset). */
  forceNeutral() {
    this.shift.mode = 'neutral'; this.shift.y = 0.5; this.shift.x = 0.5;
    this.currentGear = 0;
    this.renderKnob();
  }

  // ---------------- Touch wheel ----------------
  bindWheel() {
    const el = document.getElementById('touchwheel');
    const thumb = el.querySelector('.thumb');
    let ptr = null, x0 = 0;
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); el.setPointerCapture(ev.pointerId); ptr = ev.pointerId;
      const r = el.getBoundingClientRect();
      x0 = r.left + r.width / 2;
      this.touchSteer = -clamp((ev.clientX - x0) / (r.width / 2), -1, 1);
    });
    el.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== ptr) return;
      const r = el.getBoundingClientRect();
      this.touchSteer = -clamp((ev.clientX - x0) / (r.width / 2), -1, 1);
    });
    const end = (ev) => { if (ev.pointerId === ptr) { ptr = null; this.touchSteer = 0; } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    this.wheelThumb = thumb;
  }

  // ---------------- Keyboard (desktop testing) ----------------
  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if ('12345'.includes(k) && k.length === 1) this.selectGear(+k);
      else if (k === 'r') this.selectGear(-1);
      else if (k === 'n' || k === '0') this.selectGear(0);
      else if (k === 'i' || k === 'enter') this.onIgnition();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  clutchNow() {
    const kc = this.keys.has(' ') || this.keys.has('shift') ? 1 : 0;
    return this.enabled ? Math.max(this.pedals.clutch, kc) : 0;
  }

  /** Sample all inputs for this frame. */
  read(dt) {
    const k = this.keys;
    const kGas = k.has('arrowup') || k.has('w') ? 1 : 0;
    const kBrake = k.has('arrowdown') || k.has('s') ? 1 : 0;
    const kClutch = k.has(' ') || k.has('shift') ? 1 : 0;
    const kl = k.has('arrowleft') || k.has('a'), kr = k.has('arrowright') || k.has('d');
    const kt = (kl ? 1 : 0) - (kr ? 1 : 0);
    this.keySteer += clamp(kt - this.keySteer, -dt * 4, dt * 4);
    if (!kl && !kr) this.keySteer *= Math.max(0, 1 - dt * 8);

    let steer = 0;
    if (this.steerMode === 'tilt' && this.tiltSeen) {
      let a = this.tiltRaw - this.tiltCenter;
      if (a > 180) a -= 360; if (a < -180) a += 360;
      // Wide deadzone, then rescale so steering still starts from zero at its edge
      const dz = this.tiltDeadzone;
      const mag = Math.max(0, Math.abs(a) - dz) / Math.max(1, this.tiltRange - dz);
      // Progressive curve: soft just past the deadzone, then builds steadily, so a comfortable
      // 20-30° tilt gives the 35-65 % a tight corner needs (speed-capped lock in vehicle.js keeps
      // the same tilt safe at high speed)
      const target = Math.sign(a) * Math.pow(Math.min(1, mag), 1.25);
      // Smoothing (≈0.2 s low-pass) and a turn-in rate of ~0.8 s to full lock; unwinding is faster
      const k = 1 - Math.exp(-dt / 0.2);
      const unwinding = Math.abs(target) < Math.abs(this.tiltSmooth) || Math.sign(target) !== Math.sign(this.tiltSmooth);
      const rate = (unwinding ? 2.2 : 1.3) * dt;
      this.tiltSmooth += clamp((target - this.tiltSmooth) * k, -rate, rate);
      steer = this.tiltSmooth;
    } else if (this.steerMode === 'touch') {
      steer = this.touchSteer;
    }
    if (Math.abs(this.keySteer) > 0.01) steer = this.keySteer;
    if (this.wheelThumb) this.wheelThumb.style.transform = `translateX(${-this.touchSteer * 100}%)`;

    return {
      throttle: this.enabled ? Math.max(this.pedals.gas, kGas) : 0,
      brake: this.enabled ? Math.max(this.pedals.brake, kBrake) : 0,
      clutch: this.enabled ? Math.max(this.pedals.clutch, kClutch) : 0,
      steer: this.enabled ? steer : 0,
    };
  }
}
