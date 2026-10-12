/**
 * #213 — the ship gate's auto-push swallowed every failure.
 *
 * `generateShipEvidence` ended with five statements inside `try { … } catch {}`,
 * and `runGate` calls it only once the ship gate has recorded PASS. So a
 * rejected push left a run reporting success with the commit on the local
 * branch and nothing, anywhere, saying so.
 *
 * ## What is driven rather than described
 *
 * The unit half exercises `classifyPush`, which is pure, so every branch is
 * reachable — including the ones a healthy repo never produces.
 *
 * The integration half builds a real temp repo with a real `origin` and makes
 * the push fail for real: a second clone advances the remote, so the local
 * push is a genuine non-fast-forward rejection from git, not a stubbed error.
 *
 * ## The mutation (#213's fifth criterion)
 *
 * The remote-SHA read-back is the assertion this issue turns on, and "the
 * push exited 0" is exactly what it must stop trusting. So the mutation is
 * performed, not asserted: a `git` shim is placed ahead of the real git on
 * PATH which exits 0 on `push` and delegates everything else. Under it the
 * push reports success and the remote is untouched, and the outcome must be
 * `unconfirmed`. If the read-back were removed — or if the shim were not in
 * effect — that case would report `pushed` and go red.
 *
 * Running the mutation here rather than recording a count in the PR body
 * means it is re-measured on every suite run, per
 * .claude/rules/checks-must-be-able-to-fail.md.
 *
 * Covers SC-714, SC-715, SC-716, SC-717, SC-718, SC-719, SC-720, SC-721,
 * SC-722 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  classifyPush,
  parseLsRemoteSha,
  verifiedPush,
  leftWorkLocal,
  OUTCOMES_LEAVING_WORK_LOCAL,
  redactSecrets,
  type PushReadings,
  type Reading,
} from "../lib/verified-push";
import {
  readConformityFindings,
  unreadableConformityMarker,
  conformityFindingsUnreadable,
} from "../gates/gate-executor";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";
import { stripJsComments } from "../lib/strip-js-comments";

const ok = (output = ""): Reading => ({ ok: true, output });
const bad = (output = "boom"): Reading => ({ ok: false, output });

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

/** A healthy set of readings: on a branch, upstream set, one commit ahead. */
function healthy(over: Partial<PushReadings> = {}): PushReadings {
  return {
    branch: ok("feature\n"),
    remoteName: ok("origin\n"),
    remoteRef: ok("refs/heads/feature\n"),
    ahead: ok("1\n"),
    localSha: ok(`${SHA}\n`),
    push: ok(""),
    remote: ok(`${SHA}\trefs/heads/feature\n`),
    ...over,
  };
}

