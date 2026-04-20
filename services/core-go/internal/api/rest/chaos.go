package rest

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
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
	chaosEnabled bool,
) *ChaosHandler {
	return &ChaosHandler{
		hub:          hub,
		cache:        cache,
		trips:        trips,
		pings:        pings,
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
// Body: { "count": <int>, "center_lat": <float>, "center_lng": <float>, "radius_m": <float> }
// Broadcasts a FLEET_SPAWN envelope placing count synthetic vehicles in a grid
// within radius_m of the given centre.
func (h *ChaosHandler) SpawnFleet(c *fiber.Ctx) error {
	if err := h.guard(c); err != nil {
		return err
	}

	var req struct {
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

	vehicles := spawnVehicles(req.Count, req.CenterLat, req.CenterLng, req.RadiusM)

	ids := make([]string, len(vehicles))
	for i, v := range vehicles {
		ids[i] = v.ID
	}

	h.mu.Lock()
	h.fleetIDs = append(h.fleetIDs, ids...)
	h.mu.Unlock()

	h.hub.BroadcastFleetSpawn(vehicles)

	metrics.ChaosTriggers.WithLabelValues("spawn-fleet").Add(float64(req.Count))
	log.Info().Int("count", req.Count).Msg("chaos: fleet spawned")

	return c.JSON(fiber.Map{"spawned": req.Count, "vehicle_ids": ids})
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

// spawnVehicles places count fleet vehicles in a uniform grid inscribed within
// radius_m of the given center. Each vehicle carries a stable synthetic ID.
func spawnVehicles(count int, centerLat, centerLng, radiusM float64) []ws.FleetVehicle {
	// Convert radius from metres to approximate degree spans.
	latDeg := radiusM / 111320.0
	lngDeg := radiusM / (111320.0 * math.Cos(centerLat*math.Pi/180))

	side := int(math.Ceil(math.Sqrt(float64(count))))
	if side < 1 {
		side = 1
	}

	vehicles := make([]ws.FleetVehicle, count)
	for i := range vehicles {
		row := i / side
		col := i % side
		// Map row/col into [-1, +1] normalised coordinates.
		fracRow := (float64(row)/float64(max(side-1, 1)))*2 - 1
		fracCol := (float64(col)/float64(max(side-1, 1)))*2 - 1
		vehicles[i] = ws.FleetVehicle{
			ID:     fmt.Sprintf("chaos-fleet-%04d", i),
			Lat:    centerLat + fracRow*latDeg,
			Lng:    centerLng + fracCol*lngDeg,
			Status: "rerouting",
		}
	}
	return vehicles
}
