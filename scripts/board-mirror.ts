#!/usr/bin/env bun
/**
 * Put a spec's criteria onto the project board, where they can be SEEN (#1647).
 *
 * Step 3 of `docs/adr/ADR-003-spec-to-tracker-mapping.md` says the issue body
 * declares which criteria the work serves. That is the right place for the
 * fact and the wrong place to read it from: a board renders FIELDS, not
 * bodies, so grouping by milestone shows the phase and the criteria stay
 * invisible until somebody opens all 27 issues one at a time.
 *
 * This command derives a text field from the bodies and writes it to the
 * board. **The field is a mirror. The body is the source.** A project custom
 * field is invisible to `gh` — `gh issue list --json projectItems` returns
 * Status and nothing else, measured on #1592 — so an agent can never read this
 * column, and nothing load-bearing may be put in it. It exists so a person can
 * look at the board and see the trace. If the column and the body disagree,
 * the body is right; re-run this, do not edit the cell.
 *
 * ## Ready is written, not filtered, and that is measured
 *
 * The obvious design is a saved view on `is:open no:blocked-by`. It does not
 * work: those filters match on whether a dependency LINK exists, not on
 * whether the blocker is still open. See `isReady` in `lib/board-mirror.ts`
 * for the four public issues that prove it. So readiness is computed from
 * `issueDependenciesSummary.blockedBy` — the OPEN count, a different field
 * from `totalBlockedBy` — and written to Status.
 *
 * ## It only ever moves Status between Backlog and Ready
 *
 * A board column is also a person's workspace. An item somebody has dragged to
 * *In progress*, *In review* or *Done* is a statement this command has no
 * standing to overrule, and the whole value of the lane dies the first time it
 * stamps on one. So the transition set is closed and tiny: empty or Backlog
 * may become Ready, Ready may fall back to Backlog, and every other reading is
 * left exactly where it is and reported as skipped.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import { createGitHubClient } from "../lib/github";
import { parseCriteria } from "../lib/spec-evidence";
import { mirrorRows, isReady, openFrontier, phaseOf, specCriteriaIn } from "../lib/board-mirror";

/**
 * THE one non-zero exit, so `test/board-mirror.test.ts` can build a mutant
 * with it set to `0` and prove each refusal is what the case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

const USAGE = `rungate board-mirror --project <node-id> [--spec <spec.md>] [--field <name>] [--write] [--ready] [--json]

  --project  the ProjectV2 node id, e.g. PVT_kwHO…
  --spec     narrow the column to ONE spec's criteria. Omit it — which is the
             normal case — and every spec under specs/ is read. An issue does
             not know which spec you had in mind, so narrowing blanks the cell
             of every issue serving any other spec (SC-2610).
  --field    the TEXT field to mirror into. Default "Criteria". It must
             already exist on the project — this does not create one, because
             a typo would silently add a column nobody looks at.
  --write    write the field. Without it nothing is mutated.
  --ready    also move Status between Backlog and Ready from the OPEN
             blocked-by count. Implies nothing unless --write is given too.
  --json     the whole reading.`;

/** Status names this command is allowed to write, and what it may overwrite. */
export const READY = "Ready";
export const BACKLOG = "Backlog";
export const MAY_OVERWRITE: readonly string[] = ["", BACKLOG, READY];

interface Item {
  itemId: string;
  number: number;
  title: string;
  body: string;
  state: string;
  status: string;
  assignees: number;
  blockedByOpen: number;
  blockedByTotal: number;
  criteriaCell: string;
  milestone: string;
  phase: number | null;
}

