---
argument-hint: <issue-number>
---

!`gh issue view $ARGUMENTS --repo hornjason/pai-harness 2>/dev/null || echo "Issue $ARGUMENTS not found"`

Ship this issue through the harness. Follow the pipeline:

1. Read the issue above and understand the goal
2. Read the governing spec (check specs-routing rule)
3. Invoke Skill("harness") to orchestrate implementation
4. The harness delegates to Marcus (code), Quinn (test), Rook (security)
