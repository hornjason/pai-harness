/**
 * #1148: a generated trigger change has to be able to reach a consumer that
 * already has the file.
 *
 * ## The defect
 *
 * #1136 removed the `branches:` filter from `on.pull_request` in every
 * generated workflow, because a pull request based on a feature branch matched
 * no entry and so triggered nothing at all — and reported CLEAN, because no
 * required check was left pending. The generator change is right. It cannot
 * arrive: `mergeTopLevelSection` is ADDITIVE, so a sub-key both sides declare
 * keeps the consumer's value, and `pull_request` is a sub-key both sides
 * declare. The removal has no channel.
 *
 * ## Why the proposed fix is the wrong one, measured rather than argued
 *
 * #1148 proposes regenerating the `on:` block when its `generated-sha` marker
 * is VERIFIED, on the reading that "a VERIFIED marker proves the bytes on disk
 * are the harness's own output". **That reading is false**, and
 * `managed-workflow.ts` already says so one layer up (`restorableIntro`): a
 * verified marker proves the harness WROTE the bytes, not that it AUTHORED
 * them. The merge carries a consumer's value forward and then re-stamps, so
 * one re-scaffold launders a hand-edited `on:` block into VERIFIED bytes.
 * `AC-5` below is that laundering, executed.
 *
 * The control #1148 asks for — "a fixture whose `on:` block was hand-edited
 * must still be preserved" — would have PASSED against that fix while the
 * defect shipped, because a freshly hand-edited fixture has a stale marker and
 * so reads UNPROVEN. The control cannot see the case that breaks. That is why
 * this file pins the laundering as a property rather than trusting provenance.
 *
 * ## What replaces it
 *
 * An explicit ownership claim, `HARNESS_AUTHORED_PATHS`, in the shape #923
 * already uses for `permissions.id-token`: the harness names the sub-key paths
 * it authors, and a named path the generator has stopped emitting is withdrawn.
 * It is a statement about the GENERATOR, which the harness can actually make,
 * rather than an inference from a digest, which it cannot.
 *
 * The withdrawal is gated twice over, and `AC-3`/`AC-8` are those gates:
 * nothing is withdrawn unless the generator still emits the PARENT sub-key,
 * and nothing is withdrawn from a path that is not named.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  HARNESS_AUTHORED_PATHS,
  mergeManagedWorkflowRecording,
} from "../lib/scaffold/managed-workflow";
import { writeManagedFile } from "../lib/scaffold/steps";
import { lineCommentProvenance } from "../lib/scaffold/owned-files";

const PROV = lineCommentProvenance("#");

/** What the generator emits since #1136: `pull_request` bare, `push` filtered. */
const GENERATED = `# Managed by rungate
name: ci
on:
  push:
    branches:
      - "main"
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** A consumer scaffolded before #1136: the filter the generator used to emit. */
const CONSUMER = `# Managed by rungate
name: ci
on:
  push:
    branches:
      - "main"
  pull_request:
    branches:
      - "main"

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** The `on:` block only, so an assertion about triggers cannot read a job. */
function onBlock(text: string): string {
  const start = text.indexOf("\non:");
  const end = text.indexOf("\njobs:");
  expect(start, "the fixture has no `on:` block, so every assertion below is vacuous").toBeGreaterThan(-1);
  expect(end, "the fixture has no `jobs:` key, so the slice is not the trigger block").toBeGreaterThan(start);
  return text.slice(start, end);
}

const merge = (before: string, generated: string, overrides: readonly string[] = []) =>
  mergeManagedWorkflowRecording(before, generated, overrides);

// ── AC-1: the removal reaches a consumer that already has the file ───────

describe("AC-1 (#1148): a withdrawn trigger filter reaches an existing consumer", () => {
  test("the consumer's `on.pull_request.branches` is removed", () => {
    const { content } = merge(CONSUMER, GENERATED);
    const block = onBlock(content);
    expect(
      block,
      "the consumer keeps the `branches:` filter under `pull_request`, so #1136's fix " +
        "never arrives and the pull requests it was about still run no CI",
    ).not.toMatch(/pull_request:\s*\n\s*branches:/);
  });

  test("the withdrawal is RECORDED, not silent", () => {
    // A removal the merge does not report is a removal `resolveManagedWrite`
    // cannot whitelist, which is a REFUSED re-scaffold (#834) — and a
    // consumer who is never told loses a filter they chose with no signal.
    const { revoked } = merge(CONSUMER, GENERATED);
    expect(revoked.map(r => `${r.section}.${r.key}`)).toEqual(["on.pull_request.branches"]);
    expect(revoked[0].reason, "an authored withdrawal reported as a computed grant gives false advice").toBe(
      "authored",
    );
    expect(
      revoked[0].lines.join("\n"),
      "the record does not carry the lines it removed, so the write cannot forgive them",
    ).toContain("branches:");
  });

  test("`push.branches` is untouched — the generator still emits it", () => {
    const block = onBlock(merge(CONSUMER, GENERATED).content);
    expect(
      block,
      "the push filter went with the pull_request one: this withdrawal is not reading " +
        "the generator, it is deleting every `branches:` it finds",
    ).toMatch(/push:\s*\n\s*branches:/);
  });
});

