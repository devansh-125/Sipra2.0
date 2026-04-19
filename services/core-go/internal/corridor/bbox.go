// Package corridor implements the PostGIS-powered rolling exclusion envelope.
package corridor

import (
	"context"
	"fmt"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// OnCorridorUpdated is invoked after a new corridor row is committed.
// It runs in a detached goroutine so the caller's transaction is never coupled
// to downstream side-effects such as webhook delivery or WebSocket broadcast.
type OnCorridorUpdated func(
	ctx context.Context,
	tripID domain.TripID,
	corridorID string,
	version, bufferMeters int,
	polygonGeoJSON string,
)

// Engine computes rolling spatial exclusion corridors using PostGIS.
// Each CalculateRollingCorridor call runs in a single serializable transaction.
type Engine struct {
	pool         *pgxpool.Pool
	pingWindow   int
	bufferMeters int
	onUpdated    OnCorridorUpdated
}

// NewEngine creates a corridor Engine.
// pingWindow controls how many recent pings form the linestring;
// bufferMeters is the ST_Buffer radius (metres via geography cast).
func NewEngine(pool *pgxpool.Pool, pingWindow, bufferMeters int) *Engine {
	return &Engine{pool: pool, pingWindow: pingWindow, bufferMeters: bufferMeters}
}

// SetOnUpdated registers a post-commit hook. Safe to call once at startup only.
func (e *Engine) SetOnUpdated(fn OnCorridorUpdated) {
	e.onUpdated = fn
}

// sqlComputeEnvelope builds the buffered corridor polygon.
// ORDER BY recorded_at ASC on ST_MakeLine ensures chronological line direction.
// The CASE falls back to a point buffer when fewer than two pings exist.
// HAVING COUNT(*) > 0 lets the caller distinguish "no pings" from a real error.
const sqlComputeEnvelope = `
WITH recent AS (
    SELECT location, recorded_at
    FROM   gps_pings
    WHERE  trip_id = $1
    ORDER  BY recorded_at DESC
    LIMIT  $2
)
SELECT ST_AsEWKT(
    ST_Buffer(
        CASE WHEN COUNT(*) >= 2
             THEN ST_MakeLine(location ORDER BY recorded_at ASC)
             ELSE MAX(location)
        END::geography,
        $3
    )::geometry
)
FROM   recent
HAVING COUNT(*) > 0`

const sqlCloseCurrentCorridor = `
UPDATE corridors
SET    valid_until = NOW()
WHERE  trip_id = $1 AND valid_until IS NULL`

const sqlNextVersion = `
SELECT COALESCE(MAX(version), 0) + 1
FROM   corridors
WHERE  trip_id = $1`

const sqlInsertCorridor = `
INSERT INTO corridors (trip_id, version, envelope, buffer_meters, valid_from)
VALUES ($1, $2, ST_GeomFromEWKT($3), $4, NOW())
RETURNING id, version, ST_AsGeoJSON(envelope)`

// CalculateRollingCorridor recomputes and persists the exclusion envelope for
// tripID atomically. Returns nil immediately when the trip has no pings yet.
// Safe to call concurrently for distinct trip IDs.
func (e *Engine) CalculateRollingCorridor(ctx context.Context, tripID domain.TripID) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var ewkt string
	err = tx.QueryRow(ctx, sqlComputeEnvelope,
		string(tripID), e.pingWindow, e.bufferMeters,
	).Scan(&ewkt)
	if err == pgx.ErrNoRows {
		log.Debug().Str("trip", string(tripID)).Msg("corridor: no pings yet, skipping")
		return nil
	}
	if err != nil {
		return fmt.Errorf("compute envelope trip=%s: %w", tripID, err)
	}

	if _, err = tx.Exec(ctx, sqlCloseCurrentCorridor, string(tripID)); err != nil {
		return fmt.Errorf("close previous corridor trip=%s: %w", tripID, err)
	}

	var version int
	if err = tx.QueryRow(ctx, sqlNextVersion, string(tripID)).Scan(&version); err != nil {
		return fmt.Errorf("next version trip=%s: %w", tripID, err)
	}

	var corridorID, geoJSON string
	err = tx.QueryRow(ctx, sqlInsertCorridor,
		string(tripID), version, ewkt, e.bufferMeters,
	).Scan(&corridorID, &version, &geoJSON)
	if err != nil {
		return fmt.Errorf("insert corridor trip=%s: %w", tripID, err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit corridor trip=%s: %w", tripID, err)
	}

	log.Info().
		Str("trip", string(tripID)).
		Str("corridor_id", corridorID).
		Int("version", version).
		Int("buffer_m", e.bufferMeters).
		Msg("corridor updated")

	if e.onUpdated != nil {
		hook := e.onUpdated
		bufferMeters := e.bufferMeters
		// Detach from the caller's context so flusher cancellation cannot
		// silently abort in-flight webhook or WebSocket deliveries.
		go hook(context.Background(), tripID, corridorID, version, bufferMeters, geoJSON)
	}

	return nil
}
