/**
 * The one Bun version for a project (#622).
 *
 * Nothing in this repository pinned the runtime. `.github/workflows/ci.yml`
 * and `gates.yml` carried `bun-version: "latest"`, `release.yml` carried the
 * literal `"1.3.14"`, the development machine ran 1.3.14 and CI's `latest`
 * resolved to **1.4.3** — a full minor apart, with nothing comparing any of
 * the four.
 *
 * `latest` is the opposite of a pin: the runtime executing a given commit can
 * change between two runs of that same commit, with nothing in the diff to
 * explain a new failure. Re-running a red job was also a Bun upgrade, and a
 * green local run could not say which runtime produced it.
 *
 * ## Why this is a module and not a string in two template literals
 *
 * It was two, and they were fed by `harness?.ci?.bunVersion || "latest"` in
 * `lib/scaffold/steps.ts` while two other workflow files — neither of them
 * generated — named versions of their own. Four positions, three spellings,
 * no decider. This is #87's fix for the type check and #488's for the test
 * command, applied to the step directly beside them: one binding, so a
 * mutation of it can show that the agreement is load-bearing rather than
 * coincidental.
 *
 * ## The rungs, and what each one is not
 *
 * 1. **`.bun-version` at the project root.** The ecosystem's file:
 *    `oven-sh/setup-bun` reads it through `bun-version-file`, and so do
 *    `mise` and `asdf`. It wins because it is the file CI itself obeys —
 *    a resolver that preferred something else would be naming a version CI
 *    does not install.
 * 2. **`ci.bunVersion` in the rungate config.** The field the harness has
 *    documented since SC-86, and the only declaration a consumer who has not
 *    adopted `.bun-version` has. Emitted as a literal, because there is no
 *    file for CI to point at.
 * 3. **Nothing.** `null`, and the state is named `undeclared` rather than
 *    quietly becoming `latest`. `.claude/rules/config-access.md`: a built-in
 *    default substituted for an absent declaration must be loud, because `0`,
 *    `{}`, `null` and silence are all indistinguishable from success.
 *
 * ## What this does NOT cover
 *
 * - **Which bun is on the developer's PATH.** Two installations from two
 *   package managers sit on the issue's machine; this reports the mismatch,
 *   it cannot fix it. That is what `bunVersionReading` is for.
 * - **Whether the declared version exists.** A pin CI cannot resolve fails
 *   the job, loudly, naming the value — which is the point. A
 *   well-formedness guard with `|| "latest"` behind it is the cheapest repair
 *   for that failure and is exactly the silent fallback AC-7 forbids, so
 *   `isPinnedBunVersion` refuses moving tags and nothing else.
 * - **`package.json` `engines.bun` and `.tool-versions`.** Neither exists in
 *   this tree, and a rung nobody declares is a rung nothing can test. Add one
 *   here, with a case, if a consumer turns up on it — not before.
 * - **`workflows/*.js`.** They cannot import (#69) and none of them installs
 *   bun; if one ever does, it reads the resolved config the way every other
 *   workflow prompt does.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tryLoadRungateConfig } from "./config-loader";

/** The declaration file, at the project root. The name `setup-bun` knows. */
export const BUN_VERSION_FILE = ".bun-version";

/**
 * Tags that resolve to whatever shipped today. Declaring one is a declaration
 * that the project is NOT pinned, which is a legitimate thing for a consumer
 * to choose and is not a thing this repository may choose by accident.
 */
export const MOVING_BUN_TAGS = ["latest", "canary"] as const;

export type BunVersionSource = "bun-version-file" | "config" | "undeclared";

export interface BunVersionDecision {
  /** The declared version. Null only when nothing declares one. */
  version: string | null;
  source: BunVersionSource;
  /** Why this version and not another. */
  reason: string;
  /**
   * Both declarations present and disagreeing. Empty when they agree, or when
   * only one of them exists. Reported rather than resolved in silence: two
   * positions naming two versions is #621's defect, and the loser here is the
   * one a human is most likely to have edited.
   */
  conflict: string;
}

/** Where a decision came from, spelled the way a log reader can act on. */
export function bunVersionSourceLabel(source: BunVersionSource): string {
  if (source === "bun-version-file") return BUN_VERSION_FILE;
  if (source === "config") return "ci.bunVersion in .claude/rungate/config.json";
  return "no declaration";
}

/**
 * Is this a pin — a value that names the same runtime tomorrow?
 *
 * Deliberately NOT a semver test. `1.0.x`, a commit sha and a download URL are
 * all things `setup-bun` resolves, and narrowing this to `\d+\.\d+\.\d+` is
 * the over-narrow detector that would reject a legitimate declaration and send
 * someone looking for a fallback.
 */
export function isPinnedBunVersion(version: string | null | undefined): boolean {
  if (typeof version !== "string") return false;
  const v = version.trim();
  if (v === "") return false;
  return !(MOVING_BUN_TAGS as readonly string[]).includes(v);
}

