// Launch and ending effects (design doc §8, round 14), cheap sprites and shaders in the house style.
// Every effect is createX(...) -> { object3d, update(dt, params), fire?(...), dispose() }; object3d is added by
// UI 3 where the effect belongs (scene, pad, stack or booster group). Particles are instanced camera-facing
// quads whose shader computes each particle from time + a per-instance seed (no per-frame CPU work, no point
// size limits); sheets and cones are single meshes. One draw each unless noted; no shadows; not pickable.
//
//  (1)  createVents(ports, { scale_u })             vapour wisps at umbilical ports (pre-launch)
//         ports: [{ position: Vector3, dir?: Vector3 }] (≤ 6, same frame as object3d); setPorts(ports) to move them
//         update(dt, { intensity = 1 })
//  (2)  createDeluge({ layout })                    water sheets spreading across the deck from the mount
//         layout = createPad().layout; update(dt, { t: seconds since deluge start (T−3), intensity = 1 });
//         fills the deck over 2.5 s, fades out between t 10 and 13 s
//  (3)  createTrenchJet({ layout, color })          exhaust jetting sideways out of the trench exit (2 draws:
//         cone + sparks); update(dt, { throttle 0..1, bellHeight_m }) — full while the bells are low, gone by 30 m
//  (4)  createSteamCloud({ layout })                40–60 soft billows from the trench exit and around the deck,
//         lit from below; update(dt, { t: seconds since ignition, glow 0..1 (plume light), intensity = 1 });
//         billows grow and rise for ~12 s, then thin out by 14 s
//  (5)  createCondensationHalo({ radius_u, length_u }) brief white vapour cone (Max-Q); fire() starts 0.8 s;
//         update(dt, { intensity = 1 }); origin = the ring where the cone starts, opening downward
//  (6)  createColdGasPuffs({ scale_u })              short white jets, up to 8 at once;
//         fire({ position, dir }) in the object3d's frame; update(dt); each puff lasts 0.55 s
//  (7)  createIgnitionFlash({ color })              TEA-TEB green flash (0.4 s) or MECO sparks (0.9 s);
//         fire({ position, kind: "tea-teb" | "meco", scale_u }); update(dt)
//  (8)  createPlasmaGlow({ radius_u, length_u })    re-entry glow around the booster base (origin = engine exit
//         plane, shell up the side and a cap under the engines); update(dt, { intensity 0..1 }) — UI 2's heat proxy;
//         setBreakup(0..1): glowing fragments and sparks peeling off and trailing behind (a stage falling back
//         uncontrolled), a second draw shown only while the break-up is on
//  (9)  createCloudLayer({ altitude_u, radius_u })  a thin layer of soft cloud billboards the camera passes
//         through (fade near the camera); update(dt, { intensity = 1 })
//  (10) createSea({ radius_u })                     dark sea disc + faint peach wave lines (fog on, 2 draws);
//         update(dt) moves the swell; sea.bob(t) -> { y, rx, rz } for the drone ship (±0.3 m heave, slow roll)
//  (11) createLunarDust({ radius_u })               radial dust sheets under a lander;
//         update(dt, { throttle 0..1, altitude_m }) — grows below ~30 m, settles over ~1.5 s after cut-off
//  (12) createGroundMap({ size_u, y_u })            line-art ground: coastline, 1 km grid, the pad mark (fog on)
//  (13) createAurora()                              auroral curtains over the polar oval, 100–400 km up: a green
//         band and a red fringe (2 draws, additive) with slow folds and drifting rays; lives in the FAR layer:
//         world.attach("earth", aurora) (world.js) places it, turns it with the Earth and hides what is behind
//         the planet; setIntensity(stormGlow 0..1), update(dt)
//  (15) createImpact()                              a failed ascent hitting the sea or the ground (~2.5 s, 3
//         draws): fire({ position, kind: "sea" | "ground", speed_ms, size_u }) — sea: a white water column,
//         spray and a foam ring wave; ground: a flash and fireball, a smoke column, debris chunks, a dust shock
//         ring; update(dt), active()
//  (14) createLightning({ ground_u })               distant cloud-to-ground strike for scrubbed launches (near
//         layer, site frame): a sky flash in the cloud base, a jagged bolt, a soft glow on the ground (3 draws);
//         fire({ azimuth (compass degrees: 0 north, 90 east), distance_km }); update(dt); active()
// Weather (hazards.js effectsForFlight → { windDrift_ms, stormGlow, scrub }): the vents, steam cloud, deluge mist
// and cold-gas puffs take update(…, { wind_ms }) — a Vector3 or [x, y, z] in m/s, site frame (+x east, +y up,
// +z south) — and drift with it; plumeLean(plume, wind_ms, altitude_m) leans a plume downwind at low altitude.
// Planet extras live in planet.js (Earth night lights, createShadowDecal).
import * as THREE from "three";
import { SCALE } from "../layout.js";
import { peachLineMaterial } from "../parts.js";

const noPick = (o) => ((o.raycast = () => {}), o);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ---------- instanced billboard particles ----------

const QUAD = new THREE.PlaneGeometry(1, 1);
const SPRITE_VERT = (body, { nearFade = false } = {}) => /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uI;
  varying vec2 vUv;
  varying float vA;
  varying vec3 vCol;
  varying float vSoft;
  ${body}
  void main() {
    vec3 c = vec3(0.0); vec2 sz = vec2(0.0); float a = 0.0; vec3 col = vec3(1.0); vec3 vel = vec3(0.0); float soft = 1.0;
    particle(c, sz, a, col, vel, soft);
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    vec2 d = (modelViewMatrix * vec4(vel, 0.0)).xy;
    float L = length(d);
    float rot = aSeed.z * 6.2831853;
    vec2 ax = L > 1e-6 ? d / L : vec2(cos(rot), sin(rot));   // long axis along the screen-space velocity
    vec2 ay = vec2(-ax.y, ax.x);
    mv.xy += ax * position.y * sz.y + ay * position.x * sz.x;
    ${nearFade ? "a *= smoothstep(0.15 * sz.x, 1.0 * sz.x, -mv.z);" : ""}
    gl_Position = a > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);   // dead particles off-screen
    vUv = position.xy + 0.5; vA = a; vCol = col; vSoft = soft;
  }
