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
 *
 * THE FIRST VALUE CHARACTER MAY NOT BE `=` (#489)
 *
 * `=` is in the value charset because base64 pads with it. Minified
 * JavaScript collapses whitespace, so `if (e.password === t.password) {...}`
 * — which does NOT match, the space after `===` ends the value at two
 * characters — comes out of a minifier with the spaces gone and then
 * presented as `password` -> `=` -> `==t.password`, twelve characters all
 * inside the charset, matched by nothing in the allowlist, and the generated
 * job's branch is `exit 1` rather than a warning. Every consumer with
 * committed minified build output hard-failed CI on a comparison.
 *
 * So the value is split: one leading character from the charset WITHOUT `=`,
 * then eleven or more from the full charset. Twelve total, unchanged. Every
 * `===`, `==` or `=>` comparison produces a value beginning with `=` and is
 * now excluded; no real credential form this pattern can see begins with one
 * — measured against the detectable control set, not assumed.
 *
 * This narrows the detector, which is the change most likely to buy green
 * with blindness, so the boundary is a mutation battery in
 * test/unit/secret-patterns.test.ts rather than this comment.
 *
 * ONE BLIND SPOT THAT IS NOT #489 AND MUST NOT BE FIXED HERE
 *
 * The charset excludes `"` and `'`, so a quoted literal — the normal way a
 * credential is written in TS, JS, Python and JSON — stops the match at the
 * opening quote. That is a real gap and a separate issue: widening the
 * charset in the same change would make this narrowing unmeasurable, because
 * the minified fixtures would then match for a new reason. The test file pins
 * it so a widening cannot ride along.
 *
 * The second blind spot recorded here — no `-i`, so `PASSWORD` and
 * `DB_PASSWORD` were invisible — is closed by `TIER2_GREP_CASE_FLAG` below
 * (#844). It is kept out of the expression itself deliberately: spelling the
 * vocabulary as `[Pp][Aa][Ss][Ss]...` would quadruple the length of a string
 * that is read in a generated workflow by whoever is debugging a blocked
 * commit, for no behaviour a flag does not already buy.
 */
export const TIER2_ASSIGNMENT_ERE =
  "(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+_.-][A-Za-z0-9/+=_.-]{11,}";

/**
 * The flag every tier-2 grep carries, and tier 1 carries nowhere (#844).
 *
 * Environment variables and shell defaults are conventionally UPPERCASE, so
 * the spelling a case-sensitive `(password|passwd|api[_-]?key|secret)` can
 * see is the one real credentials are least often written in. Measured on
 * six realistic inputs, tier 2 scored 0 on all three uppercase spellings and
 * 1 on all three lowercase ones; `-i` takes all six to 1. The live instance
 * is a consumer repository that committed a real API key in a shell default
 * of the form `<NAME>_KEY="${<NAME>_API_KEY:-<key>}"`; the scaffolded gate
 * reported clean for as long as it sat on the default branch, because the
 * pattern could not see an uppercase variable name. The consumer and the
 * issue are named in `test/unit/secret-patterns.test.ts` — a module under
 * `lib/` may carry no consumer-specific value (SC-A1).
 *
 * **It is a constant and not a literal in the generators for the reason the
 * rest of this file exists.** Four positions consume it — the capture and
 * the allowlist, in `gates.yml` and in the generated pre-commit hook — and
 * four hand-typed flags are four things that can disagree about what counts
 * as a secret. The cheapest wrong fix for #844 is to add `-i` to the
 * committed `gates.yml` and stop: the symptom disappears for the repository
 * that noticed it, every consumer's next scaffold writes the gate back
 * without it, and so does this one's.
 *
 * **Tier 1 must never carry it.** Its patterns are anchored key FORMATS —
 * `AKIA`, `ghp_`, a PEM header — whose case is part of the format. A
 * case-insensitive tier 1 is a widening of the one tier that has no
 * allowlist to absorb a false positive.
 */
export const TIER2_GREP_CASE_FLAG = "-i";

/**
 * Values that look like credentials but are not.
 *
 * Applied to the extracted VALUE, never the whole line. Matching anywhere on
 * the line was an allowlist escape: appending `# placeholder` to a line
 * holding a real secret laundered it past the scan.
 *
 * READ CASE-INSENSITIVELY TOO, AND THAT IS A WIDENING (#844)
 *
 * The exclusion carries `TIER2_GREP_CASE_FLAG` in the same positions the
 * capture does. This widens what is let through, which is the direction that
 * fails open, so it is a deliberate choice rather than symmetry for its own
 * sake: the population newly visible to the capture is dominated by `.env`
 * and `.env.example` files, where the conventional spelling of a non-value
 * is `API_KEY=CHANGEME` and `SECRET=PLACEHOLDER`. Closing the case gap
 * without it would hard-fail CI — the generated job's branch is `exit 1`,
 * not a warning — for every consumer who committed the example env file the
 * documentation told them to, which is a gate consumers delete.
 *
 * The exclusion stays anchored at `[:=][[:space:]]*`, so a value is only let
 * through when it STARTS with one of these tokens. A credential beginning
 * with the letters of `getenv` or `placeholder` is the laundering this
 * widens, and no form of it was detectable before either.
 */
export const TIER2_ALLOWED_VALUE_ERE =
  "^$|[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)";

/**
 * Tier 3 — a credential written as a shell default, caught by SHAPE.
 *
 * Tiers 1 and 2 both need something in the text to tell them where to look: a
 * provider prefix, or a variable name carrying credential vocabulary. A shell
 * default gives neither when the variable is named for what it holds rather
 * than for what kind of thing it is, and it is camouflaged in a way an
 * assignment is not — every neighbouring line in such a block genuinely is a
 * default, so the one that is not sits in a list of things that look alike.
 *
 * TWO DISCRIMINATORS, AND ONE OF THEM IS ON THE NAME SIDE (#848)
 *
 * The name must begin with a letter or underscore, which excludes positional
 * parameters. A positional parameter is an argument, never a credential
 * declaration, and both false positives this repository had were that shape.
 *
 * The VALUE must carry both a letter and a digit, which is the exclusion
 * below rather than part of this expression — a `grep -oE` capture cannot
 * express "contains one of these and one of those" without an alternation
 * that doubles its length, and the two-stage pipeline tier 2 already uses
 * reads better and is the shape every generated scanner already has.
 *
 * THE FLOOR IS NOT THE DISCRIMINATOR, AND REACHING FOR IT IS THE WRONG FIX
 *
 * Measured on a consumer tree: the false-positive values are 13, 13, 13, 13,
 * 23 and 32 characters, and the real credential is 32. No length floor
 * separates them. 12 is kept to match tier 2, as a floor and nothing more.
 *
 * MEASURED BEFORE IT WAS SHIPPED
 *
 * Captured / reported after the exclusion, over the tracked files of this
 * repository and three consumer trees: 0/0 of 1138, 10/1 of 1726, 0/0 of
 * 374, 0/0 of 52. Zero false positives over 3,290 tracked files, and the one
 * reported hit is already caught by tier 2 because its name carries
 * `API_KEY` — so on every tree available to measure, this tier adds nothing.
 * The population it exists for has to be constructed, which is what
 * `test/unit/secret-patterns.test.ts` does, and the constructed case asserts
 * tier 2 reads CLEAN on it or this tier is measuring nothing #844 did not
 * already do.
 *
 * The trees are named in that test file and deliberately not here: a module
 * under `lib/` may carry no consumer-specific value (SC-A1), which is the
 * same rule the `-i` note above defers to.
 *
 * A narrower charset with `/` removed — the obvious way to kill relative-path
 * defaults — captures 8 instead of 10 on the consumer and reports the same 1.
 * It differs only in captures the exclusion throws away, and it costs base64
 * secrets, which carry `/`. Declined on the measurement, not on an argument.
 *
 * WHY `[$][{]` AND NOT `\$\{`
 *
 * Every pattern here is interpolated into a JS template literal on its way to
 * generated shell. A literal `$` adjacent to a `{` inside one of those is an
 * interpolation, and `unshellSafePatterns()` below refuses any pattern
 * carrying that adjacency. Bracket expressions say the same thing in POSIX
 * ERE with no backslash and no adjacency, and `[{]` additionally avoids a
 * bare `{`, which some greps read as the start of an interval.
 *
 * NO CASE FLAG, DELIBERATELY. Tier 2 needs `-i` because its vocabulary is
 * spelled in one case and credentials are written in another. This tier has
 * no vocabulary: every character class is already written for both cases, and
 * the exclusion is structural rather than a list of words. `-i` here would
 * change nothing except to widen the value class, which is the direction that
 * fails open.
 *
 * WHAT IT DOES NOT CATCH, named rather than left as an omission: a value with
 * no digit at all, a `:=` or bare `-` default, and a quoted value — the last
 * for the same reason recorded for tier 2 above.
 */
export const TIER3_SHELL_DEFAULT_ERE = "[$][{][A-Za-z_][A-Za-z0-9_]*:-[A-Za-z0-9][A-Za-z0-9/+=_.-]{11,}";

/**
 * Values in a shell default that look like credentials but are not.
 *
 * Applied to the extracted MATCH, anchored at the `:-` separator, for the
 * reason tier 2's is anchored at its own: matching anywhere on the line is an
 * allowlist escape.
 *
 * `^$` absorbs the single empty line `printf '%s\n' "$tier3"` produces from an
 * empty capture — the same device tier 2's exclusion uses.
 *
 * The other two alternatives are the discriminator: a value with no digit, or
 * a value with no letter, is let through. That one rule covers every false
 * positive measured on three consumer trees — path defaults, scan-directory
 * defaults and container names are letters and separators, port and timeout
 * defaults are digits — and it subsumes the placeholder vocabulary tier 2
 * needs a word list for, since `CHANGEME`, `placeholder` and `REDACTED` all
 * carry no digit.
 *
 * `:` is not in the value charset and the name charset excludes it too, so
 * `:-` occurs exactly once in any captured match and these anchors cannot
 * attach to the wrong place.
 */
export const TIER3_ALLOWED_VALUE_ERE = "^$|:-[^0-9]*$|:-[^A-Za-z]*$";

/** Tier 1 as one alternation, parenthesised and ready to embed in `grep -E '...'`. */
export function tier1Ere(): string {
  return `(${TIER1_SECRET_PATTERNS.map(p => p.ere).join("|")})`;
}

/**
 * Tier 2, ready to embed in `grep -E '...'`.
 *
 * Mirrors `tier1Ere()` so the generator has ONE binding to interpolate for
 * each tier. It had `tier1Ere()` and then a hardcoded copy of the tier-2
 * string, which is the two-deciders shape this file's header says the
 * registry exists to prevent — and it cost #489: the narrowing had to be
 * applied in three places that nothing compared.
 */
export function tier2Ere(): string {
  return TIER2_ASSIGNMENT_ERE;
}

/**
 * Tier 3, ready to embed in `grep -E '...'`.
 *
 * Mirrors `tier1Ere()` and `tier2Ere()` for the same reason: the generator
 * interpolates ONE binding per tier, so a mutation of a tier has one site.
 */
export function tier3Ere(): string {
  return TIER3_SHELL_DEFAULT_ERE;
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
    { id: "tier3-shell-default", ere: TIER3_SHELL_DEFAULT_ERE },
    { id: "tier3-allowlist", ere: TIER3_ALLOWED_VALUE_ERE },
  ];
  // A single quote ends the shell quoting; a backtick or ${ ends the JS
  // template the shell is built in. Backslashes are legitimate regex escapes,
  // so they are not disqualifying on their own.
  return embedded.filter(p => /['`]|\$\{/.test(p.ere)).map(p => p.id);
}
