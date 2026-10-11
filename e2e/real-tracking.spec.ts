import { expect, test } from "@playwright/test";

// The real MediaPipe pipeline (WebAssembly + hand model + Web Worker) under the production
// Content Security Policy, fed by Chromium's fake camera.
test.use({
  launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["camera"],
});

test("real hand tracking loads and runs under the content security policy", async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/?labcheck=1");
  await page.getByLabel("Username").fill("instructor");
  await page.getByLabel("Password").fill("demo-pass-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("row", { name: /Camera/ })).toContainText("✓ Working", { timeout: 60_000 });
  // Frames are flowing through the worker: the tracking frame rate becomes non-zero.
  await expect(page.getByRole("row", { name: /Tracking frame rate/ })).not.toContainText(/ 0 fps/, { timeout: 30_000 });
  await expect(page.getByRole("row", { name: /3D frame rate/ })).toContainText("fps", { timeout: 30_000 });
  expect(problems).toEqual([]);
});
