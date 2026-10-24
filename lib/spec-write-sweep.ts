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
 * For each call to a write primitive, the sweep reads the **first argument
 * expression**, and — when that argument is a bare identifier — one level of
 * its local `const`/`let`/`var` initialiser in the same file. A site is
 * spec-targeting when that text matches `/spec/i`.
 *
 * Two deliberate properties:
 *
 *   - **It over-reports.** `spec-compliance-auto.test.ts` is a test, not a
 *     spec, and it matches. An over-report costs one classified line in
 *     `NOT_A_SPEC_PATH`; an under-report is how three unguarded writers
 *     reached review across #1286 and #1549.
 *   - **One level of expansion, not a resolver.** `const outputPath =
 *     join(specsDir, filename)` is seen; a path assembled across three
 *     statements is not. That bound is a real hole and it is named here rather
 *     than left for someone to discover — `writeSpec` is what closes it, and
 *     this sweep is what makes skipping `writeSpec` expensive.
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

/** The module every spec write must route through. Excluded from the sweep. */
export const CHOKEPOINT = "lib/write-spec.ts";

/**
 * Everything that can put bytes on disk, including the non-`fs` spellings.
 * Spelled apart from the pattern so this file's own source does not read as a
 * call site when the sweep walks `lib/`.
 */
export const WRITE_PRIMITIVES = [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "renameSync",
  "copyFileSync",
  "truncateSync",
  "Bun.write",
] as const;

/** Directories whose TypeScript sources are swept. */
export const SWEPT_DIRS = ["lib", "scripts", "gates", "bin", "hooks"] as const;

export interface WriteSite {
  /** Repo-relative path, forward-slashed. */
  file: string;
  /** 1-based line of the call. */
  line: number;
  /** Which primitive was called. */
  primitive: string;
  /** The first argument's source text, whitespace-collapsed. */
  target: string;
  /** The text the detector actually read — target plus any expansion. */
  view: string;
  /** Whether `view` names a spec. */
  specTargeting: boolean;
}

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

// ── Lexing ────────────────────────────────────────────────────────

/**
 * Blank out comments, preserving every byte offset and newline.
 *
 * Offsets are preserved because the line number and the argument scan are both
 * taken from this string, and a shifted offset would report the wrong call.
 * String, template and regex literals are tracked so that a `//` inside a URL
 * and a `["']` inside a regex do not open or close the wrong state — this
 * repository contains both.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let prevSignificant = "";
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i, c);
      prevSignificant = c;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prevSignificant)) {
      i = skipRegex(src, i);
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}

/**
 * Index just past the literal opened at `start`, or `start + 1` if it never
 * closes.
 *
 * **An unterminated literal is not a literal.** Returning `src.length`
 * instead makes every scanner here silently blind from that byte to the end
 * of its input, and `identifiersIn` runs over a VIEW — a concatenation of
 * initialiser fragments, not well-formed source — where a lone backtick
 * really does occur: `initialiserOf` correctly captures
 * `raw.replace(/` + "`" + `/g, "")` with the backtick intact, and everything
 * appended after it was being dropped, so an identifier whose initialiser
 * named a spec path was never chased. Found by the AI review on this PR, as
 * the third instance of this one defect class. On well-formed source nothing
 * changes: there are no unterminated literals in a file that parses.
 */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
          i = skipQuoted(src, i, src[i]);
          continue;
        }
        i++;
      }
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  // Never closed: consume the opener only, so the rest of the input is still
  // read. See the docstring — this is the whole point of the function.
  return start + 1;
}

/** A `/` opens a regex only where a value cannot already have ended. */
function regexCanStartAfter(prev: string): boolean {
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

function skipRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i; // not a regex after all; give up at the line end
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  // Same rule as `skipQuoted`: an unclosed regex is not a regex.
  return start + 1;
}

// ── Argument extraction ───────────────────────────────────────────

/**
 * Walk `src` from `at`, tracking bracket depth, and stop where `done` says.
 *
 * Shared by both argument scanners because both have to skip regex literals,
 * and only one of them did. `match[1].replace(/`/g, "")` holds a BACKTICK
 * inside a regex: read as a template-literal opener it swallows every line up
 * to the next backtick, and the scanner returns an initialiser spanning
 * unrelated statements. That put two `lib/conformity.ts` writes on the
 * violation list for the word "spec" in prose four hundred lines away.
 */
function scanExpression(
  src: string,
  at: number,
  done: (c: string, depth: number) => boolean,
): number {
  let depth = 0;
  let i = at;
  let prevSignificant = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i, c);
      prevSignificant = c;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prevSignificant)) {
      i = skipRegex(src, i);
      prevSignificant = "/";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (done(c, depth)) return i;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return src.length;
}

