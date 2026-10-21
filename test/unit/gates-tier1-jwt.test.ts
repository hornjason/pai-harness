/**
 * #863 — the eyJ tier-1 pattern, and the tier-2 exclusions that make it
 * necessary.
 *
 * WHAT HAPPENED
 *
 * #844 put `-i` on the tier-2 capture, which closed a real gap (an uppercase
 * `<NAME>_API_KEY` shell default holding a live key) and made `apiKey` match
 * `api[_-]?key` for the first time. `apiKey` is the conventional TypeScript
 * spelling, so every consumer passing a key through an object property began
 * hard-failing the gate — the generated job's branch is `exit 1`, not a
 * warning.
 *
 * MEASURED ON TWO CONSUMER TREES, 2026-10-21
 *
 * The harness modules may name no consumer (SC-A1, test/anti.test.ts), so the
 * trees and their positions are recorded here. Both scans ran the capture and
 * allowlist CUT OUT OF THE COMMITTED `gates.yml`, over the same working trees,
 * before and after the change — not predicted from a reading of the registry.
 *
 * hornjason/agentgrit (feat/ai-review-vertex-wif, PR #303): 5 -> 0
 *   bin/commands/eval.ts:31       `apiKey:` config.judge.apiKey      dotted path
 *   bin/commands/upgrade.ts:60    `apiKey:` current.judge.apiKey     dotted path
 *   bin/commands/optimize.ts:268  `apiKey:` config.judge.apiKey      dotted path
 *   src/daemon/daemon.ts:286      `apiKey:` config.judge.apiKey      dotted path
 *   src/daemon/daemon.ts:734      `apiKey:` config.judge.apiKey      dotted path
 *
 * hornjason/asaCommandCenter: 7 -> 1
 *   src/claude-call.ts:101        `apiKey:` env.ANTHROPIC_API_KEY    dotted path
 *   src/lib/sapling-gate.ts:96    `ApiKey =` deps.resolveApiKey      dotted path
 *   test/unit/...secrets:219      `API_KEY:-` your-api-key-goes-here  placeholder
 *   test/unit/...secrets:221      `SECRET:-` example-value-not-real   placeholder
 *   docs/MAC-MINI-DEMO-SETUP:564  `API_KEY=` your_key_here            placeholder
 *   docs/MAC-MINI-DEMO-SETUP:632  `API_KEY=` your_gemini_key_here     placeholder
 *   test/unit/...secrets:187      `API_KEY:-` <32 random chars>       STILL REPORTED
 *
 * This harness's own tree: 1 -> 0 (a docstring example, since rewritten).
 *
 * The one survivor is not a miss and must not be fixed. It is that project's
 * own positive fixture for the #844 shell-default shape, and SC-C requires
 * that shape to stay reported — excusing it is how this change becomes the
 * cheapest way to revert #844. Eleven of the twelve lines were false
 * positives; the twelfth is a test asserting the gate works.
 *
 * Tier 1 with the new registry reports 0 on all three trees. It reported 2 on
 * asaCommandCenter before the signature floor was raised; see the floor case
 * below.
 *
 * WHY THE EXCLUSION IS SAFE, AND WHERE IT IS NOT
 *
 * The tier-2 value charset excludes `"` and `'`, so in a source file tier 2
 * can only ever see an UNQUOTED value — and an unquoted value in source is an
 * expression, not a literal. That is the whole argument for excluding dotted
 * identifier paths: it cannot hide any credential form this pattern can
 * currently see.
 *
 * Except one. A JWT is `<base64url>.<base64url>.<base64url>`, and a signature
 * with no `-` in it is a dotted identifier path by shape. So the exclusion
 * opens exactly one hole, and this file is where it is closed: a JWT is a
 * credential FORMAT, not a shape, so tier 1 owns it — the tier with no
 * allowlist, anchored on `eyJ`, which is base64url for the `{"` every JWT
 * header and payload begins with.
 *
 * That is why the handoff case below is the load-bearing one. Asserting that
 * tier 1 catches a JWT says nothing on its own; asserting that tier 2 lets
 * the same line through and tier 1 catches it is the thing the change is for.
 *
 * WHY THE EXPRESSIONS ARE READ OUT OF `gates.yml` AND NOT IMPORTED
 *
 * The committed workflow is what CI executes. Importing the constants would
 * assert the registry is correct and say nothing about the artifact, which
 * drifts until someone re-scaffolds. Both are read, then compared, so a drift
 * is a named failure rather than an untested half — the same discipline
 * test/unit/secret-patterns.test.ts applies to tier 2.
 *
 * These drive the REAL `grep` binary. POSIX ERE and the JavaScript RegExp
 * dialect disagree about `[[:space:]]` and about what `{10,}` means in a
 * character class context, so a `new RegExp(...)` case would be testing a
 * different language than the one CI runs.
 *
 * WHAT WAS BROKEN TO PROVE THESE CAN FAIL
 *
 * Run and counted rather than asserted, over this file (13 tests) with
 * `test/unit/secret-patterns.test.ts` (24 tests) read beside it as the
 * instrument. Every mutation is applied to `lib/secret-patterns.ts` and
 * `gates.yml` is REGENERATED from it, because a registry mutation that never
 * reaches the artifact is not the regression these cases guard. Every count
 * was predicted before the battery ran, and the baseline row was read first —
 * an instrument that has stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured (this file / sibling) | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline — unmutated | 13 pass, 0 fail | **13 pass 0 fail / 24 pass 0 fail** | — |
 * | M1 the `jwt` entry deleted from the registry | 3 | **3 of 13 / 0 of 24** | an `api_key:` carrying the fixture token — original tier 1 FAIL, mutant CLEAN |
 * | M2 the signature floor widened back to `{10,}` | 1 | **1 of 13 / 0 of 24** | asaCommandCenter's `ux.spec.ts:803` fixture — original CLEAN, mutant FAIL |
 * | M3 **the cheapest wrong fix**: the trailing `$` dropped from `TIER2_DOTTED_PATH_ERE` | 1 | **1 of 13 / 0 of 24** | an `api_key:` whose value is `config.judge` then a dash then `sk_live_abcdefgh` — original FAIL, mutant CLEAN. Spelled out rather than quoted, because the literal is a value this repository's own Gates scan reports, which is the point of it |
 * | M4 `your[_-]` and `example[_-]` removed from the vocabulary | 1 | **1 of 13 / 0 of 24** | `API_KEY=` then `your_key_here` — original CLEAN, mutant FAIL |
 * | M5 the shell-default `-?` removed from the allowlist anchor | 1 | **1 of 13 / 0 of 24** | `API_KEY:-` then `your-api-key-goes-here` — original CLEAN, mutant FAIL |
 * | M6 NEGATIVE CONTROL: the unrelated `openai` pattern narrowed to `{49,}` | 0 here, 1+ there | **0 of 13 / 2 of 24** | `sk-` + 24 characters — nothing in THIS file is about it, and the sibling's "sk- keys shorter than 48 chars" case is |
 *
 * M6 is the row that makes the other five mean something. A battery in which
 * every row is red cannot distinguish cases that witness #863 from cases that
 * go red whenever anything in the registry moves. Its first form narrowed
 * `{20,}` to `{21,}` and measured 0 / 0 — which reads identically to a
 * specific battery and was in fact a mutation with no distinguishing input,
 * because a 24-character key matches `{21,}` too. Re-cut as `{49,}` and
 * confirmed applied by grepping the literal out of BOTH the registry and the
 * regenerated `gates.yml`, it is 0 here and 2 there: the mutant is live, and
 * this file is silent about it on purpose.
 *
 * M1's 3 and not 4: the pre-commit-hook case compares the generated hook to
 * `tier1Ere()`, so it agrees with itself under any registry mutation. It is a
 * drift case between two POSITIONS, not a case about the JWT, and it is
 * counted as neither.
 *
 * None of the mutations is left in the tree; all were run and reverted, and
 * `lib/secret-patterns.ts` and `.github/workflows/gates.yml` were confirmed
 * byte-identical to the measured source afterwards by sha256.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TIER2_ALLOWED_VALUE_ERE,
  TIER2_DOTTED_PATH_ERE,
  TIER2_GREP_CASE_FLAG,
  TIER2_PLACEHOLDER_VOCAB_ERE,
  tier1Ere,
} from "../../lib/secret-patterns";
import { preCommitHookScript } from "../../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const gatesYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "gates.yml"), "utf-8");

/**
 * No literal in this file is a string its own scanners report.
 *
 * `EY` is assembled so the three-segment JWT below never appears contiguously
 * in the source — a literal JWT here would make the repository's own tier-1
 * Gates scan fail on the test that proves the scanner works, which is the
 * self-reference trap `.claude/rules/self-referential-tests.md` is about.
 * `K.` and `V()` are the same device test/unit/secret-patterns.test.ts uses
 * for the tier-2 vocabulary.
 */
