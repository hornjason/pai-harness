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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createCiWorkflows,
  HARNESS_BOOKKEEPING_PREFIXES,
  HARNESS_COMPUTED_SUBKEYS,
  resolveManagedWrite,
} from "../lib/scaffold/steps";
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

// ── #923 ───────────────────────────────────────────────────────────────────

/**
 * A derived grant goes when the thing that derived it goes (#923).
 *
 * The third row of #923's table, which #834 deliberately did not pin: #834
 * fixed the write refusal that kept `id-token: write` OFF consumers adding
 * `ci.vertex`, and its cases above assert that direction only. Removing
 * `ci.vertex` and re-scaffolding left the grant in place for ever, with no
 * route to withdraw it — a job keeping the right to mint an OIDC token for a
 * federation that is no longer configured, which is #631's "a permission
 * nobody consumes is a permission nobody audits" stuck open in the one
 * direction nothing closed.
 *
 * ## Why the before-state is never hand-written
 *
 * Same discipline as #834's block above, inverted. The cheapest wrong fix
 * here is hand-deleting the line from one consumer's `ai-review.yml`, and a
 * case whose before-state was built by writing `id-token: write` into a
 * fixture string would be measuring the fixture. Every before-state below is
 * whatever `createCiWorkflows` itself produced for a consumer that HAD
 * `ci.vertex`, the only thing that changes between the two runs is the
 * config, and no file in this repository is touched — so a hand edit
 * anywhere cannot move any of these.
 *
 * ## Where `HARNESS_COMPUTED_SUBKEYS`'s population comes from
 *
 * Not from the map. The ratchet scaffolds the same project with and without
 * the config that drives the grant and takes the PER-FILE symmetric
 * difference of the `permissions:` sub-keys each GENERATOR emitted. That is
 * the definition of "conditionally emitted", read off the emitting module,
 * and the reason it is read that way is the one #926 records a floor below:
 * a list checked against a fixture derived from itself matches whatever it
 * says and cannot see itself drift.
 *
 * Per file rather than merged, because the comparison is what catches an
 * entry for a workflow whose generator never emits the sub-key under any
 * config — finding 1 below — and a union would hide exactly that.
 *
 * Its limit, stated rather than implied: it varies `ci.vertex` and nothing
 * else, so a sub-key made conditional on some OTHER config key would not
 * appear in the difference and the case would not demand an entry. That is a
 * gap in the ratchet, not in the entry it currently holds.
 *
 * ## Two findings from review, and the cases that hold them
 *
 * Both were in the first draft of this change and both are the SAME SHAPE as
 * the issue it fixes. #923 is a grant outliving its reason; an unscoped or
 * over-generous revoker is a WITHDRAWAL outliving its reason.
 *
 * 1. `HARNESS_COMPUTED_SUBKEYS` was keyed by SECTION alone, so
 *    `permissions.id-token` was revocable in every managed workflow. All
 *    three generated workflows carry a top-level `permissions:` and only one
 *    ever emits `id-token`, so a consumer with a deploy job of their own in
 *    a different file would have had the grant deleted by a feature that was
 *    not reasoning about it. Keyed by FILE now; `a managed workflow the map
 *    has no entry for keeps a grant the consumer put there` is the case and
 *    M18 is its control.
 *
 * 2. The loss set excused revoked lines through a `Set` of line TEXT. The
 *    loss set is the single mechanism stopping this generator from eating
 *    content a consumer wrote, and `  id-token: write` is a line a workflow
 *    plausibly carries twice — so one legitimate withdrawal silently excused
 *    every match, and a set cannot tell two-revoked-five-present from
 *    one-and-one. It is a spent multiset now: exactly as many occurrences
 *    are forgiven as the merge removed. `a second occurrence of a revoked
 *    line is still a loss` is the case and M17 is its control.
 *
 * ## Mutation battery, measured on this base
 *
 * Over this file plus `workflow-top-level-merge`, `workflow-version-skew`,
 * `managed-workflow-key-order`, `scaffold-ci-preservation`, `ci-shard`,
 * `ai-review-wif` and `workflow-provenance-merge` — **123 cases**, green
 * unmutated, source restored after each and green again.
 *
 * Counts AND the assertions each row reddens, because a count that is right
 * about the wrong assertion is not coverage. Every case named below is in
 * this block and runs against a temporary tree, so no count here depends on
 * the machine it was measured on.
 *
 * | mutation | red | the assertions that go red |
 * |---|---|---|
 * | M10 `HARNESS_COMPUTED_SUBKEYS` emptied | **6 of 123** | the five revoking cases + `the map names exactly the sub-keys each generator computes, file by file` |
 * | M11 the map widened to `{contents, id-token}`, which is direction (1) as #923 drafted it | **1 of 123** | the ratchet — `contents` is emitted unconditionally, so it is in no symmetric difference |
 * | M12 the revocation budget dropped from `lostLines`' filter | **4 of 123** | the four revoking cases, each via REFUSAL — #834's failure from the other side |
 * | M13 `revokedSubKeys` drops its `!emitted.has` term | **1 of 123** | `a consumer that keeps ci.vertex is reported as withdrawing nothing` |
 * | M14 the revocation moved OUTSIDE the `!declined` arm | **1 of 123** | `ci.workflowOverrides takes the grant back` |
 * | M15 the budget widened to excuse ALL consumer content once anything is revoked | **2 of 123** | `a consumer line the merge drops still refuses a revoking write`; `a second occurrence of a revoked line is still a loss` |
 * | M16 `withoutRevoked` returns `before` unchanged | **4 of 123** | the four revoking cases — the record is produced and the lines stay |
 * | M17 **finding 2** — the budget is a `Set` of line text, not a spent multiset | **1 of 123** | `a second occurrence of a revoked line is still a loss` |
 * | M18 **finding 1** — the file key ignored, the map flattened to sections | **1 of 123** | `a managed workflow the map has no entry for keeps a grant the consumer put there` |
 * | M19 the wiring dropped, so `writeManagedFile` never passes the map on | **5 of 123** | the five revoking cases |
 *
 * **M13 was 0 of 120 and recording it is what closed it.** Its mutant
 * produces a byte-identical file: the sub-key is withdrawn and
 * `mergeTopLevelSection` adds it straight back, because the generated side
 * declares it and the stripped consumer no longer does. Everything that
 * differs is downstream of the RECORD — a scaffold claiming a withdrawal
 * that did not happen, and a loss set that quietly stops protecting those
 * lines. No assertion about the FILE could ever have reached it, which is
 * why the case that closed it asserts the report.
 */
