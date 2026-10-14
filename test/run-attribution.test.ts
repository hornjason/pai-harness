/**
 * Covers SC-873, SC-874, SC-875, SC-876 (HARNESS-STANDARD.md).
 *
 * #288 — a run's artefacts are not attributable to it.
 *
 * `WORK_DIR` is `~/.rungate/<slug>/` and the slug is repo + issue number, so
 * every run of one issue writes into one directory. Nothing clears it and
 * nothing stamps it. After a failed run the directory holds a complete,
 * plausible, WRONG set of artefacts — `rook-findings.json`, `rook-scope.json`,
 * `worktree-groups.json`, `marcus-brief.md` — and a reader has no way to tell.
 *
 * Measured, the hard way: `~/.rungate/pai-harness-254/workflow-state.json`
 * was read while a fresh #254 run was in flight. It showed `phase: VERIFY`,
 * 6 ACs and a populated `rook-findings.json`. The run was actually at `setup`,
 * three agents in; everything read was the previous night's failed run. A
 * healthy run was cancelled on that misreading.
 *
 * Within a run this was already thought about — `workflows/ship.js` suffixes
 * a re-review's findings file `-r<N>` precisely so "a second review cannot
 * read the first one's findings file and report them as its own". The same
 * reasoning stops at the run boundary.
 *
 * ## No new write sites
 *
 * Disposition is derived from what the system already writes: the marker, the
 * run id in the state file, the state's own `updatedTs` heartbeat, and the
 * ship gate's verdict. A design needing 45 `endRun()` calls at 45 return
 * points would be wrong by the time the next return point was added.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ARCHIVE_PREFIX,
  RUN_MARKER_FILE,
  beginRun,
  newRunId,
  readRunMarker,
  runDisposition,
  staleArtefacts,
} from "../gates/run-attribution";
import { initWorkflow } from "../gates/orchestrator";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "rungate-288-"));
}

/** The artefact set the issue lists, as a dead run would leave it. */
const DEAD_RUN_ARTEFACTS = {
  "rook-findings.json": '{"findings":["command injection in x.ts"]}',
  "rook-scope.json": '{"files":["x.ts"]}',
  "worktree-groups.json": '{"groups":[]}',
  "marcus-brief.md": "# brief from last night\n",
  "canaries.json": "{}",
};

function plantDeadRun(d: string): void {
  for (const [name, body] of Object.entries(DEAD_RUN_ARTEFACTS)) {
    writeFileSync(join(d, name), body);
  }
  writeFileSync(join(d, "workflow-state.json"), JSON.stringify({ phase: "VERIFY", acs: [1, 2, 3, 4, 5, 6] }));
}

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("#288 SC-873: a run id exists and is unique", () => {
  test("two ids from the same millisecond differ", () => {
    // A timestamp-only id collides for exactly the runs this has to tell
    // apart: a failed run and its immediate re-run.
    const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
    expect(ids.size).toBe(200);
  });

  test("it is filesystem-safe — it becomes a directory name", () => {
    for (let i = 0; i < 50; i++) expect(newRunId()).toMatch(/^run_[A-Za-z0-9_-]+$/);
  });
});

