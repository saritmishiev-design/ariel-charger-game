// AudioWorklet: physically-inspired cross-plane V8 (Hemi) exhaust synthesiser.
//
// Model: 8 combustion pressure pulses per 720° cycle, fired in Chrysler order
// 1-8-4-3-6-5-7-2. Odd cylinders exhaust into the left bank, even into the right,
// which gives each bank the uneven L-R-R-L-R-L-L-R rhythm behind the V8 "burble".
// Each bank drives its own header/pipe waveguide (resonant delay line), then both
// meet in a muffler low-pass whose cutoff opens with load, then soft saturation.

const FIRING_ORDER = [1, 8, 4, 3, 6, 5, 7, 2];

class V8Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 10000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'running', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.sr = sampleRate;
    this.seed = 0x9e3779b9;
    this.bank = FIRING_ORDER.map(c => (c % 2 ? 0 : 1));
    // Per-cylinder personality: slightly different breathing & timing.
    this.cylGain = FIRING_ORDER.map(() => 0.76 + this.rand() * 0.48);
    this.cylTiming = FIRING_ORDER.map(() => (this.rand() - 0.5) * 0.1);
    this.fireCount = 0;
    this.firePos = 0;              // in "firing intervals"
    this.nextAt = 1;

    // Pulse generators (difference of exponentials) per bank
    this.pa = [0, 0]; this.pb = [0, 0]; this.nz = [0, 0];
    this.da = 0.99; this.db = 0.9; this.dn = 0.99;

    // Header / pipe waveguides — slightly unequal lengths give a richer beat
    const maxLen = 4096;
    this.dl = [new Float32Array(maxLen), new Float32Array(maxLen)];
    this.dlPos = [0, 0];
    this.dlLen = [Math.round(this.sr / (2 * 86)), Math.round(this.sr / (2 * 97))];
    this.dlLp = [0, 0];
    // Short "header collector" comb for rasp
    this.hl = [new Float32Array(512), new Float32Array(512)];
    this.hlPos = [0, 0];
    this.hlLen = [Math.round(this.sr / 410), Math.round(this.sr / 455)];

    // Muffler 2-pole low-pass state (per channel) and DC blockers
    this.m1 = [0, 0]; this.m2 = [0, 0];
    this.dcx = [0, 0]; this.dcy = [0, 0];

    this.bodyPhase = 0;
    this.rpmS = 0; this.loadS = 0; this.popEnv = 0;
  }

  rand() {
    // xorshift32 → [0,1)
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  fire(cyl, rpm, load, cut) {
    const b = this.bank[cyl];
    const lope = Math.max(0, 1 - (rpm - 900) / 1800);          // big-cam idle lope
    let amp = this.cylGain[cyl] * (1 + (this.rand() - 0.5) * (0.12 + 0.55 * lope));
    let noise = 0.25 + load * 0.9;
    let level = 0.28 + 0.72 * Math.pow(load, 0.75);
    const overrun = load < 0.06 && rpm > 2300;

    if (lope > 0.4 && this.rand() < 0.035 * lope) level *= 0.25;   // lumpy near-misfire at idle
    if (cut && this.rand() < 0.8) {
      // limiter fuel cut: missing fires and the odd pop of unburnt fuel
      if (this.rand() < 0.18) { level = 1.5; noise = 2.4; this.popEnv = 1; }
      else level = 0.05;
    } else if (overrun) {
      level = 0.13;
      if (this.rand() < 0.07) {                                    // overrun crackle
        level = 0.9 + this.rand() * 1.1; noise = 2.8; this.popEnv = 1;
      }
    }
    amp *= level;
    this.pa[b] += amp;
    this.pb[b] += amp;
    this.nz[b] += amp * noise;
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length, sr = this.sr;
    const rpmT = params.rpm[0], loadT = params.load[0];
    const running = params.running[0] > 0.5, cut = params.cut[0] > 0.5;
    const outGain = params.gain[0];
    const rpm0 = this.rpmS, load0 = this.loadS;

    // Pulse shapes scale with the firing interval (computed per block)
    const interval = 15 / Math.max(rpmT, 120);                    // seconds between firings
    const tauA = Math.min(0.0048, Math.max(0.0007, interval * 0.32));
    const tauB = tauA * 0.28;
    const tauN = tauA * (0.55 + this.popEnv * 2.5);
    const da = Math.exp(-1 / (tauA * sr)), db = Math.exp(-1 / (tauB * sr)), dn = Math.exp(-1 / (tauN * sr));
    // Muffler: resonant 2-pole low-pass opening with load + rpm
    const fc = Math.min(7000, 420 + 2900 * Math.pow(loadT, 0.8) + rpmT * 0.32 + this.popEnv * 2500);
    const g = 1 - Math.exp(-6.283185307 * fc / sr);
    const fb = 0.18;
    const drive = 1.4 + loadT * 2.6 + this.popEnv;
    const norm = outGain * 0.62 / Math.tanh(drive);
    const lopeBlk = Math.max(0, 1 - (rpmT - 900) / 1800);

    for (let i = 0; i < n; i++) {
      const f = (i + 1) / n;
      const rpm = rpm0 + (rpmT - rpm0) * f;
      const load = load0 + (loadT - load0) * f;

      if (running && rpm > 60) {
        this.firePos += rpm / 15 / sr;
        if (this.firePos >= this.nextAt) {
          const cyl = this.fireCount % 8;
          this.fire(cyl, rpm, load, cut);
          this.fireCount++;
          const nc = this.fireCount % 8;
          this.nextAt = Math.floor(this.firePos) + 1 + this.cylTiming[nc] * (0.4 + lopeBlk) + (this.rand() - 0.5) * 0.06 * lopeBlk;
          if (this.firePos > 1e6) { this.firePos -= 1e6; this.nextAt -= 1e6; }
        }
      }
      this.popEnv *= 0.9992;

      let yl = 0, yr = 0;
      for (let b = 0; b < 2; b++) {
        this.pa[b] *= da; this.pb[b] *= db; this.nz[b] *= dn;
        const white = this.rand() * 2 - 1;
        const x = (this.pa[b] - this.pb[b]) * 1.6 + white * this.nz[b] * 0.22;

        // Header collector comb (short) → rasp
        const hb = this.hl[b], hp = this.hlPos[b], hlen = this.hlLen[b];
        const hRead = hb[(hp - hlen + 512) & 511];
        const h = x + hRead * 0.35;
        hb[hp] = h;
        this.hlPos[b] = (hp + 1) & 511;

        // Pipe waveguide with damped open-end reflection (odd harmonics)
        const dlb = this.dl[b], p = this.dlPos[b], len = this.dlLen[b];
        const rd = dlb[(p - len + 4096) & 4095];
        this.dlLp[b] += 0.42 * (rd - this.dlLp[b]);
        const y = h - 0.52 * this.dlLp[b];
        dlb[p] = y;
        this.dlPos[b] = (p + 1) & 4095;
        if (b === 0) yl = y; else yr = y;
      }

      // Two banks meet: mostly separate, some cross-talk (H-pipe)
      let chL = yl * 0.8 + yr * 0.28;
      let chR = yr * 0.8 + yl * 0.28;

      // Fundamental "body" at firing frequency — weight on bigger speakers
      this.bodyPhase += rpm / 15 / sr;
      if (this.bodyPhase > 1) this.bodyPhase -= 1;
      const body = running ? Math.sin(this.bodyPhase * 6.283185307) * (0.05 + load * 0.08) * Math.min(1, rpm / 600) : 0;

      for (let c = 0; c < 2; c++) {
        const inp = (c === 0 ? chL : chR) - this.m2[c] * fb;
        this.m1[c] += g * (inp - this.m1[c]);
        this.m2[c] += g * (this.m1[c] - this.m2[c]);
        // DC blocker
        const y = this.m2[c] + body;
        const dc = y - this.dcx[c] + 0.9975 * this.dcy[c];
        this.dcx[c] = y; this.dcy[c] = dc;
        // Saturation: thicker and grittier under load
        const s = Math.tanh(dc * drive) * norm;
        if (c === 0) L[i] = s; else if (R !== L) R[i] = s;
      }
    }
    this.rpmS = rpmT;
    this.loadS = loadT;
    return true;
  }
}

registerProcessor('v8-hemi', V8Processor);
