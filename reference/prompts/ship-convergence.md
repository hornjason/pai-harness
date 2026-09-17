---
doc-type: reference
status: active
owner: jason
updated: 2026-09-03
---

# Convergence Budget

## Rule

No hard cap on council rounds. Stop when findings plateau or grow after 3 consecutive rounds.

## How it works

After each council→ship cycle, track the findings count:

```
Round 1: council finds 5 issues → ship them
Round 2: council finds 3 issues → ship them  (declining = progress)
Round 3: council finds 1 issue  → ship it    (still declining)
Round 4: council finds 0        → DONE

vs.

Round 1: council finds 5 → ship
Round 2: council finds 6 → ship           (growing = problem)
Round 3: council finds 5 → STALL          (not declining after 3 rounds)
→ Stop: "3 council rounds, findings not declining. Manual review needed."
```

## Signal: trend, not count

- Findings declining each round → keep going
- Findings plateau (same count 2x) → one more round
- Findings plateau 3x OR grow → STALL, stop and flag

## Tracking

Write convergence data to workflow-state.json:

```json
{
  "convergence": {
    "rounds": [
      { "round": 1, "findingsCount": 5, "ts": "..." },
      { "round": 2, "findingsCount": 3, "ts": "..." },
      { "round": 3, "findingsCount": 1, "ts": "..." }
    ],
    "trend": "declining",
    "verdict": "CONVERGING"
  }
}
```

Verdicts: CONVERGING (declining), STALLED (plateau 3x or growing), DONE (0 findings).

## Integration with ship

The DA reads convergence data after each council run and decides:
- CONVERGING → continue shipping findings
- STALLED → stop, post diagnostic to issue
- DONE → close the loop

This is advisory — the DA makes the call. No mechanical enforcement beyond tracking.
