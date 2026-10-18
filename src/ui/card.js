// Detail card for one selected part. Fixed left on desktop, bottom sheet on narrow screens (style.css).
//   createCard(rootEl, { onOption }?) -> { show(part, ctx), refresh(ctx), hide(), el, part }
// The card's only control is "Options": it expands the slot's alternatives (dataset records) inside the card.
// Esc / a click on empty space close it (select.js).
// Every number is a dataset record field or a physics.js result; computed values carry a "derived" tag and
// estimates (full-throttle burn time) an "est." tag. Stage physics (Δv, mass ratio, burn, TWR, warnings) only
// shows once the whole preset is built: a stage's Δv depends on everything above it (design round 4).
import { RULES } from "../physics.js";
import * as f from "./format.js";

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

function stageFooter(d, { withTwr }) {
  const bits = [`Stage ${d.stageIndex + 1}`, `Δv ${f.ms(d.deltaV_ms)} ${DERIVED}`];
  bits.push(Number.isFinite(d.burnTime_s) && d.burnTime_s > 0 ? `burn ${f.s(d.burnTime_s)} ${EST}` : "burn –");
  if (withTwr && Number.isFinite(d.twr)) bits.push(`TWR ${f.twr(d.twr)} ${DERIVED}`);
  const warn = (d.warnings ?? []).map((w) => `<li>${f.esc(w)}</li>`).join("");
  return `<div class="stage"><p>${bits.map(nw).join(" · ")}</p>${warn ? `<ul class="warn">${warn}</ul>` : ""}</div>`;
}

function engineCard(part, ctx) {
  const e = part.record;
  const n = part.count ?? 1;
  const d = ctx.stage;
  const vacOnly = !(e.thrustSL_kN > 0 && e.ispSL_s > 0);
  const len = ctx.catalog?.visuals?.engines?.[e.id];
  const rows = [
    row("Propellant", f.esc(e.propellant)),
    row("Thrust SL", vacOnly ? "vacuum only" : each(f.kN(e.thrustSL_kN), f.kN(n * e.thrustSL_kN))),
    row("Thrust vac", each(f.kN(e.thrustVac_kN), f.kN(n * e.thrustVac_kN))),
    row("Isp", `${nw(`${vacOnly ? "–" : f.s(e.ispSL_s)} SL`)} · ${nw(`${f.s(e.ispVac_s)} vac`)}`),
    row("Mass", n > 1 ? each(f.mass(e.mass_kg), f.mass(n * e.mass_kg)) : f.mass(e.mass_kg)),
    row("Exit diameter", f.len(e.diameter_m)),
  ];
  if (len?.length_m) rows.push(row("Length", f.len(len.length_m)));
  if (d && Number.isFinite(d.fitMaxEngines)) {
    const over = n > d.fitMaxEngines;
    rows.push(
      row(
        "Fit rule",
        over
          ? `<span class="bad">${d.fitMaxEngines} fit (real vehicle flew ${n})</span>`
          : `up to ${d.fitMaxEngines} on this tank`,
        '<span class="tag">app rule</span>',
      ),
    );
  }
  const sources = [sourceLink(e.source), sourceLink(ctx.countSource, "count"), len ? sourceLink(len.source, "length") : ""];
  return {
    eyebrow: `Stage ${part.stageIndex + 1} · ${KIND_LABEL.engines}`,
    title: e.name,
    sub: `${n} × ${e.name}`,
    body: `<dl>${rows.join("")}</dl>${ctx.complete && d ? stageFooter(d, { withTwr: part.stageIndex === 0 }) : ""}`,
    sources,
  };
}

function tankCard(part, ctx) {
  const k = part.record;
  const d = ctx.stage;
  const rule = RULES?.DRY_MASS_MIN_FRACTION ?? 0.04;
  const frac = d?.dryFraction ?? k.dryMass_kg / k.propellantMass_kg;
  const rows = [
    row("Propellant", f.esc(k.propellant)),
    row("Propellant mass", f.t(k.propellantMass_kg)),
    row("Dry mass", f.t(k.dryMass_kg)),
    row("Dry fraction", `<span class="${frac < rule ? "bad" : ""}">${f.pct(frac)}</span> (app rule ≥ ${f.num(rule * 100, 0)}\u00a0%)`, DERIVED),
    row("Size", f.dims(k.diameter_m, k.height_m)),
  ];
  if (ctx.complete && d) {
    rows.push(row("Mass ratio", f.num(d.massRatio, 2), DERIVED));
    rows.push(row("Stage Δv", f.ms(d.deltaV_ms), DERIVED));
  }
  return {
    eyebrow: `Stage ${part.stageIndex + 1} · ${KIND_LABEL.tank}`,
    title: k.name,
    sub: part.sub ?? "",
    body: `<dl>${rows.join("")}</dl>${ctx.complete && d?.warnings?.length ? `<div class="stage"><ul class="warn">${d.warnings.map((w) => `<li>${f.esc(w)}</li>`).join("")}</ul></div>` : ""}`,
    sources: [sourceLink(k.source)],
  };
}

