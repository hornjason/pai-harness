#!/usr/bin/env bun
/**
 * Report which ticked criteria name what proved them, and refuse on a spec
 * that opted in and did not comply.
 *
 * This is the measurement instrument behind `specs/SPEC-AUTHORING-SPEC.md`'s
 * outcome table, and the command its baseline cell names. Run it as written:
 *
 *     bun scripts/audit-spec-evidence.ts
 *     bun scripts/audit-spec-evidence.ts --json
 *
 * ## Two populations, reported apart
 *
 * **Bound** specs declare `evidence: required` and are gated: any violation
 * exits {@link EVIDENCE_AUDIT_EXIT}. **Unbound** specs are every document
 * that predates the key; they are counted and never refused, because the
 * scope rule lives in the document and not in an allowlist somebody has to
 * shrink (`.claude/rules/self-referential-tests.md`, DRIFT-3).
 *
 * The unbound count is the one worth watching. It is the retrofit backlog,
 * and reporting it as a number rather than a failure is the whole of the
 * grandfathering decision: 1,477 ticked criteria on 2026-10-28 named nothing,
 * and reddening all of them at once would have made the rule the first thing
 * anybody disabled.
 *
 * ## Why the exit code is one constant
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: a refusal spelled at two
 * sites can bypass a mutation at either, and the case goes green having
 * witnessed nothing. One line, one site.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

import { writeSpec } from "../lib/write-spec";

import {
  criterionFingerprint,
  evidenceViolations,
  parseCriteria,
  specDeclaresEvidence,
} from "../lib/spec-evidence";
import { localCalendarDay } from "../lib/local-calendar-day";

/** The single refusal. Every non-zero exit in this file routes through it. */
export const EVIDENCE_AUDIT_EXIT = 1;

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    // An absent `specs/` is UNMEASURED, not clean. Exiting zero here would
    // tell a consumer who pointed the command at the wrong directory that
    // their specs comply, and "no specs found" and "every spec complies" are
    // byte-identical on the only channel they would read
    // (`.claude/rules/config-access.md`, Silent Default Substitution).
    console.error(
      `no specs directory at ${dir}. UNMEASURED — nothing was read, which is not the ` +
        `same as nothing being wrong. Pass --project-root <dir> naming the tree whose ` +
        `specs/ you mean.`,
    );
    process.exit(EVIDENCE_AUDIT_EXIT);
  }
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return entry.endsWith(".md") ? [path] : [];
  });
}

/**
 * The tree to audit.
 *
 * `--project-root <dir>` is REQUIRED for any consumer and the dispatcher in
 * `lib/cli-commands.ts` appends it, because the default — this script's own
 * location — is correct for `bun scripts/audit-spec-evidence.ts` inside this
 * repository and wrong everywhere else. Without it,
 * `bunx rungate audit-spec-evidence` would walk
 * `node_modules/rungate/specs/`, report rungate's own compliance, exit zero
 * and tell the consumer their specs are clean. That is a command that reports
 * success about a tree it never looked at, which is the #363 shape and the
 * exact one `lib/cli-commands.ts` documents for `create-spec`.
 */
function resolveRoot(argv: string[]): string {
  const at = argv.indexOf("--project-root");
  if (at === -1) return join(import.meta.dir, "..");
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(
      "--project-root was given with no directory after it. Refusing rather than " +
        "falling back to this script's own location, which would audit the installed " +
        "package and report its result as yours.",
    );
    process.exit(EVIDENCE_AUDIT_EXIT);
  }
  return value;
}

const root = resolveRoot(process.argv);
const specsDir = join(root, "specs");
// UTC, EXPLICITLY, and this is the one place the anchoring is decided.
//
// `localCalendarDay()` with no zone returns the day the runner is living in,
// and `lib/spec-evidence.ts` validates `waived-until` in UTC — so the two
// sides of `c.waiver.until < today` were anchored differently and a waiver
// could read as expired in Sydney and live in London. A gate whose verdict is
// a property of WHO RAN IT is the thing this whole rule exists to refuse, and
// the decider's own docblock claimed the comparison was already UTC on both
// sides. Raised on #1639 by the required reviewer; the claim was false for the
// shipped path and is now true.
//
// The decider cannot enforce this itself: `lib/spec-evidence.ts` must stay
// free of relative imports so its mutation battery can load a copy from a temp
// directory, so it takes `today` as a parameter and this is its only caller.
// `test/spec-evidence.test.ts` SC-2576 spawns this script under two zones 25
// hours apart and refuses if they disagree.
const today = localCalendarDay(new Date(), "UTC");
const asJson = process.argv.includes("--json");
const recordFingerprints = process.argv.includes("--record-fingerprints");

