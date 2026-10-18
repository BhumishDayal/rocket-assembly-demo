// One-pass audit of every source URL the demo cites: is it reachable, does it redirect to another host, and does
// each quote paired with it still appear on the page? Report only: it never edits data.
// Run: node scripts/audit-sources.mjs [--refresh] [--only <substring>] [--list (print citations, fetch nothing)]
//   (Node 22+, no deps; exits 0 when it ran, whatever it found; 2 on a harness error)
//
// Inputs: src/data/*.json (incl. field-sources.json, hazards.json, engines.pending.json), src/data/STARSHIP-SOURCES.md,
// src/assets/planets/SOURCES.md. How quotes are paired with URLs:
// - "URL (\"quote\")" strings: every "..." / “...” run after a URL and before the next URL belongs to that URL;
// - field-sources.json [url, tier, quote]: quotes in the third element belong to the first, unless an embedded
//   URL precedes them;
// - objects with url + quote / quote2 / auroraQuote / alternative (hazards.json, engines.pending.json); an object with
//   quotes but no url inherits the nearest ancestor's url; xUrl pairs with xQuote (measureUrl / measureQuote);
// - markdown: quotes on a line pair with the last URL before them on that line; "> " blockquote lines pair with the
//   last URL seen above.
// Requests: ONE GET per unique URL (fragment dropped), redirects followed (the final host is compared with the
// original), generic browser User-Agent, no cookies or personal data, 10 s timeout, 2 at a time, web.archive.org
// spaced 1.5 s apart. PDFs and other binary types: reachability only (the body is not read). HTML: tags stripped;
// JS/JSON/text: raw. Quotes match after normalising case, whitespace (removed), quotes, dashes and entities; a quote
// with "..." must match every part. Pages that render in the browser (little text in the HTML) are "unverifiable".
// Cache: scripts/qa/sources-audit.json (per URL result + per quote verdict); a rerun only fetches new URLs unless
// --refresh.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts/qa/sources-audit.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 10000;
const CONCURRENCY = 2;
const SLOW_HOSTS = { "web.archive.org": 1500 };
const JS_HOSTS = new Set(["www.spacex.com", "spacex.com", "x.com", "twitter.com"]);
const MIN_QUOTE = 8; // normalised characters; shorter quoted runs ("Thrust", "86”") are labels, not evidence

const argv = process.argv.slice(2);
const REFRESH = argv.includes("--refresh");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const LIST = argv.includes("--list");

// ---------- extraction ----------
const URL_RE = /https?:\/\/[^\s"'<>\]]+/g;
function cleanUrl(u) {
  // Trailing punctuation, and a closing parenthesis the URL did not open (Wikipedia titles may contain "(...)").
  for (;;) {
    const before = u;
    u = u.replace(/[.,;:!?'"”’]+$/, "");
    if (u.endsWith(")") && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1);
    if (u === before) return u;
  }
}
function urlsIn(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    out.push({ url, start: m.index, end: m.index + url.length });
  }
  return out;
}
const QUOTE_RE = /"([^"]+)"|“([^”]+)”/g;
const quotesIn = (text) => [...text.matchAll(QUOTE_RE)].map((m) => (m[1] ?? m[2]).trim()).filter((q) => norm(q).length >= MIN_QUOTE);

// A source string: each quote belongs to the closest URL before it (or baseUrl when none precedes it).
function fromString(text, baseUrl, where, items) {
  const urls = urlsIn(text);
  const cuts = [{ url: baseUrl, end: 0 }, ...urls];
  for (let i = 0; i < cuts.length; i++) {
    const seg = text.slice(cuts[i].end, i + 1 < cuts.length ? cuts[i + 1].start : text.length);
    const url = cuts[i].url;
    if (!url) continue;
    const qs = quotesIn(seg);
    items.push({ where, url, quotes: qs });
  }
}

