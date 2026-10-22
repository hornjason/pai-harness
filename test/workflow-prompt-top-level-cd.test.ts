/**
 * #1056: no command written into a `workflows/*.js` agent prompt is one the
 * registered guard refuses.
 *
 * ## Why this is a property of the repository and not of a unit
 *
 * `hooks/TopLevelCdGuard.hook.ts` is registered at project scope and fires on
 * every `Bash` tool call made by any agent working in this repo. Prompt text
 * handed to an agent BECOMES that agent's Bash call, so a `cd` written into a
 * prompt here is a command the harness will refuse when it reaches the agent
 * that was told to run it. At the time this was filed, 50 such commands were
 * sitting in these files, dormant only because the three largest workflows had
 * been disabled since 2026-10-19 under direct-ship mode. The first run after a
 * mode switch would have hit all of them at once, in a pipeline nobody had
 * touched in the interim.
 *
 * Fixing the 50 does nothing about the 51st. This is the half that lasts.
 *
 * ## One decider, not two
 *
 * The decision is `topLevelCdRefusal` — the same binding the hook calls, not a
 * second regex that agrees with it. A second spelling here would be the
 * two-deciders-that-agree defect (`.claude/rules/checks-must-be-able-to-fail.md`,
 * the fourth shape) living inside the test for the first one: mutate the hook's
 * parser and this file would stay green over it.
 *
 * What this file DOES own is the extraction — turning a JavaScript source file
 * into the list of command strings to ask about. `candidateCommands` is
 * deliberately generous and strips only WRAPPERS, never content: indentation,
 * a markdown list marker, a `return`/`const x =`/`+` that begins a JS line, an
 * opening backtick, a `Run:` lead-in. Every one of those forms has actually
 * appeared in front of a `cd` in these files. Being generous is the safe
 * direction here for the same reason the guard itself over-refuses: a
 * candidate that is not really a command costs one rewrite, and a command the
 * extractor never built costs a refused pipeline nobody can attribute.
 *
 * ## The cheapest wrong fix, named
 *
 * `RUNGATE_CD_GUARD=off` in the workflow environment. The refusals vanish, the
 * commands stay, and the guard is disabled in exactly the pipeline that spawns
 * the most concurrent worktree-holding agents. A case that passes with the
 * guard disabled witnesses nothing — so the last test below runs the scan with
 * that variable set and shows the planted violation is still found. The mode
 * switch lives in the hook; `topLevelCdRefusal` has no mode and cannot be
 * turned off, which is why this check survives that fix for real rather than
 * vacuously.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { remedyMessage } from "../lib/check-remedy";
import { CD_GUARD_MODE_VAR, topLevelCdRefusal } from "../lib/top-level-cd";

const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_DIR = join(REPO_ROOT, "workflows");

/**
 * The command strings one source line could become once an agent reads it.
 *
 * More than one, because the wrappers nest: `   1. Run: \`cd /x && make\`` is a
 * list marker, a lead-in and a backtick deep. Each successive strip is offered
 * to the decider, and the first refusal wins.
 */
