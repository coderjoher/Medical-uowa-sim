import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

const PW = "demo-pass-123";

async function staffLogin(page: Page, user: string, pw = PW) {
  await page.goto("/staff/");
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Staff dashboard")).toBeVisible();
}

async function studentPage(browser: Browser, user: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
  return page;
}

test("admin manages users, courses, labs and sees system health", async ({ page }) => {
  await staffLogin(page, "admin", "admin-pass-123");
  await page.getByRole("link", { name: "Users" }).click();
  await page.getByLabel("Username").fill("newstudent");
  await page.getByLabel("Full name").fill("New Student");
  await page.getByLabel(/^Password/).fill("new-student-1");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByRole("cell", { name: "New Student" })).toBeVisible();

  // Edit the role.
  const row = page.getByRole("row", { name: /newstudent/ });
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Role of newstudent").selectOption("instructor");
  await page.getByRole("row", { name: /newstudent/ }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row", { name: /newstudent/ })).toContainText("instructor");

  // Bulk import: a bad file lists problems; a good one imports.
  await page.getByLabel("Users CSV").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("username,display_name,role\nok1,OK,student\nbad name,X,pilot\n") });
  await expect(page.locator(".issues")).toContainText('line 3 — invalid username "bad name"');
  await page.getByLabel("Users CSV").setInputFiles({ name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from("username,display_name,role,courses\nroster1,Roster One,student,MED-401\nroster2,Roster Two,student,MED-401\n") });
  await expect(page.locator(".note")).toContainText("Imported: 2 created, 0 updated, 2 course enrolments.");
  await expect(page.getByRole("cell", { name: "Roster Two" })).toBeVisible();

  await page.getByRole("link", { name: "Courses" }).click();
  await page.getByLabel("Course code").fill("MED-999");
  await page.getByLabel("Course title").fill("Test course");
  await page.getByRole("button", { name: "Add course" }).click();
  await expect(page.getByRole("heading", { name: "MED-999 — Test course" })).toBeVisible();

  await page.getByRole("link", { name: "Labs" }).click();
  await page.getByLabel("Lab name").fill("Sim Lab 2");
  await page.getByRole("button", { name: "Add lab" }).click();
  await expect(page.getByRole("cell", { name: "Sim Lab 2" })).toBeVisible();

  await page.getByRole("link", { name: "System health" }).click();
  await expect(page.getByText("Running")).toBeVisible();
  await expect(page.getByText("Database size")).toBeVisible();
});

