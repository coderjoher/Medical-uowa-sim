#!/usr/bin/env bash
# Daily database backup with retention. Case JSON, results and action logs all live in the
# database; models and app files are rebuilt from the repository.
set -euo pipefail
BACKUP_HOUR="${BACKUP_HOUR:-2}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

backup() {
  local file="/backups/sim-$(date -u +%Y%m%d-%H%M%S).dump"
  pg_dump --format=custom --file="$file.partial"
  mv "$file.partial" "$file"
  # Check the dump is readable before calling it a success.
  pg_restore --list "$file" > /dev/null
  date -u +%Y-%m-%dT%H:%M:%SZ > /backups/last-success
  find /backups -name 'sim-*.dump' -mtime "+$RETENTION_DAYS" -delete
  echo "backup ok: $file"
}

[ "${1:-}" = "now" ] && { backup; exit 0; }
[ -f /backups/last-success ] || backup
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  sleep $((next - now))
  backup || echo "backup FAILED at $(date -u)" >&2
done
