/**
 * #1135 — every fixture below used to be written into the real checkout.
 *
 * `ROOT` was `join(import.meta.dir, "..")`, so `writeTestJson` replaced the
 * live `project-state.json`, the renderer rewrote the live
 * `PROJECT-STATE.md`, one case deleted `project-state.json` outright, and
 * `afterAll` put everything back. Measured, that left the two DA-owned
 * records in 36 distinct states across a single run — one of them ABSENT —
 * and for 48.4% of the run a concurrent reader got a document it could not
 * use. `test/project-state-currency.test.ts` and `test/closing-keywords.test.ts`
 * are deliberately pointed at those live files, and several agents share this
 * checkout.
 *
 * Restoring in `afterAll` is not a fix: the window stays open for the whole
 * run and the originals are lost on a crash. So the fixtures moved to a temp
 * root instead, via the seam `test/project-state-shape.test.ts` already
 * drives — see `test/helpers/project-state-temp-root.ts`.
 *
 * A side effect worth naming: `specs/` in the temp root is EMPTY, so SC
 * promotion is now exactly what each test puts there. Against the real tree
 * these cases were also scanning several hundred committed SC checkboxes,
 * which is where the "21 flips" in the filed issue came from — flips of
 * `"done": false` inside `project-state.json`, not edits to any spec.
 *
 * Guarded by `test/project-state-suite-isolation.test.ts`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { makeProjectStateTempRoot, type ProjectStateTempRoot } from "./helpers/project-state-temp-root";

/** The real checkout. Read-only here: used to assert the script is shipped. */
const REPO = join(import.meta.dir, "..");

let tmp: ProjectStateTempRoot;
let ROOT: string;
let STATE_JSON: string;
let STATE_MD: string;
let SPECS_DIR: string;

