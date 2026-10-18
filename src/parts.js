// Procedural rocket parts, generated from the layout manifest (src/layout.js) at true scale.
// A part is a group at spec.slotY whose local y = 0 is the part's bottom. A part is a mechanical assembly of
// many separate pieces (an engine = bell, chamber, injector dome, turbopump, gas generator, feed pipes, duct,
// gimbal; a tank = shell quarters, stringers, domes, baffles, feed line, pressurant bottles, ...), so the
// build can bring sub-pieces in one by one and the exploded views show the inside.
// Piece rules: translation-only children (rotation about Y allowed, X/Z rotations baked into the geometry);
// every mesh has its own material clone and mesh.userData.partId = spec.id; each piece carries a structured
// explode { dir, dist } (scene units, used as rest + dir × dist) and an axisOffset (scene units along Y) for
// the axial pull-apart view (see axisOffsets below).
//
// Geometry is authored in metres and scaled by SCALE once. Sizes come from the spec (dataset records via
// layout.js). Every other proportion here (bell shape, pump size, leg length, panel layout, ...) is a visual
// ratio for shape only and is never shown on screen as a fact.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./layout.js";

export const COLORS = {
  body: 0xd6d8d4,
  accent: 0x15171c,
  metal: 0x3b3f48,
  gold: 0xc9a24a,
  panel: 0x1b2a4a,
  holo: 0x5cc8ff,
  select: 0xffb020,
};

const S = SCALE;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const DS = THREE.DoubleSide;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
// Azimuth a (from +X toward +Z, as in layout.js) ↔ lathe phi (from +Z toward +X): phi = π/2 − a.
const radial = (a, y = 0) => new THREE.Vector3(Math.cos(a), y, Math.sin(a)).normalize();
const radialPhi = (phi, y = 0) => new THREE.Vector3(Math.sin(phi), y, Math.cos(phi)).normalize();
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- procedural textures (pixel-generated once, shared by every material of every preset) ----------

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed + 1, 2147483629);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
// Tileable value noise: u, v in [0, 1), P lattice cells per tile.
function vnoise(u, v, P, seed) {
  const x = u * P;
  const y = v * P;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const g = (i, j) => hash2((((ix + i) % P) + P) % P, (((iy + j) % P) + P) % P, seed);
  return lerp(lerp(g(0, 0), g(1, 0), sx), lerp(g(0, 1), g(1, 1), sx), sy);
}
function fbm(u, v, P, seed, octaves = 4) {
  let sum = 0;
  let norm = 0;
  for (let o = 0, a = 0.5; o < octaves; o++, a *= 0.5) {
    sum += a * vnoise(u, v, P << o, seed + o);
    norm += a;
  }
  return sum / norm;
}

// fill(u, v) -> [r, g, b] in 0..1. Data maps pack bump height in R and a roughness factor in G
// (three reads bumpMap.r and roughnessMap.g), so one texture serves both slots.
function dataTexture(w, h, fill, { srgb = false, channel = 0, tile_m = 0 } = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill((x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      data[i] = clamp(r, 0, 1) * 255;
      data[i + 1] = clamp(g, 0, 1) * 255;
      data[i + 2] = clamp(b, 0, 1) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.channel = channel;
  if (tile_m) t.repeat.set(1 / tile_m, 1 / tile_m); // geometry UVs of that channel are in metres
  t.needsUpdate = true;
  return t;
}

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const W = 256;
  const px = 1 / W;
  TEX = {
    // Tank skin, 4 m tile on uv1 (metres): a ring weld every 4 m (raised bead, a little shinier), a vertical
    // panel seam (shallow groove) and low-frequency paint unevenness.
    seams: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 4, 11);
        const weld = Math.exp(-(((v - 0.5) / (1.6 * px)) ** 2));
        const seam = Math.exp(-(((u - 0.5) / (1.0 * px)) ** 2));
        return [0.5 + 0.22 * weld - 0.25 * seam + (n - 0.5) * 0.08, 0.93 + (n - 0.5) * 0.14 - 0.15 * weld, 1];
      },
      { channel: 1, tile_m: 4 },
    ),
    // Regenerative-cooling tube ridges on engine bells: one ridge per tile across u (geometry repeats u).
    ridges: dataTexture(32, 8, (u) => {
      const r = 0.5 + 0.5 * Math.cos(u * TAU);
      return [r, 0.8 + 0.2 * (1 - r), 1];
    }),
    // Crinkled multi-layer insulation: ridged noise for the bump, varied roughness, 1.2 m tile.
    crinkle: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 6, 3, 5);
        const ridged = 1 - Math.abs(2 * n - 1);
        return [ridged ** 2, 0.55 + 0.45 * fbm(u, v, 4, 7), 1];
      },
      { tile_m: 1.2 },
    ),
    // Solar cells: dark blue cells with thin bus-bar lines, 0.8 m tile (colour, sRGB).
    cells: dataTexture(
      128,
      128,
      (u, v) => {
        const cu = (u * 4) % 1;
        const cv = (v * 4) % 1;
        const line = cu < 0.04 || cv < 0.04 ? 1 : 0;
        const shade = 0.9 + 0.1 * Math.sin(cv * Math.PI);
        return line ? [0.5, 0.52, 0.56] : [0.07 * shade, 0.11 * shade, 0.24 * shade];
      },
      { srgb: true, tile_m: 0.8 },
    ),
    // Black-and-white roll pattern on normalized tank UVs (u around, v along the tank): alternating eighths
    // on the lower part and a counter-phased band at the top. A visual reading of the photos, not a drawing.
    roll: dataTexture(
      W,
      512,
      (u, v) => {
        const sector = Math.floor(u * 8);
        const black = (v < 0.3 && sector % 2 === 0) || (v > 0.93 && sector % 2 === 1);
        return black ? [0.06, 0.06, 0.065] : [0.92, 0.92, 0.9];
      },
      { srgb: true },
    ),
    // Sprayed foam: mottled orange-brown (colour, sRGB); its red channel doubles as the bump. 3 m tile on uv1.
    foam: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 8, 21, 5);
        const k = 0.78 + 0.4 * n;
        return [0.78 * k, 0.37 * k, 0.13 * k];
      },
      { srgb: true, channel: 1, tile_m: 3 },
    ),
    // Carbon composite twill, 0.5 m tile on uv1.
    weave: dataTexture(
      64,
      64,
      (u, v) => {
        const cu = Math.floor(u * 16);
        const cv = Math.floor(v * 16);
        const alongU = (cu + cv) % 4 < 2;
        const f = alongU ? (v * 16) % 1 : (u * 16) % 1;
        const h = 0.5 + 0.3 * Math.sin(f * Math.PI);
        return [h, 0.85 + 0.15 * (alongU ? 1 : 0.6), 1];
      },
      { channel: 1, tile_m: 0.5 },
    ),
  };
  return TEX;
}

// ---------- materials ----------

