/**
 * #505 — the harness config must not live where git thinks it is disposable.
 *
 * ## What this battery must be capable of showing, stated before it was run
 *
 * The headline case is a real `git checkout`, not a model of one. Asserting
 * "the config survives" without running the command asserts my reading of
 * `gitignore(5)`, and the issue is open precisely because that reading was
 * wrong in the recommendation it carries. So the control has to be able to
 * demonstrate BOTH directions against the same temporary repository:
 *
 *  1. **The loss, reproduced.** With the project's rules unchanged, a branch
 *     switch DELETES `.claude/rungate.json` from the working tree. If this
 *     arm cannot show the deletion, the fixture is not #505 and nothing the
 *     other arm says is evidence about it.
 *  2. **The loss, impossible.** After the scaffold's negation, a plain
 *     `git add -A` picks the config up — no `-f` — and the same branch
 *     switch leaves the file byte-identical.
 *  3. **The cheap wrong fix still failing.** The negation the issue
 *     recommends, `!.claude/rungate.json` on its own, must still leave the
 *     path ignored and `git add` still refusing. A fixture that goes green
 *     under the repair someone reaches for certifies that repair
 *     (`.claude/rules/checks-must-be-able-to-fail.md`, fifth shape).
 *
 * Every repository below is created by `mkdtemp` and removed in the same
 * `finally`. Nothing here touches a repository anyone is working in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  configPathsIgnored,
  configTrackabilityBlock,
  ensureConfigTrackable,
} from "../lib/config-trackable";
import { DIRECTORY_CONFIG_FILES, RUNGATE_CONFIG_IGNORE_PATHS } from "../lib/config-loader";
import { runScaffoldWriteSteps } from "../lib/scaffold/write-steps";
import type { ProjectType } from "../lib/generators/types";

const scratch: string[] = [];

/**
 * An empty `HOME`, and no global or system git config.
 *
 * Every assertion below is about what THIS repository's rules say, and
 * `core.excludesFile` in a developer's `~/.gitconfig` is an ignore rule like
 * any other — so a machine with `*.json` in a global excludes file would
 * measure a different thing from CI while both reported a verdict. Set on
 * `process.env` rather than per-`spawnSync`, because the module under test
 * spawns git itself and a hermetic fixture that only covers the test's own
 * calls is hermetic about the wrong half.
 */
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), "rungate-505-home-"));
const PRIOR_ENV = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
};
beforeAll(() => {
  process.env.HOME = HERMETIC_HOME;
  process.env.XDG_CONFIG_HOME = HERMETIC_HOME;
  process.env.GIT_CONFIG_GLOBAL = join(HERMETIC_HOME, "absent-gitconfig");
  process.env.GIT_CONFIG_SYSTEM = join(HERMETIC_HOME, "absent-gitconfig");
});
afterAll(() => {
  for (const [k, v] of Object.entries(PRIOR_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  rmSync(HERMETIC_HOME, { recursive: true, force: true });
});

/**
 * An action list with no refusal and no unmeasured outcome.
 *
 * UNMEASURED is a RESULT here and not a pass: `git` missing, a timeout or a
 * locked index all produce one, and a row that accepted it would go green
 * on a machine where the thing under test never ran.
 */
function expectMeasured(actions: string[], wanted: string) {
  const joined = actions.join("\n");
  expect(joined, `the step could not measure: ${joined}`).not.toContain("UNMEASURED:");
  expect(joined, `the step did not reach "${wanted}": ${joined}`).toContain(wanted);
}

function run(root: string, ...args: string[]) {
  // `env` explicitly, and the fixture above is why. Under Bun a
  // `process.env` write made after process start does NOT reach a child
  // given no `env` option, so the hermetic HOME set in `beforeAll` never
  // arrived here: measured, a global `core.excludesFile` written after
  // start is honoured by a bare spawn and neutralised by this one (#1096).
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", env: { ...process.env } });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A throwaway repository on `main`, with the given files already written. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-505-"));
  scratch.push(root);
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.invalid");
  run(root, "config", "user.name", "t");
  run(root, "config", "commit.gpgsign", "false");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** The monolith and the directory layout, named from the module that owns them. */
const [DIR_CONFIG, MONOLITH] = RUNGATE_CONFIG_IGNORE_PATHS;
const CONFIG_BODY = JSON.stringify({ project: { name: "p" }, pages: { a: "/a" } }, null, 2) + "\n";

describe("#505: a config in an ignored directory is deleted by an ordinary branch switch", () => {
  test("the loss, reproduced: a real `git checkout` removes the config", () => {
    // Arm 1. This is the reported shape exactly: `.claude/` ignored
    // wholesale, the config force-added on ONE branch because that is the
    // only way it could be added at all, and untracked everywhere else.
    const root = repo({ ".gitignore": ".claude/\n", "README.md": "# p", [MONOLITH]: CONFIG_BODY });
    run(root, "add", "-A");
    run(root, "commit", "-qm", "base");

    // The scaffold's own symptom first: `git add -A` did NOT pick the
    // config up, so `main` has no idea it exists.
    expect(run(root, "ls-files", MONOLITH).out.trim(), "the config was tracked on main after all")
      .toBe("");

    run(root, "checkout", "-q", "-b", "feature");
    expect(run(root, "add", "-f", MONOLITH).status, "the force-add failed").toBe(0);
    run(root, "commit", "-qm", "force-add the harness config");
    expect(existsSync(join(root, MONOLITH))).toBe(true);

    // The branch switch. Run, not reasoned about.
    const back = run(root, "checkout", "-q", "main");
    expect(back.status, `checkout failed: ${back.out}`).toBe(0);
    expect(
      existsSync(join(root, MONOLITH)),
      "the fixture did not reproduce #505 — nothing below is evidence about it",
    ).toBe(false);
    // And git says nothing about it afterwards, which is the whole report.
    expect(run(root, "status", "--porcelain").out.trim(), "git flagged the deletion").toBe("");
  });

  test("the cheap wrong fix: `!.claude/rungate.json` alone is inert", () => {
    // Arm 3, and the correction to the issue's own recommendation.
    // `gitignore(5)`: "It is not possible to re-include a file if a parent
    // directory of that file is excluded."
    const root = repo({ ".gitignore": `.claude/\n!${MONOLITH}\n`, [MONOLITH]: CONFIG_BODY });
    expect(configPathsIgnored(root).ignored, "the naive negation un-ignored the config")
      .toContain(MONOLITH);
    const added = run(root, "add", MONOLITH);
    expect(added.status, "git add accepted the path, so the negation worked").not.toBe(0);
    expect(added.out).toContain("ignored by one of your .gitignore files");
  });

  test("the loss made impossible: the config survives the same branch switch", () => {
    // Arm 2, on a repository built the same way as arm 1 so the two differ
    // in one thing: whether the scaffold step ran.
    const root = repo({ ".gitignore": ".claude/\n", "README.md": "# p", [MONOLITH]: CONFIG_BODY });
    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expectMeasured(actions, "UPDATED: .gitignore");

    // A PLAIN add. No `-f`. This is the thing that was impossible before,
    // and it is why the file ends up on every branch instead of one.
    expect(run(root, "add", "-A").status, "git add -A still refused the config").toBe(0);
    run(root, "commit", "-qm", "base");
    expect(run(root, "ls-files", MONOLITH).out.trim(), "the config is still untracked on main")
      .toBe(MONOLITH);

    const before = readFileSync(join(root, MONOLITH), "utf-8");
    run(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "README.md"), "# changed on the branch\n");
    run(root, "commit", "-qam", "unrelated work");
    const back = run(root, "checkout", "-q", "main");
    expect(back.status, `checkout failed: ${back.out}`).toBe(0);

    expect(existsSync(join(root, MONOLITH)), "the branch switch deleted the config").toBe(true);
    expect(readFileSync(join(root, MONOLITH), "utf-8"), "the config came back changed").toBe(before);
  });

  test("the other deletion path: `git clean -xfd` no longer reaches it", () => {
    // A branch switch is not the only ordinary command that removes an
    // ignored file. `-x` is the flag that makes `clean` take ignored files
    // too, and it is what an agent reaches for to get a pristine tree.
    const root = repo({ ".gitignore": ".claude/\n", "README.md": "# p", [MONOLITH]: CONFIG_BODY });
    run(root, "add", "-A");
    run(root, "commit", "-qm", "base");
    run(root, "clean", "-xfdq");
    expect(existsSync(join(root, MONOLITH)), "the fixture did not reproduce the clean case")
      .toBe(false);

    const healed = repo({ ".gitignore": ".claude/\n", "README.md": "# p", [MONOLITH]: CONFIG_BODY });
    ensureConfigTrackable(healed, []);
    run(healed, "add", "-A");
    run(healed, "commit", "-qm", "base");
    run(healed, "clean", "-xfdq");
    expect(existsSync(join(healed, MONOLITH)), "git clean -x still deleted the config").toBe(true);
  });

  test("the directory layout is covered too, and the rest of .claude/ stays ignored", () => {
    // The block re-includes a DIRECTORY, which is a different pattern from
    // re-including a file, and `.claude/` holds things that must stay out:
    // the issue names `settings.local.json` and `worktrees/` specifically.
    const root = repo({
      ".gitignore": ".claude/\n",
      [DIR_CONFIG]: CONFIG_BODY,
      ".claude/rungate/roles.json": "{}\n",
      ".claude/settings.local.json": "{}\n",
      ".claude/worktrees/x/keep.txt": "x\n",
    });
    ensureConfigTrackable(root, []);
    expect(configPathsIgnored(root).ignored, "a config path is still ignored").toEqual([]);
    run(root, "add", "-A");
    const tracked = run(root, "ls-files").out.split("\n").filter(Boolean).sort();
    expect(tracked, "the directory-layout config was not picked up").toContain(DIR_CONFIG);
    expect(tracked, "a sibling fragment in the config directory was left out")
      .toContain(".claude/rungate/roles.json");
    expect(tracked, "settings.local.json stopped being ignored")
      .not.toContain(".claude/settings.local.json");
    expect(tracked, "the worktrees directory stopped being ignored")
      .not.toContain(".claude/worktrees/x/keep.txt");
  });

  test("the negation reaches the config files and NOTHING else in the directory", () => {
    // The finding a four-line block hid. `!.claude/rungate/` on its own
    // un-ignores that directory RECURSIVELY: every file in it becomes
    // trackable, now and whenever one is added, in every repository the
    // scaffold reaches. Measured against the four-line version, `DECOY.json`
    // and `nested/DECOY.json` both came back trackable.
    //
    // A row that asserted only "the config files are trackable" passes on
    // the broken block, which is why the decoys are the assertion and not
    // the configs.
    const root = repo({
      ".gitignore": ".claude/\n",
      [DIR_CONFIG]: CONFIG_BODY,
      ".claude/rungate/DECOY.json": '{"secret":"planted"}\n',
      ".claude/rungate/nested/DECOY.json": '{"secret":"planted deeper"}\n',
    });
    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expectMeasured(actions, "UPDATED: .gitignore");

    const ignored = configPathsIgnored(root);
    expect(ignored.failure, "the verification itself could not run").toBeNull();
    expect(ignored.ignored, "a config path is still ignored").toEqual([]);

    // `git add -A` is the command that would commit them, so it is the
    // command that decides this.
    run(root, "add", "-A");
    const tracked = run(root, "ls-files").out.split("\n").filter(Boolean);
    for (const f of DIRECTORY_CONFIG_FILES.filter(f => f === "config.json")) {
      expect(tracked, `${f} is not committable`).toContain(`.claude/rungate/${f}`);
    }
    expect(tracked, "a file nobody named became trackable — the glob is too wide")
      .not.toContain(".claude/rungate/DECOY.json");
    expect(tracked, "a NESTED file nobody named became trackable")
      .not.toContain(".claude/rungate/nested/DECOY.json");
  });

  test("every file the directory layout is made of survives, not just config.json", () => {
    // The other direction, and the reason the block names four files rather
    // than one: losing `roles.json` to a branch switch is #505 for
    // `roles.json`. The list comes from `DIRECTORY_CONFIG_FILES`, so adding
    // a fifth layout file without adding it to the block reddens here.
    const files: Record<string, string> = { ".gitignore": ".claude/\n" };
    for (const f of DIRECTORY_CONFIG_FILES) files[`.claude/rungate/${f}`] = "{}\n";
    const root = repo(files);
    ensureConfigTrackable(root, []);
    run(root, "add", "-A");
    const tracked = run(root, "ls-files").out.split("\n").filter(Boolean);
    for (const f of DIRECTORY_CONFIG_FILES) {
      expect(tracked, `${f} is not committable, so a branch switch still deletes it`)
        .toContain(`.claude/rungate/${f}`);
    }
  });

  test("a config file at an unexpected depth stays ignored, and that is the boundary", () => {
    // Stated rather than inferred. `.claude/rungate/*` matches the
    // intermediate directory, git does not descend, and the anchored
    // negation below never applies — so a config at a depth the layout does
    // not have is NOT rescued. Ignored is the safe side for a path nobody
    // designed, and the emitted block says so in a comment.
    const root = repo({ ".gitignore": ".claude/\n", ".claude/rungate/nested/config.json": CONFIG_BODY });
    ensureConfigTrackable(root, []);
    const r = spawnSync("git", ["check-ignore", "--no-index", "-q", ".claude/rungate/nested/config.json"],
      { cwd: root, env: { ...process.env } });
    expect(r.status, "a nested config was quietly un-ignored").toBe(0);
  });

  test("a glob that reaches one path too far is a REFUSAL, measured over the whole ignored set", () => {
    // The guard that holds for globs nobody has written yet. A tree where
    // the existing rule ignores something the block's `!.claude/` would
    // rescue: `.claude/` is excluded and so is a sibling the project means
    // to keep out. Proven by pointing the guard at a block that is too
    // wide, rather than by trusting the narrow one.
    const root = repo({ ".gitignore": ".claude/\n", [MONOLITH]: CONFIG_BODY, ".claude/secrets.env": "K=v\n" });
    const before = run(root, "ls-files", "-o", "-i", "--exclude-standard").out.split("\n").filter(Boolean);
    expect(before, "the fixture's sibling is not ignored to begin with").toContain(".claude/secrets.env");

    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expectMeasured(actions, "UPDATED: .gitignore");
    const after = run(root, "ls-files", "-o", "-i", "--exclude-standard").out.split("\n").filter(Boolean);
    expect(after, "a sibling of the config stopped being ignored").toContain(".claude/secrets.env");
    expect(after, "the config is still ignored").not.toContain(MONOLITH);
  });

  test("the un-ignore guard refuses a block that is too wide — the witness", () => {
    // The guard cannot fire against the block this module emits, which is
    // the point of the block and also the reason the guard needed this:
    // deleting the guard was 0 red of 17 without it. So the witness hands
    // in the block the review caught — `!.claude/rungate/` with no
    // re-exclude after it, which un-ignores that directory RECURSIVELY —
    // and asserts the step refuses rather than shipping it.
    const tooWide = [
      "", "!.claude/", ".claude/*", "!.claude/rungate/", "!.claude/rungate.json", "",
    ].join("\n");
    const original = ".claude/\n";
    const root = repo({
      ".gitignore": original,
      [DIR_CONFIG]: CONFIG_BODY,
      ".claude/rungate/DECOY.json": '{"planted":true}\n',
    });
    const actions: string[] = [];
    ensureConfigTrackable(root, actions, tooWide);
    expect(actions.join("\n"), "a block that un-ignores a decoy was accepted").toContain("REFUSED:");
    expect(actions.join("\n"), "the refusal does not name what it would have un-ignored")
      .toContain(".claude/rungate/DECOY.json");
    expect(readFileSync(join(root, ".gitignore"), "utf-8"), "the too-wide block was left on disk")
      .toBe(original);

    // The control for the witness: the same tree, the REAL block, accepted.
    // Without this the row is satisfied by a step that refuses everything.
    const ok: string[] = [];
    ensureConfigTrackable(root, ok);
    expectMeasured(ok, "UPDATED: .gitignore");
  });

  test("a config already tracked under an ignore rule is still reported at risk", () => {
    // `git check-ignore` SKIPS paths in the index unless `--no-index` is
    // given, so without that flag this repository — the reported consumer's
    // exact state, force-added on one branch — answers "not ignored" about
    // the file that is about to be deleted on the next checkout.
    const root = repo({ ".gitignore": ".claude/\n", [MONOLITH]: CONFIG_BODY });
    run(root, "add", "-f", MONOLITH);
    run(root, "commit", "-qm", "force-add");
    // Both paths match `.claude/` — `check-ignore` answers about patterns,
    // not about files that exist. The INDEXED one is the load-bearing
    // half: drop `--no-index` and this list loses exactly the entry that
    // names a file git is about to delete.
    expect(configPathsIgnored(root).ignored, "a tracked-but-ignored config was reported safe")
      .toContain(MONOLITH);
  });

  test("a project that is not a git repository is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "rungate-505-bare-"));
    scratch.push(root);
    writeFileSync(join(root, ".gitignore"), ".claude/\n");
    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expect(actions.join("\n")).toContain("SKIP: .gitignore");
    expect(readFileSync(join(root, ".gitignore"), "utf-8"), "a non-repo had its .gitignore edited")
      .toBe(".claude/\n");
  });

  test("a project whose config is already committable is left alone, and twice is once", () => {
    // rungate's own shape: `.claude/worktrees/` ignored, the config not.
    const root = repo({ ".gitignore": "node_modules\n.claude/worktrees/\n", [DIR_CONFIG]: CONFIG_BODY });
    const first: string[] = [];
    ensureConfigTrackable(root, first);
    expectMeasured(first, "already committable");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules\n.claude/worktrees/\n");

    // Idempotence, which matters because the scaffold is re-run: a step
    // that appends every time turns a `.gitignore` into a log.
    const healed = repo({ ".gitignore": ".claude/\n", [MONOLITH]: CONFIG_BODY });
    ensureConfigTrackable(healed, []);
    const once = readFileSync(join(healed, ".gitignore"), "utf-8");
    ensureConfigTrackable(healed, []);
    expect(readFileSync(join(healed, ".gitignore"), "utf-8"), "the block was appended twice")
      .toBe(once);
  });

  test("an ignore rule this block cannot reach is a REFUSAL, and the file is restored", () => {
    // A rule the root block cannot override, and the fixture had to change
    // once already: a root `*.json` IS reachable, because the block's
    // anchored `!.claude/rungate.json` is the last matching pattern. A
    // NESTED `.gitignore` is not — patterns in a deeper directory's file
    // win over a parent's whatever the order, so no line appended at the
    // root can reach them. `check-ignore -v` names the file and the line,
    // which is what the consumer needs.
    //
    // Reporting `UPDATED:` over this would be a step that cannot fail: it
    // edits a file, verifies nothing, and says it worked.
    const original = ".claude/\n";
    const root = repo({
      ".gitignore": original,
      ".claude/.gitignore": "*\n",
      [MONOLITH]: CONFIG_BODY,
    });
    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expect(actions.join("\n"), "an unreachable rule was reported as fixed").toContain("REFUSED:");
    expect(actions.join("\n"), "the refusal does not name the rule that beat it")
      .toContain(".claude/.gitignore");
    expect(readFileSync(join(root, ".gitignore"), "utf-8"), "the .gitignore was left edited")
      .toBe(original);
  });

  test("a negation that would newly ignore a TRACKED file is a REFUSAL too", () => {
    // `.claude/*` is a no-op when `.claude/` is already excluded, and is
    // NOT a no-op otherwise. Here a bare `rungate.json` rule matches the
    // monolith at any depth while `.claude/` itself is not excluded, so
    // `.claude/rules/x.md` is an ordinary tracked file — and the block
    // would make it tracked AND ignored, the contradiction
    // `lib/tracked-vs-ignored.ts` exists to report.
    const original = "rungate.json\n";
    const root = repo({
      ".gitignore": original,
      ".claude/rules/x.md": "# a rule\n",
      [MONOLITH]: CONFIG_BODY,
    });
    run(root, "add", "-A");
    run(root, "commit", "-qm", "base");
    expect(run(root, "ls-files").out, "the fixture's tracked file is not tracked")
      .toContain(".claude/rules/x.md");

    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expect(actions.join("\n"), "a tracked file was silently ignored").toContain("REFUSED:");
    expect(actions.join("\n")).toContain(".claude/rules/x.md");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(original);
  });

  test("a project with no .gitignore at all does not acquire an empty one", () => {
    // The config can be ignored with no root `.gitignore` in the tree at
    // all — here by a nested one. The block cannot reach that, so it
    // refuses —
    // and a refusal that leaves behind a file the project never had is a
    // step that changed something while reporting that it did not.
    const root = repo({ ".claude/.gitignore": "*\n", [MONOLITH]: CONFIG_BODY });
    expect(existsSync(join(root, ".gitignore")), "the fixture already has a root .gitignore")
      .toBe(false);
    const actions: string[] = [];
    ensureConfigTrackable(root, actions);
    expect(actions.join("\n"), "a nested ignore rule was not even detected").toContain("REFUSED:");
    expect(existsSync(join(root, ".gitignore")), "an empty .gitignore was left behind").toBe(false);
  });

  test("the real scaffold runs this step, in the one order that works", () => {
    // Not a grep for a call site, and not a reimplementation of the phase
    // order: `runScaffoldWriteSteps` itself, against a planted repository.
    // The order is the claim — `createGitignore` APPENDS, and a negation
    // that is not the last matching rule does nothing — so a test that
    // called the two functions itself would prove the order it chose.
    const root = repo({ ".gitignore": ".claude/\n", "README.md": "# p", [DIR_CONFIG]: CONFIG_BODY });
    const actions: string[] = [];
    try {
      runScaffoldWriteSteps(root, "content" as ProjectType, actions, { profile: "minimal" });
    } catch {
      // Later phases need more of a project than this fixture is. The
      // claim is about Phase 0, and an action list that reached it.
    }
    const ours = actions.filter(a => a.includes(".gitignore"));
    expect(ours.join("\n"), "the scaffold never ran the trackability step")
      .toContain("is now committable");
    expect(
      ours.findIndex(a => a.includes("missing entries")),
      "the trackability block was written BEFORE createGitignore appended, so it is not last",
    ).toBeLessThan(ours.findIndex(a => a.includes("is now committable")));
    expect(configPathsIgnored(root).ignored, "the scaffolded project's config is still ignored")
      .toEqual([]);
  });

  test("the block is written verbatim, and its order is the mechanism", () => {
    // `GITIGNORE_SECTIONS`'s rule (#474): nothing downstream transforms a
    // pattern. This asserts the four lines and their ORDER, because the
    // order is what makes the negation work at all — a `!` line before the
    // directory is re-included is inert, which is the bug in the issue's
    // own recommendation.
    const lines = configTrackabilityBlock().split("\n").filter(l => l !== "" && !l.startsWith("#"));
    expect(lines, "the block's patterns or their order changed").toEqual([
      "!.claude/",
      ".claude/*",
      `!${dirname(DIR_CONFIG)}/`,
      `${dirname(DIR_CONFIG)}/*`,
      ...DIRECTORY_CONFIG_FILES.map(f => `!${dirname(DIR_CONFIG)}/${f}`),
      `!${MONOLITH}`,
    ]);
    // The re-exclude must follow its own re-include and precede the
    // negations, at BOTH levels. That ordering is the whole mechanism and
    // the reason a flat list of `!` lines does not work.
    expect(lines.indexOf(".claude/*")).toBeGreaterThan(lines.indexOf("!.claude/"));
    expect(lines.indexOf(`${dirname(DIR_CONFIG)}/*`))
      .toBeGreaterThan(lines.indexOf(`!${dirname(DIR_CONFIG)}/`));
    expect(lines.indexOf(`!${DIR_CONFIG}`)).toBeGreaterThan(lines.indexOf(`${dirname(DIR_CONFIG)}/*`));
  });
});
