#!/usr/bin/env bash
# Parity harness runner. Requires the qparking_backend container (Repo B) up.
set -euo pipefail
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1   # no-op off Git-Bash-for-Windows
CONTAINER="${QPARKING_BACKEND_CONTAINER:-qparking_backend}"
TZ_PARITY="${TZ_PARITY:-Asia/Kuala_Lumpur}"

echo "=== curated scenarios ==="
docker cp scenarios.json "$CONTAINER:/tmp/scenarios.json"
docker cp ref_cloud.php  "$CONTAINER:/tmp/ref_cloud.php"
docker exec "$CONTAINER" php /tmp/ref_cloud.php /tmp/scenarios.json > cloud.json
TZ="$TZ_PARITY" node ref_local.mjs scenarios.json > local.json
node compare.mjs scenarios.json cloud.json local.json

echo
echo "=== fuzz (1000) ==="
node gen_fuzz.mjs 1000 > scenarios.fuzz.json
docker cp scenarios.fuzz.json "$CONTAINER:/tmp/scenarios.fuzz.json"
docker exec "$CONTAINER" php /tmp/ref_cloud.php /tmp/scenarios.fuzz.json > cloud.fuzz.json
TZ="$TZ_PARITY" node ref_local.mjs scenarios.fuzz.json > local.fuzz.json
node compare_quiet.mjs scenarios.fuzz.json cloud.fuzz.json local.fuzz.json
