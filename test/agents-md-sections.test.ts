/**
 * Covers SC-1950..SC-1954 (HARNESS-STANDARD.md), #568.
 *
 * `specs/bootstrap-data-flow/problem-statement.md` promises that the Hard
 * Constraints section of AGENTS.md is the one piece of user-owned content
 * that survives regeneration. Nothing implemented it: the scaffold built
 * AGENTS.md from a template and called `writeFileSync`. Measured on a
 * consumer, one run removed 37 constraint lines — the test-container
 * promotion sequence, a permanently-disabled endpoint, the deploy command —
 * and reported `REGENERATED: AGENTS.md`, exit 0.
 *
 * The fixtures run the REAL scaffold over a real project, twice, because
 * the thing under test is what a re-scaffold does and a unit test of the
 * merge function would have passed on the day the bug shipped: the merge
 * function did not exist, and neither did the call to it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { preserveSections, readHardConstraints } from "../lib/agents-md-sections";
import { SCAFFOLD_REFUSE } from "../lib/scaffold/owned-files";
import { decideOwnedWrite } from "../lib/scaffold/owned-files";
import { regenerateOwned } from "../lib/scaffold/steps";

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const SCAFFOLD = join(REPO_ROOT, "scripts", "scaffold-project.ts");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * The section as a consumer actually had it: eight lines between the
 * extractor's markers and hand-written ones after. Both halves matter —
 * preserving only the marked block would rescue what a machine can
 * regenerate and drop what only a human holds.
 */
const CONSTRAINTS = `## Hard Constraints (non-inferrable — agents cannot discover these from code)
<!-- BEGIN AUTO-EXTRACTED -->
- **extracted: the ci suite targets the test port only** — never the live one
- **extracted: destructive cases run on the test port only**
<!-- END AUTO-EXTRACTED -->
- **hand-written: the scraper endpoint is permanently disabled** — use the sidebar
- **hand-written: deploy is one rebuild at the end, then verify the health route**`;

/** A minimal consumer with an AGENTS.md already carrying the section. */
function project(agentsMd: string | null): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-568-")));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer-568", version: "1.0.0", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
  );
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  if (agentsMd !== null) writeFileSync(join(root, "AGENTS.md"), agentsMd);
  return root;
}

