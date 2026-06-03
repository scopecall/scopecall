package clickhouse

import (
	"crypto/tls"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type Config struct {
	Host     string
	Port     int
	Database string
	Username string
	Password string
	TLS      bool
}

func New(cfg Config) (driver.Conn, error) {
	opts := &clickhouse.Options{
		Addr: []string{fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)},
		Auth: clickhouse.Auth{
			Database: cfg.Database,
			Username: cfg.Username,
			Password: cfg.Password,
		},
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
		Settings: clickhouse.Settings{
			"max_execution_time": 30,
		},
		DialTimeout:     5 * time.Second,
		MaxOpenConns:    10,
		MaxIdleConns:    5,
		ConnMaxLifetime: time.Hour,
	}
	if cfg.TLS {
		opts.TLS = &tls.Config{}
	}
	return clickhouse.Open(opts)
}