`;
const SPRITE_FRAG = (additive) => /* glsl */ `
  varying vec2 vUv;
  varying float vA;
  varying vec3 vCol;
  varying float vSoft;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float g = pow(max(0.0, 1.0 - r), 1.0 + vSoft);
    if (g <= 0.001) discard;
    ${additive ? "gl_FragColor = vec4(vCol * vA * g, 1.0);" : "gl_FragColor = vec4(vCol, clamp(vA * g, 0.0, 1.0));"}
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
function sprites({ count, uniforms = {}, body, additive = true, nearFade = false, seed = 1, name }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = QUAD.index;
  geo.setAttribute("position", QUAD.attributes.position);
  const rand = rng(seed);
  const s = new Float32Array(count * 4);
  for (let i = 0; i < s.length; i++) s[i] = rand();
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(s, 4));
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uI: { value: 0 }, ...uniforms },
    vertexShader: SPRITE_VERT(body, { nearFade }),
    fragmentShader: SPRITE_FRAG(additive),
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide, // the velocity-aligned basis can mirror the quad; never cull it
    fog: false,
  });
  const mesh = noPick(new THREE.Mesh(geo, mat));
  mesh.frustumCulled = false; // positions come from the shader
  mesh.name = name;
  return mesh;
}
const NOISE = /* glsl */ `
  float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;
const TONE = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
// Wind in m/s (Vector3 or [x, y, z], site frame) → scene units per second, into a uniform; the object's own
// rotation is undone so the drift stays in the site frame.
const windU = (out, wind_ms, object3d = null) => {
  if (!wind_ms) return out.set(0, 0, 0);
  out.set(...(Array.isArray(wind_ms) ? wind_ms : [wind_ms.x, wind_ms.y, wind_ms.z])).multiplyScalar(SCALE);
  if (object3d?.parent) out.applyQuaternion(object3d.getWorldQuaternion(new THREE.Quaternion()).invert());
  return out;
};
const disposeAll = (object3d) => () => {
  object3d.traverse((o) => {
    if (o.geometry && o.geometry !== QUAD) o.geometry.dispose();
    o.material?.dispose();
  });
  object3d.removeFromParent();
};
const group = (name, ...children) => {
  const g = new THREE.Group();
  g.name = name;
  g.add(...children);
  return g;
};

// (1) Vapour wisps at the umbilical ports: cold vapour drifting out, sinking a little, with a light wind.
export function createVents(ports = [], { scale_u = 0.5 } = {}) {
  const MAX = 6;
  const uPorts = { value: Array.from({ length: MAX }, () => new THREE.Vector3()) };
  const uDirs = { value: Array.from({ length: MAX }, () => new THREE.Vector3(1, 0, 0)) };
  const uN = { value: 0 };
  const mesh = sprites({
    count: 8 * MAX,
    additive: false,
    seed: 11,
    name: "fx-vents",
    uniforms: { uPorts, uDirs, uN, uScale: { value: scale_u }, uWind: { value: new THREE.Vector3() } },
    body: /* glsl */ `
      uniform vec3 uPorts[6];
      uniform vec3 uDirs[6];
      uniform float uN;
      uniform float uScale;
      uniform vec3 uWind;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        if (float(gl_InstanceID) >= uN * 8.0) return;
        int k = int(mod(float(gl_InstanceID), max(uN, 1.0)));
        vec3 P = uPorts[k];
        vec3 D = normalize(uDirs[k]);
        float life = 2.6;
        float k01 = mod(uTime + aSeed.x * life, life) / life;
        vec3 side = normalize(cross(D, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
        c = P + D * uScale * (0.1 + 1.3 * k01) + side * uScale * (aSeed.y - 0.5) * 1.2 * k01
          + vec3(0.35, -0.45 * k01, 0.12) * uScale * k01 + uWind * (k01 * life);
        float s = uScale * (0.15 + 0.85 * k01) * (0.7 + 0.6 * aSeed.w);
        sz = vec2(s);
        a = uI * 0.38 * smoothstep(0.0, 0.15, k01) * (1.0 - k01);
        col = vec3(0.86, 0.89, 0.93);
        soft = 1.5;
      }
    `,
  });
  const object3d = group("fx-vents", mesh);
  function setPorts(list) {
    uN.value = Math.min(MAX, list.length);
    list.slice(0, MAX).forEach((p, i) => {
      uPorts.value[i].copy(p.position);
      uDirs.value[i].copy(p.dir ?? new THREE.Vector3(p.position.x, 0, p.position.z).normalize());
    });
  }
  setPorts(ports);
  return {
    object3d,
    setPorts,
    update(dt, { intensity = 1, wind_ms = null } = {}) {
      mesh.material.uniforms.uTime.value += dt;
      mesh.material.uniforms.uI.value = intensity;
      windU(mesh.material.uniforms.uWind.value, wind_ms, object3d);
      object3d.visible = intensity > 0.002 && uN.value > 0;
    },
    dispose: disposeAll(object3d),
  };
}

// Radial sheet shader shared by the deluge and the lunar dust: a disc whose sheet spreads from uInner to
// uReach with streaks flowing outward (direction-based noise, no angular seam).
const SHEET_FRAG = /* glsl */ `
  uniform float uTime, uS, uInner, uReach, uOuter, uSettle, uMist;
  uniform vec2 uWindOff;
  uniform vec3 uColor;
  varying vec3 vPos;
  ${NOISE}
  void main() {
    float r = length(vPos.xz);
    vec2 dir = vPos.xz / max(r, 1e-4);
    float front = mix(uInner, uOuter, uReach);
    float sheet = smoothstep(uInner * 0.9, uInner * 1.05, r) * (1.0 - smoothstep(front - 0.18 * uOuter, front, r));
    float flow = n2(dir * 9.0 + vec2(r / uOuter * 7.0 - uTime * 3.0, r / uOuter * 2.0)) * 0.75 + 0.25;
    float haze = uSettle * exp(-pow((r / uOuter - 0.3 - 0.5 * uSettle) / 0.25, 2.0)) * 0.4;
    // spray mist carried downwind (deluge): a soft patch displaced by the wind
    float mist = uMist * exp(-pow(length(vPos.xz - uWindOff) / (0.55 * uOuter), 2.0)) * (0.6 + 0.4 * n2(vPos.xz / uOuter * 5.0 + uWindOff - uTime * 0.6));
    vec3 col = uColor * (sheet * flow * exp(-r / uOuter * 1.2) + haze + mist * 0.3) * uS;
    gl_FragColor = vec4(col, 1.0);
    ${TONE}
  }
`;
const SHEET_VERT = /* glsl */ `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
function sheetMesh(outer, color, name) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uS: { value: 0 }, uInner: { value: 0.1 * outer }, uReach: { value: 0 }, uOuter: { value: outer }, uSettle: { value: 0 }, uMist: { value: 0 }, uWindOff: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(...color) } },
    vertexShader: SHEET_VERT,
    fragmentShader: SHEET_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = noPick(new THREE.Mesh(new THREE.CircleGeometry(outer, 72).rotateX(-Math.PI / 2), mat));
  mesh.name = name;
  return mesh;
}

