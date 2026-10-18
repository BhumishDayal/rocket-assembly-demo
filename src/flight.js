// One continuous flight: launch -> space -> (transfer) -> land, as a single timeline. Pure: no DOM; all est.
//   flightTimeline(build, catalog, opts?) -> {
//     outcome, kind, endState, bodies, bodyPosAt(body, t_sim), segments, events, stageDrops, sampleAt(t_screen),
//     screenToSim(t), simToScreen(t), surfaceFrame, totalScreen_s, totalSim_s, arrival, est }
//   opts: { ascent (a simulateAscent result to reuse), totalScreen_s (scales every segment's share) }
//   A blocked build gives { blocked: true, outcome: "blocked", reason, endState, est } and nothing else.
//   sampleAt(t_screen) -> { t_sim, t_screen, body ("earth" | "moon" | "mars" | "space"), segment, phase,
//     stageIndex (null once only the spacecraft flies), pos_km (body-centred; "space" = Earth-centred), pos_eci_km,
//     vel_kms (relative to the body), vel_eci_kms, dest_eci_km, speed_ms, alt_km, axis (unit nose / thrust axis),
//     pitch_deg (0 = straight up), yaw_deg (0 = north, 90 = east), throttle, burn, mass_kg, chute, heat, dust }
//   endState.type: "in-orbit" | "stranded" | "escape" | "landed" | "fell-back" | "impact" ("pad-abort" if blocked).
//   stageDrops: [{ type: "sep" | "fairing" | "payload-release" | "spacecraft-sep", stageIndex, t_sim, t_screen,
//     dropAway: { dir_body, dir_eci, speed_ms, duration_s } }] (fairing: one half; the other mirrors x).
// Built on ascent.js (the ascent itself) and arrival.js (success / landing rules, the powered descents). Nothing
// here adds physics beyond those and the cited constants; the stitching below is model choices:
// - Frame: Earth-centred, km, z = Earth's axis, x toward longitude 0; Earth's rotation ignored. Launch site 28.5 N,
//   80.6 W (Cape Canaveral) launching due east, so the ascent's 2-D plane is the plane of the site's up and east
//   directions, and everything after stays in that plane (the Moon's orbit is drawn in it too).
// - Earth missions: ascent -> SECO -> a quarter of a circular orbit at the SECO radius -> "In orbit" (or
//   "Stranded" when short of the mission). Earth escape: a third of an orbit, the departure burn, then the coast
//   out to 100,000 km.
// - Moon: a third of a parking orbit -> departure burn (impulsive) of the mission's beyond-LEO delta-v (missions.json:
//   mission - leo) -> the resulting coast under Earth's gravity (RK4) out to the Moon's mean distance -> orbit
//   insertion (impulsive) into a circular 15 km orbit -> a quarter orbit -> arrival.js's powered descent ->
//   touchdown. The Moon is placed where the coast reaches it and moves on a circle at its revolution period.
//   Orbiters (telescope, satellite) end after the quarter orbit.
// - Mars: departure burn as above -> a straight-line cruise scaled to 2,000,000 km (the real cruise takes months;
//   NOT to scale) whose speed eases from the post-burn speed to the hyperbolic excess speed (from that delta-v)
//   and up to arrival.js's 5.5 km/s entry speed -> aeroshell entry, parachute and powered descent -> touchdown.
//   Orbiters end in a 300 km circular orbit (model choice) after an impulsive insertion.
// - Burns after orbit are impulsive; throttle reads 1 for the 2 s around each one, and `burn` names it, as a
//   visual cue only. Between burns the vehicle turns smoothly (over the last quarter of each coast) to the
//   attitude the next phase starts with, so the axis never jumps at a coast's end.
// - Spent stages have no flight of their own: each separation gives a detach time and a 2 s drop-away (2 m/s,
//   backward and slightly sideways in the vehicle's body frame) so the director can let them fall out of frame.
// - Screen time: real time (rate 1 screen s per sim s) inside windows around ignition and liftoff, Max-Q, fairing,
//   MECO/separation/upper-stage ignition, SECO, payload release, each burn, chute opening and the last 3 s before
//   touchdown, and around every segment boundary. Leaving a window, the sim speed grows linearly with sim time
//   (so exponentially with screen time, e^6 per screen second) until it meets the segment's base rate (soft
//   minimum); each segment's base rate is solved so the segment gets its share of the total (Earth ~35 s, Moon
//   ~55 s, Mars ~65 s). The time rate is continuous everywhere, so screenToSim / simToScreen are C1.
// Constants: Earth GM as in ascent.js (WGS 84); radii, GM, the Moon's 0.3844 x 10^6 km semimajor axis and its
// 27.3217-day revolution period from NASA's planetary fact sheets
// (https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, .../marsfact.html, .../earthfact.html).
import { simulateAscent } from "./ascent.js";
import { arrivalTimeline, descentTimeline, lightingFor, atmosphereFor } from "./arrival.js";

export { lightingFor, atmosphereFor };

