/**
 * `SUCCESS.md` is seeded, and an unfilled seed is REFUSED (#485).
 *
 * Covers SC-1706, SC-1707, SC-1708, SC-1709, SC-1710 (HARNESS-STANDARD.md).
 *
 * The gap: `CLAUDE.md` opens its rules with "SUCCESS.md is the measure", and
 * no generator, template or scaffold step ever produced one. rungate's own was
 * hand-written in `22aa5b20` and nothing reproduced it for anyone else, while
 * `specs/HARNESS-STANDARD.md` carried SC-822, which asserts a property of a
 * file the scaffold never wrote. (#485 says SC-822..824; checked, and only
 * SC-822 is about this file — the other two are about
 * `lib/distribution-standing.ts`. The new criteria are SC-1706..1710.)
 *
 * ## The case a file-exists check misses
 *
 * A generator alone makes it worse. An unfilled template is indistinguishable
 * from a considered one to everything except a reader — the same argument
 * `.claude/rules/checks-must-be-able-to-fail.md` makes about guards, applied
 * to a document. So the case written first here is #485's second one: a
 * project whose `SUCCESS.md` is the generator's own output, unmodified. A
 * check that only asks whether the file exists waves through every project
 * that ran `create-success` and stopped.
 *
 * ## Why the conformity cases are SPAWNED
 *
 * `runSuccessDocValidation` is a `describe`/`test` pair, so calling it from
 * this file would register its assertions in THIS suite, where a failure is
 * indistinguishable from a failure of the file. More to the point, #476's
 * review found the exact defect that invites: its test helper reimplemented
 * the composition, so DELETING the consumer block from the real function was
 * **0 red over 9,652 tests** — the guard counted call sites while the
 * mutation removed the caller. The lesson is mutate the call site, not just
 * the binding, and that is only possible if the call site is what runs. So
 * the real function is spawned under `bun test` over planted roots, and the
 * findings are read back from a test declared after it.
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * `test/success-doc.test.ts` (20 tests):
 *
 * | Mutation | Red | Predicted |
 * |---|---|---|
 * | `successViolations` short-circuited to a clean verdict | 10 | 10 |
 * | **the call site**: `if (verdict.unmeasured)` block deleted from `runSuccessDocValidation` | 1 | 1 |
 * | the placeholder refusal removed | 1 | 1 |
 * | `CLAIM_FORMS` narrowed to the heading form, dropping rungate's own | 3 | 3 |
 * | the `howItFails === null` refusal removed | 2 | 2 |
 * | `expect(violations).toEqual([])` dropped from the call site, `addFinding` kept | 2 | 2 |
 *
 * None is left in the tree; all were run and reverted.
 *
 * The call-site row is the one the battery was built for. It is 1 because
 * exactly one case — "absence is RECORDED, never silent" — drives a project
 * with no SUCCESS.md and then asks what the check WROTE rather than whether
 * it failed. Delete that case and the row is 0, which is #476's defect
 * verbatim: `violations` is empty for an absent file, so the assertion below
 * the deleted block passes and the check goes green over a project that has
 * no SUCCESS.md at all.
 *
 * Two findings came out of writing this rather than out of the battery, both
 * recorded here because they are the same mistake the file is about:
 *
 * - The first `FALSIFIABILITY` admitted `**How to measure it:**` alongside
 *   `**How it fails:**`. Case 3's fixture deleted the `How it fails` line and
 *   the claim was STILL considered falsifiable, because the measurement line
 *   matched — a claim could satisfy the rule while saying only how to look.
 *   The fixture failing is what surfaced it; a fixture that deleted both
 *   would have passed and hidden it.
 * - The first `parseSuccessDoc` recognised only `### Claim N — ...`, so
 *   rungate's own SUCCESS.md — the only real instance of this document, and
 *   the one the methodology is named after — reported "defines no claims".
 *   `rungate's OWN SUCCESS.md passes the check it ships` is the regression.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { PLACEHOLDER_MARKER, parseSuccessDoc, successViolations } from "../lib/success-doc";
import { extractTestFailureCount } from "../gates/gate-executor";

const ROOT = join(import.meta.dir, "..");
const CONFORMITY = join(ROOT, "lib", "conformity.ts");
const TEMPLATE = join(ROOT, "templates", "SUCCESS-TEMPLATE.md");
const CREATE_SUCCESS = join(ROOT, "scripts", "create-success.ts");

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "rg-success-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

let seq = 0;
/** A project tree described as `relative path -> contents`. */
function project(files: Record<string, string>): string {
  const root = join(scratch, `p${seq++}`);
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** A SUCCESS.md that satisfies every rule, in the template's heading form. */
const FILLED = `# What we are building, and how we will know it worked

## The thing

A command-line tool that turns a spec into a runnable test.

## What this is not

Not a test framework. It produces input for one.

### Claim 1 — a spec with no testable criteria is rejected, not silently skipped

**How it fails:** a spec whose criteria are all prose produces zero tests and
exit code 0.

**How to measure it:** \`bun test test/spec-to-test.test.ts\`

## Standing

| Claim | Standing | Measured |
|---|---|---|
| 1 | untested | — |
`;

// ── The four cases #485 names, driven through the REAL check ────────────────

/**
 * Spawn the REAL `runSuccessDocValidation` over a planted root.
 *
 * `ran` exists because a spawned file that failed to load reports zero
 * failures, which is indistinguishable from the check passing.
 */
function runSuccess1(projectRoot: string): {
  failures: number;
  ran: number;
  findings: Array<Record<string, string>>;
} {
  const file = join(scratch, `s1-${seq++}.test.ts`);
  writeFileSync(
    file,
    `import { test } from "bun:test";\n` +
      `import { runSuccessDocValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
      `clearFindings();\n` +
      `runSuccessDocValidation(${JSON.stringify(projectRoot)});\n` +
      `test("zz-report-findings", () => {\n` +
      `  console.log("FINDINGS:" + JSON.stringify(getFindings().filter(f => f.ruleId === "SUCCESS-1")));\n` +
      `});\n`,
  );
  const r = spawnSync("bun", ["test", file], { cwd: ROOT, encoding: "utf-8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const marker = out.match(/FINDINGS:(\[.*\])/);
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  return {
    failures: extractTestFailureCount(out),
    ran: pass + extractTestFailureCount(out),
    findings: marker ? JSON.parse(marker[1]) : [],
  };
}

describe("SC-1707/SC-1708: the check refuses the four states #485 names", () => {
  test("case 1: no SUCCESS.md does not FAIL a project that never opted in", () => {
    const r = runSuccess1(project({ "README.md": "# a project\n" }));
    expect(r.ran, "the spawned suite never loaded").toBeGreaterThan(0);
    expect(r.failures, "a project that never opted in was failed, not measured").toBe(0);
  });

  test("case 1, the half that matters: absence is RECORDED, never silent", () => {
    // The call-site test. Deleting the `if (verdict.unmeasured)` block from
    // `runSuccessDocValidation` leaves `violations` empty, so the assertion
    // below it passes and the whole check goes green over a project with no
    // SUCCESS.md at all. `0`, `{}`, `null` and `SKIP` are indistinguishable
    // from success — see `.claude/rules/config-access.md`. Only this case can
    // tell the difference, and #476 is the issue that proved a check counting
    // its own call sites cannot.
    const r = runSuccess1(project({ "README.md": "# a project\n" }));
    expect(r.findings.length, "SUCCESS.md was absent and nothing recorded it").toBe(1);
    expect(r.findings[0]!.severity).toBe("WARN");
    expect(r.findings[0]!.message).toContain("UNMEASURED");
    expect(r.findings[0]!.message, "the skip does not say how to fix it").toContain(
      "create-success",
    );
  });

  test("case 2: the generator's output UNMODIFIED is refused", () => {
    // #485: "the case a naive file-exists check misses". Written first on
    // purpose — a check that only tests existence passes over every project
    // that ran the generator and stopped.
    const r = runSuccess1(project({ "SUCCESS.md": readFileSync(TEMPLATE, "utf-8") }));
    expect(r.ran).toBeGreaterThan(0);
    expect(r.failures, "an unfilled template was accepted as a considered one").toBe(1);
  });

  test("case 3: claims with no falsifiability line are refused, by number", () => {
    const noFails = FILLED.replace(/\*\*How it fails:\*\*[^\n]*\n[^\n]*\n/, "");
    const r = runSuccess1(project({ "SUCCESS.md": noFails }));
    expect(r.failures, "a claim nothing can falsify was accepted").toBe(1);
    expect(r.findings.map(f => f.message).join("\n")).toContain("claim 1");
  });

  test("case 4: a filled-in SUCCESS.md passes, and records nothing", () => {
    // The positive control. A check that refused everything would satisfy all
    // three cases above and fail every consumer on day one. The second
    // assertion is the other half: UNMEASURED is not a synonym for OK, so a
    // satisfied check must be silent rather than reassuring.
    const r = runSuccess1(project({ "SUCCESS.md": FILLED }));
    expect(r.ran).toBeGreaterThan(0);
    expect(r.failures, "a complete SUCCESS.md was refused").toBe(0);
    expect(r.findings, "a satisfied check recorded a finding anyway").toEqual([]);
  });
});

// ── The decider itself ──────────────────────────────────────────────────────

describe("SC-1706: `successViolations` is the one place that decides", () => {
  test("a surviving placeholder is refused even when everything else is filled", () => {
    // Isolates the placeholder rule from the TODO rules. The template fails
    // for several reasons at once, so a case built from the template alone
    // cannot tell which rule is load-bearing.
    const withMarker = FILLED.replace(
      "## The thing",
      `## The thing\n\n<!-- ${PLACEHOLDER_MARKER} -->`,
    );
    const v = successViolations(withMarker);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain("placeholder");
    expect(v.violations[0], "the refusal does not say which line").toContain("line(s)");
  });

  test("a claim with no falsifiability line is refused", () => {
    const v = successViolations(FILLED.replace(/\*\*How it fails:\*\*[^\n]*\n[^\n]*\n/, ""));
    expect(v.violations.join("\n")).toContain("How it fails");
    expect(v.violations.join("\n"), "a slogan is not a claim").toContain("slogan");
  });

  test("the standing table naming a claim nothing defines is refused", () => {
    const v = successViolations(FILLED.replace("| 1 | untested | — |", "| 1 | untested | — |\n| 2 | met | 2026-01-01 |"));
    expect(v.violations.join("\n")).toContain("row for claim 2");
  });

  test("a claim with no standing row is refused — the direction that rots quietly", () => {
    // The inverse, and the one nobody notices: a claim added and never given
    // a row reads as met by omission.
    const v = successViolations(FILLED.replace(/\| 1 \| untested \| — \|\n/, ""));
    expect(v.violations.join("\n")).toContain("claim 1 has no row");
    expect(v.violations.join("\n")).toContain("met by omission");
  });

  test("a complete document is clean", () => {
    expect(successViolations(FILLED).violations).toEqual([]);
    expect(successViolations(FILLED).unmeasured).toBeNull();
  });

  test("absent is UNMEASURED and carries no violations — the two are different answers", () => {
    const v = successViolations(null);
    expect(v.violations, "absence was reported as a violation").toEqual([]);
    expect(v.unmeasured).toContain("UNMEASURED");
  });
});

