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
  lines: string[];
}

interface JobBlock {
  name: string;
  lines: string[];
}

// ── reading the shape of a workflow file ───────────────────────────────────

function splitTopLevel(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { key: "", lines: [] };
  for (const line of text.split("\n")) {
    const m = TOP_LEVEL_KEY.exec(line);
    if (m) {
      if (cur.key !== "" || cur.lines.length > 0) out.push(cur);
      cur = { key: m[1], lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
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

/** Split trailing blank lines off a block. */
function splitTrailingBlanks(lines: string[]): [string[], string[]] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return [lines.slice(0, end), lines.slice(end)];
}

function jobsSectionOf(sections: Section[]): Section | undefined {
  return sections.find(s => s.key === "jobs");
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
 */
export function mergeManagedWorkflow(
  before: string,
  generated: string,
  overrides: readonly string[] = [],
): string {
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
    const merged =
      gen !== undefined && !declined.has(section.key)
        ? mergeTopLevelSection(consumer, gen)
        : consumer.lines;
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
    ordered.push(...sectionFor(section));
    emitted.add(section.key);
  }
  // Generated keys the consumer does not have, appended in generated order.
  // Preserving the consumer's layout must not mean refusing to take anything
  // new.
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
    ordered.push(...splitTrailingBlanks(section.lines)[0]);
    ordered.push("");
  }
  // A `before` with no top-level key at all — empty, or something that is not
  // a workflow — has no layout to preserve and nothing to carry, so the
  // generated file is the answer. Returned directly rather than walked by a
  // second merge loop: two code paths producing the same bytes for the same
  // input is one decider too many, and the dead one is the one no mutation
  // can reach.
  return b.some(s => s.key !== "") ? ordered.join("\n") : generated;
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
