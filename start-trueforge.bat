@echo off
set OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]
set NODE_OPTIONS=--dns-result-order=ipv4first
echo Starting TrueForge on http://localhost:8790 with OUTBOUND_URL_ALLOWED_HOSTS=%OUTBOUND_URL_ALLOWED_HOSTS%
npx @truefoundry/trueforge@latest
