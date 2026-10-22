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
 */

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
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
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
  return s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' ');
}

/** Remove quote characters, keep the contents. Use when looking for a TARGET. */
export function dequote(s: string): string {
  return s.replace(/['"]/g, '');
}

/** Wrappers that delegate to the real command word rather than being one. */
const WRAPPERS = /^(?:sudo|env|nohup|time|command|xargs)$/;

/**
 * The command word of a segment — the first token that is not a wrapper, an
 * assignment or an option. Read off `stripQuoted`, because a quoted token is
 * an argument.
 */
export function commandWord(segment: string): string {
  for (const raw of stripQuoted(segment).trim().split(/\s+/)) {
    const tok = raw.replace(/^.*\//, ''); // `/usr/bin/python3` -> `python3`
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
export function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  const code = stripQuoted(segment);
  // `> file` and `>> file`, but not `2>` or `&>` — those are stderr plumbing.
  for (const m of code.matchAll(/(?<![2&])\s*>{1,2}\s*(\S+)/g)) {
    if (m[1] && m[1] !== '/dev/null') targets.push(dequote(m[1]));
  }
  // A quoted redirect target survives quote-stripping as nothing at all, so
  // it is recovered separately rather than lost.
  for (const m of segment.matchAll(/(?<![2&])\s*>{1,2}\s*(['"])([^'"]+)\1/g)) targets.push(m[2]);
  const tee = code.match(/\btee\s+(?:-a\s+)?(\S+)/);
  if (tee) targets.push(dequote(tee[1]));
  // `cp`/`mv` take the LAST non-option argument as the destination. Reading
  // the second token instead — which this did until #1120 — mis-parses every
  // invocation carrying a flag: `cp -p src /x/workflow-state.json` read the
  // destination as `src` and never examined the real one.
  //
  // Arguments are DEQUOTED rather than stripped. Stripping them was measured
  // to lose the destination entirely for `cp "a/X.hook.ts" "b/X.hook.ts"`,
  // which is a real hook write that then read as having no target.
  const word = commandWord(segment);
  if (word === 'cp' || word === 'mv' || word === 'install' || word === 'rsync') {
    const args = dequote(segment)
      .trim()
      .split(/\s+/)
      .slice(1)
      .filter(a => !a.startsWith('-'));
    if (args.length >= 2) targets.push(args[args.length - 1]);
  }
  return targets;
}

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
];

/** Interpreters whose argument is a program this module cannot read. */
const INTERPRETERS = /^(?:python[23]?|perl|ruby|node|bun|deno|osascript|sh|bash|zsh|php)$/;

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

/** `find` actions that run or delete rather than print. */
const FIND_MUTATING = /\s-(?:delete|exec|execdir|ok|okdir)\b/;

/** Does this text name a protected artifact? Pass a DEQUOTED segment. */
function names(text: string, list: string[]): string | null {
  for (const p of list) if (text.includes(p)) return p;
  return null;
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
 */
export function decideBashWrite(cmd: string): BashWriteDecision {
  if (!cmd) return ALLOW;

  for (const seg of segments(cmd)) {
    const bare = dequote(seg); // TARGET view: contents kept
    const code = stripQuoted(seg); // VERB view: quoted spans gone
    const word = commandWord(seg);

    // 1. Shell redirection and copying verbs. Never exempted by anything:
    //    this is the arm the old allowlist sat above, which is #1120.
    for (const target of writeTargets(seg)) {
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
    if (IN_PLACE.some(p => p.test(code))) {
      const pf = names(argumentsOf(seg).join(' '), ALL_PROTECTED);
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
    if (isInterpreter || isMutatingFind) {
      const pf = isMutatingFind
        ? names(bare, ALL_PROTECTED)
        : (ALL_PROTECTED.find(p => bare.includes(p) && writesNear(bare, p)) ?? null);
      if (pf) {
        return {
          blocked: true,
          reason:
            `Bash command runs an interpreter or a mutating \`find\` naming "${pf}". ` +
            `What it writes cannot be read off the command line, so it is refused.`,
        };
      }
    }

    // 4. Permission changes on a hook file. The COMMAND WORD must be the
    //    verb — not merely a `chmod` somewhere in the string, which is what
    //    refused four read-only commands. The target is read off `bare`, so
    //    quoting the path does not hide it.
    if ((word === 'chmod' || word === 'chflags') && names(bare, PROTECTED_HOOKS)) {
      return { blocked: true, reason: 'Permission change on hook file blocked. Hook integrity is protected.' };
    }
  }

  // 5. The gate salt in the Keychain. Exempted by nothing — unlike `chmod`,
  //    which turns up innocently in docs and greps, `pai-gate-salt` beside
  //    `security` has no benign INVOCATION. It has a benign MENTION though,
  //    and two real commands hit it: issue comments quoting the very command
  //    they were proposing to guard. So it reads the code, not the prose.
  const codeOnly = stripQuoted(cmd);
  if (codeOnly.includes('pai-gate-salt') && codeOnly.includes('security')) {
    return { blocked: true, reason: 'Access to gate salt Keychain entry blocked.' };
  }

  return ALLOW;
}
