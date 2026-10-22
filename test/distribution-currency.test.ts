/**
 * #875: the distribution check survives the bump that makes the symptom vanish.
 *
 * `test/published-artifact.test.ts` covers the content comparison and
 * `test/distribution-standing.test.ts` covers the version-string equality.
 * Neither covers the thing this file is about, and it is the thing #875 was
 * reopened for: **the cheapest repair for a red distribution check is to bump
 * `package.json`**, and under `lib/published-artifact.ts`'s classification that
 * repair works — `DIVERGED` becomes `AHEAD` and `artifactViolations` returns
 * `[]` — while the published tree stays exactly as stale as it was.
 *
 * That is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`:
 * a case that goes green under the WRONG fix. The answer here is not a wider
 * assertion but a different INPUT — `currencyRefusal` reads only file counts
 * and commit distance, none of which a bump touches.
 *
 * ## The pair varies exactly one thing
 *
 * `the bump clears the label` and `the bump does not clear the refusal` are
 * driven from ONE `ContentDifference` and differ only in the tree's version
 * string, so what the pair measures is the bump and nothing else (#585). A
 * pair whose halves differ in two places measures neither.
 *
 * ## The live case asserts the reading was TAKEN, not that it passed
 *
 * The tree is `STALE` today and clearing it needs a release, which is not an
 * agent's call. A case asserting `STALE` would go red the day Jason publishes,
 * which is the inverse defect — a check that reddens on the fix. So the live
 * case asserts the script's exit code AGREES with an independently-taken
 * reading, which is true either side of a release and false for a script that
 * stopped refusing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DISTRIBUTION_STALE_EXIT,
  currencyHeadline,
  currencyRefusal,
  currencyReportLines,
  distributionCurrency,
  type DistributionCurrency,
} from "../lib/distribution-currency";
import {
  artifactStanding,
  artifactViolations,
  measureArtifactStanding,
  STANDING_CAUSE_HEADLINE,
  standingCauses,
  type ArtifactStanding,
  type ContentDifference,
  type RunCommand,
} from "../lib/published-artifact";
import { publishedVersion } from "../lib/distribution-standing";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "check-distribution-currency.ts");
const MODULE = join(ROOT, "lib", "distribution-currency.ts");
const scratch: string[] = [];

const run: RunCommand = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** One difference, reused by both halves of the bump pair. */
const DIFFERENCE: ContentDifference = {
  onlyLocal: ["lib/new-thing.ts", "lib/other.ts"],
  onlyPublished: [],
  differing: ["lib/conformity.ts"],
  localCount: 200,
  publishedCount: 198,
};

function standingAt(treeVersion: string): ArtifactStanding {
  return artifactStanding({
    treeVersion,
    publishedVersion: "0.6.0",
    difference: DIFFERENCE,
    commitsAhead: 183,
  });
}

describe("#875: the version bump that makes the symptom vanish", () => {
  test("the bump clears the LABEL — this is the wrong fix, measured", () => {
    // The control. Without it, the case below is asserting that something
    // stayed the same across a change that may have done nothing at all.
    expect(standingAt("0.6.0").reading).toBe("DIVERGED");
    expect(artifactViolations(standingAt("0.6.0"))).toHaveLength(1);

    expect(standingAt("0.7.0").reading).toBe("AHEAD");
    expect(artifactViolations(standingAt("0.7.0"))).toEqual([]);
  });

  test("the bump does not clear the REFUSAL, and moves no number in it", () => {
    const before = distributionCurrency(standingAt("0.6.0"));
    const after = distributionCurrency(standingAt("0.7.0"));

    expect(before.reading).toBe("STALE");
    expect(after.reading).toBe("STALE");
    expect(currencyRefusal(before)).not.toBeNull();
    expect(currencyRefusal(after)).not.toBeNull();

    // Equality of the whole reading, not of a count: a count is the proxy and
    // the membership is the property (#532). Two readings that agree on
    // `staleFiles.length` while naming different files would pass a count.
    expect(after).toEqual(before);
    expect(currencyReportLines(after)).toEqual(currencyReportLines(before));
  });

  test("no version string is an input to the refusal at all", () => {
    // The stronger form of the pair: not merely that 0.6.0 and 0.7.0 agree,
    // but that a version BELOW the published one agrees too. `BEHIND` is the
    // third thing the label comparison can say and the consumer's question
    // does not have a third answer.
    expect(standingAt("0.5.0").reading).toBe("BEHIND");
    expect(artifactViolations(standingAt("0.5.0"))).toEqual([]);
    expect(distributionCurrency(standingAt("0.5.0"))).toEqual(
      distributionCurrency(standingAt("0.6.0")),
    );
  });
});

