// Launch factors: is the range GO today? Pure: no DOM. The conditions are simulated (est.); the rules are real.
//   assessLaunch({ build, verdict?, seed?, conditions?, presetId?, day?, attempt? })
//     -> { go, hud, lines, conditions, blockers, cautions, window, seedKey, est }
//   effectsForFlight(assessmentOrConditions) -> { wind_ms, windDrift_ms, stormGlow, scrub, scrubReason, lightning }
//   simulateConditions(seedKey, build?) -> conditions; CALM_CONDITIONS; planeChangeDeltaV_ms(v_ms, di_deg)
// Every threshold comes from src/data/hazards.json with its URL and a verbatim quote; each blocker/caution carries
// that rule's quote (rule) and URL (source). Nothing here is a real forecast.
//
// Seed: default `${presetId ?? build key}|${day}` (day = local YYYY-MM-DD, or opts.day), so one rocket gets one
// sky per day; `attempt` (1, 2, ...) appends "#n" for the next window after a scrub; `seed` (number or string)
// replaces the whole key. Same key, same conditions (FNV-1a + mulberry32).
// `conditions` overrides single generated fields (e.g. { lightning_nm: 6 }); gScale and the wind limit are always
// derived. `verdict` is accepted for the call shape but not used: the vehicle's own GO stays with physics/ascent.js
// (pad abort), so `go` here is the range and space environment only.
//
// Rules (hazards.json ids; "est." = demo model choice, not a published rule):
// - Pad wind (sustained, kt) above the first stage's limit: Falcon 9 booster 30 mph (26.1 kt, derived), Atlas V
//   booster 33 kt; other vehicles have no published limit here, so the Falcon 9 one stands in (est.).
// - Lightning within 10 nm in the last 30 min, anvil (attached or detached) or freezing-top cumulus within 10 nm,
//   a thick freezing cloud layer on the path, field mill above 1,500 V/m: scrub. The sheets' "unless specified
//   criteria can be met" exceptions are not modelled.
// - Upper-level shear: low / moderate / high; high = "could lead to control problems" (est.: the real rule is a
//   loads simulation on balloon winds, no single number).
// - Space weather (NOAA scales): G4+ (Kp 8+) holds (est., on the ESCAPADE precedent); S4+ holds (est., NOAA's S4
//   wording); G1-G3, S2-S3 and R3+ are cautions with NOAA's stated effects. Any storm adds the low-orbit drag
//   caution (Starlink 2022 precedent; ascent.js parks at 200 km).
// - Debris (FAA 14 CFR 450.169): collision probability above 1e-6 with a crewed station or 1e-5 with any other
//   object closes the window: scrub. Above NASA CARA's 1E-07 "operational attention": caution.
// - Cautions also flag winds above 80 % of the limit, lightning 10-20 nm away and field mills above 1,000 V/m (est.).
//
// Simulated ranges (all est., tuned to about one scrub in five): a stormy day 10 %, a windy front 8 %; calm winds
// 2-16 kt, front 18-34 kt, storm 8-24 kt; shear low 80 % / moderate 16 % / high 4 %; storm lightning 75 % of stormy
// days at 0.5-30 nm; field 40-300 V/m fair, 200-3,000 V/m stormy; fair-day cumulus 33 % at 5-45 nm, thick layer
// 3 %; stormy days: anvils, cumulus at 1-25 nm or a thick layer; Kp, S and R levels drawn at NOAA's per-cycle frequencies (days per
// 11-year cycle; S events counted as one day each, est.; quiet Kp 0-4 weighted est.); levels NOAA lists as "fewer
// than 1 per cycle" (S5, R5) only come from overrides; the scales are drawn independently (real storms correlate);
// debris: crewed 8 % / satellite 50 % / debris 42 %, log10 Pc normal around -9 (sd 1.3).
import hazards from "./data/hazards.json";

const U = hazards._units;
const KT_PER_MPH = U.kt_per_mph.value;
const MS_PER_KT = U.ms_per_kt.value;
const KM_PER_NM = U.km_per_nm.value;
const DAYS_PER_CYCLE = U.days_per_cycle.value;

const W = Object.fromEntries(hazards.weather.map((r) => [r.id, r]));
const SW = hazards.spaceWeather;
const PRECEDENT = Object.fromEntries(SW.precedents.map((p) => [p.id, p]));
const PC = Object.fromEntries(hazards.debris.limits.map((l) => [l.object, l]));

