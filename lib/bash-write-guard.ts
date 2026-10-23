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
import { isInterpreterWord, isShellWord } from './interpreters';

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
 *
 * ## BOTH spellings, which #1175 got wrong
 *
 * `resolve()` normalises `.` and `..`; it does not follow a symlink. So a
 * tree named `/tmp/e2e` stayed in this list as `/tmp/e2e` while a path
 * through the same inode reads `/private/tmp/e2e/…`, and `inAnyTree`
 * matches neither spelling against the other. Executed against the module
 * as merged, with `RUNGATE_WORK_DIR=/tmp/e2e`:
 *
 *     /tmp/e2e/s/workflow-state.json           blocked
 *     /private/tmp/e2e/s/workflow-state.json   ALLOWED   ← the run store
 *
 * The same for `RUNGATE_HOOKS_DIR`, and `/tmp` is a symlink to
 * `/private/tmp` on every macOS install, so the second spelling is not
 * exotic — it is what `realpath` prints.
 *
 * `scratchRoots()` below already recorded both spellings for the fixed
 * roots, so the asymmetry was inside one file: the roots a write may land
 * in were realpathed and the trees it may not were not. A `catch` here
 * means the tree is not on disk, which is ordinary for a variable pointing
 * at a directory the command is about to create, and the resolved spelling
 * stands on its own.
 */
