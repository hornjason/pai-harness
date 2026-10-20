import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { $ } from "bun";

export interface UploadResult {
  uploaded: string[];
  failed: string[];
  markdownLinks: string[];
}

/**
 * The one route to the network (#805).
 *
 * Takes an absolute path, returns whatever `gh gist create` printed. It is a
 * parameter rather than a module-scope call because a test cannot observe
 * this upload without performing it — and performing it published 3,667
 * public gists to the account between 2026-09-30 and 2026-10-20, four per
 * full-suite run, while CI read the same call hanging to its 5000ms budget
 * as a flaky test.
 *
 * Nothing here interprets the reply. Deciding whether a string is a usable
 * gist URL stays in `uploadScreenshotsToIssue` below, so an injected runner
 * cannot wave a bad reply through — that is what the #805 negative controls
 * in `test/screenshot-upload.test.ts` drive.
 */
export type GistRunner = (filePath: string) => Promise<string>;

const realGist: GistRunner = async filePath =>
  await $`gh gist create --public ${filePath}`.text();

/**
 * Uploads screenshot files to GitHub via gists and returns markdown image links.
 *
 * Uses `gh gist create` to upload each screenshot file, then converts the gist URL
 * to a raw content URL suitable for markdown embedding.
 *
 * @param issue - GitHub issue number (for future use in direct issue attachments)
 * @param repo - Repository in owner/repo format
 * @param screenshotPaths - Array of absolute paths to screenshot files
 * @param run - how a single file is uploaded; the real `gh gist create` by
 *   default, injected by tests so the suite makes no outbound write (#805)
 * @returns UploadResult with uploaded files, failed files, and markdown links
 */
export async function uploadScreenshotsToIssue(
  issue: number,
  repo: string,
  screenshotPaths: string[],
  run: GistRunner = realGist,
): Promise<UploadResult> {
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
      const gistResult = await run(filePath);
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
