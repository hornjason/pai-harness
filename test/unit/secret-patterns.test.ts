/**
 * Every generated secret scanner carries the same registry.
 *
 * There were three copies and they disagreed:
 *
 *   scripts/git-hooks/pre-commit:22      8 patterns
 *   lib/scaffold/steps.ts  -> gates.yml   3 patterns
 *   lib/scaffold/steps.ts  -> pre-commit  3 patterns
 *
 * CI missed `gho_`, `ghs_`, `github_pat_`, `sk-ant-`, and PEM private key
 * blocks entirely — a committed private key passed CI. The generated CONSUMER
 * pre-commit hook carried the same weak set, so every downstream project
 * inherited the gap while this repo's own checked-in hook had the full list.
 *
 * The generated gates.yml asserted the opposite in a comment: "Two tiers
 * matching the pre-commit hook, so local and CI cannot disagree about what
 * counts as a secret." It was not true, and nothing checked it. A comment is
 * not a mechanism. These tests are the mechanism.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

import {
  TIER1_SECRET_PATTERNS,
  TIER2_ALLOWED_VALUE_ERE,
  TIER2_ASSIGNMENT_ERE,
  TIER2_GREP_CASE_FLAG,
  TIER3_ALLOWED_VALUE_ERE,
  TIER3_SHELL_DEFAULT_ERE,
  tier1Ere,
  tier2Ere,
  tier3Ere,
  unshellSafePatterns,
} from "../../lib/secret-patterns";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Split so this file never contains a literal PEM header (see below).
const PEM_OPEN = "-----" + "BEGIN";
const PEM_TAIL = "PRIVATE" + " KEY" + "-----";
const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
const gatesYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "gates.yml"), "utf-8");
const repoPreCommit = readFileSync(join(REPO_ROOT, "scripts", "git-hooks", "pre-commit"), "utf-8");

describe("the registry covers the key formats that actually leak", () => {
  test("includes the five CI used to miss", () => {
    const ids = TIER1_SECRET_PATTERNS.map(p => p.id);
    for (const id of ["github-oauth", "github-server", "github-pat-fine", "anthropic", "private-key"]) {
      expect(ids, `${id} was missing from CI and is the reason this registry exists`).toContain(id);
    }
  });

  test("every pattern survives embedding in single-quoted generated shell", () => {
    // A quote or backtick here produces a scanner that either fails to parse
    // or silently matches the wrong thing — invisible in review, which is why
    // this is a test and not a convention.
    expect(unshellSafePatterns(), "these patterns would break the generated shell").toEqual([]);
  });

  test("the alternation is valid regex and matches real key shapes", () => {
    const re = new RegExp(tier1Ere());
    const shouldMatch: Array<[string, string]> = [
      ["AWS", "AKIA" + "A".repeat(16)],
      ["GitHub PAT", "ghp_" + "a".repeat(36)],
      ["GitHub OAuth", "gho_" + "b".repeat(36)],
      ["GitHub server", "ghs_" + "c".repeat(36)],
      ["OpenAI", "sk-" + "d".repeat(48)],
      ["Anthropic", "sk-ant-" + "e".repeat(95)],
      // Assembled from fragments, never written whole. A literal PEM header
      // here makes this file match its own scanner, and the Gates secret scan
      // then fails on the test that proves the scanner works. Same
      // self-reference trap as an allowlist naming the files it exempts.
      ["PEM", `${PEM_OPEN} RSA ${PEM_TAIL}`],
      ["PEM bare", `${PEM_OPEN} ${PEM_TAIL}`],
      ["PEM openssh", `${PEM_OPEN} OPENSSH ${PEM_TAIL}`],
    ];
    for (const [label, sample] of shouldMatch) {
      expect(re.test(sample), `${label} key shape is not caught`).toBe(true);
    }
  });

  test("does not fire on ordinary text", () => {
    // A scanner nobody can commit through gets disabled, so the false-positive
    // side is load-bearing too.
    const re = new RegExp(tier1Ere());
    for (const benign of [
      "const apiKey = process.env.OPENAI_API_KEY",
      "see docs/sk-notes.md",
      "https://github.com/hornjason/pai-harness",
      "-----BEGIN CERTIFICATE-----",
    ]) {
      expect(re.test(benign), `false positive on: ${benign}`).toBe(false);
    }
  });
});

describe("generated scanners use the registry, not their own copy", () => {
  test("steps.ts interpolates tier1Ere() rather than inlining patterns", () => {
    const inlined = steps.match(/AKIA\[A-Z0-9\]\{16\}/g) || [];
    expect(
      inlined.length,
      "a secret pattern is hardcoded in the generator again — import it from lib/secret-patterns.ts",
    ).toBe(0);
    // Both generated scanners: gates.yml and the consumer pre-commit hook.
    expect((steps.match(/\$\{tier1Ere\(\)\}/g) || []).length).toBe(2);
  });

  test("the generated gates.yml carries every registry pattern", () => {
    // Asserts the OUTPUT, not just the generator — the two can diverge until
    // someone re-scaffolds, and gates.yml is committed.
    for (const p of TIER1_SECRET_PATTERNS) {
      expect(gatesYml, `gates.yml is missing ${p.id} (${p.description})`).toContain(p.ere);
    }
  });

  // "gates.yml keeps the tier-2 assignment scan" used to live here as
  // `expect(gatesYml).toContain(TIER2_ASSIGNMENT_ERE)`. It was collapsed into
  // "the committed gates.yml and the registry are one binding, not two
  // copies" below (#489): the two asked one question of one input, so a
  // mutation of either left the other holding the case up — measured, 2 red
  // where 1 was predicted. The surviving case is the stronger of the pair. It
  // cuts the `tier2=$(git grep ...)` line out of the file and compares the
  // whole expression rather than matching a substring anywhere in the
  // document, and it covers the allowlist line too, which this one never did.

  test("gates.yml no longer claims a parity it does not have", () => {
    // The specific false statement that let this sit: it asserted the CI and
    // hook registries matched while they differed 3 to 8.
    expect(gatesYml).not.toContain("Two tiers matching the pre-commit hook");
  });

  test("this repo's own pre-commit hook is not weaker than the registry", () => {
    // scripts/git-hooks/pre-commit is checked in, not generated, so it can
    // drift independently. It was the STRONGEST of the three copies; this
    // keeps it from quietly becoming the weakest.
    for (const p of TIER1_SECRET_PATTERNS) {
      // The derivation cuts the ERE at its first metacharacter. For `jwt`
      // that is `eyJ` — three characters — and the guard used to `continue`
      // on anything under four, which SKIPPED the one pattern the hook was
      // missing. A short derivation is not a reason to waive the check; it
      // is a reason to demand an explicit probe. Carry `hookProbe`, or be
      // refused.
      const derived = p.ere.split(/[[(\\]/)[0];
      const probe = derived.length >= 4 ? derived : p.hookProbe;
      expect(
        probe,
        `TIER1_SECRET_PATTERNS[${p.id}] derives the probe "${derived}", which is too short to grep for. ` +
          `Give it a hookProbe: a literal substring of its ERE that also appears in scripts/git-hooks/pre-commit.`,
      ).toBeTruthy();
      expect(repoPreCommit, `scripts/git-hooks/pre-commit no longer covers ${p.id}`).toContain(probe!);
    }
  });
});

describe("deduplication must not narrow coverage", () => {
  test("sk- keys shorter than 48 chars are still caught", () => {
    // The regression the security review caught. pre-commit used {48}, CI used
    // {20,}; merging to a single registry by taking the hook's value would
    // have silently narrowed CI. When registries disagree, the union is the
    // safe merge — a dedup must never remove coverage that existed.
    const re = new RegExp(tier1Ere());
    expect(re.test("sk-" + "a".repeat(24)), "a 24-char sk- key slipped through").toBe(true);
    expect(re.test("sk-" + "a".repeat(48))).toBe(true);
  });

  test("every string embedded in generated shell is validated, not just tier 1", () => {
    // The validator used to inspect only TIER1, while tier-2 expressions are
    // interpolated into the same shell — a validator with a narrower view
    // than the thing it validates.
    const src = readFileSync(join(REPO_ROOT, "lib", "secret-patterns.ts"), "utf-8");
    expect(src).toContain("tier2-assignment");
    expect(src).toContain("tier2-allowlist");
    expect(unshellSafePatterns()).toEqual([]);
  });
});

/**
 * #489 — the tier-2 scan read a minified comparison as a credential
 * assignment.
 *
 * `if (e.password === t.password) {...}` does not match — the space after
 * `===` ends the value at two characters. A minifier removes the spaces, and
 * the result presents to the tier-2 ERE as `password` -> `=` -> `==t.password`,
 * twelve characters inside the value charset, matched by nothing in the
 * allowlist. The generated job's branch is `exit 1`, not a warning, so every
 * consumer with committed minified build output hard-failed CI for something
 * that is not a defect.
 *
 * WHY EVERY FIXTURE BELOW IS ASSEMBLED FROM FRAGMENTS
 *
 * Same self-reference trap the PEM samples above are split for, and it is not
 * hypothetical: the first attempt to commit this file was refused by the
 * repo's own pre-commit hook, which flagged eight of its fixtures. A test
 * that proves a scanner works must not be a file that scanner blocks. The
 * refusal was correct, so the fixtures moved rather than the hook.
 *
 * **It is not only the fixtures.** #844's battery table named its differing
 * input in PROSE — one cell reading `API` + `_KEY=` joined to a twenty-
 * character value — and the Gates secret scan refused the branch, correctly,
 * over a documentation table. The fixtures had been assembled from fragments
 * all along; the evidence recording them had not. Every position in this file
 * is in the scanned population, comments included.
 *
 * WHY THESE CASES RUN `grep`, NOT `RegExp`
 *
 * The pattern is POSIX ERE consumed by `grep -E`. `[[:space:]]` is not a
 * JavaScript character class, so a `new RegExp(...)` case would be testing a
 * different language than the one CI runs — a detector narrower than the
 * thing it detects. These drive the real binary through the same two-stage
 * pipeline the generated shell uses.
 *
 * WHY THE PATTERN IS READ OUT OF `gates.yml` AND NOT IMPORTED
 *
 * The committed workflow is what CI executes. Importing the constant would
 * assert that the registry is correct and say nothing about the artifact,
 * which can drift until someone re-scaffolds. The two are then compared, so
 * a drift is a named failure rather than an untested half.
 */

