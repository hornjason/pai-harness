/**
 * One fact, one decider: "is this a TypeScript project, and what type-checks it?" (#87)
 *
 * Four places answered the first question and three answered the second, and
 * they disagreed — which is the whole of #87:
 *
 * | Site | Asked | Answered |
 * |---|---|---|
 * | `createTsconfig` | is there TypeScript source? | skip the tsconfig if not |
 * | `createCiWorkflows` | is there a tsconfig? | skip the CI step if not |
 * | `generateAgentsMd` | is there a tsconfig? | skip the doc row if not |
 * | `scanProject` → `dev.typeCheck` | nothing | `bunx tsc --noEmit`, always |
 * | `runTsconfigValidation` (TSC-1) | nothing | the tsconfig MUST exist |
 *
 * So a consumer with no TypeScript source got no tsconfig from the generator
 * that decided it did not need one, no CI step and no doc row from the two
 * that agreed — and then a conformity suite that hard-failed TSC-1 over the
 * absent file, plus a `dev.typeCheck` of `bunx tsc --noEmit` written into its
 * config, which `gates/gate-executor.ts` runs. Without a tsconfig tsc prints
 * 147 lines of help text and exits 1, so that is #65/#76 reintroduced in the
 * one place #65/#76 never looked.
 *
 * THE DECISION #87 ASKED FOR
 *
 * > Either consumers are allowed to be non-TypeScript projects (then TSC-1
 * > must become conditional or a warning), or they are not (then the scaffold
 * > should generate a tsconfig and TSC-1 is right). Pick one; today both are
 * > asserted.
 *
 * Consumers ARE allowed to be non-TypeScript projects. Two generators had
 * already voted that way and shipped, and writing a tsconfig into a project
 * with no TypeScript in it produces `include: []` — tsc error TS18003, a type
 * check that reads as broken rather than as "nothing to check". So TSC-1
 * becomes conditional on the predicate `createTsconfig` already used, and the
 * conditional arm RECORDS why it did not measure instead of passing quietly:
 * `.claude/rules/config-access.md` calls the silent form out by name, and a
 * check that cannot fail is indistinguishable from a check that is satisfied.
 *
 * WHY THE COMMAND LIVES HERE TOO
 *
 * `typecheckDecision` exists because the three command sites were a worse
 * version of the same problem: they agreed on the question and still produced
 * different answers, and one of their branches was unreachable. `files:` in
 * package.json ships neither `scripts/typecheck.ts` nor `tsconfig.json`, so no
 * consumer could ever land on the ratchet branch — it was dead code that read
 * as a supported configuration. A consumer's own `package.json` `scripts.
 * typecheck` is checked first, which is the escape hatch that was missing: the
 * ratchet is reachable by any project that writes one, and a project with a
 * tsconfig full of pre-existing errors is no longer handed a CI step that can
 * only be red over a generated file it is told not to edit.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Where a consumer keeps hand-written TypeScript.
 *
 * The scanner's source directories plus `scripts/` — a consumer keeps real
 * TypeScript there and nothing else would check it.
 *
 * `test/` is deliberately absent. The conformity test rungate generates into
 * every consumer imports `bun:test` and `rungate/lib/conformity`, and neither
 * resolves for tsc without `@types/bun` and an installed `rungate` — so
 * including the test tree would hand a freshly scaffolded project a type check
 * that reports 4 errors it did not cause and cannot fix. That is the #65/#76
 * defect again in the other direction: a documented command whose result says
 * nothing about the project's code.
 */
export const TS_SOURCE_DIRS = ["src", "lib", "scripts", "gates", "hooks", "workflows"] as const;

