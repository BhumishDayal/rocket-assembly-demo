// A virtual clock for repeatable captures, injected before any page script runs
// (Page.addScriptToEvaluateOnNewDocument). Nothing in src/ knows about it.
//   - performance.now(), Date.now() (anime.js reads it) and the rAF timestamp advance by exactly 1/fps per frame,
//     however long the frame really took, so the frame at "launch + 8 s" is the same frame on every run and every
//     machine;
//   - setTimeout / setInterval / requestIdleCallback fire on that clock (main.js presimulates on idle; choreo.js
//     sequences beats with setTimeout);
//   - Math.random is a seeded mulberry32 (stars, swarm particles, flash phases, shake);
//   - the clock is HELD (no app frame runs, the canvas keeps its last frame) except while the harness asks it to
//     run; key presses and clicks are sent while it is held, so they land on a known frame;
//   - while an <img> or fetch is in flight (planet maps) the clock does not advance, so a texture always
//     arrives on the same frame.
// Real requestAnimationFrame keeps ticking underneath (the pump), so Chrome keeps compositing. Unlike Chrome's
// --virtual-time-budget (which starves rAF and stalls anime.js), this only replaces what the page reads.
//
// Harness side: createClock(page) -> { now(), run(ms), runTo(t), runUntil(predicateSource, maxMs), stats() }.

export function vclockSource({ fps = 60, seed = 1 } = {}) {
  return `(() => {
  if (window.__vclock) return;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const realSetTimeout = window.setTimeout.bind(window);
  const STEP = 1000 / ${Number(fps)};
  const DATE0 = Date.UTC(2026, 0, 1);
  const c = (window.__vclock = { t: 0, frames: 0, held: true, until: 0, pred: null, done: null, step: STEP,
    pending: 0, stalledMs: 0, frameRealMs: 0, realNow, realSetTimeout, realRaf });

  let s = ${Number(seed) >>> 0};
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  performance.now = () => c.t;
  Date.now = () => DATE0 + Math.floor(c.t);

  let rafId = 0;
  let rafQ = new Map();
  window.requestAnimationFrame = (cb) => (rafQ.set(++rafId, cb), rafId);
  window.cancelAnimationFrame = (id) => rafQ.delete(id);

  let timerId = 0;
  const timers = new Map(); // id -> { due, cb, args, every }
  const add = (cb, ms, args, every) => {
    const id = ++timerId;
    timers.set(id, { due: c.t + Math.max(0, Number(ms) || 0), cb, args, every });
    return id;
  };
  window.setTimeout = (cb, ms, ...args) => add(cb, ms, args, 0);
  window.setInterval = (cb, ms, ...args) => add(cb, ms, args, Math.max(1, Number(ms) || 0));
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestIdleCallback = (cb) => add(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0, [], 0);
  window.cancelIdleCallback = (id) => timers.delete(id);

  const call = (fn, args) => {
    try {
      typeof fn === "function" ? fn(...args) : (0, eval)(String(fn));
    } catch (e) {
      reportError(e); // still surfaces as an uncaught exception
    }
  };
  function fireTimers() {
    for (let guard = 0; guard < 10000; guard++) {
      let id = null;
      let best = null;
      for (const [k, v] of timers) if (v.due <= c.t && (!best || v.due < best.due || (v.due === best.due && k < id))) (id = k), (best = v);
      if (!best) return;
      if (best.every) best.due += best.every;
      else timers.delete(id);
      call(best.cb, best.args);
    }
  }

  // Loads in flight hold the clock (bounded: 15 s of real time per stall).
  const track = (p) => {
    c.pending++;
    const done = () => c.pending--;
    p.then(done, done);
  };
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...srcDesc,
    set(v) {
      if (!this.__vcBusy) {
        this.__vcBusy = true;
        track(new Promise((r) => {
          const end = () => ((this.__vcBusy = false), r());
          this.addEventListener("load", end, { once: true });
          this.addEventListener("error", end, { once: true });
        }));
      }
      return srcDesc.set.call(this, v);
    },
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = (...a) => {
    const p = realFetch(...a);
    track(p);
    return p;
  };

  let stallStart = null;
  function pump() {
    realRaf(pump);
    if (c.held || document.visibilityState !== "visible") return;
    if (c.pending > 0) {
      stallStart ??= realNow();
      if (realNow() - stallStart < 15000) return;
    }
    if (stallStart != null) (c.stalledMs += realNow() - stallStart), (stallStart = null);
    const r0 = realNow();
    c.t += STEP;
    fireTimers();
    const q = rafQ;
    rafQ = new Map();
    for (const cb of q.values()) call(cb, [c.t]);
    c.frames++;
    c.frameRealMs += realNow() - r0;
    let met = false;
    if (c.pred) {
      try {
        met = Boolean(c.pred());
      } catch {}
    }
    if (met || c.t >= c.until - 1e-6) {
      c.held = true;
      const d = c.done;
      c.done = c.pred = null;
      d?.({ t: c.t, met });
    }
  }
  realRaf(pump);

  // Run up to ms of virtual time, or until pred() is true after a frame. Resolves { t, met } once held again.
  c.run = (ms, predSrc) =>
    new Promise((res) => {
      const pred = predSrc ? new Function("return (" + predSrc + ");") : null;
      if (pred) {
        try {
          if (pred()) return res({ t: c.t, met: true });
        } catch {}
      }
      c.until = c.t + ms;
      c.pred = pred;
      c.done = res;
      c.held = false;
    });
  // Real-time waits for the harness (the page's own setTimeout/rAF are virtual).
  c.realFrames = (n) => new Promise((r) => { let k = 0; (function f() { if (++k >= n) r(); else realRaf(f); })(); });
  c.realSleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
})();`;
}

// Harness-side controls. Long runs are cut into chunks so no single CDP call waits too long.
export function createClock(page, { chunkMs = 2000 } = {}) {
  const now = () => page.js("window.__vclock.t");
  async function runUntil(pred, maxMs) {
    const start = await now();
    const end = start + maxMs;
    for (;;) {
      const left = end - (await now());
      if (left <= 1e-6) return { t: await now(), met: false };
      const r = await page.js(`window.__vclock.run(${Math.min(chunkMs, left)}, ${pred ? JSON.stringify(pred) : "null"})`, 180000);
      if (r.met) return r;
    }
  }
  return {
    now,
    run: (ms) => runUntil(null, ms),
    runTo: async (t) => runUntil(null, Math.max(0, t - (await now()))),
    runUntil,
    stats: () => page.js("({ t: __vclock.t, frames: __vclock.frames, msPerFrame: __vclock.frameRealMs / Math.max(1, __vclock.frames), stalledMs: __vclock.stalledMs })"),
  };
}