// ── AC-1b: the shape the generator actually emits ────────────────────────

describe("AC-1b (#1148): the real generated workflows, not a fixture shape", () => {
  // The case that caught the first draft. Every generated workflow introduces
  // `pull_request:` with a comment block, and `parseSubKeys` puts a block's
  // introducing comments BEFORE its key line. A re-parse that assumes
  // `lines[0]` is the key reads the comment instead, finds no leaves, and
  // withdraws nothing — eleven green cases and zero effect on any real file.
  //
  // Driven off the committed workflows rather than a copy of them, so the day
  // a generator stops emitting the trigger bare this case says so.
  const WORKFLOWS = ["ci.yml", "gates.yml", "ai-review.yml"] as const;

  /** The committed file with the pre-#1136 filter put back: a consumer. */
  function asPre1136Consumer(text: string): string {
    const withFilter = text.replace(/\n  pull_request:\n/, '\n  pull_request:\n    branches:\n      - "main"\n');
    expect(
      withFilter,
      "no bare `pull_request:` to put a filter back on — this case no longer builds a consumer",
    ).not.toBe(text);
    return withFilter;
  }

  for (const name of WORKFLOWS) {
    test(`${name}: a pre-#1136 consumer loses the filter`, () => {
      const generated = readFileSync(join(import.meta.dir, "..", ".github", "workflows", name), "utf-8");
      const consumer = asPre1136Consumer(generated);
      const { content, revoked } = merge(consumer, generated);
      expect(
        revoked.map(r => `${r.section}.${r.key}`),
        `${name} withdrew nothing from a consumer carrying the filter #1136 removed`,
      ).toEqual(["on.pull_request.branches"]);
      expect(
        onBlock(content),
        `${name} kept the filter, so #1136's fix still cannot reach an existing consumer`,
      ).not.toMatch(/pull_request:\s*\n\s*branches:/);
      // The comment block introducing the trigger is the consumer's to keep —
      // and it is the thing the first draft tripped over, so assert it.
      expect(
        onBlock(content),
        `${name} dropped the comment introducing the trigger along with the filter`,
      ).toContain("NO branches: filter");
    });
  }
});

// ── AC-2: the consumer's other trigger keys survive ──────────────────────

describe("AC-2 (#1148): only the named path is withdrawn", () => {
  const WITH_EXTRAS = CONSUMER.replace(
    "  pull_request:\n    branches:\n      - \"main\"\n",
    "  pull_request:\n    branches:\n      - \"main\"\n    types:\n      - opened\n",
  );

  test("a sibling sub-key the harness does not claim is preserved", () => {
    const block = onBlock(merge(WITH_EXTRAS, GENERATED).content);
    expect(block, "`types:` is the consumer's and nothing claims it").toContain("types:");
    expect(block, "the claimed path was not withdrawn").not.toMatch(/pull_request:[\s\S]*branches:/);
  });

  test("a consumer's own top-level trigger is preserved", () => {
    const withSchedule = CONSUMER.replace(
      "\njobs:",
      "  schedule:\n    - cron: \"0 0 * * *\"\n\njobs:",
    );
    expect(
      onBlock(merge(withSchedule, GENERATED).content),
      "a trigger the generator never emits is the consumer's, and it was dropped",
    ).toContain("cron:");
  });
});

// ── AC-3 / AC-8: the two gates, each able to fail ────────────────────────

describe("AC-3 (#1148): nothing is withdrawn unless the generator emits the parent", () => {
  test("a generator with no `pull_request` at all withdraws nothing", () => {
    // The #923 failure mode wearing the other hat: an unscoped withdrawal is a
    // claim outliving its reason. A generated workflow that does not emit this
    // trigger is making no statement about the consumer's copy of it.
    const noPr = GENERATED.replace("  pull_request:\n", "");
    const { content, revoked } = merge(CONSUMER, noPr);
    expect(revoked, "a generator that is silent about the trigger still withdrew from it").toEqual([]);
    expect(onBlock(content), "the consumer's filter was dropped by a generator that never mentioned it").toMatch(
      /pull_request:\s*\n\s*branches:/,
    );
  });

  test("a path that is not named is not withdrawn", () => {
    expect(
      HARNESS_AUTHORED_PATHS.has("on.push.branches"),
      "`on.push.branches` is claimed, which contradicts the gates.yml comment: a push " +
        "filter asks which branches earn a run ON THEIR OWN, a different question",
    ).toBe(false);
    expect(
      [...HARNESS_AUTHORED_PATHS],
      "the claim set is empty, so every withdrawal case above is vacuous",
    ).toContain("on.pull_request.branches");
  });
});

