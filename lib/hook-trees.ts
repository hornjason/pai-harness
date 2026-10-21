/**
 * Two hook trees, and which one a registration names (#713).
 *
 * A LEAF module with no relative imports, so there is one thing to mutate.
 *
 * ## The state this exists to hold
 *
 * Hooks are wired from two trees — `${PAI_HOOKS_DIR}` (`~/.pai/hooks`, 55
 * files) and `${RUNGATE_HOOKS_DIR}` (`~/Projects/rungate/hooks`, 18). Eight
 * NAMES exist as files in both, and all eight have diverged: the `.pai`
 * copies are the old monolithic versions, rungate's are the refactored thin
 * triggers. Nothing in either tree says which copy wins; the answer lives
 * only in a settings file.
 *
 * That is how `OrphanProcessCleanup` survived (#712) — a `.pai` hook doing a
 * harness job, which nobody re-read because it looked like settled
 * infrastructure.
 *
 * ## What this module does NOT answer, which is most of the question
 *
 * **Whether a declared hook is registered at all is `reconcile`'s question**,
 * in `test/hook-registration-reconciler.test.ts` (#199, #479). That file
 * already splits the inventory by `scope`, enforces the project-scoped half
 * against the committed `.claude/settings.json`, and reports the user-scoped
 * half as UNMEASURED on every run. Answering it a second time here would be
 * two deciders for one question — they would agree on every input anyone has,
 * and a mutation of either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * So nothing below reports a hook as missing. `registrationTree` is handed
 * commands that already exist and answers a question `reconcile` does not
 * ask: **which tree does this command point into.**
 *
 * That blindness is the live gap #713 names. `registeredIn` matches
 * `/([A-Za-z][A-Za-z0-9]*)\.hook\.ts/`, so
 * `bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts` satisfies it exactly as well
 * as the rungate path does. A hook this repo owns could be re-pointed at the
 * superseded 554-line `.pai` copy and every check in the tree stays green.
 *
 * ## Read EVERY settings scope before concluding anything about one hook
 *
 * #713 reported `AgentBriefGuard` as "dead in both trees — wired nowhere".
 * It is not. It is registered in the PROJECT settings as
 * `bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts`, which resolves to
 * the rungate copy; the measurement read `~/.claude/settings.json` alone and
 * took zero hits as absence. That is the #646 trap — a negative result over a
 * store you did not write, with the error pointing toward believing nothing
 * happened — and the control nobody ran is "is this hook wired ANYWHERE?".
 *
 * `settingsCommands` therefore takes a LIST of documents. A caller that reads
 * one scope gets an answer about one scope and has to say so.
 *
 * ## Why the tree is decided by PATH VARIABLE and not by substring
 *
 * `${CLAUDE_PROJECT_DIR}/hooks/X.hook.ts` and `${PAI_HOOKS_DIR}/X.hook.ts`
 * both contain the hook's name, so deciding by name matches a commented-out
 * line, a `description` field and the other tree's registration equally. The
 * roots are the only thing that distinguishes them.
 */

/** The path variables each tree is spelled with, in any settings scope. */
const RUNGATE_ROOTS = ["${RUNGATE_HOOKS_DIR}", "${CLAUDE_PROJECT_DIR}/hooks"];
const PAI_ROOTS = ["${PAI_HOOKS_DIR}", "/.pai/hooks"];

export type HookTree = "rungate" | "pai";

/**
 * Which tree one command points into.
 *
 * `unknown` is a reading, not a default: a command naming neither root is
 * something nobody has classified, and reporting it as rungate would be the
 * silent substitution this repo keeps paying for.
 */
export function registrationTree(command: string): HookTree | "unknown" {
  if (RUNGATE_ROOTS.some(r => command.includes(r))) return "rungate";
  if (PAI_ROOTS.some(r => command.includes(r))) return "pai";
  return "unknown";
}

/**
 * Every `command` string anywhere under a settings document's `hooks` key.
 *
 * Walks rather than indexing a known shape: the schema nests
 * event → matcher-group → `hooks[]` and has gained a level before. A reader
 * that knew one shape would return nothing for the next one, and nothing is
 * indistinguishable from a tree with no `.pai` registrations in it.
 *
 * A document that does not parse THROWS. A corrupt settings file is not a
 * settings file with no hooks in it (`.claude/rules/config-access.md`).
 */
