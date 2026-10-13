/**
 * Who owns a `.claude/rules/*.md` file after a human has edited it (#370).
 *
 * `bun bin/rungate.ts scaffold . --fix` on a clean checkout of this repo
 * rewrote eight rule files unconditionally — `writeFileSync` in a loop, no
 * existence check, no comparison — and reported `GENERATED:` for each. On
 * 2026-10-13 that truncated `.claude/rules/checks-must-be-able-to-fail.md`
 * from 262 lines to 65, discarding every worked example and every mutation
 * table in the file the rest of the repo cites more than any other. The run
 * exited 0. `git status` said `M`, not `D`, so the loss did not even look
 * like a deletion.
 *
 * It also reverted `key-files.md`'s `#296` annotation — "DA-owned, never
 * written from an agent worktree" — which exists because run
 * `wf_0b15a933-b2b` lost four worktrees and 2,565 lines of validated work
 * when an agent wrote a DA-owned file.
 *
 * ## Why neither obvious answer works
 *
 * This is the other half of the question #208 asks from the opposite side:
 *
 * - **Never overwrite** (`safeWrite`, the plain `scaffold .` mode) writes
 *   nothing, so a generator fix never reaches a tree that already has the
 *   file. #363's AGENTS.md fix could not be adopted at all without `--fix`.
 * - **Always overwrite** (`--fix`) is the defect above.
 *
 * Neither can be right, because `key-files.md` is genuinely generated — its
 * table comes from a scan — *and* genuinely hand-annotated.
 *
 * ## The mechanism
 *
 * The generator stamps the sha of the body it wrote into the file's own
 * frontmatter. On the next run the file answers the only question that
 * matters — *has anyone touched this since the harness wrote it?* — without
 * a manifest that can desync from the tree it describes.
 *
 *   | existing file                              | action     |
 *   |--------------------------------------------|------------|
 *   | absent                                     | `create`   |
 *   | body identical to what would be generated  | `update`   |
 *   | carries a marker matching its own body     | `update`   |
 *   | anything else                              | `preserve` |
 *
 * The second row is what makes adoption possible without a migration: a file
 * the harness wrote before provenance existed is byte-identical to the
 * generator's output, so the first run recognises it and stamps it. Nothing
 * has to be hand-listed as owned.
 *
 * The last row is deliberately the fallback rather than an enumerated case.
 * An unrecognised file is preserved and REPORTED, never resolved — the
 * direction this is allowed to be wrong in is toward keeping a file the
 * harness could have regenerated, which costs a line in a report. The other
 * direction costs 197 lines of a rule nobody noticed was gone.
 */
import { createHash } from "crypto";

export type RuleAction = "create" | "update" | "preserve";

export interface RuleDecision {
  action: RuleAction;
  /** Why, in the words the scaffold report prints. */
  reason: string;
  /** What to write. Absent exactly when `action` is `preserve`. */
  content?: string;
}

/** The frontmatter key carrying the sha of the body the harness last wrote. */
export const PROVENANCE_KEY = "generated-sha";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/**
 * Everything after the frontmatter block.
 *
 * The sha covers the body alone, and that is load-bearing twice over: the
 * stamp lives in the frontmatter, so hashing the whole file would change the
 * thing being hashed, and `updated:`-style keys move on their own without
 * anybody editing the rule.
 */
export function ruleBody(text: string): string {
  // Leading blank lines go too. Without that the sha depends on whether the
  // block was followed by one newline or two — which differs between a file
  // that had frontmatter already and one the stamp just gave some, so the
  // very first stamped file would read as hand-edited on the next run.
  return text.replace(FRONTMATTER, "").replace(/^\n+/, "");
}

export function bodySha(text: string): string {
  return createHash("sha256").update(ruleBody(text)).digest("hex").slice(0, 16);
}

/** The sha the file claims the harness wrote, or null if it claims nothing. */
export function declaredSha(text: string): string | null {
  const fm = FRONTMATTER.exec(text);
  if (!fm) return null;
  const line = new RegExp(`^${PROVENANCE_KEY}:\\s*([0-9a-f]{16})\\s*$`, "m").exec(fm[1]);
  return line ? line[1] : null;
}

/**
 * Put the generated content's own body-sha into its frontmatter.
 *
 * Replaces an existing stamp rather than appending a second one — two
 * `generated-sha` lines would make `declaredSha` read whichever came first
 * and silently stop matching.
 */
export function stampProvenance(generated: string): string {
  const sha = bodySha(generated);
  const fm = FRONTMATTER.exec(generated);
  if (!fm) return `---\n${PROVENANCE_KEY}: ${sha}\n---\n\n${generated}`;
  const keys = fm[1]
    .split("\n")
    .filter(l => !new RegExp(`^${PROVENANCE_KEY}:`).test(l));
  const block = `---\n${[...keys, `${PROVENANCE_KEY}: ${sha}`].join("\n")}\n---\n`;
  return generated.replace(FRONTMATTER, block);
}

/**
 * The single place that decides whether a generated rule file may be written.
 *
 * One exported predicate on purpose. A second site deciding the same thing
 * would survive any mutation of this one, and the guard would go green for a
 * reason that has nothing to do with it working —
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function decideRuleWrite(existing: string | null, generated: string): RuleDecision {
  const content = stampProvenance(generated);
  if (existing === null) return { action: "create", reason: "no such file", content };

  if (bodySha(existing) === bodySha(generated)) {
    // Unchanged from what the generator would write. Writing is a no-op on
    // the body and stamps the marker, which is how a pre-provenance tree
    // adopts the mechanism without anyone listing files by hand.
    return { action: "update", reason: "identical to generator output", content };
  }

  const declared = declaredSha(existing);
  if (declared !== null && declared === bodySha(existing)) {
    return { action: "update", reason: "harness-written and untouched since", content };
  }

  return {
    action: "preserve",
    reason:
      declared === null
        ? "hand-authored — no harness provenance marker"
        : "hand-edited since the harness wrote it",
  };
}
