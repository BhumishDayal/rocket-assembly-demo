// Check for src/flight.js: every preset plus one build per ending (Moon orbiter, Mars lander, Mars orbiter, LEO and
// GTO flights that bring the rocket home to the pad or a drone ship (round 20), Earth escape, a fall back, a single stage that never makes orbit, a lunar-orbit build short of insertion, a Mars
// build short of Mars, a pad hold-down, a blocked build) runs; the ending matches arrival.js and the build's
// consequence (lost: impact on the ground or sea; transfer-failed: the burn runs dry and the orbit falls back below
// the destination, demo-build's apogee under the Moon's 384,400 km, Atlas V 401's under GEO); the clocks are
// monotone, real time in the windows and smooth elsewhere (frame-to-frame sim step changes by at most 12 %);
// screen totals (Earth ~35 s, Moon ~55 s, Mars ~65 s); positions are continuous at 60 fps (Earth-centred,
// against the velocities, 8 to 256 sub-steps a frame: no jump over 1 km); no NaN; events and drops carry both clocks.
// Prints one line per build.
// Run: node scripts/check-flight.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";
import { cpus, loadavg } from "node:os";

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
  { id: "saturn-v + hubble -> moon (orbiter)", build: variant("saturn-v", { payloadId: "hubble" }), kind: "moon", end: "in-orbit-of" },
  { id: "saturn-v + nova-c -> mars (lander)", build: variant("saturn-v", { missionId: "mars-transfer", payloadId: "nova-c" }), kind: "mars", end: "landed" },
  { id: "saturn-v + hubble -> mars (orbiter)", build: variant("saturn-v", { missionId: "mars-transfer", payloadId: "hubble" }), kind: "mars", end: "in-orbit-of" },
  { id: "falcon-9 -> leo", build: variant("falcon-9", { missionId: "leo" }), kind: "earth", end: "landed" },
  { id: "atlas-v-401 -> leo", build: variant("atlas-v-401", { missionId: "leo" }), kind: "earth", end: "landed" },
  { id: "saturn-v -> leo", build: variant("saturn-v", { missionId: "leo" }), kind: "earth", end: "landed" },
  { id: "delta-iv-m -> gto", build: variant("delta-iv-m", { missionId: "gto" }), kind: "earth", end: "landed" },
  { id: "saturn-v -> earth escape", build: variant("saturn-v", { missionId: "earth-escape" }), kind: "earth", end: "landed" },
  { id: "delta-iv-m + jwst -> moon (falls back)", build: variant("delta-iv-m", { payloadId: "jwst" }), kind: "moon", end: "lost" },
  { id: "falcon-9 first stage alone -> leo", build: { ...variant("falcon-9", { missionId: "leo" }), stages: presetToBuild(getPreset("falcon-9")).stages.slice(0, 1) }, kind: "earth", end: "lost" },
  { id: "saturn-v -> lunar orbit (short of insertion)", build: variant("saturn-v", { missionId: "lunar-orbit" }), kind: "moon", end: "transfer-failed" },
  { id: "saturn-v -> mars (short, adrift)", build: variant("saturn-v", { missionId: "mars-transfer" }), kind: "mars", end: "transfer-failed" },
];
const PRESET_END = { "falcon-9": "landed", "saturn-v": "landed", "atlas-v-401": "transfer-failed", "delta-iv-m": "landed", "demo-build": "transfer-failed" };
// GEO radius from the Earth fact sheet (sidereal day 23.9345 h), as flight.js derives it
const GEO_R = Math.cbrt(398600.4418 * ((23.9345 * 3600) / (2 * Math.PI)) ** 2);
const TOTAL = { earth: 35, moon: 55, mars: 65 };
const FPS = 60;
const SUB = 8;

