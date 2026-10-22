/**
 * Which files read a changed source file AS TEXT, and which region of it (#1054).
 *
 * The third relationship, beside the two this repository already routes by.
 * `lib/affected-tests.ts` routes by what a change IMPORTS;
 * `scripts/census-routing.ts` routes by what a change DID. Neither answers
 * the question an author actually asks before pushing: *of the thousands of
 * lines in the file I just edited, which other files lift the part I touched,
 * and by what name?*
 *
 * ## The measurement this module is built on, and the premise it corrected
 *
 * #1054 reports that the import graph "cannot see" a test that parses a
 * source file it does not import, and names PR #1034 as the instance: a
 * change to `workflows/ship.js` reddened five files, every one of which lifts
 * a region of `ship.js` out of its text, and the fixing agent's own report
 * says *"none has 'container' in its name, so my local grep missed them."*
 *
 * Re-measured against the tree at that commit before any of this was written,
 * the premise is **wrong in its stated form and right in its consequence**.
 * `affectedTests` with `workflows/ship.js` in the change set selects all five
 * — it has a basename-literal rule, and each of the five writes
 * `join(REPO_ROOT, "workflows", "ship.js")`. What it selects is **226 of 538
 * test files**. Three answers were available that night and not one of them
 * was usable:
 *
 *   | the question asked          | answer | the five |
 *   |---|---|---|
 *   | filenames matching `container` | 1 file   | **1 of 5** |
 *   | `grep -rl container test/`     | 46 files | 5 of 5 |
 *   | `affectedTests(ship.js)`       | 226 files| 5 of 5 |
 *
 * The narrow answer missed; the answers that caught were 46 and 226 files
 * wide, and the selector that produced the 226 runs only inside a ship run.
 * So the gap is not that nothing could reach those files. It is that nothing
 * could **name** them: no command said *these are the files that lift the
 * block you edited, and here is the anchor each one lifts it by.* An agent
 * holding a 226-file list and no attribution greps, which is what happened.
 *
 * ## What an anchor is
 *
 * A file that lifts a region of another file has to name where the region
 * starts. In this tree that name is a string literal or a regex literal whose
 * text occurs verbatim in the subject:
 *
 *   markerRegion(shipSource, "RECORDER-COMMAND")          // string
 *   region(/^let quinnContainerResult = null$/m, ...)     // regex
 *
 * Both are **anchors**: literal text, written in the reader, present in the
 * subject. That is a dependency as real as an import, expressed in a syntax
 * no resolver reads — #484's shape, where a guard knew one spelling of a
 * property that had two.
 *
 * Anchors are read from a COMMENT-STRIPPED view of the reader, for the reason
 * `lib/affected-tests.ts` states about the same question: this repository
 * quotes its own source constantly in prose, and a docstring that mentions a
 * marker is a citation, not a read.
 *
 * ## Two readings, and only one of them is allowed to narrow the run
 *
 * An anchor gives a span in the subject — the marker pair's first and last
 * occurrence, or the balanced block enclosing a lone anchor. Comparing that
 * span against the changed line numbers says whether the edit landed INSIDE
 * the lifted region, which is the attribution a human wants.
 *
 * **It is not allowed to remove anything from the selection.** The brace scan
 * is a raw text scan with the limits `lib/source-slice.ts` states, the diff's
 * line numbers are the new side only, and a span computed slightly wrong
 * narrows a run — which is the one direction a test selector may never be
 * wrong in. So an anchor match is an edge, full stop, and the span only sets
 * `direct`. A narrow answer that is sometimes wrong is worse than a wide one
 * that is never wrong; the narrowing here is in the REPORT.
 *
 * ## UNMEASURED fails, it does not empty
 *
 * `0`, `{}` and an empty selection are indistinguishable from success, which
 * is the whole of `.claude/rules/config-access.md` and of #492. A changed
 * file this module could not read is not a file with no dependents, so:
 *
 *   - nothing changed, nothing scanned, or no test file found -> UNMEASURED
 *   - a changed path that is not on disk -> UNMEASURED, named. Its anchors
 *     cannot be computed at all, and a deletion is exactly when a lifter
 *     breaks.
 *   - a changed path that is on disk and unreadable -> UNMEASURED, named
 *   - a changed path that is binary -> recorded in `notText` and NOT
 *     unmeasured. A text-anchor router is definitionally not about bytes,
 *     and saying which files it declined by name is the difference between
 *     a skip and a silence.
 *
 * and the caller is told `filesRead` of `filesSeen` either way, because
 * `36/426` and `426/426` are the same PASS when only the verdict is printed.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join } from "path";

import { relativeImports } from "./package-closure";
import { commentMask, stripJsComments } from "./strip-js-comments";

/**
 * The shortest literal that may be an anchor.
 *
 * Not a tuning knob so much as a statement about what a name is. Below this,
 * literals stop being names of places and start being fragments every file
 * shares — `"utf-8"`, `"const "`, `" null"` — and an anchor that matches
 * everywhere anchors nothing. Measured on this tree, dropping it to 6
 * roughly triples the edge count without adding a reader that any of the
 * three corpus changes needed.
 */