describe("update-project-state", () => {
  beforeAll(() => {
    tmp = makeProjectStateTempRoot("ps-update-");
    ROOT = tmp.root;
    STATE_JSON = join(ROOT, "project-state.json");
    STATE_MD = join(ROOT, "PROJECT-STATE.md");
    SPECS_DIR = tmp.specs;
  });

  afterAll(() => {
    tmp?.cleanup();
  });

  function writeTestJson(state: any) {
    writeFileSync(STATE_JSON, JSON.stringify(state, null, 2));
  }

  /**
   * Run the copied script. No shell: the root is an `mkdtemp` path and an
   * argument array keeps it one argument whatever characters it contains.
   */
  function exec(timeout = 10000): { status: number; out: string } {
    const r = spawnSync("bun", [tmp.script], { cwd: ROOT, encoding: "utf-8", timeout });
    return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  function run() {
    const r = exec();
    // The old `execSync` threw on a non-zero exit, so a script that started
    // refusing would have failed loudly. `spawnSync` does not, so say it.
    expect(r.status, `the renderer exited ${r.status}:\n${r.out}`).toBe(0);
    return readFileSync(STATE_MD, "utf-8");
  }

  test("script exists", () => {
    // The shipped one, not the copy — a test that only ever checked its own
    // scratch copy would stay green after the script was deleted.
    expect(existsSync(join(REPO, "scripts/update-project-state.ts"))).toBe(true);
  });

  test("runs fast (under 2s)", () => {
    // Seeded, because the timing is of a run that RENDERS. Against the real
    // checkout this inherited whatever document happened to be committed; in
    // an empty root the script correctly skips, and timing a skip would make
    // this the fastest test in the file and measure nothing.
    writeTestJson({
      updated: "2026-01-01",
      priorities: ["Do the thing"],
      phases: [{ name: "Phase 0", scs: [{ id: "SC-9441", what: "A", done: true }] }],
      sessions: [{ date: "2026-10-17 session 48", items: ["x"] }],
    });
    const start = Date.now();
    run();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("generates markdown from JSON", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: ["Do the thing"],
      phases: [{ name: "Phase 0 — Test", scs: [
        { id: "SC-9441", what: "Test SC", done: true }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("# Project State");
    expect(md).toContain("| ✅ | SC-9441 | Test SC |");
    expect(md).toContain("Do the thing");
  });

  test("phase emoji: all done = ✅", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0 — Done", scs: [
        { id: "SC-9441", what: "A", done: true },
        { id: "SC-9442", what: "B", done: true }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## ✅ Phase 0 — Done (COMPLETE)");
  });

  test("phase emoji: some done = 🔄", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0 — Mixed", scs: [
        { id: "SC-9441", what: "A", done: true },
        { id: "SC-9442", what: "B", done: false }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## 🔄 Phase 0 — Mixed (IN PROGRESS)");
  });

  test("phase emoji: none done = ⬜", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 1 — Empty", scs: [
        { id: "SC-9441", what: "A", done: false }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## ⬜ Phase 1 — Empty (NOT STARTED)");
  });

  test("current phase = first phase with open SCs", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [
        { name: "Phase 0 — Done", scs: [{ id: "SC-9441", what: "A", done: true }] },
        { name: "Phase 1 — Next", scs: [
          { id: "SC-9442", what: "B", done: false },
          { id: "SC-9443", what: "C", done: false }
        ]}
      ],
      sessions: []
    });
    const md = run();
    expect(md).toContain("**Current phase: Phase 1 — Next — 2 SCs open**");
  });

  /**
   * The headline and the phase sections must agree about what "complete"
   * means, because they are two readings of one question.
   *
   * `render`'s `current` had its own: the first phase with an open SC. A
   * phase carrying no SCs at all — the shape every planning phase has before
   * its criteria are bound — is invisible to it, so the document opened with
   * "All phases complete" while a section further down read "NOT STARTED"
   * with a note saying 30 engineering items remain. That is the file
   * AGENTS.md tells every session to read first, and its first line was
   * false. Raised by the AI review of #1684.
   */
  test("the headline does not say complete while a phase section says otherwise", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [
        { name: "Phase 0 — Done", scs: [{ id: "SC-9441", what: "A", done: true }] },
        { name: "Phase 1 — Unbound", scs: [], note: "IN PROGRESS — 9 of 56 criteria bound" },
      ],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## 🔄 Phase 1 — Unbound (IN PROGRESS)");
    expect(md, "the headline claims completion the section below contradicts").not.toContain(
      "All phases complete",
    );
    expect(md).toContain("**Current phase: Phase 1 — Unbound — IN PROGRESS**");
  });

  /**
   * The negative control for the case above. Without it, "never say All
   * phases complete" is satisfiable by deleting the string, and the headline
   * would be wrong in the other direction on a genuinely finished project.
   */
  /**
   * `"incomplete".includes("complete")` is TRUE.
   *
   * An SC-less phase's status was inferred by testing whether its note
   * contained the substring "complete" anywhere, so a note reading
   * `Status: incomplete, 9 of 56 criteria bound` rendered `✅ (COMPLETE)` —
   * and once the headline was derived from the same reading, it skipped the
   * phase and printed "All phases complete" above a section describing
   * unfinished work. The same contradiction the headline fix removed,
   * arriving by a different route. Raised by the AI review of #1684.
   *
   * Every note in this repo's own state begins with its status word —
   * `COMPLETE — 25 SCs`, `IN PROGRESS 2026-10-23`, `P0 PRIORITY`, `SHIPPED` —
   * so the leading token is read and nothing else is. A note reading
   * "completed" is therefore NOT credited, which is the direction this is
   * allowed to be wrong in: an uncredited phase costs one word in a note,
   * and the other direction puts a false headline on the handoff document.
   */
  test.each([
    // A note that does not say complete is somebody writing about work in
    // flight — IN PROGRESS, never NOT STARTED. Only an ABSENT note means
    // nothing is known, and that is the third row's whole point.
    ["Status: incomplete, 9 of 56 criteria bound", "\u{1F504}", "IN PROGRESS"],
    ["not complete yet", "\u{1F504}", "IN PROGRESS"],
    ["IN PROGRESS — nowhere near complete", "\u{1F504}", "IN PROGRESS"],
    [undefined, "\u2B1C", "NOT STARTED"],
    ["", "\u2B1C", "NOT STARTED"],
    ["COMPLETE — 25 SCs, all done", "\u2705", "COMPLETE"],
    ["complete", "\u2705", "COMPLETE"],
  ])("a note reading %j is %s", (note, emoji, status) => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase X", scs: [], ...(note === undefined ? {} : { note }) }],
      sessions: []
    });
    expect(run()).toContain(`## ${emoji} Phase X (${status})`);
  });

  test("the headline still reads complete when every phase is", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [
        { name: "Phase 0 — Done", scs: [{ id: "SC-9441", what: "A", done: true }] },
        { name: "Phase 1 — Also done", scs: [], note: "complete" },
      ],
      sessions: []
    });
    expect(run()).toContain("**Current phase: All phases complete**");
  });

  /**
   * `issues_created` is declared `string` and the DA has always written an
   * array of numbers, so `render` interpolated it through
   * `Array.prototype.toString` and produced a bare `1675,1676,1680` where
   * every other issue reference in the same document reads `#1675`.
   *
   * The second half is the one the review did not name and is the worse of
   * the two: `[]` is TRUTHY, so a session that closed nothing rendered the
   * label `Issues closed:` with nothing after it — byte-identical to a
   * session that never recorded the field. *Silent Default Substitution*,
   * in the handoff document (`.claude/rules/config-access.md`). Raised by
   * the AI review of #1684.
   */
  test("issue lists render as issue references, and an empty one is omitted rather than left blank", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [{ id: "SC-9441", what: "A", done: true }] }],
      session: { number: 1, date: "2026-01-01", summary: "s", suite: "t", issues_created: [1675, 1680], issues_closed: [] },
      sessions: []
    });
    const md = run();
    expect(md).toContain("Issues opened: #1675, #1680");
    // The premise: without the formatting there really would be a bare list.
    expect(md, "the raw Array.toString form survived").not.toContain("Issues opened: 1675,1680");
    expect(md, "an empty list rendered a label with nothing after it").not.toContain("Issues closed:");
  });

  /**
   * A field that was never written renders nothing — not `#undefined`.
   *
   * Absent and empty reach `issueList` by different routes and the first
   * mutation battery had no case for the first, so `v === undefined` could
   * be changed to `v === null` and stay green while the document grew a
   * line reading `Issues opened: #undefined`.
   */
  test("a session with no issue fields renders no issue lines", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [{ id: "SC-9441", what: "A", done: true }] }],
      session: { number: 1, date: "2026-01-01", summary: "s", suite: "t" },
      sessions: []
    });
    const md = run();
    expect(md).not.toContain("Issues opened:");
    expect(md).not.toContain("Issues closed:");
    expect(md, "an absent field rendered as the string undefined").not.toContain("undefined");
  });

  /** The control: a NON-empty closed list must still render. */
  test("a session that closed something still says so", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [{ id: "SC-9441", what: "A", done: true }] }],
      session: { number: 1, date: "2026-01-01", summary: "s", suite: "t", issues_closed: [1676] },
      sessions: []
    });
    expect(run()).toContain("Issues closed: #1676");
  });

  test("promote-only: spec [x] promotes SC, spec [ ] does not demote", () => {
    writeFileSync(join(SPECS_DIR, "test-promote.md"), `- [x] SC-9441: promoted\n- [ ] SC-9442: still open in spec`);
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [
        { id: "SC-9441", what: "Should promote", done: false },
        { id: "SC-9442", what: "Should stay done", done: true }
      ]}],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    const scs = json.phases[0].scs;
    expect(scs.find((s: any) => s.id === "SC-9441").done).toBe(true);
    expect(scs.find((s: any) => s.id === "SC-9442").done).toBe(true);
    rmSync(join(SPECS_DIR, "test-promote.md"));
  });

  test("is idempotent", () => {
    const first = run();
    const second = run();
    expect(first).toBe(second);
  });

  // Was "sessions capped at 3" asserting Day 1 and Day 3 present and Day 4
  // absent — the three OLDEST. That is the behaviour that made PROJECT-STATE.md
  // show ancient history while every appended session stayed invisible, and the
  // test locked it in. Inverted rather than deleted: the cap is still 3, but it
  // must be the three most recent, because this file is the session handoff
  // AGENTS.md tells the next session to read first.
  test("sessions capped at 3, newest first", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [],
      sessions: [
        { date: "Day 1", items: ["a"] },
        { date: "Day 2", items: ["b"] },
        { date: "Day 3", items: ["c"] },
        { date: "Day 4", items: ["d"] },
        { date: "Day 5", items: ["e"] }
      ]
    });
    const md = run();
    expect(md).toContain("Day 5");
    expect(md).toContain("Day 4");
    expect(md).toContain("Day 3");
    expect(md).not.toContain("Day 2");
    expect(md).not.toContain("Day 1");
    // Newest must lead, not merely be present.
    expect(md.indexOf("Day 5")).toBeLessThan(md.indexOf("Day 3"));
  });

  test("updates SC count in notes after sync", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      notes: "Session 11 — stuff happened.\nSuite: 1264 pass, 0 fail. 28/56 SCs done.\nMore stuff.",
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-9441", what: "A", done: true },
          { id: "SC-9442", what: "B", done: true },
          { id: "SC-9443", what: "C", done: false }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    // After sync, notes should say 2/3 SCs done (two done out of three)
    expect(json.notes).toContain("2/3 SCs done");
    expect(json.notes).not.toContain("28/56 SCs done");
    // Preserve surrounding text
    expect(json.notes).toContain("Session 11");
    expect(json.notes).toContain("More stuff.");
  });

  test("appends SC count to notes when no pattern exists", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      notes: "Session 11 — no counts here.",
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-9441", what: "A", done: true },
          { id: "SC-9442", what: "B", done: false }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    expect(json.notes).toContain("Suite:");
    expect(json.notes).toContain("1/2 SCs done");
    // Original text preserved
    expect(json.notes).toContain("Session 11 — no counts here.");
  });

  test("appends SC count when notes field is absent", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-9441", what: "A", done: true }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    expect(json.notes).toContain("Suite:");
    expect(json.notes).toContain("1/1 SCs done");
  });

  test("refuses when project-state.json is missing but PROJECT-STATE.md is not (#354)", () => {
    // This used to assert a clean exit and the words "not found", which was
    // the behaviour #354 changed. A project with no state file and a project
    // that LOST one exited 0 with the same line — and in this repo, where a
    // pre-commit hook renders the artifact every commit and AGENTS.md tells
    // the next session to read it first, the second case meant the hook had
    // quietly stopped maintaining a file people are told to trust, while
    // saying "skipping".
    //
    // The distinction is the presence of the rendered output, so deleting
    // the source here — with PROJECT-STATE.md still on disk — is now the
    // refusing case. The skip case has no markdown either, and is covered in
    // test/project-state-shape.test.ts against a temp directory.
    //
    // #1135: this delete used to land on the checkout's own
    // `project-state.json`, which is where the ABSENT readings came from. It
    // is the temp root's copy now, so no backup is needed — but the file is
    // rebuilt anyway, because later tests in this describe share the root.
    //
    // The refusal needs PROJECT-STATE.md PRESENT and its source gone, so the
    // markdown is rendered here rather than inherited from whichever test ran
    // last — order-dependence is how this case would quietly stop testing
    // the refusal and start testing the skip.
    writeTestJson({ updated: "2026-01-01", priorities: [], phases: [], sessions: [] });
    run();
    expect(existsSync(STATE_MD)).toBe(true);
    const backup = readFileSync(STATE_JSON, "utf-8");
    rmSync(STATE_JSON);
    try {
      const r = exec(5000);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("outlived its source");
    } finally {
      writeFileSync(STATE_JSON, backup);
    }
  });

  // ── #572: the handoff shows the newest sessions, wherever they were written ──

  /**
   * Every fixture here plants the newest entry at `sessions[0]`, which is
   * where the DA actually wrote session 48 and where the old renderer could
   * not see it. A fixture that appends instead passes under the bug, which
   * is the whole reason this one does not.
   */
  function withSessions(sessions: Array<{ date: string; items: string[] }>) {
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions,
    });
    return run();
  }

  test("SC-1960: the newest session is rendered from the FRONT of the array", () => {
    const md = withSessions([
      { date: "2026-10-17 session 48", items: ["the newest, written first in the array"] },
      { date: "2026-10-01 session 40", items: ["older"] },
      { date: "2026-10-02 session 41", items: ["older still, but later in the array"] },
    ]);
    expect(md, "the newest session did not reach the handoff").toContain("the newest, written first in the array");

    // And it is FIRST, because the file is read top-down by the next
    // session and a correct entry buried under two older ones is the same
    // failure one step smaller.
    expect(md.indexOf("session 48")).toBeLessThan(md.indexOf("session 41"));
    expect(md.indexOf("session 41")).toBeLessThan(md.indexOf("session 40"));
  });

  test("SC-1961: the position in the array decides nothing", () => {
    // The same three entries in three orders must render identically. The
    // old renderer gives three different answers, and only one of them is
    // right — which is what "it just trusted a position" means.
    const entries = [
      { date: "2026-10-17 newest", items: ["c"] },
      { date: "2026-10-02 middle", items: ["b"] },
      { date: "2026-10-01 oldest", items: ["a"] },
    ];
    const a = withSessions([entries[0]!, entries[1]!, entries[2]!]);
    const b = withSessions([entries[2]!, entries[1]!, entries[0]!]);
    const c = withSessions([entries[1]!, entries[0]!, entries[2]!]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // …and the agreement is not three empty renders.
    expect(a).toContain("newest");
  });

  test("SC-1962: a fourth, older session is dropped and an undated one is named", () => {
    const md = withSessions([
      { date: "2026-10-17 d", items: ["d"] },
      { date: "2026-10-16 c", items: ["c"] },
      { date: "2026-10-15 b", items: ["b"] },
      { date: "2026-10-14 a", items: ["a"] },
    ]);
    expect(md).toContain("2026-10-15 b");
    expect(md, "the fourth-newest session was rendered, so the limit does nothing").not.toContain("2026-10-14 a");

    // An entry with no ISO date cannot be ordered, so it is never rendered.
    // Silence would make it indistinguishable from one that is merely old,
    // so the run says so by name.
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions: [
        { date: "someday", items: ["unorderable"] },
        { date: "2026-10-17 d", items: ["d"] },
      ],
    });
    const { status, out } = exec();
    expect(status, out).toBe(0);
    expect(out, "an unorderable entry was ranked without saying so").toContain("someday");
    expect(out).toContain("no ISO date");

    // Ranked below the dated entry, NOT dropped. A project whose dates are
    // all free-form must still get a handoff — excluding them would mean
    // fixing this bug by producing an empty file, which is worse than the
    // bug. Its position is the only thing that changes.
    const md2 = readFileSync(STATE_MD, "utf-8");
    expect(md2).toContain("unorderable");
    expect(md2.indexOf("2026-10-17 d")).toBeLessThan(md2.indexOf("someday"));
  });

  test("SC-1963: the run names the sessions it rendered, not just that it wrote", () => {
    // `rewrote PROJECT-STATE.md` was true on every run that dropped session
    // 48. A reader who sees yesterday's date in this line knows at once.
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions: [{ date: "2026-10-17 session 48", items: ["x"] }],
    });
    const { status, out } = exec();
    expect(status, out).toBe(0);
    expect(out).toContain("rendered 1 of 1 session(s)");
    expect(out, "the summary does not say which session reached the file").toContain("2026-10-17");
  });
});
