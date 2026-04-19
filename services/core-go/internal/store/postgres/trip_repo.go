// Package pgstore implements the repository layer backed by PostgreSQL/PostGIS.
package pgstore

import (
	"context"
	"fmt"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TripRepo persists and retrieves Trip aggregates.
type TripRepo struct{ pool *pgxpool.Pool }

// NewTripRepo creates a TripRepo backed by the given connection pool.
func NewTripRepo(pool *pgxpool.Pool) *TripRepo { return &TripRepo{pool: pool} }

// sqlInsertTrip uses ST_MakePoint(lng, lat) — PostGIS convention is (X, Y) = (lng, lat).
const sqlInsertTrip = `
INSERT INTO trips (
    id, status, cargo_type, cargo_description, cargo_tolerance_celsius,
    origin, destination,
    golden_hour_deadline, ambulance_id, hospital_dispatch_id,
    created_at, updated_at
) VALUES (
    $1, $2::trip_status, $3::cargo_type, $4, $5,
    ST_SetSRID(ST_MakePoint($6, $7), 4326),
    ST_SetSRID(ST_MakePoint($8, $9), 4326),
    $10, $11, $12, $13, $13
)`

// Create stamps t with a new UUID and persists it.
// The caller must validate via t.Validate() before calling Create.
func (r *TripRepo) Create(ctx context.Context, t *domain.Trip) error {
	now := time.Now().UTC()
	t.ID = domain.TripID(uuid.New().String())
	t.Status = domain.TripStatusPending
	t.CreatedAt = now
	t.UpdatedAt = now

	_, err := r.pool.Exec(ctx, sqlInsertTrip,
		string(t.ID),
		string(t.Status),
		string(t.Cargo.Category),
		t.Cargo.Description,
		t.Cargo.ToleranceCelsius,
		t.Origin.Lng, t.Origin.Lat,      // MakePoint(X=lng, Y=lat)
		t.Destination.Lng, t.Destination.Lat,
		t.GoldenHourDeadline,
		t.AmbulanceID,
		nullableStr(t.HospitalDispatchID),
		now,
	)
	if err != nil {
		return fmt.Errorf("insert trip: %w", err)
	}
	return nil
}

// ST_X = longitude, ST_Y = latitude for a GEOMETRY(Point) stored as (lng, lat).
const sqlGetTrip = `
SELECT
    id, status,
    cargo_type, cargo_description, cargo_tolerance_celsius,
    ST_Y(origin)      AS origin_lat,
    ST_X(origin)      AS origin_lng,
    ST_Y(destination) AS dest_lat,
    ST_X(destination) AS dest_lng,
    golden_hour_deadline, started_at, completed_at,
    ambulance_id, hospital_dispatch_id,
    created_at, updated_at
FROM trips WHERE id = $1`

// GetByID retrieves a single trip. Returns a descriptive error on not-found.
func (r *TripRepo) GetByID(ctx context.Context, id domain.TripID) (*domain.Trip, error) {
	var (
		t                  domain.Trip
		idStr              string
		statusStr          string
		cargoTypeStr       string
		hospitalDispatchID *string
	)

	err := r.pool.QueryRow(ctx, sqlGetTrip, string(id)).Scan(
		&idStr, &statusStr,
		&cargoTypeStr, &t.Cargo.Description, &t.Cargo.ToleranceCelsius,
		&t.Origin.Lat, &t.Origin.Lng,
		&t.Destination.Lat, &t.Destination.Lng,
		&t.GoldenHourDeadline, &t.StartedAt, &t.CompletedAt,
		&t.AmbulanceID, &hospitalDispatchID,
		&t.CreatedAt, &t.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("trip %s: not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get trip %s: %w", id, err)
	}

	t.ID = domain.TripID(idStr)
	t.Status = domain.TripStatus(statusStr)
	t.Cargo.Category = domain.CargoCategory(cargoTypeStr)
	if hospitalDispatchID != nil {
		t.HospitalDispatchID = *hospitalDispatchID
	}
	return &t, nil
}

const sqlListInTransit = `
SELECT
    id, status,
    cargo_type, cargo_description, cargo_tolerance_celsius,
    ST_Y(origin)      AS origin_lat,
    ST_X(origin)      AS origin_lng,
    ST_Y(destination) AS dest_lat,
    ST_X(destination) AS dest_lng,
    golden_hour_deadline, started_at, completed_at,
    ambulance_id, hospital_dispatch_id,
    created_at, updated_at
FROM trips WHERE status = 'InTransit'`

// ListInTransit returns all trips currently in the InTransit state.
// The Risk Monitor calls this on every poll cycle.
func (r *TripRepo) ListInTransit(ctx context.Context) ([]domain.Trip, error) {
	rows, err := r.pool.Query(ctx, sqlListInTransit)
	if err != nil {
		return nil, fmt.Errorf("list in-transit trips: %w", err)
	}
	defer rows.Close()

	var trips []domain.Trip
	for rows.Next() {
		var (
			t                  domain.Trip
			idStr              string
			statusStr          string
			cargoTypeStr       string
			hospitalDispatchID *string
		)
		if err := rows.Scan(
			&idStr, &statusStr,
			&cargoTypeStr, &t.Cargo.Description, &t.Cargo.ToleranceCelsius,
			&t.Origin.Lat, &t.Origin.Lng,
			&t.Destination.Lat, &t.Destination.Lng,
			&t.GoldenHourDeadline, &t.StartedAt, &t.CompletedAt,
			&t.AmbulanceID, &hospitalDispatchID,
			&t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan in-transit trip: %w", err)
		}
		t.ID = domain.TripID(idStr)
		t.Status = domain.TripStatus(statusStr)
		t.Cargo.Category = domain.CargoCategory(cargoTypeStr)
		if hospitalDispatchID != nil {
			t.HospitalDispatchID = *hospitalDispatchID
		}
		trips = append(trips, t)
	}
	return trips, rows.Err()
}

const sqlUpdateStatus = `UPDATE trips SET status = $2::trip_status, updated_at = $3 WHERE id = $1`

// UpdateStatus persists a status transition that has already been validated by
// the domain's TransitionTo method.
func (r *TripRepo) UpdateStatus(ctx context.Context, id domain.TripID, status domain.TripStatus, now time.Time) error {
	_, err := r.pool.Exec(ctx, sqlUpdateStatus, string(id), string(status), now)
	if err != nil {
		return fmt.Errorf("update trip %s status -> %s: %w", id, status, err)
	}
	return nil
}

// nullableStr returns nil for the empty string so Postgres stores NULL rather
// than an empty TEXT value in optional columns.
func nullableStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
