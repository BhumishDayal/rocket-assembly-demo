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
//   deploy      null, or an articulated deploy (payload panels/doors/legs/petals, booster legs, grid fins):
//               { axis: unit Vector3, pivot: Vector3, angle: rad, order } in part-local scene units (the frame of
//               rest.position). At deploy fraction k ∈ [0, 1], with R = rotation about axis by k·angle:
//                 mesh.position   = pivot + R · (rest.position − pivot)
//                 mesh.quaternion = R · rest.quaternion
//               Rest poses stay translation-only (+ Y turn); the rotation exists only while deployed.
//               deployables(part) lists them.
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
const frostTime = { value: 0 };
const tickFrost = () => (frostTime.value = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);
function sootHook(shader) {
  shader.uniforms.uSoot = this.soot ?? (this.soot = { value: new THREE.Vector4(0, 1, 0, 0) });
  shader.uniforms.uFrost = this.frost ?? (this.frost = { value: new THREE.Vector4(0, 0, 0, 1) });
  shader.uniforms.uFrostT = frostTime;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec2 vSoot;\nvarying vec3 vSootP;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSoot = vec2(position.y, atan(position.x, position.z));\nvSootP = position;");
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
const sootKey = () => "paint-soot-frost-v3";

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
    heatShield: keep(classic.heatShield),
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
    engine: phys({ color: new THREE.Color(2.6, 2.6, 2.6), vertexColors: true, metalness: 1, roughness: 0.34, roughnessMap: t.brushed, bumpMap: t.ridges, bumpScale: 0.25, anisotropy: 0.55, anisotropyRotation: Math.PI / 2, clearcoat: 0, envMapIntensity: 0.9 }),
    chamber: keep(classic.chamber),
    powerhead: keep(classic.powerhead),
    valve: keep(classic.valve),
    pump: keep(classic.pump),
    pipe: keep(classic.pipe),
    actuator: keep(classic.actuator),
    gimbal: keep(classic.gimbal),
    gridFin: keep(classic.gridFin),
    gold: keep(classic.gold),
    mliSilver: keep(classic.mliSilver),
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
function piece(geo, material, { x = 0, y = 0, z = 0, ry = 0, order = 0, dir = UP, dist = 0.4, side, ax = null, sym = false, kind = "detail", engine = null, edges = kind === "shell", lineGeo = null, fineGeo = null, deploy = null } = {}) {
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
  let dep = null;
  if (deploy) {
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, ry);
    dep = {
      axis: deploy.axis.clone().normalize().applyQuaternion(qy),
      pivot: deploy.pivot.clone().multiplyScalar(S).applyQuaternion(qy).add(mesh.position),
      angle: deploy.angle,
      order: deploy.order ?? 0,
    };
  }
  return { mesh, order, explode: { dir: dir.clone().normalize(), dist }, ax, sym, kind, engine, deploy: dep };
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
  // The first stage's thrust-skirt flange is a little wider and taller (relief at the base).
  const skirtRing = g.stageIndex === 0 ? machinedRing(R * 0.985, R * 1.025, skirtH * 1.3) : machinedRing(R * 0.985, R * 1.008, skirtH);
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
  // Raised panel seam strip on each quarter's leading edge (phi = 0, so four quarters give four seams).
  const seamStrip = projectUV(box(0.012 * D, y1s - y0s, 0.006 * D, 0, (y0s + y1s) / 2, R + 0.003 * D));
  const quarterGeo = merge([latheUV(lathe(shellProfile, 24, 0, Math.PI / 2), { phiStart: 0, phiLength: Math.PI / 2, H, R }), seamStrip.clone()]);
  const plain = lathe([[R, y0s], [R, y1s]], 24, 0, Math.PI / 2); // its boundary = the panel seams
  const seamWeldGeo = merge([plain, seamStrip, ...welds.map((y) => lathe([[R, y - ww], [R * 1.004, y - ww], [R * 1.004, y + ww], [R, y + ww]], 24, 0, Math.PI / 2))]);
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
    // The raceway as a run of cover plates (~2 m each with a small joint), structural lines on the plates.
    const plates = [];
    const pl = 2;
    const nP = Math.max(1, Math.floor(rwH / pl));
    for (let i = 0; i < nP; i++) {
      const len = rwH / nP - 0.12;
      plates.push(box(rwD, len, 0.07 * D, R + rwD / 2, skirtH + (i + 0.5) * (rwH / nP), 0));
    }
    const duct = merge(plates);
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
      // a bolt ring around each port on the plate face (ring built flat, turned to face +X)
      const ub = 0.01 * D;
      const portBolts = [-0.06, 0.06].map((zf) => boltRing(0.055 * D, 0, 8, ub).rotateZ(Math.PI / 2).translate(R + 0.03 * D + ub / 2, uy, zf * D));
      out.push(piece(projectUV(merge([umb.clone(), ...portBolts])), mats.steelDark, { ry: -ua, order: 2.2, dir: radial(ua), dist: shellDist * 1.1, edges: true, lineGeo: umb }));
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
    // Deploy: the folded leg (foot up) swings out and down about its base hinge, ending ~30° off vertical,
    // feet below the engines (local frame: +X radial; axis −Z turns +Y toward +X).
    const deploy = { axis: v3(0, 0, -1), pivot: v3(R + 0.5 * t0, y0 + 0.02 * len, 0), angle: (150 * Math.PI) / 180, order: 1 };
    out.push(piece(legGeo, mats.leg, { ry: -a, order: 3 + i * 0.02, dir: radial(a), dist: shellDist * 1.4, edges: true, deploy }));
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
    const deploy = { axis: v3(0, 0, -1), pivot: v3(r + d / 2, y0, 0), angle: Math.PI / 2, order: 0 }; // root hinge, +Y → +X
    out.push(piece(geo, mats.gridFin, { ry: -a, order: 4 + i * 0.02, dir: radial(a, 0.2), dist: dist * 1.3, edges: true, deploy }));
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
  // 12 raised external longerons (3 per quarter), drawn as structural lines; the panel seams stay fine.
  const ribD = 0.012 * D;
  const ribs = [];
  for (let j = 0; j < 3; j++) {
    const o = radialPhi(((j + 0.5) * (Math.PI / 2)) / 3);
    const at = (y) => o.clone().multiplyScalar(rAt(y) + ribD / 2).setY(y);
    ribs.push(strut(at(ringH), at(H - ringH), 0.016 * D, ribD, o));
  }
  const ribGeo = projectUV(merge(ribs));
  const iqRibbed = merge([iq.clone(), ribGeo.clone()]);
  for (let q = 0; q < 4; q++) {
    const ry = (q * Math.PI) / 2;
    out.push(piece(iqRibbed, mat, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4), dist: shellDist, side: DS, kind: "shell", lineGeo: ribGeo, fineGeo: iq }));
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
      // unfold 90° about the bottom inner edge so the array points out along ±Z (axis ±X turns +Y toward ±Z)
      deploy: { axis: v3(s, 0, 0), pivot: v3(0, y0 + 0.37 * H, s * 0.7 * R), angle: Math.PI / 2, order: 1 },
    });
  }
  P(projectUV(merge([cyl(R * 0.77, R * 0.77, 0.025 * H, 40, 0, y0 + 0.96 * H), box(0.12 * R, 0.04 * H, 0.2 * R, R * 0.74, y0 + 0.965 * H, 0)])), mats.machined, {
    order: 1.4,
    dist: 0.6,
    ax: [1, 0],
    edges: true,
    // aperture door swings open 110° about its hinge on the +X rim (axis −Z lifts the far side)
    deploy: { axis: v3(0, 0, -1), pivot: v3(0.77 * R, y0 + 0.985 * H, 0), angle: (110 * Math.PI) / 180, order: 0 },
  });
}

