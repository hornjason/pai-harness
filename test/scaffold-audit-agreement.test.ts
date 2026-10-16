/**
 * #398 — scaffold's audit mode reports 0 changes on a tree where `--fix`
 * modifies 16 files.
 *
 * Covers SC-1510, SC-1511, SC-1512 (HARNESS-STANDARD.md).
 *
 * `rungate scaffold <path>` without `--fix` calls itself a preview —
 * "Mode: audit (pass --fix to apply changes)" — and reports
 * `0 created, 0 replaced, 0 skipped, 0 refused` on a tree that `--fix` then
 * rewrites. It is not a conservative preview; it is a report with nothing in
 * it, because the audit branch is four `existsSync` checks standing in for
 * twenty-five write steps. Two code paths that share no code cannot agree
 * except by accident.
 *
 * `--fix` is the DESTRUCTIVE mode: #370 is `--fix` truncating
 * `.claude/rules/checks-must-be-able-to-fail.md` from 262 lines to 65 — the
 * rule three specs cite by path. Audit is the one thing between a consumer
 * and that, and it reports clean no matter what is about to happen. A
 * preview that under-reports is worse than no preview, because it converts
 * "I checked first" into false confidence.
 *
 * ## Why the property is "the two modes agree" and nothing narrower
 *
 * A test asserting "audit reports N changes" pins today's template set and
 * goes stale on the next generator edit, and someone then updates the number
 * rather than the code. "Audit and fix agree" needs no judgement about what
 * the right answer is, stays true forever, and fails the moment one step
 * forgets its audit branch — which is the actual bug, one step at a time
 * rather than a global switch.
 *
 * Both modes are run as SUBPROCESSES over planted repositories, and the
 * comparison is between the paths audit NAMES and the paths `--fix`
 * ACTUALLY WROTE as git reports them. Comparing audit's report to fix's
 * report would pass if both were empty, which is the vacuous form and is
 * most of the current defect.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { WRITE_VERBS, writtenPath } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "scaffold-project.ts");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/**
 * A consumer that has been scaffolded once and has since drifted — which is
 * every consumer that has not re-scaffolded recently, and the population the
 * issue measured on agentgrit.
 */
function plantDriftedConsumer(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `scaffold-audit-${name}-`));
  roots.push(root);
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  write("package.json", JSON.stringify({ name, private: true }, null, 2));
  write("src/index.ts", "export const x = 1;\n");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

  // Drift: present but stale, so --fix REPLACES rather than CREATES. Both
  // outcomes have to be in the fixture or a mode that reports only one kind
  // passes (SC-1511).
  write("AGENTS.md", "# stale\n\nThis is not what the generator produces.\n");
  write(".github/workflows/ci.yml", "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hand-edited\n");
  write("specs/EXAMPLE-SPEC.md", "# Example\n\nNo frontmatter, so a validator has something to say.\n");

  git("add", "-A");
  git("commit", "-qm", "planted");
  return root;
}

interface Run { code: number; out: string; paths: Set<string> }

function runScaffold(root: string, args: string[]): Run {
  const r = spawnSync("bun", [CLI, root, ...args], {
    cwd: ROOT, encoding: "utf-8", timeout: 300_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const paths = new Set<string>();
  for (const line of out.split("\n")) {
    const p = writtenPath(line);
    // Normalised the same way postScaffoldCommit normalises before staging:
    // scaffold reports some output as a created directory rather than
    // per-file, and "reference/" and "reference" are the same write.
    if (p) paths.add(p.replace(/\/+$/, ""));
  }
  return { code: r.status ?? -1, out, paths };
}

/**
 * Every path under `root`, with a content fingerprint for files.
 *
 * NOT `git status --porcelain`, which was the first oracle here and was
 * narrower than the thing it measured — the same defect shape as the bug
 * under repair. Git does not track directories, so a created `reference/`
 * is invisible to it, and `.git/hooks/` is never tracked at all, so both
 * generated hooks were invisible too. Audit named nine paths `git status`
 * could not see and the test called them phantoms. The audit was right.
 */
function snapshot(root: string, rel = "", acc = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    // Not scaffold output. `.fallow` is the static-analysis tool's cache,
    // written as a side effect of a step that shells out to it, and both
    // modes produce it. Excluding it here rather than teaching audit to
    // report it: a preview that lists a tool cache as a change it is about
    // to make is noise, and noise is how a preview stops being read.
    if (entry.name === "node_modules" || entry.name === ".fallow") continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      acc.set(`${child}/`, "dir");
      snapshot(root, child, acc);
    } else if (entry.isFile()) {
      // Size and mtime would report a rewrite that changed nothing; content
      // is what "scaffold wrote this" has to mean for the comparison to be
      // about behaviour rather than about touching files.
      acc.set(child, createHash("sha1").update(readFileSync(join(root, child))).digest("hex"));
    }
  }
  return acc;
}

