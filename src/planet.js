// Planets, landing surface and touchdown dust, in the demo's x-ray palette (dark shaded bodies, warm key,
// peach rims and lines). Everything procedural, no textures.
//   createPlanet({ kind: "earth" | "moon" | "mars", radius_u }) -> { object3d, update(t, camera?), setSunDir(v3), dispose() }
//     3 draws: the body (one ShaderMaterial: shading, surface, Earth's clouds), a peach graticule every 15°
//     (opacity 0.12, turns with the body), and a thin additive atmosphere shell (Earth, Mars; the Moon has none).
//     Slow self-rotation in update(t) (t in seconds); pass the camera too and the graticule fades as the globe
//     gets small on screen (15° lines would crowd into a cage). setSunDir(world direction) moves the terminator.
//     Built to read both huge (landing page, radius ~40 u filling the lower half of the frame) and small.
//   createSurfacePatch({ kind, radius_u }) -> { object3d, dispose() }
//     flat ground disc for the landing close-up with peach line-art (opacity 0.2, fog on): craters and rocks
//     on the Moon, dunes and rocks on Mars; receives shadows. Keep the middle (r < 0.12 R) clear for the lander.
//   createDustPuff() -> { object3d, fire({ position, radius }), update(dt), active(), dispose() }
//     a ring of additive dust blobs thrown out at touchdown over ~1 s (one Points draw).
// Planet materials ignore fog so a distant globe is not swallowed by the per-frame fog band around the rocket.
import * as THREE from "three";
import { peachLineMaterial } from "./parts.js";

const PEACH = new THREE.Color(1.0, 0.706, 0.541);
const SPIN = 0.015; // rad/s self-rotation
const DEFAULT_SUN = new THREE.Vector3(-0.45, 0.75, 0.5).normalize(); // matches the warm key (upper-left-front)

// Per kind: surface colours (linear) and atmosphere.
const KINDS = {
  earth: { define: "KIND_EARTH", base: [0.03, 0.045, 0.07], land: [0.08, 0.09, 0.08], atmo: [0.3, 0.5, 1.0], atmoGain: 0.4 },
  moon: { define: "KIND_MOON", base: [0.13, 0.13, 0.135], land: [0.085, 0.085, 0.09], atmo: null, atmoGain: 0 },
  mars: { define: "KIND_MARS", base: [0.2, 0.08, 0.04], land: [0.11, 0.05, 0.03], atmo: [0.9, 0.55, 0.35], atmoGain: 0.3 },
};

const NOISE = /* glsl */ `
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s / 0.875; }
  // Cellular craters: bowl inside the radius, raised rim just outside (height in units of the body radius × k).
  float craters(vec3 p, float freq) {
    vec3 q = p * freq; vec3 i = floor(q); vec3 f = fract(q);
    float best = 8.0; float rnd = 0.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 o = vec3(hash3(i + g), hash3(i + g + 19.1), hash3(i + g + 47.3));
      vec3 r = g + o - f; float d = dot(r, r);
      if (d < best) { best = d; rnd = hash3(i + g + 71.7); }
    }
    float rad = 0.18 + 0.3 * rnd;
    float d = sqrt(best) / rad;
    float bowl = d < 1.0 ? (d * d - 1.0) * 0.6 : 0.0;
    float rim = exp(-pow((d - 1.0) / 0.14, 2.0)) * 0.35;
    return (bowl + rim) * step(0.35, rnd + 0.2);
  }
`;