function fileDeclaration(root: string): string | null {
  const path = join(root, BUN_VERSION_FILE);
  if (!existsSync(path)) return null;
  // A file that exists and says nothing is not a declaration. It is also not
  // a reason to throw: `setup-bun` would fail on it anyway, and the rung below
  // is a better answer than a dead scaffold.
  const raw = readFileSync(path, "utf-8").trim();
  return raw === "" ? null : raw;
}

function configDeclaration(root: string): string | null {
  // Through the loader, never a constructed path to `.claude/rungate*`
  // (`.claude/rules/config-access.md`), so both config layouts are honoured.
  // It THROWS on a malformed config, deliberately: a corrupt config is never a
  // missing config, and `catch {}` here is the conversion that rule forbids.
  const config = tryLoadRungateConfig(root) as { ci?: { bunVersion?: unknown } } | null;
  const declared = config?.ci?.bunVersion;
  if (typeof declared !== "string" || declared.trim() === "") return null;
  return declared.trim();
}

/** One position that declares a version, and what it says. */
export interface BunVersionDeclaration {
  source: Exclude<BunVersionSource, "undeclared">;
  version: string;
}

/**
 * Every position in a project that declares a Bun version, in rung order.
 *
 * Separate from `declaredBunVersion` because the two questions are different:
 * the decision is "what will CI install", and this is "who said so". A caller
 * comparing positions — `scripts/contract-parity.ts` — needs the second, and
 * reconstructing it from the decision's `conflict` string was the alternative:
 * a consumer parsing a producer's prose, which is this repository's most
 * expensive recurring mistake (#626).
 */
export function bunVersionDeclarations(root: string): BunVersionDeclaration[] {
  const out: BunVersionDeclaration[] = [];
  const fromFile = fileDeclaration(root);
  if (fromFile !== null) out.push({ source: "bun-version-file", version: fromFile });
  const fromConfig = configDeclaration(root);
  if (fromConfig !== null) out.push({ source: "config", version: fromConfig });
  return out;
}

export function declaredBunVersion(root: string): BunVersionDecision {
  const declarations = bunVersionDeclarations(root);
  const fromFile = declarations.find(d => d.source === "bun-version-file")?.version ?? null;
  const fromConfig = declarations.find(d => d.source === "config")?.version ?? null;
  const conflict =
    fromFile !== null && fromConfig !== null && fromFile !== fromConfig
      ? `${BUN_VERSION_FILE} declares ${fromFile} and ci.bunVersion declares ${fromConfig}; ` +
        `CI installs what ${BUN_VERSION_FILE} says, so the config field is the stale one`
      : "";

  if (fromFile !== null) {
    return {
      version: fromFile,
      source: "bun-version-file",
      reason: `the project declares ${BUN_VERSION_FILE}, which is the file setup-bun itself reads`,
      conflict,
    };
  }
  if (fromConfig !== null) {
    return {
      version: fromConfig,
      source: "config",
      reason: `the project declares ci.bunVersion and no ${BUN_VERSION_FILE}`,
      conflict,
    };
  }
  return {
    version: null,
    source: "undeclared",
    reason: `the project declares neither ${BUN_VERSION_FILE} nor ci.bunVersion`,
    conflict,
  };
}

export type BunVersionState = "match" | "mismatch" | "undeclared";

export interface BunVersionReading {
  state: BunVersionState;
  /** One line, for a log somebody pastes into an issue. */
  line: string;
}

/**
 * What a run should say about the runtime it is running on.
 *
 * `running` is a parameter rather than `Bun.version` read inside, and that is
 * the whole of AC-4: a comparison that reads the machine can only be driven
 * with the machine's own answer, so the mismatch branch is unreachable from a
 * test on any machine that is already correct — which is every machine where
 * the case would be written.
 */
export function bunVersionReading(decision: BunVersionDecision, running: string): BunVersionReading {
  const suffix = decision.conflict ? ` WARNING: ${decision.conflict}.` : "";

  if (decision.version === null) {
    return {
      state: "undeclared",
      line:
        `bun ${running} is running, and the declared version is UNMEASURED — ` +
        `${decision.reason}, so this run says nothing about what CI will install.${suffix}`,
    };
  }
  if (decision.version !== running) {
    return {
      state: "mismatch",
      line:
        `WARNING: bun ${running} is running but ${bunVersionSourceLabel(decision.source)} declares ` +
        `${decision.version} — this run does NOT model CI, and a result pasted from it ` +
        `describes ${running}.${suffix}`,
    };
  }
  return {
    state: "match",
    line: `bun ${running} (declared in ${bunVersionSourceLabel(decision.source)}).${suffix}`,
  };
}

/**
 * What a `setup-bun` step's `with:` block NAMES, one entry per step.
 *
 * The reading half of `setupBunWith` below, and here rather than in
 * `scripts/contract-parity.ts` (#637, AC-9) for one reason: the generator and
 * the reader of the thing it generates are a producer and a consumer that must
 * agree, and keeping them in one module is what makes a round-trip case —
 * emit a step, read it back, compare — an ordinary import rather than a second
 * copy of this regex somewhere a script can reach.
 *
 * Deliberately text, not YAML: `#622c`'s position is the step the SCAFFOLD
 * would emit, which is a string that has never been a file.
 */
