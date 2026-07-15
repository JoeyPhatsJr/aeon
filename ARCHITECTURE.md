# AEON — Architecture

> This document is the contract. Every feature in AEON must be expressible through the
> mechanisms described here. If a feature cannot be expressed through the deterministic
> multi-LOD core, it does not ship. This file is authoritative; when code and this file
> disagree, one of them is a bug.

AEON is a single-planet life simulator that runs the full arc of a world — molten
accretion, cooling crust, condensing oceans, abiogenesis, the divergence of life,
the possible emergence of intelligence and civilization, and the death of the world as
its star turns hostile and expires. **We author physics, chemistry, and one law of
energy. Every organism, body plan, brain, diet, and behavior is discovered by
evolution under selection — never hand-written.**

---

## 1. The one decision that matters most

A **single deterministic simulation core** represents the same world at multiple levels
of detail (LOD), with logical time fully decoupled from wall-clock time. This rests on
four pillars.

### 1.1 Deterministic fixed-timestep core

- The sim advances in **fixed logical ticks** (`BASE_DT = 1/30` sim-seconds). Wall-clock
  and render framerate are decoupled; the renderer interpolates between the last two sim
  states (`alpha` factor) for smooth visuals.
- **One 64-bit seed determines everything.** We implement `SplitMix64` to seed and
  `xoshiro256**` for the stream (`core/rng.js`). **`Math.random` is never called in the
  sim core.** Every subsystem draws from a *named substream* via `rng.fork(name)` so that
  adding a die-roll in one system never shifts the numbers another system sees. Required
  substreams: `geology, weather, mutation, abiogenesis, mating, naming, catastrophe, civ`.
- **Determinism rule:** identical seed + identical *ordered* list of player interventions
  ⇒ byte-identical history. Enforced by `?selftest` (see §7 of the brief): seed a fixed
  world, run N ticks headless, hash the state (`core/hash.js`), assert equality against a
  stored hash and against a second live run.
- **Forbidden in the sim core:** `Math.random`, `Date.now`, `performance.now`, iteration
  over `Object` keys or `Set` insertion order where order affects results, and
  order-sensitive float reductions (always reduce arrays left-to-right by index).

### 1.2 Two representations of every organism

The **LOD manager** (`core/lod.js`) keeps each species/region in one of two forms and
promotes/demotes between them:

- **Full-fidelity agent** — used when zoomed in and/or time-warp is low. Has the real
  genome-derived articulated body (`bio/bodyBuilder.js`), a NEAT brain stepped every tick
  (`bio/brain.js`), 2D physics (`bio/physics.js`), per-tick metabolism (`bio/metabolism.js`),
  and local sensing. This is where gaits, camouflage, ambush, and flocking are *visibly
  happening*. Stored structure-of-arrays in typed arrays; births/deaths use object pools.
- **Statistical population** — used when zoomed out and/or time is fast. A species collapses
  to aggregates: population count, mean genome vector, genome variance, biome occupancy,
  energy in/out, age structure. Advanced by population-dynamics math (`sim/population.js`,
  multi-species Lotka–Volterra + logistic self-limitation + mutation drift). A billion
  organisms cost a few dozen floats.

**Reconciliation — the make-or-break seam.** Two documented operations:

- `promote(species, region)`: instantiate representative full-fidelity agents by sampling
  genomes from the population's mean + covariance (a clamped multivariate Gaussian in genome
  space). Instantiated count matches local density. Sprites crossfade in — no pop.
- `demote(species, region)`: fold agents' births/deaths/energy back into the aggregates
  (delta-update mean/variance/count). No double-counting, no lost individuals.

**Contract (must hold):** `promote → demote` round-trips a species' aggregate stats within
tolerance; population count is conserved (agents instantiated == agents folded back, modulo
births/deaths that occurred while promoted, which are accounted explicitly). Verified by
`?selftest`.

### 1.3 Time-warp (≈12 orders of magnitude)

Discrete warp stops (`core/clock.js`), each remapping sim-ticks-per-frame **and** which LOD
is active:

