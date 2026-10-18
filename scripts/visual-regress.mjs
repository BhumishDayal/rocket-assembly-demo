// Visual regression for the demo: the same flow, frame for frame, compared with a stored reference set.
// Run:  node scripts/visual-regress.mjs --serve --baseline   capture the reference set into scripts/qa/baselines/
//       node scripts/visual-regress.mjs --serve              compare the current tree with it (exit 1 if any frame
//                                                            differs by more than --threshold)
//       node scripts/visual-regress.mjs http://127.0.0.1:5191/   any server but 5173 (the script adds ?build=...)
// --serve freezes a copy of the tree on a free port (own Vite cache, no HMR), like smoke.mjs; --rev=HEAD (or any
// commit) serves that commit's files instead, ignoring uncommitted edits (implies --serve).
//
// Frames, at 1600x900 (DPR 1):
//   landing                    the landing page (it always opens on the first preset, so it is captured once)
//   <preset>-home              ?build=<preset>, Build all, verdict, camera settled
//   <preset>-card              a part clicked (found by hover, nearest the centre first), card open, camera settled
//   <preset>-options           its Options list open
//   <preset>-exploded          Explode, springs settled
//   <preset>-compare           C, then the first entry (closest real rocket), camera settled
//   <preset>-launch-SS         SS screen seconds after pressing L: 00 (first frame), 04, 08, 12, 16, 20, 30
// for presets falcon-9 and saturn-v (--presets=a,b to change). Before Explode the clicked part is clicked once
// more (each click flips its look), so later frames do not depend on the card step.
//
// Repeatability (scripts/qa/lib/vclock.mjs): a virtual clock injected before the page loads advances exactly
// 1/60 s per frame and is held while the harness acts and captures; Math.random is seeded; timers and idle
// callbacks run on the clock; loads in flight hold it. Before each capture, finite CSS / Web animations are
// finished and infinite ones paused at 0. The frame is then shot until two consecutive shots agree (up to 6);
// if they never do, it is marked "unstable" (something draws outside the clock) and its score is less useful.
// Diffs are computed inside the same headless Chrome (canvas getImageData), no image library: score = mean
// absolute difference over RGB, in % of full scale. Frames over --threshold get <out>/<frame>-diff.png (heatmap
// over a dimmed copy of the new frame: yellow = large change) and <out>/<frame>-actual.png.
//
// Flags: --baseline  --threshold=2  --presets=falcon-9,saturn-v  --only=<id or substring,...>  --out=<dir>
//        --rev=<commit>  --baseline-dir=scripts/qa/baselines  --size=1600x900  --fps=60  --seed=1  --angle=metal  --keep (write
//        every actual frame, not only failing ones)
// Exit: 0 all frames within the threshold (or baseline written), 1 a frame over it / missing / not captured,
//       2 harness error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkUrl, openBrowser, parseArgs, repo, serveSnapshot, sleep } from "./qa/lib/browser.mjs";
import { createClock, vclockSource } from "./qa/lib/vclock.mjs";
import { diffSource } from "./qa/lib/imgdiff.mjs";

const { flags, positional } = parseArgs();
const BASELINE = Boolean(flags.baseline);
const THRESHOLD = Number(flags.threshold ?? 2);
const [W, H] = String(flags.size ?? "1600x900").split("x").map(Number);
const FPS = Number(flags.fps ?? 60);
const SEED = Number(flags.seed ?? 1);
const PRESETS = String(flags.presets ?? "falcon-9,saturn-v").split(",").filter(Boolean);
const ONLY = flags.only ? String(flags.only).split(",").filter(Boolean) : null;
const LAUNCH_S = [0, 4, 8, 12, 16, 20, 30];
const baseDir = resolve(String(flags["baseline-dir"] ?? join(repo, "scripts", "qa", "baselines")));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(String(flags.out ?? join(tmpdir(), `visual-regress-${stamp}`)));
const STEP = 1000 / FPS;

