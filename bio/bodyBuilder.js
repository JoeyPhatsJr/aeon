// bio/bodyBuilder.js
// Expand a genome's recursive morphology graph into a concrete articulated body (Appendix C).
// Walk the MorphGene tree from the root; at each node emit a physical segment attached to its
// parent by a joint. `recursionLimit` chains a copy of the node onto itself (the Karl Sims
// trick — a compact gene yields a repeated, segmented limb). `symmetry` mirrors (bilateral)
// or replicates around an axis (radial). A hard cap bounds total segments so cost stays
// bounded no matter how mutation inflates the genome.
//
// We also compute the brain I/O layout here, because the number of muscles (one motor output
// per actuated joint) and the sensor channels depend on the expanded body, not just the genes.
// The layout is a stable, deterministic list; the agent-step code fills input values from the
// world each tick and reads output values back to drive muscles/mouth/scent/signal/reproduce.

import { JOINT, SYMMETRY, PART, PART_IS_SENSOR } from './genome.js';

export const MAX_SEGMENTS = 24;

// Channel type tags (inputs).
export const IN = {
  EYE_FOOD_X: 0, EYE_FOOD_Y: 1, EYE_THREAT_X: 2, EYE_THREAT_Y: 3, EYE_CONSPEC_X: 4, EYE_CONSPEC_Y: 5,
  CHEMO_X: 6, CHEMO_Y: 7, PROP_ENERGY: 8, PROP_AGE: 9, PROP_JOINT: 10, THERMO: 11, OSC: 12,
};
// Channel type tags (outputs).
export const OUT = { MUSCLE: 0, MOUTH: 1, SCENT: 2, SIGNAL: 3, REPRODUCE: 4 };

// Build the body. Returns a plain object (structure-of-arrays-friendly where it matters).
export function buildBody(genome) {
  const segments = []; // each: {gene, parentSeg, attachAngle, radius, length, density, mass, joint..., color...}
  const muscles = [];  // segment indices with an actuated joint

  const morph = genome.morph;
  if (morph.length === 0) {
    // Degenerate genome: a single default blob so nothing crashes.
    segments.push(makeSegment({ radius: 0.3, length: 0.3, density: 1, jointType: JOINT.FIXED, hue: 0.3, sat: 0.5, val: 0.6 }, -1, 0));
  } else {
    // Recursive expansion with a global segment budget.
    const budget = { left: MAX_SEGMENTS };
    expandNode(morph, 0, -1, 0, segments, muscles, budget, genome);
  }

  // Aggregate physical properties.
  let totalMass = 0;
  let exposedArea = 0;
  for (let i = 0; i < segments.length; i++) {
    totalMass += segments[i].mass;
    // Photosynthetic/exposed surface ~ projected area of a capsule.
    exposedArea += segments[i].radius * segments[i].length + Math.PI * segments[i].radius * segments[i].radius;
  }

  // Brain I/O layout from parts + muscles.
  const inputChannels = buildInputLayout(genome, muscles);
  const outputChannels = buildOutputLayout(genome, muscles);

  return {
    segments,
    muscles,
    totalMass: Math.max(0.01, totalMass),
    exposedArea: Math.max(0.01, exposedArea),
    inputChannels,
    outputChannels,
    segmentCount: segments.length,
  };
}

function makeSegment(gene, parentSeg, attachAngle) {
  const radius = gene.radius;
  const length = gene.length;
  const density = gene.density;
  const mass = Math.PI * radius * radius * length * density;
  return {
    parentSeg,
    attachAngle,
    radius,
    length,
    density,
    mass,
    jointType: gene.jointType,
    jointMin: gene.jointMin,
    jointMax: gene.jointMax,
    muscleStrength: gene.muscleStrength,
    hue: gene.hue,
    sat: gene.sat,
    val: gene.val,
    pattern: gene.pattern,
    patternScale: gene.patternScale,
  };
}

// Recursively expand a morph node into segments. `depth` guards against runaway; the real cap
// is the shared segment budget.
function expandNode(morph, nodeIndex, parentSeg, attachAngle, segments, muscles, budget, genome, recursionDepth = 0) {
  if (budget.left <= 0) return;
  const gene = morph[nodeIndex];
  if (!gene) return;

  // Emit this segment.
  const segIndex = segments.length;
  segments.push(makeSegment(gene, parentSeg, attachAngle));
  budget.left--;
  if (gene.jointType !== JOINT.FIXED && gene.muscleStrength > 0.02) muscles.push(segIndex);

  // Recursion: chain a copy of this node onto itself, forming a repeated limb (centipede/tail).
  if (gene.recursionLimit > recursionDepth && budget.left > 0) {
    expandNode(morph, nodeIndex, segIndex, gene.attachAngle, segments, muscles, budget, genome, recursionDepth + 1);
  }

  // Children: any morph gene whose parentIndex === this nodeIndex.
  for (let i = 0; i < morph.length; i++) {
    if (i === nodeIndex) continue;
    if (morph[i].parentIndex !== nodeIndex) continue;
    if (budget.left <= 0) break;
    const childAngle = morph[i].attachAngle;
    if (gene.symmetry === SYMMETRY.BILATERAL) {
      // Mirror the child across the body axis: emit at +angle and -angle.
      expandNode(morph, i, segIndex, childAngle, segments, muscles, budget, genome, 0);
      if (budget.left > 0) expandNode(morph, i, segIndex, -childAngle, segments, muscles, budget, genome, 0);
    } else if (gene.symmetry === SYMMETRY.RADIAL) {
      // Replicate around 3 directions.
      const arms = 3;
      for (let a = 0; a < arms && budget.left > 0; a++) {
        expandNode(morph, i, segIndex, childAngle + (a * 2 * Math.PI) / arms, segments, muscles, budget, genome, 0);
      }
    } else {
      expandNode(morph, i, segIndex, childAngle, segments, muscles, budget, genome, 0);
    }
  }
}

