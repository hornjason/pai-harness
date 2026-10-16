/**
 * The `.gitignore` the scaffold writes, checked by RUNNING git (#474).
 *
 * `createGitignore` had two branches holding two lists in two syntaxes. The
 * fresh-template branch wrote `credentials.json`; the append branch derived
 * its own form with `e.includes("*") ? e : \`${e}/\``, and a trailing slash
 * in gitignore syntax restricts the pattern to DIRECTORIES:
 *
 * | Intended | Appended | Matches a file `credentials.json`? |
 * |---|---|---|
 * | `credentials.json` | `credentials.json/` | no |
 * | `service-account*` | `service-account/` | no |
 *
 * Six of the eight entries are directories, so the bug was invisible for
 * them — and the two it broke are the two FILES in the block labelled
 * "Environment and secrets". The scaffold reported
 * `UPDATED: .gitignore (added 8 missing entries)` with two of them inert, on
 * exactly the path an existing project takes when it adopts rungate.
 *
 * ## Why every case here spawns git
 *
 * **A text assertion cannot see this bug.** `expect(src).toContain(
 * "credentials.json")` passes against `credentials.json/` — the broken form
 * contains the substring. That is `.claude/rules/checks-must-be-able-to-
 * fail.md`'s second shape, a detector narrower than what it detects, and it
 * is why this shipped. Only `git check-ignore` distinguishes them, so every
 * case below plants a real repo, touches a real file and asks git.
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * `test/scaffold-gitignore.test.ts` (10 tests):
 *
 * | Mutation | Red | Predicted |
 * |---|---|---|
 * | the trailing-slash transform restored on the append path — #474 verbatim | 4 | 4 |
 * | presence reverted to `existing.includes(entry)` | 2 | 2 |
 * | `credentials.json/` written into the one list | 4 | 2 |
 * | `requiredGitignorePatterns` short-circuited to `return []` | 4 | 4 |
 *
 * None is left in the tree; all were run and reverted.
 *
 * The third row missed, and the two extra reds are the line-wise cases
 * below. They probe with the literal string `credentials.json`, so they are
 * sensitive to what the list CONTAINS as well as to how presence is decided.
 * That is coupling rather than coverage and it is left in deliberately: the
 * alternative is deriving the probe from the list, which would make the
 * fixture agree with the code it checks — the same reason `SECRET_FILES` is
 * written out by hand instead of filtered for a trailing slash.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createGitignore,
  gitignoreTemplate,
  missingGitignorePatterns,
  requiredGitignorePatterns,
} from "../lib/scaffold/steps";

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real git repo, because `git check-ignore` needs one. */
function repo(existingGitignore?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-gi-"));
  scratch.push(dir);
  // No identity is configured: nothing here commits, and `git check-ignore`
  // does not need one. #84's isolation check is right to refuse an identity
  // write whose target a reader cannot see at the call site, and the cheapest
  // way to satisfy it is not to need one.
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf-8" });
  if (existingGitignore !== undefined) writeFileSync(join(dir, ".gitignore"), existingGitignore);
  return dir;
}

