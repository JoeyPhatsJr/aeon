// bio/genome.js
// The genome — the ONLY thing that evolves. It encodes body, brain, and life-history
// together (Appendix C). A genome is a small header plus four gene tables. We store genes
// as plain JS arrays of fixed-shape records rather than one giant ArrayBuffer: genomes are
// variable-length and structurally mutated (add node/segment, duplicate subtree), which a
// fixed typed-array layout fights. The *agents* that express genomes are stored
// structure-of-arrays (see bio/physics + the agent pool); the genome is the compact
// blueprint, one per lineage-ish, shared by structurally-identical individuals.
//
// Every scalar has a documented range; codecs clamp to those ranges so mutation/crossover
// can never produce an invalid body. Enumerations are small integers with named constants.

// ---- Enumerations ----
export const JOINT = { FIXED: 0, HINGE: 1, BALL: 2 };
export const SYMMETRY = { NONE: 0, BILATERAL: 1, RADIAL: 2 };
export const ACT = { TANH: 0, RELU: 1, SIN: 2, GAUSS: 3 };
export const NODE = { IN: 0, HIDDEN: 1, OUT: 2, BIAS: 3 };
export const REPRO = { ASEXUAL: 0, SEXUAL: 1 };

// Sensor/effector kinds. Order matters for stable wiring.
export const PART = {
  EYE: 0, CHEMO: 1, PROPRIO: 2, THERMO: 3,      // sensors
  MUSCLE: 4, MOUTH: 5, EMIT_SCENT: 6, SIGNAL: 7, REPRODUCE: 8, // effectors
};
export const PART_IS_SENSOR = [true, true, true, true, false, false, false, false, false];

// ---- Field ranges (min, max) for clamping. Keys mirror record fields. ----
export const RANGE = {
  radius: [0.1, 3], length: [0.2, 6], density: [0.3, 2],
  jointMin: [-Math.PI, 0], jointMax: [0, Math.PI],
  muscleStrength: [0, 1], attachAngle: [-Math.PI, Math.PI],
  recursionLimit: [0, 4], hue: [0, 1], sat: [0, 1], val: [0.2, 1],
  patternScale: [0.2, 8],
  weight: [-4, 4],
  basalRate: [0.002, 0.05], photoCap: [0, 1.2], digestCap: [0, 1.2],
  efficiency: [0.3, 0.98], maturationAge: [3, 400], maxLifespan: [20, 4000],
  offspringInvestment: [0, 1], mutationRate: [0, 0.5],
  coneAngle: [0.2, Math.PI], senseRange: [1, 30], param: [0, 1],
};

export function clamp(field, v) {
  const r = RANGE[field];
  if (!r) return v;
  return v < r[0] ? r[0] : v > r[1] ? r[1] : v;
}

// ---- Genome factory ----
// The genome-id counter is held in a swappable object, NOT a bare module variable, so that
// two coexisting worlds (e.g. a live world + a snapshot re-sim) each get their OWN counter and
// never assign colliding/diverging ids. The World binds its counter with setGenomeCounter()
// in its constructor and at the top of every step. Assignment order within a world is driven
// by the deterministic sim loop, never wall-clock.
let _genomeCounter = { v: 0 };
export function setGenomeCounter(obj) { _genomeCounter = obj; }
export function nextGenomeId() { return ++_genomeCounter.v; }
export function resetGenomeCounter(v = 0) { _genomeCounter.v = v; }

// Create a MorphGene record. parentIndex -1 == root.
export function morphGene(o = {}) {
  return {
    parentIndex: o.parentIndex ?? -1,
    radius: clamp('radius', o.radius ?? 0.5),
    length: clamp('length', o.length ?? 1.0),
    density: clamp('density', o.density ?? 1.0),
    jointType: o.jointType ?? JOINT.HINGE,
    jointMin: clamp('jointMin', o.jointMin ?? -0.8),
    jointMax: clamp('jointMax', o.jointMax ?? 0.8),
    muscleStrength: clamp('muscleStrength', o.muscleStrength ?? 0.5),
    attachAngle: clamp('attachAngle', o.attachAngle ?? 0),
    recursionLimit: Math.round(clamp('recursionLimit', o.recursionLimit ?? 0)),
    symmetry: o.symmetry ?? SYMMETRY.BILATERAL,
    hue: clamp('hue', o.hue ?? 0.3),
    sat: clamp('sat', o.sat ?? 0.6),
    val: clamp('val', o.val ?? 0.7),
    pattern: o.pattern ?? 0,
    patternScale: clamp('patternScale', o.patternScale ?? 1),
  };
}

export function partGene(o = {}) {
  return {
    kind: o.kind ?? PART.EYE,
    attachSegment: o.attachSegment ?? 0,
    param: clamp('param', o.param ?? 0.5),
    coneAngle: clamp('coneAngle', o.coneAngle ?? 1.0),
    range: clamp('senseRange', o.range ?? 8),
  };
}

