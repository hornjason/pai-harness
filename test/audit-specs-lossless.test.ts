/**
 * Covers SC-1587..SC-1595 (SCAFFOLD-DECOMPOSITION-SPEC.md), #426.
 *
 * `bun bin/rungate.ts scaffold . --fix` is the documented way to take a
 * harness update. It rewrote `specs/HARNESS-GATES.md` on every run, and the
 * rewrite lost information:
 *
 *   - SC-1469: workflows/ship.js not contains [s.environments.prod.rebuild = 'PASS'] — a container that answers …
 *   + SC-1469: not contains [s.environments.prod.rebuild = 'PASS']
 *
 * The file the criterion is about and the entire rationale clause, deleted,
 * silently, under a summary line naming `ci.yml`.
 *
 * The proximate cause is `content-not-contains` in the matcher registry: it
 * accepted `must NOT contain` and `has no` but not the `not contains` form —
 * which is the form `content-contains-compound`'s OWN example writes. So the
 * single-clause form of the documented grammar was unmatchable, SC-1469 was
 * classified unmatched, and `--fix` re-rendered it from a template that
 * carries neither a file nor prose.
 *
 * Two things are therefore fixed and both are driven from both sides here,
 * because fixing only the registry would leave the next unrecognised
 * structured form being silently rewritten:
 *
 *   1. the registry recognises the form, so the absence claim is ASSERTED
 *      rather than merely left alone — it had never run;
 *   2. `decideRewrite` refuses to rewrite anything already in the structured
 *      grammar, refuses any rewrite that would drop the file, and carries
 *      the rationale across when it does rewrite.
 *
 * The thing that makes this file a check rather than a line in a report is
 * the pairing: every case asserting a line survives sits beside one asserting
 * a genuinely unstructured line is still rewritten. An "it never rewrites
 * anything" fix has to fail here, which is AC-4 in the issue.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  auditSpecs,
  decideRewrite,
  alreadyStructured,
} from "../scripts/audit-specs";
import { matchPattern } from "../lib/conformity";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures", "audit-specs-lossless");

/** SC-1469's text, verbatim from the tree at the time of #426. */
const SC_1469 =
  "workflows/ship.js not contains [s.environments.prod.rebuild = 'PASS'] — a container that answers a health check is recorded as SKIP with a reason rather than as a rebuild that happened";

/**
 * Structured, and STILL unmatched after the registry fix — the leading token
 * is followed by prose before the absence keyword, so `^(\S+)\s+does\s+not`
 * does not bind. SC-440 in DA-COMPLIANCE-SPEC.md is this shape today. It is
 * the live case for the rewriter guard: the matcher gap that remains is
 * exactly where a lossy rewrite would still happen.
 */
const STRUCTURED_UNMATCHED =
  "workflows/ship.js GRADE phase does not contain [Grade each agent] — the grading is data, not a prompt";

/**
 * Prose a heuristic CAN bind, so `--fix` rewrites it. The control.
 *
 * It has to be a line the rewriter genuinely acts on: a statement with no
 * close pattern at all is merely KEPT, which would make the "still rewrites
 * something" assertion pass over a rewriter that had been switched off.
 */
const UNSTRUCTURED = "the generator should emit a tidy CODE-MAP.md for every project";

function writeFixtureSpec(body: string): string {
  mkdirSync(join(FIXTURE, "specs"), { recursive: true });
  const path = join(FIXTURE, "specs", "LOSSLESS-SPEC.md");
  writeFileSync(path, `---
doc-type: spec
status: active
testable: true
compliance: strict
updated: 2026-10-16
governs: the #426 fixture
---

# Lossless Spec

## Success Criteria

${body}
`);
  return path;
}

beforeEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });
afterEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });

