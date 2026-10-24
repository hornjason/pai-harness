#!/usr/bin/env bun
/**
 * Dump every write-primitive call site the sweep sees, with its classification.
 *
 * This exists so the AST rework (#1566) can be measured rather than asserted:
 * run it before the change and after, and diff. A site that MOVES between
 * `specTargeting: true` and `false` is the defect having been live, which is
 * the most important thing either run can tell you.
 *
 * Usage:
 *   bun scripts/spec-write-census.ts            # JSON to stdout
 *   bun scripts/spec-write-census.ts --summary  # counts only
 */
import { writeSites, SWEPT_DIRS } from "../lib/spec-write-sweep";

const root = new URL("..", import.meta.url).pathname;
const sites = writeSites(root, SWEPT_DIRS);

if (process.argv.includes("--summary")) {
  const targeting = sites.filter((s) => s.specTargeting);
  console.log(`sites: ${sites.length}`);
  console.log(`specTargeting: ${targeting.length}`);
  for (const s of targeting) console.log(`  ${s.file}:${s.line} ${s.primitive} -> ${s.target}`);
} else {
  // Keyed by file::target — a symbol, never a line number, so a site that
  // merely moved in the file does not read as a classification change.
  const rows = sites
    .map((s) => ({
      key: `${s.file}::${s.target}`,
      primitive: s.primitive,
      specTargeting: s.specTargeting,
      view: s.view,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  console.log(JSON.stringify(rows, null, 2));
}
