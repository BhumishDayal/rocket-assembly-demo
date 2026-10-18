// Headless smoke test for the demo: drives a real Chrome over the DevTools protocol and checks the main flow.
// Run: node scripts/smoke.mjs <url> [outPrefix] [flags]
//      node scripts/smoke.mjs --serve [?query] [outPrefix] [flags]      (recommended; see scripts/README.md)
//   e.g. node scripts/smoke.mjs "http://127.0.0.1:5191/?build=falcon-9" /tmp/smoke/f9
//        node scripts/smoke.mjs --serve "?build=saturn-v" /tmp/smoke/sv
// --serve copies index.html, src/ and vite.config.js to a temp folder and serves that frozen snapshot with the
// repo's Vite on a free port, so edits by other chats (Vite full-reloads the page on every save) cannot reset
// the page mid-run. Without --serve, a reload during the run is reported and fails it.
// Time budgets: each step's user-visible action must finish within its budget (seconds), and the page must
// render smoothly again afterwards (a 600 ms run of frames, none slower than --jank-ms=100), or the step fails.
// Defaults: load 20, landing 8, build 90, card 10, swap 5, esc 1.5, explode 6, card2 20, assemble 6, next 8,
// reset 15.
// Override: --budget=swap:8,explode:10 (--build-timeout=N is the same as --budget=build:N).
// --angle=metal|swiftshader|gl|default picks Chrome's GL backend (default: metal on macOS); swiftshader is a
// CPU renderer, useful to tell a GPU-driver problem from app cost.
// --perf adds frame rate, draw calls per frame and newly created shader programs to the build, options,
// explode and assemble lines (WebGL calls are counted by a wrapper injected before the page loads).
// No deps (Node >= 22 for the global WebSocket). Exits 1 if any assertion fails, 2 on a harness error.
// Never pass --virtual-time-budget to Chrome: requestAnimationFrame barely ticks and anime.js stalls.
//
// Flow (one summary line per step; screenshots <outPrefix>-<step>.png; report <outPrefix>-report.json):
//   load      HUD shows the preset's name
//   landing   only when the URL has none of ?build / ?story / ?skip / ?demo: the landing page shows its button,
//             Enter enters, and the UI is back once the camera has come down (SKIP otherwise)
//   build     click "Build all", HUD reaches GO / NO-GO (verdict line) within --build-timeout seconds
//   card      click a part of the stack (found by hover: pointer cursor), the card opens and its title is a part name from the dataset
//   options   if the card has Options: open them, pick the second alternative (the next one if the second is
//             the current record), the verdict line changes and the card shows the chosen record
//   esc       Esc closes the card
//   explode   click "Explode", the button flips to "Assemble"
//   card2     click a piece of the exploded stack, the card opens again
//   assemble  click "Assemble", the button flips back to "Explode"
//   next      "]" switches to the next preset, which appears BUILT: HUD shows its name and a GO / NO-GO
//             verdict, URL has ?build=<id>
//   reset     "R": HUD is "Empty pad · blueprint: <name>"; then key "1" builds part 1 from the empty pad
// Console warnings/errors, uncaught exceptions and failed loads are collected; exceptions and console errors
// fail the run, warnings are only reported. A 404 for /favicon.ico is ignored (the page declares none).
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const positional = args.filter((a) => !a.startsWith("--"));
const serve = "serve" in flags;
if (serve && positional[0] && !positional[0].startsWith("?")) positional.unshift(""); // --serve <outPrefix>
const [target = "", prefixArg = "smoke"] = positional;
if (!serve && !target) {
  console.error("usage: node scripts/smoke.mjs <url> | --serve [?query]  [outPrefix] [--size=1600x900] [--budget=swap:5,...] [--jank-ms=100] [--perf] [--angle=metal]");
  process.exit(2);
}
const prefix = resolve(prefixArg);
mkdirSync(dirname(prefix), { recursive: true });
const [W, H] = (flags.size ?? "1600x900").split("x").map(Number);
const BUDGET = { load: 20, landing: 8, build: 90, card: 10, swap: 5, esc: 1.5, explode: 6, card2: 20, assemble: 6, next: 8, reset: 15 };
if (flags["build-timeout"]) BUDGET.build = Number(flags["build-timeout"]);
for (const kv of (flags.budget ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  if (!(k in BUDGET) || !(Number(v) > 0)) {
    console.error(`bad --budget entry "${kv}" (known: ${Object.keys(BUDGET).join(", ")})`);
    process.exit(2);
  }
  BUDGET[k] = Number(v);
}
const JANK_MS = Number(flags["jank-ms"] ?? 100);
const ms = (k) => BUDGET[k] * 1000;

// ---------- expectations from the repo's own data (works against dev and built pages alike) ----------
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (f) => JSON.parse(readFileSync(join(repo, "src", "data", f), "utf8"));
const presets = readJson("presets.json");
const catalogSrc = readFileSync(join(repo, "src", "data", "catalog.js"), "utf8");
const presetOrder = JSON.parse(catalogSrc.match(/presetIds\s*=\s*(\[[^\]]*\])/)?.[1] ?? "null") ?? presets.map((p) => p.id);
const layoutSrc = readFileSync(join(repo, "src", "layout.js"), "utf8");
const derivedNames = [...layoutSrc.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1]);
const partNames = new Set([
  ...readJson("engines.json").map((r) => r.name),
  ...readJson("tanks.json").map((r) => r.name),
  ...readJson("payloads.json").map((r) => r.name),
  ...readJson("payloads.extra.json").map((r) => r.name),
  ...derivedNames,
]);
// --serve: freeze the current tree into a temp folder and serve it with the repo's own Vite.
const tmpDirs = [];
let server = null;
async function serveSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "smoke-snap-"));
  tmpDirs.push(dir);
  for (const f of ["index.html", "vite.config.js", "package.json"]) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(dir, f));
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  if (existsSync(join(repo, "public"))) cpSync(join(repo, "public"), join(dir, "public"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  // Own dependency cache: the default (node_modules/.vite) is the repo's shared one, and re-optimizing into it
  // disturbs the dev server the user is watching. No HMR: nothing should reload the page under the test.
  writeFileSync(
    join(dir, "vite.smoke.config.mjs"),
    `import base from "./vite.config.js";\nexport default { ...base, cacheDir: ${JSON.stringify(join(dir, ".vite-cache"))}, clearScreen: false, server: { ...(base.server ?? {}), hmr: false } };\n`,
  );
  const port = await new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [vite, "--config", "vite.smoke.config.mjs", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return base;
    } catch {}
    await sleep(100);
  }
  throw new Error(`snapshot server did not start:\n${log}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = serve ? new URL(target, await serveSnapshot().catch((e) => (console.error("harness error:", e.message), process.exit(2)))).href : target;
const startId = new URL(url).searchParams.get("build");
const startIndex = Math.max(0, presetOrder.indexOf(startId));
const presetName = (i) => presets.find((p) => p.id === presetOrder[i % presetOrder.length])?.name ?? "?";

// ---------- Chrome ----------
const CHROME =
  process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find(existsSync);
if (!CHROME) {
  console.error("Chrome not found; set CHROME=/path/to/chrome");
  process.exit(2);
}
// Own profile and a random debugging port, so several chats can run this at once.
const profile = mkdtempSync(join(tmpdir(), "smoke-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--use-angle=${flags.angle ?? (process.platform === "darwin" ? "metal" : "default")}`,
    "--enable-unsafe-swiftshader",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
function cleanup() {
  for (const p of [chrome, server]) {
    try {
      p?.kill();
    } catch {}
  }
  for (const d of [profile, ...tmpDirs]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}
process.on("exit", cleanup);
// Normal end: let Chrome and the snapshot server exit before deleting their folders (an rm racing a still
// running Chrome leaves the profile behind).
async function shutdown(code) {
  const gone = (p) => (!p || p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", r)));
  for (const p of [chrome, server]) {
    try {
      p?.kill();
    } catch {}
  }
  await Promise.race([Promise.all([gone(chrome), gone(server)]), sleep(3000)]);
  cleanup();
  process.exit(code);
}
process.on("SIGINT", () => process.exit(130));

async function connect() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 80 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome did not start (no DevToolsActivePort)");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let targets = [];
  for (let i = 0; i < 40 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {}
    if (!targets.some((t) => t.type === "page")) await sleep(150);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return ws;
}

// ---------- CDP plumbing ----------
const ws = await connect().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(2);
});
let nextId = 0;
const pending = new Map();
const consoleLog = []; // { level, text, t }
let navigations = 0;
let unresponsive = null; // first CDP call that timed out: the page stopped answering
const t0 = Date.now();
const note = (level, text) => consoleLog.push({ level, text: text.slice(0, 400), t: ((Date.now() - t0) / 1000).toFixed(1) });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && ["warning", "error", "assert"].includes(m.params.type)) {
    note(m.params.type === "warning" ? "warning" : "error", m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) {
    navigations++;
    if (navigations > 1) note("reload", `page reloaded (${m.params.frame.url}); without --serve this is usually Vite reloading after another chat saved a file`);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    note("exception", d.exception?.description ?? d.text);
  } else if (m.method === "Log.entryAdded" && ["warning", "error"].includes(m.params.entry.level)) {
    if (/\/favicon\.ico$/.test(m.params.entry.url ?? "")) return; // the page has no favicon; not a demo bug
    note(m.params.entry.level, `[${m.params.entry.source}] ${m.params.entry.text}${m.params.entry.url ? " " + m.params.entry.url : ""}`);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++nextId;
    const timer = setTimeout(() => {
      unresponsive ??= method;
      rej(new Error(`CDP ${method} timed out after 30s (page unresponsive)`));
    }, 30000);
    pending.set(i, (m) => {
      clearTimeout(timer);
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
if ("perf" in flags) {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const c = (window.__smokeGl = { programs: 0, draws: 0, frames: 0 });
      for (const P of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
        if (!P) continue;
        const wrap = (name, key) => { const f = P[name]; if (f) P[name] = function (...a) { c[key]++; return f.apply(this, a); }; };
        wrap("createProgram", "programs");
        for (const d of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) wrap(d, "draws");
      }
      const raf = window.requestAnimationFrame.bind(window);
      (function tick() { c.frames++; raf(tick); })();
    })()`,
  });
}
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// ---------- page helpers ----------
const hud = () => js(`(document.getElementById("hud-text") || document.getElementById("hud"))?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);
const card = () =>
  js(`(() => {
    const el = document.getElementById("detail");
    if (!el) return { exists: false, open: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const t = el.querySelector(".opt-toggle");
    return {
      exists: true,
      open: el.classList.contains("open") && r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0,
      title: el.querySelector("h2")?.textContent?.trim() ?? "",
      eyebrow: el.querySelector(".eyebrow")?.textContent?.trim() ?? "",
      hasOptions: !!t,
      optionsDisabled: !!t?.disabled,
      text: el.innerText.replace(/\\s+/g, " ").slice(0, 300),
    };
  })()`);
const rectOf = (selector) =>
  js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled, text: el.textContent.trim() }; })()`);
const VERDICT = /\bNO-GO\b|\bGO\b/;

// Resolves once the page has rendered 600 ms of frames with none slower than JANK_MS; false after `budget` ms.
// Catches the "everything still works but each frame takes seconds" class of bug.
async function smooth(budget) {
  const r = await js(`new Promise((r) => { const t0 = performance.now(); let last = t0, run = t0;
    (function f() { const now = performance.now(); if (now - last > ${JANK_MS}) run = now; last = now;
      if (now - run >= 600) return r(true); if (now - t0 > ${budget}) return r(false); requestAnimationFrame(f); })(); })`);
  return r;
}
async function mustBeSmooth(after, budget = 4000) {
  if (!(await smooth(budget))) fail(`page not rendering smoothly within ${budget / 1000}s after ${after} (frames slower than ${JANK_MS} ms)`);
}
function withinBudget(key, startedAt, what) {
  const s = (Date.now() - startedAt) / 1000;
  if (s > BUDGET[key]) fail(`${what} took ${s.toFixed(1)}s (budget ${BUDGET[key]}s)`);
  return `${s.toFixed(1)}s/${BUDGET[key]}s`;
}

// --perf: " · 60 fps (worst 21 ms), 155 draws/frame, +0 programs" since the previous sample.
let glPrev = null;
async function perf() {
  if (!("perf" in flags)) return "";
  const f = await js(`new Promise((r) => { let n = 0, worst = 0, last = performance.now(); const t0 = last;
    (function f() { const now = performance.now(); worst = Math.max(worst, now - last); last = now; n++;
      if (now - t0 < 1500) requestAnimationFrame(f); else r({ fps: n / ((now - t0) / 1000), worst }); })(); })`);
  const g = await js("window.__smokeGl ? { ...window.__smokeGl } : null");
  let gl = "";
  if (g) {
    const d = glPrev ? { programs: g.programs - glPrev.programs, draws: g.draws - glPrev.draws, frames: g.frames - glPrev.frames } : g;
    gl = `, ${Math.round(d.draws / Math.max(1, d.frames))} draws/frame, +${d.programs} programs`;
    glPrev = g;
  }
  return ` · ${f.fps.toFixed(0)} fps (worst ${Math.round(f.worst)} ms)${gl}`;
}

async function click(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(50);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
async function clickEl(selector) {
  const r = await rectOf(selector);
  if (!r) throw new Error(`${selector} not found`);
  if (r.disabled) throw new Error(`${selector} is disabled`);
  await click(r.x, r.y);
  return r;
}
const KEYS = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  " ": { code: "Space", keyCode: 32 },
  "]": { code: "BracketRight", keyCode: 221 },
  "[": { code: "BracketLeft", keyCode: 219 },
};
async function press(key) {
  const k = KEYS[key] ?? { code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text ?? (key.length === 1 ? key : undefined) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await keepVisible();
}
// Headless Chrome quirk: a CDP Escape key also reaches the browser, which marks the page hidden
// (visibilityState "hidden"), and requestAnimationFrame stops for the whole page. The app still got the key;
// bring the page back so the test keeps rendering. Not a demo bug.
let hiddenRestores = 0;
async function keepVisible() {
  await sleep(50);
  if ((await js("document.visibilityState")) === "visible") return;
  await send("Page.bringToFront");
  hiddenRestores++;
  if (!(await until(async () => (await js("document.visibilityState")) === "visible", 2000, 100))) fail("page stayed hidden after Page.bringToFront");
}
async function until(pred, ms, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await pred();
    if (last) return last;
    await sleep(every);
  }
  return null;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const file = `${prefix}-${name}.png`;
  writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
}
// Find a part under the pointer the way a user would: hover candidate points (nearest the screen centre
// first) and click only where the canvas shows the pointer cursor (select.js sets it over pickable parts), so
// probing never clicks empty space or the UI. Returns the opened card, or null.
async function clickPart(points, budgetMs = 60000) {
  let probes = 0;
  const end = Date.now() + budgetMs;
  for (const [px, py] of points) {
    if (Date.now() > end) fail(`no clickable part found within ${budgetMs / 1000}s (${probes} probes; page slow?)`);
    const x = Math.round(px);
    const y = Math.round(py);
    probes++;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(90); // select.js coalesces hover raycasts to one per frame, at most every 40 ms
    const over = await js(`(() => { const c = document.getElementById("scene");
      return document.elementFromPoint(${x}, ${y}) === c && c.style.cursor === "pointer"; })()`);
    if (!over) continue;
    await click(x, y);
    const c = await until(async () => {
      const s = await card();
      return s.open && s.title ? s : null;
    }, 800, 100);
    if (c) return { ...c, at: [x, y], probes };
  }
  return null;
}
function gridPoints(x0, x1, y0, y1, step) {
  const pts = [];
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) pts.push([x, y]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return pts.sort((a, b) => Math.hypot(a[0] - cx, (a[1] - cy) * 0.5) - Math.hypot(b[0] - cx, (b[1] - cy) * 0.5));
}

// ---------- steps ----------
const results = [];
const state = {};
async function step(name, fn, { needs = [] } = {}) {
  const t = Date.now();
  if (unresponsive) {
    results.push({ name, status: "SKIP", ms: 0, detail: `page unresponsive (${unresponsive} timed out)` });
    return print(results.at(-1));
  }
  const missing = needs.filter((n) => !results.find((r) => r.name === n && r.status === "PASS"));
  if (missing.length) {
    results.push({ name, status: "SKIP", ms: 0, detail: `needs ${missing.join(", ")}` });
    return print(results.at(-1));
  }
  let status = "PASS";
  let detail = "";
  try {
    detail = (await fn()) ?? "";
    if ((await js("document.visibilityState")) !== "visible") fail("page is hidden (rAF stopped) at the end of the step");
  } catch (e) {
    status = e.skip ? "SKIP" : "FAIL";
    detail = e.message;
    if (e.skip) {
      results.push({ name, status, ms: Date.now() - t, detail });
      return print(results.at(-1));
    }
    if (!unresponsive) {
      try {
        detail += ` | hud="${await hud()}"`;
        await shot(`fail-${name}`);
      } catch {}
    }
  }
  const reloads = consoleLog.filter((l) => l.level === "reload" && Number(l.t) * 1000 >= t - t0).length;
  if (reloads && status === "PASS") detail += " (page reloaded during this step)";
  else if (reloads) detail = `page reloaded during this step; ${detail}`;
  results.push({ name, status, ms: Date.now() - t, detail });
  print(results.at(-1));
}
function print(r) {
  console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(9)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.detail}`);
}
const fail = (msg) => {
  throw new Error(msg);
};
const skip = (msg) => {
  throw Object.assign(new Error(msg), { skip: true });
};

