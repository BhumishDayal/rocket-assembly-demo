// Check for src/compat.js: every preset is all-ok, each rule fires with its plain-words reason, option lists
// are ordered ok -> unusual -> incompatible.
// Run: node scripts/check-compat.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { catalog, presetIds, getPreset, presetToBuild, optionsFor } = await import("../src/data/catalog.js");
const { checkBuild, checkOption, optionsWithCompat } = await import("../src/compat.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const livery = { primary: "#ffffff", accent: "#111111", stripe: false, patch: null };
const build = (stages, payloadId = "", missionId = "leo") => ({
  missionId,
  payloadId,
  livery,
  stages: stages.map(([engineId, engineCount, tankId]) => ({ engineId, engineCount, tankId })),
});
const rec = (kind, id) => (kind === "payload" ? catalog.payloads : kind === "tank" ? catalog.tanks : catalog.engines).find((r) => r.id === id);

// 1. Every preset, as shipped, is all-ok, except the labels listed here (agreed with the head chat): the team's
// demo build is a made-up pairing whose 5.0 m upper stage really is wider than its 3.66 m booster.
const EXPECTED = { "demo-build": ["tank s1 unusual: wider than the stage below"] };
for (const id of presetIds) {
  const slots = checkBuild(presetToBuild(getPreset(id)), catalog);
  const got = slots.filter((s) => s.level !== "ok").map((s) => `${s.kind}${s.stageIndex == null ? "" : ` s${s.stageIndex}`} ${s.level}: ${s.reasons.join("; ")}`);
  const want = EXPECTED[id] ?? [];
  const ok = got.length === want.length && got.every((g, k) => g === want[k]);
  if (!ok) failures.push(`preset ${id}: got [${got.join(" | ")}], want [${want.join(" | ")}]`);
  console.log(`${ok ? "ok  " : "FAIL"}  preset ${id.padEnd(12)} ${slots.length} slots${got.length ? ` · ${got.join(" | ")}` : ", all ok"}`);
}

// 2. Each rule, through checkOption (what the option list shows) or checkBuild.
const cases = [
  // [label, build, kind, stageIndex, recordId, level, reason substring]
  ["propellant (engine option)", build([["merlin-1d", 9, "falcon9-s1-tank"]]), "engines", 0, "rs-25", "incompatible", "hydrolox engine on a kerolox tank"],
  ["propellant (tank option)", build([["merlin-1d", 9, "falcon9-s1-tank"]]), "tank", 0, "sls-core-tank", "incompatible", "hydrolox tank for a kerolox engine"],
  ["vacuum-only on stage 0", build([["merlin-1d", 9, "falcon9-s1-tank"]]), "engines", 0, "merlin-1d-vac", "incompatible", "vacuum engine cannot light at sea level"],
  // J-2 under Centaur fits: 0.6 * (3.05 / 1.956)^2 = 1.46 -> 1 engine.
  ["J-2 fits under Centaur", build([["rd-180", 1, "atlas-v-ccb-tank"], ["rl10c-1", 1, "centaur-iii-tank"]]), "engines", 1, "j-2", "ok", ""],
  ["bell wider than the tank (F-1 under Centaur)", build([["rd-180", 1, "atlas-v-ccb-tank"], ["j-2", 1, "centaur-iii-tank"]]), "engines", 1, "f-1", "incompatible", "3.53 m bell does not fit under a 3.05 m tank"],
  ["overall-diameter engine says engine", build([["rd-180", 1, "atlas-v-ccb-tank"], ["rl10c-1", 1, "centaur-iii-tank"]]), "engines", 1, "rd-180", "incompatible", "3.2 m engine does not fit under a 3.05 m tank"],
  ["tank narrower than its engine (tank option)", build([["rd-180", 1, "atlas-v-ccb-tank"]]), "tank", 0, "centaur-iii-tank", "incompatible", "3.2 m engine does not fit under a 3.05 m tank"],
  // Single engines nearly as wide as the stage are real (the app's 0.6 packing rule wrongly returns 0 here).
  ["MVac fits on the F9 second stage", build([["merlin-1d", 9, "falcon9-s1-tank"], ["rl10b-2", 1, "falcon9-s2-tank"]]), "engines", 1, "merlin-1d-vac", "ok", ""],
  ["RD-180 fits on the Atlas booster", build([["merlin-1d", 1, "atlas-v-ccb-tank"]]), "engines", 0, "rd-180", "ok", ""],
  ["stage much wider than below", build([["rl10c-1", 1, "centaur-iii-tank"], ["rl10c-1", 1, "centaur-iii-tank"]]), "tank", 1, "dcss-5m-tank", "incompatible", "5.0 m stage on a 3.05 m stage"],
  ["payload much wider than top stage", build([["rd-180", 1, "atlas-v-ccb-tank"], ["rl10c-1", 1, "centaur-iii-tank"]], "goes-r"), "payload", null, "apollo-csm-lm", "incompatible", "6.6 m payload on a 3.05 m stage"],
  ["sea-level engine on an upper stage", build([["merlin-1d", 9, "falcon9-s1-tank"], ["merlin-1d-vac", 1, "falcon9-s2-tank"]]), "engines", 1, "merlin-1d", "unusual", "sea-level engine used in vacuum"],
  ["stage wider than below", build([["merlin-1d", 9, "falcon9-s1-tank"], ["rl10b-2", 1, "falcon9-s2-tank"]], "jwst"), "tank", 1, "dcss-5m-tank", "unusual", "wider than the stage below"],
  ["upper stage heavier", build([["rd-180", 1, "atlas-v-ccb-tank"], ["merlin-1d", 1, "centaur-iii-tank"]]), "tank", 1, "falcon9-s1-tank", "unusual", "upper stage heavier than the stage below"],
  ["count reduced by the fit rule", build([["merlin-1d", 9, "falcon9-s1-tank"]]), "engines", 0, "rd-191", "unusual", "count reduced to 1 to fit"],
  ["re-choosing the current record changes nothing", build([["f-1", 5, "saturn-v-s-ic-tank"]]), "engines", 0, "f-1", "ok", ""],
  ["tank choice judges the stage above", build([["rl10c-1", 1, "centaur-iii-tank"], ["rl10b-2", 1, "dcss-5m-tank"]]), "tank", 0, "icps-tank", "ok", ""],
  ["tank choice under a wide stage above", build([["rs-68a", 1, "delta-iv-cbc-tank"], ["rl10b-2", 1, "sls-core-tank"]]), "tank", 0, "delta-iv-cbc-tank", "incompatible", "stage 2: 8.4 m stage on a 5.0 m stage"],
];
for (const [label, b, kind, i, id, level, reason] of cases) {
  const r = rec(kind, id);
  if (!r) {
    failures.push(`${label}: no record ${id}`);
    continue;
  }
  const got = checkOption(b, catalog, kind, i, r);
  const ok = got.level === level && (reason ? got.reasons.includes(reason) : got.reasons.length === 0);
  expect(ok, `${label}: got ${got.level} [${got.reasons.join("; ")}], want ${level}${reason ? ` with "${reason}"` : " with no reasons"}`);
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${got.level}${got.reasons.length ? ` · ${got.reasons.join("; ")}` : ""}`);
}

// 3. Option lists: every record once, ok -> unusual -> incompatible, optionsFor order inside each level.
const RANK = { ok: 0, unusual: 1, incompatible: 2 };
const f9 = presetToBuild(getPreset("falcon-9"));
for (const [kind, i] of [["engines", 0], ["engines", 1], ["tank", 0], ["tank", 1], ["payload", null]]) {
  const rows = optionsWithCompat(f9, catalog, kind, i);
  const base = optionsFor(kind, f9, i).map((r) => r.id);
  const label = `falcon-9 ${kind}${i == null ? "" : ` s${i}`} options`;
  expect(rows.length === base.length && new Set(rows.map((r) => r.record.id)).size === base.length, `${label}: ${rows.length} rows for ${base.length} records`);
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1];
    const b = rows[k];
    if (RANK[a.level] > RANK[b.level]) failures.push(`${label}: ${a.record.id} (${a.level}) before ${b.record.id} (${b.level})`);
    if (a.level === b.level && base.indexOf(a.record.id) > base.indexOf(b.record.id)) failures.push(`${label}: ${a.record.id} before ${b.record.id} breaks optionsFor order`);
  }
  const counts = rows.reduce((c, r) => ((c[r.level] = (c[r.level] ?? 0) + 1), c), {});
  console.log(`      ${label}: ${JSON.stringify(counts)}`);
}

// 4. The current record's option verdict equals checkBuild's verdict for that slot (engines and payload slots;
// a tank option also judges the slot above, so it can legitimately say more).
for (const id of presetIds) {
  const b = presetToBuild(getPreset(id));
  const slots = checkBuild(b, catalog);
  b.stages.forEach((s, i) => {
    const o = checkOption(b, catalog, "engines", i, rec("engines", s.engineId));
    const sl = slots.find((x) => x.kind === "engines" && x.stageIndex === i);
    expect(o.level === sl.level, `${id} s${i} engines: option says ${o.level}, build says ${sl.level}`);
  });
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: compat rules, presets and option ordering all check out.");
