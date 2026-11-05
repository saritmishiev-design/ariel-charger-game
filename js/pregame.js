// Pre-game garage: pick a track and a car, toggle the tunes, watch the performance bars move.
import { CARS, TRACKS, TUNES, TUNE_DEFAULT, carSpec, performance, carSummary } from './cars.js';
import { trackOutline } from './track.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// Side silhouettes (viewBox 0 0 200 60): body path + wheel centres
const SILHOUETTES = {
  charger: { d: 'M7 43 L9 34 Q12 30 30 29 L72 27 Q80 26 86 21 L101 14 Q106 12 119 12 L134 13 Q141 15 151 25 L184 27 Q192 28 194 34 L194 43 Z', wheels: [44, 158] },
  gtr: { d: 'M6 43 L8 36 Q12 31 40 29 L76 26 L101 14 Q108 11 124 12 L141 14 Q157 20 177 26 L190 27 L192 34 L193 43 Z M168 21 L195 19 L195 22 L170 23 Z', wheels: [42, 160] },
  sentra: { d: 'M8 43 L9 34 Q12 29 36 27 L64 25 L90 12 Q96 10 116 10 L134 11 Q146 14 162 24 L186 25 Q192 26 193 33 L193 43 Z', wheels: [44, 156] },
};

function silhouette(id) {
  const s = SILHOUETTES[id];
  return `<svg viewBox="0 0 200 60" aria-hidden="true"><path d="${s.d}" />${s.wheels.map(x => `<circle cx="${x}" cy="44" r="10.5" /><circle class="hub" cx="${x}" cy="44" r="4.5" />`).join('')}</svg>`;
}

function drawOutline(canvas, id) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 140, h = canvas.clientHeight || 64;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts = trackOutline(id);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = 8, k = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxZ - minZ));
  const ox = (w - (maxX - minX) * k) / 2, oy = (h - (maxZ - minZ) * k) / 2;
  const P = ([x, z]) => [ox + (x - minX) * k, oy + (z - minZ) * k];
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  pts.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  if (id !== 'drag') g.closePath();
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = id === 'drag' ? 9 : 6; g.stroke();
  g.strokeStyle = '#ff9a3c'; g.lineWidth = 2; g.stroke();
  const [sx, sy] = P(pts[id === 'drag' ? Math.round(pts.length * 0.07) : 0]);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill();
  if (id === 'drag') {
    const [fx, fy] = P(pts[Math.round(pts.length * 0.353)]);
    g.fillStyle = '#ffd400'; g.fillRect(fx - 1.5, fy - 9, 3, 18);
    g.font = '700 10px system-ui, sans-serif'; g.fillStyle = '#ffd400'; g.textAlign = 'center';
    g.fillText('402 m', (sx + fx) / 2, sy - 11);
  }
}

export class PreGame {
  constructor({ setup, custom, onChange, onRace, onSettings, onEngine }) {
    this.setup = setup;
    this.custom = custom;
    this.onChange = onChange;
    this.stockPerf = {};
    this.root = $('pregame');
    this.build();
    $('pg-race').addEventListener('click', () => onRace());
    $('pg-settings').addEventListener('click', () => onSettings());
    $('pg-engine').addEventListener('click', () => onEngine());
    window.addEventListener('resize', () => this.drawMaps());
    this.refresh();
  }

  build() {
    const tracks = $('pg-tracks');
    for (const [id, t] of Object.entries(TRACKS)) {
      const b = el('button', 'pg-card', `<canvas></canvas><b>${t.name}</b><small>${t.sub.split('·').pop().trim()}</small>`);
      b.dataset.id = id;
      b.addEventListener('click', () => { this.setup.track = id; this.changed(); });
      tracks.appendChild(b);
    }
    const cars = $('pg-cars');
    for (const [id, c] of Object.entries(CARS)) {
      const b = el('button', `pg-card car-${id}`, `${silhouette(id)}<b>${c.name}</b><small>${c.tag}</small>`);
      b.dataset.id = id;
      b.addEventListener('click', () => { this.setup.car = id; this.changed(); });
      cars.appendChild(b);
    }
    const tunes = $('pg-tunes');
    for (const [key, def] of Object.entries(TUNES)) {
      const row = el('div', 'pg-tune', `<span class="g-l">${def.label}</span>`);
      const seg = el('div', 'seg');
      for (const [v, label] of def.options) {
        const btn = el('button', null, label);
        btn.dataset.k = key; btn.dataset.v = v;
        btn.addEventListener('click', () => { this.setup.tunes[this.setup.car][key] = v; this.changed(); });
        seg.appendChild(btn);
      }
      row.appendChild(seg);
      row.appendChild(el('small', 'pg-hint'));
      tunes.appendChild(row);
    }
    const bars = $('pg-bars');
    for (const [k, label] of [['hp', 'POWER'], ['accel', 'ACCELERATION'], ['top', 'TOP SPEED'], ['grip', 'GRIP']]) {
      bars.appendChild(el('div', `pg-bar bar-${k}`, `<span>${label}</span><div class="pg-track"><i></i><em></em></div><b></b>`));
    }
  }

