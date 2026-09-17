#!/usr/bin/env bash
# context-audit.sh — Pipeline transparency for context injection
# Usage: bash ~/.claude/scripts/context-audit.sh
#        or via skill: /context-audit
# Rewritten for #147: surfaces filter stages, domain balance, precision trend

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
STATE_DIR="${CLAUDE_DIR}/MEMORY/STATE"
AGENTGRIT_STATE="${HOME}/.agentgrit/state"
SESSION_CTX="${STATE_DIR}/session-context.json"
AGENTGRIT_CTX="${AGENTGRIT_STATE}/session-context.json"
RULE_DOMAINS="${CLAUDE_DIR}/MEMORY/LEARNING/STATE/rule-domains.json"
RECALL_SCORES="${CLAUDE_DIR}/MEMORY/LEARNING/STATE/recall-scores.json"
RULE_STATS="${AGENTGRIT_STATE}/rule-stats.json"

echo ""
echo "════════════════════════════════════════════════"
echo "  CONTEXT AUDIT"
echo "════════════════════════════════════════════════"
echo ""

# ── 1. SESSION ──
if [[ -f "$SESSION_CTX" ]]; then
  python3 -c "
import json
from datetime import datetime, timezone

with open('$SESSION_CTX') as f:
    ctx = json.load(f)

ts = ctx.get('timestamp','')
domains = ctx.get('domains', [])
source = ctx.get('domain_source', '?')
signals = ctx.get('detection_signals', [])

try:
    created = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    age_h = (datetime.now(timezone.utc) - created).total_seconds() / 3600
    expired = age_h > 24
except:
    age_h = 0
    expired = False

print('-- SESSION --')
print(f'  Created:    {ts[:19]}')
print(f'  Age:        {age_h:.1f}h {\"!! EXPIRED\" if expired else \"\"}')
print(f'  Domains:    {len(domains)} -- {\", \".join(domains)}')
print(f'  Source:     {source}')
print(f'  Signals:    {\", \".join(signals) if signals else \"none\"}')
print()
"
else
  echo "-- SESSION --"
  echo "  No session-context.json found at ${SESSION_CTX}"
  echo ""
fi

# ── 2. PIPELINE ──
if [[ -f "$SESSION_CTX" ]]; then
  python3 -c "
import json

with open('$SESSION_CTX') as f:
    ctx = json.load(f)

pipeline = ctx.get('pipeline', {})
if not pipeline:
    print('-- PIPELINE --')
    print('  No pipeline metadata (session predates #147)')
    print()
else:
    raw_clusters = pipeline.get('rawCandidateCount', 0)
    raw_ag = pipeline.get('rawAgentgritCount', 0)
    suppressed = pipeline.get('suppressed', [])
    diversity = pipeline.get('diversityDropped', [])
    bm25 = pipeline.get('bm25Stats', {})
    final_rules = ctx.get('loaded_rule_ids', [])
    bm25_total = bm25.get('total', 0)
    bm25_passed = bm25.get('passed', 0)

    sup_count = len(suppressed)
    div_count = len(diversity)

    print('-- PIPELINE --')
    print(f'  Graph clusters:       {raw_clusters} raw')
    print(f'  AgentGrit rules:      {raw_ag} raw')
    print(f'  Always-on suppressed: -{sup_count:>3} (from both sources)')
    print(f'  Diversity enforced:   -{div_count:>3} (cap {3}/domain per-source)')
    print(f'  BM25 (learned):       {bm25_total} total -> {bm25_passed} passed')
    print(f'  Final injected:       {len(final_rules)}')
    print(f'  Sources:              clusters + agentgrit + learned')
    print()

    if suppressed:
        print('  Suppressed IDs:')
        for rid in suppressed:
            print(f'    - {rid}')
        print()

    if diversity:
        print('  Diversity-dropped IDs:')
        for rid in diversity:
            print(f'    - {rid}')
        print()
"
fi

# ── 3. DOMAIN BALANCE ──
if [[ -f "$SESSION_CTX" ]]; then
  python3 -c "
import json

with open('$SESSION_CTX') as f:
    ctx = json.load(f)

pipeline = ctx.get('pipeline', {})
dist = pipeline.get('domainDistribution', {})
domains = ctx.get('domains', [])

if not dist:
    # Fall back: compute from loaded_rule_ids + rule-domains.json
    try:
        with open('$RULE_DOMAINS') as f:
            rd = json.load(f)
        rules_meta = rd.get('rules', {})
        dist = {}
        for rid in ctx.get('loaded_rule_ids', []):
            d = rules_meta.get(rid, {}).get('domains', ['unknown'])[0]
            dist[d] = dist.get(d, 0) + 1
    except:
        pass

if dist:
    print('-- DOMAIN BALANCE --')
    max_count = max(dist.values()) if dist else 0
    cap = 3  # MAX_PER_DOMAIN from GraphContext.hook.ts
    sorted_domains = sorted(dist.items(), key=lambda x: -x[1])
    for domain, count in sorted_domains:
        bar = '#' * count
        over = ' !! >3 combined (cap is per-source)' if count > cap else ''
        match = ' (detected)' if domain in domains else ''
        print(f'  {domain:<20} {bar:<15} {count}{over}{match}')
    print()
"
fi

