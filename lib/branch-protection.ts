/**
 * branch-protection.ts — PROTECT-1: does this repo's protection serialise
 * every swarm's PRs? (#909)
 *
 * `required_status_checks.strict` is GitHub's "Require branches to be up to
 * date before merging". Under it, merging PR #1 invalidates #2..#N: each then
 * needs `gh pr update-branch`, a full CI re-run, then a merge. Measured on
 * `hornjason/asaCommandCenter` on 2026-10-21 at **2.5 minutes per PR, strictly
 * serial** — 18 open PRs, every one `BEHIND`, not one of them broken. A 30-PR
 * swarm is ~90 minutes of serialisation during which the swarm opens more PRs,
 * so it never converges.
 *
 * It is the single biggest throughput limit on a RunGate consumer and it is
 * invisible from every direction a reviewer looks: each PR is individually
 * healthy, CI is green, nothing is red anywhere. The only place the cause is
 * visible is a repo setting nothing in the harness had ever read.
 *
 * ## Why the remedy is not one sentence
 *
 * The normal fix is a merge queue, which batches N PRs into one speculative
 * commit and tests once. **It is not available on a user-owned repo.** GitHub
 * restricts merge queues to organization-owned repositories, and private org
 * repos additionally need Enterprise Cloud. Measured the same day:
 *
 *     gh api repos/hornjason/pai-harness -q .owner.type   -> "User"
 *     POST /repos/hornjason/pai-harness/rulesets, merge_queue rule
 *       -> 422 Validation Failed, "Invalid rule 'merge_queue': "
 *
 * The identical ruleset without that one rule is accepted, so the 422 is
 * GitHub refusing on owner type rather than rejecting a malformed payload.
 * And the LEGACY branch-protection endpoint silently *ignores* a
 * `required_merge_queue` field, which is why this reads as "configured" to
 * anyone who sets it there and then checks for an error.
 *
 * So one message for both owner types would be the defect, not the feature:
 * on a user-owned repo "enable a merge queue" is advice that cannot be
 * followed, and a gate that refuses with an impossible remedy gets switched
 * off. Organization → merge queue. User → `strict: false`.
 *
 * ## Why `strict: false` is not advised unconditionally
 *
 * `strict: true` is doing one real job: catching the SEMANTIC conflict — two
 * PRs each green alone and broken together, which no textual merge conflict
 * reports. Turning it off is safe only when something else catches that, and
 * the something else is CI on `push:` to the default branch: the pair lands,
 * main goes red within minutes, and a human sees it.
 *
 * Without push-CI, `strict: false` removes the only check standing between a
 * swarm and a quietly broken default branch. This module therefore REFUSES to
 * recommend `strict: false` on a repo whose required contexts do not run on
 * push, and says that is why. Recommending it there would be this gate
 * causing the outage it exists to prevent.
 *
 * ## Reads. Never writes.
 *
 * Nothing here calls a mutating endpoint. A scaffold that silently rewrote a
 * repository's security settings would be a worse problem than the one it
 * fixes — the operator's next read of their own protection config would be a
 * reading of what a tool decided, with no record that it decided it. The
 * output is a refusal naming the setting, the cost and the exact remedy; the
 * change is the operator's.
 *
 * ## UNMEASURED is not a pass
 *
 * The protection endpoint needs admin on the repo, and the default Actions
 * token does not have it — so 403 is the ORDINARY outcome in a consumer's CI,
 * not an exotic one. If a 403 fell through to "no violations found", this
 * check would report clean on every repo it cannot see, which is the whole of
 * `.claude/rules/checks-must-be-able-to-fail.md`: `0`, `{}`, `null` and SKIP
 * are indistinguishable from success. Every unreadable path lands on
 * UNMEASURED with the cause named.
 *
 * The one thing that is NOT UNMEASURED is an unprotected branch. That is read
 * from `GET /repos/{owner}/{repo}/branches/{branch}`, which needs only read
 * access and returns `protected`, so "not protected" is a fact this check
 * establishes rather than a status code it has to guess at.
 *
 * That pre-call is load-bearing, and the measurement says so. Probing
 * `oven-sh/bun` on 2026-10-21 with a token that has no admin there:
 *
 *     GET /repos/oven-sh/bun/branches/main             -> protected: true
 *     GET /repos/oven-sh/bun/branches/main/protection  -> 404 Not Found
 *
 * **404, not 403.** The non-admin response is byte-identical to the response
 * for a branch with no protection at all. Asking the protection endpoint
 * first and reading its 404 as "nothing configured" would therefore report a
 * confident PASS on every repo the token cannot see into — which is this
 * check certifying the exact thing it exists to find.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { createGitHubClient, parseOwnerRepo, type GitHubClient } from "./github";
import { originSlug } from "./verified-push";

// ── Facts ───────────────────────────────────────────────

/** What one reading of a repo's protection established. */
export interface ProtectionFacts {
  /** `owner/name` the facts are about. */
  slug: string;
  /** The default branch the protection was read for, or null when unknown. */
  branch: string | null;
  /**
   * `required_status_checks.strict`, or null when it could not be determined.
   *
   * `false` is a measured fact and includes the unprotected branch: nothing
   * is requiring anything, so nothing is serialising.
   */
  strict: boolean | null;
  /** `owner.type` — "User", "Organization", or whatever GitHub said. */
  ownerType: string | null;
  /** `required_status_checks.contexts`, in the order GitHub returned them. */
  contexts: string[];
  /**
   * Whether a merge queue is already in front of this branch, or null when
   * the payload said nothing either way.
   *
   * Honest about its own limits: the legacy protection endpoint is not a
   * reliable reporter of merge-queue state, which is the same quirk that made
   * `required_merge_queue` writes vanish. `null` therefore means "not
   * established", never "absent", and only an explicit `true` is allowed to
   * excuse `strict: true`.
   */
  mergeQueueEnabled: boolean | null;
  /**
   * Non-null when something could not be read: no credential, no remote, a
   * 403, a network failure. Named, because a cause the operator cannot see is
   * a cause they cannot fix.
   */
  unreadable: string | null;
}