if (flags.rev === true) {
  console.error("--rev needs a commit, e.g. --rev=HEAD");
  process.exit(2);
}
if (flags.rev) flags.serve = true;
if (!flags.serve && !positional[0]) {
  console.error("usage: node scripts/visual-regress.mjs --serve [--baseline] [--threshold=2] [--presets=a,b] [--only=id,...] [--out=dir]\n       node scripts/visual-regress.mjs <base url> [...]");
  process.exit(2);
}
const harnessError = (msg) => {
  console.error(`harness error: ${msg}`);
  process.exit(2);
};

const presets = JSON.parse(
  flags.rev
    ? execFileSync("git", ["show", `${flags.rev}:src/data/presets.json`], { cwd: repo, encoding: "utf8" })
    : readFileSync(join(repo, "src", "data", "presets.json"), "utf8"),
);
for (const id of PRESETS) if (!presets.some((p) => p.id === id)) harnessError(`unknown preset "${id}" (presets.json has ${presets.map((p) => p.id).join(", ")})`);
const presetName = (id) => presets.find((p) => p.id === id).name;

// Every frame this run can produce, in order; --only keeps those matching any entry (exact id or substring).
const allFrames = [
  "landing",
  ...PRESETS.flatMap((p) => [`${p}-home`, `${p}-card`, `${p}-options`, `${p}-exploded`, `${p}-compare`, ...LAUNCH_S.map((s) => `${p}-launch-${String(s).padStart(2, "0")}`)]),
];
const wanted = (id) => !ONLY || ONLY.some((o) => id === o || id.includes(o));
const frames = allFrames.filter(wanted);
if (!frames.length) harnessError(`--only matched no frame (frames: ${allFrames.join(", ")})`);

let manifest = null;
if (!BASELINE) {
  const mf = join(baseDir, "manifest.json");
  if (!existsSync(mf)) harnessError(`no baseline at ${baseDir}; create one with --baseline`);
  manifest = JSON.parse(readFileSync(mf, "utf8"));
  if (manifest.size?.[0] !== W || manifest.size?.[1] !== H) harnessError(`baseline is ${manifest.size?.join("x")}, this run is ${W}x${H} (pass --size=${manifest.size?.join("x")})`);
  if (manifest.fps !== FPS || manifest.seed !== SEED) console.log(`note: baseline used fps ${manifest.fps}, seed ${manifest.seed}; this run uses fps ${FPS}, seed ${SEED}`);
}

// ---------- server + browser ----------
let snap = null;
let base;
try {
  if (flags.serve) {
    snap = await serveSnapshot({ rev: flags.rev });
    base = snap.base;
    console.log(`serving ${snap.rev}`);
  } else base = checkUrl(positional[0]).href;
} catch (e) {
  harnessError(e.message);
}
const page = await openBrowser({ width: W, height: H, angle: flags.angle }).catch((e) => harnessError(e.message));
const clock = createClock(page);
const initScript = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: vclockSource({ fps: FPS, seed: SEED }) });
mkdirSync(outDir, { recursive: true });
if (manifest && manifest.chrome !== page.version) console.log(`note: baseline was captured with ${manifest.chrome}, this run uses ${page.version}`);

// sha1 of index.html and every file under src/ as served (the frozen snapshot with --serve), so a compare can
// say which files changed since the baseline.
function treeFiles(root) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name !== ".DS_Store") out[r] = createHash("sha1").update(readFileSync(join(root, r))).digest("hex").slice(0, 12);
    }
  };
  walk("src");
  if (existsSync(join(root, "index.html"))) out["index.html"] = createHash("sha1").update(readFileSync(join(root, "index.html"))).digest("hex").slice(0, 12);
  return out;
}
const files = treeFiles(snap?.dir ?? repo);

