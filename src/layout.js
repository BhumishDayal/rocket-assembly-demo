// Layout: turns a BuildState (+ the catalog) into an ordered manifest of parts at true scale.
// Pure data, no three.js, so node can run it (see the manifest check in the head chat's notes).
//
// Every size is either a dataset field (record.diameter_m / height_m, visuals.engines[id].length_m) or a
// visual proportion used only to shape geometry where the data has none. Visual proportions are the named
// constants below; they are never shown on screen as facts (cards only show record fields or derived sizes
// labelled as such).
//
// A tank record's height_m is the full STAGE length, engine exit to forward end: stage 0 includes its engine
// section, an upper stage includes the interstage its engine hangs in. (NASA SP-4029's Saturn V stage lengths
// only add up to the vehicle height read this way; adding engines and interstages on top overshot by ~14 m.)
// The tank is drawn as that length minus the engine section / interstage below it.
//
// Stack arithmetic (all in metres, converted with SCALE at the end; part local y = 0 is its bottom):
//   stage 0 engines   slotY = 0                         height = L0 + MOUNT     (bells at y=0, mount plate on top)
//   stage 0 tank      slotY = L0 + MOUNT                height = H0 − (L0 + MOUNT)
//   interstage k→k+1  slotY = top of tank k             height = I = L(k+1) + CLEAR (the upper engines hang inside)
//   stage k+1 engines slotY = interstage top − (L(k+1) + MOUNT)
//                     → bell exits sit CLEAR − MOUNT = 0.2 m above the lower tank, mount plate flush with the
//                       interstage top (= bottom of the upper tank), so the bells never poke out below.
//   stage k+1 tank    slotY = interstage top            height = H(k+1) − I
//   payload           slotY = top of the last tank      height = adapter + payload.height_m (+ escape tower)
//   fairing           slotY = top of the last tank      height = adapter + payload.height_m + nose
//                     (boattail + cylinder up to the payload top, then the ogive nose; skipped when exposed)
// Stacked height = Σ stage lengths (record height_m) + the top (fairing height, or adapter + payload + tower
// when the payload is exposed). Upper engines and the payload are nested inside the interstage / fairing.
// If subtracting would leave a tank shorter than MIN_TANK_SHARE of its record, that record is treated as
// tank-only (engine section / interstage added on top) and manifest.warnings says so.

export const SCALE = 0.25; // scene units per metre

// ---- visual proportions (shape only, not real-world data) ----
const ENGINE_LEN_SEA_LEVEL = 1.8; // engine length / exit diameter, engines with sea-level thrust, when unsourced
const ENGINE_LEN_VACUUM = 1.3; // same for vacuum-only engines (thrustSL_kN = 0)
const MOUNT_M = 0.2; // thrust/mount plate on top of each engine cluster
const INTERSTAGE_CLEAR_M = 0.4; // interstage length = upper engine length + this clearance
const CLUSTER_GAP = 1.03; // bell centre spacing ≥ exit diameter × this (3 % gap between bells)
const ADAPTER_PER_STAGE_D = 0.12; // payload adapter height / upper-stage diameter
const FAIRING_PER_PAYLOAD_D = 1.2; // fairing diameter ≥ payload diameter × this
const NOSE_PER_FAIRING_D = 1.3; // ogive nose length / fairing diameter
const BOATTAIL_TAN = 0.7; // boattail flare (fairing wider than the stage): radial step / height (~35° half-angle)
const FIN_SPAN_PER_TANK_D = 0.22; // stage-0 fins ("fins" feature): span / stage diameter
const MIN_TANK_SHARE = 0.35; // guard for the stage-length reading (see header)

const byId = (list, id) => (list ?? []).find((x) => x.id === id);

export const isVacuumOnly = (engine) => !(engine.thrustSL_kN > 0);

// Engine length in metres: sourced when visuals.json has it, else a visual ratio of the exit diameter.
export function engineLength(engine, visuals) {
  const v = visuals?.engines?.[engine.id];
  if (v?.length_m > 0) return { length_m: v.length_m, source: v.source ?? null };
  const k = isVacuumOnly(engine) ? ENGINE_LEN_VACUUM : ENGINE_LEN_SEA_LEVEL;
  return { length_m: engine.diameter_m * k, source: null };
}

