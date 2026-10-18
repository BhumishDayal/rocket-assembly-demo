// Scale anchors (design doc §7, C9): faint peach line-art around the pad so the rocket reads at its true size.
//   createAnchors({ baseRadius_u, stackHeight_u, scale, cameraAzimuth }) -> { object3d, human, tower, trench,
//                                                    masts, towerHeight_u, setVisible(bool), update(t), dispose() }
// (1) a 1.8 m person (12 line segments) standing at the pad edge, facing the rocket;
// (2) a strongback/service tower beside the pad, 1.08 × the stack tall, with cross-braced bays and a top boom
//     reaching toward the vehicle;
// (3) the flame trench as a rectangular cut in the deck, running out past the pad edge;
// (4) four 25 m floodlight masts around the pad, each with a small lit sprite.
// Real sizes in metres (person, masts) go through `scale` (scene units per metre); the rest follows the
// rocket. Lines use the shared peach line material (fog on, depth fade) at opacity 0.35 (tower 0.25), cast no shadows and
// are not pickable. Placement assumes the default camera azimuth (about 0.58 rad, the home view): person in
// front-right, tower to the left and slightly behind, trench to the right, masts out to the sides and behind
// (none between the camera and the rocket).
import * as THREE from "three";
import { SCALE } from "./layout.js";
import { padRadius, peachLineMaterial } from "./parts.js";

const OPACITY = 0.35;
const TOWER_OPACITY = 0.25; // the tower is tall and close to the rocket, so it sits quieter
const HUMAN_M = 1.8; // a person, for scale
const MAST_M = 25; // floodlight mast height
const TOWER_SHARE = 1.08; // tower height / stack height
// Visual sizes (shape only).
const TOWER_MIN_W_M = 4; // tower width, at least this
const TOWER_W_SHARE = 0.06; // or this share of its height
const TOWER_CLEAR_M = 4; // gap between the vehicle's widest radius and the tower
const MAST_MIN_DIST_M = 40; // masts stand at least this far from the vehicle axis
const BAYS = 6;

// Lathe-style azimuth used everywhere in the demo: phi from +Z toward +X.
const at = (phi, r, y = 0) => new THREE.Vector3(Math.sin(phi) * r, y, Math.cos(phi) * r);

function lineSet(name, segments, opacity = OPACITY) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(segments.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z]), 3));
  geo.computeBoundingSphere();
  const lines = new THREE.LineSegments(geo, peachLineMaterial(opacity));
  lines.name = name;
  lines.raycast = () => {};
  lines.castShadow = false;
  lines.receiveShadow = false;
  return lines;
}

