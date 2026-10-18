// Scale anchors and pad furniture (design doc §7 C9, round 13): x-ray style structures around the pad, sized
// in real metres or from the rocket, so the vehicle reads at its true size and the pad has depth.
//   createAnchors({ baseRadius_u, stackHeight_u, manifest, scale, cameraAzimuth })
//     -> { object3d, human, tower, towerFrame, arms, cableTray, masts, lamps, towerHeight_u, setVisible(bool),
//          update(t), dispose() }
//   (1) a 1.8 m person at the deck edge, facing the rocket: a dark silhouette (painted) or 12 line segments (x-ray);
//   (2) the strongback/service tower: a lattice column 1.08 × the stack tall (columns, girders, braces), with
//       one umbilical arm per stage joint (each interstage) and at the payload adapter, reaching the vehicle;
//       arms[i] = { mesh, y_u, reach_u, partId } with the mesh's origin on its hinge at the tower face, so
//       retracting is mesh.rotation.y (UI 3);
//   (3) a cable tray on the deck from the tower to the launch mount;
//   (4) four 25 m lattice lightning masts (plus a 6 m air terminal) on the ground around the hardstand, each
//       with a lamp sprite.
//   createDroneShip({ size_u }) -> { object3d, deckY, length_u, width_u, dispose() }
//     the booster landing barge: hull, landing circle with a cross, four corner thrusters.
// Layout comes from padLayout() in parts.js (deck top y = 0, ground at −plinthH; placement around the home
// camera azimuth: person front-right, tower left and slightly behind, masts at the sides and behind). Steel
// meshes are painted galvanized dark grey by default (edge lines at 0.15 level) and switch to the x-ray prop
// materials with peach edges through setPropLook (parts.js); only the tower and its arms cast and receive
// shadows; nothing is pickable.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./layout.js";
import { addLines, disposeLooks, padLayout, paintProp, peachLineMaterial, propMaterial, propMaterials } from "./parts.js";

const OPACITY = 0.35; // person line art
const TOWER_LINES = 0.25; // the tower is tall and close to the rocket, so it sits quieter
const ARM_LINES = 0.35;
const MAST_LINES = 0.3;
const MAST_M = 25; // lightning-mast lattice height
const ROD_M = 6; // air terminal on top
const TOWER_SHARE = 1.08; // tower height / stack height
// Visual sizes (shape only).
const TOWER_MIN_W_M = 4;
const TOWER_W_SHARE = 0.06;
const TOWER_CLEAR_M = 4;
const MAST_MIN_DIST_M = 40;
const BAYS = 6;

const at = (phi, r, y = 0) => new THREE.Vector3(Math.sin(phi) * r, y, Math.cos(phi) * r);
const v = (x, y, z = 0) => new THREE.Vector3(x, y, z);
const noPick = (o) => ((o.raycast = () => {}), o);

// Merge indexed geometries (boxes, cylinders) on position + normal + uv into one. shade: a per-member grey
// jitter (±shade) in a colour attribute, so a painted lattice reads as separate galvanized members.
function mergeSolid(geos, { shade = 0 } = {}) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  let base = 0;
  geos.forEach((g, k) => {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    const h = Math.sin(k * 12.9898 + 4.1) * 43758.5453;
    const c = 1 + shade * (2 * (h - Math.floor(h)) - 1); // 1 ± shade, fixed per member
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
      if (shade) col.push(c, c, c);
    }
    for (const i of g.index.array) idx.push(i + base);
    base += p.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (shade) out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}
const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
// Box from a to b (long axis), w × d cross-section, thin side facing `out`.
function strut(a, b, w, d, out) {
  const yAxis = b.clone().sub(a);
  const len = yAxis.length();
  yAxis.normalize();
  const zAxis = new THREE.Vector3().crossVectors(out, yAxis).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  return new THREE.BoxGeometry(d, len, w).applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}
