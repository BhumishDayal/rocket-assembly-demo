// Procedural rocket parts, generated from the layout manifest (src/layout.js) at true scale.
// A part is a group at spec.slotY whose local y = 0 is the part's bottom. A part is a mechanical assembly of
// separate pieces (docs/v2-design.md round 8, then the density pass at ~3× the pieces): a sea-level engine =
// 28 (nozzle extension and regen bell with their stiffening rings, exhaust duct, throat, chamber and four
// brackets, gas generator, manifold ring, injector, two main valves, turbopump, pump inlet, feed, high-pressure
// and ignition lines, instrumentation box, two actuators, gimbal block, heat-shield boot; see engineKit), a
// vacuum engine 20; a tank ≈ 56 (skin quarters, stringer sets, three domes, baffles, ring frames, feed and
// pressurisation lines, bottles on brackets, vents, raceway segments, umbilicals, skirt and forward rings, see
// buildTank); an interstage 24, a fairing 16, payloads by archetype (≈ 15–35). Rivet rows, bolt circles, pipe
// clamps and raceway straps are static instanced detail on the pieces (see "instanced fine detail").
// Piece rules: translation-only children (rotation about Y allowed, X/Z rotations baked into the geometry);
// every mesh has its own material clone, mesh.userData.partId = spec.id and mesh.userData.kind
// ("shell" | "interior" | "detail"). Each piece carries (round 7):
//   order       arrival order, bottom-up (clusters: engineIndex + subIndex × 0.01)
//   engine      engine index for engine sub-pieces, else null (also on mesh.userData.engine)
//   explode     { dir, dist } radial opening, scene units, used as rest + dir × dist
//   axisOffset  scene units along +Y in the axial pull-apart view (see axisOffsets)
//   spin        radians about Y carried on arrival/departure (see assignSpins)
//   deploy      null, or an articulated deploy (payload panels/doors/legs/petals, booster legs, grid fins):
//               { axis: unit Vector3, pivot: Vector3, angle: rad, order } in part-local scene units (the frame of
//               rest.position). At deploy fraction k ∈ [0, 1], with R = rotation about axis by k·angle:
//                 mesh.position   = pivot + R · (rest.position − pivot)
//                 mesh.quaternion = R · rest.quaternion
//               Rest poses stay translation-only (+ Y turn); the rotation exists only while deployed.
//               deployables(part) lists them.
//   followers   (round 18) pieces that track a deploying piece instead of having their own hinge: the
//               telescoping leg pistons. They have no `deploy` (not in deployables); applyDeploy(leg, k)
//               poses them from the leg's current pose: piece.follow = { leader, B, L, end } with B a fixed
//               point on the body and L a point on the leader (part-local units, rest), end "B" (the outer
//               tube, pinned at B) or "L" (the rod, pinned at L); both turn to aim along B → L.
//
// Geometry is authored in metres and scaled by SCALE once. Sizes come from the spec (dataset records via
// layout.js). Every other proportion here (bell shape, pump size, leg length, panel layout, ...) is a visual
// ratio for shape only and is never shown on screen as a fact.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SCALE } from "./layout.js";

// Two looks per piece (round 15), switched by setShellOpacity: painted PBR (default, shell value ≥ 0.9: clear-
// coated paint with micro-roughness, soot near the base, brushed bare-metal bells, black composite with a weave
// normal, edge lines at 0.15) and the round-10 x-ray look (docs/v2-design.md §5, below 0.9: dark see-through
// graphite shells with a peach fresnel rim, opaque steel internals, peach edge lines). ?look=classic shows the
// round-9 painted look with no switching.
const XRAY = !(typeof location !== "undefined" && /[?&]look=classic(&|$)/.test(location.search ?? ""));
export const LOOK = XRAY ? "xray" : "classic";
const PEACH = 0xffb48a;
const SHELL_OPACITY = 0.55; // built; choreo sets 0.30 exploded, 0.15 selected through setShellOpacity
const LINE_STRUCT = 0.55; // rings, flanges, bell lips, fins, legs, shell rims and seams
const LINE_FINE = 0.2; // weld lands, raceway clamps, shell panel seams
const LINE_INTERIOR = 0.3; // internals seen through the shells (domes, baffles, bottles)
const PAINT_AT = 0.9; // setShellOpacity at or above this shows the painted look
const LINE_PAINT = 0.15; // structural edge lines over paint (others scale by the same factor)

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

// The roll pattern's black areas on normalized shell UVs (u around, v along): alternating eighths on the lower
// part and a counter-phased band at the top. Shared by the textures and the rivet layout (no rivets on black).
const rollBlack = (u, v) => {
  const sector = Math.floor(u * 8);
  return (v < 0.3 && sector % 2 === 0) || (v > 0.93 && sector % 2 === 1);
};

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
        // Blanket seams every 0.6 m (two per tile each way): a sewn, taped groove, a little more matte.
        const d = (t) => Math.min(t % 0.5, 0.5 - (t % 0.5)) / 0.5;
        const seam = Math.max(Math.exp(-((d(u) / 0.02) ** 2)), Math.exp(-((d(v) / 0.02) ** 2)));
        return [ridged ** 2 * (1 - 0.85 * seam), 0.55 + 0.45 * fbm(u, v, 4, 7) + 0.25 * seam, 1];
      },
      { tile_m: 1.2 },
    ),
    // Octaweb heat-shield "dance floor": 0.5 m plates with grooves and corner bolts, a shade per plate
    // (colour, sRGB; R doubles as bump). 1 m tile on uv (metres).
    plates: dataTexture(
      W,
      W,
      (u, v) => {
        const cu = (u * 2) % 1;
        const cv = (v * 2) % 1;
        const groove = Math.min(cu, 1 - cu, cv, 1 - cv) < 0.015 ? 1 : 0;
        const bolt = [0.06, 0.94].some((x) => [0.06, 0.94].some((y) => Math.hypot(cu - x, cv - y) < 0.02)) ? 1 : 0;
        const shade = 0.82 + 0.18 * hash2(Math.floor(u * 2), Math.floor(v * 2), 31) + 0.06 * (fbm(u, v, 8, 33, 3) - 0.5);
        const k = groove ? 0.35 : bolt ? 1.0 : shade;
        return [k, k, k];
      },
      { srgb: true, tile_m: 1 },
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
      (u, v) => (rollBlack(u, v) ? [0.06, 0.06, 0.065] : [0.92, 0.92, 0.9]),
      { srgb: true },
    ),
    // Alpha for the roll pattern on x-ray shells: black bands opaque, the rest at the shell opacity (G channel).
    rollAlpha: dataTexture(W, 512, (u, v) => (rollBlack(u, v) ? [1, 1, 1] : [SHELL_OPACITY, SHELL_OPACITY, SHELL_OPACITY])),
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
    // Paint skin, 4 m tile on uv1: the seams map's welds and panel seam (R bump) plus micro-roughness noise in G
    // so highlights break up across the clear coat.
    paint: dataTexture(
      W,
      W,
      (u, v) => {
        const n = fbm(u, v, 4, 11);
        const micro = fbm(u, v, 24, 5, 3);
        const weld = Math.exp(-(((v - 0.5) / (1.6 * px)) ** 2));
        const seam = Math.exp(-(((u - 0.5) / (1.0 * px)) ** 2));
        return [0.5 + 0.22 * weld - 0.25 * seam, 0.9 + (micro - 0.5) * 0.22 + (n - 0.5) * 0.12 - 0.12 * weld, 1];
      },
      { channel: 1, tile_m: 4 },
    ),
    // Brushed metal: fine streaks along v (roughness in G), for the bare-metal bells; uv.x counts cooling tubes.
    brushed: (() => {
      const tex = dataTexture(256, 8, (u) => {
        const n = 0.6 * vnoise(u, 0, 128, 61) + 0.4 * vnoise(u, 0, 32, 62);
        return [0.5, 0.7 + 0.5 * (n - 0.5), 1];
      });
      tex.repeat.set(1 / 12, 1);
      return tex;
    })(),
    // Carbon composite twill as a normal map (from the weave height below), 0.5 m tile on uv1.
    weaveN: (() => {
      const h = (u, v) => {
        const cu = Math.floor(u * 16);
        const cv = Math.floor(v * 16);
        const alongU = (((cu + cv) % 4) + 4) % 4 < 2;
        const f = alongU ? (((v * 16) % 1) + 1) % 1 : (((u * 16) % 1) + 1) % 1;
        return 0.5 + 0.3 * Math.sin(f * Math.PI);
      };
      const e = 1 / 128;
      return dataTexture(
        128,
        128,
        (u, v) => {
          const dx = (h(u + e, v) - h(u - e, v)) * 1.6;
          const dy = (h(u, v + e) - h(u, v - e)) * 1.6;
          const l = Math.hypot(dx, dy, 1);
          return [(-dx / l) * 0.5 + 0.5, (-dy / l) * 0.5 + 0.5, (1 / l) * 0.5 + 0.5];
        },
        { channel: 1, tile_m: 0.5 },
      );
    })(),
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
    // Gold-coated mirror segments (smooth, unlike the crinkled blankets).
    mirror: std({ color: 0xd9ad55, metalness: 1, roughness: 0.12 }),
    // Ablative composite nozzle (visuals.engines[id].bellFinish "ablative"): tan, matte.
    ablative: std({ color: 0xc9b597, metalness: 0, roughness: 0.9 }),
    // Two-tone foil blankets (gold / black / silver per vertex colour), e.g. the LM descent stage.
    foil: std({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: 0.34, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }),
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
  // Role names travel with the materials into piece() (mesh.userData.role): the bells are found by role.
  const tag = (set) => {
    for (const k of Object.keys(set)) if (!Object.hasOwn(set[k], "role")) Object.defineProperty(set[k], "role", { value: k });
  };
  if (!XRAY) return tag(classic), classic;
  const x = xrayMaterials(t, classic);
  const paint = paintedMaterials(t, classic);
  // Each role gets its own x-ray object (the x-ray set shares a few) carrying its painted twin; piece() reads
  // material.painted and keeps both on the mesh (setShellOpacity switches).
  const seen = new Set();
  for (const k of Object.keys(x)) {
    let m = x[k];
    if (seen.has(m)) {
      const c = cloneMat(m);
      if (m.asShell) Object.defineProperty(c, "asShell", { value: m.asShell });
      m = x[k] = c;
    }
    seen.add(m);
    if (paint[k]) Object.defineProperty(m, "painted", { value: paint[k], configurable: true });
  }
  tag(x);
  return x;
}

// Soot: darkens paint toward the part's base in uneven vertical streaks, and dulls its roughness and clear
// coat. Per material: material.soot = { value: Vector4(y0, height, strength, 0) } in mesh-local units: full
// strength at y0, gone by y0 + height
// (set by createPart; strength 0 = clean). The streak pattern runs on the mesh-local azimuth.
//
// Frost (same hook): a matte blue-white layer over cryogenic tank skin above an edge at mesh-local y, the edge
// wavering with 3D noise and drifting slowly in time; patchy inside. material.frost = { value: Vector4(edgeY,
// waver, amount, softness) } (amount 0 = none). The time uniform is shared and set before each frosted draw.
// Instanced detail on a shell (its rivets) takes the same hook with its host's uniforms (see createPart), so the
// rivets soot and frost with the skin they sit on.
const frostTime = { value: 0 };
const tickFrost = () => (frostTime.value = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);
function sootHook(shader) {
  shader.uniforms.uSoot = this.soot ?? (this.soot = { value: new THREE.Vector4(0, 1, 0, 0) });
  shader.uniforms.uFrost = this.frost ?? (this.frost = { value: new THREE.Vector4(0, 0, 0, 1) });
  shader.uniforms.uFrostT = frostTime;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vSoot;\nvarying vec3 vSootP;")
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vec3 sootP = position;
      #ifdef USE_INSTANCING
        sootP = (instanceMatrix * vec4(position, 1.0)).xyz; // instanced detail: in its host piece's frame
      #endif
      vSoot = vec2(sootP.y, atan(sootP.x, sootP.z));
      vSootP = sootP;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      varying vec2 vSoot;
      varying vec3 vSootP;
      uniform vec4 uSoot, uFrost;
      uniform float uFrostT;
      float frostH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float frostN(vec3 p) {
        vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(frostH(i), frostH(i + vec3(1, 0, 0)), f.x), mix(frostH(i + vec3(0, 1, 0)), frostH(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(frostH(i + vec3(0, 0, 1)), frostH(i + vec3(1, 0, 1)), f.x), mix(frostH(i + vec3(0, 1, 1)), frostH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }`,
    )
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      float sootStreak = 0.5 + 0.25 * sin(vSoot.y * 23.0 + 1.7 * sin(vSoot.y * 7.0)) + 0.25 * sin(vSoot.y * 61.0 + 0.4);
      float sootG = 1.0 - smoothstep(uSoot.x, uSoot.x + uSoot.y * (0.55 + 0.9 * sootStreak), vSoot.x);
      float soot = uSoot.z * sootG * (2.0 - sootG);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.032, 0.03), soot);
      float frost = 0.0;
      if (uFrost.z > 0.0) {
        vec3 fp = vSootP * 4.0 + vec3(0.0, 0.0, uFrostT * 0.02);
        float edge = uFrost.x + uFrost.y * (frostN(fp) + 0.5 * frostN(fp * 2.7) - 0.75);
        float fine = 0.6 * frostN(vSootP * 9.0) + 0.4 * frostN(vSootP * 25.0);
        frost = uFrost.z * smoothstep(edge - uFrost.w, edge + uFrost.w, vSoot.x) * (0.65 + 0.35 * frostN(vSootP * 5.0 + 3.1)) * (1.0 - soot);
        float wet = uFrost.z * exp(-pow((vSoot.x - edge + 2.5 * uFrost.w) / uFrost.w, 2.0)); // condensation under the line
        diffuseColor.rgb *= 1.0 - 0.14 * wet;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.81, 0.9) * (0.74 + 0.3 * fine), frost);
      }`,
    )
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.85, soot), 0.92, frost);")
    .replace(
      "#include <lights_physical_fragment>",
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
        material.clearcoat *= (1.0 - 0.8 * soot) * (1.0 - frost);
      #endif`,
    );
}
const sootKey = () => "paint-soot-frost-v4";

// Bell glow: an emissive ramp on the nozzle while it fires, orange at the lip to dull red at the throat, the
// inside (back faces) brightest. Chained after any hook the material already has (the x-ray shell's rim).
// material.glow = { value: Vector4(lipY, throatY, intensity, 0) } in mesh-local units, shared by both looks.
const GLOW_LIP = new THREE.Color(1.0, 0.42, 0.1);
const GLOW_THROAT = new THREE.Color(0.6, 0.07, 0.02);
function addBellGlow(m, glow) {
  const prev = m.onBeforeCompile;
  const prevKey = prev === THREE.Material.prototype.onBeforeCompile ? "" : m.customProgramCacheKey();
  m.glow = glow;
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uGlow = this.glow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vGlowY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlowY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlowY;\nuniform vec4 uGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (uGlow.z > 0.0) {
          float glowT = clamp((vGlowY - uGlow.x) / max(uGlow.y - uGlow.x, 1e-5), 0.0, 1.0);
          vec3 glowC = mix(vec3(${GLOW_LIP.toArray().map((v) => v.toFixed(3))}), vec3(${GLOW_THROAT.toArray().map((v) => v.toFixed(3))}), glowT);
          totalEmissiveRadiance += glowC * uGlow.z * (gl_FrontFacing ? 0.35 : 1.0) * 1.6;
        }`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey}|bell-glow-v1`;
}
const BELL_ROLES = new Set(["engine", "ablative"]);
// Bell glow for a part's engines: throttle 0..1 (clamped), every engine or only engine index `engine`
// (piece.engine, e.g. plume.engine from attachPlumes). Drive it with the plume updates; 0 = cold metal.
export function setBellGlow(part, throttle = 0, engine = null) {
  const v = Math.min(1, Math.max(0, Number(throttle) || 0));
  for (const p of part.pieces) {
    const g = p.mesh.userData.bellGlow;
    if (g && (engine === null || p.engine === engine)) g.value.z = v;
  }
}

// Painted PBR twins of every role (round 15). Paint: MeshPhysicalMaterial, clear coat 0.4, roughness 0.35-0.5
// broken up by the paint map's micro-roughness, soot near the base (sootHook). Bells: brushed bare metal with an
// anisotropic highlight. Composite: black with a weave normal. Metals and blankets keep their classic look.
// polygonOffset on all, so the faint edge lines sit cleanly on them. Colours are visual.
function paintedMaterials(t, classic) {
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const phys = (o) => new THREE.MeshPhysicalMaterial({ metalness: 0, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.22, fog: true, ...po, ...o });
  const sooty = (m) => {
    m.onBeforeCompile = sootHook;
    m.customProgramCacheKey = sootKey;
    m.userData.soot = true;
    return m;
  };
  const paint = (color, extra = {}) => phys({ color, roughnessMap: t.paint, bumpMap: t.paint, bumpScale: 1.0, ...extra });
  const composite = () => phys({ color: 0x15161a, metalness: 0.2, roughness: 0.38, roughnessMap: t.weave, normalMap: t.weaveN, normalScale: new THREE.Vector2(0.7, 0.7), clearcoat: 0.5, clearcoatRoughness: 0.18 });
  const keep = (m) => {
    const c = cloneMat(m);
    Object.assign(c, po);
    return c;
  };
  const white = sooty(paint(0xe9eae6));
  return {
    body: white,
    roll: sooty(paint(0xe9e9e5, { map: t.roll })),
    foam: sooty(phys({ color: 0xffffff, map: t.foam, bumpMap: t.foam, bumpScale: 1.6, roughness: 0.82, clearcoat: 0.05 })),
    bronze: sooty(paint(0xa65f35, { metalness: 0.15, roughness: 0.45 })),
    silver: sooty(paint(0xb9bdc2, { metalness: 0.7, roughness: 0.35 })),
    composite: sooty(composite()),
    // Octaweb heat shield: dark plates with grooves and bolts (the "dance floor").
    heatShield: phys({ color: 0x3a3b3e, metalness: 0.35, roughness: 0.72, map: t.plates, bumpMap: t.plates, bumpScale: 1.2, clearcoat: 0 }),
    raceway: paint(0xc4c6c1),
    skirt: keep(classic.skirt),
    metal: keep(classic.metal),
    darkMetal: keep(classic.darkMetal),
    interior: keep(classic.interior),
    steelDark: keep(classic.darkMetal),
    trim: paint(0xe9eae6),
    leg: composite(),
    copv: composite(),
    machined: keep(classic.machined),
    // Bare-metal bell: vertex colours (heat tint, flanges) lifted to read as metal, brushed streaks, tube ridges.
    // (vertex colours × 1.25: dark brushed metal; brighter read as chrome and blew out under bloom)
    engine: phys({ color: new THREE.Color(1.25, 1.25, 1.25), vertexColors: true, metalness: 1, roughness: 0.42, roughnessMap: t.brushed, bumpMap: t.ridges, bumpScale: 0.25, anisotropy: 0.55, anisotropyRotation: Math.PI / 2, clearcoat: 0, envMapIntensity: 0.9 }),
    chamber: keep(classic.chamber),
    powerhead: keep(classic.powerhead),
    valve: keep(classic.valve),
    pump: keep(classic.pump),
    pipe: keep(classic.pipe),
    actuator: keep(classic.actuator),
    gimbal: keep(classic.gimbal),
    // Cast titanium grid fins: grey metal, rough, a faint warm heat tint.
    gridFin: phys({ color: 0x8a8580, metalness: 0.85, roughness: 0.52, roughnessMap: t.paint, clearcoat: 0 }),
    gold: keep(classic.gold),
    mliSilver: keep(classic.mliSilver),
    foil: keep(classic.foil),
    mirror: phys({ color: 0xe0b45a, metalness: 1, roughness: 0.08, clearcoat: 0 }),
    ablative: phys({ color: 0xcdb99b, metalness: 0, roughness: 0.88, roughnessMap: t.paint, clearcoat: 0 }),
    panel: keep(classic.panel),
    accent: keep(classic.accent),
    dark: keep(classic.dark),
  };
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
    foil: asShell(steel(0xffffff, 0.34, 1, { vertexColors: true, bumpMap: t.crinkle, bumpScale: 2.2, roughnessMap: t.crinkle }), sh.gold),
    mirror: steel(0xd9ad55, 0.15, 1),
    ablative: asShell(steel(0xc9b597, 0.85, 0.05), sh.white),
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
// Peach technical line material (fog on, depth fade): the edge lines here and the line-art in anchors.js.
export function peachLineMaterial(opacity = LINE_STRUCT) {
  lineBase ??= new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: LINE_STRUCT, depthTest: true, fog: true });
  const m = lineBase.clone();
  m.onBeforeCompile = lineDepthAlpha; // set per clone: Material.copy drops shader hooks
  m.customProgramCacheKey = lineDepthKey;
  m.opacity = opacity;
  return m;
}
function lineChild(mesh, geo, base, name) {
  let eg = edgeCache.get(geo);
  if (!eg) edgeCache.set(geo, (eg = new THREE.EdgesGeometry(geo, 25)));
  const m = peachLineMaterial(base);
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

// Material clone that keeps a shader hook (Material.copy drops onBeforeCompile / customProgramCacheKey).
function cloneMat(src) {
  const m = src.clone();
  if (src.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) {
    m.onBeforeCompile = src.onBeforeCompile;
    m.customProgramCacheKey = src.customProgramCacheKey;
  }
  return m;
}

const scaled = new WeakSet();
const probeOf = new WeakMap(); // lander leg mesh → its contact-probe geometry (drawn on the landerOf copy only)
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
function piece(geo, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, dir = UP, dist = 0.4, side, ax = null, sym = false, kind = "detail", engine = null, edges = kind === "shell", lineGeo = null, fineGeo = null, deploy = null, follow = null, lander = null, landerLeg = null, dock = false, probe = null } = {}) {
  const g = toUnits(geo);
  g.computeBoundingBox();
  const xrayShell = XRAY && kind === "shell";
  const src = xrayShell && material.asShell ? material.asShell : material;
  const mat = cloneMat(src);
  if (side !== undefined && !xrayShell) mat.side = side; // x-ray shells stay front-side
  // Painted twin (default look); both live on the mesh and setShellOpacity switches between them.
  const painted = XRAY && material.painted ? cloneMat(material.painted) : null;
  if (painted && side !== undefined) painted.side = side;
  const mesh = new THREE.Mesh(g, painted ?? mat);
  mesh.userData.role = material.role ?? null;
  if (painted) {
    mesh.userData.looks = { xray: mat, painted };
    for (const m of [mat, painted]) if (m.emissive) m.userData.emissive0 = [m.emissive.getHex(), m.emissiveIntensity];
  }
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
  // deploy is given in the geometry's own frame (metres, before the Y turn); store it part-local.
  const hingeOf = (h) => {
    if (!h) return null;
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, ry);
    return {
      axis: h.axis.clone().normalize().applyQuaternion(qy),
      pivot: h.pivot.clone().multiplyScalar(S).applyQuaternion(qy).add(mesh.position),
      angle: h.angle,
      order: h.order ?? 0,
    };
  };
  const dep = hingeOf(deploy);
  // Landable sub-part (landerOf): lander = "descent" | "ascent" | "leg"; a leg's hinge is landerLeg, kept out of
  // `deploy` so the payload's own deploy (the SLA petals) does not swing it; dock marks the docking apex.
  if (lander) mesh.userData.lander = lander;
  if (probe) probeOf.set(mesh, toUnits(probe));
  if (dock) mesh.userData.dock = true;
  // follow points are given like the deploy pivot (metres, the geometry's own frame).
  let fol = null;
  if (follow) {
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, ry);
    const toPart = (p) => p.clone().multiplyScalar(S).applyQuaternion(qy).add(mesh.position);
    fol = { leader: follow.leader, B: toPart(follow.B), L: toPart(follow.L), end: follow.end };
  }
  return { mesh, order, explode: { dir: dir.clone().normalize(), dist }, ax, sym, kind, engine, deploy: dep, follow: fol, landerLeg: hingeOf(landerLeg) };
}

