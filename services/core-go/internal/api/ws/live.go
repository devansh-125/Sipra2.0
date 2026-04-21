// Package ws implements the real-time WebSocket fan-out for the Sipra dashboard.
package ws

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/metrics"
	"github.com/gofiber/contrib/websocket"
	"github.com/rs/zerolog/log"
)

type MessageType string

const (
	MsgGPSUpdate        MessageType = "GPS_UPDATE"
	MsgCorridorUpdate   MessageType = "CORRIDOR_UPDATE"
	MsgHandoffInitiated MessageType = "HANDOFF_INITIATED"
	MsgFleetSpawn       MessageType = "FLEET_SPAWN"
	MsgRerouteStatus    MessageType = "REROUTE_STATUS"
)

// Envelope is the discriminated-union wrapper for all outbound WebSocket messages.
type Envelope struct {
	Type      MessageType `json:"type"`
	Timestamp time.Time   `json:"timestamp"`
	Payload   interface{} `json:"payload"`
}

type GPSUpdatePayload struct {
	TripID     string    `json:"trip_id"`
	PingID     string    `json:"ping_id"`
	Lat        float64   `json:"lat"`
	Lng        float64   `json:"lng"`
	HeadingDeg *float64  `json:"heading_deg,omitempty"`
	SpeedKPH   *float64  `json:"speed_kph,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
}

// HandoffInitiatedPayload signals that the AI brain predicted an ETA breach
// and the trip has been transitioned to DroneHandoff.
type HandoffInitiatedPayload struct {
	TripID              string `json:"trip_id"`
	DroneID             string `json:"drone_id,omitempty"`
	ETASeconds          int    `json:"eta_seconds,omitempty"`
	Reason              string `json:"reason"`
	PredictedETASeconds int    `json:"predicted_eta_seconds"`
}

// CorridorUpdatePayload carries the polygon as raw JSON so the frontend can
// feed it directly into Mapbox/Leaflet without re-serialization.
type CorridorUpdatePayload struct {
	TripID         string          `json:"trip_id"`
	CorridorID     string          `json:"corridor_id"`
	Version        int             `json:"version"`
	BufferMeters   int             `json:"buffer_meters"`
	PolygonGeoJSON json.RawMessage `json:"polygon_geojson"`
}

// FleetVehicle is a single synthetic fleet vehicle broadcast by the chaos spawn-fleet endpoint.
type FleetVehicle struct {
	ID     string  `json:"id"`
	Lat    float64 `json:"lat"`
	Lng    float64 `json:"lng"`
	Status string  `json:"status"`
}

// FleetSpawnPayload carries a batch of synthetic fleet vehicles to the dashboard.
type FleetSpawnPayload struct {
	Vehicles []FleetVehicle `json:"vehicles"`
}

// RerouteStatusPayload carries a driver's reroute lifecycle status change to
// all connected dashboard clients, enabling real-time fleet reroute tracking.
type RerouteStatusPayload struct {
	DriverRef    string `json:"driver_ref"`
	TripID       string `json:"trip_id"`
	Status       string `json:"status"` // "rerouting", "completed", "failed"
	BountyID     string `json:"bounty_id,omitempty"`
	AmountPoints int    `json:"amount_points,omitempty"`
}

// client owns one WebSocket connection and its serialized write channel.
// closeOnce prevents a double-close race between unregister and writePump exit.
type client struct {
	id        uint64
	conn      *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
}

// Hub manages the set of connected dashboard WebSocket clients.
// All broadcasts are non-blocking: a full client buffer causes that message
// to be dropped rather than stalling the ambulance ingest path.
type Hub struct {
	mu         sync.RWMutex
	clients    map[uint64]*client
	nextID     atomic.Uint64
	sendBuffer int
}

// NewHub creates a Hub with a per-client outbound buffer of 64 messages.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[uint64]*client),
		sendBuffer: 64,
	}
}

// Handler returns a Fiber WebSocket handler that manages the full client
// lifecycle: register → read/write pumps → unregister on disconnect.
func (h *Hub) Handler() func(*websocket.Conn) {
	return func(c *websocket.Conn) {
		cl := h.register(c)
		defer h.unregister(cl)
		go h.writePump(cl)
		h.readPump(cl)
	}
}

func (h *Hub) register(conn *websocket.Conn) *client {
	cl := &client{
		id:   h.nextID.Add(1),
		conn: conn,
		send: make(chan []byte, h.sendBuffer),
	}
	h.mu.Lock()
	h.clients[cl.id] = cl
	count := len(h.clients)
	h.mu.Unlock()

	metrics.WSClientsConnected.Set(float64(count))
	log.Info().Uint64("client", cl.id).Int("total", count).Msg("ws: client connected")
	return cl
}

func (h *Hub) unregister(cl *client) {
	h.mu.Lock()
	delete(h.clients, cl.id)
	count := len(h.clients)
	h.mu.Unlock()

	cl.closeOnce.Do(func() { close(cl.send) })
	_ = cl.conn.Close()
	metrics.WSClientsConnected.Set(float64(count))
	log.Info().Uint64("client", cl.id).Int("total", count).Msg("ws: client disconnected")
}

// readPump blocks until the client disconnects, draining inbound frames.
// The dashboard is currently receive-only; this exists to handle pings/closes.
func (h *Hub) readPump(cl *client) {
	for {
		if _, _, err := cl.conn.ReadMessage(); err != nil {
			return
		}
	}
}

// writePump is the sole goroutine permitted to write to this client's connection.
// Fasthttp WebSocket connections are not concurrent-write safe.
func (h *Hub) writePump(cl *client) {
	for msg := range cl.send {
		_ = cl.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := cl.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Debug().Err(err).Uint64("client", cl.id).Msg("ws: write failed, dropping client")
			return
		}
	}
}

// BroadcastGPSUpdate fans a GPS_UPDATE to every connected dashboard client.
func (h *Hub) BroadcastGPSUpdate(p domain.GPSPing) {
	h.broadcast(Envelope{
		Type:      MsgGPSUpdate,
		Timestamp: time.Now().UTC(),
		Payload: GPSUpdatePayload{
			TripID:     string(p.TripID),
			PingID:     string(p.ID),
			Lat:        p.Location.Lat,
			Lng:        p.Location.Lng,
			HeadingDeg: p.HeadingDeg,
			SpeedKPH:   p.SpeedKPH,
			RecordedAt: p.RecordedAt,
		},
	})
}

// BroadcastCorridorUpdate fans a CORRIDOR_UPDATE to every connected client.
// polygonGeoJSON must be valid GeoJSON (ST_AsGeoJSON output).
func (h *Hub) BroadcastCorridorUpdate(tripID, corridorID string, version, bufferMeters int, polygonGeoJSON string) {
	h.broadcast(Envelope{
		Type:      MsgCorridorUpdate,
		Timestamp: time.Now().UTC(),
		Payload: CorridorUpdatePayload{
			TripID:         tripID,
			CorridorID:     corridorID,
			Version:        version,
			BufferMeters:   bufferMeters,
			PolygonGeoJSON: json.RawMessage(polygonGeoJSON),
		},
	})
}

// BroadcastHandoffInitiated fans a HANDOFF_INITIATED to every connected client.
// droneID and etaSeconds are optional (populated in F3 once drone dispatch is wired).
func (h *Hub) BroadcastHandoffInitiated(tripID, reason string, predictedETASeconds int) {
	h.BroadcastHandoffInitiatedFull(tripID, "", 0, reason, predictedETASeconds)
}

// BroadcastHandoffInitiatedFull is the full-fidelity variant used by F3 once the drone
// dispatch API returns a drone_id and eta_seconds.
func (h *Hub) BroadcastHandoffInitiatedFull(tripID, droneID string, etaSeconds int, reason string, predictedETASeconds int) {
	h.broadcast(Envelope{
		Type:      MsgHandoffInitiated,
		Timestamp: time.Now().UTC(),
		Payload: HandoffInitiatedPayload{
			TripID:              tripID,
			DroneID:             droneID,
			ETASeconds:          etaSeconds,
			Reason:              reason,
			PredictedETASeconds: predictedETASeconds,
		},
	})
}

// BroadcastFleetSpawn fans a FLEET_SPAWN envelope to every connected dashboard client.
// Used exclusively by the chaos spawn-fleet endpoint.
func (h *Hub) BroadcastFleetSpawn(vehicles []FleetVehicle) {
	h.broadcast(Envelope{
		Type:      MsgFleetSpawn,
		Timestamp: time.Now().UTC(),
		Payload:   FleetSpawnPayload{Vehicles: vehicles},
	})
}

// BroadcastRerouteStatus fans a REROUTE_STATUS envelope to every connected client.
// This enables Mission Control to track individual driver reroute progress in real time.
func (h *Hub) BroadcastRerouteStatus(driverRef, tripID, status, bountyID string, amountPoints int) {
	h.broadcast(Envelope{
		Type:      MsgRerouteStatus,
		Timestamp: time.Now().UTC(),
		Payload: RerouteStatusPayload{
			DriverRef:    driverRef,
			TripID:       tripID,
			Status:       status,
			BountyID:     bountyID,
			AmountPoints: amountPoints,
		},
	})
}

// ClientCount returns the number of currently connected clients (used by /healthz).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// broadcast marshals once and delivers to all clients under a read-lock.
// Clients whose send buffer is full are skipped to protect the write path.
func (h *Hub) broadcast(env Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		log.Error().Err(err).Str("type", string(env.Type)).Msg("ws: marshal envelope")
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, cl := range h.clients {
		select {
		case cl.send <- data:
		default:
			log.Warn().Uint64("client", cl.id).Str("type", string(env.Type)).Msg("ws: buffer full, dropping message")
		}
	}
}
