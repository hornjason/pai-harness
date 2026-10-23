import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT } from "../lib/scaffold/ai-review-step";
import type { AiReviewUnmeasuredReason } from "../lib/scaffold/ai-review-findings";
import {
  AI_REVIEW_CHANGED_FILES_FLAG,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_SCOPE_LINE,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_VERDICT_KEY,
  aiReviewExitCode,
  aiReviewRefusal,
  aiReviewScopeLine,
  main,
  readAiReviewChangedFiles,
  readAiReviewFindings,
  scopeNotSupplied,
  unlocatableBlockingFinding,
} from "../lib/scaffold/ai-review-findings";

/**
 * Covers #1204 — a blocking finding may name a file the pull request never
 * touched, and nothing compared the two.
 *
 * ## What this is NOT
 *
 * It is not a correctness filter. Nothing here asks whether a finding is
 * RIGHT; a reviewer that is wrong about real code is a review problem and
 * this module has no standing to judge it. The only question asked is
 * whether the finding can be LOCATED — whether the path it cites is in the
 * set of paths the pull request changed — and that is mechanically decidable
 * from the diff, with no reading of the finding's claim at all.
 *
 * ## Why an unlocatable finding REFUSES rather than passing
 *
 * The dangerous repair here is to DROP the finding and let the run go green.
 * A review that silently discards findings is byte-indistinguishable from a
 * review that found nothing, which is the defect class this whole module
 * exists against (`.claude/rules/config-access.md`). So an unlocatable
 * blocking finding is its own named UNMEASURED reason, exactly as #1198's
 * `BLOCKING_FINDING_INCOMPLETE` is: the finding is carried, counted, named in
 * the annotation, and does not get to block on its own — and the run is red
 * for a reason that says the finding could not be placed, not that the code
 * is broken. AC-3 below is the case that goes red under the drop repair.
 *
 * ## The half that is not here
 *
 * The changed-file list is an INPUT. Nothing in this repository supplies it
 * yet: the generated job would have to write `git diff --name-only
 * <base>...HEAD` from the RESTORED tree, and that is a workflow change this
 * branch deliberately does not make (#1242 — the review refuses to run when
 * `ai-review.yml` differs from the default branch). AC-10 is the guard that
 * keeps the gap honest: this module must never compute the diff itself, or
 * it would compute it from a tree the reviewer could have written to.
 */

const MODULE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-findings.ts");
const STEP_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step");
const source = readFileSync(MODULE_PATH, "utf-8");

let SCRATCH = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-finding-scope-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

let fixtureSeq = 0;

function scratchFile(body: string, ext = "txt"): string {
  const path = join(SCRATCH, `scope-${fixtureSeq++}.${ext}`);
  writeFileSync(path, body);
  return path;
}

/**
 * A contract-complete finding, built FROM the contract (#1166's lesson).
 *
 * Eight fixtures in the sibling suite carried keys the contract never
 * declared and adjudicated BLOCKED anyway. A fixture that spells its own keys
 * cannot notice the reader and the prompt drifting apart.
 */