const bodyVertex = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vObj = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const bodyFragment = /* glsl */ `
  uniform vec3 uSunDir, uSunColor, uRim, uBase, uLand, uAmbient;
  uniform float uTime, uRadius;
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  ${NOISE}
  // Screen-space bump (three's perturbNormalArb): h is a height in world units.
  vec3 bump(vec3 N, float h) {
    vec3 dpx = dFdx(vWorldPos); vec3 dpy = dFdy(vWorldPos);
    float dhx = dFdx(h); float dhy = dFdy(h);
    vec3 r1 = cross(dpy, N); vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * N - grad);
  }
  void main() {
    vec3 N0 = normalize(vNormalW);
    vec3 N = N0;
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 albedo = uBase;
    float glint = 0.0;
    float clouds = 0.0;
  #ifdef KIND_EARTH
    float c = fbm3(vObj * 1.7 + 3.1);
    float land = smoothstep(0.53, 0.57, c);
    albedo = mix(uBase, uLand, land);
    albedo += uRim * 0.05 * exp(-pow((c - 0.55) / 0.012, 2.0));              // faint warm coastline
    glint = (1.0 - land) * pow(max(dot(reflect(-L, N0), V), 0.0), 60.0) * 0.35; // ocean sun glint
    // Cloud band: noise drifting in longitude, strongest in the mid latitudes.
    float a = uTime * 0.01;
    vec3 cp = vec3(vObj.x * cos(a) - vObj.z * sin(a), vObj.y, vObj.x * sin(a) + vObj.z * cos(a));
    float band = smoothstep(0.75, 0.2, abs(vObj.y)) * smoothstep(0.0, 0.25, abs(vObj.y) + 0.05);
    clouds = smoothstep(0.58, 0.78, fbm3(cp * vec3(4.0, 9.0, 4.0) + 5.3)) * band * 0.3;
  #endif
  #ifdef KIND_MOON
    float maria = smoothstep(0.45, 0.62, fbm3(vObj * 1.6 + 7.0));
    albedo = mix(uBase, uLand, maria);
    float h = craters(vObj, 7.0) + 0.5 * craters(vObj + 3.3, 17.0);
    N = bump(N0, h * uRadius * 0.012);
    albedo *= 0.9 + 0.2 * vnoise(vObj * 40.0);
  #endif
  #ifdef KIND_MARS
    float dark = smoothstep(0.42, 0.66, fbm3(vObj * 2.0 + 1.7));
    albedo = mix(uBase, uLand, dark);
    float cap = smoothstep(0.82, 0.9, abs(vObj.y) + 0.04 * vnoise(vObj * 12.0));
    albedo = mix(albedo, vec3(0.32, 0.3, 0.3), cap);
    N = bump(N0, craters(vObj, 9.0) * uRadius * 0.006);
  #endif
    float ndl = dot(N, L);
    float diff = smoothstep(-0.04, 1.0, ndl);
    vec3 col = albedo * (uSunColor * diff * 1.25 + uAmbient);
    col = mix(col, vec3(0.55, 0.57, 0.6) * (uSunColor * diff * 1.5 + uAmbient * 2.0), clouds);
    col += uSunColor * glint * diff;
    float ndl0 = dot(N0, L);
    col += uRim * exp(-pow(ndl0 / 0.1, 2.0)) * 0.06;                                  // warm terminator
    float fres = pow(1.0 - clamp(dot(N0, V), 0.0, 1.0), 4.0);
    fres = pow(fres, 1.25);                                                              // narrow on huge globes
    col += uRim * fres * (0.1 + 0.9 * smoothstep(-0.25, 0.6, ndl0)) * 0.35;           // peach fresnel rim
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmoFragment = /* glsl */ `
  uniform vec3 uSunDir, uColor;
  uniform float uGain;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.0);
    float lit = smoothstep(-0.35, 0.6, dot(N, normalize(uSunDir)));
    gl_FragColor = vec4(uColor * rim * (0.15 + 0.85 * lit) * uGain, 1.0);
  }
