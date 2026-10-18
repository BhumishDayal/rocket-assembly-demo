// Golden check for src/physics.js: the JS port must reproduce the team app's TypeScript physics exactly.
// Run: node scripts/check-physics.mjs   (no deps; exits 1 on any mismatch)
//
// GOLDEN below was produced by running the team's TypeScript unmodified: verbatim copies of
// SpaxeX/src/lib/physics/{catalog,closest,deltav,feasibility,twr}.ts, src/types/index.ts and src/data/*
// (branch phase1_bhumish @ 1007b3b), executed with `npx -y tsx` (tsx 4.23.15, node v24.18.0) on every
// preset in src/data/presets.json and on EDGE_BUILDS, with the demo's payloads.extra.json appended to the
// payloads exactly as catalog.js does. Generated 2026-10-17. Regenerate after any change to the TS physics, the
// data or the presets (the generator lives outside this repo; ask harvard-space-9d).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clampEngineCount, evaluateBuild, maxEngineCount, rocketDistance, stageDetails, stackMass_kg } from "../src/physics.js";

const REL_TOL = 1e-6;
const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
const read = (f) => JSON.parse(readFileSync(join(dataDir, f), "utf8"));

// Same assembly as src/data/catalog.js (node cannot import bare JSON, so it is read here).
const catalog = {
  engines: read("engines.json"),
  tanks: read("tanks.json"),
  payloads: [...read("payloads.json"), ...read("payloads.extra.json")],
  missions: read("missions.json"),
  referenceRockets: read("reference-rockets.json"),
};
const presets = read("presets.json");
const livery = { primary: "#ffffff", accent: "#111111", stripe: false, patch: null };
const toBuild = (p) => ({
  missionId: p.missionId,
  payloadId: p.payloadId,
  livery,
  stages: p.stages.map(({ engineId, engineCount, tankId }) => ({ engineId, engineCount, tankId })),
});

// Edge builds (not presets) that exercise every rule branch; same TS run.
const EDGE_BUILDS = {
  "empty": {"missionId": "", "payloadId": "", "stages": []},
  "unknown-ids": {"missionId": "nowhere", "payloadId": "ghost", "stages": [{"engineId": "nope", "engineCount": 1, "tankId": "falcon9-s1-tank"}, {"engineId": "merlin-1d", "engineCount": 1, "tankId": ""}]},
  "vac-on-stage0-mismatch": {"missionId": "leo", "payloadId": "", "stages": [{"engineId": "merlin-1d-vac", "engineCount": 1, "tankId": "saturn-v-s-ii-tank"}]},
  "twr-below-1": {"missionId": "leo", "payloadId": "hubble", "stages": [{"engineId": "merlin-1d", "engineCount": 1, "tankId": "falcon9-s1-tank"}]},
  "no-mission": {"missionId": "", "payloadId": "nova-c", "stages": [{"engineId": "rd-180", "engineCount": 1, "tankId": "atlas-v-ccb-tank"}, {"engineId": "rl10c-1-1", "engineCount": 1, "tankId": "centaur-iii-tank"}]},
  "two-dry-rule-hits": {"missionId": "lunar-orbit", "payloadId": "jwst", "stages": [{"engineId": "rs-25", "engineCount": 4, "tankId": "shuttle-et-tank"}, {"engineId": "merlin-1d-vac", "engineCount": 1, "tankId": "falcon9-s2-tank"}]},
  "zero-engines": {"missionId": "mars-transfer", "payloadId": "", "stages": [{"engineId": "rs-25", "engineCount": 0, "tankId": "sls-core-tank"}, {"engineId": "rl10b-2", "engineCount": 1, "tankId": "icps-tank"}]},
};

