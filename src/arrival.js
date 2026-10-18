// The planet ending: what happens after the rocket's job is done. Pure: no DOM; all est.
//   arrivalTimeline(build, catalog, ascentSummary) -> { body, success, lands, lines, legs, mission, shortBy_ms, est }
//   legs: [{ type: "orbit" | "transfer" | "descent" | "touchdown" | "stranded", seconds, alt_km, note, body }]
//   (seconds = screen time; all legs together take at most 8 s)
//   descentTimeline(payload, opts?) -> samples for the touchdown animation (see the bottom of this file)
// Rules (no physics beyond missions.json and ascent.js):
// - body from the mission: leo / gto / earth-escape -> earth; moon-transfer / lunar-orbit -> moon;
//   mars-transfer -> mars.
// - success = ascentSummary.remainingDeltaV_ms >= the mission's beyond-LEO increment (mission.requiredDeltaV_ms
//   - leo.requiredDeltaV_ms; missions.json builds every mission as 9,400 m/s to LEO plus that increment). The
//   rocket's job ends at injection; anything after (orbit insertion at the target, descent, landing) is the
//   spacecraft's own propulsion, and the notes say so.
// - lands = success, the payload archetype (visuals.json) is lander or capsule, and the body is not Earth.
//   A capsule stack (Apollo CSM + LM) lands its lander; a lander lands itself. Telescopes and satellites end
//   in orbit of the body. Earth escape ends on the departure.
// - Short (in parking orbit but not enough left) -> stranded in Earth parking orbit, "short by N m/s".
//   No parking orbit at all -> no legs, one line saying how the ascent ended ("Pad abort · <reason>" when the
//   verdict blocked the flight).
// alt_km is only given where the simulation has it (the parking orbit); the data has no altitudes for the
// target orbits, so those legs carry null.

const BODY = { leo: "earth", gto: "earth", "earth-escape": "earth", "moon-transfer": "moon", "lunar-orbit": "moon", "mars-transfer": "mars" };
const BODY_NAME = { earth: "Earth", moon: "the Moon", mars: "Mars" };
const SCREEN_S = 8;

const byId = (list, id) => (id ? list?.find((x) => x.id === id) : undefined);
const num = (v) => Math.round(v).toLocaleString("en-US");

// Spread the screen time over the legs by weight, total SCREEN_S, one decimal.
function timed(legs) {
  const w = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const out = legs.map(({ weight, ...l }) => ({ ...l, seconds: Math.round(((SCREEN_S * weight) / w) * 10) / 10 }));
  let over = out.reduce((s, l) => s + l.seconds, 0) - SCREEN_S;
  for (let i = out.length - 1; i >= 0 && over > 1e-9; i--) {
    const cut = Math.min(over, out[i].seconds);
    out[i].seconds = Math.round((out[i].seconds - cut) * 10) / 10;
    over -= cut;
  }
  return out;
}

