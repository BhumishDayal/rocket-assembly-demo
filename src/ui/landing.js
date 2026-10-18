// Scroll-driven landing page (design rounds 14 A and 15 (1)). One progress value p, 0 = the landing shot of the
// Earth under the title, 1 = the builder's home shot, drives one continuous dive: the camera swings up over the
// pole, the globe grows under it (its radius is scaled up exponentially, so the horizon flattens into ground)
// while the terminator sweeps up to the pole (the pad is a dusk/night scene), the camera crosses the atmosphere (the
// sky above the horizon turns to a deep blue haze, a soft glow over the frame) and UI4's cloud layer, the
// ground map resolves, the pad comes into frame, and the shot settles at home.
// Input: wheel / trackpad scroll and touch or mouse drags move the target progress (about 1.2 viewport heights
// for the whole dive); a click, tap or key jumps it to 1 over ~5.5 s (the cinematic swipe). The shown progress
// follows on a critically damped spring. Below 0.98 the landing UI shows (title fades over the first 30 %);
// past it the builder's UI fades in, and once the spring settles at 1 the builder takes over (controls on).
// From the builder (nothing built, at rest), resume() comes back to the landing at p = 1, ending at the
// camera's current pose, and scrolling up continues the dive in reverse.
//   createLanding({ scene, camera, controls, root, stars, canvas, groundY(), groundMap(), endPose(), view, onState })
//     -> { on, p, fogOpen, update(dt, t), enter(), resume(), feed(px), wheelPx(e), dispose() }
//   view: choreo.landingView { up, back, aim, az, sun }; endPose() -> { position, target } (choreo.homePose)
//   onState(on): called when the landing takes over (true) or hands over to the builder (false).
import * as THREE from "three";
import { createPlanet } from "../planet.js";
import { createCloudLayer } from "../fx/launchfx.js";

