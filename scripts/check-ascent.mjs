// Check for src/ascent.js: every preset flies without NaN, the expected outcomes hold, Falcon 9 passes two
// sanity ranges and recovers its booster (touchdown < 2 m/s, main ascent still in orbit), stages without legs
// do not return, a light LEO Falcon 9 returns to the pad (< 10 km), the round-14 detail channels and events are
// consistent (mach/heat/x_m, tower-clear < max-q, igniters 0.4 s before ignitions, payload release at orbit
// + 20 s, booster cold-gas/heating/grid fins/drone ship), builds the verdict blocks are not flown
// ("blocked" with the first blocking warning), edge builds do not throw, and a run stays
// under 100 ms. Prints one block per preset with the booster timeline.
// Run: node scripts/check-ascent.mjs   (no deps; exits 1 on any failure)
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

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
// Outcomes the head chat asked for. Saturn V has no expectation: it is printed, whatever it says.
const EXPECT_OUTCOME = { "falcon-9": "orbit", "delta-iv-m": "orbit", "atlas-v-401": "shortfall", "demo-build": "shortfall" };
const MAX_MS = 100;

function badNumbers(res) {
  const bad = [];
  const scan = (o, path) => {
    if (typeof o === "number") {
      if (Number.isNaN(o)) bad.push(path);
      else if (!Number.isFinite(o) && path !== "summary.apogee_km") bad.push(path);
    } else if (Array.isArray(o)) o.forEach((v, i) => scan(v, `${path}[${i}]`));
    else if (o && typeof o === "object") for (const k in o) scan(o[k], `${path}.${k}`);
  };
  scan(res, "result");
  return bad;
}
function ordered(list) {
  for (let i = 1; i < list.length; i++) if (list[i].t < list[i - 1].t) return false;
  return true;
}
function timeIt(build) {
  const times = [];
  let res;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    res = simulateAscent(build, catalog);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { res, ms: times[1], cold: times[2] };
}
const n0 = (v) => (v == null ? "–" : Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "∞");
const n1 = (v) => (v == null ? "–" : v.toFixed(1));

// Detail channels (round 14): mach, transonic, heat, x_m on samples; tower-clear, transonic, throttle-down/up,
// tea-teb/igniter, payload-release events; booster cold-gas, heating window, grid fins, drone ship.
function detailChecks(id, res) {
  const S = res.samples;
  const E = res.events;
  const has = (type) => E.filter((e) => e.type === type);
  expect(S.every((x) => Number.isFinite(x.mach) && x.mach >= 0), `${id}: bad mach`);
  const edge = (m) => Math.abs(m - 0.85) < 0.002 || Math.abs(m - 1.15) < 0.002; // mach is rounded to 3 decimals
  expect(S.every((x) => typeof x.transonic === "boolean" && (edge(x.mach) || x.transonic === (x.mach > 0.85 && x.mach < 1.15))), `${id}: transonic flag disagrees with mach`);
  expect(S.some((x) => x.transonic), `${id}: never transonic`);
  expect(S.every((x) => x.heat >= 0 && x.heat <= 1) && S.some((x) => x.heat === 1), `${id}: heat not normalised to 0..1`);
  expect(S.every((x) => x.x_m === x.downrange_m), `${id}: x_m differs from downrange_m`);
  expect(S.every((x, i) => i === 0 || x.x_m >= S[i - 1].x_m - 0.5), `${id}: x_m goes backwards`);
  const tc = has("tower-clear")[0];
  const mx = has("maxq")[0];
  expect(tc && mx && tc.t < mx.t, `${id}: tower-clear (${tc?.t}) must come before max-q (${mx?.t})`);
  const m1 = has("transonic")[0];
  const firstMach1 = S.find((x) => x.mach >= 1);
  expect(m1 && firstMach1 && Math.abs(m1.t - firstMach1.t) <= 0.6, `${id}: transonic event at ${m1?.t}, first Mach 1 sample at ${firstMach1?.t}`);
  const down = has("throttle-down");
  const up = has("throttle-up");
  expect(down.length === up.length && down.every((d, i) => d.t < up[i].t), `${id}: throttle-down/up not paired in order`);
  const ign = has("ignition2");
  const pre = E.filter((e) => e.type === "tea-teb" || e.type === "igniter");
  expect(pre.length === ign.length && pre.every((p, i) => Math.abs(ign[i].t - p.t - 0.4) <= 0.11), `${id}: tea-teb/igniter must lead every upper-stage ignition by 0.4 s`);
  const orbit = has("orbit")[0];
  const rel = has("payload-release")[0];
  if (orbit) expect(rel && Math.abs(rel.t - orbit.t - 20) < 0.01 && rel.screen_s === 1, `${id}: payload-release must be orbit + 20 s with screen_s 1`);
  else expect(!rel, `${id}: payload-release without an orbit`);
  const b = res.summary.booster;
  if (b?.returns) {
    const cg = b.events.filter((e) => e.type === "cold-gas");
    const flip = b.events.find((e) => e.type === "flip");
    expect(cg.length === 2 && cg[0].phase === "start" && cg[1].phase === "end" && cg[0].t === flip.t && cg[1].t > cg[0].t, `${id}: booster cold-gas start/end`);
    expect(b.heating && b.heating.start_t < b.heating.end_t && b.heating.peak_t >= b.heating.start_t && b.heating.peak_t <= b.heating.end_t, `${id}: booster heating window ${JSON.stringify(b.heating)}`);
    expect(b.samples.every((x) => Number.isFinite(x.gridFin_deg) && Math.abs(x.gridFin_deg) <= 4 && x.heat >= 0 && x.heat <= 1 && Number.isFinite(x.mach)), `${id}: booster sample details`);
    expect(b.sea === (b.mode === "droneship") && (!b.sea || (b.droneShip?.alt_m === 0 && Math.abs(b.droneShip.x_m - b.landingDownrange_m) < 1)), `${id}: drone ship position`);
  }
}