describe("#288 SC-874: beginRun stamps the directory and clears what it is not", () => {
  test("a fresh directory gets a marker naming this run", () => {
    const d = dir();
    const marker = beginRun(d, { issue: 288, slug: "pai-harness-288" });
    expect(marker.runId).toMatch(/^run_/);
    expect(marker.issue).toBe(288);
    expect(readRunMarker(d)).toEqual(marker);
    expect(existsSync(join(d, RUN_MARKER_FILE))).toBe(true);
  });

  test("the measured case: a previous run's artefacts do not stay readable in place", () => {
    const d = dir();
    plantDeadRun(d);
    const first = beginRun(d, { issue: 288, slug: "s" });
    const second = beginRun(d, { issue: 288, slug: "s" });

    expect(second.runId, "the re-run reused the dead run's id").not.toBe(first.runId);
    for (const name of Object.keys(DEAD_RUN_ARTEFACTS)) {
      expect(
        existsSync(join(d, name)),
        `${name} from the previous run is still sitting where a reader will find it`,
      ).toBe(false);
    }
  });

  test("they are ARCHIVED, not deleted — the work may be the only copy", () => {
    // `scripts/preserve-worktree-work.ts` exists because output a run refused
    // to collect is still output. Deleting it to make attribution work would
    // trade one data-loss bug for another.
    const d = dir();
    const first = beginRun(d, { issue: 288, slug: "s" });
    plantDeadRun(d);
    beginRun(d, { issue: 288, slug: "s" });

    const archive = join(d, `${ARCHIVE_PREFIX}${first.runId}`);
    expect(existsSync(archive), "the previous run's artefacts were destroyed").toBe(true);
    expect(readFileSync(join(archive, "rook-findings.json"), "utf-8")).toContain("command injection");
    expect(readFileSync(join(archive, "marcus-brief.md"), "utf-8")).toContain("last night");
  });

  test("the archive is named for the run that wrote the files, not the one archiving them", () => {
    const d = dir();
    const first = beginRun(d, { issue: 288, slug: "s" });
    plantDeadRun(d);
    const second = beginRun(d, { issue: 288, slug: "s" });
    expect(existsSync(join(d, `${ARCHIVE_PREFIX}${first.runId}`))).toBe(true);
    expect(existsSync(join(d, `${ARCHIVE_PREFIX}${second.runId}`))).toBe(false);
  });

  test("archives are not re-archived, so a tenth run does not nest nine deep", () => {
    const d = dir();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      plantDeadRun(d);
      ids.push(beginRun(d, { issue: 288, slug: "s" }).runId);
    }
    const archives = readdirSync(d).filter(n => n.startsWith(ARCHIVE_PREFIX));
    // Four: one per sweep. The first is named with a minted id because the
    // files it swept had no marker to attribute them to; the other three
    // carry the id of the run that actually wrote them.
    expect(archives.length, "archives were swept into each other").toBe(4);
    for (const id of ids.slice(0, 3)) expect(archives).toContain(`${ARCHIVE_PREFIX}${id}`);
    expect(archives, "the last run archived itself").not.toContain(`${ARCHIVE_PREFIX}${ids[3]}`);
  });

  test("an unreadable previous marker still archives — the files are still not ours", () => {
    // Fails closed toward attribution. A marker nobody can parse is not
    // evidence that the artefacts beside it belong to this run.
    const d = dir();
    plantDeadRun(d);
    writeFileSync(join(d, RUN_MARKER_FILE), "{ not json");
    beginRun(d, { issue: 288, slug: "s" });
    expect(existsSync(join(d, "rook-findings.json"))).toBe(false);
    const archives = readdirSync(d).filter(n => n.startsWith(ARCHIVE_PREFIX));
    expect(archives.length).toBe(1);
  });

  test("a first-ever run with artefacts and no marker archives them too", () => {
    // The state every WORK_DIR in ~/.rungate is in right now.
    const d = dir();
    plantDeadRun(d);
    beginRun(d, { issue: 288, slug: "s" });
    expect(existsSync(join(d, "rook-findings.json"))).toBe(false);
    expect(readdirSync(d).filter(n => n.startsWith(ARCHIVE_PREFIX)).length).toBe(1);
  });

  test("an empty directory produces no empty archive", () => {
    const d = dir();
    beginRun(d, { issue: 288, slug: "s" });
    beginRun(d, { issue: 288, slug: "s" });
    expect(readdirSync(d).filter(n => n.startsWith(ARCHIVE_PREFIX))).toEqual([]);
  });

  test("staleArtefacts names what does not belong to a given run", () => {
    const d = dir();
    const marker = beginRun(d, { issue: 288, slug: "s" });
    writeFileSync(join(d, "rook-findings.json"), "{}");
    expect(staleArtefacts(d, marker.runId)).toEqual([]);
    expect(staleArtefacts(d, "run_somethingelse").sort())
      .toEqual(["rook-findings.json"]);
  });
});

