/**
 * The git-config isolation set, declared ONCE as data (#1001).
 *
 * ## Why this file exists rather than a second copy of a string
 *
 * `git` executes code out of its own configuration. `core.fsmonitor` is a
 * command git runs, `core.hooksPath` points at hooks git fires, and
 * `core.excludesFile` can make a file invisible to the reading that is
 * supposed to see it. So **running `git` in a directory someone else chose
 * means running whatever that directory's `.git/config` says**, and
 * converting a shell string to an argv does nothing about it.
 *
 * That was measured once, under #960/#965, in a scratch repository with one
 * planted untracked file (git 2.50.1):
 *
 * | poisoned key | written where | unisolated | isolated |
 * |---|---|---|---|
 * | `core.excludesFile` → a file listing the plant | `~/.gitconfig` | **plant INVISIBLE** | `?? planted.txt` |
 * | `core.excludesFile` → a file listing the plant | the checkout's `.git/config` | **plant INVISIBLE** | `?? planted.txt` |
 * | `core.fsmonitor` → a script touching a marker | `~/.gitconfig` | **marker written — git ran it** | not run |
 * | `core.hooksPath` → a dir with `post-index-change` | `~/.gitconfig` | **hook fired** | not fired |
 *
 * **The lesson was learned once and propagated nowhere.** It lived as a
 * single shell-prefix string inside `lib/scaffold/ai-review-step.ts`, so
 * `hooks/CommitEnforcement.hook.ts` — which runs `git -C <a path out of an
 * agent's reply text>` — could not reuse it even in principle: its call sites
 * are `execFileSync('git', […])` and a shell prefix is not an argv.
 *
 * One declaration, two projections. `gitIsolatedShellPrefix()` reproduces the
 * existing string exactly, so `AI_REVIEW_GIT_ISOLATED` is now derived rather
 * than spelled; `gitIsolatedArgs`/`gitIsolatedEnv` serve the `execFileSync`
 * callers. A second declaration of either is refused by
 * `test/git-isolation.test.ts`.
 *
 * ## Why env vars AND `-c`, which is not belt-and-braces
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM` neutralise
 * whole FILES, so they cover keys nobody thought to enumerate — but they do
 * not touch the checkout's own `.git/config`, which is inside the tree being
 * read. The `-c` flags are the only thing covering row two of the table, and
 * command scope outranks local scope. **Neither covers the other.**
 *
 * ## `safe.directory='*'` is load-bearing, not a loosening
 *
 * `actions/checkout` writes `safe.directory` for the workspace into the
 * GLOBAL config on every job. Neutralise the global file and that exception
 * goes with it, so wherever the working tree is owned by a different uid than
 * the process — containers, rootless self-hosted pools — `git` exits 128 with
 * *"detected dubious ownership"*. `safe.directory` is honoured only from
 * protected scopes (system, global, command), so `-c` restores it from the
 * one source the subject cannot write, and the checkout's `.git/config` still
 * cannot set it. Without it, isolation would be stricter than what it
 * replaces in a way that fails closed on **green** repositories.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Config a caller passes deliberately.** These are defaults a caller
 *   prepends; anything added after them wins.
 * - **`git` subcommands that reach the network.** `fetch` with these env vars
 *   also discards a proxy, a CA bundle, or an `insteadOf` rewrite a
 *   self-hosted runner legitimately keeps in `~/.gitconfig`. That is a
 *   different trade-off and is why `buildRestoreScript` was left out of #960.
 * - **The repository's CONTENT.** Isolating config is not reviewing a tree.
 *
 * Issue: #1001. Refs #960, #965.
 */

/**
 * Env vars neutralising whole config FILES.
 *
 * `GIT_CONFIG_NOSYSTEM=1` is not redundant with `GIT_CONFIG_SYSTEM=/dev/null`
 * on every git version, so both are set.
 */
export const GIT_ISOLATION_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

/**
 * Keys overridden at COMMAND scope, which outranks the checkout's own
 * `.git/config` — the one scope the env vars above cannot reach.
 *
 * `core.fsmonitor` is set to the empty string rather than removed: an empty
 * value is how git spells "no fsmonitor", and there is no `-c` form that
 * unsets a key.
 */
export const GIT_ISOLATION_CONFIG: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["core.fsmonitor", ""],
  ["core.excludesFile", "/dev/null"],
  ["core.hooksPath", "/dev/null"],
  ["safe.directory", "*"],
] as const);

/**
 * The shell-prefix projection: `VAR=… VAR=… git -c k=v …`, ready to be
 * interpolated in front of a subcommand in a generated script.
 *
 * `safe.directory`'s value is single-quoted because `*` would otherwise be
 * glob-expanded by the shell. That quoting is a property of THIS projection
 * and must not leak into the argv one, where the value is passed literally —
 * a `'*'` reaching git through `execFileSync` would be three characters that
 * match no directory, i.e. isolation that silently does not apply.
 */
export function gitIsolatedShellPrefix(): string {
  const env = Object.entries(GIT_ISOLATION_ENV).map(([k, v]) => `${k}=${v}`).join(" ");
  const flags = GIT_ISOLATION_CONFIG.map(([k, v]) => `-c ${k}=${shellQuoteIfGlob(v)}`).join(" ");
  return `${env} git ${flags}`;
}

/** Single-quote a value a shell would otherwise expand. */
function shellQuoteIfGlob(v: string): string {
  return /[*?[\]]/.test(v) ? `'${v}'` : v;
}

/**
 * The argv projection: the `-c` flags, followed by whatever the caller
 * passes.
 *
 * Pre-command options only, so a caller's own `-C <dir>` may follow in any
 * order. Pair with `gitIsolatedEnv`; the flags alone leave `~/.gitconfig`
 * live, and the env alone leaves the checkout's `.git/config` live.
 */
export function gitIsolatedArgs(args: readonly string[] = []): string[] {
  const flags: string[] = [];
  for (const [k, v] of GIT_ISOLATION_CONFIG) flags.push("-c", `${k}=${v}`);
  return [...flags, ...args];
}

/**
 * `base` with the isolation vars applied on top.
 *
 * Takes the base environment as a parameter rather than reading
 * `process.env`, so a case can drive it without touching the machine's.
 */
export function gitIsolatedEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...GIT_ISOLATION_ENV };
}
