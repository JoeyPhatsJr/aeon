// bio/metabolism.js
// THE ONE LAW OF ENERGY (Appendix E). This is the ONLY selection code in AEON, together with
// birth (reproduction.js) and death (here). There is deliberately NO term anywhere that
// references a species "role": no isPredator, no isHerbivore, no reward for being social or
// smart. Predation, herbivory, decomposition, parasitism, pack-hunting, camouflage, and
// intelligence are all EXPRESSED STRATEGIES — outcomes of body + brain + placement under this
// energy budget — never assigned. Fitness is never written down; it is simply whether a genome
// makes more surviving copies of itself.
//
// If you are auditing for hand-authored fitness: grep this whole repo for `predator`,
// `herbivore`, `reward`, `fitness`. The only hits are in comments like this one and in derived
// *labels* the UI computes for display (trophic role is inferred post-hoc from realized diet,
// and never feeds back into selection).

// Tunable constants. k_brain is the gatekeeper of intelligence: a bigger brain costs energy
// every tick, so cognition only spreads when it materially improves energy capture. It is
// scaled by the world's "cognition cost" setting.
export const K = {
  brain: 0.0012,     // per (node + active-connection) per unit mass-time; scaled by cognitionCost
  move: 0.02,        // drag coefficient on speed^2
  sense: 0.0006,     // per sensor per tick
  actuation: 0.15,   // per unit |torque·Δangle|
  biteEnergy: 6.0,   // energy per unit edible mass successfully bitten
  photoBase: 1.0,    // scales photosynthesis
  detritusValue: 0.4,// structural energy a corpse contributes to detritus
  tempDrainPerDeg: 0.004, // energy drain per degree outside tolerance per tick
  ageMortalityScale: 0.02, // mortality slope past maxLifespan
};

// Aerobic factor: large aerobic bodies need O2; anaerobes tolerate low O2 but cap smaller.
// o2 in [0,1] (fraction of modern). Returns a multiplier on photosynthetic/metabolic gain and
// an implicit size penalty applied by callers via mass. This models the Great Oxygenation
// enabling larger bodies (and stressing anaerobes) WITHOUT scripting the event.
export function aerobicFactor(o2, mass) {
  // Small bodies fine anaerobically; big bodies scale with O2 availability.
  const need = Math.min(1, mass / 4); // bigger => needs more O2
  return (1 - need) + need * Math.min(1, o2 / 0.5);
}

// Photosynthetic energy gain for this tick.
export function photosynthesis(life, exposedArea, insolation, o2, mass, dt) {
  const af = aerobicFactor(o2, mass);
  return K.photoBase * life.photoCap * insolation * exposedArea * af * dt;
}

// Metabolic cost for this tick. `jointActivity` = Σ |output·strength| across muscles this tick
// (a proxy for |torque·Δangle|). `speed` in world units/sec. `sensorCount` = number of sensor
// parts. `brainUnits` = nodes + active connections.
export function metabolicCost(life, mass, brainUnits, jointActivity, speed, sensorCount, cognitionCost, dt) {
  const basal = life.basalRate * mass;
  const brain = K.brain * cognitionCost * brainUnits;
  const actuation = K.actuation * jointActivity;
  const move = K.move * speed * speed;
  const sense = K.sense * sensorCount;
  return (basal + brain + actuation + move + sense) * dt;
}

// Full per-tick energy update for a full-fidelity agent. Mutates nothing; returns a result the
// caller applies. `ctx` carries the local world sample and the agent's realized actions.
//
// ctx = {
//   insolation, o2, temperature, tolLow, tolHigh, dt, cognitionCost,
//   biteMass,          // edible mass the agent's mouth contacted this tick (0 if none)
//   jointActivity, speed, sensorCount, brainUnits, mass, exposedArea,
//   reproduceGate,     // brain reproduce output in [-1,1]
// }
export function stepMetabolism(agent, ctx) {
  const life = agent.life;
  const gain =
    photosynthesis(life, ctx.exposedArea, ctx.insolation, ctx.o2, ctx.mass, ctx.dt) +
    life.digestCap * ctx.biteMass * K.biteEnergy;

  const cost = metabolicCost(
    life, ctx.mass, ctx.brainUnits, ctx.jointActivity, ctx.speed, ctx.sensorCount, ctx.cognitionCost, ctx.dt
  );

  // Efficiency applies to gain (assimilation), not to unavoidable upkeep.
  let energy = agent.energy + gain * life.efficiency - cost;

  // Temperature tolerance: excursions drain energy (sets the climate range limit on ranges).
  let tempDrain = 0;
  if (ctx.temperature < ctx.tolLow) tempDrain = (ctx.tolLow - ctx.temperature);
  else if (ctx.temperature > ctx.tolHigh) tempDrain = (ctx.temperature - ctx.tolHigh);
  if (tempDrain > 0) energy -= tempDrain * K.tempDrainPerDeg * ctx.dt;

  const result = { energy, die: false, cause: 0, ate: ctx.biteMass > 0 };

  if (energy <= 0) {
    result.die = true;
    result.cause = 1; // starvation
    result.energy = 0;
    return result;
  }

  // Age mortality: past maxLifespan, mortality rises. The caller rolls the actual death using
  // its RNG substream; we just report the hazard so death stays deterministic and centralized.
  result.ageHazard = agent.age > life.maxLifespan
    ? Math.min(0.5, (agent.age - life.maxLifespan) / life.maxLifespan * K.ageMortalityScale)
    : 0;

  return result;
}

// Energy a corpse deposits into the cell detritus pool.
export function corpseDetritus(agent) {
  return Math.max(0, agent.energy) + agent.mass * K.detritusValue;
}
