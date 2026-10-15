/**
 * #213 — the ship gate's auto-push, with every failure mode named.
 *
 * The code this replaces was five statements wrapped in `try { … } catch {}`.
 * It ran at the very end of `generateShipEvidence`, which `runGate` calls only
 * once the ship gate has already decided PASS — so nothing downstream looks at
 * it, and four distinct ways for it to leave the work on the local machine all
 * produced the same observable outcome as success:
 *
 *   - the push was rejected (non-fast-forward, a pre-receive hook, no network);
 *   - the branch had no upstream, so `rev-list @{upstream}..HEAD` exited
 *     non-zero and the catch swallowed it before the push was even attempted;
 *   - `rev-list` printed something non-numeric, and `parseInt(x) > 0` is false
 *     for NaN, so the push was skipped as if there were nothing to push;
 *   - the push "succeeded" against a remote that did not end up carrying the
 *     commit, with `stdio: "pipe"` discarding whatever git said about it.
 *
 * This is not the same reading `unpushedViolations` in gates/workflow.test.ts
 * takes for the `code-pushed` check, and it does not make that one redundant.
 * That one runs during the gate and compares HEAD against `@{upstream}`, a
 * LOCAL remote-tracking ref that only fetch and push update. This one runs
 * after the gate's verdict and asks the remote directly, with `ls-remote`,
 * because the question here is "did the commit leave the machine" and a local
 * ref cannot answer it.
 *
 * ## Shape
 *
 * `classifyPush` is pure and total: it takes the readings and returns exactly
 * one outcome. The git invocations live in `verifiedPush`, so every branch —
 * including the ones a healthy repo never reaches — is reachable in a test
 * without a network, and the interesting ones are additionally driven against
 * a real temp repo with a real rejecting remote in test/gate-auto-push.test.ts.
 *
 * Nothing here throws. The caller is a post-verdict bookkeeping step and must
 * not be able to crash a run that has already passed; the point of the change
 * is that the failure is now RECORDED rather than that it is now fatal.
 */

import { execFileSync } from "child_process";

/** One git invocation's result. `ok` is "exited zero", never "looks sensible". */
export interface Reading {
  ok: boolean;
  output: string;
}

/**
 * Everything `classifyPush` is allowed to look at.
 *
 * `push` and `remote` are nullable because they describe steps that may never
 * have been attempted — and "not attempted" has to be distinguishable from
 * "attempted and came back empty", which is the distinction the empty catch
 * destroyed.
 */
export interface PushReadings {
  /** `git symbolic-ref --short HEAD`, or a failed reading on a detached HEAD. */
  branch: Reading;
  /** `git config --get branch.<b>.remote` — absent means no upstream is configured. */
  remoteName: Reading;
  /** `git config --get branch.<b>.merge` — the full ref name on the remote. */
  remoteRef: Reading;
  /** `git rev-list --count @{upstream}..HEAD`. */
  ahead: Reading;
  /** `git rev-parse HEAD`. */
  localSha: Reading;
  /** The push itself, or null when it was never attempted. */
  push: Reading | null;
  /** `git ls-remote <remote> <ref>`, or null when it was never attempted. */
  remote: Reading | null;
}

export type PushOutcome =
  /** The remote was read back and carries the local HEAD. The only success. */
  | { kind: "pushed"; sha: string; remote: string; detail: string }
  /** The upstream already had HEAD. Nothing was pushed and nothing is missing. */
  | { kind: "nothing-to-push"; sha: string; detail: string }
  /** No upstream is configured, so nothing on this branch has been pushed. */
  | { kind: "no-upstream"; detail: string }
  /** A git read failed or printed something that is not a count. UNMEASURED. */
  | { kind: "unmeasured"; detail: string }
  /** Commits are ahead and no push was attempted. */
  | { kind: "not-attempted"; sha: string; ahead: number; detail: string }
  /** The push ran and exited non-zero. */
  | { kind: "rejected"; detail: string }
  /** The push exited zero and the remote does not carry HEAD. */
  | { kind: "unconfirmed"; sha: string; remoteSha: string | null; detail: string }
  /** The upstream names a ref other than the branch's own. Nothing was pushed. */
  | { kind: "ref-mismatch"; branch: string; remoteRef: string; detail: string }
  /** The caller expected a different repository than the tree's origin. */
  | { kind: "repo-mismatch"; expected: string; actual: string | null; detail: string };

