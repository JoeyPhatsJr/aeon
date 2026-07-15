// core/hash.js
// Deterministic state hashing for the self-test. We hash typed-array world state into a
// 64-bit FNV-1a digest (returned as a hex string). Two runs from the same seed + the same
// ordered interventions must produce the same digest after N ticks; a snapshot round-trip
// must reproduce the digest of the moment it captured.
//
// Determinism requirements this file enforces:
//   - Reduce arrays strictly left-to-right by index (never Object/Set order).
//   - Quantize floats before hashing so that benign last-bit differences from transcendental
//     functions (which the spec allows to be best-effort across engines) do not spuriously
//     fail the test, while meaningful divergence still shows up.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export class Hasher {
  constructor() {
    this.h = FNV_OFFSET;
  }

  _byte(b) {
    this.h ^= BigInt(b & 0xff);
    this.h = (this.h * FNV_PRIME) & MASK64;
  }

  int32(v) {
    v |= 0;
    this._byte(v);
    this._byte(v >> 8);
    this._byte(v >> 16);
    this._byte(v >> 24);
    return this;
  }

  // Quantize a float to a fixed grid before hashing. `scale` controls sensitivity
  // (default 1e4 => ~4 significant decimals). NaN/Inf map to fixed sentinels.
  float(v, scale = 1e4) {
    if (!Number.isFinite(v)) {
      this.int32(v !== v ? 0x7fc00000 : v > 0 ? 0x7f800000 : 0xff800000);
      return this;
    }
    const q = Math.round(v * scale);
    // q can exceed 32 bits; hash it as two 32-bit halves for stability.
    const lo = q | 0;
    const hi = Math.floor(q / 0x100000000) | 0;
    this.int32(lo);
    this.int32(hi);
    return this;
  }

  floatArray(arr, scale = 1e4, stride = 1) {
    for (let i = 0; i < arr.length; i += stride) this.float(arr[i], scale);
    return this;
  }

  intArray(arr, stride = 1) {
    for (let i = 0; i < arr.length; i += stride) this.int32(arr[i]);
    return this;
  }

  bigint(v) {
    let x = BigInt(v) & MASK64;
    for (let i = 0; i < 8; i++) {
      this._byte(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  str(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this._byte(c);
      this._byte(c >> 8);
    }
    return this;
  }

  digest() {
    return this.h.toString(16).padStart(16, '0');
  }
}

// Convenience: hash a whole world snapshot object into a hex digest. The world module
// provides `hashInto(hasher)` so this stays decoupled from world internals.
export function hashWorld(world) {
  const h = new Hasher();
  h.bigint(world.rng ? world.rng.masterSeed : 0n);
  h.int32(world.clock ? world.clock.tick : 0);
  if (typeof world.hashInto === 'function') world.hashInto(h);
  return h.digest();
}
