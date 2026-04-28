package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	"github.com/devansh-125/sipra/services/core-go/internal/sim"
	pgstore "github.com/devansh-125/sipra/services/core-go/internal/store/postgres"
	redisstore "github.com/devansh-125/sipra/services/core-go/internal/store/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// ChaosHandler exposes demo-only endpoints for live chaos injection.
// Every handler returns 403 when chaosEnabled is false (CHAOS_ENABLED=false).
type ChaosHandler struct {
	hub          *ws.Hub
	cache        *redisstore.PingCache
	trips        *pgstore.TripRepo
	pings        *pgstore.PingRepo
	valhalla     *sim.ValhallaClient
	tickPub      *redisstore.FleetTickPublisher
	simTickHz    int
	chaosEnabled bool

	mu           sync.Mutex
	floodedTrips map[string]int // trip_id -> pings injected
	fleetIDs     []string       // synthetic fleet vehicle IDs from spawn-fleet
}

// NewChaosHandler constructs a ChaosHandler. Pass chaosEnabled=false to lock
// all endpoints behind a 403 guard without registering routes.
func NewChaosHandler(
	hub *ws.Hub,
	cache *redisstore.PingCache,
	trips *pgstore.TripRepo,
	pings *pgstore.PingRepo,
	valhalla *sim.ValhallaClient,
	tickPub *redisstore.FleetTickPublisher,
	simTickHz int,
	chaosEnabled bool,
) *ChaosHandler {
	if simTickHz <= 0 {
		simTickHz = 20
	}
	return &ChaosHandler{
		hub:          hub,
		cache:        cache,
		trips:        trips,
		pings:        pings,
		valhalla:     valhalla,
		tickPub:      tickPub,
		simTickHz:    simTickHz,
		chaosEnabled: chaosEnabled,
		floodedTrips: make(map[string]int),
	}
}

func (h *ChaosHandler) guard(c *fiber.Ctx) error {
	if !h.chaosEnabled {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "chaos_disabled"})
	}
	return nil
}

