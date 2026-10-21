#!/usr/bin/env bun
/**
 * Print the census tests a change can trip — the ones the import graph cannot
 * reach (#990).
 *
 * `.claude/rules/self-referential-tests.md` carries a "What to run before you
 * push" list. It is prose, and prose routes what its author remembered. #990
 * is the measured cost: its `specs/` row names the pair that an *edit* to a
 * spec trips, and nothing names the three that a *tick* trips. A criterion
 * went `- [ ]` -> `- [x]`, every targeted suite was green locally, and CI went
 * red in `test/sc-binding-split.test.ts` — a file the change does not touch.
 *
 * ## Why this is not `scripts/select-affected-tests.ts`
 *
 * That script selects by import graph. A census test imports none of the
 * things that move it: `test/sc-binding-split.test.ts` walks `specs/`, it does
 * not import any spec. Measured on this tree at the time of writing, with
 * `specs/HARNESS-STANDARD.md` as the only changed file, `affectedTests`
 * returns MEASURED with 112 of its files selected and:
 *
 *   test/ticked-sc-cover.test.ts        selected, as a sweep
 *   test/sc-binding-split.test.ts       MISSING
 *   test/behavioral-sc-ratchet.test.ts  MISSING
 *
 * So the gap #990 reports in the prose list is also in the automated selector,
 * and for a reason the selector cannot fix: a census test's input is the shape
 * of the tree, which no edge expresses. The two are complements. This one
 * routes by what the diff DID; that one routes by what the diff IMPORTS.
 *
 * ## Why the triggers read the diff, not just the path list
 *
 * An edit to a spec and a tick inside one are the same path and different
 * events, with different blast radii. A router that sees only
 * `git diff --name-only` is definitionally unable to tell them apart, which is
 * the whole of #990. So a change here carries its added and removed lines.
 *
 * ## What this does NOT do
 *
 * It does not enforce. It prints a command; running it is still a decision,
 * and an agent that reads neither the rule nor this script is unaffected by
 * both. Refusing a push whose census tests were not in the run's measured set
 * needs a notion of "what this session ran" that does not exist here.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * One changed file, with enough of the diff to tell an edit from an event.
 *
 * `added`/`removed` hold the payload of the `+`/`-` lines without their
 * marker. A file with no textual diff (a rename, a mode change, a binary) is
 * still a change; its line arrays are simply empty, and only the triggers
 * that ask about the path will fire.
 */
export interface Change {
  /** Repo-relative, forward slashes. */
  path: string;
  /** The file does not exist on the base. */
  isNew: boolean;
  added: string[];
  removed: string[];
}

export interface CensusTrigger {
  /** Stable name, used in output and in the rule file's block. */
  id: string;
  /** The event, phrased the way the agent who caused it would describe it. */
  event: string;
  /** Repo-relative test paths. */
  tests: string[];
  fires(c: Change): boolean;
}

const isMarkdown = (p: string) => p.endsWith(".md");
const inDir = (p: string, dir: string) => p.startsWith(`${dir}/`);

/**
 * A `path.ts:123` citation, which is the only thing `#541`'s ratchet counts.
 * Deliberately narrow: a bare `foo.ts` is not a citation, and neither is a
 * version like `1.2:3`.
 */
const LINE_CITATION = /[\w./-]+\.tsx?:\d+/;

/** A criterion checkbox, ticked. The space inside `[ ]` is the discriminator. */
const TICKED_CRITERION = /^\s*[-*]\s*\[[xX]\]\s*SC-/;
const UNTICKED_CRITERION = /^\s*[-*]\s*\[ \]\s*SC-/;

/**
 * The routing table.
 *
 * Every row is one event, not one directory. Rows overlap on purpose — a new
 * rule file is a new file AND a doc AND a rule doc — because the union is what
 * you run and the per-row reasons are what make the union readable.
 */
export const CENSUS_TRIGGERS: CensusTrigger[] = [
  {
    id: "new-file",
    event: "added or renamed a file",
    tests: ["test/scaffold-conformity.test.ts", "test/package-closure.test.ts"],
    fires: c => c.isNew,
  },
  {
    id: "doc",
    event: "added a doc, or edited one containing file:line citations",
    tests: ["test/line-citation-ratchet.test.ts", "test/agents-md-refs.test.ts"],
    fires: c =>
      isMarkdown(c.path) &&
      (c.isNew || [...c.added, ...c.removed].some(l => LINE_CITATION.test(l))),
  },
  {
    // Not in the prose list before #990, and the rule file's own closing
    // section records this check catching that file on its first run. The
    // list has been missing the test that caught the list's author.
    // #1009 widened this past `.claude/rules/`: `CLAUDE.md` and `AGENTS.md`
    // are loaded at launch too, so an edit to either moves the instruction
    // surface and can put it over its budget — in a test the diff does not
    // touch, which is the whole shape of this router.
    id: "rule-doc",
    //
    // `harness-fixed-point` is here because #1009 paid for its absence: a
    // `.claude/rules/` file the scaffold generates carries a count derived
    // from a scan, so adding two documents to `reference/` made `scaffold .
    // --fix` rewrite a tracked file. Local census said green; CI did not.
    event: "added or edited CLAUDE.md, AGENTS.md or a .claude/rules/ doc",
    tests: [
      "test/rule-provenance.test.ts",
      "test/instruction-surface-budget.test.ts",
      "test/harness-fixed-point.test.ts",
    ],
    fires: c =>
      isMarkdown(c.path) &&
      (c.path.startsWith(".claude/rules/") || c.path === "CLAUDE.md" || c.path === "AGENTS.md"),
  },
  {
    id: "new-test-file",
    event: "added a test file",
    tests: ["test/sc-id-namespace.test.ts", "test/scratch-paths-unique.test.ts"],
    fires: c => c.isNew && /^test\/.*\.test\.tsx?$/.test(c.path),
  },
  {
    id: "spec-edit",
    event: "touched specs/",
    tests: ["test/agents-md-spec-listing.test.ts", "test/spec-requirements.test.ts"],
    fires: c => inDir(c.path, "specs") && isMarkdown(c.path),
  },
  {
    // #990 itself. Fires on a tick in EITHER direction: an untick lowers the
    // same three numbers, and `test/sc-binding-split.test.ts` brackets both of
    // its counts with an equality, so a fall is red there even where the
    // per-spec ratchet's `<=` stays green.
    id: "spec-tick",
    event: "ticked or unticked an SC (ran sync-sc-status)",
    tests: [
      "test/sc-binding-split.test.ts",
      "test/ticked-sc-cover.test.ts",
      "test/behavioral-sc-ratchet.test.ts",
    ],
    fires: c =>
      inDir(c.path, "specs") &&
      (c.added.some(l => TICKED_CRITERION.test(l)) ||
        c.removed.some(l => TICKED_CRITERION.test(l))),
  },
  {
    id: "gates-hooks-scaffold",
    event: "touched gates/, hooks/ or the scaffold",
    tests: [
      "test/gate-contracts.test.ts",
      "test/scaffold-ownership.test.ts",
      "test/hook-traceability.test.ts",
    ],
    fires: c => inDir(c.path, "gates") || inDir(c.path, "hooks") || inDir(c.path, "lib/scaffold"),
  },
];