export function settingsCommands(docs: string[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.command === "string") out.push(rec.command);
    Object.values(rec).forEach(walk);
  };
  for (const doc of docs) {
    const parsed = JSON.parse(doc) as { hooks?: unknown };
    walk(parsed?.hooks ?? {});
  }
  return out;
}

/**
 * The hook file a command actually EXECUTES, as a basename.
 *
 * ## Three matchers, each narrower than the last, and why there was a third
 *
 * 1. `command.includes("X.hook.ts")` — satisfied by `other-X.hook.ts`, by
 *    `X.hook.ts.bak`, by the name in any path fragment.
 * 2. **token membership** — any `.hook.ts`-shaped token anywhere in the
 *    string. Narrower, and the same class: measured on the #976 branch, all
 *    four of these returned `true` for `IssueCloseGuard`:
 *
 *        bun run x.ts # IssueCloseGuard.hook.ts
 *        bun run x.ts ; echo IssueCloseGuard.hook.ts
 *        bun run x.ts && cat IssueCloseGuard.hook.ts
 *        SOME=1 bun run x.ts --note IssueCloseGuard.hook.ts
 *
 *    A hook counted as registered because its name appeared near a command
 *    that never runs it. Tokenising narrowed the hole; it did not remove it,
 *    and the diff implied otherwise.
 * 3. the **executed argument** — what this does now.
 *
 * Recorded as three steps deliberately. Three PRs in one day have replaced a
 * matcher that was wrong about its subject with one carrying the same
 * property a level down, and the way that keeps happening is a diff that
 * reads as though the class were closed.
 *
 * ## What this does
 *
 * Truncate at the first `#`, `;`, `&&`, `||` or `|`; drop leading `VAR=`
 * assignments, an `env` prefix, a known interpreter and a `run`/`exec`
 * subcommand; skip flags; basename the **first positional** and compare it
 * by equality.
 *
 * ## What it does NOT close, named rather than left to be inferred
 *
 * An argv parse has its own differentials and this closes some of them:
 *
 * - **`sh -c "bun X.hook.ts"`** — the real command is inside a quoted string
 *   and is not parsed. Reads as NOT naming the hook.
 * - **a wrapper script** that execs the hook. Reads as NOT naming it.
 * - **a `$VAR`-built path** whose variable holds the hook file name. The
 *   variable is not expanded here; `lib/hook-scopes.ts` compares the literal.
 * - **a hook executed in a LATER segment** — `make x && bun X.hook.ts`. The
 *   truncation stops at the first separator, so this reads as NOT naming it.
 *
 * **Every one of those errs toward reporting a registration that exists as
 * absent**, and that is the direction chosen rather than tolerated. For
 * `hookRegistration` a missed registration becomes `unregistered` or
 * `unmeasured`, which `AC-4`/`AC-4b` turn red — loud, and someone fixes the
 * spelling. The opposite error is a guard reporting clean about its own
 * subject, which is what #910 cost. Do not "fix" a false red here by
 * widening this; add the spelling to the parse.
 *
 * `wrongTreeViolations` below deliberately still uses a substring match. The
 * error directions are opposite there: an over-broad match reports a
 * violation that is not real, which costs an investigation and fails loud,
 * while a narrow parse could silently stop reporting a hook genuinely wired
 * to the superseded tree. Tracked as #981 rather than changed here, and that
 * issue carries the error-direction table — so the cheap generalisation
 * "reuse this parser everywhere" has a written reason not to.
 */
const INTERPRETERS = new Set([
  "bun", "bunx", "node", "npx", "npm", "pnpm", "yarn", "deno", "ts-node", "tsx",
]);
const SUBCOMMANDS = new Set(["run", "exec"]);
const SEPARATORS = new Set(["#", ";", "&&", "||", "|", "&"]);

