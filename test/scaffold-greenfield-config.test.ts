/**
 * #70 Phase 2 — greenfield scaffold must emit POPULATED roles.json and hooks.json.
 *
 * Both emission sites used to hardcode `{}` and `[]`:
 *   - lib/scaffold/steps.ts  → writeDirectoryStructure(root, config, {}, [], ...)
 *   - scripts/scaffold-rungate-config.ts → JSON.stringify({}) / JSON.stringify([])
 *
 * Every assertion here reads OBSERVABLE SCAFFOLD OUTPUT on a fresh temp project
 * and, for roles, puts it back through loadRungateConfig. Per ADR-001 and #71 a
 * source-text assertion ("steps.ts contains a non-empty literal") certifies only
 * that code was authored, never that it was adopted — so there are none.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";
import {
  generateOrAuditProjectHarness,
  deployHooksToConsumers,
  executingHookCommands,
  consumerHooksDir,
} from "../lib/scaffold/steps";
import { loadRungateConfig } from "../lib/config-loader";
import { settingsCommands } from "../lib/hook-trees";

const ROOT = resolve(import.meta.dir, "..");

/** Fresh temp project with nothing but a package.json — the greenfield case. */
function greenfield(dir: string, name = "greenfield-proj"): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "bun test" } }));
}

describe("AC-7: greenfield roles.json survives a loadRungateConfig read-back", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-roles");

  beforeEach(() => greenfield(tmpRoot));
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("loadRungateConfig reports >= 3 roles after a greenfield scaffold", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const roles = loadRungateConfig(tmpRoot).roles;

    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(3);
  });

  test("every emitted role carries the fields the harness reads off it", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const roles = loadRungateConfig(tmpRoot).roles as Record<string, any>;

    // Guard the loop below against passing on an empty map — that is exactly
    // the state this issue is about.
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(3);

    // brief/standardTask are required by RoleSchema and read by ship.js,
    // prove.js and test-brief.ts; description/tools/model drive brief
    // generation. A role missing any of them is a role the harness cannot run.
    for (const [name, role] of Object.entries(roles)) {
      expect(role.brief, `${name}.brief`).toBe(`.claude/agents/${name}.md`);
      expect(typeof role.standardTask, `${name}.standardTask`).toBe("string");
      expect(role.standardTask.length, `${name}.standardTask`).toBeGreaterThan(0);
      expect(typeof role.description, `${name}.description`).toBe("string");
      expect(typeof role.tools, `${name}.tools`).toBe("string");
      expect(typeof role.model, `${name}.model`).toBe("string");
    }
  });

  test("the roles the ship pipeline dispatches are all present", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const roles = loadRungateConfig(tmpRoot).roles;

    for (const role of ["discovery", "marcus", "quinn"]) {
      expect(roles).toHaveProperty(role);
    }
  });
});

