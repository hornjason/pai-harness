/**
 * create-sc — Generate matchable SC lines from structured input.
 *
 * Deep module: all pattern-to-text logic lives here.
 * Thin consumer: scripts/create-sc.ts is the CLI wrapper.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { ScRegistry } from "./sc-ids";
import { isFixtureScId, scIdsSpelledInSourceReading, SC_SOURCE_DIRS } from "./sc-ids";
import type { ScNamespaceReading, SourceReading } from "./sc-id-cross-tree";
import { readScNamespace } from "./sc-id-cross-tree";
import type { ScReservation, ScReservationReading } from "./sc-reservations";
import {
  lowestFreeInBlock,
  readScReservations,
  RESERVATION_REFUSAL,
  reservationFor,
  reservedCeiling,
  reservedIdCount,
  SC_RESERVATIONS_PATH,
} from "./sc-reservations";
import { tryLoadRungateConfig } from "./config-loader";

// ── Types ─────────────────────────────────────────────────────

export interface RegistryEntry {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

interface ParamDef {
  required: string[];
  generate: (params: Record<string, string>) => string;
}

// ── Registry loading ──────────────────────────────────────────

const _registryCache = new Map<string, RegistryEntry[]>();

function loadBuiltInRegistry(): RegistryEntry[] {
  const key = "__builtin__";
  if (_registryCache.has(key)) return _registryCache.get(key)!;
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json");
  const entries: RegistryEntry[] = JSON.parse(readFileSync(configPath, "utf-8"));
  _registryCache.set(key, entries);
  return entries;
}

/**
 * Load the matcher registry, optionally merging consumer-defined custom matchers.
 *
 * When projectRoot is provided, resolves that project's config through
 * `lib/config-loader.ts` and merges any `customMatchers` array entries with the
 * built-in registry. Consumer entries with the same `name` as a built-in entry
 * override the built-in.
 */
export function loadRegistry(projectRoot?: string): RegistryEntry[] {
  const cacheKey = projectRoot ?? "__builtin__";
  if (_registryCache.has(cacheKey)) return _registryCache.get(cacheKey)!;

  const builtIn = loadBuiltInRegistry();
  if (!projectRoot) {
    return builtIn;
  }

  // Through the loader, so a consumer on the directory layout can supply
  // custom matchers at all — this read was monolith-only, which is #212/#90.
  // The parse failure is NOT caught: the old `catch` returned the built-in
  // registry, so a consumer whose config had a trailing comma silently got
  // rungate's matchers and no indication their own had been dropped.
  const config = tryLoadRungateConfig(projectRoot);
  const customMatchers = (config?.customMatchers ?? []) as RegistryEntry[];
  if (customMatchers.length === 0) {
    _registryCache.set(cacheKey, builtIn);
    return builtIn;
  }

  // Merge: consumer entries override built-in entries with same name
  const merged = builtIn.filter(
    (entry) => !customMatchers.some((c) => c.name === entry.name)
  );
  merged.push(...customMatchers);

  _registryCache.set(cacheKey, merged);
  return merged;
}

// ── Pattern param definitions ─────────────────────────────────

const patternDefs: Record<string, ParamDef> = {
  "file-exists": {
    required: ["file"],
    generate: (p) => `${p.file} exists`,
  },
  "dir-exists": {
    required: ["dir"],
    generate: (p) => `${p.dir}/ directory exists`,
  },
  "all-specs-frontmatter": {
    required: [],
    generate: () => "all specs have frontmatter",
  },
  "paths-resolve": {
    required: ["file"],
    generate: (p) => `all paths referenced in ${p.file} resolve`,
  },
  "root-clean": {
    required: [],
    generate: () => "root is clean",
  },
  "pointer-exists": {
    required: ["file", "target"],
    generate: (p) => `${p.file} exists with pointer to ${p.target}`,
  },
  "canary": {
    required: [],
    generate: () => "canary test exists",
  },
  "content-contains": {
    required: ["file", "items"],
    generate: (p) => `${p.file} contains [${p.items}]`,
  },
  "content-not-contains": {
    required: ["file", "items"],
    generate: (p) => `${p.file} must NOT contain [${p.items}]`,
  },
  "count-threshold": {
    required: ["file", "count", "unit"],
    generate: (p) => `${p.file} is under [${p.count}] ${p.unit}`,
  },
  "json-field-equals": {
    required: ["file", "field", "value"],
    generate: (p) => `${p.file} ${p.field} field equals [${p.value}]`,
  },
  "section-exists": {
    required: ["file", "section"],
    generate: (p) => `${p.file} has section [${p.section}]`,
  },
  "regex-match": {
    required: ["file", "pattern"],
    generate: (p) => `${p.file} matches /${p.pattern}/${p.flags ?? ""}`,
  },
  "source-contains": {
    required: ["file", "keywords"],
    generate: (p) => `harness ${p.file} contains [${p.keywords}]`,
  },
  "json-has-field": {
    required: ["file", "field"],
    generate: (p) => `${p.file} has field ${p.field}`,
  },
  "scaffold-produces": {
    required: ["file"],
    generate: (p) => `scaffold output ${p.file} exists`,
  },
  "frontmatter-field": {
    required: ["file", "field"],
    generate: (p) => p.value
      ? `${p.file} frontmatter has ${p.field} = ${p.value}`
      : `${p.file} frontmatter has ${p.field}`,
  },
  "file-line-range": {
    required: ["file", "min", "max"],
    generate: (p) => `${p.file} is between [${p.min}] and [${p.max}] lines`,
  },
  "command-output": {
    required: ["command", "expected"],
    generate: (p) => `command-output \`${p.command}\` contains [${p.expected}]`,
  },
};

