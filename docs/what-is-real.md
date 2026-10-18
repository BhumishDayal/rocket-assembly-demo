# What is real in Rocket Assembly

Every number on screen is one of three things:
- a **dataset value** with its source (in a card, click the number to see the quote);
- a **computed** value from a named formula (tagged `derived`);
- a **model output** (tagged `est.`).

Everything else is visual. Paths are under anim-demo/src/.

## 1. Dataset values (each with a source URL and, where available, a verbatim quote)

| What | File |
|---|---|
| Engines, tanks/stages, payloads, missions (Δv needed), reference rockets. Copied verbatim from the team app's data; each record carries `source` (SpaceX, NASA, ULA, L3Harris, NOAA, …) | data/engines.json, tanks.json, payloads.json, missions.json, reference-rockets.json |
| Apollo 11 CSM + LM payload (NASA SP-4029 weights) | data/payloads.extra.json |
| The five pre-made rockets: engine count per stage quoted from user's guides and the Saturn V flight manual | data/presets.json |
| Engine lengths, stage finishes and features, payload types (each with a source) | data/visuals.json |
| Per-field evidence behind the card's clickable numbers (URL, evidence tier, quote) | data/field-sources.json |
| 489 real rockets for "closest real rocket": length, diameter, launches, failures (GCAT, J. McDowell, CC BY 4.0) | data/gcat-rockets.json |
| Planet surface maps (NASA public domain) | assets/planets/, credited in SOURCES.md |
| Launch weather rules (NASA Kennedy), NOAA storm scales, FAA collision limits. Ready, not yet on screen | data/hazards.json |
| Constants: g0 9.80665; Earth GM (WGS 84) and mean radius; ISA sea-level pressure and density; Moon and Mars radius, GM, pressure and scale height (NASA fact sheets); which engines can throttle (Merlin 1D, RD-180, RS-68A, each sourced) | physics.js, ascent.js, arrival.js, flight.js |

## 2. Computed by a named formula

| What | Formula / method | File (check) |
|---|---|---|
| Stage and total Δv | rocket equation Isp·g0·ln(m₀/m₁); sea-level Isp for stage 1, vacuum above | physics.js, the team's TypeScript ported and matched to 1e-6 (scripts/check-physics.mjs) |
| Liftoff TWR, stage mass, mass flow, burn time, mass ratio, dry fraction | n·F/(m·g0); n·engine + dry + propellant; F/(Isp·g0); propellant/(n·ṁ) at full throttle (`est.`) | physics.js |
| GO / NO-GO | team app rules: Δv ≥ mission, TWR ≥ 1.15, dry mass ≥ 3 % of propellant, engines fit 0.62·(D/d)², ≤ 9 per stage. These are app rules, not laws of physics | physics.js `RULES` |
| Options: ok / unusual / incompatible, with the reason | propellant match, sea-level vs vacuum engine, bell wider than tank, engine fit, stage and payload widths | compat.js (check-compat) |
| Closest real rocket | log distance on liftoff mass and thrust, plus log diameter | data/catalog.js `closestRockets` (check-twin) |
| Ascent | 2-D point mass: thrust (sea level → vacuum blend), drag, inverse-square gravity, gravity turn, staging at burnout | ascent.js (check-ascent) |
| Flight after orbit | departure burns flown from the stage's own thrust and flow; RK4 coasts; vis-viva orbits | flight.js (check-flight) |
| Descent and landing | Moon: powered descent. Mars: entry drag, parachute, powered descent; all as continuous constant-acceleration segments | arrival.js (check-arrival) |
| Rocket height | sum of record stage lengths, payload and fairing: shown `est.` | layout.js |

## 3. Model choices (shown as `est.`)

| Choice | File |
|---|---|
| Ascent model. Earth's rotation ignored (conservative). Atmosphere: one scale height of 8.5 km. Drag: Cd 0.3. Parking orbit: 200 km, with a kick-angle search. "In orbit" = perigee above 150 km | ascent.js |
| Ascent limits. 4.5 g limit (throttle floor 0.4). Max-Q throttle 0.8 above 25 kPa, only for engines with sourced throttling. 1 s separation and ignition gaps. Fairing at 110 km. Heating shown as ρv³ | ascent.js |
| Mission success = Δv left ≥ the mission's beyond-orbit Δv; after that the spacecraft's own engine is assumed. Only landers and capsules land | arrival.js |
| Moon descent from a 15 km orbit. Mars entry at 120 km, 5.5 km/s, −10°. Mars parachute at 480 m/s (Cd 0.6). Touchdown at 1 m/s | arrival.js |
| Launch site Cape Canaveral (28.5° N, due east). Mars cruise drawn on a 2,000,000 km line (not to scale). 300 km Mars orbit. Insertion burns are instantaneous. Time speeds up through coasts | flight.js |
| De-orbit timing that brings Earth missions' stage home (pad for LEO, drone ship 600 km downrange for GTO). A story choice: real Falcon 9 second stages are not recovered | flight.js |
| Simulated range day: weather, space weather and debris, judged against the real rules in hazards.json. Holds for severe solar storms. Falcon 9 wind limit standing in for rockets with none published. Not yet on screen | hazards.js |
| Shape proportions where a record has no dimension (named constants, never shown as facts) | layout.js |

## 4. Purely visual

| What | File |
|---|---|
| Part detail: engine plumbing, tank stringers, rivets. Shapes follow the records' sizes; the detail is illustrative | parts.js |
| Launch complex (Kennedy LC-39 style, generic, no logos), tower, lightning masts, 1.8 m person for scale | complex.js, anchors.js |
| Build effects: hologram ghost, crystallize reveal, particle swarm, lock flash | fx/hologram.js, reveal.js, swarm.js, flash.js |
| Launch effects: vents, deluge, steam, Mach collar, cold-gas puffs, re-entry plasma, cloud layer, aurora, lightning. Timed to simulated events; looks only | fx/launchfx.js |
| Exhaust plumes (shape changes with throttle and air pressure; no data) | plume.js |
| Planets, atmosphere glow, clouds, terrain craters and dunes, ocean, touchdown dust, star field. The maps are NASA's; the shading and terrain are procedural | planet.js, world.js |
| Real-rocket outline in compare: true length and diameter; stage proportions are visual | silhouette.js |
| Landing-page dive, camera moves, springs and staggers | ui/landing.js, choreo.js |
| Finishes: which finish a stage has is sourced (visuals.json); the materials are art | parts.js |

The site makes no sound.
