package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

func New(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         addr,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	})
}

func Ping(ctx context.Context, rdb *redis.Client) error {
	return rdb.Ping(ctx).Err()
}
