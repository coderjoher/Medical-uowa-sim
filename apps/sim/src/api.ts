/** Thin client for the API. The token lives in sessionStorage so closing the browser signs out. */
const TOKEN_KEY = "sim.token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const auth = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(t: string | null) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: token stays in memory only */
    }
  },
};

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(path, {
      method,
      signal: ctrl.signal,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText, json?.details);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export function liveSocket(sessionId: string, onMessage: (m: { type: string; status?: string }) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/live?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(auth.token ?? "")}`);
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
