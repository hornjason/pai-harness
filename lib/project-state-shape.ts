/**
 * Does `project-state.json` have the shape the renderer will read?
 *
 * Found by writing a malformed entry by hand. `scripts/update-project-state.ts`
 * declares `interface Session { date: string; items: string[] }`, and that
 * interface is erased at runtime: the file is `JSON.parse`d into it and
 * nothing checks. An archived session carrying `summary` instead of `items`
 * produced
 *
 *     TypeError: undefined is not an object (evaluating 'session.items.forEach')
 *       at render (scripts/update-project-state.ts:134:15)
 *
 * and nothing else — no path, no index, no statement of what the file should
 * have contained. The renderer runs from a pre-commit hook, where a stack
 * trace with a line number into a script the committer did not open is close
 * to no message at all.
 *
 * This is the mirror of the defect class the rest of this repo keeps finding.
 * A fail-open reports success it did not earn; this reports a failure nobody
 * can act on. Both end with a reader who cannot tell what happened, and the
 * second is the one that trains people to re-run the command and hope.
 *
 * So: every problem at once, each naming the path into the document and what
 * was there instead. Not the first one and then a crash — a writer fixing a
 * hand-edited file wants the whole list, and a validator that stops at the
 * first finding turns one bad edit into four round-trips.
 */

/** Every shape violation in a parsed `project-state.json`, in document order. */
export function projectStateViolations(raw: unknown): string[] {
  const out: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [`the document is ${Array.isArray(raw) ? "an array" : typeof raw}, not an object`];
  }
  const doc = raw as Record<string, unknown>;

  for (const key of ["updated", "priorities", "phases", "sessions"]) {
    if (!(key in doc)) out.push(`missing required key: ${key}`);
  }

  if ("sessions" in doc) {
    if (!Array.isArray(doc.sessions)) {
      out.push(`sessions is ${typeof doc.sessions}, not an array`);
    } else {
      doc.sessions.forEach((s, i) => {
        const at = `sessions[${i}]`;
        if (s === null || typeof s !== "object" || Array.isArray(s)) {
          out.push(`${at} is not an object`);
          return;
        }
        const e = s as Record<string, unknown>;
        if (typeof e.date !== "string" || e.date.length === 0) {
          out.push(`${at}.date is ${JSON.stringify(e.date)}, expected a non-empty string`);
        }
        if (!Array.isArray(e.items)) {
          // The exact edit that produced the crash, named rather than thrown.
          const hint = typeof e.summary === "string"
            ? ` — it has a "summary" instead; archived sessions use "items": [...]`
            : "";
          out.push(`${at}.items is ${JSON.stringify(e.items)}, expected an array of strings${hint}`);
        } else {
          e.items.forEach((it, j) => {
            if (typeof it !== "string") out.push(`${at}.items[${j}] is ${typeof it}, expected a string`);
          });
        }
      });
    }
  }

  if ("phases" in doc) {
    if (!Array.isArray(doc.phases)) {
      out.push(`phases is ${typeof doc.phases}, not an array`);
    } else {
      doc.phases.forEach((p, i) => {
        const at = `phases[${i}]`;
        if (p === null || typeof p !== "object" || Array.isArray(p)) {
          out.push(`${at} is not an object`);
          return;
        }
        const e = p as Record<string, unknown>;
        if (typeof e.name !== "string") out.push(`${at}.name is ${JSON.stringify(e.name)}, expected a string`);
        if (!Array.isArray(e.scs)) out.push(`${at}.scs is ${JSON.stringify(e.scs)}, expected an array`);
      });
    }
  }

  if ("priorities" in doc && !Array.isArray(doc.priorities)) {
    out.push(`priorities is ${typeof doc.priorities}, not an array`);
  }

  return out;
}
