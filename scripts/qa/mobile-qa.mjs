// Mobile, keyboard, reduced-motion and lite QA for the demo in a real headless Chrome; writes an issue list.
// Run:  node scripts/qa/mobile-qa.mjs --serve                 (frozen snapshot of the tree on a free port)
//       node scripts/qa/mobile-qa.mjs http://127.0.0.1:5191/  (any server but 5173)
// Configs (--configs=phone,tablet,keyboard,reduced-motion,lite; default all, one Chrome at a time):
//   phone           390x844 DPR 2, touch: taps for buttons and parts (parts are found by mouse hover first)
//   tablet          768x1024 DPR 2, touch
//   keyboard        1600x900, keyboard only: Tab to each control, Enter / Space to use it, Esc to close
//   reduced-motion  1600x900, mouse, prefers-reduced-motion: reduce (also lists animations still running)
//   lite            390x844 DPR 2, touch, ?lite=1
// Flow (pointer configs): landing, enter, build (Build all -> verdict), card (a part), options, close (tap on empty
// space), explode, assemble, rockets (list open), compare (C, closest real rocket), liftoff, flight, ending.
// Keyboard: landing (Tab to the button), enter, tab-order (one full Tab cycle), build, explode, space (Space on a
// focused button), rockets, compare, launch; plus whether a part card can be reached at all.
// After each step: a screenshot (scripts/qa/shots/<config>/NN-<step>.png), real frame times (frames over 50 ms),
// and a layout probe in the page: overlapping text / controls (text line boxes, not element boxes), text cut by
// an overflow box or the screen edge (ellipsis truncation listed separately), enabled controls that are off
// screen or covered (elementFromPoint at their centre), touch targets under 24 px, text under 11 px on touch
// devices, sideways page scroll. Console errors and exceptions are collected per config.
// Output: scripts/qa/report.md (issue list first, then per-step tables) and scripts/qa/shots/ (--out=dir moves
// both). Frame times are real (no virtual clock here) and depend on what else the machine is running.
// Exit: 0 ran (issues are in the report), 2 harness error.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";
import { checkUrl, openBrowser, parseArgs, repo, serveSnapshot, sleep } from "./lib/browser.mjs";

const { flags, positional } = parseArgs();
const ALL = {
  phone: { label: "Phone 390×844 @2x, touch", width: 390, height: 844, dpr: 2, mobile: true, touch: true, flow: "pointer" },
  tablet: { label: "Tablet 768×1024 @2x, touch", width: 768, height: 1024, dpr: 2, mobile: true, touch: true, flow: "pointer" },
  keyboard: { label: "Keyboard only, 1600×900", width: 1600, height: 900, dpr: 1, flow: "keyboard" },
  "reduced-motion": { label: "prefers-reduced-motion, 1600×900, mouse", width: 1600, height: 900, dpr: 1, reduced: true, flow: "pointer" },
  lite: { label: "?lite=1, phone 390×844 @2x, touch", width: 390, height: 844, dpr: 2, mobile: true, touch: true, query: "lite=1", flow: "pointer" },
};
const names = String(flags.configs ?? Object.keys(ALL).join(",")).split(",").filter(Boolean);
for (const n of names) if (!ALL[n]) (console.error(`unknown config "${n}" (known: ${Object.keys(ALL).join(", ")})`), process.exit(2));
const outDir = resolve(String(flags.out ?? join(repo, "scripts", "qa")));
const shotsDir = join(outDir, "shots");
if (!flags.serve && !positional[0]) {
  console.error("usage: node scripts/qa/mobile-qa.mjs --serve | <base url>  [--configs=phone,tablet,keyboard,reduced-motion,lite] [--out=dir]");
  process.exit(2);
}
const presets = JSON.parse(readFileSync(join(repo, "src", "data", "presets.json"), "utf8"));

