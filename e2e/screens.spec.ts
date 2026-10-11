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

async function startOrResume(p: import("@playwright/test").Page) {
  const begin = p.getByRole("button", { name: "Begin" });
  await expect(begin.or(p.getByText("Resumed where you stopped"))).toBeVisible({ timeout: 60_000 });
  if (await begin.isVisible()) await begin.click();
}

test("capture debrief and dashboard screenshots", async ({ page, browser }) => {
  test.setTimeout(300_000); // three browsers rendering 3D in software is slow
  // Instructor dashboard watching the seeded session.
  const staff = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await staff.goto("/staff/");
  await staff.getByLabel("Username").fill("instructor");
  await staff.getByLabel("Password").fill("demo-pass-123");
  await staff.getByRole("button", { name: "Sign in" }).click();
  await staff.getByRole("button", { name: "Open" }).first().click();

  for (const [user, seat] of [["student2", "Seat 02"], ["student3", "Seat 03"]] as const) {
    const p = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await p.goto("/");
    await p.getByLabel("Username").fill(user);
    await p.getByLabel("Password").fill("demo-pass-123");
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.getByLabel("Seat").selectOption({ label: seat });
    await p.getByRole("button", { name: /Start|Resume|Try again/ }).first().click();
    await p.getByRole("button", { name: "Use the mouse" }).click();
    await startOrResume(p);
    await p.locator(".menubar").getByRole("button", { name: user === "student2" ? "Examine" : "History" }).click();
  }

  // Student 1 plays a short case and finishes.
  await page.goto("/");
  await page.getByLabel("Username").fill("student1");
  await page.getByLabel("Password").fill("demo-pass-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Seat").selectOption({ label: "Seat 01" });
  await page.getByRole("button", { name: /Start|Resume|Try again/ }).first().click();
  await page.getByRole("button", { name: "Use the mouse" }).click();
  // Resumes the attempt the scene-screenshot test left open, if any.
  await startOrResume(page);
  await page.locator(".menubar").getByRole("button", { name: "History" }).click();
  await page.locator(".panel").getByRole("button", { name: /When did the pain start/ }).click();
  await page.locator(".panel").getByRole("button", { name: /Does the pain go anywhere else/ }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/screenshots/history.png" });
  await page.locator(".menubar").getByRole("button", { name: "Tests" }).click();
  await page.locator(".panel .item", { hasText: "12-lead ECG" }).getByRole("button", { name: "Order" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/checkpoint-question.png" });
  await page.getByRole("dialog", { name: "Checkpoint question" }).getByRole("button", { name: "Right coronary artery" }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();
  await page.locator(".menubar").getByRole("button", { name: "Manage" }).click();
  await page.locator(".panel").getByRole("button", { name: /^Aspirin/ }).click();
  await page.locator("[data-modal]").getByRole("button", { name: "Confirm" }).click();
  await page.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
  await page.getByRole("button", { name: "Finish and see results" }).click();
  await expect(page.locator(".big-score")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "docs/screenshots/debrief.png", fullPage: true });

  await expect(staff.locator(".seat")).toHaveCount(3);
  await staff.waitForTimeout(500);
  await staff.screenshot({ path: "docs/screenshots/dashboard-live.png" });
  await staff.getByRole("button", { name: "Results" }).click();
  await staff.waitForTimeout(800);
  await staff.screenshot({ path: "docs/screenshots/dashboard-results.png" });
});
