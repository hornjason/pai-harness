/**
 * The scope gate reported SPEC DRIFT for "this project has no spec-compliance
 * suite" (#197, found while measuring it).
 *
 * `gates/gate-executor.ts` shells out to
 * `bun test test/spec-compliance.test.ts test/spec-compliance-auto.test.ts`
 * with `cwd: harnessRoot`, and `execSync` throws on any non-zero exit. The
 * catch arm printed:
 *
 *     SPEC DRIFT DETECTED: spec-compliance tests failed
 *
 * followed by an empty list of failures — because there were none. Bun exits
 * non-zero both when tests fail and when the files do not exist, and the
 * catch could not tell those apart. Every fixture project in the suite
 * produced that line, four times over in one clean-env run.
 *
 * Two failures in one, and they are the two this repo keeps finding:
 *
 * - **A reading that could not be absent.** "The suite failed" and "there is
 *   no suite" are different facts and had one output.
 * - **An alarm that cannot be acted on.** A DRIFT report naming zero drifted
 *   claims teaches its reader to skip the line, and a line everyone skips is
 *   the same as no line — which is what it will be on the run that matters.
 *
 * The fix is to classify rather than to silence: the probe reports PASS,
 * DRIFT or UNMEASURED, and UNMEASURED says which files it could not find.
 *
 * Covers SC-769..776 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import {
  classifySpecComplianceRun,
  execErrorOutput,
  missingSpecComplianceFiles,
  SPEC_COMPLIANCE_FILES,
} from "../gates/spec-compliance-probe";

describe("#197: the spec-compliance probe tells absence from failure", () => {
  test("a run reporting failures is DRIFT", () => {
    const r = classifySpecComplianceRun({
      ok: false,
      output: "(fail) AUTO-GATE-1: something\n\n 3 pass\n 1 fail\nRan 4 tests across 2 files.",
      missing: [],
    });
    expect(r.verdict).toBe("DRIFT");
    expect(r.detail).toContain("1");
  });

  test("a clean run is PASS", () => {
    const r = classifySpecComplianceRun({
      ok: true,
      output: " 55 pass\n 0 fail\nRan 55 tests across 2 files.",
      missing: [],
    });
    expect(r.verdict).toBe("PASS");
    expect(r.detail).toContain("55");
  });

  test("a project without the files is UNMEASURED, and says which are missing", () => {
    // The whole of this issue's finding. Not DRIFT: nothing drifted.
    const r = classifySpecComplianceRun({
      ok: false,
      output: "error: Module not found",
      missing: [...SPEC_COMPLIANCE_FILES],
    });
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.detail).toContain("test/spec-compliance.test.ts");
  });

  test("a command that produced no summary at all is UNMEASURED, not PASS", () => {
    // The files exist and bun still could not run — a syntax error, a
    // timeout, a killed process. Reporting PASS here is the fail-open; the
    // output carries no `N pass` line to read, and the absence of a reading
    // is the reading.
    const r = classifySpecComplianceRun({ ok: false, output: "Killed: 9", missing: [] });
    expect(r.verdict).toBe("UNMEASURED");

    // ...and it must say WHICH kind of unmeasured. Deleting this branch left
    // the verdict unchanged — "0 pass" and "no pass line at all" both fall
    // into the zero-checks branch below, so the verdict alone could not tell
    // them apart and the mutation scored 0 red. "The command did not produce
    // a summary" and "the suite ran and contained nothing" send a reader to
    // two different places, so the detail is the part under test.
    expect(r.detail).toContain("no pass/fail summary");
    expect(r.detail).toContain("Killed: 9");
  });

  test("a non-zero exit WITH a failure count is still DRIFT, not UNMEASURED", () => {
    // The ordinary case: bun exits 1 because a test failed. Classifying that
    // as UNMEASURED would turn the real alarm off, which is the opposite
    // mistake and the more expensive one.
    const r = classifySpecComplianceRun({
      ok: false,
      output: "(fail) x\n 54 pass\n 1 fail\nRan 55 tests",
      missing: [],
    });
    expect(r.verdict).toBe("DRIFT");
  });

  test("zero tests run is UNMEASURED, not a clean pass", () => {
    // test/spec-compliance-auto.test.ts is legitimately empty since #343, so
    // this is reachable: a pair of files that between them run nothing has
    // not shown that ship.js matches the spec.
    const r = classifySpecComplianceRun({
      ok: true,
      output: " 0 pass\n 0 fail\nRan 0 tests across 1 file.",
      missing: [],
    });
    expect(r.verdict).toBe("UNMEASURED");
    // The other half of the pair above: this one HAS a summary.
    expect(r.detail).toContain("0 checks");
    expect(r.detail).not.toContain("no pass/fail summary");
  });

  test("a non-zero exit with a clean summary is UNMEASURED, not PASS", () => {
    // Found by the background security review of the first commit: `ok` was
    // in the interface and never read, so a timeout or a crash AFTER the
    // summary printed classified as a clean pass. Two readings that disagree
    // are not a result.
    const r = classifySpecComplianceRun({
      ok: false,
      output: " 55 pass\n 0 fail\nRan 55 tests across 2 files.\nsegmentation fault",
      missing: [],
    });
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.detail).toContain("disagree");
  });

  test("the same summary with a zero exit is still PASS", () => {
    // The control for the case above. Without it, pinning the verdict to
    // UNMEASURED for every run would satisfy that test and switch the gate
    // off entirely.
    const r = classifySpecComplianceRun({
      ok: true,
      output: " 55 pass\n 0 fail\nRan 55 tests across 2 files.",
      missing: [],
    });
    expect(r.verdict).toBe("PASS");
  });

  test("some of the files missing is DRIFT, not 'no suite here'", () => {
    // Also from the review. `missing.length > 0` treated a half-deleted suite
    // as a project that never had one, so removing a single spec-compliance
    // file silenced the gate with reassuring words. A project holding part of
    // the suite is missing the rest of it, not exempt from it.
    const r = classifySpecComplianceRun({
      ok: false,
      output: "error: Module not found",
      missing: ["test/spec-compliance-auto.test.ts"],
    });
    expect(r.verdict).toBe("DRIFT");
    expect(r.failures.join("\n")).toContain("test/spec-compliance-auto.test.ts");
  });

  test("all of the files missing is still UNMEASURED", () => {
    // The boundary on the other side, so the branch above cannot grow to
    // cover every fixture project and bring #197's original noise back.
    const r = classifySpecComplianceRun({
      ok: false,
      output: "error: Module not found",
      missing: [...SPEC_COMPLIANCE_FILES],
    });
    expect(r.verdict).toBe("UNMEASURED");
  });

  test("the file list is read from the probe, not restated by the caller", () => {
    expect(SPEC_COMPLIANCE_FILES.length).toBeGreaterThan(0);
    for (const f of SPEC_COMPLIANCE_FILES) expect(f).toMatch(/^test\/.*\.test\.ts$/);
  });
});

describe("#197: the probe detects absence against a real directory", () => {
  test("missing files are found by looking, not by assuming", () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-probe-"));
    try {
      const { missingSpecComplianceFiles } = require("../gates/spec-compliance-probe");
      // Nothing there at all.
      expect(missingSpecComplianceFiles(dir).sort()).toEqual([...SPEC_COMPLIANCE_FILES].sort());

      // ...and present files are not reported missing, so the detector is
      // not simply returning its own input list.
      mkdirSync(join(dir, "test"), { recursive: true });
      for (const f of SPEC_COMPLIANCE_FILES) writeFileSync(join(dir, f), "");
      expect(missingSpecComplianceFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("this repo has them", () => {
    expect(missingSpecComplianceFiles(join(import.meta.dir, ".."))).toEqual([]);
  });
});

/**
 * A classifier nothing calls is worth nothing (#194's lesson, paid for there).
 * The gate's block is sliced out of gates/gate-executor.ts and EXECUTED, with
 * `execSync` and `console` injected, so the three branches are driven through
 * the real wiring rather than described by a grep.
 */
