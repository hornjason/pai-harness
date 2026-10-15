/**
 * The close gate's label check, and the transport it was entangled with (#395).
 *
 * Covers SC-1416, SC-1417, SC-1418, SC-1489, SC-1490 of HARNESS-STANDARD.md.
 *
 * `gates/workflow.test.ts` read an issue's labels by shelling out to the
 * GitHub CLI. GITHUB-API-MIGRATION-SPEC.md's SC-502 forbids exactly that,
 * and SC-502 was TICKED over it for the criterion's whole life.
 *
 * How it survived is the point. The call put the exec on one line and the
 * command on the next, so every line-oriented search for it found nothing —
 * "a detector narrower than what it detects", the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. #327 classified SC-502
 * "satisfied, needs a test" on the strength of one of those searches. The
 * test it implied found the violation on its first run.
 *
 * SC-502 also carried a `(behavioral)` tag, which exempted it from every
 * mechanical check. A mechanical absence check wearing a behavioural tag is
 * the worst of both: nothing runs it, and its tick reads as proof. The tag
 * is removed in this change because the criterion is mechanically checkable
 * and always was.
 *
 * ## Why these cases use a stub and not the source text
 *
 * SC-4 of the issue asks for it by name, and the reason is this issue's own
 * history: a source-text search is exactly what could not see the call. So
 * the read is DRIVEN — against a fake Octokit — rather than asserted to
 * exist. `test/ticked-sc-cover.test.ts` keeps the absence scan; this keeps
 * the behaviour.
 */
import { describe, expect, test } from "bun:test";

import { join } from "path";

import { getIssueLabels } from "../lib/github";
import {
  LABEL_FIXTURE_ENV,
  plantedLabelRead,
  proveLabelGateVerdict,
  proveLabelViolation,
} from "../lib/prove-label-gate";

/** A fake Octokit that records what it was asked for. */
function stubClient(labels: unknown, seen: Record<string, unknown> = {}) {
  return {
    rest: {
      issues: {
        get: async (params: Record<string, unknown>) => {
          Object.assign(seen, params);
          return { data: { labels } };
        },
      },
    },
  } as never;
}

describe("SC-1416: labels are read through Octokit, with the inputs as arguments", () => {
  test("the owner, repo and issue number arrive as fields rather than a command", async () => {
    // The injection half of #395. Both values come out of workflow state and
    // used to be interpolated into a shell string; here they can only land
    // in named parameters, so there is no command line to break out of.
    const seen: Record<string, unknown> = {};
    await getIssueLabels(stubClient([{ name: "proven" }], seen), "hornjason/pai-harness", 395);
    expect(seen).toMatchObject({
      owner: "hornjason",
      repo: "pai-harness",
      issue_number: 395,
    });
  });

  test("a shell-shaped repo slug is refused outright", async () => {
    // Stronger than the old call could be, and stronger than this case was
    // first written to expect: `parseOwnerRepo` VALIDATES the slug rather
    // than passing it through to a parameter. Under the subprocess the same
    // text was concatenated into a command; here it never reaches the API.
    const seen: Record<string, unknown> = {};
    await expect(
      getIssueLabels(stubClient([], seen), "owner/repo; rm -rf /", 1),
    ).rejects.toThrow(/Invalid repo format/);
    expect(seen, "a malformed slug still reached the client").toEqual({});
  });

  test("a well-formed slug is NOT refused", async () => {
    // The positive control for the case above. A validator that rejected
    // everything would satisfy it and break every real call.
    await expect(
      getIssueLabels(stubClient([{ name: "x" }]), "owner/repo", 1),
    ).resolves.toEqual(["x"]);
  });

  test("label objects and bare strings both come back as names", async () => {
    // The API returns either shape. A reader that handled only one would
    // return an empty list for the other — and an empty list is indistinguishable
    // from an issue with no labels, so the gate would pass over a blocked issue.
    expect(
      await getIssueLabels(stubClient([{ name: "needs-prove" }, "proven"]), "o/r", 1),
    ).toEqual(["needs-prove", "proven"]);
  });

  test("a malformed labels payload yields no names rather than throwing", async () => {
    expect(await getIssueLabels(stubClient(null), "o/r", 1)).toEqual([]);
    expect(await getIssueLabels(stubClient([{}, 3, "", "ok"]), "o/r", 1)).toEqual(["ok"]);
  });
});

