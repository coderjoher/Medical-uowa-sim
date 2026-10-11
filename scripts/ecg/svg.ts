/**
 * Renders simulated ECG traces as a standard 12-lead SVG on ECG grid paper:
 * 3 rows × 4 columns (I aVR V1 V4 / II aVL V2 V5 / III aVF V3 V6), 2.5 s per lead,
 * plus a 10 s lead II rhythm strip. 25 mm/s, 10 mm/mV, 1 mV calibration pulse per row.
 *
 * SVG user units are millimetres.
 */
import type { EcgTraces, Lead } from "./model.js";

const MM_PER_S = 25;
const MM_PER_MV = 10;

const LAYOUT: Lead[][] = [
  ["I", "aVR", "V1", "V4"],
  ["II", "aVL", "V2", "V5"],
  ["III", "aVF", "V3", "V6"],
];

export interface EcgSvgOptions {
  /** Header line, e.g. "12-lead ECG". Must not reveal the diagnosis (students interpret it). */
  heading?: string;
  /** Lead for the rhythm strip. */
  rhythmLead?: Lead;
  /** Rendered pixel width (height follows the aspect ratio). */
  pixelWidth?: number;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderEcgSvg(tr: EcgTraces, opts: EcgSvgOptions = {}): string {
  const rhythmLead = opts.rhythmLead ?? "II";
  const header = 14;
  const rowH = 35;
  const rows = 4;
  const gx = 5; // grid left
  const gy = header; // grid top
  const gw = 265; // 53 large squares
  const gh = rows * rowH; // 28 large squares
  const x0 = gx + 10; // trace start (after calibration pulse)
  const W = gx + gw + 5;
  const H = gy + gh + 8;
  const pxW = opts.pixelWidth ?? 1400;
  const pxH = Math.round((pxW * H) / W);
  const colSec = 2.5;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${pxW}" height="${pxH}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<title>${esc(opts.heading ?? "12-lead ECG")} (simulated placeholder)</title>`);
  out.push(`<desc>Procedurally generated ECG placeholder (scripts/generate-assets.ts). Not a patient recording. Replace with a licensed tracing at the same path.</desc>`);
  out.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);

  // ── Grid paper: 1 mm minor lines, 5 mm major lines.
  out.push(`<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="#fff4f2"/>`);
  let minor = "";
  let major = "";
  for (let i = 0; i <= gw; i++) {
    const seg = `M${gx + i} ${gy}v${gh}`;
    if (i % 5 === 0) major += seg;
    else minor += seg;
  }
  for (let j = 0; j <= gh; j++) {
    const seg = `M${gx} ${gy + j}h${gw}`;
    if (j % 5 === 0) major += seg;
    else minor += seg;
  }
  out.push(`<path d="${minor}" stroke="#f6b8b4" stroke-width="0.1" fill="none"/>`);
  out.push(`<path d="${major}" stroke="#e2726b" stroke-width="0.25" fill="none"/>`);

  // ── Header (no diagnosis — students must interpret the tracing).
  out.push(`<text x="${gx}" y="6" font-size="4" font-weight="bold" fill="#222">${esc(opts.heading ?? "12-lead ECG")}</text>`);
  out.push(`<text x="${gx}" y="11.5" font-size="2.8" fill="#444">25 mm/s · 10 mm/mV · 0.05–150 Hz</text>`);
  out.push(`<text x="${gx + gw}" y="6" font-size="3" text-anchor="end" fill="#b00020" font-weight="bold">SIMULATED — PROCEDURAL PLACEHOLDER</text>`);
  out.push(`<text x="${gx + gw}" y="11.5" font-size="2.5" text-anchor="end" fill="#666">Not a patient recording · replace with licensed tracing</text>`);

  const trace: string[] = [];
  const marks: string[] = [];
  const labels: string[] = [];
  const sr = tr.sampleRate;

  // Compact relative path: constant x step, y deltas taken from rounded absolutes (no drift).
  const poly = (sig: Float64Array, tStart: number, tEnd: number, xStart: number, base: number) => {
    const i0 = Math.round(tStart * sr);
    const i1 = Math.min(sig.length - 1, Math.round(tEnd * sr));
    const short = (v: string) => v.replace(/^(-?)0\./, "$1.");
    const dx = short(f(MM_PER_S / sr));
    const yAt = (i: number) => Math.round((base - sig[i]! * MM_PER_MV) * 100);
    let prev = yAt(i0);
    let d = `M${f(xStart)} ${f(prev / 100)}l`;
    for (let i = i0 + 1; i <= i1; i++) {
      const y = yAt(i);
      const dy = short(f((y - prev) / 100));
      d += `${dx}${dy.startsWith("-") ? "" : " "}${dy} `;
      prev = y;
    }
    return `<path d="${d.trimEnd()}"/>`;
  };

  const calibration = (base: number) => {
    // flat 2 mm, 1 mV (10 mm) step for 200 ms (5 mm), back to baseline, flat to trace start.
    const a = gx + 1;
    marks.push(`<path d="M${a} ${base}h2v${-MM_PER_MV}h5v${MM_PER_MV}h2"/>`);
  };

  for (let r = 0; r < rows; r++) {
    const base = gy + r * rowH + 19;
    calibration(base);
    if (r < 3) {
      LAYOUT[r]!.forEach((lead, c) => {
        const xs = x0 + c * colSec * MM_PER_S;
        // Each column shows its own 2.5 s window of the simultaneous 10 s acquisition.
        trace.push(poly(tr.leads[lead], c * colSec, (c + 1) * colSec, xs, base));
        if (c > 0) marks.push(`<path d="M${f(xs)} ${base - 4}v8"/>`);
        labels.push(`<text x="${f(xs + 1.2)}" y="${base - 14.5}">${lead}</text>`);
      });
    } else {
      trace.push(poly(tr.leads[rhythmLead], 0, Math.min(tr.duration, 10), x0, base));
      labels.push(`<text x="${f(x0 + 1.2)}" y="${base - 14.5}">${rhythmLead}</text>`);
    }
  }
  out.push(`<g fill="none" stroke="#111" stroke-width="0.32" stroke-linejoin="round" stroke-linecap="round">${trace.join("")}</g>`);
  out.push(`<g fill="none" stroke="#111" stroke-width="0.32">${marks.join("")}</g>`);
  out.push(`<g font-size="3.4" font-weight="bold" fill="#111">${labels.join("")}</g>`);
  out.push(`<text x="${gx}" y="${H - 2.5}" font-size="2.4" fill="#666">Rhythm strip: lead ${rhythmLead}, 10 s. Generated by scripts/generate-assets.ts (deterministic model, no third-party content).</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
