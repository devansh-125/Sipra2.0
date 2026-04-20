package webhooks

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestDispatch_RetriesOnServerErrorAndVerifiesHMAC spins up a local HTTP server
// that rejects the first two attempts with 503, then accepts the third. It
// checks that (a) exactly 3 requests are made, and (b) every request carries a
// valid HMAC-SHA256 signature.
func TestDispatch_RetriesOnServerErrorAndVerifiesHMAC(t *testing.T) {
	const secret = "test-secret"
	body := []byte(`{"trip_id":"trip-abc","version":1}`)
	wantSig := sign(secret, body)

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)

		got := r.Header.Get("X-Sipra-Signature")
		if got != wantSig {
			t.Errorf("attempt %d: signature mismatch\n  got:  %q\n  want: %q", n, got, wantSig)
		}

		if n < int32(maxAttempts) {
			w.WriteHeader(http.StatusServiceUnavailable) // 503 → triggers retry
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := &Dispatcher{
		client:  &http.Client{Timeout: 2 * time.Second},
		stopped: make(chan struct{}),
	}

	// Override delays so the test completes in milliseconds.
	orig := retryDelays
	retryDelays = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	defer func() { retryDelays = orig }()

	d.dispatch(job{
		partner: partner{Name: "mock-partner", URL: srv.URL, Secret: secret},
		body:    body,
		tripID:  "trip-abc",
	})

	if got := calls.Load(); got != int32(maxAttempts) {
		t.Errorf("expected %d HTTP calls, got %d", maxAttempts, got)
	}
}
