import { registry } from "@alertforge/core";
import sentryAdapter from "@alertforge/source-sentry";

/**
 * Side-effect module: imported once at server boot from
 * apps/server/src/index.ts to register every source + channel
 * adapter shipped with this binary. New adapters land here as a
 * one-line import + registry.registerSource/registerChannel call.
 *
 * Explicit registration (vs. Bun.glob auto-discovery) keeps the
 * dependency graph visible to the type checker and avoids
 * import-side-effect surprises during testing.
 */
registry.registerSource(sentryAdapter);
