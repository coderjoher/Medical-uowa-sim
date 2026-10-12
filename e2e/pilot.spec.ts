import { expect, test, type Page } from "@playwright/test";

const PW = "demo-pass-123";

async function signIn(page: Page, url: string, user: string, pw = PW) {
  await page.goto(url);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function staff(page: Page, user: string, pw = PW) {
  await signIn(page, "/staff/", user, pw);
  await expect(page.getByText("Simulation dashboard")).toBeVisible();
}

const hold = (page: Page, pose: string | null, x: number, y: number, ms: number) =>
  page.evaluate(([p, x, y, ms]) => (window as any).__sim.hold(p, x, y, ms), [pose, x, y, ms] as const);

test("lab check saves a result per seat and the seat shows in readiness", async ({ page, browser }) => {
  await signIn(page, "/?labcheck=1&fakeHand=1", "instructor");
  await page.getByLabel("Seat").selectOption({ label: "Sim Lab 1 · Seat 06" });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Lab check" })).toBeVisible();
  await hold(page, "point", 800, 450, 1500); // a hand in view at 30 fps
  await page.getByRole("button", { name: "I heard it" }).click();
  await expect(page.getByRole("button", { name: "Save result" })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Save result" }).click();
  await expect(page.getByText(/^Saved: seat/)).toBeVisible();

  const dash = await (await browser.newContext()).newPage();
  await staff(dash, "instructor");
  await dash.getByRole("link", { name: "Seat readiness" }).click();
  await dash.getByLabel("Lab").selectOption({ label: "Sim Lab 1" });
  const seat = dash.getByRole("article", { name: "Seat 06" });
  await expect(seat).not.toContainText("never checked");
  await expect(seat).toContainText("tracking 30");
});

test("surveys after a case and for the course feed the pilot report; academics review scores", async ({ page, browser }) => {
  await signIn(page, "/", "student2");
  await page.getByRole("button", { name: /Start|Resume|Try again/ }).first().click();
  await page.getByRole("button", { name: "Use the mouse" }).click();
  const begin = page.getByRole("button", { name: "Begin" });
  await expect(begin.or(page.getByText("Resumed where you stopped"))).toBeVisible({ timeout: 60_000 });
  if (await begin.isVisible()) await begin.click();
  await page.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
  await page.getByRole("button", { name: "Finish and see results" }).click();
  await expect(page.locator(".big-score")).toBeVisible({ timeout: 20_000 });

  // Case survey under the debrief.
  const survey = page.locator(".survey");
  await survey.getByRole("radiogroup", { name: "Did you use hand tracking?" }).getByRole("radio", { name: "No" }).click();
  await survey.getByRole("radiogroup", { name: /How useful/ }).getByRole("radio", { name: "4" }).click();
  await survey.getByRole("button", { name: "Send feedback" }).click();
  await expect(survey).toContainText("Thank you for your feedback.");

  // Course survey from the sessions screen.
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await page.getByRole("button", { name: "Course feedback: MED-401" }).click();
  const dlg = page.getByRole("dialog", { name: "Course feedback" });
  await dlg.getByRole("radiogroup", { name: /hand tracking reliable/ }).getByRole("radio", { name: "Yes" }).click();
  await dlg.getByRole("radiogroup", { name: /how useful/ }).getByRole("radio", { name: "5" }).click();
  await dlg.getByRole("textbox").fill("Very realistic monitor");
  await dlg.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Course feedback: MED-401" })).toBeHidden();

  // Pilot report shows it.
  const admin = await (await browser.newContext()).newPage();
  await staff(admin, "admin", "admin-pass-123");
  await admin.getByRole("link", { name: "Pilot report" }).click();
  await expect(admin.getByRole("row", { name: /Students rating hand tracking reliable/ })).toContainText("100 %");
  await expect(admin.getByText("Very realistic monitor")).toBeVisible();
  const [xlsx] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("button", { name: "Export to Excel" }).click()]);
  expect(xlsx.suggestedFilename()).toBe("pilot-report.xlsx");

  // Academic score review.
  const author = await (await browser.newContext()).newPage();
  await staff(author, "author");
  await author.getByRole("link", { name: "Score review" }).click();
  // Wait for the page to switch: the case library (the author's default page) also has "Case…" fields.
  await expect(author.getByRole("heading", { name: "Score review" })).toBeVisible();
  await author.getByLabel("Case").selectOption({ label: "Chest pain in a 45-year-old man" });
  await author.getByRole("button", { name: "Review" }).first().click();
  await expect(author.getByRole("region", { name: "Attempt under review" })).toBeVisible();
  await author.getByRole("button", { name: "Agree", exact: true }).click();
  await expect(author.getByRole("cell", { name: "Agrees" }).first()).toBeVisible();
});

test("case media are served on the LAN at /media", async ({ request }) => {
  const ecg = await request.get("/media/ecg/inferior-stemi.svg");
  expect(ecg.status()).toBe(200);
  expect(ecg.headers()["content-type"]).toContain("image/svg+xml");
  const heart = await request.get("/media/sounds/heart-normal.wav");
  expect(heart.status()).toBe(200);
  expect(heart.headers()["cache-control"]).toBe("public, max-age=86400"); // replaceable, so never "immutable"
  // Encoded traversal must not escape the media folder.
  for (const path of ["/media/..%2f..%2fpackage.json", "/media/%2e%2e/%2e%2e/package.json"]) {
    const r = await request.get(path);
    expect(await r.text()).not.toContain('"workspaces"');
  }
});

test("staff signed in on a lab PC who open the student page are sent to the dashboard", async ({ page }) => {
  await signIn(page, "/?labcheck=1&fakeHand=1", "admin", "admin-pass-123");
  await expect(page.getByRole("heading", { name: "Lab check" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This page is for students" })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the dashboard" })).toHaveAttribute("href", "/staff/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
});
