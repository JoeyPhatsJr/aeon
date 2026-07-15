// sim/abiogenesis.js
// Abiogenesis (§B) — abstracted but principled. The world begins lifeless and molten. Only
// once oceans condense (liquid water) can life spark. Each tick we roll for the emergence of a
// first replicator in cells that are simultaneously energy-rich AND chemistry-rich:
// hydrothermal vents (deep ocean floor over young/rifting crust), tidal pools (warm coastal
// shallows), and volcanic margins. Probability rises with local energy·chemistry and is
// seed-dependent, so some worlds spark life early, some late, a rare few barely at all. A
// lifeless world is still a valid, interesting geology-and-climate toy running to stellar death.

const YEAR = 365.25 * 24 * 3600;

// Returns a cell index where life emerged this tick, or -1.
export function rollAbiogenesis(world, dtSim) {
  // Require condensed oceans and a settled young star.
  if (!world._milestones.has('oceans_condense')) return -1;
  if (world.simSeconds < world.star.accretionTime) return -1;

  const years = dtSim / YEAR;
  const rng = world.rngAbio;

  // Sample a handful of candidate cells per tick (cheap; scales emergence with warp via years).
  const samples = 12;
  for (let s = 0; s < samples; s++) {
    const x = rng.int(world.W);
    const y = rng.int(world.H);
    const i = y * world.W + x;
    const suitability = cellSuitability(world, i);
    if (suitability <= 0) continue;

    // Per-year emergence probability; tiny, so life takes an evolutionarily plausible while.
    // Scaled by years-per-tick so high warp does not make it impossible to observe.
    const pPerYear = 2.5e-8 * suitability;
    const p = 1 - Math.pow(1 - pPerYear, Math.min(1e6, years * (1 / samples)));
    if (rng.float01() < p) return i;
  }
  return -1;
}

// Energy·chemistry suitability of a cell for abiogenesis, in [0, ~3].
function cellSuitability(world, i) {
  const depth = world.waterDepth[i];
  const temp = world.temperature[i];
  const nutrients = (world.nutrientN[i] + world.nutrientP[i] + world.nutrientMin[i]) / 3;

  // Must be liquid water in a habitable-ish range.
  if (depth <= 0) return 0;
  if (temp < 2 || temp > 90) return 0;

  let s = 0;
  // Hydrothermal vents: deep water over freshly rifted crust (crustAge near 0).
  if (depth > 0.4 && world.crustAge[i] < 5) s += 2.0;
  // Tidal pools: warm shallow coastal water.
  if (depth < 0.15 && temp > 15 && temp < 45) s += 1.5;
  // Volcanic margins: high local elevation gradient near water (proxy: shallow near steep).
  if (depth < 0.3 && world.elevation[i] > world.seaLevel - 0.5) s += 0.6;
  // Chemistry: nutrient richness helps everywhere.
  s *= (0.5 + nutrients);
  return s;
}