describe("#923: a grant the generator stopped computing is withdrawn", () => {
  /**
   * The before-state every case below starts from: a consumer the generator
   * itself federated. Asserted to carry the grant, or the case that removes
   * it is measuring nothing.
   */
  function federatedConsumer(ci: Record<string, unknown> = {}): string {
    const { root } = scaffolded({ ...BASE_CI, ...ci, vertex: VERTEX });
    expect(
      permissionsOf(root)["id-token"],
      "the before-state does not carry id-token: write, so removing ci.vertex " +
        "cannot show anything — this fixture is generator-produced and never hand-written",
    ).toBe("write");
    return root;
  }

  /** The `REVOKED:` lines a scaffold recorded for the ai-review workflow. */
  const revocations = (actions: string[]) =>
    actions.filter(a => a.startsWith("REVOKED:") && a.includes(AI_REVIEW_WORKFLOW_FILE));

  /** The headline. #923's third row. */
  test("a consumer that removes ci.vertex no longer declares id-token: write", () => {
    const root = federatedConsumer();

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(
      refusals(actions),
      "the write refused, so the merge's revocation never reached disk — the loss " +
        "set and the merge are disagreeing about lines the harness itself authored",
    ).toEqual([]);
    expect(
      permissionsOf(root)["id-token"],
      "ci.vertex is gone and the job still holds the right to mint an OIDC token " +
        "for a federation that is no longer configured",
    ).toBeUndefined();
    expect(permissionsOf(root).contents, "the unconditional grant went with it").toBe("read");
  });

  /**
   * #839 does not regress. A sub-key only the consumer declares is still the
   * consumer's — the whole reason this needed a declared list rather than
   * "remove whatever the generated side lacks".
   *
   * Planted by editing the generated file, which is the only way a consumer
   * grant can exist: the generator does not emit one, so there is no config
   * that would produce it.
   */
  test("a permission the consumer added for a job of their own is untouched", () => {
    const root = federatedConsumer();
    writeFileSync(
      aiReviewPath(root),
      aiReviewText(root).replace(/^permissions:\n/m, "permissions:\n  pull-requests: write\n"),
    );
    expect(permissionsOf(root)["pull-requests"], "the plant did not land").toBe("write");

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(refusals(actions), "the write refused over the consumer's own grant").toEqual([]);
    expect(
      permissionsOf(root)["pull-requests"],
      "a local knob the consumer added was withdrawn along with the derived grant — " +
        "the revocation is reading `absent from the generated side` instead of " +
        "`named in HARNESS_COMPUTED_SUBKEYS` for this file",
    ).toBe("write");
    expect(permissionsOf(root)["id-token"], "and the derived grant still went").toBeUndefined();
  });

  /** AC-3. A deletion nothing records is a deletion nobody can audit. */
  test("the scaffold report names the grant it withdrew and why", () => {
    const root = federatedConsumer();

    const line = revocations(rescaffoldWith(root, { ...BASE_CI }));

    expect(line.length, "the scaffold withdrew a standing grant and said nothing about it").toBe(1);
    expect(line[0], "the report does not name the sub-key that went").toContain("id-token");
    expect(line[0], "the report does not name the key it sat under").toContain("permissions");
    expect(
      line[0],
      "the report does not name the escape hatch, so a consumer who wanted the " +
        "grant has been told it is gone and not how to keep it",
    ).toContain("ci.workflowOverrides");
  });

  /**
   * AC-4. The escape hatch covers this path, through the mechanism that
   * already existed: naming the top-level key short-circuits the sub-key
   * merge before the revocation is read.
   */
  test("ci.workflowOverrides takes the grant back", () => {
    const root = federatedConsumer();

    const actions = rescaffoldWith(root, { ...BASE_CI, workflowOverrides: ["permissions"] });

    expect(refusals(actions), "the write refused").toEqual([]);
    expect(
      permissionsOf(root)["id-token"],
      "a consumer who declared `permissions` theirs had a sub-key deleted out of it " +
        "anyway — which is the deletion-without-a-route #839's hatch exists to make " +
        "impossible",
    ).toBe("write");
    expect(
      revocations(actions),
      "the harness reported withdrawing a grant it left in place",
    ).toEqual([]);
    expect(
      aiReviewText(root),
      "the key was kept and the file does not say why, so the deviation is implicit",
    ).toContain(WORKFLOW_OVERRIDE_COMMENT);
  });

  /**
   * The negative control for the loss-set widening. The revocation
   * whitelists the lines the MERGE removed, and nothing else; a consumer's
   * own line that the merge drops must still refuse, or the whitelist has
   * stopped being about the revocation and #216 is back.
   *
   * Planted beside the job key, which is #926's position: outside the
   * leading preamble, so `harnessPreamble` does not cover it, and outside
   * every job, so `harnessOwned` does not either. The only thing that could
   * excuse it is the revocation whitelist, and the revocation is happening
   * on this very run.
   */
  test("a consumer line the merge drops still refuses a revoking write", () => {
    const root = federatedConsumer();
    const planted = "  # our fleet tags the jobs block of every workflow";
    writeFileSync(
      aiReviewPath(root),
      aiReviewText(root).replace(/^jobs:\n/m, `jobs:\n${planted}\n`),
    );

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(
      refusals(actions).join("\n"),
      "a line the consumer wrote was dropped by a revoking re-scaffold without a " +
        "refusal — the revocation whitelist is covering lines the merge did not revoke",
    ).toContain(planted.trim());
    expect(aiReviewText(root), "and the line itself is still on disk").toContain(planted);
  });

  /**
   * The cost of revocation, pinned rather than left to be discovered.
   *
   * `parseSubKeys` gives a sub-key the run of comments immediately above it,
   * because carrying a key without its reason is how the next person deletes
   * it. Revoking the key therefore takes any comment a consumer wrote above
   * it, and the write cannot refuse over that — the whitelist is what stops
   * the whole re-scaffold failing over the harness's own `# Mint the OIDC
   * token ...` line, and nothing at revocation time can tell the two apart,
   * because the generated side no longer declares the key to compare with.
   *
   * So the REVOKED line in the report is the only record, and this case is
   * what makes that a measured statement instead of a hope.
   */
  test("a consumer comment riding on the revoked key goes with it, and the report is the record", () => {
    const root = federatedConsumer();
    const planted = "  # our quarterly audit signs off on this grant";
    writeFileSync(
      aiReviewPath(root),
      aiReviewText(root).replace(/^(\s*)id-token: write$/m, `${planted}\n$1id-token: write`),
    );
    expect(aiReviewText(root), "the plant did not land").toContain(planted);

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(refusals(actions), "the write refused rather than revoking").toEqual([]);
    expect(
      aiReviewText(root),
      "the comment outlived the key it introduced, which is the #482 orphan",
    ).not.toContain(planted);
    expect(
      revocations(actions).length,
      "a consumer's own line went and the scaffold report said nothing — this is the " +
        "ONLY record of that deletion, so it is not optional",
    ).toBe(1);
  });

  /**
   * Convergence. A managed file has to reach a fixed point, and a revocation
   * that re-fires is a file that never settles — which is also what a
   * removal NOTICE written into the file would have been, and the reason
   * #923 reports this through the scaffold log instead.
   */
  test("re-scaffolding a third time changes nothing", () => {
    const root = federatedConsumer();
    rescaffoldWith(root, { ...BASE_CI });
    const settled = aiReviewText(root);

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(aiReviewText(root), "the merge did not converge after the revocation").toBe(settled);
    expect(
      revocations(actions),
      "the harness reported withdrawing a grant that was already gone",
    ).toEqual([]);
  });

  /**
   * The other direction of the report, and the case that gave M13 something
   * to redden.
   *
   * M13 — `revokedSubKeys` without its `!emitted` term, so a mapped sub-key
   * is "withdrawn" even while the generator still emits it — measured **0 of
   * 120** before this case existed. The output file is identical either way:
   * the sub-key is taken out and `mergeTopLevelSection` puts it straight
   * back, because the generated side declares it and the stripped consumer
   * no longer does. What differs is everything downstream of the RECORD —
   * the scaffold claims it withdrew a grant that is still in the file, and
   * the loss set quietly stops protecting those lines. Asserting the file
   * could never see it; asserting the report can.
   */
  test("a consumer that keeps ci.vertex is reported as withdrawing nothing", () => {
    const root = federatedConsumer();

    const actions = rescaffoldWith(root, { ...BASE_CI, vertex: VERTEX, branches: ["main", "develop"] });

    expect(permissionsOf(root)["id-token"], "the grant went while the config still justifies it").toBe("write");
    expect(
      revocations(actions),
      "the scaffold reported withdrawing a grant that is still in the file. The " +
        "revocation is firing on `the sub-key is in the map` rather than on `the map " +
        "names it AND the generator stopped emitting it`, and the file looks right only " +
        "because the sub-key merge adds back what was taken out",
    ).toEqual([]);
  });

  /**
   * The ratchet, PER FILE, and the fixture comes from the GENERATORS rather
   * than from the map. See the block docblock.
   *
   * Every generated workflow is scaffolded both ways and the per-file
   * symmetric difference of its `permissions:` sub-keys is taken. That
   * difference IS the definition of "conditionally emitted", and comparing
   * the whole map against the whole set of differences is what catches an
   * entry for a file whose generator never computes the sub-key under any
   * config — which is the over-reach the file key exists to prevent, not
   * merely a tidiness check.
   */
  test("the map names exactly the sub-keys each generator computes, file by file", () => {
    const withVertex = scaffolded({ ...BASE_CI, vertex: VERTEX });
    const without = scaffolded({ ...BASE_CI });

    /** Top-level `permissions:` sub-keys of one generated workflow. */
    const subKeys = (root: string, file: string): Set<string> => {
      const doc = Bun.YAML.parse(
        readFileSync(join(root, ".github", "workflows", file), "utf-8"),
      ) as any;
      return new Set(Object.keys((doc?.permissions ?? {}) as Record<string, string>));
    };

    /** Every workflow the scaffold wrote, read off disk rather than listed. */
    const files = readdirSync(join(withVertex.root, ".github", "workflows")).sort();
    expect(files.length, "the scaffold wrote no workflows, so this case is vacuous").toBeGreaterThan(1);

    const measured = new Map<string, string[]>();
    for (const file of files) {
      const a = subKeys(withVertex.root, file);
      const b = subKeys(without.root, file);
      const diff = [...[...a].filter(k => !b.has(k)), ...[...b].filter(k => !a.has(k))].sort();
      if (diff.length > 0) measured.set(file, diff);
    }

    expect(
      measured.size,
      "no generated workflow emitted a different permissions block either way, so " +
        "this case measures nothing about which sub-keys are computed",
    ).toBeGreaterThan(0);

    const declared = new Map(
      [...HARNESS_COMPUTED_SUBKEYS].map(
        ([file, sections]) => [file, [...(sections.get("permissions") ?? [])].sort()] as const,
      ),
    );

    expect(
      Object.fromEntries(declared),
      "HARNESS_COMPUTED_SUBKEYS (lib/scaffold/steps.ts) disagrees with the generators " +
        "about which permissions sub-keys each FILE conditionally emits. A sub-key a " +
        "generator computes and the map omits is a grant that outlives its reason. A " +
        "sub-key the map names for a file whose generator never emits it is worse: the " +
        "revocation reaches a workflow it was not reasoning about and deletes a grant " +
        "the consumer put there. Add or drop the entry in the same commit that makes " +
        "the sub-key conditional.",
    ).toEqual(Object.fromEntries(measured));
  });

  /**
   * Finding 1. The revocation does not reach a workflow whose generator
   * never computes the sub-key.
   *
   * All three generated workflows carry a top-level `permissions:`, and only
   * one of them ever emits `id-token`. Keyed by section alone the merge
   * cannot tell them apart, so a consumer with a deploy job of their own in
   * a DIFFERENT managed workflow has the grant silently withdrawn by a
   * feature that was not reasoning about their file. An unscoped revoker is
   * a withdrawal outliving its reason, which is #923 with the sign flipped.
   *
   * The file is chosen off the map rather than named: the point is "a
   * managed workflow this map has no entry for", and spelling one would
   * stop being that the moment the map gained a row for it.
   */
  test("a managed workflow the map has no entry for keeps a grant the consumer put there", () => {
    const { root } = scaffolded({ ...BASE_CI, vertex: VERTEX });
    const others = readdirSync(join(root, ".github", "workflows"))
      .filter(f => !HARNESS_COMPUTED_SUBKEYS.has(f))
      .sort();
    expect(
      others.length,
      "every generated workflow has a HARNESS_COMPUTED_SUBKEYS entry, so there is no " +
        "unmapped file to measure the scope against",
    ).toBeGreaterThan(0);

    const target = join(root, ".github", "workflows", others[0]);
    const before = readFileSync(target, "utf-8");
    expect(before, "the chosen workflow has no permissions block to plant into").toMatch(/^permissions:$/m);
    writeFileSync(target, before.replace(/^permissions:\n/m, "permissions:\n  id-token: write\n"));

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(
      actions.filter(a => a.startsWith("REFUSED:") && a.includes(others[0])),
      "the write refused rather than leaving the consumer's grant alone",
    ).toEqual([]);
    const after = Bun.YAML.parse(readFileSync(target, "utf-8")) as any;
    expect(
      after.permissions["id-token"],
      `the revocation reached ${others[0]}, whose generator never emits id-token under ` +
        "any config. The map is keyed too widely and is deleting a grant in a file it " +
        "was never reasoning about",
    ).toBe("write");
    expect(
      actions.filter(a => a.startsWith("REVOKED:") && a.includes(others[0])),
      "and it reported doing so",
    ).toEqual([]);
  });

  /**
   * Finding 2. The loss set forgives exactly as many occurrences as the
   * merge removed — a multiset, not a set of line TEXT.
   *
   * `  id-token: write` is a line a workflow plausibly carries more than
   * once. Excusing by text means one legitimately withdrawn occurrence
   * silently excuses every other occurrence in the file, and a `Set` cannot
   * tell two-revoked-five-present from one-and-one. The loss set is the
   * single mechanism stopping the generator from eating content a consumer
   * wrote, so widening it by text is a silent deletion through scaffold.
   *
   * The second occurrence is planted beside the job key — #926's position,
   * which the merge drops and which neither `harnessOwned` nor
   * `harnessPreamble` covers — so the only thing that could excuse it is the
   * revocation budget. One is revoked; the budget is 1; two occurrences
   * reach the loss set; one must survive it and refuse.
   */
  test("a second occurrence of a revoked line is still a loss", () => {
    const root = federatedConsumer();
    const grant = "  id-token: write";
    expect(aiReviewText(root), "the generated grant is not spelled as planted").toContain(`\n${grant}\n`);
    writeFileSync(
      aiReviewPath(root),
      aiReviewText(root).replace(/^jobs:\n/m, `jobs:\n${grant}\n`),
    );
    const planted = aiReviewText(root);
    expect(
      planted.split("\n").filter(l => l === grant).length,
      "the fixture does not actually carry the line twice",
    ).toBe(2);

    const actions = rescaffoldWith(root, { ...BASE_CI });

    expect(
      refusals(actions).join("\n"),
      "one occurrence was revoked and the OTHER was dropped without a refusal — the " +
        "loss set is excusing by line TEXT, so a single withdrawal forgives every " +
        "matching line in the file. That is a silent deletion of content the consumer " +
        "wrote, through scaffold, which is the one thing the loss set exists to stop",
    ).toContain(grant.trim());
    expect(
      aiReviewText(root),
      "the write refused, so nothing should have changed on disk",
    ).toBe(planted);
  });
});
