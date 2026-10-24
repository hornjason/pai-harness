/**
 * The unmeasured classifier runs by itself, end to end (#1488).
 *
 * #1486 built `classifyUnmeasuredRound` and proved it at the library level.
 * What it could not do was run: the only thing invoking it was a script a
 * person types, and the evidence it reads — a finished run's full Actions
 * job log — expires. A classifier nobody runs and a classifier that finds
 * nothing produce the same ledger.
 *
 * So every case here drives the GENERATED WORKFLOW'S OWN `run:` text,
 * extracted from the YAML this repository ships, through `bash -e` with a
 * stub `gh` and a stub `bunx`, over a planted ledger comment. The classifier
 * underneath is the real one, the splice is the real one, and what is
 * asserted is the body of the PATCH that leaves the job.
 *
 * ## What is NOT faked
 *
 * The `bunx` stub does not stand in for the recorder — it dispatches to
 * `scripts/record-ai-review-unmeasured.ts`, which is what `bunx rungate@<v>
 * record-ai-review-unmeasured` resolves to for a consumer, and it REFUSES
 * any other command name with its own exit code (AC-0). So a generated
 * workflow naming a command the registry does not carry fails here rather
 * than in somebody's repository.
 *
 * ## The mutation, and what it is pointed at
 *
 * AC-9 builds a mutant of that same `run:` text with the recorder
 * invocation replaced by `true` — the workflow present, triggered, green,
 * and calling nothing. Both halves are asserted in one case against one
 * input: the real script PATCHes a discriminator onto the round, the mutant
 * sends no PATCH at all. Without the second half, a workflow that silently
 * fails to run is indistinguishable from one that found nothing to classify,
 * which is the defect #1486 exists to fix, reintroduced in the delivery
 * mechanism.
 *
 * The mutation is also asserted to have APPLIED. A mutant whose edit matched
 * nothing runs the real command and goes green for the wrong reason —
 * `.claude/rules/checks-must-be-able-to-fail.md`, seventh shape.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_REVIEW_DECLINE_LOG_LINE,
  AI_REVIEW_LEDGER_UNMEASURED_KEY,
  AI_REVIEW_UNMEASURED_DECLINED,
  AI_REVIEW_UNMEASURED_LOG_UNREADABLE,
  AI_REVIEW_UNMEASURED_NO_PAYLOAD,
} from "../lib/ai-review-unmeasured.ts";
import { AI_REVIEW_LEDGER_COMMENT_MARKER } from "../lib/ai-review-rounds.ts";
import { CLI_COMMANDS } from "../lib/cli-commands.ts";
import {
  AI_REVIEW_UNMEASURED_COMMAND,
  AI_REVIEW_UNMEASURED_JOB,
  AI_REVIEW_UNMEASURED_REPO_VAR,
  AI_REVIEW_UNMEASURED_SHA_VAR,
  AI_REVIEW_UNMEASURED_WORKFLOW_FILE,
  AI_REVIEW_WORKFLOW_NAME,
} from "../lib/scaffold/ai-review-unmeasured-workflow.ts";
import { ownedFileFor } from "../lib/scaffold/owned-files.ts";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const RECORDER = join(ROOT, "scripts", "record-ai-review-unmeasured.ts");

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PR = 77;
const REPO_SLUG = "o/r";
const COMMENT_ID = 5;

/** The shipped workflow, as bytes. */
function shippedWorkflow(): string {
  return readFileSync(join(WORKFLOWS, AI_REVIEW_UNMEASURED_WORKFLOW_FILE), "utf8");
}

/**
 * The step's `run:` text, taken out of the shipped YAML by a YAML parser.
 *
 * Not a slice and not the builder's return value. A block scalar's
 * indentation is stripped by the parser, so this is the exact string the
 * Actions runner hands to `bash`, and reading it this way is what makes a
 * workflow whose YAML stopped parsing a red case rather than a silent one.
 */
function runScript(): string {
  const doc = Bun.YAML.parse(shippedWorkflow()) as any;
  const job = doc?.jobs?.[AI_REVIEW_UNMEASURED_JOB];
  expect(job, `the shipped workflow has no \`${AI_REVIEW_UNMEASURED_JOB}\` job`).toBeTruthy();
  const withRun = (job.steps as any[]).filter(s => typeof s?.run === "string");
  expect(withRun.length, "the job has no run: step").toBe(1);
  return withRun[0].run as string;
}

