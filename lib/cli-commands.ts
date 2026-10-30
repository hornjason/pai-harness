/**
 * What `rungate <command>` dispatches to (#363).
 *
 * Data, not a switch in the bin, because three separate things have to agree
 * and only one of them is code:
 *
 *   1. `bin/rungate.ts` can run the command
 *   2. `package.json`'s `files` ships the script it runs
 *   3. the AGENTS.md generator publishes the command to every consumer
 *
 * Before this existed they did not agree, and the disagreement was invisible
 * from every direction. `AGENTS.md` published `bunx rungate create-spec`;
 * `package.json` declared no `bin`, so the command could not run at all; and
 * `scripts/create-spec.ts` was not in `files`, so even a correct `bin` would
 * have shipped a dispatcher pointing at a script the consumer never received.
 * Three defects, each hiding behind the next.
 *
 * An agent reading `AGENTS.md` ran the command and it failed. An agent
 * reading `package.json` saw no `bin`, concluded rungate had no CLI and was
 * not distributable, and recommended hand-scaffolding a project. Both
 * readings of the repo were wrong, which is the state a single source fixes.
 *
 * ## A command script is run as an ENTRY MODULE, not imported
 *
 * This section used to read: "None of them guards on `import.meta.main`
 * … Adding an `import.meta.main` guard to any of them would silently turn its
 * subcommand into a no-op, so `test/cli-contract.test.ts` runs every command
 * for real." The hazard was named exactly. Both mitigations were false.
 *
 * Three scripts acquired the guard — and `import.meta.main` is FALSE for a
 * dynamically imported module, so `await import(script)` loaded them, ran
 * nothing, and exited 0. Measured on `3da782dc`, dispatcher against the same
 * script run directly, in bytes of output:
 *
 *   audit-specs          0  vs  2092     silent
 *   sync-spec-tests      0  vs  1254     silent
 *   extract-constraints  0  vs    57     silent
 *   ai-review-findings 270  vs   270     reached — see below
 *
 * Three of ten commands reported success having done nothing. The second
 * mitigation is why nobody saw it: `test/cli-contract.test.ts` ran ONE
 * command for real, `create-sc --list`, and its comment names this defect in
 * as many words. One member of the population was enough to hold the
 * assertion up while the other nine went unmeasured — the battery varied the
 * dispatcher and held the COMMAND fixed, and the defect was on that axis
 * (`.claude/rules/checks-must-be-able-to-fail.md`, seventh shape).
 *
 * `scripts/ai-review-findings.ts` is the one that still worked, and it is the
 * prior art rather than the exception: #675 hit this, documented the
 * mechanism in its docblock, and worked around it by calling `main`
 * unconditionally from a wrapper. That fixed one command and left the
 * dispatcher as it was.
 *
 * So the fix is here, in the one place that decides how a command is invoked,
 * rather than three more wrappers — a per-script workaround is three more
 * places to forget, and the forgetting reads as the command succeeding.
 * `runCommandScript` spawns the script with the running bun binary, which
 * makes it the entry module and `import.meta.main` true, exactly as
 * `bun scripts/audit-specs.ts` already was. A guard is now the normal thing
 * for a script to have, instead of a trap.
 */
import { spawnSync } from "child_process";

export interface CliCommand {
  /** The script this runs, relative to the package root. Must be in `files`. */
  script: string;
  /** One line for `rungate --help`. */
  summary: string;
  /** Shown under the summary; the form a consumer types. */
  usage: string;
  /**
   * The script defaults its project root to its OWN location, so the
   * dispatcher must pass `--project-root <cwd>` or the command writes into
   * the installed package.
   *
   * `scripts/create-spec.ts` ends with
   * `const root = projectRoot ?? join(import.meta.dir, "..")`, which is
   * correct for `bun scripts/create-spec.ts` inside this repo and wrong for
   * every consumer: `bunx rungate create-spec "Title"` would write
   * `node_modules/rungate/specs/TITLE-SPEC.md` and print `Created
   * specs/TITLE-SPEC.md`, so the command reports success and the consumer's
   * project is untouched. That is the #363 defect one layer in — the
   * documented interface existing and doing the wrong thing.
   *
   * Flagged per-command rather than passed to everything, because a script
   * that does not accept the flag would take it as a positional argument.
   */
  projectRootFlag?: true;
}

