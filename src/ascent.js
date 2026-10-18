// Ascent simulator (all outputs are estimates: label them "est." on screen). Pure: no DOM.
//   simulateAscent(build, catalog, opts?) -> { samples, events, summary }
// Standard textbook model, not a flight-dynamics tool:
// - 2-D point mass over a spherical, NON-rotating Earth: no free ~400 m/s from Earth's spin, so the result is
//   on the conservative side. Inverse-square gravity.
// - Isothermal exponential atmosphere, density and pressure with one scale height. The atmosphere is at rest,
//   so drag uses the inertial speed.
// - Thrust per stage n * (F_vac - (F_vac - F_sl) * p/p0); Isp blended the same way; mass flow F / (Isp * g0).
//   Vacuum-only engines (F_sl = 0) produce almost nothing at sea level.
// - Drag 0.5 * rho * v^2 * Cd * A, with Cd 0.3 and A the frontal area of the current lowest stage's tank (the
//   first-stage diameter for the first stage). Fairing and payload shapes are ignored; above ~60 km drag is
//   negligible anyway.
// - Guidance:
//   - First stage: vertical for 10 s and until 1.5 km, then a pitch-over to the kick angle (5 s ramp), then a
//     gravity turn (thrust along the velocity vector).
//   - Upper stages: closed-loop steering toward a circular orbit at the target altitude (default 200 km). The
//     radial thrust share is chosen so altitude reaches the target with zero vertical speed when the stage
//     reaches circular speed.
//   - The kick angle is searched per build (opts.kick_deg overrides) to leave the most delta-v after orbit
//     insertion.
// - g-limit (default 4.5 g, opts.gLimit; null turns it off): any stage throttles down, never below 0.4, to hold
//   thrust / mass at the limit, as real vehicles do near burnout. Samples carry gLimited; summary.gLimited_s
//   counts the time spent limited. Below 0.4 throttle the limit is exceeded rather than flame out.
// - Max-Q: the first stage throttles to 0.8 while q > 25 kPa and still rising, and returns to full once q has
//   peaked.
// - Staging at propellant depletion: cutoff, separation 1 s later (the spent stage's dry mass is dropped),
//   next-stage ignition 1 s after that (2 s coast). Fairing jettison at 110 km is an event only: the dataset
//   has no fairing mass, and there is no fairing for exposed payloads (visuals.json).
// - Cutoff: the last burning stage stops when its speed reaches circular speed at its current altitude, or
//   when its propellant runs out.
//
// Outcome:
// - "orbit": perigee above 150 km AND enough delta-v left in the stack for the mission's beyond-LEO increment.
//   The increment is mission.requiredDeltaV_ms - leo.requiredDeltaV_ms: missions.json builds every mission as
//   9,400 m/s to LEO plus a cited increment.
// - "shortfall": reached space (apogee >= 100 km) but not orbit, so the samples coast on to impact; OR in orbit
//   but short of the mission increment, in which case it stays in the parking orbit.
// - "impact": never reached 100 km, or never lifted off (thrust below weight 3 s after ignition: pad abort).
//
// Max Q and max g are taken over powered flight (a suborbital fall back is not part of the ascent).
// Losses over powered flight:
// - gravity = integral of g * sin(flight-path angle) dt
// - drag = integral of D / m dt
// - achieved delta-v = integral of T / m dt
// Steering loss is the remainder.
//
// Events, each { t, type, alt_m, vel_ms, stage }:
// - ignition, liftoff, maxq;
// - meco: cutoff of a stage that has another above it;
// - sep;
// - ignition2: every upper-stage ignition;
// - fairing;
// - seco: cutoff of the last burning stage;
// - orbit / shortfall / impact.
//
// Samples every opts.sampleEvery_s (0.5 s), plus one at each event.
//
// Constants:
// - GM: WGS 84 / IERS value.
// - R: the 6,371 km mean Earth radius.
// - p0 101,325 Pa and rho0 1.225 kg/m^3: ISA sea level.
// - The 8.5 km scale height and Cd 0.3: model choices, from the design brief.
import { G0 } from "./physics.js";