describe("SC-1587: --fix leaves a structured criterion byte-identical", () => {
  test("SC-1469's exact line survives, and an unstructured line beside it is still rewritten", () => {
    const path = writeFixtureSpec(
      `- [ ] SC-1469: ${SC_1469}\n- [ ] SC-9002: ${STRUCTURED_UNMATCHED}\n- [ ] SC-9001: ${UNSTRUCTURED}`,
    );
    const before = readFileSync(path, "utf-8");

    auditSpecs(FIXTURE, { fix: true });
    const after = readFileSync(path, "utf-8");

    expect(
      after.includes(`- [ ] SC-1469: ${SC_1469}`),
      "SC-1469 was rewritten — the file it names or its rationale was dropped",
    ).toBe(true);
    // The guard's own live case: structured, and the matcher still cannot
    // bind it. This is the line that would be truncated if only the registry
    // had been widened.
    expect(
      after.includes(`- [ ] SC-9002: ${STRUCTURED_UNMATCHED}`),
      "a structured criterion the matcher cannot bind was rewritten anyway",
    ).toBe(true);

    // AC-4's other half, and the reason this assertion lives in the SAME test:
    // a fix that simply stopped rewriting anything would satisfy both cases
    // above and leave --fix doing nothing at all.
    expect(after, "nothing was rewritten — --fix has become a no-op").not.toBe(before);
    expect(after).not.toContain(`- [ ] SC-9001: ${UNSTRUCTURED}`);
    expect(after, "the rewrite did not produce the canonical form").toContain(
      "- [ ] SC-9001: CODE-MAP.md exists",
    );
    // And the original survives beside it. `file-exists` is a lossy render
    // by nature — it is kept as the one remaining rewrite path precisely
    // because it writes the statement it replaced into the next line.
    expect(after).toContain(`<!-- REVIEW: original — ${UNSTRUCTURED} -->`);
  });

  test("SC-1588: running --fix twice is a fixed point", () => {
    // The issue's reproduction: run it twice from a clean tree and the second
    // run re-truncates after a `git checkout --`. A rewriter that is not
    // idempotent is editing something it has already decided about.
    const path = writeFixtureSpec(
      `- [ ] SC-1469: ${SC_1469}\n- [ ] SC-9002: ${STRUCTURED_UNMATCHED}\n- [ ] SC-9001: ${UNSTRUCTURED}`,
    );
    auditSpecs(FIXTURE, { fix: true });
    const once = readFileSync(path, "utf-8");
    auditSpecs(FIXTURE, { fix: true });
    expect(readFileSync(path, "utf-8"), "the second --fix changed the file again").toBe(once);
  });
});

describe("SC-1589: the decision about one line, driven directly", () => {
  const CLOSEST = { patternName: "file-exists", rewrite: "ship.js exists", ambiguous: true };

  test("a structured statement is kept, and says why", () => {
    const d = decideRewrite(SC_1469, CLOSEST);
    expect(d.kind).toBe("keep");
    expect(d.kind === "keep" && d.reason).toMatch(/already a structured criterion/);
  });

  test("SC-1590: a rewrite that would drop the file the criterion names is refused", () => {
    // `findClosestPattern`'s last resort collapses anything containing a
    // filename to `<file> exists`, which is an assertion that holds
    // vacuously against a file that obviously exists.
    const d = decideRewrite("gates/orchestrator.ts should be wired up correctly", CLOSEST);
    expect(d.kind).toBe("keep");
    expect(d.kind === "keep" && d.reason).toMatch(/would drop the file gates\/orchestrator\.ts/);
  });

  test("SC-1591: a rewrite that survives carries the rationale across", () => {
    const d = decideRewrite(
      "the project must have a canary test — otherwise the suite proves nothing",
      { patternName: "canary", rewrite: "canary test exists", ambiguous: false },
    );
    expect(d.kind).toBe("rewrite");
    expect(d.kind === "rewrite" && d.statement)
      .toBe("canary test exists — otherwise the suite proves nothing");
  });

  test("SC-1592: a statement with no close pattern is kept rather than invented", () => {
    const d = decideRewrite(UNSTRUCTURED, null);
    expect(d.kind).toBe("keep");
    expect(d.kind === "keep" && d.reason).toMatch(/no registry pattern/);
  });

  test("the structured predicate answers both ways", () => {
    // The positive control for the predicate itself: one that returned true
    // for everything would satisfy every "is kept" case above and turn --fix
    // off entirely.
    expect(alreadyStructured(SC_1469)).toBe(true);
    expect(alreadyStructured("AGENTS.md contains [Project Identity]")).toBe(true);
    expect(alreadyStructured("AGENTS.md is under [200] lines")).toBe(true);
    expect(alreadyStructured(UNSTRUCTURED)).toBe(false);
    // A bracket with no target, and a target with no bracket — neither is
    // the structured grammar, and both were forms the rewriter would reach.
    expect(alreadyStructured("contains [something]")).toBe(false);
    expect(alreadyStructured("AGENTS.md should be tidy")).toBe(false);
  });
});

