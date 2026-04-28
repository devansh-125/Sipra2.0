package redisstore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	goredis "github.com/redis/go-redis/v9"
)

type FleetTickPublisher struct {
	rdb           *goredis.Client
	maxLen        int64
	streamKeyFmt  string
	channelKeyFmt string
	geoKeyFmt     string
}

func NewFleetTickPublisher(rdb *goredis.Client, maxLen int64) *FleetTickPublisher {
	return &FleetTickPublisher{
		rdb:           rdb,
		maxLen:        maxLen,
		streamKeyFmt:  "sipra:sim:%s:fleet:stream",
		channelKeyFmt: "sipra:sim:%s:fleet:pubsub",
		geoKeyFmt:     "sipra:sim:%s:fleet:geo",
	}
}

func (p *FleetTickPublisher) PublishTick(
	ctx context.Context,
	tripID string,
	tick int,
	timestamp time.Time,
	fleet []ws.FleetVehicle,
) error {
	raw, err := json.Marshal(fleet)
	if err != nil {
		return fmt.Errorf("fleet tick marshal: %w", err)
	}

	streamKey := fmt.Sprintf(p.streamKeyFmt, tripID)
	channelKey := fmt.Sprintf(p.channelKeyFmt, tripID)
	geoKey := fmt.Sprintf(p.geoKeyFmt, tripID)

	pipe := p.rdb.Pipeline()
	pipe.Del(ctx, geoKey)
	for _, v := range fleet {
		pipe.GeoAdd(ctx, geoKey, &goredis.GeoLocation{
			Name:      v.ID,
			Longitude: v.Lng,
			Latitude:  v.Lat,
		})
	}
	pipe.Expire(ctx, geoKey, 3*time.Minute)
	pipe.XAdd(ctx, &goredis.XAddArgs{
		Stream: streamKey,
		MaxLen: p.maxLen,
		Approx: false,
		ID:     "*",
		Values: map[string]interface{}{
			"trip_id": tripID,
			"tick":    tick,
			"ts_ms":   timestamp.UnixMilli(),
			"fleet":   raw,
		},
	})
	pipe.Publish(ctx, channelKey, raw)
	_, err = pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("fleet tick redis pipeline: %w", err)
	}
	return nil
}