function protectedTrees(): string[] {
  const home = process.env.HOME || '';
  const spellings: string[] = [];
  for (const p of [
    // The run store — where 2,620 of 3,240 absolute artifact references live.
    process.env.RUNGATE_WORK_DIR || '',
    home ? join(home, '.rungate') : '',
    home ? join(home, '.claude') : '',
    // The trees a hook registration resolves to. Read from the environment
    // because that is what the registrations are spelled with.
    process.env.PAI_HOOKS_DIR || '',
    process.env.RUNGATE_HOOKS_DIR || '',
    home ? join(home, '.pai', 'hooks') : '',
  ].filter(Boolean)) {
    const normalised = resolve(p);
    spellings.push(normalised);
    try {
      const real = realpathSync(normalised);
      if (real !== normalised) spellings.push(real);
    } catch {
      // Not on disk. The resolved spelling above still stands.
    }
  }
  return spellings;
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

/**
 * `ln` is not the only verb that makes a link (#1411, raised as a CRITICAL
 * by the review on #1354).
 *
 * GNU and BSD `cp` create links on request and spell none of
 * `LINK_CREATION`'s four alternatives, so every one of these was ALLOWED —
 * the bypass in the docblock above, reachable by a different verb:
 *
 *     cp -s ~/.rungate/victim /tmp/esc && echo '{}' > /tmp/esc/workflow-state.json
 *
 * Measured before the fix, all allowed: `cp -s`, `cp --symbolic-link`,
 * `cp -l`, `cp --link`, `cp -rs`, `cp -as`, `cp -sv`, `/bin/cp -s`,
 * `sudo cp -s`, `install -l s`. `-l` belongs with `-s`: a hard link to a
 * file inside the run store aims a later write at the victim's inode just
 * as a symlink aims it at the victim's path.
 *
 * ## The FAMILY, not the spelling
 *
 * A test for the literal `cp -s` is the cheapest wrong fix — seven of the
 * ten rows above walk around it. So the reading is token-level: a short
 * cluster is any `-…` containing a lower-case `s` or `l`, which is what
 * makes `-rs`, `-as` and `-sv` fall out of one rule rather than three; a
 * long option is matched by PREFIX, because GNU accepts any unambiguous
 * abbreviation and `--sym` is as real as `--symbolic-link`.
 *
 * Case matters: `cp -L` dereferences links in the SOURCE and creates none,
 * so only the lower-case letters count. `cp -r`, `cp -p`, `cp -a` and
 * `mkdir -p` are CONTROL rows and must stay exempt.
 *
 * The scan is position-independent rather than keyed to the resolved verb,
 * so `find . -exec cp -s …` is covered — the same position `LINK_CREATION`
 * exists to reach for `ln`, where `commandWord` resolves to `find`.
 *
 * ## And the `ln` boundary, since it was asked
 *
 * `\bln\s` needs a following character, so it misses an `ln` that ends a
 * segment. Measured over five spellings: the regex misses four, and the
 * segment-verb net catches three of those four (`ln`, `echo x && ln`,
 * `sudo ln`). The one neither catches is `find . -exec ln` with no
 * terminator, which `find(1)` refuses — "the expression must be terminated
 * by a semicolon" — so it is a syntax error, not a bypass. Count: ONE
 * spelling missed by both nets, ZERO executable. No change made.
 */
const LINK_VERBS = new Set(['cp', 'install']);

/** A token's verb name: `/bin/cp` and `\cp` are both `cp`. */
function verbToken(token: string): string {
  const bare = token.replace(/^[\\(]+/, '');
  return bare.slice(bare.lastIndexOf('/') + 1);
}

function isLinkFlag(token: string): boolean {
  if (token.startsWith('--')) {
    const name = token.slice(2).split('=')[0];
    if (!name) return false;
    return 'symbolic-link'.startsWith(name) || 'link'.startsWith(name);
  }
  // A short cluster. Lower case only: `-L` follows links in the source and
  // creates none, which is a CONTROL row.
  return /^-[A-Za-z]+$/.test(token) && /[sl]/.test(token.slice(1));
}

function flagMakesLink(segment: string): boolean {
  const tokens = stripQuoted(segment).trim().split(/\s+/).filter(Boolean);
  if (!tokens.some(t => LINK_VERBS.has(verbToken(t)))) return false;
  return tokens.some(isLinkFlag);
}

/**
 * #1240: both tests read a view that KEEPS the text an interpreter is going
 * to run. `stripHeredocs` deletes a heredoc body, so an `ln` inside
 * `bash <<'EOF'` was invisible to the first test; `segments(cmd)` over the
 * raw command does not make a body's lines into segments, so it was
 * invisible to the second as well. One view, built once, fed to both.
 */
function exemptionIsVoid(cmd: string): boolean {
  const programs = interpreterPrograms(cmd).map(p => p.program);
  const view = [stripHeredocs(cmd), ...programs].join('\n');
  if (LINK_CREATION.test(view)) return true;
  return segments(view).some(seg => commandWord(seg) === 'ln' || flagMakesLink(seg));
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
      //
      // #1249: inside DOUBLE quotes, consume the escape PAIR rather than
      // looking one character back. `\\` is an escaped BACKSLASH — a
      // complete pair — and the `"` after it closes the span. A lookbehind
      // cannot tell that `"` from the escaped one in `\"`, so `"x\\"` was
      // read as still open and the rest of the command, separator and write
      // verb together, became one segment whose command word is `echo`. The
      // outside-quote branch below already consumes the pair, for this same
      // reason; this is that rule applied inside the span.
      if (quote === '"' && c === '\\' && i + 1 < cmd.length) {
        cur += cmd[++i];
        continue;
      }
      if (c === quote) quote = null;
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

/**
 * Does the heredoc opened on this line hand its body to an interpreter?
 *
 * Two ways it can. The segment carrying the operator IS an interpreter
 * (`bash <<'EOF'`), or the operator's segment is piped into one
 * (`cat <<'EOF' | bash`). Everything else — `cat > doc.md <<'EOF'`,
 * `gh issue comment --body-file - <<'EOF'` — is a DOCUMENT, and stripping
 * those bodies is what stopped 1,860 real commands from being refused for
 * quoting the words this guard looks for. That distinction is the whole
 * reason this is a predicate rather than "stop stripping heredocs".
 */
function heredocInterpreter(line: string): string | null {
  const segs = segments(line);
  const ownerIdx = segs.findIndex(s => heredocDelimiter(s) !== null);
  if (ownerIdx === -1) return null;
  const owner = commandWord(segs[ownerIdx]);
  if (isInterpreterWord(owner)) return owner;
  const opAt = line.search(/(?<!<)<<(?!<)/);
  if (opAt === -1 || !line.slice(opAt).includes('|')) return null;
  return segs.slice(ownerIdx + 1).map(commandWord).find(isInterpreterWord) ?? null;
}

/**
 * The program text this command hands to an interpreter on stdin (#1240).
 *
 * A heredoc body fed to an interpreter, and a herestring operand of one.
 * Deliberately NOT the `-c`/`-e` form: arm 3a already reads that, and
 * returning it here would decide it twice.
 *
 * An UNTERMINATED heredoc is not returned. `stripHeredocs` already emits
 * those lines unchanged — the #1184 fail-closed direction — so every arm
 * can already see them, and returning them again would double-count a body
 * that is not hidden in the first place.
 */
export function interpreterPrograms(cmd: string): Array<{ shell: boolean; program: string }> {
  const out: Array<{ shell: boolean; program: string }> = [];
  const lines = cmd.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (/^\s*#/.test(line)) continue; // a comment cannot open either form

    // A HERESTRING has no body and no terminator, which is why
    // `heredocDelimiter` excludes it (#1184). It is still a program, and it
    // is invisible for the other half of the mechanism: the `>` inside it
    // sits in a quoted span that the VERB view removes.
    const hs = /(?<!<)<<<(?!<)([\s\S]*)$/.exec(line);
    if (hs) {
      const owner = segments(line).find(s => /(?<!<)<<<(?!<)/.test(s));
      const word = owner ? commandWord(owner) : '';
      if (isInterpreterWord(word)) {
        out.push({ shell: isShellWord(word), program: dequote(hs[1]).trim() });
      }
    }

    const delim = heredocDelimiter(line);
    if (!delim) continue;
    const body: string[] = [];
    let j = i;
    while (j < lines.length && lines[j].trim() !== delim) {
      body.push(lines[j]);
      j++;
    }
    if (j < lines.length) {
      const word = heredocInterpreter(line);
      if (word) out.push({ shell: isShellWord(word), program: body.join('\n') });
      i = j + 1;
    } else {
      i = j; // unterminated: already visible, see the docblock
    }
  }
  return out.filter(p => p.program !== '');
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

// #1240: the list moved to `lib/interpreters.ts`, which `lib/bash-file-read.ts`
// now reads too. Two modules were answering "is this an interpreter" with two
// different lists, and the narrower one was why a `python3` heredoc read as a
// document.

/**
 * Interpreters whose `-c` argument is SHELL — which this module can read.
 *
 * #1176: these were being handed to `WRITE_INTENT`, which enumerates Node and
 * Python idioms, so `bash -c 'echo x > <protected>'` matched nothing and was
 * allowed. Arm 1 could not see it either, because the body is quoted. The
 * body is shell, the module parses shell, so it recurses instead of guessing.
 *
 * #1240: also in `lib/interpreters.ts` as `isShellWord`.
 */

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

/**
 * Protected names in a program body, counting only ABSOLUTE spellings
 * outside a scratch tree (#1240).
 *
 * The stricter reading exists because of what it costs otherwise, measured
 * rather than reasoned: scanning an interpreter body for a protected NAME
 * newly refused **23** real commands, and every one of them was an agent
 * building hook FIXTURES in a `/tmp` tree with an assembled path —
 * `open(os.path.join(dst, n), "w")`, where the only word carrying
 * `.hook.ts` is the relative suffix itself. A relative fragment cannot be
 * shown to be scratch, so the fail-closed reading in `isScratchPath`
 * correctly refuses to exempt it, and the result is that the fixture work
 * #1175 exists to unblock gets refused by the arm added beside it.
 *
 * So this arm asks for an absolute path. The spelling it is there to catch
 * — `open("<run store>/workflow-state.json", "w")` inside a heredoc — is
 * absolute, and the 23 are not. The arm it mirrors (arm 3, the `-c` form)
 * keeps its looser reading: that behaviour is pre-existing and measured,
 * and tightening it is not this change's business.
 */
function absoluteNamesOutsideScratch(text: string, exempt: boolean): string[] {
  const out: string[] = [];
  for (const p of ALL_PROTECTED) {
    const words = pathWordsContaining(text, p).filter(w => w.startsWith('/'));
    if (words.length === 0) continue;
    if (exempt && words.every(isScratchPath)) continue;
    out.push(p);
  }
  return out;
}

/**
 * The `-c`/`-e` program of an interpreter segment, with only its OUTER
 * quoting removed (#1277).
 *
 * `shellBody` next door `dequote`s, which is right for a shell body about to
 * be re-parsed as shell and wrong for every other language: it deletes the
 * only thing that marks where one string literal ends and the next
 * expression begins. `bodyTargets` is the whole point of this function, and
 * it cannot answer its question on a view with no quotes in it.
 *
 * An unmatched outer quote leaves the text as it stands. `bodyTargets` then
 * reports the body `unreadable` rather than guessing, which is the
 * fail-closed direction.
 */
export function programBody(segment: string): string {
  const m = /\s-[a-z]*[ce]\s+([\s\S]+)$/.exec(segment);
  if (!m) return '';
  const raw = m[1].trim();
  const q = raw[0];
  if ((q === "'" || q === '"') && raw.length > 1 && raw[raw.length - 1] === q) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * A literal that STANDS ALONE as an argument is one nothing transforms, so
 * the path it spells is the path the program hands to the filesystem.
 *
 * Both sets are closed-world and that is the point. They enumerate what may
 * legally DELIMIT an argument, not what may operate on one — so a language
 * whose concatenation operator nobody here thought of reads as "not
 * delimited", which refuses. The other spelling, a denylist of operators
 * (`+`, `%`, `.replace`, an f-string, …), is a detector narrower than what
 * it detects — `.claude/rules/checks-must-be-able-to-fail.md` — and it is
 * what #1276's stopgap was a second attempt at.
 *
 * ## `=` and `:` ARE openers, and the rebinding question moved (#1371)

 * A round of #1371 dropped them, on the finding that `p = "/tmp/x"` records
 * a target nothing then follows through its reassignment:
 *
 *     p = '/tmp/fix/workflow-state.json'
 *     p = p.replace('/tmp/fix', os.environ['RUNGATE_WORK_DIR'])
 *     open(p, 'w').write('{}')
 *
 * Dropping them worked and was the wrong place to answer it. `inWritePosition`
 * answers the same question generally — a binding at statement level is an
 * argument of no call, so it is not a write position — and it also catches the
 * dict KEY, the ternary branch, and the inner call's default that the `:` drop
 * reached only by accident or not at all. Measured: with `inWritePosition` in
 * place, restoring `=` and `:` moves nothing — 0 newly blocked and 0 newly
 * allowed over 132,196 real commands, and the same exemption population.
 *
 * So they are restored, because two deciders answering one question are
 * behaviourally one, no behavioural test can tell them apart, and the next
 * reader deletes whichever looks redundant — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. The measurement above is
 * exactly the evidence that they WERE two deciders.
 *
 * What this set still answers alone is ADJACENCY: `x + "/tmp/…"` has an
 * operator against the literal, and no question about write position can see
 * that.
 *
 * A closing bracket is neither an opener nor a closer. It ENDS the group the
 * literal sits in and leaves the outer expression still running, so the walk
 * steps past it and keeps asking — which is how `Path("/tmp/x")
 * .relative_to(…)` is told from `shutil.copy(src, "/tmp/x")`. The first
 * version of this stopped at the `)` and reported the pathlib spelling as a
 * target; its own CONTROL row caught it, and that row is in the tests.
 */
const ARG_OPENS = new Set(['(', ',', '[', '{', '=', ':', ';']);
const ARG_CLOSES = new Set([')', ',', ']', '}', ';', ':']);
const GROUP_CLOSES = new Set([')', ']', '}']);

export interface BodyTargets {
  /** Carrying literals that stand alone — the paths the program can write. */
  targets: string[];
  /** Carrying literals an expression consumes. The destination is NOT these. */
  fragments: string[];
  /**
   * Literals resolving inside a protected tree, whatever they spell and
   * whether or not anything transforms them (#1371).
   *
   * `targets` and `fragments` are both filtered by `ALL_PROTECTED`, so
   * `targets.every(isScratchPath)` quantifies over a set the caller chose the
   * membership of. This one is not filtered by a name list at all, which is
   * the point: the property it reports does not depend on `ALL_PROTECTED`
   * being complete, and completeness is what failed.
   */
  protectedLiterals: string[];
  /**
   * Path-shaped literals the reader could NOT place — an expansion it cannot
   * perform, a backtick, or a relative path whose meaning depends on a
   * working directory. Kept on their own list rather than folded into
   * `protectedLiterals`, so that afterwards the reason a body was refused is
   * still readable: "it names a live tree" and "I could not tell" are
   * different facts and only one of them is a finding about the command.
   */
  unplaceable: string[];
  /** The body does not read as a sequence of complete literals. */
  unreadable: boolean;
}

/**
 * Where a literal sits, as THREE readings and not two (#1371, second round).
 *
 * The first version of this returned a boolean behind
 * `if (!value.startsWith('/')) return false`, and the review was right that
 * the word *absolute* in the remedy I was given is where the hole came
 * from. `~/.rungate/run`, `$HOME/.rungate/run` and `${HOME}/.claude` all
 * took that early exit, and the caller read `false` as **not a protected
 * target** rather than as **I could not place this** — a silent skip, one
 * layer inside the remedy for silent skips.
 *
 * The asymmetry that settles it: a false `unplaceable` costs a refused
 * exemption, which somebody notices and fixes. A false `elsewhere` costs a
 * bypass, which nobody notices.
 *
 * Expansion handles the spellings we thought of; `unplaceable` handles the
 * ones we did not, and it is the half that matters. Both are kept because
 * expansion is what stops the fail-closed half from refusing every ordinary
 * `~/`-spelled read.
 */
type Placement = 'protected' | 'unplaceable' | 'elsewhere';

/** A leading `~`, `$HOME` or `${HOME}`, which the runtime or shell expands. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * Path-shaped and NOT placeable: an expansion we cannot perform, a backtick,
 * or a relative path whose meaning depends on a working directory this
 * module cannot see. `isScratchPath` already gives a relative path exactly
 * this reading — "only an ABSOLUTE path can be placed in a tree" — so this
 * is that rule applied on the other side of the same question.
 */
const UNPLACEABLE = /[$`~]/;

function expandHome(value: string): string {
  const home = process.env.HOME || '';
  if (!home) return value;
  return value.replace(HOME_PREFIX, home);
}

/**
 * One site per reading, so a mutation battery can remove the live-tree
 * reading without removing the fail-closed one and report which rows each
 * is actually holding up. Inlining either verdict at a second site would
 * let a refusal bypass the mutation and the rows would go green having
 * witnessed nothing — `.claude/rules/checks-must-be-able-to-fail.md`.
 */
const IN_LIVE_TREE: Placement = 'protected';
const CANNOT_PLACE: Placement = 'unplaceable';

/**
 * ## The case comparison is the VOLUME's to make, and it makes it (#1371)
 *
 * The review asked for both sides of the live-tree comparison to be
 * case-folded, as `names()` already is, because `/Users/JHORN/…` and
 * `/Users/jhorn/…` are one file and two strings on this volume. It was
 * built, and then the mutation battery refused to witness it: removing the
 * fold left the SHOUTED row refused anyway, because `resolveThroughLinks`
 * climbs to the deepest EXISTING ancestor and `realpathSync` returns the
 * canonical case — `/USERS` comes back `/Users`. So the fold decided
 * nothing that the resolution had not already decided.
 *
 * It is not shipped, and the reason is not thrift. Two deciders answering
 * one question are behaviourally one, no test can tell them apart, and the
 * next reader deletes whichever looks redundant. And on a case-SENSITIVE
 * volume the fold is the wrong answer rather than a spare one: there
 * `/Users/JHORN/x` really is a different file, which the fold would report
 * as live. `names()` folds for a different situation — it matches a
 * basename inside a command string where nothing resolves anything.
 *
 * CI proved both halves of that, and corrected the heading this note used
 * to carry. It said the differential "does not exist here", measured on
 * macOS — and the SHOUTED row went red on the Linux runner, where
 * `/HOME/RUNNER/.rungate/run` is a path that does not exist and is not the
 * artifact. The guard was right on both volumes; the claim was macOS's,
 * read as universal. The row now probes the volume and asserts the verdict
 * tracks it in BOTH directions, so a blind `.toLowerCase()` fold reddens it
 * on Linux and dropping the resolution reddens it on macOS.
 *
 * #1211 / #1358 is the same QUESTION about `WorkflowStateGuard` and may
 * well have a different answer, because that matcher has no resolution step
 * to fall back on. Worth reading this note before fixing it there.
 */
function placeLiteral(value: string, live: string[]): Placement {
  const expanded = expandHome(value);
  // UNPLACEABLE is asked FIRST, and the order is the fix for a hole the
  // other way round left open (#1411 review): `"$RG"` carries no slash, so
  // a slash test in front of this one answered `elsewhere` — "I placed it,
  // and it is not protected" — for a value nothing had placed. Witnessed:
  // `shutil.copy("/tmp/fix/workflow-state.json", os.path.expandvars("$RG"))`
  // was ALLOWED before this swap and is refused after it. The slash-bearing
  // spelling of the same command was already refused, which is what made
  // the gap invisible.
  if (UNPLACEABLE.test(expanded)) return CANNOT_PLACE;
  // Not path-shaped at all: a mode string, a JSON blob, a module name. The
  // exemption would never apply again if these ended it.
  if (!expanded.includes('/')) return 'elsewhere';
  // A RELATIVE path-shaped literal stays `elsewhere`, and that is measured
  // rather than comfortable. Treating one as unplaceable costs 7 real
  // commands and halves the exemption population (13 segments to 6),
  // because `'hornjason/pai-config'` and `'./lib/x.ts'` are slash-bearing
  // and are not paths — and it does not even close the class it was
  // widened for, since `'.'` and `'x'` carry no slash at all. The honest
  // closure for a relative destination is `inWritePosition`, which asks
  // only about literals the write actually consumes.
  if (!expanded.startsWith('/')) return 'elsewhere';
  const normalised = resolve(expanded);
  if (inAnyTree(normalised, live)) return IN_LIVE_TREE;
  const real = resolveThroughLinks(normalised);
  // Nothing in the chain resolved, so this is a path we could not place —
  // not a path we placed outside the live trees. The distinction is the
  // whole of #1371's third round, and `isScratchPath` already notes that an
  // unreachable fail-OPEN in a fail-closed module reads as permission.
  if (real === null) return CANNOT_PLACE;
  // Both spellings, for the reason `protectedTrees` gives at length:
  // `resolve` normalises `..` and does not follow a link, so a pre-existing
  // symlink out of scratch is invisible to the first reading.
  if (inAnyTree(real, live)) return IN_LIVE_TREE;
  return 'elsewhere';
}

/**
 * Which path literals in an interpreter body can be shown to be the write
 * TARGET, and which are merely fragments of an expression that computes one
 * (#1277).
 *
 * ## The mistake this replaces
 *
 * Every escape in this family is the same one wearing a different costume:
 * the exemption read a path LITERAL off the command line and treated it as
 * the destination. #1276 shipped a labelled stopgap — "is every absolute
 * literal in the body scratch" — which closed the one spelling that had been
 * measured and left the class open, because a computed destination need not
 * leave a non-scratch literal behind. Four spellings that it exempts and
 * this refuses are asserted in `test/bash-write-guard.test.ts`; the one that
 * matters least is also the one that reads worst:
 *
 *     bun -e 'writeFileSync("/tmp/x/workflow-state.json"
 *               .replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'
 *
 * Every absolute literal in it is scratch. The write lands in the run store.
 *
 * ## What is asked instead
 *
 * A literal is a target only when nothing between it and the filesystem
 * transforms it — then, and only then, `isScratchPath` resolving it answers
 * the real question. A carrying literal that does NOT stand alone is not
 * evidence against the write, it is the ABSENCE of evidence for it, so it
 * ends the exemption rather than being ignored. That is the same fail-closed
 * reading `isScratchPath` already applies to a relative path.
 *
 * The three things this still does not do are stated rather than hidden.
 * It cannot see an assembled NAME (`'workflow' + '-state.json'`) — no
 * literal carries the artifact, so arm 3 never receives a candidate, which
 * is a limit of the candidate search and has its own asserted row. It does
 * not read a program in a FILE. And `eval` defeats it, as it defeats any
 * reading of a program that does not run it.
 */
export function bodyTargets(body: string): BodyTargets {
  const targets: string[] = [];
  const fragments: string[] = [];
  const protectedLiterals: string[] = [];
  const unplaceable: string[] = [];
  /** Every literal span read so far, so the backward walk can step over one. */
  const spans: [number, number][] = [];
  // Read once per body rather than once per literal: each call realpaths up
  // to six trees, and a body has as many literals as it likes.
  const live = protectedTrees();
  let i = 0;
  while (i < body.length) {
    const q = body[i];
    if (q !== "'" && q !== '"') {
      i++;
      continue;
    }
    let j = i + 1;
    let value = '';
    let closed = false;
    while (j < body.length) {
      const c = body[j];
      // Only a DOUBLE-quoted literal escapes. Inside single quotes a
      // backslash is literal in both shell and Python, and treating it as an
      // escape keeps the span open past its real end — #1203's defect, one
      // layer down.
      if (q === '"' && c === '\\' && j + 1 < body.length) {
        value += body[j + 1];
        j += 2;
        continue;
      }
      if (c === q) {
        closed = true;
        break;
      }
      value += c;
      j++;
    }
    // An unterminated literal means every boundary after it is a guess.
    if (!closed) return { targets: [], fragments: [], protectedLiterals: [], unplaceable: [], unreadable: true };
    spans.push([i, j]);
    const where = placeLiteral(value, live);
    if (where === 'protected') protectedLiterals.push(value);
    if (where === 'unplaceable') unplaceable.push(value);
    if (ALL_PROTECTED.some(p => value.toLowerCase().includes(p.toLowerCase()))) {
      const pos = standsAlone(body, i, j) ? inWritePosition(body, i, spans) : UNPROVEN;
      if (pos === 'destination') targets.push(value);
      // `argument` is deliberately in neither list — see `inWritePosition`.
      else if (pos === 'unproven') fragments.push(value);
    }
    i = j + 1;
  }
  return { targets, fragments, protectedLiterals, unplaceable, unreadable: false };
}

/**
 * Whitespace, including a newline. See `standsAlone` for why the newline is
 * in here rather than carrying a rule of its own.
 */
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * The callees a literal may be a direct argument of and still be the write
 * TARGET (#1371, second round).
 *
 * This is a WHITELIST OF POSITIONS, which is why it is allowed to exist at
 * all. The thing refused twice on this PR is a denylist of TRANSFORMS —
 * `.replace(`, `+`, `%`, an f-string — because a transform nobody listed
 * reads as "no transform" and the exemption holds; `Path("/tmp/x")
 * .relative_to(…)` is the standing proof and it is a CONTROL row. A
 * whitelist fails the other way: a callee nobody listed is not a recognised
 * write position, so the literal is a fragment and the exemption ends.
 *
 * The names are not a new list. They are the names already in
 * `WRITE_INTENT`, which is what makes a command a candidate for arm 3 in
 * the first place — so a verb missing here is a verb that never brought a
 * command to this question.
 *
 * `remove`, `rename`, `replace`, `unlink` and `write` are qualified rather
 * than matched bare: `str.replace` and `stdout.write` are not writes to a
 * file, and a bare match would read a transform as a write position, which
 * is the denylist's failure wearing a whitelist's clothes.
 */
const WRITE_CALLEES = new Set([
  'writeFileSync',
  'appendFileSync',
  'createWriteStream',
  'copyFileSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'truncateSync',
  'write_text',
  'open',
  'dump',
  'copy',
  'copyfile',
  'copytree',
  'move',
  'rmtree',
]);
const QUALIFIED_WRITE_CALLEES = new Set([
  'os.remove',
  'os.rename',
  'os.replace',
  'os.unlink',
  'os.rmdir',
  'shutil.copy',
  'shutil.copyfile',
  'shutil.copytree',
  'shutil.move',
  'shutil.rmtree',
  'json.dump',
]);

/**
 * WHICH argument of a recognised write call is the destination (#1411).
 *
 * Recognising the callee is not enough, because most of these take a SOURCE
 * as well: `shutil.copy("/tmp/fix/workflow-state.json", dest)` put a scratch
 * literal in `targets` while the destination was a name nothing tracks, and
 * `targets.every(isScratchPath)` then exempted a copy whose destination was
 * unknown. Witnessed allowed before this map and refused after it.
 *
 * `-1` means NO argument of that callee is ever a destination path:
 * `json.dump(obj, fp)` writes to a file object, and `p.write_text(data)`
 * writes to its RECEIVER. A literal argument of either is data, and reading
 * it as a target is the same defect pointed the other way.
 *
 * The default is 0 rather than "unknown", because every remaining name in
 * `WRITE_CALLEES` takes its path first and a name that reaches here has
 * already passed the whitelist.
 */
const DEST_INDEX = new Map<string, number>([
  ['copy', 1],
  ['copyfile', 1],
  ['copytree', 1],
  ['copyFileSync', 1],
  ['move', 1],
  ['rename', 1],
  ['renameSync', 1],
  ['replace', 1],
  ['dump', -1],
  ['write_text', -1],
]);

function destIndexOf(name: string): number {
  const last = name.slice(name.lastIndexOf('.') + 1);
  const at = DEST_INDEX.get(last);
  return at === undefined ? 0 : at;
}

function isWriteCallee(name: string): boolean {
  if (!name) return false;
  if (QUALIFIED_WRITE_CALLEES.has(name)) return true;
  const last = name.slice(name.lastIndexOf('.') + 1);
  return WRITE_CALLEES.has(last);
}

/**
 * Is the literal beginning at `start` a DIRECT argument of a recognised
 * write call?
 *
 * The walk goes backwards to the opener of the group the literal sits in,
 * stepping over balanced groups and over literal spans already read — a
 * `(` inside a string is not a bracket. Three endings, and only the first
 * is a yes:
 *
 *   a `(` at depth 0      the literal is an argument of that call; read the
 *                         callee in front of it and ask the whitelist
 *   a `[` or `{` at 0     the literal is an element of a list or an entry
 *                         in a dict, not an argument of anything
 *   the start of the body the literal is at statement level: a binding, a
 *                         bare expression, a dict key with no enclosing call
 *
 * This is what makes the exemption a claim about the WRITE rather than
 * about a path that appears somewhere near one, and it is what the two
 * earlier rounds were each reaching for with a cheaper instrument.
 *
 * ## Three answers, because two of them conflated placed with unreadable
 *
 * `argument` is a literal that IS a direct argument of a recognised write
 * call and is NOT at the destination index — `shutil.copy`'s source, or
 * `json.dump`'s object. A boolean had to call that `unproven`, which is a
 * fragment, which ends the exemption: with the index map added and two
 * answers available, `shutil.copy('/tmp/a/x', '/tmp/b/x')` went from
 * allowed to refused, and that command is the exact shape #1175 exists to
 * unblock. It is three CONTROL rows across three describes and all three
 * went red together, which is what a control is for.
 *
 * So: `destination` counts as a target, `unproven` ends the exemption, and
 * `argument` does neither — the literal is placed, and placed somewhere
 * that is not the write. A command whose ONLY literal is an `argument`
 * still reaches `targets.length === 0` and is refused.
 */
type Position = 'destination' | 'argument' | 'unproven';
const IS_DESTINATION: Position = 'destination';
const UNPROVEN: Position = 'unproven';

function inWritePosition(body: string, start: number, spans: [number, number][]): Position {
  let i = start - 1;
  let depth = 0;
  /** Depth-0 commas between the opener and the literal: its argument index. */
  let index = 0;
  while (i >= 0) {
    const span = spans.find(([s, e]) => i >= s && i <= e);
    if (span) {
      i = span[0] - 1;
      continue;
    }
    const c = body[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(') {
      if (depth === 0) {
        const callee = calleeBefore(body, i);
        if (!isWriteCallee(callee)) return UNPROVEN;
        return index === destIndexOf(callee) ? IS_DESTINATION : 'argument';
      }
      depth--;
    } else if (c === '[' || c === '{') {
      if (depth === 0) return UNPROVEN;
      depth--;
    } else if (c === ',') {
      if (depth === 0) index++;
    } else if (c === '?') {
      // A ternary BRANCH is not a destination, it is one of two candidates,
      // and the guard has no way to say which runs. `:` is an `ARG_OPEN`, so
      // the false branch read as a complete argument and the walk continued
      // past `?` to the write call's own paren — witnessed:
      // `writeFileSync(x ? d : "/tmp/fix/workflow-state.json", "{}")` was
      // ALLOWED, while the same command with the literal in the TRUE branch
      // was already refused, because `?` is not an `ARG_OPEN` and the
      // literal fell out as a fragment. That asymmetry is the whole finding:
      // one spelling of one expression was fail-closed by accident and the
      // other was not.
      if (depth === 0) return UNPROVEN;
    }
    i--;
  }
  return UNPROVEN;
}

/** The dotted name immediately in front of an opening parenthesis. */
function calleeBefore(body: string, openIndex: number): string {
  let i = openIndex - 1;
  while (i >= 0 && WHITESPACE.has(body[i])) i--;
  let end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$.]/.test(body[i])) i--;
  return body.slice(i + 1, end);
}

/**
 * Is the literal spanning `[start, end]` a complete argument on both sides,
 * and is every expression ENCLOSING it also complete?
 *
 * ## A newline is whitespace, not a delimiter (#1371)
 *
 * It used to be one: a newline at the literal's own depth ENDED the
 * expression, on the reading that a newline ends a statement. The AI review
 * on #1371 found what that costs, and it is the whole of #1277 — the
 * headline escape, with one newline inserted:
 *
 *     writeFileSync("/tmp/x/workflow-state.json"
 *       .replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")
 *
 * The literal is followed by a newline, so it read as a complete argument;
 * the `.replace` on the next line was never looked at. Both JavaScript and
 * Python continue an expression across a newline, so "a newline ends a
 * statement" is true only of a statement nothing encloses — which this walk
 * cannot tell apart from a line break inside one. A detector a reformat
 * defeats is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and it defeated the exact
 * witness the PR was written for.
 *
 * So the walk looks THROUGH whitespace in both directions to the real
 * delimiter, which is the same question it was always asking. It keeps the
 * ordinary multi-line fixture, because looking back through a newline from
 * a literal that starts a line lands on the `(` or `,` that really opened
 * it.
 *
 * ## The LEADING half has no witness, and that is said rather than implied
 *
 * The trailing half is the escape above, executed. The leading half —
 * `x +\n  "…"`, where a literal opening a line read as unconsumed — is
 * symmetry, and no harmful instance of it exists that I could write: for it
 * to matter the literal must be scratch AND carry a protected artifact AND
 * be the right operand of a concatenation, and a scratch absolute path is
 * not a suffix of anything. It is kept because the two halves ask one
 * question and an asymmetric rule invites the next reader to restore the
 * half that looks arbitrary. Measured cost over 131,942 real commands:
 * 0 newly blocked, 0 newly allowed, and the exemption population does not
 * move. `bodyTargets` reporting it as a fragment is asserted in the tests;
 * no verdict claim is made for it, because none was earned.
 */
function standsAlone(body: string, start: number, end: number): boolean {
  let a = start - 1;
  while (a >= 0 && WHITESPACE.has(body[a])) a--;
  if (a >= 0 && !ARG_OPENS.has(body[a])) return false;

  let b = end + 1;
  for (;;) {
    while (b < body.length && WHITESPACE.has(body[b])) b++;
    if (b >= body.length) return true;
    const c = body[b];
    if (GROUP_CLOSES.has(c)) {
      b++;
      continue;
    }
    return ARG_CLOSES.has(c);
  }
}

/**
 * Can every write this body could make to a protected artifact be shown to
 * land in a scratch tree?
 *
 * Five ways to answer no, and all five are the absence of evidence rather
 * than evidence of harm: the body cannot be read, a carrying literal is
 * consumed by an expression, the body names a live tree, the body names a
 * path the reader cannot PLACE, or no literal carries the artifact at all.
 * The exemption's job is to say YES.
 *
 * With five refusals stacked, the failure that costs us is no longer a
 * bypass — it is an exemption that silently never applies again, and every
 * refusal row stays green through exactly that. So the CONTROL rows are the
 * load-bearing half of the suite, and the corpus reading that matters most
 * is `exempt > 0`, not `newly blocked == 0`.
 *
 * ## Why the live-tree reading is a separate question (#1371)
 *
 * The last line is `every` over `targets`, and `targets` only ever receives
 * literals that matched `ALL_PROTECTED`. So the quantifier ranges over a set
 * the command's author chooses the membership of, and the two readings come
 * apart on a body that writes a protected artifact into scratch AND touches
 * a live tree under a name no list has:
 *
 *     shutil.copy('/tmp/fix/workflow-state.json', '$HOME/.rungate/run')
 *
 * Every member of `targets` is scratch, so `every` says yes; the copy lands
 * in the run store. `main` refused this, this module allowed it until
 * #1371, and 50,189 real commands could not see it — an honest caller does
 * not write it, which is exactly who it is worth something to.
 *
 * `protectedLiterals` is the reading that does not go through a name list,
 * so it cannot be walked around by choosing a basename. The alternative on
 * the table was a second whole-body gate ANDed with this one, and it was
 * refused: two deciders answering one question are behaviourally one, no
 * test can tell them apart, and the next reader deletes the live half —
 * `.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape.
 */
function bodyTargetsAreScratch(body: string): boolean {
  const { targets, fragments, protectedLiterals, unplaceable, unreadable } = bodyTargets(body);
  if (unreadable || fragments.length > 0) return false;
  if (protectedLiterals.length > 0 || unplaceable.length > 0) return false;
  if (targets.length === 0) return false;
  return targets.every(isScratchPath);
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

  // #1240: a program handed to an interpreter on stdin. `stripHeredocs`
  // deletes the body before every arm below, and arm 3a only reads a body
  // back when the segment also carries `-c`/`-e` — which `bash <<'EOF'` does
  // not. The result was that the guard decided on the single word `bash`
  // while the program underneath wrote whatever it liked. Each program is
  // re-entered as a command in its own right, and recomputes its own
  // exemption: an `ln` in the body is the body's business.
  // A SHELL body is read as shell; anything else gets the treatment arm 3
  // gives a `-c` body it cannot parse — a declared write verb near the name
  // of a protected artifact. Reading a Python body as shell finds nothing,
  // which is how `python3 <<'PY'` stayed allowed after the shell spellings
  // were closed.
  for (const { shell, program } of interpreterPrograms(cmd)) {
    if (shell) {
      const inner = decideBashWrite(program, depth + 1, exempt && !exemptionIsVoid(program));
      if (inner.blocked) return inner;
      continue;
    }
    // #1277: the same target question as arm 3 below. A stdin program is
    // the arm 3 body reached by another route, and it had NO body gate at
    // all — so the `.replace` spelling #1276 closed for `-e` was still open
    // here, in a heredoc, for as long as the stopgap existed.
    const pf = absoluteNamesOutsideScratch(program, exempt && bodyTargetsAreScratch(program)).find(p =>
      writesNear(program, p),
    );
    if (pf) {
      return {
        blocked: true,
        reason:
          `Bash command runs an interpreter or a mutating \`find\` naming "${pf}". ` +
          `What it writes cannot be read off the command line, so it is refused.`,
      };
    }
  }

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
    const isInterpreter = isInterpreterWord(word) && /\s-[a-z]*[ce]\b/.test(code);
    const isMutatingFind = word === 'find' && FIND_MUTATING.test(code);

    // 3a. A shell `-c` body is shell. Read it as shell rather than scanning
    //     it for Node and Python idioms it will never contain (#1176).
    if (isInterpreter && isShellWord(word)) {
      const body = shellBody(seg);
      if (body) {
        const inner = decideBashWrite(body, depth + 1, exempt);
        if (inner.blocked) return inner;
      }
    }

    if (isInterpreter || isMutatingFind) {
      // #1277: the exemption asks whether the body's write TARGET can be
      // shown to be scratch — see `bodyTargets`. It replaces #1276's
      // all-absolute-literals stopgap, which this closes the class of.
      //
      // Two cases keep the plain `exempt`, because their destinations are
      // SHELL WORDS and not source literals, so `namesOutsideScratch`
      // already asks the target question of them directly: a mutating
      // `find`, whose operands are on the command line, and a shell `-c`
      // body, which arm 3a re-enters as shell. Handing either to a reader of
      // string literals would refuse them for having none.
      const bodyExempt =
        isMutatingFind || isShellWord(word) ? exempt : exempt && bodyTargetsAreScratch(programBody(seg));
      const candidates = namesOutsideScratch(bare, ALL_PROTECTED, bodyExempt);
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
