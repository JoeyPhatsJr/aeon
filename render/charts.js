// render/charts.js
// Lightweight 2D-canvas charts for the panels: population time-series, atmosphere composition,
// biodiversity. Each chart also produces a text-equivalent summary string so the UI can expose
// an aria-label / visually-hidden data table (no chart is color-only).

export function drawSparkline(ctx, x, y, w, h, series, color, opts = {}) {
  if (!series || series.length < 2) return;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < series.length; i++) { const v = series[i]; if (v < min) min = v; if (v > max) max = v; }
  if (opts.min !== undefined) min = opts.min;
  if (opts.max !== undefined) max = opts.max;
  const range = max - min || 1;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const px = x + (i / (series.length - 1)) * w;
    const py = y + h - ((series[i] - min) / range) * h;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (opts.fill) {
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle = opts.fill; ctx.fill();
  }
}

// Draw stacked population-by-trophic-role bands over time. `bands` = [{color, series[]}].
export function drawStack(ctx, x, y, w, h, bands, maxTotal) {
  const len = bands[0] ? bands[0].series.length : 0;
  if (len < 2) return;
  const bottoms = new Float32Array(len);
  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi];
    ctx.fillStyle = band.color;
    ctx.beginPath();
    // Top edge left->right.
    for (let i = 0; i < len; i++) {
      const px = x + (i / (len - 1)) * w;
      const top = bottoms[i] + band.series[i];
      const py = y + h - (top / maxTotal) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    // Bottom edge right->left.
    for (let i = len - 1; i >= 0; i--) {
      const px = x + (i / (len - 1)) * w;
      const py = y + h - (bottoms[i] / maxTotal) * h;
      ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    for (let i = 0; i < len; i++) bottoms[i] += band.series[i];
  }
}

export function summarizeSeries(name, series) {
  if (!series || series.length === 0) return `${name}: no data`;
  const last = series[series.length - 1];
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < series.length; i++) { if (series[i] < min) min = series[i]; if (series[i] > max) max = series[i]; }
  const trend = series.length > 1 ? (series[series.length - 1] - series[0] > 0 ? 'rising' : 'falling') : 'flat';
  return `${name}: currently ${fmt(last)}, ranging ${fmt(min)}–${fmt(max)}, ${trend}`;
}

function fmt(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(v < 10 ? 2 : 0);
}