/**
 * The outcomes that mean a commit this run reported on may not be on the
 * remote. Exported so the caller states the rule once rather than spelling out
 * a list of string literals that drifts the first time a kind is added.
 */
export const OUTCOMES_LEAVING_WORK_LOCAL: ReadonlySet<PushOutcome["kind"]> = new Set([
  "no-upstream",
  "unmeasured",
  "not-attempted",
  "rejected",
  "unconfirmed",
  "ref-mismatch",
  "repo-mismatch",
]);

export function leftWorkLocal(outcome: PushOutcome): boolean {
  return OUTCOMES_LEAVING_WORK_LOCAL.has(outcome.kind);
}

/**
 * The `owner/name` a git remote URL points at, or `null` if it names none.
 *
 * Returns `null` rather than a best guess for anything it cannot parse —
 * including the filesystem paths every fixture in the suite uses as its
 * origin. `repoMatches` turns `null` into "does not match", so an
 * unrecognised remote refuses a push instead of permitting one, which is the
 * direction this is allowed to be wrong in (#430).
 */
export function parseRemoteSlug(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // scp-style (`git@host:owner/name.git`) and URL-style, with any userinfo —
  // which is where a token lives on an HTTPS remote — discarded.
  const m = trimmed.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]*@)?[^/:]+[:/](.+?)(?:\.git)?\/?$/i);
  const path = m?.[1];
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/** Whether a remote URL names the given `owner/name`. Unparseable matches nothing. */
export function repoMatches(url: string, slug: string): boolean {
  const parsed = parseRemoteSlug(url);
  return parsed !== null && parsed === slug.trim().toLowerCase();
}

/**
 * The `owner/name` of a tree's `origin`, or `null` when it cannot be read.
 *
 * `config --get remote.origin.url` rather than `remote get-url origin`: the
 * latter applies `url.<base>.insteadOf` rewrites, which are a local transport
 * alias — a mirror, a proxy, a cache — and not a statement about which
 * project this is. A developer who rewrites GitHub to an internal mirror has
 * not changed what repository they are shipping, and reading the rewritten
 * value would refuse their every push.
 */
export function originSlug(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const r = runner(cwd, env)(["config", "--get", "remote.origin.url"], 5000);
  return r.ok ? parseRemoteSlug(r.output) : null;
}

/** The sha `ls-remote` reports for a ref, or null if its output names none. */
export function parseLsRemoteSha(output: string, ref: string): string | null {
  for (const line of output.split("\n")) {
    const [sha, name] = line.split("\t");
    if (!sha || !name) continue;
    if (name.trim() === ref) return sha.trim();
  }
  return null;
}

/**
 * Turn the readings into exactly one outcome.
 *
 * Order matters and is the opposite of the original's: the cheap reads that
 * can invalidate everything downstream are checked first, so a missing
 * upstream is reported as a missing upstream rather than surfacing later as a
 * confusing push failure.
 */