/**
 * Write a `fingerprint:` line beneath the evidence of every ticked criterion
 * that has evidence and no fingerprint yet.
 *
 * Only ever ADDS. It never rewrites a fingerprint that is already there,
 * because the one case the staleness check exists for — recorded hash and
 * current text disagree — is exactly the case a refresher would erase. Fixing
 * a stale criterion means re-running its evidence and then recording the new
 * hash by hand, which is a decision and not a formatting pass.
 */
function recordFingerprintsIn(path: string): number {
  const lines = readFileSync(path, "utf-8").split("\n");
  const content = lines.join("\n");
  const pending = parseCriteria(content).filter(
    c => c.ticked && c.provedBy !== null && c.provedBy.trim() !== "" && c.recordedFingerprint === null,
  );
  if (pending.length === 0) return 0;

  // Walk from the end so earlier insertion points keep their line numbers.
  for (const criterion of [...pending].sort((a, b) => b.line - a.line)) {
    let at = criterion.line; // 0-indexed line after the bullet
    while (at < lines.length && !/^\s{2,}proved-by:/.test(lines[at])) at += 1;
    if (at >= lines.length) continue;
    lines.splice(at + 1, 0, `      fingerprint: ${criterionFingerprint(criterion.text)}`);
  }
  // #1552: every write under `specs/` goes through the chokepoint, which
  // consults `mayWrite` and refuses on a derived document. A bare
  // `writeFileSync` here would also be an OPAQUE site to the #1584 sweep —
  // the path is a parameter, so nothing static can establish what it writes.
  const result = writeSpec(path, lines.join("\n"), { label: relative(root, path) });
  if (!result.written) {
    console.error(result.refusal);
    return 0;
  }
  return pending.length;
}

interface SpecReading {
  file: string;
  bound: boolean;
  criteria: number;
  ticked: number;
  tickedWithEvidence: number;
  violations: { id: string; code: string; message: string }[];
}

const readings: SpecReading[] = [];

for (const path of markdownFiles(specsDir)) {
  if (recordFingerprints && specDeclaresEvidence(readFileSync(path, "utf-8"))) {
    const n = recordFingerprintsIn(path);
    if (n > 0) console.log(`recorded ${n} fingerprint(s) in ${relative(root, path)}`);
  }
  const content = readFileSync(path, "utf-8");
  const criteria = parseCriteria(content);
  if (criteria.length === 0) continue;
  const ticked = criteria.filter(c => c.ticked);
  readings.push({
    file: relative(root, path),
    bound: specDeclaresEvidence(content),
    criteria: criteria.length,
    ticked: ticked.length,
    tickedWithEvidence: ticked.filter(c => c.provedBy !== null && c.provedBy.trim() !== "").length,
    violations: evidenceViolations(content, today).map(v => ({
      id: v.id,
      code: v.code,
      message: v.message,
    })),
  });
}

const sum = (pick: (r: SpecReading) => number) => readings.reduce((n, r) => n + pick(r), 0);
const bound = readings.filter(r => r.bound);
const unbound = readings.filter(r => !r.bound);
const offending = bound.filter(r => r.violations.length > 0);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        today,
        specs: readings.length,
        criteria: sum(r => r.criteria),
        ticked: sum(r => r.ticked),
        tickedWithEvidence: sum(r => r.tickedWithEvidence),
        bound: { specs: bound.length, ticked: bound.reduce((n, r) => n + r.ticked, 0) },
        unbound: { specs: unbound.length, ticked: unbound.reduce((n, r) => n + r.ticked, 0) },
        readings,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`spec evidence audit — ${today}`);
  console.log(
    `  ${sum(r => r.ticked)} of ${sum(r => r.criteria)} criteria are ticked across ` +
      `${readings.length} specs; ${sum(r => r.tickedWithEvidence)} of those name what proved them.`,
  );
  console.log(
    `  BOUND (declare \`evidence: required\`, gated): ${bound.length} spec(s)` +
      (bound.length > 0 ? ` — ${bound.map(r => r.file).join(", ")}` : ""),
  );
  console.log(
    `  UNBOUND (predate the key, counted not refused): ${unbound.length} spec(s), ` +
      `${unbound.reduce((n, r) => n + r.ticked, 0)} ticked criteria. This is the retrofit ` +
      `backlog, not a failure.`,
  );

  for (const r of offending) {
    console.error(`\n${r.file}`);
    for (const v of r.violations) console.error(`  [${v.code}] ${v.message}`);
  }
}

if (offending.length > 0) {
  if (!asJson) {
    console.error(
      `\n${offending.length} spec(s) declare \`evidence: required\` and do not satisfy it. ` +
        `Name what proved each ticked criterion in a \`proved-by:\` line, or waive it ` +
        `explicitly with \`waived-reason\`, \`waived-by\` and \`waived-until\`. Keep ` +
        `\`needs:\` either way — a waiver expires, and a waived criterion still owes a ` +
        `statement of what would prove it.`,
    );
  }
  process.exit(EVIDENCE_AUDIT_EXIT);
}
