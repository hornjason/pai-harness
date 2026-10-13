/**
 * What CI's checkout actually looks like, read from CI's own workflow (#168).
 *
 * `scripts/test-clean-env.ts` claimed "a test that passes here passes in CI
 * for the same reason". On 2026-10-07 it reported 2998 pass / 0 fail on a
 * tree where CI reported 2 fail, and both failures were real. It models the
 * developer's *environment* — `HOME`, `gh` credentials, git identity — and
 * nothing about the developer's *checkout*. CI runs `actions/checkout@v4`,
 * which by default fetches one commit onto a detached HEAD with no local
 * branches. Any test whose behaviour depends on a ref or on history was
 * therefore unmodelled, and `test/prior-branch.test.ts` was exactly that: it
 * counts `main..<ref>`, which resolves on a developer's clone and does not
 * resolve in CI.
 *
 * ## Why this reads the workflow instead of hardcoding CI's shape
 *
 * The obvious implementation is `git clone --depth 1`, detach, delete `main`.
 * That is what the first draft of this did, and it was **already wrong** —
 * #347 added a `git fetch --depth=200 origin main` step to the `test` job, so
 * `origin/main` does exist by the time the suite runs. A hardcoded model
 * reported two failures that CI does not have, which is the same defect as
 * reporting zero that it does: a model nobody can trust in either direction.
 *
 * So the shape is parsed out of `.github/workflows/ci.yml`, and when the
 * workflow changes the model follows. A parse that cannot find what it
 * expects returns `null` with a reason, and the caller refuses — because a
 * modelling step that silently falls back to "run it in the working tree" is
 * the original defect with a flag on top.
 */

/** One `git fetch` the workflow performs after checkout. */
export interface FetchStep {
  /** The refspec as written, e.g. `+refs/heads/main:refs/remotes/origin/main`. */
  refspec: string;
  /** `--depth=N`, or null for an unbounded fetch. */
  depth: number | null;
}

export interface CheckoutModel {
  /** The job this was read from. */
  jobName: string;
  /** `fetch-depth`, defaulting to 1 the way `actions/checkout` does. null = full. */
  depth: number | null;
  /** Fetches the job runs after the checkout, in order. */
  fetches: FetchStep[];
}

export interface CheckoutModelResult {
  model: CheckoutModel | null;
  /** Why there is no model, when there is none. Empty when there is one. */
  why: string;
}

/**
 * What this models, and — the part that matters — what it does not.
 *
 * #168's SC-582 asks for this list in writing, because the claim it replaces
 * was absolute and wrong. Everything here is a way a local run can still
 * disagree with CI, and naming them is the difference between a model and a
 * promise.
 */
export const UNMODELLED: readonly string[] = [
  "the runner OS — CI is ubuntu-latest and this runs on the developer's machine, so anything platform-dependent (BSD vs GNU flags, path casing, file watchers) is still invisible here",
  "a fresh `bun install` — node_modules is linked from the working tree rather than installed, so a missing or mis-ranged dependency still passes locally",
  "the bun version — CI pins `bun-version: latest` at the moment the job runs; this uses whichever bun is on PATH",
  "the PR merge commit — `actions/checkout@v4` on a pull_request checks out a merge of the head into the base, while this checks out the head alone, so a conflict-free-but-broken merge is not modelled",
  "network and API availability — CI has neither the developer's `gh` credentials (stripped) nor their network conditions",
  "files git ignores — a `.env` or a stray build artefact present locally and absent in CI is carried over only if git can see it",
];

/**
 * Is this refspec safe to hand to `git fetch` as an argument?
 *
 * Found by a security review of the first commit. The refspec is read out of
 * a workflow file and pushed into an argv, and `git fetch` takes options
 * anywhere on its command line — so a refspec beginning with `-` is a flag,
 * and `--upload-pack=<command>` makes git **execute that command**. An argv
 * array stops shell metacharacters; it does nothing about a value that is
 * itself an option.
 *
 * This matters more here than the file it reads might suggest. rungate
 * scaffolds other projects, so this parses workflow files it does not own —
 * a repo whose CI contains `git fetch origin --upload-pack=...` would be
 * cloning arbitrary execution into whoever ran the harness against it.
 *
 * An allowlist, not a denylist of leading dashes: the set of characters a
 * real refspec needs is small and closed, and enumerating what is forbidden
 * is how the next option syntax gets through.
 */
