// render/worldRenderer.js
// Draws the planet's cell grid. The whole surface (256×128 ≈ 32k cells) is painted into an
// offscreen ImageData once per frame — a single putImageData, zero per-cell draw calls, no DOM
// — then blitted to the viewport scaled by the camera, drawn twice where the cylinder wraps.
// Overlay modes recolor the same buffer: biome, temperature, elevation, moisture, life density.
//
// This is the "2D-canvas instead of instanced WebGL" tradeoff (see README changelog): for a
// grid this size, ImageData is already GPU-blitted by the browser and trivially hits 60fps,
// while being far more robust than hand-written shaders.

import { BIOME_META } from '../data/biomes.js';

export const OVERLAY = { BIOME: 'biome', TEMPERATURE: 'temperature', ELEVATION: 'elevation', MOISTURE: 'moisture', LIFE: 'life' };

// Biome base colors (RGB). Kept in sync with the CSS tokens but hard-coded here for the pixel
// buffer (reading CSS per-cell would be far too slow).
const BIOME_RGB = [
  [20, 48, 74],    // ocean
  [34, 120, 128],  // reef
  [58, 104, 76],   // wetland
  [138, 156, 82],  // grassland
  [46, 130, 74],   // forest
  [28, 104, 60],   // rainforest
  [176, 158, 86],  // savanna
  [198, 160, 104], // desert
  [138, 150, 158], // tundra
  [176, 200, 222], // ice (pale blue, not white)
  [120, 132, 144], // alpine
  [122, 52, 44],   // volcanic
];

export class WorldRenderer {
  constructor(worldW, worldH) {
    this.W = worldW; this.H = worldH;
    this.canvas = document.createElement('canvas');
    this.canvas.width = worldW; this.canvas.height = worldH;
    this.octx = this.canvas.getContext('2d');
    this.image = this.octx.createImageData(worldW, worldH);
    this.overlay = OVERLAY.BIOME;
  }

  setOverlay(mode) { this.overlay = mode; }

  // Rebuild from a raw RGBA buffer already painted (by the worker via paintWorldRGBA), OR from
  // cell arrays directly (main-thread fallback). Either way ends with putImageData.
  rebuildFromRGBA(rgba) {
    this.image.data.set(rgba);
    this.octx.putImageData(this.image, 0, 0);
  }

  rebuild(frame, star) {
    paintWorldRGBA(this.image.data, this.W, this.H, frame, this.overlay, star ? star.phase : 0);
    this.octx.putImageData(this.image, 0, 0);
  }

  // Blit the offscreen grid to the main context under the camera transform, wrapping in x.
  draw(ctx, cam) {
    ctx.imageSmoothingEnabled = cam.scale < 12; // crisp cells when zoomed in
    const topLeft = cam.worldToScreen(cam.cx - cam.viewW / (2 * cam.scale), cam.cy - cam.viewH / (2 * cam.scale));
    void topLeft;
    // Draw the world image, possibly twice for wrap. Compute screen x of world x=0.
    const originScreenX = cam.viewW / 2 + (0 - cam.cx) * cam.scale;
    const worldPixW = this.W * cam.scale;
    const y = cam.viewH / 2 + (0 - cam.cy) * cam.scale;
    const h = this.H * cam.scale;
    // Find the leftmost copy that covers the screen.
    let startX = originScreenX;
    while (startX > 0) startX -= worldPixW;
    for (let x = startX; x < cam.viewW; x += worldPixW) {
      ctx.drawImage(this.canvas, x, y, worldPixW, h);
    }
  }
}

// Pure, DOM-free painter: fill `dst` (a Uint8ClampedArray/Uint8Array of length W*H*4) from the
// cell arrays. Shared by the worker (fills a transfer buffer) and the main-thread fallback.
// `cells` provides biomeId, temperature, elevation, waterDepth, soilMoisture, insolation,
// densityRef. `overlay` selects the colormap; `starPhase` washes the world in the giant phase.
export function paintWorldRGBA(dst, W, H, cells, overlay, starPhase) {
  const N = W * H;
  const giant = starPhase >= 2;
  for (let i = 0; i < N; i++) {
    let r, g, b;
    if (overlay === OVERLAY.TEMPERATURE) {
      const c = tempColor(cells.temperature[i]); r = c[0]; g = c[1]; b = c[2];
    } else if (overlay === OVERLAY.ELEVATION) {
      const c = elevColor(cells.elevation[i], cells.waterDepth[i]); r = c[0]; g = c[1]; b = c[2];
    } else if (overlay === OVERLAY.MOISTURE) {
      const m = cells.soilMoisture[i];
      r = 40 + 20 * (1 - m); g = 60 + 120 * m; b = 60 + 160 * m;
    } else if (overlay === OVERLAY.LIFE) {
      const den = Math.min(1, (cells.densityRef ? cells.densityRef[i] : 0) / 20);
      r = 20 + 30 * (1 - den); g = 30 + 200 * den; b = 40 + 60 * den;
    } else {
      const bi = cells.biomeId[i];
      const c = BIOME_RGB[bi] || [80, 80, 80];
      if (cells.waterDepth[i] > 0 && bi !== 9) {
        // Ocean: deepen with depth (deep = darker), lighten toward coasts — a legible bathymetry.
        const depth = Math.min(1, cells.waterDepth[i] / 1.5);
        const shallow = 1 - depth;
        r = c[0] * (0.7 + 0.5 * shallow); g = c[1] * (0.75 + 0.5 * shallow); b = c[2] * (0.8 + 0.4 * shallow);
      } else {
        // Land: gentle day/night from insolation (never blows out) + a soft elevation hillshade.
        const day = 0.7 + 0.26 * Math.min(1, cells.insolation[i]); // 0.7 (night) .. ~0.96 (noon)
        const hill = bi === 9 ? 1 : 0.95 + Math.min(0.1, Math.max(0, cells.elevation[i]) * 0.05);
        const s = Math.min(0.98, day * hill);
        r = c[0] * s; g = c[1] * s; b = c[2] * s;
      }
    }
    // Night side gets a gentle cool wash so the terminator is readable (not overpowering).
    if (cells.insolation[i] < 0.12) { r = r * 0.74 + 3; g = g * 0.74 + 6; b = b * 0.78 + 12; }
    if (giant) { r = Math.min(255, r * 1.08 + 48); g = Math.min(255, g * 0.85 + 12); b = Math.min(255, b * 0.6); }
    const p = i * 4;
    dst[p] = r | 0; dst[p + 1] = g | 0; dst[p + 2] = b | 0; dst[p + 3] = 255;
  }
  return dst;
}

function tempColor(t) {
  // Blue (cold) -> green (temperate) -> red (hot).
  if (t < 0) return [40, 80, 200];
  if (t < 15) return [60, 160, 200 - t * 4];
  if (t < 30) return [80 + t * 3, 180, 80];
  if (t < 60) return [220, 160 - (t - 30) * 3, 60];
  return [255, 60, 40];
}
function elevColor(e, water) {
  if (water > 0) { const d = Math.min(1, water); return [20 + 30 * (1 - d), 60 + 40 * (1 - d), 120 + 80 * (1 - d)]; }
  const v = Math.max(0, Math.min(1, (e + 1) / 4));
  return [90 + v * 120, 90 + v * 90, 70 + v * 60];
}