const P_STORM = 0.1;
const P_FRONT = 0.08;
const NEAR_LIMIT = 0.8; // caution above this share of the wind limit (est.)
const LIGHTNING_WATCH_NM = 20; // caution band beyond the 10 nm rule (est.)
const FIELD_WATCH_VM = 1000; // the sheets' stricter field-mill figure, as a caution (est.)
const G_HOLD = 4;
const S_HOLD = 4;
const R_CAUTION = 3;
const QUIET_KP = [0.08, 0.22, 0.3, 0.25, 0.15]; // Kp 0..4 on days below G1 (est.)

const round = (v, k = 1) => Math.round(v * 10 ** k) / 10 ** k;
const toKt = (t) => (t.unit === "mph" ? t.value * KT_PER_MPH : t.value);
const kV = (v) => (v / 1000).toFixed(1);
const sci = (p) => p.toExponential(0).replace("e+", "e");

// Threshold test, worded as the source words it: "exceeds"/"exceed"/"greater than" are strict, "within" includes
// the limit.
const violates = (value, t) => (t.compare === "within" ? value <= t.value : value > t.value);

// --- seed ------------------------------------------------------------------------------------------------------
const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const buildKey = (build) =>
  `${build?.missionId ?? ""}:${(build?.stages ?? []).map((s) => `${s.engineId}x${s.engineCount}/${s.tankId}`).join("+")}:${build?.payloadId ?? ""}`;

// --- the vehicle's pad-wind rule ---------------------------------------------------------------------------------
function windRuleFor(build) {
  const tank = build?.stages?.[0]?.tankId;
  const own = hazards.weather.find((r) => r.appliesTo?.firstStageTank?.includes(tank));
  const rule = own ?? W["surface-wind-falcon-9"];
  return { id: rule.id, name: rule.appliesTo.name, limit_kt: round(toKt(rule.threshold)), standIn: !own };
}

// --- simulated conditions (est.) ---------------------------------------------------------------------------------
const pick = (u, pairs) => {
  let acc = 0;
  for (const [p, v] of pairs) {
    acc += p;
    if (u < acc) return v;
  }
  return pairs[pairs.length - 1][1];
};

// Daily Kp from NOAA's G-scale days per cycle; below G1, the quiet weights.
function drawKp(u) {
  let acc = 0;
  for (const l of [...SW.geomagnetic.levels].reverse()) {
    acc += l.daysPerCycle / DAYS_PER_CYCLE;
    if (u < acc) return l.kp;
  }
  const quiet = (u - acc) / (1 - acc);
  return pick(quiet, QUIET_KP.map((p, kp) => [p, kp]));
}
// Highest S or R level of the day from NOAA's per-cycle counts (S: events, counted as one day each, est.).
function drawLevel(u, levels, key) {
  let acc = 0;
  for (const l of [...levels].reverse()) {
    acc += l[key] / DAYS_PER_CYCLE;
    if (u < acc) return l.level;
  }
  return 0;
}

export function simulateConditions(seedKey, build) {
  const rnd = mulberry32(fnv1a(String(seedKey)));
  const u = Array.from({ length: 17 }, rnd); // fixed draw order: one uniform per field
  const stormy = u[0] < P_STORM;
  const front = u[1] < P_FRONT;
  const windSurface_kt = round(stormy ? 8 + 16 * u[2] : front ? 18 + 16 * u[2] : 2 + 14 * u[2]);
  const lightning_nm = stormy && u[5] < 0.75 ? round(0.5 + 29.5 * u[6]) : null;
  const cloudRule = stormy
    ? pick(u[9], [[0.35, "anvil-attached"], [0.15, "anvil-detached"], [0.35, "cumulus"], [0.15, "thick-layer"]])
    : pick(u[9], [[0.64, "clear"], [0.33, "cumulus"], [0.03, "thick-layer"]]);
  const cloud_nm = cloudRule === "clear" ? null : cloudRule === "thick-layer" ? 0 : round(stormy ? 1 + 24 * u[10] : 5 + 40 * u[10]);
  const z = Math.sqrt(-2 * Math.log(1 - u[15])) * Math.cos(2 * Math.PI * u[16]);
  const log10Pc = Math.min(-3, Math.max(-12, -9 + 1.3 * z));
  return withDerived(
    {
      windSurface_kt,
      windDir_deg: Math.floor(360 * u[3]) % 360,
      windShear: pick(u[4], [[0.8, "low"], [0.16, "moderate"], [0.04, "high"]]),
      lightning_nm,
      lightningAz_deg: Math.floor(360 * u[7]) % 360,
      fieldMill_Vm: Math.round((stormy ? 200 + 2800 * u[8] : 40 + 260 * u[8]) / 10) * 10,
      cloudRule,
      cloud_nm,
      kp: drawKp(u[11]),
      sScale: drawLevel(u[12], SW.radiation.levels, "eventsPerCycle"),
      rScale: drawLevel(u[13], SW.radioBlackout.levels, "daysPerCycle"),
      debrisObject: pick(u[14], [[0.08, "inhabitable"], [0.5, "spacecraft"], [0.42, "debris"]]),
      debrisPc: Number((10 ** log10Pc).toPrecision(2)),
    },
    build,
  );
}