const MU = { earth: 398600.4418, moon: 4900, mars: 42828 }; // km^3/s^2 (moon 0.00490, mars 0.042828 x 10^6)
const R = { earth: 6371.0, moon: 1737.4, mars: 3389.5 }; // km
const MOON_DIST = 384400; // km (semimajor axis)
const MOON_PERIOD_DAYS = 27.3217;
const MOON_PERIOD_S = MOON_PERIOD_DAYS * 86400;
const LUNAR_ORBIT_ALT = 15; // km: arrival.js starts the powered descent from a 15 km circular orbit
const MARS_LINE_KM = 2e6; // scaled cruise length (model choice)
const MARS_ENTRY_ALT = 120; // km (arrival.js)
const MARS_ENTRY_GAMMA = -10; // deg (arrival.js)
const MARS_ENTRY_SPEED = 5.5; // km/s (arrival.js)
const MARS_ORBIT_ALT = 300; // km, orbiters (model choice)
const ESCAPE_SHOW_KM = 1e5; // escape coast shown out to this distance (model choice)
const EASE_S = 86400; // Mars cruise: speed eases over the first and the last day (model choice)
const SITE = { lat: 28.5, lon: -80.6 };
const LAMBDA = 6; // 1/s: sim speed = 1 + LAMBDA * (sim seconds since the window)
const SOFT_P = 4; // soft-minimum exponent between the window ramp and the base rate (4: two square roots)
const DROP = { speed_ms: 2, duration_s: 2 }; // model choice
const BURN_CUE_S = 1;
const TURN_FRACTION = 0.25; // a coast turns to the next attitude over its last quarter
const SHARE = {
  earth: { ascent: 24, orbit: 11 }, // 35
  escape: { ascent: 24, "parking-orbit": 4, escape: 7 }, // 35
  moon: { ascent: 23, "parking-orbit": 4, transfer: 9, "lunar-orbit": 4, braking: 5.5, approach: 3.5, vertical: 6 }, // 55
  "moon-orbit": { ascent: 23, "parking-orbit": 4, transfer: 9, "lunar-orbit": 6 }, // 42
  mars: { ascent: 24, "parking-orbit": 4, transfer: 10, entry: 8, parachute: 5, approach: 5.5, vertical: 8.5 }, // 65
  "mars-orbit": { ascent: 24, "parking-orbit": 4, transfer: 10, "mars-orbit": 6 }, // 44
};
const FAILED_ASCENT_S = 35; // a flight that never reaches orbit is all ascent
// The real-time windows and the ramps out of them set a floor per segment (about 3.9 s for the parking orbit,
// 8 s for a transfer, 3.6 s for a lunar orbit ending in a descent, 16-20 s for an ascent); the shares sit above it.

// ---------- vector helpers ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (v) => mul(v, 1 / (len(v) || 1));
const lerp = (a, b, u) => a + (b - a) * u;
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const r6 = (v) => v.map((x) => Math.round(x * 1e6) / 1e6); // velocities: km/s to the mm/s (a coast frame spans minutes)
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const rad = Math.PI / 180;

// Local frame on a body: up, east, north (north toward +z; every body shares Earth's axis here).
export function surfaceFrame(body, pos_km) {
  const up = unit(pos_km);
  let east = cross([0, 0, 1], up);
  if (len(east) < 1e-9) east = [0, 1, 0];
  east = unit(east);
  return { up, east, north: cross(up, east) };
}
export const altitude = (body, pos_km) => len(pos_km) - (R[body] ?? R.earth);

// ---------- the flight plane ----------
const U_SITE = [Math.cos(SITE.lat * rad) * Math.cos(SITE.lon * rad), Math.cos(SITE.lat * rad) * Math.sin(SITE.lon * rad), Math.sin(SITE.lat * rad)];
const E_SITE = unit([-Math.sin(SITE.lon * rad), Math.cos(SITE.lon * rad), 0]);
const H_PLANE = unit(cross(U_SITE, E_SITE)); // orbit normal of an eastward launch
const rHat = (th) => add(mul(U_SITE, Math.cos(th)), mul(E_SITE, Math.sin(th)));
const tHat = (th) => add(mul(U_SITE, -Math.sin(th)), mul(E_SITE, Math.cos(th)));
const planeAngle = (v) => Math.atan2(dot(v, E_SITE), dot(v, U_SITE));
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
// Turn axis a toward b by u (0..1) about the plane normal (every axis of the flight lies in the plane).
const turn = (a, b, u) => (u <= 0 ? a : u >= 1 ? b : rHat(planeAngle(a) + wrap(planeAngle(b) - planeAngle(a)) * u));

// ---------- interpolation over a time-sorted array ----------
function bracket(arr, t, key) {
  let lo = 0;
  let hi = arr.length - 1;
  if (t <= arr[0][key]) return [0, 0, 0];
  if (t >= arr[hi][key]) return [hi, hi, 0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= t) lo = mid;
    else hi = mid;
  }
  const a = arr[lo][key];
  const b = arr[hi][key];
  return [lo, hi, b > a ? (t - a) / (b - a) : 0];
}

