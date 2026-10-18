// Procedural rocket parts, generated from the layout manifest (src/layout.js) at true scale.
// A part is a group at spec.slotY whose local y = 0 is the part's bottom. A part is a mechanical assembly of
// separate pieces (docs/v2-design.md round 8): an engine = nozzle extension, regen bell, chamber, injector,
// valve block, turbopump, gas generator, LOX + fuel pipes, actuator pair, gimbal; a tank = shell quarters,
// stringers, three domes, slosh baffles, downcomer, pressurant bottles, skirt and forward rings, ...
// Piece rules: translation-only children (rotation about Y allowed, X/Z rotations baked into the geometry);
// every mesh has its own material clone, mesh.userData.partId = spec.id and mesh.userData.kind
// ("shell" | "interior" | "detail"). Each piece carries (round 7):
//   order       arrival order, bottom-up (clusters: engineIndex + subIndex × 0.01)
//   engine      engine index for engine sub-pieces, else null (also on mesh.userData.engine)
//   explode     { dir, dist } radial opening, scene units, used as rest + dir × dist
//   axisOffset  scene units along +Y in the axial pull-apart view (see axisOffsets)
//   spin        radians about Y carried on arrival/departure (see assignSpins)
//
// Geometry is authored in metres and scaled by SCALE once. Sizes come from the spec (dataset records via
// layout.js). Every other proportion here (bell shape, pump size, leg length, panel layout, ...) is a visual
// ratio for shape only and is never shown on screen as a fact.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./layout.js";

// Round-10 x-ray look (docs/v2-design.md §5): dark see-through graphite shells with a peach fresnel rim,
// opaque steel internals, peach edge lines on every piece. It is the default; ?look=classic shows the
// earlier painted look for comparison.
const XRAY = !(typeof location !== "undefined" && /[?&]look=classic(&|$)/.test(location.search ?? ""));
export const LOOK = XRAY ? "xray" : "classic";
const PEACH = 0xffb48a;
const SHELL_OPACITY = 0.55; // built; choreo sets 0.30 exploded, 0.15 selected through setShellOpacity
const LINE_STRUCT = 0.55; // rings, flanges, bell lips, fins, legs, shell rims and seams
const LINE_FINE = 0.2; // weld lands, raceway clamps, shell panel seams
const LINE_INTERIOR = 0.3; // internals seen through the shells (domes, baffles, bottles)

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
    // Knurled / machined rings: fine diamond knurl, 6 cm tile on uv1 (metres).
    knurl: dataTexture(
      64,
      64,
      (u, v) => {
        const a = Math.abs(Math.sin((u + v) * Math.PI * 4));
        const b = Math.abs(Math.sin((u - v) * Math.PI * 4));
        const h = Math.min(a, b);
        return [h, 0.75 + 0.25 * (1 - h), 1];
      },
      { channel: 1, tile_m: 0.06 },
    ),
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
    // Black-and-white roll pattern on normalized UVs (u around, v along the shell): alternating eighths on the
    // lower part and a counter-phased band at the top. A visual reading of the photos, not a drawing.
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
    // Alpha for the roll pattern on x-ray shells: black bands opaque, the rest at the shell opacity (G channel).
    rollAlpha: dataTexture(W, 512, (u, v) => {
      const sector = Math.floor(u * 8);
      const black = (v < 0.3 && sector % 2 === 0) || (v > 0.93 && sector % 2 === 1);
      return black ? [1, 1, 1] : [SHELL_OPACITY, SHELL_OPACITY, SHELL_OPACITY];
    }),
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
  const classic = {
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
    // Inside the tanks: bare aluminium, not the painted finish.
    interior: metal(0xb7bbc1, 0.38, 0.85),
    // Machined rings and flanges: bright metal with a fine knurl.
    machined: std({ color: 0xaeb2b9, metalness: 1, roughness: 0.26, bumpMap: t.knurl, bumpScale: 0.8, roughnessMap: t.knurl }),
    // Engines: dark ridged metal bell (per-vertex colour = faint heat tint toward the throat, lighter flanges)
    // and bare-metal sub-assemblies around it.
    engine: std({ color: 0xffffff, vertexColors: true, metalness: 0.8, roughness: 0.55, envMapIntensity: 0.6, bumpMap: t.ridges, bumpScale: 0.25, roughnessMap: t.ridges }),
    chamber: metal(0x6e5d50, 0.38),
    powerhead: metal(0x8d9198, 0.36),
    valve: metal(0x5d6168, 0.4, 0.85),
    pump: metal(0xb3b7bd, 0.3, 0.92),
    pipe: metal(0xc4c8ce, 0.24, 0.95),
    actuator: metal(0x9a9ea6, 0.2, 0.95),
    gimbal: metal(0x2a2c31, 0.5, 0.8),
    gridFin: metal(0x4d5056, 0.46, 0.85),
    gold: mli(COLORS.gold),
    mliSilver: mli(0xc6c9ce),
    panel: std({ color: 0xffffff, map: t.cells, metalness: 0.45, roughness: 0.28, emissive: 0x050b1a, emissiveIntensity: 1 }),
    // legacy keys (kept so older callers still find them)
    accent: std({ color: COLORS.accent, metalness: 0.5, roughness: 0.5 }),
    dark: std({ color: 0x23262e, metalness: 0.7, roughness: 0.55 }),
  };
  // Roles used by the builders (same keys in both looks).
  classic.trim = classic.body; // painted parts that are not shells (fins, IU ring, CM, dish)
  classic.leg = classic.composite;
  classic.copv = classic.composite;
  classic.steelDark = classic.darkMetal;
  if (!XRAY) return classic;
  return xrayMaterials(t, classic);
}

// Fresnel rim in peach, added to the emissive term; the rim also lifts alpha so silhouettes read through.
function fresnelRim(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <emissivemap_fragment>",
    `#include <emissivemap_fragment>
    float xrayRim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0) * 0.8;
    totalEmissiveRadiance += vec3(1.0, 0.706, 0.541) * xrayRim;
    diffuseColor.a = min(1.0, diffuseColor.a + xrayRim * 0.3);`,
  );
}
const fresnelKey = () => "xray-shell-rim-v2";