// Input channel layout: for each sensor part (in stable gene order) enumerate its channels,
// then per-muscle proprioceptive joint angles, then a thermoception channel, then a slow
// oscillator seed. The agent-step code fills these each tick.
function buildInputLayout(genome, muscles) {
  const channels = [];
  for (let i = 0; i < genome.parts.length; i++) {
    const p = genome.parts[i];
    if (!PART_IS_SENSOR[p.kind]) continue;
    switch (p.kind) {
      case PART.EYE:
        channels.push({ type: IN.EYE_FOOD_X, part: i }, { type: IN.EYE_FOOD_Y, part: i },
          { type: IN.EYE_THREAT_X, part: i }, { type: IN.EYE_THREAT_Y, part: i },
          { type: IN.EYE_CONSPEC_X, part: i }, { type: IN.EYE_CONSPEC_Y, part: i });
        break;
      case PART.CHEMO:
        channels.push({ type: IN.CHEMO_X, part: i }, { type: IN.CHEMO_Y, part: i });
        break;
      case PART.PROPRIO:
        channels.push({ type: IN.PROP_ENERGY, part: i }, { type: IN.PROP_AGE, part: i });
        break;
      case PART.THERMO:
        channels.push({ type: IN.THERMO, part: i });
        break;
      default: break;
    }
  }
  // Proprioceptive joint angle per muscle (only meaningful if a PROPRIO sense exists).
  const hasProprio = genome.parts.some((p) => p.kind === PART.PROPRIO);
  if (hasProprio) {
    for (let m = 0; m < muscles.length; m++) channels.push({ type: IN.PROP_JOINT, muscle: m });
  }
  // Always a slow internal oscillator seed (drives CPG gaits without scripting them).
  channels.push({ type: IN.OSC });
  return channels;
}

// Output channel layout: one motor output per muscle, then mouth/scent/signal/reproduce for
// each corresponding effector part present.
function buildOutputLayout(genome, muscles) {
  const channels = [];
  for (let m = 0; m < muscles.length; m++) channels.push({ type: OUT.MUSCLE, muscle: m });
  for (let i = 0; i < genome.parts.length; i++) {
    const p = genome.parts[i];
    if (p.kind === PART.MOUTH) channels.push({ type: OUT.MOUTH, part: i });
    else if (p.kind === PART.EMIT_SCENT) channels.push({ type: OUT.SCENT, part: i });
    else if (p.kind === PART.SIGNAL) channels.push({ type: OUT.SIGNAL, part: i });
    else if (p.kind === PART.REPRODUCE) channels.push({ type: OUT.REPRODUCE, part: i });
  }
  return channels;
}

// Compute the world-space segment positions given a root position and orientation, walking the
// joint chain. Used by the renderer and by collision/sensing. `jointAngles` (length = muscles)
// are the current actuated angles; fixed joints use their rest attachAngle. Returns an array of
// {x, y, radius, hue, sat, val, pattern, patternScale}.
export function poseBody(body, rootX, rootY, rootAngle, jointAngles) {
  const segs = body.segments;
  const out = new Array(segs.length);
  const muscleOf = new Map();
  for (let m = 0; m < body.muscles.length; m++) muscleOf.set(body.muscles[m], m);

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.parentSeg < 0) {
      out[i] = { x: rootX, y: rootY, angle: rootAngle, radius: s.radius, hue: s.hue, sat: s.sat, val: s.val, pattern: s.pattern, patternScale: s.patternScale };
      continue;
    }
    const parent = out[s.parentSeg];
    const mi = muscleOf.get(i);
    const jointAngle = mi !== undefined && jointAngles ? jointAngles[mi] : 0;
    const angle = parent.angle + s.attachAngle + jointAngle;
    // Attach at the parent's far end.
    const plen = segs[s.parentSeg].length;
    const px = parent.x + Math.cos(parent.angle) * plen;
    const py = parent.y + Math.sin(parent.angle) * plen;
    out[i] = { x: px, y: py, angle, radius: s.radius, hue: s.hue, sat: s.sat, val: s.val, pattern: s.pattern, patternScale: s.patternScale };
  }
  return out;
}