function scaffold(root: string): string {
  return execFileSync("bun", ["run", SCAFFOLD, root, "--fix"], {
    encoding: "utf-8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const agentsMdOf = (root: string): string => readFileSync(join(root, "AGENTS.md"), "utf-8");

describe("#568: the one section the spec guarantees survives regeneration", () => {
  test("SC-1950: a re-scaffold leaves every Hard Constraints line where it found it", () => {
    const seeded = `# consumer-568\n\n## Project Identity\n\nA consumer.\n\n${CONSTRAINTS}\n\n## Workflow\n\n- **Test:** \`bun test\`\n`;
    const root = project(seeded);
    scaffold(root);

    const after = agentsMdOf(root);

    // The instrument, and the reason this is not a tautology: the run really
    // did rewrite the file. Without this, a scaffold that silently skipped
    // AGENTS.md entirely would satisfy every assertion below.
    expect(after, "the scaffold did not regenerate anything, so nothing was preserved").toContain("## Commands");
    expect(after).not.toBe(seeded);

    // Line by line, not "the heading is still there". A heading over an
    // emptied section is exactly what the consumer was left with, and it is
    // what a `toContain("Hard Constraints")` assertion certifies.
    for (const line of CONSTRAINTS.split("\n")) {
      expect(after, `a constraint line did not survive: ${line}`).toContain(line);
    }
    // Including both markers and the hand-written lines outside them, which
    // is the half a marker-anchored implementation would have dropped.
    expect(after).toContain("<!-- BEGIN AUTO-EXTRACTED -->");
    expect(after).toContain("<!-- END AUTO-EXTRACTED -->");
    expect(readHardConstraints(after)?.text, "the section came back altered").toBe(CONSTRAINTS);

    // A second run over the output of the first is byte-identical — SC-364
    // asks that of every generator here, and a merge that re-inserted at a
    // different place each run would quietly grow the file forever.
    scaffold(root);
    expect(agentsMdOf(root), "the second run moved it").toBe(after);
  }, 240_000);

  test("SC-1951: a project with no such section is regenerated as before", () => {
    // The positive control. Every assertion above is satisfied by a writer
    // that refuses to touch AGENTS.md at all.
    const root = project(null);
    scaffold(root);
    const after = agentsMdOf(root);
    expect(after).toContain("## Project Identity");
    expect(after).toContain("## Commands");
    expect(readHardConstraints(after), "a section was invented out of nothing").toBeNull();

    // And an EMPTY section is not a section: a heading with nothing under it
    // is what somebody's last edit left, and carrying it forward would make
    // "preserved nothing" indistinguishable from "preserved something".
    expect(readHardConstraints("# x\n\n## Hard Constraints\n\n## Rules\n\n- a\n")).toBeNull();
  }, 240_000);

  test("SC-1952: a merge that would drop a line refuses, and names the line", () => {
    // Reached through the one binding every owned file routes through, not
    // through the merge function: a strategy implemented at a call site and
    // missing from `decideOwnedWrite` is how AGENTS.md came to be the only
    // rewritten file in the tree with no declared strategy.
    const existing = `# p\n\n${CONSTRAINTS}\n\n## Rules\n\n- a\n`;

    // A generated template that carries its OWN Hard Constraints section —
    // not a case today, which is exactly why it must not be waved through.
    const generatedWithOwn = `# p\n\n## Hard Constraints\n\n- something else entirely\n\n## Rules\n\n- a\n`;
    const refused = decideOwnedWrite("section-preserving", existing, generatedWithOwn);
    expect(refused.action, "a write that loses user content was allowed").toBe("refuse");
    expect(refused.content, "a refusal still handed bytes to the writer").toBeUndefined();
    for (const line of ["<!-- BEGIN AUTO-EXTRACTED -->", "- **hand-written: the scraper endpoint is permanently disabled** — use the sidebar"]) {
      expect(refused.reason, `the refusal does not name ${line}`).toContain(line);
    }

    // …and the refusal reaches the report rather than being swallowed, with
    // the file left exactly as it was.
    const root = project(existing);
    const actions: string[] = [];
    regenerateOwned(join(root, "AGENTS.md"), generatedWithOwn, "AGENTS.md", actions, "section-preserving");
    expect(agentsMdOf(root), "the file was overwritten despite the refusal").toBe(existing);
    expect(actions.join("\n")).toContain(SCAFFOLD_REFUSE);
    expect(actions.join("\n")).toContain("would be lost");

    // The ordinary case is still written, or the refusal above is satisfied
    // by a strategy that refuses everything.
    const ok: string[] = [];
    regenerateOwned(join(root, "AGENTS.md"), "# p\n\n## Rules\n\n- b\n", "AGENTS.md", ok, "section-preserving");
    const after = agentsMdOf(root);
    expect(ok.join("\n")).toContain("CHANGED: AGENTS.md");
    expect(after).toContain("- b");
    expect(after).toContain(CONSTRAINTS.split("\n")[0]);
  });

  test("SC-1953: AGENTS.md is written through the owned-file writer, so the symlink refusal covers it", () => {
    // #507 gave every owned file a symlink refusal. AGENTS.md was written
    // with a bare `writeFileSync`, which FOLLOWS a link — so the one file
    // every consumer has was the one the refusal could not reach.
    const victimDir = realpathSync(mkdtempSync(join(tmpdir(), "rg-568-outside-")));
    roots.push(victimDir);
    const victim = join(victimDir, "theirs.md");
    writeFileSync(victim, "someone else's file\n");

    const root = project(null);
    rmSync(join(root, "AGENTS.md"), { force: true });
    symlinkSync(victim, join(root, "AGENTS.md"));

    const actions: string[] = [];
    regenerateOwned(join(root, "AGENTS.md"), "# generated\n", "AGENTS.md", actions, "section-preserving");
    expect(readFileSync(victim, "utf-8"), "the generator wrote through a link, outside the project").toBe(
      "someone else's file\n",
    );
    expect(actions.join("\n")).toContain("is a symlink");

    // Asserted on the pipeline too, because the refusal lives in the writer
    // and the defect was the call site not using it.
    const pipeline = readFileSync(join(REPO_ROOT, "lib", "scaffold", "write-steps.ts"), "utf-8");
    expect(pipeline, "AGENTS.md is written with a bare writeFileSync again").not.toMatch(
      /writeFileSync\(join\(projectPath, "AGENTS\.md"\)/,
    );
  });

  test("SC-1954: the section is read as a section, not as a prefix match", () => {
    // Boundaries, because every one of them was a way to lose content:
    // the section runs to the NEXT `##` heading and no further, a `###`
    // inside it belongs to it, and a heading at EOF has no terminator.
    const doc = `# p\n\n## Hard Constraints\n\n- a\n\n### a sub-heading inside it\n\n- b\n\n## Rules\n\n- not mine\n`;
    const read = readHardConstraints(doc);
    expect(read?.lines).toEqual(["## Hard Constraints", "- a", "### a sub-heading inside it", "- b"]);
    expect(read?.text, "the next section was swallowed").not.toContain("not mine");

    expect(readHardConstraints(`# p\n\n## Rules\n\n- a\n\n## Hard Constraints\n\n- last\n`)?.lines).toEqual([
      "## Hard Constraints",
      "- last",
    ]);

    // A generated file with no anchor section at all still carries it —
    // appended rather than dropped, which is the direction this is allowed
    // to be wrong in.
    const appended = preserveSections(`# p\n\n${CONSTRAINTS}\n`, "# p\n\n## Nothing Familiar\n\n- a\n");
    expect(appended.lost).toEqual([]);
    expect(appended.content).toContain("- **hand-written: deploy is one rebuild at the end, then verify the health route**");

    // The anchor is the generated file's `## Rules`, so constraints are read
    // before the harness's own advice rather than after the Commands table.
    const anchored = preserveSections(`# p\n\n${CONSTRAINTS}\n`, "# p\n\n## Rules\n\n- a\n\n## Commands\n\n- b\n");
    expect(anchored.content.indexOf("## Hard Constraints")).toBeLessThan(anchored.content.indexOf("## Rules"));
    expect(anchored.lost).toEqual([]);
  });
});
