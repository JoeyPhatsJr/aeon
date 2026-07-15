// sim/world.js
// The world: a wrapped 2D surface (equirectangular cylinder, wraps in x) as a grid of cells
// stored structure-of-arrays in typed arrays, plus the full-fidelity agent pool and the tick
// loop that drives every subsystem. This is the seam where physics/chemistry (sim/, bio/) meet
// the deterministic core (core/). Nothing here imports render/ or ui/.
//
// Determinism: all randomness comes from named substreams of the master RNG; arrays are
// iterated by index; the integer tick is canonical time. Agents live in an object-pooled SoA
// so births/deaths never allocate in the hot loop.

import { RNG } from '../core/rng.js';
import { EventBus, EV } from '../core/events.js';
import { Star } from './star.js';
import { generateTerrain } from './tectonics.js';
import { stepTectonics } from './tectonics.js';
import { stepErosion } from './erosion.js';
import { stepClimate } from './climate.js';
import { Atmosphere } from './atmosphere.js';
import { rollAbiogenesis } from './abiogenesis.js';
import { PopulationField } from './population.js';
import { classifyBiome, biomeAlbedo } from '../data/biomes.js';
import { primordialGenome, brainSize, hasPart, PART, countPart, hasManipulator, recurrenceRatio } from '../bio/genome.js';
import { buildBody } from '../bio/bodyBuilder.js';
import { compileBrain, makeBrainState, stepBrain } from '../bio/brain.js';
import { IN, OUT } from '../bio/bodyBuilder.js';
import { stepMetabolism, corpseDetritus } from '../bio/metabolism.js';
import { InnovationRegistry, reproduceAsexual, crossover } from '../bio/reproduction.js';
import { Phylogeny, SpeciesClusters, genomeDistance, resetSpeciesCounter, setSpeciesCounter } from '../bio/speciation.js';
import { emergentLocomotion, integrateAgent, cellDrag, overlap } from '../bio/physics.js';
import { binomial, dominantTrait } from '../data/naming.js';
import { resetGenomeCounter, setGenomeCounter } from '../bio/genome.js';

export const MAX_AGENTS = 1400;

export class World {
  constructor(params, seed, interventions = []) {
    this.params = params;
    this.seed = typeof seed === 'bigint' ? seed : RNG.toSeed64(String(seed));
    this.interventions = interventions.slice();
    this.rng = new RNG(this.seed);
    // Named substreams (Appendix A).
    this.rngGeology = this.rng.fork('geology');
    this.rngWeather = this.rng.fork('weather');
    this.rngMutation = this.rng.fork('mutation');
    this.rngAbio = this.rng.fork('abiogenesis');
    this.rngMating = this.rng.fork('mating');
    this.rngCatastrophe = this.rng.fork('catastrophe');
    this.rngCiv = this.rng.fork('civ');

    // Per-world id counters (see genome.setGenomeCounter): bind BEFORE any genome/species is
    // created so this world never shares id state with another coexisting world.
    this.genomeCounter = { v: 0 };
    this.speciesCounter = { v: 0 };
    setGenomeCounter(this.genomeCounter);
    setSpeciesCounter(this.speciesCounter);
    resetGenomeCounter(0);
    resetSpeciesCounter(0);

    this.bus = new EventBus();
    this.tick = 0;
    this.simSeconds = 0;

    // Grid.
    this.W = Math.max(64, Math.min(512, params.gridRes | 0));
    this.H = this.W >> 1;
    const N = this.W * this.H;
    this.N = N;
    this.elevation = new Float32Array(N);
    this.crustAge = new Float32Array(N);
    this.plateId = new Int16Array(N);
    this.temperature = new Float32Array(N);
    this.waterDepth = new Float32Array(N);
    this.soilMoisture = new Float32Array(N);
    this.insolation = new Float32Array(N);
    this.nutrientN = new Float32Array(N);
    this.nutrientP = new Float32Array(N);
    this.nutrientMin = new Float32Array(N);
    this.biomeId = new Uint8Array(N);
    this.o2 = new Float32Array(N);
    this.co2 = new Float32Array(N);
    this.detritus = new Float32Array(N);
    this.densityRef = new Float32Array(N); // per-cell life density for LOD (aggregate)
    this.scent = new Float32Array(N);       // shared pheromone/scent field

    this.star = new Star(params.mass);
    this.atmosphere = new Atmosphere(params.co2_0, params.o2_0);
    this.population = new PopulationField(this);
    this.phylo = new Phylogeny();
    this.clusters = new SpeciesClusters(this.phylo);
    this.innov = new InnovationRegistry();

    // Genome/body/brain caches keyed by agent slot.
    this.genomes = new Array(MAX_AGENTS).fill(null);
    this.bodies = new Array(MAX_AGENTS).fill(null);
    this.brainPlans = new Array(MAX_AGENTS).fill(null);
    this.brainStates = new Array(MAX_AGENTS).fill(null);

    // Agent pool (SoA).
    this.alive = new Uint8Array(MAX_AGENTS);
    this.ax = new Float32Array(MAX_AGENTS);
    this.ay = new Float32Array(MAX_AGENTS);
    this.avx = new Float32Array(MAX_AGENTS);
    this.avy = new Float32Array(MAX_AGENTS);
    this.aheading = new Float32Array(MAX_AGENTS);
    this.aenergy = new Float32Array(MAX_AGENTS);
    this.aage = new Float32Array(MAX_AGENTS);
    this.aspecies = new Int32Array(MAX_AGENTS);
    this.amass = new Float32Array(MAX_AGENTS);
    this.aradius = new Float32Array(MAX_AGENTS);
    this.freeList = [];
    for (let i = MAX_AGENTS - 1; i >= 0; i--) this.freeList.push(i);
    this.agentCount = 0;

    // Milestone flags for one-shot events.
    this._milestones = new Set();

    // Deep-time milestone bookkeeping for civ.
    this.civ = null; // populated by civ layer when a lineage crosses thresholds

    this.lifeExists = false;
    this.oxygenated = false;

    // Intervention queue sorted by tick.
    this.interventions.sort((a, b) => a.tick - b.tick);
    this._interventionIdx = 0;

    generateTerrain(this);
    // Initialize climate/biomes once so a lifeless world still looks real.
    stepClimate(this, 0.0, true);
    this.classifyAll();
  }

