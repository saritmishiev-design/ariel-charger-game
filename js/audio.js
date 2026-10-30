// Web Audio graph: V8 worklet + blower whine + intake + tyres + wind + one-shots.
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 1;
    this.interior = false;
  }

  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS 17+ only */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
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
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 140; lowShelf.gain.value = 7;
    const chest = ctx.createBiquadFilter();
    chest.type = 'peaking'; chest.frequency.value = 260; chest.Q.value = 0.9; chest.gain.value = 4;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 1400; presence.Q.value = 1.2; presence.gain.value = 2.5;
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass'; this.cabin.frequency.value = 14000; this.cabin.Q.value = 0.5;
    this.engineBus.connect(lowShelf).connect(chest).connect(presence).connect(this.cabin).connect(this.master);

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

    // Tyre squeal: two resonant bands + slow wobble
    this.tyreG = ctx.createGain(); this.tyreG.gain.value = 0;
    const tA = ctx.createBiquadFilter(); tA.type = 'bandpass'; tA.frequency.value = 880; tA.Q.value = 11;
    const tB = ctx.createBiquadFilter(); tB.type = 'bandpass'; tB.frequency.value = 1450; tB.Q.value = 7;
    this.tyreFA = tA; this.tyreFB = tB;
    const tn = noise();
    tn.connect(tA).connect(this.tyreG);
    tn.connect(tB).connect(this.tyreG);
    this.tyreG.connect(this.master);

    // Gravel / grass rumble
    this.offF = ctx.createBiquadFilter(); this.offF.type = 'lowpass'; this.offF.frequency.value = 380;
    this.offG = ctx.createGain(); this.offG.gain.value = 0;
    noise().connect(this.offF).connect(this.offG).connect(this.master);

    // Wind
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'lowpass'; this.windF.frequency.value = 400;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    noise().connect(this.windF).connect(this.windG).connect(this.master);

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
    this.interior = on;
    if (!this.ready) return;
    this.cabin.frequency.setTargetAtTime(on ? 2600 : 14000, this.ctx.currentTime, 0.1);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend() { if (this.ctx) this.ctx.suspend(); }
  resume() { if (this.ctx) this.ctx.resume(); }

  /** Called every frame with telemetry from the car. */
  update(s) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, tc = 0.025;
    const rpm = s.rpm, load = s.load;
    this.p.rpm.setTargetAtTime(rpm, t, 0.012);
    this.p.load.setTargetAtTime(load, t, 0.03);
    this.p.running.setTargetAtTime(s.running ? 1 : 0, t, 0.001);
    this.p.cut.setTargetAtTime(s.cut ? 1 : 0, t, 0.001);
    this.p.gain.setTargetAtTime(s.running ? 1 : 0.0, t, s.running ? 0.01 : 0.12);

    const crankHz = rpm / 60;
    const thr = s.throttle;
    this.intakeF.frequency.setTargetAtTime(250 + rpm * 0.16, t, tc);
    this.intakeG.gain.setTargetAtTime(s.running ? (0.015 + thr * 0.12) * clamp(rpm / 6000, 0.2, 1.2) : 0, t, 0.04);

    const blowerHz = crankHz * 1.15 * 6;
    this.whine.frequency.setTargetAtTime(Math.max(20, blowerHz), t, tc);
    this.whine2.frequency.setTargetAtTime(Math.max(20, blowerHz * 2.01), t, tc);
    this.whineF.frequency.setTargetAtTime(Math.max(60, blowerHz * 1.3), t, tc);
    const boost = s.running ? (0.012 + load * 0.05) * Math.pow(clamp(rpm / 6500, 0, 1.1), 1.6) : 0;
    this.whineG.gain.setTargetAtTime(boost, t, 0.05);

    // Tyres
    const scrub = clamp(s.scrub, 0, 1);
    const onGrass = s.offroad ? 1 : 0;
    const sq = onGrass ? 0 : Math.pow(scrub, 1.3) * 0.32;
    this.tyreG.gain.setTargetAtTime(sq, t, 0.05);
    this.tyreFA.frequency.setTargetAtTime(780 + scrub * 220 + Math.sin(t * 7) * 30, t, 0.05);
    this.tyreFB.frequency.setTargetAtTime(1300 + scrub * 300, t, 0.05);
    const sp = Math.abs(s.speed);
    this.offG.gain.setTargetAtTime(onGrass * clamp(sp / 25, 0, 1) * 0.35, t, 0.06);
    this.windF.frequency.setTargetAtTime(300 + sp * 14, t, 0.1);
    this.windG.gain.setTargetAtTime(Math.min(0.22, (sp / 80) ** 2 * 0.22), t, 0.1);

    // Gearbox whine follows output-shaft speed in low gears
    const shaftHz = Math.abs(s.shaftRpm) / 60 * 17;
    this.gearOsc.frequency.setTargetAtTime(Math.max(20, shaftHz), t, tc);
    const gw = s.gear !== 0 && s.running ? (s.gear === -1 ? 0.05 : 0.012 * (6 - Math.abs(s.gear)) / 5) * clamp(load + 0.2, 0, 1) : 0;
    this.gearG.gain.setTargetAtTime(gw, t, 0.05);
  }

  // ---------------- One-shots ----------------
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
    const s = clamp(strength, 0, 1);
    this.burst(0.25 + s * 0.3, { freq: 380 + s * 400, gain: 0.25 + s * 0.6, q: 0.8 });
    this.burst(0.5, { type: 'bandpass', freq: 1700, q: 8, gain: 0.08 + s * 0.2 });
  }
}
