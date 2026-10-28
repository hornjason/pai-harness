/**
 * The document a new spec starts as.
 *
 * ## Why this is not the old template
 *
 * `scripts/create-spec.ts` used to emit a title, a `## Context` placeholder
 * and one `SC-TODO` line. Everything that makes a criterion checkable later —
 * what outcome it moves, what the measurement was before, which increment it
 * belongs to, what would prove it, when to stop — had to be retrofitted by
 * hand onto a finished document, and on
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` that retrofit took three rounds and
 * still left two ticked criteria naming nothing.
 *
 * So the frame is emitted at authoring time. The sections below are not
 * decoration: each one exists because leaving it out produced a specific,
 * observed failure, and the heading text names which.
 *
 * ## What each section is for, and where it comes from
 *
 * - **Outcomes, with a baseline and the command that produced it.** GQM
 *   (Basili) and ISO/IEC/IEEE 15939 both make the measurement subordinate to
 *   a stated question. The addition here is the COMMAND: a baseline nobody
 *   can re-run is a number, not a measurement, and an outcome with no
 *   baseline makes the first increment *instrument it*, never *improve it*.
 * - **Increments as MMFs.** Denne & Cleland-Huang's Minimum Marketable
 *   Feature — the smallest set of criteria that together move one outcome.
 *   Not an MVP: an MVP buys learning, an MMF delivers value, and conflating
 *   them is how a spec ends up with one increment containing everything.
 * - **Appetite and a circuit breaker.** Shape Up's answer to the question
 *   MMF is silent on: what happens when an increment does not finish. The
 *   default is CANCELLED, not extended.
 * - **Pre-specified decision criteria.** 15939's defined term. The test is
 *   determinism — two people following the rule reach the same decision — so
 *   a threshold written as a number beats one written as "if it looks good".
 * - **A deviations record, written after the measurement.** The only element
 *   of this frame with direct empirical support: van den Akker et al. (2023)
 *   found ~75% of studies deviate from their protocol, and adherence rose to
 *   92% where deviations had to be declared. Empty until the measurement
 *   exists is the correct state; absent is not.
 *
 * ## The checker is shipped with the template, deliberately
 *
 * A template with nothing behind it is a convention, and the surveyed tools
 * are unanimous that conventions decay. `lib/spec-evidence.ts` is bound by
 * the `evidence: required` key this template emits, so a document created
 * through this path is checked from its first commit and every document that
 * predates it is untouched.
 */

import { localCalendarDay } from "./local-calendar-day";

/** What a generated spec must carry for `lib/spec-evidence.ts` to bind it. */
export const EVIDENCE_FRONTMATTER_KEY = "evidence: required";

export interface SpecTemplateInput {
  title: string;
  /** One line saying what the spec governs. May be the `TODO —` placeholder. */
  governs: string;
  /** Criterion statements supplied with `--sc`, already validated. */
  criteria: string[];
  /** `YYYY-MM-DD`. Injected so a test is not a hostage to the clock. */
  today?: string;
}

/**
 * Render the criteria block.
 *
 * Every criterion is emitted with its `needs:` line already present and its
 * `proved-by:` line already present and EMPTY. That is the point: the blank
 * cell is visible in the document from the moment it is created, rather than
 * being a thing somebody could have added. `SC-TODO` carries no digits, so
 * `lib/spec-evidence.ts` does not parse a placeholder as a criterion and a
 * freshly generated spec is not born red.
 */
function criteriaBlock(criteria: string[]): string {
  const lines = criteria.length > 0
    ? criteria.map((statement, i) => `- [ ] SC-TODO-${i + 1}: ${statement}`)
    : ["- [ ] SC-TODO: [first criterion — atomic, verifiable, 8-12 words]"];

  return lines
    .map(
      line =>
        `${line}\n` +
        `      needs: test\n` +
        `      proved-by:\n`,
    )
    .join("\n");
}

/**
 * The whole document.
 *
 * One exported function, so the template has a single site. A second place
 * that emits spec scaffolding would drift from this one silently — and the
 * two would be indistinguishable from one correct emitter under any test that
 * only ever calls one of them.
 */
export function renderSpecTemplate(input: SpecTemplateInput): string {
  const today = input.today ?? localCalendarDay();

  return `---
doc-type: spec
status: draft
owner: TODO
created: ${today}
updated: ${today}
governs: ${input.governs}
testable: true
compliance: strict
${EVIDENCE_FRONTMATTER_KEY}
---

# ${input.title}

## Why this exists

[The problem, in the terms of whoever has it. Not the solution.]

## Outcomes

What changes in the world if this works. One row each. **An outcome with no
baseline makes the first increment "instrument it", never "improve it"** — so
if you cannot fill the baseline column, say \`UNMEASURED\` and treat measuring
it as the work.

| Outcome | Baseline today | Command that produced the baseline | Target |
|---|---|---|---|
| [what gets better] | [number, or UNMEASURED] | \`[the command, runnable as written]\` | [number] |

## Increment 1 — [name]

The smallest set of criteria that together move ONE outcome above. Not a
phase, not a layer, not a list of everything that is wrong: if finishing it
would not move a row in the table, it is not an increment.

**Moves:** [which outcome row]

**Appetite:** [e.g. "three pull requests and one release"]. When the appetite
is spent and the exit criteria are not met, this increment is **cancelled and
re-scoped, not extended.**

**Exit criteria — how we know it is done:**

- [ ] [the observable state that ends this increment]

**Pre-specified decision criteria — written BEFORE the measurement:**

Two people reading this must reach the same decision from the same reading.
A row that needs a judgement call is not a decision criterion yet.

| Reading | Selects | Next increment |
|---|---|---|
| [a number and an operator, e.g. "> 60%"] | [hypothesis] | [what gets built] |
| [the futility row — the reading that means STOP] | neither | cancel and re-scope |

**Deviations record — written after the measurement, and empty until then.**

## Success Criteria

Each criterion carries two lines. \`needs:\` says at authoring time what kind
of proof this takes — one of \`test\`, \`measurement\`, \`run\`, \`review\`.
\`proved-by:\` names what actually ran, and **a ticked criterion with it blank
fails the build** (\`lib/spec-evidence.ts\`). If you are deliberately not
proving one, say so out loud instead:

\`\`\`
      waived-reason: [why, in a sentence that is still true next month]
      waived-by: [who decided]
      waived-until: YYYY-MM-DD
\`\`\`

When you tick a criterion, record \`fingerprint:\` beside its evidence with
\`rungate audit-spec-evidence --record-fingerprints\`, so that **rewording the
criterion later invalidates what proved it.** That command only ever adds a
fingerprint — refreshing a stale one is a decision, and it means re-running
the evidence first.

Check the whole document at any time with \`rungate audit-spec-evidence\`.

Both are named as CLI commands and not as paths into \`scripts/\`, because a
generated spec is read in the project it was generated FOR. A \`bun
scripts/…\` line resolves against that project's own \`scripts/\` directory,
where this tool does not live, so the instruction would name a path the
reader does not have — and the frontmatter above would declare a gate the
reader cannot run.

${criteriaBlock(input.criteria)}`;
}
