package rest

import (
	"encoding/json"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/gofiber/fiber/v2"
)

// SimHandler handles simulator-to-backend data-plane endpoints.
// These are unauthenticated dev/demo endpoints — never expose in production.
type SimHandler struct {
	hub *ws.Hub
}

func NewSimHandler(hub *ws.Hub) *SimHandler {
	return &SimHandler{hub: hub}
}

// UpdateFleet handles POST /api/v1/sim/fleet.
// Body: JSON array of fleet vehicles (matches FleetVehicle in types.ts).
// Broadcasts a FLEET_UPDATE envelope to all connected dashboard clients.
func (h *SimHandler) UpdateFleet(c *fiber.Ctx) error {
	body := c.Body()
	if len(body) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "empty body"})
	}
	if !json.Valid(body) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON"})
	}
	h.hub.BroadcastFleetUpdate(json.RawMessage(body))
	return c.JSON(fiber.Map{"ok": true})
}
