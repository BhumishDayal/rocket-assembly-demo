// Choreography: anime.js drives every motion (paths, springs, staggers); three.js only draws.
// Build  = hologram pieces fly in from the parts panel with stagger → spring-snap → crystallize sweep
//          (hologram → solid, bottom to top, glowing edge, particle swarm) → lock flash + clunk.
// Remove = the reverse. Explode/Assemble = anime.js-hero style staggered springs on every piece.
import * as THREE from "three";
import { animate, spring, utils } from "animejs";
import { createHologramMaterial } from "./fx/hologram.js";
import { makeRevealable } from "./fx/reveal.js";
import { createSwarm } from "./fx/swarm.js";
import { createBoltFlash } from "./fx/flash.js";
import { COLORS } from "./parts.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const D = (ms) => (reduced ? ms * 0.55 : ms);
const rnd = (a, b) => a + Math.random() * (b - a);
const rnd3 = (r) => new THREE.Vector3(rnd(-r, r), rnd(-r, r), rnd(-r, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

export function createChoreographer({ parts, scene, root, camera, controls, sfx, onChange }) {
  const swarm = createSwarm({ maxCount: 12000 });
  const flash = createBoltFlash();
  scene.add(swarm.object3d, flash.object3d);

  const state = { busy: 0, exploded: false, gen: 0, shake: 0 };
  const live = new Set();

  // anime.js wrapper: returns a promise, remembers the animation so reset() can cancel it.
  function run(targets, params) {
    return new Promise((resolve) => {
      const anim = animate(targets, {
        ...params,
        onComplete: (self) => {
          live.delete(anim);
          params.onComplete?.(self);
          resolve();
        },
      });
      live.add(anim);
    });
  }
  function cancelAll() {
    for (const a of live) a.cancel();
    live.clear();
  }

  // ---------- per-part setup: hologram twins, ghost preview, reveal hooks ----------
  for (const part of parts) {
    part.holoFly = createHologramMaterial({ color: COLORS.holo, opacity: 0.6 });
    part.holoGhost = createHologramMaterial({ color: COLORS.holo, opacity: 0.3 });
    part.ghost = new THREE.Group();
    part.ghost.position.y = part.slotY;
    part.ghost.visible = false;
    part.ghostFade = { v: 0 };
    for (const piece of part.pieces) {
      const g = new THREE.Mesh(piece.mesh.geometry, part.holoGhost.material);
      g.position.copy(piece.rest.position);
      g.quaternion.copy(piece.rest.quaternion);
      part.ghost.add(g);

      piece.holo = new THREE.Mesh(piece.mesh.geometry, part.holoFly.material);
      piece.holo.visible = false;
      piece.holo.renderOrder = 2;
      part.group.add(piece.holo);

      piece.reveal = makeRevealable(piece.mesh, { edgeColor: COLORS.holo, edgeWidth: 0.12 });
      piece.mesh.visible = false;
    }
    root.add(part.group, part.ghost);
  }

  const index = (part) => parts.indexOf(part);
  const canBuild = (part) => !part.built && !part.busy && (index(part) === 0 || parts[index(part) - 1].built);
  const isTopBuilt = (part) => part.built && parts.slice(index(part) + 1).every((p) => !p.built);
  const topY = () => parts.reduce((m, p) => (p.built ? Math.max(m, p.slotY + p.height) : m), 0);

  // Where pieces come from: off-screen left (the parts panel side), a little toward the camera.
  function sourcePoint(part) {
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
    return new THREE.Vector3(0, part.slotY + part.height * 0.5 + 1.2, 0)
      .addScaledVector(right, -9)
      .addScaledVector(fwd, -2.5);
  }

  // ---------- camera ----------
  const camDir = new THREE.Vector3();
  function frameTo({ ty, dist, duration = D(1100), ease = "inOutCubic" }) {
    camDir.copy(camera.position).sub(controls.target).normalize();
    const cur = { ty: controls.target.y, d: camera.position.distanceTo(controls.target) };
    return run(cur, {
      ty,
      d: dist,
      duration,
      ease,
      onUpdate: () => {
        controls.target.set(0, cur.ty, 0);
        camDir.copy(camera.position).sub(controls.target).normalize();
        camera.position.copy(controls.target).addScaledVector(camDir, cur.d);
      },
    });
  }
  // Frames the built stack, plus `includeTop` (the part on its way in, or the exploded spread).
  function reframe(extra = 1, includeTop = 0) {
    const top = Math.max(topY(), includeTop, 3.5);
    return frameTo({ ty: Math.max(2.4, top * 0.5), dist: Math.max(15, top * 1.42 + 5) * extra });
  }
  function home() {
    return frameTo({ ty: 2.5, dist: 18.5, duration: D(900) });
  }

  // ---------- ghost preview on hover ----------
  function setGhost(part, on) {
    if (on && (!canBuild(part) || state.busy || state.exploded)) return;
    utils.remove(part.ghostFade);
    if (on) part.ghost.visible = true;
    run(part.ghostFade, {
      v: on ? 1 : 0,
      duration: D(on ? 220 : 160),
      ease: "outQuad",
      onUpdate: () => part.holoGhost.setOpacity(part.ghostFade.v),
      onComplete: () => {
        if (!on) part.ghost.visible = false;
      },
    });
  }
  function hideGhostNow(part) {
    utils.remove(part.ghostFade);
    part.ghostFade.v = 0;
    part.holoGhost.setOpacity(0);
    part.ghost.visible = false;
  }

  // ---------- build ----------
  function flyIn(part, sourceWorld) {
    const source = part.group.worldToLocal(sourceWorld.clone());
    const n = part.pieces.length;
    const stag = n > 8 ? 42 : 75;
    return Promise.all(
      part.pieces.map((piece, i) => {
        const end = piece.rest.position;
        const start = source.clone().add(rnd3(1.3));
        const mid = start
          .clone()
          .lerp(end, 0.45)
          .add(new THREE.Vector3(rnd(-1, 1), rnd(2, 3.6), rnd(-1, 1)));
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const over = curve.getTangent(1).normalize().multiplyScalar(0.16); // tiny overshoot, spring brings it back
        const spinAxis = rnd3(1).normalize();
        const spinAngle = (Math.random() < 0.5 ? -1 : 1) * rnd(1.4, 3.2);
        const holo = piece.holo;
        holo.position.copy(start);
        holo.visible = true;
        const prog = { t: 0 };
        return run(prog, {
          t: 1,
          duration: D(640),
          delay: D(i * stag),
          ease: "outQuart",
          onUpdate: () => {
            curve.getPoint(prog.t, holo.position).addScaledVector(over, prog.t);
            holo.quaternion.copy(piece.rest.quaternion).premultiply(tmpQ.setFromAxisAngle(spinAxis, (1 - prog.t) * spinAngle));
          },
          onComplete: () => sfx.play("tick", { rate: rnd(0.9, 1.12) }),
        }).then(() =>
          run(holo.position, { x: end.x, y: end.y, z: end.z, ease: spring({ stiffness: 260, damping: 13 }) }),
        );
      }),
    );
  }

  async function crystallize(part, sourceWorld, { reverse = false } = {}) {
    const H = part.height;
    const h = { v: reverse ? H + 0.3 : -0.25 };
    for (const piece of part.pieces) {
      piece.mesh.visible = true;
      piece.reveal.setActive(true);
      piece.reveal.setCut(h.v - piece.mesh.position.y);
      if (reverse) {
        piece.holo.position.copy(piece.rest.position);
        piece.holo.quaternion.copy(piece.rest.quaternion);
        piece.holo.visible = true;
      }
    }
    let dur = D(470 + H * 42);
    if (!reverse) {
      // Particles pour in first; the sweep runs exactly over the window in which they land (swarm.timing).
      swarm.play({ source: sourceWorld, targets: part.pieces.map((p) => p.mesh), duration: (dur + 380) / 1000, color: COLORS.holo });
      const { firstLanding = 0, lastLanding = dur / 1000 } = swarm.timing ?? {};
      await wait(firstLanding * 1000);
      dur = Math.max(220, (lastLanding - firstLanding) * 1000);
    }
    sfx.play("shimmer", { rate: reverse ? 0.85 : 1 });
    await run(h, {
      v: reverse ? -0.25 : H + 0.3,
      duration: dur,
      ease: "inOutSine",
      onUpdate: () => {
        for (const piece of part.pieces) piece.reveal.setCut(h.v - piece.mesh.position.y);
        part.holoFly.setOpacity(1 - THREE.MathUtils.clamp(h.v / H, 0, 1));
      },
    });
    for (const piece of part.pieces) {
      piece.reveal.setActive(false);
      if (reverse) piece.mesh.visible = false;
      else piece.holo.visible = false;
    }
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
    onChange();
    sfx.play("whoosh");
    reframe(1, part.slotY + part.height);
    const source = sourcePoint(part);
    part.holoFly.setOpacity(1);
    await flyIn(part, source);
    if (gen !== state.gen) return false;
    await crystallize(part, source);
    if (gen !== state.gen) return false;
    part.built = true;
    part.busy = false;
    state.busy--;
    lock(part);
    reframe();
    onChange();
    return true;
  }

  // ---------- remove (reverse) ----------
  function flyOut(part, sourceWorld) {
    const source = part.group.worldToLocal(sourceWorld.clone());
    const n = part.pieces.length;
    const stag = n > 8 ? 30 : 55;
    return Promise.all(
      [...part.pieces].reverse().map((piece, i) => {
        const start = piece.rest.position.clone();
        const end = source.clone().add(rnd3(1.5));
        const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(rnd(-1, 1), rnd(1.5, 3), rnd(-1, 1)));
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const spinAxis = rnd3(1).normalize();
        const spinAngle = (Math.random() < 0.5 ? -1 : 1) * rnd(1, 2.5);
        const holo = piece.holo;
        const prog = { t: 0 };
        return run(prog, {
          t: 1,
          duration: D(560),
          delay: D(i * stag),
          ease: "inQuart",
          onUpdate: () => {
            curve.getPoint(prog.t, holo.position);
            holo.quaternion.copy(piece.rest.quaternion).premultiply(tmpQ.setFromAxisAngle(spinAxis, prog.t * spinAngle));
          },
          onComplete: () => {
            holo.visible = false;
          },
        });
      }),
    );
  }

  async function remove(part) {
    if (state.busy || state.exploded || !isTopBuilt(part)) return false;
    const gen = state.gen;
    state.busy++;
    part.busy = true;
    onChange();
    const source = sourcePoint(part);
    part.holoFly.setOpacity(0);
    await crystallize(part, source, { reverse: true });
    if (gen !== state.gen) return false;
    part.built = false;
    sfx.play("whoosh", { rate: 0.8 });
    await flyOut(part, source);
    if (gen !== state.gen) return false;
    part.busy = false;
    state.busy--;
    reframe();
    onChange();
    return true;
  }

  // ---------- explode / assemble ----------
  async function explode() {
    if (state.busy || state.exploded || topY() === 0) return false;
    const gen = state.gen;
    state.busy++;
    state.exploded = true;
    onChange();
    sfx.play("explode");
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.9;
    const built = parts.filter((p) => p.built);
    reframe(1.2, topY() + built.length * 0.85 + 1.5);
    const jobs = [];
    built.forEach((part, pi) => {
      part.pieces.forEach((piece, i) => {
        const target = piece.rest.position
          .clone()
          .addScaledVector(piece.explode.dir, piece.explode.dist * 1.15)
          .add(tmpV.set(0, 0.35 + pi * 0.85, 0));
        piece.q0 = piece.mesh.quaternion.clone();
        piece.q1 = new THREE.Quaternion().setFromAxisAngle(rnd3(1).normalize(), rnd(0.12, 0.45)).multiply(piece.rest.quaternion);
        const delay = D(pi * 90 + i * 24);
        const k = { v: 0 };
        jobs.push(
          run(piece.mesh.position, { x: target.x, y: target.y, z: target.z, delay, ease: spring({ stiffness: 85, damping: 11 }) }),
          run(k, { v: 1, duration: D(900), delay, ease: "outCubic", onUpdate: () => piece.mesh.quaternion.slerpQuaternions(piece.q0, piece.q1, k.v) }),
        );
      });
    });
    await Promise.all(jobs);
    if (gen !== state.gen) return false;
    state.busy--;
    onChange();
    return true;
  }

  async function assemble() {
    if (state.busy || !state.exploded) return false;
    const gen = state.gen;
    state.busy++;
    onChange();
    sfx.play("assemble");
    const built = parts.filter((p) => p.built);
    const jobs = [];
    const count = built.length;
    built.forEach((part, pi) => {
      part.pieces.forEach((piece, i) => {
        const delay = D((count - 1 - pi) * 70 + i * 18);
        const k = { v: 0 };
        piece.q0 = piece.mesh.quaternion.clone();
        const r = piece.rest.position;
        jobs.push(
          run(piece.mesh.position, { x: r.x, y: r.y, z: r.z, delay, ease: spring({ stiffness: 130, damping: 12 }) }),
          run(k, { v: 1, duration: D(700), delay, ease: "inOutCubic", onUpdate: () => piece.mesh.quaternion.slerpQuaternions(piece.q0, piece.rest.quaternion, k.v) }),
        );
      });
    });
    await Promise.all(jobs);
    if (gen !== state.gen) return false;
    controls.autoRotate = false;
    state.exploded = false;
    state.busy--;
    sfx.play("clunk", { gain: 0.7 });
    state.shake = 0.6;
    reframe();
    onChange();
    return true;
  }

  const toggleExplode = () => (state.exploded ? assemble() : explode());

  // ---------- build all / reset ----------
  async function buildAll() {
    if (state.busy || state.exploded) return;
    const gen = state.gen;
    for (const part of parts) {
      if (part.built) continue;
      const ok = await build(part);
      if (!ok || gen !== state.gen) return;
      await wait(D(160));
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    setTimeout(() => {
      if (gen === state.gen && !state.exploded) controls.autoRotate = false;
    }, 6500);
  }

  function reset() {
    state.gen++;
    cancelAll();
    swarm.stop();
    controls.autoRotate = false;
    state.busy = 0;
    state.exploded = false;
    state.shake = 0;
    for (const part of parts) {
      part.built = false;
      part.busy = false;
      hideGhostNow(part);
      part.holoFly.setOpacity(1);
      for (const piece of part.pieces) {
        piece.reveal.setActive(false);
        piece.mesh.visible = false;
        piece.holo.visible = false;
        piece.mesh.position.copy(piece.rest.position);
        piece.mesh.quaternion.copy(piece.rest.quaternion);
      }
    }
    home();
    onChange();
  }

  // One-time shader warm-up so the first build has no compile hitch.
  function prewarm(renderer) {
    for (const part of parts) {
      part.ghost.visible = true;
      for (const piece of part.pieces) {
        piece.mesh.visible = true;
        piece.holo.visible = true;
        piece.reveal.setActive(true);
      }
    }
    renderer.compile(scene, camera);
    for (const part of parts) {
      part.ghost.visible = false;
      for (const piece of part.pieces) {
        piece.reveal.setActive(false);
        piece.mesh.visible = false;
        piece.holo.visible = false;
      }
    }
  }

  function update(dt, t) {
    for (const part of parts) {
      part.holoFly.update(t);
      part.holoGhost.update(t);
      if (part.ghost.visible) part.ghost.position.y = part.slotY + Math.sin(t * 2.6) * 0.05;
    }
    swarm.update(dt);
    flash.update(dt);
    if (state.shake > 0.002) {
      state.shake *= Math.exp(-dt * 8);
      root.position.set((Math.random() - 0.5) * 0.09 * state.shake, 0, (Math.random() - 0.5) * 0.09 * state.shake);
    } else if (root.position.x !== 0) {
      root.position.set(0, 0, 0);
    }
  }

  return { state, canBuild, isTopBuilt, topY, setGhost, build, remove, explode, assemble, toggleExplode, buildAll, reset, prewarm, update, home };
}
