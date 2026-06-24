package config

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/caarlos0/env/v11"
)

// Config holds all runtime parameters parsed from environment variables.
type Config struct {
	DatabaseURL string `env:"DATABASE_URL,required"`
	RedisURL    string `env:"REDIS_URL,required"`
	Port        string `env:"PORT"      envDefault:"8080"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`

	PingFlushIntervalS int `env:"PING_FLUSH_INTERVAL_SEC" envDefault:"5"`
	CorridorPingWindow int `env:"CORRIDOR_PING_WINDOW"    envDefault:"20"`
	CorridorBufferM    int `env:"CORRIDOR_BUFFER_M"       envDefault:"2000"`

	// WebhookWorkers is the number of Kafka consumer goroutines draining the
	// delivery topic; size it to active_partners × corridor_updates/sec.
	WebhookWorkers   int `env:"WEBHOOK_WORKERS"    envDefault:"8"`
	WebhookTimeoutMS int `env:"WEBHOOK_TIMEOUT_MS" envDefault:"5000"`

	// KafkaBrokers is the bootstrap broker list backing the webhook delivery
	// queue. Durability boundary: a crash between produce and consumer commit
	// redelivers the message instead of losing it (unlike an in-process channel).
	KafkaBrokers       []string `env:"KAFKA_BROKERS"        envSeparator:"," envDefault:"localhost:9092"`
	KafkaWebhookTopic  string   `env:"KAFKA_WEBHOOK_TOPIC"  envDefault:"sipra.webhook.deliveries"`
	KafkaConsumerGroup string   `env:"KAFKA_CONSUMER_GROUP" envDefault:"sipra-webhook-dispatcher"`

	AiBrainURL        string `env:"AI_BRAIN_URL"           envDefault:"http://localhost:8000"`
	AiBrainAPIKey     string `env:"AI_BRAIN_API_KEY"       envDefault:""`
	RiskPollIntervalS int    `env:"RISK_POLL_INTERVAL_SEC" envDefault:"10"`
	AiBrainTimeoutMS  int    `env:"AI_BRAIN_TIMEOUT_MS"    envDefault:"3000"`
	MockDroneURL      string `env:"MOCK_DRONE_URL"         envDefault:"http://localhost:4003"`
	ValhallaURL       string `env:"VALHALLA_URL"           envDefault:"http://localhost:8002"`
	SimTickHz         int    `env:"SIM_TICK_HZ"            envDefault:"20"`
	SimTickMaxLen     int64  `env:"SIM_TICK_STREAM_MAXLEN" envDefault:"20000"`

	ChaosEnabled bool `env:"CHAOS_ENABLED" envDefault:"false"`
}

// Load parses Config from the process environment. Before parsing it
// opportunistically loads a `.env` file from the working directory (or any
// parent up to the repo root) so `go run ./cmd/server` works without the
// caller having to export every variable by hand. Real env vars always win.
func Load() (Config, error) {
	loadDotEnv()
	var cfg Config
	return cfg, env.Parse(&cfg)
}

func loadDotEnv() {
	path, ok := findDotEnv()
	if !ok {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, val)
	}
}

func findDotEnv() (string, bool) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", false
	}
	dir := cwd
	for i := 0; i < 5; i++ {
		candidate := filepath.Join(dir, ".env")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", false
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", false
}