// ---------- instanced fine detail ----------

// Static fine detail at no animation cost (density pass): rivet rows along seams, bolt circles on flanges,
// pipe clamps and raceway straps. One InstancedMesh per detail type per piece, a child of the piece's mesh, so
// it moves with the piece. Transforms are authored in metres in the piece geometry's own frame and stored in
// scene units (shared by every piece of the same shape, e.g. the engines of a cluster). The unit geometries
// are shared module-wide; a part's detail meshes share one painted and one x-ray material per detail type and
// colour (userData.looks, switched by setShellOpacity like the pieces; both MeshStandardMaterial with the same
// features, so the switch compiles nothing), so they draw back to back without material changes (nothing
// animates detail materials; pieces keep their own clones). On a shell piece the detail shows in the painted look only (userData.lookOnly "painted"): an
// x-ray shell is see-through and would leave it floating. No shadows, no edge lines, never picked
// (userData.nonPickable, raycast no-op); it is not a piece, so deploys, explode layouts and the line budget
// ignore it (check-budget counts each InstancedMesh as one mesh). mesh.userData.details lists them.
const DETAIL = {
  bolt: { painted: { color: 0x8c9199, metalness: 0.9, roughness: 0.32 }, xray: { color: 0xa3a9b2, metalness: 0.85, roughness: 0.3 } },
  rivet: { painted: { color: 0xb6b8b4, metalness: 0.45, roughness: 0.42 }, xray: { color: 0x5a5f68, metalness: 0.8, roughness: 0.4 } },
  clamp: { painted: { color: 0x767b83, metalness: 0.85, roughness: 0.4 }, xray: { color: 0xb4bac3, metalness: 0.7, roughness: 0.35 } },
  strap: { painted: { color: 0xa3a5a1, metalness: 0.5, roughness: 0.48 }, xray: { color: 0x5a5f68, metalness: 0.8, roughness: 0.4 } },
};
let detailGeos = null;
const detailGeo = (type) =>
  (detailGeos ??= {
    bolt: new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0), // hex head, unit across, base on y = 0, axis +Y
    rivet: lathe([[0.5, 0], [0.42, 0.16], [0.26, 0.28], [0, 0.32]], 6), // domed head, unit across
    clamp: new THREE.TorusGeometry(1, 0.22, 4, 10).rotateX(Math.PI / 2), // band round +Y, unit radius
    strap: new THREE.BoxGeometry(1, 1, 1), // centred unit box
  })[type];