describe("#875: currencyRefusal and artifactViolations are not one decider", () => {
  test("an input on which exactly one of them refuses", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape: two guards
    // answering the same question about the same input are behaviourally one,
    // and no behavioural test can tell them apart. This names the input on
    // which they differ, so a mutation of either is visible.
    const s = standingAt("0.7.0");
    expect(artifactViolations(s)).toEqual([]);
    expect(currencyRefusal(distributionCurrency(s))).toContain("STALE");
  });

  test("and an input on which exactly the other one refuses", () => {
    // The mirror: identical content under one version string. The label is
    // honest and so is the distribution, so both allow — but swap the content
    // for a differing one and only `artifactViolations` has anything to say
    // about the label. Asserted as the pair that varies only the content.
    const identical: ContentDifference = {
      onlyLocal: [],
      onlyPublished: [],
      differing: [],
      localCount: 198,
      publishedCount: 198,
    };
    const clean = artifactStanding({
      treeVersion: "0.6.0",
      publishedVersion: "0.6.0",
      difference: identical,
      commitsAhead: 0,
    });
    expect(clean.reading).toBe("MATCHED");
    expect(artifactViolations(clean)).toEqual([]);
    const c = distributionCurrency(clean);
    expect(c.reading).toBe("CURRENT");
    expect(currencyRefusal(c)).toBeNull();
  });
});

describe("#875: a reading nobody took refuses, and never skips", () => {
  const unmeasured: ArtifactStanding = artifactStanding({
    treeVersion: "0.6.0",
    publishedVersion: null,
    difference: null,
    unmeasured: [
      { cause: "REGISTRY", text: "registry: could not reach https://registry.npmjs.org" },
    ],
  });

  test("an unreachable registry is UNMEASURED, not CURRENT", () => {
    const c = distributionCurrency(unmeasured);
    expect(c.reading).toBe("UNMEASURED");
    expect(currencyRefusal(c)).toContain("UNMEASURED");
    expect(currencyRefusal(c)).toContain("could not reach");
  });

  test("a standing that reports no reason still carries one", () => {
    // A refusal whose body is an empty join reads as a refusal nobody can act
    // on. `0`, `{}`, `null` and `SKIP` are indistinguishable from success and
    // so is an empty sentence (.claude/rules/config-access.md).
    const c = distributionCurrency({
      ...unmeasured,
      reading: "MATCHED",
      difference: null,
      unmeasured: [],
      unmeasuredReasons: [],
    });
    expect(c.reading).toBe("UNMEASURED");
    expect(currencyRefusal(c)).toContain("the content comparison was not performed");
    // …and it names a condition too, rather than an empty headline (#1117).
    expect(c.causes).toEqual(["UNCLASSIFIED"]);
  });
});

describe("#1117: the refusal says which condition produced it", () => {
  const transport = distributionCurrency(
    artifactStanding({
      treeVersion: "0.7.0",
      publishedVersion: null,
      difference: null,
      unmeasured: [{ cause: "REGISTRY", text: "registry: registry returned 503 for rungate" }],
    }),
  );
  const content = distributionCurrency(standingAt("0.6.0"));

  test("a transport failure and a content divergence refuse with different sentences", () => {
    expect(transport.reading).toBe("UNMEASURED");
    expect(content.reading).toBe("STALE");
    expect(transport.causes).toEqual(["REGISTRY"]);
    expect(content.causes).toEqual(["CONTENT"]);
    expect(currencyHeadline(transport)).not.toBe(currencyHeadline(content));
    // Both still refuse, and each refusal carries its own sentence.
    expect(currencyRefusal(transport)).toContain(currencyHeadline(transport));
    expect(currencyRefusal(content)).toContain(currencyHeadline(content));
    expect(currencyReportLines(content).join("\n")).toContain("CONTENT");
  });

  test("the input on which the two cause readings disagree, named", () => {
    // `standingCauses` and this module's own selector are not one decider
    // wearing two hats, and the distinguishing input is the one this module's
    // header already names: a tree at 0.7.0 against a published 0.6.0 whose
    // content differs. The standing is AHEAD with no condition at all — no
    // label is lying — and the currency is STALE with CONTENT, because a
    // consumer still cannot obtain this tree.
    const bumped = standingAt("0.7.0");
    expect(bumped.reading).toBe("AHEAD");
    expect(standingCauses(bumped)).toEqual([]);
    expect(artifactViolations(bumped)).toEqual([]);

    const c = distributionCurrency(bumped);
    expect(c.reading).toBe("STALE");
    expect(c.causes).toEqual(["CONTENT"]);
    expect(currencyRefusal(c)).not.toBeNull();
    // The sentences come from ONE table, so the two readings cannot drift
    // apart in wording while agreeing about the condition.
    expect(currencyHeadline(c)).toBe(STANDING_CAUSE_HEADLINE.CONTENT);
  });
});

