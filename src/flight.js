// One continuous flight: launch -> space -> (transfer) -> land, as a single timeline. Pure: no DOM; all est.
//   flightTimeline(build, catalog, opts?) -> {
//     outcome, endState, bodies, segments, events, stages, sampleAt(t_screen), screenToSim(t), simToScreen(t),
//     bodyPosAt(body, t_sim), totalScreen_s, arrival, est }
// Built on ascent.js (the ascent itself) and arrival.js (success / landing rules, powered descents). Nothing here
// adds physics beyond those and the cited constants; the stitching choices are model choices:
// - Frame: Earth-centred inertial, km, z = north pole, x toward longitude 0 at launch; Earth's rotation ignored.
//   Launch site 28.5 N, 80.6 W (Cape Canaveral), launching due east, so the ascent's 2-D plane is the plane of
//   the site's up and east directions (inclination = the site latitude).
// - Earth missions (and any build that does not leave Earth): ascent -> orbit insertion (SECO) -> a quarter of a
//   circular orbit at the achieved altitude -> end state "In orbit" (or "Stranded" when short of the mission).
// - Moon: a third of a parking orbit -> departure burn (impulsive, est.) of the mission's beyond-LEO delta-v ->
//   the resulting Keplerian arc (Earth gravity only) out to the Moon -> orbit insertion (impulsive) into a
//   circular orbit at 15 km -> a quarter orbit -> arrival.js's powered descent -> touchdown. The Moon is placed
//   where the arc reaches its mean distance (384,400 km) and moves on a circle at its revolution period.
// - Mars: departure burn as above -> a scaled straight-line cruise (2,000,000 km; the real cruise takes months;
//   NOT to scale) whose speed eases from the post-burn speed to the hyperbolic excess speed and up to the 5.5
//   km/s entry speed -> arrival.js's aeroshell entry, parachute and powered descent -> touchdown.
// - Spent stages: no flight of their own; each separation gives a detach time and a 2 s drop-away (1 m/s,
//   backward and slightly sideways in the vehicle's body frame) so the director can let them fall out of frame.
// - Screen time: a continuous time rate (screen s per sim s): 1 (real time) in windows around ignition and
//   liftoff, Max-Q, MECO/separation/upper-stage ignition, SECO, payload release, burns, chute opening and the
//   last seconds before touchdown; a per-segment base rate elsewhere, solved so each segment gets its share of
//   the total (Earth ~35 s, Moon ~55 s, Mars ~65 s); linear blends between them, so the map is C1 (no jumps in
//   the time rate).
// Constants: Earth GM as in ascent.js (WGS 84); radii, GM, the Moon's 0.3844 x 10^6 km semimajor axis and its
// 27.3217-day revolution period from NASA's planetary fact sheets
// (https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, .../marsfact.html).
import { simulateAscent } from "./ascent.js";
import { arrivalTimeline, descentTimeline, lightingFor, atmosphereFor } from "./arrival.js";

export { lightingFor, atmosphereFor };

const MU_E = 398600.4418; // km^3/s^2
const R = { earth: 6371.0, moon: 1737.4, mars: 3389.5 }; // km
const MU_M = 4900; // km^3/s^2 (0.00490 x 10^6)
const MOON_DIST = 384400; // km
const MOON_PERIOD_S = 27.3217 * 86400;
const LUNAR_ORBIT_ALT = 15; // km: the powered descent starts from a 15 km orbit (arrival.js)
const MARS_LINE_KM = 2e6; // scaled cruise length (model choice)
const MARS_ENTRY_ALT = 120; // km (arrival.js)
const MARS_ENTRY_GAMMA = (-10 * Math.PI) / 180; // (arrival.js)
const MARS_ENTRY_SPEED = 5.5; // km/s (arrival.js)
const SITE = { lat: 28.5, lon: -80.6 };
const TOTAL = { earth: 35, moon: 55, mars: 65 };
const RAMP_S = 2; // sim seconds over which the rate blends into a real-time window
const DROP = { speed_ms: 1, duration_s: 2, dir_body: normalize([0.08, -1, 0]) }; // model choice

