/**
 * #971 — a hook that builds a SHELL STRING out of a tool-call value.
 *
 * `ProjectStateSync` is registered at user scope on both `Write` and `Edit`,
 * so it is reached by every agent's write in every session on this machine.
 * It took `input.tool_input.file_path`, cut `project-state.json` off the end,
 * and interpolated the remaining prefix into
 * `execSync(\`bun ${script} --skip-tests\`)`. Everything before the trailing
 * file name is attacker-influenced, and `$(…)`, backticks and `;` are all
 * legal in a filename.
 *
 * The two things that narrow it close nothing. The path must END in
 * `project-state.json`, so the prefix is the payload; and `existsSync(script)`
 * must pass first, so the payload has to be a real directory on disk — a bar,
 * not a wall, and `/tmp` is writable.
 *
 * `CommitEnforcement` is the sibling the sweep found (#971 SC-4). Its
 * `worktreePath` is read out of `tool_response` with `[^\s]*`, which admits
 * `$`, backticks and `;`, and `$(…)` is evaluated INSIDE the double quotes
 * the command wrapped it in. Both exec calls there sat in a `catch {}`, so
 * the injection was not merely silent — it was swallowed.
 *
 * ## How a case here can fail
 *
 * Every arm drives the REAL hook as a subprocess against a path that genuinely
 * exists, and every arm is run TWICE: once against the shipped source and once
 * against a mutant carrying the pre-#971 shell-string spelling, built by
 * byte-replacing one anchor in the real file. A hand-written "vulnerable
 * version" would prove the fixture can be attacked, not that this hook was.
 *
 * Each arm carries two independent observations:
 *
 * - the CANARY — a file the payload creates if a shell parsed the path.
 * - the REACH marker — the generator, or a `git` stub earlier on `PATH`,
 *   recording that the hook got as far as spawning anything at all.
 *
 * The reach marker is what stops "no canary" being satisfied by a hook that
 * exited at the `existsSync` guard and never reached the feature (#971 SC-2
 * says so in as many words).
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/hook-tree-divergence.test.ts` (32 tests). Every
 * count was predicted before the battery ran, and **the baseline row was read
 * before any mutation row** — an instrument that has stopped reporting takes
 * the baseline down with it, and that is the row nobody mutates anything to
 * produce. Each row names the ASSERTIONS it reddens, not only how many.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 32 pass, 0 fail | **32 pass, 0 fail** | — |
 * | M1 the genuinely pre-#971 `ProjectStateSync` — `execSync` restored | 5 | **5 of 32** — AC-1 (`injected`), AC-2, AC-3, AC-7, AC-8 | a directory named `p$(touch <canary>)q`: the original leaves the canary absent and writes `--skip-tests`, the mutant creates the canary and never runs the generator |
 * | M2 the genuinely pre-#971 `CommitEnforcement` — both `execSync` calls restored | 5 | **5 of 32** — AC-4 (`injected`), AC-5, AC-6, AC-7, AC-8 | a worktree leaf `agent-deadbeef$(touch${IFS}<canary>)`: original canary absent, mutant canary present |
 * | M3 `shellStringExecViolations` short-circuited to `return []` | 2 | **2 of 32** — AC-8, AC-9 | the pre-#971 mutant source: original returns one violation, mutant none. **AC-7 stays green**, which is why AC-8 exists |
 * | M4 **the cheapest wrong fix**: keep `execSync`, refuse a path containing a metacharacter | 5 | **5 of 32** — AC-1 (`reached`), AC-2, AC-3, AC-7, AC-8 | the same metacharacter directory: original runs the generator, mutant exits at the new guard. `injected` is GREEN under this fix — see below |
 * | M5 the reach instrument hardcoded — `reached: true` in `runProjectStateSync` | 1 | **1 of 32** — AC-2 | the pre-#971 mutant arm, whose marker is genuinely absent |
 *
 * **M4 is the fifth shape, measured rather than argued.** The 5pm repair for
 * "a path with `$(…)` in it ran" is a denylist, not an argv — the symptom
 * disappears, `injected` goes green, and the hook is still handing a command
 * line to a shell for every path the list does not happen to name. AC-1
 * survives it NON-vacuously, and the assertion that catches it is `reached`:
 * the hook stopped syncing anything it used to sync. Without that assertion
 * this file would certify the regression it exists to block.
 *
 * **M1, M2 and M4 each red three cases for the mutant-builder's reason**, not
 * for a behavioural one: with the anchor gone from the real file, `stageHook`
 * throws *"could not build the mutant: the anchor … appears 0 times"*. That
 * is the loud-abort property the builder exists for — a harness that silently
 * no-ops when its target moves is the decorative check this is all about —
 * but it is why those rows are 5 and not 2.
 *
 * None of the five mutations is left in the tree; all were applied and
 * reverted, and `hooks/ProjectStateSync.hook.ts`,
 * `hooks/CommitEnforcement.hook.ts` and this file were confirmed
 * byte-identical to the measured source afterwards by sha256.
 *
 * ## Instrument controls, labelled as such
 *
 * `AC-3` and `AC-6` are CONTROLS, not witnesses. They run a BENIGN path
 * through both spellings and assert the canary is absent and the reach marker
 * present in all four. They are green on the defective source by
 * construction, and there is no state of the code in which they go red for
 * the original defect. They exist so that "the canary is absent" in AC-1 and
 * AC-4 is a reading rather than a hook that did nothing.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - The hook's behaviour when the generator is slow: `timeout` is unchanged
 *   and unasserted here.
 * - `CommitEnforcement`'s fallback worktree discovery, which scans
 *   `~/.claude/.claude/worktrees` by mtime. It is not a tool-call value, so
 *   it is outside #971's population — but it reaches the same two exec calls,
 *   and those are now argv either way.
 * - Any hook that spawns nothing. The sweep in `AC-7` is what establishes
 *   that the population of spawn sites in `hooks/` is the two files tested
 *   here, and it asserts the scan read a non-empty tree so it cannot agree
 *   vacuously.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { stripJsComments } from "../lib/strip-js-comments";

const ROOT = join(import.meta.dir, "..");
const HOOKS = join(ROOT, "hooks");

/** Every scratch path in this file lives under one mkdtemp, removed in `afterAll`. */
const SCRATCH = mkdtempSync(join(tmpdir(), "hook-shell-injection-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let seq = 0;
function scratch(label: string): string {
  const dir = join(SCRATCH, `${label}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A copy of a real hook with named anchors replaced, runnable from a temp dir.
 *
 * Two properties, both asserted rather than assumed, and both taken from
 * `.claude/rules/checks-must-be-able-to-fail.md`'s mutant-builder discipline:
 *
 * - **Each anchor appears exactly once.** A second copy of the exec call would
 *   survive the replacement and the mutant would behave like the real source.
 *   Zero means the source moved and the row measures nothing, so it THROWS
 *   rather than returning something that reads as a mutation.
 * - **No relative import survives.** The copy runs from a temp directory, so a
 *   `./lib/parseStdin` left behind would die on module resolution — and a
 *   mutant that dies looks exactly like a mutant the code rejected.
 */
function stageHook(
  hookFile: string,
  edits: [string, string][],
  opts: { agentConfig?: boolean } = {},
): { path: string; source: string; staged: string } {
  const dir = scratch("staged");
  const source = readFileSync(join(HOOKS, hookFile), "utf-8");
  let out = source;
  for (const [from, to] of edits) {
    const n = out.split(from).length - 1;
    if (n !== 1) {
      throw new Error(
        `could not build the mutant: the anchor ${JSON.stringify(from)} appears ${n} times in ` +
          `hooks/${hookFile}`,
      );
    }
    out = out.replace(from, to);
  }

  // `hooks/lib/agent-config.json` has never existed in this repository, so
  // `detectAgent` returns null for every input and `CommitEnforcement` exits
  // before reaching either exec call. That is its own defect and is filed
  // separately; here it would mean the arm could not reach the subject at
  // all, so the detection module is staged LOCALLY with a config beside it.
  // Nothing about the hook under test is substituted — only the data a module
  // it imports could not find.
  const local = new Set<string>();
  if (opts.agentConfig) {
    mkdirSync(join(dir, "lib"), { recursive: true });
    copyFileSync(join(HOOKS, "lib", "agentDetection.ts"), join(dir, "lib", "agentDetection.ts"));
    writeFileSync(
      join(dir, "lib", "agent-config.json"),
      JSON.stringify({ agents: { marcus: { match: ["marcus"] } } }),
    );
    local.add("./lib/agentDetection");
  }

  const base = dirname(join(HOOKS, hookFile));
  out = out.replace(/from (['"])(\.[^'"]*)\1/g, (_m, q: string, rel: string) =>
    local.has(rel) ? `from ${q}${rel}${q}` : `from ${q}${resolve(base, rel)}${q}`,
  );
  const survivors = [...out.matchAll(/from ['"](\.[^'"]*)['"]/g)].map(m => m[1]).filter(r => !local.has(r));
  if (survivors.length > 0) {
    throw new Error(`could not build the mutant: relative imports survived the rewrite: ${survivors.join(", ")}`);
  }
  const path = join(dir, hookFile);
  writeFileSync(path, out);
  return { path, source, staged: out };
}

/** `stageHook`'s path alone, for the arms that do not assert staging fidelity. */
function mutantOf(hookFile: string, edits: [string, string][], opts: { agentConfig?: boolean } = {}): string {
  return stageHook(hookFile, edits, opts).path;
}

/** The lines on which a staged copy differs from the shipped hook. */
function changedLines(a: string, b: string): { before: string; after: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const out: { before: string; after: string }[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) out.push({ before: x[i] ?? "", after: y[i] ?? "" });
  }
  return out;
}

/** The genuinely pre-#971 spelling of each exec call, as it stood on `origin/main`. */
const PRE_971 = {
  projectStateImport: ['import { execFileSync } from "child_process";', 'import { execSync } from "child_process";'] as [string, string],
  projectStateCall: [
    'execFileSync("bun", [script, "--skip-tests"], {',
    'execSync(`bun ${script} --skip-tests`, {',
  ] as [string, string],
  commitImport: ["import { execFileSync } from 'child_process'", "import { execSync } from 'child_process'"] as [string, string],
  commitDiff: [
    "execFileSync('git', ['-C', worktreePath, 'diff', '--name-only', 'main'], {",
    'execSync(`git -C "${worktreePath}" diff --name-only main 2>/dev/null`, {',
  ] as [string, string],
  commitStatus: [
    "execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {",
    'execSync(`git -C "${worktreePath}" status --porcelain`, {',
  ] as [string, string],
};

/**
 * Drive a hook as a real subprocess, with `HOME` at an empty directory.
 *
 * `HOME` is its own mkdtemp per call, so nothing the hook records reaches the
 * machine's real work directory and no reading here can be satisfied by state
 * another session left behind.
 */
function driveHook(
  hookPath: string,
  payload: unknown,
  extraPath?: string,
): { status: number | null; stderr: string; stdout: string } {
  const home = scratch("home");
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      RUNGATE_WORK_DIR: join(home, ".rungate"),
      PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH,
    },
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/**
 * One ProjectStateSync arm.
 *
 * `dirName` is the directory the `project-state.json` write targets, and the
 * payload is BUILT INTO IT — a directory literally named
 * `p$(touch <canary>)q` on disk. That is the whole point: the fixture is a
 * real path, so the hook passes its own `existsSync` guard and reaches the
 * feature, which `#971 SC-2` requires in as many words.
 */
function runProjectStateSync(hookPath: string, makeDirName: (canary: string) => string) {
  const base = scratch("pss");
  const canary = join(base, "CANARY-INJECTED");
  const marker = join(base, "GENERATOR-RAN");
  const projectRoot = join(base, makeDirName(canary));
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });
  // The generator stub IS the reach marker. It is a real file at the real
  // path, so `existsSync(script)` passes and the hook goes on to spawn it.
  writeFileSync(
    join(projectRoot, "scripts", "update-project-state.ts"),
    `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));\n`,
  );
  const out = driveHook(hookPath, {
    tool_name: "Write",
    tool_input: { file_path: join(projectRoot, "project-state.json") },
    cwd: base,
  });
  return {
    ...out,
    injected: existsSync(canary),
    reached: existsSync(marker),
    generatorArgv: existsSync(marker) ? readFileSync(marker, "utf-8") : null,
  };
}

/** One CommitEnforcement arm. The reach marker is a `git` stub earlier on `PATH`. */
function runCommitEnforcement(hookPath: string, makeLeaf: (canary: string) => string) {
  const base = scratch("ce");
  const canary = join(base, "CANARY-INJECTED");
  const marker = join(base, "GIT-RAN");
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "git");
  // Prints nothing and exits 0, so neither exec call can succeed by accident
  // and the hook's own behaviour past this point is irrelevant to the reading.
  writeFileSync(stub, `#!/bin/sh\n: >> ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(stub, 0o755);

  const worktree = join(base, "worktrees", makeLeaf(canary));
  mkdirSync(worktree, { recursive: true });
  const out = driveHook(
    hookPath,
    {
      tool_name: "Agent",
      tool_input: { subagent_type: "marcus", isolation: "worktree", prompt: "issue #971" },
      tool_response: `done: ${worktree}`,
    },
    bin,
  );
  return { ...out, injected: existsSync(canary), reached: existsSync(marker) };
}

/** A payload with NO whitespace — `CommitEnforcement`'s `[^\s]*` stops at a space. */
const SPACELESS = (canary: string) => `agent-deadbeef$(touch\${IFS}${canary})`;

const REAL_PROJECT_STATE = join(HOOKS, "ProjectStateSync.hook.ts");

const COMMIT_EDITS: [string, string][] = [PRE_971.commitImport, PRE_971.commitDiff, PRE_971.commitStatus];
/**
 * Both CommitEnforcement arms are STAGED, and they differ from each other by
 * exactly the three anchors — #585's pair discipline, so no second difference
 * can creep into the comparison.
 */
const stagedCommit = (edits: [string, string][]) => stageHook("CommitEnforcement.hook.ts", edits, { agentConfig: true });

describe("#971: a tool-call file_path must never be parsed by a shell", () => {
  test("AC-1: ProjectStateSync does not execute metacharacters in the path, and still syncs", () => {
    // WITNESS. Red on the pre-#971 source (AC-2 measures it).
    //   `injected` reddens on a shell parsing the path.
    //   `reached`   reddens on a hook that never got to the generator — which
    //               is how `injected === false` could otherwise be bought.
    const r = runProjectStateSync(REAL_PROJECT_STATE, c => `p$(touch ${c})q`);
    expect(
      r.injected,
      "the directory name was parsed by a shell: the command substitution in the path RAN",
    ).toBe(false);
    expect(
      r.reached,
      "the generator never ran, so this case never reached the feature — a clean canary here " +
        "would be the existsSync guard, not the fix",
    ).toBe(true);
    expect(r.generatorArgv, "the generator was spawned without its flag").toBe("--skip-tests");
  });

  test("AC-2 (#971 SC-3): the pre-#971 execSync spelling DOES execute them — the negative control", () => {
    // The same arm against a mutant built by replacing ONE anchor in the real
    // file. Measured red here, so AC-1 is known to be able to fail rather than
    // assumed to be. The reach marker is absent in this arm for a true reason
    // and it is asserted: the shell expands `$(…)` to nothing, so the path the
    // mutant hands `bun` is `…/pq/scripts/update-project-state.ts`, which does
    // not exist.
    const mutant = mutantOf("ProjectStateSync.hook.ts", [PRE_971.projectStateImport, PRE_971.projectStateCall]);
    const r = runProjectStateSync(mutant, c => `p$(touch ${c})q`);
    expect(r.injected, "the mutant did not execute the payload, so AC-1 witnesses nothing").toBe(true);
    expect(r.reached, "the mutant ran the generator as well as the payload").toBe(false);
  });

  test("AC-3 CONTROL: a benign path reaches the generator under BOTH spellings", () => {
    // INSTRUMENT CONTROL, not a witness. Green on the defective source by
    // construction. Without it, AC-1's `injected === false` is satisfiable by
    // a hook that exits before doing anything, and AC-2's `reached === false`
    // reads as a broken mutant rather than as a mangled path.
    const mutant = mutantOf("ProjectStateSync.hook.ts", [PRE_971.projectStateImport, PRE_971.projectStateCall]);
    for (const [label, hook] of [["real", REAL_PROJECT_STATE], ["mutant", mutant]] as const) {
      const r = runProjectStateSync(hook, () => "ordinary-project");
      expect(r.injected, `${label}: a benign path created the canary, so the canary is not a reading`).toBe(false);
      expect(r.reached, `${label}: the generator did not run on a benign path — the instrument is dead`).toBe(true);
    }
  });

  test("AC-4a: the staged CommitEnforcement differs from the shipped hook only in its imports", () => {
    // Without this, AC-4 is a claim about a file this test wrote. The staged
    // copy supplies `agent-config.json`, which the repository does not have;
    // nothing else about the hook may differ, and this is the assertion that
    // says so rather than the comment above it.
    const { source, staged } = stagedCommit([]);
    const diff = changedLines(source, staged);
    expect(diff.length, "the staged copy is identical to the shipped hook, so nothing was rewritten").toBeGreaterThan(0);
    for (const d of diff) {
      expect(
        d.before.trimStart().startsWith("import ") || d.before.trimStart().startsWith("} from "),
        `the staging changed a line that is not an import: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
      ).toBe(true);
    }
  });

  test("AC-4 (#971 SC-4): CommitEnforcement does not execute metacharacters in a worktree path", () => {
    // WITNESS, for the sibling. `reached` is a `git` stub on PATH rather than
    // the generator, because this hook spawns `git` and not `bun`.
    const r = runCommitEnforcement(stagedCommit([]).path, SPACELESS);
    expect(
      r.injected,
      "the worktree path out of tool_response was parsed by a shell: $(…) inside the double " +
        "quotes RAN",
    ).toBe(false);
    expect(
      r.reached,
      "git was never spawned, so this case never reached the exec — a clean canary here is the " +
        "regex or the existsSync guard, not the fix",
    ).toBe(true);
  });

  test("AC-5 (#971 SC-3, sibling): the pre-#971 CommitEnforcement DOES execute them", () => {
    const r = runCommitEnforcement(stagedCommit(COMMIT_EDITS).path, SPACELESS);
    expect(r.injected, "the mutant did not execute the payload, so AC-4 witnesses nothing").toBe(true);
    expect(r.reached, "the mutant never spawned git at all, so the arm measures the wrong thing").toBe(true);
  });

  test("AC-6 CONTROL: a benign worktree path reaches git under BOTH spellings", () => {
    // INSTRUMENT CONTROL, not a witness. Same role as AC-3.
    for (const [label, hook] of [
      ["real", stagedCommit([]).path],
      ["mutant", stagedCommit(COMMIT_EDITS).path],
    ] as const) {
      const r = runCommitEnforcement(hook, () => "agent-deadbeef");
      expect(r.injected, `${label}: a benign path created the canary, so the canary is not a reading`).toBe(false);
      expect(r.reached, `${label}: git did not run on a benign path — the instrument is dead`).toBe(true);
    }
  });
});

