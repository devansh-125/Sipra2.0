# Sipra Testing Guide

Complete guide to testing the Sipra system with dummy data and dynamic test scenarios.

---

## 📊 Current Testing Infrastructure

### ✅ **EXISTING & USEFUL**

#### 1. **Simulation Scripts** (Production-Ready)

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/simulate-gps.ts` | God-mode simulator with 20 fleet vehicles on real Bangalore roads | ✅ **EXCELLENT** |
| `scripts/realtime-ingest.ts` | Streams pre-recorded GPS pings from NDJSON file | ✅ **USEFUL** |
| `scripts/e2e-handoff.ts` | End-to-end test for drone handoff pipeline | ✅ **COMPREHENSIVE** |

**How to use:**
```bash
cd scripts
npm install

# Run god-mode simulator (recommended)
npm run simulate

# Run pre-recorded ping stream
npm run realtime:ingest

# Run e2e handoff test
npm run e2e:handoff
```

#### 2. **Chaos Testing Endpoints** (Stress Testing)

| Endpoint | Purpose | Example |
|----------|---------|---------|
| `POST /api/v1/chaos/flood-bridge` | Inject GPS pings to simulate traffic jam | `{"trip_id": "...", "count": 50}` |
| `POST /api/v1/chaos/spawn-fleet` | Spawn synthetic fleet vehicles | `{"count": 100, "center_lat": 12.96, "center_lng": 77.57, "radius_m": 5000}` |
| `POST /api/v1/chaos/force-handoff` | Bypass AI and force drone handoff | `{"trip_id": "...", "reason": "Manual test"}` |
| `POST /api/v1/chaos/reset` | Clear all chaos state | `{}` |

**How to use:**
```bash
# Flood bridge (PowerShell)
.\scripts\chaos-flood-bridge.ps1

# Flood bridge (Bash)
bash scripts/chaos-flood-bridge.sh

# Or use curl
curl -X POST http://localhost:8080/api/v1/chaos/spawn-fleet \
  -H "Content-Type: application/json" \
  -d '{"count": 50, "center_lat": 12.9656, "center_lng": 77.5713, "radius_m": 3000}'