const MU = 3.986004418e14; // m^3/s^2
const RE = 6371e3; // m
const P0 = 101325; // Pa
const RHO0 = 1.225; // kg/m^3
const SCALE_H = 8500; // m
const CD = 0.3;
const DT = 0.1; // s (the kick search runs at 0.5 s, the returned flight at 0.1 s)
const SEARCH_DT = 0.5;
const T_MAX = 1200; // s; extended per build to fit long upper-stage burns plus a fall back (see capFor)
const VERTICAL_S = 10;
const KICK_ALT = 1500; // m
const KICK_RAMP_S = 5;
const KICK_HOLD_MAX_S = 15; // after the ramp, hold the kick until the velocity vector catches up (at most this)
const MAXQ_LIMIT = 25000; // Pa
const MAXQ_THROTTLE = 0.8;
const G_LIMIT = 4.5; // g, default
const MIN_THROTTLE = 0.4;
const HOLDDOWN_S = 3; // no liftoff this long after ignition -> abort on the pad
const SEP_DELAY_S = 1;
const IGNITION_DELAY_S = 1;
const FAIRING_ALT = 110e3;
const PERIGEE_MIN = 150e3;
const SPACE_ALT = 100e3;
const TARGET_ALT = 200e3;

const byId = (list, id) => (id ? list?.find((x) => x.id === id) : undefined);

function stagesOf(build, catalog) {
  return build.stages.map((s) => {
    const e = byId(catalog.engines, s.engineId);
    const t = byId(catalog.tanks, s.tankId);
    if (!e || !t) return null;
    const n = s.engineCount;
    return {
      prop: t.propellantMass_kg,
      dry: n * e.mass_kg + t.dryMass_kg,
      Fsl: n * e.thrustSL_kN * 1000,
      Fvac: n * e.thrustVac_kN * 1000,
      ispSl: e.ispSL_s,
      ispVac: e.ispVac_s,
      area: Math.PI * (t.diameter_m / 2) ** 2,
    };
  });
}

// Delta-v left in the stack from stage k upward, stage k holding `propLeft` (vacuum Isp, rocket equation).
function remainingDeltaV(stages, k, propLeft, payload_kg) {
  let dv = 0;
  for (let i = k; i < stages.length; i++) {
    const above = stages.slice(i + 1).reduce((s, st) => s + st.dry + st.prop, 0) + payload_kg;
    const prop = i === k ? propLeft : stages[i].prop;
    const m0 = above + stages[i].dry + prop;
    const m1 = above + stages[i].dry;
    if (prop > 0 && stages[i].ispVac > 0) dv += stages[i].ispVac * G0 * Math.log(m0 / m1);
  }
  return dv;
}

function orbitOf(x, y, vx, vy) {
  const r = Math.hypot(x, y);
  const v2 = vx * vx + vy * vy;
  const eps = v2 / 2 - MU / r;
  const hAng = x * vy - y * vx;
  if (eps >= 0) return { perigee_m: null, apogee_m: Infinity, escape: true };
  const a = -MU / (2 * eps);
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * hAng * hAng) / (MU * MU)));
  return { perigee_m: a * (1 - e) - RE, apogee_m: a * (1 + e) - RE, escape: false };
}

