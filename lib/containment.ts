/**
 * The containment reading: are there harness-pattern files left in the
 * locations this harness was moved OUT of (#921).
 *
 * ## Why this is a module and not three lines in a test
 *
 * `test/structure.test.ts` ST-2b used to compose the old harness root from
 * `process.env.HOME` and `readdirSync` it, then assert the listing was empty.
 * Two separate defects, and the second is the worse one:
 *
 *  - `if (!existsSync(dir)) return` made ABSENCE a pass. A machine with no
 *    old `gates/` directory ran the case to completion having measured
 *    nothing, which is indistinguishable from a clean directory —
 *    `.claude/rules/checks-must-be-able-to-fail.md`, first shape.
 *  - The verdict of the suite that gates THIS repository was set by whatever
 *    the developer happened to have installed in their home directory. Two
 *    unrelated scripts belonging to another running process made every full
 *    local suite 1-fail, while CI — where the home directory is empty — was
 *    green on the same commit. **The CI green was the vacuous case and the
 *    local red was the only real measurement**, which is the exact shape that
 *    gets read as flake and suppressed.
 *
 * Containment is still a property worth watching: harness code moved out of
 * the old locations, and a copy left behind is a second source of truth. What
 * is wrong is reading it off a directory this repository does not own, inside
 * the suite that gates this repository's changes.
 *
 * So the reading is separated from where it is pointed. The suite points it
 * at fixture trees it builds itself and asserts the three states it can
 * return. `scripts/check-containment.ts` points it at the real old root for
 * whoever can actually act on a stray — and that script's exit code, not the
 * repo suite's verdict, is where a machine-local stray shows up.
 *
 * ## Three states, not two
 *
 * `0 strays`, `directory absent` and `could not read the directory` are three
 * different facts and only the first is a pass. Same vocabulary as
 * `scripts/check-unit-suite.sh` (exit 2 = nothing was measured) and the secret
 * scan in `gates.yml` (capture first, so a git failure fails closed).
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { remedyMessage } from "./check-remedy";

/** What a reading of one watched location can say. */
export type ContainmentState = "CLEAN" | "STRAY" | "UNMEASURED";

/**
 * What a location that could not be looked at reports.
 *
 * One declaration, so there is exactly one site to flip in a mutation
 * battery and no second decider can hold a case up while this one is dead.
 * Flipping it to `"CLEAN"` is the pre-#921 behaviour — `if (!existsSync(dir))
 * return` — and is the mutation `test/containment-home-independence.test.ts`
 * applies.
 */
export const ABSENT_STATE: ContainmentState = "UNMEASURED";

/** A directory that must hold no file with the given extension. */
export interface WatchedDir {
  /** Relative to the old harness root. */
  dir: string;
  /** The extension that makes a file there a harness-pattern file. */
  ext: string;
}

/**
 * The directories the harness was moved out of, and the extension that marks
 * a harness file in each.
 *
 * Spelled here rather than derived from `reference/migration-manifest.json`,
 * and the reason is a correctness one rather than convenience: the manifest
 * also lists `skills/`, `PAI/` and `scripts/*.sh` sources, which were NOT
 * migrated away from the old root and still legitimately live there. A watch
 * list derived from every manifest source would report that legitimate tree
 * as strays, and a report that is wrong by construction gets ignored, which
 * costs more than the hand-maintained list of three.
 */
export const WATCHED_DIRS: readonly WatchedDir[] = [
  { dir: "workflows", ext: ".js" },
  { dir: "gates", ext: ".ts" },
  { dir: "lib", ext: ".ts" },
];

/**
 * Individual files whose old directory still holds unrelated files, so the
 * whole directory cannot be scanned by extension.
 *
 * `scripts/` in the old root is shared with scripts that never moved, so only
 * the named two are strays there. This is a narrowing of what counts as a
 * stray in a shared directory, not an exemption for a stray that was found.
 */
export const WATCHED_FILES: readonly string[] = [
  "scripts/sync-spec-tests.ts",
  "scripts/scaffold-rungate-config.ts",
];

/** What one watched location says, and why. */
export interface ContainmentReading {
  /** Human-readable subject, e.g. `workflows/*.js`. */
  subject: string;
  /** The absolute path that was examined. */
  path: string;
  state: ContainmentState;
  /** Absolute paths of the harness-pattern files found. Empty unless STRAY. */
  strays: string[];
  /** Why the state is what it is — the sentence a reader needs. */
  note: string;
}