/**
 * The `on:` block of a parsed workflow.
 *
 * `on` is a YAML 1.1 boolean, so a parser may hand it back under the key
 * `true` rather than `"on"`. `Object.entries` stringifies both, which is why
 * this reads the entries rather than indexing — and why a parser changing
 * its mind about that cannot make these cases vacuous.
 */
function triggers(doc: unknown): any {
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (k === "on" || k === "true") return v;
  }
  throw new Error("the workflow has no on: block");
}

/**
 * The same text with the recorder invocation replaced by `true`.
 *
 * The command is backslash-continued, so the span is "the line that starts
 * the call, plus every line the previous one continued into". Spelling it
 * that way rather than matching the whole call as one regex means a later
 * change to the flags cannot make the mutation quietly match nothing — and
 * the caller asserts the text moved in any case.
 */
function withoutRecorderCall(script: string): string {
  const lines = script.split("\n");
  const at = lines.findIndex(l => l.trimStart().startsWith("bunx "));
  if (at === -1) return script;
  let end = at;
  while (end < lines.length - 1 && lines[end].trimEnd().endsWith("\\")) end++;
  return [...lines.slice(0, at), "true", ...lines.slice(end + 1)].join("\n");
}

/** A ledger comment body in the shape the persist step writes. */
function ledgerBody(rounds: unknown[]): string {
  return [
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify({ rounds, truncated: 0 }, null, 2),
    "```",
  ].join("\n");
}

/** An unmeasured round: `findings: null`, with a run id to fetch a log for. */
function unmeasuredRound(over: Record<string, unknown> = {}) {
  return { round: 1, run: "40047304108", attempt: "1", sha: SHA, findings: null, ...over };
}

/** A measured round: `findings` is an array, so there is nothing to classify. */
function measuredRound(over: Record<string, unknown> = {}) {
  return { round: 2, run: "40047304109", attempt: "1", sha: SHA, findings: [], ...over };
}

const DECLINED_LOG =
  `ai-review\tRun the AI review\t2026-10-23T00:00:00Z ##[warning]${AI_REVIEW_DECLINE_LOG_LINE}: Workflow validation failed.\n` +
  "ai-review\tRun the AI review\t2026-10-23T00:00:01Z Exiting due to workflow validation skip\n";

const REVIEWED_LOG =
  "ai-review\tRun the AI review\t2026-10-23T00:00:00Z Running Claude Code\n" +
  "ai-review\tRun the AI review\t2026-10-23T00:04:11Z Done\n";

interface Rig {
  /** The rounds the planted ledger comment holds. */
  rounds?: unknown[];
  /** The full job log every `gh run view --log` answers with. `null` fails it. */
  log?: string | null;
  /** What the commits→pulls endpoint lists. `null` makes that call fail. */
  pulls?: number[] | null;
  /** The head sha the workflow_run payload carried. */
  headSha?: string;
  /** Plant no ledger comment at all. */
  noLedger?: boolean;
  /** The script under test — defaulted, so the mutant runs the identical rig. */
  script?: string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every argument of every `gh` invocation, one per line. */
  ghArgv: string[];
  /** The comment body that was PATCHed, or null if nothing was sent. */
  patchedBody: string | null;
  /** The rounds inside that body. */
  patchedRounds: any[] | null;
}

