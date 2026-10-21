/**
 * The ai-review deny list denies things that exist (#885).
 *
 * The CLI validates every `--allowedTools` / `--disallowedTools` entry at
 * startup, warns on a name it cannot resolve, and carries on:
 *
 *     Permission deny rule "SlashCommand" matches no known tool — check for typos.
 *     Permission deny rule "MultiEdit" matches no known tool — check for typos.
 *
 * So eleven entries read as eleven denials and two of them were inert. The
 * cost is a reading problem rather than a security one — neither is a live
 * hole — but it is this repo's recurring shape pointed at a config list: a
 * rule that matches no known tool is indistinguishable from a rule that is
 * holding. It also means a tool RENAMED upstream silently turns its denial
 * off, with no trace but a log line nobody greps.
 *
 * ## What is enforced where
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` says to split a population by
 * what the repo can see, enforce the half it owns, and make the other half
 * report UNMEASURED on every run.
 *
 * - **Owned, and enforced everywhere:** every emitted rule agrees with the
 *   recorded vocabulary in `lib/claude-tool-vocabulary.ts`. Deterministic, no
 *   external tool, red the moment somebody adds an unverified name.
 * - **Not owned:** whether that record is still true of the CLI on THIS
 *   machine. `probePermissionRules` answers it when `claude` is on PATH and
 *   returns `UNMEASURED` when it is not — never an empty `unknown` list, which
 *   is what a passing probe looks like.
 *
 * ## The negative controls, and why there are two kinds
 *
 * "Every name is known" passes over an empty list, and a control made of a
 * synthetic typo proves only that the comparison runs. So there are two:
 *
 * - a **synthetic** bogus name, which `unknownAgainstRecord` must report, and
 * - the **real** retained entries, which the record must report as unknown.
 *   Those are readings rather than inventions, and they go red if
 *   `SlashCommand` ever becomes a tool again — at which point it moves out of
 *   `inert` and starts denying something.
 *
 * ## The cheapest wrong fix, named
 *
 * **Add the two names to the vocabulary's known set** so the comparison goes
 * green. One line, the symptom disappears, and the record now asserts the
 * opposite of what was measured. AC-4 survives it non-vacuously: it asserts
 * the two are in `VERIFIED_UNKNOWN_TOOLS` and that the two sets are disjoint,
 * so the repair turns it red rather than green.
 *
 * The second-cheapest: **delete both entries from the list.** It also works,
 * and it was one of the issue's own options — but it loses #732's history and
 * changes the emitted workflow on a CLI version this repo has not measured
 * (the record is `2.1.306`; CI runs `2.1.303`). The entries are kept with
 * reasons instead, and AC-5 is what stops a reason being dropped to a bare
 * flag.
 */
import { describe, expect, test } from "bun:test";

import {
  AI_REVIEW_ALLOWED_TOOLS,
  AI_REVIEW_DENY_RULES,
  AI_REVIEW_DISALLOWED_TOOLS,
  AI_REVIEW_WORKSPACE_WRITE_DENY,
} from "../lib/scaffold/ai-review-step";
import {
  CLAUDE_TOOL_VOCABULARY_COMMAND,
  CLAUDE_TOOL_VOCABULARY_VERSION,
  VERIFIED_KNOWN_TOOLS,
  VERIFIED_UNKNOWN_TOOLS,
  parseUnknownRuleWarnings,
  probePermissionRules,
  ruleToolName,
  unknownAgainstRecord,
} from "../lib/claude-tool-vocabulary";

/** Exactly what `aiReviewClaudeArgs` hands the CLI, split back into rules. */
const EMITTED_DENY = `${AI_REVIEW_DISALLOWED_TOOLS},${AI_REVIEW_WORKSPACE_WRITE_DENY}`.split(",");
const EMITTED_ALLOW = AI_REVIEW_ALLOWED_TOOLS.split(",");