/**
 * Every file under `hooks/` that could hand a string to a shell.
 *
 * Keyed on the IMPORT and on `shell: true`, over comment-stripped source —
 * the prose in both repaired hooks names `execSync` deliberately, and a
 * scanner that could not tell a sentence from a call would report the fix as
 * the defect. One binding, so there is one thing to mutate.
 */
export function shellStringExecViolations(file: string, source: string): string[] {
  const code = stripJsComments(source);
  const out: string[] = [];
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)];
  for (const m of imports) {
    for (const raw of m[1].split(",")) {
      const name = raw.split(" as ")[0].trim();
      // `execFileSync`/`execFile`/`spawn`/`spawnSync` take an argv. `exec` and
      // `execSync` take a COMMAND LINE and there is no option that changes it.
      if (name === "exec" || name === "execSync") out.push(`${file} imports ${name}, which parses its argument as a shell command line`);
    }
  }
  if (/\bshell\s*:\s*true/.test(code)) out.push(`${file} passes shell: true, which re-introduces the shell this hook does not need`);
  if (/Bun\.\$`/.test(code)) out.push(`${file} uses Bun.$, which is a shell`);
  return out;
}

describe("#971 SC-4: the sibling spelling, swept", () => {
  function hookSources(): { file: string; source: string }[] {
    const out: { file: string; source: string }[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(join(dir, e.name), `${prefix}${e.name}/`); continue; }
        if (!e.name.endsWith(".ts")) continue;
        out.push({ file: `hooks/${prefix}${e.name}`, source: readFileSync(join(dir, e.name), "utf-8") });
      }
    };
    walk(HOOKS, "");
    return out;
  }

  test("AC-7: no hook in the tree hands a command line to a shell", () => {
    const sources = hookSources();
    // The scan read something. Zero files is perfect agreement, and it is
    // what a moved directory looks like.
    expect(sources.length, "the sweep read no hook sources at all, so it compared nothing").toBeGreaterThan(15);

    const violations = sources.flatMap(s => shellStringExecViolations(s.file, s.source));
    expect(
      violations,
      `these hooks parse a command line with a shell. Spawn with an argument array — ` +
        `execFileSync("git", ["-C", path, …]) — so no metacharacter in a tool-call value is ` +
        `interpreted (#971):\n${violations.map(v => `  ${v}`).join("\n")}`,
    ).toEqual([]);
  });

  test("AC-8: the sweep reports the pre-#971 spelling of both hooks", () => {
    // The scan's own witness. The sources are the MUTANTS — produced by
    // byte-replacing an anchor in the real files — not hand-written examples,
    // so this cannot pass over a scanner that only recognises a string this
    // file invented.
    const pss = readFileSync(
      mutantOf("ProjectStateSync.hook.ts", [PRE_971.projectStateImport, PRE_971.projectStateCall]),
      "utf-8",
    );
    const ce = stagedCommit(COMMIT_EDITS).staged;
    expect(shellStringExecViolations("hooks/ProjectStateSync.hook.ts", pss)).toHaveLength(1);
    expect(shellStringExecViolations("hooks/CommitEnforcement.hook.ts", ce)).toHaveLength(1);
  });

  test("AC-9: the sweep does not report a hook for NAMING execSync in prose", () => {
    // The third shape, inverted: a detector that cannot tell a sentence from
    // a call reports the repaired hooks as the defect, and the cheapest
    // repair for THAT is to delete the comment explaining the fix.
    const commentOnly = `/**\n * This used to be execSync(\`bun \${x}\`) and shell: true.\n */\nexport const x = 1;\n`;
    expect(shellStringExecViolations("hooks/Fixture.hook.ts", commentOnly)).toEqual([]);
    // And the boundary in the other direction: a real call is still caught.
    expect(
      shellStringExecViolations("hooks/Fixture.hook.ts", `import { execSync } from "child_process";\nexecSync(x);\n`),
    ).toHaveLength(1);
  });
});
