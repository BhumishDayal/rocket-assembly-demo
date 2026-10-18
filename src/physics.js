// Port of the team app's physics: SpaxeX/src/lib/physics/{deltav,twr,closest,feasibility}.ts (main @ e7600da,
// after #20), same names, same math, same warning strings. Plain JS, no imports, so node can run it
// (scripts/check-physics.mjs compares it to golden numbers from the TypeScript). Keep it in step with the TS:
// change the TS first, then port, then refresh the goldens.
// The demo extras at the bottom (mass flow, burn time, stage details, stack mass) are standard formulas on the
// same fields; label them "est." on screen.

// --- deltav.ts --------------------------------------------------------------------------------------------
export const G0 = 9.80665;

export const stageMass_kg = (engine, engineCount, tank) =>
  engineCount * engine.mass_kg + tank.dryMass_kg + tank.propellantMass_kg;

export const rocketEquationDeltaV_ms = (isp_s, startMass_kg, endMass_kg) => {
  if (isp_s <= 0 || startMass_kg <= 0 || endMass_kg <= 0 || startMass_kg <= endMass_kg) {
    return 0;
  }
  return isp_s * G0 * Math.log(startMass_kg / endMass_kg);
};

export const ispForStage_s = (engine, stageIndex) => (stageIndex === 0 ? engine.ispSL_s : engine.ispVac_s);

// --- twr.ts -----------------------------------------------------------------------------------------------
export const liftoffTWR = (engine, engineCount, startMass_kg) => {
  if (startMass_kg <= 0) {
    return 0;
  }
  return (engineCount * engine.thrustSL_kN * 1000) / (startMass_kg * G0);
};

export const liftoffThrust_kN = (engine, engineCount) => engineCount * engine.thrustSL_kN;

// --- closest.ts -------------------------------------------------------------------------------------------
export const rocketDistance = (buildMass_kg, buildThrust_kN, ref) => {
  const lnMass = Math.log(buildMass_kg / ref.liftoffMass_kg);
  const lnThrust = Math.log(buildThrust_kN / ref.liftoffThrust_kN);
  return Math.sqrt(lnMass * lnMass + lnThrust * lnThrust);
};

export const closestRocketId = (buildMass_kg, buildThrust_kN, refs) => {
  if (buildMass_kg <= 0 || buildThrust_kN <= 0 || refs.length === 0) {
    return "";
  }
  let bestId = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ref of refs) {
    if (ref.liftoffMass_kg <= 0 || ref.liftoffThrust_kN <= 0) {
      continue;
    }
    const d = rocketDistance(buildMass_kg, buildThrust_kN, ref);
    if (d < bestDistance) {
      bestDistance = d;
      bestId = ref.id;
    }
  }
  return bestId;
};

// --- catalog.ts -------------------------------------------------------------------------------------------
const byId = (items, id) => items.find((item) => item.id === id);

// --- feasibility.ts ---------------------------------------------------------------------------------------
export const RULES = {
  TWR_OK: 1.2,
  TWR_BLOCKING: 1.0,
  DRY_MASS_MIN_FRACTION: 0.04,
  MAX_ENGINE_COUNT: 9,
  // Spec: tune so a 3.66 m tank + Merlin = 9. 0.62 also fits the real Saturn V S-IC's 5 F-1s (0.6 allowed 4).
  ENGINE_FIT_FACTOR: 0.62,
};
const { TWR_OK, TWR_BLOCKING, DRY_MASS_MIN_FRACTION, MAX_ENGINE_COUNT, ENGINE_FIT_FACTOR } = RULES;

export const maxEngineCount = (tankDiameter_m, engineDiameter_m) => {
  if (engineDiameter_m <= 0 || tankDiameter_m <= 0) {
    return 1;
  }
  const fit = Math.floor(ENGINE_FIT_FACTOR * (tankDiameter_m / engineDiameter_m) ** 2);
  return Math.max(1, Math.min(MAX_ENGINE_COUNT, fit));
};

