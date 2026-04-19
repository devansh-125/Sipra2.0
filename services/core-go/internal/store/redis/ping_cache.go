// Package redisstore implements the high-speed GPS ping buffer backed by Redis.
package redisstore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	// listKeyFmt is a per-trip Redis list that buffers incoming pings.
	listKeyFmt = "sipra:pings:%s"

	// activeTripsKey is a Redis Set that tracks every trip_id that currently
	// has at least one buffered ping. The flush worker iterates this set.
	activeTripsKey = "sipra:active_trips"
)

// drainScript atomically pops every item from the list in a single
// server-side operation. New RPUSH calls during the script go to the same
// key and are picked up on the next flush cycle — no data loss.
var drainScript = goredis.NewScript(`
local items = redis.call('LRANGE', KEYS[1], 0, -1)
if #items > 0 then redis.call('DEL', KEYS[1]) end
return items
`)

// pingRecord is the compact wire format written to Redis.
// Short field names reduce list-entry byte size under high-frequency ingest.
type pingRecord struct {
	ID         string   `json:"i"`
	TripID     string   `json:"t"`
	Lat        float64  `json:"la"`
	Lng        float64  `json:"lo"`
	HeadingDeg *float64 `json:"h,omitempty"`
	SpeedKPH   *float64 `json:"s,omitempty"`
	AccuracyM  *float64 `json:"a,omitempty"`
	RecordedAt int64    `json:"r"` // Unix nanoseconds
	IngestedAt int64    `json:"g"` // Unix nanoseconds
}

// PingCache buffers GPS pings in per-trip Redis lists for sub-millisecond
// writes, decoupling the IoT hot path from Postgres.
type PingCache struct {
	rdb *goredis.Client
}

// NewPingCache creates a PingCache backed by the given Redis client.
func NewPingCache(rdb *goredis.Client) *PingCache {
	return &PingCache{rdb: rdb}
}

// Push serialises p and appends it to the trip's Redis list, then registers
// the trip in the active-trips set. Both operations run in one pipeline
// round-trip so the handler returns in < 1 ms under normal conditions.
func (c *PingCache) Push(ctx context.Context, p domain.GPSPing) error {
	rec := pingRecord{
		ID:         string(p.ID),
		TripID:     string(p.TripID),
		Lat:        p.Location.Lat,
		Lng:        p.Location.Lng,
		HeadingDeg: p.HeadingDeg,
		SpeedKPH:   p.SpeedKPH,
		AccuracyM:  p.AccuracyM,
		RecordedAt: p.RecordedAt.UnixNano(),
		IngestedAt: p.IngestedAt.UnixNano(),
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("ping marshal: %w", err)
	}

	key := fmt.Sprintf(listKeyFmt, string(p.TripID))
	pipe := c.rdb.Pipeline()
	pipe.RPush(ctx, key, data)
	pipe.SAdd(ctx, activeTripsKey, string(p.TripID))
	_, err = pipe.Exec(ctx)
	return err
}

// OnFlushedFn is called after a successful batch insert for a trip.
// The corridor engine is wired in here so it recalculates after every flush.
type OnFlushedFn func(ctx context.Context, tripID domain.TripID)

// FlushPingsToDB is a blocking background worker. It ticks every interval,
// drains buffered pings for all active trips via an atomic Lua script,
// batch-inserts them into Postgres, and then calls onFlushed (if non-nil)
// so the corridor engine can recompute the exclusion envelope.
//
// The worker exits cleanly when ctx is cancelled (SIGTERM / SIGINT).
func (c *PingCache) FlushPingsToDB(
	ctx context.Context,
	interval time.Duration,
	insert func(ctx context.Context, pings []domain.GPSPing) error,
	onFlushed OnFlushedFn,
) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("ping flusher: shutting down")
			return
		case <-ticker.C:
			c.flush(ctx, insert, onFlushed)
		}
	}
}

func (c *PingCache) flush(
	ctx context.Context,
	insert func(ctx context.Context, pings []domain.GPSPing) error,
	onFlushed OnFlushedFn,
) {
	tripIDs, err := c.rdb.SMembers(ctx, activeTripsKey).Result()
	if err != nil {
		log.Error().Err(err).Msg("redis: list active trips")
		return
	}

	for _, tripID := range tripIDs {
		key := fmt.Sprintf(listKeyFmt, tripID)

		// Atomically drain the list. New pushes after this point land on a
		// freshly created key and are picked up next tick.
		val, err := drainScript.Run(ctx, c.rdb, []string{key}).Result()
		if err != nil {
			log.Error().Err(err).Str("trip", tripID).Msg("redis: drain script")
			continue
		}

		rawItems, _ := val.([]interface{})
		if len(rawItems) == 0 {
			// No pings buffered — remove from active set to avoid scanning
			// this trip every tick forever.
			c.rdb.SRem(ctx, activeTripsKey, tripID)
			continue
		}

		pings := make([]domain.GPSPing, 0, len(rawItems))
		for _, item := range rawItems {
			raw, ok := item.(string)
			if !ok {
				continue
			}
			var rec pingRecord
			if err := json.Unmarshal([]byte(raw), &rec); err != nil {
				log.Warn().Err(err).Str("trip", tripID).Msg("redis: skip corrupt ping record")
				continue
			}
			pings = append(pings, toDomainPing(rec))
		}

		if err := insert(ctx, pings); err != nil {
			log.Error().Err(err).
				Str("trip", tripID).
				Int("count", len(pings)).
				Msg("postgres: batch insert pings failed")
			continue
		}

		log.Debug().
			Str("trip", tripID).
			Int("count", len(pings)).
			Msg("flushed pings to postgres")

		if onFlushed != nil {
			// Run corridor recomputation in the background so the next tick
			// is not delayed by a slow PostGIS computation.
			go onFlushed(ctx, domain.TripID(tripID))
		}
	}
}

func toDomainPing(r pingRecord) domain.GPSPing {
	return domain.GPSPing{
		ID:         domain.PingID(r.ID),
		TripID:     domain.TripID(r.TripID),
		Location:   domain.Point{Lat: r.Lat, Lng: r.Lng},
		HeadingDeg: r.HeadingDeg,
		SpeedKPH:   r.SpeedKPH,
		AccuracyM:  r.AccuracyM,
		RecordedAt: time.Unix(0, r.RecordedAt).UTC(),
		IngestedAt: time.Unix(0, r.IngestedAt).UTC(),
	}
}
