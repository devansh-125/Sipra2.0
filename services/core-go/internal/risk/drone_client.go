package risk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// LatLng is a geographic coordinate used in dispatch requests.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// AIPredictedFlight carries the AI brain's drone-flight numbers into
// the partner dispatch call. When present, the mock dispatcher echoes
// these values instead of computing its own — keeping cruise/altitude/
// ETA consistent with the operator dashboard explainability panel.
type AIPredictedFlight struct {
	CruiseKPH       float64 `json:"cruise_kph"`
	AltitudeMCruise int     `json:"altitude_m_cruise"`
	SpinUpSeconds   int     `json:"spin_up_seconds"`
	ETASeconds      int     `json:"eta_seconds"`
	RouteKM         float64 `json:"route_km"`
	WeatherCondition string `json:"weather_condition,omitempty"`
}

// DispatchRequest is the payload sent to the mock drone dispatch API.
type DispatchRequest struct {
	TripID      string             `json:"trip_id"`
	Pickup      LatLng             `json:"pickup"`
	Dropoff     LatLng             `json:"dropoff"`
	CargoType   string             `json:"cargo_type"`
	Priority    string             `json:"priority"`
	AIPredicted *AIPredictedFlight `json:"ai_predicted,omitempty"`
}

// DroneMetadata mirrors the drone-dispatch mock's metadata block. Surfaced
// on the dashboard's HandoffBanner so operators see which drone was
// allocated, its battery, launch pad, cruise speed, and route distance.
// Shape locked in datasets/realtime/drone-dispatch.sample.response.json.
// CruiseKPH and AltitudeMCruise are floats so the AI-computed weather-
// derated values (e.g. 73.5 kph in heavy rain) survive the wire round-trip.
type DroneMetadata struct {
	Model           string  `json:"model"`
	MaxPayloadKG    float64 `json:"max_payload_kg"`
	BatteryPct      int     `json:"battery_pct"`
	LaunchPadID     string  `json:"launch_pad_id"`
	AltitudeMCruise float64 `json:"altitude_m_cruise"`
	CruiseKPH       float64 `json:"cruise_kph"`
	RouteKM         float64 `json:"route_km"`
}

// DispatchResponse mirrors the mock drone dispatch API's response schema.
type DispatchResponse struct {
	DroneID       string         `json:"drone_id"`
	ETASeconds    int            `json:"eta_seconds"`
	Status        string         `json:"status"`
	DroneMetadata *DroneMetadata `json:"drone_metadata,omitempty"`
}

// DroneDispatcher is the interface the Monitor uses to request a drone.
// *DroneClient satisfies this interface; tests inject a fake.
type DroneDispatcher interface {
	Dispatch(ctx context.Context, req DispatchRequest) (*DispatchResponse, error)
}

// DroneClient is a typed HTTP client for the mock drone dispatch service.
type DroneClient struct {
	baseURL string
	http    *http.Client
}

// NewDroneClient creates a DroneClient pointed at baseURL with the given timeout.
func NewDroneClient(baseURL string, timeout time.Duration) *DroneClient {
	return &DroneClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: timeout},
	}
}

// Dispatch calls POST /api/v1/drones/dispatch and returns the decoded response.
func (c *DroneClient) Dispatch(ctx context.Context, req DispatchRequest) (*DispatchResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("risk/drone_client: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx, http.MethodPost,
		c.baseURL+"/api/v1/drones/dispatch",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("risk/drone_client: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("risk/drone_client: POST /api/v1/drones/dispatch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("risk/drone_client: dispatch returned HTTP %d", resp.StatusCode)
	}

	var out DispatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("risk/drone_client: decode response: %w", err)
	}
	return &out, nil
}
