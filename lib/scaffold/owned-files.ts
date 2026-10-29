/**
 * Which files the scaffold owns, and how it writes each one (#208).
 *
 * `.claude/rules/harness-managed.md` says of five file classes:
 *
 *   > These files are managed by rungate and **regenerated on re-scaffold**.
 *   > Do not edit them directly.
 *
 * That is an ownership claim, and a maintainer who believes it correctly
 * declines to hand-edit a brief or a workflow and waits for a re-scaffold to
 * deliver improvements. So it has to be true.
 *
 * **It was true for four of the five.** Measured on this tree:
 *
 * | claimed file | what re-scaffold actually did |
 * |---|---|
 * | `.github/workflows/ci.yml` | regenerated, job-preserving — correct |
 * | `.github/workflows/gates.yml` | the same — correct |
 * | `.claude/agents/*.md` | rewritten every run — correct |
 * | `CODE-MAP.md` | rewritten, with a freshness skip — correct |
 * | `test/scaffold-conformity.test.ts` | **skipped forever** |
 *
 * The last one went through `safeWrite`, which returns early on
 * `existsSync`. Create-if-absent wearing the word "regenerated". The run
 * reported `SKIP: … (already exists)`, which is indistinguishable from
 * "already current" to anyone reading the log, and the claim converted a
 * fixable staleness into a permanent one.
 *
 * So the issue's framing — *every* `safeWrite` file drifts — is right about
 * the mechanism and overcounts the damage: of the five `safeWrite` call
 * sites only one is a file the harness claims to own. Two are files it does
 * not claim (`.github/copilot-instructions.md`, `specs/WORKFLOW-DEFINITION.md`),
 * and two must NEVER be rewritten (below). Stated plainly because a fix
 * scoped to the claim is a different change from a fix scoped to the helper.
 *
 * ## Why this file exists rather than a tighter `safeWrite`
 *
 * The defect is not that one helper returns early. It is that **ownership
 * was prose**. A table in a doc cannot be iterated, so nothing could notice
 * that one of its rows described behaviour the code did not have. Here the
 * declaration is data, the generator reads it, and a test reconciles it
 * against the doc in both directions.
 *
 * ## `project-state.json` and `PROJECT-STATE.md` are create-only, on purpose
 *
 * They look like scaffold artifacts and are listed here so that nothing
 * "tidies" them into the regenerated set later. They are **DA-owned** (#296):
 * a single shared state document that four parallel worktrees would each
 * overwrite with their own version. On 2026-10-11 run `wf_0b15a933-b2b` lost
 * four worktrees and 2,565 lines of validated work to exactly that. The
 * scaffold seeds them once and never touches them again.
 */

import { createHash } from "crypto";
import { PROJECT_STATE_OWNERSHIP } from "../project-state-derivation";

import {
  BRIEF_CONSTRAINTS_SECTION,
  HARD_CONSTRAINTS_SECTION,
  preserveSections,
  type SectionSpec,
} from "../agents-md-sections";

/** How the generator writes one owned file. */
export type WriteStrategy =
  /** Rewritten every run. Reported CHANGED only when the bytes differ. */
  | "regenerate"
  /** Rewritten every run, but hand-edits are preserved and reported (#370). */
  | "provenance"
  /** The harness owns named jobs inside a file a consumer also writes to. */
  | "job-preserving"
  /** The harness owns the file except for named sections, which carry forward (#568). */
  | "section-preserving"
  /** Seeded once and never rewritten. Someone else owns the content. */
  | "create-only";