function runWorkflowStep(rig: Rig = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-unmeasured-wf-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);

    const ghArgvPath = join(dir, "gh-argv.txt");
    const patchPath = join(dir, "patch-body.txt");
    const logPath = join(dir, "job.log");
    const commentsPath = join(dir, "comments.jsonl");
    const pullsPath = join(dir, "pulls.txt");

    // Fixtures reach the stub through FILES, never through a shell. A ledger
    // body contains ```json fences, and backticks interpolated into a
    // `printf` become command substitution — the mistake that made six
    // correct rows of `test/ai-review-ledger-step.test.ts` fail against a
    // correct script. A file cannot be mangled.
    const log = rig.log === undefined ? DECLINED_LOG : rig.log;
    if (log !== null) writeFileSync(logPath, log);
    const rounds = rig.rounds ?? [unmeasuredRound()];
    if (!rig.noLedger) {
      writeFileSync(
        commentsPath,
        `${JSON.stringify({ id: COMMENT_ID, body: ledgerBody(rounds) })}\n`,
      );
    } else {
      writeFileSync(commentsPath, "");
    }
    const pulls = rig.pulls === undefined ? [PR] : rig.pulls;
    if (pulls !== null) writeFileSync(pullsPath, pulls.map(String).join("\n"));

    const gh = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" >> ${JSON.stringify(ghArgvPath)}`,
      // `gh run view <id> --log` — the FULL log of one finished run.
      'if [ "$1" = "run" ]; then',
      log === null
        ? '  echo "log expired" >&2; exit 1'
        : `  cat ${JSON.stringify(logPath)}; exit 0`,
      "fi",
      // A write is told from a read the way the script tells them apart.
      "mode=read",
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--method" ]; then mode="$a"; fi',
      '  case "$a" in body=*) printf "%s" "${a#body=}" > ' +
        JSON.stringify(patchPath) +
        ";; esac",
      '  prev="$a"',
      "done",
      'if [ "$mode" != "read" ]; then printf "{}"; exit 0; fi',
      // The two reads, told apart by the path. `*/pulls` is the commit→pull
      // request resolution; everything else is the comment list.
      'for a in "$@"; do',
      '  case "$a" in',
      `    */pulls) ${
        pulls === null ? 'echo "not found" >&2; exit 1' : `cat ${JSON.stringify(pullsPath)}`
      }; exit 0;;`,
      `    */comments) cat ${JSON.stringify(commentsPath)}; exit 0;;`,
      "  esac",
      "done",
      'echo "gh stub: unhandled $*" >&2',
      "exit 90",
    ].join("\n");
    writeFileSync(join(bin, "gh"), `${gh}\n`, { mode: 0o755 });

    // The registry lookup a consumer's runner performs, performed for real
    // enough to fail: the package must be `rungate@<something>` and the
    // command must be one this stub knows how to resolve.
    const bunx = [
      "#!/usr/bin/env bash",
      'case "$1" in rungate@*) ;; *) echo "bunx stub: not a rungate package: $1" >&2; exit 97;; esac',
      'cmd="$2"',
      "shift 2",
      `case "\${cmd}" in`,
      `  ${AI_REVIEW_UNMEASURED_COMMAND}) exec bun ${JSON.stringify(RECORDER)} "$@";;`,
      '  *) echo "bunx stub: rungate has no command ${cmd}" >&2; exit 98;;',
      "esac",
    ].join("\n");
    writeFileSync(join(bin, "bunx"), `${bunx}\n`, { mode: 0o755 });

    const scriptPath = join(dir, "step.sh");
    writeFileSync(scriptPath, rig.script ?? runScript());

    const r = spawnSync("bash", ["-e", scriptPath], {
      cwd: dir,
      env: {
        // `bun` itself has to stay reachable: the stub execs the recorder.
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        [AI_REVIEW_UNMEASURED_REPO_VAR]: REPO_SLUG,
        [AI_REVIEW_UNMEASURED_SHA_VAR]: rig.headSha === undefined ? SHA : rig.headSha,
        GH_TOKEN: "t",
      },
      encoding: "utf8",
      timeout: 120_000,
    });

    const ghArgv = existsSync(ghArgvPath)
      ? readFileSync(ghArgvPath, "utf8").split("\n").filter(Boolean)
      : [];
    const patchedBody = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null;
    let patchedRounds: any[] | null = null;
    if (patchedBody !== null) {
      const fenced = patchedBody.split("```json")[1]?.split("```")[0];
      const doc = fenced === undefined ? null : JSON.parse(fenced);
      patchedRounds = Array.isArray(doc) ? doc : (doc?.rounds ?? null);
    }
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      ghArgv,
      patchedBody,
      patchedRounds,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The discriminator recorded on round `i` of the PATCHed ledger. */
function discriminator(r: Run, i = 0): unknown {
  expect(r.patchedRounds, `nothing was PATCHed — stderr: ${r.stderr}`).not.toBeNull();
  return r.patchedRounds![i][AI_REVIEW_LEDGER_UNMEASURED_KEY];
}

