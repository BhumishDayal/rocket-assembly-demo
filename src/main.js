import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import * as catalogModule from "./data/catalog.js";
import { catalog, presetIds, getPreset, presetToBuild, applyOption } from "./data/catalog.js";
import { evaluateBuild, stageDetails, stackMass_kg } from "./physics.js";
import { optionsWithCompat } from "./compat.js";
import { simulateAscent } from "./ascent.js";
import { arrivalTimeline } from "./arrival.js";
import { createSilhouette } from "./silhouette.js";
import { createAnchors } from "./anchors.js";
import { animate, spring } from "animejs";
import { SCALE, buildManifest, sceneBounds } from "./layout.js";
import { createMaterials, createPart, createPad, createStars, setShellOpacity, setPropLook, LOOK } from "./parts.js";
import { createChoreographer } from "./choreo.js";
import { createOptionShelf } from "./optionShelf.js";
import { createSfx } from "./fx/sfx.js";
import { createSelector } from "./ui/select.js";
import { createCard } from "./ui/card.js";
import { createScrub } from "./ui/scrub.js";
import { ensureShell } from "./ui/shell.js";
import { createLanding } from "./ui/landing.js";
import { createGroundMap } from "./fx/launchfx.js";
import { createWorld } from "./world.js";
import { flightTimeline } from "./flight.js";
import * as f from "./ui/format.js";

const query = new URLSearchParams(location.search);
const lite = query.get("lite") === "1";
// The host page (team app shell or index.html) may lack newer elements: create them, refresh the hint line.
const shell = ensureShell();

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
const canvas = shell.canvas;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lite, powerPreference: "high-performance" });
renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, 1.5)); // 1.5 caps the fill cost on retina screens
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

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 6000); // far: the star shell
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
const key = new THREE.DirectionalLight(0xffb48a, 2.8); // contrast: every cylinder shows a light-to-shadow gradient
key.castShadow = !lite;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.3);
fill.position.set(0.34, 0.45, -0.94).multiplyScalar(40);
scene.add(fill);
scene.add(new THREE.HemisphereLight(0x8fa6c8, 0x0f1118, 0.08));

const root = new THREE.Group(); // shakes on lock
scene.add(root);
let pad = null;
let anchors = null; // scale anchors (UI4): person, tower, trench, masts at true size, on the pad
// UI4's star field is a 90–130 u shell; pushed out ×30 (as in UI4's world harness) so no star sits in front of a
// globe, with the points scaled to keep their size on screen.
const stars = createStars();
stars.scale.setScalar(30);
stars.material.size *= 30;
scene.add(stars);

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    for (const m of new Set([].concat(o.material ?? [], Object.values(o.userData.looks ?? {})))) m.dispose(); // both looks of a piece
  });
}

// Key-light shadow box: sized and centred on the stack (room for the exploded view); in flight it follows the
// orbit target (the rocket, the booster, the craft). Changes ease over ~0.5 s (placeShadow, every frame) and the
// centre snaps to whole shadow-map texels, so shadows neither jump nor swim.
const shadowBox = { home: new THREE.Vector3(), half: 0, dist: 0, far: 0, goal: { half: 8, dist: 20, far: 45 }, c: new THREE.Vector3(), init: false };
const SHADOW_AXES = (() => {
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), KEY_DIR).normalize();
  return { x, y: new THREE.Vector3().crossVectors(KEY_DIR, x) };
})();
function placeShadow(dt, snap) {
  const s = shadowBox;
  const k = snap || !s.init ? 1 : 1 - Math.exp(-dt / 0.15);
  s.init = true;
  s.c.lerp(choreo.state.launch ? controls.target : s.home, k);
  const sc = key.shadow.camera;
  if (Math.abs(s.goal.half - s.half) > 1e-4 || Math.abs(s.goal.far - s.far) > 1e-4) {
    s.half += (s.goal.half - s.half) * k;
    s.far += (s.goal.far - s.far) * k;
    sc.left = sc.bottom = -s.half;
    sc.right = sc.top = s.half;
    sc.near = 1;
    sc.far = s.far;
    sc.updateProjectionMatrix();
  }
  s.dist += (s.goal.dist - s.dist) * k;
  const texel = (2 * s.half) / key.shadow.mapSize.x;
  const ax = s.c.dot(SHADOW_AXES.x);
  const ay = s.c.dot(SHADOW_AXES.y);
  key.target.position.copy(s.c).addScaledVector(SHADOW_AXES.x, Math.round(ax / texel) * texel - ax).addScaledVector(SHADOW_AXES.y, Math.round(ay / texel) * texel - ay);
  key.position.copy(key.target.position).addScaledVector(KEY_DIR, s.dist);
}

// Contact shadow: a soft dark blob on the deck under the stack, where the key light's shadow map is too coarse to
// ground the base. Shown while the bottom part is built; in flight it stays on the pad and fades as the rocket
// climbs off it (updateContact). Writes no depth, so GTAO and the DoF depth skip it.
function createContactShadow(radius) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,0.9)");
  grd.addColorStop(0.4, "rgba(0,0,0,0.5)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * radius, 2 * radius).rotateX(-Math.PI / 2), mat);
  mesh.name = "contact-shadow";
  mesh.position.y = 0.002;
  mesh.renderOrder = 1;
  mesh.raycast = () => {};
  return mesh;
}
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
function updateContact(dt) {
  const c = pad?.contact;
  if (!c) return;
  const base = parts[0];
  let goal = base?.built ? 0.6 : 0;
  if (goal && choreo.state.launch) {
    const rise = base.group.getWorldPosition(tmpA).y - pad.group.getWorldPosition(tmpB).y - base.slotY;
    goal *= 1 - THREE.MathUtils.smoothstep(rise, 0, 2.5 * pad.baseRadius_u);
  }
  c.material.opacity += (goal - c.material.opacity) * (1 - Math.exp(-dt / 0.12));
  c.visible = c.material.opacity > 0.003;
}

// Everything tuned to the stack size: fog, key-light shadow box, orbit range, pad. The light keeps its
// direction; only its box follows the preset.
function applyBounds(b) {
  const H = b.height_u;
  shadowBox.home.set(0, H * 0.45, 0);
  shadowBox.goal = { half: Math.max(8, H * 0.85, b.radius_u * 6), dist: H * 1.5 + 20, far: H * 3.2 + 45 };
  controls.maxDistance = Math.max(70, H * 3.4);
  if (pad?.baseRadius_u !== b.baseRadius_u) {
    if (pad) {
      root.remove(pad.group);
      disposeTree(pad.group);
    }
    pad = { ...createPad({ baseRadius_u: b.baseRadius_u }), baseRadius_u: b.baseRadius_u };
    // UI4's line-art ground (coastline, 1 km grid, the pad mark) just under the hardstand; it hangs on the pad,
    // so it drops away with it in flight.
    pad.ground = createGroundMap({ y_u: -pad.layout.plinthH - 0.01 });
    pad.group.add(pad.ground.object3d);
    pad.contact = createContactShadow(b.baseRadius_u * 2.4);
    pad.group.add(pad.contact);
    root.add(pad.group);
  }
  // Anchors are sized from the stack height too, so they follow every preset/option change. They hang on the
  // pad group, so they drop away with the pad in flight.
  anchors?.dispose();
  anchors = createAnchors({ baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u, manifest: current.manifest });
  pad.group.add(anchors.object3d);
}
applyBounds(current.bounds);

