/**
 * Covers SC-2052, SC-2053, SC-2054, SC-2055, SC-2056 (HARNESS-STANDARD.md).
 *
 * #614 — an agent-authored evidence command loses every `$`.
 *
 * Run `wf_c92dd0a7-fe6` (issue #600). Discovery authored AC-5's evidence as
 *
 *     grep -rhcE '^export function localCalendarDay' lib | awk '{s+=$1} END {print s+0}'
 *
 * and `workflow-state.json` holds the same command with `$1` GONE:
 *
 *     grep -rhcE '^export function localCalendarDay' lib | awk '{s+=} END {print s+0}'
 *
 * which awk refuses with a syntax error (exit 2). AC-5 could never produce
 * evidence, stayed PENDING, and took the verify gate down with it. The
 * journal's agent-reply lines carry `s+=$1}` intact, so the loss happens after
 * the agent returns and before the state file is written.
 *
 * ## The site
 *
 * `workflows/ship.js` built the setup step as a DOUBLE-QUOTED shell string —
 * `bun -e "…"` — and interpolated `JSON.stringify(discovery.acs…)` straight
 * into it. Inside double quotes the shell expands `$1` (a positional
 * parameter, unset, so empty), `${VAR}`, and `$(cmd)` — the last of which it
 * also EXECUTES. The AC payload is agent-authored text, so this was a
 * corruption channel and an injection channel at once.
 *
 * ## Why these assertions are byte equality and not "contains $1"
 *
 * `toContain("$1")` is satisfied by a command that kept one `$1` of two, and
 * by a command the shell reassembled with different whitespace. The claim is
 * that the string is the same string, so the assertion is `toBe`.
 *
 * ## Why the fixture goes through a real shell
 *
 * The defect is a property of bash's quote removal, and no amount of
 * reasoning about the builder reproduces it. Every round-trip case here
 * RUNS the command ship.js hands the agent, in `bash -c`, and reads the
 * result back off disk. A test that only compared strings in-process would
 * have been green over the whole life of this bug.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AC_PAYLOAD_ARGV_INDEX,
  acPayloadJson,
  acPayloadReadExpression,
  acPayloadRecords,
  acPayloadShellArgument,
  recordEvidenceRewrite,
} from "../lib/evidence-command-transport";
import { autoPopulateACs } from "../gates/gate-executor";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";
import { EvidenceMethodSchema } from "../gates/schema";

const REPO = join(import.meta.dir, "..");
const SHIP = join(REPO, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

// ── the three forms, in one place ───────────────────────────────────────────

/**
 * The `$` forms a shell treats differently, each one a different failure.
 *
 * `$1` is the measured one — it silently becomes the empty string. `${VAR}`
 * substitutes whatever the agent's environment happens to hold. `$(cmd)` is
 * not a corruption at all but an EXECUTION, and it is in this list because a
 * fix that only escaped the first two would leave the worst one open.
 */
const DOLLAR_FORMS: Record<string, string> = {
  "$1": "grep -rhcE '^export function localCalendarDay' lib | awk '{s+=$1} END {print s+0}'",
  "${VAR}": "test -d ${HOME}/.rungate && echo 1 || echo 0",
  "$(cmd)": "echo $(basename lib) && echo \"$(git rev-parse --abbrev-ref HEAD)\"",
};

function acsWithDollarForms(): Array<Record<string, unknown>> {
  return Object.entries(DOLLAR_FORMS).map(([label, command], i) => ({
    id: `AC-${i + 1}`,
    type: "CODE",
    statement: `the ${label} form survives the setup payload round trip intact`,
    threshold: { op: ">=", value: 2 },
    evidenceMethod: { type: "COMMAND", command },
    specElement: "evidence command transport",
    coversCriteria: [`C-${i + 1}`],
    contextFiles: [],
  }));
}

