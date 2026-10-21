/**
 * #903 — the Workflow sandbox's refusals that a NAME-shaped detector cannot see.
 *
 * #903 records that the sandbox constraint was priced three separate times in
 * one session and nobody had written down what it costs. The thing that makes
 * it cost every time is that the constraint lives in prose: `workflows/ship.js`,
 * `workflows/prove.js` and `lib/trajectory.ts` each carry a hand-written
 * comment saying the sandbox has no clock, and nothing mechanical enforced it.
 * A constraint maintained by comment is one every reader has to rediscover.
 *
 * THE GAP, MEASURED BEFORE IT WAS CLOSED. On `origin/main` at 78a94f63,
 * `scripts/validate-workflow.ts` validated this script —
 *
 *     const stamp = Date.now()
 *     const jitter = Math.random()
 *     const when = new Date()
 *
 * — with `✓ Sandbox globals: no unavailable globals referenced` and exit 0,
 * even though every one of those three statements throws in the sandbox. The
 * reason is structural rather than an omission from a list:
 * `FORBIDDEN_SANDBOX_GLOBALS` keys on a bare global NAME, and all three of
 * these are members of globals that really do exist. `Date` and `Math` are in
 * the validator's own `WORKFLOW_GLOBALS` allowlist, correctly. A name-shaped
 * detector has no way to express "this global is here but that member of it
 * is not" — which is a detector narrower than the thing it detects.
 *
 * WHAT THE SOURCE IS. The host's `workflow-authoring` reference, read
 * 2026-10-21: *"Standard JS built-ins (JSON, Math, Array, etc.) are available
 * — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`, which throw
 * (they would break resume)"*. `scripts/validate-workflow.ts` carries the
 * zero-agent probe that re-checks it.
 *
 * WHAT THESE CASES ASSERT. That the three constructs are refused, that legal
 * neighbours of each are NOT refused, and — via a mutant validator whose
 * `REFUSE_EXIT` is 0 — that the refusal is the thing producing the non-zero
 * exit rather than a crash or a module-resolution failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-workflow.ts");
const validatorSource = readFileSync(VALIDATOR, "utf-8");

const REFUSE_EXIT_DECL = "export const REFUSE_EXIT = 1;";

let DIR = "";
let MUTANT = "";

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "sandbox-903-"));

  const hits = validatorSource.split(REFUSE_EXIT_DECL).length - 1;
  if (hits !== 1) {
    throw new Error(`could not build the mutant: the exit-code constant appears ${hits} times`);
  }
  const inlined = validatorSource.match(/process\.exit\(\s*[1-9]/g) || [];
  if (inlined.length > 0) {
    throw new Error(`could not build the mutant: ${inlined.length} inlined non-zero exit(s)`);
  }
  // The mutant runs from a temp directory, so a relative import would make it
  // die on module resolution — a non-zero exit that reads as the mutation
  // having been rejected on the merits.
  const relative = validatorSource.match(/from\s+["']\.\.?\//g) || [];
  if (relative.length > 0) {
    throw new Error(`could not build the mutant: the validator gained ${relative.length} relative import(s)`);
  }

  MUTANT = join(DIR, "validate-workflow-refuse-exit-zero.ts");
  writeFileSync(MUTANT, validatorSource.replace(REFUSE_EXIT_DECL, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

function run(target: string, validator = VALIDATOR) {
  const r = spawnSync("bun", [validator, target], { encoding: "utf-8", cwd: REPO_ROOT });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** A syntactically valid workflow script whose body is `body`. */
function fixture(name: string, body: string): string {
  const p = join(DIR, name);
  writeFileSync(
    p,
    `export const meta = { name: '${name.replace(/\W/g, "-")}', description: 'fixture for #903' }\n${body}\n`,
  );
  return p;
}

