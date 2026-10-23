/**
 * #1359 — the crash fallback in `GateResultProtection.hook.ts` decided "is
 * this the artifact?" with its own case-SENSITIVE `endsWith`, while
 * `isWorkflowState` in the same subsystem case-FOLDS (#1184). The fold
 * reached the predicate and not the arm whose whole job is to not fail open.
 *
 * ## It is measured here, not read
 *
 * The issue says so explicitly, and it is the right bar: the fallback had no
 * test at all before this file, so "a guard that crashes must not thereby
 * allow the thing it guards (#1137)" was a comment rather than a claim.
 * Measured before the fix, with `decideGateResultWrite` forced to throw:
 *
 * | `file_path`            | before    | after     |
 * |------------------------|-----------|-----------|
 * | `workflow-state.json`  | REFUSED   | REFUSED   |
 * | `WORKFLOW-STATE.JSON`  | ALLOWED   | REFUSED   |
 * | `README.md`            | allowed   | allowed   |
 *
 * On the default macOS filesystem the first two are the same inode, so the
 * uppercase spelling reached the real artifact with the guard switched off.
 *
 * ## Why the crash is injected rather than provoked
 *
 * `decideGateResultWrite` is defensive throughout — `readPriorState` catches
 * both the read and the parse — so there is no known input that makes it
 * throw. That is a good property of the function and a bad one for a test:
 * waiting for a real crash means this arm stays untested until the day it
 * matters. The crash is therefore injected with `mock.module` in a preload,
 * and the hook runs as the subprocess it really is.
 *
 * **The mock re-exports the real `isWorkflowState`.** Replacing the whole
 * module would hand the hook a fold written here, and the rows would then
 * agree with this file instead of with `lib/gate-result-protection.ts` —
 * the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`, two
 * sites computing one thing and agreeing by construction. Only
 * `decideGateResultWrite` is replaced.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "GateResultProtection.hook.ts");
const LIB = join(ROOT, "lib", "gate-result-protection.ts");

const scratch = mkdtempSync(join(tmpdir(), "gate-crash-fallback-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The thrown message, asserted on so a refusal for another reason is visible. */
const CRASH = "forced crash: #1359 exercises the fallback, not the ordinary path";

const PRELOAD = join(scratch, "preload.ts");
writeFileSync(
  PRELOAD,
  `import { mock } from "bun:test";
// The REAL module first, so the fold the hook uses is the shipped one.
const real = await import(${JSON.stringify(LIB)});
mock.module(${JSON.stringify(LIB)}, () => ({
  ...real,
  decideGateResultWrite: () => { throw new Error(${JSON.stringify(CRASH)}); },
}));
`,
);

interface HookAnswer { code: number | null; blocked: boolean; reason: string }

function runHook(filePath: string): HookAnswer {
  const r = spawnSync("bun", ["--preload", PRELOAD, HOOK], {
    cwd: ROOT,
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath, content: "{}" } }),
    encoding: "utf-8",
    timeout: 60_000,
  });
  const out = (r.stdout ?? "").trim();
  let blocked = false;
  let reason = "";
  for (const line of out.split("\n")) {
    try {
      const d = JSON.parse(line) as { decision?: string; reason?: string };
      if (d.decision === "block") {
        blocked = true;
        reason = d.reason ?? "";
      }
    } catch {
      // Not every line is the decision object; a non-JSON line is not a block.
    }
  }
  return { code: r.status, blocked, reason };
}

describe("#1359: the crash fallback folds case, like the predicate it guards with", () => {
  test("PREMISE: the injected crash reaches the fallback at all", () => {
    // Without this every row below could be green because nothing ever threw,
    // and the file would be measuring an empty set.
    const r = runHook(join(scratch, "workflow-state.json"));
    expect(r.blocked, "the lowercase spelling was not refused, so no crash reached the fallback").toBe(true);
    expect(r.reason).toContain("could not evaluate this write");
    expect(r.reason, "refused, but not by the crash arm — some other branch blocked this").toContain(CRASH);
  });

  test("an UPPERCASE spelling is refused by the crash fallback", () => {
    // RED before the fix: exit 0, silent, write permitted. Same inode as the
    // row above on the default macOS filesystem.
    const r = runHook(join(scratch, "WORKFLOW-STATE.JSON"));
    expect(r.blocked, "the crash fallback ALLOWED an uppercase spelling of the artifact it guards").toBe(true);
    expect(r.reason).toContain(CRASH);
  });

  test.each(["Workflow-State.json", "workflow-state.JSON", "WorkFlow-State.Json"])(
    "mixed case %s is refused too",
    name => {
      expect(runHook(join(scratch, name)).blocked).toBe(true);
    },
  );

  test("CONTROL: a crash on an unrelated path still allows the write", () => {
    // The narrowing is the reason this hook does not brick a session when it
    // has a bug. A fix that refused everything on crash would pass every row
    // above and be strictly worse than the defect.
    const r = runHook(join(scratch, "README.md"));
    expect(r.blocked, "a guard bug refused a write to a file it does not guard").toBe(false);
    expect(r.code).toBe(0);
  });

  test("CONTROL: a path merely CONTAINING the name is not the artifact", () => {
    // `endsWith` and the folded predicate agree here, and the row exists so
    // that a future fix reaching for `includes` is caught rather than praised
    // for being more thorough.
    expect(runHook(join(scratch, "workflow-state.json.bak")).blocked).toBe(false);
    expect(runHook(join(scratch, "notes-about-workflow-state.json-format.md")).blocked).toBe(false);
  });

  test("CONTROL: the hook consults the shipped predicate, not a copy", () => {
    // Names what this file can show. `lib/gate-result-protection.ts` must
    // still be the only place the fold is written; a hand-rolled `endsWith`
    // in the hook is how #1359 happened and would make every row above pass
    // while the two sites drifted again.
    const src = require("fs").readFileSync(HOOK, "utf-8") as string;
    expect(src).toContain("isWorkflowState(named)");
    expect(src, "the hook re-implements the artifact test instead of importing it").not.toMatch(
      /endsWith\(\s*['"]workflow-state\.json['"]\s*\)/i,
    );
  });
});