function xrayMaterials(t, classic) {
  // X-ray shell: graphite, see-through, no depth write, front faces only. Finishes survive as tints;
  // `scale` multiplies the shell opacity (darker composite reads denser; the roll pattern's black bands are
  // opaque through its alphaMap, so its base opacity is scaled to 1).
  const shell = (color, { scale = 1, map = null, alphaMap = null } = {}) => {
    // Low metalness so the key light shades the cylinder light → shadow (depth); clearcoat adds a soft sheen.
    const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, metalness: 0.25, clearcoat: 0.25, clearcoatRoughness: 0.4, fog: true, transparent: true, opacity: clamp(SHELL_OPACITY * scale, 0, 1), depthWrite: false, side: THREE.FrontSide, map, alphaMap });
    m.onBeforeCompile = fresnelRim;
    m.customProgramCacheKey = fresnelKey;
    m.userData.opacityScale = scale;
    return m;
  };
  // Opaque internals: polygon offset pushes faces back so the edge lines sit cleanly on them.
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const steel = (color, roughness, metalness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, fog: true, ...po, ...extra });
  const light = steel(0xb9bec7, 0.35, 0.6); // brushed steel; 0.6 so internals read as lit forms, not mirrors
  const dark = steel(0x4a4f58, 0.4, 0.85);
  const sh = {
    white: shell(0x202328),
    roll: shell(0x24272c, { map: t.roll, alphaMap: t.rollAlpha, scale: 1 / SHELL_OPACITY }),
    foam: shell(0x45291a),
    bronze: shell(0x3a2e25),
    silver: shell(0x2f3338),
    composite: shell(0x101114, { scale: 1.2 }),
    gold: shell(0x382f1d),
    heat: shell(0x151618, { scale: 1.15 }),
  };
  // A material that is not a shell but whose piece may be (bell extension, MLI bus skins) names its shell.
  const asShell = (m, s) => Object.defineProperty(m, "asShell", { value: s });
  return {
    body: sh.white,
    roll: sh.roll,
    foam: sh.foam,
    bronze: sh.bronze,
    silver: asShell(steel(0xc3c7cd, 0.32, 0.9), sh.silver),
    composite: sh.composite,
    heatShield: sh.heat,
    raceway: dark,
    skirt: dark,
    metal: light,
    darkMetal: dark,
    interior: light,
    steelDark: dark,
    trim: light,
    leg: dark,
    copv: dark,
    machined: steel(0xc6cad1, 0.24, 1, { bumpMap: t.knurl, bumpScale: 0.6, roughnessMap: t.knurl }),
    engine: asShell(steel(0xffffff, 0.5, 0.8, { vertexColors: true, envMapIntensity: 0.6, bumpMap: t.ridges, bumpScale: 0.25, roughnessMap: t.ridges }), sh.white),
    chamber: steel(0xa59c93, 0.36, 0.9),
    powerhead: light,
    valve: dark,
    pump: dark,
    pipe: dark,
    actuator: light,
    gimbal: dark,
    gridFin: dark,
    gold: asShell(steel(COLORS.gold, 0.34, 1, { bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.gold),
    mliSilver: asShell(steel(0xc6c9ce, 0.34, 1, { bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.silver),
    panel: steel(0xffffff, 0.28, 0.45, { map: t.cells, emissive: 0x050b1a, emissiveIntensity: 1 }),
    accent: classic.accent,
    dark: dark,
  };
}

// Peach technical edge lines (x-ray look): one shared base, cloned per line object so opacity can follow
// its shell. Structural lines come from the mesh geometry (or a cleaner line-only geometry); fine lines (weld
// lands, clamps) from an optional extra geometry, at a lower opacity. userData.base = opacity when built.
let lineBase = null;
const edgeCache = new WeakMap();
// Depth cue: far lines fade more than fog alone gives, alpha *= 1 − 0.6 · smoothstep(fogNear, fogFar, depth),
// using the scene's linear fog uniforms (no-op without fog or with exponential fog).
function lineDepthAlpha(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <fog_fragment>",
    `#include <fog_fragment>
    #if defined( USE_FOG ) && !defined( FOG_EXP2 )
      gl_FragColor.a *= 1.0 - 0.6 * smoothstep( fogNear, fogFar, vFogDepth );
    #endif`,
  );
}
const lineDepthKey = () => "xray-line-depth-v1";
function lineChild(mesh, geo, base, name) {
  lineBase ??= new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: LINE_STRUCT, depthTest: true, fog: true });
  let eg = edgeCache.get(geo);
  if (!eg) edgeCache.set(geo, (eg = new THREE.EdgesGeometry(geo, 25)));
  const m = lineBase.clone();
  m.onBeforeCompile = lineDepthAlpha; // set per clone: Material.copy drops shader hooks
  m.customProgramCacheKey = lineDepthKey;
  m.opacity = base;
  const lines = new THREE.LineSegments(eg, m);
  lines.raycast = () => {}; // picking stays on the meshes
  lines.name = name;
  lines.userData.base = base;
  mesh.add(lines);
  return lines;
}
// lineGeo === false: no structural layer (long shells whose rims are drawn by their rings).
function addEdges(mesh, { kind, lineGeo = null, fineGeo = null } = {}) {
  if (lineGeo !== false) mesh.userData.edges = lineChild(mesh, lineGeo ?? mesh.geometry, kind === "interior" ? LINE_INTERIOR : LINE_STRUCT, "edges");
  if (fineGeo) mesh.userData.edgesFine = lineChild(mesh, fineGeo, LINE_FINE, "edges-fine");
}

const finishMat = (mats, finish) =>
  ({ "white-black-roll": mats.roll, "orange-foam": mats.foam, bronze: mats.bronze, silver: mats.silver, "black-composite": mats.composite })[finish] ??
  mats.body;
// Short structures (thrust-section skin) take the stage colour but never the roll pattern (mapped per shell).
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
function latheUV(geo, { phiStart = 0, phiLength = TAU, H = 1, R = 1, y0 = 0 }) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const phi = phiStart + uv.getX(i) * phiLength;
    const y = pos.getY(i);
    uv.setXY(i, phi / TAU, (y - y0) / H);
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
const tube = (a, c, b, r, seg = 8) => new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, c, b), seg, r, 6, false);
const rod = (a, b, r, seg = 2) => tube(a, a.clone().lerp(b, 0.5), b, r, seg);

// Box spanning a → b (long axis), thin side facing `out` (baked orientation, no mesh rotation needed).
function strut(a, b, w, d, out) {
  const yAxis = b.clone().sub(a);
  const len = yAxis.length();
  yAxis.normalize();
  const zAxis = new THREE.Vector3().crossVectors(out, yAxis).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  return new THREE.BoxGeometry(d, len, w)
    .applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
    .translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// Machined ring between radii rIn..rOut, height h, bottom at y0: chamfered edges and a shallow centre groove
// so it catches crisp highlights (the anime.js-lens look). Closed lathe profile.
function machinedRing(rIn, rOut, h, y0 = 0, seg = 64) {
  const w = rOut - rIn;
  const c = Math.min(0.25 * w, 0.18 * h);
  const g = Math.min(0.3 * w, 0.1 * h);
  const pts = [
    [rIn, y0 + h],
    [rIn, y0],
    [rOut - c, y0],
    [rOut, y0 + c],
    [rOut, y0 + 0.38 * h],
    [rOut - g, y0 + 0.44 * h],
    [rOut - g, y0 + 0.56 * h],
    [rOut, y0 + 0.62 * h],
    [rOut, y0 + h - c],
    [rOut - c, y0 + h],
    [rIn, y0 + h],
  ];
  return latheUV(lathe(pts, seg), { H: h, R: rOut, y0 });
}

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

// Ring of n small blocks (bolt heads, knurl teeth) on radius r centred at height y: w tangential,
// h tall, d radial. One merged geometry with uv/uv1, so it merges into rings, flanges and lathes.
function boltRing(r, y, n, w, h = w, d = w, phase = 0) {
  const geos = [];
  for (let i = 0; i < n; i++) {
    const phi = phase + (i / n) * TAU;
    geos.push(new THREE.BoxGeometry(d, h, w).rotateY(phi - Math.PI / 2).translate(Math.sin(phi) * r, y, Math.cos(phi) * r));
  }
  return projectUV(merge(geos));
}
const paint = (geo, rgb) => {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
};

// Per-profile-point vertex colours for a lathe (vertex index = segmentIndex × points + pointIndex).
function colorLathe(geo, nPts, colorOf) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(colorOf(i % nPts, geo.attributes.position.getY(i)), i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
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

// Geometry and offsets in metres; explode.dist in scene units.
//   ax   = [group, side, rank] tag for the axial pull-apart (see axisOffsets)
//   sym  = axisymmetric piece on the axis (own alternating spin); off-axis pieces share the part's spin so a
//          ring of shells / a cluster rotates rigidly in the exploded view (see assignSpins)
//   kind = "shell" | "interior" | "detail"; engine = engine index or null
function piece(geo, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, dir = UP, dist = 0.4, side, ax = null, sym = false, kind = "detail", engine = null, edges = kind === "shell", lineGeo = null, fineGeo = null } = {}) {
  const g = toUnits(geo);
  g.computeBoundingBox();
  const xrayShell = XRAY && kind === "shell";
  const src = xrayShell && material.asShell ? material.asShell : material;
  const mat = src.clone();
  if (src.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) {
    mat.onBeforeCompile = src.onBeforeCompile; // Material.copy does not carry the shader hook
    mat.customProgramCacheKey = src.customProgramCacheKey;
  }
  if (side !== undefined && !xrayShell) mat.side = side; // x-ray shells stay front-side
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x * S, y * S, z * S);
  mesh.rotation.y = ry;
  // Performance: only shells cast and receive shadows (internals sit inside them anyway).
  mesh.castShadow = kind === "shell";
  mesh.receiveShadow = kind === "shell";
  mesh.userData.kind = kind;
  mesh.userData.engine = engine;
  // Edge lines only on shells (default) and pieces marked edges: true (domes, rings, fins, legs, payload
  // bodies); never on bolts, clamps, pipes, pumps, stringers. lineGeo / fineGeo (metres, same frame as geo)
  // give a cleaner structural layer (e.g. a ring without its bolts) and a fine layer.
  if (XRAY && edges) addEdges(mesh, { kind, lineGeo: lineGeo && toUnits(lineGeo), fineGeo: fineGeo && toUnits(fineGeo) });
  return { mesh, order, explode: { dir: dir.clone().normalize(), dist }, ax, sym, kind, engine };
}

// ---------- engines ----------

