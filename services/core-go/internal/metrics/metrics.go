// Package metrics owns the Prometheus collectors exposed at GET /metrics.
//
// Cardinality note: pings_ingested_total is labelled by trip_id. Acceptable
// for a demo (handful of concurrent trips); revisit if trip volume grows.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	PingsIngested = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sipra_pings_ingested_total",
			Help: "GPS pings accepted by the ingest endpoint, by trip.",
		},
		[]string{"trip_id"},
	)

	CorridorComputeDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "sipra_corridor_compute_duration_seconds",
			Help:    "Wall time of one CalculateRollingCorridor transaction.",
			Buckets: prometheus.DefBuckets,
		},
	)

	HandoffsTriggered = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sipra_handoffs_triggered_total",
			Help: "Trips transitioned to DroneHandoff, by predictor reason.",
		},
		[]string{"reason"},
	)

	WSClientsConnected = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "sipra_ws_clients_connected",
			Help: "Currently connected dashboard WebSocket clients.",
		},
	)

	ChaosTriggers = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sipra_chaos_triggers_total",
			Help: "Chaos endpoint invocations by kind (flood-bridge, spawn-fleet, force-handoff, reset).",
		},
		[]string{"kind"},
	)
)
