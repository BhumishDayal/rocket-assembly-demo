import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import * as catalogModule from "./data/catalog.js";
import { catalog, presetIds, getPreset, presetToBuild, applyOption } from "./data/catalog.js";
import { evaluateBuild, stageDetails, stackMass_kg } from "./physics.js";
import { optionsWithCompat } from "./compat.js";
import { simulateAscent } from "./ascent.js";
import { createSilhouette } from "./silhouette.js";
import { createAnchors } from "./anchors.js";
import { SCALE, buildManifest, sceneBounds } from "./layout.js";
import { createMaterials, createPart, createPad, createStars } from "./parts.js";
import { createChoreographer } from "./choreo.js";
import { createSfx } from "./fx/sfx.js";
import { createSelector } from "./ui/select.js";
import { createCard } from "./ui/card.js";
import { createScrub } from "./ui/scrub.js";
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
  if (pad?.baseRadius_u !== b.baseRadius_u) {
    if (pad) {
      root.remove(pad.group);
      disposeTree(pad.group);
    }
    pad = { ...createPad({ baseRadius_u: b.baseRadius_u }), baseRadius_u: b.baseRadius_u };
    root.add(pad.group);
  }
  // Anchors are sized from the stack height too, so they follow every preset/option change. They hang on the
  // pad group, so they drop away with the pad in flight.
  anchors?.dispose();
  anchors = createAnchors({ baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u });
  pad.group.add(anchors.object3d);
}
applyBounds(current.bounds);

// ---------- parts ----------
const materials = createMaterials();
const makePart = (spec) => createPart(spec, materials);
let parts = current.manifest.map(makePart);
const sfx = createSfx();
const choreo = createChoreographer({ parts, scene, root, camera, controls, sfx, onChange: syncUi, scale: SCALE, bounds: current.bounds, makePart });

// ---------- post ----------
// GTAO skips what writes no depth (holograms, flashes, the pad ring, x-ray shells), so they never darken the
// stack. It runs at half resolution (the AO is soft anyway) and is a luxury: off while anything animates,
// off on stacks over 230 pieces, and off for the session if frames average over 22 ms (see frame()).
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
let composer = null;
let gtao = null;
if (!lite) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const pr = renderer.getPixelRatio();
  gtao = new SolidGTAOPass(scene, camera, innerWidth * pr, innerHeight * pr);
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
    options: part?.record ? optionsWithCompat(ctx.build, catalog, part.kind, part.stageIndex) : [],
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
    choreo.state.launch
      ? null // nothing to inspect in flight
      : part?.kind === "fairing" && !choreo.state.exploded
        ? parts.find((p) => p.kind === "payload" && p.built) ?? part
        : part,
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
const btnRockets = document.getElementById("btn-rockets");
const rocketsEl = document.getElementById("rockets");
const btnBuildAll = document.getElementById("btn-build-all");
const btnExplode = document.getElementById("btn-explode");
const btnReset = document.getElementById("btn-reset");
const btnSound = document.getElementById("btn-sound");
const hudText = document.getElementById("hud-text");

// Build all becomes Launch once the stack is complete.
btnBuildAll.addEventListener("click", () => (isComplete() ? launch() : choreo.buildAll()));

