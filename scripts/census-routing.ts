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
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { LINE_CITATION } from "../lib/line-citation";
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
  /** Repo-relative test paths. Empty on a row that derives its targets. */
  tests: string[];
  fires(c: Change): boolean;
  /**
   * Targets resolved against the TREE rather than written down (#1442).
   *
   * A fixed list is wrong for a per-document suite: the pair
   * `specs/<NAME>.md` / `test/<name>.test.ts` is a convention, and a literal
   * row would be wrong the moment a spec gains a suite or a suite is
   * renamed. `exists` is injected rather than read here so the convention is
   * one expression with one reading of the filesystem behind it.
   *
   * **An empty return means the row does not fire for that change at all** —
   * see `censusTestsFor`. A row that fired with no target would read exactly
   * like a spec whose suite was renamed away, and those are different facts.
   */
  derive?(c: Change, exists: (path: string) => boolean): string[];
  /**
   * The rule file's table cell for a derived row, since there is no path
   * list to render. It must spell no concrete test path: the document's
   * section is compared to `allCensusTests()`, a derived row contributes
   * nothing to that set, and a concrete path in this prose would read as a
   * routed test. `test/census-routing.test.ts` asserts it.
   */
  derivedTarget?: string;
}

const isMarkdown = (p: string) => p.endsWith(".md");
const inDir = (p: string, dir: string) => p.startsWith(`${dir}/`);

/**
 * The DA-owned session state (#296, #1515), at the repo root and nowhere
 * else.
 *
 * These are a single shared state document: `project-state.json` is the
 * source, `PROJECT-STATE.md` is rendered from it, and `SUCCESS.md`'s standing
 * table moves in the same edit. They are listed here rather than inline so
 * the row's predicate and the test's membership guard read one binding.
 */
export const DA_OWNED_STATE = ["project-state.json", "PROJECT-STATE.md", "SUCCESS.md"];

/**
 * What `#541`'s ratchet counts as a line citation — asked of the ratchet's
 * own binding rather than respelled here.
 *
 * It used to be a hand-written `/[\w./-]+\.tsx?:\d+/`, which is a second
 * spelling of `lib/line-citation.ts`'s `LINE_CITATION`, and the two
 * disagreed in both directions: `.js` and `.json` citations are counted by
 * the ratchet and were invisible here, and a `.tsx:12` is matched here and
 * counted by nothing. PR #1466 rewrote `PROJECT-STATE.md` and removed
 * `ship.js:2931` and `workflows/ship.js:1705` — both `.js` — so this row
 * stayed silent and CI went red on `NoLineCitationsError` for a banked
 * document that now yielded none. One round, on a docs-only change (#1442).
 *
 * `LINE_CITATION` is global, and `.test()` on a `/g` regex carries
 * `lastIndex` between calls, so the source is recompiled without the flag:
 * a stateful reader would skip every other line.
 */
const LINE_CITATION_LINE = new RegExp(LINE_CITATION.source);

/**
 * The suite named after a spec document, whether or not it exists.
 *
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` -> `test/code-review-convergence-spec.test.ts`.
 * Nested specs collapse to their basename, which is the convention the tree
 * already follows. Exported so there is ONE expression of the convention;
 * a second one would survive any mutation of the first.
 */
