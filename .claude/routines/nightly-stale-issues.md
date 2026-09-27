# Nightly Stale Issue Detection

## Trigger

- **Type:** schedule
- **Cron:** `0 2 * * *`
- **Timezone:** America/Chicago
- **Frequency:** daily (nightly at 2:00 AM CT)

This routine runs on a nightly cron schedule to detect and close stale GitHub
issues whose associated work is already complete.

## Prompt

Run the stale issue scanner to find and close issues that reference completed
project phases:

1. Check out the repository at the latest main.
2. Run `bun install` to ensure dependencies are current.
3. Run `bun scripts/scan-stale-issues.ts` to detect stale issues.
4. Review the scan results:
   - For each stale issue found, verify the associated phase SCs are all done
     in project-state.json before closing.
   - Close confirmed stale issues with an auto-generated comment explaining
     why the issue was closed (all SCs in the referenced phase are complete).
5. Log a summary: number of issues scanned, stale issues found, issues closed.

## Repos

- hornjason/pai-harness

## Why

Stale issues accumulate when phases complete but their tracking issues remain
open. Manual cleanup is unreliable. A nightly scan-stale-issues routine
automates this hygiene, keeping the issue tracker accurate without human
intervention.
