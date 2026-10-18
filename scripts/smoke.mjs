// Headless smoke test for the demo: drives a real Chrome over the DevTools protocol and checks the main flow.
// Run: node scripts/smoke.mjs <url> [outPrefix] [--size=1600x900] [--build-timeout=90]
//   e.g. node scripts/smoke.mjs "http://127.0.0.1:5191/?build=falcon-9" /tmp/smoke/f9
// No deps (Node >= 22 for the global WebSocket). Exits 1 if any assertion fails, 2 on a harness error.
// Never pass --virtual-time-budget to Chrome: requestAnimationFrame barely ticks and anime.js stalls.
//
// Flow (one summary line per step; screenshots <outPrefix>-<step>.png; report <outPrefix>-report.json):
//   load      HUD shows the preset's name
//   build     click "Build all", HUD reaches GO / NO-GO (verdict line) within --build-timeout seconds
//   card      click the stack, the card opens and its title is a part name from the dataset
//   options   if the card has Options: open them, pick the second alternative (the next one if the second is
//             the current record), the verdict line changes and the card shows the chosen record
//   esc       Esc closes the card
//   explode   click "Explode", the button flips to "Assemble"
//   card2     click a piece of the exploded stack, the card opens again
//   assemble  click "Assemble", the button flips back to "Explode"
//   next      "]" switches to the next preset (HUD shows its name, URL has ?build=<id>)
//   reset     build part 1 with key "1", then "R": HUD is back to "pad ready"
// Console warnings/errors, uncaught exceptions and failed loads are collected; exceptions and console errors
// fail the run, warnings are only reported.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [url, prefixArg = "smoke"] = args.filter((a) => !a.startsWith("--"));
if (!url) {
  console.error("usage: node scripts/smoke.mjs <url> [outPrefix] [--size=1600x900] [--build-timeout=90]");
  process.exit(2);
}
const prefix = resolve(prefixArg);
mkdirSync(dirname(prefix), { recursive: true });
const [W, H] = (flags.size ?? "1600x900").split("x").map(Number);
const BUILD_TIMEOUT_MS = Number(flags["build-timeout"] ?? 90) * 1000;

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
    "--use-angle=metal",
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() {
  try {
    chrome.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);

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
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    note("exception", d.exception?.description ?? d.text);
  } else if (m.method === "Log.entryAdded" && ["warning", "error"].includes(m.params.entry.level)) {
    note(m.params.entry.level, `[${m.params.entry.source}] ${m.params.entry.text}${m.params.entry.url ? " " + m.params.entry.url : ""}`);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++nextId;
    const timer = setTimeout(() => rej(new Error(`CDP ${method} timed out`)), 30000);
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
  " ": { code: "Space", keyCode: 32 },
  "]": { code: "BracketRight", keyCode: 221 },
  "[": { code: "BracketLeft", keyCode: 219 },
};
async function press(key) {
  const k = KEYS[key] ?? { code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: key.length === 1 ? key : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
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
// Click candidate points (centre column first, then fanning out) until the card opens on a part.
async function clickUntilCard(points) {
  for (const [x, y] of points) {
    await click(Math.round(x), Math.round(y));
    const c = await until(async () => {
      const s = await card();
      return s.open && s.title ? s : null;
    }, 700, 100);
    if (c) return { ...c, at: [Math.round(x), Math.round(y)] };
  }
  return null;
}
function columnPoints(cx, yFrom, yTo, step) {
  const pts = [];
  const mid = (yFrom + yTo) / 2;
  for (let d = 0; d <= (yTo - yFrom) / 2; d += step) {
    pts.push([cx, mid - d]);
    if (d) pts.push([cx, mid + d]);
  }
  return pts;
}

// ---------- steps ----------
const results = [];
const state = {};
async function step(name, fn, { needs = [] } = {}) {
  const t = Date.now();
  const missing = needs.filter((n) => !results.find((r) => r.name === n && r.status === "PASS"));
  if (missing.length) {
    results.push({ name, status: "SKIP", ms: 0, detail: `needs ${missing.join(", ")}` });
    return print(results.at(-1));
  }
  let status = "PASS";
  let detail = "";
  try {
    detail = (await fn()) ?? "";
  } catch (e) {
    status = "FAIL";
    detail = e.message;
    try {
      detail += ` | hud="${await hud()}"`;
      await shot(`fail-${name}`);
    } catch {}
  }
  results.push({ name, status, ms: Date.now() - t, detail });
  print(results.at(-1));
}
function print(r) {
  console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(9)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.detail}`);
}
const fail = (msg) => {
  throw new Error(msg);
};

await step("load", async () => {
  await send("Page.navigate", { url });
  const want = presetName(startIndex);
  const h = await until(async () => {
    const t = await hud();
    return t.includes(want) ? t : null;
  }, 20000);
  if (!h) fail(`HUD never showed "${want}"`);
  await sleep(800); // first frames + prewarm
  await shot("load");
  return `HUD "${h}"`;
});

await step(
  "build",
  async () => {
    await clickEl("#btn-build-all");
    const start = Date.now();
    const h = await until(async () => {
      const t = await hud();
      return VERDICT.test(t) ? t : null;
    }, BUILD_TIMEOUT_MS, 500);
    if (!h) fail(`no GO/NO-GO verdict within ${BUILD_TIMEOUT_MS / 1000}s`);
    await sleep(1200); // let the last lock flash and camera settle
    state.verdict = await hud();
    await shot("built");
    return `${((Date.now() - start) / 1000).toFixed(1)}s to verdict: "${state.verdict}"`;
  },
  { needs: ["load"] },
);

await step(
  "card",
  async () => {
    const c = await clickUntilCard(columnPoints(W / 2, H * 0.12, H * 0.88, 30));
    if (!c) fail("no click on the centre column opened the card");
    if (!partNames.has(c.title)) fail(`card title "${c.title}" is not a part name in the dataset/layout`);
    state.cardTitle = c.title;
    await shot("card");
    return `"${c.title}" (${c.eyebrow}) at ${c.at.join(",")}${c.hasOptions ? " · has Options" : ""}`;
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
    const after = await until(async () => {
      const t = await hud();
      return t !== before && VERDICT.test(t) ? t : null;
    }, 60000, 300);
    if (!after) fail(`verdict line did not change within 60s after choosing "${pick.name}"`);
    c = await until(async () => {
      const s = await card();
      return s.open && s.title === pick.name ? s : null;
    }, 5000);
    await shot("options");
    if (!c) fail(`HUD changed but the card does not show "${pick.name}" (shows "${(await card()).title}")`);
    return `${state.cardTitle} -> "${pick.name}"; HUD "${after}"`;
  },
  { needs: ["card"] },
);

await step(
  "esc",
  async () => {
    if (!(await card()).open) fail("card was not open before Esc");
    await press("Escape");
    const closed = await until(async () => !(await card()).open, 1500, 100);
    if (!closed) fail("card still open after Esc");
    return "card closed";
  },
  { needs: ["card"] },
);

await step(
  "explode",
  async () => {
    await clickEl("#btn-explode");
    const ok = await until(async () => (await rectOf("#btn-explode"))?.text === "Assemble", 3000);
    if (!ok) fail(`button did not flip to "Assemble" (says "${(await rectOf("#btn-explode"))?.text}")`);
    await sleep(3500); // springs settle
    await shot("exploded");
    return "button says Assemble";
  },
  { needs: ["build"] },
);

await step(
  "card2",
  async () => {
    // Exploded pieces spread sideways and up: centre column, then two side columns.
    const pts = [
      ...columnPoints(W / 2, H * 0.08, H * 0.9, 30),
      ...columnPoints(W / 2 - W * 0.06, H * 0.1, H * 0.85, 40),
      ...columnPoints(W / 2 + W * 0.06, H * 0.1, H * 0.85, 40),
    ];
    const c = await clickUntilCard(pts);
    if (!c) fail("no click on the exploded stack opened the card");
    if (!partNames.has(c.title)) fail(`card title "${c.title}" is not a part name in the dataset/layout`);
    await shot("card2");
    await press("Escape");
    return `"${c.title}" (${c.eyebrow}) at ${c.at.join(",")}`;
  },
  { needs: ["explode"] },
);

await step(
  "assemble",
  async () => {
    await clickEl("#btn-explode");
    const ok = await until(async () => (await rectOf("#btn-explode"))?.text === "Explode", 3000);
    if (!ok) fail(`button did not flip back to "Explode" (says "${(await rectOf("#btn-explode"))?.text}")`);
    await sleep(3500);
    await shot("assembled");
    return "button says Explode";
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
      return t.includes(want) ? t : null;
    }, 8000);
    if (!h) fail(`HUD did not switch to "${want}"`);
    const q = await js("location.search");
    const id = presetOrder[i % presetOrder.length];
    if (!new URLSearchParams(q).get("build")?.startsWith(id)) fail(`URL is "${q}", expected ?build=${id}`);
    await sleep(1500);
    await shot("next");
    return `HUD "${h}"`;
  },
  { needs: ["load"] },
);

await step(
  "reset",
  async () => {
    await press("1");
    const building = await until(async () => /\b1\/\d+\b/.test(await hud()), 15000, 300);
    if (!building) fail(`key "1" did not build part 1 (HUD "${await hud()}")`);
    await press("r");
    const h = await until(async () => {
      const t = await hud();
      return /pad ready/i.test(t) ? t : null;
    }, 15000, 300);
    if (!h) fail("HUD never returned to \"pad ready\" after R");
    await sleep(800);
    await shot("reset");
    return `HUD "${h}"`;
  },
  { needs: ["next"] },
);

// ---------- summary ----------
const errors = consoleLog.filter((l) => l.level !== "warning");
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
    ` · ${errors.length} error(s)/exception(s), ${warnings.length} warning(s) · report ${prefix}-report.json`,
);
ws.close();
cleanup();
process.exit(ok ? 0 : 1);
