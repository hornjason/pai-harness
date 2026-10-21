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

/*
 * There was a `hookProbe?: string` here for one commit, and the second
 * security review of #868 was right that it should not exist.
 *
 * The parity guard used to grep the hook for a PREFIX of each ERE, derived by
 * cutting at the first metacharacter. That derivation yields `eyJ` for `jwt`
 * and `sk-` for `openai` — three characters each — and the guard skipped
 * anything under four, which is how the hook went its whole life missing
 * `jwt` entirely and carrying `{48}` where this registry says `{20,}`. The
 * first repair made a short derivation demand an explicit probe rather than
 * waive the check.
 *
 * That was still the weaker design, for a reason the review named: a probe is
 * a DECLARATION, and nothing checked it was even a substring of its own ERE.
 * A prefix also cannot see a hook that carries the right prefix and the wrong
 * quantifier, which is precisely the `{48}` defect.
 *
 * The guard now greps the hook for each pattern's ENTIRE ere. Measured: all
 * nine are already present verbatim in `scripts/git-hooks/pre-commit`, modulo
 * `\-` for `-` inside a bracket expression, so the stronger check needed no
 * per-pattern metadata at all. It catches both halves of the historical gap —
 * a missing pattern and a narrowed one — with one assertion and no field.
 */

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
  // The hook carried `{48}` against this `{20,}` until #868, and the parity
  // guard could not say so: `sk-` is the derived prefix and three characters
  // long, so the guard skipped this entry for its whole life. A 30-character
  // key committed cleanly and was caught in CI, which is the gap the skip was
  // hiding in the OTHER direction from `jwt` — not a missing pattern, a
  // narrowed one. A prefix probe could not have caught it either: `sk-` is in
  // the hook under both quantifiers. Comparing the whole ERE can.
  { id: "openai", ere: "sk-[A-Za-z0-9]{20,}", description: "OpenAI-style API key" },
  { id: "anthropic", ere: "sk-ant-[A-Za-z0-9-]{90,}", description: "Anthropic API key" },
  {
    id: "private-key",
    ere: "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    description: "PEM private key block",
  },
  // #863. The one unquoted credential form that LOOKS like a dotted
  // identifier path, which is the population `TIER2_DOTTED_PATH_ERE` below
  // removes from tier 2. Tier 2 cannot tell the two apart — the shape IS the
  // same — so the exclusion would launder a bearer token out of a `.env`.
  //
  // It belongs here and not there because a JWT is a FORMAT, not a shape:
  // both the header and the payload are base64url of a JSON object, so both
  // begin `eyJ`, and two anchored prefixes separated by a dot is not
  // something ordinary source produces. That is what makes it safe in the
  // tier with no allowlist.
  //
  // The signature segment is required. A two-segment `alg: none` token is
  // not a credential, and matching two segments alone would catch
  // `a.b`-shaped prose beginning with those three letters.
  //
  // THE SIGNATURE FLOOR IS 43 AND IT IS A FORMAT FACT, NOT A TUNING (#863)
  //
  // A JWS signature is a fixed-width base64url encoding of a fixed-width
  // MAC or signature, so the shortest one any standard algorithm produces is
  // HS256's 32 bytes — 43 base64url characters. ES256 is 86, RS256 342.
  // There is no signed JWT below the floor, so nothing is given up by it.
  //
  // What it buys is the false-positive side, which tier 1 cannot absorb.
  // Measured 2026-10-21 on one consumer tree: a `{10,}` signature reports
  // two quoted browser-test fixtures whose third segment is an English
  // phrase of 21 and 26 characters. Both are JWT-shaped and neither is a
  // token, and tier 1 has no allowlist to excuse them — so that consumer's
  // Gates job would have gone from red on two property references to red on
  // two test fixtures, which is #863 reintroduced by its own fix. The tree
  // and the lines are named in `test/unit/gates-tier1-jwt.test.ts`; a module
  // under `lib/` may carry no consumer-specific value (SC-A1).
  {
    id: "jwt",
    ere: "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{43,}",
    description: "JSON Web Token (signed, three segments)",
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
export const TIER2_KEY_ERE = "(password|passwd|api[_-]?key|secret)";

export const TIER2_ASSIGNMENT_ERE =
  `${TIER2_KEY_ERE}[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+_.-][A-Za-z0-9/+=_.-]{11,}`;

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
/**
 * An unquoted value that is a DOTTED IDENTIFIER PATH, not a literal (#863).
 *
 * `-i` (above) made `api[_-]?key` match `apiKey`, which it could not before.
 * `apiKey` is the conventional TypeScript spelling, so every consumer that
 * passes a key through an object property started hard-failing the gate on
 * lines like `apiKey:` config.judge.apiKey — a property REFERENCE, excused by
 * nothing in the list above, and the generated job's branch is `exit 1`, not
 * a warning. A secret gate that hard-fails CI on a property reference is a
 * gate a consumer deletes, and deleting it costs the #844 fix too.
 *
 * WHY THIS CANNOT HIDE A CREDENTIAL THE CAPTURE CAN SEE
 *
 * The value charset excludes `"` and `'`, so in a source file tier 2 can only
 * ever see an UNQUOTED value — and an unquoted value in source is an
 * expression. The false-positive class is precisely dotted identifier paths,
 * so excluding them removes no credential FORM this pattern is able to
 * report, with one exception, which is why the exception is a tier-1 pattern:
 * a signed JWT has this exact shape and is reachable in a `.env`. See the
 * `jwt` entry in `TIER1_SECRET_PATTERNS`.
 *
 * It is anchored at BOTH ends of the value — `[:=][[:space:]]*` on the left,
 * `$` on the right — so the whole value must be the path. The cheapest wrong
 * fix for #863 is an "anything unquoted" exclusion, which deletes tier 2 for
 * every source file while making the symptom go away; dropping the `$` is
 * that fix wearing one character. An `API_KEY=` carrying `sk-live` and
 * eighteen more characters has no dot and stays a FAIL, and so does a
 * `${NAME_API_KEY:-...}` default, whose value begins `-`.
 *
 * Every example in this module is written so it is NOT itself a tier-2
 * capture — the value is described rather than spelled, or a character
 * outside the value charset leads it. A docstring that its own scanner
 * reports is a module that fails the repository's Gates job the day somebody
 * narrows one of these expressions, and the failure would name this file
 * rather than their change.
 *
 * It is a named constant rather than six more tokens inside the string below
 * because it is the component a reader of a blocked commit needs to find, and
 * because `test/unit/gates-tier1-jwt.test.ts` asserts the committed
 * `gates.yml` carries THIS and not a hand-typed near-copy. It is still a
 * component OF the allowlist and not a second expression the generator joins
 * on its own: four generated greps interpolate one allowlist binding, and a
 * second string to interpolate is a second thing that can disagree about what
 * counts as a secret.
 *
 * THE ROOT IS A CLOSED VOCABULARY, AND THE FIRST DRAFT'S WAS NOT
 *
 * This read `[A-Za-z_][A-Za-z0-9_]*` for the first segment — any identifier —
 * and the security review of PR #868 was right that it is a hole. The premise
 * above is that an unquoted value is an EXPRESSION, and that premise is a fact
 * about source languages, not about every file a `git grep -- .` reaches. In a
 * dotenv file, a shell script or a YAML document an unquoted dotted value is a
 * LITERAL, and some credentials are literally shaped like an identifier path:
 * a key of the form two letters, a dot, a base62 run, a dot, another base62
 * run — the shape one well-known mail provider issues — walks through an
 * any-identifier root. Measured on the first draft: it was excused.
 *
 * So the root is a fixed list of the words real code roots an expression at.
 * It is the same decision as the placeholder vocabulary below and for the same
 * reason: a closed list of words is auditable, and "anything shaped like an
 * identifier" is a judgement the scanner is not entitled to make. A consumer
 * whose expression roots at a word not on this list gets a false positive and
 * a one-line change here, which is the direction this is allowed to be wrong
 * in — the other direction is a credential nobody sees.
 */
export const TIER2_EXPRESSION_ROOT_ERE =
  "(process|os|Deno|globalThis|module|exports|this|self|config|conf|cfg|" +
  "settings|options|opts|env|deps|current|ctx|context|params|args|argv|" +
  "input|data|state|store|creds|credentials|auth|secrets|vars)";

export const TIER2_DOTTED_PATH_ERE =
  `${TIER2_EXPRESSION_ROOT_ERE}(\\.[A-Za-z_][A-Za-z0-9_]*)+`;

/**
 * The FIXED vocabulary of documented non-values (#863).
 *
 * The dotted-path exclusion above covers only two of the seven lines the
 * widened capture reports on one consumer tree. Four of the remaining five
 * are the spelling every getting-started document in the world uses,
 * measured 2026-10-21. The tree and the file positions are named in
 * `test/unit/gates-tier1-jwt.test.ts`, which also carries the four lines
 * byte-exact; a module under `lib/` may carry no consumer-specific value
 * (SC-A1). The shapes, with this file's own angle brackets:
 *
 *   API_KEY:- <your-api-key-goes-here>
 *   API_KEY= <your_key_here>
 *   API_KEY= <your_gemini_key_here>
 *   SECRET:- <example-value-not-real>
 *
 * (The angle brackets and the space are this file's, not the consumer's —
 * see the note above about a docstring that matches its own scanner.)
 *
 * A fix measured only on the repository that reported it is a fix measured on
 * one input, and the dotted-path class alone leaves a second consumer red.
 *
 * WHAT MAKES THIS SAFE AND AN "IT LOOKS HARMLESS" RULE NOT
 *
 * This is a VOCABULARY — a closed list of words — not a judgement about
 * whether a value looks like a credential. `your[_-]` and `example[_-]`
 * require the separator, so the exclusion is the documented placeholder
 * idiom and not every value beginning with four common letters.
 * An `API_KEY=` carrying `sk-live` and eighteen more characters carries none
 * of these words and stays a FAIL.
 *
 * It is ONE NAMED CONSTANT and not five more tokens spliced into the string
 * below, for the reason `TIER2_GREP_CASE_FLAG` is one: the positions that
 * consume it are generated into four greps, and a vocabulary a reader cannot
 * point at is a vocabulary that gets re-typed somewhere else.
 *
 * It does NOT widen what the dotted-path exclusion covers and must not be
 * read as a general placeholder heuristic. Adding a word here is adding a
 * word to a gate's blind spot; measure the consumer line that needs it
 * first, the way these four were measured.
 *
 * THE TAIL CARRIES NO DIGIT, AND THE FIRST DRAFT'S COULD
 *
 * `your[_-]` alone is a PREFIX test, so a value beginning with those five
 * characters and continuing into thirty-two random ones was excused — the
 * security review of PR #868 was right, and it reproduced. End-anchoring
 * alone does not fix it, because the tail is still arbitrary.
 *
 * The discriminator is the digit. A documented placeholder is words and
 * separators (`your` then a dash then `api` then a dash then `key`, and so
 * on); a credential is not. The grep that consumes this runs `-i`, so case
 * cannot be the discriminator here even though a real key is usually mixed —
 * which is worth stating, because reaching for `[a-z]` is the obvious move
 * and it silently matches everything under that flag.
 *
 * THAT TAIL RULE HELD FOR TWO OF THE THREE WORDS, AND THE SECOND REVIEW
 * CAUGHT THE THIRD
 *
 * `your[_-]` and `example[_-]` require the separator. `REDACTED|CHANGEME|
 * placeholder` did not — it carried a bare `[A-Za-z_-]*` tail — so a value
 * beginning with one of those three words and continuing into a digit-free
 * random run was excused. Reproduced on the shipped expression: an
 * `API_KEY=` carrying `CHANGEME` and twenty-two more letters read CLEAN.
 * It is the same defect as the `your_` one directly above, in the sibling
 * the first repair did not look at.
 *
 * The separator is now required of all three, which is the rule the other
 * two already stated. It costs nothing real: the consumer shape that needs
 * a tail at all is `Placeholder_value_here`, whose tail begins `_`.
 */
export const TIER2_PLACEHOLDER_VOCAB_ERE =
  "(REDACTED|CHANGEME|placeholder)([_-][A-Za-z][A-Za-z_-]*)?" +
  "|your[_-][A-Za-z][A-Za-z_-]*" +
  "|example[_-][A-Za-z][A-Za-z_-]*";

/**
 * The optional `-` is the SHELL DEFAULT separator, not a widening of the
 * value (#863). Three of the four placeholder lines above are written as a
 * `${NAME_API_KEY:-...}` default, so the character after `[:=]` is `-` and
 * an anchor without it cannot reach the vocabulary at all.
 *
 * It cannot soften `SC-C`: the #844 shape is `${SAPLING_API_KEY:-<32 random
 * chars>}`, whose value begins with no word in the vocabulary, so it is still
 * reported. The anchor decides WHERE to look; the vocabulary decides what is
 * excused, and only the second of those two is a list anyone can lengthen.
 */
const TIER2_VALUE_ANCHOR = `^${TIER2_KEY_ERE}[[:space:]]*[:=][[:space:]]*-?`;

/**
 * THE ENV-LOOKUP BRANCH WAS UNANCHORED, AND THREE QUARTERS OF IT WAS A
 * SECOND DECIDER (second review of #868)
 *
 * It read `(process\.env|os\.environ|Deno\.env|getenv)` and was the only one
 * of the four branches with no `$`. So it was a PREFIX test, and an
 * `API_KEY=` carrying `getenv` and sixteen random characters was excused —
 * the third instance of the unanchored-prefix defect in this one expression,
 * after `your[_-]` and the placeholder vocabulary. Measured on the shipped
 * expression before the repair: CLEAN.
 *
 * Anchoring it closes that. What anchoring alone does NOT do is notice that
 * `process`, `os` and `Deno` have all been in `TIER2_EXPRESSION_ROOT_ERE`
 * since #863 widened the root to a vocabulary — so three of the four
 * alternatives were already excused by the dotted-path branch below, and an
 * anchored branch naming them is two deciders answering one question. A
 * mutation of either would leave the other holding every case up.
 *
 * Measured over this whole tree and nine control lines: the four-alternative
 * branch and a `getenv`-only branch give identical verdicts on every input,
 * including `os.environ.get` and `Deno.env.toObject`.
 *
 * `getenv` is the one that is NOT redundant, because it is a bare function
 * name rather than an object, so no dotted path reaches it. It stays, with
 * the end anchor and an identifier tail.
 *
 * A NOTE ON WHAT THAT TAIL IS FOR, BECAUSE THE FIRST DRAFT DELETED IT
 *
 * This branch was briefly removed outright, on the reasoning that nothing
 * real is shaped like `getenv` followed by an identifier — a bare `getenv`
 * is six characters against a twelve-character floor, and a genuine call
 * writes `getenv(`, which ends the capture at the paren. That reasoning is
 * sound and it is beside the point: #844's own case pins a `SECRET:` whose
 * value is < Getenv_SOME_LONG_NAME > CLEAN, as the fixture proving the
 * allowlist reads case the way the capture does. The class is not empty —
 * there is a case in it. An argument that a class has no members is not
 * evidence when the suite already holds one.
 *
 * (The angle brackets and the spaces are this file's. Spelling that value
 * plainly makes this docstring a tier-2 capture excused only by the branch
 * it is describing — so narrowing the branch would turn the Gates job red on
 * THIS FILE rather than on the change that narrowed it. Measured: it did,
 * and the tier-2 self-scan case in `test/unit/secret-patterns.test.ts` is
 * what reported it. See the note above the dotted-path constant.)
 */
export const TIER2_ALLOWED_VALUE_ERE =
  "^$" +
  `|${TIER2_VALUE_ANCHOR}getenv([A-Za-z_][A-Za-z0-9_]*)?(\\.[A-Za-z_][A-Za-z0-9_]*)*$` +
  `|${TIER2_VALUE_ANCHOR}(${TIER2_PLACEHOLDER_VOCAB_ERE})$` +
  `|${TIER2_VALUE_ANCHOR}${TIER2_DOTTED_PATH_ERE}$`;

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
 * EVERY registry expression that reaches generated shell, each with the id a
 * refusal names it by.
 *
 * One binding, two consumers, because they are one question asked twice.
 * `unshellSafePatterns()` below asks whether each of these survives the trip
 * into a single-quoted shell string; `scripts/check-installed-hook-currency.ts`
 * asks which of them the hook a developer actually commits through is missing
 * (#874). A second list in the check script would be a second decider that
 * agrees with this one right up until somebody adds a pattern to one of them
 * — `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape — and the
 * failure mode is the one this registry exists to prevent: a scanner position
 * nothing compares.
 *
 * Tier 1 is spread rather than re-listed, so an entry added to
 * `TIER1_SECRET_PATTERNS` is covered here without a second edit. The four
 * tier-2 and tier-3 expressions have no list of their own to spread.
 */
export const EMBEDDED_PATTERNS: ReadonlyArray<{ id: string; ere: string }> = [
  ...TIER1_SECRET_PATTERNS.map(p => ({ id: p.id, ere: p.ere })),
  { id: "tier2-assignment", ere: TIER2_ASSIGNMENT_ERE },
  { id: "tier2-allowlist", ere: TIER2_ALLOWED_VALUE_ERE },
  { id: "tier3-shell-default", ere: TIER3_SHELL_DEFAULT_ERE },
  { id: "tier3-allowlist", ere: TIER3_ALLOWED_VALUE_ERE },
];

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
  //
  // A single quote ends the shell quoting; a backtick or ${ ends the JS
  // template the shell is built in. Backslashes are legitimate regex escapes,
  // so they are not disqualifying on their own.
  return EMBEDDED_PATTERNS.filter(p => /['`]|\$\{/.test(p.ere)).map(p => p.id);
}
