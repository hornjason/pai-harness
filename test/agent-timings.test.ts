/**
 * Per-call-site agent timing (#227).
 *
 * The run's timing numbers used to come from `stat` on agent-*.jsonl: the
 * transcript file's creation time subtracted from its modification time. That
 * measures a FILE, not a CALL. A transcript that is flushed once at the end
 * reads as zero seconds; one the runtime touches later reads as longer than
 * the call; and a call site that shares a transcript with another is not
 * distinguishable at all. Nothing in the pipeline could tell any of those
 * apart from a real duration, so every "TIMING: x = Ns" line in a ship run was
 * a number nobody could act on.
 *
 * The replacement is a bracket written by the only participant that can
 * observe the call — the agent itself — under the call site's own label, into
 * one artifact per run.
 *
 * That makes the artifact lossy by construction: an agent that dies, is
 * skipped, or ignores the instruction leaves a start with no end. The whole
 * point of these tests is that such a call is reported as UNTERMINATED rather
 * than dropped, because a dropped start is indistinguishable from a call that
 * never happened — which is the same class of defect the stat-based version
 * had, just quieter.
 *
 * What was broken to prove these can fail, run and reverted:
 *   - defaulting `unterminated` to false in summarize() and setting it only
 *     for leftovers turns the "start with no end" tests red;
 *   - dropping leftover pending starts instead of emitting them (the
 *     "silently dropped" shape) turns them red too, with a length mismatch;
 *   - replacing the acorn walk below with a `shipSource.includes("timedAgent")`
 *     grep leaves every AC-1 test green against a ship.js where only ONE call
 *     site was converted — which is why it is a parse and not a grep.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "acorn";

import {
  TIMING_USAGE_EXIT,
  readTimings,
  recordEvent,
  summarize,
} from "../scripts/record-agent-timings.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-agent-timings.ts");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const temps: string[] = [];
function tempArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-timings-"));
  temps.push(dir);
  return join(dir, "nested", "agent-timings.jsonl");
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

// ── AC-2: the artifact round-trips, and a missing end is not a missing call ──

describe("AC-2: the script writes and reads the artifact", () => {
  test("a start and an end become one measured entry", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "start", 1_000);
    recordEvent(artifact, "marcus", "end", 4_500);

    const entries = summarize(readTimings(artifact).records);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent).toBe("marcus");
    expect(entries[0]!.seconds).toBe(3.5);
    expect(entries[0]!.unterminated).toBe(false);
  });

  test("it creates the artifact's directory rather than failing on it", () => {
    // WORK_DIR exists in a real run, but the nested path must not be a
    // precondition nobody checks — a write that throws inside an agent turns
    // into a prompt-following failure attributed to the agent.
    const artifact = tempArtifact();
    recordEvent(artifact, "a", "start", 1);
    expect(readFileSync(artifact, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  test("a start with no matching end is reported as unterminated, not dropped", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "quinn-local-1", "start", 1_000);
    recordEvent(artifact, "rook", "start", 1_100);
    recordEvent(artifact, "rook", "end", 2_100);

    const entries = summarize(readTimings(artifact).records);
    // Both calls are present. The dropped-start bug would leave one.
    expect(entries.map((e) => e.agent).sort()).toEqual(["quinn-local-1", "rook"]);

    const stranded = entries.find((e) => e.agent === "quinn-local-1")!;
    expect(stranded.unterminated).toBe(true);
    expect(stranded.seconds).toBeNull();
    expect(stranded.startedAt).toBe(1_000);
    expect(stranded.endedAt).toBeNull();
  });

  test("unterminated is the default, cleared only by an observed end", () => {
    // Stated separately from the test above because it is the fail-closed
    // direction: a summarizer that starts every entry at `unterminated: false`
    // reports an agent that died mid-task as a completed call with no duration.
    const entries = summarize([{ label: "marcus", event: "start", at: 5 }]);
    expect(entries[0]!.unterminated).toBe(true);
  });

  test("interleaved call sites pair with their own label, not the nearest end", () => {
    // Parallel agents append to one artifact, so file order is interleaved.
    const artifact = tempArtifact();
    recordEvent(artifact, "a", "start", 100);
    recordEvent(artifact, "b", "start", 200);
    recordEvent(artifact, "b", "end", 500);
    recordEvent(artifact, "a", "end", 900);

    const byLabel = Object.fromEntries(
      summarize(readTimings(artifact).records).map((e) => [e.agent, e.seconds]),
    );
    expect(byLabel).toEqual({ a: 0.8, b: 0.3 });
  });

  test("a label used twice produces two entries paired in order", () => {
    // Remediation rounds reuse a label. Collapsing them would silently report
    // one round and hide the other.
    const entries = summarize([
      { label: "collect-worktrees", event: "start", at: 0 },
      { label: "collect-worktrees", event: "end", at: 1_000 },
      { label: "collect-worktrees", event: "start", at: 2_000 },
      { label: "collect-worktrees", event: "end", at: 2_500 },
    ]);
    expect(entries.map((e) => e.seconds)).toEqual([1, 0.5]);
  });

  test("an end with no start is surfaced, not discarded", () => {
    const entries = summarize([{ label: "ghost", event: "end", at: 10 }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.orphanEnd).toBe(true);
    expect(entries[0]!.seconds).toBeNull();
  });

  test("a malformed line is reported rather than skipped past", () => {
    const artifact = tempArtifact();
    mkdirSync(join(artifact, ".."), { recursive: true });
    writeFileSync(
      artifact,
      [
        JSON.stringify({ label: "ok", event: "start", at: 1 }),
        "{not json",
        JSON.stringify({ label: "ok", event: "end", at: 2 }),
        JSON.stringify({ label: "no-event", at: 3 }),
      ].join("\n") + "\n",
    );

    const { records, malformed } = readTimings(artifact);
    expect(records).toHaveLength(2);
    expect(malformed).toHaveLength(2);
    expect(malformed.join(" ")).toContain("{not json");
  });

  test("a missing artifact says so instead of looking like a run with no agents", () => {
    const { records, malformed, missing } = readTimings(tempArtifact());
    expect(missing).toBe(true);
    expect(records).toEqual([]);
    expect(malformed).toEqual([]);
  });
});

describe("AC-2: the CLI the agents are told to run", () => {
  function run(args: string[]) {
    const p = Bun.spawnSync(["bun", SCRIPT, ...args]);
    return {
      code: p.exitCode,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
    };
  }

  test("start / end / report round-trips through the real commands", () => {
    const artifact = tempArtifact();
    expect(run(["start", "--label", "marcus", "--artifact", artifact]).code).toBe(0);
    expect(run(["end", "--label", "marcus", "--artifact", artifact]).code).toBe(0);

    const out = run(["report", "--artifact", artifact, "--json"]);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      timing: Array<{ agent: string; seconds: number | null; unterminated: boolean }>;
    };
    expect(parsed.timing).toHaveLength(1);
    expect(parsed.timing[0]!.agent).toBe("marcus");
    expect(parsed.timing[0]!.unterminated).toBe(false);
    expect(parsed.timing[0]!.seconds).toBeGreaterThanOrEqual(0);
  });

  test("report names the unterminated call sites in its JSON", () => {
    const artifact = tempArtifact();
    run(["start", "--label", "marcus", "--artifact", artifact]);
    const parsed = JSON.parse(run(["report", "--artifact", artifact, "--json"]).stdout) as {
      timing: Array<{ agent: string; unterminated: boolean }>;
      unterminated: string[];
    };
    expect(parsed.unterminated).toEqual(["marcus"]);
    expect(parsed.timing[0]!.unterminated).toBe(true);
  });

  test("a missing --label is a usage refusal, not a nameless record", () => {
    const artifact = tempArtifact();
    const out = run(["start", "--artifact", artifact]);
    expect(out.code).toBe(TIMING_USAGE_EXIT);
    expect(out.stderr).toContain("--label");
  });

  test("an unknown subcommand refuses", () => {
    expect(run(["frobnicate", "--artifact", tempArtifact()]).code).toBe(TIMING_USAGE_EXIT);
  });
});

// ── AC-1: every agent call site in ship.js is bracketed ──

type AstNode = { type: string; start: number; end: number; [k: string]: unknown };

function isNode(v: unknown): v is AstNode {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AstNode).type === "string" &&
    typeof (v as AstNode).start === "number"
  );
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

/**
 * Every call to agent / timedAgent / briefedAgent in ship.js, parsed.
 *
 * Parsed and not grepped on purpose. A grep for "timedAgent" stays green when
 * one call site is converted and thirty-eight are not, and `.claude/rules/
 * checks-must-be-able-to-fail.md` is a list of this repository's own checks
 * that passed for exactly that reason.
 */