export const ANCHOR_MIN_LENGTH = 12;

/**
 * Occurrences above which a literal stops being an anchor.
 *
 * `lib/source-slice.ts` refuses a duplicated anchor by name
 * (`AmbiguousAnchorError`) because a cut taken around whichever occurrence
 * the search reached is a confident answer about the wrong region. The same
 * judgement, one notch looser: a marker pair is two occurrences and legal, a
 * literal appearing nine times in the subject is a coincidence. Declined
 * literals are REPORTED (`ambiguous`), never silently dropped.
 */
export const ANCHOR_AMBIGUITY_MAX = 8;

/**
 * What makes a literal a NAME rather than a word.
 *
 * Measured before this pair existed, on the #1034 diff: length alone admitted
 * `"implementation"`, `"do not touch"` and `"verification"`, which occur in
 * every long document in the tree, and the reading came back with 510 of 538
 * test files and 4,155 edges. A router that names 95% of the suite has
 * answered the question nobody asked; the author still has to grep.
 *
 * The two families that are real anchors here, and nothing else:
 *
 *   MARKER  `CONTAINER-PROBE`, `RECORDER-COMMAND` — a screaming-case label
 *           that exists to be found
 *   CODE    `let quinnContainerResult = null`, `async function
 *           runContainerVerify() {` — a line of source, which is recognisable
 *           because source has punctuation and prose does not
 *
 * This is the filter that can be wrong in the dangerous direction, so it is
 * the one to suspect first when a lifter is missed: a reader that anchors on
 * a bare lowercase phrase is invisible here. That is a deliberate trade
 * against a result nobody reads, it is stated rather than implied, and the
 * edge count makes it checkable.
 */
const MARKER_ANCHOR = /[A-Z][A-Z0-9_-]{5,}/;
const CODE_ANCHOR = /[=(){}[\];<>]/;

/**
 * How much of an anchor has to be letters and digits.
 *
 * Length alone counts punctuation and newlines, so a fixture holding
 * `");\n  } return"` cleared a twelve-character bar on syntax, and syntax
 * occurs in every file. Measured on this branch's own diff before the rule
 * existed: six of the first twenty edges were punctuation runs, each naming
 * a reader with no relationship to the change at all.
 */
const ANCHOR_MIN_ALNUM = 10;

/**
 * Extensions a target may have.
 *
 * Declared scope, not an oversight: this router answers *which files read
 * this SOURCE file as text*. A markdown target shares vocabulary with every
 * other document in the tree, so the same filter that makes code anchors
 * precise makes prose anchors meaningless — and prose coupling is already
 * `scripts/census-routing.ts`'s question, routed by what the diff DID.
 * Declined targets are listed in `notAnchorable` by name.
 */
