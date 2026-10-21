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
 */

import { type AstNode, calleeRoot, parseTsModule, walkNodes } from "./ts-ast";

/** Module specifiers that resolve to node's filesystem API. */
const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/**
 * Named exports of `fs` that create, destroy or modify a path.
 *
 * Listed because the question is "can this file plant a scratch root", not
 * "does it touch fs at all" — `readFileSync` and `readdirSync` are how the
 * detector does its job and must not be refused.
 */
const FS_WRITE_NAMES = new Set([
  "appendFile", "appendFileSync",
  "copyFile", "copyFileSync",
  "cp", "cpSync",
  "createWriteStream",
  "mkdir", "mkdirSync",
  "mkdtemp", "mkdtempSync",
  "open", "openSync",
  "rename", "renameSync",
  "rm", "rmSync",
  "rmdir", "rmdirSync",
  "symlink", "symlinkSync",
  "truncate", "truncateSync",
  "unlink", "unlinkSync",
  "writeFile", "writeFileSync",
]);

function literalString(node: unknown): string | null {
  const n = node as AstNode | undefined;
  if (n?.type === "Literal" && typeof n.value === "string") return n.value;
  return null;
}

function isFsModule(spec: string | null): boolean {
  return spec !== null && FS_MODULES.has(spec);
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
      if (!isFsModule(spec)) continue;
      for (const s of (node.specifiers ?? []) as AstNode[]) {
        // A namespace or default binding carries the WHOLE module, so every
        // write primitive comes with it whether or not it is named here.
        if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier") {
          out.push(`the whole of "${spec}" is bound as \`${(s.local as AstNode).name}\``);
          continue;
        }
        const imported = (s.imported as AstNode | undefined)?.name;
        if (typeof imported === "string" && FS_WRITE_NAMES.has(imported)) {
          out.push(`\`${imported}\` is imported from "${spec}"`);
        }
      }
      continue;
    }

    if (node.type === "ImportExpression") {
      const spec = literalString(node.source);
      if (isFsModule(spec)) out.push(`"${spec}" is imported dynamically`);
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
      if (isFsModule(spec)) out.push(`"${spec}" is loaded with require()`);
      continue;
    }

    // Bun's own writers, which import nothing and so are invisible to any
    // import-list check. `Bun.$` is reported even though a read-only shell
    // call writes nothing: a shell is a write capability, and the cost of
    // over-reporting it is named in the caller.
    const callee = node.callee as AstNode | undefined;
    if (callee && calleeRoot(callee) === "Bun") {
      const text = parsed.js.slice(callee.start, callee.end);
      if (/^Bun\s*\.\s*(write|\$)$/.test(text)) out.push(`\`${text}\` can write without importing fs`);
    }
  }
  return out;
}
