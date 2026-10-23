/**
 * #1309 — the scaffold routes specs, docs and key files, and not commands.
 *
 * `.claude/rules/docs-routing.md` and `.claude/rules/specs-routing.md` are
 * generated and route DOCUMENTS. `.claude/rules/key-files.md` routes FILES.
 * `.claude/rules/harness-managed.md` routes OWNERSHIP. Nothing routed the
 * project's own CLI, so a command reached an agent only if somebody had
 * hand-written a row for it in `AGENTS.md`'s Commands table.
 *
 * Measured on `11a60f67` with the matcher below, over the always-loaded
 * surface and nothing else: three of ten commands were named — `scaffold`,
 * `create-spec`, `create-sc` — and seven were not, `audit-specs` among them.
 * An agent spent a day hand-building the thing `audit-specs` does.
 *
 * ## Why these counts differ from the issue's
 *
 * #1309 reports five of ten absent. Two commands it counted as present are
 * absent here, and both differences are the instrument being narrower on
 * purpose:
 *
 *   - `create-success` is named in `.claude/rules/harness-managed.md`, which
 *     declares `paths:` and therefore loads ON DEMAND. The issue counted
 *     every `.claude/rules/*.md`; this counts what `measureSurface` says is
 *     loaded at launch, which is the question "can an agent find it" is
 *     actually about.
 *   - `convert-spec` appears only as `scripts/convert-spec.ts`, the script
 *     path. That is not a command a consumer can type, and reading it as one
 *     is how the row stayed absent from the CLI's own documentation.
 *
 * Both corrections move in the same direction — more commands unrouted — and
 * that is the direction `commandNamed` is allowed to be wrong in.
 *
 * ## What was broken to prove this can fail
 *
 * Recorded in the PR with its counts. The short version: the population case
 * below is RED on the tree this file was added to, naming those seven, and it
 * is red again if the generated rule is deleted, if a command is added to
 * `CLI_COMMANDS` without regenerating, or if the rule acquires a `paths:` key
 * — the last being the cheapest wrong fix, because the surface is at 93% of
 * its byte budget and scoping a rule is how you buy bytes back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLI_COMMANDS,
  codeSpans,
  commandNamed,
  commandRoutingReading,
  commandRoutingTable,
  publishedCommands,
  type SurfaceDoc,
} from "../lib/cli-commands";
import { isPathScoped, measureSurface } from "../scripts/check-instruction-surface";

const ROOT = join(import.meta.dir, "..");
const RULE = join(ROOT, ".claude", "rules", "commands-routing.md");

/**
 * The always-loaded surface, read through the one binding that decides what
 * "always loaded" means.
 *
 * `measureSurface` reports every launch document plus every rule, marking a
 * path-scoped rule `excluded`. Filtering on `excluded` here is what makes a
 * `paths:` key added to the commands rule visible as the removal it is.
 */
function surface(): SurfaceDoc[] {
  return measureSurface(ROOT)
    .entries.filter(e => e.excluded === null)
    .map(e => ({ file: e.file, text: readFileSync(join(ROOT, e.file), "utf-8") }));
}

