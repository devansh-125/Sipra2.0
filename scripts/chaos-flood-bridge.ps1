# chaos-flood-bridge.ps1
#
# PowerShell mirror of chaos-flood-bridge.sh for Windows users.
# Simulates a flooded bridge stalling the ambulance at a fixed GPS position for
# 60 seconds while the golden-hour deadline ticks down, forcing the Risk Monitor
# to predict a breach and dispatch a drone.
#
# Requires: PowerShell 5.1+  (curl / jq are NOT needed — uses Invoke-RestMethod)

[CmdletBinding()]
param(
    [string]$BackendUrl  = ($env:BACKEND_URL ?? "http://localhost:8080"),
    [int]   $FloodSecs   = 60,
    [int]   $PollSecs    = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Banner([string]$Text, [ConsoleColor]$Bg = "Red", [ConsoleColor]$Fg = "White") {
    $pad = " " * 4
    $line = " " * ($Text.Length + 8)
    Write-Host $line           -BackgroundColor $Bg -ForegroundColor $Fg
    Write-Host "$pad$Text$pad" -BackgroundColor $Bg -ForegroundColor $Fg
    Write-Host $line           -BackgroundColor $Bg -ForegroundColor $Fg
}

function Write-Step([string]$Text) {
    $bar = "-" * 53
    Write-Host ""
    Write-Host "+$bar+" -ForegroundColor Cyan
    Write-Host "|  $($Text.PadRight(51))|" -ForegroundColor Cyan
    Write-Host "+$bar+" -ForegroundColor Cyan
}

function Write-Ok([string]$Text)   { Write-Host "  [OK]  $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "        $Text" -ForegroundColor DarkGray }
function Write-Warn([string]$Text) { Write-Host "  [!!]  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  [!!]  $Text" -ForegroundColor Red; exit 1 }

# ── Config ────────────────────────────────────────────────────────────────────
$Api       = "$BackendUrl/api/v1"
$StuckLat  = 12.5129   # ~50 km south of destination — guaranteed ETA breach
$StuckLng  = 77.6201
$DestLat   = 12.9629
$DestLng   = 77.6201

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Banner "  SIPRA CHAOS  --  FLOODED BRIDGE SIMULATION  " -Bg DarkRed -Fg White
Write-Host ""
Write-Host "  Scenario : Bridge flooded -- ambulance cannot move"         -ForegroundColor DarkGray
Write-Host "  Effect   : GPS stuck at ($StuckLat, $StuckLng) for ${FloodSecs}s" -ForegroundColor DarkGray
Write-Host "  Goal     : Force Risk Monitor -> AI brain -> DroneHandoff"  -ForegroundColor DarkGray
Write-Host ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
Write-Step "0 / 5   PRE-FLIGHT CHECKS"

try {
    $null = Invoke-WebRequest -Uri "$BackendUrl/health" -UseBasicParsing -TimeoutSec 3
    Write-Ok "Go backend reachable (:8080)"
} catch {
    Write-Warn "Go backend health check failed -- ensure 'go run ./cmd/server' is running"
    Write-Info "Continuing anyway..."
}

# Deadline: 2 minutes from now — tight enough to guarantee a breach
$Deadline = (Get-Date).ToUniversalTime().AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ssZ")
Write-Ok "Deadline computed: $Deadline"

# ── Step 1: Create trip ───────────────────────────────────────────────────────
Write-Step "1 / 5   CREATE TRIP"
Write-Info "cargo:    organ (Heart -- chaos flood bridge demo)"
Write-Info "deadline: $Deadline  (2 min from now)"

$CreateBody = @{
    cargo_category      = "organ"
    cargo_description   = "Heart -- chaos flood bridge demo"
    origin              = @{ lat = $StuckLat; lng = $StuckLng }
    destination         = @{ lat = $DestLat;  lng = $DestLng  }
    golden_hour_deadline = $Deadline
    ambulance_id         = "AMB-FLOOD-01"
    hospital_dispatch_id = "HOSP-CHAOS-01"
} | ConvertTo-Json -Depth 3

try {
    $CreateResp = Invoke-RestMethod -Method Post -Uri "$Api/trips" `
        -ContentType "application/json" -Body $CreateBody
} catch {
    Write-Fail "POST /api/v1/trips failed -- is the Go backend running on :8080?`n$_"
}

$TripId = $CreateResp.trip_id
if (-not $TripId) { Write-Fail "No trip_id in response: $($CreateResp | ConvertTo-Json)" }

Write-Ok "trip_id: $TripId"

# ── Step 2: Start trip ────────────────────────────────────────────────────────
Write-Step "2 / 5   START TRIP  (Pending -> InTransit)"

try {
    $StartResp = Invoke-RestMethod -Method Post -Uri "$Api/trips/$TripId/start" `
        -ContentType "application/json" -Body "{}"
} catch {
    Write-Fail "POST /api/v1/trips/$TripId/start failed: $_"
}

Write-Ok "status: $($StartResp.status)"
Write-Info "Risk Monitor will evaluate this trip on its next poll cycle"

# ── Countdown ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  BRIDGE FLOODED -- deploying stuck pings in..." `
    -BackgroundColor DarkYellow -ForegroundColor Black
Write-Host ""
foreach ($i in 3, 2, 1) {
    Write-Host "     $i..." -ForegroundColor Yellow
    Start-Sleep -Seconds 1
}
Write-Host "     FLOOD ACTIVE -- ambulance is STUCK" -ForegroundColor Red
Write-Host ""

# ── Step 3: Flood loop ────────────────────────────────────────────────────────
Write-Step "3 / 5   FLOOD LOOP  (${FloodSecs}s)"
Write-Info "Sending pings every second at stuck position ($StuckLat, $StuckLng)"
Write-Info "speed_kph=0 -- zero movement for $FloodSecs consecutive seconds"
Write-Host ""

$PingBody  = @{ lat = $StuckLat; lng = $StuckLng; speed_kph = 0 } | ConvertTo-Json
$EndTime   = (Get-Date).AddSeconds($FloodSecs)
$PingCount = 0
$Errors    = 0

while ((Get-Date) -lt $EndTime) {
    $Remaining = [int]($EndTime - (Get-Date)).TotalSeconds

    try {
        $null = Invoke-RestMethod -Method Post -Uri "$Api/trips/$TripId/pings" `
            -ContentType "application/json" -Body $PingBody
        $PingCount++
        Write-Host -NoNewline "`r  [+] ping #$($PingCount.ToString().PadRight(4))  ($StuckLat, $StuckLng)  spd:0  remaining: ${Remaining}s   "
    } catch {
        $Errors++
        $PingCount++
        Write-Host -NoNewline "`r  [!] ping #$($PingCount.ToString().PadRight(4))  ERR  remaining: ${Remaining}s   " `
            -ForegroundColor Red
    }

    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host ""
Write-Ok "$PingCount pings sent ($Errors error(s))"
Write-Ok "Ambulance was stationary for ${FloodSecs}s -- AI brain will see massive ETA overshoot"
Write-Info "Flush ticker drains Redis -> Postgres every 5 s"
Write-Info "Risk Monitor polls every 10 s, then calls AI brain -> expects will_breach: true"

# ── Step 4: Poll for DroneHandoff ─────────────────────────────────────────────
Write-Step "4 / 5   POLLING FOR DRONEHANDOFF  (up to ${PollSecs}s)"
Write-Info "Waiting for Risk Monitor to flip trip to DroneHandoff..."
Write-Host ""

$PollEnd       = (Get-Date).AddSeconds($PollSecs)
$CurrentStatus = "InTransit"
$Dots          = 0

while ((Get-Date) -lt $PollEnd) {
    $SecsLeft = [int]($PollEnd - (Get-Date)).TotalSeconds
    $DotStr   = "." * (($Dots % 3) + 1)

    try {
        $TripResp      = Invoke-RestMethod -Uri "$Api/trips/$TripId"
        $CurrentStatus = if ($TripResp.status)      { $TripResp.status }
                         elseif ($TripResp.trip_status) { $TripResp.trip_status }
                         else                           { "unknown" }
    } catch {
        # transient — keep polling
    }

    Write-Host -NoNewline "`r  polling$($DotStr.PadRight(4))  status: $($CurrentStatus.PadRight(16))  budget: ${SecsLeft}s   "
    $Dots++

    if ($CurrentStatus -eq "DroneHandoff") {
        Write-Host ""
        Write-Host ""
        Write-Ok "DroneHandoff detected!  Risk Monitor fired the drone dispatch."
        break
    }

    Start-Sleep -Seconds 3
}

Write-Host ""

# ── Step 5: Final status ──────────────────────────────────────────────────────
Write-Step "5 / 5   FINAL TRIP STATUS"
Write-Host ""

try {
    $Final = Invoke-RestMethod -Uri "$Api/trips/$TripId"
    $Final | ConvertTo-Json -Depth 5
} catch {
    Write-Warn "Could not fetch final trip status: $_"
}

Write-Host ""

# ── Result ────────────────────────────────────────────────────────────────────
if ($CurrentStatus -eq "DroneHandoff") {
    Write-Host "  CHAOS DEMO PASSED" -BackgroundColor DarkGreen -ForegroundColor White
    Write-Host "  Flooded bridge -> Risk Monitor -> DroneHandoff  [OK]" `
        -BackgroundColor DarkGreen -ForegroundColor White
    Write-Host ""
    Write-Info "Check the dashboard at http://localhost:3000 for the HandoffBanner"
    Write-Info "Drone dispatch log: Invoke-RestMethod http://localhost:4003/calls"
    Write-Host ""
    exit 0
} else {
    Write-Host "  Trip is '$CurrentStatus' -- handoff may still be in-flight" `
        -BackgroundColor DarkYellow -ForegroundColor Black
    Write-Host ""
    Write-Warn "The Risk Monitor polls every 10 s and the flush ticker runs every 5 s."
    Write-Info "Allow another 20 s then re-check:"
    Write-Info "  Invoke-RestMethod $Api/trips/$TripId | ConvertTo-Json"
    Write-Host ""
    Write-Info "If status never changes, verify these services are running:"
    Write-Info "  Go core API    :8080  (go run ./cmd/server)"
    Write-Info "  AI brain       :8000  (uvicorn app.main:app --port 8000)"
    Write-Info "  Drone dispatch :4003  (node services/mocks/drone-dispatch/index.js)"
    Write-Host ""
    exit 1
}
