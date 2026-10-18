# Rocket Assembly demo v2 — design (head chat, 2026-10-17)

Goal from the user: make the demo real. Real physics (same math as the team app), 3D shapes generated from
the real dataset records, more parts, a detail card that appears only when a single part is clicked (build or
exploded view), keep the empty dark look and the page exactly as it is (no new panels/decoration), and raise
the quality so it stops looking like a toy.

This doc is the result of six ideation/debate rounds (section 1), followed by the contracts the three
executing chats build against (section 2) and the work split (section 3).

Hard rules for everyone (same culture as the team repo):
- Never invent a real-world number. Every displayed number is either a field of a dataset record (with its
  `source`) or a value computed by a named formula from such fields (label it "est." or "derived").
  Visual-only proportions (ratios used to shape geometry when data has none) are fine but live in code
  comments, never on screen as facts.
- No commits, no pushes, no deploys, no `vite build`: the head chat (harvard-space-b3) does those.
- Do not start a dev server on port 5173: the head chat runs it so the user can watch live.
  Use another port if you need your own.
- No new npm dependencies (three 0.180 + animejs 4 only; three/addons are fine).
- Touch only the files you own (section 3). Talk to the other chats directly for integration
  questions, and message harvard-space-b3 when done (summary + file list + anything unresolved).
- No personal data in any web request (generic User-Agent).

---

## 1. Ideation rounds

### Round 1 — "Port the app into the demo"
Idea: copy the five JSON tables from `SpaxeX/src/data` (branch `phase1_bhumish`) into the demo, port
`SpaxeX/src/lib/physics/*.ts` to JS verbatim, size the six existing parts from the Falcon 9 records, show a
card when a part is clicked.
Debate: this gives correct numbers but the picture barely changes. The stack just becomes 19:1 slender.
The materials are still plastic, nothing on the engines says "engine", there is no second rocket, and with
the parts column gone there is no way to pick what to build. Scale is also unsolved: fog, shadow camera,
star shell, pad, camera distances were all tuned for a 17-unit stack.
Keep: exact physics port, JSON copies, click-to-card. Fix the rest in later rounds.

### Round 2 — "Presets and a manifest"
Idea: the demo builds a *preset* `BuildState` (the same object the team app evaluates): stages of
`{engineId, engineCount, tankId}` + `payloadId` + `missionId`. A pure function turns a build into an
ordered **manifest** of parts: for each stage `engines` → `tank` → (`interstage` if a stage follows), then
`payload` (on an adapter) and `fairing`. Interstage, adapter and fairing are *derived structures* sized from
the neighbouring records; they carry no mass in the dataset and the card says so.
Presets (all engine counts from the sources already in the dataset research):
- `falcon-9`: 9 × merlin-1d + falcon9-s1-tank; 1 × merlin-1d-vac + falcon9-s2-tank; payload goes-r; mission gto.
- `saturn-v`: 5 × f-1 + s-ic; 5 × j-2 + s-ii; 1 × j-2 + s-ivb; payload apollo (new sourced record); mission moon-transfer.
- `atlas-v-401`: 1 × rd-180 + atlas-v-ccb; 1 × rl10c-1 + centaur-iii; payload goes-r; mission gto.
- `delta-iv-m`: 1 × rs-68a + delta-iv-cbc; 1 × rl10b-2 + dcss-5m; payload nova-c; mission moon-transfer.
- `demo-build`: the team's demo story (9 × merlin-1d + falcon9-s1-tank; 1 × rl10b-2 + dcss-5m-tank; jwst; moon-transfer).
Switch with `[` / `]` or `?build=<id>`; the hint line under the title mentions the keys (text only, no new UI).
World scale: `SCALE = 0.25` scene units per metre (Falcon 9 = 17.5 u, Saturn V ≈ 27.7 u). Camera, pad,
shadow bounds, fog adapt from the manifest's bounds instead of constants.
Debate: (a) The app's 4 % dry-mass rule flags the real Falcon 9 second stage (3.2 %). We do not hide this:
the demo computes exactly what the app computes and the tank card prints "dry fraction 3.2 % (app rule ≥ 4 %)".
That is the honest state and it is the evidence P2 needs to relax the rule. (b) The app's engine-fit rule
`floor(0.6·(D/d)²)` allows only 4 F-1 on the S-IC (real: 5). `evaluateBuild` does not enforce the fit rule, so
Saturn V still evaluates; the engines card shows "fit rule: 4 (real vehicle flew 5)". (c) Derived parts must
never show a mass. (d) Why presets and not a free configurator? The team app is the configurator; the demo
proves the cinematic build + physics; a free picker needs the parts column the user wants gone.

### Round 3 — "Looks: what makes it stop being a toy"
Toy signals today: one plastic white, no small-scale detail, no scale cue, perfectly clean, random exploded
directions, flat environment light. Fixes, all procedural, no asset downloads:
- Engines: one merged geometry per engine = bell (parabolic contour, exit diameter from the record,
  length from a sourced table where we have it, else 1.8 × exit diameter for sea-level engines and 1.3 × for
  vacuum engines — visual ratios, commented) + chamber + powerhead: a turbopump cylinder offset to one side,
  two feed pipes (tube geometry on a curve) from pump to chamber, a gimbal block. Bell material: dark metal
  with a procedural vertical-ridge roughness (regen channels) and a faint heat tint toward the throat.
