// Web Audio graph: V8 worklet + blower whine + intake + tyres + wind + one-shots.
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// iPhone / iPad (iPadOS reports itself as a Mac with touch)
export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  /[?&]ios=1/.test(location.search);   // force the iOS audio path for testing

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 1;
    this.interior = false;
    // iOS Safari never prunes finished automation events, so the per-frame setTargetAtTime calls
    // build an ever-growing timeline until WebKit's audio thread overruns and the sound dies.
    // On iOS the same smoothing runs in JS and values are written directly (no events at all).
    this.directParams = IS_IOS;
    this.smooth = new Map();
    this.frameDt = 1 / 60;
    this.lastT = 0;
    this.wantRunning = false;
    this.lastImpact = 0;
    this.lastImpactS = 0;
    this.watch = { ctxT: 0, wall: 0, stuck: false };
  }

  /** Smoothly move an AudioParam toward v with time constant tc (s). */
  ramp(param, v, tc) {
    if (!this.directParams) { param.setTargetAtTime(v, this.ctx.currentTime, tc); return; }
    let st = this.smooth.get(param);
    if (!st) { st = { v: typeof param.value === 'number' ? param.value : 0 }; this.smooth.set(param, st); }
    st.v += (v - st.v) * (tc <= 0.002 ? 1 : 1 - Math.exp(-this.frameDt / tc));
    if (Math.abs(st.v - st.last) > 1e-5 || st.last === undefined) { param.value = st.v; st.last = st.v; }
  }

  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS 17+ only */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: IS_IOS ? 'playback' : 'interactive' });
    this.ctx = ctx;
    this.smooth = new Map();
    this.wantRunning = true;
    // iOS suspends/"interrupts" the context (calls, Siri, other apps, screen lock): resume it
    ctx.onstatechange = () => { if (this.wantRunning && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); };
    if (!this._gestureHook) {
      this._gestureHook = true;
      const kick = () => {
        if (!this.ctx || !this.wantRunning) return;
        if (this.watch.stuck) { this.restart(); return; }
        if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      };
      document.addEventListener('touchend', kick, { passive: true });
      document.addEventListener('pointerup', kick, { passive: true });
    }
    // Unlock on iOS: play a silent buffer inside the user gesture
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
    if (ctx.state !== 'running') await ctx.resume();

    // ---- Master chain
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.18;
    this.master.connect(comp).connect(ctx.destination);

    // ---- Engine bus: tone shaping for that chest-thumping Hemi
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 1.0;
    // Low shelf for real speakers/headphones, then a "throat" lift in the 150–350 Hz band
    // that phone speakers can actually reproduce, and a softened top end (rumble, not rasp)
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 120; lowShelf.gain.value = 6;
    const throat = ctx.createBiquadFilter();
    throat.type = 'peaking'; throat.frequency.value = 190; throat.Q.value = 0.8; throat.gain.value = 5;
    const chest = ctx.createBiquadFilter();
    chest.type = 'peaking'; chest.frequency.value = 330; chest.Q.value = 1.0; chest.gain.value = 2.5;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 1200; presence.Q.value = 1.2; presence.gain.value = 1;
    const deRasp = ctx.createBiquadFilter();
    deRasp.type = 'highshelf'; deRasp.frequency.value = 3500; deRasp.gain.value = -4;
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass'; this.cabin.frequency.value = 14000; this.cabin.Q.value = 0.5;
    this.engineBus.connect(lowShelf).connect(throat).connect(chest).connect(presence).connect(deRasp).connect(this.cabin).connect(this.master);

    await this.createEngineNode();

    // ---- Shared noise source
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      s.loopStart = Math.random(); s.start(0, Math.random() * 1.9);
      return s;
    };

    // Intake roar (through the blower scoop)
    this.intakeF = ctx.createBiquadFilter();
    this.intakeF.type = 'bandpass'; this.intakeF.Q.value = 1.4; this.intakeF.frequency.value = 400;
    this.intakeG = ctx.createGain(); this.intakeG.gain.value = 0;
    noise().connect(this.intakeF).connect(this.intakeG).connect(this.engineBus);

    // Supercharger whine (6-71 Roots blower, 3-lobe rotors, overdriven)
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine2 = ctx.createOscillator();
    this.whine2.type = 'sine';
    this.whineF = ctx.createBiquadFilter();
    this.whineF.type = 'bandpass'; this.whineF.Q.value = 3;
    this.whineG = ctx.createGain(); this.whineG.gain.value = 0;
    this.whine.connect(this.whineF);
    this.whine2.connect(this.whineF);
    this.whineF.connect(this.whineG).connect(this.cabin);
    this.whine.start(); this.whine2.start();

    // Tyre squeal: two procedural voices on one bus, mixed with the V8 through the shared master
    // compressor so the two glue together:
    //  - cornering squeal: a tonal stick-slip "scream" (two detuned oscillators with jittery vibrato
    //    through a resonant band) plus a noisy band. Pitch rises with slip angle.
    //  - wheelspin howl: lower, rougher noise band whose pitch follows the tyre's spin speed over
    //    the road, amplitude-modulated by a fast flutter.
    this.tyreBus = ctx.createGain(); this.tyreBus.gain.value = 1;
    const tyreLP = ctx.createBiquadFilter(); tyreLP.type = 'lowpass'; tyreLP.frequency.value = 6500;
    this.tyreBus.connect(tyreLP).connect(this.master);
    // cornering voice
    this.sqOscA = ctx.createOscillator(); this.sqOscA.type = 'sawtooth';
    this.sqOscB = ctx.createOscillator(); this.sqOscB.type = 'triangle';
    this.sqVib = ctx.createOscillator(); this.sqVib.frequency.value = 11;
    this.sqVibG = ctx.createGain(); this.sqVibG.gain.value = 18;
    this.sqVib.connect(this.sqVibG); this.sqVibG.connect(this.sqOscA.frequency); this.sqVibG.connect(this.sqOscB.frequency);
    this.sqF = ctx.createBiquadFilter(); this.sqF.type = 'bandpass'; this.sqF.Q.value = 6;
    this.sqToneG = ctx.createGain(); this.sqToneG.gain.value = 0;
    this.sqOscA.connect(this.sqF); this.sqOscB.connect(this.sqF);
    this.sqF.connect(this.sqToneG).connect(this.tyreBus);
    this.sqNF = ctx.createBiquadFilter(); this.sqNF.type = 'bandpass'; this.sqNF.Q.value = 9;
    this.sqNoiseG = ctx.createGain(); this.sqNoiseG.gain.value = 0;
    noise().connect(this.sqNF).connect(this.sqNoiseG).connect(this.tyreBus);
    this.sqOscA.start(); this.sqOscB.start(); this.sqVib.start();
    // wheelspin voice
    this.spF = ctx.createBiquadFilter(); this.spF.type = 'bandpass'; this.spF.Q.value = 3.5;
    this.spAM = ctx.createGain(); this.spAM.gain.value = 0.6;
    this.spFl = ctx.createOscillator(); this.spFl.type = 'square'; this.spFl.frequency.value = 23;
    this.spFlG = ctx.createGain(); this.spFlG.gain.value = 0.35;
    this.spFl.connect(this.spFlG).connect(this.spAM.gain); this.spFl.start();
    this.spG = ctx.createGain(); this.spG.gain.value = 0;
    noise().connect(this.spF).connect(this.spAM).connect(this.spG).connect(this.tyreBus);

    // Gravel / grass rumble
    this.offF = ctx.createBiquadFilter(); this.offF.type = 'lowpass'; this.offF.frequency.value = 380;
    this.offG = ctx.createGain(); this.offG.gain.value = 0;
    noise().connect(this.offF).connect(this.offG).connect(this.master);

    // Wind
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'lowpass'; this.windF.frequency.value = 400;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    noise().connect(this.windF).connect(this.windG).connect(this.master);

    // Nitrous: high-pressure hiss through the solenoids and nozzles
    this.nosF = ctx.createBiquadFilter(); this.nosF.type = 'highpass'; this.nosF.frequency.value = 2400;
    this.nosG = ctx.createGain(); this.nosG.gain.value = 0;
    noise().connect(this.nosF).connect(this.nosG).connect(this.master);

    // Transmission whine (straight-cut-ish gear noise)
    this.gearOsc = ctx.createOscillator(); this.gearOsc.type = 'sine';
    this.gearG = ctx.createGain(); this.gearG.gain.value = 0;
    this.gearOsc.connect(this.gearG).connect(this.cabin);
    this.gearOsc.start();

    this.ready = true;
  }

  async createEngineNode() {
    const ctx = this.ctx;
    const url = new URL('./engine-worklet.js', import.meta.url).href;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      await ctx.audioWorklet.addModule(url);
      this.engine = new AudioWorkletNode(ctx, 'v8-hemi', { numberOfInputs: 0, outputChannelCount: [2] });
      this.p = {
        rpm: this.engine.parameters.get('rpm'),
        load: this.engine.parameters.get('load'),
        running: this.engine.parameters.get('running'),
        cut: this.engine.parameters.get('cut'),
        gain: this.engine.parameters.get('gain'),
      };
      this.engine.connect(this.engineBus);
    } catch (err) {
      // Fallback: run the same DSP in a ScriptProcessor
      const code = await (await fetch(url)).text();
      let Proc = null;
      class AWP { constructor() { this.port = { postMessage() {}, onmessage: null }; } }
      new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', code)(AWP, (n, c) => { Proc = c; }, ctx.sampleRate);
      const proc = new Proc();
      const vals = { rpm: [0], load: [0], running: [0], cut: [0], gain: [1] };
      const sp = ctx.createScriptProcessor(1024, 0, 2);
      sp.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        for (let o = 0; o < L.length; o += 128) {
          proc.process([], [[L.subarray(o, o + 128), R.subarray(o, o + 128)]], vals);
        }
      };
      const mk = (k) => ({ setTargetAtTime: (v) => { vals[k][0] = v; }, set value(v) { vals[k][0] = v; } });
      this.p = { rpm: mk('rpm'), load: mk('load'), running: mk('running'), cut: mk('cut'), gain: mk('gain') };
      sp.connect(this.engineBus);
      this.engine = sp;
    }
  }

  setInterior(on) {
    // Called every frame by the camera: only touch the filter when the view actually changes
    if (on === this.interior && this._interiorSet) return;
    this.interior = on;
    if (!this.ready) return;
    this._interiorSet = true;
    if (this.directParams) this.cabin.frequency.value = on ? 2600 : 14000;
    else this.cabin.frequency.setTargetAtTime(on ? 2600 : 14000, this.ctx.currentTime, 0.1);
  }

  /** Tear down a dead context and rebuild the whole graph (must run inside a user gesture on iOS). */
  async restart() {
    const old = this.ctx;
    this.watch.stuck = false;
    this.ready = false;
    this.ctx = null;
    this._interiorSet = false;
    try { old && old.close(); } catch (e) { /* already gone */ }
    try { await this.init(); this.setInterior(this.interior); } catch (e) { console.warn('audio restart failed', e); }
  }

  setVolume(v) {
    this.volume = v;
    if (!this.master) return;
    if (this.directParams) this.master.gain.value = v;
    else this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend() { this.wantRunning = false; if (this.ctx) this.ctx.suspend().catch(() => {}); }
  resume() {
    this.wantRunning = true;
    this.watch.wall = performance.now();
    if (!this.ctx) return;
    if (this.watch.stuck) { this.restart(); return; }
    this.ctx.resume().catch(() => {});
  }

  /** Called every frame with telemetry from the car. */
  update(s) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, tc = 0.025;
    this.frameDt = clamp(t - this.lastT, 0.001, 0.1);
    this.lastT = t;
    // Watchdog: if the context claims to run but its clock has frozen for 2 s, the audio thread
    // has died (an iOS failure mode); rebuild it on the next tap
    const now = performance.now();
    if (t !== this.watch.ctxT || this.ctx.state !== 'running' || !this.wantRunning) { this.watch.ctxT = t; this.watch.wall = now; }
    else if (now - this.watch.wall > 2000) this.watch.stuck = true;
    const rpm = s.rpm, load = s.load;
    this.ramp(this.p.rpm, rpm, 0.012);
    this.ramp(this.p.load, load, 0.03);
    this.ramp(this.p.running, s.running ? 1 : 0, 0.001);
    this.ramp(this.p.cut, s.cut ? 1 : 0, 0.001);
    const nos = s.nitrous || 0;
    this.ramp(this.p.gain, s.running ? 1 + nos * 0.3 : 0.0, s.running ? 0.01 : 0.12);
    this.ramp(this.nosG.gain, nos * 0.09, 0.03);

    const crankHz = rpm / 60;
    const thr = s.throttle;
    this.ramp(this.intakeF.frequency, 250 + rpm * 0.16, tc);
    this.ramp(this.intakeG.gain, s.running ? (0.015 + thr * 0.12) * clamp(rpm / 6000, 0.2, 1.2) : 0, 0.04);

    const blowerHz = crankHz * 1.15 * 6;
    this.ramp(this.whine.frequency, Math.max(20, blowerHz), tc);
    this.ramp(this.whine2.frequency, Math.max(20, blowerHz * 2.01), tc);
    this.ramp(this.whineF.frequency, Math.max(60, blowerHz * 1.3), tc);
    const boost = s.running ? (0.012 + load * 0.05) * Math.pow(clamp(rpm / 6500, 0, 1.1), 1.6) : 0;
    this.ramp(this.whineG.gain, boost, 0.05);

    // Tyres (silent on grass, where the rumble layer takes over)
    const onGrass = s.offroad ? 1 : 0;
    const sp = Math.abs(s.speed);
    const ang = s.slideAngle || 0;
    // Cornering squeal: starts around 3° of slip, full by ~18°; pitch 650 → 1500 Hz with angle,
    // with a slow random wander so a long drift never sounds like a held note
    const corner = onGrass ? 0 : clamp((ang - 3) / 15, 0, 1) * clamp(sp / 8, 0, 1);
    const wander = Math.sin(t * 2.3) * 40 + Math.sin(t * 5.9) * 22;
    const pitch = 650 + Math.min(ang, 40) * 22 + wander;
    this.ramp(this.sqOscA.frequency, pitch, 0.06);
    this.ramp(this.sqOscB.frequency, pitch * 1.503, 0.06);
    this.ramp(this.sqF.frequency, pitch * 1.15, 0.06);
    this.ramp(this.sqNF.frequency, pitch * 1.9, 0.06);
    this.ramp(this.sqVib.frequency, 9 + corner * 6, 0.1);
    this.ramp(this.sqToneG.gain, Math.pow(corner, 1.4) * 0.06, 0.05);
    this.ramp(this.sqNoiseG.gain, Math.pow(corner, 1.2) * 0.22, 0.05);
    // Wheelspin / lock-up howl: driven by how fast the tyre surface rubs over the road (m/s)
    const rub = s.slipSpeed || 0;
    const spin = onGrass ? 0 : clamp((rub - 1.5) / 9, 0, 1);
    this.ramp(this.spF.frequency, 420 + Math.min(rub, 40) * 26, 0.05);
    this.ramp(this.spFl.frequency, 16 + Math.min(rub, 40) * 0.6, 0.1);
    this.ramp(this.spG.gain, Math.pow(spin, 1.2) * 0.3, 0.05);
    this.ramp(this.offG.gain, onGrass * clamp(sp / 25, 0, 1) * 0.35, 0.06);
    this.ramp(this.windF.frequency, 300 + sp * 14, 0.1);
    this.ramp(this.windG.gain, Math.min(0.22, (sp / 80) ** 2 * 0.22), 0.1);

    // Gearbox whine follows output-shaft speed in low gears
    const shaftHz = Math.abs(s.shaftRpm) / 60 * 17;
    this.ramp(this.gearOsc.frequency, Math.max(20, shaftHz), tc);
    const gw = s.gear !== 0 && s.running ? (s.gear === -1 ? 0.05 : 0.012 * (6 - Math.abs(s.gear)) / 5) * clamp(load + 0.2, 0, 1) : 0;
    this.ramp(this.gearG.gain, gw, 0.05);
  }

  // ---------------- One-shots ----------------
  // Every one-shot disconnects its whole chain when its source ends, so nothing piles up in the
  // graph (iOS keeps finished-but-connected nodes alive far longer than Chrome does).
  static cleanup(src, nodes) {
    src.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already */ } } };
  }

  burst(dur, { type = 'lowpass', freq = 800, q = 1, gain = 0.5, attack = 0.002, dest = null, rate = 1 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
    AudioEngine.cleanup(src, [src, f, g]);
    return { f, g, src };
  }

  shift(up) {
    if (!this.ready) return;
    // Hurst-style mechanical clunk: thud + metallic click
    this.burst(0.09, { freq: 220, gain: 0.55, q: 2 });
    this.burst(0.05, { type: 'bandpass', freq: up ? 2400 : 2000, q: 6, gain: 0.25 });
  }

  grind() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 95;
    const am = ctx.createOscillator(); am.type = 'square'; am.frequency.value = 38;
    const amG = ctx.createGain(); amG.gain.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    am.connect(amG).connect(g.gain);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 2;
    o.connect(f).connect(g).connect(this.master);
    o.start(t); am.start(t); o.stop(t + 0.5); am.stop(t + 0.5);
    AudioEngine.cleanup(o, [o, am, amG, g, f]);
    this.burst(0.45, { type: 'bandpass', freq: 3200, q: 3, gain: 0.3, rate: 0.7 });
  }

  starter(dur = 0.75) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    // Starter motor whirr + compression pulses ("rr-rr-rr")
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t); o.frequency.linearRampToValueAtTime(210, t + dur);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const g = ctx.createGain(); g.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.setValueAtTime(10, t); lfo.frequency.linearRampToValueAtTime(15, t + dur);
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.09;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t); env.gain.exponentialRampToValueAtTime(1, t + 0.04);
    env.gain.setValueAtTime(1, t + dur - 0.05); env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    g.gain.value = 0.11;
    lfo.connect(lfoG).connect(g.gain);
    o.connect(f).connect(g).connect(env).connect(this.master);
    o.start(t); lfo.start(t); o.stop(t + dur + 0.1); lfo.stop(t + dur + 0.1);
    AudioEngine.cleanup(o, [o, lfo, lfoG, f, g, env]);
  }

  ignition() {
    // The catch: a big bark as the Hemi lights
    this.burst(0.35, { freq: 260, gain: 0.8, q: 1.5, attack: 0.01 });
  }

  stall() {
    this.burst(0.25, { freq: 160, gain: 0.5, q: 2 });
    setTimeout(() => this.burst(0.2, { freq: 120, gain: 0.3, q: 2 }), 120);
  }

  impact(strength) {
    // Scraping along a wall reports a contact every physics step (120/s): play at most ~7 hits a
    // second, and let a much harder hit through early
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this.lastImpact < 0.14 && strength < this.lastImpactS * 1.8) return;
    this.lastImpact = now; this.lastImpactS = strength;
    const s = clamp(strength, 0, 1);
    this.burst(0.25 + s * 0.3, { freq: 380 + s * 400, gain: 0.25 + s * 0.6, q: 0.8 });
    this.burst(0.5, { type: 'bandpass', freq: 1700, q: 8, gain: 0.08 + s * 0.2 });
  }
}
