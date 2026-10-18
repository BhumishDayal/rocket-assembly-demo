// Check for src/complex.js (the launch complex around the pad), every preset plus edge cases:
//   API      createLaunchComplex returns the anchors.js shape (object3d, setVisible, update, tower, arms[], person,
//            masts) plus waterTower, rss, setLook, setRssAngle, dispose; arms are { mesh, y_u, reach_u, partId }.
//   draws    ≤ 110 for the complex in both looks (same count painted and x-ray); also printed with the pad.
//   sizes    FSS lattice top = 1.15 × stack, lightning-tower tops = 1.3 × stack, water tower 1.5 × the FSS height
//            from the pad axis; doubling the stack doubles them; doubling `scale` doubles the metric sizes
//            (hardstand rise, apron); hardstand top at the pad's ground (−plinthH), apron below it.
//   sanity   no NaN in any geometry, instance matrix or point set (also after update(t) and at every RSS angle);
//            nothing pickable; fog on every material; shadows only from the FSS (+ beams, arms, RSS), the water
//            tower and the buildings; nothing of the complex inside the pad plinth; arms stop at the vehicle; the RSS
//            clears the vehicle, the deck and the FSS at every angle 0–120°; lightning towers stand off the
//            hardstand and clear of the director's low pad-camera ray.
//   looks    painted by default, setPropLook / setLook switch to x-ray and back (material twins, line levels).
//   pad      added under the pad group it hides the pad's ground disc + polar grid and sinks the ground map under
//            the apron; setVisible(false) / dispose() restore them.
// Run: node scripts/check-complex.mjs   (no deps; exits 1 on any failure)
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
const { createGroundMap } = await import("../src/fx/launchfx.js");
const { createLaunchComplex } = await import("../src/complex.js");

const BUDGET = 110;
const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const draws = (...roots) => {
  let n = 0;
  for (const r of roots) r.traverseVisible((o) => (o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material?.visible !== false && n++);
  return n;
};
// World-space vertices of an object's own geometry (instances expanded), as a flat callback.
const tmp = new THREE.Vector3();
const im = new THREE.Matrix4();
function eachVertex(o, fn) {
  o.updateWorldMatrix(true, false);
  const pos = o.geometry?.attributes?.position;
  if (!pos) return;
  const n = o.isInstancedMesh ? o.count : 1;
  for (let k = 0; k < n; k++) {
    if (o.isInstancedMesh) o.getMatrixAt(k, im);
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      if (o.isInstancedMesh) tmp.applyMatrix4(im);
      tmp.applyMatrix4(o.matrixWorld);
      fn(tmp);
    }
  }
}
function box(o) {
  const b = new THREE.Box3();
  let finite = true;
  eachVertex(o, (p) => {
    if (![p.x, p.y, p.z].every(Number.isFinite)) finite = false;
    else b.expandByPoint(p);
  });
  return finite ? b : null;
}
const widestAt = (manifest, y) => Math.max(0, ...(manifest ?? []).filter((s) => s.kind !== "engines" && y >= s.slotY - 1e-9 && y <= s.slotY + s.height + 1e-9).map((s) => s.radius));
const CASTERS = /^complex-(fss|fss-beams|arm:.*|rss|water-tower|buildings)$/;
const API = ["object3d", "setVisible", "update", "tower", "arms", "person", "masts", "waterTower", "rss", "setLook", "setRssAngle", "dispose"];

const cases = catalog.presets.map((preset) => {
  const manifest = buildManifest(presetToBuild(preset), catalog);
  const b = sceneBounds(manifest);
  return { id: preset.id, manifest, baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u };
});
cases.push({ ...cases[0], id: "falcon-9, stack ×2", stackHeight_u: cases[0].stackHeight_u * 2, manifest: null });
cases.push({ id: "tiny, no manifest", manifest: null, baseRadius_u: 0.2, stackHeight_u: 3 });

