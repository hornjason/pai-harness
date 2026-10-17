/**
 * The one test command for a project (#488).
 *
 * The scaffold read `dev.testCmd` in four places and wrote it into
 * everything an agent reads — AGENTS.md's Commands table, the agent briefs,
 * the ship workflow — and then generated a CI workflow that ran `bun test`
 * regardless. `createCiWorkflows` had `harness` in scope and reached for
 * `harness?.ci?.bunVersion`, `?.runner` and `?.branches` four lines above
 * the hardcode.
 *
 * The divergence is silent in both directions. If the consumer's command is
 * a superset, CI is weaker than the gate every agent was told about. If
 * `bun test` does not work in their project at all, CI is red for a reason
 * no config change can fix, because the field that would fix it is not
 * read.
 *
 * ## Why this is a module and not four `||` chains that agree
 *
 * They did not agree. Four sites resolved the same question four ways:
 *
 * | Site | Ladder |
 * |---|---|
 * | `createCiWorkflows` | `"bun test"` |
 * | `generateAgentsMdContent` | `dev.testCmd \|\| "bun test"` |
 * | `scanProject` | `package.json scripts.test \|\| "bun test"` |
 * | `generateAgentBriefs` | `dev.testCmd \|\| scan.testCmd \|\| "bun test"` |
 *
 * So a consumer with a `scripts.test` and no `dev.testCmd` was told one
 * command by AGENTS.md and another by CI, and two sites that happen to
 * agree today are one decider too many — only a mutation of a SHARED
 * binding can show that the agreement is load-bearing rather than
 * coincidental. This is #87's fix for the type check, applied to the step
 * directly below the one #87 collapsed.
 *
 * ## The rungs, and what each one is not
 *
 * 1. **`dev.testCmd` from the rungate config.** The operator said so, in
 *    the field the harness documents for exactly this.
 * 2. **`package.json` `scripts.test`, verbatim.** The value, not `bun run
 *    test`. That is the existing behaviour of `scanProject`, so this rung
 *    is a collapse rather than a new judgement — and `bun run test` would
 *    fire `pretest`/`posttest`, which on this repo means CI running
 *    `sync-sc-status.ts` and writing to the tree.
 * 3. **`bun test`.** Unchanged for every consumer that declares neither.
 *
 * ## What this does NOT cover
 *
 * `workflows/ship.js` resolves `test.command || dev.testCmd || 'bun test'`
 * and cannot import (#69). It is the fifth site and it stays its own, which
 * is a known gap rather than an oversight — the subprocess boundary is how
 * workflows comply with `.claude/rules/config-access.md`.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tryLoadRungateConfig } from "./config-loader";

export type TestCommandSource = "config" | "package-script" | "default";

export interface TestCommandDecision {
  /** The shell command. Never null — every project can run something. */
  command: string;
  source: TestCommandSource;
  /** Why this command and not another. */
  reason: string;
}

export const DEFAULT_TEST_COMMAND = "bun test";

export function testCommandDecision(root: string): TestCommandDecision {
  // Through the loader, never a constructed path to `.claude/rungate*`
  // (`.claude/rules/config-access.md`). It also means both config layouts
  // are honoured — a consumer who followed the documented migration to the
  // directory form is the exact population a monolith-only read loses.
  //
  // It THROWS on a malformed config, deliberately: a corrupt config is
  // never a missing config, and `catch {}` here is the conversion that rule
  // exists to forbid. The one caller that must survive corruption is the
  // config REPAIR step, and it calls `inferredTestCommand` instead — see
  // below for why that is not a loophole.
  const config = tryLoadRungateConfig(root) as { dev?: { testCmd?: unknown } } | null;
  const declared = config?.dev?.testCmd;
  if (typeof declared === "string" && declared.trim() !== "") {
    return {
      command: declared,
      source: "config",
      reason: "the project declares `dev.testCmd`, which beats anything inferred",
    };
  }

  return inferredTestCommand(root);
}

/**
 * The same decision with the config rung removed — what this project's test
 * command would be if the config said nothing.
 *
 * Exactly one caller, and it is not a convenience: `generateOrAuditProjectHarness`
 * chooses the value to WRITE into `dev.testCmd`, so asking the loader for
 * `dev.testCmd` first is circular, and it runs against trees whose config is
 * malformed — that is what it exists to repair. Routing it through the
 * throwing loader killed the repair with `SyntaxError: JSON Parse error` in
 * the step whose job is to fix that file.
 *
 * Split rather than flagged, because a boolean parameter makes the two
 * behaviours one call site's argument rather than two named things, and the
 * shared rungs stay shared either way.
 */
export function inferredTestCommand(root: string): TestCommandDecision {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const script = pkg?.scripts?.test;
      if (typeof script === "string" && script.trim() !== "") {
        return {
          command: script,
          source: "package-script",
          reason: "the project declares a `test` script and no `dev.testCmd`",
        };
      }
    } catch {
      // An unreadable package.json is not a reason to lose the test command.
      // The default below needs no package.json at all, and this module's
      // neighbours already shrug at this rather than killing the scaffold.
    }
  }

  return {
    command: DEFAULT_TEST_COMMAND,
    source: "default",
    reason: "the project declares neither `dev.testCmd` nor a `test` script",
  };
}
