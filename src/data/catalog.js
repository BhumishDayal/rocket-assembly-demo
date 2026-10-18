// The demo's dataset. engines/tanks/payloads/missions/reference-rockets.json are verbatim copies of
// SpaxeX/src/data/*.json (branch phase1_bhumish); refresh them by copying, never by hand-editing.
// payloads.extra.json holds demo-only payload records in the same shape; visuals.json holds sourced visual
// facts (engine lengths, finishes, features, payload archetypes); presets.json holds the buildable vehicles.
// gcat-rockets.json is the GCAT pool for the twin compare (closestRockets; see the note there for P2).
import engines from "./engines.json";
import tanks from "./tanks.json";
import basePayloads from "./payloads.json";
import extraPayloads from "./payloads.extra.json";
import missions from "./missions.json";
import referenceRockets from "./reference-rockets.json";
import visuals from "./visuals.json";
import presets from "./presets.json";
import gcat from "./gcat-rockets.json";
import { evaluateBuild, isVacuumOnly, rocketDistance, sanitizeEngineCount } from "../physics.js";

// Base + extra payloads, one record per id: the team's payloads.json now carries apollo-csm-lm too, so a refresh
// must not list it twice. The base (team) record wins.
const payloads = [...basePayloads, ...extraPayloads.filter((x) => !basePayloads.some((p) => p.id === x.id))];

export const catalog = {
  engines,
  tanks,
  payloads,
  missions,
  referenceRockets,
  visuals,
  presets,
};

export const byId = (list, id) => list.find((x) => x.id === id);

// Display order for [ / ] switching; falcon-9 first.
export const presetIds = ["falcon-9", "saturn-v", "atlas-v-401", "delta-iv-m", "demo-build"];

export function getPreset(id) {
  return byId(presets, id);
}

// Livery is part of the team's BuildState but the demo's look comes from visuals.json; this is a neutral default.
const DEFAULT_LIVERY = { primary: "#ffffff", accent: "#111111", stripe: false, patch: null };

// Preset -> the team app's BuildState (the object evaluateBuild takes). Strips the per-stage source notes.
export function presetToBuild(preset) {
  return {
    missionId: preset.missionId,
    stages: preset.stages.map(({ engineId, engineCount, tankId }) => ({ engineId, engineCount, tankId })),
    payloadId: preset.payloadId,
    livery: { ...DEFAULT_LIVERY },
  };
}

// --- slots: every part can be swapped for another record of its kind -------------------------------------
// kind: "engines" | "tank" | "payload" (singular/plural both accepted). Other kinds (interstage, fairing) are
// derived structures with no records: no options, and applyOption leaves the build as it is.
const KIND = { engine: "engines", engines: "engines", tank: "tank", tanks: "tank", payload: "payload", payloads: "payload" };

const byNumberThenName = (value) => (a, b) => value(a) - value(b) || a.name.localeCompare(b.name);
const engineThrust = (e) => (isVacuumOnly(e) ? e.thrustVac_kN : e.thrustSL_kN);

// All records for a slot, ascending: engines sea-level first then vacuum-only, each by thrust (SL thrust for
// sea-level engines, vacuum thrust for vacuum-only); tanks by propellant mass; payloads (base + extra) by mass.
// build/stageIndex are accepted for the slot's context but do not filter: mismatches are the physics' job.
export function optionsFor(kind, build, stageIndex) {
  switch (KIND[kind]) {
    case "engines":
      return [...catalog.engines].sort(
        (a, b) => isVacuumOnly(a) - isVacuumOnly(b) || byNumberThenName(engineThrust)(a, b),
      );
    case "tank":
      return [...catalog.tanks].sort(byNumberThenName((t) => t.propellantMass_kg));
    case "payload":
      return [...catalog.payloads].sort(byNumberThenName((p) => p.mass_kg));
    default:
      return [];
  }
}

// A NEW BuildState with recordId swapped into the slot. The stage's engineCount is kept (only cleaned by
// physics.sanitizeEngineCount), as the team app's applySuggestion does since #20: if more engines than the new
// engine/tank pair fits remain, the verdict blocks the build with the "engines don't fit" warning, and compat.js
// marks that option incompatible with the same words. Picking the record that is already there returns an
// unchanged copy. Unknown record ids or stage indices also return an unchanged copy.
export function applyOption(build, kind, stageIndex, recordId) {
  const next = {
    ...build,
    stages: build.stages.map((s) => ({ ...s })),
    livery: build.livery ? { ...build.livery } : build.livery,
  };
  const k = KIND[kind];
  if (k === "payload") {
    if (byId(catalog.payloads, recordId)) next.payloadId = recordId;
    return next;
  }
  const stage = next.stages[stageIndex];
  if (!stage || (k !== "engines" && k !== "tank")) return next;
  const field = k === "engines" ? "engineId" : "tankId";
  if (stage[field] === recordId || !byId(k === "engines" ? catalog.engines : catalog.tanks, recordId)) return next;
  stage[field] = recordId;
  stage.engineCount = sanitizeEngineCount(stage.engineCount);
  return next;
}

