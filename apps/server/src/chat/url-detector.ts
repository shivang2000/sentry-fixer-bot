// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC + DCS sequences also start with ESC
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

const HINTS = [
  /open the following url/i,
  /visit this url/i,
  /authentication code/i,
  /paste.*code/i,
  /open this url/i,
  /browser didn'?t open/i,
  /sign in.*claude/i,
  /first copy.*one-time/i,
  /one-time code/i,
];

const URL_CHAR = /[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]/;

/**
 * Pull an `https://...` URL out of a noisy PTY buffer. Two complications:
 *
 *   1. The buffer contains ANSI escape codes (cursor moves, colors).
 *   2. The TTY is 80 columns, so URLs longer than that get hard-wrapped —
 *      CR/LF gets injected mid-URL. The detector reassembles by reading
 *      URL chars and skipping any intervening whitespace (URLs don't
 *      legitimately contain whitespace).
 *
 * Returns null until we see one of the OAuth hint phrases AND find a URL.
 */
export function detectOAuthPrompt(buffer: string): { url: string } | null {
  const clean = buffer.replace(ANSI, "").replace(OSC, "");
  if (!HINTS.some((re) => re.test(clean))) return null;

  const start = clean.indexOf("https://");
  if (start < 0) return null;

  // PTY hard-wrap continuation rule: real wraps emit a single `\r\n` (CR
  // then LF) at the column boundary, with URL characters resuming on the
  // next line. Two cases must end the URL:
  //   1. Plain text afterwards (bare `\n` line break in a sentence).
  //   2. A blank line — i.e. two consecutive `\r\n` sequences. Claude's
  //      setup-token prints the URL, then a blank line, then "Paste code
  //      here if prompted". Without this guard the detector swallows the
  //      prompt text into the URL.
  let url = "";
  let prev = "";
  let pendingNewlines = 0;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i] as string;
    if (URL_CHAR.test(c)) {
      url += c;
      prev = c;
      pendingNewlines = 0;
    } else if (c === "\r") {
      prev = c;
    } else if (c === "\n" && prev === "\r") {
      prev = c;
      pendingNewlines += 1;
      if (pendingNewlines >= 2) break;
    } else {
      break;
    }
  }
  // Drop trailing punctuation a sentence ("Open https://x/y.") would attach.
  url = url.replace(/[.,;:!?]+$/, "");
  return url.length > "https://".length ? { url } : null;
}

const DEVICE_CODE_PATTERNS = [
  // gh: "! First copy your one-time code: XXXX-XXXX"
  /one-time code:\s*([A-Z0-9]{3,5}-[A-Z0-9]{3,5})/i,
  // sentry-cli: "User code: WGQL-WQPC" (also appears in URL query)
  /user[_ ]code[:=]\s*([A-Z0-9]{3,5}-?[A-Z0-9]{3,5})/i,
];

/**
 * gh + sentry-cli print a short device code next to the OAuth URL. The
 * code is what the user has to type into the page at the URL. Render it
 * prominently on the OAuthCard so the operator doesn't have to scroll
 * through the xterm to find it.
 *
 * Returns null if no device-code pattern matches.
 */
export function detectDeviceCode(buffer: string): string | null {
  const clean = buffer.replace(ANSI, "").replace(OSC, "");
  for (const pat of DEVICE_CODE_PATTERNS) {
    const m = clean.match(pat);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}
