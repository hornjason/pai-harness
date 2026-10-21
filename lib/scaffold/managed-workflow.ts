/**
 * managed-workflow.ts — deciding what a re-scaffold is allowed to do to a
 * workflow file a consumer has since edited (#216).
 *
 * `createCiWorkflows` ended in two unconditional `writeFileSync` calls, and
 * re-scaffolding is the documented way both to onboard a consumer AND to
 * update one. So every update destroyed whatever the consumer had added to
 * `.github/workflows/ci.yml`. That is the whole of SUCCESS.md claim 5 — the
 * harness works on a repo that is not this one — and it could not be claimed
 * while the first real consumer's build would be deleted by the second run.
 *
 * ## The one hard problem
 *
 * Given a file on disk and a freshly generated one, the harness has to tell
 * three things apart:
 *
 *   a. content the harness wrote and is now regenerating differently
 *      (a config change: a shorter branch list, a different bun version)
 *   b. content the consumer added that the harness can carry over (a job)
 *   c. content the consumer added that the harness CANNOT carry over (a step
 *      inside a job the harness owns, a hand-written file predating rungate)
 *
 * Text comparison alone cannot separate (a) from (c): both look like "a line
 * that was there and is not in the new output". So the harness records what it
 * wrote. Every file it writes carries
 *
 *     # rungate-managed-sha256: <hex>
 *
 * over the harness-authored region with the marker line removed. On the next
 * run that region is reconstructed out of the file on disk and re-hashed. A
 * match proves the harness authored every line of it, so those lines may be
 * replaced freely — that is case (a). No match, or no marker at all, means the
 * harness can prove nothing, and anything it would drop is treated as the
 * consumer's — case (c), which is refused rather than written.
 *
 * Case (b) is the merge: consumer-only jobs and consumer-only top-level keys
 * are carried into the new output verbatim.
 *
 * ## Deliberately fail-closed
 *
 * When the harness cannot prove it wrote something, it refuses. A consumer
 * whose ci.yml predates rungate gets a refusal on first scaffold rather than a
 * replaced build, and `--force` is the only thing that overrides it. A refusal
 * a consumer has to read is cheap; a deleted deploy job is not.
 */
import { createHash } from "crypto";

/** Prefix of the single line recording what the harness authored. */
export const MANAGED_MARKER_PREFIX = "# rungate-managed-sha256: ";

/** A top-level YAML key at column zero. Block scalars are always indented. */
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_.\-]*):(?:\s|$)/;

export type ManagedWriteVerb = "CREATED" | "UPDATED" | "REPLACED" | "SKIP" | "REFUSED";

export interface ManagedWritePlan {
  verb: ManagedWriteVerb;
  /** Bytes to write. Meaningless for SKIP and REFUSED — nothing is written. */
  content: string;
  /** Lines in the proposed content minus lines in the file on disk. 0 for a new file. */
  lineDelta: number;
  /** Jobs in the file on disk holding content the write would lose. */
  atRiskJobs: string[];
  /** Non-blank lines the write would lose and the harness cannot prove it wrote. */
  lostLines: string[];
  /** Populated only when verb === "REFUSED". Names the jobs and the line delta. */
  refusal: string | null;
}

interface Section {
  key: string;
  /**
   * The contiguous comment block introducing this key, held apart from the
   * section it precedes so it can travel with the key (#941).
   *
   * Empty for the leading preamble and for any key with nothing above it.
   * `[...intro, ...lines]` is always the section as it appeared in the file.
   */
  intro: string[];
  lines: string[];
}

interface JobBlock {
  name: string;
  lines: string[];
}

// ── reading the shape of a workflow file ───────────────────────────────────

/**
 * Split the comment block introducing the NEXT top-level key off the end of a
 * section (#941).
 *
 * The same rule `parseSubKeys` applies one level down, and deliberately so:
 * a run of comments immediately above a key belongs to that key, because the
 * whole reason to read this structure is to carry a generated key into a
 * consumer's file and a key carried without its reason is a key the next
 * person deletes. Two mechanisms for associating comments with keys would be
 * worse than the bug, so `isIntroLine` is the one place that decides.
 *
 * Column zero only. A top-level key's comment is never indented, and an
 * indented one is commentary inside the mapping above — `permissions:` carries
 * eight lines of it, and moving those onto the next key would be the #482
 * incident with the harness holding the pen.
 *
 * Blank lines leading the block stay behind: they separate it from the section
 * above rather than introducing the key below. A suffix of nothing but blanks
 * is layout, and is left alone.
 */
function splitIntroducingComment(lines: string[]): [string[], string[]] {
  const isIntroLine = (l: string) => l.trim() === "" || l.startsWith("#");
  let at = lines.length;
  while (at > 0 && isIntroLine(lines[at - 1])) at--;
  while (at < lines.length && lines[at].trim() === "") at++;
  if (at >= lines.length || !lines[at].startsWith("#")) return [lines, []];
  return [lines.slice(0, at), lines.slice(at)];
}