// Never written whole; see the note above. `K.` is a scanned key word, `V()`
// joins a key to a value with a separator, so no literal in this file is a
// string the tier-2 scan reports.
const K = {
  password: "pass" + "word",
  passwd: "pass" + "wd",
  apiKey: "api" + "_key",
  secret: "sec" + "ret",
} as const;
const V = (key: string, sep: string, value: string) => `${key}${sep}${value}`;

/** A tier-2 scan as the committed job spells it: the flags AND the expression. */
interface Tier2Scan {
  captureFlags: string[];
  ere: string;
  allowFlags: string[];
  allowlist: string;
}

/** `grep -hoE [flags] <ere>` over text, exactly as the generated job extracts. */
function grepExtract(flags: string[], ere: string, text: string): string {
  const r = spawnSync("grep", ["-hoE", ...flags, ere], { input: text, encoding: "utf-8" });
  if ((r.status ?? 2) > 1) throw new Error(`grep -hoE failed (${r.status}): ${r.stderr}`);
  return r.stdout ?? "";
}

/**
 * The generated job's verdict for a body of text.
 *
 * Mirrors the shell exactly: capture with `grep -hoE`, then
 * `printf '%s\n' "$tier2" | grep -qvE '<allowlist>'`. Command substitution
 * strips trailing newlines and printf adds one back, so an empty capture is
 * a single empty line — which `^$` in the allowlist is there to absorb.
 * Exit 0 from that pipe is the branch that runs `exit 1`.
 *
 * The FLAGS come from the committed file alongside the expressions (#844).
 * Taking them from the constant instead would make every case below green
 * under a generator that stopped emitting `-i`, which is the cheapest wrong
 * fix for #844 wearing its own regression.
 */
