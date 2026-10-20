/**
 * #655 — a mined reinforcement had no durable home.
 *
 * Every per-role surface an agent reads was regenerated from harness-wide
 * inputs. `.claude/agents/*.md` was declared `regenerate` and the
 * declaration was never consulted: `generateAgentBriefsStep` called
 * `writeFileSync(p, content)` with no `decideOwnedWrite`, no
 * `ownedStrategy` and no preservation step, so the row happened to
 * describe the behaviour rather than cause it.
 * `templates/agent-briefs/_shared.md` resolves under the harness's own
 * templates directory, so a project rule written there reaches every
 * consumer; `roles.json`'s `tiers.reinforcement` carries section NAMES,
 * not rule text.
 *
 * So the hill-climb composed rules that the next `bunx rungate scaffold .`
 * destroyed, whichever destination #648 picks.
 *
 * `## Project Constraints` is the fourth option: one region of a brief the
 * harness does not own, carried forward by the same merge AGENTS.md's
 * `## Hard Constraints` goes through (#568) — including the property worth
 * copying, which is that a run that cannot carry every line forward
 * REFUSES the write and names the lines rather than losing them quietly.
 *
 * Covers SC-2131..SC-2137 (AGENT-BRIEF-TEMPLATE-SPEC.md).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BRIEF_CONSTRAINTS_SECTION, readPreservedSection } from "../lib/agents-md-sections";
import {
  applyHillClimb,
  type HillClimbAction,
  REINFORCEMENT_PREFIX,
} from "../lib/compliance-report";
import { SCAFFOLD_REFUSE } from "../lib/scaffold/owned-files";
import { generateAgentBriefsStep, ownedStrategy } from "../lib/scaffold/steps";
import { structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
const HARNESS_TEMPLATES = join(REPO_ROOT, "templates", "agent-briefs");

/** The heading, spelled once. Every fixture below reads it from the module. */
const HEADING = BRIEF_CONSTRAINTS_SECTION.label;

/**
 * A string that cannot come from a template. If this ever appears in a
 * generated brief the preservation cases below are measuring the generator
 * rather than the merge, and the premise assertions say so by name.
 */
const MARKER = "- CANARY-655: the deploy ref is pinned, and nothing in the code says why";

let root: string;
const briefPath = () => join(root, ".claude", "agents", "marcus.md");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brief-region-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Append a project-owned section carrying `body` to the brief on disk. */
function plantRegion(body: string = MARKER): void {
  writeFileSync(briefPath(), `${readFileSync(briefPath(), "utf-8").replace(/\s+$/, "")}\n\n${HEADING}\n\n${body}\n`);
}

describe("#655: a brief carries one project-owned region", () => {
  // covers SC-2132
  test("SC-2132: a marker written into the region survives a re-scaffold verbatim", () => {
    const first: string[] = [];
    generateAgentBriefsStep(root, first);
    const generated = readFileSync(briefPath(), "utf-8");

    // --- The premise, asserted BEFORE anything about preservation (the
    // issue's criterion 5). A generator that happened to emit either string
    // would make the assertion below true without the feature.
    expect(generated, "the generator already emits the marker").not.toContain(MARKER);
    expect(generated, "a template emits the project-owned heading — the merge would refuse")
      .not.toContain(HEADING);
    expect(first).toContain("CREATED: .claude/agents/marcus.md");

    plantRegion();
    const planted = readFileSync(briefPath(), "utf-8");
    expect(readPreservedSection(planted, BRIEF_CONSTRAINTS_SECTION), "the fixture planted no readable section")
      .not.toBeNull();

    const second: string[] = [];
    generateAgentBriefsStep(root, second);
    const after = readFileSync(briefPath(), "utf-8");

    // The run really regenerated — a step that skipped the file entirely
    // would preserve the marker by doing nothing at all.
    expect(second.join("\n"), "the brief was not rewritten, so nothing was preserved")
      .toContain("UPDATED: .claude/agents/marcus.md");
    expect(after, "the brief was left exactly as the fixture wrote it").not.toBe(planted);

    expect(after, "the marker did not survive regeneration").toContain(MARKER);
    expect(readPreservedSection(after, BRIEF_CONSTRAINTS_SECTION)?.text, "the section came back altered")
      .toBe(`${HEADING}\n\n${MARKER}`);

    // And the generated half is still generated: every non-blank line the
    // first run wrote is still there, so "preserved" did not mean "froze".
    const lost = generated.split("\n").map(l => l.trim()).filter(l => l !== "" && !after.includes(l));
    expect(lost, "regeneration dropped generated lines").toEqual([]);
  });

  // covers SC-2133
  test("SC-2133: the merge is idempotent — a third run is byte-identical", () => {
    generateAgentBriefsStep(root, []);
    plantRegion();
    generateAgentBriefsStep(root, []);
    const second = readFileSync(briefPath(), "utf-8");

    const third: string[] = [];
    generateAgentBriefsStep(root, third);

    expect(readFileSync(briefPath(), "utf-8"), "the section moved on the second merge").toBe(second);
    expect(third.join("\n")).toContain("UNCHANGED: .claude/agents/marcus.md");
  });

  // covers SC-2134
  test("SC-2134: no shipped template emits the project-owned heading", () => {
    // The premise behind every case above, over the real templates rather
    // than the one brief the fixture reads. A template that grew the
    // heading would make `preserveSections` take its own-section branch and
    // REFUSE every re-scaffold on every consumer that had written one.
    const templates = readdirSync(HARNESS_TEMPLATES).filter(f => f.endsWith(".md"));
    expect(templates.length, "no templates were read — this case measures nothing")
      .toBeGreaterThan(3);
    for (const f of templates) {
      expect(readFileSync(join(HARNESS_TEMPLATES, f), "utf-8"), `${f} emits ${HEADING}`)
        .not.toContain(HEADING);
    }
  });
});

