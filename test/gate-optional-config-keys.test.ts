/**
 * #315 — a gate check keyed to a config value nobody authors reads as
 * satisfied rather than as unmeasured.
 *
 * `code-committed` read `harness?.codeCommittedPaths || []` and returned
 * early on an empty list. Measured on main, no config authors that key —
 * not rungate's `.claude/rungate/config.json`, not its legacy
 * `.claude/rungate.json`, not DailyBriefDashboard's. So the check whose
 * entire job is confirming the shipped work is committed hit the early
 * return on every run this repository has ever made.
 *
 * This is the third instance of the class, after `dev.testCmd` vs
 * `test.command` (#294) and `container` being undeclared in the schema
 * (#307). Hence the registry below: the point is not to fix two call sites,
 * it is to make a fourth impossible to add without a reader noticing.
 *
 * ## What this file does, and what it deliberately does not
 *
 * It enumerates every `harness?.<key>` read in gates/workflow.test.ts and
 * requires each to carry a recorded reason — ratcheting both ways, so a key
 * that stops being read must be delisted and a new one cannot appear
 * unexplained. It drives `codeCommittedViolations` against real temp repos
 * with real uncommitted work, and mutates it.
 *
 * It does NOT assert that every check named in config/ceremony-profiles.json
 * has an implementation. That assertion was written and then measured before
 * being trusted: nine of the profile's 42 names have no matching test in
 * gates/workflow.test.ts, and some of those are real checks living elsewhere
 * (`spec-drift` is `runSpecDrift` in lib/conformity.ts). A guard that cannot
 * tell "implemented elsewhere" from "not implemented" would have to ship red
 * or ship with an eight-entry exemption list nobody can interpret. #339 is
 * for resolving the nine; this file stays within what it can measure.
 *
 * Covers SC-723, SC-724, SC-725, SC-726, SC-727, SC-728 of
 * GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { codeCommittedViolations } from "../gates/workflow.test";
import { stripJsComments } from "../lib/strip-js-comments";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW_TESTS = join(ROOT, "gates", "workflow.test.ts");

/**
 * Every optional `.claude/rungate.json` key a gate check reads, with what
 * happens when it is absent.
 *
 * "early-return" is the shape #315 is about and is not allowed to grow: a
 * check that silently passes because its scope is unset. Anything listed
 * that way needs a reason a reader can act on.
 */
const OPTIONAL_HARNESS_KEYS: Record<string, { absent: "early-return" | "derived-default"; why: string }> = {
  codeCommittedPaths: {
    absent: "derived-default",
    why: "#315. It used to be an on/off switch: `|| []` then `if (paths.length === 0) return;`, " +
      "and nothing authors it, so `code-committed` never ran. It is still READ — a configured " +
      "list narrows the scope — but absence now means the whole tree rather than no check.",
  },
  "dev.testCmd": {
    absent: "early-return",
    why: "tests-pass skips when the project declares no test command. A project with no " +
      "suite has nothing for this check to read, and refusing would block every " +
      "docs-only consumer. #307/#311 track the separate defect that the key is spelled " +
      "`dev.testCmd` here and `test.command` in the directory config.",
  },
  "dev.apiBase": {
    absent: "early-return",
    why: "local-api-validated only applies to a project that declares an API to validate.",
  },
  "dev.uiBase": {
    absent: "early-return",
    why: "local-ui-validated only applies to a project that declares a UI to validate.",
  },
  "prod.rebuild": {
    absent: "early-return",
    why: "the prod checks only apply to a project with a promotion step. DailyBriefDashboard " +
      "has one; rungate does not.",
  },
  "prod.smokeTest": {
    absent: "early-return",
    why: "prod-smoke only applies where a smoke test is declared.",
  },
  "container.port": {
    absent: "early-return",
    why: "#344. `quinn-container-port` used to compare Quinn's port against a literal 7776 — " +
      "one consumer's container port — so every other consumer got a warning naming a port " +
      "they do not run. It reads `container.port` now, and with none configured it says it " +
      "could not determine whether the container was tested rather than inventing a number " +
      "to disagree with. Early-return because a project with no container has no container " +
      "port to test on, and there is no honest default: a guessed port warns about the " +
      "wrong thing, which is the defect being removed.",
  },
  "prod.containerName": {
    absent: "early-return",
    why: "container-has-fix needs a container to inspect. It falls back to prod.imageName, " +
      "and the check is already gated on prod.rebuild above it, so a project with no " +
      "promotion step never reaches this read. Note that the check ALSO passes on four " +
      "distinct unmeasurable states once it is past this point — #341, deliberately not " +
      "fixed here because refusing would change behaviour on a live consumer.",
  },
  "prod.imageName": {
    absent: "early-return",
    why: "the fallback for prod.containerName — see that entry.",
  },
};

