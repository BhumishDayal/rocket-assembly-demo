// The page shell, made robust: the demo runs inside a fixed host page (the team app's React AssemblyStage, or
// index.html in dev) whose markup may lag behind the demo. ensureShell() finds every element the demo uses,
// creates whatever is missing in the expected place, rewrites the hint line from KEYS so it always lists the
// current keys, and returns the elements. Nothing else in the demo looks elements up by id.
//   ensureShell() -> { canvas, brand, hint, detail, hud, hudText, bar, btnRockets, rocketsEl, btnBuildAll,
//                      btnExplode, btnReset }
// The site makes no sound: a host page's Sound button (#btn-sound) is removed, never created.

// The hint line under the title: [key(s), what it does]; plain text first.
const LEAD = "Click the ghost to build the next part · click a part for details";
const KEYS = [
  [["Space"], "explode"],
  [["B"], "build all"],
  [["R"], "reset"],
  [["[", "]"], "change rocket"],
  [["L"], "launch"],
  [["S"], "save card"],
  [["C"], "compare"],
  [["P"], "story"],
  [["X"], "opacity"],
];

function make(tag, { id, className, attrs = {}, text } = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (className) el.className = className;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

export function ensureShell() {
  const body = document.body;
  const canvas = document.getElementById("scene") ?? body.insertBefore(make("canvas", { id: "scene", attrs: { "aria-label": "3D rocket assembly" } }), body.firstChild);

  let brand = document.querySelector("header.brand");
  if (!brand) {
    brand = make("header", { className: "brand" });
    brand.append(make("h1", { text: "Rocket assembly" }));
    canvas.after(brand);
  }
  const hint = brand.querySelector("p") ?? brand.appendChild(make("p"));
  hint.replaceChildren(
    LEAD,
    ...KEYS.flatMap(([keys, label]) => [" · ", ...keys.flatMap((k, i) => [i ? " " : "", make("kbd", { text: k })]), ` ${label}`]),
  );

  let detail = document.getElementById("detail");
  if (!detail) {
    detail = make("aside", { id: "detail", className: "detail", attrs: { "aria-live": "polite" } });
    brand.after(detail);
  }

  let hud = document.getElementById("hud");
  if (!hud) {
    hud = make("div", { id: "hud", className: "hud" });
    detail.after(hud);
  }
  const hudText = document.getElementById("hud-text") ?? hud.appendChild(make("span", { id: "hud-text", text: "Pad ready" }));

  let bar = document.querySelector("footer.bar");
  if (!bar) {
    bar = make("footer", { className: "bar" });
    body.appendChild(bar);
  }
  const button = (id, label, className, attrs) => document.getElementById(id) ?? make("button", { id, className, text: label, attrs: { type: "button", ...attrs } });
  const btnBuildAll = button("btn-build-all", "Build all");
  const btnExplode = button("btn-explode", "Explode", undefined, { disabled: "" });
  const btnReset = button("btn-reset", "Reset", "quiet");
  document.getElementById("btn-sound")?.remove();
  for (const b of [btnBuildAll, btnExplode, btnReset]) if (!b.isConnected) bar.appendChild(b);
  const btnRockets = button("btn-rockets", "Rockets", "quiet", { "aria-expanded": "false", "aria-controls": "rockets" });
  if (!btnRockets.isConnected) bar.insertBefore(btnRockets, btnBuildAll);
  let rocketsEl = document.getElementById("rockets");
  if (!rocketsEl) {
    rocketsEl = make("div", { id: "rockets", className: "rockets", attrs: { "aria-label": "Pre-made rockets" } });
    rocketsEl.hidden = true;
    btnRockets.after(rocketsEl);
  }

  return { canvas, brand, hint, detail, hud, hudText, bar, btnRockets, rocketsEl, btnBuildAll, btnExplode, btnReset };
}
