/**
 * What a consumer actually installs, compared against this tree — by CONTENT,
 * not by version string (#875).
 *
 * ## The defect this exists for
 *
 * `lib/distribution-standing.ts` compares three spellings of a NUMBER:
 * `package.json`'s version, `SUCCESS.md`'s standing line, and the registry's
 * `latest`. All three agreeing proves the repository and the registry agree
 * about a NAME. It proves nothing about what is behind the name.
 *
 * Measured 2026-10-21, with all three agreeing on `0.6.0` and the check
 * reporting standing fine:
 *
 * | Reading | Value |
 * |---|---|
 * | files `npm pack --dry-run` would publish | 235 |
 * | files in the published `rungate@0.6.0` tarball | 192 |
 * | published files whose bytes differ from the tree | 42 |
 * | files the published artifact does not have at all | 43 |
 *
 * Same label, different software. That is the defect class
 * `.claude/rules/checks-must-be-able-to-fail.md` calls *a detector narrower
 * than what it detects*: the version string is the cheapest proxy for "the
 * registry and the tree agree", and a proxy is a thing that can be satisfied
 * directly without fixing anything. Here it is satisfied permanently, because
 * the numbers keep agreeing for as long as nobody bumps.
 *
 * ## Why a content mismatch is not automatically a failure
 *
 * A repository that is AHEAD of its last release is the normal state between
 * releases, so a check that reddened on "the tree differs from npm" would be
 * red every day and would teach everyone to stop reading it. The distinction
 * this module is built around is which of two things the difference means:
 *
 * | Versions | Content | Reading | Violation |
 * |---|---|---|---|
 * | tree > published | — | `AHEAD` | no — unreleased work is what a repo is for |
 * | tree < published | — | `BEHIND` | no — a stale checkout, not a distribution defect |
 * | equal | identical | `MATCHED` | no |
 * | **equal** | **differs** | **`DIVERGED`** | **yes — the label lies** |
 * | could not be taken | — | `UNMEASURED` | yes |
 *
 * `DIVERGED` is the only content state that is a defect, and it is a defect
 * because of what the version string claims, not because of the bytes. A
 * consumer running `bun add -d rungate@0.6.0` and a maintainer reading `0.6.0`
 * in `package.json` are talking about different trees and nothing says so.
 *
 * ## UNMEASURED is a violation, deliberately
 *
 * `0`, `{}`, `null` and `SKIP` are indistinguishable from success
 * (`.claude/rules/config-access.md`). A guard with no failing input in the
 * configuration it actually runs in is worse than no guard, because the green
 * is read as evidence — so an unreachable registry, an absent `npm`, a tarball
 * this module cannot parse and a pack that named no files all produce
 * `UNMEASURED`, and `artifactViolations` refuses it with the same force it
 * refuses `DIVERGED`.
 *
 * ## One binding per question
 *
 * `artifactStanding` is the only thing that decides a reading and
 * `artifactViolations` is a projection of it, so they cannot disagree — two
 * deciders that agree are behaviourally one guard and no behavioural test can
 * tell them apart.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "zlib";
import { NPM_REGISTRY } from "./release-preflight";

/** One file in a publishable artifact, hashed by content. */
export interface ArtifactFile {
  /** Path relative to the package root — `lib/conformity.ts`, never `package/lib/…`. */
  path: string;
  /** sha256 of the file's bytes, hex. */
  sha256: string;
  /** Bytes, so a reader can see the size of a difference without re-reading. */
  size: number;
}

/** Every npm tarball entry is prefixed with this directory. */
export const TARBALL_ROOT = "package/";

/** Raised by anything in this module that could not take its reading. */
export class ArtifactUnmeasured extends Error {}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse an uncompressed npm tarball into per-entry content hashes.
 *
 * Hand-rolled rather than extracted to disk: nothing from the registry is ever
 * written to the filesystem, so there is no untrusted archive to unpack and no
 * `tar` binary whose flags differ between macOS and CI.
 *
 * **Every way of failing to read throws.** A typeflag this does not understand
 * — a pax extended header, a GNU long name, a symlink — is an entry whose name
 * or content comes from somewhere this parser is not looking, and skipping it
 * would silently shrink the published set, which makes the comparison agree for
 * a reason that has nothing to do with the bytes. The header checksum is
 * verified for the same reason: a misaligned read produces plausible garbage,
 * and plausible garbage compares unequal, which reads as a finding.
 */
