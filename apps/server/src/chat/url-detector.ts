const URL_PATTERN = /https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]+[A-Za-z0-9_/-]/g;

const HINTS = [
  /open the following url/i,
  /visit this url/i,
  /authentication code/i,
  /paste.*code/i,
  /open this url/i,
];

export function detectOAuthPrompt(buffer: string): { url: string } | null {
  if (!HINTS.some((re) => re.test(buffer))) return null;
  const m = buffer.match(URL_PATTERN);
  if (!m || m.length === 0) return null;
  return { url: m[0] };
}