await step("load", async () => {
  await send("Page.navigate", { url });
  const want = presetName(startIndex);
  const h = await until(async () => {
    const t = await hud();
    return t.includes(want) ? t : null;
  }, ms("load"));
  if (!h) fail(`HUD never showed "${want}" within ${BUDGET.load}s`);
  await sleep(800); // first frames + prewarm
  await shot("load");
  return `HUD "${h}"`;
});

const params = new URL(url).searchParams;
const landingExpected = !["build", "story", "skip", "demo"].some((k) => params.has(k));
await step(
  "landing",
  async () => {
    if (!landingExpected) skip("URL has ?build / ?story / ?skip / ?demo: no landing page");
    const shown = await until(() => js(`!!document.querySelector(".landing .landing-go")`), 5000);
    if (!shown) fail("landing page (.landing .landing-go) did not appear");
    await shot("landing");
    await press("Enter");
    const start = Date.now();
    const done = await until(() => js(`!document.querySelector(".landing") && !document.body.classList.contains("landing")`), ms("landing"), 200);
    if (!done) fail(`still on the landing page ${BUDGET.landing}s after Enter`);
    const took = withinBudget("landing", start, "entering from the landing page");
    await mustBeSmooth("entering");
    return `Enter entered in ${took}; HUD "${await hud()}"`;
  },
  { needs: ["load"] },
);

