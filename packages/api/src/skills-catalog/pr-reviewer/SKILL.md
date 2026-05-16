---
name: pr-reviewer
description: Use after writing a fix but before opening the PR. Run a structured self-review of the diff to catch over-scoped changes, missing tests, and blast-radius risks.
---

# PR Self-Reviewer

After producing a diff that you believe fixes the Sentry alert, but BEFORE running `gh pr create`, run this self-review:

1. **Scope check**. Run `git diff HEAD --stat`. Are all touched files plausibly related to the alert? If something looks unrelated, revert it.
2. **Test check**. Did you add or update at least one test that fails before the change and passes after? If no, add one. If the test framework cannot be inferred, write a `TODO test:` comment in the PR body and continue.
3. **Blast radius**. Are any of the touched files used by more than 10 other files? If yes, downgrade the PR confidence to `medium` and call this out in the Risk section.
4. **Secrets check**. Does the diff add any string that looks like a token, key, or password? If yes, abort and write `SENTRY_TRIAGE.md` instead.
5. **Idempotency**. If the fix runs in a hot path, is it safe to retry? Document any non-idempotent operations in Risk.

Return the result as a YAML block at the end of your work:

```yaml
self_review:
  scope_ok: true|false
  test_added: true|false
  blast_radius: small|medium|large
  secrets_clean: true|false
  notes: |
    <one paragraph>
```
