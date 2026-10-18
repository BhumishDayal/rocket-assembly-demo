// Check for the articulated deploys in src/parts.js (piece.deploy, deployables(part)): every deployable has a
// unit axis, a pivot inside the piece's bounds and a nonzero angle; the expected pieces deploy on each preset;
// the fully deployed pose is finite, rigid (vertex distances kept), and swings the piece outward from the stack
// axis (catches a hinge with the wrong sense). Followers (the leg pistons): applyDeploy(leg, k) keeps the
// outer tube pinned at the body point B and the rod pinned at the leg point L for k in [0, 1.15] (spring
// overshoot), both aimed along B → L, still overlapping, and back at rest for k = 0.
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
const { applyDeploy, createMaterials, createPart, deployables, landerOf } = await import("../src/parts.js");

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
// Followers.
let nFol = 0;
for (const preset of catalog.presets) {
  const mats = createMaterials();
  for (const spec of buildManifest(presetToBuild(preset), catalog)) {
    const part = createPart(spec, mats);
    for (const leg of part.pieces.filter((p) => p.followers?.length)) {
      const [tube, rod] = ["B", "L"].map((e) => leg.followers.find((f) => f.follow.end === e));
      const name = `${preset.id}/${leg.mesh.name}`;
      expect(tube && rod && !tube.deploy && !rod.deploy, `${name}: needs a tube (B) and a rod (L), neither deployable`);
      if (!tube || !rod) continue;
      nFol += 2;
      const { B, L } = tube.follow;
      const span = (g) => (g.computeBoundingBox(), g.boundingBox.getSize(new THREE.Vector3()).length());
      const lt = span(tube.mesh.geometry);
      const lr = span(rod.mesh.geometry);
      const worldOf = (f, p) => p.clone().sub(f.rest.position).applyQuaternion(f.rest.quaternion.clone().invert()).applyQuaternion(f.mesh.quaternion).add(f.mesh.position);
      for (const k of [0, 0.25, 0.5, 0.75, 1, 1.15]) {
        applyDeploy(leg, k);
        const Lk = worldOf(leg, L);
        expect(worldOf(tube, B).distanceTo(B) < 1e-6 && worldOf(rod, L).distanceTo(Lk) < 1e-6, `${name}: piston pins slip at k ${k}`);
        expect(tube.mesh.quaternion.angleTo(rod.mesh.quaternion) < 1e-6, `${name}: tube and rod not aligned at k ${k}`);
        const d = Lk.distanceTo(B);
        expect(lt + lr > d * 1.02, `${name}: piston parts separate at k ${k} (${(lt + lr).toFixed(3)} for ${d.toFixed(3)})`);
        expect([tube, rod].every((f) => [f.mesh.position.x, f.mesh.position.y, f.mesh.position.z].every(Number.isFinite)), `${name}: NaN piston at k ${k}`);
      }
      applyDeploy(leg, 0);
      expect([tube, rod].every((f) => f.mesh.position.distanceTo(f.rest.position) < 1e-9 && f.mesh.quaternion.angleTo(f.rest.quaternion) < 1e-9), `${name}: pistons not back at rest`);
    }
  }
}
expect(nFol === 16, `${nFol} piston pieces, want 16 (Falcon 9 and the demo build, 4 legs × 2)`);