// ---------- parts ----------
const materials = createMaterials();
const makePart = (spec) => createPart(spec, materials);
let parts = current.manifest.map(makePart);
const sfx = createSfx();
// The far layer (UI4's world.js, rounds 16–17): the Earth, Moon, Mars, stars and sun in scaled space, drawn first
// with the near scene (vehicle, pad, effects) on top, its depth cleared. The far camera follows the near camera
// from the near origin's place on the Earth (the pad, rising with the vehicle in flight; choreo.nearOriginKm).
// Off during the landing dive, which draws its own planet and sky.
const world = createWorld({ renderer });
const BG = scene.background;
world.clearColor.copy(BG); // what shows behind the builder while the far layer is off
const PAD_KM = new THREE.Vector3(0, world.bodies.earth.radius_km, 0);
const viewerKm = new THREE.Vector3();
const choreo = createChoreographer({ parts, scene, root, camera, controls, sfx, onChange: syncUi, scale: SCALE, bounds: current.bounds, makePart, world });

// ---------- post ----------
// GTAO skips what writes no depth (holograms, flashes, the pad ring, x-ray shells), so they never darken the
// stack. It runs at half resolution (the AO is soft anyway) and is on whenever the scene is at rest: off only
// while something animates (build, swap, explode, scrub, the landing dive) and for the whole launch (countdown to
// the held final frame: no AO popping on mid-flight). The frame-time guard (see luxuryBudget) can drop it.
class SolidGTAOPass extends GTAOPass {
  setSize(width, height) {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
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
// Depth of field (design rounds 13 (7), 15 (3)): mild, only where it reads, on a focused part at rest and on the
// vehicle in flight. three's BokehPass with its depth at half resolution, skipping what writes no depth (glows,
// holograms, x-ray shells) and the background (the sky stays "far"). The pass is off whenever its aperture has
// eased to 0 (updateDof); the frame-time guard drops it before GTAO.
class SoftBokehPass extends BokehPass {
  setSize(width, height) {
    super.setSize(width, height);
    this._renderTargetDepth.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const hidden = [];
    this.scene.traverseVisible((o) => {
      if (o.material && !Array.isArray(o.material) && o.material.depthWrite === false) hidden.push(o);
    });
    for (const o of hidden) o.visible = false;
    const background = this.scene.background;
    this.scene.background = null;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.scene.background = background;
    for (const o of hidden) o.visible = true;
  }
}
let composer = null;
let gtao = null;
let dof = null;
let worldPass = null;
let nearPass = null;
if (!lite) {
  composer = new EffectComposer(renderer);
  composer.addPass((worldPass = world.createPass()));
  composer.addPass((nearPass = new RenderPass(scene, camera)));
  nearPass.clearDepth = true;
  const pr = renderer.getPixelRatio();
  gtao = new SolidGTAOPass(scene, camera, innerWidth * pr, innerHeight * pr);
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.55; // dark shells need little AO
  composer.addPass(gtao);
  dof = new SoftBokehPass(scene, camera, { focus: 10, aperture: 0, maxblur: 0.004 });
  dof.enabled = false;
  composer.addPass(dof);
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
const card = createCard(shell.detail, { onOption: (part, id) => chooseOption(part, id) });
const isComplete = () => parts.length > 0 && parts.every((p) => p.built);
// During a swap the open card still shows the old part, so it keeps the old build's numbers (shown).
let shown = null;
const cardContext = (part = card.part) => {
  const ctx = shown ?? current;
  return {
    ...ctx,
    complete: shown ? shown.complete : isComplete(),
    options: part?.record ? optionsWithCompat(ctx.build, catalog, part.kind, part.stageIndex) : [],
    optionsDisabled: choreo.state.busy > 0,
    fairing: part?.kind === "payload" ? parts.find((p) => p.kind === "fairing" && p.built) : null,
  };
};

let hovered = null;
// Grok's options for the next part, shown as the real parts beside the rocket (app bridge; see optionShelf.js).
const shelf = createOptionShelf({
  camera,
  scene,
  root,
  canvas,
  catalog,
  onPick: (o) => dispatchEvent(new CustomEvent("assembly:option-picked", { detail: o })),
});

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
  // Nothing to inspect in flight. A fairing in the clear look shows its payload, so a click there selects the
  // payload; an opaque fairing is what you see and click.
  resolve: (part) =>
    choreo.state.launch || landingOn()
      ? null
      : part?.kind === "fairing" && part.look === "clear" && !choreo.state.exploded
        ? parts.find((p) => p.kind === "payload" && p.built) ?? part
        : part,
  // Every click on a part flips its look (opaque ↔ clear); empty space only deselects.
  onPick: (part) => choreo.toggleLook(part),
  onGhostClick(part) {
    if (landingOn()) return;
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

// Scrub the exploded view: vertical drag on empty space, or wheel / two-finger scroll (design E17).
createScrub({
  canvas,
  controls,
  isEmpty: (x, y) => !selector.hit(x, y),
  start: () => choreo.scrubStart(),
  by: (d) => choreo.scrubBy(d),
  end: () => choreo.scrubEnd(),
});

// ---------- UI ----------
const { btnRockets, rocketsEl, btnBuildAll, btnExplode, btnReset, hudText } = shell;

// Build all becomes Launch once the stack is complete.
btnBuildAll.addEventListener("click", () => (isComplete() ? launch() : choreo.buildAll()));

// Rockets: the presets as an in-place list above the bar. One line each: name, stages, height est.,
// payload → mission (all from the records and the layout). Choosing one loads it (it appears built).
// Compare mode (key C): the closest real rocket (GCAT twin) first, then the other presets; choosing one shows
// it beside the current rocket at true scale.
let rocketsMode = "switch";
function rocketsHtml(mode = "switch") {
  const rows = [];
  const rec = mode === "compare" ? twinRecord() : null;
  if (rec) {
    const name = rec.variant ? `${rec.name} (${rec.variant})` : rec.name;
    const meta = catalogModule.twinLine ? catalogModule.twinLine(rec) : name;
    rows.push(`<li><button type="button" class="opt" data-twin="1"><span class="opt-name">Closest real rocket: ${f.esc(name)}</span><span class="opt-meta" title="${f.esc(meta)}">${f.esc(meta)}</span></button></li>`);
  }
  presetIds.forEach((id, i) => {
    if (mode === "compare" && i === presetIndex && !current.modified) return; // not itself
    const p = getPreset(id);
    const b = presetToBuild(p);
    const height = sceneBounds(buildManifest(b, catalog)).height_m;
    const payload = catalog.payloads.find((x) => x.id === b.payloadId);
    const mission = catalog.missions.find((x) => x.id === b.missionId);
    const n = b.stages.length;
    const meta = `${n} stage${n === 1 ? "" : "s"} · ${f.m(height)} est. · ${payload?.name ?? b.payloadId} → ${mission?.name ?? b.missionId}`;
    const cur = mode === "switch" && i === presetIndex && !current.modified;
    rows.push(`<li><button type="button" class="opt" data-i="${i}"${cur ? ' aria-current="true"' : ""}><span class="opt-name">${f.esc(p.name)}</span><span class="opt-meta" title="${f.esc(meta)}">${f.esc(meta)}</span></button></li>`);
  });
  return `<ul>${rows.join("")}</ul>`;
}
function setRocketsOpen(open, mode = "switch") {
  if (open === !rocketsEl.hidden && (!open || mode === rocketsMode)) return;
  if (open) {
    selector.clear(); // one panel at a time (the card is a bottom sheet on phones)
    rocketsMode = mode;
    rocketsEl.innerHTML = rocketsHtml(mode);
    rocketsEl.setAttribute("aria-label", mode === "compare" ? "Compare with" : "Pre-made rockets");
  }
  rocketsEl.hidden = !open;
  btnRockets.setAttribute("aria-expanded", String(open));
  if (open && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    rocketsEl.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
  }
}
btnRockets.addEventListener("click", () => setRocketsOpen(rocketsEl.hidden));
rocketsEl.addEventListener("click", (e) => {
  const opt = e.target.closest(".opt");
  if (!opt) return;
  const mode = rocketsMode;
  setRocketsOpen(false);
  if (mode !== "compare") return switchPreset(Number(opt.dataset.i) - presetIndex);
  clearCompare({ reframe: false });
  if (opt.dataset.twin) showTwin();
  else showRival(Number(opt.dataset.i));
});
addEventListener("pointerdown", (e) => {
  if (!rocketsEl.hidden && !e.target.closest("#rockets, #btn-rockets")) setRocketsOpen(false);
});
btnExplode.addEventListener("click", () => choreo.toggleExplode());
btnReset.addEventListener("click", () => reset());


// HUD: running tally while building (parts, stacked height, stacked mass from the records via physics),
// the verdict line once the preset is complete (same numbers the team app computes). The height is "est.":
// it comes from the layout, which uses visual ratios where the dataset has no length (nose, unsourced bells).
function hudHtml() {
  const { preset, build, verdict, bounds } = current;
  const built = parts.filter((p) => p.built);
  const name = `<strong>${f.esc(preset.name)}</strong>${current.modified ? " (modified)" : ""}`;
  // Nothing is built yet: the preset is only the plan (starter blueprint) the parts will come from.
  if (built.length === 0) return `Empty pad · blueprint: ${name}`;
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
  const launched = Boolean(choreo.state.launch);
  if (built === parts.length && !launched) presimulate();
  btnBuildAll.textContent = built === parts.length ? "Launch" : "Build all";
  btnBuildAll.disabled = busy > 0 || exploded || launched;
  btnExplode.disabled ||= launched;
  const cmp = twin ?? rival;
  if (cmp && (cmp.key !== buildKey(current.build) || launched || busy > 0 || built < parts.length)) clearCompare({ reframe: false });
  if (launched) {
    if (telemetry.final) hudText.innerHTML = telemetry.final;
  } else if (twin ?? rival) hudText.innerHTML = (twin ?? rival).line;
  else if (!swapping) hudText.innerHTML = hudHtml();
  announceProgress();
  announceComplete();
  // A selected part that is being removed (or gone after reset) loses its card.
  const sel = selector.selected;
  if (sel && (!sel.built || (sel.busy && !swapping) || !parts.includes(sel))) selector.clear();
  if (card.part) card.refresh(cardContext());
  selector.refresh();
}

// ---------- app bridge (team PR #30, ported verbatim in behaviour) ----------
// In the Next app the build also lives in the app's store (Grok reads it there). This screen announces every
// build it shows ("assembly:build") and accepts builds from the app ("assembly:apply", e.g. Grok's Apply),
// which animate exactly like Options. Standalone (Vite) nothing listens and nothing is sent.
const announce = () => dispatchEvent(new CustomEvent("assembly:build", { detail: { build: current.build } }));
// "assembly:report": what a screen action ended in (launch outcome, twin found), as plain text for Grok.
const report = (kind, html) =>
  dispatchEvent(
    new CustomEvent("assembly:report", {
      detail: { kind, text: String(html ?? "").replace(/<[^>]+>/g, "").replace(/\u00a0/g, " ").trim() },
    }),
  );
// "assembly:complete": whether every part of the current build is on the stack (the app shows Render only then).
// "assembly:progress": every part in build order and whether it is on the stack, sent whenever that changes,
// so Grok can walk the user through the build one part at a time.
let lastProgress = "";
function announceProgress() {
  const list = parts.map((p) => ({ id: p.id, kind: p.kind, stageIndex: p.stageIndex, recordId: p.record?.id ?? null, built: p.built }));
  const key = JSON.stringify(list);
  if (swapping || key === lastProgress) return;
  lastProgress = key;
  const shelfPart = shelf.partId ? list.find((p) => p.id === shelf.partId) : null;
  if (shelf.partId && (!shelfPart || shelfPart.built !== shelf.forBuilt)) shelf.clear();
  dispatchEvent(new CustomEvent("assembly:progress", { detail: { parts: list } }));
}
let lastComplete = null;
function announceComplete() {
  const complete = !swapping && isComplete();
  if (complete === lastComplete) return;
  lastComplete = complete;
  dispatchEvent(new CustomEvent("assembly:complete", { detail: { complete } }));
}

// Animate the stack to `build` (choreo.applyManifest: lift, unscrew, fly in, settle), then physics, HUD and the
// open card switch to it. Resolves to false if nothing changed or the swap was cancelled.
async function swapTo(build) {
  if (choreo.state.exploded && !(await choreo.assemble())) return false;
  const next = loadBuild(current.preset, build);
  if (buildKey(next.build) === buildKey(current.build)) return false;
  const fromShelf = next.manifest.find((sp) => parts.find((p) => p.id === sp.id)?.built && shelf.has(sp.id, sp.record?.id));
  if (fromShelf) await shelf.flyIn(fromShelf);
  shown = { ...current, complete: isComplete() };
  current = next;
  announce();
  swapping = true;
  applyBounds(next.bounds);
  choreo.setBounds(next.bounds);
  const res = await choreo.applyManifest(next.manifest);
  swapping = false;
  shown = null;
  syncUi();
  return Boolean(res); // false: cancelled (reset or preset switch mid-swap)
}

// Options: swap one slot for another record.
async function chooseOption(part, recordId) {
  if (choreo.state.busy) return;
  if (!(await swapTo(applyOption(current.build, part.kind, part.stageIndex, recordId)))) return;
  const swapped = choreo.parts.find((p) => p.id === part.id);
  if (swapped?.built) selector.select(swapped);
}

// A build from the app waits until any running animation is done; only the latest one is applied.
let pendingApply = null;
function applyFromApp(build) {
  pendingApply = build;
  if (choreo.state.busy) return void setTimeout(() => pendingApply === build && applyFromApp(build), 250);
  pendingApply = null;
  // A finished rocket stays finished (e.g. Apply fix adds a stage); a rocket mid-build keeps its pace (guided build).
  const wasComplete = isComplete();
  void swapTo(build).then((ok) => ok && wasComplete && !isComplete() && choreo.buildAll());
}
addEventListener("assembly:apply", (e) => applyFromApp(e.detail.build));
// Place the next part; if a swap or another part is still animating, wait for it (up to tries x 250 ms).
function buildNextWhenIdle(tries) {
  if (choreo.state.busy || pendingApply || shelf.busy) {
    if (tries > 0) setTimeout(() => buildNextWhenIdle(tries - 1), 250);
    return;
  }
  const next = parts.find((p) => !p.built);
  if (!next || !choreo.canBuild(next)) return;
  // Picked from the option shelf: that preview flies onto its slot first, then the part locks in.
  if (shelf.has(next.id, next.record?.id)) void shelf.flyIn(next).then(() => choreo.build(next));
  else choreo.build(next);
}
const whenIdle = () =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      if (choreo.state.busy || pendingApply || shelf.busy) return;
      clearInterval(t);
      resolve();
    }, 100);
  });