await step(
  "build",
  async () => {
    await clickEl("#btn-build-all");
    const start = Date.now();
    const h = await until(async () => {
      const t = await hud();
      return VERDICT.test(t) ? t : null;
    }, ms("build"), 500);
    if (!h) fail(`no GO/NO-GO verdict within ${BUDGET.build}s`);
    const took = withinBudget("build", start, "Build all");
    await mustBeSmooth("Build all");
    await sleep(1200); // let the last lock flash and camera settle
    state.verdict = await hud();
    await shot("built");
    return `${took} to verdict: "${state.verdict}"${await perf()}`;
  },
  { needs: ["load"] },
);

await step(
  "card",
  async () => {
    const c = await clickPart(gridPoints(W * 0.35, W * 0.65, H * 0.08, H * 0.88, 24), ms("card"));
    if (!c) fail("found no clickable part on the stack (hover never showed the pointer cursor)");
    if (!partNames.has(c.title)) fail(`card title "${c.title}" is not a part name in the dataset/layout`);
    state.cardTitle = c.title;
    await shot("card");
    return `"${c.title}" (${c.eyebrow}) at ${c.at.join(",")} after ${c.probes} probe(s)${c.hasOptions ? " · has Options" : ""}`;
  },
  { needs: ["load"] },
);

