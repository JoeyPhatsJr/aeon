// render/organismRenderer.js
// Draws full-fidelity agents. No per-organism DOM — everything is batched canvas paths. At low
// zoom an agent is a dot tinted by its evolved coloration genes; as you zoom in it becomes an
// oriented body (a main capsule plus a few segment/limb blobs derived from its body summary),
// so camouflage (hue/value matching the biome) and warning coloration (high saturation) are
// literally visible. The selected/followed agent can be drawn from its real posed skeleton.

export class OrganismRenderer {
  constructor() {
    this.selectedId = -1;
  }

  // frame.agents: { count, x, y, radius, hue, sat, val, heading, role, species, elong, segCount }
  // all typed arrays of length `count` (packed, alive only). Optional frame.selectedPose:
  // array of {x,y,radius,hue,sat,val} posed segments in world coords for the selected agent.
  draw(ctx, cam, frame) {
    const a = frame.agents;
    if (!a || a.count === 0) return;
    const bounds = cam.visibleBounds();
    const zoom = cam.zoom01;

    for (let i = 0; i < a.count; i++) {
      const wx = a.x[i], wy = a.y[i];
      // Cull (wrap-aware in x handled by worldToScreen).
      if (wy < bounds.y0 - 2 || wy > bounds.y1 + 2) continue;
      const s = cam.worldToScreen(wx, wy);
      if (s.x < -20 || s.x > cam.viewW + 20 || s.y < -20 || s.y > cam.viewH + 20) continue;

      const px = a.radius[i] * cam.scale;
      // Brightness floor so dark-evolved organisms stay visible against ocean/night; the true
      // hue/sat still read (camouflage vs. warning coloration remain distinguishable).
      const [r, g, b] = hsv2rgb(a.hue[i], a.sat[i], Math.max(0.42, a.val[i]));

      if (px < 2.2) {
        // Dot with a faint dark rim for contrast.
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
      } else {
        this._drawBody(ctx, s.x, s.y, px, a.heading[i], a.elong ? a.elong[i] : 1.4, a.segCount ? a.segCount[i] : 3, r, g, b);
      }

      if (a.species[i] === this.selectedId || i === this.selectedIndex) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, px + 4, 0, Math.PI * 2); ctx.stroke();
      }
      void zoom;
    }

    // Real posed skeleton for the selected agent (drawn on top).
    if (frame.selectedPose && frame.selectedPose.length) {
      this._drawPose(ctx, cam, frame.selectedPose);
    }
  }

  _drawBody(ctx, x, y, r, heading, elong, segCount, cr, cg, cb) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(0.5, r * 0.12);
    // Main body: an ellipse elongated along heading, with a faint rim for contrast.
    ctx.beginPath();
    ctx.ellipse(0, 0, r * elong, r, 0, 0, Math.PI * 2);
    ctx.fill();
    if (r > 3) ctx.stroke();
    // A few segment blobs trailing behind, shrinking.
    const n = Math.min(6, Math.max(1, segCount));
    for (let k = 1; k < n; k++) {
      const rr = r * (1 - k / (n + 1));
      const off = -r * elong - rr * 0.6 * k;
      ctx.beginPath();
      ctx.ellipse(off, 0, rr, rr, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // A darker "eye" hint at the front when large enough.
    if (r > 6) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.arc(r * elong * 0.6, -r * 0.3, r * 0.15, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _drawPose(ctx, cam, pose) {
    for (let i = 0; i < pose.length; i++) {
      const seg = pose[i];
      const s = cam.worldToScreen(seg.x, seg.y);
      const [r, g, b] = hsv2rgb(seg.hue, seg.sat, seg.val);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1, seg.radius * cam.scale), 0, Math.PI * 2);
      ctx.fill();
      // Bone to parent.
      if (seg.parentSeg >= 0 && pose[seg.parentSeg]) {
        const ps = cam.worldToScreen(pose[seg.parentSeg].x, pose[seg.parentSeg].y);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = Math.max(1, seg.radius * cam.scale * 0.5);
        ctx.beginPath(); ctx.moveTo(ps.x, ps.y); ctx.lineTo(s.x, s.y); ctx.stroke();
      }
    }
  }
}

// HSV (h,s,v in [0,1]) -> [r,g,b] 0..255.
export function hsv2rgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [(r * 255) | 0, (g * 255) | 0, (b * 255) | 0];
}
