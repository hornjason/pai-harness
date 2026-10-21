#!/usr/bin/env bun
/**
 * Ask the claim-content reading about ONE file, and refuse by NAME (#892).
 *
 * `lib/claim-content.ts` answers IDENTICAL, DIFFERENT or UNMEASURED for a file
 * two worktrees both wrote. This script is the terminal-reachable caller of
 * that reading: `workflows/ship.js` cannot import (#69), so the single-claimant
 * arm of the collection audit reaches the comparison across a subprocess
 * boundary, exactly as `scripts/collect-worktree-files.ts` and
 * `scripts/rook-review-scope.ts` do.
 *
 * Usage:
 *   bun scripts/compare-claim-content.ts --path <repo-relative file> \
 *       --reporting <worktree dir> --claiming <worktree dir>
 *   bun scripts/compare-claim-content.ts --prove
 *
 * One JSON object on stdout; every refusal sentence on stderr, so stdout stays
 * machine-readable for the arm that calls this.
 *
 * ## What it refuses, and what the sentence has to say
 *
 * A refusal that says only "that file was unclaimed" is the sentence #892
 * exists to replace: the operator cannot tell a real divergence from two
 * worktrees that produced the same bytes, and on run `wf_161c4e96-f01` that
 * cost the whole run. So:
 *
 * - **DIFFERENT** names the divergence FROM THE CLAIMING WORKTREE'S COPY, both
 *   worktree directories and the file path — the three facts an operator needs
 *   to open the diff — and never says merely that the file was unclaimed.
 * - **UNMEASURED** names the EXACT path that could not be read and the reader's
 *   own reason, per side, and the report says `collectable: false`. A
 *   comparison nobody could take is not a comparison that passed
 *   (`.claude/rules/config-access.md`).
 *
 * ## Three properties this file must keep
 *
 * All three are checked by `--prove`, which is where the mutation battery lives
 * because this sub-issue's claim covers this file and the spec and nothing
 * else — a test file it did not claim would be refused by SC-413 at collection.
 *
 *   1. **No second content comparison.** The bytes are compared in exactly one
 *      position in this repository, `compareClaimedFileContent` in
 *      `lib/claim-content.ts`. This file imports it, calls it once, and
 *      declares nothing of its own. A second comparison here would survive any
 *      mutation of the first and both would read as covered
 *      (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *   2. **Every refusal exits through one exported exit-code constant**,
 *      assigned on exactly one line and passed to the single process exit in
 *      the file. `--prove` builds a copy of this source with that constant set
 *      to 0 and runs it beside the real script for BOTH refusal readings: the
 *      real one refuses, the mutant does not, asserted per reading. An exit
 *      written with a literal code would slip past the mutation and the case
 *      guarding it would be indistinguishable from one passing by accident.
 *   3. **The mutant resolves its imports.** It runs from a temp directory, so
 *      the relative specifier is rewritten to an absolute path and a specifier
 *      the rewriter could not see ABORTS the proof — a mutant that died on
 *      module resolution exits non-zero, which reads as the mutation having
 *      been rejected on the merits.
 *
 * `--prove` also runs an IDENTICAL control before it believes any refusal row:
 * if the real script cannot exit 0 on a file both copies agree about, then a
 * non-zero exit is not evidence of a refusal and nothing below it means
 * anything.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareClaimedFileContent } from "../lib/claim-content";
import type { ClaimContentComparison } from "../lib/claim-content";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1; // EXIT-CODE-CONSTANT: the single site --prove neutralises

const SELF = fileURLToPath(import.meta.url);

/**
 * The declaration above, located WITHOUT spelling the constant's name — a
 * matcher carrying the name would itself count as an assignment and the
 * "declared exactly once" check would read 2 over a correct file.
 */
const EXIT_DECL = /^export const ([A-Z_]+) = 1; \/\/ EXIT-CODE-CONSTANT/gm;

/** Every process exit in this file, with whatever it was handed. */
const EXIT_CALL = /process\.exit\(([^)]*)\)/g;

/** A relative import specifier — the thing the mutant cannot keep. */
const RELATIVE_IMPORT = /from ["'](\.[^"']*)["']/g;

