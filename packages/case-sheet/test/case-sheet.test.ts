import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { validateCase, type CaseDefinition } from "@sim/shared";
import { caseToWorkbook, formatIssue, importCaseWorkbook, workbookBuffer } from "../src/index.js";

const refCase = (): CaseDefinition => {
  const r = validateCase(JSON.parse(readFileSync(new URL("../../../content/cases/chest-pain-stemi.json", import.meta.url), "utf8")));
  if (!r.ok) throw new Error("reference case invalid");
  return r.case;
};

/** q.correct comes back in option order; compare as sets. */
const normalize = (c: CaseDefinition) => ({ ...c, questions: c.questions.map((q) => ({ ...q, correct: [...q.correct].sort() })) });

async function roundTrip(wb: ExcelJS.Workbook) {
  return importCaseWorkbook(await workbookBuffer(wb));
}

async function edit(c: CaseDefinition, fn: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await workbookBuffer(caseToWorkbook(c))) as unknown as ArrayBuffer);
  fn(wb);
  return roundTrip(wb);
}

const issues = (r: Awaited<ReturnType<typeof importCaseWorkbook>>) => (r.ok ? [] : r.issues.map(formatIssue));

describe("case template", () => {
  it("has one tab per case part plus instructions and lists, with dropdowns", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await workbookBuffer(caseToWorkbook())) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Instructions",
      "Metadata",
      "Patient",
      "History questions",
      "Examination",
      "Vitals",
      "Vital events",
      "Investigations",
      "Result values",
      "Diagnosis",
      "Management",
      "Required order",
      "Questions",
      "Question options",
      "Rubric",
      "Lists",
    ]);
    const exam = wb.getWorksheet("Examination")!;
    expect(exam.getCell("A3").dataValidation?.type).toBe("list");
    expect(String(exam.getCell("A3").dataValidation?.formulae?.[0])).toContain("Lists!");
    expect(wb.getWorksheet("Rubric")!.getCell("B3").value).toBe(0.7);
  });

  it("an empty template reports what is missing instead of crashing", async () => {
    const r = await roundTrip(caseToWorkbook());
    expect(r.ok).toBe(false);
    expect(issues(r)).toContain("Metadata row 3 · Case id: required");
    expect(issues(r).some((i) => i.startsWith("Diagnosis · Correct?: mark exactly one"))).toBe(true);
  });
});

describe("import", () => {
  it("round-trips the reference case with no data loss", async () => {
    const c = refCase();
    const r = await roundTrip(caseToWorkbook(c));
    if (!r.ok) throw new Error(issues(r).join("\n"));
    expect(normalize(r.case)).toEqual(normalize(c));
  });

  it("generates ids an academic leaves blank", async () => {
    const r = await edit(refCase(), (wb) => {
      wb.getWorksheet("History questions")!.getCell("A3").value = null;
      wb.getWorksheet("Diagnosis")!.getCell("A4").value = null; // "nstemi" row
      wb.getWorksheet("Question options")!.getCell("B3").value = null;
    });
    if (!r.ok) throw new Error(issues(r).join("\n"));
    expect(r.case.history[0]!.id).toBe("h1");
    expect(r.case.diagnosis.options[1]!.id).toBe("non_st_elevation_myocardial_infarction");
    expect(r.case.questions[0]!.options[0]!.id).toBe("a");
  });

  it("points to the tab, row and column of each problem", async () => {
    const r = await edit(refCase(), (wb) => {
      wb.getWorksheet("History questions")!.getCell("D5").value = null; // missing answer
      wb.getWorksheet("Management")!.getCell("A3").value = "unobtainium"; // unknown drug
      wb.getWorksheet("Investigations")!.getCell("E3").value = "soon"; // not a number
      wb.getWorksheet("Examination")!.getCell("E4").value = "maybe"; // not yes/no
    });
    expect(issues(r)).toEqual(
      expect.arrayContaining([
        "History questions row 5 · Patient's answer: required",
        'Investigations row 3 · Turnaround (case minutes): expected a number, found "soon"',
        'Examination row 4 · Relevant?: expected yes or no, found "maybe"',
      ]),
    );
  });

  it("reports library and reference problems with their row", async () => {
    const r = await edit(refCase(), (wb) => {
      wb.getWorksheet("Management")!.getCell("A3").value = "unobtainium";
      wb.getWorksheet("Questions")!.getCell("D3").value = "nothing"; // after_action trigger that does not exist
    });
    expect(issues(r)).toEqual(
      expect.arrayContaining([
        'Management row 3 · Action: unknown drug or action "unobtainium"',
        'Questions row 3 · After action: "nothing" is not an action in this case',
      ]),
    );
  });

  it("requires exactly one correct diagnosis", async () => {
    const r = await edit(refCase(), (wb) => (wb.getWorksheet("Diagnosis")!.getCell("C4").value = "yes"));
    expect(issues(r)).toContain("Diagnosis · Correct?: mark exactly one diagnosis as correct (found 2)");
  });

  it("finds columns by header even if they were moved", async () => {
    const r = await edit(refCase(), (wb) => {
      const ws = wb.getWorksheet("History questions")!;
      // Swap the Question and Patient's answer columns, headers included.
      for (let row = 2; row <= ws.rowCount; row++) {
        const a = ws.getCell(row, 3).value;
        ws.getCell(row, 3).value = ws.getCell(row, 4).value;
        ws.getCell(row, 4).value = a;
      }
    });
    if (!r.ok) throw new Error(issues(r).join("\n"));
    expect(r.case.history[0]!.text).toBe("When did the pain start?");
  });

  it("rejects a file that is not a workbook", async () => {
    expect(issues(await importCaseWorkbook(Buffer.from("not excel")))).toEqual(["(file): not a readable .xlsx file"]);
  });
});