export function arrivalTimeline(build, catalog, ascentSummary) {
  const mission = byId(catalog.missions, build.missionId);
  const leo = byId(catalog.missions, "leo");
  const payload = byId(catalog.payloads, build.payloadId);
  const archetype = catalog.visuals?.payloads?.[payload?.id]?.archetype ?? null;
  const body = BODY[mission?.id] ?? "earth";
  const increment = mission && leo ? Math.max(0, mission.requiredDeltaV_ms - leo.requiredDeltaV_ms) : 0;
  const remaining = ascentSummary?.remainingDeltaV_ms;
  const inOrbit = remaining != null;
  const success = inOrbit && remaining + 1e-6 >= increment;
  const lands = success && (archetype === "lander" || archetype === "capsule") && body !== "earth";
  const shortBy = inOrbit ? Math.max(0, increment - remaining) : null;
  const what = payload?.name ? payload.name.replace(/\s*\([^)]*\)\s*$/, "") : "the payload"; // drop "(stowed)" etc.
  const goal = mission?.name ?? "the mission";
  const parkKm = ascentSummary?.perigee_km != null ? Math.round(ascentSummary.perigee_km) : null;
  const parkLine =
    parkKm != null && Number.isFinite(ascentSummary.apogee_km) ? `${parkKm} × ${Math.round(ascentSummary.apogee_km)} km Earth parking orbit (est.)` : "Earth parking orbit (est.)";

  const result = (legs, lines) => ({ body, success, lands, lines, legs: timed(legs), mission: mission?.id ?? null, shortBy_ms: shortBy, est: true });

  if (ascentSummary?.outcome === "blocked") return result([], [`Pad abort · ${ascentSummary.reason}`]);
  if (!inOrbit) {
    const how = ascentSummary?.outcome === "shortfall" ? "reached space but not orbit, and fell back" : "never reached orbit";
    return result([], [`The rocket ${how} (est.).`]);
  }
  const park = { type: "orbit", alt_km: parkKm, body: "earth", note: `Parking orbit: ${parkLine}.` };
  if (!success) {
    return result(
      [
        { ...park, weight: 3 },
        {
          type: "stranded",
          alt_km: parkKm,
          body: "earth",
          note: `Short by ${num(shortBy)} m/s for ${goal}: ${num(remaining)} m/s left after orbit, ${num(increment)} needed beyond LEO (est.).`,
          weight: 5,
        },
      ],
      [`Stranded in a ${parkLine}.`, `Short by ${num(shortBy)} m/s for ${goal} (est.).`],
    );
  }

  const legs = [{ ...park, weight: 2 }];
  const lines = [`${parkLine[0].toUpperCase()}${parkLine.slice(1)}.`];
  if (mission?.id === "leo") {
    legs[0].weight = 8;
    lines.push(`${what} is in low Earth orbit (est.).`);
    return result(legs, lines);
  }
  const injection = `${num(remaining)} m/s left after orbit for ${num(increment)} needed (est.)`;
  const dest = mission?.destination ?? goal;
  legs.push({ type: "transfer", alt_km: null, body, note: `The rocket's last burn puts ${what} on its way: ${dest}; ${injection}. The rocket's job ends here.`, weight: 3 });
  lines.push(`Injection: ${dest}; ${injection}.`);
  const own = `${what}'s own propulsion`;
  if (mission?.id === "earth-escape") {
    legs[1].weight = 6; // the departure is the ending: no orbit after it
    lines.push(`${what} leaves Earth's gravity; from here its own propulsion takes over.`);
    return result(legs, lines);
  }
  if (body === "earth") {
    legs.push({ type: "orbit", alt_km: null, body: "earth", note: `${goal} reached; anything further (e.g. a final orbit) is ${own}.`, weight: 3 });
    lines.push(`${goal} reached; from here ${what}'s own propulsion takes over.`);
    return result(legs, lines);
  }
  if (!lands) {
    legs.push({ type: "orbit", alt_km: null, body, note: `${what} ends in orbit of ${BODY_NAME[body]} using ${own}.`, weight: 3 });
    lines.push(`${what} ends in orbit of ${BODY_NAME[body]} (its own propulsion).`);
    return result(legs, lines);
  }
  legs.push({ type: "orbit", alt_km: null, body, note: `${what} brakes into orbit of ${BODY_NAME[body]} with ${own}.`, weight: 1 });
  // A capsule stack (Apollo) lands its lander; a lander lands itself.
  const who = archetype === "capsule" ? `${what}: its lander` : what;
  legs.push({ type: "descent", alt_km: null, body, note: `${who} descends with its own engine.`, weight: 1.2 });
  legs.push({ type: "touchdown", alt_km: 0, body, note: `Touchdown on ${BODY_NAME[body]}.`, weight: 0.8 });
  lines.push(`${who} lands on ${BODY_NAME[body]} with its own engine (est.).`);
  return result(legs, lines);
}