export function createMaterials() {
  const t = textures();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const metal = (color, roughness = 0.34, metalness = 0.9) => std({ color, metalness, roughness });
  // Matte paint, low metalness, seams/welds from the shared skin texture.
  const painted = (color, extra = {}) =>
    std({ color, metalness: 0.05, roughness: 0.62, bumpMap: t.seams, bumpScale: 1.2, roughnessMap: t.seams, ...extra });
  const mli = (color) => std({ color, metalness: 1, roughness: 0.34, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle });
  return {
    body: painted(COLORS.body),
    roll: painted(0xe4e4e0, { map: t.roll }),
    foam: std({ color: 0xffffff, map: t.foam, bumpMap: t.foam, bumpScale: 1.6, metalness: 0, roughness: 0.9 }),
    bronze: painted(0xa65f35, { metalness: 0.12, roughness: 0.66 }),
    silver: painted(0xb9bdc2, { metalness: 0.7, roughness: 0.34 }),
    composite: std({ color: 0x141518, metalness: 0.22, roughness: 0.5, bumpMap: t.weave, bumpScale: 0.6, roughnessMap: t.weave }),
    raceway: painted(0xc4c6c1),
    skirt: std({ color: 0x24262b, metalness: 0.5, roughness: 0.6 }),
    heatShield: std({ color: 0x1d1e21, metalness: 0.25, roughness: 0.88 }),
    metal: metal(0xa8acb2, 0.3),
    darkMetal: metal(0x3b3f48, 0.42, 0.85),
    // Engines: dark ridged metal bell (per-vertex colour = faint heat tint toward the throat) and bare-metal
    // sub-assemblies around it.
    engine: std({ color: 0xffffff, vertexColors: true, metalness: 0.85, roughness: 0.46, bumpMap: t.ridges, bumpScale: 0.5, roughnessMap: t.ridges }),
    chamber: metal(0x6e5d50, 0.38),
    powerhead: metal(0x8d9198, 0.36),
    pump: metal(0xb3b7bd, 0.3, 0.92),
    pipe: metal(0xc4c8ce, 0.24, 0.95),
    duct: metal(0x2e2c2a, 0.62, 0.6),
    gimbal: metal(0x2a2c31, 0.5, 0.8),
    gridFin: metal(0x4d5056, 0.46, 0.85),
    gold: mli(COLORS.gold),
    mliSilver: mli(0xc6c9ce),
    panel: std({ color: 0xffffff, map: t.cells, metalness: 0.45, roughness: 0.28, emissive: 0x050b1a, emissiveIntensity: 1 }),
    // legacy keys (kept so older callers still find them)
    accent: std({ color: COLORS.accent, metalness: 0.5, roughness: 0.5 }),
    dark: std({ color: 0x23262e, metalness: 0.7, roughness: 0.55 }),
  };
}

const finishMat = (mats, finish) =>
  ({ "white-black-roll": mats.roll, "orange-foam": mats.foam, bronze: mats.bronze, silver: mats.silver, "black-composite": mats.composite })[finish] ??
  mats.body;
// Short structures (skirts, adapters) take the stage colour but never the roll pattern (it is mapped per tank).
const plainFinish = (mats, finish) => finishMat(mats, finish === "white-black-roll" ? "white" : finish);

// ---------- geometry helpers (metres) ----------

const lathe = (pts, segments, phiStart = 0, phiLength = TAU) =>
  new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)),
    segments,
    phiStart,
    phiLength,
  );

// Lathe UVs: uv = (phi / 2π, y / H) normalized (finish maps), uv1 = (arc length, y) in metres (skin textures).
function latheUV(geo, { phiStart = 0, phiLength = TAU, H = 1, R = 1 }) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const phi = phiStart + uv.getX(i) * phiLength;
    const y = pos.getY(i);
    uv.setXY(i, phi / TAU, y / H);
    uv1[i * 2] = phi * R;
    uv1[i * 2 + 1] = y;
  }
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  return geo;
}

// Planar UVs in metres by dominant normal axis, on both channels (crinkle, cells, skin seams on small parts).
function projectUV(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u;
    let v;
    if (ay >= ax && ay >= az) (u = p.getX(i)), (v = p.getZ(i));
    else if (ax >= az) (u = p.getZ(i)), (v = p.getY(i));
    else (u = p.getX(i)), (v = p.getY(i));
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv.slice(), 2));
  return geo;
}

// Merge into one geometry (one piece, one material). Keeps only the attributes every input has.
function merge(geos) {
  let list = geos.filter(Boolean);
  if (list.some((g) => !g.index)) list = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(list[0].attributes).filter((n) => list.every((g) => g.attributes[n]));
  for (const g of list) {
    for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
    g.clearGroups();
  }
  const out = mergeGeometries(list, false);
  if (!out) throw new Error("parts.js: geometry merge failed");
  return out;
}

const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (rTop, rBot, h, seg, x = 0, y = 0, z = 0, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(x, y + h / 2, z); // y = bottom
const tube = (a, c, b, r, seg = 16) => new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, c, b), seg, r, 8, false);

// Tangent ogive of base radius R and length L starting at y0 (s measured from the base).
function ogivePoints(R, L, y0, n = 32) {
  const rho = (R * R + L * L) / (2 * R);
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const s = (L * i) / n;
    pts.push([Math.sqrt(Math.max(rho * rho - s * s, 0)) + R - rho, y0 + s]);
  }
  return pts;
}

// Elliptical dome as a lathe profile; up = bulges up from the rim at y=0 to y=h, else down to y=-h.
function domePoints(R, h, up, n = 12) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI / 2) * (i / n);
    pts.push([R * Math.cos(a), (up ? 1 : -1) * h * Math.sin(a)]);
  }
  return up ? pts : pts.reverse();
}

// ---------- piece factory ----------

const scaled = new WeakSet();
function toUnits(geo) {
  if (!scaled.has(geo)) {
    geo.scale(S, S, S);
    scaled.add(geo);
  }
  return geo;
}

// Geometry and offsets in metres; explode.dist in scene units. ax = [group, side, rank] tags the piece for
// the axial pull-apart (see axisOffsets).
function piece(geo, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, dir = UP, dist = 0.4, side, ax = null } = {}) {
  const g = toUnits(geo);
  g.computeBoundingBox();
  const mat = material.clone();
  if (side !== undefined) mat.side = side;
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x * S, y * S, z * S);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, order, explode: { dir: dir.clone().normalize(), dist }, ax };
}

// ---------- engines ----------

// Nozzle + chamber + injector dome profiles, exit at y=0. Rao-style parabolic bell: a quadratic Bezier from
// the exit to the throat whose control point is where the throat and exit tangents meet.
function nozzleProfile({ L, Re, rt, rc, bellL, convL, chamberL, domeL, vacuum }) {
  const tn = Math.tan(((vacuum ? 33 : 28) * Math.PI) / 180); // wall angle just below the throat (visual)
  const te = Math.tan(((vacuum ? 9 : 10) * Math.PI) / 180); // wall angle at the exit (visual)
  const yc = clamp((bellL * tn - (Re - rt)) / (tn - te), 0.08 * bellL, 0.92 * bellL);
  const rcp = Re - yc * te;
  const bell = [];
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    bell.push([a * Re + b * rcp + c * rt, b * yc + c * bellL]);
  }
  const chamber = [[rt, bellL]];
  for (let i = 1; i <= 5; i++) {
    const k = i / 5;
    chamber.push([rt + (rc - rt) * k * k * (3 - 2 * k), bellL + convL * k]);
  }
  const y1 = bellL + convL + chamberL;
  chamber.push([rc, y1]);
  const fl = 0.015 * L; // injector flange
  const dome = [[rc, y1], [rc * 1.14, y1], [rc * 1.14, y1 + fl]];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    dome.push([rc * 1.04 * Math.cos(a), y1 + fl + domeL * Math.sin(a)]);
  }
  return { bell, chamber, dome, all: [...bell, ...chamber.slice(1), ...dome.slice(1)], yTop: y1 + fl + domeL };
}

