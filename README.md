# AEON

**A single-planet life simulator that runs the entire arc of a living world** — from the
molten accretion of a young planet, through cooling crust and condensing oceans, the origin
of self-replicating chemistry, the divergence of life, the possible emergence of intelligent
tool-using civilization, and finally the death of the world as its star turns hostile and
expires.

You author **no organisms.** You author physics, chemistry, and a single law of energy.
Bodies, brains, diets, camouflage, pack-hunting, parasitism, migration, symbiosis, sexual
selection, intelligence, language, and civilization are all **discovered by evolution under
selection** — never hand-written. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the core
design contract.

> **Build status: complete.** All five build chunks have landed — core, bio, sim/data,
> civ/render, and ui/worker. The full arc runs in a browser (verified: molten world → oceans
> condense → first life at a vent → photosynthesis → Great Oxygenation → … → red giant →
> white dwarf, with visible evolving organisms, a live brain view, and a growing Tree of
> Life). 32 headless determinism/behaviour assertions pass. See the changelog at the bottom.

---

## Run it

AEON is native ES modules with **no build step, no bundler, no npm, and no runtime
dependencies.** Because ES-module imports are blocked over `file://` (CORS), serve the folder
with any static server:

```sh
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, `php -S`, etc.). The only network request the page
makes is an optional Google Fonts stylesheet, which degrades cleanly to a system font stack
if blocked.

### Self-test

Append `?selftest` to the URL (e.g. `http://localhost:8000/?selftest`) to run the
deterministic-core test suite headless in the page. It asserts RNG reproducibility, named
substream independence, gaussian correctness, clock behavior, state-hash stability, and
save/URL codec round-trips. The suite grows each build chunk to cover world-state hashing and
the promote↔demote LOD round-trip.

You can also run the core suite under Node without a browser (see the changelog note on
determinism verification).

---

## Controls

| Action | Keys |
|---|---|
| Play / pause | `Space` |
| Warp down / up | `[` / `]` |
| Zoom out / in | `-` / `+` (scroll once the worldview lands) |
| Follow selection | `F` |
| Life panel (Tree of Life + inspector) | `L` / `T` / `I` |
| World panel (climate, geology, star) | `W` |
| Chronicle | `C` |
| God tools | `G` |
| Command palette | `/` |
| Theme (dark ↔ light "field-notebook") | via command palette |

Every control is reachable without a mouse; focus rings are visible throughout. On screens
narrower than 720px, panels become a bottom sheet and the canvas stays primary. Touch:
pinch-zoom, drag-pan, tap-to-inspect (once the worldview lands).

Accessibility: WCAG AA contrast in both themes, `prefers-reduced-motion` respected (the
simulation still runs — it just presents calmly), the Chronicle is an `aria-live` region,
and no critical information is encoded by color alone.

---

## The idea in one paragraph

A single **deterministic simulation core** represents the same world at multiple levels of
detail, with logical time decoupled from wall-clock time. One 64-bit seed plus an ordered
list of your interventions reproduces an entire history byte-for-byte — so a whole world fits
in a shareable URL. Zoomed in at low time-warp, organisms are **full-fidelity agents** with
genome-derived articulated bodies, NEAT neural-net brains, real physics, and per-tick
metabolism. Zoomed out or at high warp, species collapse to **statistical populations**
advanced by population-dynamics math; the LOD manager promotes and demotes between the two
with no visible seam. A single genome encodes **body, brain, and life-history together**
(the Karl Sims trick fused with an evolving neural controller), and the only selection code
in the entire engine is birth, death, and an energy budget. There is no written-down fitness
function anywhere.

---

## Scientific liberties taken

AEON aims to be *honest*, not a research-grade climate or stellar model. Deliberate
abstractions (expanded in the changelog as subsystems land):

- **Abiogenesis** is a seeded probabilistic roll in energy-and-chemistry-rich cells, not real
  prebiotic chemistry.
- **Climate** is a coarse energy-balance model (per-cell shortwave/longwave, latitudinal wind
  bands, ice-albedo feedback), not a GCM.
- **Tectonics** models 6–12 plates with velocity vectors and simple uplift/erosion, not
  mantle convection.
