// Click-to-select on the 3D stack, without stealing orbit drags.
//   createSelector({ canvas, camera, parts, onSelect(part|null), onGhostClick(part), onHover?(hit|null), resolve?(part) })
//   resolve maps a clicked part to the part to select (main: the closed fairing selects the payload inside).
//     -> { setParts(parts), select(part), clear(), refresh(), get selected(), dispose() }
// - A click is a pointerup less than 5 px from its pointerdown (same pointer, no second finger in between),
//   so orbiting never selects.
// - Targets: visible meshes of built parts, plus the ghost of the next buildable part (choreo sets
//   part.ghostActive). The ghost is hit-tested as its world bounding box padded by ~20 px at the current zoom,
//   so a thin 3.66 m tank is still easy to click; a ghost hit wins over a solid hit (the ghost draws on top).
// - Hit -> part: mesh.userData.partId, else walk up the parents to the part's group / ghost group.
//   Shells (mesh.userData.kind "shell") are see-through: a click goes to the first solid piece behind them.
// - Hover raycasts are coalesced to one per animation frame and at most every 40 ms; they set the pointer
//   cursor and report { part, ghost } through onHover (used for the ghost hover opacity).
// - Esc and a click on empty space deselect (onSelect(null)).
import * as THREE from "three";

const CLICK_PX = 5;
const HOVER_MS = 40;

export function createSelector({ canvas, camera, parts, onSelect, onGhostClick, onHover, resolve = (p) => p }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let list = parts;
  let owners = new Map(); // Object3D (part group / ghost group) -> part
  let selected = null;
  let down = null; // { id, x, y }
  let hover = null; // { part, ghost }
  let hoverPending = false;
  let lastHover = 0;
  let lastMove = null;

  function setParts(next) {
    list = next;
    owners = new Map();
    for (const p of list) {
      owners.set(p.group, p);
      if (p.ghost) owners.set(p.ghost, p);
    }
    selected = null;
    setHover(null);
  }
  setParts(parts);

  const byId = (id) => list.find((p) => p.id === id);
  function partOf(obj) {
    for (let o = obj; o; o = o.parent) {
      if (o.userData?.partId) return byId(o.userData.partId);
      const p = owners.get(o);
      if (p) return p;
    }
    return null;
  }

  function solids() {
    const out = [];
    for (const p of list) {
      if (!p.built) continue;
      for (const piece of p.pieces) if (piece.mesh.visible) out.push(piece.mesh);
    }
    return out;
  }

  const box = new THREE.Box3();
  const boxHit = new THREE.Vector3();
  function ghostHit() {
    const p = list.find((q) => q.ghostActive && q.ghost?.visible);
    if (!p) return null;
    box.setFromObject(p.ghost);
    const r = canvas.getBoundingClientRect();
    const d = camera.position.distanceTo(box.getCenter(boxHit));
    const pxWorld = (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, r.height);
    box.expandByScalar(20 * pxWorld);
    return raycaster.ray.intersectBox(box, boxHit) ? p : null;
  }

  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const ghost = ghostHit();
    if (ghost) return { part: ghost, ghost: true };
    const hits = raycaster.intersectObjects(solids(), false);
    const part = hits.length ? resolve(xray(hits)) : null;
    return part ? { part, ghost: false } : null;
  }

  // X-ray click-through: shells are see-through, so a click lands on what is seen through them. When the
  // first hit is a shell, the first solid piece behind it decides: another part (engines inside an
  // interstage, a payload inside a fairing) wins; the shell's own interior keeps the shell's part.
  function xray(hits) {
    const first = partOf(hits[0].object);
    if (hits[0].object.userData.kind !== "shell") return first;
    const inner = hits.find((h) => h.object.userData.kind !== "shell");
    return (inner && partOf(inner.object)) || first;
  }

  function setHover(h) {
    const same = h?.part === hover?.part && h?.ghost === hover?.ghost;
    if (same) return;
    hover = h;
    canvas.style.cursor = h ? "pointer" : "";
    onHover?.(h);
  }

  function hoverNow() {
    hoverPending = false;
    if (!lastMove || down) return;
    lastHover = performance.now();
    setHover(pick(lastMove.x, lastMove.y));
  }

  function onPointerMove(e) {
    if (e.pointerType === "touch") return; // no hover on touch
    lastMove = { x: e.clientX, y: e.clientY };
    if (down) return;
    if (hoverPending) return;
    hoverPending = true;
    const wait = Math.max(0, HOVER_MS - (performance.now() - lastHover));
    setTimeout(() => requestAnimationFrame(hoverNow), wait);
  }

  function onPointerDown(e) {
    if (down && down.id !== e.pointerId && e.pointerType === "touch") {
      down = null; // second finger: pinch/orbit, not a click
      return;
    }
    if (e.button !== 0) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e) {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_PX) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit?.ghost) {
      onGhostClick?.(hit.part);
      return;
    }
    select(hit?.part ?? null);
    if (e.pointerType !== "touch") {
      lastMove = { x: e.clientX, y: e.clientY };
      hoverNow();
    }
  }

  function onPointerCancel() {
    down = null;
  }

  function onPointerLeave() {
    lastMove = null;
    setHover(null);
  }

  function onKey(e) {
    if (e.key === "Escape" && selected) select(null);
  }

  function select(part) {
    if (part === selected) return;
    selected = part;
    onSelect?.(part);
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  addEventListener("keydown", onKey);

  return {
    setParts,
    select,
    clear: () => select(null),
    get selected() {
      return selected;
    },
    // Re-run the hover test after the scene changed under a still pointer (a part landed, the ghost moved on).
    refresh() {
      if (lastMove && !down) hoverNow();
    },
    dispose() {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      removeEventListener("keydown", onKey);
    },
  };
}
