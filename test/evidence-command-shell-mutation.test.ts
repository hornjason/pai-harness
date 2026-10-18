/**
 * Covers SC-2056, SC-2057 (HARNESS-STANDARD.md).
 *
 * #614 AC-5 — the round-trip cases can go red.
 *
 * `test/evidence-command-roundtrip.test.ts` asserts that an evidence command
 * containing `$1`, `${VAR}` and `$(cmd)` reaches `workflow-state.json`
 * unchanged. On its own that is a check whose ability to fail nobody has
 * watched: it passes today, and it would also pass over a transport that was
 * never fixed if the fixture happened to be quoted somewhere upstream.
 *
 * So the pre-#614 defect is REBUILT inside a copy of `workflows/ship.js` —
 * `acPayloadShellArgument` emptied and `acPayloadReadExpression` restored to
 * interpolating the payload into the program text — and a four-case suite is
 * SPAWNED against both copies with one argv, differing only in
 * `SHIP_UNDER_TEST`.
 *
 * ## Why the mutant escapes the inner double quotes
 *
 * The pre-fix source wrote the payload into a double-quoted `bun -e "…"` with
 * its JSON `"` characters bare, and bash's quote removal would make that
 * program unparseable — every case would go red, including the control, and
 * the measurement would be of a mutant that crashes rather than of the
 * defect. `.claude/rules/checks-must-be-able-to-fail.md` names that: a mutant
 * that crashes is not a mutant.
 *
 * What run `wf_c92dd0a7-fe6` actually produced was a state file with valid
 * ACs and one `$1` missing, which is what the setup AGENT produced when it
 * escaped the quotes it could see a problem with and left alone the `$` it
 * could not. The mutant reproduces that: `"` escaped, `$` untouched.
 *
 * ## The control
 *
 * The fourth case carries an evidence command with no `$` in it at all. It is
 * the only case that is not about the mutated behaviour, so its GREEN under
 * the mutant is what says the spawn ran rather than dying on load — a suite
 * that failed to resolve its imports reports no failures too, and a count
 * alone cannot tell those apart. Green and red are compared by NAME.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readJunitCheckNames } from "../lib/junit-checks";

const REPO = join(import.meta.dir, "..");
const SHIP = join(REPO, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

const TRANSPORT_START = "// ──── AC-PAYLOAD-TRANSPORT-START ────";
const TRANSPORT_END = "// ──── AC-PAYLOAD-TRANSPORT-END ────";

/**
 * The two sites the mutation removes, each declared as a literal rather than
 * regex-built, so renaming one aborts this file instead of quietly mutating
 * nothing.
 */
const ARGUMENT_SITE =
  "function acPayloadShellArgument(acs) {\n  return shellSingleQuote(acPayloadJson(acs))\n}";
const READ_SITE =
  "function acPayloadReadExpression() {\n  return `JSON.parse(process.argv[${AC_PAYLOAD_ARGV_INDEX}])`\n}";

/**
 * The pre-#614 transport, rebuilt: nothing after the closing quote, and the
 * payload interpolated into the program text with only its double quotes
 * escaped — the form the setup agent produced on `wf_c92dd0a7-fe6`.
 *
 * The mutant's `acPayloadReadExpression` takes the ACs; the real one ignores
 * the argument. That is what lets one spawned suite drive both.
 */
const MUTANT_ARGUMENT = "function acPayloadShellArgument(acs) {\n  return ''\n}";
const MUTANT_READ =
  "function acPayloadReadExpression(acs) {\n  return acPayloadJson(acs).replace(/\"/g, '\\\\\"')\n}";

