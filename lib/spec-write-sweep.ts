/**
 * Every call site in this tree that can put bytes on disk, and which of them
 * aim at a spec (#1552).
 *
 * ## What this replaces
 *
 * #1286's completeness sweep classified *files*: a file that reads and writes
 * the same identifier had to appear on one of two declared lists. That check
 * fails when a known writer is unclassified and **cannot** fail when somebody
 * adds a new unguarded one, because list membership is not reachability. It is
 * also blind below the file — a second unguarded write site inside an
 * already-classified file is invisible to it (#1548).
 *
 * This sweep's unit is the **call site**, and its reading is the write's
 * **target expression**, so both of those holes close at once. The question it
 * answers is not "has somebody classified this file" but "does a raw write
 * primitive aim at a spec path without going through `lib/write-spec.ts`".
 *
 * ## The detector's view, stated so it can be argued with
 *
 * For each call to a write primitive, the sweep reads the **written argument
 * expression** and resolves the identifiers in it against the real scope
 * chain. A site is spec-targeting when the resolved text matches `SPEC_TARGET`.
 *
 * The resolution lives in `lib/spec-write-ast.ts` and goes through `acorn` via
 * `lib/ts-ast.ts`. It replaces a hand-rolled lexer whose `initialiserOf` was a
 * file-global name scan (#1566): four AI-review rounds on #1557 found four
 * separate edge cases in that lexer and a fifth was found by its own negative
 * control. The question it was answering — "which binding does this identifier
 * resolve to" — is scope and position, and no name scan answers it.
 *
 * Two deliberate properties:
 *
 *   - **It over-reports.** `spec-compliance-auto.test.ts` is a test, not a
 *     spec, and it matches. An over-report costs one classified line in
 *     `NOT_A_SPEC_PATH`; an under-report is how three unguarded writers
 *     reached review across #1286 and #1549.
 *   - **It names what it cannot resolve.** A parameter, an import and a
 *     destructured binding carry no readable value, and each is reported as
 *     UNRESOLVED rather than resolving to something plausible. A site whose
 *     target shows no string literal AND has an unresolved identifier is
 *     `opaque`: the path is entirely invisible, so the sweep cannot claim it is
 *     not a spec.
 *
 * ## Which directories are in scope, decided rather than inherited
 *
 * The TypeScript half sweeps five directories — `lib scripts gates bin hooks`.
 * `workflows/` and `.github/` are ALSO swept, for `.js`, and that is a
 * deliberate inclusion rather than the default:
 *
 *   - MEASURED 2026-10-24, `grep -rnE '(writeFileSync|writeFile|appendFileSync|
 *     appendFile|renameSync|copyFileSync|truncateSync|Bun\.write)\s*\(' workflows
 *     .github` → **2** call sites, **0** of them naming a spec or an ADR. So
 *     including them changes no reading today.
 *   - They are included anyway because **`workflows/*.js` cannot import**
 *     (#69). That makes them the one region where the chokepoint is not
 *     merely skipped but *unavailable*, so a future spec write there would be
 *     unguarded with no local remedy — it would have to call the CLI. A
 *     region a guard cannot reach is exactly the region worth watching.
 *
 * ## Shell is covered, and the population is zero
 *
 * `shellSpecWrites` scans `.github/workflows/*.yml`, `workflows/`, and `*.sh`
 * for a redirect, a `tee`, or a `sed -i` whose target names `specs/`. Measured
 * 2026-10-24: zero. A TypeScript-only chokepoint is therefore sufficient
 * *today*, which is a fact about the tree and not a property of the design —
 * so the shell reading is taken rather than assumed, and it has its own
 * planted-violation case.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  resolveLines,
  SIMPLE_PRIMITIVES,
  specTargetingOf,
  writeSitesIn,
} from "./spec-write-ast";

/** The module every spec write must route through. Excluded from the sweep. */
export const CHOKEPOINT = "lib/write-spec.ts";

/**
 * Everything that can put bytes on disk, including the non-`fs` spellings.
 *
 * Derived from `SIMPLE_PRIMITIVES` rather than restated, so there is ONE list
 * to extend. A second copy here would drift from the one the detector reads
 * and the sweep would go green on a primitive it no longer looks for.
 */
export const WRITE_PRIMITIVES = [...SIMPLE_PRIMITIVES, "Bun.write"] as const;

/** Directories whose TypeScript sources are swept. */
export const SWEPT_DIRS = ["lib", "scripts", "gates", "bin", "hooks"] as const;

/**
 * Directories swept for `.js` instead. See the scope note in the module
 * docblock: these are included because `workflows/*.js` cannot import (#69),
 * so the chokepoint is unavailable rather than merely skipped there.
 */
