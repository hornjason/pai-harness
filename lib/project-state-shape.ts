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
        if (!Array.isArray(e.scs)) {
          out.push(`${at}.scs is ${JSON.stringify(e.scs)}, expected an array`);
          return;
        }
        // The elements, not only the array. Found by a security review of the
        // first commit: checking that `scs` is an array leaves
        // `sc.id.toUpperCase()` and `sc.done` to crash on `[null]` or `[{}]`,
        // which is the same unreadable TypeError this whole module replaces,
        // one level deeper. A validator that stops at the container is a
        // validator that moves the crash rather than removing it.
        e.scs.forEach((sc, j) => {
          const scAt = `${at}.scs[${j}]`;
          if (sc === null || typeof sc !== "object" || Array.isArray(sc)) {
            out.push(`${scAt} is not an object`);
            return;
          }
          const s = sc as Record<string, unknown>;
          if (typeof s.id !== "string") out.push(`${scAt}.id is ${JSON.stringify(s.id)}, expected a string`);
          if (typeof s.done !== "boolean") out.push(`${scAt}.done is ${JSON.stringify(s.done)}, expected a boolean`);
          if (typeof s.what !== "string") out.push(`${scAt}.what is ${JSON.stringify(s.what)}, expected a string`);
        });
      });
    }
  }

  if ("priorities" in doc && Array.isArray(doc.priorities)) {
    doc.priorities.forEach((p, i) => {
      if (typeof p !== "string") out.push(`priorities[${i}] is ${typeof p}, expected a string`);
    });
  }

  // `session` is optional — the renderer guards it with `if (state.session)`
  // — but a present one is dereferenced four fields deep without a guard,
  // and a half-written session renders "Session undefined (undefined)".
  if ("session" in doc && doc.session !== undefined && doc.session !== null) {
    const s = doc.session;
    if (typeof s !== "object" || Array.isArray(s)) {
      out.push(`session is ${Array.isArray(s) ? "an array" : typeof s}, expected an object`);
    } else {
      const e = s as Record<string, unknown>;
      if (typeof e.number !== "number") out.push(`session.number is ${JSON.stringify(e.number)}, expected a number`);
      for (const k of ["date", "summary", "suite"]) {
        if (typeof e[k] !== "string") out.push(`session.${k} is ${JSON.stringify(e[k])}, expected a string`);
      }
    }
  }

  if ("priorities" in doc && !Array.isArray(doc.priorities)) {
    out.push(`priorities is ${typeof doc.priorities}, not an array`);
  }

  return out;
}

/**
 * A project with no `project-state.json` is not the same as a project that
 * lost one.
 *
 * The script exited 0 with "project-state.json not found, skipping" for
 * both. For a consumer project that does not use the feature that is right.
 * For this repo — where the pre-commit hook renders the artifact every
 * commit and `AGENTS.md` tells the next session to read it first — a missing
 * source means the hook quietly stopped maintaining a file people are
 * instructed to trust, and said "skipping" while doing it.
 *
 * The tell is the output: if `PROJECT-STATE.md` is there and its source is
 * not, this project HAS the artifact and has lost the thing that writes it.
 * Same distinction the spec-compliance probe draws between "no suite here"
 * and "half a suite".
 */
export function missingStateVerdict(opts: {
  jsonExists: boolean;
  markdownExists: boolean;
}): { verdict: "OK" | "SKIP" | "REFUSE"; detail: string } {
  if (opts.jsonExists) return { verdict: "OK", detail: "" };
  if (opts.markdownExists) {
    return {
      verdict: "REFUSE",
      detail:
        "PROJECT-STATE.md exists but project-state.json does not — the rendered artifact has " +
        "outlived its source, so it is now a file nobody maintains that the next session is told to trust",
    };
  }
  return { verdict: "SKIP", detail: "project-state.json not found and no PROJECT-STATE.md to maintain — nothing to do" };
}