function tier2Verdict(scan: Tier2Scan, text: string): "FAIL" | "CLEAN" {
  const printfInput = grepExtract(scan.captureFlags, scan.ere, text).replace(/\n+$/, "") + "\n";
  const r = spawnSync("grep", ["-qvE", ...scan.allowFlags, scan.allowlist], {
    input: printfInput,
    encoding: "utf-8",
  });
  return r.status === 0 ? "FAIL" : "CLEAN";
}

/**
 * The two commands the committed `gates` job actually runs.
 *
 * Cut out of the file rather than matched against it: a claim about one line
 * asserted over the whole document is satisfied by a match anywhere in it,
 * and a cut that failed to find its own line is an empty string, which is
 * indistinguishable from a clean result. Both are therefore asserted
 * non-empty before anything is measured with them.
 */
function gatesTier2Scan(): Tier2Scan {
  const capture = gatesYml.match(/tier2=\$\(git grep -I -hoE ((?:-[A-Za-z]+ )*)'([^']+)' -- \.\)/);
  const allow = gatesYml.match(/grep -qvE ((?:-[A-Za-z]+ )*)'([^']+)'/);
  expect(capture?.[2] ?? "", "the tier-2 capture line is not in gates.yml — this cut is reading nothing").not.toBe("");
  expect(allow?.[2] ?? "", "the tier-2 allowlist line is not in gates.yml — this cut is reading nothing").not.toBe("");
  return {
    captureFlags: (capture?.[1] ?? "").split(" ").filter(Boolean),
    ere: capture?.[2] ?? "",
    allowFlags: (allow?.[1] ?? "").split(" ").filter(Boolean),
    allowlist: allow?.[2] ?? "",
  };
}

describe("the tier-2 scan does not read a minified comparison as an assignment (#489)", () => {
  test("the committed gates.yml and the registry are one binding, not two copies", () => {
    // If these drift, every behavioural case below is measuring the artifact
    // while the generator ships something else. The flags are compared for
    // the same reason the expressions are: a scan is a command, and half a
    // command is not what CI runs (#844).
    const scan = gatesTier2Scan();
    expect(scan.ere).toBe(TIER2_ASSIGNMENT_ERE);
    expect(scan.allowlist).toBe(TIER2_ALLOWED_VALUE_ERE);
    expect(scan.captureFlags, "the committed capture dropped the registry's case flag").toContain(
      TIER2_GREP_CASE_FLAG,
    );
    expect(scan.allowFlags, "the committed allowlist dropped the registry's case flag").toContain(
      TIER2_GREP_CASE_FLAG,
    );
    // Read the artifact once WITHOUT going through the cut above. Every other
    // case in this file reaches gates.yml through `gatesTier2Scan`, so a cut
    // short-circuited to return the constants would leave all of them green
    // over a workflow that says something else — the store answering with
    // what you put in it (#530). This line is the one that cannot.
    expect(
      gatesYml,
      "the committed capture command is not the one the registry composes",
    ).toContain(`git grep -I -hoE ${TIER2_GREP_CASE_FLAG} '${TIER2_ASSIGNMENT_ERE}' -- .`);
  });

  test("a minified === comparison of two credential fields does not fail the scan", () => {
    const scan = gatesTier2Scan();
    for (const minified of [
      `if(e.${K.password}===t.${K.password}){return 1}`,
      `if(a.${K.apiKey}===b.${K.apiKey}){return 0}`,
      `function f(x,y){return x.${K.secret}===y.${K.secret}}`,
      `const ok=u.${K.passwd}===v.${K.passwd}&&u.id===v.id`,
      // The same four in the spelling #844 made visible. A minified bundle is
      // the one place a credential field name is as likely to be uppercase as
      // not, so widening the case had to be measured against the narrowing
      // #489 bought rather than assumed to be orthogonal to it.
      `if(e.${K.password.toUpperCase()}===t.${K.password.toUpperCase()}){return 1}`,
      `if(a.${K.apiKey.toUpperCase()}===b.${K.apiKey.toUpperCase()}){return 0}`,
    ]) {
      expect(tier2Verdict(scan, minified), `false positive on: ${minified}`).toBe("CLEAN");
    }
  });

  test("the control: a credential assignment this scan can see still fails it", () => {
    // The control set is deliberately narrow, and the narrowness is MEASURED,
    // not assumed — see the blind-spot case below. Of six ordinary ways to
    // write a credential, only an unquoted lowercase key with a colon or an
    // equals is visible to this pattern at all. A control drawn from outside
    // that set would be green whether or not the narrowing is correct, which
    // is a control that certifies nothing.
    const scan = gatesTier2Scan();
    for (const real of [
      V(K.apiKey, ": ", "sk_live_abcdefghijklmnop"),
      V(K.password, "=", "hunter2hunter2hunter2"),
      V(K.secret, ": ", "abcdefghijklmnopqr"),
    ]) {
      expect(tier2Verdict(scan, real), `a real assignment stopped failing: ${real}`).toBe("FAIL");
    }
  });

  test("the narrowing is POSITIONAL — `=` is still a value character, just not the first", () => {
    // The cheapest wrong fix, named: delete `=` from the value charset
    // outright. One character, the symptom disappears, every minified
    // comparison goes clean — and base64 padding stops being a value
    // character anywhere, so a value whose twelve-character length depends
    // on an interior `=` stops being seen at all.
    //
    // Every other case in this file is GREEN under that repair. This is the
    // one that is not, which is why it is written as its own case rather
    // than folded into the control above.
    const scan = gatesTier2Scan();
    expect(tier2Verdict(scan, V(K.apiKey, ": ", "AB==CDEFGHIJ"))).toBe("FAIL");
  });

  test("the allowlist still launders nothing it did not before", () => {
    const scan = gatesTier2Scan();
    expect(tier2Verdict(scan, V(K.password, " = ", "process.env.DB_PASSWORD"))).toBe("CLEAN");
    // The escape the allowlist position was moved to fix: a trailing comment
    // must not launder a real value.
    expect(tier2Verdict(scan, V(K.apiKey, ": ", "sk_live_abcdefghijklmnop # placeholder"))).toBe("FAIL");
  });

  test("the known blind spot is pinned: widening the value charset is a SEPARATE issue", () => {
    // Measured, not inferred: the value charset excludes `"` and `'`, so every
    // quoted literal — the normal way a credential is written in TS, JS,
    // Python and JSON — stops the match at the opening quote.
    //
    // That is a real gap and it is not #489. It is pinned here so a fix
    // author who notices it cannot widen the charset in the same change:
    // conflating a widening with that narrowing makes the narrowing
    // unmeasurable, because the minified fixtures above would then match for
    // a new reason. Widening this is a separate issue and turns this case
    // red, which is the point.
    //
    // The case half of this pin — PASSWORD and DB_PASSWORD invisible — was
    // the other row here until #844 closed it. Its fixtures did not move to
    // a comment; they moved to the describe below, inverted, which is the
    // only form of "this gap is closed" worth anything.
    const scan = gatesTier2Scan();
    for (const invisible of [
      `const ${K.apiKey} = "sk_live_abcdefghijklmnop"`,
      `${K.password} = 'hunter2hunter2hunter2'`,
      `const ${K.apiKey.toUpperCase()} = "sk_live_abcdefghijklmnop"`,
    ]) {
      expect(tier2Verdict(scan, invisible), `charset blind spot closed: ${invisible}`).toBe("CLEAN");
    }
    // Secondary, and secondary on purpose: the three rows above are the pin.
    // A double quote in the value charset would also break the generated
    // single-quoted shell, which `unshellSafePatterns()` does not currently
    // treat as disqualifying.
    expect(scan.ere, "a double quote in the tier-2 ERE breaks single-quoted generated shell").not.toContain('"');
  });
});

