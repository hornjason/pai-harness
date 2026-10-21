import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { structuralCut } from "../lib/source-slice";
import { worktreeIdentity } from "../lib/worktree-repo";

/**
 * #872 — `worktreeRepo` is a mechanical fact the harness asks an agent to
 * transcribe, and the agent transcribed the wrong one.
 *
 * Run `wf_8dfce214-9f4`, 17 agents, 0 errors. The agent ran the command as
 * its first tool call and printed the right answer:
 *
 *   https://github.com/hornjason/<consumer>.git
 *
 * and then filled the structured output with the PARENT CHECKOUT PATH:
 *
 *   "worktreeRepo": "/Users/jhorn/Projects/DailyBriefDashboard"
 *
 * `repoSlug` cannot read a filesystem path as `owner/name`, so the verdict
 * was `unreadable` and the run ended at IMPLEMENT_FAILED. ~100 minutes and
 * ~1.39M subagent tokens of correct, committed work never reached Quinn or
 * Rook. **The guard was right to refuse** — refusing an unreadable reading
 * is the whole of #218. The defect is upstream of it.
 *
 * ## Why this is a shape and not a slip
 *
 * At the moment the model fills the output it is looking at a bare key named
 * `worktreeRepo` with `{ type: 'string' }` and no description, beside a
 * `worktreePath` that makes a path salient. The prose defining the field
 * sits ~4,500 lines away in the prompt. Two honest readings of the name —
 * "the repo this worktree belongs to" and "what the command printed" — and
 * the schema, which is what the model reads, declares neither.
 *
 * ## What this file does and does NOT fix
 *
 * Stated plainly because the issue prefers a different fix and cannot have
 * it here. "Stop asking, read it with `git -C <path> remote get-url origin`"
 * is right, and `lib/worktree-repo.ts` already has `readWorktreeRemote`
 * doing exactly that. **`workflows/ship.js` cannot call it**: it has no
 * subprocess access in the Workflow sandbox (#69), and the reporting spawn
 * is Marcus itself, so reading it in-harness costs an extra agent per run.
 * That is a cost/architecture decision, not a bug fix.
 *
 * So this is the issue's own stated minimum, and it follows the pattern the
 * sibling field already established: `filesChanged` carries a `description`
 * AND a refusal, because — in that field's own comment — *"a description is
 * a request"*. The description moves the definition to where the model reads
 * it; the refusal is what makes the failure legible when it still goes wrong.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
const libSource = readFileSync(join(REPO_ROOT, "lib", "worktree-repo.ts"), "utf-8");

/**
 * Cuts go through `lib/source-slice.ts` (#664) — no fixed windows, and no
 * private copy of the cutting logic in a file whose subject is two copies of
 * one thing drifting.
 */
const SCHEMA = structuralCut(shipSource, "const BUILD_RESULT_SCHEMA", { balanced: "{" });

/** The property's own declaration, so a description elsewhere cannot satisfy this. */
const property = (name: string) => structuralCut(SCHEMA, `${name}: {`, { balanced: "{" });

/**
 * ship.js's inlined copy of the decision, executed rather than read.
 *
 * `new Function` over an interpolated body is a code-injection shape and a
 * scanner will flag it. The interpolated value is this repository's own
 * `workflows/ship.js`, read off disk at test time — the same trust boundary
 * as importing it, which the Workflow sandbox makes impossible (#69). The
 * sibling `test/worktree-repo.test.ts` does the same for the same reason.
 */
const inlined = new Function(
  `${structuralCut(shipSource, "// ──── WORKTREE-IDENTITY-START ────", {
    endAnchor: "// ──── WORKTREE-IDENTITY-END ────",
  })}\nreturn { worktreeIdentity }`,
)() as { worktreeIdentity: typeof worktreeIdentity };

// ── The declaration the model actually reads ─────────────────────────────

describe("#872: the field says what it means, in the schema", () => {
  test("AC-1: worktreeRepo carries a description naming the command", () => {
    // Inside the PROPERTY, not merely somewhere in the schema: the prose is
    // already in the prompt and in a comment above the field, and both were
    // true while the run died. A `toContain` over the whole literal would
    // stay green over a bare `{ type: 'string' }`.
    const decl = property("worktreeRepo");
    expect(
      decl,
      "worktreeRepo has no description, so the model fills it from the name alone — #872",
    ).toContain("description:");
    expect(decl, "the description does not name the command whose output is wanted").toContain(
      "git remote get-url origin",
    );
  });

  test("AC-2: it rules out the reading that was actually taken", () => {
    // The failure was not "the model did not know what to run" — it ran the
    // command first thing. It was "the model did not know which of two
    // honest readings of the NAME to write down". So the description has to
    // refuse the wrong one by name, not merely describe the right one.
    const decl = property("worktreeRepo");
    expect(decl.toLowerCase(), "the description does not say it is never a path").toMatch(
      /never a (?:file ?system )?path|not a path/,
    );
  });

  test("AC-3: worktreePath says what IT is, so the pair is unambiguous", () => {
    // The confusion is between two adjacent fields. Describing one and
    // leaving the other bare moves the ambiguity rather than removing it.
    expect(property("worktreePath"), "worktreePath is still a bare string").toContain(
      "description:",
    );
  });

  test("AC-4: the schema and the prompt name the SAME command", () => {
    // Two positions naming one fact, with nothing comparing them (#621's
    // shape). The prompt paragraphs already existed and were already
    // followed — the agent ran the command — so their presence is not the
    // claim. The claim is that the declaration the model fills the output
    // from and the paragraph that asks for it cannot drift apart.
    //
    // NOT a count. `git remote get-url origin` appeared three times in
    // ship.js before this change, so any `>= 2` assertion was green over the
    // bare `{ type: 'string' }` and would stay green if the description were
    // deleted again — vacuous in both directions.
    const cmd = property("worktreeRepo").match(/`([^`]*git remote get-url[^`]*)`/)?.[1];
    expect(cmd, "the description quotes no command to compare the prompt against").toBeTruthy();

    const asks = shipSource.split("\n").filter(l => /report worktreeRepo/.test(l));
    expect(asks.length, "no prompt paragraph asks for worktreeRepo at all").toBeGreaterThan(0);
    for (const line of asks) {
      expect(line, `a prompt asks for worktreeRepo without naming \`${cmd}\``).toContain(cmd!);
    }
  });
});