describe("AC-10: greenfield hooks.json carries real hook registrations", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-hooks");

  beforeEach(() => greenfield(tmpRoot));
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test(">= 3 hook registrations in a freshly scaffolded project", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const hooks = JSON.parse(readFileSync(join(tmpRoot, ".claude/rungate/hooks.json"), "utf-8"));

    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks.length).toBeGreaterThanOrEqual(3);
  });

  test("each registration has the fields the deployer requires", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const hooks = JSON.parse(readFileSync(join(tmpRoot, ".claude/rungate/hooks.json"), "utf-8"));

    // deployHooksToConsumers skips any hook missing enabled/hookFor/command,
    // so a registration without them is dead weight in the file.
    expect(hooks.length).toBeGreaterThanOrEqual(3);
    for (const hook of hooks) {
      expect(typeof hook.name, hook.name).toBe("string");
      expect(typeof hook.hookFor, hook.name).toBe("string");
      expect(`${hook.name}: ${hook.command}`).toContain("${RUNGATE_HOOKS_DIR}");
      expect(typeof hook.enabled, hook.name).toBe("boolean");
    }
  });

  test("every registered hook points at a hook file that actually exists", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const hooks = JSON.parse(readFileSync(join(tmpRoot, ".claude/rungate/hooks.json"), "utf-8"));

    // A registration naming a file nobody shipped is worse than no
    // registration: it deploys a command that fails at hook time.
    expect(hooks.length).toBeGreaterThanOrEqual(3);
    for (const hook of hooks) {
      const file = hook.command.replace("${RUNGATE_HOOKS_DIR}", join(ROOT, "hooks"));
      const path = file.replace(/^bun\s+/, "").trim();
      expect(existsSync(path), `${hook.name} → ${path}`).toBe(true);
    }
  });

  test("loadRungateConfig reads the same registrations back", () => {
    generateOrAuditProjectHarness(tmpRoot, []);

    const hooks = loadRungateConfig(tmpRoot).hooks;

    expect(Array.isArray(hooks)).toBe(true);
    expect((hooks as unknown[]).length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The hook file a consumer actually has, at the path a deployed command
 * points into (#1088). `deployHooksToConsumers` now refuses to write an entry
 * whose file is not there, so a fixture that skips this gets UNMEASURED —
 * which is the correct answer for a consumer that never installed rungate,
 * and the reason the old fixtures could not tell the two apart.
 */
function installConsumerHook(consumerRoot: string, name: string): string {
  const dir = join(consumerRoot, "node_modules", "rungate", "hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.hook.ts`);
  writeFileSync(file, "export {};\n");
  return file;
}

/** What a deployed command for `name` looks like, in the consumer spelling. */
function deployedCommand(name: string): string {
  return "bun ${CLAUDE_PROJECT_DIR}/node_modules/rungate/hooks/" + name + ".hook.ts";
}

describe("AC-8: hooks.json drives consumer hook deployment under the directory layout", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-consumer");
  const consumerDir = join(tmpRoot, "consumer-a");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, ".claude", "rungate"), { recursive: true });
    mkdirSync(consumerDir, { recursive: true });
    installConsumerHook(consumerDir, "DeployedGuard");
    writeFileSync(
      join(tmpRoot, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "dir-layout", consumers: ["consumer-a"] }, null, 2)
    );
    writeFileSync(
      join(tmpRoot, ".claude", "rungate", "hooks.json"),
      JSON.stringify(
        [
          {
            name: "DeployedGuard",
            hookFor: "PreToolUse",
            command: "bun ${RUNGATE_HOOKS_DIR}/DeployedGuard.hook.ts",
            enabled: true,
            matcher: "Bash",
            deployToConsumers: true,
          },
          {
            name: "HarnessOnly",
            hookFor: "PreToolUse",
            command: "bun ${RUNGATE_HOOKS_DIR}/HarnessOnly.hook.ts",
            enabled: true,
          },
        ],
        null,
        2
      )
    );
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("a consumer gets the deployToConsumers hooks from hooks.json", () => {
    const actions: string[] = [];

    deployHooksToConsumers(tmpRoot, actions);

    const settingsPath = join(consumerDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Through the EXECUTING reader, not through a hand-indexed shape and not
    // through `lib/hook-trees`'s permissive walk (#1088).
    expect(executingHookCommands(settings, "PreToolUse")).toEqual([
      deployedCommand("DeployedGuard"),
    ]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(actions.some(a => a.startsWith("DEPLOYED:"))).toBe(true);
  });

  test("consumer deployment skips hooks not marked deployToConsumers", () => {
    deployHooksToConsumers(tmpRoot, []);

    const settings = JSON.parse(
      readFileSync(join(consumerDir, ".claude", "settings.local.json"), "utf-8")
    );
    expect(JSON.stringify(settings)).not.toContain("HarnessOnly");
  });

  test("DEPLOYED names the hooks, because a count cannot be checked against a registry (#1047)", () => {
    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);
    const line = actions.find(a => a.startsWith("DEPLOYED:"));
    expect(line, "no DEPLOYED action was emitted").toBeDefined();
    expect(line).toContain("DeployedGuard");
  });

  test("#1047: a registry where nobody opted in reads UNMEASURED, not success", () => {
    // THE case this issue turns on, and the one the cheapest wrong fix —
    // adding `hooks/` to `files[]` — does not reach. Before this change the
    // same input produced `SKIP: All hooks already deployed to consumer-a`,
    // which is the `else` of `deployed > 0` claiming a fact about hooks that
    // were never eligible. That line and a correct run over a project that
    // genuinely wanted no hooks were byte-identical, which is why 0 of 20
    // entries holding the flag survived to a release.
    const noneRoot = join(ROOT, "test", ".tmp-consumer-nobody-opted-in");
    rmSync(noneRoot, { recursive: true, force: true });
    mkdirSync(join(noneRoot, ".claude", "rungate"), { recursive: true });
    mkdirSync(join(noneRoot, "consumer-c"), { recursive: true });
    writeFileSync(
      join(noneRoot, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "none", consumers: ["consumer-c"] }),
    );
    writeFileSync(
      join(noneRoot, ".claude", "rungate", "hooks.json"),
      JSON.stringify([
        {
          name: "Undeclared",
          hookFor: "PreToolUse",
          command: "bun ${RUNGATE_HOOKS_DIR}/Undeclared.hook.ts",
          enabled: true,
        },
        {
          name: "DeclaredNo",
          hookFor: "PreToolUse",
          command: "bun ${RUNGATE_HOOKS_DIR}/DeclaredNo.hook.ts",
          enabled: true,
          deployToConsumers: false,
        },
      ]),
    );

    try {
      const actions: string[] = [];
      deployHooksToConsumers(noneRoot, actions);

      const unmeasured = actions.filter(a => a.startsWith("UNMEASURED:"));
      expect(unmeasured, "an empty eligible set must produce a reading").toHaveLength(1);
      // The separating content, not just the label: the count is what tells
      // "0 of 2 opted in" apart from "this project declares no hooks".
      expect(unmeasured[0]).toContain("0 of 2");

      // And it must NOT claim a deployment happened, by any wording.
      expect(actions.filter(a => a.startsWith("DEPLOYED:"))).toEqual([]);
      expect(actions.join("\n")).not.toContain("already deployed");
      expect(existsSync(join(noneRoot, "consumer-c", ".claude", "settings.local.json"))).toBe(false);
    } finally {
      rmSync(noneRoot, { recursive: true, force: true });
    }
  });

  test("#1047: every early exit leaves a reading rather than returning in silence", () => {
    // Four returns used to emit nothing at all, so a caller could not tell
    // "no config", "no hooks array", "no consumers" and "ran fine" apart.
    const bareRoot = join(ROOT, "test", ".tmp-consumer-silent-exits");
    rmSync(bareRoot, { recursive: true, force: true });
    mkdirSync(join(bareRoot, ".claude", "rungate"), { recursive: true });
    try {
      // hooks declared, consumers absent
      writeFileSync(
        join(bareRoot, ".claude", "rungate", "config.json"),
        JSON.stringify({ project: "bare" }),
      );
      writeFileSync(
        join(bareRoot, ".claude", "rungate", "hooks.json"),
        JSON.stringify([
          {
            name: "Any",
            hookFor: "PreToolUse",
            command: "bun ${RUNGATE_HOOKS_DIR}/Any.hook.ts",
            enabled: true,
            deployToConsumers: true,
          },
        ]),
      );
      const noConsumers: string[] = [];
      deployHooksToConsumers(bareRoot, noConsumers);
      expect(noConsumers.join("\n")).toContain("no consumers");
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  test("#1047 review: a consumer's unparseable settings.local.json is refused, never overwritten", () => {
    // `.claude/rules/config-access.md` — a corrupt config is never a missing
    // config — applied to somebody else's security settings. The `catch {}`
    // this replaces left `settings` as `{}` and then WROTE, so a consumer's
    // permissions and allowlists were replaced by a file holding our hooks.
    const settingsPath = join(consumerDir, ".claude", "settings.local.json");
    mkdirSync(join(consumerDir, ".claude"), { recursive: true });
    const corrupt = '{"permissions": {"allow": ["Bash(ls:*)"]},\n<<<<<<< HEAD\n';
    writeFileSync(settingsPath, corrupt);

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    // The separating assertion is the BYTES, not the action line: a refusal
    // that still wrote would emit a SKIP and pass a label-only check.
    expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    expect(actions.join("\n")).toContain("does not parse");
    expect(actions.filter(a => a.startsWith("DEPLOYED:"))).toEqual([]);
  });

  test("#1047 review: settings.local.json that parses to a non-object is refused too", () => {
    // `JSON.parse("null")` and `JSON.parse("[]")` both succeed, and both take
    // `settings.hooks = {}` without complaint — so the parse succeeding does
    // not establish that the file is a settings object.
    const settingsPath = join(consumerDir, ".claude", "settings.local.json");
    mkdirSync(join(consumerDir, ".claude"), { recursive: true });
    for (const payload of ["null", "[]", '"a string"']) {
      writeFileSync(settingsPath, payload);
      const actions: string[] = [];
      deployHooksToConsumers(tmpRoot, actions);
      expect(readFileSync(settingsPath, "utf-8"), payload).toBe(payload);
      expect(actions.join("\n"), payload).toContain("is not an object");
    }
  });

  test("#1047 review: a mention of a hook's name does not shadow its deployment", () => {
    // `h.command.includes(hook.name)` matched anywhere in the string, so a
    // consumer's own unrelated entry could suppress one of our hooks and the
    // run would report success — "already deployed" and "deployed" produce
    // the same absence of a complaint.
    const settingsPath = join(consumerDir, ".claude", "settings.local.json");
    mkdirSync(join(consumerDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ command: "bun ./scripts/their-own-lint.ts # unrelated to DeployedGuard" }],
        },
      }),
    );

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(executingHookCommands(settings, "PreToolUse")).toEqual([
      deployedCommand("DeployedGuard"),
    ]);
    // Theirs is untouched — still exactly the entry they wrote, in the shape
    // they wrote it. The repair below only removes entries that EXECUTE one
    // of our hooks, and this one executes their own script.
    expect(settings.hooks.PreToolUse).toContainEqual({
      command: "bun ./scripts/their-own-lint.ts # unrelated to DeployedGuard",
    });
  });

  test("a second consumer deployment run is idempotent", () => {
    deployHooksToConsumers(tmpRoot, []);
    const second: string[] = [];
    deployHooksToConsumers(tmpRoot, second);

    const settings = JSON.parse(
      readFileSync(join(consumerDir, ".claude", "settings.local.json"), "utf-8")
    );
    // One matcher group, one leaf in it. A re-scaffold that appended a second
    // group per run would still satisfy a command-count assertion on the
    // first run and drift on every one after, so both are asserted (#1088).
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(executingHookCommands(settings, "PreToolUse")).toEqual([
      deployedCommand("DeployedGuard"),
    ]);
    expect(second.join("\n")).toContain("already deployed");
  });

  test("the monolith path still deploys to a consumer (no regression)", () => {
    const monoRoot = join(ROOT, "test", ".tmp-consumer-monolith");
    rmSync(monoRoot, { recursive: true, force: true });
    mkdirSync(join(monoRoot, ".claude"), { recursive: true });
    mkdirSync(join(monoRoot, "consumer-b"), { recursive: true });
    installConsumerHook(join(monoRoot, "consumer-b"), "DeployedGuard");
    writeFileSync(
      join(monoRoot, ".claude", "rungate.json"),
      JSON.stringify({
        project: "mono",
        consumers: ["consumer-b"],
        hooks: [
          {
            name: "DeployedGuard",
            hookFor: "PreToolUse",
            command: "bun ${RUNGATE_HOOKS_DIR}/DeployedGuard.hook.ts",
            enabled: true,
            deployToConsumers: true,
          },
        ],
      })
    );

    try {
      deployHooksToConsumers(monoRoot, []);
      const settings = JSON.parse(
        readFileSync(join(monoRoot, "consumer-b", ".claude", "settings.local.json"), "utf-8")
      );
      expect(executingHookCommands(settings, "PreToolUse")).toEqual([
        deployedCommand("DeployedGuard"),
      ]);
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
    }
  });
});