/**
 * The arguments of the call whose `(` is at `open`, as source text.
 *
 * ONE pass. Restarting `scanExpression` at each comma loses the depth the
 * open paren contributed, so the second argument's scan never sees itself as
 * nested and runs to the end of the file — measured, on this repository's
 * own `renameSync` sites, while fixing the AI review's second finding.
 */
export function callArguments(src: string, open: number): string[] {
  const args: string[] = [];
  let start = open + 1;
  let depth = 0;
  let i = open;
  let prevSignificant = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i, c);
      prevSignificant = c;
      continue;
    }
    if (c === "/" && regexCanStartAfter(prevSignificant)) {
      i = skipRegex(src, i);
      prevSignificant = "/";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i).trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  args.push(src.slice(start).trim());
  return args;
}

/** Argument `index` (0-based), or `""` when the call has no such argument. */
export function argumentAt(src: string, open: number, index: number): string {
  return callArguments(src, open)[index] ?? "";
}

/** The first argument of the call whose `(` is at `open`, as source text. */
export function firstArgument(src: string, open: number): string {
  return argumentAt(src, open, 0);
}

/**
 * Which argument of each primitive names the path that gets WRITTEN.
 *
 * `renameSync(src, dest)` and `copyFileSync(src, dest)` write their SECOND
 * argument. Reading the first means a `copyFileSync(join(assetsDir,
 * "blank.md"), join(specsDir, "NEW-SPEC.md"))` is invisible — the sweep
 * answering a weaker question than the one it is named for. Found by the AI
 * review on #1552; today's population is zero, so nothing live was hidden
 * and the next one would have been.
 */
const WRITTEN_ARGUMENT: Record<string, number> = {
  renameSync: 1,
  copyFileSync: 1,
};

/**
 * EVERY local initialiser of a bare identifier in the file, joined, or `""`.
 *
 * Every, not the first. This has no function-scope awareness — resolving one
 * properly needs a parser, which this sweep deliberately is not — so the only
 * question is which way it is allowed to be wrong. Reading the FIRST
 * declaration is wrong in the **unsafe** direction: a file with
 * `const filePath = join(outDir, "report.json")` in one function and
 * `const filePath = join(specsDir, "NEW-SPEC.md")` in another would have its
 * real spec write read through the report path, match nothing, and be
 * silently omitted — the exact shape of miss #1552 exists to end, rebuilt
 * inside the detector meant to catch it. Found by the AI review on this PR.
 *
 * Taking the union over-reports instead: a site is spec-targeting if ANY
 * same-named binding in the file names a spec. An over-report costs one line
 * in `NOT_A_SPEC_PATH` with a reason; an under-report costs an unguarded
 * writer nobody can see.
 */
export function initialiserOf(src: string, name: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return "";
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=\\s*`, "g");
  const parts: string[] = [];
  for (const m of src.matchAll(decl)) {
    const init = firstArgumentFromAssignment(src, m.index + m[0].length);
    if (init) parts.push(init);
  }
  return parts.join(" ");
}

/**
 * Identifiers whose expansion would swamp the view without naming a path.
 * `join` and friends are calls, not variables; `file` and `e` are loop
 * bindings a `const` search would never find anyway.
 */
const NOT_A_PATH_BINDING = /^(join|resolve|dirname|basename|relative|String|JSON|Bun|process)$/;

/** Maximum links of a `const a = f(b); const b = f(c)` chain the view follows. */
export const EXPANSION_DEPTH = 3;

/**
 * Identifiers in an expression, with quoted spans removed first.
 *
 * Without the removal, `join(root, "AGENTS.md")` yields `md`, and
 * `initialiserOf` then finds some unrelated `const md = …` elsewhere in the
 * file and splices its text into the view. Measured: that alone put four
 * `AGENTS.md` and `CLAUDE.md` writes in `lib/scaffold/steps.ts` on the
 * violation list, each for a word inside a filename.
 */
export function identifiersIn(text: string): string[] {
  let bare = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, i, c);
      bare += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "`") {
      // A template's LITERAL text is blanked for the reason above, but its
      // `${…}` holes are code and are kept. Blanking the whole span loses
      // `outDir` out of `` `${outDir}/REPORT.md` ``, so the view has no
      // identifier to chase, the literal text names no spec, and a raw write
      // straight to a spec path reports nothing. Found by the AI review on
      // this PR; `blankComments` never had the bug because it keeps the
      // literal, and only this harvester erases it.
      const end = skipQuoted(text, i, c);
      bare += templateHoles(text.slice(i, end));
      i = end;
      continue;
    }
    bare += c;
    i++;
  }
  return [...bare.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]);
}