export function executedHookFile(command: string): string | null {
  const tokens: string[] = [];
  for (const raw of command.split(/\s+/).filter(Boolean)) {
    // A separator ends the first command, whether it stands alone or is
    // glued to the token before it (`x.ts;`, `x.ts&&`).
    if (SEPARATORS.has(raw)) break;
    const cut = raw.search(/[#;|&]/);
    if (cut === 0) break;
    if (cut > 0) {
      tokens.push(raw.slice(0, cut));
      break;
    }
    tokens.push(raw);
  }

  let i = 0;
  // Leading `VAR=value` assignments, and an `env` prefix that introduces more.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === "env") {
    i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  }
  const bare = (t: string) => t.replace(/^['"]+|['"]+$/g, "");
  if (i < tokens.length && INTERPRETERS.has(bare(tokens[i]).split("/").pop() ?? "")) i++;
  if (i < tokens.length && SUBCOMMANDS.has(bare(tokens[i]))) i++;
  while (i < tokens.length && bare(tokens[i]).startsWith("-")) i++;
  if (i >= tokens.length) return null;

  const arg = bare(tokens[i]);
  const base = arg.slice(arg.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9_-]+\.hook\.ts$/.test(base) ? base : null;
}

/**
 * Does `command` EXECUTE `<hook>.hook.ts`?
 *
 * The single predicate every registration reading goes through, so there is
 * one binding to mutate and one place a narrowing or a widening lands.
 */
export function commandNamesHook(command: string, hook: string): boolean {
  return executedHookFile(command) === `${hook}.hook.ts`;
}

export interface TreeViolation {
  hook: string;
  tree: HookTree | "unknown";
  command: string;
  detail: string;
}

/**
 * Registrations of a hook this repo OWNS that do not name the rungate tree.
 *
 * Reports nothing for a hook with no registration — that is `reconcile`'s
 * finding, and duplicating it here would make this the second decider for a
 * question that already has one. The input this binding alone can see is a
 * registration that EXISTS and points at the superseded copy.
 */
export function wrongTreeViolations(owned: string[], commands: string[]): TreeViolation[] {
  const out: TreeViolation[] = [];
  for (const hook of owned) {
    for (const command of commands.filter(c => c.includes(`${hook}.hook.ts`))) {
      const tree = registrationTree(command);
      if (tree === "rungate") continue;
      out.push({
        hook,
        tree,
        command,
        detail:
          tree === "pai"
            ? `${hook} is owned by this repo and registered from the .pai tree, which holds the ` +
              `superseded copy: ${command}`
            : `${hook} is registered by a command naming neither tree's path variable, so which ` +
              `copy runs cannot be read from it: ${command}`,
      });
    }
  }
  return out;
}

export interface HookTreeCensus {
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Hook names present as files in BOTH trees. */
  duplicates: string[];
  pai: string[];
  rungate: string[];
}

const HOOK_FILE = /\.hook\.ts$/;

/**
 * Both trees, listed, with the duplicate names named.
 *
 * `listDir` is injected so a case can drive an unreadable directory without
 * touching the filesystem, and so this module stays a leaf with no `fs`
 * import.
 *
 * **A directory that cannot be read is UNMEASURED and NOT an empty list.**
 * Zero duplicates found between two directories nobody opened is the reading
 * SC-1 exists to refuse, and it is what CI sees: `~/.pai` is machine state
 * and does not exist on a runner.
 */
export function hookTreeCensus(
  paiDir: string,
  rungateDir: string,
  listDir: (dir: string) => string[] | null,
): HookTreeCensus {
  const reasons: string[] = [];
  const read = (dir: string, label: string): string[] => {
    const entries = listDir(dir);
    if (entries === null) {
      reasons.push(
        `the ${label} hook tree at ${dir} could not be read, so a duplicate between the two ` +
          `trees cannot be ruled out. This is not "no duplicates".`,
      );
      return [];
    }
    return entries.filter(n => HOOK_FILE.test(n)).map(n => n.replace(HOOK_FILE, "")).sort();
  };

  const pai = read(paiDir, "PAI");
  const rungate = read(rungateDir, "rungate");

  // ONE decider for "an unreadable tree contributes no duplicates": `read`
  // returns an empty list beside its reason, so the intersection below is
  // empty by construction. A `reasons.length === 0 ? … : []` guard here as
  // well would be a second decider for the same question — mutating it was
  // row M8 of the battery and measured **0 red**, because there is no input
  // on which the two versions differ. Per
  // `.claude/rules/checks-must-be-able-to-fail.md` that is a collapsed pair,
  // not a gap in the cases, so it was collapsed rather than banked.
  const duplicates = pai.filter(n => rungate.includes(n));

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    duplicates,
    pai,
    rungate,
  };
}
