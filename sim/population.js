// sim/population.js
// The statistical representation of life (Appendix F, ARCHITECTURE §1.2). When a species is
// demoted (zoomed out or high warp), it lives here as per-region aggregates advanced by
// population-dynamics math instead of per-organism agents. A billion organisms cost a few
// dozen floats.
//
// dNi/dt = Ni·[ ri·(1 − Ni/Ki) + Σ_j a_ij·Nj ]   (multi-species Lotka–Volterra + logistic)
// plus mutation drift on the mean genome vector (grows variance; can split a species) and
// migration as diffusion of Ni between adjacent regions weighted by habitat suitability.
//
// This module also implements the LOD reconciliation contract:
//   fold(speciesId, region, agentIndices)  — demote: fold live agents into aggregates
//   instantiate(speciesId, region, count)  — promote: sample representative genomes -> agents
// so promote→demote round-trips a species' aggregate stats within tolerance.

import { genomeToVector, cloneGenome, LIFE_VEC_FIELDS, MORPH_VEC_FIELDS, clamp, hasPart, PART } from '../bio/genome.js';
import { biomeProductivity } from '../data/biomes.js';
import { reproduceAsexual } from '../bio/reproduction.js';
import { genomeDistance, COEF } from '../bio/speciation.js';
import { binomial, dominantTrait } from '../data/naming.js';
import { EV } from '../core/events.js';

export const REGION_W = 8, REGION_H = 4;
export const N_REGIONS = REGION_W * REGION_H;
export const MAX_STAT_SPECIES = 56; // bound the tree + per-tick cost

export class PopulationField {
  constructor(world) {
    this.world = world;
    this.species = new Map(); // speciesId -> aggregate
    this._speciationQueue = []; // buds to create after the step iteration (avoids mutating the Map mid-loop)
    this._extinctQueue = [];    // species to prune after the step iteration
  }

  regionOf(x, y) {
    const rx = Math.min(REGION_W - 1, ((x / this.world.W) * REGION_W) | 0);
    const ry = Math.min(REGION_H - 1, ((y / this.world.H) * REGION_H) | 0);
    return ry * REGION_W + rx;
  }

  ensure(speciesId, repGenome) {
    let a = this.species.get(speciesId);
    if (!a) {
      const vec = genomeToVector(repGenome);
      a = {
        speciesId,
        rep: cloneGenome(repGenome),
        originRep: cloneGenome(repGenome), // genome at species origin — divergence is measured from here
        counts: new Float32Array(N_REGIONS),
        meanVec: Float32Array.from(vec),
        variance: new Float32Array(vec.length),
        role: this._roleOf(repGenome),
        photoCap: repGenome.life.photoCap,
        digestCap: repGenome.life.digestCap,
        evolveClock: 0, // accumulates sim-years toward the next structural mutation
      };
      this.species.set(speciesId, a);
    }
    return a;
  }

  _roleOf(g) {
    if (g.life.digestCap > g.life.photoCap * 1.3) return 'pred';
    if (g.life.photoCap > 0.5) return 'auto';
    return 'herb';
  }

  totalPopulation() {
    let t = 0;
    this.species.forEach((a) => { for (let r = 0; r < N_REGIONS; r++) t += a.counts[r]; });
    return t;
  }

  photoBiomass() {
    let b = 0;
    this.species.forEach((a) => {
      if (a.role === 'auto') { let c = 0; for (let r = 0; r < N_REGIONS; r++) c += a.counts[r]; b += c * a.photoCap * 0.01; }
    });
    return b;
  }

  speciesInRegion(regionId) {
    const list = [];
    this.species.forEach((a) => { if (a.counts[regionId] > 0.5) list.push(a); });
    return list;
  }

  // Per-region carrying capacity from biome productivity + insolation + nutrients.
  regionCapacity(regionId, role) {
    const w = this.world;
    // Sample the region's cells coarsely.
    const rx = regionId % REGION_W, ry = (regionId / REGION_W) | 0;
    const x0 = (rx / REGION_W) * w.W, x1 = ((rx + 1) / REGION_W) * w.W;
    const y0 = (ry / REGION_H) * w.H, y1 = ((ry + 1) / REGION_H) * w.H;
    let prod = 0, count = 0;
    for (let y = y0 | 0; y < (y1 | 0); y += 3) {
      for (let x = x0 | 0; x < (x1 | 0); x += 3) {
        const i = y * w.W + x;
        prod += biomeProductivity(w.biomeId[i]) * (0.3 + w.insolation[i]);
        count++;
      }
    }
    const base = count > 0 ? prod / count : 0.2;
    // Predators are capped lower than autotrophs (less energy up the chain).
    const k = role === 'pred' ? 40 : role === 'herb' ? 120 : 200;
    return base * k;
  }

