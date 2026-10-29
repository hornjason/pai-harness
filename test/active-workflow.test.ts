/**
 * #1648: an archived run must not decide a live gate.
 *
 * Two layers, because the predicate alone proves nothing about the hook. The
 * first describes `isRunDirectory`; the second plants a work directory on
 * disk, runs the real hook against it, and asserts on what the hook DECIDED.
 *
 * ## What was broken to prove these can fail
 *
 * `bash /tmp/rg-lock-battery/battery.sh`, 2026-10-29:
 *
 *   baseline                              0 red / 9 pass
 *   isRunDirectory always true            5 red / 4 pass
 *   the hook drops the filter             3 red / 6 pass
 *   restored                              0 red / 9 pass
 *
 * The second row is the one that matters: it is the line actually removed to
 * create #1648, and it reddens the end-to-end cases rather than only the unit
 * ones.
 *
 * **Run the battery with `(cd <root> && bun test …)`, never `bun --cwd <root>
 * test`.** The second form resolves `test` as the package SCRIPT, so
 * `posttest` fires and `sync-sc-status` ticks real checkboxes in `specs/`.
 * It did, eight times, during the battery for `lib/board-mirror.ts` — three
 * criteria in the convergence spec among them, one of which (CRC-B4) #1591
 * records as never having run in CI at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunDirectory } from "../lib/active-workflow";

const HOOK = join(import.meta.dir, "..", "hooks", "VerifyPhaseLock.hook.ts");

const CREATE = "gh issue create --repo o/r --title t --body b";

/** Plant a work dir and ask the real hook what it decides about `cmd`. */
async function hookDecision(
  runs: { dir: string; phase: string }[],
  cmd = CREATE,
): Promise<{ blocked: boolean; text: string }> {
  const work = mkdtempSync(join(tmpdir(), "rg-verify-lock-"));
  for (const r of runs) {
    const d = join(work, ...r.dir.split("/"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "workflow-state.json"), JSON.stringify({ phase: r.phase }));
  }
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUNGATE_WORK_DIR: work },
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return { blocked: text.includes('"decision":"block"'), text };
}

describe("#1648: isRunDirectory", () => {
  test("an ordinary run slug is a run", () => {
    expect(isRunDirectory("pai-harness-892")).toBe(true);
    expect(isRunDirectory("agentgrit-311")).toBe(true);
  });

  test(".archive is not — it is the work dir's own bookkeeping", () => {
    expect(isRunDirectory(".archive")).toBe(false);
  });

  test("any hidden entry is not, because a list of one name is a list someone must extend", () => {
    expect(isRunDirectory(".tmp")).toBe(false);
    expect(isRunDirectory(".anything-added-later")).toBe(false);
  });

  test("a dot INSIDE the name is still a run — only a leading dot hides it", () => {
    expect(isRunDirectory("repo.name-12")).toBe(true);
  });
});

describe("#1648: the hook, end to end against a planted work directory", () => {
  test("a LIVE run in VERIFY still blocks — the gate is not disabled", async () => {
    // The control. Without this the fix below could have switched the whole
    // lock off and every case would still read as a pass.
    const { blocked, text } = await hookDecision([{ dir: "proj-1", phase: "VERIFY" }]);
    expect(blocked).toBe(true);
    expect(text).toContain("VerifyPhaseLock");
  });

  test("an ARCHIVED run in VERIFY does not block", async () => {
    // Exactly #1648: `.archive/<slug>/workflow-state.json` matches the nested
    // scan, so a run that finished on 21 October was deciding the gate.
    const { blocked } = await hookDecision([{ dir: ".archive/proj-892", phase: "VERIFY" }]);
    expect(blocked).toBe(false);
  });

  test("an archived VERIFY alongside a live non-VERIFY run does not block", async () => {
    // The real shape on this machine: three live runs, none in VERIFY, and
    // the newest file of all sitting in `.archive` at VERIFY. The archived
    // one won because the scan ranks by mtime.
    const { blocked } = await hookDecision([
      { dir: "proj-169", phase: "DONE" },
      { dir: ".archive/proj-892", phase: "VERIFY" },
    ]);
    expect(blocked).toBe(false);
  });

  test("a live VERIFY run blocks even when an archived run is newer", async () => {
    // The other direction, so the fix cannot be "ignore VERIFY when anything
    // is archived". The live run is written FIRST and is therefore older.
    const { blocked } = await hookDecision([
      { dir: "proj-1", phase: "VERIFY" },
      { dir: ".archive/proj-892", phase: "DONE" },
    ]);
    expect(blocked).toBe(true);
  });

  test("no work directory entries at all does not block", async () => {
    expect((await hookDecision([])).blocked).toBe(false);
  });
});
