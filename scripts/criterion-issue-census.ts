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
  censusRows,
  renderCensus,
  unadjudicated,
  type Adjudication,
  type IssueRef,
  type SpecRef,
} from "../lib/criterion-issue-census";
import { createGitHubClient, listOpenIssues } from "../lib/github";
import { localCalendarDay } from "../lib/local-calendar-day";
import { collectSpecFiles } from "../lib/spec-files";

/** Every refusal exits through this, so a test can mutate one site. */
export const EXIT_REFUSED = 1;

export const ADJUDICATIONS_FILE = ".claude/criterion-issue-adjudications.json";

const REPO_SLUG = "hornjason/pai-harness";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function readAdjudications(root: string): Adjudication[] {
  const path = join(root, ADJUDICATIONS_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Absent is a real state and a legitimate one: nobody has judged anything
    // yet. It is NOT the same as unreadable, which throws below.
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.adjudications)) {
    throw new Error(
      `${ADJUDICATIONS_FILE} is present and has no \`adjudications\` array. ` +
        `A store that cannot be read is a refusal, not an empty reading.`,
    );
  }
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

  const page = await listOpenIssues(createGitHubClient(), REPO_SLUG);
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

process.exit(await main());
