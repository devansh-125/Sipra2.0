"""
Pure domain types. No I/O, no third-party deps beyond pydantic. Imported
freely by all other modules. Mirrors the DDD-pure rule used in
services/core-go/internal/domain.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------
# Geo / time primitives
# ---------------------------------------------------------------------

class LatLng(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


def utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


# ---------------------------------------------------------------------
# Organ / urgency
#
# Cold-ischemia times are clinically established hard ceilings. Sources:
#   - Heart, Lungs:  ISHLT (International Society for Heart and Lung
#     Transplantation) — heart 4 h, lungs 6 h.
#   - Liver:         AASLD practice guidelines (American Association for
#     the Study of Liver Diseases) — 8-12 h.
#   - Pancreas:      OPTN policy 11.7 — typical 12 h.
#   - Kidney:        UNOS / OPTN — up to 24-36 h with cold storage,
#     12 h preferred for outcomes.
#   - Cornea, Bone:  Eye Bank Association of America / AATB — multi-day.
# Numbers below are the *clinically preferred* deadlines we treat as
# hard breach lines, not the absolute survival ceiling.
# ---------------------------------------------------------------------

class OrganType(str, Enum):
    HEART = "Heart"
    LUNG = "Lung"
    LIVER = "Liver"
    PANCREAS = "Pancreas"
    KIDNEY = "Kidney"
    INTESTINE = "Intestine"
    CORNEA = "Cornea"
    BONE = "Bone"
    BLOOD = "Blood"
    VACCINE = "Vaccine"
    OTHER = "Other"


# Cold-ischemia hard ceiling, in seconds, from organ recovery.
ISCHEMIA_CEILING_SECONDS: dict[OrganType, int] = {
    OrganType.HEART:     4  * 3600,
    OrganType.LUNG:      6  * 3600,
    OrganType.LIVER:     10 * 3600,
    OrganType.PANCREAS:  12 * 3600,
    OrganType.KIDNEY:    18 * 3600,
    OrganType.INTESTINE: 8  * 3600,
    OrganType.CORNEA:    7  * 24 * 3600,
    OrganType.BONE:      30 * 24 * 3600,
    OrganType.BLOOD:     6  * 3600,
    OrganType.VACCINE:   24 * 3600,
    OrganType.OTHER:     6  * 3600,
}


class UrgencyTier(str, Enum):
    CRITICAL = "Critical"   # < 25% of ischemia ceiling remaining
    HIGH     = "High"       # 25-50%
    MEDIUM   = "Medium"     # 50-75%
    LOW      = "Low"        # > 75%


def urgency_tier(organ: OrganType, deadline_seconds_remaining: int) -> UrgencyTier:
    ceiling = ISCHEMIA_CEILING_SECONDS.get(organ, ISCHEMIA_CEILING_SECONDS[OrganType.OTHER])
    if ceiling <= 0:
        return UrgencyTier.CRITICAL
    fraction = deadline_seconds_remaining / ceiling
    if fraction < 0.25:
        return UrgencyTier.CRITICAL
    if fraction < 0.50:
        return UrgencyTier.HIGH
    if fraction < 0.75:
        return UrgencyTier.MEDIUM
    return UrgencyTier.LOW


# ---------------------------------------------------------------------
# Explainability — every prediction carries a list of Factors
# ---------------------------------------------------------------------

class Factor(BaseModel):
    """
    One named contribution to a prediction or decision. The set of factors
    must reconstruct the output: predicted_eta = base * π(factor.value)
    for residuals, and the decision is the union of named rule_ids.

    citation: free-form short identifier for the source (paper, manual, table)
              that justifies the factor's value or threshold.
    """
    name:        str
    value:       float
    unit:        str
    description: str
    citation:    str


class Explanation(BaseModel):
    """
    Non-black-box readout. `factors` are machine-readable; `reasoning` is
    a deterministic English rendering of the same factors so a clinician
    can audit without any LLM in the loop.
    """
    backbone:      str
    factors:       list[Factor]
    reasoning:     str
    model_version: str


# ---------------------------------------------------------------------
# Prediction request / response (extends the locked /predict contract)
# ---------------------------------------------------------------------

class PredictRequest(BaseModel):
    trip_id: UUID
    current_position: LatLng
    destination: LatLng
    deadline_seconds_remaining: int = Field(..., ge=0)
    recent_speeds_kph: list[float] = Field(..., min_length=1)
    fleet_density_in_corridor: int = Field(..., ge=0)
    organ_type: Optional[OrganType] = None


Recommendation = Literal["CONTINUE", "REQUEST_BOUNTY_BOOST", "DISPATCH_DRONE"]


class PredictResponse(BaseModel):
    # Locked fields (datasets/realtime/ai-predict.sample.response.json)
    trip_id: UUID
    predicted_eta_seconds: int
    deadline_seconds_remaining: int
    breach_probability: float
    will_breach: bool
    recommendation: Recommendation
    weather_condition: str
    weather_factor: float
    fleet_density_in_corridor: int
    fleet_penalty: float
    effective_speed_kph: float
    ai_confidence: float
    reasoning: str

    # Extensions (additive, optional in the contract)
    prediction_id: Optional[UUID] = None
    model_version: Optional[str] = None
    backbone: Optional[str] = None
    urgency_tier: Optional[UrgencyTier] = None
    factors: list[Factor] = Field(default_factory=list)


# ---------------------------------------------------------------------
# Decision engine
# ---------------------------------------------------------------------

class DecisionAction(str, Enum):
    CONTINUE              = "CONTINUE"
    REQUEST_BOUNTY_BOOST  = "REQUEST_BOUNTY_BOOST"
    REROUTE               = "REROUTE"
    ACTIVATE_CORRIDOR     = "ACTIVATE_CORRIDOR"
    DISPATCH_DRONE        = "DISPATCH_DRONE"
    ABORT                 = "ABORT"


class Decision(BaseModel):
    trip_id:       UUID
    action:        DecisionAction
    confidence:    float
    rule_path:     list[str]
    factors:       list[Factor]
    prediction_id: Optional[UUID] = None
    decided_at:    datetime = Field(default_factory=utcnow)


# ---------------------------------------------------------------------
# Anomalies
# ---------------------------------------------------------------------

class AnomalyKind(str, Enum):
    STALE_PING       = "STALE_PING"
    GPS_JITTER       = "GPS_JITTER"
    ROUTE_DEVIATION  = "ROUTE_DEVIATION"
    SPEED_ANOMALY    = "SPEED_ANOMALY"
    NO_PROGRESS      = "NO_PROGRESS"


class AnomalySeverity(str, Enum):
    INFO     = "Info"
    WARNING  = "Warning"
    CRITICAL = "Critical"


class Anomaly(BaseModel):
    trip_id:     UUID
    kind:        AnomalyKind
    severity:    AnomalySeverity
    detected_at: datetime = Field(default_factory=utcnow)
    evidence:    dict


class GPSPing(BaseModel):
    trip_id:     UUID
    position:    LatLng
    speed_kph:   Optional[float] = None
    heading_deg: Optional[float] = None
    recorded_at: datetime


# ---------------------------------------------------------------------
# Drone flight prediction
#
# Sipra-MK2 nominal cruise (95 kph at 120 m AGL) comes from public spec
# sheets of the Wingcopter 198 / Zipline P2 medical-delivery class. The
# AI brain *derates* that nominal by live weather (visibility, wind,
# precipitation) so the dashboard ETA isn't a fixed string.
# ---------------------------------------------------------------------

class DronePredictRequest(BaseModel):
    trip_id: UUID
    pickup: LatLng
    dropoff: LatLng
    weather_condition: Optional[str] = None
    urgency_tier: Optional[UrgencyTier] = None
    payload_kg: Optional[float] = Field(default=None, ge=0)


class DronePredictResponse(BaseModel):
    trip_id: UUID
    route_km: float
    cruise_kph: float
    altitude_m_cruise: int
    spin_up_seconds: int
    flight_seconds: int
    eta_seconds: int
    weather_condition: str
    weather_factor: float
    payload_factor: float
    reasoning: str
    factors: list[Factor] = Field(default_factory=list)
