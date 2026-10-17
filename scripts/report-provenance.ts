#!/usr/bin/env bun
/**
 * report-provenance — the tree a peer report was measured against (#553).
 *
 * Usage:
 *   bun scripts/report-provenance.ts
 *   bun scripts/report-provenance.ts --measured 7fdfa72a --ref origin/fix/540
 *   bun scripts/report-provenance.ts --project /path/to/worktree
 *
 * Prints a three-line block to paste at the top of a report, and exits
 * non-zero when the branch has moved past the tree you measured — which is
 * the moment to re-measure rather than to send.
 *
 * Thin CLI consumer: every decision lives in lib/report-provenance.ts.
 */
import { provenanceBlock, provenanceReading, STALE_EXIT } from "../lib/report-provenance";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i + 1 >= args.length ? undefined : args[i + 1];
}

const reading = provenanceReading(flag("project") ?? process.cwd(), flag("measured"), flag("ref"));
console.log(provenanceBlock(reading));
if (!reading.current) process.exit(STALE_EXIT);