const ANCHORABLE_TARGET = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Directories walked for readers. The same population `affectedTests` walks. */
export const SCAN_DIRS = ["test", "lib", "scripts", "gates", "bin", "hooks", "workflows"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** A reader this module can extract anchors from. */
const SCANNABLE = /\.(ts|tsx|js|jsx|mts|cts)$/;

/** A test file, by the convention this repo uses everywhere. */
export const TEST_FILE = /\.test\.(ts|tsx)$/;

/** One changed region of a changed file, on the NEW side, 1-based. */
export interface Hunk {
  start: number;
  lines: number;
}

/** What this module needs to know about a changed file. */
export interface ChangedFile {
  path: string;
  /**
   * New-side hunks. `undefined` means the caller could not say, which is not
   * the same as "no lines changed": every edge is then reported `direct:
   * false` rather than being dropped.
   */
  hunks?: Hunk[];
}

/** Why a span is the shape it is — attribution only, never selection. */
export type AnchorScope =
  /** Two sibling anchors of one reader: the span is the text between them. */
  | "marker-pair"
  /** The balanced `{}` block the anchor sits in, or opens. */
  | "block"
  /**
   * The anchor's own lines.
   *
   * What a module-scope anchor gets. Its enclosing block is the whole
   * document, which delimits nothing — counting that as a region made 124
   * of the #1034 diff's readers direct hits — so the honest span is the
   * text the reader actually named, and a sibling anchor is what widens it.
   */
  | "line";

/** One reader, one subject, one anchor. */
export interface TextEdge {
  /** Repo-relative path of the file doing the reading. */
  reader: string;
  /** Repo-relative path of the changed file being read. */
  target: string;
  /** The literal, as written in the reader. */
  anchor: string;
  scope: AnchorScope;
  /** 1-based, inclusive, in the target. */
  from: number;
  to: number;
  /**
   * The change landed inside the span. Attribution, not selection — a
   * `false` edge is still in `tests`.
   */
  direct: boolean;
}

export interface TextDependentsReading {
  /** `UNMEASURED` means this router could not look. It never means "none". */
  reading: "MEASURED" | "UNMEASURED";
  /** Why it could not look. Empty when MEASURED. */
  unmeasuredReasons: string[];
  /** Every anchor match, direct first then by reader. Empty under UNMEASURED. */
  edges: TextEdge[];
  /** Runnable test files: readers that are tests, plus tests importing a reader. */
  tests: string[];
  /** Readers that are not themselves test files — a helper is a real dependent. */
  helpers: string[];
  /** Changed paths declined as binary, by name. */
  notText: string[];
  /** Changed paths outside this router's declared scope, by name. */
  notAnchorable: string[];
  /** Literals present in a target too often to anchor anything, by name. */
  ambiguous: { target: string; anchor: string; occurrences: number }[];
  /** Coverage (#492): how many of the files it could see it actually read. */
  filesSeen: number;
  filesRead: number;
  unreadable: string[];
}

/** Repo-relative, forward slashes, no leading `./`. */
function norm(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Every scannable file under `SCAN_DIRS`.
 *
 * Symlinked directories are followed and visited once by real path, for the
 * reasons `lib/affected-tests.ts` records (#500): a linked package is a real
 * layout, and following links without a visited set recurses forever.
 */
function readerFiles(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    rootReal = root;
  }

  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    if (real !== rootReal && !real.startsWith(`${rootReal}/`)) return;
    if (seen.has(real)) return;
    seen.add(real);

    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = norm(join(rel, e.name));
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(join(root, child)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(child);
      else if (SCANNABLE.test(e.name)) out.push(child);
    }
  };
  for (const d of SCAN_DIRS) walk(d);
  return out.sort();
}

/**
 * Quoted string literals in `code`, templates included when they interpolate
 * nothing.
 *
 * An interpolating template is excluded deliberately: its text is assembled
 * at runtime, so no part of it is a name the subject can be searched for, and
 * taking the literal chunks around a `${}` would produce fragments that match
 * by accident.
 */
export function stringLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;
  for (const m of code.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined) continue;
    out.push(unescapeJs(raw));
  }
  return out;
}

/** `\n` to a newline, `\"` to a quote; anything else keeps its payload. */
function unescapeJs(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}

/**
 * The literal runs inside regex literals in `code`.
 *
 * `region(/^let quinnContainerResult = null$/m, ...)` names a line of
 * `ship.js` exactly, and a module that reads only string literals is blind to
 * every lifter written this way — which is most of them here.
 *
 * The regex-literal scan declines a `/` that follows a value, because
 * division and a regex open identically and a misread one swallows the rest
 * of the line. A missed regex costs an anchor and is reported in the
 * coverage line; a misread one would invent a span.
 */