await step(
  "options",
  async () => {
    let c = await card();
    if (!c.hasOptions) return `no Options on "${c.title}" (skipped)`;
    if (c.optionsDisabled) fail("Options button is disabled");
    const before = await hud();
    await clickEl("#detail .opt-toggle");
    const opts = await until(
      () =>
        js(`(() => { const l = document.querySelector("#detail .opt-list"); if (!l || l.hidden) return null;
        return [...l.querySelectorAll(".opt")].map((b) => ({ id: b.dataset.id, name: b.querySelector(".opt-name")?.textContent.trim(), current: b.getAttribute("aria-current") === "true", disabled: b.disabled })); })()`),
      2000,
    );
    if (!opts?.length) fail("Options list did not open");
    const pick = [opts[1], ...opts.slice(2), opts[0]].find((o) => o && !o.current && !o.disabled);
    if (!pick) fail("no selectable alternative in the Options list");
    await clickEl(`#detail .opt[data-id="${pick.id}"]`);
    const swapStart = Date.now();
    const after = await until(async () => {
      const t = await hud();
      return t !== before && VERDICT.test(t) ? t : null;
    }, Math.max(ms("swap") * 3, 15000), 200);
    if (!after) fail(`verdict line did not change within ${Math.max(BUDGET.swap * 3, 15)}s after choosing "${pick.name}"`);
    const took = withinBudget("swap", swapStart, "swap (option click to new verdict)");
    await mustBeSmooth("the swap");
    c = await until(async () => {
      const s = await card();
      return s.open && s.title === pick.name ? s : null;
    }, 5000);
    await shot("options");
    if (!c) fail(`HUD changed but the card does not show "${pick.name}" (shows "${(await card()).title}")`);
    return `${state.cardTitle} -> "${pick.name}" in ${took}; HUD "${after}"${await perf()}`;
  },
  { needs: ["card"] },
);