// Nozzle + chamber + injector profiles, exit at y=0. Rao-style parabolic bell: a quadratic Bezier from the
// exit to the throat whose control point is where the throat and exit tangents meet.
function nozzleProfile({ L, Re, rt, rc, bellL, convL, chamberL, domeL, vacuum }) {
  const tn = Math.tan(((vacuum ? 33 : 28) * Math.PI) / 180); // wall angle just below the throat (visual)
  const te = Math.tan(((vacuum ? 9 : 10) * Math.PI) / 180); // wall angle at the exit (visual)
  const yc = clamp((bellL * tn - (Re - rt)) / (tn - te), 0.08 * bellL, 0.92 * bellL);
  const rcp = Re - yc * te;
  const bell = [];
  const N = 40;
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
  const rAtBell = (y) => {
    for (let i = 1; i < bell.length; i++) if (bell[i][1] >= y) return lerp(bell[i - 1][0], bell[i][0], (y - bell[i - 1][1]) / Math.max(bell[i][1] - bell[i - 1][1], 1e-9));
    return rt;
  };
  return { bell, chamber, dome, rAtBell, all: [...bell, ...chamber.slice(1), ...dome.slice(1)], yTop: y1 + fl + domeL, y1 };
}

// One engine's sub-assemblies, each its own geometry in engine-local metres (exit plane y=0, gimbal top y=L,
// turbopump on local +X, gas generator on −X, valve block on −Z). Shared by every engine of the same shape.
//   sea-level: nozzle extension, regen bell, chamber, injector, valve block, turbopump, gas generator (+ turbine
//              exhaust duct), LOX pipe, fuel pipe, actuator pair, gimbal                         = 11 pieces
//   vacuum:    long nozzle extension, regen bell, chamber, injector, turbopump, 2 pipes, gimbal  = 8 pieces
//   twin (chambers = 2, RD-180 style): two bell/chamber/injector stacks inside the record's envelope around
//              one turbopump                                                                     = 15 pieces
// Entry: { geo, mat, ax: [side, rank] around the chamber core, sym, ds (double-sided) }.
const kitCache = new Map();
function engineKit({ exitD_m, L, vacuum, chambers = 1, overall = false }) {
  const key = [exitD_m, L, vacuum, chambers, overall].join("|");
  if (kitCache.has(key)) return kitCache.get(key);
  const twin = chambers > 1;
  // diameter_m is the exit diameter, except "overall" envelopes (bell drawn at a visual 84 % of it) and twins.
  const Re = twin ? exitD_m / 4 / 1.03 : overall ? exitD_m * 0.42 : exitD_m / 2;
  const off = twin ? Re * 1.03 : 0;
  // Visual proportions of the engine length (no data): bell share, converging section, chamber, dome.
  const bellL = L * (vacuum ? 0.74 : 0.6);
  const convL = L * (vacuum ? 0.04 : 0.06);
  const chamberL = L * (vacuum ? 0.07 : 0.11);
  const domeL = L * (vacuum ? 0.035 : 0.05);
  const rt = Re * (vacuum ? 0.16 : 0.3); // throat radius (visual expansion ratio)
  const rc = rt * 1.6; // chamber radius
  const prof = nozzleProfile({ L, Re, rt, rc, bellL, convL, chamberL, domeL, vacuum });
  const { yTop, y1, rAtBell } = prof;
  const radiusAt = (y) => (y <= bellL ? rAtBell(y) : rc);

  const kit = [];
  const zs = twin ? [-off, off] : [0];
  // Bell split into the nozzle extension (lower) and the regeneratively cooled bell (upper), joined by a
  // bolted flange; a stiffener lip at the exit. Dark steel (darker niobium-like extension on vacuum engines),
  // faint warm tint toward the throat, lighter machined flanges. uv.x repeats the one-ridge texture.
  const ySplit = (vacuum ? 0.62 : 0.5) * bellL;
  const rs = rAtBell(ySplit);
  const fl = 0.012 * L;
  const ext = [[Re * 1.025, 0.014 * L], [Re * 1.025, 0], ...prof.bell.filter((p) => p[1] > 0 && p[1] < ySplit), [rs, ySplit], [rs * 1.07, ySplit], [rs * 1.07, ySplit - fl]];
  const regen = [[rs * 1.07, ySplit], [rs * 1.07, ySplit + fl], [rAtBell(ySplit + fl), ySplit + fl], ...prof.bell.filter((p) => p[1] > ySplit + fl)];
  const steel = vacuum ? [0.07, 0.07, 0.08] : [0.15, 0.15, 0.16];
  const regenBase = [0.15, 0.15, 0.16];
  const heat = [0.4, 0.25, 0.15];
  const flange = [0.48, 0.48, 0.5];
  const RIDGES = vacuum ? 72 : 48;
  const ridgeUV = (g) => {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * RIDGES);
    return g;
  };
  for (const z of zs) {
    const ge = colorLathe(lathe(ext, 48), ext.length, (j) => (j < 2 || j >= ext.length - 2 ? flange : steel));
    kit.push({ geo: ridgeUV(ge).translate(0, 0, z), mat: "engine", ax: [-1, 1], sym: !twin, ds: true, kind: "shell" });
    const gr = colorLathe(lathe(regen, 48), regen.length, (j, y) => {
      if (j < 2) return flange;
      const k = Math.pow(clamp(y / bellL, 0, 1), 3) * 0.55;
      return [lerp(regenBase[0], heat[0], k), lerp(regenBase[1], heat[1], k), lerp(regenBase[2], heat[2], k)];
    });
    // Bolt circle on the extension flange (nuts on the regen side).
    const b = Math.min(0.012 * L, 0.05 * rs);
    const bolts = paint(boltRing(rs * 1.035, ySplit + fl + b / 2, 16, b), flange);
    kit.push({ geo: merge([ridgeUV(gr), bolts]).translate(0, 0, z), mat: "engine", ax: [-1, 0], sym: !twin, ds: true });
  }
  // Chamber with a knurled ring at the throat; injector dome with a bolt circle on its flange.
  const knurl = boltRing(rt * 1.16, bellL + 0.012 * L, 24, (TAU * rt * 1.16) / 48, 0.03 * L, 0.08 * rt);
  for (const z of zs) kit.push({ geo: merge([lathe(prof.chamber, 20), knurl.clone()]).translate(0, 0, z), mat: "chamber", ax: [0, 0], sym: !twin, ds: true });
  const bd = Math.min(0.01 * L, 0.06 * rc);
  for (const z of zs) kit.push({ geo: merge([lathe(prof.dome, 20), boltRing(rc * 1.09, y1 + 0.015 * L + bd / 2, 16, bd)]).translate(0, 0, z), mat: "powerhead", ax: [1, 0], sym: !twin });

  // Turbopump: a vertical cylinder beside the chamber (between the chambers on a twin) with turbine cap and
  // pump volute ring.
  const rp = rc * (twin ? 0.7 : vacuum ? 0.5 : 0.6);
  const hp = L * (vacuum ? 0.16 : 0.24);
  const py0 = bellL + convL * 0.5;
  const px = twin ? 0 : rc + rp + 0.03 * L;
  const pz = twin ? 0 : 0;
  if (!vacuum) {
    // Main valve block on the injector (−Z side) with its actuator can.
    const vz = twin ? -(rp + 0.3 * rc) : -rc * 1.15;
    kit.push({ geo: merge([box(0.55 * rc, 0.07 * L, 0.5 * rc, 0, yTop - 0.03 * L, vz), cyl(0.14 * rc, 0.14 * rc, 0.05 * L, 8, 0, yTop + 0.005 * L, vz)]), mat: "valve", ax: [1, 1] });
  }
  kit.push({
    geo: merge([
      cyl(rp, rp, hp, 12, px, py0, pz),
      cyl(rp * 0.72, rp * 0.72, hp * 0.14, 10, px, py0 + hp, pz),
      new THREE.TorusGeometry(rp * 1.02, rp * 0.22, 6, 16).rotateX(Math.PI / 2).translate(px, py0 + hp * 0.3, pz),
    ]),
    mat: "pump",
    ax: [1, 2],
  });
  if (!vacuum) {
    // Gas generator (small can with a domed top, opposite the pump) and its turbine exhaust duct down the bell.
    const rg = rc * (twin ? 0.36 : 0.3);
    const hg = L * 0.1;
    const gx = twin ? -(rp + rg + 0.03 * L) : -(rc + rg + 0.02 * L);
    const gy = bellL + convL;
    const yEnd = bellL * 0.42;
    const rD = rp * 0.42;
    const xEnd = -(radiusAt(yEnd) + (twin ? off : 0) * 0 + rD * 1.3);
    const parts = [cyl(rg, rg * 0.8, hg, 10, gx, gy), lathe(domePoints(rg, rg * 0.7, true, 4), 10).translate(gx, gy + hg, 0)];
    if (!twin) parts.push(tube(v3(gx, gy, 0), v3(Math.min(gx, xEnd) - rD, gy - (gy - yEnd) * 0.35, 0), v3(xEnd, yEnd, 0), rD, 10));
    kit.push({ geo: merge(parts), mat: "powerhead", ax: [0, 0] });
  }
  // Feed pipes: LOX (pump → injector dome) and fuel (pump → chamber side), one branch per chamber.
  const rPipe = rc * (vacuum ? 0.16 : 0.2);
  const lox = [];
  const fuel = [];
  for (const z of zs) {
    const s = twin ? Math.sign(z) : 1;
    lox.push(tube(v3(px, py0 + hp * 0.8, 0), v3(px * 0.6, yTop + domeL * 0.9, z * 0.4), v3(rc * 0.3, yTop - domeL * 0.3, z), rPipe));
    fuel.push(tube(v3(px, py0 + hp * 0.35, rp * 0.6 * s), v3(px * 0.7 + rc * 0.4, py0 + hp * 0.2, rc * 1.3 * s + z * 0.5), v3(rc * 0.55, bellL + convL + chamberL * 0.5, z + rc * 0.75 * s), rPipe * 0.85));
  }
  kit.push({ geo: merge(lox), mat: "pipe", ax: [1, 3] });
  kit.push({ geo: merge(fuel), mat: "pipe", ax: [1, 3] });
  if (!vacuum) {
    // Gimbal actuator pair: two hydraulic rams from the thrust frame down to the chamber, ±Z.
    const rams = [];
    for (const s of [1, -1]) {
      const zc = s * (twin ? off : 0);
      const top = v3(-0.2 * rc, L - 0.03 * L, s * rc * 1.5 + zc);
      const bot = v3(-0.2 * rc, bellL + convL + 0.6 * chamberL, s * rc * 1.05 + zc);
      const mid = top.clone().lerp(bot, 0.5);
      rams.push(rod(top, mid, 0.17 * rc), rod(mid, bot, 0.1 * rc), cyl(0.2 * rc, 0.2 * rc, 0.03 * L, 8, top.x, top.y - 0.005 * L, top.z));
    }
    kit.push({ geo: merge(rams), mat: "actuator", ax: [1, 4] });
  }
  // Gimbal block + flange up to the mount plate.
  const gw = twin ? 2 * off + rc : rc * 1.1;
  const gh = L - yTop + 0.02 * L;
  kit.push({
    geo: merge([
      box(twin ? rc * 1.1 : gw, gh, gw, 0, yTop - 0.02 * L + gh / 2, 0),
      cyl(rc * 0.95, rc * 0.95, 0.025 * L, 12, 0, L - 0.025 * L),
      boltRing(rc * 0.97, L - 0.0125 * L, 24, (TAU * rc) / 50, 0.02 * L, 0.06 * rc), // knurled gimbal ring
    ]),
    mat: "gimbal",
    ax: [1, 5],
    sym: true,
  });
  Object.assign(kit, { radiusAt, bellL, rc, off, y1 });
  kitCache.set(key, kit);
  return kit;
}