// Rockets: the presets as an in-place list above the bar. One line each: name, stages, height est.,
// payload → mission (all from the records and the layout). Choosing one loads it and builds it.
function rocketsHtml() {
  const rows = presetIds.map((id, i) => {
    const p = getPreset(id);
    const b = presetToBuild(p);
    const height = sceneBounds(buildManifest(b, catalog)).height_m;
    const payload = catalog.payloads.find((x) => x.id === b.payloadId);
    const mission = catalog.missions.find((x) => x.id === b.missionId);
    const n = b.stages.length;
    const meta = `${n} stage${n === 1 ? "" : "s"} · ${f.m(height)} est. · ${payload?.name ?? b.payloadId} → ${mission?.name ?? b.missionId}`;
    const cur = i === presetIndex && !current.modified;
    return `<li><button type="button" class="opt" data-i="${i}"${cur ? ' aria-current="true"' : ""}><span class="opt-name">${f.esc(p.name)}</span><span class="opt-meta" title="${f.esc(meta)}">${f.esc(meta)}</span></button></li>`;
  });
  return `<ul>${rows.join("")}</ul>`;
}
function setRocketsOpen(open) {
  if (open === !rocketsEl.hidden) return;
  if (open) {
    selector.clear(); // one panel at a time (the card is a bottom sheet on phones)
    rocketsEl.innerHTML = rocketsHtml();
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
  setRocketsOpen(false);
  switchPreset(Number(opt.dataset.i) - presetIndex);
  choreo.buildAll();
});
addEventListener("pointerdown", (e) => {
  if (!rocketsEl.hidden && !e.target.closest("#rockets, #btn-rockets")) setRocketsOpen(false);
});
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
  const launched = Boolean(choreo.state.launch);
  btnBuildAll.textContent = built === parts.length ? "Launch" : "Build all";
  btnBuildAll.disabled = busy > 0 || exploded || launched;
  btnExplode.disabled ||= launched;
  if (twin && (twin.key !== buildKey(current.build) || launched || busy > 0)) hideTwin({ reframe: false });
  if (launched) {
    if (telemetry.final) hudText.innerHTML = telemetry.final;
  } else if (twin) hudText.innerHTML = twin.line;
  else if (!swapping) hudText.innerHTML = hudHtml();
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
  if (!rocketsEl.hidden) rocketsEl.innerHTML = rocketsHtml();
  const q = new URLSearchParams(location.search);
  q.set("build", current.preset.id);
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

// Reset means reset: back to the empty pad and, if Options changed the build, the pristine preset.
function reset() {
  if (current.modified) switchPreset(0);
  else choreo.reset();
}

// ---------- launch ----------
// One ascent simulation per launch (ascent.js; every number it shows is an estimate), played by choreo.
const telemetry = { final: null, last: 0 };
const pad2 = (n) => String(Math.floor(n)).padStart(2, "0");
function telemetryHtml(tel) {
  if (tel.countdown != null) return `<strong>${f.esc(current.preset.name)}</strong> · <strong>T−${tel.countdown}</strong>`;
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
let lastSim = null;
function onTelemetry(tel) {
  if (tel.final) {
    telemetry.final = outcomeHtml(tel);
    hudText.innerHTML = telemetry.final;
    return;
  }
  const now = performance.now();
  if (now - telemetry.last < 80) return;
  telemetry.last = now;
  hudText.innerHTML = telemetryHtml(tel);
}
async function launch() {
  if (!isComplete() || choreo.state.busy || choreo.state.launch) return;
  setRocketsOpen(false);
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  const sim = simulateAscent(current.build, catalog);
  if (!sim.samples.length) {
    hudText.innerHTML = `<strong class="nogo">Cannot fly</strong> · ${f.esc(sim.summary.error ?? "no trajectory")}`;
    return;
  }
  lastSim = sim;
  telemetry.final = null;
  selector.clear();
  choreo.launch(sim, { pad: pad.group, onTelemetry });
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
  if (twin || choreo.state.launch || choreo.state.busy || !isComplete()) return false;
  const rec = twinRecord();
  if (!rec) {
    hudText.innerHTML = "Closest real rocket: data not loaded yet";
    return false;
  }
  const text = catalogModule.twinLine ? catalogModule.twinLine(rec) : rec.name;
  const credit = gcatCredit();
  const line = `Closest real rocket: <strong>${f.esc(text)}</strong> · est.${credit ? ` · ${f.esc(credit)}` : ""}`;
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
  twin = { rec, sil, line, key: buildKey(current.build) };
  hudText.innerHTML = line;
  return true;
}
function hideTwin({ reframe = true } = {}) {
  if (!twin) return;
  if (twin.sil) {
    root.remove(twin.sil.object3d);
    twin.sil.dispose();
  }
  twin = null;
  if (reframe) choreo.frameStack();
  hudText.innerHTML = hudHtml();
}
const toggleTwin = () => (twin ? hideTwin() : showTwin());

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
    hideTwin({ reframe: false });
    setRocketsOpen(false);
    if (current.preset.id !== "falcon-9" || current.modified) switchPreset(presetIds.indexOf("falcon-9") - presetIndex);
    else if (parts.some((p) => p.built) || choreo.state.launch) choreo.reset();
    await hold(900);
    await step(choreo.buildAll());
    await until(() => isComplete() && !choreo.state.busy && !choreo.state.auto);
    await hold(2000);

    // The stage-2 tank: card, Options, the first unusual alternative, then back.
    const slot = () => parts.find((p) => p.kind === "tank" && p.stageIndex === 1) ?? parts.find((p) => p.kind === "tank");
    const original = slot().record.id;
    selector.select(slot());
    await hold(1400);
    card.el.querySelector(".opt-toggle")?.click();
    await hold(1500);
    const alts = optionsWithCompat(current.build, catalog, "tank", slot().stageIndex);
    const pick = alts.find((o) => o.level === "unusual" && o.record.id !== original) ?? alts.find((o) => o.level === "ok" && o.record.id !== original);
    if (pick) {
      await step(chooseOption(slot(), pick.record.id));
      await hold(2000);
      card.el.querySelector(".opt-toggle")?.click();
      await hold(1200);
      await step(chooseOption(slot(), original));
      await hold(1200);
    }
    selector.clear();
    await hold(600);

    // Launch, watch it to the outcome, hold.
    launch();
    await until(() => choreo.state.launch === "done");
    await hold(3000);

    // Back on the pad beside its closest real twin, then a slow orbit around both.
    choreo.returnToPad();
    await hold(1300);
    showTwin();
    await hold(1600);
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
  if (story.active && e.isTrusted) story.cancel?.();
};
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
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key === "Escape" && !rocketsEl.hidden) return setRocketsOpen(false);
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
  else if (k === "l") launch();
  else if (k === "c") toggleTwin();
  else if (k === "p") runStory();
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

