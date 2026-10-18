// Exhaust plumes, pad light and the plume's glow on the pad (design doc §7, A3).
//   createPlume({ engineRecord, exitRadius_u, gain }) -> { object3d, update(dt, { throttle, ambientPressure_Pa,
//                                                          cameraDistance }), metrics, dispose() }
//   attachPlumes(part) -> plumes[]   one plume per bell of an engines part, added to part.group at the bell
//                                    exits (plume.engine = engine index); gain 1/√bells so a cluster's
//                                    overlapping additive plumes do not saturate to white
//   createPadLight({ baseRadius_u, bellExitRadius_u }) -> { object3d, light, disc, splash, metrics,
//                                                          update(dt, throttle, altitude_m), dispose() }
// A plume hangs from its bell exit along −Y (local y = 0 is the exit plane). One additive mesh + one sprite per
// bell; toneMapped off and HDR colours so bloom picks up the core.
//
// Look (visual model, no data): at sea level a tight bright core just below the exit with 5 Mach diamonds
// (periodic brightness along the axis) inside a translucent sheath; as ambient pressure falls the plume
// widens to exit radius × (1 + 5·(p0 − p)/p0), up to 6× in vacuum, the diamonds fade out and it becomes a faint
// wide bell. Length scales with throttle. Colours by propellant. Flicker from cheap value noise.
import * as THREE from "three";
import { bellExits } from "./parts.js";

export const P0 = 101325; // Pa, sea-level standard pressure

// Visual constants (shape only).
const K_WIDE = 5; // vacuum width = exit radius × (1 + K_WIDE)
const LEN_K = 16; // sea-level plume length at full throttle = exit radius × LEN_K
const SEA_WMAX = 1.6; // widest point of the sea-level shape (radius factor)

// Colours (linear, may exceed 1 for bloom) and gains per propellant.
const LOOKS = {
  kerolox: { core: [1.0, 0.82, 0.5], sheath: [1.0, 0.42, 0.1], coreGain: 1.0, sheathGain: 1.0, smoke: 0 }, // orange-yellow core, sooty orange sheath
  hydrolox: { core: [0.95, 0.95, 1.0], sheath: [0.42, 0.32, 0.95], coreGain: 1.1, sheathGain: 0.22, smoke: 0 }, // nearly invisible blue-violet, white core
  methalox: { core: [0.45, 0.62, 1.0], sheath: [0.55, 0.45, 0.95], coreGain: 0.9, sheathGain: 0.45, smoke: 0 }, // blue core
  solid: { core: [1.0, 0.9, 0.72], sheath: [1.0, 0.62, 0.32], coreGain: 1.0, sheathGain: 1.3, smoke: 0.8 }, // white-orange with a bright smoky tail
  hypergolic: { core: [1.0, 0.65, 0.45], sheath: [0.95, 0.45, 0.3], coreGain: 0.9, sheathGain: 0.6, smoke: 0 },
};

