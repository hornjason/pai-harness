import { join, resolve } from "path";
import { existsSync } from "fs";

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
