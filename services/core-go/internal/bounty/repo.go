package bounty

import (
	"context"
	"fmt"
	"time"

	"github.com/devansh-125/sipra/services/core-go/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repo persists and retrieves Bounty aggregates.
type Repo struct{ pool *pgxpool.Pool }

// NewRepo creates a Repo backed by the given connection pool.
func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

const sqlInsertBounty = `
INSERT INTO bounties (
    id, trip_id, driver_ref, partner_id,
    amount_points, checkpoint, checkpoint_radius_m,
    status, offered_at, expires_at
) VALUES (
    $1, $2, $3, $4,
    $5, ST_SetSRID(ST_MakePoint($6, $7), 4326), $8,
    'Offered'::bounty_status, $9, $10
)`

// Create stamps b with a new UUID, sets OfferedAt = now, and persists it.
func (r *Repo) Create(ctx context.Context, b *domain.Bounty) error {
	now := time.Now().UTC()
	b.ID = domain.BountyID(uuid.New().String())
	b.Status = domain.BountyStatusOffered
	b.OfferedAt = now

	_, err := r.pool.Exec(ctx, sqlInsertBounty,
		string(b.ID),
		string(b.TripID),
		b.DriverRef,
		b.PartnerID,
		b.AmountPoints,
		b.Checkpoint.Lng, b.Checkpoint.Lat, // ST_MakePoint(X=lng, Y=lat)
		b.CheckpointRadius,
		now,
		b.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("insert bounty: %w", err)
	}
	return nil
}

const sqlClaimBounty = `
UPDATE bounties
SET    status = 'Claimed'::bounty_status, claimed_at = $2
WHERE  id = $1
  AND  status = 'Offered'::bounty_status
  AND  expires_at > NOW()`

// Claim transitions an Offered, non-expired bounty to Claimed.
// Returns an error if the bounty does not exist, is expired, or is already claimed/verified.
func (r *Repo) Claim(ctx context.Context, id domain.BountyID) error {
	now := time.Now().UTC()
	tag, err := r.pool.Exec(ctx, sqlClaimBounty, string(id), now)
	if err != nil {
		return fmt.Errorf("claim bounty %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("bounty %s: not found, already claimed, or expired", id)
	}
	return nil
}

const sqlVerifyBountyPositional = `
UPDATE bounties
SET    status = 'Verified'::bounty_status, verified_at = $4
WHERE  id = $1
  AND  status = 'Claimed'::bounty_status
  AND  ST_DWithin(
           checkpoint::geography,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           checkpoint_radius_m
       )`

// Verify confirms the driver physically reached the checkpoint by checking that
// the supplied ping location lies within checkpoint_radius_m of the stored
// checkpoint using PostGIS ST_DWithin on geography (great-circle metres).
// Transitions the bounty from Claimed → Verified.
func (r *Repo) Verify(ctx context.Context, id domain.BountyID, pingLat, pingLng float64) error {
	now := time.Now().UTC()
	tag, err := r.pool.Exec(ctx, sqlVerifyBountyPositional,
		string(id),
		pingLng, pingLat, // ST_MakePoint(X=lng, Y=lat)
		now,
	)
	if err != nil {
		return fmt.Errorf("verify bounty %s: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("bounty %s: not found, not claimed, or checkpoint not reached", id)
	}
	return nil
}

const sqlGetBounty = `
SELECT
    id, trip_id, driver_ref, partner_id,
    amount_points,
    ST_Y(checkpoint) AS cp_lat,
    ST_X(checkpoint) AS cp_lng,
    checkpoint_radius_m,
    status, offered_at, claimed_at, verified_at, expires_at
FROM bounties WHERE id = $1`

// GetByID retrieves a single bounty for read-back after creation.
func (r *Repo) GetByID(ctx context.Context, id domain.BountyID) (*domain.Bounty, error) {
	var (
		b         domain.Bounty
		idStr     string
		tripIDStr string
		statusStr string
	)
	err := r.pool.QueryRow(ctx, sqlGetBounty, string(id)).Scan(
		&idStr, &tripIDStr, &b.DriverRef, &b.PartnerID,
		&b.AmountPoints,
		&b.Checkpoint.Lat, &b.Checkpoint.Lng,
		&b.CheckpointRadius,
		&statusStr, &b.OfferedAt, &b.ClaimedAt, &b.VerifiedAt, &b.ExpiresAt,
	)
	if err == pgx.ErrNoRows {
		return nil, fmt.Errorf("bounty %s: not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get bounty %s: %w", id, err)
	}
	b.ID = domain.BountyID(idStr)
	b.TripID = domain.TripID(tripIDStr)
	b.Status = domain.BountyStatus(statusStr)
	return &b, nil
}