export const SWEPT_JS_DIRS = ["workflows", ".github"] as const;

export interface WriteSite {
  /** Repo-relative path, forward-slashed. */
  file: string;
  /**
   * 1-based line of the call, or `null` when it could not be established.
   *
   * AST node positions index the TRANSPILED text — `Bun.Transpiler` drops
   * comments and blank lines — so the line is resolved by ordinal against the
   * original and refused when the counts disagree. `NOT_A_SPEC_PATH` is keyed
   * on the target expression and never on a line, so a null costs a reader
   * some context and costs the check nothing.
   */
  line: number | null;
  /** Which primitive was called. */
  primitive: string;
  /** The written argument's source text, whitespace-collapsed. */
  target: string;
  /** The text the detector actually read — target plus any expansion. */
  view: string;
  /** Whether `view` names a spec. */
  specTargeting: boolean;
  /** `name: reason` for each identifier in the target carrying no value. */
  unresolved?: string[];
  /** True when the sweep cannot determine this target's path. */
  opaque?: boolean;
  /** True when the target depends on a `let`/`var` binding. */
  reassignable?: boolean;
}

/**
 * Write sites whose target depends on a REASSIGNABLE binding, each with what
 * it actually writes. Keyed `file::targetExpression`.
 *
 * This is the population that makes the strict reading honest. A target built
 * from a `let` or `var` is one whose value at the write the sweep cannot
 * establish — so rather than let it read as "not a spec", every one is listed
 * here and `undeterminedTargets` fails on one that is not.
 *
 * That is what stops the detector being defeated by an assignment spelling
 * nobody enumerated. MEASURED: widening the tracker to destructuring patterns
 * still missed 3 of 6 spellings (a default inside a pattern, `for ([p] of …)`,
 * `for (p of …)`); under this reading all three come out undetermined instead
 * of clean, and a fourth spelling nobody has thought of does too.
 *
 * Six entries on this tree, out of 131 write sites. The flag propagates
 * through the expansion, so a locally-`const` target lands here when an
 * identifier INSIDE it is a `let` — `backupDir`, `outDir` and `SF` are why
 * most of these are listed.
 *
 * This deliberately does NOT cover the wider class of targets with no visible
 * literal at all — 32 sites, nearly all function parameters. That bound
 * predates this change, is stated in `lib/spec-write-ast.ts`, and declaring
 * all 32 would be a guard that flags a quarter of the tree: louder, not more
 * accurate.
 */
export const REASSIGNABLE_TARGETS: Record<string, string> = {
  "lib/test-suite-lock.ts::tmp":
    "a temp sibling of the lock file, `${path}.${pid}.${rand}`, renamed over it; `path` is the lock path",
  "lib/test-suite-lock.ts::path":
    "the suite lock file itself, as the destination of the atomic rename above",
  "lib/worktree-collect.ts::slot":
    "a numbered slot under the collect backup root, from `backupDir` which is a lazily-assigned let",
  "scripts/suite-flake-run.ts::log":
    "`run-NN.log` under the flake run's output directory",
  "scripts/verify-merge-content.ts::out":
    "the artefact path given by --out, written only when that flag was passed",
  "gates/run-gate.ts::SF":
    "the gate state file this script exists to maintain",
};

/**
 * Write sites whose target matches `/spec/i` and is nonetheless not a path
 * under `specs/`. Keyed `file::targetExpression` — a symbol, never a line
 * number, so moving the call does not stale the entry.
 *
 * This is the negative control the check needs, not an exemption lane for
 * spec writers: every entry names something that is demonstrably not a spec,
 * and `test/spec-write-chokepoint.test.ts` refuses an entry whose site has
 * disappeared from the population.
 */
export const NOT_A_SPEC_PATH: Record<string, string> = {
  // Empty, and that is the reading: all nineteen spec writes in this tree
  // were MIGRATED to `writeSpec`, not exempted. An entry here is a claim that
  // a `/spec/i` match is not a spec path, and it has to say what the site
  // writes instead. Grandfathering a spec writer here would make the check
  // decorative, which is the whole failure mode #1552 exists to end.
};

// ── The sweep ─────────────────────────────────────────────────────

/** TypeScript sources under the five swept directories. */
function sourceFiles(root: string, dir: string, out: string[], ext: RegExp): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      sourceFiles(root, rel, out, ext);
      continue;
    }
    if (!ext.test(e.name) || e.name.endsWith(".test.ts")) continue;
    out.push(rel);
  }
}