const R0 = 40; // the globe's radius in the landing shot
const SPAN_VH = 1.2; // viewport heights of scrolling for the whole dive
const JUMP_S = 5.5; // a click / key: the whole dive in this long
const SPRING_W = 6.5; // rad/s, critically damped
const SKY = new THREE.Color(0x1d2f4d); // the atmosphere's haze (background and fog)
// The sun at dusk over the pole (elevation ~0.08): the ground under the pad goes dark and warm. Not full night:
// planet.js's city lights are cells on the unit sphere, so on the zoomed globe they would be metres-wide tiles.
const DUSK_SUN = new THREE.Vector3(-0.85, 0.07, -0.2).normalize();
// Cape Canaveral under the pad. The photoreal maps are equirectangular on three's sphere UVs (u = (lon + 180) /
// 360), so the globe is turned once: the site's up to +Y, its east to +X, its south to +Z (UI 2's site frame;
// UI4's ground map draws the coast 3 km east of the pad).
const SITE = { lat: 28.5, lon: -80.6 };
function siteQuaternion() {
  const phi = ((SITE.lon + 180) / 360) * Math.PI * 2;
  const lat = THREE.MathUtils.degToRad(SITE.lat);
  const up = new THREE.Vector3(-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat));
  const east = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
  const south = new THREE.Vector3().crossVectors(east, up);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south)).invert();
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// Monotone cubic through (xs, ys), flat at both ends: smooth, no overshoot, no stop at the inner keys.
function monotone(xs, ys) {
  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = ys.map((_, i) => (i === 0 || i === n - 1 || d[i - 1] * d[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / d[i - 1] + (h[i] + 2 * h[i - 1]) / d[i])));
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export function createLanding({ scene, camera, controls, root, stars, canvas, groundY = () => -0.6, groundMap = () => null, endPose, view, onState = () => {} }) {
  let G = groundY(); // the ground under the pad (the pole sits just below it); read again on every take-over
  const bg0 = scene.background.clone();
  const fog0 = scene.fog.color.clone();
  const starOpacity = stars?.material.opacity ?? 0.8;

  const planet = createPlanet({ kind: "earth", radius_u: R0 }); // UI4's photoreal Earth
  planet.setSunDir?.(view.sun);
  planet.object3d.quaternion.copy(siteQuaternion());
  scene.add(planet.object3d);
  const graticule = planet.object3d.getObjectByName("planet-graticule"); // line-art mode only
  // Close to the ground, sunlight and the limb haze (photoreal; the peach rim in line-art) would paint the grazing
  // ground toward the horizon a bright band; they fade out on the way down (uniforms only), and so does the
  // scattering shell's sky glow, leaving dark ground that hands over to the builder's dark pad unseen.
  const bodyU = planet.object3d.getObjectByName("planet-body")?.material.uniforms ?? {};
  const atmoU = planet.object3d.getObjectByName("planet-atmosphere")?.material.uniforms ?? {};
  const fades = [bodyU.uSunColor, bodyU.uRim, bodyU.uHaze, atmoU.uGain].filter(Boolean).map((u) => ({ u, v0: u.value.clone?.() ?? u.value }));
  const sun = new THREE.Vector3();
  const clouds = createCloudLayer({ altitude_u: G + 22, radius_u: 70 }); // the camera passes it near p 0.45
  scene.add(clouds.object3d);
  clouds.object3d.traverse((o) => (o.frustumCulled = false)); // one draw; out of the opening shot's frustum otherwise
  // Drawn at a trace for the first frames so its shader compiles at load, not mid-dive (a ~250 ms freeze).
  let warmFrames = 3;
  const cloudsAt = (q) => Math.max(smooth(0.33, 0.4, q) * (1 - smooth(0.52, 0.62, q)), warmFrames > 0 ? 0.003 : 0);
  // The atmosphere's glow over the whole frame while the camera is inside it (brighter toward the horizon).
  const glow = document.createElement("div");
  glow.className = "landing-glow";
  canvas.after(glow);

  const el = document.createElement("div");
  el.className = "landing landing-page"; // styled as .landing-page only: body.landing is the page state
  el.innerHTML = `<h1>Rocket Assembly</h1><button type="button" class="landing-go">Build a rocket</button>`;
  document.body.appendChild(el);
  el.querySelector(".landing-go").addEventListener("click", () => enter());

  let on = false;
  let p = 0; // shown progress
  let v = 0; // its velocity
  let pt = 0; // target progress
  let jump = null; // { from, t, dur }
  let path = null;
  let quietUntil = 0; // swallow trailing wheel inertia right after handing over

  // The camera path for one dive, from the landing shot to `end` (orbit target T, elevation, distance,
  // azimuth per key; the globe's log radius on its own keys).
  function makePath(end) {
    const c0 = new THREE.Vector3(0, G - 0.05 - R0, 0);
    const cam0 = new THREE.Vector3(0, view.up * R0, view.back * R0).applyAxisAngle(new THREE.Vector3(0, 1, 0), view.az).add(c0);
    const T0 = c0.clone().add(new THREE.Vector3(0, view.aim * R0, 0));
    const d0 = cam0.distanceTo(T0);
    const el0 = Math.asin((cam0.y - T0.y) / d0);
    const Te = end.target.clone();
    const off = end.position.clone().sub(Te);
    const dE = off.length();
    const elE = Math.asin(THREE.MathUtils.clamp(off.y / dE, -1, 1));
    let azE = Math.atan2(off.x, off.z);
    while (azE - view.az > Math.PI) azE -= 2 * Math.PI;
    while (azE - view.az < -Math.PI) azE += 2 * Math.PI;
    const deg = THREE.MathUtils.degToRad;
    const keys = [0, 0.3, 0.55, 0.8, 1];
    return {
      end: { position: end.position.clone(), target: end.target.clone() },
      Te,
      ty: monotone(keys, [T0.y, G, G, G + 0.5 * (Te.y - G), Te.y]),
      el: monotone(keys, [el0, deg(34), deg(18), elE + deg(3), elE]), // the horizon stays in frame from p 0.35
      dist: monotone(keys, [Math.log(d0), Math.log(Math.max(0.95 * d0, 2 * dE)), Math.log(Math.max(36, 1.5 * dE)), Math.log(1.25 * dE), Math.log(dE)]),
      az: monotone(keys, [view.az, view.az + 0.2 * (azE - view.az), view.az + 0.5 * (azE - view.az), view.az + 0.85 * (azE - view.az), azE]),
      logR: monotone([0, 0.12, 0.3, 0.55, 0.8, 1], [Math.log(R0), Math.log(R0), Math.log(160), Math.log(8000), Math.log(60000), Math.log(60000)]),
    };
  }

  const T = new THREE.Vector3();
  function apply() {
    // Camera on the path.
    const w = smooth(0.6, 1, p);
    T.set(path.Te.x * w, path.ty(p), path.Te.z * w);
    const e = path.el(p);
    const d = Math.exp(path.dist(p));
    const a = path.az(p);
    controls.target.copy(T);
    camera.position.set(T.x + d * Math.cos(e) * Math.sin(a), T.y + d * Math.sin(e), T.z + d * Math.cos(e) * Math.cos(a));
    camera.lookAt(T);
    // The globe: pole just under the ground, radius growing as the camera comes down.
    const R = Math.exp(path.logR(p));
    planet.object3d.visible = p < 0.86;
    planet.setScale(R / R0); // the shader lengths (scattering, relief) follow
    planet.object3d.position.set(0, G - 0.05 - R, 0);
    planet.setSunDir(sun.copy(view.sun).lerp(DUSK_SUN, smooth(0.22, 0.42, p)).normalize()); // dusk sweeps over the pole
    const k = 1 - smooth(0.3, 0.55, p); // dark before the pad shows (p 0.45)
    for (const { u, v0 } of fades) u.value = typeof v0 === "number" ? v0 * k : u.value.copy(v0).multiplyScalar(k);
    // Sky: space → the atmosphere's haze (from its shell, crossed near p 0.42) → the night pad under the clouds.
    const haze = smooth(0.34, 0.45, p) * (1 - smooth(0.7, 0.92, p));
    scene.background.copy(bg0).lerp(SKY, haze);
    scene.fog.color.copy(fog0).lerp(SKY, haze);
    if (stars) stars.material.opacity = starOpacity * (1 - 0.85 * haze);
    glow.style.opacity = String(0.3 * smooth(0.34, 0.45, p) * (1 - smooth(0.6, 0.85, p)));
    clouds.update(0, { intensity: cloudsAt(p) });
    const gm = groundMap();
    const lines = gm?.object3d.getObjectByProperty("isLineSegments", true);
    if (lines) {
      lines.material.userData.base ??= lines.material.opacity;
      lines.material.opacity = lines.material.userData.base * smooth(0.42, 0.62, p);
    }
    root.visible = p > 0.45; // above the deck by then, inside the clouds
    // Page: the title over the first 30 %, the builder's UI past 0.98.
    el.style.opacity = String(1 - smooth(0, 0.3, p));
    el.querySelector(".landing-go").disabled = p > 0.1;
    document.body.classList.toggle("landing", p < 0.98);
  }

  function takeOver(end) {
    on = true;
    G = groundY();
    path = makePath(end);
    if (!el.isConnected) document.body.appendChild(el);
    controls.enabled = false;
    onState(true);
  }
  function handOver() {
    on = false;
    p = pt = 1;
    v = 0;
    jump = null;
    apply();
    camera.position.copy(path.end.position); // exactly where the builder expects it
    controls.target.copy(path.end.target);
    camera.lookAt(path.end.target);
    planet.object3d.visible = false;
    clouds.update(0, { intensity: 0 });
    glow.style.opacity = "0";
    scene.background.copy(bg0);
    scene.fog.color.copy(fog0);
    if (stars) stars.material.opacity = starOpacity;
    root.visible = true;
    el.remove(); // back on resume()
    document.body.classList.remove("landing");
    controls.enabled = true;
    quietUntil = performance.now() + 500;
    onState(false);
  }

  function enter() {
    if (!on || pt >= 1) return;
    jump = { from: pt, t: 0, dur: JUMP_S * (1 - pt) };
  }
  function feed(px) {
    if (!on) return;
    jump = null;
    pt = Math.min(1, Math.max(0, pt + px / (SPAN_VH * innerHeight)));
  }
  function resume() {
    if (on) return;
    takeOver({ position: camera.position.clone(), target: controls.target.clone() });
    p = pt = 1;
    v = 0;
    apply();
  }
  const wheelPx = (e) => e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);

  function update(dt, t) {
    if (!on) return;
    if (jump) {
      jump.t += dt;
      pt = jump.from + (1 - jump.from) * easeInOut(Math.min(1, jump.t / Math.max(0.01, jump.dur)));
      if (jump.t >= jump.dur) jump = null;
    }
    v += (SPRING_W * SPRING_W * (pt - p) - 2 * SPRING_W * v) * dt;
    p += v * dt;
    if (p <= 0 || p >= 1) {
      p = Math.min(1, Math.max(0, p));
      v = 0;
    }
    if (pt >= 1 && p > 0.999) return handOver();
    apply();
    planet.update(0, camera); // t fixed: the self-rotation would turn the Cape away from the pad
    if (graticule) graticule.material.opacity *= 1 - smooth(0.2, 0.42, p); // no 15° cage converging on the pad
    clouds.update(dt, { intensity: cloudsAt(p) });
    if (warmFrames > 0) warmFrames--;
  }

  // Wheel / trackpad scroll while the landing is on (capture: the scrub and OrbitControls never see it), and the
  // inertia tail right after handing over.
  function onWheel(e) {
    if (!on && performance.now() > quietUntil) return;
    if (e.ctrlKey) return; // pinch zoom stays the browser's
    e.preventDefault();
    e.stopPropagation();
    if (on) feed(wheelPx(e));
  }
  // Drags scroll (up = forward, like a page); a click or tap without travel enters.
  let drag = null;
  function onDown(e) {
    if (!on || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest?.(".landing-go")) return;
    drag = { id: e.pointerId, y: e.clientY, x: e.clientX, travel: 0 };
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    drag.travel += Math.abs(dy) + Math.abs(e.clientX - drag.x);
    drag.y = e.clientY;
    drag.x = e.clientX;
    if (drag.travel > 8) feed(dy * 1.4);
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = drag.travel <= 8;
    drag = null;
    if (tap) enter();
  }
  addEventListener("wheel", onWheel, { capture: true, passive: false });
  canvas.addEventListener("pointerdown", onDown);
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", () => (drag = null));

  // Start on the landing shot.
  takeOver(endPose());
  apply();

  return {
    get on() {
      return on;
    },
    get p() {
      return p;
    },
    // How far the fog band is opened (1 on the landing, 0 at home): main blends its band with a wide one.
    get fogOpen() {
      return on ? 1 - smooth(0.8, 1, p) : 0;
    },
    update,
    enter,
    resume,
    feed,
    wheelPx,
    dispose() {
      removeEventListener("wheel", onWheel, { capture: true });
      canvas.removeEventListener("pointerdown", onDown);
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
      planet.dispose();
      clouds.dispose();
      el.remove();
      glow.remove();
    },
  };
}
