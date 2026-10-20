/**
 * #830 — a reported path is measured when it is reported, not two hours later.
 *
 * Run `wf_7ba257c7-b87` spent 6,854 seconds and 1,580,869 subagent tokens
 * across 24 agents, every one of them succeeding, and collected nothing. One
 * agent reported `/.github/workflows/ai-review.yml` — the right file, in
 * repo-root notation — and `pathRefusal` refused it as an absolute path at
 * COLLECTION, after every agent had finished. Blast radius of one malformed
 * string: the whole run, including two worktrees that reported nothing wrong.
 *
 * **The rule is correct and is not relaxed here.** `/x` is absolute on this
 * platform; stripping the slash so it "works" turns `/etc/passwd` into a
 * contributable `etc/passwd`. #400's table stands exactly as it is.
 *
 * ## What is new, and what it deliberately is not
 *
 * `reportedPathRefusal` adds no rule and no normalisation. It asks the SAME
 * two functions the collection audit asks, in the same order —
 * `pathRefusal(claimKey(worktreePath, element))` — at the moment the element
 * arrives. So it cannot be stricter than collection or looser than it; the
 * only thing that changes is WHEN the answer is taken and WHICH agent is
 * named. AC-4 is the case that holds it to that.
 *
 * That matters more than it sounds. The tempting version of this check reads
 * the raw string and refuses any leading `/`, which would be STRICTER than
 * collection: `claimKey` strips a worktree prefix, so
 * `/…/worktrees/wf-21/lib/a.ts` reduces to `lib/a.ts` and is accepted today —
 * `workflows/ship.js` calls that "the most common reporting style". A
 * report-time guard that refused it would turn working runs red on the shape
 * of a path rather than on anything wrong with it.
 *
 * ## Not a second decider
 *
 * `filesChangedShapeRefusal` (#611) is next to this one and answers a
 * different question — "is this a path, or a sentence about a path" — and the
 * two have inputs only they reach: `lib/a.ts modified by marcus` for the
 * shape rule, `lib/a;rm.ts` for the path table. This file does not re-ask
 * either. It asks whether the path table's answer arrives in time to be
 * actionable.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Strip the leading `/` and retry.** It is one `replace`, the reported
 * symptom disappears, the dead run would have completed — and
 * `/etc/passwd` becomes a contributable `etc/passwd` in the same line. AC-3's
 * corpus is what survives it and AC-5 applies it and counts.
 *
 * ## What was broken to prove it
 *
 * Counted over this file + `test/claim-path-safety-parity.test.ts` +
 * `test/files-changed-path-shape.test.ts` +
 * `test/files-changed-shape-mutation.test.ts` (134 tests). Every count
 * predicted before the run, in `/tmp/830-battery/predictions.md`, and **the
 * baseline row was read before any mutation row**.
 *
 * The last three files are a CONTROL, predicted 0 in every row: they are
 * #400's shared-table guard and #611's report-time shape guard — the two
 * things this change calls rather than copies. A red in one of them means a
 * shared decider was modified instead of a caller added.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** | 134 pass, 0 fail | **134 pass, 0 fail** | — |
 * | M1 `reportedPathRefusal` short-circuited to `return null` — pre-#830 | 5 | **5** — AC-1, AC-2, AC-3, AC-3b, AC-5 | `['/.github/workflows/ai-review.yml']`: original refuses naming `an absolute path`, mutant returns null |
 * | M2 the `filesChangedShapeRule(el)` skip removed | 1 | **2** — AC-8, and #611's forwarding case | `['lib/a.ts (modified by marcus)']`: original stays silent, mutant refuses it for the `(` |
 * | M3 the `!refusal.boundary` branch collapsed | 1 | **1** — AC-2 | `['lib/a;rm.ts']`: original says it is inside and cannot be staged, mutant says it names no location inside the worktree |
 * | M4 the `if (!wt) return null` guard removed | 1 | **1** — AC-7 | `{worktreePath: '', filesChanged: ['/etc/passwd']}`: original returns null as collection does, mutant refuses — stricter than collection |
 * | M5 **the cheapest wrong fix**, `.replace(/^\/+/, '')` on the key | 5 | **5** — AC-1, AC-2, AC-3, AC-3b, AC-5 | `['/etc/passwd']`: original refuses, mutant accepts it as `etc/passwd` |
 * | M6 `claimKey(wt, el)` replaced by the raw `el` — the stricter draft | 2 | **3** — AC-3, AC-3b, AC-5 | `['<WT>/lib/a.ts']`: original accepts, as collection does; mutant refuses an absolute path that is inside |
 * | M7 the per-sub-issue call site removed | 1 | **1** — AC-6 | the source text: two call sites against one |
 *
 * **M1 and M7 are one wire mutated at each end** (#235) and red disjoint
 * sets: M1 takes the behaviour out, M7 takes one of the two deliveries out,
 * and only AC-6 can see the second.
 *
 * ### M3 came back 0 the first time, and the case was the defect
 *
 * AC-2's negative half forbade the string `"inside its own worktree"` — which
 * is the COLLECTION AUDIT's wording, not anything this function emits. So it
 * was true of every string it could ever be handed, and collapsing both
 * branches into one sentence was **0 of 134**: the third shape, in the case
 * written to separate two sentences. It now asserts the clauses these two
 * messages actually carry, and the row is 1.
 *
 * ### Two rows came back HIGH, and both extra reds are the real kind
 *
 * **M2's extra red is #611's own mutation case** — *"the mutant forwards it,
 * and the audit refuses it with the git add sentence"*. That case
 * short-circuits the SHAPE guard and asserts an annotated element then
 * reaches the collection audit. Remove this function's `filesChangedShapeRule`
 * skip and the element is refused here instead, so it never arrives, and
 * #611's proof that its own guard is what stops it stops being true. The skip
 * is not politeness about message wording: it is what keeps these two from
 * becoming two deciders for one question, and #611's row is what notices.
 *
 * **M6's extra red is AC-5's mutant builder aborting**, not a verdict. Its
 * anchor is `const key = claimKey(wt, el)` — the line M6 replaces — so
 * `mutateOnce` finds it zero times and throws *"could not build the mutant"*.
 * That is the loud-abort property the builder exists for: a harness that
 * silently no-ops when its target moves is the decorative check this is all
 * about.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** The worktree from the dead run, named so the fixtures read as that run. */
