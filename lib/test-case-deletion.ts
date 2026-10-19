/**
 * Which test cases a repair round DELETED, and whether they were green
 * before it (#659).
 *
 * ## The run this exists for
 *
 * `wf_2abbe96f-546`, issue #646. The verify gate recorded AC-9 FAIL over an
 * evidence command that emits two numbers against one threshold — a verdict
 * that was never about the code (see `lib/evidence-satisfiability.ts`). The
 * repair round the FAIL triggered deleted three PASSING test cases from
 * `test/unit/hill-climb-receipt.test.ts` and 296 net lines overall, and
 * deleting them changed nothing about what AC-9 measures. The run's output
 * was a smaller green tree, and nothing in the run said what left.
 *
 * ## Why two commits, and why these two
 *
 * The cases were added at the first build commit and removed at the repair
 * commit, both on the run's own branch. Against the merge base they never
 * existed — so the PR diff, `git log main..branch`, and every "what did this
 * branch change" reading are all clean of the deletion. The only window it
 * is visible in is between the two BUILD COMMITS, which is why this takes a
 * pair of commits and reads them out of the object store rather than looking
 * at a working tree or a branch.
 *
 * ## Absence is not the finding
 *
 * A name that is gone is a deleted passing test, a deleted failing test, a
 * renamed test, or a test somebody moved to another file. Only the first is
 * the defect. So the verdict needs the PREVIOUS commit's own ledger, and
 * three outcomes rather than two:
 *
 *   CLEAN       nothing left, or what left was not green before
 *   DELETED     a case the previous build commit proved green is gone
 *   UNMEASURED  the ledger does not say — which is NOT "the case was red"
 *
 * That last one is `lib/suite-run-reading.ts`'s distinction, in a second
 * place: `0`, `{}` and silence are indistinguishable from success, and
 * UNMEASURED is the only reading that is not.
 */
import { spawnSync } from "child_process";
import { readJunitOutcomes } from "./junit-checks";

// ── Reading a commit ─────────────────────────────────────────────────────

/** A commit SHA or any other revision git can resolve. */
function git(projectRoot: string, args: string[]): { out: string; status: number } {
  const r = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { out: r.stdout ?? "", status: r.status ?? 1 };
}

/**
 * The commit a revision names, or a throw.
 *
 * A throw rather than a null: every caller of this module is deciding
 * whether a run may ship, and a revision that does not resolve produces an
 * empty reading — which is byte-identical to "nothing was deleted". Run
 * `wf_2abbe96f-546`'s own context records the shell form of this trap: in
 * zsh, `$SHA:path` is parsed as a parameter modifier, mangles the ref, and
 * makes `grep -c` return 0, "which reads exactly like a clean result". No
 * command here goes through a shell, and an unresolvable revision stops the
 * reading rather than emptying it.
 */
function resolveCommit(projectRoot: string, revision: string): string {
  const r = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  const sha = r.out.trim();
  if (r.status !== 0 || sha === "") {
    throw new Error(`the revision "${revision}" does not resolve to a commit in ${projectRoot}`);
  }
  return sha;
}

/** A file's contents at a commit, or `null` when the commit does not hold it. */
function blobAt(projectRoot: string, commit: string, path: string): string | null {
  // `commit:path` is built as ONE argv element and handed to spawn, never to
  // a shell. The ref is not re-parsed by anything.
  const r = git(projectRoot, ["show", `${commit}:${path}`]);
  return r.status === 0 ? r.out : null;
}

/** Paths a tree holds that look like test files. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The test files that CHANGED between the two commits, including the ones
 * the second commit no longer has.
 *
 * `-z` everywhere, because `--name-only` C-quotes any path with a non-ASCII
 * byte, a quote, a tab or a newline — `"caf\303\251.test.ts"`, quotes
 * included. Fed back to `git show` that string resolves on neither commit,
 * both readings come back empty, and a file whose every case was deleted
 * reports no deletions (#516 measured exactly this).
 *
 * `--no-renames` so a renamed file arrives as a delete plus an add. A rename
 * that also dropped cases is then visible; with rename detection on, the
 * drop would be folded into a similarity score.
 */
