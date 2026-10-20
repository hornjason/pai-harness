/**
 * Uploading screenshots, measured without uploading anything (#806).
 *
 * Three cases in this file used to hand a real file to
 * `uploadScreenshotsToIssue`, which shells out to `gh gist create --public`.
 * There was no seam, so every `bun test` run published four PUBLIC gists to
 * whoever ran it: 3,667 existed on the account when this was found, every
 * gist on it, from 2026-09-30 to 2026-10-20. The same three cases were the
 * red shard on `main` at `b5ffabca`, timing out at 5000.36ms, 5001.44ms and
 * 5001.46ms — bun's default budget to the millisecond — because the verdict
 * was decided by how fast GitHub answered rather than by the code.
 *
 * The two cases that always passed are the two that return before any spawn.
 * That is the whole tell, and it was visible in the log the day it was filed.
 *
 * Every case here injects `createGist`. None spawns a process, and AC-2
 * asserts that rather than promising it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  uploadScreenshotsToIssue,
  createPublicGist,
  type GistCreator,
} from "../lib/screenshot-upload.ts";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let TEST_DIR: string;

/**
 * A creator that records what it was asked for and answers like `gh` does.
 *
 * It is NOT `createPublicGist` with the network stubbed out — it is the
 * reading the real one returns, so a case can state the input it varies.
 */
function fakeGists(urlFor: (filePath: string) => string): {
  create: GistCreator;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    create: async (filePath: string) => {
      calls.push(filePath);
      return `${urlFor(filePath)}\n`;
    },
  };
}

const OK = (_: string) => "https://gist.github.com/user/abc123";

