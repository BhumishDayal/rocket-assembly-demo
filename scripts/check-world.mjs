// Check for src/world.js (the far layer): bodies at their real sizes and distance in 10 km units, the Cape on
// top of the Earth with the pad frame as the world frame, landing sites lit at lightingFor's sun elevation, the
// viewer's constants precise at 2 m above the pad, far-to-near draw order, one draw per body, the round-17
// night sky (dark, deep blue haze below ~30 km, nothing warm), local ground in its site frame, the cloud deck,
// no NaN anywhere. Shaders are compiled by scripts/far-harness.html, not here.
// Run: node scripts/check-world.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { createWorld, KM_PER_UNIT } = await import("../src/world.js");
const { lightingFor } = await import("../src/arrival.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const finite = (...xs) => xs.flat().every(Number.isFinite);
const w = createWorld();
const { earth, moon, mars } = w.bodies;

// Sizes and placement.
expect(KM_PER_UNIT === 10, "1 unit = 10 km");
expect(earth.center_km.length() === 0 && Math.abs(moon.center_km.length() - 384400) < 1e-6, "Earth at the origin, the Moon at 384 400 km");
expect(Math.abs(earth.R - 637.1) < 1e-9 && Math.abs(moon.R - 173.74) < 1e-9 && Math.abs(mars.R - 338.95) < 1e-9, "body radii in units");
w.setDestination("mars", new THREE.Vector3(1, 2, 3).normalize().multiplyScalar(7.5e7));
expect(Math.abs(mars.center_km.length() - 7.5e7) < 1e-3, "setDestination");

// The Cape: world +y is up there, +x east, +z south (the near layer's pad frame).
const cape = w.landingSite("earth");
expect(cape.frame.angleTo(new THREE.Quaternion()) < 1e-6 && Math.abs(cape.lat - 28.5) < 1e-6 && Math.abs(cape.lon + 80.6) < 1e-6, `Cape frame / lat ${cape.lat} lon ${cape.lon}`);
// Body-fixed lookups: world +y at the origin is the Cape; Earth's north tilts toward −z (north) by the latitude.
const toLL = (m, v) => {
  const b = v.clone().applyMatrix3(m).normalize();
  return [Math.asin(b.z) / (Math.PI / 180), Math.atan2(b.y, b.x) / (Math.PI / 180)];
};
const [la, lo] = toLL(earth.toBody, new THREE.Vector3(0, 1, 0));
expect(Math.abs(la - 28.5) < 1e-6 && Math.abs(lo + 80.6) < 1e-6, "world up = the Cape on the Earth map");

// Night launch: the sun below the Cape's horizon; landing sites lit at lightingFor's elevation.
expect(w.sunDir.y < -0.3 && Math.abs(w.sunDir.length() - 1) < 1e-9, `night sun ${w.sunDir.toArray()}`);
for (const b of ["moon", "mars"]) {
  const s = w.landingSite(b);
  const el = Math.asin(s.up.dot(w.sunDir)) / (Math.PI / 180);
  expect(Math.abs(el - lightingFor(b).sunElevation_deg) < 1e-6, `${b} site sun elevation ${el.toFixed(3)}`);
  expect(Math.abs(s.pos_km.length() - w.bodies[b].radius_km) < 1e-6 && Math.abs(s.east.dot(s.up)) < 1e-9 && Math.abs(s.south.dot(s.up)) < 1e-9, `${b} site frame`);
  if (b === "moon") expect(s.up.dot(earth.center_km.clone().sub(moon.center_km).normalize()) > 0, "Moon site on the near side");
}

// Viewer on the pad, 2 m up: draw order far → near, exact constants, finite uniforms.
w.setViewer({ body: "earth", pos_km: new THREE.Vector3(0, earth.radius_km + 0.002, 0), quaternion: new THREE.Quaternion() });
w.update();
const ro = (b) => b.mesh.renderOrder;
expect(ro(mars) < ro(moon) && ro(moon) < ro(earth), "draw order far → near");
const u = earth.uniforms;
const want = 2 * earth.R * 0.0002 + 0.0002 ** 2;
expect(Math.abs(u.uDCC.value.x - want) < 1e-6 * want + 1e-9 && u.uNearMode.value === 1, `pad: D²−R² ${u.uDCC.value.x} want ${want}`);
expect(moon.uniforms.uNearMode.value === 0 && mars.uniforms.uNearMode.value === 0, "far bodies use the cross-product form");
for (const b of [earth, moon, mars]) {
  for (const [k, { value }] of Object.entries(b.uniforms)) {
    const vals = typeof value === "number" ? [value] : value?.isVector3 ? value.toArray() : value?.isMatrix3 ? value.elements : [];
    expect(finite(vals), `NaN in ${b.name}.${k}`);
  }
  expect(b.mesh.material.depthTest === false && b.mesh.material.side === THREE.BackSide, `${b.name}: proxy material`);
}
let draws = 0;
w.scene.traverseVisible((o) => (o.isMesh || o.isPoints || o.isSprite) && draws++);
expect(draws === 5, `${draws} far draws, want 5 (3 bodies, stars, sun)`);
// Viewer high and far: the same holds.
for (const alt of [100, 2000, 400000]) {
  w.setViewer({ body: "earth", pos_km: new THREE.Vector3(0, earth.radius_km + alt, 0) });
  w.update();
  expect(finite(earth.uniforms.uDir.value.toArray(), earth.uniforms.uDist.value) && Math.abs(earth.uniforms.uDist.value - (earth.radius_km + alt) / 10) < 1e-6, `viewer at ${alt} km`);
}

// Night sky (round 17): dark, blue-dominant (never warm), haze fading to black by ~30 km.
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
for (const alt of [0, 5, 15, 30, 100]) {
  const s = w.skyAt("earth", alt);
  for (const c of [s.zenith, s.horizon, s.haze]) expect(c.b >= c.g && c.g >= c.r && lum(c) < 0.05, `earth sky at ${alt} km not night-blue: ${c.toArray()}`);
  expect(s.stars === 1, "stars on the Earth night sky");
}
expect(lum(w.skyAt("earth", 0).haze) > 0 && lum(w.skyAt("earth", 30).haze) === 0 && lum(w.skyAt("earth", 5).haze) < lum(w.skyAt("earth", 0).haze), "haze band fades by 30 km");
expect(lum(w.skyAt("moon", 0).zenith) === 0, "Moon sky black");
const ms = w.skyAt("mars", 0);
expect(ms.horizon.r > ms.horizon.b, "Mars sky dusty");
expect(w.atmosphereLimb("moon") === null && w.atmosphereLimb("earth").scaleHeight_km === 8.5, "atmosphere limbs");

// Local ground: site frame, placement, albedo; cloud deck.
for (const b of ["moon", "mars", "earth"]) {
  const site = w.landingSite(b);
  const g = w.createLocalGround({ body: b, pos_km: site.pos_km, size_km: 0.3 });
  expect(g.kind === (b === "earth" ? "ground" : "terrain") && g.frame.angleTo(site.frame) < 1e-6, `${b} local ground ${g.kind}`);
  const origin = g.surface_km.clone().addScaledVector(g.up, 0.5); // near origin 500 m above the spot
  g.place(origin);
  expect(Math.abs(g.object3d.position.y + 0.5 * 250) < 1e-6 && Math.abs(g.object3d.position.x) < 1e-6 && Math.abs(g.object3d.position.z) < 1e-6, `${b} ground placed 500 m below the origin (${g.object3d.position.toArray()})`);
  const c = w.surfaceColourAt(b, g.lat, g.lon);
  expect(finite(c.r, c.g, c.b), `${b} albedo`);
  g.dispose();
}
// flight.js frame: the Cape (28.5 N, 80.6 W) in ECI maps to world +y; the Earth's axis to world north; the
// Moon placed from ECI; a site sun at the requested elevation.
const cos = Math.cos, sin = Math.sin, rad = Math.PI / 180;
const capeECI = [cos(28.5 * rad) * cos(-80.6 * rad), cos(28.5 * rad) * sin(-80.6 * rad), sin(28.5 * rad)].map((x) => x * 6371);
const cw = w.fromECI(capeECI);
expect(Math.abs(cw.x) < 1e-6 && Math.abs(cw.y - 6371) < 1e-6 && Math.abs(cw.z) < 1e-6, `Cape from ECI → ${cw.toArray()}`);
expect(w.toECI(cw).distanceTo(new THREE.Vector3(...capeECI)) < 1e-6, "toECI inverts fromECI");
const axis = w.fromECI([0, 0, 1]);
expect(Math.abs(axis.y - sin(28.5 * rad)) < 1e-9 && axis.z < 0 && Math.abs(axis.x) < 1e-9, "Earth's axis tilts north (−z) by the latitude");
expect(new THREE.Vector3(0, 0, 1).applyQuaternion(w.eciFrame).distanceTo(axis) < 1e-9, "eciFrame rotates ECI axes into world axes");
w.setBodyECI("moon", [384400, 0, 0]);
expect(moon.center_km.distanceTo(w.fromECI([384400, 0, 0])) < 1e-6, "setBodyECI");
w.setViewerECI({ eci_km: capeECI.map((x) => x * (6371.002 / 6371)), quaternion: new THREE.Quaternion() });
w.update();
const want2m = 2 * earth.R * 0.0002 + 0.0002 ** 2; // 2 m up: D² − R² in units²
expect(earth.uniforms.uNearMode.value === 1 && Math.abs(earth.uniforms.uDCC.value.x - want2m) < 1e-3 * want2m, `viewer from ECI on the pad (${earth.uniforms.uDCC.value.x} want ${want2m})`);
const site = new THREE.Vector3(1, 2, -0.5).normalize().multiplyScalar(moon.radius_km);
const sd = w.sunForSite("moon", site, 12);
expect(Math.abs(Math.asin(sd.dot(site.clone().normalize())) / rad - 12) < 1e-6 && Math.abs(sd.length() - 1) < 1e-9, "sunForSite elevation");
w.setSunDir(sd);
expect(w.sunDir.distanceTo(sd) < 1e-12 && w.sunLight.position.clone().normalize().distanceTo(sd) < 1e-9, "setSunDir");

// Cost controls: a stub renderer records the passes. Scale 1: one pass; scale 0.5: the bodies into a half-size
// target, then sky, composite and effects; disabled: only the clear.
{
  const calls = [];
  const stub = {
    autoClear: true,
    getDrawingBufferSize: (v) => v.set(800, 600),
    setRenderTarget: (t) => calls.push(["target", t ? `${t.width}x${t.height}` : "screen"]),
    setClearColor: () => {},
    clear: () => calls.push(["clear"]),
    clearDepth: () => {},
    render: (sc, cam) => calls.push(["render", sc === w.scene ? cam.layers.mask : "quad"]),
    getContext: () => null,
  };
  w.setResolutionScale(1);
  calls.length = 0;
  w.render(stub);
  expect(calls.filter((c) => c[0] === "render").length === 1 && w.stats.passes === 1 && w.stats.width === 800, `scale 1: ${JSON.stringify(calls)}`);
  w.setResolutionScale(0.5);
  calls.length = 0;
  w.render(stub);
  const renders = calls.filter((c) => c[0] === "render").map((c) => c[1]);
  expect(calls.some((c) => c[0] === "target" && c[1] === "400x300") && w.stats.width === 400 && w.stats.height === 300 && w.stats.scale === 0.5, `scale 0.5 target: ${JSON.stringify(calls)}`);
  expect(JSON.stringify(renders) === JSON.stringify([1 << 1, 1 << 0, "quad", 1 << 2]), `scale 0.5 order bodies → sky → composite → fx: ${JSON.stringify(renders)}`);
  expect(Object.values(w.bodies).every((b) => b.mesh.material.blendDstAlpha === THREE.OneFactor), "bodies back to opaque alpha after the offscreen pass");
  w.setResolutionScale(0.1);
  expect(w.stats.scale === 0.25, "scale clamps to 0.25");
  w.setEnabled(false);
  calls.length = 0;
  w.render(stub);
  expect(!calls.some((c) => c[0] === "render") && calls.some((c) => c[0] === "clear") && w.stats.skipped && w.stats.passes === 0, "disabled: only a clear");
  w.setEnabled(true);
  w.setResolutionScale(1);
  const pass = w.createPass();
  calls.length = 0;
  pass.render(stub, null, { width: 640, height: 480 });
  expect(calls.some((c) => c[0] === "target" && c[1] === "640x480") && stub.autoClear === true, "pass renders into the read buffer and restores autoClear");
}

const deck = w.cloudDeck("earth", 5);
expect(deck && deck.object3d && w.cloudDeck("moon") === null, "cloud deck");
w.dispose();

console.log(`world: 3 bodies, ${draws} far draws, sites, sky, local ground`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
