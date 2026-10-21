/**
 * #915 — #722's census can tell a hand-edited generated workflow from an
 * untouched one, and no consumer check ever asked it.
 *
 * `lib/scaffold/workflow-census.ts` has classified every file in
 * `.github/workflows/` as `generated-and-unchanged`,
 * `generated-and-hand-edited` or `NOT-OWNED` since #722, and the
 * `# generated-sha:` stamp it reads is on disk in consumer repos today.
 * `lib/conformity.ts` exported fifteen `run*` functions — the consumer-facing
 * check surface — and none of them called it. So the detection existed, the
 * raw material existed, and the two were never connected: a hand-edit to a
 * stamped `ci.yml`, `gates.yml` or `ai-review.yml` was reverted by the next
 * `bunx rungate scaffold .` with nothing red at any point in the sequence.
 *
 * ## What this file is about, and what it deliberately is not
 *
 * Not the census. That is `test/workflow-census.test.ts` and it is unchanged.
 * This is about the VERDICT drawn from it, and the hard half of the verdict
 * is #917's `ci.workflowOverrides`: a top-level key a consumer has
 * deliberately taken back is left alone by every future scaffold, so an edit
 * inside it is not drift and a check calling it drift would be reporting the
 * supported escape hatch as a defect.
 *
 * The stamp digests the WHOLE body. It can say the bytes moved; it cannot say
 * where. So the three outcomes are DRIFTED (nothing in this file is the
 * consumer's — the edit WILL be reverted), UNMEASURED-with-keys-named (part
 * of this file is the consumer's and a whole-body digest cannot localise the
 * edit), and NOT-OWNED (passing, named). The middle one is the honest reading
 * and AC-4 is the case that pins it; a silent pass there would be
 * `.claude/rules/config-access.md`'s Silent Default Substitution with the
 * file on the consumer's side.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **When the check reds on a repo that uses `ci.workflowOverrides`, widen it
 * to skip drift entirely whenever the config declares any override.** One
 * line, the symptom goes away, and a project that took back `concurrency`
 * loses drift detection on all three of its workflows — including the
 * `$HOME` subtraction list in `ai-review.yml` that #877, #897, #907 and #913
 * each had to widen in turn.
 *
 * Does this file survive it? AC-5 is the case that does, non-vacuously: its
 * fixture declares an override for a key the file does not have, and asserts
 * the file is still DRIFTED. The global-skip repair turns it green, so AC-5
 * is red under that repair and stays pointed at the real gap. AC-4 alone
 * would not have been enough — it is green under the wrong fix, because
 * skipping and reporting-as-unmeasurable both mean "not drifted" to a case
 * that only reads `drifted`. AC-4 therefore also asserts the file is named in
 * `consumerOwned` with its key, which the global skip does not produce.
 *
 * ## The negative control
 *
 * AC-9 runs the shipped check over this repository and over the census
 * fixture the generator itself produces. A drift check that reds on
 * everything is as useless as one that reds on nothing, and the only way to
 * know which this is, is to point it at a tree that must stay green.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  WORKFLOW_OVERRIDE_COMMENT,
  mergeManagedWorkflow,
  overrideNoticeKeys,
  workflowOverrides,
} from "../lib/scaffold/managed-workflow";
import { stampWorkflow } from "../lib/scaffold/workflow-census";
import { workflowDrift, workflowDriftReport } from "../lib/scaffold/workflow-drift";

const REPO = join(import.meta.dir, "..");

/** A plausible generated workflow before the stamp goes on. */
const GENERATED = `name: CI
on:
  push:
    branches:
      - "main"

permissions:
  contents: read

jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;

/** A consumer's own workflow: no marker, so NOT-OWNED. */
const FOREIGN = `name: Nightly
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  sweep:
    runs-on: "ubuntu-latest"
    steps:
      - run: ./sweep.sh
