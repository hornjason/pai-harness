import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

/**
 * #713 — the PRODUCT-classified hooks, migrated from `~/.pai/hooks` into this
 * repository's `hooks/`.
 *
 * `docs/research/hook-tree-classification.md` named nine hooks PRODUCT. Seven
 * are migrated here; `ForceBypassPermissions` and `HookIntegrity` are not, and
 * the PR body says why for each.
 *
 * **Why these cases execute the hooks instead of reading them.** The cheapest
 * wrong fix for "migrate a hook" is `cp` plus a test asserting the file
 * exists, and that test passes against a file whose entire body is
 * `process.exit(0)`. The last `describe` in this file runs exactly that,
 * against exactly such a stub, so the claim is demonstrated rather than
 * asserted — see `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Each case below is a WITNESS (the hook acts) or a CONTROL (the hook stays
 * out of the way). A migration proved only by witnesses would pass for a hook
 * that blocks everything it is shown.
 */

const HOOKS = resolve(import.meta.dir, "..", "hooks");

/** The seven files this issue brings into the package. */
const MIGRATED = [
  "ActionVerificationGate.hook.ts",
  "BashWriteGuard.hook.ts",
  "DocHygiene.hook.ts",
  "GateResultProtection.hook.ts",
  "HarnessAFKGate.hook.ts",
  "SkillGuard.hook.ts",
  "TeamInit.hook.ts",
];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a hook the way Claude Code runs it: a `bun` subprocess fed JSON on
 * stdin. `env` entries set to `undefined` are REMOVED rather than blanked —
 * an absent variable and an empty one are different inputs, and TeamInit's
 * whole guard turns on which one it got.
 */
function runHook(file: string, stdin: string, env: Record<string, string | undefined> = {}): Run {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const r = spawnSync("bun", [join(HOOKS, file)], {
    input: stdin,
    encoding: "utf-8",
    env: childEnv,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), `rg713-${prefix}-`));

