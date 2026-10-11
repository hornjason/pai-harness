/**
 * #274 AC-4 — the scope gate's evidence pre-validator, run over a CONSUMER
 * fixture's AC set.
 *
 * Every rungate self-run is rewritten to LIGHT (`pages: {}` → `hasUI` false →
 * the downgrade fires), and `skipScope` is `tier === 'LIGHT'`. So the scope
 * gate — and the pre-validation it stamps — has never executed on a self-run.
 * A consumer with a non-empty `pages` map is the first project to enter it.
 * This file runs that path's pre-validator over an AC set shaped like a
 * consumer's, before a consumer run finds out the hard way.
 *
 * #271 IS CLOSED. The `|| true` auto-widen is gone, replaced by grep's own
 * exit contract — 0 selected, 1 none selected, >1 error. So the claim here is
 * NOT "the fail-open is still there"; a test written against the old fail-open
 * would pass vacuously. The claim is that the FIXED refusal EXECUTES on a
 * consumer's AC set: a zero-match grep is CLASSIFIED rather than repaired into
 * a command that cannot fail, and an unrunnable command is still broken.
 *
 * What makes this different from `test/prevalidator-zero-count.test.ts`, which
 * already covers #271 at the unit level: nothing there goes past
 * `prevalidateEvidence`. The gate does not read per-AC statuses — it reads the
 * REDUCED reading at `evidencePrevalidation`, through
 * `measureEvidencePrevalidation`, and turns it into a refusal in exactly one
 * place, `prevalidationViolations` in gates/workflow.test.ts. This file runs
 * that whole chain on one AC set and asserts the links agree.
 *
 * Nothing here is hand-written. Every verdict, status and refusal string below
 * is produced by executing the real functions over commands that really run in
 * a throwaway tree — the trap `.claude/rules/checks-must-be-able-to-fail.md`
 * names for this exact code: a refusal test fed a literal
 * `{ verdict: "FAIL", broken: ["AC-2"] }` stays green when the pre-validator
 * stops validating.
 *
 * The throwaway tree is DERIVED from the on-disk consumer fixture's `pages`
 * map, so the consumer's shape is one fact in one place rather than a second
 * copy typed into this file.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  measureEvidencePrevalidation,
  prevalidateEvidence,
  type ACInput,
  type PrevalidationResult,
} from "../lib/evidence-prevalidator";
import { EvidencePrevalidationSchema, WorkflowStateSchema } from "../gates/schema";
import { prevalidationViolations } from "../gates/workflow.test";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "consumer-ui-project");

/** The consumer's declared pages — the fact that makes this a consumer run. */
const FIXTURE_PAGES = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, ".claude", "rungate.json"), "utf-8"),
).pages as Record<string, string>;

/** The consumer's own AC set, as the scope gate would find it in state.acs. */
const FIXTURE_STATE = WorkflowStateSchema.passthrough().parse(
  JSON.parse(readFileSync(join(FIXTURE_ROOT, "workflow-state.json"), "utf-8")),
);

/**
 * A throwaway project tree with one source file per page the fixture declares.
 *
 * The pre-validator does not read config — it reads commands and a cwd — so
 * what has to be real is the TREE the commands run against: a `grep` against a
 * missing file exits 2, which is broken, and would make the zero-match case
 * below pass for the wrong reason.
 */
let PROJECT = "";
const PAGE_SLUGS = Object.values(FIXTURE_PAGES).map((name) => String(name));

beforeAll(() => {
  PROJECT = mkdtempSync(join(tmpdir(), "consumer-scope-274-"));
  mkdirSync(join(PROJECT, "src", "pages"), { recursive: true });
  for (const slug of PAGE_SLUGS) {
    writeFileSync(
      join(PROJECT, "src", "pages", `${slug}.tsx`),
      `export function ${slug.replace(/[^a-zA-Z0-9]/g, "_")}Page() {\n  return null;\n}\n`,
    );
  }
});

