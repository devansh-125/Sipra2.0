#!/usr/bin/env bash
# chaos-flood-bridge.sh
#
# Simulates a flooded bridge that stalls the ambulance at a fixed GPS position
# for 60 seconds while the golden-hour deadline ticks down.  The stuck pings
# flush into Postgres, the Risk Monitor calls the AI brain, detects an ETA
# breach, and transitions the trip to DroneHandoff.
#
# Requires: curl  jq  (GNU date or python3 for RFC3339 deadline arithmetic)

set -euo pipefail

# ── ANSI palette ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
CYN='\033[0;36m'
MAG='\033[0;35m'
BLD='\033[1m'
DIM='\033[2m'
RST='\033[0m'
REDBG='\033[41;37;1m'
YLWBG='\033[43;30;1m'
GRNBG='\033[42;30;1m'

# ── Config ────────────────────────────────────────────────────────────────────
API="${BACKEND_URL:-http://localhost:8080}/api/v1"
# Bangalore south — 50 km from destination, guarantees AI brain predicts breach
STUCK_LAT=12.5129
STUCK_LNG=77.6201
DEST_LAT=12.9629
DEST_LNG=77.6201
FLOOD_SECS=60   # how long the ambulance sits "stuck" at the bridge
POLL_SECS=60    # budget to wait for DroneHandoff after flooding ends

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo -e "\n${RED}${BLD}✗  $*${RST}" >&2; exit 1; }
step() {
  local pad="─────────────────────────────────────────────────────"
  echo -e "\n${BLD}${CYN}┌${pad}┐${RST}"
  printf "${BLD}${CYN}│  %-51s│${RST}\n" "$*"
  echo -e "${BLD}${CYN}└${pad}┘${RST}"
}
ok()    { echo -e "  ${GRN}${BLD}✓${RST}  $*"; }
info()  { echo -e "  ${DIM}$*${RST}"; }
warn()  { echo -e "  ${YEL}${BLD}⚠${RST}  $*"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e ""
echo -e "${REDBG}                                                       ${RST}"
echo -e "${REDBG}   🌊  SIPRA CHAOS — FLOODED BRIDGE SIMULATION  🌊    ${RST}"
echo -e "${REDBG}                                                       ${RST}"
echo -e ""
echo -e "  ${DIM}Scenario : Bridge flooded — ambulance cannot move${RST}"
echo -e "  ${DIM}Effect   : GPS stuck at (${STUCK_LAT}, ${STUCK_LNG}) for ${FLOOD_SECS}s${RST}"
echo -e "  ${DIM}Goal     : Force Risk Monitor → AI brain → DroneHandoff${RST}"
echo -e ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
step "0 / 5   PRE-FLIGHT CHECKS"

for cmd in curl jq; do
  command -v "$cmd" &>/dev/null \
    && ok "${cmd} found" \
    || die "required tool not found: ${cmd}  —  install it first"
done

HTTP_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" \
  "${BACKEND_URL:-http://localhost:8080}/health" 2>/dev/null || echo "000")
if [[ "$HTTP_HEALTH" == "200" ]]; then
  ok "Go backend reachable (:8080)"
else
  warn "Go backend health returned ${HTTP_HEALTH} — make sure 'go run ./cmd/server' is running"
  info "Continuing anyway…"
fi

# ── Deadline: 2 minutes from now (tight — guaranteed golden-hour breach) ──────
DEADLINE=$(date -u -d '+2 minutes' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
  python3 -c \
    "from datetime import datetime,timezone,timedelta
print((datetime.now(timezone.utc)+timedelta(minutes=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))" \
  2>/dev/null) || die "need GNU date or python3 to compute RFC3339 deadline"

ok "deadline computed: ${BLD}${MAG}${DEADLINE}${RST}"

# ── Step 1: Create trip ───────────────────────────────────────────────────────
step "1 / 5   CREATE TRIP"
info "cargo: organ (Heart — chaos flood bridge demo)"
info "deadline: ${DEADLINE}  (2 min from now)"

CREATE_RESP=$(curl -sf -X POST "${API}/trips" \
  -H 'Content-Type: application/json' \
  -d "{
    \"cargo_category\":      \"organ\",
    \"cargo_description\":   \"Heart — chaos flood bridge demo\",
    \"origin\":              { \"lat\": ${STUCK_LAT}, \"lng\": ${STUCK_LNG} },
    \"destination\":         { \"lat\": ${DEST_LAT},  \"lng\": ${DEST_LNG}  },
    \"golden_hour_deadline\": \"${DEADLINE}\",
    \"ambulance_id\":         \"AMB-FLOOD-01\",
    \"hospital_dispatch_id\": \"HOSP-CHAOS-01\"
  }") || die "POST /api/v1/trips failed — is the Go backend running on :8080?"

TRIP_ID=$(echo "$CREATE_RESP" | jq -r '.trip_id')
[[ -z "$TRIP_ID" || "$TRIP_ID" == "null" ]] && die "no trip_id in response: ${CREATE_RESP}"

ok "trip_id: ${BLD}${MAG}${TRIP_ID}${RST}"

# ── Step 2: Start trip ────────────────────────────────────────────────────────
step "2 / 5   START TRIP  (Pending → InTransit)"

START_RESP=$(curl -sf -X POST "${API}/trips/${TRIP_ID}/start" \
  -H 'Content-Type: application/json') \
  || die "POST /api/v1/trips/${TRIP_ID}/start failed"

STATUS=$(echo "$START_RESP" | jq -r '.status')
ok "status: ${BLD}${GRN}${STATUS}${RST}"
info "Risk Monitor will now evaluate this trip on its next poll cycle"

# ── Countdown ─────────────────────────────────────────────────────────────────
echo -e ""
echo -e "  ${YLWBG}  BRIDGE FLOODED — deploying stuck pings in…  ${RST}"
echo -e ""
for i in 3 2 1; do
  echo -e "  ${BLD}${YEL}  ${i}…${RST}"
  sleep 1
done
echo -e "  ${BLD}${RED}  🌊  FLOOD ACTIVE — ambulance is STUCK  🌊${RST}"
echo -e ""

# ── Step 3: Flood loop ────────────────────────────────────────────────────────
step "3 / 5   FLOOD LOOP  (${FLOOD_SECS}s)"
info "Sending pings every second at stuck position (${STUCK_LAT}, ${STUCK_LNG})"
info "speed_kph=0 — zero movement for ${FLOOD_SECS} consecutive seconds"
echo -e ""

END_TS=$(( $(date +%s) + FLOOD_SECS ))
PING_COUNT=0
ERRORS=0

while [[ $(date +%s) -lt $END_TS ]]; do
  REMAINING=$(( END_TS - $(date +%s) ))

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API}/trips/${TRIP_ID}/pings" \
    -H 'Content-Type: application/json' \
    -d "{\"lat\": ${STUCK_LAT}, \"lng\": ${STUCK_LNG}, \"speed_kph\": 0}" \
    2>/dev/null) || HTTP_CODE="000"

  PING_COUNT=$(( PING_COUNT + 1 ))

  if [[ "$HTTP_CODE" == "202" ]]; then
    printf "\r  ${GRN}●${RST} ping #%-4d  ${DIM}(${STUCK_LAT}, ${STUCK_LNG})  spd: 0 kph${RST}  ⏱  ${YEL}%3ds left${RST}   " \
      "$PING_COUNT" "$REMAINING"
  else
    ERRORS=$(( ERRORS + 1 ))
    printf "\r  ${RED}✗${RST} ping #%-4d  HTTP %-3s  ⏱  ${YEL}%3ds left${RST}   " \
      "$PING_COUNT" "$HTTP_CODE" "$REMAINING"
  fi

  sleep 1
done

echo -e "\n"
ok "${PING_COUNT} pings sent  (${ERRORS} error(s))"
ok "Ambulance was stationary for ${FLOOD_SECS}s — AI brain will see massive ETA overshoot"
info "Flush ticker drains Redis → Postgres every 5 s"
info "Risk Monitor polls every 10 s, then calls AI brain → expects will_breach: true"

# ── Step 4: Poll for DroneHandoff ─────────────────────────────────────────────
step "4 / 5   POLLING FOR DRONEHANDOFF  (up to ${POLL_SECS}s)"
info "Waiting for Risk Monitor to flip trip to DroneHandoff…"
echo -e ""

POLL_END=$(( $(date +%s) + POLL_SECS ))
CURRENT_STATUS="InTransit"
DOTS=0

while [[ $(date +%s) -lt $POLL_END ]]; do
  TRIP_RESP=$(curl -sf "${API}/trips/${TRIP_ID}" 2>/dev/null) || { sleep 3; continue; }
  CURRENT_STATUS=$(echo "$TRIP_RESP" | jq -r '.status // .trip_status // "unknown"')
  SECS_LEFT=$(( POLL_END - $(date +%s) ))

  # Animated dot cycle
  DOT_STR=$(printf '%0.s.' $(seq 1 $(( (DOTS % 3) + 1 ))))
  printf "\r  ${DIM}polling%-3s  status: %-16s  budget: %3ds${RST}   " \
    "$DOT_STR" "$CURRENT_STATUS" "$SECS_LEFT"
  DOTS=$(( DOTS + 1 ))

  if [[ "$CURRENT_STATUS" == "DroneHandoff" ]]; then
    echo -e "\n"
    ok "${BLD}${MAG}DroneHandoff detected!${RST}  Risk Monitor fired the drone dispatch."
    break
  fi

  sleep 3
done

echo -e ""

# ── Step 5: Final status ──────────────────────────────────────────────────────
step "5 / 5   FINAL TRIP STATUS"
echo -e ""

FINAL=$(curl -sf "${API}/trips/${TRIP_ID}") \
  || die "GET /api/v1/trips/${TRIP_ID} failed — cannot fetch final status"

echo "$FINAL" | jq .
echo -e ""

# ── Result ────────────────────────────────────────────────────────────────────
if [[ "$CURRENT_STATUS" == "DroneHandoff" ]]; then
  echo -e "${GRNBG}                                                      ${RST}"
  echo -e "${GRNBG}   ✅  CHAOS DEMO PASSED                              ${RST}"
  echo -e "${GRNBG}   Flooded bridge → Risk Monitor → DroneHandoff ✓    ${RST}"
  echo -e "${GRNBG}                                                      ${RST}"
  echo -e ""
  info "Check the dashboard at http://localhost:3000 for the HandoffBanner"
  info "Drone dispatch log:  curl -s http://localhost:4003/calls | jq ."
  echo -e ""
  exit 0
else
  echo -e "${YLWBG}  ⚠  Trip is '${CURRENT_STATUS}' — handoff may still be in-flight  ${RST}"
  echo -e ""
  warn "The Risk Monitor polls every 10 s and the flush ticker runs every 5 s."
  info "Allow another 20 s then re-check:"
  echo -e "  ${DIM}curl -s ${API}/trips/${TRIP_ID} | jq .${RST}"
  echo -e ""
  echo -e "  ${DIM}If status never changes, verify these services are running:${RST}"
  echo -e "  ${DIM}  • Go core API     :8080  (go run ./cmd/server)${RST}"
  echo -e "  ${DIM}  • AI brain        :8000  (uvicorn app.main:app --port 8000)${RST}"
  echo -e "  ${DIM}  • Drone dispatch  :4003  (node services/mocks/drone-dispatch/index.js)${RST}"
  echo -e ""
  exit 1
fi
