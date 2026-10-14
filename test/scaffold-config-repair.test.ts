/**
 * Covers SC-849, SC-850, SC-851, SC-852 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md).
 *
 * #121 — #75 stopped NEW projects being scaffolded with `roles: {}` /
 * `hooks: []`. It did nothing for projects already in that state, and those
 * projects were told they were healthy.
 *
 * `generateOrAuditProjectHarness` has three branches. A project scaffolded
 * before #75 has `.claude/rungate/config.json`, so every re-scaffold takes
 * the audit branch — and `auditExistingConfig` was not even passed the
 * project root, so it could not read `roles.json` or `hooks.json` if it
 * wanted to. It reported `AUDITED: rungate.json (aligned with code)` over
 * zero roles and zero hooks.
 *
 * That is the shape `.claude/rules/checks-must-be-able-to-fail.md` is about:
 * a check that passes because of what it never looked at. Worse here than
 * usual, because the output is not silence but an active assertion of
 * health — someone re-scaffolding to FIX this reads that line as
 * confirmation there is nothing to fix.
 *
 * SC-852 is the control arm the issue asked for by name. Repair that
 * overwrites a populated config is not repair, and SC-851 passes trivially
 * for a `--fix` that rewrites everything.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateOrAuditProjectHarness } from "../lib/scaffold/steps";
import { buildDefaultRoles, buildDefaultHooks } from "../lib/scaffold/defaults";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  roles: () => any;
  hooks: () => any;
}

/** A project shaped exactly like the one in #121's reproduction. */
function project(roles: string, hooks: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cfg-repair-"));
  scratch.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"x","scripts":{"test":"bun test"}}');
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(root, ".claude", "rungate", "config.json"), '{"project":"x","repo":"o/x"}');
  writeFileSync(join(root, ".claude", "rungate", "roles.json"), roles);
  writeFileSync(join(root, ".claude", "rungate", "hooks.json"), hooks);
  execSync(`git init -q "${root}"`, { stdio: "pipe" });
  const read = (f: string) => () =>
    JSON.parse(readFileSync(join(root, ".claude", "rungate", f), "utf-8"));
  return { root, roles: read("roles.json"), hooks: read("hooks.json") };
}

function audit(root: string): string[] {
  const actions: string[] = [];
  generateOrAuditProjectHarness(root, actions);
  return actions;
}

const ALIGNED = /^AUDITED: rungate\.json \(aligned with code\)$/;

