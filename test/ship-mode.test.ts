/**
 * #911 — `ship.mode` is a declared project fact, and the generated rule says so.
 *
 * `.claude/rules/ship-workflow.md` hard-coded *"All implementation work must
 * go through the ship workflow"*. A project that has decided to bypass the
 * harness therefore shipped every agent into a standing rule conflict, and a
 * swarm agent working agentgrit #314/#315 closed its report unable to tell
 * whether the bypass it had been instructed to perform was legitimate.
 *
 * ## The control that makes the rest mean anything
 *
 * *"Absent `ship` block changes nothing"* is the claim every existing
 * consumer depends on, and `expect(a).toEqual(b)` over two strings this file
 * wrote would be satisfied by two empty strings. So the harness arm is pinned
 * to **`b4eaa1a38ec2127a`** — the body-sha the PRE-#911 generator produced,
 * recorded independently in the `generated-sha:` frontmatter of the
 * `ship-workflow.md` shipped in this repository and in agentgrit. Nothing in
 * this file computed it; a reformat of one character in the harness text
 * moves it and the case goes red.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Make an unrecognised `ship.mode` fall back to `"harness"`.** It is the
 * one-line repair for "a consumer with a typo now crashes", and it is the
 * exact defect #911 is about: a typo'd `"dierct"` silently reinstates the
 * harness, the run looks like it honoured the flag, and the generated rule
 * says the opposite of the project's decision. The refusal cases below
 * survive it really and not vacuously — each asserts the throw AND that the
 * returned policy is not a harness policy, so a fallback turns them red
 * rather than green.
 *
 * ## What was broken to prove it, over this file (28 tests)
 *
 * Every count predicted before the battery ran, and **the baseline row was
 * read before any mutation row** — the first attempt at this battery had a
 * red baseline (the live-tree case was still pinned to the harness sha after
 * rungate itself went `"direct"`), which made all four rows unreadable.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 0 fail | **28 pass, 0 fail** | — |
 * | M1 the cheapest wrong fix: an unrecognised mode falls back to `"harness"` | 7 | **7 of 28** | `{mode:"dierct"}` — the original throws, the mutant returns `{mode:"harness"}` |
 * | M2 `shipWorkflowRule`'s direct arm renders the harness text | 6 | **7 of 28** | a direct policy — the original's output contains `2026-10-19` and no prohibition, the mutant's contains `NEVER spawn Marcus` and no date |
 * | M3 one character of the harness text (`Required` → `required`) | 3 | **3 of 28** | a harness policy — body-sha `b4eaa1a38ec2127a` against `08e1cccbe6e12c67` |
 * | M4 the direct-mode `since`/`reason` requirement removed | 4 | **4 of 28** | `{mode:"direct",reason:"because"}` — the original throws, the mutant returns a dateless direct policy |
 * | M5 the genuinely pre-#911 generator: the rule ignores config entirely | 7 | **8 of 28** | any config — the generator stops consulting `scan.harnessConfig` |
 *
 * **M2 and M5 came back HIGH, and both extra reds are the real kind.**
 * M2's is the live-tree case: rungate's own config says `"direct"`, so a
 * mutant rendering harness text puts this repository's rule file out of
 * agreement with its own declaration — which is precisely what that control
 * is for. M5's two extras are the refusal cases, because a generator that
 * never calls `resolveShipPolicy` cannot refuse a typo. Neither mutant is
 * broken: 21 and 20 cases respectively still pass, and every red is about
 * the mutated behaviour. Per `.claude/rules/checks-must-be-able-to-fail.md`
 * that is "the prediction was wrong and the check is better than you
 * thought", and the fact it records is that the live-tree control witnesses
 * the renderer and not only the tree.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `lib/ship-mode.ts` and `lib/generators/agents-md.ts` were confirmed
 * byte-identical to the measured source afterwards by sha256.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_SHIP_MODE,
  SHIP_MODES,
  ShipModeError,
  resolveShipPolicy,
  shipWorkflowRule,
} from "../lib/ship-mode";
import { generateScopedRules } from "../lib/generators/agents-md";
import { mockProjectScan } from "../lib/generators/types";
import { bodySha, declaredSha, ruleBody } from "../lib/rule-provenance";
import { generateAgentsMdContent } from "../lib/scaffold/steps";
import { tryLoadRungateConfig } from "../lib/config-loader";

const REPO = join(import.meta.dir, "..");

/** The body-sha the pre-#911 generator emitted. Not computed here. */
const PRE_911_BODY_SHA = "b4eaa1a38ec2127a";

const DIRECT = {
  ship: { mode: "direct", since: "2026-10-19", reason: "stabilising RunGate and clearing backlogs" },
};

/**
 * Phrases that FORBID direct shipping. The direct-mode rule must contain none
 * of them; the harness-mode rule must contain all of them. Asserted against
 * the rendered text and not against a flag, because the agent reads the text.
 */
const PROHIBITIONS = [
  "must go through the ship workflow",
  "never spawn agents directly",
  "NEVER spawn Marcus, Quinn, or Rook directly",
];

