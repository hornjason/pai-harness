/**
 * #671 — a refusal that leaves the side effect it refused to perform is not a
 * refusal.
 *
 * `asaCommandCenter#1585` ran the full lifecycle across three parallel
 * worktrees, committed waves 1 and 2, and refused at Commit on wave 3 with six
 * unclaimed file modifications (#178, SC-413). `SHIP_FAILED`, `pr: NO_PR`,
 * after 2h06m and 2.03M subagent tokens of correct work.
 *
 * The refusal is right and is not loosened here. What the issue measured
 * afterwards is the part this file is about: **the project root already held
 * wave 3's output** — byte-identical to worktree `-21` on all six files, by
 * shasum — so the run ended in the exact mixed state the check exists to
 * prevent, with nothing recording it.
 *
 * ## What was verified before writing anything, because it decided the scope
 *
 * #671 suggests three directions. Two are already in the tree, and building
 * them again would be two deciders that agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`):
 *
 * - *"register a claim for every file named in the issue body"* — #751 landed
 *   `planCoverage`, which refuses the parallel plan at decomposition time when
 *   a discovered file is claimed by no sub-issue, and argues on the issue why
 *   auto-claiming is the worse of the two repairs.
 * - *"branch wave N from wave N-1's commit"* — #420 landed `integrateWave`,
 *   which commits each wave onto the run ref in `PROJECT_ROOT` before the next
 *   wave's worktrees are cut from that checkout's HEAD, and #652 added the
 *   pre-wave re-read that refuses when the checkout has drifted off it.
 *
 * The third is the one with nothing holding it. `collectAgentWork` DOES run
 * the claim audit before the collect step is spawned — the ordering is correct
 * in today's source, and that is exactly the problem: it is correct and
 * unwitnessed, which is #530's shape. Moving the audit three statements down
 * would reinstate #1585's half-collected tree with every test in the
 * repository green.
 *
 * ## Why the control is the point of this file
 *
 * "The project root is unchanged after a refusal" is satisfied trivially by a
 * harness in which nothing ever writes. A stubbed `timedAgent` is such a
 * harness, so the assertion alone would be vacuous — #500's shape, a fixture
 * reaching its assertion by a route that bypasses the feature.
 *
 * So the stub here EXECUTES the shell the collect prompt contains, against a
 * real git repository with real worktrees. The accepted case genuinely moves
 * files and the snapshot genuinely sees it; the refused case is then a
 * measurement rather than an absence.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * The 5pm repair for "the tree is half-collected after a refusal" is to **add
 * a cleanup pass after the refusal** — walk back what was written once the
 * audit says no. It reads as atomicity and is not: it runs after the fact, it
 * cannot restore a file whose pre-collect content nobody recorded, and it is
 * silent when the walk-back itself fails.
 *
 * **I predicted AC-1 would survive it and it does not, which is a better
 * answer than the one I expected.** Both variants were applied and measured
 * (M2 and M2b below) and AC-1 is red in each. The reason is specific and
 * worth knowing rather than filing as luck: `scripts/collect-worktree-files.ts`
 * **stages** what it collects, so `git checkout -- .` restores from the INDEX
 * and puts the collected bytes straight back. Probed directly rather than
 * reasoned about — stage a changed file, run the checkout, read it back: the
 * new content is still there. The stronger `git reset -q && git checkout -- .`
 * does restore the content, and AC-1 is still red, because the snapshot
 * carries mtime and a rewrite with equal bytes is still a write.
 *
 * So AC-2 and AC-4 remain the cases that catch the wrong fix **on the
 * property** — the collect step must not run at all — while AC-1 catches it
 * through the instrument. Both are worth having and they are not the same
 * claim; a future cleanup pass that preserved mtimes would leave AC-1 green
 * with the half-collect fully reinstated.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/collect-claim-enforcement.test.ts` (56 tests).
 * Counts predicted in `/tmp/671-battery/predictions.md` before the battery
 * ran, and **the baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 56 pass, 0 fail | **56 pass, 0 fail** | — |
 * | M1 **the defect restored**: the claim refusal deferred until after the collect step is spawned | 3 | **5 of 56** | the three-worktree fixture: the original leaves the project root byte-identical, the mutant leaves it holding `CASCADE FROM 13` and a `solution-plays.json` it refused |
 * | M2 **the cheapest wrong fix**: M1 plus `git checkout -- .` after the refusal | 2 | **5 of 56** | the same fixture: the cleanup does not restore, because the collect script staged the files |
 * | M2b the same with `git reset -q && git checkout -- .` — the cleanup that does restore | not predicted | **5 of 56** | the same fixture: content is restored, mtime is not |
 * | M3 the control neutered — the harness stops executing collect commands | 1 | **1 of 56** | AC-3's accepted collection: the original rewrites `src/startup-cascade.ts`, the mutant writes nothing and the snapshot cannot see a change |
 * | M4 `auditWorktreeClaims` short-circuited to no violations | 2 + unpredicted | **10 of 56** | the same fixture: the original refuses, the mutant collects |
 *
 * **M1 came back HIGH and the battery found a real defect in this file while
 * doing it.** An earlier draft of AC-4 pinned the position of the audit CALL,
 * and M1 moves the REFUSAL and leaves the call where it was — so AC-4 was
 * **green over the exact regression it names**, which is the fifth shape with
 * the wrong fix already applied. It now pins the refusal. That is the whole
 * value of predicting a number first: 2 of my 3 showed up, and chasing the
 * missing one found a case asserting the wrong position.
 *
 * The other two extra reds in M1/M2/M2b are in
 * `test/collect-claim-enforcement.test.ts` and are the real kind — both are
 * cases about *what a refusal reports*, and a refusal that now happens after
 * a collect attempt reports the collect step's failure instead.
 *
 * **M4's 10 includes all five #228 preserve cases**, which exist only because
 * a refusal happens; with nothing refused there is nothing to preserve. Also
 * squarely about the mutated behaviour.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * `cp` backups, never `git checkout --`, and `workflows/ship.js` was confirmed
 * byte-identical by sha256 after every row.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

interface AgentCall {
  label: string;
  prompt: string;
  /** The shell the prompt told the agent to run, when it carried one. */
  command: string | null;
  /** What running it printed, for the calls this harness chose to execute. */
  ran: boolean;
}

