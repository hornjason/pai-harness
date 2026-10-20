import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  uploadScreenshotsToIssue,
  type GistRunner,
} from "../lib/screenshot-upload.ts";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stripJsComments } from "../lib/strip-js-comments.ts";

/**
 * #805. Three cases in this file used to hand a real file to
 * `uploadScreenshotsToIssue`, which shells out to `gh gist create --public`.
 *
 * In CI that call has no usable credential, so it hung to the 5000ms budget
 * in `bunfig.toml` and took `main` red — read as a flake for three weeks
 * because a timeout prints no message. On an authenticated machine it
 * SUCCEEDED, and four public gists were published per full-suite run: 3,667
 * of them on the account by 2026-10-20, every gist it held, back to
 * 2026-09-30.
 *
 * A test suite does not get to make an outbound write. Every case below
 * drives an injected runner, and the two guards at the bottom are what stop
 * the real one coming back.
 */

const SELF = "screenshot-upload.test.ts";
const REPO = "owner/repo";
const ISSUE = 123;

let dir: string;

beforeEach(() => {
  // #323 SC-6. This was the fixed `/tmp/screenshot-upload-test`, with the
  // recursive delete below pointed at it — so two concurrent runs, two
  // shards or two sessions deleted each other's fixtures. Outside the
  // repository, so `test/scratch-paths-unique.test.ts` does not scan for it;
  // the defect is the same one either way.
  dir = mkdtempSync(join(tmpdir(), "screenshot-upload-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A runner that answers like `gh gist create` and touches nothing. */
function gistRunner(urlFor: (file: string) => string): {
  run: GistRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: async filePath => {
      calls.push(filePath);
      return urlFor(filePath);
    },
  };
}

const GOOD = (id: string) => () => `https://gist.github.com/user/${id}\n`;

/**
 * The ONLY call to the real export in this file. Every case goes through
 * here, so there is one position to audit and the guard below can count it.
 */
function upload(paths: string[], run: GistRunner) {
  return uploadScreenshotsToIssue(ISSUE, REPO, paths, run);
}

function plant(name: string, bytes: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(bytes));
  return p;
}

describe("screenshot-upload", () => {
  test("handles empty file list gracefully", async () => {
    const { run, calls } = gistRunner(GOOD("abc123"));
    const result = await upload([], run);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.markdownLinks).toEqual([]);
    expect(calls, "an empty list must not reach the runner").toEqual([]);
  });

  test("handles non-existent files gracefully", async () => {
    const { run, calls } = gistRunner(GOOD("abc123"));
    const missing = join(dir, "nonexistent", "screenshot.png");
    const result = await upload([missing], run);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toContain(missing);
    expect(result.markdownLinks).toEqual([]);
    expect(calls, "an absent file must not reach the runner").toEqual([]);
  });

  test("returns proper markdown link format", async () => {
    const file = plant("test-screenshot.png", "fake-png-data");
    const { run, calls } = gistRunner(GOOD("abc123"));

    const result = await upload([file], run);

    // Asserted as a whole string. `toContain("gist")` is satisfied by the
    // gist URL the runner returned, which is the input rather than the
    // derivation.
    expect(result.uploaded).toEqual([file]);
    expect(result.failed).toEqual([]);
    expect(result.markdownLinks).toEqual([
      "![test-screenshot.png](https://gist.githubusercontent.com/owner/abc123/raw/test-screenshot.png)",
    ]);
    expect(calls).toEqual([file]);
  });

  test("processes multiple files", async () => {
    const one = plant("screenshot-1.png", "fake-png-1");
    const two = plant("screenshot-2.png", "fake-png-2");
    const { run, calls } = gistRunner(f =>
      f.endsWith("screenshot-1.png")
        ? "https://gist.github.com/user/id1"
        : "https://gist.github.com/user/id2",
    );

    const result = await upload([one, two], run);

    expect(result.uploaded).toEqual([one, two]);
    expect(result.failed).toEqual([]);
    expect(calls).toEqual([one, two]);
    expect(result.markdownLinks).toEqual([
      "![screenshot-1.png](https://gist.githubusercontent.com/owner/id1/raw/screenshot-1.png)",
      "![screenshot-2.png](https://gist.githubusercontent.com/owner/id2/raw/screenshot-2.png)",
    ]);
  });

  test("markdown links match uploaded files", async () => {
    const file = plant("test.png", "fake-png");
    const { run } = gistRunner(GOOD("xyz789"));

    const result = await upload([file], run);

    // The `if (result.uploaded.length > 0)` this used to be wrapped in made
    // it vacuous on exactly the runs where the upload did not happen — which
    // is every CI run this file has ever had.
    expect(result.uploaded.length).toBe(1);
    expect(result.markdownLinks.length).toBe(result.uploaded.length);
    expect(result.markdownLinks[0]).toMatch(/^!\[.+\]\(https:\/\/.+\)$/);
  });

  describe("#805: the seam did not buy green by removing the check", () => {
    test("a reply that is not a gist URL is a failure, not an upload", async () => {
      const file = plant("test.png", "fake-png");
      const { run } = gistRunner(() => "https://example.com/not-a-gist");

      const result = await upload([file], run);

      expect(result.uploaded).toEqual([]);
      expect(result.failed).toEqual([file]);
      expect(result.markdownLinks).toEqual([]);
    });

    test("an empty reply is a failure, not an upload", async () => {
      const file = plant("test.png", "fake-png");
      const { run } = gistRunner(() => "   \n");

      const result = await upload([file], run);

      expect(result.uploaded).toEqual([]);
      expect(result.failed).toEqual([file]);
    });

    test("a runner that throws fails that file and keeps going", async () => {
      const bad = plant("screenshot-1.png", "fake-png-1");
      const good = plant("screenshot-2.png", "fake-png-2");
      const run: GistRunner = async f => {
        if (f === bad) throw new Error("gh exited 1");
        return "https://gist.github.com/user/id2";
      };

      const result = await upload([bad, good], run);

      expect(result.failed).toEqual([bad]);
      expect(result.uploaded).toEqual([good]);
    });
  });

  describe("#805: no case in this file can reach the network", () => {
    test("there is exactly one call site, and it injects a runner", () => {
      // Comments stripped, literals kept. Both halves are load-bearing and
      // both were measured: the explanatory comment below spells
      // `uploadScreenshotsToIssue(123, …)` and a raw-source count reads it
      // as a second call site — the citation-versus-claim trap
      // `.claude/rules/checks-must-be-able-to-fail.md` names, met by the
      // guard's own prose. Blanking literals instead would delete the
      // signature string this case also asserts.
      const self = stripJsComments(
        readFileSync(join(import.meta.dir, SELF), "utf-8"),
      );
      const calls = self.match(/uploadScreenshotsToIssue\(/g) ?? [];

      // A second direct call site is how the default parameter comes back:
      // `uploadScreenshotsToIssue(123, "owner/repo", [f])` is three
      // arguments and a real `gh gist create`, and it reads like every other
      // line in the file. Counting the call sites is cheaper to keep honest
      // than counting arguments, and `upload()` above cannot omit the runner
      // because its signature requires it.
      expect(
        calls.length,
        `${SELF} calls uploadScreenshotsToIssue directly ${calls.length} times; ` +
          `it must be exactly once, inside upload(), which takes a GistRunner ` +
          `as a required parameter (#805)`,
      ).toBe(1);

      expect(
        self.includes("function upload(paths: string[], run: GistRunner)"),
        "upload() no longer requires a runner, so a case can fall through to the real one",
      ).toBe(true);
    });

    test("the shell is reached from exactly one place in the library", () => {
      // Same reason as above: the library's own docstring explains what
      // `gh gist create` used to do, and an unstripped count read 5.
      const lib = stripJsComments(
        readFileSync(
          join(import.meta.dir, "..", "lib", "screenshot-upload.ts"),
          "utf-8",
        ),
      );

      // The guard is on the LIBRARY, not on this file, because a second
      // un-injected path added there is invisible to every case above: they
      // would all still pass, driving a runner nothing calls any more.
      expect(
        (lib.match(/gh gist create/g) ?? []).length,
        "lib/screenshot-upload.ts names `gh gist create` more than once — " +
          "every shell-out must go through realGist so the default parameter " +
          "is the only route to the network (#805)",
      ).toBe(1);

      expect(
        (lib.match(/\$`/g) ?? []).length,
        "lib/screenshot-upload.ts opens more than one shell template — see above",
      ).toBe(1);
    });
  });
});
