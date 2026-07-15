// ui/chronicle.js
// The auto-generated prose history. Consumes milestone events from the sim and narrates them
// into timestamped sentences with named lineages. The feed is an aria-live region (announced to
// screen readers). Filterable by epoch and event type; exportable as text. It is also the
// source of timeline bookmarks (each narrated event carries its tick).

import { EV } from '../core/events.js';
import { formatSimTime } from '../core/clock.js';

// Event -> narrator. Receives the event payload; returns { text, kind } or null to skip.
const NARRATORS = {
  [EV.OCEANS_CONDENSE]: () => ({ text: 'The crust cooled below the boiling point and the first oceans condensed from the sky.', kind: 'world' }),
  [EV.FIRST_LIFE]: (e) => ({ text: `At a hydrothermal vent, a self-replicating chemistry sparked into being — the lineage of ${e.species}.`, kind: 'life' }),
  [EV.PHOTOSYNTHESIS]: () => ({ text: 'Life learned to eat light; photosynthesizers spread across the shallows.', kind: 'life' }),
  [EV.GREAT_OXYGENATION]: (e) => ({ text: `Free oxygen flooded the air (O₂ ≈ ${(e.o2 * 100 | 0)}%). Larger bodies became possible; the old anaerobes suffered.`, kind: 'world' }),
  [EV.FIRST_PREDATOR]: () => ({ text: 'For the first time, one organism consumed another. The long arms race between hunter and hunted had begun.', kind: 'life' }),
  [EV.FIRST_EYE]: () => ({ text: 'An eye evolved — the world could now be seen, and the seen could be caught.', kind: 'life' }),
  [EV.LAND_COLONIZATION]: () => ({ text: 'Life crept from the water onto bare stone and began to green the land.', kind: 'life' }),
  [EV.SPECIATION]: (e) => ({ text: `A population drifted far enough to split: ${e.species} diverged from ${e.parent}.`, kind: 'life' }),
  [EV.EXTINCTION]: (e) => ({ text: `${e.species || 'A lineage'} vanished from the world${e.note ? ' — ' + e.note : ''}.`, kind: 'death' }),
  [EV.MASS_EXTINCTION]: (e) => ({ text: `A mass extinction swept the biosphere${e.cause ? ' (' + e.cause + ')' : ''}. Whole branches of the tree of life went dark.`, kind: 'death' }),
  [EV.SNOWBALL]: () => ({ text: 'Ice advanced from both poles until it nearly met at the equator — a snowball world.', kind: 'world' }),
  [EV.HOTHOUSE]: () => ({ text: 'Runaway greenhouse warming turned the world into a hothouse.', kind: 'world' }),
  [EV.METEOR_IMPACT]: (e) => ({ text: `A meteor struck${e.size >= 3 ? ' — a catastrophe on a global scale' : ''}.`, kind: 'world' }),
  [EV.VOLCANIC_WINTER]: () => ({ text: 'Ash veiled the sun and the world plunged into a volcanic winter.', kind: 'world' }),
  [EV.FIRST_TOOL]: (e) => ({ text: `The descendants of ${e.species} began shaping objects to their purpose — the first tools.`, kind: 'mind' }),
  [EV.FIRE]: (e) => ({ text: `${e.species || 'A people'} mastered fire; cooking unlocked new energy and the land began to burn to their will.`, kind: 'mind' }),
  [EV.LANGUAGE]: (e) => ({ text: `Among ${e.species || 'them'}, scent-signals and cries became true speech.`, kind: 'mind' }),
  [EV.CULTURE]: (e) => ({ text: `${e.species || 'They'} began passing knowledge down the generations — culture, inherited without genes.`, kind: 'mind' }),
  [EV.AGRICULTURE]: (e) => ({ text: `${e.species || 'They'} learned to cultivate other species and settle in one place.`, kind: 'mind' }),
  [EV.CITIES]: (e) => ({ text: `Cities rose. Specialists multiplied, and the great beasts of the world began to disappear before them.`, kind: 'mind' }),
  [EV.INDUSTRY]: (e) => ({ text: `An industrial age dawned; their smoke began to change the very climate.`, kind: 'mind' }),
  [EV.SPACEFLIGHT]: (e) => ({ text: `${e.species || 'A civilization'} reached for the stars — even as their own sun began to turn against them.`, kind: 'mind' }),
  [EV.MAIN_SEQUENCE]: () => null, // too frequent; not narrated
  [EV.RED_GIANT]: () => ({ text: 'The star swelled into a red giant. Its light grew a hundredfold and the oceans began to boil away.', kind: 'star' }),
  [EV.OCEANS_BOIL]: () => ({ text: 'The last oceans boiled into vapor. Only the poles and the deep offered refuge.', kind: 'star' }),
  [EV.WHITE_DWARF]: () => ({ text: 'The star shed its envelope and collapsed to a white dwarf — a cold cinder lighting a dead world.', kind: 'star' }),
  [EV.SUPERNOVA]: () => ({ text: 'The star tore itself apart in a supernova. In a single flash, the world was stripped and sterilized.', kind: 'star' }),
  [EV.WORLD_END]: () => ({ text: 'And so the world ended, as all worlds must.', kind: 'star' }),
  [EV.INTERVENTION]: (e) => ({ text: `[A hand reached into the world: ${e.ivType}.]`, kind: 'god' }),
};

export class Chronicle {
  constructor(feedEl) {
    this.feed = feedEl;
    this.entries = []; // {tick, simSeconds, text, kind, type}
    this.filter = 'all';
    this.bookmarks = []; // {tick, simSeconds, label, kind}
  }

  ingest(events) {
    if (!events || events.length === 0) return;
    let added = false;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const narrator = NARRATORS[e.type];
      if (!narrator) continue;
      const out = narrator(e);
      if (!out) continue;
      const entry = { tick: e.tick, simSeconds: e.simSeconds || 0, text: out.text, kind: out.kind, type: e.type };
      this.entries.push(entry);
      // Major events become timeline bookmarks.
      if (out.kind !== 'god') this.bookmarks.push({ tick: e.tick, simSeconds: e.simSeconds || 0, label: shortLabel(e.type), kind: out.kind });
      added = true;
    }
    if (this.entries.length > 600) this.entries.splice(0, this.entries.length - 600);
    if (added) this.render();
  }

  setFilter(f) { this.filter = f; this.render(); }

  render() {
    if (!this.feed) return;
    const frag = document.createDocumentFragment();
    const list = this.filter === 'all' ? this.entries : this.entries.filter((e) => e.kind === this.filter);
    const recent = list.slice(-120);
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      const div = document.createElement('div');
      div.className = 'chron-entry chron-' + e.kind;
      div.style.cssText = 'padding:6px 0;border-bottom:1px solid var(--line);font-size:var(--fs-sm);';
      const t = document.createElement('span');
      t.className = 'num';
      t.style.cssText = 'color:var(--ink-dim);display:block;font-size:var(--fs-xs);';
      t.textContent = formatSimTime(e.simSeconds);
      const p = document.createElement('span');
      p.textContent = e.text;
      div.appendChild(t); div.appendChild(p);
      frag.appendChild(div);
    }
    this.feed.textContent = '';
    if (recent.length === 0) { this.feed.textContent = 'The history of this world is yet unwritten.'; return; }
    this.feed.appendChild(frag);
  }

  exportText() {
    return this.entries.map((e) => `${formatSimTime(e.simSeconds).padStart(10)}  ${e.text}`).join('\n');
  }
}

function shortLabel(type) {
  return String(type).replace(/_/g, ' ');
}