const EY = "ey" + "J";
const K = {
  password: "pass" + "word",
  apiKey: "api" + "_key",
  secret: "sec" + "ret",
} as const;
const V = (key: string, sep: string, value: string) => `${key}${sep}${value}`;

/**
 * A JWT whose signature carries no `-` and is 43 characters.
 *
 * Both properties are deliberate and each would make this file green for the
 * wrong reason if dropped.
 *
 * No `-`: base64url admits one, and a signature containing one is NOT a
 * dotted identifier path, so tier 2 would still report the line and the
 * handoff case below would hold for a reason that has nothing to do with
 * tier 1. The hard case is the one that escapes, so the fixture is it.
 *
 * 43 characters: the registry's floor, and the shortest signature any
 * standard JWS algorithm produces (HS256, 32 bytes). A longer fixture would
 * pass over a floor set anywhere below it.
 */
const SIGNATURE = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const JWT = `${EY}hbGciOiJIUzI1NiJ9.${EY}zdWIiOiIxMjM0NSJ9.${SIGNATURE}`;

interface Tier1Scan {
  flags: string[];
  ere: string;
}

interface Tier2Scan {
  captureFlags: string[];
  ere: string;
  allowFlags: string[];
  allowlist: string;
}

/**
 * The tier-1 command the committed `gates` job actually runs.
 *
 * Cut out of the file rather than matched against it: a claim about one line
 * asserted over the whole document is satisfied by a match anywhere in it,
 * and a cut that failed to find its line is an empty string, which is
 * indistinguishable from a clean result. Asserted non-empty before anything
 * is measured with it.
 */
