import type { ActionLogEntry, ActionType, InputSource } from "@sim/shared";
import { api, ApiError } from "./api.js";

interface Stored {
  queue: ActionLogEntry[];
  nextSeq: number;
  clock?: { accumulatedMs: number; runningSince: number | null };
}

const key = (attemptId: string) => `sim.attempt.${attemptId}`;

const load = (attemptId: string): Stored | null => {
  try {
    const raw = localStorage.getItem(key(attemptId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
};

/**
 * Records actions and syncs them to the server. Every action goes to localStorage first, so
 * a network drop, refresh or crash never loses it; unsynced actions are re-sent until the
 * server confirms them (the server ignores duplicates by id).
 */
export class ActionRecorder {
  private queue: ActionLogEntry[] = [];
  private nextSeq = 0;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  online = true;
  onStatus: (online: boolean, pending: number) => void = () => {};

  /** @param local preview mode: keep actions on this PC only, never send them. */
  constructor(
    private readonly attemptId: string,
    serverLog: readonly { seq?: number }[],
    private readonly local = false,
  ) {
    const stored = load(attemptId);
    const serverMax = serverLog.reduce((m, a) => Math.max(m, a.seq ?? -1), -1);
    this.queue = stored?.queue ?? [];
    this.nextSeq = Math.max(serverMax + 1, stored?.nextSeq ?? 0);
  }

  /** Unsynced actions from a previous page load (to merge into the replayed log). */
  get pending(): readonly ActionLogEntry[] {
    return this.queue;
  }

  savedClock(): Stored["clock"] {
    return load(this.attemptId)?.clock;
  }

  saveClock(clock: NonNullable<Stored["clock"]>): void {
    this.persist(clock);
  }

  private persist(clock?: Stored["clock"]) {
    try {
      const prev = load(this.attemptId);
      localStorage.setItem(key(this.attemptId), JSON.stringify({ queue: this.queue, nextSeq: this.nextSeq, clock: clock ?? prev?.clock }));
    } catch {
      /* storage full or blocked: actions still go to the server directly */
    }
  }

  record(type: ActionType, ref: string | undefined, caseTimeMs: number, inputSource: InputSource, payload?: Record<string, unknown>): ActionLogEntry {
    const entry: ActionLogEntry = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      caseTimeMs: Math.max(0, Math.round(caseTimeMs)),
      clientTs: new Date().toISOString(),
      type,
      ...(ref !== undefined ? { ref } : {}),
      ...(payload ? { payload } : {}),
      inputSource,
    };
    this.queue.push(entry);
    this.persist();
    void this.flush();
    return entry;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<boolean> {
    if (this.flushing) return false;
    if (this.local) this.queue = [];
    if (!this.queue.length) {
      this.onStatus(this.online, 0);
      return true;
    }
    this.flushing = true;
    const batch = this.queue.slice(0, 200);
    try {
      await api("POST", `/api/attempts/${this.attemptId}/actions`, { actions: batch }, { timeoutMs: 8000 });
      const sent = new Set(batch.map((a) => a.id));
      this.queue = this.queue.filter((a) => !sent.has(a.id));
      this.persist();
      this.online = true;
    } catch (e) {
      // A 4xx other than auth means the server will never take this batch (e.g. attempt finished).
      if (e instanceof ApiError && e.status === 409) {
        this.queue = [];
        this.persist();
      } else this.online = false;
    } finally {
      this.flushing = false;
    }
    this.onStatus(this.online, this.queue.length);
    if (this.online && this.queue.length) return this.flush();
    return this.online;
  }

  /** Flush everything, retrying, before finishing the attempt. */
  async drain(timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < until) {
      if (!(await this.flush())) await new Promise((r) => setTimeout(r, 1000));
    }
    return this.queue.length === 0;
  }

  clear(): void {
    this.stop();
    try {
      localStorage.removeItem(key(this.attemptId));
    } catch {
      /* ignore */
    }
  }
}