# ── 4. INJECTED RULES (with relevance) ──
if [[ -f "$SESSION_CTX" ]]; then
  python3 -c "
import json, os

with open('$SESSION_CTX') as f:
    ctx = json.load(f)

# Load rule domains for relevance check
rule_domains = {}
try:
    with open('$RULE_DOMAINS') as f:
        rd = json.load(f)
    rule_domains = rd.get('rules', {})
except:
    pass

# Load rule stats for quality metrics
stats_map = {}
try:
    with open('$RULE_STATS') as f:
        stats = json.load(f)
    stats_map = {s['ruleId']: s for s in stats}
except:
    pass

session_domains = set(ctx.get('domains', []))
rules = ctx.get('loaded_rule_ids', [])

print('-- INJECTED RULES --')
print(f'  {\"#\":<3} {\"Rule\":<55} {\"Avg\":>5} {\"Sess\":>4}  Relevance')
print(f'  {\"-\"*3} {\"-\"*55} {\"-\"*5} {\"-\"*4}  {\"-\"*10}')

match_count = 0
mismatch_count = 0

for i, rid in enumerate(rules, 1):
    stat = stats_map.get(rid, {})
    avg = stat.get('avgCorrelatedRating', 0)
    sessions = len(stat.get('sessionRatings', []))

    name = rid[:55]

    # Relevance: check if rule's domains overlap with session domains
    rule_meta = rule_domains.get(rid, {})
    rule_doms = set(rule_meta.get('domains', []))
    if rule_doms & session_domains:
        relevance = 'MATCH'
        match_count += 1
    elif not rule_doms:
        relevance = '? no domain'
        mismatch_count += 1
    else:
        relevance = 'MISMATCH'
        mismatch_count += 1

    print(f'  {i:<3} {name:<55} {avg:>5.1f} {sessions:>4}  {relevance}')

print()
print(f'  Relevance: {match_count} MATCH, {mismatch_count} MISMATCH/unknown')
print()
"
fi

# ── 5. PRECISION TREND ──
if [[ -f "$RECALL_SCORES" ]]; then
  python3 -c "
import json

with open('$RECALL_SCORES') as f:
    scores = json.load(f)

p5 = scores.get('mean_precision5', 0)
target = 0.64
r5 = scores.get('mean_recall5', 0)
r10 = scores.get('mean_recall10', 0)
mrr = scores.get('mean_mrr', 0)
sessions = scores.get('sessions_evaluated', 0)
last_int = scores.get('last_intervention', 'unknown')[:10]

delta = p5 - target
direction = '+' if delta >= 0 else ''

print('-- PRECISION TREND --')
print(f'  precision@5:       {p5:.3f}  (target: {target}, delta: {direction}{delta:.3f})')
print(f'  recall@5:          {r5:.3f}')
print(f'  recall@10:         {r10:.3f}')
print(f'  MRR:               {mrr:.3f}')
print(f'  Sessions evaluated:{sessions}')
print(f'  Last intervention: {last_int}')
print()
"
else
  echo "-- PRECISION TREND --"
  echo "  No recall-scores.json found"
  echo ""
fi

# ── 6. SUPPRESSED RULES ──
python3 -c "
import json

# Read suppressed list from pipeline metadata if available
suppressed_ids = []
try:
    with open('$SESSION_CTX') as f:
        ctx = json.load(f)
    suppressed_ids = ctx.get('pipeline', {}).get('suppressed', [])
except:
    pass

# Also show the static ALWAYS_ON_SUPPRESSED list for reference
always_on = [
    'feedback_capture_decisions_immediately',
    'feedback_always_update_docs',
    'feedback_verify_before_answering',
    'feedback_iterative_quality_loop',
    'success_real-data-honest-gaps',
    'feedback_exhaustive-search-before-claiming-nonexistence',
    'feedback_read-background-task-output',
    'feedback_avoid-unnecessary-doc-regeneration',
    'feedback_proactive-spot-check-patterns',
    'success_technical-explanation-direct-and-structu',
]

# Load rule names from knowledge graph if available
rule_names = {}
try:
    with open('${AGENTGRIT_STATE}/knowledge-graph.json') as f:
        graph = json.load(f)
    for node in graph.get('nodes', []):
        rule_names[node.get('id', '')] = node.get('text', '')[:60]
except:
    pass

print('-- SUPPRESSED RULES --')
print(f'  Always-on suppression list ({len(always_on)} rules):')
for rid in always_on:
    hit = ' (was in candidates)' if rid in suppressed_ids else ''
    name = rule_names.get(rid, '')
    label = f' -- {name}' if name else ''
    print(f'    {rid}{label}{hit}')
print()
"

# ── RECENT SESSIONS ──
if [[ -f "${AGENTGRIT_STATE}/session-context-history.jsonl" ]]; then
  echo "-- RECENT SESSIONS --"
  tail -5 "${AGENTGRIT_STATE}/session-context-history.jsonl" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        ts = d.get('timestamp','')[:16]
        rules = d.get('rulesInjectedCount', '?')
        kb = d.get('rulesInjectedKB', '?')
        domains = len(d.get('domains', []))
        print(f'  {ts} | {rules} rules | {kb} KB | {domains} domains')
    except: pass
"
  echo ""
fi

echo "════════════════════════════════════════════════"
