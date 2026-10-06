/**
 * #86 — conformity collection must not mutate the specs it collects from.
 *
 * runScaffoldConformity() builds its test list at collection time by reading
 * SC checkboxes off disk, and used to register an afterAll that wrote those
 * same files back, flipping `- [ ] SC-N` to `- [x] SC-N`. Run N therefore
 * changed the input run N+1 collected from, and the generated test list
 * alternated between two shapes — 57 tests, then 99, then 57.
 *
 * Both parities reported 0 fail, so nothing surfaced it. The suite was not
 * hiding a failure; it was hiding whether 42 checks ran at all.
 *
 * Checkbox syncing still happens, deliberately, via the `posttest` hook in
 * package.json -> scripts/sync-sc-status.ts, which re-derives pass state
 * independently rather than riding on a test run's in-memory bookkeeping.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const CONFORMITY = join(REPO, "lib", "conformity.ts");

const SPEC = `---
doc-type: spec
testable: true
governs: a fixture spec used to prove conformity collection is read-only
---

# Fixture Spec

## Success Criteria

- [ ] SC-1: AGENTS.md exists
`;

/** A project whose single testable spec holds one SC that will pass. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "conformity-readonly-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "FIXTURE-SPEC.md"), SPEC);
  // Makes SC-1 pass, so the old afterAll would have had something to flip.
  writeFileSync(join(root, "AGENTS.md"), "# fixture\n");
  return root;
}

/**
 * Run the conformity suite against `root` in a separate bun process, so the
 * afterAll hook actually fires and any write lands before we inspect the file.
 */
function runConformityAgainst(root: string): void {
  const runner = join(root, "run-conformity.test.ts");
  writeFileSync(
    runner,
    `import { runScaffoldConformity } from ${JSON.stringify(CONFORMITY)};\n` +
      `runScaffoldConformity(${JSON.stringify(root)});\n`
  );
  try {
    execFileSync("bun", ["test", runner], { cwd: root, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
  } catch {
    // A failing assertion inside the fixture suite is not what this test is
    // about — we only care what the run did to the spec file on disk.
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
});

describe("#86: conformity collection is read-only", () => {
  test("a conformity run leaves the spec files it read byte-identical", () => {
    const root = makeProject();
    roots.push(root);
    const specPath = join(root, "specs", "FIXTURE-SPEC.md");
    const before = readFileSync(specPath, "utf-8");

    runConformityAgainst(root);

    expect(readFileSync(specPath, "utf-8")).toBe(before);
  });

  test("the SC checkbox is not flipped as a side effect of running tests", () => {
    const root = makeProject();
    roots.push(root);
    const specPath = join(root, "specs", "FIXTURE-SPEC.md");

    runConformityAgainst(root);

    const after = readFileSync(specPath, "utf-8");
    expect(after).toContain("- [ ] SC-1:");
    expect(after).not.toContain("- [x] SC-1:");
  });

  test("two consecutive runs collect the same tests", () => {
    const root = makeProject();
    roots.push(root);
    const runner = join(root, "run-conformity.test.ts");
    writeFileSync(
      runner,
      `import { runScaffoldConformity } from ${JSON.stringify(CONFORMITY)};\n` +
        `runScaffoldConformity(${JSON.stringify(root)});\n`
    );

    const counts = [0, 1].map(() => {
      let out = "";
      try {
        out = execFileSync("bun", ["test", runner], { cwd: root, encoding: "utf-8", stdio: "pipe", timeout: 60_000 });
      } catch (e: any) {
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      return out.match(/Ran (\d+) tests/)?.[1];
    });

    expect(counts[0]).toBeDefined();
    expect(counts[1]).toBe(counts[0]);
  });
});
