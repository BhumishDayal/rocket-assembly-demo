// The FAR render layer in scaled space (design doc §8, round 16; round 17: night launch). One continuous world:
// Earth at the origin, the Moon at its distance, Mars where the transfer puts it, stars, the sun; the NEAR layer
// (vehicle, pad, effects, local ground) composites on top with its depth cleared.
//
//   createWorld({ renderer? }) -> {
//     scene, camera, bodies: { earth, moon, mars }, sunDir (world, unit), sunLight (a DirectionalLight for the near
//     layer, same direction), setViewer({ body, pos_km, quaternion | camera, frame? }), setDestination(body,
//     pos_km_fromEarth), landingSite(body), skyAt(body, alt_km), surfaceColourAt(body, lat, lon), isOceanAt(lat,
//     lon), atmosphereLimb(body), createLocalGround({ body, pos_km, size_km, kind? }), cloudDeck(body, alt_km),
//     attach(body, fx) (far-layer effects riding with a body, e.g. launchfx's aurora), update(),
//     render(renderer), createPass(), dispose(),
//     // UI 2's flight.js frame (Earth-centred, z = Earth's axis, x toward longitude 0, Earth's rotation ignored):
//     fromECI(v_km) / toECI(v_km) (Vector3 or [x, y, z] → Vector3 in the other frame), eciFrame (Quaternion:
//     ECI axes → world axes; pass it as setViewer's frame if the near layer is built in ECI axes),
//     setBodyECI(body, eci_km) (e.g. the moving Moon: f.bodyPosAt("moon", t) or sample.dest_eci_km),
//     setViewerECI({ eci_km, camera | quaternion, frame }), setSunDir(v), sunForSite(body, pos_km, elevation_deg),
//     // cost: setResolutionScale(s) (the bodies at s × the output resolution, bilinear; default 0.5 when
//     // devicePixelRatio ≥ 1.5, else 1), setEnabled(on) (off: only a clear to clearColor), stats { scale,
//     // width, height, cpuMs, gpuMs (EXT_disjoint_timer_query_webgl2, else null), passes, skipped } }
//
// Frame: 1 unit = 10 km (KM_PER_UNIT), Earth-centred, axes = the launch site's frame at the Cape (28.5° N,
// 80.6° W): +x east, +y up, +z south there (the near layer's pad frame, so both layers share orientation).
// Positions are given in km relative to a body's centre (pos_km), in these axes.
// Rendering: every body is ONE draw, a ray-traced sphere (a proxy shell; the fragment shader intersects the
// view ray with the exact sphere), so the horizon is exact at 0 km and the limb at any altitude, with no mesh
// facets and no depth fighting. The far camera sits at the origin and the bodies are placed camera-relative in
// double precision every frame (floating origin), drawn far to near (no depth test). In each body's shader:
// map shading (day, night lights, ocean glint, relief), a cloud shell (Earth), single-scatter atmosphere
// (Earth, Mars) along the ray, and a faint deep-blue night haze (round 17).
// Lighting: one sun for the world. For the Earth ascent it sits below the Cape's horizon (a night launch: dark
// sky, stars, the lit limb ahead from space); the Moon and Mars landing sites are chosen where the same sun
// stands at lightingFor(body).sunElevation_deg (UI 2's arrival.js).
// Sizes: volumetric mean radii from the NASA planetary fact sheets (the pages arrival.js cites); the Moon's
// distance 384 400 km (fact sheet semi-major axis). Atmosphere scale heights from atmosphereFor (arrival.js).
// Scattering coefficients, cloud height, haze and colours are visual.
import * as THREE from "three";
import { atmosphereFor, lightingFor } from "./arrival.js";
import { planetTexture, createTerrain, createOcean, skyAt as daySkyAt } from "./planet.js";
import { createCloudLayer } from "./fx/launchfx.js";
import { SCALE } from "./layout.js";

export const KM_PER_UNIT = 10;
const NEAR_U_PER_KM = 1000 * SCALE; // near-layer scene units per km
const DEG = Math.PI / 180;
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html, moonfact.html, marsfact.html (volumetric mean radius)
const RADIUS_KM = { earth: 6371.0, moon: 1737.4, mars: 3389.5 };
const MOON_DISTANCE_KM = 384400; // moonfact.html: semimajor axis 0.3844 × 10^6 km
const CAPE = { lat: 28.5, lon: -80.6 };
const STAR_R = 2e6; // units
const NIGHT_SUN_ELEVATION_DEG = -24; // round 17: the sun well below the Cape's horizon at launch (visual)
const CLOUD_ALT_KM = 5; // Earth's cloud shell (visual)
// Render layers of the far scene: stars and sun, the ray-traced bodies (may go to a reduced-resolution target),
// attached effects (drawn over the bodies at full resolution).
const LAYER_SKY = 0;
const LAYER_BODIES = 1;
const LAYER_FX = 2;

// ---------- frames ----------

