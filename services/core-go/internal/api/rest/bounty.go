package rest

import (
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/bounty"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	pgstore "github.com/devansh-125/sipra/services/core-go/internal/store/postgres"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// BountyHandler handles the bounty sub-resource endpoints.
type BountyHandler struct {
	trips *pgstore.TripRepo
	repo  *bounty.Repo
	hub   *ws.Hub
}

// NewBountyHandler constructs a BountyHandler.
func NewBountyHandler(trips *pgstore.TripRepo, repo *bounty.Repo, hub *ws.Hub) *BountyHandler {
	return &BountyHandler{trips: trips, repo: repo, hub: hub}
}

// createBountyRequest is the JSON body for POST /api/v1/trips/:id/bounties.
type createBountyRequest struct {
	DriverRef        string  `json:"driver_ref"`
	PartnerID        *string `json:"partner_id,omitempty"`
	BaseAmountPoints int     `json:"base_amount_points"`
	CorridorLengthM  float64 `json:"corridor_length_m"`
	DeviationM       float64 `json:"deviation_m"`
	CheckpointLat    float64 `json:"checkpoint_lat"`
	CheckpointLng    float64 `json:"checkpoint_lng"`
	CheckpointRadius int     `json:"checkpoint_radius_m"`
	ExpiresAt        string  `json:"expires_at"` // RFC3339
}

// CreateBounty handles POST /api/v1/trips/:id/bounties.
// Computes surge-adjusted amount, persists the bounty, returns 201.
func (h *BountyHandler) CreateBounty(c *fiber.Ctx) error {
	tripID := domain.TripID(c.Params("id"))
	if tripID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "trip id is required"})
	}

	var req createBountyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}
	if req.DriverRef == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "driver_ref is required"})
	}
	if req.BaseAmountPoints <= 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "base_amount_points must be > 0"})
	}
	if req.CheckpointRadius <= 0 {
		req.CheckpointRadius = 50
	}

	expiresAt, err := time.Parse(time.RFC3339, req.ExpiresAt)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "expires_at must be RFC3339 (e.g. 2025-04-19T15:30:00Z)",
		})
	}

	trip, err := h.trips.GetByID(c.Context(), tripID)
	if err != nil {
		log.Error().Err(err).Str("trip_id", string(tripID)).Msg("create bounty: fetch trip failed")
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "trip not found"})
	}

	amount := bounty.CalculateSurge(trip, req.CorridorLengthM, req.DeviationM, req.BaseAmountPoints)

	b := &domain.Bounty{
		TripID:           tripID,
		DriverRef:        req.DriverRef,
		PartnerID:        req.PartnerID,
		AmountPoints:     amount,
		Checkpoint:       domain.Point{Lat: req.CheckpointLat, Lng: req.CheckpointLng},
		CheckpointRadius: req.CheckpointRadius,
		ExpiresAt:        expiresAt.UTC(),
	}

	if err := h.repo.Create(c.Context(), b); err != nil {
		log.Error().Err(err).Str("trip_id", string(tripID)).Msg("create bounty: insert failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create bounty"})
	}

	log.Info().
		Str("bounty_id", string(b.ID)).
		Str("trip_id", string(tripID)).
		Int("amount_points", amount).
		Msg("bounty created")

	return c.Status(fiber.StatusCreated).JSON(b)
}

// ClaimBounty handles POST /api/v1/bounties/:id/claim.
func (h *BountyHandler) ClaimBounty(c *fiber.Ctx) error {
	id := domain.BountyID(c.Params("id"))
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "bounty id is required"})
	}

	if err := h.repo.Claim(c.Context(), id); err != nil {
		log.Error().Err(err).Str("bounty_id", string(id)).Msg("claim bounty: failed")
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	}

	// Read back the bounty to get driver_ref and trip_id for the broadcast.
	b, err := h.repo.GetByID(c.Context(), id)
	if err != nil {
		log.Warn().Err(err).Str("bounty_id", string(id)).Msg("claim bounty: read-back failed (broadcast skipped)")
	} else {
		h.hub.BroadcastRerouteStatus(b.DriverRef, string(b.TripID), "rerouting", string(b.ID), 0)
	}

	log.Info().Str("bounty_id", string(id)).Msg("bounty claimed")
	return c.JSON(fiber.Map{"bounty_id": string(id), "status": string(domain.BountyStatusClaimed)})
}

// verifyBountyRequest is the JSON body for POST /api/v1/bounties/:id/verify.
type verifyBountyRequest struct {
	PingLat float64 `json:"ping_lat"`
	PingLng float64 `json:"ping_lng"`
}

// VerifyBounty handles POST /api/v1/bounties/:id/verify.
// Confirms via ST_DWithin that the driver physically reached the checkpoint.
func (h *BountyHandler) VerifyBounty(c *fiber.Ctx) error {
	id := domain.BountyID(c.Params("id"))
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "bounty id is required"})
	}

	var req verifyBountyRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid JSON body"})
	}

	if err := h.repo.Verify(c.Context(), id, req.PingLat, req.PingLng); err != nil {
		log.Error().Err(err).Str("bounty_id", string(id)).Msg("verify bounty: failed")
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	}

	// Read back the verified bounty to broadcast the completion with points.
	b, err := h.repo.GetByID(c.Context(), id)
	if err != nil {
		log.Warn().Err(err).Str("bounty_id", string(id)).Msg("verify bounty: read-back failed (broadcast skipped)")
	} else {
		h.hub.BroadcastRerouteStatus(b.DriverRef, string(b.TripID), "completed", string(b.ID), b.AmountPoints)
	}

	log.Info().Str("bounty_id", string(id)).Msg("bounty verified")
	return c.JSON(fiber.Map{"bounty_id": string(id), "status": string(domain.BountyStatusVerified)})
}
