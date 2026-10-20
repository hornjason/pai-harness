/**
 * Does THIS project generate `PROJECT-STATE.md` from `project-state.json`?
 * (#781)
 *
 * `.claude/rules/key-files.md` is generated, and one of its rows was a
 * hardcoded literal in two places — `lib/scanner.ts` and
 * `lib/scaffold/steps.ts` — reading *"Live status + handoff (generated from
 * project-state.json — don't edit directly)"*. Every consumer got that
 * sentence, whether or not it was true of them.
 *
 * Measured on one consumer at `e58ab6bb` (named on #781): **no generator exists there.**
 * Nothing in `src/`, `scripts/`, `dashboard/src/` or the `Makefile` reads
 * `project-state.json`, and the two files carry unrelated content — the JSON
 * has priorities and sessions, the Markdown has 27 KB of page inventory, API
 * groups and architecture. An agent that reads the rule, believes it, and
 * regenerates destroys the only authoritative snapshot that repo has, and
 * **the loss presents as a success**: exit 0, `git status` showing `M`, not
 * `D`.
 *
 * ## The generator was asserting a relationship it had no way to check
 *
 * That is the part worth fixing rather than wording around. *"Generated from
 * X"* is a claim about the CONSUMER's build. The sentence that authorises the
 * destructive action was emitted unconditionally by a generator that had
 * never looked.
 *
 * So the row is now a reading. A project with something that reads
 * `project-state.json` is told the file is derived; a project with nothing
 * that reads it is told it is maintained directly; and a scan that could not
 * look at anything says so instead of defaulting to either
 * (`.claude/rules/config-access.md`, *Silent Default Substitution* — `0`,
 * `{}` and silence are indistinguishable from success).
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Soften the literal.** Replace both copies with *"Live status + handoff.
 * DA-owned."* and stop. It is one find-and-replace, it removes the
 * authorisation, and #781 lists it as option 1.
 *
 * It is wrong because it is wrong in the other direction for everybody else:
 * this repository DOES generate `PROJECT-STATE.md`, from
 * `scripts/update-project-state.ts`, and a consumer told to edit it directly
 * will have its edits overwritten on the next run. The derivation claim is
 * not false — it is *conditional*, and a fix that deletes it trades one
 * untrue sentence for another.
 *
 * The case that does not survive it is the GENERATOR_FOUND one: a fixture
 * that does read `project-state.json` must still be told the file is
 * derived. A battery with only the no-generator shape in it would have
 * certified the softening.
 *
 * ## Why the scan reports its own coverage
 *
 * #492: a scan that reports a verdict should report how much it read. An
 * empty tree and a tree with no generator produce the same `found: false`,
 * and only one of them is a measurement. `filesScanned` and `bytesScanned`
 * are both carried, and both must be non-zero — a byte count alone is
 * walked past by a single newline, which is measured in that issue.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** The one spelling of the ownership fact, so no site states it twice. */
export const PROJECT_STATE_OWNERSHIP = "DA-owned (#296)";

export const PROJECT_STATE_DERIVED =
  "Live status + handoff (generated from project-state.json — don't edit directly)";

export const PROJECT_STATE_UNDERIVED =
  `Live status + handoff. ${PROJECT_STATE_OWNERSHIP} — nothing in this project reads ` +
  "project-state.json, so this file is maintained directly and regenerating it would " +
  "destroy its contents";

export const PROJECT_STATE_UNMEASURED =
  `Live status + handoff. ${PROJECT_STATE_OWNERSHIP} — whether anything in this project ` +
  "generates it could not be determined, so do not regenerate it";

export type DerivationVerdict = "GENERATOR_FOUND" | "NO_GENERATOR" | "UNMEASURED";

export interface DerivationReading {
  verdict: DerivationVerdict;
  /** Project-relative paths that read `project-state.json`. */
  evidence: string[];
  /** How many files the walk actually opened, so a PASS can report its coverage. */
  filesScanned: number;
  /** And how much of them it read — one empty file is not a scan. */
  bytesScanned: number;
  /** Present only on UNMEASURED, and never empty when it is. */
  unmeasuredReason: string | null;
}

