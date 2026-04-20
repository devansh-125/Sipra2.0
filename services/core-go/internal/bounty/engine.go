// Package bounty implements the surge-pricing engine for consumer-fleet detour incentives.
package bounty

import (
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
)

const (
	urgencyFactorHigh = 1.0
	urgencyFactorLow  = 0.3
	urgencyThreshold  = 30 * time.Minute
)

// CalculateSurge returns the surge-adjusted bounty amount in points.
//
// Formula: base × (1 + urgency_factor) × (1 + corridor_penetration_factor)
//
//   - urgency_factor   = 1.0 if remaining golden-hour < 30 min, else 0.3
//   - penetration      = deviationM / corridorLengthM, clamped to [0, 1]
//
// corridorLengthM is the approximate backbone length of the current exclusion
// corridor (metres). deviationM is the extra detour distance the driver will
// travel to reach the checkpoint (metres).
func CalculateSurge(trip *domain.Trip, corridorLengthM, deviationM float64, baseAmountPoints int) int {
	urgency := urgencyFactorLow
	if trip.RemainingGoldenHour(time.Now()) < urgencyThreshold {
		urgency = urgencyFactorHigh
	}

	penetration := 0.0
	if corridorLengthM > 0 {
		penetration = deviationM / corridorLengthM
		if penetration > 1.0 {
			penetration = 1.0
		}
		if penetration < 0 {
			penetration = 0
		}
	}

	result := float64(baseAmountPoints) * (1 + urgency) * (1 + penetration)
	return int(result)
}