export interface OwnedFile {
  /** Repo-relative path, or a `*` class for a directory of generated files. */
  path: string;
  strategy: WriteStrategy;
  /** What to change INSTEAD of editing the file. */
  customize: string;
  /** The thing not to do. */
  avoid: string;
  /**
   * Which section carries forward. REQUIRED on a `section-preserving` row,
   * and asserted as such by `test/scaffold-ownership.test.ts` — a row that
   * declared the strategy and no section would silently merge against
   * AGENTS.md's heading, which is *Silent Default Substitution* in the one
   * place the declaration is supposed to be the whole answer.
   */
  sections?: SectionSpec;
  /**
   * The binding that implements this row's strategy, when it is NOT
   * `decideOwnedWrite` (#759).
   *
   * `decideOwnedWrite` is the one decider for files written through
   * `regenerateOwned`, and for a while the table read as though it were the
   * one decider for EVERY owned file. It is not: `.claude/rules/*.md` go
   * through `decideRuleWrite` because a markdown file has no `//` comments,
   * and the two workflow rows go through `writeManagedFile` because YAML
   * jobs merge rather than replace.
   *
   * A row that names no `servedBy` is claiming `decideOwnedWrite` handles
   * it, and `test/owned-strategy-reachability.test.ts` refuses that claim
   * when the function has no branch for the strategy. Unset is therefore a
   * claim, not an absence — which is the direction this has to be wrong in,
   * because the silent version is what #759 is about.
   */
  servedBy?: string;
}

/**
 * The declared set. This list and the table in
 * `.claude/rules/harness-managed.md` are reconciled in both directions by
 * `test/scaffold-ownership.test.ts`, so a row cannot describe behaviour the
 * code does not have — which is the whole of #208.
 */
export const OWNED_FILES: OwnedFile[] = [
  {
    // Absent from this list until #568, which is how a run could delete 37
    // lines of a consumer's Hard Constraints and report `REGENERATED`: the
    // most-rewritten file in the tree was the one file with no declared
    // strategy and no route through `decideOwnedWrite`.
    path: "AGENTS.md",
    strategy: "section-preserving",
    customize: "Everything but `## Hard Constraints` is generated from the scan and `.claude/rungate/`; put non-inferable project rules in that section and they carry forward",
    avoid: "Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it",
    sections: HARD_CONSTRAINTS_SECTION,
  },
  {
    path: ".github/workflows/ci.yml",
    strategy: "job-preserving",
    servedBy: "writeManagedFile (lib/scaffold/steps.ts) via mergeManagedWorkflow — the harness owns named jobs, not the file",
    customize: "Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job",
    avoid: "Don't edit the generated `test` job",
  },
  {
    path: ".github/workflows/gates.yml",
    strategy: "job-preserving",
    servedBy: "writeManagedFile (lib/scaffold/steps.ts) via mergeManagedWorkflow — the harness owns named jobs, not the file",
    customize: "Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job",
    avoid: "Don't edit the generated `gates` job",
  },
  {
    // Absent from this list, and from the prose table, for the whole life of
    // the file (#630 through #631). `createCiWorkflows` has written it since
    // #630 — through the same `writeManagedFile` its two siblings above use
    // — so a consumer's hand edit to the `ai-review` job was overwritten on
    // every scaffold and reported as nothing, while the two files beside it
    // reported the overwrite by name. The ownership did not travel with the
    // bytes, which is #722's property met from the other side.
    path: ".github/workflows/ai-review.yml",
    strategy: "job-preserving",
    servedBy: "writeManagedFile (lib/scaffold/steps.ts) via mergeManagedWorkflow — the harness owns named jobs, not the file",
    customize: "Set `ci.vertex` in `.claude/rungate/config.json` to authenticate on Vertex with Workload Identity Federation; add your own jobs alongside the generated `ai-review` job",
    avoid: "Don't edit the generated `ai-review` job",
  },
  {
    // #1488. The `workflow_run: completed` half of the AI review: it runs
    // the unmeasured classifier after the review job ends, which is the
    // first moment that job's log is served. Declared the moment the
    // generator learned to write it — the whole of #631's lesson one file
    // over is that ownership has to travel with the bytes, and a workflow
    // the generator writes and this list does not name is a consumer's hand
    // edit overwritten in silence.
    path: ".github/workflows/ai-review-unmeasured.yml",
    strategy: "job-preserving",
    servedBy: "writeManagedFile (lib/scaffold/steps.ts) via mergeManagedWorkflow — the harness owns named jobs, not the file",
    customize: "Set `ci.runner` in `.claude/rungate/config.json`; add your own jobs alongside the generated `record-unmeasured` job",
    avoid: "Don't edit the generated `record-unmeasured` job, and don't give it a `merge_group` trigger — it reports no status to the pull request and cannot be a required check",
  },
  {
    // `regenerate` until #655, and the declaration was never consulted:
    // `generateAgentBriefsStep` called `writeFileSync` directly, so the row
    // described behaviour that a bare overwrite happened to coincide with.
    // The cost was that a rule mined from a project's own compliance history
    // had nowhere in that project to live — every brief surface was rebuilt
    // from harness-wide templates on the next scaffold.
    path: ".claude/agents/*.md",
    strategy: "section-preserving",
    customize: "Everything but `## Project Constraints` is generated from `.claude/rungate/roles.json` and the templates; put rules mined from this repo's own history in that section and they carry forward",
    avoid: "Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it",
    sections: BRIEF_CONSTRAINTS_SECTION,
  },
  {
    path: ".claude/rules/*.md",
    strategy: "provenance",
    servedBy: "decideRuleWrite (lib/rule-provenance.ts) — a frontmatter `generated-sha:` key, because a markdown file has no line comments",
    customize: "Edit freely — a hand-edited rule is preserved and reported (#370)",
    avoid: "Don't expect edits to survive if you also delete the `generated-sha` marker",
  },
  {
    path: "test/scaffold-conformity.test.ts",
    strategy: "regenerate",
    customize: "Runs automatically",
    avoid: "Don't edit",
  },
  {
    path: "CODE-MAP.md",
    strategy: "regenerate",
    customize: "Auto-generated from code scan",
    avoid: "Don't edit",
  },
  {
    path: "project-state.json",
    strategy: "create-only",
    customize: "DA-owned (#296) — seeded once, then yours",
    avoid: "Don't expect re-scaffold to update it; an agent in a worktree must never write it",
  },
  {
    path: "PROJECT-STATE.md",
    strategy: "create-only",
    // #781: whether this project GENERATES the file is a reading, not a
    // constant — see lib/project-state-derivation.ts. This table has no
    // root to scan, so it states only the part that is true everywhere.
    customize: `${PROJECT_STATE_OWNERSHIP} — maintained by the DA; whether this project derives it from the state JSON is reported per project in .claude/rules/key-files.md`,
    avoid: "Don't edit directly; don't expect re-scaffold to update it",
  },
  {
    path: "SUCCESS.md",
    strategy: "create-only",
    customize: "Seeded as a template (#485) — fill in the claims; `bunx rungate create-success` re-seeds",
    avoid: "Don't leave it as the seed; SUCCESS-1 refuses a template, and re-scaffold will not fill it in",
  },
];