// One flight. record=false skips samples and stops as soon as the outcome is known (used by the kick search).
function fly(stages, payload_kg, fairing, increment_ms, { kick_deg, targetAlt_m, maxQThrottle, gLimit, record, sampleEvery_s, dt: DT_RUN, tMax }) {
  const samples = [];
  const events = [];
  let x = 0;
  let y = RE;
  let vx = 0;
  let vy = 0;
  let m = stages.reduce((s, st) => s + st.dry + st.prop, 0) + payload_kg;
  let t = 0;
  let k = 0; // burning (or next) stage
  let propLeft = stages[0].prop;
  let phase = "burn"; // burn | staging | ballistic | done
  let stagingAt = 0;
  let sepDone = false;
  let ignitedAt = 0;
  let lifted = false;
  let kickAt = null;
  let qPeakPassed = false;
  let qPrev = 0;
  let fairingDone = !fairing;
  let maxQ = 0;
  let maxQAt = null;
  let maxG = 0;
  let gravLoss = 0;
  let dragLoss = 0;
  let dvAch = 0;
  const burnTimes = stages.map(() => 0);
  let outcome = null;
  let orbit = null;
  let remaining = null;
  let nextSample = 0;
  let throttle = 1;
  let gLimited = false;
  let gLimitedTime = 0;
  let thrustNow = 0;
  let accNow = 0;

  const state = () => {
    const r = Math.hypot(x, y);
    return { alt_m: r - RE, vel_ms: Math.hypot(vx, vy) };
  };
  const ev = (type, stage = k) => {
    const s = state();
    events.push({ t: round(t, 2), type, alt_m: round(s.alt_m, 0), vel_ms: round(s.vel_ms, 1), stage });
    if (record) sample(true);
  };
  const sample = (force = false) => {
    if (!record || (!force && t < nextSample - 1e-9)) return;
    if (!force) nextSample += sampleEvery_s;
    const r = Math.hypot(x, y);
    const h = r - RE;
    const v = Math.hypot(vx, vy);
    const rho = h > 0 ? RHO0 * Math.exp(-h / SCALE_H) : RHO0;
    samples.push({
      t: round(t, 2),
      alt_m: round(h, 1),
      vel_ms: round(v, 2),
      acc_ms2: round(accNow, 3),
      mass_kg: round(m, 1),
      stage: k,
      throttle: round(throttle, 3),
      gLimited,
      q_Pa: round(0.5 * rho * v * v, 1),
      thrust_kN: round(thrustNow / 1000, 2),
      downrange_m: round(RE * Math.atan2(x, y), 1),
      gamma_deg: round(v > 1 ? (Math.asin(Math.max(-1, Math.min(1, (x * vx + y * vy) / (r * v)))) * 180) / Math.PI : 90, 3),
    });
  };

  // Acceleration for the integrator: gravity + thrust (fixed over the step) + drag (state-dependent).
  let Fx = 0;
  let Fy = 0;
  let area = stages[0].area;
  const accel = (px, py, qx, qy, mass, out) => {
    const r = Math.hypot(px, py);
    const g = MU / (r * r);
    let ax = (-g * px) / r + Fx / mass;
    let ay = (-g * py) / r + Fy / mass;
    const h = r - RE;
    const v = Math.hypot(qx, qy);
    if (h < 150e3 && v > 0) {
      const D = 0.5 * RHO0 * Math.exp(-Math.max(0, h) / SCALE_H) * v * v * CD * area;
      ax -= (D / mass) * (qx / v);
      ay -= (D / mass) * (qy / v);
    }
    out[0] = ax;
    out[1] = ay;
  };
  const k1 = [0, 0];
  const k2 = [0, 0];
  const k3 = [0, 0];
  const k4 = [0, 0];

  ev("ignition", 0);
  sample(true);

  while (t < tMax - 1e-9 && phase !== "done") {
    const r = Math.hypot(x, y);
    const h = r - RE;
    const ur = [x / r, y / r];
    const ut = [ur[1], -ur[0]];
    const v = Math.hypot(vx, vy);
    const vr = vx * ur[0] + vy * ur[1];
    const vt = vx * ut[0] + vy * ut[1];
    const pRatio = h > 0 ? Math.exp(-h / SCALE_H) : 1;
    const q = 0.5 * RHO0 * pRatio * v * v;
    const g = MU / (r * r);

    // ---- control for this step ----
    let F = 0;
    let mdot = 0;
    let dir = ur;
    throttle = 0;
    gLimited = false;
    if (phase === "burn") {
      const st = stages[k];
      const Ffull = Math.max(0, st.Fvac - (st.Fvac - st.Fsl) * pRatio);
      const isp = Math.max(0, st.ispVac - (st.ispVac - st.ispSl) * pRatio);
      throttle = 1;
      if (maxQThrottle && k === 0) {
        if (!qPeakPassed && q > MAXQ_LIMIT) throttle = MAXQ_THROTTLE;
        if (q > MAXQ_LIMIT && q < qPrev) qPeakPassed = true;
      }
      if (gLimit > 0 && Ffull > 0) {
        const cap = (gLimit * G0 * m) / Ffull;
        if (cap < throttle) {
          throttle = Math.max(MIN_THROTTLE, cap);
          gLimited = true;
        }
      }
      F = Ffull * throttle;
      mdot = F > 0 && isp > 0 ? F / (isp * G0) : 0;
      if (k === 0) {
        if (kickAt === null && t >= VERTICAL_S && h >= KICK_ALT) kickAt = t;
        if (kickAt !== null) {
          const a = (kick_deg * Math.PI) / 180;
          const since = t - kickAt;
          const velFromVertical = v > 1 ? Math.acos(Math.max(-1, Math.min(1, vr / v))) : 0;
          if (since >= KICK_RAMP_S && (velFromVertical >= a || since >= KICK_RAMP_S + KICK_HOLD_MAX_S)) {
            dir = [vx / v, vy / v]; // gravity turn
          } else {
            const ang = a * Math.min(1, since / KICK_RAMP_S);
            dir = [Math.cos(ang) * ur[0] + Math.sin(ang) * ut[0], Math.cos(ang) * ur[1] + Math.sin(ang) * ut[1]];
          }
        }
      } else if (F > 0) {
        // Closed-loop: reach targetAlt with vr = 0 when vt reaches circular speed there.
        const aT = F / m;
        const vCirc = Math.sqrt(MU / (RE + targetAlt_m));
        const dvGo = Math.max(1, vCirc - vt);
        const isp0 = Math.max(1, isp);
        const tGo = Math.max(5, (m / mdot) * (1 - Math.exp(-dvGo / (isp0 * G0))));
        const aR = (6 * (targetAlt_m - h)) / (tGo * tGo) - (4 * vr) / tGo;
        const need = aR + g - (vt * vt) / r;
        const s = Math.max(-0.95, Math.min(0.95, need / aT));
        const c = Math.sqrt(1 - s * s);
        dir = [s * ur[0] + c * ut[0], s * ur[1] + c * ut[1]];
      }
    }
    qPrev = q;

    // Liftoff: thrust must beat weight; until then the rocket sits on the pad and burns.
    if (!lifted && phase === "burn" && F > m * g) {
      lifted = true;
      ev("liftoff", 0);
    }

    // ---- step length (stop exactly at propellant depletion) ----
    let dt = DT_RUN;
    let depleted = false;
    if (phase === "burn" && mdot > 0 && mdot * dt >= propLeft) {
      dt = propLeft / mdot;
      depleted = true;
    }

    // ---- integrate ----
    Fx = F * dir[0];
    Fy = F * dir[1];
    area = stages[Math.min(k, stages.length - 1)].area;
    if (lifted) {
      const mMid = m - mdot * dt * 0.5;
      const mEnd = m - mdot * dt;
      accel(x, y, vx, vy, m, k1);
      accel(x + vx * dt * 0.5, y + vy * dt * 0.5, vx + k1[0] * dt * 0.5, vy + k1[1] * dt * 0.5, mMid, k2);
      accel(x + (vx + k1[0] * dt * 0.5) * dt * 0.5, y + (vy + k1[1] * dt * 0.5) * dt * 0.5, vx + k2[0] * dt * 0.5, vy + k2[1] * dt * 0.5, mMid, k3);
      accel(x + (vx + k2[0] * dt * 0.5) * dt, y + (vy + k2[1] * dt * 0.5) * dt, vx + k3[0] * dt, vy + k3[1] * dt, mEnd, k4);
      const nvx = vx + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      const nvy = vy + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      x += (dt / 6) * (vx + 2 * (vx + k1[0] * dt * 0.5) + 2 * (vx + k2[0] * dt * 0.5) + (vx + k3[0] * dt));
      y += (dt / 6) * (vy + 2 * (vy + k1[1] * dt * 0.5) + 2 * (vy + k2[1] * dt * 0.5) + (vy + k3[1] * dt));
      vx = nvx;
      vy = nvy;
    }
    // Sensed acceleration and losses (powered flight only).
    const D = lifted && h < 150e3 ? 0.5 * RHO0 * pRatio * v * v * CD * area : 0;
    accNow = m > 0 ? Math.hypot(Fx - (v > 0 ? (D * vx) / v : 0), Fy - (v > 0 ? (D * vy) / v : 0)) / m : 0;
    thrustNow = F;
    if (lifted && F > 0) maxG = Math.max(maxG, accNow / G0); // powered flight only (not re-entry)
    if (gLimited) gLimitedTime += dt;
    if (lifted && F > 0) {
      dvAch += (F / m) * dt;
      gravLoss += g * (v > 0 ? vr / v : 1) * dt;
      dragLoss += (D / m) * dt;
    }
    if (lifted && F > 0 && q > maxQ) {
      maxQ = q;
      maxQAt = { t, alt_m: h, vel_ms: v, stage: k };
    }
    m -= mdot * dt;
    if (phase === "burn") propLeft = Math.max(0, propLeft - mdot * dt);
    t += dt;

    const now = state();
    if (!fairingDone && now.alt_m >= FAIRING_ALT) {
      fairingDone = true;
      ev("fairing");
    }

    // ---- phase transitions ----
    if (phase === "burn" && k === stages.length - 1 && F > 0 && k > 0 && now.alt_m > SPACE_ALT && now.vel_ms >= Math.sqrt(MU / (RE + now.alt_m))) {
      burnTimes[k] = t - ignitedAt;
      ev("seco");
      phase = "insert";
    } else if (depleted) {
      burnTimes[k] = t - ignitedAt;
      if (k < stages.length - 1) {
        ev("meco");
        phase = "staging";
        stagingAt = t;
        sepDone = false;
      } else {
        ev("seco");
        phase = "insert";
      }
    } else if (phase === "staging") {
      if (!sepDone && t >= stagingAt + SEP_DELAY_S - 1e-9) {
        m -= stages[k].dry;
        sepDone = true;
        ev("sep");
        k += 1;
        propLeft = stages[k].prop;
      } else if (sepDone && t >= stagingAt + SEP_DELAY_S + IGNITION_DELAY_S - 1e-9) {
        phase = "burn";
        ignitedAt = t;
        ev("ignition2");
      }
    }

    if (phase === "insert") {
      orbit = orbitOf(x, y, vx, vy);
      if (orbit.escape || orbit.perigee_m > PERIGEE_MIN) {
        remaining = remainingDeltaV(stages, k, propLeft, payload_kg);
        ev("orbit");
        if (remaining + 1e-6 >= increment_ms) outcome = "orbit";
        else {
          outcome = "shortfall";
          ev("shortfall");
        }
        phase = "done";
      } else {
        phase = "ballistic";
      }
    } else if (phase === "ballistic") {
      const vrNow = (x * vx + y * vy) / Math.hypot(x, y);
      if (outcome === null && vrNow <= 0) {
        orbit = orbitOf(x, y, vx, vy);
        if (now.alt_m >= SPACE_ALT) {
          outcome = "shortfall";
          ev("shortfall");
        } else outcome = "impact";
        if (!record) phase = "done";
      }
    }
    if (lifted && now.alt_m <= 0 && t > 1) {
      ev("impact");
      outcome ??= "impact";
      orbit ??= orbitOf(x, y, vx, vy);
      phase = "done";
    }
    if (!lifted && phase === "burn" && (depleted || t >= HOLDDOWN_S)) {
      // Thrust never beat weight: the hold-downs never release (a real pad abort); counts as "impact".
      ev("impact", 0);
      outcome = "impact";
      phase = "done";
    }
    sample();
  }
  if (outcome === null) {
    orbit = orbitOf(x, y, vx, vy);
    outcome = orbit.perigee_m !== null && orbit.perigee_m > PERIGEE_MIN ? "orbit" : (orbit.apogee_m ?? 0) >= SPACE_ALT ? "shortfall" : "impact";
  }
  if (maxQAt) events.push({ t: round(maxQAt.t, 2), type: "maxq", alt_m: round(maxQAt.alt_m, 0), vel_ms: round(maxQAt.vel_ms, 1), stage: maxQAt.stage });
  events.sort((a, b) => a.t - b.t);
  return {
    samples,
    events,
    outcome,
    orbit,
    remaining,
    summary: {
      outcome,
      achievedDeltaV_ms: dvAch,
      gravityLoss_ms: gravLoss,
      dragLoss_ms: dragLoss,
      maxQ_Pa: maxQ,
      maxG,
      burnTimes_s: burnTimes,
      gLimited_s: gLimitedTime,
      perigee_km: orbit?.perigee_m == null ? null : orbit.perigee_m / 1000,
      apogee_km: orbit ? (Number.isFinite(orbit.apogee_m) ? orbit.apogee_m / 1000 : Infinity) : null,
    },
  };
}