// Take parts off from the top, down to and including `partId` (no id: just the top part). Only the top part can
// come off, as on a real stack, so everything above it goes first.
async function removeDownTo(partId) {
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  for (let guard = 0; guard < 20; guard++) {
    const target = partId ? parts.find((p) => p.id === partId) : [...parts].reverse().find((p) => p.built);
    if (!target?.built) return;
    await whenIdle();
    const top = [...parts].reverse().find((p) => p.built);
    if (!top || !(await choreo.remove(top)) || top === target) return;
  }
}
// Put parts back on, bottom up to and including `partId` (no id: just the next part).
async function placeUpTo(partId) {
  await whenIdle();
  const target = partId ? parts.find((p) => p.id === partId) : parts.find((p) => !p.built);
  if (target && !target.built) await choreo.buildUpTo(target);
}
// Screen commands from the app (Grok's voice tools): the same actions as the buttons.
addEventListener("assembly:command", (e) => {
  const cmd = e.detail?.cmd;
  if (cmd === "build_all") choreo.buildAll();
  else if (cmd === "build_next") buildNextWhenIdle(40);
  else if (cmd === "explode") choreo.toggleExplode();
  else if (cmd === "reset") reset();
  else if (cmd === "show_options") shelf.show({ build: current.build, partId: e.detail.partId, options: e.detail.options, built: e.detail.built });
  else if (cmd === "remove_parts") void removeDownTo(e.detail.partId);
  else if (cmd === "place_parts") void placeUpTo(e.detail.partId);
  else if (cmd === "inspect_part") {
    const part = parts.find((p) => p.id === e.detail.partId && p.built);
    if (part) selector.select(part);
  } else if (cmd === "reset_view") {
    selector.clear();
    choreo.home();
  }
  else if (cmd === "hide_options") shelf.clear();
  else if (cmd === "launch") {
    if (!isComplete()) report("launch", "Not launched: the rocket is not fully built yet");
    else if (choreo.state.launch) report("launch", "Already in flight");
    else void launch();
  } else if (cmd === "show_twin") {
    if (!isComplete()) report("twin", "The rocket must be fully built to find its twin");
    else if (!showTwin() && !twin) report("twin", hudText.innerHTML);
  } else if (cmd === "hide_twin") hideTwin();
  else if (cmd === "see_through") choreo.toggleLookAll();
  else if (cmd === "save_card") void saveCard();
  else if (cmd === "play_story") void runStory();
  else if (cmd === "switch_rocket") {
    const i = presetIds.indexOf(e.detail.presetId);
    if (i >= 0) switchPreset(i - presetIndex, { built: e.detail.built !== false });
  }
});