function splitTopLevel(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { key: "", intro: [], lines: [] };
  for (const line of text.split("\n")) {
    const m = TOP_LEVEL_KEY.exec(line);
    if (m) {
      if (cur.key !== "" || cur.lines.length > 0) out.push(cur);
      cur = { key: m[1], intro: [], lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);

  // Move each introducing comment block onto the key it introduces (#941).
  //
  // The leading preamble is exempt. It is the managed banner — the one part of
  // the file the harness authors outright, replaced whole by the merge — and
  // reading it as an introduction to `name:` would hand the banner to a
  // consumer section and lose it the moment the consumer already had one.
  for (let i = 1; i < out.length; i++) {
    const above = out[i - 1];
    if (above.key === "") continue;
    const [kept, intro] = splitIntroducingComment(above.lines);
    above.lines = kept;
    out[i].intro = intro;
  }
  return out;
}

/**
 * Split a `jobs:` section into its header and one block per job.
 *
 * A job starts at the shallowest indentation in the section, which is how YAML
 * mapping keys work. Each block keeps every line up to the next job — blank
 * lines included — so putting the blocks back together is byte-exact.
 */
function parseJobsSection(lines: string[]): { head: string[]; jobs: JobBlock[] } {
  const body = lines.slice(1);
  let base = -1;
  for (const l of body) {
    if (l.trim() === "") continue;
    // Comments do not set the indentation of a YAML mapping, and a consumer's
    // trailing `# note` at column zero lands in this section because it is not
    // a top-level key. Letting it set `base` to 0 made every job fail the
    // `indent === base` test, so the whole mapping was read as section head
    // and the merge dropped every consumer job — caught by the loss count
    // rather than written, but a silent destruction one refusal away.
    if (l.trimStart().startsWith("#")) continue;
    const indent = l.length - l.trimStart().length;
    if (base < 0 || indent < base) base = indent;
  }
  const isJobStart = (l: string) =>
    base >= 0 &&
    l.length - l.trimStart().length === base &&
    /^[A-Za-z0-9_.\-]+:\s*(#.*)?$/.test(l.trim());

  const head = [lines[0]];
  const jobs: JobBlock[] = [];
  for (const l of body) {
    if (isJobStart(l)) {
      jobs.push({ name: l.trim().replace(/:.*$/, ""), lines: [l] });
    } else if (jobs.length === 0) {
      head.push(l);
    } else {
      jobs[jobs.length - 1].lines.push(l);
    }
  }
  return { head, jobs };
}

interface SubBlock {
  key: string;
  lines: string[];
}

/**
 * Split a non-`jobs` top-level section into its key line and one block per
 * sub-key (#839).
 *
 * The same shape `parseJobsSection` reads, with two deliberate differences.
 * A sub-key here may carry a value on its own line (`contents: read`), which a
 * job name never does. And a run of comments immediately above a sub-key
 * belongs to that sub-key rather than to the one before it, because the whole
 * point of reading this structure is to carry a generated sub-key into a
 * consumer's file and the generated `merge_group:` is eleven lines of comment
 * explaining why it has no `branches:` filter. Carrying the key without its
 * reason is how the next person deletes it.
 *
 * That is the opposite of the rule for TOP-LEVEL keys, where a comment stays
 * with the key above it (#482) — top-level sections are never relocated, so
 * nothing there needs to travel.
 */
function parseSubKeys(lines: string[]): { head: string[]; blocks: SubBlock[] } {
  const body = lines.slice(1);
  let base = -1;
  for (const l of body) {
    if (l.trim() === "") continue;
    if (l.trimStart().startsWith("#")) continue;
    const indent = l.length - l.trimStart().length;
    // A column-zero line inside a section is a trailing comment or stray text,
    // never a sub-key. Letting it set `base` to 0 is the bug
    // `parseJobsSection` records for comments; here the guard is structural.
    if (indent === 0) continue;
    if (base < 0 || indent < base) base = indent;
  }
  const isSubKey = (l: string) =>
    base > 0 &&
    l.length - l.trimStart().length === base &&
    /^[A-Za-z0-9_.\-]+:(\s|$)/.test(l.trim());

  const head = [lines[0]];
  const blocks: SubBlock[] = [];
  /** Comments and blanks held back until we know what they introduce. */
  let pending: string[] = [];
  const open = () => (blocks.length === 0 ? head : blocks[blocks.length - 1].lines);
  for (const l of body) {
    if (isSubKey(l)) {
      blocks.push({ key: l.trim().replace(/:.*$/, ""), lines: [...pending, l] });
      pending = [];
      continue;
    }
    if (l.trim() === "" || l.trimStart().startsWith("#")) {
      pending.push(l);
      continue;
    }
    open().push(...pending, l);
    pending = [];
  }
  // Whatever is left introduces nothing; it stays where the consumer put it.
  open().push(...pending);
  return { head, blocks };
}

/**
 * The consumer's section with the generated sub-keys it does not have appended
 * (#839).
 *
 * Only the sub-keys it does NOT have. A sub-key both sides declare is a local
 * knob — a branch list, a runner label, a permission the consumer widened —
 * and the consumer's value stands. What the harness takes back is the
 * STRUCTURE: a trigger or a permission the generator learned since this file
 * was written, which under the previous rule could never reach an already
 * scaffolded repo at all because every non-`jobs` key the consumer had was
 * the consumer's whichever side the merge was walking.
 *
 * Appended rather than interleaved, for the reason the whole of #482 exists:
 * a key that moves away from the comment introducing it reads as a deletion.
 */
/**
 * The consumer's sub-keys that this generator computes and has stopped
 * emitting (#923).
 *
 * Read off the SAME `parseSubKeys` both sides of the merge read, so the thing
 * removed and the thing reported removed cannot be two different readings.
 * The scalar guard is the same one `mergeTopLevelSection` opens with and for
 * the same reason: `permissions: read-all` has no sub-keys to withdraw.
 */
function revokedSubKeys(
  section: string,
  before: Section,
  generated: Section,
  computed: ComputedSubKeys,
): RevokedSubKey[] {
  const owned = computed.get(section);
  if (owned === undefined) return [];
  if (!/^[A-Za-z_][A-Za-z0-9_.\-]*:\s*(#.*)?$/.test(before.lines[0])) return [];
  const emitted = new Set(parseSubKeys(generated.lines).blocks.map(s => s.key));
  return parseSubKeys(before.lines)
    .blocks.filter(s => owned.has(s.key) && !emitted.has(s.key))
    .map(s => ({ section, key: s.key, lines: s.lines }));
}

/**
 * The consumer's section with the revoked sub-keys taken out (#923).
 *
 * Reassembled from `parseSubKeys` rather than filtered by line value: a
 * revoked block carries the blank line and the comment block that introduce
 * it, and dropping those by value would take every other blank in the section
 * with them. `parseSubKeys` places every body line in exactly one block in
 * file order, so head followed by the surviving blocks IS the section minus
 * what was withdrawn — and with nothing to withdraw it is the section
 * unchanged, which is why the caller still runs the untouched merge after it.
 */
function withoutRevoked(before: Section, revoked: readonly RevokedSubKey[]): Section {
  if (revoked.length === 0) return before;
  const gone = new Set(revoked.map(r => r.key));
  const parsed = parseSubKeys(before.lines);
  return {
    ...before,
    lines: [...parsed.head, ...parsed.blocks.filter(s => !gone.has(s.key)).flatMap(s => s.lines)],
  };
}

function mergeTopLevelSection(before: Section, generated: Section): string[] {
  // A scalar on the consumer's side (`permissions: read-all`, `on: [push]`)
  // has nowhere to put a sub-key, and appending one produces YAML that does
  // not parse. The consumer's spelling stands.
  //
  // Read off the KEY LINE and not off "the consumer declared no sub-keys":
  // a bare `permissions:` with nothing under it is an empty mapping, not a
  // scalar, and it is exactly the shape an older generator leaves behind when
  // the only sub-key it knew has since been renamed. Treating the two the
  // same is how `permissions.contents` failed to converge — caught by #840's
  // skew loop, which rewinds every sub-key rather than the one that was on
  // somebody's mind.
  if (!/^[A-Za-z_][A-Za-z0-9_.\-]*:\s*(#.*)?$/.test(before.lines[0])) return before.lines;

  const b = parseSubKeys(before.lines);
  const have = new Set(b.blocks.map(s => s.key));
  const extra = parseSubKeys(generated.lines).blocks.filter(s => !have.has(s.key));
  if (extra.length === 0) return before.lines;

  const [kept, trailing] = splitTrailingBlanks(before.lines);
  return [...kept, ...extra.flatMap(s => splitTrailingBlanks(s.lines)[0]), ...trailing];
}

/**
 * The sub-keys one generated workflow COMPUTES, by the top-level key they sit
 * under (#923).
 *
 * Declared by the caller, never here. `HARNESS_COMPUTED_SUBKEYS` in
 * `lib/scaffold/steps.ts` names it per FILE, because the scope is the whole
 * risk: this merge runs over every managed workflow, and a map keyed by
 * section alone makes `permissions.id-token` revocable in files whose
 * generator never emits it under any config. A consumer with a deploy job of
 * their own and `id-token: write` in that workflow's `permissions:` would
 * have it withdrawn by a feature that was not reasoning about their file.
 *
 * Which is #923's own defect wearing the other hat: the issue is about a
 * grant outliving its reason, and an unscoped revoker is a WITHDRAWAL
 * outliving its reason. The symmetry is the argument for scoping it tightly.
 *
 * Empty is the default at every seam, so a caller that declares nothing
 * revokes nothing.
 */
export type ComputedSubKeys = ReadonlyMap<string, ReadonlySet<string>>;

const NO_COMPUTED_SUBKEYS: ComputedSubKeys = new Map();

/** A sub-key the merge withdrew because the generator stopped emitting it (#923). */
export interface RevokedSubKey {
  /** The top-level key it sat under. */
  section: string;
  /** The sub-key itself. */
  key: string;
  /** Its lines as they stood in the consumer's file, comment block included. */
  lines: string[];
}

/**
 * Opening of the line the merge writes where a consumer has declined a
 * generated key (#839).
 *
 * Stable prefix, because it is matched to strip the previous run's copy before
 * the current one is written — the comment has to disappear when the config
 * entry does, or a consumer who opts back in keeps reading that they have not.
 * `resolveManagedWrite` knows this prefix for the same reason it knows the
 * managed banner: a refusal is only useful when it is about somebody else's
 * work, and this line is the harness's.
 */
export const WORKFLOW_OVERRIDE_COMMENT =
  "# rungate: ci.workflowOverrides in .claude/rungate/config.json declares this key the consumer's";

/** The harness's note on a declined key, naming the key and the config path. */
function overrideNotice(key: string, indent: string): string {
  return `${indent}${WORKFLOW_OVERRIDE_COMMENT} — the generated \`${key}:\` is not merged into it.`;
}

/**
 * Top-level workflow keys this consumer has taken back from the generator
 * (#839).
 *
 * The escape hatch that makes the key-wise merge safe to turn on. Structural
 * keys are the harness's by default; a consumer who needs a different CI —
 * self-hosted runners declared in `on:`, a permission model the generator
 * cannot know about — names the key here and the merge leaves it alone and
 * says so in the file.
 *
 * `jobs` is refused rather than honoured. Job ownership already has a
 * mechanism (`HARNESS_OWNED_JOBS` and the job merge), and a second one that
 * silently freezes `test` and `gates` would leave a consumer with a required
 * check nothing regenerates. Read through the same `harness?.ci` binding as
 * `shardCount` and `globalToolInstallStep`; a malformed value yields no
 * overrides, which is the direction that keeps the harness in charge rather
 * than the one that quietly hands everything over.
 *
 * Declared here rather than in `steps.ts`, which re-exports it unchanged, so
 * that `lib/conformity.ts` can ask the same question (#915) without importing
 * the generator.
 */
export function workflowOverrides(ci: unknown): string[] {
  const raw = (ci as { workflowOverrides?: unknown } | null | undefined)?.workflowOverrides;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (k): k is string => typeof k === "string" && k !== "jobs" && OVERRIDE_KEY.test(k),
  );
}

const OVERRIDE_KEY = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/*
 * There was an `overrideNoticeKeys` parser here (#915), reading the notices
 * back out of a workflow so `workflow-drift.ts` could treat them as a second
 * source of ownership beside `ci.workflowOverrides`. #958 deleted its only
 * caller: a notice is a comment anybody can type, so reading it back let a
 * hand-edited workflow exempt itself from the drift check. The notice is
 * written FOR A HUMAN READING THE FILE — it says why a key they edited was
 * left alone — and it is not evidence of anything on the way back in.
 *
 * `stripOverrideNotices` below still matches on the prefix, because removing
 * last run's notices before re-merging is a different job from believing
 * them.
 */

/**
 * Drop every previous run's override notice, wherever in the file it sits.
 *
 * Over the whole document rather than per section, and before anything is
 * parsed. A notice written at column zero for a key the consumer did not have
 * lands in whatever section follows it on the next read — including `jobs:`,
 * where it would ride along with a preserved consumer job while a fresh copy
 * was appended, one more line every run.
 */
function stripOverrideNotices(text: string): string {
  return text
    .split("\n")
    .filter(l => !l.trim().startsWith(WORKFLOW_OVERRIDE_COMMENT))
    .join("\n");
}

/**
 * What the CALLER was able to prove about the file on disk (#957).
 *
 * `VERIFIED` means the bytes handed in as `before` still hash to the digest a
 * previous harness run stamped on them, so the harness wrote every one of
 * them. `UNPROVEN` is every other reading — no marker, a marker that no longer
 * matches, or a caller that did not look — and they are deliberately one
 * value: a reading nobody took and a reading that came back negative are both
 * "the harness cannot prove this", which is the only distinction the merge
 * acts on.
 *
 * The merge cannot compute this itself. The marker is stripped one layer up,
 * before anything is parsed, because `resolveManagedWrite` treats every line
 * outside a job as the consumer's and the marker line would otherwise refuse
 * its own update (#722/#767). So the proof has to arrive as an argument, which
 * is why #957 was filed rather than bundled into #941.
 */
export type MergeProvenance = "VERIFIED" | "UNPROVEN";

/**
 * The generated comment block to write above a key the consumer ALREADY has,
 * or nothing (#957).
 *
 * #941 made a section the merge ADDS arrive with its introducing comment, and
 * deliberately left a section the consumer already has alone — comments
 * included. That is right, and it leaves a residue: a consumer who took the
 * bare key through the defect holds it for ever, because the key is present
 * from then on and nothing ever puts the reasoning back. **This repository was
 * one of them.**
 *
 * Two conditions, and the second is what makes the first safe to act on.
 *
 * - **The harness can prove it wrote these bytes.** Presence is the wrong
 *   discriminator: "the consumer wrote this section bare" and "the harness
 *   wrote it bare, through the bug" look identical, and repairing on absence
 *   re-imposes a comment on every consumer who deliberately DELETED one, every
 *   run, with no way to opt out short of `ci.workflowOverrides`. A harness that
 *   cannot be disagreed with is the thing the refusal path exists to avoid.
 * - **The consumer has written no commentary of their own.** #917's precedent
 *   one level up: where both sides have said something about the same thing,
 *   the consumer's stands. A comment is the consumer's statement about their
 *   own file and replacing one is the data loss #216 exists to prevent.
 *
 * Idempotent by the same condition that gates it. After one run the key has a
 * block, so `consumerIntro` is non-empty on every run after, and the inverse
 * defect — a copy appended per upgrade, with nothing stripping the last one —
 * cannot arise.
 *
 * **What this does NOT claim**, said here rather than left as an omission. A
 * verified marker proves the harness WROTE the bytes, not that it AUTHORED
 * them: the merge carries a consumer's sub-key values forward and re-stamps,
 * so a consumer who set `cancel-in-progress: true` by hand and re-scaffolded
 * will receive the generator's explanation of why it is an expression. That is
 * the generator explaining its own default above a value the consumer chose —
 * a comment they can delete, after which this never fires again — and it is a
 * better outcome than the file staying silent. Narrowing it further, to a
 * section byte-identical to the generated one, would make the repair
 * unreachable for every consumer the moment the generator changes a value.
 *
 * One exported binding, so there is one thing to mutate. It takes plain data
 * rather than a `Section`, so a case can drive it without constructing the
 * parser's internals.
 */
export function restorableIntro(args: {
  provenance: MergeProvenance;
  consumerIntro: readonly string[];
  generatedIntro: readonly string[];
}): string[] {
  if (args.provenance !== "VERIFIED") return [];
  if (args.consumerIntro.length > 0) return [];
  return [...args.generatedIntro];
}

/** Split trailing blank lines off a block. */
function splitTrailingBlanks(lines: string[]): [string[], string[]] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return [lines.slice(0, end), lines.slice(end)];
}

function jobsSectionOf(sections: Section[]): Section | undefined {
  return sections.find(s => s.key === "jobs");
}

/**
 * Opening of the banner every harness-generated workflow carries.
 *
 * Deliberately the stable prefix and not the whole sentence: the rest of it
 * names the config path, and that is exactly the part that changed and caused
 * the harness to refuse to update its own file.
 */
export const MANAGED_BANNER_PREFIX = "# Managed by rungate";

/**
 * The part of the leading preamble `mergeManagedWorkflow` replaces (#834).
 *
 * The merge states its own ownership rule at the preamble: *"the consumer's
 * leading preamble is replaced by the generated one, which carries the
 * managed banner — it is the one part of the file the harness does author."*
 * The write's loss set did not agree. It whitelisted only the banner LINE, so
 * the prose underneath it read as the consumer's, and a consumer that added
 * `ci.vertex` had its whole re-scaffold REFUSED over three lines of the
 * harness's own "no credential is configured" paragraph — the paragraph the
 * new header, the one saying a federation now exists, is there to replace.
 *
 * Two deciders about the same bytes, disagreeing, and the merge is the one
 * that was right: it computed the correct file and the write declined to put
 * it on disk. That is what kept `id-token: write` off every already
 * scaffolded consumer, and it is why #839's sub-key merge — which adds a
 * generated sub-key the consumer lacks, `id-token` included — could not reach
 * `ai-review.yml` either. One refusal, two features.
 *
 * It starts AT the banner, not at line one. A comment a consumer wrote above
 * the banner is still theirs, is still dropped by the merge, and must still
 * make the write refuse — widening this to the whole preamble would turn that
 * refusal into a silent deletion.
 */
export function managedPreamble(text: string): string[] {
  const head = splitTopLevel(text).find(s => s.key === "");
  if (!head) return [];
  const start = head.lines.findIndex(l => l.startsWith(MANAGED_BANNER_PREFIX));
  return start < 0 ? [] : head.lines.slice(start);
}

/** Every top-level key a workflow declares, in file order (#482). */
export function topLevelKeyOrder(text: string): string[] {
  return splitTopLevel(text).map(s => s.key).filter(k => k !== "");
}

/**
 * Top-level keys declared more than once, in first-seen order (#482).
 *
 * YAML forbids duplicate mapping keys and GitHub Actions rejects the file, so
 * this is not a style question — it is a workflow that will not run. It
 * happens when somebody restores a block they believe the merge deleted and
 * the original is still further down, which is the incident this issue is
 * about.
 *
 * The repo has no YAML dependency on purpose — every reader in this file
 * parses the shape by hand — so the property detected is the one that causes
 * the parse error rather than the parser's message.
 */
export function duplicateTopLevelKeys(text: string): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const key of topLevelKeyOrder(text)) {
    if (seen.has(key) && !dupes.includes(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}

export interface MovedKey {
  key: string;
  from: number;
  to: number;
}

/**
 * Top-level keys that changed line position between two versions (#482).
 *
 * **Keys added or removed are excluded, deliberately.** They shift the index
 * of everything after them, so counting those as movement makes the signal
 * fire on the ordinary case — a scaffold adding its own key — and a report
 * that fires every time is a report nobody reads. What is left is the thing
 * worth saying: a key that exists in both and is somewhere else.
 */
export function movedTopLevelKeys(before: string, after: string): MovedKey[] {
  const index = (text: string): Map<string, number> => {
    const out = new Map<string, number>();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = TOP_LEVEL_KEY.exec(lines[i]);
      if (m && !out.has(m[1])) out.set(m[1], i);
    }
    return out;
  };
  const b = index(before);
  const a = index(after);

  // Movement is a change of RANK among the keys both versions have, not a
  // change of line number. A key inserted above `b` moves `b`'s line and
  // leaves its position in the file's structure exactly where the consumer
  // put it; reporting that would fire on every scaffold that adds a key.
  const common = [...b.keys()].filter(k => a.has(k));
  const rankBefore = new Map(common.slice().sort((x, y) => b.get(x)! - b.get(y)!).map((k, i) => [k, i]));
  const rankAfter = new Map(common.slice().sort((x, y) => a.get(x)! - a.get(y)!).map((k, i) => [k, i]));

  const moved: MovedKey[] = [];
  for (const key of common) {
    if (rankBefore.get(key) === rankAfter.get(key)) continue;
    moved.push({ key, from: b.get(key)!, to: a.get(key)! });
  }
  return moved;
}

/** Every job name in a workflow file, in file order. */
export function jobNames(text: string): string[] {
  const jobs = jobsSectionOf(splitTopLevel(text));
  return jobs ? parseJobsSection(jobs.lines).jobs.map(j => j.name) : [];
}

// ── the merge ──────────────────────────────────────────────────────────────

/**
 * Job names the harness owns whether or not it emitted one this run (#728).
 *
 * `mergeJobsSection` decides ownership by asking whether the GENERATED file
 * contains a job of that name, which is correct for every job the harness
 * always emits and wrong for one it emits conditionally. `test-shard` exists
 * only when `ci.shards > 1`: turn sharding back off and the previous run's
 * matrix is absent from the generated side, so it reads as a consumer job
 * and is carried forward — leaving an orphan that runs the whole suite once
 * per leg, forever, with nothing in the diff explaining where it came from.
 *
 * A name here is removed when it is not regenerated. Add a conditionally
 * emitted job to this set in the same commit that makes it conditional.
 */
const HARNESS_OWNED_JOBS = new Set(["test", "test-shard", "gates"]);

function mergeJobsSection(before: Section, generated: Section): string[] {
  const g = parseJobsSection(generated.lines);
  const b = parseJobsSection(before.lines);
  const generatedNames = new Set(g.jobs.map(j => j.name));
  const extra = b.jobs.filter(
    j => !generatedNames.has(j.name) && !HARNESS_OWNED_JOBS.has(j.name),
  );
  if (extra.length === 0) return generated.lines;

  const [content, trailing] = splitTrailingBlanks(g.jobs.flatMap(j => j.lines));
  const carried = extra.flatMap(j => splitTrailingBlanks(j.lines)[0]);
  return [...g.head, ...content, ...carried, ...trailing];
}

/**
 * The newly generated file with everything the harness did not author carried
 * across: consumer-only jobs appended to the jobs mapping, consumer-only
 * top-level keys appended to the file.
 *
 * `overrides` names top-level keys the consumer has claimed through
 * `ci.workflowOverrides`. A claimed key is left exactly as the consumer wrote
 * it and carries a comment saying so — deviation is explicit, never implicit,
 * which is the half of #839 that makes the other half safe to ship.
 *
 * `provenance` is what the caller could prove about `before` (#957). It
 * defaults to `UNPROVEN`, which is the fail-closed direction and the
 * pre-#957 behaviour exactly: a caller that has not looked changes nothing.
 */
export function mergeManagedWorkflow(
  before: string,
  generated: string,
  overrides: readonly string[] = [],
  provenance: MergeProvenance = "UNPROVEN",
  computed: ComputedSubKeys = NO_COMPUTED_SUBKEYS,
): string {
  return mergeManagedWorkflowRecording(before, generated, overrides, provenance, computed).content;
}

/**
 * `mergeManagedWorkflow`, plus the derived grants it withdrew (#923).
 *
 * The recording form exists because the write has to agree with the merge
 * about the revocation, and the cheap way to make it agree is the wrong one.
 * Withdrawing `id-token: write` puts that line and the comment introducing it
 * into `resolveManagedWrite`'s loss set — outside any job, outside the
 * leading preamble, nothing covering them — and the whole re-scaffold REFUSES
 * over two lines the harness wrote itself. That is #834's failure reached
 * from the other direction.
 *
 * The fix is not a second computation in the write of which lines ought to be
 * revoked. Two deciders about the same bytes is what #834 actually was, and
 * the merge was the one that was right. So the merge reports the lines it
 * removed and the write whitelists THOSE, which is why this returns blocks
 * rather than a count.
 *
 * `mergeManagedWorkflow` is the thin wrapper and not the other way round:
 * there is one merge, and a caller that does not need the record reads
 * `.content`.
 */
export function mergeManagedWorkflowRecording(
  before: string,
  generated: string,
  overrides: readonly string[] = [],
  provenance: MergeProvenance = "UNPROVEN",
  computed: ComputedSubKeys = NO_COMPUTED_SUBKEYS,
): { content: string; revoked: RevokedSubKey[] } {
  const revoked: RevokedSubKey[] = [];
  const b = splitTopLevel(stripOverrideNotices(before));
  const g = splitTopLevel(generated);
  const generatedKeys = new Set(g.map(s => s.key));
  const beforeJobs = jobsSectionOf(b);
  const declined = new Set(overrides);
  const beforeByKey = new Map(b.filter(s => s.key !== "").map(s => [s.key, s] as const));

  // Walk the CONSUMER's sections, not the generated ones (#482).
  //
  // The previous form emitted the generated order and appended the consumer's
  // extra keys at the end. Nothing was lost — `lostLines` is a line set and
  // correctly stayed quiet — but `concurrency:` arrived 460 lines below the
  // comment introducing it, because a comment above a top-level key lives in
  // the section of the key ABOVE it and so does not travel. A reader of the
  // resulting diff concluded the block had been deleted and restored it by
  // hand; the file then declared the key twice and stopped parsing.
  //
  // So the consumer's order is the order. The harness owns the jobs it
  // generates and its own preamble; it does not own where in the file the
  // consumer's keys sit, and moving them manufactures a deletion signal that
  // is more expensive than a deletion.
  const generatedByKey = new Map(g.filter(s => s.key !== "").map(s => [s.key, s] as const));
  const emitted = new Set<string>();
  const sectionFor = (section: Section): string[] => {
    if (section.key === "jobs" && beforeJobs) {
      const generatedJobs = generatedByKey.get("jobs");
      return generatedJobs ? mergeJobsSection(beforeJobs, generatedJobs) : section.lines;
    }
    // Every non-jobs key the consumer already has is merged SUB-KEY BY
    // SUB-KEY (#839).
    //
    // It used to be returned whole, on the reasoning that the generated `on:`
    // is a default for a file that does not exist yet and not a claim on one
    // that does. True of a one-time default, and wrong for a fleet: it made
    // scaffold ORDER decide ownership, so no CI improvement the harness ever
    // made could reach a repo it had already scaffolded. Measured 2026-10-20 —
    // a consumer scaffolded before the generator learned `merge_group:` could
    // not be given it by any number of re-scaffolds, and enabling a merge
    // queue there would hang every entry on a check that never reports.
    //
    // What replaced it keeps the part that was right. The consumer's value for
    // a sub-key both sides declare still wins, and the consumer's top-level
    // order is untouched; only a sub-key the consumer does not have at all is
    // added.
    const consumer = beforeByKey.get(section.key);
    if (section.key === "" || consumer === undefined) return section.lines;
    const gen = generatedByKey.get(section.key);
    // A derived grant the generator has stopped computing is withdrawn before
    // the sub-key merge runs, never after: the merge's job is to carry what
    // the generator newly emits INTO the consumer's section, and running it
    // over a section that still holds a withdrawn key would have it decide
    // ownership of a line that is on its way out (#923).
    //
    // Inside the `!declined` arm, deliberately. A consumer who has named this
    // top-level key in `ci.workflowOverrides` has taken the whole block back,
    // and revoking a sub-key out of a block the harness has just declared not
    // its own is the deletion-without-a-route that #839's escape hatch exists
    // to make impossible.
    let merged: string[];
    if (gen !== undefined && !declined.has(section.key)) {
      const withdrawn = revokedSubKeys(section.key, consumer, gen, computed);
      revoked.push(...withdrawn);
      merged = mergeTopLevelSection(withoutRevoked(consumer, withdrawn), gen);
    } else {
      merged = consumer.lines;
    }
    // The notice is re-made from the current config every run — never carried
    // — so a consumer who opts back in stops being told they have opted out.
    return declined.has(section.key)
      ? [merged[0], overrideNotice(section.key, "  "), ...merged.slice(1)]
      : merged;
  };

  const ordered: string[] = [];
  for (const section of b) {
    if (section.key === "") {
      // The consumer's leading preamble is replaced by the generated one,
      // which carries the managed banner. It is the one part of the file the
      // harness does author.
      const genHead = g.find(s => s.key === "");
      if (genHead) ordered.push(...genHead.lines);
      continue;
    }
    // The consumer's own introducing comment, emitted unchanged (#941). A key
    // the consumer already has keeps whatever they wrote above it, and the
    // generator's block for that key is not merged in beside it — the same
    // rule #839 applies to a sub-key both sides declare, one level up.
    //
    // Unless the consumer wrote nothing above it AND the harness can prove it
    // wrote the section itself, in which case the block it dropped through
    // #941 is put back (#957). `restorableIntro` returns nothing whenever
    // `section.intro` is non-empty, so this expression is `section.intro`
    // in every case but that one — including a declined key, whose generated
    // counterpart is not consulted at all.
    const genForIntro = declined.has(section.key) ? undefined : generatedByKey.get(section.key);
    ordered.push(
      ...section.intro,
      ...restorableIntro({
        provenance,
        consumerIntro: section.intro,
        generatedIntro: genForIntro?.intro ?? [],
      }),
      ...sectionFor(section),
    );
    emitted.add(section.key);
  }
  // Generated keys the consumer does not have, appended in generated order.
  // Preserving the consumer's layout must not mean refusing to take anything
  // new.
  //
  // With the comment block that introduces each of them (#941). It used to
  // arrive without one: a comment above a top-level key was read as the tail
  // of the section ABOVE it, so the key travelled and its reasoning stayed
  // behind in a section the consumer already had. What landed on every
  // already-scaffolded consumer was a bare
  // `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` in a file
  // headed "do not edit", with nothing anywhere saying why it is an expression
  // rather than `true` — and simplifying it to `true` is what made one
  // consumer cancel its own main-branch CI on every merge. Only brand-new
  // consumers, who get the generated file verbatim, ever saw the reason.
  for (const section of g) {
    if (section.key === "" || emitted.has(section.key)) continue;
    if (declined.has(section.key)) {
      // Declining a key the consumer does not have means not writing it. The
      // notice is still written, at column zero where the key would have
      // gone: an omission nothing records is indistinguishable from a
      // generator that never emitted the key.
      ordered.push(overrideNotice(section.key, ""));
      ordered.push("");
      continue;
    }
    ordered.push(...section.intro, ...splitTrailingBlanks(section.lines)[0]);
    ordered.push("");
  }
  // A `before` with no top-level key at all — empty, or something that is not
  // a workflow — has no layout to preserve and nothing to carry, so the
  // generated file is the answer. Returned directly rather than walked by a
  // second merge loop: two code paths producing the same bytes for the same
  // input is one decider too many, and the dead one is the one no mutation
  // can reach.
  // A `before` with nothing to merge takes the generated file whole, so
  // nothing of the consumer's was withdrawn and the record has to say so —
  // reporting a revocation for a file that was replaced outright would have
  // the scaffold claim it removed a grant it never read.
  return b.some(s => s.key !== "")
    ? { content: ordered.join("\n"), revoked }
    : { content: generated, revoked: [] };
}

/**
 * Reconstruct, out of the file on disk, the region a previous harness run
 * wrote — the exact inverse of `mergeManagedWorkflow`. Consumer-only jobs and
 * consumer-only top-level keys are dropped; nothing else is touched.
 */
export function harnessRegion(before: string, generated: string): string {
  const b = splitTopLevel(before);
  const g = splitTopLevel(generated);
  const generatedKeys = new Set(g.map(s => s.key));
  const generatedJobNames = new Set(jobNames(generated));

  const out: string[] = [];
  for (const section of b) {
    // The introducing block is emitted whether or not the section it belongs
    // to survives (#941). It is where the file had it, and this reconstruction
    // is compared byte-for-byte against the generated text: a consumer who
    // inserted a key of their own between a harness comment and the harness
    // key it introduces must not lose the comment out of the region and turn
    // their next scaffold into a refusal over lines the harness wrote.
    out.push(...section.intro);
    if (section.key !== "" && !generatedKeys.has(section.key)) continue;
    if (section.key !== "jobs") {
      out.push(...section.lines);
      continue;
    }
    const parsed = parseJobsSection(section.lines);
    const [, trailing] = splitTrailingBlanks(parsed.jobs.flatMap(j => j.lines));
    const kept = parsed.jobs
      .filter(j => generatedJobNames.has(j.name))
      .flatMap(j => splitTrailingBlanks(j.lines)[0]);
    out.push(...parsed.head, ...kept, ...trailing);
  }
  return out.join("\n");
}

// ── the marker ─────────────────────────────────────────────────────────────

function stripMarker(text: string): { body: string; marker: string | null } {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l.startsWith(MANAGED_MARKER_PREFIX));
  if (at < 0) return { body: text, marker: null };
  const marker = lines[at].slice(MANAGED_MARKER_PREFIX.length).trim();
  lines.splice(at, 1);
  return { body: lines.join("\n"), marker };
}

function stampMarker(body: string, authored: string): string {
  const sha = createHash("sha256").update(authored).digest("hex");
  return `${MANAGED_MARKER_PREFIX}${sha}\n${body}`;
}

// ── measuring what a write would lose ──────────────────────────────────────

function nonBlank(text: string): string[] {
  return text.split("\n").map(l => l.trim()).filter(l => l !== "");
}

/** Lines of `from` that `minus` does not account for, counting duplicates. */
function multisetSubtract(from: string[], minus: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of minus) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of from) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

/** Which jobs in `text` contain any of `lines`. */
function jobsHolding(text: string, lines: string[]): string[] {
  const wanted = new Set(lines);
  const jobs = jobsSectionOf(splitTopLevel(text));
  if (!jobs) return [];
  return parseJobsSection(jobs.lines)
    .jobs.filter(j => j.lines.some(l => wanted.has(l.trim())))
    .map(j => j.name);
}

// ── the decision ───────────────────────────────────────────────────────────

/**
 * Decide what writing `generated` over `before` should do.
 *
 * `before` is the file on disk, or null when there is none. Nothing here
 * touches the filesystem: the caller writes `plan.content` and reports
 * `plan.verb`, which is why the verb is a measurement of the two contents
 * rather than a guess from whether the path existed.
 */
export function planManagedWrite(
  before: string | null,
  generated: string,
  opts: { force?: boolean } = {},
): ManagedWritePlan {
  const clean = stripMarker(generated).body;

  if (before === null) {
    return {
      verb: "CREATED",
      content: stampMarker(clean, clean),
      lineDelta: 0,
      atRiskJobs: [],
      lostLines: [],
      refusal: null,
    };
  }

  const { body: beforeBody, marker } = stripMarker(before);
  const force = opts.force === true;
  const merged = force ? clean : mergeManagedWorkflow(beforeBody, clean);
  const content = stampMarker(merged, clean);
  const lineDelta = content.split("\n").length - before.split("\n").length;

  if (content === before) {
    return { verb: "SKIP", content, lineDelta: 0, atRiskJobs: [], lostLines: [], refusal: null };
  }

  // Lines the harness can prove it wrote are free to change. Everything else
  // that the write would drop belongs to the consumer.
  //
  // Scoping the whitelist to the REGION rather than to the whole file is not
  // independently observable today, and saying so is cheaper than implying a
  // guard that is not there (.claude/rules/checks-must-be-able-to-fail.md):
  // widening it to `nonBlank(beforeBody)` leaves all 39 tests green, because a
  // verified marker means the merge carried every consumer line, so
  // `before \ merged` holds nothing but harness lines anyway. The narrow form
  // is what stays correct if the merge ever stops carrying something, and the
  // extraction it depends on IS pinned — mutating `harnessRegion` to return
  // its input turns 3 red.
  const region = harnessRegion(beforeBody, clean);
  const provable =
    marker !== null && createHash("sha256").update(region).digest("hex") === marker ? nonBlank(region) : [];
  const lostLines = multisetSubtract(
    multisetSubtract(nonBlank(beforeBody), nonBlank(merged)),
    provable,
  );
  const atRiskJobs = jobsHolding(beforeBody, lostLines);

  if (lostLines.length > 0 && !force) {
    const where = atRiskJobs.length > 0 ? `job(s) ${atRiskJobs.join(", ")}` : "content outside any job";
    return {
      verb: "REFUSED",
      content,
      lineDelta,
      atRiskJobs,
      lostLines,
      refusal:
        `${lostLines.length} line(s) the harness did not author would be lost from ${where} ` +
        `(${before.split("\n").length} -> ${content.split("\n").length} lines, ${lineDelta >= 0 ? "+" : ""}${lineDelta}). ` +
        `Re-run with --force to overwrite, or move the content into a job the harness does not generate.`,
    };
  }

  const removing = lostLines.length > 0 || lineDelta < 0;
  return {
    verb: removing ? "REPLACED" : "UPDATED",
    content,
    lineDelta,
    atRiskJobs,
    lostLines,
    refusal: null,
  };
}
