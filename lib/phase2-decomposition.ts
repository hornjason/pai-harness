/**
 * The Phase 2 issue has to carry the ACs it was given (#79).
 *
 * When discovery produces more than `MAX_ACS_PER_ISSUE` ACs, `workflows/
 * ship.js` asks an agent to group them and open a sub-issue for each group
 * after the first. The agent returns a STRUCTURED list — `{number, phase,
 * acIds}` — and separately writes the issue BODY as free prose. Nothing
 * compared the two.
 *
 * On #70 they disagreed completely. The structured list said:
 *
 *     AC-7  a greenfield scaffold writes a roles.json with at least three
 *           agent role entries that survive a read-back
 *     AC-8  hook registrations stored in hooks.json drive consumer hook
 *           deployment under the directory layout
 *     AC-9  the existing scaffold and scanner test files still pass
 *
 * and the body of #75 described AC-7/8/9 as doc-path cleanup — a restatement
 * of AC-5, which was already in Phase 1. Both halves are internally
 * plausible: the ids line up, the spec cited is real, the line numbers are
 * real. A human or an agent picking up #75 reads the prose, not the list, so
 * the deferral would have re-fixed Phase 1's work, shipped it as complete,
 * and closed the parent while `roles.json` and `hooks.json` went on being
 * written empty for every greenfield consumer — the defect that opened #70.
 *
 * That is scope loss that LOOKS COMPLETE. The sub-issue exists, is linked to
 * its parent, and has well-formed ACs. Nothing is visibly missing, which is
 * why the fix has to be a comparison rather than a better prompt.
 *
 * WHAT THIS MODULE REFUSES, AND WHY EACH ONE IS SEPARATE
 *
 * `decompositionRefusal` reads the structure alone; `phase2BodyViolations`
 * reads a body against the ACs it is supposed to carry. They are separate
 * because they fail separately: a grouping can be sound and the body still
 * describe something else (#70's case), and a body can quote its ACs
 * perfectly while the grouping has silently dropped one.
 *
 * Every refusal here is a refusal rather than a repair. A decomposition the
 * harness "fixes" is an acceptance criterion nobody reviewed, which is the
 * #217 lesson one layer up.
 */

/** An AC as discovery produced it. `statement` is the text that must survive. */
export interface DecomposedAc {
  id: string;
  statement: string;
  specElement?: string;
}

/** One group the decompose agent proposed. `number` is set once it exists. */
export interface SubIssuePlan {
  number?: number;
  phase?: string;
  acIds?: string[];
}

/**
 * Everything wrong with a proposed decomposition, or an empty list.
 *
 * Returns a LIST, not a boolean or a first error: a decomposition that drops
 * one AC and duplicates another has two problems, and reporting one of them
 * invites a second round that discovers the other.
 */