  step(dtSim, mode) {
    const years = dtSim / (365.25 * 24 * 3600);
    if (years <= 0) return;
    // At bio-mode low warp, the statistical layer ticks slowly (agents carry the detail).
    const effYears = mode === 'bio' ? years : years;

    // Advance each species. We integrate the logistic (self-limiting) term with its EXACT
    // solution so the step is unconditionally stable no matter how large dt is — explicit
    // Euler would explode at mega-year dt (ri·dt ≫ 1). Interaction and drift are applied as
    // bounded multipliers/increments so nothing can run to NaN (Appendix F: "stable scheme").
    this.species.forEach((a) => {
      for (let r = 0; r < N_REGIONS; r++) {
        let Ni = a.counts[r];
        if (Ni <= 0) continue;
        const Ki = Math.max(1, this.regionCapacity(r, a.role));
        const ri = this._intrinsicGrowth(a);

        // Exact logistic map: N(t+dt) = K / (1 + (K/N − 1)·e^{−ri·dt}).
        const expo = Math.exp(-Math.min(50, ri * effYears));
        Ni = Ki / (1 + (Ki / Math.max(1e-6, Ni) - 1) * expo);

        // Interaction as a bounded exponential multiplier (predation/competition), clamped.
        let interaction = 0;
        const others = this.speciesInRegion(r);
        for (let o = 0; o < others.length; o++) {
          const b = others[o];
          if (b.speciesId === a.speciesId) continue;
          if (a.role === 'pred' && b.role !== 'pred') interaction += 0.00002 * b.counts[r];
          else if (a.role !== 'pred' && b.role === 'pred') interaction -= 0.00003 * b.counts[r];
          else interaction -= 0.000005 * b.counts[r];
        }
        Ni *= Math.exp(Math.max(-4, Math.min(4, interaction * effYears)));

        if (!Number.isFinite(Ni) || Ni < 1) Ni = Number.isFinite(Ni) && Ni >= 1 ? Ni : 0;
        a.counts[r] = Math.min(1e7, Ni); // hard cap keeps aggregates bounded
      }

      // Mutation drift on the mean genome vector; variance grows as a random walk (~√time), so
      // drift magnitude scales with √dt and is capped. meanVec is re-clamped to sane bounds so
      // a long run can never produce NaN/Inf that would poison the state hash.
      const rng = this.world.rngMutation;
      const driftYears = Math.min(effYears, 5e5);
      const mr = Math.min(0.4, 0.0006 * Math.sqrt(driftYears));
      if (mr > 1e-6) {
        for (let k = 0; k < a.meanVec.length; k++) {
          a.meanVec[k] += rng.gaussian(0, mr * (0.05 * Math.abs(a.meanVec[k]) + 0.01));
          if (!Number.isFinite(a.meanVec[k])) a.meanVec[k] = 0;
          a.meanVec[k] = Math.max(-1e4, Math.min(1e4, a.meanVec[k]));
          a.variance[k] = Math.min(1e6, a.variance[k] + mr * 0.0005);
        }
      }

      // Migration: diffuse counts to neighbor regions weighted by suitability.
      this._migrate(a, effYears);

      // STRUCTURAL EVOLUTION (anagenesis): the representative genome accumulates real mutations
      // over evolutionary time — growing segments, eyes, muscles, bigger brains, shifting diet.
      // This is what makes deep-time evolution real: promoted agents reflect it, and emergent
      // milestones (multicellularity, first eye, first predator) can finally fire.
      this._evolveSpecies(a, effYears);

      // Phylogeny population bookkeeping (total across regions).
      let total = 0;
      for (let r = 0; r < N_REGIONS; r++) total += a.counts[r];
      const sp = this.world.phylo.get(a.speciesId);
      if (sp) this.world.phylo.recordPopulation(a.speciesId, this.world.tick, Math.round(total + this._agentCountOf(a.speciesId)));

      // Extinction: no population and no live agents -> mark extinct (prune later).
      if (total < 1 && this._agentCountOf(a.speciesId) === 0) {
        if (sp && sp.deathTick < 0) { this.world.phylo.extinct(a.speciesId, this.world.tick); this.world.bus.emit(EV.EXTINCTION, { tick: this.world.tick, simSeconds: this.world.simSeconds, species: sp.name }); }
        this._extinctQueue.push(a.speciesId);
      }
    });

    // Apply queued speciation buds and prune extinct species outside the iteration.
    this._applySpeciationQueue();
    this._pruneExtinct();
    // Bound the phylogeny's memory over deep time (retains living + significant extinct branches).
    if ((this.world.tick & 63) === 0) this.world.phylo.prune(1600);
  }

