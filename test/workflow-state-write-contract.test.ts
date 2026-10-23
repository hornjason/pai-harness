/**
 * The write contract for `workflow-state.json` — asserted, not described.
 *
 * Issue: #1152. Two hooks decide every `Write` or `Edit` whose `file_path` is
 * `workflow-state.json`, and until this file existed nothing in the repository
 * stated what either one answers, which is authoritative, or where they
 * disagree. The prose half of the answer is in
 * `specs/HOOK-ARCHITECTURE-SPEC.md` § "The workflow-state.json write contract";
 * this file is the binding, and the table below is the contract itself rather
 * than a description of one.
 *
 * ## Why a measured table and not a sentence
 *
 * The two hooks are "two deciders that agree" —
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape — on most
 * inputs, which is exactly the configuration no ordinary behavioural test can
 * see through: the blanket guard refuses first, so the specific guard's
 * ALLOW-path is never observed in this tree and a mutation of it leaves the
 * blanket guard holding the case up. The only instrument that separates them
 * is one that runs **each hook on its own** over a corpus and records both
 * answers side by side. That is what this does.
 *
 * ## The two hooks, and what each one is for
 *
 * | hook | question it answers | reach |
 * |---|---|---|
 * | `WorkflowStateGuard` | "was this artifact written by a tool call at all?" | ships to consumers (`deployToConsumers: true`) |
 * | `GateResultProtection` | "does this write forge, erase or change a gate verdict?" | harness-only today (`deployToConsumers: false`, OPT-IN) |
 *
 * **`WorkflowStateGuard` is authoritative for whether the artifact may be
 * written by a tool call; `GateResultProtection` is authoritative for what a
 * permitted write may contain.**
 *
 * Since #1211 the containment runs ONE way: everything the specific guard
 * refuses, the blanket guard also refuses, and rows 2, 3, 9, 13 and 14 are
 * inputs the blanket guard refuses and the specific guard allows. That is the
 * correct direction and it is now asserted in both halves below. Until #1211
 * the set pointing the other way was non-empty, and its single member was row
 * 8 — a hole in the SHIPPING guard. A guard pair whose non-redundancy rests on
 * one of them having a gap is not defence in depth, so the claim that used to
 * require that member now forbids it.
 *
 * ## Reading a row
 *
 * Every row is run twice, once per hook, as a **subprocess from `hooks/`**, so
 * the relative imports resolve the way they do in a session. A hook that fails
 * to load exits 0 with no output, which is byte-identical to a permit — so a
 * non-zero exit or any stderr is recorded as `UNMEASURED` and fails, and the
 * positive controls below are asserted before any row is read. Without them a
 * table of fourteen `ALLOWED`s would look like a clean bill of health.
 *
 * ## WHICH TREE these readings are from, and how that was resolved (#713, #1216)
 *
 * A decision table that does not name its tree has the defect it is trying to
 * describe: correct about some bytes, silent about which. So this one names
 * it, and the naming is a reading rather than a comment — see
 * "the tree under measurement" below, which resolves the spawned paths and
 * asserts they are inside the tree the suite itself runs from.
 *
 * **These rows measure `<this tree>/hooks/`** — the copies this repository
 * owns, reviews and publishes. That is the right scope for a contract test
 * and it is also a LIMIT, because it is not automatically what executes in a
 * session on any particular machine.
 *
 * Which copy executes cannot be decided by looking at a path. Every
 * registration is spelled through a variable, so the question is what that
 * variable resolves to on the machine doing the reading —
 * `lib/hook-target-tree.ts` is the binding that answers it, and
 * `registrationTree` in `lib/hook-trees.ts` deliberately does NOT: it answers
 * which root a command is *spelled* with, and the spelling was right in #999
 * while the bytes were a different tree's.
 *
 * Resolved with `registeredTreeCensus` on 2026-10-22 against this machine,
 * with `repoRoot` as the shared primary checkout — reading `MEASURED`, four
 * registrations examined, no unresolved variables:
 *
 * | hook | scope | spelled through | resolves to | target |
 * |---|---|---|---|---|
 * | `WorkflowStateGuard` | project-settings | `CLAUDE_PROJECT_DIR` | `<repo>/hooks/` | in-repo |
 * | `WorkflowStateGuard` | repo-registry | `RUNGATE_HOOKS_DIR` | `<repo>/hooks/` | in-repo |
 * | `GateResultProtection` | user-settings, ×2 (Write, Edit) | `PAI_HOOKS_DIR` | a tree outside this repository | **foreign** |
 *
 * So the blanket guard's rows describe bytes that do run. **The specific
 * guard's rows describe bytes this repository owns and that a session on this
 * machine does not execute** — its user-scope registration resolves outside
 * the repo entirely, which is #713, and it means a merged fix to the repo
 * copy does not reach a live session. Nothing here is a claim about the
 * contents of that other tree; it was not read, and the resolution is from
 * the registration strings and the `env` blocks alone.
 *
 * Two further cautions a reader needs, both measured rather than reasoned:
 *
 *  - `RUNGATE_HOOKS_DIR` names the shared primary checkout, so the same
 *    registration reads `in-repo` from there and `foreign` from every agent
 *    worktree. A `foreign` verdict is only a finding once you know which root
 *    produced it.
 *  - Resolving `in-repo` does not make the bytes CURRENT. That primary
 *    checkout was measured 180 commits behind `origin/main`, which is #1216.
 *    `hook-target-tree` answers *which directory*, never *which commit*.
 *
 * ## Changing this file
 *
 * A row whose reading moves means a hook's behaviour moved. Update the row in
 * the same commit as the change and say which hook moved and why. Do not
 * delete a row to make the suite green.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

const ROOT = join(import.meta.dir, "..");
const BLANKET = join(ROOT, "hooks", "WorkflowStateGuard.hook.ts");
const SPECIFIC = join(ROOT, "hooks", "GateResultProtection.hook.ts");

/** The only two readings a row may carry. Anything else is UNMEASURED. */
type Verdict = "REFUSED" | "ALLOWED";

