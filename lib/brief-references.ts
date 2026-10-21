/**
 * Whether a `node_modules/...` path named in an agent brief could be checked
 * at all (#884).
 *
 * AGENT-6 resolves every `node_modules/...` path the briefs reference. A ship
 * worktree is created without an install, so in one the paths cannot be
 * resolved — and the check reported them as BROKEN. Both of the files it named
 * exist in the main checkout; the briefs were correct and the corpus was
 * missing. `record-local-env` runs the suite in that worktree, so the FAIL was
 * recorded as the project's test health and failed `tests-pass` on every run.
 *
 * A conformity check whose corpus is absent did not run. Three outcomes, not
 * two:
 *
 * | the package is | the path is | status |
 * |---|---|---|
 * | installed | present | `resolved` |
 * | installed | absent | `broken` — AGENT-6 fails, as before |
 * | not installed | unknowable | `unresolvable` — UNMEASURED, by name |
 *
 * The third is NOT a pass. `0`, `{}`, `SKIP` and silence are indistinguishable
 * from success, so an unresolvable reference is recorded as a WARN finding
 * naming the package that is missing, per `.claude/rules/config-access.md`.
 *
 * ## One binding
 *
 * `briefReferenceReading` is the only thing that decides any of this, and
 * `reading` / `absentCorpora` are projections of the lists it builds rather
 * than second answers computed beside them — two deciders that agree are
 * behaviourally one, and no behavioural test can tell them apart.
 *
 * It lives here rather than in `lib/conformity.ts` because conformity imports
 * `bun:test` at module scope and so cannot be imported by a CLI. Same
 * arrangement as `lib/fallow-availability.ts` (#581) and `lib/git-dates.ts`
 * (#508).
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * The packages the project says it depends on, or `null` when it does not say.
 *
 * This is the evidence that stops the UNMEASURED reading swallowing a real
 * finding. In a tree that HAS an install, a reference into a package the
 * manifest never declared cannot be "not installed yet" — it is a wrong
 * reference, and before #884 it was reported as one. `null` is a third answer
 * and not an empty set: a project with no readable manifest has told us
 * nothing, and nothing is not "depends on nothing".
 */
export function declaredPackages(root: string): Set<string> | null {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  } catch {
    return null;
  }
  if (pkg === null || typeof pkg !== "object") return null;
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/** The pattern AGENT-6 has always used to find references. Unchanged. */
export const BRIEF_REFERENCE_PATTERN = /node_modules\/[^\s`*)"']+/g;

/** Markdown punctuation a reference picks up from the prose around it. */
export function cleanBriefReference(raw: string): string {
  return raw.replace(/[`*)"']+$/, "");
}

export type BriefReferenceStatus = "resolved" | "broken" | "unresolvable";

export interface BriefReference {
  /** The brief's file name, e.g. `quinn.md`. */
  brief: string;
  /** The cleaned reference, repo-relative. */
  ref: string;
  /** The installed tree this reference lives inside, repo-relative. */
  packageRoot: string;
  status: BriefReferenceStatus;
}

export interface BriefReferenceReading {
  /** `UNMEASURED` as soon as one reference could not be looked at. */
  reading: "MEASURED" | "UNMEASURED";
  references: BriefReference[];
  broken: BriefReference[];
  unresolvable: BriefReference[];
  /** The corpora the scan could not see, deduped and sorted. */
  absentCorpora: string[];
}

/**
 * The installed tree a reference lives inside — the thing whose absence makes
 * the reference unknowable rather than wrong.
 *
 * For a scoped package that is `node_modules/@scope/name` and not
 * `node_modules/@scope`: a scope directory holding some other package of the
 * same scope is present while the package itself is not, and a corpus computed
 * one segment short reads that tree as an install.
 */
export function corpusOf(ref: string): string {
  const parts = ref.split("/");
  if (parts.length >= 3 && parts[1]!.startsWith("@")) return parts.slice(0, 3).join("/");
  if (parts.length >= 2) return parts.slice(0, 2).join("/");
  return "node_modules";
}

