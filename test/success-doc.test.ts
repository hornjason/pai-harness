/**
 * `SUCCESS.md` is seeded, and a half-written one is REFUSED (#485).
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
 * A generator alone makes it worse. A half-written template is
 * indistinguishable from a considered one to everything except a reader —
 * the same argument `.claude/rules/checks-must-be-able-to-fail.md` makes
 * about guards, applied to a document. A check that only asks whether the
 * file exists waves through every project that ran `create-success` and
 * stopped.
 *
 * Where this departs from #485, on the record: the UNTOUCHED seed reports
 * UNMEASURED rather than FAIL, because it carries exactly as much
 * information as no file at all and the scaffold now plants it whether the
 * project asked or not. A finding is still recorded, so it is never clean.
 * The refusal lands one state on — see `case 2` and `case 2b`.
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { PLACEHOLDER_MARKER, UNREADABLE, parseSuccessDoc, readSuccessDoc, successViolations, templateResidue } from "../lib/success-doc";
import { extractTestFailureCount } from "../gates/gate-executor";
import { seedSuccessDoc } from "../lib/scaffold/steps";

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

  test("case 2: the generator's output UNMODIFIED is UNMEASURED, never clean", () => {
    // #485 asks for a refusal here, and this reports UNMEASURED instead.
    // **A deliberate deviation, so the reasoning is on the record.**
    //
    // What the issue is protecting against is an unfilled template passing
    // as a considered one — "the case a naive file-exists check misses". A
    // naive check reports CLEAN. This reports UNMEASURED and records a
    // finding, so the defect the issue names is still caught; what differs
    // is only whether CI goes red.
    //
    // And UNMEASURED is the honest answer. A pristine seed carries exactly
    // as much information about the project as no file at all, which is the
    // state `null` already reports as unmeasured — `.claude/rules/
    // config-access.md`: "0, {}, null and SKIP are indistinguishable from
    // success; UNMEASURED is not."
    //
    // The practical half: the scaffold seeds this file whether the project
    // asked or not, so a FAIL here turns an existing consumer's suite red on
    // a re-scaffold they ran for an unrelated reason, with no way back —
    // deleting the file is undone by the next run. It would also be a new
    // check shipping straight to FAIL, which the WARN-then-data-then-FAIL
    // ladder in the harness automation matrix spec (rule 9) says not to do.
    //
    // That spec is named in words rather than by filename ON PURPOSE. The
    // filename alone would make DRIFT-2 count this file as a test covering
    // it — `allContent.includes(name)` is a substring match — and this
    // comment tests nothing about that spec. Citing is not covering; see
    // `.claude/rules/claiming-sc-coverage.md`, which records the same trap
    // catching itself three times.
    //
    // The refusal is aimed one state further on, at a document somebody
    // STARTED and left half-written. That is the one that reads as
    // considered and is not, and the next case is it.
    const r = runSuccess1(project({ "SUCCESS.md": readFileSync(TEMPLATE, "utf-8") }));
    expect(r.ran).toBeGreaterThan(0);
    expect(r.failures, "a pristine seed failed a project that never asked for it").toBe(0);
    expect(r.findings.length, "a pristine seed passed silently, which is the actual defect")
      .toBe(1);
    expect(r.findings[0]!.message).toContain("UNMEASURED");
  });

  test("case 2b: ONE edit to the seed turns it into a refusal", () => {
    // The boundary, and the case that carries #485's intent. A document
    // somebody started and abandoned is indistinguishable from a considered
    // one to everything except a reader, and it is the state the issue was
    // filed about. Any edit at all moves the document out of "untouched
    // seed" and into "half-written", where every surviving placeholder
    // becomes a violation.
    const seed = readFileSync(TEMPLATE, "utf-8");
    const touched = seed.replace("### Claim 1 — TODO", "### Claim 1 — the thing works");
    expect(touched, "the fixture did not actually change anything").not.toBe(seed);
    const r = runSuccess1(project({ "SUCCESS.md": touched }));
    expect(r.failures, "a half-written SUCCESS.md was accepted").toBe(1);
    expect(r.findings.length, "the refusal did not say what was wrong").toBeGreaterThan(1);
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
    const numberedDoc = FILLED
      .replace(
        "### Claim 1 — a spec with no testable criteria is rejected, not silently skipped",
        "1. **a spec with no testable criteria is rejected, not silently skipped**",
      )
      .replace(/\*\*How it fails:\*\*/, "   Check:");
    const numbered = successViolations(numberedDoc);
    expect(numbered.violations, numbered.violations.join("\n")).toEqual([]);
    // Compare the PARSED STRUCTURES, not two violation lists. Both lists are
    // empty here, so `toEqual` between them held vacuously — the third shape
    // in `.claude/rules/checks-must-be-able-to-fail.md`, in a test whose own
    // name claims to distinguish the two forms. A change that made the
    // numbered form parse into something different but also clean would have
    // left it green.
    const h = parseSuccessDoc(FILLED).claims;
    const n = parseSuccessDoc(numberedDoc).claims;
    expect(n, "the two claim forms do not parse to the same structure").toEqual(h);
    expect(h.length, "the comparison above is over an empty list").toBeGreaterThan(0);
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
    mkdirSync(join(fakePkg, "lib"), { recursive: true });
    writeFileSync(
      join(fakePkg, "scripts", "create-success.ts"),
      readFileSync(CREATE_SUCCESS, "utf-8"),
    );
    // The script imports `../lib/success-doc`, so the fake package needs a
    // resolvable one or it dies on module resolution — which exits non-zero
    // and reads exactly like the refusal under test. Re-exported from the
    // real module rather than stubbed, so this cannot pass by accident if
    // the import list grows.
    writeFileSync(
      join(fakePkg, "lib", "success-doc.ts"),
      `export * from ${JSON.stringify(join(ROOT, "lib", "success-doc.ts"))};\n`,
    );
    const root = project({});
    const r = spawnSync("bun", [join(fakePkg, "scripts", "create-success.ts"), "--project-root", root], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr, "the script died on module resolution, not on the missing template")
      .not.toContain("Cannot find module");
    expect(r.stderr, "the failure does not name the missing file").toContain(
      "templates/SUCCESS-TEMPLATE.md",
    );
    expect(existsSync(join(root, "SUCCESS.md")), "a failed run left a partial file").toBe(false);
  });
});