| Warp | sim-time / real-sec | Typical LOD | Watch |
|---|---|---|---|
| `Real` | seconds | full everywhere on screen | one animal hunting, a brain firing |
| `Hour` | ~1 hr | full near camera | foraging, day/night |
| `Day` | ~1 day | mixed | tides, weather |
| `Year` | ~1 yr | mostly statistical | seasons, migration |
| `Century` | ~100 yr | statistical | booms/crashes |
| `Millennium` | ~1e3 yr | statistical | speciation |
| `Mega-year` | ~1e6 yr | statistical + geology | continents drift |
| `Epoch` | ~1e7–1e8 yr | + climate | mass extinctions, radiations |
| `Eon` | ~1e9 yr | coarse + star active | the star ages, the whole story |

The LOD manager keys entirely off `(cameraZoom, activeWarp, localDensity)`. Warping up
degrades fidelity gracefully and reports it honestly in the stats readout — never crashes
or stalls. At high warp `simStep` runs the *statistical* integration mode (sim-years per
tick) instead of the biological mode (sim-seconds per tick); the integer tick counter
remains the canonical time either way.

### 1.4 Threading

- The **sim runs in a Web Worker** (`sim/worker` entry via `main.js`). The main thread only
  renders and handles input.
- Communication uses **transferable `ArrayBuffer`s / `SharedArrayBuffer` where available**,
  not deep structured-clone of object graphs. Organism and cell data live in typed arrays
  (structure-of-arrays), so a frame of state ships as a few buffer views.
- Graceful fallback: if `Worker` or cross-origin isolation is unavailable, the sim runs on
  the main thread behind the same message interface (`core/simHost.js`), so the app still
  works from a plain static server.

---

## 2. Module map (responsibility boundaries)

```
core/   deterministic infrastructure, no domain knowledge
  rng.js         SplitMix64 seed + xoshiro256** stream + named substreams + gaussian/pick
  clock.js       fixed-step accumulator, warp table, integration-mode switch
  events.js      tiny synchronous event bus (ordered listener arrays)
  hash.js        FNV-1a-style state hashing for the self-test
  serialize.js   snapshot ring buffer + save/URL codec (packed binary <-> base64url)
  lod.js         promote/demote, reconciliation contract, LOD selection

sim/    the world (physics, chemistry, no per-organism behavior)
  world.js       cell grid (SoA), tick orchestration
  tectonics.js   plates, uplift, ocean crust, volcanism
  erosion.js     stream-power erosion + flow accumulation + rivers
  climate.js     energy-balance temperature, winds, precipitation, ice-albedo
  atmosphere.js  CO2/O2 budget, greenhouse, oxygenation
  star.js        stellar evolution: luminosity, main-sequence lifetime, giant, end state
  abiogenesis.js first-replicator emergence rolls
  population.js  statistical Lotka–Volterra dynamics + mutation drift + migration

bio/    the one law of energy and everything that evolves under it
  genome.js      binary genome layout + codec (morph / sensor-effector / brain / life-history)
  bodyBuilder.js genome -> articulated body (recursive graph, symmetry, segment cap)
  brain.js       NEAT network build + per-tick evaluation (recurrent, activation palette)
  physics.js     Verlet articulated bodies + collisions + drag
  metabolism.js  THE ENERGY LAW: gain, cost, death. No species-role terms, ever.
  reproduction.js crossover (align by innovation id) + mutation operators + innovation registry
  speciation.js  compatibility distance (NEAT delta + morph) + clustering + phylogeny

civ/    emerges on top of genetics, only if selection allows
  intelligence.js emergence thresholds (brain complexity, sociality, manipulation)
  culture.js      meme pool: learned, non-genetic, fast drift/selection
  civilization.js aggregate tech tiers, territory, biosphere feedback

render/ main thread only; reads typed-array views
  camera.js       continuous zoom (organism <-> planet), pan, follow, globe/flat
  worldRenderer.js instanced WebGL cells
  organismRenderer.js instanced WebGL bodies
  brainViz.js     live neural-net visualization
  charts.js       2D-canvas charts (population time-series, etc.)
  theme.js        CSS custom-property themes, persisted

ui/     DOM chrome; no per-organism DOM nodes ever
  panels.js, timeline.js, inspector.js, treeOfLife.js, chronicle.js,
  godTools.js, newWorld.js, commandPalette.js

data/   static tables (pure functions / lookups)
  naming.js   binomial grammar + etymology (seeded per lineage)
  presets.js  curated starter seeds
  biomes.js   Whittaker classification table
```

