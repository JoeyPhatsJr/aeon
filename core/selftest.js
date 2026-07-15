// core/selftest.js
// The ?selftest harness. Asserts the deterministic core behaves. It GROWS each build chunk:
// later chunks add world-state-hash equality across two runs, snapshot round-trip, and the
// promote->demote->promote aggregate round-trip. Right now it locks down the bedrock:
// RNG reproducibility & substream independence, clock ticking, hash stability, and the
// save-codec round-trip. A failing assertion throws; the runner collects pass/fail lines.

import { RNG } from './rng.js';
import { Clock } from './clock.js';
import { Hasher } from './hash.js';
import { packWorld, unpackWorld, worldToJson, worldFromJson, worldToHash, worldFromHash } from './serialize.js';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

// Each test returns nothing or throws. The registry order is stable.
const TESTS = [
  ['rng: identical seeds produce identical streams', () => {
    const a = new RNG(12345n);
    const b = new RNG(12345n);
    for (let i = 0; i < 1000; i++) assert(a.nextU64() === b.nextU64(), 'stream diverged at ' + i);
  }],

  ['rng: different seeds diverge', () => {
    const a = new RNG(1n);
    const b = new RNG(2n);
    let differ = false;
    for (let i = 0; i < 100; i++) if (a.nextU64() !== b.nextU64()) { differ = true; break; }
    assert(differ, 'distinct seeds gave identical streams');
  }],

  ['rng: float01 stays in [0,1)', () => {
    const r = new RNG(99n);
    for (let i = 0; i < 5000; i++) {
      const f = r.float01();
      assert(f >= 0 && f < 1, 'float01 out of range: ' + f);
    }
  }],

  ['rng: named substreams are independent of draw order', () => {
    // Draw a lot from 'weather' on one master; the 'mutation' stream must be unaffected.
    const m1 = new RNG(777n);
    const mut1 = m1.fork('mutation');
    const seqA = [];
    for (let i = 0; i < 50; i++) seqA.push(mut1.nextU64());

    const m2 = new RNG(777n);
    const weather = m2.fork('weather');
    for (let i = 0; i < 10000; i++) weather.nextU64(); // perturb a different substream a lot
    const mut2 = m2.fork('mutation');
    const seqB = [];
    for (let i = 0; i < 50; i++) seqB.push(mut2.nextU64());

    for (let i = 0; i < 50; i++) assert(seqA[i] === seqB[i], 'substream coupling at ' + i);
  }],

  ['rng: gaussian is deterministic and roughly standard', () => {
    const a = new RNG(555n), b = new RNG(555n);
    let sum = 0, sumSq = 0, n = 4000;
    for (let i = 0; i < n; i++) {
      const x = a.gaussian(0, 1);
      assert(x === b.gaussian(0, 1), 'gaussian diverged at ' + i);
      sum += x; sumSq += x * x;
    }
    const mean = sum / n;
    const varr = sumSq / n - mean * mean;
    assert(Math.abs(mean) < 0.1, 'gaussian mean off: ' + mean);
    assert(Math.abs(varr - 1) < 0.15, 'gaussian variance off: ' + varr);
  }],

  ['rng: saveState/loadState reproduces the stream', () => {
    const r = new RNG(2024n);
    for (let i = 0; i < 37; i++) r.nextU64();
    const st = r.saveState();
    const tail = [];
    for (let i = 0; i < 20; i++) tail.push(r.nextU64());
    const r2 = new RNG(0n).loadState(st);
    for (let i = 0; i < 20; i++) assert(r2.nextU64() === tail[i], 'restore diverged at ' + i);
  }],

  ['clock: fixed cadence, real warp advances real-time', () => {
    const c = new Clock();
    c.setWarpIndex(0); // 1x Real
    let ticks = 0, dt = 0, mode = null;
    // A 0.1s frame at 30 ticks/sec => 3 ticks, each 1/30 sim-second.
    c.advance(0.1, (d, m) => { ticks++; dt = d; mode = m; });
    assert(ticks >= 2 && ticks <= 4, 'unexpected tick count: ' + ticks);
    assert(mode === 'bio', 'real warp not bio mode');
    assert(Math.abs(dt - 1 / 30) < 1e-6, 'real warp dt not 1/30: ' + dt);
    assert(c.tick === ticks, 'tick counter mismatch');
  }],

  ['clock: long-frame clamp prevents spiral', () => {
    const c = new Clock();
    c.setWarpIndex(0);
    let ticks = 0;
    c.advance(100.0, () => { ticks++; }); // huge stall
    assert(ticks <= c.maxSubSteps, 'spiral not bounded: ' + ticks);
  }],

  ['clock: high warp uses statistical mode and races sim-time', () => {
    const c = new Clock();
    c.setWarpIndex(8); // eon
    let mode = null, dt = 0;
    c.advance(0.1, (d, m) => { mode = m; dt = d; });
    assert(mode === 'stat', 'eon warp did not use stat mode');
    assert(dt > 1e6 * 365 * 24 * 3600, 'eon tick should span >1e6 yr, got ' + dt);
  }],

  ['hash: stable and sensitive', () => {
    const h1 = new Hasher().floatArray(new Float32Array([1, 2, 3, 4])).digest();
    const h2 = new Hasher().floatArray(new Float32Array([1, 2, 3, 4])).digest();
    const h3 = new Hasher().floatArray(new Float32Array([1, 2, 3, 4.001])).digest();
    assert(h1 === h2, 'identical input hashed differently');
    assert(h1 !== h3, 'sensitive change not detected');
    assert(/^[0-9a-f]{16}$/.test(h1), 'digest not 64-bit hex');
  }],

  ['serialize: pack/unpack round-trips', () => {
    const world = {
      seed: 424242n,
      params: { mass: 1.0, waterFrac: 0.71, co2_0: 0.9, o2_0: 0.0, tilt: 23.4, gridRes: 256, baseMutation: 0.05, cognitionCost: 1.0 },
      interventions: [ { tick: 10, type: 'meteor', params: { x: 5, y: 9, size: 2 } }, { tick: 200, type: 'temp', params: { delta: -4 } } ],
    };
    const bytes = packWorld(world);
    const back = unpackWorld(bytes);
    assert(back.seed === world.seed, 'seed lost');
    assert(Math.abs(back.params.waterFrac - 0.71) < 1e-9, 'param lost');
    assert(back.interventions.length === 2, 'interventions lost');
    assert(back.interventions[1].params.delta === -4, 'intervention param lost');
  }],

  ['serialize: JSON and hash forms round-trip', () => {
    const world = {
      seed: 9001n,
      params: { mass: 3.0, waterFrac: 0.5, co2_0: 0.8, o2_0: 0.01, tilt: 12, gridRes: 128, baseMutation: 0.1, cognitionCost: 0.8 },
      interventions: [ { tick: 5, type: 'iceage', params: {} } ],
    };
    const json = worldToJson(world);
    const backJ = worldFromJson(json);
    assert(backJ.seed === 9001n, 'json seed lost');

    const hash = worldToHash(world);
    const backH = worldFromHash('#' + hash);
    assert(backH.seed === 9001n, 'hash seed lost');
    assert(Math.abs(backH.params.mass - 3.0) < 1e-9, 'hash param lost');
  }],
];

// Run all tests. Returns { pass, fail, lines[] }. In later chunks, `world` hooks are passed
// in so world-level determinism tests can run too.
export function runSelfTest(extraTests = []) {
  const all = TESTS.concat(extraTests);
  const lines = [];
  let pass = 0, fail = 0;
  for (let i = 0; i < all.length; i++) {
    const [name, fn] = all[i];
    try {
      fn();
      pass++;
      lines.push('PASS  ' + name);
    } catch (err) {
      fail++;
      lines.push('FAIL  ' + name + '  — ' + (err && err.message ? err.message : err));
    }
  }
  return { pass, fail, lines };
}
