// Detail card for one selected part. Fixed left on desktop, bottom sheet on narrow screens (style.css).
//   createCard(rootEl, { onOption }?) -> { show(part, ctx), refresh(ctx), hide(), el, part }
// The card's only control is "Options": it expands the slot's alternatives (dataset records) inside the card.
// Esc / a click on empty space close it (select.js).
// Every number is a dataset record field or a physics.js result; computed values carry a "derived" tag and
// estimates (full-throttle burn time) an "est." tag. Stage physics (Δv, mass ratio, burn, TWR, warnings) only
// shows once the whole preset is built: a stage's Δv depends on everything above it (design round 4).
// Sourced-number drawer (design G27): every number is clickable and opens a line under it with its evidence:
// the quote + evidence tier + link from data/field-sources.json ([url, tier, quote] per field), or, where the
// file has no entry for the field, the record's own source (its quoted text, the tank note or derivation, and
// the link); derived numbers show their formula with the inputs.
import { RULES } from "../physics.js";
import * as f from "./format.js";

// Optional until it lands: a glob import resolves to {} when the file does not exist yet.
const FIELD_SOURCES = Object.values(import.meta.glob("../data/field-sources.json", { eager: true, import: "default" }))[0] ?? null;
const G0 = "9.80665\u00a0m/s²";

const KIND_LABEL = { engines: "engines", tank: "tank", interstage: "interstage", payload: "payload", fairing: "fairing" };
const DERIVED = '<span class="tag">derived</span>';
const EST = '<span class="tag">est.</span>';

const row = (label, value, tag = "") => `<div><dt>${f.esc(label)}</dt><dd>${value}${tag ? " " + tag : ""}</dd></div>`;
const nw = f.nw;
const each = (v, total) => `${nw(`${v} each`)} · ${nw(`${total} total`)}`;

function sourceLink(str, label) {
  const src = f.source(str);
  if (!src?.url) return src?.derived ? `<span>${f.esc(label ? label + ": " : "")}derived</span>` : "";
  const text = `${src.derived ? "derived · " : ""}${src.host ?? "source"}`;
  return `<span>${label ? f.esc(label) + ": " : ""}<a href="${f.esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${f.esc(str)}">${f.esc(text)}</a></span>`;
}

// Provenance registry for one render: rec() marks a record field, calc() a derived value; both return the
// number wrapped in a clickable, and remember what its drawer shows.
function provenance() {
  const entries = [];
  const wrap = (html, entry) => {
    entries.push(entry);
    return `<button type="button" class="num" data-p="${entries.length - 1}" aria-expanded="false">${html}</button>`;
  };
  return {
    entries,
    // path into field-sources.json, e.g. ["engines", "merlin-1d", "thrustSL_kN"]; source = the record's source string
    rec: (html, path, source) => wrap(html, { path, source }),
    calc: (html, formula, note = "") => wrap(html, { formula, note }),
  };
}