// ── The documents that actually exist ───────────────────────────────────────

describe("SC-1709: both claim forms parse, and the real documents are the cases", () => {
  test("rungate's OWN SUCCESS.md passes the check it ships", () => {
    // The regression this describe block exists for. The first draft of
    // `parseSuccessDoc` recognised only `### Claim N — ...`, and run against
    // the only real instance of the document it validates — hand-written four
    // months before the validator, in `1. **statement**` / `Check:` form — it
    // reported "SUCCESS.md defines no claims". A validator whose single
    // real-world example fails it is not strict, it is miscalibrated, and the
    // repair people reach for is to stop running it.
    const v = successViolations(readFileSync(join(ROOT, "SUCCESS.md"), "utf-8"));
    expect(v.violations, v.violations.join("\n")).toEqual([]);
    expect(v.unmeasured).toBeNull();
  });

  test("the template SHIPPED on disk is refused, read from the file the CLI copies", () => {
    // Not a fixture copy. If someone "fixes" the template by filling in its
    // placeholders, the generator starts handing every consumer a document
    // that passes while saying nothing, and this is what notices.
    const v = successViolations(readFileSync(TEMPLATE, "utf-8"));
    expect(v.violations.length, "the shipped template is accepted as a real SUCCESS.md")
      .toBeGreaterThan(0);
    expect(v.violations.join("\n")).toContain("placeholder");
  });

  test("the numbered form and the heading form are read the same way", () => {
    const heading = successViolations(FILLED);
    const numbered = successViolations(
      FILLED
        .replace(
          "### Claim 1 — a spec with no testable criteria is rejected, not silently skipped",
          "1. **a spec with no testable criteria is rejected, not silently skipped**",
        )
        .replace(/\*\*How it fails:\*\*/, "   Check:"),
    );
    expect(numbered.violations, numbered.violations.join("\n")).toEqual([]);
    expect(numbered.violations).toEqual(heading.violations);
  });

  test("`Check:` counts as falsifiability, and an indented one still attaches", () => {
    const d = parseSuccessDoc(
      "1. **the thing works**\n   Check: run `bun test` and watch it go red.\n",
    );
    expect(d.claims).toHaveLength(1);
    expect(d.claims[0]!.howItFails, "an indented Check: was not attached to its claim")
      .toContain("bun test");
  });

  test("a standing row whose first cell is not a number is skipped, not refused", () => {
    // rungate's table carries a `| consumer list |` row, and the file holds
    // two unrelated `| mutation |` tables. Refusing those would make the check
    // unusable on the document it was written for.
    const text = [
      "### Claim 1 — the thing works",
      "**How it fails:** it returns the wrong answer for an empty input.",
      "| Claim | Standing |",
      "|---|---|",
      "| 1 — x works | untested |",
      "| consumer list | surveyed |",
      "| the guard removed | 3 of 9 red |",
    ].join("\n");
    expect(parseSuccessDoc(text).standingRows, "a prose row was counted as a claim")
      .toEqual([1]);
    expect(successViolations(text).violations, "a prose row was refused as an unknown claim")
      .toEqual([]);
  });
});

