# Starship preset: sources and gaps (UI 5, 2026-10-18)

Goal: a `starship` preset, Super Heavy plus Starship to `mars-transfer`, with the ship landing itself on Mars.
The engine records are in `engines.pending.json`, and each field there carries its URL and quote. The tank records
are proposed below. Nothing here is in `engines.json` or `tanks.json`: those stay verbatim copies of the team repo.

## Bottom line

The preset cannot be built honestly yet. Four blockers:

1. **33 engines on Super Heavy.**
   - `RULES.MAX_ENGINE_COUNT` is 9 (physics.js, mirroring the team's feasibility.ts), and `sanitizeEngineCount`
     clamps every stage to 1–9.
   - The fit rule also allows only `floor(0.62 × (9 / 1.3)²) = 29` Raptors under a 9 m tank.
   - The real booster therefore needs both of these team-rule changes:
     - `MAX_ENGINE_COUNT ≥ 33`;
     - `ENGINE_FIT_FACTOR ≥ 0.689` (≥ 0.695 with the FAA's 1.306 m nozzle exit).
   - A 9-engine stand-in has TWR 0.40, so it would be grounded.
2. **Stage dry masses are unpublished.** SpaceX, the FAA EAs/EISs and the Space Force EIS give height, diameter,
   engine count, thrust and propellant only. Both tank `dryMass_kg` are `null` / TODO(source).
3. **Raptor 3 has no official sea-level Isp or vacuum thrust, and RVac has no official Isp or mass.** Derived and
   CEO-post candidates exist, flagged in `_candidates`.
4. **Mars needs refilling in orbit.** SpaceX's own vehicle page says so. BuildState has no refilling, so an honest
   single-launch result is "short", stranded in the Earth parking orbit, for any real payload (sensitivity below).

## Engines (V3 vehicle)

| Field | raptor-3 (sea-level variant) | raptor-3-vacuum (RVac) | Source (quote in engines.pending.json) |
|---|---|---|---|
| thrustSL_kN | **2451.7** (250 tf) | 0 (vacuum-only) | SpaceX "Introducing Starship V3", 2026-05-12, spacex.com/updates#starship-v3: "sea-level variants now producing 250 tf (551,000 lbf)"; spacex.com/vehicles/starship Raptor tile "250 tf" |
| thrustVac_kN | **null** TODO(source); candidate 2579.1 (263 tf, est.) | **2696.8** (275 tf) | V3 update: "vacuum engines produce 275 tf (606,000 lbf)". The candidate comes from the Starship tile: 1,614 tf − 3 × 275 tf |
| ispSL_s | **null** TODO(source); candidate 332.7 (est.) | 0 | none official |
| ispVac_s | **350** (condition unstated, mapped to vacuum) | **null** TODO(source); candidate ~380 (2019 CEO post) | SpaceX post 2024-08-03, x.com/SpaceX/status/1819772716339339664: "Raptor 3 (sea level variant) Thrust: 280tf Specific impulse: 350s Engine mass: 1525kg" |
| mass_kg | **1525** | **null** TODO(source) | V3 update: "Mass of the Raptor sea-level engines has been reduced to 1,525 kg from 1,630 kg." |
| diameter_m | **1.3** | **2.3** | spacex.com/vehicles/starship tiles ("Diameter 1.3 m"; "Diameter 2.3 m"), what is measured unstated |
| visuals (length) | 2.9 m | 4.4 m | same tiles ("Height"); for visuals.json if the preset goes ahead |

Notes:
- **Two thrust figures for Raptor 3.**
  - SpaceX's 2024 post gives 280 tf.
  - The 2026 V3 update and the vehicle page give 250 tf.
  - 250 tf is used here as the current official flight figure.
- **Why 350 s is treated as vacuum Isp.**
  - SpaceX's companion post (x.com/SpaceX/status/1819795288116330594) gives Raptor 2 "Specific impulse: 347s".
  - The FAA's 2022 plume report for Raptor 2 yields about 316 s at sea level (derivation in `raptor-2._candidates`;
    two independent methods agree within 1 %).
  - So SpaceX's 347/350 s figures are not sea-level values.
- **Raptor 2 records are kept for reference.**
  - 230 tf, 347 s, 1,630 kg (SpaceX), plus the FAA nozzle exit of 1.306 m.
  - The Raptor 2-generation RVac: 258 tf.
- **The Raptor 3 plume appendices give emissions only.**
  - They are the Space Force CCSFS Final EIS App. 3.1C and the FAA LC-39A Final EIS App. C.2.1.
  - Neither gives a total plume flow, so the Raptor 2 Isp method cannot be repeated.
  - A carbon balance on the R3vac report gives an impossible ~496 s, so nothing was derived from it.

## Tanks (V3, proposed records)

Shape as in tanks.json. `dryMass_kg` is "stage dry minus engines", as the other tanks use. It cannot be filled.

```json
[
  { "id": "super-heavy-v3-tank", "name": "Super Heavy (V3) booster tank", "propellant": "methalox",
    "diameter_m": 9, "height_m": 72, "propellantMass_kg": 3650000, "dryMass_kg": null,
    "source": "https://www.spacex.com/vehicles/starship/" },
  { "id": "starship-v3-tank", "name": "Starship (V3) upper-stage tank", "propellant": "methalox",
    "diameter_m": 9, "height_m": 52, "propellantMass_kg": 1600000, "dryMass_kg": null,
    "source": "https://www.spacex.com/vehicles/starship/" }
]
```

| Field | Super Heavy | Starship | Quote (spacex.com/vehicles/starship, chunk 2337.c79c2132bc6aff75.js) |
|---|---|---|---|
| diameter_m | 9 | 9 | `{label:"Diameter",value:"9 m",secondValue:" / 29.5 ft"}` (both tiles) |
| height_m | 72 | 52 | `{label:"Height",value:"72 m"...}` / `{label:"Height",value:"52 m"...}`: whole-stage heights (booster incl. engine bay and hot-stage ring; ship incl. nose/payload bay), not tank barrels |
| propellantMass_kg | 3,650,000 | 1,600,000 | `{label:"Propellant capacity",value:"3,650 t"...}` / `"1,600 t"`: capacity |
| dryMass_kg | **null** TODO(source) | **null** TODO(source) | not published by SpaceX, FAA, Space Force or NASA documents checked |
| (engines) | 33 Raptor | 3 Raptor + 3 RVac | "Super Heavy is powered by 33 Raptor engines"; "Starship is powered by six engines, three Raptor engines, and three Raptor Vacuum (RVac) engines" |
| (thrust tile) | 8,240 tf | 1,614 tf | `{label:"Thrust",value:"8,240 tf"...}` / `"1,614 tf"` |
| (stack) | 124 m, 100+ t payload | | `{label:"Height",value:"124 m"...}`, `{label:"Payload capacity",value:"100+ t"}` |

Other configurations on record. Do not mix them with V3.

| Configuration | Super Heavy | Starship | Source |
|---|---|---|---|
| 2022 PEA | 71 m, 37 engines, 74 MN, 3,700 t | 50 m, 6 engines, 12 MN, 1,500 t | FAA Final Tiered EA, Boca Chica increased cadence, April 2025 (faa.gov/media/94346), Table 2 "Launch Vehicle Specifications" |
| "Upgraded" (future) | 80 m, 35 engines, 103 MN, 4,100 t | 70 m, 9 engines, 28.7 MN, 2,650 t | same Table 2; CCSFS Final EIS (Nov 2025): "Super Heavy includes 35 Raptor engines and Starship includes 9 Raptor engines"; App. 3.1C: "six (6) Raptor3 vacuum (R3vac) engines arranged around three (3) Raptor3 booster engines" |

The FAA Appendix G (2022) says "The baseline Super Heavy stage includes 33 Raptor2 engines", while Table 2 says
37 for the 2022 PEA column. This is the FAA's own inconsistency; V3 = 33 per SpaceX.

## Mixed engines on the ship (one engine type per stage)

| Option | Stage 2 | Fields sourced | Physics effect | Fit rule (9 m tank) |
|---|---|---|---|---|
| **A (recommended)** | 6 × raptor-3 | mass 1,525, ispVac 350, thrustSL 250 tf; thrustVac only as the est. candidate | Δv uses 350 s for all six: **conservative** (the real 3 RVac have higher Isp); stage mass exact for engines | `floor(0.62 × (9/1.3)²) = 29`, capped at 9 → 6 OK |
| B | 3 × raptor-3-vacuum | thrustVac 275 tf only; ispVac and mass null | cannot be evaluated until RVac Isp and mass are sourced; drops the 3 sea-level engines (their mass and the landing engines) | `floor(0.62 × (9/2.3)²) = 9` → 3 OK |
| C | 3 + 3 split | — | not representable in BuildState | — |

Option A is the honest approximation. Every physics input except the vacuum thrust is a SpaceX number, it
under-states the ship rather than flattering it, and the sea-level Raptors are the ones that land the ship. The
card note should read: "Stage 2 modelled as 6 × Raptor 3 (sea-level variant); the real ship has 3 Raptor + 3
Raptor Vacuum, so Δv is understated."

The booster is the hard part, not the ship (blocker 1).

## Mission and landing

- `mars-transfer` asks for 13,200 m/s from the pad (missions.json).
- SpaceX, spacex.com/vehicles/starship (same chunk): "Starship leverages tanker vehicles (essentially the Starship
  spacecraft minus the windows) to refill the Starship spacecraft in low-Earth orbit prior to departing for Mars.
  Refilling on-orbit enables the transport several hundred tonnes of cargo per ship all the way to Mars."
