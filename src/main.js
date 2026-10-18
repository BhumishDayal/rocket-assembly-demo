import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { catalog, presetIds, getPreset, presetToBuild, optionsFor, applyOption } from "./data/catalog.js";
import { evaluateBuild, stageDetails, stackMass_kg } from "./physics.js";
import { SCALE, buildManifest, sceneBounds } from "./layout.js";
import { createMaterials, createPart, createPad, createStars } from "./parts.js";
import { createChoreographer } from "./choreo.js";
import { createSfx } from "./fx/sfx.js";
import { createSelector } from "./ui/select.js";
import { createCard } from "./ui/card.js";
import * as f from "./ui/format.js";

const query = new URLSearchParams(location.search);
const lite = query.get("lite") === "1";

// ---------- preset → build → manifest + physics ----------
// A build starts as a preset and changes through the card's Options (applyOption); `modified` says so.
const buildKey = (b) => JSON.stringify([b.missionId, b.payloadId, b.stages]);
function loadBuild(preset, build = presetToBuild(preset)) {
  const manifest = buildManifest(build, catalog);
  return {
    preset,
    build,
    modified: buildKey(build) !== buildKey(presetToBuild(preset)),
    manifest,
    bounds: sceneBounds(manifest),
    verdict: evaluateBuild(build, catalog),
    details: stageDetails(build, catalog),
  };
}
const loadPreset = (id) => loadBuild(getPreset(id));
let presetIndex = Math.max(0, presetIds.indexOf(query.get("build")));
let current = loadPreset(presetIds[presetIndex]);

// ---------- renderer / scene ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lite, powerPreference: "high-performance" });
renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
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
controls.minDistance = 2.5; // close enough to frame a single engine cluster
controls.maxDistance = 70;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.25;

// Light rig (design round 10): one warm peach key from upper-left-front of the home view, a cool fill from the
// opposite side, a faint hemisphere. Dark graphite shells read by their rims and edges, not by flat white light.
const KEY_DIR = new THREE.Vector3(-0.34, 1.1, 0.94).normalize(); // from the target toward the key light
const key = new THREE.DirectionalLight(0xffb48a, 2.2);
key.castShadow = !lite;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.5);
fill.position.set(0.34, 0.45, -0.94).multiplyScalar(40);
scene.add(fill);
scene.add(new THREE.HemisphereLight(0x8fa6c8, 0x0f1118, 0.15));

const root = new THREE.Group(); // shakes on lock
scene.add(root);
let pad = null;
scene.add(createStars());

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material ?? [])) m.dispose();
  });
}

// Everything tuned to the stack size: fog, key-light shadow box (with room for the exploded view), orbit
// range, pad. The light keeps its direction; only its box follows the preset.
function applyBounds(b) {
  const H = b.height_u;
  scene.fog.near = Math.max(45, H * 2.6);
  scene.fog.far = Math.max(130, scene.fog.near + 85);
  key.target.position.set(0, H * 0.45, 0);
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, H * 1.5 + 20);
  const half = Math.max(8, H * 0.85, b.radius_u * 6);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -half;
  sc.right = sc.top = half;
  sc.near = 1;
  sc.far = H * 3.2 + 45;
  sc.updateProjectionMatrix();
  controls.maxDistance = Math.max(70, H * 3.4);
  if (pad?.baseRadius_u === b.baseRadius_u) return;
  if (pad) {
    root.remove(pad.group);
    disposeTree(pad.group);
  }
  pad = { ...createPad({ baseRadius_u: b.baseRadius_u }), baseRadius_u: b.baseRadius_u };
  root.add(pad.group);
}
applyBounds(current.bounds);

// ---------- parts ----------
const materials = createMaterials();
const makePart = (spec) => createPart(spec, materials);
let parts = current.manifest.map(makePart);
const sfx = createSfx();
const choreo = createChoreographer({ parts, scene, root, camera, controls, sfx, onChange: syncUi, scale: SCALE, bounds: current.bounds, makePart });