const GATE_EXECUTOR = join(import.meta.dir, "..", "gates", "gate-executor.ts");
const BLOCK_ANCHOR = "const missing = missingSpecComplianceFiles(harnessRoot);";

/** The `{ ... }` statement in gate-executor.ts holding the probe's call site. */
function sliceProbeBlock(): string {
  const src = readFileSync(GATE_EXECUTOR, "utf-8");
  const anchor = src.indexOf(BLOCK_ANCHOR);
  if (anchor === -1) {
    throw new Error(`could not slice the probe block: the anchor appears 0 times`);
  }
  if (src.indexOf(BLOCK_ANCHOR, anchor + 1) !== -1) {
    // Two call sites would mean a mutation to one leaves the other standing,
    // and the mutant would go green for a reason unrelated to the mutation.
    throw new Error(`could not slice the probe block: the anchor appears more than once`);
  }
  const open = src.lastIndexOf("{", anchor);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("could not slice the probe block: unbalanced braces");
}

interface RunLog {
  err: string[];
  out: string[];
  commands: string[];
}

/** Execute the sliced block against a planted outcome. */
function runProbeBlock(opts: {
  harnessRoot: string;
  exec: (cmd: string) => string;
}): RunLog {
  const log: RunLog = { err: [], out: [], commands: [] };
  const scope = {
    harnessRoot: opts.harnessRoot,
    missingSpecComplianceFiles,
    classifySpecComplianceRun,
    execErrorOutput,
    SPEC_COMPLIANCE_FILES,
    execSync: (cmd: string) => {
      log.commands.push(cmd);
      return opts.exec(cmd);
    },
    console: {
      error: (m: string) => log.err.push(String(m)),
      log: (m: string) => log.out.push(String(m)),
    },
  };
  // `has` returning true for every name shadows the real globals, so a block
  // reaching for something the scope does not provide throws rather than
  // silently picking up the ambient one.
  const proxy = new Proxy(scope as Record<string, unknown>, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k as string]),
  });
  // eslint-disable-next-line no-new-func
  new Function("__scope__", `with (__scope__) ${sliceProbeBlock()}`)(proxy);
  return log;
}

