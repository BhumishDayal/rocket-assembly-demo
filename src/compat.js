// Part compatibility: which records can go in which slot, with a one-line plain-words reason per problem
// (shown next to the option). Pure: no DOM, data in, verdicts out.
//   checkOption(build, catalog, kind, stageIndex, record) -> { level, reasons }
//   optionsWithCompat(build, catalog, kind, stageIndex)   -> [{ record, level, reasons }]  ok, unusual, incompatible
//   checkBuild(build, catalog)                            -> [{ kind, stageIndex, level, reasons }]  every slot
// kind: "engines" | "tank" | "payload" (singular/plural accepted). level: "ok" | "unusual" | "incompatible".
//
// INCOMPATIBLE (cannot be chosen):
//   - engine and tank propellants differ
//   - vacuum-only engine on stage 0
//   - the engine is wider than its tank (d_engine > D_tank): even a single engine cannot sit under the stage.
//     The app's packing rule floor(RULES.ENGINE_FIT_FACTOR * (D_tank / d_engine)^2) (factor 0.62 since #20) is
//     a cluster rule and is NOT used for this: it returns 0 for real flown pairs (Merlin Vacuum 3.3 m on the
//     3.66 m Falcon 9 second stage: 0.62 * (3.66 / 3.3)^2 = 0.76 -> 0; RD-180 3.2 m on the 3.81 m Atlas V
//     booster: 0.88 -> 0) and only works in the app because physics.maxEngineCount takes max(1, ...).
//   - more engines than the tank fits (that packing rule): the app's verdict blocks it since #20, and
//     catalog.applyOption keeps the count, so the option is incompatible with the verdict's own words
//     ("9 RD-191 engines don't fit a 3.66 m wide Falcon 9 Block 5 first-stage tank: max 1").
//   - tank more than 1.6x as wide as the stage below; payload more than 1.6x as wide as the top tank
// UNUSUAL (allowed, labelled):
//   - sea-level engine on an upper stage
//   - tank more than 1.15x as wide as the stage below
//   - upper stage carries more propellant than the stage below
// The 1.6 / 1.15 width ratios and the sea-level test below are design thresholds for this check, not
// real-world data.
import { isVacuumOnly, maxEngineCount, tooManyEnginesWarning } from "./physics.js";
import { applyOption, optionsFor } from "./data/catalog.js";

const WIDER_INCOMPATIBLE = 1.6;
const WIDER_UNUSUAL = 1.15;
// "Sea-level engine": keeps at least 75 % of its vacuum Isp at sea level, i.e. its nozzle is expanded for the
// ground. Upper-stage engines that publish a sea-level figure (the J-2: 200 s vs 424 s) fall well below.
const SEA_LEVEL_ISP_SHARE = 0.75;

const RANK = { ok: 0, unusual: 1, incompatible: 2 };
const KIND = { engine: "engines", engines: "engines", tank: "tank", tanks: "tank", payload: "payload", payloads: "payload" };

const byId = (list, id) => (id ? list?.find((x) => x.id === id) : undefined);
// Metres for a reason line: at most 2 decimals, at least 1 ("5.0 m", "3.05 m", "10.06 m").
const m = (x) => {
  const s = String(Math.round(x * 100) / 100);
  return s.includes(".") ? s : `${s}.0`;
};
const isSeaLevelEngine = (e) => !isVacuumOnly(e) && e.ispVac_s > 0 && e.ispSL_s / e.ispVac_s >= SEA_LEVEL_ISP_SHARE;
const tooWide = (tank, engine) => tank.diameter_m > 0 && engine.diameter_m > tank.diameter_m;
// visuals.json says when an engine's diameter is its overall envelope (RD-180, RD-191, RS-68A), not a bell.
const engineNoun = (catalog, e) => (catalog.visuals?.engines?.[e.id]?.diameterKind === "overall" ? "engine" : "bell");
const noFit = (catalog, tank, engine) => `${m(engine.diameter_m)} m ${engineNoun(catalog, engine)} does not fit under a ${m(tank.diameter_m)} m tank`;

// Engine count over the packing rule (whole counts only; physics flags fractional counts separately).
const tooMany = (stage, e, t) => Number.isInteger(stage.engineCount) && stage.engineCount > maxEngineCount(t.diameter_m, e.diameter_m);
const tooManyReason = (stage, e, t) => tooManyEnginesWarning(stage.engineCount, e, t, maxEngineCount(t.diameter_m, e.diameter_m));

function resolve(build, catalog, i) {
  const s = build.stages[i];
  return s ? { stage: s, engine: byId(catalog.engines, s.engineId), tank: byId(catalog.tanks, s.tankId) } : null;
}

