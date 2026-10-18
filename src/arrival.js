// The planet ending: what happens after the rocket's job is done. Pure: no DOM; all est.
//   arrivalTimeline(build, catalog, ascentSummary) -> { body, success, lands, lines, legs, mission, shortBy_ms, est }
//   legs: [{ type: "orbit" | "transfer" | "descent" | "touchdown" | "stranded", seconds, alt_km, note, body }]
//   (seconds = screen time; all legs together take at most 8 s)
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
