// Custom garage & dyno: edit the build, see the engine's power/torque curves update live, and run
// the full drivetrain on a simulated drag strip. Everything comes from build.js, the same model
// the driving physics uses.
import {
  STOCK, LIMITS, CYLINDERS, LAYOUTS, INDUCTION, TRANS, layoutAllows, sanitize, engineModel,
  deriveSpec, shiftSpeeds, balance, dragRun,
} from './build.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const GEAR_NAMES = ['1st', '2nd', '3rd', '4th', '5th'];

export class Garage {
  constructor({ baseSpec, current, onApply, onClose }) {
    this.base = baseSpec;
    this.applied = sanitize(current);
    this.b = sanitize(current);
    this.onApply = onApply;
    this.onClose = onClose;
    this.stockEngine = engineModel(STOCK);
    this.el = $('garage');
    this.buildUi();
    this.refresh();
    window.addEventListener('resize', () => { if (this.open) this.drawDyno(); });
  }

  show() {
    this.b = sanitize(this.applied);
    this.syncControls();
    this.refresh();
    this.el.classList.add('show');
    this.open = true;
    this.el.querySelector('.g-body').scrollTop = 0;
    requestAnimationFrame(() => this.drawDyno());
  }

  hide() { this.el.classList.remove('show'); this.open = false; this.cancelRun(); }

  // ------------------------------------------------------------------ UI construction
  slider(parent, key, label, unit, digits, opts = {}) {
    const [lo, hi, step] = opts.range || LIMITS[key];
    const row = document.createElement('label');
    row.className = 'g-slider';
    row.innerHTML = `<span class="g-l">${label}</span><b class="g-v"></b><input type="range" min="${lo}" max="${hi}" step="${step}">`;
    const input = row.querySelector('input'), out = row.querySelector('.g-v');
    const get = opts.get || (() => this.b[key]);
    const set = opts.set || ((v) => { this.b[key] = v; });
    const show = () => { out.textContent = `${fmt(+get(), digits)}${unit}`; };
    input.addEventListener('input', () => { set(+input.value); show(); this.refresh(); });
    parent.appendChild(row);
    this.controls.push(() => { input.value = get(); show(); });
    return row;
  }

