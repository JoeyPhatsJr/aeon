// ui/inspector.js
// The organism/species inspector: decodes a selected agent's genome into readable traits, shows
// its energy budget, lineage, and a live brain visualization (nodes firing). Fed by the sim's
// per-frame `selected` payload. No per-organism DOM churn — one static structure updated in place.

import { BrainViz } from '../render/brainViz.js';

export class Inspector {
  constructor(panelEl) {
    this.panel = panelEl;
    this._build();
    this.brainViz = new BrainViz(this.brainCanvas);
    this.current = null;
  }

  _build() {
    this.panel.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = 'Life';
    this.panel.appendChild(h);

    this.empty = document.createElement('p');
    this.empty.className = 'muted';
    this.empty.textContent = 'Click an organism on the map to inspect its body, brain, and lineage. The Tree of Life is below.';
    this.panel.appendChild(this.empty);

    this.body = document.createElement('div');
    this.body.hidden = true;
    this.panel.appendChild(this.body);

    this.nameEl = document.createElement('div');
    this.nameEl.style.cssText = 'font-size:var(--fs-lg);';
    this.etymEl = document.createElement('div');
    this.etymEl.className = 'muted';
    this.etymEl.style.cssText = 'font-style:italic;margin-bottom:8px;font-size:var(--fs-sm);';
    this.traits = document.createElement('div');
    this.traits.className = 'num';
    this.traits.style.cssText = 'font-size:var(--fs-sm);line-height:1.7;';

    const brainH = document.createElement('h3'); brainH.textContent = 'Brain (live)';
    this.brainCanvas = document.createElement('canvas');
    this.brainCanvas.width = 340; this.brainCanvas.height = 160;
    this.brainCanvas.style.cssText = 'width:100%;height:auto;background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius-sm);';

    this.body.appendChild(this.nameEl);
    this.body.appendChild(this.etymEl);
    this.body.appendChild(this.traits);
    this.body.appendChild(brainH);
    this.body.appendChild(this.brainCanvas);
  }

  update(selected) {
    this.current = selected;
    if (!selected) {
      this.empty.hidden = false; this.body.hidden = true;
      this.brainViz.render(null, null);
      return;
    }
    this.empty.hidden = true; this.body.hidden = false;
    this.nameEl.innerHTML = `<em>${escapeHtml(selected.name)}</em>`;
    this.etymEl.textContent = selected.etymology || '';
    const roleName = { auto: 'Autotroph', herb: 'Herbivore', pred: 'Predator', decomp: 'Decomposer', omni: 'Omnivore' }[selected.trophic] || selected.trophic;
    this.traits.innerHTML = row('Realized role', roleName) +
      row('Energy', selected.energy.toFixed(2)) +
      row('Age', selected.age.toFixed(0) + ' / ' + selected.maxLifespan.toFixed(0)) +
      row('Body mass', selected.mass.toFixed(2)) +
      row('Segments', selected.segments) +
      row('Generation', selected.generation) +
      row('Brain', selected.brainNodes + ' nodes, ' + selected.brainConns + ' links') +
      row('Photosynthesis', selected.photoCap.toFixed(2)) +
      row('Digestion', selected.digestCap.toFixed(2));
    this.brainViz.render(selected.brain, selected.activations);
  }
}

function row(label, val) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;"><span class="muted">${label}</span><span>${val}</span></div>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