// Switching rockets ([ ], the Rockets list) shows the new one built (one snap); reset and the story start empty.
function switchPreset(step, { built = true } = {}) {
  shelf.clear();
  presetIndex = (presetIndex + step + presetIds.length) % presetIds.length;
  current = loadPreset(presetIds[presetIndex]);
  selector.clear();
  hovered = null;
  parts = current.manifest.map(makePart);
  applyBounds(current.bounds);
  choreo.setBounds(current.bounds);
  setPropLook(pad.group, "painted");
  selector.setParts(parts);
  choreo.rebuild(parts);
  if (built) choreo.appearBuilt();
  if (!rocketsEl.hidden) rocketsEl.innerHTML = rocketsHtml(rocketsMode);
  announce();
  const q = new URLSearchParams(location.search);
  q.set("build", current.preset.id);
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

// Reset means reset: back to the empty pad and, if Options changed the build, the pristine preset.
function reset() {
  shelf.clear();
  if (current.modified) switchPreset(0, { built: false });
  else choreo.reset();
  setPropLook(pad.group, "painted"); // new parts arrive painted; the pad and anchors match them
}

// ---------- launch ----------
// One ascent simulation per launch (ascent.js; every number it shows is an estimate), played by choreo.
const telemetry = { final: null, last: 0 };
const pad2 = (n) => String(Math.floor(n)).padStart(2, "0");
function telemetryHtml(tel) {
  if (tel.countdown != null) return `<strong>${f.esc(current.preset.name)}</strong> · <strong>T−${tel.countdown}</strong>${tel.label ? ` · <strong>${f.esc(tel.label)}</strong>` : ""}`;
  const t = Math.max(0, tel.t);
  return [
    `<strong>T+${pad2(t / 60)}:${pad2(t % 60)}</strong>`,
    `${f.num(Math.max(0, tel.alt_m) / 1000, 1)}\u00a0km`,
    f.ms(tel.vel_ms),
    `${f.num(tel.g, 1)}\u00a0g`,
    tel.label ? `<strong>${f.esc(tel.label)}</strong>` : "",
    "est.",
  ]
    .filter(Boolean)
    .join(" · ");
}
function outcomeHtml({ outcome, inOrbit, summary, alt_m }) {
  const mission = catalog.missions.find((m) => m.id === current.build.missionId);
  const orbit = Number.isFinite(summary.perigee_km) ? `${f.num(summary.perigee_km, 0)}\u00a0×\u00a0${f.num(summary.apogee_km, 0)}\u00a0km` : "";
  const short = summary.mission?.shortBy_ms;
  if (inOrbit && outcome === "orbit") {
    return `<strong class="go">ORBIT</strong> · ${orbit} est.${Number.isFinite(summary.remainingDeltaV_ms) ? ` · Δv left ${f.ms(summary.remainingDeltaV_ms)}` : ""}`;
  }
  if (inOrbit) {
    return `Parking orbit ${orbit} est. · <strong class="nogo">Δv short by ${f.ms(short)}</strong>${mission ? ` for ${f.esc(mission.name)}` : ""}`;
  }
  if (outcome === "shortfall") return `<strong class="nogo">Δv short by ${f.ms(short ?? 0)}</strong> · est.`;
  const maxAlt_km = Math.max(...(lastSim?.samples ?? []).map((x) => x.alt_m)) / 1000;
  return maxAlt_km < 0.05
    ? `<strong class="nogo">Pad abort</strong> · thrust below weight (TWR ${f.twr(current.verdict.liftoffTWR)})`
    : `<strong class="nogo">Did not reach space</strong> · max ${f.num(maxAlt_km, 1)}\u00a0km est.`;
}
const BODY_NAME = { earth: "Earth", moon: "the Moon", mars: "Mars" };
const ORBIT_NAME = { earth: "Earth orbit", moon: "lunar orbit", mars: "Mars orbit" };
function endingLegHtml(leg) {
  if (!leg || leg.type === "booster") return hudText.innerHTML;
  if (leg.type === "earth-payload") return `<strong>${f.esc(ORBIT_NAME.earth.toUpperCase())}</strong> · est.`;
  const label =
    leg.type === "orbit"
      ? ORBIT_NAME[leg.body]?.toUpperCase()
      : leg.type === "transfer"
        ? leg.body && leg.body !== "earth"
          ? `TRANSFER TO ${BODY_NAME[leg.body].toUpperCase()}`
          : "TRANSFER"
        : leg.type.toUpperCase();
  const alt = Number.isFinite(leg.alt_km) && leg.alt_km > 0 ? ` · ${f.num(leg.alt_km, 0)}\u00a0km` : "";
  return `<strong>${f.esc(label ?? "")}</strong>${alt} · est.`;
}
function endingFinalHtml(a, booster) {
  const line = endingOutcome(a);
  return booster ? `${line} · booster ${booster}` : line;
}
function endingOutcome(a) {
  if (!a) return telemetry.final ?? "";
  if (!a.success) {
    return `Stranded in Earth orbit · <strong class="nogo">Δv short by ${f.ms(a.shortBy_ms ?? 0)}</strong> · est.`;
  }
  if (a.lands) return `<strong class="go">Landed on ${BODY_NAME[a.body] ?? a.body}</strong> · est.`;
  if (a.body && a.body !== "earth") return `<strong class="go">In ${ORBIT_NAME[a.body]}</strong> · est.`;
  const mission = catalog.missions.find((m) => m.id === current.build.missionId);
  const name = mission ? mission.name.charAt(0).toLowerCase() + mission.name.slice(1) : "orbit";
  return `<strong class="go">In ${f.esc(name)}</strong> · est.`;
}
let lastSim = null;
function onTelemetry(tel) {
  // The planet ending (arrival.js): a short label per leg, then one outcome line (est. by construction).
  if (tel.booster === true) {
    const now = performance.now();
    if (now - telemetry.last < 80) return;
    telemetry.last = now;
    const t = Math.max(0, tel.t);
    hudText.innerHTML = [
      "<strong>BOOSTER</strong>",
      `T+${pad2(t / 60)}:${pad2(t % 60)}`,
      `${f.num(Math.max(0, tel.alt_m) / 1000, 1)}\u00a0km`,
      f.ms(tel.vel_ms),
      `<strong>${f.esc(tel.label)}</strong>`,
      "est.",
    ].join(" · ");
    return;
  }
  if (tel.endState) {
    // flight.js's end state (rounds 16–17): its sentence, green when it got there, warm red when it did not.
    const st = tel.endState;
    const ok = ["landed", "in-orbit-of", "orbit", "in-orbit", "escape"].includes(st.type);
    const line = st.line ?? st.text ?? "";
    const html = (st.missionLine ? `${f.esc(st.missionLine)} · ` : "") + `<strong class="${ok ? "go" : "nogo"}">${f.esc(line)}</strong>`;
    telemetry.final = html;
    report("launch", html);
    hudText.innerHTML = html;
    return;
  }
  if (tel.ending) {
    const html = tel.final ? endingFinalHtml(tel.arrival, tel.booster) : endingLegHtml(tel.leg);
    if (tel.final) {
      telemetry.final = html;
      report("launch", html);
    }
    hudText.innerHTML = html;
    return;
  }
  if (tel.final) {
    telemetry.final = outcomeHtml(tel);
    hudText.innerHTML = telemetry.final;
    report("launch", telemetry.final);
    return;
  }
  const now = performance.now();
  if (now - telemetry.last < 80) return;
  telemetry.last = now;
  hudText.innerHTML = telemetryHtml(tel);
}
// The ascent is simulated ahead, at idle, once a stack is complete (it takes ~45 ms, which otherwise lands on
// the first frame of the countdown as a stutter); launch() reuses it for the same build.
const simCache = { key: null, sim: null, pending: false };
function simFor(build) {
  const k = buildKey(build);
  if (simCache.key !== k) Object.assign(simCache, { key: k, sim: simulateAscent(build, catalog) });
  return simCache.sim;
}
const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 250));
function presimulate() {
  if (simCache.pending || simCache.key === buildKey(current.build)) return;
  simCache.pending = true;
  idle(() => {
    simCache.pending = false;
    if (isComplete() && !choreo.state.launch) simFor(current.build);
  });
}
async function launch({ countdown, brief = false } = {}) {
  if (!isComplete() || choreo.state.busy || choreo.state.launch) return;
  setRocketsOpen(false);
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  const sim = simFor(current.build);
  // A verdict with a blocking warning never flies (ascent.js says "blocked"): a pad abort line for 3 s, no sim.
  if (sim.summary.outcome === "blocked" || !sim.samples.length) {
    const why = sim.summary.reason ?? sim.summary.blockedBy ?? sim.summary.error ?? "no trajectory";
    hudText.innerHTML = `<strong class="nogo">Pad abort</strong> · ${f.esc(why)}`;
    report("launch", hudText.innerHTML);
    clearTimeout(launch.abortTimer);
    launch.abortTimer = setTimeout(() => syncUi(), 3000);
    return;
  }
  lastSim = sim;
  telemetry.final = null;
  selector.clear();
  const arrival = arrivalTimeline(current.build, catalog, sim.summary);
  // One timeline for the whole flight (UI 2's flight.js); the story runs it shorter.
  const flight = brief ? null : flightTimeline(current.build, catalog, { ascent: sim }); // the story keeps its short ascent
  choreo.launch(sim, { pad: pad.group, clamps: pad.clamps, anchors, onTelemetry, arrival, countdown, brief, timeline: !flight || flight.blocked || flight.kind !== "earth" ? null : flight }); // Moon/Mars: next push
}