/**
 * The shell a `Run exactly this` prompt carries, or `null`.
 *
 * Cut between the instruction and the reporting paragraph rather than taken
 * with a fixed window: a window is a guess about how long a construct stays
 * that size and it decays silently (#664).
 */
function commandIn(prompt: string): string | null {
  const open = prompt.indexOf("Run exactly this and report the result:");
  if (open < 0) return null;
  const body = prompt.slice(open + "Run exactly this and report the result:".length);
  const close = body.indexOf("\nSet ok to true");
  return close < 0 ? null : body.slice(0, close);
}

/**
 * `collectAgentWork` with the real ship.js blocks, and a `timedAgent` that
 * actually runs the collect command.
 *
 * The preserve step (#228) is answered without being run: it pushes refused
 * work onto refs, which is not this file's subject, and running it would make
 * a refusal's side effects indistinguishable from a collection's.
 */
function loadCollect(project: string, workDir: string) {
  const calls: AgentCall[] = [];
  const logs: string[] = [];
  const body = [
    block("SECURITY-HELPERS"),
    block("COLLECT-DESTINATION"),
    block("COLLECT-CLAIM"),
    block("PRESERVE-REFUSED"),
    block("COLLECT-AGENT-WORK"),
  ].join("\n");

  const collectAgentWork = new Function(
    "log",
    "timedAgent",
    "WORK_DIR",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${body}\nreturn collectAgentWork`,
  )(
    (m: string) => logs.push(String(m)),
    async (prompt: string, opts: { label: string }) => {
      const command = commandIn(prompt);
      const isPreserve = opts.label.endsWith("-preserve");
      if (isPreserve || !command) {
        calls.push({ label: opts.label, prompt, command, ran: false });
        return { preserved: [], detail: "" };
      }
      const run = spawnSync("bash", ["-c", command], { cwd: project, encoding: "utf-8" });
      calls.push({ label: opts.label, prompt, command, ran: true });
      const m = /COLLECTED (\d+)/.exec(run.stdout || "");
      return {
        ok: run.status === 0,
        collected: m ? Number(m[1]) : 0,
        detail: run.stderr || "",
      };
    },
    workDir,
    project,
    REPO_ROOT,
  ) as (
    results: unknown,
    intoDir: string,
    phaseName: string,
    label: string,
  ) => Promise<{ ok: boolean; collected: number; staged: boolean; detail?: string }>;

  return { collectAgentWork, calls, logs };
}

/** Content AND mtime for every tracked path, so a rewrite with equal bytes is still a change. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".claude") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p)] = `${readFileSync(p, "utf-8")}@${statSync(p).mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

/**
 * #1585's shape: three worktrees, and `config-templates/solution-plays.json`
 * — the file the issue is ABOUT — edited by two of them and claimed by none.
 *
 * Three and not two. `SINGLE_WORKTREE_EXEMPT` (#228) keeps every file when
 * only one worktree participates, so a smaller fixture would reach the
 * assertion without the audit being load-bearing.
 */
function plant(): { root: string; project: string; workDir: string; results: unknown[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rungate-671-")));
  const project = join(root, "project");
  const workDir = join(root, "work");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "config-templates"), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", project], { stdio: "pipe" });
  git(project, "config", "user.email", "t@example.invalid");
  git(project, "config", "user.name", "t");
  writeFileSync(join(project, "src", "startup-cascade.ts"), "base cascade\n");
  writeFileSync(join(project, "config-templates", "solution-plays.json"), "{\"base\": true}\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");

  mkdirSync(join(project, ".claude", "worktrees"), { recursive: true });
  const wts: string[] = [];
  for (const name of ["wf_13", "wf_17", "wf_21"]) {
    const wt = join(project, ".claude", "worktrees", name);
    git(project, "worktree", "add", "-q", "-b", `b-${name}`, wt);
    wts.push(wt);
  }
  const [w13, w17, w21] = wts;
  writeFileSync(join(w13, "src", "startup-cascade.ts"), "CASCADE FROM 13\n");
  writeFileSync(join(w17, "config-templates", "solution-plays.json"), "{\"from\": 17}\n");
  writeFileSync(join(w21, "config-templates", "solution-plays.json"), "{\"from\": 21}\n");

  return {
    root,
    project,
    workDir,
    results: [
      { worktreePath: w13, filesChanged: ["src/startup-cascade.ts"], claimedFiles: ["src/startup-cascade.ts"] },
      // The issue's own central file, reported by two worktrees and claimed
      // by neither. Not an overlap the collector can resolve — a claim that
      // was never registered.
      { worktreePath: w17, filesChanged: ["config-templates/solution-plays.json"], claimedFiles: ["src/other.ts"] },
      { worktreePath: w21, filesChanged: ["config-templates/solution-plays.json"], claimedFiles: ["src/third.ts"] },
    ],
  };
}

describe("#671 / SC-413: a refused collection leaves the project root exactly as it found it", () => {
  let planted: ReturnType<typeof plant>;

  beforeEach(() => {
    planted = plant();
  });
  afterEach(() => {
    if (planted?.root) rmSync(planted.root, { recursive: true, force: true });
  });

  test("AC-1: the refusal reports #1585's unclaimed file and changes nothing on disk", async () => {
    const before = snapshot(planted.project);
    // Compared to what it WAS, not to clean: the fixture's own `.claude`
    // worktree directory is untracked, so asserting an empty status would
    // measure the fixture rather than the refusal.
    const statusBefore = git(planted.project, "status", "--porcelain");
    const { collectAgentWork } = loadCollect(planted.project, planted.workDir);

    const out = await collectAgentWork(planted.results, planted.project, "Commit", "collect-1");

    expect(out.ok, "a collection with an unclaimed file was accepted").toBe(false);
    expect(out.staged).toBe(false);
    expect(out.detail, "the refusal does not name the unclaimed file").toContain(
      "config-templates/solution-plays.json",
    );

    expect(
      snapshot(planted.project),
      "the refusal left the project root carrying work it refused to collect (#671)",
    ).toEqual(before);
    expect(
      git(planted.project, "status", "--porcelain"),
      "the refusal left the tree in a different state than it found it",
    ).toBe(statusBefore);
  });

  test("AC-2: the collect step is never spawned, so there is nothing to walk back", async () => {
    // The half of the pair the cheapest wrong fix does not survive. A cleanup
    // pass added after the refusal leaves the tree looking restored, so AC-1
    // is satisfied by it — this is not.
    const { collectAgentWork, calls } = loadCollect(planted.project, planted.workDir);
    await collectAgentWork(planted.results, planted.project, "Commit", "collect-2");

    const collectCalls = calls.filter(c => !c.label.endsWith("-preserve"));
    expect(
      collectCalls.map(c => c.label),
      "the refusal spawned the collect step it was refusing",
    ).toEqual([]);
    expect(calls.some(c => c.label.endsWith("-preserve")), "refused work was not preserved (#228)").toBe(true);
  });

  test("AC-3: the control — an accepted collection DOES move files, so the snapshot can see a change", async () => {
    // Without this the two cases above are satisfied by a harness in which
    // nothing ever writes (#500). The claim is registered and nothing else
    // about the fixture changes.
    const before = snapshot(planted.project);
    // wf_13 unchanged; wf_17 now CLAIMS the file it edits; wf_21 contributes
    // nothing, because two worktrees claiming one file is a different
    // refusal (SC-411's) and would make this control measure that instead.
    const raw = planted.results as Array<{ claimedFiles: string[]; filesChanged: string[] }>;
    const results = [
      raw[0],
      { ...raw[1], claimedFiles: [...raw[1].filesChanged] },
      { ...raw[2], claimedFiles: [], filesChanged: [] },
    ];
    const { collectAgentWork, calls } = loadCollect(planted.project, planted.workDir);

    const out = await collectAgentWork(results, planted.project, "Commit", "collect-3");

    expect(out.ok, `the control collection was refused: ${out.detail}`).toBe(true);
    expect(out.collected).toBeGreaterThan(0);
    expect(calls.some(c => c.ran), "no collect command was actually executed").toBe(true);

    const after = snapshot(planted.project);
    expect(after, "the accepted collection changed nothing — the instrument is blind").not.toEqual(before);
    expect(readFileSync(join(planted.project, "src", "startup-cascade.ts"), "utf-8")).toBe(
      "CASCADE FROM 13\n",
    );
  });

  test("AC-4: the audit is positioned above the spawn, and there is one of it", async () => {
    // AC-2 observes the order through behaviour; this pins it in the source,
    // because a reordering is the regression and behaviour alone cannot say
    // whether the next edit moved the audit or merely made it pass.
    // The REFUSAL, not the audit call. Row M1 of the battery below moved the
    // refusal and left the call where it was — the #1585 tree, restored —
    // and an earlier draft of this case stayed GREEN over it, because the
    // call is not the thing that has to come first. A position assertion is
    // only worth what it points at.
    const collect = block("COLLECT-AGENT-WORK");
    const refusal = collect.indexOf("unclaimed file modification(s) (#178, SC-413)");
    const spawn = collect.indexOf("await timedAgent(");
    expect(refusal, "the collect step no longer refuses unclaimed modifications").toBeGreaterThan(-1);
    expect(spawn, "the collect step no longer spawns anything").toBeGreaterThan(-1);
    expect(
      refusal,
      "the claim refusal is reached AFTER the collect step is spawned — #1585's half-collected tree (#671)",
    ).toBeLessThan(spawn);
    expect(
      collect.split("auditWorktreeClaims(results)").length - 1,
      "two audits of the same question — a mutation of either leaves the other holding the case up",
    ).toBe(1);
  });
});