export function regexAnchors(code: string): string[] {
  const out: string[] = [];
  const re = /\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[gimsuyvd]*/g;
  for (const m of code.matchAll(re)) {
    // Walk back over whitespace: a `/` whose last meaningful neighbour is a
    // value is division. `total / count / 2` would otherwise be read as a
    // regex `/ count /` and contribute ` count ` as an anchor.
    let k = (m.index as number) - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (k >= 0 && /[\w)\]"'`.]/.test(code[k])) continue;
    for (const run of literalRuns(m[1])) out.push(run);
  }
  return out;
}

/**
 * The maximal runs of literal text in a regex body.
 *
 * Split on every unescaped metacharacter, unescape the rest. `^const
 * containerConfig = projectConfig\.container \|\| null$` yields `const
 * containerConfig = projectConfig`, which occurs once in `ship.js` and is a
 * better anchor than the whole pattern would be.
 */
export function literalRuns(body: string): string[] {
  const runs: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[i + 1];
      i++;
      if (next === undefined) break;
      // A class escape (\d, \s, \w, \b, \n...) is not literal text.
      if (/[dDsSwWbBnrtfv0-9uxkpP]/.test(next)) {
        if (cur) runs.push(cur);
        cur = "";
      } else {
        cur += next;
      }
      continue;
    }
    if ("^$.*+?()[]{}|".includes(c)) {
      if (cur) runs.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) runs.push(cur);
  return runs;
}

/** 1-based line number of a byte offset. */
function lineAt(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * The balanced `{}` block enclosing `index`, as a half-open byte range.
 *
 * A raw brace scan, with the scope `lib/source-slice.ts` states for the same
 * technique: it does not know strings, comments or regex literals. At depth
 * zero it returns the whole document rather than guessing, and the caller
 * labels that `file` so a reader of the report can see that the span is not a
 * claim about a region. The result never removes an edge.
 */
export function enclosingBlock(source: string, index: number): { start: number; end: number } {
  const opens: number[] = [];
  for (let i = 0; i < index; i++) {
    if (source[i] === "{") opens.push(i);
    else if (source[i] === "}") opens.pop();
  }
  const open = opens.pop();
  if (open === undefined) return { start: 0, end: source.length };

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i + 1 };
    }
  }
  return { start: open, end: source.length };
}

/**
 * The candidate regions site `i` could be delimiting, tightest first.
 *
 * Two, and the second is the one that makes marker pairs work:
 *
 *  1. the balanced block enclosing the site. This is the right answer for a
 *     code anchor — `async function runContainerVerify() {` delimits its own
 *     function — and it degenerates to the whole document at brace depth
 *     zero, which is labelled `file` and never counted as a direct hit.
 *
 *  2. the text from this site to the reader's NEXT anchor site in the same
 *     target. `sliceBlock("// ──── SECURITY-DECISION-START ────", "// ──── …
 *     -END ────")` names two DIFFERENT literals, so no rule about repeated
 *     occurrences of one literal can see that region; what makes it a region
 *     is that one anchor of this reader is followed by another.
 *
 * The second rule is self-limiting in the way that matters: the more anchors
 * a reader has in a file, the tighter every span between them becomes, and a
 * reader with two anchors nine thousand lines apart genuinely cannot say
 * anything narrower than that. It is also why the pairing is per READER —
 * pairing across readers would join two files' unrelated anchors into a
 * region neither of them lifts.
 */
function spansFor(
  source: string,
  starts: number[],
  sites: { anchor: string; start: number; end: number }[],
  i: number,
): { from: number; to: number; scope: AnchorScope }[] {
  const site = sites[i];
  const out: { from: number; to: number; scope: AnchorScope }[] = [];

  // Both ends of the anchor are asked, because an anchor that OPENS a block
  // — `if (discovery.tier !== 'LIGHT' && probeTarget) {` — sits at the
  // depth outside it, and asking only where it starts returns the block it
  // is written in rather than the one it names.
  for (const at of new Set([site.start, site.end])) {
    const block = enclosingBlock(source, at);
    if (block.start === 0 && block.end === source.length) continue;
    out.push({
      from: lineAt(starts, block.start),
      to: lineAt(starts, Math.max(block.start, block.end - 1)),
      scope: "block",
    });
  }
  out.push({
    from: lineAt(starts, site.start),
    to: lineAt(starts, Math.max(site.start, site.end - 1)),
    scope: "line",
  });

  const next = pairedWith(sites, i);
  if (next) {
    out.push({
      from: lineAt(starts, site.start),
      to: lineAt(starts, next.end - 1),
      scope: "marker-pair",
    });
  }
  return out;
}