describe("SC-1593: the absence form binds to a matcher, so the claim is executed", () => {
  test("`not contains` is recognised, alongside the forms that already were", () => {
    // Until #426 this returned null, so SC-1469 generated NO assertion: an
    // absence claim about `workflows/ship.js` that nothing ever checked,
    // while reading in the spec as a criterion.
    for (const statement of [
      SC_1469,
      "AGENTS.md not contains [foo]",
      "AGENTS.md does not contain [foo]",
      "AGENTS.md must NOT contain [deprecated-section]",
      "AGENTS.md has no [foo]",
    ]) {
      expect(
        matchPattern({ id: "SC-1", statement, specFile: "X.md" } as never),
        `unmatched: ${statement.slice(0, 50)}`,
      ).not.toBeNull();
    }
  });

  test("the positive control — prose still binds to nothing", () => {
    for (const statement of [UNSTRUCTURED, "the harness should feel responsive to operate"]) {
      expect(
        matchPattern({ id: "SC-1", statement, specFile: "X.md" } as never),
        `prose bound to a matcher: ${statement}`,
      ).toBeNull();
    }
  });
});

describe("SC-1594: a rewrite is reported, naming the spec and the id", () => {
  test("the audit result distinguishes a rewrite from a line left intact", () => {
    writeFixtureSpec(
      `- [ ] SC-1469: ${SC_1469}\n- [ ] SC-9002: ${STRUCTURED_UNMATCHED}\n- [ ] SC-9001: ${UNSTRUCTURED}`,
    );
    const result = auditSpecs(FIXTURE, { fix: true });

    // SC-1469 is MATCHED now, so it never reaches the rewriter at all —
    // asserted rather than assumed, because "not rewritten" and "never
    // considered" are different states and only one of them means the
    // registry fix landed.
    const spec = result.specs[0]!;
    expect(spec.matchedSCs.map(s => s.id), "SC-1469 is still unmatched").toContain("SC-1469");
    expect((result.rewrites ?? []).map(r => r.scId)).not.toContain("SC-1469");

    const kept = (result.rewrites ?? []).find(r => r.scId === "SC-9002");
    expect(kept, "the structured-but-unmatched line was not reported at all").toBeTruthy();
    expect(kept!.kept, "a kept line is indistinguishable from a rewritten one").toBeTruthy();
    expect(kept!.before).toBe(kept!.after);

    const rewritten = (result.rewrites ?? []).find(r => r.scId === "SC-9001");
    expect(rewritten, "the unstructured line was not reported").toBeTruthy();
    expect(rewritten!.kept, "a real rewrite was reported as kept").toBeUndefined();
  });

  test("SC-1595: the scaffold step names every rewritten criterion in its actions", () => {
    // A spec line edited under a documented command and reported only as a
    // count is the defect, not merely the content that was lost. `before ===
    // after` cannot carry this: it is also what a no-op rewrite looks like.
    const steps = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const fn = steps.slice(steps.indexOf("export function runAuditSpecsFix"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "the step does not name what it rewrote").toContain("REWROTE:");
    expect(body, "the step does not name what it declined to rewrite").toContain("KEPT:");
    expect(body).toContain("r.scId");
    expect(body, "the id is reported without the spec it lives in").toContain("r.specFile");
  });
});

/**
 * The damaged shape: a criterion rendered from a template, so it opens with a
 * bare matcher keyword instead of the target it is about. One binding, used
 * by both the sweep and the case that proves the sweep can see one.
 */
const DAMAGED = /^(?:not\s+contains?|contains?|has\s+no|must\s+NOT\s+contain)\s*\[/i;

describe("SC-1596: the tree carries no line already damaged by this", () => {
  test("no SC in specs/ is a bare pattern that lost its file and its reason", () => {
    // AC-5. The damaged shape is specific: a criterion rendered from a
    // template, so it opens with a bare matcher keyword instead of the
    // target it is about, and carries no prose. Measured over every spec
    // rather than the one the issue names — "SC-1469 is probably not alone"
    // is a claim, and this is how it stops being one.
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
      );
    }
    const damaged: string[] = [];
    let scanned = 0;
    const files = walk(join(ROOT, "specs"));
    for (const file of files) {
      for (const m of readFileSync(file, "utf-8").matchAll(/^- \[[ x]\] (SC-[\w-]+):\s*(.+)$/gm)) {
        scanned++;
        const statement = m[2]!.trim();
        if (DAMAGED.test(statement)) {
          damaged.push(`${file.split("/").pop()} ${m[1]}: ${statement.slice(0, 60)}`);
        }
      }
    }

    // The count control, FIRST. An empty `damaged` is also what a walker
    // reading nothing produces, and a clean sweep over zero files is the
    // "assertions that hold vacuously" shape this repo keeps finding — in
    // the sweep written to prove a claim about the whole tree, which is
    // where it would be least visible.
    expect(files.length, "the walker found no spec files").toBeGreaterThan(20);
    expect(scanned, "the walker found no SC lines to classify").toBeGreaterThan(500);

    expect(damaged, "these criteria name no file — they were rendered from a template").toEqual([]);
  });

  test("the sweep can see a damaged line when there is one", () => {
    // The classifier's own two directions. Paired with the count control
    // above: between them, a clean result means the sweep looked at the
    // tree AND could have reported something.
    expect(DAMAGED.test("not contains [s.environments.prod.rebuild = 'PASS']")).toBe(true);
    expect(DAMAGED.test("contains [Project Identity]")).toBe(true);
    expect(DAMAGED.test(SC_1469)).toBe(false);
    expect(DAMAGED.test("AGENTS.md contains [Project Identity]")).toBe(false);
  });
});