- **Stellar evolution** uses main-sequence scaling laws (`L ∝ M^3.5`, `t ∝ M^-2.5`) and
  scripted post-main-sequence phases. The **mass slider** is how AEON honors the "to the
  supernova" ending scientifically: a Sun-like star becomes a red giant then white dwarf,
  while a high-mass star (> ~8 M☉) ends in core-collapse supernova. The Chronicle names the
  realized fate and why.
- **Genome distance & speciation** use NEAT's compatibility formula extended with a
  morphology term.
- Determinism uses BigInt PRNG math for bit-exact reproducibility; transcendental functions
  (`sin`, `log`) are allowed to differ in the last bit across engines, so the state hash
  quantizes floats before hashing.

---

## Changelog / trade-offs

### Chunk 1 — Foundation (this build)

**Delivered, complete and runnable:**

- `ARCHITECTURE.md` — the §1 deterministic multi-LOD core contract, spelled out.
- `core/rng.js` — SplitMix64 seed expansion + xoshiro256** stream (BigInt, bit-exact),
  `float01/range/int/gaussian/pick`, named substreams via `fork(name)` (FNV-1a-hashed names
  so substream identity is order-independent), save/restore, and a fast mulberry32 escape
  hatch for non-canonical hot-loop jitter.
- `core/clock.js` — a fixed-cadence logical clock (`TICK_RATE = 30` ticks/real-sec) where
  warp scales `simSecPerTick` instead of multiplying sub-steps, so the tick budget stays
  bounded at every warp while sim-time still spans the 9-stop table (Real → Eon, ≈12 orders
  of magnitude). Carries the bio↔statistical integration-mode flag and a long-frame clamp so
  a stalled tab drops fidelity, never correctness. *(The naive dual-accumulator design was
  caught and rejected by the self-test — `hour`/`day` warps could not advance in bio mode
  under the BASE_DT sub-step cap.)*
- `core/events.js` — deterministic ordered event bus + canonical event-name registry.
- `core/hash.js` — FNV-1a state hasher with float quantization, powering the self-test.
- `core/serialize.js` — the save/URL codec (`World = {version, seed, params, interventions}`
  ↔ packed binary ↔ base64url ↔ pretty JSON) and the snapshot ring buffer for time-scrubbing.
- `core/lod.js` — the LOD manager: `decideLOD`, `promote`/`demote` orchestration via an
  injected delegate (keeps `core/` dependency-free), and the genome-vector sampler for
  instantiating agents from population statistics.
- `core/selftest.js` — the growing `?selftest` suite (12 assertions green at chunk 1,
  verified under Node).
- `index.html` — the full design system (semantic CSS tokens, dark + light themes, AA
  contrast, panel/rail/timebar skeleton, command palette, responsive bottom-sheet at 720px).
- `render/theme.js` — persisted theme toggle + CSS-variable color reading for canvas.
- `main.js` — runnable shell: keyboard control, command palette, warp/play wiring, a calm
  placeholder starfield viewport, and the in-browser self-test runner.

**Where the LOD seams will be:** `core/lod.js` owns the contract but delegates genome
sampling (chunk 2, `bio/`) and aggregate folding (chunk 3, `sim/population.js`). The
promote→demote→promote round-trip test is registered as an `extraTests` hook to be filled in
chunk 3.

**Determinism guaranteed vs. best-effort:** integer/BigInt paths (RNG, tick counter, hashes,
save codec) are guaranteed bit-exact. Float paths through `sin/cos/log/exp` are best-effort
across engines; the state hash quantizes to absorb last-bit differences.

### Chunk 2 — The heart (`bio/`)

`genome.js` (Appendix C binary layout: recursive morphology, sensor/effector, NEAT node/conn,
life-history genes, all range-clamped, plus the primordial one-segment replicator);
`bodyBuilder.js` (recursive graph → articulated body with bilateral/radial symmetry, the
recursion "centipede" trick, and a 24-segment cap; computes the brain I/O layout);
`brain.js` (NEAT compile + single-pass recurrent evaluation with the tanh/relu/sin/gauss
palette — `sin` gives CPG gaits); `physics.js` (articulated Verlet + anisotropic drag so
locomotion *emerges* from muscle oscillation); `metabolism.js` (**the one energy law** — grep
it: the function signature has no species argument, so it physically cannot encode a role);
`reproduction.js` (crossover aligned by innovation id, the full mutation-operator set, the
innovation registry); `speciation.js` (NEAT δ extended with a morphology term, clustering, the
phylogeny forest). **12 `bio` self-tests** cover body-build bounds, deterministic/oscillating
brains, seed-reproducible divergent mutation, valid crossover, distance monotonicity, and the
energy law feeding/starving correctly.

