/**
 * Covers SC-1806..SC-1814 (HARNESS-STANDARD.md), #533.
 *
 * `workflows/ship.js` interpolates four arguments UNQUOTED into shell command
 * text inside agent prompts — `repo` at 6 sites, `issueRepo` at 11,
 * `harnessRoot` at 44, `projectRoot` at 33 — and the only check any of them
 * had was that `repo` was present.
 *
 * Not a live exploit, and this file does not claim one: `Skill("ship")`
 * derives the slug from `git remote get-url origin`. What makes it worth
 * fixing is that the same file already does the opposite thing one function
 * away — `isSafeBranchName` before a branch reaches a `git push` — and
 * `scripts/github-op.ts` has `--title-from-issue` precisely so an issue title
 * never crosses a shell. The project had already decided; `repo` is the value
 * that missed, and a harness argument is exactly the kind of thing a consumer
 * sets from a config file.
 *
 * Three layers here, and the third is the one that would have been easiest to
 * skip: the refusals exist (executed), the library and the inlined mirror
 * agree on every case (parity), and the WHOLE SCRIPT actually stops — because
 * a refusal nothing calls is a refusal that reads as a guard.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { repoSlugRefusal, rootPathRefusal } from "../lib/workflow-security";
import { runWorkflow } from "../lib/workflow-test-harness";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** The inlined mirrors, lifted out of ship.js and callable. */
function inlined(): {
  repoSlugRefusal: (n: string, v: unknown) => string | null;
  rootPathRefusal: (n: string, v: unknown) => string | null;
} {
  const start = SHIP.indexOf("// ──── SECURITY-HELPERS-START ────");
  const end = SHIP.indexOf("// ──── SECURITY-HELPERS-END ────");
  if (start < 0 || end < 0) throw new Error("ship.js is missing the SECURITY-HELPERS markers");
  return new Function(
    "PROJECT_ROOT", "log",
    `${SHIP.slice(start, end)}; return { repoSlugRefusal, rootPathRefusal };`,
  )("/tmp/project", () => {}) as ReturnType<typeof inlined>;
}

const SLUGS: Array<[string, unknown, boolean]> = [
  ["an ordinary slug", "hornjason/pai-harness", true],
  ["dots, dashes and underscores", "Org.Name/some_repo-1.2", true],
  ["digits only", "123/456", true],

  ["a command substitution", "o/r$(curl evil.example.com)", false],
  ["a backtick", "o/r`id`", false],
  ["a separator", "o/r; rm -rf /", false],
  ["a pipe", "o/r|sh", false],
  ["a space", "o/my repo", false],
  ["a quote", 'o/"r', false],
  ["a single quote", "o/'r", false],
  ["a newline", "o/r\nmain", false],
  ["a traversal segment", "o/..", false],
  ["a dot segment", "./r", false],
  // Flagged by the commit security review on this branch. Not a live hole —
  // every site puts the value after `--repo`, where a parser reads it as
  // that flag's value — but `isSafeBranchName` refuses a leading dash one
  // function below with the reason that git and gh both read it as a flag,
  // and no GitHub name may begin with `-` or `.` anyway.
  ["a leading dash on the owner", "-o/r", false],
  ["a leading dash on the name", "o/-r", false],
  ["a leading dot", "o/.r", false],
  ["a trailing dot", "o/r.", false],
  ["three segments", "o/r/x", false],
  ["one segment", "justaname", false],
  ["empty", "", false],
  ["a leading slash", "/o/r", false],
  ["not a string", 42, false],
  ["absent", undefined, false],
];

const ROOTS: Array<[string, unknown, boolean]> = [
  ["an ordinary root", "/Users/x/Projects/thing", true],
  ["a root with dots and dashes", "/opt/my-app.v2/root", true],
  ["the filesystem root", "/", true],

  ["a relative path", "Projects/thing", false],
  ["a tilde, which is not expanded by this interpolation", "~/Projects/thing", false],
  ["a command substitution", "/tmp/$(id)", false],
  ["a backtick", "/tmp/`id`", false],
  ["a separator", "/tmp; rm -rf /", false],
  ["a space", "/Users/x/My Projects/thing", false],
  ["a tab", "/tmp/a\tb", false],
  ["a newline", "/tmp/a\nb", false],
  ["a traversal segment", "/tmp/../etc", false],
  ["a null byte", "/tmp/a\u0000b", false],
  ["empty", "", false],
  ["not a string", {}, false],
  ["absent", undefined, false],
];

// ── the refusals themselves ──────────────────────────────────

