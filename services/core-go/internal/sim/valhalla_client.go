package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
)

type ValhallaClient struct {
	baseURL string
	http    *http.Client
}

func NewValhallaClient(baseURL string, timeout time.Duration) *ValhallaClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &ValhallaClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: timeout},
	}
}

type RouteRequest struct {
	Origin          domain.Point
	Destination     domain.Point
	ExcludePolygons [][][]float64
}

type routeResponse struct {
	Trip struct {
		Legs []struct {
			Shape string `json:"shape"`
		} `json:"legs"`
	} `json:"trip"`
}

func (c *ValhallaClient) Route(ctx context.Context, req RouteRequest) ([]domain.Point, error) {
	body := map[string]interface{}{
		"locations": []map[string]float64{
			{"lat": req.Origin.Lat, "lon": req.Origin.Lng},
			{"lat": req.Destination.Lat, "lon": req.Destination.Lng},
		},
		"costing":         "auto",
		"directions_type": "none",
		"units":           "kilometers",
	}
	if len(req.ExcludePolygons) > 0 {
		body["exclude_polygons"] = req.ExcludePolygons
	}

	b, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("valhalla route marshal: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/route", bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("valhalla route request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("valhalla route call: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("valhalla route status=%d body=%s", resp.StatusCode, string(raw))
	}

	var parsed routeResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("valhalla route decode: %w", err)
	}
	if len(parsed.Trip.Legs) == 0 || parsed.Trip.Legs[0].Shape == "" {
		return nil, fmt.Errorf("valhalla route: empty leg shape")
	}

	points := decodePolyline6(parsed.Trip.Legs[0].Shape)
	if len(points) < 2 {
		return nil, fmt.Errorf("valhalla route: decoded shape too short")
	}
	return points, nil
}

func decodePolyline6(encoded string) []domain.Point {
	points := make([]domain.Point, 0, 64)
	var lat, lng int64
	i := 0
	for i < len(encoded) {
		dlat, n := decodeSigned(encoded, i)
		i = n
		dlng, n2 := decodeSigned(encoded, i)
		i = n2
		lat += dlat
		lng += dlng
		points = append(points, domain.Point{
			Lat: float64(lat) / 1e6,
			Lng: float64(lng) / 1e6,
		})
	}
	return points
}

func decodeSigned(s string, start int) (int64, int) {
	var result int64
	var shift uint
	i := start
	for {
		b := int64(s[i] - 63)
		i++
		result |= (b & 0x1f) << shift
		shift += 5
		if b < 0x20 {
			break
		}
	}
	if result&1 != 0 {
		return ^(result >> 1), i
	}
	return result >> 1, i
}