// ---------- page-side instrumentation (installed before the page's scripts) ----------
const PAGE_SRC = `(() => {
  // Real frame intervals (rAF to rAF), reset by the harness per step; a hidden page's gap is not counted.
  const raf = window.requestAnimationFrame.bind(window);
  const q = (window.__qaFrames = { list: [], last: 0 });
  (function f(t) { if (q.last && document.visibilityState === "visible") q.list.push(t - q.last); q.last = t; raf(f); })(0);
  document.addEventListener("visibilitychange", () => (q.last = 0));

  const desc = (el) => {
    if (!el) return "nothing";
    if (el === document.body || el === document.documentElement) return el.tagName.toLowerCase();
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    if (el.getAttribute("aria-current") === "true") s += "[current]";
    const t = (el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    return t ? s + ' "' + (t.length > 42 ? t.slice(0, 41) + "…" : t) + '"' : s;
  };
  // Shown by style: not [hidden], visibility visible, opacity product over the ancestors above 5 %.
  const styleShown = (el) => {
    if (!el?.isConnected || el.closest("[hidden]")) return false;
    if (getComputedStyle(el).visibility !== "visible") return false;
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.display === "none") return false;
      o *= Number(c.opacity);
    }
    return o > 0.05;
  };
  const clippers = (el) => {
    const list = [];
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.display !== "inline" && (c.overflowX !== "visible" || c.overflowY !== "visible")) list.push(e);
    }
    return list;
  };
  const inner = (e) => {
    const b = e.getBoundingClientRect();
    const L = b.left + e.clientLeft, T = b.top + e.clientTop;
    return { left: L, top: T, right: L + e.clientWidth, bottom: T + e.clientHeight };
  };
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  // How a rect fares against its overflow ancestors: ok | scrolls | truncated (ellipsis / line clamp) | clipped.
  function fate(el, r) {
    for (const c of clippers(el)) {
      const b = inner(c);
      const cs = getComputedStyle(c);
      const outX = r.left < b.left - 1.5 || r.right > b.right + 1.5;
      const outY = r.top < b.top - 1.5 || r.bottom > b.bottom + 1.5;
      if (!outX && !outY) continue;
      const scrollX = /auto|scroll/.test(cs.overflowX) && c.scrollWidth > c.clientWidth;
      const scrollY = /auto|scroll/.test(cs.overflowY) && c.scrollHeight > c.clientHeight;
      if ((outX && !scrollX) || (outY && !scrollY)) {
        const ell = [el, c].some((e) => getComputedStyle(e).textOverflow === "ellipsis" || (getComputedStyle(e).webkitLineClamp ?? "none") !== "none");
        return { kind: ell ? "truncated" : "clipped", by: c };
      }
      return { kind: "scrolls", by: c };
    }
    return { kind: "ok" };
  }
  const visiblePart = (el, r) => {
    let v = meet(r, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    for (const c of clippers(el)) v = meet(v, inner(c));
    return area(v) > 0.5 ? v : null;
  };

  window.__qaProbe = ({ touch = false } = {}) => {
    const W = innerWidth, H = innerHeight;
    const issues = [];
    const add = (category, severity, what, detail = "") => issues.push({ category, severity, what, detail });
    const items = []; // { owner, rect, text|control }
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest("script, style, noscript, canvas, template") || !styleShown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1);
      if (!rects.length) continue;
      let worst = { kind: "ok" };
      for (const r of rects) {
        const f = fate(el, r);
        if (f.kind === "clipped" || (f.kind === "truncated" && worst.kind !== "clipped")) worst = f;
      }
      const key = desc(el);
      if (worst.kind !== "ok" && !seen.has(worst.kind + key)) {
        seen.add(worst.kind + key);
        if (worst.kind === "clipped") add("clipped text", "major", key, "cut by " + desc(worst.by));
        else if (worst.kind === "truncated") {
          const tip = el.closest("[title]");
          add("truncated text", "minor", key, "cut with an ellipsis" + (worst.by !== el ? " by " + desc(worst.by) : "") + (tip ? (touch ? "; the full text is only in a title tooltip, which touch screens do not show" : "; full text in a title tooltip") : ""));
        }
      }
      // Off the screen edge: the part left after the overflow boxes (ellipsis, scrolled-out) still crosses it.
      const kept = rects.map((r) => clippers(el).reduce((v, c) => meet(v, inner(c)), r)).filter((v) => area(v) > 0.5);
      if (kept.some((v) => v.left < -1 || v.top < -1 || v.right > W + 1 || v.bottom > H + 1) && !seen.has("off" + key)) {
        seen.add("off" + key);
        add("clipped text", "major", key, "runs off the screen edge");
      }
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (touch && fs < 11 && !seen.has("tiny" + key)) {
        seen.add("tiny" + key);
        add("tiny text", "minor", key, fs.toFixed(1) + " px");
      }
      for (const r of rects) {
        const v = visiblePart(el, r);
        if (v) items.push({ owner: el, rect: v });
      }
    }
    const controls = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])")].filter((el) => el.tagName !== "CANVAS");
    for (const el of controls) {
      if (!styleShown(el) || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const key = desc(el);
      if (touch && (r.width < 24 || r.height < 24)) add("small touch target", "minor", key, Math.round(r.width) + "×" + Math.round(r.height) + " px (WCAG 2.5.8 asks for 24×24)");
      if (fate(el, r).kind === "scrolls") continue; // inside a scroll box: reachable by scrolling it
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > W || cy > H) {
        add("unreachable control", "major", key, "off screen (centre at " + Math.round(cx) + "," + Math.round(cy) + ")");
        continue;
      }
      const v = visiblePart(el, r);
      if (!v) {
        add("unreachable control", "major", key, "hidden by " + desc(fate(el, r).by ?? el.parentElement));
        continue;
      }
      items.push({ owner: el, rect: v, control: true });
      const top = document.elementFromPoint((v.left + v.right) / 2, (v.top + v.bottom) / 2);
      if (top !== el && !el.contains(top)) add("unreachable control", "major", key, "covered by " + desc(top));
    }
    // Overlaps between different owners (a control and the text inside it are one owner).
    const pairs = new Set();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
        const ov = area(meet(a.rect, b.rect));
        if (ov < 16 || ov < 0.25 * Math.min(area(a.rect), area(b.rect))) continue;
        const k = desc(a.owner) + " | " + desc(b.owner);
        if (pairs.has(k)) continue;
        pairs.add(k);
        add("overlap", "major", desc(a.owner), "overlaps " + desc(b.owner));
      }
    }
    const hudText = document.getElementById("hud-text");
    const onLanding = document.body.classList.contains("landing") || !!document.querySelector(".landing");
    if (!onLanding && hudText?.textContent.trim() && !(styleShown(hudText) && hudText.getBoundingClientRect().width > 0)) {
      add("hidden information", "major", "#hud", "the HUD line has text but is not shown at this size, so the GO / NO-GO verdict, launch telemetry and outcome never appear");
    }
    if (document.documentElement.scrollWidth > W + 1) add("sideways scroll", "major", "page", "content is " + document.documentElement.scrollWidth + " px wide in a " + W + " px viewport");
    return issues;
  };
  // Animations running now (for prefers-reduced-motion).
  window.__qaMotion = () =>
    document.getAnimations().filter((a) => a.playState === "running").map((a) => {
      const t = a.effect?.getComputedTiming?.() ?? {};
      return { what: desc(a.effect?.target), name: a.animationName || a.transitionProperty || "Web Animation", ms: t.duration === Infinity ? "infinite" : Math.round(Number(t.duration) || 0), infinite: t.endTime === Infinity };
    }).filter((m) => m.infinite || m.ms > 0);
  window.__qaDesc = desc;
  window.__qaShown = (el) => styleShown(el) && el.getBoundingClientRect().width > 0;
})();`;

