/**
 * Does a document the routing table calls a spec actually state anything? (#579)
 *
 * `.claude/rules/specs-routing.md` is the table every agent is told to consult
 * before changing an area. It is generated from `specs/`, one row per file,
 * and it promises each row GOVERNS something. Nothing checked that the
 * document on the other end states a requirement.
 *
 * `specs/PROJECT-STATE.md` was a **rendered PROJECT-STATE.md snapshot from
 * 2026-09-22 with spec frontmatter pasted on top** — a "Current phase" line, a
 * stale priorities list, and status tables citing criteria it did not declare.
 * It sat in the routing table as the governing spec for project state
 * management for two months. An agent sent there before touching
 * `scripts/update-project-state.ts` got no criteria at all.
 *
 * **A gap in a routing table is visible; this is not.** The reader believes
 * they have arrived. That is the same harm as `.claude/rules/config-access.md`'s
 * Silent Default Substitution with a document as the victim: an empty answer
 * and a correct answer are the same shape to the consumer.
 *
 * ## Why the exemption is frontmatter and not an allowlist
 *
 * Some documents in `specs/` legitimately state no criteria —
 * `BOOTSTRAP-DATA-FLOW-SPEC.md` is a redirect stub whose whole job is to point
 * readers at the directory it was split into. An allowlist would cover that,
 * and two things are wrong with one here.
 *
 * DRIFT-3 refuses any entry ADDED to `.claude/conformity-allowlists.json`
 * relative to `origin/main`, because an agent must not pass a gate by editing
 * the gate. Shipping this check with its current violators pre-listed is
 * exactly that move, and the ratchet is right to refuse it.
 *
 * The better reason is that **an allowlist is invisible to the person being
 * harmed.** The reader harmed by a criteria-free spec is the one who followed
 * the routing table to it; a JSON file in `.claude/` is not on that path. A
 * declaration in the document's own frontmatter is, and the generated routing
 * table can render it, so the warning reaches the reader before they click
 * rather than after they have read 300 lines looking for requirements.
 *
 * So: state criteria, or say `criteria: none` and say why. Both are honest.
 * Silence is the thing that is not.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

/** A checkbox criterion line, whatever id prefix it uses. */
const CRITERION_LINE = /^\s*- \[[ xX]\]/;

/**
 * Counted on any checkbox line rather than on `- [ ] SC-`.
 *
 * `BOOTSTRAP-TEST-PLAN.md` numbers its criteria `TP-1`, `TP-2`, and the first
 * census written for this issue counted `- [ ] SC-` and reported it as
 * stating nothing. It states 41 criteria. A detector narrower than what it
 * detects, in the direction that accuses a correct document —
 * `.claude/rules/checks-must-be-able-to-fail.md`, second shape.
 */
export function countCriteria(content: string): number {
  return content.split("\n").filter(l => CRITERION_LINE.test(l)).length;
}

export interface SpecRequirementReading {
  /** Path relative to `specs/`, so a report can name it. */
  spec: string;
  criteria: number;
  /** The document says it states none, in its own frontmatter. */
  declaredNone: boolean;
  /** Why it states none. A declaration with no reason is a mute. */
  reason: string | null;
}

