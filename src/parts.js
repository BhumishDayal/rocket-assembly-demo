// Procedural rocket parts. Pure three.js geometry, no data: every number here is a visual proportion.
// A part is a group whose local y=0 is the part's bottom; its pieces are translation-only children
// (the reveal shader relies on that: part height h maps to piece-local y = h - piece.position.y).
import * as THREE from "three";

export const COLORS = {
  body: 0xe9e9e4,
  accent: 0x15171c,
  metal: 0x3b3f48,
  gold: 0xc9a24a,
  panel: 0x1b2a4a,
  holo: 0x5cc8ff,
};

export function createMaterials() {
  const common = { side: THREE.DoubleSide };
  return {
    body: new THREE.MeshStandardMaterial({ color: COLORS.body, metalness: 0.2, roughness: 0.42, ...common }),
    accent: new THREE.MeshStandardMaterial({ color: COLORS.accent, metalness: 0.5, roughness: 0.5, ...common }),
    metal: new THREE.MeshStandardMaterial({ color: COLORS.metal, metalness: 0.9, roughness: 0.38, ...common }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 0.7, roughness: 0.55, ...common }),
    gold: new THREE.MeshStandardMaterial({ color: COLORS.gold, metalness: 0.95, roughness: 0.3, ...common }),
    panel: new THREE.MeshStandardMaterial({
      color: COLORS.panel,
      metalness: 0.6,
      roughness: 0.3,
      emissive: 0x0a1a3a,
      emissiveIntensity: 0.6,
      ...common,
    }),
  };
}

// ---------- profiles ----------

const lathe = (points, segments, phiStart = 0, phiLength = Math.PI * 2) =>
  new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
    segments,
    phiStart,
    phiLength,
  );

// Rocket engine: bell (parabolic approximation) + throat + chamber + powerhead, bottom at y=0.
function bellProfile({ exitR, throatR, bellH, chamberR, chamberH }) {
  const pts = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    pts.push([throatR + (exitR - throatR) * Math.pow(1 - k, 1.55), bellH * k]);
  }
  pts.push([throatR * 1.05, bellH + 0.04]);
  pts.push([chamberR, bellH + 0.12]);
  pts.push([chamberR, bellH + chamberH]);
  pts.push([chamberR * 0.55, bellH + chamberH + 0.06]);
  pts.push([chamberR * 0.3, bellH + chamberH + 0.14]);
  pts.push([0.001, bellH + chamberH + 0.16]);
  return pts;
}

// Tangent ogive nose with a short cylindrical skirt, bottom at y=0.
function ogiveProfile(R, L, skirt) {
  const rho = (R * R + L * L) / (2 * R);
  const pts = [
    [R, 0],
    [R, skirt],
  ];
  const n = 26;
  for (let i = 1; i <= n; i++) {
    const x = (L * i) / n;
    const r = Math.sqrt(rho * rho - (L - x) * (L - x)) + R - rho;
    pts.push([Math.max(r, 0.001), skirt + x]);
  }
  return pts;
}

// Elliptical dome. up=true bulges upward from rim y=0 to tip y=h.
function domeProfile(R, h, up) {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    if (up) pts.push([Math.max(R * Math.cos(a), 0.001), h * Math.sin(a)]);
    else pts.push([Math.max(R * Math.sin(a), 0.001), -h * Math.cos(a) + h]);
  }
  if (!up) pts.reverse(), pts.forEach((p) => (p[1] = p[1] - h)); // tip at y=-h, rim at y=0
  if (!up) pts.reverse();
  return pts;
}

// ---------- piece factory ----------

function piece(geometry, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, explode } = {}) {
  geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, material.clone());
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, order, explode };
}

function tankPieces(mats, { R, H, domeH, bandY, bandMat }) {
  const out = [];
  const shellH = H - 2 * domeH;
  const shellPts = [];
  const rows = 6;
  for (let i = 0; i <= rows; i++) shellPts.push([R, domeH + (shellH * i) / rows]);
  for (let q = 0; q < 4; q++) {
    out.push(
      piece(lathe(shellPts, 18, (q * Math.PI) / 2, Math.PI / 2), mats.body, {
        order: 1 + q * 0.1,
        explode: { dir: new THREE.Vector3(Math.cos((q + 0.5) * (Math.PI / 2)), 0, -Math.sin((q + 0.5) * (Math.PI / 2))), dist: 1.6 },
      }),
    );
  }
  out.push(piece(lathe(domeProfile(R, domeH, false), 48), mats.body, { y: domeH, order: 0, explode: { dir: new THREE.Vector3(0, -1, 0), dist: 0.9 } }));
  out.push(piece(lathe(domeProfile(R, domeH, true), 48), mats.body, { y: H - domeH, order: 2, explode: { dir: new THREE.Vector3(0, 1, 0), dist: 0.9 } }));
  for (const [by, h, m] of bandY) {
    out.push(
      piece(new THREE.CylinderGeometry(R + 0.012, R + 0.012, h, 64, 1, true), m === "accent" ? mats.accent : bandMat ?? mats.dark, {
        y: by,
        order: 1.5,
        explode: { dir: new THREE.Vector3(0, 0, 1), dist: 1.2 },
      }),
    );
  }
  return out;
}

