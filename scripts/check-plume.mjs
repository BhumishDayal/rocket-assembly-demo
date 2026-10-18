// Check for src/plume.js and src/silhouette.js: no NaN anywhere, plume width grows as ambient pressure falls,
// Mach diamonds fade with pressure, length grows with throttle, one plume per bell (twins get two), pad light
// follows throttle, silhouettes are true scale.
// Run: node scripts/check-plume.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { catalog, presetToBuild } = await import("../src/data/catalog.js");
const { buildManifest, SCALE } = await import("../src/layout.js");
const { createMaterials, createPart, bellExits } = await import("../src/parts.js");
const { attachPlumes, createPadLight, P0 } = await import("../src/plume.js");
const { createSilhouette } = await import("../src/silhouette.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const finite = (...v) => v.every((x) => Number.isFinite(x));
const PRESSURES = [P0, 50000, 10000, 0];
const THROTTLES = [0, 0.5, 1];
const mats = createMaterials();
let plumeCount = 0;

// 1. Plumes on every engines part of every preset.
for (const preset of catalog.presets) {
  for (const spec of buildManifest(presetToBuild(preset), catalog).filter((s) => s.kind === "engines")) {
    const part = createPart(spec, mats);
    const plumes = attachPlumes(part);
    plumeCount += plumes.length;
    const bells = spec.geom.positions.length * (spec.geom.chambers > 1 ? 2 : 1);
    expect(plumes.length === bells, `${preset.id}/${spec.id}: ${plumes.length} plumes for ${bells} bells`);
    expect(plumes.every((p) => p.object3d.parent === part.group), `${preset.id}/${spec.id}: plumes not attached to the part group`);
    for (const [i, b] of bellExits(spec).entries()) {
      const o = plumes[i].object3d.position;
      expect(finite(o.x, o.z, b.r) && o.y === 0 && b.r > 0, `${preset.id}/${spec.id}: bad bell exit ${i}`);
      expect(Math.hypot(o.x, o.z) <= spec.radius + 1e-6, `${preset.id}/${spec.id}: bell ${i} outside the part radius`);
    }
    const p = plumes[0];
    const at = (pressure, throttle) => {
      p.update(1 / 60, { throttle, ambientPressure_Pa: pressure, cameraDistance: 30 });
      const m = p.metrics;
      const mesh = p.object3d.children[0];
      const u = mesh.material.uniforms;
      const vals = [m.length_u, m.width_u, m.diamonds, mesh.scale.x, mesh.scale.y, mesh.scale.z, ...Object.values(u).map((x) => (typeof x.value === "number" ? x.value : 0))];
      expect(finite(...vals), `${preset.id}/${spec.id}: NaN at p=${pressure} thr=${throttle}`);
      return { ...m, visible: p.object3d.visible };
    };
    for (const thr of THROTTLES) {
      const series = PRESSURES.map((pr) => at(pr, thr));
      for (let k = 1; k < series.length; k++) {
        expect(series[k].width_u >= series[k - 1].width_u - 1e-9, `${preset.id}/${spec.id}: width shrinks as pressure falls (thr ${thr})`);
        expect(series[k].diamonds <= series[k - 1].diamonds + 1e-9, `${preset.id}/${spec.id}: diamonds grow as pressure falls (thr ${thr})`);
      }
      const ratio = series.at(-1).width_u / series[0].width_u;
      expect(ratio > 3 && ratio < 6.5, `${preset.id}/${spec.id}: vacuum/sea-level width ratio ${ratio.toFixed(2)} (want ~4–6)`);
      expect(series[0].diamonds > 0.95 && series.at(-1).diamonds === 0, `${preset.id}/${spec.id}: diamonds should be full at sea level and gone in vacuum`);
      expect(series.every((s) => s.visible === thr > 0), `${preset.id}/${spec.id}: visibility does not follow throttle ${thr}`);
    }
    for (const pr of PRESSURES) {
      const lens = THROTTLES.slice(1).map((thr) => at(pr, thr).length_u);
      expect(lens[1] > lens[0], `${preset.id}/${spec.id}: length does not grow with throttle at p=${pr}`);
    }
    for (const pl of plumes) pl.dispose();
  }
}

// 2. Pad light.
const pad = createPadLight({ baseRadius_u: 0.46 });
pad.update(0.016, 0);
expect(pad.light.intensity === 0 && !pad.object3d.visible, "pad light: should be off at throttle 0");
pad.update(0.016, 1);
const on = pad.light.intensity;
expect(finite(on) && on > 0 && pad.object3d.visible, "pad light: should be on at throttle 1");
pad.update(0.016, 1, { altitude_u: 50 });
expect(pad.light.intensity < on, "pad light: should fade as the rocket climbs");
// Deflected splash: full while the bells are within 2 exit radii of the deck (exit radius 0.115 u = 0.46 m →
// 0.92 m), fading out by 15 m; numeric altitude is metres.
const padS = createPadLight({ baseRadius_u: 0.46, bellExitRadius_u: 0.115 });
const splashAt = (alt_m, thr = 1) => (padS.update(0.016, thr, alt_m), padS.metrics.splash);
expect(splashAt(0) > 0.99 && splashAt(0.9) > 0.99, `splash: should be full near the deck (${splashAt(0).toFixed(2)})`);
expect(splashAt(5) > 0 && splashAt(5) < 1, "splash: should be fading at 5 m");
expect(splashAt(15) === 0 && !padS.splash.visible, "splash: should be gone by 15 m");
expect(splashAt(0, 0) === 0, "splash: should be off at throttle 0");
expect(splashAt(8) < splashAt(4), "splash: should fade as the rocket climbs");
expect(Number.isFinite(padS.metrics.light), "splash: NaN light");

// 3. Silhouettes at true scale.
for (const s of [
  { name: "Falcon 9", length_m: 70, diameter_m: 3.7, stages: 2 },
  { name: "Saturn V", length_m: 110.6, diameter_m: 10.1, stages: 3 },
  { name: "custom", length_m: 60, diameter_m: 4, stages: [{ length_m: 35 }, { diameter_m: 3 }] },
  { name: "single", length_m: 20, diameter_m: 1.5, stages: 1 },
]) {
  const sil = createSilhouette(s);
  const pos = sil.object3d.children[0].geometry.attributes.position;
  let maxY = -Infinity;
  let minY = Infinity;
  let maxR = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (!finite(x, y, z)) {
      failures.push(`${s.name}: NaN in silhouette`);
      break;
    }
    maxY = Math.max(maxY, y);
    minY = Math.min(minY, y);
    maxR = Math.max(maxR, Math.hypot(x, z));
  }
  expect(Math.abs(maxY - s.length_m * SCALE) < 1e-6 && Math.abs(minY) < 1e-9, `${s.name}: height ${maxY.toFixed(4)} u, want ${(s.length_m * SCALE).toFixed(4)}`);
  expect(maxR <= sil.radius_u + 1e-6 && Math.abs(sil.radius_u - (s.diameter_m / 2) * SCALE) < 1e-6, `${s.name}: radius ${maxR.toFixed(4)} u vs ${sil.radius_u.toFixed(4)}`);
  sil.dispose();
}

console.log(`plumes checked: ${plumeCount} across ${catalog.presets.length} presets; pad light + splash; 4 silhouettes`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
