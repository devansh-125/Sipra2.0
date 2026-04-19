package config

import "github.com/caarlos0/env/v11"

// Config holds all runtime parameters parsed from environment variables.
type Config struct {
	DatabaseURL string `env:"DATABASE_URL,required"`
	RedisURL    string `env:"REDIS_URL,required"`
	Port        string `env:"PORT"      envDefault:"8080"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`

	PingFlushIntervalS int `env:"PING_FLUSH_INTERVAL_SEC" envDefault:"5"`
	CorridorPingWindow int `env:"CORRIDOR_PING_WINDOW"    envDefault:"20"`
	CorridorBufferM    int `env:"CORRIDOR_BUFFER_M"       envDefault:"2000"`

	// WebhookWorkers should be sized to active_partners × corridor_updates/sec.
	WebhookWorkers   int `env:"WEBHOOK_WORKERS"    envDefault:"8"`
	WebhookQueueSize int `env:"WEBHOOK_QUEUE_SIZE" envDefault:"1024"`
	WebhookTimeoutMS int `env:"WEBHOOK_TIMEOUT_MS" envDefault:"5000"`

	AiBrainURL        string `env:"AI_BRAIN_URL"           envDefault:"http://localhost:8000"`
	RiskPollIntervalS int    `env:"RISK_POLL_INTERVAL_SEC" envDefault:"10"`
	AiBrainTimeoutMS  int    `env:"AI_BRAIN_TIMEOUT_MS"    envDefault:"3000"`
}

// Load parses Config from the process environment.
func Load() (Config, error) {
	var cfg Config
	return cfg, env.Parse(&cfg)
}