export function decompositionRefusal(
  allAcs: readonly DecomposedAc[] | null | undefined,
  phase1AcIds: readonly string[] | null | undefined,
  subIssues: readonly SubIssuePlan[] | null | undefined,
): string[] {
  const acs = Array.isArray(allAcs) ? allAcs : [];
  const phase1 = Array.isArray(phase1AcIds) ? phase1AcIds : [];
  const groups = Array.isArray(subIssues) ? subIssues : [];
  const out: string[] = [];

  if (acs.length === 0) return ["decomposition was asked for with no ACs to decompose"];

  const known = new Set<string>();
  for (const ac of acs) {
    if (ac?.id) known.add(ac.id);
    if (ac?.specElement) for (const s of ac.specElement.split(",")) known.add(s.trim());
  }

  // Phase 1 holding nothing is not a decomposition, it is a deferral of the
  // whole issue — and it reads as success because sub-issues were created.
  if (phase1.length === 0) out.push("no AC was kept for Phase 1 — the whole issue was deferred");

  for (const id of phase1) {
    if (!known.has(id)) out.push(`Phase 1 keeps ${id}, which discovery never produced`);
  }

  /** Which groups claim each id — the shape both duplicate cases need. */
  const claimedBy = new Map<string, string[]>();
  for (const [i, g] of groups.entries()) {
    const label = g?.number ? `#${g.number}` : (g?.phase || `group ${i + 1}`);
    const ids = Array.isArray(g?.acIds) ? g.acIds : [];
    if (ids.length === 0) out.push(`${label} was created carrying no ACs`);
    for (const id of ids) {
      if (!known.has(id)) out.push(`${label} claims ${id}, which discovery never produced`);
      claimedBy.set(id, [...(claimedBy.get(id) ?? []), label]);
    }
  }

  // AC-3. The #70 failure mode exactly: a deferred AC that restates one
  // already being shipped. Flagged, never written.
  const phase1Set = new Set(phase1);
  for (const [id, labels] of claimedBy) {
    if (phase1Set.has(id)) {
      out.push(`${id} is in Phase 1 AND deferred to ${labels.join(" and ")} — a deferral that duplicates shipped work`);
    }
    if (labels.length > 1) {
      out.push(`${id} is claimed by ${labels.join(" and ")} — two phases cannot both own one AC`);
    }
  }

  // The silent half. An AC in neither Phase 1 nor any sub-issue has been
  // dropped, and every count the run prints still adds up.
  for (const ac of acs) {
    const ids: string[] = [ac.id, ...(ac.specElement ? ac.specElement.split(",").map((s: string) => s.trim()) : [])].filter(Boolean);
    const placed = ids.some(id => phase1Set.has(id) || claimedBy.has(id));
    if (!placed) out.push(`${ac.id} was neither kept nor deferred — it is gone, and nothing else would say so`);
  }

  return out;
}

/**
 * The ACs one group owns, in discovery's order.
 *
 * One function, so the body comparison and the issue that was created cannot
 * disagree about which ACs belong to a group. Matches on `id` or on any
 * comma-separated `specElement`, because the decompose agent returns either
 * — the same tolerance `workflows/ship.js` already applies when it filters
 * Phase 1, and splitting it in two is how the two would drift.
 */
export function acsForGroup(
  acs: readonly DecomposedAc[] | null | undefined,
  group: SubIssuePlan | null | undefined,
): DecomposedAc[] {
  const ids = new Set<string>(Array.isArray(group?.acIds) ? group!.acIds : []);
  if (ids.size === 0) return [];
  // Annotated because `Array.isArray` narrows a `readonly T[]` to `any[]`,
  // and an `any` here would silently turn every field access below into an
  // unchecked one.
  const list: readonly DecomposedAc[] = Array.isArray(acs) ? acs : [];
  return list.filter(ac => {
    if (ids.has(ac.id)) return true;
    if (!ac.specElement) return false;
    return ac.specElement.split(",").some((s: string) => ids.has(s.trim()));
  });
}

/**
 * Wrap a string so a POSIX shell passes it through untouched.
 *
 * AC statements routinely contain backticks, double quotes and `$`. A
 * single-quoted shell word is literal for every character except `'`, which
 * is closed, escaped and reopened. This is the only quoting in the data path
 * and it exists because the reference copy of the statements must reach disk
 * WITHOUT passing through the model — a model that reworded both the body
 * and the thing the body is compared against would pass any comparison.
 */
export function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The AC list as it appears in the decompose prompt.
 *
 * The prompt used to list no ACs at all, so the agent wrote each sub-issue
 * body by reconstructing the scope from memory — which is exactly how #75's
 * body came to describe Phase 1's work. The statements are now in front of
 * it, verbatim, in the form it is asked to copy.
 */
export function acListBlock(acs: readonly DecomposedAc[]): string {
  return acs.map(ac => `- [ ] ${ac.id}: ${ac.statement}`).join("\n");
}

