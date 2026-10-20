/**
 * Covers AC-1, AC-2, AC-3, AC-4 (#689).
 *
 * Two workflows pinned `anthropics/claude-code-action` to two different
 * commits, and both annotated the pin `# v1`:
 *
 * | File | Pin | Comment |
 * |---|---|---|
 * | `.github/workflows/ai-review.yml` (#631, unmerged) | `5eb090f3` | `# v1` |
 * | `.github/workflows/claude-review.yml` | `f27be6b6` | `# v1` |
 *
 * The comment is the only thing a reader checks, and it agreed with itself in
 * both files while naming neither commit. That is #621's shape with a comment
 * standing in for the second decider: **N positions name one thing and nothing
 * compares them.**
 *
 * ## Why every extractor refuses rather than returning nothing
 *
 * A check that reads N files and compares what it found has one characteristic
 * way to die, and it is the third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`: **finding nothing in every
 * file is perfect agreement.** Zero strings are trivially all equal, so a
 * template edit that moves a step or renames a job converts this check into a
 * ceremony without changing a line of it — and on this tree today there is
 * exactly ONE consumer, which makes that failure mode one edit away rather
 * than hypothetical.
 *
 * So `actionPinAgreement` THROWS `NoActionPinError` when the tree names the
 * action nowhere, the throw escapes the function rather than folding into an
 * empty violation list, and `actionPinParity` records it as a BLOCKING
 * UNMEASURED. UNMEASURED is not a pass.
 *
 * ## What the real v1 is, and why the issue's own resolution was wrong
 *
 * `gh api repos/anthropics/claude-code-action/git/ref/tags/v1 --jq .object.sha`
 * returns `310805dc335398c705877f09079340090470ff77`, and #689 read that as
 * the v1 commit. It is not: `v1` is an ANNOTATED tag, so `refs/tags/v1` points
 * at a tag OBJECT (`.object.type == "tag"`), and the commit is one
 * dereference further down —
 * `gh api repos/anthropics/claude-code-action/git/tags/310805dc…` →
 * `5eb090f3c3afd701a0672cd32981197ca27688f6`, which `gh api
 * repos/anthropics/claude-code-action/commits/v1` confirms. A tag object SHA
 * is not a commit and cannot be used as a `uses:` pin at all.
 *
 * So `5eb090f3` IS v1 and `f27be6b6` (v1 as of 2026-10-16, two releases back)
 * is not. The pin this tree carries is the wrong one of the two.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * **Named: edit the two SHAs so they match, and move on.** It is the 5pm
 * repair — the symptom is two lines disagreeing, and making them agree costs
 * one character. It fixes today's disagreement and leaves nothing comparing
 * them tomorrow, which is the state the issue was filed about.
 *
 * These cases survive it NON-vacuously, and the thing that makes them survive
 * is that they do not compare the workflows to EACH OTHER. They compare every
 * workflow to a single declared position, and a tree with no declaration
 * reports UNMEASURED however well its workflows agree — asserted directly by
 * `AC-4`, which plants exactly the tree that repair produces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  ACTION_PIN_DECLARATION,
  CLAUDE_CODE_ACTION,
  NoActionPinError,
  PINNED_ACTIONS,
  actionPinAgreement,
  actionPinParity,
  actionPinsNamedByWorkflow,
  declaredActionPin,
  pinnedAction,
} from "../scripts/contract-parity";
import {
  GOOGLE_AUTH_ACTION,
  GOOGLE_AUTH_ACTION_SHA,
  GOOGLE_AUTH_ACTION_VERSION,
  googleAuthActionRef,
} from "../lib/google-auth-action";
import {
  CLAUDE_CODE_ACTION as CLAUDE_CODE_ACTION_NAME,
  CLAUDE_CODE_ACTION_SHA,
  CLAUDE_CODE_ACTION_VERSION,
  claudeCodeActionRef,
} from "../lib/claude-code-action";

const REPO_ROOT = join(import.meta.dir, "..");

/** The one workflow in this tree that pins the action today. */
const ACTION_PIN_WORKFLOW = join(".github", "workflows", "claude-review.yml");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `action-pin-689-${label}-`));
  scratch.push(dir);
  return dir;
}