function gatesTier1Scan(): Tier1Scan {
  const m = gatesYml.match(/if git grep -I -lE ((?:-[A-Za-z]+ )*)'([^']+)' -- \.; then/);
  expect(m?.[2] ?? "", "the tier-1 scan line is not in gates.yml — this cut is reading nothing").not.toBe("");
  return { flags: (m?.[1] ?? "").split(" ").filter(Boolean), ere: m?.[2] ?? "" };
}

/** The tier-2 capture and allowlist, as the committed job spells them. */
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

/** `git grep -I -lE` over text, as the generated tier-1 step runs it. */
function tier1Verdict(scan: Tier1Scan, text: string): "FAIL" | "CLEAN" {
  const r = spawnSync("grep", ["-lE", ...scan.flags, scan.ere], { input: text, encoding: "utf-8" });
  if ((r.status ?? 2) > 1) throw new Error(`grep -lE failed (${r.status}): ${r.stderr}`);
  return r.status === 0 ? "FAIL" : "CLEAN";
}

/**
 * The generated job's tier-2 verdict, mirroring the shell exactly: capture
 * with `grep -hoE`, then `printf '%s\n' "$tier2" | grep -qvE '<allowlist>'`.
 * Command substitution strips trailing newlines and printf adds one back, so
 * an empty capture is a single empty line — which `^$` absorbs.
 */
function tier2Verdict(scan: Tier2Scan, text: string): "FAIL" | "CLEAN" {
  const cap = spawnSync("grep", ["-hoE", ...scan.captureFlags, scan.ere], { input: text, encoding: "utf-8" });
  if ((cap.status ?? 2) > 1) throw new Error(`grep -hoE failed (${cap.status}): ${cap.stderr}`);
  const printfInput = (cap.stdout ?? "").replace(/\n+$/, "") + "\n";
  const r = spawnSync("grep", ["-qvE", ...scan.allowFlags, scan.allowlist], {
    input: printfInput,
    encoding: "utf-8",
  });
  return r.status === 0 ? "FAIL" : "CLEAN";
}