// Landable sub-part: the Apollo payload has an LM (descent, ascent, 4 legs that are not payload deployables);
// the copy shares geometry, folds inside the adapter, deploys its legs outward and down with the feet below
// its base and outside its body; every other payload has none.
for (const preset of catalog.presets) {
  const mats = createMaterials();
  for (const spec of buildManifest(presetToBuild(preset), catalog).filter((s) => s.kind === "payload")) {
    const part = createPart(spec, mats);
    const lm = landerOf(part);
    const id = `${preset.id}/${spec.id}`;
    if (spec.geom.archetype !== "capsule") {
      expect(lm === null, `${id}: unexpected lander`);
      continue;
    }
    expect(lm && lm.pieces.length === 6 && lm.deployables.length === 4, `${id}: LM should be descent + ascent + 4 legs`);
    if (!lm) continue;
    expect(deployables(part).every((p) => !p.mesh.userData.lander), `${id}: LM legs must not be payload deployables`);
    expect(lm.pieces.every((p) => part.pieces.some((q) => q.mesh.geometry === p.mesh.geometry)), `${id}: LM copies should share geometry`);
    const descentR = Math.max(...lm.pieces.filter((p) => p.mesh.userData.lander === "descent").map((p) => (p.mesh.geometry.computeBoundingBox(), p.mesh.geometry.boundingBox.max.x)));
    expect(lm.feetY_u < -0.05 * lm.height_u && lm.footprint_u > descentR * 1.2, `${id}: LM feet ${lm.feetY_u.toFixed(3)} / footprint ${lm.footprint_u.toFixed(3)} (descent r ${descentR.toFixed(3)})`);
    for (const d of lm.deployables) {
      expect(Math.abs(d.deploy.axis.length() - 1) < 1e-9 && Math.abs(d.deploy.axis.y) < 1e-9, `${id}: LM leg axis`);
      applyDeploy(d, 1);
      const c = new THREE.Box3().setFromObject(d.mesh).getCenter(new THREE.Vector3());
      applyDeploy(d, 0);
      const c0 = new THREE.Box3().setFromObject(d.mesh).getCenter(new THREE.Vector3());
      expect(Math.hypot(c.x, c.z) > Math.hypot(c0.x, c0.z) && c.y < c0.y, `${id}: LM leg should swing out and down`);
    }
    // folded inside the adapter: within the adapter's base radius, above its floor
    const restBox = new THREE.Box3().setFromObject(lm.group).translate(lm.restPose.position);
    const Rb = spec.geom.dims?.sla_base_diameter_m ? (spec.geom.dims.sla_base_diameter_m / 2) * 0.25 : spec.radius;
    expect(Math.max(-restBox.min.x, restBox.max.x, -restBox.min.z, restBox.max.z) < Rb && restBox.min.y >= -1e-6, `${id}: folded LM outside the adapter`);
    const dock = part.pieces.find((p) => p.mesh.userData.dock);
    expect(dock && lm.detachPose.position.y > dock.topY && Math.abs(Math.abs(lm.detachPose.quaternion.x) - 1) < 1e-9, `${id}: detach pose should be inverted above the CM apex`);
    // feet = pad undersides; the probes (children of the legs) reach below them with the legs out
    expect(lm.probes.length === 4 && lm.probes.every((pr) => lm.deployables.some((d) => d.mesh === pr.parent)) && lm.probeLength_u > 0, `${id}: four probes on the legs`);
    for (const d of lm.deployables) applyDeploy(d, 1);
    lm.group.updateMatrixWorld(true);
    const ownLow = (m) => {
      const p = m.geometry.attributes.position;
      const v = new THREE.Vector3();
      let lo = Infinity;
      for (let i = 0; i < p.count; i++) lo = Math.min(lo, v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).y);
      return lo;
    };
    const legsLow = Math.min(...lm.deployables.map((d) => ownLow(d.mesh))); // the leg's own vertices, not its probe
    const probesLow = Math.min(...lm.probes.map((pr) => new THREE.Box3().setFromObject(pr, true).min.y));
    expect(Math.abs(legsLow - lm.feetY_u) < 1e-6 && probesLow < lm.feetY_u - 0.5 * lm.probeLength_u, `${id}: feetY ${lm.feetY_u.toFixed(4)} should be the pads (${legsLow.toFixed(4)}), probes below (${probesLow.toFixed(4)})`);
    for (const d of lm.deployables) applyDeploy(d, 0);
    lm.setProbesVisible(false);
    expect(lm.probes.every((pr) => !pr.visible), `${id}: setProbesVisible(false)`);
    lm.setPartLanderVisible(false);
    expect(part.pieces.filter((p) => p.mesh.userData.lander).every((p) => !p.mesh.visible), `${id}: setPartLanderVisible(false)`);
  }
}
console.log(`deployables checked: ${total} across ${catalog.presets.length} presets; ${nFol} followers`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