// One engine's sub-assemblies, each its own geometry in engine-local metres (exit plane y=0, gimbal top y=L,
// turbopump on local +X). Shared by every engine of the same shape. chambers = 2 draws twin bells inside the
// record's envelope diameter (RD-180 style) around one turbopump.
// Each entry: { geo, mat, ax: [side, rank] around the chamber core, k: explode-distance factor, sw: sideways }.
const kitCache = new Map();
function engineKit({ exitD_m, L, vacuum, chambers = 1 }) {
  const key = [exitD_m, L, vacuum, chambers].join("|");
  if (kitCache.has(key)) return kitCache.get(key);
  const twin = chambers > 1;
  const Re = twin ? exitD_m / 4 / 1.03 : exitD_m / 2;
  const off = twin ? Re * 1.03 : 0;
  // Visual proportions of the engine length (no data): bell share, converging section, chamber, dome.
  const bellL = L * (vacuum ? 0.74 : 0.6);
  const convL = L * (vacuum ? 0.04 : 0.06);
  const chamberL = L * (vacuum ? 0.07 : 0.11);
  const domeL = L * (vacuum ? 0.035 : 0.05);
  const rt = Re * (vacuum ? 0.16 : 0.3); // throat radius (visual expansion ratio)
  const rc = rt * 1.6; // chamber radius
  const prof = nozzleProfile({ L, Re, rt, rc, bellL, convL, chamberL, domeL, vacuum });
  const yTop = prof.yTop;
  const radiusAt = (y) => {
    const a = prof.all;
    for (let i = 1; i < a.length; i++) {
      if (a[i][1] >= y) return lerp(a[i - 1][0], a[i][0], (y - a[i - 1][1]) / Math.max(a[i][1] - a[i - 1][1], 1e-6));
    }
    return rc;
  };

  const kit = [];
  const zs = twin ? [-off, off] : [0];
  // Bell: dark steel with a faint warm temper tint toward the throat (linear RGB vertex colours) and
  // regenerative-tube ridges (uv.x repeats the one-ridge texture).
  const base = vacuum ? [0.09, 0.09, 0.1] : [0.15, 0.15, 0.16];
  const heat = [0.4, 0.25, 0.15];
  const RIDGES = vacuum ? 72 : 48;
  for (const z of zs) {
    const g = lathe(prof.bell, 48);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.pow(clamp(pos.getY(i) / bellL, 0, 1), 3) * 0.55;
      col.set([lerp(base[0], heat[0], k), lerp(base[1], heat[1], k), lerp(base[2], heat[2], k)], i * 3);
      uv.setXY(i, uv.getX(i) * RIDGES, uv.getY(i));
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    kit.push({ geo: g.translate(0, 0, z), mat: "engine", ax: [-1, 0], k: 1, ds: true });
  }
  for (const z of zs) kit.push({ geo: lathe(prof.chamber, 32).translate(0, 0, z), mat: "chamber", ax: [0, 0], k: 0.8, ds: true });
  for (const z of zs) kit.push({ geo: lathe(prof.dome, 32).translate(0, 0, z), mat: "powerhead", ax: [1, 0], k: 0.62 });

  // Gas generator: a small can with a domed top on the side opposite the pump (behind the pump on a twin).
  const rg = rc * (twin ? 0.36 : 0.3);
  const hg = L * 0.1;
  const gx = twin ? -(rc * 0.7 + rg + 0.03 * L) : -(rc + rg + 0.02 * L);
  const gy = bellL + convL;
  kit.push({ geo: merge([cyl(rg, rg * 0.8, hg, 16, gx, gy), lathe(domePoints(rg, rg * 0.7, true, 6), 16).translate(gx, gy + hg, 0)]), mat: "powerhead", ax: [0, 0], k: 0.75, sw: -1 });

  // Turbopump: a vertical cylinder beside the chamber (between the chambers on a twin) with turbine cap and
  // pump volute ring.
  const rp = rc * (twin ? 0.7 : vacuum ? 0.5 : 0.6);
  const hp = L * (vacuum ? 0.16 : 0.24);
  const py0 = bellL + convL * 0.5;
  const px = twin ? 0 : rc + rp + 0.03 * L;
  kit.push({
    geo: merge([
      cyl(rp, rp, hp, 20, px, py0),
      cyl(rp * 0.72, rp * 0.72, hp * 0.14, 16, px, py0 + hp),
      new THREE.TorusGeometry(rp * 1.02, rp * 0.22, 8, 24).rotateX(Math.PI / 2).translate(px, py0 + hp * 0.3, 0),
    ]),
    mat: "pump",
    ax: [1, 1],
    k: 0.7,
    sw: 1,
  });

  // Feed pipes: pump → injector dome and pump → chamber side (two per chamber).
  const rPipe = rc * (vacuum ? 0.16 : 0.2);
  for (const z of zs) {
    const s = twin ? Math.sign(z) : 1;
    kit.push({ geo: tube(v3(px, py0 + hp * 0.8, 0), v3(px * 0.6, yTop + domeL * 0.9, z * 0.4), v3(rc * 0.3, yTop - domeL * 0.3, z), rPipe), mat: "pipe", ax: [1, 1], k: 0.68, sw: 0.5 });
    kit.push({
      geo: tube(v3(px, py0 + hp * 0.35, rp * 0.6 * s), v3(px * 0.7 + rc * 0.4, py0 + hp * 0.2, rc * 1.3 * s + z * 0.5), v3(rc * 0.55, bellL + convL + chamberL * 0.5, z + rc * 0.75 * s), rPipe * 0.85),
      mat: "pipe",
      ax: [1, 1],
      k: 0.66,
      sw: 0.5,
    });
  }
  // Turbine exhaust duct down the side of the bell (sea-level single-chamber engines).
  if (!vacuum && !twin) {
    const yEnd = bellL * 0.42;
    const rD = rp * 0.42;
    const xEnd = radiusAt(yEnd) + rD * 1.3;
    kit.push({ geo: tube(v3(px, py0 + rD, 0), v3(Math.max(px, xEnd) + rD, py0 - (py0 - yEnd) * 0.35, 0), v3(xEnd, yEnd, 0), rD, 20), mat: "duct", ax: [0, 0], k: 0.85, sw: 1 });
  }
  // Gimbal block + flange up to the mount plate.
  const gw = twin ? 2 * off + rc : rc * 1.1;
  const gh = L - yTop + 0.02 * L;
  kit.push({
    geo: merge([box(twin ? rc * 1.1 : gw, gh, gw, 0, yTop - 0.02 * L + gh / 2, 0), cyl(rc * 0.95, rc * 0.95, 0.025 * L, 20, 0, L - 0.025 * L)]),
    mat: "gimbal",
    ax: [1, 2],
    k: 0.55,
  });
  // Assembly order inside one engine: bell first, then up the engine.
  const rank = { engine: 0, chamber: 1, powerhead: 2, pump: 3, pipe: 4, duct: 5, gimbal: 6 };
  kit.sort((a, b) => rank[a.mat] - rank[b.mat]);
  Object.assign(kit, { radiusAt, bellL, rc });
  kitCache.set(key, kit);
  return kit;
}

