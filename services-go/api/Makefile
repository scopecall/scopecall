.PHONY: generate generate-check

SPEC := ../../schemas/api/v1.yaml
GEN  := internal/gen/api.gen.go

generate:
	oapi-codegen -config oapi-codegen.yaml $(SPEC)
	sqlc generate

generate-check:
	oapi-codegen -config oapi-codegen.yaml $(SPEC) > /tmp/api.gen.go.new
	diff $(GEN) /tmp/api.gen.go.new
	sqlc diff
