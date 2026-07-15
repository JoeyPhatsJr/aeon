// ui/newWorld.js
// The new-world dialog: seed (view/enter/randomize), stellar mass, water fraction, initial
// atmosphere (CO2/O2), axial tilt, world size, base mutation, and cognition cost. The estimated
// star lifetime updates live as the mass slider moves, so the player sees the mass reshape the
// whole timeline. Also lists curated starter seeds. Calls onCreate(seed, params).

import { PRESETS, DEFAULT_PARAMS, estimateStarLifetimeGyr, starFateLabel } from '../data/presets.js';
import { RNG } from '../core/rng.js';

export class NewWorld {
  constructor(onCreate) {
    this.onCreate = onCreate;
    this._build();
  }

  _build() {
    const overlay = document.createElement('div');
    overlay.id = 'newworld';
    overlay.style.cssText = 'position:fixed;inset:0;display:none;place-items:center;background:rgba(0,0,0,0.55);z-index:70;padding:16px;';
    overlay.innerHTML = `
      <div style="width:min(560px,96vw);max-height:92vh;overflow:auto;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;">
        <h2 style="margin:0 0 4px;font-size:var(--fs-xl);letter-spacing:0.1em;">AEON</h2>
        <p class="muted" style="margin:0 0 16px;">Shape a star and a world, then let it live.</p>
        <div id="nw-presets" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;"></div>
        <div id="nw-form" class="num" style="display:grid;gap:12px;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;flex-wrap:wrap;">
          <div id="nw-fate" class="muted num" style="font-size:var(--fs-sm);"></div>
          <button id="nw-create" style="background:var(--accent-life);color:#04120a;border:none;border-radius:var(--radius-sm);padding:10px 20px;font-family:inherit;font-weight:600;cursor:pointer;font-size:var(--fs-md);">Ignite</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    this.params = { ...DEFAULT_PARAMS };
    this.seed = '20260715';

    // Presets.
    const pres = overlay.querySelector('#nw-presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.title = p.teaser;
      b.style.cssText = 'background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;cursor:pointer;font-family:inherit;font-size:var(--fs-sm);';
      b.addEventListener('click', () => { this.params = { ...p.params }; this.seed = p.seed; this._syncForm(); });
      pres.appendChild(b);
    });

    // Form fields.
    const form = overlay.querySelector('#nw-form');
    this.fields = {};
    this._seedField(form);
    this._slider(form, 'mass', 'Stellar mass (M☉)', 0.5, 20, 0.1);
    this._slider(form, 'waterFrac', 'Water fraction', 0.2, 0.98, 0.01);
    this._slider(form, 'co2_0', 'Initial CO₂', 0.1, 1.5, 0.05);
    this._slider(form, 'o2_0', 'Initial O₂', 0, 0.3, 0.01);
    this._slider(form, 'tilt', 'Axial tilt (°)', 0, 45, 1);
    this._slider(form, 'gridRes', 'World size (grid)', 128, 384, 64);
    this._slider(form, 'baseMutation', 'Base mutation', 0.01, 0.2, 0.01);
    this._slider(form, 'cognitionCost', 'Cognition cost', 0.4, 2.0, 0.1);

    overlay.querySelector('#nw-create').addEventListener('click', () => this._create());
    this.fate = overlay.querySelector('#nw-fate');
    this._syncForm();
  }

  _seedField(form) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const label = document.createElement('label'); label.textContent = 'Seed'; label.className = 'muted'; label.style.minWidth = '120px';
    const input = document.createElement('input'); input.type = 'text'; input.value = this.seed;
    input.style.cssText = 'flex:1;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 8px;font-family:inherit;';
    input.addEventListener('input', () => { this.seed = input.value; });
    const rnd = document.createElement('button'); rnd.textContent = '⟳'; rnd.title = 'Randomize';
    rnd.style.cssText = 'background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 12px;cursor:pointer;';
    // Randomize deterministically from a rotating base (avoids Math.random in the sim; UI-only).
    let salt = 1;
    rnd.addEventListener('click', () => { const r = new RNG(BigInt(Date.now ? Date.now() : (salt++)) ^ BigInt(salt)); this.seed = String(r.nextU64() % 100000000n); input.value = this.seed; });
    wrap.appendChild(label); wrap.appendChild(input); wrap.appendChild(rnd);
    form.appendChild(wrap);
    this.fields.seed = input;
  }

  _slider(form, key, label, min, max, step) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const lab = document.createElement('label'); lab.textContent = label; lab.className = 'muted'; lab.style.minWidth = '120px'; lab.style.fontSize = 'var(--fs-sm)';
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.style.flex = '1';
    const val = document.createElement('span'); val.className = 'num'; val.style.minWidth = '48px'; val.style.textAlign = 'right';
    input.addEventListener('input', () => { this.params[key] = parseFloat(input.value); val.textContent = fmt(this.params[key]); this._updateFate(); });
    wrap.appendChild(lab); wrap.appendChild(input); wrap.appendChild(val);
    form.appendChild(wrap);
    this.fields[key] = { input, val };
  }

  _syncForm() {
    this.fields.seed.value = this.seed;
    for (const key of Object.keys(this.fields)) {
      if (key === 'seed') continue;
      this.fields[key].input.value = this.params[key];
      this.fields[key].val.textContent = fmt(this.params[key]);
    }
    this._updateFate();
  }

  _updateFate() {
    const gyr = estimateStarLifetimeGyr(this.params.mass);
    this.fate.textContent = `~${gyr.toFixed(2)} Gyr on the main sequence · ends in ${starFateLabel(this.params.mass)}`;
  }

  open() { this.overlay.style.display = 'grid'; }
  close() { this.overlay.style.display = 'none'; }

  _create() {
    this.close();
    this.params.gridRes = Math.round(this.params.gridRes / 64) * 64;
    this.onCreate(this.seed, { ...this.params });
  }
}

function fmt(v) { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2); }
