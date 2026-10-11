import type { WebSocket } from "ws";

/**
 * In-process pub/sub for live updates. Staff watch seat status; students only receive session
 * control messages (pause, resume, end), never other students' seats. One API server per
 * campus, so in-memory is enough for Stage 1.
 */
export type LiveMessage =
  | { type: "seat"; sessionId: string; seat: unknown }
  | { type: "session"; sessionId: string; status: "open" | "paused" | "ended" };

interface Sub {
  ws: WebSocket;
  staff: boolean;
}

export class LiveHub {
  private subs = new Map<string, Set<Sub>>();

  subscribe(sessionId: string, ws: WebSocket, staff: boolean): () => void {
    let set = this.subs.get(sessionId);
    if (!set) this.subs.set(sessionId, (set = new Set()));
    const sub = { ws, staff };
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (!set!.size) this.subs.delete(sessionId);
    };
  }

  publish(msg: LiveMessage): void {
    const data = JSON.stringify(msg);
    for (const { ws, staff } of this.subs.get(msg.sessionId) ?? []) {
      if (msg.type === "seat" && !staff) continue;
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
}