// ---------- bodies: constants from NASA's planetary fact sheets ----------
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html, .../marsfact.html, .../earthfact.html
//   Moon: "GM (x 10^6 km^3/s^2) 0.00490", "Volumetric mean radius (km) 1737.4", "Surface gravity (m/s^2) 1.62",
//         "Surface pressure (night): 3 x 10^-15 bar".
//   Mars: "GM ... 0.042828", "Volumetric mean radius (km) 3389.5", "Surface gravity (mean) (m/s^2) 3.73",
//         "Surface pressure: 6.36 mb at mean radius (variable from 4.0 to 8.7 mb depending on season)",
//         "Surface density: ~0.016 +/- 0.006 kg/m3", "Scale height: 11.0 km".
//   Earth: "Surface pressure: 1014 mb", "Surface density: 1.217 kg/m3", "Scale height: 8.5 km".
const FACTS = {
  moon: { gm: 0.0049e15, radius_m: 1737.4e3, g: 1.62, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html" },
  mars: { gm: 0.042828e15, radius_m: 3389.5e3, g: 3.73, p0_Pa: 636, rho0: 0.016, H_m: 11.0e3, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html" },
  earth: { p0_Pa: 101400, rho0: 1.217, H_m: 8.5e3, source: "https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html" },
};

// Atmosphere constants for the planet shader (UI4). Moon: none.
export function atmosphereFor(body) {
  if (body === "moon") return { none: true, scaleHeight_m: null, surfacePressure_Pa: 0, surfaceDensity_kgm3: 0, colourHint: null, source: `${FACTS.moon.source} ("Surface pressure (night): 3 x 10^-15 bar": effectively none)` };
  const f = FACTS[body] ?? FACTS.earth;
  return {
    none: false,
    scaleHeight_m: f.H_m,
    surfacePressure_Pa: f.p0_Pa,
    surfaceDensity_kgm3: f.rho0,
    colourHint: body === "mars" ? "#d8a273" : "#6fa8ff", // visual hint only
    source: f.source,
    note: body === "mars" ? "NASA's fact sheet gives 6.36 mb (636 Pa) at mean radius, 4.0-8.7 mb by season; the often-quoted 610 Pa is not on it." : "Fact-sheet values; the ascent itself uses ISA sea level (101,325 Pa, 1.225 kg/m3).",
  };
}

// Sun and light per body for the ending scenes (visual choices, not data). sunDir is a unit vector in the site
// frame: +x east, +y up, +z south. Earth: dawn terminator over the site; Moon: low sun (12 deg) near the
// terminator (long shadows); Mars: mid-morning.
export function lightingFor(body) {
  const dir = (elev_deg, az_deg) => {
    const e = (elev_deg * Math.PI) / 180;
    const a = (az_deg * Math.PI) / 180; // from east, toward south
    return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)].map((v) => Math.round(v * 1e4) / 1e4);
  };
  if (body === "moon") return { body, sunDir: dir(12, 15), sunElevation_deg: 12, ambient: 0.02, skyColour: "#000000", note: "low sun near the terminator: long shadows, black sky (no air); 12 deg so the lander's shadow stays clear of crater shadows" };
  if (body === "mars") return { body, sunDir: dir(35, 25), sunElevation_deg: 35, ambient: 0.25, skyColour: "#c9a27a", note: "mid-morning, dusty butterscotch sky (hint)" };
  return { body: "earth", sunDir: dir(2, 0), sunElevation_deg: 2, ambient: 0.08, skyColour: "#0b0d12", limbGlowHint: "#e8a36a", note: "dawn terminator under the parking orbit" };
}

