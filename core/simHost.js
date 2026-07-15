// core/simHost.js
// The main thread's handle to the simulation. It prefers a Web Worker (ARCHITECTURE §1.4) and
// falls back to running the same SimEngine on the main thread if workers are unavailable (e.g.
// a restrictive environment). Either way the interface is identical: post(msg) in, on(type,fn)
// callbacks out. The worker path probes for liveness (a 'boot' message) before committing, so a
// silently-broken worker still degrades gracefully instead of hanging.

export class SimHost {
  constructor() {
    this.worker = null;
    this.engine = null;
    this.mode = 'pending';
    this.handlers = {};
    this._queue = [];
    this._raf = 0;
    this._last = 0;
    this._booted = false;
    this._hidden = false;
  }

  start() {
    return new Promise((resolve) => {
      let settled = false;
      const commitWorker = () => { if (settled) return; settled = true; this.mode = 'worker'; this._flush(); resolve('worker'); };
      const commitMain = () => { if (settled) return; settled = true; this._fallback(); this._flush(); resolve('main'); };

      try {
        this.worker = new Worker(new URL('../sim/simWorker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
          if (e.data && e.data.type === 'boot') { this._booted = true; commitWorker(); return; }
          if (e.data && e.data.type === 'error') { console.error('[sim worker]', e.data.message); }
          this._dispatch(e.data);
        };
        this.worker.onerror = (e) => {
          console.warn('[simHost] worker error; falling back to main thread:', e.message || e);
          if (!this._booted) { try { this.worker.terminate(); } catch (_) {} this.worker = null; commitMain(); }
        };
        // If the worker never boots within the timeout, fall back.
        setTimeout(() => { if (!this._booted) { try { this.worker && this.worker.terminate(); } catch (_) {} this.worker = null; commitMain(); } }, 1500);
      } catch (err) {
        console.warn('[simHost] worker construction failed; main-thread fallback:', err);
        commitMain();
      }
    });
  }

  async _fallback() {
    if (this.engine) return;
    const { SimEngine } = await import('../sim/simEngine.js');
    this.engine = new SimEngine((msg) => this._dispatch(msg));
    this.mode = 'main';
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      if (this._hidden) { this._last = now; return; }
      const dt = this._last ? (now - this._last) / 1000 : 0;
      this._last = now;
      try { this.engine.tick(dt); } catch (e) { console.error('[sim main]', e); }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _flush() {
    for (let i = 0; i < this._queue.length; i++) this._rawPost(this._queue[i].msg, this._queue[i].transfer);
    this._queue.length = 0;
  }

  post(msg, transfer) {
    if (this.mode === 'pending') { this._queue.push({ msg, transfer }); return; }
    this._rawPost(msg, transfer);
  }

  _rawPost(msg, transfer) {
    if (this.worker) this.worker.postMessage(msg, transfer || []);
    else if (this.engine) this.engine.handle(msg);
  }

  on(type, fn) { this.handlers[type] = fn; }
  _dispatch(data) { const fn = this.handlers[data.type]; if (fn) fn(data); }

  // Pause ALL sim work when the tab is hidden, without disturbing the user's play/pause state.
  // Main-thread mode: the _hidden flag skips tick(). Worker mode: a 'setHidden' message pauses
  // its timer loop.
  setHidden(hidden) {
    this._hidden = hidden;
    this.post({ type: 'setHidden', hidden });
  }
}
