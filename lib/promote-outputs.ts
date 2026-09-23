import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join, basename } from "path";

interface PromoteResult {
  promoted: string[];
  skipped: string[];
  archived: string[];
  errors: string[];
}

export function promoteOutputs(projectRoot: string): PromoteResult {
  const home = process.env.HOME || "";
  const rungatDir = join(home, ".rungate");
  const result: PromoteResult = { promoted: [], skipped: [], archived: [], errors: [] };

  if (!existsSync(rungatDir)) return result;

  const archiveDir = join(rungatDir, "_archived");
  const maxAgeDays = 7;

  const slugDirs = readdirSync(rungatDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("_"))
    .map(d => join(rungatDir, d.name));

  for (const dir of slugDirs) {
    const slug = basename(dir);

    // Council synthesis → docs/council/
    const councilJson = join(dir, "council-synthesis.json");
    if (existsSync(councilJson)) {
      try {
        const data = JSON.parse(readFileSync(councilJson, "utf-8"));
        const topic = data.topic || slug;
        const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
        const date = data.capturedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10);
        const destDir = join(projectRoot, "docs", "council");
        const destFile = join(destDir, `${date}-${topicSlug}.md`);

        if (!existsSync(destFile)) {
          mkdirSync(destDir, { recursive: true });
          const md = buildCouncilMarkdown(data, date, topic);
          writeFileSync(destFile, md);
          result.promoted.push(`council: ${basename(destFile)}`);
        } else {
          result.skipped.push(`council: ${basename(destFile)} (exists)`);
        }
      } catch (e: any) {
        result.errors.push(`council ${slug}: ${e.message}`);
      }
    }

    // Research output → docs/research/
    const researchJson = join(dir, "research-output.json");
    if (existsSync(researchJson)) {
      try {
        const data = JSON.parse(readFileSync(researchJson, "utf-8"));
        const topic = data.topic || slug;
        const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
        const destDir = join(projectRoot, "docs", "research");
        const destFile = join(destDir, `${topicSlug}.md`);

        if (!existsSync(destFile)) {
          mkdirSync(destDir, { recursive: true });
          const md = buildResearchMarkdown(data, topic);
          writeFileSync(destFile, md);
          result.promoted.push(`research: ${basename(destFile)}`);
        } else {
          result.skipped.push(`research: ${basename(destFile)} (exists)`);
        }
      } catch (e: any) {
        result.errors.push(`research ${slug}: ${e.message}`);
      }
    }
  }

  // Archive stale working dirs (older than maxAgeDays, no active workflow-state)
  for (const dir of slugDirs) {
    const slug = basename(dir);
    try {
      const stat = statSync(dir);
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays < maxAgeDays) continue;

      const wsPath = join(dir, "workflow-state.json");
      if (existsSync(wsPath)) {
        try {
          const ws = JSON.parse(readFileSync(wsPath, "utf-8"));
          if (ws.phase && !["DONE", "SHIPPED", "PROVEN"].includes(ws.phase)) continue;
        } catch { /* unparseable — safe to archive */ }
      }

      mkdirSync(archiveDir, { recursive: true });
      renameSync(dir, join(archiveDir, slug));
      result.archived.push(slug);
    } catch (e: any) {
      result.errors.push(`archive ${slug}: ${e.message}`);
    }
  }

  return result;
}

function buildCouncilMarkdown(data: any, date: string, topic: string): string {
  const lines = [
    "---",
    "doc-type: council",
    "status: accepted",
    `created: ${date}`,
    `topic: ${topic}`,
    "---",
    "",
    `# Council: ${topic}`,
    "",
  ];

  if (data.convergencePoints?.length) {
    lines.push("## Convergence", "");
    for (const p of data.convergencePoints) lines.push(`- ${p}`);
    lines.push("");
  }
  if (data.disagreements?.length) {
    lines.push("## Disagreements", "");
    for (const d of data.disagreements) lines.push(`- ${d}`);
    lines.push("");
  }
  if (data.recommendation) {
    lines.push("## Recommendation", "", data.recommendation, "");
  }
  if (data.decisions?.length) {
    lines.push("## Decisions", "");
    for (const d of data.decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function buildResearchMarkdown(data: any, topic: string): string {
  const lines = [
    "---",
    "doc-type: research",
    "status: active",
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `governs: ${topic}`,
    "---",
    "",
    `# ${topic}`,
    "",
  ];

  if (data.findings) lines.push(data.findings, "");
  if (data.summary) lines.push(data.summary, "");
  if (typeof data === "string") lines.push(data, "");

  return lines.join("\n") + "\n";
}
