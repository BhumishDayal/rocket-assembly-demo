// Shared plumbing for scripts/visual-regress.mjs and scripts/qa/mobile-qa.mjs (no deps, Node >= 22):
//   serveSnapshot()  the smoke.mjs --serve recipe: copy index.html, src/, vite.config.js to a temp folder and serve
//                    that frozen snapshot with the repo's Vite on a free port, own dependency cache, no HMR;
//   openBrowser()    one headless Chrome (own profile, random debugging port) and a CDP session on its page, with
//                    the input helpers the flows need and the console collected;
//   checkUrl()       refuses port 5173 (the user's live view).
// Headless pitfalls handled here (see scripts/README.md): no --virtual-time-budget (rAF barely ticks and
// anime.js stalls; the repeatable timing comes from lib/vclock.mjs instead); a CDP Escape also reaches headless
// Chrome, which marks the page hidden and stops rAF, so every key press is followed by Page.bringToFront when
// needed; a page reload (another chat saving into a live dev server) is counted so callers can fail on it.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --a=b --c  ->  { a: "b", c: true }; everything else is positional.
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (const a of argv.filter((x) => x.startsWith("--"))) {
    const [k, ...v] = a.slice(2).split("=");
    flags[k] = v.length ? v.join("=") : true;
  }
  return { flags, positional: argv.filter((a) => !a.startsWith("--")) };
}

export function checkUrl(url) {
  const u = new URL(url);
  if (u.port === "5173") throw new Error("port 5173 is the user's live view; use --serve or another dev server");
  return u;
}

