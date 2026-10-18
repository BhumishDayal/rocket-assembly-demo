// The demo's dataset. engines/tanks/payloads/missions/reference-rockets.json are verbatim copies of
// SpaxeX/src/data/*.json (branch phase1_bhumish); refresh them by copying, never by hand-editing.
// payloads.extra.json holds demo-only payload records in the same shape; visuals.json holds sourced visual
// facts (engine lengths, finishes, features, payload archetypes); presets.json holds the buildable vehicles.
import engines from "./engines.json";
import tanks from "./tanks.json";
import basePayloads from "./payloads.json";
import extraPayloads from "./payloads.extra.json";
import missions from "./missions.json";
import referenceRockets from "./reference-rockets.json";
import visuals from "./visuals.json";
import presets from "./presets.json";
import { clampEngineCount, isVacuumOnly } from "../physics.js";

export const catalog = {
  engines,
  tanks,
  payloads: [...basePayloads, ...extraPayloads],
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

// A NEW BuildState with recordId swapped into the slot. The stage's engineCount is kept, clamped with
// physics.clampEngineCount for the new engine/tank pair (the app's fit rule). Picking the record that is
// already there returns an unchanged copy, so re-selecting never clamps a real vehicle (e.g. 5 F-1 on the
// S-IC, where the fit rule allows 4). Unknown record ids or stage indices also return an unchanged copy.
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
  stage.engineCount = clampEngineCount(
    stage.engineCount,
    byId(catalog.tanks, stage.tankId),
    byId(catalog.engines, stage.engineId),
  );
  return next;
}
