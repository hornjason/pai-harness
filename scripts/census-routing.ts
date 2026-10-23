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

import { TRACKED_ID_PREFIX_SOURCE } from "../lib/sc-ids";

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
  /**
   * New-side hunk positions, 1-based, as `@@ -a,b +start,lines @@` gives
   * them. No census trigger reads these — `lib/text-dependents.ts` (#1054)
   * does, to say whether a change landed inside a region some other file
   * lifts. They ride along here rather than in a second `git diff` because
   * two readings of the same diff are two things that can disagree.
   */
  hunks: { start: number; lines: number }[];
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

/**
 * A criterion checkbox, ticked. The space inside `[ ]` is the discriminator.
 *
 * The PREFIX comes from `TRACKED_ID_PREFIX_SOURCE` and is not respelled here.
 * It used to be a hand-written `SC-`, and #1298 added a second tracked
 * namespace — `CRC-A1`..`CRC-N5` in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` —
 * which this row could not see. Ticking one of those routed the spec-edit
 * pair and nothing else, while moving `UNCLAIMED_RATCHET` and
 * `CLAIMED_UNBINDABLE` in `test/sc-binding-split.test.ts` and the per-spec
 * census in `test/ticked-sc-cover.test.ts`, all three of which this row
 * exists to route. That is #990 exactly — the same event, in the same file,
 * invisible to the same router — one namespace later, and it was found by
 * running this script on the first diff that ticked a `CRC-` id.
 *
 * `lib/sc-ids.ts` says the list is the only thing that decides what a tracked
 * criterion id is. A reader that respells it is a reader that decides again.
 */
const TICKED_CRITERION = new RegExp(`^\\s*[-*]\\s*\\[[xX]\\]\\s*${TRACKED_ID_PREFIX_SOURCE}-`);
const UNTICKED_CRITERION = new RegExp(`^\\s*[-*]\\s*\\[ \\]\\s*${TRACKED_ID_PREFIX_SOURCE}-`);

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
    // #1306. ADDING a spec is a third event, and it reddens census files that
    // neither an edit nor a tick can touch: `audit-specs` refuses a testable
    // spec without `compliance: strict`, and `scanner`'s live-tree case holds
    // `.claude/rules/docs-routing.md`'s `specs/ (N files)` row to a recursive
    // count. PR #1298 paid a CI round for the first; neither is reachable
    // from the import graph, and the spec it names imports nothing.
    //
    // Measured rather than grepped: a probe spec was planted and the 143 test
    // files whose source names `specs` were run against a 0-fail baseline.
    // Five went red. Three were already routed — `scaffold-conformity` by
    // `new-file`, `agents-md-spec-listing` by `spec-edit`, and
    // `spec-drift.test.ts`, whose whole body is the same `runSpecDrift(ROOT)`
    // call `scaffold-conformity` already makes, so routing it would run one
    // check twice. These two were routed by nothing, and cost 1.3s together.
    //
    // Scoped to `isNew` on purpose. On the `spec-edit` row these would run on
    // every prose edit to every spec, and a router that names more than it
    // has to is a router people stop running — which is the state #990 is
    // about, arriving from the other side.
    id: "new-spec",
    event: "added a specs/ file",
    tests: ["test/audit-specs.test.ts", "test/scanner.test.ts"],
    fires: c => c.isNew && inDir(c.path, "specs") && isMarkdown(c.path),
  },
  {
    // #990 itself. Fires on a tick in EITHER direction: an untick lowers the
    // same three numbers, and `test/sc-binding-split.test.ts` brackets both of
    // its counts with an equality, so a fall is red there even where the
    // per-spec ratchet's `<=` stays green.
    id: "spec-tick",
    event: "ticked or unticked an SC (ran sync-sc-status)",
    //
    // `ticked-sc-absent-symbol` joined in #1161, and it is the row's most
    // literal member: it refuses a tick naming a symbol the tree does not
    // contain, which is an event only a spec edit can cause, in a file the
    // spec edit does not touch.
    tests: [
      "test/sc-binding-split.test.ts",
      "test/ticked-sc-cover.test.ts",
      "test/behavioral-sc-ratchet.test.ts",
      "test/ticked-sc-absent-symbol.test.ts",
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
  {
    // #1368. The row above routes the OWNERSHIP family — which files the
    // scaffold owns, which gates exist, which hooks are traceable. Nothing
    // routed to the suites that read the committed workflow and assert
    // properties of its TEXT, and those are the self-referential shape this
    // whole table exists for: they go red on a change in a file they do not
    // name, for a reason the diff does not contain.
    //
    // Paid for on PR #1351. Shard 3 went red on `AC-2 (#1116)` in
    // `ai-review-runner-shell-parity` — two new `rf=$(...)` assignments were
    // #1110's shape — after every suite this router named came back green.
    // The guard is unreachable from the diff by any route an agent takes:
    // not the source file's own suite, not the ownership family, and its
    // name shares no string with anything that changed.
    //
    // Fires on BOTH halves on purpose. The two usually move together, but an
    // edit to `lib/scaffold/**` without a re-scaffold, and a hand edit to a
    // workflow with no source change, are each a real event — and the second
    // fired no row at all before this one existed.
    id: "generated-workflow",
    event: "changed a generated workflow, or the scaffold source that emits one",
    tests: [
      "test/ai-review-runner-shell-parity.test.ts",
      "test/action-pin-parity.test.ts",
      "test/scaffold-permissions-merge.test.ts",
    ],
    fires: c => inDir(c.path, ".github/workflows") || inDir(c.path, "lib/scaffold"),
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
      cur = { path: header[2], isNew: false, added: [], removed: [], hunks: [] };
      changes.push(cur);
      continue;
    }
    if (!cur) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      cur.hunks.push({ start: Number(hunk[1]), lines: hunk[2] === undefined ? 1 : Number(hunk[2]) });
      continue;
    }
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
    prev.hunks.push(...c.hunks);
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
    // An untracked file has no diff, so every line of it is new: one hunk
    // covering the whole file. Dropping `hunks` here instead would make an
    // untracked file indistinguishable from a diff whose hunks were not read.
    absorb({
      path,
      isNew: true,
      added,
      removed: [],
      hunks: added.length > 0 ? [{ start: 1, lines: added.length }] : [],
    });
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