// Steel prop: x-ray dark steel with peach edges, painted galvanized dark grey (default; see paintProp).
const LATTICE_LINE_K = 0.2; // painted lattices: their many thin members would read peach at the prop level
function steelMesh(geo, name, { shadows = false, lines = OPACITY, lineK } = {}) {
  const mesh = noPick(new THREE.Mesh(geo, propMaterial(propMaterials().steelDark)));
  mesh.name = name;
  mesh.castShadow = mesh.receiveShadow = shadows;
  addLines(mesh, lines);
  paintProp(mesh, geo.attributes.color ? "galvShaded" : "galv", lineK ? { lineK } : {});
  return mesh;
}
function lineSet(name, segments, opacity = OPACITY) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(segments.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z]), 3));
  geo.computeBoundingSphere();
  const lines = noPick(new THREE.LineSegments(geo, peachLineMaterial(opacity)));
  lines.name = name;
  return lines;
}

// Umbilical arm heights from the manifest: the middle of every interstage (the stage joints) and the payload
// adapter; each arm reaches to the widest part at that height (plus a small gap).
function armSpecs(manifest, scale) {
  if (!Array.isArray(manifest)) return [];
  const widest = (y) => Math.max(0, ...manifest.filter((s) => s.kind !== "engines" && y >= s.slotY - 1e-9 && y <= s.slotY + s.height + 1e-9).map((s) => s.radius));
  const out = [];
  for (const s of manifest) {
    if (s.kind === "interstage") out.push({ y: s.slotY + s.height / 2, id: s.id });
    if (s.kind === "payload") out.push({ y: s.slotY + Math.max(0.5 * (s.geom?.adapterH_m ?? 0) * scale, 0.02), id: s.id });
  }
  return out.map((a) => ({ ...a, r: widest(a.y) }));
}

