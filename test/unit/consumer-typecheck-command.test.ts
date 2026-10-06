/**
 * #72 AC-3 (OUTCOME) — the Type check command printed in a generated AGENTS.md
 * actually type-checks the consumer's code.
 *
 * This is the half that `.claude/rules/checks-must-be-able-to-fail.md` demands.
 * Asserting that the row exists, or that tsconfig.json exists, proves only that
 * files were authored. #65/#76 were exactly that defect: the row existed, the
 * command ran in CI, and it had never checked a single file. So this test
 * breaks the consumer on purpose and requires the documented command to go red,
 * then requires it to go green again when the break is removed.
 *
 * A single direction would not be enough either: a command that always fails
 * passes the red half, and a command that always passes passes the green half.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { scaffoldMinimalProject } from "../helpers/scaffold-fixture";

const dest = join(tmpdir(), `rungate-typecheck-cmd-${process.pid}`);
const SOURCE = join(dest, "src", "index.ts");
const CLEAN = 'export const greeting: string = "hello";\n';
const BROKEN = `${CLEAN}export const broken: number = "not a number";\n`;

/** The command AGENTS.md tells an agent to run, pulled out of the table. */
function documentedTypeCheck(): string {
  const agentsMd = readFileSync(join(dest, "AGENTS.md"), "utf-8");
  const row = agentsMd.match(/^\|\s*Type check\s*\|\s*`([^`]+)`\s*\|/m);
  if (!row) throw new Error("AGENTS.md has no Type check row — nothing to run");
  return row[1];
}

function runDocumentedTypeCheck(): { status: number; output: string } {
  const result = spawnSync("sh", ["-c", documentedTypeCheck()], { cwd: dest, encoding: "utf-8" });
  if (result.error) throw result.error;
  // A signal death reports status null, which `=== 0` would never catch but
  // `!== 0` would read as a type error. Make it an explicit failure instead.
  if (result.status === null) throw new Error(`type check killed by signal ${result.signal}`);
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("#72 AC-3: the documented Type check command checks real files", () => {
  beforeAll(() => {
    scaffoldMinimalProject(dest);
    // Warm the toolchain so the three runs below measure type checking rather
    // than a one-off dependency resolution.
    runDocumentedTypeCheck();
  }, 300_000);

  afterAll(() => rmSync(dest, { recursive: true, force: true }));

  test("passes on the untouched consumer", () => {
    writeFileSync(SOURCE, CLEAN);
    const { status, output } = runDocumentedTypeCheck();
    expect({ status, output }).toMatchObject({ status: 0 });
  }, 300_000);

  test("fails, naming the file, once a type error is planted", () => {
    writeFileSync(SOURCE, BROKEN);
    const { status, output } = runDocumentedTypeCheck();
    expect(status).not.toBe(0);
    expect(output).toContain("src/index.ts");
    // Guards against passing for the wrong reason — tsc printing its help text
    // and exiting 1 is the #65/#76 failure mode, and it would satisfy a bare
    // non-zero assertion.
    expect(output).toMatch(/error TS2322/);
    expect(output).not.toMatch(/tsc: The TypeScript Compiler/);
  }, 300_000);

  test("passes again once the planted error is removed", () => {
    writeFileSync(SOURCE, CLEAN);
    const { status, output } = runDocumentedTypeCheck();
    expect({ status, output }).toMatchObject({ status: 0 });
  }, 300_000);
});
