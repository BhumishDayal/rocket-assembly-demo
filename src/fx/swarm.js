// Nano-swarm: stateless GPU particles that pour from a source point onto a part's surface.
// Signature (kept from the fallback):
//   createSwarm({ maxCount }) -> { object3d, play({ source, targets, duration, color }), update(dt), stop(), dispose() }
// - Each particle's position is a pure function of (start, control, target, launch time, time), evaluated in the
//   vertex shader. play() does all CPU work once (surface sampling + attribute upload); update(dt) only writes a uniform.
// - Targets are sampled in WORLD space with MeshSurfaceSampler (area-weighted across meshes, InstancedMesh aware).
// - Landing order follows height: the lowest surface points land first, the highest last, the last at `duration`.
//   Particles need flight time, so landings span [0.4·duration, duration] (flight clamped to 0.3–0.9 s).
//   The extra read-only field `timing` = { firstLanding, lastLanding } (seconds after play) is set on every play()
//   so a reveal sweep can be aligned exactly (sweep the cut from bottom to top over that window).
// - Flight: quadratic arc (start -> lifted control point -> target) plus a divergence-free swirl that is zero at
//   launch and landing; particles fade in, glow in flight, and fade out as they land.
// - Size is in world units derived from the targets' bounds and converted to pixels with the real drawing-buffer
//   height (so it is DPR-correct). Additive, depthWrite off, depthTest on (the rocket occludes particles behind it).
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";

const vertexShader = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aControl;
  attribute float aLaunch;   // seconds after play() when this particle leaves the source
  attribute float aSeed;
  uniform float uTime;
  uniform float uFlight;     // seconds of flight per particle
  uniform float uSize;       // world-space diameter
  uniform float uViewportH;  // drawing-buffer height in pixels
  uniform float uSwirl;      // world-space swirl amplitude
  varying float vAlpha;
  varying float vHeat;

  // Analytic curl of a sum of sines: divergence-free, cheap, smooth.
  vec3 swirlField(vec3 p, float t) {
    vec3 a = vec3(sin(p.y * 1.3 + t * 1.7), sin(p.z * 1.1 + t * 1.3), sin(p.x * 1.7 + t * 1.1));
    vec3 b = vec3(cos(p.z * 2.3 - t * 2.1), cos(p.x * 2.9 - t * 1.9), cos(p.y * 2.1 - t * 2.3));
    return vec3(a.x - b.y, a.y - b.z, a.z - b.x);
  }

  void main() {
    float p = clamp((uTime - aLaunch) / uFlight, 0.0, 1.0);
    float e = p * p * (3.0 - 2.0 * p);                       // smoothstep ease
    vec3 target = position;
    vec3 q0 = mix(aStart, aControl, e);
    vec3 q1 = mix(aControl, target, e);
    vec3 pos = mix(q0, q1, e);                                // quadratic Bezier
    float swirlEnv = sin(3.14159265 * e);                     // 0 at launch and landing
    pos += swirlField(pos * 0.9 + aSeed * 7.0, uTime + aSeed * 3.0) * uSwirl * swirlEnv;

    float alive = step(0.0001, uTime - aLaunch) * (1.0 - step(1.0, p));
    vAlpha = alive * smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.82, 1.0, p));
    vHeat = smoothstep(0.6, 1.0, p);                          // hotter (whiter) just before landing

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float pixels = uSize * projectionMatrix[1][1] * 0.5 * uViewportH / max(-mv.z, 0.001);
    gl_PointSize = clamp(pixels * (0.75 + 0.5 * fract(aSeed * 13.7)), 1.0, 24.0) * (alive > 0.5 ? 1.0 : 0.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vHeat;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float glow = exp(-d2 * 14.0);
    float core = exp(-d2 * 60.0);
    vec3 col = uColor * glow * 1.1 + vec3(1.0) * core * (0.35 + 0.65 * vHeat);
    gl_FragColor = vec4(col * vAlpha, vAlpha * glow);
    #include <colorspace_fragment>
  }