function dirReading(oldRoot: string, { dir, ext }: WatchedDir): ContainmentReading {
  const path = join(oldRoot, dir);
  const subject = `${dir}/*${ext}`;
  if (!existsSync(path)) {
    return {
      subject,
      path,
      state: ABSENT_STATE,
      strays: [],
      note: `${path} does not exist, so nothing was looked at. Absent is not clean.`,
    };
  }
  let entries: string[];
  try {
    entries = readdirSync(path).map(String);
  } catch (err) {
    // Fails CLOSED. A catch that returned an empty listing here would turn
    // an unreadable directory into a pass, which is the fail-open shape this
    // whole module exists to refuse.
    return {
      subject,
      path,
      state: ABSENT_STATE,
      strays: [],
      note: `${path} could not be read (${(err as Error).message}), so nothing was looked at.`,
    };
  }
  const strays = entries.filter(f => f.endsWith(ext)).map(f => join(path, f));
  return {
    subject,
    path,
    state: strays.length > 0 ? "STRAY" : "CLEAN",
    strays,
    note:
      strays.length > 0
        ? `${strays.length} harness-pattern file(s) in ${path}`
        : `${entries.length} entr(ies) read in ${path}, none ending ${ext}`,
  };
}

function fileReading(oldRoot: string, rel: string): ContainmentReading {
  const path = join(oldRoot, rel);
  const parent = join(oldRoot, rel.split("/").slice(0, -1).join("/"));
  if (!existsSync(parent)) {
    return {
      subject: rel,
      path,
      state: ABSENT_STATE,
      strays: [],
      note: `${parent} does not exist, so ${rel} was never looked for. Absent is not clean.`,
    };
  }
  let present = false;
  try {
    present = statSync(path).isFile();
  } catch {
    present = false;
  }
  return {
    subject: rel,
    path,
    state: present ? "STRAY" : "CLEAN",
    strays: present ? [path] : [],
    note: present ? `${path} is still in the old location` : `${path} is not present`,
  };
}

/**
 * Read every watched location under `oldRoot`.
 *
 * `oldRoot` is a parameter and has no default on purpose: a default would put
 * the home directory back inside every caller that forgot to think about it,
 * and the whole point of #921 is that the repo suite must name a root it owns.
 */
export function readContainment(oldRoot: string): ContainmentReading[] {
  return [
    ...WATCHED_DIRS.map(w => dirReading(oldRoot, w)),
    ...WATCHED_FILES.map(f => fileReading(oldRoot, f)),
  ];
}

/**
 * The verdict over a set of readings.
 *
 * STRAY outranks UNMEASURED because a found file is actionable now; both are
 * non-zero, so neither can be mistaken for clean. A reading set that is empty
 * is UNMEASURED — zero locations examined is not zero strays found.
 */
export function containmentVerdict(readings: ContainmentReading[]): ContainmentState {
  if (readings.length === 0) return "UNMEASURED";
  if (readings.some(r => r.state === "STRAY")) return "STRAY";
  if (readings.some(r => r.state === "UNMEASURED")) return "UNMEASURED";
  return "CLEAN";
}

/** 0 clean, 1 a stray was found, 2 nothing was measured. */
export function containmentExitCode(state: ContainmentState): 0 | 1 | 2 {
  if (state === "CLEAN") return 0;
  return state === "STRAY" ? 1 : 2;
}

/**
 * The message a refusal carries: every file, the directory it is in, and the
 * action — routed through `remedyMessage` so it also names the family of
 * repository-level checks when the project carries that document.
 */
export function containmentRemedy(root: string, readings: ContainmentReading[]): string {
  const strays = readings.filter(r => r.state === "STRAY").flatMap(r => r.strays);
  const unmeasured = readings.filter(r => r.state === "UNMEASURED");
  const unmeasuredNote = unmeasured.length
    ? ` ${unmeasured.length} location(s) reported UNMEASURED and are NOT clean: ` +
      `${unmeasured.map(r => r.note).join("; ")}.`
    : "";
  return remedyMessage({
    root,
    check: "ST-2b containment",
    violations: strays,
    fix:
      `each file above is a second copy of the harness in a directory it was moved out of. ` +
      `Read it, find who owns it, and move or delete it there — do NOT delete a file you ` +
      `did not put there, and do NOT add its name to a list of accepted ones, which only ` +
      `dates the problem. The repo suite asserts this reading against a fixture tree it ` +
      `owns and never a home directory; \`bun scripts/check-containment.ts\` is what takes ` +
      `it against the real old root.${unmeasuredNote}`,
  });
}
