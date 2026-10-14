/**
 * Which repository is an isolated agent actually standing in? (#218)
 *
 * On run `wf_5e3ed885-98c` the first Marcus was spawned in a worktree of the
 * repository the run targets, and the remediation Marcus in a worktree of
 * ANOTHER project entirely — a different checkout, with a different `origin`,
 * for an issue targeting this one. The operator had changed directory
 * mid-run, and `isolation: "worktree"` is resolved by the agent runtime
 * against the session's cwd rather than the workflow's `projectRoot`.
 *
 * (The two repositories are named in the issue and in
 * `test/worktree-repo.test.ts`'s replay, not here: the harness must not name
 * one of its consumers — see `test/anti.test.ts` SC-A1 and #304.)
 *
 * `workflows/ship.js:674` already pins `opts.cwd = PROJECT_ROOT` for every
 * isolated spawn and has since 2026-09-23 — three weeks BEFORE the incident.
 * The pin did not hold, so the fix cannot be another way of deriving the path.
 * It has to be a reading of where the agent actually ended up.
 *
 * ## Why a slug comparison and not a path comparison
 *
 * A path prefix check answers "is this under the directory I expected", which
 * is the question whose answer was already wrong: the run's idea of the
 * directory is the thing that drifted. `git remote get-url origin` is a fact
 * about the checkout, read from the checkout, and it is the same identity the
 * run was given in its `repo` argument. Comparing those two cannot be
 * satisfied by a path that merely looks right.
 *
 * ## Fail-closed, with the two "no answer" cases kept apart
 *
 * An unreadable remote and an absent one are both refusals. They are not the
 * same refusal: "the worktree has no origin" is a detached or bare checkout,
 * and "nothing reported a remote" means the reading never happened. A guard
 * that collapsed them would let a reading that never ran read as a checkout
 * with no remote, which is this repo's defining defect
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { spawnSync } from "child_process";

/** Returned by `readWorktreeRemote`, so a failure carries its own reason. */
export interface RemoteReading {
  /** The raw URL git printed, or null if it printed nothing usable. */
  url: string | null;
  /** Non-null when the read itself failed — git missing, path gone, non-zero exit. */
  error: string | null;
}

/** How a worktree's identity reading can go wrong. One value per refusal kind. */
export type IdentityVerdict = "match" | "mismatch" | "unreadable" | "unreported";

export interface IdentityResult {
  verdict: IdentityVerdict;
  /** The slug the worktree reports, when one could be parsed. */
  actual: string | null;
  /** The slug the run expects, normalised the same way. */
  expected: string | null;
  /** Null when the verdict is `match`; otherwise an operator-facing sentence. */
  refusal: string | null;
}

/**
 * `owner/name`, from any remote URL form git hands back.
 *
 * Handles the three this repo actually sees, and normalises case because
 * GitHub slugs are case-insensitive while a clone URL may not match the
 * canonical casing:
 *
 *   git@github.com:owner/name.git
 *   https://github.com/owner/name.git
 *   https://x-access-token:TOKEN@github.com/owner/name
 *
 * Returns null rather than a guess for anything else. A guessed slug compared
 * against a real one produces a refusal nobody can act on, and a guessed slug
 * that happens to match is worse.
 */
export function repoSlug(remote: string | null | undefined): string | null {
  if (typeof remote !== "string") return null;
  let s = remote.trim();
  if (!s) return null;

  // Strip a trailing `.git` and any trailing slashes, in that order — a URL
  // can carry both (`…/name.git/`).
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");

  // scp-style: `git@host:owner/name`. The colon is the separator, and there
  // is no `//` after it, which is what distinguishes this from a URL.
  const scp = s.match(/^[^/]*@[^/:]+:(.+)$/);
  if (scp) return normaliseSlug(scp[1]!);

  // URL-style, with or without credentials in the authority.
  const url = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.+)$/i);
  if (url) return normaliseSlug(url[1]!);

  // Already a bare slug — this is how the run's own `repo` argument arrives.
  if (/^[^/\s]+\/[^/\s]+$/.test(s)) return normaliseSlug(s);

  return null;
}

