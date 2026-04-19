// Package domain holds Sipra's core business entities and invariants.
//
// Rules of this package:
//   - Only the Go standard library may be imported.
//   - No knowledge of HTTP, SQL, Redis, JSON wire formats beyond struct tags,
//     or any third-party library.
//   - Behavior that can be expressed as a pure function on these types belongs
//     here; anything that needs I/O belongs in an outer layer.
package domain

import (
	"errors"
	"time"
)

// -----------------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------------

// TripID uniquely identifies a bio-logistics mission.
type TripID string

// PingID uniquely identifies a single GPS sample.
type PingID string

// CorridorID uniquely identifies a version of an exclusion envelope.
type CorridorID string

// -----------------------------------------------------------------------------
// Value objects
// -----------------------------------------------------------------------------

// Point is a WGS84 coordinate. Lat/Lng are in decimal degrees.
type Point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// Polygon is an ordered, closed ring of points (first == last).
// The domain does not prescribe a wire format; the store layer maps this to
// PostGIS GEOMETRY(Polygon, 4326).
type Polygon []Point

// -----------------------------------------------------------------------------
// Enumerations
// -----------------------------------------------------------------------------

// TripStatus is the state of a mission in the orchestrator's state machine.
type TripStatus string

const (
	TripStatusPending      TripStatus = "Pending"
	TripStatusInTransit    TripStatus = "InTransit"
	TripStatusDroneHandoff TripStatus = "DroneHandoff"
	TripStatusCompleted    TripStatus = "Completed"
	TripStatusFailed       TripStatus = "Failed"
)

// Valid reports whether the status is one of the defined enum values.
func (s TripStatus) Valid() bool {
	switch s {
	case TripStatusPending, TripStatusInTransit,
		TripStatusDroneHandoff, TripStatusCompleted, TripStatusFailed:
		return true
	}
	return false
}

// CargoCategory classifies the payload for survival/handling rules.
type CargoCategory string

const (
	CargoOrgan      CargoCategory = "Organ"
	CargoVaccine    CargoCategory = "Vaccine"
	CargoBlood      CargoCategory = "Blood"
	CargoMedication CargoCategory = "Medication"
)