export const CLI_COMMANDS: Record<string, CliCommand> = {
  scaffold: {
    script: "scripts/scaffold-project.ts",
    summary: "Generate or refresh a project's agent files, rules and conformity suite",
    usage: "rungate scaffold <path> [--type code|workflow] [--fix] [--force] [--commit] [--no-auto-fix] [--prune-consumers]",
  },
  "create-spec": {
    script: "scripts/create-spec.ts",
    summary: "Create a spec file with the required frontmatter",
    usage: 'rungate create-spec "Title" ["what it governs"] [--sc "statement"]',
    projectRootFlag: true,
  },
  "create-success": {
    script: "scripts/create-success.ts",
    summary: "Seed SUCCESS.md — what this project is for, and the claims that prove it",
    usage: "rungate create-success [--owner <name>] [--force]",
    projectRootFlag: true,
  },
  "create-sc": {
    script: "scripts/create-sc.ts",
    summary: "Generate a matchable success-criterion line from a registered pattern",
    usage: "rungate create-sc --pattern <name> --params '<json>' [--spec <file>]",
  },
  "convert-spec": {
    script: "scripts/convert-spec.ts",
    summary: "Convert an existing document into a testable spec",
    usage: 'rungate convert-spec <file> [--dry-run] [--title "..."] [--governs "..."]',
    projectRootFlag: true,
  },
  "audit-specs": {
    script: "scripts/audit-specs.ts",
    summary: "Report which success criteria are matched, unmatched or uncovered",
    usage: "rungate audit-specs",
  },
  // Registered because `create-spec` SHIPS and stamps every generated spec
  // with `evidence: required`, and this is the only thing that enforces that
  // key (#1639). Without the entry the published package emitted a document
  // declaring itself gated and carried no gate — half of a generator/checker
  // pair, which is the shape the `create-spec` note above records this
  // registry already having been built for once.
  //
  // Raised by the required reviewer on EVERY round of #1639, rounds 1 through
  // 5, and answered on none of them: its finding anchors `package.json`,
  // which is not in that pull request's diff, so `ai-review-threads` could
  // not create the thread (422, "path could not be resolved") and the job
  // failed with a message naming the posting failure rather than the finding.
  // A finding on a file outside the diff is invisible to anyone reading
  // review threads. Read the ledger.
  //
  // `projectRootFlag` is load-bearing: the script defaults its root to its
  // own location, so without the flag `bunx rungate audit-spec-evidence`
  // would walk `node_modules/rungate/specs/` and report RUNGATE's compliance
  // as the consumer's — a pass about a tree it never opened.
  "audit-spec-evidence": {
    script: "scripts/audit-spec-evidence.ts",
    summary: "Refuse a ticked criterion that does not name what proved it",
    usage: "rungate audit-spec-evidence [--json] [--record-fingerprints]",
    projectRootFlag: true,
  },
  // Step 2 of `docs/adr/ADR-003-spec-to-tracker-mapping.md`, which was eight
  // `gh` commands typed by hand before this existed (#1647). Registered
  // rather than left a script because the whole point is that a CONSUMER can
  // turn their own spec into their own milestones — the derivation is not
  // about this repository's phases, and a script in `scripts/` reaches
  // nobody who installed the package.
  //
  // `projectRootFlag` is load-bearing for the same reason it is on
  // `audit-spec-evidence`: the spec path is resolved against the root, so
  // without the flag `bunx rungate plan-spec specs/X.md` would read
  // `node_modules/rungate/specs/X.md` and derive RUNGATE's phases into the
  // consumer's repository.
  "plan-spec": {
    script: "scripts/plan-spec.ts",
    summary: "Derive a repository's milestones from a spec's Phase placement table",
    usage: "rungate plan-spec <spec.md> --repo <owner/name> --prefix <name> [--write] [--json]",
    projectRootFlag: true,
  },
  // Registered after two hours of building a weaker version of it beside it
  // (#1647). This script has produced the full criterion-to-issue-to-PR-to-
  // test matrix since it was written, and was reachable from nothing: not a
  // command, not in `files[]`, not in CI, named in no always-loaded document.
  // `rungate plan-spec`'s coverage column was written in ignorance of it and
  // duplicated its matcher. An unregistered tool is indistinguishable from an
  // absent one, which is the whole of #1309 and is why that registry exists.
  //
  // `projectRootFlag`, and the script REFUSES a `--project-root` without a
  // `--spec`: its default spec is rungate's own convergence document.
  "criterion-inventory": {
    script: "scripts/criterion-inventory.ts",
    summary: "Trace every criterion to the tests, issues and pull requests that name it",
    usage: "rungate criterion-inventory --snapshot <dir> --spec <path> [--json] [--markdown]",
    projectRootFlag: true,
  },
  // Step 3 of ADR-003 made VISIBLE (#1647). The issue body declares which
  // criteria the work serves and the board renders fields, not bodies, so the
  // declaration was invisible without opening every issue in turn. This
  // derives a text column from the bodies and writes it.
  //
  // The direction is load-bearing and stated in `lib/board-mirror.ts`: the
  // body is the source, the column is a mirror. A project custom field cannot
  // be read through `gh` at all, so nothing an agent acts on may live there.
  //
  // `projectRootFlag` for the same reason as its neighbours — the spec path
  // resolves against the root, and without it a consumer would mirror
  // RUNGATE's criteria onto their own board.
  // `--spec` is BRACKETED, and that is load-bearing rather than cosmetic.
  // Spelling it as required tells a reader to narrow the sweep to one spec,
  // which blanks the cell of every issue serving any other spec — SC-2610,
  // the defect the flag was made optional to fix. This registry is a second
  // place that documents the same contract as `USAGE` in
  // `scripts/board-mirror.ts`, so `test/board-mirror.test.ts` asserts the two
  // agree: the AI review of #1679 raised this stale string on ten rounds
  // running and each round found it unswept, because a fix applied to the
  // script never reached the sibling that describes it.
  "board-mirror": {
    script: "scripts/board-mirror.ts",
    summary: "Show every spec's criteria, and what is ready to pick up, on the project board",
    usage:
      "rungate board-mirror --project <node-id> [--spec <spec.md>] [--field <name>] [--write] [--ready] [--json]",
    projectRootFlag: true,
  },
  // Step 4 of ADR-003, in reverse. The issue template's own footer says a
  // GitHub issue form cannot set a milestone or a dependency; this does both
  // from a plan somebody approved. `--repair` fixes issues that already
  // exist.
  //
  // `projectRootFlag` because the plan path resolves against the root.
  "plan-issues": {
    script: "scripts/plan-issues.ts",
    summary:
      "Apply an approved issue plan — --decompose creates issues from criteria (step 4), --repair links and demotes existing ones",
    usage:
      "rungate plan-issues (--repair | --decompose) <plan.md> --repo <owner/name> [--write] [--json]",
    projectRootFlag: true,
  },
  // Step 5 of ADR-003. `plan-spec` turns the placement table into milestones;
  // this turns the ORDER of those milestones into `blocked by` edges, which is
  // AGENTS.md rule 4 — ordering is data, not prose.
  //
  // No `projectRootFlag`: it reads the tracker, not the tree. The phase is
  // read off each issue's milestone title, so there is no spec path to
  // resolve and nothing on disk it could resolve against the wrong root.
  "plan-deps": {
    script: "scripts/plan-deps.ts",
    summary: "Write a spec's phase order onto the tracker as blocked-by edges",
    usage: "rungate plan-deps --repo <owner/name> [--write] [--json] [--include-closed]",
  },
  "sync-spec-tests": {
    script: "scripts/sync-spec-tests.ts",
    summary: "Regenerate the conformity suite from the specs",
    usage: "rungate sync-spec-tests",
  },
  "generate-code-map": {
    script: "scripts/generate-code-map.ts",
    summary: "Regenerate CODE-MAP.md from the source tree",
    usage: "rungate generate-code-map",
  },
  "extract-constraints": {
    script: "scripts/extract-constraints.ts",
    summary: "Extract constraints from a project's docs into agent rules",
    usage: "rungate extract-constraints",
  },
  // Registered so the GENERATED ai-review workflow has something to run. The
  // reader has existed and been tested since #631 and nothing executed it:
  // `lib/scaffold/ai-review-step.ts` emitted a warning saying so by name,
  // because a scaffolded consumer has no copy of rungate's sources at a path
  // the workflow could hardcode. This registry is the path (#675).
  //
  // No `projectRootFlag`: the arguments are the findings payload and the
  // changed-path list, both of which live outside the checkout by design
  // (`RUNNER_TEMP`), and appending `--project-root <cwd>` would arrive as a
  // third positional. That absence is now load-bearing twice over — it is
  // also why the changed-path list may safely BE a positional.
  "ai-review-findings": {
    script: "scripts/ai-review-findings.ts",
    summary: "Adjudicate an AI review's findings payload — exits non-zero on a blocking finding",
    // The second positional is the pull request's changed-path list, one path
    // per line (#1204, #1435). It is OPTIONAL: no generated job supplies it
    // yet, and an absent list reports its own state rather than switching a
    // check off in silence.
    usage: "rungate ai-review-findings <path-to-findings.json> [<path-to-changed-files.txt>]",
  },
  // Registered for the same reason `ai-review-findings` is, one workflow
  // over (#1488): the generated `ai-review-unmeasured.yml` runs in a
  // consumer's repository, which has no copy of rungate's sources at any
  // path the workflow could name. This registry is the path.
  //
  // No `projectRootFlag`: every argument is a flag and the script reads no
  // project tree at all — it talks to the GitHub API about a repository it
  // is told the name of, so an appended `--project-root <cwd>` would be
  // refused by `parseArgs` as an unknown argument.
  // Registered for the same reachability reason as the two around it
  // (#1612): the generated `ai-review` job runs in a consumer's repository,
  // which holds no copy of rungate's sources at any path a workflow could
  // name. This registry is that path.
  //
  // SEPARATE from `ai-review-findings` on purpose. That command exits
  // non-zero on a blocking finding — so a poster sharing its entry point
  // could never run on the review that actually found something, which is
  // the only review worth posting.
  //
  // No `projectRootFlag`: the payload lives outside the checkout in
  // `RUNNER_TEMP`, everything else is a flag, and an appended
  // `--project-root <cwd>` would arrive as a second positional, which
  // `parse` refuses by name rather than silently reading as the payload.
  "ai-review-threads": {
    script: "scripts/ai-review-threads.ts",
    summary: "Post an AI review's findings onto the pull request's diff as review threads",
    usage:
      "rungate ai-review-threads <path-to-findings.json> --repo <owner/name> " +
      "--pr <n> --commit <sha> [--changed-files <path>]",
  },
  "record-ai-review-unmeasured": {
    script: "scripts/record-ai-review-unmeasured.ts",
    summary: "Record WHICH kind of unmeasured each unmeasured AI-review round was",
    usage:
      "rungate record-ai-review-unmeasured --repo <owner/name> " +
      "[--head-sha <sha> | --pr <n> | --limit <n>] [--write]",
  },
};

