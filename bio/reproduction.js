// bio/reproduction.js
// Reproduction, mutation, and crossover (Appendix C + G). Asexual = clone + mutate. Sexual =
// crossover two genomes (align brain genes by innovation id, morph genes by position) then
// mutate. A global innovation registry gives the same structural mutation the same innovation
// number within a run, so homologous genes align during crossover and count correctly in the
// speciation distance.
//
// Every stochastic choice draws from the passed-in RNG (the `mutation` / `mating` substreams),
// never Math.random — so an identical seed + identical intervention order replays identical
// evolution.

import {
  cloneGenome, morphGene, partGene, nodeGene, connGene, clamp, nextGenomeId,
  JOINT, SYMMETRY, ACT, NODE, PART, REPRO, RANGE,
} from './genome.js';

// Innovation registry: deterministic because it is keyed by structural identity and advanced
// only by the sim loop. Same (inNode,outNode) pair within a run => same innovation id.
export class InnovationRegistry {
  constructor(start = 1000) {
    this.counter = start;
    this.connKey = new Map(); // "in>out" -> innovation id
    this.nodeKey = new Map(); // "in>out" split -> new node id
    this.nextNodeId = 100000; // node ids for split-created hidden nodes live above input/output ids
  }

  connInnovation(inNode, outNode) {
    const key = inNode + '>' + outNode;
    let id = this.connKey.get(key);
    if (id === undefined) {
      id = ++this.counter;
      this.connKey.set(key, id);
    }
    return id;
  }

  // A node created by splitting a given connection gets a stable id per split site.
  splitNodeId(inNode, outNode) {
    const key = inNode + '>' + outNode;
    let id = this.nodeKey.get(key);
    if (id === undefined) {
      id = this.nextNodeId++;
      this.nodeKey.set(key, id);
    }
    return id;
  }

  saveState() {
    return {
      counter: this.counter,
      nextNodeId: this.nextNodeId,
      connKey: Array.from(this.connKey.entries()),
      nodeKey: Array.from(this.nodeKey.entries()),
    };
  }
  loadState(st) {
    this.counter = st.counter;
    this.nextNodeId = st.nextNodeId;
    this.connKey = new Map(st.connKey);
    this.nodeKey = new Map(st.nodeKey);
    return this;
  }
}

// Brain-size caps: a bigger brain is a real metabolic tax, but structural mutation must still
// be bounded or deep-time anagenesis inflates brains to thousands of nodes (unrealistic and
// expensive to compile when promoted). These mirror the 24-segment body cap.
const MAX_NODES = 48;
const MAX_CONNS = 120;

function perturb(rng, v, field, amount) {
  return clamp(field, v + rng.gaussian(0, amount));
}

