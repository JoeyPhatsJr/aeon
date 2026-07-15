// data/presets.js
// Curated starter seeds with one-line teasers (Appendix H8). Each is a full world-creation
// param set. `seed` is a decimal string (fits the 64-bit codec). These are deterministic
// entry points; the "smart" one is a hand-found seed where intelligence reliably emerges under
// the default constants (documented as best-effort — see README changelog).

export const DEFAULT_PARAMS = {
  mass: 1.0,          // solar masses
  waterFrac: 0.68,    // fraction of surface as ocean
  co2_0: 0.85,        // initial atmospheric CO2 (fraction of a "hothouse" reference)
  o2_0: 0.0,          // initial free O2 (none — oxygenation must be earned)
  tilt: 23.4,         // axial tilt (degrees)
  gridRes: 256,       // base grid width (height = width/2)
  baseMutation: 0.06, // world base mutation rate added to each genome's own rate
  cognitionCost: 1.0, // k_brain multiplier: lower => intelligence easier
};

export const PRESETS = [
  {
    id: 'default', name: 'Cradle', teaser: 'A temperate world much like the one you know.',
    seed: '20260715', params: { ...DEFAULT_PARAMS },
  },
  {
    id: 'ocean', name: 'Ocean World', teaser: 'Almost all water — life stays wet for eons.',
    seed: '8888', params: { ...DEFAULT_PARAMS, waterFrac: 0.95, tilt: 18 },
  },
  {
    id: 'harsh', name: 'Harsh Sun', teaser: 'A blue giant. A short, brutal timeline ending in supernova.',
    seed: '1212', params: { ...DEFAULT_PARAMS, mass: 12.0, waterFrac: 0.6 },
  },
  {
    id: 'smart', name: 'The One That Got Smart', teaser: 'Variable climate, cheap cognition — minds tend to wake here.',
    seed: '31415926', params: { ...DEFAULT_PARAMS, mass: 0.9, waterFrac: 0.62, tilt: 28, cognitionCost: 0.7, baseMutation: 0.08 },
  },
  {
    id: 'snowball', name: 'Snowball', teaser: 'A cold start teetering on runaway ice.',
    seed: '55', params: { ...DEFAULT_PARAMS, co2_0: 0.4, waterFrac: 0.7, mass: 0.95 },
  },
  {
    id: 'volatile', name: 'Volatile', teaser: 'High volcanism — CO₂ pulses and frequent upheaval.',
    seed: '66613', params: { ...DEFAULT_PARAMS, co2_0: 1.1, waterFrac: 0.55, tilt: 15 },
  },
];

export function presetById(id) {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
  return PRESETS[0];
}

// Estimate main-sequence lifetime (Gyr) for the new-world dialog's live readout.
// t ≈ 10 · M^-2.5 Gyr (Appendix I).
export function estimateStarLifetimeGyr(mass) {
  return 10 * Math.pow(mass, -2.5);
}

export function starFateLabel(mass) {
  return mass > 8 ? 'core-collapse supernova' : 'red giant → white dwarf';
}
