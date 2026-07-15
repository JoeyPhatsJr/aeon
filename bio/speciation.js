// bio/speciation.js
// Automatic, emergent speciation (Appendix G). Genome distance = NEAT's compatibility formula
// extended with a morphology term:
//   δ = c1·E/N + c2·D/N + c3·W̄ + c4·morphDist
// where E/D are excess/disjoint brain conn genes aligned by innovation id, W̄ is the mean
// weight difference of matching genes, and morphDist is the normalized distance of the
// morphology+life-history vector. Organisms within δ_t of a species representative join it;
// otherwise they found a new species, recording parent + split tick in the phylogeny. The
// phylogeny forest is the Tree of Life; extinct species persist, greyed.

import { genomeToVector, LIFE_VEC_FIELDS, MORPH_VEC_FIELDS, RANGE } from './genome.js';

export const COEF = { c1: 1.0, c2: 1.0, c3: 0.4, c4: 0.6, threshold: 3.0 };

// Per-field scale to normalize the genome vector so no single wide-range field (e.g.
// maxLifespan) dominates morphDist. Order must mirror genomeToVector.
const VEC_SCALE = buildVecScale();
function buildVecScale() {
  const s = [];
  for (const f of LIFE_VEC_FIELDS) { const r = RANGE[f]; s.push(Math.max(1e-6, r[1] - r[0])); }
  for (const f of MORPH_VEC_FIELDS) { const r = RANGE[f]; s.push(Math.max(1e-6, r[1] - r[0])); }
  s.push(16); // segment count scale
  s.push(20); // hidden-node count scale
  return s;
}

export function morphDistance(g1, g2) {
  const a = genomeToVector(g1);
  const b = genomeToVector(g2);
  let sum = 0;
  const n = Math.min(a.length, b.length, VEC_SCALE.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] - b[i]) / VEC_SCALE[i];
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

// Brain compatibility: excess, disjoint, and matching-weight difference, aligned by innovation.
export function brainCompat(g1, g2) {
  const m1 = new Map();
  const m2 = new Map();
  let max1 = 0, max2 = 0;
  for (let i = 0; i < g1.conns.length; i++) { const c = g1.conns[i]; m1.set(c.innovation, c); if (c.innovation > max1) max1 = c.innovation; }
  for (let i = 0; i < g2.conns.length; i++) { const c = g2.conns[i]; m2.set(c.innovation, c); if (c.innovation > max2) max2 = c.innovation; }

  const lowMax = Math.min(max1, max2);
  let excess = 0, disjoint = 0, matching = 0, weightDiff = 0;

  // Iterate the union of innovation ids in ascending order for determinism.
  const ids = new Set();
  m1.forEach((_, k) => ids.add(k));
  m2.forEach((_, k) => ids.add(k));
  const sorted = Array.from(ids).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i];
    const a = m1.get(id), b = m2.get(id);
    if (a && b) { matching++; weightDiff += Math.abs(a.weight - b.weight); }
    else {
      if (id > lowMax) excess++;
      else disjoint++;
    }
  }
  const wbar = matching > 0 ? weightDiff / matching : 0;
  return { excess, disjoint, wbar };
}

export function genomeDistance(g1, g2) {
  const N = Math.max(1, Math.max(g1.conns.length, g2.conns.length));
  const { excess, disjoint, wbar } = brainCompat(g1, g2);
  const md = morphDistance(g1, g2);
  return COEF.c1 * (excess / N) + COEF.c2 * (disjoint / N) + COEF.c3 * wbar + COEF.c4 * md;
}

// ---- Phylogeny / species registry ----

// Swappable per-world counter (see genome.js setGenomeCounter for the rationale — two
// coexisting worlds must not share species-id state).
let _speciesCounter = { v: 0 };
export function setSpeciesCounter(obj) { _speciesCounter = obj; }
export function resetSpeciesCounter(v = 0) { _speciesCounter.v = v; }

export class Phylogeny {
  constructor() {
    this.species = new Map(); // id -> node
    this.roots = [];          // top-level species ids
  }