// Mutate a genome IN PLACE (call on a fresh clone). `rate` is the genome's own mutationRate
// gene combined with the world base rate. Returns the genome for chaining.
export function mutateGenome(g, rng, baseRate, innov) {
  const rate = Math.min(0.9, g.life.mutationRate + baseRate);

  // --- Brain: weight perturbation / reset (per connection) ---
  for (let i = 0; i < g.conns.length; i++) {
    if (rng.bool(rate)) {
      if (rng.bool(0.1)) g.conns[i].weight = rng.range(RANGE.weight[0], RANGE.weight[1]); // reset
      else g.conns[i].weight = perturb(rng, g.conns[i].weight, 'weight', 0.4);            // perturb
    }
    if (rng.bool(rate * 0.05)) g.conns[i].enabled = g.conns[i].enabled ? 0 : 1; // toggle
  }

  // --- Add connection --- (capped: brains cannot grow without bound)
  if (rng.bool(rate * 0.6) && g.nodes.length >= 2 && g.conns.length < MAX_CONNS) {
    addConnection(g, rng, innov);
  }

  // --- Add node (split a connection: NEAT style) --- (capped like the segment cap)
  if (rng.bool(rate * 0.3) && g.conns.length > 0 && g.nodes.length < MAX_NODES) {
    addNode(g, rng, innov);
  }
  // --- Prune the brain occasionally so lineages can also simplify (evolution isn't monotone) ---
  if (g.conns.length > MAX_CONNS * 0.6 && rng.bool(rate * 0.12)) {
    const idx = rng.int(g.conns.length);
    g.conns.splice(idx, 1);
  }

  // --- Morphology: modify a segment ---
  if (g.morph.length > 0 && rng.bool(rate)) {
    const m = g.morph[rng.int(g.morph.length)];
    m.radius = perturb(rng, m.radius, 'radius', 0.15);
    m.length = perturb(rng, m.length, 'length', 0.2);
    m.muscleStrength = perturb(rng, m.muscleStrength, 'muscleStrength', 0.1);
    m.hue = clamp('hue', (m.hue + rng.gaussian(0, 0.05) + 1) % 1);
    m.sat = perturb(rng, m.sat, 'sat', 0.08);
    m.val = perturb(rng, m.val, 'val', 0.08);
    if (rng.bool(0.1)) m.jointType = rng.int(3);
    if (rng.bool(0.08)) m.symmetry = rng.int(3);
    if (rng.bool(0.06)) m.recursionLimit = Math.round(clamp('recursionLimit', m.recursionLimit + (rng.bool() ? 1 : -1)));
    if (rng.bool(0.05)) m.pattern = rng.int(4);
  }

  // --- Add a morphology segment ---
  if (rng.bool(rate * 0.35) && g.morph.length < 16) {
    const parent = g.morph.length === 0 ? -1 : rng.int(g.morph.length);
    g.morph.push(morphGene({
      parentIndex: parent,
      radius: rng.range(0.15, 0.9), length: rng.range(0.3, 1.6), density: rng.range(0.6, 1.4),
      jointType: rng.int(3), attachAngle: rng.range(-1.2, 1.2),
      muscleStrength: rng.range(0, 1), symmetry: rng.int(3),
      hue: g.morph.length ? g.morph[0].hue : rng.float01(), sat: rng.range(0.3, 0.9), val: rng.range(0.4, 0.9),
      recursionLimit: rng.bool(0.2) ? rng.int(3) : 0,
    }));
  }

  // --- Remove a (non-root) morphology segment ---
  if (rng.bool(rate * 0.15) && g.morph.length > 1) {
    const idx = 1 + rng.int(g.morph.length - 1);
    // Reparent orphans to root to keep the tree valid.
    for (let i = 0; i < g.morph.length; i++) if (g.morph[i].parentIndex === idx) g.morph[i].parentIndex = 0;
    g.morph.splice(idx, 1);
    // Fix indices after removal.
    for (let i = 0; i < g.morph.length; i++) if (g.morph[i].parentIndex > idx) g.morph[i].parentIndex--;
  }

  // --- Duplicate a segment subtree (gene duplication — a powerful complexity driver) ---
  if (rng.bool(rate * 0.12) && g.morph.length >= 1 && g.morph.length < 12) {
    const src = rng.int(g.morph.length);
    const copy = morphGene({ ...g.morph[src], parentIndex: 0 });
    g.morph.push(copy);
  }

  // --- Add/modify a sensor or effector part ---
  if (rng.bool(rate * 0.25)) {
    const kind = rng.int(9); // any PART kind
    g.parts.push(partGene({
      kind,
      attachSegment: g.morph.length ? rng.int(g.morph.length) : 0,
      param: rng.float01(), coneAngle: rng.range(0.3, 2.5), range: rng.range(3, 20),
    }));
  }
  if (g.parts.length > 0 && rng.bool(rate * 0.1)) {
    const p = g.parts[rng.int(g.parts.length)];
    p.range = perturb(rng, p.range, 'senseRange', 3);
    p.coneAngle = perturb(rng, p.coneAngle, 'coneAngle', 0.3);
  }

  // --- Life-history scalars ---
  if (rng.bool(rate)) {
    const L = g.life;
    L.basalRate = perturb(rng, L.basalRate, 'basalRate', 0.003);
    L.photoCap = perturb(rng, L.photoCap, 'photoCap', 0.08);
    L.digestCap = perturb(rng, L.digestCap, 'digestCap', 0.08);
    L.efficiency = perturb(rng, L.efficiency, 'efficiency', 0.05);
    L.maturationAge = perturb(rng, L.maturationAge, 'maturationAge', 8);
    L.maxLifespan = perturb(rng, L.maxLifespan, 'maxLifespan', 30);
    L.offspringInvestment = perturb(rng, L.offspringInvestment, 'offspringInvestment', 0.08);
    L.mutationRate = perturb(rng, L.mutationRate, 'mutationRate', 0.03);
    if (rng.bool(0.02)) g.reproMode = g.reproMode === REPRO.ASEXUAL ? REPRO.SEXUAL : REPRO.ASEXUAL;
  }

  return g;
}

