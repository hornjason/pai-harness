/**
 * #968 — the fs-write detector against the forms its predecessor missed.
 *
 * ## Why the fixtures are HERE
 *
 * The live consumer is `test/scratch-paths-unique.test.ts`, which runs this
 * detector over ITSELF to show its self-exclusion is safe. Fixtures placed
 * there would be read by the very reading they are meant to witness. A third
 * file keeps the subject and the witness apart.
 *
 * ## The measured defect
 *
 * The check this replaces was
 * `/import\s*\{([^}]*)\}\s*from\s*"fs";/.exec(self)` — first match only.
 * Measured by mutating the real file and running it:
 *
 * | mutant | result | verdict |
 * |---|---|---|
 * | a SECOND `import { mkdirSync } from "fs";` | 8 pass / 0 fail | **missed** |
 * | `import { mkdirSync } from "node:fs";`     | 8 pass / 0 fail | **missed** |
 * | the braced import replaced by `import * as fs from "fs";` | 1 fail | caught |
 *
 * The third row is recorded because #968 asserted the old check "fails open
 * when no recognisable import form is found". It does not — `.not.toBeNull()`
 * reddens. The defect is the first match, not the missing one.
 */

import { describe, expect, test } from "bun:test";
import { fsWriteCapabilities } from "../lib/fs-write-capabilities";

/** `fsWriteCapabilities` or an explicit failure — never a silent `[]`. */
function capabilities(src: string): string[] {
  const found = fsWriteCapabilities(src);
  expect(found, `source did not parse, so this reading is a refusal, not a clean result:\n${src}`).not.toBeNull();
  return found!;
}

const READS_ONLY = 'import { readFileSync, readdirSync } from "fs";\nreadFileSync("x");\n';

describe("#968: every way a module can acquire a write primitive", () => {
  test("a read-only fs import is not a write capability", () => {
    // The boundary. A detector that flagged this would refuse the file it
    // guards, which does its work with readFileSync and readdirSync.
    expect(capabilities(READS_ONLY)).toEqual([]);
  });

  /**
   * BLIND SPOT 1 — `exec` reads the first import and stops. This is the
   * mutant measured at 8 pass / 0 fail against the old check.
   */
  test("a write primitive in a SECOND fs import", () => {
    const found = capabilities(READS_ONLY + 'import { mkdirSync } from "fs";\n');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("mkdirSync");
  });

  /** BLIND SPOT 2 — the `node:` prefix, also measured at 8 pass / 0 fail. */
  test("a write primitive imported from node:fs", () => {
    expect(capabilities(READS_ONLY + 'import { mkdirSync } from "node:fs";\n')[0]).toContain("node:fs");
  });

  test("a write primitive imported from fs/promises and node:fs/promises", () => {
    expect(capabilities(READS_ONLY + 'import { mkdir } from "fs/promises";\n')).toHaveLength(1);
    expect(capabilities(READS_ONLY + 'import { rm } from "node:fs/promises";\n')).toHaveLength(1);
  });

  /**
   * BLIND SPOT 3 — a namespace binding names no members, so an import-list
   * check has nothing to compare. The whole module comes with it.
   */
  test("a namespace import carries every write primitive", () => {
    expect(capabilities('import * as fs from "fs";\n')[0]).toContain("the whole of");
  });

  test("a default import carries every write primitive", () => {
    expect(capabilities('import fs from "fs";\n')[0]).toContain("the whole of");
  });

  test("a dynamic import and a require are both capabilities", () => {
    expect(capabilities('const fs = await import("fs");\n')[0]).toContain("dynamically");
    expect(capabilities('const fs = require("node:fs");\n')[0]).toContain("require()");
  });

  /** BLIND SPOT 4 — Bun's writers import nothing, so no import-list check can reach them. */
  test("Bun.write and Bun.$ are capabilities with no import at all", () => {
    expect(capabilities('await Bun.write("x", "y");\n')[0]).toContain("Bun.write");
    expect(capabilities("await Bun.$`touch x`;\n")[0]).toContain("Bun.$");
  });

  test("an aliased write primitive is reported under its exported name", () => {
    // `import { mkdirSync as md }` — the local name is free, the capability
    // is not. Reported by what was imported, not by what it was called.
    expect(capabilities('import { mkdirSync as md } from "fs";\n')[0]).toContain("mkdirSync");
  });

  test("a module that touches no filesystem reports nothing", () => {
    expect(capabilities('import { join } from "path";\nconst x = join("a", "b");\n')).toEqual([]);
  });
});

describe("#968: the widening did not cost precision", () => {
  /**
   * THE COST OF WIDENING, measured and named.
   *
   * Two over-reports are deliberate and both are stated rather than hidden:
   *
   * 1. **Capability, not use.** An imported-but-uncalled `mkdirSync` is
   *    reported. The exclusion this guards is about what the file COULD
   *    hide, and unused is one edit from used. The predecessor did the same.
   * 2. **`Bun.$` with a read-only command.** A shell that only reads is
   *    reported as a write capability. A shell is a shell; the cost is that
   *    if the guarded file ever needs a read-only shell call, the right
   *    repair is to drop the self-exclusion, not to narrow this.
   *
   * The over-report that is NOT accepted: a write-shaped NAME that is not an
   * fs import. `mkdirSync` from somewhere else, or as a local function, is
   * not node's. The old import-list check shared this property and the AST
   * keeps it.
   */
  test("a write-shaped name from a non-fs module is not reported", () => {
    expect(capabilities('import { mkdirSync } from "./my-helpers";\n')).toEqual([]);
    expect(capabilities("function mkdirSync() {}\nmkdirSync();\n")).toEqual([]);
  });

  test("the two deliberate over-reports, stated as assertions", () => {
    expect(capabilities('import { mkdirSync } from "fs";\n'), "imported but never called is still a capability").toHaveLength(1);
    expect(capabilities("await Bun.$`ls`;\n"), "a read-only shell call is still reported").toHaveLength(1);
  });

  /**
   * The self-reference trap, closed — and this is the whole reason the
   * predecessor read the import list instead of counting calls. The file it
   * guards contains `mkdtempSync(` and `rmSync(` as string DATA. A text
   * count reads them as calls; an AST reads them as `Literal`.
   */
  test("write-call text inside a string literal is not a capability", () => {
    const src = 'const SAMPLE = \'mkdirSync(S); rmSync(S); Bun.write("x", "y");\';\nconsole.log(SAMPLE);\n';
    expect(capabilities(src)).toEqual([]);
  });

  test("write-call text inside a comment is not a capability", () => {
    expect(capabilities("// mkdirSync(S) would be a write\nconst x = 1;\n")).toEqual([]);
  });
});

describe("#968: a reading that could not be taken says so", () => {
  test("source that does not parse is null, not an empty list", () => {
    expect(fsWriteCapabilities('import { mkdirSync } from "fs"\nconst x = {\n')).toBeNull();
  });

  test("an empty module is an empty list, not a refusal", () => {
    expect(fsWriteCapabilities("")).toEqual([]);
  });
});