describe("#213: classifyPush names every way a push can leave work local", () => {
  test("a confirmed push is the only success", () => {
    const o = classifyPush(healthy());
    expect(o.kind).toBe("pushed");
    expect(leftWorkLocal(o)).toBe(false);
  });

  test("no upstream is reported as no upstream, not as nothing to push", () => {
    // The original read the rev-list failure through an empty catch, so the
    // branch that has NEVER been pushed was the one that passed silently.
    const o = classifyPush(healthy({ remoteName: bad(""), ahead: bad("no upstream") }));
    expect(o.kind).toBe("no-upstream");
    expect(o.detail).toContain("nothing on it has been pushed");
  });

  test("a detached HEAD is no-upstream, not a crash", () => {
    const o = classifyPush(healthy({ branch: bad("fatal: ref HEAD is not a symbolic ref") }));
    expect(o.kind).toBe("no-upstream");
    expect(o.detail).toContain("detached");
  });

  test("a configured remote with no merge ref is still no upstream", () => {
    // Half-configured tracking is a real state: `git config branch.x.remote`
    // set by hand without `branch.x.merge`. Treating it as configured would
    // send the push to an empty refspec.
    const o = classifyPush(healthy({ remoteRef: ok("  \n") }));
    expect(o.kind).toBe("no-upstream");
  });

  test("a non-numeric ahead-count is UNMEASURED, not zero", () => {
    // `parseInt("") → NaN`, `NaN > 0 → false`. The original skipped the push.
    const o = classifyPush(healthy({ ahead: ok("\n") }));
    expect(o.kind).toBe("unmeasured");
    expect(o.detail).toContain("parseInt");
  });

  test("a garbled ahead-count is UNMEASURED too", () => {
    const o = classifyPush(healthy({ ahead: ok("warning: something\n") }));
    expect(o.kind).toBe("unmeasured");
  });

  test("an ahead-count command that failed is UNMEASURED", () => {
    const o = classifyPush(healthy({ ahead: bad("fatal: bad revision") }));
    expect(o.kind).toBe("unmeasured");
    expect(o.detail).toContain("unknown reason");
  });

  test("an unreadable HEAD refuses before anything is compared", () => {
    const o = classifyPush(healthy({ localSha: bad("fatal: not a git repository") }));
    expect(o.kind).toBe("unmeasured");
  });

  test("a HEAD that is not a sha is UNMEASURED, not a sha to compare against", () => {
    // An empty or prose output compared equal to an empty ls-remote parse
    // would be the vacuous-assertion shape: two unknowns matching.
    const o = classifyPush(healthy({ localSha: ok("HEAD\n") }));
    expect(o.kind).toBe("unmeasured");
  });

  test("zero ahead is nothing-to-push, and that is not a failure", () => {
    const o = classifyPush(healthy({ ahead: ok("0\n"), push: null, remote: null }));
    expect(o.kind).toBe("nothing-to-push");
    expect(leftWorkLocal(o)).toBe(false);
  });

  test("commits ahead with no push attempted is its own outcome", () => {
    const o = classifyPush(healthy({ push: null, remote: null }));
    expect(o.kind).toBe("not-attempted");
    expect(leftWorkLocal(o)).toBe(true);
  });

  test("a rejected push is reported with git's own reason", () => {
    const o = classifyPush(healthy({ push: bad("! [rejected] feature -> feature (fetch first)") }));
    expect(o.kind).toBe("rejected");
    expect(o.detail, "the rejection reason is dropped, which is what stdio:pipe did")
      .toContain("[rejected]");
  });

  test("a push that exited 0 against a remote still at the old sha is unconfirmed", () => {
    // #213's first criterion. The case the whole issue turns on: git said yes and the
    // commit is not there.
    const o = classifyPush(healthy({ remote: ok(`${OTHER_SHA}\trefs/heads/feature\n`) }));
    expect(o.kind).toBe("unconfirmed");
    expect(o.detail).toContain("is not on the remote");
  });

  test("a push that exited 0 with an unreadable remote is unconfirmed, not pushed", () => {
    const o = classifyPush(healthy({ remote: bad("fatal: could not read from remote") }));
    expect(o.kind).toBe("unconfirmed");
    expect(o.detail).toContain("not a successful push");
  });

  test("a push that exited 0 with no ls-remote attempted is unconfirmed", () => {
    const o = classifyPush(healthy({ remote: null }));
    expect(o.kind).toBe("unconfirmed");
  });

  test("ls-remote naming a DIFFERENT ref does not count as confirmation", () => {
    // A detector narrower than what it detects, inverted: matching the sha
    // anywhere in the output would accept a tag or another branch at that sha.
    const o = classifyPush(healthy({ remote: ok(`${SHA}\trefs/heads/other\n`) }));
    expect(o.kind).toBe("unconfirmed");
  });

  test("parseLsRemoteSha reads the named ref and ignores the rest", () => {
    const out = `${OTHER_SHA}\trefs/heads/main\n${SHA}\trefs/heads/feature\n`;
    expect(parseLsRemoteSha(out, "refs/heads/feature")).toBe(SHA);
    expect(parseLsRemoteSha(out, "refs/heads/missing")).toBeNull();
    expect(parseLsRemoteSha("", "refs/heads/feature")).toBeNull();
  });

  test("every outcome kind is classified as local-or-not exactly once", () => {
    // An added kind that nobody listed would default to "fine", which is the
    // fail-open this issue is about, one level up.
    const kinds = [
      "pushed", "nothing-to-push", "no-upstream", "unmeasured",
      "not-attempted", "rejected", "unconfirmed",
    ];
    for (const k of OUTCOMES_LEAVING_WORK_LOCAL) {
      expect(kinds, `${k} is in the local set but is not a known outcome kind`).toContain(k);
    }
    expect([...OUTCOMES_LEAVING_WORK_LOCAL].sort()).toEqual(
      ["no-upstream", "not-attempted", "rejected", "unconfirmed", "unmeasured"],
    );
  });
});

