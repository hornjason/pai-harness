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

// Declared beside its only reader, matching `lib/gate-result-protection.ts`.
import { statSync } from 'fs';

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
export function decideBashWrite(cmd: string, depth = 0): BashWriteDecision {
  if (!cmd) return ALLOW;
  // A shell body can contain a shell body. Bounded so a crafted nest costs a
  // fixed amount of work rather than the session.
  if (depth > 3) return ALLOW;

  for (const seg of segments(cmd)) {
    const bare = dequote(seg); // TARGET view: contents kept
    const code = stripQuoted(seg); // VERB view: quoted spans gone
    const word = commandWord(seg);

    // 1. Shell redirection and copying verbs. Never exempted by anything:
    //    this is the arm the old allowlist sat above, which is #1120.
    // The whole command is passed so the directory test can see a `mkdir`
    // in an EARLIER segment (#1196 R2). Everything else is per-segment.
    for (const target of writeTargets(seg, cmd)) {
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

    // 3a. A shell `-c` body is shell. Read it as shell rather than scanning
    //     it for Node and Python idioms it will never contain (#1176).
    if (isInterpreter && SHELLS.test(word)) {
      const body = shellBody(seg);
      if (body) {
        const inner = decideBashWrite(body, depth + 1);
        if (inner.blocked) return inner;
      }
    }

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
