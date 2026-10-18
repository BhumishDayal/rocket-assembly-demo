// Render-budget report for the scene (local tooling, not deployed). For every preset, in the painted look and
// in x-ray: draw objects split into meshes and line sets, shadow casters, unique geometries, vertices drawn,
// unique materials, programs (approximated by material type + shader hooks + maps/defines), textures. The
// pad + anchors are reported separately, and so are the flight props grouped by the scene they share (pad
// ignition, ascent to orbit, booster return, Moon landing, Mars landing).
// Fails when a preset's builder exceeds 320 meshes + 120 line sets in either look, or a flight-prop scene
// exceeds 60 extra draws. (All flight props together are printed too, for reference: they never share a frame.)
// Run: node scripts/check-budget.mjs   (no deps; exits 1 over budget)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { catalog, presetToBuild } = await import("../src/data/catalog.js");
const { buildManifest, sceneBounds } = await import("../src/layout.js");
const { createMaterials, createPart, createPad, setShellOpacity, setPropLook, landerOf } = await import("../src/parts.js");
const { createAnchors, createDroneShip } = await import("../src/anchors.js");
const { attachPlumes, createPlume, createPadLight } = await import("../src/plume.js");
const FX = await import("../src/fx/launchfx.js");
const { createPlanet, createTerrain, createOcean, createSkyDome, createDustPuff, createShadowDecal } = await import("../src/planet.js");

const BUILDER = { meshes: 320, lines: 120 };
const FLIGHT = 60;
const failures = [];

// ---------- counting ----------

const proto = THREE.Material.prototype;
let shaderIds = new Map();
const shaderId = (m) => {
  const k = m.vertexShader + "\n" + m.fragmentShader;
  if (!shaderIds.has(k)) shaderIds.set(k, `s${shaderIds.size}`);
  return shaderIds.get(k);
};
const MAPS = ["map", "normalMap", "bumpMap", "roughnessMap", "metalnessMap", "alphaMap", "emissiveMap", "aoMap", "lightMap", "envMap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap", "anisotropyMap", "displacementMap"];
// Program key: what makes three compile a different program (approximate: type, hooks, maps, defines).
function programKey(m) {
  const hook = m.customProgramCacheKey !== proto.customProgramCacheKey ? m.customProgramCacheKey() : m.onBeforeCompile !== proto.onBeforeCompile ? "obc" : "";
  const maps = MAPS.filter((k) => m[k]).join(",");
  const defs = [
    m.vertexColors && "vc",
    m.transparent && "tr",
    m.flatShading && "flat",
    m.clearcoat > 0 && "cc",
    m.anisotropy > 0 && "aniso",
    m.fog && "fog",
    m.alphaTest > 0 && "at",
    m.side === THREE.DoubleSide && "ds",
    m.isShaderMaterial && shaderId(m),
    m.defines && JSON.stringify(m.defines),
    m.sizeAttenuation === false && "nosize",
  ].filter(Boolean);
  return `${m.type}|${hook}|${maps}|${defs.join(",")}`;
}
function texturesOf(m, out) {
  for (const k of MAPS) if (m[k]?.isTexture) out.add(m[k]);
  for (const u of Object.values(m.uniforms ?? {})) if (u?.value?.isTexture) out.add(u.value);
}
function stats(...roots) {
  const s = { meshes: 0, lines: 0, casters: 0, geos: new Set(), verts: 0, mats: new Set(), progs: new Set(), texs: new Set() };
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverseVisible((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      const ms = [].concat(o.material ?? []);
      if (!ms.length || ms.every((m) => m.visible === false)) return; // three skips these draws
      if (o.isLine) s.lines++;
      else s.meshes++;
      if (o.castShadow && !o.isLine) s.casters++;
      if (o.geometry) {
        s.geos.add(o.geometry);
        s.verts += (o.geometry.attributes.position?.count ?? 0) * (o.isInstancedMesh ? o.count : 1);
      }
      for (const m of ms) {
        s.mats.add(m);
        s.progs.add(programKey(m));
        texturesOf(m, s.texs);
      }
    });
  }
  return { meshes: s.meshes, lines: s.lines, draws: s.meshes + s.lines, casters: s.casters, geos: s.geos.size, verts: s.verts, mats: s.mats.size, progs: s.progs.size, texs: s.texs.size };
}

// ---------- table ----------

