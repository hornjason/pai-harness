/**
 * Spawn sites that may be relying on an environment Bun does not pass on.
 *
 * ## The runtime divergence, with its control
 *
 * Under Bun, a `process.env` write made AFTER process start does not reach a
 * child spawned with no explicit `env` option. Under Node it does. Measured
 * 2026-10-22, Bun 1.3.14 and Node v26.3.0, same script and same machine:
 *
 * ```ts
 * process.env.RG_LATE_PROBE = "set-in-process";
 * execFileSync("printenv", ["RG_LATE_PROBE"], { encoding: "utf8" });
 * ```
 *
 * | runtime | no `env:` option | `env: { ...process.env }` |
 * |---|---|---|
 * | `bun probe.ts` | **child does not have it** | `"set-in-process"` |
 * | `node probe.ts` | `"set-in-process"` | `"set-in-process"` |
 *
 * **The Node row is why this is a runtime divergence and not a bad probe.**
 * Without it the next reader reasonably concludes that `printenv` or the
 * variable name was at fault; the only difference between the two rows is
 * which binary ran the identical file. It applies to `Bun.spawnSync` too,
 * not only to the `node:child_process` shims — measured separately, both
 * report the process's STARTUP value.
 *
 * Note the second column: the spread is not ceremony. `{ ...process.env }`
 * reads the live object, so an explicit env is both the diagnosis and the
 * whole fix.
 *
 * Anything scaffolded onto Bun inherits this, so it is worth stating
 * wherever this harness tells a consumer how to write a test that spawns.
 *
 * ## Why a scan and not a list
 *
 * The failure is silent. The child takes its default path, and the assertion
 * usually still passes — for a reason unrelated to the feature under test.
 * Found on #1048 only because a mutation row came back 4 where 5 was
 * predicted; the case was green on every tree, including the one with the
 * feature deleted.
 *
 * So the population is DERIVED, never enumerated. A hand-written list of
 * today's members is written by the person who just fixed them, which means
 * it cannot fail on the day it ships and nothing adds tomorrow's member to
 * it. `lateEnvSpawnSites` recomputes the population from the tree on every
 * run, and a new un-exempted instance is red with no list to update.
 *
 * ## What a member is, and what it is not
 *
 * A member is a spawn call, in a test file that ALSO writes `process.env`,
 * which passes no `env:` option. That is a shape worth looking at and not a
 * defect: an env write and a spawn in one file does not mean the child reads
 * the variable. Plenty of writes are consumed in-process, which works fine.
 *
 * The per-site question is **does this child read the variable this test just
 * set?** A site where the answer is no says so in a `late-env-ok:` comment,
 * and the reason has to be long enough to be a reason — see `MIN_REASON`.
 *
 * Comments and string literals are blanked before matching, via
 * `lib/strip-js-comments.ts` with `blankLiterals`. Two of the eight files
 * #1096 listed by hand are in it because a `grep` counted `execSync` inside a
 * comment and a third because it matched `process.env.X === "1"`, which is a
 * READ. A scanner that reads raw source cannot tell a call from a sentence
 * about a call — `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Issue: #1096. Found during #1048 (PR #1090).
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

import { stripJsComments } from "./strip-js-comments";

/**
 * How long a `late-env-ok:` reason has to be.
 *
 * A marker nobody has to justify is a marker everybody applies, which is the
 * exemption list this scan exists to avoid wearing a different hat.
 * `lib/gate-check-audit.ts` sets the same kind of floor at 80 for a check
 * waiver; this one is lower because the question here is narrower — name the
 * variable and say why the child does not read it.
 */
export const MIN_REASON = 40;

/** The marker that exempts one site, followed by why. */
export const EXEMPT_MARKER = "late-env-ok:";

/**
 * A write to `process.env.<CAPS>`, excluding comparisons.
 *
 * `=(?![=>])` is the whole discrimination: `process.env.X === "1"` is a read,
 * and `process.env.X =>` cannot occur but costs nothing to exclude.
 */