const rows = [];
for (const c of cases) {
  const L = padLayout({ baseRadius_u: c.baseRadius_u });
  const pad = createPad({ baseRadius_u: c.baseRadius_u });
  const map = createGroundMap({ y_u: -L.plinthH - 0.01 });
  pad.group.add(map.object3d);
  const t0 = performance.now();
  const cx = createLaunchComplex({ baseRadius_u: c.baseRadius_u, stackHeight_u: c.stackHeight_u, manifest: c.manifest });
  const ms = performance.now() - t0;
  const H = c.stackHeight_u;
  // API
  const missing = API.filter((k) => cx[k] === undefined || cx[k] === null);
  expect(!missing.length, `${c.id}: API missing ${missing.join(", ")}`);
  expect(cx.object3d?.isObject3D && cx.tower?.isObject3D && cx.rss?.isObject3D && cx.person?.isObject3D && cx.masts?.isObject3D && cx.waterTower?.isObject3D, `${c.id}: object members are not Object3Ds`);
  expect(["setVisible", "update", "setLook", "setRssAngle", "dispose"].every((k) => typeof cx[k] === "function"), `${c.id}: API functions`);
  expect(Array.isArray(cx.arms) && cx.arms.every((a) => a.mesh?.isMesh && Number.isFinite(a.y_u) && Number.isFinite(a.reach_u) && typeof a.partId === "string" && a.mesh.parent === cx.tower), `${c.id}: arms shape`);
  // pad adoption
  pad.group.add(cx.object3d);
  pad.group.updateMatrixWorld(true);
  const padGround = pad.group.getObjectByName("pad-ground");
  const grid = pad.group.children.find((o) => o.type === "PolarGridHelper");
  const mapY = box(map.object3d.children[0]).max.y;
  expect(!padGround.visible && !grid.visible, `${c.id}: pad ground / grid still visible under the complex`);
  expect(mapY < cx.groundY_u - 0.1, `${c.id}: ground map (y ${mapY.toFixed(3)}) not under the apron (${cx.groundY_u.toFixed(3)})`);
  // draws, both looks
  const nPaint = draws(cx.object3d);
  const nAll = draws(pad.group);
  setPropLook(cx.object3d, "xray");
  const nX = draws(cx.object3d);
  const looked = [];
  cx.object3d.traverse((o) => o.userData.looks && looked.push(o));
  expect(looked.length >= 12 && looked.every((o) => o.material === o.userData.looks.xray), `${c.id}: setPropLook did not switch every mesh to x-ray`);
  expect(looked.every((o) => o.children.filter((e) => e.isLineSegments && e.userData.base0 !== undefined).every((e) => near(e.material.opacity, e.userData.base0))), `${c.id}: x-ray line levels`);
  setPropLook(cx.object3d, "painted");
  expect(looked.every((o) => o.material === o.userData.looks.painted), `${c.id}: back to painted`);
  expect(looked.every((o) => o.children.filter((e) => e.isLineSegments && e.userData.base0 !== undefined).every((e) => e.material.opacity <= 0.15 + 1e-9)), `${c.id}: painted lines above 0.15`);
  cx.setLook("xray");
  expect(draws(cx.object3d) === nX, `${c.id}: setLook(xray) draws`);
  cx.setLook("painted");
  expect(nPaint <= BUDGET && nX <= BUDGET, `${c.id}: ${nPaint} painted / ${nX} x-ray draws (budget ${BUDGET})`);
  expect(nPaint === nX, `${c.id}: draws differ by look (${nPaint} vs ${nX})`);
  // sanity: NaN, pickable, fog, shadows
  cx.update(12.34);
  cx.object3d.traverse((o) => {
    if (o.geometry?.attributes?.position && !box(o)) failures.push(`${c.id}: NaN in ${o.name}`);
    if (o.isInstancedMesh && !o.instanceMatrix.array.every(Number.isFinite)) failures.push(`${c.id}: NaN instance matrix in ${o.name}`);
    if (o.userData.nonPickable !== true) failures.push(`${c.id}: ${o.name || o.type} not marked nonPickable`);
    if ((o.isMesh || o.isLine || o.isPoints) && o.raycast === Object.getPrototypeOf(o).raycast) failures.push(`${c.id}: ${o.name || o.type} pickable`);
    for (const mt of [].concat(o.material ?? [], Object.values(o.userData.looks ?? {}))) if (!mt.fog) failures.push(`${c.id}: ${o.name || o.type} material without fog`);
    if (o.castShadow && !o.isLight && !CASTERS.test(o.name)) failures.push(`${c.id}: ${o.name} casts a shadow`);
  });
  // sizes
  const fss = box(cx.tower.getObjectByName("complex-fss-beams"));
  const masts = box(cx.masts);
  const water = box(cx.waterTower);
  const hard = box(cx.hardstand);
  const apron = box(cx.apron);
  expect(near(cx.towerHeight_u, 1.15 * H) && near(fss.max.y, 1.15 * H, 1e-3), `${c.id}: FSS lattice top ${fss.max.y.toFixed(3)} for 1.15 × ${H.toFixed(3)}`);
  expect(fss.min.y >= -L.plinthH - 1e-4, `${c.id}: FSS below the hardstand`);
  expect(near(masts.max.y, 1.3 * H, 1e-3), `${c.id}: lightning towers top ${masts.max.y.toFixed(3)} for 1.3 × ${H.toFixed(3)}`);
  // water tower axis: centre of the tank rim (the highest vertices) in plan
  let wx = 0;
  let wz = 0;
  let wn = 0;
  eachVertex(cx.waterTower, (p) => {
    if (p.y > water.max.y - 1e-3) (wx += p.x), (wz += p.z), wn++;
  });
  const wDist = Math.hypot(wx / wn, wz / wn);
  // 1.5 × the FSS height (very short stacks: pushed off the hardstand, never closer)
  expect(c.id.startsWith("tiny") ? wDist >= 1.5 * cx.towerHeight_u - 1e-3 : near(wDist, 1.5 * cx.towerHeight_u, 0.02), `${c.id}: water tower ${wDist.toFixed(2)} from the axis, want 1.5 × ${cx.towerHeight_u.toFixed(2)}`);
  expect(near(hard.max.y, -L.plinthH), `${c.id}: hardstand top ${hard.max.y} vs pad ground ${-L.plinthH}`);
  expect(near(apron.min.y, cx.groundY_u) && cx.groundY_u < -L.plinthH, `${c.id}: apron level`);
  expect(near(apron.max.x - apron.min.x, 1500 * SCALE, 0.05) || apron.max.x - apron.min.x > 1500 * SCALE, `${c.id}: apron narrower than 1.5 km`);
  // nothing inside the pad plinth (r < padR, −plinthH < y < 0)
  let intrude = null;
  cx.object3d.traverse((o) => {
    if (intrude || !(o.isMesh || o.isLine) || o === cx.person || o.parent === cx.person) return;
    eachVertex(o, (p) => {
      if (!intrude && Math.hypot(p.x, p.z) < L.padR - 1e-3 && p.y < -1e-3 && p.y > -L.plinthH + 1e-3) intrude = `${o.name || o.parent?.name} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
    });
  });
  expect(!intrude, `${c.id}: inside the pad plinth: ${intrude}`);
  // arms: one per interstage + payload, reaching the vehicle without entering it
  const wantArms = c.manifest ? c.manifest.filter((s) => s.kind === "interstage" || s.kind === "payload").length : 0;
  expect(cx.arms.length === wantArms, `${c.id}: ${cx.arms.length} arms, want ${wantArms}`);
  for (const arm of cx.arms) {
    let minR = Infinity;
    eachVertex(arm.mesh, (p) => (minR = Math.min(minR, Math.hypot(p.x, p.z))));
    const rv = widestAt(c.manifest, arm.y_u);
    expect(minR >= rv - 1e-6 && minR < rv + 0.12, `${c.id}: arm ${arm.partId} stops at ${minR.toFixed(3)} for vehicle radius ${rv.toFixed(3)}`);
    // the director swings it about its hinge with mesh.rotation.y: the hinge is at the tower face
    expect(near(arm.mesh.position.y, arm.y_u) && arm.mesh.position.x < 0, `${c.id}: arm ${arm.partId} hinge`);
  }
  // RSS at every angle: clear of the vehicle (over its span), the deck plinth and the FSS; finite
  const info = cx.rssInfo;
  expect(info?.clear === true, `${c.id}: RSS clearance solver failed`);
  const fssLocal = new THREE.Box3();
  const tf = cx.tower.getObjectByName("complex-fss-beams");
  for (let i = 0; i < tf.count; i++) {
    tf.getMatrixAt(i, im);
    fssLocal.expandByPoint(new THREE.Vector3().setFromMatrixPosition(im));
  }
  const inv = new THREE.Matrix4();
  for (const deg of [0, 20, 40, 60, 80, 100, 120]) {
    cx.setRssAngle(deg);
    cx.object3d.updateMatrixWorld(true);
    inv.copy(cx.tower.matrixWorld).invert();
    const rssMesh = cx.rss.getObjectByName("complex-rss");
    let bad = null;
    eachVertex(rssMesh, (p) => {
      if (bad) return;
      if (![p.x, p.y, p.z].every(Number.isFinite)) bad = "NaN";
      const r = Math.hypot(p.x, p.z);
      const rv = widestAt(c.manifest, p.y) || (p.y >= 0 && p.y <= H ? c.baseRadius_u : 0);
      if (rv && r < rv + 1e-3) bad = `inside the vehicle at y ${p.y.toFixed(2)} (r ${r.toFixed(2)} < ${rv.toFixed(2)})`;
      if (p.y < -1e-3 && r < L.padR - 1e-3) bad = `in the pad plinth (r ${r.toFixed(2)})`;
      const q = p.clone().applyMatrix4(inv);
      if (Math.abs(q.x) < fssLocal.max.x - 1e-3 && Math.abs(q.z) < fssLocal.max.z - 1e-3 && q.y > 0 && q.y < cx.towerHeight_u) bad = `inside the FSS (${q.x.toFixed(2)}, ${q.z.toFixed(2)})`;
    });
    expect(!bad, `${c.id}: RSS at ${deg}°: ${bad}`);
  }
  expect(cx.setRssAngle(-5) === 0 && cx.setRssAngle(500) === 120 && cx.rssAngle === 120, `${c.id}: setRssAngle clamps to 0–120`);
  cx.setRssAngle(0);
  // lightning towers: off the hardstand, clear of the director's pad camera (choreo.js padCamPose)
  const phiT = Math.atan2(cx.tower.position.x, cx.tower.position.z);
  const opts = [phiT - 1.15, phiT + 1.15];
  const offHome = (a) => Math.abs(Math.atan2(Math.sin(a - 0.58), Math.cos(a - 0.58)));
  const az = offHome(opts[0]) < offHome(opts[1]) ? opts[0] : opts[1];
  const camP = new THREE.Vector3(Math.sin(az) * 1.9 * H, 0, Math.cos(az) * 1.9 * H);
  const ray = camP.clone().normalize();
  let blocked = null;
  eachVertex(cx.masts, (p) => {
    const along = p.x * ray.x + p.z * ray.z;
    const side = Math.abs(p.x * ray.z - p.z * ray.x);
    if (!blocked && along > 0 && along < camP.length() - 0.5 && side < 0.5 && p.y < H) blocked = `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  });
  expect(!blocked, `${c.id}: a lightning tower stands in the pad camera's line of sight at ${blocked}`);
  // look / visibility / dispose round trip
  cx.setVisible(false);
  expect(!cx.object3d.visible && padGround.visible && grid.visible, `${c.id}: setVisible(false) should restore the pad ground`);
  cx.setVisible(true);
  expect(cx.object3d.visible && !padGround.visible, `${c.id}: setVisible(true) should adopt the pad again`);
  cx.dispose();
  expect(!cx.object3d.parent && padGround.visible && grid.visible && near(box(map.object3d.children[0]).max.y, -L.plinthH - 0.01), `${c.id}: dispose should detach and restore the pad`);
  cx.dispose(); // idempotent
  rows.push([c.id, nPaint, nX, nAll, ms.toFixed(1)]);
}

// Sizes scale with the inputs.
const base = { baseRadius_u: 0.5, stackHeight_u: 12 }; // shorter than every preset, still clear of the hardstand
const a = createLaunchComplex(base);
const b2 = createLaunchComplex({ ...base, stackHeight_u: 24 });
const tall = (cx) => box(cx.masts).max.y;
const wd = (cx) => {
  const bx = box(cx.waterTower);
  let x = 0;
  let z = 0;
  let n = 0;
  eachVertex(cx.waterTower, (p) => p.y > bx.max.y - 1e-3 && ((x += p.x), (z += p.z), n++));
  return Math.hypot(x / n, z / n);
};
expect(near(b2.towerHeight_u, 2 * a.towerHeight_u) && near(tall(b2), 2 * tall(a), 1e-3) && near(wd(b2), 2 * wd(a), 0.02), "tower, lightning towers or water tower do not scale with the stack");
const s2 = createLaunchComplex({ ...base, scale: SCALE * 2 });
const rise = (cx) => cx.hardstandY_u - cx.groundY_u;
const apronW = (cx) => {
  const bx = box(cx.apron);
  return bx.max.x - bx.min.x;
};
expect(near(rise(s2), 2 * rise(a)) && near(apronW(s2), 2 * apronW(a), 0.02), `metric sizes do not scale with \`scale\` (rise ${rise(a).toFixed(3)} → ${rise(s2).toFixed(3)})`);
for (const cx of [a, b2, s2]) cx.dispose();

// Timing (informative; the first call also builds the shared textures).
const tm = cases[0];
const N = 10;
let t1 = performance.now();
for (let i = 0; i < N; i++) createLaunchComplex({ baseRadius_u: tm.baseRadius_u, stackHeight_u: tm.stackHeight_u * (1 + i * 0.01), manifest: tm.manifest }).dispose();
const avg = (performance.now() - t1) / N;

console.log("case".padEnd(22), "painted", "x-ray", "+pad", "build ms");
for (const r of rows) console.log(String(r[0]).padEnd(22), String(r[1]).padStart(7), String(r[2]).padStart(5), String(r[3]).padStart(4), String(r[4]).padStart(8));
console.log(`average rebuild ${avg.toFixed(1)} ms over ${N} (Falcon 9); budget ${BUDGET} draws`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
