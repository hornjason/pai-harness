/**
 * Read a `path.ts:<N>` citation, and refuse to call it correct (#541).
 *
 * `lib/source-anchor.ts` (#514) is the form this repository is moving TO: a
 * citation that carries the text it is about, so the resolver reports the
 * position instead of the document asserting it. This module is about the
 * 231 citations still written the old way, and the measurement that says
 * why they need a guard rather than a cleanup:
 *
 * Of `specs/GATE-CONTRACTS-SPEC.md`'s seven line citations, the three under
 * a test were correct and **three of the four unguarded ones were already
 * wrong** — `gate-executor.ts:1725` pointed at a `parseFloat`,
 * `evidence-prevalidator.ts:208` at a comment, `scaffold-rungate-config.ts:66`
 * at an unrelated `existsSync`. Each pointed at a plausible-looking line in
 * the right file, and nobody had noticed because nothing could.
 *
 * Two readings follow from that, and both are refusals of a comfortable
 * default:
 *
 * **There is no VALID.** `LineReading` has two arms. A citation that
 * resolves is `UNMEASURED`, not correct: the file exists and the line
 * exists, and whether it is the line the sentence describes is not something
 * this code can decide. A 75% staleness rate in the unguarded half of one
 * document is the argument against reporting "ok" — `0`, `null`, `SKIP` and
 * a green tick are all indistinguishable from a correct answer, and a
 * refusal naming the reading is not.
 *
 * **A citation that cannot be resolved has a named cause.** A file that
 * moved, a bare basename, a basename matching two files, a line past the
 * end — four different repairs, so four different readings. "This citation
 * is broken" is not actionable; `steps.ts:43` is ambiguous between two files
 * and `src/api/auth.ts:23` names nothing at all, and the fix for one is not
 * the fix for the other.
 *
 * The enforcement splits the same way, which is the only honest split
 * available: the anchor form is DECIDABLE, so `citationFailures` is a hard
 * gate over every document in the tree; the line form is not, so the
 * population is held by a both-ways ratchet that records what it banked.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { join, resolve, sep } from "path";

import { anchorCitations, citationFailures } from "./source-anchor";

/**
 * `path.ts:<N>`, optionally opening a code span.
 *
 * Deliberately NOT matching the historical prose form. "line 4462 of ship.js
 * as it then stood" is a paragraph whose whole point is that the line no
 * longer exists, and refusing it would be refusing the document for being
 * about history. The two forms are distinguished by the colon and nothing
 * else, which is why that boundary is asserted rather than described.
 */
export const LINE_CITATION = /`?\b([A-Za-z0-9_./-]+\.(?:ts|js|json)):(\d+)\b/g;

export interface LineCitation {
  path: string;
  line: number;
  raw: string;
}

export type BrokenCause =
  | "NO_SUCH_FILE"
  | "UNQUALIFIED_PATH"
  | "AMBIGUOUS_PATH"
  | "PAST_END_OF_FILE"
  | "OUTSIDE_REPOSITORY";

/**
 * Two arms. Adding a third that means "fine" would undo the whole module.
 */
export type LineReading =
  | { reading: "BROKEN"; cause: BrokenCause; cite: LineCitation; detail: string }
  | { reading: "UNMEASURED"; cite: LineCitation; detail: string };

/** Raised when a document that should carry citations yields none (#621). */
export class NoLineCitationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLineCitationsError";
  }
}

/** Every line citation in a document, in order. */
export function lineCitations(doc: string): LineCitation[] {
  const out: LineCitation[] = [];
  // Anchor citations contain a path and a quoted fragment, and a fragment
  // can end in `.ts:12`. Removing them first stops the new form being
  // counted as an instance of the old one.
  const text = doc.replace(/`[A-Za-z0-9_./-]+@"[^"`]*"`/g, " ");
  for (const m of text.matchAll(LINE_CITATION)) {
    out.push({ path: m[1], line: Number.parseInt(m[2], 10), raw: m[0] });
  }
  return out;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "worktrees",
  "dist",
  "build",
  "coverage",
  ".next",
  ".bun",
]);

function walk(root: string, rel: string, out: string[], want: (p: string) => boolean): void {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    // A directory that cannot be read is not an empty directory. Nothing in
    // this walk can repair that, but it must not be reported as "nothing
    // here" either, so the caller's control — a floor on the count — is what
    // catches it rather than a silent zero.
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".claude" && e.name !== ".github") continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    // `isDirectory()` is false for a symlink, which is what keeps the walk
    // out of the `node_modules` link a worktree carries.
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(root, next, out, want);
    } else if (e.isFile() && want(next)) {
      out.push(next);
    }
  }
}

