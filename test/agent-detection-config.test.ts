/**
 * #1000 — `detectAgent` read a config that was not in the tree, and the
 * `catch` turned that into `{ agents: {} }`.
 *
 * ## What was actually wrong
 *
 * `hooks/lib/agentDetection.ts` loaded `agent-config.json` from beside
 * itself. The file was in no commit on any branch of this repository.
 * `JSON.parse(readFileSync(...))` threw `ENOENT`, the `catch` returned an
 * object with no agents, the `for` over `Object.entries(config.agents)` ran
 * zero times, and `detectAgent` returned `null` for **every** input.
 *
 * `hooks/CommitEnforcement.hook.ts` is the only consumer:
 *
 *     const agent = detectAgent(toolInput)
 *     if (!agent) process.exit(0)   // Not a known agent — skip
 *
 * So the hook exited before its UI-file detection and before its
 * uncommitted-changes tripwire, for every agent, for as long as the file has
 * been absent. Neither signal was ever written by this copy.
 *
 * ## Why the absence was invisible, which is the part worth testing
 *
 * `.claude/rules/config-access.md`'s *Silent Default Substitution*: a hook
 * that **declined** and a hook that **could not run** produced the same
 * observation — `exit 0`, nothing written, no record. There was no reading
 * that could distinguish them, so nothing could notice. The headline defect
 * is one missing file and is fixed by adding it; **the defect that let it
 * last is the `catch`**, and adding the file does not touch it.
 *
 * That split is the design of this battery:
 *
 * | arm | survives "just add the JSON"? |
 * |---|---|
 * | AC-1, AC-2 — the shipped config exists and matches a real agent | no — these are what that fix is |
 * | **AC-3, AC-4, AC-5** — absent / malformed / empty is a REFUSAL | **yes** — all three stay red against it |
 * | AC-6 — the hook RECORDS the unreadable case | yes |
 *
 * AC-3 to AC-6 are the arms that matter. If a later change deletes the
 * config again, AC-1 goes red; if a later change restores the `catch`, the
 * deletion becomes silent again and only AC-3 to AC-6 can say so.
 *
 * ## The scope error inside the issue, recorded because it recurs
 *
 * #1000 said the config *"has never existed on any branch"*. True of this
 * repository, false of the machine — `~/.claude/hooks/lib/agent-config.json`
 * has been there since Sep 9, and the five agents and the `exclude:
 * ["council"]` on `marcus` in `hooks/lib/agent-config.json` are **recovered
 * from it**, not invented from the match patterns. A census over one scope
 * reporting confident absence is #910 and #713, arriving for the third time
 * in the issue that cites both of them for it.
 *
 * Issue: #1000. Refs #971, #910, #713.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { detectAgent, agentConfigPath } from "../hooks/lib/agentDetection";

const ROOT = join(import.meta.dir, "..");
const SHIPPED = join(ROOT, "hooks", "lib", "agent-config.json");

/** Temp dirs, removed by the arm that made them. */
const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-config-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/**
 * A copy of the detection module in a directory we control, so the config it
 * finds beside itself is the one an arm chose to put there — including none.
 *
 * Nothing about the module is rewritten: it is copied byte-for-byte and only
 * its `agent-config.json` neighbour varies. `AC-0` asserts that, so this
 * helper cannot quietly become a second version of the subject.
 */
function stageDetection(config: string | null, into?: string): { dir: string; source: string } {
  const dir = into ?? tmp();
  const source = readFileSync(join(ROOT, "hooks", "lib", "agentDetection.ts"), "utf-8");
  writeFileSync(join(dir, "agentDetection.ts"), absolutiseImports(source, join(ROOT, "hooks", "lib")));
  if (config !== null) writeFileSync(join(dir, "agent-config.json"), config);
  return { dir, source };
}

/**
 * Relative imports repointed at the real directory the module came from.
 *
 * A staged copy is somewhere else on disk, so `../../lib/hook-evidence`
 * resolves to nothing. Only the import SPECIFIERS change; the module's own
 * statements do not, which is what AC-0 asserts.
 */
