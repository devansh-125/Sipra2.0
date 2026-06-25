package risk_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/risk"
)

// --- fakes ---

type fakeTripStore struct {
	trips     []domain.Trip
	updated   []domain.TripID
	updateErr error
}

func (f *fakeTripStore) ListInTransit(_ context.Context) ([]domain.Trip, error) {
	return f.trips, nil
}

func (f *fakeTripStore) UpdateStatus(_ context.Context, id domain.TripID, _ domain.TripStatus, _ time.Time) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	f.updated = append(f.updated, id)
	return nil
}

type fakePingStore struct {
	pings []domain.GPSPing
	err   error
}

func (f *fakePingStore) GetLatest(_ context.Context, _ domain.TripID) (*domain.GPSPing, error) {
	if f.err != nil {
		return nil, f.err
	}
	if len(f.pings) == 0 {
		return nil, errors.New("no pings")
	}
	p := f.pings[0]
	return &p, nil
}

func (f *fakePingStore) GetRecent(_ context.Context, _ domain.TripID, _ int) ([]domain.GPSPing, error) {
	return f.pings, f.err
}

type fakeFleetDensity struct {
	count int
	err   error
}

func (f *fakeFleetDensity) CountInRadius(_ context.Context, _, _ float64, _ float64) (int, error) {
	return f.count, f.err
}

type fakePredictor struct {
	resp *risk.DecideResponse
	err  error
}

func (f *fakePredictor) Decide(_ context.Context, _ risk.DecideRequest) (*risk.DecideResponse, error) {
	return f.resp, f.err
}

func (f *fakePredictor) PredictDrone(_ context.Context, req risk.DronePredictRequest) (*risk.DronePredictResponse, error) {
	return &risk.DronePredictResponse{
		TripID:           req.TripID,
		RouteKM:          50.0,
		CruiseKPH:        95.0,
		AltitudeMCruise:  120,
		SpinUpSeconds:    30,
		FlightSeconds:    1894,
		ETASeconds:       1924,
		WeatherCondition: "clear",
		WeatherFactor:    1.0,
		PayloadFactor:    1.0,
	}, nil
}

type fakeDroneDispatcher struct {
	resp       *risk.DispatchResponse
	err        error
	dispatched []risk.DispatchRequest
}

func (f *fakeDroneDispatcher) Dispatch(_ context.Context, req risk.DispatchRequest) (*risk.DispatchResponse, error) {
	f.dispatched = append(f.dispatched, req)
	return f.resp, f.err
}

// --- helpers ---

func inTransitTrip(id string) domain.Trip {
	return domain.Trip{
		ID:                 domain.TripID(id),
		Status:             domain.TripStatusInTransit,
		GoldenHourDeadline: time.Now().Add(30 * time.Minute),
		Destination:        domain.Point{Lat: 12.9716, Lng: 77.5946},
	}
}

// tripWithDeadline is like inTransitTrip but with an explicit deadline, used
// by tests that assert evaluation order across trips of different urgency.
func tripWithDeadline(id string, deadline time.Time) domain.Trip {
	return domain.Trip{
		ID:                 domain.TripID(id),
		Status:             domain.TripStatusInTransit,
		GoldenHourDeadline: deadline,
		Destination:        domain.Point{Lat: 12.9716, Lng: 77.5946},
	}
}

func recentPings(tripID string, n int, speed float64) []domain.GPSPing {
	out := make([]domain.GPSPing, 0, n)
	s := speed
	for i := 0; i < n; i++ {
		out = append(out, domain.GPSPing{
			TripID:   domain.TripID(tripID),
			Location: domain.Point{Lat: 12.8000, Lng: 77.4000},
			SpeedKPH: &s,
		})
	}
	return out
}

func decideResp(action risk.DecisionAction, pred risk.PredictResponse) *risk.DecideResponse {
	return &risk.DecideResponse{
		Prediction: pred,
		Decision:   risk.DecisionResult{Action: action},
	}
}

func newMonitor(trips risk.TripStore, pings risk.PingStore, p risk.Predictor, d risk.DroneDispatcher) *risk.Monitor {
	if d == nil {
		d = &fakeDroneDispatcher{resp: &risk.DispatchResponse{DroneID: "test-drone", ETASeconds: 300, Status: "DISPATCHED"}}
	}
	density := &fakeFleetDensity{count: 0}
	return risk.NewMonitor(trips, pings, p, ws.NewHub(), d, density, time.Hour, 4)
}

