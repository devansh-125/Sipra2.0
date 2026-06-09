"""
Security primitives: HMAC verification (constant-time) and JWT validation.

For healthcare data the brain treats every inbound request as untrusted.
Two complementary mechanisms:

  - HMAC-SHA256 with a per-partner secret + replay-protection timestamp
    is used for service-to-service webhooks (drone provider, EMS feeds).
    Pattern matches Stripe's: signature header includes a timestamp and
    a v1 hash; the verifier rejects messages older than 5 minutes.

  - RS256 JWT issued by the org's IdP is used for ambulance devices and
    dashboard users. Public-key verification means the brain has no
    shared secret to leak.

The brain stores no PHI. Trip IDs are opaque UUIDs. Patient/donor names
never enter this service. PII deflection is enforced at the contract
boundary (PredictRequest has no PHI fields).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Optional

from .config import SETTINGS


# ---------------------------------------------------------------------
# HMAC
# ---------------------------------------------------------------------

HMAC_TOLERANCE_SECONDS = 300  # 5 min replay window


class SignatureError(ValueError):
    """Raised when HMAC signature verification fails."""


def sign(secret: str, timestamp: int, body: bytes) -> str:
    msg = f"{timestamp}.".encode("ascii") + body
    digest = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def verify_api_key(header: str) -> None:
    """
    Verifies a Bearer API key from an Authorization header.
    Raises SignatureError on any failure. Constant-time comparison prevents
    timing attacks. Call only when SETTINGS.auth_required is True.
    """
    key = SETTINGS.api_key
    if not key:
        raise SignatureError("api key not configured")
    if not header.startswith("Bearer "):
        raise SignatureError("missing or invalid authorization header")
    if not hmac.compare_digest(header[7:], key):
        raise SignatureError("invalid api key")


def verify_signature(header: str, body: bytes, *, secret: Optional[str] = None,
                     now_s: Optional[int] = None) -> None:
    """
    Stripe-style signature verification. Header format:
       t=<unix>,v1=<hex sha256>
    Raises SignatureError on any mismatch — including a missing secret.
    """
    secret = secret if secret is not None else SETTINGS.webhook_hmac_secret
    if not secret:
        raise SignatureError("hmac secret not configured")
    if not header:
        raise SignatureError("missing signature header")

    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    if "t" not in parts or "v1" not in parts:
        raise SignatureError("malformed signature header")

    try:
        ts = int(parts["t"])
    except ValueError as exc:
        raise SignatureError("invalid timestamp") from exc

    now = now_s if now_s is not None else int(time.time())
    if abs(now - ts) > HMAC_TOLERANCE_SECONDS:
        raise SignatureError("signature timestamp outside tolerance")

    expected = sign(secret, ts, body).split("v1=")[1]
    if not hmac.compare_digest(expected, parts["v1"]):
        raise SignatureError("signature mismatch")


# ---------------------------------------------------------------------
# JWT (RS256). Minimal, dependency-free for the verify path.
# We only need: parse header/claims, verify signature with a public key,
# enforce exp/aud. We never *issue* tokens here.
#
# Falls back gracefully when AI_AUTH_REQUIRED=false (dev) or when no key
# is configured: the dependency returns AnonClaims so handlers still work.
# ---------------------------------------------------------------------

@dataclass(frozen=True)
class Claims:
    sub:  str
    aud:  str
    exp:  int
    iat:  int
    role: str
    raw:  dict


@dataclass(frozen=True)
class AnonClaims:
    sub:  str = "anonymous"
    aud:  str = ""
    role: str = "anonymous"


def _b64url_decode(s: str) -> bytes:
    pad = 4 - (len(s) % 4)
    if pad < 4:
        s += "=" * pad
    return base64.urlsafe_b64decode(s)


def verify_jwt(token: str) -> Claims:
    """
    RS256 JWT verification. Imports cryptography lazily so dev without the
    library installed still boots. Raises SignatureError on any failure.
    """
    if not SETTINGS.jwt_public_key_pem:
        raise SignatureError("jwt public key not configured")

    try:
        h_b64, p_b64, s_b64 = token.split(".")
    except ValueError as exc:
        raise SignatureError("malformed jwt") from exc

    try:
        header  = json.loads(_b64url_decode(h_b64))
        payload = json.loads(_b64url_decode(p_b64))
        sig     = _b64url_decode(s_b64)
    except Exception as exc:
        raise SignatureError("jwt decode failed") from exc

    if header.get("alg") != "RS256":
        raise SignatureError(f"unsupported alg {header.get('alg')!r}")

    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError as exc:
        raise SignatureError("cryptography library not installed") from exc

    pub = serialization.load_pem_public_key(SETTINGS.jwt_public_key_pem.encode("utf-8"))
    signed_input = f"{h_b64}.{p_b64}".encode("ascii")
    try:
        pub.verify(sig, signed_input, padding.PKCS1v15(), hashes.SHA256())  # type: ignore[attr-defined]
    except Exception as exc:
        raise SignatureError("jwt signature invalid") from exc

    now = int(time.time())
    if int(payload.get("exp", 0)) < now:
        raise SignatureError("jwt expired")
    aud = payload.get("aud", "")
    if SETTINGS.jwt_audience and aud != SETTINGS.jwt_audience:
        raise SignatureError("jwt audience mismatch")

    return Claims(
        sub=str(payload.get("sub", "")),
        aud=str(aud),
        exp=int(payload.get("exp", 0)),
        iat=int(payload.get("iat", 0)),
        role=str(payload.get("role", "")),
        raw=payload,
    )
