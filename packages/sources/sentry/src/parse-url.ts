/**
 * URL patterns Sentry uses for issue links. Order matters — the
 * organization-scoped pattern is the most specific so it appears
 * first, then the org-less canonical, then the custom-subdomain
 * variant that older Sentry tenants emit.
 */
/**
 * Order matters. Custom-subdomain pattern is tested first because the
 * bare `sentry.io/issues/{id}` pattern is a substring of the subdomain
 * form (`acme.sentry.io/issues/{id}`) and would otherwise grab those
 * URLs before the subdomain matcher gets a turn.
 */
export const SENTRY_URL_PATTERNS: RegExp[] = [
  /([a-z0-9-]+)\.sentry\.io\/issues\/(\d+)/i,
  /sentry\.io\/organizations\/[^/]+\/issues\/(\d+)/i,
  /sentry\.io\/issues\/(\d+)/i,
];

/**
 * Parse a Sentry issue URL into { sourceProject, externalId }.
 *
 * Sentry URLs do not always encode the project slug — only the
 * subdomain variant ({org}.sentry.io/issues/{id}/) has it, and even
 * then it is the org slug, not the project. So we return sourceProject
 * as the wildcard "*" when the URL does not encode it; the caller is
 * then expected to resolve the trigger by fetching the issue and
 * matching the issue's project slug against configured triggers.
 *
 * Returns null if the URL does not look like a Sentry issue URL.
 */
export function parseSentryUrl(url: string): { sourceProject: string; externalId: string } | null {
  for (const pattern of SENTRY_URL_PATTERNS) {
    const m = url.match(pattern);
    if (!m) continue;
    // Last capture group is always the numeric issue id; for subdomain
    // pattern, group 1 carries the org slug (not the project) which we
    // still surface as a hint by stuffing it into sourceProject if
    // present. Otherwise "*" means "look up by fetched issue".
    if (pattern.source.includes("([a-z0-9-]+)")) {
      return { sourceProject: m[1] ?? "*", externalId: m[2] ?? "" };
    }
    return { sourceProject: "*", externalId: m[1] ?? "" };
  }
  return null;
}
