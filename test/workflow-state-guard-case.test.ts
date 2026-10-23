/**
 * #1211 — what `WorkflowStateGuard`'s path matcher claims authority over,
 * enumerated rather than sampled.
 *
 * The defect: the guard matched with a case-SENSITIVE `String.includes()`, so a
 * `Write` of a forged gate result to `WORKFLOW-STATE.JSON` was permitted. #1184
 * had already closed exactly this in `GateResultProtection` — which case-folds —
 * and the fix was never carried to the blanket guard. It is the blanket guard
 * that SHIPS (`deployToConsumers: true`), so on a scaffolded consumer tree,
 * where the specific guard is not deployed, that input reached disk with no
 * guard at all. In this repository the specific guard happened to cover it,
 * which is how an overlap hides a gap locally while leaving it open downstream.
 *
 * ## Why this file plants no files
 *
 * The guard is a pure predicate over the `file_path` STRING in the hook
 * payload — it never stats, opens or resolves anything. A fixture that planted
 * `WORKFLOW-STATE.JSON` and `workflow-state.json` and asserted something about
 * the pair would be asserting that APFS is case-insensitive, not that the guard
 * is case-folded, and it would read differently on a case-sensitive filesystem
 * while the guard had not moved. Every row below is a string handed to the
 * guard. The filesystem is not part of the instrument.
 *
 * (That the two spellings ARE one file on a case-insensitive filesystem is the
 * reason the fold is correct, and it was measured in #1184. It is a premise of
 * this fix, not a thing this file re-measures.)
 *
 * ## Why a mutant, and why the delta is the assertion
 *
 * A case-fold can only widen what a matcher refuses, and widening a guard is
 * not automatically safe: a fold that reached past the artifact would hand the
 * guard authority over files nobody decided it should hold. So the claim worth
 * binding is not "the uppercase spelling is now caught" — one row cannot say
 * anything about the population — but "the refusal set grew by EXACTLY these
 * case-variants, and shrank by nothing".
 *
 * That needs the before-reading, so this runs the pre-#1211 matcher as well:
 * the real hook spawned from `hooks/`, and a mutant copy with `.toLowerCase()`
 * deleted, which is the old code character for character. The two are run over
 * one corpus and the difference between them is measured. Deleting the fold
 * from the real hook makes `the fold widens by exactly the case-variants` and
 * `the uppercase spelling is refused` go red — that is the break, performed.
 *
 * Related: `test/workflow-state-write-contract.test.ts` row 8 is this same
 * input inside the two-hook contract; it flipped to REFUSED in the same commit.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const GUARD = join(ROOT, "hooks", "WorkflowStateGuard.hook.ts");

/** The one token whose presence is the fix. Deleting it restores the defect. */
const FOLD = ".toLowerCase()";

/** The only two readings a row may carry. Anything else is UNMEASURED. */
type Verdict = "REFUSED" | "ALLOWED";

interface Spelling {
  /** The `file_path` handed to the guard, verbatim. */
  path: string;
  /** What the guard answers today. */
  now: Verdict;
  /** What the pre-#1211 case-SENSITIVE matcher answered. */
  before: Verdict;
  why: string;
}

const PREFIX = "/work/run-1/";

/**
 * The population. Three groups: unchanged refusals, the widening, and the
 * near-misses the fold must NOT reach.
 */