const GOLDEN = {
  "falcon-9": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 282, "startMass_kg": 549939, "endMass_kg": 140356, "deltaV_ms": 3776.603066137006},
      {"stageIndex": 1, "ispUsed_s": 348, "startMass_kg": 114756, "endMass_kg": 9092, "deltaV_ms": 8652.640730039622},
    ],
    "totalDeltaV_ms": 12429.243796176628,
    "requiredDeltaV_ms": 11900,
    "marginDeltaV_ms": 529.2437961766282,
    "liftoffTWR": 1.4101458161172684,
    "deltaVOk": true,
    "twrOk": true,
    "feasible": false,
    "totalMass_kg": 549939,
    "liftoffThrust_kN": 7605,
    "closestRocketId": "falcon-9",
    "warnings": ["tank dry mass below 4 percent of propellant"],
  },
  "saturn-v": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 260, "startMass_kg": 2919673.3000000003, "endMass_kg": 773875.3000000003, "deltaV_ms": 3385.5716144478206},
      {"stageIndex": 1, "ispUsed_s": 424, "startMass_kg": 643453.4, "endMass_kg": 200218.40000000002, "deltaV_ms": 4854.2418828840255},
      {"stageIndex": 2, "ispUsed_s": 424, "startMass_kg": 164060.7, "endMass_kg": 56965.70000000001, "deltaV_ms": 4398.299698067984},
    ],
    "totalDeltaV_ms": 12638.11319539983,
    "requiredDeltaV_ms": 12600,
    "marginDeltaV_ms": 38.11319539983015,
    "liftoffTWR": 1.1822697260517419,
    "deltaVOk": true,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 2919673.3000000003,
    "liftoffThrust_kN": 33851,
    "closestRocketId": "saturn-v",
    "warnings": ["liftoff TWR below 1.2"],
  },
  "atlas-v-401": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 311.9, "startMass_kg": 333408, "endMass_kg": 49319, "deltaV_ms": 5845.340559257165},
      {"stageIndex": 1, "ispUsed_s": 449.7, "startMass_kg": 28265, "endMass_kg": 7435, "deltaV_ms": 5889.294827724242},
    ],
    "totalDeltaV_ms": 11734.635386981408,
    "requiredDeltaV_ms": 11900,
    "marginDeltaV_ms": -165.36461301859163,
    "liftoffTWR": 1.170351659402696,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 333408,
    "liftoffThrust_kN": 3826.6,
    "closestRocketId": "falcon-9",
    "warnings": ["liftoff TWR below 1.2"],
  },
  "delta-iv-m": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 362, "startMass_kg": 258998, "endMass_kg": 59358, "deltaV_ms": 5229.989445633722},
      {"stageIndex": 1, "ispUsed_s": 465.5, "startMass_kg": 32598, "endMass_kg": 5398, "deltaV_ms": 8208.877400216214},
    ],
    "totalDeltaV_ms": 13438.866845849936,
    "requiredDeltaV_ms": 12600,
    "marginDeltaV_ms": 838.866845849936,
    "liftoffTWR": 1.2346929489412208,
    "deltaVOk": true,
    "twrOk": true,
    "feasible": true,
    "totalMass_kg": 258998,
    "liftoffThrust_kN": 3136,
    "closestRocketId": "falcon-9",
    "warnings": [],
  },
  "demo-build": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 282, "startMass_kg": 472073, "endMass_kg": 62490, "deltaV_ms": 5592.142522799266},
      {"stageIndex": 1, "ispUsed_s": 465.5, "startMass_kg": 36890, "endMass_kg": 9690, "deltaV_ms": 6102.696465703547},
    ],
    "totalDeltaV_ms": 11694.838988502812,
    "requiredDeltaV_ms": 12600,
    "marginDeltaV_ms": -905.1610114971882,
    "liftoffTWR": 1.6427420758435973,
    "deltaVOk": false,
    "twrOk": true,
    "feasible": false,
    "totalMass_kg": 472073,
    "liftoffThrust_kN": 7605,
    "closestRocketId": "falcon-9",
    "warnings": [],
  },
};

