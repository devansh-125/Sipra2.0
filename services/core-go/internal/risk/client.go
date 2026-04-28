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

// PredictRequest is the payload sent to the AI brain's POST /predict endpoint.
type PredictRequest struct {
	TripID             string    `json:"trip_id"`
	CurrentLat         float64   `json:"current_lat"`
	CurrentLng         float64   `json:"current_lng"`
	DestinationLat     float64   `json:"destination_lat"`
	DestinationLng     float64   `json:"destination_lng"`
	GoldenHourDeadline time.Time `json:"golden_hour_deadline"`
	AvgSpeedKPH        float64   `json:"avg_speed_kph"`
}

// PredictResponse mirrors the AI brain's response schema.
type PredictResponse struct {
	TripID                   string   `json:"trip_id"`
	PredictedETASeconds      int      `json:"predicted_eta_seconds"`
	DeadlineSecondsRemaining int      `json:"deadline_seconds_remaining"`
	BreachProbability        float64  `json:"breach_probability"`
	WillBreach               bool     `json:"will_breach"`
	WeatherCondition         string   `json:"weather_condition"`
	WeatherFactor            float64  `json:"weather_factor"`
	Reasoning                string   `json:"reasoning"`
	AIConfidence             float64  `json:"ai_confidence"`
	AIReasoning              string   `json:"ai_reasoning"`
	RiskFactors              []string `json:"risk_factors"`
	Recommendations          []string `json:"recommendations"`
}

// Predictor is the interface the Monitor uses to call the AI brain.
// *Client satisfies this interface; tests inject a fake.
type Predictor interface {
	Predict(ctx context.Context, req PredictRequest) (*PredictResponse, error)
}

// Client is a typed HTTP client for the AI brain service.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient creates a Client pointed at baseURL with the given request timeout.
func NewClient(baseURL string, timeout time.Duration) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: timeout},
	}
}

// Predict calls POST /predict on the AI brain and returns the decoded response.
func (c *Client) Predict(ctx context.Context, req PredictRequest) (*PredictResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("risk/client: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/predict", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("risk/client: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("risk/client: POST /predict: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("risk/client: /predict returned HTTP %d", resp.StatusCode)
	}

	var out PredictResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("risk/client: decode response: %w", err)
	}
	return &out, nil
}
