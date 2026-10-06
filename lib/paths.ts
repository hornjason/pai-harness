import { dirname, join, resolve } from "path";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

export function harnessRoot(): string {
  if (process.env.HARNESS_ROOT) return process.env.HARNESS_ROOT;
  const repoRoot = resolve(import.meta.dir, "..");
  if (existsSync(join(repoRoot, "HARNESS.md"))) return repoRoot;
  return join(process.env.HOME || "", ".claude");
}

export function paiRoot(): string {
  return process.env.PAI_ROOT || join(process.env.HOME || "", ".claude");
}

export function workDir(slug: string): string {
  if (slug.includes('..') || slug.startsWith('/')) throw new Error(`Invalid slug: ${slug}`);
  const base = process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate");
  return join(base, slug);
}

export function gateSaltPath(): string {
  return join(harnessRoot(), "gates", ".gate-salt");
}

/**
 * Return the gate salt path, minting the salt if it does not exist yet.
 *
 * The salt is gitignored, so a fresh checkout has none. Creation used to live
 * inline in `generateHmac` (gates/orchestrator.ts), which made every other
 * reader depend on that one function having run first: `gates/adversarial.test.ts`
 * read the salt directly and threw ENOENT unless `gates/orchestrator.test.ts`
 * happened to execute earlier in the same run. Eight tests were passing on
 * readdir order, which is not alphabetical on ext4 — they would have flipped
 * red on an unrelated commit, and the diff would have explained nothing.
 *
 * Deliberately NOT used by `gates/witness.ts`: verification must fail when the
 * salt is missing rather than quietly mint a new one and validate against it.
 */
export function ensureGateSalt(): string {
  const path = gateSaltPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    // mode at creation: writeFileSync-then-chmod leaves the salt world-readable
    // for a moment, and a readable salt is a forgeable gate witness.
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  // Re-assert the mode even when the file already existed: a salt readable by
  // other users is a forgeable gate witness.
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  return path;
}