export function ownSpecTestPath(specPath: string): string {
  const base = specPath.slice(specPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return `test/${base.toLowerCase()}.test.ts`;
}

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
      (c.isNew || [...c.added, ...c.removed].some(l => LINE_CITATION_LINE.test(l))),
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
    // #1442. The three rows above route the same fixed set for an edit, a
    // tick and an add, and none of them routes the suite whose entire
    // subject is the document that changed.
    //
    // Measured twice, four days apart, on two branches: #1439 ticked `CRC-E4`
    // and #1450 ticked `CRC-M11` in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`,
    // each left the criterion in the not-done bucket, each ran the six suites
    // this router printed, each was green locally, and each went red in CI on
    // `test/code-review-convergence-spec.test.ts` — *"criteria in TWO
    // buckets"*. A tick and a bucket entry are the SAME edit for any spec
    // that keeps a per-criterion remainder list, so the gap is not random:
    // this router was reliably silent on exactly the follow-on a tick
    // creates.
    //
    // DERIVED rather than literal, because the population moves. One pair
    // resolves on this tree and it is the pair that cost the two rounds.
    //
    // The obvious widening — also accept the name with a trailing `-spec`
    // removed — was measured and REJECTED. It adds four candidates, and
    // `test/gate-contracts.test.ts`, `test/instruction-compliance.test.ts`
    // and `test/scaffold-decomposition.test.ts` contain their spec's
    // filename zero times and open no spec document at all; they read
    // `gates/`, `lib/compliance.ts` and `scripts/scaffold-project.ts`. An
    // edit to the spec cannot redden any of them. The fourth,
    // `test/agent-brief-template.test.ts`, names its spec once, in a
    // `describe` title. Routing four suites a spec edit cannot redden is the
    // thing the `new-spec` row above is scoped to avoid.
    id: "spec-own-test",
    event: "touched a specs/ file that has a suite named after it",
    tests: [],
    // Kept short on purpose: this cell is rendered into an always-loaded
    // rule file, whose peak surface sits inside 400 bytes of its budget.
    derivedTarget: "the suite named after it: `test/` + its basename lowercased + `.test.ts`",
    derive: (c, exists) => [ownSpecTestPath(c.path)].filter(exists),
    fires: c => inDir(c.path, "specs") && isMarkdown(c.path),
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
    // #1401 added the last two, and the membership rule is worth stating
    // because three attempts to DERIVE it all failed and the measurements
    // are the reason this list is still hand-kept:
    //
    //   - suites that CO-CHANGE with `lib/scaffold/**`, over 202 such
    //     commits: `ai-review-wif` scores 2 and `no-fixed-window-slices`
    //     scores 0. Both are known catchers. Co-change finds the suites an
    //     author edited, and these two catch by going red UNTOUCHED, which
    //     is the opposite population.
    //   - suites that READ the generated YAML or import a scaffold builder:
    //     138 of 588 test files. Routing 138 is routing everything, and it
    //     still misses `no-fixed-window-slices`, which reads neither.
    //   - suites named beside a redness word in the commit messages of those
    //     202 commits: 13, and neither of the two. The catches were reported
    //     in a rebase, not written down here.
    //
    // So a suite joins this row on EVIDENCE OF A CATCH, recorded inline.
    // Nothing derivable from the tree reproduces the list, and all three
    // instruments above have a control that fails — which is why none of
    // them is wired up as a check.
    //
    // `ai-review-wif` (#1387, reported by rg-crc-bind): a comment written
    // INSIDE the generated bash, explaining that the PR title and body are
    // never interpolated, spelled the interpolation construct literally. A
    // shell `#` does not hide it — the runner substitutes over the whole
    // `run:` body, comments included. Strictly wider than the author's own
    // AC-S8a, which greps for `github.event.pull_request.body` and
    // structurally could not have seen it.
    //
    // `no-fixed-window-slices` (#1387, same report): an assertion used
    // `yml.slice(at - 400, at + 400)` around an annotation. #664's guard was
    // right twice over — the fixed window runs off the end of the construct,
    // and it read only the first occurrence while the generator emits three.
    //
    // Both landed on shard 4 and both survived a targeted run of every suite
    // this file named at the time.
    id: "generated-workflow",
    event: "changed a generated workflow, or the scaffold source that emits one",
    tests: [
      "test/ai-review-runner-shell-parity.test.ts",
      "test/action-pin-parity.test.ts",
      "test/scaffold-permissions-merge.test.ts",
      "test/ai-review-wif.test.ts",
      "test/no-fixed-window-slices.test.ts",
    ],
    fires: c => inDir(c.path, ".github/workflows") || inDir(c.path, "lib/scaffold"),
  },
  {
    // #1515. The three files with the NARROWEST set of people who may edit
    // them — DA-owned (#296), and an agent in a worktree is forbidden to
    // write them — matched no row at all. `new-file` needs `isNew`; `doc`
    // needs `isNew` or a line citation, and a session summary has neither;
    // `rule-doc` is scoped to `CLAUDE.md`, `AGENTS.md` and `.claude/rules/`;
    // and `project-state.json` is not markdown, so nothing could see it.
    //
    // Measured on commit `9a174688`, a state write touching
    // `project-state.json` and `PROJECT-STATE.md` and nothing else: the
    // router printed `no census test is reachable from this change`, and
    // `test/closing-keywords.test.ts` went red on `#590` — *"no closing
    // keyword at all was found in the live summary"* — reading the live
    // `project-state.json` the diff had just rewritten. The same suite is
    // green at `009562dc`, the merged write with the keyword restored. So
    // `no census test is reachable` and UNMEASURED were the same output,
    // which is the `0`/`{}`/`null` reading this project refuses everywhere
    // else.
    //
    // FIXED rather than derived, and all three derivations are written up in
    // `test/census-routing.test.ts` with their counts. The short version:
    // naming the paths gives 68 test files, the issue's hand list of nine is
    // wrong in three places, and the one detector that reproduces this set
    // exactly — a trio path resolved against a repo-root constant — agrees
    // by SPELLING, since `test/project-state-suite-isolation.test.ts`
    // escapes it only through a `DA_OWNED` array. That detector is used as a
    // one-directional membership guard in the test file and NOT as the
    // mechanism here. A fixed row also keeps the rename control: *"every
    // routed test exists on disk"* goes red the day one of these seven is
    // renamed away, where a derived row would silently stop routing it.
    //
    // Each member reads one of the three from the repo root, so the file's
    // CONTENT is an input to it. Three candidates were excluded on evidence:
    // `distribution-currency` names the three paths zero times (and so does
    // `lib/distribution-currency.ts`), `project-state-derivation` scans the
    // tree for a generator rather than reading the record, and
    // `suite-isolation` asserts the trio is byte-identical before and after
    // a run — content-invariant by construction.
    id: "state-write",
    event: "wrote the DA-owned session state (project-state.json, PROJECT-STATE.md, SUCCESS.md)",
    tests: [
      "test/closing-keywords.test.ts",
      "test/project-state-currency.test.ts",
      "test/project-state-shape.test.ts",
      "test/update-project-state.test.ts",
      "test/success-doc.test.ts",
      "test/distribution-standing.test.ts",
      "test/rule-lifecycle-spec.test.ts",
    ],
    // Exact repo-root paths, not a basename match. A consumer fixture at
    // `test/fixtures/project-state.json` is not the live record, and a
    // substring row would route seven suites for it.
    fires: c => DA_OWNED_STATE.includes(c.path),
  },
];

