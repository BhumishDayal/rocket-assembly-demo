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
// - Max-Q: a first stage with a sourced throttle capability (THROTTLEABLE: Merlin 1D, RD-180, RS-68A) throttles
//   to 0.8 once q exceeds 25 kPa and returns to full when q is back under 25 kPa (events throttle-down /
//   throttle-up); other first stages fly through Max-Q at full thrust.
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
import { G0, TWR_LOW_WARNING, evaluateBuild } from "./physics.js";

// Pad abort: a build whose verdict has a blocking warning is not flown (outcome "blocked", reason = the first
// blocking warning, no samples or events). In physics.js every warning blocks except TWR_LOW_WARNING.
// FLIGHT_EXEMPT lists blocking warnings that are app rules rather than physics, which a real vehicle breaks and
// the simulation can still fly honestly: the dry-mass floor (now 3 %; at 4 % the real Falcon 9 second stage,
// 3.23 %, failed it; every tank in tanks.json passes 3 %, the lightest being that one). Remove it to ground those
// builds too. opts.ignoreVerdict flies any build regardless.
const NON_BLOCKING = new Set([TWR_LOW_WARNING]);
const FLIGHT_EXEMPT = [/^tank dry mass below \d+(\.\d+)? percent of propellant$/];

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

// Detail channels for the animation (est.):
// - mach: speed / speed of sound from a simplified ISA table (ISO 2533 / US Standard Atmosphere 1976:
//   340 m/s at sea level falling to 295 m/s at 11 km); above 11 km it is held at 295 m/s (model choice).
// - transonic: 0.85 < Mach < 1.15, the window where condensation collars show.
// - heat: a heating proxy rho * v^3, normalised to its own maximum over that flight (0..1); the main vehicle
//   and the booster are normalised separately. Not a heat-flux figure.
const speedOfSound = (h) => (h <= 0 ? 340 : h >= 11000 ? 295 : 340 - (45 * h) / 11000);
const TRANSONIC = [0.85, 1.15];
// Igniters: only the Merlin Vacuum's is sourced ("the engine contains dual redundant triethylaluminum-
// triethylborane (TEA-TEB) pyrophoric igniters", Falcon User's Guide 2025,
// https://www.spacex.com/assets/media/falcon-users-guide-2025-05-09.pdf); other upper-stage ignitions get a
// generic "igniter" event.
const TEA_TEB = new Set(["merlin-1d-vac"]);
// Max-Q throttling only for first-stage engines with a sourced throttle capability; the others have none in our
// data and fly through Max-Q at full thrust (no throttle-down / throttle-up events).
const THROTTLEABLE = {
  "merlin-1d": "https://www.spacex.com/assets/media/falcon-users-guide-2025-05-09.pdf (throttle \"Yes (190,000 lbf to 108,300 lbf sea level)\")",
  "rd-180": "https://www.ulalaunch.com/rockets/atlas-v (\"an impressive range of continuous throttling capability\")",
  "rs-68a": "https://web.archive.org/web/20140720073154/http://www.ulalaunch.com/Products_DeltaIV.aspx (\"the throttleable RS-68A engine\")",
};
const IGNITER_LEAD_S = 0.4;
const RELEASE_AFTER_S = 20; // payload release: SECO + 20 s of sim time (shown as 1 s on screen)
const normaliseHeat = (samples) => {
  const max = samples.reduce((m, s) => Math.max(m, s.heat), 0);
  for (const s of samples) s.heat = max > 0 ? round(s.heat / max, 4) : 0;
};