function candidateCommands(line: string): string[] {
  const out: string[] = [];
  const bare = line.replace(/^[\s>]*/, "");
  out.push(bare);

  const unlisted = bare.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  if (unlisted !== bare) out.push(unlisted);

  let s = unlisted;
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/^(?:return|const\s+[A-Za-z_$][\w$]*\s*=|\+)\s*/, "")
      .replace(/^`/, "")
      .replace(/^(?:Run|Then|Command)\s*:?\s+/i, "")
      .trimStart();
    if (next === s) break;
    s = next;
    out.push(s);
  }
  return out.filter(c => c.trim() !== "");
}

/** `<file>:<line> — <segment>` for every refusable command in a source. */
export function refusedCommands(relPath: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    for (const candidate of candidateCommands(line)) {
      const refusal = topLevelCdRefusal(candidate);
      if (!refusal) continue;
      found.push(`${relPath}:${i + 1} — ${refusal.segment.slice(0, 120)}`);
      return;
    }
  });
  return found;
}

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith(".js"))
  .sort();

describe("#1056: workflow prompts carry no command the registered guard refuses", () => {
  test("the scan has a population to be about", () => {
    // Without this, every assertion below is satisfied by a `workflows/`
    // directory the glob stopped matching.
    expect(WORKFLOW_FILES.length, "no workflow sources were scanned").toBeGreaterThan(3);
  });

  for (const file of WORKFLOW_FILES) {
    test(`workflows/${file}`, () => {
      const rel = `workflows/${file}`;
      const refused = refusedCommands(rel, readFileSync(join(WORKFLOW_DIR, file), "utf-8"));
      expect(
        refused,
        remedyMessage({
          root: REPO_ROOT,
          check: "CD-GUARD-1",
          violations: refused,
          fix:
            "a prompt command here is one hooks/TopLevelCdGuard.hook.ts refuses, so the agent " +
            "told to run it will be refused. Rewrite it, in this order of preference: " +
            "`git -C <path> <subcommand>` for anything git; an explicit path flag the command " +
            "already takes (`--project`, `--cwd`, `--prefix`, `-C`); `bun --cwd <path> <args>` " +
            "for a bun script; and only then a subshell `( cd <path> && <command> )`, which " +
            "keeps the directory dependency the other three remove. Do NOT set " +
            `${CD_GUARD_MODE_VAR}=off and do NOT widen the guard — the guard's default is ` +
            "`block` by the owner's decision in #992, made with the measurement in hand.",
        }),
      ).toEqual([]);
    });
  }
});

describe("#1056: the scan can fail, and fails on the right input", () => {
  // The population above is empty by construction after the fix, so on its own
  // it is indistinguishable from an extractor that builds no candidates and a
  // decider that never refuses. These are the inputs that separate the two.

  const PLANTED_VIOLATION = [
    "const step = await agent(`",
    "Run exactly this and report what it prints:",
    "",
    "cd ${PROJECT_ROOT} && git rev-parse HEAD",
    "`)",
  ].join("\n");

  test("a top-level cd written into a prompt IS found", () => {
    const found = refusedCommands("planted.js", PLANTED_VIOLATION);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("planted.js:4");
  });

  test("the forms the fix uses are NOT found, or the check forbids its own remedy", () => {
    // The mutant/original pair for the extraction: these four lines and the
    // planted line above differ only in HOW the directory is named, and that
    // difference is the entire property. A scan that flagged these would have
    // sent the next agent back to `cd`.
    const clean = [
      "git -C ${PROJECT_ROOT} rev-parse HEAD",
      "bun --cwd ${HARNESS_ROOT} scripts/github-op.ts issue-get --repo ${REPO}",
      "( cd ${PROJECT_ROOT} && ${testCommand} ) 2>&1 | tail -20",
      "This step used to cd into the worktree; it does not any more.",
    ].join("\n");
    expect(refusedCommands("clean.js", clean)).toEqual([]);
  });

  test("the wrappers are stripped, so a cd inside a numbered step is still a cd", () => {
    // The naive extractor — `line.startsWith("cd ")` — misses every one of
    // these, and all three shapes are real lines from the files this fixed.
    const wrapped = [
      "   1. Run: cd ${PROJECT_ROOT} && bun test",
      "  return `cd ${quote(projectRoot)} && ${testCommand}`",
      "- cd ${commitDir} && git push",
    ].join("\n");
    expect(refusedCommands("wrapped.js", wrapped)).toHaveLength(3);
  });

  test(`${CD_GUARD_MODE_VAR}=off does not make this check pass`, () => {
    // The cheapest wrong fix, run. The mode is read by the HOOK; the decider
    // this check calls has none, so disabling the guard in the pipeline leaves
    // the violation visible here. Really, not vacuously: the variable is set
    // for the duration of the scan and the planted input is unchanged.
    const previous = process.env[CD_GUARD_MODE_VAR];
    process.env[CD_GUARD_MODE_VAR] = "off";
    try {
      expect(
        refusedCommands("planted.js", PLANTED_VIOLATION),
        "turning the guard off hid the violation from the check that exists to find it",
      ).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[CD_GUARD_MODE_VAR];
      else process.env[CD_GUARD_MODE_VAR] = previous;
    }
  });
});
