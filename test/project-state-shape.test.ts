/**
 * The renderer crashed instead of refusing, which is the same problem from
 * the other side.
 *
 * `scripts/update-project-state.ts` declares
 * `interface Session { date: string; items: string[] }`, and that interface
 * is erased at runtime: the file is `JSON.parse`d into it and nothing checks.
 * An archived session carrying `summary` instead of `items` produced
 *
 *     TypeError: undefined is not an object (evaluating 'session.items.forEach')
 *       at render (scripts/update-project-state.ts:134:15)
 *
 * and nothing else — no path into the document, no index, no statement of
 * what should have been there. The renderer runs from a pre-commit hook,
 * where a stack trace pointing into a script the committer never opened is
 * close to no message at all.
 *
 * A fail-open reports success it did not earn. This reported a failure
 * nobody could act on. Both leave a reader who cannot tell what happened,
 * and the second is the one that teaches people to re-run and hope.
 *
 * Covers SC-778..779 of HARNESS-STANDARD.md. (Not specs/PROJECT-STATE.md,
 * which `.claude/rules/specs-routing.md` marks non-testable; the renderer is
 * harness tooling and its criteria belong with the rest of it.)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { missingStateVerdict, projectStateViolations, selectRecentSessions } from "../lib/project-state-shape";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "update-project-state.ts");

/** A document the renderer is happy with. */
function good() {
  return {
    updated: "2026-10-12",
    priorities: ["a"],
    phases: [{ name: "Phase 0", scs: [{ id: "SC-1", done: true, what: "a thing" }] }],
    sessions: [{ date: "2026-10-01", items: ["did a thing"] }],
  };
}