function stagesOf(build, catalog) {
  return build.stages.map((s) => {
    const e = byId(catalog.engines, s.engineId);
    const t = byId(catalog.tanks, s.tankId);
    if (!e || !t) return null;
    const n = s.engineCount;
    return {
      engineId: e.id,
      throttleable: e.id in THROTTLEABLE,
      n,
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
function fly(stages, payload_kg, fairing, increment_ms, { kick_deg, targetAlt_m, maxQThrottle, gLimit, record, sampleEvery_s, dt: DT_RUN, tMax, stopAtSep = false, towerClear_m = 0 }) {
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
  let sep0 = null; // state at the first stage's separation (for the booster return)
  let towerCleared = false;
  let machOne = false;
  let qThrottling = false;
  let igniterDone = false;

  const state = () => {
    const r = Math.hypot(x, y);
    return { alt_m: r - RE, vel_ms: Math.hypot(vx, vy) };
  };
  const ev = (type, stage = k, extra = null) => {
    const s = state();
    events.push({ t: round(t, 2), type, alt_m: round(s.alt_m, 0), vel_ms: round(s.vel_ms, 1), stage, ...(extra ?? {}) });
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
      x_m: round(RE * Math.atan2(x, y), 1),
      mach: round(v / speedOfSound(h), 3),
      transonic: v / speedOfSound(h) > TRANSONIC[0] && v / speedOfSound(h) < TRANSONIC[1],
      heat: h < 150e3 ? rho * v * v * v : 0, // normalised after the flight
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
      if (maxQThrottle && k === 0 && stages[0].throttleable) {
        // Throttled from q > 25 kPa through the peak until q is back under 25 kPa (once per flight). Releasing
        // at the first dip would be wrong: the throttle-down itself makes q dip before the real peak.
        if (qThrottling && q <= MAXQ_LIMIT) qPeakPassed = true;
        const active = !qPeakPassed && q > MAXQ_LIMIT;
        if (active) throttle = MAXQ_THROTTLE;
        if (active && !qThrottling) ev("throttle-down", 0, { reason: "max-q", throttle: MAXQ_THROTTLE });
        if (!active && qThrottling) ev("throttle-up", 0, { reason: "max-q", throttle: 1 });
        qThrottling = active;
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
    if (lifted && !towerCleared && towerClear_m > 0 && now.alt_m > towerClear_m) {
      towerCleared = true;
      ev("tower-clear", 0);
    }
    if (lifted && !machOne && now.vel_ms >= speedOfSound(now.alt_m)) {
      machOne = true;
      ev("transonic", k, { mach: 1 });
    }
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
        if (k === 0) sep0 = { t, x, y, vx, vy };
        m -= stages[k].dry;
        sepDone = true;
        ev("sep");
        if (k === 0 && stopAtSep) phase = "done";
        k += 1;
        propLeft = stages[k].prop;
      } else if (sepDone && !igniterDone && t >= stagingAt + SEP_DELAY_S + IGNITION_DELAY_S - IGNITER_LEAD_S - 1e-9) {
        igniterDone = true;
        ev(TEA_TEB.has(stages[k].engineId) ? "tea-teb" : "igniter", k);
      } else if (sepDone && t >= stagingAt + SEP_DELAY_S + IGNITION_DELAY_S - 1e-9) {
        phase = "burn";
        ignitedAt = t;
        igniterDone = false;
        ev("ignition2");
      }
    }

    if (phase === "insert") {
      orbit = orbitOf(x, y, vx, vy);
      if (orbit.escape || orbit.perigee_m > PERIGEE_MIN) {
        remaining = remainingDeltaV(stages, k, propLeft, payload_kg);
        ev("orbit");
        const s = state();
        events.push({ t: round(t + RELEASE_AFTER_S, 2), type: "payload-release", alt_m: round(s.alt_m, 0), vel_ms: round(s.vel_ms, 1), stage: k, screen_s: 1 });
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
  if (record) normaliseHeat(samples);
  if (maxQAt) events.push({ t: round(maxQAt.t, 2), type: "maxq", alt_m: round(maxQAt.alt_m, 0), vel_ms: round(maxQAt.vel_ms, 1), stage: maxQAt.stage });
  events.sort((a, b) => a.t - b.t);
  return {
    samples,
    events,
    outcome,
    orbit,
    remaining,
    sep0,
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

// ---------- booster return (return to launch site) ----------
// For a first stage whose tank lists "landing-legs" in visuals.json (Falcon 9 today). After separation the
// booster flies on its own from the separation state with the propellant held in reserve (est.):
//   flip      3 s coast while it turns around;
//   boostback n engines (default 3), thrust horizontal toward the pad, until the predicted ballistic impact
//             (flat-Earth, vacuum) is at the aim point; the aim point is corrected over a few runs so the
//             landing (with drag) ends on the pad;
//   coast     ballistic;
//   entry     n engines (default 3), retrograde, up to 20 s, on the way down below 70 km while faster than
//             700 m/s (low boostback arcs never reach 70 km but still fall fast); stops early at 450 m/s;
//   descent   grid fins out: Cd 1.0 instead of 0.3 (model choice; same frontal area);
//   landing   1 engine (3 if one cannot out-push gravity with margin, as Falcon 9 has flown). Ignition: below
//             the no-drag closed-form height h = v_r^2 / (2 (0.9 T/m - g)), a short look-ahead (0.9 throttle,
//             retrograde, drag, gravity) predicts where the descent stops; the burn lights when that is at the
//             ground (drag changes too much on the way down for the closed form alone). Then closed loop,
//             thrust retrograde: throttle (0.4-1) so the vertical share delivers v_r^2/(2h) + g - 0.5 D_v/m
//             (drag averages about half its current value over the burn). If it stops above the pad, the
//             engine is cut and relit by the same trigger.
//   Touchdown below 2 m/s counts; faster, or out of propellant, is "lost".
// The reserve is the smallest share of the stage's propellant (bisection, then +1 % of the load) that lands
// within 10 km of the pad; the stage burns that much less, so MECO comes earlier. The reserve may not make the
// flight worse (a mission success stays one; a build already short of its mission still reaches the parking
// orbit). If returning to the pad would, a drone-ship landing is tried: no boostback, the booster comes down
// where its arc ends (the ship is stationed there), which needs far less propellant; that is what Falcon 9 does
// on GTO missions. If neither works, the booster is not recovered ("no-return") and the normal ascent is flown.
// Real Falcon 9 return reserves are roughly 10-15 % of the stage propellant for a pad return, less for a ship.
const BOOSTER = {
  flip_s: 3,
  boostbackEngines: 3,
  entryEngines: 3,
  entryAlt_m: 70e3,
  entry_s: 20,
  entryMinSpeed_ms: 700,
  entryStopSpeed_ms: 450,
  landingEngines: 1,
  cd: 1.0,
  landingDv_ms: 400, // propellant kept back for the landing burn while boostback and entry run (est.)
  touchdownMax_ms: 2,
  padRadius_m: 10e3,
  maxReserve: 0.45,
  modes: ["rtls", "droneship"], // tried in this order; the first that lands without costing the orbit wins
};

function flyBooster(sep, st, reserve_kg, cfg, { aim_m = 0, mode = "rtls", record = false, sampleEvery_s = 0.5 } = {}) {
  let { x, y, vx, vy } = sep;
  let t = sep.t;
  let prop = reserve_kg;
  const dryM = st.dry;
  const perFvac = st.Fvac / st.n;
  const perFsl = st.Fsl / st.n;
  const events = [];
  const samples = [];
  let phase = "flip";
  let phaseAt = t;
  let throttle = 0;
  let lit = 0;
  let nextSample = t;
  let result = null;
  let maxAlt = Math.hypot(x, y) - RE;
  let entryDone = false;
  let nextPredict = -Infinity; // the landing look-ahead is re-run only as the predicted stop nears the ground
  let landN = cfg.landingEngines;
  const downrange = () => RE * Math.atan2(x, y);
  const evb = (type, extra = null) => {
    events.push({ t: round(t, 2), type, alt_m: round(Math.hypot(x, y) - RE, 0), vel_ms: round(Math.hypot(vx, vy), 1), ...(extra ?? {}) });
    if (record) sampleB(true);
  };
  // Grid fins (visual, not physics): out after the flip; a small steering wiggle scaled by dynamic pressure
  // (up to +-4 deg at 20 kPa) while descending in the air.
  const finDeg = (h, v, vr) => {
    if (phase === "flip" || vr >= 0 || h > 80e3) return 0;
    const q = 0.5 * RHO0 * Math.exp(-Math.max(0, h) / SCALE_H) * v * v;
    const amp = 4 * Math.min(1, q / 20000);
    return amp * (0.6 * Math.sin(2 * Math.PI * 0.7 * t) + 0.4 * Math.sin(2 * Math.PI * 1.9 * t + 1));
  };
  const sampleB = (force = false) => {
    if (!record || (!force && t < nextSample - 1e-9)) return;
    if (!force) nextSample += sampleEvery_s;
    const r = Math.hypot(x, y);
    const h = r - RE;
    const v = Math.hypot(vx, vy);
    const vr = (vx * x + vy * y) / r;
    const rho = RHO0 * Math.exp(-Math.max(0, h) / SCALE_H);
    samples.push({
      t: round(t, 2),
      x_m: round(downrange(), 1),
      alt_m: round(h, 1),
      vel_ms: round(v, 2),
      throttle: round(throttle, 3),
      enginesLit: lit,
      mach: round(v / speedOfSound(h), 3),
      heat: h < 150e3 ? rho * v * v * v : 0, // normalised after the flight
      gridFin_deg: round(finDeg(h, v, vr), 2),
    });
  };
  const needFor = (dv) => (dryM + 0) * (Math.exp(dv / (st.ispVac * G0)) - 1);
  const landReserve = needFor(cfg.landingDv_ms);
  evb("flip");
  evb("cold-gas", { phase: "start" }); // the flip is done on cold-gas thrusters
  const end = sep.t + 1200;
  while (t < end) {
    const r = Math.hypot(x, y);
    const h = r - RE;
    const ur = [x / r, y / r];
    const ut = [ur[1], -ur[0]];
    const v = Math.hypot(vx, vy);
    const vr = vx * ur[0] + vy * ur[1];
    const vt = vx * ut[0] + vy * ut[1];
    const g = MU / (r * r);
    const pRatio = h > 0 ? Math.exp(-h / SCALE_H) : 1;
    const m = dryM + prop;
    const perF = Math.max(0, perFvac - (perFvac - perFsl) * pRatio);
    const isp = Math.max(1, st.ispVac - (st.ispVac - st.ispSl) * pRatio);
    let n = 0;
    throttle = 0;
    let dir = [0, 0];
    if (phase === "flip" && t >= phaseAt + cfg.flip_s) {
      evb("cold-gas", { phase: "end" });
      if (mode === "rtls") {
        phase = "boostback";
        evb("boostback");
      } else phase = "coast"; // drone ship: no boostback, the ship waits where the arc comes down
    }
    if (phase === "boostback") {
      // Predicted ballistic impact (flat Earth, no drag) from here.
      const tf = (vr + Math.sqrt(Math.max(0, vr * vr + 2 * g * Math.max(0, h)))) / g;
      const impact = downrange() + vt * tf;
      if (impact <= aim_m || prop <= landReserve + cfg.entryEngines * (perF / (isp * G0)) * cfg.entry_s * 0.5) {
        phase = "coast";
      } else {
        n = cfg.boostbackEngines;
        throttle = 1;
        dir = [-ut[0], -ut[1]];
      }
    }
    maxAlt = Math.max(maxAlt, h);
    if ((phase === "coast" || phase === "descent") && !entryDone && vr < 0 && h <= cfg.entryAlt_m && v > cfg.entryMinSpeed_ms) {
      entryDone = true;
      phase = "entry";
      phaseAt = t;
      evb("entry");
    }
    if (phase === "entry") {
      if (t >= phaseAt + cfg.entry_s || prop <= landReserve || v <= cfg.entryStopSpeed_ms) phase = "descent";
      else {
        n = cfg.entryEngines;
        throttle = 1;
        dir = v > 0 ? [-vx / v, -vy / v] : [0, 1];
      }
    }
    if (phase === "coast" && vr < 0 && h < cfg.entryAlt_m && v <= cfg.entryMinSpeed_ms) phase = "descent";
    if (phase === "descent" || phase === "landing") {
      const D0 = h < 150e3 && v > 0 ? 0.5 * RHO0 * pRatio * v * v * cfg.cd * st.area : 0;
      if (phase === "descent") {
        // One engine unless it cannot beat gravity with 2 m/s^2 to spare; then three (or all there are).
        landN = cfg.landingEngines;
        if (0.9 * landN * perF / m - g < 2) landN = Math.min(st.n, Math.max(landN, 3));
      }
      const Fmax = landN * perF;
      const Dv = v > 0 ? (D0 * -vr) / v : 0; // drag's upward share while descending
      const aNoDrag = (0.9 * Fmax) / m - g;
      if (phase === "descent" && vr < 0 && aNoDrag > 0 && h <= (vr * vr) / (2 * aNoDrag) && t >= nextPredict) {
        const s = stopHeight(h, vr, vt, m, 0.9 * Fmax, isp, cfg, st.area);
        if (s <= 0) {
          phase = "landing";
          evb("landing-burn");
        } else nextPredict = t + Math.min(2, (0.25 * s) / Math.max(1, -vr)); // a quarter of the time to close the gap
      }
      if (phase === "landing") {
        // Retrograde (as the look-ahead assumed), throttled so the vertical share of the thrust stops the
        // descent at 0 m: need v_r^2/(2h) + g - D_v/m; the horizontal speed shrinks in proportion.
        const hh = Math.max(h, 0.5);
        // Drag falls with v^2 during the burn: over a constant-deceleration stop it averages about half of
        // its value now, so only half is counted (counting all of it under-throttles early and lands hard).
        const aV = (vr * vr) / (2 * hh) + g - (0.5 * Dv) / m;
        const share = v > 0 && vr < 0 ? -vr / v : 1;
        n = landN;
        throttle = Math.max(MIN_THROTTLE, Math.min(1, (aV * m) / Math.max(1, Fmax * Math.max(0.2, share))));
        dir = v > 0.5 && vr < 0 ? [-vx / v, -vy / v] : [ur[0], ur[1]];
        // Stopped above the pad (minimum throttle still out-pushes gravity): cut and let the trigger relight.
        if (vr > -0.5 && h > 3) {
          phase = "descent";
          n = 0;
          throttle = 0;
        }
      }
    }
    if (n > 0 && prop <= 0) {
      n = 0;
      throttle = 0;
    }
    lit = n;
    const F = n * perF * throttle;
    const mdot = F > 0 ? F / (isp * G0) : 0;
    let dt = DT;
    if (mdot > 0 && mdot * dt > prop) dt = prop / mdot;
    // Euler-Cromer is enough here: short arcs, strong drag, and the controller closes the loop every step.
    const D = h < 150e3 && v > 0 ? 0.5 * RHO0 * pRatio * v * v * cfg.cd * st.area : 0;
    const ax = (-g * x) / r + (F * dir[0]) / m - (v > 0 ? (D / m) * (vx / v) : 0);
    const ay = (-g * y) / r + (F * dir[1]) / m - (v > 0 ? (D / m) * (vy / v) : 0);
    vx += ax * dt;
    vy += ay * dt;
    x += vx * dt;
    y += vy * dt;
    prop = Math.max(0, prop - mdot * dt);
    t += dt;
    sampleB();
    const hNow = Math.hypot(x, y) - RE;
    if (hNow <= 0) {
      // Interpolate the touchdown speed at h = 0 is not needed at 0.1 s: report the speed at ground contact.
      const vNow = Math.hypot(vx, vy);
      const ok = phase === "landing" && vNow < cfg.touchdownMax_ms;
      evb(ok ? "touchdown" : "lost");
      result = { landed: ok, touchdownSpeed_ms: vNow, landingX_m: downrange(), prop_kg: prop };
      break;
    }
  }
  if (!result) {
    evb("lost");
    result = { landed: false, touchdownSpeed_ms: Math.hypot(vx, vy), landingX_m: downrange(), prop_kg: prop };
  }
  if (record) normaliseHeat(samples);
  return { ...result, events, samples };
}

// Look-ahead for the landing burn: flat Earth, thrust F retrograde, drag, gravity; returns the height where the
// descent would stop (negative: it would hit the ground first, by that much "below" 0).
function stopHeight(h, vr, vt, m, F, isp, cfg, area) {
  const dt = 0.2;
  for (let i = 0; i < 1500; i++) {
    const v = Math.hypot(vr, vt);
    if (vr >= 0) return h;
    if (h <= 0) return h + vr * dt; // below ground: how far, roughly
    const rho = RHO0 * Math.exp(-Math.max(0, h) / SCALE_H);
    const D = 0.5 * rho * v * v * cfg.cd * area;
    const g = MU / ((RE + h) * (RE + h));
    const a = (F + D) / m;
    vr += (a * (-vr / v) - g) * dt;
    vt += a * (-vt / v) * dt;
    h += vr * dt;
    m -= (F / (isp * G0)) * dt;
  }
  return h;
}

// Booster return with the aim point corrected for drag (secant on the landing error, a few runs).
function returnBooster(sep, st, reserve_kg, cfg, record, mode = "rtls") {
  if (mode !== "rtls") return flyBooster(sep, st, reserve_kg, cfg, { mode, record });
  let aim = 0;
  let res = flyBooster(sep, st, reserve_kg, cfg, { aim_m: aim });
  let prevAim = null;
  let prevErr = null;
  for (let i = 0; i < 4 && res.landed && Math.abs(res.landingX_m) > 500; i++) {
    const err = res.landingX_m;
    const next = prevErr == null || err === prevErr ? aim - err : aim - (err * (aim - prevAim)) / (err - prevErr);
    prevAim = aim;
    prevErr = err;
    aim = next;
    res = flyBooster(sep, st, reserve_kg, cfg, { aim_m: aim });
  }
  return record ? flyBooster(sep, st, reserve_kg, cfg, { aim_m: aim, record: true }) : res;
}

export function simulateAscent(build, catalog, opts = {}) {
  if (!opts.ignoreVerdict) {
    const verdict = evaluateBuild(build, catalog);
    const blocking = verdict.warnings.filter((w) => !NON_BLOCKING.has(w) && !FLIGHT_EXEMPT.some((re) => re.test(w)));
    if (blocking.length) {
      return {
        samples: [],
        events: [],
        summary: {
          outcome: "blocked",
          reason: blocking[0],
          blockingWarnings: blocking,
          achievedDeltaV_ms: 0,
          gravityLoss_ms: 0,
          dragLoss_ms: 0,
          maxQ_Pa: 0,
          maxG: 0,
          burnTimes_s: [],
          perigee_km: null,
          apogee_km: null,
          remainingDeltaV_ms: null,
          booster: { returns: false, reason: "blocked", events: [], samples: [], propellantReserve_kg: 0 },
          est: true,
        },
      };
    }
  }
  const stagesFull = stagesOf(build, catalog);
  const payload = byId(catalog.payloads, build.payloadId);
  const mission = byId(catalog.missions, build.missionId);
  const leo = byId(catalog.missions, "leo");
  const empty = (why) => ({
    samples: [],
    events: [],
    summary: { outcome: "impact", achievedDeltaV_ms: 0, gravityLoss_ms: 0, dragLoss_ms: 0, maxQ_Pa: 0, maxG: 0, burnTimes_s: [], perigee_km: null, apogee_km: null, booster: { returns: false, reason: why }, error: why },
  });
  if (!stagesFull.length) return empty("empty build");
  if (stagesFull.some((s) => !s)) return empty("unknown engine or tank id");
  const payload_kg = payload?.mass_kg ?? 0;
  const exposed = catalog.visuals?.payloads?.[payload?.id]?.exposed === true;
  const increment_ms = mission && leo ? Math.max(0, mission.requiredDeltaV_ms - leo.requiredDeltaV_ms) : 0;
  const base = {
    targetAlt_m: opts.targetAlt_m ?? TARGET_ALT,
    maxQThrottle: opts.maxQThrottle ?? true,
    gLimit: opts.gLimit === undefined ? G_LIMIT : opts.gLimit ?? 0,
    sampleEvery_s: opts.sampleEvery_s ?? 0.5,
  };
  const tMax = capFor(stagesFull);
  // The first stage with `reserve_kg` of its propellant held back: it burns that much less and carries it.
  const withReserve = (reserve_kg) =>
    reserve_kg > 0 ? [{ ...stagesFull[0], prop: stagesFull[0].prop - reserve_kg, dry: stagesFull[0].dry + reserve_kg }, ...stagesFull.slice(1)] : stagesFull;
  // Tower clear at 1.2 x the stack height: opts.stackHeight_m (the UI knows the drawn height), else tank heights
  // + payload height + the first engine's sourced length (visuals.json) where there is one.
  const stackHeight_m =
    opts.stackHeight_m ??
    build.stages.reduce((s, st) => s + (byId(catalog.tanks, st.tankId)?.height_m ?? 0), 0) + (payload?.height_m ?? 0) + (catalog.visuals?.engines?.[build.stages[0]?.engineId]?.length_m ?? 0);
  const flyWith = (stages, kick_deg, record, extra = {}) =>
    fly(stages, payload_kg, Boolean(payload) && !exposed, increment_ms, { ...base, kick_deg, record, dt: record ? DT : SEARCH_DT, tMax, towerClear_m: 1.2 * stackHeight_m, ...extra });

  // Kick angle: coarse grid (1-45 deg, 2 deg steps), then golden-section refinement around the best point.
  // Light upper stages on a powerful first stage want large kicks (the demo build: ~27 deg).
  const searchKick = (stages) => {
    const run = (a) => score(flyWith(stages, a, false));
    let best = { kick: 3, s: -Infinity };
    for (let a = 1; a <= 45.01; a += 2) {
      const s = run(a);
      if (s > best.s) best = { kick: a, s };
    }
    let lo = Math.max(0.1, best.kick - 2);
    let hi = best.kick + 2;
    const phi = (Math.sqrt(5) - 1) / 2;
    let c = hi - phi * (hi - lo);
    let d = lo + phi * (hi - lo);
    let sc = run(c);
    let sd = run(d);
    for (let i = 0; i < 10; i++) {
      if (sc > sd) {
        hi = d;
        d = c;
        sd = sc;
        c = hi - phi * (hi - lo);
        sc = run(c);
      } else {
        lo = c;
        c = d;
        sc = sd;
        d = lo + phi * (hi - lo);
        sd = run(d);
      }
    }
    const k = sc > sd ? c : d;
    return Math.max(sc, sd) < best.s ? best.kick : k;
  };

  // Booster return: only for a first stage with landing legs and something above it.
  const legs = stagesFull.length > 1 && (catalog.visuals?.tanks?.[build.stages[0].tankId]?.features ?? []).includes("landing-legs");
  const cfg = { ...BOOSTER, ...(opts.booster ?? {}) };
  let booster = { returns: false, reason: legs ? null : "no landing legs on the first stage", events: [], samples: [], propellantReserve_kg: 0 };
  let stages = stagesFull;
  let kick = opts.kick_deg;
  let res = null;
  if (legs && opts.boosterReturn !== false) {
    const st0 = stagesFull[0];
    const kickR = kick ?? searchKick(withReserve(0.08 * st0.prop));
    // The reserve may not make the flight worse: a mission success must stay one; a build that already falls
    // short of its mission must still reach the parking orbit.
    const baseline = flyWith(stagesFull, kickR, false);
    const keepsOrbit = (frac) => {
      const r = frac > 0 ? flyWith(withReserve(frac * st0.prop), kickR, false) : baseline;
      return baseline.outcome === "orbit" ? r.outcome === "orbit" : r.remaining != null;
    };
    const sepState = (frac) => flyWith(withReserve(frac * st0.prop), kickR, false, { dt: DT, stopAtSep: true }).sep0;
    const lands = (frac, mode) => {
      const sep = sepState(frac);
      if (!sep) return null;
      const b = returnBooster(sep, st0, frac * st0.prop, cfg, false, mode);
      return b.landed && (mode !== "rtls" || Math.abs(b.landingX_m) <= cfg.padRadius_m) ? b : null;
    };
    let reason = null;
    if (baseline.remaining == null) reason = "the stack does not reach orbit even without a reserve";
    else if (!keepsOrbit(0.02)) reason = "even a 2 % reserve costs the orbit";
    else {
      // Largest reserve that still reaches orbit (coarse ascent runs), then the smallest that lands, per mode.
      let lo = 0.02;
      let hi = cfg.maxReserve;
      if (keepsOrbit(hi)) lo = hi;
      for (let i = 0; i < 7 && hi - lo > 0.005; i++) {
        const mid = (lo + hi) / 2;
        if (keepsOrbit(mid)) lo = mid;
        else hi = mid;
      }
      const fMax = lo;
      const tried = [];
      for (const mode of cfg.modes) {
        if (!lands(fMax, mode)) {
          tried.push(`${mode === "rtls" ? "return to the pad" : "drone ship"} needs more than the ${Math.round(fMax * 100)} % the orbit allows`);
          continue;
        }
        let a = 0.02;
        let b = fMax;
        if (lands(a, mode)) b = a;
        for (let i = 0; i < 6 && b - a > 0.005; i++) {
          const mid = (a + b) / 2;
          if (lands(mid, mode)) b = mid;
          else a = mid;
        }
        // The searches use the minimum share that lands; the recorded flight takes 1 % more, and steps up by
        // 2 % (at most twice, never past fMax) if the recorded flight still misses.
        let frac = 0;
        let asc = null;
        let ret = null;
        for (const extra of [0.01, 0.03, 0.05]) {
          frac = Math.min(fMax, b + extra);
          asc = flyWith(withReserve(frac * st0.prop), kickR, true);
          const ok = (baseline.outcome === "orbit" ? asc.outcome === "orbit" : asc.remaining != null) && asc.sep0;
          ret = ok ? returnBooster(asc.sep0, st0, frac * st0.prop, cfg, true, mode) : null;
          if (ret && ret.landed && (mode !== "rtls" || Math.abs(ret.landingX_m) <= cfg.padRadius_m)) break;
          ret = null;
          if (frac >= fMax) break;
        }
        if (!ret) {
          tried.push(`${mode === "rtls" ? "return to the pad" : "drone ship"}: the recorded flight missed at ${Math.round(frac * 100)} %`);
          continue;
        }
        const reserve = frac * st0.prop;
        stages = withReserve(reserve);
        kick = kickR;
        res = asc;
        const hot = ret.samples.filter((s) => s.heat > 0.25);
        booster = {
          returns: true,
          mode, // "rtls" (back to the pad) | "droneship" (lands where the arc comes down)
          sea: mode === "droneship",
          droneShip: mode === "droneship" ? { x_m: round(ret.landingX_m, 1), alt_m: 0 } : null,
          heating: hot.length ? { start_t: hot[0].t, end_t: hot.at(-1).t, peak_t: ret.samples.find((s) => s.heat === 1)?.t ?? null } : null,
          events: ret.events,
          samples: ret.samples,
          propellantReserve_kg: reserve,
          reserveFraction: frac,
          touchdownSpeed_ms: ret.touchdownSpeed_ms,
          landingDownrange_m: ret.landingX_m,
          propellantLeft_kg: ret.prop_kg,
          note: tried.length ? tried.join("; ") : null,
          est: true,
        };
        break;
      }
      if (!booster.returns) reason = tried.join("; ") || "no landing found";
    }
    if (reason) booster = { ...booster, returns: false, reason: `no-return: ${reason}` };
  }
  if (!res) {
    kick = kick ?? searchKick(stagesFull);
    res = flyWith(stagesFull, kick, true);
  }
  return {
    samples: res.samples,
    events: res.events,
    summary: {
      ...res.summary,
      kick_deg: round(kick, 3),
      targetAlt_km: base.targetAlt_m / 1000,
      stackHeight_m: round(stackHeight_m, 1),
      remainingDeltaV_ms: res.remaining,
      mission: mission
        ? {
            id: mission.id,
            beyondLEO_ms: increment_ms,
            shortBy_ms: res.remaining == null ? null : Math.max(0, increment_ms - res.remaining),
          }
        : null,
      booster,
      est: true,
    },
  };
}