describe("#1488 AC-0: the rig is wired to the real thing", () => {
  // The control. Every case below asserts on a PATCH body, and a rig that
  // cannot produce one at all would make each of them fail for a reason
  // that has nothing to do with the property under test.
  test("the default rig reaches the recorder and sends a PATCH", () => {
    const r = runWorkflowStep();
    expect(r.status, `the step failed: ${r.stderr}`).toBe(0);
    expect(r.patchedBody, "no PATCH was sent").not.toBeNull();
    expect(r.ghArgv, "the job log was never fetched").toContain("--log");
  });

  test("the command the workflow names is one the CLI registry carries", () => {
    // The `bunx` stub refuses an unregistered name with exit 98, so a
    // generated workflow invoking a command nobody registered is already a
    // red case above. This states the other direction, against the registry
    // a consumer's `bunx rungate` actually dispatches through.
    expect(Object.keys(CLI_COMMANDS)).toContain(AI_REVIEW_UNMEASURED_COMMAND);
    expect(CLI_COMMANDS[AI_REVIEW_UNMEASURED_COMMAND].script).toBe(
      "scripts/record-ai-review-unmeasured.ts",
    );
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(
      pkg.files,
      "the script is not published, so `bunx rungate` cannot run it in a consumer's repo",
    ).toContain("scripts/record-ai-review-unmeasured.ts");
  });
});

describe("#1488 AC-1/AC-2: both sides of the split, through the workflow", () => {
  // BOTH, against one rig differing in one byte-range. A case checking only
  // the decline passes on a classifier that answers `declined` for
  // everything — which is the conflation this whole feature undoes, so it is
  // the one shape this file may not have.
  test("a log carrying the skip line leaves `declined` on the round", () => {
    const r = runWorkflowStep({ log: DECLINED_LOG });
    expect(r.status).toBe(0);
    expect(discriminator(r)).toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });

  test("the same round without that line leaves `no_payload`", () => {
    const r = runWorkflowStep({ log: REVIEWED_LOG });
    expect(r.status).toBe(0);
    expect(discriminator(r)).toBe(AI_REVIEW_UNMEASURED_NO_PAYLOAD);
  });
});

describe("#1488 AC-3: a log it cannot read is `log_unreadable`, not either real state", () => {
  test("a failed log fetch records the unreadable value by name", () => {
    const r = runWorkflowStep({ log: null });
    expect(r.status).toBe(0);
    const value = discriminator(r);
    expect(value).toBe(AI_REVIEW_UNMEASURED_LOG_UNREADABLE);
    // Said twice, because the whole point is that it is NEITHER of these.
    // "I could not grep" arriving at "I grepped and found nothing" is the
    // same substitution one level up from the one being fixed.
    expect(value).not.toBe(AI_REVIEW_UNMEASURED_NO_PAYLOAD);
    expect(value).not.toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });
});

describe("#1488 AC-4: a round with a payload is untouched", () => {
  test("a measured round gains no key and stays measured", () => {
    const r = runWorkflowStep({ rounds: [measuredRound(), unmeasuredRound({ round: 3 })] });
    expect(r.status).toBe(0);
    const [measured, unmeasured] = r.patchedRounds!;
    expect(Object.hasOwn(measured, AI_REVIEW_LEDGER_UNMEASURED_KEY)).toBe(false);
    expect(measured.findings).toEqual([]);
    // The control: the other round in the same ledger DID gain one, so the
    // absence above is a decision and not a pass that classified nothing.
    expect(unmeasured[AI_REVIEW_LEDGER_UNMEASURED_KEY]).toBe(AI_REVIEW_UNMEASURED_DECLINED);
  });

  test("a ledger of only measured rounds is not written at all", () => {
    const r = runWorkflowStep({ rounds: [measuredRound()] });
    expect(r.status).toBe(0);
    expect(r.patchedBody, "a ledger with nothing to classify was rewritten anyway").toBeNull();
    expect(r.ghArgv, "a log was fetched for a round with a payload").not.toContain("--log");
  });
});

describe("#1488 AC-5: it does not fire on a round that already carries a discriminator", () => {
  test("an already-classified round costs no fetch and no write", () => {
    const r = runWorkflowStep({
      rounds: [unmeasuredRound({ [AI_REVIEW_LEDGER_UNMEASURED_KEY]: AI_REVIEW_UNMEASURED_DECLINED })],
    });
    expect(r.status).toBe(0);
    expect(r.patchedBody, "a settled round was rewritten — this re-writes forever").toBeNull();
    // The stronger half. Re-reading an expired log would turn a reading
    // taken while the log existed into `log_unreadable`, so the fetch must
    // not happen either.
    expect(r.ghArgv, "the log was re-fetched for a round that already had a reading")
      .not.toContain("--log");
  });
});

