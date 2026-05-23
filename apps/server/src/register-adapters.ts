import emailAdapter from "@alertforge/channel-email";
import slackAdapter from "@alertforge/channel-slack";
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
 *
 * P6: channel adapters added here so the channels.listAdapters tRPC
 * procedure can return them to the UI. Worker fan-out already reads
 * from this same registry via deps.channels, so this consolidates the
 * single source of truth.
 */
registry.registerSource(sentryAdapter);
registry.registerChannel(slackAdapter);
registry.registerChannel(emailAdapter);
