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
//   kind: the mission's destination ("earth" | "moon" | "mars", arrival.js).
//   endState: { type, line (ready to show), text (= line) , ... }; type:
//     "landed" (body; Earth missions bring the stage home: missionLine, landing { site, ... }) | "in-orbit-of" (body)
//     | "lost" (impact { downrange_km, surface: "sea" | "ground" }) | "transfer-failed" (body, shortBy_ms,
//     apogee_km (null if it escapes Earth), perigee_km, period_s) | "aborted" (blocked, or never left the pad).
//   stageDrops: [{ type: "sep" | "fairing" | "payload-release" | "spacecraft-sep", stageIndex, t_sim, t_screen,
//     dropAway: { dir_body, dir_eci, speed_ms, duration_s } }] (fairing: one half; the other mirrors x).
// Built on ascent.js (the ascent itself) and arrival.js (success / landing rules, the powered descents). Nothing
// here adds physics beyond those and the cited constants; the stitching below is model choices:
// - Frame: Earth-centred, km, z = Earth's axis, x toward longitude 0; Earth's rotation ignored. Launch site 28.5 N,
//   80.6 W (Cape Canaveral) launching due east, so the ascent's 2-D plane is the plane of the site's up and east
//   directions, and everything after stays in that plane (the Moon's orbit is drawn in it too).
// - The flight is the build's consequence. Never in orbit (ascent.js "impact" / suborbital "shortfall"): the
//   ascent samples run through the fall and re-entry (heat) to the ground: "lost" (or "aborted" if it never left
//   the pad). LEO: a quarter of a circular orbit at the SECO radius: "orbit".
// - Beyond LEO: a third of a circular parking orbit, then the departure burn, flown: the upper stage's own vacuum
//   thrust and mass flow (engines.json), prograde, RK4 under Earth's gravity, until it has given the mission's
//   departure delta-v (missions.json: mission - leo; for lunar-orbit, moon-transfer - leo, the rest being the
//   insertion) or its propellant is gone ("propellant-depleted": burn time from the remaining delta-v at that mass
//   flow). The orbit after cutoff comes from vis-viva (apogee, perigee, period).
// - Earth missions end with the stage landing back on Earth (round 20): LEO releases the payload and times the
//   de-orbit to touch down on the pad; Earth escape does the same, the spacecraft leaving on its own escape burn
//   (an event, not flown); GTO coasts the stage out to the transfer orbit's apogee, de-orbits there and comes
//   down on a drone ship 600 km down the launch track, its departure timed for that (the parking-orbit coast
//   is chosen so; "return timed to the recovery zone" in landing.modelled). landing carries lat_deg / lon_deg and
//   downrange_km from the Cape. See returnPlan / landHome.
// - Moon: the coast under Earth's gravity (RK4) out to the Moon's mean distance; orbit insertion (impulsive) into a
//   circular 15 km orbit; a quarter orbit; arrival.js's powered descent; touchdown ("landed"), or "in-orbit-of"
//   for orbiters. The Moon is placed where the coast reaches it and moves on a circle at its revolution period.
// - Mars: a straight-line cruise along the cutoff velocity, scaled to 2,000,000 km (the real cruise takes months;
//   NOT to scale), its speed easing from the cutoff speed to the hyperbolic excess speed and up to arrival.js's
//   5.5 km/s entry speed; aeroshell entry, parachute and powered descent ("landed"), or a 300 km circular orbit
//   (model choice) after an impulsive insertion ("in-orbit-of").
// - Short of the mission ("transfer-failed", with the shortfall, apogee and period): the burn runs dry; a bound
//   orbit is flown once around, out to its apogee and back toward Earth (its perigee stays near the parking
//   orbit), while the destination stays where a full burn would have met it (Moon) or 2,000,000 km away (Mars).
//   A lunar-orbit build short only of the insertion crosses the Moon's orbit 500 km past the Moon (model choice;
//   the Moon's gravity is not modelled) and flies on. A Mars build that escapes Earth too slowly stops short down
//   the line in proportion to its hyperbolic excess speed: adrift.
// - Insertion burns are impulsive: throttle reads 1 for the 2 s around them, and `burn` names them, as a visual
//   cue only. Between burns the vehicle turns smoothly (over the last quarter of each coast) to the attitude the
//   next phase starts with, so the axis never jumps at a coast's end.
// - Spent stages have no flight of their own: each separation gives a detach time and a 2 s drop-away (2 m/s,
//   backward and slightly sideways in the vehicle's body frame) so the director can let them fall out of frame.
// - Screen time: real time (rate 1 screen s per sim s) inside windows around ignition and liftoff, Max-Q, fairing,
//   MECO/separation/upper-stage ignition, SECO, payload release, each burn, chute opening and the last 3 s before
//   touchdown, and around every segment boundary. Leaving a window, the sim speed grows linearly with sim time
//   (so exponentially with screen time, e^6 per screen second) until it meets the segment's base rate (soft
//   minimum); each segment's base rate is solved so the segment gets its share of the total (Earth ~35 s, Moon
//   ~55 s, Mars ~65 s). The time rate is continuous everywhere, so screenToSim / simToScreen are C1.
// Constants: Earth GM as in ascent.js (WGS 84); radii, GM, the Moon's 0.3844 x 10^6 km semimajor axis and its
// 27.3217-day revolution period, Earth's sidereal day and equatorial radius (for GEO) from NASA's planetary fact sheets
// (https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, .../marsfact.html, .../earthfact.html).
import { simulateAscent, returnFromSpace } from "./ascent.js";
import { arrivalTimeline, descentTimeline, lightingFor, atmosphereFor } from "./arrival.js";
import { G0 } from "./physics.js";

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
const DEORBIT_PERIGEE_ALT = 50; // km: the de-orbit burn aims the perigee this low (model choice)
const ENTRY_INTERFACE_ALT = 120; // km: where the Kepler coast hands over to the booster model (model choice)
const MODELLED_DEORBIT = 0.1; // km/s: the retro assumed when no propellant is left (Head 1's brief, est.)
const DRONE_SHIP_KM = 600; // km down the launch track from the Cape: where a GTO stage's return is timed to (model choice)
const PAYLOAD_OFF = [0.05, 1, 0]; // drop-away of a payload leaving a stage that comes home: forward off the nose
const FLYBY_ALT = 500; // km: a lunar-orbit build short of insertion crosses the Moon's orbit this far off (model choice)
// GEO from the Earth fact sheet: "Sidereal rotation period (hrs) 23.9345", "Equatorial radius (km) 6378.137"
const R_EQ = 6378.137;
const GEO_R = Math.cbrt(398600.4418 * ((23.9345 * 3600) / (2 * Math.PI)) ** 2); // km from Earth's centre (35,786 km up)
const EASE_S = 86400; // Mars cruise: speed eases over the first and the last day (model choice)
const SITE = { lat: 28.5, lon: -80.6 };
const LAMBDA = 6; // 1/s: sim speed = 1 + LAMBDA * (sim seconds since the window)
const SOFT_P = 4; // soft-minimum exponent between the window ramp and the base rate (4: two square roots)
const DROP = { speed_ms: 2, duration_s: 2 }; // model choice
const BURN_CUE_S = 1;
const TURN_FRACTION = 0.25; // a coast turns to the next attitude over its last quarter
const SHARE = {
  earth: { ascent: 22, orbit: 6, "deorbit-burn": 2, "deorbit-coast": 4, reentry: 8, landing: 6 }, // 48 (LEO, then home)
  gto: { ascent: 22, "parking-orbit": 4, "departure-burn": 3.5, transfer: 4.5, "deorbit-burn": 2, "deorbit-coast": 4, reentry: 7, landing: 6 }, // 53
  moon: { ascent: 22, "parking-orbit": 4, "departure-burn": 3.5, transfer: 8, "lunar-orbit": 4, braking: 5, approach: 3.5, vertical: 5 }, // 55
  "moon-orbit": { ascent: 22, "parking-orbit": 4, "departure-burn": 3.5, transfer: 8, "lunar-orbit": 4.5 }, // 42
  mars: { ascent: 22.5, "parking-orbit": 4, "departure-burn": 3.5, transfer: 9, entry: 8, parachute: 5, approach: 5, vertical: 8 }, // 65
  "mars-orbit": { ascent: 22.5, "parking-orbit": 4, "departure-burn": 3.5, transfer: 9, "mars-orbit": 5 }, // 44
  failed: { ascent: 23, "parking-orbit": 4, "departure-burn": 3.5, transfer: 6, coast: 9.5 }, // 40 (46 with a Moon pass)
  lost: { ascent: 35 },
};
const FAILED_ASCENT_S = 35; // a flight that never reaches orbit is all ascent
// The real-time windows and the ramps out of them set a floor per segment (about 3.9 s for the parking orbit,
// 3.3 s for the departure burn, 7.9 s for a Moon transfer, 3.6 s for a lunar orbit ending in a descent, 5 s for
// the vertical descent, 16-20 s for an ascent); the shares sit above it.

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
const num = (v) => Math.round(v).toLocaleString("en-US");
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
// Latitude / longitude of an Earth-centred position (no rotation: the frame is Earth-fixed at launch).
const latLon = (p) => ({ lat_deg: round((Math.asin(p[2] / len(p)) * 180) / Math.PI, 3), lon_deg: round((Math.atan2(p[1], p[0]) * 180) / Math.PI, 3) });

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
    if (done(pn, vn, t + h)) {
      let lo = 0;
      let hi = h;
      for (let k = 0; k < 50; k++) {
        const m = (lo + hi) / 2;
        const [pm, vm] = step(p, v, m);
        if (done(pm, vm, t + m)) hi = m;
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

// A prograde (sign 1) or retrograde (-1) burn under Earth's gravity (RK4, steps of at most 1 s): thrust F_N, mass
// flow mdot, for T seconds.
function burnArc(p0, v0, m0, F_N, mdot, T, sign = 1) {
  const f = (p, v, m) => [v, add(mul(p, -MU.earth / len(p) ** 3), mul(unit(v), (sign * F_N) / m / 1000))];
  const n = Math.max(1, Math.ceil(T));
  const h = T / n;
  const out = [{ t: 0, p: p0, v: v0, m: m0 }];
  let p = p0;
  let v = v0;
  for (let i = 0; i < n; i++) {
    const m = m0 - mdot * h * i;
    const [k1p, k1v] = f(p, v, m);
    const [k2p, k2v] = f(add(p, mul(k1p, h / 2)), add(v, mul(k1v, h / 2)), m - (mdot * h) / 2);
    const [k3p, k3v] = f(add(p, mul(k2p, h / 2)), add(v, mul(k2v, h / 2)), m - (mdot * h) / 2);
    const [k4p, k4v] = f(add(p, mul(k3p, h)), add(v, mul(k3v, h)), m - mdot * h);
    p = add(p, mul(add(add(k1p, mul(k2p, 2)), add(mul(k3p, 2), k4p)), h / 6));
    v = add(v, mul(add(add(k1v, mul(k2v, 2)), add(mul(k3v, 2), k4v)), h / 6));
    out.push({ t: h * (i + 1), p, v, m: m - mdot * h });
  }
  return out;
}
// Orbit from a state (vis-viva): bound or not, apogee / perigee radius, period, hyperbolic excess speed.
function elements(p, v, mu) {
  const energy = dot(v, v) / 2 - mu / len(p);
  const h = len(cross(p, v));
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const bound = energy < 0;
  const a = bound ? -mu / (2 * energy) : Infinity;
  return { bound, e, apogee: bound ? a * (1 + e) : Infinity, perigee: (h * h) / (mu * (1 + e)), period: bound ? 2 * Math.PI * Math.sqrt(a ** 3 / mu) : Infinity, vInf: bound ? 0 : Math.sqrt(2 * energy) };
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
  if (s.outcome === "blocked") {
    const line = `Pad abort · ${s.reason}`;
    return { blocked: true, outcome: "blocked", reason: s.reason, endState: { type: "aborted", line, text: line }, est: true };
  }
  const arrival = arrivalTimeline(build, catalog, s);
  const payload = catalog.payloads.find((p) => p.id === build.payloadId) ?? null;
  const mission = catalog.missions.find((m) => m.id === build.missionId);
  const leo = catalog.missions.find((m) => m.id === "leo");
  const inc = (id) => {
    const m = catalog.missions.find((x) => x.id === id);
    return m && leo ? Math.max(0, m.requiredDeltaV_ms - leo.requiredDeltaV_ms) / 1000 : 0; // km/s beyond LEO
  };
  const need = mission ? inc(mission.id) : 0;
  // the departure burn's part of it: all of it, except lunar orbit's insertion (lunar-orbit = moon-transfer + LOI)
  const departure = mission?.id === "lunar-orbit" ? inc("moon-transfer") : need;
  const AS = ascent.samples;
  const AE = ascent.events;
  const inOrbit = s.remainingDeltaV_ms != null;
  const kind = arrival.body; // the mission's destination

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
  const lastA = AS.at(-1);
  // where a lost flight comes down: within 1 km of the pad "ground", else "sea" (the Cape launches east over the
  // Atlantic; there is no coastline data, so a far impact is called sea too: a default for the director, est.)
  const impact = { downrange_km: round(lastA.downrange_m / 1000, 1), ...latLon(rHat(lastA.downrange_m / 1000 / R.earth)), surface: lastA.downrange_m >= 1000 ? "sea" : "ground" };
  pieces.push({ name: "ascent", body: "earth", t0: 0, t1: tEndAscent, fn: ascentState });
  const liftoff = AE.find((e) => e.type === "liftoff");
  win(0, (liftoff?.t ?? 0) + 3);
  for (const e of AE) {
    if (e.t > tEndAscent + 1e-6) continue;
    ev(e.type, e.t, { body: "earth", stage: e.stage, ...(e.type === "impact" ? impact : {}) });
    if (e.type === "maxq") win(e.t - 0.5, e.t + 0.5);
    if (e.type === "fairing") {
      win(e.t - 0.2, e.t + 0.8);
      stageDrops.push(dropAway("fairing", e.stage, e.t, ascentState(e.t), [1, 0.2, 0], { part: "fairing", halves: 2, note: "the other half mirrors x" }));
    }
    if (e.type === "meco") win(e.t - 0.3, e.t + 2.3); // MECO, separation (+1 s), upper-stage ignition (+2 s)
    if (e.type === "sep") stageDrops.push(dropAway("sep", e.stage, e.t, ascentState(e.t), undefined, { part: "stage" }));
    if (e.type === "seco") win(e.t - 0.5, e.t + 0.5);
  }

  const bodies = { earth: { radius_km: R.earth, pos_km: [0, 0, 0] } };
  let bodyPos = (body) => (body === "earth" ? [0, 0, 0] : null);
  let endState;
  let shareKey = "lost";
  const upper = AS.at(-1).stage;
  const fullMass = AS.at(-1).mass_kg;
  const payloadMass = payload?.mass_kg ?? fullMass;
  const shortBy = Math.round(arrival.shortBy_ms ?? 0);
  const end = (type, line, extra = {}) => ({ type, line, text: line, ...extra });

  if (!inOrbit) {
    // never in orbit: the ascent samples already run through the fall (re-entry heating in `heat`) to the ground
    if (!liftoff) endState = end("aborted", "Pad abort · thrust never beat weight; the hold-downs stayed shut (est.)");
    else {
      const how = s.outcome === "shortfall" ? "Reached space but not orbital speed" : "Never reached orbital speed";
      endState = end("lost", `Lost · ${how}; fell back and came down ${impact.surface === "sea" ? `${num(impact.downrange_km)} km downrange` : "near the pad"} (est.)`, { impact });
    }
    ev("end", tEndAscent, { body: "earth" });
  } else {
    // circular orbit at the SECO radius, in the launch plane
    const endA = ascentState(tEndAscent);
    const th0 = planeAngle(endA.pos);
    const r0 = len(endA.pos);
    const vc = Math.sqrt(MU.earth / r0);
    const om = vc / r0;
    const period = (2 * Math.PI) / om;
    const thAt = (t) => th0 + om * (t - tEndAscent);
    const orbitState = (tRelease) => (t) => ({
      body: "earth",
      pos: mul(rHat(thAt(t)), r0),
      vel: mul(tHat(thAt(t)), vc),
      axis: tHat(thAt(t)),
      throttle: 0,
      stageIndex: t < tRelease ? upper : null,
      mass_kg: t < tRelease ? fullMass : payloadMass,
      phase: "orbit",
    });

    // the upper stage: vacuum thrust and mass flow (engines.json), its propellant left at SECO (from the
    // remaining delta-v, rocket equation) and its mass without the payload
    const stg = build.stages[upper];
    const eng = catalog.engines.find((e) => e.id === stg?.engineId);
    const F = (stg?.engineCount ?? 0) * (eng?.thrustVac_kN ?? 0) * 1000; // N
    const ve = (eng?.ispVac_s ?? 0) * G0; // m/s
    const mdot = ve > 0 ? F / ve : 0;
    const propSeco = ve > 0 ? fullMass * (1 - Math.exp(-s.remainingDeltaV_ms / ve)) : 0;
    const stageOnly = fullMass - (payload?.mass_kg ?? 0);
    // Earth missions follow the stage home: after the payload leaves, the vehicle in view is the stage
    const stageOrbit = (tRelease) => (t) => ({ ...orbitState(Infinity)(t), stageIndex: upper, mass_kg: t < tRelease ? fullMass : stageOnly });

    // ---- the rocket comes home (round 20): a retrograde de-orbit burn to a 50 km perigee, paid from the
    // propellant left (else a modelled 100 m/s, est.); a Kepler coast to the 120 km entry interface; then the
    // booster model (ascent.js returnFromSpace): entry burn, landing burn, touchdown.
    function returnPlan(tD, pD, vD, mStage, propLeft) {
      const v0 = len(vD);
      const perigeeAfter = (dv) => elements(pD, mul(vD, 1 - dv / v0), MU.earth).perigee;
      let lo = 0;
      let hi = v0;
      for (let k = 0; k < 60; k++) {
        const m = (lo + hi) / 2;
        if (perigeeAfter(m) > R.earth + DEORBIT_PERIGEE_ALT) lo = m;
        else hi = m;
      }
      const need = hi;
      const avail = ve > 0 && propLeft > 0 && mStage > propLeft ? (ve / 1000) * Math.log(mStage / (mStage - propLeft)) : 0;
      const modelled = avail < need;
      const dvB = modelled ? Math.max(MODELLED_DEORBIT, need) : need;
      const used = modelled ? 0 : mStage * (1 - Math.exp(-(dvB * 1000) / ve));
      const T = Math.max(1e-3, modelled ? (dvB * 1000 * mStage) / Math.max(1, F) : used / mdot);
      const burn = burnArc(pD, vD, mStage, F, modelled ? 0 : mdot, T, -1).map((x) => ({ ...x, t: x.t + tD }));
      const tB = burn.at(-1).t;
      const down = coast(burn.at(-1).p, burn.at(-1).v, MU.earth, (p) => len(p) <= R.earth + ENTRY_INTERFACE_ALT, 2 * 86400).map((x) => ({ ...x, t: x.t + tB }));
      const pE = down.at(-1).p;
      const vE = down.at(-1).v;
      const thE = planeAngle(pE);
      const ret = returnFromSpace(build, catalog, upper, { x: 0, y: len(pE) * 1000, vx: dot(vE, tHat(thE)) * 1000, vy: dot(vE, rHat(thE)) * 1000 }, propLeft - used);
      const ahead = (((thE - planeAngle(pD)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); // entry point past the de-orbit point
      return { tD, need, modelled, dvB, burn, tB, down, tE: down.at(-1).t, thE, ret, mStage: mStage - used, thLand: ahead + ret.landingX_m / 1000 / R.earth };
    }
    // the plan's pieces, events and ending
    function landHome(plan, site, missionLine) {
      const { burn, down, ret, tE, thE } = plan;
      pieces.push({
        name: "deorbit-burn",
        body: "earth",
        t0: plan.tD,
        t1: plan.tB,
        fn: (t) => {
          const { p, v } = hermite(burn, t);
          const [i, j, u] = bracket(burn, t, "t");
          return { body: "earth", pos: p, vel: v, axis: mul(unit(v), -1), throttle: 1, burn: "deorbit", stageIndex: upper, mass_kg: lerp(burn[i].m, burn[j].m, u), phase: "deorbit-burn" };
        },
      });
      ev("deorbit-burn", plan.tD, { body: "earth", stage: upper, dv_ms: Math.round(plan.dvB * 1000), modelled: plan.modelled });
      win(plan.tD - 0.5, plan.tD + 0.5);
      win(plan.tB - 0.5, plan.tB + 0.5);
      pieces.push({
        name: "deorbit-coast",
        body: "earth",
        t0: plan.tB,
        t1: tE,
        fn: (t) => {
          const { p, v } = hermite(down, t);
          return { body: "earth", pos: p, vel: v, axis: mul(unit(v), -1), throttle: 0, stageIndex: upper, mass_kg: plan.mStage, phase: "deorbit-coast" };
        },
        coast: true,
      });
      ev("entry-interface", tE, { body: "earth", alt_km: ENTRY_INTERFACE_ALT });
      // booster samples (2-D, from the entry point) -> Earth-centred states; velocity from the track
      const RS = ret.samples.map((x) => ({ ...x, t: x.t + tE }));
      const posAt = (t) => {
        const [i, j, u] = bracket(RS, t, "t");
        const th = thE + lerp(RS[i].x_m, RS[j].x_m, u) / 1000 / R.earth;
        return { pos: mul(rHat(th), R.earth + lerp(RS[i].alt_m, RS[j].alt_m, u) / 1000), a: RS[i], b: RS[j], u };
      };
      const evAt = (type) => ret.events.find((e) => e.type === type);
      const tLand = tE + (evAt("landing-burn")?.t ?? ret.samples.at(-1).t);
      const tDown = RS.at(-1).t;
      const homeState = (t) => {
        const { pos, a, b, u } = posAt(t);
        const t1 = Math.max(tE, t - 0.5);
        const t2 = Math.min(tDown, t + 0.5);
        const vel = t2 > t1 ? mul(sub(posAt(t2).pos, posAt(t1).pos), 1 / (t2 - t1)) : [0, 0, 0];
        const throttle = lerp(a.throttle, b.throttle, u);
        // engines first through the air (nose against the flow); upright once it has nearly stopped
        const axis = len(vel) > 0.0005 ? mul(unit(vel), -1) : unit(pos);
        return { body: "earth", pos, vel, axis, throttle, burn: throttle > 0 ? (t < tLand ? "entry" : "landing") : null, stageIndex: upper, mass_kg: plan.mStage, heat: lerp(a.heat, b.heat, u), phase: t >= tDown ? "touchdown" : t < tLand ? "reentry" : "landing" };
      };
      pieces.push({ name: "reentry", body: "earth", t0: tE, t1: tLand, fn: homeState });
      pieces.push({ name: "landing", body: "earth", t0: tLand, t1: tDown, fn: homeState });
      for (const e of ret.events) {
        const type = { entry: "entry-burn", lost: "touchdown" }[e.type] ?? e.type;
        ev(type, tE + e.t, { body: "earth", stage: upper, ...(e.phase ? { phase: e.phase } : {}), ...(type === "touchdown" ? { site, speed_ms: round(ret.touchdownSpeed_ms, 2) } : {}) });
        if (type === "entry-burn" || type === "landing-burn") win(tE + e.t - 0.5, tE + e.t + 0.5);
      }
      win(tDown - 3, tDown);
      const thPad = wrap(thE + ret.landingX_m / 1000 / R.earth); // the touchdown's angle from the Cape, along the track
      const legs = Boolean(catalog.visuals?.tanks?.[stg?.tankId]?.features?.includes("landing-legs"));
      const touch = posAt(tDown).pos;
      const landing = {
        site,
        downrange_km: round(Math.abs(thPad) * R.earth, 1), // from the Cape, along the launch track
        ...latLon(touch),
        pos_eci_km: r3(touch),
        touchdown_ms: round(ret.touchdownSpeed_ms, 2),
        legs,
        touchdown: legs ? "legs" : "propulsive",
        deorbit_ms: Math.round(plan.dvB * 1000),
        modelled: ["return timed to the recovery zone", ...(plan.modelled ? ["de-orbit delta-v"] : []), ...ret.modelled],
      };
      endState = end("landed", "Landed back on Earth · est.", { body: "earth", missionLine, landing });
      ev("end", tDown, { body: "earth" });
    }

    // Earth escape that makes it: the spacecraft leaves the parking orbit on its own escape burn (not flown: its
    // own propulsion) while the stage comes home like a LEO flight (round 20: every successful flight lands)
    const ownEscape = arrival.success && mission?.id === "earth-escape";
    if (!(need > 0) || ownEscape) {
      // LEO: release the payload, then the stage comes home, its de-orbit timed so it touches down on the pad
      shareKey = "earth";
      const release = AE.find((e) => e.type === "payload-release");
      const tRel = release?.t ?? tEndAscent;
      const trial = returnPlan(0, mul(rHat(0), r0), mul(tHat(0), vc), stageOnly, propSeco);
      const lead = trial.thLand; // de-orbit point to touchdown, the same wherever the de-orbit starts
      const thD = 2 * Math.PI * Math.ceil((thAt(tRel + 60) + lead) / (2 * Math.PI)) - lead;
      const tD = tEndAscent + (thD - th0) / om;
      pieces.push({ name: "orbit", body: "earth", t0: tEndAscent, t1: tD, fn: stageOrbit(tRel), coast: true });
      if (release) {
        ev("payload-release", release.t, { body: "earth", stage: upper });
        win(release.t - 0.5, release.t + 1.5);
        stageDrops.push(dropAway("payload-release", upper, release.t, stageOrbit(tRel)(release.t), PAYLOAD_OFF, { part: "payload" }));
        if (ownEscape) ev("spacecraft-departure", release.t + 1, { body: "earth", dv_ms: Math.round(departure * 1000), note: "the spacecraft's own escape burn (est.; not flown)" });
      }
      const plan = returnPlan(tD, mul(rHat(thD), r0), mul(tHat(thD), vc), stageOnly, propSeco);
      landHome(plan, "pad", arrival.lines.at(-1));
    } else {
      // a third of a parking orbit, then the upper stage's departure burn (prograde, its own thrust and mass flow)
      // until it has given the mission's departure delta-v or its propellant is gone
      const remaining = s.remainingDeltaV_ms / 1000;
      const depleted = remaining + 1e-6 < departure;
      const burnDv = Math.min(remaining, departure);
      const mCut = ve > 0 ? fullMass * Math.exp(-(burnDv * 1000) / ve) : fullMass;
      const burnT = mdot > 0 ? (fullMass - mCut) / mdot : 0;
      const burnFrom = (thDep, t0) => {
        const p0 = mul(rHat(thDep), r0);
        const v0 = mul(tHat(thDep), vc);
        return burnT >= 1 ? burnArc(p0, v0, fullMass, F, mdot, burnT).map((x) => ({ ...x, t: x.t + t0 })) : [{ t: t0, p: p0, v: v0, m: fullMass }];
      };
      const toApogee = (b) => coast(b.at(-1).p, b.at(-1).v, MU.earth, (p, v, t) => t > 60 && dot(p, v) < 0, 30 * 86400).map((x) => ({ ...x, t: x.t + b.at(-1).t }));
      const homeMass = mCut - (payload?.mass_kg ?? 0);
      const homeProp = propSeco - (fullMass - mCut);
      // a third of a parking orbit; a GTO stage that comes home waits instead for the departure point that puts
      // its touchdown on the drone ship 600 km down the launch track (the return timed to the recovery zone, est.;
      // the angle from departure to touchdown is the same wherever the departure is, so one trial run finds it)
      let thDep = thAt(tEndAscent + period / 3);
      if (arrival.success && mission.id === "gto") {
        const b = burnFrom(0, 0);
        const a = toApogee(b);
        const plan = returnPlan(0, a.at(-1).p, a.at(-1).v, homeMass, homeProp);
        const lead = ((planeAngle(a.at(-1).p) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) + plan.thLand;
        const thMin = thAt(tEndAscent + period / 10);
        const target = DRONE_SHIP_KM / R.earth - lead;
        thDep = target + 2 * Math.PI * Math.ceil((thMin - target) / (2 * Math.PI));
      }
      const tDep = tEndAscent + (thDep - th0) / om;
      pieces.push({ name: "parking-orbit", body: "earth", t0: tEndAscent, t1: tDep, fn: orbitState(Infinity), coast: true });
      const burn = burnFrom(thDep, tDep);
      const tCut = burn.at(-1).t;
      const pCut = burn.at(-1).p;
      const vCut = burn.at(-1).v;
      ev("departure-burn", tDep, { body: "earth", stage: upper, dv_ms: Math.round(burnDv * 1000), duration_s: round(burnT, 1) });
      win(tDep - 0.5, tDep + 0.5);
      ev(depleted ? "propellant-depleted" : "departure-cutoff", tCut, { body: "earth", stage: upper, dv_ms: Math.round(burnDv * 1000) });
      win(tCut - 0.5, tCut + 0.5);
      if (burnT >= 1) {
        pieces.push({
          name: "departure-burn",
          body: "earth",
          t0: tDep,
          t1: tCut,
          fn: (t) => {
            const { p, v } = hermite(burn, t);
            const [i, j, u] = bracket(burn, t, "t");
            return { body: "earth", pos: p, vel: v, axis: unit(v), throttle: 1, burn: "departure", stageIndex: upper, mass_kg: lerp(burn[i].m, burn[j].m, u), phase: "departure-burn" };
          },
        });
      }
      // the spacecraft leaves the spent stage 30 s after cutoff
      const tSep = tCut + 30;
      // Earth missions follow the stage home; the others follow the spacecraft
      const homeBound = arrival.success && arrival.body === "earth";
      const craft = (t) => (homeBound ? { stageIndex: upper, mass_kg: t < tSep ? mCut : mCut - (payload?.mass_kg ?? 0) } : { stageIndex: t < tSep ? upper : null, mass_kg: t < tSep ? mCut : payloadMass });
      ev("spacecraft-sep", tSep, { body: "space", stage: upper });
      win(tSep - 0.3, tSep + 0.7);
      const el = elements(pCut, vCut, MU.earth);
      const orbitOut = { apogee_km: Number.isFinite(el.apogee) ? round(el.apogee - R.earth, 0) : null, perigee_km: round(el.perigee - R.earth, 0), period_s: Number.isFinite(el.period) ? round(el.period, 0) : null };
      const coastPiece = (name, arc, extra = () => ({})) => (t) => {
        const { p, v } = hermite(arc, t);
        return { body: "space", pos: p, vel: v, axis: unit(v), throttle: 0, ...craft(t), phase: name, ...extra(t, p, v) };
      };
      const arcFrom = (done, tMax) => coast(pCut, vCut, MU.earth, done, tMax).map((x) => ({ ...x, t: x.t + tCut }));
      // the coast of a failed transfer: once around (out to apogee and back) when bound, else out to `far` km
      const failedCoast = (far) => {
        const arc = el.bound && el.period < 60 * 86400 ? arcFrom(() => false, el.period) : arcFrom((p) => len(p) >= far, 30 * 86400);
        const iTop = arc.reduce((k, x, i) => (len(x.p) > len(arc[k].p) ? i : k), 0);
        if (el.bound && iTop > 0 && iTop < arc.length - 1) ev("apogee", arc[iTop].t, { body: "space", apogee_km: orbitOut.apogee_km });
        pieces.push({ name: "coast", body: "space", t0: tCut, t1: arc.at(-1).t, fn: coastPiece("coast", arc), coast: true });
        return arc.at(-1).t;
      };
      const fail = (line, tEnd) => {
        shareKey = "failed";
        endState = end("transfer-failed", line, { body: arrival.body, shortBy_ms: shortBy, ...orbitOut });
        ev("end", tEnd, { body: "space" });
      };
      const apo = orbitOut.apogee_km == null ? "escapes Earth" : `apogee ${num(orbitOut.apogee_km)} km`;
      const omM = (2 * Math.PI) / MOON_PERIOD_S;
      const placeMoon = (alpha, tAt) => {
        const moonPos = (t) => mul(rHat(alpha + omM * (t - tAt)), MOON_DIST);
        const moonVel = (t) => mul(tHat(alpha + omM * (t - tAt)), MOON_DIST * omM);
        bodies.moon = { radius_km: R.moon, distance_km: MOON_DIST, period_days: MOON_PERIOD_DAYS, pos_km_at_arrival: r3(moonPos(tAt)) };
        bodyPos = (body, t) => (body === "earth" ? [0, 0, 0] : body === "moon" ? moonPos(t) : null);
        return { moonPos, moonVel };
      };
      const rLo = R.moon + LUNAR_ORBIT_ALT;
      const rArr = MOON_DIST - rLo;

      if (arrival.body === "earth") {
        if (arrival.success) {
          // GTO: the stage coasts out to the transfer orbit's apogee with the payload gone, de-orbits there and
          // comes down where its arc ends (a drone ship)
          shareKey = "gto";
          const arc = toApogee(burn);
          pieces.push({ name: "transfer", body: "space", t0: tCut, t1: arc.at(-1).t, fn: coastPiece("transfer", arc), coast: true });
          ev("apogee", arc.at(-1).t, { body: "space", apogee_km: orbitOut.apogee_km });
          const plan = returnPlan(arc.at(-1).t, arc.at(-1).p, arc.at(-1).v, homeMass, homeProp);
          landHome(plan, "drone-ship", `${arrival.lines.at(-1)} Apogee ${num(orbitOut.apogee_km)} km (est.).`);
        } else {
          const geo = mission.id === "gto" && el.apogee < GEO_R ? ` (GEO is ${num(GEO_R - R_EQ)} km)` : "";
          fail(`Transfer failed · short by ${num(shortBy)} m/s · ${apo}${geo} · falls back toward Earth (est.)`, failedCoast(ESCAPE_SHOW_KM));
        }
      } else if (arrival.body === "moon") {
        if (!arrival.success && depleted) {
          // the Moon stays where a full departure burn would have met it
          const nominal = coast(mul(rHat(thDep), r0), mul(tHat(thDep), vc + departure), MU.earth, (p) => len(p) >= rArr, 30 * 86400);
          placeMoon(planeAngle(nominal.at(-1).p), tDep + nominal.at(-1).t);
          const tail = el.apogee < MOON_DIST ? "falls back toward Earth" : "misses the Moon";
          fail(`Transfer failed · short by ${num(shortBy)} m/s · ${apo} · ${tail} (est.)`, failedCoast(2 * MOON_DIST));
        } else if (!arrival.success) {
          // departure complete, insertion short (lunar orbit): it crosses the Moon's orbit just ahead of the Moon
          // and flies on (the Moon's own gravity is not modelled)
          const arc = arcFrom((p) => len(p) >= 1.5 * MOON_DIST, 30 * 86400);
          const k = arc.findIndex((x) => len(x.p) >= MOON_DIST);
          const tX = arc[k].t;
          const { moonPos } = placeMoon(planeAngle(arc[k].p) + (R.moon + FLYBY_ALT) / MOON_DIST, tX);
          pieces.push({ name: "transfer", body: "space", t0: tCut, t1: tX, fn: coastPiece("transfer", arc), coast: true });
          pieces.push({ name: "coast", body: "space", t0: tX, t1: arc.at(-1).t, fn: coastPiece("coast", arc), coast: true });
          ev("moon-flyby", tX, { body: "space", distance_km: Math.round(len(sub(arc[k].p, moonPos(tX))) - R.moon) });
          fail(`Transfer failed · short by ${num(shortBy)} m/s for lunar orbit insertion · flies past the Moon (est.)`, arc.at(-1).t);
        } else {
          shareKey = arrival.lands ? "moon" : "moon-orbit";
          const arc = arcFrom((p) => len(p) >= rArr, 30 * 86400);
          const tArr = arc.at(-1).t;
          const alpha = planeAngle(arc.at(-1).p);
          const { moonPos, moonVel } = placeMoon(alpha, tArr);
          pieces.push({ name: "transfer", body: "space", t0: tCut, t1: tArr, fn: coastPiece("transfer", arc, (t) => (Math.abs(t - tArr) <= BURN_CUE_S ? { throttle: 1, burn: "insertion" } : {})), coast: true });
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
            const b = Math.abs(t - tArr) <= BURN_CUE_S ? "insertion" : null;
            return { body: "moon", pos: rel, posEci: add(moonPos(t), rel), vel: relV, velEci: add(relV, moonVel(t)), axis: mul(unit(relV), -1), throttle: b ? 1 : 0, burn: b, stageIndex: null, mass_kg: payloadMass, phase: "lunar-orbit" };
          };
          pieces.push({ name: "lunar-orbit", body: "moon", t0: tArr, t1: tPdi, fn: loState, coast: true });
          if (arrival.lands) {
            const tEnd = addDescent(descentTimeline(payload, { body: "moon" }), "moon", tPdi, Math.PI / 2, u1, u2, moonPos, moonVel);
            endState = end("landed", arrival.lines.at(-1), { body: "moon" });
            ev("end", tEnd, { body: "moon" });
          } else {
            endState = end("in-orbit-of", arrival.lines.at(-1), { body: "moon" });
            ev("end", tPdi, { body: "moon" });
          }
        }
      } else {
        // Mars: a straight line along the cutoff velocity, its speed eased (the distance integrates the speed exactly);
        // Mars sits 2,000,000 km down it (not to scale)
        const dHat = unit(vCut);
        const w0 = unit(sub(pCut, mul(dHat, dot(pCut, dHat))));
        const v0 = len(vCut);
        const lineState = (vInf, vEnd, T2) => {
          const s1 = (EASE_S * (v0 + vInf)) / 2;
          const along = (t) => {
            const x = t - tCut;
            if (x <= EASE_S) {
              const u = x / EASE_S;
              return { s: EASE_S * (v0 * u + (vInf - v0) * (u ** 3 - u ** 4 / 2)), v: lerp(v0, vInf, smooth(u)) };
            }
            if (x <= EASE_S + T2 || vEnd == null) return { s: s1 + vInf * (x - EASE_S), v: vInf };
            const u = Math.min(1, (x - EASE_S - T2) / EASE_S);
            return { s: s1 + vInf * T2 + EASE_S * (vInf * u + (vEnd - vInf) * (u ** 3 - u ** 4 / 2)), v: lerp(vInf, vEnd, smooth(u)) };
          };
          return (b) => (t) => {
            const { s: d, v } = along(t);
            const cue = b && Math.abs(t - b) <= BURN_CUE_S ? "insertion" : null;
            return { body: "space", pos: add(pCut, mul(dHat, d)), vel: mul(dHat, v), axis: dHat, throttle: cue ? 1 : 0, burn: cue, ...craft(t), phase: "transfer" };
          };
        };
        const vInfFull = Math.sqrt(Math.max(0.01, (vc + departure) ** 2 - (2 * MU.earth) / r0));
        const placeMars = (gamDeg, rEnd) => {
          const gam = gamDeg * rad;
          const up = add(mul(dHat, Math.sin(gam)), mul(w0, Math.cos(gam)));
          const marsC = sub(add(pCut, mul(dHat, MARS_LINE_KM)), mul(up, rEnd));
          bodies.mars = { radius_km: R.mars, pos_km: r3(marsC), scaled: true, note: "placed 2,000,000 km down the departure line: not to scale" };
          bodyPos = (body) => (body === "earth" ? [0, 0, 0] : body === "mars" ? marsC : null);
          return { up, marsC };
        };
        if (!arrival.success) {
          placeMars(0, R.mars + MARS_ORBIT_ALT);
          if (el.bound) fail(`Transfer failed · missed Mars by ${num(shortBy)} m/s · ${apo} · falls back toward Earth (est.)`, failedCoast(2 * MOON_DIST));
          else {
            // escaped Earth too slowly: the line stops short in proportion to the hyperbolic excess speed
            const L = MARS_LINE_KM * Math.min(1, el.vInf / vInfFull);
            const s1 = (EASE_S * (v0 + el.vInf)) / 2;
            const tEnd = tCut + EASE_S * Math.min(1, L / s1) + Math.max(0, (L - s1) / el.vInf);
            pieces.push({ name: "coast", body: "space", t0: tCut, t1: tEnd, fn: lineState(el.vInf, null, Infinity)(null), coast: true });
            fail(`Transfer failed · missed Mars by ${num(shortBy)} m/s · adrift in space (est.)`, tEnd);
          }
        } else {
          shareKey = arrival.lands ? "mars" : "mars-orbit";
          const vInf = Math.sqrt(Math.max(0.01, v0 * v0 - (2 * MU.earth) / len(pCut)));
          const s1 = (EASE_S * (v0 + vInf)) / 2;
          const s3 = (EASE_S * (vInf + MARS_ENTRY_SPEED)) / 2;
          const T2 = Math.max(3600, (MARS_LINE_KM - s1 - s3) / vInf);
          const tEi = tCut + 2 * EASE_S + T2;
          const rEnd = R.mars + (arrival.lands ? MARS_ENTRY_ALT : MARS_ORBIT_ALT);
          // the line's end, s1 + vInf T2 + s3 down the line, is the entry (or insertion) point
          const Lline = s1 + vInf * T2 + s3;
          const gam = (arrival.lands ? MARS_ENTRY_GAMMA : 0) * rad;
          const up = add(mul(dHat, Math.sin(gam)), mul(w0, Math.cos(gam)));
          const marsC = sub(add(pCut, mul(dHat, Lline)), mul(up, rEnd));
          bodies.mars = { radius_km: R.mars, pos_km: r3(marsC), scaled: true, note: "placed 2,000,000 km down the departure line: not to scale" };
          bodyPos = (body) => (body === "earth" ? [0, 0, 0] : body === "mars" ? marsC : null);
          pieces.push({ name: "transfer", body: "space", t0: tCut, t1: tEi, fn: lineState(vInf, MARS_ENTRY_SPEED, T2)(arrival.lands ? null : tEi), coast: true });
          const u1 = up;
          const u2 = unit(sub(dHat, mul(u1, dot(dHat, u1))));
          if (arrival.lands) {
            ev("entry-interface", tEi, { body: "mars" });
            win(tEi - 0.5, tEi + 0.5);
            const tEnd = addDescent(descentTimeline(payload, { body: "mars" }), "mars", tEi, 0, u1, u2, () => marsC, () => [0, 0, 0]);
            endState = end("landed", arrival.lines.at(-1), { body: "mars" });
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
              const b = Math.abs(t - tEi) <= BURN_CUE_S ? "insertion" : null;
              return { body: "mars", pos: rel, posEci: add(marsC, rel), vel: relV, axis: mul(unit(relV), -1), throttle: b ? 1 : 0, burn: b, stageIndex: null, mass_kg: payloadMass, phase: "mars-orbit" };
            };
            pieces.push({ name: "mars-orbit", body: "mars", t0: tEi, t1: tEnd, fn: moState, coast: true });
            endState = end("in-orbit-of", arrival.lines.at(-1), { body: "mars" });
            ev("end", tEnd, { body: "mars" });
          }
        }
      }
      const sepState = pieces.find((p) => tSep >= p.t0 && tSep <= p.t1)?.fn(tSep) ?? ascentState(tEndAscent);
      stageDrops.push(homeBound ? dropAway("spacecraft-sep", upper, tSep, sepState, PAYLOAD_OFF, { part: "payload" }) : dropAway("spacecraft-sep", upper, tSep, sepState, undefined, { part: "stage" }));
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
  const dest = kind !== "earth" && bodies[kind] ? kind : null;
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
    // for flightSummaryText: the parking orbit (ascent.js) and the highest / fastest point of the ascent
    parking: inOrbit ? { perigee_km: round(s.perigee_km, 1), apogee_km: Number.isFinite(s.apogee_km) ? round(s.apogee_km, 1) : null, t_sim: round(tEndAscent, 1) } : null,
    peak: { alt_km: round(Math.max(...AS.map((x) => x.alt_m)) / 1000, 1), speed_ms: Math.round(Math.max(...AS.map((x) => x.vel_ms))) },
    mission: mission?.id ?? null,
    _clock: clock, // for checks
    est: true,
  };
}

// What happened, in plain words, from the timeline's own numbers (UI 3: the headline for the HUD, the sentences
// for the result card and the "assembly:report" bridge event, so the narration tells the real outcome).
//   flightSummaryText(timeline) -> { headline, sentences: [2-3 short sentences] }
// Every sentence that quotes a modelled number ends "(est.)".
const BODY_NAME = { earth: "Earth", moon: "the Moon", mars: "Mars" };
const MISSION_NAME = { leo: "Low Earth orbit", gto: "Geostationary transfer orbit", "earth-escape": "Earth escape", "moon-transfer": "Moon transfer", "lunar-orbit": "Lunar orbit", "mars-transfer": "Mars transfer" };
export const GEO_ALT_KM = Math.round(GEO_R - R_EQ);
const tPlus = (t) => `T+${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const est = (text) => `${text} (est.).`;
export function flightSummaryText(f) {
  const e = f.endState;
  const at = (type) => f.events?.find((x) => x.type === type);
  if (f.blocked || e.type === "aborted") {
    return f.blocked
      ? { headline: e.line, sentences: [`The design check stopped the launch: ${f.reason}.`, "Nothing left the pad."] }
      : { headline: "Pad abort", sentences: [est("The engines lit but their thrust never beat the rocket's weight"), "The hold-downs stayed shut and nothing left the pad."] };
  }
  const out = [];
  const p = f.parking;
  if (p) out.push(est(`Reached a ${num(p.perigee_km)} × ${p.apogee_km == null ? "escape" : num(p.apogee_km)} km parking orbit at ${tPlus(p.t_sim)}`));
  const dep = at("departure-burn");
  const dry = at("propellant-depleted");
  const apo = at("apogee");
  const days = (name) => {
    const g = f.segments.find((x) => x.name === name);
    return g ? (g.t1_sim - g.t0_sim) / 86400 : null;
  };
  const mission = MISSION_NAME[f.mission] ?? "The mission";
  if (e.type === "lost") {
    const i = e.impact;
    return {
      headline: "Lost · never reached orbit",
      sentences: [
        est(`It climbed to ${num(f.peak.alt_km)} km at up to ${num(f.peak.speed_ms)} m/s, short of orbital speed`),
        est(`It fell back through the atmosphere and came down ${i.surface === "sea" ? `${num(i.downrange_km)} km downrange` : "near the pad"}`),
      ],
    };
  }
  if (e.type === "transfer-failed") {
    const short = num(e.shortBy_ms);
    if (at("moon-flyby")) {
      out.push(est(`The departure burn added ${num(dep.dv_ms)} m/s, but ${short} m/s short of what lunar orbit insertion needs`));
      out.push(est(`It crossed the Moon's orbit ${num(at("moon-flyby").distance_km)} km from the Moon and flew on past`));
    } else if (e.apogee_km == null) {
      out.push(est(`The departure burn ran dry ${short} m/s short; it escaped Earth too slowly to reach Mars and is adrift`));
    } else {
      const goal = f.mission === "gto" ? `below the ${num(GEO_ALT_KM)} km needed` : f.kind === "moon" ? (e.apogee_km + R.earth < MOON_DIST ? `short of the Moon, ${num(MOON_DIST)} km away` : "but the Moon was not there") : f.kind === "mars" ? "far short of an escape from Earth" : "short of an escape from Earth";
      out.push(est(`The departure burn ran dry ${short} m/s short; apogee ${num(e.apogee_km)} km, ${goal}; the vehicle fell back toward Earth`));
    }
    return { headline: `Transfer failed · short by ${short} m/s`, sentences: out.slice(0, 3) };
  }
  if (e.type === "landed" && e.body === "earth") {
    const L = e.landing;
    if (f.mission === "gto") out.push(est(`The departure burn added ${num(dep.dv_ms)} m/s; apogee ${num(apo.apogee_km)} km`));
    else if (f.mission === "earth-escape") out.push(est(`The spacecraft left on its own ${num(at("spacecraft-departure").dv_ms)} m/s escape burn`));
    else if (at("payload-release")) out.push(est(`The payload was released at ${tPlus(at("payload-release").t_sim)}`));
    const where = L.site === "pad" ? "back on the pad" : `on the drone ship ${num(L.downrange_km)} km downrange`;
    out.push(est(`The stage returned and landed ${where} at ${L.touchdown_ms.toFixed(1)} m/s`));
    return { headline: `${mission} reached · landed ${L.site === "pad" ? "on the pad" : "on the drone ship"}`, sentences: out };
  }
  // Moon / Mars
  const coast = days("transfer");
  out.push(est(`The departure burn added ${num(dep.dv_ms)} m/s; the coast to ${BODY_NAME[f.kind]} took ${coast < 2 ? `${num(coast * 24)} hours` : `${coast.toFixed(1)} days`}${f.kind === "mars" ? " on a shortened, not-to-scale path" : ""}`));
  if (e.type === "in-orbit-of") {
    out.push(est(`It braked into a ${f.kind === "moon" ? num(LUNAR_ORBIT_ALT) : num(MARS_ORBIT_ALT)} km orbit of ${BODY_NAME[f.kind]} with its own engine`));
    return { headline: `In orbit of ${BODY_NAME[f.kind]}`, sentences: out };
  }
  const td = at("touchdown");
  const chute = at("chute-open");
  out.push(est(f.kind === "mars" && chute ? `It came through entry, opened its parachute at ${num(chute.vel_ms)} m/s and touched down at ${num(td.vel_ms)} m/s` : `It descended from a ${num(LUNAR_ORBIT_ALT)} km orbit and touched down at ${num(td.vel_ms)} m/s`));
  return { headline: `Landed on ${BODY_NAME[f.kind]}`, sentences: out };
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