describe("screenshot-upload", () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), "screenshot-upload-"));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function plant(name: string, body = "fake-png-data"): string {
    const p = join(TEST_DIR, name);
    writeFileSync(p, Buffer.from(body));
    return p;
  }

  test("handles empty file list gracefully", async () => {
    const gh = fakeGists(OK);
    const result = await uploadScreenshotsToIssue(123, "owner/repo", [], {
      createGist: gh.create,
    });

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.markdownLinks).toEqual([]);
    expect(gh.calls, "an empty list must not reach the seam at all").toEqual([]);
  });

  test("handles non-existent files gracefully", async () => {
    const gh = fakeGists(OK);
    const result = await uploadScreenshotsToIssue(
      123,
      "owner/repo",
      ["/nonexistent/screenshot.png"],
      { createGist: gh.create },
    );

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toContain("/nonexistent/screenshot.png");
    expect(result.markdownLinks).toEqual([]);
    // The existence check is what stops it, so the seam is never reached —
    // without this the case passes identically on a creator that refuses.
    expect(gh.calls).toEqual([]);
  });

  // AC-5. The network version of this case could assert only that the result
  // had three array-shaped properties, because it had no idea what the real
  // `gh` would say. With the answer injected, the actual format is assertable.
  test("AC-5: the markdown link names the file and the raw URL built from the gist id", async () => {
    const file = plant("test-screenshot.png");
    const gh = fakeGists(() => "https://gist.github.com/someone/abc123");

    const result = await uploadScreenshotsToIssue(123, "owner/repo", [file], {
      createGist: gh.create,
    });

    expect(gh.calls).toEqual([file]);
    expect(result.uploaded).toEqual([file]);
    expect(result.failed).toEqual([]);
    expect(result.markdownLinks).toEqual([
      "![test-screenshot.png](https://gist.githubusercontent.com/owner/abc123/raw/test-screenshot.png)",
    ]);
  });

  test("AC-5: every uploaded file has exactly one link, in order", async () => {
    const one = plant("screenshot-1.png", "fake-png-1");
    const two = plant("screenshot-2.png", "fake-png-2");
    // A DIFFERENT id per file, because one shared id cannot witness the
    // correspondence: both links would be right by accident.
    const gh = fakeGists(p => `https://gist.github.com/user/${p.endsWith("1.png") ? "id1" : "id2"}`);

    const result = await uploadScreenshotsToIssue(123, "owner/repo", [one, two], {
      createGist: gh.create,
    });

    expect(gh.calls).toEqual([one, two]);
    expect(result.uploaded).toEqual([one, two]);
    expect(result.markdownLinks.length).toBe(result.uploaded.length);
    expect(result.markdownLinks[0]).toContain("/id1/raw/screenshot-1.png");
    expect(result.markdownLinks[1]).toContain("/id2/raw/screenshot-2.png");
    for (const link of result.markdownLinks) expect(link).toMatch(/^!\[.*\]\(.+\)$/);
  });

  // AC-4, both halves. Neither was reachable before: a real `gh` cannot be
  // asked to throw on demand, and cannot be asked to print something that is
  // not a gist URL.
  test("AC-4: a creator that throws puts its file in failed and links nothing", async () => {
    const file = plant("boom.png");

    const result = await uploadScreenshotsToIssue(123, "owner/repo", [file], {
      createGist: async () => {
        throw new Error("gh: HTTP 503");
      },
    });

    expect(result.failed).toEqual([file]);
    expect(result.uploaded).toEqual([]);
    expect(result.markdownLinks).toEqual([]);
  });

  test("AC-4: output that is not a gist URL is a failure, not a link to it", async () => {
    const file = plant("odd.png");

    for (const answer of ["", "   ", "not a url", "https://example.com/abc123"]) {
      const result = await uploadScreenshotsToIssue(123, "owner/repo", [file], {
        createGist: async () => answer,
      });
      expect(result.failed, `"${answer}" must not be read as a gist`).toEqual([file]);
      expect(result.markdownLinks).toEqual([]);
    }
  });

  test("AC-4: one file failing does not stop the ones after it", async () => {
    const good = plant("good.png");
    const bad = plant("bad.png");
    const alsoGood = plant("also-good.png");

    const result = await uploadScreenshotsToIssue(
      123,
      "owner/repo",
      [good, bad, alsoGood],
      {
        createGist: async p => {
          if (p === bad) throw new Error("gh: HTTP 503");
          return "https://gist.github.com/user/abc123";
        },
      },
    );

    expect(result.uploaded).toEqual([good, alsoGood]);
    expect(result.failed).toEqual([bad]);
    expect(result.markdownLinks.length).toBe(2);
  });

  // AC-2. The point of the file: no case above may reach the network. A
  // comment saying so is what the previous version had.
  test("AC-2: every call in this file injects the seam, so none can reach the network", () => {
    const source = readFileSync(join(import.meta.dir, "screenshot-upload.test.ts"), "utf-8");

    // The needles are COMPOSED at runtime. Spelled as literals they would
    // appear in this file and the probe would count itself — which is
    // `.claude/rules/self-referential-tests.md`'s trap, and the first draft
    // of this case fell straight into it: a checker that greps for a string
    // cannot tell a use from a mention of one.
    const CALL = "uploadScreenshots" + "ToIssue(";
    const INJECT = "createGist" + ":";

    const calls = source.split(CALL).length - 1;
    const injections = source.split(INJECT).length - 1;

    expect(calls, "the probe found no calls — it has stopped measuring").toBeGreaterThan(0);
    expect(
      injections,
      `${calls} call(s) into the subject and ${injections} seam injection(s). ` +
        "A call without `createGist` publishes a real public gist on every run of this suite.",
    ).toBe(calls);
  });

  // AC-3. Without this, the seam could be wired to a stub in production and
  // every case above would stay green — which is the defect wearing the fix.
  test("AC-3: production gets the real gh command, through one site", () => {
    const lib = readFileSync(
      join(import.meta.dir, "..", "lib", "screenshot-upload.ts"),
      "utf-8",
    );

    expect(typeof createPublicGist).toBe("function");

    // Count the SPAWN, not the phrase. `gh gist create` also appears in that
    // module's prose, and a probe that cannot tell the command from a
    // sentence about the command reports two deciders where there is one.
    const SPAWN = "$" + "`gh gist create --public";
    expect(
      lib.split(SPAWN).length - 1,
      "exactly one site may spawn; a second would survive any mutation of the first",
    ).toBe(1);

    // The default is the real creator, not a placeholder.
    const DEFAULT = "opts?.createGist ?? create" + "PublicGist";
    expect(lib).toContain(DEFAULT);
  });
});
