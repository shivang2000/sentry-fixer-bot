/**
 * Shell-quote a value for inclusion in a sh-readable env file
 * (i.e. lines of the form KEY=value). The value side must survive
 * being parsed by `source` and by systemd EnvironmentFile=.
 */
export function shellQuote(v: string): string {
  if (v === "") return "''";
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate an env key: ALL_CAPS_UNDERSCORE.
 */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}
