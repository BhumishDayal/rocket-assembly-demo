// Check for src/hazards.js and src/data/hazards.json: every threshold has a URL and a verbatim quote that contains
// its number; the module takes no number from anywhere else; assessLaunch is deterministic per seed; lightning
// within 10 nm scrubs, calm days are GO; every rule's boundary reads as its source words it; every preset runs
// over many seeds; effectsForFlight's vectors and glow; the generated space weather matches NOAA's frequencies.
// Prints each preset's range call for one fixed day.
// Run: node scripts/check-hazards.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

// catalog.js and hazards.js import JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { catalog, presetIds, getPreset, presetToBuild } = await import("../src/data/catalog.js");
const { assessLaunch, effectsForFlight, simulateConditions, CALM_CONDITIONS, planeChangeDeltaV_ms, hazards } = await import("../src/hazards.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DAY = "2026-10-18";
const builds = Object.fromEntries(presetIds.map((id) => [id, presetToBuild(getPreset(id))]));
const F9 = builds["falcon-9"];

// 1. Sources: URL, verbatim quote, and the threshold's own text inside the quote(s).
let thresholds = 0;
const quotes = (e) => [e.quote, e.quote2, e.auroraQuote, e.alternative].filter(Boolean).join(" ");
function sourced(label, e, { url = e.url, needThreshold = true } = {}) {
  expect(typeof url === "string" && url.startsWith("https://"), `${label}: no https URL`);
  expect(typeof e.quote === "string" && e.quote.length > 20, `${label}: no quote`);
  expect(typeof e.tier === "string" || label.includes("level"), `${label}: no tier`);
  const t = e.threshold;
  if (t === null || t === undefined) {
    expect(!needThreshold || /est\./.test(e.note ?? ""), `${label}: no threshold and no est. note`);
    return;
  }
  thresholds++;
  expect(Number.isFinite(t.value), `${label}: threshold value ${t.value}`);
  expect(typeof t.quoted === "string" && quotes(e).includes(t.quoted), `${label}: quote does not contain "${t.quoted}"`);
  if (t.windowQuoted) expect(quotes(e).includes(t.windowQuoted), `${label}: quote does not contain "${t.windowQuoted}"`);
  if (e.frequencyQuoted) expect(quotes(e).includes(e.frequencyQuoted), `${label}: quote does not contain "${e.frequencyQuoted}"`);
}
for (const r of hazards.weather) {
  sourced(`weather ${r.id}`, r);
  if (r.process) sourced(`weather ${r.id} process`, { ...r.process, threshold: null }, { needThreshold: false });
}
const SW = hazards.spaceWeather;
expect(SW.url.startsWith("https://") && SW.pdf.startsWith("https://") && SW.cycleQuote.includes("11 years"), "space weather: page/pdf/cycle source");
for (const [scale, key] of [["geomagnetic", "daysPerCycle"], ["radiation", "eventsPerCycle"], ["radioBlackout", "daysPerCycle"]]) {
  const s = SW[scale];
  expect(s.levels.length === 5 && s.levels.every((l, i) => l.level === i + 1), `${scale}: levels 1..5`);
  expect(s.measureQuote?.length > 5, `${scale}: no measure quote`);
  for (const l of s.levels) {
    sourced(`${scale} level ${l.level}`, l, { url: SW.url });
    expect(Number.isFinite(l[key]), `${scale} level ${l.level}: ${key}`);
  }
  for (let i = 1; i < 5; i++) expect(s.levels[i].threshold.value > s.levels[i - 1].threshold.value, `${scale}: thresholds rise`);
}
for (const p of SW.precedents) sourced(`precedent ${p.id}`, p);
sourced("debris screening", { ...hazards.debris.screening, threshold: null }, { needThreshold: false });
for (const l of hazards.debris.limits) {
  sourced(`debris ${l.id}`, l);
  if (l.mitigation) expect(l.quote.includes(l.mitigation.quoted), `debris ${l.id}: quote lacks "${l.mitigation.quoted}"`);
}
for (const w of hazards.window.kinds) sourced(`window ${w.id}`, w, { needThreshold: false });
sourced("plane change", { ...hazards.window.planeChange, threshold: null }, { needThreshold: false });
// The derived unit factors.
const U = hazards._units;
expect(near(U.kt_per_mph.value, 1609.344 / 1852, 5e-7), `kt_per_mph ${U.kt_per_mph.value}`);
expect(near(U.ms_per_kt.value, 1852 / 3600, 5e-7), `ms_per_kt ${U.ms_per_kt.value}`);
expect(U.km_per_nm.value === 1.852 && U.days_per_cycle.value === 11 * 365.25, "km_per_nm / days_per_cycle");
console.log(`${failures.length ? "FAIL" : "ok  "}  sources: ${thresholds} thresholds, each with URL + quote containing its number`);

// 2. hazards.js takes its numbers from hazards.json: no rule figure as a literal, no DOM.
const src = readFileSync(new URL("../src/hazards.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
for (const lit of ["26.1", "33", "1500", "4500", "1e-6", "1e-5", "1e-7", "1e-4", "0.868976", "0.514444", "1.852", "4017.75"]) {
  expect(!new RegExp(`(?<![\\w.])${lit.replace(".", "\\.")}(?![\\w])`).test(src), `hazards.js has the literal ${lit} outside comments`);
}
expect(!/(?<![.\w])(document|window\.|localStorage|requestAnimationFrame|THREE)/.test(src), "hazards.js touches the DOM or three");

// 3. Deterministic per seed.
for (const id of presetIds) {
  const a = assessLaunch({ build: builds[id], presetId: id, day: DAY });
  const b = assessLaunch({ build: builds[id], presetId: id, day: DAY });
  expect(JSON.stringify(a) === JSON.stringify(b), `${id}: two calls with the same day differ`);
  expect(a.seedKey === `${id}|${DAY}`, `${id}: seedKey ${a.seedKey}`);
}
expect(JSON.stringify(assessLaunch({ build: F9, seed: 42 })) === JSON.stringify(assessLaunch({ build: F9, seed: "42" })), "seed 42 and \"42\" differ");
const tries = [0, 1, 2].map((attempt) => assessLaunch({ build: F9, presetId: "falcon-9", day: DAY, attempt }));
expect(tries[1].seedKey === `falcon-9|${DAY}#1` && new Set(tries.map((t) => JSON.stringify(t.conditions))).size === 3, "attempt does not give a new sky");
expect(JSON.stringify(tries[0]) === JSON.stringify(assessLaunch({ build: F9, presetId: "falcon-9", day: DAY })), "attempt 0 differs from no attempt");
const distinct = new Set(Array.from({ length: 300 }, (_, s) => JSON.stringify(simulateConditions(s, F9))));
expect(distinct.size === 300, `only ${distinct.size} distinct skies in 300 seeds`);
expect(JSON.stringify(simulateConditions("x", F9)) === JSON.stringify(simulateConditions("x", F9)), "simulateConditions not deterministic");

// 4. A seed with lightning inside 10 nm scrubs; calm days are GO.
let lightSeed = null;
for (let s = 0; s < 20000 && lightSeed === null; s++) {
  const c = simulateConditions(s, F9);
  if (c.lightning_nm !== null && c.lightning_nm < 10) lightSeed = s;
}
expect(lightSeed !== null, "no seed with lightning inside 10 nm");
if (lightSeed !== null) {
  const a = assessLaunch({ build: F9, seed: lightSeed });
  const fx = effectsForFlight(a);
  expect(!a.go && a.blockers.some((b) => b.id === "lightning"), `seed ${lightSeed}: lightning ${a.conditions.lightning_nm} nm did not scrub`);
  expect(fx.scrub === true && fx.lightning && near(fx.lightning.distance_km, a.conditions.lightning_nm * 1.852, 0.06), `seed ${lightSeed}: effects ${JSON.stringify(fx.lightning)}`);
  expect(a.hud.startsWith("Range: SCRUB · "), `seed ${lightSeed}: hud "${a.hud}"`);
  console.log(`ok    lightning seed ${lightSeed}: ${a.hud}`);
}
for (const id of presetIds) {
  const a = assessLaunch({ build: builds[id], presetId: id, day: DAY, conditions: CALM_CONDITIONS });
  expect(a.go && a.blockers.length === 0 && a.cautions.length === 0, `${id} calm: ${a.blockers.map((b) => b.text).join("; ")} ${a.cautions.map((b) => b.text).join("; ")}`);
  expect(a.hud === "Range: GO · winds 6 kt · Kp 2", `${id} calm hud "${a.hud}"`);
  expect(effectsForFlight(a).scrub === false && effectsForFlight(a).stormGlow === 0, `${id} calm effects`);
}

// 5. Each rule's boundary, as its source words it ("exceeds" strict, "within" inclusive).
const at = (over, build = F9) => assessLaunch({ build, seed: 1, conditions: { ...CALM_CONDITIONS, ...over } });
const ids = (a) => a.blockers.map((b) => b.id).join(",");
const cases = [
  // [label, overrides, build, go, blocker id (when not go)]
  ["F9 wind at the 26.1 kt limit", { windSurface_kt: 26.1 }, F9, true],
  ["F9 wind above the limit", { windSurface_kt: 26.2 }, F9, false, "surface-wind"],
  ["Atlas V wind 33 kt", { windSurface_kt: 33 }, builds["atlas-v-401"], true],
  ["Atlas V wind 33.1 kt", { windSurface_kt: 33.1 }, builds["atlas-v-401"], false, "surface-wind"],
  ["Saturn V uses the Falcon 9 stand-in", { windSurface_kt: 26.2 }, builds["saturn-v"], false, "surface-wind"],
  ["lightning at 10 nm (within)", { lightning_nm: 10 }, F9, false, "lightning"],
  ["lightning at 10.1 nm", { lightning_nm: 10.1 }, F9, true],
  ["field mill 1,500 V/m", { fieldMill_Vm: 1500 }, F9, true],
  ["field mill 1,510 V/m", { fieldMill_Vm: 1510 }, F9, false, "field-mill"],
  ["cumulus at 10 nm", { cloudRule: "cumulus", cloud_nm: 10 }, F9, false, "cloud"],
  ["cumulus at 10.5 nm", { cloudRule: "cumulus", cloud_nm: 10.5 }, F9, true],
  ["attached anvil at 9 nm", { cloudRule: "anvil-attached", cloud_nm: 9 }, F9, false, "cloud"],
  ["detached anvil at 11 nm", { cloudRule: "anvil-detached", cloud_nm: 11 }, F9, true],
  ["thick freezing layer", { cloudRule: "thick-layer", cloud_nm: 0 }, F9, false, "cloud"],
  ["high shear", { windShear: "high" }, F9, false, "wind-shear"],
  ["moderate shear", { windShear: "moderate" }, F9, true],
  ["Kp 7 (G3)", { kp: 7 }, F9, true],
  ["Kp 8 (G4)", { kp: 8 }, F9, false, "geomagnetic"],
  ["Kp 8.67 (\"9-\", still G4)", { kp: 8.67 }, F9, false, "geomagnetic"],
  ["S3", { sScale: 3 }, F9, true],
  ["S4", { sScale: 4 }, F9, false, "radiation"],
  ["R5 (caution only)", { rScale: 5 }, F9, true],
  ["crewed station Pc 1e-6", { debrisObject: "inhabitable", debrisPc: 1e-6 }, F9, true],
  ["crewed station Pc 1.1e-6", { debrisObject: "inhabitable", debrisPc: 1.1e-6 }, F9, false, "debris"],
  ["satellite Pc 5e-6", { debrisObject: "spacecraft", debrisPc: 5e-6 }, F9, true],
  ["debris Pc 2e-5", { debrisObject: "debris", debrisPc: 2e-5 }, F9, false, "debris"],
];
for (const [label, over, build, go, id] of cases) {
  const a = at(over, build);
  const ok = a.go === go && (go || a.blockers[0]?.id === id);
  expect(ok, `${label}: go ${a.go} [${ids(a)}], want ${go}${id ? ` [${id}]` : ""}`);
}
const sat = at({ windSurface_kt: 30 }, builds["saturn-v"]);
expect(sat.blockers[0]?.text.includes("Falcon 9 rule, est.") && sat.blockers[0].est, `Saturn V stand-in label: ${sat.blockers[0]?.text}`);
expect(at({}, F9).conditions.windLimit_kt === 26.1 && at({}, builds["atlas-v-401"]).conditions.windLimit_kt === 33, "wind limits 26.1 / 33 kt");
expect(at({ kp: 6 }).cautions.some((c) => c.id === "orbit-drag") && at({ kp: 6 }).cautions.some((c) => c.id === "geomagnetic"), "G2 cautions");
expect(at({ debrisPc: 3e-7 }).cautions.some((c) => c.id === "debris"), "CARA attention caution");
console.log(`${failures.length ? "FAIL" : "ok  "}  ${cases.length} rule boundaries`);

// 6. Every preset over many seeds: sane fields, short lines, sources on every item, effects agree.
const N = 3000;
const SHEAR = new Set(["low", "moderate", "high"]);
const CLOUD = new Set(["clear", "cumulus", "anvil-attached", "anvil-detached", "thick-layer"]);
const counts = {};
let scrubs = 0;
let storms = 0;
let rDays = 0;
let maxHud = 0;
for (const id of presetIds) {
  for (let s = 0; s < N; s++) {
    let a;
    try {
      a = assessLaunch({ build: builds[id], presetId: id, day: `d${s}` });
    } catch (e) {
      failures.push(`${id} seed d${s}: threw ${e.message}`);
      continue;
    }
    const c = a.conditions;
    const bad = [];
    if (!(c.windSurface_kt >= 0 && c.windSurface_kt <= 40)) bad.push(`wind ${c.windSurface_kt}`);
    if (!(Number.isInteger(c.windDir_deg) && c.windDir_deg >= 0 && c.windDir_deg < 360)) bad.push(`dir ${c.windDir_deg}`);
    if (!SHEAR.has(c.windShear)) bad.push(`shear ${c.windShear}`);
    if (!(c.lightning_nm === null || (c.lightning_nm >= 0.5 && c.lightning_nm <= 30))) bad.push(`lightning ${c.lightning_nm}`);
    if (!(c.fieldMill_Vm >= 0 && c.fieldMill_Vm <= 3000)) bad.push(`field ${c.fieldMill_Vm}`);
    if (!CLOUD.has(c.cloudRule) || (c.cloudRule === "clear") !== (c.cloud_nm === null)) bad.push(`cloud ${c.cloudRule}/${c.cloud_nm}`);
    if (!(Number.isInteger(c.kp) && c.kp >= 0 && c.kp <= 9) || c.gScale !== Math.max(0, c.kp - 4)) bad.push(`kp ${c.kp} g ${c.gScale}`);
    if (!(c.sScale >= 0 && c.sScale <= 4 && c.rScale >= 0 && c.rScale <= 4)) bad.push(`s ${c.sScale} r ${c.rScale}`);
    if (!(c.debrisPc >= 1e-12 && c.debrisPc <= 1e-3)) bad.push(`pc ${c.debrisPc}`);
    if (c.note !== "simulated conditions · est.") bad.push("note");
    if (a.go !== (a.blockers.length === 0)) bad.push("go vs blockers");
    if (a.lines[0] !== a.hud || !/^Range: (GO · winds \d+ kt · Kp \d|SCRUB · .+)$/.test(a.hud)) bad.push(`hud "${a.hud}"`);
    if (a.lines.some((l) => typeof l !== "string" || l.length > 96)) bad.push("long line");
    for (const it of [...a.blockers, ...a.cautions]) {
      if (!it.source?.startsWith("https://") || !(it.rule?.length > 10) || !it.text || !it.hud) bad.push(`item ${it.id} unsourced`);
    }
    const fx = effectsForFlight(a);
    const fx2 = effectsForFlight(c); // from the conditions alone
    if (fx.scrub !== !a.go || fx2.scrub !== fx.scrub || fx2.scrubReason !== fx.scrubReason) bad.push("effects scrub");
    if (!near(Math.hypot(...fx.wind_ms), c.windSurface_kt * 0.514444, 0.01) || fx.wind_ms[1] !== 0 || fx.windDrift_ms !== fx.wind_ms) bad.push(`wind_ms ${fx.wind_ms}`);
    if (!(fx.stormGlow >= 0 && fx.stormGlow <= 1) || (c.kp < 5) !== (fx.stormGlow === 0)) bad.push(`glow ${fx.stormGlow} at Kp ${c.kp}`);
    if ((c.lightning_nm === null) !== (fx.lightning === null)) bad.push("lightning effect");
    if (bad.length) failures.push(`${id} d${s}: ${bad.join("; ")}`);
    maxHud = Math.max(maxHud, a.hud.length);
    if (!a.go) {
      scrubs++;
      counts[a.blockers[0].id] = (counts[a.blockers[0].id] ?? 0) + 1;
    }
    if (c.gScale >= 1) storms++;
    if (c.rScale >= 1) rDays++;
  }
}
const total = N * presetIds.length;
const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / total).toFixed(1)}%`).join(", ");
console.log(`ok    ${total} skies over ${presetIds.length} presets: scrub ${((100 * scrubs) / total).toFixed(1)}% (first blocker: ${top}); longest HUD ${maxHud} chars`);

// 7. Generated space weather matches NOAA's frequencies (days per 11-year cycle).
const dpc = hazards._units.days_per_cycle.value;
const gWant = SW.geomagnetic.levels.reduce((s, l) => s + l.daysPerCycle, 0) / dpc;
const rWant = SW.radioBlackout.levels.reduce((s, l) => s + l.daysPerCycle, 0) / dpc;
const gGot = storms / total;
const rGot = rDays / total;
expect(near(gGot, gWant, 0.015), `G1+ days ${gGot.toFixed(3)}, NOAA ${gWant.toFixed(3)}`);
expect(near(rGot, rWant, 0.015), `R1+ days ${rGot.toFixed(3)}, NOAA ${rWant.toFixed(3)}`);
console.log(`ok    G1+ on ${(100 * gGot).toFixed(1)}% of days (NOAA ${(100 * gWant).toFixed(1)}%), R1+ on ${(100 * rGot).toFixed(1)}% (NOAA ${(100 * rWant).toFixed(1)}%)`);

// 8. effectsForFlight: frame (+x east, +z south), glow ramp, lightning shape.
const kt12 = 12 / 0.514444;
const w = (fromDeg) => effectsForFlight({ ...CALM_CONDITIONS, windSurface_kt: kt12, windDir_deg: fromDeg }).wind_ms;
const vec = (v, want) => v.every((x, i) => near(x, want[i], 0.01));
expect(vec(w(270), [12, 0, 0]), `wind from west ${w(270)}, want [12, 0, 0]`);
expect(vec(w(0), [0, 0, 12]), `wind from north ${w(0)}, want [0, 0, 12]`);
expect(vec(w(90), [-12, 0, 0]), `wind from east ${w(90)}, want [-12, 0, 0]`);
expect(vec(w(180), [0, 0, -12]), `wind from south ${w(180)}, want [0, 0, -12]`);
const glow = (kp) => effectsForFlight({ ...CALM_CONDITIONS, kp }).stormGlow;
expect(glow(4) === 0 && glow(5) > 0 && glow(9) === 1 && glow(7) > glow(6), `glow 4:${glow(4)} 5:${glow(5)} 9:${glow(9)}`);
const lf = effectsForFlight({ ...CALM_CONDITIONS, lightning_nm: 6, lightningAz_deg: 120 });
expect(lf.scrub && lf.lightning.azimuth_deg === 120 && lf.lightning.azimuth === 120 && near(lf.lightning.distance_km, 11.1, 0.06) && lf.lightning.perMinute > 0, `lightning effect ${JSON.stringify(lf)}`);

// 9. Windows per mission, plane change.
const WANT = { leo: "flexible", gto: "parking-orbit", "earth-escape": "parking-orbit", "moon-transfer": "lunar", "lunar-orbit": "lunar", "mars-transfer": "planetary" };
for (const m of catalog.missions) {
  const a = assessLaunch({ build: { ...F9, missionId: m.id }, seed: 1 });
  expect(a.window.kind === WANT[m.id] && a.window.source.startsWith("https://"), `${m.id}: window ${a.window.kind}`);
}
expect(near(planeChangeDeltaV_ms(7800, 1), 136.13, 0.01), `plane change 1° at 7.8 km/s = ${planeChangeDeltaV_ms(7800, 1)}`);

// One fixed day, every preset.
console.log(`\nRange calls for ${DAY}:`);
for (const id of presetIds) {
  const a = assessLaunch({ build: builds[id], presetId: id, day: DAY });
  const more = a.lines.slice(1, -2);
  console.log(`  ${id.padEnd(12)} ${a.hud}${more.length ? `\n${more.map((l) => `               - ${l}`).join("\n")}` : ""}`);
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures.slice(0, 40)) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nall hazards checks passed");