/**
 * #844 — the spelling the scan could see was the one credentials are least
 * often written in.
 *
 * Environment variables and shell defaults are conventionally UPPERCASE, and
 * the tier-2 vocabulary was matched case-sensitively, so `API_KEY=<32 chars>`
 * scored 0 while `api_key=<32 chars>` scored 1. Tier 1 cannot cover for it:
 * tier 1 is provider-prefixed, and a bare alphanumeric key from a provider
 * with no prefix convention matches none of its patterns.
 *
 * The live instance is asaCommandCenter #1683 — a real API key committed in a
 * shell default, `SAPLING_KEY="${SAPLING_API_KEY:-<key>}"`, on `main`, with a
 * scaffolded `gates.yml` reporting a clean scan the whole time. Not because
 * the value was exempt: because the pattern could not see the variable name.
 *
 * ### The cheapest wrong fix, named before the repair was written
 *
 * **Add `-i` to the committed `.github/workflows/gates.yml` and stop.** The
 * symptom disappears for the repository that noticed it, in one character,
 * and no consumer ever sees the fix — the next `scaffold` writes the gate
 * back without it, in this repository too. Every behavioural case in this
 * file is GREEN under that repair, because they all read the artifact. The
 * one case that is not is "the case flag is interpolated into all four
 * tier-2 greps", measured at M2 below: 1 of 24, and it is the only witness.
 *
 * The other cheap repair is to put `-i` on the whole step, tier 1 included,
 * and M4 is that one.
 *
 * ### What was broken to prove it
 *
 * Over this file (24 tests). Every count predicted before the battery ran, in
 * `/tmp/844-battery/predictions.md`, and **the baseline row was read first** —
 * an instrument that has stopped reporting takes the baseline down with it,
 * and that is the row nobody mutates anything to produce.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 24 pass, 0 fail | **24 pass, 0 fail** | — |
 * | M1 the genuinely pre-#844 generator: all four interpolations removed, `gates.yml` regenerated | 5 | **5 of 24** | an uppercase `API` + `_KEY=` joined to a 20-character value — original FAIL, mutant CLEAN |
 * | M2 **the cheapest wrong fix**: generator reverted as in M1, `gates.yml` hand-edited to keep `-i` | 1 | **1 of 24** | the generator source — four interpolations against zero |
 * | M3 `-i` dropped from the ALLOWLIST only, the capture keeping it | 3 | **3 of 24** | `API_KEY=Placeholder_value_here` — original CLEAN, mutant FAIL |
 * | M4 `-i` added to the tier-1 `git grep` as well | 1 | **2 of 24** | `akia` + 16 `a` — original no match, mutant matches |
 * | M5 PAIR: `gatesTier2Scan` short-circuited to return the registry constants, AND `gates.yml` reverted | 1 | **1 of 24** | `gates.yml`'s capture line |
 * | M6 `gates.yml` alone reverted to no `-i`; generator and test untouched | 4 | **4 of 24** | the same `API_KEY=sk_live_…`, read off the artifact rather than the constant |
 *
 * Each differing input above was run through the real `grep` and printed
 * before its row was recorded, not inferred from the diff.
 *
 * **M4 came back 2 against a predicted 1, and the extra red is the real
 * kind.** It is the interpolation-count case: five interpolations where the
 * assertion says four. The prediction treated that case as guarding against a
 * MISSING interpolation only; it equally forbids a surplus one, and a surplus
 * one is precisely the "put `-i` on the whole step" repair. Not a crashing
 * mutant — 22 cases still pass and both reds are about the mutated behaviour.
 * The fact it records is that writing `toBe(4)` rather than a floor is what
 * buys the second direction, and it is affordable here only because this
 * change owns all four positions; a count over a population other sessions
 * extend should still be a floor.
 *
 * **M5b is the row that is not a measurement, and it is recorded rather than
 * dropped.** Short-circuiting the cut while leaving `gates.yml` alone is
 * 0 of 24 — with the real artifact agreeing with the constants there is no
 * input on which mutant and original differ, so that run is the code
 * executed twice. Only the pair says anything.
 *
 * None of the mutations is left in the tree; all were run and restored from a
 * `cp` backup, and `lib/secret-patterns.ts`, `lib/scaffold/steps.ts`,
 * `.github/workflows/gates.yml` and this file were confirmed byte-identical
 * to the measured source afterwards by SHA-256, never by `git checkout --`.
 *
 * ### What this change does NOT do, said here rather than left as an omission
 *
 * A `${NAME:-value}` whose variable name carries no credential vocabulary is
 * still invisible, and #844 proposed a pattern anchored at `${`…`:-` with a
 * length floor instead of a name. Measured over this repository's tracked
 * files before declining it: that pattern with no vocabulary returns **2**
 * hits, both `${2:-hornjason/pai-config}` positional-parameter defaults and
 * both false positives, and with a credential vocabulary it returns **0** —
 * while `${KEYSTORE_PATH:-/usr/local/share/keystore}` is a false positive
 * anyone can construct, since the value charset carries `/`, `.` and `-`.
 * A gate that fires on a path default is a gate consumers delete, which is
 * the issue's own argument. It is a separate pattern and a separate decision.
 */