const WT = "/Users/x/.claude/worktrees/wf_7ba257c7-b87-21";

interface Violation {
  worktreePath: string;
  path: string;
  claimant: string | null;
  detail: string;
}

interface Phases {
  reportedPathRefusal: (buildResult: unknown, label: string) => string | null;
  filesChangedShapeRefusal: (buildResult: unknown, label: string) => string | null;
  auditWorktreeClaims: (r: unknown) => { violations: Violation[]; candidates: unknown[] };
  claimKey: (wt: string, p: unknown) => string;
  pathRefusal: (p: string) => { rule: string; boundary: boolean } | null;
}

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

/**
 * All three blocks together, because the point of the change is that the
 * report-time caller reaches into the two existing deciders. Loading
 * FILES-CHANGED-SHAPE alone throws on the first call, which is the structural
 * proof it keeps no third copy of the rules.
 */
function loadPhases(mutate: (src: string) => string = s => s): Phases {
  const src = mutate(
    `${block("SECURITY-HELPERS")}\n${block("FILES-CHANGED-SHAPE")}\n${block("COLLECT-CLAIM")}`,
  );
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${src}
     return { reportedPathRefusal, filesChangedShapeRefusal, auditWorktreeClaims, claimKey, pathRefusal }`,
  )("/repo", () => {}) as Phases;
}

/** Replace exactly once, or abort loudly — a mutant that was never applied measures nothing. */
function mutateOnce(src: string, from: string, to: string): string {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`could not build the mutant: the anchor appears ${n} times`);
  return src.replace(from, to);
}

const real = loadPhases();

function built(filesChanged: unknown[], worktreePath = WT) {
  return { success: true, worktreePath, filesChanged, claimedFiles: [] };
}

/**
 * One corpus, one literal verdict each, written by hand and derived from
 * nothing — the discipline `test/claim-path-safety-parity.test.ts` sets for
 * the same table. A corpus computed from the predicate is satisfied by a
 * predicate that refuses nothing.
 */
interface Row {
  path: string;
  refused: boolean;
  boundary: boolean | null;
  why: string;
}

const CORPUS: Row[] = [
  // ── permitted, and the second one is the row that stops this being strict ──
  { path: "lib/a.ts", refused: false, boundary: null, why: "an ordinary worktree-relative path" },
  { path: `${WT}/lib/a.ts`, refused: false, boundary: null, why: "absolute INSIDE the worktree — claimKey strips the prefix, and ship.js calls this the most common reporting style" },
  { path: ".github/workflows/ai-review.yml", refused: false, boundary: null, why: "what the dead run's agent should have written" },
  { path: "a/./b.ts", refused: false, boundary: null, why: "a `.` segment collapses; it cannot be a symlink" },

  // ── refused at the boundary: not a location inside this worktree ──
  { path: "/.github/workflows/ai-review.yml", refused: true, boundary: true, why: "#830 verbatim — repo-root notation is absolute" },
  { path: "/etc/passwd", refused: true, boundary: true, why: "the row that survives the cheapest wrong fix" },
  { path: "../x", refused: true, boundary: true, why: "a `..` segment escapes" },
  { path: "/Users/x/.claude/worktrees/wf_7ba257c7-b87-16/lib/a.ts", refused: true, boundary: true, why: "another worktree's absolute path — the prefix is not this worktree's" },

  // ── refused, and inside: "not inside its own worktree" is the wrong sentence ──
  { path: "lib/a;rm.ts", refused: true, boundary: false, why: "a shell metacharacter, in a path that IS inside" },
  { path: "lib/foo..", refused: true, boundary: false, why: "a segment ending in `..` — a legal filename staging has always refused" },
];

describe("#830: a reported path is refused when it is reported", () => {
  test("AC-1: the dead run's element is refused at report time, naming the agent and the path", () => {
    const refusal = real.reportedPathRefusal(
      built(["/.github/workflows/ai-review.yml"]),
      "marcus-sub-21",
    );
    expect(refusal, "the element that voided wf_7ba257c7-b87 is accepted at report time").toBeTruthy();
    expect(refusal).toContain("marcus-sub-21");
    expect(refusal).toContain("/.github/workflows/ai-review.yml");
    expect(refusal, "the refusal does not name the rule from the shared table").toContain("an absolute path");

    // The control, varying exactly one thing: the same report with the path
    // the agent should have written. Without this the case is satisfied by a
    // function that refuses everything.
    expect(
      real.reportedPathRefusal(built([".github/workflows/ai-review.yml"]), "marcus-sub-21"),
      "the correct path is refused too, so this measures nothing",
    ).toBeNull();
  });

  test("AC-2: the two boundary cases get different sentences, and the absolute one says what to write", () => {
    const outside = real.reportedPathRefusal(built(["/.github/workflows/ai-review.yml"]), "m")!;
    const inside = real.reportedPathRefusal(built(["lib/a;rm.ts"]), "m")!;

    // Asserted against the clauses these two messages ACTUALLY carry. The
    // first draft of this case forbade `"inside its own worktree"` — the
    // collection audit's wording, which this function never emits — so the
    // negative half was true of every string it could ever be handed.
    // Measured: collapsing both branches into the boundary sentence was 0 of
    // 134, the third shape, in the case written to catch it.
    const NOT_INSIDE = "does not name a location inside";
    expect(outside, "the boundary refusal does not say the path is outside the worktree").toContain(NOT_INSIDE);
    expect(inside, `"${NOT_INSIDE}" is a wrong sentence about lib/a;rm.ts — an operator reading it goes looking for a path that is not there`)
      .not.toContain(NOT_INSIDE);
    expect(inside, "the inside refusal does not say what is actually wrong").toContain("cannot be staged");
    expect(outside).not.toContain("cannot be staged");

    // What the agent should have written, quoted back — and quoted ONLY. The
    // #611 discipline: the harness names the bare form and stages nothing on
    // the agent's behalf, because a repaired path is a path nobody reported.
    expect(outside, "the refusal does not say what to write instead").toContain(
      '".github/workflows/ai-review.yml"',
    );
    expect(outside.toLowerCase()).toContain("worktree-relative");
  });

  test("AC-3: the table is not relaxed — every row's literal verdict, at report time", () => {
    for (const row of CORPUS) {
      const refusal = real.reportedPathRefusal(built([row.path]), "m");
      expect(refusal !== null, `${row.path} — ${row.why}`).toBe(row.refused);
    }
    // Non-vacuity: a corpus that refuses nothing, or everything, would satisfy
    // a loop over itself.
    expect(CORPUS.filter(r => r.refused).length).toBeGreaterThan(3);
    expect(CORPUS.filter(r => !r.refused).length).toBeGreaterThan(2);
  });

  test("AC-3b: report time and collection time return the SAME verdict for every row", () => {
    // The property that keeps this an earlier reading rather than a new one.
    // A report-time guard that is stricter than collection turns working runs
    // red on notation; one that is looser is theatre.
    for (const row of CORPUS) {
      const atReport = real.reportedPathRefusal(built([row.path]), "m") !== null;
      const audit = real.auditWorktreeClaims([
        { worktreePath: WT, filesChanged: [row.path], claimedFiles: [real.claimKey(WT, row.path)] },
        { worktreePath: `${WT}-other`, filesChanged: [], claimedFiles: [] },
      ]);
      const atCollection = audit.violations.some(v => v.path === real.claimKey(WT, row.path));
      expect(atCollection, `collection disagrees with the literal for ${row.path} — ${row.why}`).toBe(row.refused);
      expect(atReport, `the two phases disagree about ${row.path}`).toBe(atCollection);
    }
  });

  test("AC-3c: the boundary column agrees with the one the audit prints", () => {
    for (const row of CORPUS.filter(r => r.refused)) {
      const key = real.claimKey(WT, row.path);
      // A refused row that declares no boundary would compare `undefined`
      // against `null` and pass, which is the deleted-side-of-a-comparison
      // shape — establish presence before comparing.
      expect(typeof row.boundary, `${row.path} is refused and declares no boundary`).toBe("boolean");
      const refusal = real.pathRefusal(key);
      expect(refusal, `${row.path} — ${row.why}`).not.toBeNull();
      expect(refusal!.boundary, `${row.path} — ${row.why}`).toBe(row.boundary as boolean);
    }
  });

  test("AC-4: collection still refuses when the report-time check is switched off", () => {
    // Report time is an ADDITION. An agent that never reports, or a path that
    // reaches collection by some route this check does not see, must still be
    // caught — so the collection half is measured with the new half disabled,
    // which is the only way to know it is not now load-bearing on it.
    const disabled = loadPhases(src =>
      mutateOnce(
        src,
        "function reportedPathRefusal(buildResult, label) {",
        "function reportedPathRefusal(buildResult, label) { if (buildResult || label) return null;",
      ),
    );
    expect(
      disabled.reportedPathRefusal(built(["/etc/passwd"]), "m"),
      "the mutant still refuses, so it was never applied",
    ).toBeNull();

    for (const row of CORPUS) {
      const audit = disabled.auditWorktreeClaims([
        { worktreePath: WT, filesChanged: [row.path], claimedFiles: [disabled.claimKey(WT, row.path)] },
        { worktreePath: `${WT}-other`, filesChanged: [], claimedFiles: [] },
      ]);
      const refused = audit.violations.some(v => v.path === disabled.claimKey(WT, row.path));
      expect(refused, `collection stopped refusing ${row.path} once report time was disabled`).toBe(row.refused);
    }
  });

  test("AC-5: the cheapest wrong fix is applied, and the corpus refuses it", () => {
    // Strip the leading slash and retry. The reported symptom goes away, the
    // dead run completes, and `/etc/passwd` becomes contributable.
    const stripped = loadPhases(src =>
      mutateOnce(
        src,
        "    const key = claimKey(wt, el)",
        "    const key = claimKey(wt, el).replace(/^\\/+/, '')",
      ),
    );

    // The mutant was applied: it accepts the thing the real one refuses.
    expect(
      stripped.reportedPathRefusal(built(["/etc/passwd"]), "m"),
      "the mutant refuses /etc/passwd, so the strip was never applied",
    ).toBeNull();
    expect(
      real.reportedPathRefusal(built(["/etc/passwd"]), "m"),
      "the real source accepts /etc/passwd",
    ).toBeTruthy();

    // And the corpus is what notices: the two absolute rows flip.
    const flipped = CORPUS.filter(
      row => (stripped.reportedPathRefusal(built([row.path]), "m") !== null) !== row.refused,
    ).map(r => r.path);
    expect(flipped.sort()).toEqual(
      ["/.github/workflows/ai-review.yml", "/Users/x/.claude/worktrees/wf_7ba257c7-b87-16/lib/a.ts", "/etc/passwd"].sort(),
    );
  });

  test("AC-6: both implement paths ask it, next to the shape check they pair with", () => {
    // A refusal nothing calls is a function. The two call sites are the whole
    // delivery — `runImplement` for an undecomposed run and the per-sub-issue
    // block for a decomposed one, which is the shape the dead run had.
    // `= reportedPathRefusal(` and not `reportedPathRefusal(`: the function's
    // own declaration takes the same two parameter names, and counting it as
    // a call site would make a function nothing invokes report two callers.
    const calls = shipSource.match(/= reportedPathRefusal\(buildResult, /g) || [];
    expect(calls.length, "reportedPathRefusal is not called from both implement paths").toBe(2);
    expect(shipSource).toContain("= reportedPathRefusal(buildResult, 'marcus')");
    expect(shipSource).toContain("reportedPathRefusal(buildResult, `marcus-sub-${subIssue.number}`)");

    // Declared once, so there is one binding to mutate.
    const declarations = shipSource.match(/function reportedPathRefusal\(/g) || [];
    expect(declarations.length, "reportedPathRefusal must be declared once").toBe(1);
  });

  test("AC-7: a report with no worktreePath is collection's question, not this one", () => {
    // `claimKey('', p)` leaves an absolute path absolute, so refusing here
    // would make report time STRICTER than collection, which skips a row with
    // no worktree path entirely. `worktreeIdentity` owns whether a pathless
    // report is allowed at all, and answering it twice under a path-safety
    // reason misattributes the failure.
    expect(real.reportedPathRefusal(built(["/etc/passwd"], ""), "m")).toBeNull();
    const audit = real.auditWorktreeClaims([
      { worktreePath: "", filesChanged: ["/etc/passwd"], claimedFiles: [] },
      { worktreePath: WT, filesChanged: [], claimedFiles: [] },
    ]);
    expect(audit.violations, "collection started refusing a pathless row, so the two now disagree").toEqual([]);
  });

  test("AC-8: a failed, absent or non-array report is nobody's path problem", () => {
    // Those are `implementRefusal`'s questions. Answering them here under a
    // path-safety reason is the misattribution #611's docstring refuses.
    expect(real.reportedPathRefusal(null, "m")).toBeNull();
    expect(real.reportedPathRefusal({ success: false, worktreePath: WT, filesChanged: ["/etc/passwd"] }, "m")).toBeNull();
    expect(real.reportedPathRefusal({ success: true, worktreePath: WT, filesChanged: "nope" }, "m")).toBeNull();
    expect(real.reportedPathRefusal(built([]), "m")).toBeNull();

    // An annotated element is the SHAPE check's to refuse, and this one stays
    // silent about it — two refusals for one element is two sentences for one
    // fact, and the operator acts on whichever arrives first.
    const annotated = built(["lib/a.ts (modified by marcus)"]);
    expect(real.filesChangedShapeRefusal(annotated, "m"), "the shape check stopped seeing an annotated path").toBeTruthy();
    expect(real.reportedPathRefusal(annotated, "m"), "the path check answers the shape question too").toBeNull();
  });

  test("AC-9: an element at any index is read, and the index it names is that element's", () => {
    // The loop is this function's own, so it needs its own case — #611's
    // identical claim is about a different loop in a different function, and
    // a check that reads only `filesChanged[0]` passes every case above.
    const innocents = ["lib/zeta.ts", "docs/x.md", "lib/beta.ts"];
    const report = built([innocents[0]!, innocents[1]!, "/etc/passwd", innocents[2]!]);
    const refusal = real.reportedPathRefusal(report, "marcus")!;
    expect(refusal, "an element behind two clean ones is never reached").toBeTruthy();
    expect(refusal, "the refusal does not name the element it is about").toContain("/etc/passwd");
    expect(refusal, "the index names a different element than the one refused").toContain("filesChanged[2]");

    // And the clean elements are not blamed. Asserted rather than assumed:
    // a message that quoted the whole list would satisfy the line above.
    //
    // None of the three is `lib/a.ts`, and that is not a style choice — the
    // boundary sentence carries `"lib/a.ts"` as its EXAMPLE of a path the
    // agent should have written. A fixture using it reads as the refusal
    // naming an innocent element when it is the advice doing so, which is
    // the kind of red that sends the next reader after the wrong code.
    for (const innocent of innocents) {
      expect(refusal, `${innocent} is named in a refusal that is not about it`).not.toContain(innocent);
    }

    // The control, varying exactly one thing: the same four positions with
    // the refusable element replaced. Without it this is satisfied by a
    // function that refuses any list of four.
    expect(
      real.reportedPathRefusal(built([innocents[0]!, innocents[1]!, "etc/passwd", innocents[2]!]), "marcus"),
      "a list of four clean paths is refused, so the case measures the element and not the length",
    ).toBeNull();
  });

  test("AC-10: a non-string or blank element is skipped here, not refused under a path reason", () => {
    // `claimKey` of a blank is a blank, and `pathRefusal('')` is null — but
    // relying on that would make this function's silence an accident of
    // another function's return value. It skips them itself, and the reason
    // is AC-8's: whether an agent may report `null` as a changed file is
    // `implementRefusal`'s question, and answering it here would attach a
    // path-safety sentence to a report that has no path in it.
    for (const junk of [[null], [123], [{}], [[]], [""], ["   "]] as unknown[][]) {
      expect(
        real.reportedPathRefusal(built(junk), "m"),
        `${JSON.stringify(junk)} was refused under a path-safety reason`,
      ).toBeNull();
    }

    // Non-vacuity, and the property that matters: a skipped element does not
    // end the walk. A `break` where the code has `continue` passes every
    // assertion above and lets a refusable path hide behind a blank one.
    const refusal = real.reportedPathRefusal(built(["", null, "/etc/passwd"]), "m");
    expect(refusal, "the walk stopped at the first unreadable element").toBeTruthy();
    expect(refusal).toContain("filesChanged[2]");
  });
});

describe("#830: the refusal is delivered, and it ends the sub-issue that reported it", () => {
  /**
   * The decomposed path, driven. AC-6 counts two call sites in the source;
   * a call site is text until something watches the run stop. This is the
   * shape the dead run had — several sub-issues, one of them reporting a
   * path the table refuses — and the claim is that it fails HERE, naming
   * that agent, rather than at the barrier with every worktree's work done.
   */
  async function runWith(betaPath: string) {
    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal",
      "worktreeIdentity", "REPO", "taskSourceRefusal",
      "establishRunRef", "integrateWave", "waveNeedsIntegration",
      "measureLaunchBase",
      `${block("SECURITY-HELPERS")}\n${block("COLLECT-CLAIM")}\n`
        + `${block("FILES-CHANGED-SHAPE")}\n${block("DECOMPOSED-SHIP")}\nreturn runDecomposedShip;`,
    );
    const spawned: string[] = [];
    const run = factory(
      () => {},
      async (p: string, o: { label: string }) => {
        spawned.push(o.label);
        return {
          success: true,
          worktreePath: WT,
          worktreeRepo: "git@github.com:owner/project.git",
          taskSource: "brief",
          filesChanged: p.includes("beta") ? [betaPath] : ["lib/alpha.ts"],
          testOutput: "2 pass",
        };
      },
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      "/tmp/work", 830, REPO_ROOT, {},
      async () => ({ success: true, buildResult: {} }),
      new Function(`${block("IMPLEMENT-RESULT")}\nreturn implementRefusal;`)(),
      new Function(`${block("WORKTREE-IDENTITY")}\nreturn worktreeIdentity;`)(),
      "owner/project",
      new Function(`${block("BRIEF-PRECEDENCE")}\nreturn taskSourceRefusal;`)(),
      async () => ({ branch: "rungate/run-830", refusal: null }),
      async () => ({ ok: true, integrated: 0 }),
      new Function(`${block("RUN-REF")}\nreturn waveNeedsIntegration;`)(),
      async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
    );
    const result = await run([
      { number: 1, title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
      { number: 2, title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
    ]);
    return {
      result: result as Decomposed,
      spawned,
    };
  }

  interface Decomposed {
    success?: boolean;
    failed?: Array<{ title: string; buildResult?: { findings?: string[] } }>;
  }

  test("AC-11: the sub-issue that reported the dead run's path fails, naming its own agent", async () => {
    const { result, spawned } = await runWith("/.github/workflows/ai-review.yml");

    expect(result.success, "the run succeeded while one agent reported an unstageable path").not.toBe(true);

    // Attributed to the sub-issue that did it, and to no other. `alpha`
    // reported a clean path, and a run that failed both would be the
    // collection-time blast radius this issue is about, arriving earlier.
    expect(result.failed?.map(f => f.title)).toEqual(["beta"]);

    const findings = (result.failed?.[0]?.buildResult?.findings ?? []).join("\n");
    expect(findings, "the refusal did not reach the result the run reads").toContain(
      "/.github/workflows/ai-review.yml",
    );
    expect(findings, "the refusal does not say when it was caught").toContain("report time");

    // Named with the SAME label the spawn carried, read off the timeline
    // rather than written down here: a refusal naming a label no agent ran
    // under is a sentence an operator cannot trace to an agent, and ship.js
    // composes the two from one expression precisely so they cannot drift.
    const betaLabel = spawned[spawned.length - 1]!;
    expect(betaLabel, "the fixture's second spawn is not the sub-issue being measured").toContain("sub-");
    expect(findings, `the refusal does not name ${betaLabel}, the agent that reported it`).toContain(betaLabel);

    // It is the REPORT-time sentence and not collection's. Both are true of
    // this path, and only one of them arrives before the other agents finish
    // — so a case that accepted either would be green on the dead run.
    expect(findings, "this is the collection audit's sentence, which is the two-hour-late one").not.toContain(
      "not inside its own worktree",
    );
  });

  test("AC-12: the control — the same plan with the path the agent should have written", async () => {
    // Without this, AC-11 is satisfied by a decomposed run that fails for any
    // reason at all, which is the one thing a refusal case cannot assume.
    const { result, spawned } = await runWith(".github/workflows/ai-review.yml");
    expect(
      result.success,
      `the correct path fails too: ${(result.failed ?? []).map(f => (f.buildResult?.findings ?? []).join(" ")).join(" | ")}`,
    ).toBe(true);
    expect(spawned.length, "the plan did not dispatch both sub-issues").toBe(2);
  });
});