const QUOTE_KEY = /^(quote\d*|[a-z]+Quote|alternative)$/;
function walk(node, where, items, inheritedUrl = null) {
  if (typeof node === "string") {
    if (/https?:\/\//.test(node)) fromString(node, null, where, items);
    return;
  }
  if (Array.isArray(node)) {
    // field-sources.json: [url, tier, quote]
    if (node.length >= 3 && typeof node[0] === "string" && typeof node[2] === "string" && /^https?:\/\//.test(node[0])) {
      const base = cleanUrl(urlsIn(node[0])[0]?.url ?? node[0]);
      fromString(node[2], base, where, items);
      return;
    }
    node.forEach((v, i) => walk(v, `${where}[${i}]`, items, inheritedUrl));
    return;
  }
  if (node && typeof node === "object") {
    const own = typeof node.url === "string" && /^https?:\/\//.test(node.url) ? cleanUrl(urlsIn(node.url)[0].url) : null;
    const url = own ?? inheritedUrl;
    const handled = new Set();
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== "string") continue;
      if (QUOTE_KEY.test(k)) {
        handled.add(k);
        const pairKey = k.endsWith("Quote") && k !== "quote" ? `${k.slice(0, -5)}Url` : null;
        const pairUrl = pairKey && typeof node[pairKey] === "string" ? cleanUrl(node[pairKey]) : null;
        if (/https?:\/\//.test(v)) fromString(v, pairUrl ?? url, `${where}.${k}`, items);
        else if (pairUrl ?? url) items.push({ where: `${where}.${k}`, url: pairUrl ?? url, quotes: norm(v).length >= MIN_QUOTE ? [v] : [] });
      } else if (k === "url" || /Url$/.test(k) || k === "pdf") {
        handled.add(k);
        if (/^https?:\/\//.test(v)) items.push({ where: `${where}.${k}`, url: cleanUrl(v), quotes: [] });
      }
    }
    for (const [k, v] of Object.entries(node)) if (!handled.has(k)) walk(v, `${where}.${k}`, items, url);
  }
}

function fromMarkdown(text, file, items) {
  let last = null;
  text.split("\n").forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const urls = urlsIn(line);
    const block = /^\s*>/.test(line);
    if (block && !urls.length && last) {
      items.push({ where, url: last, quotes: quotesIn(line) });
      return;
    }
    fromString(line, block ? last : null, where, items);
    if (urls.length) last = urls.at(-1).url;
  });
}

function collect() {
  const items = [];
  const dataDir = join(ROOT, "src/data");
  for (const f of readdirSync(dataDir).sort()) {
    const p = join(dataDir, f);
    if (f.endsWith(".json")) walk(JSON.parse(readFileSync(p, "utf8")), `src/data/${f}`, items);
    else if (f.endsWith(".md")) fromMarkdown(readFileSync(p, "utf8"), `src/data/${f}`, items);
  }
  fromMarkdown(readFileSync(join(ROOT, "src/assets/planets/SOURCES.md"), "utf8"), "src/assets/planets/SOURCES.md", items);
  return items;
}

