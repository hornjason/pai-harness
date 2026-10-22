/**
 * #875: the distribution standing compares CONTENT, not version strings.
 *
 * `test/distribution-standing.test.ts` is unchanged and still runs — a bump
 * with no publish is a different defect and that file catches it. This one
 * catches the defect three agreeing version strings cannot see: the registry
 * and the tree naming one version and holding different software.
 *
 * ## The defect is CONSTRUCTED, not described
 *
 * Every fixture below is produced by `npm pack` — the emitting side — on both
 * halves. The published half is a real tarball npm wrote; the local half is
 * `npm pack --dry-run --json` over the same tree with one file changed and the
 * version left alone. Neither side is built from `package.json`'s `files[]`,
 * which is the list being checked: a comparison sourced from it would be the
 * declaration compared with itself (#484 is this repository's own instance of
 * a published module reading a path `files[]` omitted).
 *
 * ## The pair varies exactly one thing
 *
 * `AHEAD` and `DIVERGED` are driven from the SAME content difference and
 * differ only in the version string, so what those two cases measure is the
 * version comparison and nothing else (#585). A pair whose halves differ in
 * two places measures neither.
 *
 * ## Absence is not clean
 *
 * `the live tree's standing is MEASURED` asserts the reading was TAKEN, not
 * that it passed. With the registry unreachable it reds; it cannot skip, and
 * it cannot go green on a tree nobody looked at. Measured with the registry
 * blocked — see the PR for #875.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { gunzipSync } from "zlib";
import {
  ArtifactUnmeasured,
  TARBALL_ROOT,
  artifactStanding,
  artifactViolations,
  compareVersions,
  contentAgrees,
  contentDifference,
  localArtifact,
  measureArtifactStanding,
  parseNpmTarball,
  publishedArtifact,
  publishedTagDistance,
  STANDING_CAUSE_HEADLINE,
  standingCauses,
  standingHeadline,
  type ArtifactFile,
  type ArtifactStanding,
  type RunCommand,
  type StandingCause,
} from "../lib/published-artifact";
import { publishedVersion } from "../lib/distribution-standing";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];

/** Resolved once, over the network, before any case runs. */
const live = await measureArtifactStanding({
  pkg: "rungate",
  root: ROOT,
  run: (cmd, cwd) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  latestVersion: publishedVersion,
});

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const run: RunCommand = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function scratchDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `rungate-875-${label}-`));
  scratch.push(d);
  return d;
}