// FloodBridge handles POST /api/v1/chaos/flood-bridge.
// Body: { "trip_id": "<uuid>", "count": <1..500> }
// Injects count synthetic GPS_UPDATE pings along a bottleneck path anchored at
// the trip's most recent known position (falls back to trip origin).
func (h *ChaosHandler) FloodBridge(c *fiber.Ctx) error {
	if err := h.guard(c); err != nil {
		return err
	}

	var req struct {
		TripID string `json:"trip_id"`
		Count  int    `json:"count"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}
	if _, err := uuid.Parse(req.TripID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Errorf("chaos.flood-bridge: trip_id must be a valid UUID: %w", err).Error(),
		})
	}
	if req.Count < 1 || req.Count > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "chaos.flood-bridge: count must be between 1 and 500",
		})
	}

	tripID := domain.TripID(req.TripID)
	anchor, err := h.resolveAnchor(c.Context(), tripID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": fmt.Errorf("chaos.flood-bridge: %w", err).Error(),
		})
	}

	waypoints := bottleneckPath(anchor, req.Count)
	now := time.Now().UTC()

	for i, wp := range waypoints {
		ping := domain.GPSPing{
			ID:         domain.PingID(uuid.New().String()),
			TripID:     tripID,
			Location:   wp,
			RecordedAt: now.Add(time.Duration(i) * 200 * time.Millisecond),
			IngestedAt: now,
		}
		if err := h.cache.Push(c.Context(), ping); err != nil {
			log.Error().Err(err).Str("trip", req.TripID).Msg("chaos.flood-bridge: redis push failed")
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"error": fmt.Errorf("chaos.flood-bridge: cache push: %w", err).Error(),
			})
		}
		h.hub.BroadcastGPSUpdate(ping)
	}

	h.mu.Lock()
	h.floodedTrips[req.TripID] += req.Count
	h.mu.Unlock()

	metrics.ChaosTriggers.WithLabelValues("flood-bridge").Add(float64(req.Count))
	log.Info().Str("trip", req.TripID).Int("count", req.Count).Msg("chaos: flood-bridge injected")

	return c.JSON(fiber.Map{"injected": req.Count, "trip_id": req.TripID})
}

// SpawnFleet handles POST /api/v1/chaos/spawn-fleet.
// Body: { "trip_id": "<uuid>", "count": <int>, "center_lat": <float>, "center_lng": <float>, "radius_m": <float> }
// Broadcasts a FLEET_SPAWN envelope, then runs a short evacuation simulation:
// drivers accept synthetic bounties, move out of the red zone, and complete.
func (h *ChaosHandler) SpawnFleet(c *fiber.Ctx) error {
	if err := h.guard(c); err != nil {
		return err
	}

	var req struct {
		TripID    string  `json:"trip_id"`
		Count     int     `json:"count"`
		CenterLat float64 `json:"center_lat"`
		CenterLng float64 `json:"center_lng"`
		RadiusM   float64 `json:"radius_m"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}
	if req.Count < 1 || req.Count > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "chaos.spawn-fleet: count must be between 1 and 500",
		})
	}
	if req.CenterLat == 0 && req.CenterLng == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "chaos.spawn-fleet: center_lat and center_lng are required",
		})
	}
	if req.RadiusM <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "chaos.spawn-fleet: radius_m must be positive",
		})
	}
	if req.TripID != "" {
		if _, err := uuid.Parse(req.TripID); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": fmt.Errorf("chaos.spawn-fleet: trip_id must be a valid UUID: %w", err).Error(),
			})
		}
	}

	vehicles, run := spawnEvacuationFleet(req.Count, req.CenterLat, req.CenterLng, req.RadiusM)

	ids := make([]string, len(vehicles))
	for i, v := range vehicles {
		ids[i] = v.ID
	}

	h.mu.Lock()
	h.fleetIDs = append(h.fleetIDs, ids...)
	h.mu.Unlock()

	h.hub.BroadcastFleetSpawn(vehicles)
	if req.TripID != "" {
		go h.runFleetEvacuation(req.TripID, req.CenterLat, req.CenterLng, req.RadiusM, run)
	}

	metrics.ChaosTriggers.WithLabelValues("spawn-fleet").Add(float64(req.Count))
	log.Info().Int("count", req.Count).Bool("evacuation", req.TripID != "").Msg("chaos: fleet spawned")

	return c.JSON(fiber.Map{
		"spawned":          req.Count,
		"vehicle_ids":      ids,
		"evacuation_run":   req.TripID != "",
		"run_duration_sec": 162,
	})
}

// ForceHandoff handles POST /api/v1/chaos/force-handoff.
// Body: { "trip_id": "<uuid>", "reason": "<string>" }
// Broadcasts HANDOFF_INITIATED bypassing the risk monitor and AI brain.
func (h *ChaosHandler) ForceHandoff(c *fiber.Ctx) error {
	if err := h.guard(c); err != nil {
		return err
	}

	var req struct {
		TripID string `json:"trip_id"`
		Reason string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}
	if _, err := uuid.Parse(req.TripID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Errorf("chaos.force-handoff: trip_id must be a valid UUID: %w", err).Error(),
		})
	}
	if req.Reason == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "chaos.force-handoff: reason is required",
		})
	}

	trip, err := h.trips.GetByID(c.Context(), domain.TripID(req.TripID))
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": fmt.Errorf("chaos.force-handoff: %w", err).Error(),
		})
	}

	predictedETA := int(time.Until(trip.GoldenHourDeadline).Seconds())
	if predictedETA < 0 {
		predictedETA = 0
	}

	h.hub.BroadcastHandoffInitiated(req.TripID, req.Reason, predictedETA)

	metrics.ChaosTriggers.WithLabelValues("force-handoff").Inc()
	log.Info().Str("trip", req.TripID).Str("reason", req.Reason).Msg("chaos: handoff forced")

	return c.JSON(fiber.Map{
		"trip_id":               req.TripID,
		"reason":                req.Reason,
		"predicted_eta_seconds": predictedETA,
	})
}

