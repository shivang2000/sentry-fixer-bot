import { env } from "@alertforge/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

// Single shared connection pool process-wide. Reasons:
//  1. `drizzle(urlString)` opens a brand-new `pg.Client` per call. No
//     keepalive, no reconnect, no pool. After a few minutes of idle
//     (e.g. while `jest:coverage` runs in the worker), the underlying
//     TCP connection dies silently — the next query throws
//     `Connection terminated unexpectedly` and the worker's outer
//     try/catch turns the run into agent_error.
//  2. Per-call clients also leak: each createDb() leaves an idle
//     socket behind until the GC collects, eventually hitting
//     postgres `max_connections`.
//
// `keepAlive: true` enables TCP SO_KEEPALIVE so the kernel sends
// liveness probes during long idles. `idleTimeoutMillis: 30s` lets
// the pool recycle stale clients before a query notices the drop.
// `allowExitOnIdle: true` lets the process shut down cleanly without
// having to manually `pool.end()` on graceful exits.
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  allowExitOnIdle: true,
});

export function createDb() {
  return drizzle(pool, { schema });
}

export const db = createDb();
