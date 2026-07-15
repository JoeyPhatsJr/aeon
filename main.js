// main.js
// Bootstrap: wires the sim host (worker or fallback), the renderers, the camera, and every UI
// panel into one live loop. The main thread only renders and handles input; all sim state lives
// behind the SimHost message interface. Interventions and camera moves are posted as messages;
// frames come back with a painted world image + packed agents + stats + events.

import { initTheme, toggleTheme } from './render/theme.js';
import { WARPS, formatSimTime, Clock } from './core/clock.js';
import { runSelfTest } from './core/selftest.js';
import { SimHost } from './core/simHost.js';
import { Camera } from './render/camera.js';
import { WorldRenderer, OVERLAY } from './render/worldRenderer.js';
import { OrganismRenderer } from './render/organismRenderer.js';
import { Panels } from './ui/panels.js';
import { CommandPalette } from './ui/commandPalette.js';
import { Chronicle } from './ui/chronicle.js';
import { Inspector } from './ui/inspector.js';
import { TreeOfLife } from './ui/treeOfLife.js';
import { Timeline } from './ui/timeline.js';
import { GodTools } from './ui/godTools.js';
import { NewWorld } from './ui/newWorld.js';
import { worldToHash, worldToJson, worldFromHash } from './core/serialize.js';
import { PHASE_NAME } from './sim/star.js';

async function runSelfTestPage() {
  // Include bio + sim tests when available (dynamic import so the fast core path stays light).
  const [{ bioTests }, { simTests }] = await Promise.all([import('./bio/biotest.js'), import('./sim/simtest.js')]);
  const result = runSelfTest([...bioTests, ...simTests]);
  document.body.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:24px;font:13px/1.5 ui-monospace,Menlo,monospace;color:#dfe;background:#070b12;min-height:100vh;margin:0;white-space:pre-wrap;';
  pre.textContent = `AEON self-test — ${result.pass} passed, ${result.fail} failed\n${'='.repeat(48)}\n\n` +
    result.lines.join('\n') + `\n\n${result.fail === 0 ? 'ALL GREEN ✓' : 'FAILURES PRESENT ✗'}`;
  document.body.appendChild(pre);
  document.title = `AEON selftest ${result.fail === 0 ? 'OK' : 'FAIL'}`;
}

// ---- App state ----
const app = {
  host: null,
  cam: null,
  worldR: null,
  orgR: null,
  W: 256, H: 128,
  latestFrame: null,
  lastStats: null,
  paused: false,
  warpIndex: 3,
  selectedSpecies: -1,
  world: null, // {seed, params, interventions} for save/hash
  ready: false,
};

const els = {};

function boot() {
  window.__aeonBooted = true; // tells the startup watchdog (index.html) the module app is alive
  cacheEls();
  window.AEON = app; // debug/introspection hook (harmless; read-only use)
  if (els.bootStatus) els.bootStatus.textContent = 'generating the world…';
  initTheme();
  setupControls();
  setupCommandPalette();
  setupPanelsUI();
  setupCanvasInput();

  app.host = new SimHost();
  app.host.on('ready', onReady);
  app.host.on('frame', onFrame);
  app.host.on('tree', onTree);
  app.host.on('save', onSave);
  app.host.on('error', (m) => console.error('[sim]', m.message));

  app.newWorld = new NewWorld((seed, params) => startWorld(seed, params));

  document.addEventListener('visibilitychange', () => app.host && app.host.setHidden(document.hidden));

  app.host.start().then((mode) => {
    els.stats.textContent = `sim online (${mode}) · igniting…`;
    // Start from URL hash if present, else the default world.
    const fromHash = tryLoadHash();
    if (!fromHash) startWorld('20260715', undefined);
  });

  startRenderLoop();
}

function cacheEls() {
  const ids = ['viewport', 'overlay', 'stats', 'boot', 'boot-status', 'warp-select', 'btn-play', 'btn-warpup', 'btn-warpdown', 'scrub', 'time-readout', 'palette', 'palette-input', 'palette-list', 'chronicle-feed'];
  for (const id of ids) els[camel(id)] = document.getElementById(id);
  els.rail = document.querySelector('.rail');
}
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// ---- Sim lifecycle ----
function startWorld(seed, params) {
  const p = params || defaultParams();
  app.world = { seed, params: p, interventions: [] };
  app.host.post({ type: 'init', seed, params: p, interventions: [], warpIndex: app.warpIndex });
  updateHash();
}