describe("#1488 AC-6: a commit on no pull request is not a failure", () => {
  test("an empty pull-request list classifies nothing and exits 0", () => {
    const r = runWorkflowStep({ pulls: [] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.patchedBody).toBeNull();
    expect(r.stdout).toContain("on no pull request");
  });

  test("a FAILED pull-request lookup is UNMEASURED and exits non-zero", () => {
    // The pair above. `gh` exiting non-zero and `gh` listing nothing are the
    // same zero-length stdout, and only one of them is a reading.
    const r = runWorkflowStep({ pulls: null });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("UNMEASURED");
  });
});

describe("#1488 AC-7: an absent head sha is UNMEASURED, and says so", () => {
  test("no head_sha warns by name rather than reporting a clean pass", () => {
    const r = runWorkflowStep({ headSha: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.stdout).toContain("::warning");
    expect(r.patchedBody).toBeNull();
    expect(r.ghArgv, "something was asked of the API with no commit to ask about").toEqual([]);
  });
});

describe("#1488 AC-8: this workflow cannot be a required check, by construction", () => {
  // The population `test/merge-group-trigger.test.ts` excludes. That
  // exclusion is only honest while this holds, so it is asserted here rather
  // than written as a sentence in the file that does the excluding.
  test("it is triggered by workflow_run and by nothing a pull request raises", () => {
    const on = triggers(Bun.YAML.parse(shippedWorkflow()));
    expect(Object.keys(on)).toEqual(["workflow_run"]);
    expect(on.workflow_run.types).toEqual(["completed"]);
  });

  test("the subscription names the workflow the generator actually produces", () => {
    // Derived on both sides. A literal here would be a third copy of the
    // name, and a rename would leave this green while the subscription
    // matched nothing — firing never, which looks exactly like firing and
    // finding nothing to classify.
    const subscribed = triggers(Bun.YAML.parse(shippedWorkflow())).workflow_run
      .workflows as string[];
    const producer = Bun.YAML.parse(readFileSync(join(WORKFLOWS, "ai-review.yml"), "utf8")) as any;
    expect(producer.name, "the producing workflow is not named from the shared constant")
      .toBe(AI_REVIEW_WORKFLOW_NAME);
    expect(subscribed).toEqual([producer.name]);
  });

  test("it checks out no code, holding a write permission on a workflow_run event", () => {
    const doc = Bun.YAML.parse(shippedWorkflow()) as any;
    expect(doc.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    });
    const uses = (doc.jobs[AI_REVIEW_UNMEASURED_JOB].steps as any[])
      .map(s => String(s.uses ?? ""))
      .filter(Boolean);
    expect(uses.some(u => u.startsWith("actions/checkout")), "a workflow_run job checks out code")
      .toBe(false);
  });

  test("the scaffold declares it owned, so a consumer's edit is not overwritten in silence", () => {
    const owned = ownedFileFor(`.github/workflows/${AI_REVIEW_UNMEASURED_WORKFLOW_FILE}`);
    expect(owned, "the generator writes a file OWNED_FILES does not name — #631 exactly")
      .not.toBeNull();
    expect(owned!.strategy).toBe("job-preserving");
  });
});

describe("#1488 AC-9: the mutation — the workflow's call made a no-op", () => {
  /**
   * Real red, mutant green, one input.
   *
   * What was broken to make this fail: the `bunx rungate@<v>
   * record-ai-review-unmeasured …` command in the generated step, replaced
   * by `true`. That is a workflow that exists, is subscribed, is triggered,
   * and exits 0 having classified nothing — the state this issue is about,
   * expressed in the delivery mechanism rather than in the classifier.
   */
  test("the real step records a discriminator and the no-op step records none", () => {
    const real = runScript();
    const mutant = withoutRecorderCall(real);

    // The mutation applied. A mutant identical to the original runs the real
    // command, goes green, and witnesses nothing.
    expect(mutant, "the mutation matched nothing — this battery is measuring itself")
      .not.toEqual(real);
    expect(mutant).not.toContain("bunx ");
    expect(real).toContain("bunx ");

    const r = runWorkflowStep({ script: real });
    expect(discriminator(r)).toBe(AI_REVIEW_UNMEASURED_DECLINED);

    const m = runWorkflowStep({ script: mutant });
    expect(m.status, "the mutant did not even run").toBe(0);
    expect(
      m.patchedBody,
      "the no-op step still PATCHed a ledger — this case cannot tell a workflow that " +
        "runs the classifier from one that does not, so it is not a check",
    ).toBeNull();
    expect(m.ghArgv, "the no-op step still talked to the API").toEqual([]);
  });
});
