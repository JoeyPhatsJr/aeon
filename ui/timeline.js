// ui/timeline.js
// The time scrubber spanning the world's projected lifespan, with auto-dropped event bookmarks.
// Dragging the scrub seeks (the sim deterministically re-simulates to that tick). Bookmarks are
// rendered as ticks along the bar; clicking one seeks there.

export class Timeline {
  constructor(scrubEl, readoutEl, onSeek) {
    this.scrub = scrubEl;
    this.readout = readoutEl;
    this.onSeek = onSeek;
    this.currentTick = 0;
    this.maxTick = 1000;
    this.bookmarks = [];
    this._dragging = false;
    this.scrub.addEventListener('input', () => { this._dragging = true; });
    this.scrub.addEventListener('change', () => {
      const frac = parseInt(this.scrub.value, 10) / 1000;
      const tick = Math.floor(frac * this.maxTick);
      this._dragging = false;
      if (this.onSeek) this.onSeek(tick);
    });
  }

  // Estimate the tick span of the world from its projected lifetime and average sim-sec/tick.
  setLifetime(lifetimeSeconds, simSecPerTick) {
    this.maxTick = Math.max(1000, Math.floor(lifetimeSeconds / Math.max(1, simSecPerTick)));
  }

  setCurrent(tick) {
    this.currentTick = tick;
    if (tick > this.maxTick) this.maxTick = tick * 1.2;
    if (!this._dragging) this.scrub.value = String(Math.min(1000, Math.floor((tick / this.maxTick) * 1000)));
  }

  setBookmarks(list) { this.bookmarks = list; }
}