function withDerived(c, build) {
  const w = windRuleFor(build);
  return {
    ...c,
    gScale: Math.max(0, Math.min(5, Math.floor(c.kp) - 4)), // NOAA: "Kp = 8, including a 9-" is G4
    sScale: Math.max(0, Math.min(5, Math.round(c.sScale ?? 0))),
    rScale: Math.max(0, Math.min(5, Math.round(c.rScale ?? 0))),
    windLimit_kt: w.limit_kt,
    windRule: w.id,
    windRuleName: w.name,
    windRuleStandIn: w.standIn,
    note: "simulated conditions · est.",
  };
}

// A quiet day, for overrides and tests (est.).
export const CALM_CONDITIONS = Object.freeze({
  windSurface_kt: 6,
  windDir_deg: 90,
  windShear: "low",
  lightning_nm: null,
  lightningAz_deg: 0,
  fieldMill_Vm: 100,
  cloudRule: "clear",
  cloud_nm: null,
  kp: 2,
  sScale: 0,
  rScale: 0,
  debrisObject: "debris",
  debrisPc: 1e-9,
});

// --- rules -------------------------------------------------------------------------------------------------------
const item = (id, rule, text, hud, value, limit, unit, est = false, extra = {}) => ({
  id,
  text,
  hud,
  value,
  limit,
  unit,
  rule: rule.quote,
  source: rule.url,
  est,
  ...extra,
});