function defaultParams() {
  return { mass: 1.0, waterFrac: 0.68, co2_0: 0.85, o2_0: 0.0, tilt: 23.4, gridRes: 256, baseMutation: 0.06, cognitionCost: 1.0 };
}

function onReady(msg) {
  window.__aeonReady = true; // tells the startup watchdog the first world is live
  app.readyTime = performance.now(); // ms from navigation start until the first world is live
  app.W = msg.W; app.H = msg.H;
  app.cam = new Camera(msg.W, msg.H);
  app.cam.resize(innerWidth, innerHeight);
  app.cam.fitPlanet();
  app.cam.scale = Math.max(app.cam.minScale, (innerWidth / msg.W) * 1.2);
  app.worldR = new WorldRenderer(msg.W, msg.H);
  app.orgR = new OrganismRenderer();
  app.ready = true;
  app.lifetime = msg.lifetime;
  app.timeline.setLifetime(msg.lifetime, new Clock().simSecPerTick);
  els.boot && els.boot.classList.add('hide');
  postCamera();
}

function onFrame(msg) {
  app.latestFrame = msg;
  app.lastStats = msg.stats;
  if (app.worldR && msg.image) {
    app.worldR.rebuildFromRGBA(new Uint8ClampedArray(msg.image));
  }
  // Unpack agents into the organism renderer's expected shape.
  if (msg.agents) {
    const f = new Float32Array(msg.agents);
    const count = msg.agentCount | 0;
    const F = msg.fields;
    const a = app._agentScratch || (app._agentScratch = {});
    a.count = count;
    a.x = new Float32Array(count); a.y = new Float32Array(count); a.radius = new Float32Array(count);
    a.hue = new Float32Array(count); a.sat = new Float32Array(count); a.val = new Float32Array(count);
    a.heading = new Float32Array(count); a.segCount = new Float32Array(count); a.species = new Float32Array(count);
    a.elong = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * F;
      a.x[i] = f[o]; a.y[i] = f[o + 1]; a.radius[i] = f[o + 2];
      a.hue[i] = f[o + 3]; a.sat[i] = f[o + 4]; a.val[i] = f[o + 5];
      a.heading[i] = f[o + 6]; a.segCount[i] = f[o + 7]; a.species[i] = f[o + 8];
      a.elong[i] = 1.3 + Math.min(1.2, a.segCount[i] * 0.12);
    }
    app.agentFrame = { agents: a };
  }
  updateHUD(msg.stats);
  if (app.chronicle) app.chronicle.ingest(msg.events);
  if (app.inspector) app.inspector.update(msg.selected);
  if (msg.selected) { app.selectedSpecies = msg.selected.speciesId; app.godTools.setSelected(msg.selected.speciesId, msg.selected.name); app.orgR.selectedId = msg.selected.speciesId; }
  if (app.timeline && msg.stats) app.timeline.setCurrent(msg.stats.tick);
  updateWorldPanel(msg.stats);
}

function onTree(msg) {
  if (app.tree) app.tree.setData(msg.species, msg.nowTick);
  // Update command palette dynamic entries (species search).
  if (app.palette) {
    app.palette.setDynamic(msg.species.filter((s) => s.deathTick < 0).slice(0, 40).map((s) => ({
      id: 'sp' + s.id, label: 'Species: ' + s.name, run: () => selectSpecies(s.id),
    })));
  }
}

function onSave(msg) {
  // Download .aeon.json.
  const json = worldToJson({ seed: BigInt(msg.world.seed), params: msg.world.params, interventions: msg.world.interventions });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'world.aeon.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Render loop ----
function startRenderLoop() {
  const canvas = els.viewport;
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * dpr); canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (app.cam) app.cam.resize(innerWidth, innerHeight);
  }
  resize();
  addEventListener('resize', resize);

  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!app.ready || !app.cam || !app.worldR) { drawBootBg(ctx, reduce); return; }
    // Follow.
    if (app.cam.followId >= 0 && app.agentFrame) { /* follow handled via selected pose later */ }
    app.worldR.draw(ctx, app.cam);
    if (app.agentFrame) app.orgR.draw(ctx, app.cam, app.agentFrame);
    drawVignette(ctx);
  }
  requestAnimationFrame(frame);
}

