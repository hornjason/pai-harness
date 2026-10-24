---
description: A comment claims SC coverage only from a declaring position — a bare id mid-sentence is a citation
doc-type: reference
status: active
owner: jason
updated: 2026-10-13
---

## Say it in a declaring position, or it does not count

When a test file covers a success criterion, write the id where a scanner can
see that you meant it as a claim:

```ts
/**
 * Covers SC-640, SC-641 (HARNESS-STANDARD.md).
 */
```

Any of these count, and they are the forms already in the tree — you almost
certainly do not need to change how you write:

| Form | Example |
|---|---|
| a coverage verb before the id | `// covers SC-640` |
| a label | `// SC-640: the rate is a rate` · `// AC-2 / SC-516 / SC-517: …` |
| the id opening a line | `` *     SC-561..SC-564 (SPEC.md) `` |
| an issue heading | `// #178 / SC-413: a worktree may only contribute what it claimed` |
| a `SPEC-REF:` line | `// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Success Criteria (SC-369)` |
| a parenthetical of ids only | `// … turns it red (SC-4).` · `(#190, SC-624)` |
| a `describe`/`test`/`it` title | `test("SC-640: …")` |

**What does not count: a bare id in the middle of a sentence.**

```ts
// SC-640 was the criterion the collision broke      ← NOT a claim
// which is #307 SC-A1 exactly, reintroduced         ← NOT a claim
// `other.test.ts` declares SC-621, SC-622           ← NOT a claim
```

Write about a criterion as much as you like. Prose is the point of a comment.
Just do not expect prose to tick a checkbox.

## Why

`scripts/sync-sc-status.ts` ticks a spec's checkbox when a test file mentions
the id in a comment. #149 chose that position deliberately and was right about
it — a comment is where a project declares intent. What the position cannot do
is tell a claim from a citation, and they are the same shape.

Measured at #360: of 220 comment-position credits the population separates
almost perfectly **by structural position** — every citation found sat
mid-sentence in running prose. So this is not a new marker to adopt; it is
the convention the repo already followed, made checkable. The audit, and
the three times this rule caught itself, are in
`reference/check-failure-worked-instances.md`.

## The direction this is allowed to be wrong in

Toward NOT crediting. A declaring form nobody thought of costs an unticked
checkbox, which someone fixes by adding one line. The other direction
certifies a criterion that nothing tests — see
`.claude/rules/checks-must-be-able-to-fail.md`.

If your claim is not being credited, add `covers` in front of it. Do not widen
the rule.

## Owner

`lib/sc-claim-forms.ts` — `commentClaimForm()` is the single exported
predicate, so there is one binding to mutate. Do not add a second place that
decides what counts as a claim; a second one would survive any mutation of the
first and the guard would go green for the wrong reason.