/** The commands the AGENTS.md generator may publish to a consumer. */
export function publishedCommands(): string[] {
  return Object.keys(CLI_COMMANDS);
}

/** What a dispatched command returned, and what it wrote when captured. */
export interface CommandRun {
  /** The code to exit with. Never `null` — a killed or unspawnable child is non-zero. */
  code: number;
  /** Present only when `capture` was asked for. */
  stdout?: string;
  stderr?: string;
}

/**
 * Run a command's script AS AN ENTRY MODULE, and return the code to exit with.
 *
 * THE single binding for how a subcommand is invoked. The dispatcher calls
 * nothing else, so there is one place to mutate and a test can watch the
 * invocation stop being an entry-module run — see the docblock at the top of
 * this file for the three commands that were silently no-ops when this was
 * `await import(script)`.
 *
 * `process.execPath` rather than the string `"bun"`: the child must be the
 * same runtime the parent is already running under, and a consumer's PATH is
 * not ours to assume.
 *
 * ## Every way this can fail to run is non-zero
 *
 * `spawnSync` reports `status: null` for a child that never produced an exit
 * code — killed by a signal, or never spawned at all. Mapping that to 0 would
 * reinstate the defect this function exists to remove, one layer out: a
 * command that did not run, reporting success.
 *
 * ONE `??`, not a `signal` branch beside it. The first version had both, and
 * the separate branch made `?? 1` unreachable — no input could distinguish it
 * from `?? 0`, so the case asserting "a script that cannot run is a failure"
 * passed under that mutation. It was green because a missing script makes
 * *bun* exit non-zero, which is a real status the `??` never sees
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape: an assertion
 * holding for a reason that is not the one claimed). Collapsed to one path,
 * a SIGKILLed child reaches it and the mutation is caught.
 */
