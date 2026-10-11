import ExcelJS from "exceljs";
import { ACTIONS, EXAM_POINTS, TESTS, validateCase, type CaseDefinition } from "@sim/shared";
import { FIELD_SHEETS, LISTS, TABLE_SHEETS, type Column, type FieldSheet, type ListName, type TableSheet } from "./layout.js";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F8B8D" } };
const INTRO_FONT: Partial<ExcelJS.Font> = { italic: true, color: { argb: "FF5B6B76" } };
const MAX_ROWS = 300;

type Cell = string | number | boolean | null | undefined;

// ---------------------------------------------------------------------------------------------
// Writing: blank template, or an existing case as a filled workbook
// ---------------------------------------------------------------------------------------------

/** Excel column letter for a 1-based index. */
const colLetter = (n: number): string => (n > 26 ? colLetter(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(65 + ((n - 1) % 26));

/** Cell ranges on the 'Lists' tab used by the dropdowns (the tab itself is written last). */
function listRanges(): Record<ListName, string> {
  const out = {} as Record<ListName, string>;
  (Object.keys(LISTS) as ListName[]).forEach((name, i) => {
    const col = colLetter(i + 1);
    out[name] = `Lists!$${col}$2:$${col}$${LISTS[name].length + 1}`;
  });
  return out;
}

function writeLists(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Lists", { properties: { tabColor: { argb: "FF8C96A1" } } });
  const names = Object.keys(LISTS) as ListName[];
  names.forEach((name, i) => {
    const col = colLetter(i + 1);
    ws.getCell(`${col}1`).value = name;
    ws.getCell(`${col}1`).font = { bold: true };
    LISTS[name].forEach((v, j) => (ws.getCell(`${col}${j + 2}`).value = v));
    ws.getColumn(i + 1).width = Math.max(14, ...LISTS[name].map((v) => v.length + 2));
  });
  // Human-readable reference of the shared libraries next to the dropdown lists.
  const ref = names.length + 2;
  const blocks: [string, { id: string; label: string }[]][] = [
    ["Exam points", EXAM_POINTS.map((p) => ({ id: p.id, label: `${p.label} (${p.tool})` }))],
    ["Tests", TESTS.map((t) => ({ id: t.id, label: t.label }))],
    ["Actions and drugs", ACTIONS.map((a) => ({ id: a.id, label: a.dose ? `${a.label} — ${a.dose}` : a.label }))],
  ];
  blocks.forEach(([title, rows], b) => {
    const idCol = ref + b * 3;
    ws.getCell(1, idCol).value = `${title}: id`;
    ws.getCell(1, idCol + 1).value = "label";
    ws.getRow(1).font = { bold: true };
    rows.forEach((r, j) => {
      ws.getCell(j + 2, idCol).value = r.id;
      ws.getCell(j + 2, idCol + 1).value = r.label;
    });
    ws.getColumn(idCol).width = 26;
    ws.getColumn(idCol + 1).width = 36;
  });
}

function validationFor(col: Column, ranges: Record<ListName, string>): ExcelJS.DataValidation | null {
  if (col.list) return { type: "list", allowBlank: !col.required, formulae: [ranges[col.list]], showErrorMessage: true, errorTitle: "Not in the list", error: `Choose a value from the list (see the 'Lists' tab).` };
  if (col.kind === "number") return { type: "decimal", operator: "greaterThanOrEqual", allowBlank: !col.required, formulae: [-100000], showErrorMessage: true, error: "Enter a number." };
  return null;
}

function writeTable(wb: ExcelJS.Workbook, s: TableSheet, rows: Record<string, Cell>[], ranges: Record<ListName, string>) {
  const ws = wb.addWorksheet(s.name, { views: [{ state: "frozen", ySplit: 2 }] });
  ws.getCell("A1").value = s.intro;
  ws.getCell("A1").font = INTRO_FONT;
  ws.mergeCells(1, 1, 1, s.columns.length);
  ws.getRow(1).height = 30;
  ws.getCell("A1").alignment = { wrapText: true, vertical: "top" };
  s.columns.forEach((col, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = col.header + (col.required ? " *" : "");
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { wrapText: true, vertical: "middle" };
    if (col.note) cell.note = col.note;
    ws.getColumn(i + 1).width = col.width;
    const dv = validationFor(col, ranges);
    if (dv) for (let r = 3; r <= MAX_ROWS; r++) ws.getCell(r, i + 1).dataValidation = dv;
  });
  ws.getRow(2).height = 32;
  rows.forEach((row, r) =>
    s.columns.forEach((col, i) => {
      const v = row[col.key];
      if (v === undefined || v === null || v === "") return;
      const cell = ws.getCell(r + 3, i + 1);
      cell.value = typeof v === "boolean" ? (v ? "yes" : "no") : v;
      cell.alignment = { wrapText: true, vertical: "top" };
    }),
  );
}

function writeFields(wb: ExcelJS.Workbook, s: FieldSheet, values: Record<string, Cell | Cell[]>, ranges: Record<ListName, string>) {
  const ws = wb.addWorksheet(s.name);
  ws.getCell("A1").value = s.intro;
  ws.getCell("A1").font = INTRO_FONT;
  ws.mergeCells("A1:B1");
  ws.getCell("A2").value = "Field";
  ws.getCell("B2").value = "Value";
  for (const a of ["A2", "B2"]) {
    ws.getCell(a).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getCell(a).fill = HEADER_FILL;
  }
  ws.getColumn(1).width = 44;
  ws.getColumn(2).width = 70;
  let r = 3;
  for (const f of s.fields) {
    const v = values[f.key];
    // Repeatable fields always get spare blank rows so another objective or author can be added.
    const filled = Array.isArray(v) ? v : [];
    const list = f.repeat ? [...filled, ...Array(Math.max(2, 4 - filled.length)).fill(undefined)] : [Array.isArray(v) ? v.join(", ") : v];
    for (const item of list) {
      ws.getCell(r, 1).value = f.header + (f.required ? " *" : "");
      if (f.note) ws.getCell(r, 1).note = f.note;
      if (item !== undefined && item !== null && item !== "") ws.getCell(r, 2).value = item as ExcelJS.CellValue;
      ws.getCell(r, 2).alignment = { wrapText: true, vertical: "top" };
      const dv = validationFor(f, ranges);
      if (dv) ws.getCell(r, 2).dataValidation = dv;
      r++;
    }
  }
}

const INSTRUCTIONS = [
  "How to fill in this case template",
  "",
  "1. Fill each tab from left to right. Columns marked * are required.",
  "2. Use the dropdowns. Exam points, tests and drugs must come from the shared lists (see the 'Lists' tab) so terms stay the same across cases; ask the dev team to add a missing one.",
  "3. Ids marked optional are created for you. Where an id is required (vital events, questions), use short lowercase words without spaces, e.g. o2_response.",
  "4. Times are in case minutes from the start of the case.",
  "5. Feedback columns are shown to the student in the debrief after the case.",
  "6. Send the finished file to the dev team. It is checked automatically: you get a list of any problems with the tab, row and column.",
  "7. A second academic reviews the case, then you play it in preview mode and sign it off.",
];

/** A workbook for `c`, or the blank template when `c` is undefined. */
export function caseToWorkbook(c?: CaseDefinition): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clinical Simulation";
  const intro = wb.addWorksheet("Instructions");
  INSTRUCTIONS.forEach((line, i) => {
    const cell = intro.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true, vertical: "top" };
    if (i === 0) cell.font = { bold: true, size: 14 };
  });
  intro.getColumn(1).width = 100;
  const ranges = listRanges();

  writeFields(
    wb,
    FIELD_SHEETS.metadata,
    c
      ? {
          id: c.metadata.id,
          title: c.metadata.title,
          course: c.metadata.course,
          specialty: c.metadata.specialty,
          difficulty: c.metadata.difficulty,
          timeLimitMin: c.metadata.timeLimitMin,
          learningObjective: c.metadata.learningObjectives,
          author: c.metadata.authors,
          reviewedBy: c.metadata.reviewedBy,
        }
      : {},
    ranges,
  );
  writeFields(wb, FIELD_SHEETS.patient, c ? { ...c.patient, appearance: c.patient.appearance } : {}, ranges);
  writeTable(wb, TABLE_SHEETS.history, c ? c.history.map((h) => ({ ...h })) : [], ranges);
  writeTable(wb, TABLE_SHEETS.examination, c ? c.examination.map((e) => ({ id: e.id, ...e.finding, relevant: e.relevant, points: e.points, feedback: e.feedback })) : [], ranges);
  writeFields(wb, FIELD_SHEETS.vitals, c ? { ...c.vitals.initial } : {}, ranges);

  const events: Record<string, Cell>[] = [];
  if (c) {
    for (const e of c.vitals.timed) for (const ch of e.changes) events.push({ id: e.id, type: "timed", atMin: e.atMin, ...ch, mode: ch.mode });
    for (const e of c.vitals.onAction) for (const ch of e.changes) events.push({ id: e.id, type: "after_action", action: e.onAction, afterMin: e.afterMin, ...ch });
    for (const e of c.vitals.deterioration)
      e.changes.forEach((ch, i) => events.push({ id: e.id, type: "deterioration", atMin: e.atMin, unless: e.unlessActions.join(", "), ...ch, ...(i === 0 && e.message ? { message: e.message } : {}) }));
  }
  writeTable(wb, TABLE_SHEETS.events, events, ranges);

  writeTable(
    wb,
    TABLE_SHEETS.investigations,
    c ? c.investigations.map((t) => ({ id: t.id, text: t.result.text, image: t.result.image, ecg: t.result.ecg, turnaroundMin: t.turnaroundMin, indicated: t.indicated, points: t.points, penalty: t.penalty, feedback: t.feedback })) : [],
    ranges,
  );
  writeTable(wb, TABLE_SHEETS.resultValues, c ? c.investigations.flatMap((t) => t.result.values.map((v) => ({ test: t.id, ...v }))) : [], ranges);

  const acceptable = new Map((c?.diagnosis.acceptable ?? []).map((a) => [a.id, a.points]));
  writeTable(
    wb,
    TABLE_SHEETS.diagnosis,
    c
      ? c.diagnosis.options.map((o) => {
          const correct = o.id === c.diagnosis.correct;
          return { id: o.id, label: o.label, correct, points: correct ? c.diagnosis.correctPoints : acceptable.get(o.id), feedback: correct ? c.diagnosis.feedback : undefined };
        })
      : [],
    ranges,
  );
  writeTable(wb, TABLE_SHEETS.management, c ? c.management.actions.map((a) => ({ ...a, critical: a.critical })) : [], ranges);
  writeTable(wb, TABLE_SHEETS.order, c ? c.management.requiredOrder.map((o) => ({ sequence: o.sequence.join(", "), penalty: o.penalty, feedback: o.feedback })) : [], ranges);
  writeTable(
    wb,
    TABLE_SHEETS.questions,
    c
      ? c.questions.map((q) => ({
          id: q.id,
          checkpoint: q.checkpoint.kind,
          atMin: q.checkpoint.kind === "time" ? q.checkpoint.atMin : undefined,
          action: q.checkpoint.kind === "after_action" ? q.checkpoint.action : undefined,
          type: q.type,
          prompt: q.prompt,
          points: q.points,
          feedback: q.feedback,
        }))
      : [],
    ranges,
  );
  writeTable(wb, TABLE_SHEETS.options, c ? c.questions.flatMap((q) => q.options.map((o) => ({ question: q.id, id: o.id, label: o.label, correct: q.correct.includes(o.id) }))) : [], ranges);
  writeFields(wb, FIELD_SHEETS.rubric, c ? { ...c.rubric, maxDifferentials: c.diagnosis.maxDifferentials } : { decisionWeight: 0.7, questionWeight: 0.3, passMark: 60, irrelevantHistoryPenalty: 0.5, maxDifferentials: 3 }, ranges);

  writeLists(wb);
  return wb;
}

