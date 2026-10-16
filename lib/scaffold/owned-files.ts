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

/** How the generator writes one owned file. */
export type WriteStrategy =
  /** Rewritten every run. Reported CHANGED only when the bytes differ. */
  | "regenerate"
  /** Rewritten every run, but hand-edits are preserved and reported (#370). */
  | "provenance"
  /** The harness owns named jobs inside a file a consumer also writes to. */
  | "job-preserving"
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
}

/**
 * The declared set. This list and the table in
 * `.claude/rules/harness-managed.md` are reconciled in both directions by
 * `test/scaffold-ownership.test.ts`, so a row cannot describe behaviour the
 * code does not have — which is the whole of #208.
 */
export const OWNED_FILES: OwnedFile[] = [
  {
    path: ".github/workflows/ci.yml",
    strategy: "job-preserving",
    customize: "Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job",
    avoid: "Don't edit the generated `test` job",
  },
  {
    path: ".github/workflows/gates.yml",
    strategy: "job-preserving",
    customize: "Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job",
    avoid: "Don't edit the generated `gates` job",
  },
  {
    path: ".claude/agents/*.md",
    strategy: "regenerate",
    customize: "Settings from `.claude/rungate/roles.json`",
    avoid: "Don't edit briefs",
  },
  {
    path: ".claude/rules/*.md",
    strategy: "provenance",
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
    customize: "DA-owned (#296) — generated from project-state.json by the DA",
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
 * The provenance marker for a file whose comment syntax is `//`.
 *
 * The frontmatter form in `lib/rule-provenance.ts` is the same idea and
 * cannot be reused verbatim: a TypeScript file has no `---` block. Both
 * stamp a digest of the body the generator wrote, so the next run can ask
 * "has anyone touched this since?" with nothing that can desync from the
 * tree it describes.
 */
const MARKER = /^\/\/ generated-sha: ([0-9a-f]{16})\n/;

export function commentBody(text: string): string {
  return text.replace(MARKER, "");
}

export function commentSha(text: string): string {
  return createHash("sha256").update(commentBody(text)).digest("hex").slice(0, 16);
}

export function declaredCommentSha(text: string): string | null {
  const m = MARKER.exec(text);
  return m ? m[1] : null;
}

export function stampComment(generated: string): string {
  const body = commentBody(generated);
  return `// generated-sha: ${commentSha(body)}\n${body}`;
}

export interface WriteDecision {
  action: "create" | "unchanged" | "changed" | "preserve";
  reason: string;
  /** The bytes to write. Absent for `unchanged` and `preserve`. */
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
export function decideOwnedWrite(
  strategy: WriteStrategy,
  existing: string | null,
  generated: string,
): WriteDecision {
  if (existing === null) {
    return {
      action: "create",
      reason: "no such file",
      content: strategy === "provenance" ? stampComment(generated) : generated,
    };
  }

  if (strategy === "create-only") {
    return { action: "unchanged", reason: "seeded once; its content is not the harness's" };
  }

  if (strategy === "provenance") {
    const stamped = stampComment(generated);
    if (bytesIdentical(existing, stamped)) {
      return { action: "unchanged", reason: "identical to generator output" };
    }
    const declared = declaredCommentSha(existing);
    if (declared === null) {
      return { action: "preserve", reason: "hand-authored — no harness provenance marker" };
    }
    if (declared !== commentSha(existing)) {
      return { action: "preserve", reason: "hand-edited since the harness wrote it" };
    }
    return { action: "changed", reason: "harness-written and untouched since", content: stamped };
  }

  if (bytesIdentical(existing, generated)) {
    return { action: "unchanged", reason: "regenerated output is byte-identical" };
  }
  return { action: "changed", reason: "regenerated output differs", content: generated };
}