function buildEngines(spec, mats) {
  const g = spec.geom;
  const L = g.engineLength_m;
  const kit = engineKit({ exitD_m: g.exitD_m, L, vacuum: g.vacuum, chambers: g.chambers });
  const { radiusAt, bellL, rc } = kit;
  const out = [];
  const d = Math.max(0.3, 0.7 * L * S);
  g.positions.forEach((p, i) => {
    // Powerheads turn tangentially on a ring so pumps stay inside the cluster footprint.
    const ry = p.r > 0 ? -p.a - Math.PI / 2 : 0;
    const base = p.r > 0 ? DOWN.clone().add(radial(p.a).multiplyScalar(0.3)).normalize() : DOWN;
    const side = v3(Math.cos(ry), 0, -Math.sin(ry)); // the engine's local +X (pump side) in part space
    kit.forEach((s, j) => {
      const dir = base.clone().addScaledVector(side, 0.35 * (s.sw ?? 0));
      out.push(piece(s.geo, mats[s.mat], { x: p.x, z: p.z, ry, order: i + j * 0.01, dir, dist: d * s.k, side: s.ds ? DS : undefined, ax: [`e${i}`, ...s.ax] }));
    });
  });
  const n = g.positions.length;

  const Rm = g.mountD_m / 2;
  const mountH = g.mountH_m;
  const fairings = g.features.includes("engine-fairings");
  // Stage-0 clusters (3+ engines) get a thrust section: the stage skin continues down to a heat shield at
  // the upper bell, hiding the powerheads (Falcon 9 octaweb / S-IC base). Its height is a visual ratio.
  const thrustSection = g.stageIndex === 0 && spec.count >= 3;
  const yHs = thrustSection ? (fairings ? 0.8 * L : 0.9 * bellL) : L;
  const plate = cyl(Rm * 0.985, Rm * 0.985, mountH, 64, 0, L);
  let deck = plate;
  if (thrustSection) {
    const shape = new THREE.Shape().absarc(0, 0, Rm * 0.98, 0, TAU, false);
    const pitch = n > 1 ? Math.min(...g.positions.flatMap((a, i) => g.positions.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z)))) : Infinity;
    for (const p of g.positions) {
      const hr = Math.min(radiusAt(yHs) * 1.12 + 0.02 * L, pitch / 2 - 0.02, Rm - p.r - 0.02);
      shape.holes.push(new THREE.Path().absarc(p.x, -p.z, Math.max(hr, rc), 0, TAU, true));
    }
    const shield = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false, curveSegments: 20 }).rotateX(-Math.PI / 2).translate(0, yHs, 0);
    deck = merge([plate, shield]);
    const skirt = latheUV(lathe([[Rm, yHs], [Rm, L + mountH]], 64), { H: spec.height / S, R: Rm });
    out.push(piece(skirt, plainFinish(mats, g.finish), { order: n + 0.2, dir: UP, dist: 0.35, side: DS, ax: ["top", 1, 0] }));
  }
  out.push(piece(deck, thrustSection ? mats.heatShield : mats.skirt, { order: n + 0.1, dir: UP, dist: 0.25, ax: ["top", 1, 0] }));

  // S-IC style engine fairings (outer engines) and fins.
  const outer = g.positions.filter((p) => p.r > 0);
  if (fairings) {
    const yBot = 0.45 * L;
    const fGeo = projectUV(lathe([[radiusAt(yBot) * 1.12 + 0.03 * L, yBot], [rc * 2.4, yHs]], 32));
    outer.forEach((p, i) => out.push(piece(fGeo, mats.body, { x: p.x, z: p.z, order: n + 0.5 + i * 0.02, dir: radial(p.a, -0.2), dist: 0.35, side: DS })));
  }
  if (g.fin) {
    const { rootR_m: r0, span_m: span } = g.fin;
    const shape = new THREE.Shape();
    // Planform in the radial (x) / vertical (y) plane: swept leading edge, short tip chord (visual).
    shape.moveTo(r0 - 0.2, 0.18 * L);
    shape.lineTo(r0 + span, 0.3 * L);
    shape.lineTo(r0 + span, 0.52 * L);
    shape.lineTo(r0 - 0.2, Math.min(yHs, 0.95 * L));
    shape.closePath();
    const t = Math.max(0.12, 0.012 * g.mountD_m);
    const finGeo = projectUV(new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false }).translate(0, 0, -t / 2));
    outer.forEach((p, i) => out.push(piece(finGeo, mats.body, { ry: -p.a, order: n + 0.6 + i * 0.02, dir: radial(p.a), dist: 0.45 })));
  }
  return out;
}

// ---------- tanks ----------

function buildTank(spec, mats) {
  const g = spec.geom;
  const R = g.D_m / 2;
  const H = g.H_m;
  const D = g.D_m;
  const T = (side, rank) => ["t", side, rank];
  const out = [];
  // Internals first (they fly in before the skin closes around them). Visual layout: bulkheads, a mid
  // common bulkhead at the propellant split, two ring baffles, a feed line down the axis, pressurant bottles.
  const domeH = 0.35 * R;
  const inset = 0.015 * H;
  const yMid = 0.42 * H;
  const smallD = 0.15 + 0.15 * R * S;
  const lower = projectUV(lathe(domePoints(R * 0.985, domeH, false), 48).translate(0, inset + domeH, 0));
  out.push(piece(lower, mats.metal, { order: 0.1, dir: DOWN, dist: 0.2 + 0.35 * R * S, side: DS, ax: T(-1, 1) }));
  out.push(piece(cyl(0.045 * D, 0.045 * D, yMid - inset, 16, 0, inset), mats.pipe, { order: 0.2, dir: DOWN, dist: 0.1, ax: T(0, 0) }));
  out.push(piece(projectUV(lathe(domePoints(R * 0.985, domeH * 0.8, true), 48).translate(0, yMid, 0)), mats.metal, { order: 0.3, dir: UP, dist: 0.08, side: DS, ax: T(-1, 2) }));
  const baffle = lathe([[R * 0.985, 0], [R * 0.8, 0], [R * 0.78, 0.025 * D]], 64);
  [0.22, 0.7].forEach((f, i) => {
    const geo = i === 0 ? baffle : baffle.clone();
    out.push(piece(geo, mats.metal, { y: f * H, order: 0.4 + i * 0.02, dir: i ? UP : DOWN, dist: 0.06, side: DS, ax: T(-1, 3 + i) }));
  });
  const upper = projectUV(lathe(domePoints(R * 0.985, domeH, true), 48).translate(0, H - inset - domeH, 0));
  out.push(piece(upper, mats.metal, { order: 0.5, dir: UP, dist: 0.2 + 0.35 * R * S, side: DS, ax: T(1, 0) }));
  const copv = new THREE.CapsuleGeometry(0.07 * D, 0.12 * D, 6, 16);
  const yCopv = H - inset - domeH - 0.16 * D;
  for (let k = 0; k < 3; k++) {
    const a = Math.PI / 6 + (k * TAU) / 3;
    out.push(piece(k ? copv.clone() : copv, mats.composite, { x: 0.32 * R * Math.cos(a), y: yCopv, z: 0.32 * R * Math.sin(a), order: 0.6 + k * 0.01, dir: radial(a, 0.8), dist: smallD, ax: T(1, 1) }));
  }

  // Skin: four shell quarters, each with its ring of internal stringers.
  const shellMat = finishMat(mats, g.finish);
  const shellDist = 0.25 + 0.9 * R * S;
  for (let q = 0; q < 4; q++) {
    const phi0 = (q * Math.PI) / 2;
    const dir = radialPhi(phi0 + Math.PI / 4);
    const str = [];
    for (let j = 0; j < 6; j++) {
      const phi = phi0 + ((j + 0.5) * (Math.PI / 2)) / 6;
      const r = R - 0.008 * D;
      str.push(box(0.012 * D, 0.94 * H, 0.01 * D).rotateY(phi - Math.PI / 2).translate(Math.sin(phi) * r, H / 2, Math.cos(phi) * r));
    }
    out.push(piece(merge(str), mats.metal, { order: 1 + q * 0.02, dir, dist: shellDist * 0.7, ax: T(0, 0) }));
    const geo = latheUV(lathe([[R, 0], [R, H]], 24, phi0, Math.PI / 2), { phiStart: phi0, phiLength: Math.PI / 2, H, R });
    out.push(piece(geo, shellMat, { order: 1.5 + q * 0.02, dir, dist: shellDist, side: DS, ax: T(0, 0) }));
  }
  // Thrust-structure skirt band at the base (dark, a hair proud of the skin).
  const skirtH = Math.min(0.03 * H, 0.3 * D);
  const skirt = latheUV(lathe([[R * 1.006, 0], [R * 1.006, skirtH]], 96), { H, R });
  out.push(piece(skirt, mats.skirt, { order: 2, dir: DOWN, dist: 0.15, side: DS, ax: T(-1, 0) }));
  // Raceway (cable/plumbing tunnel) along the full length.
  const rwA = Math.PI / 2;
  const rwD = 0.03 * D;
  const rwH = H - skirtH - 0.01 * H;
  out.push(piece(projectUV(box(rwD, rwH, 0.07 * D, R + rwD / 2, skirtH + rwH / 2, 0)), mats.raceway, { ry: -rwA, order: 2.5, dir: radial(rwA), dist: 0.25, ax: T(0, 0) }));

  if (g.features.includes("landing-legs")) legs(out, mats, R, H, D);
  if (g.features.includes("grid-fins")) gridFins(out, mats, R, R, H * 0.985, D);
  return out;
}