export interface CensusRouting {
  /**
   * Rows that fired, in table order, each with the paths that fired it and
   * the tests THAT reading resolved to. A fixed row's `tests` is the row's
   * own list; a derived row's is what the tree answered (#1442).
   */
  fired: { trigger: CensusTrigger; because: string[]; tests: string[] }[];
  /** The union of the fired rows' tests, deduplicated, in table order. */
  tests: string[];
}

/**
 * Every test a FIXED row can emit. The rule file's block must equal this set.
 *
 * A derived row contributes nothing here on purpose: its membership is a
 * property of the tree, not of the table, so putting it in this set would
 * put a list into the rule file's prose that rots at the next rename —
 * which is the thing #990 built the rendered table to prevent.
 */
export function allCensusTests(): string[] {
  return [...new Set(CENSUS_TRIGGERS.flatMap(t => t.tests))];
}

/** Resolve a repo-relative path against a project root. */
export const onDisk = (root: string) => (p: string) => existsSync(join(root, p));

const SELF_ROOT = join(import.meta.dir, "..");

/**
 * `exists` decides what a derived row resolves to. It defaults to THIS
 * repository, which is right for a reader asking about the tree it was
 * imported from and wrong for one routing a consumer project — pass
 * `onDisk(root)` whenever the root is not this one.
 */
export function censusTestsFor(
  changes: Change[],
  exists: (path: string) => boolean = onDisk(SELF_ROOT),
): CensusRouting {
  const fired: CensusRouting["fired"] = [];
  for (const trigger of CENSUS_TRIGGERS) {
    const matched = changes.filter(c => trigger.fires(c));
    // A derived row drops the changes whose derivation resolved to nothing,
    // so a row with no surviving change is ABSENT rather than present and
    // empty. The two read identically in the output and are different facts:
    // "no spec in this diff has a suite named after it" against "the row
    // fired and the suite it names is gone".
    const resolved = trigger.derive
      ? matched
          .map(c => ({ path: c.path, tests: trigger.derive!(c, exists) }))
          .filter(r => r.tests.length > 0)
      : matched.map(c => ({ path: c.path, tests: trigger.tests }));
    if (resolved.length === 0) continue;
    fired.push({
      trigger,
      because: resolved.map(r => r.path),
      tests: [...new Set(resolved.flatMap(r => r.tests))],
    });
  }
  return { fired, tests: [...new Set(fired.flatMap(f => f.tests))] };
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
      const target = t.derivedTarget ?? t.tests.join(" ");
      console.log(`${t.id.padEnd(22)}${t.event}\n${" ".repeat(22)}${target}`);
    }
    process.exit(0);
  }

  let routing: CensusRouting;
  try {
    routing = censusTestsFor(changesFor(root, flag("base")), onDisk(root));
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
