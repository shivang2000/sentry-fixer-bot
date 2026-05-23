#!/usr/bin/env bash
# Daily postgres backup → S3 with date-prefixed key.
# Triggered by alertforge-backup.timer. Reads DATABASE_URL + S3_BUCKET from
# /etc/alertforge/env (sourced by systemd EnvironmentFile=).

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL not set}"
: "${S3_BUCKET:?S3_BUCKET not set}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
KEY="db-backups/${STAMP}.sql.gz"
TMP="/tmp/alertforge-backup-${STAMP}.sql.gz"

pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$TMP"

aws s3 cp "$TMP" "s3://${S3_BUCKET}/${KEY}"
rm -f "$TMP"

echo "backup uploaded: s3://${S3_BUCKET}/${KEY}"
