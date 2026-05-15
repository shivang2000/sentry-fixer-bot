export function shellQuote(v: string): string {
  if (v === "") return "''";
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export function isValidEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}