`;

function graticule(radius) {
  const pos = [];
  const pt = (lat, lon) => [radius * Math.cos(lat) * Math.sin(lon), radius * Math.sin(lat), radius * Math.cos(lat) * Math.cos(lon)];
  const step = (15 * Math.PI) / 180;
  for (let lon = 0; lon < Math.PI * 2 - 1e-6; lon += step) {
    for (let i = 0; i < 48; i++) pos.push(...pt(-Math.PI / 2 + (i * Math.PI) / 48, lon), ...pt(-Math.PI / 2 + ((i + 1) * Math.PI) / 48, lon));
  }
  for (let lat = -Math.PI / 2 + step; lat < Math.PI / 2 - 1e-6; lat += step) {
    for (let i = 0; i < 96; i++) pos.push(...pt(lat, (i * Math.PI * 2) / 96), ...pt(lat, ((i + 1) * Math.PI * 2) / 96));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

export function createPlanet({ kind = "earth", radius_u = 40 } = {}) {
  const k = KINDS[kind] ?? KINDS.earth;
  const R = Math.max(1e-3, radius_u);
  const sun = { value: DEFAULT_SUN.clone() };
  const time = { value: 0 };
  const object3d = new THREE.Group();
  object3d.name = `planet:${kind}`;

  const bodyMat = new THREE.ShaderMaterial({
    defines: { [k.define]: "" },
    uniforms: {
      uSunDir: sun,
      uTime: time,
      uRadius: { value: R },
      uSunColor: { value: new THREE.Color(1.0, 0.86, 0.72) },
      uRim: { value: PEACH.clone() },
      uBase: { value: new THREE.Color(...k.base) },
      uLand: { value: new THREE.Color(...k.land) },
      uAmbient: { value: new THREE.Color(0.012, 0.014, 0.02) },
    },
    vertexShader: bodyVertex,
    fragmentShader: bodyFragment,
    fog: false,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), bodyMat);
  body.name = "planet-body";
  body.raycast = () => {};
  object3d.add(body);

  const gratMat = new THREE.LineBasicMaterial({ color: PEACH, transparent: true, opacity: 0.12, depthWrite: false, fog: false });
  const grat = new THREE.LineSegments(graticule(R * 1.003), gratMat);
  grat.name = "planet-graticule";
  grat.raycast = () => {};
  body.add(grat); // turns with the body

  let atmo = null;
  if (k.atmo) {
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uSunDir: sun, uColor: { value: new THREE.Color(...k.atmo) }, uGain: { value: k.atmoGain } },
      vertexShader: bodyVertex,
      fragmentShader: atmoFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.025, 96, 64), atmoMat);
    atmo.name = "planet-atmosphere";
    atmo.raycast = () => {};
    object3d.add(atmo);
  }

  const centre = new THREE.Vector3();
  return {
    object3d,
    radius_u: R,
    update(t = 0, camera = null) {
      body.rotation.y = t * SPIN;
      time.value = t;
      if (camera) {
        // angular radius on screen: full graticule above ~0.12 rad, down to a quarter below ~0.02 rad
        const ang = R / Math.max(1e-6, camera.position.distanceTo(object3d.getWorldPosition(centre)));
        gratMat.opacity = 0.12 * THREE.MathUtils.clamp((ang - 0.02) / 0.1, 0.25, 1);
      }
    },
    setSunDir(v) {
      if (v && v.lengthSq() > 0) sun.value.copy(v).normalize();
    },
    dispose() {
      body.geometry.dispose();
      bodyMat.dispose();
      grat.geometry.dispose();
      gratMat.dispose();
      if (atmo) atmo.geometry.dispose(), atmo.material.dispose();
      object3d.removeFromParent();
    },
  };
}

// Seeded random in [0, 1).
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function createSurfacePatch({ kind = "moon", radius_u = 12, seed = 7 } = {}) {
  const R = Math.max(0.1, radius_u);
  const rand = rng(seed);
  const object3d = new THREE.Group();
  object3d.name = `surface:${kind}`;
  const groundColor = { moon: 0x1c1c1e, mars: 0x2a150c, earth: 0x15191d }[kind] ?? 0x1c1c1e;
  const groundMat = new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1, metalness: 0, fog: true });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), groundMat);
  ground.receiveShadow = true;
  ground.name = "surface-ground";
  object3d.add(ground);

  const segs = [];
  const y = 0.003;
  const seg = (x0, z0, x1, z1) => segs.push(x0, y, z0, x1, y, z1);
  const clear = 0.12 * R; // keep the landing spot clear
  const place = (margin) => {
    for (let tries = 0; tries < 50; tries++) {
      const r = Math.sqrt(rand()) * (R - margin);
      const a = rand() * Math.PI * 2;
      if (r - margin > clear) return [Math.cos(a) * r, Math.sin(a) * r];
    }
    return null;
  };
  const ring = (cx, cz, r, n, from = 0, to = Math.PI * 2) => {
    for (let i = 0; i < n; i++) {
      const a0 = from + ((to - from) * i) / n;
      const a1 = from + ((to - from) * (i + 1)) / n;
      seg(cx + Math.cos(a0) * r, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cz + Math.sin(a1) * r);
    }
  };
  const rocks = (count, smin, smax) => {
    for (let i = 0; i < count; i++) {
      const s = smin + (smax - smin) * rand() ** 2;
      const c = place(s);
      if (!c) continue;
      const n = 5;
      const a0 = rand() * Math.PI;
      const pts = Array.from({ length: n }, (_, j) => {
        const a = a0 + (j / n) * Math.PI * 2;
        const rr = s * (0.7 + 0.5 * rand());
        return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr];
      });
      pts.forEach((p, j) => seg(...p, ...pts[(j + 1) % n]));
    }
  };
  if (kind === "moon") {
    for (let i = 0; i < 38; i++) {
      const s = R * (0.02 + 0.1 * rand() ** 2.2);
      const c = place(s);
      if (!c) continue;
      ring(c[0], c[1], s, 24); // rim
      const sh = Math.PI * 0.15 + rand() * 0.3; // inner shadow arc on the far side of the light
      ring(c[0] + s * 0.12, c[1] - s * 0.1, s * 0.78, 10, sh, sh + Math.PI * 0.9);
    }
    rocks(70, R * 0.004, R * 0.014);
  } else if (kind === "mars") {
    const spacing = R * 0.07;
    const freq = 2.6 / R;
    for (let z = -R; z <= R; z += spacing) {
      const phase = rand() * Math.PI * 2;
      const amp = spacing * (0.25 + 0.2 * rand());
      let prev = null;
      for (let i = 0; i <= 64; i++) {
        const x = -R + (2 * R * i) / 64;
        const zz = z + amp * Math.sin(x * freq + phase);
        const r = Math.hypot(x, zz);
        const ok = r < R * 0.97 && r > clear;
        if (ok && prev) seg(prev[0], prev[1], x, zz);
        prev = ok ? [x, zz] : null;
      }
    }
    rocks(45, R * 0.004, R * 0.012);
  } else {
    ring(0, 0, R * 0.5, 64);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
  const lines = new THREE.LineSegments(geo, peachLineMaterial(0.2));
  lines.name = "surface-lines";
  lines.raycast = () => {};
  object3d.add(lines);
  return {
    object3d,
    radius_u: R,
    dispose() {
      ground.geometry.dispose();
      groundMat.dispose();
      geo.dispose();
      lines.material.dispose();
      object3d.removeFromParent();
    },
  };
}

const DUST_N = 28;
const DUST_SECONDS = 1.0;
const dustVertex = /* glsl */ `
  attribute float aAngle, aSpeed, aSize, aRise;
  uniform float uT, uRadius, uViewportH;
  varying float vAlpha;
  void main() {
    float e = 1.0 - pow(1.0 - uT, 3.0);                          // fast out, slow settle
    float d = uRadius * (0.25 + 1.35 * e * aSpeed);
    vec3 p = vec3(cos(aAngle) * d, aRise * uRadius * 0.35 * e, sin(aAngle) * d);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = uRadius * (0.35 + 0.9 * e) * aSize;
    gl_PointSize = size * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 1e-3);
    vAlpha = pow(1.0 - uT, 1.5) * smoothstep(0.0, 0.08, uT);
    gl_Position = projectionMatrix * mv;
  }
