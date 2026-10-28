/**
 * A ticked criterion must say what proved it, and blank must be a failure.
 *
 * ## Why this exists
 *
 * `scripts/sync-sc-status.ts` ticks a checkbox when a test file mentions the
 * id. That is a claim of INTENT and this repository has always treated it as
 * one. What nothing has ever recorded is the EVIDENCE — what was run, against
 * what, and when. Measured on `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`: of ten
 * ticked criteria, eight name a pull request in prose and **two name nothing
 * at all**, and two of the eight are contradicted by issues that are still
 * open. A tick in that document means somebody merged something.
 *
 * ## This is a category, not our bug
 *
 * Surveyed 2026-10-28, four tools gate on a boolean a human or an agent sets:
 * OpenSpec's `validate --archived` exits non-zero unless every `tasks.md` box
 * is **ticked**, never that it was earned; GitHub Spec Kit gates on checkbox
 * state an LLM wrote; Doorstop's `review` stamps a fingerprint with no
 * evidence required and `clear` resolves a suspect link with no reason; Jama
 * and DOORS make "clear suspect links" a workflow action with an optional
 * comment.
 *
 * The rule behind all four: **wherever a human-or-agent-settable boolean is
 * the gate's input, the gate measures compliance with the ritual.** The only
 * tools that escape it are the ones whose input is a link the tool itself
 * resolved — BMW lobster, OpenFastTrace, NIST OSCAL, SLSA.
 *
 * ## What is copied, and the hole that is closed
 *
 * lobster is the model: `Tracing_Status = {OK, PARTIAL, MISSING, JUSTIFIED,
 * ERROR}`, anything not OK or JUSTIFIED is a non-zero exit, so blank is a
 * build failure rather than a warning. NIST OSCAL supplies the two-level
 * split — a criterion states intent, a dated observation states what was run
 * and what came back. Eclipse trudag supplies the default: **absent evidence
 * scores zero, because missing evidence is disbelief and not neutrality.**
 *
 * lobster's one hole is closed here deliberately. Its justification is free
 * text and `has_just_up = len(self.just_up) > 0` tests list length, never
 * content — so an EMPTY justification clears its gate, which is the same
 * silent pass one level up. {@link WaiverFields} requires a reason, an owner
 * and an expiry, and every one of them is checked for content.
 *
 * ## Grandfathering, without an allowlist
 *
 * `.claude/rules/self-referential-tests.md` DRIFT-3 refuses any growth of
 * `.claude/conformity-allowlists.json`, and it is right to: an allowlist of
 * exempt files is a list somebody has to shrink and nobody does. So the scope
 * is declared by the document instead. A spec is bound by this module when
 * its frontmatter says `evidence: required` and not otherwise, and
 * {@link specDeclaresEvidence} is the only place that decides. The 27 specs
 * that predate this change say nothing and are untouched; a spec opts in once
 * and can never silently opt back out, because removing the key is a visible
 * edit to a tracked file.
 *
 * ## One decider
 *
 * {@link evidenceViolations} is the single exported predicate, so there is one
 * binding to mutate and `test/spec-evidence.test.ts` proves the check can fail
 * by short-circuiting it. Do not add a second place that decides whether a
 * criterion is proved — two guards answering one question are behaviourally
 * one guard, and a mutation of either leaves the other holding every case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */

/**
 * The kinds of evidence a criterion may declare it needs.
 *
 * Closed on purpose, and an unknown kind is a violation rather than a pass.
 * You cannot tell "nobody filled this in" from "nothing was ever needed here"
 * unless the criterion said up front what belonged in the cell — that is
 * OpenFastTrace's `Needs:` and lobster's `requires:`, and it is the reason
 * this field is mandatory rather than inferred.
 */
