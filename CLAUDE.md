# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Honest status (read this first)

AEON is **OK as a tech demo, but it does not really work as the thing the brief describes, and it
has a LONG way to go.** Be candid about this in any planning.

What genuinely works and is verified:
- The deterministic core (seeded PRNG, fixed-step clock, hashing, save/URL codec).
- Genome → body + brain co-evolution under a single energy law, with no hand-authored fitness.
- Deep-time statistical evolution: lineages grow complexity, diversify into trophic webs, and
  branch the Tree of Life; the star ages to a real ending; 34 headless assertions pass.
- It renders, runs in a Web Worker, and deploys (live at https://joeyphatsjr.github.io/aeon/).

What does NOT really work yet (the "long way to go"):
- **As a playable/legible experience it's rough.** You must manually juggle warp + zoom to
  witness anything; organisms are small, often camouflaged, and hard to find; the world easily
  blows past the interesting biological window into stellar death.
- **Full-fidelity agent life is shallow.** Promoted agents rarely live/reproduce long enough to
  visibly evolve in-agent; the real evolution happens statistically and is only *sampled* into
  agents. The two representations are not yet convincingly the "same world."
- **Much of the brief is stubbed or unverified in-app:** pack hunting / flocking, sexual
  selection & mate choice, real articulated-skeleton animation (the solver exists but only the
  selected agent's pose ships), migration realism, civ made visible at the individual level,
  bookmarks/scrub UX, and the LOD `promote→demote` UX seam (the math round-trips in tests, but
  the in-app reconciliation is a simplified heuristic, not the full `core/lod.js` contract).
- **Visuals are functional, not beautiful.** 2D canvas, not the instanced-WebGL the brief wants.
- Balance/pacing is under-tuned; many constants were set to pass a test, not to feel good.

Treat the tests as the source of truth for "correct," and your own eyes (run it in a browser)
as the source of truth for "good." They diverge a lot right now.

## Commands

No build step, no dependencies, no npm. Everything is native ES modules.

```sh
# Run locally — MUST be over http(s); ES modules are blocked over file://
python3 -m http.server 8000        # then open http://localhost:8000

# Headless test suite (determinism + behaviour), Node — the primary correctness gate:
node --input-type=module -e '
globalThis.btoa=(s)=>Buffer.from(s,"binary").toString("base64");
globalThis.atob=(s)=>Buffer.from(s,"base64").toString("binary");
const {runSelfTest}=await import("./core/selftest.js");
const {bioTests}=await import("./bio/biotest.js");
const {simTests}=await import("./sim/simtest.js");
const r=runSelfTest([...bioTests,...simTests]);
console.log(r.pass+" passed, "+r.fail+" failed");
console.log(r.lines.filter(l=>l.startsWith("FAIL")).join("\n"));
process.exit(r.fail?1:0);'

# Same suite in-browser:  open http://localhost:8000/?selftest
```

Test layout: `core/selftest.js` holds the base `TESTS` array and the `runSelfTest(extraTests)`
runner. Domain tests live in `bio/biotest.js` and `sim/simtest.js` as exported `[name, fn]`
arrays and are passed in as `extraTests` (this keeps `core/` free of `bio`/`sim` imports).
To run one test, temporarily filter the array or comment out the others in the relevant file.

Deploy: it's already on GitHub Pages (`main`/root, `.nojekyll` present). Just
`git commit && git push`; Pages rebuilds in ~1–2 min. Verify a real load afterward — the worker
path is the main deployment risk on a subpath.

## Architecture — the parts that require reading several files

Read `ARCHITECTURE.md` for the contract; it is authoritative. The essentials:

**One deterministic core at multiple LODs.** `core/rng.js` (SplitMix64 + xoshiro256**, BigInt,
bit-exact) + `core/clock.js` (fixed 30 ticks/sec; *warp scales sim-seconds-per-tick*, it does
NOT multiply sub-steps). The integer tick is canonical time. `sim/simEngine.js` owns the world
and drives it; it runs inside `sim/simWorker.js`, fronted by `core/simHost.js` which prefers a
Worker and falls back to the main thread behind an identical message interface.

**The genome is the only thing that evolves** (`bio/genome.js`): morphology (recursive body
graph), sensor/effector, NEAT brain (nodes+conns), and life-history — together. `bodyBuilder.js`
expands it to an articulated body; `brain.js` is the NEAT net; `metabolism.js` is **the one
energy law and the ONLY selection code** (with birth/death). Predator/herbivore/etc. are
*expressed strategies*, never assigned. `reproduction.js` = crossover-by-innovation + mutation +
the innovation registry; `speciation.js` = NEAT distance + phylogeny.

**Two representations of life, and the seam between them.** Zoomed in / low warp: full-fidelity
agents (SoA typed arrays + object pool) in `sim/world.js`. Zoomed out / high warp: statistical
populations in `sim/population.js` (Lotka–Volterra + drift + migration + **structural
evolution** — this is what makes deep time interesting; without it, promoted agents are
primordial blobs). `core/lod.js` defines the promote/demote contract; `simEngine._manageLOD`
currently implements a *simplified* version of it (see gaps above).

**Civ runs on top, driven from outside the world** (`civ/`): `intelligence.js` observes for
emergence thresholds; `civilization.js` is the reversible tech ladder with biosphere feedback;
`culture.js` is the meme pool. Nothing in `sim/` imports `civ/` — the host wires them.

**Rendering is main-thread, read-only** (`render/`): the world grid is painted into an RGBA
buffer (`paintWorldRGBA`, shared with the worker) and blitted; organisms are batched canvas
paths. `main.js` wires host ↔ renderers ↔ `ui/` panels and translates input into messages.

## Invariants that must not break (these caused real bugs)

- **Determinism**: no `Math.random` / `Date.now` / `performance.now` in the sim core (pacing in
  the worker loop is the only allowed `performance.now`). Iterate arrays by index; never rely on
  `Object`/`Set` order where it affects results. The state hash quantizes floats.
- **No module-global mutable state that two worlds could share.** Genome/species id counters are
  per-world objects rebound at the top of `World.step` (`setGenomeCounter`/`setSpeciesCounter`).
  A snapshot re-sim creates a *second* live world — anything global will diverge the hash.
- **No unbounded rate × huge `dt`.** Warp `dt` reaches ~1e6 years. Population growth uses the
  exact logistic map; migration flux and mutation drift are clamped. Explicit Euler will explode.
- **No hand-authored fitness.** `metabolism.stepMetabolism` takes no species/role argument by
  design. Grep the repo for `reward`/`fitness`/`isPredator` — hits should only be comments.
- **Caps exist for a reason**: body ≤ 24 segments, brain ≤ 48 nodes / 120 conns, phylogeny
  pruned to ~1600 nodes. Deep-time anagenesis inflates everything without them.

## When changing sim behaviour

Run the headless suite (determinism will catch most mistakes), THEN open it in a browser and
actually watch — warp up to ~Epoch to get established life, drop to Hour/Day and zoom in to
promote agents. `window.AEON` exposes the app for introspection in the console. Update the
"emergent behaviours observed" and changelog sections of `README.md` to stay honest.