export function classifyPush(raw: PushReadings): PushOutcome {
  // Every `detail` below interpolates git's own output, and every `detail`
  // ends up in ship-evidence.json. Redacting once here rather than at each
  // interpolation means a `detail` added later cannot forget to do it — and
  // it holds for callers that build readings by hand, not only for the ones
  // that came through `runner`.
  const r = redactReadings(raw);

  if (!r.localSha.ok || !/^[0-9a-f]{7,64}$/i.test(r.localSha.output.trim())) {
    return {
      kind: "unmeasured",
      detail: `HEAD could not be read (${r.localSha.output.trim() || "no output"}), so there is ` +
        `nothing to compare the remote against. UNMEASURED is not PASS.`,
    };
  }
  const sha = r.localSha.output.trim();

  if (!r.branch.ok || r.branch.output.trim() === "") {
    return {
      kind: "no-upstream",
      detail: "HEAD is detached, so there is no branch to push and nothing on it has been " +
        "pushed. This is the worst case for this check, not an exemption from it.",
    };
  }
  const branch = r.branch.output.trim();

  if (!r.remoteName.ok || r.remoteName.output.trim() === "" ||
      !r.remoteRef.ok || r.remoteRef.output.trim() === "") {
    return {
      kind: "no-upstream",
      detail: `branch ${branch} has no upstream configured, so nothing on it has been pushed. ` +
        `A remediation re-push uses \`git push origin HEAD:<branch>\`, which does not set ` +
        `upstream, so this is reachable on any run that needed one (#174).`,
    };
  }
  const remoteName = r.remoteName.output.trim();
  const remoteRef = r.remoteRef.output.trim();
  const upstream = `${remoteName} ${remoteRef}`;

  // #429 — the push below is `HEAD:${remoteRef}`, and `remoteRef` is whatever
  // `branch.<b>.merge` says. `git checkout -b <name> origin/main`, the
  // ordinary way to start work here, sets that to `refs/heads/main` — so an
  // unattended auto-push on a feature branch wrote `main` and reported a
  // verified success, which it was, to the wrong ref. Four `wip:` commits
  // reached origin/main that way on 2026-10-15 from a session that never ran
  // `git push`.
  //
  // Refusing rather than rewriting the target: a branch whose upstream names
  // a different ref may well be deliberate — this repo has several — and
  // guessing which the operator meant is the kind of repair
  // `.claude/rules/checks-must-be-able-to-fail.md` warns about. This is
  // bookkeeping, not a gate, so the refusal costs a manual `git push` and
  // `leftWorkLocal` already says the work may be local.
  if (remoteRef !== `refs/heads/${branch}`) {
    return {
      kind: "ref-mismatch",
      branch,
      remoteRef,
      detail: `branch ${branch} is configured to track ${upstream}, so an auto-push would write ` +
        `${remoteRef} from a branch that is not it. Nothing was pushed. This is usually a branch ` +
        `created with \`git checkout -b ${branch} origin/main\`, which sets the upstream to main ` +
        `rather than to a ref of its own name (#429). Push explicitly with ` +
        `\`git push -u origin ${branch}\` if that is what you meant.`,
    };
  }

  if (!r.ahead.ok) {
    return {
      kind: "unmeasured",
      detail: `branch ${branch} tracks ${upstream} but the ahead-count could not be read ` +
        `(${r.ahead.output.trim() || "no output"}). A git invocation that fails for an unknown ` +
        `reason says nothing about whether work is unpushed.`,
    };
  }
  // `parseInt("") === NaN` and `NaN > 0 === false`, so the original read an
  // empty or garbled count as "nothing to push" and skipped the push entirely.
  // An exact-digits test is the whole fix for that path.
  const aheadRaw = r.ahead.output.trim();
  if (!/^\d+$/.test(aheadRaw)) {
    return {
      kind: "unmeasured",
      detail: `the ahead-count against ${upstream} is not a number (${JSON.stringify(aheadRaw)}). ` +
        `The previous code ran this through parseInt and compared NaN > 0, which is false, so ` +
        `an unreadable count was indistinguishable from nothing to push.`,
    };
  }

  if (aheadRaw === "0") {
    return {
      kind: "nothing-to-push",
      sha,
      detail: `HEAD (${sha}) is not ahead of ${upstream}; nothing to push.`,
    };
  }

  if (r.push === null) {
    return {
      kind: "not-attempted",
      sha,
      ahead: Number(aheadRaw),
      detail: `${aheadRaw} commit(s) are ahead of ${upstream} and no push was attempted.`,
    };
  }

  if (!r.push.ok) {
    return {
      kind: "rejected",
      detail: `git push to ${upstream} was rejected: ${r.push.output.trim() || "no output"}`,
    };
  }

  // The push exited zero. That is a claim by git, not a reading of the remote,
  // and this issue exists because the two were treated as the same thing.
  if (r.remote === null || !r.remote.ok) {
    return {
      kind: "unconfirmed",
      sha,
      remoteSha: null,
      detail: `git push to ${upstream} exited 0 and the remote could not be read back ` +
        `(${r.remote ? r.remote.output.trim() || "no output" : "not attempted"}). An unconfirmed ` +
        `push is not a successful push.`,
    };
  }

  const remoteSha = parseLsRemoteSha(r.remote.output, remoteRef);
  if (remoteSha !== sha) {
    return {
      kind: "unconfirmed",
      sha,
      remoteSha,
      detail: `git push to ${upstream} exited 0 but ${remoteName} ${remoteRef} is at ` +
        `${remoteSha ?? "no such ref"}, not the local HEAD ${sha}. The commit this run reported ` +
        `on is not on the remote.`,
    };
  }

  return {
    kind: "pushed",
    sha,
    remote: upstream,
    detail: `pushed ${aheadRaw} commit(s); ${upstream} confirmed at ${sha}.`,
  };
}