export function parseNpmTarball(tar: Uint8Array): ArtifactFile[] {
  const b = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const out: ArtifactFile[] = [];
  let off = 0;

  /** A list with nothing in it compares equal to anything. Refuse instead. */
  const done = (): ArtifactFile[] => {
    if (out.length === 0) throw new ArtifactUnmeasured("the tarball holds no files at all");
    return out.sort((x, y) => (x.path < y.path ? -1 : 1));
  };

  while (off + 512 <= b.length) {
    const header = b.subarray(off, off + 512);
    if (header.every(x => x === 0)) return done();

    // The checksum is the sum of every header byte with the checksum field
    // itself read as spaces. If this does not agree we are not on a header.
    const declared = parseInt(header.subarray(148, 156).toString("utf8").replace(/\0.*$/, "").trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (!Number.isFinite(declared) || declared !== sum) {
      throw new ArtifactUnmeasured(
        `tarball header at byte ${off} has checksum ${declared} but its bytes sum to ${sum} — ` +
          `the parser is not aligned on a header and anything it reported would be noise`,
      );
    }

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const type = String.fromCharCode(header[156]);
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new ArtifactUnmeasured(`tarball entry ${name} declares an unreadable size ${JSON.stringify(sizeField)}`);
    }

    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > b.length) {
      throw new ArtifactUnmeasured(
        `tarball entry ${name} declares ${size} bytes but the archive ends ${dataEnd - b.length} bytes short — truncated`,
      );
    }

    if (type !== "0" && type !== "\0" && type !== "5") {
      throw new ArtifactUnmeasured(
        `tarball entry ${name} has typeflag ${JSON.stringify(type)}, which this parser does not read. ` +
          `Skipping it would shrink the published file set and the comparison would agree for the wrong reason`,
      );
    }

    if (type !== "5") {
      const full = prefix ? `${prefix}/${name}` : name;
      if (!full.startsWith(TARBALL_ROOT)) {
        throw new ArtifactUnmeasured(`tarball entry ${full} is not under ${TARBALL_ROOT}`);
      }
      out.push({
        path: full.slice(TARBALL_ROOT.length),
        sha256: sha256(b.subarray(dataStart, dataEnd)),
        size,
      });
    }

    off = dataStart + Math.ceil(size / 512) * 512;
  }

  // Falling out of the loop means the terminating zero blocks were never
  // reached. Every tar npm writes ends with two of them, so their absence is a
  // truncated download — and a truncated download yields a SHORT FILE LIST,
  // which reads as "the published artifact has fewer files than the tree",
  // i.e. as a finding rather than as the absence of a reading.
  throw new ArtifactUnmeasured(
    `the tarball ended after ${out.length} entries without its terminating zero blocks, ` +
      `${b.length - off} bytes short of a header — the download is truncated`,
  );
}

/**
 * Download and hash what the registry actually serves for `pkg@version`.
 *
 * Reads only. Nothing here publishes, tags, or writes to the registry.
 */