/** Paths a run added or rewrote, as the filesystem sees it. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [p, h] of after) if (before.get(p) !== h) out.add(p);
  return out;
}

/**
 * Git's own bookkeeping, which both modes churn for reasons unrelated to
 * scaffold output. Excluded from the comparison by prefix rather than by
 * name, and the two generated hooks are deliberately NOT excluded — they are
 * scaffold output and the whole point of #85 and #397.
 */
function isGitBookkeeping(p: string): boolean {
  return p.startsWith(".git/") && !p.startsWith(".git/hooks/");
}

/** Run `--fix` on `copy` and return what it actually wrote. */
function fixChanges(copy: string): Set<string> {
  const before = snapshot(copy);
  runScaffold(copy, ["--fix"]);
  const out = new Set<string>();
  for (const p of changedPaths(before, snapshot(copy))) {
    if (!isGitBookkeeping(p)) out.add(p.replace(/\/$/, "") || p);
  }
  return out;
}

describe("SC-1510: audit names what --fix performs", () => {
  test("the audit report is not empty on a tree --fix rewrites", () => {
    // The headline symptom, stated on its own so a regression says which
    // half broke rather than only that the sets differ.
    const fixture = plantDriftedConsumer("empty");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    const actuallyChanged = fixChanges(copy);
    expect(
      actuallyChanged.size,
      "the fixture does not drift — this test would pass vacuously",
    ).toBeGreaterThan(0);

    const audit = runScaffold(fixture, []);
    expect(
      audit.paths.size,
      `--fix changed ${actuallyChanged.size} paths and audit named none`,
    ).toBeGreaterThan(0);
  }, 300_000);

  test("audit writes nothing", () => {
    // Separate claim from "reports correctly", and the only one that makes
    // the preview safe. Compared as the tree git sees, not as a count.
    const fixture = plantDriftedConsumer("readonly");
    const before = snapshot(fixture);
    runScaffold(fixture, []);
    const touched = [...changedPaths(before, snapshot(fixture))].filter(q => !isGitBookkeeping(q));
    expect(touched, "audit wrote into the tree it was previewing").toEqual([]);
  }, 300_000);

  test("every path audit names is one --fix writes", () => {
    // Direction one: audit must not invent work. A preview that over-reports
    // trains a consumer to ignore it, which costs the same as under-reporting
    // one incident later.
    const fixture = plantDriftedConsumer("no-phantoms");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    const audit = runScaffold(fixture, []);
    const changed = fixChanges(copy);

    const phantom = [...audit.paths].filter(p => !changed.has(p));
    expect(phantom, "audit named paths --fix never wrote").toEqual([]);
  }, 300_000);

  test("every path --fix writes is one audit named", () => {
    // Direction two, and the one that is red today. Kept apart from the
    // first because a mode that reports nothing satisfies the first.
    const fixture = plantDriftedConsumer("no-silent");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    const audit = runScaffold(fixture, []);
    const changed = fixChanges(copy);

    // A path counts as reported if audit named it OR named a directory
    // containing it. Scaffold reports some output per-directory rather than
    // per-file — `.claude/rungate/` covers the four json files it writes —
    // and `postScaffoldCommit` already depends on exactly that reading when
    // it stages a reported directory to pick up its contents.
    const covered = (q: string) => {
      if (audit.paths.has(q)) return true;
      for (let i = q.lastIndexOf("/"); i > 0; i = q.lastIndexOf("/", i - 1)) {
        if (audit.paths.has(q.slice(0, i))) return true;
      }
      // A bare directory that exists only as the parent of something
      // reported. `.claude` is never an action of its own — it is there
      // because `.claude/rungate/` was written into it. Listing every
      // implicit parent would be noise, and noise is how a preview stops
      // being read, so the comparison accepts the child instead.
      if (!q.includes(".", 1)) {
        for (const named of audit.paths) if (named.startsWith(q + "/")) return true;
      }
      return false;
    };
    const unreported = [...changed].filter(q => !covered(q));
    expect(unreported, "--fix wrote paths audit never mentioned").toEqual([]);
  }, 300_000);
});

