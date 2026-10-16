import { createHash, timingSafeEqual } from "crypto";

const SHELL_METACHARACTERS = /[;&|$`\n\r"'\\(){}[\]<>!~*?#]/;
const PATH_TRAVERSAL = /\.\.($|[/\\])/;
const NULL_BYTE = /\x00/;

/**
 * Why a path may not be contributed by an agent, or `null` if it may.
 *
 * ONE table, ONE decider (#400). Before this there were two: a regex set here,
 * checked at staging time, and a segment walk in `workflows/ship.js`'s
 * `escapesWorktree`, checked at collection time. They agreed on traversal and
 * on nothing else, so the audit accepted a reported path carrying a shell
 * metacharacter, a null byte or 500+ characters, declared the run clean, and
 * staging refused it two phases later with a different message.
 *
 * `boundary` separates the two reasons a path can be refused, because they are
 * different things to tell an operator:
 *
 *   true  — the path does not name a location inside the worktree at all.
 *   false — it does, and still cannot be handled safely.
 *
 * "not inside its own worktree" is a wrong sentence to print about
 * `lib/a;rm.ts`, and an operator who reads it goes looking for a path that is
 * not there.
 *
 * The order is the order the reasons are reported in. Absoluteness first
 * because it is the least ambiguous, then the segment walk, then the regexes.
 *
 * The two traversal rules are deliberately both present and deliberately
 * separate. `p.split("/").includes("..")` is the real boundary question; the
 * regex also matches a segment merely ENDING in `..` (`lib/foo..`), which is a
 * legal filename that staging has always refused. Folding it into the boundary
 * rule would label a legal file an escape; dropping it would make the audit
 * permit something staging rejects, which is the whole defect.
 */
const CONTRIBUTABLE_PATH_RULES: ReadonlyArray<
  readonly [rule: string, boundary: boolean, fails: (p: string) => boolean]
> = [
  ["an absolute path", true, (p) => p.startsWith("/")],
  ["a `..` segment", true, (p) => p.split("/").includes("..")],
  ["a segment ending in `..`", false, (p) => PATH_TRAVERSAL.test(p)],
  ["a shell metacharacter", false, (p) => SHELL_METACHARACTERS.test(p)],
  ["a null byte", false, (p) => NULL_BYTE.test(p)],
  ["over 500 characters", false, (p) => p.length > 500],
];

export function pathRefusal(
  p: string,
): { rule: string; boundary: boolean } | null {
  for (const [rule, boundary, fails] of CONTRIBUTABLE_PATH_RULES) {
    if (fails(p)) return { rule, boundary };
  }
  return null;
}

export function buildSafeGitAdd(filesChanged: string[]): string {
  const validated = validateFilePaths(filesChanged);
  if (validated.rejected.length > 0) {
    throw new Error(
      `Rejected unsafe file paths: ${validated.rejected.join(", ")}`,
    );
  }
  if (validated.valid.length === 0) throw new Error("No valid files to stage");
  return `git add ${validated.valid.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ")}`;
}

export function validateFilePaths(
  paths: string[],
): { valid: string[]; rejected: string[] } {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    if (pathRefusal(p)) {
      rejected.push(p);
    } else {
      valid.push(p);
    }
  }
  return { valid, rejected };
}

/**
 * Whether a string is safe to interpolate into a git or `gh` command as a
 * branch name.
 *
 * #136 made branch names flow from the run into commands: the PR head is now
 * `${shipBranch}` rather than something a checkout is asked for at the time.
 * That is the right direction — an agent recovering from a failed push chose
 * `HEAD:main` once — but the value still reaches a shell, and it originates
 * from an agent's reply or from a PR listing, neither of which this process
 * wrote.
 *
 * Git's own rules are looser than this (`git check-ref-format`). The extra
 * strictness is deliberate: every character git allows but this rejects is
 * one that means something to a shell, and no branch this harness creates
 * needs any of them.
 */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (!SAFE_BRANCH.test(name)) return false;
  // Git's own refusals, and the ones that matter here: `..` would let a
  // branch argument climb out of a refspec, and a leading `-` would be read
  // as a flag by git and by gh alike.
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".lock")) return false;
  return true;
}

/**
 * Why a repo slug may not reach a shell command, or null if it may (#533).
 *
 * `ship.js` interpolates `repo` and `issueRepo` UNQUOTED into shell text
 * inside agent prompts — six and eleven sites respectively — and checked only
 * that `repo` was present. One function away, the same file validates a
 * branch name before it reaches a `git push`, and `scripts/github-op.ts` has
 * `--title-from-issue` precisely so an issue title never crosses a shell. So
 * the project had already decided that values reaching a shell get checked
 * first, and this is the one that missed.
 *
 * The shape is `parseOwnerRepo`'s in `lib/github.ts`, which is what the
 * GitHub API layer will accept anyway: exactly two segments of
 * `[A-Za-z0-9._-]`, neither of them `.` or `..`. A slug this refuses would
 * have failed at the API boundary regardless — the difference is that it now
 * fails before a shell has seen it, with a sentence naming the argument.
 *
 * REFUSED, never sanitised. Stripping characters out of a repo slug produces
 * a run filed under a different project, which is the defect #114 already
 * cost this repo once.
 */
