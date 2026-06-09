"""Security + reliability primitives — pure unit tests."""
import asyncio
import time

import pytest

from app.reliability import CircuitBreaker, CircuitOpenError, retry_async
from app.security import SignatureError, sign, verify_signature


# ---------- HMAC ----------

def test_hmac_roundtrip():
    secret = "shh"
    body   = b'{"hello":"world"}'
    ts     = int(time.time())
    header = sign(secret, ts, body)
    verify_signature(header, body, secret=secret, now_s=ts)  # no raise


def test_hmac_replay_window_enforced():
    secret = "shh"
    body   = b"x"
    ts     = int(time.time())
    header = sign(secret, ts, body)
    with pytest.raises(SignatureError):
        verify_signature(header, body, secret=secret, now_s=ts + 600)  # 10 min later


def test_hmac_tampered_body_rejected():
    secret = "shh"
    ts     = int(time.time())
    header = sign(secret, ts, b"original")
    with pytest.raises(SignatureError):
        verify_signature(header, b"tampered", secret=secret, now_s=ts)


def test_hmac_missing_secret_rejected():
    with pytest.raises(SignatureError):
        verify_signature("t=1,v1=abcdef", b"x", secret="", now_s=1)


# ---------- Retry ----------

@pytest.mark.asyncio
async def test_retry_eventually_succeeds():
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient")
        return "ok"

    out = await retry_async(flaky, attempts=5, base_delay_s=0.001, max_delay_s=0.01)
    assert out == "ok"
    assert calls["n"] == 3


@pytest.mark.asyncio
async def test_retry_propagates_after_max():
    async def always_fail():
        raise ValueError("nope")

    with pytest.raises(ValueError):
        await retry_async(always_fail, attempts=3, base_delay_s=0.001, max_delay_s=0.01)


# ---------- Circuit breaker ----------

@pytest.mark.asyncio
async def test_circuit_opens_after_threshold():
    cb = CircuitBreaker("t", failure_threshold=2, cooldown_s=0.05)

    async def fail():
        raise RuntimeError("x")

    for _ in range(2):
        with pytest.raises(RuntimeError):
            await cb.call(fail)

    with pytest.raises(CircuitOpenError):
        await cb.call(fail)


@pytest.mark.asyncio
async def test_circuit_recovers_after_cooldown():
    cb = CircuitBreaker("t", failure_threshold=1, cooldown_s=0.05)

    async def fail():
        raise RuntimeError("x")

    async def succeed():
        return "ok"

    with pytest.raises(RuntimeError):
        await cb.call(fail)

    with pytest.raises(CircuitOpenError):
        await cb.call(fail)

    await asyncio.sleep(0.06)
    out = await cb.call(succeed)
    assert out == "ok"