/**
 * Exactly two segments, lowercased.
 *
 * EXACTLY two, not "the last two". Taking the tail of a longer path is a
 * parser differential: `https://github.com/evil/repo/owner/name` is a path
 * git reads as the repository `evil/repo/owner/name`, and a tail-taking
 * parser reads it as `owner/name` and reports a MATCH. The remote being
 * compared originates in an agent reply, so a parser that can be talked into
 * agreeing is the whole guard.
 *
 * The cost is a self-hosted layout with a group prefix, which returns null
 * and lands in the `unreadable` refusal. That is a loud, visible outcome
 * naming the string it could not read — the right direction for a check to
 * be wrong in.
 */
function normaliseSlug(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return parts.join("/").toLowerCase();
}

/**
 * A remote URL with every credential-bearing part replaced.
 *
 * Refusals are logged, and a CI checkout's origin is
 * `https://x-access-token:TOKEN@host/owner/name`. Quoting the raw string
 * into a run log writes a live token somewhere it will be read, copied into
 * an issue, and kept.
 *
 * Three places, not one. The first draft redacted only the authority, which
 * the push security review flagged as incomplete sanitisation, and it was
 * right — a remote is not always well formed, and these strings reach the
 * redactor precisely BECAUSE they could not be parsed:
 *
 *  - the authority's userinfo, `user:pass@` or a bare `token@`
 *  - a query string, `?access_token=…` — git accepts one, and an
 *    `insteadOf` rewrite is a common way for one to end up there
 *  - anything left that is shaped like a key, anywhere in the string. A
 *    deny-list of parameter names is a list someone has to keep; the shape
 *    check is what covers the form nobody listed
 *
 * The control arm is the point of the third rule being narrow: a redactor
 * that mangled every URL would satisfy every token case and make every
 * refusal unreadable, which is a worse outcome than the leak for the 99% of
 * refusals that quote an ordinary string.
 */
const KEY_SHAPED = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,})\b/g;

export function redactRemote(remote: string): string {
  return String(remote)
    .replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1<redacted>@")
    .replace(/^([^/\s]*):[^/\s@]*@/, "$1:<redacted>@")
    .replace(/([?&][^=&\s]*(?:token|auth|key|secret|password|pat)[^=&\s]*=)[^&\s]+/gi, "$1<redacted>")
    .replace(KEY_SHAPED, "<redacted>");
}

/**
 * Read a worktree's `origin` URL.
 *
 * `spawnSync` with an argument array and `-C`, never a shell string: the path
 * originates in an agent reply (#155) and a shell would read whatever is in
 * it. The timeout is short because this runs on a path that is already
 * suspected of being wrong, and a hang here would stall the run at exactly
 * the moment it needs to refuse.
 */
export function readWorktreeRemote(worktreePath: string): RemoteReading {
  if (typeof worktreePath !== "string" || !worktreePath.trim()) {
    return { url: null, error: "no worktree path was given" };
  }
  const got = spawnSync("git", ["-C", worktreePath, "remote", "get-url", "origin"], {
    timeout: 10_000,
    encoding: "utf-8",
  });
  // Redacted on the way out, not at the call site. git's own stderr quotes
  // the remote back at you — "fatal: 'https://user:TOKEN@host/x' does not
  // appear to be a git repository" — so the error string is a second channel
  // for the same credential the URL carries, and a caller that redacted only
  // `url` would leak it through `error`.
  if (got.error) return { url: null, error: redactRemote(got.error.message) };
  if (got.status !== 0) {
    const said = String(got.stderr || "").trim().split("\n")[0] || `git exited ${got.status}`;
    return { url: null, error: redactRemote(said) };
  }
  const url = String(got.stdout || "").trim();
  return url ? { url, error: null } : { url: null, error: "git printed no url" };
}