describe("SC-1417: the decision is one predicate over a list of names", () => {
  test("needs-prove without proven is refused, and the refusal says what to do", () => {
    const refusal = proveLabelViolation(["needs-prove", "bug"]);
    expect(refusal).toBeTruthy();
    expect(refusal, "the refusal does not name the step that clears it").toContain("/prove");
  });

  test("needs-prove WITH proven is allowed", () => {
    // The positive control. A predicate that refused whenever `needs-prove`
    // was present would satisfy the case above and block every proven issue.
    expect(proveLabelViolation(["needs-prove", "proven"])).toBeNull();
  });

  test("an issue carrying neither label is allowed", () => {
    expect(proveLabelViolation([])).toBeNull();
    expect(proveLabelViolation(["bug", "follow-up"])).toBeNull();
  });

  test("proven alone is allowed — it is not a requirement on its own", () => {
    expect(proveLabelViolation(["proven"])).toBeNull();
  });

  test("the match is exact, not a substring", () => {
    // `needs-proven` and `not-proven` are not these labels. A substring rule
    // would read `needs-proven` as both set and satisfied at once.
    expect(proveLabelViolation(["needs-proven"])).toBeNull();
    expect(proveLabelViolation(["needs-prove", "not-proven"])).toBeTruthy();
  });
});

describe("SC-1418: read and decision compose the way the gate uses them", () => {
  // No comma in this title on purpose: SC-1418 quotes it verbatim, and the
  // conformity parser splits an SC's token list on commas, so a comma here
  // would silently become two tokens neither of which appears in the file.
  test("a blocked issue - end to end from the API payload", async () => {
    // The two halves are separate so each can be mutated; this is the one
    // case that proves they still meet. Driving only the predicate would
    // leave a reader that returns [] looking exactly like a clean issue.
    const labels = await getIssueLabels(
      stubClient([{ name: "needs-prove" }, { name: "bug" }]),
      "o/r",
      1,
    );
    expect(proveLabelViolation(labels)).toBeTruthy();
  });

  test("a proven issue - end to end from the API payload", async () => {
    const labels = await getIssueLabels(
      stubClient([{ name: "needs-prove" }, { name: "proven" }]),
      "o/r",
      1,
    );
    expect(proveLabelViolation(labels)).toBeNull();
  });
});

// ── SC-1489 / SC-1490 (#405) ────────────────────────────────────────────────

/** A fake Octokit whose read rejects. */
function throwingClient(message: string) {
  return {
    rest: {
      issues: {
        get: async () => { throw new Error(message); },
      },
    },
  } as never;
}

const GATE_CHECK = 'test("prove-label-enforcement: needs-prove requires proven label"';

/**
 * The source of the gate check itself, bounded and asserted non-empty.
 *
 * Two source-text guards below read this. A slice whose start index is `-1`,
 * or whose end lands before its start, is an empty string that satisfies
 * every `.not.toMatch` in the file — the guard's view of the input shrinking
 * to nothing while reporting clean. So the bounds are checked here, once,
 * rather than being a precondition each caller has to remember.
 */
function gateCheckBody(): string {
  const src = require("fs").readFileSync(join(import.meta.dir, "..", "gates", "workflow.test.ts"), "utf-8");
  const from = src.indexOf(GATE_CHECK);
  if (from < 0) throw new Error(`the prove-label gate check moved: ${GATE_CHECK} is not in gates/workflow.test.ts`);
  const to = src.indexOf("\n  });", from);
  if (to < from) throw new Error("the prove-label gate check has no end — the slice would be the rest of the file");
  return src.slice(from, to);
}

/** The gate's own sequence: try the read, hand whatever happened to the verdict. */
async function driveGate(client: never, tokenPresent: boolean) {
  try {
    return proveLabelGateVerdict({
      labels: await getIssueLabels(client, "hornjason/pai-harness", 405),
      tokenPresent,
    });
  } catch (error) {
    return proveLabelGateVerdict({ error, tokenPresent });
  }
}