/**
 * Where a generator could live. Deliberately wider than the source
 * directories `scanner.ts` detects: `scripts/` and `bin/` are where this
 * repository's own updater lives, and a walk that missed them would report
 * NO_GENERATOR for the tree it is running in.
 */
const SEARCH_DIRS = ["src", "lib", "gates", "workflows", "hooks", "scripts", "bin", "dashboard/src"];
const SEARCH_FILES = ["Makefile", "package.json", "justfile", "Taskfile.yml"];

/** `.claude/` is excluded on purpose: the rule file naming the claim is not evidence for it. */
const SKIP_DIRS = new Set([".git", ".claude", "node_modules", "dist", "build", "coverage"]);

/**
 * This module is excluded from its own walk.
 *
 * #646's trap, in the form that is easiest to ship by accident: the file that
 * DECIDES whether a generator exists quotes both of the strings it looks for,
 * so without this it is evidence for itself and every project carrying a copy
 * of rungate's source reads GENERATOR_FOUND. The store quoting the subject
 * back is not a witness.
 */
const SELF = "project-state-derivation.ts";
const TEXTLIKE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|sh|bash|zsh|json|ya?ml|toml|mk)$/;

function walk(dir: string, root: string, acc: { files: string[] }, depth = 0): void {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, acc, depth + 1);
    else if (TEXTLIKE.test(e.name) && e.name !== SELF) acc.files.push(p);
  }
}

/**
 * Read the project and say whether anything in it consumes
 * `project-state.json`.
 *
 * One binding, so there is one thing to mutate and one answer. A second
 * notion of "does this project generate it" would agree on every tree anyone
 * has and diverge on the one that matters
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */
export function projectStateDerivation(root: string): DerivationReading {
  const acc = { files: [] as string[] };
  for (const d of SEARCH_DIRS) {
    const full = join(root, d);
    if (existsSync(full)) walk(full, root, acc);
  }
  for (const f of SEARCH_FILES) {
    const full = join(root, f);
    try {
      if (existsSync(full) && statSync(full).isFile()) acc.files.push(full);
    } catch {
      /* unreadable is not present */
    }
  }

  const evidence: string[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  for (const f of acc.files) {
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    filesScanned++;
    bytesScanned += text.length;
    // BOTH names, not either. A generator reads the JSON and writes the
    // Markdown, and that is the claim being made; a file that merely mentions
    // `project-state.json` — a doc lint, a gitignore check, a path constant —
    // is not one. The direction of a loose predicate matters here: a false
    // GENERATOR_FOUND is the reading that re-authorises destroying the file.
    if (text.includes("project-state.json") && text.includes("PROJECT-STATE.md")) {
      evidence.push(f.startsWith(root) ? f.slice(root.length).replace(/^[/\\]/, "") : f);
    }
  }

  if (filesScanned === 0 || bytesScanned === 0) {
    return {
      verdict: "UNMEASURED",
      evidence: [],
      filesScanned,
      bytesScanned,
      unmeasuredReason:
        filesScanned === 0
          ? "no source file in this project could be read, so nothing was searched for a " +
            "generator — which is not the same fact as there being none (#781)"
          : `${filesScanned} file(s) were walked and none had any content, so the search ` +
            "read nothing (#781)",
    };
  }

  return {
    verdict: evidence.length > 0 ? "GENERATOR_FOUND" : "NO_GENERATOR",
    evidence: evidence.sort(),
    filesScanned,
    bytesScanned,
    unmeasuredReason: null,
  };
}

/**
 * The `what` column of `key-files.md`'s PROJECT-STATE.md row.
 *
 * One binding for the three sentences, so the two generators cannot drift —
 * #781's SC-2 is exactly that: a fix applied to one hardcoded copy leaves the
 * other.
 */
export function projectStateKeyFileNote(reading: DerivationReading): string {
  switch (reading.verdict) {
    case "GENERATOR_FOUND":
      return PROJECT_STATE_DERIVED;
    case "NO_GENERATOR":
      return PROJECT_STATE_UNDERIVED;
    default:
      return PROJECT_STATE_UNMEASURED;
  }
}