function drawBootBg(ctx, reduce) {
  const w = innerWidth, h = innerHeight;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.16;
  const t = reduce ? 0.5 : (performance.now() * 0.0004 % 1);
  const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
  g.addColorStop(0, `rgba(255,${140 + 60 * t | 0},60,0.5)`); g.addColorStop(1, 'rgba(30,15,8,0.05)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
}

function drawVignette(ctx) {
  const w = innerWidth, h = innerHeight;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

// ---- HUD & panels ----
function updateHUD(s) {
  if (!s) return;
  els.stats.textContent = `${s.timeLabel} · ${WARPS[s.warp].label} · agents ${s.agentCount} · stat-species ${s.statSpecies} · LOD ${s.lodTier} · ${s.starPhase}`;
  els.timeReadout.innerHTML = `<strong>${s.timeLabel}</strong> · ${WARPS[s.warp].label}`;
  els.warpSelect.value = String(s.warp);
  app.warpIndex = s.warp;
}

function updateWorldPanel(s) {
  if (!s || !els.worldBody) return;
  els.worldBody.innerHTML =
    wrow('Star', `${s.starPhase} · ${s.luminosity.toFixed(2)} L☉`) +
    wrow('Atmosphere', `O₂ ${(s.o2 * 100).toFixed(1)}% · CO₂ ${s.co2.toFixed(2)}`) +
    wrow('Life', s.lifeExists ? `${s.livingSpecies} living species` : 'lifeless') +
    wrow('Oxygenated', s.oxygenated ? 'yes' : 'no') +
    wrow('Civilizations', String(s.civCount)) +
    wrow('Total lineages', String(s.totalSpecies)) +
    wrow('Milestones', String(s.milestones));
}
function wrow(l, v) { return `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;"><span class="muted">${l}</span><span class="num">${v}</span></div>`; }

// ---- Controls ----
function setupControls() {
  els.warpSelect.innerHTML = '';
  WARPS.forEach((w, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = w.label; els.warpSelect.appendChild(o); });
  els.warpSelect.value = String(app.warpIndex);
  els.warpSelect.addEventListener('change', () => setWarp(parseInt(els.warpSelect.value, 10)));
  els.btnPlay.addEventListener('click', togglePlay);
  els.btnWarpup.addEventListener('click', () => setWarp(app.warpIndex + 1));
  els.btnWarpdown.addEventListener('click', () => setWarp(app.warpIndex - 1));
  addEventListener('keydown', onKey);

  // Timeline.
  app.timeline = new Timeline(els.scrub, els.timeReadout, (tick) => app.host.post({ type: 'scrub', tick }));
}

function setWarp(i) {
  app.warpIndex = Math.max(0, Math.min(WARPS.length - 1, i));
  els.warpSelect.value = String(app.warpIndex);
  app.host.post({ type: 'setWarp', index: app.warpIndex });
}
function togglePlay() {
  app.paused = !app.paused;
  els.btnPlay.textContent = app.paused ? '▶' : '▮▮';
  els.btnPlay.setAttribute('aria-label', app.paused ? 'Play (Space)' : 'Pause (Space)');
  app.host.post({ type: 'setPaused', paused: app.paused });
}

function onKey(e) {
  if (app.palette && app.palette.onKey(e)) return;
  const tag = e.target && e.target.tagName;
  if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && e.key !== '/') return;
  switch (e.key) {
    case ' ': togglePlay(); e.preventDefault(); break;
    case '[': setWarp(app.warpIndex - 1); break;
    case ']': setWarp(app.warpIndex + 1); break;
    case '=': case '+': zoom(1.2); break;
    case '-': case '_': zoom(1 / 1.2); break;
    case 'ArrowLeft': pan(-40, 0); break;
    case 'ArrowRight': pan(40, 0); break;
    case 'ArrowUp': pan(0, -40); break;
    case 'ArrowDown': pan(0, 40); break;
    case 'w': case 'W': app.panels.toggle('world'); break;
    case 'c': case 'C': app.panels.toggle('chronicle'); break;
    case 'g': case 'G': app.panels.toggle('god'); break;
    case 'l': case 'L': case 't': case 'T': case 'i': case 'I': app.panels.toggle('life'); break;
    case 'n': case 'N': app.newWorld.open(); break;
    case 'f': case 'F': toggleFollow(); break;
    case '/': app.palette.open(); e.preventDefault(); break;
    default: break;
  }
}

function zoom(factor) { if (!app.cam) return; app.cam.zoomBy(factor, innerWidth / 2, innerHeight / 2); postCamera(); }
function pan(dx, dy) { if (!app.cam) return; app.cam.panBy(dx, dy); postCamera(); }
function toggleFollow() { /* selection-based follow: center on selected next frames */ if (app.lastSelectedWorld) { app.cam.follow(app.lastSelectedWorld); postCamera(); } }

function postCamera() {
  if (!app.cam || !app.host) return;
  app.host.post({ type: 'camera', zoom: app.cam.zoom01, cx: app.cam.cx, cy: app.cam.cy });
}

// ---- Canvas input (pan / zoom / select / touch) ----
function setupCanvasInput() {
  const c = els.viewport;
  let dragging = false, lastX = 0, lastY = 0, moved = 0;
  c.addEventListener('pointerdown', (e) => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', (e) => {
    if (!dragging || !app.cam) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    app.cam.panBy(-dx, -dy); postCamera();
  });
  c.addEventListener('pointerup', (e) => {
    dragging = false;
    if (moved < 5 && app.cam) selectAt(e.clientX, e.clientY);
  });
  c.addEventListener('wheel', (e) => {
    if (!app.cam) return; e.preventDefault();
    app.cam.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); postCamera();
  }, { passive: false });

  // Pinch zoom.
  const pointers = new Map();
  let pinchDist = 0;
  c.addEventListener('pointerdown', (e) => pointers.set(e.pointerId, e));
  c.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      if (pinchDist) { app.cam.zoomBy(d / pinchDist, (pts[0].clientX + pts[1].clientX) / 2, (pts[0].clientY + pts[1].clientY) / 2); postCamera(); }
      pinchDist = d;
    }
  });
  const clear = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchDist = 0; };
  c.addEventListener('pointerup', clear); c.addEventListener('pointercancel', clear);
}