/**
 * What the security review of this PR found, and what it cost (#502 review).
 *
 * Both findings are the same mistake in different places: a guard that was
 * narrower than the thing it guards.
 */
describe("#502 review: the marker check and the writers were both too narrow", () => {
  const run = (args: string[]) =>
    spawnSync("bun", [CREATE_SUCCESS, ...args], { cwd: ROOT, encoding: "utf-8" });

  test("F1: deleting the markers is not the same as filling the document in", () => {
    // The review found this by reading what `create-success` PRINTS: "Replace
    // every line marked `rungate:placeholder`". A user who does exactly that,
    // names the claims, writes a How-it-fails for each and stops, left SEVEN
    // TODOs and scored ZERO violations — `## The thing` still the template's
    // instruction text, every measurement line still TODO, owner and date
    // still TODO-OWNER and TODO-DATE. One `grep -v` cleared the whole guard,
    // and our own output told the user to run it.
    const template = readFileSync(TEMPLATE, "utf-8");
    let doc = template.split("\n").filter(l => !l.includes(PLACEHOLDER_MARKER)).join("\n");
    doc = doc.replace(/### Claim (\d) — TODO/g, "### Claim $1 — the thing works");
    doc = doc.replace(/\*\*How it fails:\*\* TODO[^\n]*\n[^\n]*\n/g, "**How it fails:** it returns the wrong answer.\n");
    doc = doc.replace(/\*\*How it fails:\*\* TODO/g, "**How it fails:** it returns the wrong answer.");

    expect(doc, "the fixture no longer reproduces the finding").not.toContain(PLACEHOLDER_MARKER);
    expect(doc.match(/TODO/g)?.length, "the fixture should still be substantively unfilled")
      .toBeGreaterThan(0);

    const v = successViolations(doc, template);
    expect(v.violations.length, "a document that is still mostly the template passed")
      .toBeGreaterThan(0);
    expect(v.violations.join("\n")).toContain("verbatim from the generator's template");
  });

  test("F1: the residue check does NOT fire on the one real document", () => {
    // The control, and the reason the check excludes structural lines. A
    // document legitimately shares headings, table rows and frontmatter keys
    // with the template; rungate's own SUCCESS.md shares exactly two lines,
    // `doc-type: reference` and `status: active`, both frontmatter.
    const template = readFileSync(TEMPLATE, "utf-8");
    const real = readFileSync(join(ROOT, "SUCCESS.md"), "utf-8");
    expect(templateResidue(real, template), "the real document was called unwritten").toEqual([]);
    expect(successViolations(real, template).violations).toEqual([]);
  });

  test("F2: --force does not write through a symlink to a file outside the project", () => {
    // The worst outcome in the diff, and it needed no --force bypass: the
    // refusal used `existsSync`, which RESOLVES a symlink, while
    // `writeFileSync` FOLLOWS one. Measured before the fix: a 26-byte
    // hand-written note outside the project was replaced with 2,007 bytes of
    // template, exit 0.
    const outside = mkdtempSync(join(tmpdir(), "rungate-victim-"));
    const victim = join(outside, "notes.md");
    writeFileSync(victim, "hand-written, do not clobber\n");
    const root = project({});
    symlinkSync(victim, join(root, "SUCCESS.md"));

    expect(run(["--project-root", root, "--force"]).status).toBe(0);
    expect(readFileSync(victim, "utf-8"), "a file outside the project was destroyed")
      .toBe("hand-written, do not clobber\n");
    expect(lstatSync(join(root, "SUCCESS.md")).isSymbolicLink(), "the symlink survived the write")
      .toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  test("F2: a DANGLING symlink is 'already exists', not 'absent'", () => {
    // The input the two functions disagreed about. `existsSync` says absent
    // because the target is gone; `writeFileSync` creates the target.
    const outside = mkdtempSync(join(tmpdir(), "rungate-victim-"));
    const root = project({});
    symlinkSync(join(outside, "absent.md"), join(root, "SUCCESS.md"));

    const r = run(["--project-root", root]);
    expect(r.status, "a dangling symlink was treated as an absent file").toBe(1);
    expect(existsSync(join(outside, "absent.md")), "the write escaped the project").toBe(false);
    // The MESSAGE is asserted, not just the exit code, and that is what makes
    // this case distinguish `lstatSync` from the `wx` flag below it. Both
    // refuse this input — `O_EXCL` fails on a dangling symlink too — so with
    // only the exit code asserted, reverting to `existsSync` was 0 red and
    // the presence check was dead code nothing could see. With `existsSync`
    // the user gets a raw EEXIST; with `lstatSync` they get the sentence that
    // tells them what to do.
    expect(r.stderr, "the refusal is the raw write error, not the guard's")
      .toContain("already exists");
    expect(r.stderr).toContain("--force");
    rmSync(outside, { recursive: true, force: true });
  });

  test("F2: the write is exclusive, which is the half a check cannot do", () => {
    // `lstatSync` then `writeFileSync` is a TOCTOU by construction: the path
    // can change between the two. `wx` is `O_CREAT|O_EXCL`, so the refusal
    // happens in the syscall and is atomic.
    //
    // This is a SOURCE assertion, deliberately, and it is weaker than the
    // rest of this file. The race needs the filesystem to change between two
    // adjacent statements, which this suite cannot schedule, so there is no
    // honest behavioural case for it — saying that plainly beats a test that
    // passes for an unrelated reason. What is asserted is that the exclusive
    // flag is still there and that nothing writes the file unguarded.
    const src = readFileSync(CREATE_SUCCESS, "utf-8");
    expect(src, "the exclusive write flag is gone").toContain('{ flag: "wx" }');
    expect(src.match(/writeFileSync\(/g) ?? [], "a second, unguarded write was added")
      .toHaveLength(1);
  });

  test("F2: the scaffold's owned-file writer refuses a symlink too", () => {
    // PRE-EXISTING and wider than this PR: `regenerateOwned` is the writer
    // for every owned file, so the same planted symlink made the scaffold
    // create `project-state.json`'s content outside the project root and
    // report CREATED. Asserted through SUCCESS.md because that is this PR's
    // file, but the fix is in the shared writer.
    const outside = mkdtempSync(join(tmpdir(), "rungate-victim-"));
    const root = project({});
    symlinkSync(join(outside, "escaped.md"), join(root, "SUCCESS.md"));

    const actions: string[] = [];
    seedSuccessDoc(root, actions);
    expect(actions.join("\n"), "the writer followed the symlink").toContain("is a symlink");
    expect(existsSync(join(outside, "escaped.md")), "the scaffold wrote outside the project")
      .toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});

/**
 * The rest of the security review of this PR (#502 review, §3 and §5-§9).
 *
 * Each refusal gets its OWN fixture. Hanging three new rules off one existing
 * document would be three deciders and one input — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and the review said so
 * before I wrote them.
 */
describe("#502 review: the rest", () => {
  const claim = (v: string) =>
    `### Claim 1 — ${v}\n**How it fails:** ${v}\n\n| Claim | Standing |\n|---|---|\n| 1 | untested |\n`;

  test("§5: `UNFILLED` recognised only UPPERCASE TODO", () => {
    // A detector narrower than what it detects, where the narrowing was a
    // `[A-Z]`. Every one of these scored zero violations as BOTH the claim
    // statement and its How-it-fails.
    for (const v of ["todo", "TBD", "FIXME", "???", "xxx", "N/A", "tbd later", "."]) {
      expect(successViolations(claim(v)).violations.length, `"${v}" passed as a real claim`)
        .toBeGreaterThan(0);
    }
  });

  test("§5: the WORD list, on an input only it reaches", () => {
    // Every fixture in the case above is under ten characters, so the length
    // floor caught them all and narrowing the word list back to uppercase
    // `TODO` was 0 red — two deciders agreeing, with the floor holding the
    // word list up. This placeholder is long enough to clear the floor, so
    // only the word list can refuse it.
    // Lowercase and a different word, deliberately: an uppercase `TODO` of
    // any length is caught by the OLD regex too, so a fixture using one
    // would measure nothing. This is reachable only by the widened list.
    const long = "tbd — write the real claim here once we have decided what it is";
    expect(long.length, "the fixture is short enough for the floor to catch").toBeGreaterThan(20);
    expect(successViolations(claim(long)).violations.length, "a long lowercase placeholder passed")
      .toBeGreaterThan(0);
  });

  test("§5: the LENGTH floor, on an input only it reaches", () => {
    // And the floor's own: a short statement that is not a placeholder word.
    // "fast" is not in any list and never will be; it is also not a
    // falsifiable claim.
    expect(successViolations(claim("fast")).violations.length, "a four-letter claim passed")
      .toBeGreaterThan(0);
  });

  test("§5: the control — a real claim of ordinary length passes", () => {
    // The length floor is the half most likely to over-refuse, so the
    // boundary is asserted rather than assumed.
    expect(successViolations(claim("the parser rejects an empty spec")).violations).toEqual([]);
  });

  test("§6: a falsifiability line cannot be borrowed from a later section", () => {
    // The scan had no section awareness, so the first `Check:` ANYWHERE
    // below a claim satisfied it — here one six lines down under a different
    // heading.
    const doc = [
      "### Claim 1 — we are the fastest renderer available",
      "",
      "## Appendix",
      "",
      "Check: the dashboard, probably.",
      "",
      "| Claim | Standing |", "|---|---|", "| 1 | untested |",
    ].join("\n");
    const v = successViolations(doc);
    expect(v.violations.join("\n"), "a Check: under another heading was borrowed")
      .toContain("How it fails");
  });

  test("§6: a fenced example does not hand out falsifiability lines", () => {
    // The sharper half: a SUCCESS.md that documents its own format gave
    // every claim below the example a free pass.
    const doc = [
      "### Claim 1 — we are the fastest renderer available",
      "",
      "```markdown",
      "**How it fails:** this is an EXAMPLE of the format, not a claim.",
      "```",
      "",
      "| Claim | Standing |", "|---|---|", "| 1 | untested |",
    ].join("\n");
    expect(successViolations(doc).violations.join("\n"), "a fenced example satisfied a claim")
      .toContain("How it fails");
  });

  test("§7: a directory at SUCCESS.md refuses instead of throwing", () => {
    // `existsSync` is true for a directory and `readFileSync` then throws
    // EISDIR. The throw escaped the scaffold step and aborted the whole run
    // mid-way, after some files were written and before others — a worse
    // outcome than any verdict. UNREADABLE is distinct from absent: "it is
    // there and I could not read it" refuses; "there is no file" is
    // unmeasured.
    const root = project({});
    mkdirSync(join(root, "SUCCESS.md"), { recursive: true });
    expect(readSuccessDoc(root), "a directory read as an absent file").toBe(UNREADABLE);
    const v = successViolations(readSuccessDoc(root));
    expect(v.violations.length, "an unreadable SUCCESS.md passed").toBe(1);
    expect(v.unmeasured, "unreadable was collapsed into unmeasured").toBeNull();

    const actions: string[] = [];
    expect(() => seedSuccessDoc(root, actions), "the scaffold run aborted").not.toThrow();
    expect(actions.join("\n")).toContain("not a regular file");
  });

  test("§7: the non-file check is there, and why a behavioural case cannot prove it", () => {
    // Removing `isFile()` is 0 red, and that is honest rather than a gap in
    // the fixtures: for a DIRECTORY the `readFileSync` below it throws
    // EISDIR and the catch returns the same UNREADABLE, so the two are
    // behaviourally one decider on every input this suite can build.
    //
    // They are not redundant. `readFileSync` on a FIFO BLOCKS waiting for a
    // writer rather than throwing, so the catch never runs and the scaffold
    // hangs instead of refusing — and a test that hangs is a test that
    // cannot report. Scheduling that reliably is not something this suite
    // can do, so the check is asserted in the source and the limitation is
    // written down rather than papered over with a case that passes for an
    // unrelated reason.
    const src = readFileSync(join(ROOT, "lib", "success-doc.ts"), "utf-8");
    expect(src, "the non-file guard is gone; a FIFO would block the read")
      .toContain("if (!stat.isFile()) return UNREADABLE;");
  });

  test("§3: the two seed writers produce the same bytes", () => {
    // `create-success` substituted owner and date; the scaffold wrote the
    // template raw, so a scaffolded SUCCESS.md kept `owner: TODO-OWNER`
    // forever and nothing checked frontmatter. One substitution, two
    // callers — asserted by running BOTH rather than by reading the code.
    const viaScaffold = project({});
    seedSuccessDoc(viaScaffold, []);
    const scaffolded = readFileSync(join(viaScaffold, "SUCCESS.md"), "utf-8");

    const viaCli = project({});
    const owner = process.env.USER || "TODO-OWNER";
    spawnSync("bun", [CREATE_SUCCESS, "--project-root", viaCli, "--owner", owner], { cwd: ROOT });
    const generated = readFileSync(join(viaCli, "SUCCESS.md"), "utf-8");

    expect(scaffolded, "the two writers disagree about the same seed").toBe(generated);
    expect(scaffolded, "the scaffold left the template's owner placeholder")
      .not.toContain("TODO-OWNER");
    expect(scaffolded).not.toContain("TODO-DATE");
  });

  test("§8: a flag is not accepted as a flag's value", () => {
    // `--project-root --force` returned "--force" and the script ENOENTed
    // with a raw stack on `--force/SUCCESS.md` — in a file whose own comment
    // says "Named rather than swallowed" about this exact class of failure.
    const r = spawnSync("bun", [CREATE_SUCCESS, "--project-root", "--force"], {
      cwd: ROOT, encoding: "utf-8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr, "the raw ENOENT stack is still the error").toContain("needs a value");
    expect(r.stderr).not.toContain("ENOENT");
  });

  test("§9: --owner cannot introduce YAML keys", () => {
    // Written verbatim into frontmatter, so a newline let it add a duplicate
    // `status` and an attacker-chosen `doc-type` to a file other tooling
    // parses.
    const root = project({});
    const r = spawnSync(
      "bun",
      [CREATE_SUCCESS, "--project-root", root, "--owner", "evil\nstatus: deprecated"],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(r.status, "a newline in --owner was accepted").toBe(1);
    expect(existsSync(join(root, "SUCCESS.md")), "a refused run still wrote the file").toBe(false);

    const colon = spawnSync("bun", [CREATE_SUCCESS, "--project-root", root, "--owner", "a: b"], {
      cwd: ROOT, encoding: "utf-8",
    });
    expect(colon.status, "a colon in --owner was accepted").toBe(1);
  });

  test("§9: an EMPTY USER does not produce a bare `owner:`", () => {
    // `??` guards null and undefined only, so `USER=""` — a container, a
    // cron job — wrote `owner:` with nothing after it.
    const root = project({});
    spawnSync("bun", [CREATE_SUCCESS, "--project-root", root], {
      cwd: ROOT, encoding: "utf-8", env: { ...process.env, USER: "" },
    });
    const body = readFileSync(join(root, "SUCCESS.md"), "utf-8");
    expect(body, "an empty USER left the owner key empty").not.toMatch(/^owner:\s*$/m);
    expect(body).toContain("owner: TODO-OWNER");
  });
});