- Cluster layouts from the engine count: 1 centre; 2 pair; 3 triangle; 4 square; 5 quincunx (4 + centre);
  6 hexagon; 7 hexagon + centre; 8 ring; 9 ring + centre (octaweb). Ring radius is the geometric minimum so
  bells do not overlap (plus 3 % gap); it may exceed the tank radius slightly (the real S-IC does).
- Tanks: cylinder at true D × H; a dark thrust-structure skirt at the base; a raceway strip along the full
  length; panel seams and ring welds as a shared procedural bump/roughness texture; finish from a per-tank
  visual table (white, white with black roll-pattern stripes for Saturn, orange foam for SLS/Shuttle/Delta,
  bronze for Atlas CCB), each with a photo-page source.
- Interstage: cylinder when both stages share a diameter, frustum otherwise; black composite for Falcon,
  body finish for the others. Length = upper engine length + 0.4 m clearance (the upper engine hangs inside it).
- Signature features from the visual table, no numbers claimed: Falcon 9 first stage gets four folded landing
  legs and four folded grid fins; S-IC gets four fins and engine fairings.
- Payloads by archetype keyed by id: telescope (cylinder + aperture door; Hubble, JWST stowed), weather
  satellite (box bus + folded panel + dish; GOES-R), lander (hex prism + legs; Nova-C), capsule stack (Apollo
  CSM + LM adapter; exposed, no fairing).
- Fairing: diameter = max(upper-stage D, 1.2 × payload D); cylinder = payload H + adapter; ogive nose
  1.3 × D; two halves.
- Lighting: keep the night pad. Add ground-truth cues: GTAO (ambient occlusion) pass when not `?lite`,
  key light shadow bounds that follow the stack, slightly lower exposure, bloom unchanged.
Debate: piece count vs. the reveal shader. Reveal needs translation-only pieces (rotation about Y is fine,
bake X/Z rotations into geometry). Merging each engine into one piece keeps the Saturn S-IC at 5 engine
pieces + mount + fairings, so fly-in stagger and swarm sampling stay cheap. Textures are generated once on a
canvas and shared. Materials stay `MeshStandardMaterial`/`MeshPhysicalMaterial` so reveal.js keeps working.

### Round 4 — "Physics you can feel"
- `evaluateBuild` port is byte-for-byte the same math (G0 = 9.80665, SL Isp for stage 0, vacuum above,
  stage mass = n·engine + tank dry + propellant, TWR ≥ 1.2, blocking rules, closest rocket by log distance).
  Verified against golden numbers produced by running the team's TypeScript on the same presets.
- Extra derived numbers (standard formulas, labelled "est."): mass flow ṁ = F/(Isp·g0); burn time =
  propellant/(n·ṁ) at full throttle in the regime used for that stage; mass ratio m_start/m_end; liftoff
  acceleration (TWR − 1)·g0.
- HUD (existing top-right element) becomes the verdict line once the stack is complete:
  `Falcon 9 Block 5 · 70.0 m · 549 t · Δv 9 420 / 11 900 m/s · TWR 1.41 · GO` (numbers come from the code,
  these are placeholders). While building it shows the running tally: parts built, stacked height, stacked mass.
- Cards: engine → name, "9 × Merlin 1D", propellant, thrust SL/vac per engine and total, Isp SL/vac, mass each
  and total, exit diameter, sourced length if any, fit-rule note, stage footer (stage index, Δv, burn est.);
  tank → propellant, propellant mass, dry mass, dry fraction with the app rule, D × H, mass ratio, stage Δv;
  payload → mass, D × H, mission and required Δv; interstage/fairing → "derived structure", sizes, "mass not
  modelled / included in stage dry mass". Every card ends with the record's source hostname as a link.
Debate: do we show stage Δv before the whole rocket is built? No: a stage's Δv depends on everything above it.
During the build the cards show record facts; the stage physics footer appears once the preset is complete.
Keeps every number true at every moment.

### Round 5 — "Interaction without the parts column"
- The next buildable part shows as a faint always-on hologram ghost at its slot (opacity ~0.12, rises to ~0.35
  on hover). Clicking the ghost builds it. This is the Subnautica affordance and adds no UI.
- Clicking a built part (any piece, build or exploded view) selects the whole part: a soft emissive pulse in the
  select colour on its pieces, and the card slides in at the left where the column used to be, same visual
  language. Click empty space or press Esc to dismiss; clicking another part swaps the card.
- Click vs. orbit: select only on pointerup with < 5 px travel since pointerdown.
- Keys: 1–9 and 0 build the nth part, Space explode/assemble, B build all, R reset, M mute, `[` `]` preset.
- Explode becomes an engineering exploded view: stages separate along the axis, engines drop below their tank,
  tank shells open radially, fairing halves swing out sideways, payload lifts. Still springs, still staggered.
Debate: should the card be a 3D callout with a leader line? Cleaner on screen to keep it fixed-left and tie it
to the part with the highlight; no overlap with the rocket, no projection clamping, reuses the existing style.
Mobile: the card becomes a bottom sheet above the bar.

