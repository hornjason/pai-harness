/**
 * Cut the region a claim is about, by where the CONSTRUCT ends (#664).
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` says to cut the region out of
 * the string first, assert on the cut, and assert the cut is non-empty. Ten
 * guards in `test/` satisfy the letter of that with `slice(at, at + 6000)` and
 * miss the point: a region ends where its construct ends, and a character
 * count is a guess about how long the construct will stay that size. The guess
 * decays silently and the day it fails it accuses the wrong code.
 *
 * Measured on `test/worktree-repo.test.ts` SC-1446: 650 characters of
 * headroom, and a 2,119-character insertion in the branch ABOVE the one it
 * guards pushed both target strings 1,469 characters past the boundary. The
 * case is named "the Verify BUILD regression has an else, and it is terminal",
 * the `else` is still there and still terminal, and the case went red.
 *
 * So this module has **no numeric-length parameter anywhere in its API**. A
 * window cannot decay if there is no window to pass. A cut ends at a matching
 * bracket or at a named end anchor, and nothing else is offered.
 *
 * ## The refusals, and why each is its own name
 *
 * | refusal | the input only it reaches |
 * |---|---|
 * | `AnchorNotFoundError` | an anchor, start anchor or end anchor absent from the document |
 * | `UnbalancedCutError` | a bracket with no matching close, or no opener after the anchor |
 * | `EmptyCutError` | an end landing where the anchor ends, so the cut holds only the anchor |
 * | `AnchorOutsideCutError` | a two-sided region that does not contain the anchor it is about |
 *
 * The last two are the ones that matter most, because the thing they prevent
 * reads as a pass. A caller that runs `expect(cut).toContain(x)` over a cut
 * that is nothing but the anchor is asserting against text it typed itself,
 * and a two-sided region that misses its subject answers confidently about the
 * wrong code — which is the failure line numbers already had (#514).
 *
 * This is a sibling of `lib/source-anchor.ts`, not a replacement for it. That
 * module answers *where does this citation point*; this one answers *what is
 * the region this claim is about*. Its exports are untouched.
 *
 * ## Scope, stated rather than implied
 *
 * The bracket scan is a raw text scan, the same one already written by hand in
 * `test/ship-remediation-commits.test.ts` and `test/liveness-contradiction.ts`.
 * It does not know about strings, comments or regex literals, so it is for
 * cutting a block out of source whose brackets balance across the region —
 * which is what every call site here does. An unbalanced region refuses by
 * name rather than running to the end of the document.
 */

/** The bracket kinds a cut can close on. */
export type Bracket = "{" | "[" | "(";

const CLOSER: Record<Bracket, string> = { "{": "}", "[": "]", "(": ")" };

/**
 * Where a cut stops: at the close of a balanced bracket, or at a named anchor.
 *
 * Both ends are structural. Neither is a length — that is the whole point of
 * the module and the reason this type has no third member.
 */
export type CutEnd = { balanced: Bracket } | { endAnchor: string };

/** The bounds of a two-sided cut: a named start, and either structural end. */
export interface CutBounds {
  startAnchor: string;
  end: CutEnd;
}

/** An anchor — leading, trailing or the subject itself — is not in the document. */
export class AnchorNotFoundError extends Error {
  readonly anchor: string;
  constructor(anchor: string, role: string) {
    super(`the ${role} ${JSON.stringify(anchor)} does not appear in the document, so the cut reads nothing`);
    this.name = "AnchorNotFoundError";
    this.anchor = anchor;
    Object.setPrototypeOf(this, AnchorNotFoundError.prototype);
  }
}

/** A bracket cut found no opener, or an opener that never closes. */
export class UnbalancedCutError extends Error {
  readonly anchor: string;
  readonly bracket: Bracket;
  constructor(anchor: string, bracket: Bracket, detail: string) {
    super(`the cut from ${JSON.stringify(anchor)} cannot close its ${bracket} — ${detail}`);
    this.name = "UnbalancedCutError";
    this.anchor = anchor;
    this.bracket = bracket;
    Object.setPrototypeOf(this, UnbalancedCutError.prototype);
  }
}

/**
 * The cut holds nothing but the anchor the caller typed.
 *
 * Not literally zero bytes — a cut always carries its own anchor — but zero
 * bytes BEYOND it, which is the same thing for every purpose a cut has. An
 * assertion over it can only confirm the anchor, and an assertion that can
 * only confirm its own input is this repository's most common defect.
 */
export class EmptyCutError extends Error {
  readonly anchor: string;
  constructor(anchor: string) {
    super(
      `the cut from ${JSON.stringify(anchor)} holds nothing beyond the anchor itself, ` +
        `so anything asserted against it is being asserted against the anchor`,
    );
    this.name = "EmptyCutError";
    this.anchor = anchor;
    Object.setPrototypeOf(this, EmptyCutError.prototype);
  }
}

