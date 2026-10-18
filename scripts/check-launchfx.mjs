// Check for src/fx/launchfx.js (+ the planet.js shadow decal): every effect at full and half intensity over its
// timeline has no NaN, shows and hides on its documented schedule, casts no shadows, and everything active at
// once stays within 25 draws. Weather (round 18): wind drift on the vents, steam, deluge mist and cold-gas puffs,
// the plume lean, the aurora (2 draws, intensity) and the lightning strike (3 draws, ~1.2 s).
// Shaders are compiled by the browser harnesses (scripts/fx-harness.html, scripts/far-harness.html), not here.
// Run: node scripts/check-launchfx.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { SCALE } = await import("../src/layout.js");
const { createPad } = await import("../src/parts.js");
const { createShadowDecal } = await import("../src/planet.js");
const FX = await import("../src/fx/launchfx.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const finiteUniforms = (root, label) => {
  root.traverse((o) => {
    const u = o.material?.uniforms;
    if (!u) return;
    for (const [k, { value }] of Object.entries(u)) {
      const vals = typeof value === "number" ? [value] : Array.isArray(value) ? value.flatMap((x) => (typeof x === "number" ? [x] : [x.x, x.y, x.z ?? 0])) : value?.isColor ? [value.r, value.g, value.b] : value?.isVector3 || value?.isVector2 ? [value.x, value.y, value.z ?? 0] : [];
      if (!vals.every(Number.isFinite)) failures.push(`${label}: NaN in ${o.name}.${k}`);
    }
  });
};
const draws = (root) => {
  let n = 0;
  root.traverseVisible((o) => (o.isMesh || o.isLine || o.isPoints || o.isSprite) && n++);
  return n;
};
const run = (fx, seconds, params, dt = 1 / 30) => {
  for (let t = 0; t < seconds; t += dt) fx.update(dt, typeof params === "function" ? params(t) : params);
};

const layout = createPad({ baseRadius_u: 0.458 }).layout;
const ports = [{ position: new THREE.Vector3(0.5, 10, 0) }, { position: new THREE.Vector3(0, 13, 0.5), dir: new THREE.Vector3(0, 0, 1) }];