function agentCallSites() {
  const tree = parse(shipSource, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  }) as unknown as AstNode;

  const sites: Array<{ callee: string; start: number; opts: AstNode | undefined; line: number }> = [];
  walk(tree, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee as AstNode | undefined;
    if (!callee || callee.type !== "Identifier") return;
    const name = (callee as unknown as { name: string }).name;
    if (name !== "agent" && name !== "timedAgent" && name !== "briefedAgent") return;
    const args = n.arguments as AstNode[];
    sites.push({
      callee: name,
      start: n.start,
      opts: args[1],
      line: shipSource.slice(0, n.start).split("\n").length,
    });
  });
  return sites;
}

const TIMING_START = "// ──── AGENT-TIMING-START ────";
const TIMING_END = "// ──── AGENT-TIMING-END ────";

describe("AC-1: no agent invocation in ship.js escapes the timing bracket", () => {
  test("ship.js carries the AGENT-TIMING markers this test slices by", () => {
    expect(shipSource.indexOf(TIMING_START)).toBeGreaterThan(-1);
    expect(shipSource.indexOf(TIMING_END)).toBeGreaterThan(shipSource.indexOf(TIMING_START));
  });

  test("the only raw agent() call is the one inside the timing wrapper", () => {
    const from = shipSource.indexOf(TIMING_START);
    const to = shipSource.indexOf(TIMING_END);
    const escaped = agentCallSites()
      .filter((s) => s.callee === "agent")
      .filter((s) => !(s.start > from && s.start < to))
      .map((s) => `ship.js:${s.line}`);
    expect(
      escaped,
      `these call sites bypass timedAgent, so they write no start and no end: ${escaped.join(", ")}`,
    ).toEqual([]);
  });

  test("every call site passes a label — the bracket's only key", () => {
    const unlabelled = agentCallSites()
      .filter((s) => s.callee !== "agent")
      .filter((s) => {
        // briefedAgent's two tail calls forward the caller's own options
        // object verbatim — `timedAgent(fullPrompt, opts)`. Their label came
        // from the call site one frame up, which this same test already
        // checked. Only a bare `opts` forward is exempt; anything else built
        // in place has to name its label here.
        if (s.opts && s.opts.type === "Identifier") {
          return (s.opts as unknown as { name: string }).name !== "opts";
        }
        if (!s.opts || s.opts.type !== "ObjectExpression") return true;
        const props = s.opts.properties as AstNode[];
        return !props.some(
          (p) =>
            p.type === "Property" &&
            isNode(p.key) &&
            ((p.key as unknown as { name?: string }).name === "label" ||
              (p.key as unknown as { value?: string }).value === "label"),
        );
      })
      .map((s) => `ship.js:${s.line}`);
    expect(
      unlabelled,
      `a call site with no label cannot be bracketed under a stable name: ${unlabelled.join(", ")}`,
    ).toEqual([]);
  });

  test("there are as many timed call sites as there were agent calls", () => {
    // A conversion that deleted call sites instead of renaming them would pass
    // both tests above. 39 is the count at the time of #227; the number is
    // allowed to grow, and a drop means a spawn went missing.
    const timed = agentCallSites().filter((s) => s.callee !== "agent");
    expect(timed.length).toBeGreaterThanOrEqual(39);
  });

  test("the two call sites #227 names by line are timed", () => {
    // ship.js:1918 (preserveRefusedWork) and ship.js:2072 (collectAgentWork)
    // take their label from the CALLER, so a conversion keyed on literal
    // labels would have skipped exactly these two.
    const bodyOf = (fn: string) => {
      const at = shipSource.indexOf(`async function ${fn}(`);
      expect(at, `ship.js no longer defines ${fn}`).toBeGreaterThan(-1);
      return shipSource.slice(at, at + 6_000);
    };
    for (const fn of ["preserveRefusedWork", "collectAgentWork"]) {
      const body = bodyOf(fn);
      expect(body, `${fn} still calls the untimed agent()`).toContain("await timedAgent(");
      expect(body.slice(0, body.indexOf("await timedAgent("))).not.toContain("await agent(");
    }
  });
});