### Round 6 — "Polish and stretch"
- Camera framing uses real heights; reset returns to a home computed from the preset.
- `?demo=1` still auto-builds; `?lite=1` still drops post-processing and shadows (and now GTAO).
- Sound unchanged.
- Stretch (only after the core is verified end to end): a launch sequence. 1-D vertical ascent integrated from
  the same thrust/mass/Isp numbers (gravity, simple drag), staging events, exhaust plume, camera chase; triggered
  from the existing Build-all button relabelled "Launch" once the stack is complete. Not assigned yet.
- Starship preset when its numbers are complete (Raptor data still pending in the research).

---

## 2. Contracts

### 2.1 Data (owner A: harvard-space-9d) — `src/data/`
- `engines.json`, `tanks.json`, `payloads.json`, `missions.json`, `reference-rockets.json`: verbatim copies of
  `SpaxeX/src/data/*.json` from branch `phase1_bhumish`.
- `payloads.extra.json`: demo-only payload records in the same shape (`id, name, mass_kg, diameter_m, height_m,
  source`), e.g. `apollo-csm-lm` (CSM + LM mass to TLI, NASA source). Merged into `catalog.payloads`.
- `visuals.json`: visual facts, every entry with a `source` URL.
  ```json
  {
    "engines": { "merlin-1d": { "length_m": 2.92, "source": "https://..." } },
    "tanks":   { "falcon9-s1-tank": { "finish": "white", "interstage": "black-composite",
                                      "features": ["landing-legs", "grid-fins", "raceway"], "source": "https://..." } },
    "payloads": { "goes-r": { "archetype": "weather-sat", "exposed": false, "source": "https://..." },
                  "apollo-csm-lm": { "archetype": "capsule", "exposed": true, "source": "https://..." } }
  }
  ```
  Allowed `finish`: `white | white-black-roll | orange-foam | bronze | silver`. Allowed `interstage`:
  `black-composite | body`. Allowed `features`: `landing-legs | grid-fins | raceway | fins | engine-fairings`.
  Allowed `archetype`: `telescope | weather-sat | lander | capsule`. Missing entries are fine: geometry falls back
  to ratios and the plain white finish.
- `presets.json`: `[{ "id", "name", "missionId", "payloadId", "stages": [{ "engineId", "engineCount", "tankId" }],
  "note", "source" }]` for `falcon-9`, `saturn-v`, `atlas-v-401`, `delta-iv-m`, `demo-build`.
- `catalog.js`:
  ```js
  export const catalog = { engines, tanks, payloads, missions, referenceRockets, visuals, presets }; // payloads = base + extra
  export const byId = (list, id) => list.find((x) => x.id === id);
  export const presetIds = [...];               // in display order, falcon-9 first
  export function getPreset(id) -> preset | undefined
  export function presetToBuild(preset) -> BuildState   // { missionId, stages, payloadId, livery }
  ```

### 2.2 Physics (owner A) — `src/physics.js`
Same names and semantics as `SpaxeX/src/lib/physics/*.ts` (deltav, twr, closest, feasibility), in plain JS:
```js
export const G0 = 9.80665;
export const stageMass_kg = (engine, engineCount, tank) => ...
export const rocketEquationDeltaV_ms = (isp_s, startMass_kg, endMass_kg) => ...
export const ispForStage_s = (engine, stageIndex) => ...
export const liftoffTWR = (engine, engineCount, startMass_kg) => ...
export const liftoffThrust_kN = (engine, engineCount) => ...
export const maxEngineCount = (tankDiameter_m, engineDiameter_m) => ...
export const clampEngineCount = (n, tank, engine) => ...
export const isVacuumOnly = (engine) => ...
export const rocketDistance = (buildMass_kg, buildThrust_kN, ref) => ...
export const closestRocketId = (buildMass_kg, buildThrust_kN, refs) => ...
export const evaluateBuild = (build, catalog) => Verdict   // identical field set to the TS Verdict
export const RULES = { TWR_OK: 1.2, TWR_BLOCKING: 1.0, DRY_MASS_MIN_FRACTION: 0.04, MAX_ENGINE_COUNT: 9 };
// demo extras (standard formulas, label as "est." on screen):
export const massFlow_kgs = (engine, regime /* "sl" | "vac" */) => thrust_kN*1000 / (isp_s*G0)
export const burnTime_s = (engine, engineCount, tank, stageIndex) => tank.propellantMass_kg / (engineCount * massFlow_kgs(engine, stageIndex === 0 ? "sl" : "vac"))
export const stageDetails = (build, catalog) => [{
  stageIndex, engine, engineCount, tank,
  startMass_kg, endMass_kg, propellantMass_kg, dryMass_kg, massRatio,
  ispUsed_s, deltaV_ms, thrust_kN /* regime of that stage */, twr /* stage 0 only, else null */,
  burnTime_s, fitMaxEngines, dryFraction, warnings: [] /* strings from the rules that hit THIS stage */
}]
export const stackMass_kg = (build, catalog, { stages: [0..k], payload: bool }) => number   // running tally for the HUD
```
Golden check: run the team's TS physics on every preset (copy `src/lib/physics/*.ts` + `src/types/index.ts` to the
scratchpad and run with `npx tsx`; do not add files to SpaxeX) and assert the JS port matches to 1e-6 relative.
Put the check in `scripts/check-physics.mjs` (node, no deps) with the golden numbers inlined and their origin noted.

