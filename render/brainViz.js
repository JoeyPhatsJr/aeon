// render/brainViz.js
// Live visualization of a selected organism's brain: nodes light as they fire, edges weighted
// by connection strength (green excitatory, red inhibitory). Layout is layered — inputs on the
// left, outputs on the right, hidden nodes in between — computed once per brain topology and
// cached. The worker sends the current activation vector each frame.

import { hsv2rgb } from './organismRenderer.js';

export class BrainViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._layout = null;
    this._topoKey = '';
  }

  // brain = { nodes:[{id,kind}], edges:[{from,to,weight}], inputIdx, outputIdx } (indices into
  // nodes). activations = Float32Array aligned to nodes. kind: 0 in,1 hidden,2 out,3 bias.
  render(brain, activations) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!brain || !brain.nodes || brain.nodes.length === 0) {
      ctx.fillStyle = 'rgba(147,161,182,0.6)';
      ctx.font = '12px monospace';
      ctx.fillText('no brain selected', 12, 20);
      return;
    }
    const key = brain.nodes.length + ':' + brain.edges.length;
    if (key !== this._topoKey) { this._layout = this._computeLayout(brain, w, h); this._topoKey = key; }
    const pos = this._layout;

    // Edges.
    for (let e = 0; e < brain.edges.length; e++) {
      const ed = brain.edges[e];
      const a = pos[ed.from], b = pos[ed.to];
      if (!a || !b) continue;
      const wgt = ed.weight;
      const act = activations ? Math.abs(activations[ed.from]) : 0.3;
      const alpha = 0.1 + 0.6 * Math.min(1, act);
      ctx.strokeStyle = wgt >= 0 ? `rgba(87,224,138,${alpha})` : `rgba(255,93,93,${alpha})`;
      ctx.lineWidth = Math.min(3, 0.4 + Math.abs(wgt) * 0.6);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Nodes.
    for (let i = 0; i < brain.nodes.length; i++) {
      const p = pos[i];
      if (!p) continue;
      const act = activations ? activations[i] : 0;
      const mag = Math.min(1, Math.abs(act));
      const [r, g, bl] = act >= 0 ? hsv2rgb(0.33, 0.7, 0.4 + 0.6 * mag) : hsv2rgb(0.02, 0.7, 0.4 + 0.6 * mag);
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 + 3 * mag, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  _computeLayout(brain, w, h) {
    const pad = 18;
    const cols = { 0: [], 1: [], 2: [], 3: [] }; // in, hidden, out, bias
    for (let i = 0; i < brain.nodes.length; i++) cols[brain.nodes[i].kind].push(i);
    const pos = new Array(brain.nodes.length);
    // x by kind: inputs+bias left, hidden middle, outputs right.
    const place = (arr, x) => {
      for (let k = 0; k < arr.length; k++) {
        const y = pad + (arr.length === 1 ? (h - 2 * pad) / 2 : (k / (arr.length - 1)) * (h - 2 * pad));
        pos[arr[k]] = { x, y };
      }
    };
    place(cols[0].concat(cols[3]), pad + 8);
    place(cols[1], w / 2);
    place(cols[2], w - pad - 8);
    return pos;
  }
}
