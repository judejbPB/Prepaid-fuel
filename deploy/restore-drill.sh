#!/usr/bin/env sh
# Restore drill: proves the off-site copy works without touching the live database.
# Restores the latest Litestream copy to a scratch file in the data volume, checks it (integrity, ledger
# balances, record counts) and deletes it. Run monthly, and after any change to storage keys or buckets.
#   cd deploy && ./restore-drill.sh
set -eu
cd "$(dirname "$0")"
DRILL=/data/restore-drill.db
echo "1/3 Restoring the latest off-site copy…"
docker compose run --rm --no-deps --entrypoint sh litestream -c \
  "rm -f $DRILL $DRILL-wal $DRILL-shm && litestream restore -config /etc/litestream.yml -o $DRILL /data/bousol.db"
echo "2/3 Checking the restored copy…"
status=0
docker compose exec -T app node_modules/.bin/tsx server/src/verify-db.ts "$DRILL" || status=$?
echo "3/3 Removing the scratch copy…"
docker compose exec -T app rm -f "$DRILL" "$DRILL-wal" "$DRILL-shm"
if [ "$status" -eq 0 ]; then echo "Restore drill passed."; else echo "Restore drill FAILED: see the report above."; fi
exit "$status"
