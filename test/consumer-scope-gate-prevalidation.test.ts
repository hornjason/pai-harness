/**
 * #274 AC-4 — the scope gate's evidence pre-validator, run over a CONSUMER
 * fixture's real AC set.
 *
 * Every rungate self-run is rewritten to LIGHT (`pages: {}` → `hasUI` false →
 * the downgrade fires), and `skipScope` is `tier === 'LIGHT'`. So the scope
 * gate — and the pre-validation it stamps — has never executed on a self-run.
 * A consumer with a non-empty `pages` map is the first project to enter it.
 * This file runs that path's pre-validator over an AC set shaped like a
 * consumer's, before a consumer run finds out the hard way.
 *
 * What makes this different from `test/prevalidator-zero-count.test.ts`, which
 * already covers #271 at the unit level: nothing there goes past
 * `prevalidateEvidence`. The gate does not read per-AC statuses — it reads the
 * REDUCED reading at `evidencePrevalidation`, through
 * `measureEvidencePrevalidation`, and turns it into a refusal in exactly one
 * place, `prevalidationViolations` in gates/workflow.test.ts. This file runs
 * that whole chain on one AC set and asserts the links agree.
 *
 * #271 is CLOSED and merged, so the premise this file is written against is the
 * FIXED pre-validator, not the fail-open one: a zero-match grep is CLASSIFIED
 * as a result (grep's own exit contract — 0 selected, 1 none, >1 error) rather
 * than repaired into `... || true`, which also swallowed exit 2. A test written
 * against the old fail-open would pass vacuously here.
 *
 * Nothing below is hand-written. Every verdict, status and refusal string is
 * produced by executing the real functions over commands that really run in the
 * fixture directory — the trap `.claude/rules/checks-must-be-able-to-fail.md`
 * names for this exact code: a refusal test fed a literal
 * `{ verdict: "FAIL", broken: ["AC-2"] }` stays green when the pre-validator
 * stops validating.
 *
 * ## One thing this file deliberately does NOT assert
 *
 * The refusal does not NAME the broken AC, and that is #295, not a bug in the
 * fixture. `prevalidationViolations` reads a top-level `reading.broken` that no
 * writer produces — `measureEvidencePrevalidation` returns `acs`,
 * `EvidencePrevalidationSchema` accepts only `acs`, and no workflow-state.json
 * has ever carried a `broken` key — so every genuine FAIL falls through to the
 * "no broken AC ids were recorded" branch. Still a refusal, so not a fail-open,
 * but a refusal that cannot say which AC to fix, on the only path a consumer
 * run takes. #295 is filed with a fix on branch worktree-wf_536df065-969-10;
 * editing gates/workflow.test.ts from here is out of scope. The assertions
 * below therefore check that the FAIL is REFUSED and that a clean set is not,
 * which is true both before and after #295 lands.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  measureEvidencePrevalidation,
  prevalidateEvidence,
  type ACInput,
  type PrevalidationResult,
} from "../lib/evidence-prevalidator";
import { EvidencePrevalidationSchema } from "../gates/schema";
import { prevalidationViolations } from "../gates/workflow.test";

// ── The consumer fixture ────────────────────────────────────────────────

/**
 * A throwaway project in the shape that makes a run a CONSUMER run: a
 * non-empty `pages` map, so `hasUI` is true and the LIGHT downgrade never
 * fires.
 *
 * The pre-validator does not read the config — it reads commands and a cwd —
 * so the config is here to say which fixture this is rather than to be
 * consumed. What the commands below DO read is the source tree, and that has
 * to be real: a `grep` against a missing file exits 2, which is broken, and
 * would make the "zero match" case below pass for the wrong reason.
 */
let FIXTURE = "";

const PAGES = {
  "/": "home",
  "/settings": "settings",
};

beforeAll(() => {
  FIXTURE = mkdtempSync(join(tmpdir(), "consumer-scope-274-"));
  mkdirSync(join(FIXTURE, "src", "pages"), { recursive: true });
  mkdirSync(join(FIXTURE, ".claude"), { recursive: true });
  writeFileSync(
    join(FIXTURE, "src", "pages", "dashboard.tsx"),
    "export function DashboardPage() {\n  return null;\n}\n",
  );
  writeFileSync(
    join(FIXTURE, ".claude", "rungate.json"),
    JSON.stringify({ pages: PAGES, dev: { testCmd: "bun test" } }, null, 2),
  );
});

afterAll(() => {
  if (FIXTURE) rmSync(FIXTURE, { recursive: true, force: true });
});

