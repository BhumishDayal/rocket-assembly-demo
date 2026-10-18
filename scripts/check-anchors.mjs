// Check for src/anchors.js: real sizes (1.8 m person, 25 m masts), tower = 1.08 × stack, everything scales with
// its inputs, nothing collides with the vehicle, no NaN.
// Run: node scripts/check-anchors.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const { catalog, presetToBuild } = await import("../src/data/catalog.js");
const { buildManifest, sceneBounds, SCALE } = await import("../src/layout.js");
const { padRadius } = await import("../src/parts.js");
const { createAnchors } = await import("../src/anchors.js");
const THREE = await import("three");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const near = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b)); // positions are float32
// World-space extent of a line set (positions transformed by its object matrix).
function extent(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const pos = obj.geometry.attributes.position;
  const p = new THREE.Vector3();
  let minR = Infinity;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
    if (![p.x, p.y, p.z].every(Number.isFinite)) return null;
    box.expandByPoint(p);
    minR = Math.min(minR, Math.hypot(p.x, p.z));
  }
  return { box, minR, h: box.max.y - box.min.y };
}

const cases = catalog.presets.map((preset) => {
  const b = sceneBounds(buildManifest(presetToBuild(preset), catalog));
  return { id: preset.id, baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u, radius_u: b.radius_u };
});
cases.push({ ...cases[0], id: "falcon-9, stack ×2", stackHeight_u: cases[0].stackHeight_u * 2 }, { ...cases[0], id: "falcon-9, scale ×2", scale: SCALE * 2 });

for (const c of cases) {
  const scale = c.scale ?? SCALE;
  const a = createAnchors({ baseRadius_u: c.baseRadius_u, stackHeight_u: c.stackHeight_u, scale });
  const ex = Object.fromEntries(["human", "tower", "trench", "masts"].map((k) => [k, extent(a[k])]));
  for (const [k, e] of Object.entries(ex)) expect(e, `${c.id}: NaN in ${k}`);
  if (Object.values(ex).some((e) => !e)) continue;
  expect(near(ex.human.h, 1.8 * scale), `${c.id}: person ${(ex.human.h / scale).toFixed(3)} m tall, want 1.8`);
  expect(near(ex.human.box.min.y, 0), `${c.id}: person not standing on the deck`);
  expect(ex.human.minR > c.baseRadius_u && ex.human.minR < padRadius(c.baseRadius_u), `${c.id}: person not on the pad edge`);
  expect(near(a.towerHeight_u, 1.08 * c.stackHeight_u) && near(ex.tower.box.max.y, 1.08 * c.stackHeight_u), `${c.id}: tower height ${ex.tower.box.max.y.toFixed(3)} u, want ${(1.08 * c.stackHeight_u).toFixed(3)}`);
  expect(ex.tower.minR >= c.baseRadius_u, `${c.id}: tower boom reaches inside the vehicle (${ex.tower.minR.toFixed(3)} < ${c.baseRadius_u.toFixed(3)})`);
  expect(near(ex.masts.box.max.y - ex.masts.box.min.y, 25 * scale), `${c.id}: masts ${((ex.masts.box.max.y - ex.masts.box.min.y) / scale).toFixed(2)} m, want 25`);
  expect(ex.masts.minR > padRadius(c.baseRadius_u), `${c.id}: a mast stands on the pad`);
  expect(ex.trench.box.max.y < 0.01 && ex.trench.box.min.y > 0, `${c.id}: trench not on the deck`);
  expect(a.lamps.length === 4 && a.lamps.every((s) => Number.isFinite(s.position.y)), `${c.id}: lamps`);
  a.update(1.23);
  expect(a.lamps.every((s) => Number.isFinite(s.material.opacity)), `${c.id}: lamp opacity NaN`);
  a.setVisible(false);
  expect(!a.object3d.visible, `${c.id}: setVisible(false) ignored`);
  a.object3d.traverse((o) => {
    if (o.castShadow) failures.push(`${c.id}: ${o.name} casts a shadow`);
    if (o.isLineSegments && !o.material.fog) failures.push(`${c.id}: ${o.name} ignores fog`);
  });
  a.dispose();
}
// Tower height scales with the stack.
const one = createAnchors({ baseRadius_u: 0.5, stackHeight_u: 10 });
const two = createAnchors({ baseRadius_u: 0.5, stackHeight_u: 20 });
expect(near(two.towerHeight_u, 2 * one.towerHeight_u), "tower height does not scale with the stack");

console.log(`anchors checked: ${cases.length} cases`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