describe("SC-1489: an authenticated read that fails REFUSES rather than passing", () => {
  test("a throwing client with a token present blocks the gate", async () => {
    // The whole of #405. This was `catch { return }`, so this case was a pass.
    // Driven through the real `getIssueLabels` so the rejection travels the
    // path the gate travels, rather than being handed in as a value.
    const outcome = await driveGate(throwingClient("API rate limit exceeded"), true);
    expect(outcome.verdict).toBe("REFUSE");
    expect(outcome.message).toContain("a token was present");
    expect(outcome.message, "the reason has to survive into the output").toContain("API rate limit exceeded");
  });

  test("the refusal says which fact it is, not just that something went wrong", () => {
    // SC-1. "No blocking label" and "could not find out" must be
    // distinguishable or the next person debugging a blocked ship has
    // nothing to go on.
    const unreadable = proveLabelGateVerdict({ error: new Error("ENOTFOUND"), tokenPresent: true });
    const labelled = proveLabelGateVerdict({ labels: ["needs-prove"], tokenPresent: true });
    expect(unreadable.verdict).toBe("REFUSE");
    expect(labelled.verdict).toBe("REFUSE");
    expect(unreadable.message).not.toBe(labelled.message);
    expect(unreadable.message).toContain("could not be read");
    expect(labelled.message).toContain("needs-prove");
  });

  test("a successful read still decides on the labels", async () => {
    // The control. "Always refuse" would satisfy both cases above and turn
    // the gate into a block on every run.
    expect((await driveGate(stubClient([{ name: "proven" }, { name: "needs-prove" }]), true)).verdict).toBe("ALLOW");
    expect((await driveGate(stubClient([{ name: "needs-prove" }]), true)).verdict).toBe("REFUSE");
    expect((await driveGate(stubClient([]), true)).verdict).toBe("ALLOW");
  });
});

describe("SC-1490: a token-less environment is UNMEASURED, which is not clean", () => {
  test("no token yields UNMEASURED rather than ALLOW", async () => {
    const outcome = await driveGate(throwingClient("GITHUB_TOKEN environment variable is not set"), false);
    expect(outcome.verdict, "a token-less run must not read as a pass").toBe("UNMEASURED");
    expect(outcome.verdict).not.toBe("ALLOW");
  });

  test("the UNMEASURED message says why it is not clean", () => {
    const outcome = proveLabelGateVerdict({ error: new Error("no token"), tokenPresent: false });
    expect(outcome.message).toContain("UNMEASURED, not clean");
    expect(outcome.message).toContain("needs-prove");
  });

  test("the three verdicts are three, not two wearing three names", () => {
    const verdicts = new Set([
      proveLabelGateVerdict({ labels: [], tokenPresent: true }).verdict,
      proveLabelGateVerdict({ labels: ["needs-prove"], tokenPresent: true }).verdict,
      proveLabelGateVerdict({ error: new Error("x"), tokenPresent: false }).verdict,
    ]);
    expect(verdicts).toEqual(new Set(["ALLOW", "REFUSE", "UNMEASURED"]));
  });

  test("the gate reads tokenPresent from resolveGitHubToken, not a second env read", () => {
    // Two deciders of "is there a token" survive any mutation of either, and
    // `resolveGitHubToken` already trims — a `GH_TOKEN` with a trailing
    // newline is present to a bare `process.env` check and rejected by the
    // API, which is the exact pair of answers that must not diverge.
    expect(gateCheckBody()).toContain("const tokenPresent = Boolean(resolveGitHubToken())");
  });

  test("the gate no longer swallows the read", () => {
    const body = gateCheckBody();

    // The load-bearing assertions here are the POSITIVE ones. The first draft
    // of this test asserted `.not.toMatch(/catch\s*\{[^}]*\breturn;\s*\}/)`
    // and scored ZERO against the mutation that restores the fail-open,
    // because the real source reads `catch (e) {` and the pattern demanded
    // `catch {`. That is shape two in
    // `.claude/rules/checks-must-be-able-to-fail.md` — a detector narrower
    // than what it detects — and a negative text match is the easiest place
    // in the tree to write one, because it is green both when the defect is
    // absent and when the detector is blind.
    //
    // So this asserts what the code must CONTAIN instead. `catch { return }`
    // cannot be reintroduced without deleting the line that hands the failure
    // to the decider, and a reformat that defeats these strings turns the
    // test red rather than quietly blind.
    expect(body, "the catch must route the read failure to proveLabelGateVerdict, not swallow it")
      .toContain("read = { error: e, tokenPresent }");
    expect(body, "the verdict must be computed from the read, unconditionally")
      .toContain("const outcome = proveLabelGateVerdict(read)");

    // Nothing may return between the read and the verdict: that is the
    // fail-open, whatever shape its catch clause is written in. The
    // UNMEASURED branch's own `return` sits after the verdict and is the
    // reported outcome, not a swallowed one, so it is outside this slice.
    const from = body.indexOf("try {");
    const to = body.indexOf("const outcome = proveLabelGateVerdict(read)");
    expect(from, "the read is gone").toBeGreaterThan(-1);
    expect(to, "the verdict call is gone").toBeGreaterThan(from);
    expect(body.slice(from, to), "an early return between the read and the verdict is the #405 fail-open")
      .not.toMatch(/\breturn\s*;/);
  });
});