// ---------- powered descent (est.; every number below is a model choice; the dataset has no lander engine data,
// so throttle is a shape only) ----------
// descentTimeline(payload, { body = "moon" }) -> { body, payloadId, screen_s: 15, phases, moments, samples,
//   touchdown_ms, brakingAccel_ms2, approachAccel_ms2, entry, est, note }
// samples: [{ t_screen, t_s, phase, alt_m, downrange_m, vel_ms, pitch_deg, throttle, dust, heat, chute }]
//   pitch_deg is the thrust axis from vertical (0 = upright, 90 = horizontal); dust = throttle * clamp(1 - alt/30 m);
//   heat is the aeroshell glow (rho v^3 normalised over the aeroshell phase, 0..1), 0 elsewhere; chute is the
//   parachute (0 packed, inflating 0 -> 1, 1 open), 0 once released.
// moments: [{ type, t_screen, t_s, alt_m, vel_ms }] - Mars: heatshield-sep (= chute open), chute-release;
//   both: touchdown.
// Moon: braking burn from a 15 km circular orbit (speed from the fact-sheet GM and radius), horizontal speed bled
//   off at a constant 3 m/s^2 to 50 m/s, pitch 80 -> 55 deg, throttle 1.0 then 0.6 for the last quarter; approach
//   from 2.3 km to 150 m at 30 deg pitch, horizontal 50 -> 3 m/s; vertical descent from 150 m, 5 -> 1 m/s with
//   throttle modulation; touchdown at 1 m/s. The vertical profile is a chain of constant-acceleration segments so
//   altitude and speed are continuous.
// Mars, with the two things real landers carry (model choices):
//   entry      from 120 km at 5.5 km/s and -10 deg inside an aeroshell 1.6 x the payload diameter (Cd 1.5),
//              drag integrated with the fact-sheet density, scale height and mean gravity;
//   parachute  opens at Mach 2, taken as 480 m/s (or at 3 km if still faster: reported); Cd 0.6, canopy
//              6 x the payload diameter, inflating over 1.5 s; the heat shield separates at chute open; flown
//              until 1.5 km or 60 m/s;
//   powered    from the chute release straight into the approach (no braking burn is needed under a chute) to
//              150 m at 15 deg, then the same vertical descent as on the Moon.
const SCREEN = { moon: { braking: 6.5, approach: 4, vertical: 4.5 }, mars: { entry: 4.5, parachute: 4, approach: 3, vertical: 3.5 } };
const STEP = 0.1; // screen seconds per sample
const MARS = { aeroshellScale: 1.6, aeroCd: 1.5, chuteOpen_ms: 480, chuteFloor_m: 3000, chuteCd: 0.6, chuteScale: 6, inflate_s: 1.5, release_m: 1500, release_ms: 60 };

// Point mass over a flat surface with the curvature term, gravity and drag (est.). dragArea(t, state) gives Cd*A.
function integrate(st, f, mass, dragArea, stop, dt = 0.1, tMax = 3000) {
  let { t, h, v, gamma, x } = st;
  const out = [];
  while (!stop({ t, h, v, gamma }) && t < tMax && h > 0) {
    const rho = f.rho0 * Math.exp(-Math.max(0, h) / f.H_m);
    out.push({ t, h, v, gamma, x, rho });
    const drag = (0.5 * rho * v * v * dragArea(t, { h, v })) / mass;
    v += (-drag - f.g * Math.sin(gamma)) * dt;
    gamma += ((-f.g * Math.cos(gamma)) / Math.max(1, v) + (v * Math.cos(gamma)) / (f.radius_m + h)) * dt;
    h += v * Math.sin(gamma) * dt;
    x += v * Math.cos(gamma) * dt;
    t += dt;
  }
  const rho = f.rho0 * Math.exp(-Math.max(0, h) / f.H_m);
  out.push({ t, h, v, gamma, x, rho });
  return out;
}