describe("#project-state: the shape is checked before the renderer reads it", () => {
  test("a well-formed document has no violations", () => {
    // The control. Without it a validator that rejected everything would
    // satisfy every case below and block every commit.
    expect(projectStateViolations(good())).toEqual([]);
  });

  test("this repo's own project-state.json passes", () => {
    const doc = JSON.parse(readFileSync(join(REPO, "project-state.json"), "utf-8"));
    expect(projectStateViolations(doc)).toEqual([]);
  });

  test("the exact edit that crashed the renderer is named, not thrown", () => {
    const doc = good() as any;
    doc.sessions.push({ date: "2026-10-12", summary: "wrote summary instead of items" });
    const v = projectStateViolations(doc);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("sessions[1].items");
    // The path, and the fix. A message saying only "invalid" costs the same
    // round-trip the stack trace did.
    expect(v[0]).toContain("summary");
    expect(v[0]).toContain("items");
  });

  test("every problem is reported, not just the first", () => {
    // A writer fixing a hand-edited file wants the whole list. Stopping at
    // the first finding turns one bad edit into four round-trips, which is
    // how a validator becomes something people route around.
    const doc = good() as any;
    doc.sessions.push({ date: "", summary: "x" });
    doc.sessions.push({ items: ["y"] });
    doc.phases.push({ scs: [] });
    const v = projectStateViolations(doc);
    expect(v.length).toBeGreaterThanOrEqual(4);
    expect(v.join("\n")).toContain("sessions[1].date");
    expect(v.join("\n")).toContain("sessions[1].items");
    expect(v.join("\n")).toContain("sessions[2].date");
    expect(v.join("\n")).toContain("phases[1].name");
  });

  test("a missing required key is a violation, not a default", () => {
    for (const key of ["updated", "priorities", "phases", "sessions"]) {
      const doc = good() as any;
      delete doc[key];
      expect(projectStateViolations(doc).join("\n"), key).toContain(key);
    }
  });

  test("a non-object document is refused rather than indexed into", () => {
    expect(projectStateViolations(null)[0]).toContain("object");
    expect(projectStateViolations([])[0]).toContain("array");
    expect(projectStateViolations("{}")[0]).toContain("string");
  });

  test("the SC elements are checked, not only that scs is an array", () => {
    // Found by a security review of the first commit. Checking the container
    // and not its contents leaves `sc.id.toUpperCase()` and `sc.done` to
    // crash on `[null]` or `[{}]` — the same unreadable TypeError this whole
    // module replaces, one level deeper. A validator that stops at the
    // container moves the crash rather than removing it.
    const nulled = good() as any;
    nulled.phases[0].scs = [null];
    expect(projectStateViolations(nulled).join("\n")).toContain("phases[0].scs[0]");

    const empty = good() as any;
    empty.phases[0].scs = [{}];
    const v = projectStateViolations(empty).join("\n");
    expect(v).toContain("phases[0].scs[0].id");
    expect(v).toContain("phases[0].scs[0].done");
    expect(v).toContain("phases[0].scs[0].what");
  });

  test("a present session is checked four fields deep, an absent one is fine", () => {
    // `session` is optional and the renderer guards it — but a PRESENT one
    // is dereferenced without a guard, and a half-written session renders
    // "Session undefined (undefined)" into the file the next session reads.
    const doc = good() as any;
    expect(projectStateViolations(doc)).toEqual([]); // absent is fine

    doc.session = { number: "forty", date: "2026-10-12" };
    const v = projectStateViolations(doc).join("\n");
    expect(v).toContain("session.number");
    expect(v).toContain("session.summary");
    expect(v).toContain("session.suite");

    doc.session = { number: 40, date: "d", summary: "s", suite: "x" };
    expect(projectStateViolations(doc)).toEqual([]);
  });

  test("a missing source is told apart from a project that never had one", () => {
    // Also from the review. The script exited 0 with "not found, skipping"
    // for both. For a consumer project that does not use the feature that is
    // right; for this repo, where a pre-commit hook renders the artifact
    // every commit and AGENTS.md tells the next session to read it first, a
    // missing source means the hook quietly stopped maintaining a file
    // people are instructed to trust — and said "skipping" while doing it.
    expect(missingStateVerdict({ jsonExists: true, markdownExists: true }).verdict).toBe("OK");
    expect(missingStateVerdict({ jsonExists: true, markdownExists: false }).verdict).toBe("OK");
    expect(missingStateVerdict({ jsonExists: false, markdownExists: false }).verdict).toBe("SKIP");

    const orphan = missingStateVerdict({ jsonExists: false, markdownExists: true });
    expect(orphan.verdict).toBe("REFUSE");
    expect(orphan.detail).toContain("outlived its source");
  });

  test("a non-string priority is caught", () => {
    // Unglamorous, and it scored 0 red until it had a case: the renderer
    // interpolates each priority straight into a numbered list, so a nested
    // object lands in PROJECT-STATE.md as "[object Object]".
    const doc = good() as any;
    doc.priorities = ["fine", { not: "a string" }];
    expect(projectStateViolations(doc).join("\n")).toContain("priorities[1]");
  });

  test("an items array holding a non-string is caught", () => {
    const doc = good() as any;
    doc.sessions[0].items = ["ok", 42];
    expect(projectStateViolations(doc).join("\n")).toContain("sessions[0].items[1]");
  });

  /**
   * `issues_created` / `issues_closed` reach the renderer's issue-list
   * formatter, which stringifies whatever it is handed. Every shape below
   * rendered silently into the handoff document rather than being refused:
   * a bare string produced one garbled reference `#1675,1676,1680`, and a
   * stray element produced `#null` or `#[object Object]`.
   *
   * Refusing the string here rather than teaching the renderer to split it
   * is deliberate. `parseDeclaredCloses` in
   * `scripts/check-state-record-closes.ts` ALREADY parses this field and
   * already splits strings; a second splitter in the renderer would be two
   * deciders for one question, which is the defect that cost this session
   * its night. One shape reaches the renderer, and anything else is a
   * refusal naming the path. Raised by the AI review of #1684.
   */
  test("an issue list that is not an array of issue numbers is caught", () => {
    for (const [value, expected] of [
      ["1675,1676", "session.issues_created"],
      [null, "session.issues_created"],
      [[1675, null], "session.issues_created[1]"],
      [[1675, { n: 1 }], "session.issues_created[1]"],
      [[1675, "not-a-number"], "session.issues_created[1]"],
    ] as [unknown, string][]) {
      const doc = good() as any;
      doc.session = { number: 1, date: "d", summary: "s", suite: "t", issues_created: value };
      expect(
        projectStateViolations(doc).join("\n"),
        `${JSON.stringify(value)} was accepted`,
      ).toContain(expected);
    }
  });

  /**
   * The negative control. Without it, "refuse an issue list" is satisfiable
   * by refusing every issue list, and the field becomes unusable.
   */
  test("the shapes the DA actually writes are accepted", () => {
    for (const value of [undefined, [], [1675, 1676], ["#1675", "1676"]]) {
      const doc = good() as any;
      doc.session = { number: 1, date: "d", summary: "s", suite: "t" };
      if (value !== undefined) doc.session.issues_closed = value;
      expect(projectStateViolations(doc), JSON.stringify(value)).toEqual([]);
    }
  });
});

