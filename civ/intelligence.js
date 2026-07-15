// civ/intelligence.js
// The intelligence question (§E, Appendix J). Intelligence is an emergent POSSIBILITY, never a
// guaranteed milestone. Bigger, more structured brains cost energy every tick (metabolism.js
// k_brain), so cognition only spreads when the environment rewards it. This layer OBSERVES the
// world (it never writes fitness) and, when a lineage sustains all three preconditions —
// neural complexity, sociality, and manipulation — attaches a cultural layer that runs on top
// of genetics and evolves orders of magnitude faster.
//
// Dependency direction: this is driven from OUTSIDE world.step by the sim host, so sim/ never
// imports civ/. It reads world state and (for biosphere feedback) may nudge it, exactly like a
// player intervention.

import { brainSize, recurrenceRatio, hasManipulator, hasPart, PART } from '../bio/genome.js';
import { EV } from '../core/events.js';
import { Civilization } from './civilization.js';

export const THRESH = {
  brain: 55,        // nodes + active connections, weighted by recurrence
  recurrence: 0.12, // fraction of recurrent connections (memory/temporal capacity)
  sociality: 0.45,  // proxy: signalling + clustering
  sustainGens: 3,   // must hold across this many evaluations before proto-sapience
};

export class IntelligenceLayer {
  constructor(world) {
    this.world = world;
    this.candidates = new Map(); // speciesId -> consecutive-eval count
    this.civilizations = new Map(); // speciesId -> Civilization
    this.evalEvery = 30; // ticks between scans (cheap)
    this._lastEval = 0;
  }

  // Called by the host after world.step. Returns the set of active civilizations.
  step() {
    const w = this.world;
    // Advance existing civilizations every tick (they run at aggregate LOD).
    this.civilizations.forEach((civ) => civ.step(w));

    if (w.tick - this._lastEval < this.evalEvery) return this.civilizations;
    this._lastEval = w.tick;

    // Scan living species for the three preconditions.
    w.phylo.species.forEach((sp) => {
      if (sp.deathTick >= 0) return;
      if (this.civilizations.has(sp.id)) return;
      const g = sp.representative;
      if (!g) return;

      const bUnits = brainSize(g) * (1 + recurrenceRatio(g));
      const social = this._sociality(g, sp);
      const manip = hasManipulator(g);

      const meets = bUnits > THRESH.brain && social > THRESH.sociality && manip;
      if (meets) {
        const n = (this.candidates.get(sp.id) || 0) + 1;
        this.candidates.set(sp.id, n);
        if (n >= THRESH.sustainGens) {
          this._becomeProtoSapient(sp);
        }
      } else {
        this.candidates.delete(sp.id);
      }
    });

    return this.civilizations;
  }

  // Sociality proxy: a signalling channel plus population clustering. We cannot cheaply measure
  // realized cooperation, so we approximate: has a SIGNAL effector AND a reasonably dense
  // population (grouping). This is intentionally a PROXY, not a reward — nothing here changes
  // any organism's energy.
  _sociality(g, sp) {
    const hasSignal = hasPart(g, PART.SIGNAL) ? 0.4 : 0;
    const hasEyes = hasPart(g, PART.EYE) ? 0.2 : 0;
    const dense = Math.min(0.4, sp.population / 200);
    return hasSignal + hasEyes + dense;
  }

  _becomeProtoSapient(sp) {
    const w = this.world;
    const civ = new Civilization(sp);
    this.civilizations.set(sp.id, civ);
    w.civ = w.civ || [];
    w.civ.push(civ);
    w.milestone('proto_sapient_' + sp.id, EV.FIRST_TOOL, { species: sp.name });
  }

  hashInto(h) {
    const ids = Array.from(this.civilizations.keys()).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) { h.int32(ids[i]); this.civilizations.get(ids[i]).hashInto(h); }
  }
}