// One instance (metres in, scene units out): the unit detail at p with its +Y turned onto n, scaled along its
// own axes, turned by `twist` about n.
const xfQ = new THREE.Quaternion();
const xfT = new THREE.Quaternion();
const xfN = new THREE.Vector3();
function xf(p, n, sx, sy = sx, sz = sx, twist = 0) {
  xfQ.setFromUnitVectors(UP, xfN.copy(n).normalize());
  if (twist) xfQ.multiply(xfT.setFromAxisAngle(UP, twist));
  return new THREE.Matrix4().compose(p.clone().multiplyScalar(S), xfQ, new THREE.Vector3(sx * S, sy * S, sz * S));
}
function instAttr(list) {
  const a = new Float32Array(list.length * 16);
  list.forEach((m, i) => m.toArray(a, i * 16));
  return new THREE.InstancedBufferAttribute(a, 16);
}
// Bolt heads on a circle of radius r at height y round (cx, cz): on a flange face (face "up" / "down") or
// standing out of a band (face "out"). size: across flats; h: head height.
function boltCircle(r, y, n, size, { face = "up", h = 0.6 * size, phase = 0, cx = 0, cz = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const phi = phase + ((i + 0.5) / n) * TAU;
    const o = radialPhi(phi);
    out.push(xf(v3(cx + o.x * r, y, cz + o.z * r), face === "up" ? UP : face === "down" ? DOWN : o, size, h, size, phi));
  }
  return out;
}
// Rivet heads from a to b at about `pitch` apart, on a surface facing radially out from the Y axis.
function rivetRow(a, b, pitch, size) {
  const n = Math.max(2, Math.round(a.distanceTo(b) / pitch) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = a.clone().lerp(b, i / (n - 1));
    out.push(xf(p, v3(p.x, 0, p.z), size));
  }
  return out;
}
// Rivet heads round an arc of radius r at height y, lathe azimuth phi0 → phi1.
function rivetArc(r, y, phi0, phi1, pitch, size) {
  const n = Math.max(2, Math.round((r * Math.abs(phi1 - phi0)) / pitch) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = radialPhi(lerp(phi0, phi1, i / (n - 1)));
    out.push(xf(o.clone().multiplyScalar(r).setY(y), o, size));
  }
  return out;
}
// Pipe clamps: a band round a pipe of radius r at n points of a curve, between t0 and t1.
function clampsAlong(curve, r, n, t0 = 0.18, t1 = 0.82) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? (t0 + t1) / 2 : lerp(t0, t1, i / (n - 1));
    out.push(xf(curve.getPoint(t), curve.getTangent(t), 1.25 * r, 0.9 * r, 1.25 * r));
  }
  return out;
}
// Adds one InstancedMesh of `type` to a piece; list = Matrix4[] (from the helpers above) or a shared
// InstancedBufferAttribute. color overrides the painted colour (rivets take their host's paint).
let detailMats = null; // while createPart builds a part: `${type}|${color}` → { painted, xray }
function addDetail(pc, type, list, { lookOnly = null, color = null } = {}) {
  const attr = list?.isInstancedBufferAttribute ? list : instAttr(list ?? []);
  if (!attr.count) return null;
  const spec = DETAIL[type];
  const mk = (o) => new THREE.MeshStandardMaterial({ fog: true, ...o });
  const key = `${type}|${color}`;
  let pair = detailMats?.get(key);
  if (!pair) {
    pair = { painted: mk(color === null ? spec.painted : { ...spec.painted, color }), xray: XRAY ? mk(spec.xray) : null };
    detailMats?.set(key, pair);
  }
  const { painted, xray } = pair;
  const inst = new THREE.InstancedMesh(detailGeo(type), painted, attr.count);
  inst.instanceMatrix = attr;
  inst.castShadow = inst.receiveShadow = false;
  inst.raycast = () => {};
  Object.assign(inst.userData, { kind: "detail", detail: type, nonPickable: true });
  if (xray) inst.userData.looks = { painted, xray };
  if (lookOnly) inst.userData.lookOnly = lookOnly;
  pc.mesh.add(inst);
  (pc.mesh.userData.details ??= []).push(inst);
  return inst;
}
// Rivets take their host's paint, a shade darker on light finishes and lighter on dark ones, so they read as
// texture up close and vanish at a distance.
function rivetTint(mesh) {
  const c = (mesh.userData.looks?.painted ?? mesh.material).color?.clone() ?? new THREE.Color(0xd0d0d0);
  return (c.getHSL({}).l > 0.35 ? c.multiplyScalar(0.8) : c.multiplyScalar(1.7).addScalar(0.04)).getHex();
}
const rivetsOn = (finish) => finish !== "orange-foam"; // sprayed foam shows no rivets
// Drops rivets that would sit on the roll pattern's black areas (they take the white paint's tint). For quarter
// shells whose UVs span u = phi / 2π over [0, π/2] and v = y / H; the rivets' piece-local azimuth folds into it.
function offRoll(list, H) {
  const q = Math.PI / 2;
  return list.filter((m) => {
    const [x, y, z] = [m.elements[12] / S, m.elements[13] / S, m.elements[14] / S];
    const phi = ((Math.atan2(x, z) % q) + q) % q;
    return !rollBlack(phi / TAU, y / H);
  });
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

// Bell exit radius (m) and twin-bell offset: diameter_m is the exit diameter, except "overall" envelopes
// (bell drawn at a visual 84 % of it) and twins (two bells side by side inside the envelope).
function bellGeometry(exitD_m, chambers = 1, overall = false) {
  const twin = chambers > 1;
  const Re = twin ? exitD_m / 4 / 1.03 : overall ? exitD_m * 0.42 : exitD_m / 2;
  return { Re, off: twin ? Re * 1.03 : 0, twin };
}

// Bell exits of an engines part in part-local scene units (exit plane y = 0): [{ engine, x, z, r }], two per
// engine on twin-chamber engines. Used by plume.js to put one plume under every bell.
export function bellExits(spec) {
  const g = spec?.geom;
  if (spec?.kind !== "engines" || !g) return [];
  const { Re, off, twin } = bellGeometry(g.exitD_m, g.chambers, g.diameterKind === "overall");
  const out = [];
  g.positions.forEach((p, i) => {
    const ry = p.r > 0 ? -p.a - Math.PI / 2 : 0; // same turn as the engine's pieces (buildEngines)
    for (const z of twin ? [-off, off] : [0]) out.push({ engine: i, x: (p.x + z * Math.sin(ry)) * S, z: (p.z + z * Math.cos(ry)) * S, r: Re * S });
  });
  return out;
}

// One engine's sub-assemblies, each its own geometry in engine-local metres (exit plane y=0, gimbal top y=L,
// turbopump on local +X, gas generator on −X, valves on −Z). Shared by every engine of the same shape.
//   sea-level (27 here + the heat-shield boot buildEngines adds per engine = 28): nozzle extension and its
//     stiffening ring, regen bell and its stiffening ring, turbine exhaust duct, throat, chamber, 4 chamber
//     brackets, gas generator, injector manifold ring, injector dome, main fuel and main LOX valves, turbopump
//     housing, pump inlet, 2 feed lines, 2 high-pressure lines, ignition line, instrumentation box, 2 gimbal
//     actuators, gimbal block
//   vacuum (20): long nozzle extension with 2 stiffening rings, regen bell, exhaust duct, throat, chamber,
//     2 brackets, manifold ring, injector dome, main valve, turbopump, pump inlet, 2 feed lines, 1 high-pressure
//     line, 2 actuators, gimbal block
//   twin (chambers = 2, RD-180 style): the chamber stack (extension, 2 rings, regen bell, throat, chamber,
//     manifold ring, injector) twice inside the record's envelope around one set of shared turbomachinery and
//     plumbing, without brackets, ignition line or instrumentation box (29 + boot, so even nine stay under
//     300 pieces a cluster)
// Lens view (ax = [side, rank] round the chamber core): below it the throat, the regen bell with the exhaust
// duct, the upper ring, the extension, the lower ring; above it the manifold ring, the injector dome, the
// valves, the turbopump, the plumbing (inlet, feed, high-pressure and ignition lines), the actuators with the
// instrumentation box, the gimbal block; brackets and gas generator stay with the chamber.
// Instanced detail (shared transforms): bolt circles on the manifold ring, pump and inlet flanges, clamps on
// the feed lines.
// Entry: { geo, mat, ax, sym, ds (double-sided), kind, edges, details: [{ type, attr }] }.
const kitCache = new Map();
// extFrac: a sourced nozzle extension (visuals.engines[id].extension.startRadiusFraction): the bell splits
// where its radius reaches extFrac × the exit radius, and the extension below is a smooth film-cooled shell
// (no tubes, darker steel), as on the F-1.
function engineKit({ exitD_m, L, vacuum, chambers = 1, overall = false, extFrac = 0 }) {
  const key = [exitD_m, L, vacuum, chambers, overall, extFrac].join("|");
  if (kitCache.has(key)) return kitCache.get(key);
  const { Re, off, twin } = bellGeometry(exitD_m, chambers, overall);
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
  const yJ = bellL + convL; // throat section → chamber joint
  const zs = twin ? [-off, off] : [0];
  const kit = [];
  const add = (geo, mat, ax, o = {}) => kit.push({ geo, mat, ax, ...o });
  const det = (type, list) => ({ type, attr: instAttr(list) });

  // Bell split into the nozzle extension (lower) and the regeneratively cooled bell (upper), joined by a
  // bolted flange; a stiffener lip at the exit. Dark steel (darker niobium-like extension on vacuum engines),
  // faint warm tint toward the throat, lighter machined flanges. uv.x repeats the one-ridge texture.
  // the first point down the bell (from the throat) where r ≥ extFrac · Re; radius falls with height
  const bisect = (target) => {
    let lo = 0;
    let hi = bellL;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rAtBell(mid) >= target) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const filmCooled = extFrac > 0 && extFrac < 1;
  const ySplit = filmCooled ? bisect(extFrac * Re) : (vacuum ? 0.62 : 0.5) * bellL;
  const rs = rAtBell(ySplit);
  const fl = 0.012 * L;
  const ext = [[Re * 1.025, 0.014 * L], [Re * 1.025, 0], ...prof.bell.filter((p) => p[1] > 0 && p[1] < ySplit), [rs, ySplit], [rs * 1.07, ySplit], [rs * 1.07, ySplit - fl]];
  const regen = [[rs * 1.07, ySplit], [rs * 1.07, ySplit + fl], [rAtBell(ySplit + fl), ySplit + fl], ...prof.bell.filter((p) => p[1] > ySplit + fl)];
  const steel = vacuum ? [0.13, 0.112, 0.095] : filmCooled ? [0.1, 0.1, 0.108] : [0.15, 0.15, 0.16]; // vacuum: niobium bronze-grey; film-cooled: darker stainless
  const regenBase = [0.15, 0.15, 0.16];
  const heat = [0.4, 0.25, 0.15];
  const flange = [0.48, 0.48, 0.5];
  const RIDGES = vacuum ? 72 : 48;
  const ridgeUV = (g) => {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * RIDGES);
    return g;
  };
  // Stiffening "hat band" hugging the bell at height yc: a closed, chamfered lathe ring with a centre bead.
  const hatH = 0.024 * L;
  const hat = (yc, z) => {
    const t = 0.022 * Re;
    const e = 0.004 * Re;
    const yb = yc - hatH / 2;
    const yt = yc + hatH / 2;
    const [rb, rm, rT] = [rAtBell(yb), rAtBell(yc), rAtBell(yt)];
    const pts = [[rT + e, yt], [rb + e, yb], [rb + t, yb], [rm + 1.35 * t, yc - 0.15 * hatH], [rm + 1.35 * t, yc + 0.15 * hatH], [rT + t, yt], [rT + e, yt]];
    return latheUV(lathe(pts, 48), { H: hatH, R: rm, y0: yb }).translate(0, 0, z);
  };
  // the lower ring on the extension (clear of the exit lip and the flange), the upper one on the regen bell
  // (sea level) or higher on the long vacuum extension
  const yLo = clamp((vacuum ? 0.3 : 0.45) * ySplit, 0.03 * L + hatH, ySplit - fl - hatH);
  const yHi = vacuum ? clamp(0.68 * ySplit, yLo + 2 * hatH, ySplit - fl - hatH) : ySplit + fl + 0.42 * (bellL - ySplit - fl);
  for (const z of zs) {
    const ge = colorLathe(lathe(ext, 48), ext.length, (j) => (j < 2 || j >= ext.length - 2 ? flange : steel));
    // a radiatively cooled vacuum extension or a film-cooled one has no cooling tubes: flat uv.x, so no ridges
    const extUV = vacuum || filmCooled ? (g) => (g.attributes.uv.array.forEach((_, i, a) => i % 2 === 0 && (a[i] = 0.5)), g) : ridgeUV;
    add(extUV(ge).translate(0, 0, z), "engine", [-1, 3], { sym: !twin, ds: true, kind: "shell" });
  }
  for (const z of zs) add(hat(yLo, z), "machined", [-1, 4], { sym: !twin, edges: true });
  for (const z of zs) {
    const gr = colorLathe(lathe(regen, 48), regen.length, (j, y) => {
      if (j < 2) return flange;
      const k = Math.pow(clamp(y / bellL, 0, 1), 3) * 0.55;
      return [lerp(regenBase[0], heat[0], k), lerp(regenBase[1], heat[1], k), lerp(regenBase[2], heat[2], k)];
    });
    // Bolt circle on the extension flange (nuts on the regen side).
    const b = Math.min(0.012 * L, 0.05 * rs);
    const bolts = paint(boltRing(rs * 1.035, ySplit + fl + b / 2, 16, b), flange);
    add(merge([ridgeUV(gr), bolts]).translate(0, 0, z), "engine", [-1, 1], { sym: !twin, ds: true });
  }
  for (const z of zs) add(hat(yHi, z), "machined", [-1, 2], { sym: !twin, edges: true });

  // Turbopump layout (shared by the pieces below): a vertical cylinder beside the chamber (between the
  // chambers on a twin).
  const rp = rc * (twin ? 0.7 : vacuum ? 0.5 : 0.6);
  const hp = L * (vacuum ? 0.16 : 0.24);
  const py0 = bellL + convL * 0.5;
  const px = twin ? 0 : rc + rp + 0.03 * L;
  // Turbine exhaust duct: from the turbine end of the pump down along the bell, a flared exit at its end
  // (moves with the regen bell in the lens view).
  {
    const rD = rp * 0.42;
    let curve;
    if (twin) {
      const x0 = px + rp * 0.75;
      curve = new THREE.QuadraticBezierCurve3(v3(x0, py0 + 0.1 * hp, 0), v3(x0 + 0.6 * rp, py0 - 0.05 * L, 0), v3(x0 + 0.6 * rp, 0.55 * bellL, 0));
    } else {
      const yEnd = vacuum ? ySplit + 0.3 * (bellL - ySplit) : 0.42 * bellL;
      const xEnd = radiusAt(yEnd) + rD * 1.3;
      curve = new THREE.QuadraticBezierCurve3(v3(px + 0.3 * rp, py0, 0), v3(Math.max(px, xEnd) + rD, py0 - 0.35 * (py0 - yEnd), 0), v3(xEnd, yEnd, 0));
    }
    const e = curve.getPoint(1);
    const s0 = curve.getPoint(0);
    add(merge([new THREE.TubeGeometry(curve, 12, rD, 8, false), lathe([[rD * 1.4, -0.05 * L], [rD * 1.02, 0]], 12).translate(e.x, e.y, e.z), cyl(rD * 1.3, rD * 1.3, 0.012 * L, 10, s0.x, s0.y - 0.006 * L, s0.z)]), "powerhead", [-1, 1], { ds: true });
  }
  // Throat: the converging section up from the throat with a knurled ring at the throat and a flange lip at
  // the chamber joint.
  const knurl = boltRing(rt * 1.16, bellL + 0.012 * L, 24, (TAU * rt * 1.16) / 48, 0.03 * L, 0.08 * rt);
  const throat = [...prof.chamber.slice(0, 6), [rc * 1.08, yJ], [rc * 1.08, yJ - 0.012 * L]];
  for (const z of zs) add(merge([lathe(throat, 24), knurl.clone()]).translate(0, 0, z), "chamber", [-1, 0], { sym: !twin, ds: true });
  // Chamber: the cylinder with two raised cooling-jacket bands (the lens core).
  const band = (y) => lathe([[rc * 1.002, y - 0.006 * L], [rc * 1.04, y - 0.006 * L], [rc * 1.04, y + 0.006 * L], [rc * 1.002, y + 0.006 * L]], 24);
  for (const z of zs) add(merge([lathe([[rc, yJ], [rc, y1]], 24), band(yJ + 0.35 * chamberL), band(yJ + 0.7 * chamberL)]).translate(0, 0, z), "chamber", [0, 0], { sym: !twin, ds: true });
  // Chamber brackets: gusset lugs on the diagonals (clear of pump, gas generator, valves and actuators).
  const bracket = (phi, z) => {
    const yb = yJ + 0.15 * chamberL;
    const h = 0.7 * chamberL;
    const d = 0.26 * rc;
    const w = 0.07 * rc;
    const o = radialPhi(phi);
    // built along +X (radial) and turned onto the diagonal; r = distance of its centre from the chamber axis
    const place = (g, r, y) => g.rotateY(phi - Math.PI / 2).translate(o.x * r, y, o.z * r + z);
    return merge([
      place(new THREE.BoxGeometry(d, h, w), rc + d / 2, yb + h / 2), // web
      place(new THREE.BoxGeometry(0.04 * rc, h * 1.15, w * 3), rc * 1.02, yb + h / 2), // foot on the wall
      place(new THREE.CylinderGeometry(0.06 * rc, 0.06 * rc, w * 1.8, 10).rotateX(Math.PI / 2), rc + d, yb + 0.75 * h), // lug boss
    ]);
  };
  const bPhis = twin ? [] : vacuum ? [Math.PI / 4, (5 * Math.PI) / 4] : [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  for (const z of zs) for (const phi of bPhis) add(bracket(phi, z), "steelDark", [0, 0]);
  // Gas generator (sea level): a small can with a domed top and an outlet stub, opposite the pump.
  const rg = rc * (twin ? 0.36 : 0.3);
  const hg = L * 0.1;
  const gx = twin ? -(rp + rg + 0.03 * L) : -(rc + rg + 0.02 * L);
  const gy = bellL + convL;
  if (!vacuum) add(merge([cyl(rg, rg * 0.8, hg, 10, gx, gy), lathe(domePoints(rg, rg * 0.7, true, 4), 10).translate(gx, gy + hg, 0), cyl(rg * 1.15, rg * 1.15, 0.01 * L, 10, gx, gy + 0.3 * hg), cyl(rg * 0.35, rg * 0.35, 0.04 * L, 8, gx, gy - 0.04 * L)]), "powerhead", [0, 0]);
  // Injector manifold ring just under the injector flange, with a bolt circle on its top face.
  const mH = 0.022 * L;
  const mTop = y1 - 0.006 * L;
  const mb = 0.045 * rc;
  for (const z of zs) add(machinedRing(rc * 1.006, rc * 1.27, mH, mTop - mH, 48).translate(0, 0, z), "machined", [1, 0], { sym: !twin, edges: true, details: [det("bolt", boltCircle(rc * 1.17, mTop, 16, mb, { h: Math.min(0.6 * mb, 0.6 * (y1 - mTop)), cz: z }))] });
  // Injector dome with a bolt circle on its flange.
  const bd = Math.min(0.01 * L, 0.06 * rc);
  for (const z of zs) add(merge([lathe(prof.dome, 20), boltRing(rc * 1.09, y1 + 0.015 * L + bd / 2, 16, bd)]).translate(0, 0, z), "powerhead", [1, 1], { sym: !twin });
  // Main valves on the injector (−Z): body, bonnet flange, actuator can, cap and two line stubs each.
  const vz = twin ? -(rp + 0.3 * rc) : -rc * 1.3;
  const xv = vacuum ? [0.25 * rc] : twin ? [0.62 * rc, -0.62 * rc] : [0.62 * rc, -0.8 * rc];
  const stub = (x, s) => new THREE.CylinderGeometry(0.11 * rc, 0.11 * rc, 0.1 * rc, 10).rotateZ(Math.PI / 2).translate(x + s * 0.26 * rc, yTop - 0.035 * L, vz);
  for (const x of xv) {
    add(merge([box(0.42 * rc, 0.06 * L, 0.36 * rc, x, yTop - 0.035 * L, vz), cyl(0.17 * rc, 0.17 * rc, 0.008 * L, 10, x, yTop - 0.005 * L, vz), cyl(0.12 * rc, 0.12 * rc, 0.05 * L, 8, x, yTop + 0.003 * L, vz), cyl(0.08 * rc, 0.08 * rc, 0.015 * L, 8, x, yTop + 0.053 * L, vz), stub(x, 1), stub(x, -1)]), "valve", [1, 2]);
  }
  // Turbopump housing: cylinder, turbine cap, pump volute; a bolt circle round the cap.
  add(merge([cyl(rp, rp, hp, 12, px, py0, 0), cyl(rp * 0.72, rp * 0.72, hp * 0.14, 10, px, py0 + hp, 0), new THREE.TorusGeometry(rp * 1.02, rp * 0.22, 6, 16).rotateX(Math.PI / 2).translate(px, py0 + hp * 0.3, 0)]), "pump", [1, 3], {
    details: [det("bolt", boltCircle(rp * 0.86, py0 + hp, 12, 0.09 * rp, { cx: px }))],
  });
  // Pump inlet: a duct up from the pump to a bolted flange under the thrust frame (an elbow on a twin, whose
  // pump sits under the gimbal block).
  {
    const rIn = rp * 0.42;
    const yIn = L - 0.035 * L;
    let duct;
    let at;
    if (twin) {
      const xi = px + rp * 1.35;
      duct = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(px + 0.85 * rp, py0 + 0.7 * hp, 0), v3(xi, py0 + 0.72 * hp, 0), v3(xi, yIn, 0)), 10, rIn, 8, false);
      at = v3(xi, yIn, 0);
    } else {
      const y0 = py0 + hp * 1.14;
      duct = cyl(rIn, rIn, Math.max(yIn - y0, 0.01 * L), 10, px, y0);
      at = v3(px, yIn, 0);
    }
    add(merge([duct, cyl(rIn * 1.7, rIn * 1.7, 0.014 * L, 12, at.x, yIn - 0.014 * L, at.z)]), "pipe", [1, 4], { details: [det("bolt", boltCircle(rIn * 1.38, yIn, 8, 0.2 * rIn, { cx: at.x, cz: at.z }))] });
  }
  // Feed lines: LOX (pump → injector dome) and fuel (pump → chamber side), one branch per chamber, clamped.
  const rPipe = rc * (vacuum ? 0.16 : 0.2);
  const feed = { lox: [[], []], fuel: [[], []] };
  for (const z of zs) {
    const s = twin ? Math.sign(z) : 1;
    const cl = new THREE.QuadraticBezierCurve3(v3(px, py0 + hp * 0.8, 0), v3(px * 0.6, yTop + domeL * 0.9, z * 0.4), v3(rc * 0.3, yTop - domeL * 0.3, z));
    const cf = new THREE.QuadraticBezierCurve3(v3(px, py0 + hp * 0.35, rp * 0.6 * s), v3(px * 0.7 + rc * 0.4, py0 + hp * 0.2, rc * 1.3 * s + z * 0.5), v3(rc * 0.55, bellL + convL + chamberL * 0.5, z + rc * 0.75 * s));
    feed.lox[0].push(new THREE.TubeGeometry(cl, 8, rPipe, 6, false));
    feed.lox[1].push(...clampsAlong(cl, rPipe, 3));
    feed.fuel[0].push(new THREE.TubeGeometry(cf, 8, rPipe * 0.85, 6, false));
    feed.fuel[1].push(...clampsAlong(cf, rPipe * 0.85, 3));
  }
  for (const [geos, clamps] of [feed.lox, feed.fuel]) add(merge(geos), "pipe", [1, 4], { details: [det("clamp", clamps)] });
  // High-pressure lines: pump discharge round to each main valve's outer stub.
  const rHP = rPipe * 0.7;
  xv.forEach((x, k) => {
    const end = v3(x + (twin && x < 0 ? -0.31 : 0.31) * rc, yTop - 0.035 * L, vz);
    let a;
    let c;
    if (twin) {
      a = v3(Math.sign(x) * 0.5 * rp, py0 + 0.5 * hp, -0.85 * rp);
      c = v3(Math.sign(x) * 0.95 * rc, yTop - 0.05 * L, vz - 0.12 * rc);
    } else if (k === 0) {
      a = v3(px - 0.25 * rp, py0 + 0.5 * hp, -0.85 * rp);
      c = v3((px + end.x) / 2 + 0.2 * rc, yTop - 0.06 * L, vz - 0.1 * rc);
    } else {
      a = v3(px - 0.55 * rp, py0 + 0.8 * hp, -0.7 * rp);
      c = v3(0.6 * rc, yTop + 0.03 * L, vz - 1.1 * rc);
    }
    add(tube(a, c, end, rHP, 10), "pipe", [1, 4]);
  });
  // Ignition line (single-chamber sea level): from the gas generator's igniter cartridge up to the injector dome.
  if (!vacuum && !twin) {
    const g0 = v3(gx, gy + hg + rg * 0.55, 0);
    const end = v3(-0.6 * rc, yTop - 0.01 * L, 0.5 * rc);
    add(merge([tube(g0, v3(gx * 0.7, yTop + 0.03 * L, end.z * 0.8), end, 0.05 * rc, 10), box(0.16 * rc, 0.05 * L, 0.12 * rc, gx, g0.y + 0.02 * L, 0.2 * rc)]), "pipe", [1, 4]);
    // Instrumentation box with its connector, on a standoff plate beside the injector.
    const ib = v3(-0.85 * rc, yTop - 0.02 * L, 0.75 * rc);
    add(merge([box(0.36 * rc, 0.07 * L, 0.26 * rc, ib.x, ib.y, ib.z), cyl(0.06 * rc, 0.06 * rc, 0.03 * L, 8, ib.x, ib.y + 0.035 * L, ib.z), box(0.42 * rc, 0.006 * L, 0.32 * rc, ib.x, ib.y - 0.038 * L, ib.z)]), "steelDark", [1, 5]);
  }
  // Gimbal actuators (±Z): hydraulic ram from the thrust frame down to a clevis on the chamber.
  for (const s of [1, -1]) {
    const zc = s * (twin ? off : 0);
    const top = v3(-0.2 * rc, L - 0.03 * L, s * rc * 1.5 + zc);
    const bot = v3(-0.2 * rc, bellL + convL + 0.6 * chamberL, s * rc * 1.05 + zc);
    const mid = top.clone().lerp(bot, 0.5);
    add(merge([rod(top, mid, 0.17 * rc), rod(mid, bot, 0.1 * rc), cyl(0.2 * rc, 0.2 * rc, 0.03 * L, 8, top.x, top.y - 0.005 * L, top.z), box(0.16 * rc, 0.045 * L, 0.2 * rc, bot.x, bot.y, bot.z - s * 0.05 * rc)]), "actuator", [1, 5]);
  }
  // Gimbal block + flange up to the mount plate.
  const gw = twin ? 2 * off + rc : rc * 1.1;
  const gh = L - yTop + 0.02 * L;
  add(
    merge([
      box(twin ? rc * 1.1 : gw, gh, gw, 0, yTop - 0.02 * L + gh / 2, 0),
      cyl(rc * 0.95, rc * 0.95, 0.025 * L, 12, 0, L - 0.025 * L),
      boltRing(rc * 0.97, L - 0.0125 * L, 24, (TAU * rc) / 50, 0.02 * L, 0.06 * rc), // knurled gimbal ring
    ]),
    "gimbal",
    [1, 6],
    { sym: true },
  );
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
  const kit = engineKit({ exitD_m: g.exitD_m, L, vacuum: g.vacuum, chambers: g.chambers, overall: g.diameterKind === "overall", extFrac: g.extension?.startRadiusFraction ?? 0 });
  const { radiusAt, bellL, rc, off } = kit;
  const out = [];
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
  const hsDist = 0.12 + 0.35 * Rm * S;
  // Heat-shield boot (sea-level engines): a bellows sleeve from the engine up into its hole in the heat shield.
  // It hangs from the shield, so it takes the shield's lens layer and its sector's opening move. One geometry
  // per hole size (ring engines / centre engine).
  const boots = new Map();
  const bootGeo = (rTop) => {
    if (boots.has(rTop)) return boots.get(rTop);
    const hB = 0.06 * L;
    const yB = yHs - hB;
    const rIn = (y) => radiusAt(y) * 1.03 + (g.chambers > 1 ? off : 0) + 0.004 * L;
    const pts = [[rIn(yB), yB]];
    for (let k = 1; k < 6; k++) {
      const y = yB + (k / 6) * hB;
      const r = lerp(rIn(y), rTop * 0.97, (k / 6) ** 2);
      pts.push([r + (k % 2 ? 0.05 : -0.02) * Math.abs(rTop - rIn(y)) + (k % 2 ? 0.004 * L : 0), y]);
    }
    pts.push([rTop * 0.97, yHs], [rTop * 1.02, yHs]);
    const geo = projectUV(lathe(pts, 32));
    boots.set(rTop, geo);
    return geo;
  };
  // Exploded view: each engine's sub-pieces stack along the axis (axisOffset, group "e<i>") and the whole
  // column moves outward from the cluster centre (explode), so neighbouring columns never touch.
  const d = Math.max(0.15, 0.45 * L * S);
  g.positions.forEach((p, i) => {
    // Powerheads turn tangentially on a ring so pumps stay inside the cluster footprint.
    const ry = p.r > 0 ? -p.a - Math.PI / 2 : 0;
    const dir = p.r > 0 ? radial(p.a, -0.12) : DOWN;
    const dist = p.r > 0 ? d : 0.25 * d;
    kit.forEach((s, j) => {
      const pc = piece(s.geo, mats[s.mat === "engine" && g.bellFinish === "ablative" ? "ablative" : s.mat], { x: p.x, z: p.z, ry, order: i + j * 0.01, dir, dist, side: s.ds ? DS : undefined, ax: [`e${i}`, ...s.ax], sym: s.sym && p.r === 0, engine: i, kind: s.kind ?? "detail", edges: s.edges });
      for (const dt of s.details ?? []) addDetail(pc, dt.type, dt.attr);
      out.push(pc);
    });
    if (!g.vacuum) {
      out.push(piece(bootGeo(p.r > 0 ? holeR : innerR), mats.skirt, { x: p.x, z: p.z, order: i + 0.035, dir: p.r > 0 ? radial(p.a, -0.15) : UP, dist: p.r > 0 ? hsDist : 0.1, side: DS, ax: ["top", 1, 0], engine: i }));
    }
  });

  heatShieldSectors(g, holeR, innerR, Rm * 0.98, yHs, 0.06).forEach(({ geo, mid, ry }, k) =>
    out.push(piece(geo, mats.heatShield, { ry, order: n + 0.1 + k * 0.01, dir: radial(mid, -0.15), dist: hsDist, ax: ["top", 1, 0], kind: "shell" })),
  );
  if (thrustSection) {
    // Thrust-section skin with 12 raised longerons (edges draw the ribs and the rims).
    const ribD = 0.012 * g.mountD_m;
    const ribs = [];
    for (let k = 0; k < 12; k++) {
      const o = radialPhi((k * TAU) / 12);
      ribs.push(strut(o.clone().multiplyScalar(Rm + ribD / 2).setY(yHs), o.clone().multiplyScalar(Rm + ribD / 2).setY(L + mountH), 0.016 * g.mountD_m, ribD, o));
    }
    const skirt = merge([latheUV(lathe([[Rm, yHs], [Rm, L + mountH]], 64), { H: spec.height / S, R: Rm }), projectUV(merge(ribs))]);
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

// A tank (~56 pieces): skirt ring; inside, the bottom dome, two feed lines (tunnels) and the downcomer through
// the lower tank, six slosh baffles and six ring frames, the common bulkhead, two pressurisation lines, four
// line brackets, four pressurant bottles on four brackets, the top dome with two vent valves; eight stringer
// sets and four skin quarters (rivet rows along the panel seams, instanced); outside, a raceway in four
// segments (straps instanced) and four umbilical plates; the forward ring; legs and grid fins by feature.
// Arrival bottom-up: the interior by height, then the skin closing round it, raceway, umbilicals, forward
// ring, legs. Interior layout is visual (bulkheads, propellant split at 42 % of the height).
function buildTank(spec, mats) {
  const g = spec.geom;
  const R = g.D_m / 2;
  const H = g.H_m;
  const D = g.D_m;
  const T = (side, rank) => ["t", side, rank];
  const out = [];
  const P = (geo, mat, o) => {
    const pc = piece(geo, mat, o);
    out.push(pc);
    return pc;
  };
  const domeH = 0.35 * R;
  const inset = 0.015 * H;
  const yMid = 0.42 * H;
  const skirtH = Math.min(0.012 * H, 0.12 * D);
  const fwdH = Math.min(0.012 * H, 0.12 * D);
  const inner = 0.15 + 0.2 * R * S;
  const tb = Math.max(0.02, 0.006 * D); // bolt head size (visual)
  const ringBolts = (y) => boltRing(R * 1.011, y, 24, tb, tb, tb * 0.8);
  // Height of a dome's surface at radius rr (rim at y = rim, bulging up or down by h).
  const domeY = (rr, rim, h, up) => rim + (up ? 1 : -1) * h * Math.sqrt(Math.max(0, 1 - (rr / (R * 0.985)) ** 2));
  const yCopv = H - inset - domeH - 0.16 * D;
  // Interior bays at the wall: the lower tank between the bottom dome's rim and the common bulkhead's rim,
  // the upper one from clear of the bulkhead's crown up to below the pressurant bottles.
  const lower = [inset + domeH, yMid];
  const upper = [yMid + 0.55 * domeH, yCopv - 0.15 * D];
  if (upper[1] - upper[0] < 0.08 * H) upper[1] = Math.max(upper[0] + 0.08 * H, H - inset - domeH - 0.02 * H);
  const at = ([lo, hi], f) => lo + f * (hi - lo);
  const orderAt = (y) => 0.12 + 0.56 * clamp(y / H, 0, 1);

  // The first stage's thrust-skirt flange is a little wider and taller (relief at the base).
  const skirtTop = g.stageIndex === 0 ? skirtH * 1.3 : skirtH;
  const skirtRing = g.stageIndex === 0 ? machinedRing(R * 0.985, R * 1.025, skirtTop) : machinedRing(R * 0.985, R * 1.008, skirtH);
  P(merge([skirtRing.clone(), ringBolts(skirtH * 0.5)]), mats.skirt, { order: 0, dir: DOWN, dist: 0.15, ax: T(-1, 0), sym: true, edges: true, lineGeo: skirtRing });
  P(projectUV(lathe(domePoints(R * 0.985, domeH, false), 36).translate(0, inset + domeH, 0)), mats.interior, { order: 0.1, dir: DOWN, dist: inner, side: DS, sym: true, kind: "interior", edges: true });
  // Two feed lines (propellant tunnels) through the lower tank, from the bottom dome up into the bulkhead's
  // crown, flanged at both ends and clamped.
  const rf = 0.5 * R;
  const fr = 0.028 * D;
  [0, Math.PI].forEach((phi, k) => {
    const o = radialPhi(phi);
    const yb = domeY(rf, inset + domeH, domeH, false) + 0.004 * D;
    const yt = domeY(rf, yMid, 0.8 * domeH, true) - 0.004 * D;
    const [x, z] = [o.x * rf, o.z * rf];
    const fg = (y) => cyl(fr * 1.45, fr * 1.45, 0.014 * D, 12, x, y, z);
    const pc = P(merge([cyl(fr, fr, yt - yb, 12, x, yb, z), fg(yb), fg(yt - 0.014 * D)]), mats.interior, { order: 0.15 + k * 0.01, dir: radialPhi(phi, -0.3), dist: 0.07, kind: "interior" });
    addDetail(pc, "clamp", clampsAlong(new THREE.LineCurve3(v3(x, yb, z), v3(x, yt, z)), fr, 4, 0.15, 0.85));
  });
  P(cyl(0.045 * D, 0.045 * D, yMid - inset, 16, 0, inset), mats.interior, { order: 0.2, dir: DOWN, dist: 0.05, sym: true, kind: "interior" });
  // Slosh baffle: flat annulus with a ring of lightening cut-outs (edges draw the holes).
  const baffleShape = new THREE.Shape().absarc(0, 0, R * 0.985, 0, TAU, false);
  baffleShape.holes.push(new THREE.Path().absarc(0, 0, R * 0.78, 0, TAU, true));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    baffleShape.holes.push(new THREE.Path().absarc(Math.cos(a) * R * 0.88, Math.sin(a) * R * 0.88, R * 0.045, 0, TAU, true));
  }
  const baffleGeo = new THREE.ExtrudeGeometry(baffleShape, { depth: 0.012 * D, bevelEnabled: false, curveSegments: 16 }).rotateX(-Math.PI / 2); // shared by the six baffles
  // Ring frame: a T-section ring against the stringers, flange inward; one geometry for the six, edge lines
  // on the flange only.
  const [rF, rI, rW, hf, tw] = [R * 0.922, R * 0.938, R * 0.972, 0.034 * D, 0.01 * D];
  const frameGeo = lathe([[rF, hf / 2], [rF, -hf / 2], [rI, -hf / 2], [rI, -tw / 2], [rW, -tw / 2], [rW, tw / 2], [rI, tw / 2], [rI, hf / 2], [rF, hf / 2]], 64);
  const frameLines = lathe([[rF, hf / 2], [rF, -hf / 2], [rI, -hf / 2], [rI, hf / 2], [rF, hf / 2]], 64);
  // In each bay, alternating frame / baffle / frame / baffle / frame / baffle at sevenths of its height.
  for (const bay of [lower, upper]) {
    for (let j = 1; j <= 6; j++) {
      const y = at(bay, j / 7);
      const dir = y < yMid ? DOWN : UP;
      if (j % 2) P(frameGeo, mats.interior, { y, order: orderAt(y), dir, dist: 0.03, sym: true, kind: "interior", edges: true, lineGeo: frameLines });
      else P(baffleGeo, mats.interior, { y, order: orderAt(y), dir, dist: 0.04, side: DS, sym: true, kind: "interior" });
    }
  }
  P(projectUV(lathe(domePoints(R * 0.985, domeH * 0.8, true), 36).translate(0, yMid, 0)), mats.interior, { order: orderAt(yMid), dir: UP, dist: 0.06, side: DS, sym: true, kind: "interior", edges: true });
  // Pressurisation lines: one up the upper tank from the bulkhead to below the bottles, one down the lower
  // tank from under the bulkhead to the bottom dome; flanged, clamped.
  const rpl = 0.66 * R;
  const pr = 0.009 * D;
  [
    { phi: Math.PI / 2, yb: domeY(rpl, yMid, 0.8 * domeH, true) + 0.01 * D, yt: yCopv - 0.04 * D },
    { phi: (3 * Math.PI) / 2, yb: domeY(rpl, inset + domeH, domeH, false) + 0.01 * D, yt: yMid + 0.45 * domeH },
  ].forEach(({ phi, yb, yt }) => {
    const o = radialPhi(phi);
    const [x, z] = [o.x * rpl, o.z * rpl];
    const fg = (y) => cyl(pr * 1.9, pr * 1.9, 0.01 * D, 8, x, y, z);
    const pc = P(merge([cyl(pr, pr, yt - yb, 8, x, yb, z), fg(yb), fg(yt - 0.01 * D)]), mats.pipe, { order: orderAt((yb + yt) / 2) + 0.004, dir: radialPhi(phi, 0.2), dist: 0.06, kind: "interior" });
    addDetail(pc, "clamp", clampsAlong(new THREE.LineCurve3(v3(x, yb, z), v3(x, yt, z)), pr, 4, 0.12, 0.88));
  });
  // Line brackets: flat struts from the downcomer out to each feed line, with collars, at two heights each.
  [0, Math.PI].forEach((phi, k) => {
    const o = radialPhi(phi);
    for (const f of k ? [0.4, 0.79] : [0.33, 0.72]) {
      const y = at(lower, f);
      const geo = merge([
        strut(o.clone().multiplyScalar(0.045 * D).setY(y), o.clone().multiplyScalar(rf - 0.9 * fr).setY(y), 0.03 * D, 0.012 * D, UP),
        cyl(fr * 1.3, fr * 1.3, 0.02 * D, 12, o.x * rf, y - 0.01 * D, o.z * rf),
        cyl(0.056 * D, 0.056 * D, 0.02 * D, 16, 0, y - 0.01 * D, 0),
      ]);
      P(geo, mats.steelDark, { order: orderAt(y) + 0.002, dir: radialPhi(phi, -0.1), dist: 0.05, kind: "interior" });
    }
  });
  // Pressurant bottles, each on a bracket (saddle band + strut out to the wall).
  const copvGeo = new THREE.CapsuleGeometry(0.07 * D, 0.12 * D, 4, 12); // shared by the four bottles
  const saddle = new THREE.TorusGeometry(0.074 * D, 0.006 * D, 4, 24).rotateX(Math.PI / 2);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const o = radial(a);
    const [cx, cz] = [0.32 * R * o.x, 0.32 * R * o.z];
    P(copvGeo, mats.copv, { x: cx, y: yCopv, z: cz, order: 0.6 + k * 0.01, dir: radial(a, 0.6), dist: 0.08, kind: "interior" });
    const st = strut(o.clone().multiplyScalar(0.32 * R + 0.074 * D).setY(yCopv), o.clone().multiplyScalar(0.962 * R).setY(yCopv), 0.026 * D, 0.012 * D, UP);
    P(merge([saddle.clone().translate(cx, yCopv, cz), st]), mats.steelDark, { order: 0.605 + k * 0.01, dir: radial(a, 0.6), dist: 0.12, kind: "interior" });
  }
  P(projectUV(lathe(domePoints(R * 0.985, domeH, true), 36).translate(0, H - inset - domeH, 0)), mats.interior, { order: 0.7, dir: UP, dist: inner, side: DS, sym: true, kind: "interior", edges: true });
  // Two vent valves on the top dome (body, flange, stem, outlet bar); they lift off the dome when exploded.
  [Math.PI / 2 + 0.4, (3 * Math.PI) / 2 + 0.4].forEach((phi, k) => {
    const o = radialPhi(phi);
    const rv = 0.5 * R;
    const yv = domeY(rv, H - inset - domeH, domeH, true);
    const [x, z] = [o.x * rv, o.z * rv];
    const vr = 0.028 * D;
    P(merge([cyl(vr, vr, 0.035 * D, 10, x, yv - 0.01 * D, z), cyl(vr * 1.5, vr * 1.5, 0.008 * D, 10, x, yv + 0.006 * D, z), cyl(vr * 0.55, vr * 0.55, 0.02 * D, 8, x, yv + 0.025 * D, z), box(vr * 1.6, 0.008 * D, vr * 0.6, x, yv + 0.03 * D, z)]), mats.valve, { order: 0.72 + k * 0.01, dir: UP, dist: inner + 0.07 });
  });

  // Skin: four shell quarters, each with two sets of internal stringers. An enclosed tank (it sits inside the
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
  // piece rules), so each tank uploads one skin, two stringer sets and one line set.
  const strSet = (j0) => {
    const s = [];
    for (let j = j0; j < j0 + 3; j++) {
      const phi = ((j + 0.5) * (Math.PI / 2)) / 6;
      const r = R - 0.008 * D;
      s.push(box(0.012 * D, 0.94 * H, 0.01 * D).rotateY(phi - Math.PI / 2).translate(Math.sin(phi) * r, H / 2, Math.cos(phi) * r));
    }
    return merge(s);
  };
  const [strA, strB] = [strSet(0), strSet(3)];
  // Raised panel seam strip on each quarter's leading edge (phi = 0, so four quarters give four seams).
  const seamStrip = projectUV(box(0.012 * D, y1s - y0s, 0.006 * D, 0, (y0s + y1s) / 2, R + 0.003 * D));
  const quarterGeo = merge([latheUV(lathe(shellProfile, 24, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H, R }), seamStrip.clone()]);
  const plain = lathe([[R, y0s], [R, y1s]], 24, 0, Math.PI / 2); // its boundary = the panel seams
  const seamWeldGeo = merge([plain, seamStrip, ...welds.map((y) => lathe([[R, y - ww], [R * 1.004, y - ww], [R * 1.004, y + ww], [R, y + ww]], 24, 0, Math.PI / 2))]);
  // Rivets (instanced, shared by the four quarters): a row each side of the seam strip, a row round the top
  // and bottom of the quarter clear of the skirt and forward rings.
  let rivets = null;
  if (rivetsOn(g.finish)) {
    const rv = Math.max(0.012, 0.0042 * D);
    const pitch = 8 * rv;
    const list = [];
    const ya = Math.max(y0s, skirtTop) + 0.03 * D;
    const yb = Math.min(y1s, H - fwdH) - 0.03 * D;
    for (const sx of [-1, 1]) {
      const o = radialPhi(Math.asin((sx * 0.0095 * D) / R)).multiplyScalar(R);
      list.push(...rivetRow(o.clone().setY(ya + 0.03 * D), o.clone().setY(yb - 0.03 * D), pitch, rv));
    }
    const d0 = (0.02 * D) / R;
    list.push(...rivetArc(R, ya, d0, Math.PI / 2 - d0, pitch, rv), ...rivetArc(R, yb, d0, Math.PI / 2 - d0, pitch, rv));
    rivets = instAttr(g.finish === "white-black-roll" && !g.enclosed ? offRoll(list, H) : list);
  }
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    P(strA, mats.interior, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 8), dist: shellDist * 0.7, kind: "interior" });
    P(strB, mats.interior, { ry, order: 1.01 + q * 0.02, dir: radialPhi(ry + (3 * Math.PI) / 8), dist: shellDist * 0.64, kind: "interior" });
  }
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    const pc = P(quarterGeo, shellMat, { ry, order: 1.5 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist, side: DS, kind: "shell", lineGeo: false, fineGeo: seamWeldGeo });
    if (rivets) addDetail(pc, "rivet", rivets, { lookOnly: "painted", color: rivetTint(pc.mesh) });
  }
  // Raceway (cable/plumbing tunnel) along the full length in four segments of cover plates (~2 m each with a
  // small joint), straps every 1.5 m (instanced); the segments part a little along the axis when exploded.
  if (!g.enclosed) {
    const rwA = Math.PI / 2;
    const rwD = 0.03 * D;
    const rwW = 0.07 * D;
    const rwH = H - skirtH - fwdH - 0.01 * H;
    const nP = Math.max(4, Math.floor(rwH / 2));
    const pl = rwH / nP;
    const segs = [[], [], [], []];
    for (let i = 0; i < nP; i++) segs[Math.min(3, Math.floor((i * 4) / nP))].push(i);
    segs.forEach((idx, k) => {
      const duct = projectUV(merge(idx.map((i) => box(rwD, pl - 0.12, rwW, R + rwD / 2, skirtH + (i + 0.5) * pl, 0))));
      const [ya, yb] = [skirtH + idx[0] * pl, skirtH + (idx.at(-1) + 1) * pl];
      const straps = [];
      for (let y = ya + 0.5; y < yb - 0.4; y += 1.5) straps.push(xf(v3(R + rwD * 0.85, y, 0), UP, rwD * 1.7, 0.1, rwW * 1.45));
      const pc = P(duct, mats.raceway, { ry: -rwA, order: 2 + k * 0.01, dir: radial(rwA, (k - 1.5) * 0.08), dist: shellDist * 1.1, edges: true });
      addDetail(pc, "strap", straps);
    });
    // Four umbilical plates beside the raceway, in the raceway's paint: a pair near the base with two
    // quick-disconnect ports each, a smaller pair near the top with one; a bolt ring round every port (visual
    // sizes).
    const umb = (big) => {
      const plate = box(0.025 * D, (big ? 0.26 : 0.12) * D, (big ? 0.15 : 0.09) * D, R + 0.0125 * D, 0, 0);
      const ub = 0.01 * D;
      const parts = [plate.clone()];
      const pr = big ? 0.035 * D : 0.025 * D;
      for (const py of big ? [-0.065 * D, 0.065 * D] : [0]) {
        parts.push(new THREE.CylinderGeometry(pr, pr, 0.045 * D, 10).rotateZ(Math.PI / 2).translate(R + 0.04 * D, py, 0));
        parts.push(boltRing(pr * 1.45, 0, 8, ub).rotateZ(Math.PI / 2).translate(R + 0.025 * D + ub / 2, py, 0));
      }
      return [projectUV(merge(parts)), plate];
    };
    const [bigGeo, bigPlate] = umb(true);
    const [smallGeo, smallPlate] = umb(false);
    const yLo = skirtTop + 0.02 * H + 0.2 * D;
    const yHi = H - fwdH - 0.02 * H - 0.12 * D;
    [[rwA + 0.33, yLo, true], [rwA - 0.33, yLo, true], [rwA + 0.33, yHi, false], [rwA - 0.33, yHi, false]].forEach(([ua, uy, big], k) =>
      P(big ? bigGeo : smallGeo, mats.raceway, { y: uy, ry: -ua, order: 2.2 + k * 0.01, dir: radial(ua), dist: shellDist * 1.1, edges: true, lineGeo: big ? bigPlate : smallPlate }),
    );
  }
  const fwdRing = machinedRing(R * 0.985, R * 1.008, fwdH, H - fwdH);
  P(merge([fwdRing.clone(), ringBolts(H - fwdH * 0.5)]), mats.machined, { order: 2.5, dir: UP, dist: 0.12, ax: T(1, 0), sym: true, edges: true, lineGeo: fwdRing });

  if (g.features.includes("landing-legs")) legs(out, mats, R, H, D, shellDist, skirtH);
  if (g.features.includes("grid-fins")) gridFins(out, mats, R, R, H * 0.985 - fwdH, D, shellDist);
  return out;
}