/**
 * The declared row for a label, or null.
 *
 * One matcher. `ownedStrategy` and `ownedSections` are two questions about
 * one row, and a second copy of the glob rule would be a second answer to
 * "which row is this" that nothing compares against the first.
 */
export function ownedFileFor(label: string): OwnedFile | null {
  for (const owned of OWNED_FILES) {
    if (owned.path === label) return owned;
    if (owned.path.includes("*")) {
      const [prefix, suffix] = owned.path.split("*");
      if (label.startsWith(prefix) && label.endsWith(suffix)) return owned;
    }
  }
  return null;
}

/**
 * The markdown table for `.claude/rules/harness-managed.md`, generated.
 *
 * #208 in one function. The old table was hand-written prose, so nothing
 * could notice that one of its rows described behaviour the code did not
 * have. Generating it means a row cannot exist without an entry here, and
 * `test/scaffold-ownership.test.ts` reconciles the shipped file against
 * this output in both directions so the generated table cannot drift from
 * the one on disk either.
 *
 * The strategy column is new and is the part that would have caught the
 * defect: "managed" was doing too much work as a single word.
 */
export function ownedFilesTable(): string {
  const rows = OWNED_FILES.map(
    f => `| \`${f.path}\` | ${f.strategy} | ${f.customize} | ${f.avoid} |`,
  );
  return [
    "| File | Strategy | How to customize | What NOT to do |",
    "|------|----------|-----------------|----------------|",
    ...rows,
  ].join("\n");
}

/** The action prefix for an owned file the generator declined to overwrite. */
export const SCAFFOLD_REFUSE = "PRESERVED";

