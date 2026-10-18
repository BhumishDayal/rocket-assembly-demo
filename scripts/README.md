# scripts

Five node checks (plain Node >= 22, no dependencies) and one browser page for looking at plumes.

| Script | What it checks | Run | Exit |
|---|---|---|---|
| `check-physics.mjs` | `src/physics.js` against golden numbers from the team app's TypeScript physics | `node scripts/check-physics.mjs` | 0 match, 1 mismatch |
| `check-compat.mjs` | `src/compat.js`: every preset all-ok (demo-build: exactly its one "wider than the stage below"), each rule's reason, option ordering | `node scripts/check-compat.mjs` | 0 pass, 1 fail |
| `check-ascent.mjs` | `src/ascent.js`: every preset flies without NaN, expected outcomes (F9 and Delta IV orbit, Atlas V 401 and demo-build shortfall), Falcon 9 MECO 130–170 s and max g 3–6, edge builds, < 50 ms per run; prints a per-preset flight table | `node scripts/check-ascent.mjs` | 0 pass, 1 fail |
| `check-plume.mjs` | `src/plume.js` + `src/silhouette.js` (UI4): no NaN; plume width grows as ambient pressure falls, Mach diamonds fade with pressure, length grows with throttle; one plume per bell (twin-chamber engines get two); pad light follows throttle; silhouettes at true scale. Runs over all presets × 4 ambient pressures (sea level, 50 kPa, 10 kPa, vacuum) × 3 throttles (0, 0.5, 1) | `node scripts/check-plume.mjs` | 0 pass, 1 fail |
| `plume-harness.html` | Visual check of the plume (UI4): a built stack firing one stage with the demo's lights and bloom; not part of the demo. Serve the repo with Vite on a free port (never 5173) and open `/scripts/plume-harness.html?build=falcon-9&p=101325&throttle=1` (sea level) or `&p=0` (vacuum). Params: `build`, `stage`, `p` (Pa), `throttle` (0–1), `alt` (m above the pad), `ty`/`dist` (camera), `twin=1` (adds a silhouette); `window.__ready` is set after ~40 frames | browser | – |
| `smoke.mjs` | The demo in a real headless Chrome: build, verdict, card, options, explode, preset switch, reset | `node scripts/smoke.mjs --serve "?build=falcon-9" /tmp/smoke/f9` | 0 pass, 1 fail, 2 harness error |

## check-physics.mjs

It compares `src/physics.js` with numbers produced by running the team's TypeScript physics unmodified:
verbatim copies of `SpaxeX/src/lib/physics/*.ts`, `src/types` and `src/data`, run with `npx -y tsx`. The
goldens are inlined in the script, and its header says which commit and tools produced them.

It covers:
- every preset in `src/data/presets.json`;
- seven edge builds that hit every rule branch;
- the closest-rocket distances;
- the engine-fit rule for every tank × engine pair.

Tolerance is 1e-6 relative.

Regenerate the goldens after any change to the TS physics, the copied data or the presets. The generator is not
in this repo; ask harvard-space-9d ("UI 2").

## smoke.mjs

```sh
# Recommended: test a frozen snapshot of the current tree on a free port.
node scripts/smoke.mjs --serve "?build=falcon-9" /tmp/smoke/f9

# Or point it at any URL: your own dev server (never 5173, that is the user's live view) or the deployed site.
node scripts/smoke.mjs "https://bhumishdayal.github.io/rocket-assembly-demo/?build=saturn-v" /tmp/smoke/live
```

### `--serve`

`--serve` copies `index.html`, `src/` and `vite.config.js` to a temp folder and serves them with the repo's
own Vite on a free port. It gives that server its own dependency cache and turns HMR off. Two reasons:
- Vite fully reloads the page every time any chat saves a file, which resets the test mid-run.
- A second Vite server using the default cache rewrites the shared `node_modules/.vite`, which the user's
  server also uses.

The temp folder and the server are removed when the run ends. Without `--serve`, a page reload during the run is
detected, reported, and fails the run.

### Flags

