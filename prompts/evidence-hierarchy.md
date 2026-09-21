---
doc-type: reference
status: active
owner: jason
updated: 2026-09-19
---

# Evidence Hierarchy

## Purpose
Defines evidence tiers so agents know what quality of proof is required.

## When to use
Gate enforcement — maps evidence types to tiers per AC type.

## Tiers

| Tier | Name | Method | Strength |
|------|------|--------|----------|
| S | Negative control | Revert fix, confirm bug returns | Strongest |
| A | Test output | `bun test` with assertion | Strong |
| B | Browser verification | Quinn screenshot + assertion | Strong for UI |
| C | Command output | curl, grep with specific check | Moderate |
| D | Static grep | `grep -r "pattern"` | Weak — cap at 25% |
| F | Self-attestation | "I checked and it works" | FAIL — always rejected |

### Minimum tiers by AC type
- CODE → A (test output)
- UI → B (browser verification)
- BUG-FIX → S (negative control)
- Static analysis → C supplementary only

### Never
- Never accept tier F (self-attestation) evidence for any AC — it is always rejected
- Never mix evidence tiers to inflate a verdict — the weakest piece of evidence governs the tier
- Never use static grep (tier D) as the sole evidence for more than 25% of ACs
