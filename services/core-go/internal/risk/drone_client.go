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

// DispatchRequest is the payload sent to the mock drone dispatch API.
type DispatchRequest struct {
	TripID    string `json:"trip_id"`
	Pickup    LatLng `json:"pickup"`
	Dropoff   LatLng `json:"dropoff"`
	CargoType string `json:"cargo_type"`
	Priority  string `json:"priority"`
}

// DispatchResponse mirrors the mock drone dispatch API's response schema.
type DispatchResponse struct {
	DroneID    string `json:"drone_id"`
	ETASeconds int    `json:"eta_seconds"`
	Status     string `json:"status"`
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
