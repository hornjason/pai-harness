#!/usr/bin/env bun
/**
 * The `rungate` command (#363).
 *
 * `AGENTS.md` published `bunx rungate create-spec` to every scaffolded
 * project and `package.json` declared no `bin`, so the documented consumer
 * interface did not exist. This is it.
 *
 * Deliberately thin: the command table is `lib/cli-commands.ts`, so the three
 * things that must agree — what dispatches, what ships, what the generator
 * publishes — read from one place instead of three.
 */
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { CLI_COMMANDS, helpText, runCommandScript } from "../lib/cli-commands";
import { harnessVersionLine } from "../lib/harness-identity";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Say which version is running, before anything else can fail.
//
// On STDERR, and that is the whole design. `ai-review.yml` captures the
// adjudicator with `2>&1`, so this reaches the CI log either way and nothing
// is lost by keeping it off stdout — while stdout stays what a caller can
// parse. `--version` in particular exists to be read by a machine and must
// remain exactly one line.
//
// Emitted for every invocation including `--help` and an unknown command: the
// runs worth attributing are the ones that went wrong, and a banner that
// skips the failure paths is absent exactly when it is wanted.
console.error(harnessVersionLine(PACKAGE_ROOT));

const [name, ...rest] = process.argv.slice(2);

if (!name || name === "--help" || name === "-h" || name === "help") {
  console.log(helpText());
  process.exit(name ? 0 : 1);
}

if (name === "--version" || name === "-v") {
  const pkg = await import(join(PACKAGE_ROOT, "package.json"), { with: { type: "json" } });
  console.log((pkg.default ?? pkg).version);
  process.exit(0);
}

const command = CLI_COMMANDS[name];
if (!command) {
  console.error(`rungate: unknown command "${name}"\n`);
  console.error(helpText());
  process.exit(1);
}

const script = join(PACKAGE_ROOT, command.script);
if (!existsSync(script)) {
  // Reachable only from an installed package whose `files` lost the script.
  // Named rather than swallowed: "command does nothing" is the failure #363
  // is about, and a missing file must not look like a successful run.
  console.error(
    `rungate: "${name}" is registered but ${command.script} is not in this ` +
      `installation. The package's "files" field and lib/cli-commands.ts ` +
      `disagree — see test/cli-contract.test.ts, which exists to stop this.`,
  );
  process.exit(1);
}

// Default the project root to where the USER is, not to where the package
// is. `scripts/create-spec.ts` ends with
// `const root = projectRoot ?? join(import.meta.dir, "..")` — right for
// `bun scripts/create-spec.ts` in this repo, and wrong for every consumer:
// `bunx rungate create-spec "Title"` would write into
// `node_modules/rungate/specs/` and print `Created specs/TITLE-SPEC.md`, so
// the command reports success and the consumer's project is untouched.
// Only added when the caller did not say otherwise, and only for commands
// that accept the flag — a script that does not would read it as a
// positional argument.
const needsRoot = command.projectRootFlag && !rest.includes("--project-root");
const args = needsRoot ? [...rest, "--project-root", process.cwd()] : rest;

// Run the script as an ENTRY MODULE, so `import.meta.main` is true inside it
// and it sees its own arguments rather than the subcommand name.
//
// This was `process.argv = [...]; await import(script)`, and the argv rewrite
// was the tell: it existed to make an imported module look like an entry
// module, which is most of the way to just running it as one. The half it
// could not fake is `import.meta.main`, which is false for any dynamic
// import — so the three command scripts that guard on it loaded, ran nothing
// and exited 0. `lib/cli-commands.ts` carries the measurement.
process.exit(runCommandScript(script, args).code);
