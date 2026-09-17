---
doc-type: reference
status: active
owner: jason
updated: 2026-09-03
---

# Stall Escalation Ladder

## When stall detection fires

Gate-runner.sh detects a stall when the same verify failures appear in consecutive iterations (same FAIL_HASH).

## Escalation steps

### Level 1: Council (advisory)
- DA reads "STALL DETECTED" message from gate-runner
- DA decides whether to run `/council` on the failures
- Council topic: "Verify gate has the same failures after N iterations: {failures}. What's wrong?"
- Council may recommend: different approach, missing context, wrong AC, architectural issue

### Level 2: Ship council findings
- Council recommendations that are MECHANICAL → file issues → ship them
- Re-run verify gate after shipping fixes
- If failures change → progress, continue normal iteration

### Level 3: Escalate (same failure after council)
- Council ran, findings shipped, STILL same failure
- This is a different class of problem — not "need more perspectives" but "something fundamental is wrong"
- Action: post full diagnostic to issue and STOP
  - All iterations with failure details
  - Council synthesis
  - What was tried and failed
  - Exact error output
- Let Jason investigate manually

### Level 4: Never reached
- Council does NOT auto-loop. One shot per stall, then escalate.
- Prevents: 200-400K token council debates on unsolvable problems

## Key principle

Council is advisory, not automatic. Gate-runner emits the signal. The DA reads it and decides. Auto-triggering council costs tokens and time without human judgment on whether the stall warrants debate vs a simple retry.