describe("#533: the shapes an argument reaching a shell must have", () => {
  test("SC-1806: a repo slug is refused unless it is owner/name", () => {
    const wrong = SLUGS.filter(([, v, ok]) => (repoSlugRefusal("repo", v) === null) !== ok);
    expect(wrong.map(([label]) => label), "these cases disagree with the refusal").toEqual([]);
    // Not vacuous in either direction: the table has to contain both verdicts,
    // or a function that refused everything — or nothing — would pass the row.
    expect(SLUGS.filter(([, , ok]) => ok).length).toBeGreaterThan(0);
    expect(SLUGS.filter(([, , ok]) => !ok).length).toBeGreaterThan(5);
  });

  test("SC-1807: a root is refused unless it is an absolute path with nothing a shell reads", () => {
    const wrong = ROOTS.filter(([, v, ok]) => (rootPathRefusal("projectRoot", v) === null) !== ok);
    expect(wrong.map(([label]) => label), "these cases disagree with the refusal").toEqual([]);
    expect(ROOTS.filter(([, , ok]) => ok).length).toBeGreaterThan(0);
    expect(ROOTS.filter(([, , ok]) => !ok).length).toBeGreaterThan(5);
  });

  test("SC-1808: a root refusal is the opposite question from a contributable path", () => {
    // `pathRefusal` refuses an absolute path, because it answers "may an
    // agent contribute this file from inside its worktree". This one REQUIRES
    // one, because it answers "may the run cd here". Pinned, because folding
    // the two together is the natural tidy-up and it would make one of them
    // wrong — and because two deciders that agree are indistinguishable from
    // one, which is what makes this distinction worth a row.
    expect(rootPathRefusal("projectRoot", "/Users/x/p")).toBeNull();
    expect(rootPathRefusal("projectRoot", "lib/a.ts")).toContain("absolute");
  });

  test("SC-1809: a refusal names the argument and truncates the value", () => {
    // The message is printed, logged and pasted into issues, and the value is
    // attacker-shaped by assumption at the point this runs.
    const long = "/tmp/" + "a".repeat(400) + "$(id)";
    const why = String(rootPathRefusal("harnessRoot", long));
    expect(why).toContain("harnessRoot");
    expect(why.length, "the whole value was echoed back into the message").toBeLessThan(200);

    // An absent value says "nothing" rather than the string "undefined",
    // which reads as a value someone actually passed.
    expect(String(repoSlugRefusal("repo", undefined))).toContain("nothing");
    expect(String(repoSlugRefusal("repo", undefined))).not.toContain('"undefined"');

    // And every refusal names its argument, or an operator with four of them
    // cannot tell which one to fix.
    for (const [, v, ok] of [...SLUGS, ...ROOTS]) {
      if (ok) continue;
      const r = repoSlugRefusal("theArg", v) ?? rootPathRefusal("theArg", v);
      expect(String(r), `${JSON.stringify(v)} produced a refusal with no argument name`).toContain("theArg");
    }
  });

  test("SC-1810: the library and ship.js's inlined mirror agree on every case", () => {
    // The sandbox has no module loading (#69), so ship.js carries a copy.
    // A copy nothing compares is a copy that drifts, and the drift shows up
    // as a guard that is present in one place and absent where it runs.
    const copy = inlined();
    const disagreements: string[] = [];
    for (const [label, v] of SLUGS) {
      const a = repoSlugRefusal("repo", v);
      const b = copy.repoSlugRefusal("repo", v);
      if (a !== b) disagreements.push(`repo/${label}: library ${JSON.stringify(a)} vs inlined ${JSON.stringify(b)}`);
    }
    for (const [label, v] of ROOTS) {
      const a = rootPathRefusal("projectRoot", v);
      const b = copy.rootPathRefusal("projectRoot", v);
      if (a !== b) disagreements.push(`root/${label}: library ${JSON.stringify(a)} vs inlined ${JSON.stringify(b)}`);
    }
    expect(disagreements).toEqual([]);
    // Identical MESSAGES, not merely identical verdicts. A mirror that
    // refused the same inputs with different words would still be a drift,
    // and the next person to read one would be reading the other's behaviour.
    expect(copy.repoSlugRefusal("repo", "o/r; rm -rf /"))
      .toBe(repoSlugRefusal("repo", "o/r; rm -rf /"));
  });
});

// ── the whole script, actually stopping ──────────────────────

