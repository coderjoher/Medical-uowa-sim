import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ResultRow } from "./routes/sessions.js";

type Cohort = {
  caseId: string;
  students: number;
  meanPct: number;
  medianPct: number;
  passRate: number;
  mostMissed: { ref: string; area: string; missed: number; missedPct: number }[];
};

export interface ResultsExport {
  title: string;
  results: ResultRow[];
  cohort: Cohort[];
}

const AREAS = ["history", "examination", "investigations", "diagnosis", "management", "safety"] as const;

/** Results workbook: one sheet per student attempt row, cohort summary, and most-missed items. */
export async function resultsXlsx(r: ResultsExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clinical Simulation";
  const students = wb.addWorksheet("Students");
  students.columns = [
    { header: "Student", key: "student", width: 24 },
    { header: "Username", key: "username", width: 16 },
    { header: "Case", key: "caseId", width: 22 },
    { header: "Version", key: "caseVersion", width: 9 },
    { header: "Attempt", key: "attemptNo", width: 9 },
    { header: "Score %", key: "totalPct", width: 10 },
    { header: "Result", key: "result", width: 12 },
    { header: "Critical errors", key: "criticalErrors", width: 15 },
    ...AREAS.map((a) => ({ header: a[0]!.toUpperCase() + a.slice(1), key: a, width: 14 })),
    { header: "Questions %", key: "questionsPct", width: 12 },
  ];
  for (const x of r.results)
    students.addRow({
      student: x.studentName,
      username: x.username,
      caseId: x.caseId,
      caseVersion: x.caseVersion,
      attemptNo: x.attemptNo,
      totalPct: x.totalPct,
      result: x.passed ? "Passed" : "Not passed",
      criticalErrors: x.criticalErrors,
      ...Object.fromEntries(AREAS.map((a) => [a, x.areas[a].max ? `${x.areas[a].points}/${x.areas[a].max}` : x.areas[a].points])),
      questionsPct: x.questionsPct,
    });
  students.getRow(1).font = { bold: true };
  students.views = [{ state: "frozen", ySplit: 1 }];

  const cohort = wb.addWorksheet("Cohort");
  cohort.columns = [
    { header: "Case", key: "caseId", width: 24 },
    { header: "Students", key: "students", width: 10 },
    { header: "Mean %", key: "meanPct", width: 10 },
    { header: "Median %", key: "medianPct", width: 10 },
    { header: "Pass rate %", key: "passRate", width: 12 },
  ];
  r.cohort.forEach((c) => cohort.addRow(c));
  cohort.getRow(1).font = { bold: true };

  const missed = wb.addWorksheet("Most missed");
  missed.columns = [
    { header: "Case", key: "caseId", width: 24 },
    { header: "Area", key: "area", width: 16 },
    { header: "Item", key: "ref", width: 30 },
    { header: "Students who missed it", key: "missed", width: 22 },
    { header: "% of cohort", key: "missedPct", width: 12 },
  ];
  for (const c of r.cohort) for (const m of c.mostMissed) missed.addRow({ caseId: c.caseId, ...m });
  missed.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Printable PDF of the same results. */
export function resultsPdf(r: ResultsExport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: r.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(r.title);
    doc.moveDown(0.3).fontSize(9).fillColor("#555").text(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} · formative results`);
    doc.fillColor("#000");

    for (const c of r.cohort) {
      doc.moveDown().fontSize(13).text(`Case: ${c.caseId}`);
      doc.fontSize(10).text(`Students ${c.students} · mean ${c.meanPct}% · median ${c.medianPct}% · pass rate ${c.passRate}%`);
      if (c.mostMissed.length) {
        doc.moveDown(0.3).fontSize(10).text("Most missed:", { underline: true });
        for (const m of c.mostMissed) doc.text(`• ${m.ref} (${m.area}) — missed by ${m.missed} (${m.missedPct}%)`);
      }
    }

    doc.moveDown().fontSize(13).text("Students");
    doc.moveDown(0.3);
    const cols = [
      { h: "Student", w: 150 },
      { h: "Case", w: 130 },
      { h: "Att.", w: 35 },
      { h: "Score", w: 50 },
      { h: "Result", w: 75 },
      { h: "Critical", w: 50 },
    ];
    const row = (cells: string[], bold = false) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      let x = doc.page.margins.left;
      doc.fontSize(9).font(bold ? "Helvetica-Bold" : "Helvetica");
      cells.forEach((cell, i) => {
        doc.text(cell, x, y, { width: cols[i]!.w - 6, ellipsis: true, lineBreak: false });
        x += cols[i]!.w;
      });
      doc.moveDown(0.6);
      doc.x = doc.page.margins.left;
    };
    row(cols.map((c) => c.h), true);
    for (const x of r.results) row([x.studentName, x.caseId, String(x.attemptNo), `${x.totalPct}%`, x.passed ? "Passed" : "Not passed", String(x.criticalErrors)]);
    doc.end();
  });
}
