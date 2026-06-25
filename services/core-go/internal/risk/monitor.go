package risk

import (
	"cmp"
	"context"
	"slices"
	"sync"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	"github.com/rs/zerolog/log"
)

// recentSpeedsLimit is how many recent pings the monitor reads to build
// the AI brain's recent_speeds_kph[] residual signal. Five matches the
// Highway Capacity Manual rolling window used in the AI brain.
const recentSpeedsLimit = 5

// fleetCorridorRadiusMeters is the 2 km exclusion-corridor radius the
// dashboard renders. The AI brain weighs density inside that same radius.
const fleetCorridorRadiusMeters = 2_000.0

// defaultSpeedKPH is used when no recent ping carries speed telemetry.
// Conservative urban-arterial midpoint; the AI brain's bounded residual
// keeps a single bad fallback from dominating the prediction.
const defaultSpeedKPH = 40.0

// TripStore is the subset of TripRepo the Monitor needs.
type TripStore interface {
	ListInTransit(ctx context.Context) ([]domain.Trip, error)
	UpdateStatus(ctx context.Context, id domain.TripID, status domain.TripStatus, now time.Time) error
}

// PingStore is the subset of PingRepo the Monitor needs.
type PingStore interface {
	GetLatest(ctx context.Context, tripID domain.TripID) (*domain.GPSPing, error)
	GetRecent(ctx context.Context, tripID domain.TripID, limit int) ([]domain.GPSPing, error)
}

// FleetDensity is the live corridor-density signal the AI brain uses.
// *redisstore.FleetGeoStore satisfies this; tests inject a fake.
type FleetDensity interface {
	CountInRadius(ctx context.Context, lat, lng float64, radiusMeters float64) (int, error)
}

// Monitor polls Postgres for InTransit trips, calls the AI brain, and
// reacts to the recommendation enum: DISPATCH_DRONE transitions the trip
// and dispatches a drone; REQUEST_BOUNTY_BOOST emits a WS signal so the
// bounty engine (Phase 6) can raise the surge; CONTINUE is a no-op.
type Monitor struct {
	trips      TripStore
	pings      PingStore
	predictor  Predictor
	dispatcher DroneDispatcher
	density    FleetDensity
	hub        *ws.Hub
	interval   time.Duration
	workers    int
}

// NewMonitor wires the Monitor with its dependencies.
// Both *pgstore.TripRepo and *pgstore.PingRepo satisfy the store interfaces.
// density may be nil if no fleet GEO source is wired yet — in that case the
// monitor sends fleet_density_in_corridor=0 so the AI brain still works.
// workers bounds how many trips EvaluateOnce evaluates concurrently per poll
// cycle; values <= 0 fall back to 4.
func NewMonitor(trips TripStore, pings PingStore, p Predictor, hub *ws.Hub, dispatcher DroneDispatcher, density FleetDensity, interval time.Duration, workers int) *Monitor {
	if workers <= 0 {
		workers = 4
	}
	return &Monitor{
		trips:      trips,
		pings:      pings,
		predictor:  p,
		dispatcher: dispatcher,
		density:    density,
		hub:        hub,
		interval:   interval,
		workers:    workers,
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
// transition breaching trips. Trips are evaluated most-urgent-first across a
// bounded worker pool, so a fleet larger than m.workers never lets a
// near-breach trip wait behind a pile of lower-urgency ones. Exported so
// tests can invoke it synchronously.
func (m *Monitor) EvaluateOnce(ctx context.Context) {
	trips, err := m.trips.ListInTransit(ctx)
	if err != nil {
		log.Error().Err(err).Msg("risk: list in-transit trips")
		return
	}
	if len(trips) == 0 {
		return
	}

	now := time.Now().UTC()
	slices.SortFunc(trips, func(a, b domain.Trip) int {
		return cmp.Compare(a.RemainingGoldenHour(now), b.RemainingGoldenHour(now))
	})

	m.evaluateAll(ctx, trips)
}

// evaluateAll fans trips out across m.workers goroutines. trips must already
// be sorted most-urgent-first: the queue channel is filled in that order
// before any worker starts, so whichever worker is next free always picks up
// the most-urgent unstarted trip. A trip already mid-flight is never
// preempted by a newer, more urgent one — it's a single bounded AI-brain
// call, not worth interrupting.
func (m *Monitor) evaluateAll(ctx context.Context, trips []domain.Trip) {
	queue := make(chan domain.Trip, len(trips))
	for _, t := range trips {
		queue <- t
	}
	close(queue)

	n := min(m.workers, len(trips))
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			for trip := range queue {
				m.evaluateTrip(ctx, trip)
			}
		}()
	}
	wg.Wait()
}