  idx(x, y) { return y * this.W + this.wrapX(x); }
  wrapX(x) { x %= this.W; return x < 0 ? x + this.W : x; }
  clampY(y) { return y < 0 ? 0 : y >= this.H ? this.H - 1 : y; }

  classifyAll() {
    for (let i = 0; i < this.N; i++) {
      this.biomeId[i] = classifyBiome(this.temperature[i], this.soilMoisture[i], this.elevation[i], this.waterDepth[i]);
    }
  }

  milestone(key, ev, payload) {
    if (this._milestones.has(key)) return false;
    this._milestones.add(key);
    this.bus.emit(ev, { tick: this.tick, simSeconds: this.simSeconds, ...payload });
    return true;
  }

  // ---- Main tick ----
  step(dtSim, mode, warp) {
    // Rebind the active per-world id counters so that if another world was stepped in between
    // (re-sim, self-test), genome/species ids stay bound to THIS world — the determinism seam.
    setGenomeCounter(this.genomeCounter);
    setSpeciesCounter(this.speciesCounter);
    this.applyDueInterventions();

    // Star drives insolation; evaluate every tick (cheap).
    this.star.evaluate(this.simSeconds, this.bus);

    // Geology only advances at mega-year+ warps (Appendix H, clock flags).
    if (warp && warp.geology) {
      stepTectonics(this, dtSim);
      if ((this.tick & 3) === 0) stepErosion(this, dtSim);
      this.classifyAll();
    }

    // Climate: throttle at low warp (expensive) but always run at climate warps.
    const climateEvery = warp && warp.climate ? 1 : 8;
    if ((this.tick % climateEvery) === 0) {
      stepClimate(this, dtSim, false);
      if (!(warp && warp.geology)) this.classifyAll();
    }

    // Atmosphere / chemistry.
    this.atmosphere.step(this, dtSim);

    // Abiogenesis: only before life, in the right cells.
    if (!this.lifeExists) {
      const born = rollAbiogenesis(this, dtSim);
      if (born) this.spawnFirstLife(born);
    }

    // Life.
    if (mode === 'bio') {
      this.stepAgents(dtSim);
    }
    // Statistical populations always advance (they carry the bulk / off-screen life).
    this.population.step(dtSim, mode);

    // Decay the scent field.
    this.decayScent(dtSim);

    this.tick++;
    this.simSeconds += dtSim;
  }