const REPO_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function repoSlugRefusal(argName: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${argName} must be a non-empty string of the form "owner/name"; got ${describeArg(value)}`;
  }
  if (value.length > 255) return `${argName} is ${value.length} characters, which is not a repository slug`;
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some(p => !REPO_SLUG_SEGMENT.test(p) || p === "." || p === "..")) {
    return (
      `${argName} must be "owner/name" using only letters, digits, dot, dash and underscore; ` +
      `got ${describeArg(value)} — it is interpolated unquoted into shell commands`
    );
  }
  return null;
}

/**
 * Why a root directory may not reach a shell command, or null if it may.
 *
 * Deliberately NOT `pathRefusal`, and the difference is the first rule in
 * each: that table refuses an absolute path, because it answers "may an agent
 * contribute this file from inside its worktree". This one REQUIRES an
 * absolute path, because it answers "may the run `cd` here". Same word, two
 * questions, opposite answers — folding them together would make one of the
 * two wrong.
 *
 * Whitespace is refused along with the metacharacters, which `pathRefusal`
 * does not do. A space is harmless in a path and fatal in `cd ${ROOT} && …`
 * unquoted, and these values reach seventy-seven such sites. The honest fix
 * is to quote all of them; until then a run on a path with a space in it
 * silently `cd`s somewhere else, and refusing is the reading an operator can
 * act on.
 */
export function rootPathRefusal(argName: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `${argName} must be a non-empty absolute path; got ${describeArg(value)}`;
  }
  if (value.length > 500) return `${argName} is ${value.length} characters, which is not a directory path`;
  if (!value.startsWith("/")) return `${argName} must be an absolute path; got ${describeArg(value)}`;
  if (NULL_BYTE.test(value)) return `${argName} contains a null byte`;
  if (value.split("/").includes("..")) return `${argName} contains a \`..\` segment: ${describeArg(value)}`;
  if (/\s/.test(value)) {
    return (
      `${argName} contains whitespace: ${describeArg(value)} — it is interpolated unquoted into ` +
      `shell commands, so the run would cd somewhere other than where you meant`
    );
  }
  if (SHELL_METACHARACTERS.test(value)) {
    return `${argName} contains a shell metacharacter: ${describeArg(value)} — it is interpolated unquoted into shell commands`;
  }
  return null;
}

/**
 * An argument value, quoted and truncated, for a refusal message.
 *
 * Truncated because the value is attacker-shaped by assumption at the point
 * this runs, and a refusal is printed, logged and pasted into issues.
 */
function describeArg(value: unknown): string {
  if (typeof value !== "string") return value === undefined ? "nothing" : JSON.stringify(value) ?? String(value);
  return JSON.stringify(value.length > 80 ? value.slice(0, 80) + "…" : value);
}

export function resolveEvidencePath(
  basePath: string,
  evidencePath: string,
): string {
  if (NULL_BYTE.test(evidencePath)) {
    throw new Error(`Evidence path contains null byte: ${evidencePath}`);
  }
  if (PATH_TRAVERSAL.test(evidencePath)) {
    throw new Error(`Evidence path contains traversal: ${evidencePath}`);
  }
  if (evidencePath.startsWith("/")) {
    throw new Error(`Evidence path is absolute: ${evidencePath}`);
  }
  const resolved = `${basePath}/${evidencePath}`;
  if (!resolved.startsWith(basePath)) {
    throw new Error(`Evidence path escapes base: ${resolved}`);
  }
  return resolved;
}

export function validateEvidenceCommand(command: string): {
  safe: boolean;
  reason?: string;
} {
  if (NULL_BYTE.test(command)) {
    return { safe: false, reason: "Command contains null byte" };
  }
  const dangerous = [
    /rm\s+-rf/,
    />\s*\/dev/,
    /mkfs/,
    /dd\s+if=/,
    /chmod\s+777/,
    /curl.*\|\s*(bash|sh)/,
  ];
  for (const pattern of dangerous) {
    if (pattern.test(command)) {
      return { safe: false, reason: `Dangerous pattern: ${pattern.source}` };
    }
  }
  // Heuristic denylist — blocks known-dangerous patterns but not a security gate
  // for arbitrary command execution. Evidence commands are controlled by Discovery,
  // not external input, so denylist is defense-in-depth, not the primary control.
  return { safe: true };
}

export function buildSafeSSHCommand(
  host: string,
  command: string,
): string[] {
  if (SHELL_METACHARACTERS.test(host)) {
    throw new Error(`SSH host contains shell metacharacters: ${host}`);
  }
  if (host.startsWith("-")) {
    throw new Error(`SSH host starts with dash (option injection): ${host}`);
  }
  return [
    "ssh",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=no",
    "--",
    host,
    command,
  ];
}

interface ACForHash {
  id: string;
  type: string;
  statement: string;
  specElement?: string;
  threshold?: { op: string; value: unknown };
  evidenceMethod?: { type: string; command?: string };
}

export function computeACHash(
  acs: ACForHash[],
  excludeFields: (keyof ACForHash)[] = [],
): string {
  const normalized = acs
    .map((ac) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(ac)) {
        if (!excludeFields.includes(key as keyof ACForHash)) {
          filtered[key] = value;
        }
      }
      return filtered;
    })
    .sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function verifyACHash(
  acs: ACForHash[],
  expectedHash: string,
  excludeFields: (keyof ACForHash)[] = [],
): boolean {
  const computed = computeACHash(acs, excludeFields);
  const computedBuf = Buffer.from(computed, "utf-8");
  const expectedBuf = Buffer.from(expectedHash, "utf-8");
  if (computedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(computedBuf, expectedBuf);
}
