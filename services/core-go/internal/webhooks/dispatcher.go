// Package webhooks implements the B2B outbound corridor-event dispatcher.
//
// BroadcastCorridor produces one Kafka message per active partner; a pool of
// consumer goroutines started by StartConsumers drains that topic and performs
// the signed HTTP POST with retry. Kafka — not Go process memory — is the
// durability boundary: a crash between produce and consumer commit redelivers
// the message on restart instead of silently dropping it.
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

	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	"github.com/jackc/pgx/v5/pgxpool"
	kafka "github.com/segmentio/kafka-go"
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

// job is pre-serialized once per broadcast so all partners receive identical
// bytes, which is required for HMAC signatures to be consistent. It is also
// the wire format written to and read back from Kafka, so every field must be
// exported for encoding/json to round-trip it.
type job struct {
	Partner partner
	Body    []byte
	TripID  string
}

// Dispatcher fans out corridor updates to every active partner via Kafka:
// BroadcastCorridor produces one message per partner, keyed by partner ID so
// a single partner's deliveries stay ordered on one topic partition, and the
// consumer goroutines started by StartConsumers perform the actual signed
// HTTP POST.
type Dispatcher struct {
	pool     *pgxpool.Pool
	client   *http.Client
	producer *kafka.Writer

	brokers []string
	topic   string
	groupID string

	wg       sync.WaitGroup
	stopOnce sync.Once
	stopped  chan struct{}
}

// Config holds the tunable parameters for NewDispatcher.
type Config struct {
	// HTTPTimeout is the default per-POST ceiling. A per-partner timeout_ms
	// column overrides this value when set.
	HTTPTimeout time.Duration

	// KafkaBrokers is the bootstrap broker list (host:port, ...) backing the
	// delivery queue.
	KafkaBrokers []string
	// KafkaTopic holds per-partner delivery jobs.
	KafkaTopic string
	// KafkaGroupID is the consumer group shared by every StartConsumers
	// goroutine — and, when core-go is scaled to multiple replicas, every
	// replica — so each job is delivered to exactly one consumer.
	KafkaGroupID string
}

// NewDispatcher creates a Dispatcher backed by pool and a Kafka writer. Call
// StartConsumers before the first BroadcastCorridor is expected to be drained.
func NewDispatcher(pool *pgxpool.Pool, cfg Config) *Dispatcher {
	if cfg.HTTPTimeout <= 0 {
		cfg.HTTPTimeout = 5 * time.Second
	}
	if cfg.KafkaTopic == "" {
		cfg.KafkaTopic = "sipra.webhook.deliveries"
	}
	if cfg.KafkaGroupID == "" {
		cfg.KafkaGroupID = "sipra-webhook-dispatcher"
	}

	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}

	producer := &kafka.Writer{
		Addr:         kafka.TCP(cfg.KafkaBrokers...),
		Topic:        cfg.KafkaTopic,
		Balancer:     &kafka.Hash{}, // same partner ID -> same partition -> ordered per partner
		BatchTimeout: 100 * time.Millisecond,
		RequiredAcks: kafka.RequireOne,
		// kafka-go gates auto-creation on this flag regardless of the
		// broker's auto.create.topics.enable — without it every first
		// produce to a not-yet-created topic fails UNKNOWN_TOPIC_OR_PARTITION.
		AllowAutoTopicCreation: true,
	}

	return &Dispatcher{
		pool: pool,
		client: &http.Client{
			Transport: transport,
			Timeout:   cfg.HTTPTimeout,
		},
		producer: producer,
		brokers:  cfg.KafkaBrokers,
		topic:    cfg.KafkaTopic,
		groupID:  cfg.KafkaGroupID,
		stopped:  make(chan struct{}),
	}
}

// StartConsumers spawns n goroutines, each owning its own Kafka reader in the
// shared consumer group, that drain partner delivery jobs and dispatch them.
// Call once at startup.
func (d *Dispatcher) StartConsumers(ctx context.Context, n int) {
	if n <= 0 {
		n = 4
	}
	for i := 0; i < n; i++ {
		reader := kafka.NewReader(kafka.ReaderConfig{
			Brokers:  d.brokers,
			Topic:    d.topic,
			GroupID:  d.groupID,
			MinBytes: 1,
			MaxBytes: 10e6,
		})
		d.wg.Add(1)
		go d.consume(ctx, i, reader)
	}
	log.Info().Int("consumers", n).Str("topic", d.topic).Str("group", d.groupID).
		Msg("webhook dispatcher: kafka consumers started")
}

