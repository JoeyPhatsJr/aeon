// civ/culture.js
// The cultural layer (§E, Appendix J): a meme pool transmitted by LEARNING, not genes, so it
// drifts and selects orders of magnitude faster than mutation. Memes here are abstract
// knowledge tokens; their accumulation and spread raise a civilization's "cooperation ceiling"
// and knowledge stock, which gate the tech tiers. Because transmission is non-genetic, a
// population collapse can erase accumulated culture (tech is reversible).

export class MemePool {
  constructor(rng) {
    this.rng = rng;
    this.knowledge = 0;      // accumulated cultural knowledge (drives tech tiers)
    this.cooperation = 0.2;  // cooperation ceiling in [0,1], raised by language/culture
    this.memes = [];         // [{id, utility}] — abstract, drift/select
    this._nextId = 1;
  }

  // Advance the meme pool one civ-step. `population`, `hasLanguage`, `hasCulture` gate rates.
  step(population, hasLanguage, hasCulture, years) {
    const learners = Math.max(1, population);

    // Innovation: new memes appear at a rate scaled by population and cooperation (more minds,
    // more sharing => more ideas). Utility is drawn from the culture substream.
    const innovationRate = 0.02 * Math.log(1 + learners) * (0.3 + this.cooperation);
    const expected = innovationRate * years * (hasCulture ? 3 : 1);
    let toAdd = Math.floor(expected);
    if (this.rng.float01() < expected - toAdd) toAdd++;
    for (let i = 0; i < Math.min(toAdd, 50); i++) {
      this.memes.push({ id: this._nextId++, utility: this.rng.float01() });
    }

    // Selection + drift: high-utility memes persist and compound knowledge; low ones fade.
    let gained = 0;
    for (let i = this.memes.length - 1; i >= 0; i--) {
      const m = this.memes[i];
      m.utility += this.rng.gaussian(0, 0.02); // drift
      if (m.utility < 0.25 && this.rng.bool(0.1)) { this.memes.splice(i, 1); continue; }
      gained += m.utility;
    }
    // Language multiplies transmission fidelity; culture adds generational memory. Knowledge is
    // a shared stock: more minds accumulate it FASTER (a mild log boost), never slower — so a
    // growing civilization is not penalized for its own success.
    const transmit = (hasLanguage ? 1.6 : 1) * (hasCulture ? 1.4 : 1);
    const minds = 1 + Math.log(1 + learners) * 0.3;
    this.knowledge += gained * 0.0006 * years * transmit * minds;

    // Cooperation rises toward a ceiling set by language/culture presence.
    const ceiling = 0.3 + (hasLanguage ? 0.3 : 0) + (hasCulture ? 0.3 : 0);
    this.cooperation += (ceiling - this.cooperation) * Math.min(1, 0.1 * years);

    // Cap memory to keep it bounded.
    if (this.memes.length > 400) this.memes.splice(0, this.memes.length - 400);
  }

  // A population crash erases a fraction of accumulated culture (tech reversibility).
  collapse(severity) {
    this.knowledge *= (1 - severity);
    this.cooperation = Math.max(0.15, this.cooperation * (1 - severity * 0.5));
    const keep = Math.max(0, Math.floor(this.memes.length * (1 - severity)));
    this.memes.length = keep;
  }

  hashInto(h) {
    h.float(this.knowledge, 1e3); h.float(this.cooperation, 1e3); h.int32(this.memes.length);
  }
}
