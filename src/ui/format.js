// Number formatting for the card and the HUD. Thin-space thousands (narrow no-break space, so a number never
// wraps), 1 decimal for metres and tonnes, 0 for m/s, 2 for TWR. Unit separated by a no-break space.
const THIN = " ";
const NB = " ";

export function num(x, digits = 0) {
  if (!Number.isFinite(x)) return "–";
  const [int, frac] = Math.abs(x).toFixed(digits).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return (x < 0 && Number(x.toFixed(digits)) !== 0 ? "−" : "") + grouped + (frac ? "." + frac : "");
}

// Record values keep their own precision (up to `max` decimals, trailing zeros dropped).
export function rec(x, max = 2) {
  if (!Number.isFinite(x)) return "–";
  const digits = Math.min(max, (String(x).split(".")[1] ?? "").length);
  return num(x, digits);
}

export const m = (x) => `${num(x, 1)}${NB}m`;
export const ms = (x) => `${num(x, 0)}${NB}m/s`;
export const s = (x) => `${num(x, 0)}${NB}s`;
export const twr = (x) => num(x, 2);
export const pct = (x) => `${num(x * 100, 1)}${NB}%`;
export const kN = (x) => `${rec(x, 1)}${NB}kN`;
export const t = (kg) => `${num(kg / 1000, 1)}${NB}t`;
// Masses under 10 t read better in kg at the record's precision (467.2 kg, 8 400 kg); above that in tonnes.
export const mass = (kg) => (Math.abs(kg) < 10000 ? `${rec(kg, 1)}${NB}kg` : t(kg));
// D × H. Record sizes keep the record's precision; derived (computed) sizes are rounded to 2 / 1 decimals.
export const dims = (d_m, h_m, { derived = false } = {}) =>
  derived ? `${num(d_m, 2)}${NB}×${NB}${num(h_m, 1)}${NB}m` : `${rec(d_m, 3)}${NB}×${NB}${rec(h_m, 3)}${NB}m`;
export const len = (x_m) => `${rec(x_m, 3)}${NB}m`;

// Source strings are a URL, a URL followed by quotes, or "derived: ...; <url>". Returns the first URL, its
// hostname (no www.) and whether the value is derived.
export function source(str) {
  if (!str) return null;
  const url = str.match(/https?:\/\/[^\s;)"]+/)?.[0];
  let host = null;
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    host = null;
  }
  // archive.org snapshots: show the archived site, link the snapshot.
  const archived = url?.match(/web\.archive\.org\/web\/[^/]+\/(https?:\/\/[^/]+)/)?.[1];
  if (archived) {
    try {
      host = new URL(archived).hostname.replace(/^www\./, "") + " (archive)";
    } catch {
      /* keep the archive host */
    }
  }
  return { url, host, derived: /^\s*derived/i.test(str) };
}

// A chunk that must not break inside (a line may wrap between chunks).
export const nw = (html) => `<span class="nw">${html}</span>`;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