function changedTestFiles(projectRoot: string, previous: string, current: string): string[] {
  const r = git(projectRoot, [
    "diff", "--name-only", "-z", "--no-renames", "--diff-filter=MD", previous, current,
  ]);
  if (r.status !== 0) {
    throw new Error(`git diff between ${previous} and ${current} failed in ${projectRoot}`);
  }
  return r.out.split("\0").filter(p => p !== "" && TEST_FILE.test(p));
}

// ── Reading the cases a source file declares ─────────────────────────────

/**
 * `test("…")` and `it("…")`, including the `.skip`, `.only`, `.todo` and
 * `.failing` forms.
 *
 * `describe` is deliberately not matched: the census this is compared
 * against counts cases, and a describe block that was renamed is not a
 * deleted case. The first group is the quote character and the second is the
 * raw name, escapes included.
 */
const CASE_DECLARATION =
  /(?:^|[^.\w$])(?:test|it)(?:\.(?:skip|only|todo|failing|skipIf|todoIf|runIf))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** A source-level string literal's VALUE. */
function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => ESCAPES[ch] ?? ch);
}

/**
 * Every test case name a source file declares, in declaration order.
 *
 * Exported so a caller can compare a reading of one commit against an
 * instrument that is not this one — `test/unit/deletion-build-commit-pair.test.ts`
 * checks both totals against the counts the verify gate's own `test-census`
 * recorded on the run, which is the only thing that can say this reads the
 * file rather than producing the right three names by luck.
 */
export function caseNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(CASE_DECLARATION)) {
    // A template literal with an interpolation has no single name to record,
    // and reporting its text as a name would make it look deleted the moment
    // the interpolation changed.
    if (m[1] === "`" && m[2].includes("${")) continue;
    names.push(unescape(m[2]));
  }
  return names;
}

// ── The deletion ─────────────────────────────────────────────────────────

/** One test case present at the previous commit and absent at the current one. */
export interface DeletedCase {
  /** The name as the source declared it, with no describe chain. */
  name: string;
  /** The path it was declared in, at the previous commit. */
  file: string;
}

/**
 * Every test case the current commit has lost since the previous one.
 *
 * Both sides are read out of the object store, so neither commit has to be
 * checked out and the working tree is never touched. Only files the diff
 * reports as modified or deleted are read: a file whose blob is identical
 * cannot have lost a case, and reading every test file in both trees would
 * be ~700 git invocations for an answer the diff already narrows.
 */
export function deletedCases(
  projectRoot: string,
  previousCommit: string,
  currentCommit: string,
): DeletedCase[] {
  const previous = resolveCommit(projectRoot, previousCommit);
  const current = resolveCommit(projectRoot, currentCommit);
  const out: DeletedCase[] = [];

  for (const file of changedTestFiles(projectRoot, previous, current)) {
    const before = blobAt(projectRoot, previous, file);
    if (before === null) continue;
    const after = blobAt(projectRoot, current, file);
    const survived = new Set(after === null ? [] : caseNames(after));
    for (const name of new Set(caseNames(before))) {
      if (!survived.has(name)) out.push({ name, file });
    }
  }
  return out;
}

// ── The verdict ──────────────────────────────────────────────────────────

/** What the previous build commit's own run says about each case. */
export type PassLedger =
  | { status: "MEASURED"; passed: string[]; failed: string[] }
  | { status: "UNMEASURED"; reason: string };

/**
 * A deletion the operator has taken responsibility for (#661).
 *
 * Carries the reason with it rather than beside it, so a waived case and
 * the justification for waiving it cannot be read apart in the artefact.
 */
export interface WaivedCase extends DeletedCase {
  acceptedReason: string;
  /**
   * What the previous build commit's ledger said about this case.
   *
   * A waiver RECORDS the reading, it does not erase it. Waiving a case the
   * ledger proved green and waiving one nothing can judge are different
   * acts, and a CLEAN that cannot tell them apart has thrown away the one
   * fact this module exists to carry (`.claude/rules/config-access.md`:
   * keep the whole reading, derive the boolean).
   */
  ledgerReading: LedgerReading;
}

/** What a ledger says about one case. `unjudged` is not `red`. */
export type LedgerReading = "green" | "red" | "unjudged";

