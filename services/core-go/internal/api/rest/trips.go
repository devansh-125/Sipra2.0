// Package rest contains the Fiber HTTP handlers for Sipra's public API.
package rest

import (
	"strings"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	pgstore "github.com/devansh-125/sipra/services/core-go/internal/store/postgres"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// TripHandler holds the dependencies needed by trip-related endpoints.
type TripHandler struct {
	trips *pgstore.TripRepo
}

// NewTripHandler constructs a TripHandler.
func NewTripHandler(trips *pgstore.TripRepo) *TripHandler {
	return &TripHandler{trips: trips}
}

// createTripRequest is the JSON body accepted by POST /api/v1/trips.
type createTripRequest struct {
	CargoCategory      string   `json:"cargo_category"`
	CargoDescription   string   `json:"cargo_description"`
	CargoToleranceC    *float64 `json:"cargo_tolerance_celsius"`
	Origin             pointDTO `json:"origin"`
	Destination        pointDTO `json:"destination"`
	GoldenHourDeadline string   `json:"golden_hour_deadline"` // RFC3339
	AmbulanceID        string   `json:"ambulance_id"`
	HospitalDispatchID string   `json:"hospital_dispatch_id"`
}

// pointDTO carries a WGS84 coordinate from the client.
type pointDTO struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// CreateTrip handles POST /api/v1/trips.
// It validates the request body via domain invariants, persists the new trip
// to Postgres, and returns 201 Created with the assigned trip ID.
//
//	POST /api/v1/trips
//	Body: { cargo_category, cargo_description, origin, destination,
//	         golden_hour_deadline (RFC3339), ambulance_id }
//	201: { trip_id, status }
func (h *TripHandler) CreateTrip(c *fiber.Ctx) error {
	var req createTripRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid JSON body",
		})
	}

	deadline, err := time.Parse(time.RFC3339, req.GoldenHourDeadline)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "golden_hour_deadline must be RFC3339 (e.g. 2025-04-19T15:00:00Z)",
		})
	}

	trip := &domain.Trip{
		Status: domain.TripStatusPending,
		Cargo: domain.Cargo{
			Category:         domain.CargoCategory(strings.Title(strings.ToLower(req.CargoCategory))),
			Description:      req.CargoDescription,
			ToleranceCelsius: req.CargoToleranceC,
		},
		Origin:             domain.Point{Lat: req.Origin.Lat, Lng: req.Origin.Lng},
		Destination:        domain.Point{Lat: req.Destination.Lat, Lng: req.Destination.Lng},
		GoldenHourDeadline: deadline.UTC(),
		AmbulanceID:        req.AmbulanceID,
		HospitalDispatchID: req.HospitalDispatchID,
	}

	// Domain validation runs in-process — no I/O required.
	if err := trip.Validate(time.Now()); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": err.Error(),
		})
	}

	if err := h.trips.Create(c.Context(), trip); err != nil {
		log.Error().Err(err).
			Str("ambulance", trip.AmbulanceID).
			Msg("create trip: postgres error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to create trip",
		})
	}

	log.Info().
		Str("trip_id", string(trip.ID)).
		Str("cargo", string(trip.Cargo.Category)).
		Str("ambulance", trip.AmbulanceID).
		Msg("trip created")

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"trip_id":              string(trip.ID),
		"status":               string(trip.Status),
		"golden_hour_deadline": trip.GoldenHourDeadline.Format(time.RFC3339),
	})
}

// GetTrip handles GET /api/v1/trips/:id.
func (h *TripHandler) GetTrip(c *fiber.Ctx) error {
	id := domain.TripID(c.Params("id"))
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "trip id is required"})
	}
	trip, err := h.trips.GetByID(c.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
		}
		log.Error().Err(err).Str("trip_id", string(id)).Msg("get trip: postgres error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch trip"})
	}
	return c.JSON(trip)
}

// StartTrip handles POST /api/v1/trips/:id/start.
// Transitions a Pending trip to InTransit so the risk monitor will begin evaluating it.
func (h *TripHandler) StartTrip(c *fiber.Ctx) error {
	id := domain.TripID(c.Params("id"))
	if id == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "trip id is required"})
	}
	trip, err := h.trips.GetByID(c.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
		}
		log.Error().Err(err).Str("trip_id", string(id)).Msg("start trip: fetch failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to fetch trip"})
	}
	now := time.Now().UTC()
	if err := trip.TransitionTo(domain.TripStatusInTransit, now); err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
	}
	if err := h.trips.UpdateStatus(c.Context(), trip.ID, domain.TripStatusInTransit, now); err != nil {
		log.Error().Err(err).Str("trip_id", string(id)).Msg("start trip: update status failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update trip status"})
	}
	log.Info().Str("trip_id", string(id)).Msg("trip started")
	return c.JSON(fiber.Map{
		"trip_id": string(trip.ID),
		"status":  string(domain.TripStatusInTransit),
	})
}