/**
 * The SC statement lines of a spec, keyed by id, with duplicates named (#586).
 *
 * **By id, and not by index.** The defect below DUPLICATES lines, and a
 * positional comparison of two lists of different lengths reports every row
 * after the first as different — true, and useless for saying which criterion
 * was damaged. Duplicates are returned rather than silently collapsed because
 * a `Map` keyed by id would otherwise absorb exactly the evidence.
 *
 * `(.*)$` rather than `(.+)$`, which is what `extractSCs` uses: a statement
 * truncated to the empty string must read as a criterion whose text is gone,
 * not as a line the scanner never saw.
 */
function statementsById(content: string): { byId: Map<string, string>; duplicates: string[] } {
  const byId = new Map<string, string>();
  const duplicates: string[] = [];
  for (const m of content.matchAll(/^- \[[ x]\] (SC-[\w-]+):\s*(.*)$/gm)) {
    const id = m[1]!;
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, m[2]!);
  }
  return { byId, duplicates };
}

/**
 * Covers SC-2000 (CONFIG-DRIVEN-TESTING-SPEC.md), #586 AC-1.
 *
 * SC-1588 above already runs `--fix` twice and compares the whole file, and
 * it is green. It is also the weaker instrument, and this is the input that
 * shows why: `auditSpecs` edits each SC line with
 *
 *   modified.replace(scLinePattern, `${scMatch[0]}\n${marker}`)
 *
 * where the second argument is a REPLACEMENT STRING, so `$'`, `$&` and `$1`
 * inside the criterion are expanded by the regex engine. Measured, before the
 * fix, on a four-criterion fixture:
 *
 *   - [ ] SC-9301: Baseline rules carry no          <- truncated
 *   - [ ] SC-9302: …                                <- the rest of the file,
 *   - [ ] SC-9303: …                                   copied in by `$'`
 *   - [ ] SC-9304: …
 *    key in frontmatter
 *
 * Three ids now appear twice in the document and one criterion has lost its
 * text — under a run that reported `kept: "no registry pattern was close
 * enough"` and `before === after` for all four. **The ledger says nothing was
 * touched and the file disagrees**, which is the whole of #586 arriving by a
 * different route than the one the issue describes.
 *
 * A whole-file comparison of run 1 against run 2 cannot see any of it: the
 * damage is done by the FIRST run and the second reproduces it exactly, so
 * `one === two` is true over a wrecked document. That is this repo's
 * "assertions that hold vacuously" shape, and the AC's own metric — zero SC
 * statement lines differing between the runs — has it too. So the run-1/run-2
 * comparison is kept, because it is what AC-1 asks for, and the original is
 * carried in beside it as the half that can actually fail.
 */