describe("#713: every migrated hook loads and runs under bun", () => {
  // Not the behavioural claim — the floor under it. A hook with a syntax
  // error or an unresolvable import fails here with its own message instead
  // of surfacing as a confusing empty stdout in each case below.
  test.each(MIGRATED)("%s is present and exits cleanly on empty input", file => {
    expect(existsSync(join(HOOKS, file)), `${file} was not migrated`).toBe(true);
    const r = runHook(file, "{}", { CLAUDE_CODE_SESSION_ID: undefined });
    expect(r.stderr).not.toContain("error: Cannot find module");
    expect(r.stderr).not.toContain("SyntaxError");
  });

  test("no migrated hook imports a PAI-owned absolute path", () => {
    // The portability property, asserted over the migrated population rather
    // than trusted from the classification doc. `./lib/paths` is allowed —
    // it resolves RUNGATE_WORK_DIR / PAI_DIR and falls back to directories
    // Claude Code and rungate own. A literal `~/.pai` or `.pai/hooks` is not.
    const offenders = MIGRATED.filter(f =>
      /\.pai\/|paiPath\(/.test(readFileSync(join(HOOKS, f), "utf-8")),
    );
    expect(offenders, "a migrated hook still reaches into the PAI tree").toEqual([]);
  });
});

describe("#713 SkillGuard: blocks the position-bias false positive only", () => {
  test("WITNESS: keybindings-help is blocked", () => {
    const r = runHook("SkillGuard.hook.ts", '{"tool_name":"Skill","tool_input":{"skill":"keybindings-help"}}');
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("CONTROL: an ordinary skill passes silently", () => {
    const r = runHook("SkillGuard.hook.ts", '{"tool_name":"Skill","tool_input":{"skill":"tdd"}}');
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("#713 ActionVerificationGate: reminds after state-changing commands", () => {
  const payload = (command: string, output: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, tool_response: { output } });

  test("WITNESS: a successful git push produces a verify reminder", () => {
    const r = runHook("ActionVerificationGate.hook.ts", payload("git push origin HEAD", "done"));
    expect(JSON.parse(r.stdout).message).toContain("VERIFY BEFORE REPORTING");
  });

  test("CONTROL: a read-only command produces nothing", () => {
    const r = runHook("ActionVerificationGate.hook.ts", payload("ls -la", "ok"));
    expect(r.stdout.trim()).toBe("");
  });

  test("CONTROL: a FAILED push produces nothing — no point verifying a broken deploy", () => {
    const r = runHook("ActionVerificationGate.hook.ts", payload("git push origin HEAD", "error: rejected"));
    expect(r.stdout.trim()).toBe("");
  });
});

describe("#713 BashWriteGuard: protects gate artifacts and hook files", () => {
  const cmd = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  test("WITNESS: a redirect into workflow-state.json is blocked", () => {
    const r = runHook("BashWriteGuard.hook.ts", cmd("echo x >> /some/workflow-state.json"));
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("WITNESS: a redirect into a hook file is blocked", () => {
    const r = runHook("BashWriteGuard.hook.ts", cmd("echo x > hooks/Evil.hook.ts"));
    expect(JSON.parse(r.stdout).reason).toContain("Hook integrity");
  });

  test("WITNESS: chflags on a hook file is blocked", () => {
    const r = runHook("BashWriteGuard.hook.ts", cmd("chflags nouchg hooks/SkillGuard.hook.ts"));
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("CONTROL: an ordinary command passes", () => {
    expect(runHook("BashWriteGuard.hook.ts", cmd("ls -la")).stdout.trim()).toBe("");
  });

  test("CONTROL: a read-only command NAMING a protected file passes (#474)", () => {
    // The false-positive tuning. Without it the guard blocks `gh` and `grep`
    // for mentioning the filename, which is how a guard gets switched off.
    expect(runHook("BashWriteGuard.hook.ts", cmd("grep -n phase workflow-state.json")).stdout.trim()).toBe("");
  });
});

describe("#713 GateResultProtection: only the gate runner writes gate results", () => {
  test("WITNESS: a Write setting a gate result is blocked", () => {
    const r = runHook(
      "GateResultProtection.hook.ts",
      JSON.stringify({
        tool_name: "Write",
        tool_input: {
          file_path: "/x/workflow-state.json",
          content: JSON.stringify({ gates: { verify: { result: "PASS" } } }),
        },
      }),
    );
    expect(JSON.parse(r.stdout).reason).toContain("gate-runner.ts");
  });

  test("WITNESS: an Edit setting phase DONE is blocked", () => {
    const r = runHook(
      "GateResultProtection.hook.ts",
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/x/workflow-state.json", new_string: '"phase": "DONE"' },
      }),
    );
    expect(JSON.parse(r.stdout).reason).toContain("DONE");
  });

  test("CONTROL: a non-gate edit to the same file passes", () => {
    const r = runHook(
      "GateResultProtection.hook.ts",
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "/x/workflow-state.json", new_string: '"phase": "BUILD"' },
      }),
    );
    expect(r.stdout.trim()).toBe("");
  });

  test("CONTROL: a different file passes", () => {
    const r = runHook(
      "GateResultProtection.hook.ts",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/notes.md", content: "hi" } }),
    );
    expect(r.stdout.trim()).toBe("");
  });
});

describe("#713 HarnessAFKGate: blocks questions only in post-approval phases", () => {
  function workDirWithPhase(phase: string): string {
    const dir = scratch("afk");
    mkdirSync(join(dir, "slug"), { recursive: true });
    writeFileSync(join(dir, "slug", "PRD.md"), `---\nphase: ${phase}\n---\n# PRD\n`);
    return dir;
  }

  test("WITNESS: phase build blocks with exit 2", () => {
    const dir = workDirWithPhase("build");
    try {
      const r = runHook("HarnessAFKGate.hook.ts", "{}", { RUNGATE_WORK_DIR: dir });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.stdout).error).toContain("HARNESS AFK GATE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: phase plan allows", () => {
    const dir = workDirWithPhase("plan");
    try {
      expect(runHook("HarnessAFKGate.hook.ts", "{}", { RUNGATE_WORK_DIR: dir }).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: no PRD at all allows — an empty work dir is not a harness run", () => {
    const dir = scratch("afk-empty");
    try {
      expect(runHook("HarnessAFKGate.hook.ts", "{}", { RUNGATE_WORK_DIR: dir }).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#713 TeamInit: creates the team config Claude Code expects", () => {
  test("WITNESS: a session id produces a config at teams/session-<short>/", () => {
    const dir = scratch("team");
    try {
      const r = runHook("TeamInit.hook.ts", "", {
        CLAUDE_CODE_SESSION_ID: "abcdef1234567890",
        PAI_DIR: dir,
      });
      expect(r.code).toBe(0);
      const cfg = JSON.parse(readFileSync(join(dir, "teams", "session-abcdef12", "config.json"), "utf-8"));
      expect(cfg.session_id).toBe("session-abcdef12");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: no session id writes nothing at all", () => {
    // Removed from the environment, not blanked. This agent's own session
    // exports CLAUDE_CODE_SESSION_ID, so a test that merely failed to set it
    // would inherit one and silently measure the WITNESS case again.
    const dir = scratch("team-none");
    try {
      runHook("TeamInit.hook.ts", "", { CLAUDE_CODE_SESSION_ID: undefined, PAI_DIR: dir });
      expect(existsSync(join(dir, "teams"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a second run leaves a valid config byte-identical", () => {
    const dir = scratch("team-idem");
    try {
      const env = { CLAUDE_CODE_SESSION_ID: "abcdef1234567890", PAI_DIR: dir };
      runHook("TeamInit.hook.ts", "", env);
      const path = join(dir, "teams", "session-abcdef12", "config.json");
      const first = readFileSync(path, "utf-8");
      runHook("TeamInit.hook.ts", "", env);
      expect(readFileSync(path, "utf-8")).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#713 DocHygiene: stamps through lib/frontmatter, add-only", () => {
  /** A doc whose path trips none of the hook's SKIP_PATTERNS. */
  function doc(contents: string): { dir: string; path: string; payload: string } {
    const dir = scratch("dh");
    const path = join(dir, "GUIDE.md");
    writeFileSync(path, contents);
    // If the scratch root ever lands under `/tmp/`, the hook SKIPS it and
    // every stamp case below would go green having stamped nothing. Asserted
    // so that configuration change is red instead of invisible.
    expect(path.includes("/tmp/"), "scratch root is skipped by the hook itself").toBe(false);
    return { dir, path, payload: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }) };
  }

  test("WITNESS: a doc with no frontmatter gets the four required fields", () => {
    const { dir, path, payload } = doc("# My Doc\n\nbody\n");
    try {
      runHook("DocHygiene.hook.ts", payload);
      const out = readFileSync(path, "utf-8");
      for (const key of ["doc-type:", "status:", "owner:", "updated:"]) expect(out).toContain(key);
      expect(out, "the body must survive the stamp").toContain("body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WITNESS: an existing field is kept, not overwritten — add-only (#299)", () => {
    const { dir, path, payload } = doc("---\ndoc-type: adr\nowner: someone-else\n---\n\nbody\n");
    try {
      runHook("DocHygiene.hook.ts", payload);
      const out = readFileSync(path, "utf-8");
      expect(out).toContain("doc-type: adr");
      expect(out).toContain("owner: someone-else");
      expect(out, "the absent fields are the ones that get added").toContain("status: active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a second run changes nothing", () => {
    const { dir, path, payload } = doc("# My Doc\n\nbody\n");
    try {
      runHook("DocHygiene.hook.ts", payload);
      const first = readFileSync(path, "utf-8");
      runHook("DocHygiene.hook.ts", payload);
      expect(readFileSync(path, "utf-8")).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a non-markdown file is untouched", () => {
    const dir = scratch("dh-nonmd");
    try {
      const path = join(dir, "data.json");
      writeFileSync(path, "{}\n");
      runHook("DocHygiene.hook.ts", JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }));
      expect(readFileSync(path, "utf-8")).toBe("{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#713: the cheapest wrong fix, run rather than described", () => {
  test("an existence-only test passes against a hook whose body is process.exit(0)", () => {
    // `cp` the file and assert it exists. This is the migration test somebody
    // writes when the deadline is close, and here it is, passing against a
    // hook that does nothing whatsoever.
    const dir = mkdtempSync(join(tmpdir(), "rg713-stub-"));
    try {
      const stub = join(dir, "SkillGuard.hook.ts");
      writeFileSync(stub, "process.exit(0)\n");

      // The cheap assertion. It passes.
      expect(existsSync(stub)).toBe(true);

      // The behavioural assertion this file uses instead, same input, same
      // stub: the stub emits nothing, so it SEPARATES them.
      const input = '{"tool_name":"Skill","tool_input":{"skill":"keybindings-help"}}';
      const stubRun = spawnSync("bun", [stub], { input, encoding: "utf-8" });
      expect(stubRun.stdout.trim(), "the stub must produce no decision").toBe("");

      // And the migrated hook does emit one. Both halves measured, so the
      // zero above is a reading rather than an absence.
      const real = runHook("SkillGuard.hook.ts", input);
      expect(JSON.parse(real.stdout).decision).toBe("block");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