/** True when `dir` holds at least one hand-written .ts/.tsx file. */
export function containsTypeScript(dir: string): boolean {
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The source directories that actually hold TypeScript, in TS_SOURCE_DIRS order.
 *
 * The include list and the "is this a TypeScript project" test are the same
 * question, answered once. Deriving them separately is how you get a tsconfig
 * whose include matches no files — tsc error TS18003, which reads as a broken
 * type check rather than as "nothing to check".
 */
export function typeScriptSourceDirs(root: string): string[] {
  return TS_SOURCE_DIRS.filter(dir => containsTypeScript(join(root, dir)));
}

/** True when the project has hand-written TypeScript anywhere a type check would look. */
export function isTypeScriptProject(root: string): boolean {
  return typeScriptSourceDirs(root).length > 0;
}

export interface TsconfigVerdict {
  /** Does this project need a tsconfig.json at all? */
  applicable: boolean;
  /** Is one there? */
  present: boolean;
  /** The source directories that made it applicable — empty when it is not. */
  dirs: string[];
  /** Why, in the words the finding and the failure message both use. */
  reason: string;
}

/**
 * Whether TSC-1 has anything to assert, and why.
 *
 * Never returns a bare boolean: a check that skips has to be able to say what
 * it skipped over, or its silence is indistinguishable from a pass.
 */
export function tsconfigVerdict(root: string): TsconfigVerdict {
  const dirs = typeScriptSourceDirs(root);
  const present = existsSync(join(root, "tsconfig.json"));
  const applicable = dirs.length > 0;

  if (!applicable) {
    return {
      applicable,
      present,
      dirs,
      reason:
        `NOT APPLICABLE: no hand-written TypeScript in ${TS_SOURCE_DIRS.join("/, ")}/, ` +
        `so no tsconfig.json is required and the scaffold did not write one (#87)`,
    };
  }
  if (!present) {
    return {
      applicable,
      present,
      dirs,
      reason:
        `TypeScript source in ${dirs.join("/, ")}/ and no tsconfig.json — ` +
        `\`bunx tsc --noEmit\` would print its help text and exit 1 (#65/#76). ` +
        `Run \`bunx rungate scaffold .\` to create one`,
    };
  }
  return {
    applicable,
    present,
    dirs,
    reason: `tsconfig.json is present and ${dirs.length} source director${dirs.length === 1 ? "y" : "ies"} need it`,
  };
}

/** Where the type-check command came from. `none` means there is nothing to run. */
export type TypecheckSource = "package-script" | "ratchet" | "tsc" | "none";

export interface TypecheckDecision {
  /** The shell command, or null when the project has nothing to type-check. */
  command: string | null;
  source: TypecheckSource;
  /** Why this command and not another. Carried into the generated comment. */
  reason: string;
}

/**
 * The one type-check command for a project — CI step, AGENTS.md row and
 * `dev.typeCheck` all read this.
 *
 * Order matters and each step earns its place:
 *
 * 1. **No tsconfig → no command.** Not a default, an absence. `bunx tsc
 *    --noEmit` without one prints help and exits 1, and three of the four
 *    former call sites had already learned that separately.
 * 2. **The project's own `scripts.typecheck`.** A project that has thought
 *    about its type check has said so in package.json; overriding that with a
 *    guess is the thing `scanProject` was doing wrong in the other direction.
 *    This is also what makes the ratchet form reachable at all — `files:`
 *    ships neither `scripts/typecheck.ts` nor `tsconfig.json`, so a consumer
 *    gets a ratchet only by writing one, and then only this branch sees it.
 * 3. **`scripts/typecheck.ts` on disk.** How the harness itself and anyone who
 *    copied its ratchet is served when package.json does not mention it.
 * 4. **Plain `bunx tsc --noEmit`.** Honest for a project with a clean tree.
 */
export function typecheckDecision(root: string): TypecheckDecision {
  if (!existsSync(join(root, "tsconfig.json"))) {
    return {
      command: null,
      source: "none",
      reason: "no tsconfig.json — tsc would print its help text and check nothing (#65/#76)",
    };
  }

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg?.scripts?.typecheck === "string" && pkg.scripts.typecheck.trim() !== "") {
        return {
          command: "bun run typecheck",
          source: "package-script",
          reason: "the project declares its own `typecheck` script, which beats anything inferred",
        };
      }
    } catch {
      // An unreadable package.json is not a reason to lose the type check. The
      // two branches below need no package.json at all, and `createTsconfig`'s
      // neighbours already shrug at this rather than killing the scaffold (#380).
    }
  }

  if (existsSync(join(root, "scripts", "typecheck.ts"))) {
    return {
      command: "bun scripts/typecheck.ts",
      source: "ratchet",
      reason: "the project has a ratchet script, which fails in both directions",
    };
  }

  return {
    command: "bunx tsc --noEmit",
    source: "tsc",
    reason: "a tsconfig.json exists and the project declares no type-check script of its own",
  };
}