/** A minimal real package, with the files npm would publish. */
function fixturePackage(version: string, body: Record<string, string>): string {
  const dir = scratchDir("pkg");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "rungate-875-fixture", version, files: ["lib/"] }, null, 2) + "\n",
  );
  for (const [p, content] of Object.entries(body)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

/** Pack `dir` for real and return the uncompressed tar npm wrote. */
function packedTar(dir: string): Buffer {
  const dest = scratchDir("tgz");
  const r = run(["npm", "pack", "--pack-destination", dest], dir);
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
  const name = r.stdout.trim().split("\n").pop()!.trim();
  return gunzipSync(readFileSync(join(dest, name)));
}

/** Pack `dir` for real and return the tarball npm wrote, parsed. */
function packedArtifact(dir: string): ArtifactFile[] {
  return parseNpmTarball(packedTar(dir));
}

describe("#875: a tarball this module cannot fully read is UNMEASURED, never a short list", () => {
  test("a real npm tarball round-trips to the bytes on disk", () => {
    // The positive control. Every refusal below is only meaningful if the
    // parser can read the thing it is refusing variants of.
    const dir = fixturePackage("1.0.0", { "lib/a.ts": "export const a = 1;\n" });
    const files = packedArtifact(dir);
    expect(files.map(f => f.path)).toContain("lib/a.ts");
    const onDisk = readFileSync(join(dir, "lib/a.ts"));
    const hashed = files.find(f => f.path === "lib/a.ts")!;
    expect(hashed.size).toBe(onDisk.length);
  });

  test("a truncated tarball throws rather than reporting the entries it did reach", () => {
    // The cut removes the terminating zero blocks and part of the last
    // entry's data. A parser that returned what it had read would report a
    // SHORTER published file set, which is indistinguishable from a release
    // that genuinely shipped fewer files.
    const dir = fixturePackage("1.0.0", {
      "lib/a.ts": "export const a = 1;\n".repeat(200),
      "lib/b.ts": "export const b = 2;\n",
    });
    const plain = packedTar(dir);
    expect(parseNpmTarball(plain).length).toBe(3); // package.json + two lib files
    expect(() => parseNpmTarball(plain.subarray(0, plain.length - 2048))).toThrow(ArtifactUnmeasured);
  });

  test("a header whose checksum does not agree throws", () => {
    const plain = Buffer.from(packedTar(fixturePackage("1.0.0", { "lib/a.ts": "export const a = 1;\n" })));
    plain[5] = plain[5] ^ 0xff; // corrupt a name byte, leaving the checksum stale
    expect(() => parseNpmTarball(plain)).toThrow(/checksum/);
  });

  test("entries are reported without the package/ prefix", () => {
    const dir = fixturePackage("1.0.0", { "lib/a.ts": "x\n" });
    for (const f of packedArtifact(dir)) expect(f.path.startsWith(TARBALL_ROOT)).toBe(false);
  });
});

describe("#875: the comparison refuses an empty side", () => {
  const one: ArtifactFile[] = [{ path: "lib/a.ts", sha256: "aa", size: 1 }];

  test("two empty sets are not agreement", () => {
    expect(() => contentDifference([], [])).toThrow(ArtifactUnmeasured);
  });

  test("an empty published side is not agreement", () => {
    expect(() => contentDifference(one, [])).toThrow(ArtifactUnmeasured);
  });

  test("an empty local side is not agreement", () => {
    expect(() => contentDifference([], one)).toThrow(ArtifactUnmeasured);
  });
});

describe("#875: same version string, different content, constructed end to end", () => {
  // Built once: one package, packed for real, then one byte of one file
  // changed with the version left alone. Both halves come from npm.
  const dir = fixturePackage("1.0.0", {
    "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "export const b = 2;\n",
  });
  const published = packedArtifact(dir);
  writeFileSync(join(dir, "lib/b.ts"), "export const b = 3;\n");
  writeFileSync(join(dir, "lib/c.ts"), "export const c = 4;\n");
  const local = localArtifact(dir, run);
  const difference = contentDifference(local.files, published);

  test("the fixture really is the defect: one version, two different trees", () => {
    // Vacuity control. Without this the cases below could be measuring a
    // version difference while claiming to measure content.
    expect(local.version).toBe("1.0.0");
    expect(difference.differing).toEqual(["lib/b.ts"]);
    expect(difference.onlyLocal).toEqual(["lib/c.ts"]);
    expect(difference.onlyPublished).toEqual([]);
    expect(contentAgrees(difference)).toBe(false);
  });

  test("the standing reads DIVERGED and the check reports it", () => {
    const s = artifactStanding({ treeVersion: "1.0.0", publishedVersion: "1.0.0", difference });
    expect(s.reading).toBe("DIVERGED");
    const v = artifactViolations(s);
    expect(v, "same version string, different content went unreported").toHaveLength(1);
    expect(v[0]).toContain("DIFFERENT SOFTWARE");
    expect(v[0]).toContain("SAME version string");
  });

  test("the SAME difference under a bumped version is AHEAD, and is not a violation", () => {
    // The pair, varying exactly one thing: identical `difference`, one
    // version string moved. A repo ahead of its last release is the normal
    // state between releases and must not red.
    const s = artifactStanding({ treeVersion: "1.1.0", publishedVersion: "1.0.0", difference });
    expect(s.reading).toBe("AHEAD");
    expect(artifactViolations(s)).toEqual([]);
  });

  test("a tree behind the registry is reported, not refused", () => {
    const s = artifactStanding({ treeVersion: "0.9.0", publishedVersion: "1.0.0", difference });
    expect(s.reading).toBe("BEHIND");
    expect(artifactViolations(s)).toEqual([]);
  });

  test("an unchanged tree against its own tarball is MATCHED", () => {
    const clean = fixturePackage("2.0.0", { "lib/a.ts": "export const a = 1;\n" });
    const same = contentDifference(localArtifact(clean, run).files, packedArtifact(clean));
    expect(same.differing).toEqual([]);
    const s = artifactStanding({ treeVersion: "2.0.0", publishedVersion: "2.0.0", difference: same });
    expect(s.reading).toBe("MATCHED");
    expect(artifactViolations(s)).toEqual([]);
  });

  test("the violation names the commit distance when one was measured", () => {
    const s = artifactStanding({
      treeVersion: "1.0.0",
      publishedVersion: "1.0.0",
      difference,
      commitsAhead: 122,
    });
    expect(artifactViolations(s)[0]).toContain("122 commits since the published tag");
  });
});

describe("#875: a reading that could not be taken refuses", () => {
  const diff = contentDifference(
    [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
    [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
  );

  test("an absent published version is UNMEASURED, not MATCHED", () => {
    const s = artifactStanding({ treeVersion: "1.0.0", publishedVersion: null, difference: diff });
    expect(s.reading).toBe("UNMEASURED");
    expect(artifactViolations(s)).toHaveLength(1);
    expect(artifactViolations(s)[0]).toContain("UNMEASURED");
  });

  test("an absent comparison is UNMEASURED, not MATCHED", () => {
    const s = artifactStanding({ treeVersion: "1.0.0", publishedVersion: "1.0.0", difference: null });
    expect(s.reading).toBe("UNMEASURED");
    expect(artifactViolations(s)).toHaveLength(1);
  });

  test("a version neither side can order is UNMEASURED, not AHEAD", () => {
    const s = artifactStanding({ treeVersion: "latest", publishedVersion: "1.0.0", difference: diff });
    expect(s.reading).toBe("UNMEASURED");
  });

  test("an unreachable registry produces UNMEASURED and a violation, never agreement", async () => {
    // The fail-open this check could most easily have had: a download that
    // returned nothing, read as "no differences found".
    const s = await measureArtifactStanding({
      pkg: "rungate",
      root: ROOT,
      run,
      latestVersion: async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
    });
    expect(s.reading).toBe("UNMEASURED");
    expect(artifactViolations(s)).toHaveLength(1);
    expect(artifactViolations(s)[0]).toContain("ENOTFOUND");
  });

  test("a registry that refuses the connection produces UNMEASURED, over a real socket", async () => {
    // Not a stub: `publishedArtifact` is given a base nothing is listening
    // on, which is what a blocked registry looks like to `fetch`.
    await expect(
      publishedArtifact("rungate", "0.6.0", { base: "http://127.0.0.1:1" }),
    ).rejects.toThrow(ArtifactUnmeasured);
  });

  test("a non-200 from the registry is UNMEASURED, not an empty artifact", async () => {
    const notThere = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(
      publishedArtifact("rungate", "9.9.9", { fetchImpl: notThere }),
    ).rejects.toThrow("404");
  });

  test("a body that is not gzip is UNMEASURED", async () => {
    const junk = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("<html>nope</html>").buffer,
    })) as unknown as typeof fetch;
    await expect(publishedArtifact("rungate", "0.6.0", { fetchImpl: junk })).rejects.toThrow(/not gzip/);
  });

  test("an npm that is not on the path is UNMEASURED, not an empty file list", () => {
    const noNpm: RunCommand = () => ({ status: 127, stdout: "", stderr: "npm: command not found" });
    expect(() => localArtifact(ROOT, noNpm)).toThrow(ArtifactUnmeasured);
  });

  test("a pack that named no files is UNMEASURED, not an artifact with nothing in it", () => {
    const empty: RunCommand = () => ({
      status: 0,
      stdout: JSON.stringify([{ name: "rungate", version: "0.6.0", files: [] }]),
      stderr: "",
    });
    expect(() => localArtifact(ROOT, empty)).toThrow(/named no files/);
  });
});

