# 90-second judge demo: Rocket Assembly

Who this is for: the person driving the demo in front of judges. Left column: what you press. Middle: what the
screen shows. Right: what you say. Every on-screen line below is copied from the app's own scripts. Numbers can
move when the data changes, so re-run them before the event (see "Refresh the numbers" at the end).

## Before you start

- Open the live app: https://spaxe-x.vercel.app (team app homepage). Backup: https://bhumishdayal.github.io/rocket-assembly-demo/
  Both read the same URL options (`?lite=1`, `?build=<preset>`).
- Chrome, full screen, mouse with a wheel. Load once and let the planet maps arrive, then reload, so the first
  frame is warm.
- Start on the landing page (no URL options). If anything goes wrong mid-demo: **double-click** finishes the
  current animation, **Esc** closes a card, compare or a held launch frame, **R** resets to an empty pad.
- The key legend sits under the title: Space explode · B build · L launch · R reset · [ ] rocket · C compare · P story ·
  X opacity · S card · Esc close.

## Main script (Falcon 9, ~89 s)

| Time | Do | Screen shows | Say |
|---|---|---|---|
| 0:00 | Scroll down on the landing page (or click once for the 5.5 s dive) | The Earth under the title; the camera dives through the atmosphere and clouds to a night launch pad | "We built a rocket configurator where every number comes from a public source or a named formula." |
| 0:05 | **B** (Build all) | Parts fly in and lock, bottom to top: 9-engine cluster, first stage, interstage, vacuum engine, second stage, payload, fairing. HUD counts up `2/7 parts · … est.` | "This is a Falcon 9 Block 5. Each piece is generated from its dataset record at true scale." |
| 0:13 | Read the HUD | `Falcon 9 Block 5 · 67.9 m est. · 549.9 t · Δv 12 429 / 11 900 m/s · TWR 1.41 · GO` | "The same physics as our team's app: 12,429 m/s of Δv against the 11,900 m/s needed for a geostationary transfer orbit, thrust-to-weight 1.41. GO." |
| 0:16 | **Click the second-stage engine** (the big bell above the interstage), then **Options** in its card | Card: Merlin 1D Vacuum, 981 kN vacuum thrust, Isp 348 s, 490 kg; every number opens its source when clicked. The Options list: `Merlin 1D Vacuum` (current); `Merlin 1D` · unusual · `sea-level engine used in vacuum`; `J-2` greyed · `hydrolox engine on a kerolox tank` | "Every alternative is judged before you pick it: a sea-level engine up here is unusual, and a hydrogen engine on a kerosene tank is simply not allowed." |
| 0:23 | **Esc** | Card closes | (no line needed) |
| 0:24 | **C** (compare), click **Closest real rocket: Falcon 9 (FT5)** | Peach true-scale outline beside the stack. HUD: `Falcon 9 Block 5 · 67.9 m est. vs Falcon 9 (FT5) · 68.4 m · 630 launches, 1 failure (2018–2026) · GCAT (J. McDowell, planet4589.org/space/gcat), CC BY 4.0` | "We match the build against 489 real rockets from Jonathan McDowell's launch catalogue. It finds Falcon 9 itself: 630 launches, one failure." |
| 0:29 | **Esc**, then **L** (launch) | Countdown `Falcon 9 Block 5 · T−10 …`: arms swing away, deluge, engines light in pairs | "Now the build flies, on a simulation of its own numbers." |
| 0:39 | (watch) | HUD telemetry, e.g. `T+01:01 · 10.1 km · 378 m/s · 1.7 g · MAX-Q · est.` then `T+02:27 · 66.9 km · 2 416 m/s · 4.5 g · MECO · est.` | "Gravity turn, Max-Q, staging. The g-load holds at 4.5 g because the engines throttle, as real ones do." |
| ~1:01 | (watch) | Second stage reaches orbit (`T+07:56 · 200.0 km · 7 791 m/s · … · SECO · est.`), parking orbit, departure burn, transfer orbit, then de-orbit, re-entry glow and touchdown on a drone ship | "One continuous shot: no cuts. Time speeds up through the coasts and slows down for each event." |
| ~1:27 | Read the final HUD line | `Geostationary transfer orbit reached; from here GOES-R weather satellite's own propulsion takes over. Apogee 38,590 km (est.). · Landed back on Earth · est.` | "It made its orbit with 321 m/s to spare. Anything labelled est. is our model; everything else is sourced." |