// Reset handles POST /api/v1/chaos/reset.
// Clears in-memory chaos state (flooded trip counters, spawned fleet IDs).
// Does NOT truncate Postgres or Redis.
func (h *ChaosHandler) Reset(c *fiber.Ctx) error {
	if err := h.guard(c); err != nil {
		return err
	}

	h.mu.Lock()
	flooded := len(h.floodedTrips)
	fleet := len(h.fleetIDs)
	h.floodedTrips = make(map[string]int)
	h.fleetIDs = nil
	h.mu.Unlock()

	metrics.ChaosTriggers.WithLabelValues("reset").Inc()
	log.Info().Int("flooded_trips", flooded).Int("fleet_ids", fleet).Msg("chaos: state reset")

	return c.JSON(fiber.Map{
		"cleared_flooded_trips": flooded,
		"cleared_fleet_ids":     fleet,
	})
}

// resolveAnchor returns the trip's most recent GPS position. Falls back to the
// trip's origin when no pings have been recorded yet.
func (h *ChaosHandler) resolveAnchor(ctx context.Context, tripID domain.TripID) (domain.Point, error) {
	if ping, err := h.pings.GetLatest(ctx, tripID); err == nil {
		return ping.Location, nil
	}
	trip, err := h.trips.GetByID(ctx, tripID)
	if err != nil {
		return domain.Point{}, fmt.Errorf("trip %s not found: %w", tripID, err)
	}
	return trip.Origin, nil
}

// bottleneckPath returns count evenly distributed points along a ~500m road
// segment offset north-east from anchor. The path models a bridge or
// intersection bottleneck for the corridor engine to absorb as realistic pings.
func bottleneckPath(anchor domain.Point, count int) []domain.Point {
	// 20 waypoints spread over ~500m: ~25m/step north + ~10m/step east.
	const totalSteps = 20
	const stepLat = 0.000225 // ≈25 m northward per step
	const stepLng = 0.000090 // ≈10 m eastward per step

	pts := make([]domain.Point, count)
	denom := float64(max(count-1, 1))
	for i := range pts {
		t := float64(i) / denom
		pts[i] = domain.Point{
			Lat: anchor.Lat + t*stepLat*totalSteps,
			Lng: anchor.Lng + t*stepLng*totalSteps,
		}
	}
	return pts
}

type evacuationVehicle struct {
	vehicle        ws.FleetVehicle
	bountyID       string
	amountPts      int
	startDelayTick int // ticks to hold at initial position before moving
	accepted       bool
	state          driverFSMState
	route          roadRoute
	edgeIdx        int
	sEdgeM         float64
	lateralM       float64
	lateralTargetM float64
	lateralRateMps float64
	speedMps       float64
	accelMps2      float64
	reactionLeftS  float64
	cooldownS      float64
	plannedBy      string
	replanTicks    int
}

type driverFSMState string

const (
	driverIdle               driverFSMState = "IDLE"
	driverNavigatingNormal   driverFSMState = "NAVIGATING_NORMAL"
	driverAlerted            driverFSMState = "ALERTED"
	driverClaimingBounty     driverFSMState = "CLAIMING_BOUNTY"
	driverEvadingPullingOver driverFSMState = "EVADING_PULLING_OVER"
	driverHoldingClear       driverFSMState = "HOLDING_CLEAR"
	driverResuming           driverFSMState = "RESUMING"
)

type routeEdge struct {
	a domain.Point
	b domain.Point
	l float64
}

type roadRoute struct {
	id    string
	edges []routeEdge
	total float64
}

type vec2 struct {
	x float64
	y float64
}

