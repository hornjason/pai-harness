/**
 * The one place rungate puts bytes on a path under `specs/` (#1552).
 *
 * ## Why a chokepoint and not thirteen guards
 *
 * #1286 and #1549 guarded thirteen spec write paths individually, each one
 * asking `mayWrite` beside its own `writeFileSync`. That is thirteen places
 * that have to remember, and **the measured forget rate was 2 of 12** — both
 * found by re-deriving the population, not by any check. A completeness sweep
 * over classified files cannot fix that: classification is list membership,
 * not reachability, so it fails when a known writer is *unclassified* and
 * stays green when somebody adds a brand new unguarded one.
 *
 * So the remembering moves into a function. Call `writeSpec` and the question
 * is asked for you; write a raw primitive at a spec path and
 * `specChokepointViolations` in `lib/spec-write-sweep.ts` names the call site.
 *
 * ## This is NOT a second decider
 *
 * `mayWrite` in `lib/derived-spec.ts` owns the refusal and still does. This
 * module **consults** it and routes the answer; it contains no comparison of
 * its own against `DerivedStatus`, and `test/spec-write-chokepoint.test.ts`
 * asserts that by mutating `mayWrite` and watching every call site here flip.
 *
 * Two guards answering the same question about the same input are
 * behaviourally one guard, and a mutation of either leaves the other holding
 * every case up — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Adding a `reading.status ===`
 * comparison to this file would be exactly that, in the module whose whole
 * purpose is to have one answer.
 *
 * ## No relative imports except the guard, on purpose
 *
 * `test/derived-spec-guard.test.ts` copies this file and `lib/derived-spec.ts`
 * into an `mkdtemp` tree to mutate the guard underneath the real write paths.
 * `./derived-spec` must stay the one relative specifier so it binds to the
 * mutant copy; anything else relative would have to be carried too, and a
 * mutant that dies on module resolution is indistinguishable from a guard that
 * held.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { mayWrite, readDerivedDeclaration, skipLine, type DerivedReading } from "./derived-spec";

export interface SpecWriteResult {
  /** Whether the bytes reached disk. */
  written: boolean;
  /** What the file on disk claimed about who produces it. */
  reading: DerivedReading;
  /**
   * Why the write was held, in one line naming the file and the reason.
   * Present exactly when `written` is false — a refusal nobody can report is
   * the same defect as a silent write.
   */
  refusal: string | null;
}

export interface WriteSpecOptions {
  /**
   * How the refusal should name the file. Defaults to `specPath`. Callers that
   * report repo-relative paths pass the relative one so the line they print
   * matches the rest of their output.
   */
  label?: string;
}

/**
 * Write a spec, unless the file on disk says a generator owns its bytes.
 *
 * A path that does not exist yet is a creation: there are no bytes to own, so
 * it is written. That keeps the create-only writers (`create-spec.ts`,
 * `convert-spec.ts`) on the same route as everything else rather than beside
 * it — they each refuse by name when the target exists, which is a *second*
 * reason they are safe, not the reason this function is.
 */
export function writeSpec(
  specPath: string,
  content: string,
  opts?: WriteSpecOptions,
): SpecWriteResult {
  const reading: DerivedReading = existsSync(specPath)
    ? readDerivedDeclaration(readFileSync(specPath, "utf-8"))
    : { status: "authored" };

  if (!mayWrite(reading)) {
    return { written: false, reading, refusal: skipLine(opts?.label ?? specPath, reading) };
  }

  writeFileSync(specPath, content);
  return { written: true, reading, refusal: null };
}

/**
 * The same decision, for a caller that already holds the file's current bytes
 * and wants to ask before doing the work rather than after.
 *
 * `audit-specs.ts` needs this: a derived file must contribute no `RewriteEntry`
 * either, because the scaffold turns those into `UPDATED: specs/<file>` and
 * stages the path, so recording rewrites for a file nobody wrote reports an
 * edit that did not happen. Asking early and asking at the write are two
 * consults of ONE decider, not two deciders — both land on `mayWrite`.
 */
export function maySpecBeWritten(currentContent: string): {
  allowed: boolean;
  reading: DerivedReading;
} {
  const reading = readDerivedDeclaration(currentContent);
  return { allowed: mayWrite(reading), reading };
}

/**
 * The same decision about bytes that are about to be DESTROYED rather than
 * rewritten — a rename or a copy whose destination already exists.
 *
 * POSIX `rename()` replaces its destination silently, so a move into `specs/`
 * can annihilate a generator-owned spec without ever calling a write
 * primitive on it. The PR that built this chokepoint claimed otherwise —
 * *"a move does not rewrite bytes, so no reading applies"* — which is true of
 * the bytes moved and says nothing about the bytes overwritten. Found by the
 * AI review on #1552.
 *
 * A destination that does not exist is a creation and is allowed; this
 * function never looks at the source, because the question is only ever about
 * who owns what is already there.
 */
export function maySpecBeReplaced(
  targetPath: string,
  opts?: WriteSpecOptions,
): { allowed: boolean; reading: DerivedReading; refusal: string | null } {
  if (!existsSync(targetPath)) {
    return { allowed: true, reading: { status: "authored" }, refusal: null };
  }
  const { allowed, reading } = maySpecBeWritten(readFileSync(targetPath, "utf-8"));
  return {
    allowed,
    reading,
    refusal: allowed ? null : skipLine(opts?.label ?? targetPath, reading),
  };
}
