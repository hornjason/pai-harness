#!/usr/bin/env bun
/**
 * Take CRC-M11's convergence reading over a named pull-request RANGE, append
 * it to a store, and print the delta against the previous row.
 *
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * ```sh
 * bun scripts/crc-reading.ts --lo 1573 --hi 1632            # read and print
 * bun scripts/crc-reading.ts --lo 1573 --hi 1632 --record   # and append the row
 * bun scripts/crc-reading.ts --lo 1573 --hi 1632 --from /tmp/entries.json
 * ```
 *
 * ## What this replaces, and why it is a program
 *
 * It was four shell commands in the spec — a `gh api graphql`, two `jq -e`
 * premise guards, `run.ts rounds`, and a second `jq` for the measured-only
 * column — plus a hand-typed table. Three things made that untenable, and all
 * three were found by running it rather than by reading it:
 *
 * - **jq cannot refuse one element.** A single malformed ledger aborted the
 *   whole pipeline and lost the entire range.
 * - **The recipe cut itself in half.** Its `split("```json")[1]` fence rule
 *   was cut by a ledger whose stored finding quoted a fenced block — on
 *   2026-10-27, by a reviewer quoting the recipe itself.
 * - **The table was retyped each time**, and twice carried figures built by a
 *   rule the prose beside them had already abandoned.
 *
 * ## The range is a filter, not a page size
 *
 * `--page` over-fetches and the range is `select`ed out of it. The second
 * premise guard asserts the page actually reached both ends, because an
 * under-sized page returns a PREFIX of the range whose figures are internally
 * consistent and about a different cohort. "The 45 most recent" is not a
 * cohort — the window rolls, and two readings are only comparable if both
 * name their range.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  deltaLines,
  premiseViolations,
  renderCrcReading,
  spliceCrcBlock,
  takeCrcReading,
  type CrcEntry,
  type CrcReadingRow,
} from "../lib/crc-reading.ts";
import { AI_REVIEW_LEDGER_COMMENT_MARKER } from "../lib/ai-review-rounds.ts";
import { localCalendarDay } from "../lib/local-calendar-day.ts";

/**
 * THE ONE EXIT CODE every refusal routes through.
 *
 * One site, so a mutation of it is a mutation of every refusal this script
 * can make and a test can watch the refusal stop happening
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const CRC_READING_REFUSED = 1;

const DEFAULT_REPO = "hornjason/pai-harness";
const DEFAULT_STORE = "specs/crc-readings.json";
const DEFAULT_PAGE = 100;

/**
 * GraphQL's `Actor.login` for the built-in Actions bot.
 *
 * **Correct here and wrong one API over.** REST's `user.login` for the same
 * comment is `github-actions[bot]`. Transcribing this filter to a REST call
 * silently matches nothing and returns a page of empty bodies, which is a
 * reading of zero that looks like data.
 */
const LEDGER_AUTHOR_LOGIN = "github-actions";

