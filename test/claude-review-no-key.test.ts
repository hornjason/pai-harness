/**
 * The reviewer must authenticate with no long-lived credential (#630 AC-15).
 *
 * ## Why this file exists rather than a sentence in the workflow's header
 *
 * `.github/workflows/claude-review.yml` ran on `pull_request` for three
 * commits and was parked on one finding: the review agent can read files and
 * can post review comments, so a service-account key written into the runner
 * workspace by `credentials_json` is one prompt away from a public PR comment
 * on a public repository. Two denylist attempts failed — the first missed
 * `Task`, the second missed `SlashCommand` — which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s *detector narrower than
 * what it detects*, and the third attempt would have missed something else.
 *
 * The fix removes what the sink could carry rather than enumerating the sinks.
 * What this file holds is the property that makes that fix durable: **no input
 * carrying long-lived credential material appears in the auth step.** The
 * header says so in prose, and prose is not re-checked on every run.
 *
 * ## Why the step is CUT rather than searched for
 *
 * `credentials_json` appears in this workflow's header, in prose, explaining
 * what was removed and why. A whole-file search for it is therefore satisfied
 * by the documentation of its own absence — `.claude/rules/
 * checks-must-be-able-to-fail.md` §"search the slice, not the document",
 * which that rule has now caught three times in prose about itself. So the
 * auth step is cut out with `structuralCut` and the claim is asserted against
 * the cut. `locateUnique` throws on zero or two occurrences, which is the loud
 * abort: a slice that failed to find its section is an empty string, and an
 * empty string contains none of the forbidden inputs.
 *
 * No YAML parser is used, deliberately — this repo ships four runtime
 * dependencies and a guard is not a reason to add a fifth to a published
 * package.
 *
 * ## The cheapest wrong fix, named
 *
 * Someone debugging a failing WIF exchange at 5pm adds `credentials_json:
 * ${{ secrets.GCP_SA_KEY }}` back **beside** the provider, because `auth`
 * accepts both and the key path is the one that has worked before. The
 * workflow goes green, the review runs, and the key is back in the workspace
 * with a `workload_identity_provider` line sitting above it reading like a
 * fix. AC-1 survives that: it asserts the ABSENCE of the key inputs, not the
 * presence of the provider, so adding the provider cannot satisfy it.
 *
 * AC-2 is the converse and is not redundant with AC-1: a tree with neither
 * input authenticates as nothing at all, and "no key" would be trivially true
 * of it. Zero credentials is not the property — exactly one, of the right
 * kind, is.
 *
 * ## What was broken to prove it
 *
 * Measured over this file alone (5 tests). Every count predicted before the
 * battery ran, and **the baseline row read before any mutation row** — an
 * instrument that has stopped reporting takes the baseline down with it, and
 * that is the row nobody checks. The first attempt at this file had a baseline
 * of `0 pass, 1 fail, 1 error` (`Cannot find package 'yaml'`), which is
 * exactly that: the mutation row beside it was meaningless and was discarded.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 5 pass, 0 fail | **5 pass, 0 fail** | — |
 * | the cheapest wrong fix: `credentials_json` added back BESIDE the provider | 1 | **1 of 5** — AC-1 | an auth step carrying both inputs: the original names `credentials_json` in the violation list, the mutant's provider line satisfies nothing AC-1 asks |
 * | the `workload_identity_provider` line deleted | 1 | **1 of 5** — AC-2 | an auth step with `project_id` and nothing else: original matches the provider path, mutant matches nothing |
 * | `service_account:` impersonation added | 1 | **1 of 5** — AC-3 | an auth step naming an SA to impersonate — which AC-1 passes, because impersonation is not a key |
 * | `id-token: write` removed from `permissions:` | 1 | **1 of 5** — AC-4 | the workflow's permission block: the exchange cannot mint a token, and the runtime failure reads as a GCP misconfiguration |
 * | the genuinely pre-#677 auth step — `credentials_json`, no provider | 2 | **2 of 5** — AC-1, AC-2 | the real prior configuration, the only row that measures against the defect rather than a reconstruction of it |
 * | `structuralCut` short-circuited to `return doc` | 2 | **1 of 5** — AC-0 | `structuralCut(source, "uses: google-github-actions/auth", …)` returns 1,180 characters on the real helper and the whole 9 kB file on the mutant |
 *
 * **The last row came back LOW, and the missing red is a fact worth keeping.**
 * AC-1 was predicted to go red on an unbounded cut, because the header
 * discusses `credentials_json` in prose. It does not: the header writes it as
 * ``# What this replaces: `credentials_json: …` ``, and AC-1's anchor is
 * `^\s*credentials_json\s*:`, which a backtick and a sentence in front of it
 * defeat. Measured directly — the whole-file test of that pattern is `false`.
 *
 * So **AC-0 is the only thing holding the boundedness of the cut**, and AC-1
 * would pass over a `structuralCut` that had stopped cutting. That is #507's
 * shape: AC-1's protection depends on how a comment two hundred lines away
 * happens to be worded, which is outside this fixture's control and will be
 * reworded by someone who has never read this file. It is recorded rather
 * than fixed with a second assertion, because a second decider answering the
 * same question would survive any mutation of the first and both would read
 * as covered (fourth shape). Do not delete AC-0 as ceremony.
 *
 * None of the six mutations is left in the tree; all were run and reverted,
 * and `.github/workflows/claude-review.yml` and `lib/source-slice.ts` were
 * confirmed byte-identical to the measured source afterwards by `diff`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { structuralCut } from "../lib/source-slice";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "claude-review.yml");
const source = readFileSync(WORKFLOW, "utf8");

/**
 * Every `auth` action input that carries, or points at, long-lived credential
 * material. `credentials_json` is the one #630 AC-15 removed; the other two
 * are the same thing reached by a different input name, and a guard that knew
 * only the first would read exactly like a guard that is satisfied (#484).
 */