let SCRATCH = "";
let WORK = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "evidence-roundtrip-"));
  WORK = join(SCRATCH, "work");
  mkdirSync(WORK, { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/**
 * Run the setup step the way the agent does: one `bash -c`, with the payload
 * write and the `bun -e "…"` in the same shell, the `bun -e` double-quoted
 * exactly as `workflows/ship.js` writes it.
 *
 * Nothing here escapes anything on the payload's behalf. If the transport is
 * wrong, this is where the `$` disappears.
 */
function runSetupStep(acs: Array<Record<string, unknown>>): {
  state: Record<string, any>;
  stdout: string;
  stderr: string;
  code: number;
} {
  const sf = join(WORK, "workflow-state.json");
  const script =
    `bun -e "\n` +
    `import {initWorkflow, writeACs} from '${REPO}/gates/orchestrator.ts';\n` +
    `const sf = '${sf}';\n` +
    `initWorkflow(sf, {issue: 614, repo: 'hornjason/pai-harness', projectRoot: '${REPO}', slug: 'pai-harness-614', issueGoal: 'evidence commands survive transport'});\n` +
    `writeACs(sf, ${acPayloadReadExpression()});\n` +
    `" ${acPayloadShellArgument(acs)} 2>&1\n`;
  const r = spawnSync("bash", ["-c", script], { cwd: SCRATCH, encoding: "utf-8", timeout: 120000 });
  return {
    state: existsSync(sf) ? JSON.parse(readFileSync(sf, "utf-8")) : {},
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("#614 SC-2052: the setup payload round trip is byte-identical", () => {
  test("$1, ${VAR} and $(cmd) all reach workflow-state.json unchanged", () => {
    const acs = acsWithDollarForms();
    const { state, stdout, code } = runSetupStep(acs);

    // The positive control first. A setup step that died produces no state
    // file, and an absent state file contains no corrupted command — which
    // would read exactly like a clean round trip.
    expect(code, `setup step exited ${code}:\n${stdout}`).toBe(0);
    expect(Array.isArray(state.acs) && state.acs.length, stdout).toBe(3);

    const persisted = Object.fromEntries(
      state.acs.map((ac: any) => [ac.id, ac.evidenceMethod?.command]),
    );
    const labels = Object.keys(DOLLAR_FORMS);
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      expect(
        persisted[`AC-${i + 1}`],
        `the ${label} form did not survive: the shell rewrote the command between the agent and the state file`,
      ).toBe(DOLLAR_FORMS[label]);
    }
  });

  test("the measured #600 command survives verbatim, awk clause and all", () => {
    // The exact string run wf_c92dd0a7-fe6 lost, not a paraphrase of it.
    const authored = DOLLAR_FORMS["$1"];
    const { state, stdout } = runSetupStep([acsWithDollarForms()[0]]);
    const got = state.acs?.[0]?.evidenceMethod?.command;
    expect(got, stdout).toBe(authored);
    expect(got, "the exact corruption #614 is filed for").not.toContain("{s+=}");
  });

  test("a $(cmd) in the payload is not EXECUTED by the transport", () => {
    // The injection half. `$(…)` inside a double-quoted shell string runs;
    // the corruption cases above would all pass for a transport that still
    // executed this one, because its output is not a `$`.
    const canary = join(SCRATCH, "executed-canary.txt");
    const acs = [
      {
        ...acsWithDollarForms()[0],
        evidenceMethod: { type: "COMMAND", command: `echo $(touch ${canary}) done` },
      },
    ];
    const { state, stdout } = runSetupStep(acs);
    expect(existsSync(canary), "the payload's command substitution ran during transport").toBe(false);
    expect(state.acs?.[0]?.evidenceMethod?.command, stdout).toBe(`echo $(touch ${canary}) done`);
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("#614 SC-2053: the execution boundary hands the runner the authored command", () => {
  /**
   * The persisted string and the executed string are different facts.
   * `autoPopulateACs` reads `ac.evidenceMethod.command`, rewrites git refs and
   * writes the result back, and it is what calls `execSync`. A round trip
   * proven only at the state file says nothing about this hop.
   *
   * So each case is witnessed by the command's OUTPUT, which is a value only a
   * command whose `$` survived can produce: `{s+=$1}` with the `$1` gone is an
   * awk syntax error, `${2}` with the `${2}` gone prints an empty line, and
   * `$(expr 3 + 4)` with the substitution gone prints the literal text.
   */
  const EXECUTABLE: Array<{ label: string; command: string; expect: string }> = [
    { label: "$1", command: "printf '3\\n4\\n' | awk '{s+=$1} END {print s+0}'", expect: "7" },
    { label: "${VAR}", command: "sh -c 'set -- 3 4; echo ${2}'", expect: "4" },
    { label: "$(cmd)", command: "echo $(expr 3 + 4)", expect: "7" },
  ];

  test("every $ form is executed, not just persisted, at the execution boundary", () => {
    const sf = join(WORK, "workflow-state.json");
    const state: Record<string, any> = {
      issue: 614,
      projectRoot: REPO,
      acs: EXECUTABLE.map((e, i) => ({
        id: `AC-${i + 1}`,
        type: "CODE",
        statement: `the ${e.label} form reaches the runner intact`,
        threshold: { op: "==", value: e.expect },
        evidenceMethod: { type: "COMMAND", command: e.command },
        verdict: "PENDING",
      })),
    };
    writeFileSync(sf, JSON.stringify(state, null, 2));

    autoPopulateACs(state, sf);

    for (let i = 0; i < EXECUTABLE.length; i++) {
      const e = EXECUTABLE[i];
      const ac = state.acs[i];
      expect(ac.evidenceMethod.command, `${e.label} was rewritten before execution`).toBe(e.command);
      expect(
        ac.evidence?.content,
        `${e.label} did not reach the runner — the runner saw a command this one cannot produce ${e.expect} without`,
      ).toBe(e.expect);
      expect(ac.verdict, `${e.label}`).toBe("PASS");
    }
  });

  test("the authored form is still readable after a legitimate rewrite at this boundary", () => {
    // The one rewrite this hop is allowed to make — `main` to `origin/main`
    // (#118) — must not destroy what the agent wrote. Both forms are on the
    // record afterwards, which is what lets a reader tell a repair from a
    // corruption.
    const sf = join(WORK, "workflow-state.json");
    const authored = "git log main..HEAD --oneline | wc -l | tr -d ' '";
    const state: Record<string, any> = {
      issue: 614,
      projectRoot: REPO,
      acs: [{
        id: "AC-1",
        type: "CODE",
        statement: "a bare main ref is qualified at the execution boundary",
        threshold: { op: ">=", value: 0 },
        evidenceMethod: { type: "COMMAND", command: authored },
        verdict: "PENDING",
      }],
    };
    writeFileSync(sf, JSON.stringify(state, null, 2));

    autoPopulateACs(state, sf);

    const em = state.acs[0].evidenceMethod;
    expect(em.command, "the ref was not qualified at all").toContain("origin/main");
    expect(em.authoredCommand, "the authored form was overwritten and is unrecoverable").toBe(authored);
    expect(em.rewrites?.map((r: any) => r.by)).toContain("normalize-git-refs");
  });
});

// ── AC-3 / AC-4 ─────────────────────────────────────────────────────────────

/**
 * ship.js cannot import (#69), so the decision exists twice — once in
 * `lib/evidence-command-transport.ts` and once in a marked block in the
 * workflow. The #169 / #244 / #306 arrangement applies: extract the inlined
 * copy by marker, run both over one matrix, and make drift red.
 *
 * Module scope on purpose. If the markers are gone this throws and every test
 * in the file fails to load, rather than skipping — which would turn "ship.js
 * lost its payload builder" into a quiet green.
 */
const TRANSPORT_START = "// ──── AC-PAYLOAD-TRANSPORT-START ────";
const TRANSPORT_END = "// ──── AC-PAYLOAD-TRANSPORT-END ────";
const PHASE2_START = "// ──── PHASE2-DECOMPOSITION-START ────";
const PHASE2_END = "// ──── PHASE2-DECOMPOSITION-END ────";

export function markedBlock(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  if (a === -1 || b === -1) {
    throw new Error(`workflows/ship.js is missing the ${start} / ${end} markers`);
  }
  return src.slice(a + start.length, b);
}

const inlined = (() => {
  // The transport block calls `shellSingleQuote`, which ship.js declares in
  // the phase-2 block. Both bodies are loaded so the extracted copy is the
  // one ship.js runs rather than a variant with its quoting stubbed out.
  const body =
    markedBlock(shipSource, PHASE2_START, PHASE2_END) +
    "\n" +
    markedBlock(shipSource, TRANSPORT_START, TRANSPORT_END);
  const fns = new Function(
    `${body}\nreturn { acPayloadRecords, acPayloadJson, acPayloadShellArgument, acPayloadReadExpression, recordEvidenceRewrite, AC_PAYLOAD_ARGV_INDEX }`,
  )();
  for (const name of Object.keys(fns)) {
    if (name === "AC_PAYLOAD_ARGV_INDEX") continue;
    if (typeof fns[name] !== "function") {
      throw new Error(`ship.js's transport block does not define ${name} — the matrix would compare nothing`);
    }
  }
  return fns as {
    acPayloadRecords: typeof acPayloadRecords;
    acPayloadJson: typeof acPayloadJson;
    acPayloadShellArgument: typeof acPayloadShellArgument;
    acPayloadReadExpression: typeof acPayloadReadExpression;
    recordEvidenceRewrite: typeof recordEvidenceRewrite;
    AC_PAYLOAD_ARGV_INDEX: number;
  };
})();

/**
 * Every `$` in `word` that the shell would look at — that is, every one not
 * inside a single-quoted run.
 *
 * Deliberately a scanner rather than a regex. `shellSingleQuote` escapes an
 * apostrophe as `'\''`, which closes and reopens the quoting, so "the whole
 * thing is inside one pair of quotes" is false of a correct argument and
 * asserting it would fail on the very input the escaping exists for.
 */
export function dollarsOutsideSingleQuotes(word: string): number[] {
  const out: number[] = [];
  let quoted = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "'") { quoted = !quoted; continue; }
    if (c === "\\" && !quoted) { i++; continue; }
    if (c === "$" && !quoted) out.push(i);
  }
  return out;
}

describe("#614 SC-2054: the payload builder, driven with a $1-bearing command", () => {
  test("the payload builder emits the whole payload inside single quotes, where no $ expands", () => {
    const acs = acsWithDollarForms();
    const arg = acPayloadShellArgument(acs);
    // Not a style preference. The whole fix is that the payload leaves the
    // generator inside the one construct the shell does not look inside.
    expect(arg.startsWith("'") && arg.endsWith("'"), "the payload is not single-quoted — $ still expands").toBe(true);
    expect(arg.slice(1, -1).includes('"'), "the payload is not carried verbatim").toBe(true);
    // And every `$` is inside a quoted run. A payload split across quoted and
    // unquoted runs — which `'\''` escaping legitimately does — is fine right
    // up until a `$` lands in one of the gaps, and that is the bug wearing a
    // different shape. So the argument is walked the way the shell walks it.
    expect(dollarsOutsideSingleQuotes(arg), "a $ in this payload is exposed to the shell").toEqual([]);
    expect(
      dollarsOutsideSingleQuotes(`echo ${acPayloadJson(acs)}`),
      "the scanner reports nothing even for an unquoted payload — it is not measuring",
    ).not.toEqual([]);
  });

  test("the payload builder survives bash: argv[1] parses back to byte-identical JSON", () => {
    const acs = acsWithDollarForms();
    const r = spawnSync(
      "bash",
      ["-c", `bun -e "console.log(process.argv[${AC_PAYLOAD_ARGV_INDEX}])" ${acPayloadShellArgument(acs)}`],
      { cwd: SCRATCH, encoding: "utf-8", timeout: 60000 },
    );
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout.trimEnd()).toBe(acPayloadJson(acs));
  });

  test("an apostrophe in a statement does not break out of the quoting", () => {
    // The one input single-quoting cannot take verbatim. `shellSingleQuote`
    // closes, escapes and reopens; a builder that forgot would produce a
    // shell syntax error here rather than a corrupted command, which is the
    // failure mode this case exists to keep visible. Evidence commands are
    // full of apostrophes — that is how an awk clause is quoted.
    const acs = [{ ...acsWithDollarForms()[0], statement: "the run's own awk clause isn't dropped" }];
    const { state, stdout } = runSetupStep(acs);
    expect(state.acs?.[0]?.statement, stdout).toBe("the run's own awk clause isn't dropped");
    expect(state.acs?.[0]?.evidenceMethod?.command, stdout).toBe(DOLLAR_FORMS["$1"]);
  });

  test("the setup prompt and the fix-acs fallback both read the payload out of argv", () => {
    // AC-4's count, over both `writeACs` call sites. The grep in the brief is
    // the same question asked from a terminal.
    const raw = [...shipSource.matchAll(/writeACs\([^\n]*\$\{JSON\.stringify\(discovery\.acs/g)];
    expect(raw.map(m => m[0]), "an AC payload is still interpolated raw into shell text").toEqual([]);

    const calls = [...shipSource.matchAll(/writeACs\(([^\n]*)\)/g)].map(m => m[1]);
    expect(calls.length, "the setup prompt and its fix-acs fallback are both expected to call writeACs")
      .toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call, `a writeACs call does not read the payload out of argv: ${call}`)
        .toContain("acPayloadReadExpression()");
    }
  });

  test("every call site that reads argv also passes the payload as an argument", () => {
    // A program reading `process.argv[1]` with nothing appended after the
    // closing quote gets `undefined`, and `JSON.parse(undefined)` throws —
    // loud, but only on a run. The pairing is a fact about the source, so it
    // is read off the source.
    // `\$\{…\}` so the function DECLARATIONS in the marked block are not
    // counted as call sites — a count that includes its own definition
    // cannot be compared against anything.
    const reads = [...shipSource.matchAll(/\$\{acPayloadReadExpression\(\)\}/g)].map(m => m.index!);
    const args = [...shipSource.matchAll(/\$\{acPayloadShellArgument\(discovery\.acs\)\}/g)].map(m => m.index!);
    expect(reads.length, "no call site reads the payload").toBeGreaterThanOrEqual(2);
    expect(args.length, "no call site supplies the payload").toBe(reads.length);
    for (let i = 0; i < reads.length; i++) {
      expect(reads[i], "a call site supplies the payload before the program that reads it")
        .toBeLessThan(args[i]);
    }
  });

  test("the inlined copy and the library agree on every form", () => {
    const acs = acsWithDollarForms();
    expect(inlined.AC_PAYLOAD_ARGV_INDEX).toBe(AC_PAYLOAD_ARGV_INDEX);
    expect(inlined.acPayloadRecords(acs)).toEqual(acPayloadRecords(acs));
    expect(inlined.acPayloadJson(acs)).toBe(acPayloadJson(acs));
    expect(inlined.acPayloadShellArgument(acs)).toBe(acPayloadShellArgument(acs));
    expect(inlined.acPayloadReadExpression()).toBe(acPayloadReadExpression());

    const a = { type: "COMMAND", command: "grep -c x lib | awk '{s+=$1}'" };
    const b = { ...a };
    expect(inlined.recordEvidenceRewrite(a, "t", "echo 1")).toBe(recordEvidenceRewrite(b, "t", "echo 1"));
    expect(a).toEqual(b);
  });
});

// ── AC-6 ────────────────────────────────────────────────────────────────────

describe("#614 SC-2055: rewrite provenance — both forms, at every rewriting site", () => {
  test("recordEvidenceRewrite keeps the FIRST authored form across repeated rewrites", () => {
    // The property that makes the record worth having. A field that holds
    // "whatever it was one rewrite ago" cannot answer the question #614 asks,
    // which is what the AGENT wrote.
    const em: Record<string, any> = { type: "COMMAND", command: "awk '{s+=$1}' a" };
    expect(recordEvidenceRewrite(em, "first", "awk '{s+=$1}' b")).toBe(true);
    expect(recordEvidenceRewrite(em, "second", "awk '{s+=$1}' c")).toBe(true);
    expect(em.authoredCommand).toBe("awk '{s+=$1}' a");
    expect(em.command).toBe("awk '{s+=$1}' c");
    expect(em.rewrites).toEqual([
      { by: "first", from: "awk '{s+=$1}' a", to: "awk '{s+=$1}' b" },
      { by: "second", from: "awk '{s+=$1}' b", to: "awk '{s+=$1}' c" },
    ]);
  });

  test("a no-op rewrite records nothing", () => {
    // The positive control. A recorder that logged every call would make
    // `rewrites` non-empty on every AC and the field would stop meaning
    // "this command was changed".
    const em: Record<string, any> = { type: "COMMAND", command: "echo 1" };
    expect(recordEvidenceRewrite(em, "noop", "echo 1")).toBe(false);
    expect(em.authoredCommand).toBeUndefined();
    expect(em.rewrites).toBeUndefined();
  });

  test("the persisted shape validates — authoredCommand and rewrites are declared", () => {
    // #530: an undeclared key round-trips through `passthrough()` and reads
    // back exactly like a declared one, so the artefact cannot witness this.
    // The schema is the statement about what has a producer.
    const em: Record<string, any> = { type: "COMMAND", command: "echo 1" };
    recordEvidenceRewrite(em, "t", "echo 2");
    const parsed = EvidenceMethodSchema.parse(em);
    expect(parsed.authoredCommand).toBe("echo 1");
    expect(parsed.rewrites).toEqual([{ by: "t", from: "echo 1", to: "echo 2" }]);
  });

  test("a rewrites entry with no authoredCommand beside it is refused", () => {
    expect(() => EvidenceMethodSchema.parse({
      type: "COMMAND", command: "echo 2",
      rewrites: [{ by: "t", from: "echo 1", to: "echo 2" }],
    })).toThrow(/authoredCommand/);
  });

  test("three rewriting sites record both forms, and each is named", () => {
    // The count AC-6 asks for. Two are source positions in ship.js — they sit
    // inside `runDiscovery` and cannot be called without running a discovery
    // — and the third is EXECUTED above, at the boundary that matters most.
    // The fourth, the pre-validator, is executed in its own case below.
    const sites = [...shipSource.matchAll(/recordEvidenceRewrite\(ac\.evidenceMethod, '([^']+)'/g)]
      .map(m => m[1]);
    expect(sites.sort(), "a ship.js rewrite site assigns the command without recording the authored form")
      .toEqual(["discovery-path-normalize", "evidence-type-ratio"]);

    // And nothing assigns the command behind the recorder's back.
    const bare = [...shipSource.matchAll(/ac\.evidenceMethod\.command\s*=/g)];
    expect(bare.map(m => m[0]), "a ship.js site still overwrites the command directly").toEqual([]);

    const gateSource = readFileSync(join(REPO, "gates", "gate-executor.ts"), "utf-8");
    expect(gateSource).toContain('recordEvidenceRewrite(ac.evidenceMethod, "normalize-git-refs"');
    expect([...gateSource.matchAll(/ac\.evidenceMethod\.command\s*=/g)].map(m => m[0])).toEqual([]);
  });

  test("the pre-validator's rewrite records both forms too", async () => {
    // Executed, not grepped — the producing side of the same claim (#235).
    const results = await prevalidateEvidence(
      [{
        id: "AC-1",
        evidenceMethod: { type: "command", command: "bun test test/canary.test.ts | grep -c pass" },
        threshold: { op: ">=", value: 2 },
      }],
      REPO,
    );
    expect(results[0].autoFixed).toBe(true);
    expect(results[0].originalCommand).toBe("bun test test/canary.test.ts | grep -c pass");
    expect(results[0].fixedCommand).toBeTruthy();
    expect(results[0].fixedCommand).not.toBe(results[0].originalCommand);
  });
});