// ---------- matching ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", times: "×", deg: "°", minus: "−", plusmn: "±", micro: "µ", sup2: "²", sup3: "³", middot: "·", shy: "" };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
function norm(s) {
  return decode(String(s))
    .normalize("NFKC")
    .replace(/[­​-‍﻿]/g, "")
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[‘’‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/…/g, "...")
    .toLowerCase()
    .replace(/\s+/g, "");
}
const htmlText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
function quoteFound(quote, pageNorm) {
  const parts = norm(quote)
    .split(/\.\.\.+/)
    .map((p) => p.replace(/^[\s"'(]+|[\s"')]+$/g, ""))
    .filter((p) => p.length >= MIN_QUOTE);
  if (!parts.length) return null;
  return parts.every((p) => pageNorm.includes(p));
}

// ---------- fetching ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHit = {};
async function fetchOne(url) {
  const host = new URL(url).host;
  const gap = SLOW_HOSTS[host];
  if (gap) {
    const wait = (lastHit[host] ?? 0) + gap - Date.now();
    lastHit[host] = Date.now() + Math.max(0, wait);
    if (wait > 0) await sleep(wait);
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8", "Accept-Language": "en" }, redirect: "follow", signal: ctrl.signal });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const finalUrl = res.url || url;
    const r = { status: res.status, ok: res.ok, finalUrl, finalHost: new URL(finalUrl).host, contentType: type.split(";")[0], ms: 0 };
    const binary = /pdf|image|octet-stream|zip|video|audio|font/.test(type) || /\.pdf($|[?#])/i.test(finalUrl);
    if (binary || !res.ok) {
      ctrl.abort(); // reachability only: do not read the body
      r.kind = binary ? (type.includes("pdf") || /\.pdf/i.test(finalUrl) ? "pdf" : "binary") : "error";
    } else {
      const body = await res.text();
      const isHtml = type.includes("html");
      const text = isHtml ? htmlText(body) : body;
      r.kind = isHtml ? "html" : "text";
      r.textChars = text.replace(/\s+/g, " ").trim().length;
      r.jsRendered = isHtml && (JS_HOSTS.has(r.finalHost) || r.textChars < 1500);
      r._page = norm(text);
    }
    r.ms = Date.now() - t0;
    return r;
  } catch (e) {
    return { status: 0, ok: false, error: e.name === "AbortError" ? "timeout (10 s)" : `${e.name}: ${e.cause?.code ?? e.message}`, ms: Date.now() - t0, kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- run ----------
const strip = (u) => u.replace(/#.*$/, "");
const hostOf = (u) => new URL(u).host.replace(/^www\./, "");
async function main() {
  const items = collect().filter((it) => !ONLY || it.url.includes(ONLY));
  const unique = [...new Set(items.map((it) => strip(it.url)))];
  if (LIST) {
    for (const it of items) console.log(`${it.where}\t${it.url}\t${it.quotes.length} quote(s)${it.quotes.map((q) => `\n    "${q.slice(0, 100)}"`).join("")}`);
    console.log(`${items.length} citations, ${unique.length} unique URLs, ${items.reduce((n, it) => n + it.quotes.length, 0)} quotes`);
    return;
  }
  let cache = { results: {}, quotes: {} };
  try {
    cache = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {}
  const todo = unique.filter((u) => REFRESH || !cache.results[u]);
  console.log(`${items.length} citations, ${unique.length} unique URLs, ${todo.length} to fetch (2 at a time, 10 s timeout)`);
  const pages = {};
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < todo.length) {
      const u = todo[next++];
      const r = await fetchOne(u);
      pages[u] = r._page ?? null;
      delete r._page;
      r.checkedAt = new Date().toISOString();
      cache.results[u] = r;
      done++;
      if (done % 10 === 0 || done === todo.length) process.stdout.write(`  fetched ${done}/${todo.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Quote verdicts: freshly fetched pages are checked; cached URLs keep their earlier verdicts.
  const quoteRows = [];
  for (const it of items) {
    const u = strip(it.url);
    const r = cache.results[u];
    for (const q of it.quotes) {
      const key = `${u}\u0000${norm(q)}`;
      let verdict;
      if (pages[u] !== undefined) {
        if (!r.ok) verdict = "unreachable";
        else if (r.kind === "pdf" || r.kind === "binary") verdict = "pdf (reachability only)";
        else {
          const found = quoteFound(q, pages[u] ?? "");
          verdict = found === null ? "too short to check" : found ? "found" : r.jsRendered ? "unverifiable (page renders in the browser)" : "missing";
        }
        cache.quotes[key] = verdict;
      } else verdict = cache.quotes[key] ?? "unchecked (cached page; rerun with --refresh)";
      quoteRows.push({ where: it.where, url: it.url, quote: q, verdict });
    }
  }

  // Report.
  const where = (u) => [...new Set(items.filter((it) => strip(it.url) === u).map((it) => it.where.split(/[.[:]/)[0].replace(/^src\//, "")))].join(", ");
  const unreachable = unique.filter((u) => !cache.results[u]?.ok);
  const moved = unique.filter((u) => cache.results[u]?.ok && cache.results[u].finalHost && hostOf(cache.results[u].finalUrl) !== hostOf(u));
  const missing = quoteRows.filter((q) => q.verdict === "missing");
  const unverifiable = quoteRows.filter((q) => q.verdict.startsWith("unverifiable"));
  const count = (v) => quoteRows.filter((q) => q.verdict === v).length;
  console.log(`\nUNREACHABLE (${unreachable.length})`);
  for (const u of unreachable) {
    const r = cache.results[u];
    console.log(`  ${r.status || "-"} ${r.error ?? ""} ${u}  [${where(u)}]`);
  }
  console.log(`\nREDIRECTED TO ANOTHER HOST (${moved.length})`);
  for (const u of moved) console.log(`  ${u}\n    -> ${cache.results[u].finalUrl}  [${where(u)}]`);
  console.log(`\nQUOTES MISSING FROM THE FETCHED PAGE (${missing.length})`);
  for (const q of missing) console.log(`  ${q.where}\n    ${q.url}\n    "${q.quote.slice(0, 160)}${q.quote.length > 160 ? "…" : ""}"`);
  console.log(`\nquotes: ${quoteRows.length} total · found ${count("found")} · missing ${missing.length} · pdf (reachability only) ${count("pdf (reachability only)")} · unverifiable (browser-rendered) ${unverifiable.length} · on unreachable pages ${count("unreachable")} · too short ${count("too short to check")}`);

  mkdirSync(dirname(OUT), { recursive: true });
  const outQuotes = Object.fromEntries(Object.entries(cache.quotes).sort());
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _about: "Written by scripts/audit-sources.mjs. results: one entry per unique URL (fragment dropped); quotes: verdict per URL + normalised quote; report: the problems of the last run.",
        generatedAt: new Date().toISOString(),
        userAgent: UA,
        results: Object.fromEntries(Object.entries(cache.results).sort()),
        quotes: outQuotes,
        report: {
          unreachable: unreachable.map((u) => ({ url: u, status: cache.results[u].status, error: cache.results[u].error ?? null, in: where(u) })),
          redirectedHost: moved.map((u) => ({ url: u, finalUrl: cache.results[u].finalUrl, in: where(u) })),
          missingQuotes: missing,
          unverifiableQuotes: unverifiable.length,
        },
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`\ncache: ${relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
