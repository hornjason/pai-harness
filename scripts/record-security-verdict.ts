#!/usr/bin/env bun
/**
 * Record the security review's verdict in workflow-state.json (#129).
 *
 * Before this, a finished ship run's artefact could not answer "did security
 * run, and what did it say?". `agents.rook` was never written, so a run where
 * rook reported a reproduced guard bypass and a run where rook never spawned
 * produced byte-identical state files.
 *
 * WHY A SCRIPT. `workflows/ship.js` runs in a sandbox with no module loading
 * (#69), so it cannot call writeWorkflowState itself, and gates/SCHEMA-GUIDE.md
 * forbids writing the file with Write or `cat >` — Zod validates at write time
 * and an invalid value must fail here rather than as an opaque gate failure
 * later.
 *
 * WHY THE FINDINGS COME FROM A FILE. The verdict and the spawned flag are
 * workflow-computed and arrive as argv. Rook's failure *strings* are text an
 * agent wrote, and interpolating agent text into a shell command is the exact
 * surface three consecutive security reviews of this area each found a new
 * hole in. So rook writes its findings to a JSON file with its own tools and
 * this script reads them off disk. Nothing agent-authored passes through a
 * shell.
 *
 * The workflow's verdict wins. The findings file supplies detail only; it can
 * never turn a FAIL into a PASS, and its absence cannot either.
 *
 * Usage:
 *   bun scripts/record-security-verdict.ts --state <workflow-state.json> \
 *     --verdict PASS|FAIL --spawned true|false [--findings <file>] [--scope <file>]
 */

import { readFileSync } from "fs";
import { writeWorkflowState } from "../gates/orchestrator";

const OPTIONS = new Set(["state", "verdict", "spawned", "findings", "scope"]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Error(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Read a JSON file, returning null on anything that is not readable JSON. */
function readJson(path: string | undefined): unknown {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The failure list to persist.
 *
 * A FAIL always ends up with at least one entry: SCHEMA-GUIDE.md calls a FAIL
 * with an empty list "a verdict nobody can act on". When the findings file is
 * missing or unusable, that fact IS the finding worth recording.
 */
export function failureList(verdict: string, findings: unknown): string[] {
  const raw = Array.isArray(findings)
    ? findings
    : Array.isArray((findings as { failures?: unknown } | null)?.failures)
      ? (findings as { failures: unknown[] }).failures
      : [];
  const detail = raw.map(f => String(f).trim()).filter(Boolean);
  if (verdict !== "FAIL") return detail;
  return detail.length > 0
    ? detail
    : ["the security review failed and wrote no findings file — see the rook transcript"];
}

export function buildRookRecord(
  verdict: string,
  spawned: boolean,
  findings: unknown,
  scope: unknown,
): Record<string, unknown> {
  const record: Record<string, unknown> = { spawned, verdict };
  const failures = failureList(verdict, findings);
  if (failures.length > 0) record.failures = failures;

  // What was actually reviewed, so the artefact answers the question the
  // production failure turned on: a PASS over zero files is distinguishable
  // from a PASS over the change.
  const s = scope as { sha?: unknown; files?: unknown } | null;
  if (s && typeof s.sha === "string") record.testedSha = s.sha;
  if (s && Array.isArray(s.files)) record.testedPaths = s.files.map(f => String(f));

  return record;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) throw new Error("--state is required");
    if (args.verdict !== "PASS" && args.verdict !== "FAIL" && args.verdict !== "SKIP") {
      throw new Error(`--verdict must be PASS, FAIL or SKIP (got "${String(args.verdict)}")`);
    }
    if (args.spawned !== "true" && args.spawned !== "false") {
      throw new Error(`--spawned must be true or false (got "${String(args.spawned)}")`);
    }

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    state.agents = state.agents || {};
    state.agents.rook = buildRookRecord(
      args.verdict,
      args.spawned === "true",
      readJson(args.findings),
      readJson(args.scope),
    );
    state.changelog = state.changelog || [];
    state.changelog.push({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      event: "security-verdict",
      detail: `rook ${args.verdict} (spawned=${args.spawned})`,
      phase: "VERIFY",
      actor: "rook",
    });

    writeWorkflowState(args.state, state);
    console.log(JSON.stringify({ ok: true, rook: state.agents.rook }));
  } catch (e) {
    console.error(`record-security-verdict: ${e instanceof Error ? e.message : String(e)}`);
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
}
