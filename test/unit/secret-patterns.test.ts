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
  tier1Ere,
  tier2Ere,
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
      const key = p.ere.split(/[[(\\]/)[0];
      if (key.length < 4) continue; // too generic to grep for meaningfully
      expect(repoPreCommit, `scripts/git-hooks/pre-commit no longer covers ${p.id}`).toContain(key);
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

/** `grep -hoE <ere>` over text, exactly as the generated job extracts. */
function grepExtract(ere: string, text: string): string {
  const r = spawnSync("grep", ["-hoE", ere], { input: text, encoding: "utf-8" });
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
 */
function tier2Verdict(ere: string, allowlist: string, text: string): "FAIL" | "CLEAN" {
  const printfInput = grepExtract(ere, text).replace(/\n+$/, "") + "\n";
  const r = spawnSync("grep", ["-qvE", allowlist], { input: printfInput, encoding: "utf-8" });
  return r.status === 0 ? "FAIL" : "CLEAN";
}

/**
 * The two expressions the committed `gates` job actually runs.
 *
 * Cut out of the file rather than matched against it: a claim about one line
 * asserted over the whole document is satisfied by a match anywhere in it,
 * and a cut that failed to find its own line is an empty string, which is
 * indistinguishable from a clean result. Both are therefore asserted
 * non-empty before anything is measured with them.
 */
function gatesTier2Scan(): { ere: string; allowlist: string } {
  const ere = gatesYml.match(/tier2=\$\(git grep -I -hoE '([^']+)' -- \.\)/)?.[1] ?? "";
  const allowlist = gatesYml.match(/grep -qvE '([^']+)'/)?.[1] ?? "";
  expect(ere, "the tier-2 capture line is not in gates.yml — this cut is reading nothing").not.toBe("");
  expect(allowlist, "the tier-2 allowlist line is not in gates.yml — this cut is reading nothing").not.toBe("");
  return { ere, allowlist };
}

describe("the tier-2 scan does not read a minified comparison as an assignment (#489)", () => {
  test("the committed gates.yml and the registry are one binding, not two copies", () => {
    // If these drift, every behavioural case below is measuring the artifact
    // while the generator ships something else.
    const { ere, allowlist } = gatesTier2Scan();
    expect(ere).toBe(TIER2_ASSIGNMENT_ERE);
    expect(allowlist).toBe(TIER2_ALLOWED_VALUE_ERE);
  });

  test("a minified === comparison of two credential fields does not fail the scan", () => {
    const { ere, allowlist } = gatesTier2Scan();
    for (const minified of [
      `if(e.${K.password}===t.${K.password}){return 1}`,
      `if(a.${K.apiKey}===b.${K.apiKey}){return 0}`,
      `function f(x,y){return x.${K.secret}===y.${K.secret}}`,
      `const ok=u.${K.passwd}===v.${K.passwd}&&u.id===v.id`,
    ]) {
      expect(tier2Verdict(ere, allowlist, minified), `false positive on: ${minified}`).toBe("CLEAN");
    }
  });

  test("the control: a credential assignment this scan can see still fails it", () => {
    // The control set is deliberately narrow, and the narrowness is MEASURED,
    // not assumed — see the blind-spot case below. Of six ordinary ways to
    // write a credential, only an unquoted lowercase key with a colon or an
    // equals is visible to this pattern at all. A control drawn from outside
    // that set would be green whether or not the narrowing is correct, which
    // is a control that certifies nothing.
    const { ere, allowlist } = gatesTier2Scan();
    for (const real of [
      V(K.apiKey, ": ", "sk_live_abcdefghijklmnop"),
      V(K.password, "=", "hunter2hunter2hunter2"),
      V(K.secret, ": ", "abcdefghijklmnopqr"),
    ]) {
      expect(tier2Verdict(ere, allowlist, real), `a real assignment stopped failing: ${real}`).toBe("FAIL");
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
    const { ere, allowlist } = gatesTier2Scan();
    expect(tier2Verdict(ere, allowlist, V(K.apiKey, ": ", "AB==CDEFGHIJ"))).toBe("FAIL");
  });

  test("the allowlist still launders nothing it did not before", () => {
    const { ere, allowlist } = gatesTier2Scan();
    expect(tier2Verdict(ere, allowlist, V(K.password, " = ", "process.env.DB_PASSWORD"))).toBe("CLEAN");
    // The escape the allowlist position was moved to fix: a trailing comment
    // must not launder a real value.
    expect(
      tier2Verdict(ere, allowlist, V(K.apiKey, ": ", "sk_live_abcdefghijklmnop # placeholder")),
    ).toBe("FAIL");
  });

  test("the known blind spot is pinned: widening the value charset is a SEPARATE issue", () => {
    // Measured, not inferred: the value charset excludes `"` and `'`, so every
    // quoted literal — the normal way a credential is written in TS, JS,
    // Python and JSON — stops the match at the opening quote; and the scan
    // runs without -i, so PASSWORD and DB_PASSWORD are invisible.
    //
    // Both are real gaps and NEITHER is #489. They are pinned here so a fix
    // author who notices them cannot widen the charset in the same change:
    // conflating a widening with this narrowing makes the narrowing
    // unmeasurable, because the minified fixtures above would then match for
    // a new reason. Widening this is a separate issue and turns this case
    // red, which is the point.
    const { ere, allowlist } = gatesTier2Scan();
    for (const invisible of [
      `const ${K.apiKey} = "sk_live_abcdefghijklmnop"`,
      `${K.password} = 'hunter2hunter2hunter2'`,
      `${K.password.toUpperCase()}=supersecretvalue123`,
      `DB_${K.password.toUpperCase()}=p4ssw0rd_longenough`,
    ]) {
      expect(tier2Verdict(ere, allowlist, invisible), `charset/case blind spot closed: ${invisible}`).toBe("CLEAN");
    }
    // Secondary, and secondary on purpose: the four rows above are the pin.
    // A double quote in the value charset would also break the generated
    // single-quoted shell, which `unshellSafePatterns()` does not currently
    // treat as disqualifying.
    expect(ere, "a double quote in the tier-2 ERE breaks single-quoted generated shell").not.toContain('"');
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
});