/**
 * The notation guards, declared once.
 *
 * Each is used by the assertion that enforces it AND by the planted control
 * that proves it can match. Two copies would let the enforcing one be
 * narrowed while the control kept passing against the old pattern — the
 * detector-differential shape, reintroduced inside the file that exists to
 * catch it.
 */
const PATTERNS = {
  // A global regex carries lastIndex between uses, and these are shared by an
  // assertion and its control. Built fresh at each call so one use cannot
  // leave the next one starting halfway through the file.
  bracketAccess: String.raw`\bharness\s*\??\.?\s*\[`,
  destructure: String.raw`(?:const|let|var)\s*\{[^}]*\}\s*=\s*harness\b`,
  unchained: String.raw`\bharness\.[A-Za-z0-9_$]+`,
  binding: String.raw`(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*loadProjectHarness\(\)`,
  keyRead: String.raw`harness\?\.([A-Za-z0-9_?.]+)`,
} as const;

const re = (k: keyof typeof PATTERNS) => new RegExp(PATTERNS[k], "g");


/**
 * Every binding `loadProjectHarness()`'s result is given in the gate suite.
 *
 * Security review raised this one: `harnessKeys` below matches
 * `harness?.<key>`, so a read written as `harness.codeCommittedPaths`, or
 * against a differently-named const, would be invisible to the registry — a
 * detector narrower than what it detects, which is shape two in
 * .claude/rules/checks-must-be-able-to-fail.md and the exact way a guard like
 * this gets bypassed without anybody meaning to.
 *
 * So the binding name is pinned first, and the key scan runs against a form
 * that is now the only one available.
 */
function harnessBindings(): string[] {
  const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
  return [...src.matchAll(re("binding"))]
    .map(m => m[1]);
}

function harnessKeys(): string[] {
  // Comments stripped first. The docblocks beside these call sites explain
  // the defect and quote `harness?.codeCommittedPaths` while doing it — a
  // detector reading raw source would report the very key its own
  // explanation says was removed.
  const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
  const found = new Set<string>();
  for (const m of src.matchAll(re("keyRead"))) {
    found.add(m[1].replace(/\?/g, ""));
  }
  return [...found].sort();
}