// ---------- post ----------
// GTAO skips what writes no depth (holograms, flashes, the pad ring), so ghosts never darken the stack.
class SolidGTAOPass extends GTAOPass {
  _overrideVisibility() {
    super._overrideVisibility();
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (o.isMesh && o.visible && o.material && o.material.depthWrite === false) {
        o.visible = false;
        cache.push(o);
      }
    });
  }
}
let composer = null;
if (!lite) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new SolidGTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.55; // dark shells need little AO
  composer.addPass(gtao);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.36, 0.55, 0.8)); // peach edges glow a touch
  composer.addPass(new OutputPass());
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// ---------- selection + card ----------
const card = createCard(document.getElementById("detail"), { onOption: (part, id) => chooseOption(part, id) });
const isComplete = () => parts.length > 0 && parts.every((p) => p.built);
// During a swap the open card still shows the old part, so it keeps the old build's numbers (shown).
let shown = null;
const cardContext = (part = card.part) => {
  const ctx = shown ?? current;
  return {
    ...ctx,
    complete: shown ? shown.complete : isComplete(),
    options: part ? optionsFor(part.kind, ctx.build, part.stageIndex) : [],
    optionsDisabled: choreo.state.busy > 0,
    fairing: part?.kind === "payload" ? parts.find((p) => p.kind === "fairing" && p.built) : null,
  };
};

let hovered = null;
const selector = createSelector({
  canvas,
  camera,
  parts,
  onSelect(part) {
    const prev = card.part;
    if (prev && prev !== part) choreo.highlight(prev, false);
    if (!part) {
      card.hide();
      if (prev && !choreo.state.busy) choreo.unfocus(); // Esc / empty click: back to the stack
      return;
    }
    choreo.highlight(part, true);
    // Glide to frame the clicked part (x-ray focus); on a phone keep it above the bottom-sheet card.
    choreo.focus(part, matchMedia("(max-width: 760px)").matches ? { frac: 0.4, shift: 0.24 } : {});
    card.show(part, cardContext(part));
    sfx.play("ui", { gain: 0.5 });
  },
  // The fairing is a derived wrapper: clicking it (assembled) selects the payload inside. Its own card is
  // reachable in the exploded view, where the halves swing out.
  resolve: (part) =>
    part?.kind === "fairing" && !choreo.state.exploded ? parts.find((p) => p.kind === "payload" && p.built) ?? part : part,
  onGhostClick(part) {
    if (choreo.canBuild(part)) choreo.build(part);
  },
  onHover(hit) {
    const ghost = hit?.ghost ? hit.part : null;
    if (ghost === hovered) return;
    if (hovered) choreo.setGhost(hovered, false);
    hovered = ghost;
    if (ghost) {
      choreo.setGhost(ghost, true);
      sfx.play("ui", { gain: 0.5 });
    }
  },
});

// ---------- UI ----------
const btnBuildAll = document.getElementById("btn-build-all");
const btnExplode = document.getElementById("btn-explode");
const btnReset = document.getElementById("btn-reset");
const btnSound = document.getElementById("btn-sound");
const hudText = document.getElementById("hud-text");

btnBuildAll.addEventListener("click", () => choreo.buildAll());
btnExplode.addEventListener("click", () => choreo.toggleExplode());
btnReset.addEventListener("click", () => reset());
btnSound.addEventListener("click", () => {
  sfx.setMuted(!sfx.muted);
  btnSound.textContent = sfx.muted ? "Sound off" : "Sound on";
  btnSound.setAttribute("aria-pressed", String(!sfx.muted));
});