// spawnEvacuationFleet places vehicles at random positions around the center.
// 70% begin inside the red zone; the rest are in the warning ring. Each vehicle
// gets a random angle and a random start delay so their movements are staggered.
func spawnEvacuationFleet(count int, centerLat, centerLng, radiusM float64) ([]ws.FleetVehicle, []evacuationVehicle) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	spawnTag := time.Now().UnixMilli() % 100_000

	vehicles := make([]ws.FleetVehicle, count)
	run := make([]evacuationVehicle, count)
	routes := buildSyntheticRoadNetwork(centerLat, centerLng, radiusM)

	redCount := int(math.Ceil(float64(count) * 0.7))
	if redCount > count {
		redCount = count
	}

	for i := 0; i < count; i++ {
		route := routes[rng.Intn(len(routes))]
		progress := rng.Float64() * route.total
		base, edgeIdx, sEdge := positionAlongRoute(route, progress)
		n := edgeNormal(route.edges[edgeIdx])

		var lateralBias float64
		if i < redCount {
			lateralBias = -(0.3 + rng.Float64()*0.8) * 3.2
		} else {
			lateralBias = (0.4 + rng.Float64()*0.8) * 3.2
		}
		start := offsetByMeters(base, n, lateralBias)
		inRed := distanceM(centerLat, centerLng, start.Lat, start.Lng) <= radiusM
		heading := bearingBetween(route.edges[edgeIdx].a, route.edges[edgeIdx].b)

		id := fmt.Sprintf("fleet-%05d-%02d", spawnTag, i)
		bountyID := fmt.Sprintf("bounty-%05d-%02d", spawnTag, i)
		amount := 60 + rng.Intn(25)
		if amount < 50 {
			amount = 50
		}

		startDelay := rng.Intn(8)
		accepted := inRed && rng.Float64() < 0.65

		initialStatus := "active"
		if inRed {
			initialStatus = "offered"
		}

		vehicles[i] = ws.FleetVehicle{
			ID:         id,
			Lat:        start.Lat,
			Lng:        start.Lng,
			Status:     initialStatus,
			Evading:    inRed,
			HeadingDeg: &heading,
			RouteID:    route.id,
		}

		state := driverNavigatingNormal
		if inRed {
			state = driverAlerted
		}
		if accepted {
			state = driverClaimingBounty
		}

		run[i] = evacuationVehicle{
			vehicle:        vehicles[i],
			bountyID:       bountyID,
			amountPts:      amount,
			startDelayTick: startDelay,
			accepted:       accepted,
			state:          state,
			route:          route,
			edgeIdx:        edgeIdx,
			sEdgeM:         sEdge,
			lateralM:       lateralBias,
			lateralTargetM: lateralBias,
			lateralRateMps: 1.2 + rng.Float64()*1.0,
			speedMps:       7.5 + rng.Float64()*5.0,
			accelMps2:      0,
			reactionLeftS:  0.6 + rng.Float64()*1.2,
			cooldownS:      0,
			plannedBy:      "synthetic",
			replanTicks:    0,
		}
	}
	return vehicles, run
}

func (h *ChaosHandler) runFleetEvacuation(tripID string, centerLat, centerLng, baseRadiusM float64, run []evacuationVehicle) {
	time.Sleep(2000 * time.Millisecond)

	for _, v := range run {
		if v.accepted {
			h.hub.BroadcastRerouteStatus(v.vehicle.ID, tripID, "rerouting", v.bountyID, 0)
		} else if v.vehicle.Status == "offered" {
			h.hub.BroadcastRerouteStatus(v.vehicle.ID, tripID, "failed", v.bountyID, 0)
		}
	}

	tickHz := h.simTickHz
	if tickHz <= 0 {
		tickHz = 20
	}
	tickDur := time.Second / time.Duration(tickHz)
	dt := 1.0 / float64(tickHz)
	const ticks = 360
	for tick := 1; tick <= ticks; tick++ {
		expandedRadius := baseRadiusM + float64(tick)*2.5
		if h.valhalla != nil && tick%int(math.Max(1, float64(tickHz*5))) == 0 {
			h.replanEvadersWithValhalla(context.Background(), run, centerLat, centerLng, expandedRadius)
		}

		frame := make([]ws.FleetVehicle, len(run))
		for i, v := range run {
			if tick <= v.startDelayTick {
				frame[i] = v.vehicle
				continue
			}
			updateEvacuationVehicle(&v, dt)
			v.replanTicks++
			run[i] = v
			frame[i] = v.vehicle
		}
		if raw, err := json.Marshal(frame); err == nil {
			h.hub.BroadcastFleetUpdate(raw)
		} else {
			log.Warn().Err(err).Msg("chaos: marshal fleet evacuation frame")
		}
		if h.tickPub != nil {
			if err := h.tickPub.PublishTick(context.Background(), tripID, tick, time.Now().UTC(), frame); err != nil {
				log.Warn().Err(err).Str("trip", tripID).Msg("chaos: publish fleet tick")
			}
		}
		time.Sleep(tickDur)
	}

	for _, v := range run {
		if v.accepted {
			h.hub.BroadcastRerouteStatus(v.vehicle.ID, tripID, "completed", v.bountyID, v.amountPts)
		}
	}
	log.Info().Str("trip", tripID).Int("drivers", len(run)).Msg("chaos: fleet evacuation completed")
}

