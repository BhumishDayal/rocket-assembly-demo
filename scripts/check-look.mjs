// Check for the two looks in src/parts.js (round 15): every piece of every preset carries a painted and an
// x-ray material of its own; painted is the default; painted shells are clear-coated MeshPhysicalMaterial
// (clearcoat 0.4, roughness 0.35-0.5 with a micro-roughness map) or composite with a weave normal; bells are
// bare metal with anisotropy; setShellOpacity ≥ 0.9 shows paint with lines at 0.15 / 0.55 of their base, below
// it the x-ray shells at that opacity with lines back at base; soot only near the base; no NaN.
// Run: node scripts/check-look.mjs   (no deps; exits 1 on any failure)
import { registerHooks } from "node:module";

// catalog.js imports JSON the Vite way (no import attributes); teach node to load those as JSON.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    return r.url.endsWith(".json") ? { ...r, importAttributes: { ...r.importAttributes, type: "json" } } : r;
  },
});
const THREE = await import("three");
const { catalog, presetToBuild } = await import("../src/data/catalog.js");
const { buildManifest } = await import("../src/layout.js");
const { createMaterials, createPart, setShellOpacity, setBellGlow, shellPieces, LOOK } = await import("../src/parts.js");

const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};
expect(LOOK === "xray", `LOOK ${LOOK}: choreo switches looks only when it is "xray"`);
const near = (a, b) => Math.abs(a - b) < 1e-9;
let meshes = 0;
let sooty = 0;
for (const preset of catalog.presets) {
  const mats = createMaterials();
  const seen = new Set();
  for (const spec of buildManifest(presetToBuild(preset), catalog)) {
    const part = createPart(spec, mats);
    const id = `${preset.id}/${spec.id}`;
    for (const p of part.pieces) {
      meshes++;
      const looks = p.mesh.userData.looks;
      if (!looks) {
        failures.push(`${id}: ${p.mesh.name} has no painted look`);
        continue;
      }
      expect(p.mesh.material === looks.painted, `${id}: ${p.mesh.name} should start painted`);
      for (const m of [looks.painted, looks.xray]) {
        expect(!seen.has(m), `${id}: ${p.mesh.name} shares a material`);
        seen.add(m);
      }
      const m = looks.painted;
      expect(!m.transparent && m.depthWrite !== false, `${id}: ${p.mesh.name} paint should be opaque`);
      if (m.userData.soot) {
        // paint or composite (clear coat ≥ 0.4), or bare sprayed foam (matte, no coat)
        const isPaint = m.isMeshPhysicalMaterial && ((m.clearcoat >= 0.4 && ((m.roughness >= 0.35 && m.roughness <= 0.5 && m.roughnessMap) || m.normalMap)) || (m.map && m.roughness > 0.8));
        expect(isPaint, `${id}: ${p.mesh.name} painted shell material (clearcoat ${m.clearcoat}, roughness ${m.roughness})`);
        const s = m.soot?.value;
        expect(s && [s.x, s.y, s.z, s.w].every(Number.isFinite) && s.y > 0, `${id}: ${p.mesh.name} soot uniform`);
        if (s?.z > 0) sooty++;
        expect(!(s?.z > 0) || spec.kind === "engines" || (spec.kind === "tank" && spec.stageIndex === 0), `${id}: soot away from the base`);
      }
      if (p.mesh.userData.role === "engine") expect(m.anisotropy > 0 && m.roughnessMap && m.metalness === 1, `${id}: bell should be brushed metal`);
      for (const lm of [looks.painted, looks.xray]) if (lm.vertexColors) expect(p.mesh.geometry.attributes.color, `${id}: ${p.mesh.name} reads vertex colours it does not have (renders black)`);
    }
    // Bell glow: every bell piece of an engines part has one uniform shared by both looks, lip below throat;
    // setBellGlow sets it (clamped), per engine or all.
    const bells = part.pieces.filter((p) => p.mesh.userData.bellGlow);
    if (spec.kind === "engines") {
      expect(bells.length >= spec.count, `${id}: ${bells.length} bell pieces for ${spec.count} engines`);
      for (const p of bells) {
        const g = p.mesh.userData.bellGlow;
        const { painted, xray } = p.mesh.userData.looks;
        expect(painted.glow === g && xray.glow === g && g.value.x < g.value.y, `${id}: ${p.mesh.name} glow uniform`);
      }
      setBellGlow(part, 1.7);
      expect(bells.every((p) => p.mesh.userData.bellGlow.value.z === 1), `${id}: setBellGlow(1.7) should clamp to 1`);
      setBellGlow(part, 0.4, bells[0].engine);
      expect(bells.every((p) => p.mesh.userData.bellGlow.value.z === (p.engine === bells[0].engine ? 0.4 : 1)), `${id}: setBellGlow per engine`);
      setBellGlow(part, 0);
    } else expect(bells.length === 0, `${id}: bell glow outside the engines`);
    // Frost: painted tank skins only; kerolox above ~55 % of the tank, hydrolox all over; never in x-ray.
    const prop = spec.kind === "tank" ? spec.record?.propellant : null;
    for (const p of part.pieces) {
      const f = p.mesh.userData.looks?.painted.frost?.value;
      const want = (prop === "kerolox" || prop === "hydrolox") && p.kind === "shell" && p.mesh.userData.looks?.painted.userData.soot;
      expect(!!(f && f.z > 0) === !!want, `${id}: ${p.mesh.name} frost ${f?.z} (${prop})`);
      if (want && f) {
        const edge = f.x + p.mesh.position.y;
        expect(prop === "kerolox" ? Math.abs(edge - 0.55 * spec.height) < 1e-9 : edge < 0, `${id}: frost edge ${edge}`);
        expect(!p.mesh.userData.looks.xray.frost, `${id}: frost in the x-ray look`);
      }
    }
    // Clear: x-ray shells at the value, lines at base. Opaque: paint, lines at 0.15 / 0.55 of base.
    setShellOpacity(part, 0.18);
    for (const p of part.pieces) {
      expect(p.mesh.material === p.mesh.userData.looks.xray, `${id}: ${p.mesh.name} should be x-ray at 0.18`);
      for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine].filter(Boolean)) expect(near(e.userData.base, e.userData.base0), `${id}: line base not restored`);
    }
    for (const p of shellPieces(part)) {
      const m = p.mesh.material;
      expect(m.transparent && near(m.opacity, Math.min(1, 0.18 * (m.userData.opacityScale ?? 1))), `${id}: ${p.mesh.name} x-ray opacity ${m.opacity}`);
    }
    setShellOpacity(part, 0.92);
    for (const p of part.pieces) {
      expect(p.mesh.material === p.mesh.userData.looks.painted, `${id}: ${p.mesh.name} should be painted at 0.92`);
      for (const e of [p.mesh.userData.edges, p.mesh.userData.edgesFine].filter(Boolean)) {
        expect(near(e.userData.base, (e.userData.base0 * 0.15) / 0.55) && near(e.material.opacity, e.userData.base), `${id}: painted line opacity ${e.material.opacity}`);
      }
    }
    // The emissive of a material switched out is restored (no stuck highlight).
    const shell = shellPieces(part)[0];
    if (shell) {
      shell.mesh.material.emissive?.setRGB(1, 0, 0);
      setShellOpacity(part, 0.3);
      setShellOpacity(part, 0.92);
      const e = shell.mesh.material.emissive;
      expect(!e || e.getHex() === shell.mesh.material.userData.emissive0[0], `${id}: emissive stuck after a look switch`);
    }
  }
}
expect(sooty > 0, "no soot anywhere");
console.log(`looks checked: ${catalog.presets.length} presets, ${meshes} pieces, ${sooty} sooty`);
if (failures.length) {
  console.log(`FAIL (${failures.length})\n  ` + failures.slice(0, 30).join("\n  "));
  process.exitCode = 1;
} else console.log("PASS");
