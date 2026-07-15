// core/rng.js
// Deterministic pseudo-random number generation for the AEON sim core.
//
// Appendix A of the brief specifies SplitMix64 for seed expansion and xoshiro256**
// for the main stream. We implement both with BigInt masked to 64 bits so results are
// bit-exact across engines (JS `number` cannot hold 64-bit integer math without loss).
//
// The whole point of the substream design (`fork`) is decoupling: each subsystem draws
// from its own stream, so adding a die-roll in `weather` never shifts the sequence the
// `mutation` stream produces. This is what makes a seed reproducibly replay an entire world.
//
// PERF NOTE: BigInt draws are slower than a Float64 LCG. We accept that in the canonical
// core because determinism is non-negotiable; hot loops that need bulk randomness (e.g.
// physics jitter) may use a fast float PRNG *seeded from* this stream, documented at the
// call site. Never `Math.random`.

const MASK64 = (1n << 64n) - 1n;
const MASK53 = (1n << 53n) - 1n;

function rotl(x, k) {
  // 64-bit rotate-left
  return ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK64;
}

// SplitMix64: expands a single 64-bit seed into a well-distributed stream, used to seed
// the four xoshiro words and to derive substream seeds.
function splitmix64Step(stateObj) {
  stateObj.s = (stateObj.s + 0x9e3779b97f4a7c15n) & MASK64;
  let z = stateObj.s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

// Stable 64-bit hash of a substream name (FNV-1a 64), so `fork('mutation')` is
// deterministic and independent of insertion order.
function hashName(name) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < name.length; i++) {
    h ^= BigInt(name.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

export class RNG {
  // masterSeed: a BigInt or number/string convertible to a 64-bit seed.
  constructor(seed) {
    this.masterSeed = RNG.toSeed64(seed);
    const sm = { s: this.masterSeed };
    // Seed the four xoshiro256** state words from SplitMix64.
    this.s0 = splitmix64Step(sm);
    this.s1 = splitmix64Step(sm);
    this.s2 = splitmix64Step(sm);
    this.s3 = splitmix64Step(sm);
    // Box–Muller spare cache for gaussian().
    this._spare = null;
  }

  static toSeed64(seed) {
    if (typeof seed === 'bigint') return seed & MASK64;
    if (typeof seed === 'number') {
      // Fold a JS number (possibly non-integer) into 64 bits deterministically.
      const sm = { s: BigInt(Math.floor(seed)) & MASK64 };
      return splitmix64Step(sm);
    }
    if (typeof seed === 'string') {
      // Accept decimal or 0x-hex strings, else hash the text.
      const t = seed.trim();
      if (/^0x[0-9a-fA-F]+$/.test(t)) return BigInt(t) & MASK64;
      if (/^\d+$/.test(t)) return BigInt(t) & MASK64;
      return hashName(t);
    }
    return 0n;
  }

  // xoshiro256** next 64-bit output.
  nextU64() {
    const result = (rotl((this.s1 * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (this.s1 << 17n) & MASK64;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 45);
    return result;
  }

  // Uniform double in [0, 1) from the top 53 bits (standard technique, avoids low-bit bias).
  float01() {
    const bits = this.nextU64() >> 11n; // keep top 53 bits
    return Number(bits & MASK53) / 9007199254740992; // 2^53
  }

  // Uniform double in [a, b).
  range(a, b) {
    return a + (b - a) * this.float01();
  }

  // Uniform integer in [0, n). Rejection-free modulo is fine here; n is small in practice.
  int(n) {
    if (n <= 0) return 0;
    return Math.floor(this.float01() * n);
  }

  // Uniform integer in [lo, hi] inclusive.
  intRange(lo, hi) {
    if (hi <= lo) return lo;
    return lo + this.int(hi - lo + 1);
  }

  bool(p = 0.5) {
    return this.float01() < p;
  }

  // Gaussian via Box–Muller; caches the second sample so successive calls are cheap and
  // still fully deterministic (the spare is consumed before drawing a new pair).
  gaussian(mean = 0, std = 1) {
    if (this._spare !== null) {
      const z = this._spare;
      this._spare = null;
      return mean + std * z;
    }
    // Avoid u1 === 0 (log(0)).
    let u1 = this.float01();
    if (u1 < 1e-12) u1 = 1e-12;
    const u2 = this.float01();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    this._spare = z1;
    return mean + std * z0;
  }

  // Pick an element by index (arrays are iterated by index; order is stable).
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[this.int(arr.length)];
  }

  // Derive an independent named substream. Seeded by splitmix64(masterSeed ^ hash(name))
  // so subsystems never perturb each other's sequences.
  fork(name) {
    const sm = { s: (this.masterSeed ^ hashName(name)) & MASK64 };
    const derived = splitmix64Step(sm);
    return new RNG(derived);
  }

  // Snapshot / restore state for deterministic re-simulation from a snapshot.
  saveState() {
    return {
      masterSeed: this.masterSeed.toString(),
      s0: this.s0.toString(),
      s1: this.s1.toString(),
      s2: this.s2.toString(),
      s3: this.s3.toString(),
      spare: this._spare,
    };
  }

  loadState(st) {
    this.masterSeed = BigInt(st.masterSeed);
    this.s0 = BigInt(st.s0);
    this.s1 = BigInt(st.s1);
    this.s2 = BigInt(st.s2);
    this.s3 = BigInt(st.s3);
    this._spare = st.spare;
    return this;
  }
}

// A fast, non-BigInt float PRNG (mulberry32) for perf-critical non-canonical jitter.
// It MUST be seeded from the canonical RNG so it stays deterministic. Use only where a
// small visual/physics perturbation is needed and the exact bit-sequence is not part of
// the shared determinism contract across subsystems.
export function makeFastRng(seedU32) {
  let a = seedU32 >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { hashName };
