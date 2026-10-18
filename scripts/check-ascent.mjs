// Check for src/ascent.js: every preset flies without NaN, the expected outcomes hold, Falcon 9 passes two
// sanity ranges, edge builds do not throw, and a run stays under 50 ms. Prints one block per preset.
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
const MAX_MS = 50;

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
  // Default 4.5 g limit holds wherever throttling to 0.4 is enough (small tolerance for drag and the step).
  const limitHolds = res.samples.every((x) => x.acc_ms2 / 9.80665 <= 4.5 + 0.05 || x.throttle <= 0.4 + 1e-9);
  expect(limitHolds, `${id}: sensed acceleration above the 4.5 g limit while throttle was above 0.4`);
  const m = s.mission;
  console.log(
    `${id}  ${s.outcome.toUpperCase()}  (kick ${s.kick_deg}°, ${ms.toFixed(1)} ms, ${res.samples.length} samples)\n` +
      `  orbit ${n0(s.perigee_km)} × ${n0(s.apogee_km)} km · Δv flown ${n0(s.achievedDeltaV_ms)} m/s · losses gravity ${n0(s.gravityLoss_ms)}, drag ${n0(s.dragLoss_ms)} m/s\n` +
      `  max Q ${n1(s.maxQ_Pa / 1000)} kPa · max ${s.maxG.toFixed(2)} g (g-limited ${n0(s.gLimited_s)} s) · burns ${s.burnTimes_s.map((b) => `${n0(b)} s`).join(" / ")}\n` +
      `  after orbit: ${n0(s.remainingDeltaV_ms)} m/s left, mission ${m?.id ?? "–"} needs ${n0(m?.beyondLEO_ms)} beyond LEO${m?.shortBy_ms ? ` → short by ${n0(m.shortBy_ms)}` : ""}\n` +
      `  events: ${res.events.map((e) => `${e.type}${e.type === "meco" || e.type === "sep" || e.type === "ignition2" ? `(s${e.stage + 1})` : ""} T+${e.t.toFixed(1)}`).join(", ")}`,
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
  ["empty build", build([]), "impact"],
  ["unknown ids", build([["nope", 1, "falcon9-s1-tank"]]), "impact"],
  ["vacuum engine on stage 0 (never lifts off)", build([["merlin-1d-vac", 1, "falcon9-s1-tank"]]), "impact"],
  ["TWR below 1 (one Merlin under a full F9 tank)", build([["merlin-1d", 1, "falcon9-s1-tank"]]), "impact"],
  ["single F9 stage trying for orbit (never reaches 100 km)", build([["merlin-1d", 9, "falcon9-s1-tank"]], "goes-r"), "impact"],
  ["Atlas booster + Centaur with Hubble: reaches space, falls back", build([["rd-180", 1, "atlas-v-ccb-tank"], ["rl10c-1", 1, "centaur-iii-tank"]], "hubble"), "shortfall"],
];
for (const [label, b, want] of edges) {
  let res;
  try {
    res = simulateAscent(b, catalog);
  } catch (e) {
    failures.push(`${label}: threw ${e.message}`);
    continue;
  }
  const bad = badNumbers(res);
  expect(bad.length === 0, `${label}: NaN/non-finite at ${bad.slice(0, 5).join(", ")}`);
  expect(res.summary.outcome === want, `${label}: outcome ${res.summary.outcome}, expected ${want}`);
  const last = res.events.at(-1);
  console.log(`edge  ${label}: ${res.summary.outcome}${res.summary.error ? ` (${res.summary.error})` : ""}${last ? `, last event ${last.type} T+${last.t}` : ""}`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: ascent runs, outcomes, Falcon 9 sanity ranges, edge builds and speed all check out.");
