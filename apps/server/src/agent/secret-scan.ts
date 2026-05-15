/**
 * Pre-PR secret scan. Returns a list of findings (empty = clean).
 * Patterns are coarse and aim to catch the *most-stolen* token shapes:
 * AWS keys, GitHub tokens, OpenAI keys, Anthropic keys, generic JWTs.
 */
export type SecretFinding = { file: string; line: number; pattern: string };

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github_pat_fine", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9-_]{20,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
];

export function scanText(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i] ?? "")) findings.push({ file, line: i + 1, pattern: name });
    }
  }
  return findings;
}
