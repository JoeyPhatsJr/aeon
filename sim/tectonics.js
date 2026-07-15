// sim/tectonics.js
// Terrain generation + plate tectonics (Appendix H). We model 6–12 plates with velocity
// vectors. Cells belong to the nearest plate seed; plates drift (advecting their crust); at
// convergent boundaries mountains rise (uplift ∝ convergence), at divergent boundaries young
// ocean crust forms, transform boundaries shear. Volcanism injects CO2 and can trigger local
// extinction pulses. Continents must visibly rearrange over mega-year timescales.

import { EV } from '../core/events.js';

// Value-noise helpers for initial terrain (deterministic via world.rngGeology).
function fractalNoise(world, x, y, octaves, freq, seedGrid) {
  let amp = 1, sum = 0, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * sampleValueNoise(x * f, y * f, world.W, seedGrid);
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

function sampleValueNoise(x, y, W, grid) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const gx = grid.size;
  const h = (ix, iy) => grid.data[((iy % gx) + gx) % gx * gx + (((ix % gx) + gx) % gx)];
  const sx = x - x0, sy = y - y0;
  const n00 = h(x0, y0), n10 = h(x0 + 1, y0), n01 = h(x0, y0 + 1), n11 = h(x0 + 1, y0 + 1);
  const u = sx * sx * (3 - 2 * sx), v = sy * sy * (3 - 2 * sy);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

export function generateTerrain(world) {
  const rng = world.rngGeology;
  const W = world.W, H = world.H;

  // Random noise grid for value noise.
  const gsize = 32;
  const grid = { size: gsize, data: new Float32Array(gsize * gsize) };
  for (let i = 0; i < grid.data.length; i++) grid.data[i] = rng.float01() * 2 - 1;

  // Plates: 6–12 seeds with velocities (cells/My).
  const nPlates = 6 + rng.int(7);
  world.plates = [];
  for (let p = 0; p < nPlates; p++) {
    world.plates.push({
      x: rng.range(0, W), y: rng.range(0, H),
      vx: rng.range(-0.6, 0.6), vy: rng.range(-0.4, 0.4),
      oceanic: rng.bool(0.55),
    });
  }

  // Assign cells to nearest plate (wrap-aware in x) and set base elevation.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let best = 0, bestD = Infinity;
      for (let p = 0; p < world.plates.length; p++) {
        let dx = world.plates[p].x - x; if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        const dy = world.plates[p].y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      world.plateId[i] = best;
      const cont = world.plates[best].oceanic ? -0.6 : 0.5;
      const n = fractalNoise(world, x, y, 5, 0.06, grid);
      world.elevation[i] = cont + n * 1.6;
      world.crustAge[i] = rng.range(0, 200);
    }
  }

  // Sea level from water fraction: pick the elevation quantile that submerges waterFrac cells.
  const sorted = Float32Array.from(world.elevation).sort();
  const seaLevel = sorted[Math.floor(world.params.waterFrac * (sorted.length - 1))];
  world.seaLevel = seaLevel;
  for (let i = 0; i < world.N; i++) {
    const depth = seaLevel - world.elevation[i];
    world.waterDepth[i] = depth > 0 ? depth : 0;
    // Molten start: whole world hot; cools during accretion (climate/star handle the decline).
    world.temperature[i] = 800; // °C, molten
    world.soilMoisture[i] = world.waterDepth[i] > 0 ? 1 : 0.3;
    world.nutrientN[i] = 0.5; world.nutrientP[i] = 0.5; world.nutrientMin[i] = 0.5;
    world.o2[i] = world.params.o2_0;
    world.co2[i] = world.params.co2_0;
  }
}

// Advance plates and reshape crust. `dtSim` is in seconds; convert to My for plate motion.
export function stepTectonics(world, dtSim) {
  const My = dtSim / (1e6 * 365.25 * 24 * 3600);
  if (My <= 0) return;
  const W = world.W, H = world.H;

  // Move plate seeds.
  for (let p = 0; p < world.plates.length; p++) {
    world.plates[p].x = ((world.plates[p].x + world.plates[p].vx * My) % W + W) % W;
    world.plates[p].y = Math.max(0, Math.min(H - 1, world.plates[p].y + world.plates[p].vy * My));
  }

  // Reassign cells to nearest plate periodically (cheap flood via nearest-seed).
  // Uplift/rift at boundaries: compare a cell's plate velocity to its neighbor's.
  let volcanism = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Nearest plate.
      let best = 0, bestD = Infinity;
      for (let p = 0; p < world.plates.length; p++) {
        let dx = world.plates[p].x - x; if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        const dy = world.plates[p].y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      const prev = world.plateId[i];
      world.plateId[i] = best;
      world.crustAge[i] += My;

      if (prev !== best) {
        // At a boundary: relative normal velocity of the two plates.
        const a = world.plates[prev], b = world.plates[best];
        const relVx = a.vx - b.vx, relVy = a.vy - b.vy;
        const conv = -(relVx + relVy); // crude convergence proxy
        if (conv > 0) {
          world.elevation[i] += 0.02 * conv * My * 1e3; // uplift
          if (world.rngGeology.bool(0.02)) volcanism++;
        } else {
          world.elevation[i] -= 0.01 * My * 1e3; // rift -> new ocean crust
          world.crustAge[i] = 0;
        }
      }
    }
  }

  // Volcanism injects CO2.
  if (volcanism > 0) {
    world.atmosphere.co2 += volcanism * 0.0008 * My;
  }

  // Recompute water depth against the (fixed) sea level.
  for (let i = 0; i < world.N; i++) {
    const depth = world.seaLevel - world.elevation[i];
    world.waterDepth[i] = depth > 0 ? depth : 0;
  }
  void EV;
}