  decayScent(dtSim) {
    const d = Math.min(1, 0.02 * Math.max(1, dtSim));
    for (let i = 0; i < this.N; i++) this.scent[i] *= (1 - d);
  }

  // ---- Abiogenesis: create the first replicator lineage ----
  spawnFirstLife(cellIdx) {
    this.lifeExists = true;
    const lineageId = 1;
    const g = primordialGenome(lineageId);
    const trait = 'photo';
    const name = binomial(this.seed, lineageId, trait);
    const sp = this.phylo.create(g, this.tick, -1, name.full, name.etymology);
    sp.trophicRole = 'auto';
    this.clusters.addRep(sp.id, g);
    const x = cellIdx % this.W, y = (cellIdx / this.W) | 0;
    // Seed a small founding population of full-fidelity agents...
    for (let k = 0; k < 8; k++) {
      this.spawnAgent(g, sp.id, x + this.rngAbio.range(-1, 1), y + this.rngAbio.range(-1, 1), 1.0);
    }
    // ...and a statistical population in the region so life persists and drifts at high warp,
    // ready to be promoted back to agents whenever the player zooms in.
    this.population.seed(sp.id, g, this.population.regionOf(x, y), 24);
    this.milestone('first_life', EV.FIRST_LIFE, { species: sp.name, cell: cellIdx });
  }

  // ---- Agent pool ----
  spawnAgent(genome, speciesId, x, y, energy) {
    if (this.freeList.length === 0) return -1;
    const slot = this.freeList.pop();
    this.alive[slot] = 1;
    this.genomes[slot] = genome;
    const body = buildBody(genome);
    this.bodies[slot] = body;
    const plan = compileBrain(genome);
    this.brainPlans[slot] = plan;
    this.brainStates[slot] = makeBrainState(plan);
    this.ax[slot] = this.wrapX(x);
    this.ay[slot] = this.clampY(y | 0) + (y - (y | 0));
    this.avx[slot] = 0; this.avy[slot] = 0;
    this.aheading[slot] = this.rngMating.range(0, Math.PI * 2);
    this.aenergy[slot] = energy;
    this.aage[slot] = 0;
    this.aspecies[slot] = speciesId;
    this.amass[slot] = body.totalMass;
    this.aradius[slot] = Math.max(0.2, Math.sqrt(body.totalMass) * 0.5);
    this.agentCount++;
    return slot;
  }

  killAgent(slot, toDetritus) {
    if (!this.alive[slot]) return;
    this.alive[slot] = 0;
    if (toDetritus) {
      const ci = this.idx(this.ax[slot] | 0, this.ay[slot] | 0);
      this.detritus[ci] += corpseDetritus({ energy: this.aenergy[slot], mass: this.amass[slot] });
    }
    this.genomes[slot] = null; this.bodies[slot] = null; this.brainPlans[slot] = null; this.brainStates[slot] = null;
    this.freeList.push(slot);
    this.agentCount--;
  }

  // Fill a brain input vector from the agent's senses + local world.
  fillInputs(slot, inputsOut) {
    const plan = this.brainPlans[slot];
    const body = this.bodies[slot];
    const channels = body.inputChannels;
    const x = this.ax[slot], y = this.ay[slot];
    const ci = this.idx(x | 0, y | 0);
    const energyFrac = Math.min(1, this.aenergy[slot] / 5);
    const ageFrac = Math.min(1, this.aage[slot] / Math.max(1, this.genomes[slot].life.maxLifespan));
    const nearest = this._nearestScan(slot);
    const n = Math.min(plan.inputCount, channels.length);
    for (let i = 0; i < plan.inputCount; i++) inputsOut[i] = 0;
    for (let c = 0; c < n; c++) {
      const ch = channels[c];
      switch (ch.type) {
        case IN.EYE_FOOD_X: inputsOut[c] = nearest.foodX; break;
        case IN.EYE_FOOD_Y: inputsOut[c] = nearest.foodY; break;
        case IN.EYE_THREAT_X: inputsOut[c] = nearest.threatX; break;
        case IN.EYE_THREAT_Y: inputsOut[c] = nearest.threatY; break;
        case IN.EYE_CONSPEC_X: inputsOut[c] = nearest.conX; break;
        case IN.EYE_CONSPEC_Y: inputsOut[c] = nearest.conY; break;
        case IN.CHEMO_X: inputsOut[c] = this._scentGradX(ci); break;
        case IN.CHEMO_Y: inputsOut[c] = this._scentGradY(ci); break;
        case IN.PROP_ENERGY: inputsOut[c] = energyFrac * 2 - 1; break;
        case IN.PROP_AGE: inputsOut[c] = ageFrac * 2 - 1; break;
        case IN.PROP_JOINT: inputsOut[c] = 0; break; // filled by joint state below if desired
        case IN.THERMO: inputsOut[c] = Math.max(-1, Math.min(1, (this.temperature[ci] - 15) / 30)); break;
        case IN.OSC: inputsOut[c] = Math.sin(this.aage[slot] * 3 + slot); break;
        default: inputsOut[c] = 0;
      }
    }
  }