const ITEMS_QUERY = `query($project: ID!, $field: String!, $after: String) {
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) { ... on ProjectV2Field { id name dataType } }
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: $field) { ... on ProjectV2ItemFieldTextValue { text } }
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number title body state
              milestone { title }
              assignees { totalCount }
              issueDependenciesSummary { blockedBy totalBlockedBy }
            }
          }
        }
      }
    }
  }
}`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        spec: { type: "string" },
        field: { type: "string", default: "Criteria" },
        write: { type: "boolean", default: false },
        ready: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
      },
      allowPositionals: false,
    });
  } catch (e) {
    console.error(`board-mirror: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const { values } = parsed;
  if (!values.project) {
    console.error(`board-mirror: --project is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();

  // The id set the column is drawn from. Default: every spec in the tree —
  // see SC-2610 and `specCriteriaIn`. `--spec` narrows it, which is useful
  // for inspecting one spec and wrong for writing the board.
  let ids: string[];
  let sourceDescription: string;
  if (values.spec) {
    const specPath = isAbsolute(values.spec) ? values.spec : join(root, values.spec);
    if (!existsSync(specPath)) {
      console.error(`board-mirror: no such spec: ${specPath}`);
      return REFUSAL_EXIT;
    }
    ids = parseCriteria(readFileSync(specPath, "utf-8")).map(c => c.id);
    if (ids.length === 0) {
      console.error(`board-mirror: ${specPath} declares no criteria — nothing could be mirrored`);
      return REFUSAL_EXIT;
    }
    sourceDescription = `${values.spec} only — every other spec's criteria will render as an empty cell`;
  } else {
    const sweep = specCriteriaIn(root);
    if (sweep.reading === "UNMEASURED") {
      console.error(`board-mirror: UNMEASURED — the criteria could not be read:`);
      for (const r of sweep.unmeasuredReasons) console.error(`  - ${r}`);
      return REFUSAL_EXIT;
    }
    // Reported, not refused: an id two specs both state still produces one
    // correct cell. What it breaks is the reader's ability to tell which
    // spec the cell meant, and that is worth saying out loud once.
    for (const c of sweep.collisions) {
      console.error(`board-mirror: note — ${c.id} is stated by ${c.specs.join(" and ")}`);
    }
    ids = [...sweep.ids];
    sourceDescription = `${sweep.specs.filter(s => s.ids.length > 0).length} specs under specs/`;
  }

  const client = createGitHubClient();

  // ── Read every item, and the field we are about to write ─────────────────
  const items: Item[] = [];
  let fieldId: string | undefined;
  let after: string | null = null;
  for (;;) {
    const page: any = await client.graphql(ITEMS_QUERY, {
      project: values.project,
      field: values.field,
      after,
    });
    const node = page?.node;
    if (!node) {
      console.error(`board-mirror: ${values.project} is not a project this token can read`);
      return REFUSAL_EXIT;
    }
    if (!node.field) {
      console.error(
        `board-mirror: the project has no field named "${values.field}". ` +
          `Create it first — this command does not, because a typo would add a ` +
          `column nobody looks at rather than failing.`,
      );
      return REFUSAL_EXIT;
    }
    if (node.field.dataType !== "TEXT") {
      console.error(
        `board-mirror: field "${values.field}" is ${node.field.dataType}, not TEXT. ` +
          `Refusing: writing a single-select regenerates every option id and ` +
          `clears every value on the board.`,
      );
      return REFUSAL_EXIT;
    }
    fieldId = node.field.id;
    for (const n of node.items.nodes) {
      if (!n.content?.number) continue; // a draft item has no issue
      items.push({
        itemId: n.id,
        number: n.content.number,
        title: n.content.title ?? "",
        body: n.content.body ?? "",
        state: n.content.state ?? "",
        status: n.status?.name ?? "",
        assignees: n.content.assignees?.totalCount ?? 0,
        blockedByOpen: n.content.issueDependenciesSummary?.blockedBy ?? 0,
        blockedByTotal: n.content.issueDependenciesSummary?.totalBlockedBy ?? 0,
        criteriaCell: n.fieldValueByName?.text ?? "",
        milestone: n.content.milestone?.title ?? "",
        phase: phaseOf(n.content.milestone?.title),
      });
    }
    if (!node.items.pageInfo.hasNextPage) break;
    after = node.items.pageInfo.endCursor;
  }

  const rows = mirrorRows(items, ids);
  const byNumber = new Map(rows.map(r => [r.number, r]));

  const fieldChanges = items
    .filter(i => (byNumber.get(i.number)?.text ?? "") !== i.criteriaCell)
    .map(i => ({ item: i, to: byNumber.get(i.number)!.text }));

  const frontier = openFrontier(items);
  const readyChanges = items
    .filter(i => i.state === "OPEN")
    .map(i => ({ item: i, to: isReady(i, frontier) ? READY : BACKLOG }))
    .filter(c => c.to !== c.item.status);

  // An assignee is a person saying "mine". Where their card sits is then
  // theirs to decide, and demoting a claimed issue to Backlog makes it look
  // abandoned on a board somebody is reading at a glance. So the guard is
  // two-part: the status must be one this command may overwrite, AND nobody
  // may have claimed the issue.
  const mayWrite = (c: { item: Item }) =>
    MAY_OVERWRITE.includes(c.item.status) && c.item.assignees === 0;
  const readyWritable = readyChanges.filter(mayWrite);
  const readySkipped = readyChanges.filter(c => !mayWrite(c));

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          field: values.field,
          criteriaInSpec: ids.length,
          items: items.length,
          rows: rows.map(r => ({ number: r.number, criteria: r.criteria })),
          fieldChanges: fieldChanges.map(c => ({ number: c.item.number, from: c.item.criteriaCell, to: c.to })),
          readyWritable: readyWritable.map(c => ({ number: c.item.number, from: c.item.status, to: c.to })),
          readySkipped: readySkipped.map(c => ({ number: c.item.number, status: c.item.status })),
          wrote: values.write,
        },
        null,
        2,
      ),
    );
  } else {
    const named = rows.filter(r => r.criteria.length > 0);
    console.log(`\nboard-mirror — ${values.field} on ${items.length} item(s)\n`);
    console.log(`  ${ids.length} criteria, read from ${sourceDescription}`);
    console.log(`  ${named.length} of ${items.length} items name at least one`);
    console.log(`  ${new Set(named.flatMap(r => r.criteria)).size} distinct criteria reached\n`);
    for (const c of fieldChanges) {
      console.log(`  #${c.item.number}  "${c.item.criteriaCell}" -> "${c.to}"`);
    }
    if (fieldChanges.length === 0) console.log(`  every cell already agrees with its issue body`);
    if (values.ready) {
      console.log(
        `\n  Ready lane — the frontier is ` +
          (frontier === null ? `nowhere: no open issue sits in a phase` : `Phase ${frontier}`),
      );
      for (const c of readyWritable) {
        console.log(`    #${c.item.number}  ${c.item.status || "(none)"} -> ${c.to}  (${c.item.milestone || "no milestone"}; ${c.item.blockedByOpen} open of ${c.item.blockedByTotal} blockers, ${c.item.assignees} assignee(s))`);
      }
      for (const c of readySkipped) {
        const why =
          c.item.assignees > 0 ? `someone has claimed it` : `not this command's to move`;
        console.log(`    #${c.item.number}  left at ${c.item.status || "(none)"} — ${why}`);
      }
      if (readyWritable.length === 0) console.log(`    nothing to move`);
    }
    if (!values.write) console.log(`\n  (reporting only — pass --write to apply)`);
  }

  if (!values.write) return 0;

  for (const c of fieldChanges) {
    await client.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{text:$v}}){projectV2Item{id}}}`,
      { p: values.project, i: c.item.itemId, f: fieldId, v: c.to },
    );
  }
  if (values.ready) {
    const statusField: any = await client.graphql(
      `query($p:ID!){node(id:$p){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { p: values.project },
    );
    const sf = statusField?.node?.field;
    if (!sf) {
      console.error(`board-mirror: the project has no Status field — --ready cannot be applied`);
      return REFUSAL_EXIT;
    }
    const optionFor = new Map<string, string>(sf.options.map((o: any) => [o.name, o.id]));
    for (const c of readyWritable) {
      const option = optionFor.get(c.to);
      if (!option) {
        console.error(`board-mirror: Status has no option named "${c.to}" — refusing`);
        return REFUSAL_EXIT;
      }
      await client.graphql(
        `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
        { p: values.project, i: c.item.itemId, f: sf.id, o: option },
      );
    }
  }
  console.log(
    `\n  wrote ${fieldChanges.length} ${values.field} cell(s)` +
      (values.ready ? ` and ${readyWritable.length} Status value(s)` : ``),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
