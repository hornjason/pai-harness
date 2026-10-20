import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { $ } from "bun";

export interface UploadResult {
  uploaded: string[];
  failed: string[];
  markdownLinks: string[];
}

/**
 * Creates one gist and returns whatever the command printed.
 *
 * The return is deliberately the RAW stdout rather than a parsed URL: the
 * caller's job is to decide whether what came back is a gist URL at all, and
 * a seam that pre-validates would hide the case where it is not.
 */
export type GistCreator = (filePath: string) => Promise<string>;

/**
 * The ONE place this module reaches the network (#806).
 *
 * It is a seam because there was none, and the cost of there being none is
 * measured rather than argued: three cases in
 * `test/screenshot-upload.test.ts` handed a real file to the function below,
 * so every `bun test` run published four PUBLIC gists to whoever ran it.
 * 3,667 of them existed on the account when this was found, every gist on it,
 * from 2026-09-30 to 2026-10-20 — and the same three cases were the red shard
 * on `main`, timing out at bun's default 5000ms whenever GitHub was slow.
 *
 * A test must never need the network to find out what this function does with
 * what the network says. One exported binding, so a test overrides it by
 * passing it in and nothing has to mutate `PATH`, the environment, or the
 * module.
 */
export const createPublicGist: GistCreator = async (filePath: string) =>
  await $`gh gist create --public ${filePath}`.text();

export interface UploadOpts {
  /**
   * Used instead of `createPublicGist`. Omitted in production; supplied by
   * every test, which is what keeps the suite off the network.
   */
  createGist?: GistCreator;
}

/**
 * Uploads screenshot files to GitHub via gists and returns markdown image links.
 *
 * Uses `gh gist create` to upload each screenshot file, then converts the gist URL
 * to a raw content URL suitable for markdown embedding.
 *
 * @param issue - GitHub issue number (for future use in direct issue attachments)
 * @param repo - Repository in owner/repo format
 * @param screenshotPaths - Array of absolute paths to screenshot files
 * @param opts - `createGist` overrides the network seam; omit it in production
 * @returns UploadResult with uploaded files, failed files, and markdown links
 */
export async function uploadScreenshotsToIssue(
  issue: number,
  repo: string,
  screenshotPaths: string[],
  opts?: UploadOpts,
): Promise<UploadResult> {
  const createGist = opts?.createGist ?? createPublicGist;

  const result: UploadResult = {
    uploaded: [],
    failed: [],
    markdownLinks: [],
  };

  if (screenshotPaths.length === 0) {
    return result;
  }

  for (const filePath of screenshotPaths) {
    // Check if file exists
    if (!existsSync(filePath)) {
      result.failed.push(filePath);
      continue;
    }

    try {
      // Upload to GitHub gist
      // gh gist create returns the gist URL on stdout
      const gistResult = await createGist(filePath);
      const gistUrl = gistResult.trim();

      if (!gistUrl || !gistUrl.startsWith("https://gist.github.com/")) {
        result.failed.push(filePath);
        continue;
      }

      // Convert gist URL to raw content URL
      // https://gist.github.com/user/abc123 → https://gist.githubusercontent.com/user/abc123/raw/filename.png
      const gistId = gistUrl.split("/").pop();
      const filename = basename(filePath);
      const rawUrl = `https://gist.githubusercontent.com/${repo.split("/")[0]}/${gistId}/raw/${filename}`;

      // Create markdown image link
      const markdownLink = `![${filename}](${rawUrl})`;

      result.uploaded.push(filePath);
      result.markdownLinks.push(markdownLink);
    } catch (error) {
      result.failed.push(filePath);
      console.error(`Failed to upload ${filePath}:`, error);
    }
  }

  return result;
}