// (2) Deluge: water sheets running out across the deck from the launch mount.
export function createDeluge({ layout } = {}) {
  const L = layout ?? { padR: 2.4, mountR: 0.6 };
  const mesh = sheetMesh(L.padR * 0.98, [0.55, 0.68, 0.82], "fx-deluge");
  mesh.position.y = 0.01;
  mesh.material.uniforms.uInner.value = L.mountR;
  const object3d = group("fx-deluge", mesh);
  return {
    object3d,
    update(dt, { t = 0, intensity = 1, wind_ms = null } = {}) {
      const u = mesh.material.uniforms;
      u.uTime.value += dt;
      u.uReach.value = smooth(0, 2.5, t);
      u.uS.value = 0.55 * intensity * (1 - smooth(10, 13, t)) * (t >= 0 ? 1 : 0);
      // mist: grows with the spray, carried downwind for a few seconds, never past the deck edge
      const w = windU(new THREE.Vector3(), wind_ms, object3d).multiplyScalar(Math.min(Math.max(t, 0), 6));
      const off = new THREE.Vector2(w.x, w.z);
      if (off.length() > L.padR * 0.8) off.setLength(L.padR * 0.8);
      u.uWindOff.value.copy(off);
      u.uMist.value = wind_ms ? smooth(0.5, 3, t) : 0;
      object3d.visible = u.uS.value > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// (3) Trench jet: an additive cone out of the trench exit plus sparks; local +X runs out of the trench.
export function createTrenchJet({ layout, color = [1.0, 0.55, 0.2] } = {}) {
  const L = layout ?? { padR: 2.4, plinthH: 0.6, holeR: 0.6, trenchPhi: 0 };
  const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 16, true).translate(0, 0.5, 0).rotateZ(-Math.PI / 2); // along +X, 0..1
  const jetMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uS: { value: 0 }, uCore: { value: new THREE.Color(1.0, 0.85, 0.55) }, uSheath: { value: new THREE.Color(...color) } },
    vertexShader: /* glsl */ `
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float t = clamp(position.x, 0.0, 1.0);
        vT = t;
        float r = (1.0 + 1.6 * t) / 2.6;
        vec4 mv = modelViewMatrix * vec4(position.x, position.y * r, position.z * r, 1.0);
        vV = -mv.xyz;
        vN = normalMatrix * vec3(0.0, position.y, position.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uS; uniform vec3 uCore, uSheath;
      varying float vT; varying vec3 vN; varying vec3 vV;
      ${NOISE}
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float flick = 0.75 + 0.5 * n2(vec2(vT * 6.0 - uTime * 14.0, facing * 3.0));
        float core = exp(-vT * 3.0) * pow(facing, 3.0);
        float sheath = exp(-vT * 1.6) * pow(facing, 1.2) * (1.0 - smoothstep(0.75, 1.0, vT));
        gl_FragColor = vec4((uCore * core * 2.0 + uSheath * sheath) * flick * uS, 1.0);
        ${TONE}
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const jet = noPick(new THREE.Mesh(geo, jetMat));
  jet.name = "fx-trench-jet";
  const sparks = sprites({
    count: 28,
    seed: 23,
    name: "fx-trench-sparks",
    uniforms: { uLen: { value: 1 }, uW: { value: L.holeR } },
    body: /* glsl */ `
      uniform float uLen, uW;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float life = 0.7;
        float k = mod(uTime + aSeed.x * life, life) / life;
        vec3 v0 = vec3(1.0, 0.25 * (aSeed.y - 0.3), 0.8 * (aSeed.w - 0.5)) * uLen * 1.3;
        c = vec3(0.0, (aSeed.y - 0.5) * uW * 0.6, (aSeed.w - 0.5) * uW * 1.2) + v0 * k + vec3(0.0, -0.6 * uLen * k * k, 0.0);
        vel = v0 + vec3(0.0, -1.2 * uLen * k, 0.0);
        sz = vec2(0.03 * uW, 0.03 * uW + 0.12 * uLen * (1.0 - k));
        a = uI * (1.0 - k) * step(0.25, aSeed.z);
        col = vec3(1.0, 0.7, 0.35) * 2.0;
        soft = 0.6;
      }
    `,
  });
  const object3d = group("fx-trench-jet", jet, sparks);
  const exitR = L.padR * 1.02;
  object3d.position.set(Math.sin(L.trenchPhi) * exitR, -L.plinthH * 0.55, Math.cos(L.trenchPhi) * exitR);
  object3d.rotation.y = L.trenchPhi - Math.PI / 2; // local +X → out of the trench
  return {
    object3d,
    update(dt, { throttle = 0, bellHeight_m = 0 } = {}) {
      const s = clamp01(throttle) * (1 - smooth(8, 30, bellHeight_m));
      const len = L.padR * (1.5 + 2.5 * s);
      jet.scale.set(len, L.plinthH * 0.45 * 2.6, L.holeR * 2.6);
      jetMat.uniforms.uTime.value += dt;
      jetMat.uniforms.uS.value = s;
      sparks.material.uniforms.uTime.value += dt;
      sparks.material.uniforms.uI.value = s;
      sparks.material.uniforms.uLen.value = len;
      object3d.visible = s > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// (4) Steam cloud: billows from the trench exit and around the deck, growing, rising, lit from below.
export function createSteamCloud({ layout, count = 56 } = {}) {
  const L = layout ?? { padR: 2.4, plinthH: 0.6, trenchPhi: 0 };
  const mesh = sprites({
    count,
    additive: false,
    seed: 37,
    name: "fx-steam",
    uniforms: {
      uT: { value: 0 },
      uGlow: { value: 0 },
      uR: { value: L.padR },
      uPlinth: { value: L.plinthH },
      uDir: { value: new THREE.Vector2(Math.sin(L.trenchPhi), Math.cos(L.trenchPhi)) },
      uGlowCol: { value: new THREE.Color(1.0, 0.5, 0.18) },
      uWind: { value: new THREE.Vector3() },
    },
    body: /* glsl */ `
      uniform float uT, uGlow, uR, uPlinth;
      uniform vec2 uDir;
      uniform vec3 uGlowCol;
      uniform vec3 uWind;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float birth = aSeed.x * 6.0;
        float age = max(0.0, uT - birth);
        float g = 1.0 - exp(-age / 2.2);
        vec3 src; vec3 o;
        if (aSeed.y < 0.55) {   // out of the trench exit, rolling outward
          o = normalize(vec3(uDir.x + (aSeed.z - 0.5) * 0.9, 0.0, uDir.y + (aSeed.w - 0.5) * 0.9));
          src = vec3(uDir.x, 0.0, uDir.y) * uR + vec3(0.0, -uPlinth * 0.45, 0.0);
        } else {                // around the deck edge
          float ang = aSeed.z * 6.2831853;
          o = vec3(sin(ang), 0.0, cos(ang));
          src = o * uR * 0.45;
        }
        // a low bank: billows roll outward along the ground and only slowly climb (overlaps build one cloud)
        c = src + o * uR * (0.25 + 1.6 * g) * (0.6 + 0.6 * aSeed.w) + vec3(0.0, uR * (0.05 + 0.65 * pow(g, 0.9)) * (0.3 + aSeed.y), 0.0)
          + uWind * age * (0.6 + 0.4 * aSeed.y);   // the bank drifts downwind, the higher billows faster
        float s = uR * (0.5 + 1.2 * g) * (0.7 + 0.6 * aSeed.w);
        sz = vec2(s * 1.25, s);
        vel = vec3(1.0, 0.0, 0.0);   // keep the wide axis horizontal
        a = uI * 0.32 * smoothstep(0.0, 0.8, age) * (1.0 - smoothstep(8.0, 14.0, uT)) * step(birth, uT);
        float low = exp(-max(c.y + uPlinth, 0.0) / (uR * 0.5));
        col = vec3(0.42, 0.43, 0.45) + uGlowCol * uGlow * low * 1.2;
        soft = 3.0;
      }
    `,
  });
  const object3d = group("fx-steam", mesh);
  return {
    object3d,
    update(dt, { t = 0, glow = 0, intensity = 1, wind_ms = null } = {}) {
      const u = mesh.material.uniforms;
      u.uTime.value += dt;
      u.uT.value = t;
      windU(u.uWind.value, wind_ms, object3d);
      u.uGlow.value = clamp01(glow);
      u.uI.value = intensity;
      object3d.visible = intensity > 0.002 && t > 0 && t < 14;
    },
    dispose: disposeAll(object3d),
  };
}

// (5) Condensation halo: a brief white vapour cone opening downward from the given ring (Max-Q).
export function createCondensationHalo({ radius_u = 0.5, length_u = 2 } = {}) {
  const r = radius_u;
  const pts = [new THREE.Vector2(r * 1.05, 0), new THREE.Vector2(r * 1.6, -length_u * 0.35), new THREE.Vector2(r * 2.3, -length_u)];
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vY; uniform float uTime;
      void main() { vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uA, uTime; varying vec3 vN; varying vec3 vV; varying float vY;
      ${NOISE}
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float bands = 0.6 + 0.4 * n2(vec2(vY * 6.0 - uTime * 8.0, rim * 4.0));
        gl_FragColor = vec4(vec3(0.92, 0.94, 0.97), uA * (0.25 + 0.75 * pow(rim, 1.5)) * bands);
        ${TONE}
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = noPick(new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat));
  mesh.name = "fx-condensation";
  const object3d = group("fx-condensation", mesh);
  object3d.visible = false;
  let age = Infinity;
  const DUR = 0.8;
  return {
    object3d,
    fire() {
      age = 0;
      object3d.visible = true;
    },
    update(dt, { intensity = 1 } = {}) {
      age += dt;
      mat.uniforms.uTime.value += dt;
      const env = age < DUR ? smooth(0, 0.12, age) * (1 - smooth(0.35, DUR, age)) : 0;
      mat.uniforms.uA.value = 0.55 * env * intensity;
      object3d.visible = env > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// (6) Cold-gas puffs: short white jets, a pool of 8.
export function createColdGasPuffs({ scale_u = 0.3 } = {}) {
  const SLOTS = 8;
  const uOrigin = { value: Array.from({ length: SLOTS }, () => new THREE.Vector3()) };
  const uDir = { value: Array.from({ length: SLOTS }, () => new THREE.Vector3(1, 0, 0)) };
  const uStart = { value: Array.from({ length: SLOTS }, () => -100) };
  const mesh = sprites({
    count: SLOTS * 8,
    additive: false,
    seed: 41,
    name: "fx-cold-gas",
    uniforms: { uOrigin, uDir, uStart, uScale: { value: scale_u }, uWind: { value: new THREE.Vector3() } },
    body: /* glsl */ `
      uniform vec3 uOrigin[8];
      uniform vec3 uDir[8];
      uniform float uStart[8];
      uniform float uScale;
      uniform vec3 uWind;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        int slot = gl_InstanceID / 8;
        float k = (uTime - uStart[slot]) / 0.55;
        if (k < 0.0 || k > 1.0) return;
        vec3 D = normalize(uDir[slot]);
        vec3 spread = (aSeed.xyw - 0.5) * 0.8;
        c = uOrigin[slot] + (D * 2.5 * (0.6 + 0.8 * aSeed.x) + spread) * uScale * k + uWind * (k * 0.55);
        vel = D;
        float s = uScale * (0.12 + 0.7 * k);
        sz = vec2(s, s * 1.4);
        a = 0.55 * (1.0 - k) * (1.0 - k);
        col = vec3(0.92, 0.94, 0.97);
        soft = 1.4;
      }
    `,
  });
  const object3d = group("fx-cold-gas", mesh);
  let next = 0;
  let time = 0;
  return {
    object3d,
    fire({ position, dir } = {}) {
      const i = next++ % SLOTS;
      uOrigin.value[i].copy(position ?? new THREE.Vector3());
      uDir.value[i].copy(dir ?? new THREE.Vector3(1, 0, 0));
      uStart.value[i] = time;
    },
    update(dt, { wind_ms = null } = {}) {
      time += dt;
      mesh.material.uniforms.uTime.value = time;
      windU(mesh.material.uniforms.uWind.value, wind_ms, object3d);
      object3d.visible = uStart.value.some((s) => time - s < 0.55);
    },
    active: () => uStart.value.some((s) => time - s < 0.55),
    dispose: disposeAll(object3d),
  };
}

// (7) Ignition flash (TEA-TEB green) and MECO sparks: one big flash quad + 24 sparks.
export function createIgnitionFlash({ color = [0.35, 1.0, 0.45] } = {}) {
  const uniforms = { uOrigin: { value: new THREE.Vector3() }, uStart: { value: -100 }, uKind: { value: 0 }, uScale: { value: 0.5 }, uColor: { value: new THREE.Color(...color) } };
  const mesh = sprites({
    count: 25,
    seed: 53,
    name: "fx-ignition-flash",
    uniforms,
    body: /* glsl */ `
      uniform vec3 uOrigin;
      uniform float uStart, uKind, uScale;
      uniform vec3 uColor;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float age = uTime - uStart;
        bool meco = uKind > 0.5;
        float life = meco ? 0.9 : 0.4;
        float k = age / life;
        if (k < 0.0 || k > 1.0) return;
        vec3 sparkCol = meco ? vec3(1.0, 0.6, 0.25) : uColor;
        if (gl_InstanceID == 0) {          // the flash
          c = uOrigin;
          float s = uScale * (meco ? 1.2 : 2.5) * (0.6 + 2.4 * k);
          sz = vec2(s);
          a = (meco ? 0.6 : 1.4) * (1.0 - k) * (1.0 - k);
          col = sparkCol * 2.0;
          soft = 1.2;
          return;
        }
        if (!meco && gl_InstanceID > 10) return;   // TEA-TEB: a few green sparks only
        vec3 dir = normalize(aSeed.xyz - 0.5 + vec3(0.0, meco ? -0.45 : 0.0, 0.0));
        float sp = uScale * (meco ? 4.0 : 6.0) * (0.5 + aSeed.w);
        c = uOrigin + dir * sp * age + vec3(0.0, -1.5 * uScale * age * age, 0.0);
        vel = dir * sp + vec3(0.0, -3.0 * uScale * age, 0.0);
        sz = vec2(0.04 * uScale, 0.04 * uScale + 0.25 * uScale * (1.0 - k));
        a = (1.0 - k);
        col = sparkCol * 2.0;
        soft = 0.6;
      }
    `,
  });
  const object3d = group("fx-ignition-flash", mesh);
  object3d.visible = false;
  let time = 0;
  let until = -1;
  return {
    object3d,
    fire({ position, kind = "tea-teb", scale_u = 0.5 } = {}) {
      uniforms.uOrigin.value.copy(position ?? new THREE.Vector3());
      uniforms.uKind.value = kind === "meco" ? 1 : 0;
      uniforms.uScale.value = scale_u;
      uniforms.uStart.value = time;
      until = time + (kind === "meco" ? 0.9 : 0.4);
      object3d.visible = true;
    },
    update(dt) {
      time += dt;
      mesh.material.uniforms.uTime.value = time;
      object3d.visible = time < until;
    },
    active: () => time < until,
    dispose: disposeAll(object3d),
  };
}

// (8) Plasma glow: additive orange-pink shell around the booster base with streaks flowing up the side
// (the booster falls engines first), a hot cap under the engines.
export function createPlasmaGlow({ radius_u = 0.5, length_u = 3 } = {}) {
  const r = radius_u;
  const pts = [[0.55 * r, -0.35 * r], [1.0 * r, -0.12 * r], [1.25 * r, 0], [1.15 * r, 0.3 * length_u], [1.05 * r, length_u]].map(([x, y]) => new THREE.Vector2(x, y));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uI: { value: 0 }, uLen: { value: length_u }, uR: { value: r } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() { vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uTime, uI, uLen, uR; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      ${NOISE}
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        vec2 dir = normalize(vP.xz + 1e-4);
        float h = clamp(vP.y / uLen, -0.2, 1.0);
        float streak = n2(dir * 7.0 + vec2(0.0, vP.y / uR * 1.5 - uTime * 6.0)) * n2(dir * 13.0 + vec2(5.0, vP.y / uR * 3.0 - uTime * 9.0));
        float fall = exp(-max(h, 0.0) * 2.5);
        float cap = smoothstep(0.0, -0.3 * uR, vP.y);
        vec3 orange = vec3(1.0, 0.45, 0.22);
        vec3 pink = vec3(1.0, 0.35, 0.62);
        vec3 col = mix(orange, pink, clamp(h * 1.5, 0.0, 1.0)) * (0.3 + 0.7 * pow(rim, 1.2)) * fall * (0.55 + 1.4 * streak);
        col += vec3(1.0, 0.85, 0.7) * cap * 1.5;
        gl_FragColor = vec4(col * uI * 2.0, 1.0);
        ${TONE}
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = noPick(new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat));
  mesh.name = "fx-plasma";
  // Break-up: fragments shed from the hot shell, streaming up past the falling stage (+y), cooling from white
  // to deep orange; some tumble off sideways.
  const shards = sprites({
    count: 72,
    seed: 67,
    name: "fx-plasma-breakup",
    uniforms: { uB: { value: 0 }, uLen: { value: length_u }, uR: { value: r } },
    body: /* glsl */ `
      uniform float uB, uLen, uR;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        if (aSeed.w > uB) return;                       // more of them as the break-up grows
        float life = 0.6 + 0.8 * aSeed.y;
        float k = mod(uTime + aSeed.x * life, life) / life;
        float ang = aSeed.z * 6.2831853 + aSeed.x * 3.0;
        vec3 o = vec3(cos(ang), 0.0, sin(ang));
        float h0 = aSeed.y * uLen * 0.8;
        float rise = uLen * (0.8 + 2.6 * aSeed.x) * k;   // swept up behind the stage
        float out_ = uR * (1.1 + (0.5 + 4.0 * aSeed.w) * k);
        c = o * out_ + vec3(0.0, h0 + rise, 0.0);
        vel = vec3(o.x * 0.25, 1.0, o.z * 0.25);
        float big = step(0.78, aSeed.z);                // a few larger burning pieces
        float s = uR * (0.1 + 0.32 * big) * (1.0 - 0.4 * k);
        sz = vec2(s, s * (1.5 + 9.0 * (1.0 - big) * (1.0 - k)));   // sparks streak, pieces stay compact
        a = uI * (1.0 - k) * (0.8 + 0.6 * aSeed.y);
        col = mix(vec3(1.0, 0.9, 0.7), vec3(1.0, 0.35, 0.1), k) * 3.0;
        soft = 0.8;
      }
    `,
  });
  shards.visible = false;
  const object3d = group("fx-plasma", mesh, shards);
  object3d.visible = false;
  let breakup = 0;
  return {
    object3d,
    setBreakup(k = 0) {
      breakup = clamp01(k);
      shards.material.uniforms.uB.value = breakup;
    },
    update(dt, { intensity = 0 } = {}) {
      mat.uniforms.uTime.value += dt;
      mat.uniforms.uI.value = clamp01(intensity);
      shards.material.uniforms.uTime.value += dt;
      shards.material.uniforms.uI.value = clamp01(intensity);
      shards.visible = breakup > 0.002;
      object3d.visible = intensity > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// (9) Cloud layer: soft billboards in a thin disc; they fade near the camera so flying through stays clean.
export function createCloudLayer({ altitude_u = 50, radius_u = 60, count = 40 } = {}) {
  const mesh = sprites({
    count,
    additive: false,
    nearFade: true,
    seed: 61,
    name: "fx-clouds",
    uniforms: { uAlt: { value: altitude_u }, uRad: { value: radius_u } },
    body: /* glsl */ `
      uniform float uAlt, uRad;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float r = uRad * sqrt(aSeed.x);
        float ang = aSeed.y * 6.2831853 + uTime * 0.003;
        c = vec3(sin(ang) * r, uAlt + (aSeed.z - 0.5) * uRad * 0.04, cos(ang) * r);
        float s = uRad * (0.12 + 0.2 * aSeed.w);
        sz = vec2(s * 0.45, s);       // wide along the (horizontal) long axis
        vel = vec3(1.0, 0.0, 0.0);
        a = uI * 0.38 * (1.0 - smoothstep(0.8, 1.0, sqrt(aSeed.x)));
        col = vec3(0.78, 0.8, 0.84);
        soft = 2.2;
      }
    `,
  });
  const object3d = group("fx-clouds", mesh);
  return {
    object3d,
    update(dt, { intensity = 1 } = {}) {
      mesh.material.uniforms.uTime.value += dt;
      mesh.material.uniforms.uI.value = intensity;
      object3d.visible = intensity > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// Drone-ship motion on a gentle swell: ±0.3 m heave (+ chop), ≤ 1.2° / 0.8° roll and pitch (scene units, radians).
export const shipBob = (t, scale = SCALE) => ({
  y: 0.3 * scale * Math.sin(t * 0.7) + 0.08 * scale * Math.sin(t * 1.9 + 0.7),
  rx: ((1.2 * Math.PI) / 180) * Math.sin(t * 0.45),
  rz: ((0.8 * Math.PI) / 180) * Math.sin(t * 0.33 + 1),
});

// (10) Sea: dark water disc with faint peach swell lines (fog on); bob(t) for the drone ship.
export function createSea({ radius_u = 80, spacing_u = null, scale = SCALE } = {}) {
  const R = Math.max(1, radius_u);
  const sp = spacing_u ?? R / 36;
  const water = noPick(new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x05080d, roughness: 0.55, metalness: 0.2, fog: true })));
  water.name = "fx-sea-water";
  const segs = [];
  const rand = rng(71);
  for (let z = -R; z <= R; z += sp) {
    const phase = rand() * Math.PI * 2;
    const amp = sp * 0.18;
    let prev = null;
    for (let i = 0; i <= 96; i++) {
      const x = -R + (2 * R * i) / 96;
      const zz = z + amp * Math.sin((x / R) * 9 + phase);
      const ok = Math.hypot(x, zz) < R * 0.98;
      if (ok && prev) segs.push(prev[0], 0.01, prev[1], x, 0.01, zz);
      prev = ok ? [x, zz] : null;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
  const waves = noPick(new THREE.LineSegments(geo, peachLineMaterial(0.18)));
  waves.name = "fx-sea-waves";
  const object3d = group("fx-sea", water, waves);
  let time = 0;
  const bob = (t) => shipBob(t, scale);
  return {
    object3d,
    bob,
    update(dt) {
      time += dt;
      waves.position.z = ((time * 0.08 * sp) % sp) - sp / 2; // slow swell drift
    },
    dispose: disposeAll(object3d),
  };
}

// (11) Lunar dust: radial sheets under the lander, growing below ~30 m, settling after engine cut-off.
export function createLunarDust({ radius_u = 4 } = {}) {
  const mesh = sheetMesh(radius_u, [0.52, 0.49, 0.45], "fx-lunar-dust");
  mesh.position.y = 0.01;
  const object3d = group("fx-lunar-dust", mesh);
  object3d.visible = false;
  let last = 0;
  let settle = 0;
  return {
    object3d,
    update(dt, { throttle = 0, altitude_m = 100 } = {}) {
      const u = mesh.material.uniforms;
      u.uTime.value += dt;
      const near = 1 - smooth(3, 30, altitude_m);
      if (throttle > 0.02) {
        last = clamp01(throttle) * near;
        settle = 0;
        u.uS.value = 0.9 * last;
        u.uReach.value = 0.25 + 0.75 * near;
        u.uSettle.value = 0;
      } else {
        settle += dt;
        u.uS.value = 0.9 * last * Math.exp(-settle / 1.5);
        u.uSettle.value = clamp01(settle / 1.5);
      }
      object3d.visible = u.uS.value > 0.002;
    },
    dispose: disposeAll(object3d),
  };
}

// (12) Ground map: coastline (the sea to the east of the pad), a 1 km grid and the pad mark, in peach lines.
export function createGroundMap({ size_u = 4000, y_u = -0.6, scale = SCALE } = {}) {
  const half = size_u / 2;
  const km = 1000 * scale;
  const segs = [];
  const seg = (x0, z0, x1, z1) => segs.push(x0, y_u, z0, x1, y_u, z1);
  for (let x = -Math.floor(half / km) * km; x <= half; x += km) seg(x, -half, x, half);
  for (let z = -Math.floor(half / km) * km; z <= half; z += km) seg(-half, z, half, z);
  // Coastline: a meander a few km east of the pad, and a barrier-island line offshore.
  const coastX = (z) => 3.2 * km + 1.4 * km * Math.sin(z / (9 * km)) + 0.5 * km * Math.sin(z / (3.1 * km) + 1) + 0.2 * km * Math.sin(z / (1.1 * km) + 2);
  for (const off of [0, 1.1 * km]) {
    for (let i = 0; i < 240; i++) {
      const z0 = -half + (size_u * i) / 240;
      const z1 = -half + (size_u * (i + 1)) / 240;
      seg(coastX(z0) + off, z0, coastX(z1) + off, z1);
    }
  }
  // Pad mark: a 150 m circle with a cross.
  const pr = 150 * scale;
  for (let i = 0; i < 48; i++) {
    const a0 = (i / 48) * Math.PI * 2;
    const a1 = ((i + 1) / 48) * Math.PI * 2;
    seg(Math.cos(a0) * pr, Math.sin(a0) * pr, Math.cos(a1) * pr, Math.sin(a1) * pr);
  }
  seg(-1.6 * pr, 0, 1.6 * pr, 0);
  seg(0, -1.6 * pr, 0, 1.6 * pr);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
  const lines = noPick(new THREE.LineSegments(geo, peachLineMaterial(0.25)));
  lines.name = "fx-ground-map";
  const object3d = group("fx-ground-map", lines);
  return { object3d, update() {}, dispose: disposeAll(object3d) };
}

// ---------- weather (round 18: hazards.js) ----------

// Plume lean in the wind at low altitude: tilts a plume (attachPlumes / createPlume) so its tail goes downwind,
// up to 10° and gone by ~5 km where the vehicle's own speed dominates. wind_ms in the site frame; the plume's
// parent rotation (the vehicle pitching over) is undone. Returns the lean angle (radians). Visual model.
const DOWN = new THREE.Vector3(0, -1, 0);
export function plumeLean(plume, wind_ms, altitude_m = 0) {
  const o = plume?.object3d ?? plume;
  const w = windU(new THREE.Vector3(), wind_ms).divideScalar(SCALE); // m/s, site frame
  w.y = 0;
  const speed = w.length();
  const angle = Math.min((10 * Math.PI) / 180, speed * ((0.7 * Math.PI) / 180)) * (1 - smooth(300, 5000, altitude_m));
  if (!o) return angle;
  if (angle < 1e-6) {
    o.quaternion.identity();
    return 0;
  }
  // The plume hangs along its parent's −Y (the vehicle axis); bend its tail toward downwind, expressed in the
  // parent's frame and kept perpendicular to that axis.
  const pq = o.parent ? o.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
  const dw = w.normalize().applyQuaternion(pq);
  dw.addScaledVector(DOWN, -dw.dot(DOWN));
  if (dw.lengthSq() < 1e-9) {
    o.quaternion.identity();
    return 0;
  }
  dw.normalize();
  const tail = DOWN.clone().multiplyScalar(Math.cos(angle)).addScaledVector(dw, Math.sin(angle));
  o.quaternion.setFromUnitVectors(DOWN, tail);
  return angle;
}

// (13) Aurora: two ribbons around the northern auroral oval in Earth-fixed axes (z = north pole), in FAR-layer
// units (1 = 10 km): the green band 100–220 km up and the red fringe 200–400 km, folding slowly, with vertical
// rays drifting along. World.attach("earth", aurora) positions it each frame and shares the Earth's ray
// constants so curtains behind the planet are hidden. Oval latitude and heights are visual.
export function createAurora({ radius_u = 637.1, lat_deg = 67 } = {}) {
  const SEG = 384;
  const strip = () => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEG + 1) * 2 * 3);
    const uv = new Float32Array((SEG + 1) * 2 * 2);
    for (let i = 0; i <= SEG; i++) {
      for (let j = 0; j < 2; j++) {
        uv.set([i / SEG, j], (i * 2 + j) * 2);
      }
    }
    const idx = [];
    for (let i = 0; i < SEG; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); // placed in the vertex shader
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius_u * 1.1);
    return geo;
  };
  const shared = {
    uTime: { value: 0 },
    uI: { value: 0 },
    uR: { value: radius_u },
    uLat: { value: (lat_deg * Math.PI) / 180 },
    // occluder (the Earth's ray constants; world.attach fills these by reference)
    uOccDir: { value: new THREE.Vector3(0, 0, -1) },
    uOccDist: { value: 1e9 },
    uOccDCC: { value: new THREE.Vector3(1e18, 1e18, 1e18) },
    uOccR: { value: radius_u },
    uOccNear: { value: 0 },
  };
  const make = (name, h0_km, h1_km, bottomCol, topCol, gain) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uH0: { value: h0_km / 10 }, uH1: { value: h1_km / 10 }, uBottom: { value: new THREE.Color(...bottomCol) }, uTop: { value: new THREE.Color(...topCol) }, uGain: { value: gain } },
      vertexShader: /* glsl */ `
        uniform float uTime, uR, uLat, uH0, uH1;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vFold;
        ${NOISE}
        void main() {
          vUv = uv;
          float lon = uv.x * 6.2831853;
          // the oval wanders and folds; the folds slide slowly along it
          float fold = 0.045 * sin(lon * 3.0 + uTime * 0.03) + 0.018 * sin(lon * 11.0 - uTime * 0.11) + 0.01 * (n2(vec2(lon * 6.0, uTime * 0.05)) - 0.5);
          vFold = fold;
          float lat = uLat + fold;
          float h = mix(uH0, uH1, uv.y) * (1.0 + 0.08 * sin(lon * 7.0 + uTime * 0.07));
          vec3 p = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)) * (uR + h);
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uI, uGain, uOccDist, uOccR, uOccNear;
        uniform vec3 uBottom, uTop, uOccDir, uOccDCC;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vFold;
        ${NOISE}
        void main() {
          // hidden behind the planet: the view ray reaches the ground before this point
          vec3 d = normalize(vWorld);
          float b = uOccDist * dot(d, uOccDir);
          float disc;
          if (uOccNear > 0.5) disc = b * b - uOccDCC.x;
          else { vec3 cr = cross(d, uOccDir); disc = uOccR * uOccR - uOccDist * uOccDist * dot(cr, cr); }
          if (disc > 0.0 && b - sqrt(disc) > 0.0 && b - sqrt(disc) < length(vWorld)) discard;
          // vertical rays drifting along the oval, a bright lower edge fading upward, a slow ripple
          float lon = vUv.x * 6.2831853;
          float rays = 0.55 + 0.45 * n2(vec2(lon * 140.0 + uTime * 0.4, vUv.y * 2.0));
          rays *= 0.7 + 0.3 * n2(vec2(lon * 40.0 - uTime * 0.15, 0.0));
          float ripple = 0.75 + 0.25 * sin(vUv.y * 9.0 - uTime * 0.9 + lon * 5.0);
          // patchy along the oval: bright arcs and quiet gaps that drift
          float arcs = 0.2 + 0.8 * smoothstep(0.3, 0.75, n2(vec2(lon * 5.0 + uTime * 0.02, 3.7)) * 0.7 + n2(vec2(lon * 17.0 - uTime * 0.05, 1.3)) * 0.3);
          float edge = smoothstep(0.0, 0.08, vUv.y) * pow(1.0 - vUv.y, 1.6);
          vec3 col = mix(uBottom, uTop, smoothstep(0.2, 1.0, vUv.y));
          gl_FragColor = vec4(col * edge * rays * ripple * arcs * uI * uGain, 1.0);
          ${TONE}
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = noPick(new THREE.Mesh(strip(), mat));
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1e6; // over the bodies in the far layer
    return mesh;
  };
  const green = make("fx-aurora-green", 100, 220, [0.15, 1.0, 0.45], [0.2, 0.9, 0.55], 1.6);
  const red = make("fx-aurora-red", 200, 400, [0.7, 0.12, 0.35], [0.9, 0.1, 0.25], 0.55);
  const object3d = group("fx-aurora", green, red);
  object3d.userData.occluded = shared; // world.attach shares the body's ray constants into these
  object3d.visible = false;
  return {
    object3d,
    setIntensity(k = 0) {
      shared.uI.value = clamp01(k);
      object3d.visible = shared.uI.value > 0.002;
    },
    update(dt) {
      shared.uTime.value += dt;
    },
    dispose: disposeAll(object3d),
  };
}