// ── The generator ───────────────────────────────────────────────────────────

describe("SC-1710: `create-success` seeds the structure and refuses to overwrite", () => {
  const run = (args: string[], cwd = ROOT) =>
    spawnSync("bun", [CREATE_SUCCESS, ...args], { cwd, encoding: "utf-8" });

  test("it writes SUCCESS.md from the template and fills in owner and date", () => {
    const root = project({});
    const r = run(["--project-root", root, "--owner", "a-person"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const body = readFileSync(join(root, "SUCCESS.md"), "utf-8");
    expect(body).toContain("owner: a-person");
    expect(body, "the date placeholder survived").not.toContain("TODO-DATE");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
  });

  test("the file it writes is REFUSED by the checker — the generator is not the answer", () => {
    // The seam the whole issue turns on. `create-success` must leave the
    // project louder than it found it, not quieter: a project that runs the
    // generator and stops is refused, where one that never ran it is only
    // unmeasured.
    const root = project({});
    expect(run(["--project-root", root]).status).toBe(0);
    const v = successViolations(readFileSync(join(root, "SUCCESS.md"), "utf-8"));
    expect(v.violations.length, "the generator's own output passes its own check")
      .toBeGreaterThan(0);
  });

  test("it refuses to overwrite, and leaves the bytes alone", () => {
    const root = project({ "SUCCESS.md": FILLED });
    const r = run(["--project-root", root]);
    expect(r.status, "a project's own SUCCESS.md was regenerated over").toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(join(root, "SUCCESS.md"), "utf-8"), "the file was modified anyway")
      .toBe(FILLED);
  });

  test("a missing template is NAMED, not an ENOENT stack", () => {
    // #484: a documented CLI command that ENOENTed for every consumer because
    // `files[]` omitted the directory it read from. The script resolves its
    // template relative to its own location, so a copy with no `templates/`
    // sibling reproduces exactly what a consumer with a bad `files[]` sees.
    const fakePkg = join(scratch, `fakepkg${seq++}`);
    mkdirSync(join(fakePkg, "scripts"), { recursive: true });
    writeFileSync(
      join(fakePkg, "scripts", "create-success.ts"),
      readFileSync(CREATE_SUCCESS, "utf-8"),
    );
    const root = project({});
    const r = spawnSync("bun", [join(fakePkg, "scripts", "create-success.ts"), "--project-root", root], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr, "the failure does not name the missing file").toContain(
      "templates/SUCCESS-TEMPLATE.md",
    );
    expect(existsSync(join(root, "SUCCESS.md")), "a failed run left a partial file").toBe(false);
  });
});
