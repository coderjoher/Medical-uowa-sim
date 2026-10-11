import { expect, test } from "@playwright/test";

// Not a test of behaviour: captures screenshots of the scene for visual review.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture");
test("capture scene screenshots", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill("student1");
  await page.getByLabel("Password").fill("demo-pass-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Start|Resume|Try again/ }).first().click();
  await page.getByRole("button", { name: "Use the mouse" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "docs/screenshots/overview.png" });
  await page.locator(".menubar").getByRole("button", { name: "Examine" }).click();
  await page.locator(".tray").getByRole("button", { name: "Stethoscope" }).click();
  await page.locator(".panel .tabs").getByRole("button", { name: "Chest" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/screenshots/exam-chest.png" });
  await page.locator(".panel .tabs").getByRole("button", { name: "Back" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/screenshots/exam-back.png" });
  await page.locator(".panel .tabs").getByRole("button", { name: "Head" }).click();
  await page.locator(".tray").getByRole("button", { name: "Penlight" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/screenshots/exam-head.png" });
  await expect(page.locator(".vitals")).toBeVisible();
});