`;

const samplerCache = new WeakMap(); // geometry -> { sampler, area }

function samplerFor(mesh) {
  let entry = samplerCache.get(mesh.geometry);
  if (!entry) {
    const sampler = new MeshSurfaceSampler(new THREE.Mesh(mesh.geometry)).build();
    const dist = sampler.distribution;
    entry = { sampler, area: dist && dist.length ? dist[dist.length - 1] : 0 };
    samplerCache.set(mesh.geometry, entry);
  }
  return entry;
}

export function createSwarm({ maxCount = 12000 } = {}) {
  const count = Math.max(1, Math.floor(maxCount));
  const geometry = new THREE.BufferGeometry();
  const target = new Float32Array(count * 3);
  const start = new Float32Array(count * 3);
  const control = new Float32Array(count * 3);
  const launch = new Float32Array(count);
  const seed = new Float32Array(count);
  const attr = (array, size) => new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attr(target, 3));
  geometry.setAttribute("aStart", attr(start, 3));
  geometry.setAttribute("aControl", attr(control, 3));
  geometry.setAttribute("aLaunch", attr(launch, 1));
  geometry.setAttribute("aSeed", attr(seed, 1));
  geometry.setDrawRange(0, 0);

  const uniforms = {
    uTime: { value: 0 },
    uFlight: { value: 0.6 },
    uSize: { value: 0.04 },
    uViewportH: { value: 1080 },
    uSwirl: { value: 0.4 },
    uColor: { value: new THREE.Color(0x5cc8ff) },
  };
  const material = new THREE.ShaderMaterial({
    name: "SwarmMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 10;
  const bufferSize = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(bufferSize);
    uniforms.uViewportH.value = bufferSize.y;
  };

  let time = 0;
  let endTime = 0;
  const tmpPos = new THREE.Vector3();
  const tmpMatrix = new THREE.Matrix4();
  const instMatrix = new THREE.Matrix4();
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const api = {
    object3d: points,
    timing: { firstLanding: 0, lastLanding: 0 },

    play({ source, targets, duration = 1.2, color = 0x5cc8ff } = {}) {
      const meshes = (Array.isArray(targets) ? targets : [targets]).filter((m) => m && m.isMesh && m.geometry);
      if (!meshes.length || !source) return;

      // Area weights in world units (approximate scale^2 from the world matrix).
      box.makeEmpty();
      const weights = meshes.map((mesh) => {
        mesh.updateWorldMatrix(true, false);
        const instances = mesh.isInstancedMesh ? mesh.count : 1;
        const s = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (mesh.isInstancedMesh) {
          if (!mesh.boundingBox) mesh.computeBoundingBox();
          meshBox.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
        } else {
          meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        }
        box.union(meshBox);
        return samplerFor(mesh).area * Math.abs(s.x * s.y + s.y * s.z + s.z * s.x) / 3 * instances;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
      box.getSize(size);
      box.getCenter(center);
      const height = Math.max(size.y, 1e-3);
      const extent = Math.max(size.x, size.y, size.z, 1e-3);

      // Sample targets.
      let k = 0;
      meshes.forEach((mesh, mi) => {
        const n = mi === meshes.length - 1 ? count - k : Math.round((count * weights[mi]) / totalWeight);
        const { sampler } = samplerFor(mesh);
        for (let j = 0; j < n && k < count; j++, k++) {
          sampler.sample(tmpPos);
          if (mesh.isInstancedMesh) {
            mesh.getMatrixAt(Math.floor(Math.random() * mesh.count), instMatrix);
            tmpMatrix.multiplyMatrices(mesh.matrixWorld, instMatrix);
            tmpPos.applyMatrix4(tmpMatrix);
          } else {
            tmpPos.applyMatrix4(mesh.matrixWorld);
          }
          target[k * 3] = tmpPos.x;
          target[k * 3 + 1] = tmpPos.y;
          target[k * 3 + 2] = tmpPos.z;
        }
      });
      const used = k;

      // Timing: the lowest points land at `flight`, the highest at `duration`.
      const flight = THREE.MathUtils.clamp(duration * 0.4, 0.3, 0.9);
      const spread = Math.max(duration - flight, 0.05);
      const sourceRadius = Math.max(extent * 0.08, 0.05);
      for (let i = 0; i < used; i++) {
        const tx = target[i * 3], ty = target[i * 3 + 1], tz = target[i * 3 + 2];
        const order = THREE.MathUtils.clamp((ty - box.min.y) / height + (Math.random() - 0.5) * 0.04, 0, 1);
        launch[i] = order * spread;
        seed[i] = Math.random();

        // Born in a small sphere around the source.
        dir.randomDirection().multiplyScalar(sourceRadius * Math.cbrt(Math.random()));
        const sx = source.x + dir.x, sy = source.y + dir.y, sz = source.z + dir.z;
        start[i * 3] = sx;
        start[i * 3 + 1] = sy;
        start[i * 3 + 2] = sz;

        // Control point: midpoint pushed outward from the part's axis and lifted, so streams arc around the part.
        const mx = (sx + tx) * 0.5, my = (sy + ty) * 0.5, mz = (sz + tz) * 0.5;
        dir.set(tx - center.x, 0, tz - center.z);
        if (dir.lengthSq() < 1e-6) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize().multiplyScalar(extent * (0.25 + 0.35 * Math.random()));
        control[i * 3] = mx + dir.x;
        control[i * 3 + 1] = my + extent * (0.1 + 0.25 * Math.random());
        control[i * 3 + 2] = mz + dir.z;
      }
      for (const name of ["position", "aStart", "aControl", "aLaunch", "aSeed"]) {
        const a = geometry.getAttribute(name);
        a.clearUpdateRanges();
        a.addUpdateRange(0, used * a.itemSize);
        a.needsUpdate = true;
      }
      geometry.setDrawRange(0, used);

      uniforms.uFlight.value = flight;
      // Size from the part's overall extent, with a floor so short parts (an engine cluster ~1 unit tall)
      // still read at a 20-30 unit camera distance.
      uniforms.uSize.value = THREE.MathUtils.clamp(Math.max(height, extent * 0.8) * 0.012, 0.05, 0.085);
      uniforms.uSwirl.value = extent * 0.06;
      uniforms.uColor.value.set(color);
      time = 0;
      uniforms.uTime.value = 0;
      endTime = spread + flight + 0.05;
      api.timing.firstLanding = flight;
      api.timing.lastLanding = flight + spread;
      points.visible = true;
    },

    update(dt) {
      if (!points.visible) return;
      time += dt;
      uniforms.uTime.value = time;
      if (time > endTime) points.visible = false;
    },

    stop() {
      points.visible = false;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
  return api;
}