afterAll(() => {
  if (PROJECT) rmSync(PROJECT, { recursive: true, force: true });
});

const FIRST_PAGE = () => `src/pages/${PAGE_SLUGS[0]}.tsx`;

/**
 * The consumer's AC set, in the shape `workflows/ship.js` persists at
 * `state.acs`.
 *
 * Three commands, chosen so each lands on a different arm of the classifier on
 * its own merits rather than by being repaired first:
 *
 *   AC-1  a plain `grep` that selects nothing. Exit 1, no stdout — grep's
 *         documented "no lines selected" (#271). A zero-match grep must be
 *         classified `empty` and must NOT be auto-widened into something that
 *         cannot fail.
 *   AC-2  a script that does not exist. Exit 127, nothing `attemptAutoFix`
 *         touches (not a bare grep, not a `bun test` pipe), so it reaches
 *         `broken` on its own.
 *   AC-3  a `grep -c` that matches. Exit 0 with a value — the control, without
 *         which a classifier that refused everything would satisfy the two
 *         cases above.
 *
 * No command mentions a bare `main`/`master` ref, so `normalizeGitRefs` leaves
 * all three alone and `autoFixed` cannot be set by the ref rewrite — which
 * matters, because AC-1 asserts the absence of exactly that field.
 */
const fixtureACs = (): ACInput[] => [
  {
    id: "AC-1",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: 'grep -rn "legacy-dashboard-widget" src',
    },
    threshold: { op: "==", value: 0, unit: "legacy widget references" },
  },
  {
    id: "AC-2",
    evidenceMethod: {
      type: "COMMAND",
      command: "./scripts/count-dashboard-widgets.sh --json",
    },
    threshold: { op: "==", value: 4, unit: "nav links rendered" },
  },
  {
    id: "AC-3",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: `grep -c "Page" ${FIRST_PAGE()}`,
    },
    threshold: { op: "==", value: 1, unit: "page definitions" },
  },
];

/**
 * The same AC set with the broken command repaired. AC-1's plain `grep`
 * becomes `grep -c`, which prints `0` — a value a `== 0` threshold can be
 * compared against — so every AC classifies `ok` and the reading is a PASS.
 *
 * This is the control for the refusal cases. Without it, a
 * `prevalidationViolations` that refused every input would satisfy them.
 */
const repairedACs = (): ACInput[] => [
  {
    id: "AC-1",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: `grep -rc "legacy-dashboard-widget" ${FIRST_PAGE()}`,
    },
    threshold: { op: "==", value: 0, unit: "legacy widget references" },
  },
  {
    id: "AC-2",
    evidenceMethod: { type: "COMMAND", command: "printf 'links=4'" },
    threshold: { op: "==", value: 4, unit: "nav links rendered" },
  },
  {
    id: "AC-3",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: `grep -c "Page" ${FIRST_PAGE()}`,
    },
    threshold: { op: "==", value: 1, unit: "page definitions" },
  },
];

const byId = (results: PrevalidationResult[], id: string): PrevalidationResult => {
  const hit = results.find((r) => r.id === id);
  if (!hit) throw new Error(`${id} is missing from the pre-validation results`);
  return hit;
};

const statuses = (results: PrevalidationResult[]): Record<string, string> =>
  Object.fromEntries(results.map((r) => [r.id, r.status]));

// ── the fixture is a consumer's, not this file's invention ──────────────

describe("#274 AC-4: the AC set under test is the consumer fixture's shape", () => {
  test("the throwaway tree carries one source file per declared page", () => {
    expect(PAGE_SLUGS.length).toBe(Object.keys(FIXTURE_PAGES).length);
    expect(PAGE_SLUGS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(PAGE_SLUGS).size).toBe(PAGE_SLUGS.length);
  });

  test("the fixture's own ACs carry the evidence shape the pre-validator reads", () => {
    const acs = FIXTURE_STATE.acs ?? [];
    expect(acs.length).toBeGreaterThan(1);
    for (const ac of acs) {
      expect(typeof ac.evidenceMethod?.type).toBe("string");
      expect(typeof ac.evidenceMethod?.command).toBe("string");
    }
  });
});

