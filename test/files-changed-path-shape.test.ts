/**
 * Covers SC-2046, SC-2047, SC-2048, SC-2049, SC-2050 (HARNESS-STANDARD.md).
 *
 * #611 — run `wf_68a566ab-500` (issue #599) reached SHIP with all six ACs
 * PASS and rook PASS, and lost its entire collection at the claim audit.
 *
 * `lib/scaffold/steps.ts` is an ordinary path. What `pathRefusal` was handed
 * was that path with a prose annotation glued to it, and the `(`, `)` and `~`
 * inside the annotation are the shell metacharacters it found. The guard is
 * right and is NOT loosened here. Two other things were wrong:
 *
 *   1. There is no agent-result CONTRACT for a `filesChanged` element.
 *      `BUILD_RESULT_SCHEMA` declares `{ type: 'array', items: { type:
 *      'string' } }`, and a sentence is a string. So the annotation was
 *      accepted at the implement result read, carried through commit and
 *      staging, and refused ~103 minutes and ~1.79M subagent tokens later.
 *   2. The refusal, when it finally came, said "git add refuses the path".
 *      The true statement is "that is not a path, it is a sentence", and an
 *      operator who reads the first one goes looking for a quoting bug.
 *
 * ## Why this is not a second copy of `pathRefusal`
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape: two deciders
 * that agree are behaviourally one, and a mutation of either leaves the other
 * holding the case up. These two answer different questions and each has an
 * input ONLY it reaches, asserted below by name:
 *
 *   - only the shape decider:  `lib/a.ts modified by marcus`
 *     `SHELL_METACHARACTERS` is `/[;&|$`\n\r"'\\(){}[\]<>!~*?#]/` — no space,
 *     no tab. A space-separated annotation carrying no metacharacter is
 *     accepted by `pathRefusal` today, in both phases, and fails at `git add`
 *     with `pathspec did not match`.
 *   - only `pathRefusal`:      `lib/a;rm.ts`
 *     one token, no whitespace, no annotation — shaped exactly like a path,
 *     and genuinely unsafe. The shape decider must NOT refuse it, or the
 *     operator gets the wrong sentence in the other direction.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * The 5pm repair for "the run died on a metacharacter" is to strip the
 * annotation — `el.split(' ')[0]` — somewhere upstream and carry on. Every
 * case here survives that, because they assert a REFUSAL rather than a
 * collected list: a sanitised path is a path the agent did not report, and
 * #114 already cost this repo one run filed under a different project.
 * `AC-2 / the bare path is quoted, not substituted` pins that directly.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria (SC-2046..SC-2050)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * The ship.js under observation. `SHIP_UNDER_TEST` is how
 * `test/files-changed-shape-mutation.test.ts` points this identical file at a
 * mutant copy (AC-6) — nothing else sets it, so an ordinary run reads the
 * real source.
 */
const SHIP_PATH = process.env.SHIP_UNDER_TEST || join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ${SHIP_PATH}`);
  const slice = shipSource.slice(start, end);
  // A slice that failed to find its own section is an empty string, and an
  // empty string contains nothing — which is indistinguishable from a clean
  // result (checks-must-be-able-to-fail.md, "search the slice").
  if (slice.trim().length === 0) throw new Error(`${name} block is empty`);
  return slice;
}

type ShapeRefusal = (r: unknown, label: string) => string | null;

function loadShapeGuard(): ShapeRefusal {
  return new Function(
    `${block("FILES-CHANGED-SHAPE")}\nreturn filesChangedShapeRefusal;`,
  )() as ShapeRefusal;
}

const filesChangedShapeRefusal = loadShapeGuard();

/** The real claim audit, with the real shared path table beneath it. */
function loadClaimAudit(): {
  auditWorktreeClaims: (r: unknown) => {
    violations: Array<{ worktreePath: string; path: string; detail: string }>;
    candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
  };
  pathRefusal: (p: string) => { rule: string; boundary: boolean } | null;
} {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${block("SECURITY-HELPERS")}\n${block("COLLECT-CLAIM")}\nreturn { auditWorktreeClaims, pathRefusal }`,
  )("/repo", () => {}) as never;
}

const { auditWorktreeClaims, pathRefusal } = loadClaimAudit();

/** The element measured on wf_68a566ab-500, as the agent reported it. */
const MEASURED = "lib/scaffold/steps.ts (modified — added the refusal, ~40 lines)";
/** The bare path that element would have been. */
const MEASURED_BARE = "lib/scaffold/steps.ts";

