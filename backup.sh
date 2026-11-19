#!/usr/bin/env bash
# Nightly SalonBook backup, run by cron. See "Backups" in README.md for setup and restore.
#
#  1. A consistent snapshot of the database (safe while the app runs), integrity-checked and gzipped.
#  2. Copies of .env, .data_key (unlocks the encrypted secrets in the database) and .session_secret.
#  3. If Google Drive is connected (an rclone remote named "gdrive"): all of the above is encrypted into one
#     file with the passphrase in ~/.config/salonbook/backup-pass and uploaded to SalonBook-backups/ on Drive.
#
# Local copies are kept 30 days, Drive copies 60 days. The result of step 3 goes in $DEST/offsite-status
# ("<time> ok|failed|skipped <detail>"), which the Platform page shows.
set -euo pipefail
umask 077

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${BACKUP_DIR:-$(dirname "$SRC")/salonbook-backups}"
RCLONE="${RCLONE:-$HOME/.local/bin/rclone}"
REMOTE="${BACKUP_REMOTE:-gdrive:SalonBook-backups}"
PASSFILE="${BACKUP_PASSFILE:-$HOME/.config/salonbook/backup-pass}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"

mkdir -p "$DEST"
chmod 700 "$DEST"

# 1. Database
sqlite3 "$SRC/salonbook.db" ".backup '$DEST/salonbook-$STAMP.db'"
sqlite3 "$DEST/salonbook-$STAMP.db" "pragma integrity_check;" | grep -qx ok
gzip "$DEST/salonbook-$STAMP.db"

# 2. Settings and keys
FILES=("salonbook-$STAMP.db.gz")
cp "$SRC/.env" "$DEST/env-$STAMP" && FILES+=("env-$STAMP")
for f in data_key session_secret; do
  if [ -f "$SRC/.$f" ]; then cp "$SRC/.$f" "$DEST/$f-$STAMP"; FILES+=("$f-$STAMP"); fi
done
find "$DEST" -type f \( -name 'salonbook-*.db.gz' -o -name 'env-*' -o -name 'data_key-*' -o -name 'session_secret-*' \) -mtime +30 -delete
echo "$(date '+%F %T') local backup ok: ${FILES[*]}"

# 3. Encrypted copy on Google Drive
status() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" > "$DEST/offsite-status"; }
if [ ! -x "$RCLONE" ] || ! "$RCLONE" listremotes 2>/dev/null | grep -qx "${REMOTE%%:*}:"; then
  status skipped "Google Drive is not connected yet (run: rclone config)"
  echo "off-site copy skipped: no rclone remote ${REMOTE%%:*}"
  exit 0
fi
if [ ! -s "$PASSFILE" ]; then
  status failed "backup passphrase file missing"
  echo "off-site copy failed: no passphrase at $PASSFILE" >&2
  exit 1
fi

BUNDLE="$DEST/salonbook-$STAMP.tar.gpg"
trap 'rm -f "$BUNDLE"' EXIT
tar -C "$DEST" -cf - "${FILES[@]}" \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o "$BUNDLE"

if ERR="$("$RCLONE" copy "$BUNDLE" "$REMOTE" --log-level ERROR 2>&1)"; then
  "$RCLONE" delete "$REMOTE" --min-age 60d --include 'salonbook-*.tar.gpg' --log-level ERROR || true
  status ok "$(basename "$BUNDLE")"
  echo "off-site copy ok: $(basename "$BUNDLE")"
else
  status failed "$(echo "$ERR" | tr '\n' ' ' | cut -c1-200)"
  echo "off-site copy failed: $ERR" >&2
  exit 1
fi
