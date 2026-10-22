/**
 * The decision behind `hooks/BashWriteGuard.hook.ts` (#473 on
 * `hornjason/pai-config`, tuned there in #474, reworked in #1120).
 *
 * Extracted from the hook so the population it refuses can be MEASURED
 * rather than argued about: 5,060 real commands from this machine's
 * transcripts were run through it, which is not something you can do with a
 * decision that only exists inside a subprocess. Same shape as
 * `lib/gate-result-protection.ts`, which #1137 extracted for the same reason.
 *
 * ## The thing this module exists to get right
 *
 * One mechanism was failing in BOTH directions at once.
 *
 * It UNDER-blocked, because a read-only prefix allowlist was consulted before
 * anything looked at what the command wrote, so `gh --version; echo x >
 * .gate-salt` exited clean. A prefix says nothing about what follows a `;`.
 *
 * It OVER-blocked, because the remaining checks matched protected names
 * anywhere in the command STRING, so a read-only `git show … | grep -nE
 * "chmod|chflags"` was refused for quoting the words it was searching for.
 * That happened four times in real work — twice to the session coordinating
 * this fix, twice to a peer staging a comparison copy — and a guard that
 * makes reading its own source awkward is a guard people route around.
 *
 * Both directions are the same root cause: a substring test over a whole
 * command line cannot tell CODE from DATA. So nothing here tests the whole
 * string. The command is split into segments at top-level separators, and
 * each check asks a structural question of a segment:
 *
 *   - what does this segment WRITE?          → redirects, tee, cp/mv
 *   - what does this segment MUTATE in place? → sed -i, dd of=, rm, …
 *   - is this segment OPAQUE?                 → an interpreter body, find -exec
 *   - is this segment's COMMAND WORD chmod?   → not "does it contain chmod"
 *
 * Quotes are handled two different ways on purpose, and the distinction is
 * the whole fix:
 *
 *   `stripQuoted`  deletes quoted spans INCLUDING their contents. Used to
 *                  find a VERB, because text inside quotes is an argument,
 *                  never the command the shell runs. This is what stops a
 *                  grep PATTERN from reading as a chmod invocation.
 *   `dequote`      removes quote characters and KEEPS the contents. Used to
 *                  find a TARGET, because `chmod 777 "x.hook.ts"` really does
 *                  name a hook file.
 *
 * Using `stripQuoted` for both would let an attacker quote the path; using
 * `dequote` for both reinstates all four false positives. Each test below
 * names which one it uses and why.
 *
 * ## The names are global; the artifacts are not (#1175)
 *
 * `PROTECTED_FILES` is a list of NAMES, and until #1175 a name matched in any
 * tree. A fixture at `/tmp/rg-abc/workflow-state.json` was refused as readily
 * as a live run's state, which is a true positive against the rule and a false
 * positive against intent — agents on this repo build such fixtures
 * constantly, including fixtures for this module.
 *
 * The scoping is by SCRATCH TREE rather than by project root, and that is a
 * measurement and not a preference. #1175's acceptance asked for "the path
 * relative to the project root". Swept over 5,531 real commands, the gate
 * artifacts named in them resolve like this:
 *
 *     2,620  under the run store (`$RUNGATE_WORK_DIR`, i.e. `~/.rungate`)
 *       521  under a former run store (`~/.pai-work`) or `~/.claude`
 *     1,724  no resolvable path at all — a bare basename, or built by `join`
 *        83  under an OS temp root
 *        65  relative
 *        16  under a repository tree
 *
 * A live `workflow-state.json` is almost never inside the project root: it is
 * in the run store, one level up and sideways. "Protect what is under the
 * root" would therefore have stopped protecting 3,141 of 3,240 absolute
 * references — reopening `pai-config#473` C1, the forge-a-gate-result attack
 * this guard was built for. The root-relative reading is recorded here as
 * MEASURED WRONG rather than merely not chosen.
 *
 * So the question asked is the fail-closed one: can this path be shown to be
 * in a scratch tree? Only then is it a fixture. Every other answer —
 * elsewhere, relative, or not a path at all — keeps the old refusal. An
 * allowlist is normally the wrong shape here and `pai-config#474`'s
 * read-only-prefix list is why: a PREFIX says nothing about what a command
 * writes. A scratch root says something about the DESTINATION, is consulted
 * only after the destination has been extracted, and is not a judgement call
 * — each entry is a value `mktemp -d` returns on a supported platform.
 * Narrowing it over-blocks; it cannot open a hole.
 */

import { realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';

/** Gate artifacts. A write to any of these must come from the gate runner. */
export const PROTECTED_FILES = ['workflow-state.json', '.gate-salt', '/witnesses/'];

/** Hook sources. Integrity matters because hooks are what enforce everything else. */
export const PROTECTED_HOOKS = ['.hook.ts', '.hook.sh'];

export interface BashWriteDecision {
  blocked: boolean;
  reason?: string;
}

const ALLOW: BashWriteDecision = { blocked: false };

/**
 * The trees an OS temporary directory can be in.
 *
 * `/tmp` and `/private/tmp` are both listed because on macOS they are the
 * same directory under two names and a command may spell either; `resolve()`
 * normalises `..` but does not follow links, and the link cannot be followed
 * here because the path being judged usually does not exist yet — it is about
 * to be created. `/var/folders` is where macOS puts a per-user `$TMPDIR`, and
 * `tmpdir()` covers whatever the platform or the environment says, which is
 * what `mkdtemp`, `mkstemp` and `mktemp -d` all build on.
 *
 * Each root is also recorded in its REALPATH form. On macOS `/var` is a
 * symlink to `/private/var`, so `tmpdir()` hands back `/var/folders/…/T`
 * while the resolution below hands back `/private/var/folders/…/T`, and a
 * list holding only the first form answers `false` for every path spelled
 * the way `mkdtemp` hands it to a program.
 *
 * The corpus does NOT show this, and saying so is the point: real commands
 * spell `/tmp` literally, so all 37 fixture commands clear either way. It
 * was found by `isScratchPath, asserted directly` calling `tmpdir()`, which
 * is what a program does and what a person does not. A sweep over what
 * people typed cannot see a defect in what their programs compute.
 *
 * Read at call time rather than frozen at import, because `TMPDIR` is what a
 * test harness moves when it wants its own scratch space, and a guard that
 * cached the old value would refuse the new one.
 *
 * ## `TMPDIR` is the writer's variable, so it is not trusted
 *
 * The first version of this took `process.env.TMPDIR` as given. Measured:
 *
 *     TMPDIR unset                  isScratchPath(…/.rungate/x/…) = false
 *     TMPDIR=$HOME/.rungate                                       = true
 *
 * The agent whose write is being judged sets the variable that decides
 * whether the write is exempt, and pointing it at the run store switches the
 * guard off for the one directory it exists to protect. `tmpdir()` is the
 * same hole wearing a function call — on POSIX it READS `TMPDIR`.
 *
 * So `FIXED` is the whole of the trust, and the environment can only ever
 * SELECT within it: a `TMPDIR` that does not already resolve inside a fixed
 * root is dropped. A platform whose temp directory is somewhere else
 * over-blocks, which is the direction this module is allowed to be wrong in.
 */
const FIXED_SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/folders'];

/**
 * Trees that hold LIVE artifacts, wherever on the disk they are.
 *
 * This is SUBTRACTED from the exemption in `isScratchPath`, not merely used
 * to vet the root list. The difference matters: vetting roots is a proxy for
 * the property, and it only holds for roots somebody thought of. Subtracting
 * the trees themselves IS the property — "a live artifact is never exempt" —
 * and it keeps holding when a root is added later by someone who has not
 * read this comment.
 *
 * The two mechanisms are also not interchangeable, and conflating them was
 * measured. Dropping a ROOT because it contains a protected tree removes
 * `/tmp` wholesale the moment `RUNGATE_WORK_DIR` points inside it — which a
 * real corpus command does — and refuses every fixture on the machine.
 * Subtracting the TREE removes only that subtree and leaves the rest of
 * `/tmp` exempt. So the root list is vetted only against trees that are not
 * themselves scratch, and the subtraction below applies unconditionally.
 *
 * ## The hook directories are here because a checkout CAN be the live hook
 *
 * A review argued that `PROTECTED_HOOKS` should lose the scratch exemption
 * entirely, on the grounds that a `.hook.ts` under `/tmp` is as likely to be
 * a real checkout as a fixture — worktrees under `/tmp` are routine here.
 * The counter-argument offered was that a hook source in a checkout is not
 * the live hook, so compromising one does nothing until it is deployed.
 *
 * That counter-argument is FALSE on this machine, and `lib/hook-target-tree.ts`
 * is where it was measured: every registration in `~/.claude/settings.json`
 * is spelled `${PAI_HOOKS_DIR}/…` or `${RUNGATE_HOOKS_DIR}/…`, and
 * `RUNGATE_HOOKS_DIR` resolved to *a checkout that is not this one*, with
 * fourteen hooks executing from it. #999's shell-injection fix never reached
 * the bytes that run. A checkout is the live hook exactly when a variable
 * says it is.
 *
 * So the answer is neither "refuse the exemption for hooks" nor "trust the
 * checkout": resolve where the registrations actually point and subtract
 * THAT, wherever it is — including when it is under `/tmp`. A hook in a
 * worktree nothing registers stays a fixture, which is the case #1175 exists
 * for; a hook in the tree that is actually wired stays protected, which is
 * the case the review was worried about.
 *
 * `process.cwd()` is deliberately NOT here, and the reason is measured. A
 * checkout under `/tmp` is ordinary on this machine — the worktree this was
 * written in is `/private/tmp/rg-1175-wt` — so treating the working
 * directory as protected drops `/private/tmp` from the roots, and because
 * `/tmp` realpaths to it the walk then refuses every `/tmp` path as well.
 * 12 of 145 tests red, measured.
 */
function protectedTrees(): string[] {
  const home = process.env.HOME || '';
  return [
    // The run store — where 2,620 of 3,240 absolute artifact references live.
    process.env.RUNGATE_WORK_DIR || '',
    home ? join(home, '.rungate') : '',
    home ? join(home, '.claude') : '',
    // The trees a hook registration resolves to. Read from the environment
    // because that is what the registrations are spelled with.
    process.env.PAI_HOOKS_DIR || '',
    process.env.RUNGATE_HOOKS_DIR || '',
    home ? join(home, '.pai', 'hooks') : '',
  ]
    .filter(Boolean)
    .map(p => resolve(p));
}

/** Is `p` inside, or equal to, any of `trees`? */
function inAnyTree(p: string, trees: string[]): boolean {
  return trees.some(t => p === t || p.startsWith(t + '/'));
}

function scratchRoots(): string[] {
  const out: string[] = [];
  const contains = (root: string, p: string) => p === root || p.startsWith(root + '/');

  const fixed: string[] = [];
  for (const r of FIXED_SCRATCH_ROOTS) {
    const n = resolve(r);
    fixed.push(n);
    try {
      fixed.push(realpathSync(n));
    } catch {
      // A root that is not on this disk is still a name a command can spell.
    }
  }

  // A protected tree that is ITSELF inside a fixed scratch root is not a
  // reason to drop that root. `RUNGATE_WORK_DIR=/tmp/e2e-gate-test` is a real
  // corpus command — a harness deliberately putting the run store in scratch
  // for a test — and without this clause it drops `/tmp` and refuses every
  // fixture on the machine, which is the same self-defeat `process.cwd()`
  // caused. Measured: `isScratchPath('/tmp/p/x')` goes false under that one
  // environment variable.
  const guarded = protectedTrees().filter(t => !fixed.some(f => contains(f, t)));
  const add = (p: string) => {
    if (p === '/' || out.includes(p)) return;
    // The invariant, enforced rather than documented: an exemption root that
    // contains a protected tree is not an exemption root.
    if (guarded.some(t => contains(p, t))) return;
    out.push(p);
  };

  for (const f of fixed) add(f);

  // The environment SELECTS within the fixed set; it cannot extend it.
  for (const r of [tmpdir(), process.env.TMPDIR ?? '']) {
    if (!r || !r.startsWith('/')) continue;
    const n = resolve(r);
    let real = n;
    try {
      real = realpathSync(n);
    } catch {
      /* not on this disk; judge the spelling */
    }
    if (!fixed.some(f => contains(f, n) || contains(f, real))) continue;
    add(n);
    add(real);
  }
  return out;
}

/**
 * Is this path demonstrably inside a scratch tree?
 *
 * Only an ABSOLUTE path can be placed in a tree, so everything else — a bare
 * basename, a relative path, a `join(dir, "workflow-state.json")` whose `dir`
 * lives in a variable — answers `false` and stays refused. That is the whole
 * fail-closed property: this function's job is to say YES, and silence means
 * the old behaviour.
 *
 * `resolve()` first, per #1129: a destination spelled `/tmp/../Users/me/
 * .rungate/x/workflow-state.json` is not in `/tmp`, and comparing the
 * unnormalised string would say it is.
 *
 * The deepest EXISTING ancestor is then realpath'd, which is the half
 * `resolve()` cannot do. Without it, `ln -s ~/.rungate/slug /tmp/esc` followed
 * by a write to `/tmp/esc/workflow-state.json` is a two-command bypass of the
 * thing this guard protects. The stat happens only after a protected NAME has
 * already matched, so the common command pays nothing for it.
 *
 * It does NOT close the case where the link is made by the SAME command —
 * see `exemptionIsVoid`, which is where that is handled, because the answer
 * is a property of the command and not of the path.
 *
 * An UNEXPANDED expansion is refused. `/tmp/$X/workflow-state.json` is not a
 * path, it is a path the shell will build, and `$X` may be `../../Users/me/
 * .rungate/slug`. Five of the six spellings a review raised were already
 * refused by `resolve()` and the `startsWith('/')` precondition — `${X}`, the
 * backtick form, `/tmp/../…`, `$HOME/…` and `~/…` — and this is the sixth.
 * Measured cost of refusing it: 0 of the 37 commands this branch clears, with
 * 209 corpus-wide carrying a `$` in an artifact path, none of them in the
 * population at stake.
 *
 * Both exits below return `false`. They are all but unreachable — the
 * deepest artifact path in the corpus is 6 components against a cap of 64,
 * and the walk only runs out of parents if `realpathSync('/')` throws — but
 * an unreachable fail-OPEN in a fail-closed module is a line that reads as
 * permission, and the next person to make the walk reachable inherits it.
 */

/**
 * Glob and brace metacharacters, tested against the DIRECTORY part only.
 *
 * `echo '{}' > /tmp/sym*​/workflow-state.json`, with `/tmp/syma` a symlink
 * into the run store: `/tmp/sym*` does not exist, the walk climbs past it to
 * `/tmp`, and the path is exempted — then the shell expands the glob and the
 * write goes through the link. Same escape as the symlink case with no `ln`
 * in the command for `exemptionIsVoid` to see.
 *
 * Only the directory part is tested, and that is measured rather than
 * cautious. A glob in the BASENAME is already safe, because the directory
 * above it is the thing `resolveThroughLinks` resolves — built and executed:
 * with `SRC/syma` linked out of scratch, `SRC/syma/*.json` answers false and
 * `SRC/sym*​/x` answered true. So the basename case needs no refusal, and
 * refusing it anyway costs a real command: `rm -f /tmp/713-battery/
 * pai-wrongfix/*.hook.ts` is 1 of the 37 this branch clears, and a blanket
 * metacharacter class takes it back. Restricting the test to the directory
 * part closes the escape at a measured cost of 0.
 *
 * The exact class a review proposed, `[$`*?[]{}~]` tested against the whole
 * path, was swept over the same 5,573-command corpus: it takes back 1 of the
 * 37, that `rm -f`. It does not ship on caution either way — it ships on the
 * reading, and the reading is 1 against 0.
 */
const UNRESOLVED_DIR = /[*?[\]{}]/;
export function isScratchPath(path: string): boolean {
  if (!path || !path.startsWith('/')) return false;
  if (/[$`]/.test(path)) return false;
  // A glob in a DIRECTORY component is unresolvable and escapes; one in the
  // basename does not. See `UNRESOLVED_DIR` for the measurement.
  if (UNRESOLVED_DIR.test(dirname(path))) return false;

  const normalised = resolve(path);
  const real = resolveThroughLinks(normalised);
  if (real === null) return false;

  // The subtraction, applied to BOTH the spelling and the resolved path. A
  // live artifact is never exempt, whichever of the two names it.
  const live = protectedTrees();
  if (inAnyTree(normalised, live) || inAnyTree(real, live)) return false;

  const roots = scratchRoots();
  return inAnyTree(normalised, roots) && inAnyTree(real, roots);
}

/**
 * The path with its deepest EXISTING ancestor resolved through symlinks, and
 * the not-yet-created tail re-attached. `null` when nothing in the chain can
 * be resolved — which is the fail-closed answer, not a missing one.
 */
function resolveThroughLinks(normalised: string): string | null {
  let dir = normalised;
  let suffix = '';
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(dir);
      return suffix ? resolve(real, suffix) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      suffix = suffix ? join(basename(dir), suffix) : basename(dir);
      dir = parent;
    }
  }
  return null;
}

/**
 * Does this command do something that makes a resolved path untrustworthy?
 *
 * `isScratchPath` resolves the destination's existing ancestors at DECISION
 * time. A command that creates a symbolic link before it writes invalidates
 * that resolution between the decision and the execution, and the whole
 * thing fits in one command:
 *
 *     ln -s ~/.rungate/victim /tmp/esc && echo '{}' > /tmp/esc/workflow-state.json
 *
 * At decision time `/tmp/esc` does not exist, the walk reaches `/tmp`, and
 * the write is exempted. Then the shell creates the link and the write lands
 * in the run store. Both halves were executed: the module allowed the
 * command, and a real shell put the bytes through the link. This is a
 * bypass, not a race — no second actor is required.
 *
 * `mkdir -p` is the overwhelmingly common thing a fixture does to a path that
 * does not exist yet, and a directory cannot point out of its tree. Only a
 * LINK can, so only link creation voids the exemption. Measured: 0 of the 37
 * commands this branch clears create one, and 9 commands in the whole 5,550
 * corpus match at all.
 *
 * ## The verb is resolved, not pattern-matched
 *
 * The first version tested `/(?:^|[\s;&|(])ln\s/` against the raw command,
 * which requires whitespace or a separator immediately before `ln`. Measured:
 * `ln -s`, `sudo ln` and `find -exec ln` voided, but **`/bin/ln -s … /tmp/x`
 * and `\ln -s … /tmp/x` did not** — two spellings the shell resolves
 * identically to the one that did, walking past the control the whole
 * exemption rests on.
 *
 * `commandWord` already strips a leading path and a leading `\` or `(`, and
 * already skips `sudo`, `env`, `xargs` and the other wrappers, because
 * #1120 and #1184 taught it to. Running it per segment is one tokeniser
 * instead of two and gets all of that for free, so the segment's resolved
 * VERB is the primary test.
 *
 * `LINK_CREATION` stays as a second, broader net for the positions a command
 * word cannot reach: `find . -exec ln …` resolves to `find`, and
 * `symlinkSync` lives inside an interpreter body this module does not parse.
 * It is read off the raw command for that reason — the link and the write
 * are in different segments by construction.
 *
 * `mkdir -p` is the overwhelmingly common thing a fixture does to a path that
 * does not exist yet, and a directory cannot point out of its tree. Only a
 * LINK can, so only link creation voids the exemption. Measured: 0 of the 37
 * commands this branch clears create one.
 */
const LINK_CREATION = /\bln\s|\bsymlinkSync\b|\bos\.symlink\b|\bsymlink\s*\(/;

function exemptionIsVoid(cmd: string): boolean {
  if (LINK_CREATION.test(stripHeredocs(cmd))) return true;
  return segments(cmd).some(seg => commandWord(seg) === 'ln');
}

/**
 * Path-like words in `text` that contain `needle`.
 *
 * A word here ends at whitespace or at a character that cannot be inside a
 * shell or source-literal path — a quote, a comma, a bracket, a semicolon.
 * That is deliberately crude and deliberately in the refusing direction: when
 * a path is assembled rather than written out, the word this returns is the
 * fragment that WAS written, which is relative, which `isScratchPath` refuses
 * to exempt.
 *
 * Case-folded for the same reason `names()` is (#1184): the default macOS
 * filesystem resolves `WORKFLOW-STATE.JSON` and `workflow-state.json` to one
 * inode, so a case-sensitive search here would find no path word for the
 * uppercase spelling, and a name with no path words is not exempted — it
 * would refuse rather than leak. Folding keeps the two readings agreeing
 * instead of agreeing by accident.
 */
function pathWordsContaining(text: string, needle: string): string[] {
  const out: string[] = [];
  const hay = text.toLowerCase();
  const pin = needle.toLowerCase();
  let i = 0;
  while ((i = hay.indexOf(pin, i)) !== -1) {
    let s = i;
    while (s > 0 && !/[\s'"`,;(){}[\]]/.test(hay[s - 1])) s--;
    let e = i + pin.length;
    while (e < hay.length && !/[\s'"`,;(){}[\]]/.test(hay[e])) e++;
    out.push(text.slice(s, e)); // the ORIGINAL case: this is a path to resolve
    i = e;
  }
  return out;
}

/**
 * Split a command at top-level `;`, `&&`, `||`, `|` and newline, leaving
 * separators inside quotes alone.
 *
 * Deliberately NOT a shell parser. It does not expand anything, does not
 * track `$(…)` nesting and does not care about redirection grammar. It
 * answers one question — where might a new command begin — and the failure
 * mode of getting that slightly wrong is MORE segments, each of which is
 * then inspected. Over-splitting costs precision in the allow direction and
 * never opens a hole, which is the direction a guard should err in.
 */
export function segments(cmd: string): string[] {
  // Heredoc bodies go FIRST, before anything looks for a separator. A
  // heredoc is not a quote, so a `|` or `;` inside an issue body, a commit
  // message or a PR description used to tear the document into fragments
  // and each fragment was then read as a command — which is how a sentence
  // about `workflow-state.json` came to be refused as a write to it.
  cmd = stripHeredocs(cmd);
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      // #1203: inside SINGLE quotes nothing is escaped, not even a backslash,
      // so the first `'` always closes. Treating `\'` as an escape there kept
      // the span open past its real end, and everything after it — the
      // separator AND the write verb — was swallowed into one segment where
      // `commandWord` could never reach the verb. Inside DOUBLE quotes `\"`
      // IS an escape, which is why the two cases are told apart rather than
      // handled by one rule.
      if (c === quote && (quote === "'" || cmd[i - 1] !== '\\')) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // #1203: a backslash-newline is a LINE CONTINUATION. The shell joins the
    // two lines into one command before it looks for anything else, so
    // splitting on that newline put the verb in one segment and its target in
    // the next, and `cp x \<nl> /r/workflow-state.json` reached the `cp` arm
    // with a single operand. Same class as #1176 and #1184 — a check reading a
    // transformed view whose transformation relocated the token — except this
    // one relocates it across a SEGMENT boundary rather than into a quote.
    //
    // Joining with NOTHING, not with a space, because that is what the shell
    // does: `ch\<nl>mod 777 x.hook.ts` runs chmod, so `commandWord` has to
    // resolve `chmod` too. Inserting a space would read the verb as `ch`.
    //
    // Only outside a quote. Inside single quotes the backslash is literal and
    // the newline is data, which is the negative control this must not break.
    if (c === '\\') {
      if (cmd[i + 1] === '\n') {
        i++;
        continue;
      }
      // An ESCAPED backslash. Consume the pair, so `\\` at end of line leaves
      // no dangling `\` to swallow the newline that genuinely separates.
      cur += c;
      if (i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cmd[i + 1] === c) i++; // `&&`, `||` are one separator, not two
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * Delete heredoc bodies, then quoted spans and their contents. Use when
 * looking for a VERB.
 *
 * A heredoc body is the single largest source of over-blocking measured on
 * this machine's history: an issue body, a commit message or a PR
 * description written with `cat > f <<'EOF'` routinely QUOTES a protected
 * filename, a `>` redirect or the word `chflags`, because the thing being
 * written about is this guard. 1,860 real commands were newly refused before
 * this stripping existed and the large majority were that shape.
 */
export function stripQuoted(s: string): string {
  return stripHeredocs(s).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ');
}

/**
 * Delete heredoc bodies only, keeping ordinary quoting intact. Separate from
 * `stripQuoted` because a quoted PATH is a real argument while a heredoc
 * body never is — it is the document being written, not a word of the
 * command writing it.
 */
export function stripHeredocs(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A whole-line `#` comment is prose, and its APOSTROPHE is not a quote.
    // #1176: `# First, check if there's a test workflow-state.json` opened a
    // quote that stayed open across the newline and swallowed the redirect on
    // a later line, so a real write to a protected file read as quoted text.
    // Two commands in a 5,513-command corpus did exactly this, both of them
    // genuine writes. Dropped here rather than in each caller because every
    // arm reaches this function first.
    const isComment = /^\s*#/.test(line);
    out.push(isComment ? '' : line); // #1176: the OPERATOR's line is kept — see below.
    i++;
    if (isComment) continue; // a comment cannot open a heredoc
    const delim = heredocDelimiter(line);
    if (!delim) continue;
    // #1184: buffer the body rather than consuming to end-of-input. A
    // heredoc whose terminator never arrives is not a heredoc this module can
    // trust, and dropping the rest of the command is a BYPASS — `cat <<EOF`
    // followed by a write on the next line used to read as a bare `cat`. The
    // regex this scanner replaced required the terminator to match, so it
    // failed closed; the first version of the scanner failed open. Keeping
    // the bytes is the direction a guard is allowed to be wrong in.
    const body: string[] = [];
    let j = i;
    while (j < lines.length && lines[j].trim() !== delim) {
      body.push(lines[j]);
      j++;
    }
    if (j < lines.length) {
      i = j + 1; // terminated: the body and the terminator are the document
    } else {
      out.push(...body); // never terminated: emit unchanged
      i = j;
    }
  }
  return out.join('\n');
}

/**
 * Which character positions on this line are OUTSIDE every quoted span.
 *
 * A `$(` opens a COMMAND SUBSTITUTION, and the shell parses its contents as a
 * fresh command with fresh quoting — so text inside `"$( … )"` is unquoted
 * even though it sits between double quotes. That one rule is the whole
 * difference between the two cases in #1196's H6, and it is why this is a
 * small stack rather than a boolean. Single quotes do not substitute, so a
 * `$(` inside them is literal and opens nothing.
 *
 * Deliberately per-line, matching its only caller: a quote opened on an
 * earlier line reads as unquoted here. That is the behaviour this function
 * replaced — which was not quote-aware at all — so no case gets worse, and
 * the direction it is wrong in deletes text rather than admitting it.
 */
function unquotedPositions(line: string): boolean[] {
  const open = new Array<boolean>(line.length).fill(false);
  const stack: string[] = ['']; // quote state per substitution depth
  let i = 0;
  while (i < line.length) {
    const q = stack[stack.length - 1];
    const c = line[i];
    if (q === "'") {
      if (c === "'") stack[stack.length - 1] = '';
      i++;
    } else if (q === '"') {
      if (c === '\\') i += 2;
      else if (c === '$' && line[i + 1] === '(') (stack.push(''), (i += 2));
      else if (c === '"') (stack[stack.length - 1] = ''), i++;
      else i++;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '$' && line[i + 1] === '(') {
      open[i] = open[i + 1] = true;
      stack.push('');
      i += 2;
    } else if (c === ')' && stack.length > 1) {
      stack.pop();
      i++;
    } else if (c === '"' || c === "'") {
      stack[stack.length - 1] = c;
      i++;
    } else {
      open[i] = true;
      i++;
    }
  }
  return open;
}

/**
 * The delimiter word of a `<<WORD` on this line, if any — at a position the
 * shell would read as an operator rather than as text.
 *
 * #1176 left this NOT quote-aware on purpose, because the obvious hardening
 * ("must be top-level") REDDENS the recorded `pai-config#474` false positive,
 * whose heredoc is legitimately nested inside `"$(cat <<'EOF' … )"`. That
 * reasoning was right about the fix it tried and wrong about the conclusion:
 * the distinction is not depth, it is whether a command substitution has
 * reset the quoting. #1196 pays for the small stack that tells them apart.
 *
 * What it buys: `bun -e 'x = "<<EOF"'` opened a heredoc, so every following
 * line up to a bare `EOF` was deleted as a document — a quoted STRING chose
 * what the guard could see. H5 was this same body-drop reached through the
 * wrong character position (`<<<`); this is the wrong quoting position.
 */
function heredocDelimiter(line: string): string | null {
  // #1184: `(?<!<)` and `(?!<)` exclude a `<<<` HERESTRING, which has no
  // terminator at all. Matching one invented a delimiter from the quoted text
  // after it and then ran straight into the unterminated case above.
  const re = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  const open = unquotedPositions(line);
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (open[m.index]) return m[2];
  }
  return null;
}

/** Remove quote characters, keep the contents. Use when looking for a TARGET. */
export function dequote(s: string): string {
  return s.replace(/['"]/g, '');
}

/** Wrappers that delegate to the real command word rather than being one. */
const WRAPPERS = /^(?:sudo|env|nohup|time|command|xargs)$/;

/**
 * A variable assignment prefix, by the POSIX shape: an identifier, an
 * optional array subscript, then `=`. Read on the raw token — see
 * `commandWord`, where recognising it only after the path strip was a bypass.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?=/;

/**
 * The command word of a segment — the first token that is not a wrapper, an
 * assignment or an option. Read off `stripQuoted`, because a quoted token is
 * an argument.
 */
export function commandWord(segment: string): string {
  // #1184: read the DEQUOTED token stream, not the quote-stripped one. This
  // is the mirror of #1176's F2 — there the TARGET was read off a view the
  // writer controls, here the VERB was: `stripQuoted` deleted `"chmod"`
  // outright, so `"chmod" 777 x.hook.ts` resolved its command word to `777`
  // and the shell ran chmod anyway. Quoting a verb changes nothing about
  // what executes, so it must change nothing about what the guard reads.
  //
  // The grep-PATTERN false positive this function was protecting against is
  // unaffected: `grep -nE "chmod" f` still resolves to `grep`, because the
  // real verb comes FIRST and a pattern is never in first position.
  //
  // #1196: the TOKENS come from `scanSegment`, the same quote-aware pass the
  // redirect scan uses. The #1184 spelling was `dequote(...).split(/\s+/)`,
  // which removes the quote characters and THEN splits on whitespace — so a
  // quoted value's internal spaces become token boundaries. `A="1 grep" cp
  // <protected> /tmp/x` split to `A=1`, `grep`, `cp`, …: the `=` skip
  // consumed only `A=1` and the verb resolved to `grep`, which is on the
  // read-only side, so the `cp` was allowed. A quoted span must stay inside
  // its word; `readWord` already does that, and now there is one tokeniser
  // rather than two spellings of the idea.
  for (const raw of scanSegment(segment).words) {
    // A token carrying WHITESPACE is not a verb. It is what the quote-aware
    // tokeniser above is for — `A="1 grep"` is one word — and the same
    // property makes `--body "## Goal … chflags uchg …"` one word too. The
    // first spelling of this fix returned that whole document as the command
    // word, and `decideBashWrite` tests `IN_PLACE` against `${word} ${code}`:
    // a `gh issue create` whose body described chflags on a hook was refused,
    // which is the recorded `pai-config#474` family. The shell cannot run a
    // verb named `chmod 777` either, so nothing executable is lost.
    if (/\s/.test(raw)) continue;
    // An assignment prefix is recognised on the RAW token, before the path
    // strip. #1196: the strip runs `^.*\/` and takes the `=` away with the
    // directory part, so `FOO=/x/grep` arrived at the `includes('=')` test
    // spelled `grep` and was returned as the command word — a fake verb in
    // front of the real one. `FOO=/x/grep chmod 777 <hook>` was ALLOW on
    // main and ALLOW behind the first #1196 fix; `chmod 777 <hook>` BLOCKs.
    // Four arms were reachable this way. Same defect this issue names, a
    // different assignment shape: the prefix hides the verb either way.
    //
    // Matched by the POSIX shape rather than by `includes('=')` so a real
    // path is not mistaken for one — `/opt/a=b/bin/tool` does not start
    // with an identifier, and the test below still catches the rest.
    if (ASSIGNMENT.test(raw)) continue;
    const tok = raw
      .replace(/^[({\\]+/, '') // `(cmd …`, `{ cmd …`, `\cmd` — alias bypass
      .replace(/^.*\//, ''); // `/usr/bin/python3` -> `python3`
    if (!tok || tok.includes('=') || tok.startsWith('-')) continue;
    if (WRAPPERS.test(tok)) continue;
    return tok;
  }
  return '';
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 *
 * Redirections are read off the heredoc-stripped text, because a `>` inside
 * a heredoc body is prose about a redirect, not one. The TARGET itself is
 * then dequoted, because `> "x/.gate-salt"` writes the same file as `>
 * x/.gate-salt`.
 */
/**
 * Read one word starting at `i`, honouring quotes. Returns the word's
 * CONTENTS — quote characters removed, contents kept — and the index after
 * it, so `dir/"workflow-state.json"` reads as one word and not as two halves
 * either side of a span that was deleted.
 */
function readWord(s: string, i: number): [string, number] {
  let w = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '>' || c === '<') break; // an operator ends a word
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1);
      const end = close === -1 ? s.length : close;
      w += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    // #1205: a command substitution is part of the word it sits in, however
    // much whitespace is inside it. Ending the word at the first space split
    // `> /tmp/`id -un`/workflow-state.json` into the target `/tmp/`id` — which
    // names no protected artifact, so arm 1 never fired at all and a write to
    // a live run-store path was allowed. The space-free spelling was caught,
    // which is why this survived: the bug is the SPACE, not the substitution.
    //
    // The text is kept verbatim rather than expanded. This module does not
    // expand anything, and keeping the `$`/backtick is what lets #1175's
    // `isScratchPath` go on reading an unexpanded path as unprovable.
    if (c === '`') {
      const close = s.indexOf('`', i + 1);
      // Unterminated: consume to the end. A substitution this module cannot
      // see the end of is not one it can read a word boundary out of, so it
      // takes the rest — the fail-closed direction.
      const end = close === -1 ? s.length : close + 1;
      w += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        // A parenthesis inside a STRING LITERAL is data, not grammar.
        // Counting it dropped the depth to zero early, ended the word in the
        // middle of the substitution, and left a `"` whose partner had
        // already been consumed — so the quote branch above then took
        // `close === -1` and swallowed the rest of the line INCLUDING the
        // `>` operator. No operator, no target, allow:
        //
        //     echo $(echo "x)") > <protected>     ran, and wrote
        //
        // This is #1205's own sentence a second time — the bug is what the
        // scanner cannot see, not the substitution — so it is fixed the same
        // way rather than by special-casing the literal that exposed it.
        const q = s[j];
        if (q === "'" || q === '"') {
          const close = s.indexOf(q, j + 1);
          j = close === -1 ? s.length : close; // the loop's j++ steps past it
          continue;
        }
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) {
          j++;
          break;
        }
      }
      w += s.slice(i, j); // unterminated falls out here with j === s.length
      i = j;
      continue;
    }
    w += c;
    i++;
  }
  return [w, i];
}

/**
 * Is this redirect operand a PATH being written, or plumbing?
 *
 * `2>&1` and `>&2` name a descriptor, not a file. Keeping that distinction is
 * what lets `2>` count as a write at all (#1176): without it, dropping `2`
 * from the old lookbehind would have turned every `2>&1` in the corpus into
 * a write to a file called `&1`.
 */
function isWriteOperand(op: string): boolean {
  if (!op) return false;
  if (/^&?\d+$/.test(op) || op === '-') return false;
  return op !== '/dev/null' && op !== '/dev/stderr' && op !== '/dev/stdout';
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 *
 * #1176 replaced three substring matches with one left-to-right scan. The
 * substring version read redirects off `stripQuoted`, which deletes quoted
 * spans AND their contents, then tried to recover a wholly-quoted target in a
 * second pass — so a target quoted in the MIDDLE of the word (`> dir/"x"`)
 * was seen by neither pass. Scanning finds the operator at a position and
 * then reads the operand as a word, which is the same rule the shell uses.
 */
/**
 * One left-to-right pass over a segment, returning its WORDS and its
 * redirect TARGETS.
 *
 * #1196 made this the single tokeniser. `commandWord` previously did its own
 * `dequote(...).split(/\s+/)`, which is not tokenisation: it let a quoted
 * multi-word assignment VALUE break into separate tokens, so
 * `A="1 grep" cp …` dropped only `A=1` on the `includes('=')` skip and
 * resolved the verb to `grep`. Here a quoted span stays INSIDE its word, so
 * the same input yields the single token `A=1 grep`, which is skipped whole.
 */
function scanSegment(segment: string): { words: string[]; targets: string[] } {
  const targets: string[] = [];
  const words: string[] = [];
  const s = stripHeredocs(segment);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '>') {
      i++;
      if (s[i] === '>') i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      // `>&1` — the `&` belongs to the operand, so readWord keeps it and
      // isWriteOperand rejects it.
      const [operand, next] = readWord(s, i);
      i = next;
      if (isWriteOperand(operand)) targets.push(operand);
      continue;
    }
    if (c === '<') {
      // An input redirect reads; skip it and its operand so the operand is
      // never mistaken for a command word.
      i++;
      if (s[i] === '<') i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      i = readWord(s, i)[1];
      continue;
    }
    const [w, next] = readWord(s, i);
    i = next === i ? i + 1 : next;
    // #1196 R3: an IO NUMBER is not a word. POSIX: an unquoted digit string
    // immediately preceding `<` or `>` names a file descriptor, so the `2`
    // in `2>/dev/null` belongs to the redirect. Emitting it as a word put it
    // in LAST position among a `cp`'s arguments, which is where this module
    // looks for the destination — so `cp /tmp/x.json /r/<protected>
    // 2>/dev/null` read its destination as `2` and the real one was demoted
    // to a source. Measured on the corpus: four genuine writes to a gate
    // artifact or a hook, allowed by #1188, and found only because a
    // classifier written for a different question made the same mistake.
    if (w && /^\d+$/.test(w) && (s[i] === '>' || s[i] === '<')) continue;
    if (w) words.push(w);
  }
  return { words, targets };
}

/**
 * Paths a segment writes through shell redirection or a copying verb.
 */
export function writeTargets(segment: string, whole: string = segment): string[] {
  const { words, targets } = scanSegment(segment);

  // `tee` takes MANY files. Reading only the first operand let
  // `tee /tmp/a <protected>` through (#1176).
  const teeAt = words.findIndex(w => w.replace(/^.*\//, '') === 'tee');
  if (teeAt !== -1) {
    for (const w of words.slice(teeAt + 1)) if (!w.startsWith('-')) targets.push(w);
  }

  // `cp`/`mv` take the LAST non-option argument as the destination. Reading
  // the second token instead — which this did until #1120 — mis-parses every
  // invocation carrying a flag: `cp -p src /x/workflow-state.json` read the
  // destination as `src` and never examined the real one.
  const word = commandWord(segment);
  if (word === 'cp' || word === 'mv' || word === 'install' || word === 'rsync') {
    const args = words.slice(1).filter(a => !a.startsWith('-'));
    if (args.length >= 2) {
      const dest = args[args.length - 1];
      targets.push(dest);
      // When the destination is a DIRECTORY the real sink is
      // `dest/basename(src)`, for every source (#1184).
      if (isDirDestination(dest, args, whole)) {
        for (const src of args.slice(0, -1)) {
          targets.push(`${dest.replace(/\/+$/, '')}/${src.replace(/^.*\//, '')}`);
        }
      }
    }
  }
  return targets;
}

/**
 * Does this destination name a DIRECTORY? Four oracles, three of them
 * syntactic, in the order they settle the question cheaply.
 *
 * #1184 asked only the fourth, `statSync`, and that is #1196's R2: a
 * PreToolUse hook decides before ANY of the command has run, so in
 * `mkdir -p d && cp <protected> d` the directory never exists at decision
 * time. Measured both ways on the same command — directory absent ALLOW,
 * directory present BLOCK. A guard whose answer depends on a directory the
 * same command is about to create is not a guard.
 *
 * The reviewer's simpler repair was to delete the test and push
 * `dest/basename(src)` unconditionally. Measured on 5,543 corpus commands
 * naming a protected artifact, that refuses 19 real commands and catches no
 * real write that the oracles below miss — every one of the 19 is a
 * protected file copied OUT to a plain destination, and 11 of those are the
 * `cp hooks/X.hook.ts /tmp/x.bak` backup that
 * `.claude/rules/checks-must-be-able-to-fail.md` requires before a mutation
 * battery. A guard that refuses the repository's own mandated practice gets
 * switched off. So the test stays and gains the readings it was missing.
 */
// #1175 moved `statSync` to the import block at the top, which `isScratchPath`
// also reads from. Two `from 'fs'` statements in one module is legal and is
// still one import of one module; one of them is what a reader greps for.
function isDirDestination(dest: string, args: string[], whole: string): boolean {
  if (dest.endsWith('/')) return true; // `cp x d/` — the shell requires a dir
  if (args.length > 2) return true; // `cp a b c d` — d MUST be a directory
  if (createdAsDirectory(dest, whole)) return true; // `mkdir -p d && cp x d`
  try {
    return statSync(dest).isDirectory();
  } catch {
    return false; // unreadable reads as a plain file; that is the last-arg case
  }
}

/** Does some earlier segment of this same command `mkdir` the destination? */
function createdAsDirectory(dest: string, whole: string): boolean {
  const want = dest.replace(/\/+$/, '');
  for (const seg of segments(whole)) {
    if (commandWord(seg) !== 'mkdir') continue;
    for (const a of scanSegment(seg).words.slice(1)) {
      if (!a.startsWith('-') && a.replace(/\/+$/, '') === want) return true;
    }
  }
  return false;
}

// `statSync` used to be declared here, beside its only reader. #1175 gave it
// a second reader in `isScratchPath` at the top of the module, so the import
// moved to the import block rather than being written twice.

/**
 * Non-option arguments of a segment, dequoted. This is what an in-place verb
 * actually operates on — as opposed to its script, which is an argument too
 * but names files only as text.
 */
export function argumentsOf(segment: string): string[] {
  const out: string[] = [];
  // Tokens that survive heredoc and quote stripping are bare words; quoted
  // tokens are recovered individually so a quoted PATH still counts while a
  // quoted sed SCRIPT does not reach the protected-name test as a path.
  for (const t of stripQuoted(segment).trim().split(/\s+/)) {
    if (t && !t.startsWith('-')) out.push(t);
  }
  // Heredoc bodies are stripped FIRST: a quoted path inside the document
  // being written is not an argument to the command writing it.
  for (const m of stripHeredocs(segment).matchAll(/(['"])([^'"\s]*[/.][^'"\s]*)\1/g)) out.push(m[2]);
  return out;
}

/**
 * Does a protected name sit NEAR a declared write verb in an interpreter
 * body? Proximity, not parsing — the arm needs to tell
 * `open('…/.gate-salt','w')` from a program that writes a `.md` and happens
 * to mention a hook in its data. Associating a call with its argument
 * properly means parsing the language, which this module will not do.
 */
function writesNear(body: string, protectedName: string): boolean {
  const WINDOW = 80;
  for (const m of body.matchAll(new RegExp(protectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    const from = Math.max(0, (m.index ?? 0) - WINDOW);
    const slice = body.slice(from, (m.index ?? 0) + protectedName.length + WINDOW);
    if (WRITE_INTENT.test(slice)) return true;
  }
  return false;
}

/**
 * Verbs that modify a named file in place, with no redirect for
 * `writeTargets` to see. `sed -i` is the ordinary way to edit a file from a
 * shell, so its absence was a plain hole rather than an exotic one.
 */
const IN_PLACE = [
  /\bsed\b[^\n]*\s-i\b/,
  /\bperl\b[^\n]*\s-[a-z]*i\b/,
  /\bdd\b[^\n]*\bof=/,
  /\btruncate\b/,
  /\brm\b/,
  /\bln\b/,
  /\bgit\s+(?:checkout|restore)\b/,
  // #1146: extended attributes are file metadata, and `com.apple.provenance`
  // is what was blocking writes to the hooks on this machine — so removing it
  // is a mutation of hook integrity by any reading.
  //
  // The mutating forms are read off `xattr --help`, not guessed:
  //
  //   xattr [-lrsvx] file …             list      READ
  //   xattr -p [-lrsvx] attr file …     print     READ
  //   xattr -w [-rsx] attr value file   set       MUTATES
  //   xattr -d [-rsv] attr file …       delete    MUTATES
  //   xattr -c [-rsv] file …            clear ALL MUTATES
  //
  // So the letters are `c`, `d`, `w` — and they may sit ANYWHERE in a flag
  // cluster, which is why this does not read a single letter. The first
  // revision of this PR shipped `-[dws]`, wrong in both directions against
  // that table: it missed `-c`, which deletes every attribute on the file,
  // and it refused `-s`, which only says "act on the symbolic link itself".
  // Seven of fifteen spellings were decided wrongly.
  //
  // A bare invocation carries no leading dash, so the READ that this arm
  // must not refuse — two real corpus commands run `xattr <hook>` to inspect
  // the attribute list — is excluded by construction rather than by a list.
  /\bxattr\b[^\n]*\s-[A-Za-z]*[cdw][A-Za-z]*\b/,
];

/** Interpreters whose argument is a program this module cannot read. */
const INTERPRETERS = /^(?:python[23]?|perl|ruby|node|bun|deno|osascript|sh|bash|zsh|dash|ksh|php)$/;

/**
 * Interpreters whose `-c` argument is SHELL — which this module can read.
 *
 * #1176: these were being handed to `WRITE_INTENT`, which enumerates Node and
 * Python idioms, so `bash -c 'echo x > <protected>'` matched nothing and was
 * allowed. Arm 1 could not see it either, because the body is quoted. The
 * body is shell, the module parses shell, so it recurses instead of guessing.
 */
const SHELLS = /^(?:sh|bash|zsh|dash|ksh)$/;

/** The `-c` body of a shell invocation, dequoted. */
function shellBody(segment: string): string {
  const m = /\s-[a-z]*c\s+([\s\S]+)$/.exec(segment);
  return m ? dequote(m[1]).trim() : '';
}

/**
 * Declared write intent inside an interpreter body.
 *
 * The honest version of this arm would refuse any interpreter naming a
 * protected artifact, since a program is opaque. That was implemented and
 * MEASURED: it newly refused 1,760 of 5,060 real commands — 35% — and
 * triage found them to be reads. `bun -e '…readFileSync(…workflow-state
 * .json…)…'` and `python3 -I -c 'json.load(open(…))'` are how every agent
 * on this machine inspects gate state, and a guard that refuses the normal
 * way of looking at a thing is a guard that gets switched off.
 *
 * So the arm fires on a declared write VERB instead. The limit that buys is
 * real and is stated rather than hidden: an interpreter can always evade
 * this — build the name from pieces, `eval` it, call through a variable, or
 * put the program in a file instead of `-c`. This arm raises the cost of an
 * accidental write and of the obvious deliberate one. It is not a boundary,
 * and `.claude/rules/checks-must-be-able-to-fail.md` would call it a
 * detector narrower than what it detects. It is the widest setting the
 * measured false-positive rate allows.
 */
const WRITE_INTENT =
  /\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|unlinkSync|rmSync|truncateSync|write_text|json\.dump|os\.remove|os\.rename|os\.replace|os\.unlink|shutil\.(?:copy|move|rmtree))\b|(?<!stdout)(?<!stderr)\.write\s*\(|\bopen\s*\([^)]*['"][wax]\+?['"]/;

/**
 * #1176 measured the suggested widening of WRITE_INTENT to shell idioms —
 * `>`, `>>`, `tee`, `rm`, `mv`, `cp`, `dd of=`, `truncate` — so that a
 * NON-shell interpreter shelling out would also fire. It is not implemented.
 *
 * Measured: 100 newly blocked against 4 without it, on 5,513 real commands.
 * Sampling the extra 96 found them to be reads, and the mechanism is
 * specific: `>{1,2}\s*\S` matches `=>`, so every arrow function in a
 * `bun -e` body became a declared write. `x=>x.id==="AC-4"` is not a write.
 *
 * The same lesson as the interpreter widening this module already records:
 * matching SHELL idioms inside a body that is not shell matches the host
 * language instead. A shell body is handled properly by recursion (see
 * SHELLS); a Python or Node body that shells out would need its
 * `os.system`/`subprocess`/`execSync` argument extracted and recursed, which
 * is a real fix and a different issue from this one.
 */

/** `find` actions that run or delete rather than print. */
const FIND_MUTATING = /\s-(?:delete|exec|execdir|ok|okdir)\b/;

/**
 * Does this text name a protected artifact? Pass a DEQUOTED segment.
 *
 * #1184: folded to lower case. Measured on this machine, `WORKFLOW-STATE.JSON`
 * and `workflow-state.json` resolve to the SAME INODE — the default macOS
 * filesystem is case-insensitive — so a case-sensitive match let the
 * uppercase spelling of every protected artifact through. On a case-sensitive
 * filesystem the two are different files, so folding costs only a refusal of
 * a file that cannot coexist with the real one where it matters.
 */
function names(text: string, list: string[]): string | null {
  const hay = text.toLowerCase();
  for (const p of list) if (hay.includes(p.toLowerCase())) return p;
  return null;
}

/**
 * Protected artifacts this text names somewhere OTHER than a scratch tree
 * (#1175).
 *
 * A name is exempted only when EVERY path word carrying it is scratch. One
 * mention of the live artifact alongside ten fixtures still refuses, which is
 * the direction a guard should err in and also the common real shape: a
 * command that copies a fixture over a run's state names both.
 */
function namesOutsideScratch(text: string, list: string[], exempt: boolean): string[] {
  const out: string[] = [];
  for (const p of list) {
    const words = pathWordsContaining(text, p);
    if (words.length === 0) continue;
    if (exempt && words.every(isScratchPath)) continue;
    out.push(p);
  }
  return out;
}

const ALL_PROTECTED = [...PROTECTED_FILES, ...PROTECTED_HOOKS];

/**
 * Decide a Bash tool call.
 *
 * Returns `{ blocked: false }` for anything this module cannot show is a
 * write to a protected artifact. That default is deliberate and is the
 * reason the checks above are structural: a guard tuned so wide that people
 * work around it protects nothing, and four real refusals of read-only work
 * is already a pattern.
 *
 * `exempt` is computed once from the WHOLE command and handed down, rather
 * than recomputed per segment or per recursion. The command that voids the
 * exemption puts the `ln` in one segment and the write in another, so a
 * per-segment answer would never see both.
 */
export function decideBashWrite(cmd: string, depth = 0, exemptIn?: boolean): BashWriteDecision {
  if (!cmd) return ALLOW;
  // A shell body can contain a shell body. Bounded so a crafted nest costs a
  // fixed amount of work rather than the session.
  if (depth > 3) return ALLOW;
  const exempt = exemptIn ?? !exemptionIsVoid(cmd);

  for (const seg of segments(cmd)) {
    const bare = dequote(seg); // TARGET view: contents kept
    const code = stripQuoted(seg); // VERB view: quoted spans gone
    const word = commandWord(seg);

    // 1. Shell redirection and copying verbs. Never exempted by anything:
    //    this is the arm the old allowlist sat above, which is #1120.
    // The whole command is passed so the directory test can see a `mkdir`
    // in an EARLIER segment (#1196 R2). Everything else is per-segment.
    for (const target of writeTargets(seg, cmd)) {
      // #1175: the target IS a path, so the tree question is asked directly
      // here rather than through `namesOutsideScratch`.
      if (exempt && isScratchPath(target)) continue;
      const pf = names(target, PROTECTED_FILES);
      if (pf) {
        return {
          blocked: true,
          reason: `Bash write to protected file "${pf}" blocked. Use gate-runner.ts for gate results.`,
        };
      }
      if (names(target, PROTECTED_HOOKS)) {
        return { blocked: true, reason: 'Bash write to hook file blocked. Hook integrity is protected.' };
      }
    }

    // 2. In-place mutation. The verb is read off `code`, and the target must
    //    be an ARGUMENT — not any text in the segment. `sed -i '' "s/|
    //    X.hook.ts |/…/" NOTES.md` edits a markdown file and merely mentions
    //    a hook in its script; matching the whole segment refused it.
    //    #1184: the resolved command word is prepended, so a QUOTED in-place
    //    verb is still seen. Prepending rather than testing the dequoted
    //    segment keeps the measured false positive out: `sed -i '' "s/|
    //    X.hook.ts |/…/" NOTES.md` must not match `rm` because some quoted
    //    text contains it, and `grep "rm -rf …"` must stay a grep.
    const verbView = `${word} ${code}`;
    if (IN_PLACE.some(p => p.test(verbView))) {
      const pf = namesOutsideScratch(argumentsOf(seg).join(' '), ALL_PROTECTED, exempt)[0];
      if (pf) {
        return {
          blocked: true,
          reason: `Bash command modifies "${pf}" in place. Use gate-runner.ts for gate results.`,
        };
      }
    }

    // 3. Interpreter bodies and mutating `find`. These write with no shell
    //    redirect, so arm 1 sees nothing at all. See WRITE_INTENT for why
    //    this asks for a declared write verb rather than refusing every
    //    interpreter that names a protected artifact, and for what that
    //    concession costs.
    const isInterpreter = INTERPRETERS.test(word) && /\s-[a-z]*[ce]\b/.test(code);
    const isMutatingFind = word === 'find' && FIND_MUTATING.test(code);

    // 3a. A shell `-c` body is shell. Read it as shell rather than scanning
    //     it for Node and Python idioms it will never contain (#1176).
    if (isInterpreter && SHELLS.test(word)) {
      const body = shellBody(seg);
      if (body) {
        const inner = decideBashWrite(body, depth + 1, exempt);
        if (inner.blocked) return inner;
      }
    }

    if (isInterpreter || isMutatingFind) {
      const candidates = namesOutsideScratch(bare, ALL_PROTECTED, exempt);
      const pf = isMutatingFind
        ? (candidates[0] ?? null)
        : (candidates.find(p => writesNear(bare, p)) ?? null);
      if (pf) {
        return {
          blocked: true,
          reason:
            `Bash command runs an interpreter or a mutating \`find\` naming "${pf}". ` +
            `What it writes cannot be read off the command line, so it is refused.`,
        };
      }
    }

    // 4. Permission changes on a protected artifact. The COMMAND WORD must be
    //    the verb — not merely a `chmod` somewhere in the string, which is
    //    what refused four read-only commands. The target is read off `bare`,
    //    so quoting the path does not hide it.
    //
    //    #1146: the TARGET list widened from PROTECTED_HOOKS to every
    //    protected artifact; the VERB test is untouched, and that asymmetry is
    //    the point. There was no reason for a `chmod` on `.gate-salt` to be
    //    allowed while a `chmod` on a `.hook.ts` was refused — mode bits are
    //    how a file stops being writable, so a permission change on the gate
    //    salt is a step toward writing it. Measured on the 5,059 allowed
    //    commands naming a protected artifact, the widening newly blocks
    //    exactly one, and that one is real:
    //      `chmod 600 …/worktrees/agent-abbce…/hooks/lib/.gate-salt`
    //
    //    #1175 composes with that widening rather than replacing it: the
    //    target list stays `ALL_PROTECTED` and the lookup moves to
    //    `namesOutsideScratch`, so a `chmod` on a FIXTURE in a scratch tree
    //    is not a permission change on a protected artifact. The widened
    //    list and the tree scoping are independent and both are kept — a
    //    textual merge that took either side alone would have silently
    //    dropped one of them.
    const permTarget =
      word === 'chmod' || word === 'chflags'
        ? (namesOutsideScratch(bare, ALL_PROTECTED, exempt)[0] ?? null)
        : null;
    if (permTarget) {
      return {
        blocked: true,
        reason: `Permission change on protected artifact "${permTarget}" blocked. Integrity is protected.`,
      };
    }

    // 5. The gate salt in the Keychain. Exempted by nothing — unlike `chmod`,
    //    which turns up innocently in docs and greps, `security` INVOKED on
    //    the gate-salt entry has no benign form. It has a benign MENTION
    //    though, and two real commands hit it: issue comments quoting the
    //    very command they proposed to guard.
    //
    //    #1176: this used to read `stripQuoted(cmd)` over the whole command,
    //    which deleted the quoted key name outright — so the real invocation,
    //    `security find-generic-password -s 'pai-gate-salt'`, could not fire
    //    it. The prose case is now separated by POSITION instead: the command
    //    word must BE `security`, which an issue comment's `gh` never is.
    //    #1184: the key is matched across the WHOLE command, not just this
    //    segment, so `KEY=pai-gate-salt; security … -s "$KEY"` cannot hide it
    //    behind a variable. Measured cost: 0 commands in an unfiltered corpus
    //    of 125,644. The command word must still BE `security`, which is what
    //    keeps the `gh issue comment` prose case allowed.
    //
    //    The other half of that suggestion — firing on any keychain
    //    SUBCOMMAND whether or not the key is named — is refused. In the same
    //    corpus only TWO commands have `security` as their command word, and
    //    widening to subcommands newly blocks exactly one: `security
    //    find-generic-password -h`, a help invocation. One false positive,
    //    zero true positives, no evidence of the risk it was meant to cover.
    if (word === 'security' && dequote(cmd).toLowerCase().includes('pai-gate-salt')) {
      return { blocked: true, reason: 'Access to gate salt Keychain entry blocked.' };
    }
  }

  return ALLOW;
}
