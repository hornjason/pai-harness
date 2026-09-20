---
doc-type: research
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: split-spec command design — what tools exist, what's novel, build vs buy
---

# Document Splitting Tools Research

## Finding: No tool does semantic markdown splitting with frontmatter generation.

Two independent researchers (Perplexity + Codex) confirmed. 20+ tools evaluated.

## Tools Evaluated

| Tool | Category | What it does | Solves our problem? |
|---|---|---|---|
| LangChain MarkdownHeaderTextSplitter | RAG chunking | Splits by heading level | No — mechanical, not semantic |
| LlamaIndex SemanticSplitter | RAG chunking | Embedding-based topic detection | Adjacent — finds topic shifts, outputs chunks not files |
| Unstructured.io | Document processing | Element-level metadata extraction | Adjacent — best metadata, targets RAG pipelines |
| log4brains | ADR management | One-ADR-per-file with YAML frontmatter | Closest — generates frontmatter, enforces single-topic |
| adr-tools | ADR management | One-decision-per-file by convention | Pattern only — structural, no semantic analysis |
| MADR | ADR template | Defines frontmatter fields for ADRs | Template standard — no splitting |
| ctxlint | Agent context | Lints files for size/structure | No — flags problems, doesn't fix them |
| agentsmd | Agent context | Validates AGENTS.md structure | No — no splitting or frontmatter gen |
| RepoRails | Agent context | Directive density scoring | No |
| agnix | Agent context | Quality metadata scoring | No |
| gray-matter | Utility | Parse/write YAML frontmatter | Utility — would use inside our tool |
| Pandoc | Utility | Mechanical splitting by heading | No semantic understanding |

## The Gap

Three steps nobody has chained:
1. Semantic intent detection in markdown
2. Split into standalone files (not vector chunks)
3. Auto-generate `governs:` YAML frontmatter per file

## Key Insight

Heading-based splitting is sufficient for specs. Specs ARE organized by heading (`### Phase 0`, `### Phase 1`). The LLM is needed for writing the governs description, not finding boundaries.

## Implication for RunGate

Build `bunx rungate split-spec` as a novel feature. No competitor solves this.
ADR tools prove one-file-per-topic works at scale. Extending to agent instructions is uncharted.