export const EVIDENCE_KINDS = ["test", "measurement", "run", "review"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A criterion as parsed out of a spec, before any judgement about it. */
export interface ParsedCriterion {
  /** `SC-640`, `CRC-M12` — whatever the id column held. */
  id: string;
  /** 1-indexed line of the `- [ ]` bullet, for a message somebody can act on. */
  line: number;
  /** Whether the box is ticked. */
  ticked: boolean;
  /** The criterion's prose, normalised, which is what {@link criterionFingerprint} hashes. */
  text: string;
  /** What the author said would prove it. `null` when the line is absent. */
  needs: string | null;
  /** What is claimed to have proved it. `null` when absent, `""` when present and blank. */
  provedBy: string | null;
  /** The fingerprint recorded beside the evidence, if any. */
  recordedFingerprint: string | null;
  /** An explicit decision not to prove this one. */
  waiver: WaiverFields | null;
}

/**
 * The named escape hatch — the one way a ticked criterion may carry no
 * evidence.
 *
 * All three fields are required and all three are checked for content. This is
 * the deliberate divergence from lobster, whose justification accepts an empty
 * string: an escape hatch nobody has to justify is a warning nobody reads, and
 * an escape hatch with no expiry is a permanent one.
 */
export interface WaiverFields {
  /** Why this is not being proved. Must be more than a token. */
  reason: string;
  /** Who decided. A waiver nobody signed is a waiver nobody owns. */
  by: string;
  /** `YYYY-MM-DD`. A waiver past this date is a violation again. */
  until: string;
}

/** One thing wrong with one criterion, in a form a failure message can print. */
export interface EvidenceViolation {
  id: string;
  line: number;
  /** Machine-readable so a test can assert the KIND, not the wording. */
  code:
    | "TICKED_WITHOUT_EVIDENCE"
    | "EVIDENCE_BLANK"
    | "NEEDS_MISSING"
    | "NEEDS_UNKNOWN"
    | "WAIVER_INCOMPLETE"
    | "WAIVER_EXPIRED"
    | "EVIDENCE_STALE";
  /** One line naming the criterion and what to do about it. */
  message: string;
}

/**
 * A stable fingerprint of a criterion's prose.
 *
 * Bound to the evidence so that **rewording a criterion invalidates what
 * proved it**. Doorstop has the fingerprint and makes clearing it a manual
 * command with no evidence required; lobster blocks on a version mismatch but
 * only when the author opted in by pinning one. Neither ships both halves, so
 * this is automatic AND blocking.
 *
 * Whitespace is collapsed before hashing, because a reflow is not a change of
 * meaning and a checker that fires on one is a checker people route around.
 *
 * Not a cryptographic hash and does not need to be: the adversary here is an
 * edit nobody noticed, not a forger. FNV-1a, 32-bit, rendered hex.
 */
export function criterionFingerprint(text: string): string {
  const normalised = text.replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Whether this spec has opted in, read from frontmatter.
 *
 * The one place scope is decided. A document that does not say `evidence:
 * required` is not bound — see the grandfathering note above.
 */
export function specDeclaresEvidence(content: string): boolean {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  return /^evidence:\s*required\s*$/m.test(fm[1]);
}

/** `2026-10-28` → true only for a real calendar date in that exact shape. */
function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A field is present only when it carries something.
 *
 * `needs:` with nothing after it, or a lone `-`, is the blank cell this module
 * exists to catch — accepting it would rebuild lobster's hole.
 */
function hasContent(value: string | null): value is string {
  return value !== null && value.trim().length > 0 && value.trim() !== "-";
}

/**
 * Parse the criteria out of a spec.
 *
 * A criterion is a `- [ ]` or `- [x]` bullet whose first token is an id. Its
 * annotation lines are the indented `key: value` lines beneath it, up to the
 * next bullet or blank-line-then-unindented-text. Exported so a test can
 * assert the parser saw what it thinks it saw — a parser that silently reads
 * zero criteria makes every downstream count vacuously green.
 */
export function parseCriteria(content: string): ParsedCriterion[] {
  const lines = content.split("\n");
  const out: ParsedCriterion[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[([ xX])\] ([A-Z]+(?:-[A-Z]?\d+)+):\s*(.*)$/);
    if (!m) continue;

    const annotations = new Map<string, string>();
    let text = m[3];

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (/^- \[[ xX]\] /.test(next) || /^#{1,6} /.test(next)) break;
      // `bun bin/rungate.ts audit-specs --fix` inserts an unindented
      // `<!-- REVIEW: … -->` marker directly beneath a criterion whose
      // wording matches no registry pattern. It is neither prose nor an
      // annotation, and treating it as a terminator would silently sever
      // every criterion in a strict-compliance spec from its own evidence —
      // which reads exactly like a spec that never recorded any.
      if (/^\s*<!--/.test(next)) continue;

      const kv = next.match(/^\s{2,}([a-z-]+):\s*(.*)$/);
      if (kv) {
        annotations.set(kv[1], kv[2].trim());
        continue;
      }
      // An indented line that is not `key: value` is a continuation of the
      // criterion's prose, and must be hashed with it — otherwise moving a
      // clause onto the next line would silently preserve the fingerprint.
      if (/^\s{2,}\S/.test(next)) {
        text += ` ${next.trim()}`;
        continue;
      }
      if (next.trim() === "") continue;
      break;
    }

    const waiverReason = annotations.get("waived-reason") ?? null;
    const waiverBy = annotations.get("waived-by") ?? null;
    const waiverUntil = annotations.get("waived-until") ?? null;
    const anyWaiverField =
      waiverReason !== null || waiverBy !== null || waiverUntil !== null;

    out.push({
      id: m[2],
      line: i + 1,
      ticked: m[1].toLowerCase() === "x",
      text,
      needs: annotations.get("needs") ?? null,
      provedBy: annotations.get("proved-by") ?? null,
      recordedFingerprint: annotations.get("fingerprint") ?? null,
      waiver: anyWaiverField
        ? { reason: waiverReason ?? "", by: waiverBy ?? "", until: waiverUntil ?? "" }
        : null,
    });
  }

  return out;
}

/**
 * Every way this spec's criteria fail the evidence rule.
 *
 * THE single decider. An empty array means every criterion either carries
 * resolvable evidence or carries a complete, unexpired, signed waiver.
 *
 * `today` is injected rather than read from the clock so the expiry case is
 * testable without waiting, and so two runs of the suite on either side of
 * midnight cannot disagree.
 */
export function evidenceViolations(
  content: string,
  today: string,
): EvidenceViolation[] {
  if (!specDeclaresEvidence(content)) return [];

  const out: EvidenceViolation[] = [];

  for (const c of parseCriteria(content)) {
    const at = `${c.id} (line ${c.line})`;

    if (!hasContent(c.needs)) {
      out.push({
        id: c.id,
        line: c.line,
        code: "NEEDS_MISSING",
        message:
          `${at} does not say what would prove it. Add a \`needs:\` line naming one of ` +
          `${EVIDENCE_KINDS.join(", ")}. Without it, an empty \`proved-by\` is ` +
          `indistinguishable from a criterion that never needed evidence.`,
      });
    } else if (!(EVIDENCE_KINDS as readonly string[]).includes(c.needs.trim())) {
      out.push({
        id: c.id,
        line: c.line,
        code: "NEEDS_UNKNOWN",
        message:
          `${at} declares \`needs: ${c.needs.trim()}\`, which is not one of ` +
          `${EVIDENCE_KINDS.join(", ")}. The set is closed; widening it is an edit to ` +
          `EVIDENCE_KINDS in lib/spec-evidence.ts and a decision about what counts as proof.`,
      });
    }

    // A waiver is judged whenever any of its fields appears, ticked or not —
    // a half-written waiver on an unticked criterion is still a waiver nobody
    // can act on, and leaving it unchecked until the tick is what lets it rot.
    if (c.waiver) {
      const missing = (["reason", "by", "until"] as const).filter(
        k => !hasContent(c.waiver![k]),
      );
      if (missing.length > 0) {
        out.push({
          id: c.id,
          line: c.line,
          code: "WAIVER_INCOMPLETE",
          message:
            `${at} is waived but its waiver is missing: ${missing.join(", ")}. All three of ` +
            `\`waived-reason\`, \`waived-by\` and \`waived-until\` must carry content. ` +
            `BMW lobster accepts an empty justification string and that is the defect this ` +
            `rule exists to not reproduce: an escape hatch nobody signs or dates is a ` +
            `permanent silent pass.`,
        });
      } else if (!isIsoDay(c.waiver.until)) {
        out.push({
          id: c.id,
          line: c.line,
          code: "WAIVER_INCOMPLETE",
          message:
            `${at} has \`waived-until: ${c.waiver.until}\`, which is not a YYYY-MM-DD ` +
            `calendar date. An expiry nothing can compare against never expires.`,
        });
      } else if (c.waiver.until < today) {
        out.push({
          id: c.id,
          line: c.line,
          code: "WAIVER_EXPIRED",
          message:
            `${at} was waived until ${c.waiver.until}, which has passed (today is ${today}). ` +
            `Either prove it, or renew the waiver with a reason that is still true.`,
        });
      }
      continue;
    }

    if (!c.ticked) continue;

    if (c.provedBy === null) {
      out.push({
        id: c.id,
        line: c.line,
        code: "TICKED_WITHOUT_EVIDENCE",
        message:
          `${at} is ticked and has no \`proved-by\` line at all. A tick records that somebody ` +
          `believed it; it is not a record of what was run. Add \`proved-by:\`, or waive it ` +
          `explicitly with \`waived-reason\`, \`waived-by\` and \`waived-until\`.`,
      });
      continue;
    }

    if (!hasContent(c.provedBy)) {
      out.push({
        id: c.id,
        line: c.line,
        code: "EVIDENCE_BLANK",
        message:
          `${at} is ticked and its \`proved-by\` is empty. Absent evidence counts as zero, ` +
          `not as neutral — Eclipse trudag scores a missing leaf as disbelief and that is the ` +
          `right default. Name what was run, or waive it explicitly.`,
      });
      continue;
    }

    const actual = criterionFingerprint(c.text);
    if (hasContent(c.recordedFingerprint) && c.recordedFingerprint.trim() !== actual) {
      out.push({
        id: c.id,
        line: c.line,
        code: "EVIDENCE_STALE",
        message:
          `${at} has been reworded since its evidence was recorded: the \`fingerprint\` line ` +
          `says ${c.recordedFingerprint.trim()} and the text now hashes to ${actual}. The ` +
          `evidence proved the old wording. Re-run it and update both, or restore the text. ` +
          `(This is the case Doorstop makes a manual \`clear\` and lobster only catches when ` +
          `a version was pinned by hand.)`,
      });
    }
  }

  return out;
}