// ── the classifier, over the fixture's real commands ────────────────────

describe("#274 AC-4: the pre-validator over the consumer fixture's AC set", () => {
  test("a zero-match grep is classified empty, and is not auto-widened", async () => {
    const results = await prevalidateEvidence(fixtureACs(), PROJECT);
    const ac1 = byId(results, "AC-1");

    expect(
      ac1.status,
      `a grep that selected nothing was classified '${ac1.status}'. Exit 1 is grep's ` +
        `"no lines selected", and for a zero-count AC it is the result that SATISFIES ` +
        `the threshold (#271)`,
    ).toBe("empty");

    // The other half of #271: the predecessor repaired this command into
    // `... || true`, which also swallowed exit 2 — a missing file or a bad
    // pattern — behind the same clean verdict. A classification is not a
    // repair, so neither field may be set.
    expect(ac1.fixedCommand, "the zero-match grep was rewritten").toBeUndefined();
    expect(ac1.autoFixed, "the zero-match grep was reported as auto-fixed").toBeUndefined();
    expect(ac1.needsRewrite, "a measured zero match was marked as needing a rewrite").toBeFalsy();
  });

  test("a command that cannot execute is broken, and the two verdicts are distinct", async () => {
    const results = await prevalidateEvidence(fixtureACs(), PROJECT);
    const ac1 = byId(results, "AC-1");
    const ac2 = byId(results, "AC-2");
    const ac3 = byId(results, "AC-3");

    expect(ac2.status, "a script that does not exist was not classified broken").toBe("broken");
    expect(ac2.needsRewrite, "a broken evidence command was not flagged for rewrite").toBe(true);
    expect(ac2.fixedCommand, "a command with no repair was reported as repaired").toBeUndefined();

    // "Both are non-ok" is the assertion this case exists to avoid. A
    // classifier that collapsed empty into broken would hand a satisfied
    // zero-count AC to the gate as a refusal, and one that collapsed broken
    // into empty would ship a command that cannot run. So the two are compared
    // to each other, not just to `ok`.
    expect(
      [ac1.status, ac2.status],
      "the zero-match grep and the unrunnable command were given the same verdict",
    ).toEqual(["empty", "broken"]);
    expect(ac1.status).not.toBe(ac2.status);
    expect(ac1.needsRewrite).not.toBe(ac2.needsRewrite);

    // The control. Without a passing AC in the same run, every assertion above
    // is satisfied by a classifier that refuses everything it is given.
    expect(ac3.status, "a grep that matched was not classified ok").toBe("ok");
    expect(statuses(results)).toEqual({ "AC-1": "empty", "AC-2": "broken", "AC-3": "ok" });
  });
});

// ── the reduced reading, and the gate's single refusal site ─────────────