/** What this script tells its caller. */
interface ClaimContentReport {
  /** The binding's reading, or UNMEASURED when no comparison was requested. */
  reading: ClaimContentComparison["reading"];
  /** True only for IDENTICAL. The unreadable path is never reported collectable. */
  collectable: boolean;
  /** The comparison as the binding returned it, or null when none was taken. */
  comparison: ClaimContentComparison | null;
  /** The refusal sentence, repeated here so an artefact carries it too. */
  refusal: string | null;
}

/**
 * The sentence for a reading that refuses, and null for one that does not.
 *
 * One position composes every refusal, so the DIFFERENT wording and the
 * UNMEASURED wording cannot drift apart or be half-reworded by a later edit.
 */
export function refusalSentence(c: ClaimContentComparison): string | null {
  if (c.reading === "IDENTICAL") return null;
  if (c.reading === "DIFFERENT") {
    return (
      `REFUSED ${c.path}: the reporting worktree's copy DIVERGES IN CONTENT from the ` +
      `claiming worktree's copy — ${c.reportingPath} and ${c.claimingPath} are not the ` +
      `same bytes. This is a real content divergence, not merely a file that went ` +
      `unclaimed: collecting one copy would discard the other worktree's edits. Open ` +
      `the diff between those two paths (#892).`
    );
  }
  const sides = c.unreadable
    .map((u) => `the ${u.side} copy at ${u.path} could not be read: ${u.reason}`)
    .join("; ");
  return (
    `REFUSED ${c.path}: the content comparison is UNMEASURED — ${sides}. An unreadable ` +
    `comparison is not an identical one, so ${c.path} is NOT reported as collectable ` +
    `(#892).`
  );
}

/**
 * What this process emits: one JSON body and, when it refuses, one sentence.
 *
 * `--prove` and a comparison carry different bodies on purpose — a proof that
 * passed must not report a READING, because it never took one, and
 * `UNMEASURED` standing in for "not applicable" is the silent default this
 * whole file is against (`.claude/rules/config-access.md`).
 */
interface Emission {
  body: Record<string, unknown>;
  refusal: string | null;
}

/** The reading, the verdict derived from it, and the sentence — one place. */
function reportOf(comparison: ClaimContentComparison | null, refusal: string | null): ClaimContentReport {
  return {
    reading: comparison ? comparison.reading : "UNMEASURED",
    collectable: comparison?.reading === "IDENTICAL",
    comparison,
    refusal: comparison ? refusalSentence(comparison) : refusal,
  };
}

/** A comparison, as something to emit. */
function comparisonEmission(comparison: ClaimContentComparison | null, refusal: string | null): Emission {
  const report = reportOf(comparison, refusal);
  return { body: { ...report }, refusal: report.refusal };
}

/** The only place this process can end non-zero. */
function finish(emission: Emission): void {
  process.stdout.write(`${JSON.stringify({ ...emission.body, refusal: emission.refusal })}\n`);
  if (!emission.refusal) return;
  process.stderr.write(`${emission.refusal}\n`);
  process.exit(REFUSE_EXIT);
}

interface Args {
  path: string;
  reporting: string;
  claiming: string;
  prove: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { path: "", reporting: "", claiming: "", prove: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--prove") {
      args.prove = true;
      continue;
    }
    const value = argv[i + 1] ?? "";
    if (flag === "--path") args.path = value;
    else if (flag === "--reporting") args.reporting = value;
    else if (flag === "--claiming") args.claiming = value;
    else continue;
    i++;
  }
  return args;
}

// ──────────────────────────────────────────────────────────────────────────
// --prove: the mutation battery, run beside the real script
// ──────────────────────────────────────────────────────────────────────────

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}

class ProofAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofAborted";
  }
}

interface Run {
  code: number;
  report: ClaimContentReport | null;
  stderr: string;
  stdout: string;
}

function runScript(script: string, argv: string[]): Run {
  const r = Bun.spawnSync(["bun", script, ...argv], { stdout: "pipe", stderr: "pipe" });
  const stdout = r.stdout.toString();
  let report: ClaimContentReport | null = null;
  try {
    report = JSON.parse(stdout.trim()) as ClaimContentReport;
  } catch {
    report = null;
  }
  return { code: r.exitCode ?? -1, report, stderr: r.stderr.toString(), stdout };
}

/**
 * The copy with the exit constant set to 0.
 *
 * It ABORTS rather than returning an unmutated copy when the declaration has
 * moved or been duplicated: a mutation harness that silently no-ops when its
 * target moves is the decorative check this whole exercise is against.
 */