// ── Core functions ────────────────────────────────────────────

function validatePattern(name: string): RegistryEntry {
  const registry = loadRegistry();
  const entry = registry.find(e => e.name === name);
  if (!entry) {
    const validNames = registry.map(e => e.name).join(", ");
    throw new Error(`Unknown pattern: "${name}". Valid patterns: ${validNames}`);
  }
  return entry;
}

function validateParams(patternName: string, params: Record<string, string>): void {
  const def = patternDefs[patternName];
  if (!def) {
    throw new Error(`No parameter definition for pattern: "${patternName}"`);
  }
  const missing = def.required.filter(k => !params[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required params for "${patternName}": ${missing.join(", ")}. ` +
      `Required: ${def.required.join(", ")}`
    );
  }
}

export function generateSCText(patternName: string, params: Record<string, string>): string {
  // Validate pattern exists in registry
  const entry = validatePattern(patternName);

  // Validate required params
  validateParams(patternName, params);

  // Generate the statement text
  const def = patternDefs[patternName];
  const statement = def.generate(params);

  // Validate round-trip: generated text must match the pattern's regex
  const regex = new RegExp(entry.regex, "i");
  if (!regex.test(statement)) {
    throw new Error(
      `Internal error: generated text "${statement}" does not match pattern regex /${entry.regex}/i`
    );
  }

  return statement;
}

export function listPatterns(): string {
  const registry = loadRegistry();
  const lines: string[] = ["Available patterns:", ""];
  for (const entry of registry) {
    const def = patternDefs[entry.name];
    const required = def ? def.required : [];
    lines.push(`  ${entry.name}`);
    lines.push(`    Syntax:   ${entry.syntax}`);
    lines.push(`    Example:  ${entry.example}`);
    lines.push(`    Required: ${required.length > 0 ? required.join(", ") : "(none)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The next free SC number.
 *
 * `SC-<n>` is a GLOBAL id — `lib/sc-ids.ts` says so, and
 * `test/spec-sc-ids-unique.test.ts` enforces it. This function read ONE
 * spec's content, which in a global namespace is not an allocator but a
 * collision generator, and it generated ten (#392): GATE-CONTRACTS-SPEC.md
 * counted up to 378 in its own file and took 379..388 for its per-gate
 * subsections, while CONFIG-DRIVEN-TESTING-SPEC.md independently counted up
 * to 378 in ITS own file and took 379 next. Both were locally correct and
 * neither could see the other.
 *
 * Pass the registry and the whole namespace is consulted, headings included —
 * a number owned by a `### SC-N:` section is just as taken as a tracked one.
 *
 * `reg` is optional so the one-argument answer is unchanged for any caller
 * that has no registry to hand; silently changing that would be a different
 * bug. It is the wrong answer in a shared namespace, which is why
 * `scripts/create-sc.ts` passes one.
 *
 * ## The namespace has a second half, and #392 only fixed the first
 *
 * Consulting the registry stopped two specs minting the same number. It did
 * nothing about test fixtures, which spell SC ids inside the SAME namespace
 * and appear in no registry: `test/sync-sc-status.test.ts:61` is literally
 * `- [ ] SC-9441: AGENTS.md exists`, a checkbox declaration in a string
 * literal. Allocating 900 would mint a criterion out of a scratch number and
 * hand a live claim to a fixture — the shape #392 closed, arriving from the
 * side nothing looks at.
 *
 * So `spelledInSource` is the other half — and only there is the reserved
 * range ignored. The 9000s exist to be safe for fixtures, so counting a
 * FIXTURE at 9450 as taken would push every future criterion past 9000 and
 * destroy the reservation it was built on. That is the one case where a
 * higher number is the wrong answer.
 *
 * A SPEC declaration is authoritative at any number, reserved or not. If a
 * spec has already claimed 9150 then 9150 is claimed, whatever the
 * convention says it should have been, and allocating it again is the
 * collision this function exists to prevent. The reservation is enforced
 * against specs by SC-1524, not by making the allocator pretend.
 */
/**
 * The ids a spec's own text spells, as one binding.
 *
 * The allocator counts them and the reading reports how many it counted; two
 * scans of the same string would be two deciders that agree, and a reading
 * whose numbers come from a different pattern than the allocation used is a
 * reading of something else.
 */
function idsInSpecContent(specContent: string): string[] {
  return [...specContent.matchAll(/SC-(\d+)/g)].map(m => m[0]);
}

export function nextSCNumber(
  specContent: string,
  reg?: ScRegistry,
  spelledInSource?: Iterable<string>,
): number {
  const ids: number[] = [];
  const take = (raw: string): void => {
    const n = Number(raw.replace(/^SC-[A-Z]?/, ""));
    if (Number.isFinite(n)) ids.push(n);
  };
  for (const raw of idsInSpecContent(specContent)) take(raw);
  for (const id of reg?.declaredById.keys() ?? []) take(id);
  for (const id of spelledInSource ?? []) if (!isFixtureScId(id)) take(id);
  if (ids.length === 0) return 1;
  return Math.max(...ids) + 1;
}

/**
 * The same three widths `nextSCNumber` reads, as a SET rather than a maximum.
 *
 * It exists because a reserved block is allocated from the bottom, not from
 * the top: `max + 1` cannot answer "is 2174 free" when the block runs
 * 2170..2189 and the tree's maximum is 2400. Both derive from one list
 * comprehension so the two cannot come to disagree about which ids count — a
 * second scan with a different fixture rule would be two deciders for one
 * question (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export function takenScNumbers(
  specContent: string,
  reg?: ScRegistry,
  spelledInSource?: Iterable<string>,
): Set<number> {
  const taken = new Set<number>();
  const take = (raw: string): void => {
    const n = Number(raw.replace(/^SC-[A-Z]?/, ""));
    if (Number.isFinite(n)) taken.add(n);
  };
  for (const raw of idsInSpecContent(specContent)) take(raw);
  for (const id of reg?.declaredById.keys() ?? []) take(id);
  for (const id of spelledInSource ?? []) if (!isFixtureScId(id)) take(id);
  return taken;
}

/**
 * The reservation store as a `SourceReading`, in one place.
 *
 * One binding for all three states, so a mutation has one site and a caller
 * cannot assemble a leg that says `read` over a store it never opened. `found`
 * is the number of ids the store declares OCCUPIED — the size of the space it
 * removes from the allocator — and it is `0` under `absent` and `unreadable`
 * for the same reason every other leg reports `0` when it did not run:
 * `status` is what tells those apart, never the count.
 */
export function scReservationLeg(reading: ScReservationReading): SourceReading {
  const label = `SC reservation store (${SC_RESERVATIONS_PATH})`;
  if (reading.status === "read") {
    return {
      label: `${label}: ${reading.blocks.length} block(s)`,
      kind: "reservations",
      status: "read",
      found: reservedIdCount(reading.blocks),
    };
  }
  return {
    label,
    kind: "reservations",
    status: "skipped",
    reason: reading.reason ?? `the store is ${reading.status}`,
    found: 0,
  };
}

/**
 * Thrown when the caller's own reserved block has no id left in it.
 *
 * A distinct error rather than a fall-through to "allocate above the block",
 * because that fall-through is the cheapest wrong fix and it silently undoes
 * the separation the block was handed out to provide, on the one day it
 * matters. Widening the block is a decision a person makes in the store.
 */
export class ScReservationExhaustedError extends Error {}

/**
 * The number, given the floor, the store and who is asking.
 *
 * Exported because it is the single binding a mutation battery points at:
 * every reservation-aware decision this module makes happens here and nowhere
 * else, so there is no second copy to hold a case up when this one is broken.
 */
export function allocateAgainstReservations(
  floor: number,
  blocks: ScReservation[],
  owner: string | null,
  taken: ReadonlySet<number>,
): number {
  const mine = reservationFor(blocks, owner);
  if (mine !== null) {
    const free = lowestFreeInBlock(mine, taken);
    if (free === null) {
      throw new ScReservationExhaustedError(
        `the SC block reserved to ${mine.owner} (${mine.from}-${mine.to}) is spent — ` +
          `widen it in ${SC_RESERVATIONS_PATH} rather than allocating outside it`,
      );
    }
    return free;
  }
  // No block of your own. The floor is still correct about what is WRITTEN;
  // it knows nothing about what is DECLARED, so it is raised past every block
  // in the store. This is the row that covers the renumber case — the one
  // where nobody thought of themselves as allocating.
  return Math.max(floor, reservedCeiling(blocks) + 1);
}

/**
 * The next free SC number for a project, over every namespace this machine
 * can see (#503).
 *
 * `nextSCNumber` answers the question for the arguments it is handed, and
 * three widths of that question have each been wrong in turn: one spec's
 * content (#392), the spec registry without test fixtures (#399), and the
 * registry of whichever working tree the command ran in (#503). This is the
 * composition, in one place, so a caller cannot assemble two of the three and
 * believe it asked.
 *
 * It returns the reading alongside the number because the number is a FLOOR:
 * a clone on another machine is outside anything this process can reach, and
 * a caller that printed only the number would be claiming a guarantee the
 * reading explicitly does not give.
 *
 * ## `reg` is REQUIRED, and was optional for two issues (#593)
 *
 * Omit it and `nextSCNumber` skips `reg.declaredById` entirely: the answer is
 * assembled from the spec's own content, source-spelled fixtures and the
 * cross-tree namespace, and the spec registry — the width #392 was filed
 * over — is not consulted at all. The number comes back looking exactly like
 * one that had asked everything, which is the composition failure the
 * paragraph above says this function exists to make impossible. A caller
 * with no registry to hand has `buildScRegistry([])`, which states "this
 * tree declares nothing" instead of defaulting to it.
 *
 * The two readings agree whenever every spec-declared id is also spelled in
 * a source file, which is most of the time and is why nothing noticed. They
 * diverged the day a spec declared eight criteria no test mentioned yet.
 *
 * ## The reading names every leg, not just the cross-tree ones
 *
 * `readScNamespace` accounts for the worktrees and refs it read. The other
 * three widths were invisible in the returned reading, so a CLI could print
 * the number and a complete-looking account of where it came from while one
 * of the legs behind it had never run. They are appended as sources of their
 * own, with the count each contributed — `0` from a leg that was consulted
 * and `0` from a leg that was skipped are the same number and opposite
 * facts (`.claude/rules/config-access.md`).
 *
 * ## …and for two issues all three said `read` without asking (#606)
 *
 * The sentence above was the docstring of a function that hardcoded
 * `status: "read"` on every one of the three. Measured on a tree holding one
 * spec and none of the four source directories: `source-mentions` reported
 * `read, found 0` — which is also the output for a tree whose four
 * directories were walked and held no ids. A consumer whose tests live in
 * `tests/` or `src/` was in the second case on every single run.
 *
 * Two of the three are now derived, and one is not:
 *
 * | Leg | Source of `found` | Can it have failed to read? |
 * |---|---|---|
 * | `spec-content` | `idsInSpecContent(specContent)` | **No.** `specContent` is a string parameter, already in memory. `0` here is a reading |
 * | `registry` | `reg.declaredById.size` | Yes — `reg` may have been built from a `specs/` the caller could not enumerate, which `ScRegistry.enumeration` now states |
 * | `source-mentions` | the source walk | Yes — four directories, any of which the walk returns silently from |
 *
 * `spec-content` stays `read` deliberately. Rewriting all three uniformly is
 * the cheap-looking repair and it adds an unreachable branch to the one leg
 * that was right, which no case can go red over.
 *
 * A leg that could not be fully read also appends to `namespace.unmeasured`,
 * because `status` is a per-leg fact and `unmeasured` is the list a caller
 * prints. A gap in only one of them is a gap a reader can miss.
 *
 * ## …and all six legs read ids that have already been WRITTEN (#725)
 *
 * Every width above answers "which ids can this machine find typed somewhere
 * right now". None of them can see an id another session has decided to take
 * and not yet typed, which is the window `.claude/rules/parallel-sessions.md`
 * says people sit in for an hour. Four collisions on 2026-10-19 came out of
 * it, and in three of them the allocator was never run at all — a renumber
 * during a repair, two individually-correct branch allocations, and ids
 * hand-written into a test file.
 *
 * `lib/sc-reservations.ts` is the seventh leg and the only one that is a
 * reading of a DECLARATION rather than of the tree. `opts.owner` — a branch
 * name or issue ref — selects the caller's own block:
 *
 * | The caller | What it gets |
 * |---|---|
 * | owns a block with room in it | the lowest free id INSIDE that block |
 * | owns a block that is spent | a refusal naming the block |
 * | owns no block | an id above every block in the store, so it cannot land in someone else's |
 *
 * The no-owner row is the one that makes the store work for the renumber
 * case: a session that never declared anything still cannot be handed an id
 * out of a block somebody else declared.
 *
 * A store that is present and could not be read is a REFUSAL, not an empty
 * reading — see `lib/sc-reservations.ts`. A store that is genuinely absent is
 * a skipped leg with a named `unmeasured` entry, because every scaffolded
 * consumer project is in that state and a refusal they cannot act on is a
 * gate everyone learns to click past.
 */
export function allocateScNumber(
  root: string,
  specContent: string,
  reg: ScRegistry,
  opts?: { owner?: string | null },
): { number: number; namespace: ScNamespaceReading } {
  const namespace = readScNamespace(root);
  const source = scIdsSpelledInSourceReading(root);
  const spelled = [...source.ids.keys()];
  const floor = nextSCNumber(specContent, reg, [...spelled, ...namespace.ids.keys()]);

  const unmeasured: string[] = [];

  const reservations = readScReservations(root);
  // The refusal, before the number exists. Returning a floor computed without
  // a store that is sitting right there, unreadable, is the pre-#725
  // behaviour: `0`, `{}` and silence are indistinguishable from success
  // (`.claude/rules/config-access.md`).
  if (reservations.status === "unreadable") {
    throw new Error(`${RESERVATION_REFUSAL} (${reservations.path}): ${reservations.reason}`);
  }
  const reservationLeg = scReservationLeg(reservations);
  if (reservations.status !== "read") {
    unmeasured.push(
      `the SC reservation store could not be consulted: ${reservations.reason ?? "no reason given"}`,
    );
  }
  const taken = takenScNumbers(specContent, reg, [...spelled, ...namespace.ids.keys()]);
  const number = allocateAgainstReservations(floor, reservations.blocks, opts?.owner ?? null, taken);

  const registryLabel = "spec registry (every declared id, checkbox and heading)";
  const registryLeg: SourceReading = reg.enumeration.status === "enumerated"
    ? { label: registryLabel, kind: "registry", status: "read", found: reg.declaredById.size }
    : {
      label: registryLabel,
      kind: "registry",
      status: "skipped",
      reason: reg.enumeration.reason ?? "the spec registry was not enumerated",
      found: 0,
    };
  if (reg.enumeration.status === "unenumerated") {
    unmeasured.push(
      `the spec registry was not enumerated: ${reg.enumeration.reason ?? "no reason given"}`,
    );
  }

  const sourceLabel = `SC ids spelled under ${SC_SOURCE_DIRS.join(", ")}`;
  const unreached = source.unwalkable.map(u => `${u.dir} (${u.reason})`).join("; ");
  let sourceLeg: SourceReading;
  if (source.walked.length === 0) {
    // None of them opened. There is no reading here at all, and the count is
    // the count of a walk that never happened.
    sourceLeg = {
      label: sourceLabel,
      kind: "source-mentions",
      status: "skipped",
      reason: `none of ${SC_SOURCE_DIRS.join(", ")} could be walked: ${unreached}`,
      found: 0,
    };
  } else if (source.unwalkable.length > 0) {
    // Partially read, and the count is real for the part that was. Saying
    // `skipped` here would swap the two cases rather than separate them.
    sourceLeg = {
      label: `${sourceLabel} (walked ${source.walked.join(", ")})`,
      kind: "source-mentions",
      status: "read",
      reason: `could not walk ${unreached}`,
      found: new Set(spelled).size,
    };
  } else {
    sourceLeg = {
      label: sourceLabel,
      kind: "source-mentions",
      status: "read",
      found: new Set(spelled).size,
    };
  }
  for (const u of source.unwalkable) {
    unmeasured.push(`source directory ${u.dir} could not be walked: ${u.reason}`);
  }

  const legs: SourceReading[] = [
    {
      // Not derived, and the table above says why: there is no state in which
      // this one could have failed to read a string it was handed.
      label: "the spec's own content",
      kind: "spec-content",
      status: "read",
      found: new Set(idsInSpecContent(specContent)).size,
    },
    registryLeg,
    sourceLeg,
    reservationLeg,
  ];

  return {
    number,
    namespace: {
      ...namespace,
      sources: [...legs, ...namespace.sources],
      unmeasured: [...unmeasured, ...namespace.unmeasured],
    },
  };
}

/**
 * Format an SC line for appending to a spec file.
 */
export function formatSCLine(scNumber: number, statement: string): string {
  return `- [ ] SC-${scNumber}: ${statement}`;
}