// (14) Lightning: a distant cloud-to-ground strike in the near layer (site frame, scene units): a soft flash
// in the cloud base, a jagged bolt (a camera-facing ribbon, rebuilt per strike) and a glow where it lands. A
// strike flickers through 2–4 return strokes over ~0.7 s. Cloud base height and sizes are visual.
export function createLightning({ ground_u = 0, cloudBase_km = 3 } = {}) {
  const U = 1000 * SCALE; // scene units per km
  const flashMat = new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(0.75, 0.8, 1.0), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, opacity: 0 });
  const flash = noPick(new THREE.Sprite(flashMat));
  flash.name = "fx-lightning-flash";
  const boltMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: /* glsl */ `attribute float aEdge; varying float vEdge; void main() { vEdge = aEdge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uI; varying float vEdge; void main() { float core = 1.0 - abs(vEdge); gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * (pow(core, 3.0) * 3.0 + core * 0.6) * uI, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const bolt = noPick(new THREE.Mesh(new THREE.BufferGeometry(), boltMat));
  bolt.name = "fx-lightning-bolt";
  bolt.frustumCulled = false;
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: new THREE.Color(0.6, 0.65, 0.9), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, opacity: 0 });
  const glow = noPick(new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glowMat));
  glow.name = "fx-lightning-glow";
  const object3d = group("fx-lightning", flash, bolt, glow);
  object3d.visible = false;
  let rand = rng(91);
  let age = Infinity;
  let strokes = [];
  // jagged path from the cloud base to the ground, a few side branches; a ribbon facing the pad (−dir)
  function build(at, dir) {
    const top = at.clone().setY(ground_u + cloudBase_km * U);
    const pts = [top.clone()];
    const n = 26;
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    let p = top.clone();
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      p = new THREE.Vector3().lerpVectors(top, at, k);
      p.addScaledVector(side, (rand() - 0.5) * 0.18 * cloudBase_km * U * (1 - k * 0.6));
      p.addScaledVector(dir, (rand() - 0.5) * 0.08 * cloudBase_km * U);
      pts.push(p);
    }
    pts[pts.length - 1].copy(at);
    const w = 0.012 * cloudBase_km * U; // ribbon width
    const pos = [];
    const edge = [];
    const idx = [];
    const ribbon = (list, width) => {
      const base = pos.length / 3;
      list.forEach((q) => {
        pos.push(q.x - side.x * width, q.y, q.z - side.z * width, q.x + side.x * width, q.y, q.z + side.z * width);
        edge.push(-1, 1);
      });
      for (let i = 0; i < list.length - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    ribbon(pts, w);
    for (let b = 0; b < 3; b++) {
      const from = 4 + Math.floor(rand() * 14);
      let q = pts[from].clone();
      const br = [q.clone()];
      for (let i = 0; i < 6; i++) {
        q = q.clone().add(new THREE.Vector3((rand() - 0.5) * 0.3, -0.5 - rand() * 0.3, 0).multiplyScalar(0.12 * cloudBase_km * U));
        q.addScaledVector(side, (rand() - 0.5) * 0.1 * cloudBase_km * U);
        br.push(q);
      }
      ribbon(br, w * 0.45);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
    g.setIndex(idx);
    bolt.geometry.dispose();
    bolt.geometry = g;
  }
  return {
    object3d,
    // azimuth in compass degrees (0 north = −z, 90 east = +x), distance in km from the site origin
    fire({ azimuth = 70, distance_km = 9, seed } = {}) {
      if (seed !== undefined) rand = rng(seed);
      const a = (azimuth * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      const at = dir.clone().multiplyScalar(distance_km * U).setY(ground_u);
      build(at, dir);
      flash.position.copy(at).setY(ground_u + cloudBase_km * U * 1.05);
      flash.scale.setScalar(cloudBase_km * U * 3.2);
      glow.position.copy(at).setY(ground_u + 0.5);
      glow.scale.setScalar(cloudBase_km * U * 1.6);
      // return strokes: start times (s) and strengths
      strokes = [[0, 1]];
      const extra = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < extra; i++) strokes.push([0.08 + i * 0.12 + rand() * 0.1, 0.5 + 0.5 * rand()]);
      age = 0;
      object3d.visible = true;
    },
    update(dt) {
      age += dt;
      let k = 0;
      for (const [t0, s] of strokes) {
        const t = age - t0;
        if (t >= 0) k = Math.max(k, s * Math.exp(-t / 0.05));
      }
      const afterglow = age < 1 ? 0.15 * Math.exp(-age / 0.3) : 0;
      boltMat.uniforms.uI.value = k;
      flashMat.opacity = Math.min(1, k * 0.55 + afterglow);
      glowMat.opacity = Math.min(1, k * 0.7 + afterglow * 0.5);
      object3d.visible = age < 1.2;
    },
    active: () => age < 1.2,
    dispose: disposeAll(object3d),
  };
}
// A soft round glow (shared by the lightning flash and ground glow).
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      data.set([255, 255, 255, Math.round(255 * Math.exp(-((r / 0.45) ** 2)) * (1 - Math.min(1, r)))], (y * n + x) * 4);
    }
  }
  glowTex = new THREE.DataTexture(data, n, n);
  glowTex.magFilter = glowTex.minFilter = THREE.LinearFilter;
  glowTex.needsUpdate = true;
  return glowTex;
}

// (15) Impact: a failed ascent hitting the sea or the ground. One additive burst (flash, fireball, glowing
// debris / spray glints), one normal-blend column (smoke and dark chunks / the white water column and spray)
// and an expanding ring (dust shock / foam ring wave). Sizes scale with speed_ms; ~2.5 s. Visual model.
export function createImpact() {
  const DUR = 2.5;
  const shared = { uStart: { value: -100 }, uOrigin: { value: new THREE.Vector3() }, uSea: { value: 0 }, uSize: { value: 8 } };
  const burst = sprites({
    count: 48,
    seed: 71,
    name: "fx-impact-burst",
    uniforms: shared,
    body: /* glsl */ `
      uniform float uStart, uSea, uSize;
      uniform vec3 uOrigin;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float t = uTime - uStart;
        if (t < 0.0 || t > 2.5) return;
        bool sea = uSea > 0.5;
        if (gl_InstanceID == 0) {                       // the flash
          float k = t / (sea ? 0.25 : 0.45);
          if (k > 1.0) return;
          c = uOrigin + vec3(0.0, uSize * 0.3, 0.0);
          sz = vec2(uSize * (sea ? 2.0 : 4.0) * (0.5 + k));
          a = (sea ? 0.8 : 2.0) * (1.0 - k) * (1.0 - k);
          col = sea ? vec3(0.9, 0.95, 1.0) : vec3(1.0, 0.75, 0.4);
          soft = 1.0;
          return;
        }
        if (!sea && gl_InstanceID < 14) {               // fireball billows: rise, swell, darken
          float k = t / 1.4;
          if (k > 1.0) return;
          vec3 d = normalize(aSeed.xyz - 0.5 + vec3(0.0, 0.6, 0.0));
          c = uOrigin + d * uSize * 1.4 * sqrt(k) + vec3(0.0, uSize * 1.2 * k, 0.0);
          sz = vec2(uSize * (0.6 + 1.2 * k) * (0.7 + 0.6 * aSeed.w));
          a = 1.3 * (1.0 - k) * (1.0 - k);
          col = mix(vec3(1.0, 0.8, 0.45), vec3(0.9, 0.25, 0.05), k) * 1.8;
          soft = 1.6;
          return;
        }
        // glowing debris (ground) or spray glints (sea): ballistic, outward and up
        float k = t / 1.8;
        if (k > 1.0) return;
        vec3 d = normalize(vec3(aSeed.x - 0.5, sea ? 0.9 + aSeed.y : 0.3 + aSeed.y * 0.8, aSeed.z - 0.5));
        float sp = uSize * (sea ? 3.0 : 4.5) * (0.4 + aSeed.w);
        c = uOrigin + d * sp * t + vec3(0.0, -uSize * 1.6 * t * t, 0.0);
        vel = d * sp + vec3(0.0, -uSize * 3.2 * t, 0.0);
        sz = vec2(uSize * 0.05, uSize * (0.05 + 0.25 * (1.0 - k)));
        a = (sea ? 0.5 : 1.0) * (1.0 - k);
        col = sea ? vec3(0.85, 0.9, 1.0) : vec3(1.0, 0.55, 0.2) * 2.0;
        soft = 0.6;
      }
    `,
  });
  const column = sprites({
    count: 54,
    additive: false,
    seed: 73,
    name: "fx-impact-column",
    uniforms: shared,
    body: /* glsl */ `
      uniform float uStart, uSea, uSize;
      uniform vec3 uOrigin;
      void particle(inout vec3 c, inout vec2 sz, inout float a, inout vec3 col, inout vec3 vel, inout float soft) {
        float t = uTime - uStart;
        if (t < 0.0 || t > 2.5) return;
        bool sea = uSea > 0.5;
        float k = t / 2.5;
        if (gl_InstanceID < 40) {
          float delay = aSeed.x * (sea ? 0.25 : 0.6);
          float tt = max(t - delay, 0.0);
          if (sea) {                                    // the water column: thrown up, spreading, falling back
            float v0 = uSize * (4.0 + 3.0 * aSeed.y);
            float y = max(v0 * tt - uSize * 1.6 * tt * tt, 0.0);
            vec2 sp = (aSeed.zw - 0.5) * uSize * (0.25 + 0.9 * tt);   // a narrow column that spreads as it tops out
            c = uOrigin + vec3(sp.x, y * 0.85, sp.y);
            float w = uSize * (0.25 + 0.45 * tt) * (0.7 + 0.6 * aSeed.w);
            sz = vec2(w, w * (2.6 - 1.4 * k));               // tall streaks while rising
            vel = vec3(0.0, 1.0, 0.0);
            a = 0.5 * smoothstep(0.0, 0.1, tt) * (1.0 - smoothstep(0.6, 1.0, k)) * step(0.0, y + 0.001);
            col = vec3(0.92, 0.95, 0.98);
          } else {                                      // the smoke column: rising, swelling, drifting
            float y = uSize * (0.3 + 4.0 * (1.0 - exp(-tt / 1.2))) * (0.6 + 0.5 * aSeed.y);
            vec2 sp = (aSeed.zw - 0.5) * uSize * (0.6 + 1.0 * tt);
            c = uOrigin + vec3(sp.x + uSize * 0.3 * tt, y, sp.y);
            sz = vec2(uSize * (0.6 + 0.9 * tt) * (0.7 + 0.6 * aSeed.w));
            a = 0.5 * smoothstep(0.0, 0.3, tt) * (1.0 - smoothstep(0.75, 1.0, k));
            col = mix(vec3(0.14, 0.13, 0.12), vec3(0.3, 0.29, 0.28), aSeed.y);
          }
          soft = 2.4;
          return;
        }
        // dark debris chunks (ground) / a low spray sheet (sea)
        vec3 d = normalize(vec3(aSeed.x - 0.5, sea ? 0.15 : 0.5 + aSeed.y, aSeed.z - 0.5));
        float sp = uSize * (sea ? 2.5 : 3.5) * (0.5 + aSeed.w);
        c = uOrigin + d * sp * t + vec3(0.0, -uSize * 1.6 * t * t, 0.0);
        if (c.y < uOrigin.y) return;
        vel = d;
        float s = uSize * (sea ? 0.35 : 0.12) * (0.6 + 0.8 * aSeed.y);
        sz = vec2(s);
        a = (sea ? 0.35 : 0.9) * (1.0 - k);
        col = sea ? vec3(0.9, 0.94, 0.97) : vec3(0.08, 0.07, 0.07);
        soft = sea ? 2.0 : 0.3;
      }
    `,
  });
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uStart, uSea, uSize;
      varying vec2 vP;
      ${NOISE}
      void main() {
        float t = uTime - uStart;
        float k = clamp(t / 2.5, 0.0, 1.0);
        float R = uSize * (0.6 + (uSea > 0.5 ? 5.0 : 6.5) * pow(k, 0.6));
        float r = length(vP);
        float w = uSize * (0.25 + 0.5 * k);
        float band = exp(-pow((r - R) / w, 2.0)) * (0.7 + 0.3 * n2(normalize(vP + 1e-4) * 9.0 + k * 2.0));
        float a = band * (1.0 - k) * step(0.0, t) * step(t, 2.5);
        vec3 col = uSea > 0.5 ? vec3(0.9, 0.94, 0.97) : vec3(0.45, 0.38, 0.3);
        gl_FragColor = vec4(col, a * (uSea > 0.5 ? 0.7 : 0.6));
        ${TONE}
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const ring = noPick(new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), ringMat));
  ring.name = "fx-impact-ring";
  const object3d = group("fx-impact", burst, column, ring);
  object3d.visible = false;
  let time = 0;
  let until = -1;
  return {
    object3d,
    // position in the object3d's frame (on the surface); speed_ms scales the event; size_u overrides it
    fire({ position, kind = "ground", speed_ms = 300, size_u } = {}) {
      const size = size_u ?? 8 * Math.min(2, Math.max(0.4, speed_ms / 300));
      shared.uOrigin.value.copy(position ?? new THREE.Vector3());
      shared.uSea.value = kind === "sea" ? 1 : 0;
      shared.uSize.value = size;
      shared.uStart.value = time;
      ring.position.copy(shared.uOrigin.value).add(new THREE.Vector3(0, 0.02, 0));
      ring.scale.setScalar(size * 9);
      until = time + DUR;
      object3d.visible = true;
    },
    update(dt) {
      time += dt;
      burst.material.uniforms.uTime.value = time;
      column.material.uniforms.uTime.value = time;
      ringMat.uniforms.uTime.value = time;
      object3d.visible = time < until;
    },
    active: () => time < until,
    dispose: disposeAll(object3d),
  };
}