// Heat-shield sectors (annulus segments with a hole per engine): one per ring engine when the ring has 3+,
// else four; boundaries fall between ring engines so every hole sits inside one sector.
function heatShieldSectors(g, holeR, innerR, Rout, y, t) {
  const ring = g.positions.filter((p) => p.r > 0);
  const m = ring.length;
  const n = m >= 3 ? m : 4;
  const a0 = m >= 3 ? ring[0].a + Math.PI / m : Math.PI / 4;
  const out = [];
  let shared = null; // with one ring engine per sector, sector k is sector 0 turned by k·2π/n
  for (let k = 0; k < n; k++) {
    const t0 = a0 + (k * TAU) / n;
    const t1 = t0 + TAU / n;
    if (shared) {
      out.push({ geo: shared, mid: (t0 + t1) / 2, ry: (-k * TAU) / n });
      continue;
    }
    // Shape space (x, y) maps to world (x, −z) after rotateX(−π/2), so world azimuth α is shape angle −α.
    const shape = new THREE.Shape();
    shape.absarc(0, 0, Rout, -t0, -t1, true);
    shape.absarc(0, 0, innerR, -t1, -t0, false);
    for (const p of ring) {
      let d = (((p.a - t0) % TAU) + TAU) % TAU;
      if (d > 0 && d < TAU / n) shape.holes.push(new THREE.Path().absarc(p.x, -p.z, holeR, 0, TAU, true));
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 16 }).rotateX(-Math.PI / 2).translate(0, y, 0);
    if (m >= 3) shared = geo;
    out.push({ geo, mid: (t0 + t1) / 2, ry: 0 });
  }
  return out;
}

