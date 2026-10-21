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
 * | M6 `MANAGED_BANNER_PREFIX` given a second spelling in `steps.ts` | **0 of 107** | nothing — see below |
 *
 * M5 is the control for the division of labour this file claims: the headline
 * case goes red if EITHER the write stops allowing the merge through or the
 * merge stops computing the grant, so neither half can quietly stop working
 * while the other holds the case up.
 *
 * **M6 found a dead decider, and this change is what killed it.** A banner
 * line is always in the preamble of a generated workflow, and
 * `resolveManagedWrite` refuses anything that does not parse as one, so
 * `harnessPreamble` now covers every line the banner entry in
 * `HARNESS_BOOKKEEPING_PREFIXES` used to cover. Nothing can tell the two
 * apart. Recorded rather than quietly left green: a count of 0 is a fact
 * about the tree, and an unexplained one invites the next reader to trust a
 * guard that cannot fail. The constant is still imported rather than
 * respelled, so there is one spelling of it either way — which is the defect
 * M6 was actually probing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import { AI_REVIEW_WORKFLOW_FILE } from "../lib/scaffold/ai-review-step";
import { managedPreamble, topLevelKeyOrder } from "../lib/scaffold/managed-workflow";

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