function absolutiseImports(source: string, base: string): string {
  const out = source.replace(/from (['"])(\.[^'"]*)\1/g, (_m, q: string, rel: string) => `from ${q}${resolve(base, rel)}${q}`);
  const survivors = [...out.matchAll(/from ['"](\.[^'"]*)['"]/g)].map(m => m[1]);
  if (survivors.length > 0) throw new Error(`relative imports survived the rewrite: ${survivors.join(", ")}`);
  return out;
}

/**
 * `detectAgent` from a staged copy, in a fresh process.
 *
 * A fresh process and not a dynamic import, for two reasons that both matter:
 * the module memoises into `_configCache`, and a throw at module scope is a
 * different observation from a throw at call time. The subprocess reports
 * which one happened.
 */
function runStaged(dir: string, toolInput: Record<string, string>): { threw: boolean; stderr: string; out: string } {
  const probe = join(dir, "probe.ts");
  writeFileSync(
    probe,
    `import { detectAgent } from ${JSON.stringify(join(dir, "agentDetection.ts"))};\n` +
      `console.log(JSON.stringify(detectAgent(${JSON.stringify(toolInput)})));\n`,
  );
  const r = spawnSync("bun", [probe], { encoding: "utf-8", timeout: 20000 });
  return { threw: r.status !== 0, stderr: r.stderr || "", out: (r.stdout || "").trim() };
}

describe("#1000 — the agent config is present, and its absence is a refusal", () => {
  test("AC-0 INSTRUMENT: the staged module differs from the shipped one only in its import specifiers", () => {
    // Without this, every arm below is a claim about a file this test wrote.
    // The copy cannot be byte-identical — `../../lib/hook-evidence` does not
    // resolve from a tmpdir — so the assertion is that NOTHING ELSE moved.
    const { dir, source } = stageDetection(null);
    const a = source.split("\n");
    const b = readFileSync(join(dir, "agentDetection.ts"), "utf-8").split("\n");
    expect(a.length, "the staging changed the line count").toBe(b.length);
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      changed++;
      expect(a[i], `the staging changed a line that is not an import: ${JSON.stringify(a[i])}`).toMatch(/^import .* from ['"]\./);
    }
    expect(changed, "nothing was rewritten, so the rewrite is not doing anything").toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-1: a known agent matches through the SHIPPED config", () => {
    // The arm that goes red if the config is ever deleted again. It drives
    // the real module against the real file — no staging, no fixture.
    const marcus = detectAgent({ subagent_type: "marcus", prompt: "issue #971" });
    expect(marcus, "detectAgent returned null for a known agent — the config is unreadable again").not.toBeNull();
    expect(marcus!.key).toBe("marcus");

    // A second agent, so the arm cannot pass on a one-entry config.
    const quinn = detectAgent({ name: "Quinn Torres", prompt: "check the UI" });
    expect(quinn, "only one agent resolves, so the config was truncated").not.toBeNull();
    expect(quinn!.key).toBe("quinn");

    // And the exclude branch, which is the only part of the matcher a
    // present-but-thin config would leave unexercised.
    expect(
      detectAgent({ subagent_type: "marcus", prompt: "convene a council on this" }),
      "the `exclude` list is not reaching the matcher",
    ).toBeNull();
  });

  test("AC-2: the shipped config declares every agent CommitEnforcement is documented to cover", () => {
    const cfg = JSON.parse(readFileSync(SHIPPED, "utf-8"));
    // The hook's own docstring: "Broadened from Marcus-only to all code
    // agents (marcus, quinn, rook, serena, aditi)." That sentence was true of
    // nothing for as long as the config was missing.
    for (const key of ["marcus", "quinn", "rook", "serena", "aditi"]) {
      expect(Object.keys(cfg.agents), `CommitEnforcement claims to cover ${key}`).toContain(key);
      expect(cfg.agents[key].match.length, `${key} has no match patterns, so it can never be detected`).toBeGreaterThan(0);
    }
  });

  test("AC-3: an ABSENT config is a refusal, not an empty reading", () => {
    // THE ARM THAT SURVIVES THE CHEAP FIX. Adding the JSON file makes AC-1
    // and AC-2 green and leaves this red: the `catch` that turned a missing
    // file into `{ agents: {} }` is what made a deleted config invisible, and
    // it is untouched by shipping a config.
    const { dir } = stageDetection(null);
    const r = runStaged(dir, { subagent_type: "marcus" });
    expect(r.threw, `an absent config returned ${r.out} instead of refusing`).toBe(true);
    expect(r.stderr, "the refusal does not name the file it could not read").toContain("agent-config.json");
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-4: a MALFORMED config is a refusal", () => {
    const { dir } = stageDetection("{ this is not json");
    const r = runStaged(dir, { subagent_type: "marcus" });
    expect(r.threw, `unparseable JSON returned ${r.out} instead of refusing`).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-5: a config declaring ZERO agents is a refusal — it is the fabricated value made real", () => {
    // `{ agents: {} }` is exactly what the `catch` used to invent. A real file
    // holding it has the identical effect and would reinstate the defect in a
    // form every other arm here passes. Refusing the value closes that door.
    const { dir } = stageDetection(JSON.stringify({ agents: {} }));
    const r = runStaged(dir, { subagent_type: "marcus" });
    expect(r.threw, `a zero-agent config returned ${r.out} instead of refusing`).toBe(true);
    expect(r.stderr).toContain("zero agents");
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-13: an agent whose `match` list is EMPTY is a refusal", () => {
    // Added because the per-agent guard was otherwise unwitnessed: mutating
    // its condition to `false` reddened nothing, since no arm fed a config
    // containing an agent that can never match. A guard no input can
    // distinguish from its own absence is not a guard
    // (`.claude/rules/checks-must-be-able-to-fail.md`). This is that input.
    const { dir } = stageDetection(JSON.stringify({ agents: { marcus: { match: [] } } }));
    const r = runStaged(dir, { subagent_type: "marcus" });
    expect(r.threw, `an agent with no match patterns returned ${r.out} instead of refusing`).toBe(true);
    expect(r.stderr).toContain("no match patterns");
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-6 CONTROL: a staged config that IS readable resolves, under the same harness", () => {
    // Without this, AC-3 to AC-5 are equally consistent with `runStaged`
    // being broken — a helper that always reports `threw` would pass all
    // three. This is the input on which the harness must NOT refuse.
    const { dir } = stageDetection(JSON.stringify({ agents: { marcus: { match: ["marcus"] } } }));
    const r = runStaged(dir, { subagent_type: "marcus" });
    expect(r.threw, `the staging harness refuses even a valid config: ${r.stderr}`).toBe(false);
    expect(JSON.parse(r.out).key).toBe("marcus");
    rmSync(dir, { recursive: true, force: true });
  });

  test("AC-7: the config still resolves from a directory whose name contains a SPACE", () => {
    // `new URL(import.meta.url).pathname` percent-encodes. Under any checkout
    // whose path contains a space the old spelling produced `…/My%20Repo/`,
    // ENOENT, and — through the `catch` — this issue's exact symptom from a
    // second, environment-dependent direction.
    //
    // Asserting `agentConfigPath()` has no `%20` would be VACUOUS: this
    // checkout's path has no space, so the assertion holds against the
    // percent-encoding spelling too and the arm could never fail. The space
    // has to be in the INPUT. A directory that has one is the input.
    const spaced = join(tmp(), "My Repo");
    mkdirSync(spaced, { recursive: true });
    stageDetection(JSON.stringify({ agents: { marcus: { match: ["marcus"] } } }), spaced);

    const r = runStaged(spaced, { subagent_type: "marcus" });
    expect(r.threw, `the config beside a module in "My Repo" was unreadable: ${r.stderr}`).toBe(false);
    expect(JSON.parse(r.out).key).toBe("marcus");

    // And the exported path is the one the loader uses, so a caller naming it
    // in an error message names the file that was actually tried.
    expect(agentConfigPath().endsWith(join("hooks", "lib", "agent-config.json"))).toBe(true);
  });
});

describe("#1000 — CommitEnforcement records the unreadable case instead of exiting silently", () => {
  /**
   * The real hook, with ONE neighbour substituted.
   *
   * There is no way to make the shipped config unreadable for a subprocess
   * without deleting it from the tree, and a test-only env override inside
   * `agentDetection` would be a production code path that exists for this
   * arm — the thing that makes a check untrustworthy. So the hook is staged
   * the way `test/hook-shell-injection.test.ts` already stages it: copied
   * verbatim, every relative import rewritten to an absolute path against
   * the real `hooks/` directory, EXCEPT `./lib/agentDetection`, which is
   * pointed at a staged copy with the chosen config beside it.
   *
   * AC-10 asserts that the only lines that differ are imports, so this
   * cannot drift into being a second version of the hook.
   */
  function stageHook(config: string | null): { path: string; source: string; staged: string } {
    const dir = tmp();
    const hooksDir = join(ROOT, "hooks");
    const source = readFileSync(join(hooksDir, "CommitEnforcement.hook.ts"), "utf-8");
    const detection = stageDetection(config).dir;

    const staged = source.replace(/from (['"])(\.[^'"]*)\1/g, (_m, q: string, rel: string) =>
      rel === "./lib/agentDetection"
        ? `from ${q}${join(detection, "agentDetection.ts")}${q}`
        : `from ${q}${resolve(hooksDir, rel)}${q}`,
    );
    const survivors = [...staged.matchAll(/from ['"](\.[^'"]*)['"]/g)].map(m => m[1]);
    if (survivors.length > 0) throw new Error(`relative imports survived the rewrite: ${survivors.join(", ")}`);

    const path = join(dir, "CommitEnforcement.hook.ts");
    writeFileSync(path, staged);
    return { path, source, staged };
  }

  /** The staged hook, driven as a real subprocess with a real stdin payload. */
  function runHook(hookPath: string): Array<Record<string, unknown>> {
    const work = tmp();
    const r = spawnSync("bun", [hookPath], {
      input: JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "marcus", isolation: "worktree", prompt: "issue #1000" },
        tool_response: "",
        cwd: work,
      }),
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, RUNGATE_WORK_DIR: work },
    });
    expect(r.status, `the hook crashed rather than recording: ${r.stderr}`).toBe(0);
    try {
      return readFileSync(join(work, "hook-firings.jsonl"), "utf-8")
        .trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  test("AC-10 INSTRUMENT: the staged hook differs from the shipped one only in its imports", () => {
    const { source, staged } = stageHook(null);
    const a = source.split("\n");
    const b = staged.split("\n");
    expect(a.length, "the staging changed the line count").toBe(b.length);
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      changed++;
      expect(
        a[i].trimStart().startsWith("import ") || a[i].trimStart().startsWith("} from "),
        `the staging changed a line that is not an import: ${JSON.stringify(a[i])}`,
      ).toBe(true);
    }
    expect(changed, "nothing was rewritten, so the staged copy is not staged").toBeGreaterThan(0);
  });

  test("AC-11: an unreadable config leaves a record — a hook that COULD NOT run is not one that declined", () => {
    // #1000's "why this is not a shrug": the error direction was silent, and
    // #910's answer — `recordHookFiring` — was not wired into this hook, so
    // there was no evidence file to check either. Both halves are fixed here,
    // and this is the arm that says so.
    const records = runHook(stageHook(null).path);
    expect(
      records.map(r => r.outcome),
      `the hook exited leaving no record of why: ${JSON.stringify(records)}`,
    ).toContain("unmeasured-agent-config");
  });

  test("AC-12 CONTROL: a readable config leaves NO such record under the same harness", () => {
    // The input on which AC-11's record must be ABSENT. Without it, AC-11 is
    // equally consistent with the hook recording `unmeasured-agent-config`
    // unconditionally — a check that cannot fail, inside the fix for a check
    // that could not fail.
    const records = runHook(stageHook(JSON.stringify({ agents: { marcus: { match: ["marcus"] } } })).path);
    expect(
      records.map(r => r.outcome),
      "the hook reports the config unreadable even when it is readable",
    ).not.toContain("unmeasured-agent-config");
  });
});
