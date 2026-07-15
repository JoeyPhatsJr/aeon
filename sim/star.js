// sim/star.js
// Stellar evolution (Appendix I). The star's whole life is a pure function of stellar mass M
// (in solar masses) and elapsed sim-time. Luminosity brightens ~10%/Gyr across the main
// sequence (a real effect that slowly cooks the biosphere), then the star leaves the main
// sequence into a giant, and ends as a white dwarf (M ≤ ~8) or a core-collapse supernova
// (M > ~8). The mass slider is how AEON honors the "to the supernova" request scientifically.

import { YEAR_SECONDS } from '../core/clock.js';
import { EV } from '../core/events.js';

export const PHASE = {
  ACCRETION: 0, MAIN_SEQUENCE: 1, SUBGIANT: 2, RED_GIANT: 3,
  WHITE_DWARF: 4, SUPERNOVA: 5, REMNANT: 6,
};
export const PHASE_NAME = ['Accretion', 'Main Sequence', 'Subgiant', 'Red Giant', 'White Dwarf', 'Supernova', 'Remnant'];

const GYR = 1e9 * YEAR_SECONDS;

// Main-sequence luminosity (L☉) and lifetime (s).
export function mainSequenceLuminosity(M) { return Math.pow(M, 3.5); }
export function mainSequenceLifetime(M) { return 10 * Math.pow(M, -2.5) * GYR; }

// Total scrub-bar extent: main sequence + a giant phase + a short coda.
export function worldLifetime(M) {
  const ms = mainSequenceLifetime(M);
  const giant = ms * 0.1 + 0.2 * GYR;
  return ms + giant + 0.05 * GYR;
}

export class Star {
  constructor(mass) {
    this.mass = mass;
    this.tMainSeq = mainSequenceLifetime(mass);
    this.L0 = mainSequenceLuminosity(mass);
    this.accretionTime = 0.03 * GYR; // molten world cools during accretion
    this.phase = PHASE.ACCRETION;
    this.luminosity = this.L0 * 0.7; // dimmer while young
    this.firedEvents = new Set();
  }

  // Evaluate the star at a given elapsed sim-time (seconds). Sets luminosity + phase and
  // returns a small descriptor. Emits milestone events once via `bus` (optional).
  evaluate(simSeconds, bus) {
    const t = simSeconds;
    const M = this.mass;
    const tMS = this.tMainSeq;
    let phase, lum;

    if (t < this.accretionTime) {
      phase = PHASE.ACCRETION;
      // Young star brightens from 0.6 to 0.9 L0 as it settles.
      lum = this.L0 * (0.6 + 0.3 * (t / this.accretionTime));
    } else if (t < tMS) {
      phase = PHASE.MAIN_SEQUENCE;
      // Linear brightening: +40% of L0 across the whole main sequence.
      const frac = (t - this.accretionTime) / (tMS - this.accretionTime);
      lum = this.L0 * (0.9 + 0.4 * frac);
      this._fire(bus, EV.MAIN_SEQUENCE, { t });
    } else {
      const giantSpan = tMS * 0.1 + 0.2 * GYR;
      const gt = t - tMS;
      if (gt < giantSpan) {
        phase = gt < giantSpan * 0.3 ? PHASE.SUBGIANT : PHASE.RED_GIANT;
        // Luminosity balloons 100–1000×; ramps across the giant span.
        const gf = gt / giantSpan;
        lum = this.L0 * (1.3 + gf * gf * (M > 8 ? 1200 : 400));
        if (phase === PHASE.RED_GIANT) this._fire(bus, EV.RED_GIANT, { t });
      } else {
        // Terminal phase.
        if (M > 8) {
          phase = PHASE.SUPERNOVA;
          lum = this.L0 * 1e5; // flash
          this._fire(bus, EV.SUPERNOVA, { t });
        } else {
          phase = PHASE.WHITE_DWARF;
          lum = 0.02; // cold cinder
          this._fire(bus, EV.WHITE_DWARF, { t });
        }
      }
    }

    this.phase = phase;
    this.luminosity = lum;
    return { phase, luminosity: lum };
  }

  _fire(bus, ev, payload) {
    if (!bus || this.firedEvents.has(ev)) return;
    this.firedEvents.add(ev);
    bus.emit(ev, payload);
  }

  // Insolation scaling relative to a habitable baseline. Life is comfortable near 1.0.
  insolationScale() {
    // Normalize so a 1 M☉ star at mid-main-sequence gives ~1.0.
    return this.luminosity / Math.max(1e-6, this.L0);
  }

  saveState() {
    return { mass: this.mass, phase: this.phase, luminosity: this.luminosity, fired: Array.from(this.firedEvents) };
  }
  loadState(st) {
    this.mass = st.mass;
    this.tMainSeq = mainSequenceLifetime(st.mass);
    this.L0 = mainSequenceLuminosity(st.mass);
    this.phase = st.phase;
    this.luminosity = st.luminosity;
    this.firedEvents = new Set(st.fired || []);
    return this;
  }
}