const cleanups = new Set();
function runCleanups() {
  for (const fn of [...cleanups].reverse()) {
    try {
      fn();
    } catch {}
  }
  cleanups.clear();
}
process.on("exit", runCleanups);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
const exited = (p) => (!p || p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", r)));

// Frozen snapshot of the tree, served by the repo's own Vite. Returns { base, dir, close }.
export async function serveSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "qa-snap-"));
  for (const f of ["index.html", "vite.config.js", "package.json"]) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(dir, f));
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  if (existsSync(join(repo, "public"))) cpSync(join(repo, "public"), join(dir, "public"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  // Own dependency cache (the shared node_modules/.vite belongs to the user's server) and no HMR.
  writeFileSync(
    join(dir, "vite.qa.config.mjs"),
    `import base from "./vite.config.js";\nexport default { ...base, cacheDir: ${JSON.stringify(join(dir, ".vite-cache"))}, clearScreen: false, logLevel: "warn", server: { ...(base.server ?? {}), hmr: false } };\n`,
  );
  const port = await freePort();
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(process.execPath, [vite, "--config", "vite.qa.config.mjs", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const kill = () => {
    try {
      server.kill();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.add(kill);
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base)).ok) {
        return {
          base,
          dir,
          async close() {
            try {
              server.kill();
            } catch {}
            await Promise.race([exited(server), sleep(3000)]);
            kill();
            cleanups.delete(kill);
          },
        };
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`snapshot server did not start:\n${log}`);
}

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const KEYS = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  " ": { code: "Space", keyCode: 32, text: " " },
  "]": { code: "BracketRight", keyCode: 221 },
  "[": { code: "BracketLeft", keyCode: 219 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
};

// One headless Chrome and a CDP session on its first page.
//   width/height/dpr/mobile/touch: the emulated device; angle: GL backend (metal on macOS by default).
// Returns the page API: send, js, press, move, click, tap, shot, keepVisible, version, consoleLog, close, ...
export async function openBrowser({ width = 1600, height = 900, dpr = 1, mobile = false, touch = false, angle } = {}) {
  const exe = process.env.CHROME ?? CHROME_PATHS.find(existsSync);
  if (!exe) throw new Error("Chrome not found; set CHROME=/path/to/chrome");
  const profile = mkdtempSync(join(tmpdir(), "qa-chrome-"));
  const chrome = spawn(
    exe,
    [
      "--headless=new",
      `--use-angle=${angle ?? (process.platform === "darwin" ? "metal" : "default")}`,
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const kill = () => {
    try {
      chrome.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  cleanups.add(kill);

  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("Chrome did not start (no DevToolsActivePort)");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let targets = [];
  for (let i = 0; i < 40 && !targets.some((t) => t.type === "page"); i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {}
    if (!targets.some((t) => t.type === "page")) await sleep(150);
  }
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket failed"));
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  const consoleLog = []; // { level, text, t, url }
  const t0 = Date.now();
  const page = {
    width,
    height,
    dpr,
    consoleLog,
    navigations: 0,
    unresponsive: null, // first CDP method that timed out
    hiddenRestores: 0,
  };
  const note = (level, text, url) => consoleLog.push({ level, text: String(text).slice(0, 500), url, t: Number(((Date.now() - t0) / 1000).toFixed(1)) });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
    if (m.method === "Runtime.consoleAPICalled" && ["warning", "error", "assert"].includes(m.params.type)) {
      note(m.params.type === "warning" ? "warning" : "error", m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      note("exception", d.exception?.description ?? d.text, d.url);
    } else if (m.method === "Log.entryAdded" && ["warning", "error"].includes(m.params.entry.level)) {
      const en = m.params.entry;
      if (/\/favicon\.ico$/.test(en.url ?? "")) return; // the page declares no favicon; not a demo bug
      note(en.level, `[${en.source}] ${en.text}${en.url ? " " + en.url : ""}`, en.url);
    } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId && !m.params.frame.url.startsWith("about:")) {
      page.navigations++;
    }
  };
  page.on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  page.send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((res, rej) => {
      const i = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(i);
        page.unresponsive ??= method;
        rej(new Error(`CDP ${method} timed out after ${timeoutMs / 1000}s (page unresponsive)`));
      }, timeoutMs);
      pending.set(i, (m) => {
        clearTimeout(timer);
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  page.js = async (expr, timeoutMs = 30000) => {
    const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  page.until = async (pred, ms, every = 200) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await pred();
      if (last) return last;
      await sleep(every);
    }
    return null;
  };

  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
  if (touch) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  page.version = (await page.send("Browser.getVersion")).product;

  // Headless quirk: an Escape (and sometimes other keys) also reaches the browser, which marks the page hidden
  // and stops rAF. The app still got the key; bring the page back.
  page.keepVisible = async () => {
    await sleep(30);
    if ((await page.js("document.visibilityState")) === "visible") return true;
    await page.send("Page.bringToFront");
    page.hiddenRestores++;
    return Boolean(await page.until(async () => (await page.js("document.visibilityState")) === "visible", 2000, 50));
  };
  // press("Tab", { shift: true }) sends Shift+Tab.
  page.press = async (key, { shift = false } = {}) => {
    const k = KEYS[key] ?? { code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
    const text = k.text ?? (key.length === 1 ? key : undefined);
    await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await page.keepVisible();
  };
  page.move = (x, y) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  page.click = async (x, y) => {
    await page.move(x, y);
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(40);
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  };
  page.tap = async (x, y) => {
    await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
    await sleep(60);
    await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // Centre of a visible element (scrolled into view), or null.
  page.rect = (selector) =>
    page.js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      const shown = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]");
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, shown, disabled: !!el.disabled, text: el.textContent.trim() }; })()`);
  page.clickEl = async (selector, { touch: useTouch = false } = {}) => {
    const r = await page.rect(selector);
    if (!r?.shown) throw new Error(`${selector} not found or not visible`);
    if (r.disabled) throw new Error(`${selector} is disabled`);
    if (useTouch) await page.tap(r.x, r.y);
    else await page.click(r.x, r.y);
    return r;
  };
  page.shot = async (file) => {
    const r = await page.send("Page.captureScreenshot", { format: "png" }, 60000);
    const buf = Buffer.from(r.data, "base64");
    if (file) writeFileSync(file, buf);
    return buf;
  };
  page.close = async () => {
    try {
      ws.close();
    } catch {}
    try {
      chrome.kill();
    } catch {}
    await Promise.race([exited(chrome), sleep(3000)]);
    kill();
    cleanups.delete(kill);
  };
  return page;
}
