// civ/civilization.js
// A civilization runs at aggregate LOD (population, tech level, territory, resource draw,
// inter-group relations) and is always zoomable to individuals (Appendix J). Tech tiers unlock
// in order, each requiring the prior plus a resource/population precondition, and each is
// REVERSIBLE on population collapse. Civilizations feed back on the biosphere: fire clears
// land, agriculture domesticates, cities pressure megafauna, industry emits CO2 shifting
// climate — and at the top tier they may try to survive the coming stellar death.

import { EV } from '../core/events.js';
import { MemePool } from './culture.js';
import { biomeProductivity } from '../data/biomes.js';

// Tier ladder. Each entry: precondition predicate + biosphere feedback applied per step.
export const TIER = { TOOL: 0, FIRE: 1, LANGUAGE: 2, CULTURE: 3, AGRICULTURE: 4, CITIES: 5, INDUSTRY: 6, INFORMATION: 7, SPACEFLIGHT: 8 };
export const TIER_NAME = ['Tool use', 'Fire', 'Language', 'Culture', 'Agriculture', 'Cities', 'Industry', 'Information', 'Spaceflight'];
const TIER_EVENT = [EV.FIRST_TOOL, EV.FIRE, EV.LANGUAGE, EV.CULTURE, EV.AGRICULTURE, EV.CITIES, EV.INDUSTRY, EV.INDUSTRY, EV.SPACEFLIGHT];

export class Civilization {
  constructor(species) {
    this.species = species;
    this.speciesId = species.id;
    this.tier = TIER.TOOL;
    this.population = Math.max(20, species.population);
    this.territory = new Set(); // region ids
    this.resourceDraw = 0;
    this.emissions = 0;
    this.knowledgeReq = [0, 0.5, 2, 5, 12, 30, 80, 200, 500]; // knowledge to reach each tier
    this._rng = null; // set lazily from world (civ substream) so it stays deterministic
    this.memes = null;
    this.alive = true;
    this.attemptedEscape = false;
    this.territory.add(0); // seed a home region so carrying capacity has room to grow
  }

  step(world) {
    if (!this.alive) return;
    if (!this._rng) { this._rng = world.rngCiv.fork('civ' + this.speciesId); this.memes = new MemePool(this._rng); }

    const years = Math.max(1e-6, (world.simSeconds - (this._lastSec || world.simSeconds)) / (365.25 * 24 * 3600));
    this._lastSec = world.simSeconds;

    // Population dynamics: carrying capacity scales with tech tier and territory productivity.
    const sp = world.phylo.get(this.speciesId);
    if (!sp || sp.deathTick >= 0) { this._collapse(world, 1.0); return; }

    const K = this._carryingCapacity(world);
    const r = 0.02;
    // Exact logistic for stability across warp.
    const expo = Math.exp(-Math.min(50, r * years));
    this.population = K / (1 + (K / Math.max(1, this.population) - 1) * expo);
    if (!Number.isFinite(this.population)) this.population = 1;

    // A crash (population below a fraction of a prior peak) reverses tech.
    this._peak = Math.max(this._peak || 0, this.population);
    if (this.population < this._peak * 0.15 && this.tier > TIER.TOOL) {
      this._regress(world);
    }
    if (this.population < 10) { this._collapse(world, 1.0); return; }

    // Culture advances (knowledge + cooperation).
    const hasLang = this.tier >= TIER.LANGUAGE;
    const hasCult = this.tier >= TIER.CULTURE;
    this.memes.step(this.population, hasLang, hasCult, years);

    // Territory grows gradually as the population presses its range (not only on tier jumps),
    // so carrying capacity is not a hard ceiling that deadlocks advancement.
    if (this.population > this._carryingCapacity(world) * 0.8 && this.territory.size < 24) {
      this._expandTerritory(world);
    }

    // Advance tiers when knowledge + precondition allow.
    this._tryAdvance(world);

    // Biosphere feedback for the current tier.
    this._applyFeedback(world, years);
  }

  _carryingCapacity(world) {
    // Capacity grows with tier (agriculture/cities boost hugely), claimed territory, and
    // accumulated knowledge (better tools feed more mouths). No hard low ceiling.
    const tierMult = [1, 1.4, 1.8, 2.4, 8, 30, 60, 90, 120][this.tier];
    const knowBoost = 1 + Math.log(1 + (this.memes ? this.memes.knowledge : 0)) * 0.15;
    return Math.max(30, 60 * tierMult * Math.max(1, this.territory.size) * knowBoost);
  }