describe("SC-D/#863: tier 1 owns the JWT, and the committed job is where that is true", () => {
  test("the committed tier-1 scan and the registry are one binding, not two copies", () => {
    // If these drift, every behavioural case below measures the artifact
    // while the generator ships something else.
    const scan = gatesTier1Scan();
    expect(scan.ere).toBe(tier1Ere());
    // Read the artifact once WITHOUT going through the cut. Every other case
    // reaches gates.yml through `gatesTier1Scan`, so a cut short-circuited to
    // return the constant would leave all of them green over a workflow that
    // says something else — the store answering with what you put in it
    // (#530). This line is the one that cannot.
    expect(gatesYml, "the committed tier-1 command is not the one the registry composes").toContain(
      `if git grep -I -lE '${tier1Ere()}' -- .; then`,
    );
  });

  test("a JWT assigned unquoted is reported by tier 1", () => {
    const scan = gatesTier1Scan();
    for (const line of [
      V(K.apiKey, ": ", JWT),
      V(K.apiKey.toUpperCase(), "=", JWT),
      `Authorization: Bearer ${JWT}`,
      `JWT${"_TOKEN"}=${JWT}`,
    ]) {
      expect(tier1Verdict(scan, line), `a JWT went unreported by tier 1: ${line}`).toBe("FAIL");
    }
  });

  test("the handoff: tier 2 cannot see a JWT that carries no tier-2 key, and tier 1 can", () => {
    // THE case, and it is narrower than the one this file first shipped.
    //
    // The original claim was that tier 2 EXCUSES a keyed JWT — a signature
    // with no `-` is a dotted identifier path by shape, so the dotted-path
    // exclusion swallowed it. That is no longer true: #868 closed the
    // exclusion to a fixed vocabulary of expression roots, and `eyJhbGci…`
    // is not one of them, so a keyed JWT is now reported by BOTH tiers. The
    // assertion below is asserted rather than the old one, because an
    // excuse that has been closed is not evidence for anything.
    //
    // What still makes tier 1 the owner is the input tier 2 cannot reach at
    // all: tier 2's capture REQUIRES `password|passwd|api[_-]?key|secret` on
    // the line. A bearer header and a bare token name carry none of those,
    // so no hardening of tier 2's allowlist could ever report them — the
    // format needs a tier that matches on the format alone.
    const keyless = `Authorization: Bearer ${JWT}`;
    expect(
      tier2Verdict(gatesTier2Scan(), keyless),
      "tier 2 grew a key-free capture — re-read why tier 1 owns the format",
    ).toBe("CLEAN");
    expect(tier1Verdict(gatesTier1Scan(), keyless), "the JWT is reported by neither tier").toBe("FAIL");

    // The negative control for the sentence above: with a tier-2 key on the
    // line, BOTH tiers report it now. Without this, "tier 2 is clean" reads
    // as tier 2 still excusing JWTs rather than as tier 2 not being asked.
    const keyed = V(K.apiKey, ": ", JWT);
    expect(tier2Verdict(gatesTier2Scan(), keyed), "the #868 root vocabulary stopped excusing a keyed JWT").toBe("FAIL");
    expect(tier1Verdict(gatesTier1Scan(), keyed), "tier 1 stopped reporting a keyed JWT").toBe("FAIL");
  });

  test("tier 1 is NOT case-insensitive, read off the committed command and then behaviourally", () => {
    // The cheap repair for #863 that must not be taken: put `-i` on the whole
    // step. Tier 1 matches anchored key FORMATS whose case is part of the
    // format, and it is the one tier with no allowlist to absorb a false
    // positive. `eyJ` is base64url for `{"` — uppercase it and it is not a
    // JWT header, it is four letters.
    const scan = gatesTier1Scan();
    expect(scan.flags, "tier 1 picked up the tier-2 case flag").not.toContain(TIER2_GREP_CASE_FLAG);
    expect(tier1Verdict(scan, JWT.toUpperCase()), "an uppercase JWT lookalike now matches tier 1").toBe("CLEAN");
  });

  test("the false-positive side: tier 1 does not fire on the lines #863 was filed over", () => {
    // A scanner nobody can commit through gets deleted, and deleting it costs
    // the #844 fix too. These are real lines from the two consumer trees.
    const scan = gatesTier1Scan();
    for (const benign of [
      V(K.apiKey.replace("_", ""), ": ", "config.judge.apiKey"),
      V(K.apiKey.replace("_", ""), ": ", "env.ANTHROPIC_API_KEY"),
      V(K.password, ": ", "opts.db.password"),
      "import { decode } from 'jsonwebtoken'",
      "see docs/jwt-notes.md",
      // A two-segment dotted value is not a JWT and must not be read as one.
      `${EY}hbGciOiJIUzI1NiJ9.${EY}zdWIiOiIxMjM0NSJ9`,
    ]) {
      expect(tier1Verdict(scan, benign), `tier 1 false positive on: ${benign}`).toBe("CLEAN");
    }
  });

  test("the signature floor: a JWT-shaped fixture with a worded signature is not reported", () => {
    // Both lines are hornjason/asaCommandCenter's, verbatim from
    // test/regression/ux.spec.ts, and both were reported by a {10,}
    // signature. Tier 1 has no allowlist, so a consumer's Gates job would
    // have moved from red on two property references to red on two test
    // fixtures — #863 reintroduced by its own fix, in the tier that cannot
    // absorb it.
    //
    // The floor is a FORMAT fact and not a number tuned to these two: the
    // shortest signature any standard JWS algorithm emits is HS256's 43
    // base64url characters, so nothing signed is given up. The control
    // beneath proves the floor is not simply "never match": one character
    // more than these fixtures carry, and the same line is reported.
    const scan = gatesTier1Scan();
    const headAndPayload = `${EY}hbGciOiJSUzI1NiJ9.${EY}zdWIiOiJ0ZXN0In0`;
    for (const [label, sig] of [
      ["hornjason/asaCommandCenter test/regression/ux.spec.ts:803", "signature" + "_placeholder"],
      ["hornjason/asaCommandCenter test/regression/ux.spec.ts:815", "signature" + "_for_status_check"],
    ] as const) {
      expect(sig.length, `${label}: the fixture signature must sit below the floor`).toBeLessThan(43);
      expect(
        tier1Verdict(scan, `const fakeToken = '${headAndPayload}.${sig}'`),
        `${label}: a quoted test fixture is reported as a credential`,
      ).toBe("CLEAN");
    }
    // The control. Without it, a floor of infinity reads exactly like a
    // floor of 43 — every case above would stay green over a pattern that
    // can no longer report any JWT at all.
    expect(SIGNATURE.length, "the live fixture must sit exactly ON the floor").toBe(43);
    expect(
      tier1Verdict(scan, `const realToken = '${headAndPayload}.${SIGNATURE}'`),
      "the floor is not a floor — a 43-character signature is unreported too",
    ).toBe("FAIL");
  });

  test("SC-D's second position: the generated pre-commit hook carries the pattern too", () => {
    // `tier1Ere()` reaches gates.yml AND the hook rungate installs into every
    // consumer. Updating the workflow and not the hook is the drift the
    // registry exists to prevent, and it is the position a reader forgets.
    // Asserted on the PRODUCED text, not on the generator source: a
    // `${tier1Ere()}` in steps.ts is a promise, and the hook body is the
    // thing a consumer runs.
    const hook = preCommitHookScript(REPO_ROOT);
    expect(hook, "the generated pre-commit hook does not carry the tier-1 registry").toContain(tier1Ere());
    expect(hook, "the generated pre-commit hook does not carry the tier-2 allowlist").toContain(
      TIER2_ALLOWED_VALUE_ERE,
    );
  });
});