**Dependency direction:** `core` depends on nothing. `sim` and `bio` depend on `core`.
`civ` depends on `bio` + `sim` + `core`. `render`/`ui` depend on everything but are
main-thread-only and read-only w.r.t. sim state (they never mutate the world; they post
intervention messages). Nothing in `sim`/`bio`/`civ` may import from `render`/`ui`.

---

## 3. Data layout

All organism and cell data is **structure-of-arrays in typed arrays**. Births/deaths reuse
slots from an object pool (a free-list of indices), so the per-tick hot loop performs **zero
allocation**. A "handle" to an agent is its integer slot index, not an object reference.

Cell fields (SoA, one `Float32Array`/`Int*Array` per field, length = gridW·gridH):
`elevation, crustAge, plateId, temperature, waterDepth, soilMoisture, insolation,
nutrientN, nutrientP, nutrientMin, biomeId, o2, co2, detritus`, plus per-cell species-density
references.

Agent fields (SoA): position, velocity, energy, age, speciesId, genomeRef, body-segment
block, brain-activation block. Brains and bodies of like species share topology; only
weights/scalars differ, so per-agent storage stays small.

---

## 4. The energy law (the only selection code)

`bio/metabolism.js`, per full-fidelity agent per tick:

```
gain  = photoCap·insolation(cell)·exposedArea·aerobicFactor
      + digestCap·biteEnergy                       // when mouth contacts edible mass
cost  = basalRate·totalMass
      + k_brain·brainSize                          // a bigger brain is a real tax
      + Σ_joint |torque·Δangle|                    // actuation
      + k_move·drag·speed²                         // locomotion
      + k_sense·sensorCount
      + reproductionDraw                           // only on a reproduction event
energy += (gain − cost)·efficiency
die if energy ≤ 0 (starvation); mortality rises past maxLifespan; temp outside tolerance
drains energy. A corpse becomes detritus (nutrients + food for decomposers).
```

**There is no term referencing a species role.** No `if (isPredator) reward += …` exists
anywhere in the codebase. Predation, herbivory, decomposition, parasitism, pack-hunting,
camouflage, and intelligence are *expressed strategies* — outcomes of body + brain +
placement + the energy law — not assigned roles. Fitness is never written down; it is simply
whether a genome made more surviving copies of itself.

---

## 5. Time-travel & persistence

- **Snapshots** (`core/serialize.js`): every K ticks (K scales with warp) a compact
  typed-array dump goes to a ring buffer. Scrubbing seeks to the nearest earlier snapshot
  and deterministically re-simulates forward to the target tick. Bookmarks seek the same way.
  A snapshot round-trip must reproduce the state hash.
- **Save / URL:** `World = { version, seed, params, interventions[] }`. The URL hash is
  `#w=` + base64url(packed binary); `.aeon.json` is the same object pretty-printed. Because
  the core is deterministic, the hash alone replays the entire history. Interventions are
  `{tick, type, params}` deltas, applied in tick order.

---

## 6. Performance budget

60fps at interactive zoom with hundreds of full-fidelity agents. Instanced WebGL for
organisms and cells; a single 2D canvas for overlays/charts; **no per-organism DOM nodes.**
Typed-array SoA storage; object pools; no garbage in the hot loop. A live stats readout
surfaces agent count, statistical-species count, ticks/sec, sim load %, and LOD tier, so any
degradation is honest and visible. All work pauses when the tab is hidden
(`visibilitychange`). Under saturation we drop the full-fidelity agent budget before dropping
framerate.

---

## 7. What "done" means

The self-check in §8 of the brief is the acceptance test. The load-bearing ones:
same seed + interventions → identical hashed history; zoom in↔out shows no LOD seam; no
hand-authored fitness (grep-clean); genome encodes body+brain+life-history together with
working structural mutation; a full run reaches a real stellar-death ending; ≈12 orders of
time-warp without stalling; intelligence possible but not guaranteed; flat memory over a long
max-warp run; keyboard-playable, AA-contrast, reduced-motion-respecting, usable at 360px;
round-trips through URL hash and `.aeon.json`; runs from a plain static server with no build
step and no runtime dependencies.