export function createAnchors({ baseRadius_u = 1, stackHeight_u = 10, manifest = null, scale = SCALE, cameraAzimuth = 0.58 } = {}) {
  const L = padLayout({ baseRadius_u, cameraAzimuth });
  const { b, padR } = L;
  const H = Math.max(0.1, stackHeight_u);
  const m = (metres) => metres * scale;
  const groundY = -L.plinthH;
  const object3d = new THREE.Group();
  object3d.name = "scale-anchors";

  // (1) Person: head hexagon 6, torso 1, shoulders 1, arms 2, legs 2 = 12 segments; 1.8 m to the top of the head.
  const p = (x, y) => v(m(x), m(y));
  const humanSegs = [];
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    humanSegs.push([p(Math.sin(a0) * 0.11, 1.69 + Math.cos(a0) * 0.11), p(Math.sin(a1) * 0.11, 1.69 + Math.cos(a1) * 0.11)]);
  }
  humanSegs.push([p(0, 1.58), p(0, 0.95)], [p(-0.2, 1.45), p(0.2, 1.45)], [p(-0.2, 1.45), p(-0.27, 0.82)], [p(0.2, 1.45), p(0.27, 0.82)], [p(0, 0.95), p(-0.14, 0)], [p(0, 0.95), p(0.14, 0)]);
  // Painted: a dark silhouette (head, torso, arms, legs; 1.8 m, facing the rocket); the 12-segment line figure
  // is its child and shows only in the x-ray look (the silhouette's x-ray material is invisible).
  const limb = (x0, y0, x1, y1, w, d) => strut(p(x0, y0), p(x1, y1), m(w), m(d), v(0, 0, 1));
  const body = [
    new THREE.SphereGeometry(m(0.11), 12, 8).translate(0, m(1.69), 0),
    new THREE.CylinderGeometry(m(0.05), m(0.06), m(0.08), 8).translate(0, m(1.55), 0), // neck
    box(m(0.4), m(0.55), m(0.22), 0, m(1.2), 0), // torso
    box(m(0.34), m(0.18), m(0.2), 0, m(0.95), 0), // hips
    limb(-0.2, 1.42, -0.27, 0.82, 0.09, 0.1),
    limb(0.2, 1.42, 0.27, 0.82, 0.09, 0.1),
    limb(-0.1, 0.92, -0.14, 0.05, 0.13, 0.15),
    limb(0.1, 0.92, 0.14, 0.05, 0.13, 0.15),
    box(m(0.12), m(0.06), m(0.26), -m(0.14), m(0.03), m(0.04)), // boots
    box(m(0.12), m(0.06), m(0.26), m(0.14), m(0.03), m(0.04)),
  ].map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()])));
  const human = noPick(new THREE.Mesh(mergeSolid(body), propMaterial(propMaterials().steelDark)));
  human.name = "anchor-human";
  human.material.visible = false; // x-ray: only the line figure
  const figure = lineSet("anchor-human-lines", humanSegs);
  figure.userData.lookOnly = "xray";
  human.add(figure);
  if (!paintProp(human, "person")) (human.material.visible = true), (figure.visible = false); // classic look
  else figure.visible = false;
  const phiH = cameraAzimuth + 0.35;
  human.position.copy(at(phiH, padR * 0.88));
  human.rotation.y = phiH + Math.PI; // the figure's plane faces the rocket axis

  // (2) Tower (local +X points away from the rocket; base on the deck at y = 0).
  const tH = TOWER_SHARE * H;
  const w = Math.max(m(TOWER_MIN_W_M), TOWER_W_SHARE * tH);
  const hw = w / 2;
  const dT = b + m(TOWER_CLEAR_M) + hw;
  const cw = 0.07 * w; // column
  const bw = 0.035 * w; // brace
  const c = hw - cw / 2;
  const frame = [];
  for (const [x, z] of [[c, c], [-c, c], [-c, -c], [c, -c]]) frame.push(box(cw, tH, cw, x, tH / 2, z));
  for (let k = 0; k <= BAYS; k++) {
    const y = Math.max(cw / 2, Math.min(tH - cw / 2, (tH * k) / BAYS));
    frame.push(box(cw * 0.8, cw * 0.8, w, c, y, 0), box(cw * 0.8, cw * 0.8, w, -c, y, 0), box(w, cw * 0.8, cw * 0.8, 0, y, c), box(w, cw * 0.8, cw * 0.8, 0, y, -c));
  }
  for (let k = 0; k < BAYS; k++) {
    const y0 = (tH * k) / BAYS + bw; // brace ends inset so their cross-section stays inside the column height
    const y1 = (tH * (k + 1)) / BAYS - bw;
    // X-braces on the face toward the rocket, a zigzag diagonal on the other three faces.
    frame.push(strut(v(-c, y0, -c), v(-c, y1, c), bw, bw, v(-1, 0, 0)), strut(v(-c, y0, c), v(-c, y1, -c), bw, bw, v(-1, 0, 0)));
    const s = k % 2 ? 1 : -1;
    frame.push(strut(v(c, y0, -c * s), v(c, y1, c * s), bw, bw, v(1, 0, 0)));
    frame.push(strut(v(-c * s, y0, c), v(c * s, y1, c), bw, bw, v(0, 0, 1)), strut(v(-c * s, y0, -c), v(c * s, y1, -c), bw, bw, v(0, 0, -1)));
  }
  const towerFrame = steelMesh(mergeSolid(frame, { shade: 0.08 }), "anchor-tower-frame", { shadows: true, lines: TOWER_LINES, lineK: LATTICE_LINE_K });
  const tower = new THREE.Group();
  tower.name = "anchor-tower";
  const phiT = cameraAzimuth - Math.PI / 2 - 0.35;
  tower.position.copy(at(phiT, dT));
  tower.rotation.y = phiT - Math.PI / 2; // local +X → radially outward
  tower.add(towerFrame);

  // Umbilical arms: truss beams from a hinge block at the tower face to an umbilical plate at the vehicle.
  const armH = Math.max(m(1.5), 0.03 * tH);
  const armW = 0.35 * w;
  const arms = armSpecs(manifest, scale).map((a) => {
    const reach = Math.max(0.05, dT - hw - a.r - 0.03);
    const parts = [
      box(cw * 1.6, armH * 1.25, armW * 1.25, -cw * 0.8, 0, 0), // hinge block on the tower face
      box(0.03, armH * 1.1, armW * 1.15, -reach, 0, 0), // umbilical plate at the tip
    ];
    for (const yy of [armH / 2, -armH / 2]) for (const zz of [armW / 2, -armW / 2]) parts.push(box(reach, bw, bw, -reach / 2, yy, zz));
    const nSeg = Math.max(2, Math.ceil(reach / armH));
    for (let i = 0; i < nSeg; i++) {
      const xa = (-reach * i) / nSeg;
      const xb = (-reach * (i + 1)) / nSeg;
      const up = i % 2 ? 1 : -1;
      for (const zz of [armW / 2, -armW / 2]) parts.push(strut(v(xa, (up * armH) / 2, zz), v(xb, (-up * armH) / 2, zz), bw * 0.8, bw * 0.8, v(0, 0, Math.sign(zz))));
    }
    const mesh = steelMesh(mergeSolid(parts, { shade: 0.08 }), `anchor-arm:${a.id}`, { shadows: true, lines: ARM_LINES, lineK: LATTICE_LINE_K });
    mesh.position.set(-hw, a.y, 0); // origin on the hinge
    tower.add(mesh);
    return { mesh, y_u: a.y, reach_u: reach, partId: a.id };
  });

  // (3) Cable tray on the deck from the tower face to the launch mount.
  const trayLen = Math.max(0.05, dT - hw - L.mountR * 1.02);
  const trayW = 0.12 * b + 0.05;
  const tray = mergeSolid([box(trayLen, 0.012, trayW, -hw - trayLen / 2, 0.006, 0), box(trayLen, 0.035, 0.012, -hw - trayLen / 2, 0.0175, trayW / 2), box(trayLen, 0.035, 0.012, -hw - trayLen / 2, 0.0175, -trayW / 2)]);
  const cableTray = steelMesh(tray, "anchor-cable-tray");
  tower.add(cableTray);

  // (4) Lightning masts: tapered three-legged lattice with rings, zigzag bracing and an air terminal; one
  // merged mesh for all four; a lamp sprite on each, on the side facing the pad.
  const mastH = m(MAST_M);
  const rM = Math.max(padR * 1.45, b + m(MAST_MIN_DIST_M));
  const rb = m(1.2);
  const rt = m(0.4);
  const mb = m(0.15);
  const LEVELS = 7;
  const mastGeos = [];
  const lamps = [];
  for (const off of [1.25, -1.25, 2.5, -2.5]) {
    const phi = cameraAzimuth + off; // radians from the camera direction; none between the camera and the rocket
    const base = at(phi, rM, groundY);
    // y is clamped half a member above the ground so the tilted members' corners stay above it
    const leg = (i, y) => {
      y = Math.max(y, mb * 0.6);
      const r = rb + ((rt - rb) * y) / mastH;
      const a = (i * Math.PI * 2) / 3 + phi;
      return base.clone().add(v(Math.cos(a) * r, y, Math.sin(a) * r));
    };
    for (let i = 0; i < 3; i++) mastGeos.push(strut(leg(i, 0), leg(i, mastH), mb, mb, leg(i, 0).sub(base).setY(0).normalize()));
    for (let k = 0; k <= LEVELS; k++) {
      const y = (mastH * k) / LEVELS;
      for (let i = 0; i < 3; i++) mastGeos.push(strut(leg(i, y), leg((i + 1) % 3, y), mb * 0.7, mb * 0.7, v(0, 1, 0)));
      if (k < LEVELS) {
        const y1 = (mastH * (k + 1)) / LEVELS;
        for (let i = 0; i < 3; i++) {
          const a0 = k % 2 ? leg(i, y) : leg((i + 1) % 3, y);
          const a1 = k % 2 ? leg((i + 1) % 3, y1) : leg(i, y1);
          const mid = leg(i, y).add(leg((i + 1) % 3, y)).multiplyScalar(0.5).sub(base).setY(0).normalize();
          mastGeos.push(strut(a0, a1, mb * 0.6, mb * 0.6, mid));
        }
      }
    }
    const top = base.clone().setY(groundY + mastH);
    mastGeos.push(strut(top, top.clone().setY(groundY + mastH + m(ROD_M)), mb * 0.6, mb * 0.6, v(0, 0, 1)));
    lamps.push(base.clone().setY(groundY + mastH * 0.85).add(base.clone().setY(0).normalize().multiplyScalar(-(rb + m(0.6)))));
  }
  const masts = steelMesh(mergeSolid(mastGeos, { shade: 0.08 }), "anchor-masts", { lines: MAST_LINES, lineK: LATTICE_LINE_K });
  const lampTex = (() => {
    const n = 32;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) / 0.5;
        data.set([255, 255, 255, Math.round(255 * Math.exp(-((r / 0.35) ** 2)) * (1 - Math.min(1, r)))], (y * n + x) * 4);
      }
    }
    const t = new THREE.DataTexture(data, n, n);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  })();
  const sprites = lamps.map((pos, k) => {
    // warm peach-white so the lamps sit in the palette
    const mat = new THREE.SpriteMaterial({ map: lampTex, color: new THREE.Color(1.0, 0.8, 0.62).multiplyScalar(1.3), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const s = noPick(new THREE.Sprite(mat));
    s.name = `anchor-lamp-${k}`;
    s.position.copy(pos);
    const size = m(1.2);
    s.scale.set(size, size, 1);
    return s;
  });

  object3d.add(human, tower, masts, ...sprites);
  return {
    object3d,
    human,
    tower,
    towerFrame,
    arms,
    cableTray,
    masts,
    lamps: sprites,
    trench: null, // the flame trench is real geometry in createPad now
    towerHeight_u: tH,
    setVisible(on) {
      object3d.visible = !!on;
    },
    // Lamps shimmer very slightly (t in seconds).
    update(t = 0) {
      sprites.forEach((s, k) => (s.material.opacity = 0.9 + 0.1 * Math.sin(t * 2.3 + k * 1.7)));
    },
    dispose() {
      disposeLooks(object3d);
      object3d.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      lampTex.dispose();
      object3d.removeFromParent();
    },
  };
}

// Booster landing barge, deck top at y = 0, four azimuth thrusters under the corners. size_u = length; width
// 0.57 × length (visual ratio). look "painted" (default, for the photoreal ocean): charcoal hull, grey deck,
// bulwarks and stern deckhouses, a white landing circle with a cross; 3 draws. look "xray": see-through hull
// and a peach circle, as before; 5 draws. The deck receives shadows (the booster's, at touchdown).
export function createDroneShip({ size_u = 6, look = "painted" } = {}) {
  if (look === "painted") return paintedDroneShip(size_u);
  const Lh = Math.max(0.1, size_u);
  const W = 0.57 * Lh;
  const D = 0.09 * Lh;
  const mats = propMaterials();
  const object3d = new THREE.Group();
  object3d.name = "drone-ship";
  const hull = noPick(new THREE.Mesh(new THREE.BoxGeometry(Lh, D, W).translate(0, -D / 2, 0), propMaterial(mats.body)));
  hull.name = "drone-hull";
  if (hull.material.transparent) hull.material.opacity = 0.75;
  hull.castShadow = hull.receiveShadow = true;
  addLines(hull, 0.4);
  const thr = [];
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const x = sx * 0.42 * Lh;
      const z = sz * 0.38 * W;
      thr.push(new THREE.CylinderGeometry(0.035 * Lh, 0.035 * Lh, 0.05 * Lh, 16).translate(x, -D - 0.025 * Lh, z), new THREE.CylinderGeometry(0.05 * Lh, 0.05 * Lh, 0.012 * Lh, 20).translate(x, -D - 0.05 * Lh, z));
    }
  }
  const thrusters = noPick(new THREE.Mesh(mergeSolid(thr), propMaterial(mats.steelDark)));
  thrusters.name = "drone-thrusters";
  addLines(thrusters, 0.35);
  const R = 0.38 * W;
  const segs = [];
  for (let i = 0; i < 64; i++) {
    const a0 = (i / 64) * Math.PI * 2;
    const a1 = ((i + 1) / 64) * Math.PI * 2;
    segs.push([v(Math.cos(a0) * R, 0.004, Math.sin(a0) * R), v(Math.cos(a1) * R, 0.004, Math.sin(a1) * R)]);
  }
  const k = R * Math.SQRT1_2 * 0.8;
  segs.push([v(-k, 0.004, -k), v(k, 0.004, k)], [v(-k, 0.004, k), v(k, 0.004, -k)]);
  const circle = lineSet("drone-landing-circle", segs, 0.6);
  object3d.add(hull, thrusters, circle);
  return {
    object3d,
    deckY: 0,
    length_u: Lh,
    width_u: W,
    freeboard_u: 0.45 * D, // deck height above the water when floating (visual)
    dispose() {
      object3d.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      object3d.removeFromParent();
    },
  };
}

