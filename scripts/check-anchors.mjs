// Check for the scene props: src/anchors.js (person, tower + umbilical arms, cable tray, lightning masts),
// createPad in src/parts.js (deck, plinth, trench, mount, clamps, rails) and createDroneShip.
// Real sizes (1.8 m person, 25 m masts + 6 m air terminal), tower = 1.08 × stack, one arm per interstage plus
// the payload adapter reaching the vehicle without entering it, deck top at y = 0, ≤ 60 draws for pad +
// anchors, shadows only on the deck, tower and arms, fog on every line, nothing pickable, no NaN. Looks: every
// structural prop starts painted (lines at 0.15 / 0.35 of their x-ray level, the person a silhouette) and
// setPropLook switches all of it to x-ray and back with the same draw count.
// Run: node scripts/check-anchors.mjs   (no deps; exits 1 on any failure)
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
const { buildManifest, sceneBounds, SCALE } = await import("../src/layout.js");
const { createPad, padLayout, setPropLook } = await import("../src/parts.js");
const { createAnchors, createDroneShip } = await import("../src/anchors.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const near = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b)); // positions are float32
// World-space box and nearest horizontal distance to the axis of an object's own geometry.
function extent(obj) {
  obj.updateWorldMatrix(true, false);
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
const draws = (...roots) => {
  let n = 0;
  for (const r of roots) r.traverseVisible((o) => (o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material?.visible !== false && n++);
  return n;
};
const PAINTED = /^(pad-(deck|plinth|trench|mount|clamps|rails)|anchor-(tower-frame|arm:.*|cable-tray|masts|human))$/;

const cases = catalog.presets.map((preset) => {
  const manifest = buildManifest(presetToBuild(preset), catalog);
  const b = sceneBounds(manifest);
  return { id: preset.id, manifest, baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u };
});
cases.push({ ...cases[0], id: "falcon-9, stack ×2", stackHeight_u: cases[0].stackHeight_u * 2, manifest: null });

for (const c of cases) {
  const scale = SCALE;
  const L = padLayout({ baseRadius_u: c.baseRadius_u });
  const pad = createPad({ baseRadius_u: c.baseRadius_u });
  const a = createAnchors({ baseRadius_u: c.baseRadius_u, stackHeight_u: c.stackHeight_u, manifest: c.manifest });
  const n = draws(pad.group, a.object3d);
  expect(n <= 60, `${c.id}: ${n} draws for pad + anchors (budget 60)`);
  // No NaN anywhere; shadows only on deck, tower and arms; fog on lines; nothing pickable but the ground.
  for (const root of [pad.group, a.object3d]) {
    root.traverse((o) => {
      if (o.geometry?.attributes?.position && !extent(o)) failures.push(`${c.id}: NaN in ${o.name}`);
      if (o.castShadow && !/^(pad-deck|anchor-tower-frame|anchor-arm:)/.test(o.name)) failures.push(`${c.id}: ${o.name} casts a shadow`);
      if (o.isLineSegments && !o.material.fog) failures.push(`${c.id}: ${o.name || o.parent?.name} lines ignore fog`);
    });
  }
  // Looks: painted by default, x-ray through setPropLook, same draws either way.
  const roots = [pad.group, a.object3d];
  const looked = [];
  for (const root of roots) root.traverse((o) => o.isMesh && PAINTED.test(o.name) && looked.push(o));
  const lineK = 0.15 / 0.35;
  const linesOf = (o) => o.children.filter((e) => e.isLineSegments && e.userData.base0 !== undefined);
  expect(looked.length === 10 + a.arms.length && looked.every((o) => o.userData.looks && o.material === o.userData.looks.painted), `${c.id}: props should start painted (${looked.filter((o) => !o.userData.looks).map((o) => o.name)})`);
  expect(looked.every((o) => linesOf(o).every((e) => Math.abs(e.material.opacity - e.userData.base0 * (o.userData.paintLineK ?? lineK)) < 1e-9 && o.userData.paintLineK <= lineK)), `${c.id}: painted prop lines`);
  const figure = a.human.getObjectByName("anchor-human-lines");
  expect(a.human.material.visible && figure && !figure.visible, `${c.id}: painted person should be a silhouette`);
  const nPaint = draws(...roots);
  for (const root of roots) setPropLook(root, "xray");
  expect(looked.every((o) => o.material === o.userData.looks.xray && linesOf(o).every((e) => Math.abs(e.material.opacity - e.userData.base0) < 1e-9)), `${c.id}: x-ray props`);
  expect(!a.human.material.visible && figure.visible, `${c.id}: x-ray person should be the line figure`);
  expect(draws(...roots) === nPaint, `${c.id}: draws ${nPaint} painted vs ${draws(...roots)} x-ray`);
  for (const root of roots) setPropLook(root, "painted");
  expect(looked.every((o) => o.material === o.userData.looks.painted) && !figure.visible, `${c.id}: back to painted`);
  // Pad: deck top at y = 0, ground at −plinthH, trench below the deck.
  const deck = extent(pad.group.getObjectByName("pad-deck"));
  expect(near(deck.box.max.y, 0) && deck.box.max.x <= L.padR + 1e-6, `${c.id}: deck top ${deck.box.max.y}`);
  const trench = extent(pad.group.getObjectByName("pad-trench"));
  expect(trench.box.max.y <= 0 && near(trench.box.min.y, -L.plinthH), `${c.id}: trench not under the deck`);
  expect(pad.ringMat && pad.layout, `${c.id}: createPad return shape`);
  // Person 1.8 m on the deck.
  const hu = extent(a.human);
  expect(near(hu.h, 1.8 * scale) && near(hu.box.min.y, 0), `${c.id}: person ${(hu.h / scale).toFixed(3)} m, standing at y ${hu.box.min.y}`);
  expect(hu.minR > c.baseRadius_u && hu.minR < L.padR, `${c.id}: person not on the deck`);
  // Tower and arms.
  const tw = extent(a.towerFrame);
  expect(near(a.towerHeight_u, 1.08 * c.stackHeight_u) && near(tw.box.max.y, 1.08 * c.stackHeight_u), `${c.id}: tower height ${tw.box.max.y.toFixed(3)}`);
  expect(tw.minR > c.baseRadius_u, `${c.id}: tower inside the vehicle radius`);
  const wantArms = c.manifest ? c.manifest.filter((s) => s.kind === "interstage" || s.kind === "payload").length : 0;
  expect(a.arms.length === wantArms, `${c.id}: ${a.arms.length} arms, want ${wantArms}`);
  for (const arm of a.arms) {
    const ex = extent(arm.mesh);
    const at = c.manifest.filter((s) => s.kind !== "engines" && arm.y_u >= s.slotY && arm.y_u <= s.slotY + s.height);
    const rv = Math.max(...at.map((s) => s.radius));
    expect(ex.minR >= rv - 1e-6 && ex.minR < rv + 0.12, `${c.id}: arm ${arm.partId} stops at ${ex.minR.toFixed(3)} for vehicle radius ${rv.toFixed(3)}`);
    expect(arm.y_u > 0 && arm.y_u < c.stackHeight_u, `${c.id}: arm ${arm.partId} height`);
  }
  // Masts: 25 m lattice + 6 m terminal on the ground, off the hardstand.
  const ms = extent(a.masts);
  // lattice extents differ from the nominal 25 + 6 m by at most one member (0.15 m)
  const member = 0.15 * scale;
  expect(Math.abs(ms.box.min.y + L.plinthH) <= member && Math.abs(ms.h - 31 * scale) <= member, `${c.id}: masts ${(ms.h / scale).toFixed(2)} m from y ${ms.box.min.y.toFixed(3)}`);
  expect(ms.minR > L.padR, `${c.id}: a mast stands on the pad`);
  expect(a.lamps.length === 4, `${c.id}: lamps`);
  a.update(1.23);
  expect(a.lamps.every((s) => Number.isFinite(s.material.opacity)), `${c.id}: lamp opacity NaN`);
  a.setVisible(false);
  expect(!a.object3d.visible, `${c.id}: setVisible(false) ignored`);
  a.dispose();
}
// Tower height scales with the stack.
const one = createAnchors({ baseRadius_u: 0.5, stackHeight_u: 10 });
const two = createAnchors({ baseRadius_u: 0.5, stackHeight_u: 20 });
expect(near(two.towerHeight_u, 2 * one.towerHeight_u), "tower height does not scale with the stack");

// Drone ship: x-ray 5 draws, painted (default) 3; size follows size_u, deck top at y = 0 (painted: the marks sit
// a hair above it, bulwarks and deckhouses stand on it), shadows on the hull, nothing pickable.
for (const look of ["xray", "painted"]) {
  for (const size_u of [6, 12]) {
    const id = `drone ${look} ${size_u}`;
    const ds = createDroneShip({ size_u, ...(look === "xray" ? { look } : {}) });
    expect(draws(ds.object3d) === (look === "xray" ? 5 : 3), `${id}: ${draws(ds.object3d)} draws`);
    const hullMesh = ds.object3d.getObjectByName("drone-hull");
    const hull = extent(hullMesh);
    expect(hull && near(hull.box.max.x - hull.box.min.x, size_u), `${id}: hull ${hull && hull.box.max.x - hull.box.min.x} long`);
    expect(look === "xray" ? near(hull.box.max.y, 0) : hull.box.max.y > 0 && hull.box.max.y < 0.1 * size_u, `${id}: hull top ${hull.box.max.y}`);
    expect(hullMesh.castShadow && hullMesh.receiveShadow, `${id}: hull shadows`);
    const circle = extent(ds.object3d.getObjectByName("drone-landing-circle"));
    expect(circle && circle.box.max.x < size_u / 2 && circle.box.min.y >= -1e-6 && circle.box.max.y < 0.005 * size_u, `${id}: landing circle`);
    ds.object3d.traverse((o) => o.isMesh && o.raycast !== THREE.Mesh.prototype.raycast || !o.isMesh || failures.push(`${id}: ${o.name} pickable`));
    expect(ds.deckY === 0, `${id}: deckY`);
    ds.dispose();
  }
}

console.log(`props checked: ${cases.length} pad/anchor cases, 4 drone ships`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
