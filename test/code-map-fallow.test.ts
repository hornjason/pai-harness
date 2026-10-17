/**
 * Covers SC-1979..SC-1983 (SCAFFOLD-DECOMPOSITION-SPEC.md), #581.
 *
 * `scripts/generate-code-map.ts` spawned `npx fallow dead-code` with no
 * check that fallow was installed. It is an optional tool and NOT a declared
 * dependency — not in `package.json`, not in `node_modules/.bin`, not on
 * `PATH`, here or on CI — so every one of those invocations was a registry
 * fetch, **on the scaffold path**, once per consumer forever.
 *
 * `lib/conformity.ts` had already written the fix and the reason for it:
 *
 *   > Resolve it locally instead, with no network path.
 *
 * and kept it to itself. One question, two answers, and the one that reached
 * consumers was the one that goes out to the network. That is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape with the
 * copies behaving DIFFERENTLY, which is the version no mutation finds either
 * — mutate the good copy and the bad one carries on being bad.
 *
 * The visible cost was a non-deterministic suite. PR #580 — three state
 * files, no code — went red on `SC-1665`, which asserted that
 * `.fallow/cache.bin` was produced by both of two scaffold runs; when the
 * fetch fails it is produced by neither, and the message blamed the two
 * invocations for a network. The real cost is quieter: a consumer behind a
 * proxy gets a 30-second stall and a silently degraded CODE-MAP.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  fallowAvailable,
  fallowNotInstalled,
  fallowRunFailed,
  fallowUnmeasuredNotice,
} from "../lib/fallow-availability";

const REPO_ROOT = join(import.meta.dir, "..");
const GENERATOR = join(REPO_ROOT, "scripts", "generate-code-map.ts");

/** The smallest project the generator will write a map for. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-581-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fallow-fixture", dependencies: {} }));
  writeFileSync(join(dir, "src", "index.ts"), "export const hello = 1;\n");
  return dir;
}

describe("#581: the scaffold path does not reach for the network", () => {
  test("SC-1979: a project without fallow gets no npx invocation, and the proof is on disk", () => {
    // The assertion that makes this about the network rather than about a
    // string: `.fallow/` is created by fallow and by nothing else, so its
    // ABSENCE after a complete run is the observable fact that no fetch was
    // attempted. Asserting only the notice would pass over a generator that
    // fetched, failed, and then printed the right words.
    const dir = project();
    try {
      expect(
        fallowAvailable(dir),
        "fallow IS installed here, so this case cannot witness the not-installed path",
      ).toBe(false);

      const proc = Bun.spawnSync({ cmd: ["bun", GENERATOR, dir], stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const out = proc.stdout.toString() + proc.stderr.toString();

      expect(proc.exitCode, out).toBe(0);
      expect(existsSync(join(dir, ".fallow")), "a fallow cache appeared, so something fetched and ran it").toBe(false);
      expect(out).toContain("no registry fetch was attempted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1980: the generated map says UNMEASURED rather than leaving the section out", () => {
    // An omitted section and a section reporting nothing wrong are the same
    // absence to a reader, and the reader of a CODE-MAP is an agent deciding
    // whether this project has dead code. `0`, `N/A`, `{}` and silence are
    // indistinguishable from success — `.claude/rules/config-access.md`.
    const dir = project();
    try {
      Bun.spawnSync({ cmd: ["bun", GENERATOR, dir], stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const map = readFileSync(join(dir, "CODE-MAP.md"), "utf-8");

      expect(map, "the health section was dropped instead of reported").toContain("## Code Health (fallow)");
      expect(map).toContain("**UNMEASURED**");
      // The summary cells too, and this is the half that used to read `N/A`
      // through `fallow?.unusedFiles.length || "N/A"` — which gave the SAME
      // cell for a project with zero unused files and a project nobody
      // scanned.
      expect(map).toContain("| Unused files | UNMEASURED |");
      expect(map).toContain("| Circular dependencies | UNMEASURED |");
      expect(map, "an unmeasured count was rendered as a number").not.toContain("| Unused files | 0 |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1981: not-installed and run-failed are different sentences", () => {
    // A notice that said the same thing for both would send a reader to
    // install a tool they already have, and the two have opposite fixes.
    const missing = fallowNotInstalled();
    const broken = fallowRunFailed("exit 2, no output");

    expect(missing.kind).toBe("not-installed");
    expect(missing.reason).toContain("no registry fetch was attempted");
    expect(broken.kind).toBe("run-failed");
    expect(broken.reason, "the failure detail was swallowed").toContain("exit 2, no output");
    expect(broken.reason, "a broken run is reported as a missing tool").not.toContain("not installed");

    // Both render as UNMEASURED, because both are. The distinction is in the
    // reason, not in whether the document admits the gap.
    for (const u of [missing, broken]) {
      expect(fallowUnmeasuredNotice(u)).toContain("**UNMEASURED**");
      expect(fallowUnmeasuredNotice(u)).toContain(u.reason);
    }
  });

  test("SC-1982: the conformity suite and the generator ask the same binding", async () => {
    // Not "both answer the same today" — the SAME FUNCTION. Two deciders
    // answering one question are behaviourally one, and this pair spent four
    // months disagreeing while every test passed, because the disagreement
    // was a network call nobody asserted the absence of.
    const conformity = await import("../lib/conformity");
    expect(
      conformity.fallowAvailable,
      "conformity has its own copy of the availability check again",
    ).toBe(fallowAvailable);
  });

  test("SC-1983: no caller spawns fallow without resolving it first", () => {
    // The source-level ratchet, and the only form that catches the NEXT
    // caller. `lib/conformity.ts` fixed itself in #510 and this defect was a
    // second call site added without the fix; a test over the two files that
    // exist today would not have caught it either.
    const spawning: string[] = [];
    for (const rel of ["lib/conformity.ts", "scripts/generate-code-map.ts", "lib/scaffold/steps.ts", "lib/scanner.ts"]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      // `"npx", "fallow"` as a spawn argument list — the form both callers
      // use. Prose mentioning `npx fallow` is not a spawn and is how this
      // file and the module it tests describe the defect.
      if (/\[\s*"npx",\s*"fallow"/.test(src) && !/fallowAvailable\(/.test(src)) spawning.push(rel);
    }
    expect(spawning, "a caller spawns `npx fallow` without resolving it locally first").toEqual([]);

    // The positive control: the detector must find the spawns that ARE
    // there, or it reports an empty list for a tree it cannot read.
    const seen = ["lib/conformity.ts", "scripts/generate-code-map.ts"].filter(rel =>
      /\[\s*"npx",\s*"fallow"/.test(readFileSync(join(REPO_ROOT, rel), "utf-8")),
    );
    expect(seen, "the detector found no fallow spawns at all, so it is not detecting").toEqual([
      "lib/conformity.ts",
      "scripts/generate-code-map.ts",
    ]);
  });
});
