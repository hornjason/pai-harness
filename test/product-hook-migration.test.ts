import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
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

const ROOT = resolve(import.meta.dir, "..");
const HOOKS = join(ROOT, "hooks");

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

/**
 * Scratch roots live INSIDE the repo, not under `tmpdir()`.
 *
 * `DocHygiene.hook.ts` skips any path containing `/tmp/`, and on Linux
 * `tmpdir()` IS `/tmp` — so every `mkdtemp` under it is a path the hook
 * refuses to touch, and all three stamp witnesses would assert against a
 * file nothing had stamped. The guard in `doc()` below caught exactly that
 * and the suite was red on every Linux runner while passing on macOS, where
 * `tmpdir()` is `/var/folders/…`.
 *
 * In-repo scratch is this project's existing convention and `.gitignore`
 * carries its reason next to the other six prefixes. The mkdtemp suffix is
 * still required (#323 SC-6): a fixed path is a shared mutable resource, and
 * two suites running at once delete each other's fixtures mid-assertion.
 */
const scratch = (prefix: string) => mkdtempSync(join(ROOT, `.rg713-${prefix}-`));

/**
 * The hook's OWN skip list, read out of its source (#1426).
 *
 * The comment above routes around ONE pattern, `/tmp/`, written out as a
 * literal. The list has ten entries and `.claude/worktrees/` is among them,
 * so a checkout living at `…/rungate/.claude/worktrees/rg-N` — which is
 * where every agent session in this project works — makes `ROOT` itself a
 * skipped path, and with it every scratch directory under it. The three
 * stamp witnesses then assert against a file nothing stamped, and they fail
 * in a worktree while passing in a plain checkout, with no code difference
 * between the two. Measured: same hook, same payload, same bytes, one path
 * containing `.claude/worktrees/` and one not — stamped NO and YES.
 *
 * Reading the list rather than restating it is the point. A pattern added
 * tomorrow is covered the day it lands, which is the failure this issue is.
 */