// ---------- run ----------
let snap = null;
let base;
try {
  if (flags.serve) {
    snap = await serveSnapshot();
    base = snap.base;
  } else base = checkUrl(positional[0]).href;
} catch (e) {
  console.error("harness error:", e.message);
  process.exit(2);
}
rmSync(shotsDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });
const runs = [];
for (const name of names) runs.push(await runConfig(name, ALL[name]));
await snap?.close();
writeReport(runs);
process.exit(0);

async function runConfig(name, cfg) {
  console.log(`\n${name}: ${cfg.label}`);
  const dir = join(shotsDir, name);
  mkdirSync(dir, { recursive: true });
  const page = await openBrowser({ width: cfg.width, height: cfg.height, dpr: cfg.dpr, mobile: cfg.mobile, touch: cfg.touch, angle: flags.angle }).catch((e) => {
    console.error("harness error:", e.message);
    process.exit(2);
  });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SRC });
  if (cfg.reduced) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const W = cfg.width;
  const H = cfg.height;
  const run = { name, cfg, steps: [], issues: [], console: page.consoleLog, chrome: page.version, notes: [] };
  let n = 0;
  let expectedNav = 0;

  const hud = () => page.js(`document.getElementById("hud-text")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);
  const card = () =>
    page.js(`(() => { const el = document.getElementById("detail"); if (!el) return { open: false };
      const r = el.getBoundingClientRect();
      return { open: el.classList.contains("open") && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden", title: el.querySelector("h2")?.textContent?.trim() ?? "",
        hasOptions: !!el.querySelector(".opt-toggle:not([disabled])") }; })()`);
  const VERDICT = /\b(NO-)?GO\b/;
  const fail = (msg) => {
    throw new Error(msg);
  };
  const skip = (msg) => {
    throw Object.assign(new Error(msg), { skip: true });
  };
  const issue = (category, severity, what, detail, step) => run.issues.push({ category, severity, what, detail, step, shot: null });
  async function nav(query) {
    expectedNav++;
    await page.send("Page.navigate", { url: new URL(query, base).href });
    if (!(await page.until(() => page.js(`document.readyState === "complete" && !!document.getElementById("hud-text")`).catch(() => false), 30000, 250))) fail("page did not load within 30 s");
  }
  // Tap on touch configs, click otherwise.
  const act = (selector) => page.clickEl(selector, { touch: cfg.touch });
  const actAt = (x, y) => (cfg.touch ? page.tap(x, y) : page.click(x, y));

  async function step(name, fn, { needs = [], shot = true, probe = true } = {}) {
    const t0 = Date.now();
    const rec = { name, status: "PASS", detail: "", s: 0, frames: null, shot: null };
    run.steps.push(rec);
    const missing = needs.filter((d) => run.steps.find((s) => s.name === d)?.status !== "PASS");
    if (page.unresponsive || missing.length) {
      rec.status = "SKIP";
      rec.detail = page.unresponsive ? `page unresponsive (${page.unresponsive} timed out)` : `needs ${missing.join(", ")}`;
      return print(rec);
    }
    await page.js("window.__qaFrames && (window.__qaFrames.list = [])").catch(() => {});
    try {
      rec.detail = (await fn()) ?? "";
    } catch (e) {
      rec.status = e.skip ? "SKIP" : "FAIL";
      rec.detail = e.message;
      if (!e.skip) rec.detail += ` | HUD "${await hud().catch(() => "?")}"`;
    }
    rec.s = (Date.now() - t0) / 1000;
    if (page.navigations > expectedNav) {
      rec.status = "FAIL";
      rec.detail = `the page reloaded during this step (use --serve); ${rec.detail}`;
      expectedNav = page.navigations;
    }
    if (page.unresponsive) return print(rec);
    rec.frames = await page.js(`(() => { const l = window.__qaFrames?.list ?? []; const s = [...l].sort((a, b) => a - b);
      return { n: l.length, over50: l.filter((x) => x > 50).length, worst: Math.round(s.at(-1) ?? 0), p95: Math.round(s[Math.floor(s.length * 0.95)] ?? 0),
        fps: l.length ? 1000 / (l.reduce((a, b) => a + b, 0) / l.length) : 0 }; })()`).catch(() => null);
    if (shot && rec.status !== "SKIP") {
      rec.shot = join(dir, `${String(++n).padStart(2, "0")}-${name}.png`);
      await page.shot(rec.shot).catch(() => (rec.shot = null));
    }
    if (probe && rec.status !== "SKIP") {
      const found = await page.js(`window.__qaProbe({ touch: ${Boolean(cfg.touch)} })`).catch((e) => [{ category: "harness", severity: "minor", what: "layout probe failed", detail: e.message }]);
      for (const f of found) run.issues.push({ ...f, step: name, shot: rec.shot });
    }
    if (cfg.reduced && rec.status !== "SKIP") {
      const motion = await page.js("window.__qaMotion()").catch(() => []);
      for (const m of motion) issue("motion under reduced motion", "minor", m.what, `${m.name} (${m.ms}${m.ms === "infinite" ? "" : " ms"}) still running`, name);
    }
    print(rec);
  }
  function print(r) {
    const f = r.frames ? ` · ${r.frames.n} frames, ${r.frames.over50} over 50 ms, worst ${r.frames.worst} ms` : "";
    console.log(`  ${r.status.padEnd(4)} ${r.name.padEnd(12)} ${r.s.toFixed(1).padStart(5)} s  ${r.detail}${f}`);
  }

  // Part under the pointer: hover candidate points (nearest the centre first) until the canvas shows the pointer
  // cursor (select.js), then tap / click there.
  async function openPart() {
    const pts = [];
    for (let x = W * 0.3; x <= W * 0.7; x += Math.max(12, W / 40)) for (let y = H * 0.08; y <= H * 0.8; y += Math.max(12, H / 50)) pts.push([Math.round(x), Math.round(y)]);
    pts.sort((p, q) => Math.hypot(p[0] - W / 2, (p[1] - H * 0.45) * 0.5) - Math.hypot(q[0] - W / 2, (q[1] - H * 0.45) * 0.5));
    const end = Date.now() + 60000;
    for (const [x, y] of pts) {
      if (Date.now() > end) break;
      await page.move(x, y);
      await sleep(90);
      const over = await page.js(`(() => { const c = document.getElementById("scene"); return document.elementFromPoint(${x}, ${y}) === c && c.style.cursor === "pointer"; })()`);
      if (!over) continue;
      await actAt(x, y);
      const c = await page.until(async () => {
        const s = await card();
        return s.open && s.title ? s : null;
      }, 2000, 100);
      if (c) return { ...c, at: [x, y] };
    }
    return null;
  }
  // A canvas point with nothing pickable under it.
  async function emptyPoint() {
    const cands = [[0.5, 0.06], [0.92, 0.3], [0.08, 0.3], [0.92, 0.55], [0.08, 0.55], [0.5, 0.2], [0.75, 0.15], [0.25, 0.15]].map(([fx, fy]) => [Math.round(W * fx), Math.round(H * fy)]);
    for (const [x, y] of cands) {
      await page.move(x, y);
      await sleep(90);
      const ok = await page.js(`(() => { const c = document.getElementById("scene"); return document.elementFromPoint(${x}, ${y}) === c && c.style.cursor !== "pointer"; })()`);
      if (ok) return [x, y];
    }
    return null;
  }
  const waitVerdict = (ms) => page.until(async () => (VERDICT.test(await hud()) ? await hud() : null), ms, 400);
  const launchButtonReady = () => page.until(() => page.js(`(() => { const b = document.getElementById("btn-build-all"); return !!b && !b.disabled && b.textContent.trim() === "Launch"; })()`), 15000, 200);
  // Frames up to here are the page load (shader warm-up): kept apart from the step's own frames.
  async function loadStall() {
    await sleep(300);
    run.load = await page.js(`(() => { const l = window.__qaFrames.list; const r = { n: l.length, over50: l.filter((x) => x > 50).length, worst: Math.round(Math.max(0, ...l)) }; window.__qaFrames.list = []; return r; })()`);
  }
  const ENDING = /\bIn [a-z]|ORBIT|Landed|Stranded|short by|Did not reach|Pad abort/i;

  if (cfg.flow === "pointer") {
    const query = cfg.query ? `./?${cfg.query}` : "./";
    await step("landing", async () => {
      await nav(query);
      if (!(await page.until(() => page.js(`!!document.querySelector(".landing .landing-go")`), 20000))) fail("landing page (.landing .landing-go) did not appear");
      await loadStall();
      await sleep(1500);
      return `landing shown${run.load ? ` (load: worst frame ${run.load.worst} ms)` : ""}`;
    });
    await step(
      "enter",
      async () => {
        await act(".landing .landing-go");
        const t = Date.now();
        if (!(await page.until(() => page.js(`!document.querySelector(".landing") && !document.body.classList.contains("landing")`), 20000, 200))) fail("still on the landing page 20 s after the tap");
        const took = (Date.now() - t) / 1000;
        await sleep(1000);
        return `entered in ${took.toFixed(1)} s; HUD "${await hud()}"`;
      },
      { needs: ["landing"] },
    );
    await step(
      "build",
      async () => {
        await act("#btn-build-all");
        const t = Date.now();
        const h = await waitVerdict(150000);
        if (!h) fail("no GO / NO-GO verdict within 150 s of Build all");
        run.buildS = (Date.now() - t) / 1000;
        await sleep(1500);
        return `verdict after ${run.buildS.toFixed(1)} s: "${h}"`;
      },
      { needs: ["enter"] },
    );
    let part = null;
    await step(
      "card",
      async () => {
        part = await openPart();
        if (!part) fail("found no tappable part (hover never showed the pointer cursor)");
        await sleep(1500);
        return `"${part.title}" at ${part.at.join(",")}${part.hasOptions ? " · has Options" : ""}`;
      },
      { needs: ["build"] },
    );
    await step(
      "options",
      async () => {
        if (!part.hasOptions) skip(`no Options on "${part.title}"`);
        await act("#detail .opt-toggle");
        if (!(await page.until(() => page.js(`!document.querySelector("#detail .opt-list")?.hidden`), 2000))) fail("the Options list did not open");
        await sleep(700);
        const n = await page.js(`document.querySelectorAll("#detail .opt-list .opt").length`);
        return `${n} options listed`;
      },
      { needs: ["card"] },
    );
    await step(
      "close",
      async () => {
        const pt = await emptyPoint();
        if (!pt) fail("found no empty canvas spot to tap");
        await actAt(...pt);
        if (!(await page.until(async () => !(await card()).open, 3000, 150))) fail(`the card did not close on a ${cfg.touch ? "tap" : "click"} on empty space at ${pt.join(",")}`);
        await sleep(1500);
        return `closed by a ${cfg.touch ? "tap" : "click"} on empty space at ${pt.join(",")} (the card has no close button)`;
      },
      { needs: ["card"], shot: false },
    );
    await step(
      "explode",
      async () => {
        await act("#btn-explode");
        if (!(await page.until(async () => (await page.rect("#btn-explode"))?.text === "Assemble", 6000))) fail("Explode did not flip to Assemble");
        await sleep(3500);
        return "exploded";
      },
      { needs: ["build"] },
    );
    await step(
      "assemble",
      async () => {
        await act("#btn-explode");
        if (!(await page.until(async () => {
          const b = await page.rect("#btn-explode");
          return b?.text === "Explode" && !b.disabled;
        }, 20000))) fail("Assemble did not finish (no enabled Explode button)");
        await sleep(1000);
        return "assembled";
      },
      { needs: ["explode"], shot: false },
    );
    await step(
      "rockets",
      async () => {
        await act("#btn-rockets");
        if (!(await page.until(() => page.js(`!!document.querySelector("#rockets:not([hidden]) .opt")`), 2000))) fail("the Rockets list did not open");
        await sleep(500);
        const n = await page.js(`document.querySelectorAll("#rockets .opt").length`);
        return `${n} rockets listed`;
      },
      { needs: ["build"] },
    );
    if (run.steps.at(-1).status === "PASS") {
      await act("#btn-rockets").catch(() => {});
      await page.until(() => page.js(`!!document.getElementById("rockets")?.hidden`), 2000);
    }
    await step(
      "compare",
      async () => {
        const onScreen = await page.js(`[...document.querySelectorAll("button, [role=button]")].some((b) => /compare/i.test(b.textContent) && b.getBoundingClientRect().width > 0 && !b.closest(".keys"))`);
        if (!onScreen && cfg.touch) issue("unreachable control", "major", "compare view", "only the C key opens it; a touch device has no way in", "compare");
        await page.press("c");
        if (!(await page.until(() => page.js(`!!document.querySelector("#rockets:not([hidden]) .opt")`), 2000))) fail("C did not open the compare chooser");
        await sleep(300);
        await act((await page.rect("#rockets .opt[data-twin]"))?.shown ? "#rockets .opt[data-twin]" : "#rockets .opt");
        await sleep(3000);
        return `compare view${onScreen ? "" : " (opened with the C key)"}: HUD "${(await hud()).slice(0, 90)}"`;
      },
      { needs: ["build"] },
    );
    if (run.steps.at(-1).status === "PASS") {
      await page.press("c");
      await sleep(2000);
    }
    await step(
      "liftoff",
      async () => {
        if (!(await launchButtonReady())) fail(`not ready to launch (button "${(await page.rect("#btn-build-all"))?.text}")`);
        await act("#btn-build-all");
        if (!(await page.until(async () => /T\+/.test(await hud()), 30000, 200))) fail(`no T+ in the HUD within 30 s of Launch (HUD "${await hud()}")`);
        await sleep(1500);
        return `HUD "${await hud()}"`;
      },
      { needs: ["build"] },
    );
    await step(
      "flight",
      async () => {
        await sleep(9000);
        return `HUD "${await hud()}"`;
      },
      { needs: ["liftoff"] },
    );
    await step(
      "ending",
      async () => {
        const h = await page.until(async () => (ENDING.test(await hud()) ? await hud() : null), 60000, 400);
        if (!h) fail(`no outcome line in the HUD within 60 s (HUD "${await hud()}")`);
        await sleep(1500);
        return `HUD "${h}"`;
      },
      { needs: ["liftoff"] },
    );
  } else {
    // ---------- keyboard only ----------
    const active = () => page.js(`(() => { const a = document.activeElement; if (!a || a === document.body) return null;
      const cs = getComputedStyle(a);
      return { desc: window.__qaDesc(a), id: a.id, shown: window.__qaShown(a), sel: a.matches?.(":focus-visible") ?? false,
        style: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor].join("|") }; })()`);
    // Unfocused look of every control, to tell whether focus changes anything visible.
    const baseLook = () =>
      page.js(`(() => { const m = {}; for (const el of document.querySelectorAll("button, a[href], [tabindex]")) { if (el === document.activeElement) continue; const cs = getComputedStyle(el);
        m[window.__qaDesc(el)] = [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor].join("|"); } return m; })()`);
    let look = {};
    const ringless = new Set();
    const hiddenStops = new Set();
    function checkRing(a, stepName) {
      if (a && !a.shown && !hiddenStops.has(a.desc)) {
        hiddenStops.add(a.desc);
        issue("keyboard gap", "major", a.desc, "Tab stops on this control while it is not visible", stepName);
      }
      if (!a || !a.shown || ringless.has(a.desc)) return;
      const before = look[a.desc];
      const [os, ow] = a.style.split("|");
      const ring = (os !== "none" && parseFloat(ow) > 0) || (before != null && before !== a.style);
      if (!ring) {
        ringless.add(a.desc);
        issue("no focus indicator", "major", a.desc, "focused with Tab, nothing visible changes (no outline, shadow, border or background change)", stepName);
      }
    }
    // Tab until `selector` has focus; returns the number of presses or null after `max`.
    async function tabTo(selector, stepName, max = 30) {
      for (let i = 0; i <= max; i++) {
        const hit = await page.js(`!!document.activeElement?.matches?.(${JSON.stringify(selector)})`);
        if (hit) {
          checkRing(await active(), stepName);
          return i;
        }
        Object.assign(look, await baseLook());
        if (i) checkRing(await active(), stepName);
        await page.press("Tab");
        await sleep(60);
      }
      return null;
    }
    await step("landing", async () => {
      await nav("./");
      if (!(await page.until(() => page.js(`!!document.querySelector(".landing .landing-go")`), 20000))) fail("landing page did not appear");
      await loadStall();
      await sleep(1200);
      look = await baseLook();
      const k = await tabTo(".landing .landing-go", "landing", 10);
      if (k == null) fail("Tab never reached the landing button");
      return `landing button focused after ${k} Tab(s)`;
    });
    await step(
      "enter",
      async () => {
        await page.press("Enter");
        if (!(await page.until(() => page.js(`!document.querySelector(".landing") && !document.body.classList.contains("landing")`), 20000, 200))) fail("Enter on the landing button did not enter");
        await sleep(1000);
        return `entered; focus on ${(await active())?.desc ?? "body"}`;
      },
      { needs: ["landing"], shot: false },
    );
    await step(
      "tab-order",
      async () => {
        look = await baseLook();
        const order = [];
        for (let i = 0; i < 30; i++) {
          Object.assign(look, await baseLook());
          await page.press("Tab");
          await sleep(60);
          const a = await active();
          if (a && order.length && a.desc === order[0]) break;
          if (a) {
            checkRing(a, "tab-order");
            order.push(a.desc);
          } else order.push("(body / nothing)");
        }
        const wanted = await page.js(`[...document.querySelectorAll("footer.bar button, header button, #detail button, .hud button")].filter((b) => !b.disabled && b.getBoundingClientRect().width > 0 && !b.closest("[hidden]")).map((b) => window.__qaDesc(b))`);
        for (const w of wanted) if (!order.includes(w)) issue("unreachable control", "major", w, "not reachable with Tab", "tab-order");
        run.notes.push(`Tab order after entering: ${order.join(" → ")}`);
        return `${order.length} stops: ${order.slice(0, 8).join(" → ")}${order.length > 8 ? " …" : ""}`;
      },
      { needs: ["enter"] },
    );
    await step(
      "build",
      async () => {
        if ((await tabTo("#btn-build-all", "build")) == null) fail("Tab never reached Build all");
        await page.press("Enter");
        const t = Date.now();
        const h = await waitVerdict(150000);
        if (!h) fail("no verdict within 150 s of Enter on Build all");
        run.buildS = (Date.now() - t) / 1000;
        await sleep(1500);
        return `verdict after ${run.buildS.toFixed(1)} s: "${h}"`;
      },
      { needs: ["enter"] },
    );
    await step(
      "part-card",
      async () => {
        const way = await page.js(`(() => { const c = document.getElementById("scene"); const parts = document.querySelectorAll("[data-part], .parts button, [aria-label*='part' i][tabindex]");
          return { canvasFocusable: c ? c.tabIndex >= 0 : false, partControls: parts.length }; })()`);
        if (!way.canvasFocusable && !way.partControls) {
          issue("keyboard gap", "major", "part cards and Options", "no keyboard path: the canvas is not focusable and no control opens a part's card (keys 1–9 build/remove parts only)", "part-card");
          return "no keyboard path to a part card (reported)";
        }
        return `canvas focusable: ${way.canvasFocusable}, part controls: ${way.partControls}`;
      },
      { needs: ["build"], shot: false, probe: false },
    );
    await step(
      "explode",
      async () => {
        if ((await tabTo("#btn-explode", "explode")) == null) fail("Tab never reached Explode");
        await page.press("Enter");
        if (!(await page.until(async () => (await page.rect("#btn-explode"))?.text === "Assemble", 6000))) fail("Enter on Explode did not explode");
        await sleep(3000);
        const shot = join(dir, `${String(++n).padStart(2, "0")}-exploded.png`);
        await page.shot(shot);
        if ((await tabTo("#btn-explode", "explode")) == null) fail("focus left Explode and Tab never came back");
        await page.press("Enter");
        if (!(await page.until(async () => {
          const b = await page.rect("#btn-explode");
          return b?.text === "Explode" && !b.disabled;
        }, 20000))) fail("Enter on Assemble did not assemble");
        await sleep(800);
        return "Enter explodes and assembles";
      },
      { needs: ["build"], shot: false },
    );
    await step(
      "space",
      async () => {
        if ((await tabTo("#btn-rockets", "space")) == null) fail("Tab never reached Rockets");
        await page.press(" ");
        await sleep(700);
        const st = await page.js(`({ list: !document.getElementById("rockets")?.hidden, exploded: document.getElementById("btn-explode")?.textContent.trim() === "Assemble", focus: window.__qaDesc(document.activeElement) })`);
        let out = `Space on the focused Rockets button: list ${st.list ? "opened" : "did not open"}${st.exploded ? ", the rocket exploded" : ""}, focus now ${st.focus}`;
        if (!st.list) issue("keyboard gap", "major", 'button#btn-rockets "Rockets"', `Space does not press a focused button${st.exploded ? " (it explodes the rocket instead and drops focus)" : ""}; Enter works`, "space");
        if (st.exploded) {
          // Put it back together (Space again once the explode has finished; else Tab to Assemble and Enter).
          const assembled = async () => {
            const b = await page.rect("#btn-explode");
            return b?.text === "Explode" && !b.disabled;
          };
          await page.until(async () => !(await page.rect("#btn-explode"))?.disabled, 8000);
          await sleep(1500);
          await page.press(" ");
          if (!(await page.until(assembled, 12000))) {
            if ((await tabTo("#btn-explode", "space")) != null) await page.press("Enter");
            if (!(await page.until(assembled, 15000))) fail("could not assemble the rocket again after the Space test");
          }
          await sleep(800);
        }
        if (st.list) await page.press("Escape");
        return out;
      },
      { needs: ["build"], shot: false },
    );
    await step(
      "rockets",
      async () => {
        if ((await tabTo("#btn-rockets", "rockets")) == null) fail("Tab never reached Rockets");
        await page.press("Enter");
        if (!(await page.until(() => page.js(`!!document.querySelector("#rockets:not([hidden]) .opt")`), 2000))) fail("Enter on Rockets did not open the list");
        const k = await tabTo("#rockets .opt", "rockets", 5);
        if (k == null) issue("keyboard gap", "major", "#rockets list", "Tab from the Rockets button does not move into the open list", "rockets");
        await sleep(400);
        const shot = join(dir, `${String(++n).padStart(2, "0")}-rockets-list.png`);
        await page.shot(shot);
        await page.press("Escape");
        await sleep(300);
        const st = await page.js(`({ hidden: !!document.getElementById("rockets")?.hidden, focus: window.__qaDesc(document.activeElement) })`);
        if (!st.hidden) fail("Esc did not close the Rockets list");
        if (!/btn-rockets/.test(st.focus)) issue("keyboard gap", "minor", "#rockets list", `after Esc closes the list, focus is on ${st.focus}, not back on the Rockets button`, "rockets");
        return `list reached with ${k ?? "no"} Tab(s); Esc closes it; focus then on ${st.focus}`;
      },
      { needs: ["build"], shot: false },
    );
    await step(
      "compare",
      async () => {
        await page.press("c");
        if (!(await page.until(() => page.js(`!!document.querySelector("#rockets:not([hidden]) .opt")`), 2000))) fail("C did not open the compare chooser");
        const k = await tabTo("#rockets .opt", "compare", 30);
        if (k == null) fail("Tab never reached an entry of the compare chooser");
        await page.press("Enter");
        await sleep(3000);
        const h = await hud();
        if (!/\bvs\b/.test(h)) fail(`Enter on the first entry did not show a comparison (HUD "${h}")`);
        return `entry reached after ${k} Tab(s); HUD "${h.slice(0, 80)}"`;
      },
      { needs: ["build"] },
    );
    if (run.steps.at(-1).status === "PASS") {
      await page.press("Escape");
      await sleep(2000);
    }
    await step(
      "launch",
      async () => {
        if (!(await launchButtonReady())) fail("Launch button not ready");
        if ((await tabTo("#btn-build-all", "launch")) == null) fail("Tab never reached Launch");
        await page.press("Enter");
        if (!(await page.until(async () => /T\+/.test(await hud()), 30000, 200))) fail(`no T+ in the HUD within 30 s of Enter on Launch (HUD "${await hud()}")`);
        await sleep(3000);
        return `HUD "${await hud()}"`;
      },
      { needs: ["build"] },
    );
  }
  // Console errors and exceptions, once per distinct text.
  const seenErr = new Set();
  for (const l of page.consoleLog) {
    if (l.level === "warning" || seenErr.has(l.text)) continue;
    seenErr.add(l.text);
    issue("console error", "major", l.level, l.text, `@${l.t}s`);
  }
  // Frames over 50 ms, per step: major when over 10 % of the step's frames or one freeze of 250 ms or more.
  for (const s of run.steps) {
    const f = s.frames;
    if (!f?.n || !f.over50) continue;
    const share = f.over50 / f.n;
    issue("slow frames", share > 0.1 || f.worst >= 250 ? "major" : "minor", `step "${s.name}"`, `${f.over50} of ${f.n} frames over 50 ms (${(share * 100).toFixed(0)} %), worst ${f.worst} ms, ${f.fps.toFixed(0)} fps`, s.name);
  }
  if (run.load?.over50) issue("slow frames", "minor", "page load", `${run.load.over50} frame(s) over 50 ms before the landing settles, worst ${run.load.worst} ms (shader warm-up and first uploads)`, "landing");
  for (const s of run.steps) if (s.status === "FAIL") issue("flow broken", "major", `step "${s.name}"`, s.detail, s.name);
  run.hiddenRestores = page.hiddenRestores;
  await page.close();
  return run;
}