`;
const dustFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;                                  // 0 centre .. 1 edge of the point sprite
    float g = (1.0 - smoothstep(0.0, 1.0, r)) * exp(-r * r * 2.0);
    gl_FragColor = vec4(uColor * g * vAlpha, 1.0);
  }
`;

export function createDustPuff() {
  const angle = new Float32Array(DUST_N);
  const speed = new Float32Array(DUST_N);
  const size = new Float32Array(DUST_N);
  const rise = new Float32Array(DUST_N);
  const rand = rng(29);
  for (let i = 0; i < DUST_N; i++) {
    angle[i] = (i / DUST_N) * Math.PI * 2 + (rand() - 0.5) * 0.3;
    speed[i] = 0.7 + 0.6 * rand();
    size[i] = 0.6 + 0.8 * rand();
    rise[i] = 0.2 + 0.8 * rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_N * 3), 3));
  geo.setAttribute("aAngle", new THREE.BufferAttribute(angle, 1));
  geo.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aRise", new THREE.BufferAttribute(rise, 1));
  const uniforms = { uT: { value: 0 }, uRadius: { value: 1 }, uViewportH: { value: 900 }, uColor: { value: new THREE.Color(0.3, 0.24, 0.18) } }; // dusty grey-brown
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: dustVertex, fragmentShader: dustFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // positions come from the shader
  points.raycast = () => {};
  points.name = "dust-puff";
  const buf = new THREE.Vector2();
  points.onBeforeRender = (renderer) => (uniforms.uViewportH.value = renderer.getDrawingBufferSize(buf).y);
  const object3d = new THREE.Group();
  object3d.name = "dust";
  object3d.add(points);
  object3d.visible = false;
  let t = 1;
  return {
    object3d,
    fire({ position, radius = 1 } = {}) {
      if (position) object3d.position.copy(position);
      uniforms.uRadius.value = Math.max(1e-3, radius);
      t = 0;
      uniforms.uT.value = 0;
      object3d.visible = true;
    },
    update(dt = 0) {
      if (!object3d.visible) return;
      t = Math.min(1, t + dt / DUST_SECONDS);
      uniforms.uT.value = t;
      if (t >= 1) object3d.visible = false;
    },
    active: () => object3d.visible,
    dispose() {
      geo.dispose();
      mat.dispose();
      object3d.removeFromParent();
    },
  };
}