function evaluate(c) {
  const blockers = [];
  const cautions = [];
  const wind = W[c.windRule] ?? W["surface-wind-falcon-9"];
  const lim = c.windLimit_kt;
  const ruleName = `${c.windRuleName ?? "Falcon 9"} rule${c.windRuleStandIn ? ", est." : ""}`;
  const kt = Math.round(c.windSurface_kt);

  // Pad wind.
  if (c.windSurface_kt > lim) blockers.push(item("surface-wind", wind, `Winds ${kt} kt, limit ${lim} kt (${ruleName})`, `winds ${kt} kt`, c.windSurface_kt, lim, "kt", c.windRuleStandIn));
  else if (c.windSurface_kt > NEAR_LIMIT * lim) cautions.push(item("surface-wind", wind, `Winds ${kt} kt, near the ${lim} kt limit`, `winds ${kt} kt`, c.windSurface_kt, lim, "kt", true));

  // Lightning and electric field.
  const L = W.lightning;
  if (c.lightning_nm != null && violates(c.lightning_nm, L.threshold)) blockers.push(item("lightning", L, `Lightning ${c.lightning_nm} nm away in the last 30 min (rule: ${L.threshold.value} nm)`, `lightning ${Math.round(c.lightning_nm)} nm`, c.lightning_nm, L.threshold.value, "nm"));
  else if (c.lightning_nm != null && c.lightning_nm <= LIGHTNING_WATCH_NM) cautions.push(item("lightning", L, `Lightning ${c.lightning_nm} nm away, outside the ${L.threshold.value} nm rule`, `lightning ${Math.round(c.lightning_nm)} nm`, c.lightning_nm, L.threshold.value, "nm", true));
  const F = W["field-mill"];
  if (violates(c.fieldMill_Vm, F.threshold)) blockers.push(item("field-mill", F, `Electric field ${kV(c.fieldMill_Vm)} kV/m at the pad (rule: ${kV(F.threshold.value)})`, `field ${kV(c.fieldMill_Vm)} kV/m`, c.fieldMill_Vm, F.threshold.value, "V/m"));
  else if (c.fieldMill_Vm > FIELD_WATCH_VM) cautions.push(item("field-mill", F, `Electric field ${kV(c.fieldMill_Vm)} kV/m, near the limit`, `field ${kV(c.fieldMill_Vm)} kV/m`, c.fieldMill_Vm, F.threshold.value, "V/m", true));

  // Clouds.
  const CLOUD = {
    "anvil-attached": ["anvil-attached", "Thunderstorm anvil", "anvil"],
    "anvil-detached": ["anvil-detached", "Detached anvil cloud", "anvil"],
    cumulus: ["cumulus", "Towering cumulus", "cumulus"],
  };
  if (c.cloudRule === "thick-layer") {
    const T = W["thick-cloud-layer"];
    blockers.push(item("cloud", T, `Thick freezing cloud layer on the flight path`, "thick cloud", c.cloud_nm ?? 0, T.threshold.value, "ft"));
  } else if (CLOUD[c.cloudRule] && c.cloud_nm != null) {
    const [id, label, hud] = CLOUD[c.cloudRule];
    const R = W[id];
    if (violates(c.cloud_nm, R.threshold)) blockers.push(item("cloud", R, `${label} ${c.cloud_nm} nm away (rule: ${R.threshold.value} nm)`, `${hud} ${Math.round(c.cloud_nm)} nm`, c.cloud_nm, R.threshold.value, "nm"));
  }

  // Upper-level wind shear (levels est.).
  const S = W["upper-wind-shear"];
  if (c.windShear === "high") blockers.push(item("wind-shear", S, "Strong wind shear aloft (control risk)", "wind shear", c.windShear, "high", "level", true));
  else if (c.windShear === "moderate") cautions.push(item("wind-shear", S, "Moderate wind shear aloft", "wind shear", c.windShear, "high", "level", true));

  // Space weather.
  const g = c.gScale;
  if (g >= 1) {
    const lvl = SW.geomagnetic.levels[g - 1];
    const noaa = { quote: lvl.quote, url: SW.url };
    if (g >= G_HOLD) {
      const P = PRECEDENT["escapade-g4-hold"];
      blockers.push(item("geomagnetic", noaa, `Geomagnetic storm G${g} (Kp ${c.kp}): hold (est.)`, `storm G${g}`, c.kp, lvl.kp, "Kp", true, { precedent: { quote: P.quote, source: P.url } }));
    } else {
      cautions.push(item("geomagnetic", noaa, `Geomagnetic storm G${g} (Kp ${c.kp}): ${g === 1 ? "minor satellite impact" : "orientation and drag may need fixes"}`, `storm G${g}`, c.kp, SW.geomagnetic.levels[G_HOLD - 1].kp, "Kp"));
    }
    const D = PRECEDENT["starlink-2022-drag"];
    cautions.push(item("orbit-drag", D, "Storm drag in the 200 km parking orbit", "drag", c.kp, null, "Kp", true));
  }
  if (c.sScale >= 1) {
    const lvl = SW.radiation.levels[c.sScale - 1];
    const noaa = { quote: lvl.quote, url: SW.url };
    if (c.sScale >= S_HOLD) blockers.push(item("radiation", noaa, `Solar radiation storm S${c.sScale}: hold (est.)`, `radiation S${c.sScale}`, c.sScale, S_HOLD, "S", true));
    else if (c.sScale >= 2) cautions.push(item("radiation", noaa, `Solar radiation storm S${c.sScale}: ${c.sScale === 2 ? "rare electronics upsets" : "electronics upsets likely"}`, `radiation S${c.sScale}`, c.sScale, S_HOLD, "S"));
  }
  if (c.rScale >= R_CAUTION) {
    const lvl = SW.radioBlackout.levels[c.rScale - 1];
    cautions.push(item("radio-blackout", { quote: lvl.quote, url: SW.url }, `Radio blackout R${c.rScale} (${lvl.flareClass} flare): HF radio lost on the day side`, `radio R${c.rScale}`, c.rScale, null, "R"));
  }

  // Debris.
  const pc = PC[c.debrisObject] ?? PC.debris;
  if (violates(c.debrisPc, pc.threshold)) blockers.push(item("debris", pc, `Collision risk ${sci(c.debrisPc)} with ${pc.label} (limit ${sci(pc.threshold.value)}): window closed`, `debris ${sci(c.debrisPc)}`, c.debrisPc, pc.threshold.value, "Pc"));
  else if (violates(c.debrisPc, PC.any.threshold)) cautions.push(item("debris", PC.any, `Collision risk ${sci(c.debrisPc)} with ${pc.label}: watched (NASA practice)`, `debris ${sci(c.debrisPc)}`, c.debrisPc, pc.threshold.value, "Pc"));

  return { blockers, cautions };
}