func (h *ChaosHandler) replanEvadersWithValhalla(
	ctx context.Context,
	run []evacuationVehicle,
	centerLat, centerLng, radiusM float64,
) {
	exclude := circlePolygon(centerLat, centerLng, radiusM, 20)
	for i := range run {
		v := &run[i]
		if !v.accepted {
			continue
		}
		if v.state != driverClaimingBounty && v.state != driverEvadingPullingOver {
			continue
		}
		origin := domain.Point{Lat: v.vehicle.Lat, Lng: v.vehicle.Lng}
		target := outwardTarget(origin, centerLat, centerLng, radiusM*1.9)
		points, err := h.valhalla.Route(ctx, sim.RouteRequest{
			Origin:          origin,
			Destination:     target,
			ExcludePolygons: [][][]float64{exclude},
		})
		if err != nil || len(points) < 2 {
			continue
		}
		route := routeFromPolyline(fmt.Sprintf("valhalla-%s", v.vehicle.ID), points)
		if len(route.edges) < 1 {
			continue
		}
		v.route = route
		v.edgeIdx = 0
		v.sEdgeM = 0
		v.plannedBy = "valhalla"
		v.vehicle.RouteID = route.id
	}
}

func updateEvacuationVehicle(v *evacuationVehicle, dt float64) {
	const (
		aBrakeMax  = 2.8
		aAccelMax  = 1.7
		jerkMax    = 1.6
		tau        = 1.25
		cruiseMps  = 10.5
		evadeMps   = 4.4
		resumeMps  = 8.8
		pullOverM  = 5.2
		clearHoldS = 3.5
	)

	if v.reactionLeftS > 0 {
		v.reactionLeftS -= dt
		v.vehicle.Status = string(driverAlerted)
		trackRoutePosition(v, dt, cruiseMps, aBrakeMax, aAccelMax, jerkMax, tau)
		return
	}

	switch v.state {
	case driverNavigatingNormal:
		v.vehicle.Status = string(driverNavigatingNormal)
		v.lateralTargetM = 0
		trackRoutePosition(v, dt, cruiseMps, aBrakeMax, aAccelMax, jerkMax, tau)
	case driverAlerted:
		v.vehicle.Status = string(driverAlerted)
		if v.accepted {
			v.state = driverClaimingBounty
		} else {
			v.state = driverEvadingPullingOver
		}
		trackRoutePosition(v, dt, evadeMps, aBrakeMax, aAccelMax, jerkMax, tau)
	case driverClaimingBounty:
		v.vehicle.Status = string(driverClaimingBounty)
		v.cooldownS += dt
		trackRoutePosition(v, dt, evadeMps, aBrakeMax, aAccelMax, jerkMax, tau)
		if v.cooldownS >= 1.4 {
			v.cooldownS = 0
			v.state = driverEvadingPullingOver
		}
	case driverEvadingPullingOver:
		v.vehicle.Status = string(driverEvadingPullingOver)
		v.lateralTargetM = pullOverM
		trackRoutePosition(v, dt, evadeMps, aBrakeMax, aAccelMax, jerkMax, tau)
		if math.Abs(v.lateralM-v.lateralTargetM) < 0.5 && v.speedMps < 0.7 {
			v.state = driverHoldingClear
			v.cooldownS = 0
		}
	case driverHoldingClear:
		v.vehicle.Status = string(driverHoldingClear)
		v.lateralTargetM = pullOverM
		trackRoutePosition(v, dt, 0.1, aBrakeMax, aAccelMax, jerkMax, tau)
		v.cooldownS += dt
		if v.cooldownS >= clearHoldS {
			v.state = driverResuming
			v.cooldownS = 0
		}
	case driverResuming:
		v.vehicle.Status = string(driverResuming)
		v.lateralTargetM = 0
		trackRoutePosition(v, dt, resumeMps, aBrakeMax, aAccelMax, jerkMax, tau)
		if math.Abs(v.lateralM) < 0.4 && v.speedMps > 7.0 {
			v.state = driverNavigatingNormal
		}
	default:
		trackRoutePosition(v, dt, cruiseMps, aBrakeMax, aAccelMax, jerkMax, tau)
	}

	v.vehicle.Evading = v.state == driverEvadingPullingOver || v.state == driverHoldingClear
	if v.accepted {
		if v.state == driverNavigatingNormal {
			v.vehicle.RerouteStatus = "completed"
		} else {
			v.vehicle.RerouteStatus = "rerouting"
		}
	} else if v.vehicle.Status == "offered" || v.state == driverAlerted {
		v.vehicle.RerouteStatus = "failed"
	}
}

