// sim/atmosphere.js
// Global atmospheric CO2/O2 budget (§B, Appendix H). Photosynthesizers draw down CO2 and
// release O2; respiration/decay and volcanism return CO2. The GREAT OXYGENATION is emergent:
// once photosynthetic life spreads, O2 accumulates past a threshold, which (a) enables larger
// aerobic bodies (via metabolism.aerobicFactor) and (b) stresses anaerobes — a real crisis the
// sim can produce, never a scripted milestone. The atmosphere is treated as well-mixed; cell
// o2/co2 fields track the global values with a small vent-local CO2 bump.

import { EV } from '../core/events.js';

export class Atmosphere {
  constructor(co2_0, o2_0) {
    this.co2 = co2_0;   // fraction of a hothouse reference
    this.o2 = o2_0;     // fraction of "modern" free O2
    this._oxygenated = false;
  }

  step(world, dtSim) {
    const years = dtSim / (365.25 * 24 * 3600);

    // Photosynthetic activity: from full-fidelity autotroph agents + statistical biomass.
    let photo = world.population ? world.population.photoBiomass() : 0;
    // Add agent-level photosynthesis (sample the pool).
    for (let s = 0; s < world.alive.length; s++) {
      if (!world.alive[s]) continue;
      const g = world.genomes[s];
      if (g) photo += g.life.photoCap * 0.02;
    }
    // Only meaningful once oceans exist and there is light. Guard non-negative: photosynthesis
    // can never REMOVE oxygen or ADD CO2 (a negative here once caused a greenhouse runaway).
    const active = Math.max(0, world.lifeExists ? photo : 0);

    // O2 production and CO2 drawdown proportional to photosynthesis; capped rates keep it
    // stable across the huge dt range (integrate in years).
    const prod = Math.min(0.05, active * 0.0008) * years;
    const co2draw = Math.min(0.05, active * 0.0006) * years;

    // Respiration + volcanic + decay return CO2; O2 slowly leaks (oxidation) without life.
    const respiration = Math.min(0.03, (world.agentCount * 0.00002)) * years;
    const o2leak = this.o2 * 0.00005 * years;

    this.o2 = Math.max(0, this.o2 + prod - o2leak);
    this.co2 = Math.max(0.02, this.co2 - co2draw + respiration);

    // Distribute to cells (well-mixed) with a small extra CO2 near volcanic/vent cells.
    for (let i = 0; i < world.N; i++) {
      world.o2[i] = this.o2;
      world.co2[i] = this.co2;
    }

    // Photosynthesis milestone (first sustained autotrophy).
    if (world.lifeExists && active > 0.1) {
      world.milestone('photosynthesis', EV.PHOTOSYNTHESIS, {});
    }

    // Great Oxygenation.
    if (!this._oxygenated && this.o2 > 0.21) {
      this._oxygenated = true;
      world.oxygenated = true;
      world.milestone('great_oxygenation', EV.GREAT_OXYGENATION, { o2: this.o2 });
    }
  }

  saveState() { return { co2: this.co2, o2: this.o2, oxygenated: this._oxygenated }; }
  loadState(st) { this.co2 = st.co2; this.o2 = st.o2; this._oxygenated = st.oxygenated; return this; }
}
