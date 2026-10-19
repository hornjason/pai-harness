/**
 * ONE binding decides whether the contract-parity check has one name and one
 * home (#637 AC-8).
 *
 * ## Why this is a check and not a comment
 *
 * #626 asked for a `contract-parity` command and said, in the issue body, why
 * it must not be called a preflight: `preflightResults` in `workflows/ship.js`
 * is SSH host reachability and `lib/release-preflight.ts` is npm release
 * verification, so a third meaning of the word would be its own parity defect
 * — the fix for the class committing an instance of the class.
 *
 * A sentence in an issue is a sentence. The thing that stops a second copy of
 * `commandParity` appearing in `workflows/ship.js` eight weeks from now, or a
 * `preflightParity` growing beside `contractParity`, is a scan somebody has to
 * get past.
 *
 * ## Why ONE exported binding and not three
 *
 * There are three properties below and it is tempting to export three
 * predicates. Two deciders that agree are behaviourally one guard — no
 * behavioural test can tell them apart, and a mutation of either leaves the
 * other holding every case up (`.claude/rules/checks-must-be-able-to-fail.md`,
 * fourth shape). Three would be worse. So the three properties are three
 * VIOLATION CLASSES out of one function, and each has an input only it can
 * reach, written down as a separate case in
 * `test/contract-parity-derivation.test.ts`:
 *
 * | Class | The input only it reaches |
 * |---|---|
 * | `DUPLICATE_PARITY_BINDING` | a tree declaring `contractParity` twice |
 * | `PREFLIGHT_NAMED_PARITY` | a tree declaring `preflightParity` beside one correct `contractParity` |
 * | `UNMEASURED_PARITY_SCAN` | a tree declaring no `contractParity` at all |
 *
 * Varying exactly one thing per input is #585's pair discipline: a fixture
 * that moved two of those at once would be red under any of the three and
 * would measure none of them.
 *
 * ## Why the scan refuses when it finds nothing
 *
 * A scan over a directory tree that matched no declarations reports the same
 * empty violation list as a tree that is perfectly in order. That is the
 * third shape, and it is how a regex that stops matching after a reformat
 * becomes a green check nobody can see through. So an empty reading is a
 * REFUSAL naming the scan — `UNMEASURED_PARITY_SCAN` — and the control is the
 * `preflight` family itself: seven declarations in this tree that cannot all
 * vanish, named here because a string that must be present if the store holds
 * anything is the only thing that distinguishes an absent problem from an
 * absent instrument (`.claude/rules/checks-must-be-able-to-fail.md`, #646/#657).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * The directories AC-8 names. `workflows/` is in the list because it is where
 * the second copy would go: `workflows/ship.js` cannot import (#69), so every
 * comparison it needs is inlined, and an inlined parity check is a second
 * decider by construction.
 */
export const PARITY_SCAN_DIRS = ["lib", "scripts", "gates", "workflows"] as const;

/** The one name the contract-parity entry point is allowed to have. */
export const PARITY_BINDING = "contractParity";

/**
 * The word a parity binding must never wear, and the word that proves the
 * scan is reading something.
 */
export const FOREIGN_PARITY_WORD = "preflight";

export const PARITY_VIOLATION_CLASSES = [
  "DUPLICATE_PARITY_BINDING",
  "PREFLIGHT_NAMED_PARITY",
  "UNMEASURED_PARITY_SCAN",
] as const;
export type ParityViolationClass = (typeof PARITY_VIOLATION_CLASSES)[number];