// --- tests ---

func TestEvaluateOnce_HandoffOnDispatchDroneRecommendation(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-1")}}
	pings := &fakePingStore{pings: recentPings("trip-1", 5, 40)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionDispatchDrone, risk.PredictResponse{
		WillBreach:          true,
		PredictedETASeconds: 4500,
		Reasoning:           "ETA exceeds deadline",
	})}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 1 || trips.updated[0] != "trip-1" {
		t.Fatalf("expected trip-1 transitioned to DroneHandoff, got %v", trips.updated)
	}
}

func TestEvaluateOnce_NoHandoffOnContinue(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-2")}}
	pings := &fakePingStore{pings: recentPings("trip-2", 5, 60)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionContinue, risk.PredictResponse{
		WillBreach:          false,
		PredictedETASeconds: 1800,
	})}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no status update on CONTINUE, got %v", trips.updated)
	}
}

func TestEvaluateOnce_NoHandoffOnBountyBoost(t *testing.T) {
	// REQUEST_BOUNTY_BOOST should emit a WS event but never transition the trip.
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-2b")}}
	pings := &fakePingStore{pings: recentPings("trip-2b", 5, 35)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionRequestBountyBoost, risk.PredictResponse{
		BreachProbability:   0.55,
		PredictedETASeconds: 2800,
	})}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no status update on REQUEST_BOUNTY_BOOST, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsOnPredictError(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-3")}}
	pings := &fakePingStore{pings: recentPings("trip-3", 5, 40)}
	pred := &fakePredictor{err: errors.New("ai brain unreachable")}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update on predict error, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsOnNoPings(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-4")}}
	pings := &fakePingStore{err: errors.New("no pings yet")}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionDispatchDrone, risk.PredictResponse{})}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update when pings unavailable, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsAlreadyHandoff(t *testing.T) {
	// A trip already in DroneHandoff should not be re-listed by the InTransit query;
	// even if it somehow lands here, the state machine rejects the transition gracefully.
	trip := domain.Trip{
		ID:                 "trip-5",
		Status:             domain.TripStatusDroneHandoff,
		GoldenHourDeadline: time.Now().Add(30 * time.Minute),
		Destination:        domain.Point{Lat: 12.9716, Lng: 77.5946},
	}
	trips := &fakeTripStore{trips: []domain.Trip{trip}}
	pings := &fakePingStore{pings: recentPings("trip-5", 5, 40)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionDispatchDrone, risk.PredictResponse{})}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update for already-handoff trip, got %v", trips.updated)
	}
}

func TestEvaluateOnce_UsesDefaultSpeedWhenAllPingsLackSpeed(t *testing.T) {
	trip := inTransitTrip("trip-6")
	pingsWithoutSpeed := []domain.GPSPing{{
		TripID:   "trip-6",
		Location: domain.Point{Lat: 12.8, Lng: 77.4},
		SpeedKPH: nil,
	}}
	var capturedReq risk.DecideRequest
	pred := &capturePredictor{
		capture: &capturedReq,
		resp:    decideResp(risk.DecisionActionContinue, risk.PredictResponse{}),
	}
	trips := &fakeTripStore{trips: []domain.Trip{trip}}
	pings := &fakePingStore{pings: pingsWithoutSpeed}

	newMonitor(trips, pings, pred, nil).EvaluateOnce(context.Background())

	if len(capturedReq.RecentSpeedsKPH) != 1 || capturedReq.RecentSpeedsKPH[0] != 40.0 {
		t.Fatalf("expected default speed [40], got %v", capturedReq.RecentSpeedsKPH)
	}
}

func TestEvaluateOnce_PassesRecentSpeedsAndDensity(t *testing.T) {
	trip := inTransitTrip("trip-6b")
	var capturedReq risk.DecideRequest
	pred := &capturePredictor{
		capture: &capturedReq,
		resp:    decideResp(risk.DecisionActionContinue, risk.PredictResponse{}),
	}
	trips := &fakeTripStore{trips: []domain.Trip{trip}}
	speeds := []float64{42, 40, 38, 36, 34}
	pps := make([]domain.GPSPing, 0, len(speeds))
	for _, s := range speeds {
		s := s
		pps = append(pps, domain.GPSPing{
			TripID:   "trip-6b",
			Location: domain.Point{Lat: 12.8, Lng: 77.4},
			SpeedKPH: &s,
		})
	}
	pings := &fakePingStore{pings: pps}
	density := &fakeFleetDensity{count: 7}

	risk.NewMonitor(trips, pings, pred, ws.NewHub(),
		&fakeDroneDispatcher{resp: &risk.DispatchResponse{Status: "DISPATCHED"}},
		density, time.Hour, 4,
	).EvaluateOnce(context.Background())

	if len(capturedReq.RecentSpeedsKPH) != 5 {
		t.Fatalf("expected 5 recent speeds forwarded, got %d", len(capturedReq.RecentSpeedsKPH))
	}
	if capturedReq.FleetDensityInCorridor != 7 {
		t.Fatalf("expected fleet density 7, got %d", capturedReq.FleetDensityInCorridor)
	}
}