/** What the local tree says about CI on `push:` to the default branch. */
export interface PushCiReading {
  /** Required contexts proven to run on push to the default branch. */
  onPush: string[];
  /** Required contexts with no such trigger. Non-empty blocks `strict: false`. */
  missing: string[];
  /**
   * Non-null when the workflows could not be read at all, so neither list
   * means anything. An empty `missing` from an unread directory is the
   * fail-open this field exists to prevent.
   */
  unmeasured: string | null;
}

export type ProtectionVerdict = "PASS" | "FAIL" | "UNMEASURED";

export interface ProtectionReading {
  verdict: ProtectionVerdict;
  /** A sentence naming why, in every branch including PASS. */
  reason: string;
  /**
   * What to do about it, differing by owner type. Empty string on PASS and on
   * UNMEASURED — there is nothing to remedy and nothing established to remedy
   * it from.
   */
  remedy: string;
  /** Whether GitHub would allow a merge queue here. null when unestablished. */
  mergeQueuePossible: boolean | null;
}

// ── The measured cost, quoted once ──────────────────────

/**
 * One sentence, used in every FAIL. A refusal that says "this is slow"
 * is an opinion; one that says 2.5 minutes per PR over 18 PRs is a number the
 * operator can weigh against the thing they were about to do instead.
 */
const MEASURED_COST =
  "measured 2026-10-21 on hornjason/asaCommandCenter at ~2.5 min per PR, strictly serial — " +
  "18 open PRs, every one BEHIND, none merging and none broken";

const SERIALISES =
  "required_status_checks.strict = true (\"Require branches to be up to date before merging\") " +
  "means merging one PR invalidates every other open PR: each then needs a branch update, a " +
  "full CI re-run, and a merge, one at a time";

// ── The classification ──────────────────────────────────

/**
 * The verdict for one repo, from its protection facts and its push-CI.
 *
 * Pure, and separate from the fetching, because every interesting decision
 * here is a classification rather than a network call — and the
 * classification is the part that has to be wrong-proof. `readCi` in
 * `lib/github.ts` is split the same way for the same reason.
 *
 * **No branch reaches PASS by not finding a problem.** PASS requires either a
 * positively-read `strict === false`, or a merge queue explicitly reported as
 * enabled. Unknown owner type, unknown strict, unreadable anything: all
 * UNMEASURED.
 */