// Cleans nonsense input only (NaN, fractions, < 1, > 9). Too many engines for the tank is left in the build,
// so the verdict can block it with a reason the advisor explains.
export const sanitizeEngineCount = (n) => {
  const rounded = Number.isFinite(n) ? Math.round(n) : 1;
  return Math.max(1, Math.min(MAX_ENGINE_COUNT, rounded));
};

const isValidEngineCount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_ENGINE_COUNT;

export const tooManyEnginesWarning = (count, engine, tank, fit) =>
  `${count} ${engine.name} engines don't fit a ${tank.diameter_m} m wide ${tank.name}: max ${fit}`;

export const isVacuumOnly = (engine) => engine.thrustSL_kN <= 0 || engine.ispSL_s <= 0;

// The per-stage blocking rules of evaluateBuild, in the TS order. Factored out (not changed) so stageDetails
// can attach each warning to the stage it hit.
const stageRuleWarnings = (stage, stageIndex, engine, tank) => {
  const out = [];
  if (!stage.engineId || !engine) {
    out.push(`unknown engine id: ${stage.engineId || stageIndex}`);
  }
  if (!stage.tankId || !tank) {
    out.push(`unknown tank id: ${stage.tankId || stageIndex}`);
  }
  if (engine && tank && engine.propellant !== tank.propellant) {
    out.push("engine and tank propellant differ");
  }
  if (engine && tank && tank.dryMass_kg < DRY_MASS_MIN_FRACTION * tank.propellantMass_kg) {
    out.push("tank dry mass below 4 percent of propellant");
  }
  if (stageIndex === 0 && engine && isVacuumOnly(engine)) {
    out.push("vacuum-only engine on stage 0");
  }
  if (!isValidEngineCount(stage.engineCount)) {
    out.push(`stage ${stageIndex + 1} engine count must be a whole number from 1 to ${MAX_ENGINE_COUNT}`);
  } else if (engine && tank) {
    const fit = maxEngineCount(tank.diameter_m, engine.diameter_m);
    if (stage.engineCount > fit) {
      out.push(tooManyEnginesWarning(stage.engineCount, engine, tank, fit));
    }
  }
  return out;
};

// The engine count the masses and thrust use: an invalid count counts as no engines (TS evaluateBuild).
const usableEngineCount = (n) => (isValidEngineCount(n) ? n : 0);

const twrWarning = (twr) =>
  twr < TWR_BLOCKING ? { message: "liftoff TWR below 1.0", blocking: true } : twr < TWR_OK ? { message: "liftoff TWR below 1.2", blocking: false } : null;