function payloadCard(part, ctx) {
  const p = part.record;
  const mission = ctx.mission;
  const rows = [row("Mass", f.mass(p.mass_kg)), row("Size", f.dims(p.diameter_m, p.height_m))];
  if (ctx.fairing) rows.push(row("Fairing", `inside ${f.dims(ctx.fairing.diameter_m, ctx.fairing.height_m, { derived: true })}`, DERIVED));
  if (mission) {
    rows.push(row("Mission", f.esc(mission.name)));
    rows.push(row("Required Δv", f.ms(mission.requiredDeltaV_ms)));
  }
  return {
    eyebrow: KIND_LABEL.payload,
    title: p.name,
    sub: mission?.destination ?? "",
    body: `<dl>${rows.join("")}</dl>`,
    sources: [sourceLink(p.source), mission ? sourceLink(mission.source, "Δv") : ""],
  };
}

function structureCard(part) {
  const fallback =
    part.kind === "interstage" ? "Mass included in the stage dry mass." : "Mass not modelled (not in the dataset).";
  const rows = [row("Size", f.dims(part.diameter_m, part.height_m, { derived: true }), DERIVED)];
  return {
    eyebrow: `Derived structure · ${KIND_LABEL[part.kind] ?? part.kind}`,
    title: part.name,
    sub: part.sub ?? "",
    body: `<dl>${rows.join("")}</dl><p class="note">${f.esc(part.note || fallback)}</p>`,
    sources: [],
  };
}

function render(part, ctx) {
  if (part.kind === "engines" && part.record) return engineCard(part, ctx);
  if (part.kind === "tank" && part.record) return tankCard(part, ctx);
  if (part.kind === "payload" && part.record) return payloadCard(part, ctx);
  return structureCard(part);
}

// The one key number per alternative (design round 9): thrust for engines (sea level, or vacuum for
// vacuum-only engines), propellant mass for tanks, mass for payloads. Straight from the record.
function optionMeta(kind, r) {
  if (kind === "engines") return r.thrustSL_kN > 0 && r.ispSL_s > 0 ? `${f.kN(r.thrustSL_kN)} SL` : `${f.kN(r.thrustVac_kN)} vac`;
  if (kind === "tank") return `${f.t(r.propellantMass_kg)} propellant`;
  if (kind === "payload") return f.mass(r.mass_kg);
  return "";
}

function optionsHtml(part, options, { expanded, disabled }) {
  if (!part.record || !options || options.length < 2) return "";
  const items = options
    .map((r) => {
      const cur = r.id === part.record.id;
      const meta = f.esc(optionMeta(part.kind, r));
      return `<li><button type="button" class="opt" data-id="${f.esc(r.id)}"${cur ? ' aria-current="true"' : ""}${disabled ? " disabled" : ""}><span class="opt-name">${f.esc(r.name)}</span><span class="opt-meta">${meta}</span></button></li>`;
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

  el.addEventListener("click", (e) => {
    const opt = e.target.closest(".opt");
    if (opt && !opt.disabled && current) {
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
    const c = render(part, {
      catalog,
      verdict,
      complete,
      stage: stageIndex != null ? details?.find((d) => d.stageIndex === stageIndex) ?? details?.[stageIndex] : null,
      // The preset's engine-count citation only applies while the slot still holds the preset's engine.
      countSource: stageIndex != null && preset?.stages?.[stageIndex]?.engineId === part.record?.id ? preset.stages[stageIndex].source : null,
      mission: build?.missionId ? catalog?.missions?.find((m) => m.id === build.missionId) : null,
      fairing: ctx.fairing ?? null,
    });
    const nextKey = `${part.id}|${part.record?.id ?? ""}|${part.count ?? ""}|${complete}|${optionsDisabled}|${verdict?.totalDeltaV_ms ?? ""}`;
    if (part === current && nextKey === key && el.classList.contains("open")) return;
    const swap = current && current.id !== part.id && el.classList.contains("open");
    if (!current || current.id !== part.id) expanded = false;
    const sources = c.sources.filter(Boolean);
    el.innerHTML = `
      <div class="detail-body">
        <p class="eyebrow">${f.esc(c.eyebrow)}</p>
        <h2>${f.esc(c.title)}</h2>
        ${c.sub ? `<p class="sub">${f.esc(c.sub)}</p>` : ""}
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