/**
 * The site that closes the region site `i` opens, under a START/END reading.
 *
 * Sites are paired greedily and WITHOUT OVERLAP in file order: 0 with 1, 2
 * with 3, and so on. A site that closes a pair does not open the next one.
 *
 * That one clause is what makes the pairing a region rule rather than a
 * sliding window, and it was measured into existence. Pairing every site
 * with its successor gave `test/blocking-grades.test.ts` a span of
 * `ship.js` 2413–8776 — the END marker of the region it lifts, joined to
 * the next unrelated anchor nine thousand lines later — and 55 direct
 * readers on a one-file diff. A reader that quotes a START and an END
 * quotes them in that order, so the even sites are the openers.
 */
function pairedWith(
  sites: { anchor: string; start: number; end: number }[],
  i: number,
): { start: number; end: number } | undefined {
  let open = 0;
  for (let k = 0; k < i; k++) if (open === k && pairs(sites[k], sites[k + 1])) open = k + 2;
  if (open !== i) return undefined;
  return pairs(sites[i], sites[i + 1]) ? sites[i + 1] : undefined;
}

/**
 * Whether two adjacent sites are the two ends of one region.
 *
 * Disjoint, and SIBLING NAMES — the two anchors agree on at least half of
 * the shorter one. `// ──── SECURITY-DECISION-START ────` and
 * `// ──── SECURITY-DECISION-END ────` agree on thirty characters; `function
 * shellQuote(` and whatever a reader quotes six thousand lines later agree
 * on nothing, and joining them produced a `ship.js` 497–7000 "region" and
 * 39 direct readers on a one-file diff.
 *
 * Prefix agreement rather than a `-START`/`-END` literal, because the
 * convention is not universal — BEGIN/END, OPEN/CLOSE and a bare repeated
 * marker all share the prefix, and a rule naming one spelling of a
 * convention is the narrow-detector shape `#484` is the worked example of.
 */
function pairs(
  a: { anchor: string; start: number; end: number } | undefined,
  b: { anchor: string; start: number; end: number } | undefined,
): boolean {
  if (!a || !b || b.start < a.end) return false;
  let shared = 0;
  const limit = Math.min(a.anchor.length, b.anchor.length);
  while (shared < limit && a.anchor[shared] === b.anchor[shared]) shared++;
  return shared * 2 >= limit;
}

/** Every occurrence of `needle` in `hay`, as byte offsets. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  let at = hay.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

/** A NUL in the first page is the cheapest reliable "this is not text". */
function looksBinary(s: string): boolean {
  return s.slice(0, 8192).includes("\u0000");
}

/**
 * Which files read any of `changed` as text, and where.
 *
 * `changed` is repo-relative, with new-side hunks where the caller has them.
 */
