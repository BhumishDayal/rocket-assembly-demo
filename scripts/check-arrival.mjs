// Check for src/arrival.js against the ascent of every preset: bodies, success, landing, stranded lines, and the
// 8 s screen-time budget. Prints each preset's ending.
// Run: node scripts/check-arrival.mjs   (no deps; exits 1 on any failure)
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
const { arrivalTimeline, descentTimeline } = await import("../src/arrival.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
// What each preset should come to, from the ascent results (check-ascent.mjs) and the rules.
const EXPECT = {
  "falcon-9": { body: "earth", success: true, lands: false, last: "orbit" },
  "saturn-v": { body: "moon", success: true, lands: true, last: "touchdown" },
  "atlas-v-401": { body: "earth", success: false, lands: false, last: "stranded" },
  "delta-iv-m": { body: "moon", success: true, lands: true, last: "touchdown" },
  "demo-build": { body: "moon", success: false, lands: false, last: "stranded" },
};
const TYPES = new Set(["orbit", "transfer", "descent", "touchdown", "stranded"]);

function sane(id, a) {
  const total = a.legs.reduce((s, l) => s + l.seconds, 0);
  expect(total <= 8 + 1e-9, `${id}: legs take ${total} s (max 8)`);
  expect(a.legs.length === 0 || total > 7.5, `${id}: legs take only ${total} s`);
  for (const l of a.legs) {
    expect(TYPES.has(l.type), `${id}: unknown leg type ${l.type}`);
    expect(Number.isFinite(l.seconds) && l.seconds > 0, `${id}: leg ${l.type} has ${l.seconds} s`);
    expect(l.alt_km === null || Number.isFinite(l.alt_km), `${id}: leg ${l.type} alt ${l.alt_km}`);
    expect(typeof l.note === "string" && l.note.length > 0, `${id}: leg ${l.type} without a note`);
  }
  expect(a.lines.length > 0, `${id}: no lines`);
  expect(a.est === true, `${id}: not labelled est.`);
}

for (const id of presetIds) {
  const build = presetToBuild(getPreset(id));
  const asc = simulateAscent(build, catalog);
  const a = arrivalTimeline(build, catalog, asc.summary);
  sane(id, a);
  const w = EXPECT[id];
  const ok = a.body === w.body && a.success === w.success && a.lands === w.lands && a.legs.at(-1)?.type === w.last;
  expect(ok, `${id}: got body ${a.body}, success ${a.success}, lands ${a.lands}, last leg ${a.legs.at(-1)?.type}; want ${JSON.stringify(w)}`);
  if (!a.success) expect(a.lines.some((l) => /^Short by [\d,]+ m\/s/.test(l)), `${id}: no "Short by N m/s" line`);
  console.log(`${ok ? "ok  " : "FAIL"}  ${id}: ${a.body}, ${a.success ? "success" : "short"}${a.lands ? ", lands" : ""}`);
  for (const l of a.lines) console.log(`        ${l}`);
  console.log(`        legs: ${a.legs.map((l) => `${l.type}${l.body !== "earth" ? `@${l.body}` : ""} ${l.seconds}s`).join(" → ")}`);
}

// Edges: a payload that never reaches orbit, a lander that only goes to LEO, Mars, and a missing summary.
const sum = (over) => ({ outcome: "orbit", remainingDeltaV_ms: 5000, perigee_km: 200, apogee_km: 201, ...over });
const b = (missionId, payloadId) => ({ ...presetToBuild(getPreset("falcon-9")), missionId, payloadId });
const edges = [
  ["suborbital", b("gto", "goes-r"), sum({ outcome: "shortfall", remainingDeltaV_ms: null, perigee_km: -3000 }), (a) => !a.success && a.legs.length === 0],
  ["lander to LEO (stays in orbit)", b("leo", "nova-c"), sum({}), (a) => a.success && !a.lands && a.body === "earth" && a.legs.length === 1],
  ["lander to Mars", b("mars-transfer", "nova-c"), sum({ remainingDeltaV_ms: 4000 }), (a) => a.success && a.lands && a.body === "mars"],
  ["telescope to Mars", b("mars-transfer", "hubble"), sum({ remainingDeltaV_ms: 4000 }), (a) => a.success && !a.lands && a.legs.at(-1).type === "orbit"],
  ["no summary", b("gto", "goes-r"), undefined, (a) => !a.success && a.legs.length === 0],
  ["blocked build (pad abort)", b("gto", "goes-r"), { outcome: "blocked", reason: "vacuum-only engine on stage 0", remainingDeltaV_ms: null }, (a) => !a.success && a.legs.length === 0 && a.lines[0] === "Pad abort · vacuum-only engine on stage 0"],
  ["earth escape ends on the departure", b("earth-escape", "jwst"), sum({ remainingDeltaV_ms: 3300 }), (a) => a.success && a.legs.at(-1).type === "transfer"],
];
for (const [label, build, s, pred] of edges) {
  let a;
  try {
    a = arrivalTimeline(build, catalog, s);
  } catch (e) {
    failures.push(`${label}: threw ${e.message}`);
    continue;
  }
  sane(label, a);
  expect(pred(a), `${label}: ${JSON.stringify({ body: a.body, success: a.success, lands: a.lands, legs: a.legs.map((l) => l.type) })}`);
  console.log(`edge  ${label}: ${a.lines.join(" ")}`);
}

// Lander descent profile (animation only): 3 km -> 0 in 8 s of screen time, monotone, dust only near the ground.
{
  const d = descentTimeline(catalog.payloads.find((p) => p.id === "nova-c"));
  const S = d.samples;
  const ok =
    d.est === true &&
    S[0].alt_m === 3000 &&
    S.at(-1).alt_m === 0 &&
    S.at(-1).t_screen === 8 &&
    S.every((x, i) => i === 0 || (x.alt_m <= S[i - 1].alt_m && x.vel_ms <= S[i - 1].vel_ms && x.t_screen > S[i - 1].t_screen)) &&
    S.every((x) => [x.t_screen, x.t_s, x.alt_m, x.vel_ms, x.throttle, x.dust].every(Number.isFinite) && x.dust >= 0 && x.dust <= 1) &&
    S.every((x) => x.alt_m >= 30 ? x.dust === 0 : true) &&
    S.some((x) => x.dust > 0.5);
  expect(ok, `descentTimeline: ${JSON.stringify(S.filter((_, i) => i % 20 === 0))}`);
  console.log(`descent  nova-c: ${S.length} samples, ${S[0].alt_m} m -> 0 in ${d.screen_s} s screen (${S.at(-1).t_s} s sim); dust from ${S.find((x) => x.dust > 0)?.t_screen} s`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: every preset's ending follows the rules and fits in 8 s.");