export function nodeGene(o = {}) {
  return { id: o.id ?? 0, kind: o.kind ?? NODE.HIDDEN, activation: o.activation ?? ACT.TANH };
}

export function connGene(o = {}) {
  return {
    inNode: o.inNode ?? 0,
    outNode: o.outNode ?? 0,
    weight: clamp('weight', o.weight ?? 0),
    enabled: o.enabled ?? 1,
    innovation: o.innovation ?? 0,
  };
}

export function lifeHistory(o = {}) {
  return {
    basalRate: clamp('basalRate', o.basalRate ?? 0.01),
    photoCap: clamp('photoCap', o.photoCap ?? 0.8),
    digestCap: clamp('digestCap', o.digestCap ?? 0.05),
    efficiency: clamp('efficiency', o.efficiency ?? 0.6),
    maturationAge: clamp('maturationAge', o.maturationAge ?? 20),
    maxLifespan: clamp('maxLifespan', o.maxLifespan ?? 200),
    offspringInvestment: clamp('offspringInvestment', o.offspringInvestment ?? 0.2),
    mutationRate: clamp('mutationRate', o.mutationRate ?? 0.08),
  };
}

// A complete genome.
export function makeGenome(o = {}) {
  return {
    genomeId: o.genomeId ?? nextGenomeId(),
    lineageId: o.lineageId ?? 0,
    generation: o.generation ?? 0,
    reproMode: o.reproMode ?? REPRO.ASEXUAL,
    morph: o.morph ?? [],       // MorphGene[]
    parts: o.parts ?? [],       // PartGene[]
    nodes: o.nodes ?? [],       // NodeGene[]
    conns: o.conns ?? [],       // ConnGene[]
    life: o.life ?? lifeHistory(),
  };
}

// ---- The primordial genome: the simplest possible first replicator (Appendix M / §B). ----
// One body segment, no brain hidden structure, two behaviors: absorb ambient energy
// (photoCap) and divide-with-mutation (reproduce effector). No eyes, no muscles. Everything
// else must be discovered by evolution.
export function primordialGenome(lineageId) {
  const morph = [morphGene({ parentIndex: -1, radius: 0.4, length: 0.4, jointType: JOINT.FIXED, symmetry: SYMMETRY.NONE, hue: 0.35, sat: 0.5, val: 0.7, recursionLimit: 0 })];
  const parts = [
    partGene({ kind: PART.PROPRIO, attachSegment: 0 }),   // knows its own energy/age
    partGene({ kind: PART.MOUTH, attachSegment: 0, range: 1.2 }), // can absorb detritus if it touches
    partGene({ kind: PART.REPRODUCE, attachSegment: 0 }),
  ];
  // Minimal brain: inputs (own energy, age, bias) -> a reproduce output. No hidden nodes.
  // Node ids are assigned by the brain builder from parts+morph; here we seed a bias and a
  // single output wired to "reproduce when energy is high". Concretely: bias(+1) * w -> out.
  const nodes = [
    nodeGene({ id: 0, kind: NODE.BIAS, activation: ACT.TANH }),
    nodeGene({ id: 1, kind: NODE.IN, activation: ACT.TANH }),   // own energy fraction
    nodeGene({ id: 2, kind: NODE.OUT, activation: ACT.TANH }),  // reproduce gate
  ];
  const conns = [
    connGene({ inNode: 1, outNode: 2, weight: 2.0, enabled: 1, innovation: 1 }), // reproduce ∝ energy
    connGene({ inNode: 0, outNode: 2, weight: -0.5, enabled: 1, innovation: 2 }), // bias down slightly
  ];
  const life = lifeHistory({
    basalRate: 0.006, photoCap: 0.9, digestCap: 0.05, efficiency: 0.55,
    maturationAge: 8, maxLifespan: 120, offspringInvestment: 0.15, mutationRate: 0.12,
  });
  return makeGenome({ lineageId, generation: 0, reproMode: REPRO.ASEXUAL, morph, parts, nodes, conns, life });
}

// ---- Structural summaries used by metabolism, speciation, and the LOD sampler ----

// Total number of morphology segments after recursive expansion is bounded elsewhere; here
// we report the gene-level counts (cheap, no expansion).
export function brainSize(g) {
  let activeConns = 0;
  for (let i = 0; i < g.conns.length; i++) if (g.conns[i].enabled) activeConns++;
  return g.nodes.length + activeConns;
}

export function hiddenNodeCount(g) {
  let n = 0;
  for (let i = 0; i < g.nodes.length; i++) if (g.nodes[i].kind === NODE.HIDDEN) n++;
  return n;
}

