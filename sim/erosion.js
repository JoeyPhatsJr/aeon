// sim/erosion.js
// Hydraulic erosion (Appendix H). A cheap flow-accumulation pass estimates upstream drainage
// area A per cell; stream-power lowers high terrain (Δelev = −k_e·A^m·S^n), deposits sediment
// downslope, and carves river cells where accumulated flow exceeds a threshold — feeding the
// water/moisture/nutrient fields. Over mega-years this counteracts tectonic uplift and creates
// the drainage networks that route moisture inland.

const M = 0.5, N_EXP = 1.0, K_E = 0.0006;

export function stepErosion(world, dtSim) {
  const My = dtSim / (1e6 * 365.25 * 24 * 3600);
  if (My <= 0) return;
  const W = world.W, H = world.H;
  const NN = world.N;

  // Flow accumulation: each land cell contributes 1 unit of rain, routed to its steepest
  // lower neighbor. Process cells in descending elevation order so upstream flows before
  // downstream (single-pass D8 accumulation).
  const order = world._eroOrder || (world._eroOrder = new Int32Array(NN));
  for (let i = 0; i < NN; i++) order[i] = i;
  // Insertion into an index array sorted by elevation desc. Array.prototype.sort is stable
  // enough here and only runs at geologic warp (infrequent).
  const elev = world.elevation;
  const idxArr = Array.from(order);
  idxArr.sort((a, b) => elev[b] - elev[a]);

  const flow = world._eroFlow || (world._eroFlow = new Float32Array(NN));
  for (let i = 0; i < NN; i++) flow[i] = world.waterDepth[i] > 0 ? 0 : world.soilMoisture[i];

  for (let k = 0; k < idxArr.length; k++) {
    const i = idxArr[k];
    if (world.waterDepth[i] > 0) continue; // rivers form on land
    const x = i % W, y = (i / W) | 0;
    // Find steepest-descent neighbor (D8, wrap x).
    let bestJ = -1, bestDrop = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = ((x + dx) % W + W) % W;
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        const drop = elev[i] - elev[j];
        if (drop > bestDrop) { bestDrop = drop; bestJ = j; }
      }
    }
    if (bestJ >= 0) {
      flow[bestJ] += flow[i];
      const slope = Math.max(1e-3, bestDrop);
      const erode = K_E * Math.pow(flow[i], M) * Math.pow(slope, N_EXP) * My;
      const cut = Math.min(erode, 0.3);
      world.elevation[i] -= cut;
      world.elevation[bestJ] += cut * 0.5; // deposit half downstream
      // Carve river: mark high-flow land cells as moist and nutrient-rich.
      if (flow[i] > 6) {
        world.soilMoisture[i] = Math.min(1, world.soilMoisture[i] + 0.2);
        world.nutrientN[i] = Math.min(1, world.nutrientN[i] + 0.05 * My);
      }
    }
  }
}