func trackRoutePosition(v *evacuationVehicle, dt, vTarget, aBrakeMax, aAccelMax, jerkMax, tau float64) {
	aDesired := clamp((vTarget-v.speedMps)/tau, -aBrakeMax, aAccelMax)
	dA := clamp(aDesired-v.accelMps2, -jerkMax*dt, jerkMax*dt)
	v.accelMps2 = clamp(v.accelMps2+dA, -aBrakeMax, aAccelMax)
	v.speedMps = math.Max(0, v.speedMps+v.accelMps2*dt)
	ds := v.speedMps*dt + 0.5*v.accelMps2*dt*dt
	v.sEdgeM += math.Max(0, ds)

	for v.edgeIdx < len(v.route.edges)-1 && v.sEdgeM > v.route.edges[v.edgeIdx].l {
		v.sEdgeM -= v.route.edges[v.edgeIdx].l
		v.edgeIdx++
	}
	if v.edgeIdx >= len(v.route.edges) {
		v.edgeIdx = len(v.route.edges) - 1
		v.sEdgeM = v.route.edges[v.edgeIdx].l
	}

	stepLat := v.lateralRateMps * dt
	if v.lateralM < v.lateralTargetM {
		v.lateralM = math.Min(v.lateralTargetM, v.lateralM+stepLat)
	} else {
		v.lateralM = math.Max(v.lateralTargetM, v.lateralM-stepLat)
	}

	edge := v.route.edges[v.edgeIdx]
	u := 0.0
	if edge.l > 0 {
		u = clamp(v.sEdgeM/edge.l, 0, 1)
	}
	base := interpolatePoint(edge.a, edge.b, u)
	n := edgeNormal(edge)
	p := offsetByMeters(base, n, v.lateralM)
	v.vehicle.Lat = p.Lat
	v.vehicle.Lng = p.Lng
	h := bearingBetween(edge.a, edge.b)
	v.vehicle.HeadingDeg = &h
}

func buildSyntheticRoadNetwork(centerLat, centerLng, radiusM float64) []roadRoute {
	ringRadii := []float64{radiusM * 0.55, radiusM * 0.8, radiusM * 1.1}
	routes := make([]roadRoute, 0, len(ringRadii))
	for i, r := range ringRadii {
		points := make([]domain.Point, 13)
		for j := 0; j <= 12; j++ {
			theta := (2 * math.Pi * float64(j)) / 12
			points[j] = offsetPoint(centerLat, centerLng, theta, r)
		}
		edges := make([]routeEdge, 0, 12)
		total := 0.0
		for j := 0; j < 12; j++ {
			a := points[j]
			b := points[j+1]
			l := distanceM(a.Lat, a.Lng, b.Lat, b.Lng)
			edges = append(edges, routeEdge{a: a, b: b, l: l})
			total += l
		}
		routes = append(routes, roadRoute{
			id:    fmt.Sprintf("ring-%d", i+1),
			edges: edges,
			total: total,
		})
	}
	return routes
}

func routeFromPolyline(id string, points []domain.Point) roadRoute {
	if len(points) < 2 {
		return roadRoute{id: id}
	}
	edges := make([]routeEdge, 0, len(points)-1)
	total := 0.0
	for i := 0; i < len(points)-1; i++ {
		a := points[i]
		b := points[i+1]
		l := distanceM(a.Lat, a.Lng, b.Lat, b.Lng)
		if l < 0.5 {
			continue
		}
		edges = append(edges, routeEdge{a: a, b: b, l: l})
		total += l
	}
	return roadRoute{id: id, edges: edges, total: total}
}