- **Sensitivity (illustration only, NOT data).**
  - Inputs: Wikipedia's dry masses (SpaceX_Starship oldid 1380733998: Super Heavy 200 t, Starship 100 t, citing
    news articles, not SpaceX), the est. 332.7 s booster Isp and option A.
  - 100 t payload: 3,388 + 7,542 = **10,930 m/s**. Zero payload: 13,222 m/s.
  - With a ~380 s RVac (option B-like): 11,576 m/s at 100 t and 14,055 m/s at zero.
  - So the verdict depends on the unsourced numbers. Even with them, a payload-carrying single launch falls short,
    which is what SpaceX's refilling statement implies.
  - TWR with 33 engines: 1.46. With 9: 0.40.
- **"The ship lands itself."**
  - arrival.js lands only payloads whose visuals archetype is `lander` or `capsule`; here the stage is the
    spacecraft.
  - That needs either a payload record standing for the crew/cargo section with archetype `lander`, or a UI rule.
  - The payload capacity on record is "100+ t" to orbit (reusable), not to Mars.

## Cross-checks and rejected sources

- **Wikipedia** (permalinks, own citations visible), cross-check only:
  - SpaceX_Starship oldid 1380733998: dry masses 200 t / 100 t, citing Sesnic 2021 and Lawler 2019 (news). Not
    acceptable: not used.
  - Raptor 2 "327 s SL / 350 s vac", citing Sesnic 2022 (news). Not used. It also conflicts with the FAA-derived
    ~316 s.
  - SpaceX_Raptor oldid 1380574902: 350 s for Raptor 3 is in the vacuum column (cites SpaceX's post); 380 s RVac
    cites the 2019 CEO post.
- **The 2019 CEO post** (archived): "Sea level Raptor’s vacuum Isp is ~350 sec, but ~380 sec with larger
  vacuum-optimized nozzle". Candidate only.
- **Space Force CCSFS Final EIS**, emissions sheet: "SH (35 eng, 185sec assumed)" booster burn. A modelling
  assumption for emissions, not used.
- **Not reachable:** the 45th Weather Squadron and other Space Force PDFs (403). No NASA HLS document with
  masses was found.

## What would unblock the preset

1. A team decision on `MAX_ENGINE_COUNT` (≥ 33) and `ENGINE_FIT_FACTOR` (≥ 0.69), or an explicit "cannot model
   Super Heavy" note.
2. Official stage dry masses; none exist today. The alternative is a labelled design-target figure if Head 1 accepts
   one (none found from an acceptable source).
3. For option B: RVac Isp and mass. For option A: an official Raptor vacuum thrust or sea-level Isp (or accept
   the est. candidates).
