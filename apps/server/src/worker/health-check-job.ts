import { computeSetupStatus, writeHealthSnapshot } from "@alertforge/api/routers/setup";
import { log } from "../log";

/**
 * Run the same probes the wizard / doctor use, persist the result into
 * the `health_snapshots` singleton row. Dashboard reads the snapshot for
 * an instant view + a "last checked N minutes ago" badge.
 */
export async function processHealthCheckJob(): Promise<void> {
  try {
    const status = await computeSetupStatus();
    await writeHealthSnapshot(status);
    log.info({ ready: status.ready }, "[health-check] tick");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[health-check] failed");
  }
}