describe("#844: the tier-2 scan reads case the way credentials are written", () => {
  test("an UPPERCASE or mixed-case credential name is no longer invisible", () => {
    const scan = gatesTier2Scan();
    for (const nowSeen of [
      `${K.password.toUpperCase()}=supersecretvalue123`,
      `DB_${K.password.toUpperCase()}=p4ssw0rd_longenough`,
      V(K.apiKey.toUpperCase(), "=", "sk_live_abcdefghijklmnop"),
      V(K.secret.toUpperCase(), ": ", "abcdefghijklmnopqr"),
      // Mixed case is the JS/TS spelling, and it was invisible for the same
      // reason the uppercase one was.
      V("api" + "Key", ": ", "sk_live_abcdefghijklmnop"),
    ]) {
      expect(tier2Verdict(scan, nowSeen), `still invisible: ${nowSeen}`).toBe("FAIL");
    }
  });

  test("the shell default from asaCommandCenter #1683 is caught", () => {
    // The shape the issue was filed over, reconstructed with a synthetic
    // value of the same length — the live one is deliberately not reproduced.
    // It is caught through the variable NAME, which carries the vocabulary;
    // a `${NAME:-value}` whose name carries none is still invisible and is
    // the follow-up this issue splits off rather than guesses at.
    const scan = gatesTier2Scan();
    const synthetic = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    expect(synthetic.length, "the synthetic value must be key-length to measure anything").toBe(32);
    const line = `SAPLING_KEY="\${SAPLING_${K.apiKey.toUpperCase()}:-${synthetic}}"`;
    expect(tier2Verdict(scan, line), `the #1683 shape is still invisible: ${line}`).toBe("FAIL");
  });

  test("tier 1 is NOT case-insensitive, and the committed job does not make it so", () => {
    // The other cheap repair: put -i on the whole step. Tier 1 matches
    // anchored key FORMATS whose case is part of the format, and it is the
    // one tier with no allowlist to absorb a false positive.
    const tier1Line = gatesYml.match(/if git grep -I -lE ((?:-[A-Za-z]+ )*)'([^']+)' -- \.; then/);
    expect(tier1Line?.[2] ?? "", "the tier-1 scan line is not in gates.yml — this cut is reading nothing").not.toBe(
      "",
    );
    expect(
      (tier1Line?.[1] ?? "").split(" ").filter(Boolean),
      "tier 1 picked up the tier-2 case flag",
    ).not.toContain(TIER2_GREP_CASE_FLAG);
    // And behaviourally, through the same binary the job runs.
    const lower = spawnSync("grep", ["-qE", tier1Line?.[2] ?? ""], {
      input: "akia" + "a".repeat(16) + "\n",
      encoding: "utf-8",
    });
    expect(lower.status, "a lowercase AWS-key lookalike now matches tier 1").not.toBe(0);
  });

  test("the allowlist reads case the same way the capture does", () => {
    // The widening this change makes deliberately. The population newly
    // visible to the capture is dominated by .env.example, where the
    // conventional spelling of a non-value is uppercase — and the generated
    // job's branch is `exit 1`, not a warning.
    const scan = gatesTier2Scan();
    for (const nonValue of [
      V(K.apiKey.toUpperCase(), "=", "Placeholder_value_here"),
      V(K.password.toUpperCase(), " = ", "PROCESS.ENV.DB_PASSWORD"),
      V(K.secret.toUpperCase(), ": ", "Getenv_SOME_LONG_NAME"),
    ]) {
      expect(tier2Verdict(scan, nonValue), `a non-value hard-fails CI: ${nonValue}`).toBe("CLEAN");
    }
    // The control the widening needs: a real uppercase credential is still
    // caught. Without this, an allowlist that excused everything would read
    // exactly like one tuned to excuse placeholders.
    expect(tier2Verdict(scan, V(K.apiKey.toUpperCase(), "=", "sk_live_abcdefghijklmnop"))).toBe("FAIL");
  });
});

describe("the tier-2 expressions are one binding the generator interpolates (#489)", () => {
  test("steps.ts interpolates the tier-2 pattern rather than inlining a copy", () => {
    // lib/scaffold/steps.ts imported only tier1Ere and then hardcoded its own
    // copy of the tier-2 ERE — two bindings for one string, in the file whose
    // own header docstring says the registry exists to prevent exactly that.
    const inlined = steps.match(/\(password\|passwd\|api\[_-\]\?key\|secret\)/g) || [];
    expect(
      inlined.length,
      "the tier-2 pattern is hardcoded in the generator again — interpolate tier2Ere() from lib/secret-patterns.ts",
    ).toBe(0);
    // Both generated scanners: gates.yml and the consumer pre-commit hook.
    expect((steps.match(/\$\{tier2Ere\(\)\}/g) || []).length).toBe(2);
  });

  test("steps.ts interpolates the tier-2 allowlist rather than inlining a copy", () => {
    const inlinedAllow = steps.match(/process\\\\\.env\|os\\\\\.environ/g) || [];
    expect(
      inlinedAllow.length,
      "the tier-2 allowlist is hardcoded in the generator again — interpolate TIER2_ALLOWED_VALUE_ERE",
    ).toBe(0);
    expect((steps.match(/\$\{TIER2_ALLOWED_VALUE_ERE\}/g) || []).length).toBe(2);
  });

  test("tier2Ere() mirrors tier1Ere() so there is one thing to mutate", () => {
    expect(tier2Ere()).toBe(TIER2_ASSIGNMENT_ERE);
  });

  test("the case flag is interpolated into all four tier-2 greps, not typed four times", () => {
    // The capture and the allowlist, in gates.yml and in the generated
    // pre-commit hook. Four hand-written flags are four things that can
    // disagree about what counts as a secret — which is the defect this
    // registry exists to prevent, arriving as a flag instead of a pattern.
    expect(
      (steps.match(/\$\{TIER2_GREP_CASE_FLAG\}/g) || []).length,
      "a tier-2 grep is deciding case for itself — interpolate TIER2_GREP_CASE_FLAG",
    ).toBe(4);
  });
});