const EDGE_GOLDEN = {
  "empty": {
    "stages": [],
    "totalDeltaV_ms": 0,
    "requiredDeltaV_ms": 0,
    "marginDeltaV_ms": 0,
    "liftoffTWR": 0,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 0,
    "liftoffThrust_kN": 0,
    "closestRocketId": "",
    "warnings": ["empty build"],
  },
  "unknown-ids": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 0, "startMass_kg": 0, "endMass_kg": -409583, "deltaV_ms": 0},
      {"stageIndex": 1, "ispUsed_s": 311, "startMass_kg": 0, "endMass_kg": 0, "deltaV_ms": 0},
    ],
    "totalDeltaV_ms": 0,
    "requiredDeltaV_ms": 0,
    "marginDeltaV_ms": 0,
    "liftoffTWR": 0,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 0,
    "liftoffThrust_kN": 0,
    "closestRocketId": "",
    "warnings": ["unknown mission id: nowhere", "unknown payload id: ghost", "unknown engine id: nope", "unknown tank id: 1", "liftoff TWR below 1.0"],
  },
  "vac-on-stage0-mismatch": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 0, "startMass_kg": 471990.2, "endMass_kg": 28755.20000000001, "deltaV_ms": 0},
    ],
    "totalDeltaV_ms": 0,
    "requiredDeltaV_ms": 9400,
    "marginDeltaV_ms": -9400,
    "liftoffTWR": 0,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 471990.2,
    "liftoffThrust_kN": 0,
    "closestRocketId": "",
    "warnings": ["engine and tank propellant differ", "vacuum-only engine on stage 0", "liftoff TWR below 1.0"],
  },
  "twr-below-1": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 282, "startMass_kg": 442331.4, "endMass_kg": 32748.400000000023, "deltaV_ms": 7199.099872159322},
    ],
    "totalDeltaV_ms": 7199.099872159322,
    "requiredDeltaV_ms": 9400,
    "marginDeltaV_ms": -2200.9001278406777,
    "liftoffTWR": 0.19479969090287266,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 442331.4,
    "liftoffThrust_kN": 845,
    "closestRocketId": "falcon-9",
    "warnings": ["liftoff TWR below 1.0"],
  },
  "no-mission": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 311.9, "startMass_kg": 330121.7, "endMass_kg": 46032.70000000001, "deltaV_ms": 6025.9619473330185},
      {"stageIndex": 1, "ispUsed_s": 453.8, "startMass_kg": 24978.7, "endMass_kg": 4148.700000000001, "deltaV_ms": 7989.229267544591},
    ],
    "totalDeltaV_ms": 14015.19121487761,
    "requiredDeltaV_ms": 0,
    "marginDeltaV_ms": 14015.19121487761,
    "liftoffTWR": 1.1820022920581532,
    "deltaVOk": false,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 330121.7,
    "liftoffThrust_kN": 3826.6,
    "closestRocketId": "falcon-9",
    "warnings": ["liftoff TWR below 1.2"],
  },
  "two-dry-rule-hits": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 366, "startMass_kg": 882333.2, "endMass_kg": 156812.19999999995, "deltaV_ms": 6200.476402918371},
      {"stageIndex": 1, "ispUsed_s": 348, "startMass_kg": 115764, "endMass_kg": 10100, "deltaV_ms": 8323.672086591943},
    ],
    "totalDeltaV_ms": 14524.148489510313,
    "requiredDeltaV_ms": 13500,
    "marginDeltaV_ms": 1024.148489510313,
    "liftoffTWR": 0.859566579342661,
    "deltaVOk": true,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 882333.2,
    "liftoffThrust_kN": 7437.6,
    "closestRocketId": "falcon-9",
    "warnings": ["tank dry mass below 4 percent of propellant", "tank dry mass below 4 percent of propellant", "liftoff TWR below 1.0"],
  },
  "zero-engines": {
    "stages": [
      {"stageIndex": 0, "ispUsed_s": 366, "startMass_kg": 1104049.3, "endMass_kg": 116578.30000000005, "deltaV_ms": 8069.232137485874},
      {"stageIndex": 1, "ispUsed_s": 465.5, "startMass_kg": 32748, "endMass_kg": 3800, "deltaV_ms": 9832.273834383548},
    ],
    "totalDeltaV_ms": 17901.50597186942,
    "requiredDeltaV_ms": 13200,
    "marginDeltaV_ms": 4701.505971869421,
    "liftoffTWR": 0,
    "deltaVOk": true,
    "twrOk": false,
    "feasible": false,
    "totalMass_kg": 1104049.3,
    "liftoffThrust_kN": 0,
    "closestRocketId": "",
    "warnings": ["liftoff TWR below 1.0"],
  },
};

