// Package integration_test exercises the full ingest → flush → corridor → WS
// pipeline against real Postgres (PostGIS) and Redis containers.
//
// The test is skipped automatically when Docker is not reachable, so it is
// safe to run in any CI environment — only runners with Docker get coverage.
package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/rest"
	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/corridor"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	pgstore "github.com/devansh-125/sipra/services/core-go/internal/store/postgres"
	redisstore "github.com/devansh-125/sipra/services/core-go/internal/store/redis"

	fiberws "github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	gorillaws "github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// TestFullPipeline runs the golden-path integration test:
//
//  1. HTTP POST pings → Redis cache (202 returned immediately)
//  2. Flush goroutine drains Redis → Postgres batch insert
//  3. PostGIS corridor computed (ST_MakeLine + ST_Buffer)
//  4. CORRIDOR_UPDATE broadcast observed on WebSocket
//  5. Corridor envelope asserted to contain every ping location
func TestFullPipeline(t *testing.T) {
	skipIfDockerUnavailable(t)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	pgConnStr, stopPG := startPostgis(t, ctx)
	defer stopPG()

	redisAddr, stopRedis := startRedis(t, ctx)
	defer stopRedis()

	pool, err := pgxpool.New(ctx, pgConnStr)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if err := runMigration(ctx, pool); err != nil {
		t.Fatalf("migration: %v", err)
	}

	rdb := goredis.NewClient(&goredis.Options{Addr: redisAddr})
	defer rdb.Close()

	pingCache := redisstore.NewPingCache(rdb)
	pingRepo := pgstore.NewPingRepo(pool)
	tripRepo := pgstore.NewTripRepo(pool)
	hub := ws.NewHub()

	// 500 m buffer is generous enough to contain pings ~100 m apart.
	corridorEngine := corridor.NewEngine(pool, 20, 500)
	corridorEngine.SetOnUpdated(func(
		_ context.Context,
		tripID domain.TripID,
		corridorID string,
		version, bufferMeters int,
		geoJSON string,
	) {
		hub.BroadcastCorridorUpdate(string(tripID), corridorID, version, bufferMeters, geoJSON)
	})

	app := buildApp(tripRepo, pingCache, hub)
	port := freePort(t)
	go app.Listen(fmt.Sprintf(":%d", port)) //nolint:errcheck
	defer app.Shutdown()                    //nolint:errcheck
	waitForServer(t, port)

	tripID := createTrip(t, port)
	startTrip(t, port, tripID)

	// Connect WS before sending pings so we catch the first CORRIDOR_UPDATE.
	wsConn := dialWS(t, port)
	defer wsConn.Close()

	corridorSeen := make(chan struct{}, 1)
	go func() {
		for {
			_, raw, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &env) == nil && env.Type == "CORRIDOR_UPDATE" {
				select {
				case corridorSeen <- struct{}{}:
				default:
				}
			}
		}
	}()

	// Three pings along a ~200 m path in Mumbai.
	pings := [][2]float64{
		{19.0760, 72.8777},
		{19.0770, 72.8787},
		{19.0780, 72.8797},
	}
	for _, p := range pings {
		postPing(t, port, tripID, p[0], p[1])
	}

	// Start flush with a short interval so the test doesn't wait long.
	flushCtx, flushCancel := context.WithCancel(ctx)
	defer flushCancel()
	go pingCache.FlushPingsToDB(flushCtx, 150*time.Millisecond, pingRepo.BatchInsert,
		func(innerCtx context.Context, tid domain.TripID) {
			cCtx, cCancel := context.WithTimeout(innerCtx, 20*time.Second)
			defer cCancel()
			if err := corridorEngine.CalculateRollingCorridor(cCtx, tid); err != nil {
				t.Logf("corridor compute error: %v", err)
			}
		},
	)

	select {
	case <-corridorSeen:
		// Pipeline completed end-to-end.
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for CORRIDOR_UPDATE on WebSocket")
	}

	// Assert every ping location is inside the corridor envelope.
	for _, p := range pings {
		lat, lng := p[0], p[1]
		var contained bool
		err := pool.QueryRow(ctx, `
			SELECT ST_Contains(
				(SELECT envelope
				 FROM corridors
				 WHERE trip_id = $1 AND valid_until IS NULL
				 ORDER BY version DESC LIMIT 1),
				ST_SetSRID(ST_MakePoint($2, $3), 4326)
			)`, tripID, lng, lat).Scan(&contained)
		if err != nil {
			t.Fatalf("ST_Contains query (lat=%.4f lng=%.4f): %v", lat, lng, err)
		}
		if !contained {
			t.Errorf("corridor does not contain ping at lat=%.4f lng=%.4f", lat, lng)
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func skipIfDockerUnavailable(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "info")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		t.Skipf("Docker not reachable (docker info: %v) — skipping integration test", err)
	}
}

