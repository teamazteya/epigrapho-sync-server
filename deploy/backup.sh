#!/usr/bin/env bash
# Nightly backup of the Epigrapho sync server to Oracle Object Storage
# (bucket epigrapho-backups, S3-compatible API):
#   daily/<date>/mongo.archive.gz   mongodump of identity + notesnook
#   daily/<date>/config.tar.gz      .env, garage.toml, dp-keys, compose, Caddyfile
#   weekly/<date>/                  Sunday's daily copy
#   attachments/                    mirror of Garage's "attachments" bucket
# Keeps 7 days of dailies and 4 weeks of weeklies. On failure it emails
# BACKUP_ALERT_EMAIL through the same SMTP the server uses.
# ponytail: attachments are a plain mirror, so an attachment deleted today is
# gone from the backup tonight; add --backup-dir if that ever matters.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a

NS=axn84pxet3pa
REGION=mx-queretaro-1
BUCKET=epigrapho-backups
day=$(date -u +%F)

alert() {
  python3 - "$1" <<'PY' || true
import os, smtplib, sys
from email.message import EmailMessage
m = EmailMessage()
m["From"] = os.environ["NOTESNOOK_SENDER_EMAIL"]
m["To"] = os.environ["BACKUP_ALERT_EMAIL"]
m["Subject"] = "Falló el respaldo del servidor de Epigrapho"
m.set_content("El respaldo nocturno falló en la línea " + sys.argv[1] + ".\n\nRevisa en la VM: journalctl -u epigrapho-backup -n 100\n")
s = smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"]), timeout=30)
s.starttls(); s.login(os.environ["SMTP_USERNAME"], os.environ["SMTP_PASSWORD"]); s.send_message(m); s.quit()
PY
}
trap 'alert $LINENO' ERR

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

docker compose exec -T notesnook-db mongodump --archive --gzip --quiet > "$tmp/mongo.archive.gz"
tar -czf "$tmp/config.tar.gz" .env garage.toml dp-keys docker-compose.yml Caddyfile

rc() {
  docker run --rm --network epigrapho_epigrapho -v "$tmp:/work" \
    -e RCLONE_CONFIG_OCI_TYPE=s3 -e RCLONE_CONFIG_OCI_PROVIDER=Other \
    -e RCLONE_CONFIG_OCI_ENDPOINT="https://$NS.compat.objectstorage.$REGION.oraclecloud.com" \
    -e RCLONE_CONFIG_OCI_REGION="$REGION" -e RCLONE_CONFIG_OCI_FORCE_PATH_STYLE=true \
    -e RCLONE_CONFIG_OCI_ACCESS_KEY_ID="$BACKUP_S3_KEY_ID" -e RCLONE_CONFIG_OCI_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET" \
    -e RCLONE_CONFIG_OCI_NO_CHECK_BUCKET=true \
    -e RCLONE_CONFIG_GARAGE_TYPE=s3 -e RCLONE_CONFIG_GARAGE_PROVIDER=Other \
    -e RCLONE_CONFIG_GARAGE_ENDPOINT=http://notesnook-s3:3900 -e RCLONE_CONFIG_GARAGE_REGION=us-east-1 \
    -e RCLONE_CONFIG_GARAGE_FORCE_PATH_STYLE=true \
    -e RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="$S3_KEY_ID" -e RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="$S3_SECRET" \
    rclone/rclone:1.71.1 "$@"
}

rc copy /work "oci:$BUCKET/daily/$day"
if [ "$(date -u +%u)" = 7 ]; then rc copy "oci:$BUCKET/daily/$day" "oci:$BUCKET/weekly/$day"; fi
rc sync garage:attachments "oci:$BUCKET/attachments"
rc delete --min-age 7d "oci:$BUCKET/daily"
rc delete --min-age 28d "oci:$BUCKET/weekly"

echo "Respaldo $day listo: $(du -h "$tmp/mongo.archive.gz" | cut -f1) de MongoDB"
