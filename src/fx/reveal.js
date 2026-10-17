// "Crystallize" reveal: the part sweeps from nothing to solid along object-space Y with a glowing cut edge.
// Signature (kept from the fallback):
//   makeRevealable(mesh, { edgeColor, edgeWidth }) -> { setActive(bool), setCut(localY), dispose() }
// Semantics (object space of `mesh`, i.e. geometry coordinates):
//   - while active, fragments with position.y > cut (plus a little noise) are discarded;
//   - the band of height `edgeWidth` just below the cut glows `edgeColor` (emissive, well above a 0.85 bloom
//     threshold), with a white-hot core at the cut and a faint crystal grid fading out further below;
//   - while active the material is double-sided, so the inside of the cut reads as a dim glowing cross-section;
//   - the shadow is cut too (customDepthMaterial), so a half-built part doesn't cast a whole shadow;
//   - PBR lighting of the original MeshStandardMaterial is untouched (patched via onBeforeCompile);
//   - when inactive, the original material hooks are restored, so rendering costs nothing extra.
// Each toggle swaps the program (three caches both after first use). Call renderer.compile(scene, camera)
// once with a part active to pre-warm the patched program if a first-use hitch matters.
//
// Cut-line idea after OtanoStudio/Burn-Dissolve (Apache-2.0, https://github.com/OtanoStudio/Burn-Dissolve);
// no code copied from it. Noise: 3D simplex by Ian McEwan / Ashima Arts, MIT License,
// https://github.com/ashima/webgl-noise (Copyright (C) 2011 Ashima Arts).
import * as THREE from "three";

const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
const EDGE_INTENSITY = 5.0; // multiplier on edgeColor; with bloom threshold ~0.85 this blooms clearly

const NOISE_GLSL = /* glsl */ `
  vec3 revealMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 revealMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 revealPermute(vec4 x) { return revealMod289(((x * 34.0) + 10.0) * x); }
  vec4 revealTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float revealSnoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = revealMod289(i);
    vec4 p = revealPermute(revealPermute(revealPermute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = revealTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

const FRAG_PARS = /* glsl */ `
  uniform float uRevealCut;
  uniform float uRevealEdgeWidth;
  uniform float uRevealNoiseFreq;
  uniform float uRevealNoiseAmp;
  uniform float uRevealGridFreq;
  uniform vec3 uRevealEdgeColor;
  varying vec3 vRevealPos;
  ${NOISE_GLSL}
`;

// Shared by the colour and the depth (shadow) pass: discard above the noisy cut, compute the edge factor.
const FRAG_CUT = /* glsl */ `
  float revealNoise = revealSnoise(vRevealPos * uRevealNoiseFreq) * 0.7
                    + revealSnoise(vRevealPos * uRevealNoiseFreq * 2.7 + 11.3) * 0.3;
  float revealBelow = uRevealCut + revealNoise * uRevealNoiseAmp - vRevealPos.y; // > 0 means visible
  if (revealBelow < 0.0) discard;
  float revealEdge = 1.0 - smoothstep(0.0, uRevealEdgeWidth, revealBelow);
`;

const FRAG_GLOW = /* glsl */ `
  {
    float hot = pow(revealEdge, 5.0);
    // Crystal grid: thin lines of a 3D lattice, visible in a band ~4 edge widths below the cut.
    float gridBand = 1.0 - smoothstep(uRevealEdgeWidth, uRevealEdgeWidth * 4.0, revealBelow);
    vec3 cell = abs(fract(vRevealPos * uRevealGridFreq) - 0.5);
    float gridLine = 1.0 - smoothstep(0.03, 0.11, min(min(cell.x, cell.y), cell.z));
    totalEmissiveRadiance += uRevealEdgeColor * (revealEdge + gridLine * gridBand * 0.3)
                           + vec3(hot * 1.0);
    if (!gl_FrontFacing) totalEmissiveRadiance += uRevealEdgeColor * 0.05; // inside of the open cut
  }
`;

function patchShader(shader, uniforms, withGlow) {
  for (const key in uniforms) shader.uniforms[key] = uniforms[key]; // shared refs: setCut() just writes .value
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vRevealPos;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRevealPos = transformed;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\n" + FRAG_PARS)
    .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + FRAG_CUT);
  if (withGlow) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n" + FRAG_GLOW,
    );
  }
}

export function makeRevealable(mesh, { edgeColor = 0x5cc8ff, edgeWidth = 0.1 } = {}) {
  const material = mesh.material;
  const width = Math.max(edgeWidth, 1e-4);
  const uniforms = {
    uRevealCut: { value: 0 },
    uRevealEdgeWidth: { value: width },
    uRevealNoiseFreq: { value: 0.55 / width }, // noise features ~2 edge widths across
    uRevealNoiseAmp: { value: width * 1.4 },   // visibly jagged, burn-like cut line
    uRevealGridFreq: { value: 0.4 / width },   // lattice cells ~2.5 edge widths
    uRevealEdgeColor: { value: new THREE.Color(edgeColor).multiplyScalar(EDGE_INTENSITY) },
  };

  const original = {
    onBeforeCompile: material.onBeforeCompile,
    customProgramCacheKey: material.customProgramCacheKey,
    side: material.side,
    shadowSide: material.shadowSide,
    customDepthMaterial: mesh.customDepthMaterial,
  };

  const onBeforeCompile = (shader, renderer) => {
    original.onBeforeCompile.call(material, shader, renderer);
    patchShader(shader, uniforms, true);
  };
  const cacheKey = () => "fx-reveal-v1|" + original.customProgramCacheKey.call(material);

  // Shadow pass: same cut, no glow. Only built if the mesh casts shadows.
  let depthMaterial = null;
  if (mesh.castShadow) {
    depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depthMaterial.onBeforeCompile = (shader) => patchShader(shader, uniforms, false);
    depthMaterial.customProgramCacheKey = () => "fx-reveal-depth-v1";
  }

  let active = false;
  return {
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      if (on) {
        material.onBeforeCompile = onBeforeCompile;
        material.customProgramCacheKey = cacheKey;
        // Double-sided so the open cut shows its inside, but keep the shadow pass on the faces it used before
        // (three renders back faces of FrontSide materials into the shadow map); otherwise: shadow acne.
        if (original.shadowSide === null) material.shadowSide = SHADOW_SIDE[original.side];
        material.side = THREE.DoubleSide;
        if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
      } else {
        material.onBeforeCompile = original.onBeforeCompile;
        material.customProgramCacheKey = original.customProgramCacheKey;
        material.side = original.side;
        material.shadowSide = original.shadowSide;
        mesh.customDepthMaterial = original.customDepthMaterial;
      }
      material.needsUpdate = true;
    },
    setCut(localY) {
      uniforms.uRevealCut.value = localY;
    },
    dispose() {
      if (active) this.setActive(false);
      if (depthMaterial) depthMaterial.dispose();
    },
  };
}