const URL_RE = /https?:\/\/[^\s;)"]+/g;
function drawerHtml(entry) {
  if (entry.formula) {
    return `<span class="drawer-f">${f.esc(entry.formula)}</span>${entry.note ? `<span class="drawer-n">${f.esc(entry.note)}</span>` : ""}`;
  }
  // field-sources.json entries are [url, tier, quote]: the quote is shown as written (verbatim in double
  // quotes, sometimes "-> conversion"), the tier says how strong the evidence is.
  const raw = entry.path?.reduce((o, k) => o?.[k], FIELD_SOURCES);
  if (Array.isArray(raw) && raw[2]) {
    const [url, tier, quote] = raw;
    const host = f.source(url)?.host ?? "source";
    return `<span class="drawer-q">${f.esc(quote)}</span>${tier ? `<span class="drawer-n">evidence: ${f.esc(tier)}</span>` : ""}${url ? `<a href="${f.esc(url)}" target="_blank" rel="noopener noreferrer">${f.esc(host)}</a>` : ""}`;
  }
  // Tanks carry one note per tank (with the dry-mass derivation) instead of per-field quotes.
  const tankRec = entry.path?.[0] === "tanks" ? FIELD_SOURCES?.tanks?.[entry.path[1]] : null;
  const tankNote = tankRec?._note ?? tankRec?.note ?? null;
  // Fallback: the record's source string: its quoted text, any derivation note before the URL, and the link.
  const str = entry.source ?? "";
  const quotes = [...str.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const derivation = /^\s*derived/i.test(str) ? str.split(URL_RE)[0].replace(/[\s;,(]+$/, "") : "";
  const src = f.source(str);
  const parts = [];
  if (quotes.length) parts.push(`<span class="drawer-q">“${f.esc(quotes.join(" … "))}”</span>`);
  if (tankNote) parts.push(`<span class="drawer-n">${f.esc(tankNote)}</span>`);
  else if (derivation) parts.push(`<span class="drawer-n">${f.esc(derivation)}</span>`);
  if (!quotes.length && !derivation && !tankNote) parts.push(`<span class="drawer-n">Record source (no verbatim quote for this field yet)</span>`);
  if (src?.url) parts.push(`<a href="${f.esc(src.url)}" target="_blank" rel="noopener noreferrer">${f.esc(src.host ?? "source")}</a>`);
  return parts.join("");
}

function stageFooter(P, d, { withTwr }) {
  const regime = d.stageIndex === 0 ? "SL" : "vac";
  const bits = [
    `Stage ${d.stageIndex + 1}`,
    `Δv ${P.calc(f.ms(d.deltaV_ms), `Δv = Isp · g0 · ln(m0 / m1) = ${f.s(d.ispUsed_s)} · ${G0} · ln(${f.t(d.startMass_kg)} / ${f.t(d.endMass_kg)})`, `Isp ${regime}; m0 = this stage + everything above it, m1 = m0 − propellant`)} ${DERIVED}`,
  ];
  bits.push(
    Number.isFinite(d.burnTime_s) && d.burnTime_s > 0
      ? `burn ${P.calc(f.s(d.burnTime_s), `t = m_prop · Isp · g0 / F = ${f.t(d.propellantMass_kg)} · ${f.s(d.ispUsed_s)} · ${G0} / ${f.kN(d.thrust_kN)}`, `full throttle, ${regime} thrust and Isp`)} ${EST}`
      : "burn –",
  );
  if (withTwr && Number.isFinite(d.twr)) {
    bits.push(`TWR ${P.calc(f.twr(d.twr), `TWR = F_SL / (m0 · g0) = ${f.kN(d.thrust_kN)} / (${f.t(d.startMass_kg)} · ${G0})`, "liftoff; the app needs ≥ 1.2")} ${DERIVED}`);
  }
  const warn = (d.warnings ?? []).map((w) => `<li>${f.esc(w)}</li>`).join("");
  return `<div class="stage"><p>${bits.map(nw).join(" · ")}</p>${warn ? `<ul class="warn">${warn}</ul>` : ""}</div>`;
}

function engineCard(part, ctx, P) {
  const e = part.record;
  const n = part.count ?? 1;
  const d = ctx.stage;
  const vacOnly = !(e.thrustSL_kN > 0 && e.ispSL_s > 0);
  const len = ctx.catalog?.visuals?.engines?.[e.id];
  const R = (field, html) => P.rec(html, ["engines", e.id, field], e.source);
  const total = (html, sym, one, unit) => P.calc(html, `total = n × ${sym} = ${n} × ${one} = ${unit}`);
  const rows = [
    row("Propellant", f.esc(e.propellant)),
    row("Thrust SL", vacOnly ? "vacuum only" : each(R("thrustSL_kN", f.kN(e.thrustSL_kN)), total(f.kN(n * e.thrustSL_kN), "F_SL", f.kN(e.thrustSL_kN), f.kN(n * e.thrustSL_kN)))),
    row("Thrust vac", each(R("thrustVac_kN", f.kN(e.thrustVac_kN)), total(f.kN(n * e.thrustVac_kN), "F_vac", f.kN(e.thrustVac_kN), f.kN(n * e.thrustVac_kN)))),
    row("Isp", `${nw(`${vacOnly ? "–" : R("ispSL_s", f.s(e.ispSL_s))} SL`)} · ${nw(`${R("ispVac_s", f.s(e.ispVac_s))} vac`)}`),
    row("Mass", n > 1 ? each(R("mass_kg", f.mass(e.mass_kg)), total(f.mass(n * e.mass_kg), "m", f.mass(e.mass_kg), f.mass(n * e.mass_kg))) : R("mass_kg", f.mass(e.mass_kg))),
    row("Exit diameter", R("diameter_m", f.len(e.diameter_m))),
  ];
  if (len?.length_m) rows.push(row("Length", P.rec(f.len(len.length_m), ["visuals", "engines", e.id, "length_m"], len.source)));
  if (d && Number.isFinite(d.fitMaxEngines)) {
    const over = n > d.fitMaxEngines;
    const D = d.tank?.diameter_m;
    const formula = `fit = ⌊0.6 · (D_tank / d_engine)²⌋, 1 to 9${D ? ` = ⌊0.6 · (${f.len(D)} / ${f.len(e.diameter_m)})²⌋` : ""}`;
    const num = P.calc(String(d.fitMaxEngines), formula, "the team app's packing rule");
    rows.push(row("Fit rule", over ? `<span class="bad">${num} fit (real vehicle flew ${n})</span>` : `up to ${num} on this tank`, '<span class="tag">app rule</span>'));
  }
  const countHtml = ctx.countSource
    ? P.rec(String(n), ["presets", ctx.presetId, "stages", part.stageIndex, "engineCount"], ctx.countSource)
    : P.calc(String(n), "count kept from the preset, clamped by the app's fit rule for this engine/tank pair");
  const sources = [sourceLink(e.source), sourceLink(ctx.countSource, "count"), len ? sourceLink(len.source, "length") : ""];
  return {
    eyebrow: `Stage ${part.stageIndex + 1} · ${KIND_LABEL.engines}`,
    title: e.name,
    subHtml: `${countHtml} × ${f.esc(e.name)}`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete && d ? stageFooter(P, d, { withTwr: part.stageIndex === 0 }) : ""}`,
    sources,
  };
}

function tankCard(part, ctx, P) {
  const k = part.record;
  const d = ctx.stage;
  const rule = RULES?.DRY_MASS_MIN_FRACTION ?? 0.04;
  const frac = d?.dryFraction ?? k.dryMass_kg / k.propellantMass_kg;
  const R = (field, html) => P.rec(html, ["tanks", k.id, field], k.source);
  const fracHtml = P.calc(f.pct(frac), `dry / propellant = ${f.t(k.dryMass_kg)} / ${f.t(k.propellantMass_kg)}`, `the app's rule needs ≥ ${f.num(rule * 100, 0)} %`);
  const rows = [
    row("Propellant", f.esc(k.propellant)),
    row("Propellant mass", R("propellantMass_kg", f.t(k.propellantMass_kg))),
    row("Dry mass", R("dryMass_kg", f.t(k.dryMass_kg))),
    row("Dry fraction", `<span class="${frac < rule ? "bad" : ""}">${fracHtml}</span> (app rule ≥ ${f.num(rule * 100, 0)}\u00a0%)`, DERIVED),
    row("Size", `${R("diameter_m", f.rec(k.diameter_m, 3))}\u00a0×\u00a0${R("height_m", f.len(k.height_m))}`),
  ];
  if (ctx.complete && d) {
    rows.push(row("Mass ratio", P.calc(f.num(d.massRatio, 2), `m0 / m1 = ${f.t(d.startMass_kg)} / ${f.t(d.endMass_kg)}`, "m0 = this stage + everything above it at ignition; m1 = m0 − propellant"), DERIVED));
    rows.push(row("Stage Δv", P.calc(f.ms(d.deltaV_ms), `Δv = Isp · g0 · ln(m0 / m1) = ${f.s(d.ispUsed_s)} · ${G0} · ln(${f.num(d.massRatio, 2)})`), DERIVED));
  }
  return {
    eyebrow: `Stage ${part.stageIndex + 1} · ${KIND_LABEL.tank}`,
    title: k.name,
    sub: part.sub ?? "",
    body: `<dl>${rows.join("")}</dl>${ctx.complete && d?.warnings?.length ? `<div class="stage"><ul class="warn">${d.warnings.map((w) => `<li>${f.esc(w)}</li>`).join("")}</ul></div>` : ""}`,
    sources: [sourceLink(k.source)],
  };
}

function payloadCard(part, ctx, P) {
  const p = part.record;
  const mission = ctx.mission;
  const R = (field, html) => P.rec(html, ["payloads", p.id, field], p.source);
  const rows = [row("Mass", R("mass_kg", f.mass(p.mass_kg))), row("Size", `${R("diameter_m", f.rec(p.diameter_m, 3))}\u00a0×\u00a0${R("height_m", f.len(p.height_m))}`)];
  if (ctx.fairing) {
    const fr = ctx.fairing;
    rows.push(row("Fairing", `inside ${P.calc(f.dims(fr.diameter_m, fr.height_m, { derived: true }), "D = max(stage D, 1.2 × payload D); H = adapter + payload H + ogive nose (1.3 × D)", fr.note || "sized by the layout around the payload")}`, DERIVED));
  }
  if (mission) {
    rows.push(row("Mission", f.esc(mission.name)));
    rows.push(row("Required Δv", P.rec(f.ms(mission.requiredDeltaV_ms), ["missions", mission.id, "requiredDeltaV_ms"], mission.source)));
  }
  return {
    eyebrow: KIND_LABEL.payload,
    title: p.name,
    sub: mission?.destination ?? "",
    body: `<dl>${rows.join("")}</dl>`,
    sources: [sourceLink(p.source), mission ? sourceLink(mission.source, "Δv") : ""],
  };
}

function structureCard(part, ctx, P) {
  const fallback =
    part.kind === "interstage" ? "Mass included in the stage dry mass." : "Mass not modelled (not in the dataset).";
  const formula =
    part.kind === "interstage"
      ? "D = the wider of the two stages; H = upper engine length + 0.4 m clearance"
      : "D = max(stage D, 1.2 × payload D); H = adapter + payload H + ogive nose (1.3 × D)";
  const rows = [row("Size", P.calc(f.dims(part.diameter_m, part.height_m, { derived: true }), formula, "layout proportions, not a dataset record"), DERIVED)];
  return {
    eyebrow: `Derived structure · ${KIND_LABEL[part.kind] ?? part.kind}`,
    title: part.name,
    sub: part.sub ?? "",
    body: `<dl>${rows.join("")}</dl><p class="note">${f.esc(part.note || fallback)}</p>`,
    sources: [],
  };
}

function render(part, ctx, P) {
  if (part.kind === "engines" && part.record) return engineCard(part, ctx, P);
  if (part.kind === "tank" && part.record) return tankCard(part, ctx, P);
  if (part.kind === "payload" && part.record) return payloadCard(part, ctx, P);
  return structureCard(part, ctx, P);
}

// The one key number per alternative (design round 9): thrust for engines (sea level, or vacuum for
// vacuum-only engines), propellant mass for tanks, mass for payloads. Straight from the record.
function optionMeta(kind, r) {
  if (kind === "engines") return r.thrustSL_kN > 0 && r.ispSL_s > 0 ? `${f.kN(r.thrustSL_kN)} SL` : `${f.kN(r.thrustVac_kN)} vac`;
  if (kind === "tank") return `${f.t(r.propellantMass_kg)} propellant`;
  if (kind === "payload") return f.mass(r.mass_kg);
  return "";
}

// options: records, or compat entries { record, level: ok | unusual | incompatible, reasons } (compat.js),
// already sorted ok → unusual → incompatible. Unusual rows carry a tag and their reasons; incompatible rows
// are greyed out and cannot be picked; a hairline separates the groups.
function optionsHtml(part, options, { expanded, disabled }) {
  if (!part.record || !options || options.length < 2) return "";
  let prevLevel = null;
  const items = options
    .map((o) => {
      const { record: r, level = "ok", reasons = [] } = o.record ? o : { record: o };
      const cur = r.id === part.record.id;
      const blocked = level === "incompatible";
      const why = reasons.length ? `<span class="opt-why">${f.esc(reasons.join(" · "))}</span>` : "";
      const tag = level === "unusual" ? ' <span class="tag">unusual</span>' : "";
      const first = prevLevel !== null && level !== prevLevel ? ' class="opt-group"' : "";
      prevLevel = level;
      return `<li${first}><button type="button" class="opt opt-${level}" data-id="${f.esc(r.id)}"${cur ? ' aria-current="true"' : ""}${disabled || (blocked && !cur) ? " disabled" : ""}${blocked ? ' aria-disabled="true"' : ""}><span class="opt-name">${f.esc(r.name)}${tag}</span><span class="opt-meta">${f.esc(optionMeta(part.kind, r))}</span>${why}</button></li>`;
    })
    .join("");
  return `<div class="opts${expanded ? " open" : ""}"><button type="button" class="opt-toggle" aria-expanded="${expanded}"${disabled ? " disabled" : ""}>Options</button><ul class="opt-list"${expanded ? "" : " hidden"}>${items}</ul></div>`;
}

// show(part, ctx): ctx = { details, verdict, catalog, complete, preset, build, options?, optionsDisabled? }.
// options: the records this slot can take (catalog.optionsFor); picking one calls onOption(part, recordId).
export function createCard(rootEl, { onOption } = {}) {
  const el = rootEl;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Part details");
  let current = null;
  let key = "";
  let expanded = false;
  let lastCtx = null;
  let prov = [];

  // A number's drawer opens on a line under its row (or under the sub line / stage footer); one per line.
  function toggleDrawer(btn) {
    const i = Number(btn.dataset.p);
    const host = btn.closest(".detail dl > div, .detail .stage, .detail .sub");
    if (!host || !prov[i]) return;
    const inside = host.matches("dl > div, .stage");
    const scope = inside ? host : host.parentElement;
    const open = scope.querySelector(`:scope > .drawer[data-for="${inside ? "" : "sub"}"]`);
    const wasThis = open?.dataset.p === String(i);
    open?.remove();
    for (const b of (inside ? host : host).querySelectorAll('.num[aria-expanded="true"]')) b.setAttribute("aria-expanded", "false");
    if (wasThis) return;
    const d = document.createElement("div");
    d.className = "drawer";
    d.dataset.p = String(i);
    d.dataset.for = inside ? "" : "sub";
    d.innerHTML = drawerHtml(prov[i]);
    if (inside) host.appendChild(d);
    else host.after(d);
    btn.setAttribute("aria-expanded", "true");
    if (!reduced()) d.animate([{ opacity: 0, transform: "translateY(-3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
  }

  el.addEventListener("click", (e) => {
    const num = e.target.closest(".num");
    if (num) {
      toggleDrawer(num);
      return;
    }
    const opt = e.target.closest(".opt");
    if (opt && !opt.disabled && opt.getAttribute("aria-disabled") !== "true" && current) {
      if (opt.getAttribute("aria-current") === "true") return;
      expanded = false;
      onOption?.(current, opt.dataset.id);
      return;
    }
    if (e.target.closest(".opt-toggle") && current) {
      expanded = !expanded;
      const wrap = el.querySelector(".opts");
      wrap.classList.toggle("open", expanded);
      wrap.querySelector(".opt-toggle").setAttribute("aria-expanded", String(expanded));
      const list = wrap.querySelector(".opt-list");
      list.hidden = !expanded;
      if (expanded) {
        list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
        if (!reduced()) list.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
      }
    }
  });

  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function show(part, ctx = {}) {
    const { details, verdict, catalog, complete = false, preset, build, options, optionsDisabled = false } = ctx;
    lastCtx = ctx;
    const stageIndex = part.stageIndex ?? null;
    const P = provenance();
    const c = render(part, {
      catalog,
      verdict,
      complete,
      stage: stageIndex != null ? details?.find((d) => d.stageIndex === stageIndex) ?? details?.[stageIndex] : null,
      // The preset's engine-count citation only applies while the slot still holds the preset's engine.
      countSource: stageIndex != null && preset?.stages?.[stageIndex]?.engineId === part.record?.id ? preset.stages[stageIndex].source : null,
      mission: build?.missionId ? catalog?.missions?.find((m) => m.id === build.missionId) : null,
      fairing: ctx.fairing ?? null,
      presetId: preset?.id,
    }, P);
    const nextKey = `${part.id}|${part.record?.id ?? ""}|${part.count ?? ""}|${complete}|${optionsDisabled}|${verdict?.totalDeltaV_ms ?? ""}`;
    if (part === current && nextKey === key && el.classList.contains("open")) return;
    const swap = current && current.id !== part.id && el.classList.contains("open");
    if (!current || current.id !== part.id) expanded = false;
    const sources = c.sources.filter(Boolean);
    prov = P.entries;
    el.innerHTML = `
      <div class="detail-body">
        <p class="eyebrow">${f.esc(c.eyebrow)}</p>
        <h2>${f.esc(c.title)}</h2>
        ${c.subHtml ? `<p class="sub">${c.subHtml}</p>` : c.sub ? `<p class="sub">${f.esc(c.sub)}</p>` : ""}
        ${c.body}
        ${optionsHtml(part, options, { expanded, disabled: optionsDisabled })}
        ${sources.length ? `<p class="src">${sources.join("")}</p>` : ""}
      </div>`;
    current = part;
    key = nextKey;
    // Force a style flush so the slide-in transition runs from the closed state.
    void el.offsetWidth;
    el.classList.add("open");
    if (swap && !reduced()) {
      el.querySelector(".detail-body").animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
    }
  }

  function hide() {
    current = null;
    key = "";
    expanded = false;
    el.classList.remove("open");
  }

  return {
    show,
    hide,
    // Re-render the open card with fresh context (after a swap or when the stack completes).
    refresh(ctx) {
      if (current) show(current, { ...lastCtx, ...ctx });
    },
    el,
    get part() {
      return current;
    },
  };
}
