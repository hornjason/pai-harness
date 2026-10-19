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

import {
  PLACEHOLDER_MARKER,
  NO_RESIDUE_CHECK,
  TEMPLATE_MISSING,
  UNREADABLE,
  parseSuccessDoc,
  readSuccessDoc,
  readSuccessTemplate,
  successViolations,
  templateResidue,
} from "../lib/success-doc";
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
/**
 * The zone a spawned `create-success` runs in (#649).
 *
 * `bun test` resolves the in-process `Intl` default to **UTC**, while a
 * subprocess it spawns gets the machine zone. `TZ` is unset on both sides, so
 * nothing in the environment names the difference — measured here as
 * `UTC` in-process and `America/New_York` in the child, at the same instant.
 *
 * Any case comparing something written in-process against something written
 * by the spawned CLI therefore disagrees about the calendar day for every
 * hour where the two zones fall on different dates: about five a night in US
 * Eastern, eight in US Pacific, and none in UTC. That is why §3 was red on
 * developer machines every evening and green in CI forever.
 *
 * Neither writer was wrong — both call `localCalendarDay()`, which correctly
 * reads the ambient zone it is given. The test had introduced an environment
 * difference and then asserted the two sides agreed. So remove the
 * difference: the child is pinned to whatever zone the parent resolved, and
 * the byte comparison goes back to being about the bytes.
 */
const PARENT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CHILD_ENV = { ...process.env, TZ: PARENT_TIME_ZONE };

/**
 * Spawn `create-success`. ONE definition: three describes had declared their
 * own identical copy, and the fourth was about to. §3 then declared a fifth
 * anyway, which is how it acquired the zone bug this helper now closes — so
 * every spawn of the CLI in this file goes through here, and there is one
 * place for the environment to be decided.
 */
const run = (args: string[], cwd = ROOT) =>
  spawnSync("bun", [CREATE_SUCCESS, ...args], { cwd, encoding: "utf-8", env: CHILD_ENV });

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
    const v = successViolations(withMarker, NO_RESIDUE_CHECK);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]).toContain("placeholder");
    expect(v.violations[0], "the refusal does not say which line").toContain("line(s)");
  });

  test("a claim with no falsifiability line is refused", () => {
    const v = successViolations(FILLED.replace(/\*\*How it fails:\*\*[^\n]*\n[^\n]*\n/, ""), NO_RESIDUE_CHECK);
    expect(v.violations.join("\n")).toContain("How it fails");
    expect(v.violations.join("\n"), "a slogan is not a claim").toContain("slogan");
  });

  test("the standing table naming a claim nothing defines is refused", () => {
    const v = successViolations(FILLED.replace("| 1 | untested | — |", "| 1 | untested | — |\n| 2 | met | 2026-01-01 |"), NO_RESIDUE_CHECK);
    expect(v.violations.join("\n")).toContain("row for claim 2");
  });

  test("a claim with no standing row is refused — the direction that rots quietly", () => {
    // The inverse, and the one nobody notices: a claim added and never given
    // a row reads as met by omission.
    const v = successViolations(FILLED.replace(/\| 1 \| untested \| — \|\n/, ""), NO_RESIDUE_CHECK);
    expect(v.violations.join("\n")).toContain("claim 1 has no row");
    expect(v.violations.join("\n")).toContain("met by omission");
  });

  test("a complete document is clean", () => {
    expect(successViolations(FILLED, NO_RESIDUE_CHECK).violations).toEqual([]);
    expect(successViolations(FILLED, NO_RESIDUE_CHECK).unmeasured).toBeNull();
  });

  test("absent is UNMEASURED and carries no violations — the two are different answers", () => {
    const v = successViolations(null, NO_RESIDUE_CHECK);
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
    const v = successViolations(readFileSync(join(ROOT, "SUCCESS.md"), "utf-8"), NO_RESIDUE_CHECK);
    expect(v.violations, v.violations.join("\n")).toEqual([]);
    expect(v.unmeasured).toBeNull();
  });

  test("the template SHIPPED on disk is refused, read from the file the CLI copies", () => {
    // Not a fixture copy. If someone "fixes" the template by filling in its
    // placeholders, the generator starts handing every consumer a document
    // that passes while saying nothing, and this is what notices.
    const v = successViolations(readFileSync(TEMPLATE, "utf-8"), NO_RESIDUE_CHECK);
    expect(v.violations.length, "the shipped template is accepted as a real SUCCESS.md")
      .toBeGreaterThan(0);
    expect(v.violations.join("\n")).toContain("placeholder");
  });

  test("the numbered form and the heading form are read the same way", () => {
    const heading = successViolations(FILLED, NO_RESIDUE_CHECK);
    const numberedDoc = FILLED
      .replace(
        "### Claim 1 — a spec with no testable criteria is rejected, not silently skipped",
        "1. **a spec with no testable criteria is rejected, not silently skipped**",
      )
      .replace(/\*\*How it fails:\*\*/, "   Check:");
    const numbered = successViolations(numberedDoc, NO_RESIDUE_CHECK);
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
    expect(successViolations(text, NO_RESIDUE_CHECK).violations, "a prose row was refused as an unknown claim")
      .toEqual([]);
  });
});

// ── The generator ───────────────────────────────────────────────────────────