// --- twin: the closest real rocket from the GCAT pool --------------------------------------------------------
// gcat-rockets.json: GCAT launch vehicles (J. McDowell, CC BY 4.0; attribution in gcatSource) that flew at least
// once and have a length and diameter, so a true-scale silhouette can be drawn.
export const gcatRockets = gcat.rockets;
export const gcatSource = gcat._source;

// The n GCAT rockets nearest to the build: physics.rocketDistance (log liftoff mass, log liftoff thrust; the
// build's mass and thrust are evaluateBuild's, i.e. est.) plus, by default, two corrections:
//   diameter: a log-diameter term (widest stage tank vs the rocket's diameter);
//   preferReference: GCAT rows that are the same vehicle as a reference-rockets.json record (referenceId:
//     Falcon 9 FT5, Falcon Heavy) match on that record's manufacturer liftoff mass and thrust instead of GCAT's.
// Pass { diameter: false, preferReference: false } for the app's plain formula.
// P2 evidence: the app's closest-rocket formula (mass + thrust only, closest.ts) picks Zhuque-3 for a Falcon 9
// built from SpaceX's own numbers (550 t, 7,605 kN), because GCAT's Falcon 9 FT5 row is 480 t / 5,886 kN
// (SpaceX: 549 t / 7,607 kN); it also picks Chang Zheng 4B over Delta 4M for the Delta IV preset. The twin
// lookup needs a diameter term or manufacturer-consistent numbers (scripts/check-twin.mjs --app-formula).
// Rows with the same name and the same numbers (e.g. Falcon 9 FT3 / FT4, identical in GCAT) collapse to the
// most-launched one; ties go to more launches.
export function closestRockets(build, n = 3, { diameter = true, preferReference = true } = {}) {
  const v = evaluateBuild(build, catalog);
  const mass = v.totalMass_kg;
  const thrust = v.liftoffThrust_kN;
  if (!(mass > 0) || !(thrust > 0)) return [];
  const widest = Math.max(0, ...build.stages.map((s) => byId(tanks, s.tankId)?.diameter_m ?? 0));
  const rows = [];
  for (const rocket of gcatRockets) {
    const ref = preferReference && rocket.referenceId ? byId(referenceRockets, rocket.referenceId) : null;
    const m = ref?.liftoffMass_kg ?? rocket.liftoffMass_kg;
    const t = ref?.liftoffThrust_kN ?? rocket.liftoffThrust_kN;
    if (!(m > 0) || !(t > 0)) continue;
    let d = rocketDistance(mass, thrust, { liftoffMass_kg: m, liftoffThrust_kN: t });
    if (diameter && widest > 0 && rocket.diameter_m > 0) d = Math.hypot(d, Math.log(widest / rocket.diameter_m));
    rows.push({ rocket, distance: d, key: `${rocket.name}|${m}|${t}|${rocket.diameter_m}` });
  }
  rows.sort((a, b) => a.distance - b.distance || b.rocket.launches - a.rocket.launches || a.rocket.name.localeCompare(b.rocket.name));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push({ rocket: r.rocket, distance: r.distance, verdictMass_kg: mass, verdictThrust_kN: thrust });
    if (out.length >= n) break;
  }
  return out;
}

// "Falcon 9 (FT5) · 68.4 m · 630 launches, 1 failure (2018–2026)": per GCAT row (variants are counted
// separately). Only GCAT facts, so no "est."; a line that also shows the build's own numbers must label those.
export function twinLine(rocket) {
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const years = rocket.firstLaunchYear === rocket.lastLaunchYear ? `${rocket.firstLaunchYear}` : `${rocket.firstLaunchYear}–${rocket.lastLaunchYear}`;
  const name = rocket.variant ? `${rocket.name} (${rocket.variant})` : rocket.name;
  return `${name} · ${rocket.length_m} m · ${plural(rocket.launches, "launch", "launches")}, ${plural(rocket.failures, "failure", "failures")} (${years})`;
}