function buildEngines(spec, mats) {
  const g = spec.geom;
  const L = g.engineLength_m;
  const kit = engineKit({ exitD_m: g.exitD_m, L, vacuum: g.vacuum, chambers: g.chambers, overall: g.diameterKind === "overall" });
  const { radiusAt, bellL, rc, off } = kit;
  const out = [];
  // Exploded view: each engine's sub-pieces stack along the axis (axisOffset, group "e<i>") and the whole
  // column moves outward from the cluster centre (explode), so neighbouring columns never touch.
  const d = Math.max(0.15, 0.45 * L * S);
  g.positions.forEach((p, i) => {
    // Powerheads turn tangentially on a ring so pumps stay inside the cluster footprint.
    const ry = p.r > 0 ? -p.a - Math.PI / 2 : 0;
    const dir = p.r > 0 ? radial(p.a, -0.12) : DOWN;
    const dist = p.r > 0 ? d : 0.25 * d;
    kit.forEach((s, j) =>
      out.push(
        piece(s.geo, mats[s.mat], { x: p.x, z: p.z, ry, order: i + j * 0.01, dir, dist, side: s.ds ? DS : undefined, ax: [`e${i}`, ...s.ax], sym: s.sym && p.r === 0, engine: i, kind: s.kind ?? "detail" }),
      ),
    );
  });
  const n = g.positions.length;

  const Rm = g.mountD_m / 2;
  const mountH = g.mountH_m;
  const fairings = g.features.includes("engine-fairings");
  // Stage-0 clusters (3+ engines) get a thrust section: the stage skin continues down to a heat shield at
  // the upper bell, hiding the powerheads (Falcon 9 octaweb / S-IC base). Other clusters carry the heat
  // shield right under the mount plate. Heights are visual ratios.
  const thrustSection = g.stageIndex === 0 && spec.count >= 3;
  const yHs = thrustSection ? (fairings ? 0.8 * L : 0.9 * bellL) : L - 0.06;
  const holeR = thrustSection ? radiusAt(yHs) * 1.12 + 0.02 * L : rc * 1.7;
  const hasCentre = g.positions.some((p) => p.r === 0);
  const innerR = hasCentre ? (g.chambers > 1 ? off + rc * 1.7 : holeR) : Math.min(holeR, 0.08 * Rm);
  heatShieldSectors(g, holeR, innerR, Rm * 0.98, yHs, 0.06).forEach(({ geo, mid, ry }, k) =>
    out.push(piece(geo, mats.heatShield, { ry, order: n + 0.1 + k * 0.01, dir: radial(mid, -0.15), dist: 0.12 + 0.35 * Rm * S, ax: ["top", 1, 0], kind: "shell" })),
  );
  if (thrustSection) {
    const skirt = latheUV(lathe([[Rm, yHs], [Rm, L + mountH]], 64), { H: spec.height / S, R: Rm });
    out.push(piece(skirt, plainFinish(mats, g.finish), { order: n + 0.3, dir: UP, dist: 0.3, side: DS, ax: ["top", 1, 1], sym: true, kind: "shell" }));
  }
  const mb = 0.06 * mountH + 0.004 * Rm;
  const mount = machinedRing(0.02, Rm * 0.985, mountH, L);
  out.push(piece(merge([mount.clone(), boltRing(Rm * 0.9, L + mountH + mb / 2, 24, mb)]), mats.machined, { order: n + 0.4, dir: UP, dist: 0.2, ax: ["top", 1, 2], sym: true, edges: true, lineGeo: mount }));

  // S-IC style engine fairings (outer engines) and fins.
  const outer = g.positions.filter((p) => p.r > 0);
  if (fairings) {
    const yBot = 0.45 * L;
    const fGeo = projectUV(lathe([[radiusAt(yBot) * 1.12 + 0.03 * L, yBot], [rc * 2.4, yHs]], 32));
    outer.forEach((p, i) => out.push(piece(fGeo, mats.body, { x: p.x, z: p.z, order: n + 0.5 + i * 0.02, dir: radial(p.a, -0.2), dist: d * 1.2, side: DS, kind: "shell" })));
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
    outer.forEach((p, i) => out.push(piece(finGeo, mats.trim, { ry: -p.a, order: n + 0.6 + i * 0.02, dir: radial(p.a), dist: d * 1.4, edges: true })));
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
  // Arrival bottom-up: skirt ring, then the interior (bottom dome, downcomer, lower baffles, common bulkhead,
  // upper baffles, pressurant bottles, top dome), then stringers and the skin closing around it, raceway,
  // forward ring, legs. Interior layout is visual (bulkheads, propellant split at 42 % of the height).
  const domeH = 0.35 * R;
  const inset = 0.015 * H;
  const yMid = 0.42 * H;
  const skirtH = Math.min(0.012 * H, 0.12 * D);
  const fwdH = Math.min(0.012 * H, 0.12 * D);
  const inner = 0.15 + 0.2 * R * S;
  const tb = Math.max(0.02, 0.006 * D); // bolt head size (visual)
  const ringBolts = (y) => boltRing(R * 1.011, y, 24, tb, tb, tb * 0.8);
  const skirtRing = machinedRing(R * 0.985, R * 1.008, skirtH);
  out.push(piece(merge([skirtRing.clone(), ringBolts(skirtH * 0.5)]), mats.skirt, { order: 0, dir: DOWN, dist: 0.15, ax: T(-1, 0), sym: true, edges: true, lineGeo: skirtRing }));
  out.push(piece(projectUV(lathe(domePoints(R * 0.985, domeH, false), 36).translate(0, inset + domeH, 0)), mats.interior, { order: 0.1, dir: DOWN, dist: inner, side: DS, sym: true, kind: "interior", edges: true }));
  out.push(piece(cyl(0.045 * D, 0.045 * D, yMid - inset, 16, 0, inset), mats.interior, { order: 0.2, dir: DOWN, dist: 0.05, sym: true, kind: "interior" }));
  // Slosh baffle: flat annulus with a ring of lightening cut-outs (edges draw the holes).
  const baffleShape = new THREE.Shape().absarc(0, 0, R * 0.985, 0, TAU, false);
  baffleShape.holes.push(new THREE.Path().absarc(0, 0, R * 0.78, 0, TAU, true));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    baffleShape.holes.push(new THREE.Path().absarc(Math.cos(a) * R * 0.88, Math.sin(a) * R * 0.88, R * 0.045, 0, TAU, true));
  }
  const baffle0 = new THREE.ExtrudeGeometry(baffleShape, { depth: 0.012 * D, bevelEnabled: false, curveSegments: 16 }).rotateX(-Math.PI / 2);
  const baffleGeo = () => baffle0; // one geometry shared by the tank's four baffles
  const baffles = [0.13, 0.28, 0.6, 0.76];
  baffles.forEach((f, i) => {
    if (i === 2) out.push(piece(projectUV(lathe(domePoints(R * 0.985, domeH * 0.8, true), 36).translate(0, yMid, 0)), mats.interior, { order: 0.35, dir: UP, dist: 0.06, side: DS, sym: true, kind: "interior", edges: true }));
    out.push(piece(baffleGeo(), mats.interior, { y: f * H, order: 0.3 + i * 0.02 + (i >= 2 ? 0.1 : 0), dir: f < 0.5 ? DOWN : UP, dist: 0.04, side: DS, sym: true, kind: "interior" }));
  });
  const yCopv = H - inset - domeH - 0.16 * D;
  const copvGeo = new THREE.CapsuleGeometry(0.07 * D, 0.12 * D, 4, 12); // shared by the four bottles
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    out.push(piece(copvGeo, mats.copv, { x: 0.32 * R * Math.cos(a), y: yCopv, z: 0.32 * R * Math.sin(a), order: 0.6 + k * 0.01, dir: radial(a, 0.6), dist: 0.08, kind: "interior" }));
  }
  out.push(piece(projectUV(lathe(domePoints(R * 0.985, domeH, true), 36).translate(0, H - inset - domeH, 0)), mats.interior, { order: 0.7, dir: UP, dist: inner, side: DS, sym: true, kind: "interior", edges: true }));

  // Skin: four shell quarters, each with its ring of internal stringers. An enclosed tank (it sits inside the
  // interstage/fairing on the real vehicle) shows the plain white enclosure instead of a painted finish.
  const shellMat = g.enclosed ? mats.body : finishMat(mats, g.finish);
  const shellDist = 0.25 + 0.9 * R * S;
  // Skin profile with raised weld lands every ~6 m (visual spacing).
  const y0s = skirtH * 0.5;
  const y1s = H - fwdH * 0.5;
  const nW = Math.max(0, Math.floor((y1s - y0s) / 6) - 1);
  const step = (y1s - y0s) / (nW + 1);
  const ww = 0.05;
  const shellProfile = [[R, y0s]];
  const welds = [];
  for (let i = 1; i <= nW; i++) {
    const y = y0s + i * step;
    welds.push(y);
    shellProfile.push([R, y - ww], [R * 1.004, y - ww], [R * 1.004, y + ww], [R, y + ww]);
  }
  shellProfile.push([R, y1s]);
  // Quarter 0 is built once; quarters 1–3 are the same geometry turned by q·π/2 about Y (allowed by the
  // piece rules), so each tank uploads one skin, one stringer set and one line set.
  const str = [];
  for (let j = 0; j < 6; j++) {
    const phi = ((j + 0.5) * (Math.PI / 2)) / 6;
    const r = R - 0.008 * D;
    str.push(box(0.012 * D, 0.94 * H, 0.01 * D).rotateY(phi - Math.PI / 2).translate(Math.sin(phi) * r, H / 2, Math.cos(phi) * r));
  }
  const strGeo = merge(str);
  const quarterGeo = latheUV(lathe(shellProfile, 24, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H, R });
  const plain = lathe([[R, y0s], [R, y1s]], 24, 0, Math.PI / 2); // its boundary = the panel seams
  const seamWeldGeo = merge([plain, ...welds.map((y) => lathe([[R, y - ww], [R * 1.004, y - ww], [R * 1.004, y + ww], [R, y + ww]], 24, 0, Math.PI / 2))]);
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    out.push(piece(strGeo, mats.interior, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist * 0.7, kind: "interior" }));
  }
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    out.push(piece(quarterGeo, shellMat, { ry, order: 1.5 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist, side: DS, kind: "shell", lineGeo: false, fineGeo: seamWeldGeo }));
  }
  // Raceway (cable/plumbing tunnel) along the full length.
  if (!g.enclosed) {
    const rwA = Math.PI / 2;
    const rwD = 0.03 * D;
    const rwH = H - skirtH - fwdH - 0.01 * H;
    const duct = box(rwD, rwH, 0.07 * D, R + rwD / 2, skirtH + rwH / 2, 0);
    const clamps = [];
    for (let y = skirtH + 1.5; y < skirtH + rwH - 0.5; y += 3) clamps.push(box(rwD * 1.7, 0.12, 0.07 * D * 1.5, R + rwD * 0.85, y, 0)); // every ~3 m
    const clampGeo = clamps.length ? merge(clamps) : null;
    out.push(piece(projectUV(merge([duct.clone(), ...(clampGeo ? [clampGeo] : [])])), mats.raceway, { ry: -rwA, order: 2, dir: radial(rwA), dist: shellDist * 1.1, edges: true, lineGeo: duct }));
    if (g.stageIndex === 0) {
      // Umbilical plate with two quick-disconnect ports near the base (visual sizes).
      const ua = rwA + 0.55;
      const uy = skirtH + 0.02 * H + 0.2 * D;
      const port = (z) => new THREE.CylinderGeometry(0.035 * D, 0.035 * D, 0.05 * D, 10).rotateZ(Math.PI / 2).translate(R + 0.045 * D, uy, z);
      const umb = merge([box(0.03 * D, 0.32 * D, 0.24 * D, R + 0.015 * D, uy, 0), port(-0.06 * D), port(0.06 * D)]);
      out.push(piece(projectUV(umb), mats.steelDark, { ry: -ua, order: 2.2, dir: radial(ua), dist: shellDist * 1.1 }));
    }
  }
  const fwdRing = machinedRing(R * 0.985, R * 1.008, fwdH, H - fwdH);
  out.push(piece(merge([fwdRing.clone(), ringBolts(H - fwdH * 0.5)]), mats.machined, { order: 2.5, dir: UP, dist: 0.12, ax: T(1, 0), sym: true, edges: true, lineGeo: fwdRing }));

  if (g.features.includes("landing-legs")) legs(out, mats, R, H, D, shellDist, skirtH);
  if (g.features.includes("grid-fins")) gridFins(out, mats, R, R, H * 0.985 - fwdH, D, shellDist);
  return out;
}