describe("#903: the sandbox's clock and entropy refusals are detected", () => {
  const CASES: { label: string; body: string; expect: RegExp }[] = [
    { label: "Date.now()", body: "const t = Date.now()\nlog(String(t))", expect: /`Date\.now\(\)` used 1x/ },
    { label: "Math.random()", body: "const r = Math.random()\nlog(String(r))", expect: /`Math\.random\(\)` used 1x/ },
    { label: "argless new Date()", body: "const d = new Date()\nlog(d.toISOString())", expect: /`new Date\(\)` used 1x/ },
    { label: "dynamic import()", body: "const m = await import('node:fs')\nlog(String(m))", expect: /`import\(\)` used 1x/ },
  ];

  for (const c of CASES) {
    test(`${c.label} is refused`, () => {
      const r = run(fixture(`refused-${c.label.replace(/\W/g, "")}.js`, c.body));
      expect(r.out).toMatch(c.expect);
      expect(r.code).not.toBe(0);
    });

    test(`${c.label}: the refusal, not a crash, is what makes the exit non-zero`, () => {
      // The mutant differs from the validator in one character: REFUSE_EXIT.
      // If the case still exits non-zero under it, the exit was never the
      // refusal — see .claude/rules/checks-must-be-able-to-fail.md.
      const target = fixture(`mutant-${c.label.replace(/\W/g, "")}.js`, c.body);
      expect(run(target).code).not.toBe(0);
      expect(run(target, MUTANT).code).toBe(0);
    });
  }

  test("the reason names the constraint and what to do instead, not just the token", () => {
    const r = run(fixture("reason.js", "const t = Date.now()\nlog(String(t))"));
    expect(r.out).toMatch(/would break resume/);
    expect(r.out).toMatch(/#903/);
    expect(r.out).toMatch(/pass it in through `args`/);
  });
});

describe("#903: the detector does not flag the legal neighbour of each refusal", () => {
  /**
   * Each of these is a construct the sandbox genuinely allows, chosen to sit
   * one character away from something it does not. A detector that reddens on
   * these is the same defect as one that misses the cases above, pointed the
   * other way — and `new Date('<iso>')` is not hypothetical: the first draft
   * of this check flagged it, because `stripNonCode` blanks the string body
   * to spaces and an empty-looking argument list is argless to a regex.
   */
  const LEGAL: { label: string; body: string }[] = [
    { label: "new Date(iso) — a parsed timestamp, not a clock read", body: "const d = new Date('2026-01-01T00:00:00Z')\nlog(d.toISOString())" },
    { label: "new Date(arg) from args", body: "const d = new Date(args.when)\nlog(d.toISOString())" },
    { label: "Date.parse", body: "log(String(Date.parse('2026-01-01')))" },
    { label: "Math.floor / Math.max", body: "log(String(Math.floor(Math.max(1, 2))))" },
    { label: "a member called now() on something else", body: "const clock = { now: () => 1 }\nlog(String(clock.now()))" },
    { label: "a member called random() on something else", body: "const rng = { random: () => 1 }\nlog(String(rng.random()))" },
    { label: "the words inside a template literal bun -e will run", body: "await agent(`run: bun -e \"console.log(Date.now(), Math.random(), new Date())\"`)" },
    { label: "the words inside a comment", body: "// Date.now() and Math.random() and new Date() are banned here\nlog('ok')" },
    { label: "the words inside a plain string", body: "log('do not call Date.now() or new Date() in a workflow')" },
    { label: "a static import line", body: "log('no dynamic import here')" },
  ];

  for (const c of LEGAL) {
    test(`${c.label} is allowed`, () => {
      const r = run(fixture(`legal-${c.label.replace(/\W/g, "").slice(0, 24)}.js`, c.body));
      expect(r.out, `the detector flagged legal code:\n${r.out}`).not.toMatch(/✗ `(Date\.now|Math\.random|new Date|import)\(\)`/);
    });
  }
});

describe("#903: the real workflow scripts", () => {
  /**
   * Sourced by reading `workflows/` rather than by listing the six names
   * known today: a seventh workflow added next month is exactly the case this
   * guard is for, and a hardcoded list would not cover it.
   */
  const SCRIPTS = readdirSync(join(REPO_ROOT, "workflows")).filter(f => f.endsWith(".js"));

  test("there are workflow scripts to check — an empty list passes over anything", () => {
    expect(SCRIPTS.length).toBeGreaterThan(0);
  });

  for (const name of SCRIPTS) {
    test(`workflows/${name} references no unavailable sandbox capability`, () => {
      const r = run(join(REPO_ROOT, "workflows", name));
      expect(r.out, r.out).not.toMatch(/✗ `(Date\.now|Math\.random|new Date|import)\(\)`/);
    });
  }

  test("the success line names what was checked, so a green is readable", () => {
    const r = run(join(REPO_ROOT, "workflows", "ship.js"));
    expect(r.out).toMatch(/✓ Sandbox capabilities: none of the \d+ unavailable global\(s\) or \d+ unavailable capability form\(s\) referenced/);
  });
});