// Cluster layout from the engine count: 1 centre, 2 pair, 3 triangle, 4 square, 5 quincunx (4 + centre),
// 6 hexagon, 7 hexagon + centre, 8 ring, 9 ring + centre (octaweb). The ring radius is the geometric minimum
// so neighbouring bells (and the centre bell) keep a 3 % gap. Returns metres; angle a is the azimuth of the
// engine (x = r cos a, z = r sin a), used by parts.js to turn each powerhead outward.
const RINGS = {
  1: [0, false, 0],
  2: [2, false, 0],
  3: [3, false, Math.PI / 2],
  4: [4, false, Math.PI / 4],
  5: [4, true, Math.PI / 4],
  6: [6, false, 0],
  7: [6, true, 0],
  8: [8, false, Math.PI / 8],
  9: [8, true, Math.PI / 8],
};
export function clusterLayout(count, exitD_m) {
  const [m, centre, a0] = RINGS[count] ?? [count, false, 0];
  const pitch = exitD_m * CLUSTER_GAP;
  const ringR = Math.max(centre ? pitch : 0, m >= 2 ? pitch / (2 * Math.sin(Math.PI / m)) : 0);
  const positions = [];
  if (centre || m === 0) positions.push({ x: 0, z: 0, a: 0, r: 0 });
  for (let i = 0; i < m; i++) {
    const a = a0 + (i / m) * Math.PI * 2;
    positions.push({ x: ringR * Math.cos(a), z: ringR * Math.sin(a), a, r: ringR });
  }
  return { ringR, outerR: ringR + exitD_m / 2, positions };
}

const plural = (n, word) => `${n} × ${word}${n === 1 ? "" : "s"}`;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

// Payload archetype + exposure: visuals.json first, else a visual guess from the id (no numbers involved).
function payloadLook(payload, visuals) {
  const v = visuals?.payloads?.[payload.id] ?? {};
  const id = payload.id.toLowerCase();
  const guess = /hubble|jwst|webb|telescope/.test(id)
    ? "telescope"
    : /nova|lander/.test(id)
      ? "lander"
      : /apollo|csm|capsule|orion|dragon/.test(id)
        ? "capsule"
        : "weather-sat";
  const archetype = v.archetype ?? guess;
  return { archetype, exposed: v.exposed ?? archetype === "capsule", source: v.source ?? null };
}

// interstage: "black-composite" | "body" (= the tank's finish) | any finish name.
function tankLook(tank, visuals) {
  const v = visuals?.tanks?.[tank.id] ?? {};
  const finish = v.finish ?? "white";
  const interstage = !v.interstage || v.interstage === "body" ? finish : v.interstage;
  return { finish, interstage, features: v.features ?? [], enclosed: !!v.enclosed, source: v.source ?? null };
}

