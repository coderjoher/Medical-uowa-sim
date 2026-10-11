import { useEffect } from "react";
import { useGet } from "../hooks.js";

interface Health {
  server: { ok: boolean; uptimeS: number; node: string };
  activeSessions: number;
  attemptsInProgress: number;
  liveConnections: number;
  storage: { databaseBytes: number };
  lastBackup: string | null;
}

export function HealthPage() {
  const [h, error, reload] = useGet<Health>("/api/admin/health");
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);
  if (error) return <p className="error">{error}</p>;
  if (!h) return <p>Loading…</p>;
  const backupAgeH = h.lastBackup ? (Date.now() - new Date(h.lastBackup).getTime()) / 3600_000 : null;
  return (
    <>
      <h1>System health</h1>
      <div className="tiles">
        <div className="tile">
          <span>Server</span>
          <strong className={h.server.ok ? "ok" : "bad"}>{h.server.ok ? "Running" : "Down"}</strong>
          <small>up {Math.round(h.server.uptimeS / 60)} min · Node {h.server.node}</small>
        </div>
        <div className="tile">
          <span>Active sessions</span>
          <strong>{h.activeSessions}</strong>
        </div>
        <div className="tile">
          <span>Attempts in progress</span>
          <strong>{h.attemptsInProgress}</strong>
        </div>
        <div className="tile">
          <span>Live connections</span>
          <strong>{h.liveConnections}</strong>
        </div>
        <div className="tile">
          <span>Database size</span>
          <strong>{(h.storage.databaseBytes / 1024 / 1024).toFixed(1)} MB</strong>
        </div>
        <div className="tile">
          <span>Last backup</span>
          <strong className={backupAgeH !== null && backupAgeH < 26 ? "ok" : "bad"}>{h.lastBackup ? new Date(h.lastBackup).toLocaleString() : "None recorded"}</strong>
          <small>{backupAgeH !== null && backupAgeH >= 26 ? "Older than a day — check the backup job" : "Daily backups expected"}</small>
        </div>
      </div>
    </>
  );
}