export function buildMutant(source: string, selfPath: string): string {
  const declarations = [...source.matchAll(EXIT_DECL)];
  if (declarations.length !== 1) {
    throw new ProofAborted(
      `could not build the mutant: the exit-code declaration appears ${declarations.length} times ` +
        `in ${selfPath}, and a mutation of one of several leaves the others refusing`,
    );
  }
  // The constant's NAME is read off the declaration, never written down a
  // second time: a second spelling is a second decider about what the one
  // exit site is allowed to be handed.
  const constant = declarations[0][1];
  const exits = [...source.matchAll(EXIT_CALL)].map((m) => m[1].trim());
  const inlined = exits.filter((arg) => arg !== constant);
  if (exits.length !== 1 || inlined.length > 0) {
    throw new ProofAborted(
      `could not build the mutant: ${selfPath} exits ${exits.length} times and ` +
        `${inlined.length} of them bypass the constant (${inlined.join(", ") || "none"}) — ` +
        `a refusal written with a literal code is invisible to this mutation`,
    );
  }
  let mutant = source.replace(EXIT_DECL, (line) => line.replace(" = 1;", " = 0;"));
  mutant = mutant.replace(RELATIVE_IMPORT, (_m, spec: string) => `from "${resolve(dirname(selfPath), spec)}"`);
  if (/from ["']\.[^"']*["']/.test(mutant)) {
    throw new ProofAborted(
      "could not build the mutant: a relative import survived the rewrite, and the mutant " +
        "would die on module resolution — a non-zero exit that reads as the mutation having " +
        "been rejected on the merits",
    );
  }
  return mutant;
}

/** A row that passes only when the builder REFUSES to build from a doctored source. */
function aborts(name: string, doctored: string, selfPath: string): Row {
  try {
    buildMutant(doctored, selfPath);
    return { name, ok: false, detail: "the builder returned a copy instead of aborting" };
  } catch (err) {
    const aborted = err instanceof ProofAborted;
    return {
      name,
      ok: aborted,
      detail: aborted ? (err as Error).message.slice(0, 140) : `threw ${String(err)}`,
    };
  }
}

/** The bytes are never compared here; only exit codes and sentences are read. */
function proveRefusal(
  real: string,
  mutant: string,
  name: string,
  argv: string[],
  expected: ClaimContentComparison["reading"],
  mustName: string[],
): Row[] {
  const r = runScript(real, argv);
  const m = runScript(mutant, argv);
  const rows: Row[] = [];

  rows.push({
    name: `${name}: the real script REFUSES`,
    ok: r.code !== 0 && r.report?.reading === expected && r.report?.collectable === false,
    detail: `exit ${r.code}, reading ${r.report?.reading ?? "<no report>"}, collectable ${String(
      r.report?.collectable,
    )}`,
  });

  const missing = mustName.filter((token) => !r.stderr.includes(token));
  rows.push({
    name: `${name}: the refusal names what an operator needs`,
    ok: missing.length === 0,
    detail: missing.length === 0 ? `names all ${mustName.length} facts` : `missing: ${missing.join(" | ")}`,
  });

  // The mutant must reach the SAME reading: that is what makes its exit 0 the
  // removed refusal rather than a crash, a usage error or an unresolved import.
  rows.push({
    name: `${name}: the mutant (exit constant 0) does NOT refuse`,
    ok: m.code === 0 && m.report?.reading === expected,
    detail: `exit ${m.code}, reading ${m.report?.reading ?? "<no report>"}${
      m.code !== 0 ? ` — stderr: ${m.stderr.trim().slice(0, 200)}` : ""
    }`,
  });

  rows.push({
    name: `${name}: real and mutant differ ONLY in the exit code`,
    ok: r.code !== m.code && r.report?.reading === m.report?.reading && r.stdout === m.stdout,
    detail: `real exit ${r.code} / mutant exit ${m.code}, same stdout: ${String(r.stdout === m.stdout)}`,
  });

  return rows;
}

