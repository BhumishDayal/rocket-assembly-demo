// Check for src/flight.js: every preset plus one build per ending (Moon orbiter, Mars lander, Mars orbiter, LEO,
// Earth escape, a fall back, a pad hold-down, a blocked build) runs; the ending matches arrival.js; the clocks are
// monotone, real time in the windows and smooth elsewhere (frame-to-frame sim step changes by at most 12 %);
// screen totals (Earth ~35 s, Moon ~55 s, Mars ~65 s); positions are continuous at 60 fps (Earth-centred,
// against the velocities, 8 to 256 sub-steps a frame: no jump over 1 km); no NaN; events and drops carry both clocks.
// Prints one line per build.
// Run: node scripts/check-flight.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { catalog, presetIds, getPreset, presetToBuild } = await import("../src/data/catalog.js");
const { simulateAscent } = await import("../src/ascent.js");
const { flightTimeline, surfaceFrame, altitude } = await import("../src/flight.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const variant = (id, change) => ({ ...presetToBuild(getPreset(id)), ...change });
const BUILDS = [
  ...presetIds.map((id) => ({ id, build: presetToBuild(getPreset(id)) })),
  { id: "saturn-v + hubble -> moon (orbiter)", build: variant("saturn-v", { payloadId: "hubble" }), kind: "moon", end: "in-orbit" },
  { id: "saturn-v + nova-c -> mars (lander)", build: variant("saturn-v", { missionId: "mars-transfer", payloadId: "nova-c" }), kind: "mars", end: "landed" },
  { id: "saturn-v + hubble -> mars (orbiter)", build: variant("saturn-v", { missionId: "mars-transfer", payloadId: "hubble" }), kind: "mars", end: "in-orbit" },
  { id: "falcon-9 -> leo", build: variant("falcon-9", { missionId: "leo" }), kind: "earth", end: "in-orbit" },
  { id: "saturn-v -> earth escape", build: variant("saturn-v", { missionId: "earth-escape" }), kind: "earth", end: "escape" },
  { id: "delta-iv-m + jwst -> moon (falls back)", build: variant("delta-iv-m", { payloadId: "jwst" }), kind: "earth", end: "fell-back" },
];
const PRESET_END = { "falcon-9": "in-orbit", "saturn-v": "landed", "atlas-v-401": "stranded", "delta-iv-m": "landed", "demo-build": "stranded" };
const TOTAL = { earth: 35, moon: 55, mars: 65 };
const FPS = 60;
const SUB = 8;

const finite = (v) => (Array.isArray(v) ? v.every(Number.isFinite) : v === null || Number.isFinite(v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function check(id, f, want) {
  const a = f.arrival;
  // ending vs arrival.js
  const inOrbit = f.outcome === "orbit" || (f.outcome === "shortfall" && a.legs.length > 0);
  const expected = !inOrbit ? (f.outcome === "shortfall" ? "fell-back" : "impact") : !a.success ? "stranded" : a.lands ? "landed" : a.mission === "earth-escape" ? "escape" : "in-orbit";
  expect(f.endState.type === expected, `${id}: end ${f.endState.type}, arrival.js says ${expected}`);
  if (want.end) expect(f.endState.type === want.end, `${id}: end ${f.endState.type}, expected ${want.end}`);
  expect(f.kind === (a.success ? a.body : "earth"), `${id}: kind ${f.kind}, arrival body ${a.body} (success ${a.success})`);
  if (want.kind) expect(f.kind === want.kind, `${id}: kind ${f.kind}, expected ${want.kind}`);
  expect(typeof f.endState.text === "string" && f.endState.text.length > 0, `${id}: no end text`);

  // screen totals
  const target = f.segments.length === 1 ? null : f.endState.type === "landed" ? TOTAL[f.kind] : f.kind === "earth" ? TOTAL.earth : null;
  if (target) expect(Math.abs(f.totalScreen_s - target) <= 1, `${id}: total ${f.totalScreen_s} s, target ~${target}`);
  expect(f.totalScreen_s > 0 && f.totalScreen_s <= 70, `${id}: total ${f.totalScreen_s} s`);

  // clocks: monotone, inverse, rate <= 1
  let prevS = -1;
  for (let i = 0; i <= 4000; i++) {
    const t = (f.totalSim_s * i) / 4000;
    const sc = f.simToScreen(t);
    expect(sc >= prevS - 1e-9, `${id}: simToScreen not monotone at t ${t}`);
    prevS = sc;
    const back = f.screenToSim(sc);
    expect(Math.abs(back - t) <= 1e-6 * Math.max(1, t) + 1e-6, `${id}: screenToSim(simToScreen(${t.toFixed(2)})) = ${back}`);
  }

  // segments contiguous on both clocks
  f.segments.forEach((s, i) => {
    expect(s.t1_sim > s.t0_sim && s.t1_screen > s.t0_screen, `${id}: segment ${s.name} empty`);
    if (i > 0) expect(Math.abs(s.t0_sim - f.segments[i - 1].t1_sim) < 1e-3, `${id}: gap before ${s.name}`);
  });

  // events and drops
  let prevE = -Infinity;
  for (const e of f.events) {
    expect(Number.isFinite(e.t_sim) && Number.isFinite(e.t_screen), `${id}: event ${e.type} without both clocks`);
    expect(e.t_screen >= prevE - 1e-3, `${id}: event ${e.type} out of order`);
    expect(e.t_screen >= -1e-6 && e.t_screen <= f.totalScreen_s + 1e-3, `${id}: event ${e.type} at ${e.t_screen} outside 0–${f.totalScreen_s}`);
    prevE = e.t_screen;
  }
  expect(f.events.at(-1)?.type === "end" || f.events.some((e) => e.type === "end"), `${id}: no end event`);
  const seps = f.events.filter((e) => e.type === "sep").length;
  expect(f.stageDrops.filter((d) => d.type === "sep").length === seps, `${id}: ${seps} separations but ${f.stageDrops.filter((d) => d.type === "sep").length} drops`);
  for (const d of f.stageDrops) {
    const v = d.dropAway;
    expect(Math.abs(Math.hypot(...v.dir_body) - 1) < 1e-2 && Math.abs(Math.hypot(...v.dir_eci) - 1) < 1e-2, `${id}: drop ${d.type} direction not unit`);
    expect(v.duration_s === 2 && v.speed_ms > 0, `${id}: drop ${d.type} ${v.duration_s} s at ${v.speed_ms} m/s`);
    expect(Number.isFinite(d.t_screen) && d.t_screen <= f.totalScreen_s + 1e-3, `${id}: drop ${d.type} at ${d.t_screen}`);
    expect(v.dir_body[1] < 0 || d.type === "fairing", `${id}: drop ${d.type} does not fall back along the axis`);
  }
  if (f.kind !== "earth" || f.endState.type === "escape") expect(f.stageDrops.some((d) => d.type === "spacecraft-sep"), `${id}: no spacecraft-sep drop`);
  if (f.kind === "earth" && f.endState.type !== "escape" && inOrbit) expect(f.stageDrops.some((d) => d.type === "payload-release"), `${id}: no payload-release drop`);

  // frame walk at 60 fps
  const n = Math.floor(f.totalScreen_s * FPS);
  let prev = null;
  let prevDt = null;
  let worst = 0;
  let worstAt = "";
  let maxRatio = 1;
  let ratioAt = "";
  let bodies = [];
  let us = 0;
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    const s = f.sampleAt(i / FPS);
    us += (performance.now() - t0) * 1000;
    for (const [k, v] of Object.entries(s)) if (typeof v === "number" || Array.isArray(v)) if (!finite(v)) expect(false, `${id}: ${k} = ${v} at ${s.t_screen}`);
    expect(Math.abs(Math.hypot(...s.axis) - 1) < 1e-2, `${id}: axis not unit at ${s.t_screen}`);
    expect(s.alt_km > -0.05, `${id}: below the surface (${s.alt_km} km) at ${s.t_screen}`);
    expect(s.throttle >= 0 && s.throttle <= 1 && s.chute >= 0 && s.chute <= 1 && s.heat >= 0 && s.heat <= 1 && s.dust >= 0 && s.dust <= 1, `${id}: a 0..1 field out of range at ${s.t_screen}`);
    if (bodies.at(-1) !== s.body) bodies.push(s.body);
    if (prev) {
      // composite trapezoid over sub-steps: Earth-centred displacement vs the velocities. A coast frame can span
      // hours of sim time, where the trapezoid's own error passes 1 km; refine (up to 256 sub-steps) before
      // calling it a jump: a real jump does not shrink with refinement.
      const moved = s.pos_eci_km.map((x, j) => x - prev.pos_eci_km[j]);
      let r = Infinity;
      for (let sub = SUB; sub <= 256 && r > 1; sub *= 4) {
        let pred = [0, 0, 0];
        let last = prev;
        for (let k = 1; k <= sub; k++) {
          const q = k === sub ? s : f.sampleAt((i - 1 + k / sub) / FPS);
          const dt = q.t_sim - last.t_sim;
          pred = pred.map((x, j) => x + ((last.vel_eci_kms[j] + q.vel_eci_kms[j]) / 2) * dt);
          last = q;
        }
        r = dist(moved, pred);
      }
      if (r > worst) {
        worst = r;
        worstAt = `${s.t_screen.toFixed(2)} s (${s.segment})`;
      }
      const dt = s.t_sim - prev.t_sim;
      expect(dt >= 1 / FPS - 1e-6, `${id}: slower than real time at ${s.t_screen} (sim step ${dt})`);
      if (prevDt) {
        const ratio = Math.max(dt / prevDt, prevDt / dt);
        if (ratio > maxRatio) {
          maxRatio = ratio;
          ratioAt = `${s.t_screen.toFixed(2)} s (${s.segment})`;
        }
      }
      prevDt = dt;
    }
    prev = s;
  }
  expect(worst <= 1, `${id}: position jumps ${worst.toFixed(3)} km between frames at ${worstAt}`);
  expect(maxRatio <= 1.12, `${id}: time rate changes ${((maxRatio - 1) * 100).toFixed(1)} % in one frame at ${ratioAt}`);
  const order = { earth: ["earth"], moon: ["earth", "space", "moon"], mars: ["earth", "space", "mars"] }[f.kind];
  if (f.endState.type === "escape") expect(bodies.join() === "earth,space", `${id}: bodies ${bodies.join()}`);
  else expect(bodies.join() === order.join(), `${id}: bodies ${bodies.join()}, expected ${order.join()}`);

  // real time around the key moments (sim advances 1/60 s per frame)
  for (const type of ["liftoff", "maxq", "meco", "seco", "departure-burn", "lunar-orbit-insertion", "chute-open"]) {
    const e = f.events.find((x) => x.type === type);
    if (!e) continue;
    const a1 = f.sampleAt(e.t_screen);
    const a2 = f.sampleAt(e.t_screen + 1 / FPS);
    expect(Math.abs(a2.t_sim - a1.t_sim - 1 / FPS) < 1e-3, `${id}: ${type} not in real time (${(a2.t_sim - a1.t_sim).toFixed(4)} s per frame)`);
  }
  const touch = f.events.find((e) => e.type === "touchdown");
  if (touch) {
    const s = f.sampleAt(f.totalScreen_s);
    expect(s.alt_km < 0.001 && s.speed_ms < 1.5, `${id}: touchdown at ${s.alt_km} km, ${s.speed_ms} m/s`);
    expect(Math.abs(touch.t_screen - f.totalScreen_s) < 1e-3, `${id}: touchdown at ${touch.t_screen}, total ${f.totalScreen_s}`);
  }
  // helpers
  const s0 = f.sampleAt(0);
  const fr = surfaceFrame("earth", s0.pos_km);
  expect(Math.abs(fr.up[0] * fr.east[0] + fr.up[1] * fr.east[1] + fr.up[2] * fr.east[2]) < 1e-9, `${id}: surfaceFrame not orthogonal`);
  expect(Math.abs(altitude("earth", s0.pos_km)) < 1e-3, `${id}: pad altitude ${altitude("earth", s0.pos_km)}`);
  expect(Math.abs(s0.yaw_deg - 90) < 1 && s0.pitch_deg < 1, `${id}: on the pad pitch ${s0.pitch_deg} yaw ${s0.yaw_deg} (want up, heading east)`);

  const segs = f.segments.map((s) => `${s.name} ${(s.t1_screen - s.t0_screen).toFixed(1)}`).join(", ");
  console.log(`${worst <= 1 && maxRatio <= 1.12 ? "ok  " : "FAIL"}  ${id}: ${f.endState.type} (${f.kind}), ${f.totalScreen_s.toFixed(1)} s screen / ${(f.totalSim_s / 3600).toFixed(1)} h sim; ${segs}`);
  console.log(`      max jump ${(worst * 1000).toFixed(0)} m at ${worstAt}; max rate change ${((maxRatio - 1) * 100).toFixed(1)} %/frame; sampleAt ${(us / (n + 1)).toFixed(0)} µs; "${f.endState.text}"`);
}

for (const b of BUILDS) {
  const t0 = performance.now();
  const f = flightTimeline(b.build, catalog);
  const ms = performance.now() - t0;
  expect(!f.blocked, `${b.id}: blocked (${f.reason})`);
  if (f.blocked) continue;
  expect(ms < 2000, `${b.id}: flightTimeline took ${ms.toFixed(0)} ms`);
  check(b.id, f, { kind: b.kind, end: b.end ?? PRESET_END[b.id] });
}

// a blocked build: only the pad-abort result
{
  const build = variant("falcon-9", {});
  build.stages = build.stages.map((s, i) => (i === 0 ? { ...s, engineId: "merlin-1d-vac" } : s));
  const f = flightTimeline(build, catalog);
  expect(f.blocked === true && f.endState.type === "pad-abort" && /^Pad abort · /.test(f.endState.text), `blocked build: ${JSON.stringify(f).slice(0, 200)}`);
  console.log(`ok    blocked build: "${f.endState.text}"`);
}
// held down on the pad (flown anyway): a 3 s ascent piece, impact
{
  const build = variant("falcon-9", {});
  build.stages = build.stages.map((s, i) => (i === 0 ? { ...s, engineCount: 1 } : s));
  const ascent = simulateAscent(build, catalog, { ignoreVerdict: true });
  const f = flightTimeline(build, catalog, { ascent });
  expect(!f.blocked && f.endState.type === "impact" && f.segments.length === 1, `hold-down: ${f.endState?.type}, ${f.segments?.length} segments`);
  const s = f.sampleAt(f.totalScreen_s);
  expect(finite(s.pos_eci_km) && s.alt_km < 0.01, `hold-down: ends at ${s.alt_km} km`);
  console.log(`ok    held down (flown anyway): ${f.endState.type}, ${f.totalScreen_s} s; "${f.endState.text}"`);
}
// opts.totalScreen_s scales the shares
{
  const f = flightTimeline(presetToBuild(getPreset("falcon-9")), catalog, { totalScreen_s: 50 });
  expect(Math.abs(f.totalScreen_s - 50) < 1, `totalScreen_s 50 gives ${f.totalScreen_s}`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const m of [...new Set(failures)].slice(0, 60)) console.error("  " + m);
  process.exit(1);
}
console.log("\nOK: every flight runs, ends as arrival.js says, keeps its clocks monotone and smooth, and never jumps.");
