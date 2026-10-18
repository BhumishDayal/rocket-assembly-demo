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
import { arrivalTimeline } from "./arrival.js";
import { createSilhouette } from "./silhouette.js";
import { createAnchors } from "./anchors.js";
import { createPlanet } from "./planet.js";
import { animate } from "animejs";
import { SCALE, buildManifest, sceneBounds } from "./layout.js";
import { createMaterials, createPart, createPad, createStars } from "./parts.js";
import { createChoreographer } from "./choreo.js";
import { createSfx } from "./fx/sfx.js";
import { createSelector } from "./ui/select.js";
import { createCard } from "./ui/card.js";
import { createScrub } from "./ui/scrub.js";
import { ensureShell } from "./ui/shell.js";
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
  anchors = createAnchors({ baseRadius_u: b.baseRadius_u, stackHeight_u: b.height_u, manifest: current.manifest });
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
    choreo.state.launch || landing
      ? null
      : part?.kind === "fairing" && part.look === "clear" && !choreo.state.exploded
        ? parts.find((p) => p.kind === "payload" && p.built) ?? part
        : part,
  // Every click on a part flips its look (opaque ↔ clear); empty space only deselects.
  onPick: (part) => choreo.toggleLook(part),
  onGhostClick(part) {
    if (landing) return;
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

// Switching rockets ([ ], the Rockets list) shows the new one built (one snap); reset and the story start empty.
function switchPreset(step, { built = true } = {}) {
  presetIndex = (presetIndex + step + presetIds.length) % presetIds.length;
  current = loadPreset(presetIds[presetIndex]);
  selector.clear();
  hovered = null;
  parts = current.manifest.map(makePart);
  applyBounds(current.bounds);
  choreo.setBounds(current.bounds);
  selector.setParts(parts);
  choreo.rebuild(parts);
  if (built) choreo.appearBuilt();
  if (!rocketsEl.hidden) rocketsEl.innerHTML = rocketsHtml();
  const q = new URLSearchParams(location.search);
  q.set("build", current.preset.id);
  history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
}

// Reset means reset: back to the empty pad and, if Options changed the build, the pristine preset.
function reset() {
  if (current.modified) switchPreset(0, { built: false });
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
  if (tel.ending) {
    const html = tel.final ? endingFinalHtml(tel.arrival, tel.booster) : endingLegHtml(tel.leg);
    if (tel.final) telemetry.final = html;
    hudText.innerHTML = html;
    return;
  }
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
async function launch({ countdown } = {}) {
  if (!isComplete() || choreo.state.busy || choreo.state.launch) return;
  setRocketsOpen(false);
  if (choreo.state.exploded && !(await choreo.assemble())) return;
  const sim = simulateAscent(current.build, catalog);
  // A verdict with a blocking warning never flies (ascent.js says "blocked"): a pad abort line for 3 s, no sim.
  if (sim.summary.outcome === "blocked" || !sim.samples.length) {
    const why = sim.summary.reason ?? sim.summary.blockedBy ?? sim.summary.error ?? "no trajectory";
    hudText.innerHTML = `<strong class="nogo">Pad abort</strong> · ${f.esc(why)}`;
    clearTimeout(launch.abortTimer);
    launch.abortTimer = setTimeout(() => syncUi(), 3000);
    return;
  }
  lastSim = sim;
  telemetry.final = null;
  selector.clear();
  const arrival = arrivalTimeline(current.build, catalog, sim.summary);
  choreo.launch(sim, { pad: pad.group, anchors, onTelemetry, arrival, countdown });
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
  if (anchors?.tower) anchors.tower.visible = false; // the service tower would stand between camera and pair
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
  if (anchors?.tower) anchors.tower.visible = true;
  if (reframe) choreo.frameStack();
  hudText.innerHTML = hudHtml();
}
const toggleTwin = () => (twin ? hideTwin() : showTwin());

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
  if (twin) {
    y += 52;
    text(plain(twin.line).split(" · GCAT")[0], 64, y, `500 17px ${MONO}`, "#ffb48a");
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
    hideTwin({ reframe: false });
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
    launch({ countdown: 1.5 });
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
  if (landing) return;
  e.preventDefault();
  skipNow();
});
let lastTap = null; // double-tap: two touch taps within 320 ms and 30 px
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch" || landing) return;
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
  if (landing) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enterFromLanding();
    }
    return; // nothing else until the user has entered
  }
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key === "Escape" && !rocketsEl.hidden) return setRocketsOpen(false);
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
  else if (k === "c") toggleTwin();
  else if (k === "s") saveCard();
  else if (k === "x") choreo.toggleLookAll();
  else if (k === "p") runStory();
  else if (k === "[") switchPreset(-1);
  else if (k === "]") switchPreset(1);
});