/**
 * SC-1491 — the fixture seam supplies the input and never the verdict.
 *
 * The contract test needs a readable issue and cannot have one: its fixture
 * names `test/repo`, which 404s, and before #405 that 404 was swallowed. A
 * seam that let a fixture buy a pass would be the fail-open wearing a test's
 * clothes, so what it plants is a label list and `proveLabelViolation` still
 * judges it.
 */
describe("SC-1491: the planted label read is an input, not a bypass", () => {
  test("no env var set means read GitHub", () => {
    expect(plantedLabelRead({})).toBeNull();
    expect(plantedLabelRead({ [LABEL_FIXTURE_ENV]: "" })).toBeNull();
  });

  test("a planted list is returned as a successful read", () => {
    expect(plantedLabelRead({ [LABEL_FIXTURE_ENV]: '["proven"]' })).toEqual({
      labels: ["proven"],
      tokenPresent: true,
    });
  });

  test("a planted needs-prove still REFUSES", () => {
    const read = plantedLabelRead({ [LABEL_FIXTURE_ENV]: '["needs-prove"]' })!;
    const outcome = proveLabelGateVerdict(read);
    expect(outcome.verdict).toBe("REFUSE");
    expect(outcome.message).toContain("Run /prove");
  });

  test("there is no value of the variable that allows a needs-prove issue", () => {
    // The seam's whole defence. Anything that is not a label list throws, and
    // a label list carrying `needs-prove` without `proven` refuses — so the
    // only way past the check is to plant the labels that would pass a live
    // read anyway.
    for (const raw of ['["needs-prove"]', '["needs-prove","other"]']) {
      expect(proveLabelGateVerdict(plantedLabelRead({ [LABEL_FIXTURE_ENV]: raw })!).verdict).toBe("REFUSE");
    }
    expect(proveLabelGateVerdict(plantedLabelRead({ [LABEL_FIXTURE_ENV]: '["needs-prove","proven"]' })!).verdict)
      .toBe("ALLOW");
  });

  test("malformed content throws rather than falling back to the live read", () => {
    // A typo'd fixture that silently became a network call is this issue's
    // own defect one level up: the caller would believe it planted something.
    expect(() => plantedLabelRead({ [LABEL_FIXTURE_ENV]: "needs-prove" })).toThrow(/not valid JSON/);
    expect(() => plantedLabelRead({ [LABEL_FIXTURE_ENV]: '{"a":1}' })).toThrow(/array of label strings/);
    expect(() => plantedLabelRead({ [LABEL_FIXTURE_ENV]: "[1,2]" })).toThrow(/array of label strings/);
  });

  test("no shipping path sets the variable", () => {
    // A fixture seam a shipping path can reach is a bypass. The gate READS it
    // — that is the one permitted mention, and it is in the file this test
    // already reads — so the scan is for assignment, anywhere under the dirs
    // that run in production.
    const { execFileSync } = require("child_process");
    const root = join(import.meta.dir, "..");
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        ["-rn", "--include=*.ts", "--include=*.js", `${LABEL_FIXTURE_ENV}=`, "lib", "gates", "scripts", "workflows", "hooks", "bin"],
        { cwd: root, encoding: "utf-8" },
      );
    } catch {
      hits = ""; // grep exits 1 on no matches, which is the passing case
    }
    expect(hits.trim(), `${LABEL_FIXTURE_ENV} is set by a shipping path — that is a bypass`).toBe("");
  });
});