interface Args {
  lo: number;
  hi: number;
  repo: string;
  page: number;
  from: string | null;
  save: string | null;
  record: boolean;
  store: string;
  date: string;
  writeSpec: string | null;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const out: Args = {
    lo: NaN,
    hi: NaN,
    repo: DEFAULT_REPO,
    page: DEFAULT_PAGE,
    from: null,
    save: null,
    record: false,
    store: DEFAULT_STORE,
    // `localCalendarDay`, not `toISOString().slice(0, 10)`: a reading taken
    // in the evening on this machine would otherwise be dated tomorrow, and
    // the store is ordered by that field.
    date: localCalendarDay(),
    writeSpec: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--lo") out.lo = Number.parseInt(next(), 10);
    else if (a === "--hi") out.hi = Number.parseInt(next(), 10);
    else if (a === "--repo") out.repo = next();
    else if (a === "--page") out.page = Number.parseInt(next(), 10);
    else if (a === "--from") out.from = next();
    else if (a === "--save") out.save = next();
    else if (a === "--store") out.store = next();
    else if (a === "--date") out.date = next();
    else if (a === "--write-spec") out.writeSpec = next();
    else if (a === "--record") out.record = true;
    else return { error: `unknown argument ${a}` };
  }
  if (!Number.isInteger(out.lo) || !Number.isInteger(out.hi)) {
    return { error: "--lo and --hi are required and must be integers" };
  }
  if (out.lo > out.hi) return { error: `--lo ${out.lo} is above --hi ${out.hi}` };
  if (!Number.isInteger(out.page) || out.page < 1 || out.page > 100) {
    return { error: `--page ${out.page} must be between 1 and 100` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    return { error: `--date ${out.date} is not an ISO day` };
  }
  return out;
}

const QUERY = (repo: string, page: number): string => {
  const [owner, name] = repo.split("/");
  return `{repository(owner:"${owner}",name:"${name}"){pullRequests(first:${page},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number merged comments(first:100){totalCount nodes{author{login} body}}}}}}`;
};

interface RawNode {
  number: number;
  merged: boolean;
  comments: { totalCount: number; nodes: { author: { login: string } | null; body: string }[] };
}

/**
 * The fetch, and it is part of the chain.
 *
 * A fetch whose failure is caught only because three downstream guards happen
 * to cover its three failure shapes is working by luck. Here it refuses in
 * its own right: a non-zero `gh`, a body that is not JSON, and a payload with
 * no `nodes` array are three different messages and none of them reaches the
 * scorer.
 */
function fetchEntries(args: Args): CrcEntry[] | { error: string } {
  const res = spawnSync(
    "gh",
    ["api", "graphql", "-f", `query=${QUERY(args.repo, args.page)}`],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    return { error: `gh api graphql exited ${res.status}: ${(res.stderr || "").trim()}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { error: `gh api graphql returned no JSON: ${(e as Error).message}` };
  }
  const nodes = (parsed as { data?: { repository?: { pullRequests?: { nodes?: unknown } } } })
    ?.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) {
    return { error: "the GraphQL payload carries no pullRequests.nodes array" };
  }
  return (nodes as RawNode[])
    .filter(n => n.number >= args.lo && n.number <= args.hi)
    .map(n => ({
      number: n.number,
      passed: n.merged === true,
      truncated: n.comments.totalCount > n.comments.nodes.length,
      // LAST, not first: the ledger is one upserted comment, but a pull
      // request can also carry a human comment QUOTING the marker, and the
      // bot-login clause is what separates them.
      body:
        n.comments.nodes
          .filter(
            c =>
              c.author?.login === LEDGER_AUTHOR_LOGIN &&
              typeof c.body === "string" &&
              c.body.includes(AI_REVIEW_LEDGER_COMMENT_MARKER),
          )
          .map(c => c.body)
          .pop() ?? null,
    }));
}

function readStore(path: string): CrcReadingRow[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON array of readings`);
  }
  return parsed as CrcReadingRow[];
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if ("error" in args) {
    process.stderr.write(
      `crc-reading: ${args.error}\n` +
        "usage: bun scripts/crc-reading.ts --lo <N> --hi <N> [--repo owner/name] " +
        "[--page 1..100] [--from <entries.json>] [--save <entries.json>] " +
        "[--record] [--store <path>] [--date YYYY-MM-DD]\n",
    );
    return CRC_READING_REFUSED;
  }

  let entries: CrcEntry[];
  if (args.from !== null) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(args.from, "utf-8"));
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      entries = parsed as CrcEntry[];
    } catch (e) {
      process.stderr.write(`crc-reading: could not read ${args.from}: ${(e as Error).message}\n`);
      return CRC_READING_REFUSED;
    }
  } else {
    const fetched = fetchEntries(args);
    if ("error" in fetched) {
      process.stderr.write(`crc-reading: ${fetched.error}\n`);
      return CRC_READING_REFUSED;
    }
    entries = fetched;
  }
  if (args.save !== null) writeFileSync(args.save, `${JSON.stringify(entries, null, 2)}\n`);

  const violations = premiseViolations(entries, args.lo, args.hi);
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`crc-reading: PREMISE ${v.kind} — ${v.detail}\n`);
    }
    return CRC_READING_REFUSED;
  }

  const row = takeCrcReading(entries, args.lo, args.hi, args.date);
  for (const line of renderCrcReading(row)) process.stdout.write(`${line}\n`);
  process.stdout.write("\n");

  const storePath = join(process.cwd(), args.store);
  let store: CrcReadingRow[];
  try {
    store = readStore(storePath);
  } catch (e) {
    process.stderr.write(`crc-reading: ${(e as Error).message}\n`);
    return CRC_READING_REFUSED;
  }
  const previous = store.length === 0 ? null : store[store.length - 1];
  for (const line of deltaLines(previous, row)) process.stdout.write(`${line}\n`);

  for (const column of [row.allRounds, row.measuredOnly] as const) {
    for (const r of column.refusals) {
      process.stdout.write(`  #${r.number} UNMEASURED ${r.refusal}: ${r.detail}\n`);
    }
  }

  if (args.record) {
    writeFileSync(storePath, `${JSON.stringify([...store, row], null, 2)}\n`);
    process.stdout.write(`\nrecorded row ${store.length + 1} in ${args.store}\n`);
  } else {
    process.stdout.write("\nnot recorded — rerun with --record to append this row\n");
  }

  if (args.writeSpec !== null) {
    const at = join(process.cwd(), args.writeSpec);
    const spliced = spliceCrcBlock(readFileSync(at, "utf-8"), row);
    if (spliced === null) {
      // A document that cannot say where its generated block goes is refused
      // rather than having one appended somewhere plausible.
      process.stderr.write(
        `crc-reading: ${args.writeSpec} carries no crc-reading begin/end markers\n`,
      );
      return CRC_READING_REFUSED;
    }
    writeFileSync(at, spliced);
    process.stdout.write(`rendered the block into ${args.writeSpec}\n`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
