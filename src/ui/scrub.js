// Scrub the exploded view like the anime.js lens (design E17): a vertical drag that starts on empty space, or the
// wheel / two-finger scroll, moves the exploded progress continuously; letting go snaps past 0.5 (choreo).
//   createScrub({ canvas, controls, isEmpty(x, y), start() -> bool, by(deltaProgress), end() }) -> { dispose() }
// - Drag: decided after 6 px. Mostly vertical (|dy| > 1.3·|dx|) scrubs, up = apart; anything else stays an orbit.
//   While scrubbing, OrbitControls is disabled so the drag does not also rotate (its pointerup still runs).
//   A full scrub is ~55 % of the canvas height.
// - Wheel / two-finger scroll over the canvas: scroll down = apart; ends 180 ms after the last event. Ctrl+wheel
//   (trackpad pinch) stays a zoom. When start() refuses (nothing built, a build running), the wheel zooms as usual.
export function createScrub({ canvas, controls, isEmpty, start, by, end }) {
  const height = () => Math.max(1, canvas.getBoundingClientRect().height);
  let drag = null; // { id, x, y, last, active }

  function onDown(e) {
    if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (!isEmpty(e.clientX, e.clientY)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, last: e.clientY, active: false };
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) < 6) return;
      if (Math.abs(dy) < Math.abs(dx) * 1.3 || !start()) {
        drag = null; // an orbit after all
        return;
      }
      drag.active = true;
      drag.last = e.clientY;
      controls.enabled = false;
      return;
    }
    by((drag.last - e.clientY) / (height() * 0.55));
    drag.last = e.clientY;
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag.active;
    drag = null;
    if (!was) return;
    controls.enabled = true;
    end();
  }

  let wheelTimer = 0;
  let wheeling = false;
  function onWheel(e) {
    if (e.target !== canvas || e.ctrlKey) return;
    if (!wheeling) {
      if (!start()) return;
      wheeling = true;
    }
    e.preventDefault();
    e.stopPropagation(); // capture phase: OrbitControls never sees it, so it does not zoom
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height() : 1);
    by(px / (height() * 1.2));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheeling = false;
      end();
    }, 180);
  }

  canvas.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onUp);
  addEventListener("wheel", onWheel, { capture: true, passive: false });

  return {
    dispose() {
      canvas.removeEventListener("pointerdown", onDown);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointercancel", onUp);
      removeEventListener("wheel", onWheel, { capture: true });
      clearTimeout(wheelTimer);
    },
  };
}
