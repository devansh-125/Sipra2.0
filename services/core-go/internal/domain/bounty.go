package domain

import "time"

// BountyID uniquely identifies a consumer-driver detour incentive.
type BountyID string

// BountyStatus tracks the lifecycle of a single detour incentive.
type BountyStatus string

const (
	BountyStatusOffered  BountyStatus = "Offered"
	BountyStatusClaimed  BountyStatus = "Claimed"
	BountyStatusVerified BountyStatus = "Verified"
	BountyStatusExpired  BountyStatus = "Expired"
)

// Bounty is a detour incentive offered to a consumer-fleet driver who reroutes
// to reach a geographic checkpoint on behalf of a bio-logistics mission.
type Bounty struct {
	ID      BountyID `json:"id"`
	TripID  TripID   `json:"trip_id"`

	DriverRef string  `json:"driver_ref"`
	PartnerID *string `json:"partner_id,omitempty"`

	AmountPoints     int   `json:"amount_points"`
	Checkpoint       Point `json:"checkpoint"`
	CheckpointRadius int   `json:"checkpoint_radius_m"`

	Status BountyStatus `json:"status"`

	OfferedAt  time.Time  `json:"offered_at"`
	ClaimedAt  *time.Time `json:"claimed_at,omitempty"`
	VerifiedAt *time.Time `json:"verified_at,omitempty"`
	ExpiresAt  time.Time  `json:"expires_at"`
}