/**
 * #1088 — the deployed entry must be a hook Claude Code executes, and it must
 * point at a file the consumer has.
 *
 * Every assertion here goes through `executingHookCommands`, which reads the
 * schema Claude Code reads: event → matcher group → `hooks[]` →
 * `{ type, command }`. Deliberately NOT through `settingsCommands` in
 * `lib/hook-trees.ts` — that walk collects any `command` string at any depth,
 * so it accepted the broken shape, and AC-1 below asserts the two readers
 * DISAGREE on it. A test written through the permissive reader is the reason
 * twelve inert guards shipped.
 *
 * ## What was broken to prove these can fail
 *
 * Every count predicted before the battery ran, naming WHICH cases each row
 * should redden, and the baseline row read first. Mutations to
 * `lib/scaffold/steps.ts`; suite is this file, 28 cases.
 *
 * | Row | Mutation | Kind | Predicted | Measured |
 * |---|---|---|---|---|
 * | B | none | baseline | 0 | **0** |
 * | M1 | write the pre-#1088 flat `{matcher, command}` instead of the group | control | 7 | **7** |
 * | M2 | drop the `existsSync` refusal | witness | 2 | **2** |
 * | M3 | resolve both spellings from the HARNESS root (defect #2 itself) | control | 11 | **12** |
 * | M4 | read registrations off the flat shape again | witness | 3 | **3** |
 * | M5 | drop the relative-consumer containment refusal | witness | 1 | **1** |
 * | M6 | drop `type !== "command"` from `executingHookCommands` | witness | 1 | **1** |
 *
 * M1 and M3 are controls: each deletes a whole path, so a large number was
 * expected and carries little information. M2, M4, M5 and M6 are witnesses —
 * one decision each, and the named cases are the evidence.
 *
 * **M3 came back one ABOVE its prediction**, which is the direction worth
 * reporting. The extra case is AC-2-absent, predicted green because the hook
 * is missing either way; it reddens because that case also asserts WHICH
 * path the refusal named, and under M3 it names the harness's. The
 * prediction was wrong about the case, not the mutation.
 *
 * **The cheapest wrong fix, named before the battery:** add `type:
 * "command"` to the bare entry and stop — `{ matcher, type, command }`
 * pushed into the event array. It is what a reader of the issue title
 * reaches for and it still does not run, because there is no `hooks[]`
 * wrapper. Measured: **7 red**, the same seven as M1. AC-1's structural
 * assertion is what refuses it.
 */