// Fraction of connections that are recurrent (out-node id <= in-node id in a simple ordering).
// A proxy for temporal/memory capacity, used by the intelligence thresholds (Appendix J).
export function recurrenceRatio(g) {
  if (g.conns.length === 0) return 0;
  let rec = 0, tot = 0;
  for (let i = 0; i < g.conns.length; i++) {
    const c = g.conns[i];
    if (!c.enabled) continue;
    tot++;
    if (c.outNode <= c.inNode) rec++;
  }
  return tot === 0 ? 0 : rec / tot;
}

export function hasPart(g, kind) {
  for (let i = 0; i < g.parts.length; i++) if (g.parts[i].kind === kind) return true;
  return false;
}

export function countPart(g, kind) {
  let n = 0;
  for (let i = 0; i < g.parts.length; i++) if (g.parts[i].kind === kind) n++;
  return n;
}

// A grasping/tool-capable appendage: a small high-dexterity terminal segment (ball joint,
// small radius) — the "manipulation" precondition for intelligence (Appendix J).
export function hasManipulator(g) {
  for (let i = 0; i < g.morph.length; i++) {
    const m = g.morph[i];
    if (m.jointType === JOINT.BALL && m.radius < 0.35 && m.parentIndex >= 0) return true;
  }
  return false;
}

// Deep clone (genomes are mutated by copy; the original is never mutated in place).
export function cloneGenome(g) {
  return {
    genomeId: g.genomeId,
    lineageId: g.lineageId,
    generation: g.generation,
    reproMode: g.reproMode,
    morph: g.morph.map((m) => ({ ...m, childAttachAngles: undefined })),
    parts: g.parts.map((p) => ({ ...p })),
    nodes: g.nodes.map((n) => ({ ...n })),
    conns: g.conns.map((c) => ({ ...c })),
    life: { ...g.life },
  };
}

// ---- Flatten a genome's continuously-valued traits into a vector, for the statistical LOD
// (mean/variance in genome space) and speciation morphDist. Only the SCALAR morphology +
// life-history traits go here; structural (topology) differences are handled separately by
// the NEAT distance. Fixed-length per (morphSegmentCount) so populations of like body plans
// share a vector length. ----
export const LIFE_VEC_FIELDS = ['basalRate', 'photoCap', 'digestCap', 'efficiency', 'maturationAge', 'maxLifespan', 'offspringInvestment', 'mutationRate'];
export const MORPH_VEC_FIELDS = ['radius', 'length', 'density', 'muscleStrength', 'hue', 'sat', 'val'];

export function genomeToVector(g) {
  const out = [];
  for (let i = 0; i < LIFE_VEC_FIELDS.length; i++) out.push(g.life[LIFE_VEC_FIELDS[i]]);
  // Aggregate morphology as means across segments (body-plan-length-independent).
  const acc = new Array(MORPH_VEC_FIELDS.length).fill(0);
  const n = Math.max(1, g.morph.length);
  for (let i = 0; i < g.morph.length; i++) {
    for (let f = 0; f < MORPH_VEC_FIELDS.length; f++) acc[f] += g.morph[i][MORPH_VEC_FIELDS[f]];
  }
  for (let f = 0; f < MORPH_VEC_FIELDS.length; f++) out.push(acc[f] / n);
  out.push(g.morph.length);          // segment count as a trait
  out.push(hiddenNodeCount(g));      // brain complexity as a trait
  return out;
}

// Hash a genome into the world state hash (for the self-test). Order-stable.
export function hashGenomeInto(g, h) {
  h.int32(g.genomeId); h.int32(g.lineageId); h.int32(g.generation); h.int32(g.reproMode);
  for (let i = 0; i < g.morph.length; i++) {
    const m = g.morph[i];
    h.int32(m.parentIndex); h.float(m.radius); h.float(m.length); h.float(m.density);
    h.int32(m.jointType); h.float(m.jointMin); h.float(m.jointMax); h.float(m.muscleStrength);
    h.float(m.attachAngle); h.int32(m.recursionLimit); h.int32(m.symmetry);
    h.float(m.hue); h.float(m.sat); h.float(m.val); h.int32(m.pattern); h.float(m.patternScale);
  }
  for (let i = 0; i < g.parts.length; i++) {
    const p = g.parts[i];
    h.int32(p.kind); h.int32(p.attachSegment); h.float(p.param); h.float(p.coneAngle); h.float(p.range);
  }
  for (let i = 0; i < g.nodes.length; i++) { const n = g.nodes[i]; h.int32(n.id); h.int32(n.kind); h.int32(n.activation); }
  for (let i = 0; i < g.conns.length; i++) { const c = g.conns[i]; h.int32(c.inNode); h.int32(c.outNode); h.float(c.weight); h.int32(c.enabled); h.int32(c.innovation); }
  const L = g.life;
  for (let i = 0; i < LIFE_VEC_FIELDS.length; i++) h.float(L[LIFE_VEC_FIELDS[i]]);
}