func TestEvaluateOnce_DispatchesDroneOnDispatchDroneRec(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-7")}}
	pings := &fakePingStore{pings: recentPings("trip-7", 5, 20)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionDispatchDrone, risk.PredictResponse{
		WillBreach:          true,
		PredictedETASeconds: 4500,
		Reasoning:           "ETA exceeds deadline",
	})}
	drone := &fakeDroneDispatcher{
		resp: &risk.DispatchResponse{DroneID: "SIPRA-DRONE-ABC123", ETASeconds: 240, Status: "DISPATCHED"},
	}

	newMonitor(trips, pings, pred, drone).EvaluateOnce(context.Background())

	if len(drone.dispatched) != 1 {
		t.Fatalf("expected 1 drone dispatch call, got %d", len(drone.dispatched))
	}
	req := drone.dispatched[0]
	if req.TripID != "trip-7" {
		t.Errorf("dispatch TripID = %q, want trip-7", req.TripID)
	}
	if req.Priority != "CRITICAL" {
		t.Errorf("dispatch Priority = %q, want CRITICAL", req.Priority)
	}
}

func TestEvaluateOnce_HandoffSucceedsEvenIfDispatchFails(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-8")}}
	pings := &fakePingStore{pings: recentPings("trip-8", 5, 20)}
	pred := &fakePredictor{resp: decideResp(risk.DecisionActionDispatchDrone, risk.PredictResponse{
		WillBreach:          true,
		PredictedETASeconds: 3600,
		Reasoning:           "breach imminent",
	})}
	drone := &fakeDroneDispatcher{err: errors.New("drone fleet offline")}

	newMonitor(trips, pings, pred, drone).EvaluateOnce(context.Background())

	if len(trips.updated) != 1 || trips.updated[0] != "trip-8" {
		t.Fatalf("expected trip-8 updated despite drone error, got %v", trips.updated)
	}
}

// capturePredictor records the last DecideRequest it received.
type capturePredictor struct {
	capture *risk.DecideRequest
	resp    *risk.DecideResponse
}

func (c *capturePredictor) Decide(_ context.Context, req risk.DecideRequest) (*risk.DecideResponse, error) {
	*c.capture = req
	return c.resp, nil
}

func (c *capturePredictor) PredictDrone(_ context.Context, req risk.DronePredictRequest) (*risk.DronePredictResponse, error) {
	return &risk.DronePredictResponse{
		TripID:           req.TripID,
		CruiseKPH:        95.0,
		AltitudeMCruise:  120,
		WeatherCondition: "clear",
		WeatherFactor:    1.0,
		PayloadFactor:    1.0,
	}, nil
}

func TestEvaluateOnce_EvaluatesMostUrgentTripFirst(t *testing.T) {
	now := time.Now()
	// Inserted out of urgency order on purpose — the monitor must sort them.
	trips := []domain.Trip{
		tripWithDeadline("trip-far", now.Add(60*time.Minute)),
		tripWithDeadline("trip-soonest", now.Add(5*time.Minute)),
		tripWithDeadline("trip-mid", now.Add(20*time.Minute)),
	}
	tripStore := &fakeTripStore{trips: trips}
	pings := &fakePingStore{pings: recentPings("any", 5, 40)}
	pred := &sequencePredictor{resp: decideResp(risk.DecisionActionContinue, risk.PredictResponse{})}

	mon := risk.NewMonitor(tripStore, pings, pred, ws.NewHub(),
		&fakeDroneDispatcher{resp: &risk.DispatchResponse{Status: "DISPATCHED"}},
		&fakeFleetDensity{count: 0}, time.Hour, 1) // workers:1 forces strict sequential order

	mon.EvaluateOnce(context.Background())

	want := []string{"trip-soonest", "trip-mid", "trip-far"}
	if !slices.Equal(pred.seen, want) {
		t.Fatalf("evaluation order = %v, want %v", pred.seen, want)
	}
}