func (m *Monitor) evaluateTrip(ctx context.Context, trip domain.Trip) {
	pings, err := m.pings.GetRecent(ctx, trip.ID, recentSpeedsLimit)
	if err != nil || len(pings) == 0 {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: no recent pings, skipping trip")
		return
	}

	// Latest ping = newest (GetRecent returns DESC).
	latest := pings[0]

	speeds := make([]float64, 0, len(pings))
	for _, p := range pings {
		if p.SpeedKPH != nil && *p.SpeedKPH >= 0 {
			speeds = append(speeds, *p.SpeedKPH)
		}
	}
	if len(speeds) == 0 {
		speeds = []float64{defaultSpeedKPH}
	}

	density := 0
	if m.density != nil {
		if n, derr := m.density.CountInRadius(ctx, latest.Location.Lat, latest.Location.Lng, fleetCorridorRadiusMeters); derr != nil {
			log.Warn().Err(derr).Str("trip", string(trip.ID)).Msg("risk: fleet density lookup failed, defaulting to 0")
		} else {
			density = n
		}
	}

	now := time.Now().UTC()
	deadlineRemaining := int(trip.GoldenHourDeadline.Sub(now).Seconds())
	if deadlineRemaining < 0 {
		deadlineRemaining = 0
	}

	predCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := m.predictor.Decide(predCtx, DecideRequest{
		PredictRequest: PredictRequest{
			TripID:                   string(trip.ID),
			CurrentPosition:          Position{Lat: latest.Location.Lat, Lng: latest.Location.Lng},
			Destination:              Position{Lat: trip.Destination.Lat, Lng: trip.Destination.Lng},
			DeadlineSecondsRemaining: deadlineRemaining,
			RecentSpeedsKPH:          speeds,
			FleetDensityInCorridor:   density,
		},
		// CorridorActive is always true once we have a recent corridor row.
		// Phase 6 will wire the real corridor state; false is safe for now
		// because rule R3 (ACTIVATE_CORRIDOR) only fires when it's false.
		CorridorActive: true,
	})
	if err != nil {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: decide call failed, skipping trip")
		return
	}

	pred := resp.Prediction

	log.Debug().
		Str("trip", string(trip.ID)).
		Str("action", string(resp.Decision.Action)).
		Strs("rule_path", resp.Decision.RulePath).
		Float64("breach_prob", pred.BreachProbability).
		Int("density", density).
		Msg("risk: decision received")

	// Broadcast every prediction so the dashboard AI Brain panel stays live.
	m.hub.BroadcastRiskPrediction(ws.RiskPredictionPayload{
		TripID:                   string(trip.ID),
		PredictedETASeconds:      pred.PredictedETASeconds,
		DeadlineSecondsRemaining: pred.DeadlineSecondsRemaining,
		BreachProbability:        pred.BreachProbability,
		WillBreach:               pred.WillBreach,
		Recommendation:           string(resp.Decision.Action),
		WeatherCondition:         pred.WeatherCondition,
		WeatherFactor:            pred.WeatherFactor,
		FleetDensityInCorridor:   pred.FleetDensityInCorridor,
		FleetPenalty:             pred.FleetPenalty,
		EffectiveSpeedKPH:        pred.EffectiveSpeedKPH,
		AIConfidence:             pred.AIConfidence,
		Reasoning:                pred.Reasoning,
	})

	switch resp.Decision.Action {
	case DecisionActionDispatchDrone:
		m.handleDispatchDrone(ctx, trip, latest, resp)
	case DecisionActionRequestBountyBoost:
		m.hub.BroadcastBountyBoostRequested(string(trip.ID), pred.BreachProbability, pred.Reasoning)
		log.Info().
			Str("trip", string(trip.ID)).
			Float64("breach_prob", pred.BreachProbability).
			Msg("risk: bounty boost requested")
	case DecisionActionContinue:
		// no-op
	case DecisionActionAbort:
		log.Warn().
			Str("trip", string(trip.ID)).
			Strs("rule_path", resp.Decision.RulePath).
			Msg("risk: ABORT decision — route deviation + no-progress detected")
	case DecisionActionActivateCorridor, DecisionActionReroute:
		log.Info().
			Str("trip", string(trip.ID)).
			Str("action", string(resp.Decision.Action)).
			Msg("risk: corridor/reroute action — handled by corridor engine")
	default:
		log.Warn().Str("trip", string(trip.ID)).Str("action", string(resp.Decision.Action)).Msg("risk: unknown action")
	}
}