/**
 * Every write-primitive call site under the swept directories.
 *
 * Throws, naming the file, when a source cannot be parsed. A file the parser
 * gave up on and a file with no writes produce the same empty list, and only
 * one of those is a clean reading.
 */
export function writeSites(root: string, dirs: readonly string[] = SWEPT_DIRS): WriteSite[] {
  const files: string[] = [];
  for (const d of dirs) sourceFiles(root, d, files, /\.ts$/);
  for (const d of SWEPT_JS_DIRS) sourceFiles(root, d, files, /\.js$/);

  const sites: WriteSite[] = [];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf-8");
    const loader = file.endsWith(".js") ? "js" : "ts";
    let found;
    try {
      found = writeSitesIn(raw, { loader });
    } catch (e) {
      throw new Error(`spec-write sweep: UNMEASURED in ${file} — ${(e as Error).message}`);
    }
    const lines = resolveLines(raw, found, { positionsAreOriginal: loader === "js" });
    found.forEach((s, i) => {
      sites.push({
        file,
        line: lines[i],
        primitive: s.primitive,
        target: s.target,
        view: s.view,
        specTargeting: specTargetingOf(s),
        unresolved: s.unresolved,
        opaque: s.opaque,
        reassignable: s.reassignable,
      });
    });
  }
  return sites;
}

/**
 * Raw spec writes that bypass the chokepoint.
 *
 * Empty is the only acceptable reading. A site here is either migrated to
 * `writeSpec` or — if its target is not a spec at all — classified in
 * `NOT_A_SPEC_PATH` with what it writes instead.
 */
export function specChokepointViolations(
  root: string,
  dirs: readonly string[] = SWEPT_DIRS,
  classified: Record<string, string> = NOT_A_SPEC_PATH,
): WriteSite[] {
  return writeSites(root, dirs).filter(
    (s) => s.specTargeting && s.file !== CHOKEPOINT && !(`${s.file}::${s.target}` in classified),
  );
}

/**
 * Write sites built from a reassignable binding that nobody has declared.
 * Empty is the only acceptable reading.
 *
 * Separate from `specChokepointViolations` because it is a different claim: a
 * violation says "this writes a spec and skips the chokepoint", while this
 * says "the sweep cannot establish what this writes, and nobody has said why
 * that is alright". Both must be empty for the chokepoint's green reading to
 * mean anything — without this one, a target the resolver cannot follow reads
 * exactly like a target it followed and cleared.
 */
export function undeterminedTargets(
  root: string,
  dirs: readonly string[] = SWEPT_DIRS,
  declared: Record<string, string> = REASSIGNABLE_TARGETS,
): WriteSite[] {
  return writeSites(root, dirs).filter(
    (s) => s.reassignable && s.file !== CHOKEPOINT && !(`${s.file}::${s.target}` in declared),
  );
}

// ── Shell ─────────────────────────────────────────────────────────

/**
 * A shell redirect, `tee` or `sed -i` whose target names `specs/`.
 *
 * Kept separate from the TypeScript sweep because the two have different
 * remedies: a TypeScript site routes through `writeSpec`, and a shell site has
 * no chokepoint to route through — it must call the CLI or not exist. Today it
 * does not exist, and this is how that stays checkable.
 */
export function shellSpecWrites(root: string, scanned?: string[]): WriteSite[] {
  const files = scanned ?? shellCorpus(root);
  const patterns: Array<[string, RegExp]> = [
    ["redirect", /(?:^|[^>\w])>>?\s*(?:"|')?[^\s"'|;&]*\bspecs\//],
    ["tee", /\btee\s+(?:-a\s+)?(?:"|')?[^\s"'|;&]*\bspecs\//],
    ["sed-i", /\bsed\s+(?:-[a-zA-Z]*\s+)*-i[a-zA-Z]*\b[^\n]*\bspecs\//],
  ];
  const out: WriteSite[] = [];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf-8");
    raw.split("\n").forEach((text, idx) => {
      if (/^\s*#/.test(text)) return;
      for (const [primitive, re] of patterns) {
        if (!re.test(text)) continue;
        out.push({
          file,
          line: idx + 1,
          primitive,
          target: text.trim(),
          view: text.trim(),
          specTargeting: true,
        });
        break;
      }
    });
  }
  return out;
}

/** The shell-shaped files the redirect scan reads. Non-empty, or it is vacuous. */
export function shellCorpus(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(rel);
        continue;
      }
      if (/\.(sh|bash|zsh|ya?ml|js)$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of [".github", "workflows", "scripts", "hooks", "bin"]) walk(d);
  return out.map((p) => p.split(sep).join("/"));
}

/** `relative`, forward-slashed — exported so callers need not import `path`. */
export function repoRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
