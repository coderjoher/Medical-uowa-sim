import { expect, test, type Page } from "@playwright/test";

const PW = "demo-pass-123";

async function login(page: Page, user = "student1", query = "") {
  await page.goto(`/${query}`);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
}

async function startCase(page: Page, mode: "mouse" | "hand") {
  await page.getByLabel("Seat").selectOption({ label: "Seat 01" });
  await page.getByRole("button", { name: /Start|Resume|Try again/ }).first().click();
  await page.getByRole("button", { name: mode === "mouse" ? "Use the mouse" : "Use hand tracking" }).click();
}

const panelButton = (page: Page, name: string | RegExp) => page.locator(".panel").getByRole("button", { name });
const confirm = async (page: Page) => page.locator("[data-modal]").getByRole("button", { name: "Confirm" }).click();

async function answerCheckpoint(page: Page, options: string[]) {
  const dlg = page.getByRole("dialog", { name: "Checkpoint question" });
  await expect(dlg).toBeVisible();
  for (const o of options) await dlg.getByRole("button", { name: o, exact: true }).click();
  await dlg.getByRole("button", { name: "Submit answer" }).click();
  await expect(dlg).toBeHidden();
}

test("full case with the mouse only, then the debrief", async ({ page }) => {
  const uploads: { url: string; bytes: number; type: string }[] = [];
  const origins = new Set<string>();
  page.on("request", (r) => {
    if (!r.url().startsWith("data:") && !r.url().startsWith("blob:")) origins.add(new URL(r.url()).origin);
    // GET and HEAD carry no body (HEAD checks whether a drop-in patient model exists).
    if (!["GET", "HEAD"].includes(r.method())) uploads.push({ url: r.url(), bytes: r.postDataBuffer()?.length ?? 0, type: r.headers()["content-type"] ?? "" });
  });

  await login(page);
  await startCase(page, "mouse");
  // The PRD allows 15 s for the first case to be ready (the patient model is the largest download).
  await expect(page.getByRole("dialog", { name: "Case handover" })).toContainText("45-year-old man", { timeout: 15_000 });
  await page.getByRole("button", { name: "Begin" }).click();
  await expect(page.locator(".vitals")).toContainText("HR 98");

  // History
  await page.locator(".menubar").getByRole("button", { name: "History" }).click();
  await panelButton(page, /When did the pain start/).click();
  await expect(page.locator(".caption")).toContainText("two hours ago");
  await panelButton(page, /Does the pain go anywhere else/).click();
  await page.locator(".panel .tabs").getByRole("button", { name: "Drugs" }).click();
  await panelButton(page, /any other tablets recently/).click();
  await expect(page.locator(".caption")).toContainText("sildenafil");

  // Examination
  await page.locator(".menubar").getByRole("button", { name: "Examine" }).click();
  await page.locator(".tray").getByRole("button", { name: "Stethoscope" }).click();
  await panelButton(page, "Heart auscultation").click();
  await expect(page.locator(".caption")).toContainText("Normal heart sounds");

  // Investigations -> ECG triggers a checkpoint question
  await page.locator(".menubar").getByRole("button", { name: "Tests" }).click();
  await page.locator(".panel .item", { hasText: "12-lead ECG" }).getByRole("button", { name: "Order" }).click();
  await answerCheckpoint(page, ["Right coronary artery"]);

  // Management (each action is confirmed, so a false click cannot give a drug)
  await page.locator(".menubar").getByRole("button", { name: "Manage" }).click();
  for (const drug of [/^Oxygen/, /^Aspirin/, /^Refer to cardiology/]) {
    await panelButton(page, drug).click();
    await confirm(page);
  }

  // Diagnosis -> before-diagnosis checkpoint first
  await page.locator(".menubar").getByRole("button", { name: "Diagnosis" }).click();
  await answerCheckpoint(page, ["PDE-5 inhibitor in the last 24-48 h", "Systolic BP below 90 mmHg", "Suspected right ventricular infarct"]);
  await page.locator(".menubar").getByRole("button", { name: "Diagnosis" }).click();
  await page.locator(".panel [role=radiogroup]").getByRole("radio", { name: "Inferior ST-elevation myocardial infarction" }).click();
  await panelButton(page, "Commit diagnosis").click();

  // Finish -> debrief
  await page.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
  await page.getByRole("button", { name: "Finish and see results" }).click();
  await expect(page.locator(".big-score")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Correct diagnosis" })).toBeVisible();
  await expect(page.locator(".debrief")).toContainText("Inferior ST-elevation myocardial infarction");
  await expect(page.locator(".debrief")).toContainText(/What you missed/);
  await expect(page.locator(".timeline li")).toHaveCount(13);

  // Runs on the campus LAN alone: every request (app, models, MediaPipe, API) is same-origin.
  expect([...origins]).toEqual([new URL(page.url()).origin]);

  // Privacy: nothing but small JSON was ever sent to the server.
  expect(uploads.length).toBeGreaterThan(0);
  for (const u of uploads) {
    expect(new URL(u.url).pathname.startsWith("/api/")).toBe(true);
    if (u.bytes) expect(u.type).toContain("application/json");
    expect(u.bytes).toBeLessThan(64_000);
  }
});

test("hand gestures drive the UI and actions are logged as hand input", async ({ page }) => {
  await login(page, "student2", "?fakeHand=1");
  await startCase(page, "hand");
  await page.waitForFunction(() => !!(window as any).__sim?.hold);

  const pinchOn = async (locator: ReturnType<Page["locator"]>) => {
    const box = (await locator.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(([x, y]) => (window as any).__sim.hold("point", x, y, 600), [x, y]);
    await expect(locator).toHaveClass(/hand-hover/);
    await page.evaluate(([x, y]) => (window as any).__sim.hold("pinch", x, y, 300), [x, y]);
    await page.evaluate(([x, y]) => (window as any).__sim.hold("point", x, y, 300), [x, y]);
  };

  await pinchOn(page.getByRole("button", { name: "Begin" }));
  await expect(page.getByRole("dialog", { name: "Case handover" })).toBeHidden();
  await expect(page.locator("#hand-cursor")).toBeVisible();

  await pinchOn(page.locator(".menubar").getByRole("button", { name: "History" }));
  await expect(page.locator(".panel h2")).toHaveText("History");
  await pinchOn(panelButton(page, /When did the pain start/));
  await expect(page.locator(".caption")).toContainText("two hours ago");

  // Open palm held still closes the open panel (cancel).
  await page.evaluate(() => (window as any).__sim.hold("open_palm", 900, 450, 500));
  await expect(page.locator(".panel")).toBeHidden();

  // Swipe turns the patient (view changes).
  const before = await page.locator(".hud .chip").first().textContent();
  await page.evaluate(() => {
    const s = (window as any).__sim;
    // Bring the hand to the start, then sweep about a third of the screen in 300 ms.
    s.hold("point", 1200, 450, 300);
    for (let i = 0; i < 10; i++) s.hold("open_palm", 1200 - i * 60, 450, 33);
    s.hold("point", 600, 450, 300);
  });
  await expect(page.locator(".hud .chip").first()).not.toHaveText(before!);

  // The server recorded these as hand actions.
  const token = await page.evaluate(() => sessionStorage.getItem("sim.token"));
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem("sim.current")!).attemptId);
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/attempts/${current}`, { headers: { authorization: `Bearer ${token}` } });
      return (await r.json()).actions.filter((a: any) => a.type === "history.ask").map((a: any) => a.inputSource);
    })
    .toEqual(["hand"]);
});

test("an attempt survives a refresh and a network drop", async ({ page, context }) => {
  await login(page, "student3");
  await startCase(page, "mouse");
  await page.getByRole("button", { name: "Begin" }).click();
  await page.locator(".menubar").getByRole("button", { name: "History" }).click();
  await panelButton(page, /When did the pain start/).click();
  await expect(page.locator(".hud")).toContainText("Saved");

  // Network drop: actions are kept on the PC and synced when the network returns.
  await context.setOffline(true);
  await panelButton(page, /What does the pain feel like/).click();
  await panelButton(page, /Does the pain go anywhere else/).click();
  await expect(page.locator(".hud")).toContainText("Offline", { timeout: 10_000 });
  await context.setOffline(false);
  await expect(page.locator(".hud")).toContainText("Saved", { timeout: 15_000 });

  const timeBefore = await page.locator(".timer").textContent();
  await page.reload();
  await expect(page.locator(".toast")).toContainText("Resumed where you stopped");
  await page.locator(".menubar").getByRole("button", { name: "History" }).click();
  await expect(page.locator(".panel .item.done")).toHaveCount(3);
  const toSec = (t: string) => t.split(" / ")[0]!.split(":").reduce((a, b) => a * 60 + Number(b), 0);
  expect(toSec((await page.locator(".timer").textContent())!)).toBeGreaterThanOrEqual(toSec(timeBefore!));
});
