/**
 * Dashboard health probe — GET /api/health
 *
 * Used by:
 *   - docker-compose healthcheck (compose depends_on health gate)
 *   - Future k8s/Nomad liveness probes
 *
 * Returns 200 JSON when the Next.js runtime is alive.
 * Not a deep probe (no DB ping) — keeps the endpoint cheap enough for
 * frequent polling without adding latency to the critical startup path.
 */

import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