// ---------------------------------------------------------------------------------------------
// Reading: workbook -> case input, with locations for error messages
// ---------------------------------------------------------------------------------------------

export interface Location {
  sheet: string;
  row?: number;
  column?: string;
}

export interface SheetIssue extends Location {
  message: string;
}

export type ImportResult = { ok: true; case: CaseDefinition; issues: [] } | { ok: false; issues: SheetIssue[] };

function cellText(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("").trim() || undefined;
    if ("result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ("text" in v) return cellText((v as { text: ExcelJS.CellValue }).text);
  }
  return String(v);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "x";

const stripStar = (s: string) => s.replace(/\s*\*$/, "").trim().toLowerCase();

class Reader {
  issues: SheetIssue[] = [];
  /** Case path prefix -> where it came from. */
  where = new Map<string, Location>();

  constructor(private readonly wb: ExcelJS.Workbook) {}

  private sheet(name: string): ExcelJS.Worksheet | null {
    const ws = this.wb.getWorksheet(name);
    if (!ws) this.issues.push({ sheet: name, message: `tab '${name}' is missing; start from the case template` });
    return ws ?? null;
  }

  convert(value: Cell, col: Column, loc: Location): Cell {
    if (value === undefined) {
      if (col.required) this.issues.push({ ...loc, column: col.header, message: "required" });
      return undefined;
    }
    if (col.kind === "number") {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      if (!Number.isFinite(n)) {
        this.issues.push({ ...loc, column: col.header, message: `expected a number, found "${value}"` });
        return undefined;
      }
      return n;
    }
    if (col.kind === "yesno") {
      const s = String(value).toLowerCase();
      if (["yes", "y", "true", "1"].includes(s)) return true;
      if (["no", "n", "false", "0"].includes(s)) return false;
      this.issues.push({ ...loc, column: col.header, message: `expected yes or no, found "${value}"` });
      return undefined;
    }
    const s = String(value);
    if (col.list && col.list !== "examPoint" && col.list !== "test" && col.list !== "action" && !LISTS[col.list].includes(s.toLowerCase())) {
      this.issues.push({ ...loc, column: col.header, message: `"${s}" is not one of: ${LISTS[col.list].join(", ")}` });
      return undefined;
    }
    return col.list ? s.toLowerCase() : s;
  }

  table(s: TableSheet): { row: number; values: Record<string, Cell> }[] {
    const ws = this.sheet(s.name);
    if (!ws) return [];
    // Map columns by header text so moved or extra columns do not break the import.
    const header = ws.getRow(2);
    const colIndex = new Map<string, number>();
    header.eachCell((cell, i) => {
      const h = stripStar(String(cellText(cell.value) ?? ""));
      const col = s.columns.find((c) => stripStar(c.header) === h);
      if (col) colIndex.set(col.key, i);
    });
    for (const col of s.columns) if (col.required && !colIndex.has(col.key)) this.issues.push({ sheet: s.name, row: 2, column: col.header, message: "column is missing" });
    const out: { row: number; values: Record<string, Cell> }[] = [];
    for (let r = 3; r <= ws.rowCount; r++) {
      const raw = s.columns.map((c) => (colIndex.has(c.key) ? cellText(ws.getRow(r).getCell(colIndex.get(c.key)!).value) : undefined));
      if (raw.every((v) => v === undefined)) continue;
      const values: Record<string, Cell> = {};
      s.columns.forEach((c, i) => (values[c.key] = this.convert(raw[i], c, { sheet: s.name, row: r })));
      out.push({ row: r, values });
    }
    return out;
  }

  fields(s: FieldSheet): { values: Record<string, Cell | Cell[]>; rows: Record<string, number> } {
    const ws = this.sheet(s.name);
    const values: Record<string, Cell | Cell[]> = {};
    const rows: Record<string, number> = {};
    if (!ws) return { values, rows };
    for (let r = 3; r <= ws.rowCount; r++) {
      const label = cellText(ws.getRow(r).getCell(1).value);
      if (label === undefined) continue;
      const f = s.fields.find((x) => stripStar(x.header) === stripStar(String(label)) || x.key.toLowerCase() === stripStar(String(label)));
      if (!f) continue;
      const raw = cellText(ws.getRow(r).getCell(2).value);
      rows[f.key] ??= r;
      if (f.repeat) {
        if (raw !== undefined) ((values[f.key] ??= []) as Cell[]).push(this.convert(raw, { ...f, required: false }, { sheet: s.name, row: r }));
      } else values[f.key] = this.convert(raw, f, { sheet: s.name, row: r });
    }
    for (const f of s.fields) {
      if (f.required && f.repeat && !(values[f.key] as Cell[] | undefined)?.length) this.issues.push({ sheet: s.name, row: rows[f.key], column: f.header, message: "at least one is required" });
      if (!(f.key in rows) && f.required) this.issues.push({ sheet: s.name, column: f.header, message: "row is missing" });
    }
    return { values, rows };
  }

  at(path: string, loc: Location) {
    this.where.set(path, loc);
  }
}

const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
const commaList = (v: Cell) => (v === undefined ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

/** Reads a workbook into a case object (not yet validated) and where each part came from. */
export function readWorkbook(wb: ExcelJS.Workbook): { input: Record<string, unknown>; reader: Reader } {
  const R = new Reader(wb);
  const S = TABLE_SHEETS;
  const F = FIELD_SHEETS;

  const meta = R.fields(F.metadata);
  for (const [k, r] of Object.entries(meta.rows)) R.at(`metadata.${k === "learningObjective" ? "learningObjectives" : k === "author" ? "authors" : k}`, { sheet: F.metadata.name, row: r });
  const patient = R.fields(F.patient);
  for (const [k, r] of Object.entries(patient.rows)) R.at(`patient.${k}`, { sheet: F.patient.name, row: r });
  const vitals = R.fields(F.vitals);
  for (const [k, r] of Object.entries(vitals.rows)) R.at(`vitals.initial.${k}`, { sheet: F.vitals.name, row: r });
  const rubric = R.fields(F.rubric);
  for (const [k, r] of Object.entries(rubric.rows)) R.at(k === "maxDifferentials" ? "diagnosis.maxDifferentials" : `rubric.${k}`, { sheet: F.rubric.name, row: r });

  const history = R.table(S.history).map(({ row, values: v }, i) => {
    R.at(`history.${i}`, { sheet: S.history.name, row });
    return defined({ id: (v.id as string) ?? `h${i + 1}`, topic: v.topic, text: v.text, answer: v.answer, relevance: v.relevance, points: v.points, feedback: v.feedback });
  });

  const examination = R.table(S.examination).map(({ row, values: v }, i) => {
    R.at(`examination.${i}`, { sheet: S.examination.name, row });
    return defined({ id: v.id, finding: defined({ text: v.text, sound: v.sound, image: v.image }), relevant: v.relevant, points: v.points, feedback: v.feedback });
  });

  // Vital events: rows grouped by event id.
  const timed: Record<string, unknown>[] = [];
  const onAction: Record<string, unknown>[] = [];
  const deterioration: Record<string, unknown>[] = [];
  const byId = new Map<string, { list: Record<string, unknown>[]; index: number; event: Record<string, unknown> & { changes: unknown[] } }>();
  for (const { row, values: v } of R.table(S.events)) {
    const change = defined({ vital: v.vital, mode: v.mode ?? "set", value: v.value, overMin: v.overMin ?? 0 });
    const id = String(v.id ?? "");
    let entry = byId.get(id);
    if (!entry) {
      const list = v.type === "timed" ? timed : v.type === "after_action" ? onAction : deterioration;
      const key = v.type === "timed" ? "timed" : v.type === "after_action" ? "onAction" : "deterioration";
      const event =
        v.type === "timed"
          ? { id, atMin: v.atMin, changes: [] as unknown[] }
          : v.type === "after_action"
            ? { id, onAction: v.action, afterMin: v.afterMin ?? 0, changes: [] as unknown[] }
            : defined({ id, atMin: v.atMin, unlessActions: commaList(v.unless), message: v.message, changes: [] as unknown[] });
      if (v.type === "timed" && v.atMin === undefined) R.issues.push({ sheet: S.events.name, row, column: "At minute", message: "timed events need a minute" });
      if (v.type === "after_action" && v.action === undefined) R.issues.push({ sheet: S.events.name, row, column: "Action", message: "after_action events need an action" });
      if (v.type === "deterioration" && (v.atMin === undefined || !commaList(v.unless).length))
        R.issues.push({ sheet: S.events.name, row, message: "deterioration events need a minute and at least one 'unless' action" });
      list.push(event);
      entry = { list, index: list.length - 1, event: event as Record<string, unknown> & { changes: unknown[] } };
      byId.set(id, entry);
      R.at(`vitals.${key}.${entry.index}`, { sheet: S.events.name, row });
    }
    entry.event.changes.push(change);
  }

  const values = new Map<string, Record<string, unknown>[]>();
  for (const { row, values: v } of R.table(S.resultValues)) {
    const list = values.get(String(v.test)) ?? [];
    list.push(defined({ name: v.name, value: v.value === undefined ? undefined : String(v.value), unit: v.unit, flag: v.flag }));
    values.set(String(v.test), list);
    R.at(`resultValues.${v.test}.${list.length - 1}`, { sheet: S.resultValues.name, row });
  }
  const investigations = R.table(S.investigations).map(({ row, values: v }, i) => {
    R.at(`investigations.${i}`, { sheet: S.investigations.name, row });
    return defined({
      id: v.id,
      result: defined({ text: v.text, values: values.get(String(v.id)) ?? [], image: v.image, ecg: v.ecg }),
      turnaroundMin: v.turnaroundMin,
      indicated: v.indicated,
      points: v.points,
      penalty: v.penalty,
      feedback: v.feedback,
    });
  });
  for (const testId of values.keys())
    if (!investigations.some((t) => t.id === testId)) {
      const loc = R.where.get(`resultValues.${testId}.0`)!;
      R.issues.push({ ...loc, message: `test "${testId}" has values but no row on the Investigations tab` });
    }

  const dxRows = R.table(S.diagnosis);
  const options = dxRows.map(({ row, values: v }, i) => {
    R.at(`diagnosis.options.${i}`, { sheet: S.diagnosis.name, row });
    return { id: (v.id as string) ?? slug(String(v.label ?? `option_${i + 1}`)), label: v.label };
  });
  const correctRows = dxRows.filter((r) => r.values.correct === true);
  if (correctRows.length !== 1) R.issues.push({ sheet: S.diagnosis.name, column: "Correct?", message: `mark exactly one diagnosis as correct (found ${correctRows.length})` });
  const correctRow = correctRows[0];
  const correctIdx = correctRow ? dxRows.indexOf(correctRow) : -1;
  if (correctRow) R.at("diagnosis.correct", { sheet: S.diagnosis.name, row: correctRow.row });
  const acceptable = dxRows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.values.correct !== true && typeof r.values.points === "number" && r.values.points > 0)
    .map(({ r, i }, j) => {
      R.at(`diagnosis.acceptable.${j}`, { sheet: S.diagnosis.name, row: r.row });
      return { id: options[i]!.id, points: r.values.points };
    });
  const diagnosis = defined({
    options,
    correct: correctIdx >= 0 ? options[correctIdx]!.id : undefined,
    correctPoints: correctRow?.values.points,
    acceptable,
    maxDifferentials: (rubric.values.maxDifferentials as number | undefined) ?? undefined,
    feedback: correctRow?.values.feedback,
  });
  if (correctRow && correctRow.values.points === undefined) R.issues.push({ sheet: S.diagnosis.name, row: correctRow.row, column: "Points", message: "give the correct diagnosis its points" });

  const actions = R.table(S.management).map(({ row, values: v }, i) => {
    R.at(`management.actions.${i}`, { sheet: S.management.name, row });
    return defined({ id: v.id, classification: v.classification, points: v.points, withinMin: v.withinMin, latePoints: v.latePoints, critical: v.critical, feedback: v.feedback });
  });
  const requiredOrder = R.table(S.order).map(({ row, values: v }, i) => {
    R.at(`management.requiredOrder.${i}`, { sheet: S.order.name, row });
    return defined({ sequence: commaList(v.sequence), penalty: v.penalty, feedback: v.feedback });
  });

  const optionRows = R.table(S.options);
  const questions = R.table(S.questions).map(({ row, values: v }, i) => {
    R.at(`questions.${i}`, { sheet: S.questions.name, row });
    const mine = optionRows.filter((o) => String(o.values.question) === String(v.id));
    const opts = mine.map((o, j) => {
      R.at(`questions.${i}.options.${j}`, { sheet: S.options.name, row: o.row });
      return { id: (o.values.id as string) ?? String.fromCharCode(97 + j), label: o.values.label };
    });
    if (!mine.length) R.issues.push({ sheet: S.options.name, message: `question "${v.id}" has no options` });
    const checkpoint = v.checkpoint === "time" ? { kind: "time", atMin: v.atMin } : v.checkpoint === "after_action" ? { kind: "after_action", action: v.action } : { kind: "before_diagnosis" };
    return defined({
      id: v.id,
      checkpoint,
      type: v.type,
      prompt: v.prompt,
      options: opts,
      correct: mine.map((o, j) => (o.values.correct === true ? opts[j]!.id : null)).filter((x): x is string => x !== null),
      points: v.points,
      feedback: v.feedback,
    });
  });
  for (const o of optionRows)
    if (!questions.some((q) => String(q.id) === String(o.values.question)))
      R.issues.push({ sheet: S.options.name, row: o.row, column: "Question id", message: `no question with id "${o.values.question}" on the Questions tab` });

  const m = meta.values;
  const input = {
    schemaVersion: 1,
    metadata: defined({
      id: m.id,
      version: 1,
      title: m.title,
      course: m.course,
      specialty: m.specialty,
      difficulty: m.difficulty,
      learningObjectives: m.learningObjective ?? [],
      timeLimitMin: m.timeLimitMin,
      authors: m.author ?? [],
      reviewedBy: m.reviewedBy,
    }),
    patient: defined({ ...patient.values, appearance: commaList(patient.values.appearance as Cell).map((s) => s.toLowerCase()) }),
    history,
    examination,
    vitals: { initial: vitals.values, timed, onAction, deterioration },
    investigations,
    diagnosis,
    management: { actions, requiredOrder },
    questions,
    rubric: defined({ decisionWeight: rubric.values.decisionWeight, questionWeight: rubric.values.questionWeight, passMark: rubric.values.passMark, irrelevantHistoryPenalty: rubric.values.irrelevantHistoryPenalty }),
  };
  return { input, reader: R };
}

/** Where a validator path like "history.3.answer" came from in the workbook. */
function locate(where: Map<string, Location>, path: string): Location | null {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const loc = where.get(parts.slice(0, n).join("."));
    if (!loc) continue;
    // Name the column when the rest of the path is a single known field.
    const rest = parts.slice(n);
    if (rest.length && !loc.column) {
      const sheet = [...Object.values(TABLE_SHEETS), ...Object.values(FIELD_SHEETS)].find((s) => s.name === loc.sheet);
      const cols = sheet ? ("columns" in sheet ? sheet.columns : sheet.fields) : [];
      // Prefer the most specific field name (checkpoint.action -> "action"), then the first.
      const named = rest.filter((p) => !/^\d+$/.test(p));
      const col = [...named].reverse().map((k) => cols.find((c) => c.key === k)).find(Boolean);
      if (col) return { ...loc, column: col.header };
    }
    return loc;
  }
  return null;
}

/** Workbook bytes -> validated case, or a list of problems located by tab, row and column. */
export async function importCaseWorkbook(data: ArrayBuffer | Buffer): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as ArrayBuffer);
  } catch {
    return { ok: false, issues: [{ sheet: "(file)", message: "not a readable .xlsx file" }] };
  }
  const { input, reader } = readWorkbook(wb);
  // Problems found while reading cells come first; schema problems would mostly repeat them.
  if (reader.issues.length) return { ok: false, issues: reader.issues };
  const v = validateCase(input);
  if (v.ok) return { ok: true, case: v.case, issues: [] };
  return {
    ok: false,
    issues: v.issues.map((i) => {
      const loc = locate(reader.where, i.path) ?? { sheet: "(case)" };
      return { ...loc, message: `${i.message}${loc.sheet === "(case)" ? ` (${i.path})` : ""}` };
    }),
  };
}

export const formatIssue = (i: SheetIssue) => `${i.sheet}${i.row ? ` row ${i.row}` : ""}${i.column ? ` · ${i.column}` : ""}: ${i.message}`;

export async function workbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