  // Scan a small neighborhood for nearest food (detritus or edible agent), threat (larger
  // agent), and conspecific. Returns normalized direction vectors. This is the SENSING the
  // brain acts on; it never labels roles — "threat" here just means a bigger agent nearby.
  _nearestScan(slot) {
    const x = this.ax[slot], y = this.ay[slot];
    const myMass = this.amass[slot];
    const mySpecies = this.aspecies[slot];
    const R = 6;
    let fdx = 0, fdy = 0, fbest = Infinity;
    let tdx = 0, tdy = 0, tbest = Infinity;
    let cdx = 0, cdy = 0, cbest = Infinity;
    // Nearby agents (brute force within R using the pool; agent counts are bounded).
    for (let s = 0; s < MAX_AGENTS; s++) {
      if (!this.alive[s] || s === slot) continue;
      let dx = this.ax[s] - x;
      // wrap-aware x distance
      if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
      const dy = this.ay[s] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      if (this.amass[s] > myMass * 1.3) { if (d2 < tbest) { tbest = d2; tdx = dx; tdy = dy; } }       // bigger => threat
      else if (this.amass[s] < myMass * 0.9) { if (d2 < fbest) { fbest = d2; fdx = dx; fdy = dy; } }   // smaller => potential food
      if (this.aspecies[s] === mySpecies) { if (d2 < cbest) { cbest = d2; cdx = dx; cdy = dy; } }
    }
    // Detritus in the local cell also counts as food direction (toward cell center of mass of
    // detritus — approximated as staying put if standing on detritus).
    const ci = this.idx(x | 0, y | 0);
    if (this.detritus[ci] > 0.1 && fbest === Infinity) { fdx = 0.0; fdy = 0.0; fbest = 0.1; }
    const norm = (dx, dy, has) => {
      if (!has) return [0, 0];
      const m = Math.hypot(dx, dy) || 1;
      return [dx / m, dy / m];
    };
    const [fx, fy] = norm(fdx, fdy, fbest < Infinity);
    const [txn, tyn] = norm(tdx, tdy, tbest < Infinity);
    const [cx, cy] = norm(cdx, cdy, cbest < Infinity);
    return { foodX: fx, foodY: fy, threatX: txn, threatY: tyn, conX: cx, conY: cy, foodDist: Math.sqrt(fbest) };
  }

  _scentGradX(ci) {
    const y = (ci / this.W) | 0, x = ci % this.W;
    return (this.scent[this.idx(x + 1, y)] - this.scent[this.idx(x - 1, y)]);
  }
  _scentGradY(ci) {
    const y = (ci / this.W) | 0, x = ci % this.W;
    const up = this.scent[this.idx(x, this.clampY(y - 1))];
    const dn = this.scent[this.idx(x, this.clampY(y + 1))];
    return dn - up;
  }

