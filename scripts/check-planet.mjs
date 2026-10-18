// Check for src/planet.js: no NaN, draw counts (photoreal planet ≤ 8, line-art planet ≤ 6, terrain ≤ 6 with the
// boulders instanced, ocean 1, surface patch 2, dust 1), sizes follow radius_u, self-rotation and sun direction,
// NASA maps resolve to files under src/assets/planets (≤ 6 MB, each listed in SOURCES.md), skyAt darkens with
// altitude, terrain flat at the landing spot and casting / receiving shadows, ocean bob ±0.3 m, dust lifecycle.
// Run: node scripts/check-planet.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";

// planet.js reaches catalog-free modules only, but launchfx → parts → layout may import JSON the Vite way.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { SCALE } = await import("../src/layout.js");
const { createPlanet, createSurfacePatch, createDustPuff, PLANET_MAPS, skyAt, createSkyDome, createTerrain, createOcean, enableShadowCasting } = await import("../src/planet.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const finiteAttr = (geo) => {
  const a = geo.attributes.position.array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};
const draws = (root) => {
  let n = 0;
  root.traverseVisible((o) => {
    if (o.isMesh || o.isLine || o.isPoints || o.isSprite) n++;
  });
  return n;
};
const maxR = (geo) => {
  const p = geo.attributes.position;
  let m = 0;
  for (let i = 0; i < p.count; i++) m = Math.max(m, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
  return m;
};

for (const kind of ["earth", "moon", "mars"]) {
  for (const radius_u of [40, 1.5]) {
    const id = `${kind} r=${radius_u}`;
    const p = createPlanet({ kind, radius_u, mode: "lineart" });
    const n = draws(p.object3d);
    expect(n <= 6 && n === (kind === "moon" ? 2 : 3), `${id}: ${n} draws`);
    p.object3d.traverse((o) => {
      if (o.geometry) expect(finiteAttr(o.geometry), `${id}: NaN in ${o.name}`);
      if (o.material) expect(o.material.fog === false, `${id}: ${o.name} uses fog`);
    });
    const body = p.object3d.getObjectByName("planet-body");
    const grat = p.object3d.getObjectByName("planet-graticule");
    const atmo = p.object3d.getObjectByName("planet-atmosphere");
    expect(Math.abs(maxR(body.geometry) - radius_u) < 1e-4 * radius_u, `${id}: body radius ${maxR(body.geometry)}`);
    expect(Math.abs(maxR(grat.geometry) - radius_u * 1.003) < 1e-4 * radius_u, `${id}: graticule radius`);
    expect(grat.parent === body, `${id}: graticule should turn with the body`);
    expect(Math.abs(grat.material.opacity - 0.12) < 1e-9, `${id}: graticule opacity`);
    if (kind !== "moon") expect(atmo && maxR(atmo.geometry) > radius_u && maxR(atmo.geometry) <= radius_u * 1.03 + 1e-6, `${id}: atmosphere shell`);
    else expect(!atmo, `${id}: the Moon has no atmosphere`);
    p.update(0);
    const r0 = body.rotation.y;
    p.update(100);
    expect(body.rotation.y !== r0 && Number.isFinite(body.rotation.y), `${id}: no self-rotation`);
    p.setSunDir(new THREE.Vector3(3, 4, 0));
    const s = body.material.uniforms.uSunDir.value;
    expect(Math.abs(s.length() - 1) < 1e-9 && Math.abs(s.x - 0.6) < 1e-9, `${id}: sun direction not normalised`);
    if (atmo) expect(atmo.material.uniforms.uSunDir.value === s, `${id}: atmosphere does not share the sun`);
    p.setSunDir(new THREE.Vector3(0, 0, 0));
    expect(Number.isFinite(s.x), `${id}: zero sun vector broke the uniform`);
    p.dispose();
  }
}

// Photoreal planets.
for (const kind of ["earth", "moon", "mars"]) {
  for (const radius_u of [40, 1.5]) {
    const id = `photoreal ${kind} r=${radius_u}`;
    const p = createPlanet({ kind, radius_u, mode: "photoreal" });
    const n = draws(p.object3d);
    const want = { earth: 3, mars: 2, moon: 1 }[kind];
    expect(p.mode === "photoreal" && n === want && n <= 8, `${id}: ${n} draws, want ${want}`);
    p.object3d.traverse((o) => {
      if (o.geometry) expect(finiteAttr(o.geometry), `${id}: NaN in ${o.name}`);
      if (o.material) expect(o.material.fog === false, `${id}: ${o.name} uses fog`);
    });
    const body = p.object3d.getObjectByName("planet-body");
    const clouds = p.object3d.getObjectByName("planet-clouds");
    const atmo = p.object3d.getObjectByName("planet-atmosphere");
    expect(Math.abs(maxR(body.geometry) - radius_u) < 1e-4 * radius_u, `${id}: body radius`);
    expect(kind === "earth" ? clouds && maxR(clouds.geometry) > radius_u && maxR(clouds.geometry) < radius_u * 1.02 : !clouds, `${id}: cloud sphere`);
    expect(kind === "moon" ? !atmo : atmo && atmo.material.side === THREE.BackSide && atmo.material.blending === THREE.AdditiveBlending, `${id}: atmosphere shell`);
    p.update(0);
    const r0 = body.rotation.y;
    p.update(100);
    expect(body.rotation.y !== r0 && Number.isFinite(body.rotation.y), `${id}: no self-rotation`);
    if (clouds) expect(clouds.rotation.y > body.rotation.y, `${id}: clouds should drift over the ground`);
    p.setSunDir(new THREE.Vector3(3, 4, 0));
    const s = body.material.uniforms.uSunDir.value;
    expect(Math.abs(s.length() - 1) < 1e-9 && Math.abs(s.x - 0.6) < 1e-9, `${id}: sun direction not normalised`);
    if (atmo) expect(atmo.material.uniforms.uSunDir.value === s, `${id}: atmosphere does not share the sun`);
    if (clouds) expect(clouds.material.uniforms.uSunDir.value === s, `${id}: clouds do not share the sun`);
    p.setSunDir(new THREE.Vector3(0, 0, 0));
    expect(Number.isFinite(s.x), `${id}: zero sun vector broke the uniform`);
    for (const m of [body, clouds, atmo].filter(Boolean))
      for (const [k, { value }] of Object.entries(m.material.uniforms)) if (typeof value === "number") expect(Number.isFinite(value), `${id}: NaN ${m.name}.${k}`);
    p.dispose();
  }
}

expect(createPlanet({ kind: "moon", radius_u: 1 }).mode === "photoreal", "createPlanet should default to photoreal");

// NASA maps: every URL is a file in src/assets/planets, ≤ 6 MB in all, each listed in SOURCES.md.
{
  let bytes = 0;
  const dir = fileURLToPath(new URL("../src/assets/planets/", import.meta.url));
  const sources = existsSync(dir + "SOURCES.md") ? readFileSync(dir + "SOURCES.md", "utf8") : "";
  expect(sources, "assets: src/assets/planets/SOURCES.md missing");
  for (const [name, url] of Object.entries(PLANET_MAPS)) {
    const file = fileURLToPath(url);
    expect(dirname(file) + "/" === dir, `assets: ${name} resolves outside src/assets/planets`);
    if (!existsSync(file)) {
      failures.push(`assets: ${basename(file)} missing`);
      continue;
    }
    bytes += statSync(file).size;
    expect(sources.includes(basename(file)), `assets: ${basename(file)} not listed in SOURCES.md`);
  }
  expect(bytes <= 6 * 1024 * 1024, `assets: ${(bytes / 1048576).toFixed(2)} MB, budget 6 MB`);
  console.log(`maps: ${Object.keys(PLANET_MAPS).length} files, ${(bytes / 1048576).toFixed(2)} MB`);
}

// Sky: darker and starrier with altitude on Earth and Mars, black on the Moon, a warm low sun on Earth.
{
  const noon = new THREE.Vector3(0, 1, 0.3).normalize();
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  for (const body of ["earth", "mars"]) {
    const a = skyAt(0, noon, body);
    const b = skyAt(30000, noon, body);
    const c = skyAt(150000, noon, body);
    expect(lum(a.zenith) > lum(b.zenith) && lum(b.zenith) > lum(c.zenith) && c.stars > a.stars, `sky ${body}: should darken with altitude`);
    expect([a, b, c].every((x) => [x.zenith, x.horizon].every((k) => [k.r, k.g, k.b].every(Number.isFinite)) && Number.isFinite(x.stars)), `sky ${body}: NaN`);
  }
  expect(skyAt(0, noon, "earth").zenith.b > skyAt(0, noon, "earth").zenith.r, "sky earth: zenith should be blue");
  expect(skyAt(0, noon, "mars").horizon.r > skyAt(0, noon, "mars").horizon.b, "sky mars: should be butterscotch");
  const dusk = skyAt(0, new THREE.Vector3(1, 0.02, 0), "earth").horizon;
  expect(dusk.r > dusk.b, "sky earth: low sun should warm the horizon");
  const moon = skyAt(0, noon, "moon");
  expect(lum(moon.zenith) === 0 && moon.stars === 1, "sky moon: should be black");
}

// Sky dome: 1 draw, follows the camera, takes skyAt colours.
{
  const d = createSkyDome({ radius_u: 900 });
  expect(draws(d.object3d) === 1 && d.object3d.children[0].material.fog === false && d.object3d.children[0].material.depthWrite === false, "sky dome: 1 draw, no fog, no depth write");
  d.set(skyAt(2000, new THREE.Vector3(0, 1, 0), "mars"), new THREE.Vector3(1, 1, 0));
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  cam.position.set(5, 6, 7);
  d.update(cam);
  expect(d.object3d.position.equals(cam.position), "sky dome should follow the camera");
  const u = d.object3d.children[0].material.uniforms;
  expect([u.uZenith.value, u.uHorizon.value].every((c) => [c.r, c.g, c.b].every(Number.isFinite)) && Math.abs(u.uSunDir.value.length() - 1) < 1e-9, "sky dome uniforms");
  d.dispose();
}

// Terrain: ≥ 200 × 200 segments, flat landing spot, finite heights, shadows, instanced boulders off the spot.
for (const body of ["moon", "mars"]) {
  const size_u = 60;
  const padRadius_u = 2;
  const t = createTerrain({ body, size_u, seed: 7, padRadius_u });
  const n = draws(t.object3d);
  const ground = t.object3d.getObjectByName("terrain-ground");
  const rocks = t.object3d.getObjectByName("terrain-boulders");
  expect(n <= 6 && rocks?.isInstancedMesh && rocks.count > 50, `terrain ${body}: ${n} draws, ${rocks?.count} boulders`);
  expect(ground.geometry.parameters.widthSegments >= 200 && ground.geometry.parameters.heightSegments >= 200, `terrain ${body}: too few segments`);
  expect(finiteAttr(ground.geometry), `terrain ${body}: NaN in the ground`);
  expect(ground.receiveShadow && ground.castShadow && rocks.castShadow && rocks.receiveShadow, `terrain ${body}: shadows`);
  expect(t.sun.isDirectionalLight && t.sun.castShadow && t.sun.shadow.mapSize.x >= 2048, `terrain ${body}: sun light`);
  expect(t.sun.position.y > 0 && t.sun.parent === t.object3d && t.sun.target.parent === t.object3d, `terrain ${body}: sun should be up, inside the terrain and aimed at it`);
  let maxSpot = 0;
  let relief = 0;
  for (let i = 0; i < 400; i++) {
    const a = i * 2.39996;
    const r = padRadius_u * Math.sqrt(i / 400);
    maxSpot = Math.max(maxSpot, Math.abs(t.heightAt(r * Math.cos(a), r * Math.sin(a))));
    const x = (Math.sin(i * 12.9898) * 0.5) * size_u;
    const z = (Math.cos(i * 78.233) * 0.5) * size_u;
    relief = Math.max(relief, Math.abs(t.heightAt(x, z)));
  }
  expect(maxSpot < 1e-9, `terrain ${body}: landing spot not flat (${maxSpot})`);
  expect(relief > 0.5 * SCALE && relief < 20 * SCALE, `terrain ${body}: relief ${(relief / SCALE).toFixed(1)} m`);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let onSpot = 0;
  for (let i = 0; i < rocks.count; i++) {
    rocks.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    if (Math.hypot(p.x, p.z) < padRadius_u * 1.4) onSpot++;
    if (![p.x, p.y, p.z].every(Number.isFinite)) failures.push(`terrain ${body}: NaN boulder`);
  }
  expect(onSpot === 0, `terrain ${body}: ${onSpot} boulders on the landing spot`);
  const g = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry()), new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry())));
  enableShadowCasting(g);
  let casts = 0;
  g.traverse((o) => o.isMesh && o.castShadow && casts++);
  expect(casts === 2, "enableShadowCasting should reach every mesh");
  t.dispose();
}

