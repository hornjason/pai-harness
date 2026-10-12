/**
 * #343 — the scaffold inferred one consumer's Makefile targets from the mere
 * existence of a Makefile.
 *
 *     start:   existsSync(makefile) ? "make dev-all" : "bun run dev"
 *     rebuild: existsSync(makefile) ? "make rebuild" : undefined
 *
 * `dev-all` and `rebuild` are target names, not a property of having a
 * Makefile. A project with a Makefile and neither target got both commands
 * written into its `rungate.json`, and the failure surfaces much later as
 * `make: *** No rule to make target 'rebuild'` — read as a broken build
 * rather than as a scaffold that guessed.
 *
 * `scripts/scaffold-rungate-config.ts:66` already tested for the target
 * (`/^rebuild/m`). This brings the two into line rather than inventing a
 * third behaviour; the parity is asserted below, because two inference sites
 * drifting is how one of them came to be wrong.
 *
 * Covers SC-750 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { generateOrAuditProjectHarness } from "../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(REPO_ROOT, ".scaffold-make-targets-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
/** A project directory carrying exactly the Makefile given (or none). */
function project(makefile: string | null): string {
  const dir = join(SCRATCH, `p${n++}`);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (makefile !== null) writeFileSync(join(dir, "Makefile"), makefile);
  return dir;
}

function harnessOf(dir: string): any {
  const actions: string[] = [];
  generateOrAuditProjectHarness(dir, actions);
  for (const p of [join(dir, ".claude", "rungate.json"), join(dir, ".claude", "rungate", "config.json")]) {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {}
  }
  throw new Error(`no generated config found under ${dir}`);
}

describe("#343: a make target is inferred from the target, not from the file", () => {
  test("a Makefile WITH both targets gets both commands", () => {
    // The positive control, and it has to come first: a change that simply
    // stopped emitting these would satisfy every negative case below.
    const h = harnessOf(project("dev-all:\n\techo dev\n\nrebuild:\n\techo rebuild\n"));
    expect(h.dev?.start).toBe("make dev-all");
    expect(h.prod?.rebuild).toBe("make rebuild");
  });

  test("a Makefile with NEITHER target gets neither command", () => {
    // The bug. Before #343 this project was handed `make dev-all` and
    // `make rebuild`, both of which fail with "No rule to make target".
    const h = harnessOf(project("build:\n\techo build\n\ntest:\n\techo test\n"));
    expect(h.dev?.start, "a target that does not exist was written into the config").not.toBe("make dev-all");
    expect(h.prod?.rebuild, "a rebuild target that does not exist was written into the config").toBeUndefined();
  });

  test("a Makefile with only ONE of them gets only that one", () => {
    // Each target is decided on its own. A single `hasMakefile` flag deciding
    // both is the shape of the original defect.
    const h = harnessOf(project("rebuild:\n\techo rebuild\n"));
    expect(h.prod?.rebuild).toBe("make rebuild");
    expect(h.dev?.start).not.toBe("make dev-all");
  });

  test("no Makefile at all falls back, as before", () => {
    const h = harnessOf(project(null));
    expect(h.dev?.start).toBe("bun run dev");
    expect(h.prod?.rebuild).toBeUndefined();
  });

  test("a target named as a SUBSTRING of another does not count", () => {
    // `rebuild-all:` is a different target. Matching it would reinstate the
    // guess with an extra step.
    const h = harnessOf(project("rebuild-all:\n\techo nope\n"));
    expect(h.prod?.rebuild).toBeUndefined();
  });

  test("the two inference sites agree — they drifted once already", () => {
    // `scripts/scaffold-rungate-config.ts` tested the target; `steps.ts`
    // tested the file. Nothing compared them, so one could be fixed and the
    // other left, which is how the harness ends up with two answers to the
    // same question.
    const other = readFileSync(join(REPO_ROOT, "scripts", "scaffold-rungate-config.ts"), "utf-8");
    expect(other, "the sibling no longer checks for the target").toMatch(/\^rebuild/);
    const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(steps, "steps.ts is back to inferring from the file's existence").not.toMatch(
      /existsSync\(makefile\) \? "make /,
    );
  });
});
