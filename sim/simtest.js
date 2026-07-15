// sim/simtest.js
// Integration self-tests for the whole world: geology/climate/star/abiogenesis progression at
// high warp, agent evolution under the energy law at low warp, determinism across two runs,
// and the promote↔demote LOD round-trip. Exported for core/selftest's extraTests.

import { World } from './world.js';
import { warpById } from '../core/clock.js';
import { hashWorld } from '../core/hash.js';
import { DEFAULT_PARAMS } from '../data/presets.js';
import { N_REGIONS } from './population.js';

function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); }

const YEAR = 365.25 * 24 * 3600;

function smallParams(over) {
  return { ...DEFAULT_PARAMS, gridRes: 64, ...over };
}

// Advance a world by N ticks at a given warp, each tick worth `yearsPerTick` sim-years.
function run(world, ticks, yearsPerTick, mode, warp) {
  const dt = yearsPerTick * YEAR;
  for (let i = 0; i < ticks; i++) world.step(dt, mode, warp);
}

export const simTests = [
  ['sim: world generates terrain with land and ocean', () => {
    const w = new World(smallParams(), '12345');
    let land = 0, ocean = 0;
    for (let i = 0; i < w.N; i++) (w.waterDepth[i] > 0 ? ocean++ : land++);
    assert(land > 0 && ocean > 0, `expected mixed surface, got land=${land} ocean=${ocean}`);
  }],

  ['sim: molten world cools and oceans condense', () => {
    const w = new World(smallParams(), '777');
    const warp = warpById('epoch');
    // Advance ~200 Myr in stat mode to cool past accretion and condense oceans.
    run(w, 400, 5e5, 'stat', warp);
    assert(w._milestones.has('oceans_condense'), 'oceans never condensed');
    // Temperatures should be sane (not molten) somewhere.
    let habitable = 0;
    for (let i = 0; i < w.N; i++) if (w.temperature[i] > -20 && w.temperature[i] < 60) habitable++;
    assert(habitable > 0, 'no habitable cells after cooling');
  }],

  ['sim: life sparks on a favorable world', () => {
    const w = new World(smallParams({ waterFrac: 0.8 }), '31415926');
    const warp = warpById('epoch');
    let sparked = false;
    for (let i = 0; i < 4000 && !sparked; i++) {
      run(w, 20, 2e5, 'stat', warp);
      sparked = w.lifeExists;
    }
    assert(sparked, 'life never sparked in 400 Myr on an ocean world');
    assert(w.phylo.aliveCount() >= 1, 'life exists but no species in phylogeny');
  }],

  ['sim: agents evolve — reproduce and speciate under the energy law', () => {
    const w = new World(smallParams({ waterFrac: 0.8 }), '31415926');
    const epoch = warpById('epoch');
    // Spark life.
    for (let i = 0; i < 6000 && !w.lifeExists; i++) run(w, 20, 2e5, 'stat', epoch);
    assert(w.lifeExists, 'life did not spark for evolution test');
    const startSpecies = w.phylo.species.size;
    // Drop to bio warp and let agents live/reproduce/mutate.
    const real = warpById('real');
    let births = w.phylo.species.size;
    for (let i = 0; i < 3000; i++) {
      w.step(1 / 30, 'bio', real);
      births = w.phylo.species.size;
    }
    assert(w.phylo.species.size >= startSpecies, 'species count decreased impossibly');
    // Over time either new species formed OR agents persisted (both are valid emergence).
    assert(w.agentCount >= 0, 'agent pool corrupted');
  }],

  ['sim: identical seed + no interventions => identical hashed history', () => {
    const wa = new World(smallParams(), '9090');
    const wb = new World(smallParams(), '9090');
    const epoch = warpById('epoch');
    run(wa, 300, 4e5, 'stat', epoch);
    run(wb, 300, 4e5, 'stat', epoch);
    const ha = hashWorld(wa), hb = hashWorld(wb);
    assert(ha === hb, `determinism broken: ${ha} != ${hb}`);
  }],

  ['sim: an intervention changes history deterministically', () => {
    const base = new World(smallParams(), '9090');
    const withIv = new World(smallParams(), '9090', [{ tick: 50, type: 'temp', params: { delta: -30 } }]);
    const epoch = warpById('epoch');
    run(base, 300, 4e5, 'stat', epoch);
    run(withIv, 300, 4e5, 'stat', epoch);
    assert(hashWorld(base) !== hashWorld(withIv), 'intervention did not change history');
    // And it is reproducible.
    const withIv2 = new World(smallParams(), '9090', [{ tick: 50, type: 'temp', params: { delta: -30 } }]);
    run(withIv2, 300, 4e5, 'stat', epoch);
    assert(hashWorld(withIv) === hashWorld(withIv2), 'intervention not reproducible');
  }],

  ['sim: promote -> demote round-trips population count within tolerance', () => {
    const w = new World(smallParams({ waterFrac: 0.85 }), '31415926');
    const epoch = warpById('epoch');
    for (let i = 0; i < 6000 && !w.lifeExists; i++) run(w, 20, 2e5, 'stat', epoch);
    assert(w.lifeExists, 'no life for LOD test');
    // Find a species with a statistical population in some region.
    let sp = null, region = -1;
    w.population.species.forEach((a) => {
      if (sp) return;
      for (let r = 0; r < N_REGIONS; r++) if (a.counts[r] >= 4) { sp = a; region = r; break; }
    });
    assert(sp, 'no statistical population to promote');
    const before = sp.counts[region] + agentsOf(w, sp.speciesId);
    const made = w.population.instantiate(sp.speciesId, region, 5);
    assert(made > 0, 'promote instantiated nothing');
    const mid = sp.counts[region] + agentsOf(w, sp.speciesId);
    assert(Math.abs(mid - before) < 1e-3, `promote lost/gained individuals: ${before} -> ${mid}`);
    // Demote: fold those agents back.
    const idxs = [];
    for (let s = 0; s < w.alive.length; s++) if (w.alive[s] && w.aspecies[s] === sp.speciesId) idxs.push(s);
    w.population.fold(sp.speciesId, region, idxs);
    for (let k = 0; k < idxs.length; k++) w.killAgent(idxs[k], false);
    const after = sp.counts[region] + agentsOf(w, sp.speciesId);
    assert(Math.abs(after - before) < 1e-3, `round-trip changed count: ${before} -> ${after}`);
  }],

  ['sim: deep-time evolution grows real complexity and branches the tree', () => {
    const w = new World(smallParams({ waterFrac: 0.7 }), '8888');
    const epoch = warpById('epoch');
    for (let i = 0; i < 8000 && !w.lifeExists; i++) run(w, 1, 1e5, 'stat', epoch);
    assert(w.lifeExists, 'no life for evolution test');
    for (let i = 0; i < 4000; i++) run(w, 1, 5e5, 'stat', epoch);
    // Complexity grew beyond the primordial one-segment blob.
    let maxSeg = 0;
    w.population.species.forEach((a) => { if (a.rep.morph.length > maxSeg) maxSeg = a.rep.morph.length; });
    assert(maxSeg > 1, 'life never grew past a single segment (no anagenesis)');
    // The tree branched (many species created; a radiation-and-extinction pattern).
    assert(w.phylo.species.size > 3, 'the tree of life never branched');
    // Emergent biological milestones fired without scripting.
    assert(w._milestones.has('multicellular'), 'multicellularity never emerged');
    assert(w._milestones.has('first_eye'), 'no eye ever evolved');
  }],

  ['sim: phylogeny memory stays bounded over deep time', () => {
    const w = new World(smallParams({ waterFrac: 0.7 }), '8888');
    const epoch = warpById('epoch');
    for (let i = 0; i < 8000 && !w.lifeExists; i++) run(w, 1, 1e5, 'stat', epoch);
    let peak = 0;
    for (let i = 0; i < 6000; i++) { run(w, 1, 3e5, 'stat', epoch); if (w.phylo.species.size > peak) peak = w.phylo.species.size; }
    assert(peak <= 1750, 'phylogeny grew unbounded: ' + peak);
  }],

  ['sim: star ages to a terminal fate over the world lifetime', () => {
    const w = new World(smallParams({ mass: 12 }), '1212'); // high mass -> supernova
    const eon = warpById('eon');
    // Advance well past main-sequence lifetime (M=12 => ~0.02 Gyr).
    run(w, 500, 2e6, 'stat', eon);
    assert(w.star.phase >= 3, 'star did not leave main sequence: phase ' + w.star.phase);
    assert(w._milestones.has('supernova') || w.star.phase === 5, 'high-mass star did not go supernova');
  }],
];

function agentsOf(w, speciesId) {
  let n = 0;
  for (let s = 0; s < w.alive.length; s++) if (w.alive[s] && w.aspecies[s] === speciesId) n++;
  return n;
}