// Stowed JWST read: spacecraft bus at the base, two folded sunshield pallets, gold mirror wall between,
// secondary-mirror struts folded on top.
function webb(P, mats, R, H, y0) {
  P(projectUV(box(1.1 * R, 0.16 * H, 1.1 * R, 0, y0 + 0.08 * H)), mats.gold, { order: 1, dist: 0.2, ax: [-1, 0] });
  P(projectUV(merge([box(0.95 * R, 0.66 * H, 0.12 * R, 0, y0 + 0.16 * H + 0.33 * H, 0.18 * R), box(0.5 * R, 0.5 * H, 0.4 * R, 0, y0 + 0.16 * H + 0.25 * H, -0.2 * R)])), mats.gold, { order: 1.1, dist: 0.5, edges: true });
  for (const s of [1, -1]) {
    // pallets unfold 90° about their bottom inner edge (axis ∓Z turns +Y toward ±X)
    const deploy = { axis: v3(0, 0, -s), pivot: v3(s * 0.65 * R, y0 + 0.16 * H, 0), angle: Math.PI / 2, order: 0 };
    P(projectUV(box(0.14 * R, 0.62 * H, 1.1 * R, s * 0.72 * R, y0 + 0.16 * H + 0.31 * H)), mats.mliSilver, { order: 1.2 + (s > 0 ? 0 : 0.02), dir: v3(s, 0.3, 0), dist: 0.45, deploy });
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
  // solar array unfolds 90° about its bottom edge on the bus side (axis −Z turns +Y toward +X)
  P(projectUV(box(0.07 * R, 0.8 * H, 1.1 * R, 0.66 * R, y0 + 0.1 * H + 0.4 * H)), mats.panel, {
    order: 1.2,
    dir: v3(1, 0.3, 0),
    dist: 0.45,
    deploy: { axis: v3(0, 0, -1), pivot: v3(0.625 * R, y0 + 0.1 * H, 0), angle: Math.PI / 2, order: 0 },
  });
  P(projectUV(cyl(0.03 * R, 0.03 * R, 0.7 * H, 8, -0.66 * R, y0 + 0.1 * H)), mats.darkMetal, { order: 1.25, dir: v3(-1, 0.3, 0), dist: 0.4 });
  const aperture = (z, r) => new THREE.CylinderGeometry(r, r, 0.08 * R, 24).rotateX(Math.PI / 2).translate(-0.15 * R, y0 + 0.75 * H, z);
  P(projectUV(merge([box(0.9 * R, 0.25 * H, 0.7 * R, -0.05 * R, y0 + 0.63 * H + 0.125 * H, 0), aperture(0.37 * R, 0.12 * R), aperture(-0.37 * R, 0.08 * R)])), mats.mliSilver, { order: 1.3, dist: 0.5, ax: [1, 0], edges: true });
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

// Lander: engine, propellant tank sphere pair (inside the body), hex body, side panels, top deck + dish,
// six legs, one piece each so each can splay outward about its own hinge.
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
  for (let i = 0; i < 6; i++) {
    const a = ((i + 0.5) * TAU) / 6;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const at = (r, y) => v3(r * R * c, y0 + y * H, r * R * s);
    const knee = at(0.82, 0.2);
    const foot = at(0.94, 0.02);
    const geo = projectUV(merge([tube(at(0.55, 0.5), at(0.75, 0.35), knee, 0.025 * R, 10), rod(knee, foot, 0.025 * R), rod(at(0.5, 0.3), knee, 0.02 * R), cyl(0.07 * R, 0.08 * R, 0.02 * H, 16, foot.x, y0, foot.z)]));
    // splay 35° outward about the attach point on the body (axis (−sin a, 0, cos a) swings the foot out)
    P(geo, mats.metal, { order: 1.5 + i * 0.01, dir: radial(a, 0.2), dist: 0.35, edges: true, deploy: { axis: v3(-s, 0, c), pivot: at(0.55, 0.5), angle: (35 * Math.PI) / 180, order: 0 } });
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
    // the Apollo petals: each opens 45° outward about its bottom edge (quarter-0 frame: centre direction
    // o = (sin π/4, 0, cos π/4), hinge axis (cos π/4, 0, −sin π/4) turns +Y toward o)
    const o = radialPhi(Math.PI / 4);
    const deploy = { axis: v3(Math.cos(Math.PI / 4), 0, -Math.sin(Math.PI / 4)), pivot: o.clone().multiplyScalar(Rb).setY(y0), angle: Math.PI / 4, order: 0 };
    P(sla, mats.silver, { ry, order: 1 + q * 0.02, dir: radialPhi(ry + Math.PI / 4, 0.4), dist: 0.25 + 0.5 * Rb * S, side: DS, ax: [-1, 3], kind: "shell", deploy });
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
      deploy: p.deploy,
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
  // Bell glow: each engine's bell pieces share a lip-to-throat range (part-local y), one uniform per piece
  // shared by both looks (setBellGlow).
  const bellY = new Map();
  for (const p of pieces) {
    if (p.mesh.userData.role !== "engine") continue;
    const r = bellY.get(p.engine) ?? [Infinity, -Infinity];
    bellY.set(p.engine, [Math.min(r[0], p.bottomY), Math.max(r[1], p.topY)]);
  }
  for (const p of pieces) {
    const r = p.mesh.userData.role === "engine" && bellY.get(p.engine);
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
      const amount = m.roughness >= 0.8 ? 0.4 : 0.85; // matte sprayed foam vs paint
      m.frost = { value: new THREE.Vector4(edge - p.mesh.position.y, 0.06 * spec.height, amount, 0.012 * spec.height + 0.02) };
      p.mesh.onBeforeRender = tickFrost;
    }
  }
  axisOffsets(pieces, clamp(0.035 * spec.height, 0.04, 0.3));
  pieces.sort((a, b) => a.order - b.order || a.bottomY - b.bottomY);
  assignSpins(pieces, spec.id);
  for (const p of pieces) {
    delete p.ax;
    delete p.sym;
  }
  return { ...spec, group, pieces, built: false, busy: false };
}

// Pieces with an articulated deploy (see the header for the hinge formula), in deploy order.
export const deployables = (part) => part.pieces.filter((p) => p.deploy).sort((a, b) => a.deploy.order - b.deploy.order);

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
  }
  if (paint) return;
  for (const p of shellPieces(part)) {
    const m = p.mesh.material;
    if (!m.transparent) (m.transparent = true), (m.needsUpdate = true);
    m.opacity = clamp(value * (m.userData.opacityScale ?? 1), 0, 1);
    for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine]) if (e) e.material.opacity = clamp((e.userData.base * value) / SHELL_OPACITY, 0, 1);
  }
}

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
// the transporter-erector rails coming up a ramp; the holo rings, ground disc and polar grid.
// Static; 16 draws; only the deck casts and receives shadows (and the ground receives).
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

  // Hold-down clamps at 0/90/180/270° (layout azimuths, clear of S-IC style fins at 45°): base plate with a
  // bolt ring on the mount ring, an upright arm and a jaw against the vehicle's base.
  const ch = 0.45 * b + 0.05;
  const clamps = [];
  const clampLines = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4;
    const bs = 0.025 * b + 0.004;
    const xb = (holeR * 1.01 + mountR) / 2;
    const body = merge([box(0.3 * b, 0.03, 0.3 * b, xb, mh + 0.015, 0), box(0.09 * b, ch, 0.14 * b, b * 1.1, mh + ch / 2, 0), box(0.1 * b, 0.07 * b, 0.16 * b, b * 1.05, mh + ch - 0.035 * b, 0)]);
    const bolts = boltRing(0.1 * b, mh + 0.03 + bs / 2, 8, bs).translate(xb, 0, 0);
    clamps.push(merge([body.clone(), bolts]).rotateY(-a));
    clampLines.push(body.rotateY(-a));
  }
  add(merge(clamps), mats.steelDark, { name: "pad-clamps", lineGeo: merge(clampLines), paint: { key: "steel" } });

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

  return { group: g, ringMat, layout: L };
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