/** Does git ignore `path` in `dir`? Exit 0 means ignored. */
function ignored(dir: string, path: string): boolean {
  const abs = join(dir, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x");
  return spawnSync("git", ["-C", dir, "check-ignore", "-q", "--", path]).status === 0;
}

/**
 * The entries that are FILES, and the ones the trailing-slash bug inverted.
 *
 * Named explicitly rather than derived from the pattern list: deriving them
 * with "has no trailing slash" would make the fixture agree with the code it
 * is checking, and then a pattern that regrew a slash would quietly drop out
 * of the corpus instead of failing.
 */
const SECRET_FILES: Array<[string, string]> = [
  ["credentials.json", "the default filename a Google OAuth client-secrets download uses"],
  ["service-account-key.json", "matched by service-account*"],
  ["server.pem", "matched by *.pem"],
  ["id_rsa.key", "matched by *.key"],
  ["bundle.p12", "matched by *.p12"],
  ["cert.pfx", "matched by *.pfx"],
  [".env", "the literal entry"],
  [".env.production", "matched by .env.*"],
  [".secrets.yml", "matched by .secret*"],
];

describe("#474: a freshly written .gitignore actually ignores the secrets it names", () => {
  test("git ignores every secret FILE the template claims to cover", () => {
    const dir = repo();
    createGitignore(dir, []);
    for (const [file, why] of SECRET_FILES) {
      expect(ignored(dir, file), `${file} is not ignored — ${why}`).toBe(true);
    }
  });

  test("the positive control: a file nothing names is NOT ignored", () => {
    // Without this, a `.gitignore` of `*` would satisfy every case above.
    const dir = repo();
    createGitignore(dir, []);
    expect(ignored(dir, "README.md"), "the ignore file matches everything").toBe(false);
    expect(ignored(dir, "src/index.ts")).toBe(false);
    // ...and the deliberate un-ignore still works.
    expect(ignored(dir, ".env.example"), "!.env.example was overridden").toBe(false);
  });
});

describe("#474: ADOPTING a project — the branch that was broken", () => {
  test("THE BUG: appending to an existing .gitignore ignores credentials.json", () => {
    // Measured on a real repo scaffolded before the fix:
    //   $ touch credentials.json && git check-ignore -v credentials.json
    //   $ echo $?
    //   1          # not ignored
    // The append branch wrote `credentials.json/`, which cannot match a file.
    const dir = repo("# my project\nnode_modules/\n*.log\n");
    const actions: string[] = [];
    createGitignore(dir, actions);
    expect(actions.join(" ")).toContain("UPDATED");

    for (const [file, why] of SECRET_FILES) {
      expect(ignored(dir, file), `${file} is not ignored after adoption — ${why}`).toBe(true);
    }
  });

  test("no pattern is written with a trailing slash it did not declare", () => {
    // The transform, stated as a property of the OUTPUT rather than of the
    // code that produced it: whatever the append branch writes must appear
    // in the one list verbatim.
    const dir = repo("# existing\n");
    createGitignore(dir, []);
    const written = readFileSync(join(dir, ".gitignore"), "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "" && !l.startsWith("#"));
    const declared = new Set(requiredGitignorePatterns());
    for (const line of written) {
      if (line === "existing") continue;
      expect(declared.has(line), `${line} was written by nothing in the one list`).toBe(true);
    }
  });

  test("both branches agree, which is the fix", () => {
    // Two lists that must agree is the shape the rule file closes with.
    // Collapsed rather than corrected, so there is nothing left to diverge.
    const template = new Set(
      gitignoreTemplate()
        .split("\n")
        .map(l => l.trim())
        .filter(l => l !== "" && !l.startsWith("#")),
    );
    for (const p of requiredGitignorePatterns()) {
      expect(template.has(p), `${p} is required on adoption but absent from the template`).toBe(true);
    }
  });

  test("an adopting repo and a fresh repo ignore exactly the same things", () => {
    // The end-to-end form of the case above, measured through git rather
    // than by comparing strings. This is what actually failed before: the
    // two files below were ignored in one repo and tracked in the other.
    const fresh = repo();
    createGitignore(fresh, []);
    const adopted = repo("# existing project\n");
    createGitignore(adopted, []);

    const probes = [...SECRET_FILES.map(([f]) => f), "README.md", "node_modules/x", "dist/x"];
    for (const p of probes) {
      expect(ignored(adopted, p), `${p} differs between a fresh and an adopting repo`)
        .toBe(ignored(fresh, p));
    }
  });
});

describe("#474: presence is decided line-wise, not by substring", () => {
  test("a COMMENT mentioning an entry does not satisfy it", () => {
    // `existing.includes(entry)` reported `credentials.json` as present
    // because of a sentence about it, and appended nothing. The entry was
    // "handled" by prose.
    const existing = "# credentials.json lives in 1Password\n";
    expect(missingGitignorePatterns(existing)).toContain("credentials.json");

    const dir = repo(existing);
    createGitignore(dir, []);
    expect(ignored(dir, "credentials.json"), "a comment about it counted as ignoring it")
      .toBe(true);
  });

  test("a LONGER line containing the pattern does not satisfy it", () => {
    // `*.key` was satisfied by `*.keystore`, and `service-account` by the
    // longer `service-account*` — which is how the two lists stayed
    // different for as long as they did.
    expect(missingGitignorePatterns("*.keystore\n")).toContain("*.key");
    expect(missingGitignorePatterns("my-credentials.json.bak\n")).toContain("credentials.json");
  });

  test("an entry genuinely present is NOT re-added", () => {
    // The positive control for the comparison. A checker that found
    // everything missing would satisfy both cases above and append the
    // whole list to every repo on every re-scaffold.
    const whole = requiredGitignorePatterns().join("\n") + "\n";
    expect(missingGitignorePatterns(whole)).toEqual([]);

    const dir = repo(whole);
    const actions: string[] = [];
    createGitignore(dir, actions);
    expect(actions.join(" ")).toContain("SKIP");
    expect(readFileSync(join(dir, ".gitignore"), "utf-8"))
      .not.toContain("Added by rungate scaffold");
  });

  test("whitespace and trailing newlines do not make an entry look missing", () => {
    expect(missingGitignorePatterns("  credentials.json  \n")).not.toContain("credentials.json");
  });
});
