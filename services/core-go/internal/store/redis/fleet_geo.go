package redisstore

import (
	"context"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// fleetGEOKey is the Redis GEO set holding the most recent fleet snapshot
// pushed by the simulator (POST /api/v1/sim/fleet). The Risk Monitor
// queries this key with GEOSEARCH to compute fleet density inside the
// 2 km corridor around the ambulance — which the AI brain uses as a
// residual-correction signal in its ETA prediction.
const fleetGEOKey = "sipra:fleet:geo"

// fleetGEOTTL bounds staleness — if the simulator stops publishing,
// the density counter naturally drops to zero rather than reporting
// a frozen snapshot.
const fleetGEOTTL = 90 * time.Second

// FleetGeoStore wraps a Redis client to publish + query fleet positions
// as a Redis GEO set. Used together with FleetTickPublisher (per-trip
// chaos streams) but operates on a single global key for the simulator
// data plane.
type FleetGeoStore struct {
	rdb *goredis.Client
}

// NewFleetGeoStore creates a FleetGeoStore backed by the given Redis client.
func NewFleetGeoStore(rdb *goredis.Client) *FleetGeoStore {
	return &FleetGeoStore{rdb: rdb}
}

// FleetPosition is the minimum information the GEO store needs per vehicle.
type FleetPosition struct {
	ID  string
	Lat float64
	Lng float64
}

// Snapshot replaces the fleet GEO set with `positions` atomically.
// Vehicles missing from the new snapshot are removed (DEL before GEOADD).
// Empty input clears the set.
func (s *FleetGeoStore) Snapshot(ctx context.Context, positions []FleetPosition) error {
	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, fleetGEOKey)
	if len(positions) > 0 {
		args := make([]*goredis.GeoLocation, 0, len(positions))
		for _, p := range positions {
			args = append(args, &goredis.GeoLocation{
				Name:      p.ID,
				Longitude: p.Lng,
				Latitude:  p.Lat,
			})
		}
		pipe.GeoAdd(ctx, fleetGEOKey, args...)
		pipe.Expire(ctx, fleetGEOKey, fleetGEOTTL)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("fleet geo snapshot: %w", err)
	}
	return nil
}

// CountInRadius returns the number of fleet vehicles within `radiusMeters`
// of the given lat/lng. Returns 0 (not an error) if the GEO key is empty
// or has expired — a stale-fleet condition is data, not a failure.
func (s *FleetGeoStore) CountInRadius(ctx context.Context, lat, lng float64, radiusMeters float64) (int, error) {
	res, err := s.rdb.GeoSearch(ctx, fleetGEOKey, &goredis.GeoSearchQuery{
		Longitude:  lng,
		Latitude:   lat,
		Radius:     radiusMeters,
		RadiusUnit: "m",
		// Sort/Count omitted — we only need the cardinality.
	}).Result()
	if err == goredis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("fleet geo search: %w", err)
	}
	return len(res), nil
}