  // Step all full-fidelity agents one tick under the energy law.
  stepAgents(dtSim) {
    const inputs = this._inputScratch || (this._inputScratch = new Float32Array(64));
    const outputs = this._outputScratch || (this._outputScratch = new Float32Array(64));
    const dtPhys = Math.min(dtSim, 1 / 30);

    for (let slot = 0; slot < MAX_AGENTS; slot++) {
      if (!this.alive[slot]) continue;
      const genome = this.genomes[slot];
      const body = this.bodies[slot];
      const plan = this.brainPlans[slot];

      // Brain.
      this.fillInputs(slot, inputs);
      stepBrain(plan, this.brainStates[slot], inputs, null, outputs);

      // Decode outputs.
      const chans = body.outputChannels;
      let jointActivity = 0;
      const muscleVel = this._muscleVelScratch || (this._muscleVelScratch = new Float32Array(24));
      let mouth = 0, scentOut = 0, signal = 0, reproduceGate = 0;
      let mi = 0;
      const oc = Math.min(plan.outputCount, chans.length);
      for (let c = 0; c < oc; c++) {
        const ch = chans[c];
        const v = outputs[c] || 0;
        switch (ch.type) {
          case OUT.MUSCLE: muscleVel[mi] = v; jointActivity += Math.abs(v) * body.segments[body.muscles[mi]].muscleStrength; mi++; break;
          case OUT.MOUTH: mouth = v; break;
          case OUT.SCENT: scentOut = v; break;
          case OUT.SIGNAL: signal = v; break;
          case OUT.REPRODUCE: reproduceGate = v; break;
          default: break;
        }
      }

      // Locomotion (emergent).
      const ci = this.idx(this.ax[slot] | 0, this.ay[slot] | 0);
      const drag = cellDrag(this.waterDepth[ci]);
      const agentRef = { x: this.ax[slot], y: this.ay[slot], vx: this.avx[slot], vy: this.avy[slot], heading: this.aheading[slot] };
      const { thrust, turn } = emergentLocomotion(body, null, muscleVel);
      const speed = integrateAgent(agentRef, thrust, turn, drag, dtPhys);
      this.ax[slot] = this.wrapX(agentRef.x);
      this.ay[slot] = Math.max(0, Math.min(this.H - 1e-3, agentRef.y));
      this.avx[slot] = agentRef.vx; this.avy[slot] = agentRef.vy; this.aheading[slot] = agentRef.heading;

      // Eating: if mouth is open and something edible is in front / underfoot.
      let biteMass = 0;
      if (mouth > 0.2 && hasPart(genome, PART.MOUTH)) {
        biteMass = this._tryEat(slot, ci);
      }

      // Scent emission.
      if (scentOut > 0.3 && hasPart(genome, PART.EMIT_SCENT)) this.scent[ci] += scentOut * 0.5;
      void signal;

      // Metabolism (the one law).
      const ci2 = this.idx(this.ax[slot] | 0, this.ay[slot] | 0);
      const agentMeta = { energy: this.aenergy[slot], age: this.aage[slot], life: genome.life, mass: this.amass[slot] };
      const res = stepMetabolism(agentMeta, {
        insolation: this.insolation[ci2], o2: this.o2[ci2], temperature: this.temperature[ci2],
        tolLow: -8, tolHigh: 42, dt: dtSim, cognitionCost: this.params.cognitionCost,
        biteMass, jointActivity, speed, sensorCount: this._sensorCount(genome), brainUnits: brainSize(genome),
        mass: this.amass[slot], exposedArea: body.exposedArea, reproduceGate,
      });
      this.aenergy[slot] = res.energy;
      this.aage[slot] += dtSim;

      if (res.die) { this.killAgent(slot, true); continue; }
      if (res.ageHazard > 0 && this.rngCatastrophe.bool(res.ageHazard * dtSim)) { this.killAgent(slot, true); continue; }

      // Reproduction.
      if (this.aage[slot] > genome.life.maturationAge && reproduceGate > 0.4 && hasPart(genome, PART.REPRODUCE)) {
        this._tryReproduce(slot, genome, signal);
      }
    }
  }

  _sensorCount(genome) {
    let n = 0;
    for (let i = 0; i < genome.parts.length; i++) {
      const k = genome.parts[i].kind;
      if (k <= PART.THERMO) n++;
    }
    return n;
  }

  // Attempt to eat: prefer a nearby smaller agent (predation), else consume local detritus
  // (decomposition) or nothing. Whichever pays is discovered by selection, not scripted here.
  _tryEat(slot, ci) {
    const x = this.ax[slot], y = this.ay[slot];
    const r = this.aradius[slot] + 0.6;
    // Predation: nearest smaller live agent within reach.
    for (let s = 0; s < MAX_AGENTS; s++) {
      if (!this.alive[s] || s === slot) continue;
      if (this.amass[s] > this.amass[slot] * 0.9) continue;
      let dx = this.ax[s] - x; if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
      const dy = this.ay[s] - y;
      if (overlap(0, 0, r, dx, dy, this.aradius[s])) {
        const gained = this.amass[s] + Math.max(0, this.aenergy[s]) * 0.5;
        this.killAgent(s, false);
        this.milestone('first_predator', EV.FIRST_PREDATOR, {});
        return gained;
      }
    }
    // Decomposition: eat local detritus.
    if (this.detritus[ci] > 0.05) {
      const bite = Math.min(this.detritus[ci], 0.5);
      this.detritus[ci] -= bite;
      return bite;
    }
    return 0;
  }

