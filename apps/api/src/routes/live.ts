import type { FastifyInstance } from "fastify";
import type { AuthUser } from "../auth.js";
import { sessionSeats } from "../seats.js";

/**
 * WebSocket: /api/live?session=<id>&token=<jwt>
 * Instructors (and admins) get seat updates; students get session status changes.
 */
export async function liveRoutes(app: FastifyInstance) {
  app.get("/api/live", { websocket: true }, async (socket, req) => {
    const { session, token } = req.query as { session?: string; token?: string };
    let user: AuthUser;
    try {
      user = app.jwt.verify<AuthUser>(token ?? "");
    } catch {
      socket.close(4401, "not signed in");
      return;
    }
    if (!session) {
      socket.close(4400, "session required");
      return;
    }
    const { rows } = await app.db.query(
      "SELECT s.instructor_id, s.status, EXISTS (SELECT 1 FROM course_members m WHERE m.course_id = s.course_id AND m.user_id = $2) AS member FROM sessions s WHERE s.id = $1",
      [session, user.id],
    );
    const s = rows[0];
    const staff = user.role === "admin" || (user.role === "instructor" && s?.instructor_id === user.id);
    if (!s || !(staff || (user.role === "student" && s.member))) {
      socket.close(4403, "not allowed");
      return;
    }
    const unsubscribe = app.live.subscribe(session, socket, staff);
    socket.on("close", unsubscribe);
    socket.send(JSON.stringify({ type: "session", sessionId: session, status: s.status }));
    if (staff) for (const seat of await sessionSeats(app.db, session)) socket.send(JSON.stringify({ type: "seat", sessionId: session, seat }));
  });
}