describe("#533: the run refuses before any of it reaches a shell", () => {
  const ARGS = { issue: 1, projectRoot: "/tmp/p", repo: "o/r", harnessRoot: "/tmp/h" };

  const ran = (over: Record<string, unknown>) =>
    runWorkflow(SHIP, { args: { ...ARGS, ...over } });

  test("SC-1811: each of the four arguments stops the run by name", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["repo", { repo: "o/r$(id)" }],
      ["issueRepo", { issueRepo: "o/r; rm -rf /" }],
      ["projectRoot", { projectRoot: "/tmp/p`id`" }],
      ["harnessRoot", { harnessRoot: "relative/path" }],
    ];
    for (const [name, over] of bad) {
      const r = await ran(over);
      expect(r.error, `${name}: the harness threw instead of refusing`).toBeNull();
      const out = (r.result ?? {}) as Record<string, unknown>;
      expect(out.status, `${name} did not stop the run`).toBe("ARGS_ERROR");
      expect(String(out.message)).toContain(name);
      // Nothing was spawned. A refusal after the first agent call has already
      // sent the value somewhere, and the whole point of an argument check is
      // that it happens first.
      expect(r.calls.filter(c => c.kind === "agent"), `${name} spawned an agent before refusing`).toEqual([]);
    }
  });

  test("SC-1812: a run with four good arguments is not refused", async () => {
    // The control, and it is load-bearing: without it a refusal that fired on
    // everything would satisfy every row above, and ship.js would be unable
    // to run at all while reading as hardened.
    const r = await ran({});
    expect(r.error).toBeNull();
    const out = (r.result ?? {}) as Record<string, unknown>;
    expect(out.status).not.toBe("ARGS_ERROR");
    expect(r.calls.filter(c => c.kind === "agent").length).toBeGreaterThan(0);
  });

  test("SC-1813: an absent root and an unusable one are told apart", async () => {
    // The first draft of this row asserted that an ABSENT projectRoot gives
    // an argument error rather than a TypeError, and shipped a `String(… ||
    // '')` guard to make it so. The mutation battery measured that guard at
    // **0 red** and reverting it changed nothing, because `ship.js:187`
    // already refuses an absent projectRoot thirty-eight lines earlier. The
    // row was passing on a check that predates this issue and the fix was
    // unreachable code — a fixture satisfying its assertion through a path
    // that bypasses the feature.
    //
    // What #533 actually adds is the PRESENT-but-unusable case, so that is
    // what this row measures, together with the boundary: both are
    // ARGS_ERROR and they must not say the same thing, or an operator who
    // passed a path with a backtick in it is handed a usage line.
    const absent = (await ran({ projectRoot: undefined })).result as Record<string, unknown>;
    expect(absent.status).toBe("ARGS_ERROR");
    expect(String(absent.message), "the absent case is the usage refusal").toContain("Usage:");

    const unusable = (await ran({ projectRoot: "/tmp/p`id`" })).result as Record<string, unknown>;
    expect(unusable.status).toBe("ARGS_ERROR");
    expect(String(unusable.message)).toContain("projectRoot");
    expect(String(unusable.message)).toContain("shell metacharacter");
    // Distinguishable. Telling someone who passed a usable-looking path to
    // read the usage line sends them to re-check an argument they got right.
    expect(String(unusable.message)).not.toContain("Usage:");
  });

  test("SC-1814: passing slug instead of repo still works - and issueRepo is still checked", async () => {
    // `repo` is optional when `slug` is given: that is the existing contract
    // at the presence check and #533 must not narrow it. Easy to break by
    // validating `repo` unconditionally, and the run would refuse a caller
    // the harness has always accepted.
    const withSlug = await ran({ repo: undefined, slug: "thing-1", issueRepo: "o/r" });
    expect(((withSlug.result ?? {}) as Record<string, unknown>).status).not.toBe("ARGS_ERROR");

    // But the exemption is for an ABSENT `repo`, not for any run that has a
    // slug. A malformed `repo` reaches its six shell sites whether or not a
    // slug was passed, and "the caller gave us a slug" says nothing about
    // that — widening the exemption to the whole check is the cheapest way
    // to make the first case above pass, and it would open the hole.
    const badRepoWithSlug = await ran({ repo: "o/r$(id)", slug: "thing-1" });
    const first = (badRepoWithSlug.result ?? {}) as Record<string, unknown>;
    expect(first.status, "a malformed repo was waved through because a slug was present").toBe("ARGS_ERROR");
    expect(String(first.message)).toContain("repo");

    // And `issueRepo` reaches eleven shell sites of its own, so an exemption
    // that spread to it would be an allowlist widening into the thing it
    // exempts.
    const badIssueRepo = await ran({ repo: undefined, slug: "thing-1", issueRepo: "o/r$(id)" });
    const out = (badIssueRepo.result ?? {}) as Record<string, unknown>;
    expect(out.status).toBe("ARGS_ERROR");
    expect(String(out.message)).toContain("issueRepo");
  });
});
