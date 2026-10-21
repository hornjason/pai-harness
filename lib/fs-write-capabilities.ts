/**
 * Can this module write to the filesystem? (#968, hardening #323 SC-6.)
 *
 * ## Why this exists
 *
 * `test/scratch-paths-unique.test.ts` excludes itself from its own scan,
 * because its negative fixtures are source text and the detector reads its
 * own test data as violations. An unchecked exclusion is how an exemption
 * becomes a hole, so the exclusion is paired with a case asserting the file
 * creates nothing. That case was:
 *
 * ```ts
 * const fsImport = /import\s*\{([^}]*)\}\s*from\s*"fs";/.exec(self);
 * ```
 *
 * `exec` returns the FIRST match. MEASURED by mutating the real file and
 * running it: adding `import { mkdirSync } from "fs";` as a SECOND import
 * leaves the suite at 8 pass / 0 fail, and so does
 * `import { mkdirSync } from "node:fs";`. The file gains a write primitive
 * and the case that exists to notice stays green.
 *
 * One claim in #968 did NOT reproduce and is recorded here so it is not
 * re-fixed: the old check does not fail open. Replacing the braced import
 * with `import * as fs from "fs"` makes `exec` return null, and the
 * `.not.toBeNull()` line goes red — 1 fail, measured. The defect is the first
 * match, not the missing match.
 *
 * ## Capability, not use
 *
 * This reports what the module CAN do, not what it does. An imported but
 * uncalled `mkdirSync` is reported, deliberately: the exclusion it guards is
 * about what the file could hide, and "imported but currently unused" is one
 * edit away from used. That is also what the regex it replaces did, so the
 * false-positive surface is unchanged on that axis.
 *
 * ## Why an AST
 *
 * The file being checked is full of `mkdtempSync(` and `rmSync(` as STRING
 * DATA — its own negative fixtures. A source-text count reads them as calls;
 * the old check sidestepped that by reading only the import list, which is
 * what made it blind to the second import. In an AST a string is a `Literal`
 * and a call is a `CallExpression`, so the detector can read both the imports
 * and the calls without its fixtures lying to it.
 *
 * `null` means the source did not parse — a REFUSAL, distinct from `[]`.
 *
 * ## WHAT THIS DOES NOT COVER (stated, because an unstated boundary reads as
 * coverage, and a clean report from an incomplete detector is worse than no
 * detector — #968's own thesis)
 *
 * MEASURED against the current implementation, each of these returns `[]`:
 *
 *  - **An indirection through a variable.** `const w = mkdirSync` after a
 *    read-only import, `const m = await import("fs"); m.mkdirSync(…)`, or a
 *    write primitive received as a function argument. Only bindings created
 *    by an import statement, `require` or `Bun.*` are read.
 *  - **A write primitive re-exported by a local module.** `import { write }
 *    from "./helpers"` is not an fs module and is not reported, by design —
 *    the alternative is following the import graph, which this is not.
 *  - **`process.binding`, `Deno.*`, raw syscalls, and native addons.**
 *  - **A write performed by code this module merely CALLS.** The reading is
 *    per-module, not transitive.
 *
 * What IS covered, and measured: named/namespace/default imports from `fs`,
 * `node:fs`, `fs/promises`, `node:fs/promises`; `require()` and dynamic
 * `import()` of those; `child_process` and `node:child_process`; and
 * `Bun.write`, `Bun.$`, `Bun.spawn`, `Bun.spawnSync`.
 *
 * The consumer that matters — `test/scratch-paths-unique.test.ts` — holds
 * none of the uncovered forms, and the covered set includes every form that
 * file could plausibly acquire. The gap is bounded by the thing it guards
 * rather than argued away.
 */

import { type AstNode, calleeRoot, parseTsModule, walkNodes } from "./ts-ast";

/** Module specifiers that resolve to node's filesystem API. */
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/**
 * Named exports of `fs` that CANNOT modify the filesystem. Everything else
 * an fs module exports is treated as a write capability.
 *
 * ## The ratchet direction, which is the whole point of this list
 *
 * This was an allowlist of write names, and an allowlist has its default
 * pointing the wrong way: every export node adds in future arrives
 * classified as safe, silently, and the detector reports clean on it. The
 * list was already five short — MEASURED on the allowlist version, all of
 * `link`, `chmod`, `utimes`, `writev` and `ftruncate` returned `[]`.
 *
 * Inverted, an unknown name is a write. A name on THIS list is a name
 * somebody considered and classified, which is the property an exemption
 * list has and an allowlist does not: naming what is exempt is evidence the
 * entry was looked at, naming what is safe is not.
 *
 * The cost of the inversion is false positives on read-only exports not
 * listed here, and it is measured rather than asserted — see the census in
 * the PR and the over-report cases in
 * `test/fs-write-capabilities.test.ts`. `readFileSync` and `readdirSync` are
 * how the detector's own consumer does its job and must not be refused.
 */
