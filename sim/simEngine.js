// sim/simEngine.js
// The simulation engine, decoupled from its driver. It owns the World, the civ layer, and the
// clock; it exposes handle(msg) for control and tick(realDt) to advance + emit a frame. It does
// NOT schedule itself — the worker wrapper (sim/simWorker.js) drives it on a timer, and the
// main-thread fallback (core/simHost.js) drives it on rAF. Same logic either way, so there is
// exactly one code path to keep deterministic.
//
// Output goes through `emit(msg, transferList)`. Frames carry the painted world RGBA and a
// packed agent array as transferable buffers (ARCHITECTURE §1.4), plus small structured stats
// and the queued milestone events for the Chronicle.

import { World } from './world.js';
import { Clock, warpById, formatSimTime } from '../core/clock.js';
import { paintWorldRGBA } from '../render/worldRenderer.js';
import { IntelligenceLayer } from '../civ/intelligence.js';
import { PHASE_NAME, worldLifetime } from './star.js';
import { EV } from '../core/events.js';
import { N_REGIONS } from './population.js';

const FRAME_INTERVAL = 1 / 30; // emit at most ~30 frames/sec of state

export class SimEngine {
  constructor(emit) {
    this.emit = emit;
    this.world = null;
    this.civ = null;
    this.clock = new Clock();
    this.camera = { zoom01: 0.4, cx: 0, cy: 0, region: -1 };
    this.overlay = 'biome';
    this.selectedSlot = -1;
    this._events = [];
    this._frameAccum = 0;
    this._agentBudget = 500;
    this._rgba = null;
    this._lastEmit = 0;
  }

  handle(msg) {
    switch (msg.type) {
      case 'init': this._init(msg); break;
      case 'setWarp': this.clock.setWarpIndex(msg.index); break;
      case 'setPaused': this.clock.paused = !!msg.paused; break;
      case 'camera': this.camera.zoom01 = msg.zoom ?? this.camera.zoom01;
        if (msg.cx !== undefined) { this.camera.cx = msg.cx; this.camera.cy = msg.cy; } break;
      case 'overlay': this.overlay = msg.overlay; break;
      case 'intervention': if (this.world) { this.world.queueIntervention(msg.ivType, msg.params); this._pushIvEvent(msg); } break;
      case 'select': this.selectedSlot = this._findSlotBySpecies(msg.speciesId, msg.x, msg.y); break;
      case 'scrub': this._scrubTo(msg.tick); break;
      case 'save': this._emitSave(); break;
      default: break;
    }
  }

  _init(msg) {
    this.world = new World(msg.params, msg.seed, msg.interventions || []);
    this.civ = new IntelligenceLayer(this.world);
    this.clock = new Clock();
    this.clock.setWarpIndex(msg.warpIndex ?? 3);
    this._events = [];
    this.camera.cx = this.world.W / 2; this.camera.cy = this.world.H / 2;
    this._rgba = new Uint8ClampedArray(this.world.W * this.world.H * 4);
    // Subscribe to milestone events for the Chronicle.
    const watch = Object.values(EV);
    for (let i = 0; i < watch.length; i++) {
      const type = watch[i];
      this.world.bus.on(type, (p) => this._events.push({ type, tick: this.world.tick, simSeconds: this.world.simSeconds, ...p }));
    }
    this.emit({ type: 'ready', W: this.world.W, H: this.world.H, lifetime: worldLifetime(this.world.star.mass) });
    this._buildFrame(true);
  }

  // Advance the sim by a real-time delta and emit at most one frame per FRAME_INTERVAL.
  tick(realDt) {
    if (!this.world) return;
    const warp = this.clock.warp;
    this.clock.advance(realDt, (dt, mode) => {
      this.world.step(dt, mode, warp);
      this.civ.step();
      this._manageLOD(mode, warp);
    });
    this._frameAccum += realDt;
    if (this._frameAccum >= FRAME_INTERVAL) {
      this._frameAccum = 0;
      this._buildFrame(false);
    }
  }