describe("SC-2000: --fix is a fixed point per criterion, not merely per file", () => {
  /** `$'` — "the portion of the input after the match". The destructive one. */
  const DOLLAR_AFTER = "Baseline rules carry no $' key in frontmatter";
  /** `$&` — "the whole match", so the line is pasted into itself. */
  const DOLLAR_MATCH = "Baseline rules carry no $& key in frontmatter";
  /** `$1` — the first capture group, which is the `- [ ] SC-9303: ` prefix. */
  const DOLLAR_GROUP = "Baseline rules carry no $1 key in frontmatter";
  /** The same shape with no `$` in it. The control for the corpus itself. */
  const PLAIN = "Baseline rules carry no `owner:` key in frontmatter";

  test("every criterion's statement survives, no id is duplicated, and the second run changes nothing", () => {
    const path = writeFixtureSpec(
      [
        `- [ ] SC-9301: ${DOLLAR_AFTER}`,
        `- [ ] SC-9302: ${DOLLAR_MATCH}`,
        `- [ ] SC-9303: ${DOLLAR_GROUP}`,
        `- [ ] SC-9304: ${PLAIN}`,
        `- [ ] SC-9305: ${UNSTRUCTURED}`,
      ].join("\n"),
    );
    const before = statementsById(readFileSync(path, "utf-8"));
    expect(before.byId.size, "the fixture did not render five criteria").toBe(5);

    const result = auditSpecs(FIXTURE, { fix: true });
    const one = statementsById(readFileSync(path, "utf-8"));
    auditSpecs(FIXTURE, { fix: true });
    const two = statementsById(readFileSync(path, "utf-8"));

    // The positive control FIRST, and it is the reason this case cannot be
    // satisfied by switching `--fix` off: a rewriter that never touched
    // anything would pass every assertion below.
    expect(one.byId.get("SC-9305"), "--fix rewrote nothing, so the rest of this proves nothing")
      .toBe("CODE-MAP.md exists");

    // A criterion the rewriter DECLINED to rewrite must read back exactly as
    // it was written. This is the half that was red: SC-9301 came back as
    // `Baseline rules carry no ` with the remainder of the document spliced
    // in after it.
    for (const id of ["SC-9301", "SC-9302", "SC-9303", "SC-9304"]) {
      expect(one.byId.get(id), `${id}'s statement was changed by a run that reported keeping it`)
        .toBe(before.byId.get(id));
    }

    // The document still has one line per criterion. `$'` and `$&` both
    // duplicate ids, and a spec carrying two SC-9303 lines is a spec where
    // every downstream reader — the sync, the drift detector, the registry —
    // answers about whichever one it reached first.
    expect(one.duplicates, "the fix run duplicated SC lines into the document").toEqual([]);
    expect(one.byId.size, "the fix run changed how many criteria the spec declares").toBe(5);

    // The ledger and the file have to agree. `before === after` on a `kept`
    // entry is the run's own claim that it left the line alone; without this
    // the claim is checked against nothing.
    for (const r of result.rewrites ?? []) {
      if (!r.kept) continue;
      expect(r.before, `${r.scId} is reported as kept but before !== after`).toBe(r.after);
      expect(
        one.byId.get(r.scId),
        `${r.scId} was reported as kept and the file says otherwise`,
      ).toBe(r.before);
    }

    // AC-1 as worded. Vacuous against the defect above — recorded in the
    // docstring rather than left for a reader to discover — and not vacuous
    // against a rewriter that re-rewrites its own output, which is the other
    // way a `--fix` stops being a fixed point.
    const differing = [...one.byId.keys()].filter(id => one.byId.get(id) !== two.byId.get(id));
    expect(differing, "a second --fix changed criteria the first had already settled").toEqual([]);
    expect(two.duplicates, "the second --fix duplicated SC lines").toEqual([]);
  });
});