export interface CensusRouting {
  /** Rows that fired, in table order, each with the paths that fired it. */
  fired: { trigger: CensusTrigger; because: string[] }[];
  /** The union of the fired rows' tests, deduplicated, in table order. */
  tests: string[];
}

/** Every test any row can emit. The rule file's block must equal this set. */
export function allCensusTests(): string[] {
  return [...new Set(CENSUS_TRIGGERS.flatMap(t => t.tests))];
}

export function censusTestsFor(changes: Change[]): CensusRouting {
  const fired: CensusRouting["fired"] = [];
  for (const trigger of CENSUS_TRIGGERS) {
    const because = changes.filter(c => trigger.fires(c)).map(c => c.path);
    if (because.length > 0) fired.push({ trigger, because });
  }
  return { fired, tests: [...new Set(fired.flatMap(f => f.trigger.tests))] };
}

/**
 * Parse `git diff -U0` output into changes.
 *
 * Only the three things a trigger asks about are read: the path, whether the
 * file is new, and the `+`/`-` payloads. `+++`/`---` headers are skipped
 * before the payload test, because `--- a/x` starts with `-` and a header
 * mistaken for a removed line would make every diff of a spec look like an
 * untick.
 */
export function parseUnifiedDiff(text: string): Change[] {
  const changes: Change[] = [];
  let cur: Change | null = null;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      cur = { path: header[2], isNew: false, added: [], removed: [] };
      changes.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.isNew = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return changes;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Everything this checkout has done to `base`: committed, staged, unstaged,
 * and untracked.
 *
 * An untracked file has no diff, so it is read from disk as all-added. That
 * matters for the only row it can fire alone — a brand new test file that has
 * not been committed yet is still a new test file.
 */
export function changesFor(root: string, base?: string): Change[] {
  const ref = base ?? git(root, ["merge-base", "HEAD", "origin/main"]).trim();
  const byPath = new Map<string, Change>();
  const absorb = (c: Change) => {
    const prev = byPath.get(c.path);
    if (!prev) return void byPath.set(c.path, c);
    prev.isNew ||= c.isNew;
    prev.added.push(...c.added);
    prev.removed.push(...c.removed);
  };

  for (const d of [
    git(root, ["diff", "-U0", "--no-color", `${ref}...HEAD`]),
    git(root, ["diff", "-U0", "--no-color", "HEAD"]),
  ]) {
    for (const c of parseUnifiedDiff(d)) absorb(c);
  }

  for (const p of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    const path = p.trim();
    if (!path) continue;
    let added: string[] = [];
    try {
      added = readFileSync(join(root, path), "utf-8").split("\n");
    } catch {
      // Unreadable or binary: the path still fires the path-only rows, which
      // is the direction that over-runs rather than under-runs.
    }
    absorb({ path, isNew: true, added, removed: [] });
  }

  return [...byPath.values()];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const root = flag("root") ?? process.cwd();

  if (argv.includes("--all")) {
    for (const t of CENSUS_TRIGGERS) {
      console.log(`${t.id.padEnd(22)}${t.event}\n${" ".repeat(22)}${t.tests.join(" ")}`);
    }
    process.exit(0);
  }

  let routing: CensusRouting;
  try {
    routing = censusTestsFor(changesFor(root, flag("base")));
  } catch (e) {
    // Loud and non-zero. A router that cannot read the diff and prints an
    // empty line reads exactly like "nothing to run", which is the fail-open
    // shape `.claude/rules/checks-must-be-able-to-fail.md` is about.
    console.error(`census-routing: could not read the diff — ${(e as Error).message.split("\n")[0]}`);
    process.exit(2);
  }

  if (routing.tests.length === 0) {
    console.error("census-routing: no census test is reachable from this change");
    process.exit(0);
  }
  // stderr, so the reasons reach the operator while stdout stays a command.
  for (const f of routing.fired) {
    console.error(`census-routing: ${f.trigger.event} — ${f.because.slice(0, 3).join(", ")}`);
  }
  console.log(`bun test ${routing.tests.join(" ")}`);
}
