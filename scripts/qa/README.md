# scripts/qa

Two browser checks. Both drive a real headless Chrome over the DevTools protocol. They need Node 22 or newer and
no npm packages. Both follow the rules in [../README.md](../README.md#headless-pitfalls-learned-the-hard-way):
- `--serve` tests a frozen snapshot of the tree.
- Port 5173 is refused.
- `Page.bringToFront` runs after each key press.
- `--virtual-time-budget` is never used.

Only one Chrome runs at a time.

| Script | What it does | Run | Exit |
|---|---|---|---|
| `../visual-regress.mjs` | Takes 25 frames of the main flow at 1600×900 and compares them pixel by pixel with `baselines/` | `node scripts/visual-regress.mjs --serve` | 0 all within threshold, 1 a frame over / missing / not captured, 2 harness error |
| `mobile-qa.mjs` | Runs the flow on phone, tablet, keyboard-only, reduced-motion and `?lite=1`, then writes `report.md` and `shots/` | `node scripts/qa/mobile-qa.mjs --serve` | 0 ran (issues are in the report), 2 harness error |

## visual-regress.mjs

```sh
node scripts/visual-regress.mjs --serve              # compare the working tree with scripts/qa/baselines
node scripts/visual-regress.mjs --serve --baseline   # replace the baseline with the working tree
node scripts/visual-regress.mjs --serve --only=saturn-v-launch          # only some frames (id or substring)
node scripts/visual-regress.mjs --serve --baseline --only=falcon-9-card # refresh one frame, keep the rest
```

### Frames

| Frame | State |
|---|---|
| `landing` | Landing page, 3.5 s after load. It is taken once: the landing always opens on the first preset and ignores `?build`. |
| `<preset>-home` | `?build=<preset>`, **Build all**, GO / NO-GO verdict, then 3 s for the camera to settle |
| `<preset>-card` | A part clicked (hover probe nearest the centre, first one with Options), card open, camera settled |
| `<preset>-options` | That card's **Options** list open |
| `<preset>-exploded` | **Explode**, 4 s of springs |
| `<preset>-compare` | `C`, then the first entry (closest real rocket), camera settled |
| `<preset>-launch-SS` | SS seconds of screen time after `L`: `00` (first frame), `04`, `08`, `12`, `16`, `20`, `30` |

The presets are `falcon-9` and `saturn-v`; `--presets=a,b` changes them. After the card, the same part is clicked
again, because each click flips its look. That way the later frames don't depend on the card step. `--only`
still runs every earlier step in the session, because skipping one would shift the clock for the frames after
it. A session stops once it has all the frames that `--only` asked for.

### Why two runs give identical pixels

`lib/vclock.mjs` is injected before any page script runs. Nothing in `src/` changes. It does the following:
- `performance.now()`, `Date.now()` (anime.js reads it) and the rAF timestamp advance by exactly 1/60 s per
  frame, however long the frame really took. The frame at "L + 8 s" is therefore the same frame on every run
  and every machine. This also keeps main.js's GTAO/DoF frame budget from dropping effects at random.
- `setTimeout`, `setInterval` and `requestIdleCallback` run on that clock.
- `Math.random` is seeded (`--seed=1`).
- The clock is held while the harness clicks, presses keys and captures, so each input lands on a known frame.
- An `<img>` or `fetch` in flight (the planet maps) holds the clock, so a texture always arrives on the same
  frame.
- Before each capture, CSS and Web animations are finished and infinite ones are paused at 0. These run in
  real time, not on the clock. Frames are then shot until two consecutive shots agree, which takes up to 6
  shots. A frame that never settles is flagged `UNSTABLE`: something draws outside the clock, and its score
  means less.

Measured on 2026-10-18: two runs of the same tree scored 0.00 % on all 13 Falcon 9 frames, launch included.
Any non-zero score therefore comes from a change, not from noise. The 2 % default threshold only lets small
deliberate tweaks pass.

### Output

One line per frame: score (mean absolute RGB difference, in % of full scale) and the share of pixels that
changed by more than 16/255. For a frame over `--threshold` (default 2):
- `<out>/<frame>-diff.png`: a heatmap over a dimmed grey copy of the new frame. Dark red is a small change,
  yellow a large one, and a blue box marks the changed area.
- `<out>/<frame>-actual.png`: the new frame. The reference is `scripts/qa/baselines/<frame>.png`.

The output also lists:
- each frame whose HUD line or card title changed;
- the `src/` files that changed since the baseline. The manifest stores a hash of every served file, so you
  can see whose change it was.

`<out>/report.json` has everything. `<out>` defaults to a fresh `$TMPDIR/visual-regress-<time>`. Diffs run
inside the same headless Chrome: both PNGs are decoded into an OffscreenCanvas and compared with `getImageData`.

### Flags

| Flag | Meaning |
|---|---|
| `--baseline` | write `baselines/*.png` and `baselines/manifest.json` instead of comparing (with `--only`: replace just those frames) |
| `--threshold=2` | fail a frame whose score is above this (%) |
| `--presets=falcon-9,saturn-v` | presets to run |
| `--only=a,b` | frames whose id equals or contains one of these |
| `--out=dir` | where heatmaps, actual frames and report.json go |
| `--keep` | write every actual frame, not only failing ones |
| `--baseline-dir=dir` | default `scripts/qa/baselines` |
| `--size=1600x900`, `--fps=60`, `--seed=1` | must match the baseline (size is enforced) |
| `--angle=metal` | Chrome's GL backend; the baseline records it and the Chrome version |

A full run takes about 4 minutes (~65 s of screen time per preset, at about 9 ms per frame on this Mac).

### When a frame fails

- **Intended change** (a new look, a retimed beat): rerun with `--baseline --only=<frames>` and say so in the
  commit.
- **Unintended**: the heatmap's box shows where it changed, and the "files since the baseline" list shows which
  files to look at.
- **A timing change** (a beat moved by a few frames): this fails every later launch frame at once. The HUD
  line in the output usually shows it, for example `T+00:05` against `T+00:04`.

## mobile-qa.mjs

```sh
node scripts/qa/mobile-qa.mjs --serve                        # all five configs, ~12 min
node scripts/qa/mobile-qa.mjs --serve --configs=phone,lite   # some of them
```

| Config | Device | Input |
|---|---|---|
| `phone` | 390×844, DPR 2, touch | taps (parts are found by mouse hover first, then tapped) |
| `tablet` | 768×1024, DPR 2, touch | taps |
| `keyboard` | 1600×900 | Tab / Shift+Tab, Enter, Space, Esc, letter keys only |
| `reduced-motion` | 1600×900 | mouse, `prefers-reduced-motion: reduce` |
| `lite` | 390×844, DPR 2, touch, `?lite=1` | taps |

Pointer flow: landing → enter → build → card → options → close (tap on empty space) → explode → assemble →
rockets list → compare (`C`) → liftoff → flight → ending.

Keyboard flow: Tab to the landing button → Enter → one full Tab cycle → Build all → can a part card be reached
at all → Explode / Assemble → Space on a focused button → Rockets list (Tab into it, Esc out) → compare chooser →
Launch.

After every step the script records:
- a screenshot, `shots/<config>/NN-<step>.png`;
- the real frame times (frames over 50 ms, the worst frame). Page load is kept apart from the steps;
- the result of a layout probe run in the page.

The probe looks for:
- overlapping text or controls. It compares the boxes of text lines, not of elements, so a wide block with
  short text does not count;
- text cut by an overflow box or the screen edge. Text cut with an ellipsis is listed separately, as minor;
- enabled controls that are off screen, hidden by an overflow box, or covered (checked with `elementFromPoint`
  at their centre). Content inside a scroll box counts as reachable;
- touch targets under 24×24 px and text under 11 px (touch configs only);
- sideways page scroll;
- the HUD line having text while being hidden.

Console errors are listed once per distinct text. The keyboard config also checks:
- invisible Tab stops;
- focus with no visible change;
- controls that Tab never reaches;
- whether Space presses a focused button;
- where focus goes after Esc.

The reduced-motion config lists every animation still running.

Frame times are real, not virtual, so they depend on what else the machine is running. Read them relative to
each other.

## fixes.patch

These are fixes for the problems in `report.md`, written as a patch for the UI chat. Nothing here edits `src/`.
It is a unified diff against `src/style.css` and `src/main.js` as they were when it was written. Check and apply it
from the repo root:

```sh
git apply --check scripts/qa/fixes.patch && git apply scripts/qa/fixes.patch
```

After applying it, rerun `mobile-qa.mjs`. Then rerun `visual-regress.mjs` and re-baseline the frames whose HUD
moved: the HUD now wraps before the key legend.
