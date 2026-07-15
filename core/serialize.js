// core/serialize.js
// Two responsibilities, both from Appendix K:
//   1. Save/URL codec: World = { version, seed, params, interventions[] } <-> compact bytes.
//      Because the core is deterministic, this object alone replays an entire history.
//   2. Snapshot ring buffer: periodic compact world dumps for time-scrubbing. Seeking =
//      load nearest earlier snapshot, deterministically re-sim forward to the target tick.
//
// The save format packs the determinism-critical fixed fields as real binary (fixed offsets,
// little-endian) and appends the variable-length intervention log as length-prefixed UTF-8
// JSON. The whole buffer is base64url-encoded for the URL hash; the .aeon.json file is the
// same logical object, pretty-printed for humans.

const MAGIC = 0x4145; // 'AE'
export const SAVE_VERSION = 1;

// ---- base64url helpers (work in both window and worker; no Buffer dependency) ----

export function bytesToBase64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- World save codec ----

// params fields, in fixed order. Adding a field bumps SAVE_VERSION.
const PARAM_ORDER = ['mass', 'waterFrac', 'co2_0', 'o2_0', 'tilt', 'gridRes', 'baseMutation', 'cognitionCost'];

export function packWorld(world) {
  // world: { seed(BigInt|string), params:{...}, interventions:[{tick,type,params}] }
  const paramFloats = new Float64Array(PARAM_ORDER.length);
  for (let i = 0; i < PARAM_ORDER.length; i++) {
    const v = world.params[PARAM_ORDER[i]];
    paramFloats[i] = typeof v === 'number' ? v : 0;
  }

  const seed64 = typeof world.seed === 'bigint' ? world.seed : BigInt(seedToU64(world.seed));
  const interventionsJson = JSON.stringify(world.interventions || []);
  const jsonBytes = new TextEncoder().encode(interventionsJson);

  const headerBytes = 2 /*magic*/ + 2 /*version*/ + 8 /*seed*/ + paramFloats.byteLength + 4 /*json len*/;
  const buf = new ArrayBuffer(headerBytes + jsonBytes.length);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint16(o, MAGIC, true); o += 2;
  dv.setUint16(o, SAVE_VERSION, true); o += 2;
  dv.setBigUint64(o, seed64 & ((1n << 64n) - 1n), true); o += 8;
  for (let i = 0; i < paramFloats.length; i++) { dv.setFloat64(o, paramFloats[i], true); o += 8; }
  dv.setUint32(o, jsonBytes.length, true); o += 4;
  new Uint8Array(buf, o).set(jsonBytes);
  return new Uint8Array(buf);
}

export function unpackWorld(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const magic = dv.getUint16(o, true); o += 2;
  if (magic !== MAGIC) throw new Error('AEON save: bad magic');
  const version = dv.getUint16(o, true); o += 2;
  const seed = dv.getBigUint64(o, true); o += 8;
  const params = {};
  for (let i = 0; i < PARAM_ORDER.length; i++) { params[PARAM_ORDER[i]] = dv.getFloat64(o, true); o += 8; }
  const jsonLen = dv.getUint32(o, true); o += 4;
  const jsonBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + o, jsonLen);
  const interventions = JSON.parse(new TextDecoder().decode(jsonBytes));
  return { version, seed, params, interventions };
}

// Compact string helpers used by the URL hash and .aeon.json.
export function worldToHash(world) {
  return 'w=' + bytesToBase64url(packWorld(world));
}

export function worldFromHash(hash) {
  const m = /(?:^|[#&])w=([^&]+)/.exec(hash);
  if (!m) return null;
  return unpackWorld(base64urlToBytes(m[1]));
}

export function worldToJson(world) {
  // Human-readable; seed printed as decimal string to survive JSON number precision.
  const seed = typeof world.seed === 'bigint' ? world.seed.toString() : String(seedToU64(world.seed));
  return JSON.stringify(
    { version: SAVE_VERSION, seed, params: world.params, interventions: world.interventions || [] },
    null,
    2
  );
}

export function worldFromJson(text) {
  const obj = JSON.parse(text);
  return { version: obj.version, seed: BigInt(obj.seed), params: obj.params, interventions: obj.interventions || [] };
}

function seedToU64(seed) {
  // Mirror of RNG.toSeed64 numeric/string handling without importing RNG (avoid a cycle for
  // pure codec use). Falls back to 0 for unexpected input.
  if (typeof seed === 'bigint') return seed;
  if (typeof seed === 'number') return BigInt(Math.floor(seed)) & ((1n << 64n) - 1n);
  if (typeof seed === 'string' && /^\d+$/.test(seed.trim())) return BigInt(seed.trim());
  return 0n;
}

// ---- Snapshot ring buffer ----
//
// Snapshots are NOT shared (unlike the save codec). Each is a compact structured clone of
// the world's typed-array blocks plus RNG/clock state. The world provides
// captureSnapshot()/restoreSnapshot(blob); this class only manages the ring and the seek.

export class SnapshotRing {
  constructor(capacity = 32) {
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null); // {tick, blob}
    this.count = 0;
    this.head = 0; // next write index
  }

  push(tick, blob) {
    this.buffer[this.head] = { tick, blob };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  // Return the snapshot with the greatest tick <= targetTick, or null if none.
  nearestBefore(targetTick) {
    let best = null;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.buffer[i];
      if (!s) continue;
      if (s.tick <= targetTick && (best === null || s.tick > best.tick)) best = s;
    }
    return best;
  }

  earliest() {
    let best = null;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.buffer[i];
      if (!s) continue;
      if (best === null || s.tick < best.tick) best = s;
    }
    return best;
  }

  clear() {
    this.buffer.fill(null);
    this.count = 0;
    this.head = 0;
  }
}

// How often to snapshot, scaled by warp (finer at low warp for smooth scrubbing, coarser at
// high warp to bound memory). Returns a tick interval K.
export function snapshotInterval(warpIndex) {
  // real-time detail near warp 0, sparse at eon scale.
  const table = [300, 300, 600, 900, 1200, 1800, 2400, 3000, 3600];
  return table[Math.min(warpIndex, table.length - 1)];
}