/**
 * Per-case waivers, modelled on `scripts/verify-merge-content.ts`.
 *
 * `cases` are matched by EXACT case name. There is deliberately no pattern,
 * no prefix and no `all`: a waiver you have to write out one name at a time
 * is a waiver somebody has to look at, and the artefact then lists each one
 * against the reason. The cheapest wrong fix for a refusal is to widen it
 * until it stops firing, and a wildcard here is that fix pre-installed.
 */
export interface DeletionWaivers {
  /**
   * Each entry is `<file> :: <case name>` — the same spelling every report
   * in this module prints, so a waiver is copied from the refusal rather
   * than retyped.
   *
   * The FILE is required, and a waiver without one is refused rather than
   * matched on the name alone. A case name is not unique across a tree:
   * the round this check exists for deleted cases from two files at once,
   * and a bare name like `the baseline` is the kind of name test files
   * share. A name-only waiver silently clears every file that happens to
   * declare it, which is the widening the exact-match design exists to
   * prevent, in the one dimension a name cannot see.
   */
  cases: string[];
  reason: string;
}

/** The separator every report and every waiver uses. One spelling. */
export const WAIVER_SEPARATOR = " :: ";

/** A waiver string, split — or a throw naming what was wrong with it. */
export function parseWaiver(raw: string): DeletedCase {
  const at = raw.indexOf(WAIVER_SEPARATOR);
  if (at < 0) {
    throw new Error(
      `the waiver "${raw}" names no file. Write it as it is printed — ` +
        `"<file>${WAIVER_SEPARATOR}<case name>" — because a case name is not unique across ` +
        "a tree and a name-only waiver clears every file that declares it",
    );
  }
  const file = raw.slice(0, at);
  const name = raw.slice(at + WAIVER_SEPARATOR.length);
  if (file.trim() === "" || name.trim() === "") {
    throw new Error(`the waiver "${raw}" has an empty file or case name`);
  }
  return { file, name };
}

/** The reading, with UNMEASURED as a first-class outcome. */
export type DeletionReading =
  | { verdict: "CLEAN"; cases: DeletedCase[]; waived?: WaivedCase[]; unusedWaivers?: string[] }
  | { verdict: "DELETED"; cases: DeletedCase[]; waived?: WaivedCase[]; unusedWaivers?: string[] }
  | { verdict: "UNMEASURED"; cases: DeletedCase[]; reason: string; waived?: WaivedCase[]; unusedWaivers?: string[] };

/** A ledger from a bun JUnit report written at the previous build commit. */
export function ledgerFromJunit(path: string): PassLedger {
  const reading = readJunitOutcomes(path);
  if (reading.passed === null) {
    return { status: "UNMEASURED", reason: reading.reason ?? `no JUnit report could be read at ${path}` };
  }
  return { status: "MEASURED", passed: reading.passed, failed: reading.failed };
}

/**
 * Whether a ledger entry is about this case.
 *
 * bun's report carries the full `describe > describe > case` chain; a source
 * file declares the bare name. A matcher demanding equality would read every
 * case inside a describe block as never having run, and UNMEASURED would be
 * the only verdict this check could ever produce on a real suite.
 */
function names(entries: string[], name: string): boolean {
  return entries.some(entry => entry === name || entry.endsWith(` > ${name}`));
}

/**
 * The verdict for one deletion against one ledger.
 *
 * ONE discriminator: `verdict`. The three outcomes are projections of the
 * same two lists computed here and nowhere else, so no two of them can
 * disagree (`.claude/rules/config-access.md`).
 *
 * UNMEASURED outranks DELETED when both apply. A reading that reported
 * DELETED while part of its input was unjudgeable would be claiming a
 * complete answer it does not have, and the two outcomes refuse the run
 * either way — what differs is what an operator is told to go and do.
 */