/**
 * The command that writes the comparison's reference copy of the ACs.
 *
 * Emitted into the prompt for the agent to run verbatim, the way every other
 * `bun -e` in this workflow is. The payload is the harness's own validated
 * discovery output, shell-quoted here rather than composed by the model.
 */
export function phase2AcsCommand(harnessRoot: string, workDir: string, acs: readonly DecomposedAc[]): string {
  const payload = JSON.stringify(acs.map(a => ({ id: a.id, statement: a.statement, specElement: a.specElement })));
  return (
    `bun --cwd ${shellSingleQuote(harnessRoot)} -e 'require("fs").writeFileSync(process.argv[1], process.argv[2])' ` +
    `${workDir}/phase2-acs.json ${shellSingleQuote(payload)}`
  );
}

/** The heading the comparison reads under. Must match what the prompt asks for. */
export const SC_HEADING = "## Success Criteria";

/**
 * Normalise for comparison WITHOUT making the comparison meaningless.
 *
 * Markdown wraps, so a statement written across two lines is the same
 * statement; collapsing runs of whitespace is therefore required rather than
 * lenient. Nothing else is touched — not case, not punctuation, not the
 * backticks around an identifier. A looser comparison here is how a body
 * that paraphrases its AC would start passing, which is the whole defect.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Everything wrong with a Phase 2 body, given the ACs it is supposed to carry.
 *
 * Covers #79 AC-1 (same ids) and AC-2 (statements verbatim, by string
 * equality after whitespace collapsing). The id check alone would have passed
 * #75 — its body listed AC-7, AC-8 and AC-9 — so the statement check is the
 * load-bearing half and the id check is there for the case where a body
 * silently carries one fewer.
 */
export function phase2BodyViolations(
  body: string | null | undefined,
  acs: readonly DecomposedAc[] | null | undefined,
): string[] {
  const text = typeof body === "string" ? body : "";
  const expected = Array.isArray(acs) ? acs : [];
  const out: string[] = [];

  if (expected.length === 0) return ["no ACs were supplied to compare the body against"];
  if (normalise(text) === "") return ["the issue body is empty"];

  const headingAt = text.indexOf(SC_HEADING);
  if (headingAt < 0) {
    return [`the body has no "${SC_HEADING}" section, so there is nothing to compare the AC list against`];
  }
  // Everything from the heading to the next H2, which is the section the
  // prompt asks for. Reading the WHOLE body would let an AC id mentioned in
  // passing somewhere else satisfy the check.
  const rest = text.slice(headingAt + SC_HEADING.length);
  const nextH2 = rest.search(/^## /m);
  const section = nextH2 < 0 ? rest : rest.slice(0, nextH2);
  const flat = normalise(section);

  for (const ac of expected) {
    if (!new RegExp(`(^|[^A-Za-z0-9-])${ac.id}([^A-Za-z0-9-]|$)`).test(flat)) {
      out.push(`${ac.id} is in the deferred list and not in the body's ${SC_HEADING} section`);
      continue;
    }
    const statement = normalise(ac.statement ?? "");
    if (statement === "") {
      out.push(`${ac.id} has no statement in discovery, so the body cannot be checked against it`);
      continue;
    }
    if (!flat.includes(statement)) {
      out.push(
        `${ac.id}'s statement is not carried verbatim. discovery: "${statement}" — ` +
          `the body describes something else, which is #70's defect: the ids lined up and the work did not`,
      );
    }
  }

  // The other direction. A body carrying an id that was never deferred to it
  // is the #75 shape read from the body's side: plausible, well-formed, and
  // about different work.
  const expectedIds = new Set(expected.map(a => a.id));
  for (const found of flat.matchAll(/(?:^|[^A-Za-z0-9-])(AC-\d+)(?![A-Za-z0-9-])/g)) {
    const id = found[1]!;
    if (!expectedIds.has(id)) {
      out.push(`the body's ${SC_HEADING} section lists ${id}, which was not deferred to this issue`);
    }
  }

  return out;
}