| Flag | Meaning |
|---|---|
| `--size=1600x900` | viewport |
| `--budget=swap:8,explode:10` | override time budgets (seconds) |
| `--build-timeout=90` | same as `--budget=build:90` |
| `--jank-ms=100` | slowest frame still counted as "smooth" |
| `--perf` | add fps, worst frame, draw calls per frame and newly created shader programs to the build / options / explode / assemble lines |
| `--angle=metal\|swiftshader\|gl\|default` | Chrome's GL backend (default metal on macOS). Use swiftshader, a CPU renderer, to tell a GPU-driver problem from app cost |
| `CHROME=/path/to/chrome` | environment variable; use it if Chrome is not in the default macOS or Linux location |

Each run starts its own Chrome, with a temporary profile and a random debugging port, so several chats can run
it at the same time.

### Steps

Each step prints one line: `PASS` / `FAIL` / `SKIP`, then seconds, then detail.

| Step | Does | Passes when (budget, s) |
|---|---|---|
| load | opens the URL | HUD shows the preset's name from `presets.json` (20) |
| build | clicks **Build all** | HUD shows `GO` or `NO-GO` (90), then frames are smooth |
| card | hovers over the stack until the canvas shows the pointer cursor, then clicks there | card opens and its title is a part name from the dataset or `layout.js` (10) |
| options | if the card has **Options**: opens them and picks the 2nd entry (the next one if the 2nd is the current record) | verdict line changes (swap 5), the card shows the chosen record, frames are smooth |
| esc | presses Esc | card closes (1.5) |
| explode | clicks **Explode** | button flips to **Assemble** and frames are smooth (6) |
| card2 | hovers and clicks across the exploded pieces | card opens on a part (20) |
| assemble | clicks **Assemble** | button is an enabled **Explode** again, which means the springs are done (6), then frames are smooth |
| next | presses `]` | HUD shows the next preset's name, the URL has `?build=<id>`, frames are smooth (8) |
| reset | presses `1` (builds part 1), then `R` | HUD is back to "pad ready" (15) |

Other rules:
- "Smooth" means 600 ms of frames with none slower than `--jank-ms`. It catches the class of bug where
  everything still works but each frame takes seconds.
- A step fails if the page is hidden at its end.
- A step is `SKIP` when a step it needs failed (card2 needs explode), or when the page stopped answering: a CDP
  call timed out after 30 s, and the rest are skipped instead of hanging.

### Outputs

- `<outPrefix>-<step>.png` screenshots, plus `<outPrefix>-fail-<step>.png` for each failing step;
- `<outPrefix>-report.json` with every step and every console line.

Console warnings, console errors, uncaught exceptions and failed resource loads are collected and printed.
Errors and exceptions fail the run; warnings are only reported. A 404 for `/favicon.ico` is ignored, because
the page declares no favicon.

### Headless pitfalls (learned the hard way)

- **Never pass `--virtual-time-budget`.** requestAnimationFrame barely ticks under it and anime.js stalls.
- **Escape hides the page.** A CDP Escape key also reaches headless Chrome itself, which sets
  `document.visibilityState` to "hidden" and stops requestAnimationFrame for the whole page. The app still gets
  the key. This looks exactly like a GPU hang: frames at 0, main thread idle, no new shaders, no context loss.
  The harness calls `Page.bringToFront` after every key press and says so in the summary.
- **Live edits reload the page.** Without `--serve`, every save by another chat reloads the page mid-run.

### Selectors it relies on

The harness only does what a user can do: real mouse moves, clicks and key presses through the DevTools
protocol, and reading the DOM. It needs no hooks in the page.

It relies on:
- `#scene` (the canvas; its pointer cursor marks a pickable part);
- `#hud-text`;
- `#btn-build-all`;
- `#btn-explode` (label Explode / Assemble; disabled while assembling);
- `#detail.open`, `#detail h2`, `#detail .eyebrow`;
- `#detail .opt-toggle`, `#detail .opt[data-id]` (with `aria-current` on the current record);
- the keys `]`, `1`, `R` and Esc.

If the UI changes, update them here and in the script.