await step(
  "esc",
  async () => {
    if (!(await card()).open) fail("card was not open before Esc");
    await press("Escape");
    const closed = await until(async () => !(await card()).open, ms("esc"), 100);
    if (!closed) fail(`card still open ${BUDGET.esc}s after Esc`);
    return "card closed";
  },
  { needs: ["card"] },
);

await step(
  "explode",
  async () => {
    await clickEl("#btn-explode");
    const start = Date.now();
    const ok = await until(async () => (await rectOf("#btn-explode"))?.text === "Assemble", ms("explode"));
    if (!ok) fail(`button did not flip to "Assemble" (says "${(await rectOf("#btn-explode"))?.text}")`);
    // The explode springs have no DOM end signal: require smooth frames within the budget, then let them settle.
    if (!(await smooth(Math.max(0, ms("explode") - (Date.now() - start))))) fail(`page not rendering smoothly within ${BUDGET.explode}s of Explode (frames slower than ${JANK_MS} ms)`);
    const took = withinBudget("explode", start, "explode");
    await sleep(3500);
    await shot("exploded");
    return `button says Assemble, smooth after ${took}${await perf()}`;
  },
  { needs: ["build"] },
);

await step(
  "card2",
  async () => {
    // Exploded pieces spread sideways and up, so search a wider area than the built stack.
    const c = await clickPart(gridPoints(W * 0.25, W * 0.75, H * 0.05, H * 0.9, 28), ms("card2"));
    if (!c) fail("found no clickable piece in the exploded view (hover never showed the pointer cursor)");
    if (!partNames.has(c.title)) fail(`card title "${c.title}" is not a part name in the dataset/layout`);
    await shot("card2");
    await press("Escape");
    return `"${c.title}" (${c.eyebrow}) at ${c.at.join(",")} after ${c.probes} probe(s)`;
  },
  { needs: ["explode"] },
);