// Per preset: TS rocketDistance to every reference rocket, and per stage
// [maxEngineCount, clampEngineCount(12), clampEngineCount(2.6)].
const EXTRA_GOLDEN = {
  "falcon-9": {"distances": {"falcon-9": 0.00163188988489616, "falcon-heavy": 1.4519772928281733, "saturn-v": 2.2216172766925903, "starship": 3.2996053885074157, "sls-block-1": 2.213950727616384}, "fit": [[9, 9, 3], [1, 1, 1]]},
  "saturn-v": {"distances": {"falcon-9": 2.240779187290936, "falcon-heavy": 0.8211615170510791, "saturn-v": 0.045959391113575845, "starship": 1.0761525724441794, "sls-block-1": 0.14175469217533956}, "fit": [[4, 4, 3], [9, 9, 3], [6, 6, 3]]},
  "atlas-v-401": {"distances": {"falcon-9": 0.849074134909368, "falcon-heavy": 2.2999494674257304, "saturn-v": 3.0600558115218357, "starship": 4.142535926151651, "sls-block-1": 3.056967160609642}, "fit": [[1, 1, 1], [2, 2, 2]]},
  "delta-iv-m": {"distances": {"falcon-9": 1.16179886659054, "falcon-heavy": 2.6145975683636196, "saturn-v": 3.378978671571182, "starship": 4.460263476060711, "sls-block-1": 3.3745063488259093}, "fit": [[2, 2, 2], [3, 3, 3]]},
  "demo-build": {"distances": {"falcon-9": 0.1510633915384269, "falcon-heavy": 1.5560754431725272, "saturn-v": 2.335779556634012, "starship": 3.407906594497478, "sls-block-1": 2.323700513721025}, "fit": [[9, 9, 3], [3, 3, 3]]},
};

// TS maxEngineCount for every tank (row) x every engine (column, engines.json order).
const FIT_GOLDEN = {
  "falcon9-s1-tank": [9, 1, 1, 3, 3, 1, 1, 2, 1, 1, 1],
  "falcon9-s2-tank": [9, 1, 1, 3, 3, 1, 1, 2, 1, 1, 1],
  "centaur-iii-tank": [6, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1],
  "saturn-v-s-ic-tank": [9, 5, 9, 9, 9, 9, 4, 9, 5, 9, 9],
  "saturn-v-s-ii-tank": [9, 5, 9, 9, 9, 9, 4, 9, 5, 9, 9],
  "saturn-v-s-ivb-tank": [9, 2, 5, 9, 9, 5, 2, 6, 2, 5, 4],
  "atlas-v-ccb-tank": [9, 1, 1, 4, 3, 1, 1, 2, 1, 1, 1],
  "sls-core-tank": [9, 3, 8, 9, 9, 9, 3, 9, 4, 9, 7],
  "icps-tank": [9, 1, 2, 7, 6, 3, 1, 4, 1, 3, 2],
  "delta-iv-cbc-tank": [9, 1, 2, 7, 6, 3, 1, 3, 1, 3, 2],
  "dcss-5m-tank": [9, 1, 2, 7, 6, 3, 1, 3, 1, 3, 2],
  "shuttle-et-tank": [9, 3, 8, 9, 9, 9, 3, 9, 4, 9, 7],
};