const COLS = ["meshes", "lines", "draws", "casters", "geos", "verts", "mats", "progs", "texs"];
const rows = [];
const row = (label, st, note = "") => rows.push({ label, ...st, note });
function print() {
  const w = Math.max(...rows.filter((r) => !r.sep).map((r) => r.label.length), 10);
  const fmt = (v) => (typeof v === "number" ? (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(v)) : v);
  console.log(["".padEnd(w), ...COLS.map((c) => c.padStart(7))].join(" ") + "  note");
  for (const r of rows) {
    if (r.sep) {
      console.log(r.label);
      continue;
    }
    console.log([r.label.padEnd(w), ...COLS.map((c) => fmt(r[c]).padStart(7))].join(" ") + (r.note ? `  ${r.note}` : ""));
  }
}
const section = (label) => rows.push({ sep: true, label });

// ---------- builder (per preset, both looks) + pad/anchors ----------

const built = {};
section("builder (all parts built)");
for (const preset of catalog.presets) {
  const mats = createMaterials();
  const manifest = buildManifest(presetToBuild(preset), catalog);
  const parts = manifest.map((spec) => createPart(spec, mats));
  const root = new THREE.Group();
  for (const p of parts) root.add(p.group);
  built[preset.id] = { manifest, parts, bounds: sceneBounds(manifest) };
  for (const look of ["painted", "x-ray"]) {
    for (const p of parts) setShellOpacity(p, look === "painted" ? 0.92 : 0.3);
    const st = stats(root);
    const over = st.meshes > BUILDER.meshes || st.lines > BUILDER.lines;
    if (over) failures.push(`${preset.id} ${look}: ${st.meshes} meshes / ${st.lines} lines (budget ${BUILDER.meshes} / ${BUILDER.lines})`);
    row(`  ${preset.id} ${look}`, st, over ? "OVER" : "");
  }
  for (const p of parts) setShellOpacity(p, 0.92);
}
section("pad + anchors");
for (const preset of catalog.presets) {
  const { manifest, bounds } = built[preset.id];
  const pad = createPad({ baseRadius_u: bounds.baseRadius_u });
  const anchors = createAnchors({ baseRadius_u: bounds.baseRadius_u, stackHeight_u: bounds.height_u, manifest });
  pad.group.add(anchors.object3d);
  for (const look of ["painted", "xray"]) {
    setPropLook(pad.group, look);
    row(`  ${preset.id} ${look === "xray" ? "x-ray" : look}`, stats(pad.group));
  }
}

// ---------- flight props, by scene ----------