// ---------- page helpers ----------
const NEUTRAL = [W - 6, Math.round(H * 0.42)]; // canvas edge: empty sky, clear of the HUD and the card
const hud = () => page.js(`document.getElementById("hud-text")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);
const card = () =>
  page.js(`(() => { const el = document.getElementById("detail"); if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    return { open: el.classList.contains("open") && r.width > 0 && r.height > 0, title: el.querySelector("h2")?.textContent?.trim() ?? "",
      hasOptions: !!el.querySelector(".opt-toggle:not([disabled])") }; })()`);
const VERDICT_JS = `/\\b(NO-)?GO\\b/.test(document.getElementById("hud-text")?.textContent ?? "")`;
const fail = (msg) => {
  throw new Error(msg);
};
let expectedNavigations = 0;

async function boot(query, ready) {
  expectedNavigations++;
  await page.send("Page.navigate", { url: new URL(query, base).href });
  const ok = await page.until(() => page.js(`document.readyState === "complete" && !!window.__vclock && (${ready})`).catch(() => false), 45000, 250);
  if (!ok) fail(`page did not become ready within 45 s (${ready})`);
  await page.move(...NEUTRAL);
  await clock.run(1000); // first frames; planet maps (if requested) arrive while the clock waits
}
// Pointer to the neutral spot, then let `ms` of virtual time pass (hover updates need frames).
async function settle(ms) {
  await page.move(...NEUTRAL);
  await clock.run(ms);
}

const shots = new Map(); // id -> { png, meta }
const DONE = Symbol("session done"); // thrown once a session has every frame --only asked for
let sessionIds = [];
async function capture(id) {
  if (!wanted(id)) return;
  // CSS transitions run on real time and can start a frame late (a button enabled on the last virtual frame):
  // finish / pause until a pass finds none left, then shoot until two consecutive shots agree.
  await page.js(`(async () => {
    for (let pass = 0; pass < 6; pass++) {
      let touched = 0;
      for (const a of document.getAnimations()) {
        if (a.playState !== "running" && !a.pending) continue;
        touched++;
        const end = a.effect?.getComputedTiming?.().endTime;
        if (end === Infinity) { a.pause(); a.currentTime = 0; a.__vrPaused = true; }
        else { try { a.finish(); } catch {} }
      }
      await window.__vclock.realFrames(3);
      if (!touched) break;
    }
  })()`);
  let prev = await page.shot();
  let png = await page.shot();
  let tries = 0;
  for (; !png.equals(prev) && tries < 4; tries++) {
    await sleep(250);
    prev = png;
    png = await page.shot();
  }
  const unstable = !png.equals(prev);
  if (unstable) writeFileSync(join(outDir, `${id}-unstable-last.png`), prev);
  await page.js(`for (const a of document.getAnimations()) if (a.__vrPaused) { a.__vrPaused = false; a.play(); }`);
  const c = await card();
  const meta = { t: Number(((await clock.now()) / 1000).toFixed(3)), hud: await hud(), card: (c.open && c.title) || undefined, unstable: unstable || undefined };
  shots.set(id, { png, meta });
  const how = unstable ? "  UNSTABLE (shots kept changing while the clock was held)" : tries ? `  (settled after ${tries + 2} shots)` : "";
  console.log(`  shot  ${id.padEnd(26)} t=${meta.t.toFixed(2).padStart(7)} s${how}`);
  if (ONLY && sessionIds.filter(wanted).every((f) => shots.has(f))) throw DONE;
}

// Hover candidate points (nearest the centre first) until the canvas shows the pointer cursor, click there, and
// return the card that opened. `skip` lists titles already tried.
function gridPoints(x0, x1, y0, y1, step) {
  const pts = [];
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) pts.push([Math.round(x), Math.round(y)]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return pts.sort((p, q) => Math.hypot(p[0] - cx, (p[1] - cy) * 0.5) - Math.hypot(q[0] - cx, (q[1] - cy) * 0.5));
}
async function clickPart(points, skip = new Set(), maxProbes = 400) {
  let probes = 0;
  for (const [x, y] of points) {
    if (++probes > maxProbes) break;
    await page.move(x, y);
    await clock.run(80); // select.js: hover raycast after a timer + a frame
    const over = await page.js(`(() => { const c = document.getElementById("scene");
      return document.elementFromPoint(${x}, ${y}) === c && c.style.cursor === "pointer"; })()`);
    if (!over) continue;
    await page.click(x, y);
    const r = await clock.runUntil(`(() => { const el = document.getElementById("detail"); return el?.classList.contains("open") && !!el.querySelector("h2")?.textContent.trim(); })()`, 1500);
    if (!r.met) continue;
    const c = await card();
    if (skip.has(c.title)) {
      await closeAndRestore([x, y], c.title);
      continue;
    }
    return { ...c, at: [x, y], probes };
  }
  return null;
}
// Esc closes the card (camera glides back), then a second click on the same spot flips the part's look back
// (each click flips it) and Esc closes that card too.
async function closeAndRestore(at, title) {
  await page.press("Escape");
  await settle(2500);
  await page.click(...at);
  const r = await clock.runUntil(`document.getElementById("detail")?.classList.contains("open")`, 1500);
  const again = r.met ? (await card()).title : null;
  if (r.met) await page.press("Escape");
  await settle(2500);
  if (again !== title) console.log(`  note  restoring the look: the second click opened "${again ?? "nothing"}", not "${title}"`);
}

// ---------- sessions ----------
const errors = new Map(); // frame id -> reason it was not captured
async function session(name, ids, fn) {
  if (!ids.some(wanted)) return;
  const t = Date.now();
  console.log(`${name}`);
  sessionIds = ids;
  try {
    await fn().catch((e) => {
      if (e !== DONE) throw e;
    });
    if (page.navigations > expectedNavigations) fail("the page reloaded during the run (another chat saved into a live server?); use --serve");
  } catch (e) {
    const reason = page.unresponsive ? `page unresponsive (${page.unresponsive} timed out)` : e.message;
    console.log(`  FAIL  ${reason}`);
    for (const id of ids) if (wanted(id) && !shots.has(id)) errors.set(id, reason);
    try {
      await page.shot(join(outDir, `${name}-harness-fail.png`));
      console.log(`        screenshot ${join(outDir, `${name}-harness-fail.png`)} · HUD "${await hud()}"`);
    } catch {}
    if (page.unresponsive) return;
  }
  const s = await clock.stats().catch(() => null);
  if (s) console.log(`  ${((Date.now() - t) / 1000).toFixed(0)} s real for ${(s.t / 1000).toFixed(1)} s virtual (${s.frames} frames, ${s.msPerFrame.toFixed(1)} ms/frame${s.stalledMs > 100 ? `, waited ${(s.stalledMs / 1000).toFixed(1)} s for loads` : ""})`);
}

await session("landing", ["landing"], async () => {
  await boot("./", `!!document.querySelector(".landing .landing-go")`);
  await settle(2500);
  await capture("landing");
});

for (const id of PRESETS) {
  const ids = allFrames.filter((f) => f.startsWith(`${id}-`));
  const name = presetName(id);
  await session(id, ids, async () => {
    await boot(`./?build=${encodeURIComponent(id)}`, `(document.getElementById("hud-text")?.textContent ?? "").includes(${JSON.stringify(name)})`);

    await page.clickEl("#btn-build-all");
    if (!(await clock.runUntil(VERDICT_JS, 180000)).met) fail(`Build all: no GO / NO-GO verdict within 180 s of virtual time (HUD "${await hud()}")`);
    await settle(3000);
    await capture(`${id}-home`);

    // Always run every step (also with --only): skipping one would shift the clock for the frames after it.
    {
      const points = gridPoints(W * 0.35, W * 0.65, H * 0.1, H * 0.86, 24);
      const tried = new Set();
      let c = null;
      for (let attempt = 0; attempt < 4 && !c?.hasOptions; attempt++) {
        if (c) {
          tried.add(c.title);
          await closeAndRestore(c.at, c.title);
        }
        c = await clickPart(points, tried);
        if (!c) break;
      }
      if (!c) fail("found no clickable part on the built stack (hover never showed the pointer cursor)");
      console.log(`  card  "${c.title}" at ${c.at.join(",")} (${c.probes} probes)${c.hasOptions ? "" : " · no Options"}`);
      await settle(3000);
      await capture(`${id}-card`);
      if (c.hasOptions) {
        await page.clickEl("#detail .opt-toggle");
        if (!(await clock.runUntil(`!document.querySelector("#detail .opt-list")?.hidden`, 1500)).met) fail("the Options list did not open");
        await settle(800);
        await capture(`${id}-options`);
      } else errors.set(`${id}-options`, "no part with Options found near the centre of the stack");
      await closeAndRestore(c.at, c.title);
    }

    await page.clickEl("#btn-explode");
    if (!(await clock.runUntil(`document.getElementById("btn-explode")?.textContent.trim() === "Assemble"`, 3000)).met) fail("Explode: the button did not flip to Assemble");
    await settle(4000);
    await capture(`${id}-exploded`);
    await page.clickEl("#btn-explode");
    if (!(await clock.runUntil(`(() => { const b = document.getElementById("btn-explode"); return b && !b.disabled && b.textContent.trim() === "Explode"; })()`, 20000)).met) fail("Assemble: the button did not come back as an enabled Explode");
    await settle(1500);

    await page.press("c");
    if (!(await clock.runUntil(`!!document.querySelector("#rockets:not([hidden]) .opt")`, 1500)).met) fail("C: the compare chooser did not open");
    await page.clickEl((await page.rect("#rockets .opt[data-twin]")) ? "#rockets .opt[data-twin]" : "#rockets .opt");
    await settle(3500);
    await capture(`${id}-compare`);
    await page.press("c");
    await settle(3000);

    if (!(await clock.runUntil(`(() => { const b = document.getElementById("btn-build-all"); return b && !b.disabled && b.textContent.trim() === "Launch"; })()`, 15000)).met) fail(`not ready to launch (Build all button: "${(await page.rect("#btn-build-all"))?.text}")`);
    await page.move(...NEUTRAL);
    await page.press("l");
    const tL = await clock.now();
    for (const s of LAUNCH_S) {
      await clock.runTo(tL + (s ? s * 1000 : STEP));
      if (s === 0) {
        await clock.run(0);
        const h = await hud();
        if (!/T[−+-]|T\+|IGNITION|LIFTOFF/i.test(h)) console.log(`  note  HUD on the first launch frame: "${h}"`);
      }
      await capture(`${id}-launch-${String(s).padStart(2, "0")}`);
    }
  });
}

