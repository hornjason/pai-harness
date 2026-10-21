/**
 * Covers #834 — a re-scaffold of an existing consumer that has since declared
 * `ci.vertex` must receive the `id-token: write` the federation needs.
 *
 * ## Why this is the WRITE's file and not the merge's
 *
 * #839's sub-key merge (`mergeTopLevelSection`) already computes the right
 * `permissions:` block: `id-token` is a generated sub-key the consumer does
 * not have, so it is added, and a grant the consumer added for a job of their
 * own keeps the consumer's value. Measured on `bf9e6b83` — the commit this
 * change is built on, with #839 already in it — and the permission still did
 * not arrive:
 *
 * | tree | generated `permissions:` |
 * |---|---|
 * | fresh project, config carries `ci.vertex`, no existing workflow | `contents: read` **+ `id-token: write`** |
 * | the same project re-scaffolded after adding `ci.vertex` | `contents: read` only |
 *
 * ```
 * REFUSED: .github/workflows/ai-review.yml: 3 line(s) the harness did not
 * author would be dropped from content outside any job: "#        set
 * `ci.vertex` in `.claude/rungate/config.json` to authenticate on", ...
 * ```
 *
 * Those three lines are the harness's OWN "no credential is configured"
 * paragraph — the paragraph the new header, the one saying a federation now
 * exists, is there to replace. `mergeManagedWorkflow` declares the preamble
 * the one part of the file the harness authors; `resolveManagedWrite`'s loss
 * set whitelisted only the banner LINE. Two deciders about the same bytes,
 * and the merge was the one that was right: it computed the correct file and
 * the write declined to put it on disk.
 *
 * So the merge is #839's and stays #839's. What is fixed here is the refusal
 * standing in front of it, and these cases are the standing guarantee that
 * #834's acceptance list keeps holding through whatever either side becomes.
 *
 * ## Why every case drives the real scaffold twice
 *
 * The cheapest wrong fix, named in the issue and already live in one consumer,
 * is to hand-add `id-token: write` to the consumer's `ai-review.yml`. A case
 * that started from a file already carrying the grant would go green under
 * that hand-edit and certify the regression it exists to block
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fifth shape). Nothing below
 * hand-writes `id-token:` into the before-state. The before-state is whatever
 * the generator itself produced for a consumer with no federation, and the
 * only thing that changes between the two runs is the consumer's config.
 *
 * ## Mutation battery, re-run on this base
 *
 * Over this file plus `workflow-top-level-merge`, `workflow-version-skew`,
 * `managed-workflow-key-order`, `scaffold-ci-preservation`, `ci-shard`,
 * `ai-review-wif` and `workflow-provenance-merge` — **107 cases**, green
 * unmutated, source restored after each.
 *
 * | mutation | red | the input on which original and mutant differ |
 * |---|---|---|
 * | M1 `managedPreamble` narrowed back to the banner LINE, which is what it was | **3 of 107** | a consumer that just declared `ci.vertex`: the original writes the merged file, the mutant REFUSES the whole re-scaffold over the harness's own header |
 * | M2 `managedPreamble` widened to the whole head section, banner or no banner | **1 of 107** | a consumer with a header comment of their own ABOVE the banner: the original still refuses, the mutant deletes it silently |
 * | M3 `managedPreamble` returns nothing at all | **3 of 107** | the M1 input — the narrowing and the emptying are one edit apart, so both are run |
 * | M4 the preamble is excluded from `lostLines` but not from `overwrittenLines` | **1 of 107** | the M1 input: the file lands either way, and the mutant reports the replaced header as lines "overwritten in harness-owned jobs" |
 * | M5 #839's `mergeTopLevelSection` returns the consumer's section unchanged | **13 of 107** | the M1 input: with the refusal lifted, that merge is the only thing that puts `id-token` in the file |
 * | M6 `MANAGED_BANNER_PREFIX` given a second spelling in `steps.ts` | **0 of 107** — see below, and **3 of 11** in the `#926` block | nothing, at the time |
 *
 * M5 is the control for the division of labour this file claims: the headline
 * case goes red if EITHER the write stops allowing the merge through or the
 * merge stops computing the grant, so neither half can quietly stop working
 * while the other holds the case up.
 *
 * **M6 found a decider no case could reach, and recording it is what got it
 * reached.** The reasoning at the time: a banner line is always in the
 * preamble of a generated workflow, `resolveManagedWrite` refuses anything
 * that does not parse as one, so `harnessPreamble` covers every line the
 * banner entry in `HARNESS_BOOKKEEPING_PREFIXES` covers and nothing can tell
 * the two apart.
 *
 * The first half of that is right and the conclusion is too strong, which
 * #926 measured. `harnessPreamble` is built from `managedPreamble`, and that
 * reads the HEAD section only — it returns `[]` when the banner is not in it.
 * A bookkeeping line beside the job key it introduces is in no head section,
 * reaches the loss set uncovered, and the entry is the only thing that keeps
 * the write from refusing over it. The battery missed it because every input
 * in these 107 cases put the banner where the generator puts it.
 *
 * So M6 is **3 of 11** now, in the `#926` block at the foot of this file, and
 * the 0 was worth recording for exactly the reason given then: a count of 0
 * is a fact about the tree, and an unexplained one invites the next reader to
 * trust a guard that cannot fail. What it also did was make the gap findable.
 *
 * The constant is still imported rather than respelled, so there is one
 * spelling of it either way — which is the defect M6 was actually probing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows, HARNESS_BOOKKEEPING_PREFIXES, resolveManagedWrite } from "../lib/scaffold/steps";
import { AI_REVIEW_WORKFLOW_FILE } from "../lib/scaffold/ai-review-step";
import {
  MANAGED_BANNER_PREFIX,
  WORKFLOW_OVERRIDE_COMMENT,
  managedPreamble,
  topLevelKeyOrder,
} from "../lib/scaffold/managed-workflow";

/** A project id and a provider path that belong to nobody. */
const VERTEX = {
  project: "fixture-vertex-project",
  workloadIdentityProvider:
    "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
  region: "us-fixture1",
  model: "claude-sonnet-5",
};

