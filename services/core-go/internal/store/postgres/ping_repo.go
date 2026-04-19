package pgstore

import (
	"context"
	"fmt"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PingRepo persists GPS pings to the gps_pings table.
type PingRepo struct{ pool *pgxpool.Pool }

// NewPingRepo creates a PingRepo backed by the given connection pool.
func NewPingRepo(pool *pgxpool.Pool) *PingRepo { return &PingRepo{pool: pool} }

// sqlInsertPing uses ON CONFLICT DO NOTHING so re-delivered pings from the
// Redis buffer are idempotent (the UUID primary key is the dedup key).
const sqlInsertPing = `
INSERT INTO gps_pings (
    id, trip_id, location,
    heading_deg, speed_kph, accuracy_m,
    recorded_at, ingested_at
) VALUES (
    $1, $2,
    ST_SetSRID(ST_MakePoint($3, $4), 4326),
    $5, $6, $7, $8, $9
)
ON CONFLICT (id) DO NOTHING`

const sqlGetLatestPing = `
SELECT
    id, trip_id,
    ST_Y(location) AS lat,
    ST_X(location) AS lng,
    heading_deg, speed_kph, accuracy_m,
    recorded_at, ingested_at
FROM gps_pings
WHERE trip_id = $1
ORDER BY recorded_at DESC
LIMIT 1`

// GetLatest returns the most recent GPS ping for a trip.
// Returns an error if no pings exist yet.
func (r *PingRepo) GetLatest(ctx context.Context, tripID domain.TripID) (*domain.GPSPing, error) {
	var (
		p       domain.GPSPing
		idStr   string
		tripStr string
	)
	err := r.pool.QueryRow(ctx, sqlGetLatestPing, string(tripID)).Scan(
		&idStr, &tripStr,
		&p.Location.Lat, &p.Location.Lng,
		&p.HeadingDeg, &p.SpeedKPH, &p.AccuracyM,
		&p.RecordedAt, &p.IngestedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("no pings for trip %s", tripID)
	}
	if err != nil {
		return nil, fmt.Errorf("get latest ping for trip %s: %w", tripID, err)
	}
	p.ID = domain.PingID(idStr)
	p.TripID = domain.TripID(tripStr)
	return &p, nil
}

// BatchInsert writes a slice of pings to Postgres in a single network
// round-trip using pgx's pipelined batch API.
// Callers should pass the full set drained from Redis for one flush cycle.
func (r *PingRepo) BatchInsert(ctx context.Context, pings []domain.GPSPing) error {
	if len(pings) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for _, p := range pings {
		batch.Queue(sqlInsertPing,
			string(p.ID), string(p.TripID),
			p.Location.Lng, p.Location.Lat, // MakePoint(X=lng, Y=lat)
			p.HeadingDeg, p.SpeedKPH, p.AccuracyM,
			p.RecordedAt, p.IngestedAt,
		)
	}

	br := r.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := range pings {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("batch ping[%d] id=%s: %w", i, pings[i].ID, err)
		}
	}
	// Close flushes remaining pipeline results and surfaces any connection error.
	return br.Close()
}