for (const id of presetIds) {
  const { res, ms } = timeIt(presetToBuild(getPreset(id)));
  const s = res.summary;
  const bad = badNumbers(res);
  expect(bad.length === 0, `${id}: NaN/non-finite at ${bad.slice(0, 5).join(", ")}`);
  expect(ordered(res.samples) && ordered(res.events), `${id}: samples or events out of time order`);
  expect(res.samples.length > 0, `${id}: no samples`);
  if (EXPECT_OUTCOME[id]) expect(s.outcome === EXPECT_OUTCOME[id], `${id}: outcome ${s.outcome}, expected ${EXPECT_OUTCOME[id]}`);
  expect(ms < MAX_MS, `${id}: ${ms.toFixed(1)} ms per run (limit ${MAX_MS})`);
  if (id === "falcon-9") {
    const meco = res.events.find((e) => e.type === "meco");
    expect(meco && meco.t >= 130 && meco.t <= 170, `falcon-9: MECO at ${meco?.t} s, expected 130-170 s`);
    expect(s.maxG >= 3 && s.maxG <= 6, `falcon-9: max g ${s.maxG.toFixed(2)}, expected 3-6`);
  }
  detailChecks(id, res);
  const b = s.booster;
  if (id === "falcon-9") {
    expect(b?.returns === true, `falcon-9: booster not recovered (${b?.reason})`);
    expect(b?.returns && b.touchdownSpeed_ms < 2, `falcon-9: touchdown at ${b?.touchdownSpeed_ms?.toFixed(2)} m/s`);
    expect(b?.mode !== "rtls" || Math.abs(b.landingDownrange_m) <= 10e3, `falcon-9: pad return landed ${(b?.landingDownrange_m / 1000).toFixed(1)} km out`);
    expect(s.outcome === "orbit", `falcon-9: main ascent outcome ${s.outcome} with the booster reserve`);
    expect(ordered(b?.samples ?? []) && ordered(b?.events ?? []), "falcon-9: booster samples or events out of order");
  } else if (id !== "demo-build") {
    expect(b?.returns === false, `${id}: a stage without landing legs came back`);
  }
  // Default 4.5 g limit holds wherever throttling to 0.4 is enough (small tolerance for drag and the step).
  const limitHolds = res.samples.every((x) => x.acc_ms2 / 9.80665 <= 4.5 + 0.05 || x.throttle <= 0.4 + 1e-9);
  expect(limitHolds, `${id}: sensed acceleration above the 4.5 g limit while throttle was above 0.4`);
  const m = s.mission;
  console.log(
    `${id}  ${s.outcome.toUpperCase()}  (kick ${s.kick_deg}°, ${ms.toFixed(1)} ms, ${res.samples.length} samples)\n` +
      `  orbit ${n0(s.perigee_km)} × ${n0(s.apogee_km)} km · Δv flown ${n0(s.achievedDeltaV_ms)} m/s · losses gravity ${n0(s.gravityLoss_ms)}, drag ${n0(s.dragLoss_ms)} m/s\n` +
      `  max Q ${n1(s.maxQ_Pa / 1000)} kPa · max ${s.maxG.toFixed(2)} g (g-limited ${n0(s.gLimited_s)} s) · burns ${s.burnTimes_s.map((b) => `${n0(b)} s`).join(" / ")}\n` +
      `  after orbit: ${n0(s.remainingDeltaV_ms)} m/s left, mission ${m?.id ?? "–"} needs ${n0(m?.beyondLEO_ms)} beyond LEO${m?.shortBy_ms ? ` → short by ${n0(m.shortBy_ms)}` : ""}\n` +
      `  events: ${res.events.map((e) => `${e.type}${e.type === "meco" || e.type === "sep" || e.type === "ignition2" ? `(s${e.stage + 1})` : ""} T+${e.t.toFixed(1)}`).join(", ")}\n` +
      `  booster: ${
        b?.returns
          ? `${b.mode === "rtls" ? "returns to the pad" : "lands on a drone ship"}, reserve ${n0(b.propellantReserve_kg)} kg (${(b.reserveFraction * 100).toFixed(1)} %), touchdown ${b.touchdownSpeed_ms.toFixed(2)} m/s ${n1(b.landingDownrange_m / 1000)} km downrange, ${n0(b.propellantLeft_kg)} kg left` +
            `\n           ${b.events.map((e) => `${e.type} T+${e.t.toFixed(1)} (${n1(e.alt_m / 1000)} km, ${n0(e.vel_ms)} m/s)`).join(", ")}` +
            (b.note ? `\n           why not ${b.mode === "rtls" ? "a ship" : "the pad"}: ${b.note}` : "")
          : b?.reason ?? "–"
      }`,
  );
}

