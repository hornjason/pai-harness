import { createHash, timingSafeEqual } from "crypto";

const SHELL_METACHARACTERS = /[;&|$`\n\r"'\\(){}[\]<>!~*?#]/;
const PATH_TRAVERSAL = /\.\.($|[/\\])/;
const NULL_BYTE = /\x00/;

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
    if (
      SHELL_METACHARACTERS.test(p) ||
      PATH_TRAVERSAL.test(p) ||
      NULL_BYTE.test(p) ||
      p.startsWith("/") ||
      p.length > 500
    ) {
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
