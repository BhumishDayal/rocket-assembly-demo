// Launch complex around the pad (Kennedy LC-39 style, generic: no logos, no text). Supersedes anchors.js
// visually and keeps its API shape so the integrator can swap one for the other.
//
//   createLaunchComplex({ baseRadius_u, stackHeight_u, scale, manifest, lightingSun, cameraAzimuth?, spotLights?, pad? })
//     -> { object3d, setVisible(bool), update(t), setLook("painted" | "xray"), setRssAngle(deg),
//          tower, arms, person, human, masts, waterTower, rss, towerFrame, towerHeight_u, lamps, cableTray, trench,
//          hardstand, apron, lights, groundY_u, hardstandY_u, radius_u, fogRange(cameraDistance), adoptPad(pad),
//          dispose() }
//
// What it builds (1 scene unit = 4 m at SCALE 0.25; m() below turns metres into units):
//   (1) fixed service structure (FSS, `tower`): square red-oxide lattice, 1.15 × the stack height, 10-14 levels of
//       crossbeams (one InstancedMesh) with grating floors, 9 columns, X-bracing, a clad elevator shaft, stairs,
//       vertical propellant lines and a hammerhead crane with its antenna on top. It stands on the hardstand at the
//       anchors.js azimuth family (left of the home view) with its local +X pointing away from the rocket, origin at
//       deck level, like anchors.js. Umbilical `arms` = one per stage joint (interstage middle) and the payload
//       adapter, each { mesh, y_u, reach_u, partId } with the mesh origin on its hinge at the tower face, so the
//       director swings them with mesh.rotation.y (as with anchors.js).
//   (2) rotating service structure (RSS, `rss`, a Group child of `tower`): hinged at the FSS base on the side away
//       from the camera; setRssAngle(deg), 0 = parked (default, behind the FSS) … 120 = mated against the vehicle
//       (its inner face then clears the widest part over its span). Clear of the arms' ±70° swing when parked.
//   (3) water tower (sound suppression) 1.5 × the FSS height from the pad axis, its roof at 0.85 × the FSS height,
//       with a down pipe along the apron, up the hardstand and into the pad's plinth wall.
//   (4) four lightning towers at the hardstand corners, tops at 1.3 × the stack height, with sagging catenary wires
//       between their tops and down to ground anchors (LineSegments).
//   (5) the hardstand: a raised concrete platform (top at y = −plinthH, the pad's own ground level, so the
//       existing createPad deck stays at y = 0 with its padRadius) rising 13 m above the apron, grass slopes, a
//       crawlerway ramp leaving behind the pad (gravel lanes, grass median, the pad's rails continued down it).
//   (6) the flame trench extended from the pad's plinth exit: a channel cut through the hardstand down to grade,
//       flared wing walls, an exit deflector, scorch on the channel, the hardstand edge and a fan on the apron.
//   (7) propellant farm: two horizontal tanks and two spheres behind an earth berm, a pipe rack (instanced bents)
//       to the hardstand and up to the FSS.
//   (8) floodlight banks on the lightning towers and the FSS (instanced lamp heads with lit faces, glow sprites as
//       Points, faint additive beams), red obstruction beacons that blink, and up to 2 warm SpotLights (spotLights:
//       true; no shadows). Night by default; a lightingSun above the horizon dims them.
//   (9) perimeter fence (instanced posts + wire lines), light poles (instanced), service buildings (boxes with roof
//       lines, lit windows: an integration hangar at the foot of the ramp, a pad terminal room, a pump house, a
//       guard house, farm shelters).
//  (10) the apron: a 1.5 km plane with a faint concrete texture, macro stains, darkening away from the pad and
//       warm light pools under the floodlights (one shader hook shared by the ground pieces), fog on.
//   Plus the 1.8 m person on the deck (as anchors.js) for scale.
//
// Looks: painted PBR by default (vertex-coloured steel and cladding, textured concrete/gravel, faint peach edge
// lines: 0.15 on solid structures, 0.07 on dense lattices) and the x-ray look (dark steel, dark ground, peach lines
// at 0.35) through mesh.userData.looks twins, so parts.js setPropLook(root, look) switches it like the pad;
// setLook(look) does that plus the lights. Same draw count in both looks.
// Draws: ~40 (Falcon 9, 2 arms; ≤ 110 for every preset, see scripts/check-complex.mjs). Shadows: only the FSS (+
// beams, arms, RSS), the water tower and the buildings cast; the ground pieces receive. Nothing is pickable
// (raycast no-op, userData.nonPickable = true). Every material has fog on.
//
// Integration notes (main.js is not touched here):
//   - Add object3d under the pad group (as anchors.js). On "added" to a parent named "pad" the complex adopts it:
//     it hides the pad's own ground disc ("pad-ground") and polar grid (they would float above the lowered apron
//     and z-fight with the hardstand top) and lowers an "fx-ground-map" sibling to just under the apron. dispose()
//     and setVisible(false) restore them. adoptPad(padOrGroup) does the same explicitly.
//   - The builder's fog band (main.js: dist ± a few stack radii) hides everything past the pad; fogRange(dist)
//     returns a band that shows the complex ({ near, far }, scene units).
//   - The FSS is a fixed structure: drive the arms (mesh.rotation.y) but not tower.rotation.z (the anchors.js
//     strongback lean would tip the whole FSS).
// Sizes are visual proportions (named constants below) or real-world orders of magnitude for a generic pad; none
// is shown on screen as a fact.
import * as THREE from "three";
import { SCALE } from "./layout.js";
import { LOOK, disposeLooks, padLayout, paintProp, peachLineMaterial, propMaterial, propMaterials, setPropLook } from "./parts.js";

// ---------- visual proportions (shape only, never shown as facts) ----------
const TOWER_SHARE = 1.15; // FSS lattice top / stack height
const MAST_SHARE = 1.3; // lightning-tower top / stack height
const WATER_DIST_SHARE = 1.5; // water tower distance from the pad axis / FSS height
const WATER_TOP_SHARE = 0.85; // water tower roof above the deck / FSS height
const FSS_MIN_W_M = 12; // FSS square footprint: at least this …
const FSS_W_SHARE = 0.11; // … or this share of its height
const FSS_LEVEL_M = 6.1; // one level per ~20 ft
const FSS_LEVELS = [10, 14];
const FSS_GAP_M = 3; // FSS front face to the pad deck edge
const HARDSTAND_M = 13; // hardstand rise above the apron
const RAMP_GRADE = 0.075; // crawlerway ramp
const APRON_M = 1500;
const RSS_SPAN = [0.45, 0.92]; // RSS body, share of the stack height
const RSS_MAX_DEG = 120;
const ARM_SWING_DEG = 70; // the director's arm swing (choreo.js), kept clear of the parked RSS

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const XRAY = LOOK === "xray";
const LINE_X = 0.35; // x-ray edge-line level (parts.js LINE_PROP)
const PAINT_K = 0.15 / LINE_X; // painted look: solid structures at 0.15
const LATTICE_K = 0.2; // dense lattices: painted lines at 0.07 so the many members do not tint the steel
const POOLS = 8; // light pools in the ground shader
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const col = (hex) => new THREE.Color(hex);
const noPick = (o) => {
  o.raycast = () => {};
  o.userData.nonPickable = true;
  return o;
};

// Palette (sRGB hex, converted to linear by THREE.Color). Visual.
const PAL = {
  fss: 0x8e4030, // red-oxide lattice
  deck: 0x5d6167, // grating floors, platforms
  shaft: 0xa9aba7, // elevator shaft cladding
  crane: 0xd6d3c8,
  counterweight: 0x8b8984,
  pipe: 0xadb1b6,
  hood: 0xd9dad6,
  rssFrame: 0x767a80,
  rssClad: 0xd2d3cf,
  waterLeg: 0x8d9196,
  waterTank: 0xd3d4d0,
  waterPipe: 0x7c8086,
  mast: 0x868a8f,
  mastTop: 0xdedcd3,
  tankWhite: 0xdedfd9,
  saddle: 0x8f8c86,
  rack: 0x6b6f75,
  wall: 0xc8c2b5,
  wallHangar: 0xd6d7d2,
  band: 0x3a3d42,
  roof: 0x4d5054,
  door: 0x2c2f34,
  post: 0x7d8186,
  rail: 0x5a5e64,
  tray: 0x6e7278,
  concreteTop: 0xbdb9b1,
  concreteRamp: 0xa9a59d,
  slope: 0x4c5438,
  berm: 0x46503a,
  trench: 0x8b867f,
  apron: 0x75767a,
  gravel: 0xb3ac9d,
  median: 0x3c4430,
  asphalt: 0x47484c,
};

// ---------- procedural textures (generated once, shared) ----------

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed + 1, 2147483629);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(u, v, P, seed) {
  const x = u * P;
  const y = v * P;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % P) + P) % P;
  const y0 = ((iy % P) + P) % P;
  const x1 = (x0 + 1) % P;
  const y1 = (y0 + 1) % P;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}
