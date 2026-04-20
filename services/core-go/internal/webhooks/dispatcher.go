// Package webhooks implements the B2B outbound corridor-event dispatcher.
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// ExclusionZonePayload is the JSON body POSTed to every active partner when a
// trip's rolling corridor is recomputed. PolygonGeoJSON is forwarded as-is
// from PostGIS so partners can consume standard GeoJSON without adaptation.
type ExclusionZonePayload struct {
	TripID         string          `json:"trip_id"`
	CorridorID     string          `json:"corridor_id"`
	Version        int             `json:"version"`
	BufferMeters   int             `json:"buffer_meters"`
	PolygonGeoJSON json.RawMessage `json:"polygon_geojson"`
	Timestamp      time.Time       `json:"timestamp"`
}

type partner struct {
	ID        string
	Name      string
	URL       string
	Secret    string
	TimeoutMS int
}

// job is pre-serialized once per broadcast so all workers send identical bytes,
// which is required for HMAC signatures to be consistent across partners.
type job struct {
	partner partner
	body    []byte
	tripID  string
}

// Dispatcher fans out corridor updates to every active partner via a fixed
// worker pool. BroadcastCorridor is safe to call from concurrent goroutines.
type Dispatcher struct {
	pool   *pgxpool.Pool
	client *http.Client
	jobs   chan job
	wg     sync.WaitGroup

	startOnce sync.Once
	stopOnce  sync.Once
	stopped   chan struct{}
}

// Config holds the tunable parameters for NewDispatcher.
type Config struct {
	// QueueSize caps the internal jobs channel; overflow jobs are dropped, not
	// blocked, to keep the corridor hook off the critical path.
	QueueSize int

	// HTTPTimeout is the default per-POST ceiling. A per-partner timeout_ms
	// column overrides this value when set.
	HTTPTimeout time.Duration
}

// NewDispatcher creates a Dispatcher backed by pool. Call Start before the
// first BroadcastCorridor.
func NewDispatcher(pool *pgxpool.Pool, cfg Config) *Dispatcher {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 1024
	}
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 5 * time.Second
	}

	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}

	return &Dispatcher{
		pool: pool,
		client: &http.Client{
			Transport: transport,
			Timeout:   cfg.HTTPTimeout,
		},
		jobs:    make(chan job, cfg.QueueSize),
		stopped: make(chan struct{}),
	}
}

// Start spawns workers goroutines that drain the jobs channel. Idempotent.
func (d *Dispatcher) Start(workers int) {
	d.startOnce.Do(func() {
		if workers <= 0 {
			workers = 4
		}
		for i := 0; i < workers; i++ {
			d.wg.Add(1)
			go d.worker(i)
		}
		log.Info().Int("workers", workers).Msg("webhook dispatcher: started")
	})
}

// Stop closes the jobs channel and waits for all in-flight deliveries to finish.
func (d *Dispatcher) Stop() {
	d.stopOnce.Do(func() {
		close(d.stopped)
		close(d.jobs)
		d.wg.Wait()
		log.Info().Msg("webhook dispatcher: stopped")
	})
}

// BroadcastCorridor queries active partners, serializes the payload once, and
// enqueues one HTTP POST job per partner. Returns the number of jobs enqueued.
// A zero return with nil error means no active subscribers — not an error.
//
// ctx governs only the DB query; each partner POST runs under its own timeout.
func (d *Dispatcher) BroadcastCorridor(
	ctx context.Context,
	tripID, corridorID string,
	version, bufferMeters int,
	polygonGeoJSON string,
) (int, error) {
	select {
	case <-d.stopped:
		return 0, fmt.Errorf("dispatcher: stopped")
	default:
	}

	partners, err := d.listActivePartners(ctx)
	if err != nil {
		return 0, fmt.Errorf("list partners: %w", err)
	}
	if len(partners) == 0 {
		return 0, nil
	}

	payload := ExclusionZonePayload{
		TripID:         tripID,
		CorridorID:     corridorID,
		Version:        version,
		BufferMeters:   bufferMeters,
		PolygonGeoJSON: json.RawMessage(polygonGeoJSON),
		Timestamp:      time.Now().UTC(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("marshal payload: %w", err)
	}

	enqueued := 0
	for _, p := range partners {
		select {
		case d.jobs <- job{partner: p, body: body, tripID: tripID}:
			enqueued++
		default:
			log.Warn().
				Str("partner", p.Name).
				Str("trip", tripID).
				Msg("webhook dispatcher: queue full, dropping job")
		}
	}
	return enqueued, nil
}

const sqlListActivePartners = `
SELECT id, name, webhook_url, hmac_secret, timeout_ms
FROM   webhook_partners
WHERE  active = TRUE`

func (d *Dispatcher) listActivePartners(ctx context.Context) ([]partner, error) {
	rows, err := d.pool.Query(ctx, sqlListActivePartners)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []partner
	for rows.Next() {
		var p partner
		if err := rows.Scan(&p.ID, &p.Name, &p.URL, &p.Secret, &p.TimeoutMS); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *Dispatcher) worker(id int) {
	defer d.wg.Done()
	for j := range d.jobs {
		d.dispatch(j)
	}
	log.Debug().Int("worker", id).Msg("webhook dispatcher: worker exit")
}

// retryDelays is a package-level var so tests can override it without forking
// the binary. Production values: 500ms → 2s → 8s (×4 exponential backoff).
var retryDelays = []time.Duration{
	500 * time.Millisecond,
	2 * time.Second,
	8 * time.Second,
}

const maxAttempts = 3

// dispatch sends a signed POST to the partner with exponential backoff retry.
// It retries on network errors and 5xx responses; 4xx responses are treated as
// authoritative failures and not retried. Cancelled via d.stopped.
func (d *Dispatcher) dispatch(j job) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			delay := retryDelays[attempt-2]
			select {
			case <-d.stopped:
				return
			case <-time.After(delay):
			}
		}

		if d.doPost(j, attempt) {
			return
		}
	}
}

// doPost performs a single HTTP POST and returns true when the delivery is
// considered final (2xx/3xx/4xx). Returns false on network errors or 5xx,
// signalling the caller to retry.
func (d *Dispatcher) doPost(j job, attempt int) bool {
	timeout := time.Duration(j.partner.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = d.client.Timeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.partner.URL, bytes.NewReader(j.body))
	if err != nil {
		log.Error().Err(err).
			Str("partner", j.partner.Name).
			Int("attempt", attempt).
			Msg("webhook: build request")
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "sipra-core/1.0")
	req.Header.Set("X-Sipra-Partner", j.partner.Name)
	req.Header.Set("X-Sipra-Trip", j.tripID)
	req.Header.Set("X-Sipra-Signature", sign(j.partner.Secret, j.body))

	started := time.Now()
	resp, err := d.client.Do(req)
	latency := time.Since(started)

	if err != nil {
		log.Error().Err(err).
			Str("partner", j.partner.Name).
			Str("trip", j.tripID).
			Int("attempt", attempt).
			Dur("latency", latency).
			Msg("webhook: partner POST failed")
		return false
	}
	defer resp.Body.Close()

	evt := log.Info()
	if resp.StatusCode >= 400 {
		evt = log.Warn()
	}
	evt.Str("partner", j.partner.Name).
		Str("trip", j.tripID).
		Int("status", resp.StatusCode).
		Int("attempt", attempt).
		Dur("latency", latency).
		Msg("webhook: delivered")

	// 5xx is a transient server error — worth retrying.
	return resp.StatusCode < 500
}

// sign returns "sha256=<hex>" using the partner's shared secret.
// Partners verify this header with constant-time comparison.
func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