describe("#315: every optional config key a gate reads carries a recorded reason", () => {
  test("the detector sees something — it is not reporting an empty file", () => {
    // Positive control. A stripper that ate the whole file, or a regex that
    // stopped matching, would make every assertion below pass vacuously.
    expect(harnessKeys().length).toBeGreaterThan(2);
  });

  test("the harness value is always bound to `harness` — the detector's assumption, asserted", () => {
    // Without this, a call site writing `const cfg = loadProjectHarness()`
    // would read config keys the registry never sees.
    const bindings = harnessBindings();
    expect(bindings.length, "no loadProjectHarness() binding found at all").toBeGreaterThan(2);
    expect([...new Set(bindings)]).toEqual(["harness"]);
  });

  test("every read of it is optional-chained, so none escapes the key scan", () => {
    // `harness.foo` would be invisible to a scan for `harness?.foo`. It is
    // also a crash waiting to happen — loadProjectHarness returns null when
    // the project has no config file — so refusing it costs nothing.
    const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
    const unchained = [...src.matchAll(re("unchained"))].map(m => m[0]);
    expect(
      unchained,
      `gates/workflow.test.ts reads the harness config without optional chaining: ` +
        `${unchained.join(", ")}. The registry scan only sees \`harness?.<key>\`, so these ` +
        `keys would bypass it — and loadProjectHarness() returns null for a project with no ` +
        `config file, so they would also throw.`,
    ).toEqual([]);
  });

  test("no bracket or computed access escapes the scan", () => {
    // Third-round security review. `harness?.["codeCommittedPaths"]` passes
    // both assertions above — it IS optional-chained, and the binding IS
    // named `harness` — yet `harnessKeys` matches only dotted identifiers,
    // so the key would be invisible to the registry. A control that can be
    // bypassed by changing notation is not a control.
    const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
    const bracket = [...src.matchAll(re("bracketAccess"))].map(m => m[0]);
    expect(
      bracket,
      `the harness config is read with bracket notation: ${bracket.join(", ")}. The registry ` +
        `scan matches dotted identifiers only, so these keys bypass it. Use \`harness?.key\`.`,
    ).toEqual([]);
  });

  test("the harness value is not destructured — that would hide keys too", () => {
    // `const { prod } = harness ?? {}` reads config keys the scan cannot see,
    // and it is the obvious thing to write when a check needs three of them.
    const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
    const destructured = [...src.matchAll(re("destructure"))]
      .map(m => m[0]);
    expect(
      destructured,
      `the harness config is destructured: ${destructured.join(", ")}. Those keys are ` +
        `invisible to the registry scan.`,
    ).toEqual([]);
  });

  test("the notation guards can fail — planted control", () => {
    // All three guards above are absence claims against the real file and
    // pass trivially while it is well-behaved. The same regexes are run over
    // planted sources carrying exactly the bypasses they describe, so a green
    // run means "no bypass present", not "the regex stopped matching".
    expect('const x = harness?.["codeCommittedPaths"];'.match(re("bracketAccess"))).not.toBeNull();
    expect('const x = harness["codeCommittedPaths"];'.match(re("bracketAccess"))).not.toBeNull();
    expect("const { prod } = harness ?? {};".match(re("destructure"))).not.toBeNull();
    expect("const p = harness.prod;".match(re("unchained"))).not.toBeNull();
    expect([...'const cfg = loadProjectHarness();'.matchAll(re("binding"))][0]?.[1]).toBe("cfg");

    // And the well-behaved form is not caught by any of them.
    const ok = "const harness = loadProjectHarness();\n  if (!harness?.prod?.rebuild) return;";
    expect(ok.match(re("bracketAccess"))).toBeNull();
    expect(ok.match(re("destructure"))).toBeNull();
    expect(ok.match(re("unchained"))).toBeNull();
  });

  test("no unexplained key is read", () => {
    const unexplained = harnessKeys().filter(k => !(k in OPTIONAL_HARNESS_KEYS));
    expect(
      unexplained,
      `gates/workflow.test.ts reads optional config key(s) with no recorded reason: ` +
        `${unexplained.join(", ")}. An absent key must not silently satisfy a check — ` +
        `that is #315, #294 and #307 SC-A1, three times over. Add an entry saying what ` +
        `absence means, or give the check a derived default.`,
    ).toEqual([]);
  });

  test("the registry ratchets the other way too — a stale entry is refused", () => {
    // An allowlist that only grows becomes a list of things that used to be
    // true. The same rule the conformity allowlist got in #302.
    const read = new Set(harnessKeys());
    const stale = Object.keys(OPTIONAL_HARNESS_KEYS).filter(k => !read.has(k));
    expect(
      stale,
      `OPTIONAL_HARNESS_KEYS names key(s) nothing reads any more: ${stale.join(", ")}. ` +
        `Delist them rather than leave the registry describing a past version of the file.`,
    ).toEqual([]);
  });

  test("at least one key has a derived default, so the registry is not all early-returns", () => {
    // #315's SC-E2. An early-return is sometimes right — a project with no
    // UI has nothing for local-ui-validated to check. What is never right is
    // an early-return on a key that decides whether a check runs AT ALL, and
    // the only way to tell the two apart is to make the author say which
    // this is. A registry where every entry is "early-return" would mean
    // nobody had.
    const derived = Object.entries(OPTIONAL_HARNESS_KEYS)
      .filter(([, e]) => e.absent === "derived-default")
      .map(([k]) => k);
    expect(derived).toContain("codeCommittedPaths");
  });

  test("a configured path list is still honoured — removed as a switch, not as a feature", () => {
    // The opposite failure: deleting the key outright would silently drop a
    // narrowing a consumer may be relying on. It is read, just not to decide
    // whether the check runs.
    const src = stripJsComments(readFileSync(WORKFLOW_TESTS, "utf-8"));
    expect(src).toContain("codeCommittedPaths");
    expect(src, "the early return is back").not.toMatch(
      /codeCommittedPaths[\s\S]{0,120}?if \(paths\.length === 0\) return;/,
    );
  });

  test("every reason is actionable prose, not a placeholder", () => {
    for (const [key, entry] of Object.entries(OPTIONAL_HARNESS_KEYS)) {
      expect(entry.why.length, `${key}'s reason is too short to be a reason`).toBeGreaterThan(40);
      expect(["early-return", "derived-default"]).toContain(entry.absent);
    }
  });
});