// ── When it still goes wrong, the refusal names the mistake ──────────────

describe("#872: a path-shaped reading is named as such", () => {
  const WT = "/Users/jhorn/Projects/DailyBriefDashboard/.claude/worktrees/wf_8dfce214-9f4-15";
  const PARENT = "/Users/jhorn/Projects/DailyBriefDashboard";

  test("AC-5: the measured reply, verbatim — refused, and the refusal says it is a path", () => {
    const got = worktreeIdentity(WT, "hornjason/asaCommandCenter", PARENT);
    // Still a refusal. This case is NOT "make it pass" — the reading really
    // is unusable, and #218's semantics are unchanged.
    expect(got.verdict, "an unreadable origin stopped being refused — #218 is weakened").toBe(
      "unreadable",
    );
    expect(got.refusal).toContain("owner/name");
    expect(
      got.refusal,
      "the refusal does not tell the reader the value was a filesystem path, which is the whole of #872",
    ).toMatch(/filesystem path/i);
    expect(
      got.refusal,
      "the refusal does not say what the field wanted instead",
    ).toContain("git remote get-url origin");
  });

  test("AC-6: a genuinely unreadable non-path keeps the plain refusal", () => {
    // The control. If every unreadable value were described as a path, the
    // new clause would carry no information — it would be the old message
    // with more words.
    const got = worktreeIdentity(WT, "hornjason/asaCommandCenter", "not a url at all");
    expect(got.verdict).toBe("unreadable");
    expect(
      got.refusal,
      "a value that is not a path was described as one",
    ).not.toMatch(/filesystem path/i);
  });

  test("AC-7: a real remote still matches, and a foreign one still mismatches", () => {
    // "Read it ourselves" must not be able to score as "stop checking", and
    // neither may a better error message. Both directions, one fixture pair.
    expect(
      worktreeIdentity(WT, "hornjason/asaCommandCenter", "https://github.com/hornjason/asaCommandCenter.git").verdict,
    ).toBe("match");
    const foreign = worktreeIdentity(WT, "hornjason/asaCommandCenter", "https://github.com/hornjason/pai-harness.git");
    expect(foreign.verdict).toBe("mismatch");
    expect(foreign.refusal).toContain("hornjason/pai-harness");
  });

  test("AC-8: a Windows-shaped path is a path too", () => {
    const got = worktreeIdentity(WT, "hornjason/pai-harness", "C:\\Users\\j\\Projects\\thing");
    expect(got.verdict).toBe("unreadable");
    expect(got.refusal).toMatch(/filesystem path/i);
  });

  test("AC-9: a relative path is NOT called a filesystem path", () => {
    // `owner/name` is itself two segments with a slash, so a rule that
    // called anything slash-shaped a path would describe a near-miss slug as
    // a directory. Only an absolute path is claimed.
    const got = worktreeIdentity(WT, "hornjason/pai-harness", "some/relative/thing/deeper");
    expect(got.verdict).toBe("unreadable");
    expect(got.refusal).not.toMatch(/filesystem path/i);
  });
});

// ── The two copies stay one answer ───────────────────────────────────────

describe("#872: ship.js and lib agree", () => {
  test("AC-10: the measured reply gets the same refusal from both copies", () => {
    // ship.js cannot import (#69), so `worktreeIdentity` exists twice. A
    // clause added to one is a divergence, and the divergence is invisible
    // until a run hits the arm in whichever copy was missed — and the arm
    // that matters is ship.js's, because that is the one the dead run went
    // through.
    //
    // EXECUTED, not read. Two earlier drafts of this case were text:
    // `toContain("filesystem path")` per file, which the doc comment above
    // the predicate satisfies on its own (#235, a detector that cannot tell
    // code from the prose about it); then a comparison of the two clause
    // DECLARATIONS, which the battery measured at 0 red for removing
    // ship.js's USE of it. A declaration both copies carry and only one
    // consults is the same two-copy hazard with an extra step.
    const WT = "/Users/jhorn/Projects/DailyBriefDashboard/.claude/worktrees/wf_8dfce214-9f4-15";
    const PARENT = "/Users/jhorn/Projects/DailyBriefDashboard";
    const lib = worktreeIdentity(WT, "hornjason/asaCommandCenter", PARENT);
    const ship = inlined.worktreeIdentity(WT, "hornjason/asaCommandCenter", PARENT);
    expect(lib.refusal, "the lib copy stopped naming the path").toMatch(/filesystem path/i);
    expect(ship.refusal, "ship.js and lib refuse the same reply differently").toBe(lib.refusal);
    expect(ship.verdict).toBe(lib.verdict);
  });

  test("AC-11: the clause is decided by one predicate in each copy", () => {
    for (const [name, src] of [["lib", libSource], ["ship.js", shipSource]] as const) {
      const decls = (src.match(/function\s+looksLikeFilesystemPath\s*\(/g) || []).length;
      expect(decls, `${name} does not declare the predicate exactly once`).toBe(1);
    }
  });
});