### 2.3 Layout and geometry (owner B: harvard-space-e2) — `src/layout.js`, `src/parts.js`
```js
// layout.js
export const SCALE = 0.25;                       // scene units per metre
export function buildManifest(build, catalog) -> PartSpec[]   // ordered bottom → top in build order
export function sceneBounds(manifest) -> { height_u, radius_u, height_m, baseRadius_u }
```
`PartSpec`:
```js
{
  id: "s0-engines" | "s0-tank" | "s0-interstage" | "s1-engines" | … | "payload" | "fairing",
  kind: "engines" | "tank" | "interstage" | "payload" | "fairing",
  name: "Merlin 1D", sub: "9 × sea-level engines · stage 1", key: "1".."9" | "0",
  stageIndex: number | null,
  record: engine | tank | payload | null,       // the dataset record this part is made from
  count: number,                                // engines on this part, else 1
  slotY: number, height: number, radius: number, // scene units; part local y=0 is its bottom
  height_m: number, diameter_m: number,          // for display (derived parts: computed sizes, say so in note)
  derived: boolean, note: string                 // e.g. "Structure sized from the stage diameters; mass included in the stage dry mass"
}
```
Stack rules: stage 0 engines at y = 0 (bells at the bottom, mount plate on top, part height = engine length +
0.2 m); tank sits on the mount; interstage sits on the tank; the next stage's engines hang *inside* the
interstage (slotY = interstage top − engine length − 0.1 m... whatever keeps the bells inside, document it);
the next tank sits on the interstage; payload adapter + payload on the last tank; fairing around the payload
(skipped when the payload is `exposed`). Engine cluster per Round 3.

`parts.js` keeps today's runtime shape so choreo.js needs no API change:
```js
export const COLORS = { body, accent, metal, gold, panel, holo, select: 0xffb020 };
export function createMaterials() -> { body, composite, metal, engineDark, gold, panel, ... }
export function createPart(spec, mats) -> { ...spec, group, pieces: [{ mesh, index, order, bottomY, topY, rest:{position,quaternion}, explode:{dir,dist} }], built:false, busy:false }
export function createPad({ baseRadius_u }) -> { group, ringMat }
export function createStars()
```
Piece rules: translation-only children (rotation about Y allowed; bake X/Z rotations into geometry with
`geometry.rotateX/Z`); each piece's material is cloned per mesh (reveal/highlight rely on that); every mesh gets
`mesh.userData.partId = spec.id`; explode directions structured (engines −Y, shells radial, domes ±Y, fairing
halves ±X, payload +Y, legs/fins radial); `castShadow`/`receiveShadow` on. Materials: Standard or Physical only
(reveal.js patches them with onBeforeCompile). Keep `side: DoubleSide` on open shells.

### 2.4 UI, selection, cards, choreography integration (owner C: harvard-space-eb) — `src/main.js`, `src/choreo.js`, `src/ui/`, `index.html`, `src/style.css`
- `src/ui/select.js`: `createSelector({ canvas, camera, parts, onSelect(part|null), onGhostClick(part) })` with
  pointerdown/up distance test, raycast over built pieces and ghosts, hover cursor.
- `src/ui/card.js`: `createCard(rootEl) -> { show(part, { details, verdict, catalog }), hide(), el }` renders the
  per-kind content of Round 4; all numbers from the record or from `stageDetails`; derived labelled; source link.