const CORPUS: Spelling[] = [
  // --- refused before and after: the fold did not touch these ---
  {
    path: `${PREFIX}workflow-state.json`,
    now: "REFUSED",
    before: "REFUSED",
    why: "The canonical spelling. Also this file's positive control: a run where " +
      "this reads ALLOWED has a guard that did not load, not a guard that permits.",
  },
  {
    path: `${PREFIX}workflow-state.json.bak`,
    now: "REFUSED",
    before: "REFUSED",
    why: "`.includes()` matches a substring anywhere, so a sibling carrying the name is " +
      "refused. Over-blocking a backup costs a rename; it is the direction to be wrong " +
      "in, and it is row 9 of the write contract.",
  },
  {
    path: `${PREFIX}workflow-state.json5`,
    now: "REFUSED",
    before: "REFUSED",
    why: "The matcher is `.includes()`, not `.endsWith()` — recorded so the difference " +
      "from GateResultProtection's suffix match is a reading and not a surprise.",
  },
  {
    path: `${PREFIX}workflow-state.json/child.txt`,
    now: "REFUSED",
    before: "REFUSED",
    why: "A directory component carrying the name matches too. Same `.includes()` fact.",
  },

  // --- the widening: refused only after the fold. This group IS #1211. ---
  {
    path: `${PREFIX}WORKFLOW-STATE.JSON`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "#1211 exactly: the spelling a forged gate result reached disk through.",
  },
  {
    path: `${PREFIX}Workflow-State.Json`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "Mixed case. A fold that only handled all-caps would leave this open.",
  },
  {
    path: `${PREFIX}workflow-state.JSON`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "Extension only — the cheapest variant to type by hand.",
  },
  {
    path: `${PREFIX}WORKFLOW-STATE.json`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "Stem only, the complement of the row above.",
  },
  {
    path: `${PREFIX}WORKFLOW-STATE.JSON.bak`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "The substring rule and the fold composing. Benign direction, recorded " +
      "because it is part of what the fold newly claims.",
  },
  {
    path: `${PREFIX}WORKFLOW-STATE.JSON/child.txt`,
    now: "REFUSED",
    before: "ALLOWED",
    why: "Directory component and the fold composing. Same reason.",
  },

  // --- allowed before and after: the near-misses the fold must not reach ---
  {
    path: `${PREFIX}README.md`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "NEGATIVE CONTROL. The guard is not a blanket refuser, so a REFUSED elsewhere " +
      "in this table is a reading rather than the instrument having jammed shut.",
  },
  {
    path: `${PREFIX}workflow_state.json`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "Underscore, not hyphen. A fold is not a fuzzy match, and this row says so.",
  },
  {
    path: `${PREFIX}workflowstate.json`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "No separator at all.",
  },
  {
    path: `${PREFIX}workflow-state.yaml`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "The stem without the extension is not the artifact.",
  },
  {
    path: `${PREFIX}state.json`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "A substring of the name is not the name.",
  },
  {
    path: `${PREFIX}workflow-stat.json`,
    now: "ALLOWED",
    before: "ALLOWED",
    why: "One character short of matching — the boundary of what the matcher claims.",
  },
  {
    path: "",
    now: "ALLOWED",
    before: "ALLOWED",
    why: "No path named. A payload that names no file cannot be a write to the artifact.",
  },
];

/**
 * The widening, stated independently of the table above.
 *
 * The two measurements below produce this set by subtraction; this literal is a
 * third statement of it, so a row quietly edited from ALLOWED to REFUSED in the
 * table reddens here instead of silently enlarging what the guard may claim.
 */
const WIDENING: string[] = [
  `${PREFIX}WORKFLOW-STATE.JSON`,
  `${PREFIX}Workflow-State.Json`,
  `${PREFIX}workflow-state.JSON`,
  `${PREFIX}WORKFLOW-STATE.json`,
  `${PREFIX}WORKFLOW-STATE.JSON.bak`,
  `${PREFIX}WORKFLOW-STATE.JSON/child.txt`,
];

/** One guard, one payload, one reading — or UNMEASURED. */
async function decide(hookPath: string, payload: unknown): Promise<string> {
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

  // A hook that failed to load exits 0 and prints nothing, which is exactly what
  // a permit looks like. Neither of these may be collapsed into ALLOWED — for
  // the MUTANT especially, where a module-resolution failure would otherwise
  // read as "the old matcher allowed everything" and make the delta look right.
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

const payloadFor = (filePath: string, tool = "Write") => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { file_path: filePath, content: '{"phase":"BUILD"}' },
});

const real = new Map<string, string>();
const mutant = new Map<string, string>();
let source = "";
let tmp = "";
/** Control on a different axis: the guard is PreToolUse on Write and Edit only. */
let bashReading = "";

beforeAll(async () => {
  source = readFileSync(GUARD, "utf-8");

  // The mutant is the pre-#1211 matcher, character for character: the real
  // source with the fold deleted. Built by deletion rather than written by
  // hand, so it cannot drift away from the thing it is the counterfactual of.
  //
  // `hooks/lib/utils.ts` imports only `fs` and `path`, so carrying that one
  // file closes the mutant's dependencies and it loads from a temp directory.
  // A mutant that failed to load would exit non-zero and be read as UNMEASURED
  // above, not as a permit.
  tmp = mkdtempSync(join(tmpdir(), "ws-guard-case-"));
  mkdirSync(join(tmp, "lib"), { recursive: true });
  copyFileSync(join(ROOT, "hooks", "lib", "utils.ts"), join(tmp, "lib", "utils.ts"));
  const mutantPath = join(tmp, "WorkflowStateGuard.hook.ts");
  writeFileSync(mutantPath, source.split(FOLD).join(""));

  for (const s of CORPUS) {
    real.set(s.path, await decide(GUARD, payloadFor(s.path)));
    mutant.set(s.path, await decide(mutantPath, payloadFor(s.path)));
  }

  bashReading = await decide(GUARD, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `cat ${PREFIX}WORKFLOW-STATE.JSON` },
  });
}, 180_000);

