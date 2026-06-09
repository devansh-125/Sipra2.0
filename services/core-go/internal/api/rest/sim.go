package rest

import (
	"encoding/json"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	redisstore "github.com/devansh-125/sipra/services/core-go/internal/store/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// SimHandler handles simulator-to-backend data-plane endpoints.
// These are unauthenticated dev/demo endpoints — never expose in production.
type SimHandler struct {
	hub      *ws.Hub
	fleetGeo *redisstore.FleetGeoStore
}

// NewSimHandler wires the dashboard hub and the Redis GEO fleet store.
// fleetGeo may be nil during tests; callers that pass nil get the legacy
// broadcast-only behaviour without GEO updates.
func NewSimHandler(hub *ws.Hub, fleetGeo *redisstore.FleetGeoStore) *SimHandler {
	return &SimHandler{hub: hub, fleetGeo: fleetGeo}
}

// fleetSnapshotItem is the minimum shape we need to GEO-index a vehicle.
// Other fields (status, heading_deg, route_id, reroute_status) ride along
// in the WS broadcast as raw JSON.
type fleetSnapshotItem struct {
	ID  string  `json:"id"`
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// UpdateFleet handles POST /api/v1/sim/fleet.
// Body: JSON array of fleet vehicles (matches FleetVehicle in types.ts).
// Effects:
//   - broadcasts a FLEET_UPDATE envelope to all connected dashboard clients,
//   - replaces the global Redis GEO snapshot (sipra:fleet:geo) so the
//     Risk Monitor can compute fleet density inside the ambulance corridor.
func (h *SimHandler) UpdateFleet(c *fiber.Ctx) error {
	body := c.Body()
	if len(body) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "empty body"})
	}
	if !json.Valid(body) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON"})
	}

	h.hub.BroadcastFleetUpdate(json.RawMessage(body))

	if h.fleetGeo != nil {
		var items []fleetSnapshotItem
		if err := json.Unmarshal(body, &items); err == nil {
			positions := make([]redisstore.FleetPosition, 0, len(items))
			for _, it := range items {
				positions = append(positions, redisstore.FleetPosition{
					ID:  it.ID,
					Lat: it.Lat,
					Lng: it.Lng,
				})
			}
			if err := h.fleetGeo.Snapshot(c.Context(), positions); err != nil {
				log.Warn().Err(err).Int("count", len(positions)).Msg("sim/fleet: GEO snapshot failed")
			}
		} else {
			log.Warn().Err(err).Msg("sim/fleet: skipping GEO update, body not a fleet array")
		}
	}

	return c.JSON(fiber.Map{"ok": true})
}