// Falcon-style folded landing legs: tapered carbon struts hinged at the base with a round footpad on a ball
// joint at the tip (pre-tilted so it lies flat once the leg is out), a two-stage telescoping piston per leg
// (outer tube pinned on the body, polished rod pinned on the leg; both follow the leg, see applyDeploy), hidden
// inside the folded leg, and the upper brackets on the skin. Sizes are visual ratios.
function legs(out, mats, R, H, D, shellDist, y0) {
  const len = Math.min(0.24 * H, 2.6 * D); // visual
  const w0 = 0.2 * D;
  const w1 = 0.11 * D;
  const t0 = 0.1 * D;
  const t1 = 0.06 * D;
  const tAt = (k) => lerp(t0, t1, k);
  const strutGeo = new THREE.BoxGeometry(1, 1, 1, 1, 4, 1);
  const p = strutGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = p.getY(i) + 0.5;
    p.setXYZ(i, R + (p.getX(i) + 0.5) * tAt(k), y0 + k * len, p.getZ(i) * lerp(w0, w1, k));
  }
  strutGeo.computeVertexNormals();
  const hinge = box(t0 * 1.2, 0.04 * len, w0 * 1.1, R + t0 * 0.6, y0 + 0.02 * len, 0);
  // Deploy: the folded leg (foot up) swings out and down about its base hinge, ending ~30° off vertical,
  // feet below the engines (local frame: +X radial; axis −Z turns +Y toward +X).
  const axis = v3(0, 0, -1);
  const angle = (150 * Math.PI) / 180;
  const pivot = v3(R + 0.5 * t0, y0 + 0.02 * len, 0);
  const qOut = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  // Footpad: a shallow round pad below a ball joint; its axis at rest is the direction that turns vertical.
  const tip = v3(R + 0.5 * t1, y0 + len, 0);
  const padUp = UP.clone().applyQuaternion(qOut.clone().invert());
  const pr = 0.16 * D;
  const pad = lathe([[0.001, -0.075 * D], [pr, -0.075 * D], [pr * 1.03, -0.05 * D], [pr * 0.55, -0.025 * D], [0.06 * D, -0.012 * D], [0.001, -0.012 * D]], 28)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, padUp))
    .translate(tip.x, tip.y, tip.z);
  const ball = new THREE.SphereGeometry(0.045 * D, 12, 8).translate(tip.x, tip.y, tip.z);
  const legGeo = projectUV(merge([strutGeo, hinge, pad, ball].map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()])))));
  const legLines = merge([strutGeo.clone(), hinge.clone()]);
  const bracketGeo = merge([box(0.05 * D, 0.03 * len, 0.16 * D, R + 0.025 * D, y0 + len + 0.03 * len, 0), cyl(0.02 * D, 0.02 * D, 0.03 * len, 10, R + 0.06 * D, y0 + len + 0.015 * len)]);
  // Piston: body pin B low on the skin, leg pin L three quarters up the leg; tube and rod each a little over
  // half the deployed span so they still overlap when fully out.
  const B = v3(R + 0.4 * t0, y0 + 0.3 * len, 0);
  const Lp = v3(R + 0.5 * tAt(0.75), y0 + 0.75 * len, 0);
  const L1 = Lp.clone().sub(pivot).applyQuaternion(qOut).add(pivot);
  const lp = Math.min(0.68 * len, Math.max(Lp.distanceTo(B), 0.5 * L1.distanceTo(B) + 0.05 * len));
  const u0 = Lp.clone().sub(B).normalize();
  const along = (l, r, from, dir) => new THREE.CylinderGeometry(r, r, l, 12).translate(0, l / 2, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir)).translate(from.x, from.y, from.z);
  const tubeGeo = merge([along(lp, 0.026 * D, B, u0), along(0.04 * len, 0.032 * D, B.clone().addScaledVector(u0, lp - 0.04 * len), u0), new THREE.SphereGeometry(0.03 * D, 10, 8).translate(B.x, B.y, B.z)].map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]))));
  const rodGeo = merge([along(lp, 0.016 * D, Lp, u0.clone().negate()), new THREE.SphereGeometry(0.022 * D, 10, 8).translate(Lp.x, Lp.y, Lp.z)].map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]))));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const leg = piece(legGeo, mats.leg, { ry: -a, order: 3 + i * 0.02, dir: radial(a), dist: shellDist * 1.4, edges: true, lineGeo: legLines, deploy: { axis, pivot, angle, order: 1 } });
    out.push(leg);
    out.push(piece(projectUV(tubeGeo.clone()), mats.darkMetal, { ry: -a, order: 3.005 + i * 0.02, dir: radial(a), dist: shellDist * 1.3, follow: { leader: leg, B, L: Lp, end: "B" } }));
    out.push(piece(projectUV(rodGeo.clone()), mats.pipe, { ry: -a, order: 3.006 + i * 0.02, dir: radial(a), dist: shellDist * 1.3, follow: { leader: leg, B, L: Lp, end: "L" } }));
    out.push(piece(bracketGeo, mats.darkMetal, { ry: -a, order: 3.1 + i * 0.02, dir: radial(a, 0.3), dist: shellDist * 1.2 }));
  }
}

// Folded grid fins standing against the body, lattice facing out: cast titanium, a deep frame around a dense
// waffle of thin plates crossing at ±45°, a hinge barrel and actuator housing at the root. Edge lines draw
// the frame only. rBot/rTop: body radius at the fin's bottom/top (frustum interstages); yTop: top of the fin.
function gridFins(out, mats, rBot, rTop, yTop, D, dist) {
  const h = 0.4 * D; // visual sizes
  const w = 0.33 * D;
  const d = 0.07 * D; // depth of the lattice
  const fr = 0.016 * D; // frame wall
  const web = 0.005 * D; // lattice plate
  const y0 = yTop - h;
  const r = (rBot + rTop) / 2 + 0.01 * D;
  const frame = [
    box(d, fr, w, r + d / 2, y0 + fr / 2, 0),
    box(d, fr, w, r + d / 2, yTop - fr / 2, 0),
    box(d, h, fr, r + d / 2, y0 + h / 2, -w / 2 + fr / 2),
    box(d, h, fr, r + d / 2, y0 + h / 2, w / 2 - fr / 2),
  ];
  const root = [
    new THREE.CylinderGeometry(0.03 * D, 0.03 * D, w * 0.9, 16).rotateX(Math.PI / 2).translate(r + d / 2, y0 - 0.02 * D, 0), // hinge barrel
    box(d * 1.4, 0.12 * h, 0.3 * w, r + d * 0.7, y0 - 0.08 * h, 0), // actuator housing
  ];
  // Waffle: plates along ±45° in the fin plane (YZ), clipped to the inside of the frame.
  const lattice = [];
  const N = 9;
  const hi = h - 2 * fr;
  const wi = w - 2 * fr;
  for (const sgn of [1, -1]) {
    for (let i = 1; i < 2 * N; i++) {
      const c = -wi / 2 - hi / 2 + (i * (wi + hi)) / (2 * N); // z + s·(y − yc) = c
      const zA = clamp(c + hi / 2, -wi / 2, wi / 2);
      const zB = clamp(c - hi / 2, -wi / 2, wi / 2);
      const yA = (c - zA) * sgn;
      const yB = (c - zB) * sgn;
      const l = Math.hypot(zA - zB, yA - yB);
      if (l < web * 4) continue;
      lattice.push(new THREE.BoxGeometry(d * 0.92, l, web).rotateX((sgn * -Math.PI) / 4).translate(r + d / 2, y0 + h / 2 + (yA + yB) / 2, (zA + zB) / 2));
    }
  }
  const frameGeo = merge(frame);
  const geo = projectUV(merge([frameGeo.clone(), ...root, ...lattice]));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const deploy = { axis: v3(0, 0, -1), pivot: v3(r + d / 2, y0, 0), angle: Math.PI / 2, order: 0 }; // root hinge, +Y → +X
    out.push(piece(geo, mats.gridFin, { ry: -a, order: 4 + i * 0.02, dir: radial(a, 0.2), dist: dist * 1.3, edges: true, lineGeo: frameGeo, deploy }));
  }
}

// ---------- interstage ----------

// Bottom and top machined joint rings, four stringer sets (three per quarter), eight separation pushers and
// four separation clamps under the top ring (one lens layer above it), four shell quarters (rivet rows along
// the seams and joints, instanced), a raceway in two segments (+ Falcon-style grid fins near the top when the
// lower stage has them, Saturn ullage-motor housings) = 24 pieces before features.
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
  const P = (geo, mat, o) => {
    const pc = piece(geo, mat, o);
    out.push(pc);
    return pc;
  };
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
  P(lowGeo, mats.machined, { order: 0, dir: DOWN, dist: 0.1, ax: ["i", -1, 0], sym: true, edges: true, lineGeo: lowLines });
  const str = [];
  for (let j = 0; j < 3; j++) {
    const o = radialPhi(((j + 0.5) * (Math.PI / 2)) / 3);
    const atS = (y) => o.clone().multiplyScalar(rAt(y) - 0.012 * D).setY(y);
    str.push(strut(atS(ringH), atS(H - ringH), 0.012 * D, 0.016 * D, o));
  }
  const strQ = merge(str); // quarter q = quarter 0 turned by q·π/2
  for (let q = 0; q < 4; q++) P(strQ, mats.interior, { ry: (q * Math.PI) / 2, order: 0.2 + q * 0.02, dir: radialPhi((q * Math.PI) / 2 + Math.PI / 4), dist: shellDist * 0.6, kind: "interior" });
  // Separation pushers (base flange, cylinder, rod, pad) between the clamps, one shared geometry.
  const pY = H - ringH - 0.12 * H;
  const pusher = merge([cyl(0.045 * D, 0.045 * D, 0.012 * H, 12, 0, pY - 0.004 * H), cyl(0.03 * D, 0.03 * D, 0.085 * H, 12, 0, pY), cyl(0.018 * D, 0.018 * D, 0.03 * H, 10, 0, pY + 0.085 * H), cyl(0.03 * D, 0.03 * D, 0.006 * H, 10, 0, pY + 0.114 * H)]);
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) * TAU) / 8;
    const r = rAt(H) * 0.82;
    P(pusher, mats.actuator, { x: r * Math.cos(a), z: r * Math.sin(a), order: 0.4 + k * 0.004, dir: UP, dist: 0.08, ax: ["i", 1, 1] });
  }
  // Separation clamps against the top ring's inner face (block, jaw, tension bolt), built along +X and turned.
  const yC = H - ringH - 0.035 * H;
  const rC = rAt(H - ringH) * 0.97 - 0.045 * D;
  const sepClamp = merge([box(0.05 * D, 0.07 * H, 0.09 * D, 0, yC, 0), box(0.02 * D, 0.05 * H, 0.12 * D, 0.03 * D, yC, 0), cyl(0.014 * D, 0.014 * D, 0.06 * H, 8, -0.02 * D, yC - 0.095 * H, 0)]);
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4;
    P(sepClamp, mats.steelDark, { x: rC * Math.cos(a), z: rC * Math.sin(a), ry: -a, order: 0.44 + k * 0.004, dir: UP, dist: 0.08, ax: ["i", 1, 1] });
  }
  const mat = finishMat(mats, g.finish);
  const iq = latheUV(lathe([[rAt(ringH * 0.5), ringH * 0.5], [rAt(H - ringH * 0.5), H - ringH * 0.5]], 24, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H, R: (Rb + Rt) / 2 });
  // 12 raised external longerons (3 per quarter), drawn as structural lines; the panel seams stay fine.
  const ribD = 0.012 * D;
  const ribs = [];
  for (let j = 0; j < 3; j++) {
    const o = radialPhi(((j + 0.5) * (Math.PI / 2)) / 3);
    const atR = (y) => o.clone().multiplyScalar(rAt(y) + ribD / 2).setY(y);
    ribs.push(strut(atR(ringH), atR(H - ringH), 0.016 * D, ribD, o));
  }
  const ribGeo = projectUV(merge(ribs));
  const iqRibbed = merge([iq.clone(), ribGeo.clone()]);
  // Rivets (instanced, shared by the quarters): a row inside each seam, an arc above the bottom ring's tori
  // and one below the top ring's.
  const rv = Math.max(0.01, 0.0042 * D);
  const pitch = 8 * rv;
  const dl = (0.008 * D) / Math.max(Rb, Rt);
  const rl = [];
  const [ya, yb] = [ringH + 0.06 * D, H - ringH - 0.06 * D];
  for (const phi of [dl, Math.PI / 2 - dl]) {
    const o = radialPhi(phi);
    rl.push(...rivetRow(o.clone().multiplyScalar(rAt(ya)).setY(ya), o.clone().multiplyScalar(rAt(yb)).setY(yb), pitch, rv));
  }
  for (const y of [ya - 0.012 * D, yb + 0.012 * D]) rl.push(...rivetArc(rAt(y), y, 2 * dl, Math.PI / 2 - 2 * dl, pitch, rv));
  const rivets = rivetsOn(g.finish) ? instAttr(g.finish === "white-black-roll" ? offRoll(rl, H) : rl) : null;
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    const pc = P(iqRibbed, mat, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist, side: DS, kind: "shell", lineGeo: ribGeo, fineGeo: iq });
    if (rivets) addDetail(pc, "rivet", rivets, { lookOnly: "painted", color: rivetTint(pc.mesh) });
  }
  // Raceway continuing up the interstage (in line with the tanks'), two segments with merged straps.
  const rwA = Math.PI / 2;
  const rwD = 0.025 * D;
  const rwW = 0.06 * D;
  const out_ = v3(1, 0, 0);
  [[ringH + 0.05 * D, H / 2 - 0.01 * H], [H / 2 + 0.01 * H, H - ringH - 0.05 * D]].forEach(([y0, y1], k) => {
    const plate = strut(v3(rAt(y0) + rwD / 2, y0, 0), v3(rAt(y1) + rwD / 2, y1, 0), rwW, rwD, out_);
    const straps = [];
    for (let y = y0 + 0.3; y < y1 - 0.2; y += 0.9) straps.push(strut(v3(rAt(y) + rwD * 0.85, y - 0.04, 0), v3(rAt(y) + rwD * 0.85, y + 0.04, 0), rwW * 1.4, rwD * 1.7, out_));
    P(projectUV(merge([plate.clone(), ...straps])), mats.raceway, { ry: -rwA, order: 1.3 + k * 0.01, dir: radial(rwA, k ? 0.12 : -0.12), dist: shellDist * 1.1, edges: true, lineGeo: plate });
  });
  const [topGeo, topLines] = jointRing(Rt, H - ringH, false);
  P(topGeo, mats.machined, { order: 2, dir: UP, dist: 0.1, ax: ["i", 1, 0], sym: true, edges: true, lineGeo: topLines });
  if (g.features?.includes("grid-fins")) {
    const yTop = H - ringH - 0.04 * H;
    gridFins(out, mats, rAt(yTop - 0.4 * D), rAt(yTop), yTop, D, shellDist);
  }
  if (g.features?.includes("ullage-motors")) {
    // Eight ullage-motor housings: half-cone fairings on the skin, nose up, a nozzle cut-out at the bottom.
    const hh = 0.55 * H;
    const hr = 0.035 * D;
    const housings = [];
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) * TAU) / 8;
      const y = 0.18 * H;
      const prof = [[hr * 0.8, 0], [hr, 0.08 * hh], [hr, 0.7 * hh], [hr * 0.5, 0.92 * hh], [0.001, hh]];
      housings.push(projectUV(lathe(prof, 12, -Math.PI / 2, Math.PI).translate(0, y, 0).translate(rAt(y + hh / 2) - 0.2 * hr, 0, 0).rotateY(-a)));
      housings.push(projectUV(new THREE.CylinderGeometry(hr * 0.55, hr * 0.75, 0.06 * hh, 12, 1, true).translate(rAt(y) + 0.45 * hr, y - 0.03 * hh, 0).rotateY(-a)));
    }
    P(merge(housings), mats.trim, { order: 1.5, dir: UP, dist: shellDist * 1.1, side: DS, edges: true });
  }
  return out;
}

// ---------- payloads ----------

// Payload pieces are tagged in group "p": the main body is the core, small bits stack above or below it. The
// adapter section (attach fitting and clamp band, or the capsule's instrument ring and its equipment) carries
// mesh.userData.adapter = true: hide by that tag when the payload flies or lands on its own.
function adapterPieces(out, mats, g) {
  const Rt = g.stageD_m / 2;
  const Rp = g.D_m / 2;
  const h = g.adapterH_m;
  if (g.archetype === "capsule") {
    // Instrument-unit style ring at the stage diameter (visual).
    out.push(piece(machinedRing(Rt * 0.94, Rt, h, 0), mats.trim, { order: 0, dir: DOWN, dist: 0.12, ax: ["p", -1, 9], sym: true, edges: true }));
    out.at(-1).mesh.userData.adapter = true;
    return;
  }
  // Payload attach fitting (cone) + machined clamp band at the payload interface.
  const rb = 0.42 * g.stageD_m;
  const rtop = Math.min(0.62 * Rp, rb);
  out.push(piece(projectUV(lathe([[0.001, 0], [rb, 0], [rtop, h * 0.9], [0.001, h * 0.9]], 48)), mats.metal, { order: 0, dir: DOWN, dist: 0.14, ax: ["p", -1, 9], sym: true, edges: true }));
  const cb = Math.max(0.015, 0.012 * rtop);
  const clampRing = machinedRing(rtop * 0.85, rtop * 1.05, h * 0.1, h * 0.9);
  out.push(piece(merge([clampRing.clone(), boltRing(rtop * 1.06, h * 0.95, 24, cb, cb, cb * 0.8)]), mats.machined, { order: 0.05, dir: DOWN, dist: 0.07, ax: ["p", -1, 8], sym: true, edges: true, lineGeo: clampRing }));
  for (const p of out.slice(-2)) p.mesh.userData.adapter = true;
}

function buildPayload(spec, mats) {
  const g = spec.geom;
  const out = [];
  adapterPieces(out, mats, g);
  const y0 = g.adapterH_m;
  const R = g.D_m / 2;
  const H = g.H_m;
  // P(geo, mat, { order, dir, dist, side, ax: [side, rank], sym, kind }) — ax defaults to the core; returns the
  // piece (for instanced detail).
  const P = (geo, mat, { ax = [0, 0], ...o } = {}) => {
    const pc = piece(geo, mat, { order: 1, dir: UP, dist: 0.35, ...o, ax: ["p", ...ax] });
    out.push(pc);
    return pc;
  };
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
// Helpers for the close-up details: a uniform vertex colour (foil pieces read colour per vertex), a prism with
// a colour per side face, an indexed copy of a non-indexed geometry, a cone nozzle pointing along dir.
const FOIL = { gold: [0.58, 0.37, 0.07], black: [0.018, 0.018, 0.02], silver: [0.58, 0.6, 0.63] };
function tint(geo, rgb) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(rgb, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}
function prism(r, h, sides, sideColor, capColor, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, sides).toNonIndexed();
  const p = g.attributes.position;
  const c = new Float32Array(p.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    d.fromBufferAttribute(p, i + 2);
    const n = b.clone().sub(a).cross(d.clone().sub(a)).normalize();
    const m = a.add(b).add(d).multiplyScalar(1 / 3);
    const k = Math.floor((((Math.atan2(m.x, m.z) + TAU) % TAU) / TAU) * sides) % sides;
    const col = Math.abs(n.y) > 0.6 ? capColor : sideColor(k);
    for (let j = 0; j < 3; j++) c.set(col, (i + j) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}
const indexed = (g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]));
function nozzle(at, dir, len, r) {
  return new THREE.CylinderGeometry(r * 0.35, r, len, 10, 1, true).translate(0, len / 2, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize())).translate(at.x, at.y, at.z);
}

