// Package risk implements the AI brain HTTP client and the Risk Monitor
// goroutine that polls active trips and triggers DroneHandoff transitions.
package risk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// DecisionAction is the actionable output of the AI brain's decision engine.
// Superset of the legacy Recommendation: includes REROUTE, ACTIVATE_CORRIDOR,
// and ABORT which the monitor handles with log-only stubs until Phase 6.
type DecisionAction string

const (
	DecisionActionContinue          DecisionAction = "CONTINUE"
	DecisionActionRequestBountyBoost DecisionAction = "REQUEST_BOUNTY_BOOST"
	DecisionActionDispatchDrone     DecisionAction = "DISPATCH_DRONE"
	DecisionActionReroute           DecisionAction = "REROUTE"
	DecisionActionActivateCorridor  DecisionAction = "ACTIVATE_CORRIDOR"
	DecisionActionAbort             DecisionAction = "ABORT"
)

// Recommendation mirrors the legacy /predict recommendation field still
// present in PredictResponse for informational logging. The monitor switches
// on Decision.Action (from /decide) instead.
type Recommendation string

const (
	RecommendationContinue           Recommendation = "CONTINUE"
	RecommendationRequestBountyBoost Recommendation = "REQUEST_BOUNTY_BOOST"
	RecommendationDispatchDrone      Recommendation = "DISPATCH_DRONE"
)

// Position is a typed lat/lng for the AI brain request body.
type Position struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// PredictRequest is the common payload for /predict and /decide.
// Shape locked in datasets/realtime/ai-predict.sample.request.json.
type PredictRequest struct {
	TripID                   string    `json:"trip_id"`
	CurrentPosition          Position  `json:"current_position"`
	Destination              Position  `json:"destination"`
	DeadlineSecondsRemaining int       `json:"deadline_seconds_remaining"`
	RecentSpeedsKPH          []float64 `json:"recent_speeds_kph"`
	FleetDensityInCorridor   int       `json:"fleet_density_in_corridor"`
}

// DecideRequest extends PredictRequest with corridor context so the decision
// engine can apply rule R3 (ACTIVATE_CORRIDOR) correctly.
type DecideRequest struct {
	PredictRequest
	CorridorActive bool `json:"corridor_active"`
}

// PredictResponse mirrors the AI brain's /predict response schema.
// Shape locked in datasets/realtime/ai-predict.sample.response.json.
type PredictResponse struct {
	TripID                   string         `json:"trip_id"`
	PredictedETASeconds      int            `json:"predicted_eta_seconds"`
	DeadlineSecondsRemaining int            `json:"deadline_seconds_remaining"`
	BreachProbability        float64        `json:"breach_probability"`
	WillBreach               bool           `json:"will_breach"`
	Recommendation           Recommendation `json:"recommendation"`
	WeatherCondition         string         `json:"weather_condition"`
	WeatherFactor            float64        `json:"weather_factor"`
	FleetDensityInCorridor   int            `json:"fleet_density_in_corridor"`
	FleetPenalty             float64        `json:"fleet_penalty"`
	EffectiveSpeedKPH        float64        `json:"effective_speed_kph"`
	AIConfidence             float64        `json:"ai_confidence"`
	Reasoning                string         `json:"reasoning"`
}

// DecisionFactor is one named contribution to a decision, mirroring the Python Factor type.
type DecisionFactor struct {
	Name        string  `json:"name"`
	Value       float64 `json:"value"`
	Unit        string  `json:"unit"`
	Description string  `json:"description"`
	Citation    string  `json:"citation"`
}

// DecisionResult is the decision engine's output from /decide, mirroring the Python Decision type.
// It contains the actionable outcome plus the full rule trace for audit.
type DecisionResult struct {
	TripID       string           `json:"trip_id"`
	Action       DecisionAction   `json:"action"`
	Confidence   float64          `json:"confidence"`
	RulePath     []string         `json:"rule_path"`
	Factors      []DecisionFactor `json:"factors"`
	PredictionID *string          `json:"prediction_id"`
	DecidedAt    string           `json:"decided_at"`
}

// DecideResponse is the envelope returned by POST /decide. It bundles the full
// prediction (for broadcasting) with the actionable decision (for switching).
type DecideResponse struct {
	Prediction PredictResponse `json:"prediction"`
	Decision   DecisionResult  `json:"decision"`
}

// DronePredictRequest is the payload for the AI brain's /predict-drone
// endpoint. The brain returns the weather-adjusted cruise speed, altitude,
// and ETA so the dispatcher mock no longer has to hardcode them.
type DronePredictRequest struct {
	TripID            string  `json:"trip_id"`
	Pickup            Position `json:"pickup"`
	Dropoff           Position `json:"dropoff"`
	WeatherCondition  string  `json:"weather_condition,omitempty"`
	UrgencyTier       string  `json:"urgency_tier,omitempty"`
	PayloadKG         float64 `json:"payload_kg,omitempty"`
}

// DronePredictResponse mirrors the AI brain's /predict-drone response.
type DronePredictResponse struct {
	TripID            string  `json:"trip_id"`
	RouteKM           float64 `json:"route_km"`
	CruiseKPH         float64 `json:"cruise_kph"`
	AltitudeMCruise   int     `json:"altitude_m_cruise"`
	SpinUpSeconds     int     `json:"spin_up_seconds"`
	FlightSeconds     int     `json:"flight_seconds"`
	ETASeconds        int     `json:"eta_seconds"`
	WeatherCondition  string  `json:"weather_condition"`
	WeatherFactor     float64 `json:"weather_factor"`
	PayloadFactor     float64 `json:"payload_factor"`
	Reasoning         string  `json:"reasoning"`
}

// Predictor is the interface the Monitor uses to call the AI brain.
// *Client satisfies this interface; tests inject a fake.
type Predictor interface {
	Decide(ctx context.Context, req DecideRequest) (*DecideResponse, error)
	PredictDrone(ctx context.Context, req DronePredictRequest) (*DronePredictResponse, error)
}

// Client is a typed HTTP client for the AI brain service.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewClient creates a Client pointed at baseURL with the given request timeout.
// apiKey is forwarded as "Authorization: Bearer <key>" on every request so the
// AI brain's auth middleware can enforce AI_AUTH_REQUIRED=true.
func NewClient(baseURL, apiKey string, timeout time.Duration) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: timeout},
	}
}

// PredictDrone calls POST /predict-drone on the AI brain. Returns the
// AI-computed cruise speed, altitude, and ETA for a drone failsafe trip.
// Failures here are non-fatal — the monitor falls back to mock-default
// dispatch values so a flaky AI brain doesn't block the handoff.
func (c *Client) PredictDrone(ctx context.Context, req DronePredictRequest) (*DronePredictResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("risk/client: marshal predict-drone request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/predict-drone", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("risk/client: build predict-drone request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("risk/client: POST /predict-drone: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("risk/client: /predict-drone returned HTTP %d", resp.StatusCode)
	}

	var out DronePredictResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("risk/client: decode predict-drone response: %w", err)
	}
	return &out, nil
}

// Decide calls POST /decide on the AI brain and returns the decoded response.
// The response contains both the full prediction and the actionable decision so
// the monitor can broadcast rich telemetry and act on the decision in one call.
func (c *Client) Decide(ctx context.Context, req DecideRequest) (*DecideResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("risk/client: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/decide", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("risk/client: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("risk/client: POST /decide: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("risk/client: /decide returned HTTP %d", resp.StatusCode)
	}

	var out DecideResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("risk/client: decode response: %w", err)
	}
	return &out, nil
}
