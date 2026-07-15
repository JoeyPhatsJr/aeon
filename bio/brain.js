// bio/brain.js
// NEAT neural network: build from a genome's node/connection genes, then evaluate once per
// tick (Appendix D). Recurrent connections are allowed — they read PREVIOUS-tick activations,
// giving memory and central-pattern-generator oscillators (crucial for gaits). Evaluation is
// a single synchronous pass so it is deterministic regardless of topology.
//
// Activation palette: tanh, relu, sin, gauss. `sin` is kept deliberately — it lets evolution
// discover oscillators for locomotion without us scripting a gait.
//
// The brain is a small compiled structure held per genome-topology; agents sharing a genome
// share the topology and only differ in the weight array + their own activation state.

import { ACT, NODE } from './genome.js';

function activate(kind, x) {
  switch (kind) {
    case ACT.RELU: return x > 0 ? x : 0;
    case ACT.SIN: return Math.sin(x);
    case ACT.GAUSS: return Math.exp(-x * x);
    case ACT.TANH:
    default: return Math.tanh(x);
  }
}

// Compile a genome's brain into an evaluable plan. Nodes are indexed 0..N-1 in a stable order
// (inputs, then bias, then hidden, then outputs — but we keep the genome's own node id map so
// connections resolve correctly). We also precompute, for feed-forward-eval quality, an
// approximate evaluation order via Kahn's algorithm ignoring recurrent (back) edges; edges
// that would create a cycle are marked recurrent and read last-tick state.
export function compileBrain(genome) {
  const nodes = genome.nodes;
  const conns = genome.conns;
  const idToIndex = new Map();
  for (let i = 0; i < nodes.length; i++) idToIndex.set(nodes[i].id, i);

  const n = nodes.length;
  const kinds = new Uint8Array(n);
  const activations = new Uint8Array(n);
  const nodeKind = new Uint8Array(n);
  const inputIdx = [];
  const outputIdx = [];
  const biasIdx = [];
  for (let i = 0; i < n; i++) {
    kinds[i] = nodes[i].kind;
    activations[i] = nodes[i].activation;
    nodeKind[i] = nodes[i].kind;
    if (nodes[i].kind === NODE.IN) inputIdx.push(i);
    else if (nodes[i].kind === NODE.OUT) outputIdx.push(i);
    else if (nodes[i].kind === NODE.BIAS) biasIdx.push(i);
  }

  // Build enabled edge list as index pairs.
  const edges = [];
  for (let i = 0; i < conns.length; i++) {
    const c = conns[i];
    if (!c.enabled) continue;
    const a = idToIndex.get(c.inNode);
    const b = idToIndex.get(c.outNode);
    if (a === undefined || b === undefined) continue;
    edges.push({ from: a, to: b, w: c.weight, recurrent: false });
  }

  // Determine evaluation order (topological over non-recurrent edges). We do a DFS-based
  // cycle detection: edges that close a cycle are flagged recurrent (read prev-tick value).
  const adj = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.length; e++) adj[edges[e].from].push(e);
  const state = new Uint8Array(n); // 0=unvisited,1=in-stack,2=done
  const order = [];
  // Iterative DFS to avoid stack overflow on pathological genomes.
  for (let s = 0; s < n; s++) {
    if (state[s] !== 0) continue;
    const stack = [{ node: s, ei: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (state[top.node] === 0) state[top.node] = 1;
      if (top.ei < adj[top.node].length) {
        const e = adj[top.node][top.ei++];
        const to = edges[e].to;
        if (state[to] === 1) {
          edges[e].recurrent = true; // back edge -> recurrent
        } else if (state[to] === 0) {
          stack.push({ node: to, ei: 0 });
        }
      } else {
        state[top.node] = 2;
        order.push(top.node);
        stack.pop();
      }
    }
  }
  order.reverse(); // topological order for the DAG portion

  // Group incoming edges per node for fast eval.
  const incoming = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.length; e++) incoming[edges[e].to].push(edges[e]);

  return {
    n,
    activations,
    inputIdx,
    outputIdx,
    biasIdx,
    order,
    incoming,
    inputCount: inputIdx.length,
    outputCount: outputIdx.length,
  };
}

// Per-agent brain runtime state: current and previous activation buffers.
export function makeBrainState(plan) {
  return {
    cur: new Float32Array(plan.n),
    prev: new Float32Array(plan.n),
  };
}

// Step the network one tick. `inputs` is a Float32Array of length plan.inputCount, in the
// same order as plan.inputIdx (which mirrors the order input nodes appear in the genome).
// Writes results into `outputs` (length plan.outputCount). Recurrent edges read `prev`.
export function stepBrain(plan, st, inputs, weights, outputs) {
  const { cur, prev } = st;
  // Swap buffers: last tick's cur becomes prev.
  prev.set(cur);

  // Load inputs and bias.
  for (let i = 0; i < plan.inputIdx.length; i++) cur[plan.inputIdx[i]] = inputs[i];
  for (let i = 0; i < plan.biasIdx.length; i++) cur[plan.biasIdx[i]] = 1;

  // Evaluate in topological order; nodes with incoming edges (hidden/output, and any input
  // that happens to be wired) aggregate and activate. Inputs/bias with no incoming edges keep
  // the raw values set above.
  for (let oi = 0; oi < plan.order.length; oi++) {
    const node = plan.order[oi];
    const inc = plan.incoming[node];
    if (inc.length === 0) continue; // raw input / bias — leave as set
    let sum = 0;
    for (let e = 0; e < inc.length; e++) {
      const edge = inc[e];
      const src = edge.recurrent ? prev[edge.from] : cur[edge.from];
      sum += src * edge.w;
    }
    cur[node] = activate(plan.activations[node], sum);
  }

  // Read outputs.
  for (let i = 0; i < plan.outputIdx.length; i++) outputs[i] = cur[plan.outputIdx[i]];
  return outputs;
}

// Weights vector extracted from a genome in the SAME order compileBrain enumerates enabled
// edges — but compileBrain bakes weights into the plan's edges directly, so per-agent weight
// variation is applied by cloning the plan's edge weights. For agents that share a genome
// exactly, the plan already holds the weights. When the LOD sampler perturbs weights, it
// produces a per-agent weights overlay applied at eval; for simplicity and determinism we
// recompile per distinct genome. This helper returns the flat weight list for inspection.
export function extractWeights(plan) {
  const out = [];
  for (let node = 0; node < plan.n; node++) {
    const inc = plan.incoming[node];
    for (let e = 0; e < inc.length; e++) out.push(inc[e].w);
  }
  return out;
}