describe("#213: a recorded outcome does not carry credentials", () => {
  // Every `detail` ends up in ship-evidence.json, which is durable, and git
  // quotes the remote URL when authentication fails. An HTTPS remote with an
  // embedded PAT would otherwise write that PAT into the artefact.
  const PAT = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  test("userinfo in a URL is stripped", () => {
    const line = `fatal: Authentication failed for 'https://jhorn:${PAT}@github.com/o/r.git/'`;
    const out = redactSecrets(line);
    expect(out).not.toContain(PAT);
    expect(out).not.toContain("jhorn:");
    // Narrow, not scorched: the host still has to be identifiable.
    expect(out).toContain("github.com/o/r.git");
  });

  test("userinfo that is not token-shaped is stripped by the URL rule alone", () => {
    // The two rules overlap on a PAT in a URL, so without this case the
    // userinfo rule could be deleted and only one assertion would notice.
    const out = redactSecrets("fatal: cannot access 'https://jhorn:hunter2@git.example/o/r'");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("jhorn");
    expect(out).toContain("git.example/o/r");
  });

  test("a bare token outside a URL is stripped too", () => {
    expect(redactSecrets(`remote: token ${PAT} is invalid`)).not.toContain(PAT);
    expect(redactSecrets("github_pat_11ABCDEFG0abcdefghijkl")).toBe("<redacted-token>");
  });

  test("an ordinary remote URL is left alone", () => {
    // A redactor that mangles every URL would make the recorded reason
    // useless, which is the failure mode opposite to the one above.
    const url = "https://github.com/hornjason/pai-harness.git";
    expect(redactSecrets(`fatal: could not read from '${url}'`)).toContain(url);
    expect(redactSecrets("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  test("a rejected push's recorded detail is redacted", () => {
    // The redaction is applied in classifyPush, not only in the git runner,
    // so this holds for readings built any way at all. Asserted through the
    // real recording path rather than against the helper alone.
    const o = classifyPush(
      healthy({ push: bad(`fatal: Authentication failed for 'https://x:${PAT}@github.com/o/r'`) }),
    );
    expect(o.kind).toBe("rejected");
    expect(JSON.stringify(o)).not.toContain(PAT);
  });

  test("a remote NAME that is a URL with credentials is redacted", () => {
    // `branch.<b>.remote` holds a name by convention; a URL is legal there.
    const o = classifyPush(
      healthy({ remoteName: ok(`https://x:${PAT}@github.com/o/r\n`), remote: bad("nope") }),
    );
    expect(JSON.stringify(o)).not.toContain(PAT);
  });
});

describe("#213: the gate's call site does not widen what the push trusts", () => {
  // Security review raised three things about this change. Two of them are
  // about the call site rather than the library, so they are pinned here
  // where a later edit has to move them deliberately.
  const SITE = readFileSync(join(import.meta.dir, "..", "gates", "orchestrator.ts"), "utf-8");
  const CODE = stripJsComments(SITE);

  test("the push runs in process.cwd(), not a tree named by workflow-state.json", () => {
    // `mergeCommitSha` in the same evidence object comes from `gitSha()` with
    // no argument, which is process.cwd(). A push against `state.projectRoot`
    // would confirm a remote for a SHA this artefact never measured — and it
    // would let a field in a state file choose which repository a privileged
    // operation runs against, which the code this replaced did not do.
    //
    // Comments stripped: the reasoning above is also written beside the call,
    // and a detector reading raw source would find `state.projectRoot` there
    // and report the defect its own explanation describes.
    expect(CODE).toMatch(/verifiedPush\(process\.cwd\(\)/);
    const call = CODE.slice(CODE.indexOf("verifiedPush("), CODE.indexOf("verifiedPush(") + 200);
    expect(call, "the push target is read out of the state file").not.toContain("projectRoot");
  });

  test("the env passed in is process.env plus the one flag, nothing else", () => {
    expect(CODE).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*GATE_PASSED_PUSH:\s*"1",?\s*\}/);
  });

  test("GATE_PASSED_PUSH is still set, because the pre-push hook reads it", () => {
    // #213's body says it is "set here and read nowhere". It is read.
    const hook = readFileSync(
      join(import.meta.dir, "..", "scripts", "git-hooks", "pre-push"), "utf-8",
    );
    expect(hook).toContain("process.env.GATE_PASSED_PUSH");
    expect(CODE).toContain("GATE_PASSED_PUSH");
  });

  test("an unexpected throw is recorded as UNMEASURED, not allowed to crash the run", () => {
    // The code this replaced was `try { … } catch {}`: wrong about the
    // swallowing, right that post-verdict bookkeeping must not crash a run
    // that has already passed. Both properties now hold at once.
    const guarded = CODE.slice(CODE.indexOf("let pushOutcome"), CODE.indexOf("const evidence"));
    expect(guarded).toMatch(/try\s*\{/);
    expect(guarded).toContain('kind: "unmeasured"');
    expect(guarded, "an empty catch is back").not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });
});

// ── Integration: a real temp repo with a real rejecting remote ─────────────

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();

let TMP = "";
let CLEAN_ENV: NodeJS.ProcessEnv = {};
let SHIM_ENV: NodeJS.ProcessEnv = {};

/**
 * A `git` that exits 0 on push and delegates everything else.
 *
 * This is the mutation, performed rather than asserted (#213's fifth criterion). Under it the
 * push claims success and the remote never moves, which is precisely the
 * state the old code could not distinguish from a real push.
 */
function buildPushNoopShim(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "push" ]; then exit 0; fi\ndone\nexec ${REAL_GIT} "$@"\n`,
  );
  chmodSync(shim, 0o755);
}

function makeRepo(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "rungate-213-"));
  const shimDir = join(TMP, "shim");
  buildPushNoopShim(shimDir);
  // A pristine PATH for the control runs, so "the shim was in effect" and
  // "the shim was not" differ by exactly one entry and nothing else.
  CLEAN_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  SHIM_ENV = { ...CLEAN_ENV, PATH: `${shimDir}:${process.env.PATH ?? ""}` };
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

/** origin (bare) + a clone with one unpushed commit on `main`. */
function repoWithUnpushedCommit(name: string): { work: string; origin: string } {
  const origin = makeRepo(`${name}-origin.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });

  const seed = makeRepo(`${name}-seed`);
  initFixtureRepo(seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  commitFixture(seed, "seed");
  execFileSync("git", ["-C", seed, "remote", "add", "origin", origin], { stdio: "pipe" });
  execFileSync("git", ["-C", seed, "push", "-u", "origin", "main"], { stdio: "pipe" });

  const work = makeRepo(`${name}-work`);
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  execFileSync("git", ["-C", work, "config", "user.email", "fixtures@rungate.invalid"], { stdio: "pipe" });
  execFileSync("git", ["-C", work, "config", "user.name", "rungate fixtures"], { stdio: "pipe" });
  execFileSync("git", ["-C", work, "config", "commit.gpgsign", "false"], { stdio: "pipe" });
  writeFileSync(join(work, "work.txt"), "local only\n");
  commitFixture(work, "local work");

  return { work, origin };
}