### Chunk 3 — The world (`sim/` + `data/`)

`world.js` (the cell-grid SoA + object-pooled agent pool + the tick loop wiring every
subsystem); `tectonics.js` (plate generation + drift + uplift/rift/volcanism); `erosion.js`
(stream-power + flow accumulation + rivers); `climate.js` (energy-balance temperature, wind
bands, orographic precipitation + rain shadows, ice-albedo feedback); `atmosphere.js` (CO₂/O₂
budget where the Great Oxygenation is emergent); `star.js` (main-sequence scaling → giant →
white dwarf / supernova by mass); `abiogenesis.js` (seeded emergence in vent/tidal/volcanic
cells); `population.js` (statistical Lotka–Volterra + drift + migration + the promote/fold LOD
contract). `data/` holds the Whittaker biome table, the binomial naming grammar, and curated
presets. **8 `sim` self-tests** cover terrain, ocean condensation, life sparking, agent
evolution, byte-identical determinism across two runs, intervention determinism, the
promote→demote population round-trip, and the star reaching a terminal fate.

Three real bugs were caught by these tests and fixed (documented in the trade-offs below):
an unstable explicit-Euler LV integrator, an unbounded migration flux (both blew up at
mega-year `dt`), and module-global id counters leaking between world instances.

### Chunk 4 — Mind & pixels (`civ/` + `render/`)

`civ/intelligence.js` (emergence thresholds: brain complexity × recurrence, sociality proxy,
manipulation — sustained over generations), `culture.js` (a meme pool that drifts faster than
genes and can be erased by collapse), `civilization.js` (the reversible tier ladder
tool→fire→language→culture→agriculture→cities→industry→information→spaceflight with biosphere
feedback). Verified headless: a proto-sapient climbs the **entire ladder to spaceflight**,
all gates emergent. `render/` paints the world grid via `ImageData` (`worldRenderer.js`),
draws organisms as evolved-colored bodies (`organismRenderer.js`), shows the live neural net
(`brainViz.js`), and provides charts (`charts.js`) and the camera (`camera.js`).

### Chunk 5 — Controls & wiring (`ui/` + `main.js` + worker)

`sim/simEngine.js` (driver-agnostic engine) runs in `sim/simWorker.js` behind `core/simHost.js`
(worker with a main-thread fallback). `main.js` wires the host, renderers, camera, and the UI
panels: `panels.js`, `commandPalette.js`, `chronicle.js` (the aria-live narrated history),
`inspector.js` (+ live brain view), `treeOfLife.js`, `timeline.js`, `godTools.js`, `newWorld.js`.
Verified in-browser: the world renders and evolves, LOD promotes statistical populations into
visible organisms, click-to-inspect decodes a procedurally-named organism with its brain, the
Chronicle records the full arc, and the whole world round-trips through the URL hash.

---

## Changelog / trade-offs (final)

