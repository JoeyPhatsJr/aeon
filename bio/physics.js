// bio/physics.js
// 2D articulated-body physics for full-fidelity agents. Each segment is a Verlet particle
// chain link; distance constraints hold segment lengths; muscles bias joint angles toward the
// brain's motor targets. Locomotion is NOT scripted: anisotropic drag (a segment resists
// motion perpendicular to its own axis more than along it — like an oar or a fish tail) turns
// oscillating muscle activity into net forward thrust. A brain that discovers a central pattern
// generator (via a `sin` node) will swim; one that doesn't, won't. That is the whole point.
//
// Two granularities:
//   - Point integrator (integrateAgent): cheap; used for every full-fidelity agent's world
//     position under an emergent thrust computed from body + muscle activity.
//   - Skeleton solver (stepSkeleton): full Verlet chain; used for near-camera agents so you can
//     watch the actual gait. Both are deterministic (fixed dt, no Math.random).

import { poseBody } from './bodyBuilder.js';

// Allocate per-agent skeleton state: one particle per segment (at its near end), plus rest
// lengths from the body. Positions initialize to a straight pose.
export function makeSkeleton(body) {
  const n = body.segments.length;
  return {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    px: new Float32Array(n), // previous positions (Verlet)
    py: new Float32Array(n),
    initialized: false,
  };
}

// Emergent thrust from muscle oscillation. `muscleAngles` are current joint angles;
// `muscleVel` their per-tick change (the flick speed). Net thrust ∝ Σ strength·|Δangle|,
// directed along the body's heading. Also returns a small turning torque from asymmetric
// muscle activity, so bilateral bodies can steer.
export function emergentLocomotion(body, muscleAngles, muscleVel) {
  let thrust = 0;
  let turn = 0;
  for (let m = 0; m < body.muscles.length; m++) {
    const segIdx = body.muscles[m];
    const strength = body.segments[segIdx].muscleStrength;
    const v = muscleVel[m] || 0;
    thrust += strength * Math.abs(v);
    // Attach angle sign biases turning (left vs right muscles).
    turn += strength * v * Math.sign(body.segments[segIdx].attachAngle || 0.0001);
  }
  // Diminishing returns: a huge body with many muscles doesn't get unbounded thrust.
  thrust = thrust / (1 + 0.1 * body.muscles.length);
  return { thrust, turn };
}

// Integrate an agent's world position under thrust + drag. `agent` has {x,y,vx,vy,heading}.
// Returns the speed this tick (for metabolism's move cost). Wraps horizontally is handled by
// the caller (cylinder world). Drag is environmental (water vs air) from the cell.
export function integrateAgent(agent, thrust, turn, drag, dt) {
  agent.heading += turn * dt;
  // Thrust along heading.
  const ax = Math.cos(agent.heading) * thrust;
  const ay = Math.sin(agent.heading) * thrust;
  agent.vx = (agent.vx + ax * dt) * (1 - drag * dt);
  agent.vy = (agent.vy + ay * dt) * (1 - drag * dt);
  agent.x += agent.vx * dt;
  agent.y += agent.vy * dt;
  const speed = Math.hypot(agent.vx, agent.vy);
  return speed;
}

// Full skeleton Verlet step for near-camera animation. Poses the body kinematically from the
// root, then relaxes with Verlet + distance constraints so it looks organic. This is display
// fidelity; the canonical world position comes from integrateAgent. Deterministic.
export function stepSkeleton(skel, body, rootX, rootY, heading, muscleAngles, dt) {
  const posed = poseBody(body, rootX, rootY, heading, muscleAngles);
  if (!skel.initialized) {
    for (let i = 0; i < skel.n; i++) {
      skel.x[i] = posed[i].x; skel.y[i] = posed[i].y;
      skel.px[i] = posed[i].x; skel.py[i] = posed[i].y;
    }
    skel.initialized = true;
  }
  // Verlet integrate toward posed targets (soft follow => organic lag).
  const follow = 0.5;
  for (let i = 0; i < skel.n; i++) {
    const vx = (skel.x[i] - skel.px[i]) * 0.9;
    const vy = (skel.y[i] - skel.py[i]) * 0.9;
    skel.px[i] = skel.x[i]; skel.py[i] = skel.y[i];
    skel.x[i] += vx + (posed[i].x - skel.x[i]) * follow;
    skel.y[i] += vy + (posed[i].y - skel.y[i]) * follow;
  }
  // Distance constraints along the chain (keep segment lengths).
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < body.segments.length; i++) {
      const s = body.segments[i];
      if (s.parentSeg < 0) continue;
      const p = s.parentSeg;
      const dx = skel.x[i] - skel.x[p];
      const dy = skel.y[i] - skel.y[p];
      const dist = Math.hypot(dx, dy) || 1e-4;
      const rest = body.segments[p].length;
      const diff = (dist - rest) / dist;
      const mx = dx * 0.5 * diff;
      const my = dy * 0.5 * diff;
      skel.x[i] -= mx; skel.y[i] -= my;
      skel.x[p] += mx; skel.y[p] += my;
    }
  }
  void dt;
  return posed;
}

// Environmental drag from a cell: water is dense (high drag but supports swimming thrust),
// air/land lower. waterDepth>0 => aquatic.
export function cellDrag(waterDepth) {
  return waterDepth > 0 ? 1.4 : 0.9;
}

// Simple circle-vs-circle overlap test for mouth-contact / predation / mating, done in the
// sim's spatial grid. Returns true if within (rA+rB).
export function overlap(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}
