# Apply the diagnostic fixes from this session and run end-to-end smoke tests.
# Run from repo root: .\scripts\apply-fixes-and-test.ps1

$ErrorActionPreference = "Stop"

Write-Host "==> 1. Recreating ai-brain (picks up AI_AUTH_REQUIRED=false)" -ForegroundColor Cyan
docker compose up -d --no-deps --force-recreate ai-brain

Write-Host "==> 2. Rebuilding web image (new scenario route + bounty progression + 204 fallback)" -ForegroundColor Cyan
docker compose build web

Write-Host "==> 3. Recreating web container with new image" -ForegroundColor Cyan
docker compose up -d --no-deps --force-recreate web

Write-Host "==> 4. Waiting for both to come up..." -ForegroundColor Cyan
Start-Sleep -Seconds 8

Write-Host "==> 5. Verifying ai-brain auth is off" -ForegroundColor Cyan
$auth = docker exec sipra-ai-brain printenv AI_AUTH_REQUIRED 2>$null
Write-Host "    AI_AUTH_REQUIRED=$auth"
$probe = curl.exe -s -o nul -w "%{http_code}" -X POST http://localhost:8000/decide `
  -H "Content-Type: application/json" `
  -d '{"trip_id":"00000000-0000-4000-8000-000000000001","origin":{"lat":12.96,"lng":77.64},"destination":{"lat":13.34,"lng":77.10},"current_position":{"lat":12.96,"lng":77.64},"current_speed_kph":40,"deadline_seconds_remaining":3600,"fleet_density":0,"weather":"clear","cargo_category":"organ"}'
Write-Host "    /decide HTTP $probe (200/422 = good, 401 = auth still on)"

Write-Host ""
Write-Host "==> 6. Smoke-test: run s3-drone-handoff" -ForegroundColor Cyan
$resp = curl.exe -s -X POST http://localhost:3000/api/scenarios/run `
  -H "Content-Type: application/json" `
  -d '{\"scenario\":\"s3-drone-handoff\"}'
Write-Host "    response: $resp"

Write-Host ""
Write-Host "==> 7. Tailing core-go for 35 s — watch for risk:/decide success and HANDOFF_INITIATED" -ForegroundColor Cyan
$job = Start-Job { docker logs sipra-core-go --tail 0 -f }
Start-Sleep -Seconds 35
Stop-Job $job | Out-Null
$lines = Receive-Job $job | Select-String -Pattern "risk:|/decide|handoff|drone|HANDOFF" | Select-Object -First 25
$lines | ForEach-Object { Write-Host "    $_" }
Remove-Job $job | Out-Null

Write-Host ""
Write-Host "==> 8. Bounty state in Postgres" -ForegroundColor Cyan
docker exec sipra-postgres psql -U sipra -d sipra -c "SELECT status::text, COUNT(*) FROM bounties WHERE created_at > NOW() - INTERVAL '5 min' GROUP BY status::text ORDER BY 1;"

Write-Host ""
Write-Host "==> Done. Open http://localhost:3000/dashboard, click Run Scenario." -ForegroundColor Green