/**
 * #848 — a credential written as a shell default whose variable NAME carries
 * no credential vocabulary.
 *
 * #844 closed the half where the name does carry it: the live instance was a
 * real key in a consumer repository, and it is caught because `API_KEY` is in
 * the tier-2 vocabulary. The half left open is the one tier 2 structurally
 * cannot reach — a variable named for what it holds rather than for what kind
 * of thing it is — and that shape is camouflaged in a way an assignment is
 * not, because every neighbouring line in such a block genuinely is a default.
 *
 * WHY THE DISCRIMINATOR IS ON THE VALUE AND NOT ON THE NAME
 *
 * Putting the vocabulary back into the name is the cheapest wrong fix, named
 * on the issue before this was written: every false positive on every tree
 * disappears, the capture goes quiet, and the tier then catches exactly the
 * population tier 2 already catches. The case below that asserts tier 2 reads
 * CLEAN on the same fixture is what makes that repair go red rather than
 * green, and it is in the same case deliberately.
 *
 * WHY THE FLOOR IS NOT THE DISCRIMINATOR EITHER
 *
 * The runner-up wrong fix is to raise the length floor until the tree goes
 * quiet. Measured on a consumer tree, the false-positive values are 13, 13,
 * 13, 13, 23 and 32 characters and the real one is 32. No floor separates
 * them, so the floor stays at tier 2's 12 and the value CLASS does the work.
 *
 * EVERY FIXTURE IS ASSEMBLED FROM FRAGMENTS, for the reason recorded above
 * the #489 block: a test that proves a scanner works must not be a file that
 * scanner blocks, and tier 3 now scans this file too.
 *
 * ### What was measured before any of this was written
 *
 * Captured, then reported after the exclusion, over tracked files. The
 * command is recorded beside the count because the trees underneath move:
 *
 *   git grep -I -hoE "$CAPTURE" -- . | wc -l
 *   git grep -I -hoE "$CAPTURE" -- . | grep -vE "$ALLOW" | wc -l
 *
 * | tree | tracked files | captured | reported |
 * |---|---|---|---|
 * | hornjason/pai-harness | 1138 | 0 | 0 |
 * | hornjason/asaCommandCenter | 1726 | 10 | 1 |
 * | hornjason/agentgrit | 374 | 0 | 0 |
 * | hornjason/control-plane | 52 | 0 | 0 |
 *
 * Zero false positives over 3,290 tracked files, and the single reported hit
 * is one tier 2 already catches — so on every tree available to measure,
 * this tier adds nothing. That is the honest reading, and it is why the case
 * below that asserts tier 2 reads CLEAN on the constructed fixture is the one
 * doing the work.
 *
 * ### What was broken to prove it
 *
 * 38 tests over this file. Every count predicted before the run in
 * `/tmp/848-battery/predictions.md`; **the baseline row was read first**. All
 * six matched, and in every row the cases that went red were the predicted
 * ones by name.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline | 38 pass, 0 fail | **38 pass, 0 fail** | — |
 * | T1 the genuinely pre-#848 `steps.ts` and `gates.yml` | 12 | **12** | `gates.yml` holds no tier-3 capture line, so the cut reads nothing |
 * | T2 **cheapest wrong fix**: credential vocabulary required in the tier-3 NAME | 4 | **4** | a 32-character value under a variable named for its destination: original FAIL, mutant CLEAN |
 * | T3 the value-class exclusion narrowed to the empty-line alternative | 3 | **3** | a keystore path default: original CLEAN, mutant FAIL |
 * | T4 the name-side rule widened to admit positional parameters | 1 | **1** | a positional default holding a repo slug: original captures nothing, mutant captures it |
 * | T5 the leading-character rule removed from the value | 1 | **1** | a path default carrying digits: original CLEAN, mutant FAIL |
 * | T6a `gatesTier3Scan` short-circuited to return the constants, artifact untouched | 0 | **0** | none — there is none, which is why this row is recorded |
 * | T6b the same short-circuit WITH the artifact's floor perturbed | 1 | **1** | `gates.yml` itself, read directly rather than through the cut |
 *
 * **T1 is 12 and not 14 deliberately.** The registry constants are kept in
 * that row: reverting `lib/secret-patterns.ts` too removes the exports this
 * file imports, and the whole file then aborts at load — 0 of 38 run, which
 * is a loud abort and not a count. The two cases that stay green read only
 * the registry, and they are green for a true reason.
 *
 * **T6a is the row that is not a measurement, and it is recorded rather than
 * dropped.** With the real artifact agreeing with the constants there is no
 * input on which the short-circuited cut and the real one differ, so that run
 * is the code executed twice. Only the pair says anything, and what it says
 * is that one assertion — the direct read of `gatesYml` in the binding case —
 * is the only thing standing between every behavioural case here and a
 * workflow that says something else.
 *
 * **T5 is 1 only because a fixture was added for it.** The prediction for the
 * leading-character rule was 0 against the fixtures as first written: every
 * path in them is letters and separators, which the value-class exclusion
 * declines anyway. A rule no input can distinguish is indistinguishable from
 * dead code, so `DATA_DIR` defaulting to a path carrying digits was added
 * before the battery ran rather than after it came back 0.
 *
 * None of the mutations is left in the tree; all were restored from a `cp`
 * backup, never `git checkout --`, and `lib/secret-patterns.ts`,
 * `lib/scaffold/steps.ts`, `.github/workflows/gates.yml` and this file were
 * confirmed byte-identical to the measured source afterwards by SHA-256.
 */