// Issues of one slot of `build`, as [{ level, reason }]. Unknown records skip the rules that need them.
// relationOnly (tanks): only the rules about the stage below (width, propellant mass), used when a tank
// choice is judged from the stage above it.
function slotIssues(build, catalog, kind, i, { relationOnly = false } = {}) {
  const out = [];
  const add = (level, reason) => out.push({ level, reason });
  if (kind === "payload") {
    const p = byId(catalog.payloads, build.payloadId);
    const top = build.stages.length ? resolve(build, catalog, build.stages.length - 1).tank : undefined;
    if (p && top && p.diameter_m > WIDER_INCOMPATIBLE * top.diameter_m) add("incompatible", `${m(p.diameter_m)} m payload on a ${m(top.diameter_m)} m stage`);
    return out;
  }
  const r = resolve(build, catalog, i);
  if (!r) return out;
  const { engine: e, tank: t } = r;
  if (kind === "engines") {
    if (e && t && e.propellant !== t.propellant) add("incompatible", `${e.propellant} engine on a ${t.propellant} tank`);
    if (i === 0 && e && isVacuumOnly(e)) add("incompatible", "vacuum engine cannot light at sea level");
    if (e && t && tooWide(t, e)) add("incompatible", noFit(catalog, t, e));
    else if (e && t && tooMany(r.stage, e, t)) add("incompatible", tooManyReason(r.stage, e, t));
    if (i > 0 && e && isSeaLevelEngine(e)) add("unusual", "sea-level engine used in vacuum");
    return out;
  }
  // tank
  if (!relationOnly && e && t && e.propellant !== t.propellant) add("incompatible", `${t.propellant} tank for a ${e.propellant} engine`);
  if (!relationOnly && e && t && tooWide(t, e)) add("incompatible", noFit(catalog, t, e));
  else if (!relationOnly && e && t && tooMany(r.stage, e, t)) add("incompatible", tooManyReason(r.stage, e, t));
  const below = i > 0 ? resolve(build, catalog, i - 1).tank : undefined;
  if (t && below) {
    const ratio = t.diameter_m / below.diameter_m;
    if (ratio > WIDER_INCOMPATIBLE) add("incompatible", `${m(t.diameter_m)} m stage on a ${m(below.diameter_m)} m stage`);
    else if (ratio > WIDER_UNUSUAL) add("unusual", "wider than the stage below");
    if (t.propellantMass_kg > below.propellantMass_kg) add("unusual", "upper stage heavier than the stage below");
  }
  return out;
}

function summarize(issues) {
  const seen = new Set();
  const uniq = issues.filter((x) => !seen.has(x.reason) && seen.add(x.reason));
  uniq.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const level = uniq.reduce((lv, x) => (RANK[x.level] > RANK[lv] ? x.level : lv), "ok");
  return { level, reasons: uniq.map((x) => x.reason) };
}

// What choosing `record` for the slot would mean. The candidate build is made with catalog.applyOption (the
// same call the UI makes, which keeps the engine count); re-choosing the current record changes nothing and
// reports the slot as it is. Only the slots the choice touches are judged:
// an engine choice -> that engine; a tank choice -> that tank, plus the stage above it and, for the top stage,
// the payload; a payload choice -> the payload.
export function checkOption(build, catalog, kind, stageIndex, record) {
  const k = KIND[kind];
  if (!k || !record) return { level: "ok", reasons: [] };
  const next = applyOption(build, k, stageIndex, record.id);
  const issues = [];
  if (k === "payload") {
    issues.push(...slotIssues(next, catalog, "payload", null));
    return summarize(issues);
  }
  if (!next.stages[stageIndex]) return { level: "ok", reasons: [] };
  if (k === "engines") {
    issues.push(...slotIssues(next, catalog, "engines", stageIndex));
  } else {
    issues.push(...slotIssues(next, catalog, "tank", stageIndex));
    if (stageIndex + 1 < next.stages.length) {
      // The stage above is judged against the new tank; its reasons name that stage, so say which.
      for (const x of slotIssues(next, catalog, "tank", stageIndex + 1, { relationOnly: true })) issues.push({ level: x.level, reason: `stage ${stageIndex + 2}: ${x.reason}` });
    } else {
      issues.push(...slotIssues(next, catalog, "payload", null));
    }
  }
  return summarize(issues);
}

// The slot's options (optionsFor order) with their verdicts: ok first, then unusual, then incompatible.
export function optionsWithCompat(build, catalog, kind, stageIndex) {
  const rows = optionsFor(kind, build, stageIndex).map((record, i) => ({ record, i, ...checkOption(build, catalog, kind, stageIndex, record) }));
  rows.sort((a, b) => RANK[a.level] - RANK[b.level] || a.i - b.i);
  return rows.map(({ record, level, reasons }) => ({ record, level, reasons }));
}

// Every slot of a build as it stands: engines and tank per stage (bottom first), then the payload.
export function checkBuild(build, catalog) {
  const out = [];
  build.stages.forEach((_, i) => {
    for (const kind of ["engines", "tank"]) out.push({ kind, stageIndex: i, ...summarize(slotIssues(build, catalog, kind, i)) });
  });
  out.push({ kind: "payload", stageIndex: null, ...summarize(slotIssues(build, catalog, "payload", null)) });
  return out;
}
