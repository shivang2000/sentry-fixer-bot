/**
 * Test-only env preload. Imported as the FIRST statement in
 * `run-pipeline.integration.test.ts` so the env-validation in
 * `@sentry-fixer-bot/env/server` (which is pulled in transitively
 * via @alertforge/step-fix-agent/spawn.ts) sees a valid set of vars
 * even when `bun test` is run from the repo root (where the
 * apps/server/.env file isn't auto-loaded by dotenv).
 *
 * Only the four required-or-validated keys need stubbing — everything
 * else has a default or is optional. Real prod / dev runs ignore this
 * file (it's only inside __tests__/).
 */

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}
if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
}
if (!process.env.BETTER_AUTH_URL) {
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
}
if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = "http://localhost:3001";
}