// Telescope (Hubble): aft bulkhead, aft shroud with bay doors, its trunnion pins, the light-shield tube with
// ring frames and handrails, two thin solar wings on masts with their drive bases, two high-gain antennas
// folded along the tube, two magnetometers, the aperture door on its hinge bracket.
function telescope(P, mats, R, H, y0) {
  const ribs = [...Array(8).keys()].map((k) => box(0.9 * R, 0.012 * H, 0.025 * R, 0.45 * R, y0 + 0.004 * H, 0).rotateY((-k * TAU) / 8));
  P(projectUV(merge([cyl(0.95 * R, 0.95 * R, 0.012 * H, 32, 0, y0 + 0.008 * H), ...ribs])), mats.darkMetal, { order: 0.98, dist: 0.18, ax: [-1, 1], sym: true });
  const doors = [];
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) * TAU) / 8;
    doors.push(box(0.012 * R, 0.2 * H, 0.42 * R, R * 0.97 + 0.004 * R, y0 + 0.17 * H, 0).rotateY(-a), box(0.02 * R, 0.012 * H, 0.08 * R, R * 0.985, y0 + 0.17 * H, 0).rotateY(-a));
  }
  const shroud = projectUV(cyl(R * 0.97, R * 0.97, 0.36 * H, 12, 0, y0));
  P(projectUV(merge([shroud.clone(), ...doors])), mats.mliSilver, { order: 1, dist: 0.2, ax: [-1, 0], sym: true, kind: "shell", lineGeo: shroud });
  // trunnion pins between the bay doors (the shuttle-bay latches), stopping inside the envelope
  const pins = [0, 1, 2, 3].map((k) => new THREE.CylinderGeometry(0.03 * R, 0.03 * R, 0.05 * R, 10).rotateZ(Math.PI / 2).translate(0.975 * R, y0 + 0.3 * H, 0).rotateY((-k * TAU) / 4 - Math.PI / 4));
  P(projectUV(merge(pins)), mats.machined, { order: 1.01, dist: 0.25, ax: [-1, 0] });
  const tubeRings = [0.3, 0.55, 0.8, 0.94].map((f) => projectUV(new THREE.TorusGeometry(R * 0.745, 0.006 * R, 4, 32).rotateX(Math.PI / 2).translate(0, y0 + 0.36 * H + f * 0.6 * H, 0)));
  const rails = [0, 1, 2, 3].map((k) => {
    const a = (k * TAU) / 4 + 0.3;
    return projectUV(cyl(0.008 * R, 0.008 * R, 0.55 * H, 6, Math.cos(a) * R * 0.77, y0 + 0.38 * H, Math.sin(a) * R * 0.77));
  });
  const tube = projectUV(cyl(R * 0.74, R * 0.74, 0.6 * H, 40, 0, y0 + 0.36 * H));
  P(projectUV(merge([tube.clone(), ...tubeRings, ...rails])), mats.mliSilver, { order: 1.1, dist: 0.35, sym: true, kind: "shell", lineGeo: merge([tube, ...tubeRings]) });
  for (const s of [1, -1]) {
    // a mast with two thin blankets either side of it, framed
    const wing = [];
    const yc = y0 + 0.62 * H;
    for (const half of [-1, 1]) {
      const zc = s * 0.86 * R + half * 0.085 * R;
      wing.push(box(0.012 * R, 0.5 * H, 0.15 * R, 0, yc, zc), box(0.02 * R, 0.5 * H, 0.008 * R, 0, yc, zc + half * 0.075 * R));
    }
    wing.push(cyl(0.02 * R, 0.02 * R, 0.52 * H, 8, 0, y0 + 0.37 * H, s * 0.86 * R), cyl(0.035 * R, 0.035 * R, 0.06 * H, 8, 0.2 * R, y0 + 0.37 * H, s * 0.86 * R));
    P(projectUV(merge(wing)), mats.panel, {
      order: 1.2 + (s > 0 ? 0 : 0.02),
      dir: v3(0, 0.3, s),
      dist: 0.4,
      // unfold 90° about the bottom inner edge so the array points out along ±Z (axis ±X turns +Y toward ±Z)
      deploy: { axis: v3(s, 0, 0), pivot: v3(0, y0 + 0.37 * H, s * 0.7 * R), angle: Math.PI / 2, order: 1 },
    });
    // the wing's drive base on the shroud's rim (does not deploy)
    P(projectUV(merge([box(0.14 * R, 0.03 * H, 0.12 * R, 0, y0 + 0.36 * H, s * 0.82 * R), cyl(0.03 * R, 0.03 * R, 0.02 * H, 10, 0, y0 + 0.375 * H, s * 0.82 * R)])), mats.darkMetal, { order: 1.19 + (s > 0 ? 0 : 0.02), dir: v3(0, 0.2, s), dist: 0.3 });
  }
  // high-gain antennas folded along the tube at ±X: a boom, its hinge block and a dish facing out
  const hgaDish = [];
  for (let i = 0; i <= 8; i++) hgaDish.push([0.15 * R * (i / 8), 0.035 * R * (i / 8) ** 2]);
  for (const sx of [1, -1]) {
    const x = sx * 0.83 * R;
    const dish = lathe(hgaDish, 20).rotateZ((-sx * Math.PI) / 2).translate(x + sx * 0.04 * R, y0 + 0.82 * H, 0);
    P(projectUV(merge([cyl(0.015 * R, 0.015 * R, 0.37 * H, 8, x, y0 + 0.45 * H, 0), box(0.06 * R, 0.03 * H, 0.06 * R, x - sx * 0.05 * R, y0 + 0.45 * H, 0), dish])), mats.trim, { order: 1.15 + (sx > 0 ? 0 : 0.005), dir: v3(sx, 0.4, 0), dist: 0.45, side: DS });
  }
  // magnetometers near the top of the light shield
  [Math.PI / 4, (5 * Math.PI) / 4].forEach((a, k) => {
    const o = radial(a);
    P(projectUV(box(0.08 * R, 0.05 * H, 0.08 * R, o.x * 0.79 * R, y0 + 0.9 * H, o.z * 0.79 * R)), mats.mliSilver, { order: 1.3 + k * 0.005, dir: radial(a, 0.5), dist: 0.5 });
  });
  // the door's hinge bracket on the tube rim (fixed; the door swings above it)
  P(projectUV(merge([box(0.06 * R, 0.05 * H, 0.22 * R, 0.77 * R, y0 + 0.93 * H, 0), box(0.1 * R, 0.01 * H, 0.06 * R, 0.79 * R, y0 + 0.95 * H, 0.08 * R), box(0.1 * R, 0.01 * H, 0.06 * R, 0.79 * R, y0 + 0.95 * H, -0.08 * R)])), mats.darkMetal, { order: 1.38, dir: v3(1, 0.4, 0), dist: 0.5 });
  const door = merge([cyl(R * 0.77, R * 0.77, 0.025 * H, 40, 0, y0 + 0.96 * H), box(0.12 * R, 0.04 * H, 0.2 * R, R * 0.74, y0 + 0.965 * H, 0)]);
  P(projectUV(merge([door.clone(), new THREE.TorusGeometry(R * 0.6, 0.012 * R, 6, 40).rotateX(Math.PI / 2).translate(0, y0 + 0.987 * H, 0)])), mats.machined, {
    order: 1.4,
    dist: 0.6,
    ax: [1, 0],
    edges: true,
    lineGeo: door,
    // aperture door swings open 110° about its hinge on the +X rim (axis −Z lifts the far side)
    deploy: { axis: v3(0, 0, -1), pivot: v3(0.77 * R, y0 + 0.985 * H, 0), angle: (110 * Math.PI) / 180, order: 0 },
  });
}

// Stowed JWST: spacecraft bus at the base with its folded solar panel, high-gain antenna, momentum flap and
// star trackers; two folded sunshield pallets (stacked membranes in a frame); the primary mirror of 18 gold
// hexagonal segments (the centre section facing out, the two three-segment wings folded back); its black
// backplane with the instrument radiators behind it; the aft optics bench; the folded secondary-mirror struts
// and the secondary mirror.
function webb(P, mats, R, H, y0) {
  P(projectUV(box(1.1 * R, 0.16 * H, 1.1 * R, 0, y0 + 0.08 * H)), mats.gold, { order: 1, dist: 0.2, ax: [-1, 0] });
  P(projectUV(box(0.9 * R, 0.12 * H, 0.02 * R, 0, y0 + 0.08 * H, -0.565 * R)), mats.panel, { order: 1.01, dir: v3(0, -0.2, -1), dist: 0.3, ax: [-1, 0] });
  const hga = [];
  for (let i = 0; i <= 8; i++) hga.push([0.16 * R * (i / 8), 0.04 * R * (i / 8) ** 2]);
  P(projectUV(merge([lathe(hga, 20).rotateX(Math.PI / 2).translate(0.25 * R, y0 + 0.08 * H, 0.6 * R), new THREE.CylinderGeometry(0.02 * R, 0.02 * R, 0.06 * R, 8).rotateX(Math.PI / 2).translate(0.25 * R, y0 + 0.08 * H, 0.575 * R)])), mats.trim, { order: 1.02, dir: v3(0, -0.2, 1), dist: 0.3, side: DS, ax: [-1, 0] });
  P(projectUV(box(0.5 * R, 0.05 * H, 0.015 * R, 0, y0 + 0.185 * H, -0.56 * R)), mats.mliSilver, { order: 1.03, dir: v3(0, 0.3, -1), dist: 0.35 });
  P(projectUV(merge([box(0.1 * R, 0.04 * H, 0.1 * R, 0.4 * R, y0 + 0.18 * H, -0.42 * R), box(0.1 * R, 0.04 * H, 0.1 * R, -0.4 * R, y0 + 0.18 * H, -0.42 * R)])), mats.darkMetal, { order: 1.04, dist: 0.3 });
  // Hex segments, flat-topped: column spacing 1.5 s, row spacing √3 s; rings 1-2 around an empty centre.
  const sH = 0.19 * R;
  const zc = 0.24 * R;
  const yc = y0 + 0.16 * H + 0.36 * H;
  const segs = [];
  const seg = () => new THREE.CylinderGeometry(sH * 0.96, sH * 0.96, 0.03 * R, 6).rotateY(Math.PI / 6).rotateX(Math.PI / 2);
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const sum = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(sum)) > 2 || (q === 0 && r === 0)) continue;
      const x = 1.5 * sH * q;
      const y = Math.sqrt(3) * sH * (r + q / 2);
      const g = seg();
      if (Math.abs(q) < 2) segs.push(g.translate(x, yc + y, zc));
      else {
        // side wing: hinged at x = ±2.25 s and folded back 100°
        const sx = Math.sign(q);
        const hingeX = sx * 2.25 * sH;
        g.translate(x - hingeX, yc + y, 0).rotateY((sx * 100 * Math.PI) / 180).translate(hingeX, 0, zc);
        segs.push(g);
      }
    }
  }
  P(projectUV(merge(segs)), mats.mirror, { order: 1.1, dist: 0.5, edges: true });
  for (const s of [1, -1]) {
    // pallets unfold 90° about their bottom inner edge (axis ∓Z turns +Y toward ±X): five membranes in a frame
    const deploy = { axis: v3(0, 0, -s), pivot: v3(s * 0.65 * R, y0 + 0.16 * H, 0), angle: Math.PI / 2, order: 0 };
    const layers = [0, 1, 2, 3, 4].map((k) => box(0.012 * R, 0.6 * H, 1.06 * R, s * (0.66 * R + k * 0.028 * R), y0 + 0.16 * H + 0.31 * H, 0));
    const frame = [box(0.14 * R, 0.02 * H, 1.1 * R, s * 0.72 * R, y0 + 0.17 * H, 0), box(0.14 * R, 0.02 * H, 1.1 * R, s * 0.72 * R, y0 + 0.77 * H, 0)];
    P(projectUV(merge([...layers, ...frame])), mats.mliSilver, { order: 1.2 + (s > 0 ? 0 : 0.02), dir: v3(s, 0.3, 0), dist: 0.45, edges: true, lineGeo: merge(frame), deploy });
  }
  P(projectUV(box(5 * sH, 5 * Math.sqrt(3) * sH, 0.08 * R, 0, yc, zc - 0.07 * R)), mats.darkMetal, { order: 1.12, dir: v3(0, 0.2, -1), dist: 0.45 }); // backplane, just behind the segments
  P(projectUV(merge([box(0.6 * R, 0.1 * H, 0.015 * R, 0, yc - 0.12 * H, zc - 0.13 * R), box(0.6 * R, 0.1 * H, 0.015 * R, 0, yc + 0.12 * H, zc - 0.13 * R)])), mats.metal, { order: 1.13, dir: v3(0, 0.1, -1), dist: 0.55 }); // instrument radiators
  P(projectUV(box(0.5 * R, 0.3 * H, 0.4 * R, 0, y0 + 0.16 * H + 0.15 * H, -0.2 * R)), mats.darkMetal, { order: 1.14, dist: 0.4 }); // aft optics bench
  P(projectUV(merge([cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, -0.3 * R, y0 + 0.82 * H, 0.3 * R), cyl(0.04 * R, 0.04 * R, 0.16 * H, 8, 0.3 * R, y0 + 0.82 * H, 0.3 * R)])), mats.darkMetal, { order: 1.3, dist: 0.7, ax: [1, 0] }); // secondary-mirror struts
  P(projectUV(cyl(0.18 * R, 0.18 * R, 0.02 * H, 24, 0, y0 + 0.96 * H, 0.3 * R)), mats.mirror, { order: 1.31, dist: 0.8, ax: [1, 1], sym: true }); // secondary mirror
}

// Weather satellite (GOES-R): base ring (bolt circle instanced) with two thruster pods at the bus corners, the
// blanketed box bus with radiator panels on two faces, one large solar wing (five framed panels on a yoke) on
// its drive, the magnetometer boom as a folded lattice with its canister, the instrument deck with its
// apertures, the imager with its sunshade, the lightning mapper, star trackers, two omni antennas, the dish.
function weatherSat(P, mats, R, H, y0) {
  const s = 1.25 * R; // square bus inside the envelope (corner at 0.88 R)
  const base = P(projectUV(merge([cyl(0.5 * R, 0.5 * R, 0.08 * H, 32, 0, y0), cyl(0.53 * R, 0.53 * R, 0.012 * H, 32, 0, y0 + 0.068 * H)])), mats.machined, { order: 1, dist: 0.15, ax: [-1, 0], sym: true });
  addDetail(base, "bolt", boltCircle(0.515 * R, y0 + 0.08 * H, 24, 0.014 * R));
  for (const sg of [1, -1]) {
    // a thruster pod at a lower bus corner: block, one nozzle down, one canted out
    const c = v3(sg * 0.66 * R, y0 + 0.12 * H, sg * 0.66 * R);
    const o = v3(sg, 0, sg).normalize();
    const pod = merge([box(0.09 * R, 0.05 * H, 0.09 * R, c.x, c.y, c.z), nozzle(c.clone().add(v3(0, -0.025 * H, 0)), DOWN, 0.04 * H, 0.03 * R), nozzle(c.clone().addScaledVector(o, 0.045 * R), o.clone().add(v3(0, -0.3, 0)), 0.035 * H, 0.025 * R)].map(indexed));
    P(projectUV(pod), mats.darkMetal, { order: 1.02 + (sg > 0 ? 0 : 0.005), dir: v3(sg, -0.4, sg), dist: 0.25, side: DS });
  }
  P(projectUV(box(s, 0.55 * H, s, 0, y0 + 0.08 * H + 0.275 * H)), mats.gold, { order: 1.1, dist: 0.3, kind: "shell" });
  for (const sz of [1, -1]) {
    // radiator panel (three ribs) on a ±Z face
    const z = sz * (s / 2 + 0.008 * R);
    P(projectUV(merge([box(0.9 * s, 0.4 * H, 0.012 * R, 0, y0 + 0.36 * H, z), ...[0, 1, 2].map((k) => box(0.9 * s, 0.006 * H, 0.02 * R, 0, y0 + 0.2 * H + k * 0.16 * H, z + sz * 0.006 * R))])), mats.metal, { order: 1.12 + (sz > 0 ? 0 : 0.005), dir: v3(0, 0.25, sz), dist: 0.4 });
  }
  // solar wing: five panels up the hinge line with small gaps, a frame and a yoke down to the hinge
  const wing = [];
  const panelH = (0.8 * H - 4 * 0.012 * H) / 5;
  for (let k = 0; k < 5; k++) {
    const yc = y0 + 0.1 * H + 0.03 * H + k * (panelH + 0.012 * H) + panelH / 2;
    wing.push(box(0.04 * R, panelH, 1.08 * R, 0.66 * R, yc, 0), box(0.05 * R, panelH, 0.02 * R, 0.66 * R, yc, 0.55 * R), box(0.05 * R, panelH, 0.02 * R, 0.66 * R, yc, -0.55 * R));
  }
  wing.push(strut(v3(0.625 * R, y0 + 0.1 * H, 0.2 * R), v3(0.66 * R, y0 + 0.13 * H, 0.45 * R), 0.03 * R, 0.03 * R, v3(1, 0, 0)), strut(v3(0.625 * R, y0 + 0.1 * H, -0.2 * R), v3(0.66 * R, y0 + 0.13 * H, -0.45 * R), 0.03 * R, 0.03 * R, v3(1, 0, 0)));
  P(projectUV(merge(wing)), mats.panel, {
    order: 1.2,
    dir: v3(1, 0.3, 0),
    dist: 0.45,
    // the wing unfolds 90° about its bottom edge on the bus side (axis −Z turns +Y toward +X)
    deploy: { axis: v3(0, 0, -1), pivot: v3(0.625 * R, y0 + 0.1 * H, 0), angle: Math.PI / 2, order: 0 },
  });
  // the wing's drive (fixed, at the hinge on the bus face)
  P(projectUV(merge([box(0.07 * R, 0.07 * H, 0.32 * R, 0.6 * R, y0 + 0.115 * H, 0), new THREE.CylinderGeometry(0.06 * R, 0.06 * R, 0.08 * R, 14).rotateZ(Math.PI / 2).translate(0.655 * R, y0 + 0.115 * H, 0)])), mats.darkMetal, { order: 1.19, dir: v3(1, 0.1, 0), dist: 0.3 });
  // magnetometer boom: a triangular lattice (three longerons, zigzag bracing); its canister on top
  const boom = [];
  const bx = -0.66 * R;
  const br = 0.035 * R;
  const corner = (i, y) => v3(bx + br * Math.cos((i * TAU) / 3), y, br * Math.sin((i * TAU) / 3));
  const yb0 = y0 + 0.1 * H;
  const yb1 = y0 + 0.78 * H;
  for (let i = 0; i < 3; i++) boom.push(rod(corner(i, yb0), corner(i, yb1), 0.005 * R));
  const bays = 10;
  for (let k = 0; k < bays; k++) {
    const ya = yb0 + ((yb1 - yb0) * k) / bays;
    const yb = yb0 + ((yb1 - yb0) * (k + 1)) / bays;
    for (let i = 0; i < 3; i++) boom.push(rod(corner(i, ya), corner((i + 1) % 3, yb), 0.0035 * R, 1));
  }
  P(projectUV(merge(boom)), mats.darkMetal, { order: 1.25, dir: v3(-1, 0.3, 0), dist: 0.4 });
  P(projectUV(merge([cyl(0.045 * R, 0.045 * R, 0.06 * H, 12, bx, yb1), cyl(0.05 * R, 0.05 * R, 0.008 * H, 12, bx, yb1 + 0.06 * H)])), mats.mliSilver, { order: 1.26, dir: v3(-1, 0.6, 0), dist: 0.5 });
  const aperture = (z, r) => new THREE.CylinderGeometry(r, r, 0.08 * R, 24).rotateX(Math.PI / 2).translate(-0.15 * R, y0 + 0.75 * H, z);
  const deck = box(0.9 * R, 0.25 * H, 0.7 * R, -0.05 * R, y0 + 0.63 * H + 0.125 * H, 0);
  P(projectUV(merge([deck.clone(), aperture(0.37 * R, 0.12 * R), aperture(-0.37 * R, 0.08 * R)])), mats.mliSilver, { order: 1.3, dist: 0.5, ax: [1, 0], edges: true, lineGeo: deck });
  // on the deck: the imager with its sunshade and aperture, the lightning mapper, two star trackers on the
  // deck's −Z face, two omni antennas on masts
  P(projectUV(merge([box(0.3 * R, 0.08 * H, 0.26 * R, -0.25 * R, y0 + 0.92 * H, -0.12 * R), box(0.32 * R, 0.012 * H, 0.06 * R, -0.25 * R, y0 + 0.966 * H, -0.24 * R), new THREE.CylinderGeometry(0.07 * R, 0.07 * R, 0.03 * R, 18).rotateX(Math.PI / 2).translate(-0.25 * R, y0 + 0.92 * H, 0.02 * R)])), mats.trim, { order: 1.32, dist: 0.55, ax: [1, 0] });
  const tracker = (x) => merge([box(0.08 * R, 0.08 * R, 0.08 * R, x, y0 + 0.8 * H, -0.39 * R), lathe([[0.025 * R, 0], [0.04 * R, 0.06 * R]], 10).rotateX(-Math.PI / 2).translate(x, y0 + 0.8 * H, -0.43 * R)]);
  P(projectUV(merge([tracker(-0.3 * R), tracker(-0.1 * R)])), mats.darkMetal, { order: 1.33, dist: 0.5, side: DS, ax: [1, 0] });
  P(projectUV(merge([box(0.14 * R, 0.06 * H, 0.12 * R, 0.05 * R, y0 + 0.91 * H, -0.2 * R), cyl(0.04 * R, 0.04 * R, 0.02 * H, 14, 0.05 * R, y0 + 0.94 * H, -0.2 * R)])), mats.mliSilver, { order: 1.335, dist: 0.55, ax: [1, 0] });
  const omni = (x, z) => merge([cyl(0.008 * R, 0.008 * R, 0.06 * H, 6, x, y0 + 0.88 * H, z), lathe([[0.035 * R, 0], [0.012 * R, 0.035 * H], [0.001, 0.04 * H]], 10).translate(x, y0 + 0.94 * H, z)]);
  P(projectUV(omni(-0.45 * R, 0.28 * R)), mats.metal, { order: 1.34, dist: 0.6, ax: [1, 0] });
  P(projectUV(omni(0.38 * R, -0.3 * R)), mats.metal, { order: 1.345, dist: 0.6, ax: [1, 0] });
  const dish = [];
  for (let i = 0; i <= 10; i++) dish.push([0.28 * R * (i / 10), 0.06 * H * (i / 10) ** 2]);
  // dish tilts out 60° about its base (axis +X turns +Y toward +Z, away from the deck)
  P(projectUV(lathe(dish, 32).translate(0.3 * R, y0 + 0.9 * H, 0.2 * R)), mats.trim, {
    order: 1.4,
    dist: 0.7,
    side: DS,
    ax: [1, 1],
    deploy: { axis: v3(1, 0, 0), pivot: v3(0.3 * R, y0 + 0.9 * H, 0.2 * R), angle: Math.PI / 3, order: 1 },
  });
}

