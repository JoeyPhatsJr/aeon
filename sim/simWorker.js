// sim/simWorker.js
// Thin worker wrapper around SimEngine. The engine holds all sim logic; this file only wires
// postMessage in/out and drives engine.tick on a ~60Hz timer (workers have no rAF). Uses
// performance.now for pacing only — pacing is a stats-layer concern; the sim core keys off the
// integer tick counter, so determinism is unaffected.

import { SimEngine } from './simEngine.js';

const engine = new SimEngine((msg, transfer) => self.postMessage(msg, transfer || []));

let running = true;
let hidden = false;
let last = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'stop') { running = false; return; }
  if (m.type === 'setHidden') { hidden = !!m.hidden; last = 0; return; } // pause the loop; no sim advance
  try {
    engine.handle(m);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
};

function loop() {
  if (!running) return;
  if (hidden) { setTimeout(loop, 200); return; }
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  try {
    engine.tick(dt);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
  setTimeout(loop, 1000 / 60);
}

// Announce liveness so the host can confirm the worker actually runs (else it falls back).
self.postMessage({ type: 'boot' });
loop();