describe("#274 AC-4: the recorded reading and the gate check that reads it", () => {
  test("the derived reading is a schema-valid FAIL that names the broken AC", async () => {
    // Derived, not written: the verdict comes from classifying commands that
    // were executed a line earlier. `takenAt` is what gate-executor.ts stamps
    // on, so this is the object that reaches workflow-state.json.
    const reading = {
      ...(await measureEvidencePrevalidation(fixtureACs(), PROJECT)),
      takenAt: "scope" as const,
    };

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(
      parsed.success,
      `the reading the scope gate would stamp does not validate: ${
        parsed.success
          ? ""
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      }`,
    ).toBe(true);

    expect(reading.verdict, "a broken evidence command did not move the verdict").toBe("FAIL");
    expect(reading.reason, "a measured verdict carried an UNMEASURED reason").toBeNull();

    // The broken AC is named in the reading itself. This is the only place the
    // id survives the reduction — the reading carries `acs`, and the schema has
    // no `broken` field for a consumer of it to read.
    expect(reading.acs.filter((a) => a.status === "broken").map((a) => a.id)).toEqual(["AC-2"]);
    expect(
      (reading as Record<string, unknown>).broken,
      "the reading grew a `broken` field",
    ).toBeUndefined();

    // The whole classification survives the reduction, not just the failures:
    // `empty` is a warning rather than a refusal, and a warning that does not
    // reach the file is a warning no later check can see.
    expect(statuses(reading.acs)).toEqual({ "AC-1": "empty", "AC-2": "broken", "AC-3": "ok" });
  });

  test("the gate's single refusal site refuses the measured FAIL, and passes a clean set", async () => {
    const failing = await measureEvidencePrevalidation(fixtureACs(), PROJECT);
    expect(failing.verdict, "the fixture stopped producing a FAIL to refuse").toBe("FAIL");

    const violations = prevalidationViolations(failing);
    expect(
      violations.length,
      `a measured FAIL produced no refusal: ${JSON.stringify(violations)}`,
    ).toBe(1);
    expect(violations[0]).toContain("evidence pre-validation: FAIL");

    // The control, also derived. A refusal site that refused everything would
    // satisfy the case above, and this is the half that catches it.
    const clean = await measureEvidencePrevalidation(repairedACs(), PROJECT);
    expect(
      statuses(clean.acs),
      "the repaired AC set is not all-ok, so it cannot show the refusal site going quiet",
    ).toEqual({ "AC-1": "ok", "AC-2": "ok", "AC-3": "ok" });
    expect(clean.verdict).toBe("PASS");
    expect(
      prevalidationViolations(clean),
      "an all-ok pre-validation was refused — the check refuses whatever it is given",
    ).toEqual([]);
  });

  test("an unmeasured reading is refused the same way a FAIL is", async () => {
    // "Nothing was measured" has been read as "nothing was wrong" once in this
    // harness already (#224). Both the absence and the explicit UNMEASURED are
    // asserted, because "the writer never ran" and "the writer ran and measured
    // nothing" fail for the same reason.
    const unmeasured = await measureEvidencePrevalidation([], PROJECT);
    expect(unmeasured.verdict).toBe("UNMEASURED");
    expect(prevalidationViolations(unmeasured).length).toBe(1);
    expect(prevalidationViolations(undefined).length).toBe(1);
  });
});

// ── the call site and the owner are the same chain ──────────────────────

describe("#274 AC-4: the gate's entry point delegates to the pre-validator", () => {
  test("measureEvidencePrevalidation returns what prevalidateEvidence classified", async () => {
    // `gates/gate-executor.ts` calls `measureEvidencePrevalidation`, never
    // `prevalidateEvidence` directly. Asserting the owner's behaviour alone
    // would stay green while the wrapper quietly stopped delegating — it
    // returns a hardcoded verdict, or an UNMEASURED it swallowed an exception
    // into — so the entry point is EXECUTED here over the same AC set and the
    // two classifications are compared.
    const owner = await prevalidateEvidence(fixtureACs(), PROJECT);
    const entry = await measureEvidencePrevalidation(fixtureACs(), PROJECT);

    // Vacuity guard. Two empty lists compare equal, and that is what both a
    // short-circuited owner and a wrapper that stopped calling it look like.
    expect(entry.acs.length, "the entry point measured nothing").toBe(3);
    expect(new Set(Object.values(statuses(entry.acs))).size, "every AC got the same verdict").toBe(3);

    expect(statuses(entry.acs)).toEqual(statuses(owner));
    expect(entry.verdict, "the entry point reported a verdict its own results contradict").toBe(
      owner.some((r) => r.status === "broken") ? "FAIL" : "PASS",
    );
    expect(byId(entry.acs, "AC-2").needsRewrite).toBe(byId(owner, "AC-2").needsRewrite as boolean);
  });
});