describe("#288 SC-875: a reader can tell running from abandoned from completed", () => {
  function planted(opts: {
    marker?: boolean;
    runIdInState?: string | null;
    updatedTs?: string;
    shipVerdict?: string;
  }): string {
    const d = dir();
    let runId = "run_x";
    if (opts.marker !== false) runId = beginRun(d, { issue: 288, slug: "s", runId: "run_x" }).runId;
    const state: Record<string, unknown> = {
      phase: "VERIFY",
      updatedTs: opts.updatedTs ?? iso(T0),
      gates: opts.shipVerdict ? { ship: { verdict: opts.shipVerdict } } : {},
    };
    if (opts.runIdInState !== null) state.runId = opts.runIdInState ?? runId;
    writeFileSync(join(d, "workflow-state.json"), JSON.stringify(state));
    return d;
  }

  test("no marker at all is said as such, never as a verdict about a run", () => {
    const d = dir();
    plantDeadRun(d);
    expect(runDisposition(d, T0).status).toBe("NO_MARKER");
  });

  test("a fresh heartbeat is RUNNING", () => {
    expect(runDisposition(planted({ updatedTs: iso(T0 - 60_000) }), T0).status).toBe("RUNNING");
  });

  test("a cold heartbeat with no ship verdict is ABANDONED", () => {
    // The previous night's failed run, which is what was misread as live.
    expect(runDisposition(planted({ updatedTs: iso(T0 - 14 * HOUR) }), T0).status).toBe("ABANDONED");
  });

  test("a ship verdict is COMPLETED however cold the heartbeat", () => {
    const out = runDisposition(planted({ updatedTs: iso(T0 - 14 * HOUR), shipVerdict: "PASS" }), T0);
    expect(out.status).toBe("COMPLETED");
    expect(out.shipVerdict).toBe("PASS");
  });

  test("a FAIL verdict is also COMPLETED — the run finished and said no", () => {
    // "Completed" is about whether the run reached its end, not whether it
    // liked what it found. Conflating them would file every refusal as
    // abandoned and hide the ones that really were.
    const out = runDisposition(planted({ updatedTs: iso(T0 - 14 * HOUR), shipVerdict: "FAIL" }), T0);
    expect(out.status).toBe("COMPLETED");
    expect(out.shipVerdict).toBe("FAIL");
  });

  test("a state file from a DIFFERENT run than the marker is MIXED", () => {
    // Exactly the misreading: artefacts and marker disagreeing about whose
    // directory this is. Reported under its own name rather than resolved,
    // because neither value is more trustworthy than the other.
    const out = runDisposition(planted({ runIdInState: "run_fromlastnight" }), T0);
    expect(out.status).toBe("MIXED");
    expect(out.detail).toContain("run_fromlastnight");
    expect(out.detail).toContain("run_x");
  });

  test("a state file with no run id at all is MIXED, not assumed to be ours", () => {
    // It predates attribution, so it was written by something that is not
    // this run. Assuming otherwise is the whole defect.
    expect(runDisposition(planted({ runIdInState: null }), T0).status).toBe("MIXED");
  });

  test("a marker with no state file beside it is RUNNING, not abandoned", () => {
    // `beginRun` stamps before `initWorkflow` writes, so there is a window of
    // milliseconds where this is the honest reading of a healthy run.
    const d = dir();
    beginRun(d, { issue: 288, slug: "s" });
    expect(runDisposition(d, T0).status).toBe("RUNNING");
  });

  test("an unparseable heartbeat is ABANDONED, not treated as now", () => {
    // Fails closed. A timestamp nobody can read is not evidence of life, and
    // defaulting to `now` would report every corrupt directory as a live run.
    for (const ts of ["", "yesterday", "null", "2026-13-45T99:99:99Z"]) {
      expect(runDisposition(planted({ updatedTs: ts }), T0).status, ts).toBe("ABANDONED");
    }
  });

  test("an unreadable marker is said as unreadable", () => {
    const d = dir();
    writeFileSync(join(d, RUN_MARKER_FILE), "{ not json");
    expect(runDisposition(d, T0).status).toBe("UNREADABLE");
  });

  test("the disposition always names the run it is about", () => {
    const out = runDisposition(planted({}), T0);
    expect(out.runId).toBe("run_x");
    expect(out.startedTs).toBeTruthy();
  });
});

