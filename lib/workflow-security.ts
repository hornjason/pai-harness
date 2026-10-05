import { createHash, timingSafeEqual } from "crypto";

const SHELL_METACHARACTERS = /[;&|$`\n\r"'\\(){}[\]<>!~*?#]/;
const PATH_TRAVERSAL = /\.\.[/\\]/;
const NULL_BYTE = /\x00/;

export function buildSafeGitAdd(filesChanged: string[]): string {
  const validated = validateFilePaths(filesChanged);
  if (validated.rejected.length > 0) {
    throw new Error(
      `Rejected unsafe file paths: ${validated.rejected.join(", ")}`,
    );
  }
  if (validated.valid.length === 0) return "git add .";
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
  return { safe: true };
}

export function buildSafeSSHCommand(
  host: string,
  command: string,
): string[] {
  if (SHELL_METACHARACTERS.test(host)) {
    throw new Error(`SSH host contains shell metacharacters: ${host}`);
  }
  return [
    "ssh",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=no",
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
