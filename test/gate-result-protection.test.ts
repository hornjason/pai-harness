import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
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
