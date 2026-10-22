import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

/**
 * #1137 — `GateResultProtection.hook.ts` failed open three ways. Covers
 * SC-370, SC-371 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * Every case here runs the hook as a SUBPROCESS, the way Claude Code runs it,
 * so each one is red or green against any revision of the hook file. That is
 * deliberate: the registry half of this issue is in
 * `test/gate-name-registry.test.ts` instead, because those cases import a
 * module that does not exist before the fix and a file that cannot load gives
 * one red for the file rather than one red per case. Splitting them keeps the
 * behavioural measurement per-case.
 *
 * ## Prediction, written before measuring (`.claude/rules/checks-must-be-able-to-fail.md`)
 *
 * PREDICTED 6 of these cases red against `origin/main` @ 7f5df160, all red by
 * BEHAVIOUR — the hook runs there and allows what it must block: the four
 * WITNESS cases under "whitespace and escapes", and the two under "an
 * unparseable write".
 *
 * MEASURED 6 red, 12 green, and they were the six named — not merely six:
 *   - an Edit spelling the result pair with extra whitespace
 *   - an Edit with a newline between key and value
 *   - an Edit spelling the key with a unicode escape
 *   - an Edit spelling phase DONE with extra whitespace
 *   - a Write whose content is not JSON
 *   - a Write with empty content
 *
 * Every CONTROL was predicted green on main and was green: a guard that
 * refuses everything passes every WITNESS above and is useless, so the
 * controls are the half that says the fix is a fix and not a brick.
 *
 * ## What was broken to prove these can fail
 *
 * They were run against main's hook before the fix existed — the literal
 * `includes` list and the `catch {}` ARE the mutant, already in the tree.
 */

const ROOT = resolve(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "GateResultProtection.hook.ts");

interface Run {
  code: number | null;
  stdout: string;
}

function runHook(payload: unknown): Run {
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout ?? "" };
}

const STATE = "/x/work/slug/workflow-state.json";

function edit(new_string: string): Run {
  return runHook({ tool_name: "Edit", tool_input: { file_path: STATE, new_string } });
}

function write(content: string, file_path: string = STATE): Run {
  return runHook({ tool_name: "Write", tool_input: { file_path, content } });
}

/** A hook that blocks prints one JSON object with `decision: "block"`. */
function blockedReason(r: Run): string {
  const out = r.stdout.trim();
  expect(out, "expected a refusal, got silence (the hook allowed this write)").not.toBe("");
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe("block");
  return parsed.reason as string;
}

function expectAllowed(r: Run): void {
  expect(r.stdout.trim(), "expected silence (allow), got a refusal").toBe("");
}

// ── Defect 1: the detector was a set of fixed literals ────────────────────

describe("#1137 whitespace and escapes cannot step around the guard", () => {
  test("WITNESS: an Edit spelling the result pair with extra whitespace is blocked", () => {
    // main enumerated '"result": "PASS"' and '"result":"PASS"' and nothing else.
    expect(blockedReason(edit('"result"  :  "PASS"'))).toContain("gate-runner");
  });

  test("WITNESS: an Edit with a newline between key and value is blocked", () => {
    expect(blockedReason(edit('"result":\n    "FAIL"'))).toContain("gate-runner");
  });

  test("WITNESS: an Edit spelling the key with a unicode escape is blocked", () => {
    // The Edit tool substitutes literally, so this text lands in the file —
    // and JSON.parse turns result back into `result` for every reader.
    expect(blockedReason(edit('"\\u0072esult": "PASS"'))).toContain("gate-runner");
  });

  test("WITNESS: an Edit spelling phase DONE with extra whitespace is blocked", () => {
    expect(blockedReason(edit('"phase"  :  "DONE"'))).toContain("DONE");
  });

  test("WITNESS: the original literal spellings are still blocked", () => {
    expect(blockedReason(edit('"result": "PASS"'))).toContain("gate-runner");
    expect(blockedReason(edit('"phase":"DONE"'))).toContain("DONE");
  });

  test("CONTROL: a non-gate Edit with the same whitespace shape is allowed", () => {
    expectAllowed(edit('"changelog"  :  [{ "event": "ac-added" }]'));
  });

  test("CONTROL: an Edit advancing the phase to BUILD is allowed, spaced or not", () => {
    expectAllowed(edit('"phase" : "BUILD"'));
    expectAllowed(edit('"phase":"VERIFY"'));
  });

  test("CONTROL: an Edit naming a gate without setting a result is allowed", () => {
    expectAllowed(edit('"scope": { "attempt": 2, "startedAt": "2026-10-22" }'));
  });
});