/**
 * Whether what is on disk already is byte-for-byte what we would write.
 *
 * The point of #208's SC-671: `0 changed` has to be a MEASUREMENT. The old
 * report said `SKIP (already exists)`, which is produced by not looking.
 * This is produced by looking and finding no difference, and the two are
 * only indistinguishable to someone reading the summary line.
 */
export function bytesIdentical(existing: string | null, generated: string): boolean {
  return existing !== null && existing === generated;
}

/**
 * A freshness stamp alone never justifies a rewrite (#1647).
 *
 * `updated:` claims to mean *the date this file's content last changed*. If
 * the only thing separating the regenerated file from the committed one is
 * that line, then the content did not change and the committed date is the
 * true one — so the generator's "today" is a lie, and writing it makes the
 * repository stop being a fixed point of its own generator at the next
 * midnight.
 *
 * ## This is #827 again, through the hole its fix left
 *
 * #827 removed a `updated: today` that was forced AFTER the frontmatter
 * spread, and replaced it with a carry-forward in
 * `lib/generators/agents-md.ts`: keep the stamp when
 * `body === existingBody(root)`. That condition is **never true in this
 * repository and never can be.** AGENTS.md is written `section-preserving`,
 * so the file on disk carries `## Hard Constraints` — 3,357 bytes of body
 * against the generator's 1,352 on `aa7bc0c0` — and the generator does not
 * emit that section. It is merged in HERE, after the comparison has already
 * been made and lost.
 *
 * So the carry-forward never fired, the stamp was always today, and AC-2 of
 * `test/harness-fixed-point.test.ts` went green only on the calendar day
 * AGENTS.md was last committed. Measured: branch `rg/phase-placement` was
 * green at 23:09 and 23:20 UTC on 2026-10-28 and red from 00:22 on 2026-10-29,
 * the reddening commit being a documentation-only edit that touches neither
 * AGENTS.md nor any generator.
 *
 * ## Why the decision lives at the write site
 *
 * Because this is the first point that holds the FINAL bytes. Any comparison
 * made before `preserveSections` is comparing a document to a different
 * document and can only be wrong — which is exactly how the first fix failed.
 * `buildFrontmatter` no longer takes a `bodyUnchanged`: two deciders for
 * "may the stamp move" is the shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the one that could see
 * the answer was not the one being asked.
 *
 * Substitution, not deletion: a file whose content genuinely changed keeps
 * the generator's today, because the swap then fails to make the two equal
 * and `generated` is returned untouched.
 */
export function carryUpdatedStamp(existing: string | null, generated: string): string {
  if (existing === null) return generated;
  const STAMP = /^updated: .*$/m;
  const theirs = existing.match(STAMP);
  if (theirs === null || !STAMP.test(generated)) return generated;
  const swapped = generated.replace(STAMP, theirs[0]);
  return swapped === existing ? swapped : generated;
}

/**
 * The provenance marker for one line-comment syntax.
 *
 * A factory rather than a second copy, because `.github/workflows/*.yml`
 * needs the same marker with `#` and the digest logic is the part that must
 * not fork (#722). Two independent implementations of "has anyone touched
 * this since" are two deciders answering one question, and a mutation of
 * either leaves the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export function lineCommentProvenance(prefix: string) {
  const marker = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")} generated-sha: ([0-9a-f]{16})\\n`);
  const body = (text: string): string => text.replace(marker, "");
  const sha = (text: string): string =>
    createHash("sha256").update(body(text)).digest("hex").slice(0, 16);
  return {
    body,
    sha,
    declared: (text: string): string | null => {
      const m = marker.exec(text);
      return m ? m[1] : null;
    },
    /** Idempotent: stamping an already-stamped document re-stamps the body. */
    stamp: (generated: string): string => {
      const b = body(generated);
      return `${prefix} generated-sha: ${sha(b)}\n${b}`;
    },
  };
}





export interface WriteDecision {
  action: "create" | "unchanged" | "changed" | "preserve" | "refuse";
  reason: string;
  /** The bytes to write. Absent for `unchanged`, `preserve` and `refuse`. */
  content?: string;
}

