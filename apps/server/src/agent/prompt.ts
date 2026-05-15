export type PromptInput = {
  title: string;
  stackTrace: string;
  suspectedFiles: string[];
  testCommand: string;
};

export function renderAgentPrompt(input: PromptInput): string {
  const filesHint =
    input.suspectedFiles.length > 0
      ? `Suspected files: ${input.suspectedFiles.join(", ")}.`
      : "No suspected files; locate from the stack trace.";

  return `You are a software engineer triaging a production exception.

Your job:
1. Read the stack trace and identify the root cause.
2. Make the minimal code change that fixes the issue.
3. Add a test that fails before the fix and passes after.
4. Run \`${input.testCommand}\` and ensure it passes.
5. When done, write a short summary in <summary>...</summary> tags including:
   - "confidence": low | medium | high
   - "risk": low | medium | high
   - what you changed and why.

Constraints:
- Touch only files relevant to this fix.
- Do not change package.json dependencies.
- Do not commit secrets.
- Keep the diff small.

ALERT TITLE: ${input.title}

STACK TRACE:
${input.stackTrace}

${filesHint}`;
}