/** A shell default, never written as a literal anywhere in this file. */
const SHELL_DEFAULT = (name: string, value: string) => "$" + "{" + name + ":" + "-" + value + "}";

/** A tier-3 scan as the committed job spells it: the flags AND the expressions. */
interface Tier3Scan {
  captureFlags: string[];
  ere: string;
  allowFlags: string[];
  allowlist: string;
}

/**
 * The two commands the committed `gates` job runs for tier 3.
 *
 * Cut out of the artifact rather than imported, for the reason
 * `gatesTier2Scan` is: importing the constant asserts the registry is correct
 * and says nothing about the file CI executes. Both cuts are asserted
 * non-empty before anything is measured with them — a cut that failed to find
 * its own line is an empty string, which is indistinguishable from a clean
 * result.
 */
function gatesTier3Scan(): Tier3Scan {
  const capture = gatesYml.match(/tier3=\$\(git grep -I -hoE ((?:-[A-Za-z]+ )*)'([^']+)' -- \.\)/);
  const allow = gatesYml.match(/"\$tier3" \| grep -qvE ((?:-[A-Za-z]+ )*)'([^']+)'/);
  expect(capture?.[2] ?? "", "the tier-3 capture line is not in gates.yml — this cut is reading nothing").not.toBe("");
  expect(allow?.[2] ?? "", "the tier-3 allowlist line is not in gates.yml — this cut is reading nothing").not.toBe("");
  return {
    captureFlags: (capture?.[1] ?? "").split(" ").filter(Boolean),
    ere: capture?.[2] ?? "",
    allowFlags: (allow?.[1] ?? "").split(" ").filter(Boolean),
    allowlist: allow?.[2] ?? "",
  };
}

/** The generated job's tier-3 verdict for a body of text. Mirrors the shell exactly. */
function tier3Verdict(scan: Tier3Scan, text: string): "FAIL" | "CLEAN" {
  const printfInput = grepExtract(scan.captureFlags, scan.ere, text).replace(/\n+$/, "") + "\n";
  const r = spawnSync("grep", ["-qvE", ...scan.allowFlags, scan.allowlist], {
    input: printfInput,
    encoding: "utf-8",
  });
  return r.status === 0 ? "FAIL" : "CLEAN";
}