  _tryAdvance(world) {
    const next = this.tier + 1;
    if (next > TIER.SPACEFLIGHT) return;
    if (this.memes.knowledge < this.knowledgeReq[next]) return;

    // Tier-specific preconditions.
    let ok = true;
    switch (next) {
      case TIER.FIRE: ok = this._hasDryBiome(world); break;
      case TIER.LANGUAGE: ok = this.memes.cooperation > 0.28 && this.population > 60; break;
      case TIER.AGRICULTURE: ok = this._hasArableBiome(world); break;
      case TIER.CITIES: ok = this.population > 400; break;
      case TIER.INDUSTRY: ok = this.population > 1500; break;
      default: ok = true;
    }
    if (!ok) return;

    this.tier = next;
    // Expand territory a bit each tier.
    this._expandTerritory(world);
    world.milestone('civ_tier_' + this.speciesId + '_' + next, TIER_EVENT[next], { species: this.species.name, tier: TIER_NAME[next] });
  }

  _regress(world) {
    const lost = this.tier;
    this.tier = Math.max(TIER.TOOL, this.tier - 1);
    this.memes.collapse(0.4);
    if (this.tier !== lost) world.milestone('civ_regress_' + this.speciesId + '_' + world.tick, EV.EXTINCTION, { species: this.species.name, note: 'cultural regression' });
  }

  _collapse(world, severity) {
    this.memes && this.memes.collapse(severity);
    this.alive = false;
    world.milestone('civ_collapse_' + this.speciesId, EV.EXTINCTION, { species: this.species.name, note: 'civilization collapse' });
  }

  _expandTerritory(world) {
    // Claim the next unclaimed region outward from the home region (bounded).
    const home = world.population.regionOf(world.W * 0.5, world.H * 0.5);
    this.territory.add(home);
    for (let step = 1; step < 32 && this.territory.size < 24; step++) {
      const r = (home + step) % 32;
      if (!this.territory.has(r)) { this.territory.add(r); break; }
    }
  }

  // Full-scan biome checks (run only on tier-advance attempts, so scanning all ~2k cells is
  // cheap). A sparse stride would miss rare-but-present arable land and wrongly block a tier.
  _hasDryBiome(world) {
    // Fire needs land with burnable fuel: any vegetated/dry land biome (not ice/ocean/alpine).
    for (let i = 0; i < world.N; i++) {
      if (world.waterDepth[i] > 0) continue;
      const b = world.biomeId[i];
      if (b === 3 || b === 4 || b === 5 || b === 6 || b === 7) return true; // grass/forest/rainforest/savanna/desert
    }
    return false;
  }
  _hasArableBiome(world) {
    for (let i = 0; i < world.N; i++) {
      if (world.waterDepth[i] > 0) continue;
      const b = world.biomeId[i];
      if (b === 2 || b === 3 || b === 4 || b === 5 || b === 6) return true; // wetland/grass/forest/rainforest/savanna
    }
    return false;
  }

  // The biosphere pays for civilization: land clearing, hunting pressure, emissions.
  _applyFeedback(world, years) {
    this.resourceDraw = this.population * (1 + this.tier) * 0.001;
    if (this.tier >= TIER.FIRE) {
      // Local burns: nudge a few land cells toward grassland/savanna.
      for (let k = 0; k < 3; k++) {
        const i = world.rngCiv.int(world.N);
        if (world.waterDepth[i] === 0 && world.biomeId[i] === 4) world.biomeId[i] = 6;
      }
    }
    if (this.tier >= TIER.CITIES) {
      // Extinction pressure on megafauna: cull statistical populations of large-bodied species.
      world.population.species.forEach((a) => {
        // meanVec last-1 index is segment count proxy; large bodies get pressured.
        const seg = a.meanVec[a.meanVec.length - 2] || 0;
        if (seg > 6) for (let r = 0; r < a.counts.length; r++) a.counts[r] *= (1 - Math.min(0.5, 0.02 * years));
      });
    }
    if (this.tier >= TIER.INDUSTRY) {
      // Emissions shift climate (self-caused warming atop the star's brightening).
      this.emissions += this.population * 1e-9 * years;
      world.atmosphere.co2 += Math.min(0.02, this.population * 2e-11 * years);
    }
    if (this.tier >= TIER.SPACEFLIGHT && !this.attemptedEscape) {
      // The most dramatic worlds: a civilization sees the coming stellar death and responds.
      if (world.star.phase >= 2) { // subgiant or later
        this.attemptedEscape = true;
        world.milestone('civ_escape_' + this.speciesId, EV.SPACEFLIGHT, { species: this.species.name, note: 'reaching for the stars as the sun turns' });
      }
    }
  }

  hashInto(h) {
    h.int32(this.tier); h.float(this.population, 1); h.int32(this.territory.size);
    if (this.memes) this.memes.hashInto(h);
  }
}
