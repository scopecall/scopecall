# services-dashboard verification targets
# Run `make verify` before every commit to catch what tsc alone misses.

.PHONY: verify typecheck api-check lint build

# Full verification suite — the canonical pre-commit check.
# Runs in dependency order: typecheck → api-check → lint → build.
verify: typecheck api-check lint build
	@echo ""
	@echo "✓ All checks passed"

# TypeScript type checking (fast — no emit)
typecheck:
	npx tsc --noEmit

# Ensure generated API types match the OpenAPI spec.
# Fails if someone updated schemas/api/v1.yaml without regenerating api-types.ts.
api-check:
	bash scripts/check-api-types.sh

# ESLint (catches @supabase/* boundary violations and other lint errors)
lint:
	npx next lint --dir src

# Production build — catches CSS/Tailwind issues tsc misses.
# Placeholder env vars are sufficient; the build validates compilation not runtime.
build:
	NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
	NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder \
	NEXT_PUBLIC_API_URL=http://localhost:3004 \
	npx next build --no-lint

# Regenerate API types from the OpenAPI spec (run after editing schemas/api/v1.yaml)
gen-api-types:
	npx openapi-typescript ../schemas/api/v1.yaml -o src/lib/api-types.ts
	@echo "✓ src/lib/api-types.ts regenerated"