// build: { stages: [{ engineId, engineCount, tankId }], payloadId, ... }; catalog: { engines, tanks, payloads, visuals }.
// Returns PartSpec[] bottom → top in build order (see the contract in docs/v2-design.md §2.3). Sizes in scene
// units (slotY, height, radius) and metres (height_m, diameter_m, geom.*). Missing records are skipped with
// a warning on the spec list (manifest.warnings) instead of throwing, so a half-landed catalog still renders.
export function buildManifest(build, catalog) {
  const visuals = catalog.visuals ?? {};
  const out = [];
  const warnings = [];
  const u = (m) => m * SCALE;
  const stages = (build.stages ?? [])
    .map((s, k) => {
      const engine = byId(catalog.engines, s.engineId);
      const tank = byId(catalog.tanks, s.tankId);
      if (!engine) warnings.push(`stage ${k + 1}: engine "${s.engineId}" not in the catalog`);
      if (!tank) warnings.push(`stage ${k + 1}: tank "${s.tankId}" not in the catalog`);
      return engine && tank ? { engine, tank, count: Math.max(1, s.engineCount | 0) } : null;
    })
    .filter(Boolean);

  const push = (spec) => out.push({ ...spec, key: KEYS[out.length] ?? null });

  let y = 0; // metres, top of what is stacked so far (excluding nested parts)
  let interBelow = 0; // height of the interstage pushed for the stage being laid out
  stages.forEach(({ engine, tank, count }, k) => {
    const look = tankLook(tank, visuals);
    const len = engineLength(engine, visuals);
    const L = len.length_m;
    const cluster = clusterLayout(count, engine.diameter_m);
    const vac = isVacuumOnly(engine);
    const enginesH = L + MOUNT_M;
    const enginesSlot = k === 0 ? 0 : y - enginesH; // k ≥ 1: y is the interstage top (see header)
    const tankR = tank.diameter_m / 2;
    if (k > 0) {
      const inter = out[out.length - 1];
      const innerR = Math.min(inter.geom.bottomD_m, inter.geom.topD_m) / 2;
      if (cluster.outerR > innerR) warnings.push(`stage ${k + 1}: engine cluster (${(cluster.outerR * 2).toFixed(2)} m) wider than the interstage (${(innerR * 2).toFixed(2)} m)`);
    }
    // Stage-0 signature structures that sit around the engines (S-IC fins + engine fairings) belong to the
    // engines part; legs, grid fins and raceway run along the tank and belong to the tank part.
    // Grid fins sit near the top of the interstage above this stage (on the tank top if no stage follows).
    const engineFeatures = k === 0 ? look.features.filter((f) => f === "fins" || f === "engine-fairings") : [];
    const fin = engineFeatures.includes("fins")
      ? { rootR_m: Math.max(tankR, cluster.outerR * 0.95), span_m: FIN_SPAN_PER_TANK_D * tank.diameter_m }
      : null;
    const next = stages[k + 1];
    push({
      id: `s${k}-engines`,
      kind: "engines",
      name: engine.name,
      sub: `${plural(count, vac ? "vacuum engine" : "sea-level engine")} · stage ${k + 1}`,
      stageIndex: k,
      record: engine,
      count,
      slotY: u(enginesSlot),
      height: u(enginesH),
      radius: u(Math.max(cluster.outerR, tankR, fin ? fin.rootR_m + fin.span_m : 0)),
      height_m: L,
      diameter_m: engine.diameter_m,
      derived: false,
      note: len.source ? "" : "Engine length is not in the dataset; the bell is drawn from a visual proportion of the exit diameter.",
      lengthSource: len.source,
      icon: "engine",
      geom: {
        engineLength_m: L,
        chambers: Math.max(1, visuals?.engines?.[engine.id]?.chambers | 0), // e.g. RD-180: two bells in one envelope
        diameterKind: visuals?.engines?.[engine.id]?.diameterKind ?? null, // "overall": diameter_m is the envelope
        bellFinish: visuals?.engines?.[engine.id]?.bellFinish ?? null, // "ablative": a composite nozzle, not bare metal
        extension: visuals?.engines?.[engine.id]?.extension ?? null, // sourced nozzle extension (F-1: film-cooled band)
        exitD_m: engine.diameter_m,
        vacuum: vac,
        mountH_m: MOUNT_M,
        mountD_m: tank.diameter_m,
        ringR_m: cluster.ringR,
        outerR_m: cluster.outerR,
        positions: cluster.positions,
        features: engineFeatures,
        fin,
        stageIndex: k,
        finish: look.finish,
      },
    });

    const tankSlot = k === 0 ? enginesH : y;
    const below = k === 0 ? enginesH : interBelow; // part of the stage length taken by engines / interstage
    let tankH = tank.height_m - below;
    if (tankH < MIN_TANK_SHARE * tank.height_m) {
      warnings.push(`stage ${k + 1}: "${tank.id}" height_m read as tank-only (stage-length reading would leave ${tankH.toFixed(2)} m)`);
      tankH = tank.height_m;
    }
    y = tankSlot + tankH;
    push({
      id: `s${k}-tank`,
      kind: "tank",
      name: tank.name,
      sub: `${tank.propellant} tank · stage ${k + 1}`,
      stageIndex: k,
      record: tank,
      count: 1,
      slotY: u(tankSlot),
      height: u(tankH),
      radius: u(tankR),
      height_m: tank.height_m,
      diameter_m: tank.diameter_m,
      derived: false,
      note:
        tankH < tank.height_m
          ? `The record's height is the stage length (engine exit to forward end); the tank is drawn ${(tank.height_m - tankH).toFixed(1)} m shorter to leave room for the ${k === 0 ? "engine section" : "interstage"} below it.`
          : "",
      icon: "tank",
      geom: {
        D_m: tank.diameter_m,
        H_m: tankH, // drawn height (record height_m minus the engine section / interstage)
        finish: look.finish,
        features: look.features.filter((f) => f !== "fins" && f !== "engine-fairings" && !(f === "grid-fins" && next)),
        enclosed: look.enclosed, // skin hidden inside interstage/fairing on the real vehicle (dcss-5m)
        stageIndex: k,
        topStage: k === stages.length - 1,
        visualSource: look.source,
      },
    });

    if (next) {
      const upperL = engineLength(next.engine, visuals).length_m;
      const H = upperL + INTERSTAGE_CLEAR_M;
      const topD = next.tank.diameter_m;
      push({
        id: `s${k}-interstage`,
        kind: "interstage",
        name: "Interstage",
        sub: `joins stage ${k + 1} and stage ${k + 2} · derived`,
        stageIndex: k,
        record: null,
        count: 1,
        slotY: u(y),
        height: u(H),
        radius: u(Math.max(tankR, topD / 2)),
        height_m: H,
        diameter_m: Math.max(tank.diameter_m, topD),
        derived: true,
        note: "Derived structure: sized from the two stages it joins and the upper engine it covers. Not a dataset record; no separate mass is modelled.",
        icon: "ring",
        geom: {
          bottomD_m: tank.diameter_m,
          topD_m: topD,
          H_m: H,
          finish: look.interstage,
          // a stage with S-IC style engine fairings carries the next stage's ullage motors on this interstage
          // (Saturn V); drawn as housings, a visual reading
          features: [...look.features.filter((f) => f === "grid-fins"), ...(look.features.includes("engine-fairings") ? ["ullage-motors"] : [])],
        },
      });
      y += H;
      interBelow = H;
    }
  });

  const payload = byId(catalog.payloads, build.payloadId);
  if (!payload && build.payloadId) warnings.push(`payload "${build.payloadId}" not in the catalog`);
  const lastTank = stages.at(-1)?.tank;
  if (payload && lastTank) {
    const { archetype, exposed, source } = payloadLook(payload, visuals);
    // Sourced sub-dimensions for the archetype (e.g. Apollo SLA/SM/CM), and an escape tower drawn above the
    // record's envelope when its height is sourced (the record's height_m excludes it).
    const dims = visuals?.payloads?.[payload.id]?.dims ?? null;
    const lesH = dims?.les_height_m > 0 ? dims.les_height_m : 0;
    const Dt = lastTank.diameter_m;
    const Dp = payload.diameter_m;
    const Hp = payload.height_m;
    const Df = Math.max(Dt, FAIRING_PER_PAYLOAD_D * Dp);
    const boattailH = Df > Dt + 1e-6 ? (Df - Dt) / 2 / BOATTAIL_TAN : 0;
    // A payload wider than the stage rides on a taller adapter so it clears the boattail cone.
    let adapterH = ADAPTER_PER_STAGE_D * Dt;
    if (!exposed && Dp > Dt) adapterH = Math.max(adapterH, boattailH);
    const top = y;
    push({
      id: "payload",
      kind: "payload",
      name: payload.name,
      sub: `payload · ${archetype} · on adapter`,
      stageIndex: null,
      record: payload,
      count: 1,
      slotY: u(top),
      height: u(adapterH + Hp + lesH),
      radius: u(Math.max(Dp, archetype === "capsule" ? Dt : 0) / 2),
      height_m: Hp,
      diameter_m: Dp,
      derived: false,
      note: "Sits on a payload adapter (derived structure, not a dataset record).",
      icon: "nose",
      geom: { D_m: Dp, H_m: Hp, adapterH_m: adapterH, lesH_m: lesH, stageD_m: Dt, archetype, exposed, dims, visualSource: source },
    });
    if (exposed) {
      y = top + adapterH + Hp + lesH;
    } else {
      const noseH = NOSE_PER_FAIRING_D * Df;
      const H = adapterH + Hp + noseH;
      push({
        id: "fairing",
        kind: "fairing",
        name: "Payload fairing",
        sub: "two halves · derived",
        stageIndex: null,
        record: null,
        count: 1,
        slotY: u(top),
        height: u(H),
        radius: u(Df / 2),
        height_m: H,
        diameter_m: Df,
        derived: true,
        note: "Derived structure: sized around the payload it encloses. Not a dataset record; no mass is modelled.",
        icon: "nose",
        geom: { D_m: Df, baseD_m: Dt, boattailH_m: boattailH, cylTop_m: adapterH + Hp, noseH_m: noseH, H_m: H },
      });
      y = top + H;
    }
  }
  out.warnings = warnings;
  if (warnings.length && typeof console !== "undefined") console.warn("[layout]", ...warnings);
  return out;
}

// Bounds of the full stack (every part built, assembled).
export function sceneBounds(manifest) {
  let height_u = 0;
  let radius_u = 0;
  let baseRadius_u = 0;
  for (const p of manifest) {
    height_u = Math.max(height_u, p.slotY + p.height);
    radius_u = Math.max(radius_u, p.radius);
    if (p.stageIndex === 0) baseRadius_u = Math.max(baseRadius_u, p.radius);
  }
  return { height_u, radius_u, height_m: height_u / SCALE, baseRadius_u };
}