/**
 * Three outcomes, and the order of the three questions is the whole design.
 *
 * 1. **A traversal segment is broken, and is never probed.** `node_modules/../..`
 *    matches the reference pattern, and probing it turns a conformity check
 *    into a filesystem-existence oracle for paths outside the repository. A
 *    brief naming one is a wrong reference whatever is on disk, so the answer
 *    does not need the disk.
 * 2. **No install at all means no reading, unconditionally.** This is #884's
 *    case: a ship worktree. Nothing about the project's manifest can make a
 *    reference checkable when there is nothing to check it against.
 * 3. **With an install present, the manifest decides.** A declared dependency
 *    that is not there is a broken or partial install — unknowable. A package
 *    the project never declared is a wrong reference, and it was reported as
 *    one before #884. Asking the manifest here is what stops the new
 *    UNMEASURED reading swallowing that finding: without it, a typo in a
 *    package name goes silent in a fully installed tree.
 *
 * A project with no readable manifest has said nothing, so step 3 cannot run
 * and the answer is `unresolvable`. That is UNMEASURED by name, not a pass.
 */
export function classifyBriefReference(
  root: string,
  ref: string,
  declared: Set<string> | null = declaredPackages(root),
): BriefReferenceStatus {
  if (ref.split("/").includes("..")) return "broken";
  if (!existsSync(join(root, "node_modules"))) return "unresolvable";
  const corpus = corpusOf(ref);
  if (!existsSync(join(root, corpus))) {
    return declared !== null && !declared.has(corpus.replace(/^node_modules\//, ""))
      ? "broken"
      : "unresolvable";
  }
  return existsSync(join(root, ref)) ? "resolved" : "broken";
}

export function briefReferenceReading(root: string, agentsDir: string): BriefReferenceReading {
  const references: BriefReference[] = [];
  // Read once per reading, not once per reference: the manifest cannot change
  // mid-scan, and a second read is a second chance to disagree with the first.
  const declared = declaredPackages(root);
  if (existsSync(agentsDir)) {
    for (const brief of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(agentsDir, brief), "utf-8");
      for (const raw of content.match(BRIEF_REFERENCE_PATTERN) ?? []) {
        const ref = cleanBriefReference(raw);
        references.push({
          brief,
          ref,
          packageRoot: corpusOf(ref),
          status: classifyBriefReference(root, ref, declared),
        });
      }
    }
  }
  const broken = references.filter(r => r.status === "broken");
  const unresolvable = references.filter(r => r.status === "unresolvable");
  return {
    reading: unresolvable.length > 0 ? "UNMEASURED" : "MEASURED",
    references,
    broken,
    unresolvable,
    absentCorpora: [...new Set(unresolvable.map(r => r.packageRoot))].sort(),
  };
}

/** What a single unresolvable reference records, as the finding says it. */
export function unresolvableBriefReferenceMessage(r: BriefReference): string {
  return (
    `UNMEASURED — the brief references "${r.ref}", but "${r.packageRoot}" is not ` +
    `installed in this checkout, so the reference was never checked. ` +
    `This is not a passing reference and it is not a broken one.`
  );
}

/**
 * The line the suite prints in place of a reading it could not take, or `null`
 * when there was nothing it could not take.
 *
 * `null` rather than an empty string: a notice composed unconditionally names
 * UNMEASURED on a clean tree too, and then the word stops meaning anything.
 */
export function unmeasuredBriefReferenceNotice(r: BriefReferenceReading): string | null {
  if (r.reading !== "UNMEASURED") return null;
  const lines = r.unresolvable.map(u => `  ${u.brief} → ${u.ref}`);
  return (
    `UNMEASURED — ${r.unresolvable.length} brief reference(s) could not be checked ` +
    `because ${r.absentCorpora.join(", ")} ${r.absentCorpora.length === 1 ? "is" : "are"} ` +
    `not installed here. Run the install in this checkout and re-run; a worktree ` +
    `created without dependencies cannot see the package corpus.\n${lines.join("\n")}`
  );
}