/** A two-sided region closed before it reached the anchor it is about. */
export class AnchorOutsideCutError extends Error {
  readonly anchor: string;
  constructor(anchor: string, startAnchor: string) {
    super(
      `the region from ${JSON.stringify(startAnchor)} does not contain ${JSON.stringify(anchor)} — ` +
        `it closed before reaching the anchor, so it is about other code`,
    );
    this.name = "AnchorOutsideCutError";
    this.anchor = anchor;
    Object.setPrototypeOf(this, AnchorOutsideCutError.prototype);
  }
}

/**
 * The index one past the matching close of the first `bracket` at or after
 * `from`. Refuses rather than returning a sentinel: `-1` and "the end of the
 * document" are both indistinguishable from a correct answer at the call site.
 */
function balancedEnd(doc: string, from: number, anchor: string, bracket: Bracket): number {
  const open = doc.indexOf(bracket, from);
  if (open < 0) {
    throw new UnbalancedCutError(anchor, bracket, `no ${bracket} follows the anchor`);
  }
  const closer = CLOSER[bracket];
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    if (doc[i] === bracket) depth++;
    else if (doc[i] === closer && --depth === 0) return i + 1;
  }
  throw new UnbalancedCutError(anchor, bracket, `the ${bracket} at offset ${open} is never closed`);
}

/** The exclusive end index for one `CutEnd`, measured forward from `from`. */
function endIndex(doc: string, from: number, anchor: string, end: CutEnd): number {
  if ("balanced" in end) return balancedEnd(doc, from, anchor, end.balanced);
  // Searched past the anchor, and EXCLUSIVE of the end anchor — which is how
  // `slice(at, src.indexOf("\n}", at))` is already written in this tree.
  const at = doc.indexOf(end.endAnchor, from + anchor.length);
  if (at < 0) throw new AnchorNotFoundError(end.endAnchor, "end anchor");
  return at;
}

/** Refuse a cut that carries nothing the caller did not already type. */
function refuseEmpty(doc: string, from: number, anchor: string, to: number): void {
  if (doc.slice(from + anchor.length, to).trim().length === 0) throw new EmptyCutError(anchor);
}

/**
 * The text from `anchor` to a structural end.
 *
 * ```ts
 * structuralCut(shipSource, "Verify CODE regression #${regressionCount}", { balanced: "{" })
 * structuralCut(shipSource, "function collectAgentWork(", { endAnchor: "\n}" })
 * ```
 *
 * A balanced end is inclusive of its closing bracket; a named end anchor is
 * exclusive of the anchor text, both matching the hand-written forms already
 * in `test/`. Throws `AnchorNotFoundError`, `UnbalancedCutError` or
 * `EmptyCutError` — never a short cut and never an empty string.
 */
export function structuralCut(doc: string, anchor: string, end: CutEnd): string {
  const at = doc.indexOf(anchor);
  if (at < 0) throw new AnchorNotFoundError(anchor, "anchor");
  const to = endIndex(doc, at, anchor, end);
  refuseEmpty(doc, at, anchor, to);
  return doc.slice(at, to);
}

/**
 * The region around `anchor`, bounded structurally on BOTH sides.
 *
 * The before-and-after shape — `slice(at - 1_500, at + 1_500)` at
 * `test/agent-timings-queued.test.ts:292` — is fragile at two ends rather than
 * one. Replacing it needs a start that is a construct too, so the start is a
 * named anchor found by searching BACKWARD from the subject, and the end is
 * resolved forward from that start:
 *
 * ```ts
 * structuralCutAround(shipSource, "TIMING: ${t.agent}", {
 *   startAnchor: "for (const t of gradeResult.timing)",
 *   end: { balanced: "{" },
 * })
 * ```
 *
 * The region must contain the anchor, and that is checked rather than assumed:
 * an end anchor sitting between the start and the subject produces a region
 * that is well-formed, non-empty, and about something else.
 */
export function structuralCutAround(doc: string, anchor: string, bounds: CutBounds): string {
  const at = doc.indexOf(anchor);
  if (at < 0) throw new AnchorNotFoundError(anchor, "anchor");
  const { startAnchor, end } = bounds;
  const from = doc.lastIndexOf(startAnchor, at);
  if (from < 0) throw new AnchorNotFoundError(startAnchor, "start anchor");

  const to = endIndex(doc, from, startAnchor, end);
  refuseEmpty(doc, from, startAnchor, to);
  const cut = doc.slice(from, to);
  if (!cut.includes(anchor)) throw new AnchorOutsideCutError(anchor, startAnchor);
  return cut;
}
