import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { $ } from "bun";

export interface UploadResult {
  uploaded: string[];
  failed: string[];
  markdownLinks: string[];
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
 * @returns UploadResult with uploaded files, failed files, and markdown links
 */
export async function uploadScreenshotsToIssue(
  issue: number,
  repo: string,
  screenshotPaths: string[],
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
      const gistResult = await $`gh gist create --public ${filePath}`.text();
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