describe("#project-state: the script refuses rather than crashing", () => {
  test("the validator is consulted before anything is written", () => {
    // Wiring. The library can be perfect and the script can still parse
    // straight into the renderer — #194's lesson, and #168's.
    const src = readFileSync(SCRIPT, "utf-8");
    const checkAt = src.indexOf("projectStateViolations(parsed)");
    // The CALL, not the import. `src.indexOf("writeFileSync")` finds the
    // import line at the top of the file, which precedes everything and
    // makes this assertion unsatisfiable rather than merely wrong — the kind
    // of mistake that gets "fixed" by loosening the comparison.
    const writes = [...src.matchAll(/writeFileSync\(\s*STATE_(?:MD|JSON)/g)].map(m => m.index!);
    expect(checkAt).toBeGreaterThan(-1);
    expect(writes.length).toBeGreaterThan(0);
    for (const at of writes) expect(checkAt).toBeLessThan(at);
    expect(src).toContain("nothing was written");
  });

  /**
   * Order is not prevention.
   *
   * The case above asserts the validator is consulted before the write, and
   * making the refusal branch unreachable (`if (false)`) scored **0 red** —
   * the check ran first and then the script wrote anyway. So the script is
   * copied somewhere it can be pointed at a bad document and actually run.
   */
  function runScriptOn(state: unknown): { status: number; out: string; wroteMd: boolean } {
    const dir = mkdtempSync(join(tmpdir(), "ps-script-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "specs"));
      symlinkSync(join(REPO, "lib"), join(dir, "lib"));
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
      cpSync(SCRIPT, join(dir, "scripts", "update-project-state.ts"));
      writeFileSync(join(dir, "project-state.json"), JSON.stringify(state));
      const r = spawnSync("bun", [join(dir, "scripts", "update-project-state.ts")], {
        cwd: dir,
        encoding: "utf-8",
      });
      return {
        status: r.status ?? 1,
        out: (r.stdout ?? "") + (r.stderr ?? ""),
        wroteMd: existsSync(join(dir, "PROJECT-STATE.md")),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a malformed document exits non-zero and writes no markdown at all", () => {
    const bad = good() as any;
    bad.sessions.push({ date: "2026-10-12", summary: "the edit that crashed it" });
    const r = runScriptOn(bad);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("sessions[1].items");
    expect(r.out).toContain("nothing was written");
    // The assertion the ordering check could not make.
    expect(r.wroteMd).toBe(false);
  });

  test("a well-formed document is written — the control", () => {
    // Without this, refusing unconditionally would satisfy the case above
    // and the renderer would never produce anything again.
    const r = runScriptOn(good());
    expect(r.status, r.out).toBe(0);
    expect(r.wroteMd).toBe(true);
  });

  test("a PROJECT-STATE.md with no source refuses; neither file present just skips", () => {
    // The script-level half of the missing-source verdict. Without it, the
    // script could ignore the verdict entirely — measured, that scored 0 red
    // with every library case still green. #194's lesson again.
    function scriptIn(files: Record<string, string>): { status: number; out: string } {
      const dir = mkdtempSync(join(tmpdir(), "ps-missing-"));
      try {
        mkdirSync(join(dir, "scripts"));
        mkdirSync(join(dir, "specs"));
        symlinkSync(join(REPO, "lib"), join(dir, "lib"));
        symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
        cpSync(SCRIPT, join(dir, "scripts", "update-project-state.ts"));
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
        const r = spawnSync("bun", [join(dir, "scripts", "update-project-state.ts")], { cwd: dir, encoding: "utf-8" });
        return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const orphan = scriptIn({ "PROJECT-STATE.md": "# stale\n" });
    expect(orphan.status).not.toBe(0);
    expect(orphan.out).toContain("outlived its source");

    // A project that simply does not use the feature is not an error, and
    // saying so is the control: refusing both ways would break every
    // consumer repo's pre-commit hook.
    const neither = scriptIn({});
    expect(neither.status, neither.out).toBe(0);
  });

  test("invalid JSON refuses rather than throwing a parse trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-script-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "specs"));
      symlinkSync(join(REPO, "lib"), join(dir, "lib"));
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
      cpSync(SCRIPT, join(dir, "scripts", "update-project-state.ts"));
      writeFileSync(join(dir, "project-state.json"), "{ not json");
      const r = spawnSync("bun", [join(dir, "scripts", "update-project-state.ts")], { cwd: dir, encoding: "utf-8" });
      expect(r.status).not.toBe(0);
      expect((r.stdout ?? "") + (r.stderr ?? "")).toContain("not valid JSON");
      expect(existsSync(join(dir, "PROJECT-STATE.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every refusal routes through one exported exit constant", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // One declaration, and no bare `process.exit(1)` alongside it — a second
    // refusal path would survive a mutation of the constant and the mutant
    // would stay red for a reason unrelated to the mutation working.
    expect(src.match(/export const PROJECT_STATE_REFUSE_EXIT = \d+/g)!.length).toBe(1);
    // Derived, not pinned: every non-zero exit must be the constant. Pinning
    // the count means adding a refusal breaks this test for the wrong
    // reason, and the natural repair is to raise the number — which is how
    // a bare `process.exit(1)` gets waved through.
    const allExits = src.match(/process\.exit\([^)]*\)/g) ?? [];
    const nonZero = allExits.filter(e => e !== "process.exit(0)");
    expect(nonZero.length).toBeGreaterThan(0);
    for (const e of nonZero) expect(e).toBe("process.exit(PROJECT_STATE_REFUSE_EXIT)");
  });
});

/**
 * #1517 / AC-1..AC-3: two sessions on one calendar day rendered oldest-first.
 *
 * `selectRecentSessions` keyed its sort on the ISO date alone, so same-day
 * entries tied, and the tie-break read `b.i - a.i` — later array index first.
 * `main` rendered `session 61` above `session 62`.
 *
 * Nothing named this function before #1517, which is the point: the direction
 * had never been asserted in either direction, and #572's own criterion —
 * SC-1961, "the position in the array decides nothing" — varies array order
 * across three entries that never tie, so no row in that battery can come back
 * wrong about a tie. The cases below hold the data fixed and vary position,
 * which is the axis SC-1961 holds fixed.
 *
 * Every tied case here is red under BOTH index directions, by construction:
 * `a.i - b.i` is the cheapest repair and it is a wrong one (see the comment on
 * `selectRecentSessions`), so a case it satisfies would certify it.
 */
describe("#1517: same-day sessions render newest-first, and position decides nothing", () => {
  /** Mirrors a live `project-state.json` entry: `<ISO date> session <n>[ prose]`. */
  const s = (date: string) => ({ date, items: ["x"] });
  const dates = (sel: { rendered: { date: string }[] }) => sel.rendered.map(r => r.date);

  test("AC-2 control: distinct dates still render newest-first", () => {
    // The date comparison was never the defect. A fix that reverses the whole
    // comparator to repair the tied case turns this red — which is the point
    // of keeping it beside the tied cases rather than trusting SC-1961 to
    // catch it from another file.
    expect(dates(selectRecentSessions([s("2026-10-01 session 1"), s("2026-10-17 session 2")], 3))).toEqual([
      "2026-10-17 session 2",
      "2026-10-01 session 1",
    ]);
  });

  test("AC-1: two sessions on one day render newest-first — the live `main` reading", () => {
    // Exactly what origin/main held at edb12c93: sessions 62 and 61, both
    // 2026-10-24, newest written to the front. main rendered 61 then 62.
    expect(dates(selectRecentSessions([s("2026-10-24 session 62"), s("2026-10-24 session 61")], 3))).toEqual([
      "2026-10-24 session 62",
      "2026-10-24 session 61",
    ]);
  });

  test("AC-1: the same two entries render identically when the array is reversed", () => {
    // The other half of the pair. Whichever index direction a comparator
    // picks, one of these two cases is red — so no index-only tie-break can
    // make this block green, and `a.i - b.i` cannot be mistaken for the fix.
    expect(dates(selectRecentSessions([s("2026-10-24 session 61"), s("2026-10-24 session 62")], 3))).toEqual([
      "2026-10-24 session 62",
      "2026-10-24 session 61",
    ]);
  });

  test("AC-1: a same-day group whose array order is neither ascending nor descending", () => {
    // Not hypothetical. On 2026-10-23 the live file holds sessions 60, 58 and
    // 59 at indices 2, 49 and 50 — the array is newest-first at its head and
    // append-ordered from index 26 on, so it has no single direction. One
    // case, red under both `b.i - a.i` and `a.i - b.i`, because no function
    // of the index alone can order this group.
    const sel = selectRecentSessions(
      [s("2026-10-23 session 60"), s("2026-10-23 session 58"), s("2026-10-23 session 59")],
      3,
    );
    expect(dates(sel)).toEqual(["2026-10-23 session 60", "2026-10-23 session 59", "2026-10-23 session 58"]);
  });

  test("AC-1: the limit still bites, and it keeps the newest of a tied group", () => {
    // A tie that straddles the cut: ordering the group wrongly does not just
    // reorder the output, it renders the wrong session and drops the newest.
    const sel = selectRecentSessions(
      [s("2026-10-24 session 61"), s("2026-10-24 session 62"), s("2026-10-23 session 60")],
      2,
    );
    expect(dates(sel)).toEqual(["2026-10-24 session 62", "2026-10-24 session 61"]);
  });

  test("AC-3: a dated entry with no session number ranks below numbered ones on its day", () => {
    // `2026-10-06 AFK pipeline-readiness run` is live at index 12 and is the
    // one entry of 51 carrying no parseable number. It is DATED, so it is
    // ordered and must not be reported as undated — the two states are
    // different and only one of them is a gap in the data.
    const sel = selectRecentSessions(
      [s("2026-10-06 AFK pipeline-readiness run"), s("2026-10-06 session 34"), s("2026-10-06 session 33")],
      3,
    );
    expect(dates(sel)).toEqual([
      "2026-10-06 session 34",
      "2026-10-06 session 33",
      "2026-10-06 AFK pipeline-readiness run",
    ]);
    expect(sel.undated).toEqual([]);
  });

  test("AC-3: an undated entry still ranks below every dated one, however old, and is named", () => {
    // The branch the comparator's own comment justifies: `""` is less than any
    // ISO date, so no second branch is needed. Adding a second sort tier moves
    // this path, so it is asserted rather than re-reasoned — and written FIRST
    // in the array, the position that would promote it under a stable sort.
    const undatedEntry = s("no date at all, session 99");
    const sel = selectRecentSessions([undatedEntry, s("2024-01-01 session 1")], 3);
    expect(dates(sel)).toEqual(["2024-01-01 session 1", "no date at all, session 99"]);
    expect(sel.undated).toEqual([undatedEntry]);
  });

  test("AC-3: two undated entries are both reported, later index first", () => {
    // Two entries that tie on every tier, so the third falls through to the
    // ORIGINAL tie-break — unchanged, because where the data says nothing it
    // was never wrong. Asserted in the direction the project already relies
    // on: `sessions capped at 3, newest first` in update-project-state.test.ts
    // renders five undated `Day N` entries and requires Day 5 to lead.
    const first = s("undated one");
    const second = s("undated two");
    const sel = selectRecentSessions([first, second, s("2024-01-01 session 1")], 3);
    expect(dates(sel)).toEqual(["2024-01-01 session 1", "undated two", "undated one"]);
    expect(sel.undated, "both are named, in the order they were written").toEqual([first, second]);
  });
});