// Lander (Nova-C): main engine on its thrust ring, two propellant tanks and their domes above the top deck, the
// hexagonal body in gold MLI, three solar panels on alternate faces, the laser rangefinder and cameras on
// another, the top deck with the antenna mast and dish and a star tracker, six RCS clusters at the corners,
// six legs (one piece each, splaying about their own hinge) with a footpad on a ball joint, level once
// deployed.
function lander(P, mats, R, H, y0) {
  const rb = 0.62 * R;
  const bell = [];
  for (let i = 0; i <= 12; i++) {
    const f = i / 12;
    bell.push([0.07 * R + 0.09 * R * (1 - f) ** 1.8, 0.14 * H * f]);
  }
  bell.push([0.1 * R, 0.15 * H], [0.1 * R, 0.17 * H], [0.06 * R, 0.18 * H]);
  P(projectUV(lathe(bell, 28).translate(0, y0 + 0.12 * H, 0)), mats.darkMetal, { order: 0.9, dist: 0.25, side: DS, ax: [-1, 0], sym: true });
  const mount = [new THREE.TorusGeometry(0.13 * R, 0.015 * R, 6, 24).rotateX(Math.PI / 2).translate(0, y0 + 0.27 * H, 0)];
  for (let k = 0; k < 4; k++) {
    const a = ((k + 0.5) * TAU) / 4;
    mount.push(rod(v3(0.13 * R * Math.cos(a), y0 + 0.27 * H, 0.13 * R * Math.sin(a)), v3(0.45 * R * Math.cos(a), y0 + 0.285 * H, 0.45 * R * Math.sin(a)), 0.012 * R, 1));
  }
  P(projectUV(merge(mount)), mats.darkMetal, { order: 0.91, dist: 0.2, sym: true });
  const ts = 0.26 * R;
  for (const sx of [1, -1]) P(new THREE.SphereGeometry(ts, 20, 14).translate(sx * 0.3 * R, y0 + 0.5 * H, 0), mats.interior, { order: 0.95 + (sx > 0 ? 0 : 0.005), dir: v3(sx, 0.4, 0), dist: 0.15, kind: "interior" });
  for (const sx of [-1, 1]) P(new THREE.SphereGeometry(0.16 * R, 20, 8, 0, TAU, 0, Math.PI / 2).translate(sx * 0.27 * R, y0 + 0.9 * H, -0.15 * R), mats.interior, { order: 1.36 + (sx > 0 ? 0.005 : 0), dir: v3(sx, 1, 0), dist: 0.3, kind: "interior" });
  P(projectUV(cyl(rb, rb, 0.5 * H, 6, 0, y0 + 0.28 * H)), mats.gold, { order: 1, dist: 0.35, kind: "shell" });
  // Hex faces (CylinderGeometry corners at x = r sin a, z = r cos a, so face centres at azimuth 0°, 60°, …):
  // panels on three alternate faces, the rangefinder box on another.
  const apothem = rb * Math.cos(Math.PI / 6);
  [0, 1, 2].forEach((i) => {
    const a = (i * TAU) / 3;
    P(projectUV(box(0.02 * R, 0.4 * H, rb * 0.85, apothem + 0.012 * R, y0 + 0.53 * H, 0).rotateY(-a)), mats.panel, { order: 1.1 + i * 0.005, dir: radial(a, 0.3), dist: 0.4 });
  });
  {
    const a = Math.PI / 3;
    const lidar = merge([box(0.06 * R, 0.07 * H, 0.12 * R, apothem + 0.03 * R, y0 + 0.42 * H, 0), new THREE.CylinderGeometry(0.03 * R, 0.03 * R, 0.03 * R, 12).rotateZ(Math.PI / 2).translate(apothem + 0.07 * R, y0 + 0.43 * H, 0.02 * R), new THREE.CylinderGeometry(0.02 * R, 0.02 * R, 0.03 * R, 10).rotateZ(Math.PI / 2).translate(apothem + 0.07 * R, y0 + 0.41 * H, -0.035 * R)]);
    P(projectUV(lidar.rotateY(-a)), mats.darkMetal, { order: 1.12, dir: radial(a, 0.2), dist: 0.45 });
  }
  const dish = [];
  for (let i = 0; i <= 8; i++) dish.push([0.2 * R * (i / 8), 0.05 * H * (i / 8) ** 2]);
  P(projectUV(cyl(0.4 * R, 0.45 * R, 0.12 * H, 6, 0, y0 + 0.78 * H)), mats.gold, { order: 1.3, dist: 0.6, ax: [1, 0], edges: true });
  P(projectUV(cyl(0.015 * R, 0.015 * R, 0.03 * H, 8, 0, y0 + 0.9 * H, 0.24 * R)), mats.metal, { order: 1.31, dist: 0.65, ax: [1, 0] });
  P(projectUV(lathe(dish, 24).translate(0, y0 + 0.93 * H, 0.24 * R)), mats.trim, { order: 1.315, dist: 0.7, side: DS, ax: [1, 1] });
  P(projectUV(merge([box(0.07 * R, 0.04 * H, 0.07 * R, -0.25 * R, y0 + 0.92 * H, 0.2 * R), lathe([[0.02 * R, 0], [0.035 * R, 0.03 * H]], 10).translate(-0.25 * R, y0 + 0.94 * H, 0.2 * R)])), mats.darkMetal, { order: 1.32, dist: 0.6, side: DS, ax: [1, 0] });
  // RCS: a block at each hex corner with thrusters up, down and to both sides, one piece per corner.
  for (let k = 0; k < 6; k++) {
    const a = (k * TAU) / 6; // CylinderGeometry corners: x = r sin a, z = r cos a
    const o = v3(Math.sin(a), 0, Math.cos(a));
    const t = v3(Math.cos(a), 0, -Math.sin(a));
    const c = o.clone().multiplyScalar(rb + 0.03 * R).setY(y0 + 0.74 * H);
    const n = 0.05 * R;
    const rcs = [indexed(box(0.06 * R, 0.06 * R, 0.06 * R, c.x, c.y, c.z)), nozzle(c.clone().addScaledVector(UP, 0.03 * R), UP, n, 0.018 * R), nozzle(c.clone().addScaledVector(DOWN, 0.03 * R), DOWN, n, 0.018 * R), nozzle(c.clone().addScaledVector(t, 0.03 * R), t, n, 0.016 * R), nozzle(c.clone().addScaledVector(t, -0.03 * R), t.clone().negate(), n, 0.016 * R)];
    P(projectUV(merge(rcs)), mats.darkMetal, { order: 1.33 + k * 0.002, dir: v3(o.x, 0.2, o.z), dist: 0.5, side: DS });
  }
  const splay = (35 * Math.PI) / 180;
  for (let i = 0; i < 6; i++) {
    const a = ((i + 0.5) * TAU) / 6;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const at = (r, y) => v3(r * R * c, y0 + y * H, r * R * s);
    const knee = at(0.82, 0.2);
    const foot = at(0.94, 0.04);
    const axis = v3(-s, 0, c);
    // footpad: a shallow dish below a ball joint, pre-turned by −splay so it is level when the leg is out
    const pad = lathe([[0.001, -0.025 * H], [0.085 * R, -0.025 * H], [0.09 * R, -0.015 * H], [0.045 * R, -0.006 * H], [0.001, -0.006 * H]], 20)
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, -splay))
      .translate(foot.x, foot.y, foot.z);
    const ball = new THREE.SphereGeometry(0.03 * R, 10, 8).translate(foot.x, foot.y, foot.z);
    const strutGeo = merge([tube(at(0.55, 0.5), at(0.75, 0.35), knee, 0.025 * R, 10), rod(knee, foot, 0.025 * R), rod(at(0.5, 0.3), knee, 0.02 * R)]);
    const geo = projectUV(merge([strutGeo.clone(), indexed(pad), ball].map(indexed)));
    // splay 35° outward about the attach point on the body (axis (−sin a, 0, cos a) swings the foot out)
    P(geo, mats.metal, { order: 1.5 + i * 0.01, dir: radial(a, 0.2), dist: 0.35, edges: true, lineGeo: strutGeo, deploy: { axis, pivot: at(0.55, 0.5), angle: splay, order: 0 } });
  }
}

// Apollo-style stack from visuals dims (sourced) or visual fallbacks: equipment boxes inside the instrument
// ring; spacecraft-LM adapter panels (stage D → CSM D, ring frames and longerons inside) on their hinge
// brackets, around the folded lander (octagonal descent stage in gold and black foil with its legs folded,
// faceted ascent stage) and the SPS bell with its two gimbal actuators; the service module (body, aft heat
// shield, two radiator panels, four RCS quads, joint bolt rings, the folded high-gain antenna); the command
// module in silver foil on its heat shield with the umbilical fairing; and the launch escape system above the
// envelope when its height is sourced (a lattice tower, the escape motor with its four nozzles, the jettison
// motor, the canard section and the nose; placing it on the CM is a visual choice).
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
  // Instrument-ring equipment: eight boxes round its inner wall (moves with the ring in the lens view).
  const Rt = g.stageD_m / 2;
  const iu = [];
  for (let i = 0; i < 8; i++) iu.push(box(0.035 * Rt, 0.55 * y0, 0.16 * Rt, Rt * 0.9, 0.5 * y0, 0).rotateY((-(i + 0.5) * TAU) / 8));
  P(projectUV(merge(iu)), mats.darkMetal, { order: 0.05, dir: DOWN, dist: 0.12, ax: [-1, 9] }).mesh.userData.adapter = true;
  // Lander folded inside the adapter, below the SPS bell (only seen when the panels open).
  const rIn = (y) => lerp(Rb, Rs, y / slaH);
  const lmTop = Math.min(0.62 * slaH, slaH - spsH - 0.05 * slaH);
  const yAsc = 0.06 * slaH + 0.55 * (lmTop - 0.06 * slaH);
  const dR = 0.85 * rIn(yAsc);
  const dH = yAsc - 0.06 * slaH;
  // descent stage: octagon, gold and black foil on alternate faces
  const yD = y0 + 0.06 * slaH; // base of the lander
  P(projectUV(prism(dR, dH, 8, (kk) => (kk % 2 ? FOIL.black : FOIL.gold), FOIL.black).translate(0, yD + dH / 2, 0)), mats.foil, { order: 0.9, dist: 0.2, ax: [-1, 2], kind: "interior", lander: "descent" });
  // four legs folded up its sides (footpad at the top, beside the ascent stage), hinged at a third of its
  // height; landerOf deploys them 135° out and down, ending 45° off vertical with the pads level, wide and
  // below the descent stage (visual proportions)
  const legL = 0.85 * dH;
  const legAngle = (135 * Math.PI) / 180;
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 8; // between the octagon's faces' centres: on the gold/black seams
    const o = v3(Math.sin(a), 0, Math.cos(a));
    const tan = v3(Math.cos(a), 0, -Math.sin(a)); // tangential, for the side braces
    const axis = new THREE.Vector3().crossVectors(UP, o); // Y × o turns +Y toward o: out and down
    const hinge = o.clone().multiplyScalar(dR * 1.05).setY(yD + 0.32 * dH);
    const tip = hinge.clone().setY(hinge.y + legL);
    const padUp = UP.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, -legAngle));
    const pad = lathe([[0.001, -0.05 * dH], [0.13 * dR, -0.05 * dH], [0.14 * dR, -0.03 * dH], [0.06 * dR, -0.012 * dH], [0.001, -0.012 * dH]], 20)
      .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, padUp))
      .translate(tip.x, tip.y, tip.z);
    // contact probe below the pad: only on the landerOf copy (a child of the leg, hideable once it has bent)
    const probe = tint(indexed(rod(tip.clone().addScaledVector(padUp, -0.05 * dH), tip.clone().addScaledVector(padUp, -0.35 * dH), 0.006 * dR, 1)), FOIL.silver);
    const legGeo = merge([
      tint(indexed(rod(hinge, tip, 0.03 * dR)), FOIL.gold),
      tint(indexed(rod(hinge.clone().addScaledVector(tan, 0.12 * dR), tip.clone().lerp(hinge, 0.35), 0.015 * dR, 1)), FOIL.gold),
      tint(indexed(rod(hinge.clone().addScaledVector(tan, -0.12 * dR), tip.clone().lerp(hinge, 0.35), 0.015 * dR, 1)), FOIL.gold),
      tint(indexed(pad), FOIL.silver),
    ]);
    P(projectUV(legGeo), mats.foil, { order: 0.92 + i * 0.005, dist: 0.25, ax: [-1, 2], kind: "interior", lander: "leg", landerLeg: { axis, pivot: hinge, angle: legAngle, order: 0 }, probe: projectUV(probe) });
  }
  // ascent stage: faceted cabin, black front facets, silver elsewhere; docking tunnel on top
  const aH = lmTop - yAsc;
  const ascent = [
    prism(0.72 * dR, aH * 0.8, 6, (kk) => (kk === 0 || kk === 5 ? FOIL.black : FOIL.silver), FOIL.silver, 0.6 * dR).translate(0, y0 + yAsc + aH * 0.4, 0),
    tint(indexed(cyl(0.2 * dR, 0.2 * dR, aH * 0.2, 16, 0, y0 + yAsc + aH * 0.8)), FOIL.silver),
  ];
  P(projectUV(merge(ascent.map(indexed))), mats.foil, { order: 0.95, dist: 0.3, ax: [-1, 1], kind: "interior", lander: "ascent" });
  // SLA petals with their inner ring frames and longerons (seen when they open)
  const slaSkin = latheUV(lathe([[Rb, y0], [Rs, y0 + slaH]], 16, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H: slaH, R: (Rb + Rs) / 2, y0 });
  const inner = [];
  for (const f of [0.25, 0.5, 0.75]) inner.push(projectUV(new THREE.TorusGeometry(rIn(f * slaH) * 0.985, 0.012 * Rb, 4, 16, Math.PI / 2).rotateX(Math.PI / 2).rotateY(-Math.PI / 2).translate(0, y0 + f * slaH, 0)));
  for (const phi of [Math.PI / 6, Math.PI / 3]) {
    const o = radialPhi(phi);
    inner.push(projectUV(strut(o.clone().multiplyScalar(Rb * 0.975).setY(y0 + 0.02 * slaH), o.clone().multiplyScalar(Rs * 0.975).setY(y0 + 0.98 * slaH), 0.02 * Rb, 0.02 * Rb, o)));
  }
  const sla = merge([slaSkin.clone(), ...inner]);
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    // the Apollo petals: each opens 45° outward about its bottom edge (quarter-0 frame: centre direction
    // o = (sin π/4, 0, cos π/4), hinge axis (cos π/4, 0, −sin π/4) turns +Y toward o)
    const o = radialPhi(Math.PI / 4);
    const deploy = { axis: v3(Math.cos(Math.PI / 4), 0, -Math.sin(Math.PI / 4)), pivot: o.clone().multiplyScalar(Rb).setY(y0), angle: Math.PI / 4, order: 0 };
    P(sla, mats.silver, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4, 0.4), dist: 0.25 + 0.5 * Rb * S, side: DS, ax: [-1, 3], kind: "shell", lineGeo: slaSkin, deploy });
  }
  // the petals' hinge brackets on the ring at their feet (fixed; one piece for the four)
  const hinges = [];
  for (let q = 0; q < 4; q++) {
    const o = radialPhi((q * Math.PI) / 2 + Math.PI / 4);
    hinges.push(box(0.05 * Rb, 0.03 * slaH, 0.16 * Rb, Rb * 0.96, y0 + 0.015 * slaH, 0).rotateY((q * Math.PI) / 2 + Math.PI / 4 - Math.PI / 2), cyl(0.015 * Rb, 0.015 * Rb, 0.03 * slaH, 8, o.x * Rb * 0.93, y0, o.z * Rb * 0.93));
  }
  P(projectUV(merge(hinges)), mats.darkMetal, { order: 1.09, dist: 0.25, ax: [-1, 3] });
  const ySm = y0 + slaH;
  // SPS: a long bell (exit at the bottom), throat, chamber, and the gimbal ring under the SM; two gimbal
  // actuators from the aft bulkhead down to the chamber
  const sps = [];
  for (let i = 0; i <= 14; i++) {
    const f = i / 14;
    sps.push([0.18 * Rc + 0.42 * Rc * (1 - f) ** 1.7, 0.86 * spsH * f]);
  }
  sps.push([0.24 * Rc, 0.9 * spsH], [0.24 * Rc, 0.97 * spsH], [0.12 * Rc, spsH]);
  P(projectUV(merge([lathe(sps, 40).translate(0, ySm - spsH, 0), new THREE.TorusGeometry(0.3 * Rc, 0.02 * Rc, 6, 32).rotateX(Math.PI / 2).translate(0, ySm - 0.06 * spsH, 0)])), mats.darkMetal, { order: 1.2, dist: 0.45, side: DS, ax: [-1, 0], sym: true, edges: true, lineGeo: lathe(sps, 40).translate(0, ySm - spsH, 0) });
  for (const sx of [1, -1]) {
    const top = v3(sx * 0.42 * Rc, ySm - 0.01 * spsH, 0);
    const bot = v3(sx * 0.26 * Rc, ySm - 0.13 * spsH, 0);
    const mid = top.clone().lerp(bot, 0.55);
    P(projectUV(merge([rod(top, mid, 0.03 * Rc), rod(mid, bot, 0.018 * Rc), cyl(0.04 * Rc, 0.04 * Rc, 0.012 * spsH, 8, top.x, top.y - 0.006 * spsH, 0)])), mats.actuator, { order: 1.21 + (sx > 0 ? 0 : 0.005), dir: v3(sx, -0.4, 0), dist: 0.45, ax: [-1, 0] });
  }
  // SM aft heat shield: a ring under the module round the bell's throat
  P(projectUV(lathe([[0.28 * Rc, ySm - 0.012 * smH], [0.98 * Rc, ySm - 0.012 * smH], [Rc * 1.004, ySm - 0.004 * smH], [Rc * 1.004, ySm + 0.003 * smH]], 48)), mats.skirt, { order: 1.25, dir: DOWN, dist: 0.5, side: DS, sym: true });
  // SM: body (the shell), two raised radiator panels, four RCS quads with four nozzles each
  const smBody = projectUV(cyl(Rc, Rc, smH, 64, 0, ySm));
  P(smBody, mats.silver, { order: 1.3, dist: 0.6, kind: "shell" });
  for (const [j, a0] of [0.35, 0.35 + Math.PI].entries()) {
    const panels = [];
    for (let i = 0; i < 4; i++) panels.push(box(0.006 * Rc, 0.42 * smH, 0.14 * Rc, Rc + 0.003 * Rc, ySm + 0.45 * smH, 0).rotateY(-(a0 + i * 0.16)));
    P(projectUV(merge(panels)), mats.silver, { order: 1.31 + j * 0.005, dir: radial(a0 + 0.24, 0.2), dist: 0.7 });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4;
    const o = v3(Math.cos(a), 0, Math.sin(a));
    const t = v3(-Math.sin(a), 0, Math.cos(a));
    const c = o.clone().multiplyScalar(Rc * 1.06).setY(ySm + 0.7 * smH);
    const quad = [box(0.12 * Rc, 0.1 * smH, 0.2 * Rc, Rc + 0.05 * Rc, ySm + 0.7 * smH, 0).rotateY(-a)];
    for (const [dir, off] of [[UP, 0.05 * smH], [DOWN, 0.05 * smH], [t, 0.1 * Rc], [t.clone().negate(), 0.1 * Rc]]) quad.push(nozzle(c.clone().addScaledVector(dir, off), dir, 0.08 * Rc, 0.03 * Rc));
    P(projectUV(merge(quad.map(indexed))), mats.silver, { order: 1.32 + i * 0.003, dir: radial(a, 0.2), dist: 0.75, side: DS });
  }
  const jb = Math.max(0.03, 0.012 * Rc);
  P(merge([boltRing(Rc * 1.01, ySm + jb / 2, 32, jb), boltRing(Rc * 1.01, ySm + smH - jb / 2, 32, jb)]), mats.machined, { order: 1.35, dist: 0.6, sym: true });
  // high-gain antenna folded under the SM's edge: a mast and four small dishes facing out
  {
    const az = (3 * Math.PI) / 2;
    const o = radialPhi(az);
    const m0 = o.clone().multiplyScalar(0.84 * Rc).setY(ySm - 0.02 * spsH);
    const m1 = o.clone().multiplyScalar(0.84 * Rc).setY(ySm - 0.3 * spsH);
    const hd = [];
    for (let i = 0; i <= 6; i++) hd.push([0.07 * Rc * (i / 6), 0.02 * Rc * (i / 6) ** 2]);
    const turn = new THREE.Quaternion().setFromUnitVectors(UP, o);
    const t = v3(Math.cos(az), 0, -Math.sin(az)); // tangential
    const dishes = [];
    for (const sy of [-1, 1]) {
      for (const st of [-1, 1]) {
        const c = m1.clone().addScaledVector(o, 0.04 * Rc).addScaledVector(t, st * 0.075 * Rc).setY(m1.y + sy * 0.075 * Rc);
        dishes.push(lathe(hd, 14).applyQuaternion(turn).translate(c.x, c.y, c.z));
      }
    }
    P(projectUV(merge([rod(m0, m1, 0.012 * Rc), box(0.04 * Rc, 0.04 * Rc, 0.04 * Rc, m1.x, m1.y, m1.z), ...dishes])), mats.trim, { order: 1.36, dir: v3(o.x, -0.3, o.z), dist: 0.55, side: DS });
  }
  const yCm = ySm + smH;
  // CM heat shield band at its base, the umbilical fairing from the SM onto the CM, and the CM
  P(projectUV(lathe([[0.001, yCm + 0.002 * cmH], [0.6 * Rc, yCm + 0.002 * cmH], [Rc * 1.006, yCm + 0.008 * cmH], [Rc * 1.006, yCm + 0.035 * cmH], [Rc * 0.97, yCm + 0.05 * cmH]], 48)), mats.darkMetal, { order: 1.39, dist: 0.75, ax: [1, 0], side: DS, sym: true });
  const umb = strut(v3(Rc * 1.02, ySm + 0.85 * smH, 0), v3(Rc * 0.88, yCm + 0.18 * cmH, 0), 0.1 * Rc, 0.04 * Rc, v3(1, 0, 0)).rotateY(-Math.PI / 2);
  P(projectUV(umb), mats.silver, { order: 1.395, dir: v3(0, 0.4, 1), dist: 0.8, ax: [1, 0] });
  const cm = [[Rc, 0], [Rc * 0.98, 0.04 * cmH], [0.24 * Rc, 0.86 * cmH], [0.16 * Rc, 0.95 * cmH], [0.001, cmH]];
  P(projectUV(lathe(cm, 48).translate(0, yCm, 0)), mats.mliSilver, { order: 1.4, dist: 0.8, ax: [1, 0], sym: true, edges: true, dock: true });
  const lesH = g.lesH_m ?? 0;
  if (lesH > 0) {
    // tower: four tapering longerons, ring frames at five levels, X-bracing on every face of every bay
    const yL = yCm + cmH * 0.95;
    const tr = dims.les_base_diameter_m ? dims.les_base_diameter_m / 2 : 0.3 * Rc;
    const tH = 0.4 * lesH;
    const corner = (i, f) => {
      const a = (i * TAU) / 4 + Math.PI / 4;
      const r = tr * lerp(1, 0.4, f);
      return v3(r * Math.cos(a), yL + f * tH, r * Math.sin(a));
    };
    const truss = [];
    const lr = 0.015 * Rc;
    for (let i = 0; i < 4; i++) truss.push(rod(corner(i, 0), corner(i, 1), lr));
    const levels = [0, 0.25, 0.5, 0.75, 1];
    for (const f of levels) for (let i = 0; i < 4; i++) truss.push(rod(corner(i, f), corner((i + 1) % 4, f), lr * 0.7, 1));
    for (let b = 0; b < levels.length - 1; b++) {
      for (let i = 0; i < 4; i++) {
        truss.push(rod(corner(i, levels[b]), corner((i + 1) % 4, levels[b + 1]), lr * 0.5, 1), rod(corner((i + 1) % 4, levels[b]), corner(i, levels[b + 1]), lr * 0.5, 1));
      }
    }
    P(projectUV(merge(truss)), mats.darkMetal, { order: 1.5, dist: 1.0, ax: [1, 1] });
    // escape motor case with its four canted nozzles at the base, then the jettison motor, the canard
    // section (canards folded) and the nose, each its own lens layer
    const yM = yL + tH;
    const caseGeo = lathe([[0.001, 0], [0.13 * Rc, 0], [0.13 * Rc, 0.38 * lesH]], 24).translate(0, yM, 0);
    P(projectUV(caseGeo.clone()), mats.trim, { order: 1.6, dist: 1.1, side: DS, ax: [1, 2], sym: true, edges: true, lineGeo: caseGeo });
    const nozzles = [];
    for (let i = 0; i < 4; i++) {
      const o = radial((i * TAU) / 4);
      nozzles.push(nozzle(o.clone().multiplyScalar(0.1 * Rc).setY(yM + 0.02 * lesH), o.clone().multiplyScalar(0.55).add(DOWN), 0.06 * lesH, 0.045 * Rc));
    }
    P(projectUV(merge(nozzles.map(indexed))), mats.darkMetal, { order: 1.605, dist: 1.1, side: DS, ax: [1, 2] });
    const jet = lathe([[0.13 * Rc, 0.38 * lesH], [0.135 * Rc, 0.4 * lesH], [0.135 * Rc, 0.42 * lesH], [0.09 * Rc, 0.46 * lesH]], 24).translate(0, yM, 0);
    P(projectUV(jet.clone()), mats.trim, { order: 1.61, dist: 1.15, side: DS, ax: [1, 3], sym: true, edges: true, lineGeo: jet });
    const canards = [lathe([[0.09 * Rc, 0.46 * lesH], [0.09 * Rc, 0.5 * lesH], [0.06 * Rc, 0.54 * lesH]], 24).translate(0, yM, 0)];
    for (let i = 0; i < 4; i++) canards.push(box(0.08 * Rc, 0.03 * lesH, 0.006 * Rc, 0.12 * Rc, yM + 0.47 * lesH, 0).rotateY((-i * TAU) / 4));
    P(projectUV(merge(canards)), mats.trim, { order: 1.62, dist: 1.2, side: DS, ax: [1, 4], sym: true });
    P(projectUV(merge([lathe([[0.06 * Rc, 0.54 * lesH], [0.03 * Rc, 0.58 * lesH], [0.001, 0.6 * lesH]], 24).translate(0, yM, 0), new THREE.SphereGeometry(0.035 * Rc, 12, 8).translate(0, yM + 0.585 * lesH, 0)])), mats.darkMetal, { order: 1.63, dist: 1.25, side: DS, ax: [1, 5], sym: true });
  }
}