const vertexShader = /* glsl */ `
  uniform float uWide;   // vacuum width factor at the tail
  uniform float uWmax;   // normaliser: the mesh's xz scale is exitRadius × uWmax
  uniform float uVac;    // 0 sea level .. 1 vacuum
  uniform float uDiamonds, uDiamondN;
  varying float vT;
  varying vec3 vN;
  varying vec3 vV;
  float radiusFactor(float t) {
    // sea level: a short under-expanded neck, then slow growth; vacuum: a fast flare toward uWide
    float sea = 1.0 + 0.55 * t - 0.16 * sin(3.14159265 * clamp(t * 5.0, 0.0, 1.0));
    // shock cells pinch the boundary at every diamond (sea level only)
    sea *= 1.0 - 0.12 * uDiamonds * (0.5 + 0.5 * cos(6.2831853 * uDiamondN * t)) * exp(-t * 1.5);
    float vac = 1.0 + (uWide - 1.0) * (1.0 - pow(1.0 - t, 3.0));
    return mix(sea, vac, uVac);
  }
  void main() {
    float t = clamp(-position.y, 0.0, 1.0);
    vT = t;
    float r = radiusFactor(t) / uWmax;
    vec4 mv = modelViewMatrix * vec4(position.x * r, position.y, position.z * r, 1.0);
    vV = -mv.xyz;
    vN = normalMatrix * vec3(position.x, 0.0, position.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uSheath;
  uniform float uThrottle, uDiamonds, uDiamondN, uTime, uVac, uCoreGain, uSheathGain, uSmoke, uSeed, uGain;
  varying float vT;
  varying vec3 vN;
  varying vec3 vV;
  float h1(float n) { return fract(sin(n) * 43758.5453123); }
  float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
  void main() {
    float t = vT;
    float facing = abs(dot(normalize(vN), normalize(vV)));      // 1 on the axis as seen, 0 at the rim
    float coreMask = pow(facing, 3.0);
    float flick = 0.82 + 0.36 * n1(t * 7.0 - uTime * 21.0 + uSeed) * n1(uTime * 29.0 + uSeed * 3.1);
    float head = exp(-t * 12.0) * coreMask;                      // bright just below the exit
    float knots = pow(0.5 + 0.5 * cos(6.2831853 * uDiamondN * t), 10.0) * exp(-t * 2.4) * uDiamonds * pow(facing, 6.0);
    float sheath = exp(-t * mix(2.0, 3.2, uVac)) * pow(facing, 1.3) * mix(1.0, 0.3, uVac) * (1.0 + uSmoke * t * 1.5);
    float tail = 1.0 - smoothstep(0.7, 1.0, t);
    vec3 col = uCore * (head * 2.2 + knots * 1.6) * uCoreGain + uSheath * sheath * uSheathGain;
    gl_FragColor = vec4(col * uThrottle * flick * tail * uGain, 1.0);
  }
`;

let plumeGeo = null; // unit open cylinder, top (the exit plane) at y = 0, tail at y = −1; shared by every plume
let coreTex = null; // radial falloff for the core sprite (alpha), shared
function sharedAssets() {
  plumeGeo ??= new THREE.CylinderGeometry(1, 1, 1, 24, 24, true).translate(0, -0.5, 0);
  if (!coreTex) {
    const n = 64;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n - 0.5;
        const dy = (y + 0.5) / n - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
        const a = Math.exp(-((r / 0.38) ** 2)) * (1 - Math.min(1, r) ** 4);
        data.set([255, 255, 255, Math.round(a * 255)], (y * n + x) * 4);
      }
    }
    coreTex = new THREE.DataTexture(data, n, n);
    coreTex.magFilter = coreTex.minFilter = THREE.LinearFilter;
    coreTex.needsUpdate = true;
  }
  return { plumeGeo, coreTex };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
let seedCounter = 0;