func outwardTarget(origin domain.Point, centerLat, centerLng, distM float64) domain.Point {
	dEast, dNorth := metersDiff(
		domain.Point{Lat: centerLat, Lng: centerLng},
		origin,
	)
	norm := math.Hypot(dEast, dNorth)
	if norm < 1e-6 {
		return offsetPoint(centerLat, centerLng, math.Pi/4, distM)
	}
	uEast := dEast / norm
	uNorth := dNorth / norm
	return domain.Point{
		Lat: origin.Lat + (uNorth*distM)/111320.0,
		Lng: origin.Lng + (uEast*distM)/(111320.0*math.Cos(origin.Lat*math.Pi/180)),
	}
}

func circlePolygon(centerLat, centerLng, radiusM float64, segments int) [][]float64 {
	if segments < 8 {
		segments = 8
	}
	ring := make([][]float64, 0, segments+1)
	for i := 0; i <= segments; i++ {
		theta := 2 * math.Pi * float64(i) / float64(segments)
		p := offsetPoint(centerLat, centerLng, theta, radiusM)
		ring = append(ring, []float64{p.Lng, p.Lat})
	}
	return ring
}

func positionAlongRoute(route roadRoute, sTotal float64) (domain.Point, int, float64) {
	if len(route.edges) == 0 {
		return domain.Point{}, 0, 0
	}
	s := math.Mod(sTotal, route.total)
	if s < 0 {
		s += route.total
	}
	for i, e := range route.edges {
		if s <= e.l {
			u := 0.0
			if e.l > 0 {
				u = s / e.l
			}
			return interpolatePoint(e.a, e.b, u), i, s
		}
		s -= e.l
	}
	last := len(route.edges) - 1
	return route.edges[last].b, last, route.edges[last].l
}

func interpolatePoint(a, b domain.Point, t float64) domain.Point {
	return domain.Point{
		Lat: a.Lat + (b.Lat-a.Lat)*t,
		Lng: a.Lng + (b.Lng-a.Lng)*t,
	}
}

func edgeNormal(e routeEdge) vec2 {
	dx, dy := metersDiff(e.a, e.b)
	l := math.Hypot(dx, dy)
	if l < 1e-6 {
		return vec2{x: 0, y: 1}
	}
	return vec2{x: -dy / l, y: dx / l}
}

func offsetByMeters(base domain.Point, n vec2, lateralM float64) domain.Point {
	dEast := n.x * lateralM
	dNorth := n.y * lateralM
	return domain.Point{
		Lat: base.Lat + dNorth/111320.0,
		Lng: base.Lng + dEast/(111320.0*math.Cos(base.Lat*math.Pi/180)),
	}
}

func bearingBetween(a, b domain.Point) float64 {
	dx, dy := metersDiff(a, b)
	angle := math.Atan2(dx, dy) * 180 / math.Pi
	if angle < 0 {
		angle += 360
	}
	return angle
}

func metersDiff(a, b domain.Point) (eastM, northM float64) {
	northM = (b.Lat - a.Lat) * 111320.0
	avgLat := (a.Lat + b.Lat) / 2
	eastM = (b.Lng - a.Lng) * (111320.0 * math.Cos(avgLat*math.Pi/180))
	return eastM, northM
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
func offsetPoint(centerLat, centerLng, angleRad, meters float64) domain.Point {
	northM := math.Sin(angleRad) * meters
	eastM := math.Cos(angleRad) * meters
	return domain.Point{
		Lat: centerLat + northM/111320.0,
		Lng: centerLng + eastM/(111320.0*math.Cos(centerLat*math.Pi/180)),
	}
}

func headingFromAngle(angleRad float64) float64 {
	deg := 90 - angleRad*180/math.Pi
	for deg < 0 {
		deg += 360
	}
	for deg >= 360 {
		deg -= 360
	}
	return deg
}

func distanceM(aLat, aLng, bLat, bLng float64) float64 {
	const earthRadiusM = 6371000.0
	dLat := (bLat - aLat) * math.Pi / 180
	dLng := (bLng - aLng) * math.Pi / 180
	lat1 := aLat * math.Pi / 180
	lat2 := bLat * math.Pi / 180
	x := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return earthRadiusM * 2 * math.Atan2(math.Sqrt(x), math.Sqrt(1-x))
}