// GTAO budget: frame times are averaged over 2 s windows while it is on; one slow window drops it for the
// session. The first window after load is skipped (shader compiles and uploads land there).
const GTAO_MAX_PIECES = 230;
const perf = { gtaoOk: true, sum: 0, n: 0, windows: 0 };
const pieceCount = () => parts.reduce((n, p) => n + p.pieces.length, 0);
function gtaoBudget(rawDt) {
  if (!gtao) return;
  gtao.enabled = perf.gtaoOk && choreo.state.busy === 0 && pieceCount() <= GTAO_MAX_PIECES;
  if (!gtao.enabled) {
    perf.sum = perf.n = 0;
    return;
  }
  perf.sum += rawDt;
  perf.n++;
  if (perf.sum < 2) return;
  if (perf.windows++ > 0 && perf.sum / perf.n > 0.022) perf.gtaoOk = false;
  perf.sum = perf.n = 0;
}

const clock = new THREE.Clock();
function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  const t = clock.elapsedTime;
  gtaoBudget(rawDt);
  choreo.update(dt, t);
  controls.update();
  // Depth cue: fog (background colour) in a band around the orbit target, sized by what is framed, so the far
  // side of the rocket and its far lines fade toward black while the near silhouette stays bright.
  // The band is wide at home and while building (the pad stays visible) and tight on a focus or exploded view.
  const { r: R, mode } = choreo.framing();
  const dist = camera.position.distanceTo(controls.target);
  scene.fog.near = Math.max(0.1, dist - 0.6 * R);
  scene.fog.far = dist + (mode === "focus" || mode === "exploded" ? 3 : 6) * R;
  if (pad?.ringMat) pad.ringMat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.6));
  twin?.sil?.update(camera);
  anchors?.update(t);
  if (composer) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);
if (query.get("story") === "1") setTimeout(() => runStory(), 900);
