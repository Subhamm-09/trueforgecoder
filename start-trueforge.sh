#!/usr/bin/env bash
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
echo "Starting TrueForge on http://localhost:8790 with OUTBOUND_URL_ALLOWED_HOSTS=$OUTBOUND_URL_ALLOWED_HOSTS"
npx @truefoundry/trueforge@latest
