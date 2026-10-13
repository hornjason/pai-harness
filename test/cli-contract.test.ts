/**
 * Covers SC-808, SC-809, SC-810, SC-811 (AGENTS-MD-TEMPLATE-SPEC.md).
 *
 * #363 — `AGENTS.md` published `bunx rungate create-spec` to every scaffolded
 * project while `package.json` declared no `bin`. Three things have to agree
 * and only one of them is code:
 *
 *   1. `bin/rungate.ts` can run the command
 *   2. `package.json`'s `files` ships the script it runs
 *   3. the AGENTS.md generator publishes the command to a consumer
 *
 * All three were wrong at once, each hiding behind the next: no `bin`, so
 * nobody got far enough to notice that `scripts/create-spec.ts` was not in
 * `files` either.
 *
 * The issue warned about the vacuous version of this test by name — asserting
 * the table *contains* the text passes over the exact defect. So every
 * command is RUN, and the `files` membership is checked against the real
 * manifest rather than against a list restated here.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLI_COMMANDS, bunxInvocations, helpText, publishedCommands } from "../lib/cli-commands";
import { generateAgentsMd } from "../lib/generators/agents-md";

const ROOT = join(import.meta.dir, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** `files` entries may be directories; `bin/` covers `bin/rungate.ts`. */
function shippedBy(files: string[], path: string): boolean {
  return files.some(f => (f.endsWith("/") ? path.startsWith(f) : f === path));
}

describe("#363 SC-808: the package declares the bin its docs depend on", () => {
  test("package.json has a bin named rungate", () => {
    expect(PKG.bin, "no bin — `bunx rungate <cmd>` cannot work").toBeDefined();
    expect(PKG.bin.rungate).toBe("bin/rungate.ts");
  });

  test("the bin file exists and is shipped", () => {
    expect(existsSync(join(ROOT, PKG.bin.rungate))).toBe(true);
    expect(
      shippedBy(PKG.files, PKG.bin.rungate),
      `files does not ship ${PKG.bin.rungate} — installing consumers get a broken bin`,
    ).toBe(true);
  });
});

describe("#363 SC-809: every registered command's script is shipped", () => {
  test.each(Object.entries(CLI_COMMANDS))("%s", (name, cmd) => {
    expect(existsSync(join(ROOT, cmd.script)), `${name} -> ${cmd.script} missing`).toBe(true);
    expect(
      shippedBy(PKG.files, cmd.script),
      `${name} dispatches to ${cmd.script}, which package.json's "files" does not ship — ` +
        `the command would exist in the registry and fail on an installed copy. ` +
        `This is the second half of #363: create-spec and create-sc were both in this state.`,
    ).toBe(true);
  });

  test("the registry is not empty", () => {
    // A positive control. Every case above is vacuously true over an empty
    // registry, and `test.each([])` reports zero failures, not zero tests.
    expect(publishedCommands().length).toBeGreaterThanOrEqual(8);
  });
});