Timing: the flight is 52.2 s of screen time after the 10 s countdown (scripts/check-flight.mjs). If you are running
long, double-click once during the transfer coast: the flight jumps to its final line.

Honesty note, if asked: real Falcon 9 second stages are not recovered. Ending Earth missions with the stage landing
is our story choice (design round 20), and the HUD marks it est.

## Variant: Saturn V to the Moon (swap in for the launch, ~92 s)

Press **]** once after the Falcon 9 beats (the Saturn V appears built), skip the compare beat, then **L**.

| Screen | Line (from the scripts) |
|---|---|
| HUD verdict | `Saturn V (Apollo 11, AS-506) · 112.5 m est. · 2 919.7 t · Δv 12 638 / 12 600 m/s · TWR 1.18 · GO` |
| Telemetry | `T+01:30 · 15.6 km · 575 m/s · 2.2 g · MAX-Q · est.` · `T+02:44 · 62.7 km · 2 569 m/s · 4.5 g · MECO · est.` · `T+11:05 · 200.0 km · 7 789 m/s · 0.8 g · SECO · est.` |
| Final line (after transfer, lunar orbit, braking, approach, vertical descent) | `Apollo 11 CSM + LM in adapter: its lander lands on the Moon with its own engine (est.).` |
| Flight length | 55.0 s screen after the countdown |
| Compare (C) | `… vs Saturn V · 110.6 m · 2 launches, 0 failures (1967–1968) · GCAT (J. McDowell, planet4589.org/space/gcat), CC BY 4.0` |

Say: "Apollo 11's real stage masses: 12,638 m/s against 12,600 needed for the Moon. That's 38 m/s of margin, and it
lands."

## Optional beat: break it on purpose (+10 s)

In the second-stage engine card, pick **Merlin 1D** (the unusual one). The engine swaps on the rocket and the HUD
turns: `Falcon 9 Block 5 (modified) · 67.9 m est. · 549.9 t · Δv 11 517 / 11 900 m/s · TWR 1.41 · NO-GO · Δv short`.
Say: "A sea-level engine wastes the vacuum: about 900 m/s gone, and the mission no longer closes." Pick **Merlin 1D
Vacuum** again to restore GO. (R after a change resets to an empty pad.)

## 30-second fallback: weak GPU (`?lite=1`)

Lite mode drops antialiasing, shadows and the bloom pass, and renders at pixel ratio 1. Open:
`https://spaxe-x.vercel.app/?lite=1&build=saturn-v` (skips the landing page; the pad shows `Empty pad · blueprint:
Saturn V (Apollo 11, AS-506)`).

| Time | Do | Screen / say |
|---|---|---|
| 0:00 | **B**, double-click if it is slow | The Saturn V assembles. "Real Apollo 11 hardware, from NASA's own figures." |
| 0:06 | Read the HUD | `Saturn V (Apollo 11, AS-506) · 112.5 m est. · 2 919.7 t · Δv 12 638 / 12 600 m/s · TWR 1.18 · GO` |
| 0:10 | **C**, click **Closest real rocket: Saturn V** | `… vs Saturn V · 110.6 m · 2 launches, 0 failures (1967–1968) · …` "It finds the real Saturn V in a catalogue of 489 rockets." |
| 0:15 | **Esc**, **L**, then double-click after liftoff | The flight jumps to its end: `Apollo 11 CSM + LM in adapter: its lander lands on the Moon with its own engine (est.).` |
| 0:25 | | "Sourced numbers, named formulas, and est. on everything we modelled." |

No GPU at all: press **P** on any working machine before the event and screen-record the story mode (it builds the
Falcon 9, opens a card, swaps a tank and back, launches, ends beside its real twin, in about 45 s).

## Refresh the numbers (run from anim-demo/, no browser needed)

| Line | Where it comes from |
|---|---|
| Verdict lines (Δv, TWR, mass) | `node scripts/check-physics.mjs` (physics.js = the team's TypeScript, checked to 1e-6) |
| Heights (`67.9 m est.`, `112.5 m est.`) | layout.js `sceneBounds(buildManifest(...))`, formatted by ui/format.js as main.js does |
| Telemetry at events | `node scripts/check-ascent.mjs` (event times, altitude, speed) |
| Final lines and flight length | `node scripts/check-flight.mjs` and `node scripts/check-arrival.mjs` |
| Compare lines | `node scripts/check-twin.mjs` |
| Option reasons | `node scripts/check-compat.mjs` |

Numbers above were generated on 2026-10-18 from branch v2-realistic @ aa6347f. The app shows thousands with a thin
space (`12 429`).