test("case author imports, previews and signs off; admin publishes", async ({ page, browser }) => {
  const c = JSON.parse(readFileSync("content/cases/chest-pain-stemi.json", "utf8"));
  c.metadata.id = "chest-pain-copy";
  c.metadata.title = "Chest pain (copy for test)";
  await staffLogin(page, "author");
  await page.getByRole("link", { name: "Case library" }).click();

  // The blank template downloads, and uploading it unfilled lists what is missing by tab and row.
  const [tpl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download blank template" }).click()]);
  expect(tpl.suggestedFilename()).toBe("case-template.xlsx");
  await page.getByLabel("Case file").setInputFiles((await tpl.path())!);
  await expect(page.locator(".issues")).toContainText("Metadata row 3 · Case id — required");

  // A filled spreadsheet imports as a draft.
  const { caseToWorkbook, workbookBuffer } = await import("@sim/case-sheet");
  const { validateCase } = await import("@sim/shared");
  const sheetCase = structuredClone(c);
  sheetCase.metadata.id = "chest-pain-sheet";
  sheetCase.metadata.title = "Chest pain (from spreadsheet)";
  const v = validateCase(sheetCase);
  if (!v.ok) throw new Error("invalid");
  await page.getByLabel("Case file").setInputFiles({ name: "filled.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await workbookBuffer(caseToWorkbook(v.case)) });
  await expect(page.locator(".note")).toContainText("Imported chest-pain-sheet as version 1");

  // A broken case shows its validation problems.
  const bad = structuredClone(c);
  bad.management.actions[0].id = "unobtainium";
  await page.getByLabel("Case file").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.locator(".issues")).toContainText('unknown drug or action "unobtainium"');

  await page.getByLabel("Case file").setInputFiles({ name: "case.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(c)) });
  await expect(page.locator(".note")).toContainText("Imported chest-pain-copy as version 1");
  const row = page.getByRole("row", { name: /Chest pain \(copy for test\)/ });
  await expect(row.getByText("draft")).toBeVisible();

  // Preview: play it in the student app without storing anything.
  const [preview] = await Promise.all([page.waitForEvent("popup"), row.getByRole("link", { name: "Preview" }).click()]);
  await preview.getByRole("button", { name: "Use the mouse" }).click();
  await preview.getByRole("button", { name: "Begin" }).click();
  await preview.locator(".menubar").getByRole("button", { name: "Tests" }).click();
  await preview.locator(".panel .item", { hasText: "12-lead ECG" }).getByRole("button", { name: "Order" }).click();
  await preview.getByRole("dialog", { name: "Checkpoint question" }).getByRole("button", { name: "Right coronary artery" }).click();
  await preview.getByRole("button", { name: "Submit answer" }).click();
  await expect(preview.locator(".panel")).toContainText(/12-lead ECG\s*Result in/);
  await preview.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
  await preview.getByRole("button", { name: "Finish and see results" }).click();
  await expect(preview.getByText("Preview — this play-through was not stored.")).toBeVisible();
  await expect(preview.locator(".big-score")).toBeVisible();
  await preview.close();

  await row.getByRole("button", { name: "Sign off" }).click();
  await expect(row.getByText("signed off")).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await staffLogin(admin, "admin", "admin-pass-123");
  await admin.getByRole("link", { name: "Case library" }).click();
  const adminRow = admin.getByRole("row", { name: /Chest pain \(copy for test\)/ });
  await adminRow.getByRole("button", { name: "Publish" }).click();
  await expect(adminRow.getByText("published")).toBeVisible();
});

test("instructor runs a session: live seats, pause, retry, results and exports", async ({ page, browser }) => {
  await staffLogin(page, "instructor");
  await page.getByLabel("Course").selectOption({ label: "MED-401 — Clinical Reasoning" });
  await page.getByLabel("Lab").selectOption({ index: 1 });
  await page.getByLabel(/Chest pain in a 45-year-old man/).check();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.getByRole("button", { name: "Live seats" })).toBeVisible();
  const sessionId = page.url().split("/session/")[1]!;

  // A student joins this session; the instructor sees the seat update live.
  const student = await studentPage(browser, "student1");
  const section = student.locator("section.card").filter({ has: student.getByRole("heading", { name: "MED-401 · Sim Lab 1" }) }).last();
  await section.getByLabel("Seat").selectOption({ label: "Seat 07" });
  await section.getByRole("button", { name: /Start|Try again/ }).click();
  await student.getByRole("button", { name: "Use the mouse" }).click();
  await student.getByRole("button", { name: "Begin" }).click();
  const seat = page.getByRole("article", { name: /Student 1 Seat 07/ });
  await expect(seat).toBeVisible();
  await student.locator(".menubar").getByRole("button", { name: "History" }).click();
  await student.locator(".panel").getByRole("button", { name: /When did the pain start/ }).click();
  await expect(seat.locator(".step")).toHaveText("history");

  // Pause reaches the student.
  await page.getByRole("button", { name: "Pause for everyone" }).click();
  await expect(student.getByRole("dialog", { name: "Paused" })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(student.getByRole("dialog", { name: "Paused" })).toBeHidden();

  // Student finishes; instructor allows a retry.
  await student.locator(".menubar").getByRole("button", { name: "Finish case" }).click();
  await student.getByRole("button", { name: "Finish and see results" }).click();
  await expect(student.locator(".big-score")).toBeVisible({ timeout: 20_000 });
  await expect(seat.locator(".step")).toHaveText("finished");
  await seat.getByRole("button", { name: "Allow retry" }).click();
  await expect(page.locator(".note")).toContainText("Retry allowed for Student 1");

  // Results and exports.
  await page.getByRole("button", { name: "Results" }).click();
  await expect(page.getByRole("cell", { name: "Student 1" })).toBeVisible();
  await expect(page.getByText(/1 students · mean/)).toBeVisible();
  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export to Excel" }).click()]);
  expect(xlsx.suggestedFilename()).toBe("results.xlsx");
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export to PDF" }).click()]);
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  // Ending the session.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.locator("h1 .badge")).toHaveText("ended");
  expect(sessionId).toBeTruthy();
});