// Falcon-style folded landing legs (tapered carbon struts hinged at the base, foot pad at the top end) and
// their upper brackets on the skin.
function legs(out, mats, R, H, D, shellDist, y0) {
  const len = Math.min(0.24 * H, 2.6 * D); // visual
  const w0 = 0.2 * D;
  const w1 = 0.11 * D;
  const t0 = 0.1 * D;
  const t1 = 0.06 * D;
  const strutGeo = new THREE.BoxGeometry(1, 1, 1, 1, 4, 1);
  const p = strutGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = p.getY(i) + 0.5;
    p.setXYZ(i, R + (p.getX(i) + 0.5) * lerp(t0, t1, k), y0 + k * len, p.getZ(i) * lerp(w0, w1, k));
  }
  strutGeo.computeVertexNormals();
  const foot = box(t1 * 1.6, 0.05 * len, w1 * 1.25, R + t1 * 0.8, y0 + len - 0.025 * len, 0);
  const hinge = box(t0 * 1.2, 0.04 * len, w0 * 1.1, R + t0 * 0.6, y0 + 0.02 * len, 0);
  const legGeo = projectUV(merge([strutGeo, foot, hinge]));
  const bracketGeo = merge([box(0.05 * D, 0.03 * len, 0.16 * D, R + 0.025 * D, y0 + len + 0.03 * len, 0), cyl(0.02 * D, 0.02 * D, 0.03 * len, 10, R + 0.06 * D, y0 + len + 0.015 * len)]);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push(piece(legGeo, mats.leg, { ry: -a, order: 3 + i * 0.02, dir: radial(a), dist: shellDist * 1.4, edges: true }));
    out.push(piece(bracketGeo, mats.darkMetal, { ry: -a, order: 3.1 + i * 0.02, dir: radial(a, 0.3), dist: shellDist * 1.2 }));
  }
}

// Folded grid fins standing against the body, lattice facing out. rBot/rTop: body radius at the fin's
// bottom/top (frustum interstages); yTop: top of the fin.
function gridFins(out, mats, rBot, rTop, yTop, D, dist) {
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
      const gb = new THREE.BoxGeometry(d * 0.9, len, bar);
      gb.rotateX((s * -Math.PI) / 4);
      geos.push(gb.translate(r + d / 2, y0 + h / 2 + (yA + yB) / 2, (zA + zB) / 2));
    }
  }
  const geo = merge(geos);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    out.push(piece(geo, mats.gridFin, { ry: -a, order: 4 + i * 0.02, dir: radial(a, 0.2), dist: dist * 1.3, edges: true }));
  }
}

// ---------- interstage ----------

// Four shell quarters, twelve stringers in two pieces, bottom and top machined rings, four separation pushers
// in one piece (+ Falcon-style grid fins near the top when the lower stage has them).
function buildInterstage(spec, mats) {
  const g = spec.geom;
  const Rb = g.bottomD_m / 2;
  const Rt = g.topD_m / 2;
  const H = g.H_m;
  const D = Math.min(g.bottomD_m, g.topD_m);
  const rAt = (y) => lerp(Rb, Rt, y / H);
  const ringH = Math.min(0.06 * H, 0.05 * D);
  const shellDist = 0.3 + 0.8 * Math.max(Rb, Rt) * S;
  const out = [];
  // Joint rings: machined ring + bolt circle + three stacked thin tori (the lens-barrel look).
  const ib = Math.max(0.02, 0.006 * D);
  const tor = 0.006 * D;
  // Returns [mesh geometry, line geometry (ring + tori, no bolts)].
  const jointRing = (r, y0, up) => {
    const lines = merge([
      machinedRing(r * 0.97, r * 1.006, ringH, y0),
      ...[0, 1, 2].map((k) => projectUV(new THREE.TorusGeometry(r * 1.002, tor, 4, 48).rotateX(Math.PI / 2).translate(0, up ? y0 + ringH + tor * (1 + 2.4 * k) : y0 - tor * (1 + 2.4 * k), 0))),
    ]);
    return [merge([lines.clone(), boltRing(r * 1.009, y0 + ringH * 0.5, 24, ib, ib, ib * 0.8)]), lines];
  };
  const [lowGeo, lowLines] = jointRing(Rb, 0, true);
  out.push(piece(lowGeo, mats.machined, { order: 0, dir: DOWN, dist: 0.1, ax: ["i", -1, 0], sym: true, edges: true, lineGeo: lowLines }));
  const str = [];
  for (let j = 0; j < 6; j++) {
    const phi = ((j + 0.5) * Math.PI) / 6;
    const out_ = radialPhi(phi);
    const at = (y) => out_.clone().multiplyScalar(rAt(y) - 0.012 * D).setY(y);
    str.push(strut(at(ringH), at(H - ringH), 0.012 * D, 0.016 * D, out_));
  }
  const strHalf = merge(str); // half 1 = half 0 turned by π
  for (let h = 0; h < 2; h++) out.push(piece(strHalf, mats.interior, { ry: h * Math.PI, order: 0.2 + h * 0.02, dir: radialPhi(h * Math.PI + Math.PI / 2), dist: shellDist * 0.6, kind: "interior" }));
  const pushers = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const r = rAt(H) * 0.82;
    pushers.push(cyl(0.035 * D, 0.035 * D, 0.12 * H, 12, r * Math.cos(a), H - ringH - 0.12 * H, r * Math.sin(a)), cyl(0.05 * D, 0.05 * D, 0.02 * H, 12, r * Math.cos(a), H - ringH - 0.12 * H, r * Math.sin(a)));
  }
  out.push(piece(merge(pushers), mats.actuator, { order: 0.4, dir: UP, dist: 0.08, ax: ["i", 1, 1] }));
  const mat = finishMat(mats, g.finish);
  const iq = latheUV(lathe([[rAt(ringH * 0.5), ringH * 0.5], [rAt(H - ringH * 0.5), H - ringH * 0.5]], 24, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H, R: (Rb + Rt) / 2 });
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    out.push(piece(iq, mat, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist, side: DS, kind: "shell", lineGeo: false, fineGeo: iq }));
  }
  const [topGeo, topLines] = jointRing(Rt, H - ringH, false);
  out.push(piece(topGeo, mats.machined, { order: 2, dir: UP, dist: 0.1, ax: ["i", 1, 0], sym: true, edges: true, lineGeo: topLines }));
  if (g.features?.includes("grid-fins")) {
    const yTop = H - ringH - 0.04 * H;
    gridFins(out, mats, rAt(yTop - 0.4 * D), rAt(yTop), yTop, D, shellDist);
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
    out.push(piece(machinedRing(Rt * 0.94, Rt, h, 0), mats.trim, { order: 0, dir: DOWN, dist: 0.12, ax: ["p", -1, 9], sym: true, edges: true }));
    return;
  }
  // Payload attach fitting (cone) + machined clamp band at the payload interface.
  const rb = 0.42 * g.stageD_m;
  const rtop = Math.min(0.62 * Rp, rb);
  out.push(piece(projectUV(lathe([[0.001, 0], [rb, 0], [rtop, h * 0.9], [0.001, h * 0.9]], 48)), mats.metal, { order: 0, dir: DOWN, dist: 0.14, ax: ["p", -1, 9], sym: true, edges: true }));
  const cb = Math.max(0.015, 0.012 * rtop);
  const clampRing = machinedRing(rtop * 0.85, rtop * 1.05, h * 0.1, h * 0.9);
  out.push(piece(merge([clampRing.clone(), boltRing(rtop * 1.06, h * 0.95, 24, cb, cb, cb * 0.8)]), mats.machined, { order: 0.05, dir: DOWN, dist: 0.07, ax: ["p", -1, 8], sym: true, edges: true, lineGeo: clampRing }));
}

