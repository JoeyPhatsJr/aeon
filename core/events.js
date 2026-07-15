// core/events.js
// A minimal synchronous event bus. Listeners are stored in insertion-ordered arrays and
// invoked by index, so dispatch order is deterministic. Used by the sim to announce
// milestones (first replicator, oxygenation, extinctions, stellar phases) that the
// Chronicle and bookmarks consume. Nothing here mutates world state.

export class EventBus {
  constructor() {
    this._listeners = new Map(); // type -> array of {fn, once}
  }

  on(type, fn) {
    let arr = this._listeners.get(type);
    if (!arr) {
      arr = [];
      this._listeners.set(type, arr);
    }
    arr.push({ fn, once: false });
    return () => this.off(type, fn);
  }

  once(type, fn) {
    let arr = this._listeners.get(type);
    if (!arr) {
      arr = [];
      this._listeners.set(type, arr);
    }
    arr.push({ fn, once: true });
  }

  off(type, fn) {
    const arr = this._listeners.get(type);
    if (!arr) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].fn === fn) arr.splice(i, 1);
    }
  }

  // Emit synchronously to all listeners in registration order. Listeners that registered
  // with `once` are removed after firing. Errors in one listener never block the others.
  emit(type, payload) {
    const arr = this._listeners.get(type);
    if (!arr || arr.length === 0) return;
    // Iterate a copy so off()/once() during dispatch does not disturb the loop.
    const snapshot = arr.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i];
      try {
        entry.fn(payload);
      } catch (err) {
        // Keep the sim alive; surface once for debugging without spamming.
        if (!entry._warned) {
          entry._warned = true;
          // eslint-disable-next-line no-console
          console.warn(`[events] listener for "${type}" threw:`, err);
        }
      }
      if (entry.once) this.off(type, entry.fn);
    }
  }

  clear() {
    this._listeners.clear();
  }
}

// Canonical event type names, so producers and consumers never drift on string keys.
export const EV = {
  // World / geology / climate
  OCEANS_CONDENSE: 'oceans_condense',
  SNOWBALL: 'snowball',
  HOTHOUSE: 'hothouse',
  VOLCANIC_WINTER: 'volcanic_winter',
  METEOR_IMPACT: 'meteor_impact',
  // Life milestones
  FIRST_LIFE: 'first_life',
  PHOTOSYNTHESIS: 'photosynthesis',
  GREAT_OXYGENATION: 'great_oxygenation',
  MULTICELLULARITY: 'multicellularity',
  FIRST_PREDATOR: 'first_predator',
  FIRST_EYE: 'first_eye',
  LAND_COLONIZATION: 'land_colonization',
  SPECIATION: 'speciation',
  EXTINCTION: 'extinction',
  MASS_EXTINCTION: 'mass_extinction',
  // Mind / civ
  FIRST_TOOL: 'first_tool',
  FIRE: 'fire',
  LANGUAGE: 'language',
  CULTURE: 'culture',
  AGRICULTURE: 'agriculture',
  CITIES: 'cities',
  INDUSTRY: 'industry',
  SPACEFLIGHT: 'spaceflight',
  // Stellar
  MAIN_SEQUENCE: 'main_sequence',
  RED_GIANT: 'red_giant',
  OCEANS_BOIL: 'oceans_boil',
  WHITE_DWARF: 'white_dwarf',
  SUPERNOVA: 'supernova',
  WORLD_END: 'world_end',
  // Player
  INTERVENTION: 'intervention',
  BOOKMARK: 'bookmark',
};
