package risk

import (
	"context"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	"github.com/rs/zerolog/log"
)

// TripStore is the subset of TripRepo the Monitor needs.
type TripStore interface {
	ListInTransit(ctx context.Context) ([]domain.Trip, error)
	UpdateStatus(ctx context.Context, id domain.TripID, status domain.TripStatus, now time.Time) error
}

// PingStore is the subset of PingRepo the Monitor needs.
type PingStore interface {
	GetLatest(ctx context.Context, tripID domain.TripID) (*domain.GPSPing, error)
}

// Monitor polls Postgres for InTransit trips, calls the AI brain, and
// transitions breaching trips to DroneHandoff.
type Monitor struct {
	trips      TripStore
	pings      PingStore
	predictor  Predictor
	dispatcher DroneDispatcher
	hub        *ws.Hub
	interval   time.Duration
}

// NewMonitor wires the Monitor with its dependencies.
// Both *pgstore.TripRepo and *pgstore.PingRepo satisfy the store interfaces.
func NewMonitor(trips TripStore, pings PingStore, p Predictor, hub *ws.Hub, dispatcher DroneDispatcher, interval time.Duration) *Monitor {
	return &Monitor{
		trips:      trips,
		pings:      pings,
		predictor:  p,
		dispatcher: dispatcher,
		hub:        hub,
		interval:   interval,
	}
}

// Start launches the poll loop as a background goroutine.
// The loop stops when ctx is cancelled.
func (m *Monitor) Start(ctx context.Context) {
	go m.run(ctx)
}

func (m *Monitor) run(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	log.Info().Dur("interval", m.interval).Msg("risk: monitor started")

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("risk: monitor stopped")
			return
		case <-ticker.C:
			m.EvaluateOnce(ctx)
		}
	}
}

// EvaluateOnce runs one full poll cycle: fetch InTransit trips, call AI brain,
// transition breaching trips. Exported so tests can invoke it synchronously.
func (m *Monitor) EvaluateOnce(ctx context.Context) {
	trips, err := m.trips.ListInTransit(ctx)
	if err != nil {
		log.Error().Err(err).Msg("risk: list in-transit trips")
		return
	}

	for _, trip := range trips {
		m.evaluateTrip(ctx, trip)
	}
}

// defaultSpeedKPH is used when the latest ping carries no speed telemetry.
const defaultSpeedKPH = 40.0

func (m *Monitor) evaluateTrip(ctx context.Context, trip domain.Trip) {
	ping, err := m.pings.GetLatest(ctx, trip.ID)
	if err != nil {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: no latest ping, skipping trip")
		return
	}

	speedKPH := defaultSpeedKPH
	if ping.SpeedKPH != nil && *ping.SpeedKPH > 0 {
		speedKPH = *ping.SpeedKPH
	}

	predCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := m.predictor.Predict(predCtx, PredictRequest{
		TripID:             string(trip.ID),
		CurrentLat:         ping.Location.Lat,
		CurrentLng:         ping.Location.Lng,
		DestinationLat:     trip.Destination.Lat,
		DestinationLng:     trip.Destination.Lng,
		GoldenHourDeadline: trip.GoldenHourDeadline,
		AvgSpeedKPH:        speedKPH,
	})
	if err != nil {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: predict call failed, skipping trip")
		return
	}

	log.Debug().
		Str("trip", string(trip.ID)).
		Bool("will_breach", resp.WillBreach).
		Float64("breach_prob", resp.BreachProbability).
		Str("reasoning", resp.Reasoning).
		Msg("risk: prediction received")

	// Broadcast every prediction so the dashboard AI Brain panel stays live.
	m.hub.BroadcastRiskPrediction(ws.RiskPredictionPayload{
		TripID:                   string(trip.ID),
		PredictedETASeconds:      resp.PredictedETASeconds,
		DeadlineSecondsRemaining: resp.DeadlineSecondsRemaining,
		BreachProbability:        resp.BreachProbability,
		WillBreach:               resp.WillBreach,
		WeatherCondition:         resp.WeatherCondition,
		WeatherFactor:            resp.WeatherFactor,
		Reasoning:                resp.Reasoning,
		AIConfidence:             resp.AIConfidence,
		AIReasoning:              resp.AIReasoning,
		RiskFactors:              resp.RiskFactors,
		Recommendations:          resp.Recommendations,
	})

	if !resp.WillBreach {
		return
	}

	now := time.Now().UTC()
	if err := trip.TransitionTo(domain.TripStatusDroneHandoff, now); err != nil {
		// ErrInvalidTransition means the trip already left InTransit — not an error.
		log.Debug().Err(err).Str("trip", string(trip.ID)).Msg("risk: transition not applicable, skipping")
		return
	}

	if err := m.trips.UpdateStatus(ctx, trip.ID, domain.TripStatusDroneHandoff, now); err != nil {
		log.Error().Err(err).Str("trip", string(trip.ID)).Msg("risk: persist DroneHandoff failed")
		return
	}

	metrics.HandoffsTriggered.WithLabelValues(resp.Reasoning).Inc()

	log.Info().
		Str("trip", string(trip.ID)).
		Int("predicted_eta_s", resp.PredictedETASeconds).
		Str("reason", resp.Reasoning).
		Msg("risk: trip transitioned to DroneHandoff")

	// Call the drone dispatch API; degrade gracefully on failure.
	droneID, droneETA := "", 0
	dispCtx, dispCancel := context.WithTimeout(ctx, 5*time.Second)
	defer dispCancel()

	dr, err := m.dispatcher.Dispatch(dispCtx, DispatchRequest{
		TripID:    string(trip.ID),
		Pickup:    LatLng{Lat: ping.Location.Lat, Lng: ping.Location.Lng},
		Dropoff:   LatLng{Lat: trip.Destination.Lat, Lng: trip.Destination.Lng},
		CargoType: string(trip.Cargo.Category),
		Priority:  "CRITICAL",
	})
	if err != nil {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: drone dispatch call failed, broadcasting without drone info")
	} else {
		droneID = dr.DroneID
		droneETA = dr.ETASeconds
		log.Info().
			Str("trip", string(trip.ID)).
			Str("drone", droneID).
			Int("drone_eta_s", droneETA).
			Msg("risk: drone dispatched")
	}

	m.hub.BroadcastHandoffInitiatedFull(string(trip.ID), droneID, droneETA, resp.Reasoning, resp.PredictedETASeconds)
}