function put(root: string, relative: string, text: string): void {
  const dest = join(root, relative);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
}

/** A declaration module carrying a given sha and version. */
function declaration(sha: string, version: string): string {
  return [
    `export const CLAUDE_CODE_ACTION = "${CLAUDE_CODE_ACTION}";`,
    `export const CLAUDE_CODE_ACTION_SHA = "${sha}";`,
    `export const CLAUDE_CODE_ACTION_VERSION = "${version}";`,
    "",
  ].join("\n");
}

/**
 * The second registered action's declaration module (#631).
 *
 * Planted in every fixture, correct and agreeing, so that each case below
 * varies exactly ONE action. Without it the category is UNMEASURED for
 * `google-github-actions/auth` in every fixture, and a verdict asserted about
 * the review action would be reading the auth action's absence instead —
 * #585's pair discipline, applied to a category that now has two subjects.
 */
function authDeclaration(): string {
  return [
    `export const GOOGLE_AUTH_ACTION = "${GOOGLE_AUTH_ACTION}";`,
    `export const GOOGLE_AUTH_ACTION_SHA = "${GOOGLE_AUTH_ACTION_SHA}";`,
    `export const GOOGLE_AUTH_ACTION_VERSION = "${GOOGLE_AUTH_ACTION_VERSION}";`,
    "",
  ].join("\n");
}

/** A workflow whose review step pins the action at `ref` (sha plus comment). */
function reviewWorkflow(ref: string): string {
  return [
    "name: demo",
    "on: [pull_request]",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    "      - name: Authenticate",
    `        uses: ${googleAuthActionRef()}`,
    "      - name: Review",
    `        uses: ${ref}`,
    "        with:",
    '          github_token: "x"',
    "",
  ].join("\n");
}

const A = "5eb090f3c3afd701a0672cd32981197ca27688f6";
const B = "f27be6b65a4652f08a2ba3cff79114829b588967";

/** A tree declaring `sha`/`version` and pinning each named workflow at `ref`. */
function plantedTree(
  label: string,
  opts: { declare?: { sha: string; version: string } | null; workflows: Record<string, string> },
): string {
  const root = scratchDir(label);
  put(root, pinnedAction(GOOGLE_AUTH_ACTION).declaration, authDeclaration());
  if (opts.declare !== null) {
    const d = opts.declare ?? { sha: A, version: "v1" };
    put(root, ACTION_PIN_DECLARATION, declaration(d.sha, d.version));
  }
  for (const [name, ref] of Object.entries(opts.workflows)) {
    put(root, join(".github", "workflows", name), reviewWorkflow(ref));
  }
  return root;
}

