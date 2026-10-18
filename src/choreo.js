// Choreography: anime.js drives every motion (paths, springs, staggers); three.js only draws.
// Mechanical model (design §4, round 7): pieces are solid from the first frame; constant timings for every kind.
// Build    = pieces fly in from the staging side on gentle arcs in `order`, each turned by `spin` about Y and
//            rolled about its travel axis; the turn unwinds over the last 30 % of the path; spring landing
//            (260/14), a tick per piece; lock = flash + clunk + shake. Engine clusters stagger ~110 ms engine
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
// X-ray    = shell opacity states via parts.setShellOpacity (design round 10): built 0.55, exploded 0.30,
//            selected part 0.15 while the others keep theirs, 0.55 from the first frame of a fly-in.
import * as THREE from "three";
import { animate, spring } from "animejs";
import { createHologramMaterial } from "./fx/hologram.js";
import { createBoltFlash } from "./fx/flash.js";
import { COLORS, LOOK, setShellOpacity as setShell } from "./parts.js";

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

const SHELL = { built: 0.55, exploded: 0.3, focus: 0.15 };
// Opacity states belong to the x-ray look only; the classic look keeps opaque shells.
const setShellOpacity = LOOK === "xray" ? setShell : () => {};
const GHOST_IDLE = 0.12;
const GHOST_HOVER = 0.35;
const EXPLODE_GAP_M = 3; // exploded view: clearance between parts, metres (visual)
const SWAP_CLEAR_M = 3; // swap: how far the parts above lift to make room, metres (visual)
// Timings (ms). Same for every part kind; only piece counts differ.
const T = {
  fly: 620, // one piece's path in
  flyOut: 460, // one piece's path out
  engineStagger: 110,
  subStagger: 35,
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

  const state = { busy: 0, exploded: false, auto: false, gen: 0, shake: 0 };
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
    part.shell = { v: SHELL.built };
    setShellOpacity(part, SHELL.built);
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
    part.hlAnim?.cancel();
    highlighted.delete(part);
    leaving.delete(part);
    if (ghostPart === part) ghostPart = null;
    root.remove(part.group, part.ghost);
    for (const piece of part.pieces) {
      piece.mesh.geometry.dispose();
      for (const m of [].concat(piece.mesh.material)) m.dispose();
    }
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
  let camAnim = null; // one camera move at a time: a new framing replaces the one in flight
  function frameTo({ ty, dist, orbit = 0, duration = D(1100), ease = "inOutCubic" }) {
    const cur = { ty: controls.target.y, d: camera.position.distanceTo(controls.target), az: 0 };
    let az = 0;
    camAnim?.cancel();
    live.delete(camAnim);
    const p = run(cur, {
      ty,
      d: dist,
      az: orbit,
      duration,
      ease,
      onUpdate: () => {
        controls.target.set(0, cur.ty, 0);
        camDir.copy(camera.position).sub(controls.target).normalize();
        if (orbit) camDir.applyAxisAngle(Y, cur.az - az);
        az = cur.az;
        camera.position.copy(controls.target).addScaledVector(camDir, cur.d);
      },
    });
    camAnim = p.anim;
    return p;
  }
  // Distance at which the span [y0, y1] around the axis (radius r) fills `frac` of the viewport height
  // (and fits the width), for the current camera pitch.
  function fitDist(h, r, frac) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camDir.copy(camera.position).sub(controls.target).normalize();
    const pitch = Math.abs(Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1)));
    const dv = (h * Math.cos(pitch) + 2 * r * Math.sin(pitch)) / (2 * tanHalf * frac);
    const dh = (2 * r) / (2 * tanHalf * camera.aspect * frac);
    return Math.max(dv, dh) + r;
  }
  // The centre sits `shift` of the view (default 2 %) below the span's middle, so the base clears the bar.
  function frameSpan(y0, y1, r, frac, { shift = 0.02, ...opts } = {}) {
    const dist = Math.max(controls.minDistance, fitDist(Math.max(y1 - y0, 0.05), r, frac));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return frameTo({ ty: (y0 + y1) / 2 - shift * 2 * dist * tanHalf, dist, ...opts });
  }
  const stackHeight = () => Math.max(bounds?.height_u ?? 0, topY(), 1);
  const stackRadius = () => bounds?.radius_u ?? 1;
  function frameStack(opts = {}) {
    return frameSpan(0, stackHeight(), stackRadius(), 0.83, opts); // ~85 %, nose clear of the HUD line
  }
  let orbitSign = 1;
  function framePart(part) {
    orbitSign = -orbitSign;
    return frameSpan(part.slotY, part.slotY + part.height, part.radius, 0.6, { orbit: 0.2 * orbitSign });
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
    return frameSpan(focusBox.min.y, focusBox.max.y, r, frac, { shift });
  }
  function unfocus() {
    return state.exploded ? frameExploded() : frameStack();
  }
  let explodedSpan = null; // { top, r } of the current exploded view
  function frameExploded() {
    return explodedSpan ? frameSpan(0, explodedSpan.top, explodedSpan.r, 0.85) : frameStack();
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

  // ---------- x-ray: shell opacity states ----------
  const shellTarget = (part) => (highlighted.has(part) ? SHELL.focus : state.exploded ? SHELL.exploded : SHELL.built);
  function fadeShell(part, v = shellTarget(part), duration = D(420)) {
    part.shellAnim?.cancel();
    if (duration <= 0) {
      part.shell.v = v;
      setShellOpacity(part, v);
      return;
    }
    part.shellAnim = animate(part.shell, { v, duration, ease: "outQuad", onUpdate: () => setShellOpacity(part, part.shell.v) });
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
      fadeShell(part, SHELL.focus);
    } else if (!highlighted.has(part)) return;
    else fadeShell(part, state.exploded ? SHELL.exploded : SHELL.built);
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

  function flyIn(part, sourceWorld, { cap = Infinity } = {}) {
    fadeShell(part, SHELL.built, 0);
    const source = part.group.worldToLocal(sourceWorld.clone());
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 18, 0.6, 2.2);
    const delays = arrivalDelays(part, cap);
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
    flash.fire({ position: new THREE.Vector3(0, part.slotY + 0.02, 0), radius: part.radius * 1.35, color: 0x9fdcff });
    sfx.play("clunk");
    state.shake = 1;
  }

  async function build(part) {
    if (state.busy || state.exploded || !canBuild(part)) return false;
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    hideGhostNow(part);
    changed();
    sfx.play("whoosh");
    framePart(part);
    await flyIn(part, sourcePoint(part));
    if (gen !== state.gen) return false;
    part.built = true;
    part.busy = false;
    state.busy--;
    lock(part);
    if (!state.auto) frameStack(); // Build all keeps following the parts and settles on the stack at the end
    changed();
    return true;
  }

  async function remove(part) {
    if (state.busy || state.exploded || !isTopBuilt(part)) return false;
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    if (highlighted.has(part)) clearHighlight(part);
    changed();
    sfx.play("whoosh", { rate: 0.8 });
    await flyOut(part, sourcePoint(part));
    if (gen !== state.gen) return false;
    part.built = false;
    part.busy = false;
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

  async function explode() {
    if (state.busy || state.exploded || topY() === 0) return false;
    const gen = state.gen;
    state.busy++;
    state.exploded = true;
    changed();
    sfx.play("explode");
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.9;
    const built = parts.filter((p) => p.built);
    for (const part of built) fadeShell(part, highlighted.has(part) ? SHELL.focus : SHELL.exploded, D(700));
    const { lifts, top } = explodeLayout(built);
    const spread = Math.max(0, ...built.flatMap((p) => p.pieces.map((q) => q.explode.dist * Math.hypot(q.explode.dir.x, q.explode.dir.z))));
    explodedSpan = { top, r: stackRadius() + spread };
    frameExploded();
    const jobs = [];
    built.forEach((part, pi) => {
      const lift = lifts.get(part);
      const step = Math.min(24, 700 / Math.max(1, part.arrival.length));
      for (const piece of part.arrival) {
        const rot = new THREE.Quaternion().setFromAxisAngle(Y, piece.turn * 0.35);
        const target = piece.rest.position.clone().addScaledVector(piece.explode.dir, piece.explode.dist).applyQuaternion(rot);
        target.y += piece.axis + lift;
        const q0 = piece.mesh.quaternion.clone();
        const q1 = rot.multiply(piece.rest.quaternion);
        const delay = D(pi * 90 + piece.rank * step);
        const k = { v: 0 };
        jobs.push(
          run(piece.mesh.position, { x: target.x, y: target.y, z: target.z, delay, ease: spring({ stiffness: 85, damping: 11 }) }),
          run(k, { v: 1, duration: D(900), delay, ease: "outCubic", onUpdate: () => piece.mesh.quaternion.slerpQuaternions(q0, q1, k.v) }),
        );
      }
    });
    await Promise.all(jobs);
    if (gen !== state.gen) return false;
    state.busy--;
    changed();
    return true;
  }

  async function assemble() {
    if (state.busy || !state.exploded) return false;
    const gen = state.gen;
    state.busy++;
    changed();
    sfx.play("assemble");
    const built = parts.filter((p) => p.built);
    for (const part of built) fadeShell(part, highlighted.has(part) ? SHELL.focus : SHELL.built, D(700));
    const jobs = [];
    built.forEach((part, pi) => {
      const step = Math.min(18, 500 / Math.max(1, part.arrival.length));
      for (const piece of part.arrival) {
        const delay = D(pi * 70 + piece.rank * step); // bottom-up
        const k = { v: 0 };
        const q0 = piece.mesh.quaternion.clone();
        const r = piece.rest.position;
        jobs.push(
          run(piece.mesh.position, { x: r.x, y: r.y, z: r.z, delay, ease: spring({ stiffness: 130, damping: 12 }) }),
          run(k, { v: 1, duration: D(700), delay, ease: "inOutCubic", onUpdate: () => piece.mesh.quaternion.slerpQuaternions(q0, piece.rest.quaternion, k.v) }),
        );
      }
    });
    await Promise.all(jobs);
    if (gen !== state.gen) return false;
    controls.autoRotate = false;
    state.exploded = false;
    state.busy--;
    sfx.play("clunk", { gain: 0.7 });
    state.shake = 0.6;
    frameStack();
    changed();
    return true;
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
    if (state.busy || state.exploded || !makePart) return false;
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
      await flyIn(p, sourcePoint(p), { cap: T.swapInStaggerMax });
      if (gen !== state.gen) return;
      p.built = true;
      p.busy = false;
      lock(p);
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

  // ---------- build all / build up to / reset ----------
  async function buildUpTo(target) {
    if (state.busy || state.exploded || target.built) return false;
    const gen = state.gen;
    state.auto = true;
    try {
      for (const part of parts.slice(0, index(target) + 1)) {
        if (part.built) continue;
        const ok = await build(part);
        if (!ok || gen !== state.gen) return false;
        if (part !== target) await wait(D(140));
      }
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
    if (state.busy || state.exploded || !parts.length) return;
    const gen = state.gen;
    const ok = await buildUpTo(parts[parts.length - 1]);
    if (!ok || gen !== state.gen) return;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    setTimeout(() => {
      if (gen === state.gen && !state.exploded) controls.autoRotate = false;
    }, 6500);
  }

  // Back to the empty pad (camera untouched).
  function clear() {
    state.gen++;
    cancelAll();
    controls.autoRotate = false;
    state.busy = 0;
    state.exploded = false;
    state.auto = false;
    state.shake = 0;
    for (const part of [...highlighted]) clearHighlight(part);
    for (const part of [...leaving]) retirePart(part); // still flying out of an interrupted swap
    for (const part of parts) {
      part.built = false;
      part.busy = false;
      hideGhostNow(part);
      fadeShell(part, SHELL.built, 0);
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
  const warmTarget = new THREE.WebGLRenderTarget(4, 4);
  function prewarm(renderer) {
    warmRenderer = renderer;
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
    flash.update(dt);
    if (state.shake > 0.002) {
      state.shake *= Math.exp(-dt * 8);
      root.position.set((Math.random() - 0.5) * 0.09 * state.shake, 0, (Math.random() - 0.5) * 0.09 * state.shake);
    } else if (root.position.x !== 0) {
      root.position.set(0, 0, 0);
    }
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
    build,
    buildUpTo,
    remove,
    explode,
    assemble,
    toggleExplode,
    swap,
    applyManifest,
    restack,
    buildAll,
    reset,
    rebuild,
    setBounds,
    prewarm,
    update,
    home,
  };
}