/** A template literal with everything outside its `${…}` holes blanked. */
function templateHoles(span: string): string {
  const out: string[] = span.split("").map(() => " ");
  let i = 1;
  while (i < span.length) {
    if (span[i] === "\\") {
      i += 2;
      continue;
    }
    if (span[i] === "$" && span[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < span.length && depth > 0) {
        const ch = span[j];
        if (ch === "`") {
          const e = skipQuoted(span, j, "`");
          const inner = templateHoles(span.slice(j, e));
          for (let k = 0; k < inner.length; k++) out[j + k] = inner[k];
          j = e;
          continue;
        }
        if (ch === '"' || ch === "'") {
          j = skipQuoted(span, j, ch);
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) break;
        out[j] = ch;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The text the detector reads: the target expression plus the transitive local
 * initialisers of every bare identifier in it, to `EXPANSION_DEPTH` links.
 *
 * Depth matters and the number is measured, not chosen for roundness.
 * `scripts/split-spec.ts` builds `filePath` from `splitDir` from `parentDir`
 * from `dirname(specPath)` — three links before the word "spec" appears. At
 * depth 1 that write is invisible, which is the shape of miss this whole issue
 * exists to stop.
 */
export function expandView(src: string, expr: string): string {
  const seen = new Set<string>();
  let view = expr;
  for (let depth = 0; depth < EXPANSION_DEPTH; depth++) {
    const names = identifiersIn(view).filter(
      (n) => !seen.has(n) && !NOT_A_PATH_BINDING.test(n),
    );
    if (names.length === 0) break;
    let grew = false;
    for (const n of names) {
      seen.add(n);
      const init = initialiserOf(src, n);
      if (init) {
        view += ` ${init}`;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return view.replace(/\s+/g, " ").trim();
}

/** The initialiser expression starting at `at`, to the end of the statement. */
function firstArgumentFromAssignment(src: string, at: number): string {
  const end = scanExpression(src, at, (c, depth) => depth === 0 && (c === ";" || c === "\n"));
  return src.slice(at, end).trim();
}

// ── The sweep ─────────────────────────────────────────────────────

/**
 * What counts as a target naming a derived document.
 *
 * `adr` is in, and that is #1548's residue rather than scope creep. The
 * decision `mayWrite` makes is about who PRODUCES a file, not about which
 * directory it sits in — a generated ADR loses injected frontmatter at the
 * next regeneration exactly as a generated spec does. #1548's cited shape is
 * literally `addFrontmatterToAdrs`, an unguarded sibling of a guarded
 * function in `lib/validators/spec-validators.ts`, and a `specs/`-only
 * detector would not see the next one. Widening costs nothing measured: the
 * real tree reads the same one site either way.
 *
 * Anchored at a token boundary rather than matched as a bare substring, so
 * `quadrant` and `inspectPath` are not derived documents. `adrDir` and
 * `specsDir` are, because the boundary is the character BEFORE the word.
 */
const SPEC_TARGET = /(?:^|[^A-Za-z0-9])(spec|adr)/i;

function tsFiles(root: string, dir: string, out: string[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      tsFiles(root, rel, out);
      continue;
    }
    if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
    out.push(rel);
  }
}

/** Every write-primitive call site under the swept directories. */
export function writeSites(root: string, dirs: readonly string[] = SWEPT_DIRS): WriteSite[] {
  const files: string[] = [];
  for (const d of dirs) tsFiles(root, d, files);

  // The lookbehind excludes identifier characters but NOT `.`, so a member
  // call is seen. `lib/conformity.ts` spells one `require("fs").writeFileSync(
  // reportPath, …)`, and a lookbehind that blocked `.` made it invisible —
  // found by this sweep's own negative control, which is the only reason it
  // is not still invisible. `safeWriteFileSync(` stays excluded: `e` is an
  // identifier character.
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_$])(${WRITE_PRIMITIVES.map((p) => p.replace(".", "\\.")).join("|")})\\s*\\(`,
    "g",
  );

  const sites: WriteSite[] = [];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf-8");
    const src = blankComments(raw);
    for (const m of src.matchAll(pattern)) {
      const open = m.index! + m[0].length - 1;
      const target = argumentAt(src, open, WRITTEN_ARGUMENT[m[1]] ?? 0).replace(/\s+/g, " ");
      const view = expandView(src, target);
      sites.push({
        file,
        line: src.slice(0, m.index!).split("\n").length,
        primitive: m[1],
        target,
        view,
        specTargeting: SPEC_TARGET.test(view),
      });
    }
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