export function readMergeSerialisation(
  facts: ProtectionFacts,
  pushCi: PushCiReading,
): ProtectionReading {
  const where = facts.branch ? `${facts.slug}@${facts.branch}` : facts.slug;

  if (facts.unreadable) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: branch protection for ${where} was not read — ${facts.unreadable}. ` +
        "Nothing was checked, which is NOT the same as nothing being wrong: the protection " +
        "endpoint needs admin on the repo, so a token without it produces this and a correctly " +
        "configured repo must not look the same.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.strict === null) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: the protection payload for ${where} carried no ` +
        "required_status_checks.strict, so whether merges serialise here is not established.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.strict === false) {
    const ctx = facts.contexts.length
      ? `required contexts kept: ${facts.contexts.join(", ")}`
      : "no required contexts are configured";
    return {
      verdict: "PASS",
      reason: `${where} has required_status_checks.strict = false, so merging one PR does not invalidate the others — ${ctx}.`,
      remedy: "",
      mergeQueuePossible: facts.ownerType === "Organization",
    };
  }

  // strict === true from here down. The serialisation is a measured fact; the
  // only open question is what to tell the operator to do about it.

  if (facts.mergeQueueEnabled === true) {
    return {
      verdict: "PASS",
      reason:
        `${where} has required_status_checks.strict = true, but a merge queue is enabled in ` +
        "front of it — the queue batches PRs into one speculative commit and tests once, which " +
        "is what makes strict safe. This is the configuration strict was designed for.",
      remedy: "",
      mergeQueuePossible: true,
    };
  }

  if (facts.ownerType === null) {
    return {
      verdict: "UNMEASURED",
      reason:
        `UNMEASURED: ${where} has required_status_checks.strict = true, but owner.type was not ` +
        "read, and the remedy differs by it — an organization can enable a merge queue and a " +
        "user account cannot. Refusing with the wrong remedy is worse than not refusing.",
      remedy: "",
      mergeQueuePossible: null,
    };
  }

  if (facts.ownerType === "Organization") {
    return {
      verdict: "FAIL",
      reason:
        `${where} serialises every PR: ${SERIALISES} — ${MEASURED_COST}. ` +
        "This repo is organization-owned, so the proper fix is available.",
      remedy:
        "Enable a merge queue on the default branch (Settings → Branches, or a ruleset with a " +
        "merge_queue rule). It batches queued PRs into one speculative commit and tests once, " +
        "which keeps strict: true honest instead of serial. Note that a PRIVATE org repo needs " +
        "GitHub Enterprise Cloud for this; if that is not available, treat this repo as the " +
        "user-owned case and set strict: false with push-CI covering the required contexts. " +
        "Also give ci.yml and gates.yml a `merge_group:` trigger — without it the queue waits " +
        "forever on a required check that never reports.",
      mergeQueuePossible: true,
    };
  }

  // User-owned: no merge queue is possible here, at any price. GitHub refuses
  // the merge_queue rule on owner.type alone.
  const base =
    `${where} serialises every PR: ${SERIALISES} — ${MEASURED_COST}. ` +
    `This repo is owned by a ${facts.ownerType} account, and GitHub restricts merge queues to ` +
    "ORGANIZATION-owned repositories — POSTing a ruleset with a merge_queue rule here returns " +
    "422 \"Invalid rule 'merge_queue'\", while the identical ruleset without it is accepted. " +
    "So the usual advice does not apply: there is no merge queue to enable.";

  if (pushCi.unmeasured) {
    return {
      verdict: "FAIL",
      reason: `${base} ${pushCi.unmeasured}`,
      remedy:
        "REFUSING to recommend strict: false — this check could not establish that the required " +
        "contexts run on push: to the default branch, and strict: true is the only thing " +
        "catching a semantic conflict (two PRs each green alone, broken together) when they do " +
        "not. Fix the reading first, then re-run: the answer may well be that push-CI is " +
        "already there.",
      mergeQueuePossible: false,
    };
  }

  if (pushCi.missing.length > 0) {
    return {
      verdict: "FAIL",
      reason:
        `${base} It is ALSO not safe to simply turn strict off here: ` +
        `${pushCi.missing.join(", ")} ` +
        `${pushCi.missing.length === 1 ? "does" : "do"} not run on push: to ` +
        `${facts.branch ?? "the default branch"}.`,
      remedy:
        "REFUSING to recommend strict: false. strict: true is doing one real job — catching the " +
        "semantic conflict, two PRs each green alone and broken together, which no textual merge " +
        "conflict reports. Without CI on push: to the default branch, turning it off removes the " +
        "only thing that catches it and main breaks quietly. Do this first: add " +
        `\`on: push: branches: [${facts.branch ?? "main"}]\` to the workflow(s) providing ` +
        `${pushCi.missing.join(", ")}, confirm a push run reports, and only then set strict: false.`,
      mergeQueuePossible: false,
    };
  }

  const covered = pushCi.onPush.length
    ? `All ${pushCi.onPush.length} required context(s) — ${pushCi.onPush.join(", ")} — already run on push: to ${facts.branch ?? "the default branch"}`
    : "No contexts are required, so nothing is lost by it";
  return {
    verdict: "FAIL",
    reason: `${base} ${covered}, so the safe remedy is available.`,
    remedy:
      "Set required_status_checks.strict = false and KEEP the required contexts " +
      `(${facts.contexts.length ? facts.contexts.join(", ") : "none configured"}). ` +
      `${covered}, so a semantic conflict — two PRs each green alone, broken together — still ` +
      "reds the default branch within minutes of landing, which is the thing strict was buying. " +
      "Apply it yourself; this check reads and refuses and never writes protection. " +
      "The read-only command that shows the current state: " +
      `gh api repos/${facts.slug}/branches/${facts.branch ?? "main"}/protection ` +
      "-q .required_status_checks",
    mergeQueuePossible: false,
  };
}

