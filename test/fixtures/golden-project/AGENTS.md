---
doc-type: reference
status: active
owner: jason
updated: 2026-10-17
---

# golden-project

## Project Identity

A fixture consumer.

## Hard Constraints (non-inferrable — agents cannot discover these from code)
<!-- BEGIN AUTO-EXTRACTED -->
- **golden: destructive cases run on the test port only** — never the live one
<!-- END AUTO-EXTRACTED -->
- **golden: deploy is one rebuild at the end, then verify the health route**

## Workflow

- **Test:** `bun test`