describe("#1211 the instrument is live before any row is read", () => {
  test("the real guard refuses the canonical spelling", () => {
    expect(
      real.get(`${PREFIX}workflow-state.json`),
      "the guard did not refuse the artifact it is pointed at, so every ALLOWED below " +
        "is a hook that failed to load rather than a decision",
    ).toBe("REFUSED");
  });

  test("the mutant refuses the canonical spelling, so it loaded and still decides", () => {
    expect(
      mutant.get(`${PREFIX}workflow-state.json`),
      "the pre-#1211 matcher is the baseline every `before` reading comes from. If it " +
        "allows even the canonical spelling it is not the old guard, it is a broken " +
        "copy — and a broken copy allows everything, which makes the widening below " +
        "look complete when nothing was measured",
    ).toBe("REFUSED");
  });

  test("the guard is not a blanket refuser", () => {
    expect(real.get(`${PREFIX}README.md`)).toBe("ALLOWED");
  });

  test("the fold has exactly one site, so the mutation cannot be bypassed", () => {
    expect(
      source.split(FOLD).length - 1,
      `A second ${FOLD} in ${GUARD} would survive the deletion above and hold the ` +
        `mutant up, so the before-readings would be the fixed guard's and every delta ` +
        `below would read as zero change. One site, or this battery measures nothing.`,
    ).toBe(1);
  });
});

describe("#1211 what the shipping guard refuses, spelling by spelling", () => {
  for (const s of CORPUS) {
    const label = s.path === "" ? "(no file_path)" : s.path.slice(PREFIX.length) || s.path;
    test(`${label}: ${s.now}`, () => {
      expect(
        real.get(s.path),
        `WorkflowStateGuard moved on "${s.path}".\n\n` +
          `  recorded: ${s.now}\n  measured: ${real.get(s.path)}\n\n` +
          `  why this row reads the way it does: ${s.why}\n\n` +
          `An UNMEASURED reading means the hook did not run — fix the harness, do not ` +
          `record it as a verdict. A changed verdict means the matcher moved: update ` +
          `this row, the widening list, row 8 of test/workflow-state-write-contract.test.ts ` +
          `and the table in specs/HOOK-ARCHITECTURE-SPEC.md in the same commit.`,
      ).toBe(s.now);
    });
  }
});

describe("#1211 the fold widens by exactly the case-variants, and narrows by nothing", () => {
  const diff = (a: Verdict, b: Verdict) =>
    CORPUS.filter((s) => real.get(s.path) === a && mutant.get(s.path) === b).map((s) => s.path);

  test("every spelling the fold newly refuses is a case-variant of the artifact", () => {
    expect(
      diff("REFUSED", "ALLOWED").sort(),
      "This is the population the case-fold hands the guard authority over that it did " +
        "not hold before. A fold is only safe while that set is case-variants of the " +
        "artifact's own name: anything else here is the guard claiming files nobody " +
        "decided it should claim, which is a different defect from the one #1211 fixed.",
    ).toEqual([...WIDENING].sort());
  });

  test("the fold takes nothing out of the refusal set", () => {
    expect(
      diff("ALLOWED", "REFUSED"),
      "A case-fold can only widen. A spelling the old matcher refused and the new one " +
        "permits means the matcher was rewritten rather than folded, and the rewrite " +
        "opened a hole while closing #1211's.",
    ).toEqual([]);
  });

  test("the before-readings are a baseline and not a row of zeros", () => {
    // Read the baseline before reading any delta: a mutant that refuses nothing
    // produces a maximal, entirely believable widening while having measured
    // nothing at all.
    const refusedBefore = CORPUS.filter((s) => mutant.get(s.path) === "REFUSED").map((s) => s.path);
    expect(
      refusedBefore.sort(),
      "the pre-#1211 matcher's own refusal set, which the widening above is measured " +
        "against. An empty or UNMEASURED baseline here invalidates both deltas.",
    ).toEqual(CORPUS.filter((s) => s.before === "REFUSED").map((s) => s.path).sort());
  });
});

describe("#1211 the fold did not widen the guard onto another axis", () => {
  test("a Bash command naming the uppercase spelling is still not this guard's business", () => {
    expect(
      bashReading,
      "WorkflowStateGuard is PreToolUse on Write and Edit. The artifact IS reachable " +
        "from Bash and a separate guard covers that; if this hook starts answering for " +
        "Bash it is deciding something it was never scoped to and two guards now " +
        "disagree about one command.\n\n" +
        "This is a control on the TOOL axis, which every row of the corpus holds fixed " +
        "at Write. It is one sample and it is not coverage of that axis.",
    ).toBe("ALLOWED");
  });
});