const ok = (filesChanged: unknown[]) => ({ success: true, filesChanged, taskSource: "brief" });

// ── AC-1 ─────────────────────────────────────────────────────
// SC-2046: every element is checked, at the implement result read.

describe("AC-1 / SC-2046: every filesChanged element is checked for bare repo-relative path shape", () => {
  test("the FILES-CHANGED-SHAPE block exists and is extractable", () => {
    expect(shipSource).toContain("// ──── FILES-CHANGED-SHAPE-START ────");
    expect(typeof filesChangedShapeRefusal).toBe("function");
  });

  test("the guard has exactly one definition, so there is one binding to mutate", () => {
    expect(shipSource.match(/function filesChangedShapeRefusal\b/g) ?? []).toHaveLength(1);
  });

  test("the measured element is refused", () => {
    expect(filesChangedShapeRefusal(ok([MEASURED]), "marcus")).not.toBeNull();
  });

  test("an ordinary list is NOT refused", () => {
    // The positive control. A guard that refuses every implement result
    // satisfies the case above and breaks the pipeline entirely.
    expect(
      filesChangedShapeRefusal(ok(["lib/a.ts", "test/a.test.ts", "docs/adr/ADR-001.md"]), "marcus"),
    ).toBeNull();
  });

  test("an element at any index is checked, not just the first", () => {
    // "Every element" is the claim. A loop that reads `filesChanged[0]` and
    // stops satisfies the measured case above and misses the real run, where
    // the annotated path was not first.
    const refusal = filesChangedShapeRefusal(ok(["lib/a.ts", "test/a.test.ts", MEASURED]), "marcus");
    expect(refusal, "a trailing annotated element was accepted").not.toBeNull();
    expect(refusal).toContain("filesChanged[2]");
  });

  test("a non-string element is refused rather than coerced", () => {
    // The schema says `items: { type: 'string' }` and that is exactly the
    // declaration this issue is about: it is not enforced here, so the guard
    // may not assume it.
    expect(filesChangedShapeRefusal(ok([42]), "marcus")).not.toBeNull();
    expect(filesChangedShapeRefusal(ok([null]), "marcus")).not.toBeNull();
    expect(filesChangedShapeRefusal(ok([""]), "marcus")).not.toBeNull();
    expect(filesChangedShapeRefusal(ok(["   "]), "marcus")).not.toBeNull();
  });

  test("an already-failed result is left to its own handler", () => {
    // One question per guard. A `success: false` result is refused by the
    // caller's own branch with its own findings, and reporting it twice under
    // a different reason misattributes the failure — the same boundary
    // `implementRefusal` draws.
    expect(filesChangedShapeRefusal({ success: false, filesChanged: [MEASURED] }, "marcus")).toBeNull();
  });

  test("an empty or absent list is left to implementRefusal", () => {
    // Also one question per guard, from the other side: "changed no files" is
    // #181's refusal and it carries #181's explanation. A second refusal for
    // the same input would be the fourth shape.
    expect(filesChangedShapeRefusal(ok([]), "marcus")).toBeNull();
    expect(filesChangedShapeRefusal({ success: true }, "marcus")).toBeNull();
    expect(filesChangedShapeRefusal({ success: true, filesChanged: "lib/a.ts" }, "marcus")).toBeNull();
  });

  test("the label identifies WHICH agent, so a sub-issue is distinguishable", () => {
    expect(filesChangedShapeRefusal(ok([MEASURED]), "marcus-sub-599001"))
      .toContain("marcus-sub-599001");
  });

  test("the annotation shapes a real agent reaches for are each refused, and named", () => {
    // Not one regex wearing six names: each row asserts the rule it is
    // refused UNDER, so collapsing the table into a single catch-all turns
    // these red rather than leaving them green on a message that says less.
    const ROWS: Array<[string, string]> = [
      ["lib/a.ts (modified)", "whitespace"],
      ["lib/a.ts — new file", "whitespace"],
      ["lib/a.ts(new)", "a trailing parenthetical"],
      ["lib/a.ts[new]", "a trailing parenthetical"],
      ["`lib/a.ts`", "markdown emphasis or quote characters"],
      ["**lib/a.ts**", "markdown emphasis or quote characters"],
    ];
    for (const [element, rule] of ROWS) {
      const refusal = filesChangedShapeRefusal(ok([element]), "marcus");
      expect(refusal, `${element} was accepted`).not.toBeNull();
      expect(refusal, `${element} was refused under the wrong rule`).toContain(rule);
    }
  });

  test("paths this repository actually contains are all accepted", () => {
    // The population the guard must not refuse, read from the tree rather
    // than imagined: 0 of 957 tracked paths carry whitespace or a bracket.
    const REAL = [
      "workflows/ship.js",
      "lib/workflow-security.ts",
      "test/claim-path-safety-parity.test.ts",
      "specs/HARNESS-STANDARD.md",
      ".claude/rules/checks-must-be-able-to-fail.md",
      "docs/adr/ADR-001.md",
      "scripts/github-op.ts",
      "x.ts",
    ];
    expect(filesChangedShapeRefusal(ok(REAL), "marcus")).toBeNull();
  });
});