export const evaluateBuild = (build, catalog) => {
  const warnings = [];
  const blocking = new Set();
  const addBlocking = (message) => {
    warnings.push(message);
    blocking.add(message);
  };

  if (build.stages.length === 0) {
    addBlocking("empty build");
    return {
      stages: [],
      totalDeltaV_ms: 0,
      requiredDeltaV_ms: 0,
      marginDeltaV_ms: 0,
      liftoffTWR: 0,
      deltaVOk: false,
      twrOk: false,
      feasible: false,
      totalMass_kg: 0,
      liftoffThrust_kN: 0,
      closestRocketId: "",
      warnings,
    };
  }

  const mission = build.missionId ? byId(catalog.missions, build.missionId) : undefined;
  if (build.missionId && !mission) {
    addBlocking(`unknown mission id: ${build.missionId}`);
  }

  const payload = build.payloadId ? byId(catalog.payloads, build.payloadId) : undefined;
  if (build.payloadId && !payload) {
    addBlocking(`unknown payload id: ${build.payloadId}`);
  }
  const payloadMass_kg = payload?.mass_kg ?? 0;

  const resolved = build.stages.map((stage, stageIndex) => {
    const engine = stage.engineId ? byId(catalog.engines, stage.engineId) : undefined;
    const tank = stage.tankId ? byId(catalog.tanks, stage.tankId) : undefined;
    stageRuleWarnings(stage, stageIndex, engine, tank).forEach(addBlocking);
    const engineCount = usableEngineCount(stage.engineCount);
    const mass_kg = engine && tank ? stageMass_kg(engine, engineCount, tank) : 0;
    return { engine, tank, mass_kg, engineCount };
  });

  const masses = resolved.map((r) => r.mass_kg);
  const totalMass_kg = masses.reduce((sum, m) => sum + m, 0) + payloadMass_kg;

  const stageResults = resolved.map((r, i) => {
    const startMass_kg = masses.slice(i).reduce((sum, m) => sum + m, 0) + payloadMass_kg;
    const propellantMass_kg = r.tank?.propellantMass_kg ?? 0;
    const endMass_kg = startMass_kg - propellantMass_kg;
    const ispUsed_s = r.engine ? ispForStage_s(r.engine, i) : 0;
    const deltaV_ms = rocketEquationDeltaV_ms(ispUsed_s, startMass_kg, endMass_kg);
    return { stageIndex: i, ispUsed_s, startMass_kg, endMass_kg, deltaV_ms };
  });

  const totalDeltaV_ms = stageResults.reduce((sum, s) => sum + s.deltaV_ms, 0);
  const requiredDeltaV_ms = mission?.requiredDeltaV_ms ?? 0;
  const marginDeltaV_ms = totalDeltaV_ms - requiredDeltaV_ms;
  const deltaVOk = Boolean(mission) && marginDeltaV_ms >= 0;

  const first = resolved[0];
  const startMass0 = stageResults[0]?.startMass_kg ?? 0;
  const thrust_kN = first?.engine ? liftoffThrust_kN(first.engine, first.engineCount) : 0;
  const twr = first?.engine ? liftoffTWR(first.engine, first.engineCount, startMass0) : 0;
  const twrOk = twr >= TWR_OK;
  const tw = twrWarning(twr);
  if (tw?.blocking) {
    addBlocking(tw.message);
  } else if (tw) {
    warnings.push(tw.message);
  }

  const closestId = closestRocketId(totalMass_kg, thrust_kN, catalog.referenceRockets);
  const feasible = deltaVOk && twrOk && blocking.size === 0;

  return {
    stages: stageResults,
    totalDeltaV_ms,
    requiredDeltaV_ms,
    marginDeltaV_ms,
    liftoffTWR: twr,
    deltaVOk,
    twrOk,
    feasible,
    totalMass_kg,
    liftoffThrust_kN: thrust_kN,
    closestRocketId: closestId,
    warnings,
  };
};

// --- demo extras (not in the team app; label "est." on screen) ---------------------------------------------
// Mass flow of one engine at full thrust: mdot = F / (Isp * g0). null when the regime has no thrust/Isp
// (a vacuum-only engine at sea level).
export const massFlow_kgs = (engine, regime) => {
  const thrust_kN = regime === "sl" ? engine.thrustSL_kN : engine.thrustVac_kN;
  const isp_s = regime === "sl" ? engine.ispSL_s : engine.ispVac_s;
  if (!(thrust_kN > 0) || !(isp_s > 0)) return null;
  return (thrust_kN * 1000) / (isp_s * G0);
};

// Full-throttle burn time: propellant / (n * mdot), in the regime the app uses for that stage (SL for stage 0).
export const burnTime_s = (engine, engineCount, tank, stageIndex) => {
  const mdot = massFlow_kgs(engine, stageIndex === 0 ? "sl" : "vac");
  if (mdot === null || !(engineCount > 0)) return null;
  return tank.propellantMass_kg / (engineCount * mdot);
};