describe("#885: the deny list denies things that exist", () => {
  test("AC-1: every ALLOWED rule names a tool the record vouches for", () => {
    expect(EMITTED_ALLOW.length, "the allow list is empty, so this passes vacuously")
      .toBeGreaterThan(0);
    expect(unknownAgainstRecord(EMITTED_ALLOW)).toEqual([]);
  });

  test("AC-2: every DENY rule either names a known tool or declares itself inert", () => {
    // The whole claim, in one line: a rule is allowed to match nothing only if
    // the declaration says so and says why.
    const inert = new Set(AI_REVIEW_DENY_RULES.filter(r => r.inert).map(r => r.rule));
    const undeclared = unknownAgainstRecord(EMITTED_DENY).filter(n => !inert.has(n));
    expect(
      undeclared,
      "a rule matching no known tool is indistinguishable from one that is holding — " +
        `verify it with: ${CLAUDE_TOOL_VOCABULARY_COMMAND}, then add it to ` +
        "VERIFIED_KNOWN_TOOLS, or mark it inert in AI_REVIEW_DENY_RULES with a reason",
    ).toEqual([]);
  });

  test("AC-3: the comparison is not vacuous — the emitted lists are real and the record is bigger", () => {
    // A record built only from the names we emit would be the question
    // restated (#530). 35 candidates were probed; these are what came back.
    expect(EMITTED_DENY.length).toBe(12);
    expect(VERIFIED_KNOWN_TOOLS.size).toBeGreaterThan(EMITTED_DENY.length);
    expect(CLAUDE_TOOL_VOCABULARY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("AC-4: the negative controls — a synthetic typo and the two real inert entries", () => {
    // Synthetic: proves the comparison can report something.
    expect(unknownAgainstRecord(["Read", "Zorplebeast", "Grep"])).toEqual(["Zorplebeast"]);

    // Real: the readings the issue is about. This is the half that goes red if
    // SlashCommand ever becomes a tool again, which is the moment it should
    // stop being marked inert.
    expect(VERIFIED_UNKNOWN_TOOLS.has("SlashCommand")).toBe(true);
    expect(VERIFIED_UNKNOWN_TOOLS.has("MultiEdit")).toBe(true);
    for (const name of VERIFIED_UNKNOWN_TOOLS) {
      expect(VERIFIED_KNOWN_TOOLS.has(name), `${name} is recorded as both known and unknown`)
        .toBe(false);
    }
  });

  test("AC-5: every inert entry carries a reason, and every inert name is really inert", () => {
    const inert = AI_REVIEW_DENY_RULES.filter(r => r.inert);
    expect(inert.map(r => r.rule)).toEqual(["SlashCommand", "MultiEdit"]);
    for (const r of inert) {
      expect(r.inert!.length, `${r.rule} is marked inert with no usable reason`)
        .toBeGreaterThan(20);
      // A name marked inert that the record says IS known is a stale comment
      // claiming a denial does nothing while it does something.
      expect(VERIFIED_KNOWN_TOOLS.has(r.rule), `${r.rule} is marked inert but the record knows it`)
        .toBe(false);
    }
  });

  test("AC-6: a path-scoped rule is checked by its TOOL name", () => {
    // `Edit(./**)` is a rule about `Edit`. Comparing the whole rule text to
    // the vocabulary would report every path-scoped rule as unknown — a
    // detector narrower than what it detects, arriving as false positives.
    expect(ruleToolName("Edit(./**)")).toBe("Edit");
    expect(ruleToolName("Read")).toBe("Read");
    expect(EMITTED_DENY).toContain(AI_REVIEW_WORKSPACE_WRITE_DENY);
    expect(unknownAgainstRecord([AI_REVIEW_WORKSPACE_WRITE_DENY])).toEqual([]);
  });

  test("AC-7: the warning parser reads the CLI's sentence, including an allow rule", () => {
    const sample =
      `Permission deny rule "SlashCommand" matches no known tool — check for typos.\n` +
      `Permission deny rule "MultiEdit" matches no known tool — check for typos.\n` +
      `Permission allow rule "Nope" matches no known tool — check for typos.\n` +
      `Error: Input must be provided either through stdin or as a prompt argument\n`;
    expect(parseUnknownRuleWarnings(sample)).toEqual(["SlashCommand", "MultiEdit", "Nope"]);
    expect(parseUnknownRuleWarnings("no warnings here")).toEqual([]);
  });
});

describe("#885: the half this repo does not own", () => {
  /**
   * The live re-take of the record. OPT-IN, and the opt-in is the honest part.
   *
   * Measured 2026-10-21: one run costs **21.7 seconds** — CLI startup, not the
   * validation, and no network call. bun's per-test budget is 5s and #804 is
   * open about a check already sitting 1.5s from it, so putting this in every
   * run buys a slow nondeterministic dependency on a tool whose installation
   * state moves (`.claude/rules/checks-must-be-able-to-fail.md`, #637).
   *
   * So the enforcement is the static comparison above, which runs everywhere,
   * and this is the command that re-takes the record. It reports UNMEASURED by
   * name when it does not run — the one thing it must not do is pass quietly,
   * because an empty `unknown` list is exactly what success looks like.
   *
   * It asserts AGREEMENT with the record rather than a fixed answer, so it
   * stays meaningful across CLI versions: a version that knows `SlashCommand`
   * turns it red, and that is the signal to move the entry out of `inert`.
   *
   *     RUNGATE_PROBE_CLAUDE_VOCABULARY=1 bun test test/ai-review-deny-vocabulary.test.ts
   */
  test(
    "AC-8: the installed CLI agrees with the record, or the reading says it did not run",
    () => {
      if (process.env.RUNGATE_PROBE_CLAUDE_VOCABULARY !== "1") {
        console.error(
          `UNMEASURED — the recorded tool vocabulary (claude ${CLAUDE_TOOL_VOCABULARY_VERSION}) ` +
            `was not re-taken on this run. Set RUNGATE_PROBE_CLAUDE_VOCABULARY=1 to re-take it, ` +
            `or by hand: ${CLAUDE_TOOL_VOCABULARY_COMMAND}`,
        );
        return;
      }
      const got = probePermissionRules([...VERIFIED_UNKNOWN_TOOLS, ...EMITTED_DENY], {
        timeoutMs: 120_000,
      });
      expect(got.reading, `the probe did not run: ${got.probe.reason}`).toBe("MEASURED");
      expect([...got.unknown].sort()).toEqual([...VERIFIED_UNKNOWN_TOOLS].sort());
    },
    150_000,
  );

  test("AC-9: with no CLI, the probe reads UNMEASURED and reports nothing", () => {
    // The branch AC-8 takes in CI, witnessed deterministically. Without this
    // the UNMEASURED path is a line of code nothing has ever executed — and
    // an UNMEASURED reading that silently carried findings, or a MEASURED one
    // that carried none, would read identically to a clean probe.
    const got = probePermissionRules(["Read", "Zorplebeast"], {
      command: "claude-does-not-exist-rungate-885",
      timeoutMs: 5_000,
    });
    expect(got.reading).toBe("UNMEASURED");
    expect(got.unknown).toEqual([]);
    expect(got.probe.available).toBe(false);
    expect(got.probe.reason.length).toBeGreaterThan(0);
  });
});