/**
 * Does the worktree belong to the repository this run is for?
 *
 * `reported` is the remote URL as the worktree stated it — read in-process by
 * `readWorktreeRemote`, or carried back in an agent's reply where the caller
 * cannot run git (`workflows/ship.js` has no subprocess access, #69).
 *
 * Every non-match is a refusal that NAMES both sides. The #218 incident was
 * recoverable only because the agent's own findings said which repo it was in
 * and which the issue targeted; a refusal that omits either is one an
 * operator has to go to the transcript for.
 */
export function worktreeIdentity(
  worktreePath: string,
  expectedRepo: string | null | undefined,
  reported: string | null | undefined,
): IdentityResult {
  const expected = repoSlug(expectedRepo);
  const where = worktreePath || "(no path reported)";

  if (!expected) {
    // The run does not know its own repo, so there is nothing to compare
    // against. Refusing is the only honest answer: passing here would make
    // the guard silently inert for exactly the misconfigured run most likely
    // to need it.
    return {
      verdict: "unreported",
      actual: null,
      expected: null,
      refusal:
        `${where} could not be checked — the run did not state a repository to compare against ` +
        // Redacted too. `repo` is normally a bare slug, but this branch fires
        // precisely when it was NOT one, and "whatever was passed instead"
        // is exactly the value that might be a URL with a token in it.
        `(repo was ${JSON.stringify(expectedRepo == null ? null : redactRemote(String(expectedRepo)))}), ` +
        `so a worktree in any repository would pass (#218)`,
    };
  }

  if (reported === null || reported === undefined || String(reported).trim() === "") {
    return {
      verdict: "unreported",
      actual: null,
      expected,
      refusal:
        `${where} reported no origin remote, so there is nothing to compare against ${expected} — ` +
        `a reading that never happened is not a checkout that matched (#218)`,
    };
  }

  const actual = repoSlug(reported);
  if (!actual) {
    return {
      verdict: "unreadable",
      actual: null,
      expected,
      refusal:
        `${where} reported an origin this run cannot read as owner/name ` +
        `(${JSON.stringify(redactRemote(String(reported).trim()))}), ` +
        `so it cannot be compared against ${expected} (#218)`,
    };
  }

  if (actual === expected) return { verdict: "match", actual, expected, refusal: null };

  return {
    verdict: "mismatch",
    actual,
    expected,
    refusal:
      `${where} is a worktree of ${actual}, but this run targets ${expected} — ` +
      `an isolated agent resolved its worktree from ambient cwd rather than the run's projectRoot. ` +
      `Work done there would be written into the wrong repository (#218).`,
  };
}

/** One result row as the workflow reports them: a path and the remote it read. */
export interface WorktreeReport {
  worktreePath?: string | null;
  worktreeRepo?: string | null;
}

/**
 * Every refusal across a run's agent results, in reported order.
 *
 * By default a row with no `worktreePath` is SKIPPED rather than refused: an
 * agent that ran without isolation has no worktree to check, and refusing
 * those would fire the guard on every non-isolated spawn in a run. A row that
 * HAS a path and no remote is the `unreported` refusal — the agent was asked
 * and did not answer, which is a different state.
 *
 * `requirePath` closes that default where it is a bypass. The push security
 * review called it an authorization bypass and it is one: at a collection
 * boundary, every row WILL be committed from, so "no path" is not "nothing to
 * check" — it is a row claiming files with no checkable origin, and omitting
 * one field would skip the guard entirely. Callers that are about to act on
 * the rows pass `true`; callers merely surveying them do not.
 */
export function worktreeIdentityViolations(
  reports: readonly WorktreeReport[] | null | undefined,
  expectedRepo: string | null | undefined,
  opts: { requirePath?: boolean } = {},
): string[] {
  if (!Array.isArray(reports)) return [];
  const out: string[] = [];
  for (const r of reports) {
    const path = r && typeof r.worktreePath === "string" ? r.worktreePath.trim() : "";
    if (!path && !opts.requirePath) continue;
    const got = worktreeIdentity(path, expectedRepo, r?.worktreeRepo);
    if (got.refusal) out.push(got.refusal);
  }
  return out;
}
