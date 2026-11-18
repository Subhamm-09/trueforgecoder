# Start TrueForge locally with localhost allowlisted for the VS Code Editor MCP server
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["localhost","127.0.0.1"]'
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'
Write-Host "Starting TrueForge on http://localhost:8790 with OUTBOUND_URL_ALLOWED_HOSTS=$env:OUTBOUND_URL_ALLOWED_HOSTS"
npx.cmd @truefoundry/trueforge@latest