// ── The probe: the one seam, used by production and by tests ────────────

/**
 * Establish the protection facts for one repo.
 *
 * This type IS the seam. `runBranchProtectionValidation` takes one of these
 * and defaults to `githubProtectionProbe`, so a test substituting a probe is
 * substituting the thing production substitutes into — not a parallel path
 * that only tests take. A test seam the production code does not go through
 * measures the seam.
 */
export type ProtectionProbe = (slug: string) => Promise<ProtectionFacts>;

/** A facts object that established nothing, with the cause named. */
export function unreadableFacts(slug: string, why: string): ProtectionFacts {
  return {
    slug,
    branch: null,
    strict: null,
    ownerType: null,
    contexts: [],
    mergeQueueEnabled: null,
    unreadable: why,
  };
}

/** The status an Octokit error carried, or null for a non-HTTP failure. */
function httpStatus(e: unknown): number | null {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : null;
}

function describeError(e: unknown): string {
  const status = httpStatus(e);
  const msg = (e as Error)?.message ?? String(e);
  return status === null ? msg : `HTTP ${status}: ${msg}`;
}

/**
 * Give up rather than hang. A conformity suite that blocks on a socket is a
 * suite nobody runs, and an indefinite wait and a 403 are the same
 * non-answer — so the timeout lands on UNMEASURED like every other one.
 */
const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * Read a repo's protection from GitHub. Three GETs, no writes.
 *
 * Order matters and is the reason this is not one call:
 *
 *   1. `GET /repos/{o}/{r}`                 — owner.type, default_branch
 *   2. `GET /repos/{o}/{r}/branches/{b}`    — `protected`, readable without admin
 *   3. `GET /…/branches/{b}/protection`     — strict, contexts; ADMIN ONLY
 *
 * Step 2 exists so that step 3's absence is never guessed at. Without it, an
 * unprotected branch and a token lacking admin both arrive as a 404 at step 3
 * and the check would have to pick one; with it, `protected: false` is a fact
 * and a 403/404 at step 3 is UNMEASURED.
 */