describe("SC-A/SC-B/SC-C/SC-I/#863: what the tier-2 exclusion does and does not excuse", () => {
  test("SC-A: a dotted identifier path as an unquoted value is CLEAN", () => {
    const scan = gatesTier2Scan();
    // The first three are agentgrit's reported lines, the last two
    // asaCommandCenter's. Reproduced as the trees spell them.
    for (const dotted of [
      V(K.apiKey.replace("_", ""), ": ", "config.judge.apiKey"),
      V(K.apiKey.replace("_", ""), ": ", "current.judge.apiKey"),
      V(K.password, ": ", "opts.db.password"),
      V(K.apiKey.replace("_", ""), ": ", "env.ANTHROPIC_API_KEY"),
      V("Api" + "Key", " = ", "deps.resolveApiKey"),
    ]) {
      expect(tier2Verdict(scan, dotted), `a property reference still hard-fails CI: ${dotted}`).toBe("CLEAN");
    }
  });

  test("the cheapest wrong fix: a value that merely BEGINS with a path is still reported", () => {
    // Named before the repair exists, per
    // .claude/rules/checks-must-be-able-to-fail.md's fifth shape. The 5pm
    // repair for "my value is still reported" is to drop the `$` from
    // `TIER2_DOTTED_PATH_ERE` — one character, every reported line goes
    // quiet, and the exclusion becomes "starts with something dotted",
    // which a real credential can be made to do.
    //
    // Every other case in this describe is GREEN under that repair: none of
    // their values contains a dot followed by a non-identifier character,
    // so the left anchor alone decides them. This is the one that is not,
    // which is why it is its own case and not another row in SC-B.
    const scan = gatesTier2Scan();
    expect(tier2Verdict(scan, V(K.apiKey, ": ", "config.judge-sk_live_abcdefgh"))).toBe("FAIL");
  });

  test("SC-B: an unquoted literal with no dotted shape is still reported", () => {
    // The exclusion is a DOTTED-PATH exclusion, not an "anything unquoted"
    // exclusion. Without this case, excusing every unquoted value would read
    // exactly like excusing property references.
    const scan = gatesTier2Scan();
    expect(tier2Verdict(scan, V(K.apiKey.toUpperCase(), "=", "sk-live" + "x".repeat(18)))).toBe("FAIL");
    expect(tier2Verdict(scan, V(K.secret, ": ", "abcdefghijklmnopqr"))).toBe("FAIL");
  });

  test("SC-C: the #844 shell default is still reported after the narrowing", () => {
    // This change must not be the cheapest way to revert #844. The shape is
    // the one a real key sat in on a consumer's default branch; the value is
    // synthetic and the same length.
    const scan = gatesTier2Scan();
    const synthetic = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    expect(synthetic.length, "the synthetic value must be key-length to measure anything").toBe(32);
    const line = `SAPLING_KEY="\${SAPLING_${K.apiKey.toUpperCase()}:-${synthetic}}"`;
    expect(tier2Verdict(scan, line), `the shell-default shape went quiet: ${line}`).toBe("FAIL");
  });

  test("SC-I: a FIXED placeholder vocabulary is excused, and it is a named constant", () => {
    // What makes a named placeholder safely excludable and SC-B's fixture not
    // is that this is a vocabulary, not a judgement that a value looks
    // harmless. The four spellings are asaCommandCenter's, verbatim.
    const scan = gatesTier2Scan();
    for (const placeholder of [
      `${K.apiKey.toUpperCase()}:-your-api-key-goes-here`,
      `${K.apiKey.toUpperCase()}=your_key_here`,
      `${K.apiKey.toUpperCase()}=your_gemini_key_here`,
      `${K.secret.toUpperCase()}:-example-value-not-real`,
    ]) {
      expect(tier2Verdict(scan, placeholder), `a documented placeholder hard-fails CI: ${placeholder}`).toBe("CLEAN");
    }
    // One constant, not four literals spliced into the composed expression —
    // the argument the registry's own header makes about the case flag. A
    // second spelling of the vocabulary is a second thing that can disagree
    // about what counts as a secret.
    expect(TIER2_PLACEHOLDER_VOCAB_ERE.length, "the placeholder vocabulary is empty").toBeGreaterThan(0);
    expect(TIER2_ALLOWED_VALUE_ERE, "the allowlist spells the vocabulary itself instead of composing it").toContain(
      TIER2_PLACEHOLDER_VOCAB_ERE,
    );
    expect(TIER2_ALLOWED_VALUE_ERE, "the allowlist spells the dotted-path shape itself instead of composing it").toContain(
      TIER2_DOTTED_PATH_ERE,
    );
  });

  test("the committed allowlist is the one the registry composes", () => {
    const scan = gatesTier2Scan();
    expect(scan.allowlist).toBe(TIER2_ALLOWED_VALUE_ERE);
    expect(scan.allowFlags, "the committed allowlist dropped the registry's case flag").toContain(
      TIER2_GREP_CASE_FLAG,
    );
    expect(scan.captureFlags, "the committed capture dropped the registry's case flag").toContain(
      TIER2_GREP_CASE_FLAG,
    );
  });
});