describe("#1088: a deployed hook is one Claude Code can run", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-1088-consumer");
  const consumerDir = join(tmpRoot, "consumer-a");
  const settingsPath = join(consumerDir, ".claude", "settings.local.json");

  /** `hooks.json` holding exactly the entries a case needs. */
  function registry(entries: unknown[]): void {
    writeFileSync(
      join(tmpRoot, ".claude", "rungate", "hooks.json"),
      JSON.stringify(entries, null, 2),
    );
  }

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, ".claude", "rungate"), { recursive: true });
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      join(tmpRoot, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "shape", consumers: ["consumer-a"] }),
    );
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("AC-1: the written entry is a matcher group holding a typed command leaf", () => {
    installConsumerHook(consumerDir, "ShapeGuard");
    registry([
      {
        name: "ShapeGuard",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/ShapeGuard.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    deployHooksToConsumers(tmpRoot, []);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // The executing reading, which is the one that decides whether the guard
    // ever runs.
    expect(executingHookCommands(settings, "PreToolUse")).toEqual([
      deployedCommand("ShapeGuard"),
    ]);
    // And the literal structure, because a reader can be wrong in the same
    // direction as the writer. Both levels, spelled out.
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: deployedCommand("ShapeGuard") }],
      },
    ]);
  });

  test("AC-1 control: the pre-#1088 shape is accepted by hook-trees and rejected here", () => {
    // The separating case, and the reason this issue existed. Both readers
    // are run over ONE document; if they ever agree on it, the test that
    // would have caught the defect has stopped being able to.
    const broken = { hooks: { PreToolUse: [{ matcher: "Bash", command: "bun /x/ShapeGuard.hook.ts" }] } };

    expect(settingsCommands([JSON.stringify(broken)])).toEqual(["bun /x/ShapeGuard.hook.ts"]);
    expect(executingHookCommands(broken, "PreToolUse")).toEqual([]);

    // Each missing level alone is enough to make it inert, so each is its own
    // case rather than one document missing all of them.
    const noType = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "bun /x/A.hook.ts" }] }] } };
    expect(settingsCommands([JSON.stringify(noType)])).toEqual(["bun /x/A.hook.ts"]);
    expect(executingHookCommands(noType, "PreToolUse")).toEqual([]);

    const ok = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bun /x/B.hook.ts" }] }] } };
    expect(executingHookCommands(ok, "PreToolUse")).toEqual(["bun /x/B.hook.ts"]);
  });

  test("AC-1: an event with no matcher gets a group with no matcher key", () => {
    // `~/.claude/settings.json` holds `{ "hooks": [...] }` with the key
    // OMITTED for SessionStart, SubagentStop and PostCompact — not set to
    // null and not set to an empty string, either of which is a matcher that
    // matches nothing.
    installConsumerHook(consumerDir, "StartGuard");
    registry([
      {
        name: "StartGuard",
        hookFor: "SessionStart",
        command: "bun ${RUNGATE_HOOKS_DIR}/StartGuard.hook.ts",
        enabled: true,
        deployToConsumers: true,
      },
    ]);

    deployHooksToConsumers(tmpRoot, []);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(Object.keys(settings.hooks.SessionStart[0])).toEqual(["hooks"]);
    expect(executingHookCommands(settings, "SessionStart")).toEqual([
      deployedCommand("StartGuard"),
    ]);
  });

  test("AC-2: a hook whose file the consumer does not have is not written, and is named", () => {
    // No `installConsumerHook`. This is every consumer that installed rungate
    // from npm under the old code: the command was built from the HARNESS
    // root, so it named a directory on the harness author's machine, nothing
    // checked it, and the run reported DEPLOYED.
    registry([
      {
        name: "AbsentGuard",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/AbsentGuard.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    expect(existsSync(settingsPath), "nothing should have been written").toBe(false);
    expect(actions.filter(a => a.startsWith("DEPLOYED:"))).toEqual([]);
    const unmeasured = actions.filter(a => a.startsWith("UNMEASURED:"));
    expect(unmeasured).toHaveLength(1);
    // The hook AND the path, because "something was missing" is not a
    // reading anyone can act on.
    expect(unmeasured[0]).toContain("AbsentGuard");
    expect(unmeasured[0]).toContain(consumerHooksDir(consumerDir).disk);
  });

  test("AC-2: the path checked is the consumer's, not the harness's", () => {
    // The pair that varies only WHERE the file is. Installing it under the
    // harness root — which is what the old command named — must not satisfy
    // the check, or the fix is a rename.
    mkdirSync(join(tmpRoot, "hooks"), { recursive: true });
    writeFileSync(join(tmpRoot, "hooks", "HarnessSide.hook.ts"), "export {};\n");
    registry([
      {
        name: "HarnessSide",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/HarnessSide.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    expect(actions.filter(a => a.startsWith("UNMEASURED:"))).toHaveLength(1);
    expect(existsSync(settingsPath)).toBe(false);
  });

  test("AC-4: an entry naming the hook at a different path is a CONFLICT, not a deployment", () => {
    installConsumerHook(consumerDir, "ShapeGuard");
    mkdirSync(join(consumerDir, ".claude"), { recursive: true });
    const theirs = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "bun ./vendor/ShapeGuard.hook.ts" }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(theirs));
    registry([
      {
        name: "ShapeGuard",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/ShapeGuard.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    const conflicts = actions.filter(a => a.startsWith("CONFLICT:"));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("./vendor/ShapeGuard.hook.ts");
    expect(actions.filter(a => a.startsWith("DEPLOYED:"))).toEqual([]);
    // Their registration is the only one, and the bytes did not move.
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(theirs);
  });

  test("#1088: an inert entry already shipped by the broken deployment is replaced", () => {
    // Without this, every consumer that received the old shape is stuck:
    // the inert entry is read as "already deployed" and the working one is
    // never written, forever, while the run reports success.
    installConsumerHook(consumerDir, "ShapeGuard");
    mkdirSync(join(consumerDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            // What the old code wrote, with the old harness-rooted path.
            { matcher: "Bash", command: "bun /harness/author/hooks/ShapeGuard.hook.ts" },
            // The consumer's own entry, in the same inert shape. Not ours,
            // so it must survive.
            { matcher: "Bash", command: "bun ./scripts/theirs.sh" },
          ],
        },
      }),
    );
    registry([
      {
        name: "ShapeGuard",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/ShapeGuard.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    const actions: string[] = [];
    deployHooksToConsumers(tmpRoot, actions);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(executingHookCommands(settings, "PreToolUse")).toEqual([
      deployedCommand("ShapeGuard"),
    ]);
    expect(JSON.stringify(settings)).not.toContain("/harness/author/hooks/");
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Bash",
      command: "bun ./scripts/theirs.sh",
    });
    expect(actions.some(a => a.startsWith("REPAIRED:"))).toBe(true);
  });

  test("#1088 hardening: a relative consumer path may not escape the repository", () => {
    const escapee = join(ROOT, "test", ".tmp-1088-escapee");
    rmSync(escapee, { recursive: true, force: true });
    mkdirSync(escapee, { recursive: true });
    writeFileSync(
      join(tmpRoot, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "shape", consumers: ["../.tmp-1088-escapee"] }),
    );
    installConsumerHook(escapee, "ShapeGuard");
    registry([
      {
        name: "ShapeGuard",
        hookFor: "PreToolUse",
        command: "bun ${RUNGATE_HOOKS_DIR}/ShapeGuard.hook.ts",
        enabled: true,
        matcher: "Bash",
        deployToConsumers: true,
      },
    ]);

    try {
      const actions: string[] = [];
      deployHooksToConsumers(tmpRoot, actions);

      // The bytes, not the label: a refusal that still wrote would emit a
      // SKIP and pass a label-only check.
      expect(existsSync(join(escapee, ".claude"))).toBe(false);
      expect(actions.join("\n")).toContain("must stay inside");
    } finally {
      rmSync(escapee, { recursive: true, force: true });
    }
  });
});

describe("AC-11: the standalone config scaffold writes the same populated files", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-standalone");

  beforeEach(() => greenfield(tmpRoot, "standalone-proj"));
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("scaffold-rungate-config.ts writes >= 3 role entries and >= 3 hooks", () => {
    execFileSync("bun", [join(ROOT, "scripts", "scaffold-rungate-config.ts"), tmpRoot], {
      encoding: "utf-8",
      timeout: 60_000,
    });

    const dir = join(tmpRoot, ".claude", "rungate");
    const roles = JSON.parse(readFileSync(join(dir, "roles.json"), "utf-8"));
    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf-8"));

    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(3);
    expect(hooks.length).toBeGreaterThanOrEqual(3);
  });

  test("both emission sites agree on the roles they write", () => {
    execFileSync("bun", [join(ROOT, "scripts", "scaffold-rungate-config.ts"), tmpRoot], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    const standaloneRoles = JSON.parse(
      readFileSync(join(tmpRoot, ".claude", "rungate", "roles.json"), "utf-8")
    );

    const mainRoot = join(ROOT, "test", ".tmp-greenfield-standalone-cmp");
    greenfield(mainRoot, "standalone-proj");
    try {
      generateOrAuditProjectHarness(mainRoot, []);
      const mainRoles = JSON.parse(
        readFileSync(join(mainRoot, ".claude", "rungate", "roles.json"), "utf-8")
      );
      // Two scaffold entry points writing DIFFERENT role sets is the #70 class
      // of bug one layer up: whichever one ran last decides what the project is.
      expect(Object.keys(standaloneRoles).sort()).toEqual(Object.keys(mainRoles).sort());
    } finally {
      rmSync(mainRoot, { recursive: true, force: true });
    }
  });
});

describe("the migration path is untouched by the greenfield defaults", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-split");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "splitme" }));
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("splitting a monolith preserves its roles and hooks EXACTLY — no defaults injected", () => {
    writeFileSync(
      join(tmpRoot, ".claude", "rungate.json"),
      JSON.stringify({
        project: "splitme",
        roles: { onlyrole: { brief: ".claude/agents/onlyrole.md", standardTask: "do a thing" } },
        hooks: [{ name: "OnlyHook", hookFor: "PreToolUse", command: "bun x", enabled: true }],
      })
    );

    generateOrAuditProjectHarness(tmpRoot, []);

    const dir = join(tmpRoot, ".claude", "rungate");
    const roles = JSON.parse(readFileSync(join(dir, "roles.json"), "utf-8"));
    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf-8"));
    expect(Object.keys(roles)).toEqual(["onlyrole"]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("OnlyHook");
  });
});
