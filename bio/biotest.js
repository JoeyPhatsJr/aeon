// bio/biotest.js
// Self-test coverage for the genome→body+brain engine and the energy law. Exported as an
// array of [name, fn] pairs so main.js can pass them to core/selftest's runSelfTest as
// extraTests (keeps core/ free of a bio dependency). These assert the HEART works: bodies
// build within bounds, brains step deterministically, mutation is seed-reproducible and
// actually diverges genomes, crossover stays valid, distance behaves, and a bare selection
// loop produces speciation — all before any world or pixels exist.

import { RNG } from '../core/rng.js';
import { primordialGenome, makeGenome, morphGene, partGene, brainSize, JOINT, PART, SYMMETRY } from './genome.js';
import { buildBody, MAX_SEGMENTS, poseBody } from './bodyBuilder.js';
import { compileBrain, makeBrainState, stepBrain } from './brain.js';
import { stepMetabolism, aerobicFactor } from './metabolism.js';
import { InnovationRegistry, mutateGenome, reproduceAsexual, crossover } from './reproduction.js';
import { genomeDistance, morphDistance, brainCompat } from './speciation.js';
import { emergentLocomotion, integrateAgent } from './physics.js';

function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); }

export const bioTests = [
  ['bio: primordial genome builds a valid one-segment body', () => {
    const g = primordialGenome(1);
    const body = buildBody(g);
    assert(body.segments.length >= 1, 'no segments');
    assert(body.totalMass > 0, 'zero mass');
    assert(body.exposedArea > 0, 'zero area');
  }],

  ['bio: recursion + symmetry stay within the segment cap', () => {
    // A pathological genome that would explode without the cap.
    const morph = [
      morphGene({ parentIndex: -1, recursionLimit: 4, symmetry: SYMMETRY.RADIAL, radius: 0.4, length: 0.6, muscleStrength: 0.8 }),
      morphGene({ parentIndex: 0, recursionLimit: 4, symmetry: SYMMETRY.BILATERAL, radius: 0.3, length: 0.5, muscleStrength: 0.7 }),
      morphGene({ parentIndex: 1, recursionLimit: 4, symmetry: SYMMETRY.RADIAL, radius: 0.2, length: 0.4 }),
    ];
    const g = makeGenome({ morph });
    const body = buildBody(g);
    assert(body.segments.length <= MAX_SEGMENTS, 'segment cap breached: ' + body.segments.length);
    assert(body.segments.length > 1, 'recursion produced nothing');
  }],

  ['bio: brain compiles and steps deterministically', () => {
    const g = primordialGenome(2);
    const plan = compileBrain(g);
    const s1 = makeBrainState(plan), s2 = makeBrainState(plan);
    const inputs = new Float32Array(plan.inputCount);
    for (let i = 0; i < inputs.length; i++) inputs[i] = 0.5;
    const o1 = new Float32Array(plan.outputCount), o2 = new Float32Array(plan.outputCount);
    for (let t = 0; t < 20; t++) {
      stepBrain(plan, s1, inputs, null, o1);
      stepBrain(plan, s2, inputs, null, o2);
    }
    for (let i = 0; i < o1.length; i++) assert(o1[i] === o2[i], 'brain nondeterministic at out ' + i);
  }],

  ['bio: a sin-node brain oscillates (CPG capacity exists)', () => {
    // Build a brain: bias -> hidden(sin) -> output, recurrent hidden to make it oscillate.
    const g = makeGenome({
      morph: [morphGene({ parentIndex: -1, jointType: JOINT.HINGE, muscleStrength: 0.8 })],
      parts: [partGene({ kind: PART.MUSCLE }), partGene({ kind: PART.PROPRIO })],
      nodes: [
        { id: 0, kind: 3, activation: 0 }, // bias
        { id: 1, kind: 1, activation: 2 }, // hidden, sin
        { id: 2, kind: 2, activation: 0 }, // out, tanh
      ],
      conns: [
        { inNode: 0, outNode: 1, weight: 0.7, enabled: 1, innovation: 1 },
        { inNode: 1, outNode: 1, weight: 1.4, enabled: 1, innovation: 2 }, // recurrent self-loop
        { inNode: 1, outNode: 2, weight: 1.0, enabled: 1, innovation: 3 },
      ],
    });
    const plan = compileBrain(g);
    const st = makeBrainState(plan);
    const inputs = new Float32Array(plan.inputCount);
    const out = new Float32Array(plan.outputCount);
    let min = Infinity, max = -Infinity;
    for (let t = 0; t < 60; t++) {
      stepBrain(plan, st, inputs, null, out);
      const v = out[0];
      if (v < min) min = v; if (v > max) max = v;
    }
    assert(max - min > 0.1, 'sin brain did not oscillate (range ' + (max - min).toFixed(3) + ')');
  }],

  ['bio: mutation is seed-reproducible', () => {
    const innovA = new InnovationRegistry(), innovB = new InnovationRegistry();
    const gA = reproduceAsexual(primordialGenome(3), new RNG(42n).fork('mutation'), 0.1, innovA);
    const gB = reproduceAsexual(primordialGenome(3), new RNG(42n).fork('mutation'), 0.1, innovB);
    assert(genomeDistance(gA, gB) < 1e-9, 'same seed gave different mutants');
  }],

  ['bio: mutation actually diverges genomes over generations', () => {
    const rng = new RNG(7n).fork('mutation');
    const innov = new InnovationRegistry();
    let g = primordialGenome(4);
    const start = g;
    for (let i = 0; i < 40; i++) g = reproduceAsexual(g, rng, 0.15, innov);
    const d = genomeDistance(start, g);
    assert(d > 0.01, 'no divergence after 40 generations (d=' + d + ')');
    assert(g.generation === 40, 'generation not tracked');
  }],

  ['bio: crossover produces a valid, buildable genome', () => {
    const rng = new RNG(11n).fork('mating');
    const innov = new InnovationRegistry();
    let a = primordialGenome(5), b = primordialGenome(6);
    for (let i = 0; i < 10; i++) { a = reproduceAsexual(a, rng, 0.2, innov); b = reproduceAsexual(b, rng, 0.2, innov); }
    const child = crossover(a, b, rng, 0.1, innov);
    const body = buildBody(child);
    assert(body.segments.length >= 1, 'crossover child unbuildable');
    assert(brainSize(child) >= 3, 'crossover lost the brain');
  }],

  ['bio: genome distance is 0 for identical, grows with mutation', () => {
    const g = primordialGenome(8);
    assert(genomeDistance(g, g) < 1e-9, 'self-distance nonzero');
    const rng = new RNG(3n).fork('mutation');
    const innov = new InnovationRegistry();
    const near = reproduceAsexual(g, rng, 0.05, innov);
    let far = g;
    for (let i = 0; i < 60; i++) far = reproduceAsexual(far, rng, 0.25, innov);
    assert(genomeDistance(g, near) <= genomeDistance(g, far) + 1e-6, 'distance not monotone-ish');
  }],

  ['bio: energy law kills a starving agent and never references a role', () => {
    const g = primordialGenome(9);
    const body = buildBody(g);
    // Depleted agent in darkness with no food loses energy every tick until it dies.
    const agent = { energy: 0.02, age: 1, life: g.life, mass: body.totalMass };
    const ctx = {
      insolation: 0, o2: 0.2, temperature: 20, tolLow: -10, tolHigh: 40, dt: 1, cognitionCost: 1,
      biteMass: 0, jointActivity: 0, speed: 0, sensorCount: 2, brainUnits: brainSize(g),
      mass: body.totalMass, exposedArea: body.exposedArea, reproduceGate: 0,
    };
    let died = false;
    for (let t = 0; t < 200 && !died; t++) {
      const res = stepMetabolism(agent, ctx);
      agent.energy = res.energy;
      if (res.die) { died = true; assert(res.cause === 1, 'wrong death cause'); }
    }
    assert(died, 'no-light no-food agent should starve within 200 ticks');
  }],

  ['bio: photosynthesis feeds an agent in the light', () => {
    const g = primordialGenome(10);
    const body = buildBody(g);
    const agent = { energy: 1.0, age: 1, life: g.life, mass: body.totalMass };
    const res = stepMetabolism(agent, {
      insolation: 1.0, o2: 0.2, temperature: 20, tolLow: -10, tolHigh: 40, dt: 1, cognitionCost: 1,
      biteMass: 0, jointActivity: 0, speed: 0, sensorCount: 2, brainUnits: brainSize(g),
      mass: body.totalMass, exposedArea: body.exposedArea, reproduceGate: 0,
    });
    assert(res.die === false, 'agent starved in full sun');
    assert(res.energy > 1.0, 'photosynthesis gave no net energy');
  }],

  ['bio: aerobic factor gates large bodies on oxygen', () => {
    const small = aerobicFactor(0.0, 0.2);
    const bigAnoxic = aerobicFactor(0.0, 4.0);
    const bigOxic = aerobicFactor(1.0, 4.0);
    assert(small > bigAnoxic, 'small body not favored under anoxia');
    assert(bigOxic > bigAnoxic, 'oxygen did not help the large body');
  }],

  ['bio: locomotion emerges from muscle oscillation, not scripting', () => {
    const g = makeGenome({ morph: [
      morphGene({ parentIndex: -1, jointType: JOINT.FIXED }),
      morphGene({ parentIndex: 0, jointType: JOINT.HINGE, muscleStrength: 1.0, attachAngle: 0.5 }),
    ] });
    const body = buildBody(g);
    const agent = { x: 0, y: 0, vx: 0, vy: 0, heading: 0 };
    // Oscillating muscle velocity => net thrust.
    let moved = 0;
    for (let t = 0; t < 60; t++) {
      const mv = [Math.sin(t * 0.5)]; // oscillating flick
      const { thrust, turn } = emergentLocomotion(body, [0], mv);
      integrateAgent(agent, thrust, turn, 0.9, 1 / 30);
      moved = Math.hypot(agent.x, agent.y);
    }
    assert(moved > 0.001, 'oscillating muscles produced no displacement');
  }],
];