/**
 * The single place that decides what happens to one owned file.
 *
 * One exported function, so there is one binding to mutate. The four
 * strategies answer the same question differently and all of them have to
 * route through here, or the declaration above becomes documentation again.
 *
 * **AC-5 asked for the hand-edit policy to be chosen and justified, not
 * resolved implicitly. It is: preserve and report.** #370 already answered
 * this exact question for `.claude/rules/*.md` and chose the same, for the
 * same reason — silently overwriting a human's work is the opposite failure
 * from silently skipping, and it is the worse one, because the skipped file
 * is still on disk and the overwritten one is gone. A second answer here
 * would mean the harness destroyed work in one directory and refused to in
 * another, with nothing stating which was which.
 *
 * `create-only` is not a weaker `regenerate`; it is a different owner. It
 * never reports a hand-edit, because there is no edit to report — the
 * content was never the harness's.
 */
/**
 * The strategies `decideOwnedWrite` actually has a branch for.
 *
 * Declared once and asserted against the branches by
 * `test/owned-strategy-reachability.test.ts`, so a strategy cannot be added
 * to the union, declared on a row, and left with no code behind it.
 */
export const DECIDED_HERE: readonly WriteStrategy[] = [
  "regenerate",
  "create-only",
  "section-preserving",
];

export function decideOwnedWrite(
  strategy: WriteStrategy,
  existing: string | null,
  generated: string,
  sections: SectionSpec = HARD_CONSTRAINTS_SECTION,
): WriteDecision {
  // Refuse a strategy this function does not implement, BEFORE anything
  // else looks at the file (#759).
  //
  // `job-preserving` and `provenance` are served elsewhere — `servedBy` on
  // their rows says where — and neither has a branch below. Until this
  // throw they fell through to the regenerate tail, so a caller that let
  // `ownedStrategy()` supply the default for `.github/workflows/ci.yml`
  // would have replaced a consumer's whole file, every job in it, and
  // reported `CHANGED: regenerated output differs`. Nothing does that
  // today; `regenerateOwned` defaults to exactly that expression, so it is
  // one forgotten argument away.
  //
  // A dead branch and a silently wrong one look identical in a green suite.
  // This is the loud version.
  if (!DECIDED_HERE.includes(strategy)) {
    const row = OWNED_FILES.find(f => f.strategy === strategy);
    throw new Error(
      `decideOwnedWrite does not implement the '${strategy}' strategy. ` +
        (row?.servedBy
          ? `It is served by ${row.servedBy}. Route this write there, or pass a strategy this function implements.`
          : `No OWNED_FILES row says what serves it, which means nothing does.`),
    );
  }

  if (existing === null) {
    return {
      action: "create",
      reason: "no such file",
      content: generated,
    };
  }

  if (strategy === "create-only") {
    return { action: "unchanged", reason: "seeded once; its content is not the harness's" };
  }

  if (strategy === "section-preserving") {
    // The merge is in `lib/agents-md-sections.ts`; what belongs HERE is the
    // decision, so a strategy cannot be implemented at a call site and left
    // out of the one binding every owned file routes through.
    const merged = preserveSections(existing, generated, sections);
    if (merged.lost.length > 0) {
      return {
        action: "refuse",
        reason:
          `${merged.lost.length} line(s) of user-owned content would be lost from ` +
          `${sections.label}, and the spec guarantees they survive regeneration: ` +
          merged.lost.join(" | "),
      };
    }
    // After the merge, because this is the first point holding the final
    // bytes — see `carryUpdatedStamp`.
    const settled = carryUpdatedStamp(existing, merged.content);
    if (bytesIdentical(existing, settled)) {
      return { action: "unchanged", reason: "regenerated output is byte-identical" };
    }
    return {
      action: "changed",
      reason:
        merged.preserved === null
          ? "regenerated output differs"
          : `regenerated output differs; ${merged.preserved.lines.length} line(s) of user-owned content carried forward`,
      content: settled,
    };
  }

  if (bytesIdentical(existing, generated)) {
    return { action: "unchanged", reason: "regenerated output is byte-identical" };
  }
  return { action: "changed", reason: "regenerated output differs", content: generated };
}