// Falcon-style folded landing legs: tapered carbon struts hinged at the base, foot at the top end.
function legs(out, mats, R, H, D) {
  const len = Math.min(0.24 * H, 2.6 * D); // visual
  const w0 = 0.2 * D;
  const w1 = 0.11 * D;
  const t0 = 0.1 * D;
  const t1 = 0.06 * D;
  const strut = new THREE.BoxGeometry(1, 1, 1, 1, 4, 1);
  const p = strut.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = p.getY(i) + 0.5;
    p.setXYZ(i, R + (p.getX(i) + 0.5) * lerp(t0, t1, k), 0.012 * H + k * len, p.getZ(i) * lerp(w0, w1, k));
  }
  strut.computeVertexNormals();
  const foot = box(t1 * 1.6, 0.05 * len, w1 * 1.25, R + t1 * 0.8, 0.012 * H + len - 0.025 * len, 0);
  const hinge = box(t0 * 1.2, 0.04 * len, w0 * 1.1, R + t0 * 0.6, 0.012 * H + 0.02 * len, 0);
  const geo = projectUV(merge([strut, foot, hinge]));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push(piece(geo, mats.composite, { ry: -a, order: 3 + i * 0.02, dir: radial(a), dist: 0.35, ax: ["t", 0, 0] }));
  }
}

// Folded grid fins standing against the body, lattice facing out. rBot/rTop: body radius at the fin's
// bottom/top (frustum interstages); yTop: top of the fin.
function gridFins(out, mats, rBot, rTop, yTop, D) {
  const h = 0.4 * D; // visual sizes
  const w = 0.33 * D;
  const d = 0.06 * D;
  const bar = 0.012 * D;
  const y0 = yTop - h;
  const r = (rBot + rTop) / 2 + 0.01 * D;
  const geos = [
    box(d, bar * 2, w, r + d / 2, y0 + bar, 0),
    box(d, bar * 2, w, r + d / 2, yTop - bar, 0),
    box(d, h, bar * 2, r + d / 2, y0 + h / 2, -w / 2 + bar),
    box(d, h, bar * 2, r + d / 2, y0 + h / 2, w / 2 - bar),
    box(d * 1.4, 0.12 * h, 0.3 * w, r + d * 0.7, y0 - 0.06 * h, 0), // actuator housing
  ];
  // Diagonal lattice: bars along ±45° in the fin plane (YZ), clipped to the frame.
  const N = 6;
  for (const s of [1, -1]) {
    for (let i = 1; i < 2 * N; i++) {
      const c = -w / 2 - h / 2 + (i * (w + h)) / (2 * N); // z + s·(y − yc) = c
      const zA = clamp(c + h / 2, -w / 2, w / 2);
      const zB = clamp(c - h / 2, -w / 2, w / 2);
      const yA = (c - zA) * s;
      const yB = (c - zB) * s;
      const len = Math.hypot(zA - zB, yA - yB);
      if (len < bar * 3) continue;
      const g = new THREE.BoxGeometry(d * 0.9, len, bar);
      g.rotateX((s * -Math.PI) / 4);
      geos.push(g.translate(r + d / 2, y0 + h / 2 + (yA + yB) / 2, (zA + zB) / 2));
    }
  }
  const geo = merge(geos);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push(piece(geo, mats.gridFin, { ry: -a, order: 4 + i * 0.02, dir: radial(a, 0.2), dist: 0.4 }));
  }
}

// ---------- interstage ----------

function buildInterstage(spec, mats) {
  const g = spec.geom;
  const Rb = g.bottomD_m / 2;
  const Rt = g.topD_m / 2;
  const H = g.H_m;
  const rAt = (y) => lerp(Rb, Rt, y / H);
  const out = [];
  // Internal ring frames (one piece), the two shell halves, a separation ring at the top.
  const frames = [0.33, 0.66].map((f) => lathe([[rAt(f * H) * 0.985, 0], [rAt(f * H) * 0.9, 0], [rAt(f * H) * 0.9, 0.03 * H]], 64).translate(0, f * H, 0));
  out.push(piece(merge(frames), mats.metal, { order: 0, dir: UP, dist: 0.08, side: DS, ax: ["i", 0, 0] }));
  const mat = plainFinish(mats, g.finish);
  for (let h = 0; h < 2; h++) {
    const phi0 = h * Math.PI;
    const geo = latheUV(lathe([[Rb, 0], [Rt, H]], 48, phi0, Math.PI), { phiStart: phi0, phiLength: Math.PI, H, R: (Rb + Rt) / 2 });
    out.push(piece(geo, mat, { order: 1 + h * 0.05, dir: radialPhi(phi0 + Math.PI / 2), dist: 0.3 + 0.8 * Math.max(Rb, Rt) * S, side: DS, ax: ["i", 0, 0] }));
  }
  const ringH = Math.min(0.05 * H, 0.04 * g.topD_m);
  out.push(piece(lathe([[Rt * 1.006, H - ringH], [Rt * 1.006, H]], 96), mats.skirt, { order: 2, dir: UP, dist: 0.12, side: DS, ax: ["i", 1, 0] }));
  if (g.features?.includes("grid-fins")) {
    const yTop = H * 0.94;
    const D = Math.min(g.bottomD_m, g.topD_m);
    gridFins(out, mats, rAt(yTop - 0.4 * D), rAt(yTop), yTop, D);
  }
  return out;
}