// Ocean: 1 draw, fog, finite uniforms, ship bob ±0.3 m.
{
  const o = createOcean({ size_u: 4000 });
  expect(draws(o.object3d) === 1, `ocean: ${draws(o.object3d)} draws`);
  const mesh = o.object3d.getObjectByName("ocean");
  const water = mesh.isMesh ? mesh : mesh.children[0];
  expect(water.material.fog === true && !water.castShadow, "ocean: fog on, no shadow");
  o.update(0.5, { sky: skyAt(0, new THREE.Vector3(0, 1, 0), "earth"), sunDir: new THREE.Vector3(1, 1, 0) });
  o.setHull({ position: new THREE.Vector3(3, 0, 4), length_u: 20, width_u: 11, yaw: 0.3 });
  const hu = water.material.uniforms.uHull.value;
  expect(hu.x === 3 && hu.y === 4 && hu.z === 10 && hu.w === 5.5 && water.material.uniforms.uFoamW.value > 0, "ocean: setHull");
  o.setHull(null);
  expect(water.material.uniforms.uHull.value.z === 0, "ocean: setHull(null) should clear the foam");
  for (const [k, { value }] of Object.entries(water.material.uniforms)) {
    const v = typeof value === "number" ? [value] : value?.isColor ? [value.r, value.g, value.b] : value?.isVector3 ? [value.x, value.y, value.z] : [];
    expect(v.every(Number.isFinite), `ocean: NaN ${k}`);
  }
  let maxY = 0;
  for (let t = 0; t < 60; t += 0.1) maxY = Math.max(maxY, Math.abs(o.bob(t).y));
  expect(maxY >= 0.25 * SCALE && maxY <= 0.38 * SCALE + 1e-9, `ocean: ship heave ${(maxY / SCALE).toFixed(2)} m`);
  o.dispose();
}