// Edge builds: never throw, never NaN, sensible outcomes.
const livery = { primary: "#ffffff", accent: "#111111", stripe: false, patch: null };
const build = (stages, payloadId = "", missionId = "leo") => ({
  missionId,
  payloadId,
  livery,
  stages: stages.map(([engineId, engineCount, tankId]) => ({ engineId, engineCount, tankId })),
});
const edges = [
  ["Falcon 9 with GOES-R to LEO: booster returns to the pad", { ...presetToBuild(getPreset("falcon-9")), payloadId: "goes-r", missionId: "leo" }, "orbit", (r) => r.summary.booster.returns && r.summary.booster.mode === "rtls" && Math.abs(r.summary.booster.landingDownrange_m) <= 10e3 && r.summary.booster.touchdownSpeed_ms < 2],
  // Blocked by the verdict: not flown (pad abort), reason = the first blocking warning.
  ["9 RD-191 under the F9 tank (too many engines)", { ...presetToBuild(getPreset("falcon-9")), stages: [{ engineId: "rd-191", engineCount: 9, tankId: "falcon9-s1-tank" }, presetToBuild(getPreset("falcon-9")).stages[1]] }, "blocked", (r) => r.summary.reason === "9 RD-191 engines don't fit a 3.66 m wide Falcon 9 Block 5 first-stage tank: max 1" && r.samples.length === 0 && r.events.length === 0],
  ["empty build", build([]), "blocked", (r) => r.summary.reason === "empty build"],
  ["unknown ids", build([["nope", 1, "falcon9-s1-tank"]]), "blocked", (r) => r.summary.reason === "unknown engine id: nope"],
  ["vacuum engine on stage 0", build([["merlin-1d-vac", 1, "falcon9-s1-tank"]]), "blocked", (r) => r.summary.reason === "vacuum-only engine on stage 0"],
  ["TWR below 1 (one Merlin under a full F9 tank)", build([["merlin-1d", 1, "falcon9-s1-tank"]]), "blocked", (r) => r.summary.reason === "liftoff TWR below 1.0"],
  // The same builds flown anyway (opts.ignoreVerdict): the simulator's own pad abort still applies.
  ["vacuum engine on stage 0, flown anyway (never lifts off)", build([["merlin-1d-vac", 1, "falcon9-s1-tank"]]), "impact", null, { ignoreVerdict: true }],
  ["TWR below 1, flown anyway", build([["merlin-1d", 1, "falcon9-s1-tank"]]), "impact", null, { ignoreVerdict: true }],
  ["single F9 stage trying for orbit (never reaches 100 km)", build([["merlin-1d", 9, "falcon9-s1-tank"]], "goes-r"), "impact"],
  ["Atlas booster + Centaur with Hubble: reaches space, falls back", build([["rd-180", 1, "atlas-v-ccb-tank"], ["rl10c-1", 1, "centaur-iii-tank"]], "hubble"), "shortfall"],
];
for (const [label, b, want, extra, simOpts] of edges) {
  let res;
  try {
    res = simulateAscent(b, catalog, simOpts);
  } catch (e) {
    failures.push(`${label}: threw ${e.message}`);
    continue;
  }
  const bad = badNumbers(res);
  expect(bad.length === 0, `${label}: NaN/non-finite at ${bad.slice(0, 5).join(", ")}`);
  expect(res.summary.outcome === want, `${label}: outcome ${res.summary.outcome}, expected ${want}`);
  if (extra) expect(extra(res), `${label}: ${JSON.stringify({ ...res.summary.booster, samples: undefined, events: undefined })}`);
  const last = res.events.at(-1);
  console.log(`edge  ${label}: ${res.summary.outcome}${res.summary.reason && res.summary.outcome === "blocked" ? ` (${res.summary.reason})` : ""}${res.summary.error ? ` (${res.summary.error})` : ""}${last ? `, last event ${last.type} T+${last.t}` : ""}`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: ascent runs, outcomes, Falcon 9 sanity ranges and booster recovery, edge builds and speed all check out.");