// ---------- payloads ----------

// Payload pieces are tagged in group "p": the main body is the core, small bits stack above or below it.
function adapterPieces(out, mats, g) {
  const Rt = g.stageD_m / 2;
  const Rp = g.D_m / 2;
  const h = g.adapterH_m;
  if (g.archetype === "capsule") {
    // Instrument-unit style ring at the stage diameter (visual).
    const geo = latheUV(lathe([[Rt, 0], [Rt, h]], 96), { H: h, R: Rt });
    out.push(piece(geo, mats.body, { order: 0, dir: DOWN, dist: 0.12, side: DS, ax: ["p", -1, 9] }));
    return;
  }
  // Payload attach fitting (cone) + clamp band at the payload interface.
  const rb = 0.42 * g.stageD_m;
  const rtop = Math.min(0.62 * Rp, rb);
  out.push(piece(projectUV(lathe([[0.001, 0], [rb, 0], [rtop, h * 0.92], [0.001, h * 0.92]], 48)), mats.metal, { order: 0, dir: DOWN, dist: 0.14, ax: ["p", -1, 9] }));
  out.push(piece(cyl(rtop * 1.04, rtop * 1.04, h * 0.08, 48, 0, h * 0.92), mats.darkMetal, { order: 0.05, dir: DOWN, dist: 0.07, ax: ["p", -1, 8] }));
}

function buildPayload(spec, mats) {
  const g = spec.geom;
  const out = [];
  adapterPieces(out, mats, g);
  const y0 = g.adapterH_m;
  const R = g.D_m / 2;
  const H = g.H_m;
  // P(geo, mat, { order, dir, dist, side, ax: [side, rank] }) — ax defaults to the core.
  const P = (geo, mat, { ax = [0, 0], ...o } = {}) => out.push(piece(geo, mat, { order: 1, dir: UP, dist: 0.35, ...o, ax: ["p", ...ax] }));
  const isWebb = /jwst|webb/.test(spec.record?.id ?? "");
  switch (g.archetype) {
    case "telescope":
      if (isWebb) webb(P, mats, R, H, y0);
      else telescope(P, mats, R, H, y0);
      break;
    case "lander":
      lander(P, mats, R, H, y0);
      break;
    case "capsule":
      capsule(P, mats, g, y0);
      break;
    default:
      weatherSat(P, mats, R, H, y0);
  }
  return out;
}

// All archetypes stay inside the record's envelope: radius R, height H, base at y0 (fractions are visual).
function telescope(P, mats, R, H, y0) {
  P(projectUV(cyl(R * 0.97, R * 0.97, 0.36 * H, 12, 0, y0)), mats.mliSilver, { order: 1, dist: 0.2, ax: [-1, 0] });
  P(projectUV(cyl(R * 0.74, R * 0.74, 0.6 * H, 40, 0, y0 + 0.36 * H)), mats.mliSilver, { order: 1.1, dist: 0.35 });
  P(projectUV(cyl(R * 0.77, R * 0.77, 0.025 * H, 40, 0, y0 + 0.96 * H)), mats.metal, { order: 1.4, dist: 0.6, ax: [1, 0] });
  for (const s of [1, -1]) {
    P(projectUV(box(0.08 * R, 0.5 * H, 0.32 * R, 0, y0 + 0.62 * H, s * 0.86 * R)), mats.panel, { order: 1.2, dir: v3(0, 0.6, s), dist: 0.4 });
    P(projectUV(cyl(0.035 * R, 0.035 * R, 0.4 * H, 8, s * 0.86 * R, y0 + 0.4 * H)), mats.darkMetal, { order: 1.3, dir: v3(s, 0.6, 0), dist: 0.35 });
  }
}

// Stowed JWST read: spacecraft bus at the base, two folded sunshield pallets, gold mirror wall between.
function webb(P, mats, R, H, y0) {
  P(projectUV(box(1.1 * R, 0.16 * H, 1.1 * R, 0, y0 + 0.08 * H)), mats.gold, { order: 1, dist: 0.2, ax: [-1, 0] });
  for (const s of [1, -1]) {
    P(projectUV(box(0.14 * R, 0.62 * H, 1.1 * R, s * 0.72 * R, y0 + 0.16 * H + 0.31 * H)), mats.mliSilver, { order: 1.2, dir: v3(s, 0.4, 0), dist: 0.45 });
  }
  P(projectUV(merge([box(0.95 * R, 0.66 * H, 0.12 * R, 0, y0 + 0.16 * H + 0.33 * H, 0.18 * R), box(0.5 * R, 0.5 * H, 0.4 * R, 0, y0 + 0.16 * H + 0.25 * H, -0.2 * R)])), mats.gold, { order: 1.1, dist: 0.5 });
  P(
    projectUV(merge([cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, -0.3 * R, y0 + 0.82 * H, 0.3 * R), cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, 0.3 * R, y0 + 0.82 * H, 0.3 * R), cyl(0.18 * R, 0.18 * R, 0.02 * H, 24, 0, y0 + 0.96 * H, 0.3 * R)])),
    mats.darkMetal,
    { order: 1.3, dist: 0.7, ax: [1, 0] },
  );
}

function weatherSat(P, mats, R, H, y0) {
  const s = 1.25 * R; // square bus inside the envelope (corner at 0.88 R)
  P(projectUV(cyl(0.5 * R, 0.5 * R, 0.08 * H, 32, 0, y0)), mats.metal, { order: 1, dist: 0.15, ax: [-1, 0] });
  P(projectUV(box(s, 0.55 * H, s, 0, y0 + 0.08 * H + 0.275 * H)), mats.gold, { order: 1.1, dist: 0.3 });
  P(projectUV(box(0.07 * R, 0.8 * H, 1.1 * R, 0.66 * R, y0 + 0.1 * H + 0.4 * H)), mats.panel, { order: 1.2, dir: v3(1, 0.4, 0), dist: 0.45 });
  P(projectUV(box(0.9 * R, 0.25 * H, 0.7 * R, -0.05 * R, y0 + 0.63 * H + 0.125 * H, 0)), mats.mliSilver, { order: 1.3, dist: 0.5, ax: [1, 0] });
  const dish = [];
  for (let i = 0; i <= 10; i++) dish.push([0.28 * R * (i / 10), 0.06 * H * (i / 10) ** 2]);
  P(projectUV(lathe(dish, 32).translate(0.3 * R, y0 + 0.9 * H, 0.2 * R)), mats.body, { order: 1.4, dist: 0.7, side: DS, ax: [1, 1] });
  P(projectUV(cyl(0.03 * R, 0.03 * R, 0.7 * H, 8, -0.66 * R, y0 + 0.1 * H)), mats.darkMetal, { order: 1.5, dir: v3(-1, 0.4, 0), dist: 0.4 });
}