function marsArrival(payload) {
  const f = FACTS.mars;
  const m = payload?.mass_kg ?? 1000;
  const D = payload?.diameter_m ?? 2;
  const aeroArea = MARS.aeroCd * Math.PI * ((MARS.aeroshellScale * D) / 2) ** 2;
  const entry = integrate({ t: 0, h: 120e3, v: 5500, gamma: (-10 * Math.PI) / 180, x: 0 }, f, m, () => aeroArea, (s) => s.v <= MARS.chuteOpen_ms || s.h <= MARS.chuteFloor_m);
  const maxHeat = entry.reduce((a, s) => Math.max(a, s.rho * s.v ** 3), 0) || 1;
  for (const s of entry) s.heat = (s.rho * s.v ** 3) / maxHeat;
  let at10 = null;
  for (let i = 1; i < entry.length; i++) {
    if (entry[i - 1].h > 10e3 && entry[i].h <= 10e3) {
      const k = (entry[i - 1].h - 10e3) / (entry[i - 1].h - entry[i].h);
      at10 = entry[i - 1].v + k * (entry[i].v - entry[i - 1].v);
    }
  }
  const open = entry.at(-1);
  // Under the chute: the heat shield is gone; the lander's own body (Cd 1.5 on its diameter) plus the canopy.
  const bodyArea = 1.5 * Math.PI * (D / 2) ** 2;
  const canopyArea = MARS.chuteCd * Math.PI * ((MARS.chuteScale * D) / 2) ** 2;
  const t0 = open.t;
  const chute = integrate(open, f, m, (t) => bodyArea + canopyArea * Math.min(1, (t - t0) / MARS.inflate_s), (s) => s.h <= MARS.release_m || (s.v <= MARS.release_ms && s.t > t0 + MARS.inflate_s));
  for (const s of chute) s.chute = Math.min(1, (s.t - t0) / MARS.inflate_s);
  return {
    entry,
    chute,
    speedAt10km_ms: at10,
    open: { alt_m: open.h, vel_ms: open.v, floor: open.v > MARS.chuteOpen_ms },
    release: chute.at(-1),
    beta: m / aeroArea,
    canopy_m: MARS.chuteScale * D,
    aeroshell_m: MARS.aeroshellScale * D,
  };
}

// The powered phases, each a function of its own sim time: [{ name, T, at(tau) -> state }].
// braking = false (Mars, under a chute): straight into the approach from the start state.
function poweredPhases(g, start, gate_m, { braking = true, approachPitch = 30 } = {}) {
  const phases = [];
  let hA = start.h;
  let vvA = start.vv; // positive down
  let vhA = start.vh;
  let pitchA = start.pitch0;
  phases.brakingAccel_ms2 = 0;
  if (braking) {
    const vh0 = start.vh;
    const vv0 = start.vv;
    const hb = start.h - gate_m;
    // Bleed horizontal speed at 3 m/s^2 and pick the descent rate that reaches the gate in that time; if the
    // vehicle already falls too fast for that, the altitude budget sets the time (end descent rate 50 m/s).
    let Tb = Math.max(20, (vh0 - 50) / 3);
    let vvb = (2 * hb) / Tb - vv0;
    if (vvb < 5) {
      vvb = 50;
      Tb = (2 * hb) / (vv0 + vvb);
    }
    phases.push({
      name: "braking",
      T: Tb,
      at: (tau) => {
        const s = tau / Tb;
        return { alt: start.h - (vv0 * tau + ((vvb - vv0) * tau * tau) / (2 * Tb)), vh: vh0 + (50 - vh0) * s, vv: vv0 + (vvb - vv0) * s, pitch: start.pitch0 + (55 - start.pitch0) * s, throttle: s < 0.75 ? 1 : 0.6 };
      },
    });
    phases.brakingAccel_ms2 = Math.hypot((vh0 - 50) / Tb, (vv0 - vvb) / Tb + g);
    hA = gate_m;
    vvA = vvb;
    vhA = 50;
    pitchA = 55;
  }
  // approach: hA -> 150 m; descent rate vvA -> 5 m/s (constant acceleration), horizontal vhA -> 3 m/s.
  const Ta = (2 * (hA - 150)) / (vvA + 5);
  phases.approachAccel_ms2 = Math.hypot((vhA - 3) / Ta, (vvA - 5) / Ta + g);
  phases.push({
    name: "approach",
    T: Ta,
    at: (tau) => {
      const s = tau / Ta;
      return {
        alt: hA - (vvA * tau + ((5 - vvA) * tau * tau) / (2 * Ta)),
        vh: vhA + (3 - vhA) * s,
        vv: vvA + (5 - vvA) * s,
        pitch: s < 0.1 ? pitchA + (approachPitch - pitchA) * (s / 0.1) : approachPitch,
        throttle: 0.55,
      };
    },
  });
  // vertical: 150 m -> 0, 5 -> 1 m/s, horizontal 3 -> 0, pitch -> 0 in the first 15 %, throttle modulation.
  const Tv = (2 * 150) / (5 + 1);
  phases.push({
    name: "vertical",
    T: Tv,
    at: (tau) => {
      const s = tau / Tv;
      return {
        alt: Math.max(0, 150 - (5 * tau + ((1 - 5) * tau * tau) / (2 * Tv))),
        vh: 3 * (1 - s),
        vv: 5 + (1 - 5) * s,
        pitch: s < 0.15 ? approachPitch * (1 - s / 0.15) : 0,
        throttle: s >= 1 ? 0 : Math.min(1, Math.max(0, 0.45 + 0.06 * Math.sin((2 * Math.PI * tau) / 6))),
      };
    },
  });
  return phases;
}