const failures = [];
const close = (a, b) => a === b || Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
function compare(path, got, want) {
  if (typeof want === "number") {
    if (typeof got !== "number" || !close(got, want)) failures.push(`${path}: got ${got}, want ${want}`);
  } else if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) {
      failures.push(`${path}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      return;
    }
    want.forEach((w, i) => compare(`${path}[${i}]`, got[i], w));
  } else if (want && typeof want === "object") {
    const keys = new Set([...Object.keys(want), ...Object.keys(got ?? {})]);
    for (const k of keys) {
      if (!(k in want)) failures.push(`${path}.${k}: unexpected field`);
      else compare(`${path}.${k}`, got?.[k], want[k]);
    }
  } else if (got !== want) {
    failures.push(`${path}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const presetIds = presets.map((p) => p.id);
for (const id of Object.keys(GOLDEN)) if (!presetIds.includes(id)) failures.push(`${id}: in GOLDEN but not in presets.json`);

for (const preset of presets) {
  const want = GOLDEN[preset.id];
  if (!want) {
    failures.push(`${preset.id}: no golden (regenerate GOLDEN)`);
    continue;
  }
  const build = toBuild(preset);
  const v = evaluateBuild(build, catalog);
  compare(preset.id, v, want);

  // The extras must agree with the verdict they are derived from.
  const d = stageDetails(build, catalog);
  d.forEach((s, i) => {
    compare(`${preset.id}.details[${i}].deltaV_ms`, s.deltaV_ms, v.stages[i].deltaV_ms);
    compare(`${preset.id}.details[${i}].startMass_kg`, s.startMass_kg, v.stages[i].startMass_kg);
  });
  const perStage = d.flatMap((s) => s.warnings);
  const global = v.warnings.filter((w) => /^unknown (mission|payload) id:/.test(w));
  compare(`${preset.id}.details.warnings`, [...perStage].sort(), v.warnings.filter((w) => !global.includes(w)).sort());
  const all = stackMass_kg(build, catalog, { stages: build.stages.map((_, i) => i), payload: true });
  compare(`${preset.id}.stackMass_kg(all)`, all, v.totalMass_kg);

  const x = EXTRA_GOLDEN[preset.id];
  for (const ref of catalog.referenceRockets) {
    compare(`${preset.id}.distance.${ref.id}`, rocketDistance(v.totalMass_kg, v.liftoffThrust_kN, ref), x.distances[ref.id]);
  }
  build.stages.forEach((s, i) => {
    const e = catalog.engines.find((r) => r.id === s.engineId);
    const k = catalog.tanks.find((r) => r.id === s.tankId);
    compare(`${preset.id}.fit[${i}]`, [maxEngineCount(k.diameter_m, e.diameter_m), clampEngineCount(12, k, e), clampEngineCount(2.6, k, e)], x.fit[i]);
    compare(`${preset.id}.details[${i}].fitMaxEngines`, d[i].fitMaxEngines, x.fit[i][0]);
  });

  const t = (x) => Math.round(x).toLocaleString("en-US");
  console.log(
    `${preset.id.padEnd(12)} dv ${t(v.totalDeltaV_ms)} / ${t(v.requiredDeltaV_ms)} m/s (margin ${t(v.marginDeltaV_ms)})` +
      `  TWR ${v.liftoffTWR.toFixed(3)}  mass ${t(v.totalMass_kg)} kg  feasible ${v.feasible}` +
      `  closest ${v.closestRocketId}  warnings ${JSON.stringify(v.warnings)}`,
  );
}

for (const [id, b] of Object.entries(EDGE_BUILDS)) {
  const build = { ...b, livery };
  compare(`edge:${id}`, evaluateBuild(build, catalog), EDGE_GOLDEN[id]);
  const v = EDGE_GOLDEN[id];
  if (build.stages.length) {
    const perStage = stageDetails(build, catalog).flatMap((s) => s.warnings);
    const global = v.warnings.filter((w) => /^unknown (mission|payload) id:/.test(w));
    compare(`edge:${id}.details.warnings`, [...perStage].sort(), v.warnings.filter((w) => !global.includes(w)).sort());
  }
}
for (const k of catalog.tanks) {
  compare(`fit.${k.id}`, catalog.engines.map((e) => maxEngineCount(k.diameter_m, e.diameter_m)), FIT_GOLDEN[k.id]);
}
console.log(`edge builds: ${Object.keys(EDGE_BUILDS).length} checked`);

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} mismatch(es)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`\nOK: physics.js matches the TypeScript goldens for ${presets.length} presets and ${Object.keys(EDGE_BUILDS).length} edge builds (rel tol ${REL_TOL}).`);