export function runCommandScript(
  script: string,
  args: string[],
  opts?: { capture?: boolean },
): CommandRun {
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: opts?.capture ? "pipe" : "inherit",
    encoding: "utf-8",
  });
  const captured = opts?.capture ? { stdout: r.stdout ?? "", stderr: r.stderr ?? "" } : {};
  // A spawn error is not a verdict the script reached. Say so on stderr —
  // under `stdio: "inherit"` the child wrote nothing and a bare exit code
  // would be the silent failure again, one layer out.
  if (r.error) {
    const why = `rungate: could not run ${script}: ${r.error.message}`;
    if (!opts?.capture) console.error(why);
    return { code: 1, ...captured, ...(opts?.capture ? { stderr: why } : {}) };
  }
  return { code: r.status ?? 1, ...captured };
}

export function helpText(): string {
  const rows = Object.entries(CLI_COMMANDS).map(
    ([name, c]) => `  ${name.padEnd(20)}${c.summary}\n  ${" ".repeat(20)}${c.usage}`,
  );
  return [
    "rungate — ship harness: conformity tests, scaffold, and agent briefs",
    "",
    "Usage: rungate <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Run a command with no arguments for its own usage where it has one.",
  ].join("\n");
}

/**
 * The routing table for `.claude/rules/commands-routing.md`, generated.
 *
 * #1309 in one function. The scaffold routed specs, docs, key files and
 * managed files and did not route COMMANDS, so a command reached an agent
 * only if somebody had hand-written a row for it in `AGENTS.md`'s Commands
 * table — four of ten, and the four were the four somebody happened to need
 * in 2026-09. Measured over the always-loaded surface on `11a60f67`, seven of
 * the ten were named in no file an agent loads, including `audit-specs`,
 * whose whole job is reporting spec status. An agent spent a day
 * hand-building a tracking mechanism that was already a subcommand.
 *
 * Generated from `CLI_COMMANDS` rather than written, because a hand-list is
 * precisely what failed: the generated table is present and plausible, reads
 * as complete, and nothing in it signals that six more commands exist.
 *
 * ## No usage strings here, deliberately
 *
 * `helpText()` carries them and `--help` prints them. This table is the
 * always-loaded surface, which is at 93% of `SURFACE_BUDGET_BYTES` — adding
 * ten usage lines would cost ~600 bytes to save one `--help`, and the thing
 * an agent cannot discover by running a command is that the command EXISTS.
 * The summary is what makes `audit-specs` findable by someone thinking "which
 * criteria are covered"; the arguments are one invocation away.
 */