  _tryReproduce(slot, genome, signal) {
    const invest = genome.life.offspringInvestment;
    const cost = 0.6 + invest * 2.5;
    if (this.aenergy[slot] < cost + 0.4) return;
    if (this.freeList.length === 0) return;

    let child;
    if (genome.reproMode === 1) {
      // Sexual: find a nearby mature conspecific.
      const mate = this._findMate(slot);
      if (mate < 0) return;
      child = crossover(genome, this.genomes[mate], this.rngMating, this.params.baseMutation, this.innov);
    } else {
      child = reproduceAsexual(genome, this.rngMutation, this.params.baseMutation, this.innov);
    }
    this.aenergy[slot] -= cost;
    // Offspring energy from investment: few-large vs many-small.
    const childEnergy = 0.4 + invest * 1.5;
    const speciesId = this.assignSpecies(child, this.aspecies[slot]);
    this.spawnAgent(child, speciesId, this.ax[slot] + this.rngMating.range(-1, 1), this.ay[slot] + this.rngMating.range(-1, 1), childEnergy);
    void signal;
  }

  _findMate(slot) {
    const x = this.ax[slot], y = this.ay[slot], sp = this.aspecies[slot];
    for (let s = 0; s < MAX_AGENTS; s++) {
      if (!this.alive[s] || s === slot || this.aspecies[s] !== sp) continue;
      if (this.aage[s] < this.genomes[s].life.maturationAge) continue;
      let dx = this.ax[s] - x; if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
      const dy = this.ay[s] - y;
      if (dx * dx + dy * dy < 9) return s;
    }
    return -1;
  }

  // Assign a child to a species; if it drifts beyond threshold from all reps, fork a new
  // species and record the split in the phylogeny (emergent speciation).
  assignSpecies(childGenome, parentSpeciesId) {
    const parentRep = this.phylo.get(parentSpeciesId);
    if (parentRep && genomeDistance(childGenome, parentRep.representative) < this.clusters.threshold) {
      return parentSpeciesId;
    }
    const matched = this.clusters.match(childGenome);
    if (matched >= 0) return matched;
    // New species.
    const trait = this._traitOf(childGenome);
    const name = binomial(this.seed, childGenome.lineageId || parentSpeciesId, trait);
    const sp = this.phylo.create(childGenome, this.tick, parentSpeciesId, name.full, name.etymology);
    sp.trophicRole = this._roleOf(childGenome);
    this.clusters.addRep(sp.id, childGenome);
    this.milestone('speciation_' + sp.id, EV.SPECIATION, { species: sp.name, parent: parentRep ? parentRep.name : '—' });
    return sp.id;
  }

  _traitOf(g) {
    return dominantTrait({
      speed: 1, mass: buildBodyMass(g), brainUnits: brainSize(g),
      sociality: hasPart(g, PART.SIGNAL) ? 0.6 : 0.1,
      photoCap: g.life.photoCap, digestCap: g.life.digestCap, recurrence: recurrenceRatio(g),
      temperature: 15, aquatic: false, camo: g.morph[0] ? (1 - g.morph[0].sat) : 0.3,
      bright: g.morph[0] ? g.morph[0].sat : 0.4, deep: false,
    });
  }

  _roleOf(g) {
    if (g.life.digestCap > g.life.photoCap * 1.3) return 'pred';
    if (g.life.photoCap > 0.5) return 'auto';
    if (hasPart(g, PART.MOUTH) && g.life.digestCap > 0.2) return 'herb';
    return 'decomp';
  }

  // ---- Interventions (god tools) ----
  applyDueInterventions() {
    while (this._interventionIdx < this.interventions.length && this.interventions[this._interventionIdx].tick <= this.tick) {
      this.applyIntervention(this.interventions[this._interventionIdx]);
      this._interventionIdx++;
    }
  }

  // Queue a live intervention (from the god tools). It is appended and applied at its tick so
  // it travels in the save and keeps determinism.
  queueIntervention(type, params) {
    const iv = { tick: this.tick, type, params: params || {} };
    // Insert in order.
    let i = this.interventions.length;
    while (i > 0 && this.interventions[i - 1].tick > iv.tick) i--;
    this.interventions.splice(i, 0, iv);
    // If it is due now (tick <= current), make sure the pointer will catch it.
    if (i <= this._interventionIdx) this._interventionIdx = i;
    return iv;
  }