describe("SC-1710: `create-success` seeds the structure and refuses to overwrite", () => {
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
    const v = successViolations(readFileSync(join(root, "SUCCESS.md"), "utf-8"), NO_RESIDUE_CHECK);
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
    // The script imports from `../lib/`, so the fake package needs every one
    // of those resolvable or it dies on module resolution — which exits
    // non-zero and reads exactly like the refusal under test. Each is
    // re-exported from the real module rather than stubbed, and the list is
    // DERIVED from the source rather than written down, because a hardcoded
    // list goes red the day an import is added (#600 added one) and the
    // repair is then indistinguishable from fixing the thing under test.
    const libImports = [
      ...new Set(
        [...readFileSync(CREATE_SUCCESS, "utf-8").matchAll(/from\s+["']\.\.\/lib\/([\w./-]+)["']/g)].map(m => m[1]),
      ),
    ];
    expect(libImports.length, "the script no longer imports from ../lib — this stubbing is now vacuous")
      .toBeGreaterThan(0);
    for (const mod of libImports) {
      writeFileSync(
        join(fakePkg, "lib", `${mod.replace(/\.(ts|js)$/, "")}.ts`),
        `export * from ${JSON.stringify(join(ROOT, "lib", `${mod.replace(/\.(ts|js)$/, "")}.ts`))};\n`,
      );
    }
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
    expect(v.violations.join("\n")).toContain("passage(s) from the generator's template");
  });

  test("F1: the residue check does NOT fire on the one real document", () => {
    // The control, and the reason the check excludes structural lines. A
    // document legitimately shares headings, table rows and frontmatter keys
    // with the template. rungate's own SUCCESS.md shares exactly two lines
    // of RAW text with it, `doc-type: reference` and `status: active`, and
    // both are frontmatter — so `templateResidue` returns an empty list, not
    // those two. The distinction matters because the empty list is what this
    // asserts: sec-485 pointed out that describing the pre-filter overlap
    // reads as though two lines survive the filter.
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
    //
    // The flag and the call are asserted in ONE statement, not as two facts
    // about one file. sec-485 built the mutant that proves why: move the
    // literal into a comment and leave the write bare, and a file-level
    // `toContain` plus a `writeFileSync(` count both still pass over
    // `writeFileSync(target, body)`. That is #235's lesson verbatim — a
    // source-text assertion cannot notice it has stopped describing the code.
    const src = readFileSync(CREATE_SUCCESS, "utf-8");
    expect(src, "the exclusive flag is no longer on the write itself")
      .toMatch(/writeFileSync\(\s*target,\s*body,\s*\{\s*flag:\s*"wx"\s*\}\s*\)/);
    // Widened past `writeFileSync` because the stated job is "nothing writes
    // this file unguarded", and `appendFileSync`, `Bun.write` and
    // `createWriteStream` all write a file while leaving a
    // `writeFileSync`-only count at exactly 1.
    expect(
      src.match(/\b(?:writeFileSync|appendFileSync|createWriteStream|Bun\.write)\s*\(/g) ?? [],
      "a second, unguarded write was added",
    ).toHaveLength(1);
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
      expect(successViolations(claim(v), NO_RESIDUE_CHECK).violations.length, `"${v}" passed as a real claim`)
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
    expect(successViolations(claim(long), NO_RESIDUE_CHECK).violations.length, "a long lowercase placeholder passed")
      .toBeGreaterThan(0);
  });

  test("§5: the LENGTH floor, on an input only it reaches", () => {
    // And the floor's own: a short statement that is not a placeholder word.
    // "fast" is not in any list and never will be; it is also not a
    // falsifiable claim.
    expect(successViolations(claim("fast"), NO_RESIDUE_CHECK).violations.length, "a four-letter claim passed")
      .toBeGreaterThan(0);
  });

  test("§5: the control — a real claim of ordinary length passes", () => {
    // The length floor is the half most likely to over-refuse, so the
    // boundary is asserted rather than assumed.
    expect(successViolations(claim("the parser rejects an empty spec"), NO_RESIDUE_CHECK).violations).toEqual([]);
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
    const v = successViolations(doc, NO_RESIDUE_CHECK);
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
    expect(successViolations(doc, NO_RESIDUE_CHECK).violations.join("\n"), "a fenced example satisfied a claim")
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
    const v = successViolations(readSuccessDoc(root), NO_RESIDUE_CHECK);
    expect(v.violations.length, "an unreadable SUCCESS.md passed").toBe(1);
    expect(v.unmeasured, "unreadable was collapsed into unmeasured").toBeNull();

    const actions: string[] = [];
    expect(() => seedSuccessDoc(root, actions), "the scaffold run aborted").not.toThrow();
    expect(actions.join("\n")).toContain("not a regular file");
  });

  test("§7: a SYMLINKED SUCCESS.md is UNREADABLE — the input only `isFile()` reaches", () => {
    // This was a SOURCE assertion defending a claim that was false. The
    // comment said removing `isFile()` is 0 red and that this was "honest
    // rather than a gap in the fixtures", because a DIRECTORY throws EISDIR
    // into the catch below and both paths return UNREADABLE — "behaviourally
    // one decider on every input this suite can build".
    //
    // sec-485 built the input. `lstatSync` describes the LINK, so for a
    // symlink to a real file `isFile()` is false and the guard refuses;
    // without it `readFileSync` FOLLOWS the link and returns the target's
    // contents. Measured against a mutant with that one line removed:
    //
    //   directory            real=UNREADABLE  mutant=UNREADABLE   same
    //   symlink->real file   real=UNREADABLE  mutant=content(127b)  DIFFERS
    //   mode-000 file        real=UNREADABLE  mutant=UNREADABLE   same
    //
    // Three lines, deterministic, no scheduling. The reason I gave was true
    // of the two cases I measured and I then applied it to all cases, which
    // is `.claude/rules/checks-must-be-able-to-fail.md`'s #199/#479 section
    // committed inside a file that cites it.
    //
    // The FIFO sentence was a real second reason and is kept as a note: a
    // `readFileSync` on a FIFO BLOCKS rather than throwing, so the catch
    // never runs and the scaffold hangs instead of refusing. It just was not
    // doing the work the comment claimed, because a case existed all along.
    //
    // THE DECISION, stated rather than inherited: a symlinked SUCCESS.md is
    // UNREADABLE. It is consistent with `regenerateOwned` and with F2
    // refusing to write through a link, but consistency is not the same as
    // having decided, and nobody had. The refusal text now names symlinks,
    // because a consumer who links SUCCESS.md into a shared docs folder was
    // being told it "may be a directory, a device, or have permissions that
    // deny reading" — three things that are all false for their input.
    const outside = mkdtempSync(join(tmpdir(), "rungate-linktarget-"));
    const target = join(outside, "real.md");
    writeFileSync(
      target,
      "### Claim 1 — a real claim that is long enough\n"
        + "**How it fails:** it returns the wrong answer for empty input.\n"
        + "| 1 | untested |\n",
    );
    const root = project({});
    symlinkSync(target, join(root, "SUCCESS.md"));

    expect(readSuccessDoc(root), "the link was followed instead of refused").toBe(UNREADABLE);
    const v = successViolations(readSuccessDoc(root), readSuccessTemplate());
    // The specific clause, not the bare word: the message says "symlink"
    // twice, so `toContain("symlink")` could not tell the enumeration of
    // causes from the sentence explaining the policy, and dropping the first
    // was 0 red. Small instance of the same shape as everything else here.
    expect(v.violations.join("\n"), "the refusal no longer lists a symlink as a cause")
      .toContain("may be a symlink");
    expect(v.unmeasured, "an unreadable document was reported as unmeasured").toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  /**
   * sec-485's fixture, verbatim and DERIVED rather than hand-written.
   *
   * A plausible NEXT version of SUCCESS-TEMPLATE.md, used only as a residue
   * fixture — it is not the shipped template and is not meant to become one.
   * Everything the reader must replace is written as a heading, a table row,
   * or a line of twelve characters or fewer: the three classes `structural()`
   * used to exclude. Today's template happens to put its placeholder prose in
   * long body paragraphs, which is the ONLY reason the check saw it at all.
   *
   * Against the tree before the narrowing this scored 1 pass / 3 fail.
   */
  const NEXT_TEMPLATE = `---
doc-type: reference
status: active
owner: TODO-OWNER
updated: TODO-DATE
---

# What we are building, and how we will know it worked

## The thing

Describe it.

## Risks

List them.

### Claim 1 — the system behaves correctly under load

**How it fails:** TODO

### Claim 2 — the system recovers from a restart without data loss

**How it fails:** TODO

## Standing

| Claim | Standing | Measured |
|---|---|---|
| 1 | untested | — |
| 2 | untested | — |
`;

  // The attack, DERIVED from the template rather than hand-written: the
  // reader does the one thing the generator asks — a `How it fails` per
  // claim — and changes nothing else. The two `.replace()` calls are the
  // discipline: the fixture cannot drift away from the template, because it
  // IS the template with two substitutions. Inlining it as a literal for
  // readability would turn it into an attack on a string that once
  // resembled the template.
  const ABANDONED = NEXT_TEMPLATE
    .replace("**How it fails:** TODO", "**How it fails:** p99 latency exceeds 2s at 500 rps.")
    .replace("**How it fails:** TODO", "**How it fails:** a restart drops uncommitted writes.");

  test("Q1 fixture self-guard: it is still a real attack", () => {
    // Not padding. The thing that defeats this kind of fixture is not a
    // wrong assertion, it is a later edit that accidentally fills the
    // placeholders in — at which point the three cases below go green over
    // a check that never improved. I produced that exact failure earlier in
    // this issue from the other direction, with a mutation fixture the old
    // code already caught.
    expect(ABANDONED, "the fixture filled in the section bodies").toContain("Describe it.");
    expect(ABANDONED, "the fixture filled in the section bodies").toContain("List them.");
    expect(ABANDONED, "the fixture rewrote the claim statements")
      .toContain("### Claim 1 — the system behaves correctly under load");
    expect(ABANDONED, "the fixture substituted the frontmatter").toContain("owner: TODO-OWNER");
    expect(ABANDONED, "the fixture left a How-it-fails unwritten")
      .not.toContain("**How it fails:** TODO");
  });

  test("Q1: a claim statement left at the template's wording is residue", () => {
    expect(
      templateResidue(ABANDONED, NEXT_TEMPLATE).join("\n"),
      "a claim heading the reader never wrote was invisible",
    ).toContain("the system behaves correctly under load");
  });

  test("Q1: a section body of twelve characters or fewer is residue", () => {
    // `Describe it.` is exactly 12 characters and `List them.` is 10, so
    // the old `length <= 12` floor hid both no matter what the heading rule
    // did. sec-485 flagged that option 1 alone would leave this case red;
    // both exclusions were narrowed.
    const residue = templateResidue(ABANDONED, NEXT_TEMPLATE);
    expect(residue, "a short template body line was invisible").toContain("Describe it.");
    expect(residue, "a short template body line was invisible").toContain("List them.");
  });

  test("Q1: the document as a whole is refused", () => {
    const v = successViolations(ABANDONED, NEXT_TEMPLATE);
    expect(v.violations.length, "a document that is still mostly the template passed")
      .toBeGreaterThan(0);
    expect(v.unmeasured, "an edited seed was waved through as pristine").toBeNull();
  });

  test("Q1 control: the narrowing did not start refusing the real document", () => {
    // The direction this must not drift in. Narrowing an exclusion is the
    // change most likely to produce false refusals, and rungate's own
    // SUCCESS.md — written four months before the template and the only
    // real instance of the genre — is the case that would notice.
    const template = readFileSync(TEMPLATE, "utf-8");
    const real = readFileSync(join(ROOT, "SUCCESS.md"), "utf-8");
    expect(templateResidue(real, template), "the real document became residue").toEqual([]);
    expect(successViolations(real, template).violations).toEqual([]);
  });

  /**
   * R1 — the narrowing must not be keyed to one separator spelling (#485,
   * sec-500 F-1).
   *
   * The fixtures are DERIVED from `NEXT_TEMPLATE` by respelling its claim
   * headings, for the same reason `ABANDONED` is derived: a hand-written
   * copy would stop being the template the moment either one is edited, and
   * the case would pass over a fixture that no longer resembles anything.
   *
   * Measured before the widening: `—` and `-` CAUGHT, `:` and `SC 1 —`
   * INVISIBLE. A heading that misses the pattern falls through to
   * `startsWith("#")` and is excluded as structural, so the statement goes
   * back to being permanently invisible — which is sec-485's finding
   * surviving for every spelling but the one today's template happens to use.
   */
  const RESPELLINGS: ReadonlyArray<readonly [string, (s: string) => string]> = [
    ["em-dash (today's template)", s => s],
    ["hyphen", s => s.replaceAll("— the system", "- the system")],
    ["colon", s => s.replaceAll(" — the system", ": the system")],
    ["a noun other than Claim", s => s.replaceAll("### Claim ", "### SC ")],
  ];

  for (const [spelling, respell] of RESPELLINGS) {
    test(`R1: a claim statement is residue however the heading spells its separator — ${spelling}`, () => {
      const template = respell(NEXT_TEMPLATE);
      const doc = respell(ABANDONED);
      // The self-guard the respelling needs: a `replaceAll` that matched
      // nothing would leave the em-dash fixture in place and the case would
      // pass for the original reason, testing the respelling of nothing.
      if (spelling !== "em-dash (today's template)") {
        expect(template, "the respelling matched nothing").not.toEqual(NEXT_TEMPLATE);
      }
      expect(
        templateResidue(doc, template).join("\n"),
        "a claim heading the reader never wrote was invisible",
      ).toContain("the system behaves correctly under load");
    });
  }

  test("R1 cost: a numbered NON-claim heading kept verbatim is now reported", () => {
    // Written down because it is the price of the widening, not because it
    // is desirable. `\w[\w ]*\d+` cannot tell `Claim 1 — <statement the
    // reader must write>` from `Phase 2 - <section title the reader must
    // keep>`, so a future template carrying the second gets a false
    // refusal. Measured cost on today's tree: zero — the shipped template
    // has no numbered heading but its claims, and a sweep of all 227
    // markdown files in the repo flags nothing the un-widened version did
    // not already flag. This case exists so that the next person to add one
    // finds out from a red test rather than from a consumer.
    const tpl = `## The thing\n\nA sentence.\n\n## Phase 2 - Rollout\n\nSomething.\n`;
    expect(
      templateResidue(tpl, tpl),
      "the widening stopped reporting a numbered non-claim heading",
    ).toContain("Rollout");
  });

  test("R1 control: the shipped template offers no one-word line to collide with", () => {
    // sec-500 F-2. Dropping the `length <= 12` floor was right and exposed
    // what it was hiding: a legitimate document whose prose happens to wrap
    // onto a single word the template also wraps onto is refused. The base
    // rate is real — 71 lines across the repo's 227 markdown files are one
    // lowercase word and a period — so the fix is to stop the template
    // offering the collision rather than to restore the floor.
    const oneWord = readFileSync(TEMPLATE, "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^[a-z][a-z-]*\.$/.test(l));
    expect(oneWord, "the template wraps onto a bare word that any document might also wrap onto")
      .toEqual([]);
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
    // Through `run`, so the child inherits the parent's zone (#649). A bare
    // spawnSync here is what made this case red for five hours a night.
    run(["--project-root", viaCli, "--owner", owner]);
    const generated = readFileSync(join(viaCli, "SUCCESS.md"), "utf-8");

    expect(scaffolded, "the two writers disagree about the same seed").toBe(generated);
    // The frontmatter is the part #502 added this case for, and the part a
    // date disagreement lands in. Assert it is actually being compared, so a
    // later "just exclude `updated:`" repair cannot quietly empty the claim.
    expect(scaffolded, "the seed carries no date, so the comparison cannot see one")
      .toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
    expect(scaffolded, "the scaffold left the template's owner placeholder")
      .not.toContain("TODO-OWNER");
    expect(scaffolded).not.toContain("TODO-DATE");
  });

  // ── #649: the case above must hold at every hour, not just the ones a
  // developer happens to run it in ────────────────────────────────────────
  //
  // Waiting until tomorrow evening is not a test. The variable is the gap
  // between the parent's zone and the child's, so these drive the parent's
  // zone directly and let the fix hold it fixed.

  const SEED_CASE = "§3: the two seed writers produce the same bytes";

  /** Run one named case of THIS file in a child with `TZ` forced. */
  function seedCaseUnder(tz: string): { ran: number; failed: number; out: string } {
    const r = spawnSync(
      "bun",
      ["test", join(ROOT, "test", "success-doc.test.ts"), "-t", SEED_CASE],
      { cwd: ROOT, encoding: "utf-8", env: { ...process.env, TZ: tz } },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // A `-t` that matches nothing reports zero failures, which is
    // indistinguishable from passing — and is also what a run that failed to
    // resolve its imports looks like. So read what actually RAN first, off
    // bun's own summary line rather than off per-test lines, which are not
    // printed in the default reporter.
    const ran = Number(out.match(/^Ran (\d+) tests? across/m)?.[1] ?? NaN);
    // The failure count comes from the harness's own parser, not a second
    // regex beside it — two readers of one number are behaviourally one, and
    // a mutation of either would leave the other holding the case up.
    const failed = extractTestFailureCount(out);
    return { ran, failed, out };
  }

  // Behind UTC, equal to UTC, and ahead of UTC. The first is the zone the
  // bug was found in; the third is the mirror case, where the LOCAL day is
  // ahead of the UTC one, and nothing had ever exercised it.
  for (const tz of ["America/New_York", "UTC", "Asia/Tokyo"]) {
    test(`§3 holds with the parent zone forced to ${tz} (#649)`, () => {
      const { ran, failed, out } = seedCaseUnder(tz);
      expect(ran, `no case matched "${SEED_CASE}" under ${tz} — the filter found nothing:\n${out}`)
        .toBe(1);
      expect(failed, `the seed comparison failed under ${tz}:\n${out}`).toBe(0);
    }, 60_000);
  }

  test("§3 would catch a real divergence — the comparison is not vacuous (#649)", () => {
    // The fix removes an environment difference. The risk is that it also
    // removes the case's ability to see a difference that matters, and the
    // cheapest wrong fix — dropping `updated:` from the comparison — would
    // do exactly that while turning every row above green.
    //
    // So plant a divergence of the shape the bug produced, and confirm a
    // byte comparison of these two documents still refuses it.
    const viaScaffold = project({});
    seedSuccessDoc(viaScaffold, []);
    const scaffolded = readFileSync(join(viaScaffold, "SUCCESS.md"), "utf-8");

    expect(scaffolded, "nothing to diverge — the seed has no date line")
      .toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);

    const divergent = scaffolded.replace(/^updated: .*$/m, "updated: 1999-12-31");
    expect(divergent, "the plant did not change anything").not.toBe(scaffolded);

    // What §3 does: a whole-document byte comparison. It must refuse this.
    expect(
      scaffolded === divergent,
      "a differing `updated:` is invisible to the comparison §3 makes",
    ).toBe(false);

    // What the cheapest wrong fix would do: drop `updated:` before
    // comparing, so the two documents become equal and the case goes green
    // over exactly the divergence it exists to catch. Asserting that the
    // wrong fix IS blind is what makes the row above load-bearing rather
    // than a restatement of "two different strings differ".
    const withoutDate = (s: string) => s.replace(/^updated: .*$/m, "");
    expect(
      withoutDate(scaffolded) === withoutDate(divergent),
      "excluding `updated:` was expected to hide this divergence; if it no longer " +
        "does, this case is no longer evidence about that repair",
    ).toBe(true);
  });

  test("§3 compares whole documents, and this is the only thing that can see otherwise (#649)", () => {
    // Measured, not assumed: with the environment pin removed AND `updated:`
    // excluded from §3's comparison, this file reported 75 pass / 0 fail.
    // Every behavioural case above — the three forced-zone rows included —
    // went green over the exact repair they exist to discourage, because
    // none of them observes what §3 actually compares. With this case
    // present that same mutation is 1 red.
    //
    // A source assertion is a poor instrument and it is the only one with
    // line of sight here, so it is scoped as narrowly as possible: one
    // comparison, in one named section, sliced out before being searched.
    const self = readFileSync(join(ROOT, "test", "success-doc.test.ts"), "utf-8");
    const sectionStart = self.indexOf('test("§3: the two seed writers produce the same bytes"');
    expect(sectionStart, "§3 has been renamed — this guard is now pointing at nothing")
      .toBeGreaterThan(-1);
    const section = self.slice(sectionStart, self.indexOf("\n  });", sectionStart));
    expect(section.length, "the §3 slice came back empty, which contains nothing and proves nothing")
      .toBeGreaterThan(0);

    expect(
      section,
      "§3 no longer compares the two documents whole — if `updated:` was excluded to " +
        "make a timezone failure go away, remove the environment difference instead (#649)",
    ).toContain(".toBe(generated)");
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

/**
 * Covers SC-1706, SC-1710 (HARNESS-STANDARD.md).
 *
 * sec-485's re-review of `ac4b8d54`. F1 and F2 were confirmed fixed; these
 * are the findings the FIX introduced or left behind.
 *
 * The one that mattered is N1, and it is worth stating plainly because the
 * shape is this repo's most common defect: the residue check — the half of
 * the validator that catches a document which deleted the placeholder
 * markers and kept the template's prose — was guarded by `if (template)`,
 * and `readSuccessTemplate()` returned `null` when the template was not
 * installed. Measured on sec-485's own fixture: **1 violation with the
 * template, 0 without, `unmeasured` still null in both.** An installation
 * missing `templates/` reverted to the pre-fix behaviour and reported clean.
 *
 * `templates/` is in `files[]` today, so this was latent. #484 is the reason
 * that is not a defence: `config/`, `templates/` and `specs/SPEC-TEMPLATE.md`
 * were ALL missing from `files[]` through a release cut whose entire purpose
 * was fixing `files[]`, and the first external consumer reported 21 pass over
 * a library that could not load its own registry.
 */
describe("#502 re-review (sec-485)", () => {
  /** sec-485's fixture: do exactly what `create-success` instructs, no more. */
  function followedTheInstructions(template: string): string {
    return template
      .split("\n")
      .filter(l => !l.includes(PLACEHOLDER_MARKER))
      .join("\n")
      .replace(/^### Claim (\d+) — TODO$/gm, "### Claim $1 — the scanner names every file it could not read")
      .replace(/^\*\*How it fails:\*\*.*$/gm, "**How it fails:** an unreadable file is counted as clean")
      .replace(/^owner: TODO-OWNER$/m, "owner: jhorn")
      .replace(/^updated: TODO-DATE$/m, "updated: 2026-10-16");
  }

  test("N1: an installation with no template REFUSES rather than reporting clean", () => {
    const template = readFileSync(TEMPLATE, "utf-8");
    const doc = followedTheInstructions(template);

    // The control. Without this the case below could pass over a document
    // that has nothing wrong with it, which is the vacuous shape.
    const withTemplate = successViolations(doc, template);
    expect(withTemplate.violations, "the fixture stopped being a residue case")
      .toHaveLength(1);
    expect(withTemplate.violations[0]).toContain("passage(s) from the generator's template");

    const absent = successViolations(doc, TEMPLATE_MISSING);
    expect(absent.violations, "a missing template silently switched the residue check off")
      .toHaveLength(1);
    expect(absent.violations[0], "the refusal does not say the check could not run")
      .toContain("not in this rungate installation");
  });

  test("N1: an explicit null is refused too, not just the sentinel", () => {
    // `readSuccessTemplate` cannot return null any more — its type forbids it.
    // This is the belt for that brace: if a future reader reintroduces a
    // nullable template, it refuses rather than reopening the fail-open.
    const template = readFileSync(TEMPLATE, "utf-8");
    const doc = followedTheInstructions(template);
    expect(successViolations(doc, null).violations.length, "null reopened the hole")
      .toBeGreaterThan(0);
  });

  test("N1: an absent template does NOT make the parser's own unit cases refuse", () => {
    // The third state, and the reason this is not simply "template is
    // required". `undefined` means the caller is not asking for a residue
    // comparison — every parse-level case in this file passes one argument.
    // If `undefined` refused, those cases would all gain a violation and
    // their counts would stop meaning what they say.
    const good = [
      "### Claim 1 — the scanner names every file it could not read",
      "**How it fails:** an unreadable file is counted as clean",
      "",
      "| 1 | untested | — |",
    ].join("\n");
    expect(successViolations(good, NO_RESIDUE_CHECK).violations, "undefined started refusing").toEqual([]);
  });

  test("N1: readSuccessTemplate reports absence as the sentinel, never as falsy", () => {
    // Asserted on the live tree: the template IS installed here, so this
    // pins the happy path and the type does the rest. A `null` return would
    // be caught by the two cases above; this one catches a return that is
    // falsy in some other way.
    const t = readSuccessTemplate();
    expect(t, "the template is not installed in this tree").not.toBe(TEMPLATE_MISSING);
    expect(t.length, "readSuccessTemplate returned something empty").toBeGreaterThan(100);
  });

  test("N5: a directory at SUCCESS.md is refused in words, not a stack trace", () => {
    // `--force` reached `unlinkSync` on a directory and the user got a raw
    // throw out of create-success.ts. The exit code was right and nothing
    // else was.
    const root = project({});
    mkdirSync(join(root, "SUCCESS.md"));

    const r = run(["--project-root", root, "--force"]);
    expect(r.status, "a directory at SUCCESS.md was not refused").toBe(1);
    expect(r.stderr, "the refusal is a raw stack trace").toContain("not a regular file");
    expect(r.stderr, "the kind of thing in the way is not named").toContain("directory");
    expect(r.stderr, "an unhandled throw escaped").not.toContain("at /");
    expect(existsSync(join(root, "SUCCESS.md")), "the directory was removed").toBe(true);
  });

  test("N4: exactly one expression in lib/ resolves the SUCCESS template path", () => {
    // Three agreed, and nothing made them agree. `seedSuccessDoc` now calls
    // `readSuccessTemplate()`, which it already imported from.
    //
    // `scripts/create-success.ts` is deliberately NOT counted: it is a CLI
    // entry point that must name the missing file in its own words before it
    // can do anything, and it resolves from `PACKAGE_ROOT`, which it uses for
    // other things too. The invariant being asserted is about the library.
    const libFiles = ["lib/success-doc.ts", "lib/scaffold/steps.ts"];
    const resolvers = libFiles.flatMap(f =>
      (readFileSync(join(ROOT, f), "utf-8").match(/"SUCCESS-TEMPLATE\.md"/g) ?? []).map(() => f),
    );
    expect(resolvers, `more than one lib file resolves the template path: ${resolvers.join(", ")}`)
      .toHaveLength(1);
    expect(resolvers[0]).toBe("lib/success-doc.ts");
  });
});

/**
 * #515: a reflow of the template prose no longer defeats `templateResidue`.
 *
 * The check compared line against line, so it saw a copy-pasted paragraph
 * only while the line breaks were byte-identical. `prettier --prose-wrap`,
 * a different editor width, or one pass of an LLM rewriting the file moved
 * them without touching a word, and the whole paragraph went invisible —
 * the second shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * ## Two matchers, and why both stay
 *
 * The fix adds sentence matching over the whitespace-normalised document
 * and UNIONS it with the line matcher. That is two deciders, so the rule
 * requires each to have an input only it can reach, written down as named
 * cases saying which decider each one is for. These are those cases:
 *
 * | Input | Reaches |
 * |---|---|
 * | the paragraph reflowed onto one line | the SENTENCE matcher only |
 * | one word changed mid-sentence | the LINE matcher only |
 * | the paragraph verbatim | both |
 *
 * Without the second row the line matcher is dead code that every test
 * still passes over, and the next person to simplify it deletes it and
 * watches the suite stay green.
 */
describe("#515: the residue check survives a reflow, and still catches a partial edit", () => {
  const TEMPLATE_TEXT = readSuccessTemplate();

  /** The template's own first body paragraph, lifted verbatim. */
  const PARA = [
    "TODO — one sentence. Not a feature list and not a mission statement: the single",
    "thing that is true when this works, written so that someone could disagree with it.",
  ].join("\n");

  const doc = (body: string) => `---\ndoc-type: reference\n---\n\n# A title\n\n## The thing\n\n${body}\n`;

  test("R2: the paragraph REFLOWED onto one line is caught — the SENTENCE matcher's input", () => {
    // The defect, exactly. Not one word differs from the template; only
    // where the newline sits. This is the case the line matcher cannot see,
    // so it is the case that proves the sentence matcher is load-bearing.
    const reflowed = PARA.replace(/\n/g, " ");
    expect(reflowed, "the fixture changed a word, so it would not isolate the reflow")
      .toBe(PARA.replace(/\n/g, " "));
    expect(templateResidue(doc(reflowed), TEMPLATE_TEXT), "a reflowed template paragraph was invisible")
      .not.toEqual([]);
  });

  test("R2: one word changed mid-sentence is caught — the LINE matcher's input", () => {
    // The sentence matcher CANNOT see this: a sentence is the coarser unit,
    // so an edit anywhere inside one destroys the whole match. The second
    // line of the paragraph is untouched, and the line matcher is the only
    // thing left that can say so. Delete the line half and this goes green
    // over a document that is still 95% template.
    const edited = PARA.replace("single", "only");
    expect(edited, "the fixture did not actually change a word").not.toBe(PARA);
    expect(templateResidue(doc(edited), TEMPLATE_TEXT), "a one-word edit bought a clean document")
      .not.toEqual([]);
  });

  test("R2: the paragraph verbatim is caught, and the comment above it is irrelevant", () => {
    // Both matchers reach this one. The second half is the case that ruled
    // out #515's own proposal: the template puts `<!-- rungate:placeholder
    // -->` on the line directly above this prose with no blank line, so a
    // normalised BLOCK is the comment plus the prose, and a reader who
    // deletes the comment — which the comment tells them to do — stops
    // matching the block. Both spellings must be caught.
    expect(templateResidue(doc(PARA), TEMPLATE_TEXT), "the verbatim paragraph was invisible")
      .not.toEqual([]);
    expect(
      templateResidue(doc(`<!-- rungate:placeholder -->\n${PARA}`), TEMPLATE_TEXT),
      "the paragraph was only visible while the placeholder comment sat above it",
    ).not.toEqual([]);
  });

  test("R2: an HTML comment interleaved into the prose does not hide it", () => {
    // `stripHtmlComments`'s input, and it exists because the battery said
    // so. Making it a no-op was **0 red of 62** on the first pass — a
    // decider no case could distinguish, which is the fourth shape. The
    // sentence still matched through every other fixture, because the
    // comments the template carries sit above TODO placeholders that
    // `unfilled()` discards either way.
    //
    // This is the input only it reaches: a reader keeps a template sentence
    // and splits it with a comment. Without the strip the substring no
    // longer appears and the sentence goes invisible, which is the second
    // shape — a detector a reformat defeats — reintroduced one layer down.
    const sentence =
      "Not a feature list and not a mission statement: the single thing that is true "
      + "when this works, written so that someone could disagree with it.";
    const split = sentence.replace("and not a mission", "and <!-- reviewer: keep --> not a mission");
    expect(split, "the fixture does not actually interleave a comment").toContain("<!--");
    expect(templateResidue(doc(sentence), TEMPLATE_TEXT), "the control sentence was not residue")
      .not.toEqual([]);
    expect(templateResidue(doc(split), TEMPLATE_TEXT), "a comment in the middle hid template prose")
      .not.toEqual([]);
  });

  test("R2 cost: a genuinely hand-written document is still clean", () => {
    // The direction a widening goes wrong in. Without this, every case
    // above is satisfied by a check that refuses everything.
    const written = doc(
      "We ship a Claude Code plugin a colleague can install in one command, against "
      + "a dashboard running on their own machine, with no customer data in the repo.",
    );
    expect(templateResidue(written, TEMPLATE_TEXT), "a hand-written document was refused")
      .toEqual([]);
  });

  test("R2 cost: a single wrapped word stops being a comparable unit at all", () => {
    // The residual false-refusal surface #515 names, measured rather than
    // argued. `prevent.` is a whole LINE of the template's standing
    // paragraph, so as a line it is comparable and a document that happens
    // to wrap the same word alone collides with it. It is never a SENTENCE,
    // so the new matcher cannot reintroduce the collision — and `unfilled()`
    // is the floor that keeps the bare `TODO` a claim heading reduces to
    // from becoming a substring test against every document in the repo.
    const wrapped = doc("We refuse a release the gate could not\nprevent.");
    const hits = templateResidue(wrapped, TEMPLATE_TEXT);
    expect(hits, `a wrapped word was reported as template residue: ${hits.join(" | ")}`)
      .toEqual([]);
  });

  test("R2 control: every tracked markdown file in this repo, and only the template is refused", () => {
    // #515 asked for this sweep by name, because block/sentence comparison
    // is a WIDENING and widenings produce false refusals. 227 files of
    // hard-wrapped prose in the same voice as a SUCCESS.md is the largest
    // adversarial corpus available, and it costs one `git ls-files`.
    const files = spawnSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf-8" })
      .stdout.trim().split("\n").filter(Boolean);
    expect(files.length, "the sweep found no files, so it asserted nothing").toBeGreaterThan(200);
    const refused = files.filter(f => {
      const body = readFileSync(join(ROOT, f), "utf-8");
      return templateResidue(body, TEMPLATE_TEXT).length > 0;
    });
    expect(refused, `files newly refused as template residue: ${refused.join(", ")}`)
      .toEqual(["templates/SUCCESS-TEMPLATE.md"]);
  });

  /**
   * Seven bindings this PR shipped that no case could distinguish, and one
   * operational defect it introduced.
   *
   * Every row below was measured at **0 red of 63** by sec-515, each with a
   * named input on which the mutant and the original differ — so none of
   * them is the "code run twice" non-mutation this repo's rules warn about.
   * They are collected here rather than scattered because they share one
   * cause: the fixtures above were written from the template, and the
   * template exercises about half of what the code decides.
   *
   * The sharpest is the first. The PR is NAMED after surviving a reflow,
   * and the only reflow fixture it shipped collapses the paragraph onto a
   * single line — a degenerate case that the cheap wrong fix also passes.
   */
  describe("#525 review: the bindings nothing could distinguish", () => {
    test("a REAL re-wrap at a different width is caught — not just a collapse to one line", () => {
      // `collapseWhitespace` with `/\s+/` narrowed to `/[ \t]+/` is 0 red,
      // because R2's fixture joins the paragraph onto ONE line and there is
      // then no newline left to collapse. `[ \t]+` is exactly the repair a
      // reviewer reaches for — "`\s+` is overbroad" — and it reinstates the
      // bug #515 exists to fix while the suite stays green. The fifth
      // shape, against the headline claim of the PR that adds the rule.
      //
      // This is what `prettier --prose-wrap` actually produces: the same
      // words, three lines, different break positions.
      const rewrapped = [
        "TODO — one sentence. Not a feature list and not a",
        "mission statement: the single thing that is true when this works,",
        "written so that someone could disagree with it.",
      ].join("\n");
      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      expect(flat(rewrapped), "the fixture changed a word, so it is not a pure re-wrap")
        .toBe(flat(PARA));
      expect(rewrapped.split("\n").length, "a one-line fixture cannot witness newline collapsing")
        .toBe(3);
      expect(templateResidue(doc(rewrapped), TEMPLATE_TEXT), "a re-wrapped paragraph was invisible")
        .not.toEqual([]);
    });

    test("a mid-sentence FRAGMENT is not residue — the block split is not a per-line split", () => {
      // `.split(/\n[ \t]*\n/)` replaced by `.split(/\n/)` is 0 red. The
      // docstring argues hardest for this line and nothing held it: the
      // mutant does not lose the reflow case, it OVER-refuses, and there
      // was no fixture in the cost direction for a fragment longer than
      // the 10-character floor.
      //
      // 58 characters, wholly inside ONE template line and therefore a unit
      // under the mutant, but only half a sentence under the real split —
      // the template's sentence runs on to the next line.
      const fragment = "Not a feature list and not a mission statement: the single";
      expect(fragment.length, "a short fragment would be caught by unfilled() instead")
        .toBeGreaterThan(10);
      const line = TEMPLATE_TEXT.split("\n").find(l => l.includes(fragment));
      expect(line, "the fragment is not inside a single template line any more").toBeDefined();
      expect(line!.trim().endsWith(fragment), `the fragment must END its line, or it is a whole sentence: ${line}`)
        .toBe(true);
      const hits = templateResidue(doc(`Our house rule: ${fragment} report everyone reads.`), TEMPLATE_TEXT);
      expect(hits, `a mid-sentence fragment was refused as residue: ${hits.join(" | ")}`)
        .toEqual([]);
    });

    test("a sentence opening with a quotation mark is still a sentence", () => {
      // SENTENCE_BREAK's lookahead narrowed to `(?=[A-Z])` is 0 red. The
      // template opens a sentence with a double quote, and without the
      // wider lookahead it merges into the one before it — producing a unit
      // the document does not contain, so the real sentence goes invisible.
      const quoted = '"It doesn\'t work" is not an answer; name the input and the wrong output.';
      expect(TEMPLATE_TEXT, "the template no longer opens a sentence with a quote")
        .toContain(quoted);
      expect(templateResidue(doc(quoted), TEMPLATE_TEXT), "a quote-opening sentence was invisible")
        .not.toEqual([]);
    });

    test("a comment with no space around it still separates the words it sits between", () => {
      // Replacing the `" "` that a stripped comment becomes with `""` is 0
      // red, because R2's interleave fixture writes `and <!-- ... --> not`
      // — spaces on BOTH sides, so either replacement collapses to the same
      // string. The same shape as the mutation that fixture was added for,
      // one layer further down.
      const sentence =
        "Not a feature list and not a mission statement: the single thing that is true "
        + "when this works, written so that someone could disagree with it.";
      const glued = sentence.replace("so that someone", "so that<!--note-->someone");
      expect(glued, "the fixture left a space beside the comment, which cannot witness this")
        .toContain("that<!--note-->someone");
      expect(templateResidue(doc(glued), TEMPLATE_TEXT), "a tightly-glued comment hid template prose")
        .not.toEqual([]);
    });

    test("a claim heading contributes its statement, not the whole heading line", () => {
      // Replacing `claim[2].trim()` with the raw line is 0 red, and it is
      // equivalent to DELETING the branch: a claim heading then falls
      // through `structural`, which returns false for it, so it is pushed
      // unchanged either way. On today's template the branch is dead in the
      // positive direction — every claim heading reduces to `TODO`, which
      // `unfilled()` discards — so its only effect is to prevent a
      // widening, and nothing was measuring the widening.
      const withPrefix = doc("### Claim 1 — TODO list hygiene is enforced by the linter on every commit.");
      const hits = templateResidue(withPrefix, TEMPLATE_TEXT);
      expect(hits, `a hand-written claim was refused for its heading prefix: ${hits.join(" | ")}`)
        .toEqual([]);
    });

    test("a passage the template repeats is reported once", () => {
      // Removing any of the three `!out.includes(...)` guards is 0 red. The
      // template carries `**How it fails:** TODO` on two lines, so an
      // undeduped check reports a document holding it once as holding it
      // twice — a count the reader cannot reconcile with the document.
      const repeated = "**How it fails:** TODO";
      const occurrences = TEMPLATE_TEXT.split(repeated).length - 1;
      expect(occurrences, "the template no longer repeats this line, so this cannot witness dedup")
        .toBeGreaterThan(1);
      const hits = templateResidue(doc(repeated), TEMPLATE_TEXT);
      expect(hits.filter(h => h === repeated), "a repeated template line was reported twice")
        .toHaveLength(hits.filter(h => h === repeated).length > 0 ? 1 : 0);
      expect(new Set(hits).size, "the residue list contains duplicates").toBe(hits.length);
    });

    test("structural() is asked about whole lines, not about continuations of a sentence", () => {
      // The reflow guarantee, falsified. `structural` is a whole-line
      // classifier and was applied to every line inside a block, so a
      // paragraph that happens to wrap onto a line starting `word: ` had
      // that line dropped as frontmatter and the lines either side JOINED
      // across the hole — producing a sentence that exists nowhere and
      // losing one that does.
      //
      // Synthetic, because today's template has no such wrap. A latent
      // falsification of a documented guarantee is still a falsification,
      // and the next re-wrap of the template creates one for free.
      const template = [
        "# A template",
        "",
        "Name the one thing that is true when this works. Do not",
        "hedge: a hedged claim cannot fail, and a claim that cannot",
        "fail is not a claim.",
        "",
      ].join("\n");
      const bothSentences = [
        "Name the one thing that is true when this works.",
        "Do not hedge: a hedged claim cannot fail, and a claim that cannot fail is not a claim.",
      ];
      // The reader copy-pasted the whole paragraph, re-wrapped. BOTH
      // sentences are template prose and both must be reported.
      const copied = doc(bothSentences.join(" "));
      const hits = templateResidue(copied, template);
      for (const s of bothSentences) {
        expect(hits, `"${s.slice(0, 40)}…" was lost to a continuation line read as structural`)
          .toContain(s);
      }
      // And nothing fabricated: the hole used to splice lines 1 and 3 into
      // `Do not fail is not a claim.`, which appears in neither document.
      expect(hits.join("\n"), "a sentence that exists in neither document was synthesised")
        .not.toContain("Do not fail is not a claim.");
    });

    test("an unterminated HTML comment is linear, and does not swallow the rest of the document", () => {
      // `s.replace(/<!--[\s\S]*?-->/g, " ")` is O(N·L) on unterminated
      // openers: 800 KB took 61.77 s, and it runs on consumer documents.
      // The cheap fix — anchoring with `(?:-->|$)` — is also linear and is
      // NOT what shipped, because it makes one stray `<!--` swallow the
      // rest of the file, silently narrowing the check to buy the speed.
      const sentence =
        "Not a feature list and not a mission statement: the single thing that is true "
        + "when this works, written so that someone could disagree with it.";
      const hostile = `${"<!--".repeat(20_000)}\n\n${sentence}`;
      const started = Date.now();
      const hits = templateResidue(doc(hostile), TEMPLATE_TEXT);
      const elapsed = Date.now() - started;
      // The quadratic version takes ~600 ms on this input and grows 4x per
      // doubling; the scan is sub-millisecond. Two orders of magnitude of
      // headroom, so this is not a timing flake.
      expect(elapsed, `20k unterminated openers took ${elapsed}ms`).toBeLessThan(250);
      // And the prose AFTER the stray opener is still compared, which the
      // anchored-regex repair would have lost.
      expect(hits, "an unterminated comment swallowed the rest of the document")
        .not.toEqual([]);
    });
  });
});
