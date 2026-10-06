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
import { generateOrAuditProjectHarness, deployHooksToConsumers } from "../lib/scaffold/steps";
import { loadRungateConfig } from "../lib/config-loader";

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

describe("AC-8: hooks.json drives consumer hook deployment under the directory layout", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-greenfield-consumer");
  const consumerDir = join(tmpRoot, "consumer-a");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, ".claude", "rungate"), { recursive: true });
    mkdirSync(consumerDir, { recursive: true });
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
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].command).toBe(
      `bun ${join(tmpRoot, "hooks")}/DeployedGuard.hook.ts`
    );
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(actions.some(a => a.startsWith("DEPLOYED:"))).toBe(true);
  });

  test("consumer deployment skips hooks not marked deployToConsumers", () => {
    deployHooksToConsumers(tmpRoot, []);

    const settings = JSON.parse(
      readFileSync(join(consumerDir, ".claude", "settings.local.json"), "utf-8")
    );
    const commands = settings.hooks.PreToolUse.map((h: any) => h.command).join(" ");
    expect(commands).not.toContain("HarnessOnly");
  });

  test("a second consumer deployment run is idempotent", () => {
    deployHooksToConsumers(tmpRoot, []);
    deployHooksToConsumers(tmpRoot, []);

    const settings = JSON.parse(
      readFileSync(join(consumerDir, ".claude", "settings.local.json"), "utf-8")
    );
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test("the monolith path still deploys to a consumer (no regression)", () => {
    const monoRoot = join(ROOT, "test", ".tmp-consumer-monolith");
    rmSync(monoRoot, { recursive: true, force: true });
    mkdirSync(join(monoRoot, ".claude"), { recursive: true });
    mkdirSync(join(monoRoot, "consumer-b"), { recursive: true });
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
      expect(settings.hooks.PreToolUse).toHaveLength(1);
    } finally {
      rmSync(monoRoot, { recursive: true, force: true });
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