// ---------- vector helpers ----------
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, u) => a + (b - a) * u;
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// Local frame on a body: up, east, north (north toward +z, the body's pole axis; all bodies share it here).
export function surfaceFrame(body, pos_km) {
  const up = normalize(pos_km);
  let east = cross([0, 0, 1], up);
  if (len(east) < 1e-9) east = [0, 1, 0];
  east = normalize(east);
  const north = cross(up, east);
  return { up, east, north };
}
export const altitude = (body, pos_km) => len(pos_km) - (R[body] ?? R.earth);

// ---------- the launch plane ----------
const rad = Math.PI / 180;
const U_SITE = [Math.cos(SITE.lat * rad) * Math.cos(SITE.lon * rad), Math.cos(SITE.lat * rad) * Math.sin(SITE.lon * rad), Math.sin(SITE.lat * rad)];
const E_SITE = normalize([-Math.sin(SITE.lon * rad), Math.cos(SITE.lon * rad), 0]);
const H_PLANE = normalize(cross(U_SITE, E_SITE)); // orbit normal (prograde, eastward launch)
const rHat = (th) => add(mul(U_SITE, Math.cos(th)), mul(E_SITE, Math.sin(th)));
const tHat = (th) => add(mul(U_SITE, -Math.sin(th)), mul(E_SITE, Math.cos(th)));

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

// ---------- attitude ----------
function attitude(body, pos, axis) {
  const f = surfaceFrame(body, pos);
  const pitch = (Math.acos(Math.max(-1, Math.min(1, dot(axis, f.up)))) * 180) / Math.PI;
  const yaw = (Math.atan2(dot(axis, f.east), dot(axis, f.north)) * 180) / Math.PI;
  return { pitch_deg: Math.round(pitch * 10) / 10, yaw_deg: Math.round(((yaw + 360) % 360) * 10) / 10 };
}

// ---------- screen-time map ----------
// segments: [{ name, t0, t1, budget }], windows: [[a, b]] in sim seconds.
function buildClock(segments, windows) {
  const n = segments.length;
  const B = segments.map((s) => s.t0).concat(segments[n - 1].t1);
  const span = B.map((b, i) => (i === 0 || i === n ? 0 : Math.min(0.1 * (B[i] - B[i - 1]), 0.1 * (B[i + 1] - B[i]))));
  // weight of segment k's base rate at time t (linear blends across interior boundaries)
  const weights = (t) => {
    const w = new Array(n).fill(0);
    let k = segments.findIndex((s) => t >= s.t0 && t <= s.t1);
    if (k < 0) k = t < B[0] ? 0 : n - 1;
    w[k] = 1;
    if (k > 0 && t < B[k] + span[k]) {
      const u = (t - (B[k] - span[k])) / (2 * span[k]);
      w[k] = u;
      w[k - 1] = 1 - u;
    } else if (k < n - 1 && t > B[k + 1] - span[k + 1]) {
      const u = (t - (B[k + 1] - span[k + 1])) / (2 * span[k + 1]);
      w[k] = 1 - u;
      w[k + 1] = u;
    }
    return w;
  };
  const phi = (t) => {
    let p = 0;
    for (const [a, b] of windows) {
      if (t >= a && t <= b) return 1;
      if (t < a && t > a - RAMP_S) p = Math.max(p, 1 - (a - t) / RAMP_S);
      if (t > b && t < b + RAMP_S) p = Math.max(p, 1 - (t - b) / RAMP_S);
    }
    return p;
  };
  // grid: uniform per segment + dense around windows and blends
  const pts = new Set();
  for (const s of segments) for (let i = 0; i <= 4000; i++) pts.add(s.t0 + ((s.t1 - s.t0) * i) / 4000);
  for (const [a, b] of windows) for (let t = a - RAMP_S; t <= b + RAMP_S; t += 0.05) pts.add(t);
  for (let i = 1; i < n; i++) for (let j = -50; j <= 50; j++) pts.add(B[i] + (span[i] * j) / 50);
  const grid = [...pts].filter((t) => t >= B[0] && t <= B[n]).sort((a, b) => a - b);
  const W = grid.map(weights);
  const P = grid.map(phi);
  // linear system: for each segment j, sum_k b_k A[j][k] + Phi_j = budget_j
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const Phi = new Array(n).fill(0);
  for (let i = 1; i < grid.length; i++) {
    const dt = grid[i] - grid[i - 1];
    const tm = (grid[i] + grid[i - 1]) / 2;
    let j = segments.findIndex((s) => tm >= s.t0 && tm <= s.t1);
    if (j < 0) j = n - 1;
    for (let k = 0; k < n; k++) A[j][k] += ((W[i][k] * (1 - P[i]) + W[i - 1][k] * (1 - P[i - 1])) / 2) * dt;
    Phi[j] += ((P[i] + P[i - 1]) / 2) * dt;
  }
  const rhs = segments.map((s, j) => s.budget - Phi[j]);
  const b = solve(A, rhs).map((x, k) => (x > 0 ? x : 1e-6 * segments[k].budget / Math.max(1, segments[k].t1 - segments[k].t0)));
  const rate = (i) => W[i].reduce((s, w, k) => s + w * b[k], 0) * (1 - P[i]) + P[i];
  const screen = new Float64Array(grid.length);
  for (let i = 1; i < grid.length; i++) screen[i] = screen[i - 1] + ((rate(i) + rate(i - 1)) / 2) * (grid[i] - grid[i - 1]);
  const sim = Float64Array.from(grid);
  const interp = (xs, ys, x) => {
    if (x <= xs[0]) return ys[0];
    const last = xs.length - 1;
    if (x >= xs[last]) return ys[last];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo] || 1);
  };
  return {
    simToScreen: (t) => interp(sim, screen, t),
    screenToSim: (s) => interp(screen, sim, s),
    total: screen[screen.length - 1],
    rates: Array.from({ length: grid.length }, (_, i) => rate(i)),
    grid: sim,
    screen,
  };
}