const pinned = (sha: string, version = "v1") => `${CLAUDE_CODE_ACTION}@${sha} # ${version}`;

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("#689 AC-1: one declaration, and every workflow resolves to it", () => {
  test("AC-1: every claude-code-action pin in this tree resolves to the one declaration", () => {
    const reading = actionPinParity(REPO_ROOT);

    // Coverage first, and it is not a formality. Zero pins are trivially all
    // equal, so a verdict taken over an empty reading is the defect this file
    // exists to stop — and with one consumer in the tree, "zero" is one
    // renamed step away.
    expect(reading.coverage.examined, `nothing was read:\n${JSON.stringify(reading, null, 2)}`).toBeGreaterThan(1);
    const { pins, declared } = actionPinAgreement(REPO_ROOT);
    expect(pins.length, "no workflow in this tree names the action").toBeGreaterThan(0);
    expect(declared.sha).toBe(CLAUDE_CODE_ACTION_SHA);

    expect(
      reading.verdict,
      `${reading.violations.join("; ")} | ${reading.unmeasured.map(u => u.reason).join("; ")}`,
    ).toBe("PASS");
    expect(reading.violations).toEqual([]);
  });

  test("AC-1: the declared pin is the real v1 commit, not the annotated tag object", () => {
    /**
     * `5eb090f3` is what `refs/tags/v1` dereferences TO. `310805dc` is the tag
     * object `refs/tags/v1` IS, which #689 read as the answer — it is not a
     * commit, so it cannot be a `uses:` pin at all. Pinned here so a future
     * bump cannot silently reintroduce the tag-object reading.
     */
    expect(CLAUDE_CODE_ACTION_SHA).toBe(A);
    expect(CLAUDE_CODE_ACTION_SHA).not.toBe("310805dc335398c705877f09079340090470ff77");
    expect(CLAUDE_CODE_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    // …and the superseded pin is gone from the tree, which is the defect
    // itself rather than a property of it.
    const { pins } = actionPinAgreement(REPO_ROOT);
    expect(pins.map(p => p.sha)).not.toContain(B);
  });

  test("AC-1: the parser and the exported constant are the same answer", () => {
    /**
     * The check parses `lib/claude-code-action.ts` as TEXT, because a planted
     * root is a different tree and cannot be imported. That is a second
     * reading of one fact, so it is bound here rather than left to agree by
     * habit: a parser that drifted from the module would report a
     * disagreement the module does not have, or miss one it does.
     */
    const declared = declaredActionPin(REPO_ROOT);
    expect(declared.sha).toBe(CLAUDE_CODE_ACTION_SHA);
    expect(declared.version).toBe(CLAUDE_CODE_ACTION_VERSION);
    expect(declared.action).toBe(CLAUDE_CODE_ACTION_NAME);
    expect(claudeCodeActionRef()).toBe(pinned(CLAUDE_CODE_ACTION_SHA, CLAUDE_CODE_ACTION_VERSION));
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("#689 AC-2: the version comment is derived from the pin, not asserted beside it", () => {
  test("AC-2: a `# vN` that disagrees with the declaration is a violation on its own", () => {
    // The SHA agrees. Only the comment differs, so this is a measurement of
    // the comment and of nothing else (#585: vary exactly one reading).
    const agreeing = plantedTree("comment-agrees", { workflows: { "a.yml": pinned(A, "v1") } });
    const disagreeing = plantedTree("comment-disagrees", { workflows: { "a.yml": pinned(A, "v2") } });

    expect(actionPinParity(agreeing).verdict).toBe("PASS");

    const red = actionPinParity(disagreeing);
    expect(red.verdict, JSON.stringify(red, null, 2)).toBe("FAIL");
    expect(red.violations.join("\n")).toContain("v2");
    expect(red.violations.join("\n")).toContain(".github/workflows/a.yml");
  });

  test("AC-2: a pin carrying no comment at all is accepted; a wrong one is not", () => {
    /**
     * "Either derived from the SHA or removed" — both halves. A comment that
     * can disagree with the pin it annotates is worse than no comment, so an
     * absent one is not a violation and a wrong one is. Without this pair the
     * rule would be satisfiable by deleting every comment and by nothing else.
     */
    const bare = plantedTree("comment-absent", { workflows: { "a.yml": `${CLAUDE_CODE_ACTION}@${A}` } });
    expect(actionPinParity(bare).verdict, JSON.stringify(actionPinParity(bare).violations)).toBe("PASS");

    const wrong = plantedTree("comment-wrong", { workflows: { "a.yml": pinned(A, "v1.2.3") } });
    expect(actionPinParity(wrong).verdict).toBe("FAIL");
  });

  test("AC-2: a movable tag where a SHA belongs is a violation, not a pin", () => {
    // `@v1` is the publisher's to repoint. It also cannot equal the declared
    // SHA, so it must not be reported as an unreadable position.
    const tagged = plantedTree("tag-ref", { workflows: { "a.yml": `${CLAUDE_CODE_ACTION}@v1 # v1` } });
    const reading = actionPinParity(tagged);
    expect(reading.verdict).toBe("FAIL");
    expect(reading.violations.join("\n")).toContain("not a commit SHA");
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe("#689 AC-3: a workflow that disagrees with the declaration turns the check red", () => {
  test("AC-3: two workflows pinning two SHAs is reported, naming both files and both pins", () => {
    // The defect verbatim: two files, two commits, both commented `# v1`.
    const split = plantedTree("two-shas", {
      workflows: { "ai-review.yml": pinned(A, "v1"), "claude-review.yml": pinned(B, "v1") },
    });
    const reading = actionPinParity(split);

    expect(reading.verdict).toBe("FAIL");
    const text = reading.violations.join("\n");
    expect(text).toContain(B);
    expect(text).toContain("claude-review.yml");

    // …and the same two files pinning the declared SHA are clean, so the red
    // above is the plant and not the planting.
    const agreed = plantedTree("two-shas-agreed", {
      workflows: { "ai-review.yml": pinned(A, "v1"), "claude-review.yml": pinned(A, "v1") },
    });
    expect(actionPinParity(agreed).verdict, JSON.stringify(actionPinParity(agreed).violations)).toBe("PASS");
  });

  test("AC-3: a generator that hardcodes its own SHA is caught, and routing it clears the violation", () => {
    /**
     * #622c: a fix that edits only the checked-in workflows leaves every
     * scaffolded consumer on whatever the generator emits. The workflows are
     * YAML and cannot import, so the generator is the only position that can
     * carry a second literal — and it is exactly where #631 will put one.
     */
    const root = plantedTree("generator-literal", { workflows: { "a.yml": pinned(A, "v1") } });
    put(root, join("lib", "scaffold", "ai-review-step.ts"), `const step = \`uses: ${CLAUDE_CODE_ACTION}@${B} # v1\`;\n`);

    const red = actionPinParity(root);
    expect(red.verdict, JSON.stringify(red.sites)).toBe("FAIL");
    expect(red.violations.join("\n")).toContain("lib/scaffold/ai-review-step.ts");

    put(
      root,
      join("lib", "scaffold", "ai-review-step.ts"),
      `import { claudeCodeActionRef } from "../claude-code-action";\nconst step = \`uses: \${claudeCodeActionRef()}\`;\n`,
    );
    const green = actionPinParity(root);
    expect(green.verdict, green.violations.join("; ")).toBe("PASS");
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe("#689 AC-4: finding nothing is not agreement, and matching by hand is not a binding", () => {
  test("AC-4: the cheapest wrong fix — two SHAs matched by hand, nothing comparing them", () => {
    /**
     * The tree the 5pm repair produces: both workflows agree, perfectly, and
     * no position declares what they are supposed to agree WITH. A check that
     * compared the workflows to each other would be green here, which is the
     * fifth shape — a case that certifies the regression it was written to
     * block.
     */
    const matchedByHand = plantedTree("cheap-fix", {
      declare: null,
      workflows: { "ai-review.yml": pinned(A, "v1"), "claude-review.yml": pinned(A, "v1") },
    });

    const reading = actionPinParity(matchedByHand);
    expect(reading.verdict, JSON.stringify(reading, null, 2)).toBe("UNMEASURED");
    expect(reading.unmeasured.map(u => u.kind)).toContain("absent-file");
    expect(reading.unmeasured.map(u => u.reason).join("\n")).toContain(ACTION_PIN_DECLARATION);
    // Not a FAIL: the workflows really do agree. The reading is that nobody
    // can say whether they agree with the right thing.
    expect(reading.violations).toEqual([]);
    // …and the identical tree WITH the declaration is PASS, so the UNMEASURED
    // above is the missing binding and not the fixture.
    const bound = plantedTree("cheap-fix-bound", {
      workflows: { "ai-review.yml": pinned(A, "v1"), "claude-review.yml": pinned(A, "v1") },
    });
    expect(actionPinParity(bound).verdict).toBe("PASS");
  });

  test("AC-4: a tree whose workflows name the action nowhere REFUSES", () => {
    /**
     * The characteristic death. `.github/workflows/` exists and is full of
     * perfectly good YAML; the step this check is about has been renamed,
     * moved, or replaced. Zero pins are all equal to each other and to the
     * declaration, and a check that returns an empty violation list here has
     * become a ceremony.
     */
    const renamed = scratchDir("no-pins");
    put(renamed, ACTION_PIN_DECLARATION, declaration(A, "v1"));
    put(renamed, join(".github", "workflows", "ci.yml"), "name: CI\njobs:\n  test:\n    steps:\n      - run: bun test\n");

    // The refusal escapes the comparison rather than folding into a verdict.
    expect(() => actionPinAgreement(renamed)).toThrow(NoActionPinError);
    const reading = actionPinParity(renamed);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.violations).toEqual([]);
    expect(reading.unmeasured.some(u => u.blocking)).toBe(true);
    expect(reading.unmeasured.map(u => u.reason).join("\n")).toContain(CLAUDE_CODE_ACTION);
  });

  test("AC-4: an absent workflow directory and an unreadable declaration stay distinct kinds", () => {
    // A corrupt declaration is never a missing one
    // (`.claude/rules/config-access.md`), and neither is a tree with no
    // workflows at all.
    const noWorkflows = scratchDir("no-workflows");
    put(noWorkflows, ACTION_PIN_DECLARATION, declaration(A, "v1"));
    const absent = actionPinParity(noWorkflows);
    expect(absent.verdict).toBe("UNMEASURED");
    expect(absent.unmeasured.map(u => u.kind)).toContain("absent-file");

    const corrupt = scratchDir("corrupt-declaration");
    put(corrupt, ACTION_PIN_DECLARATION, "export const CLAUDE_CODE_ACTION_SHA = computeIt();\n");
    // The SECOND registered action's declaration is planted and correct, so
    // the only unreadable position is the one this case is about. Without it
    // the fixture also carries an `absent-file`, and the assertion that the
    // two kinds stay distinct would be satisfied by the wrong file.
    put(corrupt, pinnedAction(GOOGLE_AUTH_ACTION).declaration, authDeclaration());
    put(corrupt, join(".github", "workflows", "a.yml"), reviewWorkflow(pinned(A, "v1")));
    const unreadable = actionPinParity(corrupt);
    expect(unreadable.verdict).toBe("UNMEASURED");
    expect(unreadable.unmeasured.map(u => u.kind)).toContain("unparseable-file");
    expect(unreadable.unmeasured.map(u => u.kind)).not.toContain("absent-file");
    // The workflow WAS read — so the refusal is the declaration's, and this
    // case is not being carried by the empty-reading guard.
    expect(unreadable.coverage.examined).toBeGreaterThan(0);
    expect(() => declaredActionPin(corrupt)).toThrow();
  });

  test("AC-4: the per-file extractor reads the line, the comment and the position", () => {
    // The instrument. Every case above is a claim about what this returned.
    const found = actionPinsNamedByWorkflow(readFileSync(join(REPO_ROOT, ACTION_PIN_WORKFLOW), "utf-8"), ACTION_PIN_WORKFLOW);
    expect(found.length).toBe(1);
    expect(found[0].sha).toBe(CLAUDE_CODE_ACTION_SHA);
    expect(found[0].comment).toBe(CLAUDE_CODE_ACTION_VERSION);
    expect(found[0].line).toBeGreaterThan(0);

    // A file that names the action in prose is not a pin — a commented-out
    // step and a sentence about the action must not be read as positions.
    expect(actionPinsNamedByWorkflow(`# we use ${CLAUDE_CODE_ACTION}@v1 one day\n`, "x.yml")).toEqual([]);
  });
});
