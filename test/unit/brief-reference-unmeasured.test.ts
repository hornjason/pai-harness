/**
 * AGENT-6 reports UNMEASURED when the corpus it resolves into is absent (#884).
 *
 * A ship worktree is created without an install. The consuming repo's
 * conformity suite ships inside `node_modules/rungate/`, and AGENT-6 resolves
 * every `node_modules/...` path an agent brief names. With no install those
 * paths cannot be resolved — and the check reported them as BROKEN:
 *
 *     (fail) Agent File Validation > AGENT-6: All file paths referenced in briefs exist
 *       quinn.md -> node_modules/rungate/prompts/quinn-decision-tree.md
 *       quinn.md -> node_modules/rungate/prompts/quinn-ui-brief.md
 *
 * Both files exist. `.claude/agents/quinn.md` is correct; the corpus is
 * missing. `record-local-env` runs the suite in the worktree, so that FAIL was
 * recorded as `environments.local.tests` and failed `verify checks > tests-pass`
 * on every run — runs `wf_99ed276b-cf3` (#1792) and `wf_ef717e60-bbd` (#1815)
 * both died at VERIFY_FAILED with AGENT-6 as their only red.
 *
 * This file covers option 3 of the issue: a conformity check whose corpus is
 * absent did not run, so it reports UNMEASURED by name rather than FAIL.
 * Sharing the install (option 2) is deliberately NOT in scope — the issue ties
 * it to #869's mechanism, and #728/#869 are the record of symlinking this exact
 * directory going wrong.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * `if (!existsSync(join(root, "node_modules"))) return;` at the top of AGENT-6.
 * One line, the symptom goes away on every worktree, and the check goes
 * SILENT: a run with no install then reports `tests: PASS`, byte-identical to a
 * run in which every reference resolved. That is *Silent Default Substitution*
 * from `.claude/rules/config-access.md` — `0`, `{}`, `SKIP` and silence are
 * indistinguishable from success; `UNMEASURED` is not.
 *
 * Every case below that could be satisfied by greenness alone is paired with
 * one asserting the reading was RECORDED and names the reference. The early
 * return records nothing, so those stay red under it. AC-9 is the witness.
 *
 * It also fails a second way, and AC-6 is the case for it: `node_modules`
 * present with one package missing is a partial install, and a guard that asks
 * only about `node_modules` calls that reference broken.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  briefReferenceReading,
  corpusOf,
  unmeasuredBriefReferenceNotice,
} from "../../lib/brief-references";
import { readJunitOutcomes } from "../../lib/junit-checks";

const REPO = join(import.meta.dir, "..", "..");
const CONFORMITY = join(REPO, "lib", "conformity.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project tree. Keys are repo-relative paths; every parent is created. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-884-"));
  scratch.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const at = join(root, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
  }
  return root;
}

const BRIEF = (ref: string) =>
  `---\nname: quinn\ndescription: QA\n---\n\nRead \`${ref}\` before testing.\n`;

const agentsDirOf = (root: string) => join(root, ".claude", "agents");
const reading = (root: string) => briefReferenceReading(root, agentsDirOf(root));

describe("#884 AC-1..AC-7: the reading", () => {
  test("AC-1: the run's input — no install, so the reference is UNMEASURED and not broken", () => {
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-decision-tree.md"),
    });
    const r = reading(root);
    expect(r.references).toHaveLength(1);
    expect(r.broken).toEqual([]);
    expect(r.unresolvable.map(u => u.ref)).toEqual([
      "node_modules/rungate/prompts/quinn-decision-tree.md",
    ]);
    expect(r.unresolvable[0]!.packageRoot).toBe("node_modules/rungate");
    expect(r.unresolvable[0]!.brief).toBe("quinn.md");
    expect(r.reading).toBe("UNMEASURED");
    expect(r.absentCorpora).toEqual(["node_modules/rungate"]);
  });

  test("AC-2: installed and present — MEASURED, nothing reported", () => {
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-decision-tree.md"),
      "node_modules/rungate/prompts/quinn-decision-tree.md": "# tree\n",
    });
    const r = reading(root);
    expect(r.references.map(x => x.status)).toEqual(["resolved"]);
    expect(r.broken).toEqual([]);
    expect(r.unresolvable).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("AC-3: installed and MISSING is still broken — an absent corpus is not how a real finding is silenced", () => {
    // The fail-open control. AC-1 and AC-2 are both satisfied by a reading
    // that never reports anything; this is the input that separates them.
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/typo.md"),
      "node_modules/rungate/package.json": "{}\n",
    });
    const r = reading(root);
    expect(r.broken.map(b => b.ref)).toEqual(["node_modules/rungate/prompts/typo.md"]);
    expect(r.unresolvable).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("AC-4: a broken reference and an absent corpus are reported together, neither suppressing the other", () => {
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/typo.md"),
      ".claude/agents/marcus.md": BRIEF("node_modules/ghost/prompts/x.md"),
      "node_modules/rungate/package.json": "{}\n",
    });
    const r = reading(root);
    expect(r.broken.map(b => b.ref)).toEqual(["node_modules/rungate/prompts/typo.md"]);
    expect(r.unresolvable.map(u => u.ref)).toEqual(["node_modules/ghost/prompts/x.md"]);
    // A tree that holds both is both: the suite still fails on the broken one,
    // and the reading still says a part of it was never looked at.
    expect(r.reading).toBe("UNMEASURED");
  });

  test("AC-5: a scoped package's corpus is the package, not the scope", () => {
    // #585's pair discipline: the two halves vary exactly one thing — whether
    // `node_modules/@acme/kit` exists. The scope directory is present in both,
    // so a corpus computed as `node_modules/@acme` cannot tell them apart.
    const files = { ".claude/agents/quinn.md": BRIEF("node_modules/@acme/kit/doc.md") };
    const scopeOnly = project({ ...files, "node_modules/@acme/other/package.json": "{}\n" });
    const installed = project({ ...files, "node_modules/@acme/kit/package.json": "{}\n" });

    expect(corpusOf("node_modules/@acme/kit/doc.md")).toBe("node_modules/@acme/kit");
    expect(reading(scopeOnly).unresolvable.map(u => u.packageRoot)).toEqual([
      "node_modules/@acme/kit",
    ]);
    expect(reading(scopeOnly).broken).toEqual([]);
    expect(reading(installed).broken.map(b => b.ref)).toEqual(["node_modules/@acme/kit/doc.md"]);
    expect(reading(installed).unresolvable).toEqual([]);
  });

  test("AC-6: a partial install — node_modules present, the package absent — is UNMEASURED", () => {
    // The input a `!existsSync(root/node_modules)` guard cannot see. It is the
    // same question one level down, and the cheap guard answers it wrong.
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-ui-brief.md"),
      "node_modules/zod/package.json": "{}\n",
    });
    const r = reading(root);
    expect(r.broken).toEqual([]);
    expect(r.unresolvable.map(u => u.packageRoot)).toEqual(["node_modules/rungate"]);
    expect(r.reading).toBe("UNMEASURED");
  });

  test("AC-7: the notice names UNMEASURED, the absent corpus and what to do", () => {
    const root = project({
      ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-ui-brief.md"),
    });
    const notice = unmeasuredBriefReferenceNotice(reading(root));
    expect(notice).toContain("UNMEASURED");
    expect(notice).toContain("node_modules/rungate");
    expect(notice).toContain("quinn.md");
    expect(notice, "a notice that does not say what was missing is one nobody can act on")
      .toContain("install");
  });

  test("AC-7b: a tree with nothing to resolve produces no notice at all", () => {
    // Vacuity control for AC-7: a notice composed unconditionally would
    // contain the word UNMEASURED for a clean tree too.
    const root = project({
      ".claude/agents/quinn.md": "---\nname: quinn\ndescription: QA\n---\n\nNo references.\n",
    });
    const r = reading(root);
    expect(r.references).toEqual([]);
    expect(r.reading).toBe("MEASURED");
    expect(unmeasuredBriefReferenceNotice(r)).toBeNull();
  });

  test("AC-11: a project with no .claude/agents reads MEASURED and empty, and does not throw", () => {
    // #492: every fixture above holds the precondition "there is a briefs
    // directory with at least one reference in it", so the branch where there
    // is not is outside the battery's reach entirely. AGENT-6 has its own
    // early return for this; the binding must not throw when called directly.
    const r = reading(project({ "README.md": "# empty\n" }));
    expect(r.references).toEqual([]);
    expect(r.reading).toBe("MEASURED");
    expect(unmeasuredBriefReferenceNotice(r)).toBeNull();
  });

  test("AC-12: a reference to the package root itself is its own corpus", () => {
    // The other precondition every fixture above holds: the reference names a
    // path INSIDE a package. A brief that points at the package directory is
    // an ordinary thing to write, and there the corpus and the reference are
    // the same path — so the two existsSync calls ask one question, and the
    // answer must still be `unresolvable` rather than `broken`.
    const files = { ".claude/agents/quinn.md": BRIEF("node_modules/rungate") };
    const absent = project(files);
    const installed = project({ ...files, "node_modules/rungate/package.json": "{}\n" });

    expect(corpusOf("node_modules/rungate")).toBe("node_modules/rungate");
    expect(reading(absent).unresolvable.map(u => u.packageRoot)).toEqual(["node_modules/rungate"]);
    expect(reading(absent).broken).toEqual([]);
    expect(reading(installed).references.map(x => x.status)).toEqual(["resolved"]);
  });
});

/**
 * The spawned half.
 *
 * The composition is NOT rebuilt here. `test/config-access-conformity.test.ts`
 * records what rebuilding it bought: deleting the production check's whole
 * UNMEASURED block was 0 red over 9,652 tests, because every case was
 * exercising the helper rather than the check. So a generated suite imports the
 * real `runAgentFileValidation`, runs it against a planted project, and prints
 * what `getFindings()` holds — findings are recorded while the suite runs and
 * can only be read from a test declared after it.
 *
 * AGENT-6's own verdict is read out of the JUnit report, by name. A count of
 * failures would also be satisfied by one of the other ten AGENT checks — a
 * minimal planted brief reds AGENT-5, AGENT-7 and AGENT-8 — and a probe suite
 * that failed to load reports no failures at all, which is indistinguishable
 * from the check passing. `readJunitOutcomes` keeps the third state: a report
 * it could not read returns `passed: null`, not `[]`.
 */
