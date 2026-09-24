---
doc-type: guide
status: active
owner: jason
created: 2026-09-24
---

# TaskCompleted Hook Setup

## Overview

The TaskCompleted hook provides quality gates before allowing an agent to mark a task as complete. It runs three checks:

1. **Test suite** — Blocks completion if tests fail
2. **Uncommitted changes** — Warns if work is not committed
3. **Conformity checks** — Blocks completion if conformity fails (when rungate.json exists)

**Exit codes:**
- `0` — Allow completion (all blockers passed)
- `2` — Block completion (one or more blockers failed)

## Registration

Add the hook to `~/.claude/settings.json` under the `TaskCompleted` event:

```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ${RUNGATE_HOOKS_DIR}/TaskCompleted.hook.ts"
          }
        ]
      }
    ]
  }
}
```

**Environment variable required:**
- `RUNGATE_HOOKS_DIR` — Path to RunGate hooks directory (e.g., `/Users/jhorn/Projects/rungate/hooks`)

## How It Works

### Test Suite Check

Runs `bun test` in the project root and parses output for failures.

- **Blocker:** Test suite has N failing test(s)
- **Warning:** No tests found, or test command issues

### Uncommitted Changes Check

Runs `git status --porcelain` to detect uncommitted files.

- **Warning:** N uncommitted file(s)
- Warnings do not block completion — they're informational

### Conformity Check

Runs `bun test test/scaffold-conformity.test.ts` if `.claude/rungate.json` exists.

- **Blocker:** Conformity check has N failing check(s)
- **Skipped:** If no `rungate.json` exists

## Testing

Run the hook's unit tests:

```bash
bun test test/task-completion-checks.test.ts
```

## Maintenance

The hook follows the thin trigger pattern (HOOK-ARCHITECTURE-SPEC):

- **Hook file:** `hooks/TaskCompleted.hook.ts` (~45 lines)
- **Logic module:** `lib/task-completion-checks.ts` (~170 lines)
- **Tests:** `test/task-completion-checks.test.ts`

To modify check behavior, edit `lib/task-completion-checks.ts`, not the hook file.

## Related

- Issue: #579
- Spec: HOOK-ARCHITECTURE-SPEC.md (SC-370, SC-371, SC-372)
- Research: docs/research/2026-09-24-claude-code-feature-audit.md