describe("#868: the three ways into the exclusion that the first draft left open", () => {
  // The security review of PR #868 found all three, and every one of them is
  // the SAME mistake: the first draft's justification was a fact about SOURCE
  // LANGUAGES — "an unquoted dotted value is an expression, and an expression
  // is not a credential" — applied to a corpus that is `git grep -- .`, which
  // reaches dotenv files, shell scripts and YAML. In those, an unquoted
  // dotted value is a LITERAL.
  //
  // Each case asserts the bypass is REPORTED and is paired, in the next
  // describe-level case, with the measured consumer line it must not break.
  // Without the pair, "report everything" scores as the fix.

  test("a credential whose SHAPE is a dotted identifier path is reported", () => {
    // SendGrid issues `SG.<base62>.<base62>`. Unquoted in a `.env`, the first
    // draft read it as an expression rooted at `SG` and excused it. The root
    // is a closed vocabulary now, and `SG` is not in it.
    const scan = gatesTier2Scan();
    for (const line of [
      "SENDGRID_API_KEY=SG.ePqRsTuVwXyZ01.aBcDeFgHiJkLmNoPqRsTuV",
      "API_KEY=AKIA.IOSFODNN7.EXAMPLEKEYVAL",
    ]) {
      expect(tier2Verdict(scan, line), `a dotted-path-shaped credential is still excused: ${line}`).toBe("FAIL");
    }
  });

  test("an internal `=` cannot start a match the allowlist then excuses", () => {
    // The allowlist branches were unanchored, so `[:=][[:space:]]*` could
    // bind to an `=` INSIDE the value — base64 padding, or a separator — and
    // excuse the whole line on the fragment after it. Every branch is
    // anchored to the key now.
    const scan = gatesTier2Scan();
    for (const line of [
      V(K.password, ": ", "hunter2hunter2hunter2=a.b"),
      V(K.apiKey, ": ", "sk_live_AbCdEfGhIjKlMnOp=cfg.key"),
    ]) {
      expect(tier2Verdict(scan, line), `an internal = still launders the value: ${line}`).toBe("FAIL");
    }
  });

  test("a placeholder PREFIX does not excuse a random tail", () => {
    // `your[_-]` matched as a prefix with no end anchor, so any secret
    // beginning `your_` was excused. The tail must now run to end-of-value
    // carrying no digit — which is what a placeholder looks like and what a
    // generated credential does not.
    const scan = gatesTier2Scan();
    expect(
      tier2Verdict(scan, "API_KEY=your_QX7bTk19ZpLmNvRs04WyEdHgUaFc"),
      "a placeholder prefix still excuses a random tail",
    ).toBe("FAIL");
  });

  test("the control: every placeholder and expression the hardening must NOT break", () => {
    // The negative control for all three cases above. These are the measured
    // consumer lines from #863 plus the two placeholder spellings the #844
    // suite already pinned; without them, anchoring the allowlist to nothing
    // at all would satisfy every assertion in this describe.
    const scan = gatesTier2Scan();
    for (const benign of [
      V(K.apiKey.replace("_", ""), ": ", "config.judge.apiKey"),
      V(K.apiKey.replace("_", ""), ": ", "env.ANTHROPIC_API_KEY"),
      V(K.password, ": ", "process.env.DB_PASSWORD"),
      "API_KEY:-your-api-key-goes-here",
      "SECRET:-example-value-not-real",
      "API_KEY=your_key_here",
      V(K.apiKey.toUpperCase(), "=", "Placeholder_value_here"),
    ]) {
      expect(tier2Verdict(scan, benign), `the hardening broke a benign line: ${benign}`).toBe("CLEAN");
    }
  });
});
