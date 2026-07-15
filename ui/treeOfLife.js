// ui/treeOfLife.js
// The Tree of Life: an interactive phylogenetic tree that grows across the run. Time runs down
// the y-axis (birth tick -> now); branch thickness ∝ population, color ∝ trophic role. Extinct
// branches are greyed. Rendered on a 2D canvas inside the Life panel; clicking a branch selects
// that species (highlighting it on the map). Fed a compact species list by the sim.

const ROLE_COLOR = { auto: '#57e08a', herb: '#ffd166', pred: '#ff5d5d', decomp: '#b18cff', omni: '#f2994a' };

export class TreeOfLife {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.species = [];
    this.nowTick = 1;
    this.showExtinct = true;
    this._layout = [];
    canvas.addEventListener('click', (e) => this._onClick(e));
  }

  setData(species, nowTick) {
    this.species = species || [];
    this.nowTick = Math.max(1, nowTick || 1);
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.species.length === 0) {
      ctx.fillStyle = 'rgba(147,161,182,0.6)'; ctx.font = '12px monospace';
      ctx.fillText('no lineages yet', 10, 20);
      return;
    }
    // Assign each species an x column by a stable depth-first order; y by tick range.
    const byId = new Map(this.species.map((s) => [s.id, s]));
    const roots = this.species.filter((s) => s.parentId < 0 || !byId.has(s.parentId));
    const cols = [];
    const order = [];
    const visit = (s) => {
      order.push(s);
      const kids = this.species.filter((c) => c.parentId === s.id);
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    for (let i = 0; i < roots.length; i++) visit(roots[i]);
    const visible = order.filter((s) => this.showExtinct || s.deathTick < 0);
    this._layout = [];

    const pad = 16;
    const colW = Math.max(6, (W - 2 * pad) / Math.max(1, visible.length));
    const xOf = new Map();
    visible.forEach((s, i) => xOf.set(s.id, pad + i * colW + colW / 2));
    const yOf = (tick) => pad + (tick / this.nowTick) * (H - 2 * pad);

    // Edges parent->child.
    ctx.strokeStyle = 'rgba(147,161,182,0.3)'; ctx.lineWidth = 1;
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      if (s.parentId >= 0 && xOf.has(s.parentId)) {
        const px = xOf.get(s.parentId), py = yOf(byId.get(s.parentId) ? byId.get(s.parentId).birthTick : 0);
        const cx = xOf.get(s.id), cy = yOf(s.birthTick);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, cy); ctx.stroke();
        void py;
      }
    }

    // Branches (birth -> death/now), thickness by population.
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      const x = xOf.get(s.id);
      const y0 = yOf(s.birthTick);
      const y1 = yOf(s.deathTick >= 0 ? s.deathTick : this.nowTick);
      const alive = s.deathTick < 0;
      const thick = Math.max(1.5, Math.min(8, Math.log(1 + (s.population || 1))));
      ctx.strokeStyle = alive ? (ROLE_COLOR[s.role] || '#9aa') : 'rgba(120,130,145,0.4)';
      ctx.lineWidth = thick;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      this._layout.push({ id: s.id, x, y0, y1, thick });
    }
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const sy = (e.clientY - rect.top) * (this.canvas.height / rect.height);
    let best = -1, bestD = 12;
    for (let i = 0; i < this._layout.length; i++) {
      const b = this._layout[i];
      if (sy < b.y0 - 4 || sy > b.y1 + 4) continue;
      const d = Math.abs(sx - b.x);
      if (d < bestD) { bestD = d; best = b.id; }
    }
    if (best >= 0 && this.onSelect) this.onSelect(best);
  }
}