function lander(P, mats, R, H, y0) {
  const rb = 0.62 * R;
  P(projectUV(lathe([[0.16 * R, 0], [0.08 * R, 0.14 * H], [0.12 * R, 0.16 * H]], 24).translate(0, y0 + 0.12 * H, 0)), mats.darkMetal, { order: 0.9, dist: 0.25, side: DS, ax: [-1, 0] });
  P(projectUV(cyl(rb, rb, 0.5 * H, 6, 0, y0 + 0.28 * H)), mats.mliSilver, { order: 1, dist: 0.35 });
  // Solar panels on three alternate hex faces (a hair proud of the body).
  const faces = [];
  for (let i = 0; i < 3; i++) {
    const a = ((2 * i + 0.5) * TAU) / 6;
    faces.push(box(0.02 * R, 0.4 * H, rb * 0.85, rb * Math.cos(Math.PI / 6) + 0.012 * R, y0 + 0.53 * H, 0).rotateY(-a));
  }
  P(projectUV(merge(faces)), mats.panel, { order: 1.1, dist: 0.4 });
  const dish = [];
  for (let i = 0; i <= 8; i++) dish.push([0.22 * R * (i / 8), 0.05 * H * (i / 8) ** 2]);
  P(projectUV(merge([cyl(0.4 * R, 0.45 * R, 0.12 * H, 6, 0, y0 + 0.78 * H), lathe(dish, 24).translate(0.1 * R, y0 + 0.92 * H, 0)])), mats.gold, { order: 1.3, dist: 0.6, ax: [1, 0] });
  // Six legs: strut from the body edge to a footpad near the envelope, plus a brace; one piece each.
  for (let i = 0; i < 6; i++) {
    const a = ((i + 0.5) * TAU) / 6;
    const knee = v3(0.82 * R, y0 + 0.2 * H, 0);
    const foot = v3(0.94 * R, y0 + 0.02 * H, 0);
    const geo = projectUV(
      merge([
        tube(v3(0.55 * R, y0 + 0.5 * H, 0), v3(0.75 * R, y0 + 0.35 * H, 0), knee, 0.025 * R, 10),
        tube(knee, knee.clone().lerp(foot, 0.5), foot, 0.025 * R, 6),
        tube(v3(0.5 * R, y0 + 0.3 * H, 0), v3(0.68 * R, y0 + 0.24 * H, 0), knee, 0.02 * R, 6),
        cyl(0.07 * R, 0.08 * R, 0.02 * H, 16, foot.x, y0),
      ]),
    );
    P(geo, mats.metal, { ry: -a, order: 1.5 + i * 0.02, dir: radial(a, 0.3), dist: 0.35 });
  }
}

// Apollo-style stack from visuals dims (sourced) or visual fallbacks: spacecraft-LM adapter panels (stage D
// → CSM D) around the folded lander and the SPS bell, service module, command module, and the escape tower
// above the envelope when its height is sourced (placing it on the CM is a visual choice).
function capsule(P, mats, g, y0) {
  const H = g.H_m;
  const dims = g.dims ?? {};
  const Rb = (dims.sla_base_diameter_m ?? g.D_m) / 2;
  const Rc = (dims.csm_diameter_m ?? dims.sla_top_diameter_m ?? 0.59 * g.D_m) / 2;
  const Rs = (dims.sla_top_diameter_m ?? 2 * Rc) / 2;
  let slaH = dims.sla_height_m ?? 0.5 * H;
  let smH = dims.sm_height_m ?? 0.3 * H;
  let cmH = dims.cm_height_m ?? 0.2 * H;
  const k = H / (slaH + smH + cmH); // keep the three inside the record's height
  slaH *= k;
  smH *= k;
  cmH *= k;
  const spsH = Math.min(dims.sm_bell_height_m ?? 0.3 * slaH, 0.45 * slaH);
  // Lander folded inside the adapter, below the SPS bell (only seen when the panels open).
  const rIn = (y) => lerp(Rb, Rs, y / slaH);
  const lmTop = Math.min(0.62 * slaH, slaH - spsH - 0.05 * slaH);
  const yAsc = 0.06 * slaH + 0.55 * (lmTop - 0.06 * slaH);
  const dR = 0.85 * rIn(yAsc);
  P(projectUV(cyl(dR, dR, yAsc - 0.06 * slaH, 8, 0, y0 + 0.06 * slaH)), mats.gold, { order: 0.9, dist: 0.2, ax: [-1, 2] });
  P(projectUV(cyl(0.6 * dR, 0.72 * dR, lmTop - yAsc, 6, 0, y0 + yAsc)), mats.mliSilver, { order: 0.95, dist: 0.3, ax: [-1, 1] });
  for (let q = 0; q < 4; q++) {
    const phi0 = (q * Math.PI) / 2;
    const geo = latheUV(lathe([[Rb, 0], [Rs, slaH]], 16, phi0, Math.PI / 2).translate(0, y0, 0), { phiStart: phi0, phiLength: Math.PI / 2, H: slaH, R: (Rb + Rs) / 2 });
    P(geo, mats.silver, { order: 1 + q * 0.02, dir: radialPhi(phi0 + Math.PI / 4, 0.5), dist: 0.25 + 0.5 * Rb * S, side: DS, ax: [-1, 3] });
  }
  const ySm = y0 + slaH;
  P(projectUV(lathe([[0.6 * Rc, 0], [0.3 * Rc, 0.75 * spsH], [0.2 * Rc, spsH]], 32).translate(0, ySm - spsH, 0)), mats.darkMetal, { order: 1.2, dist: 0.45, side: DS, ax: [-1, 0] });
  const quads = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4;
    quads.push(box(0.12 * Rc, 0.1 * smH, 0.2 * Rc, Rc + 0.05 * Rc, ySm + 0.7 * smH, 0).rotateY(-a));
  }
  P(projectUV(merge([cyl(Rc, Rc, smH, 64, 0, ySm), ...quads])), mats.silver, { order: 1.3, dist: 0.6 });
  const yCm = ySm + smH;
  const cm = [[Rc, 0], [Rc * 0.98, 0.04 * cmH], [0.24 * Rc, 0.86 * cmH], [0.16 * Rc, 0.95 * cmH], [0.001, cmH]];
  P(projectUV(lathe(cm, 48).translate(0, yCm, 0)), mats.body, { order: 1.4, dist: 0.8, ax: [1, 0] });
  const lesH = g.lesH_m ?? 0;
  if (lesH > 0) {
    const yL = yCm + cmH * 0.95;
    const tr = dims.les_base_diameter_m ? dims.les_base_diameter_m / 2 : 0.3 * Rc;
    const truss = [];
    for (let i = 0; i < 4; i++) {
      const a = (i * TAU) / 4 + Math.PI / 4;
      const c = (f) => v3(f * tr * Math.cos(a), 0, f * tr * Math.sin(a));
      truss.push(tube(c(1).setY(yL), c(0.7).setY(yL + 0.2 * lesH), c(0.4).setY(yL + 0.4 * lesH), 0.015 * Rc, 6));
    }
    P(projectUV(merge(truss)), mats.darkMetal, { order: 1.5, dist: 1.0, ax: [1, 1] });
    const motor = [[0.13 * Rc, 0], [0.13 * Rc, 0.42 * lesH], [0.07 * Rc, 0.5 * lesH], [0.05 * Rc, 0.56 * lesH], [0.001, 0.6 * lesH]];
    P(projectUV(lathe(motor, 24).translate(0, yL + 0.4 * lesH, 0)), mats.body, { order: 1.6, dist: 1.1, ax: [1, 2] });
  }
}

// ---------- fairing ----------