function buildPayload(spec, mats) {
  const g = spec.geom;
  const out = [];
  adapterPieces(out, mats, g);
  const y0 = g.adapterH_m;
  const R = g.D_m / 2;
  const H = g.H_m;
  // P(geo, mat, { order, dir, dist, side, ax: [side, rank], sym, kind }) — ax defaults to the core.
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
// Telescope: bus (aft section), tube, aperture door, two solar arrays (with their masts).
function telescope(P, mats, R, H, y0) {
  P(projectUV(cyl(R * 0.97, R * 0.97, 0.36 * H, 12, 0, y0)), mats.mliSilver, { order: 1, dist: 0.2, ax: [-1, 0], sym: true, kind: "shell" });
  const tubeRings = [0.3, 0.55, 0.8, 0.94].map((f) => projectUV(new THREE.TorusGeometry(R * 0.745, 0.006 * R, 4, 32).rotateX(Math.PI / 2).translate(0, y0 + 0.36 * H + f * 0.6 * H, 0)));
  P(projectUV(merge([cyl(R * 0.74, R * 0.74, 0.6 * H, 40, 0, y0 + 0.36 * H), ...tubeRings])), mats.mliSilver, { order: 1.1, dist: 0.35, sym: true, kind: "shell" });
  for (const s of [1, -1]) {
    P(projectUV(merge([box(0.08 * R, 0.5 * H, 0.32 * R, 0, y0 + 0.62 * H, s * 0.86 * R), cyl(0.035 * R, 0.035 * R, 0.4 * H, 8, 0.2 * R, y0 + 0.4 * H, s * 0.86 * R)])), mats.panel, {
      order: 1.2 + (s > 0 ? 0 : 0.02),
      dir: v3(0, 0.3, s),
      dist: 0.4,
    });
  }
  P(projectUV(merge([cyl(R * 0.77, R * 0.77, 0.025 * H, 40, 0, y0 + 0.96 * H), box(0.12 * R, 0.04 * H, 0.2 * R, R * 0.74, y0 + 0.965 * H, 0)])), mats.machined, { order: 1.4, dist: 0.6, ax: [1, 0], edges: true });
}

// Stowed JWST read: spacecraft bus at the base, two folded sunshield pallets, gold mirror wall between,
// secondary-mirror struts folded on top.
function webb(P, mats, R, H, y0) {
  P(projectUV(box(1.1 * R, 0.16 * H, 1.1 * R, 0, y0 + 0.08 * H)), mats.gold, { order: 1, dist: 0.2, ax: [-1, 0] });
  P(projectUV(merge([box(0.95 * R, 0.66 * H, 0.12 * R, 0, y0 + 0.16 * H + 0.33 * H, 0.18 * R), box(0.5 * R, 0.5 * H, 0.4 * R, 0, y0 + 0.16 * H + 0.25 * H, -0.2 * R)])), mats.gold, { order: 1.1, dist: 0.5, edges: true });
  for (const s of [1, -1]) {
    P(projectUV(box(0.14 * R, 0.62 * H, 1.1 * R, s * 0.72 * R, y0 + 0.16 * H + 0.31 * H)), mats.mliSilver, { order: 1.2 + (s > 0 ? 0 : 0.02), dir: v3(s, 0.3, 0), dist: 0.45 });
  }
  P(
    projectUV(merge([cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, -0.3 * R, y0 + 0.82 * H, 0.3 * R), cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, 0.3 * R, y0 + 0.82 * H, 0.3 * R), cyl(0.18 * R, 0.18 * R, 0.02 * H, 24, 0, y0 + 0.96 * H, 0.3 * R)])),
    mats.darkMetal,
    { order: 1.3, dist: 0.7, ax: [1, 0] },
  );
}

// Weather satellite: bus, folded solar array, instrument deck, dish, folded antenna boom (+ base ring).
function weatherSat(P, mats, R, H, y0) {
  const s = 1.25 * R; // square bus inside the envelope (corner at 0.88 R)
  const nozzles = [0, 1, 2, 3].map((k) => lathe([[0.05 * R, 0], [0.025 * R, 0.03 * H], [0.03 * R, 0.035 * H]], 12).translate(0.35 * R * Math.cos((k * TAU) / 4 + Math.PI / 4), y0 + 0.002 * H, 0.35 * R * Math.sin((k * TAU) / 4 + Math.PI / 4)));
  P(projectUV(merge([cyl(0.5 * R, 0.5 * R, 0.08 * H, 32, 0, y0 + 0.035 * H * 0), ...nozzles])), mats.machined, { order: 1, dist: 0.15, ax: [-1, 0], sym: true });
  P(projectUV(box(s, 0.55 * H, s, 0, y0 + 0.08 * H + 0.275 * H)), mats.gold, { order: 1.1, dist: 0.3, kind: "shell" });
  P(projectUV(box(0.07 * R, 0.8 * H, 1.1 * R, 0.66 * R, y0 + 0.1 * H + 0.4 * H)), mats.panel, { order: 1.2, dir: v3(1, 0.3, 0), dist: 0.45 });
  P(projectUV(cyl(0.03 * R, 0.03 * R, 0.7 * H, 8, -0.66 * R, y0 + 0.1 * H)), mats.darkMetal, { order: 1.25, dir: v3(-1, 0.3, 0), dist: 0.4 });
  const aperture = (z, r) => new THREE.CylinderGeometry(r, r, 0.08 * R, 24).rotateX(Math.PI / 2).translate(-0.15 * R, y0 + 0.75 * H, z);
  P(projectUV(merge([box(0.9 * R, 0.25 * H, 0.7 * R, -0.05 * R, y0 + 0.63 * H + 0.125 * H, 0), aperture(0.37 * R, 0.12 * R), aperture(-0.37 * R, 0.08 * R)])), mats.mliSilver, { order: 1.3, dist: 0.5, ax: [1, 0], edges: true });
  const dish = [];
  for (let i = 0; i <= 10; i++) dish.push([0.28 * R * (i / 10), 0.06 * H * (i / 10) ** 2]);
  P(projectUV(lathe(dish, 32).translate(0.3 * R, y0 + 0.9 * H, 0.2 * R)), mats.trim, { order: 1.4, dist: 0.7, side: DS, ax: [1, 1] });
}

// Lander: engine, propellant tank sphere pair (inside the body), hex body, side panels, top deck + dish,
// six legs as two pieces of three.
function lander(P, mats, R, H, y0) {
  const rb = 0.62 * R;
  P(projectUV(lathe([[0.16 * R, 0], [0.08 * R, 0.14 * H], [0.12 * R, 0.16 * H]], 24).translate(0, y0 + 0.12 * H, 0)), mats.darkMetal, { order: 0.9, dist: 0.25, side: DS, ax: [-1, 0], sym: true });
  const ts = 0.26 * R;
  P(merge([new THREE.SphereGeometry(ts, 20, 14).translate(0.3 * R, y0 + 0.5 * H, 0), new THREE.SphereGeometry(ts, 20, 14).translate(-0.3 * R, y0 + 0.5 * H, 0)]), mats.interior, { order: 0.95, dist: 0.15, kind: "interior" });
  P(projectUV(cyl(rb, rb, 0.5 * H, 6, 0, y0 + 0.28 * H)), mats.mliSilver, { order: 1, dist: 0.35, kind: "shell" });
  const faces = [];
  for (let i = 0; i < 3; i++) {
    const a = ((2 * i + 0.5) * TAU) / 6;
    faces.push(box(0.02 * R, 0.4 * H, rb * 0.85, rb * Math.cos(Math.PI / 6) + 0.012 * R, y0 + 0.53 * H, 0).rotateY(-a));
  }
  P(projectUV(merge(faces)), mats.panel, { order: 1.1, dist: 0.4 });
  const dish = [];
  for (let i = 0; i <= 8; i++) dish.push([0.22 * R * (i / 8), 0.05 * H * (i / 8) ** 2]);
  const rcs = [0, 1, 2, 3].map((k) => box(0.08 * R, 0.05 * H, 0.08 * R, 0.36 * R * Math.cos((k * TAU) / 4), y0 + 0.8 * H, 0.36 * R * Math.sin((k * TAU) / 4)));
  P(projectUV(merge([cyl(0.4 * R, 0.45 * R, 0.12 * H, 6, 0, y0 + 0.78 * H), lathe(dish, 24).translate(0.1 * R, y0 + 0.92 * H, 0), ...rcs])), mats.gold, { order: 1.3, dist: 0.6, ax: [1, 0], edges: true });
  for (let half = 0; half < 2; half++) {
    const geos = [];
    for (let i = half * 3; i < half * 3 + 3; i++) {
      const a = ((i + 0.5) * TAU) / 6;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const at = (r, y) => v3(r * R * c, y0 + y * H, r * R * s);
      const knee = at(0.82, 0.2);
      const foot = at(0.94, 0.02);
      geos.push(tube(at(0.55, 0.5), at(0.75, 0.35), knee, 0.025 * R, 10), rod(knee, foot, 0.025 * R), rod(at(0.5, 0.3), knee, 0.02 * R), cyl(0.07 * R, 0.08 * R, 0.02 * H, 16, foot.x, y0, foot.z));
    }
    const mid = ((half * 3 + 1.5) * TAU) / 6;
    P(projectUV(merge(geos)), mats.metal, { order: 1.5 + half * 0.02, dir: radial(mid, 0.2), dist: 0.35, edges: true });
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
  P(projectUV(cyl(dR, dR, yAsc - 0.06 * slaH, 8, 0, y0 + 0.06 * slaH)), mats.gold, { order: 0.9, dist: 0.2, ax: [-1, 2], kind: "interior" });
  P(projectUV(cyl(0.6 * dR, 0.72 * dR, lmTop - yAsc, 6, 0, y0 + yAsc)), mats.mliSilver, { order: 0.95, dist: 0.3, ax: [-1, 1], kind: "interior" });
  const sla = latheUV(lathe([[Rb, y0], [Rs, y0 + slaH]], 16, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H: slaH, R: (Rb + Rs) / 2, y0 });
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    P(sla, mats.silver, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4, 0.4), dist: 0.25 + 0.5 * Rb * S, side: DS, ax: [-1, 3], kind: "shell" });
  }
  const ySm = y0 + slaH;
  P(projectUV(lathe([[0.6 * Rc, 0], [0.3 * Rc, 0.75 * spsH], [0.2 * Rc, spsH]], 32).translate(0, ySm - spsH, 0)), mats.darkMetal, { order: 1.2, dist: 0.45, side: DS, ax: [-1, 0], sym: true, edges: true });
  const quads = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4;
    quads.push(box(0.12 * Rc, 0.1 * smH, 0.2 * Rc, Rc + 0.05 * Rc, ySm + 0.7 * smH, 0).rotateY(-a));
  }
  const jb = Math.max(0.03, 0.012 * Rc);
  P(projectUV(merge([cyl(Rc, Rc, smH, 64, 0, ySm), ...quads])), mats.silver, { order: 1.3, dist: 0.6, kind: "shell" });
  P(merge([boltRing(Rc * 1.01, ySm + jb / 2, 32, jb), boltRing(Rc * 1.01, ySm + smH - jb / 2, 32, jb)]), mats.machined, { order: 1.35, dist: 0.6, sym: true });
  const yCm = ySm + smH;
  const cm = [[Rc, 0], [Rc * 0.98, 0.04 * cmH], [0.24 * Rc, 0.86 * cmH], [0.16 * Rc, 0.95 * cmH], [0.001, cmH]];
  P(projectUV(lathe(cm, 48).translate(0, yCm, 0)), mats.trim, { order: 1.4, dist: 0.8, ax: [1, 0], sym: true, edges: true });
  const lesH = g.lesH_m ?? 0;
  if (lesH > 0) {
    const yL = yCm + cmH * 0.95;
    const tr = dims.les_base_diameter_m ? dims.les_base_diameter_m / 2 : 0.3 * Rc;
    const truss = [];
    for (let i = 0; i < 4; i++) {
      const a = (i * TAU) / 4 + Math.PI / 4;
      const c = (f, y) => v3(f * tr * Math.cos(a), y, f * tr * Math.sin(a));
      truss.push(rod(c(1, yL), c(0.4, yL + 0.4 * lesH), 0.015 * Rc));
    }
    P(projectUV(merge(truss)), mats.darkMetal, { order: 1.5, dist: 1.0, ax: [1, 1] });
    const motor = [[0.13 * Rc, 0], [0.13 * Rc, 0.42 * lesH], [0.07 * Rc, 0.5 * lesH], [0.05 * Rc, 0.56 * lesH], [0.001, 0.6 * lesH]];
    P(projectUV(lathe(motor, 24).translate(0, yL + 0.4 * lesH, 0)), mats.trim, { order: 1.6, dist: 1.1, ax: [1, 2], sym: true, edges: true });
  }
}