func (m *Monitor) handleDispatchDrone(ctx context.Context, trip domain.Trip, latest domain.GPSPing, resp *DecideResponse) {
	pred := resp.Prediction
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

	metrics.HandoffsTriggered.WithLabelValues(pred.Reasoning).Inc()

	log.Info().
		Str("trip", string(trip.ID)).
		Int("predicted_eta_s", pred.PredictedETASeconds).
		Float64("breach_prob", pred.BreachProbability).
		Strs("rule_path", resp.Decision.RulePath).
		Msg("risk: trip transitioned to DroneHandoff")

	// Ask the AI brain for weather-adjusted cruise/altitude/ETA before
	// calling the partner dispatcher. This keeps every dynamic flight
	// parameter (other than identity/inventory) inside the AI brain
	// instead of hardcoded in the dispatcher mock.
	var aiFlight *AIPredictedFlight
	flightCtx, flightCancel := context.WithTimeout(ctx, 3*time.Second)
	defer flightCancel()
	dronePred, perr := m.predictor.PredictDrone(flightCtx, DronePredictRequest{
		TripID:           string(trip.ID),
		Pickup:           Position{Lat: latest.Location.Lat, Lng: latest.Location.Lng},
		Dropoff:          Position{Lat: trip.Destination.Lat, Lng: trip.Destination.Lng},
		WeatherCondition: pred.WeatherCondition,
		UrgencyTier:      "Critical",
	})
	if perr != nil {
		log.Warn().Err(perr).Str("trip", string(trip.ID)).Msg("risk: /predict-drone failed, dispatcher will use mock defaults")
	} else {
		aiFlight = &AIPredictedFlight{
			CruiseKPH:        dronePred.CruiseKPH,
			AltitudeMCruise:  dronePred.AltitudeMCruise,
			SpinUpSeconds:    dronePred.SpinUpSeconds,
			ETASeconds:       dronePred.ETASeconds,
			RouteKM:          dronePred.RouteKM,
			WeatherCondition: dronePred.WeatherCondition,
		}
		log.Info().
			Str("trip", string(trip.ID)).
			Float64("cruise_kph", dronePred.CruiseKPH).
			Int("alt_m", dronePred.AltitudeMCruise).
			Int("eta_s", dronePred.ETASeconds).
			Str("weather", dronePred.WeatherCondition).
			Msg("risk: AI brain drone flight prediction")
	}

	// Call the drone dispatch API; degrade gracefully on failure.
	droneID, droneETA := "", 0
	var meta *ws.DroneMetadata
	dispCtx, dispCancel := context.WithTimeout(ctx, 5*time.Second)
	defer dispCancel()

	dr, err := m.dispatcher.Dispatch(dispCtx, DispatchRequest{
		TripID:      string(trip.ID),
		Pickup:      LatLng{Lat: latest.Location.Lat, Lng: latest.Location.Lng},
		Dropoff:     LatLng{Lat: trip.Destination.Lat, Lng: trip.Destination.Lng},
		CargoType:   string(trip.Cargo.Category),
		Priority:    "CRITICAL",
		AIPredicted: aiFlight,
	})
	if err != nil {
		log.Warn().Err(err).Str("trip", string(trip.ID)).Msg("risk: drone dispatch call failed, broadcasting without drone info")
	} else {
		droneID = dr.DroneID
		droneETA = dr.ETASeconds
		if dr.DroneMetadata != nil {
			meta = &ws.DroneMetadata{
				Model:           dr.DroneMetadata.Model,
				MaxPayloadKG:    dr.DroneMetadata.MaxPayloadKG,
				BatteryPct:      dr.DroneMetadata.BatteryPct,
				LaunchPadID:     dr.DroneMetadata.LaunchPadID,
				AltitudeMCruise: dr.DroneMetadata.AltitudeMCruise,
				CruiseKPH:       dr.DroneMetadata.CruiseKPH,
				RouteKM:         dr.DroneMetadata.RouteKM,
			}
		}
		log.Info().
			Str("trip", string(trip.ID)).
			Str("drone", droneID).
			Int("drone_eta_s", droneETA).
			Msg("risk: drone dispatched")
	}

	m.hub.BroadcastHandoffInitiatedFull(string(trip.ID), droneID, droneETA, pred.Reasoning, pred.PredictedETASeconds, meta)
}
