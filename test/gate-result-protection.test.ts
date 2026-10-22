import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
    // Round 2 pointed this at a path with no file, which the fragment-only
    // implementation caught from `old_string` alone. The disk-aware one
    // correctly treats a missing file as nothing to erase — the Edit tool
    // refuses it anyway — so the case now models the real situation.
    const dir = mkdtempSync(join(tmpdir(), "grp-edit-erase-"));
    try {
      const path = join(dir, "workflow-state.json");
      writeFileSync(path, '{"phase":"SHIP","gates":{"scope":{"result":"FAIL","attempt":2}}}');
      const r = runHook({
        tool_name: "Edit",
        tool_input: {
          file_path: path,
          old_string: '{"result":"FAIL","attempt":2}',
          new_string: '{"attempt":2}',
        },
      });
      expect(blockedReason(r)).toMatch(/remov|eras|chang/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  // The round-2 version of this case asserted the OPPOSITE — that a corrupt
  // prior state must not block writes, on the reasoning that refusing would
  // make the file unrepairable. That reasoning was wrong and the measurement
  // is in the next describe: the repair path is `writeWorkflowState` over a
  // Bash call, which this matcher never sees. The case now asserts the
  // refusal, and the one below keeps the property the old one was reaching
  // for — that the guard stays scoped to this one artifact.
  test("CONTROL: a corrupt file at a DIFFERENT path does not block anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "grp-corrupt-"));
    try {
      const other = join(dir, "notes.md");
      writeFileSync(other, "{ not json");
      expectAllowed(write("still not json", other));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Third review round. The Edit branch decided from two string fragments and
 * never read the file, so it caught erasure OF A RESULT but not erasure of
 * the PATH to the result — and the two findings below chain into one
 * two-step bypass.
 *
 * PREDICTED 5 red against the branch at 4c68a672, before the fix:
 * the rename, the result-key rename, the corrupting Edit, the Write over an
 * unparseable prior, and the Edit over an unparseable prior. MEASURED below.
 */
describe("#1137 an Edit cannot erase the PATH to a result", () => {
  function editOn(prior: unknown, old_string: string, new_string: string): Run {
    let out!: Run;
    withStateFile(prior, path => {
      out = runHook({ tool_name: "Edit", tool_input: { file_path: path, old_string, new_string } });
    });
    return out;
  }

  const GATED = { phase: "SHIP", gates: { scope: { result: "PASS" }, verify: { result: "FAIL" } } };

  test("WITNESS: renaming the gates key is refused", () => {
    // The reported bypass, verbatim. Neither fragment contains a forbidden
    // substring; the file stays valid JSON; every result moves out of reach.
    expect(blockedReason(editOn(GATED, '"gates"', '"gates_old"'))).toMatch(/remov|eras|chang/i);
  });

  test("WITNESS: renaming the result key is refused", () => {
    expect(blockedReason(editOn(GATED, '"result"', '"result_old"'))).toMatch(/remov|eras|chang/i);
  });

  test("WITNESS: renaming a single gate out of reach is refused", () => {
    expect(blockedReason(editOn(GATED, '"verify"', '"verify_x"'))).toMatch(/remov|eras|chang/i);
  });

  test("WITNESS: an Edit that leaves the file unparseable is refused", () => {
    // Step one of the chain: Edit is the only way to reach a corrupt prior
    // state, because the Write branch already refuses unparseable content.
    expect(blockedReason(editOn(GATED, "{", "XX"))).toMatch(/pars/i);
  });

  test("WITNESS: an Edit that FORGES a result through a rename is refused", () => {
    const prior = { phase: "BUILD", gates_draft: { ship: { result: "PASS" } } };
    expect(blockedReason(editOn(prior, '"gates_draft"', '"gates"'))).toMatch(/gate-runner|chang|add/i);
  });

  test("CONTROL: a legitimate phase Edit still passes", () => {
    expectAllowed(editOn({ phase: "BUILD", acs: [] }, '"BUILD"', '"VERIFY"'));
  });

  test("CONTROL: a legitimate Edit on a GATED state still passes", () => {
    // The guard must not become "no edits once a gate has run" — that is the
    // brick. Adding a changelog entry touches no gate result.
    expectAllowed(
      editOn(
        { ...GATED, changelog: [] },
        '"changelog":[]',
        '"changelog":[{"ts":"t","event":"note"}]',
      ),
    );
  });

  // Adopting this refusal immediately reddened two CONTROLs in this file —
  // the gated-changelog one and the already-DONE one — because both spelled
  // `old_string` with spaces that `JSON.stringify` does not emit. They had
  // been passing on the ALLOW this case removes, which means they modelled
  // no edit at all: `.claude/rules/checks-must-be-able-to-fail.md`, third
  // shape, in the very cases written to prove the guard is not a brick.
  // Both fixtures are now byte-exact. Nothing about the guard changed to
  // make them pass.
  test("WITNESS: an Edit whose old_string is not in the file is refused", () => {
    // Round 3 asserted the opposite, reasoning that the Edit tool refuses
    // such an edit anyway. That is sound about the TOOL and the wrong party
    // to reason about: the guard models the tool, and where they differ the
    // guard is wrong. Over-blocking costs a retry; under-blocking costs the
    // control.
    expect(blockedReason(editOn(GATED, '"nowhere-in-this-file"', '"x"'))).toMatch(/model/i);
  });

  test("WITNESS: an Edit with an empty old_string is refused", () => {
    expect(blockedReason(editOn(GATED, "", '"x"'))).toMatch(/model/i);
  });

  test("WITNESS: an Edit on a present-but-unreadable file is refused", () => {
    // The Edit branch had its own existsSync + catch returning ALLOW, so an
    // unreadable file allowed there and refused on the Write path. Measured.
    const dir = mkdtempSync(join(tmpdir(), "grp-perm-"));
    const path = join(dir, "workflow-state.json");
    try {
      writeFileSync(path, JSON.stringify(GATED));
      chmodSync(path, 0o000);
      const r = runHook({
        tool_name: "Edit",
        tool_input: { file_path: path, old_string: '"SHIP"', new_string: '"BUILD"' },
      });
      expect(blockedReason(r)).toMatch(/pars|read/i);
    } finally {
      try { chmodSync(path, 0o644); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WITNESS: replace_all as a truthy non-boolean cannot smuggle an erasure", () => {
    // `toolInput.replace_all === true` read `1` and `"true"` as false, so
    // the guard modelled one replacement while the tool may do all.
    // Measured ALLOWED for both, where a real `true` refused.
    const dir = mkdtempSync(join(tmpdir(), "grp-ra-"));
    try {
      const path = join(dir, "workflow-state.json");
      // The FIRST occurrence is outside `gates`; the second is the result.
      writeFileSync(path, '{"a":{"result":"PASS"},"gates":{"scope":{"result":"PASS"}}}');
      for (const replace_all of [true, 1, "true", "yes"]) {
        const r = runHook({
          tool_name: "Edit",
          tool_input: {
            file_path: path,
            old_string: '"result":"PASS"',
            new_string: '"result2":"PASS"',
            replace_all,
          },
        });
        expect(blockedReason(r), `replace_all: ${JSON.stringify(replace_all)}`).toMatch(
          /remov|eras|chang/i,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a single-occurrence edit is unaffected by modelling both splices", () => {
    expectAllowed(editOn({ phase: "BUILD", note: "x" }, '"x"', '"y"'));
  });

  test("CONTROL: an ordinary Edit to an already-DONE run passes", () => {
    // Found by the false-positive sweep, not by review: the first disk-aware
    // draft refused whenever the OUTCOME was DONE, which refused every edit
    // to a finished run — 6 refusals across 157 legitimate operations on the
    // 44 live states in ~/.rungate, all on the two already-DONE ones. Phase
    // DONE is a transition, and nothing here advances anything.
    expectAllowed(
      editOn(
        { phase: "DONE", gates: { ship: { result: "PASS" } }, updatedTs: "2026-01-01" },
        '"updatedTs":"2026-01-01"',
        '"updatedTs":"2026-10-22"',
      ),
    );
  });

  test("WITNESS: an Edit that ADVANCES a run to DONE is still refused", () => {
    // The control above must not have bought itself by switching the rule off.
    expect(
      blockedReason(editOn({ phase: "SHIP" }, '"SHIP"', '"DONE"')),
    ).toContain("DONE");
  });

  test("CONTROL: an Edit to a path with no file on disk passes", () => {
    expectAllowed(
      runHook({
        tool_name: "Edit",
        tool_input: { file_path: STATE, old_string: '"a"', new_string: '"b"' },
      }),
    );
  });
});

describe("#1137 an unparseable PRIOR state is UNMEASURED, and refuses", () => {
  // Step two of the chain. Once the file on disk will not parse, the erasure
  // comparison has nothing to compare against — and the previous round let
  // the write through on its own merits, which disabled the protection for
  // everything after.
  //
  // Closing this does NOT brick repair. Measured 2026-10-22: a corrupt
  // workflow-state.json is repaired by `bun -e "…writeWorkflowState(path,
  // state)"`, which succeeds over unparseable prior content (its own prior
  // read is inside a catch) and is a Bash call this matcher never sees.
  function onCorruptPrior(payload: (p: string) => unknown): Run {
    const dir = mkdtempSync(join(tmpdir(), "grp-prior-"));
    try {
      const path = join(dir, "workflow-state.json");
      writeFileSync(path, "XX not json");
      return runHook(payload(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("WITNESS: a Write over an unparseable prior state is refused", () => {
    const r = onCorruptPrior(path => ({
      tool_name: "Write",
      tool_input: { file_path: path, content: JSON.stringify({ phase: "BUILD" }) },
    }));
    expect(blockedReason(r)).toMatch(/pars/i);
  });

  test("WITNESS: an Edit over an unparseable prior state is refused", () => {
    const r = onCorruptPrior(path => ({
      tool_name: "Edit",
      tool_input: { file_path: path, old_string: "XX", new_string: "YY" },
    }));
    expect(blockedReason(r)).toMatch(/pars/i);
  });

  test("CONTROL: the refusal names the repair path", () => {
    const r = onCorruptPrior(path => ({
      tool_name: "Write",
      tool_input: { file_path: path, content: JSON.stringify({ phase: "BUILD" }) },
    }));
    // A refusal nobody can get out from under gets switched off.
    expect(blockedReason(r)).toContain("writeWorkflowState");
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