function frontmatterField(content: string, key: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

export function readSpecRequirements(specsDir: string, rel: string): SpecRequirementReading {
  const content = readFileSync(join(specsDir, rel), "utf-8");
  const declared = frontmatterField(content, "criteria");
  const reason = frontmatterField(content, "criteria-reason");
  return {
    spec: rel,
    criteria: countCriteria(content),
    declaredNone: declared === "none",
    reason: reason && reason.length > 0 ? reason : null,
  };
}

/**
 * Refusals, worded after the property rather than after the proxy.
 *
 * Three of them, and the second and third exist because the first alone is
 * satisfiable by something other than fixing the problem — #492's trap. A
 * check that only refused "no criteria and no declaration" is cleared by
 * pasting `criteria: none` onto a spec that has requirements and has simply
 * not written them down, which is the state this check exists to surface.
 */
export function requirementViolations(readings: SpecRequirementReading[]): string[] {
  const out: string[] = [];
  for (const r of readings) {
    if (r.criteria === 0 && !r.declaredNone) {
      out.push(
        `${r.spec} states no criteria and does not say so. The routing table presents it as a ` +
          `governing spec, so a reader is sent there expecting requirements. Add criteria, or ` +
          `declare "criteria: none" with a "criteria-reason:" in its frontmatter.`,
      );
      continue;
    }
    // Both directions, like every other ratchet here. A spec that gains
    // criteria must withdraw the declaration, or the declaration rots into a
    // line that certifies nothing — and the routing table keeps warning
    // readers away from a document that now has what they came for.
    if (r.declaredNone && r.criteria > 0) {
      out.push(
        `${r.spec} declares "criteria: none" and states ${r.criteria}. Remove the declaration.`,
      );
      continue;
    }
    if (r.declaredNone && r.reason === null) {
      out.push(
        `${r.spec} declares "criteria: none" with no "criteria-reason:". A reader routed here ` +
          `needs to know whether this is a redirect stub or an unwritten spec.`,
      );
    }
  }
  return out;
}

/**
 * `testable:` read as a value rather than as `=== "true"`.
 *
 * DRIFT-2 and SPEC-DISCOVERY both ask `fm.testable === "true"`, so every
 * other spelling is silently FALSE. `specs/DA-COMPLIANCE-SPEC.md` carries
 * `testable: no`, which happens to mean what its author intended; `testable:
 * yes` would mean the opposite of what its author intended and nothing would
 * say so. The spec would drop out of the conformity surface while its
 * frontmatter, the routing table and any reader all said it was in.
 *
 * A fail-open with no amplifier today is still a fail-open. One line.
 */
export function testableViolations(specsDir: string, specs: string[]): string[] {
  const out: string[] = [];
  for (const rel of specs) {
    const raw = frontmatterField(readFileSync(join(specsDir, rel), "utf-8"), "testable");
    if (raw === null) continue; // absence is a separate check's question
    if (raw !== "true" && raw !== "false") {
      out.push(
        `${rel} has "testable: ${raw}". Every reader compares against the string "true", so ` +
          `anything else means false — including "yes". Write true or false.`,
      );
    }
  }
  return out;
}

/**
 * Spec basenames that also name a file somewhere else in the project.
 *
 * DRIFT-2 credits a testable spec when any test file's text contains its
 * name, and for a top-level spec that name is a bare basename. On this repo
 * `specs/PROJECT-STATE.md` and the generated root `PROJECT-STATE.md` share
 * one, and **ten test files mention the root one** — so the spec was
 * referenced, by DRIFT-2's reading, by tests that have nothing to do with it.
 *
 * This is the fifth shape and it was aimed straight at #579's own fix: the
 * issue's prescribed remedy is `testable: true` plus "a test naming it, which
 * test/update-project-state.test.ts can do in one line". Flipping the flag
 * alone would have turned DRIFT-2 green for this spec on the strength of
 * `test/organize-project.test.ts` talking about a status file.
 *
 * Measured rather than assumed: exactly one spec basename collides on this
 * tree. Requiring the `specs/`-qualified path from EVERY test would orphan 15
 * of 22 testable specs, so the rule is narrowed to the ambiguous ones — where
 * a bare name genuinely does not say which file is meant.
 */
export function ambiguousSpecNames(root: string, specs: string[]): Set<string> {
  const names = new Map<string, string>();
  for (const rel of specs) names.set(basename(rel), rel);
  const found = new Set<string>();
  const SKIP = new Set(["node_modules", ".git", "specs", "dist", "build", ".fallow", ".next"]);
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const n of entries) {
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (names.has(n)) found.add(names.get(n)!);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/**
 * Whether a test names THIS spec.
 *
 * Unambiguous names are matched bare, which is how every existing credit in
 * this repo is earned. An ambiguous one must be written `specs/<path>`, which
 * is the only form that says which file is meant.
 */
export function specIsReferenced(testContent: string, rel: string, ambiguous: Set<string>): boolean {
  if (ambiguous.has(rel)) return testContent.includes(`specs/${rel}`);
  return testContent.includes(rel);
}