  // Simplified LOD: at high warp / zoomed out we run purely statistical (fold any agents so the
  // pool stays cheap); at low warp / zoomed in we promote statistical populations near the
  // camera into full-fidelity agents up to a budget, so evolution is visibly happening.
  _manageLOD(mode, warp) {
    const w = this.world;
    const region = w.population.regionOf(this.camera.cx, this.camera.cy);
    this.camera.region = region;
    const wantFull = mode === 'bio' && this.camera.zoom01 > 0.15;

    if (!wantFull) {
      // Demote: fold agents back to statistics in their regions, then remove them.
      if (w.agentCount > 0 && warp.lodBias >= 0.5) {
        const byRegion = new Map();
        for (let s = 0; s < w.alive.length; s++) {
          if (!w.alive[s]) continue;
          const r = w.population.regionOf(w.ax[s], w.ay[s]);
          const key = w.aspecies[s] * 100 + r;
          if (!byRegion.has(key)) byRegion.set(key, { sp: w.aspecies[s], r, idx: [] });
          byRegion.get(key).idx.push(s);
        }
        byRegion.forEach((grp) => {
          w.population.fold(grp.sp, grp.r, grp.idx);
          for (let k = 0; k < grp.idx.length; k++) w.killAgent(grp.idx[k], false);
        });
      }
      return;
    }

    // Promote: instantiate agents near the camera. Prefer the camera region and its neighbors
    // (spatially honest). If life exists but hasn't spread to the visible neighborhood, fall
    // back to promoting the globally-dominant species into the camera region — so zooming in
    // during the biological era ALWAYS reveals living organisms (a UX-favoring LOD choice).
    if (w.agentCount < this._agentBudget) {
      let promoted = 0;
      const neigh = this._regionNeighborhood(region);
      for (let n = 0; n < neigh.length && w.agentCount < this._agentBudget; n++) {
        const r = neigh[n];
        w.population.species.forEach((a) => {
          if (promoted > 120 || w.agentCount >= this._agentBudget) return;
          if (a.counts[r] >= 1) promoted += w.population.instantiate(a.speciesId, r, Math.min(24, Math.max(6, Math.floor(a.counts[r]))));
        });
      }
      // Top-up: if the local neighborhood is sparse but life exists, seed the dominant species
      // into the camera region so zooming in during the biological era always reveals a lively
      // population (a UX-favoring LOD choice, documented in the README).
      if (promoted < 12 && w.lifeExists) {
        let best = null, bestC = 0;
        w.population.species.forEach((a) => {
          let c = 0; for (let r = 0; r < a.counts.length; r++) c += a.counts[r];
          if (c > bestC) { bestC = c; best = a; }
        });
        if (best && bestC >= 1) {
          if (best.counts[region] < 30) best.counts[region] += 30;
          w.population.instantiate(best.speciesId, region, 30);
        }
      }
    }
  }

