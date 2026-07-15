// core/lod.js
// The level-of-detail manager — the make-or-break seam of §1.2.
//
// Every species/region is in one of two forms: FULL (per-organism agents, stepped by real
// body+brain+physics+metabolism) or STAT (aggregate population math). This module decides
// which, and orchestrates the transitions, WITHOUT knowing how a genome is sampled or how
// aggregates fold — those live in bio/ and sim/ and are injected as a `delegate`. This keeps
// core/ dependency-free (per ARCHITECTURE §2) while still owning the contract.
//
// Reconciliation contract (must hold; verified by ?selftest):
//   promote(species, region): instantiate representative agents by sampling the population's
//     mean + covariance (clamped multivariate Gaussian). Instantiated count matches local
//     density. Crossfade in — no pop.
//   demote(species, region): fold agents' births/deaths/energy back into aggregates
//     (delta-update mean/variance/count). Count is conserved modulo births/deaths that
//     happened while promoted, which are accounted explicitly.
//   promote -> demote round-trips aggregate stats within tolerance.

export const LOD = { STAT: 0, FULL: 1 };

// Decide the target LOD for a species-in-region from the three inputs of §1.3.
// cameraZoom in [0,1] where 1 == fully zoomed to a single organism.
// warpLodBias in [0,1] from the active warp (higher warp => prefer STAT).
// localDensity: agents that WOULD be instantiated near the camera for this species-region.
// onScreen: is this region within/near the current viewport?
export function decideLOD({ cameraZoom, warpLodBias, onScreen, agentBudgetLeft }) {
  // High warp collapses everything to statistics regardless of zoom.
  if (warpLodBias >= 0.6) return LOD.STAT;
  // Off-screen regions are always statistical (nothing to render at full fidelity).
  if (!onScreen) return LOD.STAT;
  // On-screen, low warp, zoomed in enough, and budget available => full fidelity.
  const zoomWantsFull = cameraZoom > 0.15;
  if (zoomWantsFull && agentBudgetLeft > 0) return LOD.FULL;
  return LOD.STAT;
}

// Manages LOD state per (speciesId, regionId) key and drives transitions via a delegate.
//
// delegate must implement:
//   instantiateAgents(speciesId, regionId, count) -> number actually instantiated
//   foldAgents(speciesId, regionId) -> void   (demote: fold live agents back to aggregates)
//   localDensity(speciesId, regionId) -> number (target on-screen agent count)
//   regionOnScreen(regionId) -> bool
//   liveAgentCount() -> number (total FULL agents currently alive)
//   maxAgents() -> number (hard cap on FULL agents this frame)
//   forEachActiveSpeciesRegion(cb) -> iterate (speciesId, regionId) pairs by stable order
export class LODManager {
  constructor(delegate) {
    this.delegate = delegate;
    this.state = new Map(); // key -> LOD.FULL | LOD.STAT
    this.stats = { full: 0, stat: 0, promotions: 0, demotions: 0, tier: 'stat' };
  }

  static key(speciesId, regionId) {
    return speciesId * 100000 + regionId; // stable integer key; avoids string allocation
  }

  // Reconcile all species-regions against the current camera/warp. Called once per rendered
  // frame from the main thread's request, executed in the sim (deterministic w.r.t. tick
  // because promote/demote sample from RNG substreams, and the iteration order is stable).
  reconcile({ cameraZoom, warpLodBias }) {
    const d = this.delegate;
    let full = 0;
    let stat = 0;

    d.forEachActiveSpeciesRegion((speciesId, regionId) => {
      const key = LODManager.key(speciesId, regionId);
      const current = this.state.get(key) ?? LOD.STAT;
      const onScreen = d.regionOnScreen(regionId);
      const agentBudgetLeft = d.maxAgents() - d.liveAgentCount();
      const target = decideLOD({ cameraZoom, warpLodBias, onScreen, agentBudgetLeft });

      if (target === LOD.FULL && current === LOD.STAT) {
        const density = d.localDensity(speciesId, regionId);
        const budget = Math.max(0, d.maxAgents() - d.liveAgentCount());
        const count = Math.min(density, budget);
        if (count > 0) {
          d.instantiateAgents(speciesId, regionId, count);
          this.state.set(key, LOD.FULL);
          this.stats.promotions++;
        }
      } else if (target === LOD.STAT && current === LOD.FULL) {
        d.foldAgents(speciesId, regionId);
        this.state.set(key, LOD.STAT);
        this.stats.demotions++;
      }

      if ((this.state.get(key) ?? LOD.STAT) === LOD.FULL) full++;
      else stat++;
    });

    this.stats.full = full;
    this.stats.stat = stat;
    this.stats.tier = warpLodBias >= 0.6 ? 'statistical' : full > 0 ? 'mixed' : 'statistical';
    return this.stats;
  }

  lodOf(speciesId, regionId) {
    return this.state.get(LODManager.key(speciesId, regionId)) ?? LOD.STAT;
  }

  // Force everything to STAT (used before a scrub/re-sim so re-simulation starts uniform).
  demoteAll() {
    const d = this.delegate;
    d.forEachActiveSpeciesRegion((speciesId, regionId) => {
      const key = LODManager.key(speciesId, regionId);
      if ((this.state.get(key) ?? LOD.STAT) === LOD.FULL) {
        d.foldAgents(speciesId, regionId);
        this.state.set(key, LOD.STAT);
      }
    });
  }

  clear() {
    this.state.clear();
  }
}

// Sample a genome vector from a population's mean + diagonal variance, clamped to valid
// ranges. This is the concrete "multivariate Gaussian in genome space" of §1.2. We use a
// diagonal (per-gene independent) approximation of covariance: it is stable, cheap, and
// sufficient to make instantiated agents look like plausible members of the population.
// `rng` must be a deterministic RNG (the `mating`/`mutation` substream).
export function sampleGenomeVector(mean, variance, lo, hi, rng, out) {
  const n = mean.length;
  const dst = out || new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const std = Math.sqrt(Math.max(0, variance[i]));
    let v = mean[i] + rng.gaussian(0, std);
    if (lo && hi) v = Math.min(hi[i], Math.max(lo[i], v));
    dst[i] = v;
  }
  return dst;
}