/**
 * Strip credentials out of anything git says before it is recorded.
 *
 * The push outcome's `detail` is written into ship-evidence.json, which is a
 * durable artefact, and printed. git's failure output quotes the remote URL —
 * `fatal: Authentication failed for 'https://user:ghp_…@github.com/o/r.git'`
 * — so a push that fails to authenticate against an HTTPS remote with an
 * embedded token would write that token into the artefact. The remote name
 * read from `branch.<b>.remote` can be a URL for the same reason.
 *
 * Two independent rules rather than one, because they fail differently: the
 * userinfo rule catches the structured case and the token rule catches a bare
 * token that reached the output some other way.
 */
export function redactSecrets(text: string): string {
  return text
    // scheme://user:secret@host — the password is what matters, but the
    // username is dropped too: a PAT is often supplied AS the username.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@")
    // Bare GitHub token forms, in case one arrives outside a URL.
    .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g, "<redacted-token>");
}

const redactReading = (x: Reading | null): Reading | null =>
  x === null ? null : { ok: x.ok, output: redactSecrets(x.output) };

function redactReadings(r: PushReadings): PushReadings {
  return {
    branch: redactReading(r.branch)!,
    remoteName: redactReading(r.remoteName)!,
    remoteRef: redactReading(r.remoteRef)!,
    ahead: redactReading(r.ahead)!,
    localSha: redactReading(r.localSha)!,
    push: redactReading(r.push),
    remote: redactReading(r.remote),
  };
}

function runner(cwd: string, env: NodeJS.ProcessEnv) {
  return (args: string[], timeout: number): Reading => {
    try {
      const output = execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf-8",
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output: redactSecrets(output ?? "") };
    } catch (e: any) {
      // stderr is where git explains a rejection, and the original threw it
      // away. Both streams are kept because which one carries the reason
      // depends on the subcommand.
      const parts = [e?.stdout, e?.stderr, e?.message].filter(Boolean).map(String);
      return { ok: false, output: redactSecrets(parts.join("\n").trim()) };
    }
  };
}