const BASE_CI = { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: ["main"] };

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** Write the consumer's config. */
function setCi(root: string, ci: Record<string, unknown>): void {
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "perm-merge-fixture", ci }, null, 2) + "\n",
  );
}

/**
 * A consumer scaffolded once, from the config it had at the time.
 *
 * The actions are kept, because a refusal is RECORDED rather than thrown —
 * `createCiWorkflows` catches it so one unpreservable workflow does not
 * abandon the rest of the scaffold. A case that read only the file on disk
 * could not tell "the harness wrote `contents: read`" from "the harness wrote
 * nothing and this is last run's file", which is exactly the state #834 was
 * in.
 */
function scaffolded(ci: Record<string, unknown>): { root: string; actions: string[] } {
  const root = mkdtempSync(join(tmpdir(), "perm-merge-"));
  scratch.push(root);
  setCi(root, ci);
  const actions: string[] = [];
  createCiWorkflows(root, actions);
  return { root, actions };
}

/** Change the config and re-scaffold OVER the file the first run left. */
function rescaffoldWith(root: string, ci: Record<string, unknown>): string[] {
  setCi(root, ci);
  const actions: string[] = [];
  createCiWorkflows(root, actions);
  return actions;
}

const aiReviewPath = (root: string) => join(root, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
const aiReviewText = (root: string) => readFileSync(aiReviewPath(root), "utf-8");

/** The refusals a scaffold recorded for the ai-review workflow, if any. */
const refusals = (actions: string[]) =>
  actions.filter(a => a.startsWith("REFUSED:") && a.includes(AI_REVIEW_WORKFLOW_FILE));

/**
 * The job's effective top-level permissions, parsed rather than grepped.
 *
 * A regex over the text would go green on a `permissions:` key that YAML reads
 * as something else — a duplicate further down the file is exactly the failure
 * #482 shipped — so the reading is the parser's.
 */
function permissionsOf(root: string): Record<string, string> {
  const doc = Bun.YAML.parse(aiReviewText(root)) as any;
  expect(doc?.permissions, "the generated ai-review.yml declares no top-level permissions").toBeTruthy();
  return doc.permissions as Record<string, string>;
}

describe("#834: a re-scaffold delivers the permissions its config implies", () => {
  /** The headline. A consumer that existed before it federated. */
  test("a consumer with an existing ai-review.yml that adds ci.vertex receives id-token: write", () => {
    const { root } = scaffolded({ ...BASE_CI });
    expect(
      permissionsOf(root)["id-token"],
      "the before-state already carried id-token: write, so this case cannot " +
        "tell the fix from the hand-edit the issue names as the wrong fix",
    ).toBeUndefined();

    const actions = rescaffoldWith(root, { ...BASE_CI, vertex: VERTEX });

    expect(refusals(actions), "the write refused, so nothing the merge computed reached disk").toEqual([]);
    expect(
      permissionsOf(root)["id-token"],
      "re-scaffolding a consumer that just declared ci.vertex left the job " +
        "unable to mint the OIDC token the federation exchanges",
    ).toBe("write");
  });

  /**
   * The create path, which has always passed — kept as the control the
   * headline case is measured against. Without it, "the update path grants
   * it" is a claim about one tree rather than about the two agreeing.
   */
  test("the create path and the update path agree on the same config", () => {
    const fresh = scaffolded({ ...BASE_CI, vertex: VERTEX });
    const updated = scaffolded({ ...BASE_CI });
    rescaffoldWith(updated.root, { ...BASE_CI, vertex: VERTEX });

    expect(permissionsOf(updated.root)).toEqual(permissionsOf(fresh.root));
  });

  /** The #631 asymmetry: a permission nobody consumes is a permission nobody audits. */
  test("a consumer that never declared ci.vertex is still not granted id-token: write", () => {
    const { root } = scaffolded({ ...BASE_CI });
    rescaffoldWith(root, { ...BASE_CI, branches: ["main", "develop"] });

    expect(
      permissionsOf(root)["id-token"],
      "a consumer with no federation was granted a permission nothing consumes",
    ).toBeUndefined();
    expect(permissionsOf(root).contents).toBe("read");
  });
});

describe("#834: the write lets the merge through without widening what it owns", () => {
  /**
   * The control for the direction this fix can go wrong. The refusal is the
   * only thing standing between a consumer's own header comment and silent
   * deletion — `mergeManagedWorkflow` replaces the whole preamble — so the
   * whitelist has to start AT the banner and not at line one.
   */
  test("a consumer's own comment above the banner still refuses the write", () => {
    const { root } = scaffolded({ ...BASE_CI });
    writeFileSync(aiReviewPath(root), `# our fleet tags every workflow\n${aiReviewText(root)}`);

    const actions = rescaffoldWith(root, { ...BASE_CI, vertex: VERTEX });

    expect(
      refusals(actions).join("\n"),
      "a consumer line above the managed banner was dropped without a refusal",
    ).toContain("# our fleet tags every workflow");
    expect(aiReviewText(root), "and the line itself is still on disk").toContain(
      "# our fleet tags every workflow",
    );
  });

  /**
   * Rewording its own header is not overwriting somebody's edit. The report
   * this feeds says "overwrote N edited line(s) in harness-owned jobs", and
   * the preamble is not a job — a consumer reading that count would go
   * looking for an edit of theirs that never existed.
   */
  test("regenerating the header is not reported as overwriting a consumer's edit", () => {
    const { root } = scaffolded({ ...BASE_CI });
    // Read BEFORE the second run, because the second run replaces it. The
    // lines are taken from the file rather than written as literals: a
    // fixture copy of the header would stop being the header the moment the
    // generator's prose changed, and go green by matching nothing.
    const preamble = managedPreamble(aiReviewText(root)).map(l => l.trim()).filter(l => l !== "");
    expect(preamble.length, "no managed preamble was found, so this case is vacuous").toBeGreaterThan(3);

    const actions = rescaffoldWith(root, { ...BASE_CI, vertex: VERTEX });

    const write = actions.find(a => a.includes(AI_REVIEW_WORKFLOW_FILE) && !a.startsWith("UNMEASURED"));
    expect(write, "no write was reported at all, so there is nothing to read").toBeDefined();
    // Lines inside the harness's own ai-review job ARE overwritten here and
    // saying so is correct. What must not appear is a line of the header.
    //
    // The quoted samples are compared EXACTLY rather than by substring: the
    // header's blank `#` separator lines are a substring of almost anything,
    // and matching those reported six hits that meant nothing. The report
    // shows at most two samples, so this reads what a consumer reads and no
    // more — M4 in the battery above is what shows it can go red.
    const samples = [...write!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`).trim());
    const inPreamble = new Set(preamble);
    const named = samples.filter(l => inPreamble.has(l));
    expect(
      named,
      "the harness reported its own replaced header as consumer lines it overwrote, " +
        `in a message that says "in harness-owned jobs" — the preamble is not a job`,
    ).toEqual([]);
  });

  /** #482 does not regress: the consumer's layout is still the consumer's. */
  test("a consumer's unrelated top-level keys keep their own order", () => {
    const { root } = scaffolded({ ...BASE_CI });
    writeFileSync(
      aiReviewPath(root),
      aiReviewText(root).replace(
        /^permissions:\n/m,
        "# cancel superseded review runs\nconcurrency:\n  group: ai-review-${{ github.ref }}\n  cancel-in-progress: true\n\npermissions:\n",
      ),
    );
    const before = topLevelKeyOrder(aiReviewText(root));

    rescaffoldWith(root, { ...BASE_CI, vertex: VERTEX });

    const after = aiReviewText(root);
    expect(topLevelKeyOrder(after), "the merge reordered the consumer's top-level keys").toEqual(before);
    expect(after, "the comment introducing the consumer's key was left behind").toContain(
      "# cancel superseded review runs\nconcurrency:",
    );
  });
});

// ── #926 ───────────────────────────────────────────────────────────────────

/**
 * Every entry in `HARNESS_BOOKKEEPING_PREFIXES` must be able to decide
 * something (#926).
 *
 * M6 above turned 0 of 107 and the conclusion drawn from it was too strong:
 * that `harnessPreamble` had subsumed the banner entry outright and nothing
 * could tell the two apart. It subsumes it in the LEADING PREAMBLE. It does
 * not subsume it anywhere else, because `managedPreamble` reads the head
 * section and returns `[]` when the banner is not in it — so a bookkeeping
 * line beside the job key it introduces, which is where #839's override
 * notice actually lives, reaches the loss set with nothing above covering it.
 *
 * ## The shape, and why it is not an assertion about the strings
 *
 * Asserting that the array contains two particular sentences would pass
 * vacuously the moment anyone rewords a banner, which is the one thing these
 * prefixes exist to tolerate. So each case plants a line at a position, runs
 * `resolveManagedWrite`, and runs the SAME position again with a line no
 * generator emits. The only difference between the two inputs is whether the
 * planted line is one of the harness's bookkeeping lines, so a difference in
 * outcome can only be the prefix list deciding. The second half is the
 * negative control: it is what stops the case going green on a position the
 * loss set never reaches.
 *
 * ## Where the planted lines come from, which is the whole trick
 *
 * They come from `managed-workflow.ts` — the module that EMITS these lines —
 * and NOT from `HARNESS_BOOKKEEPING_PREFIXES`, the list under test.
 *
 * This was written the other way round first and it was worth the detour.
 * Generating the planted line from the list means the mutant plants the
 * MUTANT's spelling, the two match each other, and M6 stays green at 0. A
 * test that reads its fixture out of the thing it is testing cannot see that
 * thing drift, and drift between two spellings is exactly the defect M6
 * probes. Sourcing from the emitting module is what gives the two deciders
 * something to disagree about.
 *
 * `WITNESSED` below is therefore the population, and `the list carries no
 * entry without a witness` is the ratchet that keeps it one: an entry added
 * to `HARNESS_BOOKKEEPING_PREFIXES` with no row here is red, so the next
 * entry cannot arrive dead the way this one did.
 *
 * ## Mutation, measured over this file
 *
 * 11 cases, green unmutated, source restored after each and green again. The
 * rows name the assertions rather than only counting them — a count that is
 * right about the wrong assertion is not coverage.
 *
 * | mutation | red | the assertions that go red |
 * |---|---|---|
 * | M6 `MANAGED_BANNER_PREFIX` given a second spelling here — `["# Managed by Rungate", WORKFLOW_OVERRIDE_COMMENT]` | **3 of 11** | `the list carries no entry without a witness`; `the managed banner — … does not make the write refuse`; `the managed banner — … not reported as a consumer edit …` |
 * | M7 the bookkeeping subtraction dropped from `overwrittenLines` (the filter term replaced by `true`) | **2 of 11** | `… not reported as a consumer edit the harness overwrote`, BOTH rows |
 * | M8 the banner entry deleted from the list outright | **3 of 11** | the same three as M6 |
 * | M9 the `harnessOwned` bookkeeping loop disabled | **2 of 11** | `… does not make the write refuse`, BOTH rows |
 *
 * M6 is the row this block exists for: it was **0 of 107** before. M7 and M9
 * separate the two decision sites — the list is read twice in
 * `resolveManagedWrite` and each read now has its own witness, so neither can
 * go dead behind the other. M8 is the control for the ratchet: deleting an
 * entry is caught, which is what keeps "make the gap go away" from being the
 * cheapest green.
 */
describe("#926: every harness bookkeeping prefix is load-bearing somewhere", () => {
  /**
   * The real generated `ai-review.yml`, used as BOTH sides of the write.
   *
   * Taken from the generator rather than pasted, and the existing side is the
   * generated side plus exactly one planted line. That is what makes the
   * comparison clean: nothing else differs, so nothing else can explain a
   * difference in the result.
   */
  let GENERATED = "";
  beforeAll(() => {
    const { root } = scaffolded({ ...BASE_CI });
    GENERATED = aiReviewText(root);
  });

  /**
   * The bookkeeping lines the harness emits, each with the witness below.
   *
   * Imported from `managed-workflow.ts`, the module that writes them —
   * deliberately NOT read out of `HARNESS_BOOKKEEPING_PREFIXES`. See the
   * docblock: a fixture taken from the list under test cannot see that list
   * drift away from the lines the generator actually puts in the file.
   */
  const WITNESSED: ReadonlyArray<{ prefix: string; what: string }> = [
    { prefix: MANAGED_BANNER_PREFIX, what: "the managed banner" },
    { prefix: WORKFLOW_OVERRIDE_COMMENT, what: "#839's override notice" },
  ];

  /** A tail no generator writes, so the planted line is always dropped. */
  const TAIL = " — a tail this generator does not write";
  /** The control line. Same position, same tail, no bookkeeping prefix. */
  const UNOWNED = `# a comment no rungate generator emits${TAIL}`;

  /**
   * The ratchet. `HARNESS_BOOKKEEPING_PREFIXES` may not carry an entry that
   * no case below exercises — which is both how the next entry is stopped
   * from arriving dead, and how a respelling of an existing one is caught.
   */
  test("the list carries no entry without a witness", () => {
    const fix =
      "every entry in HARNESS_BOOKKEEPING_PREFIXES (lib/scaffold/steps.ts) needs a " +
      "row in WITNESSED here, so the cases below exercise it. An entry with no row " +
      "is an entry nothing asserts — add the row, or drop the entry.";
    expect(
      HARNESS_BOOKKEEPING_PREFIXES.filter(p => !WITNESSED.some(w => w.prefix === p)),
      `unwitnessed bookkeeping prefix. ${fix}`,
    ).toEqual([]);
    expect(
      WITNESSED.filter(w => !HARNESS_BOOKKEEPING_PREFIXES.includes(w.prefix)).map(w => w.what),
      "a witnessed line is no longer in the list, so these cases now prove nothing " +
        `about the harness. ${fix}`,
    ).toEqual([]);
  });

  /** Beside the job key it introduces — where the override notice sits, and NOT in the head section. */
  function besideTheJobKey(line: string): string {
    const lines = GENERATED.split("\n");
    const at = lines.findIndex(l => /^jobs:/.test(l));
    expect(at, "the generated ai-review.yml has no top-level `jobs:` key, so this case is vacuous").toBeGreaterThan(-1);
    lines.splice(at + 1, 0, `  ${line}`);
    return lines.join("\n");
  }

  /** Inside the harness's own job block, which the generator regenerates whole. */
  function insideTheGeneratedJob(line: string): string {
    const lines = GENERATED.split("\n");
    const at = lines.findIndex(l => /^\s+steps:$/.test(l));
    expect(at, "the generated ai-review.yml job has no `steps:`, so this case is vacuous").toBeGreaterThan(-1);
    const indent = " ".repeat(lines[at].length - lines[at].trimStart().length + 2);
    lines.splice(at + 1, 0, `${indent}${line}`);
    return lines.join("\n");
  }

  for (const { prefix, what: label } of WITNESSED) {
    /**
     * The `harnessOwned` half. Without the entry the line enters the loss set
     * and the whole re-scaffold is refused over a sentence the harness wrote
     * itself — which is the failure #839 and #916 both describe, met at the
     * one position the preamble reader cannot see.
     */
    test(`${label} — a bookkeeping line outside the preamble does not make the write refuse`, () => {
      const line = `${prefix}${TAIL}`;
      const planted = besideTheJobKey(line);
      // The file's own banner IS in the preamble and must stay there — what
      // this asserts is that the PLANTED line is not, because a planted line
      // the preamble covers would pass whatever the prefix list said.
      expect(
        managedPreamble(planted).map(l => l.trim()),
        "the planted line landed in the leading preamble, where `harnessPreamble` " +
          "covers it — the case would then be green whatever the prefix list says",
      ).not.toContain(line);

      expect(
        resolveManagedWrite(planted, GENERATED).refusal,
        `the harness refused to update its own file over ${label} — a line it wrote ` +
          `itself, sitting where \`managedPreamble\` cannot see it. Either restore the ` +
          `entry in HARNESS_BOOKKEEPING_PREFIXES (lib/scaffold/steps.ts), or stop ` +
          `emitting that line outside the leading preamble.`,
      ).toBeNull();

      // Negative control. Same position, same tail, no prefix — and it MUST
      // refuse, or the position is one the loss set never reaches and the
      // assertion above is green for no reason.
      expect(
        resolveManagedWrite(besideTheJobKey(UNOWNED), GENERATED).refusal,
        "a line the harness did not author was dropped from this position without " +
          "a refusal, so the position proves nothing about the prefix above it",
      ).toContain(UNOWNED);
    });

    /**
     * The `overwrittenLines` half — a second decision site, and it fails
     * differently: the file still lands, and the report tells the consumer
     * the harness overwrote an edit of theirs that was never theirs.
     */
    test(`${label} — a bookkeeping line is not reported as a consumer edit the harness overwrote`, () => {
      expect(
        resolveManagedWrite(insideTheGeneratedJob(`${prefix}${TAIL}`), GENERATED).overwrittenLines,
        `the harness reported ${label} — its own line — as a consumer edit it ` +
          `overwrote. That count feeds a report a consumer acts on, so it must not ` +
          `name the harness's own bookkeeping. See the subtraction in ` +
          `\`overwrittenLines\` (lib/scaffold/steps.ts).`,
      ).toEqual([]);

      expect(
        resolveManagedWrite(insideTheGeneratedJob(UNOWNED), GENERATED).overwrittenLines,
        "a genuine consumer edit in a harness-owned job went unreported, so the " +
          "assertion above is green for no reason",
      ).toEqual([UNOWNED]);
    });
  }
});
