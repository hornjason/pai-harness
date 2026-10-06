/**
 * The single registry of secret patterns used by every scanner we generate.
 *
 * WHY THIS FILE EXISTS
 *
 * There were three copies and they disagreed:
 *
 *   scripts/git-hooks/pre-commit:22    8 patterns
 *   lib/scaffold/steps.ts  (gates.yml) 3 patterns
 *   lib/scaffold/steps.ts  (pre-commit) 3 patterns
 *
 * So CI missed `gho_`, `ghs_`, `github_pat_`, `sk-ant-` and — worst — PEM
 * private key blocks entirely. A committed private key passed CI. And the
 * generated consumer pre-commit hook carried the weak 3-pattern set, so every
 * downstream project got the gap too, while this repo's own checked-in hook
 * had the full list.
 *
 * The generated `gates.yml` even asserted the opposite in a comment: "Two
 * tiers matching the pre-commit hook, so local and CI cannot disagree about
 * what counts as a secret." They disagreed. A comment is not a mechanism —
 * this file is the mechanism, and test/unit/secret-patterns.test.ts asserts
 * that every generated scanner carries exactly this registry.
 *
 * FORMAT
 *
 * POSIX ERE, consumed by `grep -E` and `git grep -E` in generated shell. Keep
 * it portable: no PCRE (`\d`, `\w`, lookarounds), no single quotes — the
 * string is embedded inside single-quoted shell arguments.
 */

export interface SecretPattern {
  /** Short identifier used in test failure messages. */
  id: string;
  /** POSIX ERE fragment, safe to join with `|`. */
  ere: string;
  /** What it catches, for the humans reading a blocked commit. */
  description: string;
}

/**
 * Tier 1 — anchored key formats.
 *
 * Unambiguous enough that a match is a secret, so there are no exceptions and
 * no allowlist. Anything needing an exception belongs in tier 2.
 */
export const TIER1_SECRET_PATTERNS: SecretPattern[] = [
  { id: "github-pat-classic", ere: "ghp_[A-Za-z0-9]{36}", description: "GitHub personal access token" },
  { id: "github-oauth", ere: "gho_[A-Za-z0-9]{36}", description: "GitHub OAuth token" },
  { id: "github-server", ere: "ghs_[A-Za-z0-9]{36}", description: "GitHub server-to-server token" },
  { id: "github-pat-fine", ere: "github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}", description: "GitHub fine-grained PAT" },
  { id: "aws-access-key", ere: "AKIA[A-Z0-9]{16}", description: "AWS access key ID" },
  // {20,} not {48}. The pre-commit hook used {48} and the CI scan used {20,};
  // taking the hook's value would have NARROWED CI, missing any sk- key
  // shorter than 48 chars — a coverage regression smuggled in by a
  // deduplication. When registries disagree, the union is the safe merge, not
  // whichever copy you happened to start from.
  { id: "openai", ere: "sk-[A-Za-z0-9]{20,}", description: "OpenAI-style API key" },
  { id: "anthropic", ere: "sk-ant-[A-Za-z0-9-]{90,}", description: "Anthropic API key" },
  {
    id: "private-key",
    ere: "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    description: "PEM private key block",
  },
];

/**
 * Tier 2 — credential assignments.
 *
 * Shape-based rather than format-based, so it needs the allowlist below.
 */
export const TIER2_ASSIGNMENT_ERE =
  "(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+=_.-]{12,}";

/**
 * Values that look like credentials but are not.
 *
 * Applied to the extracted VALUE, never the whole line. Matching anywhere on
 * the line was an allowlist escape: appending `# placeholder` to a line
 * holding a real secret laundered it past the scan.
 */
export const TIER2_ALLOWED_VALUE_ERE =
  "^$|[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)";

/** Tier 1 as one alternation, parenthesised and ready to embed in `grep -E '...'`. */
export function tier1Ere(): string {
  return `(${TIER1_SECRET_PATTERNS.map(p => p.ere).join("|")})`;
}

/**
 * Guard against a pattern that cannot survive the trip into generated shell.
 *
 * Every pattern here is interpolated into a single-quoted shell string inside
 * a JS template literal. A single quote would terminate the shell quoting and
 * a backtick would end the template — in both cases producing a scanner that
 * either fails to parse or silently matches the wrong thing. Checked by a test
 * rather than trusted, because the failure is invisible in review.
 */
export function unshellSafePatterns(): string[] {
  // Covers EVERY string that reaches generated shell, not just tier 1. The
  // tier-2 assignment and allowlist expressions are embedded the same way, so
  // checking only tier 1 would have been a validator with a narrower view
  // than the thing it validates.
  const embedded: Array<{ id: string; ere: string }> = [
    ...TIER1_SECRET_PATTERNS.map(p => ({ id: p.id, ere: p.ere })),
    { id: "tier2-assignment", ere: TIER2_ASSIGNMENT_ERE },
    { id: "tier2-allowlist", ere: TIER2_ALLOWED_VALUE_ERE },
  ];
  // A single quote ends the shell quoting; a backtick or ${ ends the JS
  // template the shell is built in. Backslashes are legitimate regex escapes,
  // so they are not disqualifying on their own.
  return embedded.filter(p => /['`]|\$\{/.test(p.ere)).map(p => p.id);
}