describe("#875: the refusal is the script's only exit, and it is removable", () => {
  test("DISTRIBUTION_STALE_EXIT is the single non-zero exit in the script", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // A later branch that inlines `process.exit(1)` bypasses the mutant below
    // and the case goes green having witnessed nothing.
    const exits = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map(m => m[1]);
    expect(exits).toEqual(["DISTRIBUTION_STALE_EXIT"]);
    expect(DISTRIBUTION_STALE_EXIT).not.toBe(0);
  });

  test("the constant is declared exactly once in the module", () => {
    const src = readFileSync(MODULE, "utf-8");
    const declarations = [...src.matchAll(/export const DISTRIBUTION_STALE_EXIT\b/g)];
    expect(declarations).toHaveLength(1);
  });
});

describe("#875: the live tree, and the script that reports it", () => {
  let live: DistributionCurrency;
  let real: { status: number | null; stdout: string; stderr: string };
  let mutant: { status: number | null; stdout: string; stderr: string };

  beforeAll(async () => {
    const standing = await measureArtifactStanding({
      pkg: "rungate",
      root: ROOT,
      run,
      latestVersion: publishedVersion,
    });
    live = distributionCurrency(standing);

    const r = spawnSync("bun", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    real = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };

    // The mutant: the same script with the one exit constant set to zero. The
    // module is copied with `DISTRIBUTION_STALE_EXIT = 0` and the script is
    // copied with its two relative imports rewritten to absolute paths, so the
    // mutant cannot die on module resolution — a death would exit non-zero,
    // which reads as the mutation having been rejected on the merits.
    const dir = mkdtempSync(join(tmpdir(), "rungate-875-mutant-"));
    scratch.push(dir);
    const modSrc = readFileSync(MODULE, "utf-8").replace(
      "export const DISTRIBUTION_STALE_EXIT = 1;",
      "export const DISTRIBUTION_STALE_EXIT = 0;",
    );
    if (!modSrc.includes("DISTRIBUTION_STALE_EXIT = 0")) {
      throw new Error("could not build the mutant: the exit constant was not found");
    }
    const mutantModule = join(dir, "distribution-currency.ts");
    writeFileSync(
      mutantModule,
      modSrc.replace('from "./published-artifact"', `from ${JSON.stringify(join(ROOT, "lib", "published-artifact"))}`),
    );
    const scriptSrc = readFileSync(SCRIPT, "utf-8")
      .replace('from "../lib/distribution-currency"', `from ${JSON.stringify(mutantModule)}`)
      .replace('from "../lib/published-artifact"', `from ${JSON.stringify(join(ROOT, "lib", "published-artifact"))}`)
      .replace('from "../lib/distribution-standing"', `from ${JSON.stringify(join(ROOT, "lib", "distribution-standing"))}`);
    if (scriptSrc.includes('from "../lib/')) {
      throw new Error("could not build the mutant: a relative import was left unrewritten");
    }
    const mutantScript = join(dir, "check-distribution-currency.ts");
    writeFileSync(mutantScript, scriptSrc);
    const m = spawnSync("bun", [mutantScript, "--project-root", ROOT], { cwd: ROOT, encoding: "utf8" });
    mutant = { status: m.status, stdout: m.stdout ?? "", stderr: m.stderr ?? "" };
  }, 180_000);

  test("the live reading was TAKEN — a registry nobody could reach reds here", () => {
    // The instrument control. It asserts a reading happened, not that it
    // passed: with the registry blocked this is UNMEASURED and the case fails.
    // A skip would have been a green over a tree nobody looked at.
    expect(
      live.reading,
      `${currencyHeadline(live)}\nnothing was compared: ${live.unmeasuredReasons.join("; ")}`,
    ).not.toBe("UNMEASURED");
    expect(live.commitsAhead).not.toBeNull();
  });

  test("the script's exit code agrees with the reading, either side of a release", () => {
    // Deliberately not `expect(real.status).toBe(1)`. The tree is STALE today
    // and only a release clears it; pinning the suite to that would make the
    // fix turn this red. What is asserted is the AGREEMENT, which is false for
    // a script that stopped refusing and true whatever the tree is doing.
    console.log(
      `#875 ${currencyReportLines(live).join("\n#875 ")}\n#875 real exit=${real.status} mutant exit=${mutant.status}` +
        (currencyRefusal(live) ? `\n#875   ${currencyRefusal(live)}` : ""),
    );
    expect(real.stdout, real.stderr.slice(0, 400)).toContain("distribution currency:");
    expect(real.status).toBe(currencyRefusal(live) === null ? 0 : DISTRIBUTION_STALE_EXIT);
  });

  test("zeroing the exit constant removes the refusal — the negative control", () => {
    // The removal of the non-zero exit, performed and observed. It is only
    // informative while the live tree is STALE, which it is; if a release has
    // landed, both exit 0 and the synthetic cases above carry the proof.
    expect(mutant.stdout, mutant.stderr.slice(0, 400)).toContain("distribution currency:");
    expect(mutant.status).toBe(0);
    if (currencyRefusal(live) !== null) {
      expect(real.status).not.toBe(mutant.status);
    }
  });
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