describe("#288 SC-876: initWorkflow persists priorWork and AC provenance", () => {
  const BASE = {
    issue: 288,
    repo: "hornjason/pai-harness",
    projectRoot: "/tmp/x",
    slug: "pai-harness-288",
    issueGoal: "attribute artefacts to runs",
  };

  const PRIOR = {
    branch: "288-attribution",
    refName: "refs/remotes/origin/288-attribution",
    commitCount: 3,
    acStatus: [
      { id: "AC-1", status: "MET", evidence: "grep -c runId gates/ = 4" },
      { id: "AC-2", status: "UNMET" },
    ],
  };

  function init(extra: Record<string, unknown> = {}) {
    const sf = join(dir(), "workflow-state.json");
    initWorkflow(sf, { ...BASE, ...extra } as never);
    return JSON.parse(readFileSync(sf, "utf-8"));
  }

  test("priorWork survives the write — it used to be dropped in silence", () => {
    // `ship.js` passed it, `InitWorkflowInput` did not declare it, and the
    // call is assembled into a `bun -e` template so TypeScript never saw the
    // excess property. Nothing read `state.priorWork`; all ten references
    // were to the in-memory `discovery.priorWork`.
    const state = init({ priorWork: PRIOR });
    expect(state.priorWork, "priorWork was dropped again").toBeTruthy();
    expect(state.priorWork.branch).toBe("288-attribution");
    expect(state.priorWork.acStatus).toHaveLength(2);
  });

  test("…and the key is ABSENT when none was detected, not null", () => {
    // The negative control the issue asks for by name: "nobody looked for
    // prior work" and "prior work was looked for and there was none" are
    // different facts, and `null` says the second about the first.
    expect("priorWork" in init()).toBe(false);
  });

  test("an explicit null IS recorded — it is a measurement", () => {
    const state = init({ priorWork: null });
    expect("priorWork" in state).toBe(true);
    expect(state.priorWork).toBeNull();
  });

  test("a MET AC adopted from a prior branch says so, and names the branch", () => {
    // A run that inherited six passing ACs and a run that implemented six
    // passing ACs produce the same artefact today. That is the reading
    // `acCoverage` was added for in #251, missing on the neighbouring field.
    const state = init({ priorWork: PRIOR });
    const prov = state.acProvenance;
    expect(prov, "nothing records where a MET AC came from").toBeTruthy();
    expect(prov["AC-1"]).toEqual({ source: "adopted", branch: "288-attribution" });
  });

  test("an UNMET AC is this run's to earn, and is labelled so", () => {
    // Labelled, not left absent: an absent entry is what an AC nobody
    // classified looks like, and the two must stay distinguishable.
    expect(init({ priorWork: PRIOR }).acProvenance["AC-2"]).toEqual({ source: "this-run" });
  });

  test("with no prior work there is no provenance map to misread", () => {
    expect("acProvenance" in init()).toBe(false);
  });

  test("a prior branch with no acStatus produces no provenance claims", () => {
    const state = init({ priorWork: { branch: "b", acStatus: [] } });
    expect(state.acProvenance).toEqual({});
  });

  test("the run id is written into the state file", () => {
    // This is what makes a state file self-identifying, and it is the input
    // `runDisposition` compares against the marker to catch a MIXED read.
    const state = init();
    expect(state.runId).toMatch(/^run_/);
  });

  test("initWorkflow stamps the directory and sweeps it", () => {
    // The two halves have to happen together. A marker written without the
    // sweep leaves the previous run's findings beside a marker claiming the
    // directory belongs to this one, which is worse than no marker at all.
    const d = dir();
    plantDeadRun(d);
    initWorkflow(join(d, "workflow-state.json"), BASE as never);
    expect(existsSync(join(d, "rook-findings.json")), "the dead run's findings survived").toBe(false);
    const marker = readRunMarker(d);
    expect(marker!.runId).toBe(JSON.parse(readFileSync(join(d, "workflow-state.json"), "utf-8")).runId);
  });

  test("a fresh init reads as RUNNING, not as a mixed directory", () => {
    // The end-to-end control: the two writers agree, so the disposition a
    // reader gets on a healthy run is the plain one.
    const d = dir();
    plantDeadRun(d);
    initWorkflow(join(d, "workflow-state.json"), BASE as never);
    const out = runDisposition(d, Date.now());
    expect(out.status).toBe("RUNNING");
  });

  test("initWorkflow still works where the directory does not exist yet", () => {
    const d = join(dir(), "nested", "deeper");
    initWorkflow(join(d, "workflow-state.json"), BASE as never);
    expect(readRunMarker(d)).toBeTruthy();
  });
});

describe("#288 SC-874: ship.js's artefacts all land under the stamped directory", () => {
  const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

  test("setup calls initWorkflow, which is what stamps the run", () => {
    const setupAt = shipSource.indexOf("initWorkflow(sf, {");
    expect(setupAt).toBeGreaterThan(-1);
    expect(shipSource.indexOf("PHASE 4: IMPLEMENT")).toBeGreaterThan(setupAt);
  });

  test("priorWork reaches initWorkflow as a value the run measured", () => {
    // ship.js always looked — discovery is upstream of setup — so `null` is
    // the honest value here and the absent-key case belongs to callers that
    // skip discovery. What #288 changed is that the field is now declared
    // and persisted; it was passed and silently dropped for the whole life
    // of this call.
    expect(shipSource).toContain("const priorWorkArg = `priorWork: ${JSON.stringify(discovery.priorWork ?? null)}`");
    const setup = shipSource.slice(
      shipSource.indexOf("const priorWorkArg"),
      shipSource.indexOf("writeACs(sf,"),
    );
    expect(setup, "the computed argument never reaches the initWorkflow call")
      .toContain("${priorWorkArg},");
  });
});