// ── AC-2 ─────────────────────────────────────────────────────
// SC-2047: the message names the annotation and quotes the bare path.

describe("AC-2 / SC-2047: the refusal names the annotation and quotes the bare path", () => {
  const refusal = filesChangedShapeRefusal(ok([MEASURED]), "marcus")!;

  test("it names the annotation as the problem", () => {
    expect(refusal).not.toBeNull();
    expect(refusal.toLowerCase()).toContain("annotat");
  });

  test("it quotes the bare path the element would have been", () => {
    // The operator's next action is "report this instead". A refusal that
    // does not say what "this" is sends them back to the transcript, which is
    // the cost #181 already measured on `testOutput`.
    expect(refusal).toContain(JSON.stringify(MEASURED_BARE));
  });

  test("the bare path is QUOTED, not substituted — the element is still refused", () => {
    // The cheapest wrong fix, named and blocked. Stripping the annotation and
    // collecting `lib/scaffold/steps.ts` makes the symptom go away and files
    // the run under a path the agent never reported. A guard that returned
    // the repaired list instead of a refusal would satisfy every other case
    // in this file.
    expect(typeof refusal).toBe("string");
    expect(refusal.length).toBeGreaterThan(0);
  });

  test("it quotes the element as the agent reported it", () => {
    expect(refusal).toContain(JSON.stringify(MEASURED));
  });

  test("an element with no recoverable bare path says so, rather than quoting nothing", () => {
    // `""` spliced into a sentence reads as a truncated report, which is the
    // distinction #181 drew for "no explanation reported".
    const r = filesChangedShapeRefusal(ok(["(modified three files)"]), "marcus")!;
    expect(r).not.toBeNull();
    expect(r).toMatch(/no bare path/i);
  });
});

// ── AC-3 ─────────────────────────────────────────────────────
// SC-2048: refused by the phase that read the agent result; nothing annotated
// reaches the collection audit.