// ── Defect 2: an unparseable Write was allowed ────────────────────────────

describe("#1137 an unparseable write to workflow-state.json is refused", () => {
  test("WITNESS: a Write whose content is not JSON is blocked, naming the parse failure", () => {
    // main: `catch {}` with a comment about partial writes. The Write tool
    // replaces the whole file, so there is no partial-write case to protect.
    const reason = blockedReason(write('{"gates": {"ship": {"result": "PA'));
    expect(reason).toMatch(/pars/i);
  });

  test("WITNESS: a Write with empty content is blocked", () => {
    expect(blockedReason(write(""))).toMatch(/pars/i);
  });

  test("CONTROL: the refusal is scoped to workflow-state.json, not to every file", () => {
    expectAllowed(write("not json at all", "/x/work/slug/notes.md"));
  });

  test("CONTROL: a valid non-gate Write is allowed", () => {
    expectAllowed(
      write(
        JSON.stringify({
          phase: "BUILD",
          issue: 1137,
          acs: [{ id: "AC-1", statement: "the guard refuses" }],
          changelog: [{ ts: "2026-10-22", event: "ac-added" }],
        }),
      ),
    );
  });

  test("CONTROL: a valid Write naming gates without results is allowed", () => {
    expectAllowed(
      write(JSON.stringify({ phase: "VERIFY", gates: { scope: { attempt: 1 }, verify: {} } })),
    );
  });
});

// ── The structural path, which was already correct ────────────────────────

describe("#1137 the parsed-structure path keeps the behaviour it had", () => {
  test("WITNESS: a Write setting a gate result is blocked", () => {
    expect(
      blockedReason(write(JSON.stringify({ gates: { verify: { result: "PASS" } } }))),
    ).toContain("gate-runner");
  });

  test("WITNESS: a Write setting phase DONE is blocked", () => {
    expect(blockedReason(write(JSON.stringify({ phase: "DONE" })))).toContain("DONE");
  });

  test("WITNESS: a unicode-escaped key inside valid JSON is blocked", () => {
    // Green on main too, and that is the point: JSON.parse normalises the
    // escape, which is why the structural path needs no decoder of its own
    // and the Edit path — which cannot parse a fragment — does.
    expect(blockedReason(write('{"\\u0070hase": "DONE"}'))).toContain("DONE");
  });

  test("CONTROL: a Write to a different file is allowed", () => {
    expectAllowed(write("hi", "/x/notes.md"));
  });

  test("CONTROL: a tool that is neither Write nor Edit is allowed", () => {
    expectAllowed(runHook({ tool_name: "Read", tool_input: { file_path: STATE } }));
  });
});

// ── Second review round: erasure, and non-object content ─────────────────

/**
 * A state file on disk, so the guard can compare against what is already
 * there. The erasure bypass is invisible to any content-only reading.
 */