// Base adapter (boattail when the fairing is wider than the stage, else a short ring), separation ring,
// two halves with the ogive nose.
function buildFairing(spec, mats) {
  const g = spec.geom;
  const Rf = g.D_m / 2;
  const Rb = g.baseD_m / 2;
  const baseH = Math.max(g.boattailH_m, 0.04 * g.D_m);
  const out = [];
  const adapter = g.boattailH_m > 0 ? [[Rb, 0], [Rf, g.boattailH_m], [Rf, baseH]] : [[Rf, 0], [Rf, baseH]];
  out.push(piece(latheUV(lathe(adapter, 64), { H: g.H_m, R: Rf }), mats.body, { order: 0, dir: DOWN, dist: 0.1, side: DS, ax: ["f", -1, 1] }));
  const ringH = 0.02 * g.D_m;
  out.push(piece(lathe([[Rf * 1.008, baseH - ringH], [Rf * 1.008, baseH + ringH]], 96), mats.skirt, { order: 0.5, dir: DOWN, dist: 0.06, side: DS, ax: ["f", -1, 0] }));
  const pts = [[Rf, baseH], [Rf, g.cylTop_m], ...ogivePoints(Rf, g.noseH_m, g.cylTop_m)];
  for (let h = 0; h < 2; h++) {
    const phi0 = h * Math.PI;
    const geo = latheUV(lathe(pts, 40, phi0, Math.PI), { phiStart: phi0, phiLength: Math.PI, H: g.H_m, R: Rf });
    const sx = h === 0 ? 1 : -1; // phi ∈ [0, π] is the +X half
    out.push(piece(geo, mats.body, { order: 1 + h * 0.05, dir: v3(sx, 0.12, 0), dist: 0.35 + 1.25 * Rf * S, side: DS, ax: ["f", 0, 0] }));
  }
  return out;
}

// ---------- parts ----------

const BUILDERS = { engines: buildEngines, tank: buildTank, interstage: buildInterstage, payload: buildPayload, fairing: buildFairing };

// Axial pull-apart hint (anime.js style). Pieces tagged ax = [group, side, rank] stack away from their
// group's core (side 0 stays) along Y: side +1 above the core, side −1 below, rank 0 nearest; pieces sharing
// a rank form one layer that moves together. Groups "top"/"bottom" stack beyond everything else in the part.
// Result: piece.axisOffset in scene units (rest.y + axisOffset is where the piece sits in that view).
function axisOffsets(pieces, gap) {
  const extent = (list, withOffset) =>
    list.reduce(([lo, hi], p) => [Math.min(lo, p.bottomY + (withOffset ? p.axisOffset : 0)), Math.max(hi, p.topY + (withOffset ? p.axisOffset : 0))], [Infinity, -Infinity]);
  const stack = (list, coreLo, coreHi) => {
    for (const sign of [1, -1]) {
      const side = list.filter((p) => p.ax[1] === sign);
      const ranks = [...new Set(side.map((p) => p.ax[2]))].sort((a, b) => a - b);
      let cursor = sign > 0 ? coreHi : coreLo;
      for (const r of ranks) {
        const layer = side.filter((p) => p.ax[2] === r);
        const [lo, hi] = extent(layer, false);
        const off = sign > 0 ? cursor + gap - lo : cursor - gap - hi;
        for (const p of layer) p.axisOffset = off;
        cursor = sign > 0 ? hi + off : lo + off;
      }
    }
  };
  const groups = new Map();
  for (const p of pieces) {
    p.axisOffset = 0;
    if (!p.ax) continue;
    if (!groups.has(p.ax[0])) groups.set(p.ax[0], []);
    groups.get(p.ax[0]).push(p);
  }
  for (const [name, list] of groups) {
    if (name === "top" || name === "bottom") continue;
    const core = list.filter((p) => p.ax[1] === 0);
    const [lo, hi] = extent(core.length ? core : list, false);
    stack(list, lo, hi);
  }
  const rest = pieces.filter((p) => !p.ax || (p.ax[0] !== "top" && p.ax[0] !== "bottom"));
  const [lo, hi] = rest.length ? extent(rest, true) : [0, 0];
  for (const name of ["top", "bottom"]) if (groups.has(name)) stack(groups.get(name), lo, hi);
}

export function createPart(spec, mats) {
  const group = new THREE.Group();
  group.name = spec.id;
  group.position.y = spec.slotY;
  const pieces = BUILDERS[spec.kind](spec, mats).map((p, i) => {
    const bb = p.mesh.geometry.boundingBox;
    p.mesh.userData.partId = spec.id;
    p.mesh.name = `${spec.id}:${i}`;
    group.add(p.mesh);
    return {
      mesh: p.mesh,
      index: i,
      order: p.order ?? i,
      bottomY: bb.min.y + p.mesh.position.y,
      topY: bb.max.y + p.mesh.position.y,
      rest: { position: p.mesh.position.clone(), quaternion: p.mesh.quaternion.clone() },
      explode: p.explode,
      ax: p.ax,
      axisOffset: 0,
    };
  });
  axisOffsets(pieces, clamp(0.035 * spec.height, 0.04, 0.3));
  for (const p of pieces) delete p.ax;
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  return { ...spec, group, pieces, built: false, busy: false };
}

// ---------- environment ----------

// Launch pad sized from the stack's base radius (scene units): deck, exhaust opening, holo rings, hold-down
// clamps between the engines, ground disc and polar grid.
export function createPad({ baseRadius_u = 1 } = {}) {
  const b = baseRadius_u;
  const g = new THREE.Group();
  const padR = Math.max(2.4, b * 3.4);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(padR, padR * 1.06, 0.18, 96), new THREE.MeshStandardMaterial({ color: 0x171a21, metalness: 0.6, roughness: 0.7 }));
  disc.position.y = -0.09;
  disc.receiveShadow = true;
  g.add(disc);
  const hole = new THREE.Mesh(new THREE.CircleGeometry(b * 1.04, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x07080b, metalness: 0.2, roughness: 0.95 }));
  hole.position.y = 0.003;
  hole.receiveShadow = true;
  g.add(hole);

  const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.holo, transparent: true, opacity: 0.85 });
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(padR * 0.8, 0.022, 8, 160), ringMat);
  ring1.rotation.x = Math.PI / 2;
  ring1.position.y = 0.012;
  g.add(ring1);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(b * 1.45, 0.014, 8, 120), ringMat);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.y = 0.012;
  g.add(ring2);

  // Hold-down clamps at 0/90/180/270° (between the outer engines and clear of S-IC style fins at 45°).
  const cw = 0.04 + 0.06 * b;
  const ch = 0.08 + 0.15 * b;
  const clampGeo = new THREE.BoxGeometry(cw * 1.8, ch, cw);
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x3b3f48, metalness: 0.9, roughness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    const c = new THREE.Mesh(clampGeo, clampMat);
    c.position.set(Math.cos(a) * (b * 1.12 + cw), ch / 2, Math.sin(a) * (b * 1.12 + cw));
    c.rotation.y = -a;
    c.castShadow = true;
    c.receiveShadow = true;
    g.add(c);
  }

  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.18;
  ground.receiveShadow = true;
  g.add(ground);

  const grid = new THREE.PolarGridHelper(Math.max(14, padR * 3), 16, 8, 96, 0x2a3140, 0x1a1f2a);
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
    const theta = Math.random() * TAU;
    const phi = Math.acos(Math.random() * 0.98 - 0.08); // mostly above the horizon
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: false });
  return new THREE.Points(geo, mat);
}