await step(
  "assemble",
  async () => {
    await clickEl("#btn-explode");
    const start = Date.now();
    // While assembling, main.js keeps the button disabled; enabled "Explode" means the springs are done.
    const ok = await until(async () => {
      const b = await rectOf("#btn-explode");
      return b?.text === "Explode" && !b.disabled;
    }, ms("assemble") * 3, 150);
    if (!ok) fail(`button did not come back as an enabled "Explode" (now "${(await rectOf("#btn-explode"))?.text}")`);
    const took = withinBudget("assemble", start, "assemble");
    await mustBeSmooth("assemble");
    await sleep(800);
    await shot("assembled");
    return `assembled in ${took}${await perf()}`;
  },
  { needs: ["explode"] },
);

await step(
  "next",
  async () => {
    const i = startIndex + 1;
    const want = presetName(i);
    await press("]");
    const h = await until(async () => {
      const t = await hud();
      return t.includes(want) && VERDICT.test(t) ? t : null;
    }, ms("next"));
    if (!h) fail(`HUD did not show "${want}" built with a GO / NO-GO verdict within ${BUDGET.next}s (HUD "${await hud()}")`);
    const q = await js("location.search");
    const id = presetOrder[i % presetOrder.length];
    if (!new URLSearchParams(q).get("build")?.startsWith(id)) fail(`URL is "${q}", expected ?build=${id}`);
    await mustBeSmooth("the preset switch");
    await sleep(1000);
    await shot("next");
    return `HUD "${h}"`;
  },
  { needs: ["load"] },
);