function ruleFor(config: Record<string, unknown> | null): string {
  const rules = generateScopedRules(mockProjectScan({ harnessConfig: config as any }));
  const rule = rules.find(r => r.filename === "ship-workflow.md");
  if (!rule) throw new Error("the generator emitted no ship-workflow.md at all");
  return rule.content;
}

describe("#911 AC-1: an absent ship block is byte-identical to the pre-#911 generator", () => {
  test("the harness body-sha is the one two shipped consumers already declare", () => {
    expect(bodySha(shipWorkflowRule({ mode: "harness" }))).toBe(PRE_911_BODY_SHA);
  });

  test("absent config, absent ship block and an explicit harness mode all render that same body", () => {
    for (const config of [null, {}, { project: "x" }, { ship: { mode: "harness" } }]) {
      expect(bodySha(ruleFor(config))).toBe(PRE_911_BODY_SHA);
    }
  });

  test("this repository's own rule file agrees with the mode this repository declares", () => {
    // Deliberately NOT pinned to the harness sha: rungate itself went
    // `"direct"` in this change, so a case asserting the pre-#911 body here
    // would assert that the flag does not work. It compares the live file to
    // whatever the live CONFIG resolves to, which is the property that has to
    // hold in both modes and which catches the tree drifting from its own
    // declaration.
    //
    // A prefix match rather than an equality because the live file carries a
    // hand-added launch-base section below the generated part (#644); the
    // scaffold reports it PRESERVED, so the `generated-sha:` records what the
    // GENERATOR would write and not the whole body.
    // Through the loader, never by path — `.claude/rules/config-access.md`.
    const config = tryLoadRungateConfig(REPO);
    expect(config).not.toBeNull();
    const expected = shipWorkflowRule(resolveShipPolicy(config as Record<string, unknown>));
    const live = readFileSync(join(REPO, ".claude", "rules", "ship-workflow.md"), "utf-8");
    expect(declaredSha(live)).toBe(bodySha(expected));
    expect(ruleBody(live).startsWith(ruleBody(expected))).toBe(true);
  });

  test("DEFAULT_SHIP_MODE is harness, and absent resolves to it carrying no date or reason", () => {
    expect(DEFAULT_SHIP_MODE).toBe("harness");
    expect(resolveShipPolicy(null)).toEqual({ mode: "harness" });
    expect(resolveShipPolicy({})).toEqual({ mode: "harness" });
  });
});

describe('#911 AC-2: "harness" forbids direct shipping and "direct" does not', () => {
  // The non-vacuity guard for this whole describe: two empty strings are
  // byte-identical and contain no prohibition either, so both renderings are
  // established as real documents before anything is asserted about absence.
  const harness = ruleFor(null);
  const direct = ruleFor(DIRECT);

  test("both renderings are substantial documents, not empty strings", () => {
    expect(harness.length).toBeGreaterThan(400);
    expect(direct.length).toBeGreaterThan(400);
    expect(harness).not.toBe(direct);
  });

  test("the harness rule forbids direct shipping, in those words", () => {
    for (const phrase of PROHIBITIONS) expect(harness).toContain(phrase);
  });

  test("the direct rule contains none of those prohibitions", () => {
    for (const phrase of PROHIBITIONS) expect(direct).not.toContain(phrase);
  });

  test("the direct rule states the configured date and reason", () => {
    expect(direct).toContain("2026-10-19");
    expect(direct).toContain("stabilising RunGate and clearing backlogs");
  });

  test("the date and reason are read from config, not baked in", () => {
    const other = ruleFor({ ship: { mode: "direct", since: "2025-01-02", reason: "a different reason entirely" } });
    expect(other).toContain("2025-01-02");
    expect(other).toContain("a different reason entirely");
    expect(other).not.toContain("2026-10-19");
    expect(other).not.toContain("stabilising RunGate");
  });

  test("the direct rule says what to do INSTEAD, not merely what not to do", () => {
    // "Do not use the harness" is not an instruction anybody can follow.
    expect(direct).toContain("--add-assignee @me");
    expect(direct).toContain("origin/main");
    expect(direct).toContain("regression test first");
    expect(direct).toContain("auto-merge");
  });

  test("the direct rule says the harness is still there, so nobody reads it as a removal", () => {
    expect(direct).toContain('"harness"');
    expect(direct).toContain("workflows/ship.js");
  });
});