describe("#363 SC-810: every documented bunx command actually runs", () => {
  /**
   * Run the real bin, in a SCRATCH cwd.
   *
   * Not `cwd: ROOT`, and the reason is a mutation result rather than
   * caution. Breaking the argv rewrite — mutation 3 — makes `create-spec`
   * receive its own subcommand name as a title, and it writes
   * `specs/CREATE-SPEC-SPEC.md` into whatever directory it is run from. The
   * first version of this file ran from the repo root and left exactly that
   * file behind, which then failed four unrelated doc-hygiene checks. A test
   * for a dispatcher must not be able to edit the repository it is testing.
   */
  function runCli(args: string[]) {
    const scratch = mkdtempSync(join(tmpdir(), "rungate-cli-"));
    try {
      return spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), ...args], {
        encoding: "utf-8",
        cwd: scratch,
        timeout: 60_000,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test("--help lists every registered command", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    for (const name of publishedCommands()) expect(r.stdout).toContain(name);
  });

  test("an unknown command fails loudly rather than doing nothing", () => {
    const r = runCli(["no-such-command"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });

  test("a registered command dispatches — the script RUNS, not merely resolves", () => {
    // `create-sc --list` prints the pattern registry and exits 0. Chosen
    // because it has an observable, side-effect-free output: a dispatcher
    // that imported the module and never reached its top-level code would
    // also exit 0, and this is what tells the two apart.
    const r = runCli(["create-sc", "--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("file-exists");
  });

  test("a command that writes files writes into the CALLER's project", () => {
    // The #363 defect one layer in. create-spec's root defaults to
    // `join(import.meta.dir, "..")` — its own package — so without the
    // dispatcher supplying --project-root, `bunx rungate create-spec` writes
    // `node_modules/rungate/specs/TITLE-SPEC.md`, prints "Created
    // specs/TITLE-SPEC.md", and exits 0. Success reported, consumer's
    // project untouched, installed package quietly modified.
    const scratch = mkdtempSync(join(tmpdir(), "rungate-consumer-"));
    try {
      const r = spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), "create-spec", "Widget Sync"], {
        encoding: "utf-8",
        cwd: scratch,
        timeout: 60_000,
      });
      const here = existsSync(join(scratch, "specs", "WIDGET-SYNC-SPEC.md"));
      const leaked = existsSync(join(ROOT, "specs", "WIDGET-SYNC-SPEC.md"));
      // Read both, then clean up, THEN assert. A mutation that breaks the
      // flag writes into this repo's specs/, and a leaked spec file fails
      // four unrelated doc-hygiene checks on every later run — so the
      // mutation would leave the suite red after being reverted, which is
      // indistinguishable from the revert not working.
      rmSync(join(ROOT, "specs", "WIDGET-SYNC-SPEC.md"), { force: true });
      expect(r.status, r.stderr).toBe(0);
      expect(here, "the spec was not written into the caller's project").toBe(true);
      expect(
        leaked,
        "the command wrote into the rungate package instead of the caller's project",
      ).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the subcommand name is stripped before the script sees argv", () => {
    // The script reads process.argv.slice(2) at the top level. Forget the
    // rewrite and `create-sc` receives `["create-sc", "--list"]`, where
    // `--list` is still found and the bug hides until a positional argument
    // matters. Asserted against a command that takes one.
    const r = runCli(["create-spec"]);
    expect(r.status).not.toBe(0);
    expect(
      (r.stdout + r.stderr).toLowerCase(),
      "create-spec saw a stray argv entry and treated the subcommand name as its title",
    ).toContain("usage");
  });
});

describe("#363 SC-811: the generator publishes only commands that exist", () => {
  const scanFor = (root: string) =>
    ({
      root,
      name: "consumer-project",
      identity: "A consumer",
      techStack: [],
      specs: [],
      testFiles: [],
      keyFiles: [],
      docRouting: [],
      consumers: [],
      sourceDirs: [],
      makeTargets: [],
      testCommand: "bun test",
    }) as never;

  test("a consumer's AGENTS.md names no bunx command the CLI cannot run", () => {
    // The check #363 asked for, in the direction that catches the defect:
    // generated text -> registry, not registry -> text.
    const md = generateAgentsMd(scanFor("/tmp/some-consumer-project-9f3a"));
    const named = bunxInvocations(md, "rungate");
    expect(named.length, "the generator published no bunx command at all").toBeGreaterThan(0);
    for (const cmd of named) {
      expect(
        CLI_COMMANDS[cmd],
        `AGENTS.md publishes "bunx rungate ${cmd}" and lib/cli-commands.ts has no such command`,
      ).toBeDefined();
    }
  });

  test("a consumer is told how to install, since nothing else says rungate is published", () => {
    const md = generateAgentsMd(scanFor("/tmp/some-consumer-project-9f3a"));
    expect(md).toContain("## Install / Consume");
    expect(md).toContain("bun add -d rungate");
  });

  test("the harness documents the source form, not bunx", () => {
    // Inside this repo `bunx rungate` resolves to the PUBLISHED package, so
    // the harness documenting it would have every command in its own
    // AGENTS.md silently run a different version of itself.
    const md = generateAgentsMd(scanFor(ROOT));
    expect(md).toContain("bun bin/rungate.ts create-spec");
    expect(bunxInvocations(md, "rungate")).toEqual([]);
    expect(md).not.toContain("## Install / Consume");
  });

  test("no generated command hardcodes a path from one machine", () => {
    // The third broken row: `bun ~/Projects/rungate/scripts/scaffold-project.ts .`
    // went into every consumer's AGENTS.md.
    for (const root of ["/tmp/some-consumer-project-9f3a", ROOT]) {
      const md = generateAgentsMd(scanFor(root));
      expect(md, `${root} got a machine-specific path`).not.toMatch(/~\/Projects\//);
      expect(md).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//);
    }
  });

  test("help text and the registry cannot drift", () => {
    const help = helpText();
    for (const [name, cmd] of Object.entries(CLI_COMMANDS)) {
      expect(help).toContain(name);
      expect(help).toContain(cmd.summary);
    }
  });
});