// ---------- fairing ----------

// Base cone (the payload adapter section: a boattail when the fairing is wider than the stage, else a short
// ring), machined separation ring, four separation pushers beside the seams, and per half: the shell with the
// ogive nose (rivet rows along its seams, instanced), two half-ring frames inside, an access door and a vent
// (16 pieces). Everything on a half moves with it (same explode and turn), so the halves part as units.
function buildFairing(spec, mats) {
  const g = spec.geom;
  const Rf = g.D_m / 2;
  const Rb = g.baseD_m / 2;
  const D = g.D_m;
  const baseH = Math.max(g.boattailH_m, 0.04 * g.D_m);
  const ringH = 0.03 * g.D_m;
  const halfDist = 0.35 + 1.25 * Rf * S;
  const out = [];
  const P = (geo, mat, o) => {
    const pc = piece(geo, mat, o);
    out.push(pc);
    return pc;
  };
  const base = g.boattailH_m > 0 ? [[Rb, 0], [Rf, g.boattailH_m], [Rf, baseH]] : [[Rf, 0], [Rf, baseH]];
  P(latheUV(lathe(base, 64), { H: g.H_m, R: Rf }), mats.body, { order: 0, dir: DOWN, dist: 0.1, side: DS, ax: ["f", -1, 1], sym: true, kind: "shell" });
  const fb = Math.max(0.02, 0.006 * g.D_m);
  const sepRing = machinedRing(Rf * 0.97, Rf * 1.008, ringH, baseH);
  P(merge([sepRing.clone(), boltRing(Rf * 1.011, baseH + ringH / 2, 32, fb, fb, fb * 0.8)]), mats.machined, { order: 0.5, dir: DOWN, dist: 0.06, ax: ["f", -1, 0], sym: true, edges: true, lineGeo: sepRing });
  // Separation pushers on the ring beside the two seams (±Z): plate, cylinder, rod. They stay with the base
  // when the halves swing off (|dir.x| < 0.3).
  const y0 = baseH + ringH;
  const pusher = merge([box(0.06 * Rf, 0.006 * D, 0.035 * D, 0.015 * Rf, 0.003 * D, 0), cyl(0.012 * D, 0.012 * D, 0.06 * D, 10, 0, 0.006 * D), cyl(0.007 * D, 0.007 * D, 0.035 * D, 8, 0, 0.066 * D)]);
  [0.22, -0.22, Math.PI + 0.22, Math.PI - 0.22].forEach((phi, k) => {
    const o = radialPhi(phi);
    const r = 0.945 * Rf;
    P(pusher, mats.actuator, { x: o.x * r, y: y0, z: o.z * r, ry: phi - Math.PI / 2, order: 0.6 + k * 0.01, dir: radialPhi(phi, -0.5), dist: 0.06 });
  });
  const pts = [[Rf, y0], [Rf, g.cylTop_m], ...ogivePoints(Rf, g.noseH_m, g.cylTop_m)];
  // Half 0 (phi ∈ [0, π], the +X half) and what rides on it; half 1 is the same geometry turned by π.
  const half = latheUV(lathe(pts, 40, 0, Math.PI), { phiStart: 0, phiLength: Math.PI, H: g.H_m, R: Rf });
  const doorH = 0.09 * g.D_m;
  const yDoor = baseH + 0.3 * (g.cylTop_m - baseH);
  const door = projectUV(box(0.012 * g.D_m, doorH, 0.12 * g.D_m, Rf + 0.006 * g.D_m, yDoor + doorH / 2, 0.25 * Rf));
  // Half-ring T-section frames at 30 % and 65 % of the barrel.
  const barrel = g.cylTop_m - y0;
  const [rF, rI, rW, hf, tw] = [Rf * 0.958, Rf * 0.968, Rf * 0.992, 0.022 * D, 0.008 * D];
  const frames = [0.3, 0.65].map((f) => {
    const y = y0 + f * barrel;
    return lathe([[rF, y + hf / 2], [rF, y - hf / 2], [rI, y - hf / 2], [rI, y - tw / 2], [rW, y - tw / 2], [rW, y + tw / 2], [rI, y + tw / 2], [rI, y + hf / 2], [rF, y + hf / 2]], 32, 0, Math.PI);
  });
  // A louvred vent low on the half, across from its door (built at +X, turned onto its azimuth).
  const phiV = Math.PI / 2 + 0.5;
  const yV = y0 + 0.12 * barrel;
  const vent = projectUV(merge([box(0.008 * D, 0.06 * D, 0.1 * D, Rf + 0.004 * D, yV, 0), ...[0, 1, 2, 3].map((k) => box(0.012 * D, 0.004 * D, 0.085 * D, Rf + 0.009 * D, yV - 0.021 * D + k * 0.014 * D, 0))]).rotateY(phiV - Math.PI / 2));
  // Rivets (instanced, shared by the halves): a row inside each seam edge and arcs round the barrel's ends.
  const rv = Math.max(0.01, 0.004 * D);
  const pitch = 8 * rv;
  const dl = (0.008 * D) / Rf;
  const rl = [];
  for (const phi of [dl, Math.PI - dl]) {
    const o = radialPhi(phi).multiplyScalar(Rf);
    rl.push(...rivetRow(o.clone().setY(y0 + 0.04 * D), o.clone().setY(g.cylTop_m - 0.03 * D), pitch, rv));
  }
  rl.push(...rivetArc(Rf, y0 + 0.02 * D, 2 * dl, Math.PI - 2 * dl, pitch, rv), ...rivetArc(Rf, g.cylTop_m - 0.012 * D, 2 * dl, Math.PI - 2 * dl, pitch, rv));
  const rivets = instAttr(rl);
  for (let h = 0; h < 2; h++) {
    const dir = v3(h === 0 ? 1 : -1, 0.12, 0);
    const ry = h * Math.PI;
    const pc = P(half, mats.body, { ry, order: 1 + h * 0.05, dir, dist: halfDist, side: DS, kind: "shell" });
    addDetail(pc, "rivet", rivets, { lookOnly: "painted", color: rivetTint(pc.mesh) });
    frames.forEach((fg, f) => P(fg, mats.interior, { ry, order: 1.005 + h * 0.05 + f * 0.002, dir, dist: halfDist, kind: "interior", side: DS, edges: true }));
    P(door, mats.raceway, { ry, order: 1.02 + h * 0.05, dir, dist: halfDist });
    P(vent, mats.raceway, { ry, order: 1.03 + h * 0.05, dir, dist: halfDist });
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
  detailMats = new Map(); // the part's detail materials (addDetail)
  const built = BUILDERS[spec.kind](spec, mats);
  detailMats = null;
  const pieces = built.map((p, i) => {
    const bb = p.mesh.geometry.boundingBox;
    p.mesh.userData.partId = spec.id;
    p.mesh.name = `${spec.id}:${i}`;
    for (const d of p.mesh.userData.details ?? []) {
      d.userData.partId = spec.id;
      d.name = `${p.mesh.name}:${d.userData.detail}`;
    }
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
      deploy: p.deploy,
      follow: p.follow,
      landerLeg: p.landerLeg,
      ax: p.ax,
      sym: p.sym,
      axisOffset: 0,
      spin: 0,
    };
  });
  // Soot near the vehicle's base, from each piece's own bottom edge up: engine-section skins over their whole
  // height, the first-stage tank over its lowest share (visual strengths and shares).
  const soot = spec.kind === "engines" ? [0.95, null] : spec.kind === "tank" && spec.stageIndex === 0 ? [0.7, 0.12 * spec.height] : null;
  for (const p of pieces) {
    const m = p.mesh.userData.looks?.painted;
    if (!m?.userData.soot) continue;
    const bb = p.mesh.geometry.boundingBox;
    m.soot = { value: new THREE.Vector4(bb.min.y, soot ? (soot[1] ?? bb.max.y - bb.min.y) : 1, soot ? soot[0] : 0, 0) };
  }
  // Followers: point each at its leader's part piece and list it on the leader (applyDeploy poses them).
  for (const p of pieces) {
    if (!p.follow) continue;
    const leader = pieces[built.indexOf(p.follow.leader)];
    p.follow = { ...p.follow, leader };
    (leader.followers ??= []).push(p);
  }
  // Bell glow: each engine's bell pieces share a lip-to-throat range (part-local y), one uniform per piece
  // shared by both looks (setBellGlow).
  const bellY = new Map();
  for (const p of pieces) {
    if (!BELL_ROLES.has(p.mesh.userData.role)) continue;
    const r = bellY.get(p.engine) ?? [Infinity, -Infinity];
    bellY.set(p.engine, [Math.min(r[0], p.bottomY), Math.max(r[1], p.topY)]);
  }
  for (const p of pieces) {
    const r = BELL_ROLES.has(p.mesh.userData.role) && bellY.get(p.engine);
    if (!r) continue;
    const glow = { value: new THREE.Vector4(r[0] - p.mesh.position.y, r[1] - p.mesh.position.y, 0, 0) };
    p.mesh.userData.bellGlow = glow;
    for (const m of new Set([p.mesh.material, ...Object.values(p.mesh.userData.looks ?? {})])) addBellGlow(m, glow);
  }
  // Cryogenic frost (painted look): kerolox tanks over the LOX section (the upper ~45 %), hydrolox tanks over
  // the whole skin; lighter on foam, which insulates. Visual amounts.
  const prop = spec.kind === "tank" ? spec.record?.propellant : null;
  if (prop === "kerolox" || prop === "hydrolox") {
    for (const p of pieces) {
      const m = p.mesh.userData.looks?.painted;
      if (!m?.userData.soot || p.kind !== "shell") continue;
      const edge = prop === "kerolox" ? 0.55 * spec.height : -spec.height; // hydrolox: below the bottom = all
      const amount = m.roughness >= 0.8 ? 0.15 : 0.5; // matte sprayed foam (insulated) vs paint
      m.frost = { value: new THREE.Vector4(edge - p.mesh.position.y, 0.06 * spec.height, amount, 0.012 * spec.height + 0.02) };
      p.mesh.onBeforeRender = tickFrost;
    }
  }
  // Rivets on a sooty / frosty skin take the skin's hook and uniforms, so they darken and frost with it. The
  // part's rivet material is shared by its quarters (equal values); a rivet set whose host differs gets its own.
  const same = (a, b) => (!a && !b) || (a && b && a.value.equals(b.value));
  for (const p of pieces) {
    const host = p.mesh.userData.looks?.painted;
    if (!host?.userData.soot) continue;
    for (const d of p.mesh.userData.details ?? []) {
      if (d.userData.detail !== "rivet") continue;
      let m = d.userData.looks?.painted ?? d.material;
      if (m.soot && same(m.soot, host.soot) && same(m.frost, host.frost)) continue;
      if (m.soot) {
        m = m.clone();
        if (d.userData.looks) d.userData.looks = { ...d.userData.looks, painted: m };
        if (d.material !== d.userData.looks?.xray) d.material = m;
      }
      m.soot = host.soot;
      m.frost = host.frost;
      m.onBeforeCompile = sootHook;
      m.customProgramCacheKey = sootKey;
      if (host.frost) d.onBeforeRender = tickFrost;
    }
  }
  axisOffsets(pieces, clamp(0.035 * spec.height, 0.04, 0.3));
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  assignSpins(pieces, spec.id);
  for (const p of pieces) {
    delete p.ax;
    delete p.sym;
  }
  const part = { ...spec, group, pieces, built: false, busy: false };
  registerForDetail(part);
  return part;
}

// Pieces with an articulated deploy (see the header for the hinge formula), in deploy order.
export const deployables = (part) => part.pieces.filter((p) => p.deploy).sort((a, b) => a.deploy.order - b.deploy.order);

// Poses a deployable at fraction k by the hinge formula and then its followers (the leg pistons) from the
// leader's current pose, so they stay pinned whatever k does (springs, overshoot, staggered starts).
const hingeQ = new THREE.Quaternion();
const folQ = new THREE.Quaternion();
const folInv = new THREE.Quaternion();
const folL = new THREE.Vector3();
const folU = new THREE.Vector3();
const folU0 = new THREE.Vector3();
export function applyDeploy(piece, k) {
  const d = piece.deploy;
  hingeQ.setFromAxisAngle(d.axis, k * d.angle);
  piece.mesh.position.copy(piece.rest.position).sub(d.pivot).applyQuaternion(hingeQ).add(d.pivot);
  piece.mesh.quaternion.copy(hingeQ).multiply(piece.rest.quaternion);
  for (const f of piece.followers ?? []) poseFollower(f);
}
// Landable sub-part of a payload (the Apollo LM: descent stage, ascent stage, four legs), or null. Returns a
// separate group made of copies of those pieces (shared geometry, own materials, both looks) with its origin
// at the centre of the descent stage's base:
//   { group, pieces: [{ mesh, rest, deploy }], deployables (the legs; applyDeploy, same hinge formula),
//     footprint_u (radius of the deployed footpads), feetY_u (underside of the pads, legs out, group frame: put
//     the group at ground − feetY_u to land), height_u, probes (a contact probe under each pad, children of
//     the legs) with probeLength_u (they touch first, that far below the pads: cut the engine then, and hide
//     them with setProbesVisible(false) once landed, as they bend), restPose (inside the adapter, part frame),
//     detachPose (after transposition: turned over and docked nose to nose on the command module's apex, part
//     frame; the escape tower is gone by then in reality, hide it), setPartLanderVisible(on) (hides or shows the
//     original pieces in the payload when the copy takes over) }.
export function landerOf(part) {
  const lm = part.pieces.filter((p) => p.mesh.userData.lander);
  if (!lm.length) return null;
  const box = new THREE.Box3();
  const body = lm.find((p) => p.mesh.userData.lander === "descent") ?? lm[0];
  body.mesh.geometry.computeBoundingBox();
  box.copy(body.mesh.geometry.boundingBox).translate(body.rest.position);
  const base = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const group = new THREE.Group();
  group.name = `${part.id}:lander`;
  const pieces = lm.map((p) => {
    const looks = p.mesh.userData.looks;
    const mesh = new THREE.Mesh(p.mesh.geometry, cloneMat(p.mesh.material));
    if (looks) {
      mesh.userData.looks = { painted: cloneMat(looks.painted), xray: cloneMat(looks.xray) };
      mesh.material = p.mesh.material === looks.xray ? mesh.userData.looks.xray : mesh.userData.looks.painted;
    }
    mesh.name = `${p.mesh.name}:lander`;
    mesh.userData.lander = p.mesh.userData.lander;
    mesh.position.copy(p.rest.position).sub(base);
    mesh.quaternion.copy(p.rest.quaternion);
    group.add(mesh);
    const deploy = p.landerLeg ? { ...p.landerLeg, pivot: p.landerLeg.pivot.clone().sub(base), axis: p.landerLeg.axis.clone() } : null;
    return { mesh, rest: { position: mesh.position.clone(), quaternion: mesh.quaternion.clone() }, deploy, probeGeo: probeOf.get(p.mesh) ?? null };
  });
  const deployables = pieces.filter((p) => p.deploy);
  // Measure with the legs out (pads only: their undersides are the feet), then fold them back and add the
  // probes, children of their legs, hanging below the pads.
  for (const d of deployables) applyDeploy(d, 1);
  group.updateMatrixWorld(true);
  const all = new THREE.Box3().setFromObject(group, true); // precise: vertices, not rotated bounding boxes
  let footprint = 0;
  for (const d of deployables) {
    const b = new THREE.Box3().setFromObject(d.mesh, true);
    for (const x of [b.min.x, b.max.x]) for (const z of [b.min.z, b.max.z]) footprint = Math.max(footprint, Math.hypot(x, z));
  }
  for (const d of deployables) applyDeploy(d, 0);
  group.updateMatrixWorld(true);
  const folded = new THREE.Box3().setFromObject(group, true);
  const height = folded.max.y - folded.min.y;
  const probes = pieces
    .filter((p) => p.probeGeo)
    .map((p) => {
      const pr = new THREE.Mesh(p.probeGeo, cloneMat(p.mesh.material));
      pr.name = `${p.mesh.name}:probe`;
      p.mesh.add(pr);
      return pr;
    });
  const probeLen = probes.length ? (probes[0].geometry.computeBoundingBox(), probes[0].geometry.boundingBox.getSize(new THREE.Vector3()).length()) : 0;
  const dockP = part.pieces.find((p) => p.mesh.userData.dock);
  const apex = dockP ? dockP.topY : folded.max.y + base.y;
  return {
    group,
    pieces,
    deployables,
    footprint_u: footprint,
    feetY_u: all.min.y,
    height_u: height,
    probes,
    probeLength_u: probeLen,
    setProbesVisible(on) {
      for (const pr of probes) pr.visible = !!on;
    },
    restPose: { position: base.clone(), quaternion: new THREE.Quaternion() },
    detachPose: { position: new THREE.Vector3(base.x, apex + folded.max.y, base.z), quaternion: new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), Math.PI) },
    setPartLanderVisible(on) {
      for (const p of lm) p.mesh.visible = !!on;
    },
  };
}

function poseFollower(f) {
  const { leader, B, L, end } = f.follow;
  // L now: the leader's rest → current motion applied to L
  folInv.copy(leader.rest.quaternion).invert();
  folL.copy(L).sub(leader.rest.position).applyQuaternion(folInv).applyQuaternion(leader.mesh.quaternion).add(leader.mesh.position);
  folU0.copy(L).sub(B).normalize();
  folU.copy(folL).sub(B).normalize();
  folQ.setFromUnitVectors(folU0, folU);
  const pin = end === "B" ? B : folL;
  const pin0 = end === "B" ? B : L;
  f.mesh.position.copy(f.rest.position).sub(pin0).applyQuaternion(folQ).add(pin);
  f.mesh.quaternion.copy(folQ).multiply(f.rest.quaternion);
}

// Shell pieces of a part, and their look: value ≥ PAINT_AT shows the painted materials (opaque, every edge line
// at LINE_PAINT / LINE_STRUCT of its built opacity); below it the x-ray materials, shells at opacity value and
// their lines scaled with them. Lines keep userData.base current for the look, so a caller that resets lines to
// base × dim (choreo) follows. A material switched out gets its own emissive back (no stuck highlight).
export const shellPieces = (part) => part.pieces.filter((p) => p.mesh.userData.kind === "shell");
const lineK = LINE_PAINT / LINE_STRUCT;
export function setShellOpacity(part, value) {
  const paint = value >= PAINT_AT;
  for (const p of part.pieces) {
    const looks = p.mesh.userData.looks;
    if (!looks) continue;
    const want = paint ? looks.painted : looks.xray;
    if (p.mesh.material !== want) {
      const old = p.mesh.material;
      const e0 = old.userData.emissive0;
      if (e0) old.emissive.setHex(e0[0]), (old.emissiveIntensity = e0[1]);
      p.mesh.material = want;
    }
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) {
      if (!e) continue;
      e.userData.base0 ??= e.userData.base;
      e.userData.base = paint ? e.userData.base0 * lineK : e.userData.base0;
      e.material.opacity = e.userData.base;
    }
    // Instanced detail follows its piece's look; detail on a shell shows in the painted look only.
    for (const d of p.mesh.userData.details ?? []) {
      const dl = d.userData.looks;
      if (dl) d.material = paint ? dl.painted : dl.xray;
      if (d.userData.lookOnly) d.visible = d.userData.lookOnly === (paint ? "painted" : "xray");
    }
  }
  if (paint) return;
  for (const p of shellPieces(part)) {
    const m = p.mesh.material;
    if (!m.transparent) (m.transparent = true), (m.needsUpdate = true);
    m.opacity = clamp(value * (m.userData.opacityScale ?? 1), 0, 1);
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) if (e) e.material.opacity = clamp((e.userData.base * value) / SHELL_OPACITY, 0, 1);
  }
}

// ---------- detail level (frame-time guard, ?lite=1) ----------

// setDetailLevel(level, target?): 2 = everything; 1 = instanced detail (rivets, bolts, clamps, straps) hidden
// and edge lines only on shells; 0 = no instanced detail, no lines, and the smallest 40 % of each part's
// "detail"-kind pieces (by bounding radius) not drawn. Hiding moves an object to HIDDEN_LAYER, which no camera,
// shadow camera or default Raycaster sees: nothing recompiles, `visible` stays the choreography's (build
// animations and the look switch keep working), hidden pieces keep animating and are never picked, and the
// original layers come back exactly on the way up. target: a part, an array of parts, or none for every live
// part (createPart registers them and applies the current level to new parts). Returns the level set.
const HIDDEN_LAYER = 31;
let detailLevel = 2;
const liveParts = new Set(); // WeakRef<part>
function registerForDetail(part) {
  // the smallest 40 % of the detail-kind pieces, by bounding radius (scene units)
  const small = part.pieces
    .filter((p) => p.kind === "detail")
    .map((p) => {
      const g = p.mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      return [p, g.boundingSphere.radius];
    })
    .sort((a, b) => a[1] - b[1]);
  part.lodSmall = new Set(small.slice(0, Math.floor(small.length * 0.4)).map(([p]) => p));
  if (typeof WeakRef !== "undefined") liveParts.add(new WeakRef(part));
  if (detailLevel !== 2) applyDetailLevel(part, detailLevel);
}
function hideOn(o, hide) {
  if (!o) return;
  const u = (o.userData.lod ??= { mask: o.layers.mask });
  o.layers.mask = hide ? 1 << HIDDEN_LAYER : u.mask;
}
function applyDetailLevel(part, level) {
  for (const p of part.pieces) {
    const m = p.mesh;
    hideOn(m, level === 0 && part.lodSmall?.has(p));
    const shell = m.userData.kind === "shell";
    for (const e of [m.userData.edges, m.userData.edgesFine]) hideOn(e, level === 0 || (level === 1 && !shell));
    for (const d of m.userData.details ?? []) hideOn(d, level < 2);
  }
  part.detailLevel = level;
}
export function setDetailLevel(level = 2, target = null) {
  const lv = Number.isFinite(+level) ? clamp(Math.round(+level), 0, 2) : 2;
  let parts;
  if (target) parts = [].concat(target);
  else {
    detailLevel = lv;
    parts = [];
    for (const ref of liveParts) {
      const part = ref.deref();
      if (part) parts.push(part);
      else liveParts.delete(ref);
    }
  }
  for (const part of parts) if (part?.pieces) applyDetailLevel(part, lv);
  return lv;
}
export const getDetailLevel = () => detailLevel;
export const DETAIL_HIDDEN_LAYER = HIDDEN_LAYER;

