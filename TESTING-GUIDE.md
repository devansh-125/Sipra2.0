# Sipra Testing Guide

Complete guide to testing the Sipra system with dummy data and dynamic test scenarios.

---

## 📊 Current Testing Infrastructure

### ✅ **EXISTING & USEFUL**

#### 1. **Simulation Scripts** (Production-Ready)

| Script | Purpose | Status |
|--------|---------|--------|
| `test-tools/simulate-gps.ts` | God-mode simulator with 20 fleet vehicles on real Bangalore roads | ✅ **EXCELLENT** |
| `scripts/realtime-ingest.ts` | Streams pre-recorded GPS pings from NDJSON file | ✅ **USEFUL** |
| `test-tools/e2e-handoff.ts` | End-to-end test for drone handoff pipeline | ✅ **COMPREHENSIVE** |
| `scripts/play-scenario.ts` | Replays the three fixed scenario datasets (s1/s2/s3) | ✅ **PRIMARY** |

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

# Replay recorded scenarios (real data)
npm run play:s1-normal
npm run play:s2-congestion
npm run play:s3-drone-handoff
```

#### 2. **Recorded Scenario Datasets (Primary)**

Three fixed, real-data scenarios live under `datasets/test-scenarios/realtime/`:

- `s1-normal` — baseline highway run
- `s2-congestion` — mixed-speed congestion wave
- `s3-drone-handoff` — stall event intended to trigger drone dispatch

Run them with the scenario player:

```bash
cd scripts
npm run play:s1-normal
npm run play:s2-congestion
npm run play:s3-drone-handoff
```

#### 3. **Existing Test Data**

| File | Purpose | Status |
|------|---------|--------|
| `datasets/realtime/trip.json` | Demo trip configuration | ✅ Used by ingest script |
| `datasets/realtime/ambulance-pings.ndjson` | 10 GPS waypoints Victoria → Manipal | ✅ Used by ingest script |
| `datasets/realtime/ai-predict.sample.*.json` | AI brain API contract examples | ⚠️ Reference only |
| `datasets/realtime/drone-dispatch.sample.*.json` | Drone API contract examples | ⚠️ Reference only |


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

3. **Replay recorded scenarios:**
   ```bash
   cd scripts
   npm run play:s1-normal
   npm run play:s2-congestion
   npm run play:s3-drone-handoff
   ```

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

2. **Replay the recorded scenarios:**
   ```bash
   cd scripts
   npm run play:s1-normal
   npm run play:s2-congestion
   npm run play:s3-drone-handoff
   ```

### For Demo/Presentation

1. **Run god-mode simulator:**
   ```bash
   cd scripts && npm run simulate
   ```

2. **Show recorded scenarios in order:**
   ```bash
   cd scripts
   npm run play:s1-normal
   npm run play:s2-congestion
   npm run play:s3-drone-handoff
   ```

---

## 📋 **TEST COVERAGE MATRIX**

| Feature | Manual Test | Script Test | E2E Test | Scenario Replay | Status |
|---------|-------------|-------------|----------|-----------------|--------|
| Trip creation | ✅ | ✅ | ✅ | ✅ | **Complete** |
| GPS ping ingestion | ✅ | ✅ | ✅ | ✅ | **Good** |
| Corridor calculation | ✅ | ✅ | ❌ | ✅ | **Needs E2E** |
| AI breach prediction | ✅ | ✅ | ✅ | ✅ | **Good** |
| Drone handoff | ✅ | ✅ | ✅ | ✅ | **Complete** |
| Bounty creation | ✅ | ✅ | ❌ | ❌ | **Needs E2E** |
| Bounty claim | ✅ | ✅ | ❌ | ❌ | **Needs Tests** |
| Bounty verification | ✅ | ✅ | ❌ | ❌ | **Needs Tests** |
| Fleet rerouting | ✅ | ✅ | ❌ | ❌ | **Needs E2E** |
| WebSocket broadcast | ✅ | ✅ | ✅ | ✅ | **Good** |
| Webhook dispatch | ✅ | ❌ | ❌ | ❌ | **Needs Tests** |
| Multiple simultaneous trips | ❌ | ❌ | ❌ | ❌ | **Needs Implementation** |
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

**Bounties not appearing:**
- Check fleet vehicles are in red zone (< 2 km from ambulance)
- Check corridor is being calculated (check logs)
- Check webhook partners are active in database

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
✅ **Recorded scenarios** - s1/s2/s3 real dataset replays  

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
2. Replay recorded scenarios: `npm run play:s1-normal`, `npm run play:s2-congestion`, `npm run play:s3-drone-handoff`
3. Create additional test data as needed
