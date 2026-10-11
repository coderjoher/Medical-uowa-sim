import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PW = "demo-pass-123";
const cases = readdirSync("content/cases")
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`content/cases/${f}`, "utf8")) as { metadata: { id: string; title: string } });

async function signIn(page: Page, user: string, query = "") {
  await page.goto(`/${query}`);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const startButton = (page: Page, title: string) => page.locator(".case-row", { hasText: title }).getByRole("button");

test("every case plays end to end in the student app, and loads within 15 s", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, "student4");
  for (const c of cases) {
    await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
    await startButton(page, c.metadata.title).click();
    const t0 = Date.now();
    await page.getByRole("button", { name: "Use the mouse" }).click();
    await expect(page.getByRole("button", { name: "Begin" })).toBeVisible({ timeout: 15_000 });
    const loadMs = Date.now() - t0;
    console.log(`${c.metadata.id}: ready in ${loadMs} ms`);
    expect(loadMs).toBeLessThan(15_000);
    await page.getByRole("button", { name: "Begin" }).click();

    // Every panel opens and shows the case's own content.
    for (const [nav, heading] of [["History", "History"], ["Examine", "Examination"], ["Tests", "Investigations"], ["Manage", "Management"]] as const) {
      await page.locator(".menubar").getByRole("button", { name: nav }).click();
      await expect(page.locator(".panel h2").first()).toHaveText(heading);
    }
    await page.locator(".menubar").getByRole("button", { name: "History" }).click();
    await page.locator(".panel .list .item").first().click();
    await expect(page.locator(".caption")).not.toBeEmpty();

    await page.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
    await page.getByRole("button", { name: "Finish and see results" }).click();
    await expect(page.locator(".big-score")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".debrief h1")).toHaveText(c.metadata.title);
    await page.getByRole("button", { name: "Back to sessions" }).click();
  }
});

test("a whole case can be completed by hand tracking alone", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, "student5", "?fakeHand=1");
  await startButton(page, "Chest pain in a 45-year-old man").click();
  await page.getByRole("button", { name: "Use hand tracking" }).click();
  await page.waitForFunction(() => !!(window as any).__sim?.hold);

  /** Point at an element and pinch: the only input used from here on. */
  const tap = async (locator: ReturnType<Page["locator"]>) => {
    await locator.scrollIntoViewIfNeeded();
    const box = (await locator.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.evaluate(([x, y]) => (window as any).__sim.hold("point", x, y, 500), [x, y]);
    await expect(locator).toHaveClass(/hand-hover/);
    await page.evaluate(([x, y]) => (window as any).__sim.hold("pinch", x, y, 250), [x, y]);
    await page.evaluate(([x, y]) => (window as any).__sim.hold("point", x, y, 200), [x, y]);
  };
  const nav = (name: string) => page.locator(".menubar").getByRole("button", { name });
  const panel = (name: string | RegExp) => page.locator(".panel").getByRole("button", { name });

  await tap(page.getByRole("button", { name: "Begin", exact: true }));
  await tap(nav("History"));
  await tap(panel(/When did the pain start/));
  await tap(page.locator(".panel .tabs").getByRole("button", { name: "Drugs" }));
  await tap(panel(/any other tablets recently/));
  await tap(nav("Examine"));
  await tap(page.locator(".tray").getByRole("button", { name: "Stethoscope" }));
  await tap(panel("Heart auscultation"));
  await tap(nav("Tests"));
  await tap(page.locator(".panel .item", { hasText: "12-lead ECG" }).getByRole("button", { name: "Order" }));
  const q = page.getByRole("dialog", { name: "Checkpoint question" });
  await tap(q.getByRole("button", { name: "Right coronary artery" }));
  await tap(q.getByRole("button", { name: "Submit answer" }));
  await tap(nav("Manage"));
  await tap(panel(/^Aspirin/));
  await tap(page.locator("[data-modal]").getByRole("button", { name: "Confirm" }));
  await tap(nav("Diagnosis"));
  for (const o of ["PDE-5 inhibitor in the last 24-48 h", "Systolic BP below 90 mmHg", "Suspected right ventricular infarct"]) await tap(q.getByRole("button", { name: o, exact: true }));
  await tap(q.getByRole("button", { name: "Submit answer" }));
  await tap(nav("Diagnosis"));
  await tap(page.locator(".panel [role=radiogroup]").getByRole("radio", { name: "Inferior ST-elevation myocardial infarction" }));
  await tap(panel("Commit diagnosis"));
  await tap(nav("Finish case"));
  await tap(page.getByRole("button", { name: "Finish and see results" }));
  await expect(page.locator(".big-score")).toBeVisible({ timeout: 20_000 });

  // Every clinical action was made by hand.
  const token = await page.evaluate(() => sessionStorage.getItem("sim.token"));
  const sessions = await (await page.request.get("/api/my/sessions", { headers: { authorization: `Bearer ${token}` } })).json();
  const attemptId = sessions[0].cases[0].attempts.at(-1).id;
  const actions = (await (await page.request.get(`/api/attempts/${attemptId}/result`, { headers: { authorization: `Bearer ${token}` } })).json()).timeline as { type: string }[];
  expect(actions.length).toBeGreaterThanOrEqual(10);
  const r = await page.request.get(`/api/attempts/${attemptId}`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status()).toBe(200);
  const clinical = (await r.json()).actions.filter((a: { type: string }) => !["case.start", "case.end", "view.change", "tracking.stats", "tracking.lost", "input.switch"].includes(a.type));
  // 2 history questions, 1 exam, 1 test, 2 checkpoint answers, 1 drug, 1 diagnosis.
  expect(clinical.length).toBe(8);
  expect(new Set(clinical.map((a: { inputSource: string }) => a.inputSource))).toEqual(new Set(["hand"]));
});

