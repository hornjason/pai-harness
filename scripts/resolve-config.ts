#!/usr/bin/env bun
/**
 * resolve-config.ts — the subprocess boundary for ADR-002 D1.
 *
 * `workflows/*.js` and agent prompts cannot import `lib/config-loader.ts`, so
 * they get the resolved config the way every other bit of harness state
 * crosses that boundary: a thin CLI materialises it into the run's own work
 * directory and the workflow reads the file.
 *
 * THIS FILE CONTAINS NO RESOLUTION LOGIC. Any logic here would be a violation
 * of D1 by the module enforcing D1 — a second place that knows what a config
 * means is exactly the thing the ADR exists to remove. It parses two flags,
 * calls the loader, and writes what it got.
 *
 * It cannot fail open. There is no `|| echo "{}"` equivalent: an unresolvable
 * config exits non-zero and writes nothing, so the next reader faces a missing
 * file it must handle rather than an empty object that reads as "configured
 * with nothing".
 *
 * The output is a RUN ARTEFACT, not a cache: written once per run into the
 * work directory, never into the project tree, never reused across runs.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { resolveConfig, ResolvedConfigSchema } from "../lib/config-loader";

/**
 * Every refusal routes through this one constant so the mutation harness has a
 * single site to zero out (.claude/rules/checks-must-be-able-to-fail.md). It
 * must appear exactly once in this file.
 */
export const REFUSE_EXIT = 1;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function refuse(message: string): never {
  console.error(`resolve-config: ${message}`);
  process.exit(REFUSE_EXIT);
}

export function main(): void {
  const projectRoot = flag("project");
  const outPath = flag("out");

  if (!projectRoot) refuse("--project <projectRoot> is required");

  // A malformed config or an orphaned directory fragment throws out of the
  // loader. The throw is deliberate (ADR-001 D2) and is NOT caught here: an
  // uncaught throw exits non-zero with the loader's own message, which is
  // more informative than anything this file could substitute.
  const resolution = resolveConfig(projectRoot);

  if (resolution.status === "absent") {
    refuse(
      `no rungate config found under ${projectRoot}/.claude — ` +
        `expected .claude/rungate/config.json or .claude/rungate.json`
    );
  }

  const validated = ResolvedConfigSchema.safeParse(resolution.config);
  if (!validated.success) {
    const where = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    refuse(`config at ${projectRoot} did not validate — ${where}`);
  }

  const json = JSON.stringify(validated.data, null, 2);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${json}\n`);
  }

  console.log(json);
}

if (import.meta.main) main();
