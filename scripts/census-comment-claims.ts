#!/usr/bin/env bun
/**
 * #360 criterion 1: of the comment-position coverage credits, how many NAME
 * the criterion they are about, and how many CITE it in passing?
 *
 * Why this exists as a committed script rather than a one-off: the issue asks
 * for a before AND an after count, and a number produced twice by two
 * different ad-hoc greps is two numbers. Run it, record it, run it again.
 *
 * ## How a comment is recovered
 *
 * Not with a second lexer. `stripJsComments` is offset-preserving, so the
 * enclosing comment is exactly the maximal run around the id's offset where
 * the stripped view differs from the source. That is the same scanner
 * `coverageClaimSites` classifies with, so the census cannot disagree with the
 * thing it is measuring — which is the failure mode a hand-rolled
 * "find the // and read to the newline" version has against the fixture
 * `fixtureTestDir("x", "// covers SC-92")`.
 *
 * ## The classifier
 *
 * Stated rather than tuned, and deliberately crude, because the point is to
 * size two populations and not to be the production rule:
 *
 *   DECLARING   the comment contains a coverage verb (`covers`, `tests`,
 *               `verifies`, `asserts`, `proves`, `exercises`, `guards`)
 *               anywhere, OR the id is immediately followed by `:` or `—`,
 *               OR the id opens the comment.
 *   CITING      everything else.
 *
 * `--sample N` prints N comments per bucket, seeded off nothing (first N in
 * scan order), so the classifier's error rate can be hand-checked rather than
 * assumed. Both numbers go in the issue; a classifier nobody audited is a
 * guess with a decimal point.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { commentMask, enclosingComment } from "../lib/strip-js-comments";
import { commentClaimForm, type ClaimForm } from "../lib/sc-claim-forms";
import { scMentionPattern as scIdMentionPattern } from "../lib/sc-ids";
import { readScRegistry } from "./sync-sc-status";

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".js")) out.push(p);
  }
  return out;
}

type Bucket = ClaimForm | "unmarked";

const registry = readScRegistry();
const known = new Set(registry.byId.keys());

interface Row { file: string; id: string; bucket: Bucket; comment: string }
const rows: Row[] = [];
const byKey = new Map<string, Row>();

// Deliberately NOT driven off `coverageClaimSites`. Once #360 lands, that
// function drops the unmarked mentions, and a census built on it would report
// zero unmarked and call the job done — a count that can only ever agree with
// the change it is measuring. This re-derives the comment positions and asks
// the owner module what form each one is, which is the question.
for (const file of walk(join(ROOT, "test"))) {
  const source = readFileSync(file, "utf-8");
  const mask = commentMask(source);
  for (const m of source.matchAll(scIdMentionPattern())) {
    const id = m[0];
    const at = m.index!;
    if (!mask[at] || !known.has(id)) continue;
    const { text, offset } = enclosingComment(source, mask, at);
    const form = commentClaimForm(text, offset, id);
    // BEST form across every mention, not the first one. A credit is per
    // (file, id) and `findTestFilesForSCs` grants it if ANY site qualifies,
    // so a census keyed on the first mention reports a file as losing a
    // credit it keeps — test/phase-0.test.ts cites SC-74 in prose two
    // hundred lines above the test that declares it.
    const key = `${file}::${id}`;
    const prior = byKey.get(key);
    if (prior && (prior.bucket !== "unmarked" || !form)) continue;
    byKey.set(key, {
      file: file.slice(ROOT.length + 1),
      id,
      bucket: form ?? "unmarked",
      comment: text,
    });
  }
}
rows.push(...byKey.values());

const BUCKETS: Bucket[] = ["covers", "label", "line", "spec-ref", "attribution", "unmarked"];
const of = (b: Bucket) => rows.filter(r => r.bucket === b);

console.log(`comment-position credits against registry ids: ${rows.length}`);
for (const b of BUCKETS) console.log(`  ${b.padEnd(9)} ${of(b).length}`);
const marked = rows.length - of("unmarked").length;
console.log(`  --------- `);
console.log(`  marked by a scanner-visible declaring form: ${marked}`);
console.log(`  files involved: ${new Set(rows.map(r => r.file)).size}`);
console.log(`  files with at least one unmarked credit: ${new Set(of("unmarked").map(r => r.file)).size}`);

const sampleArg = process.argv.indexOf("--sample");
if (sampleArg >= 0) {
  const n = parseInt(process.argv[sampleArg + 1] ?? "10", 10);
  const which = (process.argv[sampleArg + 2] ?? "unmarked") as Bucket;
  const set = of(which);
  // Evenly spaced through scan order rather than the first N, so one verbose
  // file cannot be the whole sample — `test/dev-liveness.test.ts` alone owns
  // nine consecutive credits.
  const step = Math.max(1, Math.floor(set.length / n));
  console.log(`\n=== ${which} — ${Math.min(n, set.length)} of ${set.length}, every ${step}th ===`);
  for (let i = 0; i < set.length && i / step < n; i += step) {
    const r = set[i];
    console.log(`\n--- ${r.file}  ${r.id}`);
    console.log(r.comment.split("\n").slice(0, 5).join("\n"));
  }
}
