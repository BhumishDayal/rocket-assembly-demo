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
// X-ray    = shell opacity states via parts.setShellOpacity (design round 10): built 0.55, exploded 0.30,
//            selected part 0.15 while the others keep theirs, 0.55 from the first frame of a fly-in.
import * as THREE from "three";
import { animate, spring } from "animejs";
import { createHologramMaterial } from "./fx/hologram.js";
import { createBoltFlash } from "./fx/flash.js";
import { COLORS, LOOK, setShellOpacity as setShell } from "./parts.js";
import { attachPlumes, createPadLight, P0 } from "./plume.js";

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

  const state = { busy: 0, exploded: false, scrubbing: false, auto: false, launch: null, gen: 0, shake: 0 };
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
  // pitch: target elevation (radians) or null to keep the current one.
  function frameTo({ ty, dist, orbit = 0, pitch = null, duration = D(1100), ease = "inOutCubic" }) {
    const cur = { ty: controls.target.y, d: camera.position.distanceTo(controls.target), az: 0, el: elevation() };
    let az = 0;
    camAnim?.cancel();
    live.delete(camAnim);
    const p = run(cur, {
      ty,
      d: dist,
      az: orbit,
      el: pitch ?? cur.el,
      duration,
      ease,
      onUpdate: () => {
        controls.target.set(0, cur.ty, 0);
        camDir.copy(camera.position).sub(controls.target).normalize();
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
  function fitDist(h, r, frac) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camDir.copy(camera.position).sub(controls.target).normalize();
    const pitch = Math.abs(Math.asin(THREE.MathUtils.clamp(camDir.y, -1, 1)));
    const dv = (h * Math.cos(pitch) + 2 * r * Math.sin(pitch)) / (2 * tanHalf * frac);
    const dh = (2 * r) / (2 * tanHalf * camera.aspect * frac);
    return Math.max(dv, dh) + r;
  }
  // The centre sits `shift` of the view (default 2 %) below the span's middle, so the base clears the bar.
  // What the camera frames now (main's fog band): its radius and mode ("stack" | "part" | "focus" | "exploded").
  let framedR = initialBounds?.radius_u ?? 1;
  let framedMode = "stack";
  function spanFraming(y0, y1, r, frac, shift = 0.02) {
    const dist = Math.max(controls.minDistance, fitDist(Math.max(y1 - y0, 0.05), r, frac));
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
    part.shellAnim = animate(part.shell, {
      v,
      duration,
      ease: "outQuad",
      onUpdate: () => {
        setShellOpacity(part, part.shell.v);
        if (part.dim && part.dim.v !== 1) applyLines(part);
      },
    });
  }

  // Edge lines: while a part is selected, the OTHER parts' lines dim to 0.3 (from 0.55) so the focused part
  // pops. A line's opacity = its built base (UI4: line.userData.base) × dim × (shell lines follow the shell).
  const LINE_DIM = 0.3 / SHELL.built;
  function applyLines(part) {
    if (LOOK !== "xray") return;
    const dim = part.dim?.v ?? 1;
    const shellK = (part.shell?.v ?? SHELL.built) / SHELL.built;
    part.group.traverse((o) => {
      if (!o.isLine || !o.material) return;
      o.userData.base ??= o.material.opacity;
      const k = o.parent?.userData?.kind === "shell" ? shellK : 1;
      o.material.opacity = Math.min(1, o.userData.base * dim * k);
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
      fadeShell(part, SHELL.focus);
      fadeDim(part, 1);
      for (const p of parts) if (p !== part) fadeDim(p, LINE_DIM);
    } else if (!highlighted.has(part)) return;
    else {
      fadeShell(part, state.exploded ? SHELL.exploded : SHELL.built);
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
    fadeShell(part, SHELL.built, 0);
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
      if (!highlighted.has(part)) {
        part.shellAnim?.cancel();
        part.shell.v = SHELL.built + (SHELL.exploded - SHELL.built) * vc;
        setShellOpacity(part, part.shell.v);
        if (part.dim && part.dim.v !== 1) applyLines(part);
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
  async function settleExplode(to) {
    const gen = state.gen;
    xAnim?.cancel();
    live.delete(xAnim);
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
    xAnim = null;
    xs.v = to;
    applyExplode();
    state.busy--;
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

  // [sim t, real t] keyframes at every event: real time up to 6 s after liftoff, log-compressed gaps after.
  function playbackKeys(events, tEnd) {
    const lift = events.find((e) => e.type === "liftoff")?.t ?? 0;
    const ts = [...new Set([0, lift + 6, ...events.map((e) => e.t), tEnd])].filter((t) => t >= 0 && t <= tEnd).sort((a, b) => a - b);
    const keys = [[0, 0]];
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      const real = ts[i] <= lift + 6 ? gap : Math.min(gap, 1 + 1.3 * Math.log2(1 + gap / 6));
      keys.push([ts[i], keys[keys.length - 1][1] + real]);
    }
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
      L.padLight = createPadLight({ baseRadius_u: bounds?.baseRadius_u ?? 1, bellExitRadius_u: Math.max(...plumes.map((p) => p.exitRadius_u ?? 0.1)) });
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
    L.labelUntil = L.real + 2.5;
    switch (e.type) {
      case "ignition":
        ignite(0, e.t);
        sfx.play("whoosh", { rate: 0.5, gain: 1.2 });
        break;
      case "liftoff":
        sfx.play("clunk"); // hold-down release
        state.shake = 1;
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
    if (inOrbit) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.35;
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
          for (const part of parts) if (!L?.gone.has(part)) setShellOpacity(part, SHELL.built * fade.v);
        },
        onComplete: () => {
          if (L) L.flight.visible = false;
        },
      });
    }
    state.busy--;
    state.launch = "done";
    L.onTelemetry({ final: true, outcome: summary.outcome, inOrbit, summary, alt_m: s.alt_m });
    changed();
    L.resolve?.(summary.outcome);
  }

  // launch(sim, { pad, onTelemetry }) -> Promise<outcome>. The stack must be complete and assembled.
  function launch(sim, { pad = null, onTelemetry = () => {} } = {}) {
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
      real: -COUNTDOWN_S,
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
    };
    controls.autoRotate = false;
    frameSpan(0, H + L.riseMax, stackRadius(), 0.85, { pitch: HERO_PITCH, mode: "stack" });
    changed();
    return new Promise((resolve) => (L.resolve = resolve));
  }

  // Undo a launch (reset / preset switch): plumes and pad light gone, parts back on the pad.
  function endLaunch() {
    if (!L) return;
    for (const pl of L.plumes) pl.plume.dispose();
    L.padLight?.dispose();
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
  async function buildUpTo(target) {
    if (state.busy || state.exploded || target.built) return false;
    const gen = state.gen;
    state.auto = true;
    const running = [];
    try {
      for (const part of parts.slice(0, index(target) + 1)) {
        if (part.built) continue;
        let seated;
        const seatedP = new Promise((r) => (seated = r));
        const done = buildPart(part, { onSeated: seated });
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
    endLaunch();
    state.gen++;
    cancelAll();
    controls.autoRotate = false;
    state.busy = 0;
    state.exploded = false;
    state.scrubbing = false;
    state.auto = false;
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
    if (L) launchUpdate(dt);
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
    launch,
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