  changed() {
    this.refresh();
    this.onChange && this.onChange(this.setup);
  }

  show() { this.root.classList.add('show'); this.drawMaps(); }
  hide() { this.root.classList.remove('show'); }

  drawMaps() {
    if (!this.root.classList.contains('show')) return;
    document.querySelectorAll('#pg-tracks .pg-card').forEach(b => drawOutline(b.querySelector('canvas'), b.dataset.id));
  }

  setCustom(custom) { this.custom = custom; this.stockPerf = {}; this.refresh(); }

  refresh() {
    const s = this.setup, carId = s.car, car = CARS[carId], tune = s.tunes[carId];
    document.querySelectorAll('#pg-tracks .pg-card').forEach(b => b.classList.toggle('on', b.dataset.id === s.track));
    document.querySelectorAll('#pg-cars .pg-card').forEach(b => b.classList.toggle('on', b.dataset.id === carId));
    $('pg-track-blurb').textContent = TRACKS[s.track].blurb;
    $('pg-car-blurb').textContent = car.blurb;
    $('pg-tune-car').textContent = car.short;
    document.querySelectorAll('#pg-tunes button').forEach(b => {
      b.classList.toggle('on', tune[b.dataset.k] === b.dataset.v);
      if (b.dataset.k === 'turbo' && b.dataset.v === 'tt') b.textContent = car.tt.label || 'Twin turbo';
    });
    const hints = {
      turbo: tune.turbo === 'tt' ? (car.build.induction === 'turbo' ? 'More boost: more power, a little more lag' : 'Turbo conversion: big power up top, some lag') : 'Factory induction',
      final: { short: 'Quicker in every gear, lower top speed', stock: 'Factory ratio', long: 'Higher top speed, softer pull' }[tune.final],
      tires: tune.tires === 'slicks' ? 'Massive grip and traction, later braking' : 'Lower grip: easier to slide and drift',
      susp: tune.susp === 'lowered' ? 'Sits 45 mm lower: low CG, far less roll' : 'Factory ride height',
    };
    document.querySelectorAll('#pg-tunes .pg-tune').forEach((row, i) => { row.querySelector('.pg-hint').textContent = hints[Object.keys(TUNES)[i]]; });

    const { spec, engine, build } = carSpec(carId, tune, this.custom);
    const p = performance(spec, engine);
    if (!this.stockPerf[carId]) {
      const st = carSpec(carId, TUNE_DEFAULT, this.custom);
      this.stockPerf[carId] = performance(st.spec, st.engine);
    }
    const sp = this.stockPerf[carId];
    const vals = {
      hp: `${Math.round(p.hp)} hp`,
      accel: p.t100 ? `0–100 ${p.t100.toFixed(1)} s` : '—',
      top: `${Math.round(p.top)} km/h`,
      grip: `${p.grip.toFixed(2)} g`,
    };
    for (const k of Object.keys(vals)) {
      const row = document.querySelector(`.bar-${k}`);
      row.querySelector('i').style.width = `${(p.bars[k] * 100).toFixed(1)}%`;
      row.querySelector('em').style.left = `${(sp.bars[k] * 100).toFixed(1)}%`;
      row.querySelector('b').textContent = vals[k];
      const d = p.bars[k] - sp.bars[k];
      row.classList.toggle('up', d > 0.004);
      row.classList.toggle('down', d < -0.004);
    }
    $('pg-stats').innerHTML = [
      `<span class="chip">${carSummary(carId, engine, build)}</span>`,
      `<span>¼ mile <b>${p.quarter ? p.quarter.t.toFixed(2) : '—'} s</b></span>`,
      `<span>torque <b>${Math.round(p.torque)} Nm</b></span>`,
      `<span>weight <b>${Math.round(spec.mass)} kg</b></span>`,
    ].join('');
    $('pg-engine').style.display = car.custom ? '' : 'none';
    $('pg-race').textContent = `RACE ▶`;
    this.spec = spec;
  }
}