// ---------- baseline or compare ----------
const missingShots = frames.filter((id) => !shots.has(id) && !errors.has(id));
for (const id of missingShots) errors.set(id, "not reached");

if (BASELINE) {
  mkdirSync(baseDir, { recursive: true });
  const mf = join(baseDir, "manifest.json");
  const old = existsSync(mf) ? JSON.parse(readFileSync(mf, "utf8")) : null;
  const keep = ONLY && old && old.size?.[0] === W && old.size?.[1] === H ? old.frames : {};
  if (!ONLY) for (const f of readdirSync(baseDir)) if (f.endsWith(".png")) rmSync(join(baseDir, f));
  const out = { created: new Date().toISOString(), tree: snap?.rev ?? base, size: [W, H], fps: FPS, seed: SEED, chrome: page.version, angle: flags.angle ?? "metal", files, frames: { ...keep } };
  for (const [id, { png, meta }] of shots) {
    writeFileSync(join(baseDir, `${id}.png`), png);
    out.frames[id] = meta;
  }
  writeFileSync(mf, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nbaseline: ${shots.size} frame(s) written to ${baseDir}`);
  for (const [id, why] of errors) console.log(`  not captured: ${id} (${why})`);
  await finish(errors.size ? 1 : 0);
}

// Compare in the same Chrome: drop the clock, load a blank page, decode both PNGs into canvases there.
await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initScript.identifier });
await page.send("Page.navigate", { url: "about:blank" });
await sleep(300);
await page.js(diffSource());
const rows = [];
for (const id of frames) {
  const ref = join(baseDir, `${id}.png`);
  const shot = shots.get(id);
  if (!shot) {
    rows.push({ id, status: "ERROR", detail: `not captured: ${errors.get(id)}` });
    continue;
  }
  if (flags.keep) writeFileSync(join(outDir, `${id}-actual.png`), shot.png);
  if (!existsSync(ref) || !manifest.frames?.[id]) {
    writeFileSync(join(outDir, `${id}-actual.png`), shot.png);
    rows.push({ id, status: "MISSING", detail: `no baseline frame (rerun with --baseline --only=${id})` });
    continue;
  }
  const r = await page.js(`window.__diff(${JSON.stringify(readFileSync(ref).toString("base64"))}, ${JSON.stringify(shot.png.toString("base64"))}, ${THRESHOLD})`, 120000);
  if (r.sizeMismatch) {
    rows.push({ id, status: "FAIL", score: 100, changed: 100, box: null, notes: [`size ${r.b.join("x")} vs baseline ${r.a.join("x")}`] });
    continue;
  }
  const over = r.score > THRESHOLD;
  const notes = [];
  const was = manifest.frames[id];
  if (was.hud !== shot.meta.hud) notes.push(`HUD "${was.hud}" -> "${shot.meta.hud}"`);
  if (was.card !== shot.meta.card) notes.push(`card "${was.card ?? "-"}" -> "${shot.meta.card ?? "-"}"`);
  if (shot.meta.unstable) notes.push("unstable capture");
  const row = { id, status: over ? "FAIL" : "PASS", score: r.score, changed: r.changed, box: r.box, notes };
  if (over) {
    row.heatmap = join(outDir, `${id}-diff.png`);
    writeFileSync(row.heatmap, Buffer.from(r.heatmap, "base64"));
    writeFileSync(join(outDir, `${id}-actual.png`), shot.png);
  }
  rows.push(row);
}

console.log(`\n${"frame".padEnd(26)} ${"score".padStart(7)}  ${"px changed".padStart(10)}`);
for (const r of rows) {
  if (r.score == null) {
    console.log(`${r.status.padEnd(7)} ${r.id.padEnd(26)} ${r.detail}`);
    continue;
  }
  const box = r.box ? `  box ${r.box.join(",")}` : "";
  console.log(`${r.status.padEnd(7)} ${r.id.padEnd(26)} ${r.score.toFixed(2).padStart(6)} %  ${r.changed.toFixed(1).padStart(8)} %${r.status === "FAIL" ? box : ""}`);
  if (r.heatmap) console.log(`        heatmap ${r.heatmap}`);
  for (const n of r.notes) console.log(`        ${n}`);
}
const bad = rows.filter((r) => r.status !== "PASS");
const refFiles = manifest.files;
const changedFiles = refFiles && {
  changed: Object.keys(files).filter((f) => f in refFiles && refFiles[f] !== files[f]),
  added: Object.keys(files).filter((f) => !(f in refFiles)),
  removed: Object.keys(refFiles).filter((f) => !(f in files)),
};
if (changedFiles) {
  const n = changedFiles.changed.length + changedFiles.added.length + changedFiles.removed.length;
  console.log(`\nfiles since the baseline (${manifest.tree ?? "?"}, ${manifest.created.slice(0, 16).replace("T", " ")} UTC): ${n ? "" : "none changed"}`);
  for (const [k, list] of Object.entries(changedFiles)) if (list.length) console.log(`  ${k.padEnd(8)} ${list.join(", ")}`);
}
writeFileSync(join(outDir, "report.json"), JSON.stringify({ base, size: [W, H], threshold: THRESHOLD, chrome: page.version, baseline: manifest.created, files: changedFiles, rows, console: page.consoleLog }, null, 2));
const errs = page.consoleLog.filter((l) => l.level === "error" || l.level === "exception");
if (errs.length) {
  console.log(`\n${errs.length} console error(s)/exception(s) during the run (not scored):`);
  for (const l of errs.slice(0, 10)) console.log(`  [${l.level} @${l.t}s] ${l.text}`);
}
console.log(
  `\n${bad.length ? "VISUAL FAIL" : "VISUAL PASS"}: ${rows.length - bad.length}/${rows.length} frames within ${THRESHOLD} % mean abs diff` +
    `${bad.length ? ` · over or missing: ${bad.map((r) => r.id).join(", ")}` : ""} · out ${outDir}`,
);
await finish(bad.length ? 1 : 0);

async function finish(code) {
  await page.close();
  await snap?.close();
  process.exit(code);
}