`;

interface Plant {
  root: string;
  /** Write a workflow file verbatim. */
  put(name: string, text: string): void;
  /** Write a workflow file carrying a marker that describes its own body. */
  stamped(name: string, text: string): void;
  done(): void;
}

function plant(): Plant {
  const root = mkdtempSync(join(tmpdir(), "rg-915-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  return {
    root,
    put: (name, text) => writeFileSync(join(dir, name), text),
    stamped: (name, text) => writeFileSync(join(dir, name), stampWorkflow(text)),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("#915 AC-1: a stamped workflow nobody touched is clean, and says what it read", () => {
  test("AC-1: unchanged generated workflows produce no finding and a MEASURED reading", () => {
    const p = plant();
    try {
      p.stamped("ci.yml", GENERATED);
      p.stamped("gates.yml", GENERATED.replace("name: CI", "name: Gates"));
      const r = workflowDrift(p.root, []);

      expect(r.reading, r.unmeasuredReasons.join("\n")).toBe("MEASURED");
      expect(r.drifted).toEqual([]);
      expect(r.consumerOwned).toEqual([]);
      // #492: a verdict that does not state its own coverage cannot be told
      // from a complete one. `2 generated` is the half that makes AC-2's
      // reading distinguishable from this one.
      expect(r.coverage).toEqual({ read: 2, present: 2, generated: 2 });
      expect(workflowDriftReport(r)[0]).toContain("read 2/2 file(s), 2 generated");
    } finally {
      p.done();
    }
  });

  test("AC-1b: a consumer's own workflow passes, and is NAMED rather than counted", () => {
    const p = plant();
    try {
      p.stamped("ci.yml", GENERATED);
      p.put("nightly.yml", FOREIGN);
      const r = workflowDrift(p.root, []);

      expect(r.reading).toBe("MEASURED");
      expect(r.drifted).toEqual([]);
      expect(r.notOwned).toEqual(["nightly.yml"]);
      expect(workflowDriftReport(r).join("\n")).toContain("nightly.yml");
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-2: nothing to compare is UNMEASURED, not clean", () => {
  test("AC-2: a workflows directory with no generated file in it refuses", () => {
    const p = plant();
    try {
      // The #621 shape. Without this branch the reading below is byte-identical
      // to AC-1's: MEASURED, no drift, nothing to report — over a repo whose
      // generated CI is not there at all.
      p.put("nightly.yml", FOREIGN);
      const r = workflowDrift(p.root, []);

      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join("\n")).toContain("NO_GENERATED_WORKFLOW");
      expect(r.coverage.generated).toBe(0);
    } finally {
      p.done();
    }
  });

  test("AC-2b: an empty workflows directory refuses rather than agreeing vacuously", () => {
    const p = plant();
    try {
      const r = workflowDrift(p.root, []);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join("\n")).toContain("NO_WORKFLOW_FILES");
    } finally {
      p.done();
    }
  });

  test("AC-2c: an absent workflows directory carries the census's own reason", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-915-bare-"));
    try {
      const r = workflowDrift(root, []);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join("\n")).toContain("WORKFLOWS_DIR_ABSENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#915 AC-3: a hand-edited generated workflow is caught", () => {
  test("AC-3: the edit a re-scaffold would revert is reported, naming the file", () => {
    const p = plant();
    try {
      // Stamp the file, then move a byte. This is the whole of #915: the
      // census has always been able to see it and nothing asked.
      p.put("ai-review.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      const r = workflowDrift(p.root, []);

      expect(r.reading, r.unmeasuredReasons.join("\n")).toBe("MEASURED");
      expect(r.drifted.map(f => f.name)).toEqual(["ai-review.yml"]);
      expect(r.consumerOwned).toEqual([]);
      // The remedy is in the finding, not only in a rule file somebody has to
      // find. `.claude/rules/self-referential-tests.md`: say what to do.
      expect(r.drifted[0].detail).toContain("ci.workflowOverrides");
      expect(r.drifted[0].detail).toContain("rungate scaffold");
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-4: a key the consumer owns through ci.workflowOverrides is not drift", () => {
  test("AC-4: an override notice the real merge wrote is read back, and the file is not accused", () => {
    const p = plant();
    try {
      // Derived from the generator's own merge, not written as a literal. A
      // hand-written notice would assert that this module can parse a string
      // this test typed — the composer is not exported, so the round trip is
      // the only thing holding the two halves together.
      const consumer = GENERATED.replace('      - "main"', '      - "release"');
      const merged = mergeManagedWorkflow(consumer, GENERATED, ["on"]);
      expect(merged, "the merge wrote no override notice").toContain(WORKFLOW_OVERRIDE_COMMENT);
      expect(overrideNoticeKeys(merged), "the notice names no key this parser can see").toEqual(["on"]);

      // Stamped as the scaffold stamps it, then edited inside the key the
      // consumer owns. A re-scaffold declines `on:` outright, so this edit
      // survives — it is not drift, and must not be reported as drift.
      p.put("ci.yml", stampWorkflow(merged).replace("release", "release/*"));
      const r = workflowDrift(p.root, ["on"]);

      expect(r.drifted, "a key the consumer owns was reported as drift").toEqual([]);
      // …and not silently waved through either. The digest covers the whole
      // body, so "the edit was inside `on:`" is not something this reading
      // knows — it is UNMEASURED, with the key named.
      expect(r.reading).toBe("MEASURED");
      expect(r.consumerOwned.map(f => f.name)).toEqual(["ci.yml"]);
      expect(r.consumerOwned[0].detail).toContain("on");
      expect(r.consumerOwned[0].detail).toContain("UNMEASURED");
    } finally {
      p.done();
    }
  });

  test("AC-4b: the config alone is enough — a notice is not required", () => {
    const p = plant();
    try {
      // A consumer who added the key to `ci.workflowOverrides` and has not
      // re-scaffolded yet has no notice in the file. The config decides what
      // the NEXT scaffold declines, so it is the half that matters here.
      p.put("ci.yml", stampWorkflow(GENERATED).replace("contents: read", "contents: write"));
      const r = workflowDrift(p.root, ["permissions"]);

      expect(r.drifted).toEqual([]);
      expect(r.consumerOwned.map(f => f.name)).toEqual(["ci.yml"]);
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-5: the override reading is per-file, not a global switch", () => {
  test("AC-5: an override for a key this file does not declare leaves it DRIFTED", () => {
    const p = plant();
    try {
      // The file has `on:` and `permissions:` and no `concurrency:`. A project
      // that took back `concurrency` has said nothing about this file, so an
      // edit to it is still an edit a re-scaffold reverts.
      //
      // This is the case that survives the cheapest wrong fix — skipping drift
      // whenever any override is configured — because that repair turns it
      // green while leaving every generated workflow in the project unguarded.
      expect(GENERATED).not.toContain("concurrency");
      p.put("ci.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      const r = workflowDrift(p.root, ["concurrency"]);

      expect(r.consumerOwned, "an absent key was treated as owning the file").toEqual([]);
      expect(r.drifted.map(f => f.name)).toEqual(["ci.yml"]);
    } finally {
      p.done();
    }
  });

  test("AC-5b: one file owned does not excuse its neighbour", () => {
    const p = plant();
    try {
      const owned = mergeManagedWorkflow(
        GENERATED.replace('      - "main"', '      - "release"'),
        GENERATED,
        ["on"],
      );
      p.put("ci.yml", stampWorkflow(owned).replace("release", "release/*"));
      p.put("gates.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      const r = workflowDrift(p.root, ["on"]);

      // `gates.yml` has `on:` too, so it is unmeasurable for the same reason
      // `ci.yml` is — the point of this case is that the two files are judged
      // SEPARATELY, and a reading that collapsed them into one verdict would
      // report one name where there are two.
      expect(r.consumerOwned.map(f => f.name).sort()).toEqual(["ci.yml", "gates.yml"]);
      expect(r.drifted).toEqual([]);
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-6: ci.workflowOverrides reaches the check through the real config reader", () => {
  test("AC-6: `jobs` is refused here exactly as the merge refuses it", () => {
    // One binding, so there is one thing to mutate. A second reader inside
    // the conformity check would agree with this one on every input the suite
    // has (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    expect(workflowOverrides({ workflowOverrides: ["on", "jobs"] })).toEqual(["on"]);

    const p = plant();
    try {
      // A consumer naming `jobs` would otherwise freeze `test` and `gates`
      // behind an unmeasurable verdict — the drift check must not become the
      // second mechanism #839 refused to build.
      p.put("ci.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      const r = workflowDrift(p.root, workflowOverrides({ workflowOverrides: ["jobs"] }));
      expect(r.drifted.map(f => f.name)).toEqual(["ci.yml"]);
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-7: the conformity surface calls it, and consumers inherit it", () => {
  test("AC-7: lib/conformity.ts exports the check and generateConformityTest calls it", async () => {
    const conformity = await import("../lib/conformity");
    expect(typeof conformity.runWorkflowDriftValidation).toBe("function");

    // The template is what makes this reach a consumer at all. Without this
    // line the check exists in the published library and no scaffolded repo
    // ever runs it — which is #915 itself, one layer up.
    const { generateConformityTest } = await import("../lib/scaffold/steps");
    const template = generateConformityTest();
    expect(template).toContain("runWorkflowDriftValidation");
    expect(template).toContain("runWorkflowDriftValidation(ROOT);");
  });

  test("AC-7b: this repository's own conformity suite is the generated template", () => {
    // Asserted rather than assumed: the harness's copy IS the template's
    // output, so a check added to one and not the other is a check half the
    // fleet runs. The import specifier is the one documented difference.
    const mine = readFileSync(join(REPO, "test", "scaffold-conformity.test.ts"), "utf-8");
    expect(mine).toContain("runWorkflowDriftValidation(ROOT);");
    expect(mine.split("\n").filter(l => l.includes("runWorkflowDriftValidation"))).toHaveLength(2);
  });
});

describe("#915 AC-8: NOT-OWNED is reported without being refused", () => {
  test("AC-8: unowned workflows are named beside a drifted one, and only one fails", () => {
    const p = plant();
    try {
      p.put("ci.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      p.put("nightly.yml", FOREIGN);
      p.put("release.yml", FOREIGN.replace("Nightly", "Release"));
      const r = workflowDrift(p.root, []);

      expect(r.drifted.map(f => f.name)).toEqual(["ci.yml"]);
      expect(r.notOwned).toEqual(["nightly.yml", "release.yml"]);
      const report = workflowDriftReport(r).join("\n");
      expect(report).toContain("nightly.yml, release.yml");
      expect(report).toContain("not this check's business");
    } finally {
      p.done();
    }
  });
});

describe("#915 AC-10: the conformity check FAILS, rather than computing a verdict nobody reads", () => {
  /**
   * Spawned, not described. `workflowDrift(...).drifted.length === 1` proves
   * the reading can disagree; it does not prove the CASE fails, and a check
   * that composed a violation list and never asserted on it would pass either
   * way. That is the shape #621's counted case exists for, and it is exactly
   * the defect #915 reports one layer up — detection present, nothing asking.
   *
   * `ran` is read before any verdict: a `-t` filter that matches nothing
   * leaves bun reporting zero failures, which is indistinguishable from the
   * check passing and is also what a suite that failed to resolve its imports
   * looks like.
   */
  function runCheckOver(target: string): { ran: number; failed: number } {
    const dir = mkdtempSync(join(tmpdir(), "rg-915-spawn-"));
    const file = join(dir, "probe.test.ts");
    writeFileSync(
      file,
      `import { runWorkflowDriftValidation } from ${JSON.stringify(join(REPO, "lib", "conformity.ts"))};\n` +
        `runWorkflowDriftValidation(${JSON.stringify(target)});\n`,
    );
    try {
      const out = Bun.spawnSync(["bun", "test", file], { cwd: REPO, env: { ...process.env } });
      const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
      const pass = /^\s*(\d+) pass$/m.exec(text);
      const fail = /^\s*(\d+) fail$/m.exec(text);
      if (!pass || !fail) throw new Error(`the spawned run reported no counts:\n${text}`);
      return { ran: Number(pass[1]) + Number(fail[1]), failed: Number(fail[1]) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("AC-10: a drifted tree turns the conformity case RED", () => {
    const p = plant();
    try {
      p.put("ci.yml", stampWorkflow(GENERATED).replace("bun test", "bun test --bail"));
      const r = runCheckOver(p.root);
      expect(r.ran, "the spawned suite ran no case at all").toBe(1);
      expect(r.failed, "WORKFLOW-DRIFT-1 computed a verdict and asserted nothing on it").toBe(1);
    } finally {
      p.done();
    }
  }, 60_000);

  test("AC-10b: the control — a clean tree leaves it GREEN", () => {
    const p = plant();
    try {
      p.stamped("ci.yml", GENERATED);
      const r = runCheckOver(p.root);
      expect(r.ran, "the spawned suite ran no case at all").toBe(1);
      expect(r.failed, "a check that reds on a clean tree is a check nobody keeps").toBe(0);
    } finally {
      p.done();
    }
  }, 60_000);
});

describe("#915 AC-9: the negative control", () => {
  test("AC-9: this repository's generated workflows are clean under the shipped check", () => {
    // A check that reds on everything is as useless as one that reds on
    // nothing. This repo carries three stamped workflows and five the harness
    // did not write, which is the mixed shape a consumer has — and it must
    // come back MEASURED, zero drifted, with the five named.
    const r = workflowDrift(REPO, []);

    expect(r.reading, r.unmeasuredReasons.join("\n")).toBe("MEASURED");
    expect(r.drifted, workflowDriftReport(r).join("\n")).toEqual([]);
    expect(r.consumerOwned).toEqual([]);
    // Non-emptiness, not a count. The population is this repository's and
    // moves with other people's work (#507) — what a control has to establish
    // is that the scan READ something.
    expect(r.coverage.generated).toBeGreaterThan(0);
    expect(r.notOwned.length).toBeGreaterThan(0);
    expect(r.coverage.read).toBe(r.coverage.present);
  });
});