const round = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// 1,200 s, or longer when the stages' full-thrust burns (+ staging) leave less than 10 minutes for the rest:
// a single-RL10 upper stage alone burns ~19 minutes.
function capFor(stages) {
  const burns = stages.reduce((s, st) => s + (st.Fvac > 0 && st.ispVac > 0 ? st.prop / (st.Fvac / (st.ispVac * G0)) : 0), 0);
  return Math.max(T_MAX, Math.ceil(burns + 2 * stages.length + 600));
}

// Score for the kick search: most delta-v left once in orbit; failing flights rank below, by how close they got.
function score(res) {
  if (res.remaining != null) return 1e6 + res.remaining;
  const o = res.orbit;
  if (!o) return -1e9;
  return (o.perigee_m ?? -RE) + Math.min(o.apogee_m, 1e7) * 1e-3;
}

export function simulateAscent(build, catalog, opts = {}) {
  const stages = stagesOf(build, catalog);
  const payload = byId(catalog.payloads, build.payloadId);
  const mission = byId(catalog.missions, build.missionId);
  const leo = byId(catalog.missions, "leo");
  const empty = (why) => ({
    samples: [],
    events: [],
    summary: { outcome: "impact", achievedDeltaV_ms: 0, gravityLoss_ms: 0, dragLoss_ms: 0, maxQ_Pa: 0, maxG: 0, burnTimes_s: [], perigee_km: null, apogee_km: null, error: why },
  });
  if (!stages.length) return empty("empty build");
  if (stages.some((s) => !s)) return empty("unknown engine or tank id");
  const payload_kg = payload?.mass_kg ?? 0;
  const exposed = catalog.visuals?.payloads?.[payload?.id]?.exposed === true;
  const increment_ms = mission && leo ? Math.max(0, mission.requiredDeltaV_ms - leo.requiredDeltaV_ms) : 0;
  const base = {
    targetAlt_m: opts.targetAlt_m ?? TARGET_ALT,
    maxQThrottle: opts.maxQThrottle ?? true,
    gLimit: opts.gLimit === undefined ? G_LIMIT : opts.gLimit ?? 0,
    sampleEvery_s: opts.sampleEvery_s ?? 0.5,
  };
  const tMax = capFor(stages);
  const run = (kick_deg, record) =>
    fly(stages, payload_kg, Boolean(payload) && !exposed, increment_ms, { ...base, kick_deg, record, dt: record ? DT : SEARCH_DT, tMax });

  // Kick angle: coarse grid (1-45 deg, 2 deg steps), then golden-section refinement around the best point.
  // Light upper stages on a powerful first stage want large kicks (the demo build: ~27 deg).
  let kick = opts.kick_deg;
  if (kick == null) {
    let best = { kick: 3, s: -Infinity };
    for (let a = 1; a <= 45.01; a += 2) {
      const s = score(run(a, false));
      if (s > best.s) best = { kick: a, s };
    }
    let lo = Math.max(0.1, best.kick - 2);
    let hi = best.kick + 2;
    const phi = (Math.sqrt(5) - 1) / 2;
    let c = hi - phi * (hi - lo);
    let d = lo + phi * (hi - lo);
    let sc = score(run(c, false));
    let sd = score(run(d, false));
    for (let i = 0; i < 10; i++) {
      if (sc > sd) {
        hi = d;
        d = c;
        sd = sc;
        c = hi - phi * (hi - lo);
        sc = score(run(c, false));
      } else {
        lo = c;
        c = d;
        sc = sd;
        d = lo + phi * (hi - lo);
        sd = score(run(d, false));
      }
    }
    kick = sc > sd ? c : d;
    if (Math.max(sc, sd) < best.s) kick = best.kick;
  }
  const res = run(kick, true);
  return {
    samples: res.samples,
    events: res.events,
    summary: {
      ...res.summary,
      kick_deg: round(kick, 3),
      targetAlt_km: base.targetAlt_m / 1000,
      remainingDeltaV_ms: res.remaining,
      mission: mission
        ? {
            id: mission.id,
            beyondLEO_ms: increment_ms,
            shortBy_ms: res.remaining == null ? null : Math.max(0, increment_ms - res.remaining),
          }
        : null,
      est: true,
    },
  };
}
