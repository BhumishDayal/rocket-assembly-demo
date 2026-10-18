// Check for src/planet.js: no NaN, draw counts (planet ≤ 6, surface patch 2, dust 1), sizes follow radius_u,
// self-rotation and sun direction, surface features inside the patch with the landing spot clear, dust puff
// lifecycle (~1 s), fog off on planets and on for the surface lines.
// Run: node scripts/check-planet.mjs   (no deps; exits 1 on any failure)
const THREE = await import("three");
const { createPlanet, createSurfacePatch, createDustPuff } = await import("../src/planet.js");

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
    const p = createPlanet({ kind, radius_u });
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

console.log("planets: 3 kinds × 2 sizes; surface patches: 3; dust puff");
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
