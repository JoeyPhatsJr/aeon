// render/camera.js
// Seamless continuous zoom from a single organism (see its body move) to the whole planet,
// with wrap-aware panning (the world is a horizontal cylinder), follow-a-target, and a
// flat/globe toggle. The camera converts between world cell coordinates and screen pixels.
// Pure presentation; it never touches sim state.

export class Camera {
  constructor(worldW, worldH) {
    this.worldW = worldW;
    this.worldH = worldH;
    // Center in world coords.
    this.cx = worldW / 2;
    this.cy = worldH / 2;
    // Pixels-per-cell. zoom is stored as a continuous scale; `zoom01` maps it to [0,1] for LOD.
    this.scale = 6;
    this.minScale = 2;
    this.maxScale = 240; // fully zoomed to one organism
    this.viewW = 800;
    this.viewH = 400;
    this.followId = -1;
    this.globe = false;
    this.globeSpin = 0;
  }

  resize(w, h) { this.viewW = w; this.viewH = h; }

  // Fit the whole planet.
  fitPlanet() {
    this.scale = Math.max(this.minScale, this.viewW / this.worldW);
    this.cx = this.worldW / 2; this.cy = this.worldH / 2;
  }

  // zoom01 in [0,1]: 0 == whole planet, 1 == single organism. Feeds the LOD manager.
  get zoom01() {
    const t = (Math.log(this.scale) - Math.log(this.minScale)) / (Math.log(this.maxScale) - Math.log(this.minScale));
    return Math.max(0, Math.min(1, t));
  }

  zoomBy(factor, sx, sy) {
    // Zoom toward a screen point (sx, sy).
    const before = this.screenToWorld(sx, sy);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    const after = this.screenToWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.clampY();
  }

  setZoom01(z) {
    const t = Math.max(0, Math.min(1, z));
    this.scale = Math.exp(Math.log(this.minScale) + t * (Math.log(this.maxScale) - Math.log(this.minScale)));
  }

  panBy(dxPixels, dyPixels) {
    this.cx += dxPixels / this.scale;
    this.cy += dyPixels / this.scale;
    this.wrapCenter();
    this.clampY();
  }

  wrapCenter() { this.cx = ((this.cx % this.worldW) + this.worldW) % this.worldW; }
  clampY() {
    const half = this.viewH / (2 * this.scale);
    this.cy = Math.max(half, Math.min(this.worldH - half, this.cy));
    if (this.worldH * this.scale < this.viewH) this.cy = this.worldH / 2;
  }

  follow(target) {
    if (!target) return;
    this.cx = target.x; this.cy = target.y;
    this.wrapCenter(); this.clampY();
  }

  worldToScreen(wx, wy) {
    // Wrap-aware: choose the copy of wx nearest the center.
    let dx = wx - this.cx;
    if (dx > this.worldW / 2) dx -= this.worldW; else if (dx < -this.worldW / 2) dx += this.worldW;
    return { x: this.viewW / 2 + dx * this.scale, y: this.viewH / 2 + (wy - this.cy) * this.scale };
  }

  screenToWorld(sx, sy) {
    return {
      x: this.cx + (sx - this.viewW / 2) / this.scale,
      y: this.cy + (sy - this.viewH / 2) / this.scale,
    };
  }

  // Visible world-cell bounds (for culling). Returns {x0,x1,y0,y1} possibly with x0>x1 (wrap).
  visibleBounds() {
    const halfW = this.viewW / (2 * this.scale);
    const halfH = this.viewH / (2 * this.scale);
    return {
      x0: this.cx - halfW, x1: this.cx + halfW,
      y0: Math.max(0, this.cy - halfH), y1: Math.min(this.worldH, this.cy + halfH),
    };
  }
}
