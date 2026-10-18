// Check for the twin compare (catalog.closestRockets / twinLine over src/data/gcat-rockets.json): each real
// preset's closest GCAT rocket is from its own family; the pool is drawable; prints the top 3 per preset.
// Run: node scripts/check-twin.mjs [--app-formula | --no-diameter | --no-prefer-reference]   (exits 1 on failure)
// The default checks closestRockets' default matching; the flags switch its corrections off to compare
// (--app-formula = both off = the team app's mass + thrust formula, which fails for Falcon 9 and Delta IV).
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { presetIds, getPreset, presetToBuild, closestRockets, twinLine, gcatRockets, gcatSource } = await import("../src/data/catalog.js");

const arg = (f) => process.argv.includes(f);
const opts = {
  diameter: !(arg("--app-formula") || arg("--no-diameter")),
  preferReference: !(arg("--app-formula") || arg("--no-prefer-reference")),
};
const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
// Own family per real preset (GCAT family names). demo-build is not a real vehicle: printed only.
const FAMILY = { "falcon-9": ["Falcon9"], "saturn-v": ["SaturnV"], "atlas-v-401": ["Atlas5"], "delta-iv-m": ["Delta4"] };

expect(gcatRockets.length > 400, `pool has only ${gcatRockets.length} rows`);
expect(/CC BY 4\.0/.test(gcatSource ?? ""), "GCAT attribution (_source) missing");
for (const r of gcatRockets) {
  if (!(r.length_m > 0 && r.diameter_m > 0 && r.launches >= 1)) failures.push(`${r.id}: not drawable or never launched`);
}

console.log(`matching: rocketDistance (log mass, log thrust)${opts.diameter ? " + log diameter" : ""}${opts.preferReference ? ", reference-rockets figures where referenceId" : ""}`);
for (const id of presetIds) {
  const top = closestRockets(presetToBuild(getPreset(id)), 3, opts);
  expect(top.length === 3, `${id}: ${top.length} matches`);
  const want = FAMILY[id];
  const ok = !want || want.includes(top[0]?.rocket.family);
  if (want) expect(ok, `${id}: twin is ${top[0]?.rocket.name} ${top[0]?.rocket.variant ?? ""} (family ${top[0]?.rocket.family}), expected family ${want.join("/")}`);
  console.log(`${ok ? "ok  " : "FAIL"}  ${id}  (build est. ${Math.round(top[0]?.verdictMass_kg / 1000)} t, ${Math.round(top[0]?.verdictThrust_kN)} kN)`);
  top.forEach((t, i) => console.log(`        ${i + 1}. ${twinLine(t.rocket)}  [${t.rocket.family}, d ${t.distance.toFixed(3)}]`));
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\nOK: every real preset's twin is from its own family.");
