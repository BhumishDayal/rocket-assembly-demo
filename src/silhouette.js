// Twin silhouette (design doc §7, B8/C10): peach line art of a real rocket at true scale, from the extended
// pool's length / diameter / stages, for the side-by-side compare. No detail: stacked cylinders and a nose.
//   createSilhouette({ name, length_m, diameter_m, stages }) -> { object3d, update(camera), height_u, radius_u,
//                                                               name, dispose() }
// stages: a count, or an array of { length_m?, diameter_m? } bottom → top (missing values use visual ratios).
// The side profile lies in a plane that update(camera) turns to face the camera (yaw only); rings at the
// base and at every stage joint stay horizontal, so the outline still reads as 3-D from above.
import * as THREE from "three";
import { SCALE } from "./layout.js";

const PEACH = 0xffb48a;
// Visual ratios (shape only, never shown as data).
const NOSE_PER_D = 1.3; // nose length / diameter, capped at a quarter of the length
const STAGE_SHARE = { 1: [1], 2: [0.62, 0.38], 3: [0.48, 0.32, 0.2], 4: [0.42, 0.28, 0.18, 0.12] };
const RING_SEGMENTS = 48;

function stageList(stages, body_m, diameter_m) {
  const list = Array.isArray(stages) ? stages : Array.from({ length: Math.max(1, Math.round(stages) || 1) }, () => ({}));
  const n = list.length;
  const share = STAGE_SHARE[n] ?? Array.from({ length: n }, (_, i) => 0.66 ** i).map((v, _, a) => v / a.reduce((s, x) => s + x, 0));
  const given = list.reduce((s, st) => s + (st.length_m > 0 ? st.length_m : 0), 0);
  const freeShare = list.reduce((s, st, i) => s + (st.length_m > 0 ? 0 : share[i]), 0);
  const rest = Math.max(0, body_m - given);
  return list.map((st, i) => ({
    length_m: st.length_m > 0 ? st.length_m : freeShare > 0 ? (rest * share[i]) / freeShare : 0,
    diameter_m: st.diameter_m > 0 ? st.diameter_m : diameter_m,
  }));
}

export function createSilhouette({ name = "", length_m, diameter_m, stages = 2 } = {}) {
  const S = SCALE;
  const L = Math.max(0.1, +length_m || 0);
  const D = Math.max(0.1, +diameter_m || 0);
  const nose = Math.min(NOSE_PER_D * D, 0.25 * L);
  const list = stageList(stages, L - nose, D);
  // Scale the stack so its total is exactly the record length (given stage lengths may not add up).
  const sum = list.reduce((s, st) => s + st.length_m, 0) + nose;
  const k = sum > 0 ? L / sum : 1;

  const pos = [];
  const seg = (x0, y0, x1, y1) => pos.push(x0 * S, y0 * S, 0, x1 * S, y1 * S, 0);
  const ring = (r, y) => {
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = (i / RING_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
      pos.push(Math.cos(a0) * r * S, y * S, Math.sin(a0) * r * S, Math.cos(a1) * r * S, y * S, Math.sin(a1) * r * S);
    }
  };
  let y = 0;
  let r = list[0].diameter_m / 2;
  ring(r, 0);
  seg(-r, 0, r, 0);
  for (const st of list) {
    const rn = st.diameter_m / 2;
    if (Math.abs(rn - r) > 1e-6) seg(-r, y, r, y), seg(-rn, y, rn, y); // diameter change at the joint
    const h = st.length_m * k;
    seg(-rn, y, -rn, y + h);
    seg(rn, y, rn, y + h);
    y += h;
    seg(-rn, y, rn, y); // stage joint (or the nose base)
    ring(rn, y);
    r = rn;
  }
  // Tangent-ogive nose from the top stage's radius to the tip.
  const noseH = nose * k;
  const rho = (r * r + noseH * noseH) / (2 * r);
  let px = r;
  let py = y;
  for (let i = 1; i <= 16; i++) {
    const s = (noseH * i) / 16;
    const rx = Math.max(0, Math.sqrt(Math.max(rho * rho - s * s, 0)) + r - rho);
    seg(px, py, rx, y + s);
    seg(-px, py, -rx, y + s);
    px = rx;
    py = y + s;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.7, depthWrite: false, fog: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.raycast = () => {};
  const object3d = new THREE.Group();
  object3d.name = `silhouette:${name}`;
  object3d.add(lines);
  const tmp = new THREE.Vector3();

  return {
    object3d,
    name,
    height_u: L * S,
    radius_u: (Math.max(...list.map((st) => st.diameter_m)) / 2) * S,
    // Turn the profile plane to face the camera (yaw only).
    update(camera) {
      if (!camera) return;
      object3d.getWorldPosition(tmp);
      object3d.rotation.y = Math.atan2(camera.position.x - tmp.x, camera.position.z - tmp.z);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      object3d.removeFromParent();
    },
  };
}
