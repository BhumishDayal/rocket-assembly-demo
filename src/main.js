import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { PART_DEFS, createMaterials, createPart, createPad, createStars } from "./parts.js";
import { createChoreographer } from "./choreo.js";
import { createSfx } from "./fx/sfx.js";

const query = new URLSearchParams(location.search);
const lite = query.get("lite") === "1";

// ---------- renderer / scene ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lite, powerPreference: "high-performance" });
renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = !lite;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
scene.fog = new THREE.Fog(0x0b0d12, 45, 130);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 400);
camera.position.set(9.5, 6.8, 14.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 2.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = 6;
controls.maxDistance = 70;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(9, 18, 11);
key.target.position.set(0, 6, 0);
key.castShadow = !lite;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -13;
key.shadow.camera.right = key.shadow.camera.top = 13;
key.shadow.camera.near = 1;
key.shadow.camera.far = 60;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x7fb6ff, 1.1);
rim.position.set(-12, 9, -9);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x8fa6c8, 0x0f1118, 0.45));

const root = new THREE.Group(); // shakes on lock
scene.add(root);
const pad = createPad();
root.add(pad.group);
scene.add(createStars());

// ---------- parts ----------
const materials = createMaterials();
const parts = PART_DEFS.map((def) => createPart(def, materials));
const sfx = createSfx();
const choreo = createChoreographer({ parts, scene, root, camera, controls, sfx, onChange: syncUi });

// ---------- post ----------
let composer = null;
if (!lite) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.36, 0.55, 0.9));
  composer.addPass(new OutputPass());
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// ---------- UI ----------
const ICONS = {
  engine: '<svg viewBox="0 0 24 24"><path d="M9.5 3h5v4.5l3.5 11h-12l3.5-11z"/><path d="M8 3h8"/></svg>',
  tank: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="4"/><path d="M7 9h10M7 15h10"/></svg>',
  ring: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="7" rx="7" ry="2.5"/><path d="M5 7v10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7"/><path d="M9 9.2v9M15 9.2v9"/></svg>',
  nose: '<svg viewBox="0 0 24 24"><path d="M12 2c4 3.8 5 9 5 15H7c0-6 1-11.2 5-15z"/><path d="M7 17h10v3H7z"/><path d="M12 8v6"/></svg>',
};

const partsEl = document.getElementById("parts");
const cards = new Map();
for (const part of parts) {
  const el = document.createElement("button");
  el.className = "card";
  el.type = "button";
  el.dataset.id = part.id;
  el.innerHTML = `<span class="icon">${ICONS[part.icon]}</span><span><span class="name">${part.name}</span><span class="sub">${part.sub}</span></span><span class="key">${part.key}</span>`;
  el.addEventListener("click", () => onCard(part));
  el.addEventListener("pointerenter", () => {
    choreo.setGhost(part, true);
    if (choreo.canBuild(part)) sfx.play("ui", { gain: 0.5 });
  });
  el.addEventListener("pointerleave", () => choreo.setGhost(part, false));
  partsEl.appendChild(el);
  cards.set(part.id, el);
}

function onCard(part) {
  if (part.built) {
    if (choreo.isTopBuilt(part)) choreo.remove(part);
    else nudge(cards.get(part.id));
  } else if (choreo.canBuild(part)) {
    choreo.build(part);
  } else {
    nudge(cards.get(part.id));
  }
}

function nudge(el) {
  el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(0)" }], {
    duration: 240,
    easing: "ease-out",
  });
}

const btnBuildAll = document.getElementById("btn-build-all");
const btnExplode = document.getElementById("btn-explode");
const btnReset = document.getElementById("btn-reset");
const btnSound = document.getElementById("btn-sound");
const hudText = document.getElementById("hud-text");

btnBuildAll.addEventListener("click", () => choreo.buildAll());
btnExplode.addEventListener("click", () => choreo.toggleExplode());
btnReset.addEventListener("click", () => choreo.reset());
btnSound.addEventListener("click", () => {
  sfx.setMuted(!sfx.muted);
  btnSound.textContent = sfx.muted ? "Sound off" : "Sound on";
  btnSound.setAttribute("aria-pressed", String(!sfx.muted));
});

function syncUi() {
  const { busy, exploded } = choreo.state;
  for (const part of parts) {
    const el = cards.get(part.id);
    el.classList.toggle("built", part.built);
    el.classList.toggle("building", part.busy);
    const locked = exploded || busy > 0 ? !part.busy : !(part.built ? choreo.isTopBuilt(part) : choreo.canBuild(part));
    el.classList.toggle("locked", locked && !part.busy);
    el.querySelector(".key").textContent = part.built ? (choreo.isTopBuilt(part) ? "↺" : "✓") : part.key;
    el.title = part.built ? (choreo.isTopBuilt(part) ? "Click to remove" : "Built") : choreo.canBuild(part) ? "Click to build" : "Build the part below first";
  }
  const built = parts.filter((p) => p.built).length;
  const top = choreo.topY();
  btnExplode.disabled = built === 0 || (busy > 0 && !exploded);
  btnExplode.textContent = exploded ? "Assemble" : "Explode";
  btnExplode.classList.toggle("on", exploded);
  btnBuildAll.disabled = built === parts.length || busy > 0 || exploded;
  hudText.innerHTML =
    built === 0
      ? "Pad ready"
      : `<strong>${built}/${parts.length}</strong> parts · height <strong>${top.toFixed(1)}</strong>${exploded ? " · exploded" : ""}`;
}

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const byKey = parts.find((p) => p.key === k);
  if (byKey) return onCard(byKey);
  if (k === " ") {
    e.preventDefault();
    choreo.toggleExplode();
  } else if (k === "b") choreo.buildAll();
  else if (k === "r") choreo.reset();
  else if (k === "m") btnSound.click();
});

const unlock = () => {
  sfx.unlock();
  removeEventListener("pointerdown", unlock);
  removeEventListener("keydown", unlock);
};
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

// ---------- loop ----------
choreo.prewarm(renderer);
syncUi();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  choreo.update(dt, t);
  controls.update();
  pad.ringMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.6));
  if (composer) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);