export function commandRoutingTable(): string {
  const rows = Object.entries(CLI_COMMANDS).map(
    ([name, c]) => `| \`${name}\` | ${c.summary} |`,
  );
  return ["| Command | What it does |", "|---------|--------------|", ...rows].join("\n");
}

/**
 * Every code span in a markdown document — fenced blocks and inline spans.
 *
 * `commandNamed` searches this slice rather than the whole document, and the
 * slice is the point: `.claude/rules/harness-managed.md` says "a re-scaffold
 * rewrites them" and `AGENTS.md` says "Re-scaffold", and neither of those
 * routes anyone to the `scaffold` command. A command name is a thing you
 * TYPE, so the region where it counts is the region reserved for things you
 * type (`.claude/rules/checks-must-be-able-to-fail.md`, "search the slice,
 * not the document").
 */
export function codeSpans(markdown: string): string {
  const fenced = markdown.match(/```[\s\S]*?```/g) ?? [];
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "\n");
  const inline = withoutFences.match(/`[^`\n]+`/g) ?? [];
  return [...fenced, ...inline].join("\n");
}

/**
 * Is `name` typed, as a whole word, anywhere in this document's code spans?
 *
 * `.` is in the boundary class alongside `-` so that `scripts/convert-spec.ts`
 * does not count as routing the `convert-spec` COMMAND. It is the script the
 * command runs, named in the form a consumer cannot use, and treating a path
 * as a routing is how `convert-spec` read as present while `bunx rungate
 * convert-spec` was documented nowhere.
 *
 * The direction this is allowed to be wrong in is toward reporting a command
 * UNROUTED: a routing form nobody thought of costs one generated row, and the
 * other direction is a command that reads as discoverable and is not — which
 * is the whole of #1309.
 */
export function commandNamed(markdown: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9.-])${escaped}(?![a-z0-9.-])`).test(codeSpans(markdown));
}