// HUD: running tally while building (parts, stacked height, stacked mass from the records via physics),
// the verdict line once the preset is complete (same numbers the team app computes). The height is "est.":
// it comes from the layout, which uses visual ratios where the dataset has no length (nose, unsourced bells).
function hudHtml() {
  const { preset, build, verdict, bounds } = current;
  const built = parts.filter((p) => p.built);
  const name = `<strong>${f.esc(preset.name)}</strong>${current.modified ? " (modified)" : ""}`;
  if (built.length === 0) return `${name} · pad ready`;
  if (built.length < parts.length) {
    const ids = (kind) => built.filter((p) => p.kind === kind).map((p) => p.stageIndex);
    const mass = stackMass_kg(build, catalog, { engines: ids("engines"), tanks: ids("tank"), payload: built.some((p) => p.kind === "payload") });
    const height_m = choreo.topY() / SCALE;
    return `<strong>${built.length}/${parts.length}</strong> parts · <strong>${f.m(height_m)}</strong> est. · <strong>${f.t(mass)}</strong>${choreo.state.exploded ? " · exploded" : ""}`;
  }
  const go = verdict.feasible;
  const n = verdict.warnings.length;
  const why = n ? ` · ${n} warning${n === 1 ? "" : "s"}` : !verdict.deltaVOk ? " · Δv short" : "";
  return [
    name,
    `${f.m(bounds.height_m)} est.`,
    f.t(verdict.totalMass_kg),
    `Δv ${f.num(verdict.totalDeltaV_ms, 0)} / ${f.ms(verdict.requiredDeltaV_ms)}`,
    `TWR ${f.twr(verdict.liftoffTWR)}`,
    go ? `<strong class="go">GO</strong>` : `<strong class="nogo">NO-GO</strong>${why}`,
  ].join(" · ");
}

let swapping = false; // the HUD keeps the old verdict until the new part locks (design round 7, swap step 4)
function syncUi() {
  if (parts !== choreo.parts) {
    parts = choreo.parts;
    selector.setParts(parts);
  }
  const { busy, exploded } = choreo.state;
  const built = parts.filter((p) => p.built).length;
  btnExplode.disabled = built === 0 || (busy > 0 && !exploded);
  btnExplode.textContent = exploded ? "Assemble" : "Explode";
  btnExplode.classList.toggle("on", exploded);
  btnBuildAll.disabled = built === parts.length || busy > 0 || exploded;
  if (!swapping) hudText.innerHTML = hudHtml();
  // A selected part that is being removed (or gone after reset) loses its card.
  const sel = selector.selected;
  if (sel && (!sel.built || (sel.busy && !swapping) || !parts.includes(sel))) selector.clear();
  if (card.part) card.refresh(cardContext());
  selector.refresh();
}

// Options: swap one slot for another record. The stack animates (choreo.applyManifest: lift, unscrew,
// fly in, settle), then physics, HUD and the open card switch to the new build.
async function chooseOption(part, recordId) {
  if (choreo.state.busy) return;
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  const next = loadBuild(current.preset, applyOption(current.build, part.kind, part.stageIndex, recordId));
  if (buildKey(next.build) === buildKey(current.build)) return;
  shown = { ...current, complete: isComplete() };
  current = next;
  swapping = true;
  applyBounds(next.bounds);
  choreo.setBounds(next.bounds);
  const res = await choreo.applyManifest(next.manifest);
  swapping = false;
  shown = null;
  if (!res) return syncUi(); // cancelled (reset or preset switch mid-swap)
  const swapped = choreo.parts.find((p) => p.id === part.id);
  syncUi();
  if (swapped?.built) selector.select(swapped);
}

function switchPreset(step) {
  presetIndex = (presetIndex + step + presetIds.length) % presetIds.length;
  current = loadPreset(presetIds[presetIndex]);
  selector.clear();
  hovered = null;
  parts = current.manifest.map(makePart);
  applyBounds(current.bounds);
  choreo.setBounds(current.bounds);
  selector.setParts(parts);
  choreo.rebuild(parts);
  const q = new URLSearchParams(location.search);
  q.set("build", current.preset.id);
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

// Reset means reset: back to the empty pad and, if Options changed the build, the pristine preset.
function reset() {
  if (current.modified) switchPreset(0);
  else choreo.reset();
}

function onPartKey(part) {
  if (part.built) {
    if (choreo.isTopBuilt(part)) choreo.remove(part);
  } else {
    choreo.buildUpTo(part);
  }
}

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  const byKey = parts.find((p) => p.key === k);
  if (byKey) return onPartKey(byKey);
  if (k === " ") {
    e.preventDefault();
    if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
    choreo.toggleExplode();
  } else if (k === "b") choreo.buildAll();
  else if (k === "r") reset();
  else if (k === "m") btnSound.click();
  else if (k === "[") switchPreset(-1);
  else if (k === "]") switchPreset(1);
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
choreo.home();
syncUi();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  choreo.update(dt, t);
  controls.update();
  if (pad?.ringMat) pad.ringMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.6));
  if (composer) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);