function blockingFinding(
  severity: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const f = AI_REVIEW_FINDING_FIELDS;
  const base: Record<string, unknown> = {
    [f.severity]: severity,
    [f.file]: "lib/touched.ts",
    [f.line]: 12,
    [f.summary]: "a credential is logged in plain text",
    [f.failureScenario]: "any run with the key set writes it to the job log",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

function payloadOf(verdict: string, findings: Record<string, unknown>[]): string {
  return JSON.stringify({
    [AI_REVIEW_VERDICT_KEY]: verdict,
    [AI_REVIEW_FINDINGS_KEY]: findings,
  });
}

/** A changed-file list on disk, read through the real reader. */
function scopeOver(paths: string[]) {
  return readAiReviewChangedFiles(scratchFile(`${paths.join("\n")}\n`));
}

const BLOCKING_SEVERITY = Object.keys(AI_REVIEW_SEVERITIES).filter(s => AI_REVIEW_SEVERITIES[s])[0];
const ADVISORY_SEVERITIES = Object.keys(AI_REVIEW_SEVERITIES).filter(s => !AI_REVIEW_SEVERITIES[s]);

describe("#1204: a blocking finding is adjudicated only where it can be located", () => {
  const f = AI_REVIEW_FINDING_FIELDS;

  test("#1204 / AC-1 control: a finding naming a CHANGED file adjudicates exactly as after #1198", () => {
    // FIRST, and read before any red row below. If a locatable blocking
    // finding stopped blocking, every refusal underneath would be an
    // instrument that refuses everything rather than a measurement of scope.
    const scope = scopeOver(["lib/touched.ts", "test/other.test.ts"]);
    expect(scope.status, "the control's own changed-file list did not read").toBe("MEASURED");

    const r = readAiReviewFindings(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]),
      scope,
    );

    expect(r.outcome).toBe("BLOCKED");
    expect(r.blocked).toBe(true);
    expect(r.unmeasuredReasons).toEqual([]);
    expect(r.blockingReported).toHaveLength(1);
    expect(r.unlocatableReported, "a located finding was reported as unlocatable").toEqual([]);
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("#1204 / AC-2 witness: a finding naming a file the pull request never touched is its own reading", () => {
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" })]),
      scope,
    );

    expect(r.outcome).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toContain("BLOCKING_FINDING_UNLOCATABLE");
    expect(r.blocked, "a withheld decision was defaulted").toBeNull();

    // Carried, not dropped. The count of findings produced and the count
    // allowed to block are both observable, and they differ here.
    expect(r.reported, "the finding was discarded instead of demoted").toHaveLength(1);
    expect(r.unlocatableReported).toHaveLength(1);

    const refusal = aiReviewRefusal(r) ?? "";
    expect(refusal, "the refusal does not name the path that could not be located").toContain(
      "does/not/exist.ts",
    );
    expect(
      refusal.toLowerCase(),
      "the refusal reads as a judgement of the finding rather than of its location",
    ).toContain("locate");
  });

  test("#1204 / AC-2b: the pair varies the FILE and nothing else", () => {
    // #585's discipline. Two hand-written payloads are two literals and the
    // next edit touches one of them; the out-of-scope half is DERIVED from
    // the in-scope half, and the derivation is asserted, so the pair cannot
    // carry a second difference.
    const located = blockingFinding(BLOCKING_SEVERITY);
    const unlocatable: Record<string, unknown> = { ...located, [f.file]: "does/not/exist.ts" };

    const differing = Object.keys(located).filter(
      k => JSON.stringify(located[k]) !== JSON.stringify(unlocatable[k]),
    );
    expect(differing, "the pair differs in more than the file it names").toEqual([f.file]);
    expect(Object.keys(unlocatable).sort()).toEqual(Object.keys(located).sort());

    const scope = scopeOver(["lib/touched.ts"]);
    expect(readAiReviewFindings(payloadOf("BLOCK", [located]), scope).outcome).toBe("BLOCKED");
    expect(readAiReviewFindings(payloadOf("BLOCK", [unlocatable]), scope).outcome).toBe(
      "UNMEASURED",
    );
  });

  test("#1204 / AC-3: the cheapest wrong fix — dropping the finding — turns this case red", () => {
    // Named before the repair exists. What an operator sees is a review
    // blocking on a file nobody touched, and the 5pm repair is to filter the
    // finding out of the blocking list. It works, and it makes a review that
    // discarded a finding indistinguishable from one that never had it.
    //
    // TWO findings, one located and one not, and that is what makes this
    // case able to see the repair. With one finding the dropped payload
    // still refuses — a BLOCK verdict over nothing blocking is #1178's
    // CONTRADICTION — so a case asserting only "the run is not green" would
    // go GREEN over the drop, for a reason that has nothing to do with
    // scope. Beside a finding that does block, the dropped one disappears in
    // silence. So the assertion is that the unlocatable finding is NAMED and
    // CARRIED, not that the exit is non-zero.
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [
        blockingFinding(BLOCKING_SEVERITY),
        blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
      ]),
      scope,
    );

    expect(r.unmeasuredReasons, "the dropped finding left no reason behind").toContain(
      "BLOCKING_FINDING_UNLOCATABLE",
    );
    expect(r.unlocatableReported, "the finding was discarded rather than demoted").toHaveLength(1);
    expect(r.reported, "the payload's own findings were edited").toHaveLength(2);
    expect(
      aiReviewRefusal(r) ?? "",
      "the annotation does not name the finding that could not be located, so a run " +
        "that demoted one and a run that never had one read the same",
    ).toContain("does/not/exist.ts");
    expect(aiReviewExitCode(r), "an unlocatable finding reported a GREEN check").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
  });

  test("#1204 / AC-4: a NON-blocking finding is not subject, matching the line #1198 drew", () => {
    // The scope line, deliberately the same one #1198 drew: an advisory
    // finding costs a line in an annotation and nothing else, and reddening
    // a run over where an `info` points would lose the cheap tail the module
    // is already losing (#1162).
    const scope = scopeOver(["lib/touched.ts"]);
    for (const severity of ADVISORY_SEVERITIES) {
      const r = readAiReviewFindings(
        payloadOf("PASS", [blockingFinding(severity, { [f.file]: "does/not/exist.ts" })]),
        scope,
      );
      expect(r.outcome, `an advisory '${severity}' was held to the scope check`).toBe("CLEAN");
      expect(aiReviewExitCode(r)).toBe(0);
    }
    expect(ADVISORY_SEVERITIES.length, "the loop ran over nothing").toBeGreaterThan(0);
  });

  test("#1204 / AC-5 control: with no changed-file list the verdict is what it is today", () => {
    // The release-compatibility half. An absent list switches the check OFF,
    // and the thing that keeps that from being Silent Default Substitution is
    // that the state is NAMED and printed — never that the verdict moves.
    const cases = [
      ["BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" })], "BLOCKED"],
      ["BLOCK", [blockingFinding(BLOCKING_SEVERITY)], "BLOCKED"],
      ["PASS", [], "CLEAN"],
      ["PASS", [blockingFinding(BLOCKING_SEVERITY)], "CONTRADICTION"],
    ] as const;

    for (const [verdict, findings, expected] of cases) {
      const r = readAiReviewFindings(payloadOf(verdict, [...findings]));
      expect(r.outcome, `an absent changed-file list moved the ${expected} verdict`).toBe(expected);
      expect(r.unmeasuredReasons).not.toContain("BLOCKING_FINDING_UNLOCATABLE");
      expect(r.scope.status).toBe("NOT_SUPPLIED");
      expect(r.unlocatableReported, "a check that did not run reported an empty result").toBeNull();
    }
  });

  test("#1204 / AC-6: a list that could not be taken REFUSES, and differs from one that was empty", () => {
    // The issue's own words: an empty changed-file list makes every blocking
    // finding unlocatable, which is loud for the wrong reason and reads as
    // the reviewer hallucinating. Both states refuse, with different reasons,
    // and NEITHER of them reports an unlocatable finding.
    const absent = readAiReviewChangedFiles(join(SCRATCH, "nowhere", "changed.txt"));
    expect(absent.status).toBe("UNMEASURED");
    expect(absent.reason).toBe("CHANGED_FILES_UNREADABLE");

    const empty = readAiReviewChangedFiles(scratchFile("\n   \n"));
    expect(empty.status).toBe("UNMEASURED");
    expect(empty.reason).toBe("CHANGED_FILES_EMPTY");

    expect(absent.reason, "the two states are not distinguishable").not.toBe(empty.reason);

    for (const scope of [absent, empty]) {
      const reason = scope.reason;
      expect(reason, "a refusing scope reading carried no reason").not.toBeNull();
      const r = readAiReviewFindings(payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]), scope);
      expect(r.outcome).toBe("UNMEASURED");
      expect(r.unmeasuredReasons).toContain(reason as AiReviewUnmeasuredReason);
      expect(
        r.unmeasuredReasons,
        "a diff nobody could take was read as a pull request that touches nothing, " +
          "which makes every blocking finding unlocatable",
      ).not.toContain("BLOCKING_FINDING_UNLOCATABLE");
      expect(r.reported, "the payload's findings were lost with the scope reading").toHaveLength(1);
      expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    }
  });

  test("#1204 / AC-7: an INCOMPLETE blocking finding is not also graded on scope", () => {
    // Two deciders over one input is the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`. A finding carrying no
    // `file` has already been refused by #1198 with its own reason; grading
    // the absent path against the diff as well would mean a mutation of
    // either check leaves the other holding the case up.
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: undefined })]),
      scope,
    );
    expect(r.unmeasuredReasons).toContain("BLOCKING_FINDING_INCOMPLETE");
    expect(r.unmeasuredReasons).not.toContain("BLOCKING_FINDING_UNLOCATABLE");
  });

  test("#1204 / AC-8: the counts reach the operator — produced, and allowed to block", () => {
    const scope = scopeOver(["lib/touched.ts"]);
    const r = readAiReviewFindings(
      payloadOf("BLOCK", [
        blockingFinding(BLOCKING_SEVERITY),
        blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
      ]),
      scope,
    );

    const line = aiReviewScopeLine(r);
    expect(line.startsWith(AI_REVIEW_SCOPE_LINE), `the scope line is not prefixed: ${line}`).toBe(
      true,
    );
    expect(line).toContain("MEASURED");
    // Two produced, one unlocatable, and the blocking decision withheld
    // because the reading is UNMEASURED. A line that reported "1 blocking"
    // beside a withheld decision would be inventing the number.
    expect(line).toContain("2");
    expect(line.toLowerCase()).toContain("unlocatable");
    expect(line, "a scope line that fits on one workflow log line").not.toContain("\n");
  });

  test("#1204 / AC-9: main() reads the flag, prints the scope state, and refuses", () => {
    const payloadPath = scratchFile(
      payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" })]),
      "json",
    );
    const listPath = scratchFile("lib/touched.ts\n");

    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
    let code: number;
    try {
      code = main([payloadPath, AI_REVIEW_CHANGED_FILES_FLAG, listPath]);
    } finally {
      console.log = log;
      console.error = error;
    }

    expect(code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(out.join("\n")).toContain("ai-review findings outcome: UNMEASURED");
    expect(out.join("\n"), "the scope state was not recorded on the run's output").toContain(
      AI_REVIEW_SCOPE_LINE,
    );
    expect(err.join("\n")).toContain("::error");
    expect(err.join("\n")).toContain("does/not/exist.ts");
  });

  test("#1204 / AC-9b: an argument nobody parsed is UNMEASURED, not ignored", () => {
    // A silently dropped argument is the same fault as a silently skipped
    // check. `bin/rungate.ts` appends `--project-root <cwd>` for any command
    // declaring the flag, and this command declares none precisely because a
    // stray argument used to be read as a second payload path.
    const payloadPath = scratchFile(payloadOf("PASS", []), "json");
    for (const argv of [
      [payloadPath, "--unknown-flag", "x"],
      [payloadPath, AI_REVIEW_CHANGED_FILES_FLAG],
      [payloadPath, "a-second-positional"],
    ]) {
      const out: string[] = [];
      const log = console.log;
      const error = console.error;
      console.log = () => {};
      console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
      let code: number;
      try {
        code = main(argv);
      } finally {
        console.log = log;
        console.error = error;
      }
      expect(code, `argv ${JSON.stringify(argv)} was accepted`).toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(out.join("\n")).toContain("ARGUMENTS_UNREADABLE");
    }

    // The control for that repair: the shipped invocation still works.
    const log = console.log;
    console.log = () => {};
    try {
      expect(main([payloadPath]), "the one-argument form the generated job runs").toBe(0);
    } finally {
      console.log = log;
    }
  });

  test("#1204 / AC-10: the adjudicator never takes the diff itself", () => {
    // The input has to be read from the RESTORED tree, before the reviewer
    // could have written to the checkout. This module runs AFTER the review,
    // from the payload's own directory, so a diff computed here would be a
    // diff the subject of the review had an opportunity to edit. The only
    // honest shape is to be handed the list.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(l => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code, "the comment stripper ate the file").toContain("export function main(");
    for (const spawner of ["spawnSync", "execSync", "execFileSync", "Bun.spawn", "child_process"]) {
      expect(code, `the adjudicator reaches for ${spawner} — it must be HANDED the list`).not.toContain(
        spawner,
      );
    }
  });

  test("#1204 / AC-11: a path spelled ./x and a path spelled x are the same file", () => {
    // Narrow on purpose. A leading `./` is the one divergence a `git diff
    // --name-only` list and an agent-written path reliably produce, and
    // equating anything wider — a basename, a suffix match — would demote the
    // wrong findings. An absolute path is NOT equated: it is a different
    // claim, and guessing is how a real finding gets refused.
    const scope = scopeOver(["lib/touched.ts"]);
    expect(unlocatableBlockingFinding(blockingFinding(BLOCKING_SEVERITY, { [f.file]: "./lib/touched.ts" }), scope.files)).toBeNull();
    expect(unlocatableBlockingFinding(blockingFinding(BLOCKING_SEVERITY), scope.files)).toBeNull();
    expect(
      unlocatableBlockingFinding(blockingFinding(BLOCKING_SEVERITY, { [f.file]: "touched.ts" }), scope.files),
      "a basename matched a path, which demotes by coincidence",
    ).toBe("touched.ts");
    expect(
      unlocatableBlockingFinding(blockingFinding(BLOCKING_SEVERITY), null),
      "the decider fired with no list to decide against",
    ).toBeNull();
    expect(scopeNotSupplied().status).toBe("NOT_SUPPLIED");
  });

  test("#1204 / AC-12: the check can fail — the binding, zeroed", async () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`. One exported binding,
    // so the removal is PERFORMED: with `unlocatableBlockingFinding` unable
    // to report anything, the out-of-scope finding must adjudicate exactly as
    // the in-scope one does, which is the pre-#1204 behaviour and the defect.
    const scope = scopeOver(["lib/touched.ts"]);
    const unlocatable = payloadOf("BLOCK", [
      blockingFinding(BLOCKING_SEVERITY, { [f.file]: "does/not/exist.ts" }),
    ]);
    const located = payloadOf("BLOCK", [blockingFinding(BLOCKING_SEVERITY)]);
    expect(readAiReviewFindings(unlocatable, scope).outcome).toBe("UNMEASURED");

    const needle = "  return changed.includes(named) ? null : named;";
    expect(
      source.split(needle).length - 1,
      "could not build the mutant: the scope decider is not spelled once",
    ).toBe(1);

    const path = join(SCRATCH, "mutant-ai-review-findings.ts");
    writeFileSync(
      path,
      source
        .replace(needle, "  return null;")
        .replace(/from "\.\/ai-review-step"/g, `from "${STEP_PATH}"`),
    );
    const mutant = (await import(path)) as typeof import("../lib/scaffold/ai-review-findings");

    const mutantScope = mutant.readAiReviewChangedFiles(scratchFile("lib/touched.ts\n"));
    expect(
      mutant.readAiReviewFindings(unlocatable, mutantScope).outcome,
      "zeroing the scope decider changed nothing, so the case witnesses nothing",
    ).toBe("BLOCKED");
    expect(
      mutant.readAiReviewFindings(located, mutantScope).outcome,
      "the mutant stopped blocking a located finding, so it is broken rather than mutated",
    ).toBe("BLOCKED");
  });
});