export function descentTimeline(payload, { body = "moon" } = {}) {
  const b = body === "mars" ? "mars" : "moon";
  const screen = SCREEN[b];
  const samples = [];
  const moments = [];
  const phasesOut = [];
  let tScreen = 0;
  let tSim = 0;
  let x = 0;
  const r1 = (v) => Math.round(v * 10) / 10;
  const push = (phase, st) => {
    samples.push({
      t_screen: Math.round(tScreen * 100) / 100,
      t_s: r1(tSim),
      phase,
      alt_m: r1(st.alt),
      downrange_m: r1(x),
      vel_ms: Math.round(Math.hypot(st.vh, st.vv) * 100) / 100,
      pitch_deg: r1(st.pitch),
      throttle: Math.round(st.throttle * 1000) / 1000,
      dust: Math.round(st.throttle * Math.min(1, Math.max(0, 1 - st.alt / 30)) * 1000) / 1000,
      heat: Math.round((st.heat ?? 0) * 1000) / 1000,
      chute: Math.round((st.chute ?? 0) * 1000) / 1000,
    });
  };
  const moment = (type, st) => moments.push({ type, t_screen: Math.round(tScreen * 100) / 100, t_s: r1(tSim), alt_m: r1(st.alt), vel_ms: r1(Math.hypot(st.vh, st.vv)) });
  // A drag-integrated track shown over `secs` of screen time (linear in sim time).
  const showTrack = (name, track, secs, extra) => {
    const n = Math.round(secs / STEP);
    const T0 = track[0].t;
    const T = track.at(-1).t - T0;
    const t0Screen = tScreen;
    for (let i = 0; i < n; i++) {
      const tt = T0 + (T * i) / n;
      let k = 0;
      while (k < track.length - 1 && track[k + 1].t <= tt) k++;
      const s = track[k];
      x = s.x;
      tSim = s.t;
      tScreen = t0Screen + (secs * i) / n;
      push(name, { alt: s.h, vh: s.v * Math.cos(s.gamma), vv: -s.v * Math.sin(s.gamma), throttle: 0, ...extra(s) });
    }
    const last = track.at(-1);
    x = last.x;
    tSim = last.t;
    tScreen = t0Screen + secs;
    phasesOut.push({ name, t_screen_start: Math.round(t0Screen * 100) / 100, t_screen_end: Math.round(tScreen * 100) / 100, t_s: Math.round(T) });
    return last;
  };

  let start;
  let entry = null;
  if (b === "mars") {
    const a = marsArrival(payload);
    // aeroshell entry: heat glow; pitch along the flight path, capped at horizontal (a ballistic entry can skip)
    const open = showTrack("entry", a.entry, screen.entry, (s) => ({ pitch: Math.min(90, 90 + (s.gamma * 180) / Math.PI), heat: s.heat }));
    const openSt = { alt: open.h, vh: open.v * Math.cos(open.gamma), vv: -open.v * Math.sin(open.gamma) };
    moment("heatshield-sep", openSt);
    moment("chute-open", openSt);
    // under the chute the lander hangs: pitch 0
    const rel = showTrack("parachute", a.chute, screen.parachute, (s) => ({ pitch: 0, chute: s.chute }));
    const relSt = { alt: rel.h, vh: rel.v * Math.cos(rel.gamma), vv: -rel.v * Math.sin(rel.gamma) };
    moment("chute-release", relSt);
    entry = {
      aeroshell_m: r1(a.aeroshell_m),
      ballisticCoeff_kgm2: Math.round(a.beta),
      speedAt10km_ms: a.speedAt10km_ms == null ? null : Math.round(a.speedAt10km_ms),
      chuteOpen: { alt_m: Math.round(a.open.alt_m), vel_ms: Math.round(a.open.vel_ms), mach2Reached: !a.open.floor },
      canopy_m: r1(a.canopy_m),
      chuteRelease: { alt_m: Math.round(rel.h), vel_ms: Math.round(rel.v) },
    };
    start = { h: rel.h, vh: relSt.vh, vv: relSt.vv, pitch0: 0 };
  } else {
    const f = FACTS.moon;
    start = { h: 15e3, vh: Math.sqrt(f.gm / (f.radius_m + 15e3)), vv: 0, pitch0: 80 };
  }
  const phases = poweredPhases(FACTS[b].g, start, 2300, b === "mars" ? { braking: false, approachPitch: 15 } : {});
  for (const ph of phases) {
    const n = Math.round(screen[ph.name] / STEP);
    const t0Screen = tScreen;
    const t0Sim = tSim;
    let prev = ph.at(0);
    for (let i = 0; i < n; i++) {
      const tau = (ph.T * i) / n;
      const st = ph.at(tau);
      if (i > 0) x += ((prev.vh + st.vh) / 2) * (ph.T / n);
      prev = st;
      tScreen = t0Screen + (screen[ph.name] * i) / n;
      tSim = t0Sim + tau;
      push(ph.name, st);
    }
    x += ((prev.vh + ph.at(ph.T).vh) / 2) * (ph.T / n);
    tScreen = t0Screen + screen[ph.name];
    tSim = t0Sim + ph.T;
    phasesOut.push({ name: ph.name, t_screen_start: Math.round(t0Screen * 100) / 100, t_screen_end: Math.round(tScreen * 100) / 100, t_s: Math.round(ph.T) });
  }
  const last = phases.at(-1).at(phases.at(-1).T);
  push("touchdown", { ...last, alt: 0, throttle: 0 });
  moment("touchdown", { ...last, alt: 0 });
  const touchdown = Math.hypot(last.vh, last.vv);
  const brakingAccel = Math.round(phases.brakingAccel_ms2 * 10) / 10;
  const approachAccel = Math.round(phases.approachAccel_ms2 * 10) / 10;
  return {
    body: b,
    payloadId: payload?.id ?? null,
    screen_s: Object.values(screen).reduce((a, v) => a + v, 0),
    phases: phasesOut,
    moments,
    samples,
    touchdown_ms: Math.round(touchdown * 100) / 100,
    brakingAccel_ms2: brakingAccel, // thrust acceleration the braking burn implies (0 on Mars: no braking burn)
    approachAccel_ms2: approachAccel, // thrust acceleration the approach implies
    entry,
    est: true,
    note:
      "Model choices for the animation (est.): the dataset has no lander engine data, so throttle is a shape only. " +
      (b === "mars"
        ? `Like a real Mars lander it gets an aeroshell (${entry.aeroshell_m} m, 1.6 x its diameter, Cd 1.5) and a supersonic parachute (${entry.canopy_m} m canopy, Cd 0.6): ${entry.speedAt10km_ms ?? "–"} m/s at 10 km, chute open at ${entry.chuteOpen.vel_ms} m/s and ${(entry.chuteOpen.alt_m / 1000).toFixed(1)} km${entry.chuteOpen.mach2Reached ? "" : " (forced at the 3 km floor: it never slowed to Mach 2)"}, released at ${(entry.chuteRelease.alt_m / 1000).toFixed(1)} km and ${entry.chuteRelease.vel_ms} m/s, then a powered approach (about ${approachAccel} m/s^2 of thrust) and vertical descent. Aeroshell, chute and their sizes are model choices, not dataset records.`
        : `Braking from a 15 km orbit (about ${brakingAccel} m/s^2 of thrust), approach at 30 deg, vertical descent from 150 m.`),
  };
}
