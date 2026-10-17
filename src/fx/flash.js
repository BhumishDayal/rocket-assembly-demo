// Lock flash: a one-shot burst at the joint when a part locks in.
// Signature (kept from the fallback):
//   createBoltFlash() -> { object3d, fire({ position, radius, color }), update(dt), dispose() }
// fire(): white-hot core flare + a ring of 12 spark sprites that slide outward + a thin expanding shock ring,
// all additive, toneMapped off and brighter than 1 so bloom picks them up; ~280 ms. Safe to fire rapidly
// (each burst owns its own materials; geometry and the glow texture are shared). Adds no lights, so it never
// triggers a shader recompile of the scene.
import * as THREE from "three";

const LIFE = 0.28;
const SPARKS = 12;

function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createBoltFlash() {
  const object3d = new THREE.Group();
  object3d.renderOrder = 11;
  const texture = makeGlowTexture();
  const ringGeometry = new THREE.RingGeometry(0.94, 1, 64);
  const live = [];

  const additive = (params) =>
    Object.assign(params, {
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

  return {
    object3d,

    fire({ position, radius = 1, color = 0x9fdcff }) {
      const tint = new THREE.Color(color);
      const group = new THREE.Group();
      group.position.copy(position);

      const coreMat = new THREE.SpriteMaterial(additive({ map: texture, color: new THREE.Color(1, 1, 1).multiplyScalar(2.2) }));
      const core = new THREE.Sprite(coreMat);
      group.add(core);

      const sparkMat = new THREE.SpriteMaterial(additive({ map: texture, color: tint.clone().multiplyScalar(2.6) }));
      const sparks = [];
      const phase = Math.random() * Math.PI * 2;
      for (let i = 0; i < SPARKS; i++) {
        const s = new THREE.Sprite(sparkMat);
        s.userData.angle = phase + (i / SPARKS) * Math.PI * 2;
        group.add(s);
        sparks.push(s);
      }

      const ringMat = new THREE.MeshBasicMaterial(additive({ color: tint.clone().multiplyScalar(1.8), side: THREE.DoubleSide }));
      const ring = new THREE.Mesh(ringGeometry, ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);

      object3d.add(group);
      live.push({ group, core, sparks, ring, mats: [coreMat, sparkMat, ringMat], age: 0, radius });
    },

    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const b = live[i];
        b.age += dt;
        const k = Math.min(b.age / LIFE, 1);
        const out = 1 - Math.pow(1 - k, 3); // easeOutCubic
        const fade = (1 - k) * (1 - k);
        const r = b.radius;

        // Core: pops big immediately, shrinks while fading.
        b.core.scale.setScalar(r * (1.6 - 0.9 * out));
        b.mats[0].opacity = Math.min(1, 1.6 * (1 - k)) * (k < 0.06 ? k / 0.06 : 1);

        // Sparks slide from just inside the rim to well outside it.
        const sr = r * (0.95 + 0.55 * out);
        for (const s of b.sparks) {
          const a = s.userData.angle;
          s.position.set(Math.cos(a) * sr, 0, Math.sin(a) * sr);
          s.scale.setScalar(r * 0.28 * (1 - 0.5 * k));
        }
        b.mats[1].opacity = fade;

        // Shock ring expands fastest.
        b.ring.scale.setScalar(r * (0.9 + 0.9 * out));
        b.mats[2].opacity = 0.9 * fade;

        if (k >= 1) {
          object3d.remove(b.group);
          b.mats.forEach((m) => m.dispose());
          live.splice(i, 1);
        }
      }
    },

    dispose() {
      for (const b of live) {
        object3d.remove(b.group);
        b.mats.forEach((m) => m.dispose());
      }
      live.length = 0;
      ringGeometry.dispose();
      texture.dispose();
    },
  };
}