function fbm(u, v, P, seed, octaves = 4) {
  let s = 0;
  let n = 0;
  for (let o = 0, a = 0.5; o < octaves; o++, a *= 0.5) {
    s += a * vnoise(u, v, P << o, seed + o);
    n += a;
  }
  return s / n;
}
function dataTexture(w, h, fill, { srgb = false, nearest = false } = {}) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 1] = fill((x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      data[i] = clamp(r, 0, 1) * 255;
      data[i + 1] = clamp(g, 0, 1) * 255;
      data[i + 2] = clamp(b, 0, 1) * 255;
      data[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = !nearest;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// Ground shader hook (apron, hardstand, trench, roads): in the site frame (object space of the site group),
// macro stains, darkening away from the pad (night: only the pad is lit), the exhaust scorch along the trench and
// fanning out past its exit, warm light pools under the floodlights. material.ground = { uniforms } per mesh
// (shared vectors, own uGK = (scorch, far, stain, pool) weights).
function groundHook(shader) {
  Object.assign(shader.uniforms, this.ground);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vSiteP;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSiteP = position;");
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
      varying vec3 vSiteP;
      uniform vec4 uGFar, uGS, uGS2, uGK;
      uniform vec4 uGPools[${POOLS}];
      uniform vec3 uGPoolColor;
      float gH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float gN(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(gH(i), gH(i + vec2(1.0, 0.0)), f.x), mix(gH(i + vec2(0.0, 1.0)), gH(i + vec2(1.0, 1.0)), f.x), f.y);
      }`,
    )
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
      vec2 gp = vSiteP.xz;
      float gMacro = 0.6 * gN(gp * uGFar.w) + 0.4 * gN(gp * uGFar.w * 4.3 + 17.0);
      diffuseColor.rgb *= mix(1.0 - 0.35 * uGK.z, 1.0 + 0.2 * uGK.z, gMacro);
      float gFar = smoothstep(uGFar.x, uGFar.x + uGFar.y, length(gp));
      diffuseColor.rgb *= mix(1.0, uGFar.z, gFar * uGK.y);
      float gIn = smoothstep(uGS.x - 0.3, uGS.x, vSiteP.x);
      float gPast = max(vSiteP.x - uGS.y, 0.0);
      float gHw = uGS.z * 1.15 + gPast * uGS.w;
      float gLen = 1.0 - smoothstep(uGS2.x * 0.3, uGS2.x, gPast);
      float gAcross = 1.0 - smoothstep(gHw * 0.5, gHw, abs(vSiteP.z));
      float gAng = atan(vSiteP.z, gPast + uGS.z * 2.0);
      float gStreak = 0.5 + 0.5 * gN(vec2(gAng * 24.0, gPast * uGS2.y));
      float gScorch = clamp(gIn * gLen * gAcross * mix(1.0, gStreak, smoothstep(0.0, uGS.z * 3.0, gPast)) * uGK.x, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.032, 0.028, 0.025), gScorch);`,
    )
    .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 1.0, gScorch);")
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      vec3 gPool = vec3(0.0);
      for (int i = 0; i < ${POOLS}; i++) {
        vec4 pl = uGPools[i];
        vec2 d = (gp - pl.xy) / max(pl.z, 1e-3);
        gPool += vec3(pl.w * exp(-dot(d, d) * 2.2));
      }
      totalEmissiveRadiance += uGPoolColor * gPool * diffuseColor.rgb * uGK.w * (1.0 - 0.7 * gScorch);`,
    );
}
const groundKey = () => "complex-ground-v1";

let SH = null;
function shared() {
  if (SH) return SH;
  const tex = {
    // Concrete, one tile = 8 m: 2 × 2 slabs with dark joints, a shade per slab, stains, aggregate speckle.
    concrete: dataTexture(
      256,
      256,
      (u, v) => {
        const du = Math.min(u % 0.5, 0.5 - (u % 0.5));
        const dv = Math.min(v % 0.5, 0.5 - (v % 0.5));
        const joint = Math.max(Math.exp(-((du / 0.0045) ** 2)), Math.exp(-((dv / 0.0045) ** 2)));
        const slab = hash2(Math.floor(u * 2), Math.floor(v * 2), 5);
        const stain = fbm(u, v, 4, 11, 4);
        const agg = vnoise(u, v, 128, 12);
        const f = hash2(Math.floor(u * 256), Math.floor(v * 256), 13);
        const fleck = f > 0.975 ? -0.12 : f < 0.02 ? 0.06 : 0;
        const k = (0.86 + 0.07 * (slab - 0.5) + 0.16 * (stain - 0.5) + 0.07 * (agg - 0.5) + fleck) * (1 - 0.42 * joint);
        return [k, k * 0.985, k * 0.955];
      },
      { srgb: true },
    ),
    // Gravel (crawlerway river rock / asphalt aggregate), one tile = 3 m.
    gravel: dataTexture(
      256,
      256,
      (u, v) => {
        const n1 = vnoise(u, v, 96, 21);
        const n2 = vnoise(u, v, 24, 22);
        const h = hash2(Math.floor(u * 256), Math.floor(v * 256), 23);
        const k = 0.6 + 0.34 * n1 + 0.14 * (h - 0.5) + 0.1 * (n2 - 0.5);
        return [k * (1 + 0.06 * (n2 - 0.5)), k * 0.975, k * (0.92 - 0.08 * (n2 - 0.5))];
      },
      { srgb: true },
    ),
    // Weathered steel roughness (G), streaky along v.
    grain: dataTexture(128, 128, (u, v) => {
      const n = 0.6 * vnoise(u, v * 0.25, 32, 81) + 0.4 * vnoise(u, v, 8, 82);
      return [0.5, 0.82 + 0.36 * (n - 0.5), 1];
    }),
    // Corrugated cladding: 4 ribs per 1.2 m tile (bump in R).
    siding: dataTexture(64, 4, (u) => {
      const r = 0.5 + 0.5 * Math.cos(u * TAU * 4);
      return [r, 0.8 + 0.2 * r, 1];
    }),
    // Soft round glow for the light sprites.
    glow: dataTexture(64, 64, (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5) / 0.5;
      const a = Math.exp(-((r / 0.28) ** 2)) * 0.85 + Math.exp(-((r / 0.62) ** 2)) * 0.25;
      return [1, 1, 1, a * (1 - smooth(0.85, 1, r))];
    }),
    // Lamp heads: dark housing (left texel), lit lens (right texel), as an emissive map.
    lampFace: dataTexture(2, 1, (u) => (u > 0.5 ? [1, 1, 1] : [0, 0, 0]), { nearest: true }),
    // Beam fade: alpha along the cone (v = 1 at the lamp).
    fade: dataTexture(4, 64, (u, v) => {
      const a = v ** 2.2;
      return [a, a, a];
    }),
  };
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const std = (o) => new THREE.MeshStandardMaterial({ fog: true, ...po, ...o });
  const ground = (mt) => {
    mt.onBeforeCompile = groundHook;
    mt.customProgramCacheKey = groundKey;
    return mt;
  };
  SH = {
    tex,
    steel: std({ color: 0xffffff, vertexColors: true, metalness: 0.45, roughness: 0.52, roughnessMap: tex.grain }),
    clad: std({ color: 0xffffff, vertexColors: true, metalness: 0.08, roughness: 0.72, bumpMap: tex.siding, bumpScale: 0.6 }),
    concrete: ground(std({ color: 0xffffff, vertexColors: true, roughness: 0.93, map: tex.concrete, bumpMap: tex.concrete, bumpScale: 0.45 })),
    gravel: ground(std({ color: 0xffffff, vertexColors: true, roughness: 0.98, map: tex.gravel, bumpMap: tex.gravel, bumpScale: 0.6, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })),
    lamp: new THREE.MeshStandardMaterial({ color: 0x2b2d32, metalness: 0.55, roughness: 0.45, emissive: 0xffe2b6, emissiveMap: tex.lampFace, emissiveIntensity: 3.2, fog: true }),
    window: new THREE.MeshBasicMaterial({ color: 0xffcf98, fog: true }),
  };
  return SH;
}

// X-ray twins (one per mesh): dark steel for structures, dark ground, a dark solid for the hardstand.
const xSteel = () => propMaterial(propMaterials().steelDark);
const xGround = (offset = 1) => new THREE.MeshStandardMaterial({ color: 0x0c0e14, metalness: 0.2, roughness: 0.95, fog: true, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset * 4 });
const xSolid = () => new THREE.MeshStandardMaterial({ color: 0x17191e, metalness: 0.3, roughness: 0.85, fog: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

// ---------- geometry emitter ----------
// Appends faces straight into arrays (thousands of members without a BufferGeometry each), with flat or smooth
// normals, planar UVs in tiles of `tile` units by dominant normal axis, a vertex colour per face, and optional edge
// segments for the line child (box edges, rims), so no EdgesGeometry pass is needed.
class Builder {
  constructor(tile = 1) {
    this.tile = tile;
    this.nv = 0; // vertices
    this.ni = 0; // indices
    this.nl = 0; // line floats
    this.P = new Float32Array(3 * 2048);
    this.N = new Float32Array(3 * 2048);
    this.U = new Float32Array(2 * 2048);
    this.C = new Float32Array(3 * 2048);
    this.I = new Uint32Array(3 * 2048);
    this.Lb = new Float32Array(6 * 1024);
    this.q = new Float64Array(24); // box corners scratch
  }
  get n() {
    return this.nv;
  }
  static grown(a, need) {
    let cap = a.length;
    while (cap < need) cap *= 2;
    const b = new a.constructor(cap);
    b.set(a);
    return b;
  }
  room(v, i) {
    if ((this.nv + v) * 3 > this.P.length) {
      const need = (this.nv + v) * 3;
      this.P = Builder.grown(this.P, need);
      this.N = Builder.grown(this.N, need);
      this.C = Builder.grown(this.C, need);
      this.U = Builder.grown(this.U, (this.nv + v) * 2);
    }
    if (this.ni + i > this.I.length) this.I = Builder.grown(this.I, this.ni + i);
  }
  vtx(x, y, z, nx, ny, nz, c) {
    const i = this.nv++;
    const P = this.P;
    const N = this.N;
    const Cc = this.C;
    P[3 * i] = x;
    P[3 * i + 1] = y;
    P[3 * i + 2] = z;
    N[3 * i] = nx;
    N[3 * i + 1] = ny;
    N[3 * i + 2] = nz;
    Cc[3 * i] = c.r;
    Cc[3 * i + 1] = c.g;
    Cc[3 * i + 2] = c.b;
    const t = this.tile;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let u;
    let v;
    if (ay >= ax && ay >= az) (u = x / t), (v = z / t);
    else if (ax >= az) (u = z / t), (v = y / t);
    else (u = x / t), (v = y / t);
    this.U[2 * i] = u;
    this.U[2 * i + 1] = v;
  }
  idx(a, b, c) {
    const I = this.I;
    I[this.ni++] = a;
    I[this.ni++] = b;
    I[this.ni++] = c;
  }
  segXYZ(x0, y0, z0, x1, y1, z1) {
    if (this.nl + 6 > this.Lb.length) this.Lb = Builder.grown(this.Lb, this.nl + 6);
    const L = this.Lb;
    L[this.nl++] = x0;
    L[this.nl++] = y0;
    L[this.nl++] = z0;
    L[this.nl++] = x1;
    L[this.nl++] = y1;
    L[this.nl++] = z1;
    return this;
  }
  seg(a, b) {
    return this.segXYZ(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  loop(pts, closed = true) {
    for (let k = 0; k < pts.length - (closed ? 0 : 1); k++) this.seg(pts[k], pts[(k + 1) % pts.length]);
    return this;
  }
  // Quad from 4 points in a flat array q at corner indices a, b, c, d (counter-clockwise from the front).
  quadQ(q, a, b, c, d, color) {
    const ax = q[3 * a];
    const ay = q[3 * a + 1];
    const az = q[3 * a + 2];
    const ux = q[3 * b] - ax;
    const uy = q[3 * b + 1] - ay;
    const uz = q[3 * b + 2] - az;
    const wx = q[3 * d] - ax;
    const wy = q[3 * d + 1] - ay;
    const wz = q[3 * d + 2] - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.room(4, 6);
    const i = this.nv;
    for (const k of [a, b, c, d]) this.vtx(q[3 * k], q[3 * k + 1], q[3 * k + 2], nx, ny, nz, color);
    this.idx(i, i + 1, i + 2);
    this.idx(i, i + 2, i + 3);
  }
  // a → b → c → d counter-clockwise seen from the front (normal (b − a) × (d − a)).
  quad(a, b, c, d, color, lines = false) {
    const q = this.q;
    [a, b, c, d].forEach((p, k) => {
      q[3 * k] = p.x;
      q[3 * k + 1] = p.y;
      q[3 * k + 2] = p.z;
    });
    this.quadQ(q, 0, 1, 2, 3, color);
    if (lines) this.loop([a, b, c, d]);
    return this;
  }
  tri(a, b, c, color, lines = false) {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const wx = c.x - a.x;
    const wy = c.y - a.y;
    const wz = c.z - a.z;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.room(3, 3);
    const i = this.nv;
    for (const p of [a, b, c]) this.vtx(p.x, p.y, p.z, nx, ny, nz, color);
    this.idx(i, i + 1, i + 2);
    if (lines) this.loop([a, b, c]);
    return this;
  }
  // Box from its centre and three half-extent axes (any handedness).
  box(c, ex, ey, ez, color, lines = true) {
    let zx = ez.x;
    let zy = ez.y;
    let zz = ez.z;
    if ((ex.y * ey.z - ex.z * ey.y) * zx + (ex.z * ey.x - ex.x * ey.z) * zy + (ex.x * ey.y - ex.y * ey.x) * zz < 0) (zx = -zx), (zy = -zy), (zz = -zz); // keep faces outward
    const q = this.q;
    for (let k = 0; k < 8; k++) {
      const sx = BOX_S[3 * k];
      const sy = BOX_S[3 * k + 1];
      const sz = BOX_S[3 * k + 2];
      q[3 * k] = c.x + sx * ex.x + sy * ey.x + sz * zx;
      q[3 * k + 1] = c.y + sx * ex.y + sy * ey.y + sz * zy;
      q[3 * k + 2] = c.z + sx * ex.z + sy * ey.z + sz * zz;
    }
    for (let f = 0; f < 6; f++) this.quadQ(q, BOX_F[4 * f], BOX_F[4 * f + 1], BOX_F[4 * f + 2], BOX_F[4 * f + 3], color);
    if (lines) for (let e = 0; e < 12; e++) {
      const a = BOX_E[2 * e];
      const b = BOX_E[2 * e + 1];
      this.segXYZ(q[3 * a], q[3 * a + 1], q[3 * a + 2], q[3 * b], q[3 * b + 1], q[3 * b + 2]);
    }
    return this;
  }
  // Axis-aligned box by centre and full sizes.
  aabb(x, y, z, w, h, d, color, lines = true) {
    return this.box(_c.set(x, y, z), _ex.set(w / 2, 0, 0), _ey.set(0, h / 2, 0), _ez.set(0, 0, d / 2), color, lines);
  }
  // Box spanning a → b, cross-section w (along out × axis) by d; `out` picks the thin side's facing.
  strut(a, b, w, d, color, out = null, lines = true) {
    const ey = _ey.subVectors(b, a).multiplyScalar(0.5);
    const len = ey.length();
    if (len < 1e-6) return this;
    const dir = _d.copy(ey).divideScalar(len);
    let o = out ?? (Math.abs(dir.y) > 0.9 ? _X : _Y);
    if (Math.abs(_o.copy(o).normalize().dot(dir)) > 0.98) o = Math.abs(dir.x) < 0.9 ? _X : _Z;
    const ez = _ez.crossVectors(o, dir).normalize();
    const ex = _ex.crossVectors(dir, ez).normalize().multiplyScalar(d / 2);
    ez.multiplyScalar(w / 2);
    return this.box(_c.copy(a).add(ey), ex, ey, ez, color, lines);
  }
  // Cylinder / cone frustum from a (radius r0) to b (radius r1), smooth sides, flat caps; rims as lines.
  cyl(a, b, r0, r1, seg, color, { caps = true, lines = false } = {}) {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    let dx = b.x - ax;
    let dy = b.y - ay;
    let dz = b.z - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return this;
    dx /= len;
    dy /= len;
    dz /= len;
    const t1 = _ex.set(dx, dy, dz).cross(Math.abs(dy) < 0.9 ? _Y : _X).normalize();
    const t2 = _ey.set(dx, dy, dz).cross(t1);
    const k = (r0 - r1) / len;
    this.room(2 * (seg + 1) + (caps ? 2 * (seg + 2) : 0), 6 * seg + (caps ? 6 * seg : 0));
    const base = this.nv;
    const ring = new Float64Array(6 * (seg + 1));
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * TAU;
      const cx = Math.cos(ang);
      const sx = Math.sin(ang);
      const rx = t1.x * cx + t2.x * sx;
      const ry = t1.y * cx + t2.y * sx;
      const rz = t1.z * cx + t2.z * sx;
      let nx = rx + dx * k;
      let ny = ry + dy * k;
      let nz = rz + dz * k;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      ring[6 * i] = ax + rx * r0;
      ring[6 * i + 1] = ay + ry * r0;
      ring[6 * i + 2] = az + rz * r0;
      ring[6 * i + 3] = b.x + rx * r1;
      ring[6 * i + 4] = b.y + ry * r1;
      ring[6 * i + 5] = b.z + rz * r1;
      this.vtx(ring[6 * i], ring[6 * i + 1], ring[6 * i + 2], nx, ny, nz, color);
      this.vtx(ring[6 * i + 3], ring[6 * i + 4], ring[6 * i + 5], nx, ny, nz, color);
    }
    for (let i = 0; i < seg; i++) {
      const v0 = base + 2 * i;
      this.idx(v0, v0 + 2, v0 + 1);
      this.idx(v0 + 1, v0 + 2, v0 + 3);
    }
    if (caps) {
      for (const [off, cx, cy, cz, sgn, r] of [
        [0, ax, ay, az, -1, r0],
        [3, b.x, b.y, b.z, 1, r1],
      ]) {
        if (r < 1e-6) continue;
        const ci = this.nv;
        this.vtx(cx, cy, cz, dx * sgn, dy * sgn, dz * sgn, color);
        for (let i = 0; i <= seg; i++) this.vtx(ring[6 * i + off], ring[6 * i + off + 1], ring[6 * i + off + 2], dx * sgn, dy * sgn, dz * sgn, color);
        for (let i = 0; i < seg; i++) {
          if (sgn > 0) this.idx(ci, ci + 1 + i, ci + 2 + i);
          else this.idx(ci, ci + 2 + i, ci + 1 + i);
        }
      }
    }
    if (lines) {
      for (const [off, r] of [
        [0, r0],
        [3, r1],
      ]) {
        if (r < 1e-6) continue;
        for (let i = 0; i < seg; i++) this.segXYZ(ring[6 * i + off], ring[6 * i + off + 1], ring[6 * i + off + 2], ring[6 * (i + 1) + off], ring[6 * (i + 1) + off + 1], ring[6 * (i + 1) + off + 2]);
      }
    }
    return this;
  }
  // Surface of revolution about the vertical axis through c: profile [[r, y], …] bottom to top (y relative to
  // c.y). Normals are smoothed across profile joints under 35°, hard above (and drawn as rim lines there).
  lathe(c, profile, seg, color, lines = true) {
    const segN = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const dr = profile[i + 1][0] - profile[i][0];
      const dy = profile[i + 1][1] - profile[i][1];
      const l = Math.hypot(dr, dy) || 1;
      segN.push([dy / l, -dr / l]);
    }
    const smoothAt = (i) => i > 0 && i < segN.length && segN[i - 1][0] * segN[i][0] + segN[i - 1][1] * segN[i][1] > Math.cos(35 * DEG);
    this.room(segN.length * 2 * (seg + 1), segN.length * 6 * seg);
    for (let s = 0; s < segN.length; s++) {
      const nAt = (end) => {
        const i = s + end;
        if (!smoothAt(i)) return segN[s];
        const a = segN[i - 1];
        const b = segN[i];
        const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
        return [(a[0] + b[0]) / l, (a[1] + b[1]) / l];
      };
      const n0 = nAt(0);
      const n1 = nAt(1);
      const [r0, y0] = profile[s];
      const [r1, y1] = profile[s + 1];
      const base = this.nv;
      for (let i = 0; i <= seg; i++) {
        const ang = (i / seg) * TAU;
        const cx = Math.cos(ang);
        const sz = Math.sin(ang);
        this.vtx(c.x + cx * r0, c.y + y0, c.z + sz * r0, cx * n0[0], n0[1], sz * n0[0], color);
        this.vtx(c.x + cx * r1, c.y + y1, c.z + sz * r1, cx * n1[0], n1[1], sz * n1[0], color);
      }
      for (let i = 0; i < seg; i++) {
        const v0 = base + 2 * i;
        this.idx(v0, v0 + 1, v0 + 2);
        this.idx(v0 + 1, v0 + 3, v0 + 2);
      }
    }
    if (lines) {
      for (let i = 0; i < profile.length; i++) {
        const hard = i === 0 || i === profile.length - 1 || !smoothAt(i);
        const r = profile[i][0];
        if (!hard || r < 1e-6) continue;
        const y = c.y + profile[i][1];
        for (let k = 0; k < seg; k++) {
          const a0 = (k / seg) * TAU;
          const a1 = ((k + 1) / seg) * TAU;
          this.segXYZ(c.x + Math.cos(a0) * r, y, c.z + Math.sin(a0) * r, c.x + Math.cos(a1) * r, y, c.z + Math.sin(a1) * r);
        }
      }
    }
    return this;
  }
  sphere(c, r, color, ws = 20, hs = 12) {
    const prof = [];
    for (let i = 0; i <= hs; i++) {
      const a = -Math.PI / 2 + (i / hs) * Math.PI;
      prof.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return this.lathe(c, prof, ws, color, false);
  }
  // Set the UVs of vertices from index v0 on to one point (the lamp heads' emissive map).
  uvFrom(v0, u, v) {
    for (let i = v0; i < this.nv; i++) (this.U[2 * i] = u), (this.U[2 * i + 1] = v);
  }
  lineArray() {
    return this.Lb.slice(0, this.nl);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.P.slice(0, 3 * this.nv), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(this.N.slice(0, 3 * this.nv), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(this.U.slice(0, 2 * this.nv), 2));
    g.setAttribute("color", new THREE.BufferAttribute(this.C.slice(0, 3 * this.nv), 3));
    const I = this.nv > 65535 ? this.I.slice(0, this.ni) : Uint16Array.from(this.I.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
  lineGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.lineArray(), 3));
    g.computeBoundingSphere();
    return g;
  }
}
// Box corners (sign triples), faces (corner quads, counter-clockwise from outside) and edges.
const BOX_S = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const BOX_F = [5, 1, 2, 6, 0, 4, 7, 3, 7, 6, 2, 3, 0, 1, 5, 4, 4, 5, 6, 7, 1, 0, 3, 2];
const BOX_E = [0, 1, 1, 5, 5, 4, 4, 0, 3, 2, 2, 6, 6, 7, 7, 3, 0, 3, 1, 2, 5, 6, 4, 7];
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _o = new THREE.Vector3();
const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

// A prop mesh in both looks: painted (a clone of `paint`, default) and x-ray (`xray`), with the builder's edge
// segments as a peach line child (x-ray level LINE_X, painted × lineK). Classic look (?look=classic): painted
// only, no lines.
function lookMesh(B, name, paint, { xray = xSteel, lineK = PAINT_K, lines = true, cast = false, receive = true, ground = null } = {}) {
  const painted = propMaterial(paint);
  if (ground) painted.ground = ground;
  const mesh = noPick(new THREE.Mesh(B.geometry(), painted));
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  if (!XRAY) return mesh;
  const xm = xray();
  mesh.userData.looks = { xray: xm, painted };
  mesh.userData.paintLineK = lineK;
  if (lines && B.nl) {
    const ln = noPick(new THREE.LineSegments(B.lineGeometry(), peachLineMaterial(LINE_X)));
    ln.name = "edges";
    ln.userData.base0 = LINE_X;
    ln.userData.base = LINE_X * lineK;
    ln.material.opacity = ln.userData.base;
    mesh.add(ln);
    mesh.userData.edges = ln;
  }
  return mesh;
}

// Catenary between a and b (sag = drop of the lowest point below the chord's middle), as segment pairs.
function catenary(a, b, sag, n = 24) {
  const out = [];
  let prev = a.clone();
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t) * (1 + 0.12 * (1 - 4 * (t - 0.5) ** 2)); // parabola, a touch fuller (catenary-like)
    out.push(prev, p);
    prev = p;
  }
  return out;
}

// Widest vehicle radius (non-engine parts) over a height band, from the manifest (scene units).
function widestIn(manifest, y0, y1) {
  if (!Array.isArray(manifest)) return 0;
  return Math.max(0, ...manifest.filter((s) => s.kind !== "engines" && s.slotY <= y1 + 1e-9 && s.slotY + s.height >= y0 - 1e-9).map((s) => s.radius));
}
// Umbilical arm heights, as anchors.js: the middle of every interstage and the payload adapter.
function armSpecs(manifest, scale) {
  if (!Array.isArray(manifest)) return [];
  const out = [];
  for (const s of manifest) {
    if (s.kind === "interstage") out.push({ y: s.slotY + s.height / 2, id: s.id });
    if (s.kind === "payload") out.push({ y: s.slotY + Math.max(0.5 * (s.geom?.adapterH_m ?? 0) * scale, 0.02), id: s.id });
  }
  return out.map((a) => ({ ...a, r: widestIn(manifest, a.y, a.y) }));
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Signed area of a plan polygon [[x, z], …] (> 0: counter-clockwise with x right, z up).
const polyArea = (poly) => poly.reduce((s, [x0, z0], i) => s + x0 * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * z0, 0) / 2;
// Outward unit normal of edge i → j of a plan polygon.
function edgeNormal(poly, i, j) {
  const sgn = polyArea(poly) > 0 ? 1 : -1;
  const dx = poly[j][0] - poly[i][0];
  const dz = poly[j][1] - poly[i][1];
  const l = Math.hypot(dx, dz) || 1;
  return [(sgn * dz) / l, (-sgn * dx) / l];
}
// Polygon offset outward by d with mitred corners.
function offsetPoly(poly, d) {
  const n = poly.length;
  const nrm = (i) => edgeNormal(poly, i, (i + 1) % n);
  return poly.map((p, i) => {
    const a = nrm((i - 1 + n) % n);
    const b = nrm(i);
    const mx = a[0] + b[0];
    const mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz) || 1;
    const cosH = (mx / ml) * b[0] + (mz / ml) * b[1];
    const k = d / Math.max(0.35, cosH);
    return [p[0] + (mx / ml) * k, p[1] + (mz / ml) * k];
  });
}

export function createLaunchComplex({
  baseRadius_u = 1,
  stackHeight_u = 10,
  scale = SCALE,
  manifest = null,
  lightingSun = null,
  cameraAzimuth = 0.58,
  spotLights = true,
  pad = null,
} = {}) {
  const S = shared();
  const L = padLayout({ baseRadius_u, cameraAzimuth });
  const { b, padR, plinthH: P, holeR, mountR, trenchPhi } = L;
  const H = Math.max(0.1, Number(stackHeight_u) || 0.1);
  const sc = Number(scale) > 0 ? Number(scale) : SCALE;
  const m = (metres) => metres * sc;
  const C = Object.fromEntries(Object.entries(PAL).map(([k, h]) => [k, col(h)]));
  const topY = -P; // hardstand top = the pad's ground level
  const HS = m(HARDSTAND_M);
  const groundY = topY - HS; // the apron

  // Night or day from the sun (Vector3 toward it, or a light / object with a position and a target).
  let sunDir = null;
  if (lightingSun?.isVector3) sunDir = lightingSun.clone();
  else if (lightingSun?.isObject3D) sunDir = lightingSun.position.clone().sub(lightingSun.target?.position ?? v3());
  const night = !(sunDir && sunDir.lengthSq() > 1e-9 && sunDir.normalize().y > 0.08);
  const floodK = night ? 1 : 0.25;

  const object3d = new THREE.Group();
  object3d.name = "launch-complex";
  // Site frame: +x along the trench (right of the home view), +z toward the home camera, −z back (crawlerway).
  const site = new THREE.Group();
  site.name = "complex-site";
  site.rotation.y = trenchPhi - Math.PI / 2;
  object3d.add(site);

  // ---------- (1) fixed service structure: dimensions ----------
  const tH = TOWER_SHARE * H;
  const wF = Math.max(m(FSS_MIN_W_M), FSS_W_SHARE * tH);
  const hw = wF / 2;
  const dT = padR + m(FSS_GAP_M) + hw;
  const phiT = trenchPhi - Math.PI; // straight left of the home view, faces aligned with the hardstand
  const levels = clamp(Math.round((tH - topY) / m(FSS_LEVEL_M)), FSS_LEVELS[0], FSS_LEVELS[1]);
  // tower-local (x out, z) → site (x, z)
  const towerToSite = (x, z) => [-dT - x, -z];

  // ---------- (2) RSS geometry (tower-local plan) ----------
  const wR = 0.8 * wF;
  const hwR = wR / 2;
  const yR0 = RSS_SPAN[0] * H;
  const yR1 = RSS_SPAN[1] * H;
  const rVeh = Math.max(b, widestIn(manifest, yR0, yR1));
  const arms0 = armSpecs(manifest, sc);
  const maxReach = Math.max(m(6), ...arms0.map((a) => Math.max(0.05, dT - hw - a.r - 0.03)));
  // Hinge on the far side (local +z): far enough out that the parked RSS clears the arms' swing.
  let gapR = m(1.5);
  const hinge = { x: -hw + m(1), z: 0 };
  const rss = { thM: 0, thP: 0, s0: 0, LR: 0, colS: 0, colZ: 0, wOff: 0 };
  const solveRss = () => {
    hinge.z = hw + hwR + gapR;
    let ex = -dT - hinge.x;
    let ez = -hinge.z;
    const D = Math.hypot(ex, ez);
    ex /= D;
    ez /= D;
    const wOff = Math.min(0.92 * D, hwR + rVeh + m(1));
    const dl = Math.asin(wOff / D);
    const dx = ex * Math.cos(dl) + ez * Math.sin(dl);
    const dz = -ex * Math.sin(dl) + ez * Math.cos(dl);
    rss.wOff = wOff;
    rss.s0 = Math.sqrt(D * D - wOff * wOff);
    rss.LR = rss.s0 + 0.35 * wR;
    rss.thM = Math.atan2(-dz, dx);
    rss.thP = rss.thM + RSS_MAX_DEG * DEG;
    const zV = (-dT - hinge.x) * Math.sin(rss.thM) + -hinge.z * Math.cos(rss.thM);
    rss.inner = zV > 0 ? 1 : -1; // RSS-local z side facing the vehicle when mated
    rss.colS = rss.s0;
    rss.colZ = -rss.inner * (hwR - m(1));
  };
  // RSS-local (s, z) → tower-local plan at angle th
  const rssToTower = (s, z, th) => [hinge.x + s * Math.cos(th) + z * Math.sin(th), hinge.z - s * Math.sin(th) + z * Math.cos(th)];
  // Clearance of the parked RSS body from every arm's swept disc (arm hinge at (−hw, 0), radius = reach).
  const parkedClear = () => {
    const pts = [];
    for (let i = 0; i <= 8; i++) for (const z of [-hwR, hwR]) pts.push(rssToTower((rss.LR * i) / 8, z, rss.thP));
    for (let i = 0; i <= 6; i++) pts.push(rssToTower(0, -hwR + (wR * i) / 6, rss.thP));
    return Math.min(...pts.map(([x, z]) => Math.hypot(x + hw, z))) - maxReach;
  };
  solveRss();
  for (let i = 0; i < 12 && arms0.length && parkedClear() < m(1.5); i++) {
    gapR += m(1.5);
    solveRss();
  }

  // ---------- (5) hardstand plan (site frame) ----------
  const cwT = holeR + 0.05 * b + 0.02; // trench half-width incl. its walls (createPad)
  const gauge = 0.5 * b + 0.15; // createPad rails
  const rr2 = padR * 0.98 + 4 * P + 2.2 * padR; // end of the pad's rails behind it
  const xs0 = padR * 1.02; // the pad trench's exit
  const xR = Math.max(1.9 * padR, padR + m(14));
  const zF = xR;
  // RSS column arc and the FSS footprint decide the left and back extents.
  let arcMinX = 0;
  let arcMinZ = 0;
  for (let i = 0; i <= 24; i++) {
    const th = rss.thM + ((rss.thP - rss.thM) * i) / 24;
    for (const [s, z] of [
      [rss.colS, rss.colZ],
      [0, 0],
    ]) {
      const [tx, tz] = rssToTower(s, z, th);
      const [sx, sz] = towerToSite(tx, tz);
      arcMinX = Math.min(arcMinX, sx);
      arcMinZ = Math.min(arcMinZ, sz);
    }
  }
  const xL = Math.max(dT + hw + m(10), -arcMinX + m(8));
  const lane = m(10);
  const median = m(9);
  const rampHalf = median / 2 + lane + m(3);
  const zB = Math.max(rr2 + m(8), -arcMinZ + m(8), hw + m(10));
  const chm = 0.32 * Math.min(xR, zF);
  // Outline (x, z), counter-clockwise seen from above, with the trench notch on the right edge.
  const outline = [
    [xR, -cwT],
    [xs0, -cwT],
    [xs0, cwT],
    [xR, cwT],
    [xR, zF - chm],
    [xR - chm, zF],
    [-xL + chm, zF],
    [-xL, zF - chm],
    [-xL, -zB + chm],
    [-xL + chm, -zB],
    [-rampHalf, -zB],
    [rampHalf, -zB],
    [xR - chm, -zB],
    [xR, -zB + chm],
  ];
  // Slope edges (outline index pairs) that get a 45° grass slope down to the apron; the notch and the ramp
  // opening are skipped (the channel walls and the ramp body close them).
  const slopeRuns = [
    [3, 4, 5, 6, 7, 8, 9, 10], // right-front … back-left, ends at the ramp
    [11, 12, 13, 0], // ramp … right-back, ends at the notch
  ];
  const rampLen = HS / RAMP_GRADE;
  const xF = xR + HS; // channel reaches grade at the slope foot
  const exitLen = m(34);
  const xE = xF + exitLen;

  // ---------- lightning towers, water tower, farm, buildings: plan ----------
  const towerOut = HS + m(9);
  const mastXY = [
    [xR + towerOut, zF + towerOut], // front-right
    [xR + towerOut, -zB - towerOut * 0.6], // back-right
    [-xL - towerOut, -zB - towerOut * 0.6], // back-left
    [-xL - towerOut, zF + towerOut], // front-left
  ];
  const mastTop = MAST_SHARE * H;
  const dW = WATER_DIST_SHARE * tH;
  const wAng = -38 * DEG; // right and behind
  const WT = [dW * Math.cos(wAng), dW * Math.sin(wAng)];
  const farmHalfX = m(46);
  const farmHalfZ = m(34);
  const farm = [-(xL + HS + m(84) + farmHalfX * 0), -(zB + HS + m(14))]; // berm (outer slope ~10 m) clear of the back-left tower
  const hangar = { x: rampHalf + m(34) + m(24), z: -(zB + rampLen + m(30)), w: m(48), d: m(84), h: m(26) };

  // Ground uniforms shared by every ground material of this complex.
  const pools = Array.from({ length: POOLS }, () => new THREE.Vector4(0, 0, 1, 0));
  const groundU = {
    uGFar: { value: new THREE.Vector4(0, 1, 0.3, 1 / m(60)) },
    uGS: { value: new THREE.Vector4(xs0, xF, cwT, 0.42) },
    uGS2: { value: new THREE.Vector4(m(150), 0.35 / m(4), 0, 0) },
    uGPools: { value: pools },
    uGPoolColor: { value: new THREE.Color(1.0, 0.78, 0.55).multiplyScalar(0.9 * floodK) },
  };
  const groundOf = (scorch, far, stain, pool) => ({ ...groundU, uGK: { value: new THREE.Vector4(scorch, far, stain, pool) } });

  // ---------- hardstand mesh ----------
  const conc = new Builder(m(8));
  {
    const tris = THREE.ShapeUtils.triangulateShape(outline.map(([x, z]) => new THREE.Vector2(x, -z)), []);
    const pts = outline.map(([x, z]) => v3(x, topY, z));
    for (const [a, bb, c] of tris) {
      // keep the faces up
      const A = pts[a];
      const B2 = pts[bb];
      const Cc = pts[c];
      const ny = (B2.z - A.z) * (Cc.x - A.x) - (B2.x - A.x) * (Cc.z - A.z);
      if (ny >= 0) conc.tri(A, B2, Cc, C.concreteTop);
      else conc.tri(A, Cc, B2, C.concreteTop);
    }
    conc.loop(pts);
    // Slopes, mitred at corners, square at the run ends.
    const outer = offsetPoly(outline, HS);
    for (const run of slopeRuns) {
      for (let k = 0; k < run.length - 1; k++) {
        const i = run[k];
        const j = run[k + 1];
        const [nx, nz] = edgeNormal(outline, i, j);
        const sq = (idx) => [outline[idx][0] + nx * HS, outline[idx][1] + nz * HS];
        const bi = k === 0 ? sq(i) : outer[i];
        const bj = k === run.length - 2 ? sq(j) : outer[j];
        const tA = v3(outline[i][0], topY, outline[i][1]);
        const tB = v3(outline[j][0], topY, outline[j][1]);
        const gA = v3(bi[0], groundY, bi[1]);
        const gB = v3(bj[0], groundY, bj[1]);
        quadOut(conc, tA, tB, gB, gA, C.slope);
        conc.seg(gA, gB).seg(tA, gA);
        if (k === run.length - 2) conc.seg(tB, gB);
      }
    }
    // Ramp: concrete deck (under the gravel lanes) and grass side slopes, down to the apron behind the pad.
    const r0 = v3(-rampHalf, topY, -zB);
    const r1 = v3(rampHalf, topY, -zB);
    const r2 = v3(rampHalf, groundY, -zB - rampLen);
    const r3 = v3(-rampHalf, groundY, -zB - rampLen);
    quadUp(conc, r0, r1, r2, r3, C.concreteRamp);
    conc.seg(r0, r3).seg(r1, r2);
    for (const s of [-1, 1]) {
      const top = v3(s * rampHalf, topY, -zB);
      const foot = v3(s * (rampHalf + HS), groundY, -zB);
      const end = v3(s * rampHalf, groundY, -zB - rampLen);
      triOut(conc, top, foot, end, C.slope, v3(s, 0.5, 0));
      conc.seg(foot, end);
    }
  }
  const hardstand = lookMesh(conc, "complex-hardstand", S.concrete, { xray: xSolid, ground: groundOf(0.75, 0.4, 0.7, 1), receive: true });
  site.add(hardstand);

  // ---------- (6) trench channel, exit, deflector ----------
  const tr = new Builder(m(6));
  {
    const floorY = (x) => (x <= xF ? topY + 0.04 + ((groundY + 0.02 - topY - 0.04) * (x - xs0)) / (xF - xs0) : groundY + 0.02);
    const surfY = (x) => (x <= xR ? topY : x >= xF ? groundY : topY - (x - xR));
    const halfW = (x) => (x <= xF ? cwT : cwT + ((x - xF) / exitLen) * m(9));
    const xsList = [xs0, xR, xF, xF + exitLen * 0.5, xE];
    for (let i = 0; i < xsList.length - 1; i++) {
      const xa = xsList[i];
      const xb = xsList[i + 1];
      quadUp(tr, v3(xa, floorY(xa), -halfW(xa)), v3(xb, floorY(xb), -halfW(xb)), v3(xb, floorY(xb), halfW(xb)), v3(xa, floorY(xa), halfW(xa)), C.trench);
      // channel walls (inside the hardstand and through the slope): from the floor up to the surface
      if (xb <= xF + 1e-6) {
        for (const s of [-1, 1]) {
          const a0 = v3(xa, floorY(xa), s * cwT);
          const b0 = v3(xb, floorY(xb), s * cwT);
          const b1 = v3(xb, surfY(xb), s * cwT);
          const a1 = v3(xa, surfY(xa), s * cwT);
          if (s < 0) tr.quad(a0, b0, b1, a1, C.trench);
          else tr.quad(b0, a0, a1, b1, C.trench);
          tr.seg(a1, b1);
        }
      }
    }
    // Flared wing walls along the exit.
    const ww = m(1.2);
    const wh = m(3.5);
    for (const s of [-1, 1]) {
      const a = v3(xF - m(1), groundY, s * (cwT + ww / 2));
      const e = v3(xE, groundY, s * (halfW(xE) + ww / 2));
      tr.strut(a.clone().setY(groundY + wh / 2), e.clone().setY(groundY + wh / 2), ww, wh, C.trench, v3(0, 1, 0));
    }
    // Exit deflector: a curved concrete kicker with steel-plated face that throws the exhaust up and out.
    const kL = m(12);
    const kH = m(5);
    const kw = halfW(xE);
    const prof = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      prof.push([xE + kL * t, groundY + 0.02 + kH * t * t]);
    }
    for (let i = 0; i < prof.length - 1; i++) {
      const [x0, y0] = prof[i];
      const [x1, y1] = prof[i + 1];
      quadUp(tr, v3(x0, y0, -kw), v3(x1, y1, -kw), v3(x1, y1, kw), v3(x0, y0, kw), C.rail);
    }
    const kTop = prof[prof.length - 1];
    tr.quad(v3(kTop[0], groundY, -kw), v3(kTop[0], groundY, kw), v3(kTop[0], kTop[1], kw), v3(kTop[0], kTop[1], -kw), C.trench);
    for (const s of [-1, 1]) {
      // side cheeks of the kicker
      const pts = prof.map(([x, y]) => v3(x, y, s * kw));
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const bb = pts[i + 1];
        const a0 = a.clone().setY(groundY);
        const b0 = bb.clone().setY(groundY);
        if (s > 0) tr.quad(a0, b0, bb, a, C.trench);
        else tr.quad(b0, a0, a, bb, C.trench);
      }
      tr.loop(pts, false);
    }
  }
  const trench = lookMesh(tr, "complex-trench", S.concrete, { xray: xSolid, ground: groundOf(0.95, 0.4, 0.5, 0.6), lines: false });
  // Lines of the trench go on the hardstand's line child (one draw).
  if (XRAY && hardstand.userData.edges && tr.nl) mergeLines(hardstand.userData.edges, tr.lineArray());
  site.add(trench);

  // ---------- (10) apron with the berm ----------
  const ap = new Builder(m(12));
  const half = m(APRON_M) / 2;
  quadUp(ap, v3(-half, groundY, -half), v3(half, groundY, -half), v3(half, groundY, half), v3(-half, groundY, half), C.apron);
  // Earth berm on the farm's pad-facing sides (an L of trapezoid sections), merged into the apron.
  const bermH = m(6);
  const bermTop = m(3);
  const bermBase = bermTop + 2 * bermH * 1.4;
  const fx0 = farm[0];
  const fz0 = farm[1];
  // two straight runs (front and right of the farm) with a gap at their corner where the pipe rack leaves
  const gapB = m(18);
  bermSection(ap, [fx0 - farmHalfX, fz0 + farmHalfZ], [fx0 + farmHalfX - gapB, fz0 + farmHalfZ], groundY, bermH, bermTop, bermBase, C.berm, true, true);
  bermSection(ap, [fx0 + farmHalfX, fz0 + farmHalfZ - gapB], [fx0 + farmHalfX, fz0 - farmHalfZ], groundY, bermH, bermTop, bermBase, C.berm, true, true);
  const apron = lookMesh(ap, "complex-apron", S.concrete, { xray: () => xGround(1), ground: groundOf(0.85, 1, 1, 1), lines: false });
  site.add(apron);

  // ---------- roads: crawlerway (gravel lanes, grass median) on the hardstand, down the ramp, out to the gate;
  // perimeter road and spurs (asphalt) ----------
  const rd = new Builder(m(3));
  const laneX = median / 2 + lane / 2;
  const zLanes0 = -(padR + m(6));
  const yRamp = (z) => (z >= -zB ? topY : z <= -zB - rampLen ? groundY : topY + ((z + zB) / rampLen) * HS);
  const lift = 0.004;
  const strip = (x0, x1, za, zb, color, y = null) => {
    const zs = [za, -zB, -zB - rampLen, zb].filter((z, i, arr) => (i === 0 || i === arr.length - 1 ? true : z < za && z > zb));
    for (let i = 0; i < zs.length - 1; i++) {
      const z0 = zs[i];
      const z1 = zs[i + 1];
      const y0 = (y ?? yRamp(z0)) + lift;
      const y1 = (y ?? yRamp(z1)) + lift;
      quadUp(rd, v3(x0, y0, z0), v3(x1, y0, z0), v3(x1, y1, z1), v3(x0, y1, z1), color);
    }
  };
  // Fence radius: everything placed + margin (computed before the roads that reach it).
  const reach = [Math.hypot(...WT) + m(30), Math.hypot(fx0, fz0) + Math.hypot(farmHalfX, farmHalfZ) + m(20), Math.hypot(hangar.x + hangar.w / 2, hangar.z - hangar.d / 2) + m(20), ...mastXY.map(([x, z]) => Math.hypot(x, z) + m(40)), Math.hypot(xE + m(40), 0)];
  const Rf = Math.min(half - m(40), Math.max(...reach) + m(25));
  const zGate = -Rf * Math.cos(Math.PI / 8) - m(6);
  for (const s of [-1, 1]) strip(s * laneX - lane / 2, s * laneX + lane / 2, zLanes0, -half + m(2), C.gravel);
  strip(-median / 2, median / 2, zLanes0, -half + m(2), C.median);
  // Perimeter road: an octagon inside the fence, split where the crawlerway crosses it.
  const Rroad = Rf - m(14);
  const roadW = m(7);
  const oct = (R, i) => {
    const a = Math.PI / 8 + (i * TAU) / 8;
    return [R * Math.cos(a), R * Math.sin(a)];
  };
  for (let i = 0; i < 8; i++) {
    const [ax, az] = oct(Rroad, i);
    const [bx, bz] = oct(Rroad, i + 1);
    const crossesCrawler = Math.abs((az + bz) / 2 - -Rroad * Math.cos(Math.PI / 8)) < 1e-6 && az < 0;
    if (crossesCrawler) {
      const [lx, rx] = ax < bx ? [ax, bx] : [bx, ax];
      roadSegment(rd, [lx, az], [-rampHalf - m(2), az], roadW, groundY + lift * 0.5, C.asphalt);
      roadSegment(rd, [rampHalf + m(2), az], [rx, az], roadW, groundY + lift * 0.5, C.asphalt);
    } else roadSegment(rd, [ax, az], [bx, bz], roadW, groundY + lift * 0.5, C.asphalt);
  }
  // Spurs: to the water tower's pump house, to the farm, to the hangar apron and to the front of the hardstand.
  const pumpHouse = [WT[0] - m(30), WT[1] + m(24)];
  const zFront = zF + towerOut + m(14); // service road in front of the hardstand, beyond the front towers
  const spurs = [
    [[Rroad * Math.cos(wAng + 0.08), Rroad * Math.sin(wAng + 0.08)], pumpHouse],
    [[fx0 + farmHalfX + m(14), fz0 - farmHalfZ - m(18)], [fx0 + farmHalfX + m(14), -Rroad * Math.cos(Math.PI / 8)]],
    [[rampHalf + m(2), hangar.z + hangar.d * 0.2], [hangar.x - hangar.w / 2 - m(4), hangar.z + hangar.d * 0.2]],
    [[0, zFront], [0, Rroad * Math.cos(Math.PI / 8)]],
  ];
  for (const [a, bb] of spurs) roadSegment(rd, a, bb, roadW * 0.85, groundY + lift * 0.4, C.asphalt);
  // A turnaround at the front of the hardstand
  roadSegment(rd, [-xL - HS - m(4), zFront], [xR + HS + m(4), zFront], roadW * 0.85, groundY + lift * 0.45, C.asphalt);
  const roads = lookMesh(rd, "complex-roads", S.gravel, { xray: () => xGround(-1), ground: groundOf(0.7, 1, 0.6, 1), lines: false });
  site.add(roads);

  // ---------- (1) FSS: lattice, floors, shaft, stairs, crane (tower group, local +x away from the rocket) ----------
  const tower = new THREE.Group();
  tower.name = "complex-tower";
  tower.position.set(Math.sin(phiT) * dT, 0, Math.cos(phiT) * dT);
  tower.rotation.y = phiT - Math.PI / 2;
  object3d.add(tower);
  const fssB = new Builder(m(2));
  const cw = Math.max(m(0.7), 0.05 * wF); // column
  const bw = 0.62 * cw; // crossbeam
  const br = 0.45 * cw; // brace
  const lvY = (k) => topY + ((tH - topY) * k) / levels;
  const grid = [-hw, 0, hw];
  for (const x of grid) for (const z of grid) fssB.aabb(x, (topY + tH) / 2, z, cw, tH - topY, cw, C.fss);
  // X-braces on the two side faces and the back face, per level and bay (front face stays open for the arms).
  for (let k = 0; k < levels; k++) {
    const y0 = lvY(k) + bw;
    const y1 = lvY(k + 1) - bw;
    for (const [za, zb] of [
      [-hw, 0],
      [0, hw],
    ]) {
      fssB.strut(v3(hw, y0, za), v3(hw, y1, zb), br, br, C.fss, v3(1, 0, 0));
      fssB.strut(v3(hw, y0, zb), v3(hw, y1, za), br, br, C.fss, v3(1, 0, 0));
    }
    for (const z of [-hw, hw]) {
      for (const [xa, xb] of [
        [-hw, 0],
        [0, hw],
      ]) {
        fssB.strut(v3(xa, y0, z), v3(xb, y1, z), br, br, C.fss, v3(0, 0, 1));
        fssB.strut(v3(xb, y0, z), v3(xa, y1, z), br, br, C.fss, v3(0, 0, 1));
      }
    }
    // front face: one K-brace per level beside the arm line
    fssB.strut(v3(-hw, y0, -hw), v3(-hw, (y0 + y1) / 2, -cw), br, br, C.fss, v3(-1, 0, 0));
    fssB.strut(v3(-hw, y1, -hw), v3(-hw, (y0 + y1) / 2, -cw), br, br, C.fss, v3(-1, 0, 0));
  }
  // Grating floors on every level (three bays; the shaft takes the fourth), slightly darker.
  const fT = m(0.35);
  for (let k = 1; k <= levels; k++) {
    const y = lvY(k) - bw / 2 - fT / 2;
    fssB.aabb(-hw / 2, y, -hw / 2, hw - cw, fT, hw - cw, C.deck, true);
    fssB.aabb(hw / 2, y, -hw / 2, hw - cw, fT, hw - cw, C.deck, true);
    fssB.aabb(-hw / 2, y, hw / 2, hw - cw, fT, hw - cw, C.deck, true);
  }
  // Elevator shaft in the back bay (+x, +z), clad, with a machine room on the roof.
  const shW = hw - cw * 1.4;
  fssB.aabb(hw / 2, (topY + tH) / 2 + m(2), hw / 2, shW, tH - topY + m(4), shW, C.shaft);
  // Stair tower: a zigzag of flights in the (−x, +z) bay.
  for (let k = 0; k < levels; k++) {
    const y0 = lvY(k);
    const y1 = lvY(k + 1);
    const ym = (y0 + y1) / 2;
    const sx0 = -hw + cw;
    const sx1 = -cw;
    const zz = hw / 2 + (k % 2 ? hw * 0.18 : -hw * 0.18);
    fssB.strut(v3(sx0, y0 + m(0.3), zz), v3(sx1, ym, zz), m(1.1), m(0.3), C.deck, v3(0, 1, 0), false);
    fssB.strut(v3(sx1, ym, zz), v3(sx0, y1 - m(0.3), zz), m(1.1), m(0.3), C.deck, v3(0, 1, 0), false);
  }
  // Propellant / pneumatic lines up the outer face to the top arm level.
  const topArmY = Math.max(lvY(2), ...arms0.map((a) => a.y));
  for (const [i, z] of [-hw * 0.55, -hw * 0.38, -hw * 0.22].entries()) fssB.cyl(v3(hw + cw, topY, z), v3(hw + cw, topArmY, z), m(0.28 - i * 0.05), m(0.28 - i * 0.05), 8, C.pipe, { caps: false });
  // Hammerhead crane: slewing deck, mast, jib over the rocket, counter-jib, counterweight, cab, hook.
  const cBase = tH;
  fssB.aabb(0, cBase + m(0.5), 0, wF * 0.7, m(1), wF * 0.7, C.deck);
  const mastH = m(10);
  fssB.aabb(0, cBase + m(1) + mastH / 2, 0, m(3), mastH, m(3), C.crane);
  const jibY = cBase + m(1) + mastH;
  const jibL = dT + m(6);
  const jibB = m(1.6);
  for (const z of [-jibB / 2, jibB / 2]) fssB.strut(v3(m(1.5), jibY + jibB, z), v3(-jibL, jibY + jibB * 0.7, z), m(0.35), m(0.35), C.crane);
  fssB.strut(v3(m(1.5), jibY, 0), v3(-jibL, jibY + jibB * 0.15, 0), m(0.4), m(0.4), C.crane);
  for (let i = 0; i < 10; i++) {
    const xa = m(1.5) - ((jibL + m(1.5)) * i) / 10;
    const xb = m(1.5) - ((jibL + m(1.5)) * (i + 1)) / 10;
    for (const z of [-jibB / 2, jibB / 2]) fssB.strut(v3(xa, jibY + jibB * (1 - 0.3 * (i / 10)), z), v3(xb, jibY + jibB * 0.08, z * 0.2), m(0.18), m(0.18), C.crane, null, false);
  }
  const cjL = 0.38 * jibL;
  fssB.aabb(cjL / 2, jibY + jibB / 2, 0, cjL, jibB * 0.8, jibB, C.crane);
  fssB.aabb(cjL - m(2.5), jibY - m(1), 0, m(5), m(4), jibB * 1.6, C.counterweight);
  fssB.aabb(m(2.6), jibY - m(1.2), m(1.4), m(2.2), m(2.2), m(2), C.crane);
  const hookX = -jibL * 0.82;
  fssB.strut(v3(hookX, jibY, 0), v3(hookX, jibY - m(14), 0), m(0.08), m(0.08), C.deck, v3(1, 0, 0), false);
  fssB.aabb(hookX, jibY - m(14.8), 0, m(1), m(1.6), m(0.8), C.counterweight);
  // Antenna mast on the crane mast (beacon on top).
  const antTop = jibY + jibB + m(14);
  fssB.cyl(v3(0, jibY + jibB, 0), v3(0, antTop, 0), m(0.35), m(0.15), 6, C.mastTop, { caps: false });
  // FSS lamps (floodlights aimed at the vehicle) on every third level, front face.
  const fssLamps = [];
  for (let k = 2; k < levels; k += 3) for (const z of [-hw * 0.7, hw * 0.7]) fssLamps.push(v3(-hw - cw, lvY(k) + m(1.2), z));
  // RSS hinge column base and the cable tray from the FSS front face to the pad: drawn in the site mesh.

  // Crossbeams: one InstancedMesh (12 per level: two bays on three lines, both directions); their edges join the
  // lattice's line child.
  const beamGeo = new THREE.BoxGeometry(1, 1, 1);
  {
    const n = beamGeo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) C.fss.toArray(c, i * 3);
    beamGeo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  }
  const beamMats = [];
  for (let k = 0; k <= levels; k++) {
    const y = k === 0 ? topY + bw / 2 : lvY(k) - bw / 2;
    for (const line of grid) {
      for (const [a, bb] of [
        [-hw, 0],
        [0, hw],
      ]) {
        beamMats.push(new THREE.Matrix4().compose(v3((a + bb) / 2, y, line), new THREE.Quaternion(), v3(hw - cw, bw, bw)));
        beamMats.push(new THREE.Matrix4().compose(v3(line, y, (a + bb) / 2), new THREE.Quaternion(), v3(bw, bw, hw - cw)));
      }
    }
  }
  const beams = noPick(new THREE.InstancedMesh(beamGeo, propMaterial(S.steel), beamMats.length));
  beams.name = "complex-fss-beams";
  beamMats.forEach((mt, i) => beams.setMatrixAt(i, mt));
  beams.instanceMatrix.needsUpdate = true;
  beams.computeBoundingSphere();
  beams.castShadow = beams.receiveShadow = true;
  if (XRAY) beams.userData.looks = { xray: xSteel(), painted: beams.material };
  // the beams' box edges, for the lattice line child
  const unitEdges = [
    [-1, -1, -1, 1, -1, -1],
    [1, -1, -1, 1, -1, 1],
    [1, -1, 1, -1, -1, 1],
    [-1, -1, 1, -1, -1, -1],
    [-1, 1, -1, 1, 1, -1],
    [1, 1, -1, 1, 1, 1],
    [1, 1, 1, -1, 1, 1],
    [-1, 1, 1, -1, 1, -1],
    [-1, -1, -1, -1, 1, -1],
    [1, -1, -1, 1, 1, -1],
    [1, -1, 1, 1, 1, 1],
    [-1, -1, 1, -1, 1, 1],
  ];
  const tmpA = v3();
  const tmpB = v3();
  for (const mt of beamMats) {
    for (const e of unitEdges) {
      tmpA.set(e[0] / 2, e[1] / 2, e[2] / 2).applyMatrix4(mt);
      tmpB.set(e[3] / 2, e[4] / 2, e[5] / 2).applyMatrix4(mt);
      fssB.seg(tmpA, tmpB);
    }
  }
  const towerFrame = lookMesh(fssB, "complex-fss", S.steel, { lineK: LATTICE_K, cast: true, receive: true });
  tower.add(towerFrame, beams);

  // ---------- umbilical arms (one mesh each, origin on the hinge at the tower face) ----------
  const armH = Math.max(m(2.6), 0.024 * tH);
  const armW = m(3.2);
  const arms = arms0.map((a) => {
    const reach = Math.max(0.05, dT - hw - a.r - 0.03);
    const B = new Builder(m(2));
    const ch = Math.max(m(0.3), 0.12 * armH);
    B.aabb(-cw * 0.8, 0, 0, cw * 1.6, armH * 1.3, armW * 1.25, C.deck);
    for (const yy of [armH / 2 - ch / 2, -armH / 2 + ch / 2]) for (const zz of [armW / 2 - ch / 2, -armW / 2 + ch / 2]) B.aabb(-reach / 2, yy, zz, reach, ch, ch, C.fss);
    const nSeg = Math.max(2, Math.ceil(reach / armH));
    for (let i = 0; i < nSeg; i++) {
      const xa = (-reach * i) / nSeg;
      const xb = (-reach * (i + 1)) / nSeg;
      const up = i % 2 ? 1 : -1;
      for (const zz of [armW / 2 - ch / 2, -armW / 2 + ch / 2]) {
        B.strut(v3(xa, (up * (armH - ch)) / 2, zz), v3(xb, (-up * (armH - ch)) / 2, zz), ch * 0.7, ch * 0.7, C.fss, v3(0, 0, Math.sign(zz)));
        B.aabb(xb, 0, zz, ch * 0.7, armH - ch, ch * 0.7, C.fss, false);
      }
    }
    B.aabb(-reach / 2, -armH / 2 + ch + m(0.12), 0, reach, m(0.2), armW - 2 * ch, C.deck, false);
    for (const zz of [-armW * 0.18, armW * 0.18]) B.cyl(v3(-m(0.8), -armH * 0.18, zz), v3(-reach + m(1.4), -armH * 0.18, zz), m(0.16), m(0.16), 6, C.pipe, { caps: false });
    B.aabb(-reach + m(0.7), 0, 0, m(1.4), armH * 1.15, armW * 1.12, C.hood);
    const mesh = lookMesh(B, `complex-arm:${a.id}`, S.steel, { lineK: LATTICE_K, cast: true, receive: true });
    mesh.position.set(-hw, a.y, 0);
    tower.add(mesh);
    return { mesh, y_u: a.y, reach_u: reach, partId: a.id };
  });

  // ---------- (2) RSS (Group on the hinge; its mesh in RSS-local: +x along the arm of the structure) ----------
  const rssGroup = new THREE.Group();
  rssGroup.name = "complex-rss";
  rssGroup.position.set(hinge.x, 0, hinge.z);
  tower.add(rssGroup);
  {
    const B = new Builder(m(1.2));
    const LR = rss.LR;
    const zi = rss.inner * hwR; // vehicle side
    const zo = -zi; // outer side
    const nLev = Math.max(3, Math.round((yR1 - yR0) / m(7)));
    const rc = m(0.8); // RSS member size
    // corner columns of the body and the hinge column (full height)
    for (const s of [0, LR]) for (const z of [-hwR, hwR]) B.aabb(s, (yR0 + yR1) / 2, z, rc, yR1 - yR0, rc, C.rssFrame);
    B.cyl(v3(0, topY, 0), v3(0, yR1 + m(3), 0), m(1.6), m(1.6), 12, C.rssFrame, { lines: true });
    for (let k = 0; k <= nLev; k++) {
      const y = yR0 + ((yR1 - yR0) * k) / nLev;
      for (const z of [-hwR, hwR]) B.aabb(LR / 2, y, z, LR, rc * 0.8, rc * 0.8, C.rssFrame);
      for (const s of [0, LR]) B.aabb(s, y, 0, rc * 0.8, rc * 0.8, wR, C.rssFrame);
      if (k > 0 && k < nLev) B.aabb(LR / 2, y - m(0.3), 0, LR - rc, m(0.3), wR - rc, C.deck, false); // platforms
    }
    // cladding: outer face, both ends and the roof (white panels); the vehicle side stays open (the PCR door)
    const cladIn = m(0.25);
    B.aabb(LR / 2, (yR0 + yR1) / 2, zo - Math.sign(zo) * cladIn, LR - rc, yR1 - yR0 - rc, m(0.25), C.rssClad);
    for (const s of [cladIn, LR - cladIn]) B.aabb(s, (yR0 + yR1) / 2, 0, m(0.25), yR1 - yR0 - rc, wR - rc, C.rssClad);
    B.aabb(LR / 2, yR1 + m(0.35), 0, LR + rc, m(0.7), wR + rc, C.rssClad);
    // door frame on the vehicle side (the payload changeout room opening)
    B.aabb(rss.s0, (yR0 + yR1) / 2, zi, m(0.6), yR1 - yR0, m(0.6), C.rssFrame);
    // knee braces from the hinge column to the body's underside
    for (const z of [-hwR * 0.6, hwR * 0.6]) B.strut(v3(m(1.2), topY + (yR0 - topY) * 0.35, z * 0.3), v3(Math.min(LR * 0.55, m(14)), yR0, z), rc, rc, C.rssFrame);
    // outer support column (wheel truck on the hardstand) under the far part of the body
    const cs = rss.colS;
    const cz = rss.colZ;
    B.aabb(cs, (topY + yR0) / 2, cz, m(1.4), yR0 - topY, m(1.4), C.rssFrame);
    B.strut(v3(cs, topY + (yR0 - topY) * 0.45, cz), v3(Math.max(0, cs - m(10)), yR0, cz), rc, rc, C.rssFrame);
    B.aabb(cs, topY + m(1.1), cz, m(5), m(1.6), m(2.6), C.counterweight);
    for (const ds of [-m(1.6), m(1.6)]) B.cyl(v3(cs + ds, topY + m(0.55), cz - m(1.4)), v3(cs + ds, topY + m(0.55), cz + m(1.4)), m(0.55), m(0.55), 10, C.rail, { lines: false });
    const rssMesh = lookMesh(B, "complex-rss", S.clad, { lineK: LATTICE_K, cast: true, receive: true });
    rssGroup.add(rssMesh);
  }
  let rssAngle = 0;
  const setRssAngle = (deg = 0) => {
    rssAngle = clamp(Number(deg) || 0, 0, RSS_MAX_DEG);
    rssGroup.rotation.y = rss.thP - rssAngle * DEG;
    rssGroup.userData.angle_deg = rssAngle;
    return rssAngle;
  };
  setRssAngle(0);

  // ---------- (3) water tower + down pipe to the pad (site frame) ----------
  const wB = new Builder(m(2));
  const wTop = WATER_TOP_SHARE * tH;
  const tankR = m(8.5);
  const tankH = m(11);
  const roofH = m(2.8);
  const bowl = m(4.5);
  const tankY0 = wTop - roofH - tankH; // cylinder bottom
  const legR0 = m(11);
  const legR1 = tankR * 0.92;
  const nLeg = 6;
  const wc = v3(WT[0], 0, WT[1]);
  const legAt = (i, y) => {
    const t = (y - groundY) / (tankY0 - bowl * 0.4 - groundY);
    const r = legR0 + (legR1 - legR0) * clamp(t, 0, 1);
    const a = (i / nLeg) * TAU + Math.PI / nLeg;
    return v3(wc.x + Math.cos(a) * r, y, wc.z + Math.sin(a) * r);
  };
  const legTop = tankY0 - bowl * 0.4;
  for (let i = 0; i < nLeg; i++) wB.strut(legAt(i, groundY), legAt(i, legTop), m(1.1), m(1.1), C.waterLeg);
  const wLev = 5;
  for (let k = 1; k <= wLev; k++) {
    const y = groundY + ((legTop - groundY) * k) / (wLev + 1);
    const yPrev = groundY + ((legTop - groundY) * (k - 1)) / (wLev + 1) + m(0.6);
    for (let i = 0; i < nLeg; i++) {
      wB.strut(legAt(i, y), legAt((i + 1) % nLeg, y), m(0.5), m(0.5), C.waterLeg, v3(0, 1, 0));
      wB.strut(legAt(i, yPrev), legAt((i + 1) % nLeg, y), m(0.3), m(0.3), C.waterLeg, null, false);
    }
  }
  wB.cyl(v3(wc.x, groundY, wc.z), v3(wc.x, tankY0 - bowl * 0.8, wc.z), m(1.3), m(1.3), 12, C.waterPipe, { caps: false, lines: true });
  wB.lathe(
    v3(wc.x, tankY0, wc.z),
    [
      [0.001, -bowl],
      [tankR * 0.5, -bowl * 0.86],
      [tankR * 0.8, -bowl * 0.58],
      [tankR * 0.95, -bowl * 0.26],
      [tankR, 0],
      [tankR, tankH],
      [tankR * 1.02, tankH + m(0.15)],
      [tankR * 0.55, tankH + roofH * 0.7],
      [0.001, tankH + roofH],
    ],
    28,
    C.waterTank,
  );
  // balcony ring under the roof and a ladder line
  wB.lathe(v3(wc.x, tankY0 + tankH * 0.08, wc.z), [[tankR + m(0.1), 0], [tankR + m(1.2), 0], [tankR + m(1.2), m(0.3)], [tankR + m(0.1), m(0.3)]], 28, C.waterLeg, true);
  wB.strut(legAt(0, groundY + m(1)), legAt(0, legTop).clone().lerp(wc.clone().setY(legTop), -0.06), m(0.6), m(0.15), C.waterLeg, null, false);
  // Down pipe: along the apron toward the pad, up the hardstand slope, across the top, into the plinth wall.
  const pipeR = m(1.0);
  const dirToPad = v3(-WT[0], 0, -WT[1]).normalize();
  const start = v3(wc.x, groundY + pipeR + m(0.6), wc.z).addScaledVector(dirToPad, legR0 * 0.2);
  const footPoly = offsetPoly(outline, HS + m(1));
  let foot = start.clone();
  for (let s = 0; s < 4000; s++) {
    foot.addScaledVector(dirToPad, m(1));
    if (pointInPoly(foot.x, foot.z, footPoly)) break;
  }
  const topEdge = foot.clone().addScaledVector(dirToPad, HS + m(1)).setY(topY + pipeR + m(0.4));
  const enterR = padR + m(0.2);
  const end = dirToPad.clone().multiplyScalar(-enterR).setY(topY + pipeR + m(0.4));
  const pipePts = [start, foot, topEdge, end];
  for (let i = 0; i < pipePts.length - 1; i++) wB.cyl(pipePts[i], pipePts[i + 1], pipeR, pipeR, 12, C.waterPipe, { caps: false, lines: true });
  for (const p of pipePts.slice(1, -1)) wB.sphere(p, pipeR * 1.18, C.waterPipe, 12, 8);
  // pipe saddles every ~12 m on the apron run
  const runLen = start.distanceTo(foot);
  for (let d = m(6); d < runLen - m(3); d += m(12)) {
    const p = start.clone().addScaledVector(dirToPad, d);
    wB.aabb(p.x, (groundY + p.y - pipeR) / 2, p.z, m(1.2), p.y - pipeR - groundY, m(1.2), C.saddle, false);
  }
  const waterTower = lookMesh(wB, "complex-water-tower", S.steel, { cast: true, receive: true });
  site.add(waterTower);

  // ---------- (4) lightning towers + catenary wires ----------
  const mB = new Builder(m(2));
  const mastBase = m(3.2);
  const mastTopW = m(1.0);
  const finial = m(12);
  const latticeTop = mastTop - finial;
  const mastLevels = clamp(Math.round((latticeTop - groundY) / m(7)), 8, 40);
  const mastTops = [];
  const banks = [];
  for (const [mx, mz] of mastXY) {
    const legP = (i, y) => {
      const t = (y - groundY) / (latticeTop - groundY);
      const r = mastBase + (mastTopW - mastBase) * t;
      const sx = i === 0 || i === 3 ? -1 : 1;
      const sz = i < 2 ? -1 : 1;
      return v3(mx + sx * r, y, mz + sz * r);
    };
    const mm = m(0.45);
    for (let i = 0; i < 4; i++) mB.strut(legP(i, groundY), legP(i, latticeTop), mm, mm, C.mast);
    for (let k = 0; k <= mastLevels; k++) {
      const y = groundY + ((latticeTop - groundY) * k) / mastLevels;
      const yn = groundY + ((latticeTop - groundY) * (k + 1)) / mastLevels;
      for (let i = 0; i < 4; i++) {
        mB.strut(legP(i, Math.max(y, groundY + mm)), legP((i + 1) % 4, Math.max(y, groundY + mm)), mm * 0.7, mm * 0.7, C.mast, v3(0, 1, 0));
        if (k < mastLevels) mB.strut(legP(i, y + mm), legP((i + 1) % 4, yn - mm), mm * 0.5, mm * 0.5, C.mast, null, k % 3 === 0);
      }
    }
    mB.aabb(mx, latticeTop + m(0.3), mz, mastTopW * 2.6, m(0.6), mastTopW * 2.6, C.deck);
    mB.cyl(v3(mx, latticeTop, mz), v3(mx, mastTop, mz), m(0.6), m(0.25), 8, C.mastTop, { caps: true });
    mastTops.push(v3(mx, mastTop, mz));
    // floodlight bank: a platform on the pad-facing side at ~45 % height
    const yb = groundY + 0.45 * (latticeTop - groundY);
    const toPad = v3(-mx, 0, -mz).normalize();
    const side = new THREE.Vector3().crossVectors(toPad, v3(0, 1, 0)).normalize();
    const rb = mastBase + (mastTopW - mastBase) * 0.45 + m(1.4);
    const bc = v3(mx, yb, mz).addScaledVector(toPad, rb);
    mB.box(bc, toPad.clone().multiplyScalar(m(1.4)), v3(0, m(0.25), 0), side.clone().multiplyScalar(m(5)), C.deck);
    mB.box(bc.clone().addScaledVector(toPad, m(1.3)).setY(yb + m(1.4)), toPad.clone().multiplyScalar(m(0.12)), v3(0, m(1.4), 0), side.clone().multiplyScalar(m(5)), C.mast, false);
    banks.push({ c: bc.clone().setY(yb + m(1.6)), toPad, side, mast: [mx, mz] });
  }
  const masts = lookMesh(mB, "complex-lightning-towers", S.steel, { lineK: LATTICE_K, cast: false, receive: true });
  site.add(masts);
  // Wires: the four sides between the tops and one to a ground anchor outward from each tower.
  const wireSegs = [];
  for (let i = 0; i < 4; i++) {
    const a = mastTops[i];
    const bb = mastTops[(i + 1) % 4];
    wireSegs.push(...catenary(a, bb, 0.07 * a.distanceTo(bb)));
    const out = v3(a.x, 0, a.z).normalize();
    const anchor = v3(a.x, groundY + m(1), a.z).addScaledVector(out, m(70));
    wireSegs.push(...catenary(a, anchor, 0.03 * a.distanceTo(anchor), 16));
  }
  const wireGeo = new THREE.BufferGeometry().setFromPoints(wireSegs);
  const wires = noPick(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x9aa1a8, transparent: true, opacity: 0.55, fog: true })));
  wires.name = "complex-wires";
  site.add(wires);
  if (XRAY) {
    wires.userData.lookOnly = "painted";
    const wx = noPick(new THREE.LineSegments(wireGeo, peachLineMaterial(0.3)));
    wx.name = "complex-wires-xray";
    wx.userData.lookOnly = "xray";
    wx.visible = false;
    site.add(wx);
  }

  // ---------- (7) propellant farm, pipe rack, site steel (rails, cable tray) ----------
  const fB = new Builder(m(2));
  const sphR = m(9);
  for (const dx of [-m(18), m(18)]) {
    const c = v3(fx0 + dx, groundY + m(3.5) + sphR, fz0 - m(14));
    fB.sphere(c, sphR, C.tankWhite, 28, 16);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const top = c.clone().add(v3(Math.cos(a) * sphR * 0.98, 0, Math.sin(a) * sphR * 0.98));
      fB.strut(v3(top.x, groundY, top.z), top, m(0.7), m(0.7), C.saddle);
    }
    fB.lathe(c, [[sphR * 1.005, -m(0.25)], [sphR * 1.005, m(0.25)]], 28, C.saddle, true); // equator band
    fB.cyl(v3(c.x, groundY, c.z), v3(c.x, c.y - sphR, c.z), m(0.7), m(0.7), 8, C.pipe, { caps: false });
  }
  const tankL = m(30);
  const tankRr = m(3.4);
  for (const dz of [-m(4.5), m(4.5)]) {
    const z = fz0 + m(7) + dz;
    const y = groundY + m(1.6) + tankRr;
    fB.cyl(v3(fx0 - tankL / 2, y, z), v3(fx0 + tankL / 2, y, z), tankRr, tankRr, 24, C.tankWhite, { caps: false, lines: true });
    for (const s of [-1, 1]) fB.sphere(v3(fx0 + (s * tankL) / 2, y, z), tankRr, C.tankWhite, 20, 10);
    for (const s of [-0.32, 0.32]) fB.aabb(fx0 + s * tankL, groundY + m(1.2), z, m(1.6), m(2.4), tankRr * 1.7, C.saddle);
  }
  // pump skids and valve boxes
  fB.aabb(fx0 + m(30), groundY + m(1.2), fz0 + m(2), m(8), m(2.4), m(5), C.rack);
  fB.aabb(fx0 - m(30), groundY + m(1.2), fz0 + m(4), m(6), m(2.4), m(4), C.rack);
  // Pipe rack: from the farm toward the hardstand's left edge, up its slope, across to the FSS outer face.
  const rackH = m(3.6);
  const rp0 = v3(fx0 + farmHalfX - m(9), groundY, fz0 + farmHalfZ - m(9));
  const rpFoot = v3(-xL - HS - m(2), groundY, 0);
  const rpTop = v3(-xL + m(1), topY, 0);
  const [fssOutX] = towerToSite(hw + cw, 0);
  const rpEnd = v3(fssOutX - m(1.5), topY, 0);
  const rackPts = [rp0, rpFoot, rpTop, rpEnd];
  const bents = [];
  for (let i = 0; i < rackPts.length - 1; i++) {
    const a = rackPts[i];
    const bb = rackPts[i + 1];
    const len = Math.hypot(bb.x - a.x, bb.z - a.z);
    const dir = v3(bb.x - a.x, 0, bb.z - a.z).normalize();
    const steps = Math.max(1, Math.round(len / m(8)));
    for (let s = 0; s <= steps; s++) {
      if (i > 0 && s === 0) continue;
      const p = a.clone().lerp(bb, s / steps);
      bents.push({ p, yaw: Math.atan2(dir.x, dir.z) });
    }
  }
  const pipeOff = [-m(0.9), 0, m(0.9)];
  const pipeRad = [m(0.42), m(0.32), m(0.26)];
  for (let i = 0; i < rackPts.length - 1; i++) {
    const a = rackPts[i];
    const bb = rackPts[i + 1];
    const dir = v3(bb.x - a.x, 0, bb.z - a.z).normalize();
    const side = new THREE.Vector3().crossVectors(v3(0, 1, 0), dir);
    pipeOff.forEach((o, j) => {
      fB.cyl(a.clone().addScaledVector(side, o).setY(a.y + rackH + pipeRad[j]), bb.clone().addScaledVector(side, o).setY(bb.y + rackH + pipeRad[j]), pipeRad[j], pipeRad[j], 8, C.pipe, { caps: false });
    });
  }
  // down the FSS outer face: the lines turn up into the tower's vertical runs
  fB.cyl(v3(rpEnd.x, topY + rackH, rpEnd.z), v3(fssOutX - m(0.4), topY + rackH, rpEnd.z), m(0.42), m(0.42), 8, C.pipe, { caps: false });
  // Continue the pad's transporter rails down the ramp and along the crawlerway median.
  const railY = (z) => yRamp(z) + m(0.15);
  for (const s of [-1, 1]) {
    const x = (s * gauge) / 2;
    const zs = [-rr2, -zB, -zB - rampLen, hangar.z];
    for (let i = 0; i < zs.length - 1; i++) fB.strut(v3(x, railY(zs[i]), zs[i]), v3(x, railY(zs[i + 1]), zs[i + 1]), m(0.3), m(0.3), C.rail, v3(1, 0, 0), false);
  }
  // Cable tray: FSS front face → pad plinth wall → up → across the deck to the launch mount.
  const [fssFrontX] = towerToSite(-hw - cw, 0);
  const trayW = m(1.6);
  const trayZ = m(1.2);
  fB.aabb((fssFrontX + -padR) / 2, topY + m(0.25), trayZ, Math.abs(-padR - fssFrontX), m(0.5), trayW, C.tray);
  fB.aabb(-padR - m(0.3), (topY + 0) / 2, trayZ, m(0.6), P, trayW, C.tray);
  fB.aabb((-padR + -mountR * 1.05) / 2, m(0.08), trayZ, Math.abs(padR - mountR * 1.05), m(0.16), trayW, C.tray);
  const farmMesh = lookMesh(fB, "complex-farm", S.steel, { cast: false, receive: true });
  site.add(farmMesh);
  // rack bents (instanced): two posts + a crossbar, standing on the local ground at each station
  const bentGeo = (() => {
    const B = new Builder(m(2));
    B.aabb(-m(1.6), rackH / 2, 0, m(0.35), rackH, m(0.35), C.rack, false);
    B.aabb(m(1.6), rackH / 2, 0, m(0.35), rackH, m(0.35), C.rack, false);
    B.aabb(0, rackH - m(0.15), 0, m(3.8), m(0.3), m(0.35), C.rack, false);
    return B.geometry();
  })();
  const racks = noPick(new THREE.InstancedMesh(bentGeo, propMaterial(S.steel), bents.length));
  racks.name = "complex-rack-bents";
  bents.forEach(({ p, yaw }, i) => racks.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), yaw), v3(1, 1, 1))));
  racks.instanceMatrix.needsUpdate = true;
  racks.computeBoundingSphere();
  racks.receiveShadow = true;
  if (XRAY) racks.userData.looks = { xray: xSteel(), painted: racks.material };
  site.add(racks);

  // ---------- (9) buildings (boxes with roof lines), lit windows ----------
  const bB = new Builder(m(1.2));
  const win = new Builder(m(4));
  const winLit = (x, y, z, w, h, nx, nz) => {
    // a lit pane just proud of a wall facing (nx, nz)
    const n = v3(nx, 0, nz);
    const t = new THREE.Vector3().crossVectors(v3(0, 1, 0), n).normalize();
    const c = v3(x, y, z).addScaledVector(n, m(0.06));
    const a = c.clone().addScaledVector(t, -w / 2).setY(y - h / 2);
    const bb = c.clone().addScaledVector(t, w / 2).setY(y - h / 2);
    win.quad(a, bb, bb.clone().setY(y + h / 2), a.clone().setY(y + h / 2), C.hood);
  };
  const building = (x, z, w, d, h, wall, { gable = false, band = false, windows = 0, face = [0, 1], door = true } = {}) => {
    bB.aabb(x, groundY + h / 2, z, w, h, d, wall);
    if (band) bB.aabb(x, groundY + m(1.5), z, w + m(0.1), m(3), d + m(0.1), C.band, false);
    if (gable) {
      const rh = Math.min(w, d) * 0.12;
      const ov = m(0.6);
      const y0 = groundY + h;
      const along = d > w;
      const hx = w / 2 + ov;
      const hz = d / 2 + ov;
      if (along) {
        const ra = v3(x - hx, y0, z - hz);
        const rb = v3(x - hx, y0, z + hz);
        const rr = v3(x, y0 + rh, z + hz);
        const rl = v3(x, y0 + rh, z - hz);
        bB.quad(ra, rb, rr, rl, C.roof, true);
        bB.quad(v3(x + hx, y0, z + hz), v3(x + hx, y0, z - hz), rl, rr, C.roof, true);
        bB.tri(v3(x - w / 2, y0, z + d / 2), v3(x + w / 2, y0, z + d / 2), v3(x, y0 + rh, z + d / 2), wall);
        bB.tri(v3(x + w / 2, y0, z - d / 2), v3(x - w / 2, y0, z - d / 2), v3(x, y0 + rh, z - d / 2), wall);
      } else {
        const ra = v3(x - hx, y0, z + hz);
        const rb = v3(x + hx, y0, z + hz);
        const rr = v3(x + hx, y0 + rh, z);
        const rl = v3(x - hx, y0 + rh, z);
        bB.quad(ra, rb, rr, rl, C.roof, true);
        bB.quad(v3(x + hx, y0, z - hz), v3(x - hx, y0, z - hz), rl, rr, C.roof, true);
        bB.tri(v3(x + w / 2, y0, z + d / 2), v3(x + w / 2, y0, z - d / 2), v3(x + w / 2, y0 + rh, z), wall);
        bB.tri(v3(x - w / 2, y0, z - d / 2), v3(x - w / 2, y0, z + d / 2), v3(x - w / 2, y0 + rh, z), wall);
      }
    } else {
      // flat roof with a parapet and two rooftop units
      bB.aabb(x, groundY + h + m(0.4), z, w + m(0.3), m(0.8), d + m(0.3), C.roof);
      bB.aabb(x - w * 0.2, groundY + h + m(1.4), z, Math.min(m(4), w * 0.3), m(1.6), Math.min(m(3), d * 0.3), C.rack);
      bB.aabb(x + w * 0.22, groundY + h + m(1.1), z + d * 0.1, Math.min(m(3), w * 0.2), m(1.2), Math.min(m(3), d * 0.25), C.rack);
    }
    const [fx, fz] = face;
    const fw = fx ? d : w;
    const cx = x + (fx * w) / 2;
    const cz = z + (fz * d) / 2;
    if (door) {
      const off = -fw * 0.3;
      if (fx) bB.aabb(cx + fx * m(0.06), groundY + m(1.6), z + off, m(0.12), m(3.2), m(2.8), C.door, false);
      else bB.aabb(x + off, groundY + m(1.6), cz + fz * m(0.06), m(2.8), m(3.2), m(0.12), C.door, false);
    }
    for (let i = 0; i < windows; i++) {
      const t = (i + 0.5) / windows - 0.5;
      const wx = fx ? cx : x + t * w * 0.8;
      const wz = fx ? z + t * d * 0.8 : cz;
      if (hash2(i, Math.round(x * 10), 77) < 0.72) winLit(wx, groundY + Math.min(h * 0.62, m(4)), wz, Math.min(m(2.4), fw / (windows * 1.6)), m(1.3), fx, fz);
    }
  };
  // Integration hangar at the foot of the ramp (right of the crawlerway), big doors facing it.
  building(hangar.x, hangar.z, hangar.w, hangar.d, hangar.h, C.wallHangar, { gable: true, band: true, windows: 6, face: [-1, 0] });
  bB.aabb(hangar.x - hangar.w / 2 - m(0.1), groundY + hangar.h * 0.42, hangar.z + hangar.d * 0.1, m(0.2), hangar.h * 0.84, hangar.d * 0.5, C.door, true); // hangar door
  // Pad terminal connection room: low and long, beside the hardstand's left foot.
  const ptcr = [-xL - HS - m(24), zF + m(4)];
  building(ptcr[0], ptcr[1], m(16), m(34), m(6), C.wall, { windows: 4, face: [1, 0] });
  // Pump house by the water tower, guard house at the gate, generator shed by the terminal room, farm shelters.
  building(pumpHouse[0], pumpHouse[1], m(22), m(12), m(7), C.wall, { windows: 3, face: [0, 1] });
  building(-rampHalf - m(10), zGate + m(8), m(6), m(5), m(3.6), C.wall, { windows: 2, face: [1, 0] });
  building(ptcr[0] - m(2), ptcr[1] + m(30), m(12), m(9), m(5), C.wall, { windows: 1, face: [1, 0] });
  building(fx0 + farmHalfX * 0.3, fz0 - farmHalfZ * 0.72, m(10), m(7), m(4.5), C.wall, { windows: 1, face: [0, -1] });
  const buildings = lookMesh(bB, "complex-buildings", S.clad, { cast: true, receive: true });
  site.add(buildings);
  const windows = noPick(new THREE.Mesh(win.geometry(), S.window.clone()));
  windows.name = "complex-windows";
  windows.material.vertexColors = false;
  windows.material.color.setRGB(1.0, 0.8, 0.55).multiplyScalar(0.9 * (night ? 1 : 0.3));
  site.add(windows);

  // ---------- fence (instanced posts + wires) ----------
  const fencePosts = [];
  const fenceSegs = [];
  const postH = m(2.6);
  const gateHalf = rampHalf + m(8);
  for (let i = 0; i < 8; i++) {
    const [ax, az] = oct(Rf, i);
    const [bx, bz] = oct(Rf, i + 1);
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.round(len / m(6)));
    const pts = [];
    for (let s = 0; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n;
      const z = az + ((bz - az) * s) / n;
      const inGate = Math.abs(x) < gateHalf && z < 0 && Math.abs(z + Rf * Math.cos(Math.PI / 8)) < m(1);
      pts.push(inGate ? null : v3(x, groundY, z));
      if (!inGate && s < n) fencePosts.push(v3(x, groundY, z));
    }
    for (let s = 0; s < pts.length - 1; s++) {
      if (!pts[s] || !pts[s + 1]) continue;
      for (const h of [0.3, 0.6, 0.95]) fenceSegs.push(pts[s].clone().setY(groundY + postH * h), pts[s + 1].clone().setY(groundY + postH * h));
    }
  }
  const postGeo = (() => {
    const B = new Builder(m(1));
    B.aabb(0, postH / 2, 0, m(0.14), postH, m(0.14), C.post, false);
    B.strut(v3(0, postH, 0), v3(0, postH + m(0.45), m(0.35)), m(0.06), m(0.06), C.post, null, false);
    return B.geometry();
  })();
  const posts = noPick(new THREE.InstancedMesh(postGeo, propMaterial(S.steel), fencePosts.length));
  posts.name = "complex-fence-posts";
  fencePosts.forEach((p, i) => {
    const out = Math.atan2(p.x, p.z);
    posts.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), out), v3(1, 1, 1)));
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.computeBoundingSphere();
  if (XRAY) posts.userData.looks = { xray: xSteel(), painted: posts.material };
  site.add(posts);
  const fenceWires = noPick(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fenceSegs), new THREE.LineBasicMaterial({ color: 0x8a9096, transparent: true, opacity: 0.45, fog: true })));
  fenceWires.name = "complex-fence-wires";
  site.add(fenceWires);

  // ---------- light poles (instanced) ----------
  const polePts = [];
  for (let z = -zB - m(10); z > -zB - rampLen - m(60); z -= m(45)) for (const s of [-1, 1]) polePts.push(v3(s * (rampHalf + m(4)), yRamp(z), z));
  polePts.push(v3(pumpHouse[0] + m(14), groundY, pumpHouse[1]), v3(fx0 + farmHalfX + m(6), groundY, fz0 + farmHalfZ + m(6)), v3(ptcr[0] + m(12), groundY, ptcr[1] + m(20)), v3(hangar.x - hangar.w / 2 - m(8), groundY, hangar.z - hangar.d * 0.3));
  const poleH = m(13);
  const poleGeo = (() => {
    const B = new Builder(m(1));
    B.aabb(0, poleH / 2, 0, m(0.35), poleH, m(0.35), C.post, false);
    B.aabb(m(1.2), poleH, 0, m(2.6), m(0.25), m(0.25), C.post, false);
    B.aabb(m(2.3), poleH - m(0.3), 0, m(1.1), m(0.4), m(0.6), C.band, false);
    return B.geometry();
  })();
  const poles = noPick(new THREE.InstancedMesh(poleGeo, propMaterial(S.steel), polePts.length));
  poles.name = "complex-light-poles";
  const poleLamps = [];
  polePts.forEach((p, i) => {
    const onRamp = Math.abs(Math.abs(p.x) - (rampHalf + m(4))) < 1e-6;
    const tx = onRamp ? 0 : -p.x;
    const tz = onRamp ? 0 : -p.z;
    const yaw = Math.atan2(-tz, tx); // the arm (local +x) toward the crawlerway or the pad
    const q = new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), yaw);
    poles.setMatrixAt(i, new THREE.Matrix4().compose(p, q, v3(1, 1, 1)));
    poleLamps.push(p.clone().add(v3(m(2.3), poleH - m(0.6), 0).applyQuaternion(q)));
  });
  poles.instanceMatrix.needsUpdate = true;
  poles.computeBoundingSphere();
  if (XRAY) poles.userData.looks = { xray: xSteel(), painted: poles.material };
  site.add(poles);

  // ---------- (8) floodlights: lamp heads (instanced), glows (Points), beams, beacons, spot lights ----------
  const lampPos = [];
  const lampQuat = [];
  const aimY = 0.32 * H;
  const target = v3(0, aimY, 0);
  for (const bk of banks) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const p = bk.c.clone().addScaledVector(bk.side, (c - 1.5) * m(2.2)).add(v3(0, r * m(1.5), 0));
        lampPos.push(p);
        lampQuat.push(new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), target.clone().sub(p).normalize()));
      }
    }
  }
  // FSS lamps: tower-local → site
  const fssLampSite = fssLamps.map((p) => {
    const [x, z] = towerToSite(p.x, p.z);
    return v3(x, p.y, z);
  });
  for (const p of fssLampSite) {
    lampPos.push(p);
    lampQuat.push(new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), target.clone().sub(p).normalize()));
  }
  const lampGeo = (() => {
    const B = new Builder(1);
    B.aabb(0, 0, -m(0.35), m(1.4), m(1.0), m(0.7), C.band, false);
    B.uvFrom(0, 0.25, 0.5); // housing: dark texel of the emissive map
    const v0 = B.n;
    B.quad(v3(-m(0.62), -m(0.42), m(0.02)), v3(m(0.62), -m(0.42), m(0.02)), v3(m(0.62), m(0.42), m(0.02)), v3(-m(0.62), m(0.42), m(0.02)), C.hood);
    B.uvFrom(v0, 0.75, 0.5); // lens: lit texel
    return B.geometry();
  })();
  const lampMat = S.lamp.clone();
  lampMat.emissiveIntensity *= floodK;
  const lamps = noPick(new THREE.InstancedMesh(lampGeo, lampMat, lampPos.length));
  lamps.name = "complex-lamps";
  lampPos.forEach((p, i) => lamps.setMatrixAt(i, new THREE.Matrix4().compose(p, lampQuat[i], v3(1, 1, 1))));
  lamps.instanceMatrix.needsUpdate = true;
  lamps.computeBoundingSphere();
  site.add(lamps);
  const glowMat = (size, color, opacity) =>
    new THREE.PointsMaterial({ map: S.tex.glow, size, sizeAttenuation: true, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, toneMapped: false });
  const corePts = [...lampPos.map((p, i) => p.clone().add(v3(0, 0, m(0.1)).applyQuaternion(lampQuat[i]))), ...poleLamps];
  const glowCore = noPick(new THREE.Points(new THREE.BufferGeometry().setFromPoints(corePts), glowMat(m(3.2), new THREE.Color(1.0, 0.86, 0.66).multiplyScalar(1.6), 0.95 * floodK)));
  glowCore.name = "complex-glow-core";
  glowCore.userData.lookOpacity = { painted: 0.95 * floodK, xray: 0.55 * floodK };
  const haloPts = [...banks.map((bk) => bk.c.clone().addScaledVector(bk.toPad, m(1.2)).add(v3(0, m(0.8), 0))), ...poleLamps];
  const glowHalo = noPick(new THREE.Points(new THREE.BufferGeometry().setFromPoints(haloPts), glowMat(m(16), new THREE.Color(1.0, 0.72, 0.45), 0.42 * floodK)));
  glowHalo.name = "complex-glow-halo";
  glowHalo.userData.lookOpacity = { painted: 0.42 * floodK, xray: 0.2 * floodK };
  site.add(glowCore, glowHalo);
  // Beams: faint additive cones from each tower bank toward the pad.
  const beamCone = new THREE.CylinderGeometry(m(0.8), m(1), 1, 24, 1, true).translate(0, -0.5, 0); // apex region at y = 0, opens down −y
  {
    const pos = beamCone.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = -pos.getY(i); // 0 at the lamp, 1 at the far end
      const k = 1 + t * 11;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i), pos.getZ(i) * k);
    }
    beamCone.computeVertexNormals();
  }
  const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.58), transparent: true, opacity: 0.075 * floodK, alphaMap: S.tex.fade, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true });
  const beamsLit = noPick(new THREE.InstancedMesh(beamCone, beamMat, banks.length));
  beamsLit.name = "complex-light-beams";
  beamsLit.userData.lookOpacity = { painted: 0.075 * floodK, xray: 0 };
  banks.forEach((bk, i) => {
    const from = bk.c.clone().addScaledVector(bk.toPad, m(1.6));
    const to = v3(0, aimY * 0.6, 0);
    const len = from.distanceTo(to) * 0.95;
    const q = new THREE.Quaternion().setFromUnitVectors(v3(0, -1, 0), to.clone().sub(from).normalize());
    beamsLit.setMatrixAt(i, new THREE.Matrix4().compose(from, q, v3(1, len, 1)));
  });
  beamsLit.instanceMatrix.needsUpdate = true;
  beamsLit.computeBoundingSphere();
  beamsLit.renderOrder = 2;
  site.add(beamsLit);
  // Beacons: red obstruction lights on the tower tops, the FSS antenna, the crane jib tip and the water tower.
  const [antX, antZ] = towerToSite(0, 0);
  const [jibX, jibZ] = towerToSite(-jibL, 0);
  const beaconPts = [...mastTops.map((p) => p.clone().add(v3(0, m(0.6), 0))), v3(antX, antTop + m(0.5), antZ), v3(jibX, jibY + jibB + m(0.4), jibZ), v3(wc.x, wTop + m(0.6), wc.z)];
  const beaconGeo = new THREE.BufferGeometry().setFromPoints(beaconPts);
  beaconGeo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(beaconPts.length * 3).fill(1), 3));
  const beacons = noPick(new THREE.Points(beaconGeo, glowMat(m(5), new THREE.Color(1.0, 0.16, 0.08).multiplyScalar(2.2), 1)));
  beacons.material.vertexColors = true;
  beacons.name = "complex-beacons";
  site.add(beacons);
  // Ground light pools under the banks (and around the FSS base and the hangar door).
  const poolList = banks.map((bk) => {
    const c = v3(bk.mast[0], 0, bk.mast[1]).addScaledVector(bk.toPad, Math.hypot(...bk.mast) * 0.42);
    return new THREE.Vector4(c.x, c.z, m(30), 0.75);
  });
  poolList.push(new THREE.Vector4(-dT + hw + m(4), 0, m(18), 0.5), new THREE.Vector4(hangar.x - hangar.w / 2 - m(10), hangar.z, m(22), 0.55), new THREE.Vector4(pumpHouse[0], pumpHouse[1] + m(10), m(14), 0.4), new THREE.Vector4(0, zFront, m(20), 0.35));
  poolList.slice(0, POOLS).forEach((p, i) => pools[i].copy(p));
  groundU.uGFar.value.set(Math.max(xR, zB) + HS + m(20), Rf * 0.75, 0.3, 1 / m(60));
  // Real lights: two warm spots (front-left bank: the key's side; back-right: a rim on the vehicle), no shadows.
  const lights = [];
  if (spotLights) {
    for (const [i, kI] of [
      [3, 1.15],
      [1, 0.8],
    ]) {
      const bk = banks[i];
      const spot = new THREE.SpotLight(0xffcf9a, 1, 0, 0.5, 0.75, 2);
      spot.name = `complex-spot-${i}`;
      spot.position.copy(bk.c).addScaledVector(bk.toPad, m(1.5));
      spot.target.position.copy(target);
      const d = spot.position.distanceTo(target);
      spot.intensity = kI * d * d * floodK;
      spot.userData.intensity0 = spot.intensity;
      spot.distance = d * 3;
      spot.angle = clamp(Math.atan((0.62 * H) / d), 0.2, 0.65);
      spot.castShadow = false;
      site.add(spot, spot.target);
      lights.push(spot);
    }
  }

  // ---------- person on the deck (as anchors.js) ----------
  const person = createPerson(m, propMaterials);
  const phiH = cameraAzimuth + 0.35;
  person.position.set(Math.sin(phiH) * padR * 0.88, 0, Math.cos(phiH) * padR * 0.88);
  person.rotation.y = phiH + Math.PI;
  object3d.add(person);

  object3d.traverse(noPick);

  // ---------- pad adoption (hide the pad's own ground, lower the ground map) ----------
  const adopted = [];
  function restorePad() {
    for (const a of adopted) {
      if ("visible" in a) a.o.visible = a.visible;
      if ("y" in a) a.o.position.y = a.y;
    }
    adopted.length = 0;
  }
  function adoptPad(target = null) {
    restorePad();
    const g = target?.group ?? target ?? object3d.parent;
    if (!g?.isObject3D) return false;
    for (const o of g.children) {
      if (o === object3d) continue;
      if (o.name === "pad-ground" || o.type === "PolarGridHelper") {
        adopted.push({ o, visible: o.visible });
        o.visible = false;
      } else if (o.name === "fx-ground-map") {
        let y0 = null;
        o.traverse((c) => {
          if (y0 === null && c.geometry?.attributes?.position?.count) y0 = c.geometry.attributes.position.getY(0) + (c === o ? 0 : c.position.y);
        });
        if (y0 === null) continue;
        adopted.push({ o, y: o.position.y });
        o.position.y = groundY - 0.012 - y0;
      }
    }
    return true;
  }
  object3d.addEventListener("added", () => {
    if (object3d.parent?.name === "pad" && object3d.visible) adoptPad(object3d.parent);
  });
  object3d.addEventListener("removed", restorePad);
  if (pad) adoptPad(pad);

  // ---------- API ----------
  let look = "painted";
  const beaconCol = beaconGeo.attributes.color;
  function update(t = 0) {
    // beacons: 1.6 s cycle, alternate towers half a cycle apart, soft on/off
    for (let i = 0; i < beaconCol.count; i++) {
      const ph = (t / 1.6 + (i % 2) * 0.5) % 1;
      const k = smooth(0, 0.06, ph) * (1 - smooth(0.42, 0.55, ph));
      beaconCol.setXYZ(i, k, k, k);
    }
    beaconCol.needsUpdate = true;
    glowHalo.material.opacity = (look === "xray" ? glowHalo.userData.lookOpacity.xray : glowHalo.userData.lookOpacity.painted) * (0.97 + 0.03 * Math.sin(t * 7.1));
  }
  update(0);
  let disposed = false;
  return {
    object3d,
    tower,
    towerFrame,
    towerHeight_u: tH,
    arms,
    person,
    human: person,
    masts,
    waterTower,
    rss: rssGroup,
    hardstand,
    apron,
    trench,
    cableTray: farmMesh,
    lamps: [glowCore, glowHalo, beacons],
    lights,
    groundY_u: groundY,
    hardstandY_u: topY,
    radius_u: Rf,
    height_u: Math.max(mastTop, antTop),
    rssMaxDeg: RSS_MAX_DEG,
    get rssAngle() {
      return rssAngle;
    },
    setRssAngle,
    // Fog band that shows the complex from a camera `dist` units from its target (main.js's builder band is a few
    // stack radii wide): near a little in front of the target, far past the fence.
    fogRange(dist = 30) {
      return { near: Math.max(0.1, dist * 0.9), far: dist + Rf * 1.25 };
    },
    adoptPad,
    setVisible(on) {
      object3d.visible = !!on;
      if (!on) restorePad();
      else if (object3d.parent?.name === "pad") adoptPad(object3d.parent);
    },
    setLook(next = "painted") {
      look = next === "xray" ? "xray" : "painted";
      setPropLook(object3d, look);
      for (const s of lights) s.intensity = s.userData.intensity0 * (look === "xray" ? 0.4 : 1);
      lampMat.emissiveIntensity = S.lamp.emissiveIntensity * floodK * (look === "xray" ? 0.6 : 1);
      return look;
    },
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      restorePad();
      disposeLooks(object3d);
      object3d.traverse((o) => {
        o.geometry?.dispose();
        if (o.material && !o.isLight) o.material.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
      for (const s of lights) s.dispose?.();
      object3d.removeFromParent();
    },
  };
}

// ---------- helpers that need the frame conventions ----------

// Quad whose normal points up (+y): reorders if needed.
function quadUp(B, a, b, c, d, color, lines = false) {
  const ny = (b.z - a.z) * (d.x - a.x) - (b.x - a.x) * (d.z - a.z);
  return ny >= 0 ? B.quad(a, b, c, d, color, lines) : B.quad(a, d, c, b, color, lines);
}
// Quad tA, tB (top edge) → gB, gA (ground edge) facing away from the hardstand.
function quadOut(B, tA, tB, gB, gA, color) {
  const ux = tB.x - tA.x;
  const uz = tB.z - tA.z;
  const ox = (gA.x + gB.x) / 2 - (tA.x + tB.x) / 2;
  const oz = (gA.z + gB.z) / 2 - (tA.z + tB.z) / 2;
  // normal of (tA → gA → gB → tB) = (gA − tA) × (tB − tA); we want it along the outward offset
  const q1 = [tA, gA, gB, tB];
  const q2 = [tB, gB, gA, tA];
  const n = (q) => {
    const a = q[0];
    const b = q[1];
    const d = q[3];
    const nx = (b.y - a.y) * (d.z - a.z) - (b.z - a.z) * (d.y - a.y);
    const nz = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    return nx * ox + nz * oz;
  };
  void ux;
  void uz;
  const q = n(q1) > 0 ? q1 : q2;
  return B.quad(q[0], q[1], q[2], q[3], color);
}
// Triangle facing `out`.
function triOut(B, a, b, c, color, out) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const wx = c.x - a.x;
  const wy = c.y - a.y;
  const wz = c.z - a.z;
  const nx = uy * wz - uz * wy;
  const ny = uz * wx - ux * wz;
  const nz = ux * wy - uy * wx;
  return nx * out.x + ny * out.y + nz * out.z >= 0 ? B.tri(a, b, c, color) : B.tri(a, c, b, color);
}
// Asphalt strip a → b (plan points), width w, at height y.
function roadSegment(B, a, b, w, y, color) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) return;
  const nx = (-dz / l) * (w / 2);
  const nz = (dx / l) * (w / 2);
  const ext = w / 2; // overlap at the joints
  const ax = a[0] - (dx / l) * ext;
  const az = a[1] - (dz / l) * ext;
  const bx = b[0] + (dx / l) * ext;
  const bz = b[1] + (dz / l) * ext;
  quadUp(B, v3(ax - nx, y, az - nz), v3(bx - nx, y, bz - nz), v3(bx + nx, y, bz + nz), v3(ax + nx, y, az + nz), color);
}
// One straight berm section a → b: trapezoid (top width tw, base width bw, height h) with optional end slopes.
function bermSection(B, a, b, y0, h, tw, bw, color, capA, capB) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz);
  const ux = dx / l;
  const uz = dz / l;
  const nx = -uz;
  const nz = ux;
  const ext = (bw - tw) / 2;
  const P = (s, off, y) => v3(a[0] + ux * s + nx * off, y, a[1] + uz * s + nz * off);
  const s0 = capA ? 0 : -bw / 2;
  const s1 = capB ? l : l + bw / 2;
  const topL = [P(s0 + (capA ? ext : 0), -tw / 2, y0 + h), P(s1 - (capB ? ext : 0), -tw / 2, y0 + h)];
  const topR = [P(s0 + (capA ? ext : 0), tw / 2, y0 + h), P(s1 - (capB ? ext : 0), tw / 2, y0 + h)];
  const botL = [P(s0, -bw / 2, y0), P(s1, -bw / 2, y0)];
  const botR = [P(s0, bw / 2, y0), P(s1, bw / 2, y0)];
  quadUp(B, topL[0], topL[1], topR[1], topR[0], color);
  quadOut(B, topL[0], topL[1], botL[1], botL[0], color);
  quadOut(B, topR[1], topR[0], botR[0], botR[1], color);
  if (capA) quadOut(B, topR[0], topL[0], botL[0], botR[0], color);
  if (capB) quadOut(B, topL[1], topR[1], botR[1], botL[1], color);
}
// Merge extra segment positions into an existing LineSegments' geometry.
function mergeLines(lines, extra) {
  const old = lines.geometry.attributes.position.array; // extra: Float32Array of segment endpoints
  const arr = new Float32Array(old.length + extra.length);
  arr.set(old, 0);
  arr.set(extra, old.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  g.computeBoundingSphere();
  lines.geometry.dispose();
  lines.geometry = g;
}

// 1.8 m person: painted dark silhouette, x-ray 12-segment line figure (as anchors.js).
function createPerson(m, mats) {
  const p = (x, y) => v3(m(x), m(y), 0);
  const B = new Builder(m(1));
  const dark = new THREE.Color(0x16181c);
  B.sphere(p(0, 1.69), m(0.11), dark, 12, 8);
  B.cyl(p(0, 1.51), p(0, 1.59), m(0.06), m(0.05), 8, dark);
  B.aabb(0, m(1.2), 0, m(0.4), m(0.55), m(0.22), dark, false);
  B.aabb(0, m(0.95), 0, m(0.34), m(0.18), m(0.2), dark, false);
  const limb = (x0, y0, x1, y1, w, d) => B.strut(p(x0, y0), p(x1, y1), m(w), m(d), dark, v3(0, 0, 1), false);
  limb(-0.2, 1.42, -0.27, 0.82, 0.09, 0.1);
  limb(0.2, 1.42, 0.27, 0.82, 0.09, 0.1);
  limb(-0.1, 0.92, -0.14, 0.05, 0.13, 0.15);
  limb(0.1, 0.92, 0.14, 0.05, 0.13, 0.15);
  B.aabb(-m(0.14), m(0.03), m(0.04), m(0.12), m(0.06), m(0.26), dark, false);
  B.aabb(m(0.14), m(0.03), m(0.04), m(0.12), m(0.06), m(0.26), dark, false);
  const human = noPick(new THREE.Mesh(B.geometry(), propMaterial(mats().steelDark)));
  human.name = "complex-person";
  human.material.visible = false; // x-ray: only the line figure
  const segs = [];
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * TAU;
    const a1 = ((i + 1) / 6) * TAU;
    segs.push(p(Math.sin(a0) * 0.11, 1.69 + Math.cos(a0) * 0.11), p(Math.sin(a1) * 0.11, 1.69 + Math.cos(a1) * 0.11));
  }
  segs.push(p(0, 1.58), p(0, 0.95), p(-0.2, 1.45), p(0.2, 1.45), p(-0.2, 1.45), p(-0.27, 0.82), p(0.2, 1.45), p(0.27, 0.82), p(0, 0.95), p(-0.14, 0), p(0, 0.95), p(0.14, 0));
  const figure = noPick(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), peachLineMaterial(LINE_X)));
  figure.name = "complex-person-lines";
  figure.userData.lookOnly = "xray";
  human.add(figure);
  if (!paintProp(human, "person")) (human.material.visible = true), (figure.visible = false);
  else figure.visible = false;
  return human;
}