function hookSkipPatterns(): string[] {
  const src = readFileSync(join(ROOT, "hooks", "DocHygiene.hook.ts"), "utf-8");
  const block = /const SKIP_PATTERNS = \[([^\]]*)\]/.exec(src);
  if (block === null) {
    throw new Error("could not find SKIP_PATTERNS in DocHygiene.hook.ts — this check reads nothing");
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/**
 * A scratch root the hook will not skip, wherever this checkout lives.
 *
 * In-repo first, because that is this project's convention and `.gitignore`
 * carries the reason. `tmpdir()` is NOT a fallback — on Linux it is `/tmp`,
 * which is the pattern the original comment routed around. The home
 * directory is, because no pattern matches it on either platform.
 *
 * If no candidate survives, this throws rather than returning the least bad
 * one: a stamp witness that cannot be measured is UNMEASURED, and a green
 * row would say the mechanism is live.
 */
function unskippedScratch(prefix: string): string {
  const patterns = hookSkipPatterns();
  const failures: string[] = [];
  for (const base of [ROOT, homedir()]) {
    const dir = mkdtempSync(join(base, `.rg713-${prefix}-`));
    const hit = patterns.find(p => dir.includes(p));
    if (hit === undefined) return dir;
    rmSync(dir, { recursive: true, force: true });
    failures.push(`${base} matches ${hit}`);
  }
  throw new Error(`no scratch root escapes the hook's skip list: ${failures.join("; ")}`);
}

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

  // ── #1120: the allowlist used to be consulted BEFORE the write target.
  //
  // Two bypasses, and they fail for different reasons, which is why both are
  // here. (C) is an ordering defect: the write target was always visible, the
  // guard just never looked. (B) is a blind spot: an interpreter writes
  // without a shell redirect, so write-target extraction cannot see it at all
  // and deleting the allowlist does not help — measured, see the PR.

  // #1175 moved both of these off `/tmp`. They were written there because the
  // guard matched a NAME in any tree; `/tmp` is now the one tree where a
  // protected name is a fixture, so leaving them there would have asserted
  // the false positive #1175 removed.

  test("#1120 WITNESS: an allowlisted prefix in front of a protected redirect is blocked", () => {
    // The bypassing prefix does nothing whatsoever and the blocked redirect is
    // still there, verbatim, one semicolon later.
    const r = runHook("BashWriteGuard.hook.ts", cmd("gh --version; echo x > /opt/probe/.gate-salt"));
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("#1120 WITNESS: an interpreter one-liner writing a protected file is blocked", () => {
    const r = runHook(
      "BashWriteGuard.hook.ts",
      cmd(`python3 -c "open('/opt/probe/.gate-salt','w').write('x')"`),
    );
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("#1175 CONTROL: the same write under /tmp is a fixture and passes, end to end", () => {
    // The pair the unit tests hold is held here too, through the real hook in
    // a real subprocess — because the hook has its own refuse-on-throw
    // fallback keyed on the protected names, and a module that allows while
    // its hook refuses would be invisible to `bash-write-guard.test.ts`.
    expect(
      runHook(
        "BashWriteGuard.hook.ts",
        cmd(`python3 -c "open('/tmp/probe/.gate-salt','w').write('x')"`),
      ).stdout.trim(),
    ).toBe("");
  });

  test("#1120 NEG CTRL: the RECORDED false positive still passes", () => {
    // Reconstructed verbatim from the 2026-09-10 transcript. This is the ONLY
    // false positive the allowlist was ever built against — recorded in
    // `hornjason/pai-config#474`, NOT this repository's #474, which is a
    // `lib/scaffold/steps.ts` bug. A `gh` command whose comment body quotes a
    // protected filename and the word `chflags`.
    //
    // It is blocked by the chmod/chflags whole-command check, not by write-
    // target extraction — measured both ways. So the allowlist's remaining
    // job is to exempt a read-only command from the SUBSTRING checks, and
    // only from those. Emptying the allowlist turns this case red, which is
    // the cheapest wrong fix reintroducing the exact regression it undid.
    const recorded = [
      `gh issue close 473 --repo hornjason/pai-config --comment "$(cat <<'EOF'`,
      "1. **BashWriteGuard.hook.ts** — blocks Bash writes to workflow-state.json, .gate-salt, witnesses/, hook files.",
      "- Run `chflags uchg` on hook files for immutable protection (one-time)",
      "EOF",
      `)" 2>&1 | tail -1`,
    ].join("\n");
    expect(
      runHook("BashWriteGuard.hook.ts", cmd(recorded)).stdout.trim(),
      "the recorded pai-config#474 false positive must stay allowed",
    ).toBe("");
  });

  test("#1120 NEG CTRL: ordinary read commands all still pass", () => {
    // A guard that refuses everything passes every witness written for it.
    // This is the population that separates the fix from that guard.
    const reads = [
      "ls -la",
      "cat README.md",
      "grep -rn phase lib/",
      "find . -name '*.hook.ts'",
      "head -20 workflow-state.json",
      "tail -5 workflow-state.json",
      "wc -l hooks/BashWriteGuard.hook.ts",
      "jq .phase workflow-state.json",
      "bun test test/product-hook-migration.test.ts",
      "gh issue view 1120 --repo hornjason/pai-harness",
      "python3 -c \"print(1 + 1)\"",
    ];
    const refused = reads.filter(c => runHook("BashWriteGuard.hook.ts", cmd(c)).stdout.trim() !== "");
    expect(refused, "these are reads; a guard refusing them is a guard that gets switched off").toEqual([]);
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
    const dir = unskippedScratch("dh");
    const path = join(dir, "GUIDE.md");
    writeFileSync(path, contents);
    // The premise, checked against the hook's whole list rather than one
    // literal from it. A skipped path makes every stamp case below green
    // having stamped nothing, so this has to be red instead of invisible —
    // and before #1426 it only covered `/tmp/`, one entry of ten.
    for (const pattern of hookSkipPatterns()) {
      expect(path.includes(pattern), `scratch root is skipped by the hook's own "${pattern}"`).toBe(
        false,
      );
    }
    return { dir, path, payload: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path } }) };
  }

  // The premise check above reads a list out of a file, so it is vacuous if
  // the read comes back empty — ten assertions over zero patterns is zero
  // assertions, and every stamp row would be green for the reason this
  // issue exists. Name a member the list must contain.
  test("CONTROL: the skip list this fixture reads is non-empty and real", () => {
    const patterns = hookSkipPatterns();
    expect(patterns.length, "SKIP_PATTERNS was read as empty, so the premise check asserts nothing")
      .toBeGreaterThan(1);
    expect(patterns, "the `/tmp/` entry the original comment named is gone").toContain("/tmp/");
    expect(
      patterns,
      "`.claude/worktrees/` left the list — the premise check may now be measuring nothing",
    ).toContain(".claude/worktrees/");
  });

  test("WITNESS: a doc with no frontmatter gets the three inferable fields", () => {
    // Three, not four, since #1119. `owner:` left this set because it is the
    // one key the hook cannot infer — see the #1119 witness below.
    const { dir, path, payload } = doc("# My Doc\n\nbody\n");
    try {
      runHook("DocHygiene.hook.ts", payload);
      const out = readFileSync(path, "utf-8");
      for (const key of ["doc-type:", "status:", "updated:"]) expect(out).toContain(key);
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

  test("#1119 WITNESS: a generated doc carries NO owner key", () => {
    // The hook used to stamp `owner: 'jason'` as a literal, so a consumer's
    // markdown inherited this repository's owner. There is no config value to
    // put in its place — nothing downstream reads the key, measured over
    // `lib`, `hooks`, `bin` and `gates` — so the key is omitted rather than
    // defaulted. A default owner is the same defect as the literal: it writes
    // a value nobody chose into somebody else's file.
    //
    // This is the case the cheapest wrong fix fails. Reading the owner from
    // config with `'jason'` as the fallback passes every configured-owner
    // test ever written and lands this exact file, unchanged, on a consumer.
    const { dir, path, payload } = doc("# My Doc\n\nbody\n");
    try {
      runHook("DocHygiene.hook.ts", payload);
      const out = readFileSync(path, "utf-8");
      expect(out, "no owner may be invented for a doc that declares none").not.toContain("owner:");
      expect(out, "the literal must not survive under any spelling").not.toContain("jason");
      // The negative control. Three assertions saying a key is ABSENT also
      // hold against a hook that stamps nothing at all, so the three keys the
      // hook still owns are asserted present in the same breath.
      for (const key of ["doc-type:", "status:", "updated:"]) expect(out).toContain(key);
      expect(out, "the body must survive the stamp").toContain("body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a non-markdown file is untouched", () => {
    const dir = unskippedScratch("dh-nonmd");
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
    const dir = scratch("stub");
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