describe("#197: the gate executor routes through the probe", () => {
  const REPO = join(import.meta.dir, "..");

  test("a project with no spec-compliance suite gets UNMEASURED, and no command is run", () => {
    // The exact scenario found while measuring #197: four of these printed
    // SPEC DRIFT in one clean-env run. A fixture project is not this repo.
    const dir = mkdtempSync(join(tmpdir(), "sc-gate-"));
    try {
      const log = runProbeBlock({
        harnessRoot: dir,
        exec: () => { throw new Error("the gate must not shell out when the files are absent"); },
      });
      expect(log.commands).toEqual([]);
      expect(log.err).toEqual([]);
      expect(log.out.join("\n")).toContain("UNMEASURED");
      expect(log.out.join("\n")).not.toContain("DRIFT DETECTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing run still reaches SPEC DRIFT DETECTED, with the failures named", () => {
    // The alarm this issue must not have turned off on the way past.
    const log = runProbeBlock({
      harnessRoot: REPO,
      exec: () => {
        const e = new Error("Command failed") as Error & { stdout: string };
        e.stdout = "(fail) AUTO-GATE-1: claim drifted\n 54 pass\n 1 fail\nRan 55 tests";
        throw e;
      },
    });
    const err = log.err.join("\n");
    expect(err).toContain("SPEC DRIFT DETECTED");
    expect(err).toContain("AUTO-GATE-1");
  });

  test("a clean run reports PASS and does not raise the alarm", () => {
    const log = runProbeBlock({
      harnessRoot: REPO,
      exec: () => " 55 pass\n 0 fail\nRan 55 tests across 2 files.",
    });
    expect(log.err).toEqual([]);
    expect(log.out.join("\n")).toContain("55");
    expect(log.commands[0]).toContain("bun test");
  });

  test("an unreadable run in a repo that HAS the suite is loud, not quiet", () => {
    // The third review finding. "No suite here" and "the suite is here and
    // produced no reading" are not the same news: the second is a timeout or
    // a crash in a repo that is supposed to run these tests, and routing it
    // to stdout beside the fixture chatter is how it gets missed. Only the
    // fixture case stays on stdout.
    const log = runProbeBlock({
      harnessRoot: REPO,
      exec: () => { throw Object.assign(new Error("ETIMEDOUT"), { stdout: "" }); },
    });
    expect(log.err.join("\n")).toContain("UNMEASURED");
    expect(log.out).toEqual([]);
  });

  test("the block reads the probe's file list rather than restating it", () => {
    const log = runProbeBlock({ harnessRoot: REPO, exec: () => " 1 pass\n 0 fail" });
    for (const f of SPEC_COMPLIANCE_FILES) expect(log.commands[0]).toContain(f);
  });
});

describe("#197: execErrorOutput prefers the summary over the message", () => {
  test("stdout wins, because the message carries no pass/fail counts", () => {
    // Reading `message` first would hand the classifier a string with no
    // summary in it, and every ordinary failing run would come back
    // UNMEASURED — the alarm-off direction.
    const e = Object.assign(new Error("Command failed with exit code 1"), {
      stdout: " 54 pass\n 1 fail",
    });
    expect(execErrorOutput(e)).toContain("1 fail");
    expect(classifySpecComplianceRun({ ok: false, output: execErrorOutput(e), missing: [] }).verdict)
      .toBe("DRIFT");
  });

  test("a Buffer stdout is decoded, not stringified to [object Object]", () => {
    const e = Object.assign(new Error("x"), {
      stdout: new TextEncoder().encode(" 54 pass\n 1 fail"),
    });
    expect(execErrorOutput(e)).toContain("1 fail");
  });

  test("the message is the fallback when there is no stdout at all", () => {
    expect(execErrorOutput(new Error("Killed: 9"))).toBe("Killed: 9");
    expect(execErrorOutput(undefined)).toBe("");
  });
});