  // Evolve a species' representative genome on an evolutionary timescale, detect emergent
  // milestones, and occasionally bud a daughter species (branching the Tree of Life).
  _evolveSpecies(a, effYears) {
    a.evolveClock += effYears;
    // One structural mutation event per ~120k years of accumulated time (deterministic cadence).
    const STEP_YEARS = 120000;
    let events = 0;
    while (a.evolveClock >= STEP_YEARS && events < 8) { a.evolveClock -= STEP_YEARS; events++; }
    if (events === 0) return;

    const rng = this.world.rngMutation;
    for (let e = 0; e < events; e++) {
      a.rep = reproduceAsexual(a.rep, rng, this.world.params.baseMutation, this.world.innov);
    }
    // Refresh derived aggregates from the evolved genome.
    a.role = this._roleOf(a.rep);
    a.photoCap = a.rep.life.photoCap;
    a.digestCap = a.rep.life.digestCap;
    a.meanVec = Float32Array.from(genomeToVector(a.rep));

    this._detectEmergent(a);

    // Speciation branches the Tree of Life two ways:
    //  - ALLOPATRIC: a widespread population fragments across geography (the common case) —
    //    triggered by range + time, not by large genetic distance.
    //  - DIVERGENT: a lineage that has genetically drifted far from its origin splits.
    // Either queues a daughter; both are throttled by species count to bound the tree.
    if (this.species.size >= MAX_STAT_SPECIES) return;
    const occupied = this._regionsOccupied(a);
    let total = 0; for (let r = 0; r < N_REGIONS; r++) total += a.counts[r];
    const diverged = genomeDistance(a.rep, a.originRep) > COEF.threshold * 0.6;
    const allopatric = occupied >= 3 && total > 30 && this.world.rngMutation.float01() < Math.min(0.35, effYears / 4e6);
    if (allopatric || (diverged && occupied >= 2)) {
      this._speciationQueue.push(a);
      a.originRep = cloneGenome(a.rep); // parent must diverge afresh before budding again
    }
  }

  _detectEmergent(a) {
    const w = this.world;
    const g = a.rep;
    if (g.morph.length > 1) w.milestone('multicellular', EV.MULTICELLULARITY, {});
    if (hasPart(g, PART.EYE)) w.milestone('first_eye', EV.FIRST_EYE, {});
    // A predator: digestion-dominant diet with a mouth, and prey (non-predator biomass) exists.
    if (a.role === 'pred' && hasPart(g, PART.MOUTH)) {
      let prey = 0; this.species.forEach((b) => { if (b.role !== 'pred') for (let r = 0; r < N_REGIONS; r++) prey += b.counts[r]; });
      if (prey > 5) w.milestone('first_predator', EV.FIRST_PREDATOR, {});
    }
    // Land colonization: any occupied region that is predominantly dry land.
    for (let r = 0; r < N_REGIONS; r++) {
      if (a.counts[r] < 2) continue;
      if (this._regionIsLand(r)) { w.milestone('land_colonization', EV.LAND_COLONIZATION, {}); break; }
    }
  }