const ENV_WRITE = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\s*=(?![=>])/g;

/** `delete process.env.X` changes the environment just as a write does. */
const ENV_DELETE = /\bdelete\s+process\.env\.([A-Z][A-Z0-9_]*)/g;

/** Every way this repository starts a child process. */
const SPAWN = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|execFileSync|execSync|spawn|execFile|exec)\s*\(/g;

/**
 * An explicit `env` option, in either spelling.
 *
 * The shorthand half is load-bearing and was added after the first run read
 * `test/sync-spec-tests-paths.test.ts:225` as bare. That site builds
 * `const env = { ...process.env }; delete env.HARNESS_ROOT;` and passes
 * `{ cwd, env, … }` — which is not merely explicit, it is the most careful
 * site in the population. A detector that only knew `env:` would have
 * reported the one author who got this exactly right.
 *
 * `(?<![.\w])` keeps `process.env }` out of the shorthand arm: a spread of
 * the whole environment AS the options object is not an env option, and
 * without the guard every `{ ...process.env }` would exempt its own call.
 */
const ENV_OPTION = /(?<![.\w])env\s*(?::|(?=[,}]))/;

export interface LateEnvSite {
  /** Repo-relative, POSIX separators, so a violation message is stable. */
  file: string;
  line: number;
  callee: string;
  /** The variables this file writes late. Named, so the reader can judge. */
  vars: string[];
  /** The stated reason this site does not need an explicit env, if any. */
  exemption: string | null;
}

export class UnreadableScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableScanError";
  }
}

function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(join(root, "test"));
  return out.sort();
}

/**
 * The argument list of a call whose `(` is at `open`, or null if unbalanced.
 *
 * Counted over the literal-blanked view, which is the only view a bracket
 * matcher may count over: a `)` inside a prompt string is text.
 */
function argumentList(blanked: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return blanked.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The contiguous comment block immediately above line `line` (1-based),
 * plus that line itself so a trailing marker counts.
 */
function commentBlockAbove(lines: string[], line: number): string {
  /** Only the comment part of a line, so a reason cannot be padded by code. */
  const commentPart = (raw: string): string | null => {
    const t = raw.trim();
    if (t.startsWith("//")) return t.slice(2).trim();
    if (t.startsWith("*/")) return t.slice(2).replace(/^\*+/, "").trim();
    if (t.startsWith("*")) return t.replace(/^\*+/, "").replace(/\*\/\s*$/, "").trim();
    if (t.startsWith("/*")) return t.slice(2).replace(/^\*+/, "").replace(/\*\/\s*$/, "").trim();
    return null;
  };

  const block: string[] = [];
  for (let i = line - 2; i >= 0; i--) {
    const part = commentPart(lines[i]);
    if (part === null) break;
    block.unshift(part);
  }
  // A trailing marker on the call's own line, comment part only. Without
  // this restriction the reason runs on into the call text and a
  // seven-character excuse measures sixty-six — which is the floor being
  // satisfied by the code it is attached to.
  const own = lines[line - 1] ?? "";
  const slashes = own.indexOf("//");
  if (slashes !== -1) block.push(own.slice(slashes + 2).trim());
  return block.join("\n");
}

/**
 * Every spawn site in a test file that also changes `process.env`.
 *
 * Throws rather than returning `[]` when it can see no test files or no
 * spawn calls at all: an empty population and a scanner that stopped working
 * are the same output, and only one of them is a result
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export interface LateEnvReading {
  /** Test files walked. */
  filesScanned: number;
  /** Spawn calls the pattern matched, across all of them. */
  spawnsExamined: number;
  /** Of those, the files that also change `process.env`. */
  candidateFiles: number;
  /** Spawn sites inside a candidate file that pass no `env`. */
  sites: LateEnvSite[];
}