// ---------- twin compare (design B8/C10) ----------
// The closest real rocket from the GCAT pool (catalog.closestRockets, UI 2) as a peach outline at true scale
// beside the stack (UI4's createSilhouette), with one HUD line: catalog.twinLine + "est." (the match uses our
// build's estimated mass and thrust) + the GCAT attribution (CC BY 4.0). Key C toggles; a build change hides it.
let twin = null;
function twinRecord() {
  const list = catalogModule.closestRockets?.(current.build, 1);
  return Array.isArray(list) ? list[0]?.rocket ?? null : null;
}
const gcatCredit = () => String(catalogModule.gcatSource ?? "").split("; ").pop();
function showTwin() {
  if (twin || rival || choreo.state.launch || choreo.state.busy || !isComplete()) return false;
  const rec = twinRecord();
  if (!rec) {
    hudText.innerHTML = "Closest real rocket: data not loaded yet";
    return false;
  }
  const text = catalogModule.twinLine ? catalogModule.twinLine(rec) : rec.name;
  const credit = gcatCredit();
  const line = `${compareLead()} vs <strong>${f.esc(text)}</strong>${credit ? ` · ${f.esc(credit)}` : ""}`;
  const cardLine = `Closest real rocket: ${text} · est.`;
  let sil = null;
  const stackR = current.bounds.radius_u;
  if (rec.length_m > 0 && rec.diameter_m > 0) {
    sil = createSilhouette({ name: rec.name, length_m: rec.length_m, diameter_m: rec.diameter_m, stages: rec.stages ?? 2 });
    // To the camera's right, a gap of 0.6 stack radius from the stack's wall.
    const right = new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).setY(0).normalize();
    const off = stackR * 1.6 + sil.radius_u;
    sil.object3d.position.copy(right).multiplyScalar(off);
    root.add(sil.object3d);
    const c = (off + sil.radius_u - stackR) / 2;
    choreo.frameCompare(right.clone().multiplyScalar(c), Math.max(current.bounds.height_u, sil.height_u), (off + sil.radius_u + stackR) / 2);
  }
  twin = { rec, sil, line, cardLine, key: buildKey(current.build) };
  if (anchors?.tower) anchors.tower.visible = false; // the service tower would stand between camera and pair
  hudText.innerHTML = line;
  report("twin", line);
  return true;
}
function hideTwin({ reframe = true } = {}) {
  if (!twin) return;
  if (twin.sil) {
    root.remove(twin.sil.object3d);
    twin.sil.dispose();
  }
  twin = null;
  if (anchors?.tower) anchors.tower.visible = true;
  if (reframe) choreo.frameStack();
  hudText.innerHTML = hudHtml();
}
// The compare line's own side: "<A> · 67.9 m est.".
const compareLead = () => `<strong>${f.esc(current.preset.name)}</strong>${current.modified ? " (modified)" : ""} · ${f.m(current.bounds.height_m)} est.`;