export const githubProtectionProbe: ProtectionProbe = async (slug) => {
  let client: GitHubClient;
  try {
    client = createGitHubClient();
  } catch (e) {
    return unreadableFacts(
      slug,
      `no usable GitHub credential (${(e as Error).message}); set GITHUB_TOKEN or GH_TOKEN to a ` +
        "token with admin:repo access to read branch protection",
    );
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(slug));
  } catch (e) {
    return unreadableFacts(slug, (e as Error).message);
  }

  let ownerType: string | null = null;
  let branch: string;
  try {
    const r = await withTimeout(client.rest.repos.get({ owner, repo }), PROBE_TIMEOUT_MS, `GET /repos/${slug}`);
    const t = r.data?.owner?.type;
    ownerType = typeof t === "string" ? t : null;
    const b = r.data?.default_branch;
    if (typeof b !== "string" || !b) {
      return unreadableFacts(slug, `GET /repos/${slug} returned no default_branch`);
    }
    branch = b;
  } catch (e) {
    return unreadableFacts(slug, `GET /repos/${slug} failed — ${describeError(e)}`);
  }

  const partial = (why: string): ProtectionFacts => ({
    ...unreadableFacts(slug, why),
    branch,
    ownerType,
  });

  let isProtected: boolean;
  try {
    const r = await withTimeout(
      client.rest.repos.getBranch({ owner, repo, branch }),
      PROBE_TIMEOUT_MS,
      `GET /repos/${slug}/branches/${branch}`,
    );
    const p = r.data?.protected;
    if (typeof p !== "boolean") {
      return partial(`GET /repos/${slug}/branches/${branch} returned no boolean 'protected' field`);
    }
    isProtected = p;
  } catch (e) {
    return partial(`GET /repos/${slug}/branches/${branch} failed — ${describeError(e)}`);
  }

  // An unprotected branch requires nothing, so nothing is strict and nothing
  // serialises. Measured false, not an unread null.
  if (!isProtected) {
    return { slug, branch, strict: false, ownerType, contexts: [], mergeQueueEnabled: null, unreadable: null };
  }

  try {
    const r = await withTimeout(
      client.rest.repos.getBranchProtection({ owner, repo, branch }),
      PROBE_TIMEOUT_MS,
      `GET /repos/${slug}/branches/${branch}/protection`,
    );
    return protectionFactsFromPayload(slug, branch, ownerType, r.data);
  } catch (e) {
    const status = httpStatus(e);
    const note =
      status === 403 || status === 404
        ? " — this endpoint requires ADMIN on the repository, and the default GitHub Actions " +
          "token does not have it, so this is the ordinary outcome in CI rather than an error"
        : "";
    return partial(`GET /repos/${slug}/branches/${branch}/protection failed — ${describeError(e)}${note}`);
  }
};

/**
 * The protection payload reduced to the four fields a verdict depends on.
 *
 * Exported and pure so the shape-handling is testable without a network: the
 * API returns `required_status_checks` only when checks are required, and a
 * reader that assumed it was always present would throw on exactly the repos
 * that have nothing to report.
 */
export function protectionFactsFromPayload(
  slug: string,
  branch: string,
  ownerType: string | null,
  data: unknown,
): ProtectionFacts {
  const d = (data ?? {}) as Record<string, any>;
  const rsc = d.required_status_checks;

  // No required_status_checks block: protection exists but requires no
  // checks, so there is no strictness and nothing to be out of date against.
  if (!rsc || typeof rsc !== "object") {
    return { slug, branch, strict: false, ownerType, contexts: [], mergeQueueEnabled: mergeQueueFrom(d), unreadable: null };
  }

  const strict = typeof rsc.strict === "boolean" ? rsc.strict : null;
  // `contexts` is the legacy field and `checks[].context` the current one.
  // Both are read because branch protection still answers with either, and a
  // reader of one alone reports "no required contexts" on a repo that has
  // several — which would make the push-CI precondition vacuously satisfied.
  const legacy = Array.isArray(rsc.contexts) ? rsc.contexts : [];
  const modern = Array.isArray(rsc.checks) ? rsc.checks.map((c: any) => c?.context) : [];
  const contexts = [...new Set([...legacy, ...modern])].filter(
    (c: unknown): c is string => typeof c === "string" && c.length > 0,
  );

  return { slug, branch, strict, ownerType, contexts, mergeQueueEnabled: mergeQueueFrom(d), unreadable: null };
}