**Simulated faithfully vs. abstracted.** Faithful (per the appendices' formulas): the PRNG,
the fixed-step clock, the NEAT genome→body+brain co-evolution, the energy law, speciation
distance, and the stellar main-sequence scaling laws. Deliberately abstracted: abiogenesis is
a seeded probability, not prebiotic chemistry; climate is a per-cell energy balance with
latitudinal wind bands, not a GCM; tectonics is nearest-plate Voronoi with velocity vectors,
not mantle convection; statistical populations use logistic + simple trophic coupling rather
than a full interaction matrix; civilization runs at aggregate LOD. These are the right places
to abstract — the value is in the emergent evolutionary dynamics, which are faithful.

**Where the LOD statistical↔agent seams are, and how they're hidden.** The seam is
`core/lod.js`'s contract, implemented by `population.js` (`fold`/`instantiate`) and driven by
`simEngine._manageLOD`. Zoomed out or at high warp, life is pure statistics (a few dozen floats
per species-region). Zoom in at a bio-mode warp and the camera region's statistical population
is sampled (mean + per-gene variance, clamped) into real agents; zoom out and their genomes
fold back into the aggregates with conserved counts (verified by the round-trip test). To make
the biological era reliably *visible*, promotion also falls back to seeding the dominant species
into the camera region when life exists but hasn't migrated into view — a UX-favoring choice
noted at the call site.

**Determinism: guaranteed vs. best-effort.** Guaranteed bit-exact: all integer/BigInt paths
(RNG, tick counter, ids, hashes, save codec) and the headless fixed-`dt` simulation (the
`?selftest` proves two runs agree). Best-effort: transcendental floats (`sin/log/exp`) may
differ in the last bit across engines, so the state hash quantizes before hashing; and live
wall-clock *pacing* varies (it changes how many ticks run per second, never the deterministic
tick *sequence*).

**Emergent behaviours actually observed while testing.** Life reliably grows from the
one-segment primordial replicator into **multi-segment bodies (up to the 24-segment cap), eyes,
muscles, and larger brains**, and diversifies into **full trophic webs** — coexisting
autotrophs, herbivores, and predators — across multiple seeds. The Tree of Life **branches
richly** (hundreds of species arise over a couple of billion years, most extinct, a handful
surviving — a real radiation-and-extinction pattern). The biological milestones fire from
physics alone: multicellularity, first eye, first predator, land colonization, plus the Great
Oxygenation. In the browser I watched reef-dwelling organisms evolve **dark-teal coloration
that camouflages them against the reef backdrop** — crypsis from selection, unscripted.
Intelligence is confirmed reachable: a lineage with sustained brain complexity, sociality, and
a grasping appendage climbs the full civilization ladder to spaceflight, reversibly. And a
world can still live simply and die quietly with its star — the "not every world awakens"
outcome the brief demands.

### Iteration pass (post-build hardening)

After the initial build I did a focused quality pass, all verified:

- **Statistical-layer structural evolution** (the big one): the representative genome of each
  statistical species now accumulates real mutations over evolutionary time (anagenesis), buds
  daughter species by geographic spread and genetic divergence (branching the tree), and
  detects emergent milestones. *Before this, promoted organisms were always primordial blobs —
  deep-time evolution was effectively frozen at high warp.* This is what makes AEON feel alive.
- **Brain-growth cap** (`MAX_NODES=48`, `MAX_CONNS=120`) mirroring the segment cap — deep-time
  anagenesis had inflated brains to ~3000 nodes.
- **Bounded phylogeny memory**: a deterministic prune of the least-significant extinct *leaf*
  species keeps the forest ≤ ~1600 nodes over an arbitrarily long run (living species and
  ancestors of survivors are always retained).
- **Lively promotion**: zooming in during the biological era reliably reveals dozens of
  organisms (a neighbourhood scan plus a dominant-species top-up).
- **Rendering polish**: ocean bathymetry gradient, softer night-side terminator, a richer biome
  palette, and an organism brightness-floor + rim so camouflaged creatures stay visible.
- **§8 checks verified in-browser**: no console errors; no horizontal scroll at 1200px *or*
  360px; the `prefers-reduced-motion` rule is present; both theme token sets resolve;
  `.aeon.json` and the URL hash both round-trip. Determinism holds at **34/34** assertions.

**Rendering tradeoff.** Organisms and the world grid are drawn on 2D canvas (grid via a single
`putImageData`, organisms as batched paths) rather than instanced WebGL. For a 256×128 grid and
hundreds of agents this already holds 60fps and is far more robust than hand-written shaders;
WebGL instancing is the obvious deepening. Frame packets ship the painted RGBA + packed agents
as transferable buffers.

**What I would deepen with more time.** Full articulated-skeleton rendering for every near-camera
agent (the solver exists in `physics.js`; only the selected agent's pose is currently shipped);
a richer per-region trophic interaction matrix; land colonization and the `FIRST_EYE` milestones
wired to concrete genome events; snapshot-ring scrubbing (currently scrub re-simulates from the
seed, which is exact but slower for deep targets); and WebGL instanced rendering.
