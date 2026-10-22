#!/usr/bin/env bun
/**
 * Refuse a ship launch whose session cwd is not the tree the run was handed
 * (#644).
 *
 * ## Why this is a script and not a line in `workflows/ship.js`
 *
 * It cannot be a line in ship.js. Measured on this tree: ship.js makes
 * **zero** subprocess calls, and its own comments record why — *"ship.js
 * has no filesystem (#69)"*, *"the sandbox has no module loading (#69)"*.
 * It cannot run `git`, so it cannot read where the session is.
 *
 * And the check has to happen BEFORE the first isolated spawn, because the
 * first isolated spawn is the thing that goes wrong: failure 1 dies there,
 * and failure 2 silently succeeds there. By the time any agent is running,
 * the base has already been chosen.
 *
 * So the only position left is the launcher — whatever invokes the
 * workflow. It runs this, and does not launch on a non-zero exit:
 *
 *     bun scripts/check-launch-base.ts --project-root <dir> [--harness-root <dir>] [--cwd <dir>]
 *
 * It also refuses a root that is reached through a SYMLINK (#1129), naming
 * the canonical spelling to relaunch with. That check belongs here for the
 * same reason the rest of the file does: `workflows/ship.js` compares roots
 * as strings and cannot resolve one, so a symlinked root makes it refuse its
 * own agent worktrees. This is the last point before launch at which the
 * value can still be corrected.
 *
 * `--cwd` defaults to `process.cwd()`, which is the whole point: the
 * launcher runs in the session whose directory is in question, so the
 * default is the value being tested. It is overridable only so a test can
 * supply one.
 *
 * ## Properties this file must keep
 *
 * Both from `scripts/verify-merge-content.ts`, for the reasons it states:
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once. A
 *      refusal written with a literal `1` would slip past any mutation of
 *      the constant.
 *   2. It decides nothing itself. The reading and the refusal both come
 *      from `lib/launch-base.ts`, so there is ONE binding to mutate rather
 *      than a script and a library that agree
 *      (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */

import { launchBaseReading } from "../lib/launch-base";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

// `harness-root` is OPTIONAL, and deliberately so: the roots are two
// separate arguments to the run and a launcher that only knows one of them
// should still get the check it can have. An absent value is skipped, never
// treated as canonical (#1129).
const OPTIONS = new Set(["project-root", "harness-root", "cwd"]);

class Refused extends Error {}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Refused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Refused(`--${m[1]} needs a value`);
    out[m[1]] = value;
  }
  if (!out["project-root"]) throw new Refused("--project-root is required");
  return out;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    // The default is `process.cwd()` deliberately: this script runs in the
    // session being checked, so the thing under test is its own ambient
    // state. Everywhere else in this repo an ambient default is the defect
    // (#644 is about exactly that) — here it is the measurement.
    const reading = launchBaseReading(
      args.cwd ?? process.cwd(),
      args["project-root"],
      args["harness-root"],
    );

    console.log(JSON.stringify(reading, null, 2));

    if (reading.reading !== "SAME_CHECKOUT") {
      console.error(`LAUNCH_BASE_${reading.reading}: ${reading.refusal}`);
      process.exit(REFUSE_EXIT);
    }
  } catch (e: any) {
    // A refusal and a crash both have to be non-zero, and both have to say
    // which they are: a reading that could not be taken is not a clean one.
    console.error(e instanceof Refused ? `REFUSED: ${e.message}` : `UNREADABLE: ${e?.message || e}`);
    process.exit(REFUSE_EXIT);
  }
}