- `src/ui/format.js`: number formatting (thin-space thousands, 1 decimal for metres/tonnes, 0 for m/s, 2 for TWR).
- `choreo.js` additions: `highlight(part, on)` (emissive pulse in COLORS.select on the part's piece materials),
  always-on faint ghost for the next buildable part (`setGhost` idle 0.12 / hover 0.35), `rebuild(parts)` for
  preset switching (cancel, dispose, re-add), `setBounds(bounds)` so `reframe/home` use the preset's height,
  structured explode offsets in metres × SCALE instead of fixed units.
- `main.js`: preset from `?build=`, `[`/`]` switching, keys, HUD verdict/tally line, shadow camera bounds and fog
  from `sceneBounds`, GTAO pass when not lite, card + selector wiring, Esc.
- `index.html`/`style.css`: remove the parts column; add the card container (same style tokens); hint line text
  updated; mobile bottom-sheet card. Nothing else added.

---

## 3. Work split and order
| Chat | Owns | First deliverable | Then |
|---|---|---|---|
| A harvard-space-9d | `src/data/**`, `src/physics.js`, `scripts/check-physics.mjs` | data copies + catalog.js + presets.json (so B and C can import) | physics.js + golden check, visuals.json with sources, apollo payload |
| B harvard-space-e2 | `src/layout.js`, `src/parts.js` | `buildManifest` + `sceneBounds` with simple shapes at true sizes (so C can integrate) | engine detail, cluster layouts, textures/finishes, features, payload archetypes, fairing |
| C harvard-space-eb | `src/main.js`, `src/choreo.js`, `src/ui/**`, `index.html`, `src/style.css` | selector + card + HUD against the current parts (mock manifest if needed) | integrate layout/physics, presets, structured explode, GTAO, mobile |

Head chat (harvard-space-b3): ideation, review, headless verification (CDP script), commits, deploy.
Dev server for the user: http://localhost:5173 (head chat runs it; expect brief breakage while files land).

---

## 4. Direction change (user, 2026-10-17 evening): mechanical sub-assemblies, options per slot

Reference: the anime.js homepage hero. It is a camera lens: as you scroll, the barrel sections (knurled rings,
mount, element groups) slide apart along the lens axis and rotate about it, exposing the inside; scrolling back
screws them together again. Rigid sub-parts, axial travel + rotation, exact snapping, no particles, no holograms.
The user wants that for every rocket part: "a part has multiple sub-parts, the sub-parts make one part", the build
shows them rotating in, the exploded view shows the inside. The particle swarm + crystallize sweep are dropped from
the build path (modules stay in src/fx for reference; nothing imports them).

### Round 7 — Mechanical motion model (constant for every part kind)
Every piece has: `rest` (position, quaternion inside the part), `axisOffset` (signed metres×SCALE along +Y where the
piece sits when the part is pulled apart along the axis), `spin` (radians about Y it carries at the start of an
arrival / end of a departure), `explode {dir, dist}` (radial direction for shells, legs, fins), `order` (arrival
order, bottom-up).
- **build(part)**: pieces are solid from the first frame. They start off-screen at the staging side (the
  existing `sourcePoint`), each rotated by `spin` about Y and about its own travel axis, and fly in on gentle arcs in
  `order` (stagger 30–45 ms; engines of a cluster stagger ~110 ms engine-to-engine, sub-pieces inside an engine
  ~35 ms). Landing = spring (stiffness 260, damping 14) with the spin unwinding to zero in the last 30 % of the
  path, a `tick` per piece. Part lock = the existing flash + `clunk` + shake. The faint hologram ghost of the next
  slot stays as the click-to-build preview and vanishes the moment the build starts.
- **remove(part)**: reverse. Pieces unscrew (spin up, top-down stagger) and leave along the same arcs.
- **explode()**: engineering exploded view along the rocket axis: parts above lift to make room (stage gap =
  3 m × SCALE + the part's own spread), every piece goes to `rest + (0, axisOffset, 0) + explode.dir × dist`,
  rotated by `spin × 0.35`; staggered springs as today; tank shells open radially so domes, baffles, downcomer and
  pressurant bottles are visible; engine sub-pieces stack up along the axis like the lens rings.
- **assemble()**: reverse, bottom-up.
- **swap(part, newSpec)** — the one constant option animation (~2 s total):
  1. parts above lift by a clearance gap (0.5 s, inOutCubic) — skipped when nothing is above;
  2. at +0.2 s the old part unscrews and leaves (remove, 0.7 s);
  3. at +0.7 s the new part flies in (build, 0.9–1.3 s) and locks;
  4. parts above descend onto the new top (0.5 s) with a `clunk`; HUD verdict and open card refresh.
  Same timings for engines, tanks, interstage, payload, fairing; only the piece counts differ.

### Round 8 — Sub-assembly anatomy (what the pieces are)
Sea-level engine (per engine, ~11 pieces, bottom-up): nozzle extension, regen bell, throat + chamber, injector
dome, main valve block, turbopump (cylinder offset to one side), gas generator (small cylinder), LOX feed pipe,
fuel feed pipe, gimbal block, actuator pair (one piece). Vacuum engine (~8): long thin nozzle extension, bell,
chamber, injector, turbopump, 2 pipes, gimbal. Cluster = engines × pieces + mount plate + heat-shield segments
(8 for a 9-engine octaweb, 4 otherwise). Budget: ≤ 110 pieces per cluster part.
Tank (~22–28): 4 shell quarters, bottom dome, common-bulkhead dome, top dome, 3–5 slosh baffle rings (inside),
downcomer / feed line (tube along the axis inside the lower tank), 4 pressurant bottles (inside the upper tank),
thrust-structure skirt ring, raceway, forward ring; Falcon 9 first stage adds 4 folded legs, 4 leg brackets, 4 grid
fins; S-IC adds 4 fins and 4 engine fairings.
Interstage (~8): 4 shell quarters, 12 stringers merged into 2 pieces (front/back halves), top ring, bottom ring,
4 separation pushers merged into 1. Payload by archetype (6–12): telescope (tube, aperture door, 2 panels, bus,
adapter), weather-sat (bus, panel, dish, antenna, adapter), lander (hex body, 6 legs as 2 pieces, tank sphere pair,
engine), capsule (CSM cylinder, cone, SM engine bell, LM adapter cone). Fairing (4–6): 2 halves, separation ring,
payload adapter cone, 2 vent/door details.
Interiors must read in the exploded view: when a tank's quarters open, the domes, baffles, downcomer and bottles
are standing in the middle with their own materials (bare aluminium inside, not the painted finish).

### Round 9 — Options per slot, one button
- Every manifest part that comes from a record is a **slot**: engines (any engine), tank (any tank), payload (any
  payload). Interstage and fairing are derived and have no options (no button shown).
- The card gets exactly ONE control: an "Options" button. Clicking it expands a list inside the card: one line
  per record (name + one key number: thrust SL/vac for engines, propellant mass for tanks, mass for payloads).
  Choosing a record calls `applyOption` (catalog.js) → `buildManifest` → `swap` for the changed part + restack of
  the others; the physics verdict is recomputed and the card refreshes to the new record. Nothing else is added
  to the page.
- Engine count stays as in the preset, clamped by the fit rule for the new engine/tank pair (physics.js). The
  verdict surfaces mismatches (propellant differs, vacuum-only on stage 0, TWR) as warnings. That is the point.

### Contract deltas
- parts.js (B): every piece gets `axisOffset` (units), `spin` (rad), `order`; interiors as separate pieces with
  their own materials; counts per the budgets above. Add `kind` on `mesh.userData` too ("shell", "interior",
  "detail") so C can tune stagger.
- choreo.js (C): `build`, `remove`, `swap(part, newPart)`, `explode`, `assemble`, `restack(manifest)` (animates
  each part group's y to its new slotY), `highlight`, ghost, `rebuild`, `setBounds`. No swarm, no reveal.
- card.js (C): `show(part, ctx)` renders details + the Options button + list; `onOption(part, recordId)` callback.
- catalog.js (A): `optionsFor(kind, build, stageIndex)`, `applyOption(build, kind, stageIndex, recordId)` (done).

---

## 5. Art direction change (user, 2026-10-17 ~19:30): "it still looks like a simulation" → x-ray mechanical look

The painted-white PBR rocket reads as a toy: a thin white stick, uniform light, no visible mechanism. The user
wants the anime.js lens look: dark machined body, crisp edge highlights, semi-transparent shells that show the
mechanism inside, dense mechanical detail, filling the frame. We trade photo-realism for an engineering x-ray
look. Real finishes survive only as tints and bands on the dark shells so vehicles stay distinguishable.

### Round 10 — the look, precisely
1. **Palette + light.** Shells dark graphite (#1e2024 → #2a2d33). One warm key light, peach (#ffb48a, ~2.2)
   from upper-left-front; cool fill (#6a7fa8, ~0.5) from the opposite side; faint hemisphere; environment
   intensity low (0.25). Exposure ~0.95. Background, pad, grid, stars unchanged. Ghost stays holo blue
   (unbuilt = blue, built = warm) and selection stays amber.
2. **X-ray shells.** Every outer shell piece (tank quarters, interstage shell, fairing halves, engine nozzle
   extension, payload bus skin) uses the `shell` material: MeshPhysicalMaterial, colour graphite, roughness 0.5,
   metalness 0.6, `transparent: true`, `opacity 0.42`, `depthWrite: false`, `side: FrontSide`, with a fresnel
   rim in peach added via onBeforeCompile (rim = pow(1 − dot(n, v), 3) × 0.9) so the silhouette stays readable
   through the transparency. Internals (domes, baffles, downcomer, pressurant bottles, chambers, turbopumps,
   pipes, gimbals, stringers, rings, flanges, legs, fins) are opaque: light brushed steel (#b9bec7, metalness
   0.85, roughness 0.35) or dark steel (#4a4f58) so they read through the shell. `mesh.userData.kind` =
   "shell" | "interior" | "detail" decides which material a piece gets.
   Opacity states (animated by choreo, materials are cloned per mesh): built 0.42; exploded 0.30; selected part
   0.15 (x-ray focus) while others stay; during fly-in 0.42 from the first frame.
3. **Edge lines.** Every piece gets a child `LineSegments(new EdgesGeometry(geometry, 25), lineMaterial)`:
   colour peach, `transparent`, `opacity 0.55`, `depthTest: true`, polygon offset so lines sit on the surface.
   At 25° smooth cylinders produce only their rims, flanges, bell lips and ring edges: the technical-drawing
   look of the lens. Lines are children of the mesh, so the choreography needs no change. Lines of shell pieces
   fade with the shell (opacity × 1.3, clamped).
4. **Mechanical density (real geometry, not textures).** Flanges with bolt rings (12–24 small boxes) at every
   joint; weld lands as thin raised rings every ~3 m along tanks; a raceway with clamps every ~3 m; knurled
   rings on engine throats and gimbal blocks (ring of boxes); stacked thin tori at interstage joints; umbilical
   ports on the first stage; nozzle extension lip; baffle rings with cut-outs inside tanks. Edges draw all of
   this. Keep the per-part piece budgets; merge repeated small details (one bolt ring = one merged geometry).
5. **Framing (the lens fills the frame).** Home view fits the stack to ~85 % of the viewport height. While a
   part flies in, the camera frames that part at ~60 % of the height with a slight orbit (the lens tilts as it
   explodes), then eases back to the stack after lock. Clicking a part glides the camera to frame it (x-ray
   focus); Esc returns.
6. **Post.** Keep bloom but lower threshold a touch (0.8) so peach edges glow slightly; GTAO stays but lighter
   (dark shells need little AO). Transparent shells must be excluded from AO/depth-based passes (they already are
   for depthWrite-off meshes).

### Ownership
- UI4 (parts.js/layout.js): materials `shell`, `interior`, `steelDark`, `line`; edge-line children on every
  piece; `kind` on every mesh; detail geometry of item 4; finish tints/bands from visuals as subtle variants.
  Export `shellPieces(part)` (pieces whose userData.kind === "shell") and `setShellOpacity(part, value)` that
  sets mesh + line opacity consistently.
- UI 3 (main.js/choreo.js/select.js): the light rig and exposure, framing rules of item 5, opacity states
  of item 2 via `setShellOpacity`, bloom/GTAO values of item 6.

---

## 6. User feedback round (2026-10-17 ~21:25)

### Round 11 — compatibility, lock timing, performance, pre-made rockets
1. **Compatibility (new `src/compat.js`, UI 2).** Options get a level: `ok`, `unusual` (allowed, labelled with the
   reason), `incompatible` (greyed, not selectable, reason shown). Incompatible: propellant mismatch, vacuum-only
   engine on stage 0, engine does not fit under the tank (fit rule < 1; stricter than the app's clamp on purpose),
   stage wider than 1.6× the one below, payload wider than 1.6× the top stage. Unusual: sea-level engine in
   vacuum, stage wider than 1.15× the one below, upper stage heavier than the one below, engine count reduced by
   the fit rule. All five presets must be all-ok. The physics verdict still runs on whatever is built.
2. **Lock timing (UI 3).** Lock (flash + clunk + shake) fires when the part's body has seated (60 % of shell
   pieces landed, or 70 % of all pieces), not after the last detail piece. Flash colour warm white.
3. **Performance (UI 3 + UI4).** DPR cap 1.5, shadow map 2048, GTAO half-res and skipped during animations and
   on > 230-piece manifests, adaptive drop when frames exceed 22 ms; lines only on structural pieces (≤ 120 on
   Saturn V), no shadows from interiors/details/lines, shared low-segment detail geometry; fix the draw-call leak
   after a swap (555 → 898 observed).
4. **Pre-made rockets (UI 3).** One "Rockets" button at the left of the bottom bar opens an in-place list of the
   presets (name, stages, height, payload → mission); choosing one loads it and runs Build all. `[` `]` stay.

---

## 7. "100× better" ideation (head chat, 2026-10-17 ~21:40), unbounded, then ranked

What we have: a true-scale x-ray rocket built from real records, the app's physics verdict, click-to-card,
options with compatibility, mechanical build/swap/explode, presets, sound. What is missing is CONSEQUENCE
(the verdict is a line of text), PLACE and SCALE (a stick on a disc), VOICE (no mission control), and TRUTH
you can touch (numbers without their quotes). The ideas, grouped:

### A. It flies — the verdict becomes something you watch
A1 Launch sequence driven by the same numbers: countdown, per-engine ignition stagger, hold-down release,
   liftoff acceleration from the real TWR (a Saturn V crawls at 1.18, a Falcon leaps at 1.41), Max-Q throttle,
   MECO at the computed burn time, stage separation, fairing jettison, upper-stage burn, SECO. A NO-GO is not a
   label: the upper stage runs out 900 m/s short and you watch it fall back. 2-D gravity-turn integrator
   (thrust SL→vac blend with altitude, exponential atmosphere, Cd·A drag, staging events), ~200 lines, pure.
A2 Telemetry in the existing HUD line during flight only: T+, altitude, speed, g, events (Max-Q, MECO, SEP, SECO).
A3 Plume shader: under-expanded bell plume at sea level with Mach diamonds, flaring into a huge vacuum plume
   with altitude (exit pressure vs ambient); additive, cheap; plume light flickers on the pad and the rocket base;
   rumble with low-pass by distance, stage-sep bang.
A4 Falcon 9 booster return: boostback, entry burn, grid fins, landing burn, legs deploy, touchdown on the pad
   (we already built the legs and fins). Only for stages that have legs.
A5 Orbit: earth curvature, fairing halves open, payload deploys (GOES-R panel unfolds), target orbit vs achieved
   orbit drawn as two rings; "you reached 180 × 32 000 km, GTO needs 185 × 35 786".

### B. Mission control — Grok in the loop (the team's AI, via the app's routes or a scripted fallback)
B6 Advisor lines at every lock ("9 Merlins: 7.6 MN, 1.4 g off the pad"), on an incompatible pick (the reason,
   spoken), on NO-GO (a suggestion that applies itself with the swap animation).
B7 Voice: "give me a bigger upper stage" → applyOption; "launch" → A1. Web Speech API in, Grok maps to tool calls.
B8 Twin + roast from the 534-rocket GCAT pool: the closest real rocket appears as a ghost silhouette at true scale
   next to yours ("between a Zenit-2 and an Atlas V; 95 launches, 0 failures").

### C. Scale and place
C9 Scale anchors in the same peach line style: a 1.8 m human at the pad, the strongback/tower outline, flame
   trench, distant hangar, pad floodlights, haze. Keeps the empty dark look, adds the sense of size.
C10 Compare mode (key C): Saturn V / Falcon 9 / Starship outlines beside your build at true scale.
C11 Numbers that talk at lock time: "7.6 MN ≈ eighteen 747s" from the sourced roast facts.

### D. Deeper physics
D12 Gravity and drag losses computed from the trajectory ("losses: 1 480 m/s gravity, 150 m/s drag") shown next
    to the app's fixed 9 400 m/s rule, so the simple rule and the simulation agree or disagree visibly.
D13 Structural sanity: axial load at Max-Q vs stage mass, interstage carrying an over-heavy upper stage → unusual.
D14 Centre of mass / centre of pressure markers that slide as propellant drains during flight.
D15 Achieved orbit (perigee/apogee) from the integrator; missions as real orbit targets.
D16 Reliability from GCAT launch stats of the twin: "rockets like yours: 97.3 % success over 640 flights".

### E. Interaction and feel
E17 Scrub mode like the anime.js lens: drag/scroll to disassemble and reassemble continuously (the axial exploded
    layout interpolated 0→1), instead of only a toggle. Cheap, exactly the reference.
E18 Drag-and-drop building: pick an engine in the exploded view, drop it on another stage; the ghost turns green or
    red with the compat reason (Subnautica).
E19 Sub-piece callouts on hover (injector dome, turbopump, slosh baffle) with one sourced sentence each.
E20 Director camera for Build all and Launch: dolly, orbit, rack focus (depth of field) on the arriving part.
E21 Sound: ignition rumble, Doppler, spatialised ticks.

### F. Visual fidelity
F22 X-ray ↔ painted crossfade toggle (judges see both; the painted look gets weathering/decals).
F23 Depth of field on focus, vignette, subtle grain; plume bloom.
F24 Night-pad environment map instead of the generic room; plume light on the pad.
F25 Payload deploy animations (panels, dish, JWST sunshield in stages).

### G. Data and truth
G27 Every number on a card is clickable → the source quote and link (field-sources.json already has quotes).
G28 Historic stage library (49 GCAT stages) as options: a real S-IVB on a Falcon 9, with compat explaining why.
G29 Closest-match over all 534 GCAT rockets with silhouette compare (lengths and diameters are in the pool).
G30 Starship preset once Raptor numbers are sourced.

### H. Story and sharing
H31 Story mode (one key): build → verdict → Grok suggests → swap → launch → orbit → twin and roast, 90 s, hands-free;
    then free play.
H32 Result card: PNG of the x-ray render with the verdict and the twin (key S), ready to share.
H33 Mobile: bottom sheet card, pinch/drag scrub.

### I. Robustness
I34 Instancing for repeated pieces, LOD beyond a distance, physics in a worker, precomputed trajectories per preset.
I35 CI: the harness on GitHub Actions for every push; deterministic seeds.

### J. Play
J36 Race: your rocket vs its real twin launched side by side.
J37 Local leaderboard: best margin per mission.

### Ranked (impact per hour for the demo)
Tier 1 (tonight): A1–A3 launch + telemetry + plume; E17 scrub mode; G27 sourced-number drawer; B8/C10 twin
silhouette; H31 story mode once launch exists.
Tier 2: B6 advisor lines, B7 voice, A4 booster landing, A5 orbit deploy, C9 scale anchors, H32 result card.
Tier 3: E18 drag-and-drop, D14 CoM, D16 reliability, J36 race, I34 instancing/LOD, I35 CI.

Ownership for Tier 1: UI 2 = src/ascent.js (integrator, events, losses, achieved orbit) + check script;
UI4 = src/plume.js (plume shader, pad light, ground scorch) + twin silhouette geometry from the GCAT pool;
UI 3 = launch choreography/camera/telemetry, scrub mode, sourced-number drawer, story mode.

---

## 8. Context change + user round (2026-10-17 ~22:25)

**The prototype is the app.** SpaxeX PR #19 made `prototype/rocket-assembly/src/main.js` the homepage of the
Next.js app (https://spaxe-x.vercel.app) through a fixed React shell (`src/components/assembly/AssemblyStage.tsx`:
canvas#scene, .brand hint, aside#detail, #hud/#hud-text, bar with build-all/explode/reset/sound). Only `src/` is
deployed; the user forbids changes outside `src/` in the team repo (Vercel). Rules from now on:
- main.js creates any DOM it needs that the shell lacks (Rockets button, lists, hint text) and never throws on a
  missing element; index.html is a dev mirror only.
- anim-demo keeps scripts/docs locally; only `src/` is synced to `prototype/rocket-assembly/src/`.
- The team ported their #20 physics into the prototype (#23: ENGINE_FIT_FACTOR 0.62, sanitizeEngineCount,
  "n engines don't fit" blocking warning); anim-demo takes that as the base.

### Round 12 — user requests
1. **Per-part opacity toggle.** Parts default OPAQUE (0.92); clicking a part toggles it TRANSPARENT (0.18) and
   back; per part, per instance (reset/preset/swap restore opaque); key X toggles all.
2. **Landing page.** NASA/Apple/Tesla simple: a large procedural Earth, the title, one button "Build a rocket";
   entering flies the camera from the planet down to the pad in one move. Skipped by ?build/?story/?skip.
3. **Ending on a planet.** After orbit: Earth missions end orbiting above a rendered Earth; Moon/Mars missions
   show a short transfer and the payload descending and touching down (landers/capsules) or entering orbit
   (satellites/telescopes); NO-GO stays stranded in Earth orbit with the shortfall. Success = injection Δv met;
   the spacecraft's own propulsion does the rest (stated). ≤ 8 s.
4. **Faster launch.** ≤ 18 s wall time to the outcome (real time 2.5 s after liftoff, then compressed); story
   mode ≤ 45 s.
Owners: UI 3 (shell robustness, toggle, fast launch, landing overlay + transition, ending choreography),
UI4 (src/planet.js: Earth/Moon/Mars, surface patch, dust puff), UI 2 (port #23, src/arrival.js).