// ---------- the stack ----------

export const PART_DEFS = [
  {
    id: "engines",
    name: "Octaweb engines",
    sub: "9 × sea-level bells",
    key: "1",
    slotY: 0,
    height: 1.35,
    radius: 1,
    icon: "engine",
    build(mats) {
      const out = [];
      const prof = bellProfile({ exitR: 0.27, throatR: 0.085, bellH: 0.76, chamberR: 0.13, chamberH: 0.28 });
      const geo = lathe(prof, 40);
      out.push(piece(geo, mats.metal, { order: 0, explode: { dir: new THREE.Vector3(0, -1, 0), dist: 1.4 } }));
      const ringR = 0.64;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        out.push(
          piece(geo.clone(), mats.metal, {
            x: Math.cos(a) * ringR,
            z: Math.sin(a) * ringR,
            order: 0.2 + i * 0.1,
            explode: { dir: new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize(), dist: 1.5 },
          }),
        );
      }
      out.push(
        piece(new THREE.CylinderGeometry(0.98, 0.98, 0.16, 64), mats.dark, {
          y: 1.35 - 0.08,
          order: 1,
          explode: { dir: new THREE.Vector3(0, 0, 1), dist: 0.8 },
        }),
      );
      return out;
    },
  },
  {
    id: "booster-tank",
    name: "Booster tank",
    sub: "first stage",
    key: "2",
    slotY: 1.35,
    height: 7,
    radius: 1,
    icon: "tank",
    build: (mats) =>
      tankPieces(mats, {
        R: 1,
        H: 7,
        domeH: 0.45,
        bandY: [
          [0.9, 0.14, "dark"],
          [5.55, 0.42, "accent"],
        ],
      }),
  },
  {
    id: "interstage",
    name: "Interstage",
    sub: "open skirt + stringers",
    key: "3",
    slotY: 8.35,
    height: 1.4,
    radius: 1,
    icon: "ring",
    build(mats) {
      const out = [];
      const H = 1.4;
      out.push(
        piece(new THREE.CylinderGeometry(1, 1, H, 64, 1, true), mats.accent, {
          y: H / 2,
          order: 0,
          explode: { dir: new THREE.Vector3(0, 0, 1), dist: 1.4 },
        }),
      );
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        out.push(
          piece(new THREE.BoxGeometry(0.07, H * 0.92, 0.05), mats.dark, {
            x: Math.cos(a) * 1.03,
            z: Math.sin(a) * 1.03,
            y: H / 2,
            ry: -a,
            order: 0.5 + i * 0.05,
            explode: { dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), dist: 1.0 + (i % 3) * 0.3 },
          }),
        );
      }
      return out;
    },
  },
  {
    id: "vac-engine",
    name: "Vacuum engine",
    sub: "one big bell",
    key: "4",
    slotY: 8.25,
    height: 1.5,
    radius: 0.8,
    icon: "engine",
    build(mats) {
      const out = [];
      out.push(
        piece(lathe(bellProfile({ exitR: 0.78, throatR: 0.15, bellH: 1.08, chamberR: 0.2, chamberH: 0.22 }), 56), mats.metal, {
          order: 0,
          explode: { dir: new THREE.Vector3(0, -1, 0), dist: 1.2 },
        }),
      );
      out.push(
        piece(new THREE.TorusGeometry(0.26, 0.04, 12, 40), mats.dark, {
          y: 1.2,
          order: 1,
          explode: { dir: new THREE.Vector3(0, 1, 0), dist: 0.6 },
        }),
      );
      out[1].mesh.rotation.x = Math.PI / 2;
      return out;
    },
  },
  {
    id: "upper-tank",
    name: "Upper tank",
    sub: "second stage",
    key: "5",
    slotY: 9.75,
    height: 3.2,
    radius: 1,
    icon: "tank",
    build: (mats) => tankPieces(mats, { R: 1, H: 3.2, domeH: 0.42, bandY: [[2.4, 0.2, "accent"]] }),
  },
  {
    id: "fairing",
    name: "Fairing + payload",
    sub: "two halves, one satellite",
    key: "6",
    slotY: 12.95,
    height: 3.65,
    radius: 1.02,
    icon: "nose",
    build(mats) {
      const out = [];
      const prof = ogiveProfile(1.02, 3.3, 0.35);
      out.push(
        piece(lathe(prof, 36, Math.PI / 2, Math.PI), mats.body, {
          order: 2,
          explode: { dir: new THREE.Vector3(-1, 0.15, 0).normalize(), dist: 2.2 },
        }),
      );
      out.push(
        piece(lathe(prof, 36, -Math.PI / 2, Math.PI), mats.body, {
          order: 2.1,
          explode: { dir: new THREE.Vector3(1, 0.15, 0).normalize(), dist: 2.2 },
        }),
      );
      // payload: a small satellite, gold body + folded panels + dish
      out.push(piece(new THREE.BoxGeometry(0.72, 0.95, 0.72), mats.gold, { y: 0.55, order: 0, explode: { dir: new THREE.Vector3(0, 1, 0), dist: 0.5 } }));
      out.push(piece(new THREE.BoxGeometry(0.06, 1.1, 0.62), mats.panel, { x: -0.45, y: 0.6, order: 1, explode: { dir: new THREE.Vector3(-0.6, 0.8, 0).normalize(), dist: 0.8 } }));
      out.push(piece(new THREE.BoxGeometry(0.06, 1.1, 0.62), mats.panel, { x: 0.45, y: 0.6, order: 1.1, explode: { dir: new THREE.Vector3(0.6, 0.8, 0).normalize(), dist: 0.8 } }));
      out.push(piece(lathe(domeProfile(0.32, 0.12, false), 32), mats.body, { y: 1.3, order: 1.5, explode: { dir: new THREE.Vector3(0, 1, 0), dist: 1.0 } }));
      return out;
    },
  },
];

