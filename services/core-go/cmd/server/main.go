package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/api/rest"
	"github.com/devansh-125/sipra/services/core-go/internal/api/ws"
	"github.com/devansh-125/sipra/services/core-go/internal/config"
	"github.com/devansh-125/sipra/services/core-go/internal/corridor"
	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/devansh-125/sipra/services/core-go/internal/risk"
	pgstore "github.com/devansh-125/sipra/services/core-go/internal/store/postgres"
	redisstore "github.com/devansh-125/sipra/services/core-go/internal/store/redis"
	"github.com/devansh-125/sipra/services/core-go/internal/webhooks"

	fiberws "github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{
		Out:        os.Stderr,
		TimeFormat: time.RFC3339,
	})

	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("config: missing required environment variables")
	}

	lvl, err := zerolog.ParseLevel(cfg.LogLevel)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("pgxpool: failed to create pool")
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatal().Err(err).Msg("pgxpool: could not reach postgres")
	}
	log.Info().Msg("postgres: connected")

	redisOpt, err := goredis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Str("url", cfg.RedisURL).Msg("redis: invalid URL")
	}
	rdb := goredis.NewClient(redisOpt)
	defer rdb.Close()

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatal().Err(err).Msg("redis: could not reach server")
	}
	log.Info().Msg("redis: connected")

	tripRepo := pgstore.NewTripRepo(pool)
	pingRepo := pgstore.NewPingRepo(pool)
	pingCache := redisstore.NewPingCache(rdb)
	corridorEngine := corridor.NewEngine(pool, cfg.CorridorPingWindow, cfg.CorridorBufferM)

	hub := ws.NewHub()

	dispatcher := webhooks.NewDispatcher(pool, webhooks.Config{
		QueueSize:   cfg.WebhookQueueSize,
		HTTPTimeout: time.Duration(cfg.WebhookTimeoutMS) * time.Millisecond,
	})
	dispatcher.Start(cfg.WebhookWorkers)
	defer dispatcher.Stop()

	corridorEngine.SetOnUpdated(func(
		_ context.Context,
		tripID domain.TripID,
		corridorID string,
		version, bufferMeters int,
		geoJSON string,
	) {
		hub.BroadcastCorridorUpdate(string(tripID), corridorID, version, bufferMeters, geoJSON)

		// Give the DB query its own deadline — the hook context is ephemeral and
		// its cancellation must not silently drop partner deliveries.
		queryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		n, err := dispatcher.BroadcastCorridor(queryCtx, string(tripID), corridorID, version, bufferMeters, geoJSON)
		if err != nil {
			log.Error().Err(err).Str("trip", string(tripID)).Msg("webhook: broadcast failed")
			return
		}
		log.Info().
			Str("trip", string(tripID)).
			Str("corridor", corridorID).
			Int("partners", n).
			Msg("corridor broadcast enqueued")
	})

	riskClient := risk.NewClient(
		cfg.AiBrainURL,
		time.Duration(cfg.AiBrainTimeoutMS)*time.Millisecond,
	)
	droneClient := risk.NewDroneClient(
		cfg.MockDroneURL,
		time.Duration(cfg.AiBrainTimeoutMS)*time.Millisecond,
	)
	riskMonitor := risk.NewMonitor(
		tripRepo,
		pingRepo,
		riskClient,
		hub,
		droneClient,
		time.Duration(cfg.RiskPollIntervalS)*time.Second,
	)
	riskMonitor.Start(ctx)

	flushInterval := time.Duration(cfg.PingFlushIntervalS) * time.Second
	go pingCache.FlushPingsToDB(ctx, flushInterval, pingRepo.BatchInsert,
		func(flushCtx context.Context, tripID domain.TripID) {
			computeCtx, cancel := context.WithTimeout(flushCtx, 30*time.Second)
			defer cancel()
			if err := corridorEngine.CalculateRollingCorridor(computeCtx, tripID); err != nil {
				log.Error().Err(err).Str("trip", string(tripID)).Msg("corridor: update failed")
			}
		},
	)

	app := fiber.New(fiber.Config{
		AppName:               "Sipra Core API",
		ReadTimeout:           5 * time.Second,
		WriteTimeout:          10 * time.Second,
		IdleTimeout:           30 * time.Second,
		DisableStartupMessage: false,
	})

	app.Use(recover.New())
	app.Use(logger.New(logger.Config{
		Format: "${time} | ${status} | ${latency} | ${method} ${path}\n",
	}))

	app.Get("/healthz", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":     "ok",
			"service":    "sipra-core",
			"ws_clients": hub.ClientCount(),
		})
	})

	app.Use("/ws", func(c *fiber.Ctx) error {
		if fiberws.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})
	app.Get("/ws/dashboard", fiberws.New(hub.Handler()))

	tripHandler := rest.NewTripHandler(tripRepo)
	pingHandler := rest.NewPingHandler(pingCache, hub)

	v1 := app.Group("/api/v1")
	v1.Post("/trips", tripHandler.CreateTrip)
	v1.Post("/trips/:id/pings", pingHandler.IngestPing)

	go func() {
		<-ctx.Done()
		log.Info().Msg("shutdown: signal received, draining connections")

		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := app.ShutdownWithContext(shutCtx); err != nil {
			log.Error().Err(err).Msg("shutdown: fiber did not drain cleanly")
		}
	}()

	log.Info().Str("port", cfg.Port).Msg("server: listening")
	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Error().Err(err).Msg("server: stopped")
	}
}