export function createAnchors({ baseRadius_u = 1, stackHeight_u = 10, scale = SCALE, cameraAzimuth = 0.58 } = {}) {
  const b = Math.max(0.05, baseRadius_u);
  const H = Math.max(0.1, stackHeight_u);
  const m = (metres) => metres * scale;
  const padR = padRadius(b);
  const v = (x, y, z = 0) => new THREE.Vector3(x, y, z);
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
  humanSegs.push(
    [p(0, 1.58), p(0, 0.95)],
    [p(-0.2, 1.45), p(0.2, 1.45)],
    [p(-0.2, 1.45), p(-0.27, 0.82)],
    [p(0.2, 1.45), p(0.27, 0.82)],
    [p(0, 0.95), p(-0.14, 0)],
    [p(0, 0.95), p(0.14, 0)],
  );
  const human = lineSet("anchor-human", humanSegs);
  const phiH = cameraAzimuth + 0.35;
  human.position.copy(at(phiH, padR * 0.88));
  human.rotation.y = phiH + Math.PI; // the figure's plane faces the rocket axis

  // (2) Tower: square truss column, horizontal frames at every bay, X-braces on the face toward the rocket,
  // a top boom reaching toward the vehicle with a diagonal strut. Local +X points away from the rocket.
  const tH = TOWER_SHARE * H;
  const w = Math.max(m(TOWER_MIN_W_M), TOWER_W_SHARE * tH);
  const dT = b + m(TOWER_CLEAR_M) + w / 2;
  const hw = w / 2;
  const towerSegs = [];
  const corners = [v(-hw, 0, -hw), v(hw, 0, -hw), v(hw, 0, hw), v(-hw, 0, hw)];
  for (const c of corners) towerSegs.push([c.clone(), c.clone().setY(tH)]);
  for (let k = 0; k <= BAYS; k++) {
    const y = (tH * k) / BAYS;
    for (let i = 0; i < 4; i++) towerSegs.push([corners[i].clone().setY(y), corners[(i + 1) % 4].clone().setY(y)]);
  }
  for (let k = 0; k < BAYS; k++) {
    const y0 = (tH * k) / BAYS;
    const y1 = (tH * (k + 1)) / BAYS;
    towerSegs.push([v(-hw, y0, -hw), v(-hw, y1, hw)], [v(-hw, y0, hw), v(-hw, y1, -hw)]);
  }
  const reach = dT - hw - b * 1.1; // boom ends just short of the vehicle
  const boomH = Math.max(m(1.5), 0.012 * tH);
  towerSegs.push(
    [v(-hw, tH, -hw * 0.4), v(-hw - reach, tH, -hw * 0.4)],
    [v(-hw, tH, hw * 0.4), v(-hw - reach, tH, hw * 0.4)],
    [v(-hw - reach, tH, -hw * 0.4), v(-hw - reach, tH, hw * 0.4)],
    [v(-hw, tH - boomH, 0), v(-hw - reach, tH, 0)],
    [v(-hw, tH - 4 * boomH, 0), v(-hw - reach * 0.55, tH, 0)],
  );
  const tower = lineSet("anchor-tower", towerSegs, TOWER_OPACITY);
  const phiT = cameraAzimuth - Math.PI / 2 - 0.35;
  tower.position.copy(at(phiT, dT));
  tower.rotation.y = phiT - Math.PI / 2; // local +X → radially outward

  // (3) Flame trench: outer and inner rectangle on the deck, from under the engines out past the pad edge.
  const tw = 1.1 * b;
  const x0 = -1.1 * b;
  const x1 = padR * 1.08;
  const yT = 0.006;
  const rect = (a, bb, z) => [
    [v(a, yT, -z), v(bb, yT, -z)],
    [v(bb, yT, -z), v(bb, yT, z)],
    [v(bb, yT, z), v(a, yT, z)],
    [v(a, yT, z), v(a, yT, -z)],
  ];
  const trench = lineSet("anchor-trench", [...rect(x0, x1, tw), ...rect(x0 + 0.15 * b, x1, tw * 0.82)]);
  const phiTr = cameraAzimuth + Math.PI / 2;
  trench.rotation.y = phiTr - Math.PI / 2; // local +X → along azimuth phiTr

  // (4) Floodlight masts on the diagonals: pole, lamp bar, tripod feet; one lit sprite per lamp bar.
  const mastH = m(MAST_M);
  const rM = Math.max(padR * 1.45, b + m(MAST_MIN_DIST_M));
  const yG = -0.18; // ground level under the pad (createPad)
  const mastSegs = [];
  const lamps = [];
  for (const [k, off] of [1.25, -1.25, 2.5, -2.5].entries()) {
    const phi = cameraAzimuth + off; // radians from the camera direction
    const base = at(phi, rM, yG);
    const top = base.clone().setY(yG + mastH);
    const tangent = new THREE.Vector3(Math.cos(phi), 0, -Math.sin(phi)).multiplyScalar(m(1.5));
    const inward = base.clone().setY(0).normalize().multiplyScalar(-m(0.6));
    mastSegs.push([base, top], [top.clone().add(tangent), top.clone().sub(tangent)]);
    for (let f = 0; f < 3; f++) {
      const a = phi + (f * Math.PI * 2) / 3;
      mastSegs.push([base.clone().add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(m(2))), base.clone().setY(yG + m(3))]);
    }
    lamps.push(top.clone().add(inward));
  }
  const masts = lineSet("anchor-masts", mastSegs);
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
    const s = new THREE.Sprite(mat);
    s.name = `anchor-lamp-${k}`;
    s.position.copy(pos);
    const size = m(1.2);
    s.scale.set(size, size, 1);
    s.raycast = () => {};
    return s;
  });

  object3d.add(human, tower, trench, masts, ...sprites);
  const all = [human, tower, trench, masts];
  return {
    object3d,
    human,
    tower,
    trench,
    masts,
    lamps: sprites,
    towerHeight_u: tH,
    setVisible(on) {
      object3d.visible = !!on;
    },
    // Floodlights shimmer very slightly (t in seconds).
    update(t = 0) {
      sprites.forEach((s, k) => (s.material.opacity = 0.9 + 0.1 * Math.sin(t * 2.3 + k * 1.7)));
    },
    dispose() {
      for (const l of all) (l.geometry.dispose(), l.material.dispose());
      for (const s of sprites) s.material.dispose();
      lampTex.dispose();
      object3d.removeFromParent();
    },
  };
}
