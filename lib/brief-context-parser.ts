const CONTEXT_HEADING = /^##\s+Context\b/;
const NEXT_HEADING = /^##\s+/;
const BOLD_PATH = /\*\*([^*]+)\*\*/;
const SECTION_MARKER = /\s*§.*$/;
const FILE_PATH_PATTERN = /^[\w][\w./-]*\.\w+$/;

export function parseContextPaths(markdown: string): string[] {
  const lines = markdown.split("\n");
  let inContext = false;
  const paths: string[] = [];

  for (const line of lines) {
    if (!inContext) {
      if (CONTEXT_HEADING.test(line)) inContext = true;
      continue;
    }
    if (NEXT_HEADING.test(line) && !CONTEXT_HEADING.test(line)) break;

    const match = BOLD_PATH.exec(line);
    if (!match) continue;

    const raw = match[1].replace(SECTION_MARKER, "").trim();
    if (FILE_PATH_PATTERN.test(raw)) paths.push(raw);
  }

  return paths;
}

export function buildReadSteps(briefPath: string, contextPaths: string[]): string {
  const steps = [`1. Read \`${briefPath}\``];
  for (let i = 0; i < contextPaths.length; i++) {
    steps.push(`${i + 2}. Read \`${contextPaths[i]}\``);
  }
  return steps.join("\n");
}
