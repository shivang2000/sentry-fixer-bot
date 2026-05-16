---
name: sentry-triage
description: Use when triaging a Sentry alert. Extract likely cause from the top stack frame, summarise breadcrumb signal (auth, db, network), and propose 2-3 specific files to inspect before fixing.
---

# Sentry Triage Enhancer

When the bot is triaging a Sentry alert, this skill helps you go beyond severity classification:

1. Read the top frame of the stack trace. Note the file path and function name.
2. Walk the breadcrumbs (last 20). Group them into categories: `auth`, `db`, `http`, `cache`, `cron`, `user-action`.
3. Look for a state transition just before the exception — that is usually the proximate cause.
4. Propose 2-3 specific files to inspect first. Be conservative: if the trace is ambiguous, say so.

Return your output as:

```
Likely cause: <one sentence>
Confidence: <high|medium|low>
First files to read:
  - <path>:<line>
  - <path>:<line>
Open questions:
  - <one bullet>
```