describe("#121 SC-849: an empty roles.json is never reported as aligned", () => {
  test("the exact state #121 reproduced is reported, not passed over in silence", () => {
    // The pre-fix output was one line: `AUDITED: rungate.json (aligned with
    // code)` over zero roles and zero hooks. It now repairs them and SAYS
    // SO — and after the repair, "aligned" is TRUE, so the assertion is on
    // the report being made rather than on the word being absent. A first
    // draft asserted the absence and failed against the correct output.
    const p = project("{}", "[]");
    const report = audit(p.root).join("\n");
    expect(report, "the run was silent about two empty config files")
      .toMatch(/^REPAIRED: \.claude\/rungate\/roles\.json/m);
    expect(report).toMatch(/^REPAIRED: \.claude\/rungate\/hooks\.json/m);
  });

  test("a sidecar the repair DECLINES to touch is never reported as aligned", () => {
    // The path where the audit's own check is load-bearing. An unreadable
    // file is not overwritten — #370 and #208 settled that — so the repair
    // steps aside, and if the audit then said "aligned" the project would
    // be told it is healthy with a broken config on disk. That is #121
    // reintroduced through the one door the repair cannot close.
    const p = project("{ not json", "[]");
    const report = audit(p.root).join("\n");
    expect(report).not.toMatch(new RegExp(ALIGNED.source, "m"));
    expect(report, "the refusal was not reported")
      .toMatch(/^PRESERVED: \.claude\/rungate\/roles\.json \(unreadable/m);
    expect(report, "the audit did not flag the unreadable file as a gap")
      .toMatch(/roles\.json is unreadable/);
    // And it really was left alone.
    expect(readFileSync(join(p.root, ".claude", "rungate", "roles.json"), "utf-8"))
      .toBe("{ not json");
  });

  test("an empty roles.json is named, not merely counted", () => {
    const p = project("{}", '[{"event":"x"}]');
    const report = audit(p.root).join("\n");
    expect(report, "the report does not say WHICH file is empty").toMatch(/roles\.json/);
  });

  test("an empty hooks.json is named too, and separately", () => {
    // Both halves, because a check that only ever looks at roles.json is
    // satisfied by the case above and blind to half the defect.
    const p = project(JSON.stringify(buildDefaultRoles()), "[]");
    const report = audit(p.root).join("\n");
    expect(report, "an empty hooks.json went unreported").toMatch(/hooks\.json/);
  });

  test("a populated config IS reported as aligned — the detector is not stuck on", () => {
    // The other direction. A gap reporter that always reports a gap passes
    // all three cases above and is useless.
    const p = project(
      JSON.stringify(buildDefaultRoles()),
      JSON.stringify(buildDefaultHooks()),
    );
    expect(audit(p.root).join("\n")).toMatch(new RegExp(ALIGNED.source, "m"));
  });
});

describe("#121 SC-850: --fix repairs an empty config from the greenfield defaults", () => {
  test("empty roles and hooks are populated", () => {
    const p = project("{}", "[]");
    audit(p.root);
    expect(Object.keys(p.roles()).length, "roles.json is still empty").toBeGreaterThanOrEqual(3);
    expect(p.hooks().length, "hooks.json is still empty").toBeGreaterThanOrEqual(3);
  });

  test("the repair uses the SAME defaults the greenfield path uses", () => {
    // Not "some roles appeared". A second source of defaults would drift
    // from the greenfield one and nothing would notice — the two-deciders
    // shape this repo keeps finding.
    const p = project("{}", "[]");
    audit(p.root);
    expect(p.roles()).toEqual(buildDefaultRoles());
    expect(p.hooks()).toEqual(buildDefaultHooks());
  });

  test("after repair, a second run reports aligned", () => {
    // Idempotence, and the thing a maintainer actually experiences: run it
    // twice and the second run is quiet.
    const p = project("{}", "[]");
    audit(p.root);
    expect(audit(p.root).join("\n")).toMatch(new RegExp(ALIGNED.source, "m"));
  });
});

describe("#121 SC-851: repair must not become a silent overwrite", () => {
  test("a populated roles.json comes back byte-identical", () => {
    // The control arm #121 asked for by name. Without it, SC-850 passes for
    // a `--fix` that rewrites every config file in the project, which is
    // the opposite failure and the worse one.
    const mine = JSON.stringify({ marcus: { model: "opus", custom: true } }, null, 2);
    const myHooks = JSON.stringify([{ event: "PreToolUse", command: "mine.ts" }], null, 2);
    const p = project(mine, myHooks);
    const before = readFileSync(join(p.root, ".claude", "rungate", "roles.json"), "utf-8");
    const beforeHooks = readFileSync(join(p.root, ".claude", "rungate", "hooks.json"), "utf-8");

    audit(p.root);

    expect(readFileSync(join(p.root, ".claude", "rungate", "roles.json"), "utf-8"))
      .toBe(before);
    expect(readFileSync(join(p.root, ".claude", "rungate", "hooks.json"), "utf-8"))
      .toBe(beforeHooks);
  });

  test("one empty file is repaired without touching the populated one", () => {
    // The mixed case, which neither all-empty nor all-populated reaches.
    const myHooks = JSON.stringify([{ event: "PreToolUse", command: "mine.ts" }], null, 2);
    const p = project("{}", myHooks);
    const beforeHooks = readFileSync(join(p.root, ".claude", "rungate", "hooks.json"), "utf-8");

    audit(p.root);

    expect(Object.keys(p.roles()).length, "the empty file was not repaired")
      .toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(p.root, ".claude", "rungate", "hooks.json"), "utf-8"),
      "the populated file was overwritten").toBe(beforeHooks);
  });
});

describe("#121 SC-852: the repaired config reads back through the real loader", () => {
  test("loadRungateConfig sees the repaired roles and hooks", async () => {
    // SC-5 generalised off `~/Projects/agentgrit`. Asserting the file on
    // disk proves the scaffold wrote JSON; asserting the LOADER proves the
    // thing that consumes it can use what was written, which is the claim
    // #121 actually makes.
    const { loadRungateConfig } = await import("../lib/config-loader");
    const p = project("{}", "[]");
    audit(p.root);
    const cfg = loadRungateConfig(p.root);
    expect(Object.keys(cfg?.roles ?? {}).length).toBeGreaterThanOrEqual(3);
    expect((cfg?.hooks ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