// ---------- two-body coast (RK4, step 0.4 % of r / v) with cubic Hermite interpolation ----------
function coast(p0, v0, mu, done, tMax) {
  const acc = (p) => mul(p, -mu / len(p) ** 3);
  const step = (p, v, h) => {
    const a1 = acc(p);
    const p2 = add(p, mul(v, h / 2));
    const v2 = add(v, mul(a1, h / 2));
    const a2 = acc(p2);
    const p3 = add(p, mul(v2, h / 2));
    const v3 = add(v, mul(a2, h / 2));
    const a3 = acc(p3);
    const p4 = add(p, mul(v3, h));
    const v4 = add(v, mul(a3, h));
    const a4 = acc(p4);
    return [add(p, mul(add(add(v, mul(v2, 2)), add(mul(v3, 2), v4)), h / 6)), add(v, mul(add(add(a1, mul(a2, 2)), add(mul(a3, 2), a4)), h / 6))];
  };
  const out = [{ t: 0, p: p0, v: v0 }];
  let p = p0;
  let v = v0;
  let t = 0;
  while (t < tMax) {
    const h = Math.min((0.004 * len(p)) / len(v), 600);
    let [pn, vn] = step(p, v, h);
    if (done(pn)) {
      let lo = 0;
      let hi = h;
      for (let k = 0; k < 50; k++) {
        const m = (lo + hi) / 2;
        if (done(step(p, v, m)[0])) hi = m;
        else lo = m;
      }
      [pn, vn] = step(p, v, hi);
      out.push({ t: t + hi, p: pn, v: vn });
      return out;
    }
    p = pn;
    v = vn;
    t += h;
    out.push({ t, p, v });
  }
  return out;
}
function hermite(arc, t) {
  const [i, j, s] = bracket(arc, t, "t");
  const a = arc[i];
  const b = arc[j];
  const h = b.t - a.t;
  if (i === j || h <= 0) return { p: a.p, v: a.v };
  const s2 = s * s;
  const s3 = s2 * s;
  const p = add(add(mul(a.p, 2 * s3 - 3 * s2 + 1), mul(a.v, h * (s3 - 2 * s2 + s))), add(mul(b.p, -2 * s3 + 3 * s2), mul(b.v, h * (s3 - s2))));
  const v = add(add(mul(sub(a.p, b.p), (6 * s2 - 6 * s) / h), mul(a.v, 3 * s2 - 4 * s + 1)), mul(b.v, 3 * s2 - 2 * s));
  return { p, v };
}

// ---------- screen-time map ----------
// segs: [{ t0, t1, budget }] (contiguous), windows: [[a, b]] sim seconds, rate 1 inside.
function buildClock(segs, windows) {
  const T0 = segs[0].t0;
  const T1 = segs.at(-1).t1;
  const win = windows
    .map(([a, b]) => [Math.max(T0, a), Math.min(T1, b)])
    .filter(([a, b]) => b >= a)
    .sort((x, y) => x[0] - y[0])
    .reduce((m, w) => {
      const last = m.at(-1);
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
      else m.push([...w]);
      return m;
    }, []);
  const pts = [T0, T1];
  for (const s of segs) for (let i = 0; i <= 1500; i++) pts.push(s.t0 + ((s.t1 - s.t0) * i) / 1500);
  for (const [a, b] of win) {
    for (let t = a; t < b; t += 0.05) pts.push(t);
    pts.push(b);
    for (let k = 1; k < 2000; k++) {
      const d = (Math.exp(k * 0.02) - 1) / LAMBDA;
      if (a - d < T0 && b + d > T1) break;
      pts.push(a - d, b + d);
    }
  }
  const grid = Float64Array.from(pts.filter((t) => t >= T0 && t <= T1)).sort();
  const sim = grid.filter((t, i) => i === 0 || t - grid[i - 1] > 1e-9);
  const n = sim.length;
  // ramp rate from the nearest window, and the segment of each point
  const rw = new Float64Array(n);
  const seg = new Int32Array(n);
  let w = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = sim[i];
    while (w < win.length - 1 && win[w + 1][0] <= t) w++;
    let d = Infinity;
    for (const j of [w - 1, w, w + 1]) {
      const x = win[j];
      if (!x) continue;
      d = Math.min(d, t < x[0] ? x[0] - t : t > x[1] ? t - x[1] : 0);
    }
    rw[i] = 1 / (1 + LAMBDA * d);
    while (k < segs.length - 1 && t > segs[k].t1) k++;
    seg[i] = k;
  }
  const rw4 = rw.map((x) => x ** SOFT_P);
  const rateAt = (i, rb4) => Math.min(1, Math.sqrt(Math.sqrt(rb4 + rw4[i])));
  // one base rate per segment, by bisection on its log
  const base = segs.map((s, j) => {
    let i0 = -1;
    let i1 = -1;
    for (let i = 0; i < n - 1; i++) {
      if (sim[i] < s.t0 - 1e-9 || sim[i + 1] > s.t1 + 1e-9) continue;
      if (i0 < 0) i0 = i;
      i1 = i;
    }
    const screenOf = (rb) => {
      const rb4 = rb ** SOFT_P;
      let acc = 0;
      let left = rateAt(i0, rb4);
      for (let i = i0; i <= i1; i++) {
        const right = rateAt(i + 1, rb4);
        acc += ((left + right) / 2) * (sim[i + 1] - sim[i]);
        left = right;
      }
      return acc;
    };
    let lo = Math.log(1e-9);
    let hi = 0;
    if (i0 < 0 || screenOf(Math.exp(lo)) >= s.budget) return Math.exp(lo);
    if (screenOf(1) <= s.budget) return 1;
    for (let it = 0; it < 40; it++) {
      const m = (lo + hi) / 2;
      if (screenOf(Math.exp(m)) < s.budget) lo = m;
      else hi = m;
    }
    return Math.exp((lo + hi) / 2);
  });
  const rate = Float64Array.from({ length: n }, (_, i) => rateAt(i, base[seg[i]] ** SOFT_P));
  const screen = new Float64Array(n);
  for (let i = 1; i < n; i++) screen[i] = screen[i - 1] + ((rate[i] + rate[i - 1]) / 2) * (sim[i] - sim[i - 1]);
  // rate is linear inside each cell, so screen time is quadratic in sim time there (exact both ways)
  const cell = (xs, x) => {
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const simToScreen = (t) => {
    if (t <= sim[0]) return 0;
    if (t >= sim[n - 1]) return screen[n - 1];
    const i = cell(sim, t);
    const x = t - sim[i];
    const kk = (rate[i + 1] - rate[i]) / (sim[i + 1] - sim[i]);
    return screen[i] + rate[i] * x + (kk * x * x) / 2;
  };
  const screenToSim = (s) => {
    if (s <= 0) return sim[0];
    if (s >= screen[n - 1]) return sim[n - 1];
    const i = cell(screen, s);
    const c = s - screen[i];
    const kk = (rate[i + 1] - rate[i]) / (sim[i + 1] - sim[i]);
    const x = (2 * c) / (rate[i] + Math.sqrt(Math.max(0, rate[i] * rate[i] + 2 * kk * c)));
    return Math.min(sim[i + 1], sim[i] + x);
  };
  return { simToScreen, screenToSim, total: screen[n - 1], base, windows: win };
}