function agent6(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "rungate-884-run-"));
  scratch.push(dir);
  const file = join(dir, "probe.test.ts");
  const report = join(dir, "report.xml");
  writeFileSync(
    file,
    `import { test } from "bun:test";\n` +
      `import { runAgentFileValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
      `clearFindings();\n` +
      `runAgentFileValidation(${JSON.stringify(root)});\n` +
      `test("zz-report", () => {\n` +
      `  console.log("F:" + JSON.stringify(getFindings().filter(f => f.ruleId.startsWith("AGENT-REF") || f.ruleId === "AGENT-BROKEN-REF")));\n` +
      `});\n`,
  );
  const r = spawnSync(
    "bun",
    ["test", "--reporter=junit", "--reporter-outfile", report, file],
    { cwd: REPO, encoding: "utf-8" },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  const outcomes = readJunitOutcomes(report);
  if (outcomes.passed === null) {
    throw new Error(`the probe suite produced no readable report (${outcomes.reason}):\n${out}`);
  }
  const named = (names: string[]) => names.filter(n => n.includes("AGENT-6:"));
  const green = named(outcomes.passed);
  const red = named(outcomes.failed);
  if (green.length + red.length !== 1) {
    throw new Error(
      `the probe suite ran AGENT-6 ${green.length + red.length} times, expected exactly 1:\n${out}`,
    );
  }

  const findings = JSON.parse(out.match(/F:(\[.*\])/)?.[1] ?? "null") as
    | Array<{ ruleId: string; severity: string; message: string; file: string }>
    | null;
  if (findings === null) throw new Error(`the probe suite never reported findings:\n${out}`);

  return {
    /** AGENT-6's own colour, read off its own testcase and not off a count. */
    red: red.length === 1,
    fails: findings.filter(f => f.severity === "FAIL"),
    warns: findings.filter(f => f.severity === "WARN"),
  };
}

describe("#884 AC-8..AC-10: AGENT-6 itself", () => {
  test("AC-8: the run's tree — no install — leaves AGENT-6 green", () => {
    const got = agent6(
      project({
        ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-decision-tree.md"),
      }),
    );
    expect(got.red).toBe(false);
    expect(got.fails).toEqual([]);
  });

  test("AC-9: …and SAYS SO — the wrong fix is green here too, and records nothing", () => {
    // The witness. An early `return` when node_modules is absent satisfies
    // AC-8 exactly and leaves this empty: silence is indistinguishable from a
    // tree in which every reference resolved.
    const got = agent6(
      project({
        ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/quinn-decision-tree.md"),
      }),
    );
    expect(got.warns).toHaveLength(1);
    expect(got.warns[0]!.ruleId).toBe("AGENT-REF-UNMEASURED");
    expect(got.warns[0]!.message).toContain("UNMEASURED");
    expect(got.warns[0]!.message).toContain("node_modules/rungate");
    expect(got.warns[0]!.file).toBe(".claude/agents/quinn.md");
  });

  test("AC-10: a reference missing from an INSTALLED package still fails AGENT-6", () => {
    // The suite-level fail-open control. Without it, every case above is
    // satisfied by an AGENT-6 that reports nothing under any input.
    const got = agent6(
      project({
        ".claude/agents/quinn.md": BRIEF("node_modules/rungate/prompts/typo.md"),
        "node_modules/rungate/package.json": "{}\n",
      }),
    );
    expect(got.red).toBe(true);
    expect(got.fails.map(f => f.ruleId)).toEqual(["AGENT-BROKEN-REF"]);
    expect(got.fails[0]!.message).toContain("node_modules/rungate/prompts/typo.md");
    expect(got.warns).toEqual([]);
  });
});