function selectAt(sx, sy) {
  const wp = app.cam.screenToWorld(sx, sy);
  app.lastSelectedWorld = { x: ((wp.x % app.W) + app.W) % app.W, y: Math.max(0, Math.min(app.H - 1, wp.y)) };
  app.host.post({ type: 'select', speciesId: -1, x: app.lastSelectedWorld.x, y: app.lastSelectedWorld.y });
  app.panels.show('life');
}
function selectSpecies(id) {
  app.selectedSpecies = id;
  app.host.post({ type: 'select', speciesId: id });
  app.panels.show('life');
}

// ---- Panels UI wiring ----
function setupPanelsUI() {
  app.panels = new Panels(els.rail, ['life', 'world', 'chronicle', 'god']);

  // Life panel: inspector + tree of life.
  const lifePanel = document.getElementById('panel-life');
  app.inspector = new Inspector(lifePanel);
  const treeH = document.createElement('h3'); treeH.textContent = 'Tree of Life';
  lifePanel.appendChild(treeH);
  const treeCanvas = document.createElement('canvas');
  treeCanvas.width = 340; treeCanvas.height = 220;
  treeCanvas.style.cssText = 'width:100%;height:auto;background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius-sm);';
  lifePanel.appendChild(treeCanvas);
  app.tree = new TreeOfLife(treeCanvas, (id) => selectSpecies(id));

  // World panel: overlay buttons + readouts.
  const worldPanel = document.getElementById('panel-world');
  worldPanel.innerHTML = '<h2>World</h2>';
  const ovWrap = document.createElement('div');
  ovWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
  [['Biome', OVERLAY.BIOME], ['Temp', OVERLAY.TEMPERATURE], ['Elev', OVERLAY.ELEVATION], ['Moisture', OVERLAY.MOISTURE], ['Life', OVERLAY.LIFE]].forEach(([label, mode]) => {
    const b = document.createElement('button'); b.textContent = label;
    b.style.cssText = 'background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:5px 9px;cursor:pointer;font-family:inherit;font-size:var(--fs-sm);';
    b.addEventListener('click', () => { if (app.worldR) app.worldR.setOverlay(mode); app.host.post({ type: 'overlay', overlay: mode }); });
    ovWrap.appendChild(b);
  });
  worldPanel.appendChild(ovWrap);
  els.worldBody = document.createElement('div'); els.worldBody.className = 'num'; els.worldBody.style.fontSize = 'var(--fs-sm)';
  worldPanel.appendChild(els.worldBody);

  // Chronicle.
  app.chronicle = new Chronicle(els.chronicleFeed);
  const chronPanel = document.getElementById('panel-chronicle');
  const exportBtn = document.createElement('button'); exportBtn.textContent = 'Export chronicle';
  exportBtn.style.cssText = 'margin-top:10px;background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;cursor:pointer;font-family:inherit;font-size:var(--fs-sm);';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([app.chronicle.exportText()], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chronicle.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  chronPanel.appendChild(exportBtn);

  // God tools.
  app.godTools = new GodTools(document.getElementById('panel-god'), (ivType, params) => {
    app.host.post({ type: 'intervention', ivType, params });
    if (app.world) app.world.interventions.push({ tick: app.lastStats ? app.lastStats.tick : 0, type: ivType, params });
    updateHash();
  });
}

// ---- Command palette ----
function setupCommandPalette() {
  app.palette = new CommandPalette(els.palette, els.paletteInput, els.paletteList);
  app.palette.setCommands([
    { id: 'play', label: 'Play / Pause', run: togglePlay },
    { id: 'warpup', label: 'Warp up', run: () => setWarp(app.warpIndex + 1) },
    { id: 'warpdown', label: 'Warp down', run: () => setWarp(app.warpIndex - 1) },
    { id: 'new', label: 'New world…', run: () => app.newWorld.open() },
    { id: 'theme', label: 'Toggle light / dark theme', run: () => toggleTheme() },
    { id: 'life', label: 'Open Life (Tree of Life + inspector)', run: () => app.panels.show('life') },
    { id: 'world', label: 'Open World (climate, star)', run: () => app.panels.show('world') },
    { id: 'chronicle', label: 'Open Chronicle', run: () => app.panels.show('chronicle') },
    { id: 'god', label: 'Open God tools', run: () => app.panels.show('god') },
    { id: 'save', label: 'Save world to file (.aeon.json)', run: () => app.host.post({ type: 'save' }) },
    { id: 'copy', label: 'Copy shareable world link', run: copyHash },
    { id: 'fit', label: 'Fit whole planet', run: () => { if (app.cam) { app.cam.fitPlanet(); postCamera(); } } },
    { id: 'selftest', label: 'Run self-test', run: () => { location.search = '?selftest'; } },
  ]);
}

// ---- Save / URL hash ----
function updateHash() {
  if (!app.world) return;
  try {
    const hash = worldToHash({ seed: BigInt(seedToBig(app.world.seed)), params: app.world.params, interventions: app.world.interventions });
    history.replaceState(null, '', '#' + hash);
  } catch (_) { /* ignore */ }
}
function seedToBig(seed) {
  if (typeof seed === 'bigint') return seed;
  if (/^\d+$/.test(String(seed))) return String(seed);
  // Hash text seed to a number string deterministically.
  let h = 0n; const s = String(seed); for (let i = 0; i < s.length; i++) h = (h * 131n + BigInt(s.charCodeAt(i))) & ((1n << 64n) - 1n);
  return h.toString();
}
function copyHash() {
  updateHash();
  if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(() => {});
}
function tryLoadHash() {
  if (!location.hash || location.hash.indexOf('w=') < 0) return false;
  try {
    const w = worldFromHash(location.hash);
    if (!w) return false;
    app.world = { seed: w.seed, params: w.params, interventions: w.interventions };
    app.host.post({ type: 'init', seed: w.seed, params: w.params, interventions: w.interventions, warpIndex: app.warpIndex });
    return true;
  } catch (_) { return false; }
}

void PHASE_NAME; void formatSimTime;

// ---- Entry point (after all declarations, so no temporal-dead-zone on module consts) ----
if (/[?&]selftest\b/.test(location.search)) {
  runSelfTestPage();
} else {
  boot();
}