// ---------- fairing ----------

// Base cone (boattail when the fairing is wider than the stage, else a short ring), machined separation
// ring, two halves with the ogive nose, one access door on each half.
function buildFairing(spec, mats) {
  const g = spec.geom;
  const Rf = g.D_m / 2;
  const Rb = g.baseD_m / 2;
  const baseH = Math.max(g.boattailH_m, 0.04 * g.D_m);
  const ringH = 0.03 * g.D_m;
  const halfDist = 0.35 + 1.25 * Rf * S;
  const out = [];
  const base = g.boattailH_m > 0 ? [[Rb, 0], [Rf, g.boattailH_m], [Rf, baseH]] : [[Rf, 0], [Rf, baseH]];
  out.push(piece(latheUV(lathe(base, 64), { H: g.H_m, R: Rf }), mats.body, { order: 0, dir: DOWN, dist: 0.1, side: DS, ax: ["f", -1, 1], sym: true, kind: "shell" }));
  const fb = Math.max(0.02, 0.006 * g.D_m);
  const sepRing = machinedRing(Rf * 0.97, Rf * 1.008, ringH, baseH);
  out.push(piece(merge([sepRing.clone(), boltRing(Rf * 1.011, baseH + ringH / 2, 32, fb, fb, fb * 0.8)]), mats.machined, { order: 0.5, dir: DOWN, dist: 0.06, ax: ["f", -1, 0], sym: true, edges: true, lineGeo: sepRing }));
  const pts = [[Rf, baseH + ringH], [Rf, g.cylTop_m], ...ogivePoints(Rf, g.noseH_m, g.cylTop_m)];
  // Half 0 (phi ∈ [0, π], the +X half) and its door; half 1 is the same geometry turned by π.
  const half = latheUV(lathe(pts, 40, 0, Math.PI), { phiStart: 0, phiLength: Math.PI, H: g.H_m, R: Rf });
  const doorH = 0.09 * g.D_m;
  const yDoor = baseH + 0.3 * (g.cylTop_m - baseH);
  const door = projectUV(box(0.012 * g.D_m, doorH, 0.12 * g.D_m, Rf + 0.006 * g.D_m, yDoor + doorH / 2, 0.25 * Rf));
  for (let h = 0; h < 2; h++) {
    const dir = v3(h === 0 ? 1 : -1, 0.12, 0);
    out.push(piece(half, mats.body, { ry: h * Math.PI, order: 1 + h * 0.05, dir, dist: halfDist, side: DS, kind: "shell" }));
    out.push(piece(door, mats.raceway, { ry: h * Math.PI, order: 1.02 + h * 0.05, dir, dist: halfDist }));
  }
  return out;
}

// ---------- parts ----------

const BUILDERS = { engines: buildEngines, tank: buildTank, interstage: buildInterstage, payload: buildPayload, fairing: buildFairing };

// Axial pull-apart (anime.js-lens style). Pieces tagged ax = [group, side, rank] stack away from their group's
// core (side 0 stays) along Y: side +1 above the core, side −1 below, rank 0 nearest; pieces sharing a rank
// form one layer that moves together; layers are separated by `gap`, so nothing overlaps. Groups
// "top"/"bottom" stack beyond everything else in the part. Untagged pieces stay (0).
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
  const placed = pieces.filter((p) => !p.ax || (p.ax[0] !== "top" && p.ax[0] !== "bottom"));
  const [lo, hi] = placed.length ? extent(placed, true) : [0, 0];
  for (const name of ["top", "bottom"]) if (groups.has(name)) stack(groups.get(name), lo, hi);
}

// Spins (radians about Y, 0.5–1.5 turns, alternating sign in arrival order). Off-axis pieces of a part share
// one spin so rings of shells, legs and engine columns rotate rigidly about the stack axis in the exploded
// view (no collisions); axisymmetric pieces get their own. Deterministic per part id.
function assignSpins(pieces, partId) {
  let seed = 0;
  for (const c of partId) seed = (seed * 31 + c.charCodeAt(0)) | 0;
  const turns = (k) => 0.5 + hash2(k, 7, seed);
  let sign = 1;
  let shared = null;
  pieces.forEach((p, i) => {
    if (p.sym) {
      p.spin = sign * turns(i) * TAU;
      sign = -sign;
    } else {
      if (shared === null) {
        shared = sign * turns(-1) * TAU;
        sign = -sign;
      }
      p.spin = shared;
    }
  });
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
      engine: p.engine,
      kind: p.kind,
      bottomY: bb.min.y + p.mesh.position.y,
      topY: bb.max.y + p.mesh.position.y,
      rest: { position: p.mesh.position.clone(), quaternion: p.mesh.quaternion.clone() },
      explode: p.explode,
      ax: p.ax,
      sym: p.sym,
      axisOffset: 0,
      spin: 0,
    };
  });
  axisOffsets(pieces, clamp(0.035 * spec.height, 0.04, 0.3));
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  assignSpins(pieces, spec.id);
  for (const p of pieces) {
    delete p.ax;
    delete p.sym;
  }
  return { ...spec, group, pieces, built: false, busy: false };
}

// Shell pieces of a part, and their opacity (mesh + edge lines together; lines scale with the shell).
export const shellPieces = (part) => part.pieces.filter((p) => p.mesh.userData.kind === "shell");
export function setShellOpacity(part, value) {
  for (const p of shellPieces(part)) {
    const m = p.mesh.material;
    if (!m.transparent) (m.transparent = true), (m.needsUpdate = true);
    m.opacity = clamp(value * (m.userData.opacityScale ?? 1), 0, 1);
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) if (e) e.material.opacity = clamp((e.userData.base * value) / SHELL_OPACITY, 0, 1);
  }
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