  seg(parent, key, label, options, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'g-segrow';
    wrap.innerHTML = `<span class="g-l">${label}</span><div class="seg g-seg"></div>`;
    const seg = wrap.querySelector('.g-seg');
    for (const [v, text] of options) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.dataset.v = v; btn.textContent = text;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        (onPick || ((x) => { this.b[key] = x; }))(isNaN(+v) ? v : +v);
        this.syncControls(); this.refresh();
      });
      seg.appendChild(btn);
    }
    parent.appendChild(wrap);
    this.controls.push(() => seg.querySelectorAll('button').forEach(btn => btn.classList.toggle('on', String(this.b[key]) === btn.dataset.v)));
    return seg;
  }

  card(parent, title, sub) {
    const c = document.createElement('section');
    c.className = 'g-card';
    c.innerHTML = `<h3>${title}${sub ? `<small>${sub}</small>` : ''}</h3>`;
    parent.appendChild(c);
    return c;
  }

  info(parent) {
    const d = document.createElement('div');
    d.className = 'g-info';
    parent.appendChild(d);
    return d;
  }

  buildUi() {
    this.controls = [];
    const left = this.el.querySelector('.g-left');
    // Engine block
    const eng = this.card(left, 'ENGINE BLOCK', 'bore × stroke × cylinders = displacement');
    this.slider(eng, 'bore', 'Bore (piston width)', ' mm', 1);
    this.slider(eng, 'stroke', 'Stroke (piston travel)', ' mm', 1);
    this.slider(eng, 'cr', 'Compression ratio', ':1', 1);
    this.cylSeg = this.seg(eng, 'cyl', 'Cylinders', CYLINDERS.map(c => [c, String(c)]), (c) => {
      this.b.cyl = c;
      if (!layoutAllows(this.b.layout, c)) this.b.layout = 'V';
    });
    this.laySeg = this.seg(eng, 'layout', 'Configuration', Object.entries(LAYOUTS));
    this.engInfo = this.info(eng);
    // Induction
    const ind = this.card(left, 'FORCED INDUCTION');
    this.seg(ind, 'induction', 'Setup', [['na', 'NA'], ['turbo', 'Turbo'], ['sc', 'Super'], ['twin', 'Twin']], (v) => {
      this.b.induction = v;
      if (v === 'turbo' && this.applied.induction !== 'turbo' && this.b.boost < 10) this.b.boost = 14;
    });
    this.boostRow = this.slider(ind, 'boost', 'Max boost', ' psi', 1);
    this.indInfo = this.info(ind);
    // Transmission
    const tr = this.card(left, 'TRANSMISSION');
    this.seg(tr, 'trans', 'Type', Object.entries(TRANS).map(([k, t]) => [k, t.name.replace('Sequential ', '')]), (v) => {
      this.b.trans = v;
      this.b.gears = TRANS[v].gears.slice();     // each box comes with its own ratios; tune below
      this.b.final = TRANS[v].final;
    });
    this.trInfo = this.info(tr);
    const det = document.createElement('details');
    det.className = 'g-ratios';
    det.innerHTML = '<summary>Gear ratios &amp; final drive</summary>';
    tr.appendChild(det);
    GEAR_NAMES.forEach((name, i) => this.slider(det, null, `${name} gear`, '', 2, {
      range: LIMITS.gear,
      get: () => this.b.gears[i],
      set: (v) => {
        const g = this.b.gears;
        g[i] = v;
        // Keep the box sane: every gear taller than the one below it
        for (let k = i - 1; k >= 0; k--) g[k] = Math.max(g[k], g[k + 1] + 0.05);
        for (let k = i + 1; k < 5; k++) g[k] = Math.min(g[k], g[k - 1] - 0.05);
        for (let k = 0; k < 5; k++) g[k] = Math.min(LIMITS.gear[1], Math.max(LIMITS.gear[0], Math.round(g[k] * 100) / 100));
        this.syncControls();
      },
    }));
    this.slider(det, 'final', 'Final drive', ':1', 2);
    // Tyres
    const ty = this.card(left, 'TYRES');
    this.slider(ty, 'tireFront', 'Front width', ' mm', 0);
    this.slider(ty, 'tireRear', 'Rear width', ' mm', 0);
    this.slider(ty, 'tireDia', 'Overall diameter', '″', 1);
    this.tyInfo = this.info(ty);

    // Buttons
    $('g-back').addEventListener('click', () => { this.hide(); this.onClose && this.onClose(); });
    $('g-apply').addEventListener('click', () => this.apply());
    $('g-stock').addEventListener('click', () => { this.b = sanitize(STOCK); this.syncControls(); this.refresh(); });
    $('g-run').addEventListener('click', () => this.run());
    this.syncControls();
  }

  syncControls() {
    for (const f of this.controls) f();
    // Layout/cylinder combinations that don't exist are greyed out
    this.laySeg.querySelectorAll('button').forEach(btn => { btn.disabled = !layoutAllows(btn.dataset.v, this.b.cyl); });
    this.cylSeg.querySelectorAll('button').forEach(btn => { btn.disabled = !layoutAllows(this.b.layout, +btn.dataset.v); });
    this.boostRow.style.display = this.b.induction === 'na' ? 'none' : '';
  }

  // ------------------------------------------------------------------ live numbers
  refresh() {
    const b = this.b = sanitize(this.b);
    const e = this.engine = engineModel(b);
    const spec = this.spec = { ...this.base, ...deriveSpec(this.base, b) };
    const sq = b.bore / b.stroke;
    const pistonMs = 2 * b.stroke / 1000 * e.redline / 60;
    this.engInfo.innerHTML =
      `<span><b>${fmt(e.dispL, 2)} L</b> · ${fmt(e.ci)} ci</span>` +
      `<span>${sq > 1.03 ? 'Over-square' : sq < 0.97 ? 'Under-square' : 'Square'} ${fmt(sq, 2)}</span>` +
      `<span>Redline <b>${fmt(e.redline)}</b> rpm</span>` +
      `<span>Piston speed ${fmt(pistonMs, 1)} m/s</span>` +
      `<span>Engine ${fmt(e.mass)} kg</span>`;
    const crEff = b.cr * Math.pow(1 + (b.induction === 'na' ? 0 : b.boost / 14.7), 1 / 1.3);
    this.indInfo.innerHTML = b.induction === 'na'
      ? '<span>No boost: crisp response, highest compression without knock.</span>'
      : `<span>${INDUCTION[b.induction]}</span><span>Effective CR ${fmt(crEff, 1)}</span>` +
        (e.knockLimited ? `<span class="warn">⚠ Knock: timing pulled ${fmt(e.knockLoss * 100)}% — lower compression or boost</span>` : '<span class="ok">✓ No knock</span>') +
        (e.turbo ? '<span>Turbo lag: boost builds with revs and throttle</span>' : '');
    const ss = shiftSpeeds(spec);
    this.trInfo.innerHTML = `<span>${TRANS[b.trans].name} · shift ${fmt(TRANS[b.trans].shiftTime * 1000)} ms</span>` +
      ss.map((v, i) => `<span class="chip">${GEAR_NAMES[i]} <b>${fmt(v)}</b></span>`).join('') + '<span class="muted">km/h at redline</span>';
    const bal = balance(spec), stockBal = 1.25 / 1.15;
    const balTxt = bal < 1 ? '<span class="warn">⚠ Oversteer-prone: front out-grips the rear</span>'
      : bal < stockBal * 0.97 ? '<span>Lively balance</span>' : '<span class="ok">✓ Stable balance</span>';
    this.tyInfo.innerHTML = `<span>Grip F ${fmt(spec.frictionSlipFront / this.base.frictionSlipFront * 100)}% · R ${fmt(spec.frictionSlipRear / this.base.frictionSlipRear * 100)}%</span>` +
      `${balTxt}<span>Car ${fmt(spec.mass)} kg · ${fmt(spec.frontWeight * 100)}% front</span>`;
    // Header summary + peaks
    $('g-hp').textContent = fmt(e.peakHp);
    $('g-hp-rpm').textContent = `@ ${fmt(e.peakHpRpm)} rpm`;
    $('g-tq').textContent = fmt(e.peakTorque);
    $('g-tq-rpm').textContent = `@ ${fmt(e.peakTorqueRpm)} rpm`;
    $('g-pw').textContent = fmt(e.peakHp / spec.mass * 1000);
    const changed = JSON.stringify(b) !== JSON.stringify(this.applied);
    $('g-apply').textContent = changed ? 'APPLY & DRIVE' : 'DRIVE';
    this.results(null);
    if (!this.running) this.drawDyno();
  }

  // ------------------------------------------------------------------ dyno graph
  drawDyno(sweepRpm = null) {
    const cv = $('g-dyno');
    const rect = cv.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = rect.width, H = rect.height;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const e = this.engine, st = this.stockEngine;
    const hpAt = (rpm, t) => t * rpm * Math.PI / 30 / 745.7;
    const maxRpm = Math.ceil((Math.max(e.limiter, st.limiter) + 200) / 1000) * 1000;
    const peakT = Math.max(e.peakTorque, st.peakTorque), peakP = Math.max(e.peakHp, st.peakHp);
    const nice = (x) => { const p = Math.pow(10, Math.floor(Math.log10(x))); return Math.ceil(x / p * 2) / 2 * p; };
    const yMax = nice(Math.max(peakT, peakP) * 1.1);
    const L = 38, R = 38, T = 14, B = 22, PW = W - L - R, PH = H - T - B;
    const X = (rpm) => L + rpm / maxRpm * PW, Y = (v) => T + PH - v / yMax * PH;
    // grid
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
    g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '9px system-ui, sans-serif';
    for (let r = 0; r <= maxRpm; r += 1000) {
      g.beginPath(); g.moveTo(X(r), T); g.lineTo(X(r), T + PH); g.stroke();
      g.textAlign = 'center'; g.fillText(String(r / 1000), X(r), H - 8);
    }
    for (let i = 0; i <= 5; i++) {
      const v = yMax * i / 5;
      g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + PW, Y(v)); g.stroke();
      g.textAlign = 'right'; g.fillStyle = 'rgba(255,170,90,0.75)'; g.fillText(fmt(v), L - 5, Y(v) + 3);
      g.textAlign = 'left'; g.fillStyle = 'rgba(120,220,255,0.75)'; g.fillText(fmt(v), L + PW + 5, Y(v) + 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.4)'; g.textAlign = 'center';
    g.fillText('rpm ×1000', L + PW / 2, H - 0.5);
    // redline band
    g.fillStyle = 'rgba(224,20,30,0.12)';
    g.fillRect(X(e.redline), T, X(e.limiter) - X(e.redline), PH);
    const plot = (eng, fn, color, width, dash, upTo) => {
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash);
      g.beginPath();
      let first = true;
      for (const [rpm, t] of eng.curve) {
        if (rpm < 600 || rpm > eng.limiter || rpm > upTo) continue;
        const v = fn(rpm, t);
        if (first) { g.moveTo(X(rpm), Y(v)); first = false; } else g.lineTo(X(rpm), Y(v));
      }
      g.stroke(); g.setLineDash([]);
    };
    const upTo = sweepRpm == null ? Infinity : sweepRpm;
    // stock reference (dashed)
    if (JSON.stringify(this.b) !== JSON.stringify(sanitize(STOCK))) {
      plot(st, (r, t) => t, 'rgba(255,140,40,0.35)', 1.5, [4, 4], Infinity);
      plot(st, hpAt, 'rgba(80,200,255,0.35)', 1.5, [4, 4], Infinity);
    }
    plot(e, (r, t) => t, '#ff8a1a', 2.5, [], upTo);
    plot(e, hpAt, '#33d6ff', 2.5, [], upTo);
    // peak markers
    if (sweepRpm == null || sweepRpm >= e.limiter) {
      const dot = (x, y, c, label, above) => {
        g.fillStyle = c; g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill();
        g.font = 'bold 10px system-ui, sans-serif'; g.textAlign = 'center';
        g.fillText(label, Math.min(L + PW - 30, Math.max(L + 30, x)), y + (above ? -8 : 15));
      };
      dot(X(e.peakTorqueRpm), Y(e.peakTorque), '#ff8a1a', `${fmt(e.peakTorque)} Nm`, true);
      dot(X(e.peakHpRpm), Y(e.peakHp), '#33d6ff', `${fmt(e.peakHp)} hp`, e.peakHp > e.peakTorque);
    }
    // sweep needle
    if (sweepRpm != null && sweepRpm < e.limiter) {
      const tq = e.curve[Math.min(e.curve.length - 1, Math.round(sweepRpm / 100))][1];
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(sweepRpm), T); g.lineTo(X(sweepRpm), T + PH); g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 11px system-ui, sans-serif'; g.textAlign = 'left';
      const lx = Math.min(X(sweepRpm) + 6, L + PW - 92);
      g.fillText(`${fmt(sweepRpm)} rpm`, lx, T + 12);
      g.fillStyle = '#ff8a1a'; g.fillText(`${fmt(tq)} Nm`, lx, T + 26);
      g.fillStyle = '#33d6ff'; g.fillText(`${fmt(hpAt(sweepRpm, tq))} hp`, lx, T + 40);
    }
    // legend
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
    g.fillStyle = '#ff8a1a'; g.fillText('■ Torque (Nm)', L + 6, T + PH - 20);
    g.fillStyle = '#33d6ff'; g.fillText('■ Power (hp)', L + 6, T + PH - 7);
  }

  // ------------------------------------------------------------------ simulation run
  cancelRun() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.running = false; $('g-run').disabled = false; }

  run() {
    this.cancelRun();
    this.running = true;
    $('g-run').disabled = true;
    this.results('pending');
    const e = this.engine, t0 = performance.now(), dur = 2200;
    const sweep = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const rpm = 800 + (e.limiter - 800) * (k * k * (3 - 2 * k));
      this.drawDyno(k < 1 ? rpm : null);
      if (k < 1) { this.raf = requestAnimationFrame(sweep); return; }
      // Then the drag strip, with the real drivetrain
      const r = dragRun(this.spec);
      this.results(r);
      this.running = false; this.raf = 0;
      $('g-run').disabled = false;
    };
    this.raf = requestAnimationFrame(sweep);
  }

  results(r) {
    const el = $('g-results');
    if (r === 'pending') { el.innerHTML = '<div class="g-pending">Dyno pull in progress…</div>'; return; }
    if (!r) { el.innerHTML = '<div class="g-pending">Tap <b>RUN SIMULATION</b> for a dyno pull and a drag-strip run.</div>'; return; }
    const cell = (k, v) => `<div><small>${k}</small><b>${v}</b></div>`;
    el.innerHTML = cell('0–100 km/h', r.t100 ? `${fmt(r.t100, 2)} s` : '—') +
      cell('0–200 km/h', r.t200 ? `${fmt(r.t200, 1)} s` : '—') +
      cell('¼ mile', r.quarter ? `${fmt(r.quarter.t, 2)} s` : '—') +
      cell('Trap speed', r.quarter ? `${fmt(r.quarter.kmh)} km/h` : '—') +
      cell('Top speed', `${fmt(r.top)} km/h`) +
      cell('Weight', `${fmt(this.spec.mass)} kg`);
  }

  apply() {
    const b = sanitize(this.b);
    const changed = JSON.stringify(b) !== JSON.stringify(this.applied);
    this.onApply(b, changed);
  }
}
