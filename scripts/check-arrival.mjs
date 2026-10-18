// Check for src/arrival.js against the ascent of every preset: bodies, success, landing, stranded lines, and the
// 8 s screen-time budget; the powered-descent profiles (Moon, Mars: no NaN, touchdown < 1.5 m/s, altitude never
// rising in the powered phases); lighting and atmosphere exports. Prints each preset's ending.
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

// Powered descent (animation, est.): Moon and Mars, for the lander and the capsule stack.
const { lightingFor, atmosphereFor } = await import("../src/arrival.js");
for (const [pid, body] of [["nova-c", "moon"], ["apollo-csm-lm", "moon"], ["nova-c", "mars"], ["apollo-csm-lm", "mars"]]) {
  const label = `descent ${pid}@${body}`;
  const d = descentTimeline(catalog.payloads.find((p) => p.id === pid), { body });
  const S = d.samples;
  const nums = (x) => [x.t_screen, x.t_s, x.alt_m, x.downrange_m, x.vel_ms, x.pitch_deg, x.throttle, x.dust, x.heat, x.chute];
  expect(S.every((x) => nums(x).every(Number.isFinite)), `${label}: NaN or non-finite sample`);
  expect(d.screen_s === 15 && S.at(-1).t_screen === 15 && S.every((x, i) => i === 0 || x.t_screen > S[i - 1].t_screen), `${label}: screen time not 0..15 s increasing`);
  expect(S.at(-1).alt_m === 0 && d.touchdown_ms < 1.5, `${label}: touchdown at ${d.touchdown_ms} m/s, alt ${S.at(-1).alt_m}`);
  const powered = S.filter((x) => x.phase !== "entry");
  expect(powered.every((x, i) => i === 0 || x.alt_m <= powered[i - 1].alt_m + 1e-9), `${label}: altitude rises after entry (parachute or powered descent)`);
  expect(S.every((x) => x.alt_m >= 0 && x.pitch_deg >= 0 && x.pitch_deg <= 90 && x.throttle >= 0 && x.throttle <= 1 && x.dust >= 0 && x.dust <= 1 && x.heat >= 0 && x.heat <= 1 && x.chute >= 0 && x.chute <= 1), `${label}: value out of range`);
  expect(S.every((x) => (x.phase === "entry" ? true : x.heat === 0) && (x.phase === "parachute" ? true : x.chute === 0)), `${label}: heat outside the aeroshell phase or chute outside the parachute phase`);
  expect(d.moments.at(-1)?.type === "touchdown" && d.moments.every((m, i) => i === 0 || m.t_screen >= d.moments[i - 1].t_screen), `${label}: moments out of order or no touchdown`);
  expect(S.every((x) => (x.alt_m >= 30 ? x.dust === 0 : true)) && S.some((x) => x.dust > 0.3), `${label}: dust must appear only below 30 m`);
  expect(S.every((x, i) => i === 0 || x.downrange_m >= S[i - 1].downrange_m), `${label}: downrange goes backwards`);
  if (body === "moon") {
    expect(S[0].alt_m === 15000 && Math.abs(S[0].vel_ms - 1672) < 2 && S[0].pitch_deg === 80, `${label}: braking must start at 15 km, ~1672 m/s (from the fact-sheet GM and radius), pitch 80`);
    expect(d.entry === null && S.every((x) => x.heat === 0 && x.chute === 0), `${label}: no entry or chute on the Moon`);
  } else {
    expect(S[0].alt_m === 120000 && S[0].vel_ms === 5500 && Number.isFinite(d.entry?.speedAt10km_ms), `${label}: entry from 120 km at 5.5 km/s, speed at 10 km reported`);
    expect(S.filter((x) => x.phase === "entry").some((x) => x.heat >= 0.99), `${label}: entry heat not normalised`);
    const sep = d.moments.find((m) => m.type === "heatshield-sep");
    const par = d.phases.find((p) => p.name === "parachute");
    expect(sep && par && Math.abs(sep.t_screen - par.t_screen_start) < 1e-9 && d.moments.some((m) => m.type === "chute-release"), `${label}: heatshield-sep must be at chute open; chute-release missing`);
    expect(S.filter((x) => x.phase === "parachute").some((x) => x.chute === 1) && d.entry.chuteRelease.alt_m <= 1501, `${label}: chute never fully open or not released by 1.5 km`);
    expect(d.entry.chuteOpen.mach2Reached ? Math.abs(d.entry.chuteOpen.vel_ms - 480) <= 2 : d.entry.chuteOpen.alt_m <= 3001, `${label}: chute must open at ~480 m/s or at the 3 km floor`);
  }
  const vert = S.filter((x) => x.phase === "vertical");
  expect(vert[0]?.alt_m === 150, `${label}: vertical phase must start at 150 m`);
  console.log(`${label}: ${d.phases.map((p) => `${p.name} ${p.t_screen_start}-${p.t_screen_end}s/${p.t_s}s`).join(", ")}; touchdown ${d.touchdown_ms} m/s; braking ${d.brakingAccel_ms2}, approach ${d.approachAccel_ms2} m/s^2${d.entry ? `; 10 km ${d.entry.speedAt10km_ms} m/s, chute open ${d.entry.chuteOpen.vel_ms} m/s at ${d.entry.chuteOpen.alt_m} m${d.entry.chuteOpen.mach2Reached ? "" : " (3 km floor)"}, release ${d.entry.chuteRelease.vel_ms} m/s at ${d.entry.chuteRelease.alt_m} m` : ""}`);
}
for (const body of ["earth", "moon", "mars"]) {
  const L = lightingFor(body);
  const len = Math.hypot(...L.sunDir);
  expect(Math.abs(len - 1) < 1e-3 && L.sunDir[1] > 0 && L.ambient >= 0 && L.ambient <= 1 && typeof L.skyColour === "string", `lighting ${body}: ${JSON.stringify(L)}`);
  const A = atmosphereFor(body);
  if (body === "moon") expect(A.none === true, "atmosphere moon must be none");
  else expect(A.scaleHeight_m > 0 && A.surfacePressure_Pa > 0 && /nssdc\.gsfc\.nasa\.gov/.test(A.source), `atmosphere ${body}: ${JSON.stringify(A)}`);
  console.log(`light ${body}: sun elev ${L.sunElevation_deg} deg, ambient ${L.ambient}; atmosphere ${A.none ? "none" : `H ${A.scaleHeight_m} m, p0 ${A.surfacePressure_Pa} Pa`}`);
}
expect(atmosphereFor("mars").scaleHeight_m === 11000 && atmosphereFor("mars").surfacePressure_Pa === 636 && atmosphereFor("earth").scaleHeight_m === 8500, "atmosphere constants differ from the NASA fact sheets");

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: every preset's ending follows the rules and fits in 8 s.");
