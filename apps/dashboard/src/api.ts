const KEY = "dash.token";

export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: "instructor" | "case_author" | "admin" | "student";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export const token = {
  get: () => sessionStorage.getItem(KEY),
  set: (t: string | null) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY)),
};

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token.get() ? { authorization: `Bearer ${token.get()}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText, json?.details);
  return json as T;
}

/** Downloads an authenticated file (exports). */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token.get()}` } });
  if (!res.ok) throw new ApiError(res.status, "download failed");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function live(sessionId: string, onMessage: (m: { type: string; status?: string; seat?: Seat }) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/live?session=${sessionId}&token=${encodeURIComponent(token.get() ?? "")}`);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onopen = () => (retry = 1000);
    ws.onclose = (e) => {
      if (closed || e.code >= 4400) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15_000);
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

export interface Seat {
  attemptId: string;
  studentId: string;
  studentName: string;
  seat: string | null;
  caseId: string;
  attemptNo: number;
  status: "in_progress" | "finished";
  step: string;
  elapsedMs: number;
  inputSource: string | null;
  warnings: string[];
}

export const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const errorText = (e: unknown) =>
  e instanceof ApiError ? `${e.message}${e.details?.length ? `: ${e.details.map((d) => `${d.path || "case"} — ${d.message}`).join("; ")}` : ""}` : String(e);
