package risk_test

import (
	"context"
	"errors"
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
	ping *domain.GPSPing
	err  error
}

func (f *fakePingStore) GetLatest(_ context.Context, _ domain.TripID) (*domain.GPSPing, error) {
	return f.ping, f.err
}

type fakePredictor struct {
	resp *risk.PredictResponse
	err  error
}

func (f *fakePredictor) Predict(_ context.Context, _ risk.PredictRequest) (*risk.PredictResponse, error) {
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

func latestPing(tripID string) *domain.GPSPing {
	speed := 40.0
	return &domain.GPSPing{
		TripID:   domain.TripID(tripID),
		Location: domain.Point{Lat: 12.8000, Lng: 77.4000},
		SpeedKPH: &speed,
	}
}

func newMonitor(trips risk.TripStore, pings risk.PingStore, p risk.Predictor) *risk.Monitor {
	return risk.NewMonitor(trips, pings, p, ws.NewHub(), time.Hour)
}

// --- tests ---

func TestEvaluateOnce_HandoffWhenWillBreach(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-1")}}
	pings := &fakePingStore{ping: latestPing("trip-1")}
	pred := &fakePredictor{resp: &risk.PredictResponse{
		WillBreach: true, PredictedETASeconds: 4500, Reasoning: "ETA exceeds deadline",
	}}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if len(trips.updated) != 1 || trips.updated[0] != "trip-1" {
		t.Fatalf("expected trip-1 updated to DroneHandoff, got %v", trips.updated)
	}
}

func TestEvaluateOnce_NoHandoffWhenNoBreach(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-2")}}
	pings := &fakePingStore{ping: latestPing("trip-2")}
	pred := &fakePredictor{resp: &risk.PredictResponse{WillBreach: false, PredictedETASeconds: 1800}}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no status update, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsOnPredictError(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-3")}}
	pings := &fakePingStore{ping: latestPing("trip-3")}
	pred := &fakePredictor{err: errors.New("ai brain unreachable")}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update on predict error, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsOnNoPing(t *testing.T) {
	trips := &fakeTripStore{trips: []domain.Trip{inTransitTrip("trip-4")}}
	pings := &fakePingStore{err: errors.New("no pings yet")}
	pred := &fakePredictor{resp: &risk.PredictResponse{WillBreach: true}}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update when ping unavailable, got %v", trips.updated)
	}
}

func TestEvaluateOnce_SkipsAlreadyHandoff(t *testing.T) {
	// A trip that is already in DroneHandoff should not be re-listed (status='InTransit'
	// query won't return it), but even if it somehow arrives here the state machine
	// rejects the transition gracefully.
	trip := domain.Trip{
		ID:                 "trip-5",
		Status:             domain.TripStatusDroneHandoff,
		GoldenHourDeadline: time.Now().Add(30 * time.Minute),
		Destination:        domain.Point{Lat: 12.9716, Lng: 77.5946},
	}
	trips := &fakeTripStore{trips: []domain.Trip{trip}}
	pings := &fakePingStore{ping: latestPing("trip-5")}
	pred := &fakePredictor{resp: &risk.PredictResponse{WillBreach: true}}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if len(trips.updated) != 0 {
		t.Fatalf("expected no update for already-handoff trip, got %v", trips.updated)
	}
}

func TestEvaluateOnce_UsesDefaultSpeedWhenNil(t *testing.T) {
	// Verify the monitor doesn't panic when SpeedKPH is nil.
	trip := inTransitTrip("trip-6")
	ping := &domain.GPSPing{
		TripID:   "trip-6",
		Location: domain.Point{Lat: 12.8, Lng: 77.4},
		SpeedKPH: nil,
	}
	var capturedReq risk.PredictRequest
	pred := &capturePredictor{
		capture: &capturedReq,
		resp:    &risk.PredictResponse{WillBreach: false},
	}
	trips := &fakeTripStore{trips: []domain.Trip{trip}}
	pings := &fakePingStore{ping: ping}

	newMonitor(trips, pings, pred).EvaluateOnce(context.Background())

	if capturedReq.AvgSpeedKPH != 40.0 {
		t.Fatalf("expected default speed 40 kph, got %v", capturedReq.AvgSpeedKPH)
	}
}

// capturePredictor records the last PredictRequest it received.
type capturePredictor struct {
	capture *risk.PredictRequest
	resp    *risk.PredictResponse
}

func (c *capturePredictor) Predict(_ context.Context, req risk.PredictRequest) (*risk.PredictResponse, error) {
	*c.capture = req
	return c.resp, nil
}
