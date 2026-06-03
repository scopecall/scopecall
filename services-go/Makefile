.PHONY: build vet test generate generate-check

# go.work doesn't support ./... from the workspace root in Go 1.26.
# Use per-module targets instead.
build:
	cd common && go build ./...
	cd api    && go build ./...

vet:
	cd common && go vet ./...
	cd api    && go vet ./...

test:
	cd common && go test ./...
	cd api    && go test ./...

generate:
	cd api && make generate

generate-check:
	cd api && make generate-check
