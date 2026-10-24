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

/** One rendered session, and the entries the selection could not place. */
export interface SessionSelection<T> {
  /** Newest first, at most `limit` of them. */
  rendered: T[];
   /**
   * Entries whose `date` does not begin with an ISO date.
   *
   * They are NOT excluded — they rank below every dated entry, in array
   * order, which is the only information left about them and is exactly
   * what the old renderer used for everything. A project whose dates are
   * all free-form therefore renders exactly as it did before.
   *
   * They are reported by name, because an entry nobody can order is a
   * thing worth saying out loud: it will be outranked by any dated entry,
   * however old, and that is surprising if you cannot see it.
   */
  undated: T[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * The session number inside a free-form `date` — `2026-10-24 session 62`.
 *
 * This is the only field in the entry that tells two sessions on one calendar
 * day apart, so it is the second sort key (#1517). 50 of the live file's 51
 * entries carry one; the exception is `2026-10-06 AFK pipeline-readiness run`,
 * which is dated and unnumbered and therefore ranks below every numbered
 * session on its day rather than being treated as unorderable.
 */
const SESSION_NUMBER = /\bsession\s+(\d+)/i;

/** Ranks below every real session number. No session is numbered below 1. */
const UNNUMBERED = -1;

/**
 * The `limit` NEWEST sessions, chosen by date (#572).
 *
 * The renderer used to take `[...sessions].reverse().slice(0, 3)` — "the
 * last three entries of the array", which is correct exactly while the
 * array is in append order and which nothing anywhere enforced. Session 48
 * was written to `sessions[0]`, so eight merged issues never appeared in
 * PROJECT-STATE.md, the file AGENTS.md tells the next session to read
 * first. The script printed `✅ rewrote` every time, because it had in fact
 * rewritten the file.
 *
 * This is the second instance of that bug in the same function. The first
 * was `slice(0, 3)` rendering the three OLDEST entries, and the fix was
 * `.reverse()` — which repaired the symptom and left the defect: the
 * renderer still had no idea which sessions were newest, it just trusted a
 * position. Choosing by date removes the position from the question
 * entirely, so where an entry is written stops mattering.
 *
 * Two sessions on one day are ordered by their session number, not by where
 * they sit in the array (#1517). The date alone tied them, and the tie-break
 * was `b.i - a.i` — later index first — so `main` rendered `session 61` above
 * `session 62`.
 *
 * **Fixing the tie-break instead was considered and rejected.** `a.i - b.i`
 * is one character and it repairs the reported case, but it reinstates the
 * defect this function was written to remove: it makes correctness depend on
 * the array having one direction, and the array does not have one. Measured
 * on the live file at `edb12c93`: 16 adjacent pairs descend, 13 ascend, and
 * the direction flips at index 26 — the head is newest-first as the DA writes
 * it, the tail is append order. The case that settles it is 2026-10-23, which
 * holds sessions 60, 58 and 59 at indices 2, 49 and 50: no function of the
 * index alone can order that group, in either direction. It would also
 * contradict SC-1961 — "the position in the array decides nothing" — by
 * making position decide exactly the case that criterion never exercises.
 *
 * Ordering, in full:
 *
 * 1. ISO date, newest first.
 * 2. Session number, highest first. An entry with a date but no number ranks
 *    below every numbered entry on its day.
 * 3. Later array index first — the original tie-break, unchanged. It is kept,
 *    not reverted to, and only where the first two tiers have nothing to say:
 *    entries tying on date AND number, and entries that are wholly undated.
 *    It is right there for the same reason it was wrong above. Every real
 *    same-number group in the live file — `session 32`/`32b`, three rows
 *    numbered 34, two numbered 39 — is one session recorded as several rows,
 *    and all of them sit in the array's append-ordered tail, where the later
 *    index genuinely is the newer row. Making this tier stable instead breaks
 *    all four, and `sessions capped at 3, newest first` in
 *    test/update-project-state.test.ts catches it.
 */
export function selectRecentSessions<T extends { date: string }>(
  sessions: readonly T[],
  limit: number,
): SessionSelection<T> {
  const undated: T[] = [];
  const ranked = sessions.map((s, i) => {
    const date = s.date ?? "";
    const m = ISO_DATE.exec(date);
    if (m === null) undated.push(s);
    const n = SESSION_NUMBER.exec(date);
    // An undated entry sorts below every dated one. `""` is less than any
    // ISO date, so the comparison needs no second branch — and a branch
    // that exists only for the empty case is a branch no fixture reaches.
    // That still holds with the number tier below it: the date is compared
    // first, so no session number can promote an undated entry past a dated
    // one. Asserted, not reasoned about, in test/project-state-shape.test.ts.
    return { s, key: m === null ? "" : m[0], seq: n === null ? UNNUMBERED : Number(n[1]), i };
  });
  ranked.sort((a, b) =>
    a.key !== b.key ? (a.key < b.key ? 1 : -1) : a.seq !== b.seq ? b.seq - a.seq : b.i - a.i,
  );
  return { rendered: ranked.slice(0, limit).map(d => d.s), undated };
}
