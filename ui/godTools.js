// ui/godTools.js
// The intervention palette. Each button posts a deterministic intervention to the sim, which
// appends it to the intervention log (so it travels in the save/URL and replays identically).
// Interventions: temperature, sea level, CO2/O2, meteor, ice age, mutation burst, and the
// selected-species protect/cull. "Breed champions" is offered when two organisms are selected.

export class GodTools {
  constructor(panelEl, post) {
    this.panel = panelEl;
    this.post = post; // (ivType, params) => void
    this._build();
  }

  _build() {
    this.panel.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = 'God';
    this.panel.appendChild(h);
    const note = document.createElement('p'); note.className = 'muted';
    note.style.fontSize = 'var(--fs-sm)';
    note.textContent = 'Every intervention is recorded and travels in the shareable world — the history stays reproducible.';
    this.panel.appendChild(note);

    this._group('Climate', [
      ['Warm +4°C', () => this.post('temp', { delta: 4 })],
      ['Cool −4°C', () => this.post('temp', { delta: -4 })],
      ['Ice age', () => this.post('iceage', {})],
      ['Raise sea +0.3', () => this.post('sealevel', { delta: 0.3 })],
      ['Lower sea −0.3', () => this.post('sealevel', { delta: -0.3 })],
    ]);
    this._group('Atmosphere', [
      ['CO₂ +0.2', () => this.post('co2', { delta: 0.2 })],
      ['CO₂ −0.2', () => this.post('co2', { delta: -0.2 })],
      ['O₂ +0.1', () => this.post('o2', { delta: 0.1 })],
    ]);
    this._group('Catastrophe', [
      ['Regional meteor', () => this.post('meteor', { size: 1 })],
      ['Extinction-scale impact', () => this.post('meteor', { size: 3 })],
      ['Mutation burst', () => this.post('mutationburst', { factor: 3 })],
    ]);

    // Selected-species actions (filled/enabled by main when a species is selected).
    const spH = document.createElement('h3'); spH.textContent = 'Selected species';
    this.panel.appendChild(spH);
    this.selRow = document.createElement('div');
    this.selRow.className = 'muted'; this.selRow.style.fontSize = 'var(--fs-sm)';
    this.selRow.textContent = 'Select an organism to protect, cull, or breed.';
    this.panel.appendChild(this.selRow);
  }

  _group(title, buttons) {
    const h = document.createElement('h3'); h.textContent = title;
    this.panel.appendChild(h);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (let i = 0; i < buttons.length; i++) {
      const [label, fn] = buttons[i];
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;cursor:pointer;font-family:inherit;font-size:var(--fs-sm);';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    this.panel.appendChild(wrap);
  }

  setSelected(speciesId, name) {
    this.selRow.innerHTML = '';
    if (speciesId == null || speciesId < 0) {
      this.selRow.className = 'muted'; this.selRow.style.fontSize = 'var(--fs-sm)';
      this.selRow.textContent = 'Select an organism to protect, cull, or breed.';
      return;
    }
    const label = document.createElement('div');
    label.style.cssText = 'margin-bottom:6px;font-size:var(--fs-sm);';
    label.textContent = name || ('species ' + speciesId);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;';
    const mk = (t, fn, danger) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = `background:${danger ? 'var(--accent-danger)' : 'var(--panel-2)'};color:${danger ? '#fff' : 'var(--ink)'};border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;cursor:pointer;font-family:inherit;font-size:var(--fs-sm);`; b.addEventListener('click', fn); return b; };
    wrap.appendChild(mk('Protect', () => this.post('protect', { speciesId })));
    wrap.appendChild(mk('Cull', () => this.post('cull', { speciesId }), true));
    this.selRow.appendChild(label);
    this.selRow.appendChild(wrap);
  }
}
