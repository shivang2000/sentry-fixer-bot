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
  /^\s*url:\s*https?:/im, // sentry-cli: "URL:  https://sentry.io/oauth/device/?…"
  /user_code=/i, // device-code URL anywhere
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

  // Terminate at first newline (CR or LF). We rely on the spawner
  // setting wide PTY cols (200+) so URLs never hard-wrap. Trying to
  // reassemble across `\r\n` boundaries reliably is impossible: the
  // next line might start with another URL_CHAR ("Paste code here…"
  // starts with P, which is a valid URL char), so we'd glue prose
  // onto the URL. Better to require the source command to print the
  // URL on one line and break here cleanly.
  let url = "";
  for (let i = start; i < clean.length; i++) {
    const c = clean[i] as string;
    if (c === "\r" || c === "\n") break;
    if (URL_CHAR.test(c)) {
      url += c;
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
  // sentry CLI (cli.sentry.dev): "  Code:  CFWD-TBXH"
  /^\s*code:\s*([A-Z0-9]{3,5}-?[A-Z0-9]{3,5})\s*$/im,
  // sentry-cli legacy + URL query: "user_code=WGQL-WQPC" / "User code: WGQL"
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