  applyIntervention(iv) {
    const p = iv.params || {};
    switch (iv.type) {
      case 'temp': for (let i = 0; i < this.N; i++) this.temperature[i] += p.delta || 0; break;
      case 'sealevel': this._adjustSeaLevel(p.delta || 0); break;
      case 'co2': this.atmosphere.co2 = Math.max(0, this.atmosphere.co2 + (p.delta || 0)); break;
      case 'o2': this.atmosphere.o2 = Math.max(0, this.atmosphere.o2 + (p.delta || 0)); break;
      case 'meteor': this._meteor(p.x, p.y, p.size || 1); break;
      case 'iceage': for (let i = 0; i < this.N; i++) this.temperature[i] -= 12; this.milestone('iv_iceage_' + this.tick, EV.VOLCANIC_WINTER, {}); break;
      case 'mutationburst': this._mutationBurst(p.factor || 3); break;
      case 'protect': this._protected = p.speciesId; break;
      case 'cull': this._cullSpecies(p.speciesId); break;
      default: break;
    }
    this.bus.emit(EV.INTERVENTION, { type: iv.type, tick: this.tick });
  }

  _adjustSeaLevel(delta) {
    for (let i = 0; i < this.N; i++) {
      this.waterDepth[i] = Math.max(0, this.waterDepth[i] + delta - (this.elevation[i] > 0 ? 0 : 0));
      if (this.elevation[i] < delta) this.waterDepth[i] = Math.max(this.waterDepth[i], delta - this.elevation[i]);
    }
    this.classifyAll();
  }

  _meteor(mx, my, size) {
    const cx = mx != null ? mx : this.rngCatastrophe.int(this.W);
    const cy = my != null ? my : this.rngCatastrophe.int(this.H);
    const R = 6 * size;
    for (let s = 0; s < MAX_AGENTS; s++) {
      if (!this.alive[s]) continue;
      let dx = this.ax[s] - cx; if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
      const dy = this.ay[s] - cy;
      if (dx * dx + dy * dy < R * R) this.killAgent(s, true);
    }
    // Inject dust: cool the world, and CO2 from impact.
    for (let i = 0; i < this.N; i++) this.temperature[i] -= 4 * size * Math.exp(-2);
    this.atmosphere.co2 += 0.05 * size;
    this.population.impact(cx, cy, R);
    this.milestone('meteor_' + this.tick, EV.METEOR_IMPACT, { size });
    if (size >= 3) this.milestone('massext_' + this.tick, EV.MASS_EXTINCTION, { cause: 'meteor' });
  }

  _mutationBurst(factor) {
    // Temporarily raise effective base mutation for a window (applied by nudging the field).
    this._mutationBoost = { factor, until: this.tick + 300 };
  }

  _cullSpecies(speciesId) {
    for (let s = 0; s < MAX_AGENTS; s++) if (this.alive[s] && this.aspecies[s] === speciesId) this.killAgent(s, true);
    this.population.cull(speciesId);
    this.phylo.extinct(speciesId, this.tick);
  }

  // ---- Snapshot / hash for selftest & scrubbing ----
  hashInto(h) {
    h.int32(this.tick);
    h.floatArray(this.elevation, 1e2, 7);      // sample every 7th cell (cheap, still sensitive)
    h.floatArray(this.temperature, 1e2, 7);
    h.floatArray(this.waterDepth, 1e2, 7);
    h.float(this.atmosphere.o2, 1e4); h.float(this.atmosphere.co2, 1e4);
    h.int32(this.agentCount);
    h.float(this.star.luminosity, 1e2);
    // Agent energies (order-stable by slot).
    for (let s = 0; s < MAX_AGENTS; s++) if (this.alive[s]) { h.int32(s); h.float(this.aenergy[s], 1e2); h.int32(this.aspecies[s]); }
    h.int32(this.phylo.aliveCount());
  }
}

// Small helper: total mass of a genome's body without holding the body (used for naming).
function buildBodyMass(g) {
  let m = 0;
  for (let i = 0; i < g.morph.length; i++) {
    const s = g.morph[i];
    m += Math.PI * s.radius * s.radius * s.length * s.density;
  }
  return Math.max(0.05, m);
}
