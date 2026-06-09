"""
Sipra — AI Brain

FastAPI application wiring. Slim by design: real logic lives in
predictor / decision_engine / anomaly / reports / learning. This file
only handles app construction, lifespan (DB pool + migrations), and
route mounting.

Architecture follows the production pattern published by Uber and Google:

  Base ETA from a traffic-aware routing engine
  + thin residual correction layered on top
  = predicted ETA

Backbone: Google Routes API v2 `computeRoutes` with TRAFFIC_AWARE_OPTIMAL,
whose duration is produced by Google's Graph Neural Network ETA model
(Derrow-Pinion et al., CIKM 2021, arxiv.org/abs/2108.11482).

Residual correction follows Uber DeepETA (Uber Engineering, 2022). DeepETA
is a transformer that learns the residual between the routing engine's
base ETA and the realised time. We approximate that with an explicit set
of citation-backed correction factors:

  - ambulance_priority_factor      Pons & Markovchick, J Emerg Med 2002
  - weather_factor                 FHWA road-impact empirical table
  - speed_deviation_residual       observed-vs-expected ambulance flow
  - fleet_penalty                  Highway Capacity Manual density curve
  - urgency_tier                   ISHLT/AASLD/UNOS cold-ischemia ceilings
"""
from __future__ import annotations

from contextlib import asynccontextmanager

# Best-effort .env loading for local dev (uvicorn run directly).
try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
    load_dotenv()
except ImportError:
    pass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import SETTINGS
from .db import close_pool, init_pool
from .routes import anomaly as anomaly_routes
from .routes import decide as decide_routes
from .routes import health as health_routes
from .routes import model as model_routes
from .routes import predict as predict_routes
from .routes import predict_drone as predict_drone_routes
from .routes import reports as reports_routes
from .security import SignatureError, verify_api_key


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        await init_pool()
    except Exception:
        # Boot resilience: if Postgres is unreachable, the brain still serves
        # /predict (math is pure). Persistence + reports + learning will be
        # disabled until /readyz reports green.
        pass
    yield
    try:
        await close_pool()
    except Exception:
        pass


app = FastAPI(title="Sipra AI Brain", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _auth(request: Request, call_next):
    # OPTIONS preflight and health checks are always open.
    if request.method == "OPTIONS" or request.url.path in {"/healthz", "/readyz"}:
        return await call_next(request)
    if SETTINGS.auth_required:
        try:
            verify_api_key(request.headers.get("Authorization", ""))
        except SignatureError:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)

app.include_router(health_routes.router)
app.include_router(predict_routes.router)
app.include_router(predict_drone_routes.router)
app.include_router(decide_routes.router)
app.include_router(anomaly_routes.router)
app.include_router(reports_routes.router)
app.include_router(model_routes.router)


# ---------------------------------------------------------------------
# Backwards-compatible shims for the existing tests.
#
# tests/test_predict.py imports these names from app.main and asserts on
# the locked /predict contract. Re-export them so the contract test does
# not have to be aware of the module split.
# ---------------------------------------------------------------------
from .predictor import (  # noqa: E402
    BOOTSTRAP_PARAMS,
    breach_probability as _breach_probability_impl,
    fleet_penalty_for_density as _fleet_penalty_impl,
    haversine_meters,
    recommend as _recommend_impl,
)


def breach_probability(buffer_seconds: int) -> float:
    return _breach_probability_impl(buffer_seconds, BOOTSTRAP_PARAMS)


def fleet_penalty_for_density(density: int) -> float:
    return _fleet_penalty_impl(density, BOOTSTRAP_PARAMS)


def recommend(prob: float) -> str:
    return _recommend_impl(prob, BOOTSTRAP_PARAMS)


__all__ = [
    "app",
    "breach_probability",
    "fleet_penalty_for_density",
    "haversine_meters",
    "recommend",
]