export const STACK_HEIGHT = PART_DEFS.reduce((m, d) => Math.max(m, d.slotY + d.height), 0);

export function createPart(def, mats) {
  const group = new THREE.Group();
  group.name = def.id;
  group.position.y = def.slotY;
  const pieces = def.build(mats).map((p, i) => {
    const bb = p.mesh.geometry.boundingBox;
    group.add(p.mesh);
    return {
      mesh: p.mesh,
      index: i,
      order: p.order ?? i,
      bottomY: bb.min.y + p.mesh.position.y,
      topY: bb.max.y + p.mesh.position.y,
      rest: { position: p.mesh.position.clone(), quaternion: p.mesh.quaternion.clone() },
      explode: p.explode ?? { dir: new THREE.Vector3(0, 1, 0), dist: 1 },
    };
  });
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  return { ...def, group, pieces, built: false, busy: false };
}

// ---------- environment ----------

export function createPad() {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.6, 0.18, 96),
    new THREE.MeshStandardMaterial({ color: 0x171a21, metalness: 0.6, roughness: 0.7 }),
  );
  disc.position.y = -0.09;
  disc.receiveShadow = true;
  g.add(disc);

  const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.holo, transparent: true, opacity: 0.85 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.022, 8, 160), ringMat);
  ring1.rotation.x = Math.PI / 2;
  ring1.position.y = 0.012;
  g.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.014, 8, 120), ringMat);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = 0.012;
  g.add(ring2);

  const clampGeo = new THREE.BoxGeometry(0.22, 0.34, 0.5);
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x3b3f48, metalness: 0.9, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const c = new THREE.Mesh(clampGeo, clampMat);
    c.position.set(Math.cos(a) * 1.22, 0.17, Math.sin(a) * 1.22);
    c.rotation.y = -a;
    c.castShadow = true;
    g.add(c);
  }

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.18;
  ground.receiveShadow = true;
  g.add(ground);

  const grid = new THREE.PolarGridHelper(14, 16, 8, 96, 0x2a3140, 0x1a1f2a);
  grid.position.y = -0.17;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  g.add(grid);

  return { group: g, ringMat };
}

export function createStars(count = 1400) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 90 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.98 - 0.08); // mostly above the horizon
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8 });
  return new THREE.Points(geo, mat);
}