export function createPlume({ engineRecord, exitRadius_u, gain = 1 }) {
  const { plumeGeo: geo, coreTex: tex } = sharedAssets();
  const look = LOOKS[engineRecord?.propellant] ?? LOOKS.kerolox;
  const exitR = Math.max(1e-4, exitRadius_u);
  const seed = (seedCounter++ * 7.31) % 97;
  const uniforms = {
    uCore: { value: new THREE.Color(...look.core) },
    uSheath: { value: new THREE.Color(...look.sheath) },
    uThrottle: { value: 0 },
    uDiamonds: { value: 1 },
    uDiamondN: { value: 5 },
    uTime: { value: 0 },
    uVac: { value: 0 },
    uWide: { value: 1 },
    uWmax: { value: SEA_WMAX },
    uCoreGain: { value: look.coreGain },
    uSheathGain: { value: look.sheathGain },
    uSmoke: { value: look.smoke },
    uSeed: { value: seed },
    uGain: { value: gain },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "plume";
  mesh.renderOrder = 3;
  mesh.raycast = () => {}; // never pickable

  const spriteMat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(...look.core).multiplyScalar(1.6 * look.coreGain), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.name = "plume-core";
  sprite.renderOrder = 3;
  sprite.raycast = () => {};
  sprite.position.y = -0.35 * exitR;

  const object3d = new THREE.Group();
  object3d.name = "plume";
  object3d.add(mesh, sprite);
  object3d.visible = false;

  let time = 0;
  const metrics = { length_u: 0, width_u: exitR, diamonds: 1, throttle: 0 };
  function update(dt, { throttle = 0, ambientPressure_Pa = P0, cameraDistance = 20 } = {}) {
    time += dt;
    const thr = clamp01(throttle);
    const pr = clamp01(ambientPressure_Pa / P0);
    const vac = 1 - pr;
    const wide = 1 + K_WIDE * vac;
    const wmax = Math.max(SEA_WMAX, wide);
    const length = exitR * LEN_K * (0.3 + 0.7 * thr) * (1 + 1.2 * vac);
    const diamonds = smooth(0.25, 0.9, pr);
    object3d.visible = thr > 0.002;
    mesh.scale.set(exitR * wmax, length, exitR * wmax);
    uniforms.uThrottle.value = thr;
    uniforms.uVac.value = vac;
    uniforms.uWide.value = wide;
    uniforms.uWmax.value = wmax;
    uniforms.uDiamonds.value = diamonds;
    uniforms.uTime.value = time;
    // Core sprite: smaller and dimmer in vacuum; never shrinks below a few pixels when the camera is far.
    const flick = 0.88 + 0.12 * Math.sin(time * 37 + seed) * Math.sin(time * 23.7 + seed * 0.5);
    const s = Math.max(exitR * (1.8 + 1.4 * pr) * (0.5 + 0.5 * thr), cameraDistance * 0.008 * thr);
    sprite.scale.set(s, s, 1);
    spriteMat.opacity = thr * flick * (0.45 + 0.55 * pr) * Math.min(1, gain * 1.5);
    // Tail radius = exitR × radiusFactor(1) = exitR × mix(1.55, wide, vac) (see the vertex shader).
    Object.assign(metrics, { length_u: length, width_u: exitR * (1.55 + (wide - 1.55) * vac), diamonds, throttle: thr });
  }
  update(0);

  return {
    object3d,
    update,
    metrics,
    exitRadius_u: exitR,
    dispose() {
      material.dispose();
      spriteMat.dispose();
      object3d.removeFromParent();
    },
  };
}

// One plume per bell of an engines part (twin-chamber engines get two), at the bell exits in part-local
// coordinates, added to part.group so they move with the stage. Returns the plumes (plume.engine = index).
export function attachPlumes(part) {
  const bells = bellExits(part);
  const gain = 1 / Math.sqrt(Math.max(1, bells.length));
  return bells.map((b) => {
    const plume = createPlume({ engineRecord: part.record, exitRadius_u: b.r, gain });
    plume.object3d.position.set(b.x, 0, b.z);
    part.group.add(plume.object3d);
    plume.engine = b.engine;
    return plume;
  });
}

// Warm flickering light from the exhaust, an additive glow disc on the pad (the plume's reflection) and, at
// ignition, a deflected splash: a turbulent sheet of exhaust spreading across the deck from the plume
// footprint. update(dt, throttle 0..1, altitude_m) — altitude of the bell exits above the deck, in metres
// (an object { altitude_u } in scene units is also accepted). The splash is full while the bells are within
// 2 exit radii of the deck and gone by 15 m; light and glow fade more slowly as the rocket climbs.
//   bellExitRadius_u: the widest bell exit of the firing stage (e.g. bellExits(part)[0].r); sets the
//   "2 exit radii" height and the hot footprint size.
const SPLASH_GONE_M = 15;
const splashVertex = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const splashFragment = /* glsl */ `
  uniform vec3 uColor, uHot;
  uniform float uStrength, uTime, uFoot;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    vec2 dir = p / max(r, 1e-4);
    float reach = 0.2 + 0.75 * uStrength;                        // the sheet spreads further with strength
    float edge = 1.0 - smoothstep(reach - 0.2, reach, r);
    // turbulent outward flow: noise on the direction (seam-free) advected along the radius
    float flow = n2(dir * 7.0 + vec2(r * 6.0 - uTime * 5.0, r * 3.0)) * 0.75 + 0.25;
    float foot = exp(-pow(r / max(uFoot, 0.03), 2.0));          // hot spot under the bells
    vec3 col = uHot * foot * 1.8 + uColor * exp(-r * 2.0) * flow * edge * 1.4;
    gl_FragColor = vec4(col * uStrength, 1.0);
  }
`;

export function createPadLight({ baseRadius_u = 1, bellExitRadius_u = 0.12, color = 0xff8a3a, intensity = 40 } = {}) {
  const b = Math.max(0.1, baseRadius_u);
  const object3d = new THREE.Group();
  object3d.name = "pad-light";
  const light = new THREE.PointLight(color, 0, 0, 2);
  light.position.set(0, 0.35 * b, 0);
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false };
  const discMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: 0 } },
    vertexShader: splashVertex,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStrength; varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float g = exp(-r * r * 4.0) * (1.0 - smoothstep(0.85, 1.0, r));
        gl_FragColor = vec4(uColor * g * uStrength, 1.0);
      }`,
    ...additive,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(b * 4, 48).rotateX(-Math.PI / 2), discMat);
  disc.position.y = 0.006;
  disc.raycast = () => {};
  disc.renderOrder = 2;
  const splashR = b * 6;
  const splashMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(1.0, 0.5, 0.16) },
      uHot: { value: new THREE.Color(1.0, 0.85, 0.6) },
      uStrength: { value: 0 },
      uTime: { value: 0 },
      uFoot: { value: (b * 0.9) / splashR },
    },
    vertexShader: splashVertex,
    fragmentShader: splashFragment,
    ...additive,
  });
  const splash = new THREE.Mesh(new THREE.CircleGeometry(splashR, 64).rotateX(-Math.PI / 2), splashMat);
  splash.position.y = 0.01;
  splash.raycast = () => {};
  splash.renderOrder = 3;
  object3d.add(light, disc, splash);
  object3d.visible = false;
  const S = 0.25; // scene units per metre (layout.js SCALE), for the altitude_u form
  const nearM = (2 * Math.max(1e-3, bellExitRadius_u)) / S; // "within 2 exit radii of the deck", metres
  let time = 0;
  const metrics = { splash: 0, light: 0 };
  function update(dt, throttle = 0, altitude = 0) {
    time += dt;
    const thr = clamp01(throttle);
    const alt_m = Math.max(0, typeof altitude === "object" && altitude ? (altitude.altitude_m ?? (altitude.altitude_u ?? 0) / S) : +altitude || 0);
    const near = 1 / (1 + (alt_m / ((6 * b) / S)) ** 2);
    const flick = 0.82 + 0.18 * Math.sin(time * 31) * Math.sin(time * 17.3 + 1.7);
    const splashK = 1 - smooth(nearM, Math.max(nearM + 1, SPLASH_GONE_M), alt_m);
    light.intensity = intensity * thr * flick * (0.3 + 0.7 * near) * (1 + 0.5 * splashK);
    discMat.uniforms.uStrength.value = 1.4 * thr * near * flick;
    splashMat.uniforms.uStrength.value = thr * splashK * (0.85 + 0.15 * flick);
    splashMat.uniforms.uTime.value = time;
    splash.visible = thr * splashK > 0.002;
    object3d.visible = thr > 0.002;
    metrics.splash = thr * splashK;
    metrics.light = light.intensity;
  }
  return {
    object3d,
    light,
    disc,
    splash,
    metrics,
    update,
    dispose() {
      discMat.dispose();
      splashMat.dispose();
      disc.geometry.dispose();
      splash.geometry.dispose();
      object3d.removeFromParent();
    },
  };
}