describe("SC-1518: a rehearsal that cannot be set up refuses the run", () => {
  test("audit exits non-zero and writes nothing when the clone is refused", () => {
    // The end-to-end half, and the mutation battery is why it exists:
    // replacing the CLI's `process.exit(1)` with a fall-back to the real
    // write steps scored 0 red. Nothing ran the CLI against a tree whose
    // clone refuses, so the one branch standing between a refused preview
    // and `--fix` on the consumer's actual repository was untested.
    //
    // Falling back is the tempting failure. "The preview could not be set
    // up, so preview the real tree" is #370's damage with a reassuring
    // message in front of it: an audit that reports nothing because it
    // could not look is indistinguishable from one that found nothing, and
    // that is the defect, not a lesser version of it.
    const outside = mkdtempSync(join(tmpdir(), "scaffold-audit-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "AGENTS.md"), "the consumer's real file\n");

    const fixture = plantDriftedConsumer("refused");
    rmSync(join(fixture, "AGENTS.md"));
    require("fs").symlinkSync(join(outside, "AGENTS.md"), join(fixture, "AGENTS.md"));

    const before = snapshot(fixture);
    const r = runScaffold(fixture, []);

    expect(r.code, "a refused rehearsal must not exit 0").not.toBe(0);
    expect(r.out).toMatch(/audit did NOT run/);
    expect(r.out).toMatch(/pointing outside it/);
    expect(
      readFileSync(join(outside, "AGENTS.md"), "utf-8"),
      "audit wrote through the symlink into the consumer's real file",
    ).toBe("the consumer's real file\n");
    const touched = [...changedPaths(before, snapshot(fixture))].filter(q => !isGitBookkeeping(q));
    expect(touched, "audit fell back to writing the real tree").toEqual([]);
  }, 300_000);
});

describe("SC-1519: the two steps a rehearsal must not run, do not run", () => {
  test("audit does not deploy hooks into a configured consumer", () => {
    // `deployHooksToConsumers` resolves `consumer.startsWith("/")` and writes
    // to ABSOLUTE paths in other repositories. Rehearsing it would deploy
    // hooks to every consumer on the machine during a preview — damage done
    // outside the clone entirely, so no amount of throwing the clone away
    // undoes it.
    //
    // `STEPS_NOT_REHEARSED` naming the step is not evidence the guard fires;
    // the mutation battery scored removing the guard 0 red until this case
    // existed. A decider being right is not the same as the caller asking it.
    const consumer = mkdtempSync(join(tmpdir(), "scaffold-audit-consumer-"));
    roots.push(consumer);
    mkdirSync(join(consumer, ".claude"));
    writeFileSync(join(consumer, ".claude", "settings.local.json"), "{}\n");

    const fixture = plantDriftedConsumer("consumers");
    mkdirSync(join(fixture, "hooks"), { recursive: true });
    writeFileSync(join(fixture, "hooks", "probe.ts"), "// a hook\n");
    // Two fixture details the positive control below forced out, and the
    // reason it is here: `hooks` comes from hooks.json, not config.json —
    // `loadFromDirectory` spreads it last and defaults it to `[]`, so a
    // hooks array in config.json is silently dropped — and the step only
    // deploys an entry carrying `enabled`, `hookFor`, `command` and
    // `deployToConsumers: true`. Either mistake leaves `--fix` writing
    // nothing, which would have made the guard look like it fired.
    mkdirSync(join(fixture, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(fixture, ".claude", "rungate", "config.json"),
      JSON.stringify({ consumers: [consumer] }, null, 2),
    );
    writeFileSync(
      join(fixture, ".claude", "rungate", "hooks.json"),
      JSON.stringify([{
        name: "probe", enabled: true, hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/probe.ts", deployToConsumers: true,
      }], null, 2),
    );

    const before = snapshot(consumer);
    const audit = runScaffold(fixture, []);
    expect(audit.out, "the notice must say what was not rehearsed").toContain("deployHooksToConsumers");
    expect(
      [...changedPaths(before, snapshot(consumer))],
      "audit wrote into another repository",
    ).toEqual([]);

    // The positive control: --fix DOES deploy, so the case above is a guard
    // firing rather than a config the step ignored. Without this, misspelling
    // the config key would make both halves pass.
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });
    runScaffold(copy, ["--fix"]);
    expect(
      [...changedPaths(before, snapshot(consumer))].length,
      "--fix did not deploy either — the fixture does not configure a consumer",
    ).toBeGreaterThan(0);
  }, 300_000);
});

describe("SC-1511: the fixture exercises more than one outcome", () => {
  test("--fix both creates and replaces on this fixture", () => {
    // Without this the agreement property could hold over a fixture with one
    // kind of change, and a mode that reports only creations would pass.
    const copy = plantDriftedConsumer("outcomes");
    const r = runScaffold(copy, ["--fix"]);
    expect(r.out, "no CREATED lines — the fixture is already complete").toMatch(/\bCREATED: /);
    expect(r.out, "no REPLACED/UPDATED lines — the fixture does not drift").toMatch(/\b(REPLACED|UPDATED): /);
  }, 300_000);
});

describe("SC-1512: one binding decides what counts as a written path", () => {
  test("every write verb the scaffold emits is in WRITE_VERBS", () => {
    // The drift guard, and it is here because the drift was real: the list
    // was missing REGENERATED, REFRESHED and REPAIRED, so `postScaffoldCommit`
    // had never staged AGENTS.md, `.claude/rules/` or any seeded config. A
    // comment above the list already warned that a missing verb "silently
    // leaves generated files uncommitted"; prose did not keep it current.
    //
    // Read from the sources rather than listed here, so adding a step with a
    // new verb fails this rather than going unnoticed until someone audits
    // a consumer by hand.
    const sources = ["lib/scaffold/steps.ts", "lib/scaffold/write-steps.ts", "lib/validators/spec-validators.ts"]
      .map(f => readFileSync(join(ROOT, f), "utf-8")).join("\n");

    // Verbs that announce a write, as distinct from SKIP / GAP / WARN /
    // AUDIT / AUDITED / UNCHANGED / REFUSED, which announce that none
    // happened. A new verb lands in one list or the other by hand — that
    // judgement cannot be derived — but it can no longer land in neither.
    const NON_WRITE = new Set(["SKIP", "GAP", "WARN", "AUDIT", "AUDITED", "UNCHANGED", "REFUSED", "ERROR", "NOTE"]);
    const emitted = new Set<string>();
    for (const m of sources.matchAll(/actions\.push\([`"']([A-Z]{3,12}): /g)) emitted.add(m[1]!);

    const unclassified = [...emitted].filter(v => !NON_WRITE.has(v) && !WRITE_VERBS.includes(v));
    expect(
      unclassified,
      "a report verb is in neither WRITE_VERBS nor the non-write list — postScaffoldCommit will not stage it and audit will not report it",
    ).toEqual([]);
  });

  test.each([
    ["  CREATED: AGENTS.md", "AGENTS.md"],
    ["  REPLACED: .github/workflows/ci.yml (+4 lines, overwrote 1 edited line(s))", ".github/workflows/ci.yml"],
    ["  UPDATED: .git/hooks/pre-push (conformity check)", ".git/hooks/pre-push"],
    ["  GENERATED: CODE-MAP.md", "CODE-MAP.md"],
  ])("%s names %s", (line, path) => {
    expect(writtenPath(line)).toBe(path);
  });

  test.each([
    "  SKIP: .git/hooks/pre-push (hand-written, not overwriting)",
    "  GAP: CODE-MAP.md missing — run with --fix to generate",
    "  WARN: specs/EXAMPLE-SPEC.md has no frontmatter",
    "  REFUSED: .github/workflows/ci.yml",
    "Mode: audit (pass --fix to apply changes)",
  ])("%s names no written path", line => {
    // The negative control. An extractor that returned a path for SKIP would
    // make audit and fix agree by both over-reporting, which is agreement
    // for the wrong reason.
    expect(writtenPath(line)).toBeNull();
  });
});