describe("#1309: every command the CLI exposes is named where an agent loads it", () => {
  test("the surface this is measured over is a real population", () => {
    // The control, before any count below is believed. An empty surface, or
    // one with no code spans in it, returns an empty unrouted list for an
    // instrument reason and reads exactly like a fully routed tree
    // (`.claude/rules/checks-must-be-able-to-fail.md`, "before you believe an
    // empty search"). `CLAUDE.md` and `AGENTS.md` are loaded unconditionally,
    // so a population without both is not this repository.
    const docs = surface();
    const files = docs.map(d => d.file);
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain("AGENTS.md");
    expect(docs.length).toBeGreaterThanOrEqual(5);
    expect(Buffer.byteLength(docs.map(d => codeSpans(d.text)).join("\n"))).toBeGreaterThan(0);
  });

  test("no registered command is absent from the always-loaded surface", () => {
    const reading = commandRoutingReading(surface());
    expect(reading.reading, reading.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(
      reading.unrouted,
      `${reading.unrouted.length} of ${publishedCommands().length} registered commands are ` +
        `named in none of the ${reading.filesSearched} documents an agent loads before it ` +
        `reads its issue. A command an agent cannot find is a command it rebuilds by hand ` +
        `(#1309). Do not hand-write a row: add the command to CLI_COMMANDS in ` +
        `lib/cli-commands.ts and re-run \`bun bin/rungate.ts scaffold .\`, which regenerates ` +
        `.claude/rules/commands-routing.md from the registry.`,
    ).toEqual([]);
  });

  test("the rule carries no `paths:`, so it is loaded and not merely present", () => {
    // The cheapest wrong fix, named. The surface is at 93% of
    // SURFACE_BUDGET_BYTES, and the one-line way to make a budget complaint go
    // away is to scope a rule — which moves it out of the launch surface
    // entirely. The file would still be on disk, still be generated, still be
    // correct, and route nobody.
    expect(
      isPathScoped(readFileSync(RULE, "utf-8")),
      "commands-routing.md declares `paths:`, so it loads on demand — the one state in " +
        "which the file exists and routes nobody",
    ).toBe(false);
  });
});

describe("#1309: the routing is derived from the registry, not hand-listed", () => {
  test("the shipped rule carries the generator's table verbatim", () => {
    // Without this, the population case above is satisfiable by typing a
    // command name into any always-loaded file — which is the hand-list that
    // went stale and is the defect, re-arriving as the repair for itself.
    expect(readFileSync(RULE, "utf-8")).toContain(commandRoutingTable());
  });

  test("the table names every command and its summary, and invents none", () => {
    const table = commandRoutingTable();
    for (const [name, cmd] of Object.entries(CLI_COMMANDS)) {
      expect(table).toContain(`| \`${name}\` |`);
      expect(table).toContain(cmd.summary);
    }
    // Rows, not counting the header and separator. A table that grew a row
    // from somewhere other than the registry is as wrong as one that lost one.
    expect(table.split("\n").length - 2).toBe(publishedCommands().length);
  });
});

describe("#1309: the matcher reports absence, and says when it could not look", () => {
  test("a name typed in a code span counts; the same name in prose does not", () => {
    // The pair varies one thing: whether the name is inside backticks. If
    // prose counted, `re-scaffold rewrites them` would route `scaffold` and
    // the check would be green over a tree that routes nothing.
    expect(commandNamed("Run `audit-specs` to see the report.", "audit-specs")).toBe(true);
    expect(commandNamed("Run audit-specs to see the report.", "audit-specs")).toBe(false);
  });

  test("a script path is not a routing, and a longer name is not a match", () => {
    expect(commandNamed("`bun scripts/convert-spec.ts <file>`", "convert-spec")).toBe(false);
    expect(commandNamed("`a re-scaffold rewrites it`", "scaffold")).toBe(false);
    expect(commandNamed("`bunx rungate create-success`", "create-sc")).toBe(false);
    expect(commandNamed("`bunx rungate scaffold .`", "scaffold")).toBe(true);
  });

  test("a command named nowhere is reported, not silently dropped", () => {
    // The positive control for the whole mechanism: the real registry against
    // a surface that routes none of it.
    const reading = commandRoutingReading([{ file: "x.md", text: "`nothing to see`" }]);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.unrouted).toEqual(publishedCommands());
  });

  test("an empty surface is UNMEASURED, never a clean reading", () => {
    const none = commandRoutingReading([]);
    expect(none.reading).toBe("UNMEASURED");
    expect(none.unmeasuredReasons.join(" ")).toContain("empty");

    // Documents present, no code spans in any of them. Every command reads as
    // unrouted for an instrument reason, which is the inverse failure and
    // just as silent.
    const noSpans = commandRoutingReading([{ file: "a.md", text: "prose with no backticks" }]);
    expect(noSpans.reading).toBe("UNMEASURED");
    expect(noSpans.spanBytes).toBe(0);
  });
});