const remoteHead = (origin: string) =>
  execFileSync("git", ["-C", origin, "rev-parse", "refs/heads/main"], { encoding: "utf-8" }).trim();
const localHead = (work: string) =>
  execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

describe("#213: verifiedPush against a real remote", () => {
  test("a push that genuinely lands is confirmed by reading the remote back", () => {
    const { work, origin } = repoWithUnpushedCommit("happy");
    const outcome = verifiedPush(work, { env: CLEAN_ENV });

    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("pushed");
    expect(leftWorkLocal(outcome)).toBe(false);
    // Measured on the remote, not taken from the function's own report.
    expect(remoteHead(origin)).toBe(localHead(work));
  });

  test("a second call on the same branch is nothing-to-push, not a failure", () => {
    const { work } = repoWithUnpushedCommit("idempotent");
    expect(verifiedPush(work, { env: CLEAN_ENV }).kind).toBe("pushed");
    const again = verifiedPush(work, { env: CLEAN_ENV });
    expect(again.kind, `detail: ${again.detail}`).toBe("nothing-to-push");
  });

  test("a non-fast-forward rejection is recorded, not swallowed (#213's fourth criterion)", () => {
    const { work, origin } = repoWithUnpushedCommit("rejected");

    // Advance the remote from somewhere else, so the local push is a genuine
    // rejection produced by git rather than a stubbed failure.
    const other = makeRepo("rejected-other");
    execFileSync("git", ["clone", origin, other], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "config", "user.email", "fixtures@rungate.invalid"], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "config", "user.name", "rungate fixtures"], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "config", "commit.gpgsign", "false"], { stdio: "pipe" });
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    commitFixture(other, "their work");
    execFileSync("git", ["-C", other, "push", "origin", "main"], { stdio: "pipe" });
    const advanced = remoteHead(origin);

    const outcome = verifiedPush(work, { env: CLEAN_ENV });

    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("rejected");
    expect(leftWorkLocal(outcome)).toBe(true);
    expect(outcome.detail.toLowerCase()).toContain("reject");
    // The commit really is still only local — the point of the issue.
    expect(remoteHead(origin)).toBe(advanced);
    expect(localHead(work)).not.toBe(advanced);
  });

  test("a branch with no upstream refuses rather than reporting success", () => {
    const { work } = repoWithUnpushedCommit("no-upstream");
    execFileSync("git", ["-C", work, "checkout", "-b", "orphan-branch"], { stdio: "pipe" });

    const outcome = verifiedPush(work, { env: CLEAN_ENV });
    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("no-upstream");
    expect(leftWorkLocal(outcome)).toBe(true);
  });

  test("a detached HEAD refuses rather than reporting success", () => {
    const { work } = repoWithUnpushedCommit("detached");
    execFileSync("git", ["-C", work, "checkout", "--detach", "HEAD"], { stdio: "pipe" });

    const outcome = verifiedPush(work, { env: CLEAN_ENV });
    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("no-upstream");
  });

  test("a directory that is not a repo is UNMEASURED, not clean", () => {
    const outcome = verifiedPush(makeRepo("not-a-repo"), { env: CLEAN_ENV });
    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("unmeasured");
    expect(leftWorkLocal(outcome)).toBe(true);
  });

  test("MUTATION: a git push that exits 0 and does nothing is caught (#213's fifth criterion)", () => {
    // Removing the ls-remote read-back, or trusting the push's exit code,
    // makes this report `pushed`. It is the one assertion the issue is about,
    // and it is driven rather than described.
    const { work, origin } = repoWithUnpushedCommit("noop-push");
    const before = remoteHead(origin);

    const outcome = verifiedPush(work, { env: SHIM_ENV });

    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("unconfirmed");
    expect(leftWorkLocal(outcome)).toBe(true);
    // The shim really was in effect: the remote did not move, and the local
    // branch is still ahead. Without this a shim that silently failed to load
    // would make the assertion above fail for the right reason by accident —
    // or, if the read-back were later removed, pass for the wrong one.
    expect(remoteHead(origin), "the shim did not intercept the push").toBe(before);
    expect(localHead(work)).not.toBe(before);
    if (outcome.kind === "unconfirmed") {
      expect(outcome.remoteSha).toBe(before);
      expect(outcome.sha).toBe(localHead(work));
    }
  });

  test("CONTROL: the same repo and the same call without the shim pushes", () => {
    // The mutation above is only evidence if the unmutated run differs. One
    // PATH entry is the entire difference between the two.
    const { work, origin } = repoWithUnpushedCommit("noop-control");
    const before = remoteHead(origin);

    const outcome = verifiedPush(work, { env: CLEAN_ENV });

    expect(outcome.kind, `detail: ${outcome.detail}`).toBe("pushed");
    expect(remoteHead(origin)).not.toBe(before);
  });
});