for (const kind of ["moon", "mars", "earth"]) {
  const R = 12;
  const patch = createSurfacePatch({ kind, radius_u: R });
  expect(draws(patch.object3d) === 2, `surface ${kind}: ${draws(patch.object3d)} draws`);
  const lines = patch.object3d.getObjectByName("surface-lines");
  const pos = lines.geometry.attributes.position;
  expect(finiteAttr(lines.geometry), `surface ${kind}: NaN`);
  expect(lines.material.fog === true && Math.abs(lines.material.opacity - 0.2) < 1e-9, `surface ${kind}: line material`);
  let outside = 0;
  let inSpot = 0;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    if (r > R + 1e-6) outside++;
    if (kind !== "earth" && r < 0.12 * R - 1e-6) inSpot++;
  }
  expect(outside === 0, `surface ${kind}: ${outside} line points outside the patch`);
  expect(inSpot === 0, `surface ${kind}: ${inSpot} line points on the landing spot`);
  expect(pos.count > 100 || kind === "earth", `surface ${kind}: too few features (${pos.count / 2} segments)`);
  expect(patch.object3d.getObjectByName("surface-ground").receiveShadow, `surface ${kind}: ground should receive shadows`);
  patch.dispose();
}

const dust = createDustPuff();
expect(!dust.active() && draws(dust.object3d) === 0, "dust: should start hidden");
dust.fire({ position: new THREE.Vector3(1, 2, 3), radius: 0.8 });
expect(dust.active() && draws(dust.object3d) === 1 && dust.object3d.position.y === 2, "dust: fire should show it at the position");
let t = 0;
while (dust.active() && t < 5) (dust.update(1 / 60), (t += 1 / 60));
expect(t > 0.9 && t < 1.1, `dust: lasted ${t.toFixed(2)} s, want ~1`);
const u = dust.object3d.children[0].material.uniforms;
expect(Object.values(u).every((x) => typeof x.value !== "number" || Number.isFinite(x.value)), "dust: NaN uniform");
dust.dispose();

console.log("planets: 3 kinds × 2 sizes × 2 modes; sky; terrain: 2 bodies; ocean; surface patches: 3; dust puff");
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