const LONG_LIVED_CREDENTIAL_INPUTS = [
  "credentials_json",
  "credentials_file_path",
  "service_account_key",
] as const;

const FEDERATION_INPUT = "workload_identity_provider";

/**
 * The auth step, cut from its `uses:` line to the start of the next step.
 *
 * Anchored on the action rather than the step's `name:`, because a name is
 * prose and can be reworded while the `uses:` is the binding.
 */
const authStep = structuralCut(source, "uses: google-github-actions/auth", {
  endAnchor: "      - name: Review",
});

describe("claude-review.yml authenticates with no long-lived credential (#630 AC-15)", () => {
  /**
   * The cut is a witness only if it is the step and not the file. Asserted
   * first: every row below is about something NOT being in this string, and
   * all of them hold vacuously of an empty one.
   */
  test("AC-0: the cut is the auth step, bounded", () => {
    expect(authStep).toContain("google-github-actions/auth");
    expect(authStep.length).toBeLessThan(source.length / 4);
    // The header discusses credentials_json in prose; the cut must exclude it,
    // or AC-1 is reading the documentation rather than the configuration.
    expect(source).toContain("credentials_json");
  });

  test("AC-1: the auth step declares no input carrying long-lived credential material", () => {
    const offending = LONG_LIVED_CREDENTIAL_INPUTS.filter(k =>
      new RegExp(`^\\s*${k}\\s*:`, "m").test(authStep),
    );
    expect(
      offending,
      `claude-review.yml's auth step declares ${offending.join(", ")}. The review agent ` +
        `reads files and can post review comments on a PUBLIC repository, so a credential ` +
        `written into the workspace is an egress sink that no denylist has closed. ` +
        `Use ${FEDERATION_INPUT} instead.`,
    ).toEqual([]);
  });

  test("AC-2: the auth step authenticates by workload identity federation", () => {
    const m = authStep.match(new RegExp(`^\\s*${FEDERATION_INPUT}\\s*:\\s*(\\S+)\\s*$`, "m"));
    expect(m, `${FEDERATION_INPUT} is absent — the job authenticates as nothing`).not.toBeNull();
    expect(m![1]).toMatch(
      /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/,
    );
  });

  /**
   * Separate from AC-1 because impersonation is not a key and would pass it.
   * The federated identity holds `roles/aiplatform.user` directly, so there is
   * nothing to impersonate — and a `service_account:` reappearing here would
   * mean a key exists somewhere again, one indirection away.
   */
  test("AC-3: no service account is impersonated", () => {
    expect(/^\s*service_account\s*:/m.test(authStep)).toBe(false);
  });

  /**
   * `id-token: write` is what lets GitHub issue the token the exchange
   * consumes. Without it the auth step fails at runtime with a message about
   * the token endpoint, which reads as a GCP misconfiguration and is not one.
   */
  test("AC-4: id-token: write is granted", () => {
    const perms = structuralCut(source, "\npermissions:", { endAnchor: "\nconcurrency:" });
    expect(perms, "the permissions block is empty — nothing grants id-token").toContain("id-token");
    expect(/^\s*id-token:\s*write\s*$/m.test(perms)).toBe(true);
  });
});