/** One always-loaded document, as `measureSurface` reports the population. */
export interface SurfaceDoc {
  file: string;
  text: string;
}

export interface CommandRoutingReading {
  /** UNMEASURED FAILS. An empty search is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Registered commands named nowhere in the surface. */
  unrouted: string[];
  filesSearched: number;
  /** Bytes of code span searched. Zero is the instrument, not the answer. */
  spanBytes: number;
}

/**
 * Which registered commands are named nowhere an agent loads.
 *
 * Takes the surface as an argument rather than deriving it, because the
 * population of always-loaded files is already decided once, by
 * `measureSurface` in `scripts/check-instruction-surface.ts`. A second
 * definition here would be two deciders that agree, and the one that matters
 * — whether a `paths:` key has quietly moved a rule out of the launch surface
 * — would be invisible to a check that had its own idea of what loads.
 *
 * The three UNMEASURED states are all ways this returns `[]` while having
 * searched nothing: no documents, no code spans in any of them, or an empty
 * registry. Each of them reads exactly like a tree where every command is
 * routed (`.claude/rules/config-access.md`).
 */
export function commandRoutingReading(surface: SurfaceDoc[]): CommandRoutingReading {
  const reasons: string[] = [];
  const spans = surface.map(d => codeSpans(d.text)).join("\n");
  const spanBytes = Buffer.byteLength(spans, "utf-8");
  const names = publishedCommands();

  if (surface.length === 0) {
    reasons.push("the always-loaded surface came back empty — no documents were searched");
  }
  if (spanBytes === 0) {
    reasons.push(
      `${surface.length} document(s) yielded no code spans at all; a command name is only ` +
        `counted inside one, so every command would read as unrouted for an instrument reason`,
    );
  }
  if (names.length === 0) {
    reasons.push("CLI_COMMANDS is empty — nothing to route, which is not the same as routed");
  }

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    unrouted: names.filter(n => !surface.some(d => commandNamed(d.text, n))),
    filesSearched: surface.length,
    spanBytes,
  };
}

/**
 * Every `bunx <pkg> <cmd>` invocation in a markdown command table.
 *
 * Used in both directions by `test/cli-contract.test.ts`: a published command
 * must dispatch, and a dispatching command's script must be shipped. Written
 * to find the invocation ANYWHERE in the text rather than only in a table
 * row, because a documented-but-broken command is just as broken in a prose
 * sentence as in a table.
 */
export function bunxInvocations(markdown: string, pkg: string): string[] {
  const pattern = new RegExp(String.raw`\bbunx\s+${pkg}\s+([a-z][a-z0-9-]*)`, "g");
  return [...new Set([...markdown.matchAll(pattern)].map(m => m[1]))];
}