function windowFor(missionId) {
  const kinds = hazards.window.kinds;
  const k = kinds.find((w) => w.missions.includes(missionId)) ?? kinds.find((w) => w.id === "flexible");
  return { kind: k.id, line: k.line, quote: k.quote, source: k.url };
}

// --- API ---------------------------------------------------------------------------------------------------------
export function assessLaunch({ build, verdict, seed, conditions, presetId, day, attempt = 0 } = {}) {
  void verdict; // see the header: the vehicle verdict is not part of the range call
  const seedKey = seed != null ? String(seed) : `${presetId ?? buildKey(build)}|${day ?? today()}${attempt ? `#${attempt}` : ""}`;
  const c = withDerived({ ...simulateConditions(seedKey, build), ...(conditions ?? {}) }, build);
  const { blockers, cautions } = evaluate(c);
  const go = blockers.length === 0;
  const hud = go
    ? `Range: GO · winds ${Math.round(c.windSurface_kt)} kt · Kp ${c.kp}`
    : `Range: SCRUB · ${blockers[0].hud}${blockers.length > 1 ? ` +${blockers.length - 1}` : ""}`;
  const win = windowFor(build?.missionId);
  const lines = [hud, ...blockers.map((b) => b.text), ...cautions.map((x) => x.text), win.line, "Simulated conditions · est."];
  return { go, hud, lines, conditions: c, blockers, cautions, window: win, seedKey, est: true };
}

// What the flight effects need (site frame: +x east, +y up, +z south; m/s).
// wind_ms: the surface wind as a vector pointing downwind (a wind FROM 270°, west, blows toward +x).
// stormGlow: 0 below Kp 5 (G1), then 0.2 per Kp step to 1 at Kp 9 (est.; aurora intensity, visual only).
// lightning: present whenever lightning was seen (any distance up to 30 nm); scrub says whether it breaks the rule.
// perMinute is visual only (est.): 6 per minute at the pad falling to 2 at 30 nm.
export function effectsForFlight(x) {
  const a = x?.conditions && Array.isArray(x.blockers) ? x : null;
  const c = a ? a.conditions : x?.windLimit_kt != null ? x : withDerived({ ...CALM_CONDITIONS, ...(x ?? {}) });
  const blockers = a ? a.blockers : evaluate(c).blockers;
  const speed = (c.windSurface_kt ?? 0) * MS_PER_KT;
  const from = ((c.windDir_deg ?? 0) * Math.PI) / 180;
  const clean = (v) => Math.round(v * 1000) / 1000 + 0; // + 0 turns -0 into 0
  const wind = [clean(-Math.sin(from) * speed), 0, clean(Math.cos(from) * speed)];
  const kp = c.kp ?? 0;
  const lightning =
    c.lightning_nm != null
      ? {
          azimuth_deg: c.lightningAz_deg ?? 0,
          azimuth: c.lightningAz_deg ?? 0,
          distance_km: round(c.lightning_nm * KM_PER_NM),
          perMinute: round(2 + 4 * (1 - Math.min(1, c.lightning_nm / 30))),
        }
      : null;
  return {
    wind_ms: wind,
    windDrift_ms: wind,
    stormGlow: kp < 5 ? 0 : Math.min(1, round(0.2 + 0.2 * (kp - 5), 2)),
    scrub: blockers.length > 0,
    scrubReason: blockers[0]?.text ?? null,
    lightning,
  };
}

// Circular-orbit plane change (hazards.json window.planeChange): dv = 2 v sin(di / 2). Derived.
export const planeChangeDeltaV_ms = (v_ms, di_deg) => 2 * v_ms * Math.sin((di_deg * Math.PI) / 360);

export { hazards };