function mergeQueueFrom(d: Record<string, any>): boolean | null {
  const e = d.required_merge_queue?.enabled;
  return typeof e === "boolean" ? e : null;
}

/** The `owner/name` this tree pushes to, for the probe to ask about. */
export function protectionSubject(root: string): string | null {
  return originSlug(root);
}

// ── Push-CI, read from the local tree ───────────────────

const WORKFLOW_EXT = /\.ya?ml$/i;

/**
 * Which of `contexts` run on `push:` to `branch`, judged from
 * `.github/workflows/`.
 *
 * Read from the tree and not from GitHub's API on purpose: the question is
 * what the code in THIS commit does, and that is what the operator is about
 * to change protection against. A run-history query would answer a question
 * about the past.
 *
 * An absent or unreadable workflows directory is `unmeasured`, never an empty
 * `missing`. Those two produce byte-identical lists and mean opposite things,
 * and the empty one would silently clear the push-CI precondition for
 * `strict: false` — the gate recommending the change on exactly the repos
 * where it is least safe.
 */
export function readPushCi(root: string, contexts: string[], branch: string): PushCiReading {
  const dir = join(root, ".github", "workflows");

  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      return unmeasuredPushCi(`${dir} is not a directory, so no push: trigger could be read`);
    }
    entries = readdirSync(dir).filter(n => WORKFLOW_EXT.test(n)).sort();
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `${dir} does not exist`
      : `${dir} is unreadable — ${(e as Error).message}`;
    return unmeasuredPushCi(`${why}, so no push: trigger could be read`);
  }

  const unreadable: string[] = [];
  const pushContexts = new Set<string>();
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch (e) {
      // Not "has no push trigger" and not "has one": both are claims about
      // bytes nobody read.
      unreadable.push(`${name} (${(e as Error).message})`);
      continue;
    }
    if (!runsOnPushTo(text, branch)) continue;
    for (const job of jobContextNames(text)) pushContexts.add(job);
  }

  if (unreadable.length > 0) {
    return unmeasuredPushCi(
      `${unreadable.length} workflow file(s) could not be read — ${unreadable.join(", ")} — ` +
        "so whether the required contexts run on push is not established",
    );
  }

  return {
    onPush: contexts.filter(c => pushContexts.has(c)),
    missing: contexts.filter(c => !pushContexts.has(c)),
    unmeasured: null,
  };
}

function unmeasuredPushCi(why: string): PushCiReading {
  return {
    onPush: [],
    missing: [],
    unmeasured: `UNMEASURED push-CI: ${why}.`,
  };
}

// ── The small amount of YAML this needs ─────────────────
//
// A real parser is not pulled in for this. The two questions are "is there a
// `push:` under `on:` that matches this branch" and "what are the job context
// names", both of which are top-level structure in a file GitHub itself
// requires to be conventionally shaped. What a parser would buy is handling of
// forms no CI workflow uses; what it would cost is a dependency in the one
// module a consumer's conformity suite imports.
//
// Every function here is deliberately conservative: when the shape is not one
// it recognises, it reports NOT-matching rather than guessing, and the gate
// upstream turns a non-match into a refusal to recommend `strict: false`. The
// error direction is toward "we did not establish it", never toward "fine".

/** Lines with whole-line comments dropped and indentation preserved. */
function significantLines(text: string): string[] {
  return text
    .split("\n")
    .filter(l => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

/** The lines of the block introduced by top-level `key:`, excluding the key line. */
function topLevelBlock(lines: string[], keys: string[]): { header: string; body: string[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:(.*)$/);
    if (!m || !keys.includes(m[2])) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) break;
      body.push(lines[j]);
    }
    return { header: m[3].trim(), body };
  }
  return null;
}

