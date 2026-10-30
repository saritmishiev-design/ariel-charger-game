// AudioWorklet: physically-inspired cross-plane V8 (Hemi) exhaust synthesiser.
//
// Model: 8 combustion pressure pulses per 720° cycle, fired in Chrysler order
// 1-8-4-3-6-5-7-2. Odd cylinders exhaust into the left bank, even into the right,
// so each bank gets the uneven L-R-R-L-R-L-L-R rhythm (bank intervals 90/180/270°)
// behind the muscle-car "burble". Each bank drives its own header comb and pipe
// waveguide, then a muffler low-pass, two throat formants and asymmetric saturation.
//
// Why the banks differ: a phone speaker sums both pipes to mono. Two identical banks
// would sum back into an even 8-pulse buzz and the cross-plane lope would vanish.
// Real dual exhausts never match (header lengths, pipe routing, which side faces you),
// so each bank gets its own level, pulse shape and pipe resonance. In the mono sum
// that keeps the uneven sub-firing orders that make the sound lumpy and throaty.

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
    // Near-side bank louder and fatter; far-side bank thinner and sharper
    this.bankGain = [1.0, 0.55];
    this.bankTau = [1.0, 0.6];
    // The far tailpipe's sound arrives ~2 ms later (≈0.7 m longer path to the listener)
    this.farLen = Math.round(this.sr * 0.0021);
    this.far = new Float32Array(1024);
    this.farPos = 0;
    // Per-cylinder personality: slightly different breathing & timing.
    this.cylGain = FIRING_ORDER.map(() => 0.72 + this.rand() * 0.56);
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
    this.dlLen = [Math.round(this.sr / (2 * 66)), Math.round(this.sr / (2 * 103))];
    this.dlLp = [0, 0];
    // Short "header collector" comb for rasp
    this.hl = [new Float32Array(512), new Float32Array(512)];
    this.hlPos = [0, 0];
    this.hlLen = [Math.round(this.sr / 330), Math.round(this.sr / 410)];

    // Muffler 2-pole low-pass state (per channel) and DC blockers
    this.m1 = [0, 0]; this.m2 = [0, 0];
    this.dcx = [0, 0]; this.dcy = [0, 0];
    this.dc2x = [0, 0]; this.dc2y = [0, 0];
    // Throat formants (band-pass biquads) per channel: [x1, x2, y1, y2]
    this.f1 = [[0, 0, 0, 0], [0, 0, 0, 0]];
    this.f2 = [[0, 0, 0, 0], [0, 0, 0, 0]];

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
    let level = 0.42 + 0.58 * Math.pow(load, 0.75);
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
    amp *= level * this.bankGain[b];
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
    // Wide, bass-heavy pulses that scale with the firing interval (computed per block)
    const interval = 15 / Math.max(rpmT, 120);                    // seconds between firings
    const tauA0 = Math.min(0.0028, Math.max(0.0008, interval * 0.3));
    const dA = [0, 0], dB = [0, 0];
    for (let b = 0; b < 2; b++) {
      const tA = tauA0 * this.bankTau[b];
      dA[b] = Math.exp(-1 / (tA * sr)); dB[b] = Math.exp(-1 / (tA * 0.3 * sr));
    }
    const tauN = tauA0 * (0.45 + this.popEnv * 2.5);
    const dn = Math.exp(-1 / (tauN * sr));
    // Muffler: resonant 2-pole low-pass opening with load + rpm (darker than a race pipe)
    const fc = Math.min(6000, 300 + 2300 * Math.pow(loadT, 0.8) + rpmT * 0.26 + this.popEnv * 2500);
    const g = 1 - Math.exp(-6.283185307 * fc / sr);
    const fb = 0.22;
    // Throat formants: the chesty "ohh" of big-bore pipes, rising a little with revs
    const bp = (f, q) => {
      const w = 6.283185307 * f / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
      return [al / a0, -al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0];   // b0, b2, a1, a2 (b1 = 0)
    };
    const F1 = bp(150 + rpmT * 0.02, 1.5), F2 = bp(380 + rpmT * 0.034, 2.4);
    const g1 = 1.5 + loadT * 0.9, g2 = 0.35 + loadT * 0.35;
    // Moderate drive: hard clipping would flatten every pulse to the same height and erase
    // the bank-to-bank differences that carry the cross-plane lope
    const drive = 1.0 + loadT * 1.1 + this.popEnv;
    const lopeBlk = Math.max(0, 1 - (rpmT - 900) / 1800);
    // A big-cam Hemi idles loud: lift the low-rpm level so the lope is heard over the road
    const norm = outGain * 0.5 * (1 + 0.9 * lopeBlk) / Math.tanh(drive);

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
          // Next nominal slot (round, not floor: an early fire must not schedule a double fire)
          this.nextAt = Math.round(this.firePos) + 1 + this.cylTiming[nc] * (0.4 + lopeBlk) + (this.rand() - 0.5) * 0.06 * lopeBlk;
          if (this.firePos > 1e6) { this.firePos -= 1e6; this.nextAt -= 1e6; }
        }
      }
      this.popEnv *= 0.9992;

      let yl = 0, yr = 0;
      for (let b = 0; b < 2; b++) {
        this.pa[b] *= dA[b]; this.pb[b] *= dB[b]; this.nz[b] *= dn;
        const white = this.rand() * 2 - 1;
        const x = (this.pa[b] - this.pb[b]) * 1.6 + white * this.nz[b] * 0.16;

        // Header collector comb (short) → rasp
        const hb = this.hl[b], hp = this.hlPos[b], hlen = this.hlLen[b];
        const hRead = hb[(hp - hlen + 512) & 511];
        const h = x + hRead * 0.28;
        hb[hp] = h;
        this.hlPos[b] = (hp + 1) & 511;

        // Pipe waveguide with damped open-end reflection (odd harmonics)
        const dlb = this.dl[b], p = this.dlPos[b], len = this.dlLen[b];
        const rd = dlb[(p - len + 4096) & 4095];
        this.dlLp[b] += 0.42 * (rd - this.dlLp[b]);
        const y = h - 0.58 * this.dlLp[b];
        dlb[p] = y;
        this.dlPos[b] = (p + 1) & 4095;
        if (b === 0) yl = y; else yr = y;
      }

      // Far-side bank: delayed by its longer path
      this.far[this.farPos] = yr;
      yr = this.far[(this.farPos - this.farLen + 1024) & 1023];
      this.farPos = (this.farPos + 1) & 1023;
      // True dual exhaust: banks stay mostly separate (a little H-pipe cross-talk)
      let chL = yl * 0.88 + yr * 0.16;
      let chR = yr * 0.88 + yl * 0.16;

      // Fundamental "body" at firing frequency — weight on bigger speakers
      this.bodyPhase += rpm / 15 / sr;
      if (this.bodyPhase > 1) this.bodyPhase -= 1;
      const body = running ? Math.sin(this.bodyPhase * 6.283185307) * (0.03 + load * 0.05) * Math.min(1, rpm / 600) : 0;

      for (let c = 0; c < 2; c++) {
        const inp = (c === 0 ? chL : chR) - this.m2[c] * fb;
        this.m1[c] += g * (inp - this.m1[c]);
        this.m2[c] += g * (this.m1[c] - this.m2[c]);
        const m = this.m2[c];
        // Throat formants
        const s1 = this.f1[c], s2 = this.f2[c];
        const y1 = F1[0] * m + F1[1] * s1[1] - F1[2] * s1[2] - F1[3] * s1[3];
        s1[1] = s1[0]; s1[0] = m; s1[3] = s1[2]; s1[2] = y1;
        const y2 = F2[0] * m + F2[1] * s2[1] - F2[2] * s2[2] - F2[3] * s2[3];
        s2[1] = s2[0]; s2[0] = m; s2[3] = s2[2]; s2[2] = y2;
        // DC blocker
        const y = m + y1 * g1 + y2 * g2 + body;
        const dc = y - this.dcx[c] + 0.9975 * this.dcy[c];
        this.dcx[c] = y; this.dcy[c] = dc;
        // Asymmetric saturation: even harmonics of the low pulses land where a phone speaker
        // can play them, so the bass is heard as weight, not lost below the speaker's range
        const sat = Math.tanh(dc * drive + dc * Math.abs(dc) * drive * 0.45) * norm;
        const o = sat - this.dc2x[c] + 0.995 * this.dc2y[c];
        this.dc2x[c] = sat; this.dc2y[c] = o;
        if (c === 0) L[i] = o; else if (R !== L) R[i] = o;
      }
    }
    this.rpmS = rpmT;
    this.loadS = loadT;
    return true;
  }
}

registerProcessor('v8-hemi', V8Processor);
