// Image diff evaluated inside headless Chrome (no image library in node): page.js(diffSource()) defines
//   window.__diff(baselinePngBase64, actualPngBase64, heatmapAbove = 0) -> {
//     score     mean absolute difference over R, G, B in % of full scale (0 identical, 100 black vs white);
//     changed   % of pixels whose mean channel difference exceeds 16/255;
//     box       [x0, y0, x1, y1] around those pixels, or null;
//     heatmap   only when score > heatmapAbove: PNG (base64), the actual frame dimmed to grey, each pixel tinted by its difference
//               (dark red small, orange, yellow large, white saturated at 64/255);
//     sizeMismatch, a, b  when the two images differ in size.
//   }
export function diffSource() {
  return `window.__diff = async (a64, b64, heatmapAbove = 0) => {
  const decode = async (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([u8], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  };
  const [A, B] = await Promise.all([decode(a64), decode(b64)]);
  if (A.width !== B.width || A.height !== B.height) return { sizeMismatch: true, a: [A.width, A.height], b: [B.width, B.height] };
  const w = A.width, h = A.height, n = w * h;
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  ctx.drawImage(A, 0, 0);
  const da = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(B, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const db = img.data;
  const o = new Uint8ClampedArray(db.length);
  let sum = 0, changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const d = (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
    sum += d;
    if (d > 16) {
      changed++;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const g = (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]) * 0.3;
    const k = Math.min(1, d / 64);
    const a = d < 2 ? 0 : Math.min(1, 0.35 + k);
    const r = 255 * Math.min(1, 0.5 + 1.5 * k), gg = 255 * Math.max(0, Math.min(1, 2 * k - 0.4)), bb = 255 * Math.max(0, 3 * k - 2);
    o[i] = g + (r - g) * a;
    o[i + 1] = g + (gg - g) * a;
    o[i + 2] = g + (bb - g) * a;
    o[i + 3] = 255;
  }
  const score = (sum / n / 255) * 100;
  const out = { score, changed: (changed / n) * 100, box: x1 >= 0 ? [x0, y0, x1, y1] : null };
  if (!(score > heatmapAbove)) return out;
  ctx.putImageData(new ImageData(o, w, h), 0, 0);
  if (x1 >= 0) {
    ctx.strokeStyle = "rgba(80, 200, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
  }
  const blob = await cv.convertToBlob({ type: "image/png" });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  out.heatmap = btoa(s);
  return out;
};
true;`;
}
