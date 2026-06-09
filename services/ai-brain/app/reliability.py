"""
Reliability primitives: async retry with exponential backoff + jitter,
and a circuit breaker. Both are dependency-free so they can wrap any
coroutine — Routes, Weather, Vertex AI, even DB lookups.

References:
  - AWS Architecture Blog, "Exponential Backoff And Jitter" (2015) —
    full jitter is the variant we use.
  - Nygard, "Release It! 2nd ed." (Pragmatic 2018), Chapter 5 —
    Circuit Breaker pattern.
"""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


# ---------------------------------------------------------------------
# Retry — full-jitter exponential backoff
# ---------------------------------------------------------------------

async def retry_async(
    fn:           Callable[[], Awaitable[T]],
    *,
    attempts:     int = 3,
    base_delay_s: float = 0.2,
    max_delay_s:  float = 5.0,
    retry_on:     tuple[type[BaseException], ...] = (Exception,),
) -> T:
    last_exc: BaseException | None = None
    for i in range(attempts):
        try:
            return await fn()
        except retry_on as exc:
            last_exc = exc
            if i == attempts - 1:
                break
            sleep_s = random.uniform(0, min(max_delay_s, base_delay_s * (2 ** i)))
            await asyncio.sleep(sleep_s)
    assert last_exc is not None
    raise last_exc


# ---------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------

class BreakerState(str, Enum):
    CLOSED    = "closed"
    OPEN      = "open"
    HALF_OPEN = "half_open"


class CircuitOpenError(RuntimeError):
    pass


@dataclass
class CircuitBreaker:
    """
    Trips OPEN after `failure_threshold` consecutive failures, stays open
    for `cooldown_s`, then admits a single trial call (HALF_OPEN). One
    success closes it; one failure re-opens.

    Used to protect cascading slowdowns when an upstream (Routes API,
    Vertex) is degraded — fail fast and fall back to the offline path
    instead of paying timeouts on every request.
    """
    name:               str
    failure_threshold:  int   = 5
    cooldown_s:         float = 30.0

    state:              BreakerState = field(default=BreakerState.CLOSED)
    consecutive_fails:  int          = 0
    opened_at:          float        = 0.0

    async def call(self, fn: Callable[[], Awaitable[T]]) -> T:
        if self.state is BreakerState.OPEN:
            if (time.monotonic() - self.opened_at) >= self.cooldown_s:
                self.state = BreakerState.HALF_OPEN
            else:
                raise CircuitOpenError(f"circuit '{self.name}' open")
        try:
            result = await fn()
        except Exception:
            self._record_failure()
            raise
        self._record_success()
        return result

    def _record_failure(self) -> None:
        self.consecutive_fails += 1
        if self.state is BreakerState.HALF_OPEN or self.consecutive_fails >= self.failure_threshold:
            self.state = BreakerState.OPEN
            self.opened_at = time.monotonic()

    def _record_success(self) -> None:
        self.consecutive_fails = 0
        self.state = BreakerState.CLOSED


# ---------------------------------------------------------------------
# Module-scoped breakers — one per upstream dependency.
# ---------------------------------------------------------------------

ROUTES_BREAKER  = CircuitBreaker("google_routes")
WEATHER_BREAKER = CircuitBreaker("openweathermap")
VERTEX_BREAKER  = CircuitBreaker("vertex_ai", failure_threshold=3, cooldown_s=60.0)