  // Create a species node. `parentId` -1 for a de-novo lineage (first life).
  create(representative, birthTick, parentId, name, etymology) {
    const id = ++_speciesCounter.v;
    const node = {
      id, name: name || ('sp-' + id), etymology: etymology || '',
      parentId, birthTick, deathTick: -1,
      representative,               // representative genome
      population: 0,
      peakPopulation: 0,
      popHistory: [],               // [{tick, count}] downsampled
      trophicRole: 'auto',          // derived label for display ONLY (never feeds selection)
      lineageId: representative ? representative.lineageId : id,
      children: [],
    };
    this.species.set(id, node);
    if (parentId >= 0 && this.species.has(parentId)) this.species.get(parentId).children.push(id);
    else this.roots.push(id);
    return node;
  }

  get(id) { return this.species.get(id); }

  recordPopulation(id, tick, count) {
    const s = this.species.get(id);
    if (!s) return;
    s.population = count;
    if (count > s.peakPopulation) s.peakPopulation = count;
    // Downsample history to keep memory flat.
    const h = s.popHistory;
    if (h.length === 0 || tick - h[h.length - 1].tick > 0) h.push({ tick, count });
    if (h.length > 512) h.splice(0, h.length - 512);
    if (count <= 0 && s.deathTick < 0) s.deathTick = tick;
  }

  extinct(id, tick) {
    const s = this.species.get(id);
    if (s && s.deathTick < 0) s.deathTick = tick;
  }

  aliveCount() {
    let n = 0;
    this.species.forEach((s) => { if (s.deathTick < 0) n++; });
    return n;
  }

  // Bound memory over very long runs: when the forest exceeds `cap`, remove the least-
  // significant EXTINCT LEAF species (no living descendants, smallest peak population, oldest
  // death). Removing only leaves keeps every parent reference valid. Deterministic: the
  // candidate order derives from stable Map insertion order + numeric sort. Living species and
  // any species that is an ancestor of a survivor are always retained (the meaningful tree).
  prune(cap) {
    if (this.species.size <= cap) return;
    const referenced = new Set();
    this.species.forEach((s) => { if (s.parentId >= 0) referenced.add(s.parentId); });
    const candidates = [];
    this.species.forEach((s) => { if (s.deathTick >= 0 && !referenced.has(s.id)) candidates.push(s); });
    candidates.sort((a, b) => (a.peakPopulation - b.peakPopulation) || (a.deathTick - b.deathTick) || (a.id - b.id));
    let toRemove = this.species.size - cap;
    for (let i = 0; i < candidates.length && toRemove > 0; i++) {
      const s = candidates[i];
      this.species.delete(s.id);
      if (s.parentId >= 0 && this.species.has(s.parentId)) {
        const p = this.species.get(s.parentId);
        const idx = p.children.indexOf(s.id); if (idx >= 0) p.children.splice(idx, 1);
      } else {
        const idx = this.roots.indexOf(s.id); if (idx >= 0) this.roots.splice(idx, 1);
      }
      toRemove--;
    }
  }
}

// A species-assignment structure: keeps a representative genome per living species and finds
// the first within-threshold match. If none match, the caller founds a new species.
export class SpeciesClusters {
  constructor(phylo, threshold = COEF.threshold) {
    this.phylo = phylo;
    this.threshold = threshold;
    this.reps = []; // [{speciesId, genome}] — iterate by index for determinism
  }

  setReps(list) { this.reps = list; }

  // Return the speciesId of the first representative within threshold, else -1.
  match(genome) {
    let bestId = -1, bestD = Infinity;
    for (let i = 0; i < this.reps.length; i++) {
      const d = genomeDistance(genome, this.reps[i].genome);
      if (d < this.threshold && d < bestD) { bestD = d; bestId = this.reps[i].speciesId; }
    }
    return bestId;
  }

  addRep(speciesId, genome) { this.reps.push({ speciesId, genome }); }
  removeRep(speciesId) {
    for (let i = this.reps.length - 1; i >= 0; i--) if (this.reps[i].speciesId === speciesId) this.reps.splice(i, 1);
  }
}
