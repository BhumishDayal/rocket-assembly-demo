// Hologram material for ghost previews and in-flight pieces.
// Signature (kept from the fallback):
//   createHologramMaterial({ color, opacity }) -> { material, update(timeSeconds), setOpacity(0..1), setColor(c), dispose() }
// One ShaderMaterial is shared by every mesh of a part. All setters only touch uniforms, so they never recompile.
// Look: view-angle fresnel rim, world-space scanlines (continuous across pieces), a slow bright scan band
// travelling upward, and a subtle flicker. Additive, transparent, depthWrite off, double-sided.
// Approach after ektogamat/threejs-holographic-material (MIT, Anderson Mancini); shader written from scratch here.
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec4 local = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 world = modelMatrix * local;
    vWorldPos = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uScanDensity;   // radians per pixel row (about 1 line every 4 px)
  uniform float uBandPeriod;    // world units between upward-travelling bright bands
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 n = normalize(vWorldNormal);
    float facing = abs(dot(n, viewDir));                 // abs(): back faces read as rims too
    float fresnel = pow(1.0 - facing, 2.2);

    // Fine scanlines drifting downward, in screen space so they look the same at any scene scale
    // and line up across all pieces of a part.
    float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * uScanDensity + uTime * 6.0);
    scan = smoothstep(0.35, 1.0, scan);

    // A soft bright band sweeping upward (the "signal").
    float band = fract(vWorldPos.y / uBandPeriod - uTime * 0.35);
    band = smoothstep(0.0, 0.08, band) * (1.0 - smoothstep(0.08, 0.22, band));

    // Flicker: two incommensurate sines plus a rare short dropout.
    float flicker = 0.93 + 0.05 * sin(uTime * 37.0) + 0.03 * sin(uTime * 113.0);
    float dropout = step(0.985, hash11(floor(uTime * 24.0)));
    flicker *= 1.0 - 0.45 * dropout;

    float body = 0.10 + 0.22 * scan;                     // faint fill so the shape reads
    float rim = fresnel * 1.35;                           // bright edge, can exceed 1 to catch bloom
    float intensity = (body + rim + band * 0.55) * flicker;

    vec3 col = uColor * intensity + vec3(1.0) * pow(fresnel, 4.0) * 0.25;
    float alpha = clamp(intensity, 0.0, 1.0) * uOpacity;
    gl_FragColor = vec4(col * uOpacity, alpha);
    #include <colorspace_fragment>
  }
`;

// Optional extra option (signature-compatible): bandPeriod = world units between the bright upward bands.
// Default 4 suits a rocket a few tens of units tall; pass about a tenth of the rocket height for other scales.
export function createHologramMaterial({ color = 0x5cc8ff, opacity = 0.45, bandPeriod = 4 } = {}) {
  const baseOpacity = opacity;
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: baseOpacity },
    uTime: { value: 0 },
    uScanDensity: { value: 1.55 },
    uBandPeriod: { value: bandPeriod },
  };
  const material = new THREE.ShaderMaterial({
    name: "HologramMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
    lights: false,
  });
  return {
    material,
    update(timeSeconds) {
      uniforms.uTime.value = timeSeconds;
    },
    setOpacity(v) {
      uniforms.uOpacity.value = baseOpacity * THREE.MathUtils.clamp(v, 0, 1);
    },
    setColor(c) {
      uniforms.uColor.value.set(c);
    },
    dispose() {
      material.dispose();
    },
  };
}