// ── #213's third criterion: the conformity findings reader ───────────────────────────────────

describe("#213: an unreadable conformity findings file is not an empty one", () => {
  function stateWith(contents: string | null): Record<string, any> {
    const root = makeRepo(`conformity-${Math.abs(hash(contents ?? "absent"))}`);
    if (contents !== null) {
      mkdirSync(join(root, ".rungate"), { recursive: true });
      writeFileSync(join(root, ".rungate", "conformity-findings.json"), contents);
    }
    return { projectRoot: root };
  }
  // Date.now()/Math.random() are avoided so the fixture dirs stay deterministic.
  function hash(s: string): number {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
    return h;
  }

  test("valid findings are recorded as themselves", () => {
    const state = stateWith(JSON.stringify({ total: 0, failures: 0, warnings: 0 }));
    readConformityFindings(state);
    expect(conformityFindingsUnreadable(state.conformityFindings)).toBe(false);
    expect(state.conformityFindings.total).toBe(0);
  });

  test("an absent file leaves the field absent — nothing was claimed", () => {
    const state = stateWith(null);
    readConformityFindings(state);
    expect(state.conformityFindings).toBeUndefined();
  });

  test("a malformed file sets the unreadable marker, not undefined", () => {
    // Before this, the catch was empty: the field stayed absent and every
    // consumer's `if (state.conformityFindings)` read it as "no findings".
    const state = stateWith("{ not json at all");
    readConformityFindings(state);
    expect(state.conformityFindings).toBeDefined();
    expect(conformityFindingsUnreadable(state.conformityFindings)).toBe(true);
    expect(state.conformityFindings.path).toContain("conformity-findings.json");
  });

  test("the marker is distinguishable from an empty findings list", () => {
    const empty = stateWith(JSON.stringify({ total: 0, findings: [] }));
    readConformityFindings(empty);
    const broken = stateWith("}{");
    readConformityFindings(broken);

    expect(conformityFindingsUnreadable(empty.conformityFindings)).toBe(false);
    expect(conformityFindingsUnreadable(broken.conformityFindings)).toBe(true);
    expect(empty.conformityFindings).not.toEqual(broken.conformityFindings);
  });

  test("the marker withholds the parse message, which quotes file contents", () => {
    // The file is machine-written from a scan of the project, so a parse error
    // can carry source text into workflow-state.json. The error's NAME is
    // enough to tell a parse failure from a read failure.
    const leak = `{ "token": ghp_notarealtokenbutlooksliketone }`;
    const err = (() => { try { JSON.parse(leak); return null; } catch (e) { return e; } })();
    expect(err, "the fixture must actually fail to parse").not.toBeNull();
    expect(
      String((err as Error).message),
      "the fixture does not reproduce the leak it exists to test",
    ).toContain("ghp_notarealtokenbutlooksliketone");

    const marker = unreadableConformityMarker("/tmp/x.json", err);
    expect(JSON.stringify(marker)).not.toContain("ghp_notarealtokenbutlooksliketone");
    expect(marker.reason).toBe("SyntaxError");
  });

  test("an existing findings value is not overwritten by the marker", () => {
    const state = stateWith("nope");
    state.conformityFindings = { total: 3 };
    readConformityFindings(state);
    expect(state.conformityFindings).toEqual({ total: 3 });
  });
});