function prove(): Emission {
  const source = readFileSync(SELF, "utf8");
  const root = mkdtempSync(join(tmpdir(), "compare-claim-content-prove-"));
  try {
    const mutantPath = join(root, "compare-claim-content.mutant.ts");
    writeFileSync(mutantPath, buildMutant(source, SELF));

    const REL = "src/daemon/auto-reflection.ts";
    const reporting = join(root, "wt-reporting");
    const claiming = join(root, "wt-claiming");
    const agreed = join(root, "wt-agreed");
    for (const wt of [reporting, claiming, agreed]) mkdirSync(join(wt, dirname(REL)), { recursive: true });
    writeFileSync(join(reporting, REL), "export const reflect = true;\n");
    writeFileSync(join(claiming, REL), "export const reflect = false;\n");
    writeFileSync(join(agreed, REL), "export const reflect = true;\n");
    // The UNMEASURED side: a worktree that exists with no copy of the file in
    // it, so the reader's own ENOENT is the reason the refusal carries.
    const absent = join(root, "wt-absent");
    mkdirSync(absent, { recursive: true });

    const rows: Row[] = [];

    // The control first. Without it, "exited non-zero" is not evidence of a
    // refusal — a script that cannot run exits non-zero for every input.
    const control = runScript(SELF, ["--path", REL, "--reporting", reporting, "--claiming", agreed]);
    rows.push({
      name: "control: two copies that agree exit 0 and ARE collectable",
      ok: control.code === 0 && control.report?.reading === "IDENTICAL" && control.report.collectable === true,
      detail: `exit ${control.code}, reading ${control.report?.reading ?? "<no report>"}`,
    });

    rows.push(
      ...proveRefusal(
        SELF,
        mutantPath,
        "DIFFERENT",
        ["--path", REL, "--reporting", reporting, "--claiming", claiming],
        "DIFFERENT",
        [REL, reporting, claiming, "DIVERGES IN CONTENT", "claiming worktree's copy"],
      ),
    );

    rows.push(
      ...proveRefusal(
        SELF,
        mutantPath,
        "UNMEASURED",
        ["--path", REL, "--reporting", reporting, "--claiming", absent],
        "UNMEASURED",
        [join(absent, REL), "ENOENT", "NOT reported as collectable"],
      ),
    );

    // Property 1: no second content comparison lives in this file.
    const declaresComparison = (source.match(/function\s+compareClaimedFileContent\b/g) ?? []).length;
    const callsComparison = (source.match(/compareClaimedFileContent\(/g) ?? []).length;
    rows.push({
      name: "the comparison is called once here and declared nowhere here",
      ok: declaresComparison === 0 && callsComparison === 1,
      detail: `${declaresComparison} declarations, ${callsComparison} calls`,
    });

    // The builder itself must be LOUD. A harness that silently returns an
    // unmutated copy when its anchor moves turns both refusal rows above into
    // two runs of the same program, and every one of them would pass.
    rows.push(aborts("the builder aborts when the exit declaration is gone", source.replace(EXIT_DECL, ""), SELF));
    // Composed rather than written out: a literal second exit in THIS file
    // would be counted by the scan it is meant to feed, and the builder would
    // abort on the real source.
    const bypass = `${source}\nif (false) process.${"exit"}(2);\n`;
    rows.push(aborts("the builder aborts on a refusal that bypasses the constant", bypass, SELF));

    for (const row of rows) {
      process.stderr.write(`${row.ok ? "PASS" : "FAIL"}  ${row.name} — ${row.detail}\n`);
    }

    const failed = rows.filter((row) => !row.ok);
    const body = { proof: { rows: rows.length, failed: failed.length } };
    if (failed.length === 0) return { body, refusal: null };
    return {
      body,
      refusal:
        `REFUSED --prove: ${failed.length} of ${rows.length} proof rows failed — ` +
        failed.map((row) => row.name).join("; "),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────

function main(argv: string[]): Emission {
  const args = parseArgs(argv);
  if (args.prove) return prove();

  const missing = (["path", "reporting", "claiming"] as const).filter((k) => !args[k].trim());
  if (missing.length > 0) {
    return comparisonEmission(
      null,
      `REFUSED: no comparison was requested — ${missing.map((m) => `--${m}`).join(", ")} ` +
        "missing. Usage: --path <repo-relative file> --reporting <worktree> --claiming <worktree>",
    );
  }

  return comparisonEmission(
    compareClaimedFileContent({
      path: args.path,
      reportingWorktree: args.reporting,
      claimingWorktree: args.claiming,
    }),
    null,
  );
}

if (import.meta.main) {
  try {
    finish(main(process.argv.slice(2)));
  } catch (err) {
    // An abort is a refusal: a proof that could not be built has measured
    // nothing, and nothing is not a pass.
    finish({
      body: { proof: null },
      refusal: `REFUSED: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