function paintedDroneShip(size_u) {
  const Lh = Math.max(0.1, size_u);
  const W = 0.57 * Lh;
  const D = 0.09 * Lh;
  // Box with a flat colour per face: top faces take `top`, the rest `side`.
  const box = (sx, sy, sz, x, y, z, side, top = side) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
    const n = g.attributes.normal;
    const col = new Float32Array(n.count * 3);
    const a = new THREE.Color(side);
    const b = new THREE.Color(top);
    for (let i = 0; i < n.count; i++) (n.getY(i) > 0.5 ? b : a).toArray(col, i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };
  // Visual proportions of the length (bulwark height, deckhouse size).
  const hb = 0.022 * Lh;
  const tb = 0.006 * Lh;
  const parts = [
    box(Lh, D, W, 0, -D / 2, 0, 0x2a2d32, 0x4f5358), // charcoal hull, grey deck
    box(Lh * 0.92, hb, tb, -Lh * 0.04, hb / 2, W / 2 - tb / 2, 0x2c2f34), // bulwarks along both sides
    box(Lh * 0.92, hb, tb, -Lh * 0.04, hb / 2, -W / 2 + tb / 2, 0x2c2f34),
    box(tb, hb * 1.6, W * 0.62, -Lh / 2 + tb / 2 + 0.07 * Lh, hb * 0.8, 0, 0x2c2f34), // stern blast wall
  ];
  for (const sz of [1, -1]) parts.push(box(0.11 * Lh, 0.045 * Lh, 0.16 * W, -Lh / 2 + 0.06 * Lh, 0.0225 * Lh, sz * (W / 2 - 0.1 * W), 0x3b3f45, 0x55595f)); // deckhouses
  const hull = noPick(new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.15 })));
  hull.name = "drone-hull";
  hull.castShadow = hull.receiveShadow = true;
  // Landing marks: a white ring with a cross, a hair above the deck.
  const R = 0.38 * W;
  const k = R * 0.62;
  const bar = (len, ang) => new THREE.PlaneGeometry(len, R * 0.07).rotateZ(ang);
  const marks = mergeGeometries([new THREE.RingGeometry(R * 0.92, R, 96), bar(2 * k, Math.PI / 4), bar(2 * k, -Math.PI / 4)].map((g) => g.deleteAttribute("uv") && g)).rotateX(-Math.PI / 2).translate(0, 0.0015 * Lh, 0);
  const circle = noPick(new THREE.Mesh(marks, new THREE.MeshStandardMaterial({ color: 0xe6e6e2, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  circle.name = "drone-landing-circle";
  circle.receiveShadow = true;
  const thr = [];
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const x = sx * 0.42 * Lh;
      const z = sz * 0.38 * W;
      thr.push(new THREE.CylinderGeometry(0.035 * Lh, 0.035 * Lh, 0.05 * Lh, 16).translate(x, -D - 0.025 * Lh, z), new THREE.CylinderGeometry(0.05 * Lh, 0.05 * Lh, 0.012 * Lh, 20).translate(x, -D - 0.05 * Lh, z));
    }
  }
  const thrusters = noPick(new THREE.Mesh(mergeSolid(thr), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6, metalness: 0.5 })));
  thrusters.name = "drone-thrusters";
  const object3d = new THREE.Group();
  object3d.name = "drone-ship";
  object3d.add(hull, thrusters, circle);
  return {
    object3d,
    deckY: 0,
    length_u: Lh,
    width_u: W,
    freeboard_u: 0.45 * D, // deck height above the water when floating (visual)
    look: "painted",
    dispose() {
      object3d.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      object3d.removeFromParent();
    },
  };
}