// ── AC-4: the escape hatch still wins ────────────────────────────────────

describe("AC-4 (#1148): `ci.workflowOverrides` takes the whole key back", () => {
  test("naming `on` preserves the filter", () => {
    const { content, revoked } = merge(CONSUMER, GENERATED, ["on"]);
    expect(revoked, "a declined key had a sub-key withdrawn out from under it").toEqual([]);
    expect(
      onBlock(content),
      "the consumer declared `on` theirs and the harness took a filter out of it anyway — " +
        "deletion with no route back, which is what #839's hatch exists to make impossible",
    ).toMatch(/pull_request:\s*\n\s*branches:/);
  });
});

// ── AC-5: the laundering that makes VERIFIED the wrong discriminator ─────

describe("AC-5 (#1148): a hand-edited `on:` block becomes VERIFIED after one re-scaffold", () => {
  test("provenance goes UNPROVEN -> VERIFIED while the consumer's edit survives", () => {
    // The negative control for #1148's own proposal. If this is true, then
    // "regenerate the `on:` block when VERIFIED" deletes exactly the
    // customisation the issue's control demands be preserved — and the control
    // as worded cannot catch it, because a fresh hand-edit reads UNPROVEN.
    const dir = mkdtempSync(join(tmpdir(), "authored-paths-"));
    const file = join(dir, "ci.yml");
    // A filter under a trigger NOTHING claims, so this case measures the
    // marker and not the withdrawal above.
    const handEdited = CONSUMER.replace(
      "  pull_request:\n    branches:\n      - \"main\"\n",
      "  pull_request:\n    types:\n      - ready_for_review\n",
    );
    writeFileSync(file, handEdited);

    const provenanceOf = (): string => {
      const raw = readFileSync(file, "utf-8");
      return PROV.stamp(PROV.body(raw)) === raw ? "VERIFIED" : "UNPROVEN";
    };

    expect(provenanceOf(), "a hand-edited file already reads VERIFIED before any run").toBe("UNPROVEN");
    writeManagedFile(file, GENERATED, "ci.yml", [], {}, PROV);
    expect(
      provenanceOf(),
      "the re-stamp did not happen, so the laundering this case is about cannot occur " +
        "and #1148's premise may stand after all",
    ).toBe("VERIFIED");
    expect(
      onBlock(readFileSync(file, "utf-8")),
      "the consumer's hand-edit did not survive, so this is not the laundering case",
    ).toContain("ready_for_review");
  });
});

// ── AC-6 / AC-7: the write puts it on disk, once, and says what it did ───

describe("AC-6 (#1148): the write is not refused over lines the merge removed", () => {
  test("the re-scaffold lands and reports the withdrawal", () => {
    const dir = mkdtempSync(join(tmpdir(), "authored-write-"));
    const file = join(dir, "ci.yml");
    writeFileSync(file, CONSUMER);
    const actions: string[] = [];
    writeManagedFile(file, GENERATED, "ci.yml", actions, {}, PROV);

    const written = readFileSync(file, "utf-8");
    expect(
      onBlock(written),
      "the bytes on disk still carry the filter, so the merge was right and the write refused",
    ).not.toMatch(/pull_request:\s*\n\s*branches:/);

    const revokedLine = actions.find(a => a.startsWith("REVOKED:"));
    expect(revokedLine, `no withdrawal was reported — actions were: ${actions.join(" | ")}`).toBeDefined();
    // Assert the TEXT, not just that a line exists: #923's sentence names a
    // `ci` config entry that has nothing to do with a trigger filter, and a
    // correct-but-misdescribed withdrawal sends the reader to the wrong knob.
    expect(revokedLine, "the authored withdrawal is reported with #923's config-derived reason").not.toContain(
      "config no longer produces it",
    );
    expect(revokedLine, "the report does not name the path that was withdrawn").toContain("branches");
    expect(revokedLine, "the report does not name the escape hatch, so there is no route back").toContain(
      "ci.workflowOverrides",
    );
  });

  test("a second run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "authored-idem-"));
    const file = join(dir, "ci.yml");
    writeFileSync(file, CONSUMER);
    writeManagedFile(file, GENERATED, "ci.yml", [], {}, PROV);
    const afterFirst = readFileSync(file, "utf-8");

    const actions: string[] = [];
    writeManagedFile(file, GENERATED, "ci.yml", actions, {}, PROV);
    expect(readFileSync(file, "utf-8"), "the second run rewrote the file").toBe(afterFirst);
    expect(
      actions.filter(a => a.startsWith("REVOKED:")),
      "the withdrawal is re-reported every run for a filter that is already gone",
    ).toEqual([]);
  });
});