describe("AC-3 / SC-2048: the implement phase refuses it, so the audit never sees it", () => {
  test("both implement paths consult the guard", () => {
    const fn = shipSource.slice(shipSource.indexOf("async function runImplement()"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "runImplement does not call the shape guard")
      .toContain("filesChangedShapeRefusal(");

    const dec = block("DECOMPOSED-SHIP");
    expect(dec, "the decomposed path never calls the shape guard")
      .toContain("filesChangedShapeRefusal(");
    // Per sub-issue, before the union: `allFilesChanged` flattens every list
    // together, so one sub-issue's annotated element is invisible the moment
    // the lists are merged — #181 AC-3's trap, same place.
    expect(dec.indexOf("filesChangedShapeRefusal("))
      .toBeLessThan(dec.indexOf("const allFilesChanged"));
  });

  test("the guard runs BEFORE the claim audit — it is in the implement block, not the collector", () => {
    // Ordering as source position, because the two blocks are in one file and
    // the collection audit is what the run reaches afterwards.
    expect(shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-START ────"))
      .toBeLessThan(shipSource.indexOf("function auditWorktreeClaims"));
  });

  test("CONTROL: the audit IS reachable, and the annotated element DOES produce a violation there", () => {
    // The pre-fix behaviour, performed. Without this the "0 reached the
    // audit" assertion below is satisfied by an audit that refuses
    // everything, or by a fixture the audit never sees — a 0 with no
    // believable baseline beside it.
    const audit = auditWorktreeClaims([
      { worktreePath: "/wt/a", filesChanged: [MEASURED], claimedFiles: [MEASURED] },
      { worktreePath: "/wt/b", filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    const hit = audit.violations.filter(v => v.worktreePath === "/wt/a");
    expect(hit, "the annotated element did not reach the audit at all").toHaveLength(1);
    // And this is the sentence that cost 103 minutes: it is about git add.
    expect(hit[0]!.detail).toContain("git add refuses the path");
  });

  test("a run whose implement reader ran hands the audit ZERO annotated elements", async () => {
    const { run, logs } = loadRunDecomposedShip(async (p: string) => ({
      success: true,
      worktreePath: "/wt/a",
      worktreeRepo: "git@github.com:owner/project.git",
      taskSource: "brief",
      filesChanged: p.includes("beta") ? [MEASURED] : ["lib/alpha.ts"],
      testOutput: "2 pass",
    }));
    const result: any = await run(SUBS);

    expect(result.success, "an annotated element shipped anyway").toBe(false);
    expect(logs.join("\n")).toMatch(/Sub-issue FAILED: beta/);
    expect(logs.join("\n"), "the refusal did not name the annotation")
      .toMatch(/annotat/i);

    // What the run would hand forward, fed to the REAL audit. Not a
    // re-implemented comparison — the predicate that decides collection.
    const forwarded: string[] = Array.isArray(result?.buildResult?.filesChanged)
      ? result.buildResult.filesChanged
      : [];
    const annotatedReaching = forwarded.filter(f => f === MEASURED);
    expect(annotatedReaching, "an annotated element reached the collection audit")
      .toHaveLength(0);

    const audit = auditWorktreeClaims([
      { worktreePath: "/wt/a", filesChanged: forwarded, claimedFiles: forwarded },
    ]);
    expect(
      audit.violations.filter(v => v.detail.includes("git add refuses the path")),
      "the audit still produced the staging sentence, so something annotated got through",
    ).toHaveLength(0);
  });

  test("a batch where every element is a bare path still ships", async () => {
    // The positive control for the run, not just for the predicate.
    const { run } = loadRunDecomposedShip(async (_p: string, o: { label: string }) => ({
      success: true,
      worktreePath: "/wt/a",
      worktreeRepo: "git@github.com:owner/project.git",
      taskSource: "brief",
      filesChanged: [`lib/${o.label}.ts`],
      testOutput: "2 pass",
    }));
    const result: any = await run(SUBS);
    expect(result.success).toBe(true);
    expect(result.buildResult.filesChanged).toHaveLength(2);
  });
});

// ── AC-4 ─────────────────────────────────────────────────────
// SC-2049: the format is STATED, in the schema and in the prompt.

describe("AC-4 / SC-2049: the schema and the implement prompt both state the format", () => {
  const FORMAT = "bare repo-relative path";

  /** The `filesChanged` property of BUILD_RESULT_SCHEMA, sliced out. */
  function schemaSlice(): string {
    const at = shipSource.indexOf("const BUILD_RESULT_SCHEMA = {");
    expect(at, "BUILD_RESULT_SCHEMA was not found").toBeGreaterThan(-1);
    const body = shipSource.slice(at, shipSource.indexOf("\n}\n", at));
    const f = body.indexOf("filesChanged:");
    expect(f, "BUILD_RESULT_SCHEMA declares no filesChanged").toBeGreaterThan(-1);
    const slice = body.slice(f, body.indexOf("testFiles:", f));
    expect(slice.trim().length, "the filesChanged slice came back empty").toBeGreaterThan(0);
    return slice;
  }

  /** The marcus implement prompt in `runImplement`, sliced out. */
  function promptSlice(): string {
    const at = shipSource.indexOf("async function runImplement()");
    expect(at, "runImplement was not found").toBeGreaterThan(-1);
    const open = shipSource.indexOf("const buildResult = await briefedAgent(`", at);
    expect(open, "the implement prompt was not found").toBeGreaterThan(-1);
    const slice = shipSource.slice(open, shipSource.indexOf("`, {", open));
    expect(slice.trim().length, "the prompt slice came back empty").toBeGreaterThan(0);
    return slice;
  }

  test("the schema declares the format on filesChanged itself", () => {
    // Searched in the SLICE. `bare repo-relative path` appears elsewhere in
    // ship.js by the end of this change, and a whole-file search would be
    // satisfied by the refusal message naming it.
    expect(schemaSlice()).toContain(FORMAT);
  });

  test("the same format is stated in the implement prompt", () => {
    expect(promptSlice()).toContain(FORMAT);
  });

  test("the prompt says what to do with the explanation instead", () => {
    // Stating the format without saying where the prose goes produces an
    // agent that drops the explanation, which is strictly worse than the
    // annotation: #181 is the issue about an explanation reaching nothing.
    expect(promptSlice()).toMatch(/findings/);
  });

  test("both statements are read out of ship.js, not restated here", () => {
    // Two format statements, from two slices of the source. The constant
    // above is the only literal, and it is the thing being looked for.
    const found = [schemaSlice(), promptSlice()].filter(s => s.includes(FORMAT));
    expect(found).toHaveLength(2);
  });
});

// ── AC-5 ─────────────────────────────────────────────────────
// SC-2050: two deciders, two sentences, and an input only each one reaches.

describe("AC-5 / SC-2050: the staging sentence and the annotation sentence are distinct", () => {
  const STAGING_SENTENCE = "git add refuses the path";

  test("a genuine shell metacharacter still gets pathRefusal's staging sentence, unchanged", () => {
    const v = auditWorktreeClaims([
      { worktreePath: "/wt/a", filesChanged: ["lib/a;rm.ts"], claimedFiles: ["lib/a;rm.ts"] },
      { worktreePath: "/wt/b", filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]).violations.filter(x => x.worktreePath === "/wt/a");
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toContain("a shell metacharacter");
    expect(v[0]!.detail).toContain(STAGING_SENTENCE);
  });

  test("the annotated element gets the annotation sentence, and NOT the staging sentence", () => {
    const refusal = filesChangedShapeRefusal(ok([MEASURED]), "marcus")!;
    expect(refusal.toLowerCase()).toContain("annotat");
    expect(refusal, "the shape refusal borrowed the staging sentence")
      .not.toContain(STAGING_SENTENCE);
  });

  test("an input ONLY pathRefusal reaches: a one-token path carrying a metacharacter", () => {
    // Establishes presence on both sides before comparing (#518): the shape
    // decider is asked and answers null, the path table is asked and refuses.
    // Without this the two are a collapsed pair and a mutation of either
    // leaves the other holding every case above.
    expect(filesChangedShapeRefusal(ok(["lib/a;rm.ts"]), "marcus"))
      .toBeNull();
    expect(pathRefusal("lib/a;rm.ts")).not.toBeNull();
  });

  test("an input ONLY the shape decider reaches: a space-separated annotation", () => {
    // `SHELL_METACHARACTERS` contains no space and no tab, so this is
    // accepted by the path table in BOTH phases today and dies at `git add`
    // with `pathspec did not match`. It is the hole this issue leaves behind
    // if the two deciders are merged.
    const annotated = "lib/a.ts modified by marcus";
    expect(pathRefusal(annotated), "the path table already refuses it — the pair is collapsed")
      .toBeNull();
    expect(filesChangedShapeRefusal(ok([annotated]), "marcus")).not.toBeNull();
  });
});

// ── the decomposed-ship harness ──────────────────────────────
// Modelled on test/implement-empty-result.test.ts, which runs the real block
// rather than grepping it: grepping proves the guard is called, not that its
// answer changes anything.

const SUBS = [
  { number: 1, title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { number: 2, title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
];

function loadRunDecomposedShip(agent: (p: string, o: { label: string }) => Promise<unknown>) {
  const marked = (name: string) => block(name);
  const guard = new Function(`${marked("IMPLEMENT-RESULT")}\nreturn implementRefusal;`)();
  const identity = new Function(`${marked("WORKTREE-IDENTITY")}\nreturn worktreeIdentity;`)();
  const taskSource = new Function(`${marked("BRIEF-PRECEDENCE")}\nreturn taskSourceRefusal;`)();
  const waveNeedsIntegration = new Function(`${marked("RUN-REF")}\nreturn waveNeedsIntegration;`)();

  const logs: string[] = [];
  // The shape block is EVALUATED INTO the decomposed block's scope rather
  // than injected as a parameter. A stub would let this suite and the real
  // block disagree about what an annotated element is, and nothing would
  // notice — which is the defect one layer up.
  const factory = new Function(
    "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal",
    "worktreeIdentity", "REPO", "taskSourceRefusal",
    "establishRunRef", "integrateWave", "waveNeedsIntegration",
    "measureLaunchBase",
    `${marked("FILES-CHANGED-SHAPE")}\n${marked("DECOMPOSED-SHIP")}\nreturn runDecomposedShip;`,
  );
  const run = factory(
    (m: string) => logs.push(String(m)),
    agent,
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    "/tmp/work", 611, REPO_ROOT, {},
    async () => ({ success: true, buildResult: {} }),
    guard,
    identity,
    "owner/project",
    taskSource,
    async () => ({ branch: "rungate/run-611", refusal: null }),
    async () => ({ ok: true, integrated: 0 }),
    waveNeedsIntegration,
    async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
  );
  return { run, logs };
}
