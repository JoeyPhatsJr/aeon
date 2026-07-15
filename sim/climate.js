// sim/climate.js
// Coarse-but-honest climate (Appendix H). Per climate step, for each cell:
//   insolation  = stellar constant · cos(latitude) · seasonal tilt   (also feeds autotrophs)
//   T_eq        = energy balance: incoming shortwave·(1−albedo) + greenhouse − radiative loss
//   T           relaxes toward T_eq with ocean thermal inertia + lateral diffusion (winds)
//   moisture    picked up over ocean, carried by latitudinal wind bands, dropped on rise
//               (coasts, windward mountains) — lee slopes become rain shadows → deserts
//   ice-albedo  ice raises albedo, which cools, which grows ice: a real feedback that can run
//               away into a snowball or, with high CO2 + a bright star, a hothouse.

import { biomeAlbedo } from '../data/biomes.js';
import { EV } from '../core/events.js';

const YEAR = 365.25 * 24 * 3600;

export function stepClimate(world, dtSim, init) {
  const W = world.W, H = world.H;
  const star = world.star;
  const lum = star.insolationScale(); // ~1 at habitable baseline, balloons in the giant phase

  // Seasonal phase from sim-time and axial tilt.
  const yearPhase = (world.simSeconds % YEAR) / YEAR; // 0..1
  const tiltRad = (world.params.tilt * Math.PI) / 180;
  const subsolarLat = Math.sin(yearPhase * 2 * Math.PI) * tiltRad; // latitude of max sun

  // Greenhouse forcing from CO2 + water vapor (global, coarse). Calibrated so modern-ish CO2
  // adds ~+11°C and a high-CO2 hothouse start adds ~+22°C (saturating).
  const co2 = world.atmosphere.co2;
  const greenhouse = 8 + 14 * Math.log(1 + 2 * co2); // °C of warming, saturating

  // Relaxation rates: land responds fast, ocean slow (thermal inertia).
  const landRate = Math.min(1, 0.15 * Math.max(1, dtSim / (YEAR)) + (init ? 1 : 0.02));
  const oceanRate = Math.min(1, 0.04 * Math.max(1, dtSim / (YEAR)) + (init ? 1 : 0.005));

  // Compute insolation + equilibrium temperature.
  for (let y = 0; y < H; y++) {
    const lat = (y / (H - 1)) * Math.PI - Math.PI / 2; // -pi/2..pi/2
    const solar = Math.max(0, Math.cos(lat - subsolarLat));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ins = lum * solar;
      world.insolation[i] = ins;

      const albedo = world.waterDepth[i] > 0
        ? (world.temperature[i] < -2 ? 0.6 : 0.08)   // sea ice vs open water
        : biomeAlbedo(world.biomeId[i]);

      // Energy balance -> equilibrium temperature (°C). Calibrated: at mid-main-sequence
      // (lum≈1), a baseline world averages ~+15°C, equator ~+40°C, poles below freezing —
      // and the giant-phase luminosity blow-up drives Teq far past boiling (oceans boil).
      const shortwave = ins * 72 * (1 - albedo);
      const Teq = -32 + shortwave + greenhouse - (world.elevation[i] > 0 ? world.elevation[i] * 6 : 0);

      const rate = world.waterDepth[i] > 0 ? oceanRate : landRate;
      world.temperature[i] += (Teq - world.temperature[i]) * rate;
    }
  }

  // Lateral diffusion (winds smear heat along and across latitudes). One Jacobi pass.
  diffuseTemperature(world, init ? 0.25 : 0.12);

  // Moisture transport: oceans evaporate; latitudinal wind bands carry vapor; rise => rain.
  updateMoisture(world);

  // Oceans-condense milestone: once most ocean cells are below boiling, liquid water exists.
  if (!world._milestones.has('oceans_condense')) {
    let cool = 0, ocean = 0;
    for (let i = 0; i < world.N; i++) {
      if (world.waterDepth[i] > 0) { ocean++; if (world.temperature[i] < 60) cool++; }
    }
    if (ocean > 0 && cool / ocean > 0.6 && world.simSeconds > star.accretionTime * 0.5) {
      world.milestone('oceans_condense', EV.OCEANS_CONDENSE, {});
    }
  }

  // Snowball / hothouse detection.
  detectClimateExtremes(world);
}

function diffuseTemperature(world, k) {
  const W = world.W, H = world.H;
  const T = world.temperature;
  const tmp = world._climTmp || (world._climTmp = new Float32Array(world.N));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const l = T[y * W + ((x - 1 + W) % W)];
      const r = T[y * W + ((x + 1) % W)];
      const u = y > 0 ? T[(y - 1) * W + x] : T[i];
      const d = y < H - 1 ? T[(y + 1) * W + x] : T[i];
      tmp[i] = T[i] + k * ((l + r + u + d) * 0.25 - T[i]);
    }
  }
  T.set(tmp);
}

function updateMoisture(world) {
  const W = world.W, H = world.H;
  for (let y = 0; y < H; y++) {
    // Wind direction alternates by latitude band (trade winds / westerlies) — sign of dx.
    const band = Math.floor((y / H) * 6);
    const windDir = (band % 2 === 0) ? 1 : -1;
    let carried = 0;
    for (let step = 0; step < W; step++) {
      const x = windDir > 0 ? step : (W - 1 - step);
      const i = y * W + x;
      if (world.waterDepth[i] > 0) {
        // Evaporate from warm oceans.
        carried += Math.max(0, world.temperature[i]) * 0.0006;
        world.soilMoisture[i] = 1;
      } else {
        // Orographic + coastal rain: drop moisture proportional to terrain rise.
        const px = ((x - windDir) % W + W) % W;
        const rise = Math.max(0, world.elevation[i] - world.elevation[y * W + px]);
        const drop = carried * (0.05 + rise * 0.4);
        world.soilMoisture[i] = Math.max(0, Math.min(1, 0.15 + drop));
        carried = Math.max(0, carried - drop);
        // Rain shadow: lee of mountains stays dry (carried already depleted uphill).
      }
    }
  }
}

function detectClimateExtremes(world) {
  let frozen = 0, hot = 0;
  for (let i = 0; i < world.N; i++) {
    if (world.temperature[i] < -10) frozen++;
    else if (world.temperature[i] > 55) hot++;
  }
  const f = frozen / world.N, h = hot / world.N;
  // Fire once per EPISODE: latch while the extreme holds, reset only after climate recovers,
  // so a persistent snowball narrates once instead of every tick.
  const snowballNow = f > 0.85;
  const hothouseNow = h > 0.7;
  if (snowballNow && !world._snowballLatched) { world._snowballLatched = true; world.bus.emit(EV.SNOWBALL, { tick: world.tick, simSeconds: world.simSeconds }); }
  if (!snowballNow && f < 0.5) world._snowballLatched = false;
  if (hothouseNow && !world._hothouseLatched) { world._hothouseLatched = true; world.bus.emit(EV.HOTHOUSE, { tick: world.tick, simSeconds: world.simSeconds }); }
  if (!hothouseNow && h < 0.4) world._hothouseLatched = false;
}