  _applySpeciationQueue() {
    const w = this.world;
    for (let i = 0; i < this._speciationQueue.length; i++) {
      const parent = this._speciationQueue[i];
      if (this.species.size >= MAX_STAT_SPECIES) break;
      const rng = this.world.rngMutation;
      // Daughter: a further-mutated copy of the parent rep.
      let child = cloneGenome(parent.rep);
      const nMut = 1 + rng.int(3);
      for (let m = 0; m < nMut; m++) child = reproduceAsexual(child, rng, this.world.params.baseMutation, this.world.innov);
      child.lineageId = parent.rep.lineageId;
      // Name + phylogeny entry (branches the Tree of Life).
      const trait = dominantTrait(this._traitSummary(child));
      const name = binomial(w.seed, child.lineageId + this.species.size, trait);
      const sp = w.phylo.create(child, w.tick, parent.speciesId, name.full, name.etymology);
      sp.trophicRole = this._roleOf(child);
      w.clusters.addRep(sp.id, child);
      const daughter = this.ensure(sp.id, child);
      // Transfer the most-populated region's stock to the daughter (allopatric-ish).
      let br = 0, bc = 0;
      for (let r = 0; r < N_REGIONS; r++) if (parent.counts[r] > bc) { bc = parent.counts[r]; br = r; }
      const move = parent.counts[br] * 0.5;
      parent.counts[br] -= move; daughter.counts[br] += Math.max(2, move);
      w.milestone('speciation_stat_' + sp.id, EV.SPECIATION, { species: sp.name, parent: w.phylo.get(parent.speciesId) ? w.phylo.get(parent.speciesId).name : '—' });
    }
    this._speciationQueue.length = 0;
  }

  _pruneExtinct() {
    for (let i = 0; i < this._extinctQueue.length; i++) {
      const id = this._extinctQueue[i];
      const a = this.species.get(id);
      if (!a) continue;
      let total = 0; for (let r = 0; r < N_REGIONS; r++) total += a.counts[r];
      if (total < 1 && this._agentCountOf(id) === 0) { this.species.delete(id); this.world.clusters.removeRep(id); }
    }
    this._extinctQueue.length = 0;
  }

  _traitSummary(g) {
    let mass = 0; for (let i = 0; i < g.morph.length; i++) { const s = g.morph[i]; mass += Math.PI * s.radius * s.radius * s.length * s.density; }
    return {
      speed: 1, mass: Math.max(0.05, mass), brainUnits: g.nodes.length + g.conns.length,
      sociality: hasPart(g, PART.SIGNAL) ? 0.6 : 0.1, photoCap: g.life.photoCap, digestCap: g.life.digestCap,
      recurrence: 0, temperature: 15, aquatic: false,
      camo: g.morph[0] ? 1 - g.morph[0].sat : 0.3, bright: g.morph[0] ? g.morph[0].sat : 0.4, deep: false,
    };
  }

  _regionsOccupied(a) { let n = 0; for (let r = 0; r < N_REGIONS; r++) if (a.counts[r] >= 1) n++; return n; }

  _regionIsLand(regionId) {
    const w = this.world;
    const rx = regionId % REGION_W, ry = (regionId / REGION_W) | 0;
    let land = 0, tot = 0;
    for (let y = (ry / REGION_H) * w.H | 0; y < ((ry + 1) / REGION_H) * w.H && y < w.H; y += 4) {
      for (let x = (rx / REGION_W) * w.W | 0; x < ((rx + 1) / REGION_W) * w.W && x < w.W; x += 4) {
        const i = y * w.W + x; tot++; if (w.waterDepth[i] === 0) land++;
      }
    }
    return tot > 0 && land / tot > 0.55;
  }

  _agentCountOf(speciesId) {
    const w = this.world;
    let n = 0;
    for (let s = 0; s < w.alive.length; s++) if (w.alive[s] && w.aspecies[s] === speciesId) n++;
    return n;
  }

  _intrinsicGrowth(a) {
    // From life-history: fast-reproducing (low maturation, high investment spread) => higher ri.
    const idxMat = LIFE_VEC_FIELDS.indexOf('maturationAge');
    const mat = a.meanVec[idxMat] || 20;
    return Math.max(0.05, 2.0 / Math.max(3, mat));
  }

  _migrate(a, years) {
    // Diffusion fraction per step, BOUNDED: at most ~40% of a region's population may emigrate
    // in one tick no matter how large dt is (an unbounded flux drove counts negative at
    // mega-year dt, which cascaded into a CO2 runaway).
    const flux = Math.min(0.4, 0.05 * years);
    if (flux <= 0) return;
    const next = this._migScratch || (this._migScratch = new Float32Array(N_REGIONS));
    next.set(a.counts);
    for (let ry = 0; ry < REGION_H; ry++) {
      for (let rx = 0; rx < REGION_W; rx++) {
        const r = ry * REGION_W + rx;
        const here = a.counts[r];
        if (here <= 0) continue;
        const neighbors = [
          ((rx + 1) % REGION_W) + ry * REGION_W,
          ((rx - 1 + REGION_W) % REGION_W) + ry * REGION_W,
          rx + Math.min(REGION_H - 1, ry + 1) * REGION_W,
          rx + Math.max(0, ry - 1) * REGION_W,
        ];
        for (let n = 0; n < neighbors.length; n++) {
          const nb = neighbors[n];
          const move = here * flux * 0.25;
          next[r] -= move; next[nb] += move;
        }
      }
    }
    for (let r = 0; r < N_REGIONS; r++) a.counts[r] = Math.max(0, next[r]);
  }