/** A value declaration — the things that can decide something. */
const DECLARATION =
  /(?:^|\n)\s*(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;

export interface ParityDeclaration {
  name: string;
  /** Repo-relative path. */
  file: string;
  line: number;
  /**
   * AC-8 is about the EXPORTED symbol, and the distinction is load-bearing in
   * both directions: a module-local `const parity` is nobody's second decider,
   * and `preflightResults` — a local in `workflows/ship.js` — is one of the
   * seven declarations that prove this scan is reading the tree at all.
   */
  exported: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(p) && !/\.test\.(ts|js)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Every value declaration in the four directories whose name contains `word`,
 * case-insensitively.
 *
 * Exported for the cases to read, NOT as a second decider: nothing in this
 * module's verdict is computed anywhere but `parityBindingViolations`, so
 * there is one thing to mutate. A case that asserted on this reading instead
 * of on the violations would be asserting the input it just supplied.
 */
export function declarationsNaming(root: string, word: string): ParityDeclaration[] {
  const needle = word.toLowerCase();
  const out: ParityDeclaration[] = [];
  for (const dir of PARITY_SCAN_DIRS) {
    for (const abs of walk(join(root, dir))) {
      const text = readFileSync(abs, "utf-8");
      const relative = abs.slice(root.endsWith("/") ? root.length : root.length + 1);
      for (const m of text.matchAll(DECLARATION)) {
        if (!m[2].toLowerCase().includes(needle)) continue;
        out.push({
          name: m[2],
          file: relative,
          line: text.slice(0, m.index!).split("\n").length,
          exported: m[1] !== undefined,
        });
      }
    }
  }
  return out;
}

/**
 * The whole verdict. Empty means the contract-parity binding has one name and
 * one home; every string names its class first so a reader can tell the three
 * apart without parsing prose.
 */
export function parityBindingViolations(root: string): string[] {
  const violations: string[] = [];
  const parity = declarationsNaming(root, "parity");
  const foreign = declarationsNaming(root, FOREIGN_PARITY_WORD);

  // The instrument, before any finding. An empty reading over four
  // directories is not a clean tree, and a reading that found no `preflight`
  // in a tree that has seven of them is a scan that has stopped working.
  const exported = parity.filter(d => d.exported);
  const entry = exported.filter(d => d.name === PARITY_BINDING);
  if (entry.length === 0) {
    violations.push(
      `UNMEASURED_PARITY_SCAN: the scan over ${PARITY_SCAN_DIRS.join(", ")} found no declaration of ` +
        `\`${PARITY_BINDING}\` at all. A comparison that could not be performed is not a comparison that ` +
        `passed — either the binding was renamed, or this scan has stopped reading the tree ` +
        `(it saw ${parity.length} parity declaration(s) and ${foreign.length} ${FOREIGN_PARITY_WORD} declaration(s))`,
    );
  }

  // One name, one home. Counted per name rather than only for the entry
  // point: a second `commandParity` is the same defect one level down, and
  // the category runners are what `contractParity` dispatches to.
  const byName = new Map<string, ParityDeclaration[]>();
  for (const d of exported) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name)!.push(d);
  }
  for (const [name, found] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (found.length <= 1) continue;
    violations.push(
      `DUPLICATE_PARITY_BINDING: \`${name}\` is declared ${found.length} times — ` +
        `${found.map(d => `${d.file}:${d.line}`).join(", ")}. Two deciders answering one question about one ` +
        `input are behaviourally one guard, and a mutation of either leaves the other holding the case up (#637 AC-8)`,
    );
  }

  // Not a third preflight. The repository already has two unrelated meanings
  // of that word; a parity binding wearing it would be #626's own subject,
  // committed by the fix for it.
  for (const d of exported) {
    if (!d.name.toLowerCase().includes(FOREIGN_PARITY_WORD)) continue;
    violations.push(
      `PREFLIGHT_NAMED_PARITY: \`${d.name}\` at ${d.file}:${d.line} decides parity under the name ` +
        `\`${FOREIGN_PARITY_WORD}\`. This repository already has two unrelated things wearing that name — ` +
        `SSH host reachability in workflows/ship.js and npm release verification in lib/release-preflight.ts — ` +
        `and a third meaning is its own parity defect (#626, #637 AC-8)`,
    );
  }

  return violations;
}