for (const k of [1, 0.5]) {
  const L = `k=${k}`;
  const all = [];
  const vents = FX.createVents(ports, { scale_u: 0.4 });
  run(vents, 1, { intensity: k });
  expect(vents.object3d.visible, `${L} vents should show`);
  vents.update(0.1, { intensity: 0 });
  expect(!vents.object3d.visible, `${L} vents should hide at intensity 0`);
  vents.update(0.1, { intensity: k });
  all.push(vents);

  const deluge = FX.createDeluge({ layout });
  deluge.update(0, { t: 3, intensity: k });
  expect(deluge.object3d.visible, `${L} deluge should show at t 3`);
  deluge.update(0, { t: 13.5, intensity: k });
  expect(!deluge.object3d.visible, `${L} deluge should be gone by t 13`);
  deluge.update(0, { t: 4, intensity: k });
  all.push(deluge);

  const jet = FX.createTrenchJet({ layout });
  jet.update(0.1, { throttle: k, bellHeight_m: 0 });
  expect(jet.object3d.visible, `${L} trench jet should show with the bells low`);
  jet.update(0.1, { throttle: k, bellHeight_m: 31 });
  expect(!jet.object3d.visible, `${L} trench jet should be gone by 30 m`);
  jet.update(0.1, { throttle: k, bellHeight_m: 2 });
  expect(Math.abs(Math.hypot(jet.object3d.position.x, jet.object3d.position.z) - layout.padR * 1.02) < 1e-6, `${L} trench jet not at the trench exit`);
  all.push(jet);

  const steam = FX.createSteamCloud({ layout });
  steam.update(0.1, { t: 5, glow: k, intensity: k });
  expect(steam.object3d.visible, `${L} steam should show at t 5`);
  steam.update(0.1, { t: 14.5, glow: k, intensity: k });
  expect(!steam.object3d.visible, `${L} steam should be gone by 14 s`);
  steam.update(0.1, { t: 6, glow: k, intensity: k });
  all.push(steam);

  const halo = FX.createCondensationHalo({ radius_u: 0.46, length_u: 2.5 });
  halo.fire();
  run(halo, 0.4, { intensity: k });
  expect(halo.object3d.visible, `${L} halo should show 0.4 s after fire`);
  run(halo, 0.5, { intensity: k });
  expect(!halo.object3d.visible, `${L} halo should be gone after 0.8 s`);
  halo.fire();
  halo.update(0.2, { intensity: k });
  all.push(halo);

  const puffs = FX.createColdGasPuffs({ scale_u: 0.3 });
  puffs.fire({ position: new THREE.Vector3(0, 10, 0), dir: new THREE.Vector3(1, 0, 0) });
  run(puffs, 0.3);
  expect(puffs.object3d.visible, `${L} puff should show at 0.3 s`);
  run(puffs, 0.4);
  expect(!puffs.object3d.visible, `${L} puff should be gone after 0.55 s`);
  for (let i = 0; i < 10; i++) puffs.fire({ position: new THREE.Vector3(i, 0, 0), dir: new THREE.Vector3(0, 1, 0) });
  puffs.update(0.1);
  all.push(puffs);

  const flash = FX.createIgnitionFlash();
  flash.fire({ position: new THREE.Vector3(0, 12, 0), kind: "tea-teb" });
  run(flash, 0.3);
  expect(flash.active(), `${L} TEA-TEB flash should be active at 0.3 s`);
  run(flash, 0.2);
  expect(!flash.active(), `${L} TEA-TEB flash should end at 0.4 s`);
  flash.fire({ position: new THREE.Vector3(0, 12, 0), kind: "meco" });
  run(flash, 0.8);
  expect(flash.active(), `${L} MECO sparks should still be active at 0.8 s`);
  flash.fire({ position: new THREE.Vector3(0, 12, 0), kind: "meco" });
  flash.update(0.1);
  all.push(flash);

  const plasma = FX.createPlasmaGlow({ radius_u: 0.46, length_u: 3 });
  plasma.update(0.1, { intensity: 0 });
  expect(!plasma.object3d.visible, `${L} plasma should hide at 0`);
  plasma.update(0.1, { intensity: k });
  expect(plasma.object3d.visible, `${L} plasma should show`);
  all.push(plasma);

  const clouds = FX.createCloudLayer({ altitude_u: 40, radius_u: 60 });
  clouds.update(0.1, { intensity: k });
  all.push(clouds);

  const sea = FX.createSea({ radius_u: 80 });
  sea.update(0.5);
  let maxY = 0;
  let maxR = 0;
  for (let t = 0; t < 60; t += 0.1) {
    const b = sea.bob(t);
    maxY = Math.max(maxY, Math.abs(b.y));
    maxR = Math.max(maxR, Math.abs(b.rx), Math.abs(b.rz));
  }
  expect(maxY <= 0.38 * SCALE + 1e-9 && maxY >= 0.25 * SCALE, `${L} ship heave ${(maxY / SCALE).toFixed(2)} m, want ±0.3 m`);
  expect(maxR < (2 * Math.PI) / 180, `${L} ship roll too large`);
  expect(sea.object3d.getObjectByName("fx-sea-waves").material.fog, `${L} sea lines should use fog`);
  all.push(sea);

  const dust = FX.createLunarDust({ radius_u: 4 });
  dust.update(0.1, { throttle: k, altitude_m: 40 });
  const far = dust.object3d.children[0].material.uniforms.uS.value;
  dust.update(0.1, { throttle: k, altitude_m: 5 });
  const near = dust.object3d.children[0].material.uniforms.uS.value;
  expect(far === 0 && near > 0.3 * k, `${L} lunar dust should grow below 30 m (${far} → ${near})`);
  dust.update(0.5, { throttle: 0, altitude_m: 0 });
  const s1 = dust.object3d.children[0].material.uniforms.uS.value;
  dust.update(3, { throttle: 0, altitude_m: 0 });
  const s2 = dust.object3d.children[0].material.uniforms.uS.value;
  expect(s1 > s2 && s1 < near, `${L} lunar dust should settle after cut-off`);
  dust.update(0.1, { throttle: k, altitude_m: 8 });
  all.push(dust);

  const map = FX.createGroundMap({ size_u: 4000, y_u: -layout.plinthH - 0.01 });
  const mp = map.object3d.children[0].geometry.attributes.position;
  expect(mp.count > 200 && Array.from(mp.array).every(Number.isFinite), `${L} ground map lines`);
  expect(map.object3d.children[0].material.fog, `${L} ground map should use fog`);
  all.push(map);

  // Weather: wind drift (12 m/s from the west → +x), plume lean, aurora, lightning.
  const wind = new THREE.Vector3(12, 0, -3);
  const wv = FX.createVents(ports, { scale_u: 0.4 });
  wv.update(0.1, { intensity: k, wind_ms: wind });
  expect(wv.object3d.children[0].material.uniforms.uWind.value.distanceTo(wind.clone().multiplyScalar(SCALE)) < 1e-9, `${L} vents wind`);
  const ws = FX.createSteamCloud({ layout });
  ws.update(0.1, { t: 5, glow: k, intensity: k, wind_ms: [12, 0, -3] });
  expect(ws.object3d.children[0].material.uniforms.uWind.value.x > 0, `${L} steam wind`);
  const wd = FX.createDeluge({ layout });
  wd.update(0.1, { t: 4, intensity: k, wind_ms: wind });
  const du = wd.object3d.children[0].material.uniforms;
  expect(du.uWindOff.value.x > 0 && du.uWindOff.value.length() <= layout.padR * 0.8 + 1e-9 && du.uMist.value > 0, `${L} deluge mist downwind`);
  const wp = FX.createColdGasPuffs({ scale_u: 0.3 });
  wp.update(0.1, { wind_ms: wind });
  expect(wp.object3d.children[0].material.uniforms.uWind.value.x > 0, `${L} puffs wind`);
  for (const fx of [wv, ws, wd, wp]) fx.dispose();
  const plumeParent = new THREE.Group();
  const plumeObj = new THREE.Group();
  plumeParent.add(plumeObj);
  const lean = FX.plumeLean(plumeObj, wind, 0);
  const tail = new THREE.Vector3(0, -1, 0).applyQuaternion(plumeObj.quaternion);
  expect(lean > 0 && lean <= (10 * Math.PI) / 180 + 1e-9 && tail.x > 0, `${L} plume leans downwind (${((lean * 180) / Math.PI).toFixed(1)}°)`);
  expect(FX.plumeLean(plumeObj, wind, 6000) === 0 && plumeObj.quaternion.angleTo(new THREE.Quaternion()) < 1e-9, `${L} no lean by 6 km`);
  const aurora = FX.createAurora();
  expect(!aurora.object3d.visible, `${L} aurora starts hidden`);
  aurora.setIntensity(k);
  aurora.update(0.5);
  expect(aurora.object3d.visible && draws(aurora.object3d) === 2, `${L} aurora: 2 draws when on`);
  aurora.setIntensity(0);
  expect(!aurora.object3d.visible, `${L} aurora hides at 0`);
  aurora.setIntensity(k);
  const bolt = FX.createLightning();
  expect(!bolt.object3d.visible, `${L} lightning starts hidden`);
  bolt.fire({ azimuth: 70, distance_km: 9, seed: 5 });
  bolt.update(0.02);
  const bg = bolt.object3d.getObjectByName("fx-lightning-bolt").geometry.attributes.position;
  expect(bolt.active() && draws(bolt.object3d) === 3 && bg.count > 50 && Array.from(bg.array).every(Number.isFinite), `${L} lightning strike`);
  const at = bolt.object3d.getObjectByName("fx-lightning-glow").position;
  expect(Math.abs(Math.hypot(at.x, at.z) - 9 * 1000 * SCALE) < 1e-6 && at.x > 0 && at.z < 0, `${L} strike at 70° (ENE), 9 km`);
  bolt.update(1.3);
  expect(!bolt.active() && !bolt.object3d.visible, `${L} lightning over by 1.2 s`);
  bolt.fire({ azimuth: 70, distance_km: 9 });
  bolt.update(0.02);
  all.push(aurora, bolt);

  const decal = createShadowDecal({ radius_u: 0.6 });
  const sun = new THREE.Vector3(-0.5, 0.7, 0.3).normalize();
  decal.update({ position: new THREE.Vector3(0, 0, 0), altitude_u: 0, sunDir: sun });
  const a0 = decal.object3d.children[0].material.uniforms.uA.value;
  decal.update({ position: new THREE.Vector3(0, 0, 0), altitude_u: 4, sunDir: sun });
  const a1 = decal.object3d.children[0].material.uniforms.uA.value;
  expect(a1 < a0 && decal.object3d.position.x > 0, `${L} shadow decal should fade and fall away from the sun`);
  all.push(decal);

  // Everything active at once: draws, shadows, NaN.
  const root = new THREE.Group();
  for (const fx of all) root.add(fx.object3d);
  const n = draws(root);
  expect(n <= 25, `${L} ${n} draws with every effect active (budget 25)`);
  root.traverse((o) => o.castShadow && failures.push(`${L} ${o.name} casts a shadow`));
  finiteUniforms(root, L);
  console.log(`${L}: ${all.length} effects active, ${n} draws`);
  for (const fx of all) fx.dispose();
}

if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
