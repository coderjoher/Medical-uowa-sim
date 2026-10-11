/**
 * Renders every SVG in content/assets/{ecg,images} to PNG previews in content/assets/previews/
 * using the Playwright Chromium already installed for e2e tests.
 *
 * Usage (repo root): PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx tsx scripts/render-asset-previews.ts
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "content/assets");
const outDir = join(assets, "previews");
mkdirSync(outDir, { recursive: true });

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const sub of ["ecg", "images"]) {
      for (const file of readdirSync(join(assets, sub)).filter((f) => f.endsWith(".svg")).sort()) {
        const svg = readFileSync(join(assets, sub, file), "utf8");
        const w = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 1200);
        const h = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 800);
        await page.setViewportSize({ width: w, height: h });
        await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
        const out = join(outDir, `${sub}-${basename(file, ".svg")}.png`);
        await page.locator("svg").first().screenshot({ path: out });
        console.log(`  ${out.slice(root.length + 1)}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