// Stop closes the producer and signals every consumer to exit, then waits for
// in-flight dispatches to finish.
func (d *Dispatcher) Stop() {
	d.stopOnce.Do(func() {
		close(d.stopped)
		if err := d.producer.Close(); err != nil {
			log.Error().Err(err).Msg("webhook dispatcher: producer close")
		}
		d.wg.Wait()
		log.Info().Msg("webhook dispatcher: stopped")
	})
}

// BroadcastCorridor queries active partners, serializes the payload once, and
// produces one Kafka message per partner. Returns the number of messages
// produced. A zero return with nil error means no active subscribers — not an
// error.
//
// ctx governs the DB query and the Kafka produce call; each partner's HTTP
// POST runs later, under its own timeout, inside a consumer goroutine.
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

	msgs := make([]kafka.Message, 0, len(partners))
	for _, p := range partners {
		jBytes, err := json.Marshal(job{Partner: p, Body: body, TripID: tripID})
		if err != nil {
			return 0, fmt.Errorf("marshal job for partner %s: %w", p.Name, err)
		}
		msgs = append(msgs, kafka.Message{Key: []byte(p.ID), Value: jBytes})
	}

	if err := d.producer.WriteMessages(ctx, msgs...); err != nil {
		return 0, fmt.Errorf("kafka: produce: %w", err)
	}
	metrics.WebhookEventsPublished.Add(float64(len(msgs)))
	return len(msgs), nil
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

// consume drains reader until ctx is cancelled, dispatching each job and only
// committing its offset once dispatch returns — success or exhausted
// retries. That ordering is what makes this at-least-once: a crash between
// dispatch and commit redelivers the job after restart instead of losing it.
func (d *Dispatcher) consume(ctx context.Context, id int, reader *kafka.Reader) {
	defer d.wg.Done()
	defer func() {
		if err := reader.Close(); err != nil {
			log.Error().Err(err).Int("consumer", id).Msg("webhook dispatcher: reader close")
		}
	}()

	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error().Err(err).Int("consumer", id).Msg("webhook dispatcher: fetch message")
			continue
		}

		var j job
		if err := json.Unmarshal(msg.Value, &j); err != nil {
			log.Error().Err(err).Int("consumer", id).Msg("webhook dispatcher: malformed job, dropping")
			_ = reader.CommitMessages(ctx, msg)
			continue
		}

		d.dispatch(j)

		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Error().Err(err).Int("consumer", id).Str("trip", j.TripID).
				Msg("webhook dispatcher: commit offset")
		}
	}
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
	timeout := time.Duration(j.Partner.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = d.client.Timeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.Partner.URL, bytes.NewReader(j.Body))
	if err != nil {
		log.Error().Err(err).
			Str("partner", j.Partner.Name).
			Int("attempt", attempt).
			Msg("webhook: build request")
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "sipra-core/1.0")
	req.Header.Set("X-Sipra-Partner", j.Partner.Name)
	req.Header.Set("X-Sipra-Trip", j.TripID)
	req.Header.Set("X-Sipra-Signature", sign(j.Partner.Secret, j.Body))

	started := time.Now()
	resp, err := d.client.Do(req)
	latency := time.Since(started)

	if err != nil {
		log.Error().Err(err).
			Str("partner", j.Partner.Name).
			Str("trip", j.TripID).
			Int("attempt", attempt).
			Dur("latency", latency).
			Msg("webhook: partner POST failed")
		metrics.WebhookDeliveries.WithLabelValues("network_error").Inc()
		return false
	}
	defer resp.Body.Close()

	evt := log.Info()
	if resp.StatusCode >= 400 {
		evt = log.Warn()
	}
	evt.Str("partner", j.Partner.Name).
		Str("trip", j.TripID).
		Int("status", resp.StatusCode).
		Int("attempt", attempt).
		Dur("latency", latency).
		Msg("webhook: delivered")

	switch {
	case resp.StatusCode < 400:
		metrics.WebhookDeliveries.WithLabelValues("success").Inc()
	case resp.StatusCode < 500:
		metrics.WebhookDeliveries.WithLabelValues("client_error").Inc()
	default:
		metrics.WebhookDeliveries.WithLabelValues("server_error").Inc()
	}

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