export function buildRawInterpolationMutant(src: string = shipSource): string {
  for (const [label, site] of [
    ["the payload argument builder", ARGUMENT_SITE],
    ["the payload read expression", READ_SITE],
  ] as const) {
    const hits = src.split(site).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: ${label} appears ${hits} times in workflows/ship.js, expected exactly 1. ` +
          `Either it was renamed, or a second copy exists and replacing one would leave the other in place.`,
      );
    }
  }
  const out = src.replace(ARGUMENT_SITE, MUTANT_ARGUMENT).replace(READ_SITE, MUTANT_READ);
  if (out === src) throw new Error("could not build the mutant: the replacement changed nothing");
  if (out.includes("shellSingleQuote(acPayloadJson")) {
    throw new Error("could not build the mutant: the quoting survived the replacement");
  }
  if (!out.includes(TRANSPORT_START) || !out.includes(TRANSPORT_END)) {
    throw new Error("could not build the mutant: the transport markers were lost");
  }
  return out;
}

// ── the suite, generated once and spawned twice ─────────────────────────────

/**
 * `String.raw` is load-bearing: the regexes below contain `\(`, `\$` and
 * `\s`, and an untagged template literal would eat every one of those
 * backslashes and leave detectors that match nothing.
 */
export const SUITE_SOURCE = String.raw`
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SHIP = process.env.SHIP_UNDER_TEST;
const REPO = process.env.REPO_UNDER_TEST;
if (!SHIP) throw new Error("SHIP_UNDER_TEST is unset — this suite has nothing to observe");
if (!REPO) throw new Error("REPO_UNDER_TEST is unset — there is no orchestrator to call");
const SRC = readFileSync(SHIP, "utf-8");

function block(start, end) {
  const a = SRC.indexOf(start);
  const b = SRC.indexOf(end);
  if (a === -1 || b === -1) throw new Error("the ship.js under test is missing " + start);
  return SRC.slice(a + start.length, b);
}

const body =
  block("// ──── PHASE2-DECOMPOSITION-START ────", "// ──── PHASE2-DECOMPOSITION-END ────") +
  "\n" +
  block("// ──── AC-PAYLOAD-TRANSPORT-START ────", "// ──── AC-PAYLOAD-TRANSPORT-END ────");

const T = new Function(body + "\nreturn { acPayloadShellArgument, acPayloadReadExpression }")();

// The three forms, plus a control carrying no $ at all. The control is the
// only case that is not about the mutated behaviour: its green is what says
// the spawn ran rather than dying on load.
const CASES = [
  ["$1", "grep -rhcE '^export function localCalendarDay' lib | awk '{s+=$1} END {print s+0}'"],
  ["\${VAR}", "test -d \${HOME}/.rungate && echo 1 || echo 0"],
  ["$(cmd)", "echo $(basename lib)"],
  ["no $ at all — the control", "bun test test/canary.test.ts"],
];

/**
 * Assemble the setup step exactly as ship.js assembles it, out of the ship.js
 * under test, and run it. Nothing here escapes anything on the payload's
 * behalf.
 */
function roundTrip(command) {
  const S = mkdtempSync(join(tmpdir(), "mutation-roundtrip-"));
  const WORK = join(S, "work");
  mkdirSync(WORK, { recursive: true });
  const sf = join(WORK, "workflow-state.json");
  const acs = [{
    id: "AC-1", type: "CODE", statement: "the authored evidence command survives transport intact",
    threshold: { op: ">=", value: 2 },
    evidenceMethod: { type: "COMMAND", command },
    specElement: "evidence command transport", coversCriteria: ["C-1"], contextFiles: [],
  }];
  const script =
    'bun -e "\n' +
    "import {initWorkflow, writeACs} from '" + REPO + "/gates/orchestrator.ts';\n" +
    "const sf = '" + sf + "';\n" +
    "initWorkflow(sf, {issue: 614, repo: 'hornjason/pai-harness', projectRoot: '" + REPO +
      "', slug: 'pai-harness-614', issueGoal: 'evidence commands survive transport'});\n" +
    "writeACs(sf, " + T.acPayloadReadExpression(acs) + ");\n" +
    '" ' + T.acPayloadShellArgument(acs) + " 2>&1\n";
  const r = spawnSync("bash", ["-c", script], { cwd: S, encoding: "utf-8", timeout: 120000 });
  const state = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf-8")) : {};
  rmSync(S, { recursive: true, force: true });
  return { persisted: state.acs && state.acs[0] && state.acs[0].evidenceMethod.command, out: (r.stdout || "") + (r.stderr || "") };
}

describe("#614: the authored evidence command reaches workflow-state.json", () => {
  for (const [label, command] of CASES) {
    test("the " + label + " form survives the setup transport", () => {
      const { persisted, out } = roundTrip(command);
      expect(persisted, out).toBe(command);
    });
  }
});
`;

/** The `describe` the spawned suite declares; its names are prefixed with it. */
const SPAWNED_SUITE = "#614: the authored evidence command reaches workflow-state.json";

interface SpawnReading {
  ran: number;
  green: string[];
  red: string[];
  /** Carried so a `ran` of zero names its own cause instead of being a bare 0. */
  out: string;
}

/**
 * Read the spawn through its JUnit report rather than its console output.
 *
 * bun prints no `(pass)` markers through a pipe, so a terminal-output reader
 * sees only failures — and `0 red` would then be indistinguishable from `the
 * suite never loaded`, which is the one thing this measurement has to be able
 * to tell apart. `readJunitCheckNames` is the harness's own reader, so `ran`
 * comes from the same code the gates use.
 */
function spawnSuite(suiteFile: string, shipUnderTest: string, reportFile: string): SpawnReading {
  const r = spawnSync(
    "bun",
    ["test", suiteFile, "--reporter=junit", `--reporter-outfile=${reportFile}`],
    {
      cwd: REPO,
      encoding: "utf-8",
      timeout: 600000,
      env: { ...process.env, SHIP_UNDER_TEST: shipUnderTest, REPO_UNDER_TEST: REPO },
    },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const reading = readJunitCheckNames(reportFile);
  const names = reading.names ?? [];
  const xml = existsSync(reportFile) ? readFileSync(reportFile, "utf-8") : "";
  const red = failedNames(xml);
  return {
    ran: names.length,
    green: names.filter(n => !red.includes(n)),
    red,
    out: `${out}\n--- junit: ${reading.reason ?? "read"} ---`,
  };
}

/**
 * The `<classname> > <name>` of every testcase carrying a `<failure`.
 *
 * Composed the same way `readJunitCheckNames` composes the names it returns,
 * so `green` and `red` are drawn from one vocabulary and a name in neither
 * is a reading bug rather than a silent omission.
 */
export function failedNames(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/?)>/g)) {
    const [whole, attrs, selfClosing] = m;
    if (selfClosing) continue;
    const end = xml.indexOf("</testcase>", m.index! + whole.length);
    if (end === -1) continue;
    if (!xml.slice(m.index! + whole.length, end).includes("<failure")) continue;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1];
    const cls = attrs.match(/\bclassname="([^"]*)"/)?.[1];
    if (name) out.push(cls ? `${cls} > ${name}` : name);
  }
  return out;
}

describe("#614 SC-2056: the round-trip cases go red when the defect is put back", () => {
  test("mutant and original differ on a NAMED input, run rather than argued", () => {
    // Before any count is believed. The real builders quote the payload and
    // read it out of argv; the mutant's read expression carries it as
    // program text with only its double quotes escaped. On the command run
    // `wf_c92dd0a7-fe6` lost, the two produce different shell words.
    const mutantSrc = buildRawInterpolationMutant();
    const scratch = mkdtempSync(join(tmpdir(), "ship-mutant-"));
    try {
      const mutantShip = join(scratch, "ship.js");
      writeFileSync(mutantShip, mutantSrc);

      const block = (src: string) =>
        src.slice(src.indexOf(TRANSPORT_START) + TRANSPORT_START.length, src.indexOf(TRANSPORT_END));
      const phase2 = (src: string) =>
        src.slice(
          src.indexOf("// ──── PHASE2-DECOMPOSITION-START ────") + "// ──── PHASE2-DECOMPOSITION-START ────".length,
          src.indexOf("// ──── PHASE2-DECOMPOSITION-END ────"),
        );
      const load = (src: string) =>
        new Function(
          `${phase2(src)}\n${block(src)}\nreturn { acPayloadShellArgument, acPayloadReadExpression }`,
        )() as { acPayloadShellArgument: (a: unknown) => string; acPayloadReadExpression: (a?: unknown) => string };

      const acs = [{
        id: "AC-1", type: "CODE", statement: "the measured command survives transport intact",
        threshold: { op: ">=", value: 2 },
        evidenceMethod: {
          type: "COMMAND",
          command: "grep -rhcE '^export function localCalendarDay' lib | awk '{s+=$1} END {print s+0}'",
        },
      }];

      const real = load(shipSource);
      const mutant = load(mutantSrc);

      expect(real.acPayloadShellArgument(acs), "the real builder stopped quoting").toContain("'");
      expect(mutant.acPayloadShellArgument(acs), "the mutant still supplies an argument").toBe("");
      expect(real.acPayloadReadExpression(acs)).toBe("JSON.parse(process.argv[1])");
      expect(
        mutant.acPayloadReadExpression(acs),
        "the mutant does not carry the payload as program text — the defect was not rebuilt",
      ).toContain("{s+=$1}");
      expect(mutant.acPayloadReadExpression(acs)).not.toBe(real.acPayloadReadExpression(acs));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the suite is 4 of 4 green against the real source and 3 red against the mutant", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ship-mutant-suite-"));
    try {
      const suiteFile = join(scratch, "spawned.test.ts");
      writeFileSync(suiteFile, SUITE_SOURCE);
      const mutantShip = join(scratch, "ship.js");
      writeFileSync(mutantShip, buildRawInterpolationMutant());

      const real = spawnSuite(suiteFile, SHIP, join(scratch, "real.xml"));
      const mutated = spawnSuite(suiteFile, mutantShip, join(scratch, "mutant.xml"));

      // `ran` before any verdict. A suite that failed to resolve its imports
      // reports no failures, which is indistinguishable from a suite that
      // passed — and it is also what a broken mutant looks like.
      expect(real.ran, `the suite did not run against the real source:\n${real.out}`).toBe(4);
      expect(mutated.ran, `the suite did not run against the mutant:\n${mutated.out}`).toBe(4);

      expect(real.red, `the real transport loses a $:\n${real.out}`).toEqual([]);

      // By NAME, not by count. "3 of 4" is satisfied by any three.
      expect(mutated.red.sort(), mutated.out).toEqual([
        `${SPAWNED_SUITE} > the $(cmd) form survives the setup transport`,
        `${SPAWNED_SUITE} > the $1 form survives the setup transport`,
        `${SPAWNED_SUITE} > the \${VAR} form survives the setup transport`,
      ]);
      expect(
        mutated.green,
        "the control went red too — the mutant is broken, not the transport",
      ).toEqual([`${SPAWNED_SUITE} > the no $ at all — the control form survives the setup transport`]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600000);
});

describe("#614 SC-2057: the mutant builder refuses to no-op", () => {
  test("a renamed site aborts the build rather than mutating nothing", () => {
    // A mutation harness that silently returns an unmutated copy reports
    // green over a mutation that never happened.
    const moved = shipSource.replace(ARGUMENT_SITE, ARGUMENT_SITE.replace("acPayloadShellArgument", "acPayloadArg"));
    expect(() => buildRawInterpolationMutant(moved)).toThrow(/appears 0 times/);
  });

  test("a second copy of a site aborts the build too", () => {
    // Replacing one of two leaves the other in place, and the mutant would
    // behave like the real source for a reason unrelated to the mutation.
    expect(() => buildRawInterpolationMutant(`${shipSource}\n${ARGUMENT_SITE}\n`))
      .toThrow(/appears 2 times/);
  });
});
