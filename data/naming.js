// data/naming.js
// Procedural binomial names + etymology (Appendix L). Each lineage seeds a pronounceable
// Genus from a consonant/vowel syllable table via the `naming` substream, and a species
// epithet from a trait-derived Latinate root. The etymology string ("velox — for its
// sprint-adapted hind limbs") surfaces in the inspector and Chronicle. Deterministic: the same
// lineageId + master seed always yields the same name.

import { RNG } from '../core/rng.js';

const ONSET = ['s', 'th', 'v', 'k', 'br', 'dr', 'gl', 'ph', 'tr', 'n', 'm', 'l', 'r', 'st', 'cr', 'x', 'z', 'ch', 'sy', 'my'];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'ae', 'y', 'ia', 'eo', 'ou'];
const CODA = ['n', 's', 'x', 'r', 'l', 'ps', 'nx', 'th', 'm', 'd', ''];
const GENUS_SUFFIX = ['ops', 'odon', 'saurus', 'nyx', 'pod', 'therium', 'ella', 'ura', 'anthus', 'ictis', 'oceras'];

// Trait -> {epithet, gloss}. The sim picks the dominant trait for a species and names for it.
export const TRAIT_EPITHET = {
  swift: { epithet: 'velox', gloss: 'swift — for its sprint-adapted body' },
  armored: { epithet: 'armatus', gloss: 'armored — for its heavy protective segments' },
  deep: { epithet: 'abyssalis', gloss: 'deep-dwelling — found in the dark cold water' },
  social: { epithet: 'gregarius', gloss: 'social — for its coordinated signalling' },
  large: { epithet: 'magnus', gloss: 'great — for its imposing size' },
  small: { epithet: 'minutus', gloss: 'tiny — for its diminutive form' },
  photo: { epithet: 'solaris', gloss: 'sun-eater — living on light alone' },
  predator: { epithet: 'venator', gloss: 'hunter — for its mouth-forward pursuit' },
  grazer: { epithet: 'pascens', gloss: 'grazer — feeding on the abundant' },
  scavenger: { epithet: 'putridus', gloss: 'decomposer — thriving on the dead' },
  camouflaged: { epithet: 'occultus', gloss: 'hidden — its colors matching the ground' },
  bright: { epithet: 'ornatus', gloss: 'adorned — for its conspicuous display' },
  clever: { epithet: 'sapiens', gloss: 'knowing — for its unusually complex brain' },
  cold: { epithet: 'borealis', gloss: 'of the cold — enduring the frozen wastes' },
  warm: { epithet: 'aestivus', gloss: 'of the heat — flourishing in the tropics' },
  aquatic: { epithet: 'natans', gloss: 'swimming — a creature of the water' },
};

function syllable(rng, first) {
  let s = '';
  if (first || rng.bool(0.7)) s += rng.pick(ONSET);
  s += rng.pick(VOWEL);
  if (rng.bool(0.4)) s += rng.pick(CODA);
  return s;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Build a genus name from a lineage id + master seed.
export function genusName(masterSeed, lineageId) {
  const rng = new RNG(masterSeed).fork('naming').fork('g' + lineageId);
  const syllables = 2 + rng.int(2);
  let name = '';
  for (let i = 0; i < syllables; i++) name += syllable(rng, i === 0);
  if (rng.bool(0.5)) name += rng.pick(GENUS_SUFFIX);
  return cap(name);
}

// Full binomial + etymology for a species, given its dominant trait key.
export function binomial(masterSeed, lineageId, traitKey) {
  const genus = genusName(masterSeed, lineageId);
  const t = TRAIT_EPITHET[traitKey] || TRAIT_EPITHET.photo;
  return {
    genus,
    epithet: t.epithet,
    full: genus + ' ' + t.epithet,
    etymology: t.epithet + ' — ' + t.gloss.split('—')[1].trim(),
    gloss: t.gloss,
  };
}

// Given a species' realized traits, pick the single most distinctive one to name it after.
// Pure function of scalar summaries the sim already computes.
export function dominantTrait(summary) {
  // summary: { speed, mass, brainUnits, sociality, photoCap, digestCap, recurrence,
  //            temperature, aquatic, camo, bright, deep }
  const c = [];
  if (summary.brainUnits > 40) c.push(['clever', summary.brainUnits]);
  if (summary.sociality > 0.5) c.push(['social', summary.sociality * 50]);
  if (summary.digestCap > summary.photoCap * 1.5) c.push(['predator', summary.digestCap * 40]);
  else if (summary.photoCap > 0.6) c.push(['photo', summary.photoCap * 30]);
  if (summary.speed > 1.5) c.push(['swift', summary.speed * 15]);
  if (summary.mass > 3) c.push(['large', summary.mass * 8]);
  else if (summary.mass < 0.3) c.push(['small', 30]);
  if (summary.deep) c.push(['deep', 25]);
  if (summary.aquatic) c.push(['aquatic', 20]);
  if (summary.camo > 0.6) c.push(['camouflaged', summary.camo * 30]);
  if (summary.bright > 0.7) c.push(['bright', summary.bright * 30]);
  if (summary.temperature < 0) c.push(['cold', 22]);
  else if (summary.temperature > 28) c.push(['warm', 22]);
  if (c.length === 0) return 'photo';
  // Highest-weight trait wins; ties broken by array order (stable, deterministic).
  let best = c[0];
  for (let i = 1; i < c.length; i++) if (c[i][1] > best[1]) best = c[i];
  return best[0];
}
