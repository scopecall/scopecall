package auth

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// CheckDenylist returns true if the user or JWT is revoked.
// Fails open on Redis errors — signature validation is the primary defense.
func CheckDenylist(ctx context.Context, rdb *redis.Client, userID, jti string) bool {
	if userID != "" {
		if v, err := rdb.Get(ctx, "revoked_user:"+userID).Result(); err == nil && v == "1" {
			return true
		}
	}
	if jti != "" {
		if v, err := rdb.Get(ctx, "revoked_jwt:"+jti).Result(); err == nil && v == "1" {
			return true
		}
	}
	return false
}