function solve(A, y) {
  const n = y.length;
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// ---------- the timeline ----------
export function flightTimeline(build, catalog, opts = {}) {
  const ascent = opts.ascent ?? simulateAscent(build, catalog);
  const s = ascent.summary;
  if (s.outcome === "blocked") return { blocked: true, reason: s.reason, outcome: "blocked", endState: { type: "pad-abort", text: `Pad abort · ${s.reason}` }, est: true };
  const arrival = arrivalTimeline(build, catalog, s);
  const payload = catalog.payloads.find((p) => p.id === build.payloadId) ?? null;
  const AS = ascent.samples;
  const AE = ascent.events;
  const seco = AE.find((e) => e.type === "seco");
  const inOrbit = s.remainingDeltaV_ms != null;
  const goes = inOrbit && arrival.success && arrival.body !== "earth";
  const kind = goes ? arrival.body : "earth";
  const mission = catalog.missions.find((m) => m.id === build.missionId);
  const leo = catalog.missions.find((m) => m.id === "leo");
  const dv_kms = mission && leo ? Math.max(0, mission.requiredDeltaV_ms - leo.requiredDeltaV_ms) / 1000 : 0;

  // --- ascent state from the samples
  const ascentState = (t) => {
    const [i, j, u] = bracket(AS, t, "t");
    const a = AS[i];
    const b = AS[j];
    const alt = lerp(a.alt_m, b.alt_m, u) / 1000;
    const th = lerp(a.downrange_m, b.downrange_m, u) / 1000 / R.earth;
    const gam = lerp(a.gamma_deg, b.gamma_deg, u) * rad;
    const v = lerp(a.vel_ms, b.vel_ms, u) / 1000;
    const pos = mul(rHat(th), R.earth + alt);
    const vel = add(mul(tHat(th), v * Math.cos(gam)), mul(rHat(th), v * Math.sin(gam)));
    return {
      body: "earth",
      pos,
      vel,
      axis: v > 0.001 ? normalize(vel) : rHat(th),
      throttle: lerp(a.throttle, b.throttle, u),
      stageIndex: a.stage,
      mass_kg: lerp(a.mass_kg, b.mass_kg, u),
      heat: lerp(a.heat ?? 0, b.heat ?? 0, u),
      chute: 0,
      dust: 0,
      phase: "ascent",
    };
  };

  const tEndAscent = AS.at(-1).t;
  const segments = [];
  const windows = [];
  const events = [];
  const stages = [];
  const ev = (type, t, extra = {}) => events.push({ type, t_sim: t, ...extra });
  // ascent events (main vehicle)
  for (const e of AE) if (e.t <= tEndAscent + 1e-6 || e.type === "payload-release") ev(e.type, e.t, { body: "earth", stage: e.stage });
  const w = (a, b) => windows.push([a, b]);
  w(0, 3);
  for (const e of AE) {
    if (e.type === "maxq") w(e.t - 1, e.t + 1);
    if (e.type === "meco") w(e.t - 0.5, e.t + 2.5);
    if (e.type === "seco") w(e.t - 1, e.t + 1);
  }
  for (const e of AE.filter((x) => x.type === "sep")) {
    const st = ascentState(e.t);
    stages.push(dropAway(e.stage, e.t, st));
  }

  const stateFns = []; // [{ t0, t1, fn }]
  const lastAscent = ascentState(tEndAscent);
  segments.push({ name: "ascent", body: "earth", t0: 0, t1: tEndAscent });
  stateFns.push({ t0: 0, t1: tEndAscent, fn: ascentState });

  let endState;
  let bodies = { earth: { radius_km: R.earth, pos_km: [0, 0, 0] } };
  let bodyPosAt = (body) => (body === "earth" ? [0, 0, 0] : null);
  let tEnd = tEndAscent;

  if (!inOrbit || !seco) {
    // suborbital / impact: the ascent samples already run to the end
    endState = { type: s.outcome === "shortfall" ? "fell-back" : "impact", text: arrival.lines[0] ?? "Did not reach orbit (est.)" };
  } else {
    // circular orbit at the achieved altitude, from SECO
    const th0 = lastAscent.pos ? Math.atan2(dot(lastAscent.pos, E_SITE), dot(lastAscent.pos, U_SITE)) : 0;
    const r0 = len(lastAscent.pos);
    const vc = Math.sqrt(MU_E / r0);
    const T = (2 * Math.PI * r0) / vc;
    const om = vc / r0;
    const orbitState = (t) => {
      const th = th0 + om * (t - tEndAscent);
      return { ...lastAscent, body: "earth", pos: mul(rHat(th), r0), vel: mul(tHat(th), vc), axis: tHat(th), throttle: 0, heat: 0, phase: "orbit" };
    };
    const release = AE.find((e) => e.type === "payload-release");
    if (release) w(release.t, release.t + 1);

    if (kind === "earth") {
      tEnd = tEndAscent + T / 4;
      segments.push({ name: "orbit", body: "earth", t0: tEndAscent, t1: tEnd });
      stateFns.push({ t0: tEndAscent, t1: tEnd, fn: orbitState });
      if (release) stages.push(dropAway(lastAscent.stageIndex, release.t, orbitState(release.t), "payload-release"));
      endState = arrival.success
        ? { type: "in-orbit", text: `In orbit · ${Math.round(s.perigee_km)} × ${Math.round(s.apogee_km)} km (est.)` }
        : { type: "stranded", text: `Stranded in Earth orbit · short by ${Math.round(arrival.shortBy_ms ?? 0).toLocaleString("en-US")} m/s (est.)` };
      ev("end", tEnd, { body: "earth" });
    } else {
      const tDep = tEndAscent + T / 3;
      segments.push({ name: "parking-orbit", body: "earth", t0: tEndAscent, t1: tDep });
      stateFns.push({ t0: tEndAscent, t1: tDep, fn: orbitState });
      const thDep = th0 + om * (tDep - tEndAscent);
      const pDep = mul(rHat(thDep), r0);
      const vp = vc + dv_kms;
      ev("departure-burn", tDep, { body: "earth", dv_ms: Math.round(dv_kms * 1000) });
      w(tDep - 1, tDep + 1);
      const payloadMass = payload?.mass_kg ?? lastAscent.mass_kg;
      // the spacecraft leaves the spent upper stage 30 s after the burn
      stages.push(dropAway(lastAscent.stageIndex, tDep + 30, { ...orbitState(tDep), axis: tHat(thDep) }, "spacecraft-sep"));
      ev("spacecraft-sep", tDep + 30, { body: "space" });

      if (kind === "moon") {
        // Keplerian ellipse from perigee pDep with speed vp (Earth gravity only)
        const e = (vp * vp * r0) / MU_E - 1;
        const a = r0 / (1 - e);
        const p = a * (1 - e * e);
        const n = Math.sqrt(MU_E / (a * a * a));
        const rArr = MOON_DIST - (R.moon + LUNAR_ORBIT_ALT);
        const Earr = Math.acos(Math.max(-1, Math.min(1, (1 - rArr / a) / e)));
        const tArr = tDep + (Earr - e * Math.sin(Earr)) / n;
        const nuOf = (E) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
        const keplerE = (M) => {
          let E = M;
          for (let k = 0; k < 30; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
          return E;
        };
        const transferState = (t) => {
          const E = keplerE(n * (t - tDep));
          const nu = nuOf(E);
          const r = p / (1 + e * Math.cos(nu));
          const th = thDep + nu;
          const vr = Math.sqrt(MU_E / p) * e * Math.sin(nu);
          const vt = Math.sqrt(MU_E / p) * (1 + e * Math.cos(nu));
          const vel = add(mul(rHat(th), vr), mul(tHat(th), vt));
          return { body: "space", pos: mul(rHat(th), r), vel, axis: normalize(vel), throttle: 0, stageIndex: null, mass_kg: payloadMass, heat: 0, chute: 0, dust: 0, phase: "transfer" };
        };
        const nuArr = nuOf(Earr);
        const alphaArr = thDep + nuArr;
        const omM = (2 * Math.PI) / MOON_PERIOD_S;
        const moonPos = (t) => mul(rHat(alphaArr + omM * (t - tArr)), MOON_DIST);
        const moonVel = (t) => mul(tHat(alphaArr + omM * (t - tArr)), MOON_DIST * omM);
        bodies = { ...bodies, moon: { radius_km: R.moon, distance_km: MOON_DIST, period_days: 27.3217, pos_km_at_arrival: r3(moonPos(tArr)) } };
        bodyPosAt = (body, t) => (body === "earth" ? [0, 0, 0] : body === "moon" ? moonPos(t) : null);
        segments.push({ name: "transfer", body: "space", t0: tDep, t1: tArr });
        stateFns.push({ t0: tDep, t1: tArr, fn: transferState });
        ev("lunar-orbit-insertion", tArr, { body: "moon" });
        w(tArr - 1, tArr + 1);
        // circular lunar orbit at 15 km in the transfer plane, starting on the Earth-facing side
        const rLo = R.moon + LUNAR_ORBIT_ALT;
        const vLo = Math.sqrt(MU_M / rLo);
        const omLo = vLo / rLo;
        const u1 = mul(rHat(alphaArr), -1);
        const u2 = normalize(cross(H_PLANE, u1));
        const tPdi = tArr + (2 * Math.PI) / omLo / 4;
        const loState = (t) => {
          const b2 = omLo * (t - tArr);
          const rel = add(mul(u1, rLo * Math.cos(b2)), mul(u2, rLo * Math.sin(b2)));
          const relV = add(mul(u1, -vLo * Math.sin(b2)), mul(u2, vLo * Math.cos(b2)));
          return { body: "moon", pos: rel, pos_eci: add(moonPos(t), rel), vel: relV, axis: normalize(relV), throttle: 0, stageIndex: null, mass_kg: payloadMass, heat: 0, chute: 0, dust: 0, phase: "lunar-orbit" };
        };
        segments.push({ name: "lunar-orbit", body: "moon", t0: tArr, t1: tPdi });
        stateFns.push({ t0: tArr, t1: tPdi, fn: loState });
        const d = descentTimeline(payload, { body: "moon" });
        const b0 = omLo * (tPdi - tArr);
        tEnd = addDescent(d, "moon", tPdi, b0, u1, u2, (t) => moonPos(t));
        endState = arrival.lands ? { type: "landed", text: `${arrival.lines.at(-1)}` } : { type: "in-orbit", text: `In orbit of the Moon (est.)` };
      } else {
        // Mars: scaled straight line from the departure point along the departure direction
        const dHat = tHat(thDep);
        const vInf = Math.sqrt(Math.max(0.01, vp * vp - (2 * MU_E) / r0));
        const T1 = 86400;
        const T3 = 86400;
        const s1 = (T1 * (vp + vInf)) / 2;
        const s3 = (T3 * (vInf + MARS_ENTRY_SPEED)) / 2;
        const T2 = Math.max(3600, (MARS_LINE_KM - s1 - s3) / vInf);
        const L = s1 + vInf * T2 + s3;
        const tEi = tDep + T1 + T2 + T3;
        // speed profile and distance along the line (smoothstep blends; distance integrates the speed exactly)
        const sAt = (t) => {
          const x = t - tDep;
          if (x <= T1) {
            const u = x / T1;
            // v = vp + (vInf - vp) * smooth(u); integral of smooth = u^3 - u^4/2
            return T1 * (vp * u + (vInf - vp) * (u ** 3 - u ** 4 / 2));
          }
          if (x <= T1 + T2) return s1 + vInf * (x - T1);
          const u = Math.min(1, (x - T1 - T2) / T3);
          return s1 + vInf * T2 + T3 * (vInf * u + (MARS_ENTRY_SPEED - vInf) * (u ** 3 - u ** 4 / 2));
        };
        const vAt = (t) => {
          const x = t - tDep;
          if (x <= T1) return lerp(vp, vInf, smooth(x / T1));
          if (x <= T1 + T2) return vInf;
          return lerp(vInf, MARS_ENTRY_SPEED, smooth((x - T1 - T2) / T3));
        };
        const pEnd = add(pDep, mul(dHat, L));
        const w0 = rHat(thDep);
        const up = add(mul(dHat, Math.sin(MARS_ENTRY_GAMMA)), mul(w0, Math.cos(MARS_ENTRY_GAMMA)));
        const marsC = sub(pEnd, mul(up, R.mars + MARS_ENTRY_ALT));
        bodies = { ...bodies, mars: { radius_km: R.mars, pos_km: r3(marsC), scaled: true, note: "placed 2,000,000 km down the departure line: not to scale" } };
        bodyPosAt = (body) => (body === "earth" ? [0, 0, 0] : body === "mars" ? marsC : null);
        const cruiseState = (t) => {
          const pos = add(pDep, mul(dHat, sAt(t)));
          return { body: "space", pos, vel: mul(dHat, vAt(t)), axis: dHat, throttle: 0, stageIndex: null, mass_kg: payloadMass, heat: 0, chute: 0, dust: 0, phase: "transfer" };
        };
        segments.push({ name: "transfer", body: "space", t0: tDep, t1: tEi });
        stateFns.push({ t0: tDep, t1: tEi, fn: cruiseState });
        ev("entry-interface", tEi, { body: "mars" });
        const u1 = up;
        const u2 = normalize(sub(dHat, mul(u1, dot(dHat, u1))));
        const d = descentTimeline(payload, { body: "mars" });
        tEnd = addDescent(d, "mars", tEi, 0, u1, u2, () => marsC);
        endState = arrival.lands ? { type: "landed", text: `${arrival.lines.at(-1)}` } : { type: "in-orbit", text: `In orbit of Mars (est.)` };
      }
      ev("touchdown", tEnd, { body: kind });
    }
  }

  // descent samples (arrival.js) -> body-centred states; th0 is the arc angle already flown on the circle (u1, u2)
  function addDescent(d, body, t0, th0, u1, u2, centre) {
    const DS = d.samples;
    const T = DS.at(-1).t_s;
    for (const ph of d.phases) segments.push({ name: ph.name, body, t0: t0 + (ph.t_s_start ?? 0), t1: 0, _screen: ph });
    // phase sim bounds from the samples
    const names = d.phases.map((p) => p.name);
    let acc = t0;
    for (const nm of names) {
      const ss = DS.filter((x) => x.phase === nm);
      const seg = segments.find((sg) => sg.name === nm && sg.body === body && sg.t1 === 0);
      seg.t0 = acc;
      const next = DS[DS.indexOf(ss.at(-1)) + 1];
      seg.t1 = t0 + (next ? next.t_s : T);
      acc = seg.t1;
      delete seg._screen;
    }
    for (const m of d.moments) ev(m.type, t0 + m.t_s, { body });
    if (d.moments.some((m) => m.type === "chute-open")) {
      const m = d.moments.find((x) => x.type === "chute-open");
      w(t0 + m.t_s - 1, t0 + m.t_s + 1);
    }
    w(t0 + T - 3, t0 + T);
    const Rb = R[body];
    const posAt = (x) => {
      const [i, j, u] = bracket(DS, x, "t_s");
      const a = DS[i];
      const b = DS[j];
      const alt = lerp(a.alt_m, b.alt_m, u) / 1000;
      const th = th0 + lerp(a.downrange_m, b.downrange_m, u) / 1000 / Rb;
      return { pos: add(mul(u1, (Rb + alt) * Math.cos(th)), mul(u2, (Rb + alt) * Math.sin(th))), a, b, u, th };
    };
    const descentState = (t) => {
      const x = Math.max(0, Math.min(T, t - t0));
      const { pos, a, b, u, th } = posAt(x);
      const p2 = posAt(Math.min(T, x + 0.5)).pos;
      const p1 = posAt(Math.max(0, x - 0.5)).pos;
      const dtv = Math.min(T, x + 0.5) - Math.max(0, x - 0.5) || 1;
      const vel = mul(sub(p2, p1), 1 / dtv);
      const f = surfaceFrame(body, pos);
      const hz = sub(vel, mul(f.up, dot(vel, f.up)));
      const hdir = len(hz) > 1e-6 ? normalize(hz) : add(mul(u1, -Math.sin(th)), mul(u2, Math.cos(th)));
      const pitch = lerp(a.pitch_deg, b.pitch_deg, u) * rad;
      // thrust axis: tilted back against the motion by the descent pitch; entry and chute: against the flow
      const axis = a.phase === "entry" || a.phase === "parachute" ? (len(vel) > 1e-6 ? mul(normalize(vel), -1) : f.up) : normalize(sub(mul(f.up, Math.cos(pitch)), mul(hdir, Math.sin(pitch))));
      return {
        body,
        pos,
        pos_eci: add(centre(t), pos),
        vel,
        axis,
        throttle: lerp(a.throttle, b.throttle, u),
        stageIndex: null,
        mass_kg: payload?.mass_kg ?? null,
        heat: lerp(a.heat, b.heat, u),
        chute: lerp(a.chute ?? 0, b.chute ?? 0, u),
        dust: lerp(a.dust, b.dust, u),
        phase: a.phase === "touchdown" ? "vertical" : a.phase,
      };
    };
    stateFns.push({ t0, t1: t0 + T, fn: descentState });
    return t0 + T;
  }

  // --- screen budgets
  const totalTarget = opts.totalScreen_s ?? TOTAL[kind];
  const SHARE = {
    earth: { ascent: 24, orbit: 11 },
    moon: { ascent: 20, "parking-orbit": 4, transfer: 9, "lunar-orbit": 4, braking: 7, approach: 4, vertical: 7 },
    mars: { ascent: 20, "parking-orbit": 4, transfer: 12, entry: 9, parachute: 5, approach: 6, vertical: 9 },
  }[kind];
  const sumShare = segments.reduce((a2, sg) => a2 + (SHARE[sg.name] ?? 0), 0) || 1;
  const segs = segments.map((sg) => ({ ...sg, budget: ((SHARE[sg.name] ?? totalTarget / segments.length) / sumShare) * totalTarget }));
  if (segs.length === 1) segs[0].budget = totalTarget;
  const clock = buildClock(segs, windows);

  for (const e of events) e.t_screen = Math.round(clock.simToScreen(e.t_sim) * 1000) / 1000;
  events.sort((a2, b2) => a2.t_sim - b2.t_sim);
  for (const st of stages) st.t_screen = Math.round(clock.simToScreen(st.t_sim) * 1000) / 1000;
  const segmentsOut = segs.map((sg) => ({ name: sg.name, body: sg.body, t0_sim: sg.t0, t1_sim: sg.t1, t0_screen: clock.simToScreen(sg.t0), t1_screen: clock.simToScreen(sg.t1) }));

  const stateAt = (t) => {
    let f = stateFns.find((x) => t >= x.t0 && t <= x.t1);
    if (!f) f = t < 0 ? stateFns[0] : stateFns.at(-1);
    return f.fn(Math.max(f.t0, Math.min(f.t1, t)));
  };
  const sampleAt = (tScreen) => {
    const t = clock.screenToSim(Math.max(0, Math.min(clock.total, tScreen)));
    const st = stateAt(t);
    const eci = st.pos_eci ?? st.pos;
    const bodyName = st.body === "space" ? "earth" : st.body;
    const att = attitude(bodyName, st.pos, st.axis);
    return {
      t_sim: t,
      t_screen: Math.min(clock.total, Math.max(0, tScreen)),
      body: st.body,
      pos_km: r3(st.pos), // body-centred (transfer: Earth-centred)
      pos_eci_km: r3(eci), // always Earth-centred
      vel_kms: r3(st.vel), // relative to the current body
      speed_ms: Math.round(len(st.vel) * 1000 * 10) / 10,
      alt_km: Math.round(altitude(bodyName, st.pos) * 1000) / 1000,
      axis: r3(st.axis), // the vehicle's long axis (nose / thrust direction), unit, same frame as pos_km
      pitch_deg: att.pitch_deg,
      yaw_deg: att.yaw_deg,
      throttle: Math.round(st.throttle * 1000) / 1000,
      phase: st.phase,
      stageIndex: st.stageIndex,
      mass_kg: st.mass_kg == null ? null : Math.round(st.mass_kg),
      chute: Math.round(st.chute * 1000) / 1000,
      heat: Math.round(st.heat * 1000) / 1000,
      dust: Math.round(st.dust * 1000) / 1000,
    };
  };

  return {
    outcome: s.outcome,
    endState,
    kind,
    bodies,
    segments: segmentsOut,
    events,
    stages,
    sampleAt,
    screenToSim: clock.screenToSim,
    simToScreen: clock.simToScreen,
    bodyPosAt: (body, t) => {
      const p = bodyPosAt(body, t);
      return p ? r3(p) : null;
    },
    totalScreen_s: Math.round(clock.total * 1000) / 1000,
    totalSim_s: tEnd,
    arrival,
    _clock: clock, // for checks: the dense (sim, screen, rate) grid
    est: true,
  };
}

// A spent stage's 2 s drop-away at separation (body frame: +y along the vehicle axis (nose), +x to the vehicle's
// right = axis x local up, +z completes the frame). Also given in Earth-centred coordinates at that moment.
function dropAway(stageIndex, t, st, type = "sep") {
  const f = surfaceFrame("earth", st.pos);
  let x = cross(st.axis, f.up);
  if (len(x) < 1e-6) x = f.east;
  x = normalize(x);
  const z = cross(x, st.axis);
  const [bx, by, bz] = DROP.dir_body;
  const dirEci = normalize(add(add(mul(x, bx), mul(st.axis, by)), mul(z, bz)));
  return { type, stageIndex, t_sim: t, dropAway: { dir_body: r3(DROP.dir_body), dir_eci: r3(dirEci), speed_ms: DROP.speed_ms, duration_s: DROP.duration_s } };
}
