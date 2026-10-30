// Tachometer (canvas), speed, gear, shift lights, lap timing, toasts.
const MAX_RPM = 8000;
const RED = 6500;

export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export class HUD {
  constructor() {
    this.canvas = document.getElementById('tach');
    this.ctx = this.canvas.getContext('2d');
    this.speedEl = document.getElementById('speed');
    this.unitEl = document.getElementById('speed-unit');
    this.gearEl = document.getElementById('gear');
    this.lights = [...document.querySelectorAll('#shiftlights i')];
    this.lapEl = document.getElementById('lap-time');
    this.lastEl = document.getElementById('lap-last');
    this.bestEl = document.getElementById('lap-best');
    this.lapNoEl = document.getElementById('lap-no');
    this.toastEl = document.getElementById('toast');
    this.startBtn = document.getElementById('btn-start');
    this.toastTimer = 0;
    this.units = 'kmh';
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.size = Math.max(60, r.width);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bg = null;
  }

  angleFor(rpm) {
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    return a0 + (a1 - a0) * Math.min(rpm, MAX_RPM) / MAX_RPM;
  }

  drawBackground() {
    const s = this.size, dpr = this.canvas.width / s;
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = s / 2, cy = s / 2, R = s / 2 - 4;
    g.fillStyle = 'rgba(8,8,10,0.78)';
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    // redline arc
    g.strokeStyle = '#e0141e'; g.lineWidth = s * 0.05;
    g.beginPath(); g.arc(cx, cy, R * 0.86, this.angleFor(RED), this.angleFor(MAX_RPM)); g.stroke();
    // ticks
    for (let r = 0; r <= MAX_RPM; r += 250) {
      const a = this.angleFor(r), major = r % 1000 === 0;
      const r0 = R * (major ? 0.74 : 0.8), r1 = R * 0.9;
      g.strokeStyle = r >= RED ? '#ff4040' : '#e8e8e8';
      g.lineWidth = major ? 2.4 : 1;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
      if (major) {
        g.fillStyle = r >= RED ? '#ff4040' : '#f0f0f0';
        g.font = `600 ${Math.round(s * 0.085)}px system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(r / 1000), cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = `500 ${Math.round(s * 0.055)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText('x1000 rpm', cx, cy + R * 0.62);
    this.bg = c;
  }

  update(t) {
    if (!this.bg) this.drawBackground();
    const g = this.ctx, s = this.size, cx = s / 2, cy = s / 2, R = s / 2 - 4;
    g.clearRect(0, 0, s, s);
    g.drawImage(this.bg, 0, 0, s, s);
    const a = this.angleFor(t.rpm);
    g.strokeStyle = '#ff7a00'; g.lineWidth = 3.5; g.lineCap = 'round';
    g.shadowColor = '#ff7a00'; g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * R * 0.12, cy - Math.sin(a) * R * 0.12);
    g.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, R * 0.08, 0, Math.PI * 2); g.fill();

    const sp = Math.abs(t.speed) * (this.units === 'mph' ? 2.23694 : 3.6);
    this.speedEl.textContent = Math.round(sp);
    this.unitEl.textContent = this.units === 'mph' ? 'MPH' : 'KM/H';
    const gear = t.gear === -1 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);
    if (this.gearEl.textContent !== gear) this.gearEl.textContent = gear;

    // Shift lights: 5000 → 6400 rpm, flash at limiter
    const n = this.lights.length;
    const flash = t.rpm > 6400 && (performance.now() % 160) < 80;
    this.lights.forEach((el, i) => {
      const th = 5000 + i * (1400 / (n - 1));
      el.className = t.rpm >= th ? (flash ? 'flash' : i < 2 ? 'g' : i < 4 ? 'y' : 'r') : '';
    });

    this.lapEl.textContent = fmtTime(t.lapTime);
    this.lastEl.textContent = fmtTime(t.lastLap);
    this.bestEl.textContent = fmtTime(t.bestLap);
    this.lapNoEl.textContent = t.lap;
    this.startBtn.classList.toggle('show', !t.running && !t.cranking);

    if (this.toastTimer > 0) {
      this.toastTimer -= t.dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }

  toast(msg, secs = 2) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this.toastTimer = secs;
  }
}