describe("AC-1: the bracket the wrapper actually emits", () => {
  /** Execute ship.js's real timing block, not a copy of it. */
  function loadTimedAgent(workDir = "/work", harnessRoot = "/harness") {
    const from = shipSource.indexOf(TIMING_START);
    const to = shipSource.indexOf(TIMING_END);
    if (from < 0 || to < 0) throw new Error("AGENT-TIMING markers missing from workflows/ship.js");
    const quote = shipSource.match(/function shellQuote\(word\)[\s\S]*?\n}/);
    if (!quote) throw new Error("ship.js no longer defines shellQuote(word)");

    const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
    const logs: string[] = [];
    // `new Function` over this repository's own workflows/ship.js, read off
    // disk at test time — the established pattern here (the Workflow sandbox
    // makes ship.js unimportable). Never give it a source from anywhere else.
    const factory = new Function(
      "WORK_DIR",
      "HARNESS_ROOT",
      "agent",
      "log",
      `${quote[0]}\n${shipSource.slice(from, to)}\nreturn { timedAgent, timingInstruction, TIMING_ARTIFACT, TIMING_SCRIPT }`,
    );
    const api = factory(
      workDir,
      harnessRoot,
      async (prompt: string, opts: Record<string, unknown>) => {
        calls.push({ prompt, opts: { ...opts } });
        return { ok: true };
      },
      (m: string) => logs.push(m),
    ) as {
      timedAgent: (p: string, o?: Record<string, unknown>) => Promise<unknown>;
      timingInstruction: (label: string) => string;
      TIMING_ARTIFACT: string;
      TIMING_SCRIPT: string;
    };
    return { ...api, calls, logs };
  }

  test("the artifact is one file per run, under the run's work dir", () => {
    expect(loadTimedAgent("/work/.rungate/pai-harness-227").TIMING_ARTIFACT).toBe(
      "/work/.rungate/pai-harness-227/agent-timings.jsonl",
    );
  });

  test("the script ship.js names is the one this test imports", () => {
    // The grade prompt and every agent prompt reach the artifact through these
    // two constants, so they are the link between ship.js and scripts/.
    expect(loadTimedAgent().TIMING_SCRIPT).toBe("/harness/scripts/record-agent-timings.ts");
    expect(SCRIPT.endsWith("/scripts/record-agent-timings.ts")).toBe(true);
  });

  test("a timed call gets a start AND an end for its own label", async () => {
    const { timedAgent, calls } = loadTimedAgent();
    await timedAgent("do the work", { label: "marcus", phase: "Implement" });

    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("do the work");
    expect(prompt).toContain("start --label 'marcus'");
    expect(prompt).toContain("end --label 'marcus'");
    expect(prompt).toContain("/harness/scripts/record-agent-timings.ts");
    expect(prompt).toContain("/work/agent-timings.jsonl");
    expect(prompt.indexOf("start --label")).toBeLessThan(prompt.indexOf("end --label"));
  });

  test("the caller's options reach the agent untouched", async () => {
    const { timedAgent, calls } = loadTimedAgent();
    await timedAgent("x", { label: "rook", phase: "Verify", model: "sonnet" });
    expect(calls[0]!.opts).toEqual({ label: "rook", phase: "Verify", model: "sonnet" });
  });

  test("a label is shell-quoted, so a label with a quote cannot break out", () => {
    const { timingInstruction } = loadTimedAgent();
    expect(timingInstruction("a'; rm -rf /; echo '")).not.toContain("; rm -rf /;\n");
    expect(timingInstruction("a'; rm -rf /; echo '")).toContain("'a'\\''; rm -rf /; echo '\\'''");
  });

  test("an unlabelled call still runs, and says out loud that it is untimed", async () => {
    // Refusing would turn a missing label into a dead ship run; timing it
    // under an invented name would merge two call sites into one row. Neither
    // is acceptable, so it runs and is announced.
    const { timedAgent, calls, logs } = loadTimedAgent();
    await timedAgent("x", {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("x");
    expect(logs.join(" ")).toContain("UNTIMED");
  });
});

// ── AC-4: the stat-based derivation is gone ──

describe("AC-4: the grade agent no longer times files instead of calls", () => {
  const gradeStep = (() => {
    const at = shipSource.indexOf("label: 'grade'");
    expect(at, "ship.js no longer has a grade step").toBeGreaterThan(-1);
    const from = shipSource.lastIndexOf("timedAgent(`", at);
    expect(from, "the grade step is not a timed agent call").toBeGreaterThan(-1);
    return shipSource.slice(from, at);
  })();

  test("it does not stat agent-*.jsonl for durations", () => {
    for (const forbidden of ["stat -f '%B'", "stat -c '%W'", "modified - created"]) {
      expect(gradeStep, `the grade prompt still derives durations by ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  test("it reads the timing artifact instead", () => {
    // The prompt interpolates the two constants rather than restating the
    // paths, so this asserts the wiring; the executed test above pins what
    // those constants resolve to.
    expect(gradeStep).toContain("TIMING_SCRIPT");
    expect(gradeStep).toContain("TIMING_ARTIFACT");
    expect(gradeStep).toContain("report --artifact");
    expect(gradeStep).toContain("unterminated");
  });

  test("the timing schema can carry an unterminated call", () => {
    // Durations now come from a lossy bracket. A schema with no field for
    // "we never saw the end" would force the agent to report a number anyway.
    const schemaFrom = shipSource.indexOf("timing: { type: 'array'");
    expect(schemaFrom, "the grade result no longer declares a timing array").toBeGreaterThan(-1);
    // To the end of this array's items object — `required:` is the last key.
    const schemaTo = shipSource.indexOf("}}", shipSource.indexOf("required:", schemaFrom));
    const timingSchema = shipSource.slice(schemaFrom, schemaTo);
    expect(timingSchema).toContain("unterminated");
    expect(
      timingSchema,
      "`seconds` is still required, so an unterminated call forces the agent to invent a duration",
    ).toContain("required: ['agent']");
  });
});