test("an attempt survives the tab dying while offline, keeping the offline actions", async ({ page, context }) => {
  test.setTimeout(180_000);
  await signIn(page, "student5");
  await startButton(page, "Breathless 9-year-old girl").click();
  await page.getByRole("button", { name: "Use the mouse" }).click();
  await page.getByRole("button", { name: "Begin" }).click();
  await page.locator(".menubar").getByRole("button", { name: "History" }).click();
  await page.locator(".panel").getByRole("button", { name: /When did this start/ }).click();
  await expect(page.locator(".hud")).toContainText("Saved");

  await context.setOffline(true);
  await page.locator(".panel").getByRole("button", { name: /reliever inhaler/ }).click();
  await page.locator(".panel").getByRole("button", { name: /full sentences/ }).click();
  await expect(page.locator(".hud")).toContainText("Offline", { timeout: 10_000 });

  // The tab goes away while still offline, so the last two actions exist only on this PC.
  // (Actions are written to local storage when they happen, so a crash behaves the same.)
  await page.close();
  await context.setOffline(false);

  const again = await context.newPage();
  await signIn(again, "student5");
  await expect(again.locator(".toast")).toContainText("Resumed where you stopped", { timeout: 60_000 });
  await again.locator(".menubar").getByRole("button", { name: "History" }).click();
  await expect(again.locator(".panel .item.done")).toHaveCount(3);
  await expect(again.locator(".hud")).toContainText("Saved", { timeout: 15_000 });

  const token = await again.evaluate(() => sessionStorage.getItem("sim.token"));
  const attemptId = await again.evaluate(() => JSON.parse(localStorage.getItem("sim.current")!).attemptId);
  const stored = (await (await again.request.get(`/api/attempts/${attemptId}`, { headers: { authorization: `Bearer ${token}` } })).json()).actions;
  expect(stored.filter((a: { type: string }) => a.type === "history.ask")).toHaveLength(3);
});
