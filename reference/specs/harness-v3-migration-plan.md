---
doc-type: spec
status: proposed
owner: jason
updated: 2026-09-08
testable: true
---

# Harness v3 Migration Plan

## Viability Test (do this FIRST — 30 minutes)

Before migrating anything, prove the approach works with one seeded test.

### Step 0: Scaffold

```bash
mkdir -p ~/.claude/gates
cd ~/.claude
bun init -y  # if no package.json
bun add -d zod
```

### Step 1: Write ONE gate check as a Bun test

```typescript
// gates/viability.test.ts
import { test, expect } from "bun:test";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";

const WorkflowState = z.object({
  schemaVersion: z.literal(2),
  issue: z.number(),
  phase: z.string(),
  acs: z.array(z.object({
    id: z.string(),
    threshold: z.object({ op: z.string(), value: z.string() }).optional(),
  })),
});

const TEST_DIR = process.env.TEST_WORK_DIR || "/tmp/gate-viability-test";

test("workflow-state.json validates against schema", () => {
  const wf = JSON.parse(readFileSync(`${TEST_DIR}/workflow-state.json`, "utf-8"));
  expect(() => WorkflowState.parse(wf)).not.toThrow();
});

test("all ACs have thresholds", () => {
  const wf = JSON.parse(readFileSync(`${TEST_DIR}/workflow-state.json`, "utf-8"));
  const missing = wf.acs.filter((ac: any) => !ac.threshold);
  expect(missing.length).toBe(0);
});

test("no hardcoded thresholds in changed files", () => {
  // Simulates spec compliance check
  const changedFiles = (process.env.CHANGED_FILES || "").split(",").filter(Boolean);
  for (const f of changedFiles) {
    if (!existsSync(f)) continue;
    const content = readFileSync(f, "utf-8");
    const hardcoded = content.match(/=[0-9]+$/gm) || [];
    expect(hardcoded.length).toBe(0);
  }
});
```

### Step 2: Create seeded test data

```bash
mkdir -p /tmp/gate-viability-test
cat > /tmp/gate-viability-test/workflow-state.json << 'EOF'
{
  "schemaVersion": 2,
  "issue": 999,
  "phase": "VERIFY",
  "acs": [
    {"id": "SC-1", "threshold": {"op": ">=", "value": "1"}},
    {"id": "SC-2", "threshold": {"op": "==", "value": "0"}}
  ]
}
EOF
```

### Step 3: Run it

```bash
TEST_WORK_DIR=/tmp/gate-viability-test bun test gates/viability.test.ts
```

**Expected:** 3 tests pass. If they do, the approach is viable. If not, we learn why before investing more.

### Step 4: Run with FAILING seed data

```bash
# Seed with missing threshold
cat > /tmp/gate-viability-test/workflow-state.json << 'EOF'
{
  "schemaVersion": 2,
  "issue": 999,
  "phase": "VERIFY",
  "acs": [
    {"id": "SC-1"},
    {"id": "SC-2", "threshold": {"op": "==", "value": "0"}}
  ]
}
EOF

TEST_WORK_DIR=/tmp/gate-viability-test bun test gates/viability.test.ts
```

**Expected:** "all ACs have thresholds" FAILS. This proves the gate catches violations.

---

## Full Migration (after viability confirmed)

### Phase 1: Port checks (2 hours)

Port the 10 most important gate-checks.sh functions to gates/workflow.test.ts:
1. acs-exist
2. acs-have-threshold
3. all-acs-pass
4. evidence-type-ratio
5. code-committed
6. branch-merged
7. code-pushed
8. decision-id-valid
9. spec-drift
10. tests-pass

Run bash gate AND bun test in parallel for one session. Compare results. Fix discrepancies.

### Phase 2: Hook wiring (30 minutes)

Add to `.claude/settings.json`:
```json
{
  "hooks": {
    "SubagentStop": [{
      "command": "bun test --bail gates/workflow.test.ts",
      "description": "Gate checks after agent completion"
    }]
  }
}
```

### Phase 3: Chain as Workflow (1 hour)

One workflow script replaces skill-runner.sh chain logic:
```javascript
export const meta = {
  name: 'harness-chain',
  description: 'goal → ship → prove → close',
  phases: [{ title: 'Goal' }, { title: 'Ship' }, { title: 'Prove' }]
}

phase('Goal')
const goal = await agent('Run /goal for issue ' + args.issue)

phase('Ship')  
const ship = await agent('Run /ship for issue ' + args.issue)

phase('Prove')
const prove = await agent('Run /prove for issue ' + args.issue)
```

### Phase 4: Delete bash (30 minutes)

After one full session with both running:
- Delete skill-runner.sh (keep git history)
- Delete gate-runner.sh
- Delete gate-checks.sh
- Replace pre-push with lefthook.yml

---

## DDB Onboarding (after migration)

```bash
cd ~/Projects/DailyBriefDashboard
mkdir -p gates
cp ~/.claude/gates/workflow.test.ts gates/  # copy, then customize schema
# Edit schema to match DDB's workflow-state shape
# Add project-specific checks
bun test gates/  # verify
```

Done. No 10 bash scripts. No ceremony-profiles.json. No skill-registry.json.