  // The camera region plus its 8 wrap-aware neighbors (region grid is REGION_W×REGION_H).
  _regionNeighborhood(region) {
    const RW = 8, RH = 4; // must match population.REGION_W/H
    const rx = region % RW, ry = (region / RW) | 0;
    const out = [region];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = ((rx + dx) % RW + RW) % RW;
        const ny = ry + dy;
        if (ny < 0 || ny >= RH) continue;
        out.push(ny * RW + nx);
      }
    }
    return out;
  }

  _buildFrame(initial) {
    const w = this.world;
    // Paint the world into the RGBA buffer, then copy into a fresh transferable ArrayBuffer.
    paintWorldRGBA(this._rgba, w.W, w.H, w, this.overlay, w.star.phase);
    const img = new Uint8ClampedArray(this._rgba.length);
    img.set(this._rgba);

    // Pack alive agents: 8 floats each [x,y,radius,hue,sat,val,heading,segCount] + speciesId.
    const FIELDS = 9;
    const agentBuf = new Float32Array(Math.min(w.agentCount, this._agentBudget) * FIELDS);
    let ai = 0;
    for (let s = 0; s < w.alive.length && ai < agentBuf.length; s++) {
      if (!w.alive[s]) continue;
      const g = w.genomes[s]; const body = w.bodies[s];
      const m0 = g && g.morph[0] ? g.morph[0] : { hue: 0.3, sat: 0.5, val: 0.6 };
      agentBuf[ai] = w.ax[s]; agentBuf[ai + 1] = w.ay[s]; agentBuf[ai + 2] = w.aradius[s];
      agentBuf[ai + 3] = m0.hue; agentBuf[ai + 4] = m0.sat; agentBuf[ai + 5] = m0.val;
      agentBuf[ai + 6] = w.aheading[s]; agentBuf[ai + 7] = body ? body.segmentCount : 3;
      agentBuf[ai + 8] = w.aspecies[s];
      ai += FIELDS;
    }

    const events = this._events;
    this._events = [];
    const stats = this._stats();
    const selected = this._selectedInfo();

    this.emit({
      type: 'frame', W: w.W, H: w.H, fields: FIELDS,
      image: img.buffer, agents: agentBuf.buffer, agentCount: ai / FIELDS,
      stats, events, selected, initial: !!initial,
    }, [img.buffer, agentBuf.buffer]);

    // Throttled Tree-of-Life data (structured clone; small, sent ~once a second).
    this._treeFrame = (this._treeFrame || 0) + 1;
    if (initial || this._treeFrame % 15 === 0) this._emitTree();
  }

  _emitTree() {
    const w = this.world;
    // Send a manageable subset: all living species plus the most significant recent extinct
    // ones (by peak population), capped — the Tree of Life stays legible over deep time.
    const all = [];
    w.phylo.species.forEach((s) => all.push(s));
    const living = all.filter((s) => s.deathTick < 0);
    const extinct = all.filter((s) => s.deathTick >= 0).sort((a, b) => (b.peakPopulation - a.peakPopulation) || (b.deathTick - a.deathTick));
    const chosen = living.concat(extinct.slice(0, Math.max(0, 160 - living.length)));
    const species = chosen.map((s) => ({ id: s.id, name: s.name, parentId: s.parentId, birthTick: s.birthTick, deathTick: s.deathTick, population: s.population, role: s.trophicRole }));
    this.emit({ type: 'tree', species, nowTick: w.tick });
  }

  _stats() {
    const w = this.world;
    let statPop = 0, statSpecies = 0;
    w.population.species.forEach((a) => {
      let c = 0; for (let r = 0; r < N_REGIONS; r++) c += a.counts[r];
      if (c > 0.5) { statSpecies++; statPop += c; }
    });
    return {
      tick: w.tick,
      simSeconds: w.simSeconds,
      timeLabel: formatSimTime(w.simSeconds),
      warp: this.clock.warpIndex,
      paused: this.clock.paused,
      agentCount: w.agentCount,
      statSpecies,
      statPop: Math.round(statPop),
      livingSpecies: w.phylo.aliveCount(),
      totalSpecies: w.phylo.species.size,
      lodTier: this.clock.warp.lodBias >= 0.6 ? 'statistical' : (w.agentCount > 0 ? 'mixed' : 'statistical'),
      starPhase: PHASE_NAME[w.star.phase],
      starPhaseId: w.star.phase,
      luminosity: w.star.luminosity,
      o2: w.atmosphere.o2,
      co2: w.atmosphere.co2,
      lifeExists: w.lifeExists,
      oxygenated: w.oxygenated,
      civCount: this.civ ? this.civ.civilizations.size : 0,
      lifetime: worldLifetime(w.star.mass),
      milestones: Array.from(w._milestones).length,
    };
  }

  _selectedInfo() {
    const w = this.world;
    const s = this.selectedSlot;
    if (s < 0 || s >= w.alive.length || !w.alive[s]) return null;
    const g = w.genomes[s]; const plan = w.brainPlans[s]; const bs = w.brainStates[s];
    const sp = w.phylo.get(w.aspecies[s]);
    // Brain viz data.
    const nodes = g.nodes.map((n) => ({ id: n.id, kind: n.kind }));
    const idMap = new Map(); g.nodes.forEach((n, i) => idMap.set(n.id, i));
    const edges = [];
    for (let i = 0; i < g.conns.length; i++) { const c = g.conns[i]; if (!c.enabled) continue; const a = idMap.get(c.inNode), b = idMap.get(c.outNode); if (a !== undefined && b !== undefined) edges.push({ from: a, to: b, weight: c.weight }); }
    const activations = bs ? Array.from(bs.cur) : [];
    return {
      slot: s, speciesId: w.aspecies[s], name: sp ? sp.name : '—', etymology: sp ? sp.etymology : '',
      energy: w.aenergy[s], age: w.aage[s], mass: w.amass[s], generation: g.generation,
      segments: w.bodies[s] ? w.bodies[s].segmentCount : 0,
      brainNodes: g.nodes.length, brainConns: g.conns.length,
      photoCap: g.life.photoCap, digestCap: g.life.digestCap, maxLifespan: g.life.maxLifespan,
      brain: { nodes, edges }, activations,
      trophic: sp ? sp.trophicRole : 'auto',
    };
  }

  _findSlotBySpecies(speciesId, wx, wy) {
    const w = this.world;
    let best = -1, bestD = Infinity;
    for (let s = 0; s < w.alive.length; s++) {
      if (!w.alive[s]) continue;
      if (speciesId >= 0 && w.aspecies[s] !== speciesId) continue;
      if (wx !== undefined) {
        let dx = w.ax[s] - wx; if (dx > w.W / 2) dx -= w.W; else if (dx < -w.W / 2) dx += w.W;
        const dy = w.ay[s] - wy; const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      } else { return s; }
    }
    return best;
  }

  _pushIvEvent(msg) {
    this._events.push({ type: EV.INTERVENTION, tick: this.world.tick, simSeconds: this.world.simSeconds, ivType: msg.ivType });
  }

  // Deterministic scrub: recreate the world from seed + interventions and fast-run to `tick`.
  // Simple and correct (no snapshot deserialization); slower for deep targets but always exact.
  _scrubTo(targetTick) {
    if (!this.world || targetTick >= this.world.tick) return;
    const params = this.world.params;
    const seed = this.world.seed;
    const interventions = this.world.interventions;
    this.world = new World(params, seed, interventions);
    this.civ = new IntelligenceLayer(this.world);
    this._rgba = new Uint8ClampedArray(this.world.W * this.world.H * 4);
    const wsub = Object.values(EV);
    for (let i = 0; i < wsub.length; i++) { const t = wsub[i]; this.world.bus.on(t, (p) => this._events.push({ type: t, tick: this.world.tick, simSeconds: this.world.simSeconds, ...p })); }
    const warp = this.clock.warp;
    // Fast-run headless (statistical) to the target tick.
    const dt = this.clock.simSecPerTick;
    for (let t = 0; t < targetTick; t++) { this.world.step(dt, warp.mode, warp); this.civ.step(); }
    this._events = []; // suppress replayed events
    this._buildFrame(true);
  }

  _emitSave() {
    const w = this.world;
    this.emit({ type: 'save', world: { seed: w.seed.toString(), params: w.params, interventions: w.interventions } });
  }
}