// ── codeCommittedViolations, driven against real repos ────────────────────

let TMP = "";
function repo(name: string, opts: { dirty?: boolean; untracked?: boolean } = {}): string {
  if (!TMP) TMP = mkdtempSync(join(tmpdir(), "rungate-315-"));
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  initFixtureRepo(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  commitFixture(dir, "seed");
  if (opts.dirty) writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  if (opts.untracked) writeFileSync(join(dir, "src", "new.ts"), "export const b = 3;\n");
  return dir;
}

const status = (cwd: string, pathspec?: string[]) => {
  const args = ["status", "--porcelain", ...(pathspec?.length ? ["--", ...pathspec] : [])];
  try {
    return { ok: true, output: execFileSync("git", args, { cwd, encoding: "utf-8" }) };
  } catch (e: any) {
    return { ok: false, output: String(e?.stderr ?? e?.message ?? "") };
  }
};

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("#315: code-committed measures a real tree", () => {
  test("a clean tree produces no violations", () => {
    const v = codeCommittedViolations(status(repo("clean")), { configured: false, paths: [] });
    expect(v).toEqual([]);
  });

  test("a modified tracked file is caught with the default scope (SC-E1)", () => {
    // The case the check existed for and had never run against: no
    // `codeCommittedPaths` anywhere, and it still refuses.
    const dir = repo("modified", { dirty: true });
    const v = codeCommittedViolations(status(dir), { configured: false, paths: [] });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("uncommitted change");
    expect(v[0], "the refusal does not say which file").toContain("src/a.ts");
  });

  test("an untracked, non-ignored source file is uncommitted work too", () => {
    // `--porcelain` already honours .gitignore, so this is a file somebody
    // wrote and never added — exactly what the check is named for. Anything
    // that trips it and should not belongs in .gitignore.
    const dir = repo("untracked", { untracked: true });
    const v = codeCommittedViolations(status(dir), { configured: false, paths: [] });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("src/new.ts");
  });

  test("a gitignored artefact is not uncommitted work", () => {
    // The noise case. If this failed, the derived default would be unusable
    // and somebody would narrow it back to an unauthored config key.
    const dir = repo("ignored");
    writeFileSync(join(dir, ".gitignore"), "build/\n");
    commitFixture(dir, "ignore build");
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "out.js"), "// generated\n");
    expect(codeCommittedViolations(status(dir), { configured: false, paths: [] })).toEqual([]);
  });

  test("a configured path list narrows the scope rather than switching the check on", () => {
    const dir = repo("narrowed", { dirty: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "note.md"), "note\n");

    // Narrowed to docs/: the dirty src/a.ts is out of scope.
    const narrowed = codeCommittedViolations(status(dir, ["docs"]), {
      configured: true, paths: ["docs"],
    });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]).toContain("docs/");
    expect(narrowed[0], "the scope is not named in the refusal").toContain("within docs");
    expect(narrowed[0]).not.toContain("src/a.ts");

    // Unnarrowed: both.
    const wide = codeCommittedViolations(status(dir), { configured: false, paths: [] });
    expect(wide[0]).toContain("src/a.ts");
    expect(wide[0]).toContain("docs/");
  });

  test("an unreadable git status is UNMEASURED, not clean", () => {
    // Driven rather than asserted: a directory that is not a repo.
    const notARepo = join(TMP || mkdtempSync(join(tmpdir(), "rungate-315-")), "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const reading = status(notARepo);
    expect(reading.ok, "the fixture must actually fail").toBe(false);

    const v = codeCommittedViolations(reading, { configured: false, paths: [] });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("This is UNMEASURED, not PASS");
  });

  test("a long dirty list is truncated but its size is still reported", () => {
    // A refusal that pastes 400 paths gets skimmed; one that hides the count
    // gets underestimated. Both halves asserted.
    const many = Array.from({ length: 25 }, (_, i) => ` M src/f${i}.ts`).join("\n");
    const v = codeCommittedViolations({ ok: true, output: many }, { configured: false, paths: [] });
    expect(v[0]).toContain("25 uncommitted change");
    expect(v[0]).toContain("and 15 more");
  });
});