describe("#848: a credential in a shell default with no vocabulary in its name", () => {
  test("the committed gates.yml and the tier-3 registry are one binding, not two copies", () => {
    const scan = gatesTier3Scan();
    expect(scan.ere).toBe(TIER3_SHELL_DEFAULT_ERE);
    expect(scan.allowlist).toBe(TIER3_ALLOWED_VALUE_ERE);
    // Read the artifact once WITHOUT going through the cut, for the reason
    // the tier-2 case does: a cut short-circuited to return the constants
    // would leave every behavioural case below green over a workflow that
    // says something else — the store answering with what you put in it.
    expect(
      gatesYml,
      "the committed tier-3 capture command is not the one the registry composes",
    ).toContain(`tier3=$(git grep -I -hoE '${TIER3_SHELL_DEFAULT_ERE}' -- .)`);
  });

  test("the shape tier 2 structurally cannot see is caught, and tier 2 is shown not to catch it", () => {
    // The whole point of the tier. Both halves are asserted over ONE fixture:
    // without the tier-2 half, requiring the credential vocabulary back in
    // the tier-3 variable name — the cheapest wrong fix — leaves this green
    // while the tier measures nothing #844 did not already do.
    const value = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    expect(value.length, "the fixture value must be key-length to measure anything").toBe(32);
    const line = `DEPLOY_HOST="${SHELL_DEFAULT("DEPLOY_TARGET", value)}"`;

    expect(
      tier2Verdict(gatesTier2Scan(), line),
      "tier 2 already catches this, so tier 3 is measuring nothing new — check the fixture's variable name",
    ).toBe("CLEAN");
    expect(tier3Verdict(gatesTier3Scan(), line), `still invisible: ${line}`).toBe("FAIL");
  });

  test("a path default reads CLEAN", () => {
    // Letters and separators, no digit. Caught by the value CLASS rather than
    // by a leading-slash special case, so a relative path default is covered
    // by the same rule.
    const scan = gatesTier3Scan();
    for (const path of [
      SHELL_DEFAULT("KEYSTORE_PATH", "/usr/local/share/keystore"),
      SHELL_DEFAULT("SSH_KEY_PATH", "/home/user/.ssh/id_rsa"),
      SHELL_DEFAULT("CACHE_DIR", "var/cache/application"),
      // This one is the only input the leading-character rule can be seen on.
      // It carries a digit AND a letter, so the value-class exclusion lets it
      // through; what declines it is that the value starts with `/`. Without
      // this fixture, deleting the leading-character rule is 0 red and the
      // rule is indistinguishable from dead code.
      SHELL_DEFAULT("DATA_DIR", "/var/lib/app1/cache2"),
    ]) {
      expect(tier3Verdict(scan, path), `a path default hard-fails CI: ${path}`).toBe("CLEAN");
    }
  });

  test("a port default reads CLEAN", () => {
    const scan = gatesTier3Scan();
    for (const port of [
      SHELL_DEFAULT("PORT", "7777"),
      // Long enough to clear the floor, and still only digits.
      SHELL_DEFAULT("TIMEOUT_MS", "123456789012345"),
    ]) {
      expect(tier3Verdict(scan, port), `a port default hard-fails CI: ${port}`).toBe("CLEAN");
    }
  });

  test("every false positive measured on a real consumer tree reads CLEAN", () => {
    // The six captures the exclusion absorbs on hornjason/asaCommandCenter,
    // reconstructed by shape. A gate that fires on these is a gate consumers
    // delete, and the deletion costs the eight tier-1 patterns too.
    const scan = gatesTier3Scan();
    for (const benign of [
      SHELL_DEFAULT("CONTAINER_NAME", "asa-command-center"),
      SHELL_DEFAULT("CONTAINER_BOOT_NAME", "asa-command-center-test"),
      SHELL_DEFAULT("EMPTY_CATCH_SCAN_DIR", "src/services"),
      SHELL_DEFAULT("EMPTY_CATCH_RATCHET", "config/empty-catch-ratchet.json"),
    ]) {
      expect(tier3Verdict(scan, benign), `a consumer's ordinary default hard-fails CI: ${benign}`).toBe("CLEAN");
    }
  });

  test("a positional-parameter default is not a credential declaration", () => {
    // The name-side discriminator, and the only thing that removes this
    // repository's own two false positives: a positional parameter is an
    // argument. The value here carries no digit either, so the case asserts
    // the NAME rule by reading the capture directly rather than the verdict —
    // otherwise the exclusion would hold it up and the rule could be deleted.
    const scan = gatesTier3Scan();
    const positional = "$" + "{2" + ":" + "-" + "hornjason1/pai-config2}";
    expect(
      grepExtract(scan.captureFlags, scan.ere, positional),
      "a positional-parameter default is being captured as a credential declaration",
    ).toBe("");
    // The control: the identical value under a named variable IS captured, so
    // the case above is about the name and not about the value.
    expect(
      grepExtract(scan.captureFlags, scan.ere, SHELL_DEFAULT("REPO_SLUG", "hornjason1/pai-config2")),
      "the control did not capture, so the positional case proves nothing",
    ).not.toBe("");
  });

  test("the floor is a floor: one character below it is invisible, one at it is caught", () => {
    const scan = gatesTier3Scan();
    expect(tier3Verdict(scan, SHELL_DEFAULT("DEPLOY_TARGET", "a1b2c3d4e5f"))).toBe("CLEAN");
    expect(tier3Verdict(scan, SHELL_DEFAULT("DEPLOY_TARGET", "a1b2c3d4e5f6"))).toBe("FAIL");
  });

  test("the wider value charset is load-bearing: a base64 secret carries / and +", () => {
    // The declined narrowing, pinned. Dropping `/` from the value charset was
    // the obvious way to kill relative-path defaults; measured, it captures 8
    // instead of 10 on the consumer and reports the same 1, so it buys
    // nothing and costs this.
    const scan = gatesTier3Scan();
    expect(tier3Verdict(scan, SHELL_DEFAULT("DEPLOY_TARGET", "aB3/dEf+gHi=jKl9mN0"))).toBe("FAIL");
  });

  test("tier 3 carries no case flag, and the committed job does not give it one", () => {
    // Tier 3 has no vocabulary to miss in the wrong case — every class is
    // written for both — so `-i` here would only widen the value class, which
    // is the direction that fails open.
    const scan = gatesTier3Scan();
    expect(scan.captureFlags, "the tier-3 capture picked up a case flag").toEqual([]);
    expect(scan.allowFlags, "the tier-3 allowlist picked up a case flag").toEqual([]);
  });

  test("this repository's own tracked files report nothing, and the scan read something", () => {
    const scan = gatesTier3Scan();
    const tracked = spawnSync("git", ["grep", "-I", "-hoE", ...scan.captureFlags, scan.ere, "--", "."], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if ((tracked.status ?? 2) > 1) throw new Error(`git grep failed (${tracked.status}): ${tracked.stderr}`);
    const reported = (tracked.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .filter(l => spawnSync("grep", ["-qE", scan.allowlist], { input: l + "\n" }).status !== 0);
    expect(reported, "tier 3 reports a finding on this tree — read it before banking anything").toEqual([]);

    // The instrument control. Zero findings over a population of zero is not
    // a reading: if the shape does not occur here at all, an expression that
    // matches nothing would give the same answer. This repository has shell
    // defaults; the tier is declining them, not failing to see them.
    const anyDefault = spawnSync("git", ["grep", "-I", "-hoE", "[$][{][A-Za-z_][A-Za-z0-9_]*:-", "--", "."], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(
      (anyDefault.stdout ?? "").split("\n").filter(Boolean).length,
      "no shell default of any shape was found, so the clean reading above is UNMEASURED",
    ).toBeGreaterThan(10);
  });
});

describe("#848: the tier-3 expressions are one binding the generator interpolates", () => {
  test("steps.ts interpolates tier3Ere() rather than inlining a copy", () => {
    const inlined = steps.match(/\[A-Za-z0-9\/\+=_\.-\]\{11,\}/g) || [];
    expect(
      inlined.length,
      "the tier-3 pattern is hardcoded in the generator — interpolate tier3Ere() from lib/secret-patterns.ts",
    ).toBe(0);
    // Both generated scanners: gates.yml and the consumer pre-commit hook.
    expect((steps.match(/\$\{tier3Ere\(\)\}/g) || []).length).toBe(2);
  });

  test("steps.ts interpolates the tier-3 allowlist rather than inlining a copy", () => {
    const inlinedAllow = steps.match(/:-\[\^0-9\]\*\$/g) || [];
    expect(
      inlinedAllow.length,
      "the tier-3 allowlist is hardcoded in the generator — interpolate TIER3_ALLOWED_VALUE_ERE",
    ).toBe(0);
    expect((steps.match(/\$\{TIER3_ALLOWED_VALUE_ERE\}/g) || []).length).toBe(2);
  });

  test("tier3Ere() mirrors tier1Ere() and tier2Ere() so there is one thing to mutate", () => {
    expect(tier3Ere()).toBe(TIER3_SHELL_DEFAULT_ERE);
  });

  test("both tier-3 expressions are validated for the trip into generated shell", () => {
    // The validator used to inspect only tier 1, then only tiers 1 and 2. A
    // validator with a narrower view than the thing it validates is the
    // defect this registry exists to prevent.
    const src = readFileSync(join(REPO_ROOT, "lib", "secret-patterns.ts"), "utf-8");
    expect(src).toContain("tier3-shell-default");
    expect(src).toContain("tier3-allowlist");
    expect(unshellSafePatterns()).toEqual([]);
  });
});
