#!/usr/bin/env bun
/**
 * `rungate create-success` — seed the file the methodology calls the measure (#485).
 *
 * A sibling of `create-spec`, and deliberately the dumbest one: it copies a
 * template and fills in the owner and the date. **It does not invent
 * claims.** Five plausible generated claims would be worse than none,
 * because they read as considered and are not, and the conformity check
 * refuses while any placeholder survives — so a project that runs this and
 * stops is LOUDER than one that never ran it, which is the intended
 * direction.
 *
 * Refuses to overwrite. A project's SUCCESS.md is the one document nothing
 * should regenerate over, and `--force` exists only because a half-written
 * seed is a thing people want to restart.
 */

import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const root = arg("project-root") ?? process.cwd();
const force = process.argv.includes("--force");
const target = join(root, "SUCCESS.md");

// `lstatSync`, NOT `existsSync`. BUG-440-A's shape: `existsSync` RESOLVES a
// symlink and `writeFileSync` FOLLOWS one, so a dangling
// `SUCCESS.md -> /elsewhere/x` reads as absent to the guard and as a live
// target to the writer. Measured before this line existed: the command
// reported "Created SUCCESS.md" and wrote 2,007 bytes to
// `/tmp/symprobe/victim/absent.md`, outside the project entirely. With
// `--force` and a symlink to a REAL file it destroyed a 26-byte hand-written
// note the same way, exit 0, refusal never reached.
//
// `lstatSync` describes the LINK, so both kinds count as "already there".
let present = true;
try {
  lstatSync(target);
} catch {
  present = false;
}

if (present && !force) {
  console.error(
    `create-success: ${target} already exists.\n` +
      `This file is the project's own, and regenerating over it would discard the ` +
      `claims someone thought about. Pass --force only if you mean to restart it.`,
  );
  process.exit(1);
}

const templatePath = join(PACKAGE_ROOT, "templates", "SUCCESS-TEMPLATE.md");
if (!existsSync(templatePath)) {
  // Named rather than swallowed: #484 was a documented command that ENOENTed
  // for every consumer because `files[]` omitted the directory it read from.
  console.error(
    `create-success: templates/SUCCESS-TEMPLATE.md is not in this installation. ` +
      `The package's "files" field and this script disagree — see ` +
      `test/package-closure.test.ts, which exists to stop this.`,
  );
  process.exit(1);
}

const owner = arg("owner") ?? process.env.USER ?? "TODO-OWNER";
const today = new Date().toISOString().slice(0, 10);

const body = readFileSync(templatePath, "utf-8")
  .replace("owner: TODO-OWNER", `owner: ${owner}`)
  .replace("updated: TODO-DATE", `updated: ${today}`);

// `--force` means "restart THIS project's SUCCESS.md", never "write through
// whatever this path points at". Unlinking first turns a symlink into an
// absent path, so the `wx` write below creates a real file here rather than
// following the link somewhere else.
if (force && present) unlinkSync(target);

// `wx` is `O_CREAT|O_EXCL`: it refuses an existing path AND refuses a
// symlink, dangling or not, at the syscall rather than in a check above it.
// That also closes the window between the `lstatSync` and this line — a
// guard-then-write is a TOCTOU by construction, and the flag makes the
// refusal atomic instead of merely early.
try {
  writeFileSync(target, body, { flag: "wx" });
} catch (e) {
  console.error(
    `create-success: refused to write ${target} — ${(e as Error).message}\n` +
      `Something is at that path that was not there a moment ago, or it is a ` +
      `symlink. The generator will not write through either.`,
  );
  process.exit(1);
}

console.log(`Created SUCCESS.md (from templates/SUCCESS-TEMPLATE.md)

It is a TEMPLATE and the conformity suite REFUSES it in this state, on purpose.
Replace every line marked \`rungate:placeholder\`:

  - the one sentence under "The thing"
  - what you are deliberately NOT building
  - each claim, its "How it fails" and its "How to measure it"
  - the standing table, which should say \`untested\` until something measures it

Delete the claims you do not need. Three well-chosen claims beat five padded ones.`);
