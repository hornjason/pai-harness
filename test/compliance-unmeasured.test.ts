/**
 * A tool that was not there has not PASSED the compliance scan — it has not
 * been part of one, and those are different states (#597, #626 AC-10).
 *
 * Covers SC-2077, SC-2078, SC-2079, SC-2080 (INSTRUCTION-COMPLIANCE-SPEC.md).
 *
 * `lib/tool-probe.ts` already knows the difference between absent, errored and
 * clean. `runTemplateCompliance` threw that away at the door — it read
 * `.available` off each probe and kept nothing else, so a report produced with
 * agnix missing was byte-indistinguishable from one produced with agnix
 * installed and silent, and `overallQuality` came back as a tidy average over
 * whichever tool had answered. That is *Silent Default Substitution* in
 * `.claude/rules/config-access.md`: a number is indistinguishable from success,
 * and UNMEASURED is not.
 *
 * Every case here injects its probes through the one exported seam rather than
 * mutating `PATH`, and every injected reading carries a `PLANTED-…` sentinel no
 * real spawn can produce — so a case that passes because the machine happens to
 * have (or lack) agnix is not possible. The surface is deliberately empty: the
 * subject is the reading, not the scan, and an empty surface means no tool is
 * spawned at all, on any machine, with or without a network.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  COMPLIANCE_TOOLS,
  complianceReading,
  overallQualityOf,
  probeComplianceTools,
  runTemplateCompliance,
  type ComplianceReport,
  type ComplianceTool,
  type FileScore,
} from "../lib/compliance";
import { TOOL_PROBE_TIMEOUT_MS, toolProbe, type ToolProbe, type ToolProbeOutcome } from "../lib/tool-probe";

/**
 * The one case here that reaches a real spawn needs longer than the probe it
 * is waiting for, or the two race and which message you get is not decided by
 * the code under test.
 *
 * Bun's default test timeout is 5000ms and `TOOL_PROBE_TIMEOUT_MS` is also
 * 5000ms, so a probe that uses its whole budget — `npx @reporails/cli
 * version` does exactly that whenever the package is not already cached —
 * times the TEST out first. That is not a hypothetical: this case failed on
 * the full-suite run of the commit that introduced it, with
 * `this test timed out after 5000ms`, while passing in isolation. Shipping it
 * that way would have replaced the flake #597 is about with a new one.
 */
const REAL_PROBE_TIMEOUT_MS = TOOL_PROBE_TIMEOUT_MS * 4;

const COMPLIANCE_SOURCE = readFileSync(
  join(import.meta.dir, "..", "lib", "compliance.ts"),
  "utf-8",
);

/** A reading no real spawn could produce, so the seam is observable on any machine. */
function planted(tool: ComplianceTool, outcome: ToolProbeOutcome): ToolProbe {
  return toolProbe({
    outcome,
    tool,
    exitCode: outcome === "absent" ? null : outcome === "available" ? 0 : 3,
    reason: `PLANTED-${tool}-${outcome}`,
  });
}

type ToolStates = Record<ComplianceTool, ToolProbeOutcome>;

async function reportFor(states: ToolStates): Promise<ComplianceReport> {
  const root = mkdtempSync(join(tmpdir(), "compliance-unmeasured-"));
  const probes = {} as Record<ComplianceTool, ToolProbe>;
  for (const tool of COMPLIANCE_TOOLS) probes[tool] = planted(tool, states[tool]);
  return runTemplateCompliance(root, {
    // Nothing to scan. The subject is the reading, not the scan, and an empty
    // surface keeps every case offline and spawn-free.
    surface: [],
    writeReport: false,
    probes,
  });
}

function namesOf(report: ComplianceReport): string[] {
  return report.reading.unmeasured.map(u => u.tool).sort();
}

