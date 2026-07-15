// core/clock.js
// Fixed-timestep logical clock with time-warp, per Appendix B.
//
// Wall-clock time and render framerate are fully decoupled from sim-time. The renderer
// interpolates between the last two sim states using `alpha`. The integer `tick` counter
// is the canonical time — everything deterministic keys off it, never off wall-clock.
//
// Two integration modes:
//   - 'bio'  : each tick advances BASE_DT sim-seconds (full biological fidelity).
//   - 'stat' : each tick advances many sim-YEARS (statistical population dynamics).
// The warp level selects the mode; determinism holds either way because the tick counter
// is canonical and each mode is a pure function of (state, tick).

export const BASE_DT = 1 / 30; // sim-seconds per biological tick (also the physics substep)
export const TICK_RATE = 30;   // canonical logical ticks per real second

const YEAR_SECONDS = 365.25 * 24 * 3600;

// Warp table. `simSecPerRealSec` is the target mapping used to size the accumulator.
// `mode` selects the integration path; `simYearsPerTick` is only meaningful in 'stat' mode.
// `lodBias` nudges the LOD manager toward statistical representation as warp rises.
export const WARPS = [
  { id: 'real',       label: '1× Real',    simSecPerRealSec: 1,            mode: 'bio',  simYearsPerTick: 0,        lodBias: 0.0 },
  { id: 'hour',       label: 'Hour',       simSecPerRealSec: 3600,         mode: 'bio',  simYearsPerTick: 0,        lodBias: 0.1 },
  { id: 'day',        label: 'Day',        simSecPerRealSec: 86400,        mode: 'bio',  simYearsPerTick: 0,        lodBias: 0.25 },
  { id: 'year',       label: 'Year',       simSecPerRealSec: YEAR_SECONDS, mode: 'stat', simYearsPerTick: 1 / 30,   lodBias: 0.5 },
  { id: 'century',    label: 'Century',    simSecPerRealSec: YEAR_SECONDS * 100,   mode: 'stat', simYearsPerTick: 100 / 30,   lodBias: 0.7 },
  { id: 'millennium', label: 'Millennium', simSecPerRealSec: YEAR_SECONDS * 1e3,   mode: 'stat', simYearsPerTick: 1e3 / 30,   lodBias: 0.8 },
  { id: 'megayear',   label: 'Mega-year',  simSecPerRealSec: YEAR_SECONDS * 1e6,   mode: 'stat', simYearsPerTick: 1e6 / 30,   lodBias: 0.9,  geology: true },
  { id: 'epoch',      label: 'Epoch',      simSecPerRealSec: YEAR_SECONDS * 5e7,   mode: 'stat', simYearsPerTick: 5e7 / 30,   lodBias: 0.95, geology: true, climate: true },
  { id: 'eon',        label: 'Eon',        simSecPerRealSec: YEAR_SECONDS * 1e9,   mode: 'stat', simYearsPerTick: 1e9 / 30,   lodBias: 1.0,  geology: true, climate: true, star: true },
];

export function warpById(id) {
  for (let i = 0; i < WARPS.length; i++) if (WARPS[i].id === id) return WARPS[i];
  return WARPS[0];
}

export class Clock {
  constructor() {
    this.tick = 0;            // canonical logical time (integer)
    this.simSeconds = 0;      // accumulated sim-time in seconds (derived; for display)
    this.warpIndex = 0;
    this.paused = false;
    this.accumulator = 0;     // real-seconds * warp, drained in BASE_DT chunks
    this.alpha = 0;           // render interpolation factor in [0,1)
    this.maxSubSteps = 12;    // cap so a stalled tab cannot spiral (0.25s clamp => ≤7.5 ticks)
  }

  get warp() {
    return WARPS[this.warpIndex];
  }

  setWarpIndex(i) {
    this.warpIndex = Math.max(0, Math.min(WARPS.length - 1, i | 0));
  }

  warpUp() {
    this.setWarpIndex(this.warpIndex + 1);
  }

  warpDown() {
    this.setWarpIndex(this.warpIndex - 1);
  }

  togglePause() {
    this.paused = !this.paused;
  }

  // Sim-time advanced per tick at the current warp. The tick CADENCE is fixed
  // (TICK_RATE ticks/sec of real time); warp scales how much sim-time each tick represents.
  // At 'real' this is BASE_DT (1/30 s) so agents animate in real time; at higher warps each
  // tick carries more sim-time, so the world clock races while the tick loop stays bounded.
  get simSecPerTick() {
    return this.warp.simSecPerRealSec / TICK_RATE;
  }

  // Advance by a real-time delta, invoking `stepFn(dtSimSeconds, mode)` for each fixed tick.
  // Unified model (see simSecPerTick): the loop always runs at most TICK_RATE ticks/sec, each
  // advancing `simSecPerTick` sim-seconds and passing the warp's integration mode. This keeps
  // the tick budget bounded at every warp (no unbounded BASE_DT sub-stepping) while sim-time
  // still spans ≈12 orders of magnitude. Returns the number of ticks taken.
  //
  // In 'bio' mode the worker steps near-camera agent physics at fixed BASE_DT for stable
  // motion, but ages/metabolizes them by `dtSimSeconds`; in 'stat' mode it runs population
  // dynamics over `dtSimSeconds`. Either way the integer tick counter is canonical time.
  advance(realDeltaSeconds, stepFn) {
    if (this.paused) {
      this.alpha = 0;
      return 0;
    }
    const clamped = Math.min(Math.max(realDeltaSeconds, 0), 0.25); // clamp long frames (anti-spiral)
    this.accumulator += clamped * TICK_RATE; // accumulator counts whole ticks
    const dtSim = this.simSecPerTick;
    const mode = this.warp.mode;

    let steps = 0;
    while (this.accumulator >= 1 && steps < this.maxSubSteps) {
      stepFn(dtSim, mode);
      this.accumulator -= 1;
      this.tick++;
      this.simSeconds += dtSim;
      steps++;
    }
    this.alpha = Math.min(1, this.accumulator);
    // If we hit the cap, discard the backlog rather than spiral (drop fidelity, not correctness).
    if (steps >= this.maxSubSteps) this.accumulator = 0;
    return steps;
  }

  saveState() {
    return {
      tick: this.tick,
      simSeconds: this.simSeconds,
      warpIndex: this.warpIndex,
    };
  }

  loadState(st) {
    this.tick = st.tick | 0;
    this.simSeconds = st.simSeconds || 0;
    this.warpIndex = st.warpIndex | 0;
    this.accumulator = 0;
    this.alpha = 0;
    return this;
  }
}

// Format sim-seconds as a human-readable deep-time string for readouts.
export function formatSimTime(simSeconds) {
  const years = simSeconds / YEAR_SECONDS;
  if (years < 1) {
    const days = simSeconds / 86400;
    if (days < 1) return `${(simSeconds / 3600).toFixed(1)} hr`;
    return `${days.toFixed(1)} days`;
  }
  if (years < 1e3) return `${years.toFixed(0)} yr`;
  if (years < 1e6) return `${(years / 1e3).toFixed(2)} Kyr`;
  if (years < 1e9) return `${(years / 1e6).toFixed(2)} Myr`;
  return `${(years / 1e9).toFixed(3)} Gyr`;
}

export { YEAR_SECONDS };
