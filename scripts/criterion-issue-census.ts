#!/usr/bin/env bun
/**
 * The status view: which ticked criteria an open issue NAMES.
 *
 * The design decision — mechanical column, judgement recorded separately and
 * dated — is stated in `lib/criterion-issue-census.ts` and is not repeated
 * here. This file is the IO: read the specs, fetch the tracker, read the
 * adjudication store, print.
 *
 *   bun scripts/criterion-issue-census.ts [--project-root <dir>] [--json] [--strict]
 *
 * `--strict` exits non-zero when any named criterion has no current
 * adjudication. It is OFF by default and this script is wired into no gate,
 * deliberately: whether an unadjudicated row should block a merge is a policy
 * decision with an owner, and a reporting tool that quietly became a gate is
 * how a project acquires a refusal nobody chose.
 *
 * `--project-root` defaults to this file's repository, which is correct in
 * this repo and would be wrong in a consumer's — so the flag exists and the
 * default is stated rather than implied. This script is not published.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertAdjudicationShape,
  censusRows,
  renderCensus,
  unadjudicated,
  type Adjudication,
  type IssueRef,
  type SpecRef,
} from "../lib/criterion-issue-census";
import { tryLoadRungateConfig } from "../lib/config-loader";
import { createGitHubClient, listOpenIssues } from "../lib/github";
import { localCalendarDay } from "../lib/local-calendar-day";
import { collectSpecFiles } from "../lib/spec-files";

/** Every refusal exits through this, so a test can mutate one site. */
export const EXIT_REFUSED = 1;

export const ADJUDICATIONS_FILE = ".claude/criterion-issue-adjudications.json";

/**
 * The tracker this census reads is DECLARED by the project, never spelled here.
 *
 * It was `const REPO_SLUG = "hornjason/pai-harness"` until 2026-10-28, when the
 * repository was renamed to `hornjason/rungate`. Nothing broke — GitHub
 * redirects the old name — so the literal went on resolving to the right
 * tracker for the wrong reason, which is the failure mode worth closing: this
 * script already takes `--project-root`, and against any root but this one the
 * literal censused OUR issues against THEIR criteria and said nothing.
 */
function declaredRepo(root: string): string | null {
  const repo = tryLoadRungateConfig(root)?.repo;
  return typeof repo === "string" && repo.includes("/") ? repo : null;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function readAdjudications(root: string): Adjudication[] {
  const path = join(root, ADJUDICATIONS_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    // ENOENT and nothing else. Absent is a real, legitimate state: nobody has
    // judged anything yet. Unreadable is not — a permission error, an EISDIR
    // or any other errno means a store EXISTS and could not be read, and
    // returning `[]` there would report every row as unadjudicated when the
    // judgements may all be present. The first draft of this caught
    // everything, with a comment claiming exactly the distinction the code did
    // not make; raised by the required reviewer on #1641, and it is the
    // anti-pattern `.claude/rules/config-access.md` names by name — "never
    // `catch {}` around a config read. It converts corruption into absence."
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.adjudications)) {
    throw new Error(
      `${ADJUDICATIONS_FILE} is present and has no \`adjudications\` array. ` +
        `A store that cannot be read is a refusal, not an empty reading.`,
    );
  }
  // Per RECORD, not just per file. The lookup downstream is a strict `===`, so
  // one mistyped field makes a judgement that exists report as UNADJUDICATED.
  parsed.adjudications.forEach((record: unknown, at: number) =>
    assertAdjudicationShape(record, `${ADJUDICATIONS_FILE}[${at}]`),
  );
  return parsed.adjudications as Adjudication[];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const root = flagValue(argv, "--project-root") ?? join(import.meta.dir, "..");
  const asJson = argv.includes("--json");
  const strict = argv.includes("--strict");

  const specsDir = join(root, "specs");
  // `collectSpecFiles` returns paths relative to `specsDir`, so the join is
  // what reads the file and the `specs/` prefix is what names it in a row.
  const specs: SpecRef[] = collectSpecFiles(specsDir).map(file => ({
    file: `specs/${file}`,
    content: readFileSync(join(specsDir, file), "utf-8"),
  }));
  if (specs.length === 0) {
    console.error(`UNMEASURED: no specs under ${specsDir}. Nothing was read.`);
    return EXIT_REFUSED;
  }

  const repoSlug = declaredRepo(root);
  if (repoSlug === null) {
    console.error(
      `UNMEASURED: ${root} declares no \`repo\` in .claude/rungate/config.json. ` +
        "Nothing was read — a census against the wrong tracker reports every " +
        "criterion as unnamed by any issue, which is indistinguishable from a " +
        "clean result.",
    );
    return EXIT_REFUSED;
  }

  const page = await listOpenIssues(createGitHubClient(), repoSlug);
  if (page.truncated) {
    // A partial issue set makes every "no issue names this" row unreliable in
    // the one direction that matters, and silently.
    console.error(
      `UNMEASURED: the tracker returned a full page of ${page.perPage} and may hold ` +
        `more. A census over part of the tracker reports criteria as unnamed that ` +
        `an unfetched issue names.`,
    );
    return EXIT_REFUSED;
  }

  const issues: IssueRef[] = page.issues.map(i => ({
    number: i.number,
    title: i.title,
    body: i.body,
  }));
  const rows = censusRows(specs, issues, readAdjudications(root));
  const owed = unadjudicated(rows);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          taken: localCalendarDay(),
          specsRead: specs.length,
          issuesRead: issues.length,
          issuesDropped: page.droppedRows.length,
          rows,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      renderCensus(
        rows,
        `${localCalendarDay()}, over ${specs.length} spec(s) and ${issues.length} open issue(s)`,
      ),
    );
    console.log(`\n  ${owed.length} row(s) have no current adjudication.`);
  }

  return strict && owed.length > 0 ? EXIT_REFUSED : 0;
}

// Guarded so a test can import `readAdjudications` without running the census
// against the live tracker — which is what made the bug above untestable.
if (import.meta.main) process.exit(await main());