describe("SC-2080: the probe seam is injected, not discovered through PATH", () => {
  test("lib/compliance.ts asks the availability question in exactly one place", () => {
    // Two deciders that agree are behaviourally one, and a second probe would
    // survive any mutation of this one.
    const calls = [...COMPLIANCE_SOURCE.matchAll(/probeExternalTool\s*\(/g)].length;
    expect(calls, "the probe call must live only inside probeComplianceTools").toBe(1);
    expect(COMPLIANCE_SOURCE).toContain("export function probeComplianceTools");
  });

  test("an injected reading reaches the report verbatim", async () => {
    const report = await reportFor({ agnix: "errored", reporails: "absent" });
    expect(report.toolProbes.agnix.reason).toBe("PLANTED-agnix-errored");
    expect(report.toolProbes.reporails.reason).toBe("PLANTED-reporails-absent");
    expect(report.toolProbes.agnix.outcome).toBe("errored");
    expect(report.toolProbes.reporails.outcome).toBe("absent");
  });

  test("an un-injected tool still falls through to the real probe", () => {
    // Only `agnix` is supplied. `reporails` must come back from a spawn — so
    // the seam is an override, not a replacement that silently drops the tool.
    const probes = probeComplianceTools({ agnix: planted("agnix", "absent") });
    expect(probes.agnix.reason).toBe("PLANTED-agnix-absent");
    expect(probes.reporails.reason).not.toContain("PLANTED");
    expect(probes.reporails.tool.length).toBeGreaterThan(0);
  }, REAL_PROBE_TIMEOUT_MS);

  test("the real-probe case is allowed strictly more time than the probe it waits for", () => {
    // The guard on the line above, asserted rather than left as a comment:
    // a later edit lowering either number back into a tie reintroduces the
    // race, and a timeout failure reads like a broken probe rather than a
    // budget that was always too small.
    expect(REAL_PROBE_TIMEOUT_MS).toBeGreaterThan(TOOL_PROBE_TIMEOUT_MS);
  });

  test("available is derived from the outcome and cannot be set against it", () => {
    // The projection has one owner, so an injected probe cannot claim to be
    // available while reporting that it was absent.
    for (const outcome of ["available", "absent", "errored"] as ToolProbeOutcome[]) {
      const probe = toolProbe({ outcome, tool: "x", reason: "r" });
      expect(probe.available).toBe(outcome === "available");
    }
  });
});

describe("SC-2077: the report keeps the whole probe, and toolsAvailable is its projection", () => {
  test("every tool has a full probe on the report", async () => {
    const report = await reportFor({ agnix: "available", reporails: "errored" });
    for (const tool of COMPLIANCE_TOOLS) {
      const probe = report.toolProbes[tool];
      expect(probe, `no probe recorded for ${tool}`).toBeDefined();
      expect(probe.outcome).toMatch(/^(available|absent|errored)$/);
      expect(probe.reason.length, `${tool} recorded an empty reason`).toBeGreaterThan(0);
    }
  });

  test("toolsAvailable agrees with the probes it is derived from, in all four states", async () => {
    const states: ToolStates[] = [
      { agnix: "available", reporails: "available" },
      { agnix: "absent", reporails: "available" },
      { agnix: "available", reporails: "errored" },
      { agnix: "absent", reporails: "absent" },
    ];
    for (const s of states) {
      const report = await reportFor(s);
      for (const tool of COMPLIANCE_TOOLS) {
        expect(report.toolsAvailable[tool]).toBe(report.toolProbes[tool].available);
        expect(report.toolsAvailable[tool]).toBe(s[tool] === "available");
      }
    }
  });
});

describe("SC-2078: an unavailable tool makes the reading UNMEASURED and is named in it", () => {
  test("both available — the reading is MEASURED and names nothing", async () => {
    const report = await reportFor({ agnix: "available", reporails: "available" });
    expect(report.reading.reading).toBe("MEASURED");
    expect(report.reading.unmeasured).toEqual([]);
    expect(report.reading.reason).toBeNull();
  });

  test("one absent — the reading names exactly that tool, and the score is withheld", async () => {
    const report = await reportFor({ agnix: "absent", reporails: "available" });
    expect(report.reading.reading).toBe("UNMEASURED");
    expect(namesOf(report)).toEqual(["agnix"]);
    expect(report.reading.unmeasured[0].outcome).toBe("absent");
    expect(report.reading.reason).toContain("agnix");
    expect(report.reading.reason).toContain("PLANTED-agnix-absent");
    expect(report.reading.reason).not.toContain("reporails");
    expect(report.overallQuality).toBeNull();
  });

  test("one errored — the reading names exactly that tool, and the score is withheld", async () => {
    const report = await reportFor({ agnix: "available", reporails: "errored" });
    expect(report.reading.reading).toBe("UNMEASURED");
    expect(namesOf(report)).toEqual(["reporails"]);
    expect(report.reading.unmeasured[0].outcome).toBe("errored");
    expect(report.reading.reason).toContain("reporails");
    expect(report.reading.reason).toContain("PLANTED-reporails-errored");
    expect(report.overallQuality).toBeNull();
  });

  test("both absent — the reading names both, and the score is withheld", async () => {
    const report = await reportFor({ agnix: "absent", reporails: "absent" });
    expect(report.reading.reading).toBe("UNMEASURED");
    expect(namesOf(report)).toEqual(["agnix", "reporails"]);
    expect(report.reading.reason).toContain("PLANTED-agnix-absent");
    expect(report.reading.reason).toContain("PLANTED-reporails-absent");
    expect(report.overallQuality).toBeNull();
  });

  test("the reason says UNMEASURED in so many words", async () => {
    // `0`, `{}`, `null` and silence are indistinguishable from success. The
    // word is the only part of the reading a log reader sees.
    const report = await reportFor({ agnix: "absent", reporails: "errored" });
    expect(report.reading.reason).toContain("UNMEASURED");
  });

  test("an errored tool is not reported as an absent one", async () => {
    // The whole point of #626's three outcomes: a tool that ran and failed is
    // a different fact from a tool that was never there, and a remediation
    // that installs the tool fixes only one of them.
    const absent = await reportFor({ agnix: "absent", reporails: "available" });
    const errored = await reportFor({ agnix: "errored", reporails: "available" });
    expect(absent.reading.unmeasured[0].outcome).toBe("absent");
    expect(errored.reading.unmeasured[0].outcome).toBe("errored");
    expect(absent.reading.reason).not.toEqual(errored.reading.reason);
  });
});

describe("SC-2079: the quality score is withheld, not averaged over whoever answered", () => {
  const scored: FileScore[] = [
    { file: "a.md", agnixFindings: 0, reporailsFindings: 0, reporailsQuality: 8, findings: [] },
    { file: "b.md", agnixFindings: 0, reporailsFindings: 0, reporailsQuality: 6, findings: [] },
  ];

  test("a MEASURED reading averages the files that carry a score", () => {
    // Without this case, "withheld" is satisfied by returning null always —
    // the cheapest wrong fix, and the one an empty surface cannot distinguish.
    const reading = complianceReading({
      agnix: toolProbe({ outcome: "available", tool: "agnix", exitCode: 0, reason: "ok" }),
      reporails: toolProbe({ outcome: "available", tool: "reporails", exitCode: 0, reason: "ok" }),
    });
    expect(reading.reading).toBe("MEASURED");
    expect(overallQualityOf(scored, reading)).toBe(7);
  });

  test("an UNMEASURED reading withholds the same number", () => {
    const reading = complianceReading({
      agnix: toolProbe({ outcome: "absent", tool: "agnix", reason: "not here" }),
      reporails: toolProbe({ outcome: "available", tool: "reporails", exitCode: 0, reason: "ok" }),
    });
    expect(reading.reading).toBe("UNMEASURED");
    expect(
      overallQualityOf(scored, reading),
      "a score averaged over the tool that did answer reports a number for a surface nobody measured",
    ).toBeNull();
  });

  test("the report's score comes from that one binding", () => {
    // The two cases above are only load-bearing for the report if the report
    // routes through them. One call site, so there is one thing to mutate.
    const mentions = [...COMPLIANCE_SOURCE.matchAll(/overallQualityOf\s*\(/g)].length;
    const declarations = [...COMPLIANCE_SOURCE.matchAll(/function\s+overallQualityOf\s*\(/g)].length;
    expect(declarations, "one declaration, so there is one thing to mutate").toBe(1);
    expect(mentions - declarations, "overallQualityOf must be called exactly once").toBe(1);
    expect(COMPLIANCE_SOURCE).toContain("overallQuality: overallQualityOf(");
  });
});