interface Row {
  /** Stable id, used in failure messages. */
  id: string;
  tool: string;
  /** Plants any prior state under `dir` and returns the `tool_input`. */
  build: (dir: string) => Record<string, unknown>;
  blanket: Verdict;
  specific: Verdict;
  /** Why the pair reads the way it does. Required on every divergent row. */
  note: string;
}

const j = (o: unknown) => JSON.stringify(o, null, 2);

function plant(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

/**
 * The contract. First measured on 2026-10-22 against `origin/main` at
 * `dbf10445`; re-measured on 2026-10-23 for #1211, which moved row 8.
 *
 * Five of the fourteen rows diverge. Three are the intended blanket/specific
 * split (2, 3, 13); two are accidents of two independently written path
 * predicates (9, 14), both benign and both left alone. Row 8 was the third
 * such accident and the only one in the dangerous direction — the blanket
 * guard permitting what the specific guard refused — and #1211 closed it by
 * case-folding the blanket guard's matcher.
 */
const CONTRACT: Row[] = [
  {
    id: "1 write-forged-result",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD" }));
      return { file_path: p, content: j({ phase: "BUILD", gates: { scope: { result: "PASS" } } }) };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note: "The attack both hooks exist for. Also the specific guard's positive control.",
  },
  {
    id: "2 write-legitimate-no-results",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "SCOPE", acs: [] }));
      return { file_path: p, content: j({ phase: "BUILD", acs: ["AC-1"] }) };
    },
    blanket: "REFUSED",
    specific: "ALLOWED",
    note:
      "INTENDED DIVERGENCE. Adding an AC and advancing SCOPE to BUILD forges no verdict, " +
      "so the specific guard permits it; the blanket guard refuses because the sanctioned " +
      "writer is writeWorkflowState(), not the Write tool. This row is the specific guard's " +
      "ALLOW-path, which #1152 says is unobservable while the blanket guard fires first.",
  },
  {
    id: "3 edit-legitimate",
    tool: "Edit",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD", changelog: "old" }));
      return { file_path: p, old_string: '"old"', new_string: '"new"' };
    },
    blanket: "REFUSED",
    specific: "ALLOWED",
    note: "INTENDED DIVERGENCE. Same split as row 2, on the Edit branch.",
  },
  {
    id: "4 write-erases-result",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD", gates: { scope: { result: "FAIL" } } }));
      return { file_path: p, content: j({ phase: "BUILD" }) };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note: "Erasing a FAIL reaches the same end as forging a PASS. Second positive control.",
  },
  {
    id: "5 write-unparseable",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD" }));
      return { file_path: p, content: "not json at all" };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note: "UNMEASURED refuses on both. The specific guard's half of this is #1137.",
  },
  {
    id: "6 write-non-object",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD" }));
      return { file_path: p, content: "[]" };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note: "A workflow state is always an object; an array is a reading neither can take.",
  },
  {
    id: "7 edit-renames-gates-key",
    tool: "Edit",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD", gates: { scope: { result: "FAIL" } } }));
      return { file_path: p, old_string: '"gates"', new_string: '"gates_old"' };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note:
      "Erasure of the PATH to a result rather than of the result. The specific guard sees " +
      "it only because #1151 made the Edit branch model its outcome instead of its fragments.",
  },
  {
    id: "8 uppercase-path-forged-result",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "WORKFLOW-STATE.JSON", j({ phase: "BUILD" }));
      return { file_path: p, content: j({ phase: "BUILD", gates: { scope: { result: "PASS" } } }) };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note:
      "CONVERGED in #1211. This row read blanket=ALLOWED until the blanket guard's matcher " +
      "was case-folded: it matched with a case-SENSITIVE String.includes() while the " +
      "specific guard case-FOLDED, because #1184 measured that WORKFLOW-STATE.JSON and " +
      "workflow-state.json resolve to the same inode on a case-insensitive filesystem. " +
      "#1184 closed it in the specific guard and the fix was never carried to the blanket " +
      "one — the SHIPPING one, so on a consumer tree, where the specific guard is not " +
      "deployed, a forged result at the uppercase spelling reached disk unguarded. " +
      "The population the fold newly claims is bounded in " +
      "test/workflow-state-guard-case.test.ts, which measures the old matcher alongside " +
      "the new one; this row is the same input seen from inside the two-hook contract.",
  },
  {
    id: "9 sibling-backup-path-forged",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json.bak", j({ phase: "BUILD" }));
      return { file_path: p, content: j({ phase: "BUILD", gates: { scope: { result: "PASS" } } }) };
    },
    blanket: "REFUSED",
    specific: "ALLOWED",
    note:
      "UNINTENDED DIVERGENCE, benign direction. `.includes()` matches a substring anywhere, " +
      "so the blanket guard refuses any sibling path carrying the name; the specific guard " +
      "uses `.endsWith()` and allows it, correctly — a .bak file is not the artifact any gate " +
      "reads. Over-blocking costs a rename; it is the direction to be wrong in.",
  },
  {
    id: "10 unrelated-file",
    tool: "Write",
    build: (d) => ({ file_path: join(d, "README.md"), content: "# hi" }),
    blanket: "ALLOWED",
    specific: "ALLOWED",
    note:
      "NEGATIVE CONTROL. Neither hook is a blanket refuser, so an ALLOWED elsewhere in this " +
      "table is a reading and not the instrument having stopped reporting.",
  },
  {
    id: "11 non-matching-tool",
    tool: "Bash",
    build: (d) => ({ command: `echo hi > ${join(d, "workflow-state.json")}` }),
    blanket: "ALLOWED",
    specific: "ALLOWED",
    note:
      "Both are PreToolUse on Write|Edit and neither reads a Bash command. The artifact IS " +
      "reachable from Bash; a separate hook covers that and it is outside this contract.",
  },
  {
    id: "12 write-advances-to-done",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD" }));
      return { file_path: p, content: j({ phase: "DONE" }) };
    },
    blanket: "REFUSED",
    specific: "REFUSED",
    note: "Only the gate runner advances a run to DONE.",
  },
  {
    id: "13 edit-already-done-run",
    tool: "Edit",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "DONE", changelog: "old" }));
      return { file_path: p, old_string: '"old"', new_string: '"new"' };
    },
    blanket: "REFUSED",
    specific: "ALLOWED",
    note:
      "INTENDED DIVERGENCE. DONE is a transition, not a resting state: the specific guard " +
      "refuses the advance (row 12) and permits an edit to a run that was already there. " +
      "Reading the resting value as an event over-blocked 6 of 157 legitimate operations " +
      "when #1137 first tried it.",
  },
  {
    id: "14 path-key-not-file_path",
    tool: "Write",
    build: (d) => {
      const p = plant(d, "workflow-state.json", j({ phase: "BUILD" }));
      return { path: p, content: j({ phase: "BUILD", gates: { scope: { result: "PASS" } } }) };
    },
    blanket: "REFUSED",
    specific: "ALLOWED",
    note:
      "UNINTENDED DIVERGENCE, currently unreachable. The blanket guard falls back to a " +
      "`path` key the Write and Edit tools never send; the specific guard reads only " +
      "`file_path`. Recorded because an unreachable divergence is how a reachable one " +
      "arrives — a tool schema change makes this row live without touching either hook.",
  },
];