// One entry per stage, bottom first. Mass/Δv/Isp fields are exactly evaluateBuild's; the rest are derived:
//   dryMass_kg      stage dry mass = n * engine mass + tank dry mass (what is left when the tank is empty)
//   tankDryMass_kg  the tank record's dry mass; engineMass_kg = n * engine mass
//   dryFraction     tank dry / tank propellant, the quantity the app's 4 % rule tests
//   massRatio       startMass / endMass
//   thrust_kN       n * thrust in the stage's regime (SL for stage 0, vacuum above)
//   twr, liftoffAccel_ms2   stage 0 only ((TWR - 1) * g0), else null
//   fitMaxEngines   the app's engine-fit rule for this tank and engine (more engines is a blocking warning)
//   warnings        evaluateBuild's warning strings that this stage triggered (TWR ones land on stage 0)
// Missing engine or tank: those fields are null and the masses follow evaluateBuild (stage mass 0).
export const stageDetails = (build, catalog) => {
  const verdict = evaluateBuild(build, catalog);
  return build.stages.map((stage, i) => {
    const engine = stage.engineId ? byId(catalog.engines, stage.engineId) : undefined;
    const tank = stage.tankId ? byId(catalog.tanks, stage.tankId) : undefined;
    const r = verdict.stages[i];
    const n = stage.engineCount;
    const warnings = stageRuleWarnings(stage, i, engine, tank);
    let twr = null;
    if (i === 0) {
      twr = verdict.liftoffTWR;
      const tw = twrWarning(twr);
      if (tw) warnings.push(tw.message);
    }
    const engineMass_kg = engine ? n * engine.mass_kg : null;
    const both = engine && tank;
    return {
      stageIndex: i,
      engine: engine ?? null,
      engineCount: n,
      tank: tank ?? null,
      startMass_kg: r.startMass_kg,
      endMass_kg: r.endMass_kg,
      propellantMass_kg: tank ? tank.propellantMass_kg : 0,
      dryMass_kg: both ? engineMass_kg + tank.dryMass_kg : null,
      tankDryMass_kg: tank ? tank.dryMass_kg : null,
      engineMass_kg,
      massRatio: r.endMass_kg > 0 ? r.startMass_kg / r.endMass_kg : null,
      ispUsed_s: r.ispUsed_s,
      deltaV_ms: r.deltaV_ms,
      thrust_kN: engine ? n * (i === 0 ? engine.thrustSL_kN : engine.thrustVac_kN) : 0,
      twr,
      liftoffAccel_ms2: twr === null ? null : (twr - 1) * G0,
      burnTime_s: both ? burnTime_s(engine, n, tank, i) : null,
      fitMaxEngines: both ? maxEngineCount(tank.diameter_m, engine.diameter_m) : null,
      dryFraction: tank && tank.propellantMass_kg > 0 ? tank.dryMass_kg / tank.propellantMass_kg : null,
      warnings,
    };
  });
};

// Running mass tally for the HUD while the stack is being built.
//   opts.stages:  stage indices whose whole stage (engines + tank) is built
//   opts.engines / opts.tanks: stage indices where only that part is built (optional, finer than stages)
//   opts.payload: true once the payload is on
// Each part is counted once even if listed twice. Unknown ids count 0.
export const stackMass_kg = (build, catalog, { stages = [], engines = [], tanks = [], payload = false } = {}) => {
  const withEngines = new Set([...stages, ...engines]);
  const withTanks = new Set([...stages, ...tanks]);
  let total = 0;
  build.stages.forEach((stage, i) => {
    const engine = stage.engineId ? byId(catalog.engines, stage.engineId) : undefined;
    const tank = stage.tankId ? byId(catalog.tanks, stage.tankId) : undefined;
    if (withEngines.has(i) && engine) total += stage.engineCount * engine.mass_kg;
    if (withTanks.has(i) && tank) total += tank.dryMass_kg + tank.propellantMass_kg;
  });
  if (payload) {
    const p = build.payloadId ? byId(catalog.payloads, build.payloadId) : undefined;
    total += p?.mass_kg ?? 0;
  }
  return total;
};