// ---------- environment ----------

// Radius of the launch-pad deck for a stack base radius (scene units); anchors.js lines up with it.
export const padRadius = (baseRadius_u) => Math.max(2.4, baseRadius_u * 3.4);

// Pad layout shared with anchors.js (scene units; azimuth phi from +Z toward +X like the lathes; the home
// camera sits near phi 0.58). The deck top is y = 0 (the rocket's base); the ground is at y = −plinthH.
// Sizes are visual proportions of the base radius, not data.
export function padLayout({ baseRadius_u = 1, cameraAzimuth = 0.58 } = {}) {
  const b = Math.max(0.05, baseRadius_u);
  const padR = padRadius(b);
  return {
    b,
    padR,
    plinthH: Math.max(0.6, 0.8 * b), // raised hardstand
    deckT: Math.max(0.05, 0.03 * padR),
    holeR: 1.25 * b, // deck opening over the flame trench
    mountR: 1.4 * b, // launch-mount ring outer radius
    trenchPhi: cameraAzimuth + Math.PI / 2, // trench runs out to the right of the home view
    railPhi: cameraAzimuth + Math.PI, // transporter-erector rails come in from behind
  };
}

// Materials and edge lines for the static props (pad, anchors, drone ship): one material set, cloned per mesh.
let propMats = null;
export function propMaterials() {
  propMats ??= createMaterials();
  return propMats;
}
export const propMaterial = (m) => cloneMat(m);
export const LINE_PROP = 0.35;
// Peach edge lines on a prop mesh (x-ray look only); geo defaults to the mesh's own geometry.
export function addLines(mesh, opacity = LINE_PROP, geo = mesh.geometry) {
  return XRAY ? lineChild(mesh, geo, opacity, "edges") : null;
}

// Painted props (round 16), matching the painted rocket: concrete deck and plinth (scorched toward the trench
// opening), scorched concrete trench and deflector, dark steel mount and clamps, galvanized dark-grey steel for
// the tower, arms, masts, rails and tray (per-member shade from vertex colours where the geometry has them),
// the person as a dark silhouette. Colours and tiles are visual.
const PROP_LINE_K = LINE_PAINT / LINE_PROP; // prop lines over paint: the props' 0.35 level becomes 0.15
let propTex = null;
function propTextures() {
  if (propTex) return propTex;
  // Concrete: large stains, form-panel blotches and fine aggregate speckle (colour, sRGB; R doubles as bump).
  const concrete = dataTexture(
    256,
    256,
    (u, v) => {
      const stain = fbm(u, v, 3, 71, 4);
      const agg = vnoise(u, v, 128, 72);
      const fleck = hash2(Math.floor(u * 256), Math.floor(v * 256), 73);
      const k = 0.86 + 0.16 * (stain - 0.5) + 0.07 * (agg - 0.5) + (fleck > 0.97 ? -0.12 : fleck < 0.02 ? 0.08 : 0);
      return [k, k * 0.985, k * 0.96];
    },
    { srgb: true },
  );
  // Grain: roughness variation for steel (G), streaky along v like weathered galvanizing.
  const grain = dataTexture(128, 128, (u, v) => {
    const n = 0.6 * vnoise(u, v * 0.25, 32, 81) + 0.4 * vnoise(u, v, 8, 82);
    return [0.5, 0.82 + 0.36 * (n - 0.5), 1];
  });
  // Pad paint wear: off-white with dirt (colour) and chips where the deck shows through (alpha in G).
  const wear = dataTexture(
    256,
    256,
    (u, v) => {
      const k = 0.92 - 0.16 * Math.max(0, fbm(u, v, 6, 91, 4) - 0.45) - 0.05 * vnoise(u, v, 64, 92);
      return [k, k * 0.99, k * 0.96];
    },
    { srgb: true },
  );
  const wearAlpha = dataTexture(256, 256, (u, v) => {
    const chip = fbm(u, v, 16, 93, 3) * 0.7 + vnoise(u, v, 96, 94) * 0.3;
    const a = chip > 0.66 ? 0 : 1;
    return [a, a, a];
  });
  // Apron: dark asphalt / concrete, large soft stains over a fine grain (colour, sRGB).
  const apron = dataTexture(
    512,
    512,
    (u, v) => {
      const k = 0.8 + 0.28 * (fbm(u, v, 4, 101, 4) - 0.5) + 0.1 * (vnoise(u, v, 256, 102) - 0.5);
      return [k, k, k * 1.02];
    },
    { srgb: true },
  );
  propTex = { concrete, grain, wear, wearAlpha, apron };
  return propTex;
}
// A texture clone with its own repeat (shares the pixels).
function tiled(tex, rx, ry = rx) {
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
// Scorch: darkens a prop toward its origin's axis (the pad centre) in uneven radial streaks.
// material.scorch = { value: Vector4(r0, r1, strength, 0) }: full strength inside r0, gone past r1.
function scorchHook(shader) {
  shader.uniforms.uScorch = this.scorch ?? (this.scorch = { value: new THREE.Vector4(0, 1, 0, 0) });
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vScorchP;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvScorchP = position;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vScorchP;\nuniform vec4 uScorch;")
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      float scA = atan(vScorchP.z, vScorchP.x);
      float scS = 0.5 + 0.3 * sin(scA * 17.0 + 2.0 * sin(scA * 5.0)) + 0.2 * sin(scA * 43.0);
      float scG = 1.0 - smoothstep(uScorch.x, uScorch.x + (uScorch.y - uScorch.x) * (0.5 + 0.7 * scS), length(vScorchP.xz));
      float scorch = uScorch.z * scG * (2.0 - scG);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.045, 0.04), scorch);`,
    )
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, scorch);");
}
const scorchKey = () => "prop-scorch-v1";
let propPaint = null;
function propPaintMaterials() {
  if (propPaint) return propPaint;
  const t = propTextures();
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const std = (o) => new THREE.MeshStandardMaterial({ fog: true, metalness: 0, ...po, ...o });
  const scorchable = (m) => {
    m.onBeforeCompile = scorchHook;
    m.customProgramCacheKey = scorchKey;
    return m;
  };
  propPaint = {
    concrete: scorchable(std({ color: 0xb3b0aa, roughness: 0.92, map: t.concrete, bumpMap: t.concrete, bumpScale: 0.6 })),
    trench: scorchable(std({ color: 0x5a5550, roughness: 0.96, map: t.concrete, bumpMap: t.concrete, bumpScale: 0.8 })),
    steel: std({ color: 0x34373c, metalness: 0.75, roughness: 0.42, roughnessMap: t.grain }),
    galv: std({ color: 0x5b5f64, metalness: 0.65, roughness: 0.5, roughnessMap: t.grain }),
    galvShaded: std({ color: 0x5b5f64, vertexColors: true, metalness: 0.65, roughness: 0.5, roughnessMap: t.grain }),
    person: std({ color: 0x16181c, roughness: 0.85 }),
    // Pad markings: matte white paint, worn (chips cut out by alpha test), drawn over the deck.
    marking: std({ color: 0xe9e7e1, roughness: 0.88, map: t.wear, alphaMap: t.wearAlpha, alphaTest: 0.5, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    apron: std({ color: 0x2c2d30, roughness: 0.96, map: t.apron }),
  };
  return propPaint;
}
// Gives a prop mesh its painted twin (default) next to its x-ray material; key names propPaintMaterials().
// Returns the painted clone so callers can set its textures or scorch. No-op in the classic look.
// lineK: painted line opacity / x-ray line opacity (default PROP_LINE_K; thin lattices go lower so their lines
// do not tint the steel).
export function paintProp(mesh, key, { repeat = null, scorch = null, lineK = PROP_LINE_K } = {}) {
  if (!XRAY) return null;
  mesh.userData.paintLineK = lineK;
  const painted = cloneMat(propPaintMaterials()[key]);
  if (repeat && painted.map) painted.map = tiled(painted.map, ...repeat);
  if (repeat && painted.bumpMap) painted.bumpMap = painted.map ?? tiled(painted.bumpMap, ...repeat);
  if (scorch) painted.scorch = { value: new THREE.Vector4(...scorch, 0) };
  mesh.userData.looks = { xray: mesh.material, painted };
  mesh.material = painted;
  for (const e of [mesh.userData.edges, ...mesh.children.filter((c) => c.isLineSegments)]) {
    if (!e?.userData || e.userData.base === undefined) continue;
    e.userData.base0 ??= e.userData.base;
    e.userData.base = e.userData.base0 * lineK;
    e.material.opacity = e.userData.base;
  }
  return painted;
}
// Switches every prop under root (pad, anchors) between "painted" (default) and "xray": material twins,
// edge lines (0.15 vs 0.35 level), objects that exist only in one look (userData.lookOnly: the holo rings vs
// the pad markings, the person's line figure) and per-look opacities (userData.lookOpacity: the polar grid).
// Props follow the builder: x-ray only while the whole build is in the clear look.
export function setPropLook(root, look = "painted") {
  const paint = look !== "xray";
  root.traverse((o) => {
    const looks = o.userData.looks;
    if (looks && !o.userData.partId) {
      o.material = paint ? looks.painted : looks.xray;
      for (const e of o.children) {
        if (!e.isLineSegments || e.userData.base0 === undefined) continue;
        e.userData.base = paint ? e.userData.base0 * (o.userData.paintLineK ?? PROP_LINE_K) : e.userData.base0;
        e.material.opacity = e.userData.base;
      }
    }
    if (o.userData.lookOnly) o.visible = o.userData.lookOnly === (paint ? "painted" : "xray");
    const op = o.userData.lookOpacity;
    if (op && o.material) o.material.opacity = paint ? op.painted : op.xray;
  });
}
// Disposes both looks of every mesh under root (geometry and the material in use are the caller's).
export function disposeLooks(root) {
  root.traverse((o) => {
    for (const m of Object.values(o.userData.looks ?? {})) if (m !== o.material) m.dispose();
  });
}

// Launch pad as a structure, painted by default (concrete deck and plinth, scorched trench, dark steel mount,
// clamps and rails; see paintProp / setPropLook), x-ray in the clear look (dark see-through deck and plinth,
// opaque steel inside, peach edges, the blue holo rings):
// a raised hardstand with a deck of 8 plates (expansion joints between them) around an opening over the flame
// trench; the trench as a recessed channel with side and back walls and a deflector wedge under the engines,
// exiting through the plinth wall; the launch-mount ring with struts; four hold-down clamps with bolt rings;
// the transporter-erector rails coming up a ramp; the holo rings, ground disc and polar grid. Returns
// { group, ringMat, layout, clamps } (clamps: the four hinged hold-down arms, see below).
// Static but for the clamp arms; only the deck casts and receives shadows (and the ground and markings receive).
export function createPad({ baseRadius_u = 1, cameraAzimuth = 0.58 } = {}) {
  const L = padLayout({ baseRadius_u, cameraAzimuth });
  const { b, padR, plinthH: P, deckT, holeR, mountR, trenchPhi, railPhi } = L;
  const mats = propMaterials();
  const g = new THREE.Group();
  g.name = "pad";
  const add = (geo, mat, { shadows = false, lineGeo = null, ry = 0, name, opacity = null, paint = null } = {}) => {
    const m = new THREE.Mesh(geo, cloneMat(mat));
    if (opacity !== null && m.material.transparent) m.material.opacity = opacity;
    m.rotation.y = ry;
    m.castShadow = m.receiveShadow = shadows;
    m.name = name;
    m.raycast = () => {};
    addLines(m, LINE_PROP, lineGeo ?? geo);
    if (paint) paintProp(m, paint.key, paint);
    g.add(m);
    return m;
  };
  const tile_u = 8 * S; // concrete texture tile (8 m)

  // Deck: 8 plates around the trench opening, separated by expansion joints.
  const joint = 0.012 * padR;
  const plates = [];
  for (let k = 0; k < 8; k++) {
    const a0 = (k * TAU) / 8;
    const a1 = ((k + 1) * TAU) / 8;
    const shape = new THREE.Shape();
    shape.absarc(0, 0, padR, a0 + joint / (2 * padR), a1 - joint / (2 * padR), false);
    shape.absarc(0, 0, holeR, a1 - joint / (2 * holeR), a0 + joint / (2 * holeR), true);
    plates.push(new THREE.ExtrudeGeometry(shape, { depth: deckT, bevelEnabled: false, curveSegments: 12 }));
  }
  // Painted: light concrete (extrude UVs are in units), scorched around the opening; the joints read as dark seams.
  add(merge(plates).rotateX(-Math.PI / 2).translate(0, -deckT, 0), mats.body, { shadows: true, name: "pad-deck", opacity: 0.75, paint: { key: "concrete", repeat: [1 / tile_u], scorch: [holeR * 1.05, holeR * 2.8, 0.75] } });

  // Plinth wall: open ring under the deck with a gap where the trench comes out.
  const gapHalf = Math.asin(Math.min(0.95, (holeR + 0.1 * b) / padR));
  add(lathe([[padR, -P], [padR, -deckT]], 96, trenchPhi + gapHalf, TAU - 2 * gapHalf), mats.body, { name: "pad-plinth", paint: { key: "concrete", repeat: [(TAU * padR) / tile_u, (P - deckT) / tile_u] } });

  // Flame trench (local +X runs out along trenchPhi): floor, side and back walls, deflector wedge.
  const hw = holeR;
  const wt = 0.05 * b + 0.02;
  const depth = P - deckT;
  const x0 = -holeR * 1.05;
  const x1 = padR * 1.02;
  const len = x1 - x0;
  const wedge = new THREE.Shape();
  wedge.moveTo(-0.95 * holeR, -deckT - 0.04 * P);
  wedge.lineTo(1.15 * holeR, -P + 0.04);
  wedge.lineTo(-0.95 * holeR, -P + 0.04);
  wedge.closePath();
  const trench = merge([
    box(len, 0.04, 2 * hw + 2 * wt, (x0 + x1) / 2, -P + 0.02, 0),
    box(len, depth, wt, (x0 + x1) / 2, -P + depth / 2, hw + wt / 2),
    box(len, depth, wt, (x0 + x1) / 2, -P + depth / 2, -hw - wt / 2),
    box(wt, depth, 2 * hw + 2 * wt, x0 - wt / 2, -P + depth / 2, 0),
    new THREE.ExtrudeGeometry(wedge, { depth: 1.92 * hw, bevelEnabled: false }).translate(0, 0, -0.96 * hw),
  ]);
  add(trench, mats.steelDark, { ry: trenchPhi - Math.PI / 2, name: "pad-trench", paint: { key: "trench", repeat: [1], scorch: [holeR * 0.6, holeR * 3.5, 0.85] } });

  // Launch-mount ring around the opening, braced by 8 struts down to the deck.
  const mh = 0.05 * b + 0.03;
  const mountRing = machinedRing(holeR * 1.01, mountR, mh, 0);
  const struts = [];
  for (let k = 0; k < 8; k++) {
    const phi = ((k + 0.5) * TAU) / 8;
    const o = radialPhi(phi);
    const t = new THREE.Vector3(Math.cos(phi), 0, -Math.sin(phi));
    struts.push(strut(o.clone().multiplyScalar(mountR * 0.96).setY(mh), o.clone().multiplyScalar(mountR * 1.55).setY(0), 0.05 * b, 0.04 * b, t));
  }
  add(merge([mountRing.clone(), ...struts]), mats.machined, { name: "pad-mount", paint: { key: "steel" } });

  // Hold-down clamps at 0/90/180/270° (layout azimuths, clear of S-IC style fins at 45°): a static base plate
  // with a bolt ring on the mount ring (one mesh for all four) and four hinged arms (upright + jaw against the
  // vehicle's base; one shared geometry). Each arm swings 70° outward about the outer bottom edge of its
  // upright, a tangential axis at the deck: clamps[i] = { mesh, rest, deploy } with the legs' hinge formula
  // (applyDeploy) in the pad frame. All under the group "pad-clamps".
  const ch = 0.45 * b + 0.05;
  const clampGroup = new THREE.Group();
  clampGroup.name = "pad-clamps";
  g.add(clampGroup);
  const bs = 0.025 * b + 0.004;
  const xb = (holeR * 1.01 + mountR) / 2;
  const plate = box(0.3 * b, 0.03, 0.3 * b, xb, mh + 0.015, 0);
  const bases = [];
  const baseLines = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4;
    bases.push(merge([plate.clone(), boltRing(0.1 * b, mh + 0.03 + bs / 2, 8, bs).translate(xb, 0, 0)]).rotateY(-a));
    baseLines.push(plate.clone().rotateY(-a));
  }
  const baseMesh = add(merge(bases), mats.steelDark, { name: "pad-clamp-bases", lineGeo: merge(baseLines), paint: { key: "steel" } });
  clampGroup.add(baseMesh);
  const armW = 0.09 * b;
  const armGeo = merge([box(armW, ch, 0.14 * b, b * 1.1, mh + 0.03 + ch / 2, 0), box(0.1 * b, 0.07 * b, 0.16 * b, b * 1.05, mh + 0.03 + ch - 0.035 * b, 0)]);
  const clampArms = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4;
    const arm = add(armGeo, mats.steelDark, { ry: -a, name: `pad-clamp-arm-${k}`, paint: { key: "steel" } });
    clampGroup.add(arm);
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, -a);
    clampArms.push({
      mesh: arm,
      rest: { position: arm.position.clone(), quaternion: arm.quaternion.clone() },
      // axis −Z (arm frame) turns +Y toward +X: the jaw swings out and away from the vehicle
      deploy: { axis: v3(0, 0, -1).applyQuaternion(qy), pivot: v3(b * 1.1 + armW / 2, mh + 0.03, 0).applyQuaternion(qy), angle: (70 * Math.PI) / 180, order: 0 },
    });
  }

  // Transporter-erector rails (local +X runs out along railPhi): a ramp from the deck down to the ground,
  // rails on the ramp and on the ground, sleepers on the flat part.
  const gauge = 0.5 * b + 0.15;
  const rampLen = 4 * P;
  const r0 = padR * 0.98;
  const r1 = r0 + rampLen;
  const r2 = r1 + 2.2 * padR;
  const slope = Math.atan2(P, rampLen);
  const rampL = Math.hypot(rampLen, P);
  const onRamp = (geo, yOff) => geo.rotateZ(-slope).translate((r0 + r1) / 2, -P / 2 + yOff, 0);
  const rails = [
    onRamp(new THREE.BoxGeometry(rampL, 0.04, 2 * gauge + 0.3 * b), -0.02),
    onRamp(new THREE.BoxGeometry(rampL, 0.03, 0.03), 0.015).translate(0, 0, gauge / 2),
    onRamp(new THREE.BoxGeometry(rampL, 0.03, 0.03), 0.015).translate(0, 0, -gauge / 2),
    box(r2 - r1, 0.03, 0.03, (r1 + r2) / 2, -P + 0.015, gauge / 2),
    box(r2 - r1, 0.03, 0.03, (r1 + r2) / 2, -P + 0.015, -gauge / 2),
  ];
  for (let x = r1 + 0.15; x < r2; x += 0.3) rails.push(box(0.05, 0.012, gauge + 0.15, x, -P + 0.006, 0));
  add(merge(rails), mats.steelDark, { ry: railPhi - Math.PI / 2, name: "pad-rails", paint: { key: "galv" } });

  // Holo rings on the deck (main pulses ringMat), x-ray look; one mesh for both rings.
  const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.holo, transparent: true, opacity: 0.85 });
  const ringO = padR * 0.8;
  const ringI = b * 1.45 + 0.1 * b;
  const rings = new THREE.Mesh(merge([new THREE.TorusGeometry(ringO, 0.022, 8, 160), new THREE.TorusGeometry(ringI, 0.014, 8, 120)]).rotateX(Math.PI / 2).translate(0, 0.012, 0), ringMat);
  rings.name = "pad-holo-rings";
  rings.raycast = () => {};
  g.add(rings);
  // Painted look: the same circles as worn white deck paint (a wide outer circle, a thin inner ring) and a
  // T-shaped position mark outboard of each hold-down clamp; flat on the deck, receiving shadows.
  if (XRAY) {
    rings.userData.lookOnly = "xray";
    rings.visible = false;
    const wO = 0.3 * S;
    const wI = 0.1 * S;
    const marks = [new THREE.RingGeometry(ringO - wO / 2, ringO + wO / 2, 160), new THREE.RingGeometry(ringI - wI / 2, ringI + wI / 2, 120)];
    for (let k = 0; k < 4; k++) {
      const a = (k * TAU) / 4; // the clamps' layout azimuths
      const ra = mountR * 1.7;
      const rb = Math.min(mountR * 2.3, ringO - wO);
      const stem = new THREE.PlaneGeometry(rb - ra, wO * 0.8).translate((ra + rb) / 2, 0, 0);
      const bar = new THREE.PlaneGeometry(wO * 0.8, (rb - ra) * 0.6).translate(rb, 0, 0);
      marks.push(stem.rotateZ(a), bar.rotateZ(a));
    }
    const mg = merge(marks.map((m) => (m.deleteAttribute("uv"), m))).rotateX(-Math.PI / 2);
    // Planar UVs in units, so the wear texture is continuous across circles and marks (one tile per 4 m).
    const mp = mg.attributes.position;
    const muv = new Float32Array(mp.count * 2);
    for (let i = 0; i < mp.count; i++) muv.set([mp.getX(i) / (4 * S), mp.getZ(i) / (4 * S)], i * 2);
    mg.setAttribute("uv", new THREE.BufferAttribute(muv, 2));
    const markings = new THREE.Mesh(mg.translate(0, 0.004, 0), cloneMat(propPaintMaterials().marking));
    markings.name = "pad-markings";
    markings.userData.lookOnly = "painted";
    markings.receiveShadow = true;
    markings.raycast = () => {};
    g.add(markings);
  }

  // Ground at the foot of the hardstand: dark in x-ray; painted, an asphalt / concrete apron (stains on an
  // 80 m tile) so the pad stands on something; fog still fades it out.
  const groundR = 40;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(groundR, 64), new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -P;
  ground.receiveShadow = true;
  ground.raycast = () => {};
  ground.name = "pad-ground";
  paintProp(ground, "apron", { repeat: [(2 * groundR) / (80 * S)] }); // disc UVs span its diameter
  g.add(ground);

  // Polar grid: 0.55 in x-ray, a faint 0.08 over the painted apron.
  const grid = new THREE.PolarGridHelper(Math.max(14, padR * 3), 16, 8, 96, 0x2a3140, 0x1a1f2a);
  grid.position.y = -P + 0.01;
  grid.material.transparent = true;
  grid.userData.lookOpacity = { painted: 0.08, xray: 0.55 };
  grid.material.opacity = XRAY ? 0.08 : 0.55;
  g.add(grid);

  return { group: g, ringMat, layout: L, clamps: clampArms };
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