export async function publishedArtifact(
  pkg: string,
  version: string,
  opts: { fetchImpl?: typeof fetch; base?: string } = {},
): Promise<ArtifactFile[]> {
  const base = opts.base ?? NPM_REGISTRY;
  const f = opts.fetchImpl ?? fetch;
  const bare = pkg.replace(/^@[^/]+\//, "");
  const url = `${base}/${pkg}/-/${bare}-${version}.tgz`;
  let res: Response;
  try {
    res = await f(url);
  } catch (e) {
    throw new ArtifactUnmeasured(`could not reach ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ArtifactUnmeasured(`registry returned ${res.status} for ${url}`);
  const gz = new Uint8Array(await res.arrayBuffer());
  if (gz.length === 0) throw new ArtifactUnmeasured(`registry returned an empty body for ${url}`);
  let plain: Buffer;
  try {
    plain = gunzipSync(gz);
  } catch (e) {
    throw new ArtifactUnmeasured(`${url} is not gzip: ${(e as Error).message}`);
  }
  return parseNpmTarball(plain);
}

/** The shape `npm pack --dry-run --json` reports, narrowed to what is read here. */
export interface PackReading {
  name: string;
  version: string;
  files: ArtifactFile[];
}

/** How a command is run, so a test can drive the reading without a real npm. */
export type RunCommand = (
  cmd: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

/**
 * What `npm pack` would publish from `root`, hashed from disk.
 *
 * **The file list comes from npm, not from `package.json`'s `files[]`.**
 * `files[]` is the declaration being checked — #484 is this repository's own
 * instance of a published module reading a path `files[]` omitted — so a
 * comparison built from it would be a comparison of the list with itself.
 * `npm pack --dry-run` is the emitting side: it applies `files[]`, `.npmignore`,
 * npm's always-included and always-excluded sets, and reports the result.
 */
export function localArtifact(root: string, run: RunCommand): PackReading {
  const r = run(["npm", "pack", "--dry-run", "--json"], root);
  if (r.status !== 0) {
    throw new ArtifactUnmeasured(
      `\`npm pack --dry-run --json\` exited ${r.status} in ${root}: ${r.stderr.trim() || "(no stderr)"}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new ArtifactUnmeasured(`\`npm pack --dry-run --json\` did not print JSON: ${r.stdout.slice(0, 200)}`);
  }
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  if (!first || typeof first.name !== "string" || typeof first.version !== "string") {
    throw new ArtifactUnmeasured("`npm pack --dry-run --json` reported no package name and version");
  }
  const entries = Array.isArray(first.files) ? (first.files as { path?: unknown }[]) : [];
  if (entries.length === 0) {
    // Zero files is not agreement with an empty artifact. It is a pack that
    // read nothing, and an empty set compares equal to anything.
    throw new ArtifactUnmeasured(`\`npm pack --dry-run\` named no files in ${root}`);
  }
  const files: ArtifactFile[] = entries.map(e => {
    if (typeof e.path !== "string") throw new ArtifactUnmeasured("`npm pack` reported a file with no path");
    const bytes = readFileSync(join(root, e.path));
    return { path: e.path, sha256: sha256(bytes), size: bytes.length };
  });
  return { name: first.name, version: first.version, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

/** Which paths are on one side only, and which are on both and differ. */
export interface ContentDifference {
  onlyLocal: string[];
  onlyPublished: string[];
  differing: string[];
  localCount: number;
  publishedCount: number;
}

/** `true` when nothing is on one side only and nothing shared differs. */
export function contentAgrees(d: ContentDifference): boolean {
  return d.onlyLocal.length === 0 && d.onlyPublished.length === 0 && d.differing.length === 0;
}

/**
 * The single place that compares two artifacts.
 *
 * A comparison over two empty sets agrees trivially, which is the vacuous
 * shape this repository has shipped before, so an empty side REFUSES rather
 * than returning a clean difference.
 */
export function contentDifference(local: ArtifactFile[], published: ArtifactFile[]): ContentDifference {
  if (local.length === 0 || published.length === 0) {
    throw new ArtifactUnmeasured(
      `a content comparison needs both sides: local has ${local.length} files and published has ` +
        `${published.length}. Two empty sets agree, and that agreement is not a reading`,
    );
  }
  const l = new Map(local.map(f => [f.path, f.sha256]));
  const p = new Map(published.map(f => [f.path, f.sha256]));
  const onlyLocal: string[] = [];
  const differing: string[] = [];
  for (const [path, hash] of l) {
    const other = p.get(path);
    if (other === undefined) onlyLocal.push(path);
    else if (other !== hash) differing.push(path);
  }
  const onlyPublished = [...p.keys()].filter(path => !l.has(path));
  return {
    onlyLocal: onlyLocal.sort(),
    onlyPublished: onlyPublished.sort(),
    differing: differing.sort(),
    localCount: l.size,
    publishedCount: p.size,
  };
}

export type ArtifactReading = "MATCHED" | "DIVERGED" | "AHEAD" | "BEHIND" | "UNMEASURED";

export interface ArtifactStanding {
  reading: ArtifactReading;
  /** `package.json`'s version in the tree that was packed. */
  treeVersion: string | null;
  /** The registry's `latest`. */
  publishedVersion: string | null;
  /** `null` only when the comparison could not be performed. */
  difference: ContentDifference | null;
  /** Commits between the published tag and HEAD. `null` is a reading nobody took. */
  commitsAhead: number | null;
  /** Why `commitsAhead` is null, when it is. Reported; never gated on. */
  distanceNote: string | null;
  /** Non-empty exactly when `reading` is `UNMEASURED`. */
  unmeasuredReasons: string[];
}

/** `0.6.0` → `[0,6,0]`; anything else → `null`. Prerelease suffixes are ignored. */
function parts(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `-1`, `0`, `1`, or `null` when either side is not a version this can order. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/**
 * The single place that turns the readings into a verdict.
 *
 * Pure: every input is passed in, so a case can construct any state including
 * ones that cannot be produced on this machine today.
 */
export function artifactStanding(input: {
  treeVersion: string | null;
  publishedVersion: string | null;
  difference: ContentDifference | null;
  commitsAhead?: number | null;
  distanceNote?: string | null;
  unmeasuredReasons?: string[];
}): ArtifactStanding {
  const base = {
    treeVersion: input.treeVersion,
    publishedVersion: input.publishedVersion,
    difference: input.difference,
    commitsAhead: input.commitsAhead ?? null,
    distanceNote: input.distanceNote ?? null,
  };
  const reasons = [...(input.unmeasuredReasons ?? [])];
  if (input.treeVersion === null) reasons.push("the tree's version could not be read");
  if (input.publishedVersion === null) reasons.push("the registry's published version could not be read");
  if (input.difference === null) reasons.push("the content comparison was not performed");
  if (reasons.length > 0) {
    return { ...base, reading: "UNMEASURED", unmeasuredReasons: reasons };
  }

  const order = compareVersions(input.treeVersion!, input.publishedVersion!);
  if (order === null) {
    return {
      ...base,
      reading: "UNMEASURED",
      unmeasuredReasons: [
        `cannot order ${JSON.stringify(input.treeVersion)} against ${JSON.stringify(input.publishedVersion)}`,
      ],
    };
  }
  if (order > 0) return { ...base, reading: "AHEAD", unmeasuredReasons: [] };
  if (order < 0) return { ...base, reading: "BEHIND", unmeasuredReasons: [] };
  return {
    ...base,
    reading: contentAgrees(input.difference!) ? "MATCHED" : "DIVERGED",
    unmeasuredReasons: [],
  };
}

/**
 * The single refusal. One binding, so there is one thing to mutate.
 *
 * A projection of `reading` and nothing else — a second predicate over the
 * same facts would always agree with this one and would survive any mutation
 * of it.
 */
export function artifactViolations(s: ArtifactStanding): string[] {
  if (s.reading === "UNMEASURED") {
    return [
      `UNMEASURED: the published artifact was not compared against this tree — ` +
        s.unmeasuredReasons.join("; ") +
        `. A comparison that could not be taken is not one that passed.`,
    ];
  }
  if (s.reading === "DIVERGED") {
    const d = s.difference!;
    return [
      `rungate@${s.publishedVersion} on the registry and the ${s.treeVersion} tree are ` +
        `DIFFERENT SOFTWARE under the SAME version string: ${d.differing.length} of the published ` +
        `artifact's ${d.publishedCount} files differ in content, ${d.onlyLocal.length} files the ` +
        `tree would publish are absent from it, and ${d.onlyPublished.length} of its files are gone ` +
        `from the tree` +
        (s.commitsAhead === null ? "" : ` (${s.commitsAhead} commits since the published tag)`) +
        `. Bump package.json so the two names stop claiming to be one thing, or cut the release.`,
    ];
  }
  return [];
}

/**
 * Commits between `v<version>` and `HEAD`. `null` is a reading nobody took.
 *
 * Never gated on: a shallow CI checkout has no tags, so a refusal here would
 * fire on the ordinary case. It is reported so staleness is a number someone
 * can read, which is the half of #875 that is informational rather than a gate.
 */
export function publishedTagDistance(
  root: string,
  version: string,
  run: RunCommand,
): { commits: number | null; note: string | null } {
  const tag = `v${version}`;
  const probe = run(["git", "rev-parse", "--verify", `${tag}^{commit}`], root);
  if (probe.status !== 0) {
    return { commits: null, note: `tag ${tag} is not in this checkout (a shallow clone has none)` };
  }
  const r = run(["git", "rev-list", "--count", `${tag}..HEAD`], root);
  if (r.status !== 0) return { commits: null, note: `git rev-list failed: ${r.stderr.trim()}` };
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) ? { commits: n, note: null } : { commits: null, note: `unreadable count ${r.stdout.trim()}` };
}

/**
 * Take every reading and produce one standing. Any throw becomes `UNMEASURED`.
 *
 * The catch is what makes an unreachable registry reportable instead of a
 * crash — and `artifactViolations` refuses `UNMEASURED`, so it is not a
 * fail-open. The distinction matters: this converts an exception into a
 * REFUSAL, not into a pass.
 */
export async function measureArtifactStanding(opts: {
  pkg: string;
  root: string;
  run: RunCommand;
  latestVersion: (pkg: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  base?: string;
}): Promise<ArtifactStanding> {
  let treeVersion: string | null = null;
  let publishedVersion: string | null = null;
  let difference: ContentDifference | null = null;
  const reasons: string[] = [];

  let local: ArtifactFile[] = [];
  try {
    const pack = localArtifact(opts.root, opts.run);
    treeVersion = pack.version;
    local = pack.files;
  } catch (e) {
    reasons.push((e as Error).message);
  }

  try {
    publishedVersion = await opts.latestVersion(opts.pkg);
  } catch (e) {
    reasons.push(`registry: ${(e as Error).message}`);
  }

  if (publishedVersion !== null && local.length > 0) {
    try {
      const remote = await publishedArtifact(opts.pkg, publishedVersion, {
        fetchImpl: opts.fetchImpl,
        base: opts.base,
      });
      difference = contentDifference(local, remote);
    } catch (e) {
      reasons.push((e as Error).message);
    }
  }

  const distance =
    publishedVersion === null
      ? { commits: null, note: "no published version to measure from" }
      : publishedTagDistance(opts.root, publishedVersion, opts.run);

  return artifactStanding({
    treeVersion,
    publishedVersion,
    difference,
    commitsAhead: distance.commits,
    distanceNote: distance.note,
    unmeasuredReasons: reasons,
  });
}
