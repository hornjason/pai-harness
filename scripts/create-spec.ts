#!/usr/bin/env bun
/**
 * Create a new spec file with required frontmatter including governs.
 *
 * Usage:
 *   bun scripts/create-spec.ts "Title of the spec" "What this spec governs"
 *   bun scripts/create-spec.ts "Title of the spec"  # governs defaults to TODO
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/create-spec.ts \"Title\" [\"governs description\"]");
  process.exit(1);
}

const title = args[0];
const governs = args[1] || "TODO — describe what this spec governs";
const slug = title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const filename = `${slug}-SPEC.md`;
const root = join(import.meta.dir, "..");
const specsDir = join(root, "specs");
const filePath = join(specsDir, filename);

if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });

if (existsSync(filePath)) {
  console.error(`ERROR: ${filename} already exists`);
  process.exit(1);
}

const today = new Date().toISOString().split("T")[0];

const content = `---
doc-type: spec
status: draft
owner: TODO
created: ${today}
updated: ${today}
governs: ${governs}
testable: true
---

# ${title}

## Context

[Why this spec exists and what problem it solves]

## Success Criteria

- [ ] SC-TODO: [first criterion — atomic, verifiable, 8-12 words]
`;

writeFileSync(filePath, content);
console.log(`✅ Created specs/${filename}`);
if (governs.startsWith("TODO")) {
  console.log(`⚠️  governs: is TODO — update it before scaffolding`);
  console.log(`   Tip: describe what this spec governs in one line, e.g.:`);
  console.log(`   governs: API authentication flow — token issuance, refresh, and revocation`);
}
