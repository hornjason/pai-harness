/**
 * Covers SC-1913..SC-1916 (HARNESS-STANDARD.md), #497.
 *
 * #439 decided that a `contextDocs` entry resolving outside the project root
 * is included and labelled rather than refused, on two premises: a brief
 * names files rather than reading them, and the config is written by the
 * operator whose session the agent runs in.
 *
 * The first is true of the brief and beside the point — the brief exists to
 * be obeyed by an agent holding a Read tool. The second is true of a project
 * the operator scaffolded and false of one they cloned, where the config is
 * a checked-in file in somebody else's repository. A sentence derived from
 * the cases that were measured, applied to a population it does not cover.
 *
 * `test/context-docs.test.ts` carries the revised SC-1616 and SC-1620. This
 * file carries what #439 never had: the symlink bypass, the provenance of
 * the allowlist, and the second door.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";

import { assembleBrief } from "../gates/brief-assembler";
import { TRUSTED_ROOTS_ENV, classifyContextDoc, realPathish, trustedDocRoots } from "../lib/context-docs";

const bases: string[] = [];
afterAll(() => {
  for (const b of bases) rmSync(b, { recursive: true, force: true });
});

/** A project root and a sibling directory outside it, both real paths. */
function scene(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-497-")));
  bases.push(base);
  const root = join(base, "project");
  const outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, outside };
}

/** The comparison #439 shipped, kept here as the thing being improved on. */
function lexicallyInternal(root: string, declared: string): boolean {
  const resolved = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
  const rel = relative(resolve(root), resolved);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("#497: a declared doc may not leave the project unless something outside it says so", () => {
  test("SC-1913: a symlink out of the project is refused on the real path", () => {
    const { root, outside } = scene();
    writeFileSync(join(outside, "SECRETS.md"), "k\n");
    // The target is reachable ONLY through the link as far as the declared
    // path is concerned: `docs` does not exist in the project, it IS the
    // link. A fixture whose target is also inside the root would satisfy the
    // assertion without the feature (#500).
    symlinkSync(outside, join(root, "docs"));

    // The instrument: the comparison #439 shipped calls this internal, so a
    // green here is not a property of the fixture.
    expect(lexicallyInternal(root, "docs/SECRETS.md"), "the fixture does not reproduce the bypass").toBe(true);

    const v = classifyContextDoc(root, "docs/SECRETS.md", {});
    expect(v.kind, "a link out of the project was admitted").toBe("rejected");
    expect(v.kind === "rejected" && v.reason).toContain(join(outside, "SECRETS.md"));
  });

  test("SC-1914: trust comes from the environment, never from the repository", () => {
    const { root, outside } = scene();
    writeFileSync(join(outside, "SHARED.md"), "s\n");
    const declared = join(outside, "SHARED.md");

    // Nothing declared: refused.
    expect(classifyContextDoc(root, declared, {}).kind).toBe("rejected");

    // Declared in the environment: allowed, and the brief says which root
    // allowed it rather than merely that it is external.
    const allowed = classifyContextDoc(root, declared, { [TRUSTED_ROOTS_ENV]: outside });
    expect(allowed.kind, "a trusted root did not admit its own file").toBe("included");
    expect(allowed.kind === "included" && allowed.external).toBe(true);
    expect(allowed.kind === "included" && allowed.trustedBy).toBe(outside);

    // A DIFFERENT trusted root does not admit it, or the allowlist is a
    // boolean wearing a path's clothes.
    const other = join(outside, "..", "unrelated");
    mkdirSync(other, { recursive: true });
    expect(classifyContextDoc(root, declared, { [TRUSTED_ROOTS_ENV]: other }).kind).toBe("rejected");

    // And the thing this issue is actually about: an allowlist inside the
    // config it is allowing is not one. A project that declares the key in
    // its own rungate config gets nothing — the classifier is handed an
    // environment, and the repository under test cannot reach it.
    const fromConfig = { trustedDocRoots: outside } as unknown as NodeJS.ProcessEnv;
    expect(classifyContextDoc(root, declared, fromConfig).kind).toBe("rejected");

    // A relative entry in the variable is not a root. Half an absolute path
    // is how an allowlist silently matches the wrong directory.
    expect(trustedDocRoots({ [TRUSTED_ROOTS_ENV]: "elsewhere" })).toHaveLength(0);
    expect(trustedDocRoots({ [TRUSTED_ROOTS_ENV]: `${outside}:/nope/nothing` })).toContain(outside);
    expect(trustedDocRoots({})).toHaveLength(0);
  });

  test("SC-1915: a path that does not exist is still resolved through its links", () => {
    const { root, outside } = scene();
    symlinkSync(outside, join(root, "docs"));

    // `realpathSync` throws on a missing path, so the obvious implementation
    // falls back to a lexical resolve — and then the missing case and the
    // symlink case become mutually exclusive, with the bypass sitting in the
    // gap. Nothing is written at the target here.
    expect(realPathish(join(root, "docs", "GONE.md"))).toBe(join(outside, "GONE.md"));
    const v = classifyContextDoc(root, "docs/GONE.md", {});
    expect(v.kind, "a missing file behind a link out of the project was admitted").toBe("rejected");

    // And a missing path with no links in it is still just missing, which is
    // #439's verdict and must not have become a refusal.
    const plain = classifyContextDoc(root, "NOT-THERE.md", {});
    expect(plain.kind).toBe("included");
    expect(plain.kind === "included" && plain.missing).toBe(true);
    expect(plain.kind === "included" && plain.external).toBe(false);

    // A path below nothing at all resolves to itself rather than throwing.
    expect(realPathish("/no/such/root/at/all/DOC.md")).toBe("/no/such/root/at/all/DOC.md");
  });

  test("SC-1916: the AC contextFiles door is the same door", async () => {
    // #439's own finding was that the old filter was never a path control
    // because it covered one of two doors. A control on `contextDocs` alone
    // repeats that exactly: `contextFiles` comes from the AC schema and is
    // rendered into the same brief.
    const { root, outside } = scene();
    writeFileSync(join(outside, "KEYS.md"), "k\n");
    writeFileSync(join(root, "INSIDE.md"), "i\n");

    const workDir = join(root, "..", "work-497");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 2,
        issue: 497,
        repo: "t/r",
        issueRepo: "t/r",
        projectRoot: root,
        slug: "ctx-497",
        phase: "BUILD",
        issueGoal: "a declared doc may not leave the project",
        acs: [
          {
            id: "AC-1",
            type: "CODE",
            statement: "s",
            threshold: { op: "contains", value: "x" },
            evidenceMethod: { type: "grep", command: "grep x f" },
            evidence: null,
            verdict: "PENDING",
            contextFiles: [
              { path: join(outside, "KEYS.md"), reason: "needed" },
              { path: "INSIDE.md", reason: "also needed" },
            ],
          },
        ],
        gates: {},
        changelog: [],
      }),
    );

    const result = await assembleBrief({ slug: "ctx-497", workDir, projectRoot: root });
    const text = readFileSync(result.briefPath, "utf-8");

    expect(text, "an external AC context file was handed to the agent").not.toContain(
      `- ${join(outside, "KEYS.md")} —`,
    );
    expect(text).toContain("REJECTED");
    expect(text, "the rejection does not name the file").toContain("KEYS.md");
    // The positive control, on the same door in the same brief: a path
    // inside the project is untouched, or the case is satisfied by a door
    // that refuses everything.
    expect(text).toContain("- INSIDE.md — also needed");
  });
});
