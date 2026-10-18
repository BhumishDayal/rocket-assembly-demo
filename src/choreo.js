// Choreography: anime.js drives every motion (paths, springs, staggers); three.js only draws.
// Mechanical model (design §4, round 7): pieces are solid from the first frame; constant timings for every kind.
// Build    = pieces fly in from the staging side on gentle arcs in `order`, each turned by `spin` about Y and
//            rolled about its travel axis; the turn unwinds over the last 30 % of the path; spring landing
//            (260/14), a tick per piece; lock = flash + clunk + shake, fired when the body has seated (60 % of the
//            shell pieces landed, or 70 % of all pieces when there are no shells) while details keep ticking in;
//            built/HUD update when the last piece lands. Engine clusters stagger ~110 ms engine
//            to engine and ~35 ms between the sub-pieces of one engine; other parts ~38 ms.
// Remove   = reverse: unscrew (turn winds up over the first 30 %), top-down, back to the staging side.
// Explode  = engineering exploded view along the axis: every piece to rotY(spin·0.35)·(rest + dir·dist) +
//            (0, axisOffset, 0); parts lifted so nothing overlaps (3 m × scale between parts; the fairing keeps
//            the payload's lift). Assemble = reverse, bottom-up.
// Swap     = applyManifest(specs) / swap(part, spec): parts above lift (0.5 s) → old part unscrews out
//            (+0.2 s) → new part flies in (+0.7 s) and locks → parts above descend (0.5 s) + clunk.
//            Collateral changes ride along (an interstage resized by an engine swap, a fairing that appears or
//            goes with the payload, a clamped engine count). restack(manifest) animates group y to slotY.
// Ghost    = the next buildable part shows as a faint hologram at its slot (idle 0.12, hover 0.35); hidden
//            while busy, exploded or auto-building. part.ghostActive marks the clickable one.
// Highlight = soft emissive pulse in COLORS.select on a selected part's (per-mesh cloned) materials.
// Look     = per part, per instance: opaque (shells 0.92) or clear (0.18, interiors visible), toggled by a click
//            on the part or by X for all; exploded parts keep theirs; R / preset / swap-in / rebuild → opaque.
//            Edge lines stay at their base in both looks (the silhouette survives the clear look).
import * as THREE from "three";
import { animate, spring } from "animejs";
import { createHologramMaterial } from "./fx/hologram.js";
import { createBoltFlash } from "./fx/flash.js";
import { COLORS, LOOK, deployables, setShellOpacity as setShell } from "./parts.js";
import { attachPlumes, createPadLight, createPlume, P0 } from "./plume.js";
import { createPlanet, createSurfacePatch, createDustPuff } from "./planet.js";
import { createDroneShip } from "./anchors.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const D = (ms) => (reduced ? ms * 0.55 : ms);
const rnd = (a, b) => a + Math.random() * (b - a);
const rnd3 = (r) => new THREE.Vector3(rnd(-r, r), rnd(-r, r), rnd(-r, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const Y = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpC = new THREE.Color();

// Shell opacity per part look: opaque by default, clear (interiors visible) after a click or X.
const SHELL = { opaque: 0.92, clear: 0.18 };
const LINE_BASE = 0.55; // UI4's built edge-line opacity
// Opacity states belong to the x-ray look only; the classic look keeps opaque shells.
const setShellOpacity = LOOK === "xray" ? setShell : () => {};
const GHOST_IDLE = 0.12;
const GHOST_HOVER = 0.35;
const EXPLODE_GAP_M = 3; // exploded view: clearance between parts, metres (visual)
const SWAP_CLEAR_M = 3; // swap: how far the parts above lift to make room, metres (visual)
// Timings (ms). Same for every part kind; only piece counts differ.
const T = {
  fly: 520, // one piece's path in
  flyOut: 460, // one piece's path out
  engineStagger: 70,
  subStagger: 25,
  stagger: { shell: 38, interior: 28, detail: 20 }, // by mesh.userData.kind; shells set the pace

  outStaggerMax: 340, // remove: total stagger cap (top-down), so a 100-piece cluster still leaves in ~0.8 s
  swapInStaggerMax: 600, // swap: total arrival stagger cap, keeps the new part at 0.9–1.3 s
  lift: 500,
  outAt: 200,
  inAt: 700,
  descend: 500,
};

export function createChoreographer({ parts, scene, root, camera, controls, sfx, onChange, scale = 0.25, bounds: initialBounds = null, makePart = null }) {
  const flash = createBoltFlash();
  scene.add(flash.object3d);

  // Pad glow: UI4's pad lights (createPadLight) each carry a PointLight that is shown only while lit. A light
  // appearing or vanishing changes three's light count, which recompiles every lit material in the scene (a
  // ~100 ms freeze at ignition, again at the booster's landing burn). So one point light lives in the scene from
  // the start at intensity 0 and mirrors the brightest pad light shown; theirs are detached.
  const glow = new THREE.PointLight(0xff8a3a, 0, 0, 2);
  scene.add(glow);
  const glowSources = new Set();
  function adoptPadLight(pl) {
    pl.light.removeFromParent();
    glowSources.add(pl);
    return pl;
  }
  function dropPadLight(pl) {
    if (!pl) return;
    glowSources.delete(pl);
    pl.dispose();
  }
  function shownInScene(o) {
    for (; o; o = o.parent) {
      if (!o.visible) return false;
      if (o === scene) return true;
    }
    return false;
  }
  function updateGlow() {
    let best = null;
    for (const pl of glowSources) if (shownInScene(pl.object3d) && (!best || pl.light.intensity > best.light.intensity)) best = pl;
    glow.intensity = best ? best.light.intensity : 0;
    if (!best) return;
    glow.color.copy(best.light.color);
    best.object3d.localToWorld(glow.position.copy(best.light.position));
  }

  // cut: 0..1, the fade through black between the ending's scenes (main draws it as a full-screen overlay).
  const state = { busy: 0, exploded: false, scrubbing: false, auto: false, launch: null, deploying: false, ending: false, gen: 0, shake: 0, cut: 0 };
  const live = new Set();
  const selectColor = new THREE.Color(COLORS.select ?? 0xffb020);
  const highlighted = new Set();
  const emissive0 = new WeakMap(); // material -> { color, intensity } before any highlight
  const leaving = new Set(); // old parts still flying out of a swap (not in `parts` any more)
  let bounds = initialBounds;
  let ghostPart = null;
  let warmRenderer = null;

  // anime.js wrapper: returns a promise (with the animation on .anim), remembers the animation so reset()
  // can cancel it.
  function run(targets, params) {
    let anim;
    const promise = new Promise((resolve) => {
      anim = animate(targets, {
        ...params,
        onComplete: (self) => {
          live.delete(anim);
          params.onComplete?.(self);
          resolve();
        },
      });
      live.add(anim);
    });
    promise.anim = anim;
    return promise;
  }
  function cancelAll() {
    for (const a of live) a.cancel();
    live.clear();
  }

  function changed() {
    syncGhost();
    onChange();
  }

  // Hologram scan-band spacing: ~4 units on a 17-unit stack, proportional on others (hologram.js header).
  const bandPeriod = () => (bounds ? Math.max(1.5, bounds.height_u * 0.23) : 4);

  // ---------- per-part setup: ghost preview, arrival order, mechanical fallbacks ----------
  function setupPart(part) {
    part.holoGhost = createHologramMaterial({ color: COLORS.holo, opacity: 1, bandPeriod: bandPeriod() });
    part.holoGhost.material.depthTest = false; // seen (and clickable) even inside the interstage
    part.holoGhost.setOpacity(0);
    part.ghost = new THREE.Group();
    part.ghost.position.y = part.slotY;
    part.ghost.visible = false;
    part.ghost.renderOrder = 3;
    part.ghostFade = { v: 0 };
    part.ghostActive = false;
    part.hl = { v: 0 };
    part.look = "opaque";
    part.shell = { v: SHELL.opaque };
    setShellOpacity(part, SHELL.opaque);
    applyLines(part);
    part.group.position.y = part.slotY;
    const n = part.pieces.length;
    part.arrival = [...part.pieces].sort((a, b) => (a.order ?? a.index) - (b.order ?? b.index) || a.bottomY - b.bottomY);
    const step = Math.min(0.3, (part.height * 1.2) / Math.max(1, n));
    part.arrival.forEach((piece, rank) => {
      piece.rank = rank;
      piece.axis = Number.isFinite(piece.axisOffset) ? piece.axisOffset : (rank - (n - 1) / 2) * step;
      piece.turn = Number.isFinite(piece.spin) ? piece.spin : rank % 2 ? -0.9 : 0.9;
      piece.engineIndex = piece.engine ?? piece.mesh.userData.engine ?? null;
    });
    // Rank of each piece inside its own engine (for the 35 ms sub-stagger).
    const perEngine = new Map();
    for (const piece of part.arrival) {
      if (piece.engineIndex == null) continue;
      const k = perEngine.get(piece.engineIndex) ?? 0;
      piece.subRank = k;
      perEngine.set(piece.engineIndex, k + 1);
    }
    part.group.traverse((o) => {
      if (o.isLine) o.castShadow = o.receiveShadow = false; // edge lines: drawn, never in the shadow pass
    });
    for (const piece of part.pieces) {
      const g = new THREE.Mesh(piece.mesh.geometry, part.holoGhost.material);
      g.position.copy(piece.rest.position);
      g.quaternion.copy(piece.rest.quaternion);
      g.renderOrder = 3;
      g.userData.partId = part.id;
      g.userData.ghost = true;
      part.ghost.add(g);
      piece.mesh.userData.partId ??= part.id;
      piece.mesh.visible = part.built;
    }
    root.add(part.group, part.ghost);
  }

  function retirePart(part) {
    part.ghostAnim?.cancel();
    part.shellAnim?.cancel();
    part.dimAnim?.cancel();
    part.hlAnim?.cancel();
    highlighted.delete(part);
    leaving.delete(part);
    if (ghostPart === part) ghostPart = null;
    root.remove(part.group, part.ghost);
    // Pieces and everything under them (edge-line children carry their own geometry and material).
    part.group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) m.dispose();
    });
    part.holoGhost?.dispose();
  }

  for (const part of parts) setupPart(part);

  const index = (part) => parts.indexOf(part);
  const canBuild = (part) => !part.built && !part.busy && (index(part) === 0 || parts[index(part) - 1].built);
  const isTopBuilt = (part) => part.built && parts.slice(index(part) + 1).every((p) => !p.built);
  const topY = () => parts.reduce((m, p) => (p.built ? Math.max(m, p.slotY + p.height) : m), 0);
  const nextBuildable = () => {
    const p = parts.find((q) => !q.built);
    return p && canBuild(p) ? p : null;
  };

  // Where pieces come from: the left of the view, a little toward the camera, scaled to the current framing.
  function sourcePoint(part) {
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    const d = camera.position.distanceTo(controls.target);
    const halfW = d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    return new THREE.Vector3(0, part.slotY + part.height * 0.5 + d * 0.05, 0)
      .addScaledVector(right, -halfW * 0.62)
      .addScaledVector(fwd, -d * 0.1);
  }

  // ---------- camera ----------
  // Framing (design round 10): the stack fills ~85 % of the viewport height; a part flying in is framed at
  // ~60 % with a slight orbit, then the camera eases back to the stack; a clicked part gets the 60 % focus.
  const camDir = new THREE.Vector3();
  const elevation = () => Math.asin(THREE.MathUtils.clamp(camDir.copy(camera.position).sub(controls.target).normalize().y, -1, 1));
  const HOME_PITCH = elevation(); // the camera's starting elevation; the build hero angle sits 8° below it
  const HERO_PITCH = HOME_PITCH - THREE.MathUtils.degToRad(8);
  let camAnim = null; // one camera move at a time: a new framing replaces the one in flight
  // pitch: target elevation (radians) or null to keep the current one. tx/tz move the orbit target off the axis
  // (twin compare frames the pair); every other framing brings it back to the axis.
  function frameTo({ ty, dist, tx = 0, tz = 0, orbit = 0, pitch = null, duration = D(1100), ease = "inOutCubic" }) {
    const cur = { tx: controls.target.x, ty: controls.target.y, tz: controls.target.z, d: camera.position.distanceTo(controls.target), az: 0, el: elevation() };
    let az = 0;
    camAnim?.cancel();
    live.delete(camAnim);
    const p = run(cur, {
      tx,
      ty,
      tz,
      d: dist,
      az: orbit,
      el: pitch ?? cur.el,
      duration,
      ease,
      onUpdate: () => {
        camDir.copy(camera.position).sub(controls.target).normalize();
        controls.target.set(cur.tx, cur.ty, cur.tz);
        if (orbit) camDir.applyAxisAngle(Y, cur.az - az);
        az = cur.az;
        if (pitch != null) {
          const h = Math.hypot(camDir.x, camDir.z) || 1;
          const c = Math.cos(cur.el);
          camDir.set((camDir.x / h) * c, Math.sin(cur.el), (camDir.z / h) * c);
        }
        camera.position.copy(controls.target).addScaledVector(camDir, cur.d);
      },
    });
    camAnim = p.anim;
    return p;
  }
  // Distance at which the span [y0, y1] around the axis (radius r) fills `frac` of the viewport height
  // (and fits the width), for the current camera pitch.
  function fitDist(h, r, frac, atPitch = null) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camDir.copy(camera.position).sub(controls.target).normalize();
    const pitch = Math.abs(atPitch ?? Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1)));
    const dv = (h * Math.cos(pitch) + 2 * r * Math.sin(pitch)) / (2 * tanHalf * frac);
    const dh = (2 * r) / (2 * tanHalf * camera.aspect * frac);
    return Math.max(dv, dh) + r;
  }
  // The centre sits `shift` of the view (default 2 %) below the span's middle, so the base clears the bar.
  // What the camera frames now (main's fog band): its radius and mode ("stack" | "part" | "focus" | "exploded").
  let framedR = initialBounds?.radius_u ?? 1;
  let framedMode = "stack";
  function spanFraming(y0, y1, r, frac, shift = 0.02, atPitch = null) {
    const dist = Math.max(controls.minDistance, fitDist(Math.max(y1 - y0, 0.05), r, frac, atPitch));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return { ty: (y0 + y1) / 2 - shift * 2 * dist * tanHalf, dist };
  }
  function frameSpan(y0, y1, r, frac, { shift = 0.02, mode = "stack", ...opts } = {}) {
    framedR = r;
    framedMode = mode;
    return frameTo({ ...spanFraming(y0, y1, r, frac, shift), ...opts });
  }
  const stackHeight = () => Math.max(bounds?.height_u ?? 0, topY(), 1);
  const stackRadius = () => bounds?.radius_u ?? 1;
  function frameStack(opts = {}) {
    return frameSpan(0, stackHeight(), stackRadius(), 0.83, { pitch: HOME_PITCH, ...opts }); // ~85 %, nose clear of the HUD line
  }
  let orbitSign = 1;
  // Incoming part: 60 % of the view, a slight orbit, and the hero angle (8° lower, so rings read as ellipses).
  function framePart(part) {
    orbitSign = -orbitSign;
    return frameSpan(part.slotY, part.slotY + part.height, part.radius, 0.6, { orbit: 0.2 * orbitSign, pitch: HERO_PITCH, mode: "part" });
  }
  // Click focus: frame the part where it is now (assembled or exploded), from its visible meshes.
  // { frac, shift } let a phone keep the part in the upper half, above the bottom-sheet card.
  const focusBox = new THREE.Box3();
  function focus(part, { frac = 0.6, shift = 0.02 } = {}) {
    if (!part?.pieces?.length) return;
    focusBox.makeEmpty();
    for (const piece of part.pieces) if (piece.mesh.visible) focusBox.expandByObject(piece.mesh);
    if (focusBox.isEmpty()) return;
    const r = Math.max(Math.abs(focusBox.min.x), Math.abs(focusBox.max.x), Math.abs(focusBox.min.z), Math.abs(focusBox.max.z));
    return frameSpan(focusBox.min.y, focusBox.max.y, r, frac, { shift, mode: "focus" });
  }
  function unfocus() {
    return state.exploded ? frameExploded() : frameStack();
  }
  let explodedSpan = null; // { top, r } of the current exploded view
  function frameExploded() {
    return explodedSpan ? frameSpan(0, explodedSpan.top, explodedSpan.r, 0.85, { mode: "exploded" }) : frameStack();
  }
  // Twin compare: frame the stack and the twin outline beside it. center = the pair's midpoint on the ground
  // plane, top = the taller of the two, halfWidth = half the pair's horizontal extent.
  function frameCompare(center, top, halfWidth) {
    framedR = halfWidth;
    framedMode = "stack";
    return frameTo({ ...spanFraming(0, top, halfWidth, 0.8), tx: center.x, tz: center.z, pitch: HOME_PITCH });
  }
  // The home shot as a pose (no animation), for a camera move that must end exactly where home() would:
  // azimuth az (radians, around +Y from +Z), home pitch.
  function homePose(az = 0.58) {
    const { ty, dist } = spanFraming(0, stackHeight(), stackRadius(), 0.83, 0.02, HOME_PITCH);
    const target = new THREE.Vector3(0, ty, 0);
    const c = Math.cos(HOME_PITCH);
    const position = target.clone().add(new THREE.Vector3(Math.sin(az) * c, Math.sin(HOME_PITCH), Math.cos(az) * c).multiplyScalar(dist));
    framedR = stackRadius();
    framedMode = "stack";
    return { target, position };
  }
  // Home: the whole stack-to-be at 85 %, the first ghost waiting on the pad.
  function home() {
    return frameStack({ duration: D(900) });
  }
  function setBounds(b) {
    bounds = b;
    for (const part of parts) {
      const u = part.holoGhost?.material.uniforms.uBandPeriod;
      if (u) u.value = bandPeriod();
    }
  }

  // ---------- ghost: always-on faint preview of the next buildable part ----------
  function fadeGhost(part, v) {
    part.ghostAnim?.cancel();
    part.ghostActive = v > 0;
    if (v > 0) part.ghost.visible = true;
    part.ghostAnim = animate(part.ghostFade, {
      v,
      duration: D(v > part.ghostFade.v ? 260 : 180),
      ease: "outQuad",
      onUpdate: () => part.holoGhost.setOpacity(part.ghostFade.v),
      onComplete: () => {
        if (v === 0) part.ghost.visible = false;
      },
    });
  }
  function hideGhostNow(part) {
    part.ghostAnim?.cancel();
    part.ghostFade.v = 0;
    part.ghostActive = false;
    part.holoGhost.setOpacity(0);
    part.ghost.visible = false;
  }
  function syncGhost() {
    if (ghostPart && !parts.includes(ghostPart)) ghostPart = null;
    const want = state.busy || state.exploded || state.auto ? null : nextBuildable();
    if (want === ghostPart) return;
    if (ghostPart) fadeGhost(ghostPart, 0);
    ghostPart = want;
    if (want) fadeGhost(want, GHOST_IDLE);
  }
  // Hover on the ghost (from the selector). Ignored for anything but the current ghost.
  function setGhost(part, on) {
    if (!part || part !== ghostPart) return;
    fadeGhost(part, on ? GHOST_HOVER : GHOST_IDLE);
  }

  // ---------- look: opaque / clear shells per part ----------
  const shellTarget = (part) => (part.look === "clear" ? SHELL.clear : SHELL.opaque);
  function fadeShell(part, v = shellTarget(part), duration = D(420)) {
    part.shellAnim?.cancel();
    if (duration <= 0) {
      part.shell.v = v;
      setShellOpacity(part, v);
      applyLines(part);
      return;
    }
    part.shellAnim = animate(part.shell, {
      v,
      duration,
      ease: "outQuad",
      onUpdate: () => {
        setShellOpacity(part, part.shell.v);
        applyLines(part); // setShellOpacity scales shell lines with the shell; keep them at their base
      },
    });
  }
  function setLook(part, look) {
    if (!part?.pieces || part.look === look) return;
    part.look = look;
    fadeShell(part);
  }
  const toggleLook = (part) => setLook(part, part?.look === "clear" ? "opaque" : "clear");
  // X: every built part at once; any opaque one makes them all clear, else all go back to opaque.
  function toggleLookAll() {
    const built = parts.filter((p) => p.built);
    const look = built.some((p) => p.look !== "clear") ? "clear" : "opaque";
    for (const p of built) setLook(p, look);
    return look;
  }

  // Edge lines: while a part is selected, the OTHER parts' lines dim to 0.3 (from 0.55) so the focused part
  // pops. A line's opacity = its built base (UI4: line.userData.base) × dim, in either look.
  const LINE_DIM = 0.3 / LINE_BASE;
  function applyLines(part) {
    if (LOOK !== "xray") return;
    const dim = part.dim?.v ?? 1;
    part.group.traverse((o) => {
      if (!o.isLine || !o.material) return;
      o.userData.base ??= o.material.opacity;
      o.material.opacity = Math.min(1, o.userData.base * dim);
    });
  }
  function fadeDim(part, v) {
    part.dim ??= { v: 1 };
    part.dimAnim?.cancel();
    part.dimAnim = animate(part.dim, { v, duration: D(320), ease: "outQuad", onUpdate: () => applyLines(part) });
  }

  // ---------- highlight: emissive pulse on the selected part ----------
  const materialsOf = (part) => part.pieces.flatMap((p) => [].concat(p.mesh.material));
  function highlight(part, on) {
    if (!part?.pieces) return;
    part.hlAnim?.cancel();
    if (on) {
      for (const m of materialsOf(part)) {
        if (m.emissive && !emissive0.has(m)) emissive0.set(m, { color: m.emissive.clone(), intensity: m.emissiveIntensity });
      }
      highlighted.add(part);
      fadeDim(part, 1);
      for (const p of parts) if (p !== part) fadeDim(p, LINE_DIM);
    } else if (!highlighted.has(part)) return;
    else {
      for (const p of parts) if (p !== part) fadeDim(p, 1);
    }
    part.hlAnim = animate(part.hl, {
      v: on ? 1 : 0,
      duration: D(on ? 240 : 380),
      ease: "outQuad",
      onComplete: () => {
        if (!on) clearHighlight(part);
      },
    });
  }
  function clearHighlight(part) {
    part.hlAnim?.cancel();
    part.hl.v = 0;
    highlighted.delete(part);
    for (const m of materialsOf(part)) {
      const e0 = emissive0.get(m);
      if (!e0) continue;
      m.emissive.copy(e0.color);
      m.emissiveIntensity = e0.intensity;
    }
  }
  function updateHighlights(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.4);
    for (const part of highlighted) {
      const k = part.hl.v * (0.12 + 0.12 * pulse);
      for (const m of materialsOf(part)) {
        const e0 = emissive0.get(m);
        if (!e0) continue;
        m.emissive.copy(e0.color).multiplyScalar(e0.intensity * (1 - k)).add(tmpC.copy(selectColor).multiplyScalar(k));
        m.emissiveIntensity = 1;
      }
    }
  }

  // ---------- mechanical build / remove ----------
  // Arrival delays in part.arrival order: engine clusters go engine by engine with the sub-pieces of one engine
  // close behind each other, then the cluster's shared pieces (mount, heat shield); everything else follows in
  // `order`, each step set by the piece kind (shells 38, interiors 28, details 20 ms). `cap` compresses the
  // whole stagger to at most `cap` ms (swap).
  const kindStep = (p) => T.stagger[p.mesh.userData.kind] ?? T.stagger.shell;
  function arrivalDelays(part, cap = Infinity) {
    const delays = part.arrival.map((p) => (p.engineIndex != null ? p.engineIndex * T.engineStagger + (p.subRank ?? 0) * T.subStagger : null));
    const enginesEnd = delays.reduce((m, d) => (d == null ? m : Math.max(m, d)), -Infinity);
    let t = Number.isFinite(enginesEnd) ? enginesEnd : null;
    part.arrival.forEach((p, i) => {
      if (delays[i] != null) return;
      t = t == null ? 0 : t + kindStep(p);
      delays[i] = t;
    });
    const max = Math.max(0, ...delays);
    const k = max > cap ? cap / max : 1;
    return delays.map((d) => D(d * k));
  }

  // The piece's rest orientation turned by `spin` about Y and rolled about its travel direction, scaled by s.
  function turnedQuat(piece, s, travelAxis, roll, out) {
    out.copy(piece.rest.quaternion);
    if (roll) out.premultiply(tmpQ2.setFromAxisAngle(travelAxis, roll * s));
    return out.premultiply(tmpQ2.setFromAxisAngle(Y, piece.turn * s));
  }

  // onSeated fires once the part's body is in place (see header); the promise resolves when every piece is.
  function flyIn(part, sourceWorld, { cap = Infinity, onSeated } = {}) {
    fadeShell(part, shellTarget(part), 0);
    const source = part.group.worldToLocal(sourceWorld.clone());
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 18, 0.6, 2.2);
    const delays = arrivalDelays(part, cap);
    const isShell = (p) => p.mesh.userData.kind === "shell";
    const shells = part.arrival.filter(isShell).length;
    const need = shells ? Math.ceil(shells * 0.6) : Math.ceil(part.arrival.length * 0.7);
    let landed = 0;
    let seated = false;
    const land = (piece) => {
      if (seated || (shells && !isShell(piece))) return;
      if (++landed >= need) {
        seated = true;
        onSeated?.();
      }
    };
    return Promise.all(
      part.arrival.map((piece, i) => {
        const mesh = piece.mesh;
        const end = piece.rest.position;
        const start = source.clone().add(rnd3(0.7 * k));
        const mid = start
          .clone()
          .lerp(end, 0.5)
          .add(new THREE.Vector3(rnd(-0.4, 0.4) * k, rnd(0.8, 1.6) * k, rnd(-0.4, 0.4) * k)); // gentle arc
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const over = curve.getTangent(1).normalize().multiplyScalar(0.06 * k); // tiny overshoot, the spring takes it back
        const travel = curve.getTangent(0.5).normalize();
        const roll = (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1.1);
        const prog = { t: 0 };
        mesh.visible = false;
        return run(prog, {
          t: 1,
          duration: D(T.fly),
          delay: delays[i],
          ease: "outQuart",
          onBegin: () => {
            mesh.visible = true;
          },
          onUpdate: () => {
            const t = prog.t;
            curve.getPoint(t, mesh.position).addScaledVector(over, t);
            turnedQuat(piece, 1 - smooth((t - 0.7) / 0.3), travel, roll, mesh.quaternion);
          },
          onComplete: () => {
            mesh.quaternion.copy(piece.rest.quaternion);
            sfx.play("tick", { rate: rnd(0.9, 1.12) });
            land(piece);
          },
        }).then(() => run(mesh.position, { x: end.x, y: end.y, z: end.z, ease: spring({ stiffness: 260, damping: 14 }) }));
      }),
    );
  }

  function flyOut(part, sourceWorld) {
    const source = part.group.worldToLocal(sourceWorld.clone());
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 18, 0.6, 2.2);
    const order = [...part.arrival].reverse(); // top-down
    const step = Math.min(T.stagger.shell, T.outStaggerMax / Math.max(1, order.length - 1));
    return Promise.all(
      order.map((piece, i) => {
        const mesh = piece.mesh;
        const start = mesh.position.clone();
        const end = source.clone().add(rnd3(0.8 * k));
        const mid = start
          .clone()
          .lerp(end, 0.5)
          .add(new THREE.Vector3(rnd(-0.4, 0.4) * k, rnd(0.7, 1.4) * k, rnd(-0.4, 0.4) * k));
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const travel = curve.getTangent(0.5).normalize();
        const roll = (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 1.1);
        const prog = { t: 0 };
        return run(prog, {
          t: 1,
          duration: D(T.flyOut),
          delay: D(i * step),
          ease: "inQuart",
          onUpdate: () => {
            const t = prog.t;
            curve.getPoint(t, mesh.position);
            turnedQuat(piece, smooth(t / 0.3), travel, roll, mesh.quaternion); // unscrew first, then leave
          },
          onComplete: () => {
            mesh.visible = false;
            mesh.position.copy(piece.rest.position);
            mesh.quaternion.copy(piece.rest.quaternion);
          },
        });
      }),
    );
  }

  function lock(part) {
    flash.fire({ position: new THREE.Vector3(0, part.slotY + 0.02, 0), radius: part.radius * 1.35, color: 0xfff1e0 }); // warm white
    sfx.play("clunk");
    state.shake = 1;
  }

  // One part in: fly-in, lock when its body has seated (onSeated), built when its last detail has landed.
  async function buildPart(part, { onSeated } = {}) {
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    hideGhostNow(part);
    changed();
    sfx.play("whoosh");
    framePart(part);
    let locked = false;
    const seat = () => {
      if (locked || gen !== state.gen) return;
      locked = true;
      lock(part);
      onSeated?.();
    };
    await flyIn(part, sourcePoint(part), { onSeated: seat });
    if (gen !== state.gen) return false;
    part.built = true;
    part.busy = false;
    state.busy--;
    seat();
    if (!state.auto) frameStack(); // Build all keeps following the parts and settles on the stack at the end
    changed();
    return true;
  }

  function build(part) {
    if (state.busy || state.exploded || !canBuild(part)) return Promise.resolve(false);
    return buildPart(part);
  }

  async function remove(part) {
    if (state.busy || state.exploded || state.launch || !isTopBuilt(part)) return false;
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    part.removing = true;
    if (highlighted.has(part)) clearHighlight(part);
    changed();
    sfx.play("whoosh", { rate: 0.8 });
    await flyOut(part, sourcePoint(part));
    if (gen !== state.gen) return false;
    part.built = false;
    part.busy = false;
    part.removing = false;
    state.busy--;
    frameStack();
    changed();
    return true;
  }

  // ---------- explode / assemble ----------
  // Axial layout of the exploded view, bottom to top in build order: each part is lifted so that its exploded
  // extent clears everything below it by EXPLODE_GAP_M. The fairing encloses the payload, so it keeps the
  // payload's lift and only its halves move out.
  const explodedY = (piece) => piece.axis + piece.explode.dir.y * piece.explode.dist;
  function explodeLayout(built) {
    const lifts = new Map();
    const gap = EXPLODE_GAP_M * scale;
    let top = 0;
    let prev = null;
    for (const part of built) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const piece of part.pieces) {
        lo = Math.min(lo, piece.bottomY + explodedY(piece));
        hi = Math.max(hi, piece.topY + explodedY(piece));
      }
      let lift;
      const payload = part.kind === "fairing" ? built.find((p) => p.kind === "payload") : null;
      if (payload && lifts.has(payload)) lift = lifts.get(payload);
      else if (!prev) lift = Math.max(0, -(part.slotY + lo)); // nothing below the pad
      else lift = Math.max(lifts.get(prev), top + gap - (part.slotY + lo));
      lifts.set(part, lift);
      top = Math.max(top, part.slotY + lift + hi);
      prev = part;
    }
    return { lifts, top };
  }

  // One exploded progress xs.v, 0 = assembled → 1 = exploded, drives every piece (Space springs it, scrub sets
  // it directly). Each piece follows with an offset (lower parts first, then by arrival rank), so a scrub reads
  // as the lens cascade; the springs may overshoot past 1, never below 0 (pieces would sink into each other).
  const X_PART = 0.22; // offset spread across parts
  const X_PIECE = 0.1; // offset spread inside a part
  const X_WINDOW = 1 - X_PART - X_PIECE;
  const xs = { v: 0 };
  let xAnim = null;
  let xParts = []; // the built parts the current exploded layout was computed for
  let xFrames = null; // { stack, exploded } camera framings the scrub interpolates between
  function prepareExplode() {
    xParts = parts.filter((p) => p.built);
    const { lifts, top } = explodeLayout(xParts);
    const spread = Math.max(0, ...xParts.flatMap((p) => p.pieces.map((q) => q.explode.dist * Math.hypot(q.explode.dir.x, q.explode.dir.z))));
    explodedSpan = { top, r: stackRadius() + spread };
    const np = xParts.length;
    xParts.forEach((part, pi) => {
      const lift = lifts.get(part);
      const n = part.arrival.length;
      for (const piece of part.arrival) {
        const rot = new THREE.Quaternion().setFromAxisAngle(Y, piece.turn * 0.35);
        piece.xTo = piece.rest.position.clone().addScaledVector(piece.explode.dir, piece.explode.dist).applyQuaternion(rot);
        piece.xTo.y += piece.axis + lift;
        piece.xQ = rot.multiply(piece.rest.quaternion);
        piece.xOff = (np > 1 ? pi / (np - 1) : 0) * X_PART + (n > 1 ? piece.rank / (n - 1) : 0) * X_PIECE;
      }
    });
    xFrames = {
      stack: { ...spanFraming(0, stackHeight(), stackRadius(), 0.83), r: stackRadius() },
      exploded: { ...spanFraming(0, top, explodedSpan.r, 0.85), r: explodedSpan.r },
    };
  }
  function applyExplode() {
    const v = xs.v;
    const vc = Math.min(1, Math.max(0, v));
    const over = Math.max(0, v - 1) * 1.5;
    for (const part of xParts) {
      for (const piece of part.pieces) {
        const t = Math.min(1, Math.max(0, (vc - piece.xOff) / X_WINDOW)) + over;
        piece.mesh.position.lerpVectors(piece.rest.position, piece.xTo, t);
        piece.mesh.quaternion.slerpQuaternions(piece.rest.quaternion, piece.xQ, Math.min(1, t));
      }
    }
  }
  // The scrub camera: between the stack framing and the exploded framing, following the progress.
  function scrubCamera() {
    const a = xFrames.stack;
    const b = xFrames.exploded;
    const k = smooth(Math.min(1, Math.max(0, xs.v)));
    camAnim?.cancel();
    controls.target.set(0, a.ty + (b.ty - a.ty) * k, 0);
    camDir.copy(camera.position).sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(camDir, a.dist + (b.dist - a.dist) * k);
    framedR = a.r + (b.r - a.r) * k;
    framedMode = k > 0.5 ? "exploded" : "stack";
  }

  // Spring the progress to 0 or 1 (Space, or a released scrub). Busy while it runs.
  let xTarget = 0;
  async function settleExplode(to) {
    const gen = state.gen;
    xAnim?.cancel();
    live.delete(xAnim);
    xTarget = to;
    state.busy++;
    state.exploded = true;
    changed();
    if (to === 1) {
      sfx.play("explode");
      frameExploded();
    } else {
      sfx.play("assemble");
      frameStack();
    }
    controls.autoRotate = false;
    const p = run(xs, { v: to, ease: to === 1 ? spring({ stiffness: 85, damping: 11 }) : spring({ stiffness: 130, damping: 12 }), onUpdate: applyExplode });
    xAnim = p.anim;
    await p;
    if (gen !== state.gen) return false;
    finishExplode(to);
    return true;
  }
  function finishExplode(to) {
    xAnim = null;
    xs.v = to;
    applyExplode();
    state.busy = Math.max(0, state.busy - 1);
    if (to === 1) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.9;
    } else {
      state.exploded = false;
      xParts = [];
      sfx.play("clunk", { gain: 0.7 });
      state.shake = 0.6;
    }
    changed();
    return true;
  }

  function explode() {
    if (state.busy || state.scrubbing || state.launch || xs.v >= 1 || topY() === 0) return Promise.resolve(false);
    if (xs.v === 0) prepareExplode();
    return settleExplode(1);
  }

  function assemble() {
    if (state.busy || state.scrubbing || !state.exploded) return Promise.resolve(false);
    return settleExplode(0);
  }

  // Scrub (drag / wheel on empty space): scrubStart → scrubBy(delta of progress)… → scrubEnd (snaps past 0.5).
  function scrubStart() {
    if (state.scrubbing) return true;
    if ((state.busy && !xAnim) || state.auto || state.launch || topY() === 0) return false; // builds, swaps, launch own the stack
    if (xAnim) {
      xAnim.cancel();
      live.delete(xAnim);
      xAnim = null;
      state.busy--;
    }
    if (xs.v <= 0) prepareExplode();
    state.scrubbing = true;
    state.exploded = true;
    controls.autoRotate = false;
    changed();
    return true;
  }
  function scrubBy(delta) {
    if (!state.scrubbing) return;
    xs.v = Math.min(1, Math.max(0, xs.v + delta));
    applyExplode();
    scrubCamera();
  }
  function scrubEnd() {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    settleExplode(xs.v > 0.5 ? 1 : 0);
  }

  const toggleExplode = () => (state.exploded ? assemble() : explode());

  // ---------- swap / restack ----------
  // Shape identity: a part whose record, count, size and geometry are unchanged is kept (and only restacked).
  const shapeKey = (p) => JSON.stringify([p.kind, p.record?.id ?? null, p.count, +p.height.toFixed(5), +p.radius.toFixed(5), p.geom ?? null]);
  const RUNTIME = new Set(["group", "pieces", "built", "busy", "ghost", "holoGhost", "ghostFade", "ghostActive", "ghostAnim", "hl", "hlAnim", "arrival"]);
  const specFields = (spec) => Object.fromEntries(Object.entries(spec).filter(([k]) => !RUNTIME.has(k)));

  function moveGroup(part, y, { duration, ease = "inOutCubic" }) {
    const g = { y: part.group.position.y };
    return run(g, {
      y,
      duration,
      ease,
      onUpdate: () => {
        part.group.position.y = g.y;
      },
    });
  }

  // restack(manifest): animate every part's group to its spec's slotY (matched by id).
  function restack(manifest, { duration = D(T.descend) } = {}) {
    const jobs = [];
    for (const spec of manifest) {
      const part = parts.find((p) => p.id === spec.id);
      if (!part) continue;
      part.slotY = spec.slotY;
      part.ghost.position.y = spec.slotY;
      if (Math.abs(part.group.position.y - spec.slotY) > 1e-6) jobs.push(moveGroup(part, spec.slotY, { duration }));
    }
    return Promise.all(jobs);
  }

  // The option animation for a whole new manifest: one changed slot plus whatever it drags along. Kept parts
  // (same shape) are restacked; changed ones are replaced (old unscrews out, new flies in at its new slot).
  // Resolves to { parts, replaced: Map(oldPart -> newPart) }, or false if it could not run / was cancelled.
  async function applyManifest(specs) {
    if (state.busy || state.exploded || state.launch || !makePart) return false;
    const gen = state.gen;
    state.busy++;
    const wasComplete = parts.length > 0 && parts.every((p) => p.built);
    const oldById = new Map(parts.map((p) => [p.id, p]));
    const next = [];
    const incoming = []; // new parts to fly in
    const outgoing = []; // built old parts to fly out
    const kept = [];
    const replaced = new Map();
    for (const spec of specs) {
      const old = oldById.get(spec.id);
      if (old && (old === spec || shapeKey(old) === shapeKey(spec))) {
        oldById.delete(spec.id);
        const y = old.group.position.y;
        Object.assign(old, specFields(spec));
        old.group.position.y = y; // restack moves it
        kept.push(old);
        next.push(old);
        continue;
      }
      const part = makePart(spec);
      part.built = false;
      part.busy = false;
      setupPart(part);
      if (old) {
        oldById.delete(spec.id);
        replaced.set(old, part);
        if (old.built) outgoing.push(old);
        else retirePart(old);
      }
      if (old ? old.built : wasComplete) {
        part.busy = true;
        incoming.push(part);
      }
      next.push(part);
    }
    for (const old of oldById.values()) {
      if (old.built) outgoing.push(old);
      else retirePart(old);
    }
    for (const old of outgoing) {
      old.busy = true;
      leaving.add(old);
      if (highlighted.has(old)) clearHighlight(old);
    }
    parts = next;
    changed();

    // Parts above the lowest change lift out of the way, then settle on their new slots.
    const changedY = Math.min(Infinity, ...incoming.map((p) => p.slotY), ...outgoing.map((p) => p.slotY));
    const above = kept.filter((p) => p.built && p.slotY >= changedY - 1e-6);
    const clear = SWAP_CLEAR_M * scale + Math.max(0, ...incoming.map((p) => p.height * 0.15));
    const liftY = (p) => Math.max(p.group.position.y, p.slotY) + clear;
    frameSpan(0, Math.max(stackHeight(), ...above.map((p) => liftY(p) + p.height)), stackRadius(), 0.85);
    const t0 = performance.now();
    const at = (ms) => wait(Math.max(0, D(ms) - (performance.now() - t0)));
    const lifting = Promise.all(above.map((p) => moveGroup(p, liftY(p), { duration: D(T.lift) })));
    if (above.length) sfx.play("whoosh", { rate: 1.2, gain: 0.6 });

    await at(T.outAt);
    if (gen !== state.gen) return false;
    if (outgoing.length) sfx.play("whoosh", { rate: 0.8 });
    const departing = Promise.all(outgoing.map((p) => flyOut(p, sourcePoint(p))));

    await at(T.inAt);
    if (gen !== state.gen) return false;
    if (incoming.length) sfx.play("whoosh");
    const arriving = incoming.map(async (p) => {
      let locked = false;
      const seat = () => {
        if (gen !== state.gen) return;
        locked = true;
        lock(p);
      };
      await flyIn(p, sourcePoint(p), { cap: T.swapInStaggerMax, onSeated: seat });
      if (gen !== state.gen) return;
      p.built = true;
      p.busy = false;
      if (!locked) lock(p);
    });
    await Promise.all([lifting, departing, ...arriving]);
    if (gen !== state.gen) return false;
    for (const old of outgoing) retirePart(old);

    await restack(specs, { duration: D(T.descend) });
    if (gen !== state.gen) return false;
    if (above.length) {
      sfx.play("clunk", { gain: 0.8 });
      state.shake = 0.7;
    }
    state.busy--;
    frameStack();
    changed();
    return { parts, replaced };
  }

  // swap(part, newSpec): one slot changes and nothing else moves (applyManifest when sizes shift).
  const swap = (part, newSpec) => applyManifest(parts.map((p) => (p === part ? newSpec : p)));

  // ---------- launch (design A1–A3) ----------
  // Plays a simulateAscent() result (ascent.js, all estimates). Countdown, per-engine ignition with plumes, the
  // hold-down release at liftoff, then the rocket follows the sampled altitude in scene units: it rises in a
  // fixed frame for ~60 % of its height, then the camera tracks it while the pad drops away; it pitches over
  // along the flight-path angle. MECO kills a stage's plumes, SEP drops the spent stage (it falls away and
  // tumbles), the next stage lights, the fairing halves swing off. Long burns are time-compressed (first
  // seconds and event clusters near real time). Outcome: orbit → slow drift; suborbital/impact → arcs back and
  // fades. Telemetry goes out through onTelemetry every frame; the caller renders it.
  const EVENT_LABEL = { ignition: "IGNITION", liftoff: "LIFTOFF", maxq: "MAX-Q", meco: "MECO", sep: "STAGE SEP", ignition2: "IGNITION", fairing: "FAIRING SEP", seco: "SECO", orbit: "ORBIT", shortfall: "SHORTFALL", impact: "IMPACT" };
  const COUNTDOWN_S = 3;
  const SCALE_HEIGHT_M = 8434; // isothermal atmosphere, for the plume's ambient pressure only (visual)
  let L = null;

  // [sim t, real t] keyframes. Real time until 2.5 s after liftoff, then a fixed on-screen budget per phase so
  // the whole ascent fits ~16 s whatever the vehicle (telemetry still shows the true T+): liftoff → Max-Q 3 s,
  // → first MECO 3 s, each MECO → SEP → ignition 1.5 s, intermediate burns 2.5 s, the last burn to SECO 4 s,
  // SECO → outcome 1.5 s. Phases a flight does not have are skipped.
  const PHASE_S = { toMaxQ: 3, toMeco: 3, sep: 1.5, midBurn: 2.5, lastBurn: 4, coast: 1.5 };
  const PHASE_TOTAL_S = 13; // after the real-time opening; more stages share it (Saturn V scales down)
  function playbackKeys(events, tEnd) {
    const lift = events.find((e) => e.type === "liftoff")?.t ?? 0;
    const plan = []; // [sim t, planned seconds]
    const maxq = events.find((e) => e.type === "maxq");
    if (maxq) plan.push([maxq.t, PHASE_S.toMaxQ]);
    events
      .filter((e) => e.type === "meco")
      .forEach((m, i) => {
        plan.push([m.t, i === 0 ? PHASE_S.toMeco : PHASE_S.midBurn]);
        const ign = events.find((e) => e.type === "ignition2" && e.t >= m.t);
        if (ign) plan.push([ign.t, PHASE_S.sep]);
      });
    const seco = events.find((e) => e.type === "seco");
    if (seco) plan.push([seco.t, PHASE_S.lastBurn]);
    plan.push([tEnd, PHASE_S.coast]);
    const total = plan.reduce((n, [, d]) => n + d, 0);
    const k = total > PHASE_TOTAL_S ? PHASE_TOTAL_S / total : 1;
    const keys = [[0, 0]];
    const add = (simT, realDur) => {
      const [s0, r0] = keys[keys.length - 1];
      const t = Math.min(simT, tEnd);
      if (t > s0 + 1e-6) keys.push([t, r0 + realDur]);
    };
    add(lift + 2.5, lift + 2.5);
    for (const [t, d] of plan) add(t, Math.max(1, d * k));
    return keys;
  }
  function simTime(keys, real) {
    if (real <= 0) return real;
    for (let i = 1; i < keys.length; i++) {
      const [s1, r1] = keys[i];
      if (real <= r1) {
        const [s0, r0] = keys[i - 1];
        return s0 + ((real - r0) / Math.max(1e-6, r1 - r0)) * (s1 - s0);
      }
    }
    const [sl, rl] = keys[keys.length - 1];
    return sl + (real - rl);
  }
  function sampleAt(samples, t) {
    let lo = 0;
    let hi = samples.length - 1;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[hi].t) return samples[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
    const mix = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? x + (y - x) * k : x);
    return { ...a, t, alt_m: mix(a.alt_m, b.alt_m), vel_ms: mix(a.vel_ms, b.vel_ms), acc_ms2: mix(a.acc_ms2, b.acc_ms2), gamma_deg: mix(a.gamma_deg, b.gamma_deg), throttle: a.throttle };
  }

  // Local y range of what is still flying (flight-group coordinates), for the tracking camera.
  function flyingSpan() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const part of parts) {
      if (L.gone.has(part)) continue;
      lo = Math.min(lo, part.group.position.y);
      hi = Math.max(hi, part.group.position.y + part.height);
    }
    return { lo, hi };
  }
  function retarget() {
    const { lo, hi } = flyingSpan();
    L.trackLocalY = (lo + hi) / 2;
    L.trackDist = Math.max(controls.minDistance, fitDist(hi - lo, stackRadius(), 0.72));
  }

  function ignite(stage, t) {
    const part = parts.find((p) => p.kind === "engines" && p.stageIndex === stage);
    if (!part) return;
    const plumes = attachPlumes(part);
    for (const plume of plumes) L.plumes.push({ plume, stage, ignite: t + plume.engine * (stage === 0 ? 0.07 : 0.05), dead: false });
    if (stage === 0 && L.pad && plumes.length) {
      L.padLight = adoptPadLight(createPadLight({ baseRadius_u: bounds?.baseRadius_u ?? 1, bellExitRadius_u: Math.max(...plumes.map((p) => p.exitRadius_u ?? 0.1)) }));
      L.pad.add(L.padLight.object3d);
    }
  }
  // A spent stage (or the fairing) leaves the flight group and drifts back and down in world space, tumbling.
  function drop(part, { spread = false } = {}) {
    L.gone.add(part);
    root.attach(part.group);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(L.flight.quaternion);
    const axis = new THREE.Vector3().crossVectors(down, L.tiltAxis).normalize();
    const d = { part, t: 0, down, axis: axis.lengthSq() ? axis : L.tiltAxis.clone(), spread };
    L.debris.push(d);
  }
  function updateDebris(dt) {
    for (const d of L.debris) {
      if (!d.part.group.visible) continue;
      d.t += dt;
      d.part.group.position.addScaledVector(d.down, dt * (0.4 + d.t * 1.6));
      d.part.group.rotateOnWorldAxis(d.axis, dt * 0.25);
      if (d.spread) {
        for (const piece of d.part.pieces) {
          if (Math.abs(piece.explode.dir.x) < 0.3) continue; // fairing halves and their doors swing out
          piece.mesh.position.addScaledVector(piece.explode.dir, dt * 0.9);
          piece.mesh.rotateZ(Math.sign(piece.explode.dir.x) * dt * -0.5);
        }
      }
      if (d.t > 4) d.part.group.visible = false;
    }
  }

  function onEvent(e) {
    L.label = EVENT_LABEL[e.type] ?? e.type.toUpperCase();
    L.labelUntil = L.real + 1.5;
    switch (e.type) {
      case "ignition":
        ignite(0, e.t);
        sfx.play("whoosh", { rate: 0.5, gain: 1.2 });
        break;
      case "liftoff":
        sfx.play("clunk"); // hold-down release
        state.shake = 1;
        for (const [i, arm] of (L.anchors?.arms ?? []).entries()) {
          const k = { v: 0 };
          const r0 = arm.mesh.rotation.y;
          const swing = THREE.MathUtils.degToRad(70) * (i % 2 ? -1 : 1);
          run(k, { v: 1, duration: D(900), ease: "outCubic", onUpdate: () => (arm.mesh.rotation.y = r0 + swing * k.v) });
        }
        break;
      case "meco":
        for (const pl of L.plumes) if (pl.stage === e.stage) pl.dead = true;
        break;
      case "sep": {
        const spent = parts.filter((p) => p.stageIndex === e.stage && !L.gone.has(p));
        for (const part of spent) drop(part);
        sfx.play("clunk", { rate: 0.8, gain: 0.8 });
        retarget();
        break;
      }
      case "ignition2": {
        const next = e.stage ?? Math.max(...[...L.gone].map((p) => p.stageIndex ?? -1)) + 1;
        ignite(next, e.t);
        sfx.play("whoosh", { rate: 0.7 });
        break;
      }
      case "fairing": {
        const fairing = parts.find((p) => p.kind === "fairing" && !L.gone.has(p));
        if (fairing) drop(fairing, { spread: true });
        sfx.play("whoosh", { rate: 1.3, gain: 0.6 });
        retarget();
        break;
      }
      case "seco":
        for (const pl of L.plumes) pl.dead = true;
        break;
    }
  }

  function launchUpdate(dt) {
    if (L.done) {
      if (L.drifting) L.flight.rotateY(dt * 0.15); // slow roll in orbit; the outcome line stays in the HUD
      updateDebris(dt);
      if (E) endingUpdate(dt);
      return;
    }
    L.real += dt;
    const t = simTime(L.keys, L.real);
    if (t < 0) {
      L.onTelemetry({ countdown: Math.ceil(-t) });
      return;
    }
    while (L.next < L.events.length && L.events[L.next].t <= t) onEvent(L.events[L.next++]);
    const last = L.samples[L.samples.length - 1];
    const s = sampleAt(L.samples, Math.min(t, last.t));

    // Motion: rise in frame, then the pad drops away under a tracking camera.
    const alt_u = Math.max(0, s.alt_m) * scale;
    const rise = Math.min(alt_u, L.riseMax);
    const below = alt_u - rise;
    L.flight.position.y = L.pivotY + rise;
    L.flight.quaternion.setFromAxisAngle(L.tiltAxis, THREE.MathUtils.degToRad(90 - (s.gamma_deg ?? 90)) * L.tiltSign);
    if (L.pad) {
      if (below > 300) L.padGone = true; // far downrange: never comes back under a falling stage
      L.pad.position.y = -below;
      L.pad.visible = !L.padGone;
    }

    // Plumes and pad light.
    const ambient = P0 * Math.exp(-Math.max(0, s.alt_m) / SCALE_HEIGHT_M);
    const camD = camera.position.distanceTo(controls.target);
    let padThrottle = 0;
    for (const pl of L.plumes) {
      const ramp = THREE.MathUtils.clamp((t - pl.ignite) / 0.25, 0, 1);
      const thr = pl.dead ? 0 : ramp * (s.stage === pl.stage || t < 1 ? Math.max(0.4, s.throttle ?? 1) : 0);
      pl.plume.update(dt, { throttle: thr, ambientPressure_Pa: ambient, cameraDistance: camD });
      if (pl.stage === 0) padThrottle = Math.max(padThrottle, thr);
    }
    L.padLight?.update(dt, padThrottle, Math.max(0, s.alt_m));
    if (padThrottle > 0 && s.alt_m < 300) state.shake = Math.max(state.shake, 0.35 * padThrottle * (1 - s.alt_m / 300));
    updateDebris(dt);

    // Camera: tracking once the rocket leaves the launch frame.
    if (below > 0 || L.tracking) {
      if (!L.tracking) {
        L.tracking = true;
        camAnim?.cancel();
        retarget();
      }
      const goal = L.flight.localToWorld(new THREE.Vector3(0, L.trackLocalY, 0));
      const k = 1 - Math.exp(-dt * 2.5);
      controls.target.lerp(goal, k);
      const d = camera.position.distanceTo(controls.target);
      camDir.copy(camera.position).sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(camDir, d + (L.trackDist - d) * k);
    }

    L.onTelemetry({
      t,
      alt_m: s.alt_m,
      vel_ms: s.vel_ms,
      g: (s.acc_ms2 ?? 0) / 9.80665,
      label: L.real < L.labelUntil ? L.label : s.gLimited ? "THROTTLING" : "",
    });

    if (t >= last.t) finishLaunch(s);
  }

  function finishLaunch(s) {
    L.done = true;
    for (const pl of L.plumes) pl.dead = true;
    const types = new Set(L.events.map((e) => e.type));
    const summary = L.sim.summary;
    const inOrbit = types.has("orbit");
    L.drifting = inOrbit;
    const maxAlt = Math.max(...L.samples.map((x) => x.alt_m));
    // The ascent's outcome line first; the planet ending's own lines follow it (and its final line wins).
    state.busy--;
    state.launch = "done";
    L.onTelemetry({ final: true, outcome: summary.outcome, inOrbit, summary, alt_m: s.alt_m });
    if (inOrbit && L.arrival?.legs?.length) {
      startEnding(L.arrival); // the planet ending (≤ 8 s): orbit, transfer, arrival, landing
    } else if (inOrbit) {
      // In orbit: frame the payload, orbit it slowly, unfold its hinges (fairing is long gone).
      const payload = parts.find((p) => p.kind === "payload" && !L.gone.has(p));
      controls.autoRotate = true;
      controls.autoRotateSpeed = payload ? 0.6 : 0.35;
      if (payload && deployables(payload).length) {
        const gen = state.gen;
        state.deploying = true;
        L.drifting = false; // hold the roll while the camera orbits the payload
        frameWorldPart(payload);
        wait(D(900))
          .then(() => (gen === state.gen ? deploy(payload) : false))
          .finally(() => {
            if (gen === state.gen) state.deploying = false;
          });
      }
    } else if (maxAlt < 50) {
      // Pad abort: thrust below weight, the engines shut down and it stays on the pad.
      state.shake = 0.3;
    } else {
      // Suborbital or never reached space: it fell back; fade out where it ends.
      const fade = { v: 1 };
      run(fade, {
        v: 0,
        duration: D(1200),
        ease: "inQuad",
        onUpdate: () => {
          for (const part of parts) if (!L?.gone.has(part)) setShellOpacity(part, shellTarget(part) * fade.v);
        },
        onComplete: () => {
          if (L) L.flight.visible = false;
        },
      });
    }
    changed();
    L.resolve?.(summary.outcome);
  }

  // launch(sim, { pad, onTelemetry }) -> Promise<outcome>. The stack must be complete and assembled.
  function launch(sim, { pad = null, anchors = null, onTelemetry = () => {}, arrival = null, countdown = COUNTDOWN_S } = {}) {
    if (state.busy || state.exploded || state.launch || !parts.length || !parts.every((p) => p.built) || !sim?.samples?.length) {
      return Promise.resolve(false);
    }
    for (const part of [...highlighted]) clearHighlight(part);
    for (const part of parts) if (part.dim) {
      part.dim.v = 1;
      applyLines(part);
    }
    state.busy++;
    state.launch = "flying";
    const H = stackHeight();
    const flight = new THREE.Group();
    flight.name = "flight";
    const pivotY = H * 0.45;
    flight.position.set(0, pivotY, 0);
    root.add(flight);
    for (const part of parts) flight.attach(part.group);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    L = {
      sim,
      samples: sim.samples,
      events: sim.events,
      keys: playbackKeys(sim.events, sim.samples[sim.samples.length - 1].t),
      real: -countdown,
      next: 0,
      flight,
      pad,
      pivotY,
      riseMax: H * 0.6,
      tiltAxis: fwd,
      tiltSign: 1,
      plumes: [],
      padLight: null,
      debris: [],
      gone: new Set(),
      label: "",
      labelUntil: 0,
      onTelemetry,
      tracking: false,
      done: false,
      arrival,
      anchors,
      arms0: (anchors?.arms ?? []).map((a) => a.mesh.rotation.y),
    };
    controls.autoRotate = false;
    sfx.play("launch-swell"); // 3 s riser, peaks at ignition (end of the countdown)
    frameSpan(0, H + L.riseMax, stackRadius(), 0.85, { pitch: HERO_PITCH, mode: "stack" });
    changed();
    return new Promise((resolve) => (L.resolve = resolve));
  }

  // ---------- deployables (design A4/A5) ----------
  // UI4's hinges: piece.deploy = { axis, pivot, angle, order } in part-local units; at fraction k the piece
  // turns k·angle about the axis through the pivot (k = 0 is exactly rest). Orders go one after another, each
  // hinge on a soft spring (a little overshoot past the open angle, then it settles).
  const hingeQ = new THREE.Quaternion();
  function applyDeploy(piece, k) {
    const d = piece.deploy;
    hingeQ.setFromAxisAngle(d.axis, k * d.angle);
    piece.mesh.position.copy(piece.rest.position).sub(d.pivot).applyQuaternion(hingeQ).add(d.pivot);
    piece.mesh.quaternion.copy(hingeQ).multiply(piece.rest.quaternion);
  }
  function deploy(part, { gap = 1300 } = {}) {
    const list = deployables(part);
    if (!list.length) return Promise.resolve(false);
    const orders = [...new Set(list.map((p) => p.deploy.order))].sort((a, b) => a - b);
    return Promise.all(
      list.map((piece, i) => {
        const k = { v: 0 };
        return run(k, {
          v: 1,
          delay: D(orders.indexOf(piece.deploy.order) * gap + (i % 4) * 60),
          ease: spring({ stiffness: 55, damping: 9 }),
          onBegin: () => sfx.play("tick", { rate: rnd(0.8, 0.95) }),
          onUpdate: () => applyDeploy(piece, k.v),
        });
      }),
    ).then(() => true);
  }
  // Frame a part where it is in the world (in flight it is off the pad axis), close, for the deploy.
  function frameWorldPart(part) {
    focusBox.makeEmpty();
    for (const piece of part.pieces) if (piece.mesh.visible) focusBox.expandByObject(piece.mesh);
    if (focusBox.isEmpty()) return;
    const c = focusBox.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, focusBox.getSize(new THREE.Vector3()).length() / 2);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.25;
    framedR = r;
    framedMode = "focus";
    return frameTo({ tx: c.x, ty: c.y, tz: c.z, dist: Math.max(controls.minDistance, dist), duration: D(1400) });
  }

  // ---------- planet ending (design §7, ≤ 8 s after ORBIT) ----------
  // Plays arrival.js legs (UI 2): { type: orbit | transfer | descent | touchdown | stranded, seconds, body, note }.
  // orbit: the body's planet (UI4's planet.js) rises in below the craft and turns under it; the payload unfolds
  // on the final orbit of a satellite mission. transfer: the upper stage relights, the origin planet recedes and
  // the destination comes in. descent: cut to UI4's surface patch; the payload comes down upright on a small
  // plume while its legs deploy (feet on the ground at touchdown). touchdown: UI4's dust puff. stranded: stays
  // in Earth orbit with the shortfall line.
  const PLANET_R = { earth: 70, moon: 26, mars: 40 };
  let E = null;
  // The Earth in orbit legs as the landing page shows it: the same place on screen, size and light relative to
  // the camera (main's landing shot: camera 0.62 R up and 2.05 R out from the centre at azimuth 0.58, aimed 1.02 R
  // up, sun from `sun`; pole at the top limb), re-placed and re-oriented from the camera every frame (postUpdate),
  // so the craft floats in front of the globe's dark limb while the ground slides east under it. Close above a huge globe, the old placement showed its lit pole at grazing angles: rims
  // and atmosphere over half the frame, washed out. Drawn at 4.5 craft radii (scaled), well inside the stars.
  const landingView = { up: 0.62, back: 2.05, aim: 1.02, az: 0.58, sun: new THREE.Vector3(-0.85, 0.35, -0.2).normalize() };
  const backdrop = (() => {
    const eye = new THREE.Vector3(0, landingView.up, landingView.back).applyAxisAngle(Y, landingView.az);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, new THREE.Vector3(0, landingView.aim, 0), Y)).invert();
    // camera space: the centre (per unit R), the sun, the globe's orientation
    return { off: eye.clone().negate().applyQuaternion(q), sun: landingView.sun.clone().applyQuaternion(q), q };
  })();
  const tmpV = new THREE.Vector3();
  function placeBackdrop() {
    const b = E?.backdrop;
    if (!b) return;
    const R = b.planet.R * b.planet.object3d.scale.x;
    tmpV.copy(backdrop.off).multiplyScalar(R);
    tmpV.y -= (1 - b.k.v) * 0.9 * R; // rising into place
    b.planet.object3d.position.copy(tmpV.applyQuaternion(camera.quaternion).add(camera.position));
    b.planet.setSunDir(tmpV.copy(backdrop.sun).applyQuaternion(camera.quaternion));
    tmpQ.setFromAxisAngle(Y, (performance.now() - b.t0) * 5e-5); // 0.05 rad/s
    b.planet.object3d.quaternion.copy(camera.quaternion).multiply(backdrop.q).multiply(tmpQ);
  }
  function setBackdrop(planet, ms) {
    planet.object3d.visible = true;
    planet.object3d.scale.setScalar(Math.max(2, E.r * 4.5) / planet.R);
    E.backdrop = { planet, k: { v: ms ? 0 : 1 }, t0: performance.now() };
    if (ms) run(E.backdrop.k, { v: 1, duration: D(ms), ease: "outCubic" });
    placeBackdrop();
  }

  // Scene changes inside the ending (to the booster, back to the payload, down to the surface) go through black:
  // 120 ms down while the old scene plays on, the change on a black frame (held one more frame so first-use
  // uploads land unseen), 130 ms up. state.cut is the overlay's opacity.
  const CUT_DOWN = 0.12;
  const CUT_UP = 0.13;
  const CUT_LEGS = new Set(["booster", "earth-payload", "stranded", "descent"]);
  function cutUpdate(dt) {
    const c = E.cut;
    if (!c.fired) {
      c.t += dt;
      state.cut = Math.min(1, c.t / CUT_DOWN);
      if (c.t < CUT_DOWN) return;
      c.fired = true;
      c.hold = 1;
      c.fn();
      return;
    }
    if (c.hold-- > 0) return;
    c.up += dt;
    state.cut = Math.max(0, 1 - c.up / CUT_UP);
    if (c.up >= CUT_UP) {
      E.cut = null;
      state.cut = 0;
    }
  }
  function craftBox() {
    focusBox.makeEmpty();
    for (const part of parts) {
      if (L?.gone.has(part)) continue;
      for (const piece of part.pieces) if (piece.mesh.visible) focusBox.expandByObject(piece.mesh);
    }
    return focusBox.clone();
  }
  function planetFor(body) {
    if (!E.planets[body]) {
      const R = PLANET_R[body] ?? 40;
      const planet = createPlanet({ kind: body, radius_u: R });
      planet.setSunDir?.(new THREE.Vector3(-0.85, 0.35, -0.2).normalize());
      planet.R = R;
      scene.add(planet.object3d);
      E.planets[body] = planet;
    }
    return E.planets[body];
  }
  // A planet slides up into place below the craft (from 0.9 R lower) over `ms`.
  function bringPlanet(planet, ms) {
    const target = E.F.clone().add(new THREE.Vector3(0, -(planet.R + E.r * 2.6), 0));
    planet.object3d.visible = true;
    planet.object3d.scale.setScalar(1);
    const from = target.clone().add(new THREE.Vector3(0, -planet.R * 0.9, 0));
    planet.object3d.position.copy(from);
    const k = { v: 0 };
    run(k, { v: 1, duration: D(ms), ease: "outCubic", onUpdate: () => planet.object3d.position.lerpVectors(from, target, k.v) });
  }
  function frameCraft(distK, pitchDeg, ms = 900) {
    framedR = E.r * 3;
    framedMode = "focus";
    frameTo({ tx: E.F.x, ty: E.F.y, tz: E.F.z, dist: Math.max(controls.minDistance, E.r * distK), pitch: THREE.MathUtils.degToRad(pitchDeg), duration: D(ms) });
  }
  function startEnding(arrival) {
    const box = craftBox();
    E = {
      arrival,
      legs: arrival.legs,
      i: -1,
      legT: 0,
      planets: {},
      F: box.getCenter(new THREE.Vector3()),
      r: Math.max(0.4, box.getSize(new THREE.Vector3()).length() / 2),
      dust: createDustPuff(),
      patch: null,
      lander: null,
      origin: null,
    };
    scene.add(E.dust.object3d);
    // Earth missions land something: the Falcon booster (when it returns), then the payload deployed above
    // Earth (planet below), or stranded above Earth when short. Moon/Mars keep arrival.js's legs.
    const booster = L.sim.summary.booster;
    if (!arrival.body || arrival.body === "earth") {
      E.legs = [];
      if (booster?.returns && booster.samples?.length) E.legs.push({ type: "booster", seconds: 4.4 });
      E.legs.push({ type: arrival.success ? "earth-payload" : "stranded", seconds: 3.4, body: "earth" });
    }
    state.ending = true;
    controls.autoRotate = false;
    nextLeg();
    if (L.skipEnding) fastForwardEnding();
  }
  // Run the remaining legs to their end state at once (double-click skip).
  function fastForwardEnding() {
    E.fast = true;
    E.cut = null;
    state.cut = 0;
    while (E && state.ending) {
      const leg = E.legs[E.i];
      if (leg?.type === "booster" && E.booster && !E.booster.ended) {
        const B = E.booster;
        B.outer.position.y = B.touchY;
        B.outer.quaternion.identity();
        for (const plume of B.plumes) plume.update(0, { throttle: 0, ambientPressure_Pa: P0, cameraDistance: 10 });
        B.touched = true;
      }
      if (leg?.type === "descent" && E.lander) {
        E.lander.part.group.position.y = E.lander.touchY;
        E.lander.plume.update(0, { throttle: 0, ambientPressure_Pa: 0, cameraDistance: 10 });
      }
      nextLeg();
    }
  }
  function nextLeg() {
    const up = E.legs[E.i + 1];
    if (up && CUT_LEGS.has(up.type) && !E.fast) {
      E.cut ??= { t: 0, up: 0, fired: false, hold: 0, fn: advanceLeg };
      return;
    }
    advanceLeg();
  }
  function advanceLeg() {
    E.i++;
    E.legT = 0;
    const leg = E.legs[E.i];
    if (!leg) return finishEnding();
    L.onTelemetry({ ending: true, leg });
    const lastOrbit = !E.legs.slice(E.i + 1).some((l) => l.type === "orbit" || l.type === "descent");
    switch (leg.type) {
      case "orbit": {
        const planet = planetFor(leg.body);
        if (leg.body === "earth" || !leg.body) {
          if (E.backdrop?.planet !== planet) setBackdrop(planet, Math.min(900, leg.seconds * 600));
        } else if (E.origin !== planet) bringPlanet(planet, Math.min(900, leg.seconds * 600));
        for (const p of Object.values(E.planets)) if (p !== planet) p.object3d.visible = false;
        E.origin = planet;
        frameCraft(5.5, 18);
        const payload = parts.find((p) => p.kind === "payload" && !L.gone.has(p));
        if (lastOrbit && payload && !E.deployed && deployables(payload).length) {
          E.deployed = true;
          deploy(payload, { gap: 500 });
        }
        break;
      }
      case "transfer": {
        E.burn = leg.seconds * 0.5; // the upper stage relights for the first half
        E.from = E.origin;
        E.backdrop = null; // the origin recedes in the world from where it is
        E.fromScale = E.from?.object3d.scale.x ?? 1;
        E.to = leg.body && E.planets[leg.body] !== E.origin && PLANET_R[leg.body] ? planetFor(leg.body) : null;
        if (E.to) E.to.object3d.visible = false;
        frameCraft(9, 12, leg.seconds * 500);
        break;
      }
      case "descent":
        startDescent(leg);
        break;
      case "touchdown":
        if (E.lander) {
          E.lander.part.group.position.y = E.lander.touchY;
          E.lander.plume?.update(0, { throttle: 0, ambientPressure_Pa: 0, cameraDistance: 10 });
          E.dust.fire({ position: E.lander.ground.clone(), radius: E.lander.part.radius * 1.6 });
          sfx.play("clunk", { gain: 0.6 });
          state.shake = 0.3;
        }
        break;
      case "booster":
        startBooster(L.sim.summary.booster);
        break;
      case "earth-payload":
      case "stranded": {
        endBoosterScene();
        L.flight.visible = true;
        const planet = planetFor("earth");
        E.origin = planet;
        frameCraft(5.5, 18, 1); // on the black frame of the cut
        setBackdrop(planet, 0);
        const payload = parts.find((p) => p.kind === "payload" && !L.gone.has(p));
        if (leg.type === "earth-payload" && payload && deployables(payload).length) deploy(payload, { gap: 500 });
        break;
      }
    }
  }

  // ---------- booster return (design A4): the stage-0 parts land on the pad (rtls) or a drone-ship deck ----------
  // Screen ~4.4 s, mapped onto UI 2's booster events: flip (grid fins unfold), 3-engine entry burn, coast (legs
  // deploy), 1-engine landing burn (deck splash), touchdown. Telemetry reads the booster samples at the mapped T+.
  const BOOSTER_PHASES = [
    { name: "FLIP", s: 0.7 },
    { name: "ENTRY BURN", s: 1.2, lit: 3 },
    { name: "COAST", s: 0.7 },
    { name: "LANDING BURN", s: 1.2, lit: 1 },
    { name: "TOUCHDOWN", s: 0.6 },
  ];
  function startBooster(bst) {
    const bparts = parts.filter((p) => p.stageIndex === 0);
    if (!bparts.length) return;
    L.debris = L.debris.filter((d) => !bparts.includes(d.part)); // the falling-away tumble no longer owns them
    L.flight.visible = false;
    for (const p of Object.values(E.planets)) p.object3d.visible = false;
    const Hb = Math.max(...bparts.map((p) => p.slotY + p.height));
    const outer = new THREE.Group();
    const inner = new THREE.Group();
    inner.position.y = -Hb / 2; // pivot at mid-height, so the flip turns about the middle
    outer.add(inner);
    scene.add(outer);
    for (const part of bparts) {
      inner.add(part.group);
      part.group.position.set(0, part.slotY, 0);
      part.group.quaternion.identity();
      part.group.visible = true;
      for (const piece of part.pieces) {
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
        piece.mesh.visible = true;
      }
    }
    // Landing zone at the origin: the real pad (rtls) or a drone-ship deck.
    let zone = null;
    if (bst.mode === "rtls" && L.pad) {
      L.pad.position.y = 0;
      L.pad.visible = true;
    } else {
      if (L.pad) L.pad.visible = false;
      const ship = createDroneShip({ size_u: Math.max(...bparts.map((p) => p.radius)) * 9 });
      ship.object3d.position.y = -(ship.deckY ?? 0); // deck at y = 0, where the feet touch down
      zone = ship.object3d;
      scene.add(zone);
    }
    // Feet height with fins and legs out: deploy to 1, measure, put back.
    const deps = bparts.flatMap((p) => deployables(p));
    for (const piece of deps) applyDeploy(piece, 1);
    outer.position.set(0, 0, 0);
    outer.updateMatrixWorld(true);
    focusBox.makeEmpty();
    for (const part of bparts) for (const piece of part.pieces) focusBox.expandByObject(piece.mesh);
    const feet = focusBox.min.y; // relative to the outer pivot at y = 0
    for (const piece of deps) applyDeploy(piece, 0);
    const touchY = -feet;
    const startY = touchY + Hb * 2.4;
    outer.position.y = startY;
    // Plumes: the ascent's stage-0 plumes ride on the engines part; light the innermost bells first.
    const bplumes = L.plumes
      .filter((pl) => pl.stage === 0)
      .map((pl) => pl.plume)
      .sort((a, b) => Math.hypot(a.object3d.position.x, a.object3d.position.z) - Math.hypot(b.object3d.position.x, b.object3d.position.z));
    const exitR = Math.max(...bplumes.map((p) => p.exitRadius_u ?? 0.1), 0.1);
    const splash = adoptPadLight(createPadLight({ baseRadius_u: Math.max(...bparts.map((p) => p.radius)), bellExitRadius_u: exitR }));
    scene.add(splash.object3d);
    const ev = (type) => bst.events.find((e) => e.type === type);
    const tFlip = ev("flip")?.t ?? bst.samples[0].t;
    const tEntry = ev("entry")?.t ?? tFlip + 60;
    const tLand = ev("landing-burn")?.t ?? tEntry + 60;
    const tDown = ev("touchdown")?.t ?? ev("lost")?.t ?? tLand + 20;
    E.booster = {
      bst, bparts, outer, zone, splash, plumes: bplumes, Hb, startY, touchY, u: 0, landed: Boolean(ev("touchdown")),
      times: [tFlip, tEntry, (tEntry + tLand) / 2, tLand, tDown, tDown],
    };
    if (deps.length) for (const part of bparts) if (deployables(part).length) deploy(part, { gap: 2600 }); // fins now, legs just before the landing burn
    camAnim?.cancel();
    sfx.play("whoosh", { rate: 0.7 });
  }
  function boosterSampleAt(t) {
    const smp = E.booster.bst.samples;
    if (t <= smp[0].t) return smp[0];
    for (let i = 1; i < smp.length; i++) if (smp[i].t >= t) return smp[i];
    return smp[smp.length - 1];
  }
  function boosterUpdate(dt) {
    const B = E.booster;
    B.u += dt;
    let acc = 0;
    let phase = BOOSTER_PHASES.length - 1;
    for (let i = 0; i < BOOSTER_PHASES.length; i++) {
      if (B.u < acc + BOOSTER_PHASES[i].s) {
        phase = i;
        break;
      }
      acc += BOOSTER_PHASES[i].s;
    }
    const ph = BOOSTER_PHASES[phase];
    const q = Math.min(1, (B.u - acc) / ph.s);
    const total = BOOSTER_PHASES.reduce((n, p) => n + p.s, 0);
    // Height: down to the deck by the end of the landing burn, slowing over it.
    const fall = Math.min(1, B.u / (total - BOOSTER_PHASES[4].s));
    const ease = 1 - (1 - fall) ** 2.2;
    B.outer.position.y = B.startY + (B.touchY - B.startY) * ease;
    // Flip: from engines-up to engines-down over the first phase.
    const flip = phase === 0 ? 1 - q * q * (3 - 2 * q) : 0;
    B.outer.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * flip);
    const lit = ph.lit ?? 0;
    const alt_m = Math.max(0, (B.outer.position.y - B.touchY) / scale);
    B.plumes.forEach((plume, i) => plume.update(dt, { throttle: i < lit ? 1 : 0, ambientPressure_Pa: P0 * Math.exp(-alt_m * 40 / SCALE_HEIGHT_M), cameraDistance: camera.position.distanceTo(controls.target) }));
    B.splash.update(dt, phase === 3 ? 1 : 0, alt_m);
    if (phase === 4 && !B.touched) {
      B.touched = true;
      sfx.play("clunk", { gain: 0.8 });
      state.shake = 0.5;
    }
    // Camera: low and steady at the deck, following the booster down.
    const ty = B.outer.position.y + B.Hb * 0.1;
    controls.target.set(0, ty * 0.6 + B.touchY * 0.4, 0);
    const d = B.Hb * 2.6;
    const el = THREE.MathUtils.degToRad(6);
    camera.position.set(Math.sin(0.58) * Math.cos(el) * d, controls.target.y + Math.sin(el) * d, Math.cos(0.58) * Math.cos(el) * d);
    framedR = B.Hb * 0.5;
    framedMode = "focus";
    // Telemetry on the booster's own clock.
    const t = B.times[phase] + (B.times[phase + 1] - B.times[phase]) * q;
    const smp = boosterSampleAt(t);
    L.onTelemetry({ booster: true, t, alt_m: smp.alt_m, vel_ms: smp.vel_ms, label: phase === 4 ? (B.landed ? "TOUCHDOWN" : "LOST") : ph.name });
  }
  function endBoosterScene() {
    const B = E?.booster;
    if (!B || B.ended) return;
    B.ended = true;
    B.outer.visible = false;
    for (const plume of B.plumes) plume.update(0, { throttle: 0, ambientPressure_Pa: 0, cameraDistance: 10 });
    B.splash.update(0, 0, 1000);
  }
  function startDescent(leg) {
    const payload = parts.find((p) => p.kind === "payload" && !L.gone.has(p));
    if (!payload) return;
    // Cut to the surface: the planet sphere and the rest of the stack go; the payload comes down upright.
    for (const p of Object.values(E.planets)) p.object3d.visible = false;
    const ground = E.F.clone().add(new THREE.Vector3(0, -E.r * 4, 0));
    E.patch = createSurfacePatch({ kind: leg.body === "mars" ? "mars" : "moon", radius_u: Math.max(8, E.r * 6) });
    E.patch.object3d.position.copy(ground);
    scene.add(E.patch.object3d);
    root.attach(payload.group);
    L.gone.add(payload);
    L.flight.visible = false;
    payload.group.quaternion.identity();
    for (const piece of payload.pieces) if (/:(0|1)$/.test(piece.mesh.name)) piece.mesh.visible = false; // adapter cone + clamp band
    // Where the feet end up once the legs are out: deploy to 1, measure, put them back.
    const deps = deployables(payload);
    for (const piece of deps) applyDeploy(piece, 1);
    payload.group.position.set(ground.x, 0, ground.z);
    payload.group.updateMatrixWorld(true);
    focusBox.makeEmpty();
    for (const piece of payload.pieces) if (piece.mesh.visible) focusBox.expandByObject(piece.mesh);
    const feetLocal = focusBox.min.y - payload.group.position.y;
    for (const piece of deps) applyDeploy(piece, 0);
    const touchY = ground.y - feetLocal;
    const startY = touchY + E.r * 3;
    payload.group.position.y = startY;
    const plume = createPlume({ engineRecord: { id: "lander", propellant: "hypergolic" }, exitRadius_u: Math.max(0.05, payload.radius * 0.22) });
    plume.object3d.position.set(0, feetLocal * 0.3, 0);
    payload.group.add(plume.object3d);
    E.lander = { part: payload, ground, touchY, startY, plume };
    if (deps.length) deploy(payload, { gap: 300 });
    framedR = E.r * 2;
    framedMode = "focus";
    E.backdrop = null;
    frameTo({ tx: ground.x, ty: ground.y + E.r * 1.4, tz: ground.z, dist: E.r * 6, pitch: THREE.MathUtils.degToRad(10), duration: 1 }); // on the black frame of the cut
  }
  function endingUpdate(dt) {
    if (E.cut) {
      cutUpdate(dt);
      if (!E) return;
    }
    const leg = E.legs[E.i];
    E.legT += dt;
    for (const p of Object.values(E.planets)) {
      if (!p.object3d.visible) continue;
      p.update(E.legT, camera);
      p.object3d.rotation.x += dt * 0.05; // the ground slides under the craft
    }
    if (leg?.type === "transfer") {
      const q = Math.min(1, E.legT / Math.max(0.1, leg.seconds));
      if (E.from) {
        E.from.object3d.position.y -= dt * E.from.R * E.fromScale * 0.6;
        E.from.object3d.scale.setScalar(E.fromScale * (1 - 0.6 * q));
      }
      if (E.to && q > 0.5 && !E.to.object3d.visible) bringPlanet(E.to, leg.seconds * 450);
      const lastStage = Math.max(...L.plumes.map((pl) => pl.stage));
      for (const pl of L.plumes) {
        if (pl.stage !== lastStage) continue;
        pl.plume.update(dt, { throttle: E.legT < E.burn ? 1 : 0, ambientPressure_Pa: 0, cameraDistance: camera.position.distanceTo(controls.target) });
      }
    }
    if (leg?.type === "booster" && E.booster && !E.booster.ended) boosterUpdate(dt);
    if (leg?.type === "descent" && E.lander) {
      const q = Math.min(1, E.legT / Math.max(0.1, leg.seconds));
      const ease = 1 - (1 - q) ** 3;
      E.lander.part.group.position.y = E.lander.startY + (E.lander.touchY - E.lander.startY) * ease;
      E.lander.plume.update(dt, { throttle: 1 - q * 0.6, ambientPressure_Pa: 0, cameraDistance: camera.position.distanceTo(controls.target) });
    }
    E.patch?.update?.(E.legT);
    E.dust.update(dt);
    if (leg && E.legT >= leg.seconds && !E.cut) nextLeg();
  }
  function finishEnding() {
    state.ending = false;
    L.onTelemetry({ ending: true, final: true, arrival: E.arrival, booster: E.booster ? (E.booster.landed ? "landed" : "lost") : null });
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;
    changed();
  }
  function disposeEnding() {
    if (!E) return;
    for (const p of Object.values(E.planets)) p.dispose();
    E.patch?.dispose?.();
    if (E.patch) scene.remove(E.patch.object3d);
    E.lander?.plume?.dispose();
    if (E.booster) {
      dropPadLight(E.booster.splash);
      if (E.booster.zone) {
        scene.remove(E.booster.zone);
        E.booster.zone.traverse((o) => o.geometry?.dispose()); // UI4's ship shares its prop materials: keep them
      }
      scene.remove(E.booster.outer);
    }
    E.dust.dispose?.();
    scene.remove(E.dust.object3d);
    E = null;
    state.ending = false;
    state.cut = 0;
  }

  // After a launch: the assembled rocket back on the pad, still built (story mode's twin compare).
  function returnToPad() {
    if (!L || !L.done) return false;
    endLaunch();
    for (const part of parts) {
      for (const piece of part.pieces) {
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
        piece.mesh.visible = part.built;
      }
      fadeShell(part, shellTarget(part), 0);
    }
    controls.autoRotate = false;
    frameStack();
    changed();
    return true;
  }

  // Undo a launch (reset / preset switch): plumes and pad light gone, parts back on the pad.
  function endLaunch() {
    disposeEnding();
    if (!L) return;
    for (const pl of L.plumes) pl.plume.dispose();
    dropPadLight(L.padLight);
    (L.anchors?.arms ?? []).forEach((arm, i) => (arm.mesh.rotation.y = L.arms0[i] ?? arm.mesh.rotation.y));
    if (L.pad) {
      L.pad.position.y = 0;
      L.pad.visible = true;
    }
    for (const part of parts) {
      root.attach(part.group);
      part.group.position.set(0, part.slotY, 0);
      part.group.quaternion.identity();
      part.group.visible = true;
    }
    root.remove(L.flight);
    L.resolve?.(false);
    L = null;
    state.launch = null;
  }

  // ---------- build all / build up to / reset ----------
  // Pipelined: the next part starts flying the moment the previous part's body has seated, while that part's
  // details are still landing. The camera follows each part and settles on the stack once, at the end.
  async function buildUpTo(target, { onLastSeat } = {}) {
    if (state.busy || state.exploded || target.built) return false;
    const gen = state.gen;
    state.auto = true;
    const running = [];
    try {
      for (const part of parts.slice(0, index(target) + 1)) {
        if (part.built) continue;
        let seated;
        const seatedP = new Promise((r) => (seated = r));
        const last = part === target;
        const done = buildPart(part, {
          onSeated: () => {
            seated();
            if (last) onLastSeat?.();
          },
        });
        running.push(done);
        const ok = await Promise.race([seatedP.then(() => true), done]);
        if (!ok || gen !== state.gen) return false;
      }
      const results = await Promise.all(running);
      if (gen !== state.gen || results.includes(false)) return false;
    } finally {
      if (gen === state.gen) {
        state.auto = false;
        if (!state.busy) frameStack();
        changed();
      }
    }
    return true;
  }

  async function buildAll() {
    if (state.busy || state.exploded || !parts.length || parts.every((p) => p.built)) return;
    const gen = state.gen;
    sfx.play("assemble-cue"); // UI 2's music cue; the sting lands on the last lock
    const ok = await buildUpTo(parts[parts.length - 1], { onLastSeat: () => sfx.play("assemble-sting") });
    if (!ok || gen !== state.gen) return;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    setTimeout(() => {
      if (gen === state.gen && !state.exploded) controls.autoRotate = false;
    }, 6500);
  }

  // Back to the empty pad (camera untouched).
  function clear() {
    sfx.stopMusic?.(0.3);
    endLaunch();
    state.gen++;
    cancelAll();
    controls.autoRotate = false;
    state.busy = 0;
    state.exploded = false;
    state.scrubbing = false;
    state.auto = false;
    state.deploying = false;
    state.ending = false;
    xs.v = 0;
    xAnim = null;
    xParts = [];
    state.shake = 0;
    for (const part of [...highlighted]) clearHighlight(part);
    for (const part of [...leaving]) retirePart(part); // still flying out of an interrupted swap
    for (const part of parts) {
      part.dimAnim?.cancel();
      if (part.dim) {
        part.dim.v = 1;
        applyLines(part);
      }
    }
    for (const part of parts) {
      part.built = false;
      part.busy = false;
      hideGhostNow(part);
      part.look = "opaque";
      fadeShell(part, SHELL.opaque, 0);
      part.group.position.y = part.slotY;
      for (const piece of part.pieces) {
        piece.mesh.visible = false;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
    }
    ghostPart = null;
  }

  function reset() {
    clear();
    home();
    changed();
  }

  // A switched-to rocket appears built: every part at rest, then one snap from a small axial spread (all parts
  // at once, spring 130/12, one clunk). No part-by-part build.
  function appearBuilt() {
    const gap = 1.2 * scale;
    parts.forEach((part, i) => {
      part.built = true;
      part.busy = false;
      hideGhostNow(part);
      for (const piece of part.pieces) {
        piece.mesh.visible = true;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
      part.group.position.y = part.slotY + (i + 1) * gap;
    });
    const gen = state.gen;
    state.busy++;
    const k = { v: 1 };
    run(k, {
      v: 0,
      ease: spring({ stiffness: 130, damping: 12 }),
      onUpdate: () => parts.forEach((p, i) => (p.group.position.y = p.slotY + (i + 1) * gap * k.v)),
    }).then(() => {
      if (gen !== state.gen) return;
      state.busy--;
      sfx.play("clunk", { gain: 0.8 });
      state.shake = 0.6;
      changed();
    });
    frameStack({ duration: D(700) });
    changed();
  }

  // ---------- skip (double-click / double-tap) ----------
  // Finish whatever is animating, at once: a launch jumps to its outcome (and through the planet ending), an
  // ending runs to its end state, an explode/assemble lands, a build / Build all / swap / remove / switch snap
  // settles with every part at rest (in-flight parts built, a part being removed gone). Returns what it did.
  function skip() {
    // A held outcome frame (manual launch): leave it, the rocket back on the pad, still built.
    if (L && L.done && !state.ending) {
      returnToPad();
      return "pad";
    }
    if (L && !L.done) {
      L.real = Math.max(L.real, L.keys[L.keys.length - 1][1] + 0.01);
      L.skipEnding = true;
      return "launch";
    }
    if (E && state.ending) {
      fastForwardEnding();
      return "ending";
    }
    if (xAnim) {
      xAnim.cancel();
      live.delete(xAnim);
      finishExplode(xTarget);
      return "explode";
    }
    if (!state.busy && !state.auto) return null;
    const all = state.auto;
    state.gen++; // pending build/swap continuations bail out
    cancelAll();
    for (const part of [...leaving]) retirePart(part);
    for (const part of parts) {
      const built = part.removing ? false : all || part.built || part.busy;
      part.built = built;
      part.busy = false;
      part.removing = false;
      part.group.position.y = part.slotY;
      hideGhostNow(part);
      for (const piece of part.pieces) {
        piece.mesh.visible = built;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
      if (built) fadeShell(part, shellTarget(part), 0);
    }
    state.busy = 0;
    state.auto = false;
    frameStack();
    changed();
    return "settled";
  }

  // Preset switch: cancel everything, dispose the old stack, set up the new one.
  function rebuild(next) {
    clear();
    for (const part of parts) retirePart(part);
    parts = next;
    for (const part of parts) setupPart(part);
    if (warmRenderer) prewarm(warmRenderer);
    home();
    changed();
  }

  // Warm-up so the first build has no hitch: compile every program and upload every geometry (one offscreen
  // render with culling off; a 200-piece stack otherwise stalls ~2 s on the frame its pieces first appear).
  // The launch and ending effects (plume and sprite, pad disc and splash, the three planets, the surface
  // patches, dust, the drone ship) are warmed the same way, from one hidden set kept for the session so their
  // programs stay cached: otherwise each compiles on the frame it first appears (ignition, the booster's
  // landing burn, the arrival).
  let warmFx = null;
  function warmEffects() {
    if (!warmFx) {
      warmFx = new THREE.Group();
      warmFx.name = "warm-fx";
      const pad = createPadLight({ baseRadius_u: 0.5 });
      pad.light.removeFromParent(); // the scene's light count stays as it is (see glow)
      warmFx.add(
        createPlume({ engineRecord: { id: "warm", propellant: "kerolox" }, exitRadius_u: 0.05 }).object3d,
        pad.object3d,
        ...["earth", "moon", "mars"].map((kind) => createPlanet({ kind, radius_u: 0.05 }).object3d),
        ...["moon", "mars"].map((kind) => createSurfacePatch({ kind, radius_u: 0.5 }).object3d),
        createDustPuff().object3d,
        createDroneShip({ size_u: 0.5 }).object3d,
      );
      warmFx.position.set(0, -50, 0);
      scene.add(warmFx);
    }
    warmFx.traverse((o) => {
      o.visible = true;
      o.frustumCulled = false;
    });
    return () => (warmFx.visible = false);
  }
  const warmTarget = new THREE.WebGLRenderTarget(4, 4);
  function prewarm(renderer) {
    warmRenderer = renderer;
    const unwarm = warmEffects();
    const meshes = parts.flatMap((p) => p.pieces.map((q) => q.mesh));
    for (const part of parts) part.ghost.visible = true;
    for (const m of meshes) {
      m.visible = true;
      m.frustumCulled = false;
    }
    renderer.compile(scene, camera);
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(warmTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    for (const m of meshes) m.frustumCulled = true;
    unwarm();
    for (const part of parts) {
      part.ghost.visible = part.ghostActive || part.ghostFade.v > 0;
      for (const piece of part.pieces) piece.mesh.visible = part.built;
    }
  }

  function update(dt, t) {
    for (const part of parts) {
      part.holoGhost.update(t);
      if (part.ghost.visible) part.ghost.position.y = part.slotY + Math.sin(t * 2.6) * 0.05;
    }
    if (highlighted.size) updateHighlights(t);
    if (L) launchUpdate(dt);
    updateGlow();
    flash.update(dt);
    if (state.shake > 0.002) {
      state.shake *= Math.exp(-dt * 8);
      root.position.set((Math.random() - 0.5) * 0.09 * state.shake, 0, (Math.random() - 0.5) * 0.09 * state.shake);
    } else if (root.position.x !== 0) {
      root.position.set(0, 0, 0);
    }
  }

  // After main's controls.update(): what hangs off the final camera pose this frame.
  function postUpdate() {
    placeBackdrop();
  }

  // The always-on ghost starts with the first part.
  syncGhost();

  return {
    state,
    get parts() {
      return parts;
    },
    canBuild,
    isTopBuilt,
    topY,
    setGhost,
    ghostPart: () => ghostPart,
    highlight,
    focus,
    unfocus,
    framedRadius: () => framedR,
    framing: () => ({ r: framedR, mode: framedMode }),
    build,
    buildUpTo,
    remove,
    explode,
    assemble,
    toggleExplode,
    scrubStart,
    scrubBy,
    scrubEnd,
    toggleLook,
    toggleLookAll,
    setLook,
    launch,
    returnToPad,
    frameCompare,
    frameStack: () => frameStack(),
    homePose,
    swap,
    applyManifest,
    restack,
    buildAll,
    reset,
    rebuild,
    appearBuilt,
    skip,
    setBounds,
    prewarm,
    update,
    postUpdate,
    landingView,
    home,
  };
}
