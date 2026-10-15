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

import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { getIssueLabels } from "../lib/github";
import { proveLabelGateVerdict, proveLabelViolation } from "../lib/prove-label-gate";

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
 * SC-1491 — the gate check EXECUTED, over planted state, in both environments.
 *
 * Everything above drives `proveLabelGateVerdict` directly, which proves the
 * decision and not the wiring. The #405 defect was in the wiring: the
 * decision never ran. So the real check is spawned here the way #224 spawns
 * the suite-verdict check — `bun test gates/workflow.test.ts -t <name>`
 * against a planted `workflow-state.json` — and the two environments that
 * disagreed are run as a pair.
 *
 * `test/contract.test.ts` cannot make this observation: `run-gate.ts` prints
 * a batch summary and records detail only for failures, so a passing check's
 * stderr never reaches it.
 */
describe("SC-1491: the gate check, spawned over planted state", () => {
  const PLANT = join(tmpdir(), "rungate-405-gate-check");

  function runCheck(env: Record<string, string>) {
    mkdirSync(PLANT, { recursive: true });
    writeFileSync(
      join(PLANT, "workflow-state.json"),
      // `test/repo` does not exist, which is the point: no token means the
      // read cannot happen at all, and a token means it happens and fails.
      JSON.stringify({ phase: "SHIP", issue: 9998, repo: "test/repo", issueRepo: "test/repo" }),
    );
    const r = spawnSync(
      "bun",
      ["test", join(import.meta.dir, "..", "gates", "workflow.test.ts"), "-t", "prove-label-enforcement"],
      {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, TEST_WORK_DIR: PLANT, GITHUB_TOKEN: "", GH_TOKEN: "", ...env },
      },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // A `-t` filter that matched nothing leaves bun reporting zero of
    // everything, which is indistinguishable from the check passing. #224's
    // lesson: go through "it ran" before reading any verdict out of it.
    const ran = Number(out.match(/(\d+) pass/)?.[1] ?? 0) + Number(out.match(/(\d+) fail/)?.[1] ?? 0);
    expect(ran, `the check did not run — the -t filter matched nothing:\n${out}`).toBe(1);
    return { out, failed: /\s1 fail/.test(out) };
  }

  test("with no token it reports UNMEASURED and does not fail the gate", () => {
    const { out, failed } = runCheck({});
    expect(failed, "a token-less run must not block every local gate").toBe(false);
    // The report is the whole difference between UNMEASURED and SKIP. A
    // check that returned silently would pass this gate identically, and
    // that silence is #405.
    // Line-anchored, because a failing bun test echoes the source around the
    // failure and the `console.error` call itself is in that listing. A bare
    // `toContain` would match the code that prints the line instead of the
    // line, which is a detector reading its own target's source.
    expect(out, "an unreported skip is indistinguishable from a pass")
      .toMatch(/^PROVE_LABEL_UNMEASURED: prove-label was NOT checked/m);
    expect(out).toContain("no GITHUB_TOKEN or GH_TOKEN");
  }, { timeout: 130_000 });

  test("with a token present the same unreadable issue REFUSES", () => {
    // The control. Same state, same unreachable repo, one variable changed.
    // Whatever the credential does — 401, 404, no route to host — the read
    // did not answer and a token says it should have.
    const { out, failed } = runCheck({ GITHUB_TOKEN: "NOT-A-REAL-TOKEN-0123456789" });
    expect(failed, `an authenticated read that failed must block:\n${out}`).toBe(true);
    expect(out).toContain("could not find out");
    expect(out, "a refusal must not be reported as unmeasured")
      .not.toMatch(/^PROVE_LABEL_UNMEASURED: prove-label was NOT checked/m);
  }, { timeout: 130_000 });
});