const v = (x, y, z) => new THREE.Vector3(x, y, z);
function scene(label, items) {
  const roots = items.map(([, o]) => o);
  const st = stats(...roots);
  const parts = items.map(([n, o]) => `${n} ${stats(o).draws}`).join(", ");
  const over = st.draws > FLIGHT;
  if (over) failures.push(`${label}: ${st.draws} extra draws (budget ${FLIGHT})`);
  row(`  ${label}`, st, `${over ? "OVER · " : ""}${parts}`);
  return roots;
}
section("flight props by scene (extra draws on top of the vehicle)");
const all = [];
for (const preset of catalog.presets) {
  const { manifest, parts, bounds } = built[preset.id];
  const engines = parts.filter((p) => p.kind === "engines").sort((a, b) => a.stageIndex - b.stageIndex);
  const L = createPad({ baseRadius_u: bounds.baseRadius_u }).layout;
  const plumesOf = (part) => {
    const g = new THREE.Group();
    for (const pl of attachPlumes(part)) {
      pl.update(0.1, { throttle: 1 });
      g.add(pl.object3d);
    }
    return g;
  };
  // pad ignition: stage-0 plumes, pad light + splash, ground effects, ground map
  const padLight = createPadLight({ baseRadius_u: bounds.baseRadius_u, bellExitRadius_u: 0.1 });
  padLight.update(0.1, 1, 0);
  const vents = FX.createVents([{ position: v(0.5, 10, 0) }, { position: v(0, 13, 0.5), dir: v(0, 0, 1) }], { scale_u: 0.4 });
  vents.update(1, { intensity: 1 });
  const deluge = FX.createDeluge({ layout: L });
  deluge.update(0, { t: 4, intensity: 1 });
  const jet = FX.createTrenchJet({ layout: L });
  jet.update(0.1, { throttle: 1, bellHeight_m: 0 });
  const steam = FX.createSteamCloud({ layout: L });
  steam.update(0.1, { t: 6, glow: 1, intensity: 1 });
  const map = FX.createGroundMap({ size_u: 4000, y_u: -L.plinthH - 0.01 });
  all.push(...scene(`${preset.id}: pad ignition`, [["plumes", plumesOf(engines[0])], ["padLight", padLight.object3d], ["vents", vents.object3d], ["deluge", deluge.object3d], ["trenchJet", jet.object3d], ["steam", steam.object3d], ["groundMap", map.object3d]]));
  // ascent to orbit: upper-stage plumes, condensation halo, staging flash and puffs, Earth, sky dome
  const halo = FX.createCondensationHalo({ radius_u: bounds.baseRadius_u, length_u: 2.5 });
  halo.fire();
  halo.update(0.2, { intensity: 1 });
  const flash = FX.createIgnitionFlash();
  flash.fire({ position: v(0, 12, 0), kind: "meco" });
  flash.update(0.1);
  const puffs = FX.createColdGasPuffs({ scale_u: 0.3 });
  for (let i = 0; i < 6; i++) puffs.fire({ position: v(i, 0, 0), dir: v(0, 1, 0) });
  puffs.update(0.1);
  const earth = createPlanet({ kind: "earth", radius_u: 40 });
  const dome = createSkyDome({ radius_u: 2000 });
  all.push(...scene(`${preset.id}: ascent`, [["plumes", engines[1] ? plumesOf(engines[1]) : new THREE.Group()], ["halo", halo.object3d], ["flash", flash.object3d], ["puffs", puffs.object3d], ["earth", earth.object3d], ["sky", dome.object3d]]));
  // booster return: booster plumes, plasma glow, cloud deck, ocean, drone ship
  if (manifest.some((s) => s.geom?.features?.includes?.("landing-legs"))) {
    const plasma = FX.createPlasmaGlow({ radius_u: bounds.baseRadius_u, length_u: 3 });
    plasma.update(0.1, { intensity: 1 });
    const clouds = FX.createCloudLayer({ altitude_u: 40, radius_u: 60 });
    clouds.update(0.1, { intensity: 1 });
    const ocean = createOcean({ size_u: 4000 });
    const ship = createDroneShip({ size_u: 22 });
    all.push(...scene(`${preset.id}: booster return`, [["plumes", plumesOf(engines[0])], ["plasma", plasma.object3d], ["clouds", clouds.object3d], ["ocean", ocean.object3d], ["ship", ship.object3d], ["sky", createSkyDome().object3d]]));
  }
  // landing: terrain, the lander's plume, dust, a small Earth (Moon) or the sky (Mars)
  const payload = parts.find((p) => p.kind === "payload");
  const lands = payload && (payload.geom?.archetype === "lander" || landerOf(payload));
  if (lands) {
    for (const body of ["moon", "mars"]) {
      const terrain = createTerrain({ body, size_u: 60 });
      const plume = createPlume({ engineRecord: { id: "lander", propellant: "hypergolic" }, exitRadius_u: 0.1 });
      plume.update(0.1, { throttle: 1 });
      const dust = FX.createLunarDust({ radius_u: 2 });
      dust.update(0.1, { throttle: 1, altitude_m: 6 });
      const puff = createDustPuff();
      puff.fire({ position: v(0, 0, 0), radius: 0.5 });
      const decal = createShadowDecal({ radius_u: 0.6 });
      decal.update({ position: v(0, 0, 0), altitude_u: 0.5, sunDir: v(-0.5, 0.7, 0.3).normalize() });
      const sky = body === "moon" ? createPlanet({ kind: "earth", radius_u: 2.2 }).object3d : createSkyDome().object3d;
      all.push(...scene(`${preset.id}: ${body} landing`, [["terrain", terrain.object3d], ["plume", plume.object3d], ["dust", dust.object3d], ["puff", puff.object3d], ["shadow", decal.object3d], [body === "moon" ? "earth" : "sky", sky]]));
    }
  }
}
section("all flight props together (reference only: they never share a frame)");
row("  every scene above", stats(...new Set(all)));

print();
console.log(`\n${Object.keys(built).length} presets; budgets: builder ${BUILDER.meshes} meshes + ${BUILDER.lines} lines per look, flight props ${FLIGHT} extra draws per scene`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