/** Every repository-relative file path, for deciding whether a basename is unique. */
export function repoFileIndex(root: string): string[] {
  const out: string[] = [];
  walk(root, "", out, () => true);
  return out.sort();
}

/** Every markdown document in the tree. */
export function markdownDocuments(root: string): string[] {
  const out: string[] = [];
  walk(root, "", out, p => p.endsWith(".md"));
  return out.sort();
}

/**
 * What a line citation can be said about, which is never that it is right.
 */
export function readLineCitation(root: string, index: string[], cite: LineCitation): LineReading {
  const { path } = cite;
  const broken = (cause: BrokenCause, detail: string): LineReading =>
    ({ reading: "BROKEN", cause, cite, detail });

  // `join` concatenates a leading slash rather than absorbing it, so an
  // absolute citation reads `<root>/etc/passwd` and the containment check
  // below has nothing to say about it. Refused on its own, because a
  // citation written absolute means something other than what its author
  // thinks it means.
  if (path.startsWith("/")) {
    return broken("OUTSIDE_REPOSITORY", `${path} is absolute — citations are repository-relative`);
  }
  const full = join(root, path);
  if (!resolve(full).startsWith(resolve(root) + sep)) {
    return broken("OUTSIDE_REPOSITORY", `${path} resolves outside the repository`);
  }

  if (existsSync(full) && statSync(full).isFile()) {
    // The symlink question the lexical check cannot answer: a link inside
    // the tree whose target is outside it passes containment and then reads
    // a file that is not in the repository at all.
    if (!realpathSync(full).startsWith(realpathSync(resolve(root)) + sep)) {
      return broken("OUTSIDE_REPOSITORY", `${path} is a symlink whose target is outside the repository`);
    }
    const lines = readFileSync(full, "utf-8").split("\n").length;
    if (cite.line > lines) {
      return broken("PAST_END_OF_FILE", `${path} has ${lines} lines, so line ${cite.line} is not in it`);
    }
    return {
      reading: "UNMEASURED",
      cite,
      detail:
        `${path}:${cite.line} names a line that exists; whether it is the line this sentence ` +
        `describes cannot be decided mechanically`,
    };
  }

  // Not a path in this repository. It may still be a basename somebody wrote
  // instead of one, which is a different defect with a different repair.
  const suffix = `/${path}`;
  const candidates = index.filter(f => f === path || f.endsWith(suffix));
  if (candidates.length === 0) {
    return broken("NO_SUCH_FILE", `${path} names no file in the repository`);
  }
  if (candidates.length > 1) {
    return broken(
      "AMBIGUOUS_PATH",
      `${path} matches ${candidates.length} files (${candidates.join(", ")}), so it names no site`,
    );
  }
  return broken(
    "UNQUALIFIED_PATH",
    `${path} is not a repository path; it probably means ${candidates[0]}, and writing that down ` +
      `is the repair`,
  );
}

export interface DocumentCensus {
  broken: number;
  unmeasured: number;
  anchors: number;
  readings: LineReading[];
  anchorFailures: string[];
}

/**
 * Count one document's citations by reading.
 *
 * `expectCitations` is the ratchet's statement that this document carries
 * some. When it does and none are found, this THROWS — because a checker
 * that finds zero citations in every document is in perfect agreement, and
 * zero strings are trivially all fine. Returning an empty census would fold
 * a dead pattern into a clean result, which is the exact shape #621
 * describes: the refusal has to escape.
 */
export function documentCensus(
  root: string,
  index: string[],
  docPath: string,
  expectCitations: boolean,
): DocumentCensus {
  const full = join(root, docPath);
  if (!existsSync(full)) {
    throw new NoLineCitationsError(
      `${docPath} is banked in the citation ratchet and is not in the tree. If the document was ` +
        `removed or renamed, delete or move its entry in the same commit.`,
    );
  }
  const text = readFileSync(full, "utf-8");
  const cites = lineCitations(text);
  if (expectCitations && cites.length === 0) {
    throw new NoLineCitationsError(
      `${docPath} is banked in the citation ratchet as carrying line citations and the census ` +
        `found none. Either every one of them was converted — in which case delete the entry's ` +
        `broken and unmeasured counts in the same commit — or LINE_CITATION has stopped matching, ` +
        `in which case this guard was about to pass over the whole tree.`,
    );
  }
  const readings = cites.map(c => readLineCitation(root, index, c));
  return {
    broken: readings.filter(r => r.reading === "BROKEN").length,
    unmeasured: readings.filter(r => r.reading === "UNMEASURED").length,
    anchors: anchorCitations(text).length,
    readings,
    anchorFailures: citationFailures(root, text),
  };
}