  // ---- LOD reconciliation ----

  // DEMOTE: fold live agents of a species-region into the aggregate, then the caller removes
  // them. Updates count and running mean/variance (Welford-ish batch). Contract: no double-
  // counting — the caller kills the folded agents.
  fold(speciesId, regionId, agentIndices) {
    const w = this.world;
    if (agentIndices.length === 0) return;
    const a = this.ensure(speciesId, w.genomes[agentIndices[0]]);
    // Batch-update mean/variance from the agents' genome vectors.
    const vecs = agentIndices.map((s) => genomeToVector(w.genomes[s]));
    const n = vecs.length;
    const len = a.meanVec.length;
    const mean = new Float64Array(len);
    for (let i = 0; i < n; i++) for (let k = 0; k < len; k++) mean[k] += vecs[i][k];
    for (let k = 0; k < len; k++) mean[k] /= n;
    const varr = new Float64Array(len);
    for (let i = 0; i < n; i++) for (let k = 0; k < len; k++) { const d = vecs[i][k] - mean[k]; varr[k] += d * d; }
    for (let k = 0; k < len; k++) varr[k] /= Math.max(1, n);
    // Blend into existing aggregate weighted by counts.
    const existing = a.counts[regionId];
    const total = existing + n;
    for (let k = 0; k < len; k++) {
      a.meanVec[k] = (a.meanVec[k] * existing + mean[k] * n) / Math.max(1, total);
      a.variance[k] = (a.variance[k] * existing + varr[k] * n) / Math.max(1, total);
    }
    a.counts[regionId] = total;
  }

  // PROMOTE: instantiate up to `count` representative agents by sampling the aggregate's mean +
  // variance. Decrements the aggregate count by the number actually instantiated (conservation).
  // Returns the number instantiated.
  instantiate(speciesId, regionId, count) {
    const w = this.world;
    const a = this.species.get(speciesId);
    if (!a) return 0;
    const avail = Math.floor(a.counts[regionId]);
    let toMake = Math.min(count, avail);
    if (toMake <= 0) return 0;

    const rng = w.rngMating;
    const rx = regionId % REGION_W, ry = (regionId / REGION_W) | 0;
    let made = 0;
    for (let m = 0; m < toMake; m++) {
      // Build a representative genome: clone the rep, nudge scalar life-history by mean+variance.
      const g = cloneGenome(a.rep);
      for (let f = 0; f < LIFE_VEC_FIELDS.length; f++) {
        const field = LIFE_VEC_FIELDS[f];
        const val = a.meanVec[f] + rng.gaussian(0, Math.sqrt(Math.max(0, a.variance[f])));
        g.life[field] = clamp(field, val);
      }
      const x = ((rx + rng.float01()) / REGION_W) * w.W;
      const y = ((ry + rng.float01()) / REGION_H) * w.H;
      const slot = w.spawnAgent(g, speciesId, x, y, 1.0);
      if (slot >= 0) made++;
      else break;
    }
    a.counts[regionId] -= made;
    return made;
  }

  // Seed a statistical population directly (used when a species should exist off-camera).
  seed(speciesId, repGenome, regionId, count) {
    const a = this.ensure(speciesId, repGenome);
    a.counts[regionId] += count;
  }

  impact(cx, cy, R) {
    // A meteor kills a fraction of statistical pop in affected regions.
    const region = this.regionOf(cx, cy);
    this.species.forEach((a) => { a.counts[region] *= 0.3; });
  }

  cull(speciesId) {
    const a = this.species.get(speciesId);
    if (a) a.counts.fill(0);
  }

  hashInto(h) {
    // Deterministic order: sort species ids.
    const ids = Array.from(this.species.keys()).sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) {
      const a = this.species.get(ids[i]);
      h.int32(ids[i]);
      h.floatArray(a.counts, 1);
      h.floatArray(a.meanVec, 1e3);
    }
  }
}