// A preset beside the current rocket (compare chooser): its parts from its own manifest, to the camera's right
// with the twin's spacing, appearing built with the same snap. Not selectable (not in `parts`), shells opaque.
let rival = null;
function showRival(i) {
  if (twin || rival || choreo.state.launch || choreo.state.busy || !isComplete()) return false;
  const other = loadPreset(presetIds[i]);
  const group = new THREE.Group();
  const rparts = other.manifest.map(makePart);
  for (const p of rparts) {
    p.group.traverse((o) => {
      if (o.isLine) o.castShadow = o.receiveShadow = false;
    });
    if (LOOK === "xray") setShellOpacity(p, 0.92);
    group.add(p.group);
  }
  const right = new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).setY(0).normalize();
  const stackR = current.bounds.radius_u;
  const otherR = other.bounds.radius_u;
  const off = stackR * 1.6 + otherR;
  group.position.copy(right).multiplyScalar(off);
  root.add(group);
  // The snap (choreo.appearBuilt): each part drops from 1.2 m × its index into its slot on a spring.
  const gap = 1.2 * SCALE;
  const k = { v: 1 };
  const place = () => rparts.forEach((p, j) => (p.group.position.y = p.slotY + (j + 1) * gap * k.v));
  place();
  const anim = animate(k, { v: 0, ease: spring({ stiffness: 130, damping: 12 }), onUpdate: place });
  const c = (off + otherR - stackR) / 2;
  choreo.frameCompare(right.clone().multiplyScalar(c), Math.max(current.bounds.height_u, other.bounds.height_u), (off + otherR + stackR) / 2);
  const line = `${compareLead()} vs <strong>${f.esc(other.preset.name)}</strong> · ${f.m(other.bounds.height_m)} est.`;
  const cardLine = `vs ${other.preset.name} · ${f.m(other.bounds.height_m)} est.`;
  rival = { group, anim, line, cardLine, key: buildKey(current.build) };
  if (anchors?.tower) anchors.tower.visible = false;
  hudText.innerHTML = line;
  return true;
}
function hideRival({ reframe = true } = {}) {
  if (!rival) return;
  rival.anim.cancel();
  root.remove(rival.group);
  disposeTree(rival.group);
  rival = null;
  if (anchors?.tower) anchors.tower.visible = true;
  if (reframe) choreo.frameStack();
  hudText.innerHTML = hudHtml();
}
function clearCompare(opts) {
  hideTwin(opts);
  hideRival(opts);
}
// C: the compare chooser, or clear what is being compared.
function toggleCompare() {
  if (twin || rival) return clearCompare();
  if (!rocketsEl.hidden && rocketsMode === "compare") return setRocketsOpen(false);
  if (choreo.state.launch || choreo.state.busy || !isComplete()) return;
  setRocketsOpen(true, "compare");
}

// ---------- result card (design H32) ----------
// Key S saves "rocket-card.png": the current view rendered once at 1600×900 through a private offscreen
// composer (render → bloom → the same output pass, so tone mapping and colours match the page; read back from
// a half-float target, no preserveDrawingBuffer), composed on a 2D canvas with the preset, the verdict line, the
// stage list, payload and mission, the twin line if shown, and a line pointing to the sources.
const CARD_W = 1600;
const CARD_H = 900;
const FONT = '"Inter", "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';
function renderView(type) {
  const rt = new THREE.WebGLRenderTarget(CARD_W, CARD_H, { type });
  const comp = new EffectComposer(renderer, rt);
  comp.renderToScreen = false;
  comp.addPass(new RenderPass(scene, camera));
  if (!lite) comp.addPass(new UnrealBloomPass(new THREE.Vector2(CARD_W, CARD_H), 0.36, 0.55, 0.8));
  comp.addPass(new OutputPass());
  const aspect = camera.aspect;
  camera.aspect = CARD_W / CARD_H;
  // Shift the view right so the rocket stands clear of the reading panel on the left.
  camera.setViewOffset(CARD_W, CARD_H, -CARD_W * 0.22, 0, CARD_W, CARD_H);
  camera.updateProjectionMatrix();
  try {
    comp.render();
    const out = comp.readBuffer;
    const half = type === THREE.HalfFloatType;
    const raw = half ? new Uint16Array(CARD_W * CARD_H * 4) : new Uint8Array(CARD_W * CARD_H * 4);
    renderer.readRenderTargetPixels(out, 0, 0, CARD_W, CARD_H, raw);
    const img = new ImageData(CARD_W, CARD_H);
    for (let y = 0; y < CARD_H; y++) {
      const src = (CARD_H - 1 - y) * CARD_W * 4; // GL rows run bottom-up
      const dst = y * CARD_W * 4;
      for (let i = 0; i < CARD_W * 4; i++) {
        const v = half ? THREE.DataUtils.fromHalfFloat(raw[src + i]) * 255 : raw[src + i];
        img.data[dst + i] = (i & 3) === 3 ? 255 : Math.max(0, Math.min(255, v + 0.5));
      }
    }
    return img;
  } finally {
    camera.clearViewOffset();
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    comp.dispose();
    rt.dispose();
  }
}
const plain = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent;
};
async function makeCardCanvas() {
  let img;
  try {
    img = renderView(THREE.HalfFloatType);
  } catch {
    img = renderView(THREE.UnsignedByteType); // no half-float readback on this GPU
  }
  const cv = document.createElement("canvas");
  cv.width = CARD_W;
  cv.height = CARD_H;
  const g = cv.getContext("2d");
  g.putImageData(img, 0, 0);
  // Reading panel on the left, same surface as the page's card.
  const shade = g.createLinearGradient(0, 0, 820, 0);
  shade.addColorStop(0, "rgba(11, 13, 18, 0.88)");
  shade.addColorStop(0.75, "rgba(11, 13, 18, 0.55)");
  shade.addColorStop(1, "rgba(11, 13, 18, 0)");
  g.fillStyle = shade;
  g.fillRect(0, 0, 820, CARD_H);
  const { preset, build, verdict, bounds, modified } = current;
  const text = (s, x, y, font, color) => {
    g.font = font;
    g.fillStyle = color;
    g.fillText(s, x, y);
    return g.measureText(s).width;
  };
  let y = 96;
  g.textBaseline = "alphabetic";
  text("ROCKET ASSEMBLY", 64, y - 38, `600 15px ${FONT}`, "#a9adb8");
  const w = text(preset.name, 64, y, `650 40px ${FONT}`, "#f6f7fb");
  if (modified) text("(modified)", 64 + w + 14, y, `450 24px ${FONT}`, "#ffb48a");
  // Verdict line (or the build tally), coloured like the HUD.
  y += 46;
  if (isComplete()) {
    const bits = [`${f.m(bounds.height_m)} est.`, f.t(verdict.totalMass_kg), `Δv ${f.num(verdict.totalDeltaV_ms, 0)} / ${f.ms(verdict.requiredDeltaV_ms)}`, `TWR ${f.twr(verdict.liftoffTWR)}`];
    let x = 64;
    x += text(bits.join(" · ") + " · ", x, y, `500 19px ${MONO}`, "#a9adb8");
    const go = verdict.feasible;
    x += text(go ? "GO" : "NO-GO", x, y, `700 19px ${MONO}`, go ? "#2ee6b6" : "#ff6a3d");
    const n = verdict.warnings.length;
    if (!go && n) text(` · ${n} warning${n === 1 ? "" : "s"}`, x, y, `500 19px ${MONO}`, "#a9adb8");
  } else {
    text(plain(hudText.innerHTML), 64, y, `500 19px ${MONO}`, "#a9adb8");
  }
  if (telemetry.final) {
    y += 32;
    text(plain(telemetry.final), 64, y, `600 19px ${MONO}`, "#ffb48a");
  }
  // Stages, payload, mission: straight from the records.
  y += 64;
  g.fillStyle = "rgba(255, 180, 138, 0.6)";
  g.fillRect(64, y - 30, 48, 2);
  build.stages.forEach((st, i) => {
    const e = catalog.engines.find((x) => x.id === st.engineId);
    const k = catalog.tanks.find((x) => x.id === st.tankId);
    text(`Stage ${i + 1}`, 64, y, `600 20px ${FONT}`, "#a9adb8");
    text(`${st.engineCount} × ${e?.name ?? st.engineId}`, 184, y, `600 20px ${FONT}`, "#f6f7fb");
    text(k?.name ?? st.tankId, 184, y + 26, `450 17px ${FONT}`, "#a9adb8");
    y += 66;
  });
  const payload = catalog.payloads.find((x) => x.id === build.payloadId);
  const mission = catalog.missions.find((x) => x.id === build.missionId);
  text("Payload", 64, y, `600 20px ${FONT}`, "#a9adb8");
  text(payload?.name ?? build.payloadId, 184, y, `600 20px ${FONT}`, "#f6f7fb");
  y += 40;
  text("Mission", 64, y, `600 20px ${FONT}`, "#a9adb8");
  text(`${mission?.name ?? build.missionId} · ${f.ms(mission?.requiredDeltaV_ms ?? 0)} required`, 184, y, `600 20px ${FONT}`, "#f6f7fb");
  if (twin ?? rival) {
    y += 52;
    text((twin ?? rival).cardLine, 64, y, `500 17px ${MONO}`, "#ffb48a");
  }
  // Footer: where the numbers come from.
  const credit = twin ? ` · ${gcatCredit()}` : "";
  text(`numbers: see source links in the demo${credit}`, 64, CARD_H - 40, `450 14px ${FONT}`, "#a9adb8");
  return cv;
}
async function saveCard() {
  if (choreo.state.busy && !choreo.state.launch) return; // mid-animation frames make a poor card
  const cv = await makeCardCanvas();
  const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "rocket-card.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- story mode (design H31) ----------
// P or ?story=1: the whole pitch hands-free. Falcon 9 → Build all → verdict → the stage-2 tank's card and
// Options → the first "unusual" option (the verdict changes) → back to the original → Launch → orbit →
// back on the pad beside its real twin → a slow orbit around both. Any key or click hands control back.
const story = { active: false, cancel: null };
const CANCELLED = Symbol("story cancelled");
async function runStory() {
  if (story.active) return;
  story.active = true;
  const cancelled = new Promise((_, reject) => (story.cancel = () => reject(CANCELLED)));
  cancelled.catch(() => {});
  const timers = new Set();
  const step = (p) => Promise.race([p, cancelled]);
  const hold = (ms) => step(new Promise((r) => timers.add(setTimeout(r, ms))));
  const until = (test, every = 120) =>
    step(
      new Promise((r) => {
        const t = setInterval(() => {
          if (!test()) return;
          clearInterval(t);
          r();
        }, every);
        timers.add(t);
      }),
    );
  try {
    clearCompare({ reframe: false });
    setRocketsOpen(false);
    if (current.preset.id !== "falcon-9" || current.modified) switchPreset(presetIds.indexOf("falcon-9") - presetIndex, { built: false });
    else if (parts.some((p) => p.built) || choreo.state.launch) choreo.reset();
    await hold(300);
    await step(choreo.buildAll());
    await until(() => isComplete() && !choreo.state.busy && !choreo.state.auto);
    await hold(700);

    // The stage-2 tank: card, Options, the first unusual alternative, then back.
    const slot = () => parts.find((p) => p.kind === "tank" && p.stageIndex === 1) ?? parts.find((p) => p.kind === "tank");
    const original = slot().record.id;
    selector.select(slot());
    await hold(600);
    card.el.querySelector(".opt-toggle")?.click();
    await hold(600);
    const alts = optionsWithCompat(current.build, catalog, "tank", slot().stageIndex);
    const pick = alts.find((o) => o.level === "unusual" && o.record.id !== original) ?? alts.find((o) => o.level === "ok" && o.record.id !== original);
    if (pick) {
      await step(chooseOption(slot(), pick.record.id));
      await hold(900);
      card.el.querySelector(".opt-toggle")?.click();
      await hold(600);
      await step(chooseOption(slot(), original));
      await hold(500);
    }
    selector.clear();

    // Launch (a shorter countdown in the story), watch it to the outcome, hold.
    launch({ countdown: 1.5, brief: true }); // no pad camera: the story stays within 45 s
    await until(() => choreo.state.launch === "done");
    await until(() => !choreo.state.ending && !choreo.state.deploying); // the planet ending (≤ 8 s)
    await hold(600);

    // Back on the pad beside its closest real twin, then a slow orbit around both.
    choreo.returnToPad();
    await hold(700);
    showTwin();
    await hold(800);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
  } catch (e) {
    if (e !== CANCELLED) throw e;
  } finally {
    for (const t of timers) clearTimeout(t), clearInterval(t);
    story.active = false;
    story.cancel = null;
  }
}
// A real key press or click (not the story's own actions) hands control back.
const cancelStory = (e) => {
  if (story.active && e.isTrusted) {
    story.cancel?.();
    story.cancelledAt = performance.now();
  }
};
// The story's end state, at once: Falcon 9 built on the pad, its twin beside it, a slow orbit.
function showStoryEnd() {
  choreo.reset();
  if (current.preset.id !== "falcon-9" || current.modified) switchPreset(presetIds.indexOf("falcon-9") - presetIndex);
  else choreo.appearBuilt();
  setTimeout(() => {
    if (choreo.state.busy) choreo.skip();
    showTwin();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
  }, 900);
}

// ---------- skip: double-click / double-tap on the canvas finishes the running animation ----------
function skipNow() {
  if (performance.now() - (story.cancelledAt ?? -1e9) < 900) {
    story.cancelledAt = -1e9;
    return showStoryEnd();
  }
  const what = choreo.skip();
  if (what === "settled" && swapping) {
    swapping = false;
    shown = null;
  }
  if (what) syncUi();
}
canvas.addEventListener("dblclick", (e) => {
  if (landingOn()) return;
  e.preventDefault();
  skipNow();
});
let lastTap = null; // double-tap: two touch taps within 320 ms and 30 px
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch" || landingOn()) return;
  const now = performance.now();
  if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    skipNow();
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});
addEventListener("keydown", cancelStory, true);
addEventListener("pointerdown", cancelStory, true);

