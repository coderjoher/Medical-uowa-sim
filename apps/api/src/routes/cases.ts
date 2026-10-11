import { caseToWorkbook, formatIssue, importCaseWorkbook, workbookBuffer } from "@sim/case-sheet";
import { scoreAttempt } from "@sim/engine";
import { ActionLogEntry, toStudentCase, validateCase, type CaseDefinition } from "@sim/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { tx } from "../db.js";
import { badRequest, conflict } from "../http-errors.js";
import { loadCase, scoreAndStore } from "../scoring-service.js";

type Params = { id: string; version: string };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ver = (p: Params) => {
  const v = Number(p.version);
  if (!Number.isInteger(v) || v < 1) throw badRequest("version must be a positive integer");
  return v;
};

/** JSON with sorted keys, so documents read back from jsonb compare equal to the originals. */
const stableJson = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stableJson).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** Everything except scoring: if this differs, it is a new case version, not a rubric correction. */
const contentOf = (c: CaseDefinition) => stableJson({ view: toStudentCase(c), results: c.investigations.map((t) => t.result) });

export async function caseRoutes(app: FastifyInstance) {
  const authors = { preHandler: requireRole("admin", "case_author") };

  /** Stores a validated case as a new immutable draft version. */
  const storeNewVersion = (c: CaseDefinition, userId: string) =>
    tx(app.db, async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [c.metadata.id]);
      const { rows } = await q.query("SELECT coalesce(max(version), 0) + 1 AS next FROM case_versions WHERE case_id = $1", [c.metadata.id]);
      const version = rows[0].next as number;
      const def = { ...c, metadata: { ...c.metadata, version } };
      await q.query("INSERT INTO case_versions (case_id, version, title, course_code, definition, imported_by) VALUES ($1, $2, $3, $4, $5, $6)", [
        c.metadata.id,
        version,
        c.metadata.title,
        c.metadata.course,
        def,
        userId,
      ]);
      return { caseId: c.metadata.id, version, status: "draft" };
    });

  // Import a case JSON: validation + new immutable version.
  app.post("/api/admin/cases", authors, async (req, reply) => {
    const v = validateCase(req.body);
    if (!v.ok) throw badRequest("case failed validation", v.issues);
    return reply.code(201).send(await storeNewVersion(v.case, req.user.id));
  });

  // Import the academics' filled spreadsheet template (raw .xlsx body).
  app.post("/api/admin/cases/xlsx", authors, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("send the .xlsx file as the request body");
    const r = await importCaseWorkbook(req.body);
    if (!r.ok) throw badRequest("case template has problems", r.issues.map((i) => ({ path: formatIssue({ ...i, message: "" }).replace(/: $/, ""), message: i.message })));
    return reply.code(201).send(await storeNewVersion(r.case, req.user.id));
  });

  // Blank template (always in sync with the shared drug, test and exam-point lists).
  app.get("/api/admin/case-template.xlsx", authors, async (_req, reply) =>
    reply
      .header("content-type", XLSX)
      .header("content-disposition", 'attachment; filename="case-template.xlsx"')
      .send(await workbookBuffer(caseToWorkbook())),
  );

  // An existing version as a filled template, to start a revision from.
  app.get("/api/admin/cases/:id/:version/xlsx", authors, async (req, reply) => {
    const p = req.params as Params;
    const { definition } = await loadCase(app.db, p.id, ver(p));
    return reply
      .header("content-type", XLSX)
      .header("content-disposition", `attachment; filename="${p.id}-v${ver(p)}.xlsx"`)
      .send(await workbookBuffer(caseToWorkbook(definition)));
  });

  app.get("/api/admin/cases", { preHandler: requireRole("admin", "case_author", "instructor") }, async () => {
    const { rows } = await app.db.query(
      `SELECT case_id AS "caseId", version, title, course_code AS "course", status, rubric_revision AS "rubricRevision",
              signed_off_at AS "signedOffAt", published_at AS "publishedAt", created_at AS "createdAt"
       FROM case_versions ORDER BY case_id, version DESC`,
    );
    return rows;
  });

  app.get("/api/admin/cases/:id/:version", authors, async (req) => {
    const p = req.params as Params;
    return (await loadCase(app.db, p.id, ver(p))).definition;
  });

  // Preview mode: the author plays the case as a student would see it and gets the full debrief.
  app.get("/api/admin/cases/:id/:version/preview", authors, async (req) => {
    const p = req.params as Params;
    return toStudentCase((await loadCase(app.db, p.id, ver(p))).definition);
  });

  app.post("/api/admin/cases/:id/:version/preview-score", authors, async (req) => {
    const p = req.params as Params;
    const { actions } = z.object({ actions: z.array(ActionLogEntry) }).parse(req.body);
    return scoreAttempt((await loadCase(app.db, p.id, ver(p))).definition, actions);
  });

  app.post("/api/admin/cases/:id/:version/signoff", authors, async (req) => {
    const p = req.params as Params;
    const r = await app.db.query(
      "UPDATE case_versions SET status = 'signed_off', signed_off_by = $3, signed_off_at = now() WHERE case_id = $1 AND version = $2 AND status = 'draft' RETURNING status",
      [p.id, ver(p), req.user.id],
    );
    if (!r.rowCount) {
      await loadCase(app.db, p.id, ver(p)); // 404 if missing
      throw conflict("only a draft can be signed off");
    }
    return { caseId: p.id, version: ver(p), status: "signed_off" };
  });

  app.post("/api/admin/cases/:id/:version/publish", { preHandler: requireRole("admin") }, async (req) => {
    const p = req.params as Params;
    const v = ver(p);
    const { status } = await loadCase(app.db, p.id, v);
    if (status !== "signed_off") throw conflict("a case must be validated and signed off in preview before it is published");
    await tx(app.db, async (q) => {
      await q.query("UPDATE case_versions SET status = 'retired' WHERE case_id = $1 AND status = 'published'", [p.id]);
      await q.query("UPDATE case_versions SET status = 'published', published_at = now() WHERE case_id = $1 AND version = $2", [p.id, v]);
    });
    return { caseId: p.id, version: v, status: "published" };
  });

  /**
   * Rubric correction: replace only the scoring of an existing version and re-score every
   * finished attempt on it from its action log. Content changes need a new version instead.
   */
  app.post("/api/admin/cases/:id/:version/rubric", { preHandler: requireRole("admin") }, async (req) => {
    const p = req.params as Params;
    const v = ver(p);
    const check = validateCase(req.body);
    if (!check.ok) throw badRequest("case failed validation", check.issues);
    const { definition: old } = await loadCase(app.db, p.id, v);
    const next = { ...check.case, metadata: { ...old.metadata } };
    if (contentOf(next) !== contentOf(old)) throw badRequest("only scoring fields may change in a rubric correction; import a new version for content changes");
    return tx(app.db, async (q) => {
      const { rows } = await q.query(
        "UPDATE case_versions SET definition = $3, rubric_revision = rubric_revision + 1 WHERE case_id = $1 AND version = $2 RETURNING rubric_revision",
        [p.id, v, next],
      );
      const attempts = await q.query("SELECT id FROM attempts WHERE case_id = $1 AND case_version = $2 AND status = 'finished'", [p.id, v]);
      for (const a of attempts.rows) await scoreAndStore(q, a.id);
      return { caseId: p.id, version: v, rubricRevision: rows[0].rubric_revision, rescored: attempts.rowCount };
    });
  });

}
