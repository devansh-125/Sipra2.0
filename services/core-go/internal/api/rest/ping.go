package rest

import (
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	redisstore "github.com/devansh-125/sipra/services/core-go/internal/store/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// PingHandler handles GPS ping ingestion endpoints.
// hub is optional; pass nil to disable live WebSocket broadcasts (useful in tests).
type PingHandler struct {
	cache *redisstore.PingCache
	hub   *ws.Hub
}

func NewPingHandler(cache *redisstore.PingCache, hub *ws.Hub) *PingHandler {
	return &PingHandler{cache: cache, hub: hub}
}

type ingestPingRequest struct {
	Lat        float64  `json:"lat"`
	Lng        float64  `json:"lng"`
	HeadingDeg *float64 `json:"heading_deg"`
	SpeedKPH   *float64 `json:"speed_kph"`
	AccuracyM  *float64 `json:"accuracy_m"`
	RecordedAt string   `json:"recorded_at"` // RFC3339; defaults to server time if omitted
}

// IngestPing handles POST /api/v1/trips/:id/pings.
//
// Hot path: writes only to Redis (sub-millisecond) and returns 202 immediately
// so the IoT device is never blocked on a Postgres round-trip. A background
// worker drains Redis into Postgres on a configurable interval.
func (h *PingHandler) IngestPing(c *fiber.Ctx) error {
	tripID := domain.TripID(c.Params("id"))
	if tripID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "trip id is required"})
	}

	var req ingestPingRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}

	// (0, 0) is treated as missing — it signals uninitialized GPS hardware or a
	// parse failure, not a real location near the Gulf of Guinea.
	if req.Lat == 0 && req.Lng == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "lat and lng are required and must be non-zero",
		})
	}

	recordedAt := time.Now().UTC()
	if req.RecordedAt != "" {
		t, err := time.Parse(time.RFC3339, req.RecordedAt)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "recorded_at must be RFC3339 (e.g. 2025-04-19T14:30:00Z)",
			})
		}
		recordedAt = t.UTC()
	}

	ping := domain.GPSPing{
		ID:         domain.PingID(uuid.New().String()),
		TripID:     tripID,
		Location:   domain.Point{Lat: req.Lat, Lng: req.Lng},
		HeadingDeg: req.HeadingDeg,
		SpeedKPH:   req.SpeedKPH,
		AccuracyM:  req.AccuracyM,
		RecordedAt: recordedAt,
		IngestedAt: time.Now().UTC(),
	}

	if err := h.cache.Push(c.Context(), ping); err != nil {
		log.Error().Err(err).Str("trip", string(tripID)).Msg("redis: push ping failed")
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"error": "ping cache unavailable, retry",
		})
	}

	metrics.PingsIngested.WithLabelValues(string(tripID)).Inc()

	if h.hub != nil {
		h.hub.BroadcastGPSUpdate(ping)
	}

	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
		"ping_id": string(ping.ID),
		"status":  "queued",
	})
}