// ---------- report ----------
function writeReport(runs) {
  const rel = (p) => (p ? relative(outDir, p) : "");
  const md = [];
  let tree = "";
  try {
    tree = execSync("git log -1 --format='%h %s'", { cwd: repo, encoding: "utf8" }).trim().slice(0, 90);
    const dirty = execSync("git status --porcelain -- src index.html", { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    if (dirty) tree += ` + ${dirty} uncommitted change(s) under src/`;
  } catch {}
  md.push(`# Mobile / keyboard QA`, "");
  md.push(`Run ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${flags.serve ? "frozen snapshot of the working tree (--serve)" : base} · ${tree} · ${runs[0]?.chrome ?? ""} (headless, ${flags.angle ?? "metal"})`, "");
  md.push(`Generated by \`node scripts/qa/mobile-qa.mjs\`. Frame times are real and depend on the machine's load; read them relative to each other.`, "");
  md.push(`## Summary`, "");
  md.push(`| Config | Steps | Major | Minor | Console errors | Frames over 50 ms | Worst frame |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const r of runs) {
    const pass = r.steps.filter((s) => s.status === "PASS").length;
    const fr = r.steps.map((s) => s.frames).filter(Boolean);
    const total = fr.reduce((a, f) => a + f.n, 0);
    const over = fr.reduce((a, f) => a + f.over50, 0);
    const worst = Math.max(0, ...fr.map((f) => f.worst));
    const groups = group(r.issues);
    md.push(
      `| ${r.cfg.label} | ${pass}/${r.steps.length} passed | ${groups.filter((g) => g.severity === "major").length} | ${groups.filter((g) => g.severity === "minor").length} | ${r.issues.filter((i) => i.category === "console error").length} | ${over} of ${total} | ${worst} ms |`,
    );
  }
  const b = Object.fromEntries(runs.filter((r) => r.buildS).map((r) => [r.name, r.buildS]));
  if (b["reduced-motion"] && b.keyboard) md.push("", `Build all to verdict at 1600×900: ${b.keyboard.toFixed(1)} s normally (keyboard run), ${b["reduced-motion"].toFixed(1)} s with reduced motion.`);
  md.push("", `## Issues`, "");
  md.push(`Grouped by config; one line per distinct problem, with the steps where it was seen and the first screenshot.`, "");
  for (const r of runs) {
    const groups = group(r.issues);
    md.push(`### ${r.cfg.label} (\`${r.name}\`)`, "");
    if (!groups.length) {
      md.push("No issues found.", "");
      continue;
    }
    for (const sev of ["major", "minor"]) {
      const list = groups.filter((g) => g.severity === sev);
      if (!list.length) continue;
      md.push(`**${sev === "major" ? "Major" : "Minor"}**`, "");
      for (const g of list) {
        const where = g.steps.length ? ` · steps: ${g.steps.join(", ")}` : "";
        const shot = g.shot ? ` · [shot](${rel(g.shot)})` : "";
        md.push(`- **${g.category}**: \`${g.what.replace(/`/g, "'")}\` ${g.detail}${where}${shot}`);
      }
      md.push("");
    }
  }
  md.push(`## Steps`, "");
  for (const r of runs) {
    md.push(`### ${r.cfg.label}`, "");
    md.push(`| Step | Result | Time | Frames | Over 50 ms | Worst | Detail |`);
    md.push(`|---|---|---|---|---|---|---|`);
    for (const s of r.steps) {
      const f = s.frames;
      const shot = s.shot ? ` [shot](${rel(s.shot)})` : "";
      md.push(`| ${s.name} | ${s.status} | ${s.s.toFixed(1)} s | ${f?.n ?? ""} | ${f?.over50 ?? ""} | ${f ? f.worst + " ms" : ""} | ${s.detail.replace(/\|/g, "\\|").slice(0, 220)}${shot} |`);
    }
    for (const n of r.notes) md.push("", n);
    if (r.hiddenRestores) md.push("", `Headless quirk: the page was un-hidden ${r.hiddenRestores}× after a key press (Page.bringToFront); not a demo bug.`);
    md.push("");
  }
  const file = join(outDir, "report.md");
  writeFileSync(file, md.join("\n") + "\n");
  console.log(`\nreport ${file}`);
  for (const r of runs) {
    const groups = group(r.issues);
    console.log(`  ${r.name.padEnd(15)} ${r.steps.filter((s) => s.status === "PASS").length}/${r.steps.length} steps · ${groups.filter((g) => g.severity === "major").length} major, ${groups.filter((g) => g.severity === "minor").length} minor`);
  }
}
// Same category + element + detail -> one entry listing its steps.
function group(issues) {
  const m = new Map();
  for (const i of issues) {
    const k = `${i.category}|${i.what}|${i.detail}`;
    if (!m.has(k)) m.set(k, { ...i, steps: [] });
    const g = m.get(k);
    if (i.step && !g.steps.includes(i.step)) g.steps.push(i.step);
    g.shot ??= i.shot;
  }
  const order = ["flow broken", "console error", "hidden information", "unreachable control", "keyboard gap", "no focus indicator", "overlap", "clipped text", "sideways scroll", "slow frames", "small touch target", "truncated text", "tiny text", "motion under reduced motion", "harness"];
  return [...m.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1) || order.indexOf(a.category) - order.indexOf(b.category));
}
