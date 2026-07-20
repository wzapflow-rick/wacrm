import { NextResponse } from "next/server";

import { query } from "@/lib/db/pool";

// Never cached, always executed on the server. Used by the Docker
// healthcheck (docker-compose.crm.yml) to gate `depends_on` and to let the
// reverse proxy know when the container is ready to serve traffic.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/health — liveness + database readiness probe.
 *
 * Returns 200 when the app is up AND can reach Postgres, 503 otherwise.
 * A cheap `SELECT 1` is enough to confirm the pool can hand out a working
 * connection over the private Docker network.
 */
export async function GET() {
  try {
    await query("SELECT 1");
    return NextResponse.json({ status: "ok", db: "up" });
  } catch (err) {
    return NextResponse.json(
      {
        status: "degraded",
        db: "down",
        error: err instanceof Error ? err.message : "unknown",
      },
      { status: 503 },
    );
  }
}