describe("#875: the commit distance is reported, never gated on", () => {
  test("an absent tag is a note, not a refusal", () => {
    const d = publishedTagDistance(ROOT, "99.99.99", run);
    expect(d.commits).toBeNull();
    expect(d.note).toContain("99.99.99");
  });

  test("a standing with no distance is still MATCHED", () => {
    const same = contentDifference(
      [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
      [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
    );
    const s = artifactStanding({
      treeVersion: "1.0.0",
      publishedVersion: "1.0.0",
      difference: same,
      commitsAhead: null,
      distanceNote: "shallow clone",
    });
    expect(s.reading).toBe("MATCHED");
    expect(artifactViolations(s)).toEqual([]);
  });
});

describe("#875: version ordering", () => {
  test("it orders by component, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.6.0", "0.6.0")).toBe(0);
    expect(compareVersions("0.5.9", "0.6.0")).toBe(-1);
  });

  test("something it cannot order is null, not zero", () => {
    expect(compareVersions("latest", "0.6.0")).toBeNull();
  });
});

describe("#1117: the red says WHICH condition produced it, and refuses the same states", () => {
  const same = contentDifference(
    [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
    [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
  );
  const differs = contentDifference(
    [{ path: "lib/a.ts", sha256: "aa", size: 1 }],
    [{ path: "lib/a.ts", sha256: "bb", size: 1 }],
  );

  /** The registry could not be read. Nothing was compared. */
  const transport = artifactStanding({
    treeVersion: "0.7.0",
    publishedVersion: null,
    difference: null,
    unmeasured: [{ cause: "REGISTRY", text: "registry: registry returned 503 for rungate" }],
  });
  /** The registry WAS read, and serves different software under this version. */
  const content = artifactStanding({
    treeVersion: "0.7.0",
    publishedVersion: "0.7.0",
    difference: differs,
    commitsAhead: 22,
  });

  test("the two conditions do not produce the same sentence, and both still refuse", () => {
    // These two cannot be a one-variable pair, and saying so is the point:
    // a transport failure is a reading nobody took and a divergence is a
    // reading that was taken, so they differ in `publishedVersion` and
    // `difference` by construction. What the case holds fixed is the TREE
    // version and the refusal — both red, for different stated reasons.
    expect(transport.reading).toBe("UNMEASURED");
    expect(content.reading).toBe("DIVERGED");
    expect(transport.treeVersion).toBe(content.treeVersion);

    expect(standingHeadline(transport).length).toBeGreaterThan(0);
    expect(standingHeadline(content).length).toBeGreaterThan(0);
    expect(standingHeadline(transport)).not.toBe(standingHeadline(content));

    // Both still refuse. #1117: "Do not weaken the refusal in the process."
    const t = artifactViolations(transport);
    const c = artifactViolations(content);
    expect(t).toHaveLength(1);
    expect(c).toHaveLength(1);
    // …and the sentence reaches the violation, which is the only place a
    // CI reader sees it. Without this the headline is a function nobody calls.
    expect(t[0]).toContain(standingHeadline(transport));
    expect(c[0]).toContain(standingHeadline(content));
  });

  test("the transport sentence says the registry, and says a re-run may clear it", () => {
    const h = standingHeadline(transport);
    expect(standingCauses(transport)).toEqual(["REGISTRY"]);
    expect(h).toContain("REGISTRY");
    expect(h).toContain("not your branch");
    expect(h).toContain("a re-run may");
  });

  test("the content sentence says a release clears it and a re-run never will", () => {
    const h = standingHeadline(content);
    expect(standingCauses(content)).toEqual(["CONTENT"]);
    expect(h).toContain("CONTENT");
    expect(h).toContain("only a release clears it");
    expect(h).toContain("a re-run never will");
  });

  test("an unreachable registry never reports CONTENT — the collapse #1117 is about", () => {
    // `CONTENT` is reachable only from `DIVERGED`, which is a comparison that
    // WAS taken. A standing that compared nothing cannot name a divergence it
    // never measured, however many of its reasons mention the comparison.
    expect(transport.unmeasuredReasons).toContain("the content comparison was not performed");
    expect(standingCauses(transport)).not.toContain("CONTENT");
    const bothOut = artifactStanding({
      treeVersion: null,
      publishedVersion: null,
      difference: null,
      unmeasured: [
        { cause: "TOOLCHAIN", text: "npm: command not found" },
        { cause: "REGISTRY", text: "registry: registry returned 503 for rungate" },
      ],
    });
    expect(standingCauses(bothOut)).toEqual(["TOOLCHAIN", "REGISTRY"]);
    expect(standingCauses(bothOut)).not.toContain("CONTENT");
  });

  test("naming the condition changed no verdict", () => {
    // The whole table, so the claim is a census and not a sample. The refusal
    // is `reading` and nothing else, exactly as it was before a cause existed:
    // a cause that could turn a red green would be the one change #1117
    // forbids, and this is the case that would see it.
    const table: Array<[string, ArtifactStanding]> = [
      ["transport", transport],
      ["content", content],
      ["toolchain", artifactStanding({ treeVersion: null, publishedVersion: "0.7.0", difference: null })],
      ["versions", artifactStanding({ treeVersion: "latest", publishedVersion: "0.7.0", difference: same })],
      ["untagged", artifactStanding({ treeVersion: "0.7.0", publishedVersion: "0.7.0", difference: same, unmeasuredReasons: ["something happened"] })],
      ["matched", artifactStanding({ treeVersion: "0.7.0", publishedVersion: "0.7.0", difference: same })],
      ["ahead", artifactStanding({ treeVersion: "0.8.0", publishedVersion: "0.7.0", difference: differs })],
      ["behind", artifactStanding({ treeVersion: "0.6.0", publishedVersion: "0.7.0", difference: differs })],
    ];
    const refuses = table.filter(([, s]) => artifactViolations(s).length > 0).map(([n]) => n);
    expect(refuses).toEqual(["transport", "content", "toolchain", "versions", "untagged"]);
    // Vacuity control: a table in which nothing refuses would satisfy a
    // weaker form of the claim above, and three of these states are green.
    expect(table).toHaveLength(8);
  });

  test("a reason with no condition attached is UNCLASSIFIED, never the registry", () => {
    // Silent Default Substitution, in the position it would be cheapest to
    // commit: an untagged reason folded into whichever cause looks likeliest
    // reads as a confident attribution nobody made.
    const s = artifactStanding({
      treeVersion: "0.7.0",
      publishedVersion: "0.7.0",
      difference: same,
      unmeasuredReasons: ["something happened"],
    });
    expect(s.reading).toBe("UNMEASURED");
    expect(standingCauses(s)).toEqual(["UNCLASSIFIED"]);
    expect(standingHeadline(s)).toContain("no condition attached");
  });

  test("unmeasured and unmeasuredReasons are one list read two ways", () => {
    // Two lists built side by side would always agree and would survive any
    // mutation of either. These are projections of one list.
    for (const s of [transport, content]) {
      expect(s.unmeasuredReasons).toEqual(s.unmeasured.map(r => r.text));
    }
    expect(transport.unmeasured.length).toBeGreaterThan(0);
    expect(artifactViolations(transport)[0]).toContain("registry returned 503");
  });

  test("every condition has a sentence, and no two conditions share one", () => {
    const causes = Object.keys(STANDING_CAUSE_HEADLINE) as StandingCause[];
    expect(causes.length).toBeGreaterThan(1);
    for (const c of causes) {
      expect(STANDING_CAUSE_HEADLINE[c].length, `${c} has no sentence`).toBeGreaterThan(40);
      expect(STANDING_CAUSE_HEADLINE[c], `${c} does not name itself`).toContain(c);
    }
    expect(new Set(causes.map(c => STANDING_CAUSE_HEADLINE[c])).size).toBe(causes.length);
  });

  test("changing the condition changes the sentence and not the verdict", () => {
    // One standing, one field varied: the cause. If a cause were an input to
    // the refusal this is where it would show, and it is the behavioural form
    // of "the cause never decides" — a source assertion about which branch
    // reads what cannot notice that it has stopped describing the code.
    const retagged: ArtifactStanding = {
      ...transport,
      unmeasured: transport.unmeasured.map(r => ({ ...r, cause: "TOOLCHAIN" as const })),
    };
    expect(standingHeadline(retagged)).not.toBe(standingHeadline(transport));
    expect(artifactViolations(retagged)).toHaveLength(artifactViolations(transport).length);
    expect(artifactViolations(retagged)).toHaveLength(1);
  });
});

describe("#875: the live tree, measured against what npm actually serves", () => {
  test("the live standing is MEASURED — a registry nobody could reach reds here", () => {
    // The instrument control. It asserts the reading was TAKEN, not that it
    // passed: with the registry blocked `measureArtifactStanding` returns
    // UNMEASURED and this case fails. A skip would have been a green over a
    // tree nobody looked at.
    expect(
      live.reading,
      `${standingHeadline(live)}\nthe artifact comparison could not be taken: ` +
        live.unmeasuredReasons.join("; "),
    ).not.toBe("UNMEASURED");
    expect(live.difference).not.toBeNull();
    // A floor, not a count: the number of published files is not a property
    // this case owns, and an equality here would red on somebody else's merge.
    expect(live.difference!.publishedCount).toBeGreaterThan(0);
    expect(live.difference!.localCount).toBeGreaterThan(0);
  });

  test("the live reading is RECORDED, and whether it gates is a release decision", () => {
    // Deliberately not `artifactViolations(live).toEqual([])`. On 2026-10-21
    // the live reading is DIVERGED — `rungate@0.6.0` on npm and the 0.6.0
    // tree are different software — and that cannot be cleared from a
    // worktree: it needs a version bump plus the `SUCCESS.md` standing line,
    // which is DA-owned (#296), and a publish, which is Jason's call. A
    // refusal nobody can clear is a red main that teaches everyone to stop
    // reading the gate. See #875 for the decision this is waiting on.
    const v = artifactViolations(live);
    const d = live.difference;
    console.log(
      `#875 distribution standing: reading=${live.reading} tree=${live.treeVersion} ` +
        `published=${live.publishedVersion} ` +
        (d
          ? `local=${d.localCount} publishedFiles=${d.publishedCount} differing=${d.differing.length} ` +
            `onlyLocal=${d.onlyLocal.length} onlyPublished=${d.onlyPublished.length} `
          : "difference=UNREAD ") +
        `commitsAhead=${live.commitsAhead ?? "unread"}` +
        (v.length ? `\n  ${v[0]}` : ""),
    );
    // The message is the whole of #1117 for this case: until now this
    // assertion printed a bare `toContain` diff, so a 503 and a divergence
    // arrived here looking alike and the first reading on four PRs was
    // "my change broke something".
    expect(
      ["MATCHED", "AHEAD", "BEHIND", "DIVERGED"],
      `${standingHeadline(live)}\nreading=${live.reading} reasons=${live.unmeasuredReasons.join("; ")}`,
    ).toContain(live.reading);
    // The binding refuses DIVERGED. This asserts the projection, so a
    // mutation that stopped refusing it is red here even while the tree is
    // in the state nobody can clear.
    expect(v.length === 0).toBe(live.reading !== "DIVERGED");
  });
});
