/**
 * A reinforcement the hill-climb loop inserts is markdown somebody has to read
 * (#624).
 *
 * Covers SC-2083 (INSTRUCTION-COMPLIANCE-SPEC.md).
 *
 * The loop appended `"\n- **REINFORCED (auto):** " + text` immediately before
 * the next `## ` heading, so the bullet butted straight against the heading:
 *
 * ```markdown
 * - **REINFORCED (auto):** NEVER read a file with cat…
 * ## Context (READ THIS FIRST)
 * ```
 *
 * A list item followed by an ATX heading with no blank line between them is
 * not a reliably parsed construct, and these files are read by agents as
 * context — so the rule most likely to be swallowed is the one the loop just
 * decided an agent keeps breaking.
 *
 * ## The wrong fix this case is written to survive
 *
 * The cheapest repair for "there is no blank line before the heading" is to
 * append a newline to the prefix string — one character, in the one place the
 * prefix is spelled. It does not separate the block from the heading at all;
 * it moves the reinforcement text onto its own line and leaves the heading
 * exactly where it was. So the case asserts BOTH lines around the heading: the
 * line directly above it must be blank, and the line above THAT must carry the
 * prefix and the reinforcement text together. Under the trailing-newline fix
 * the second assertion fails, because the line above the blank is the bare
 * text with no prefix on it.
 *
 * Asserted by reading the two lines around the heading rather than searching
 * the whole document — a document-wide `toContain("\n\n## ")` is satisfied by
 * any other blank line in the brief, of which a brief has many.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  REINFORCEMENT_PREFIX,
  applyHillClimb,
  insertReinforcement,
  type HillClimbAction,
} from "../lib/compliance-report";

const REINFORCEMENT =
  "NEVER read a file with cat, head, or tail via Bash — use Read with offset/limit.";

const HEADING = "## Context (READ THIS FIRST)";

/** The shape #624 was measured on: a `## Never Do` list, then a heading. */
const BRIEF = `---
name: discovery
---

## Never Do
- Read files not relevant to the issue — stay scoped
- Guess at file structure — use AGENTS.md routing table

${HEADING}
- Read AGENTS.md first
`;

function action(): HillClimbAction {
  return {
    compId: "COMP-7",
    rule: "No cat/head via Bash",
    reinforcement: REINFORCEMENT,
    consecutiveFails: 3,
    tier: 1,
  };
}

function reinforcedBrief(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "hill-climb-markdown-"));
  const briefPath = join(dir, "discovery.md");
  writeFileSync(briefPath, source);
  const result = applyHillClimb(briefPath, [action()], { destination: "COMMIT" });
  // The assertion below is only evidence if a reinforcement was applied at
  // all — a run that skipped would leave the fixture's own blank line in
  // place and read as a pass.
  expect(result.applied.length).toBe(1);
  return readFileSync(briefPath, "utf-8").split("\n");
}

describe("hill-climb markdown", () => {
  test("AC-3: the inserted block is separated from the heading that follows it by a blank line", () => {
    const lines = reinforcedBrief(BRIEF);

    const headingIdx = lines.indexOf(HEADING);
    // Presence before comparing (#518): a heading the split could not find
    // gives -1, and `lines[-1]` is undefined, which compares unequal to
    // everything and would read as a distinction.
    expect(headingIdx).toBeGreaterThan(1);

    expect(lines[headingIdx - 1]).toBe("");
    expect(lines[headingIdx - 2]).toBe(`${REINFORCEMENT_PREFIX}${REINFORCEMENT}`);
  });

  test("AC-4b: the prefix and the reinforcement text share one line, so a newline inside the prefix is not a fix", () => {
    const lines = reinforcedBrief(BRIEF);
    const headingIdx = lines.indexOf(HEADING);
    expect(headingIdx).toBeGreaterThan(1);

    const bullet = lines[headingIdx - 2];
    expect(bullet.startsWith(REINFORCEMENT_PREFIX)).toBe(true);
    expect(bullet.endsWith(REINFORCEMENT)).toBe(true);
  });

  test("AC-3: an insertion with nothing after it ends the file with a single newline", () => {
    const tail = "---\nname: discovery\n---\n\n## Never Do\n- Stay scoped\n";
    const lines = reinforcedBrief(tail);

    expect(lines[lines.length - 1]).toBe("");
    expect(lines[lines.length - 2]).toBe(`${REINFORCEMENT_PREFIX}${REINFORCEMENT}`);
  });

  test("AC-3: insertReinforcement opens a new line when the text before it does not end in one", () => {
    const out = insertReinforcement("## Never Do\n- Stay scoped", "## Never Do\n- Stay scoped".length, "x");
    expect(out).toBe(`## Never Do\n- Stay scoped\n${REINFORCEMENT_PREFIX}x\n`);
  });

  test("AC-4: the reinforcement prefix literal appears exactly once in lib/compliance-report.ts", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "lib", "compliance-report.ts"),
      "utf-8",
    );
    // The literal, not the binding name: three sites at :511, :515 and :519
    // each spelled it out, so a formatting change could be half-applied.
    const occurrences = source.split("**REINFORCED (auto):**").length - 1;
    expect(occurrences).toBe(1);
  });
});