func TestEvaluateOnce_AllTripsEvaluatedUnderConcurrency(t *testing.T) {
	const numTrips = 20
	trips := make([]domain.Trip, numTrips)
	for i := range trips {
		trips[i] = inTransitTrip(fmt.Sprintf("trip-c-%d", i))
	}
	tripStore := &fakeTripStore{trips: trips}
	pings := &fakePingStore{pings: recentPings("any", 5, 40)}
	pred := &sequencePredictor{resp: decideResp(risk.DecisionActionContinue, risk.PredictResponse{})}

	mon := risk.NewMonitor(tripStore, pings, pred, ws.NewHub(),
		&fakeDroneDispatcher{resp: &risk.DispatchResponse{Status: "DISPATCHED"}},
		&fakeFleetDensity{count: 0}, time.Hour, 8)

	mon.EvaluateOnce(context.Background())

	if len(pred.seen) != numTrips {
		t.Fatalf("expected all %d trips evaluated, got %d", numTrips, len(pred.seen))
	}
}

func TestEvaluateOnce_NeverExceedsWorkerLimit(t *testing.T) {
	const workers = 3
	const numTrips = 10

	trips := make([]domain.Trip, numTrips)
	for i := range trips {
		trips[i] = inTransitTrip(fmt.Sprintf("trip-bound-%d", i))
	}
	tripStore := &fakeTripStore{trips: trips}
	pings := &fakePingStore{pings: recentPings("any", 5, 40)}
	pred := &blockingPredictor{
		release: make(chan struct{}),
		resp:    decideResp(risk.DecisionActionContinue, risk.PredictResponse{}),
	}

	mon := risk.NewMonitor(tripStore, pings, pred, ws.NewHub(),
		&fakeDroneDispatcher{resp: &risk.DispatchResponse{Status: "DISPATCHED"}},
		&fakeFleetDensity{count: 0}, time.Hour, workers)

	done := make(chan struct{})
	go func() {
		mon.EvaluateOnce(context.Background())
		close(done)
	}()

	time.Sleep(100 * time.Millisecond) // let the pool saturate to its bound
	close(pred.release)
	<-done

	pred.mu.Lock()
	got := pred.maxInFlight
	pred.mu.Unlock()

	if got != workers {
		t.Errorf("max in-flight = %d, want exactly %d", got, workers)
	}
}

// sequencePredictor records every DecideRequest's TripID in call order. At
// workers:1 that order is deterministic and proves the priority sort; at
// higher worker counts it's used only to count completed evaluations.
type sequencePredictor struct {
	mu   sync.Mutex
	seen []string
	resp *risk.DecideResponse
}

func (s *sequencePredictor) Decide(_ context.Context, req risk.DecideRequest) (*risk.DecideResponse, error) {
	s.mu.Lock()
	s.seen = append(s.seen, req.TripID)
	s.mu.Unlock()
	return s.resp, nil
}

func (s *sequencePredictor) PredictDrone(_ context.Context, req risk.DronePredictRequest) (*risk.DronePredictResponse, error) {
	return &risk.DronePredictResponse{TripID: req.TripID, WeatherCondition: "clear"}, nil
}

// blockingPredictor blocks every Decide call until release is closed, while
// tracking the maximum number of simultaneously in-flight calls — used to
// prove the worker pool never exceeds its configured concurrency bound.
type blockingPredictor struct {
	release chan struct{}
	resp    *risk.DecideResponse

	mu          sync.Mutex
	inFlight    int
	maxInFlight int
}

func (b *blockingPredictor) Decide(_ context.Context, _ risk.DecideRequest) (*risk.DecideResponse, error) {
	b.mu.Lock()
	b.inFlight++
	if b.inFlight > b.maxInFlight {
		b.maxInFlight = b.inFlight
	}
	b.mu.Unlock()

	<-b.release

	b.mu.Lock()
	b.inFlight--
	b.mu.Unlock()

	return b.resp, nil
}

func (b *blockingPredictor) PredictDrone(_ context.Context, req risk.DronePredictRequest) (*risk.DronePredictResponse, error) {
	return &risk.DronePredictResponse{TripID: req.TripID, WeatherCondition: "clear"}, nil
}