func startPostgis(t *testing.T, ctx context.Context) (connStr string, stop func()) {
	t.Helper()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image: "postgis/postgis:16-3.4",
			Env: map[string]string{
				"POSTGRES_USER":     "sipra",
				"POSTGRES_PASSWORD": "sipra",
				"POSTGRES_DB":       "sipra_test",
			},
			ExposedPorts: []string{"5432/tcp"},
			WaitingFor: wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(120 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("start postgis container: %v", err)
	}
	host, err := c.Host(ctx)
	if err != nil {
		t.Fatalf("postgis host: %v", err)
	}
	port, err := c.MappedPort(ctx, "5432")
	if err != nil {
		t.Fatalf("postgis port: %v", err)
	}
	dsn := fmt.Sprintf("postgres://sipra:sipra@%s:%s/sipra_test", host, port.Port())
	return dsn, func() { c.Terminate(context.Background()) } //nolint:errcheck
}

func startRedis(t *testing.T, ctx context.Context) (addr string, stop func()) {
	t.Helper()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "redis:7-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor: wait.ForLog("Ready to accept connections").
				WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("start redis container: %v", err)
	}
	host, err := c.Host(ctx)
	if err != nil {
		t.Fatalf("redis host: %v", err)
	}
	port, err := c.MappedPort(ctx, "6379")
	if err != nil {
		t.Fatalf("redis port: %v", err)
	}
	return host + ":" + port.Port(), func() { c.Terminate(context.Background()) } //nolint:errcheck
}

func runMigration(ctx context.Context, pool *pgxpool.Pool) error {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return fmt.Errorf("runtime.Caller failed")
	}
	sqlPath := filepath.Join(filepath.Dir(thisFile),
		"../../internal/store/postgres/migrations/001_init.sql")
	sqlBytes, err := os.ReadFile(sqlPath)
	if err != nil {
		return fmt.Errorf("read migration file: %w", err)
	}
	_, err = pool.Exec(ctx, string(sqlBytes))
	return err
}

// buildApp assembles a minimal Fiber app — trip CRUD, ping ingest, WS hub.
// No risk monitor or webhook dispatcher to keep the test self-contained.
func buildApp(tripRepo *pgstore.TripRepo, pingCache *redisstore.PingCache, hub *ws.Hub) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})

	app.Use("/ws", func(c *fiber.Ctx) error {
		if fiberws.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})
	app.Get("/ws/dashboard", fiberws.New(hub.Handler()))

	tripH := rest.NewTripHandler(tripRepo)
	pingH := rest.NewPingHandler(pingCache, hub)

	v1 := app.Group("/api/v1")
	v1.Post("/trips", tripH.CreateTrip)
	v1.Post("/trips/:id/start", tripH.StartTrip)
	v1.Post("/trips/:id/pings", pingH.IngestPing)

	return app
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func waitForServer(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	url := fmt.Sprintf("http://localhost:%d/api/v1/trips/probe", port)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url) //nolint:noctx
		if err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatal("Fiber server did not start within 10 seconds")
}

func createTrip(t *testing.T, port int) string {
	t.Helper()
	body := map[string]any{
		"cargo_category":       "Organ",
		"cargo_description":    "Kidney",
		"origin":               map[string]any{"lat": 19.0760, "lng": 72.8777},
		"destination":          map[string]any{"lat": 19.2183, "lng": 72.9781},
		"golden_hour_deadline": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		"ambulance_id":         "AMB-TEST-01",
	}
	raw, _ := json.Marshal(body)
	resp, err := http.Post( //nolint:noctx
		fmt.Sprintf("http://localhost:%d/api/v1/trips", port),
		"application/json",
		bytes.NewReader(raw),
	)
	if err != nil {
		t.Fatalf("createTrip POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("createTrip: expected 201, got %d — %s", resp.StatusCode, b)
	}
	var result struct {
		TripID string `json:"trip_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("createTrip decode: %v", err)
	}
	return result.TripID
}

func startTrip(t *testing.T, port int, tripID string) {
	t.Helper()
	resp, err := http.Post( //nolint:noctx
		fmt.Sprintf("http://localhost:%d/api/v1/trips/%s/start", port, tripID),
		"application/json",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("startTrip POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("startTrip: expected 200, got %d — %s", resp.StatusCode, b)
	}
}

func postPing(t *testing.T, port int, tripID string, lat, lng float64) {
	t.Helper()
	body := map[string]any{
		"lat":         lat,
		"lng":         lng,
		"recorded_at": time.Now().UTC().Format(time.RFC3339),
	}
	raw, _ := json.Marshal(body)
	resp, err := http.Post( //nolint:noctx
		fmt.Sprintf("http://localhost:%d/api/v1/trips/%s/pings", port, tripID),
		"application/json",
		bytes.NewReader(raw),
	)
	if err != nil {
		t.Fatalf("postPing (%.4f, %.4f): %v", lat, lng, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("postPing: expected 202, got %d — %s", resp.StatusCode, b)
	}
}

func dialWS(t *testing.T, port int) *gorillaws.Conn {
	t.Helper()
	url := fmt.Sprintf("ws://localhost:%d/ws/dashboard", port)
	conn, _, err := gorillaws.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dialWS: %v", err)
	}
	return conn
}