/** Indentation width of a line, in spaces. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The sub-block of `key:` within an already-dedented-by-context block. */
function childBlock(body: string[], key: string): { header: string; body: string[] } | null {
  const base = body.length ? Math.min(...body.map(indentOf)) : 0;
  for (let i = 0; i < body.length; i++) {
    if (indentOf(body[i]) !== base) continue;
    const m = body[i].trim().match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:(.*)$/);
    if (!m || m[2] !== key) continue;
    const out: string[] = [];
    for (let j = i + 1; j < body.length; j++) {
      if (indentOf(body[j]) <= base) break;
      out.push(body[j]);
    }
    return { header: m[3].trim(), body: out };
  }
  return null;
}

/** Entries of a YAML sequence in either flow (`[a, b]`) or block (`- a`) form. */
function sequenceEntries(header: string, body: string[]): string[] {
  const out: string[] = [];
  const flow = header.match(/^\[(.*)\]$/);
  if (flow) {
    for (const part of flow[1].split(",")) {
      const v = unquote(part.trim());
      if (v) out.push(v);
    }
    return out;
  }
  for (const line of body) {
    const m = line.trim().match(/^-\s*(.+)$/);
    if (m) out.push(unquote(m[1].trim()));
  }
  return out;
}

function unquote(s: string): string {
  const m = s.match(/^(["'])(.*)\1$/);
  return m ? m[2] : s;
}

/**
 * Does a `branches:` pattern cover `branch`?
 *
 * Supports exactly what GitHub's filter syntax does for the cases that occur:
 * a literal name, `*` within a path segment, and `**` across them. An
 * unrecognised pattern does not match, so an exotic filter produces "we did
 * not establish push-CI" rather than a confident wrong yes.
 */
export function branchPatternMatches(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  if (!pattern.includes("*")) return false;
  const rx = pattern
    .split("**")
    .map(seg => seg.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  try {
    return new RegExp(`^${rx}$`).test(branch);
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether this workflow runs on a push to `branch`.
 *
 * The `on:` key is the one place YAML's own history bites: unquoted `on` is a
 * boolean in YAML 1.1, so files in the wild write `'on':` and `"on":` too, and
 * a reader matching only the bare form silently sees no triggers at all.
 */
export function runsOnPushTo(text: string, branch: string): boolean {
  const lines = significantLines(text);
  const on = topLevelBlock(lines, ["on"]);
  if (!on) return false;

  // `on: push` and `on: [push, pull_request]` carry no branch filter at all,
  // which in GitHub's semantics means every branch — including this one.
  if (on.header) {
    if (on.header === "push") return true;
    const flow = on.header.match(/^\[(.*)\]$/);
    if (flow) return flow[1].split(",").map(p => unquote(p.trim())).includes("push");
    return false;
  }

  const push = childBlock(on.body, "push");
  if (!push) return false;

  const ignore = childBlock(push.body, "branches-ignore");
  if (ignore) {
    return !sequenceEntries(ignore.header, ignore.body).some(p => branchPatternMatches(p, branch));
  }

  const branches = childBlock(push.body, "branches");
  // `push:` with no filter fires on every branch.
  if (!branches) return true;
  return sequenceEntries(branches.header, branches.body).some(p => branchPatternMatches(p, branch));
}

/**
 * The status-check context names a workflow contributes.
 *
 * A job's context is its `name:` when it has one and its key otherwise —
 * which is why the key alone is not enough: `test:` with `name: Suite`
 * reports as `Suite` in branch protection, and a check looking for `test`
 * would call a configured repo unconfigured.
 */
export function jobContextNames(text: string): string[] {
  const lines = significantLines(text);
  const jobs = topLevelBlock(lines, ["jobs"]);
  if (!jobs || jobs.body.length === 0) return [];
  const base = Math.min(...jobs.body.map(indentOf));

  const names: string[] = [];
  for (let i = 0; i < jobs.body.length; i++) {
    if (indentOf(jobs.body[i]) !== base) continue;
    const key = jobs.body[i].trim().match(/^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:\s*$/);
    if (!key) continue;
    const block: string[] = [];
    for (let j = i + 1; j < jobs.body.length; j++) {
      if (indentOf(jobs.body[j]) <= base) break;
      block.push(jobs.body[j]);
    }
    const name = childBlock(block, "name");
    names.push(name?.header ? unquote(name.header) : key[2]);
  }
  return names;
}