describe("#655: the declared strategy is the one the write path honours", () => {
  // covers SC-2139
  test("SC-2139: the brief write reads OWNED_FILES rather than naming a strategy", () => {
    // The cheapest wrong fix, blocked. The symptom #655 reports is a lost
    // reinforcement, and the 5pm repair is one import and one call:
    // preserve at the write site and leave the row saying `regenerate` /
    // "Don't edit briefs". Every behavioural case above goes GREEN under
    // it — the marker survives, the refusal fires — and what ships is a
    // brief that preserves edits while every surface a human or an agent
    // reads to decide whether to edit one still says not to.
    //
    // So this case asserts the declaration is IN THE PATH, two ways, and
    // mutating either side reds it: the row must say section-preserving,
    // and the step must resolve the strategy through `ownedStrategy`
    // rather than carrying a literal.
    expect(ownedStrategy(".claude/agents/marcus.md"), "the declared strategy is not the one #655 shipped")
      .toBe("section-preserving");

    // The loop that writes one brief, cut structurally — the construct
    // ends where the construct ends, not at a character count (#664). A
    // moved anchor THROWS rather than cutting the wrong region.
    const write = structuralCut(
      readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8"),
      "for (const [agentName, content] of Object.entries(briefs))",
      { balanced: "{" },
    );
    expect(write.length, "the brief write loop could not be cut out of steps.ts")
      .toBeGreaterThan(0);
    expect(write, "the write no longer resolves its strategy from the declaration")
      .toContain("ownedStrategy(label)");
    expect(write, "the write names a strategy literal — the row is decorative again")
      .not.toMatch(/["'](?:section-preserving|regenerate|provenance|create-only|job-preserving)["']/);
    expect(write, "the write no longer asks the declaration which section is preserved")
      .toContain("ownedSections(label)");
  });
});

describe("#655: a regeneration that cannot carry the region forward refuses", () => {
  /** A templates directory whose marcus brief emits the heading itself. */
  function collidingTemplates(): string {
    const d = join(root, "colliding-templates");
    mkdirSync(d, { recursive: true });
    for (const f of readdirSync(HARNESS_TEMPLATES).filter(n => n.endsWith(".md"))) {
      const src = readFileSync(join(HARNESS_TEMPLATES, f), "utf-8");
      writeFileSync(
        join(d, f),
        f === "marcus.md" ? `${src.replace(/\s+$/, "")}\n\n${HEADING}\n\n- the template's own rule\n` : src,
      );
    }
    return d;
  }

  // covers SC-2135
  test("SC-2135: the write is refused, the lines are named, and the file is untouched", () => {
    generateAgentBriefsStep(root, []);
    plantRegion();
    const before = readFileSync(briefPath(), "utf-8");

    const actions: string[] = [];
    generateAgentBriefsStep(root, actions, { templatesDir: collidingTemplates() });

    const log = actions.join("\n");
    expect(log, "the colliding run did not refuse").toContain(
      `${SCAFFOLD_REFUSE}: .claude/agents/marcus.md not written`,
    );
    expect(log, "the refusal does not name the lines at risk").toContain(MARKER);
    expect(log, "the refusal does not say which section it is about").toContain(HEADING);

    expect(readFileSync(briefPath(), "utf-8"), "the brief was written over a refusal").toBe(before);

    // The refusal is per-file, not a dead run: the other briefs, which have
    // no planted region, are still written.
    expect(log, "a refusal on one brief stopped the whole step")
      .toMatch(/^(CREATED|UPDATED|UNCHANGED): \.claude\/agents\/quinn\.md/m);
  });

  // covers SC-2136
  test("SC-2136: the same colliding templates write freely when no region was planted", () => {
    // The control. Without it, a step that refused `marcus.md` for any
    // reason at all — an unreadable template, a thrown merge — would pass
    // the case above, and the refusal would not be about the region.
    generateAgentBriefsStep(root, []);

    const actions: string[] = [];
    generateAgentBriefsStep(root, actions, { templatesDir: collidingTemplates() });

    expect(actions.join("\n"), "the refusal fires with nothing to lose")
      .not.toContain(`${SCAFFOLD_REFUSE}: .claude/agents/marcus.md`);
    expect(readFileSync(briefPath(), "utf-8")).toContain("- the template's own rule");
  });
});

describe("#655: the hill-climb writes where the preservation reaches", () => {
  const action = (compId: string, reinforcement: string): HillClimbAction => ({
    compId,
    rule: "a rule the grader keeps failing",
    reinforcement,
    consecutiveFails: 3,
    tier: 1,
  });

  // covers SC-2137
  test("SC-2137: a COMMIT reinforcement lands in the region and survives a re-scaffold", () => {
    generateAgentBriefsStep(root, []);
    const generated = readFileSync(briefPath(), "utf-8");
    // Premise: the brief really has one of the generated headings the loop
    // used to prefer, so the region winning is a CHOICE and not the only
    // option available (`## Testing Rules` is in every marcus template).
    expect(generated, "the fixture brief has no generated insertion point at all")
      .toContain("## Testing Rules");

    plantRegion();
    const RULE = "run the suite before claiming a fix is done (#655 fixture)";
    const result = applyHillClimb(briefPath(), [action("COMP-2", RULE)], { destination: "COMMIT" });

    expect(result.applied.length, `the loop applied nothing: ${result.skipped.join(" | ")}`).toBe(1);
    expect(result.write.path, "COMMIT wrote nowhere").toBe(briefPath());

    const section = readPreservedSection(readFileSync(briefPath(), "utf-8"), BRIEF_CONSTRAINTS_SECTION);
    expect(section, "the brief lost its region").not.toBeNull();
    expect(section!.text, "the reinforcement landed outside the project-owned region")
      .toContain(`${REINFORCEMENT_PREFIX}${RULE}`);

    // The join, and the only claim #655 actually makes: what the loop wrote
    // is still there after the scaffold that used to destroy it.
    const actions: string[] = [];
    generateAgentBriefsStep(root, actions);
    expect(actions.join("\n")).toContain("UPDATED: .claude/agents/marcus.md");
    expect(readFileSync(briefPath(), "utf-8"), "the re-scaffold destroyed the reinforcement")
      .toContain(`${REINFORCEMENT_PREFIX}${RULE}`);
  });

  // covers SC-2138
  test("SC-2138: with no region the loop still uses a generated heading, and NO_SECTION still fires", () => {
    // Two controls in one case, and they are the reason the change is a
    // PREFERENCE and not a creation. Writing the heading when it is absent
    // would make `NO_SECTION` unreachable and silently change every
    // receipt #646 made reportable.
    generateAgentBriefsStep(root, []);
    const RULE = "a rule with no region to live in (#655 fixture)";
    const applied = applyHillClimb(briefPath(), [action("COMP-2", RULE)], { destination: "COMMIT" });

    expect(applied.applied.length, "the loop found no generated heading either").toBe(1);
    const after = readFileSync(briefPath(), "utf-8");
    expect(after).toContain(`${REINFORCEMENT_PREFIX}${RULE}`);
    expect(readPreservedSection(after, BRIEF_CONSTRAINTS_SECTION), "a region was invented")
      .toBeNull();

    const bare = join(root, "bare.md");
    writeFileSync(bare, "# brief\n\n## Something Else\n\n- a\n");
    const none = applyHillClimb(bare, [action("COMP-9", "nowhere to go")], { destination: "COMMIT" });
    expect(none.skipOutcomes.map(o => o.kind)).toEqual(["NO_SECTION"]);
    expect(none.write.path, "a brief with no section was written anyway").toBeNull();
    expect(existsSync(bare) && readFileSync(bare, "utf-8")).toBe("# brief\n\n## Something Else\n\n- a\n");
  });
});