function withStateFile(existing: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "grp-erase-"));
  try {
    const path = join(dir, "workflow-state.json");
    writeFileSync(path, JSON.stringify(existing));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#1137 a gate result cannot be bypassed by ERASING it", () => {
  // The guard asked "does the incoming content contain a result?" — so a
  // bypass only had to make the answer no. A forged PASS was the attack it
  // was written against; a deleted FAIL reaches the same end and was
  // invisible. Measured ALLOWED against this branch before this case existed.
  test("WITNESS: a Write that drops an existing gate result is blocked", () => {
    withStateFile({ phase: "SHIP", gates: { scope: { result: "PASS", attempt: 1 } } }, path => {
      const r = write(JSON.stringify({ phase: "SHIP" }), path);
      expect(blockedReason(r)).toMatch(/remov|eras/i);
    });
  });

  test("WITNESS: the refusal NAMES every gate result the write drops", () => {
    withStateFile(
      { gates: { scope: { result: "PASS" }, verify: { result: "FAIL" } } },
      path => {
        // The gate records survive; their `result` fields do not. Content
        // carrying a result would be refused as forgery FIRST and never
        // reach the erasure comparison — so a case that kept one would be
        // asserting the wrong rule. This one reaches it.
        const r = write(
          JSON.stringify({ gates: { scope: { attempt: 1 }, verify: { attempt: 2 } } }),
          path,
        );
        const reason = blockedReason(r);
        expect(reason).toMatch(/scope/);
        expect(reason).toMatch(/verify/);
      },
    );
  });

  test("WITNESS: a Write that changes an existing result is blocked", () => {
    withStateFile({ gates: { verify: { result: "FAIL" } } }, path => {
      // FAIL -> PASS is caught as forgery, which is the stronger refusal of
      // the two. Asserted so the ordering is pinned rather than incidental.
      expect(blockedReason(write(JSON.stringify({ gates: { verify: { result: "PASS" } } }), path)))
        .toContain("gate-runner");
    });
  });

  test("WITNESS: an Edit whose old_string holds a result and new_string does not is blocked", () => {
    const r = runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: STATE,
        old_string: '"scope": { "result": "FAIL", "attempt": 2 }',
        new_string: '"scope": { "attempt": 2 }',
      },
    });
    expect(blockedReason(r)).toMatch(/remov|eras/i);
  });

  test("CONTROL: a Write to a state that never had a gate result is allowed", () => {
    withStateFile({ phase: "BUILD", acs: [] }, path => {
      expectAllowed(write(JSON.stringify({ phase: "BUILD", acs: [{ id: "AC-1" }] }), path));
    });
  });

  test("CONTROL: a Write to a path with no file on disk yet is allowed", () => {
    withStateFile({ phase: "BUILD" }, path => {
      const fresh = path.replace("workflow-state.json", "new/workflow-state.json");
      expectAllowed(write(JSON.stringify({ phase: "GOAL" }), fresh));
    });
  });

  test("CONTROL: an Edit that touches neither old nor new result is allowed", () => {
    expectAllowed(
      runHook({
        tool_name: "Edit",
        tool_input: {
          file_path: STATE,
          old_string: '"phase": "BUILD"',
          new_string: '"phase": "VERIFY"',
        },
      }),
    );
  });

  test("CONTROL: an existing state file that is itself corrupt does not brick writes", () => {
    // An unreadable prior state is UNMEASURED for the ERASURE question
    // specifically. Refusing here would make one corrupt file permanently
    // unwritable by the only tool that could repair it.
    const dir = mkdtempSync(join(tmpdir(), "grp-corrupt-"));
    try {
      const path = join(dir, "workflow-state.json");
      writeFileSync(path, "{ not json");
      expectAllowed(write(JSON.stringify({ phase: "BUILD" }), path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1137 non-object content is UNMEASURED, and UNMEASURED refuses", () => {
  // Same class as the `catch { // allow }` this issue was filed about: a
  // workflow state is always an object, so an array, a null or a bare scalar
  // is a reading the guard cannot take — and a reading that could not be
  // taken is not one that passed.
  test("WITNESS: a Write of [] is blocked", () => {
    expect(blockedReason(write("[]"))).toMatch(/object/i);
  });

  test("WITNESS: a Write of null is blocked", () => {
    expect(blockedReason(write("null"))).toMatch(/object/i);
  });

  test("WITNESS: a Write of a bare string is blocked", () => {
    expect(blockedReason(write('"DONE"'))).toMatch(/object/i);
  });

  test("WITNESS: a Write of a bare number is blocked", () => {
    expect(blockedReason(write("0"))).toMatch(/object/i);
  });
});