// ---------- the timeline ----------
export function flightTimeline(build, catalog, opts = {}) {
  const ascent = opts.ascent ?? simulateAscent(build, catalog);
  const s = ascent.summary;
  if (s.outcome === "blocked") return { blocked: true, outcome: "blocked", reason: s.reason, endState: { type: "pad-abort", text: `Pad abort · ${s.reason}` }, est: true };
  const arrival = arrivalTimeline(build, catalog, s);
  const payload = catalog.payloads.find((p) => p.id === build.payloadId) ?? null;
  const mission = catalog.missions.find((m) => m.id === build.missionId);
  const leo = catalog.missions.find((m) => m.id === "leo");
  const dv = mission && leo ? Math.max(0, mission.requiredDeltaV_ms - leo.requiredDeltaV_ms) / 1000 : 0; // km/s
  const AS = ascent.samples;
  const AE = ascent.events;
  const inOrbit = s.remainingDeltaV_ms != null;
  const kind = inOrbit && arrival.success && arrival.body !== "earth" ? arrival.body : "earth";
  const escape = kind === "earth" && arrival.success && mission?.id === "earth-escape";
  const lands = kind !== "earth" && arrival.lands;
  const shareKey = escape ? "escape" : kind === "earth" ? "earth" : lands ? kind : `${kind}-orbit`;

  const pieces = []; // { name, body, t0, t1, fn(t) -> state, coast }
  const events = [];
  const windows = [];
  const stageDrops = [];
  const ev = (type, t, extra = {}) => events.push({ type, t_sim: round(t, 3), ...extra });
  const win = (a, b) => windows.push([a, b]);
  const burnCue = (t, burns) => {
    for (const [tb, name] of burns) if (Math.abs(t - tb) <= BURN_CUE_S) return name;
    return null;
  };

  // ---- ascent (ascent.js samples in the launch plane)
  const ascentState = (t) => {
    const [i, j, u] = bracket(AS, t, "t");
    const a = AS[i];
    const b = AS[j];
    const alt = lerp(a.alt_m, b.alt_m, u) / 1000;
    const th = lerp(a.downrange_m, b.downrange_m, u) / 1000 / R.earth;
    const gam = lerp(a.gamma_deg, b.gamma_deg, u) * rad;
    const v = lerp(a.vel_ms, b.vel_ms, u) / 1000;
    const vel = add(mul(tHat(th), v * Math.cos(gam)), mul(rHat(th), v * Math.sin(gam)));
    return {
      body: "earth",
      pos: mul(rHat(th), R.earth + alt),
      vel,
      axis: v > 0.001 ? unit(vel) : rHat(th),
      throttle: lerp(a.throttle, b.throttle, u),
      stageIndex: a.stage,
      mass_kg: lerp(a.mass_kg, b.mass_kg, u),
      heat: lerp(a.heat ?? 0, b.heat ?? 0, u),
      phase: "ascent",
    };
  };
  const tEndAscent = AS.at(-1).t;
  pieces.push({ name: "ascent", body: "earth", t0: 0, t1: tEndAscent, fn: ascentState });
  const liftoff = AE.find((e) => e.type === "liftoff");
  win(0, (liftoff?.t ?? 0) + 3);
  for (const e of AE) {
    if (e.t > tEndAscent + 1e-6) continue;
    ev(e.type, e.t, { body: "earth", stage: e.stage });
    if (e.type === "maxq") win(e.t - 0.5, e.t + 0.5);
    if (e.type === "fairing") {
      win(e.t - 0.2, e.t + 0.8);
      stageDrops.push(dropAway("fairing", e.stage, e.t, ascentState(e.t), [1, 0.2, 0], { halves: 2, note: "the other half mirrors x" }));
    }
    if (e.type === "meco") win(e.t - 0.3, e.t + 2.3); // MECO, separation (+1 s), upper-stage ignition (+2 s)
    if (e.type === "sep") stageDrops.push(dropAway("sep", e.stage, e.t, ascentState(e.t)));
    if (e.type === "seco") win(e.t - 0.5, e.t + 0.5);
  }

  let endState;
  const bodies = { earth: { radius_km: R.earth, pos_km: [0, 0, 0] } };
  let bodyPos = (body) => (body === "earth" ? [0, 0, 0] : null);
  const upper = AS.at(-1).stage;
  const fullMass = AS.at(-1).mass_kg;
  const payloadMass = payload?.mass_kg ?? fullMass;

  if (!inOrbit) {
    // never in orbit: the ascent samples already run to the end (impact or the fall back)
    endState = { type: s.outcome === "shortfall" ? "fell-back" : "impact", text: arrival.lines[0] ?? "The rocket never reached orbit (est.)." };
    ev("end", tEndAscent, { body: "earth" });
  } else {
    // circular orbit at the SECO radius, in the launch plane
    const end = ascentState(tEndAscent);
    const th0 = planeAngle(end.pos);
    const r0 = len(end.pos);
    const vc = Math.sqrt(MU.earth / r0);
    const om = vc / r0;
    const period = (2 * Math.PI) / om;
    const thAt = (t) => th0 + om * (t - tEndAscent);
    const release = AE.find((e) => e.type === "payload-release");
    const orbitState = (tRelease, burns) => (t) => ({
      body: "earth",
      pos: mul(rHat(thAt(t)), r0),
      vel: mul(tHat(thAt(t)), vc),
      axis: tHat(thAt(t)),
      throttle: burnCue(t, burns) ? 1 : 0,
      burn: burnCue(t, burns),
      stageIndex: t < tRelease ? upper : null,
      mass_kg: t < tRelease ? fullMass : payloadMass,
      phase: "orbit",
    });

    if (kind === "earth" && !escape) {
      const tEnd = tEndAscent + period / 4;
      const tRel = release?.t ?? Infinity;
      pieces.push({ name: "orbit", body: "earth", t0: tEndAscent, t1: tEnd, fn: orbitState(tRel, []), coast: true });
      if (release) {
        ev("payload-release", release.t, { body: "earth", stage: upper });
        win(release.t - 0.5, release.t + 1.5);
        stageDrops.push(dropAway("payload-release", upper, release.t, orbitState(tRel, [])(release.t)));
      }
      endState = arrival.success ? { type: "in-orbit", text: arrival.lines.at(-1) } : { type: "stranded", text: arrival.lines.join(" ") };
      ev("end", tEnd, { body: "earth" });
    } else {
      // parking orbit, then the departure burn by the upper stage; the spacecraft leaves the stage 30 s later
      const tDep = tEndAscent + period / 3;
      const thDep = thAt(tDep);
      const pDep = mul(rHat(thDep), r0);
      const tSep = tDep + 30;
      const burns = [[tDep, "departure"]];
      pieces.push({ name: "parking-orbit", body: "earth", t0: tEndAscent, t1: tDep, fn: orbitState(Infinity, burns), coast: true });
      ev("departure-burn", tDep, { body: "earth", stage: upper, dv_ms: Math.round(dv * 1000) });
      win(tDep - 0.5, tDep + 0.5);
      ev("spacecraft-sep", tSep, { body: "space", stage: upper });
      win(tSep - 0.3, tSep + 0.7);
      const craft = (t) => ({ stageIndex: t < tSep ? upper : null, mass_kg: t < tSep ? fullMass : payloadMass });
      let vp = vc + dv;

      if (escape || kind === "moon") {
        const rLo = R.moon + LUNAR_ORBIT_ALT;
        const rArr = MOON_DIST - rLo;
        if (kind === "moon") {
          // the coast must reach the Moon: at least the perigee speed of an ellipse with apogee 1.05 x rArr
          const ra = 1.05 * rArr;
          vp = Math.max(vp, Math.sqrt((2 * MU.earth * ra) / (r0 * (r0 + ra))));
        }
        const stopR = escape ? ESCAPE_SHOW_KM : rArr;
        const arc = coast(pDep, mul(tHat(thDep), vp), MU.earth, (p) => len(p) >= stopR, 30 * 86400).map((x) => ({ ...x, t: x.t + tDep }));
        const tArr = arc.at(-1).t;
        const coastName = escape ? "escape" : "transfer";
        const transferState = (t) => {
          const { p, v } = hermite(arc, t);
          const b = burnCue(t, burns.concat(kind === "moon" ? [[tArr, "insertion"]] : []));
          return { body: "space", pos: p, vel: v, axis: unit(v), throttle: b ? 1 : 0, burn: b, ...craft(t), phase: coastName };
        };
        pieces.push({ name: coastName, body: "space", t0: tDep, t1: tArr, fn: transferState, coast: true });
        if (escape) {
          endState = { type: "escape", text: arrival.lines.at(-1) };
          ev("end", tArr, { body: "space" });
        } else {
          const alpha = planeAngle(arc.at(-1).p);
          const omM = (2 * Math.PI) / MOON_PERIOD_S;
          const moonPos = (t) => mul(rHat(alpha + omM * (t - tArr)), MOON_DIST);
          const moonVel = (t) => mul(tHat(alpha + omM * (t - tArr)), MOON_DIST * omM);
          bodies.moon = { radius_km: R.moon, distance_km: MOON_DIST, period_days: MOON_PERIOD_DAYS, pos_km_at_arrival: r3(moonPos(tArr)) };
          bodyPos = (body, t) => (body === "earth" ? [0, 0, 0] : body === "moon" ? moonPos(t) : null);
          // circular 15 km lunar orbit in the flight plane, from the Earth-facing side, turning the way the
          // spacecraft arrives
          const u1 = mul(rHat(alpha), -1);
          const vRel = sub(arc.at(-1).v, moonVel(tArr));
          let u2 = sub(vRel, mul(u1, dot(vRel, u1)));
          u2 = len(u2) > 1e-6 ? unit(u2) : unit(cross(H_PLANE, u1));
          const vLo = Math.sqrt(MU.moon / rLo);
          const omLo = vLo / rLo;
          const tPdi = tArr + Math.PI / 2 / omLo;
          const ring = (beta, r) => add(mul(u1, r * Math.cos(beta)), mul(u2, r * Math.sin(beta)));
          const ringV = (beta, v) => add(mul(u1, -v * Math.sin(beta)), mul(u2, v * Math.cos(beta)));
          ev("lunar-orbit-insertion", tArr, { body: "moon" });
          win(tArr - 0.5, tArr + 0.5);
          const loState = (t) => {
            const beta = omLo * (t - tArr);
            const rel = ring(beta, rLo);
            const relV = ringV(beta, vLo);
            const b = burnCue(t, [[tArr, "insertion"]]);
            return { body: "moon", pos: rel, posEci: add(moonPos(t), rel), vel: relV, velEci: add(relV, moonVel(t)), axis: mul(unit(relV), -1), throttle: b ? 1 : 0, burn: b, stageIndex: null, mass_kg: payloadMass, phase: "lunar-orbit" };
          };
          pieces.push({ name: "lunar-orbit", body: "moon", t0: tArr, t1: tPdi, fn: loState, coast: true });
          if (lands) {
            const tEnd = addDescent(descentTimeline(payload, { body: "moon" }), "moon", tPdi, Math.PI / 2, u1, u2, moonPos, moonVel);
            endState = { type: "landed", text: arrival.lines.at(-1) };
            ev("end", tEnd, { body: "moon" });
          } else {
            endState = { type: "in-orbit", text: arrival.lines.at(-1) };
            ev("end", tPdi, { body: "moon" });
          }
        }
      } else {
        // Mars: straight line along the departure direction, speed eased (exact distance integral of the speed)
        const dHat = tHat(thDep);
        const w0 = rHat(thDep);
        const vInf = Math.sqrt(Math.max(0.01, vp * vp - (2 * MU.earth) / r0));
        const s1 = (EASE_S * (vp + vInf)) / 2;
        const s3 = (EASE_S * (vInf + MARS_ENTRY_SPEED)) / 2;
        const T2 = Math.max(3600, (MARS_LINE_KM - s1 - s3) / vInf);
        const L = s1 + vInf * T2 + s3;
        const tEi = tDep + 2 * EASE_S + T2;
        const along = (t) => {
          const x = t - tDep;
          if (x <= EASE_S) {
            const u = x / EASE_S;
            return { s: EASE_S * (vp * u + (vInf - vp) * (u ** 3 - u ** 4 / 2)), v: lerp(vp, vInf, smooth(u)) };
          }
          if (x <= EASE_S + T2) return { s: s1 + vInf * (x - EASE_S), v: vInf };
          const u = Math.min(1, (x - EASE_S - T2) / EASE_S);
          return { s: s1 + vInf * T2 + EASE_S * (vInf * u + (MARS_ENTRY_SPEED - vInf) * (u ** 3 - u ** 4 / 2)), v: lerp(vInf, MARS_ENTRY_SPEED, smooth(u)) };
        };
        const pEnd = add(pDep, mul(dHat, L));
        const gam = (lands ? MARS_ENTRY_GAMMA : 0) * rad;
        const rEnd = R.mars + (lands ? MARS_ENTRY_ALT : MARS_ORBIT_ALT);
        // local up at the line's end: the line meets Mars at flight-path angle gam
        const up = add(mul(dHat, Math.sin(gam)), mul(w0, Math.cos(gam)));
        const marsC = sub(pEnd, mul(up, rEnd));
        bodies.mars = { radius_km: R.mars, pos_km: r3(marsC), scaled: true, note: "placed 2,000,000 km down the departure line: not to scale" };
        bodyPos = (body) => (body === "earth" ? [0, 0, 0] : body === "mars" ? marsC : null);
        const cruiseState = (t) => {
          const { s: d, v } = along(t);
          const b = burnCue(t, burns.concat(lands ? [] : [[tEi, "insertion"]]));
          return { body: "space", pos: add(pDep, mul(dHat, d)), vel: mul(dHat, v), axis: dHat, throttle: b ? 1 : 0, burn: b, ...craft(t), phase: "transfer" };
        };
        pieces.push({ name: "transfer", body: "space", t0: tDep, t1: tEi, fn: cruiseState, coast: true });
        const u1 = up;
        const u2 = unit(sub(dHat, mul(u1, dot(dHat, u1))));
        if (lands) {
          ev("entry-interface", tEi, { body: "mars" });
          win(tEi - 0.5, tEi + 0.5);
          const tEnd = addDescent(descentTimeline(payload, { body: "mars" }), "mars", tEi, 0, u1, u2, () => marsC, () => [0, 0, 0]);
          endState = { type: "landed", text: arrival.lines.at(-1) };
          ev("end", tEnd, { body: "mars" });
        } else {
          const vO = Math.sqrt(MU.mars / rEnd);
          const omO = vO / rEnd;
          const tEnd = tEi + Math.PI / 2 / omO;
          ev("mars-orbit-insertion", tEi, { body: "mars" });
          win(tEi - 0.5, tEi + 0.5);
          const moState = (t) => {
            const beta = omO * (t - tEi);
            const rel = add(mul(u1, rEnd * Math.cos(beta)), mul(u2, rEnd * Math.sin(beta)));
            const relV = add(mul(u1, -vO * Math.sin(beta)), mul(u2, vO * Math.cos(beta)));
            const b = burnCue(t, [[tEi, "insertion"]]);
            return { body: "mars", pos: rel, posEci: add(marsC, rel), vel: relV, axis: mul(unit(relV), -1), throttle: b ? 1 : 0, burn: b, stageIndex: null, mass_kg: payloadMass, phase: "mars-orbit" };
          };
          pieces.push({ name: "mars-orbit", body: "mars", t0: tEi, t1: tEnd, fn: moState, coast: true });
          endState = { type: "in-orbit", text: arrival.lines.at(-1) };
          ev("end", tEnd, { body: "mars" });
        }
      }
      stageDrops.push(dropAway("spacecraft-sep", upper, tSep, pieces.find((p) => tSep >= p.t0 && tSep <= p.t1)?.fn(tSep) ?? ascentState(tEndAscent)));
    }
  }

  // arrival.js descent samples -> body-centred states on the circle (u1, u2), beta0 = arc angle already flown
  function addDescent(d, body, t0, beta0, u1, u2, centre, centreVel) {
    const DS = d.samples;
    const T = DS.at(-1).t_s;
    const names = d.phases.map((p) => p.name);
    const starts = names.map((nm) => t0 + DS.find((x) => x.phase === nm).t_s);
    const posAt = (x) => {
      const [i, j, u] = bracket(DS, x, "t_s");
      const a = DS[i];
      const b = DS[j];
      const r = R[body] + lerp(a.alt_m, b.alt_m, u) / 1000;
      const beta = beta0 + lerp(a.downrange_m, b.downrange_m, u) / 1000 / R[body];
      return { pos: add(mul(u1, r * Math.cos(beta)), mul(u2, r * Math.sin(beta))), a, b, u, beta };
    };
    const descentState = (t) => {
      const x = Math.max(0, Math.min(T, t - t0));
      const { pos, a, b, u, beta } = posAt(x);
      const x2 = Math.min(T, x + 0.5);
      const x1 = Math.max(0, x - 0.5);
      const vel = x2 > x1 ? mul(sub(posAt(x2).pos, posAt(x1).pos), 1 / (x2 - x1)) : [0, 0, 0];
      const f = surfaceFrame(body, pos);
      const hz = sub(vel, mul(f.up, dot(vel, f.up)));
      const hdir = len(hz) > 1e-6 ? unit(hz) : add(mul(u1, -Math.sin(beta)), mul(u2, Math.cos(beta)));
      const pitch = lerp(a.pitch_deg, b.pitch_deg, u) * rad;
      const unpowered = a.phase === "entry" || a.phase === "parachute";
      // powered: thrust axis tilted back against the motion by the descent pitch; entry and chute: against the flow
      const axis = unpowered ? (len(vel) > 1e-6 ? mul(unit(vel), -1) : f.up) : unit(sub(mul(f.up, Math.cos(pitch)), mul(hdir, Math.sin(pitch))));
      return {
        body,
        pos,
        posEci: add(centre(t), pos),
        vel,
        velEci: add(vel, centreVel(t)),
        axis,
        throttle: lerp(a.throttle, b.throttle, u),
        stageIndex: null,
        mass_kg: payloadMass,
        heat: lerp(a.heat, b.heat, u),
        chute: lerp(a.chute ?? 0, b.chute ?? 0, u),
        dust: lerp(a.dust, b.dust, u),
        phase: x >= T ? "touchdown" : a.phase,
      };
    };
    names.forEach((nm, i) => {
      const t1 = i + 1 < names.length ? starts[i + 1] : t0 + T;
      pieces.push({ name: nm, body, t0: starts[i], t1, fn: descentState });
    });
    for (const m of d.moments) ev(m.type, t0 + m.t_s, { body, alt_m: m.alt_m, vel_ms: m.vel_ms });
    const chute = d.moments.find((m) => m.type === "chute-open");
    if (chute) win(t0 + chute.t_s - 1, t0 + chute.t_s + 1);
    win(t0 + T - 3, t0 + T);
    return t0 + T;
  }

  // coasts turn, over their last quarter, to the attitude the next piece starts with
  for (let i = 0; i < pieces.length - 1; i++) {
    const p = pieces[i];
    if (!p.coast) continue;
    const next = pieces[i + 1];
    const target = next.fn(next.t0).axis;
    const raw = p.fn;
    const span = (p.t1 - p.t0) * TURN_FRACTION;
    p.fn = (t) => {
      const st = raw(t);
      return { ...st, axis: turn(st.axis, target, smooth((t - (p.t1 - span)) / span)) };
    };
  }

  // ---- the clock: every boundary sits in a real-time window, so the rate is continuous across segments
  for (let i = 1; i < pieces.length; i++) win(pieces[i].t0 - 0.3, pieces[i].t0 + 0.3);
  const failed = pieces.length === 1;
  const share = SHARE[shareKey];
  const sumShare = failed ? FAILED_ASCENT_S : pieces.reduce((a, p) => a + (share[p.name] ?? 0), 0);
  const scale = (opts.totalScreen_s ?? sumShare) / sumShare;
  const segs = pieces.map((p) => ({ t0: p.t0, t1: p.t1, budget: (failed ? FAILED_ASCENT_S : share[p.name] ?? 1) * scale }));
  const clock = buildClock(segs, windows);

  for (const e of events) e.t_screen = round(clock.simToScreen(e.t_sim), 3);
  events.sort((a, b) => a.t_sim - b.t_sim);
  for (const d of stageDrops) d.t_screen = round(clock.simToScreen(d.t_sim), 3);
  const segments = pieces.map((p) => ({ name: p.name, body: p.body, t0_sim: round(p.t0, 3), t1_sim: round(p.t1, 3), t0_screen: round(clock.simToScreen(p.t0), 3), t1_screen: round(clock.simToScreen(p.t1), 3) }));

  const pieceAt = (t) => pieces.find((x) => t >= x.t0 && t <= x.t1) ?? (t < pieces[0].t0 ? pieces[0] : pieces.at(-1));
  const dest = kind === "earth" ? null : kind;
  const sampleAt = (tScreen) => {
    const ts = Math.max(0, Math.min(clock.total, tScreen));
    const t = clock.screenToSim(ts);
    const piece = pieceAt(t);
    const st = piece.fn(Math.max(piece.t0, Math.min(piece.t1, t)));
    const destPos = dest ? bodyPos(dest, t) : null;
    const frameBody = st.body === "space" ? "earth" : st.body;
    const f = surfaceFrame(frameBody, st.pos);
    const pitch = (Math.acos(Math.max(-1, Math.min(1, dot(st.axis, f.up)))) * 180) / Math.PI;
    // heading of the axis; straight up (or down) it has none, so use the direction of travel in the flight plane
    const level = sub(st.axis, mul(f.up, dot(st.axis, f.up)));
    const head = len(level) > 1e-3 ? level : tHat(planeAngle(st.pos));
    const yaw = (Math.atan2(dot(head, f.east), dot(head, f.north)) * 180) / Math.PI;
    return {
      t_sim: t,
      t_screen: ts,
      body: st.body,
      segment: piece.name,
      phase: st.phase,
      stageIndex: st.stageIndex,
      pos_km: r3(st.pos), // body-centred ("space": Earth-centred)
      pos_eci_km: r3(st.posEci ?? st.pos), // always Earth-centred
      vel_kms: r6(st.vel), // relative to the current body
      vel_eci_kms: r6(st.velEci ?? st.vel),
      dest_eci_km: destPos ? r3(destPos) : null, // the destination's centre (Moon moving, Mars fixed), Earth-centred
      speed_ms: round(len(st.vel) * 1000, 1),
      alt_km: round(altitude(frameBody, st.pos), 3),
      axis: r3(st.axis), // the vehicle's long axis (nose / thrust direction), unit, same frame as pos_km
      pitch_deg: round(pitch, 1), // 0 = straight up
      yaw_deg: round((yaw + 360) % 360, 1), // 0 = north, 90 = east
      throttle: round(st.throttle, 3),
      burn: st.burn ?? null,
      mass_kg: st.mass_kg == null ? null : Math.round(st.mass_kg),
      chute: round(st.chute ?? 0, 3),
      heat: round(st.heat ?? 0, 3),
      dust: round(st.dust ?? 0, 3),
    };
  };

  return {
    outcome: s.outcome,
    kind,
    endState,
    bodies,
    bodyPosAt: (body, t) => {
      const p = bodyPos(body, t);
      return p ? r3(p) : null;
    },
    segments,
    events,
    stageDrops,
    sampleAt,
    screenToSim: clock.screenToSim,
    simToScreen: clock.simToScreen,
    surfaceFrame,
    totalScreen_s: round(clock.total, 3),
    totalSim_s: round(pieces.at(-1).t1, 3),
    arrival,
    _clock: clock, // for checks
    est: true,
  };
}

// A part's 2 s drop-away at its detach time. Body frame: +y = the vehicle's nose axis, +x = the vehicle's right
// (axis x local up), +z completes the frame; the direction is also given Earth-centred at that moment.
function dropAway(type, stageIndex, t, st, dirBody = [0.08, -1, 0], extra = {}) {
  const f = surfaceFrame("earth", st.posEci ?? st.pos);
  let x = cross(st.axis, f.up);
  x = len(x) < 1e-6 ? f.east : unit(x);
  const z = cross(x, st.axis);
  const d = unit(dirBody);
  return { type, stageIndex, t_sim: round(t, 3), dropAway: { dir_body: r3(d), dir_eci: r3(unit(add(add(mul(x, d[0]), mul(st.axis, d[1])), mul(z, d[2])))), speed_ms: DROP.speed_ms, duration_s: DROP.duration_s }, ...extra };
}