await step(
  "reset",
  async () => {
    const want = `Empty pad · blueprint: ${presetName(startIndex + 1)}`;
    await press("r");
    const h = await until(async () => {
      const t = await hud();
      return t.includes(want) ? t : null;
    }, ms("reset"), 300);
    if (!h) fail(`HUD did not show "${want}" within ${BUDGET.reset}s after R (HUD "${await hud()}")`);
    await sleep(600);
    await shot("reset");
    await press("1");
    const building = await until(async () => {
      const t = await hud();
      return /\b1\/\d+\b/.test(t) ? t : null;
    }, ms("reset"), 300);
    if (!building) fail(`key "1" did not build part 1 from the empty pad within ${BUDGET.reset}s (HUD "${await hud()}")`);
    return `R -> "${h}"; key 1 -> "${building}"`;
  },
  { needs: ["next"] },
);

// ---------- summary ----------
const errors = consoleLog.filter((l) => l.level !== "warning");
const reloadCount = consoleLog.filter((l) => l.level === "reload").length;
const warnings = consoleLog.filter((l) => l.level === "warning");
const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log("");
for (const l of consoleLog.slice(0, 40)) console.log(`  [${l.level} @${l.t}s] ${l.text}`);
if (consoleLog.length > 40) console.log(`  ... ${consoleLog.length - 40} more in the report`);
writeFileSync(`${prefix}-report.json`, JSON.stringify({ url, size: [W, H], results, console: consoleLog }, null, 2));
const ok = failed.length === 0 && errors.length === 0;
console.log(
  `${ok ? "SMOKE PASS" : "SMOKE FAIL"}: ${results.filter((r) => r.status === "PASS").length}/${results.length} steps passed` +
    `${failed.length ? `, failed: ${failed.map((r) => r.name).join(", ")}` : ""}` +
    `${skipped.length ? `, skipped: ${skipped.map((r) => r.name).join(", ")}` : ""}` +
    ` · ${errors.length - reloadCount} error(s)/exception(s), ${warnings.length} warning(s)` +
    `${reloadCount ? `, ${reloadCount} page reload(s): rerun with --serve` : ""}` +
    `${hiddenRestores ? `, page un-hidden ${hiddenRestores}x after Esc (headless quirk)` : ""} · report ${prefix}-report.json`,
);
ws.close();
await shutdown(ok ? 0 : 1);