const finite = (v) => (Array.isArray(v) ? v.every(Number.isFinite) : v === null || Number.isFinite(v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function check(id, f, want) {
  const a = f.arrival;
  // ending vs arrival.js
  const inOrbit = f.outcome === "orbit" || (f.outcome === "shortfall" && a.legs.length > 0);
  const lifted = f.events.some((e) => e.type === "liftoff");
  // round 20: every successful flight lands; Earth missions bring the rocket home (an escaping spacecraft leaves on
  // its own burn from the parking orbit)
  const expected = !inOrbit ? (lifted ? "lost" : "aborted") : !a.success ? "transfer-failed" : a.lands ? "landed" : a.body !== "earth" ? "in-orbit-of" : "landed";
  const viaParking = a.mission === "leo" || (a.success && a.mission === "earth-escape"); // home without a departure burn
  const home = expected === "landed" && a.body === "earth";
  const type = f.endState.type;
  expect(type === expected, `${id}: end ${type}, arrival.js says ${expected}`);
  if (want.end) expect(type === want.end, `${id}: end ${type}, expected ${want.end}`);
  expect(f.kind === a.body, `${id}: kind ${f.kind}, arrival body ${a.body}`);
  if (want.kind) expect(f.kind === want.kind, `${id}: kind ${f.kind}, expected ${want.kind}`);
  expect(typeof f.endState.line === "string" && f.endState.line.length > 0, `${id}: no end line`);
  if (type === "landed" || type === "in-orbit-of") expect(f.endState.body === f.kind, `${id}: end body ${f.endState.body}`);

  // the consequence of the build
  const has = (t) => f.events.some((e) => e.type === t);
  const last = f.sampleAt(f.totalScreen_s);
  if (type === "lost") {
    const hit = f.events.find((e) => e.type === "impact");
    expect(hit && (hit.surface === "sea" || hit.surface === "ground") && Number.isFinite(hit.downrange_km), `${id}: lost without an impact event (${JSON.stringify(hit)})`);
    expect(last.alt_km < 0.5, `${id}: lost but ends at ${last.alt_km} km`);
    expect(!f.segments.some((s) => s.name !== "ascent"), `${id}: lost but flies ${f.segments.map((s) => s.name).join(", ")}`);
    expect(f.endState.impact?.surface === hit?.surface, `${id}: endState.impact ${JSON.stringify(f.endState.impact)}`);
  }
  if (inOrbit && !viaParking) {
    const burn = f.segments.find((s) => s.name === "departure-burn");
    expect(burn, `${id}: no departure-burn segment`);
    if (burn) {
      const mid = f.sampleAt((burn.t0_screen + burn.t1_screen) / 2);
      const b0 = f.sampleAt(burn.t0_screen + 0.05);
      const b1 = f.sampleAt(burn.t1_screen - 0.05);
      expect(mid.throttle === 1 && mid.burn === "departure", `${id}: departure burn throttle ${mid.throttle} burn ${mid.burn}`);
      expect(b1.mass_kg < b0.mass_kg && b1.speed_ms > b0.speed_ms, `${id}: departure burn does not burn (mass ${b0.mass_kg} -> ${b1.mass_kg}, speed ${b0.speed_ms} -> ${b1.speed_ms})`);
    }
    expect(has("departure-burn") && (has("departure-cutoff") || has("propellant-depleted")), `${id}: departure events missing`);
  }
  if (type === "transfer-failed") {
    expect(f.endState.shortBy_ms > 0 && f.endState.body === f.kind, `${id}: transfer-failed ${JSON.stringify(f.endState)}`);
    const flyby = has("moon-flyby");
    expect(flyby ? has("departure-cutoff") : has("propellant-depleted"), `${id}: ${flyby ? "flyby without departure-cutoff" : "no propellant-depleted event"}`);
    if (f.endState.apogee_km != null && !flyby) {
      // once around: out to apogee and back near the perigee
      expect(has("apogee"), `${id}: no apogee event`);
      expect(Math.abs(last.alt_km - f.endState.perigee_km) < 150, `${id}: ends at ${last.alt_km} km, perigee ${f.endState.perigee_km} km`);
      const top = Math.max(...Array.from({ length: 400 }, (_, i) => f.sampleAt((f.totalScreen_s * i) / 399).alt_km));
      expect(Math.abs(top - f.endState.apogee_km) < 0.01 * f.endState.apogee_km + 50, `${id}: highest ${top.toFixed(0)} km, apogee ${f.endState.apogee_km} km`);
    }
  }
  if (id === "demo-build") expect(type === "transfer-failed" && f.endState.apogee_km != null && f.endState.apogee_km + 6371 < 384400, `demo-build: apogee ${f.endState.apogee_km} km, should fall short of the Moon`);
  if (id === "atlas-v-401") expect(type === "transfer-failed" && f.endState.apogee_km + 6371 < GEO_R, `atlas-v-401: apogee ${f.endState.apogee_km} km, should fall short of GEO`);
  if (id === "falcon-9") expect(type === "landed" && /Apogee/.test(f.endState.missionLine) && f.events.find((e) => e.type === "apogee")?.apogee_km + 6371 > GEO_R, `falcon-9: GTO ${f.endState.missionLine}`);
  if (home) {
    // the rocket comes home: de-orbit, entry interface, landing burn, touchdown on the pad (LEO) or a drone ship
    const L = f.endState.landing;
    expect(f.endState.line === "Landed back on Earth · est." && typeof f.endState.missionLine === "string", `${id}: home lines ${JSON.stringify(f.endState).slice(0, 160)}`);
    for (const k of ["deorbit-burn", "entry-interface", "landing-burn", "touchdown"]) expect(has(k), `${id}: no ${k} event`);
    expect(L && L.touchdown_ms < 2 && last.alt_km < 0.01, `${id}: touchdown ${L?.touchdown_ms} m/s at ${last.alt_km} km`);
    expect(L?.site === (viaParking ? "pad" : "drone-ship"), `${id}: landed on ${L?.site}`);
    if (a.mission === "earth-escape") expect(has("spacecraft-departure"), `${id}: no spacecraft-departure event`);
    if (L?.site === "pad") expect(L.downrange_km < 10, `${id}: ${L.downrange_km} km from the pad`);
    expect(Array.isArray(L?.modelled) && typeof L?.legs === "boolean", `${id}: landing record ${JSON.stringify(L)}`);
    const peak = Math.max(...Array.from({ length: 300 }, (_, i) => f.sampleAt(f.segments.find((g) => g.name === "reentry").t0_screen + (i / 299) * (f.totalScreen_s - f.segments.find((g) => g.name === "reentry").t0_screen)).heat));
    expect(peak > 0.5, `${id}: re-entry heat peaks at ${peak}`);
  }

  // screen totals
  const target = f.segments.length === 1 ? null : home ? (viaParking ? 48 : 53) : type === "landed" ? TOTAL[f.kind] : type === "orbit" ? TOTAL.earth : null;
  if (target) expect(Math.abs(f.totalScreen_s - target) <= (home ? 2.5 : 1), `${id}: total ${f.totalScreen_s} s, target ~${target}`);
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
    if (d.part === "payload") expect(v.dir_body[1] > 0, `${id}: payload ${d.type} does not leave forward`);
    else expect(v.dir_body[1] < 0 || d.part === "fairing", `${id}: drop ${d.type} does not fall back along the axis`);
  }
  if (inOrbit && !viaParking) expect(f.stageDrops.some((d) => d.type === "spacecraft-sep"), `${id}: no spacecraft-sep drop`);
  if (inOrbit && viaParking) expect(f.stageDrops.some((d) => d.type === "payload-release"), `${id}: no payload-release drop`);

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
  const order = home ? (viaParking ? ["earth"] : ["earth", "space", "earth"]) : type === "landed" || type === "in-orbit-of" ? ["earth", "space", f.kind] : inOrbit && !viaParking ? ["earth", "space"] : ["earth"];
  expect(bodies.join() === order.join(), `${id}: bodies ${bodies.join()}, expected ${order.join()}`);

  // real time around the key moments (sim advances 1/60 s per frame)
  for (const k of ["liftoff", "maxq", "meco", "seco", "departure-burn", "departure-cutoff", "propellant-depleted", "lunar-orbit-insertion", "chute-open", "deorbit-burn", "entry-burn", "landing-burn"]) {
    const e = f.events.find((x) => x.type === k);
    if (!e) continue;
    const a1 = f.sampleAt(e.t_screen);
    const a2 = f.sampleAt(e.t_screen + 1 / FPS);
    expect(Math.abs(a2.t_sim - a1.t_sim - 1 / FPS) < 1e-3, `${id}: ${k} not in real time (${(a2.t_sim - a1.t_sim).toFixed(4)} s per frame)`);
  }
  const touch = f.events.find((e) => e.type === "touchdown");
  if (touch && !home) {
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
  console.log(`      max jump ${(worst * 1000).toFixed(0)} m at ${worstAt}; max rate change ${((maxRatio - 1) * 100).toFixed(1)} %/frame; sampleAt ${(us / (n + 1)).toFixed(0)} µs; "${f.endState.line}"`);
}

for (const b of BUILDS) {
  const t0 = performance.now();
  const f = flightTimeline(b.build, catalog);
  const ms = performance.now() - t0;
  expect(!f.blocked, `${b.id}: blocked (${f.reason})`);
  if (f.blocked) continue;
  // timing only means something on a quiet machine (other chats run browsers and builds here)
  if (loadavg()[0] < 2 * cpus().length) expect(ms < 2000, `${b.id}: flightTimeline took ${ms.toFixed(0)} ms`);
  check(b.id, f, { kind: b.kind, end: b.end ?? PRESET_END[b.id] });
}

// a blocked build: only the pad-abort result
{
  const build = variant("falcon-9", {});
  build.stages = build.stages.map((s, i) => (i === 0 ? { ...s, engineId: "merlin-1d-vac" } : s));
  const f = flightTimeline(build, catalog);
  expect(f.blocked === true && f.endState.type === "aborted" && /^Pad abort · /.test(f.endState.line), `blocked build: ${JSON.stringify(f).slice(0, 200)}`);
  console.log(`ok    blocked build: ${f.endState.type}, "${f.endState.line}"`);
}
// held down on the pad (flown anyway): a 3 s ascent piece, impact
{
  const build = variant("falcon-9", {});
  build.stages = build.stages.map((s, i) => (i === 0 ? { ...s, engineCount: 1 } : s));
  const ascent = simulateAscent(build, catalog, { ignoreVerdict: true });
  const f = flightTimeline(build, catalog, { ascent });
  expect(!f.blocked && f.endState.type === "aborted" && f.segments.length === 1, `hold-down: ${f.endState?.type}, ${f.segments?.length} segments`);
  const s = f.sampleAt(f.totalScreen_s);
  expect(finite(s.pos_eci_km) && s.alt_km < 0.01, `hold-down: ends at ${s.alt_km} km`);
  console.log(`ok    held down (flown anyway): ${f.endState.type}, ${f.totalScreen_s} s; "${f.endState.line}"`);
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