export function isSafeRefspec(refspec: string): boolean {
  return /^\+?[A-Za-z0-9_][A-Za-z0-9_.\/*-]*(:[A-Za-z0-9_][A-Za-z0-9_.\/*-]*)?$/.test(refspec);
}

/**
 * Read the checkout shape out of a workflow file.
 *
 * Hand-parsed rather than YAML-parsed, because adding a YAML dependency to
 * ship a modelling script is a worse trade than a narrow parser that says so
 * when it is lost. The narrowness is the risk — a detector narrower than what
 * it detects is this repo's second-most-common defect — so every branch that
 * cannot find what it expects returns a reason rather than a default.
 */
export function parseCheckoutModel(workflowYaml: string, jobName: string): CheckoutModelResult {
  const lines = workflowYaml.split("\n");

  const jobIdx = lines.findIndex(l => new RegExp(`^\\s{2}${jobName}:\\s*$`).test(l));
  if (jobIdx === -1) {
    return { model: null, why: `no job named "${jobName}" at two-space indentation` };
  }
  const jobIndent = (/^(\s*)/.exec(lines[jobIdx]) || ["", ""])[1].length;

  // The job runs until the next key at the same indentation.
  let end = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) continue;
    const indent = (/^(\s*)/.exec(l) || ["", ""])[1].length;
    if (indent <= jobIndent) { end = i; break; }
  }
  const body = lines.slice(jobIdx, end);
  const joined = body.join("\n");

  const checkoutIdx = body.findIndex(l => /uses:\s*actions\/checkout@/.test(l));
  if (checkoutIdx === -1) {
    return { model: null, why: `job "${jobName}" has no actions/checkout step` };
  }

  // `fetch-depth` belongs to this step, so only look between it and the next
  // step marker. Reading the whole job would pick up a second checkout's
  // depth and model a checkout that never happens.
  let stepEnd = body.length;
  for (let i = checkoutIdx + 1; i < body.length; i++) {
    if (/^\s*-\s/.test(body[i])) { stepEnd = i; break; }
  }
  const stepBody = body.slice(checkoutIdx, stepEnd).join("\n");
  const depthMatch = /fetch-depth:\s*["']?(\d+)["']?/.exec(stepBody);
  // No `fetch-depth` is not "unknown" — actions/checkout documents the
  // default as 1, and that default is the whole reason this issue exists.
  const rawDepth = depthMatch ? parseInt(depthMatch[1], 10) : 1;
  const depth = rawDepth === 0 ? null : rawDepth;

  const fetches: FetchStep[] = [];
  for (const m of joined.matchAll(/git fetch\s+([^\n|]*)/g)) {
    const args = m[1];
    const refspecMatch = /['"]([^'"]*refs\/[^'"]*)['"]|(\+?refs\/\S+)/.exec(args);
    if (!refspecMatch) continue;
    const refspec = refspecMatch[1] ?? refspecMatch[2];
    if (!isSafeRefspec(refspec)) {
      return {
        model: null,
        why: `the "${jobName}" job fetches a refspec this will not pass to git: ${JSON.stringify(refspec)}`,
      };
    }
    const fetchDepth = /--depth[= ](\d+)/.exec(args);
    fetches.push({
      refspec,
      depth: fetchDepth ? parseInt(fetchDepth[1], 10) : null,
    });
  }

  return { model: { jobName, depth, fetches }, why: "" };
}

/** A command the preparer wants run. Returned rather than executed so the plan is testable. */
export interface CheckoutCommand {
  /**
   * `exec` runs `argv`. `delete-local-refs` has no fixed argv — the refs a
   * clone invents are only knowable once it exists — so the executor
   * enumerates and deletes them. Named as its own kind rather than hidden
   * behind a placeholder string, because a step a reader cannot see is a step
   * nobody checks.
   */
  kind: "exec" | "delete-local-refs";
  argv: string[];
  /** Run in the clone rather than the parent directory. */
  inClone: boolean;
  /** Failing this command is not fatal — matches the workflow's own `|| echo WARN`. */
  tolerateFailure?: boolean;
}

/** The refs a fresh clone invents and a CI runner does not have. */
export const CLONE_INVENTED_REF_PREFIXES = ["refs/heads/", "refs/remotes/"] as const;

/**
 * The exact commands that turn a source repo into a CI-shaped checkout.
 *
 * A list rather than a sequence of `execSync` calls, because the interesting
 * property — "the local branches are gone and the workflow's fetches are
 * replayed" — is then something a test can read instead of infer from a
 * directory it has to build.
 */
export function ciCheckoutPlan(opts: {
  source: string;
  dest: string;
  model: CheckoutModel;
}): CheckoutCommand[] {
  const { source, dest, model } = opts;
  const cmds: CheckoutCommand[] = [];

  const clone = ["git", "clone", "--quiet", "--no-hardlinks"];
  if (model.depth !== null) clone.push(`--depth=${model.depth}`);
  clone.push(`file://${source}`, dest);
  cmds.push({ kind: "exec", argv: clone, inClone: false });

  // Detach first: a branch cannot be deleted while it is checked out, and a
  // detached HEAD is what the runner has.
  cmds.push({ kind: "exec", argv: ["git", "checkout", "--detach", "--quiet", "HEAD"], inClone: true });
  // Every local branch and every remote-tracking ref the clone invented. The
  // runner has neither until the workflow asks for them, and leaving them is
  // precisely the blindness being fixed.
  cmds.push({ kind: "delete-local-refs", argv: [], inClone: true });

  // Point origin back at the source so the replayed fetches resolve offline.
  cmds.push({ kind: "exec", argv: ["git", "remote", "set-url", "origin", `file://${source}`], inClone: true });

  for (const f of model.fetches) {
    // Checked at the parse boundary and again here. The plan is exported and
    // a caller can build a model by hand, so the one place that turns a
    // refspec into an argument is also a place that refuses to.
    if (!isSafeRefspec(f.refspec)) continue;
    const argv = ["git", "fetch", "--no-tags"];
    if (f.depth !== null) argv.push(`--depth=${f.depth}`);
    argv.push("origin", f.refspec);
    // The workflow tolerates its own fetch failing (it prints a WARN and
    // carries on), so the model must too — a model stricter than CI starts
    // failing runs CI would pass, which costs trust the same way.
    cmds.push({ kind: "exec", argv, inClone: true, tolerateFailure: true });
  }

  return cmds;
}

/** One refusal reason, or null when the checkout was built. */
export type PrepareResult = { ok: true; refs: string[] } | { ok: false; why: string };

/**
 * The single exit code every refusal in `scripts/test-clean-env.ts` routes
 * through, per `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Declared here rather than in the script so a test can import it instead of
 * restating `2` — an assertion that hardcodes the number it is checking
 * stays green when the script stops using it.
 */
export const CLEAN_ENV_REFUSE_EXIT = 2;

export interface Runner {
  (argv: string[], cwd: string): { status: number; stdout: string; stderr: string };
}

/**
 * Execute a plan. Separate from building it so the plan can be read in a test
 * without a filesystem, and the execution checked against a real clone.
 *
 * Every refusal is a refusal. A preparer that gives up halfway and lets the
 * caller run the suite anyway would report green for a checkout it never
 * built — the exact fail-open shape `.claude/rules/checks-must-be-able-to-fail.md`
 * is about, reintroduced by the tool written to close it.
 */
export function executeCheckoutPlan(
  plan: CheckoutCommand[],
  dest: string,
  parentDir: string,
  run: Runner,
): PrepareResult {
  for (const cmd of plan) {
    const cwd = cmd.inClone ? dest : parentDir;

    if (cmd.kind === "delete-local-refs") {
      const listed = run(
        ["git", "for-each-ref", "--format=%(refname)", ...CLONE_INVENTED_REF_PREFIXES],
        cwd,
      );
      if (listed.status !== 0) {
        return { ok: false, why: `could not list the clone's refs: ${listed.stderr.trim()}` };
      }
      for (const ref of listed.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
        const del = run(["git", "update-ref", "-d", ref], cwd);
        if (del.status !== 0) {
          return { ok: false, why: `could not delete ${ref}: ${del.stderr.trim()}` };
        }
      }
      continue;
    }

    const r = run(cmd.argv, cwd);
    if (r.status !== 0 && !cmd.tolerateFailure) {
      return { ok: false, why: `${cmd.argv.join(" ")} exited ${r.status}: ${r.stderr.trim()}` };
    }
  }

  const after = run(["git", "for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"], dest);
  if (after.status !== 0) {
    return { ok: false, why: `could not read the prepared checkout's refs: ${after.stderr.trim()}` };
  }
  const refs = after.stdout.split("\n").map(s => s.trim()).filter(Boolean);

  // The one property the whole exercise is for. A plan that ran clean and
  // left `refs/heads/main` standing has modelled nothing, and would be
  // indistinguishable from a working-tree run.
  const localBranches = refs.filter(r => r.startsWith("refs/heads/"));
  if (localBranches.length > 0) {
    return {
      ok: false,
      why: `the prepared checkout still has local branches (${localBranches.join(", ")}) — ` +
        `CI has none, so this would model the developer's tree and report its answers as CI's`,
    };
  }

  return { ok: true, refs };
}

export interface PrepareOptions {
  /** The repository to model — normally the developer's working tree. */
  source: string;
  /** Where to read CI's shape from. */
  workflowPath: string;
  /** Which job in it. */
  jobName: string;
  /** Empty directory the clone goes inside. */
  tmpRoot: string;
  readFile: (path: string) => string;
  run: Runner;
  /** Copy a path from the working tree into the clone, or remove it if gone. */
  carryOver: (relPath: string, from: string, to: string) => void;
  /** Make node_modules available in the clone. */
  link: (from: string, to: string) => void;
  exists: (path: string) => boolean;
  log: (line: string) => void;
}

export type PrepareOutcome =
  | { ok: true; dir: string; model: CheckoutModel; refs: string[]; carried: string[] }
  | { ok: false; why: string; hint: string };

/**
 * Build a CI-shaped checkout of `source`, or say why not.
 *
 * In the library rather than inline in `scripts/test-clean-env.ts` for one
 * reason, and it was measured: with the decision inline, replacing its
 * refusal with "warn and run in the working tree anyway" scored **0 red**.
 * That is the worst fail-open this issue could produce — a caller who asked
 * for the strict check, was told it could not be built, and got the
 * unmodelled run the whole issue is about, reported as the strict one. The
 * script now does nothing with this but translate `ok: false` into an exit.
 *
 * Every refusal is a refusal. There is deliberately no fall-back parameter:
 * a caller who wants the working tree asks for it up front, where the choice
 * is visible, not as a silent consequence of something having gone wrong.
 */
export function prepareCiCheckout(opts: PrepareOptions): PrepareOutcome {
  const hint = "the CI checkout is read from the workflow, not assumed. Use --no-ci-checkout to run in the working tree instead.";

  let yaml: string;
  try {
    yaml = opts.readFile(opts.workflowPath);
  } catch (e) {
    return { ok: false, why: `cannot read ${opts.workflowPath} — ${(e as Error).message}`, hint };
  }

  const { model, why } = parseCheckoutModel(yaml, opts.jobName);
  if (!model) {
    return { ok: false, why: `could not read the "${opts.jobName}" job's checkout — ${why}`, hint };
  }

  const dest = `${opts.tmpRoot}/repo`;
  const result = executeCheckoutPlan(
    ciCheckoutPlan({ source: opts.source, dest, model }),
    dest,
    opts.tmpRoot,
    opts.run,
  );
  if (!result.ok) {
    return { ok: false, why: `could not build the CI checkout — ${result.why}`, hint };
  }

  // Uncommitted work. CI tests a pushed commit, but a developer running this
  // is asking "will CI pass on what I have", and answering with the contents
  // of their last commit is a different question confidently answered.
  const status = opts.run(["git", "status", "--porcelain", "-z"], opts.source);
  if (status.status !== 0) {
    return { ok: false, why: `could not read the working tree's status: ${status.stderr.trim()}`, hint };
  }
  const carried = status.stdout.split("\0").map(s => s.slice(3)).filter(Boolean);
  for (const rel of carried) opts.carryOver(rel, opts.source, dest);

  // Linked, not installed — see UNMODELLED. A `bun install` here would add a
  // minute and a network dependency to every run.
  const mods = `${opts.source}/node_modules`;
  if (opts.exists(mods)) opts.link(mods, `${dest}/node_modules`);

  const depthLabel = model.depth === null ? "full history" : `depth ${model.depth}`;
  opts.log(
    `CI checkout: ${depthLabel}, detached, ${result.refs.length} ref(s) after ` +
    `${model.fetches.length} replayed fetch(es)` +
    (carried.length ? `, ${carried.length} uncommitted path(s) carried over` : ""),
  );
  opts.log(`still NOT modelled: ${UNMODELLED.length} things — see UNMODELLED in lib/ci-checkout.ts`);

  return { ok: true, dir: dest, model, refs: result.refs, carried };
}