export function setupBunDeclarations(text: string): Array<{ key: "bun-version" | "bun-version-file"; value: string }> {
  const out: Array<{ key: "bun-version" | "bun-version-file"; value: string }> = [];
  for (const m of text.matchAll(/^\s*(bun-version|bun-version-file):\s*"?([^"\s#]+)"?\s*$/gm)) {
    out.push({ key: m[1] as "bun-version" | "bun-version-file", value: m[2] });
  }
  return out;
}

/**
 * The `# UNPINNED:` block, spelled in exactly one place (#932).
 *
 * Three rungs can now reach it — a moving tag in `.bun-version`, a moving tag
 * in `ci.bunVersion`, and no declaration at all — and a second copy of the
 * marker would survive a mutation of the first, leaving a case green over a
 * rung that had gone quiet (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
function unpinnedComment(indent: string, why: string, remedy: string): string {
  return (
    `${indent}# UNPINNED: ${why}, so every run of this job installs whatever\n` +
    `${indent}# shipped today and re-running a red job is also a Bun upgrade. ${remedy}\n`
  );
}

/** How to stop being unpinned, from a rung that already declares something. */
function repinRemedy(source: Exclude<BunVersionSource, "undeclared">): string {
  return `Name an exact version in ${bunVersionSourceLabel(source)} and re-scaffold.`;
}

/**
 * The `with:` body of a generated `oven-sh/setup-bun` step.
 *
 * One function, so the generator has nothing to decide and no second place
 * for a fallback to grow. It returns LINES rather than writing anything,
 * which is what lets a test assert the emission for a declaration no machine
 * has — including one CI cannot resolve.
 *
 * ## Why the pin test is asked here and not only by the checker (#932)
 *
 * `isPinnedBunVersion` had exactly one consumer — `scripts/contract-parity.ts`
 * — and the generator was not it. So a consumer declaring
 * `ci.bunVersion: "latest"` had `bun-version: "latest"` written into a managed
 * workflow under prose describing a successful declaration, and the only way
 * to learn otherwise was to run the checker, which then called that same line
 * a violation. One predicate, two positions, opposite behaviour.
 *
 * Worse, it inverted the rungs: a project declaring NOTHING got the loud block
 * below, and a project declaring a moving tag got silence. Declaring `latest`
 * was reported strictly better than declaring nothing, while installing the
 * same runtime.
 *
 * The VALUE is still emitted verbatim at every rung. `MOVING_BUN_TAGS` says
 * declaring one "is a legitimate thing for a consumer to choose", and
 * substituting a pin here would change a consumer's runtime without being
 * asked — which is AC-7's forbidden silent fallback wearing a fix. What
 * changes is only that the file says what it is.
 */
export function setupBunWith(decision: BunVersionDecision, indent: string): string {
  const pinned = isPinnedBunVersion(decision.version);

  if (decision.source === "bun-version-file") {
    // The file still wins and CI still reads it: what is wrong about a
    // `.bun-version` holding `canary` is the prose, not the mechanism, and
    // spelling a literal here instead would put a second position naming the
    // version back into the workflow — #622's defect, repaired into existence.
    const comment = pinned
      ? `${indent}# Pinned by ${BUN_VERSION_FILE} — the project's single declaration (#622).\n` +
        `${indent}# setup-bun reads that file, so there is no version spelled here to drift from it.\n`
      : unpinnedComment(
          indent,
          `${BUN_VERSION_FILE} declares the moving tag \`${decision.version}\``,
          repinRemedy("bun-version-file"),
        );
    return comment + `${indent}bun-version-file: "${BUN_VERSION_FILE}"`;
  }

  if (decision.source === "config") {
    const comment = pinned
      ? `${indent}# From ci.bunVersion in .claude/rungate/config.json — this project declares no\n` +
        `${indent}# ${BUN_VERSION_FILE}. Add one and re-scaffold to let CI read the declaration directly.\n`
      : unpinnedComment(
          indent,
          `ci.bunVersion in .claude/rungate/config.json declares the moving tag ` +
            `\`${decision.version}\``,
          repinRemedy("config"),
        );
    return comment + `${indent}bun-version: "${decision.version}"`;
  }

  // UNPINNED, said out loud. The value is unchanged from what this generator
  // has always emitted for a project that declares nothing — changing a
  // consumer's runtime without being asked is not this issue's business — but
  // the silence is. An unpinned CI is a state, and a state that is not
  // reportable is one nobody fixes.
  return (
    unpinnedComment(
      indent,
      decision.reason,
      `Declare a version in ${BUN_VERSION_FILE} (or ci.bunVersion) and re-scaffold.`,
    ) + `${indent}bun-version: "latest"`
  );
}