/**
 * The reading, with its own coverage beside it.
 *
 * `1 site` and `1 site of 3 examined` are the same number and different
 * facts, and `1 of 900` is a third. A scan that reports a verdict reports
 * how much it read — `.claude/rules/config-access.md`'s `36/426`.
 */
export function lateEnvSpawnReading(root: string): LateEnvReading {
  return scan(root);
}

export function lateEnvSpawnSites(root: string): LateEnvSite[] {
  return scan(root).sites;
}

function scan(root: string): LateEnvReading {
  const files = testFiles(root);
  if (files.length === 0) {
    throw new UnreadableScanError(`no test files under ${join(root, "test")} — the walk found nothing to scan`);
  }

  const sites: LateEnvSite[] = [];
  let spawnsSeen = 0;
  let candidateFiles = 0;

  for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    const blanked = stripJsComments(raw, { blankLiterals: true });

    const vars = [
      ...new Set([
        ...[...blanked.matchAll(ENV_WRITE)].map(m => m[1]),
        ...[...blanked.matchAll(ENV_DELETE)].map(m => m[1]),
      ]),
    ].sort();

    const spawns = [...blanked.matchAll(SPAWN)];
    spawnsSeen += spawns.length;
    if (vars.length === 0) continue;
    candidateFiles++;

    const rawLines = raw.split("\n");
    for (const m of spawns) {
      const at = m.index!;
      const open = blanked.indexOf("(", at);
      const args = argumentList(blanked, open);
      if (args === null) {
        throw new UnreadableScanError(
          `${relative(root, file)}: a spawn call's argument list is unbalanced — the scan cannot say whether it passes env`,
        );
      }
      if (ENV_OPTION.test(args)) continue;

      const line = raw.slice(0, at).split("\n").length;
      // The marker is read from RAW source: `stripJsComments` preserves every
      // offset but blanks the comment it lives in.
      //
      // The window is the comment block ATTACHED to the call — every
      // contiguous comment line immediately above it, plus the call's own
      // line for a trailing marker. A fixed count of lines was the first
      // version and it is the wrong shape: a reason long enough to satisfy
      // MIN_REASON usually needs more lines than the window allows, so the
      // floor and the window would fight each other and the way to win is
      // to write a shorter reason.
      const window = commentBlockAbove(rawLines, line);
      const marked = window.indexOf(EXEMPT_MARKER);
      const reason = marked === -1
        ? null
        : window.slice(marked + EXEMPT_MARKER.length)
          .split("\n").map(l => l.replace(/^[\s*/]+/, "")).join(" ").trim();

      sites.push({
        file: relative(root, file).split(sep).join("/"),
        line,
        callee: m[0].replace(/\s*\($/, ""),
        vars,
        exemption: reason,
      });
    }
  }

  if (spawnsSeen === 0) {
    throw new UnreadableScanError(
      "no spawn calls were found in any test file — the spawn pattern has stopped matching",
    );
  }
  return { filesScanned: files.length, spawnsExamined: spawnsSeen, candidateFiles, sites };
}

/**
 * The sites that are neither explicit nor justified.
 *
 * Split from the scan so a case can assert the POPULATION is non-empty while
 * asserting the violations are empty. Those are different claims, and a scan
 * that found nothing satisfies the second one on its own.
 */
export function lateEnvSpawnViolations(root: string): string[] {
  return scan(root).sites
    .filter(s => s.exemption === null || s.exemption.length < MIN_REASON)
    .map(s =>
      `${s.file}:${s.line} ${s.callee} passes no env: option, and this file writes ` +
      `${s.vars.join(", ")}. Under Bun the child will NOT see those writes. Pass ` +
      `env: { ...process.env } — or, if the child does not read them, say why in a ` +
      `"${EXEMPT_MARKER} <reason>" comment within three lines above the call ` +
      `(at least ${MIN_REASON} characters).` +
      (s.exemption === null ? "" : ` The reason given is ${s.exemption.length} characters.`),
    );
}
