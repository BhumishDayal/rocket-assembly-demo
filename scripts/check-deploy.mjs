// Check for the articulated deploys in src/parts.js (piece.deploy, deployables(part)): every deployable has a
// unit axis, a pivot inside the piece's bounds and a nonzero angle; the expected pieces deploy on each preset;
// the fully deployed pose is finite, rigid (vertex distances kept), and swings the piece outward from the stack
// axis (catches a hinge with the wrong sense).
// Run: node scripts/check-deploy.mjs   (no deps; exits 1 on any failure)
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
const { buildManifest } = await import("../src/layout.js");
const { createMaterials, createPart, deployables } = await import("../src/parts.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
// Expected deployables per preset and part (from visuals: legs/grid fins on falcon9-s1, payload archetypes).
const EXPECT = {
  "falcon-9": { "s0-tank": 4, "s0-interstage": 4, payload: 2 }, // legs, grid fins, GOES-R panel + dish
  "saturn-v": { payload: 4 }, // SLA petals
  "atlas-v-401": { payload: 2 },
  "delta-iv-m": { payload: 6 }, // Nova-C legs
  "demo-build": { "s0-tank": 4, "s0-interstage": 4, payload: 2 }, // JWST pallets
};

// Part-local AABB and centroid of a piece's geometry under a given transform.
function measure(geo, position, quaternion) {
  const m = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const p = new THREE.Vector3();
  const pos = geo.attributes.position;
  const pts = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(m);
    box.expandByPoint(p);
    c.add(p);
    if (i % Math.max(1, Math.floor(pos.count / 8)) === 0) pts.push(p.clone());
  }
  return { box, centroid: c.divideScalar(pos.count), pts };
}

const mats = createMaterials();
let total = 0;
for (const preset of catalog.presets) {
  for (const spec of buildManifest(presetToBuild(preset), catalog)) {
    const part = createPart(spec, mats);
    const deps = deployables(part);
    total += deps.length;
    const want = EXPECT[preset.id]?.[spec.id] ?? 0;
    expect(deps.length === want, `${preset.id}/${spec.id}: ${deps.length} deployables, want ${want}`);
    for (const piece of deps) {
      const d = piece.deploy;
      const name = `${preset.id}/${piece.mesh.name}`;
      expect(Math.abs(d.axis.length() - 1) < 1e-9, `${name}: axis not unit`);
      expect(Math.abs(d.angle) > 1e-6 && Number.isFinite(d.angle), `${name}: zero/NaN angle`);
      expect([d.pivot.x, d.pivot.y, d.pivot.z].every(Number.isFinite), `${name}: NaN pivot`);
      const rest = measure(piece.mesh.geometry, piece.rest.position, piece.rest.quaternion);
      const size = rest.box.getSize(new THREE.Vector3()).length();
      expect(rest.box.clone().expandByScalar(1e-3 * size + 1e-5).containsPoint(d.pivot), `${name}: pivot outside the piece bounds`);
      // Fully deployed pose, by the documented formula.
      const R = new THREE.Quaternion().setFromAxisAngle(d.axis, d.angle);
      const pos = piece.rest.position.clone().sub(d.pivot).applyQuaternion(R).add(d.pivot);
      const quat = R.clone().multiply(piece.rest.quaternion);
      const out = measure(piece.mesh.geometry, pos, quat);
      expect([pos.x, pos.y, pos.z, quat.x, quat.y, quat.z, quat.w].every(Number.isFinite), `${name}: NaN deployed pose`);
      const rigid = rest.pts.every((a, i) => rest.pts.every((b, j) => Math.abs(a.distanceTo(b) - out.pts[i].distanceTo(out.pts[j])) < 1e-6 * (1 + size)));
      expect(rigid, `${name}: deploy is not rigid`);
      const r0 = Math.hypot(rest.centroid.x, rest.centroid.z);
      const r1 = Math.hypot(out.centroid.x, out.centroid.z);
      expect(r1 > r0, `${name}: deploy does not swing outward (${r0.toFixed(3)} → ${r1.toFixed(3)})`);
    }
  }
}
console.log(`deployables checked: ${total} across ${catalog.presets.length} presets`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