// Unit vectors at (lat, lon) in a body-fixed frame (z = north pole, x = lon 0).
const ecef = (lat, lon) => new THREE.Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG));
// Earth: world → body-fixed. At the Cape, world (x, y, z) = (east, up, south).
function earthToBody() {
  const U = ecef(CAPE.lat, CAPE.lon);
  const E = new THREE.Vector3(-Math.sin(CAPE.lon * DEG), Math.cos(CAPE.lon * DEG), 0);
  const N = new THREE.Vector3().crossVectors(U, E);
  // body = [E U −N] · world (columns)
  return new THREE.Matrix3().set(E.x, U.x, -N.x, E.y, U.y, -N.y, E.z, U.z, -N.z);
}
const latLonOf = (m, dirWorld) => {
  const b = dirWorld.clone().applyMatrix3(m).normalize();
  return { lat: Math.asin(THREE.MathUtils.clamp(b.z, -1, 1)) / DEG, lon: Math.atan2(b.y, b.x) / DEG };
};

// ---------- the body shader ----------

const bodyVertex = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPos = wp.xyz;            // camera-relative: the far camera is at the origin
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const bodyFragment = /* glsl */ `
  uniform vec3 uDir;          // unit direction camera → body centre
  uniform float uDist;        // distance camera → centre (units)
  uniform vec3 uDCC;          // D² − r² for the ground, the atmosphere top and the cloud shell (from JS, exact)
  uniform float uNearMode;    // 1: use uDCC (viewer close), 0: the cross-product form (viewer far)
  uniform float uR, uRa, uRc; // radii: ground, atmosphere top, cloud shell
  uniform mat3 uToBody;       // world → body-fixed (z north, x lon 0)
  uniform vec3 uSun;          // unit, towards the sun
  uniform float uSunI;
  uniform sampler2D uColor, uBump, uNight, uClouds;
  uniform float uHasNight, uHasClouds, uOcean, uRelief, uHasAtmo, uCloudU;
  uniform vec3 uBetaR, uBetaM, uExtM, uGlowColor;
  uniform float uHR, uHM, uMieG, uGlow;
  varying vec3 vPos;

  const float PI = 3.14159265;
  vec2 hit(vec3 d, float r, float dcc) {
    float b = uDist * dot(d, uDir);
    float disc;
    if (uNearMode > 0.5) disc = b * b - dcc;
    else { vec3 cr = cross(d, uDir); disc = r * r - uDist * uDist * dot(cr, cr); }
    if (disc < 0.0) return vec2(-1.0);
    float s = sqrt(disc);
    return vec2(b - s, b + s);
  }
  vec2 uvOf(vec3 nWorld) {
    vec3 q = normalize(uToBody * nWorld);
    return vec2(atan(q.y, q.x) / (2.0 * PI) + 0.5, asin(clamp(q.z, -1.0, 1.0)) / PI + 0.5);
  }
  // optical depth from p (centre-relative) toward the sun to the top; -1 when the planet blocks the sun
  vec2 lightDepth(vec3 p) {
    float ps = dot(p, uSun);
    float pp = dot(p, p);
    if (ps < 0.0 && pp - ps * ps < uR * uR) return vec2(-1.0);
    float tl = -ps + sqrt(max(ps * ps - (pp - uRa * uRa), 0.0));
    vec2 od = vec2(0.0);
    float dt = tl / 4.0;
    for (int j = 0; j < 4; j++) {
      vec3 q = p + uSun * (float(j) + 0.5) * dt;
      float h = length(q) - uR;
      od += vec2(exp(-h / uHR), exp(-h / uHM)) * dt;
    }
    return od;
  }
  vec3 bumpN(vec3 N, vec3 P, float h) {
    vec3 dpx = dFdx(P); vec3 dpy = dFdy(P);
    float dhx = dFdx(h); float dhy = dFdy(h);
    vec3 r1 = cross(dpy, N); vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    if (abs(det) < 1e-12) return N;
    return normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2));
  }

  void main() {
    vec3 d = normalize(vPos);
    vec3 C = uDir * uDist;
    vec2 g = hit(d, uR, uDCC.x);
    bool ground = g.y > 0.0 && g.x > 0.0;
    float tG = ground ? g.x : 1e30;
    vec3 col = vec3(0.0);
    float trans = 1.0;     // what of the background shows through (blend: dst × alpha)

    // ---- the surface ----
    vec3 surf = vec3(0.0);
    vec3 pG = vec3(0.0);
    vec3 nG = vec3(0.0);
    float cloudA = 0.0;
    vec3 cloudCol = vec3(0.0);
    if (ground) {
      pG = d * tG - C;
      nG = normalize(pG);
      vec2 uv = uvOf(nG);
      vec3 albedo = texture2D(uColor, uv).rgb;
      float h = texture2D(uBump, uv).r;
      vec3 N = bumpN(nG, pG, h * uRelief);
      float ndl0 = dot(nG, uSun);
      float diff = max(dot(N, uSun), 0.0) * smoothstep(-0.03, 0.06, ndl0);
      float shade = 1.0;
      if (uHasClouds > 0.5) {
        vec3 toSunTan = uSun - nG * ndl0;
        vec2 suv = uvOf(normalize(nG + toSunTan * 0.0008 / max(ndl0, 0.1)));
        shade = 1.0 - 0.45 * smoothstep(0.15, 0.9, texture2D(uClouds, vec2(suv.x + uCloudU, suv.y)).r);
      }
      surf = albedo * diff * uSunI * shade;
      float ocean = uOcean * (1.0 - smoothstep(0.004, 0.03, h));
      vec3 V = -d;
      vec3 Hh = normalize(uSun + V);
      surf += vec3(uSunI) * pow(max(dot(nG, Hh), 0.0), 220.0) * ocean * 0.5 * step(0.0, ndl0) * shade;
      float night = 1.0 - smoothstep(-0.12, 0.05, ndl0);
      // city lights from above only: at grazing angles the map's minified average would smear them into a
      // warm band along the horizon (round 17: nothing warm in the night sky)
      float overhead = smoothstep(0.08, 0.35, dot(nG, -d));
      surf += texture2D(uNight, uv).rgb * night * uHasNight * 1.4 * overhead;
    }
    // ---- the cloud shell (Earth): from above over the ground, from below overhead ----
    if (uHasClouds > 0.5) {
      vec2 c = hit(d, uRc, uDCC.z);
      float tc = c.x > 0.0 ? c.x : c.y; // entering from above, or leaving from below
      if (c.y > 0.0 && tc < tG) {
        vec3 pc = d * tc - C;
        vec3 nc = normalize(pc);
        vec2 uv = uvOf(nc);
        cloudA = smoothstep(0.12, 0.85, texture2D(uClouds, vec2(uv.x + uCloudU, uv.y)).r) * 0.92;
        float lit = smoothstep(-0.08, 0.25, dot(nc, uSun));
        cloudCol = vec3(uSunI) * (0.004 + 0.996 * lit);
      }
    }
    // ---- the atmosphere along the ray (single scattering), plus the night haze ----
    vec3 inscatter = vec3(0.0);
    vec3 T = vec3(1.0);
    if (uHasAtmo > 0.5) {
      vec2 a = hit(d, uRa, uDCC.y);
      if (a.y > 0.0) {
        float t0 = max(a.x, 0.0);
        float t1 = min(a.y, tG);
        float dt = (t1 - t0) / 16.0;
        vec2 od = vec2(0.0);
        vec3 sumR = vec3(0.0);
        vec3 sumM = vec3(0.0);
        float dens = 0.0;
        for (int i = 0; i < 16; i++) {
          vec3 p = d * (t0 + (float(i) + 0.5) * dt) - C;
          float h = max(length(p) - uR, 0.0);
          vec2 rho = vec2(exp(-h / uHR), exp(-h / uHM)) * dt;
          od += rho;
          dens += rho.x;
          vec2 ld = lightDepth(p);
          if (ld.x >= 0.0) {
            vec3 att = exp(-(uBetaR * (od.x + ld.x) + uExtM * (od.y + ld.y)));
            sumR += rho.x * att;
            sumM += rho.y * att;
          }
        }
        float mu = dot(d, uSun);
        float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
        float g2 = uMieG * uMieG;
        float pM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * uMieG * mu, 1.5));
        inscatter = uSunI * (sumR * uBetaR * pR + sumM * uBetaM * pM) * 12.0;
        inscatter += uGlowColor * uGlow * (1.0 - exp(-dens * 0.08)); // night haze: thickest along the horizon
        T = exp(-(uBetaR * od.x + uExtM * od.y));
      } else if (!ground) discard;
    } else if (!ground) {
      discard;
    }
    if (ground) {
      surf = mix(surf, cloudCol, cloudA);
      col = surf * T + inscatter;
      trans = 0.0;
    } else {
      float tAvg = dot(T, vec3(0.3333));
      col = mix(inscatter, cloudCol * tAvg + inscatter, cloudA);
      trans = tAvg * (1.0 - cloudA);
    }
    gl_FragColor = vec4(col, trans);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Per-body look: maps, relief (texture height → units), atmosphere (visual coefficients per unit; scale heights
// from atmosphereFor), night haze.
function bodyLook(name) {
  const air = atmosphereFor(name);
  const H = air && !air.none ? air.scaleHeight_m / 1000 / KM_PER_UNIT : 0;
  if (name === "earth")
    return { maps: ["earth_day", "earth_bump", "earth_night", "earth_clouds"], ocean: 1, relief: 0.8, atmo: { H, HM: 0.12, betaR: [0.058, 0.135, 0.331], betaM: [0.21, 0.21, 0.21], extM: [0.231, 0.231, 0.231], g: 0.76, top: 10 * H, glow: 1, glowColor: [0.004, 0.012, 0.05] } };
  if (name === "mars")
    // Mars: dust scatters red most but absorbs blue, so its extinction is roughly neutral (butterscotch sky)
    return { maps: ["mars_color", "mars_bump"], ocean: 0, relief: 1.2, atmo: { H, HM: H, betaR: [0.004, 0.007, 0.014], betaM: [0.36, 0.21, 0.09], extM: [0.2, 0.2, 0.2], g: 0.6, top: 8 * H, glow: 0, glowColor: [0, 0, 0] } };
  return { maps: ["moon_color", "moon_disp"], ocean: 0, relief: 0.6, atmo: null };
}

function createBody(name) {
  const look = bodyLook(name);
  const R = RADIUS_KM[name] / KM_PER_UNIT;
  const atmo = look.atmo;
  const Ra = atmo ? R + atmo.top : R;
  const Rc = name === "earth" ? R + CLOUD_ALT_KM / KM_PER_UNIT : R;
  const tex = (n, srgb = true) => (n ? planetTexture(n, { srgb }) : planetTexture("none"));
  const [cm, bm, nm, clm] = look.maps;
  const uniforms = {
    uDir: { value: new THREE.Vector3(0, 0, -1) },
    uDist: { value: 1e6 },
    uDCC: { value: new THREE.Vector3() },
    uNearMode: { value: 0 },
    uR: { value: R },
    uRa: { value: Ra },
    uRc: { value: Rc },
    uToBody: { value: new THREE.Matrix3() },
    uSun: { value: new THREE.Vector3(1, 0, 0) },
    uSunI: { value: 1.2 },
    uColor: { value: tex(cm) },
    uBump: { value: tex(bm, false) },
    uNight: { value: tex(nm) },
    uClouds: { value: tex(clm, false) },
    uHasNight: { value: nm ? 1 : 0 },
    uHasClouds: { value: clm ? 1 : 0 },
    uOcean: { value: look.ocean },
    uRelief: { value: look.relief },
    uHasAtmo: { value: atmo ? 1 : 0 },
    uCloudU: { value: 0 },
    uBetaR: { value: new THREE.Vector3(...(atmo?.betaR ?? [0, 0, 0])) },
    uBetaM: { value: new THREE.Vector3(...(atmo?.betaM ?? [0, 0, 0])) },
    uExtM: { value: new THREE.Vector3(...(atmo?.extM ?? [0, 0, 0])) },
    uGlowColor: { value: new THREE.Vector3(...(atmo?.glowColor ?? [0, 0, 0])) },
    uHR: { value: atmo?.H || 1 },
    uHM: { value: atmo?.HM || 1 },
    uMieG: { value: atmo?.g ?? 0.7 },
    uGlow: { value: atmo?.glow ?? 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: bodyVertex,
    fragmentShader: bodyFragment,
    side: THREE.BackSide, // the proxy's far side covers the body from outside and everything from inside
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor, // result = colour + background × transmittance
    blendSrcAlpha: THREE.ZeroFactor, // full resolution: keep the target's alpha (opaque); offscreen the alpha
    blendDstAlpha: THREE.OneFactor, //   multiplies (dst × transmittance) for the composite, see draw()
    fog: false,
  });
  // proxy shell a little outside the atmosphere top
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
  mesh.scale.setScalar(Ra * 1.02);
  mesh.name = `world-${name}`;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  return { name, mesh, uniforms, R, Ra, Rc, radius_km: RADIUS_KM[name], center_km: new THREE.Vector3(), toBody: new THREE.Matrix3(), atmo };
}

// ---------- stars and sun ----------

function createStarField(count = 6000, seed = 3) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 2 * rnd() - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos.set([Math.cos(a) * r * STAR_R, z * STAR_R, Math.sin(a) * r * STAR_R], i * 3);
    const m = rnd() ** 3; // a few bright ones
    const t = rnd();
    col.set([0.55 + 0.4 * m + 0.1 * t, 0.6 + 0.4 * m, 0.7 + 0.3 * m - 0.1 * t].map((c) => c * (0.35 + 0.65 * m)), i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthTest: false, depthWrite: false, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.name = "world-stars";
  pts.frustumCulled = false;
  pts.renderOrder = -1e9;
  return pts;
}
function createSun() {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const core = r < 0.09 ? 1 : Math.exp(-(((r - 0.09) / 0.05) ** 2));
      const glare = 0.35 * Math.exp(-r * 4.5);
      data.set([255, 248, 235, Math.round(255 * Math.min(1, core + glare) * (1 - Math.min(1, r) ** 4))], (y * n + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(3, 2.9, 2.7), blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
  sprite.name = "world-sun";
  sprite.frustumCulled = false;
  sprite.renderOrder = -1e8;
  // the disc spans ~0.53° (the core is 9 % of the sprite, so the sprite covers ~6°)
  const dist = STAR_R * 0.5;
  sprite.scale.setScalar(dist * Math.tan(0.53 * DEG) / 0.09);
  return { sprite, dist, tex };
}

// ---------- image sampling (albedo and ocean mask at a lat/lon) ----------

const pixelCache = new WeakMap();
// The map is equirectangular: u = 0 at 180° W increasing east, row 0 at the north pole. A texture image that is
// already decoded pixels ({ data, width, height }, e.g. in a node check) is read directly.
function samplePixel(tex, lat, lon) {
  const img = tex?.image;
  if (!img || !img.width || img.width < 8) return null;
  let px = pixelCache.get(img);
  if (!px && img.data) pixelCache.set(img, (px = { data: img.data, w: img.width, h: img.height }));
  if (!px && (typeof document === "undefined" || !img.complete)) return null; // not loaded yet
  if (!px) {
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    px = { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    pixelCache.set(img, px);
  }
  const x = Math.min(px.w - 1, Math.max(0, Math.floor(((lon / 360 + 0.5) % 1) * px.w)));
  const y = Math.min(px.h - 1, Math.max(0, Math.floor((0.5 - lat / 180) * px.h))); // image row 0 = north
  const i = (y * px.w + x) * 4;
  return [px.data[i] / 255, px.data[i + 1] / 255, px.data[i + 2] / 255];
}

// ---------- the world ----------

export function createWorld({ renderer = null } = {}) {
  const scene = new THREE.Scene();
  scene.name = "far";
  const camera = new THREE.PerspectiveCamera(50, 1, 0.001, STAR_R * 4);
  const bodies = { earth: createBody("earth"), moon: createBody("moon"), mars: createBody("mars") };
  for (const b of Object.values(bodies)) {
    b.mesh.layers.set(LAYER_BODIES);
    scene.add(b.mesh);
  }
  const stars = createStarField();
  const sun = createSun();
  scene.add(stars, sun.sprite);

  // Earth at the origin, oriented to the Cape; its north pole in world axes.
  const earthM = earthToBody();
  bodies.earth.toBody.copy(earthM);
  const north = new THREE.Vector3(0, 0, 1).applyMatrix3(earthM.clone().transpose()).normalize();
  // the night-launch sun: east of the Cape, below its horizon
  const sunDir = new THREE.Vector3(Math.cos(NIGHT_SUN_ELEVATION_DEG * DEG), Math.sin(NIGHT_SUN_ELEVATION_DEG * DEG), 0).normalize();
  const sunLight = new THREE.DirectionalLight(0xfff4e6, 2.4);
  sunLight.position.copy(sunDir).multiplyScalar(100);
  sunLight.name = "world-sun-light";

  // Body-fixed frame for a moon-like body: lon 0 faces Earth, north along Earth's north.
  function faceEarth(b) {
    const x = bodies.earth.center_km.clone().sub(b.center_km);
    x.addScaledVector(north, -x.dot(north)).normalize();
    if (x.lengthSq() < 1e-12) x.set(1, 0, 0);
    const y = new THREE.Vector3().crossVectors(north, x);
    b.toBody.set(x.x, x.y, x.z, y.x, y.y, y.z, north.x, north.y, north.z);
  }
  function setDestination(name, pos_km) {
    const b = bodies[name];
    if (!b || !pos_km) return;
    b.center_km.copy(pos_km);
    if (name !== "earth") faceEarth(b);
  }
  // Defaults until the timeline places them (visual: the Moon up and east of the Cape at its distance, Mars far
  // beyond it; setDestination moves either).
  setDestination("moon", new THREE.Vector3(0.55, 0.45, -0.7).normalize().multiplyScalar(MOON_DISTANCE_KM));
  setDestination("mars", new THREE.Vector3(0.4, 0.5, -0.77).normalize().multiplyScalar(8e7));

  // A landing site where the world's sun stands at lightingFor(body).sunElevation_deg: on the near side for
  // the Moon. Returns body-relative km and the local frame (+x east, +y up, +z south) as a quaternion.
  function landingSite(name) {
    const b = bodies[name];
    const el = (name === "earth" ? NIGHT_SUN_ELEVATION_DEG : lightingFor(name).sunElevation_deg) * DEG;
    let up;
    if (name === "earth") up = new THREE.Vector3(0, 1, 0);
    else {
      const ref = name === "moon" ? bodies.earth.center_km.clone().sub(b.center_km) : north.clone();
      ref.addScaledVector(sunDir, -ref.dot(sunDir));
      if (ref.lengthSq() < 1e-9) ref.set(0, 1, 0).addScaledVector(sunDir, -sunDir.y);
      ref.normalize();
      up = sunDir.clone().multiplyScalar(Math.sin(el)).addScaledVector(ref, Math.cos(el)).normalize();
    }
    return { ...surfaceFrame(name, up), pos_km: up.clone().multiplyScalar(b.radius_km) };
  }
  function surfaceFrame(name, up) {
    const b = bodies[name];
    const bn = name === "earth" ? north : new THREE.Vector3(b.toBody.elements[2], b.toBody.elements[5], b.toBody.elements[8]); // row 3 of world→body
    let east = new THREE.Vector3().crossVectors(bn, up);
    if (east.lengthSq() < 1e-9) east = new THREE.Vector3(1, 0, 0);
    east.normalize();
    const south = new THREE.Vector3().crossVectors(east, up).normalize();
    const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
    const ll = latLonOf(b.toBody, up);
    return { up, east, south, frame, lat: ll.lat, lon: ll.lon };
  }

  // UI 2's flight.js frame → world: ECI (z = Earth's axis, x = longitude 0, rotation ignored) is Earth's body-
  // fixed frame at launch, so world = earthToBodyᵀ · eci.
  const eciToWorld = earthM.clone().transpose();
  const vec = (v) => (Array.isArray(v) ? new THREE.Vector3(...v) : v.clone());
  const fromECI = (v) => vec(v).applyMatrix3(eciToWorld);
  const toECI = (v) => vec(v).applyMatrix3(earthM);
  const eciFrame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(eciToWorld));
  const setBodyECI = (name, eci_km) => setDestination(name, fromECI(eci_km));
  // The world's sun (one for all bodies): set it, or get the direction nearest the current one that stands at
  // elevation_deg over a site (body-relative km, world axes) — e.g. ease to sunForSite("moon", landingPos,
  // lightingFor("moon").sunElevation_deg) during the coast so the actual landing site gets UI 2's light.
  function setSunDir(v) {
    if (!v || vec(v).lengthSq() < 1e-12) return;
    sunDir.copy(vec(v).normalize());
    sunLight.position.copy(sunDir).multiplyScalar(100);
  }
  function sunForSite(name, pos_km, elevation_deg = lightingFor(name).sunElevation_deg) {
    const up = vec(pos_km).normalize();
    const el = elevation_deg * DEG;
    let t = sunDir.clone().addScaledVector(up, -sunDir.dot(up)); // the current sun's horizontal direction there
    if (t.lengthSq() < 1e-9) t = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x);
    t.normalize();
    return up.multiplyScalar(Math.sin(el)).addScaledVector(t, Math.cos(el)).normalize();
  }

  // Viewer: body + position (km from that body's centre, world axes) + the near camera's orientation. frame:
  // the near layer's axes → world axes (identity on the Earth pad; a landing site's frame on the Moon or Mars
  // when the near layer is built y-up there).
  const viewer = { body: "earth", pos_km: new THREE.Vector3(0, RADIUS_KM.earth + 0.002, 0), quaternion: new THREE.Quaternion(), frame: new THREE.Quaternion() };
  function setViewer({ body = viewer.body, pos_km, quaternion, camera: near, frame } = {}) {
    viewer.body = body;
    if (pos_km) viewer.pos_km.copy(pos_km);
    if (frame) viewer.frame.copy(frame);
    if (near) {
      viewer.quaternion.copy(near.quaternion);
      camera.fov = near.fov;
      camera.aspect = near.aspect;
    } else if (quaternion) viewer.quaternion.copy(quaternion);
  }
  // The viewer from an Earth-centred ECI position (flight.js pos_eci_km).
  function setViewerECI({ eci_km, ...rest } = {}) {
    setViewer({ ...rest, body: "earth", pos_km: fromECI(eci_km) });
  }
  const geo = new THREE.Vector3();
  const rel = new THREE.Vector3();
  let time0 = typeof performance !== "undefined" ? performance.now() : 0;
  function update() {
    geo.copy(bodies[viewer.body].center_km).add(viewer.pos_km); // viewer, geocentric km (doubles)
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(viewer.frame).multiply(viewer.quaternion);
    camera.near = 0.0005;
    camera.far = STAR_R * 4;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const t = ((typeof performance !== "undefined" ? performance.now() : 0) - time0) / 1000;
    const order = Object.values(bodies).map((b) => {
      rel.copy(b.center_km).sub(geo).divideScalar(KM_PER_UNIT); // camera-relative, units
      const D = rel.length();
      b.mesh.position.copy(rel);
      b.mesh.updateMatrixWorld(true);
      const u = b.uniforms;
      u.uDir.value.copy(rel).divideScalar(Math.max(D, 1e-9));
      u.uDist.value = D;
      const d2 = D * D;
      u.uDCC.value.set(d2 - b.R * b.R, d2 - b.Ra * b.Ra, d2 - b.Rc * b.Rc);
      // the exact form when close; it loses digits far away, where the cross-product form is the precise one
      if (D < b.R * 50) {
        // (D² − r²) from the km values directly: (|p| − r)(|p| + r) keeps the altitude's digits
        const pk = b.center_km.clone().sub(geo).length() / KM_PER_UNIT;
        u.uDCC.value.set((pk - b.R) * (pk + b.R), (pk - b.Ra) * (pk + b.Ra), (pk - b.Rc) * (pk + b.Rc));
        u.uNearMode.value = 1;
      } else u.uNearMode.value = 0;
      u.uToBody.value.copy(b.toBody);
      u.uSun.value.copy(sunDir);
      u.uCloudU.value = -(t * 0.0006) / (Math.PI * 2);
      return [b, D];
    });
    order.sort((a, b) => b[1] - a[1]).forEach(([b], i) => (b.mesh.renderOrder = i)); // far → near
    for (const { o, b } of attached) {
      o.position.copy(b.mesh.position);
      o.quaternion.setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(b.toBody.clone().transpose())); // body → world
    }
    stars.position.set(0, 0, 0);
    sun.sprite.position.copy(sunDir).multiplyScalar(sun.dist);
    const sky = skyAt(viewer.body, Math.max(0, viewer.pos_km.length() - bodies[viewer.body].radius_km));
    stars.material.opacity = sky.stars;
  }
  // Far-layer effects that ride with a body in its body-fixed axes (z = north, units), e.g. launchfx's aurora;
  // effects that flag userData.occluded get the body's ray constants, so what is behind the planet is hidden.
  const attached = [];
  const OCC = { uOccDir: "uDir", uOccDist: "uDist", uOccDCC: "uDCC", uOccR: "uR", uOccNear: "uNearMode" };
  function attach(name, fx) {
    const b = bodies[name];
    const o = fx?.object3d ?? fx;
    if (!b || !o) return;
    scene.add(o);
    o.traverse((m) => m.layers.set(LAYER_FX));
    if (o.userData.occluded)
      o.traverse((m) => {
        const u = m.material?.uniforms;
        if (u) for (const [k, src] of Object.entries(OCC)) if (u[k]) u[k] = b.uniforms[src];
      });
    attached.push({ o, b });
  }
  // ---- drawing: resolution scale, on/off, cost ----
  // The ray-traced bodies are the cost (atmosphere marching per pixel). At scale s < 1 they render into an
  // s × output half-float target (premultiplied colour + transmittance in alpha) composited bilinearly under the
  // stars-and-sun pass at full resolution; attached effects (aurora) draw over at full resolution.
  // setEnabled(false): nothing but a clear to clearColor (builder at home, no flight).
  let resScale = typeof window !== "undefined" && (window.devicePixelRatio ?? 1) >= 1.5 ? 0.5 : 1;
  let enabled = true;
  const clearColor = new THREE.Color(0x000000);
  const stats = { scale: resScale, width: 0, height: 0, cpuMs: 0, gpuMs: null, passes: 0, skipped: false };
  let rt = null;
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(uTex, vUv);   // colour (premultiplied) + transmittance
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const size = new THREE.Vector2();
  let timer = null;
  function setResolutionScale(s = 1) {
    resScale = THREE.MathUtils.clamp(+s || 1, 0.25, 1);
    stats.scale = resScale;
  }
  function setEnabled(on = true) {
    enabled = !!on;
  }
  const setBodyAlpha = (offscreen) => {
    for (const b of Object.values(bodies)) b.mesh.material.blendDstAlpha = offscreen ? THREE.SrcAlphaFactor : THREE.OneFactor;
  };
  // GPU time where EXT_disjoint_timer_query_webgl2 exists (one query in flight; result a frame or two later)
  function gpuTimer(r) {
    const gl = r.getContext?.();
    const ext = gl?.getExtension?.("EXT_disjoint_timer_query_webgl2");
    if (!ext) return null;
    timer ??= { ext, gl, q: null };
    if (timer.q && gl.getQueryParameter(timer.q, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(timer.q, gl.QUERY_RESULT) / 1e6;
        stats.gpuMs = stats.gpuMs === null ? ms : stats.gpuMs * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(timer.q);
      timer.q = null;
    }
    if (timer.q) return null;
    timer.q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, timer.q);
    return () => gl.endQuery(ext.TIME_ELAPSED_EXT);
  }
  function draw(r, target) {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    r.setRenderTarget(target);
    r.setClearColor(clearColor, 1);
    r.clear();
    stats.skipped = !enabled;
    if (!enabled) {
      stats.passes = 0;
      return;
    }
    update();
    const end = gpuTimer(r);
    if (target) size.set(target.width, target.height);
    else r.getDrawingBufferSize(size);
    let draws = 0;
    if (resScale < 0.999) {
      const w = Math.max(1, Math.round(size.x * resScale));
      const h = Math.max(1, Math.round(size.y * resScale));
      if (!rt || rt.width !== w || rt.height !== h) {
        rt?.dispose();
        rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
        quadMat.uniforms.uTex.value = rt.texture;
      }
      stats.width = w;
      stats.height = h;
      // bodies → the small target (clear: no colour, full transmittance)
      setBodyAlpha(true);
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
      camera.layers.set(LAYER_BODIES);
      r.render(scene, camera);
      setBodyAlpha(false);
      // stars and sun at full resolution, then the bodies over them, then attached effects
      r.setRenderTarget(target);
      camera.layers.set(LAYER_SKY);
      r.render(scene, camera);
      r.render(quadScene, quadCam);
      camera.layers.set(LAYER_FX);
      r.render(scene, camera);
      draws = 4;
    } else {
      stats.width = size.x;
      stats.height = size.y;
      camera.layers.enableAll();
      r.render(scene, camera);
      draws = 1;
    }
    camera.layers.enableAll();
    end?.();
    stats.passes = draws;
    stats.cpuMs = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
  }
  function render(r = renderer) {
    const ac = r.autoClear;
    r.autoClear = false;
    draw(r, null);
    r.clearDepth();
    r.autoClear = ac;
  }
  // For an EffectComposer (a plain object with the Pass interface): add first, then the near RenderPass with
  // clear = false and clearDepth = true.
  function createPass() {
    const pass = {
      isPass: true,
      enabled: true,
      needsSwap: false,
      clear: false,
      renderToScreen: false,
      setSize() {},
      dispose() {},
      render(r, writeBuffer, readBuffer) {
        const ac = r.autoClear;
        r.autoClear = false;
        draw(r, pass.renderToScreen ? null : readBuffer);
        r.autoClear = ac;
      },
    };
    return pass;
  }

  // Sky colours for the near layer's fog / background, at alt_km on a body (linear THREE.Colors):
  // Earth (round 17): a night sky, near-black zenith and horizon with a thin deep-blue haze band below ~30 km
  // fading to black; Mars: the dusty sky by day (planet.js skyAt); the Moon: black.
  function skyAt(name = "earth", alt_km = 0) {
    if (name === "moon") return { zenith: new THREE.Color(0, 0, 0), horizon: new THREE.Color(0, 0, 0), haze: new THREE.Color(0, 0, 0), stars: 1 };
    if (name === "mars") {
      const site = landingSite("mars");
      const local = sunDir.clone().applyQuaternion(site.frame.clone().invert());
      const s = daySkyAt(alt_km * 1000, local, "mars");
      return { ...s, haze: s.horizon.clone() };
    }
    const k = 1 - THREE.MathUtils.smoothstep(alt_km, 0, 30); // the haze band thins to nothing by ~30 km
    const haze = new THREE.Color(0.008, 0.022, 0.07).multiplyScalar(k);
    return { zenith: new THREE.Color(0.0015, 0.002, 0.005).multiplyScalar(0.3 + 0.7 * k), horizon: haze.clone(), haze, stars: 1 };
  }
  function surfaceColourAt(name, lat, lon) {
    const b = bodies[name];
    const px = samplePixel(b.uniforms.uColor.value, lat, lon);
    if (!px) return name === "mars" ? new THREE.Color(0.62, 0.36, 0.22) : name === "moon" ? new THREE.Color(0.56, 0.55, 0.53) : new THREE.Color(0.18, 0.2, 0.14);
    return new THREE.Color().setRGB(...px, THREE.SRGBColorSpace); // → linear
  }
  // Earth's topography map (earth_bump: elevation, 0 over the oceans; not the colour map) at a lat / lon:
  // true / false, or null while the map has not loaded. At 2k one pixel is ~20 km, so coastal points can go
  // either way (the Cape's pixel reads ocean).
  function isOceanAt(lat, lon) {
    const px = samplePixel(bodies.earth.uniforms.uBump.value, lat, lon);
    return px ? px[0] < 0.02 : null;
  }
  function atmosphereLimb(name) {
    const air = atmosphereFor(name);
    if (!air || air.none) return null;
    const b = bodies[name];
    return { color: new THREE.Color(air.colourHint ?? "#6fa8ff"), scaleHeight_km: air.scaleHeight_m / 1000, top_km: b.atmo.top * KM_PER_UNIT, source: air.source };
  }

  // Local ground under the vehicle, for the near layer below ~5 km: the terrain (Moon, Mars) or a ground disc /
  // the ocean (Earth), in the near layer's y-up site frame at pos_km (body-relative km), albedo from the
  // planet's texture there. place(nearOrigin_km) positions it relative to the near layer's origin (body-relative
  // km); frame: near axes → world axes (pass it to setViewer).
  // kind (Earth): "ocean" | "ground" forces the surface (e.g. "ocean" under a drone ship); otherwise the
  // topography decides, and land is assumed while the map is still loading.
  function createLocalGround({ body: name = "earth", pos_km, size_km = 0.6, seed = 7, kind: kindIn = null } = {}) {
    const b = bodies[name];
    const up = (pos_km ?? landingSite(name).pos_km).clone().normalize();
    const f = surfaceFrame(name, up);
    const surface_km = up.clone().multiplyScalar(b.radius_km);
    const tint = surfaceColourAt(name, f.lat, f.lon);
    const size_u = size_km * NEAR_U_PER_KM;
    let kind;
    let inner;
    if (name === "earth") {
      if (kindIn ? kindIn === "ocean" : isOceanAt(f.lat, f.lon) === true) {
        kind = "ocean";
        inner = createOcean({ size_u, sunDir: sunDir.clone().applyQuaternion(f.frame.clone().invert()) });
      } else {
        kind = "ground";
        const m = new THREE.Mesh(new THREE.CircleGeometry(size_u / 2, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95 }));
        m.receiveShadow = true;
        m.name = "world-local-ground";
        const g = new THREE.Group();
        g.add(m);
        inner = { object3d: g, dispose: () => (m.geometry.dispose(), m.material.dispose()) };
      }
    } else {
      kind = "terrain";
      // a little darker than the global map so the patch's own detail and shadows carry the brightness
      inner = createTerrain({ body: name, size_u, seed, padRadius_u: Math.min(2, size_u * 0.04), sunDir: sunDir.clone().applyQuaternion(f.frame.clone().invert()), tint: [tint.r * 1.1, tint.g * 1.1, tint.b * 1.1] });
    }
    const object3d = new THREE.Group();
    object3d.name = `world-local-${name}`;
    object3d.add(inner.object3d);
    const inv = f.frame.clone().invert();
    return {
      object3d,
      kind,
      inner,
      surface_km,
      lat: f.lat,
      lon: f.lon,
      up: f.up,
      frame: f.frame,
      place(nearOrigin_km) {
        object3d.position.copy(surface_km).sub(nearOrigin_km).applyQuaternion(inv).multiplyScalar(NEAR_U_PER_KM);
      },
      dispose() {
        inner.dispose?.();
        object3d.removeFromParent();
      },
    };
  }
  // A cloud deck for the near layer at alt_km above the local ground (Earth only; null elsewhere).
  function cloudDeck(name = "earth", alt_km = CLOUD_ALT_KM) {
    if (name !== "earth") return null;
    const deck = createCloudLayer({ altitude_u: alt_km * NEAR_U_PER_KM, radius_u: 30 * NEAR_U_PER_KM });
    deck.update(0, { intensity: 0.35 }); // night: faint (round 17)
    return deck;
  }
  function dispose() {
    scene.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    sun.tex.dispose();
    rt?.dispose();
    quad.geometry.dispose();
    quadMat.dispose();
  }
  return { scene, camera, bodies, sunDir, sunLight, stats, setResolutionScale, setEnabled, clearColor, setViewer, setViewerECI, setDestination, setBodyECI, fromECI, toECI, eciFrame, setSunDir, sunForSite, landingSite, skyAt, surfaceColourAt, isOceanAt, atmosphereLimb, createLocalGround, cloudDeck, attach, update, render, createPass, dispose };
}