export function deletionReading(
  deleted: DeletedCase[],
  ledger: PassLedger,
  waivers: DeletionWaivers = { cases: [], reason: "" },
): DeletionReading {
  // Waivers are applied HERE, in the owning binding, and not in the script.
  // A script that filtered its own input before calling this would be a
  // second decider agreeing with the first, and a mutation of either would
  // leave the other holding every case up
  // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
  //
  // ONE predicate, used by all three readers below. "Is this case waived?"
  // asked in two places is two deciders that agree, so a mutation of either
  // leaves the other applying the waiver and no behavioural test can tell
  // them apart — measured: widening the `waived` list alone moved the record
  // and left the verdict untouched, which is a mutant that proves nothing.
  // `matches` is that predicate, and it is the ONLY place the shape of a
  // waiver is decided. Widening it to a prefix — the cheap repair for an
  // operator with five long case names to type — then moves the waived
  // list, the verdict and the unused-waiver report together, instead of
  // moving one and leaving the others to hold the case up.
  // `matches` is that predicate, and it is the ONLY place the shape of a
  // waiver is decided. Widening it to a prefix — the cheap repair for an
  // operator with five long case names to type — then moves the waived
  // list, the verdict and the unused-waiver report together, instead of
  // moving one and leaving the others to hold the case up. Both components
  // are compared: a name alone does not identify a case across a tree.
  const refs = waivers.cases.map(parseWaiver);
  const matches = (w: DeletedCase, d: DeletedCase) => w.name === d.name && w.file === d.file;
  const isWaived = (d: DeletedCase) => refs.some(w => matches(w, d));

  // The ledger's answer for one case, asked in ONE place. The green/red/
  // unjudged split below is derived from it too, so a waived case and an
  // unwaived one cannot be classified by two different readers.
  const ledgerReadingOf = (d: DeletedCase): LedgerReading => {
    if (ledger.status !== "MEASURED") return "unjudged";
    if (names(ledger.passed, d.name)) return "green";
    if (names(ledger.failed, d.name)) return "red";
    return "unjudged";
  };

  const waived: WaivedCase[] = deleted
    .filter(isWaived)
    .map(d => ({ ...d, acceptedReason: waivers.reason, ledgerReading: ledgerReadingOf(d) }));
  // A waiver that matches nothing is REPORTED, never silently dropped. It
  // means either the deletion it covered is gone — so the waiver should go
  // too — or the case was renamed and the waiver has quietly stopped
  // applying, which is the failure mode an allowlist has
  // (`feedback-exemption-list-self-reference`). Reported and not refused:
  // refusing would be a scope this issue did not ask for.
  const unusedWaivers = waivers.cases.filter((_raw, i) => !deleted.some(d => matches(refs[i], d)));
  const extra = {
    ...(waived.length > 0 ? { waived } : {}),
    ...(unusedWaivers.length > 0 ? { unusedWaivers } : {}),
  };

  deleted = deleted.filter(d => !isWaived(d));

  // Nothing left, so there is nothing a ledger could tell us. This arm is
  // what keeps the check usable: requiring a ledger on every round would
  // refuse every run, and a refusal everyone overrides is not a check.
  if (deleted.length === 0) return { verdict: "CLEAN", cases: [], ...extra };

  if (ledger.status !== "MEASURED") {
    return {
      verdict: "UNMEASURED",
      cases: deleted,
      ...extra,
      reason:
        `${deleted.length} test case(s) were deleted between the two build commits and the ` +
        `previous commit's ledger could not be read, so nothing says whether they were passing: ` +
        `${ledger.reason}. Deleted: ${deleted.map(d => `${d.file} :: ${d.name}`).join("; ")}`,
    };
  }

  // Three projections of ONE reading. `red` is not consulted below — a case
  // the ledger proved red is not this defect — and it is named here so the
  // three outcomes are visible as a partition rather than as two tests and
  // a remainder.
  const green = deleted.filter(d => ledgerReadingOf(d) === "green");
  const unjudged = deleted.filter(d => ledgerReadingOf(d) === "unjudged");

  if (unjudged.length > 0) {
    return {
      verdict: "UNMEASURED",
      cases: deleted,
      ...extra,
      reason:
        `the previous build commit's ledger does not mention ${unjudged.length} of the ` +
        `${deleted.length} deleted case(s), so they are neither proven green nor proven red — ` +
        `a case the ledger never ran is UNMEASURED, not red: ` +
        `${unjudged.map(d => `${d.file} :: ${d.name}`).join("; ")}`,
    };
  }

  // A case that was RED before is not this defect. Deleting it may still be
  // wrong, and the test census (#307 SC-A19) is what refuses a round that
  // removes tests at all; this check is about the narrower and more
  // dangerous thing — a repair that deleted the evidence that it was not
  // needed.
  if (green.length === 0) return { verdict: "CLEAN", cases: [], ...extra };

  return { verdict: "DELETED", cases: green, ...extra };
}