function addConnection(g, rng, innov) {
  // Pick two distinct nodes; allow recurrent (out can precede in).
  const a = g.nodes[rng.int(g.nodes.length)];
  const b = g.nodes[rng.int(g.nodes.length)];
  if (a.id === b.id) return;
  // Don't target an input/bias as the destination.
  if (b.kind === NODE.IN || b.kind === NODE.BIAS) return;
  // Avoid duplicate connection.
  for (let i = 0; i < g.conns.length; i++) {
    if (g.conns[i].inNode === a.id && g.conns[i].outNode === b.id) return;
  }
  g.conns.push(connGene({
    inNode: a.id, outNode: b.id, weight: rng.range(-1, 1), enabled: 1,
    innovation: innov.connInnovation(a.id, b.id),
  }));
}

function addNode(g, rng, innov) {
  // Split an enabled connection: disable it, insert a new node with two connections.
  const enabled = [];
  for (let i = 0; i < g.conns.length; i++) if (g.conns[i].enabled) enabled.push(i);
  if (enabled.length === 0) return;
  const ci = enabled[rng.int(enabled.length)];
  const c = g.conns[ci];
  c.enabled = 0;
  const newId = innov.splitNodeId(c.inNode, c.outNode);
  // Avoid duplicating a node id already present (stable per split site).
  if (!g.nodes.some((n) => n.id === newId)) {
    g.nodes.push(nodeGene({ id: newId, kind: NODE.HIDDEN, activation: rng.int(4) }));
  }
  g.conns.push(connGene({ inNode: c.inNode, outNode: newId, weight: 1, enabled: 1, innovation: innov.connInnovation(c.inNode, newId) }));
  g.conns.push(connGene({ inNode: newId, outNode: c.outNode, weight: c.weight, enabled: 1, innovation: innov.connInnovation(newId, c.outNode) }));
}

// Asexual reproduction: clone + mutate. Assigns a fresh genomeId and bumps generation.
export function reproduceAsexual(parent, rng, baseRate, innov) {
  const child = cloneGenome(parent);
  child.genomeId = nextGenomeId();
  child.generation = parent.generation + 1;
  mutateGenome(child, rng, baseRate, innov);
  return child;
}

// Sexual reproduction: crossover then mutate. Brain genes align by innovation id (matching
// genes inherit randomly from a parent; disjoint/excess genes come from the fitter — here,
// higher-energy — parent, passed as `parentA`). Morph genes align by position.
export function crossover(parentA, parentB, rng, baseRate, innov) {
  const child = cloneGenome(parentA);
  child.genomeId = nextGenomeId();
  child.generation = Math.max(parentA.generation, parentB.generation) + 1;

  // Brain connections: build innovation maps.
  const bByInnov = new Map();
  for (let i = 0; i < parentB.conns.length; i++) bByInnov.set(parentB.conns[i].innovation, parentB.conns[i]);
  for (let i = 0; i < child.conns.length; i++) {
    const bc = bByInnov.get(child.conns[i].innovation);
    if (bc && rng.bool(0.5)) {
      child.conns[i] = connGene({ ...bc });
    }
  }
  // Ensure any node referenced by inherited conns exists.
  const nodeIds = new Set(child.nodes.map((n) => n.id));
  for (let i = 0; i < parentB.nodes.length; i++) {
    const nid = parentB.nodes[i].id;
    let referenced = false;
    for (let c = 0; c < child.conns.length; c++) if (child.conns[c].inNode === nid || child.conns[c].outNode === nid) { referenced = true; break; }
    if (referenced && !nodeIds.has(nid)) { child.nodes.push(nodeGene({ ...parentB.nodes[i] })); nodeIds.add(nid); }
  }

  // Morph genes: blend matching positions.
  const nShared = Math.min(child.morph.length, parentB.morph.length);
  for (let i = 0; i < nShared; i++) {
    if (rng.bool(0.5)) child.morph[i] = morphGene({ ...parentB.morph[i] });
  }

  // Life-history: average the two parents' scalars.
  for (const f of Object.keys(child.life)) {
    child.life[f] = clamp(f, 0.5 * (parentA.life[f] + parentB.life[f]));
  }

  mutateGenome(child, rng, baseRate, innov);
  return child;
}