// ---------- landing page (first load without ?build / ?story / ?skip / ?demo) ----------
// The Earth (UI4's planet.js) large in the lower half, a big title and one button; bar, HUD and hint hidden.
// The globe sits right under the pad, so "Build a rocket" is one continuous descent from orbit to the home
// shot: the pad group appears once the camera is above the deck, the planet sinks away under the ground, and
// the UI fades in. The landing DOM is created here and removed after entering.
const LANDING_R = 40;
const LANDING_AZ = 0.58; // the home view's azimuth
let landing = null;
function startLanding() {
  document.body.classList.add("landing");
  const planet = createPlanet({ kind: "earth", radius_u: LANDING_R });
  planet.object3d.position.set(0, -LANDING_R - 0.2, 0); // the pad stands on its north pole
  planet.setSunDir?.(new THREE.Vector3(-0.85, 0.35, -0.2).normalize());
  scene.add(planet.object3d);
  root.visible = false;
  controls.enabled = false;
  const c = planet.object3d.position;
  const off = new THREE.Vector3(0, 0.62 * LANDING_R, 2.05 * LANDING_R).applyAxisAngle(new THREE.Vector3(0, 1, 0), LANDING_AZ);
  camera.position.copy(c).add(off);
  controls.target.set(c.x, c.y + 1.02 * LANDING_R, c.z);
  camera.lookAt(controls.target);
  const el = document.createElement("div");
  el.className = "landing";
  el.innerHTML = `<h1>Rocket Assembly</h1><button type="button" class="landing-go">Build a rocket</button>`;
  document.body.appendChild(el);
  el.querySelector(".landing-go").addEventListener("click", enterFromLanding);
  landing = { planet, el, entering: false, y0: planet.object3d.position.y };
}
function enterFromLanding() {
  if (!landing || landing.entering) return;
  landing.entering = true;
  sfx.unlock();
  sfx.play("whoosh", { rate: 0.6, gain: 0.8 });
  const { planet, el, y0 } = landing;
  el.style.transition = "none"; // the title and button fade with the move itself (first 40 %)
  el.querySelector(".landing-go").disabled = true;
  const p0 = camera.position.clone();
  const t0 = controls.target.clone();
  const { position: p1, target: t1 } = choreo.homePose(LANDING_AZ);
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const prog = { v: 0 };
  animate(prog, {
    v: 1,
    duration: 3200,
    ease: "inOutCubic",
    onUpdate: () => {
      const e = prog.v;
      camera.position.lerpVectors(p0, p1, e);
      controls.target.lerpVectors(t0, t1, e);
      camera.lookAt(controls.target);
      // The planet sinks away well before the deck shows (globe top and ground disc are almost coplanar).
      planet.object3d.position.y = y0 - smooth((e - 0.2) / 0.4) * LANDING_R * 1.5;
      if (!root.visible && camera.position.y > -0.5 && e > 0.45) root.visible = true; // the deck is one-sided
      root.position.y = -2.5 * (1 - smooth((e - 0.55) / 0.35)); // the pad (and its ghost) rise into view
      el.style.opacity = String(1 - smooth(e / 0.4));
      if (e > 0.72 && document.body.classList.contains("landing")) document.body.classList.remove("landing"); // bar, HUD, hint fade in
    },
    onComplete: () => {
      planet.dispose();
      el.remove();
      root.visible = true;
      root.position.y = 0;
      controls.enabled = true;
      landing = null;
      syncUi();
    },
  });
}

const unlock = () => {
  sfx.unlock();
  removeEventListener("pointerdown", unlock);
  removeEventListener("keydown", unlock);
};
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);

// ---------- loop ----------
choreo.prewarm(renderer);
const landingMode = !["build", "story", "skip", "demo"].some((k) => query.has(k));
if (landingMode) startLanding();
else choreo.home();
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
  landing?.planet.update(t, camera);
  anchors?.update(t);
  if (composer) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

if (query.get("demo") === "1") setTimeout(() => choreo.buildAll(), 700);
if (query.get("story") === "1") setTimeout(() => runStory(), 900);