/**
 * Push, then read the remote back, then say what happened.
 *
 * `env` is injectable so a test can place a `git` shim ahead of the real one
 * on PATH. That is how test/gate-auto-push.test.ts performs the mutation this
 * change has to survive — a `git push` that exits 0 without doing anything —
 * as a measurement on every run rather than a sentence in a PR body.
 *
 * It resolves the `git` binary, so it is worth saying what it is not: it is
 * not a widening of trust. The only production caller passes `process.env`
 * plus one flag, and anyone who can set `process.env` already controls PATH
 * for the whole process. The shape of that call site is asserted in
 * test/gate-auto-push.test.ts, so a later caller that funnels a value from a
 * state file or an issue body into `env` is caught rather than assumed away.
 *
 * It does not throw. Every git invocation's failure becomes a `Reading` with
 * `ok: false`, and `classifyPush` is total, so the worst case is an outcome of
 * `unmeasured` — which `leftWorkLocal` counts as "work may be local". There is
 * no input for which this reports success without having read the remote.
 */
export function verifiedPush(
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; expectRepo?: string } = {},
): PushOutcome {
  const env = opts.env ?? process.env;
  const git = runner(cwd, env);

  // #430 — the caller says which repository it believes it is shipping, and
  // that belief is compared against the tree rather than assumed to match it.
  //
  // `gates/orchestrator.ts` pushes `process.cwd()` and guards on
  // `issueRepo && issue > 0`. `test/contract.test.ts` runs the ship gate with
  // `issueRepo: "test/repo"` and `issue: 9998` — both truthy — from inside
  // the real rungate checkout, so running the test suite pushed to origin.
  // The cwd choice is right and stays; what was missing is this comparison.
  //
  // Checked FIRST, before any other reading, because "this is not the repo
  // you meant" invalidates everything downstream — an ahead-count against the
  // wrong tree's upstream is not a fact worth reporting.
  if (opts.expectRepo !== undefined && opts.expectRepo.trim() !== "") {
    // `actual` is already a slug, so it is compared as one. Running it back
    // through `repoMatches` — which parses its first argument as a URL —
    // made every comparison false, including the matching ones, and the
    // control in test/gate-push-repo-mismatch.test.ts is what caught it: the
    // refusal cases all still passed, for a reason that had nothing to do
    // with the repositories differing.
    const actual = originSlug(cwd, env);
    if (actual === null || actual !== opts.expectRepo.trim().toLowerCase()) {
      return {
        kind: "repo-mismatch",
        expected: opts.expectRepo,
        actual,
        detail: `the caller is shipping ${opts.expectRepo} and this tree's origin is ` +
          `${actual ?? "unreadable"}. Nothing was pushed. A run whose issue repository and ` +
          `working tree disagree is either a fixture pointed at a real checkout or a real run ` +
          `in the wrong directory, and both are reasons not to write a remote (#430).`,
      };
    }
  }

  const localSha = git(["rev-parse", "HEAD"], 5000);
  const branch = git(["symbolic-ref", "--short", "HEAD"], 5000);
  const b = branch.output.trim();
  const remoteName = b
    ? git(["config", "--get", `branch.${b}.remote`], 5000)
    : { ok: false, output: "" };
  const remoteRef = b
    ? git(["config", "--get", `branch.${b}.merge`], 5000)
    : { ok: false, output: "" };
  const ahead = git(["rev-list", "--count", "@{upstream}..HEAD"], 5000);

  const base: PushReadings = {
    branch, remoteName, remoteRef, ahead, localSha, push: null, remote: null,
  };

  // Classify once with no push attempted. Everything that rules the push out —
  // a detached HEAD, no upstream, an unreadable count, nothing to push — is
  // already decided here, and re-deriving those conditions below is how two
  // copies of the same rule drift apart. `not-attempted` is the one outcome
  // this call cannot be sure of, because it is the one a push would change.
  const before = classifyPush(base);
  if (before.kind !== "not-attempted") return before;

  const push = git(
    ["push", "--", remoteName.output.trim(), `HEAD:${remoteRef.output.trim()}`],
    30_000,
  );
  const remote = push.ok
    ? git(["ls-remote", "--", remoteName.output.trim(), remoteRef.output.trim()], 20_000)
    : null;

  return classifyPush({ ...base, push, remote });
}
