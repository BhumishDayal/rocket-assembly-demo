// Check for setDetailLevel in src/parts.js: per preset, the drawn objects drop from level 2 to 1 to 0 (instanced
// detail off at 1, lines only on shells at 1 and none at 0, the smallest 40 % of detail-kind pieces off at 0),
// piece counts and `visible` flags never change, hidden pieces still move with their animation, a default
// Raycaster never picks a hidden piece, going back up restores every layer exactly, and new parts take the
// current level. Run: node scripts/check-detail.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { catalog, presetToBuild } = await import("../src/data/catalog.js");
const { buildManifest } = await import("../src/layout.js");
const { createMaterials, createPart, setDetailLevel, getDetailLevel, setShellOpacity } = await import("../src/parts.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const cam = new THREE.Layers(); // a default camera's layers (layer 0)
const drawn = (root) => {
  const n = { meshes: 0, lines: 0, inst: 0 };
  root.traverse((o) => {
    if (!o.visible || !o.layers.test(cam)) return;
    if (o.isInstancedMesh) n.inst++;
    else if (o.isLine) n.lines++;
    else if (o.isMesh) n.meshes++;
  });
  return n;
};
const snapshot = (root) => {
  const s = [];
  root.traverse((o) => s.push([o.uuid, o.layers.mask, o.visible]));
  return JSON.stringify(s);
};
const rows = [];
for (const preset of catalog.presets) {
  const mats = createMaterials();
  const parts = buildManifest(presetToBuild(preset), catalog).map((spec) => createPart(spec, mats));
  const root = new THREE.Group();
  for (const p of parts) {
    setShellOpacity(p, 0.92);
    root.add(p.group);
  }
  root.updateMatrixWorld(true);
  const pieces0 = parts.reduce((n, p) => n + p.pieces.length, 0);
  const snap0 = snapshot(root);
  const at = [2, 1, 0].map((lv) => {
    setDetailLevel(lv, parts);
    return drawn(root);
  });
  const [l2, l1, l0] = at;
  rows.push(`${preset.id.padEnd(12)} L2 ${l2.meshes}+${l2.inst} inst+${l2.lines} lines · L1 ${l1.meshes}+${l1.inst}+${l1.lines} · L0 ${l0.meshes}+${l0.inst}+${l0.lines}`);
  expect(l1.inst === 0 && l0.inst === 0 && l2.inst > 0, `${preset.id}: instanced detail off at levels 1 and 0`);
  expect(l1.lines < l2.lines && l0.lines === 0, `${preset.id}: lines ${l2.lines} → ${l1.lines} → ${l0.lines}`);
  expect(l1.meshes === l2.meshes && l0.meshes < l1.meshes, `${preset.id}: meshes ${l2.meshes} → ${l1.meshes} → ${l0.meshes}`);
  // level 1: every visible line is on a shell
  for (const p of parts) for (const pc of p.pieces) for (const e of [pc.mesh.userData.edges, pc.mesh.userData.edgesFine]) if (e && e.layers.test(cam)) expect(pc.mesh.userData.kind === "shell", `${preset.id}: a non-shell line drawn at level 0`);
  // level 0: the hidden share of detail-kind pieces is 40 %, piece counts unchanged, visible flags untouched
  const det = parts.flatMap((p) => p.pieces.filter((pc) => pc.kind === "detail"));
  const hidden = det.filter((pc) => !pc.mesh.layers.test(cam));
  const share = hidden.length / det.length;
  expect(share > 0.3 && share <= 0.4 + 1e-9, `${preset.id}: ${(share * 100).toFixed(0)} % of detail pieces hidden`);
  expect(parts.every((p) => p.pieces.every((pc) => pc.kind !== "detail" ? pc.mesh.layers.test(cam) : true)), `${preset.id}: shells / interiors must stay drawn at 0`);
  expect(parts.reduce((n, p) => n + p.pieces.length, 0) === pieces0 && hidden.every((pc) => pc.mesh.visible), `${preset.id}: piece count / visible flags changed`);
  // hidden pieces still animate (their transform moves) and are never picked
  const h = hidden[0];
  if (h) {
    const before = h.mesh.position.clone();
    h.mesh.position.x += 0.5;
    h.mesh.updateMatrixWorld(true);
    expect(h.mesh.matrixWorld.elements[12] !== 0 && h.mesh.position.x === before.x + 0.5, `${preset.id}: hidden piece does not move`);
    h.mesh.position.copy(before);
    h.mesh.updateMatrixWorld(true);
    const c = h.mesh.geometry.boundingSphere.center.clone().applyMatrix4(h.mesh.matrixWorld);
    const ray = new THREE.Raycaster(c.clone().add(new THREE.Vector3(50, 0.01, 0.02)), new THREE.Vector3(-1, -0.0002, -0.0004).normalize());
    expect(ray.intersectObject(h.mesh, false).length === 0, `${preset.id}: a hidden piece was picked`);
  }
  // back up: exact layers, same counts as before
  setDetailLevel(2, parts);
  expect(snapshot(root) === snap0, `${preset.id}: level 2 does not restore every layer`);
  const back = drawn(root);
  expect(JSON.stringify(back) === JSON.stringify(l2), `${preset.id}: counts after 0 → 2 differ`);
  // look switch at level 1 does not bring instanced detail back (look sets visible, the level sets layers)
  setDetailLevel(1, parts);
  for (const p of parts) setShellOpacity(p, 0.3);
  for (const p of parts) setShellOpacity(p, 0.92);
  expect(drawn(root).inst === 0, `${preset.id}: the look switch brought detail back at level 1`);
  setDetailLevel(2, parts);
}
// Global level: applies to live parts and to parts created afterwards; invalid input → 2.
const mats = createMaterials();
const spec = buildManifest(presetToBuild(catalog.presets[0]), catalog).find((s) => s.kind === "tank");
const a = createPart(spec, mats);
setDetailLevel(0);
const b = createPart(spec, mats);
expect(getDetailLevel() === 0 && a.detailLevel === 0 && b.detailLevel === 0 && drawn(b.group).lines === 0, "global level 0 reaches live and new parts");
expect(setDetailLevel("nope") === 2 && getDetailLevel() === 2 && drawn(b.group).inst > 0, "invalid level → 2");

console.log(rows.join("\n"));
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