export interface RatchetEntry {
  broken: number;
  unmeasured: number;
  anchors: number;
  note?: string;
}

export interface CitationRatchet {
  meaning: string[];
  documents: Record<string, RatchetEntry>;
}

/**
 * The banked population, read from `.claude/line-citation-ratchet.json`.
 *
 * A tree with no file gets no entries — zero tolerance, which is the right
 * default for a project that has never had the defect. `lib/` travels into
 * every scaffolded project and rungate's own numbers have no business there.
 */
export function readCitationRatchet(root: string): CitationRatchet {
  const p = join(root, ".claude", "line-citation-ratchet.json");
  if (!existsSync(p)) return { meaning: [], documents: {} };
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const documents: Record<string, RatchetEntry> = {};
  for (const [k, v] of Object.entries(raw.documents ?? {})) {
    const e = v as Record<string, unknown>;
    if (typeof e?.broken !== "number" || typeof e?.unmeasured !== "number" || typeof e?.anchors !== "number") {
      // A malformed entry is not an absent one. Skipping it silently would
      // turn a typo into an exemption, which is the fail-open this file is
      // about; the comparison below then reports the document as unbanked.
      continue;
    }
    documents[k] = { broken: e.broken, unmeasured: e.unmeasured, anchors: e.anchors };
  }
  return { meaning: Array.isArray(raw.meaning) ? raw.meaning.map(String) : [], documents };
}

/**
 * Turn the census into refusals. THE binding — one place to mutate.
 *
 * Both directions, per number. Over the banked count fails, and so does
 * under it: an entry that has stopped being true is an entry nobody will
 * ever remove, and the file rots into a number nobody lowers.
 *
 * Three numbers rather than one, because a single total cannot see progress
 * happen. Qualifying `ship.js:<N>` to `workflows/ship.js:<N>` deletes
 * nothing and adds nothing, and converting a line citation to the anchor
 * form looks, to a total, exactly like deleting it. **The arithmetic cannot
 * forbid a deletion — a paragraph is allowed to go away — so what it does
 * instead is make the three numbers move differently, so a reviewer reading
 * the diff can tell a conversion from a deletion.** That distinction is the
 * point of the file and it is written into the file.
 *
 * Anchor citations are NOT ratcheted for correctness: an anchor carries its
 * own text, so whether it still names a site is decidable, and there is
 * nothing to tolerate. Their failures are returned as hard violations here
 * for every document in the tree — enforce the half the repository owns,
 * and report the other half as UNMEASURED.
 */
export function citationRatchetViolations(
  root: string,
  index: string[],
  docs: string[],
  ratchet: CitationRatchet,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const doc of docs) {
    const entry = ratchet.documents[doc];
    seen.add(doc);
    const census = documentCensus(root, index, doc, (entry?.broken ?? 0) + (entry?.unmeasured ?? 0) > 0);

    for (const f of census.anchorFailures) {
      out.push(`${doc}: an anchor citation no longer names a site — ${f}`);
    }

    if (!entry) {
      if (census.broken + census.unmeasured > 0) {
        out.push(
          `${doc} is not in .claude/line-citation-ratchet.json and carries ` +
            `${census.broken + census.unmeasured} line citations. A document absent from the ratchet ` +
            `is allowed none: the migration window is exactly when the next one gets written.`,
        );
      }
      continue;
    }

    const rows: [keyof RatchetEntry & string, number, number][] = [
      ["broken", census.broken, entry.broken],
      ["unmeasured", census.unmeasured, entry.unmeasured],
      ["anchors", census.anchors, entry.anchors],
    ];
    for (const [name, found, banked] of rows) {
      if (found === banked) continue;
      out.push(
        found > banked
          ? `${doc}: ${found} ${name} citations, ${banked} banked. Bank the number in the same ` +
            `commit that earned it, and say in the PR why it went up.`
          : `${doc}: ${found} ${name} citations, ${banked} banked. Lower it — or delete the entry ` +
            `if the document has none left. A stale entry is a number nobody lowers.`,
      );
    }
  }

  for (const doc of Object.keys(ratchet.documents)) {
    if (seen.has(doc)) continue;
    out.push(
      `${doc} is banked in .claude/line-citation-ratchet.json and was not among the documents ` +
        `scanned. Delete its entry in the same commit that removed or renamed it.`,
    );
  }
  return out;
}
