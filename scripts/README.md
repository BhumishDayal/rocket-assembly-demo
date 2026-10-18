# scripts

Two checks, both plain Node (>= 22), no dependencies.

| Script | What it checks | Run | Exit |
|---|---|---|---|
| `check-physics.mjs` | `src/physics.js` against golden numbers from the team app's TypeScript physics | `node scripts/check-physics.mjs` | 0 match, 1 mismatch |
| `smoke.mjs` | The demo in a real headless Chrome: build, verdict, card, options, explode, preset switch, reset | `node scripts/smoke.mjs <url> [outPrefix]` | 0 pass, 1 fail, 2 harness error |

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
in this repo; ask harvard-space-9d.

## smoke.mjs

```sh
# Use your own port. 5173 is the user's live view; don't start or restart anything there.
npx vite --port 5191 --strictPort --host 127.0.0.1 &
node scripts/smoke.mjs "http://127.0.0.1:5191/?build=falcon-9" /tmp/smoke/f9
```

Options:
- `--size=1600x900`: viewport size.
- `--build-timeout=90`: seconds to wait for the verdict after Build all.
- Set `CHROME=/path/to/chrome` if Chrome is not in the default macOS or Linux location.

Each run starts its own Chrome, with a temporary profile and a random debugging port, so several chats can run
it at the same time. Do not add `--virtual-time-budget`: requestAnimationFrame barely ticks under it, anime.js
stalls, and you get false failures.

Steps, one summary line each (`PASS` / `FAIL` / `SKIP` + seconds + detail):

| Step | Does | Passes when |
|---|---|---|
| load | opens the URL | HUD shows the preset's name (from `presets.json`) |
| build | clicks **Build all** | HUD shows `GO` or `NO-GO` within the build timeout |
| card | clicks down the centre column of the stack | card opens and its title is a part name from the dataset or `layout.js` |
| options | if the card has **Options**: opens them and picks the 2nd entry (the next one if the 2nd is the current record) | verdict line changes, and the card shows the chosen record |
| esc | presses Esc | card closes |
| explode | clicks **Explode** | button flips to **Assemble** |
| card2 | clicks across the exploded pieces | card opens on a part |
| assemble | clicks **Assemble** | button flips back to **Explode** |
| next | presses `]` | HUD shows the next preset's name and the URL has `?build=<id>` |
| reset | presses `1` (builds part 1), then `R` | HUD is back to "pad ready" |

A step is `SKIP` when a step it depends on failed (for example, card2 needs explode).

Outputs:
- `<outPrefix>-<step>.png` screenshots, plus `<outPrefix>-fail-<step>.png` for each failing step;
- `<outPrefix>-report.json` with every step and every console line.

Console warnings, console errors, uncaught exceptions and failed resource loads are collected and printed.
Errors and exceptions fail the run; warnings are only reported.

The harness only uses what a user can do: real mouse clicks and key presses through the DevTools protocol, and
reading the DOM. It needs no hooks in the page, so it works on the built site too:

```sh
node scripts/smoke.mjs "https://bhumishdayal.github.io/rocket-assembly-demo/?build=saturn-v" /tmp/smoke/live
```

It relies on these selectors and texts; update them here and in the script if the UI changes:
- `#hud-text`, `#btn-build-all`, `#btn-explode` (label Explode / Assemble), `#detail.open`, `#detail h2`, `#detail .opt-toggle`, `#detail .opt[data-id]`;
- the keys `]`, `1`, `R` and Esc.