const FS_READ_ONLY_NAMES = new Set([
  "access", "accessSync",
  "createReadStream",
  "exists", "existsSync",
  "lstat", "lstatSync",
  "opendir", "opendirSync",
  "readFile", "readFileSync",
  "readdir", "readdirSync",
  "readlink", "readlinkSync",
  "realpath", "realpathSync",
  "stat", "statSync",
  "statfs", "statfsSync",
  "watch", "watchFile",
  // Added after the inversion's census over 667 files flagged them. Both are
  // genuinely read-only and were the ONLY false positives the inversion
  // introduced: `glob` enumerates, `close` releases a descriptor. They are
  // listed rather than quietly tolerated, which is exactly the property the
  // inverted list is for — a name here is a name somebody classified.
  "glob", "globSync",
  "close", "closeSync",
  "fstat", "fstatSync",
  // Type-only and constant exports, which carry no capability at all.
  "constants", "Dirent", "Dir", "Stats", "promises",
]);

/**
 * Modules whose exports can write without touching `fs` — a shell or a
 * spawn is a write capability however it is spelled.
 */
const PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
  "bun",
]);

function literalString(node: unknown): string | null {
  const n = node as AstNode | undefined;
  if (n?.type === "Literal" && typeof n.value === "string") return n.value;
  return null;
}

function isFsModule(spec: string | null): boolean {
  return spec !== null && FS_MODULES.has(spec);
}

function isProcessModule(spec: string | null): boolean {
  return spec !== null && PROCESS_MODULES.has(spec);
}

/**
 * Every filesystem-write capability `source` holds, as human sentences, in
 * document order. Empty means the module cannot write. `null` means the
 * source did not parse.
 */
export function fsWriteCapabilities(source: string): string[] | null {
  const parsed = parseTsModule(source);
  if (parsed === null) return null;

  const out: string[] = [];
  for (const node of walkNodes(parsed.tree)) {
    if (node.type === "ImportDeclaration") {
      const spec = literalString(node.source);
      if (isProcessModule(spec)) {
        out.push(`"${spec}" is imported, and a spawned process can write anything`);
        continue;
      }
      if (!isFsModule(spec)) continue;
      for (const s of (node.specifiers ?? []) as AstNode[]) {
        // A namespace or default binding carries the WHOLE module, so every
        // write primitive comes with it whether or not it is named here.
        // Reported on the BINDING rather than on `fs.writeFileSync(…)` member
        // access: the binding is the capability, and tracking member access
        // would be a narrower reading that an indirection defeats.
        if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier") {
          out.push(`the whole of "${spec}" is bound as \`${(s.local as AstNode).name}\``);
          continue;
        }
        const imported = (s.imported as AstNode | undefined)?.name;
        // INVERTED (#968 review): anything not known to be read-only is a
        // write. An unknown export defaults to reported, not to safe.
        if (typeof imported === "string" && !FS_READ_ONLY_NAMES.has(imported)) {
          out.push(`\`${imported}\` is imported from "${spec}" and is not a known read-only export`);
        }
      }
      continue;
    }

    if (node.type === "ImportExpression") {
      const spec = literalString(node.source);
      if (isFsModule(spec)) out.push(`"${spec}" is imported dynamically`);
      else if (isProcessModule(spec)) out.push(`"${spec}" is imported dynamically`);
      continue;
    }

    // `Bun.$\`…\`` is a tagged template, not a call. Checked separately or it
    // is the one shell spelling this detector cannot see — the exact shape of
    // defect #968 is about.
    if (node.type === "TaggedTemplateExpression") {
      const tag = node.tag as AstNode | undefined;
      if (tag && calleeRoot(tag) === "Bun") {
        const text = parsed.js.slice(tag.start, tag.end);
        if (/^Bun\s*\.\s*\$$/.test(text)) out.push(`\`${text}\` can write without importing fs`);
      }
      continue;
    }

    if (node.type !== "CallExpression") continue;
    const args = (node.arguments ?? []) as AstNode[];

    // `require("fs")` — the whole module, same as a namespace import.
    if ((node.callee as AstNode)?.type === "Identifier" && (node.callee as AstNode).name === "require") {
      const spec = literalString(args[0]);
      if (isFsModule(spec) || isProcessModule(spec)) out.push(`"${spec}" is loaded with require()`);
      continue;
    }

    // Bun's own writers and spawners, which import nothing and so are
    // invisible to any import-list check. `Bun.$` is reported even though a
    // read-only shell call writes nothing: a shell is a write capability,
    // and the cost of over-reporting it is named in the caller.
    const callee = node.callee as AstNode | undefined;
    if (callee && calleeRoot(callee) === "Bun") {
      const text = parsed.js.slice(callee.start, callee.end);
      if (/^Bun\s*\.\s*(write|\$|spawn|spawnSync)$/.test(text)) {
        out.push(`\`${text}\` can write without importing fs`);
      }
    }
  }
  return out;
}
