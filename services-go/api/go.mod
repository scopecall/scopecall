module github.com/scopecall/services-go/api

go 1.26.3

require (
	github.com/ClickHouse/clickhouse-go/v2 v2.30.0
	github.com/go-chi/chi/v5 v5.2.1
	github.com/go-chi/httprate v0.14.0
	github.com/jackc/pgx/v5 v5.7.4
	github.com/oapi-codegen/runtime v1.4.1
	github.com/redis/go-redis/v9 v9.7.3
	github.com/scopecall/services-go/common v0.0.0
	go.uber.org/zap v1.27.0
)

require github.com/lib/pq v1.12.3

require (
	github.com/ClickHouse/ch-go v0.61.5 // indirect
	github.com/andybalholm/brotli v1.1.1 // indirect
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/go-faster/city v1.0.1 // indirect
	github.com/go-faster/errors v0.7.1 // indirect

	// JWT is needed transitively via common; pin it here for go mod tidy
	github.com/golang-jwt/jwt/v5 v5.2.2 // indirect
	github.com/google/uuid v1.6.0
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.7 // indirect
	github.com/paulmach/orb v0.11.1 // indirect
	github.com/pierrec/lz4/v4 v4.1.21 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/segmentio/asm v1.2.0 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	go.opentelemetry.io/otel v1.26.0 // indirect
	go.opentelemetry.io/otel/trace v1.26.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/crypto v0.46.0 // indirect
	golang.org/x/sync v0.19.0
	golang.org/x/sys v0.39.0 // indirect
	golang.org/x/text v0.32.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/scopecall/services-go/common => ../common