```

#### 3. **Existing Test Data**

| File | Purpose | Status |
|------|---------|--------|
| `datasets/realtime/trip.json` | Demo trip configuration | ✅ Used by ingest script |
| `datasets/realtime/ambulance-pings.ndjson` | 10 GPS waypoints Victoria → Manipal | ✅ Used by ingest script |
| `datasets/realtime/ai-predict.sample.*.json` | AI brain API contract examples | ⚠️ Reference only |
| `datasets/realtime/drone-dispatch.sample.*.json` | Drone API contract examples | ⚠️ Reference only |

---

## ❌ **WHAT'S MISSING** (Created in this session)

### 1. **UI Test Panel** ✨ NEW

**Current status:** Removed. Use `services/web/components/chaos/ChaosPanel.tsx` plus the scenario scripts instead.

**Features:**
- ✅ One-click test scenario triggers
- ✅ Organized by category (Trip, Corridor, Bounty, Handoff, Chaos)
- ✅ Real-time result feedback
- ✅ No need to write curl commands or scripts

**Test Scenarios Available:**

#### Trip Creation Tests
- 🚑 **Normal Trip** - 60 min golden hour (should NOT breach)
- ⚡ **Urgent Trip** - 10 min golden hour (high breach risk)
- 🔴 **Critical Trip** - 2 min golden hour (WILL breach)

#### Corridor Tests
- 🟢 **Small Corridor** - 500m buffer (tight zone)
- 🔴 **Large Corridor** - 3000m buffer (wide zone)

#### Bounty Tests
- 💰 **Low Bounty** - 100 points base
- 💎 **High Bounty** - 500 points base
- ⏰ **Expired Bounty** - Expires in 5 seconds

#### Handoff Tests
- 🚁 **Force Handoff** - Bypass AI, trigger immediately

#### Chaos Tests
- 🌊 **Flood Bridge** - Inject 50 pings (traffic jam)
- 🚗 **Spawn 10 Vehicles** - Light fleet density
- 🚙 **Spawn 100 Vehicles** - Stress test
- 🔄 **Reset Chaos** - Clear all chaos state

**How to use:**
1. Open the dashboard.
2. Use the Chaos panel for live fault injection.
3. Use `scripts/play-scenario.ts` for repeatable dataset replays.

### 2. **Comprehensive Test Data** ✨ NEW

**Location:** `datasets/test-scenarios/`

#### Trip Scenarios
- `trips/normal.json` - Standard 60-min delivery
- `trips/critical.json` - 2-min guaranteed breach (50km away)
- `trips/multiple-simultaneous.json` - 5 trips at once

#### Future Test Data (Recommended to Create)
- `pings/smooth-route.ndjson` - Clean 40 kph drive
- `pings/traffic-jam.ndjson` - Slow 15 kph crawl
- `pings/erratic.ndjson` - Speed varies 10-80 kph
- `bounties/standard.json` - Normal bounty offer
- `bounties/high-surge.json` - Maximum surge pricing

---

## 🎯 **RECOMMENDED TESTING WORKFLOW**

### For Development

1. **Start all services:**
   ```bash
   docker compose up -d
   cd services/core-go && go run ./cmd/server
   cd services/web && npm run dev
   ```

2. **Run god-mode simulator:**
   ```bash
   cd scripts
   npm run simulate
   ```
   - Opens dashboard at http://localhost:3000
   - Watch 20 vehicles move on real roads
   - See automatic bounty lifecycle
   - Observe corridor updates in real-time

3. **Use UI Test Panel:**
   - Navigate to Admin → Test Panel
   - Click "Critical Trip" to force a breach
   - Click "Spawn 100 Vehicles" for stress test
   - Click "Force Handoff" to test drone dispatch

### For QA Testing

1. **Run e2e test suite:**
   ```bash
   cd scripts
   npm run e2e:handoff
   ```
   Expected output:
   ```
   ✅ All assertions passed — Phase 5 handoff pipeline is working end-to-end.
   ```

2. **Test specific scenarios:**
   ```bash
   # Test critical trip
   SCENARIO=critical npm run test:scenario
   
   # Test multiple simultaneous trips
   SCENARIO=multiple npm run test:scenario
   ```

3. **Chaos testing:**
   ```bash
   # Flood bridge
   bash scripts/chaos-flood-bridge.sh
   
   # Spawn massive fleet
   curl -X POST http://localhost:8080/api/v1/chaos/spawn-fleet \
     -H "Content-Type: application/json" \
     -d '{"count": 200, "center_lat": 12.9656, "center_lng": 77.5713, "radius_m": 5000}'
   ```

### For Demo/Presentation

1. **Start with clean state:**
   ```bash
   curl -X POST http://localhost:8080/api/v1/chaos/reset
   ```

2. **Run god-mode simulator:**
   ```bash
   cd scripts && npm run simulate
   ```

3. **Show specific scenarios via UI:**
   - Open Test Panel
   - Click "Critical Trip" → Watch handoff trigger
   - Click "Spawn 100 Vehicles" → Show fleet rerouting
   - Click "Flood Bridge" → Demonstrate traffic handling

---

## 📋 **TEST COVERAGE MATRIX**

| Feature | Manual Test | Script Test | E2E Test | UI Test | Status |
|---------|-------------|-------------|----------|---------|--------|
| Trip creation | ✅ | ✅ | ✅ | ✅ | **Complete** |
| GPS ping ingestion | ✅ | ✅ | ✅ | ❌ | **Good** |
| Corridor calculation | ✅ | ✅ | ❌ | ❌ | **Needs E2E** |
| AI breach prediction | ✅ | ✅ | ✅ | ❌ | **Good** |
| Drone handoff | ✅ | ✅ | ✅ | ✅ | **Complete** |
| Bounty creation | ✅ | ✅ | ❌ | ✅ | **Needs E2E** |
| Bounty claim | ✅ | ✅ | ❌ | ❌ | **Needs Tests** |
| Bounty verification | ✅ | ✅ | ❌ | ❌ | **Needs Tests** |
| Fleet rerouting | ✅ | ✅ | ❌ | ❌ | **Needs E2E** |
| WebSocket broadcast | ✅ | ✅ | ✅ | ❌ | **Good** |
| Webhook dispatch | ✅ | ❌ | ❌ | ❌ | **Needs Tests** |
| Multiple simultaneous trips | ❌ | ❌ | ❌ | ✅ | **Needs Implementation** |
| Edge cases (invalid GPS, etc.) | ❌ | ❌ | ❌ | ❌ | **Missing** |

---

## 🚀 **NEXT STEPS TO IMPROVE TESTING**

### High Priority

1. **Create Bounty E2E Test**
   ```bash
   # New file: scripts/e2e-bounty.ts
   # Test: Create trip → Enter corridor → Offer bounty → Claim → Verify
   ```

2. **Add Edge Case Tests**
   - Invalid GPS coordinates
   - Duplicate pings
   - Expired bounties
   - Stale pings (1 hour old)

### Medium Priority

4. **Create More Test Data**
   - `pings/traffic-jam.ndjson`
   - `pings/erratic.ndjson`
   - `bounties/batch.json`

5. **Add Test Validation**
   ```bash
   npm run validate:test-data
   ```

6. **Create Test Report Generator**
   - Run all tests
   - Generate HTML report
   - Show pass/fail matrix

### Low Priority

7. **Performance Testing**
   - Load test with 1000 simultaneous trips
   - Stress test with 10,000 fleet vehicles
   - Measure corridor calculation time

8. **Integration Tests**
   - Test webhook delivery to real Uber/Swiggy endpoints
   - Test Google Maps API fallback
   - Test Redis failover

---

## 🐛 **DEBUGGING TIPS**

### Common Issues

**Map doesn't show vehicles:**
- Check fleet simulator is running: `npm run simulate`
- Check WebSocket connection in browser console
- Verify `FLEET_PORT=4001` is accessible

**Handoff doesn't trigger:**
- Check AI brain is running: `docker compose ps ai-brain`
- Check trip has tight deadline (< 10 min)
- Check ambulance is far from destination (> 20 km)
- Force handoff via UI Test Panel

**Bounties not appearing:**
- Check fleet vehicles are in red zone (< 2 km from ambulance)
- Check corridor is being calculated (check logs)
- Check webhook partners are active in database

**Chaos endpoints return 403:**
- Set `CHAOS_ENABLED=true` in backend environment
- Restart Go server

---

## 📚 **ADDITIONAL RESOURCES**

- **Main README:** `README.md` - Quick start guide
- **Dataset README:** `datasets/realtime/README.md` - Data format docs
- **Test Scenarios:** `datasets/test-scenarios/SCENARIOS.md` - Scenario catalog
- **API Docs:** Check Swagger at `http://localhost:8080/swagger` (if enabled)

---

## ✅ **SUMMARY**

### What You Have Now

✅ **God-mode simulator** - Best for development and demos  
✅ **E2E handoff test** - Validates critical path  
✅ **Chaos endpoints** - Stress testing  
✅ **UI Test Panel** - One-click scenario triggers  
✅ **Comprehensive test data** - Multiple trip scenarios  

### What's Still Missing

❌ Bounty lifecycle E2E test  
❌ Edge case tests (invalid data, etc.)  
❌ Performance/load tests  
❌ More ping sequence variations  
❌ Webhook integration tests  

### Recommended Next Action

**For immediate testing:**
```bash
# Terminal 1: Start backend
docker compose up -d
cd services/core-go && go run ./cmd/server

# Terminal 2: Start frontend
cd services/web && npm run dev

# Terminal 3: Run simulator
cd scripts && npm run simulate

# Browser: Open http://localhost:3000
# Watch the magic happen! 🎉
```

**For comprehensive testing:**
1. Run e2e tests: `npm run e2e:handoff`
2. Try chaos scenarios via the dashboard Chaos panel
3. Create additional test data as needed