// Valid reports whether the cargo category is one of the defined enum values.
func (c CargoCategory) Valid() bool {
	switch c {
	case CargoOrgan, CargoVaccine, CargoBlood, CargoMedication:
		return true
	}
	return false
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

var (
	ErrInvalidStatus     = errors.New("domain: invalid trip status")
	ErrInvalidTransition = errors.New("domain: illegal trip status transition")
	ErrInvalidCargo      = errors.New("domain: invalid cargo category")
	ErrExpiredDeadline   = errors.New("domain: golden-hour deadline already elapsed")
)

// -----------------------------------------------------------------------------
// Entities
// -----------------------------------------------------------------------------

// Cargo describes the payload and its handling envelope. The ToleranceCelsius
// field is optional; a nil pointer means "not temperature-controlled."
type Cargo struct {
	Category          CargoCategory `json:"category"`
	Description       string        `json:"description"`
	ToleranceCelsius  *float64      `json:"tolerance_celsius,omitempty"`
}

// Trip is the aggregate root. Invariants about status transitions and deadline
// enforcement live on this type — callers should never mutate Status directly.
type Trip struct {
	ID     TripID     `json:"id"`
	Status TripStatus `json:"status"`

	Cargo       Cargo `json:"cargo"`
	Origin      Point `json:"origin"`
	Destination Point `json:"destination"`

	GoldenHourDeadline time.Time  `json:"golden_hour_deadline"`
	StartedAt          *time.Time `json:"started_at,omitempty"`
	CompletedAt        *time.Time `json:"completed_at,omitempty"`

	AmbulanceID        string `json:"ambulance_id"`
	HospitalDispatchID string `json:"hospital_dispatch_id,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// GPSPing is one sample of the ambulance's telemetry. Optional fields use
// pointers so the domain can distinguish "unknown" from "zero."
type GPSPing struct {
	ID     PingID `json:"id"`
	TripID TripID `json:"trip_id"`

	Location   Point    `json:"location"`
	HeadingDeg *float64 `json:"heading_deg,omitempty"`
	SpeedKPH   *float64 `json:"speed_kph,omitempty"`
	AccuracyM  *float64 `json:"accuracy_m,omitempty"`

	RecordedAt time.Time `json:"recorded_at"`
	IngestedAt time.Time `json:"ingested_at"`
}

// Corridor is a versioned rolling exclusion polygon around the ambulance.
// A nil ValidUntil means "current" — only one row per trip should be current
// at any time (enforced at the store layer, not here).
type Corridor struct {
	ID      CorridorID `json:"id"`
	TripID  TripID     `json:"trip_id"`
	Version int        `json:"version"`

	Envelope      Polygon `json:"envelope"`
	BufferMeters  int     `json:"buffer_meters"`

	ValidFrom  time.Time  `json:"valid_from"`
	ValidUntil *time.Time `json:"valid_until,omitempty"`

	CreatedAt time.Time `json:"created_at"`
}

// -----------------------------------------------------------------------------
// Behavior
// -----------------------------------------------------------------------------

// RemainingGoldenHour reports the time left before the cargo expires.
// Returns 0 once the deadline has passed (never negative).
func (t Trip) RemainingGoldenHour(now time.Time) time.Duration {
	remaining := t.GoldenHourDeadline.Sub(now)
	if remaining < 0 {
		return 0
	}
	return remaining
}

// IsExpired reports whether the golden-hour deadline has elapsed.
func (t Trip) IsExpired(now time.Time) bool {
	return !now.Before(t.GoldenHourDeadline)
}

// IsTerminal reports whether the trip is in an end state and should no longer
// receive GPS pings or corridor updates.
func (t Trip) IsTerminal() bool {
	return t.Status == TripStatusCompleted || t.Status == TripStatusFailed
}

// CanTransitionTo reports whether `next` is a legal successor of the current
// status under Sipra's orchestration state machine.
//
//	Pending      -> InTransit | Failed
//	InTransit    -> DroneHandoff | Completed | Failed
//	DroneHandoff -> Completed | Failed
//	Completed    -> (terminal)
//	Failed       -> (terminal)
func (t Trip) CanTransitionTo(next TripStatus) bool {
	if !next.Valid() {
		return false
	}
	switch t.Status {
	case TripStatusPending:
		return next == TripStatusInTransit || next == TripStatusFailed
	case TripStatusInTransit:
		return next == TripStatusDroneHandoff ||
			next == TripStatusCompleted ||
			next == TripStatusFailed
	case TripStatusDroneHandoff:
		return next == TripStatusCompleted || next == TripStatusFailed
	case TripStatusCompleted, TripStatusFailed:
		return false
	}
	return false
}

// TransitionTo applies a legal status change to the trip, returning an error
// if the transition violates the state machine. The caller is responsible for
// persisting the mutated trip.
func (t *Trip) TransitionTo(next TripStatus, now time.Time) error {
	if !t.CanTransitionTo(next) {
		return ErrInvalidTransition
	}
	t.Status = next
	t.UpdatedAt = now
	switch next {
	case TripStatusInTransit:
		if t.StartedAt == nil {
			started := now
			t.StartedAt = &started
		}
	case TripStatusCompleted, TripStatusFailed:
		if t.CompletedAt == nil {
			completed := now
			t.CompletedAt = &completed
		}
	}
	return nil
}

// Validate checks the aggregate invariants that must hold at construction
// time. The store layer should call this before persisting a new Trip.
func (t Trip) Validate(now time.Time) error {
	if !t.Status.Valid() {
		return ErrInvalidStatus
	}
	if !t.Cargo.Category.Valid() {
		return ErrInvalidCargo
	}
	if !t.GoldenHourDeadline.After(now) {
		return ErrExpiredDeadline
	}
	return nil
}