describe("#911 AC-3: an unreadable ship block REFUSES rather than defaulting", () => {
  const unusable: Array<[string, unknown]> = [
    ["a typo'd mode", { mode: "dierct" }],
    ["a mode from another vocabulary", { mode: "manual" }],
    ["an empty-string mode", { mode: "" }],
    ["a non-string mode", { mode: true }],
    ["a block declaring no mode at all", {}],
    ["a block that is a string", "direct"],
    ["a block that is an array", [{ mode: "direct" }]],
    ["direct with no since", { mode: "direct", reason: "because" }],
    ["direct with a prose date", { mode: "direct", since: "October 19", reason: "because" }],
    ["direct with no reason", { mode: "direct", since: "2026-10-19" }],
    ["direct with a blank reason", { mode: "direct", since: "2026-10-19", reason: "   " }],
  ];

  for (const [label, ship] of unusable) {
    test(`${label} throws, and does NOT resolve to "${DEFAULT_SHIP_MODE}"`, () => {
      let resolved: unknown = "nothing was returned";
      expect(() => {
        resolved = resolveShipPolicy({ ship } as Record<string, unknown>);
      }).toThrow(ShipModeError);
      // The second half is the one that survives the cheapest wrong fix: a
      // silent fallback makes the throw disappear AND makes this value a
      // harness policy, so the case is red either way.
      expect(resolved).toBe("nothing was returned");
    });
  }

  test("the refusal names the offending value and every mode that exists", () => {
    try {
      resolveShipPolicy({ ship: { mode: "dierct" } });
      throw new Error("expected a refusal");
    } catch (e) {
      const message = (e as Error).message;
      expect(e).toBeInstanceOf(ShipModeError);
      expect(message).toContain('"dierct"');
      for (const mode of SHIP_MODES) expect(message).toContain(`"${mode}"`);
      expect(message).toContain(".claude/rungate/config.json");
    }
  });

  test("the refusal reaches the generator, so a scaffold cannot emit a rule over a typo", () => {
    expect(() => ruleFor({ ship: { mode: "dierct" } })).toThrow(ShipModeError);
  });
});

describe("#911 AC-4: the UPDATE path replaces an existing consumer's rule, not just the create path", () => {
  /** A consumer that already carries the pre-#911 rule, stamped as the harness wrote it. */
  function existingConsumer(ship: unknown): { root: string; rulePath: string } {
    const root = mkdtempSync(join(tmpdir(), "rg-911-consumer-"));
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer-911" }, null, 2));
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "consumer-911", repo: "o/consumer-911", issueRepo: "o/consumer-911", ...(ship === undefined ? {} : { ship }) }, null, 2),
    );
    // Byte-for-byte what a consumer scaffolded before #911 holds on disk.
    const rulePath = join(root, ".claude", "rules", "ship-workflow.md");
    writeFileSync(
      rulePath,
      `---
description: All implementation work must go through the ship workflow — never spawn agents directly
generated-sha: ${PRE_911_BODY_SHA}
---

## Ship Workflow Required

When shipping an issue or implementing code changes, use the ship workflow:

\`\`\`
Skill("ship")  →  Workflow({ scriptPath: "workflows/ship.js" })
\`\`\`

**NEVER spawn Marcus, Quinn, or Rook directly with the Agent tool.** The ship workflow captures transcripts, runs compliance grading, and enforces gates. Spawning agents directly bypasses all measurement.

If Skill("harness") or Skill("goal") fails, fall back to Skill("ship") with the issue number.
`,
    );
    return { root, rulePath };
  }

  test("the planted file is genuinely the pre-#911 one the harness recognises as its own", () => {
    // Without this the UPDATE below could be a `create` wearing an update's
    // name, or a `preserve` nobody noticed, and the case would pass over a
    // generator that never ran.
    const { root, rulePath } = existingConsumer(undefined);
    try {
      const before = readFileSync(rulePath, "utf-8");
      expect(declaredSha(before)).toBe(PRE_911_BODY_SHA);
      expect(bodySha(before)).toBe(PRE_911_BODY_SHA);
      for (const phrase of PROHIBITIONS) expect(before).toContain(phrase);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('re-scaffolding an EXISTING consumer with "direct" actually replaces the file on disk', () => {
    const { root, rulePath } = existingConsumer(DIRECT.ship);
    try {
      const actions: string[] = [];
      generateAgentsMdContent(root, "code", actions);

      const after = readFileSync(rulePath, "utf-8");
      expect(actions).toContain("UPDATED: .claude/rules/ship-workflow.md");
      // Assert the TEXT, not that a write happened: a generator that threw
      // halfway leaves a file, and an empty one compares equal to an empty one.
      expect(after.length).toBeGreaterThan(400);
      expect(after).toContain("2026-10-19");
      expect(after).toContain("stabilising RunGate and clearing backlogs");
      for (const phrase of PROHIBITIONS) expect(after).not.toContain(phrase);
      // And it is stamped, so the NEXT re-scaffold still owns it.
      expect(declaredSha(after)).toBe(bodySha(after));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same existing consumer with no ship block keeps the file it already had", () => {
    const { root, rulePath } = existingConsumer(undefined);
    try {
      const before = readFileSync(rulePath, "utf-8");
      generateAgentsMdContent(root, "code", []);
      expect(readFileSync(rulePath, "utf-8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing consumer with a typo'd mode refuses the whole scaffold and leaves the file alone", () => {
    const { root, rulePath } = existingConsumer({ mode: "dierct", since: "2026-10-19", reason: "x" });
    try {
      const before = readFileSync(rulePath, "utf-8");
      expect(() => generateAgentsMdContent(root, "code", [])).toThrow(ShipModeError);
      expect(readFileSync(rulePath, "utf-8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