function onPartKey(part) {
  if (part.built) {
    if (choreo.isTopBuilt(part)) choreo.remove(part);
  } else {
    choreo.buildUpTo(part);
  }
}

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (landingOn()) {
    if (!e.repeat && !["Shift", "Control", "Alt", "Meta", "Tab"].includes(e.key)) {
      e.preventDefault();
      landing.enter(); // any key flies the rest of the way down
    }
    return; // nothing else until the builder has taken over
  }
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key === "Escape" && !rocketsEl.hidden) return setRocketsOpen(false);
  if (e.key === "Escape" && (twin || rival)) return clearCompare();
  // After a launch the final frame holds (HUD outcome line) until R, Esc or a double-click.
  if (e.key === "Escape" && choreo.state.launch === "done" && !choreo.state.ending) {
    choreo.skip();
    return syncUi();
  }
  const k = e.key.toLowerCase();
  const byKey = parts.find((p) => p.key === k);
  if (byKey) return onPartKey(byKey);
  if (k === " ") {
    e.preventDefault();
    if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
    choreo.toggleExplode();
  } else if (k === "b") choreo.buildAll();
  else if (k === "r") reset();
  else if (k === "l") launch();
  else if (k === "c") toggleCompare();
  else if (k === "s") saveCard();
  else if (k === "x") setPropLook(pad.group, choreo.toggleLookAll() === "clear" ? "xray" : "painted"); // pad and anchors follow the build
  else if (k === "p") runStory();
  else if (k === "[") switchPreset(-1);
  else if (k === "]") switchPreset(1);
});

// ---------- landing page (first load without ?build / ?story / ?skip / ?demo) ----------
// The scroll-driven dive from orbit to the pad (ui/landing.js): scroll or drag to descend, click or any key to
// fly the whole way. Once it hands over, the builder runs as usual; scrolling up with nothing built (at rest)
// takes it back up. `landing` stays null when the page opens straight into the builder.
let landing = null;
const landingOn = () => Boolean(landing?.on);
function startLanding() {
  landing = createLanding({
    scene,
    camera,
    controls,
    root,
    stars,
    canvas,
    groundY: () => -pad.layout.plinthH,
    groundMap: () => pad.ground,
    endPose: () => choreo.homePose(choreo.landingView.az),
    view: choreo.landingView,
    onState: (on) => {
      if (on) {
        selector.clear();
        setRocketsOpen(false);
      } else syncUi();
    },
  });
}
// Back up to the landing: a scroll up over the canvas while the builder is at rest with nothing built.
const canLeaveBuilder = () =>
  landing && !landing.on && !story.active && rocketsEl.hidden && !choreo.state.busy && !choreo.state.auto && !choreo.state.launch && !choreo.state.exploded && parts.every((p) => !p.built);
addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.deltaY >= 0 || e.target !== canvas || !canLeaveBuilder()) return;
    e.preventDefault();
    e.stopPropagation(); // OrbitControls would zoom in
    scene.background = BG; // the landing paints its own sky (the world layer is off while it runs)
    landing.resume();
    landing.feed(landing.wheelPx(e));
  },
  { capture: true, passive: false },
);

const unlock = () => {
  sfx.unlock();
  removeEventListener("pointerdown", unlock);
  removeEventListener("keydown", unlock);
};
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

// ---------- loop ----------
choreo.prewarm(renderer);
// The planets' maps load after the warm-up: upload them as soon as they arrive, not on the frame they first show.
const loaded = THREE.DefaultLoadingManager.onLoad;
THREE.DefaultLoadingManager.onLoad = () => {
  loaded?.();
  const worldMaps = [];
  world.scene.traverse((o) => {
    for (const u of Object.values(o.material?.uniforms ?? {})) if (u.value?.isTexture) worldMaps.push(u.value);
  });
  choreo.uploadWarmTextures(worldMaps); // spread over frames, one texture each
};
const landingMode = !["build", "story", "skip", "demo"].some((k) => query.has(k));
if (landingMode) startLanding();
else choreo.home();
syncUi();
announce();

// Luxury budget (GTAO, DoF): frame times are averaged over 2 s windows while either is on; a slow window drops
// the DoF for the session if it was on, else GTAO. The first window after load is skipped (shader compiles and
// uploads land there).
const perf = { gtaoOk: true, dofOk: true, sum: 0, n: 0, windows: 0, dofSeen: false };
const animating = () => {
  const s = choreo.state;
  return s.busy > 0 || s.auto || s.scrubbing || Boolean(s.launch) || landingOn();
};
function luxuryBudget(rawDt) {
  if (!gtao) return;
  gtao.enabled = perf.gtaoOk && !animating();
  if (!gtao.enabled && !dof?.enabled) {
    perf.sum = perf.n = 0;
    perf.dofSeen = false;
    return;
  }
  perf.sum += rawDt;
  perf.n++;
  perf.dofSeen ||= Boolean(dof?.enabled);
  if (perf.sum < 2) return;
  if (perf.windows++ > 0 && perf.sum / perf.n > 0.022) {
    if (perf.dofSeen) perf.dofOk = false;
    else perf.gtaoOk = false;
  }
  perf.sum = perf.n = 0;
  perf.dofSeen = false;
}
// DoF: in on a part focus at rest (the card open) and in flight on the vehicle; out everywhere else. Focus at the
// orbit target; the aperture puts the full (small) blur at twice the focus distance.
let dofK = 0;
function updateDof(dt) {
  if (!dof) return;
  const s = choreo.state;
  const flying = s.launch === "flying" || Boolean(s.ending);
  const focused = choreo.framing().mode === "focus" && !s.launch && !animating();
  const want = perf.dofOk && !landingOn() && (flying || focused);
  dofK += ((want ? 1 : 0) - dofK) * (1 - Math.exp(-dt / 0.15));
  dof.enabled = dofK > 0.01;
  if (!dof.enabled) return;
  const d = camera.position.distanceTo(controls.target);
  const maxblur = flying ? 0.0025 : 0.004;
  dof.uniforms.focus.value = d;
  dof.uniforms.maxblur.value = maxblur;
  dof.uniforms.aperture.value = (dofK * 0.8 * maxblur) / Math.max(0.5, d);
}

const band = { near: null, far: null }; // fog band widths, eased
const FOG0 = scene.fog.color.clone();
const STAR0 = stars.material.opacity;
let hadSky = false;
// The fade through black between the ending's scenes (choreo.state.cut): over the canvas, under the page UI.
const cutEl = document.createElement("div");
cutEl.className = "cut";
canvas.after(cutEl);

const clock = new THREE.Clock();
function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  const t = clock.elapsedTime;
  luxuryBudget(rawDt);
  // The far layer draws only in flight; at home it just clears to the builder's background (UI4's setEnabled),
  // and the landing dive draws its own sky over a cleared near pass.
  const worldOn = !landingOn() && Boolean(choreo.state.launch);
  world.setEnabled(worldOn);
  scene.background = landingOn() ? BG : null;
  stars.visible = !worldOn; // the world draws its own
  if (worldPass) worldPass.enabled = !landingOn();
  if (nearPass) nearPass.clear = landingOn();
  choreo.update(dt, t);
  landing?.update(dt, t);
  if (!landingOn()) controls.update(); // its polar/distance clamps would bend the dive's path
  choreo.postUpdate();
  shelf.update(dt);
  // Depth cue: fog (background colour) in a band around the orbit target, sized by what is framed, so the far
  // side of the rocket and its far lines fade toward black while the near silhouette stays bright.
  // The band is wide at home and while building (the pad stays visible) and tight on a focus or exploded view.
  // Its widths ease over ~0.5 s when the framing changes (no fog jump); on a black cut frame they snap.
  const black = choreo.state.cut >= 1;
  const { r: R, mode } = choreo.framing();
  const goalNear = 0.6 * R;
  const goalFar = (mode === "focus" || mode === "exploded" ? 3 : 6) * R;
  const kb = band.near == null || black ? 1 : 1 - Math.exp(-dt / 0.15);
  band.near = band.near == null ? goalNear : band.near + (goalNear - band.near) * kb;
  band.far = band.far == null ? goalFar : band.far + (goalFar - band.far) * kb;
  const dist = camera.position.distanceTo(controls.target);
  const open = landing?.fogOpen ?? 0; // the landing's dive opens the band wide (ground map, cloud deck)
  scene.fog.near = Math.max(0.1, THREE.MathUtils.lerp(dist - band.near, dist * 0.5, open));
  scene.fog.far = THREE.MathUtils.lerp(dist + band.far, dist * 8, open);
  // A launch's sky (choreo.state.sky): fog in the horizon's colour, opened with the climb; stars by the sky.
  const sky = choreo.state.sky;
  if (sky) {
    scene.fog.near = THREE.MathUtils.lerp(scene.fog.near, sky.near, sky.w);
    scene.fog.far = THREE.MathUtils.lerp(scene.fog.far, sky.far, sky.w);
    scene.fog.color.copy(FOG0).lerp(sky.horizon, sky.w);
    stars.material.opacity = STAR0 * THREE.MathUtils.lerp(1, sky.stars, sky.w);
    hadSky = true;
  } else if (hadSky) {
    scene.fog.color.copy(FOG0);
    stars.material.opacity = STAR0;
    hadSky = false;
  }
  placeShadow(dt, black);
  updateContact(dt);
  updateDof(dt);
  if (cutEl.style.opacity !== String(choreo.state.cut)) cutEl.style.opacity = String(choreo.state.cut);
  if (pad?.ringMat) pad.ringMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.6));
  twin?.sil?.update(camera);
  anchors?.update(t);
  if (worldOn) {
    const v = choreo.viewer();
    if (v) world.setViewer({ body: "earth", pos_km: v.pos_km, camera, frame: v.frame });
    else {
      viewerKm.copy(PAD_KM).add(choreo.nearOriginKm()).addScaledVector(camera.position, 1 / (1000 * SCALE));
      world.setViewer({ body: "earth", pos_km: viewerKm, camera });
    }
  }
  if (composer) composer.render();
  else {
    if (worldOn) world.render(renderer);
    renderer.autoClear = !worldOn;
    renderer.render(scene, camera);
    renderer.autoClear = true;
  }
  requestAnimationFrame(frame);
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);
if (query.get("story") === "1") setTimeout(() => runStory(), 900);