/**
 * Every path actually handed to `Bun.spawn`, as it was spawned.
 *
 * Collected rather than re-derived: the provenance case below asserts the
 * tree the rows were MEASURED against, and re-computing the constants there
 * would assert that two copies of one expression agree — the vacuous shape.
 */
const spawnedPaths = new Set<string>();

/** One hook, one payload, one reading — or UNMEASURED. */
async function decide(hookPath: string, payload: unknown): Promise<string> {
  spawnedPaths.add(hookPath);
  const proc = Bun.spawn(["bun", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // A hook that failed to load exits 0 and prints nothing, which is exactly
  // what a permit looks like. Neither of these may be collapsed into ALLOWED.
  if (code !== 0) return `UNMEASURED(exit ${code}): ${err.trim().slice(0, 200)}`;
  if (err.trim()) return `UNMEASURED(stderr): ${err.trim().split("\n")[0].slice(0, 200)}`;

  const text = out.trim();
  if (!text) return "ALLOWED";
  try {
    const parsed = JSON.parse(text) as { decision?: string };
    if (parsed.decision === "block") return "REFUSED";
    return `UNMEASURED(decision ${String(parsed.decision)})`;
  } catch {
    return `UNMEASURED(unparseable stdout): ${text.slice(0, 200)}`;
  }
}

const readings = new Map<string, { blanket: string; specific: string }>();

beforeAll(async () => {
  for (const row of CONTRACT) {
    const dir = mkdtempSync(join(tmpdir(), "ws-write-contract-"));
    try {
      const payload = {
        hook_event_name: "PreToolUse",
        tool_name: row.tool,
        tool_input: row.build(dir),
      };
      readings.set(row.id, {
        blanket: await decide(BLANKET, payload),
        specific: await decide(SPECIFIC, payload),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

describe("#1152 the load path is live before any row is read", () => {
  // Asserted first and separately. On #1151's sibling a probe of this hook
  // reported "allowed" for a forged result and the finding was the harness:
  // the module failed to resolve and the trigger's catch-all exited 0. A
  // control that traverses the same load path as the cases is the only thing
  // that tells a permit from a hook that never ran.
  test("GateResultProtection refuses a forged result, so lib/ resolved", () => {
    expect(readings.get("1 write-forged-result")?.specific).toBe("REFUSED");
  });

  test("GateResultProtection refuses an erasure, so the prior-state read ran", () => {
    expect(readings.get("4 write-erases-result")?.specific).toBe("REFUSED");
  });

  test("WorkflowStateGuard refuses the artifact it is pointed at", () => {
    expect(readings.get("1 write-forged-result")?.blanket).toBe("REFUSED");
  });

  test("neither hook is a blanket refuser", () => {
    const control = readings.get("10 unrelated-file");
    expect([control?.blanket, control?.specific]).toEqual(["ALLOWED", "ALLOWED"]);
  });
});

describe("#1152 the tree under measurement, named by reading it (#713, #1216)", () => {
  // A table that does not name its tree is the #999 defect in miniature:
  // right about some bytes, silent about which. These assert the provenance
  // instead of asserting it in a comment, and they are about the paths that
  // were SPAWNED, not about the constants re-evaluated a second time.
  //
  // What makes them able to fail, measured rather than asserted: copy the
  // specific guard and the two modules it imports into a temp tree, so it
  // loads and decides IDENTICALLY, then point SPECIFIC at that copy. Both
  // cases below go red and all fourteen rows stay green — which is exactly
  // the failure mode they exist for, since a table measuring another
  // checkout's bytes reads no differently from one measuring this repo's.
  //
  // The primary checkout is not usable as that mutation: it predates #713's
  // migration and has no copy of this hook at all, so pointing there is a
  // load error and reddens every row instead of isolating provenance.
  const hooksDir = realpathSync(join(ROOT, "hooks"));

  // Derived from ROOT, deliberately NOT from BLANKET/SPECIFIC. Comparing the
  // spawned set against the same two constants that produced it is a
  // declaration asserting itself: measured, a mutation repointing SPECIFIC at
  // an identical-behaviour copy in another tree left that version green, and
  // only the realpath case below caught it. This is the second time the
  // vacuous shape got into this file — both times by comparing a reading
  // against the expression that generated it.
  const expected = ["GateResultProtection", "WorkflowStateGuard"].map((h) =>
    join(ROOT, "hooks", `${h}.hook.ts`),
  );

  test("the rows spawned exactly the two hooks this contract is about", () => {
    expect(
      [...spawnedPaths].sort(),
      "the rows measured a different set of binaries than the two this contract names, so " +
        "the table above is about something other than what it claims",
    ).toEqual(expected.sort());
  });

  test("every spawned hook resolves inside the tree this suite runs from", () => {
    const escaped = [...spawnedPaths]
      .map((p) => ({ p, real: realpathSync(p) }))
      .filter(({ real }) => dirname(real) !== hooksDir);

    expect(
      escaped.map(({ p, real }) => `${p} -> ${real}`),
      `A row above would then be describing bytes from another checkout while reading as ` +
        `this repository's contract. Expected every spawned hook under ${hooksDir}.\n\n` +
        `This is the in-repo half of the question only. Which copy a SESSION executes is a ` +
        `different reading — the registrations are spelled through variables, and ` +
        `lib/hook-target-tree.ts resolves them. As of #1152 the specific guard's user-scope ` +
        `registration resolves OUTSIDE this repository (#713), and an in-repo resolution ` +
        `still says nothing about how current the bytes are (#1216).`,
    ).toEqual([]);
  });
});

describe("#1152 the workflow-state.json write contract", () => {
  for (const row of CONTRACT) {
    test(`${row.id}: WorkflowStateGuard ${row.blanket}, GateResultProtection ${row.specific}`, () => {
      const got = readings.get(row.id);
      expect(got, `row ${row.id} was never measured`).toBeDefined();
      expect(
        [got!.blanket, got!.specific],
        `The write contract moved on row "${row.id}".\n\n` +
          `  recorded: WorkflowStateGuard=${row.blanket}  GateResultProtection=${row.specific}\n` +
          `  measured: WorkflowStateGuard=${got!.blanket}  GateResultProtection=${got!.specific}\n\n` +
          `  why this row reads the way it does: ${row.note}\n\n` +
          `An UNMEASURED reading means the hook did not run — fix the harness, do not ` +
          `record it as a verdict. A changed verdict means a hook's behaviour moved: ` +
          `update this row and the table in specs/HOOK-ARCHITECTURE-SPEC.md ` +
          `(§ "The workflow-state.json write contract") in the same commit, and say ` +
          `which hook moved. Do not delete the row.`,
      ).toEqual([row.blanket, row.specific]);
    });
  }
});

describe("#1152 the pair has not collapsed, and it is subsumed the safe way round", () => {
  // Two claims about the SHAPE of the pair, in opposite directions, and the
  // asymmetry is the point.
  //
  //  - `only("blanket")` must be NON-EMPTY: if the blanket guard stops
  //    refusing anything the specific guard permits, the pair has collapsed
  //    into one decider, a mutation of either is invisible, and whichever is
  //    redundant can be deleted — the decision #1152 says nothing in the repo
  //    is in a position to make.
  //  - `only("specific")` must be EMPTY: a member there is an input the
  //    SHIPPING guard permits, which on a consumer tree is an unguarded write.
  //    See the case below for why that flipped in #1211.
  //
  // These read the MEASUREMENTS, not the table above. An earlier draft
  // filtered `CONTRACT`, which made them a declaration asserting itself: a
  // mutation that case-folded the blanket guard's matcher — collapsing the
  // pair in the specific-only direction — left them green, because the table
  // still said what it had always said. Measured: 1 red where 2 were
  // predicted, and the missing one was this. That mutation is now the shipped
  // code, and reverting it is what makes the second case below red.
  const only = (side: "blanket" | "specific") =>
    CONTRACT.filter((r) => {
      const got = readings.get(r.id);
      if (!got) return false;
      const other = side === "blanket" ? "specific" : "blanket";
      return got[side] === "REFUSED" && got[other] === "ALLOWED";
    }).map((r) => r.id);

  test("there are inputs only WorkflowStateGuard refuses", () => {
    expect(
      only("blanket").length,
      "every input the blanket guard refuses is now also refused by the specific guard, " +
        "so the pair is behaviourally one decider and a mutation of either is invisible",
    ).toBeGreaterThan(0);
  });

  // This case used to assert the MIRROR of the one above — that the specific
  // guard refuses something the blanket guard permits — and #1211 is the reason
  // it does not any more. Until #1211 the only input in that direction was row
  // 8, the uppercase spelling, and row 8 was a DEFECT in the shipping guard. So
  // the existence claim was being held up by the very gap this suite was written
  // to surface: fixing the gap emptied the set, and a green reading there had
  // meant "the shipping guard still has a hole", which is not a property anyone
  // wants to require.
  //
  // What replaces it is the containment claim, and it is strictly stronger. The
  // specific guard's refusals are a SUBSET of the blanket guard's by
  // construction — it refuses only `Write`/`Edit` whose `file_path` case-folded
  // ENDS WITH the artifact name, and the blanket guard refuses every
  // `Write`/`Edit` whose path case-folded CONTAINS it — so any row landing in
  // this direction means the shipping guard has acquired a hole the harness-only
  // guard can see. That is #1211's shape exactly, and this now reports it on
  // arrival instead of recording it as a healthy sign.
  //
  // Subsumed is not dead. The two are not deployed to the same trees — the
  // blanket guard is `deployToConsumers: true` and the specific guard is
  // OPT-IN, asserted below — so on a consumer tree the blanket guard is the only
  // one present, and in a session on this machine the specific guard's
  // registration resolves to a tree outside this repository (#713). Behavioural
  // subsumption holds within one tree holding both; neither of those is that.
  test("the shipping guard refuses everything the specific guard refuses", () => {
    expect(
      only("specific"),
      "GateResultProtection refuses an input WorkflowStateGuard permits. The blanket " +
        "guard is the one that SHIPS, so this is a gap on every consumer tree — the " +
        "specific guard is not deployed there and nothing else is watching the " +
        "artifact. #1211 was this, at WORKFLOW-STATE.JSON. Fix the blanket guard's " +
        "matcher rather than recording the row, and if the divergence is deliberate " +
        "say so in specs/HOOK-ARCHITECTURE-SPEC.md and explain what guards a consumer.",
    ).toEqual([]);
  });

  test("every divergent row carries a note saying why", () => {
    const divergent = CONTRACT.filter((r) => r.blanket !== r.specific);
    const unexplained = divergent.filter((r) => r.note.trim().length < 40);
    expect(
      unexplained.map((r) => r.id),
      "a row where the two hooks disagree and nobody wrote down why is the gap #1152 is about",
    ).toEqual([]);
  });
});

describe("#1152 the deployment half of the contract", () => {
  // The contract is only meaningful alongside which hook a consumer actually
  // gets. #1152's body has this backwards — it reasons that the specific guard
  // travels and the blanket one may not — so this binds the registry rather
  // than leaving the correction in prose that can go stale again.
  const entries = JSON.parse(
    readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8"),
  ) as Array<{ name: string; deployToConsumers?: boolean; notDeployedReason?: string }>;

  const byName = (n: string) => entries.find((e) => e.name === n);

  test("WorkflowStateGuard is the one that travels to a consumer", () => {
    expect(
      byName("WorkflowStateGuard")?.deployToConsumers,
      "WorkflowStateGuard is the guard a scaffolded consumer gets. If this flips, row 8's " +
        "case-folding divergence stops being a consumer-reachable gap and the spec's " +
        "authority table needs rewriting.",
    ).toBe(true);
  });

  test("GateResultProtection does not travel, and says why", () => {
    const e = byName("GateResultProtection");
    expect(
      e?.deployToConsumers,
      "If this is turned on, a consumer gains the specific guard and the contract above " +
        "becomes its full write contract too. Update the spec's authority table in the " +
        "same commit.",
    ).toBe(false);
    expect(
      (e?.notDeployedReason ?? "").length,
      "deployToConsumers: false with no notDeployedReason is 'nobody said', not a decision",
    ).toBeGreaterThan(0);
  });
});