/**
 * The fixture's AC set, in the shape `workflows/ship.js` persists at
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
const FIXTURE_ACS: ACInput[] = [
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
    threshold: { op: ">=", value: 2, unit: "widgets rendered" },
  },
  {
    id: "AC-3",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: 'grep -c "DashboardPage" src/pages/dashboard.tsx',
    },
    threshold: { op: "==", value: 1, unit: "dashboard page definitions" },
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
const REPAIRED_ACS: ACInput[] = [
  {
    id: "AC-1",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: 'grep -rc "legacy-dashboard-widget" src/pages/dashboard.tsx',
    },
    threshold: { op: "==", value: 0, unit: "legacy widget references" },
  },
  {
    id: "AC-2",
    evidenceMethod: { type: "COMMAND", command: "printf 'widgets=3'" },
    threshold: { op: ">=", value: 2, unit: "widgets rendered" },
  },
  {
    id: "AC-3",
    evidenceMethod: {
      type: "GREP_CHECK",
      command: 'grep -c "DashboardPage" src/pages/dashboard.tsx',
    },
    threshold: { op: "==", value: 1, unit: "dashboard page definitions" },
  },
];

const byId = (results: PrevalidationResult[], id: string): PrevalidationResult => {
  const hit = results.find((r) => r.id === id);
  if (!hit) throw new Error(`${id} is missing from the pre-validation results`);
  return hit;
};

const statuses = (results: PrevalidationResult[]): Record<string, string> =>
  Object.fromEntries(results.map((r) => [r.id, r.status]));

// ── The classifier, over the fixture's real commands ────────────────────

describe("#274 AC-4: the pre-validator over the consumer fixture's AC set", () => {
  test("a zero-match grep is classified empty, and is not auto-widened", async () => {
    const results = await prevalidateEvidence(FIXTURE_ACS, FIXTURE);
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
    const results = await prevalidateEvidence(FIXTURE_ACS, FIXTURE);
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

// ── The reduced reading, and the gate's refusal ─────────────────────────

describe("#274 AC-4: the recorded reading and the gate check that reads it", () => {
  test("the derived reading is a schema-valid FAIL that names the broken AC", async () => {
    // Derived, not written: the verdict comes from classifying commands that
    // were executed a line earlier. `takenAt` is what gate-executor.ts stamps
    // on, so this is the object that reaches workflow-state.json.
    const reading = {
      ...(await measureEvidencePrevalidation(FIXTURE_ACS, FIXTURE)),
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

    // The broken AC is named in the reading itself.
    //
    // When this was written the id survived only in `acs`, and the absence of
    // a `broken` field was asserted and filed as #295 — `prevalidationViolations`
    // read `reading.broken`, which no writer produced, so every pre-validation
    // refusal was unable to say which AC was broken. **#295 closed on
    // 2026-10-11 at 23:30Z, about five hours after this branch's last commit**,
    // and the writer now produces the field. The assertion is inverted rather
    // than deleted: a field a refusal depends on is exactly the thing to pin.
    const fromAcs = reading.acs.filter((a) => a.status === "broken").map((a) => a.id);
    expect(fromAcs).toEqual(["AC-2"]);

    const broken = (reading as Record<string, unknown>).broken;
    expect(broken, "the reading lost the `broken` field #295 added — the refusal cannot name an AC")
      .toEqual(["AC-2"]);

    // And the two have to AGREE. A derived field that disagrees with the
    // classification it is derived from is worse than no field at all: the
    // refusal names one AC and the evidence names another, and nothing
    // compares them. Asserting each against a literal would let them drift
    // apart in opposite directions while both cases stayed green.
    expect(broken, "`broken` and the `acs` classification name different ACs").toEqual(fromAcs);

    // The whole classification survives the reduction, not just the failures:
    // `empty` is a warning rather than a refusal, and a warning that does not
    // reach the file is a warning no later check can see.
    expect(statuses(reading.acs)).toEqual({ "AC-1": "empty", "AC-2": "broken", "AC-3": "ok" });
  });

  test("the gate's single refusal site refuses the measured FAIL, and passes a clean set", async () => {
    const failing = await measureEvidencePrevalidation(FIXTURE_ACS, FIXTURE);
    expect(failing.verdict, "the fixture stopped producing a FAIL to refuse").toBe("FAIL");

    const violations = prevalidationViolations(failing);
    expect(
      violations.length,
      `a measured FAIL produced no refusal: ${JSON.stringify(violations)}`,
    ).toBe(1);
    expect(violations[0]).toContain("evidence pre-validation: FAIL");

    // The control, also derived. A refusal site that refused everything would
    // satisfy the case above, and this is the half that catches it.
    const clean = await measureEvidencePrevalidation(REPAIRED_ACS, FIXTURE);
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

  test("an absent reading refuses too — unmeasured is not clean", async () => {
    // The fail-open this chain has already had once (#224): nothing read as
    // zero. Asserted beside the measured FAIL because the two must not be
    // distinguishable by whether the gate complains.
    expect(prevalidationViolations(undefined).length).toBe(1);
    expect(prevalidationViolations(undefined)[0]).toContain("not recorded");
  });
});

// ── The call site and the owner are the same chain ──────────────────────

describe("#274 AC-4: the gate's entry point delegates to the pre-validator", () => {
  test("measureEvidencePrevalidation returns what prevalidateEvidence classified", async () => {
    // `gates/gate-executor.ts` calls `measureEvidencePrevalidation`, never
    // `prevalidateEvidence` directly. Asserting the owner's behaviour alone
    // would stay green while the wrapper quietly stopped delegating — it
    // returns a hardcoded verdict, or an UNMEASURED it swallowed an exception
    // into — so the entry point is EXECUTED here over the same AC set and the
    // two classifications are compared.
    const owner = await prevalidateEvidence(FIXTURE_ACS, FIXTURE);
    const entry = await measureEvidencePrevalidation(FIXTURE_ACS, FIXTURE);

    // Vacuity guard. Two empty lists compare equal, and that is what both a
    // short-circuited owner and a wrapper that stopped calling it look like.
    expect(entry.acs.length, "the entry point measured nothing").toBe(FIXTURE_ACS.length);
    expect(new Set(Object.values(statuses(entry.acs))).size, "every AC got the same verdict").toBe(3);

    expect(statuses(entry.acs)).toEqual(statuses(owner));
    expect(entry.verdict, "the entry point reported a verdict its own results contradict").toBe(
      owner.some((r) => r.status === "broken") ? "FAIL" : "PASS",
    );
    expect(byId(entry.acs, "AC-2").needsRewrite).toBe(byId(owner, "AC-2").needsRewrite as boolean);
  });
});