export function textDependents(root: string, changed: ChangedFile[]): TextDependentsReading {
  const unmeasuredReasons: string[] = [];
  const notText: string[] = [];
  const notAnchorable: string[] = [];
  const unreadable: string[] = [];

  const empty = (reasons: string[], filesSeen = 0, filesRead = 0): TextDependentsReading => ({
    reading: "UNMEASURED",
    unmeasuredReasons: reasons,
    edges: [],
    tests: [],
    helpers: [],
    notText,
    notAnchorable,
    ambiguous: [],
    filesSeen,
    filesRead,
    unreadable,
  });

  if (changed.length === 0) {
    return empty([
      "no changed files were supplied, so nothing constrains the reading — and an " +
        "unconstrained reading is every file, not none",
    ]);
  }

  // --- the subjects -------------------------------------------------------
  interface Target {
    path: string;
    source: string;
    starts: number[];
    /** Per character: is this inside a comment in the target? */
    inComment: boolean[];
    touched: number[];
    knowsLines: boolean;
  }
  const targets: Target[] = [];
  for (const c of changed) {
    if (!ANCHORABLE_TARGET.test(c.path)) {
      notAnchorable.push(c.path);
      continue;
    }
    const abs = join(root, c.path);
    let source: string;
    try {
      source = readFileSync(abs, "utf-8");
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      unmeasuredReasons.push(
        missing
          ? `${c.path} is not on disk, so its anchors cannot be computed — and a file that ` +
            "was deleted or renamed is precisely when the files that lift it break"
          : `${c.path} could not be read (${(e as Error).message.split("\n")[0]}), so an empty ` +
            "dependent list would be an artefact of not looking",
      );
      continue;
    }
    if (looksBinary(source)) {
      notText.push(c.path);
      continue;
    }
    const starts = lineStarts(source);
    const touched: number[] = [];
    for (const h of c.hunks ?? []) {
      // A pure deletion is `+N,0`: nothing on the new side, but the join
      // between N and N+1 is where the lines went, and a lifter of either
      // side is affected. Both are marked.
      const span = Math.max(1, h.lines);
      for (let i = 0; i < span; i++) touched.push(h.start + i);
      if (h.lines === 0) touched.push(h.start + 1);
    }
    targets.push({
      path: c.path,
      source,
      starts,
      inComment: commentMask(source),
      touched,
      knowsLines: c.hunks !== undefined,
    });
  }

  // --- the readers --------------------------------------------------------
  const files = readerFiles(root);
  const filesSeen = files.length;
  if (filesSeen === 0) {
    unmeasuredReasons.push(
      `the walk over ${SCAN_DIRS.join(", ")} found no readable source file, which is not the ` +
        "same as finding no dependent",
    );
  }

  const edges: TextEdge[] = [];
  const ambiguous: TextDependentsReading["ambiguous"] = [];
  const ambiguousSeen = new Set<string>();
  const importsOf = new Map<string, string[]>();
  let filesRead = 0;

  for (const f of files) {
    let source: string;
    try {
      source = readFileSync(join(root, f), "utf-8");
    } catch {
      unreadable.push(f);
      continue;
    }
    filesRead++;
    importsOf.set(f, relativeImports(source));

    if (targets.length === 0) continue;
    const code = stripJsComments(source);
    const anchors = new Set<string>();
    for (const l of [...stringLiterals(code), ...regexAnchors(code)]) {
      if (l.length < ANCHOR_MIN_LENGTH) continue;
      if ((l.match(/[A-Za-z0-9]/g) ?? []).length < ANCHOR_MIN_ALNUM) continue;
      if (!MARKER_ANCHOR.test(l) && !CODE_ANCHOR.test(l)) continue;
      anchors.add(l);
    }
    if (anchors.size === 0) continue;

    for (const t of targets) {
      if (t.path === f) continue; // a file is not its own dependent

      // Every place any of this reader's anchors lands in this target, in
      // file order. Collected per reader/target rather than per anchor,
      // because the span a reader lifts is bounded by its OWN other anchors
      // and by nothing else — see `spanFor`.
      const sites: { anchor: string; start: number; end: number }[] = [];
      for (const anchor of anchors) {
        const hits = occurrences(t.source, anchor);
        if (hits.length === 0) continue;
        if (hits.length > ANCHOR_AMBIGUITY_MAX) {
          const key = `${t.path}\u0000${anchor}`;
          if (!ambiguousSeen.has(key)) {
            ambiguousSeen.add(key);
            ambiguous.push({ target: t.path, anchor, occurrences: hits.length });
          }
          continue;
        }
        // A CODE anchor found inside the target's COMMENTS is a citation,
        // not a read — the mirror of the rule `lib/affected-tests.ts`
        // already applies on the reader's side, where matching raw source
        // made one rule file select 322 of 388 files. A MARKER is the
        // opposite: `// ──── X-START ────` IS a comment, and that is the
        // whole mechanism, so markers are matched raw. Measured on this
        // branch's own diff, where the new module's docblock quotes other
        // files' anchors: 7 of 12 readers were citing, not reading.
        const citation = !MARKER_ANCHOR.test(anchor);
        for (const hit of hits) {
          if (citation && t.inComment[hit]) continue;
          sites.push({ anchor, start: hit, end: hit + anchor.length });
        }
      }
      if (sites.length === 0) continue;
      sites.sort((a, b) => a.start - b.start);

      const byAnchor = new Map<string, { from: number; to: number; scope: AnchorScope }[]>();
      for (let i = 0; i < sites.length; i++) {
        const spans = spansFor(t.source, t.starts, sites, i);
        const prev = byAnchor.get(sites[i].anchor);
        if (prev) prev.push(...spans);
        else byAnchor.set(sites[i].anchor, spans);
      }

      for (const [anchor, spans] of byAnchor) {
        // One edge per reader/target/anchor: a reader does not become two
        // dependents by naming the same thing twice.
        //
        // When the caller could not give line numbers there is nothing to
        // narrow WITH, so nothing is narrowed and every anchor into that
        // target is direct. "I could not tell" resolving to the empty set is
        // the `0`-reads-as-success shape, and this is the position where it
        // costs a red `main`.
        //
        // No span is the whole document: `spansFor` declines a depth-zero
        // enclosing block and gives the anchor's own lines instead. A
        // whole-file span delimits nothing, and counting one as a region
        // made 124 of the #1034 diff's readers direct hits.
        const hit = (s: { from: number; to: number }) =>
          t.touched.some(n => n >= s.from && n <= s.to);
        const chosen = t.knowsLines
          ? spans.filter(hit).sort((a, b) => a.to - a.from - (b.to - b.from))[0]
          : undefined;
        edges.push({
          reader: f,
          target: t.path,
          anchor,
          ...(chosen ?? spans[0]),
          direct: !t.knowsLines || chosen !== undefined,
        });
      }
    }
  }

  if (filesRead === 0 && filesSeen > 0) {
    unmeasuredReasons.push(
      `all ${filesSeen} candidate readers were unreadable, so the empty result describes this ` +
        "process's permissions and not the tree",
    );
  }
  if (unmeasuredReasons.length > 0) return empty(unmeasuredReasons, filesSeen, filesRead);

  // --- make the readers runnable -----------------------------------------
  //
  // A helper that lifts a region is a real dependent and is not a test file,
  // so handing it to `bun test` runs nothing. The tests that import it,
  // transitively, are what the author has to run. Walking importers outward
  // from the helpers is linear and cannot loop on an import cycle, which
  // walking forward from each test with a memo can (`lib/affected-tests.ts`
  // records paying for that).
  const importers = new Map<string, Set<string>>();
  for (const [f, specs] of importsOf) {
    for (const spec of specs) {
      const target = resolveSpec(f, spec, new Set(files));
      if (!target) continue;
      let s = importers.get(target);
      if (!s) importers.set(target, (s = new Set()));
      s.add(f);
    }
  }

  //
  // Only DIRECT readers become a run.
  //
  // This router is ADDITIVE — its caller unions it into a selection the
  // import graph already made — so a narrow contribution can only add files,
  // never take one away, and the safety argument that forces `affectedTests`
  // to over-select does not transfer here. Measured on the #1034 diff: every
  // anchor edge is 345 of 538 test files, which is wider than the graph's own
  // 226 and attributes nothing; the direct edges are 10 readers, each with
  // the anchor and the line span that put it there. The second is the answer
  // an author can act on, and the first is another number to grep past.
  const readers = [...new Set(edges.filter(e => e.direct).map(e => e.reader))];
  const reached = new Set<string>();
  const queue = [...readers];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (reached.has(cur)) continue;
    reached.add(cur);
    for (const up of importers.get(cur) ?? []) if (!reached.has(up)) queue.push(up);
  }

  edges.sort(
    (a, b) =>
      Number(b.direct) - Number(a.direct) ||
      a.reader.localeCompare(b.reader) ||
      a.target.localeCompare(b.target) ||
      a.anchor.localeCompare(b.anchor),
  );

  return {
    reading: "MEASURED",
    unmeasuredReasons: [],
    edges,
    tests: [...reached].filter(f => TEST_FILE.test(f)).sort(),
    helpers: readers.filter(f => !TEST_FILE.test(f)).sort(),
    notText,
    notAnchorable,
    ambiguous: ambiguous.sort((a, b) => b.occurrences - a.occurrences),
    filesSeen,
    filesRead,
    unreadable,
  };
}

/**
 * Resolve a relative specifier written in `from` against `known`.
 *
 * The `.js` -> `.ts` candidates matter for the same reason they do in
 * `lib/affected-tests.ts`: ESM-targeting TypeScript writes `./x.js` for a
 * file on disk called `x.ts`, and a resolver that does not know that drops
 * the edge in silence.
 */
function resolveSpec(from: string, spec: string, known: Set<string>): string | null {
  const base = norm(join(dirname(from), spec));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    norm(join(base, "index.ts")),
    norm(join(base, "index.tsx")),
  ];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}
