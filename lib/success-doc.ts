/**
 * `SUCCESS.md` — the one file the methodology calls the measure, and the one
 * the scaffold never wrote (#485).
 *
 * `CLAUDE.md` opens its rules with:
 *
 * > **SUCCESS.md is the measure** — it states what we are building and the
 * > falsifiable claims that mean it works. Before filing an issue, reviewing
 * > a PR, or acting on an audit finding, say which claim it moves.
 *
 * No generator, no template, no step produced it. rungate's own was
 * hand-written once in `22aa5b20` and nothing reproduced that for anyone
 * else, while `specs/HARNESS-STANDARD.md` carried SC-822 asserting a
 * property of a file the scaffold never created. A consumer scaffolded a
 * project, read the generated `AGENTS.md`, and never learned the file was
 * supposed to exist.
 *
 * ## Why a validator and not just a generator
 *
 * A generator alone makes it worse. **An unfilled template is
 * indistinguishable from a considered one to everything except a reader** —
 * that is the same argument `.claude/rules/checks-must-be-able-to-fail.md`
 * makes about guards, applied to a document. A project that ran
 * `create-success` and stopped would now have a `SUCCESS.md` that every
 * "does it exist" check waves through, and five TODO claims read as
 * deliberate at a glance.
 *
 * So the template ships placeholders that are obviously placeholders, marked
 * with a token no prose would contain, and `successViolations` refuses while
 * any survive. **The generator must not invent claims**: five plausible
 * generated claims would be worse than none, because they read as considered
 * and are not.
 *
 * ## Absent is UNMEASURED, not FAIL
 *
 * A project that never opted in has not failed at anything, but it has not
 * succeeded either, and `SKIP` is indistinguishable from success — see
 * `.claude/rules/config-access.md`. So an absent file produces a loud
 * UNMEASURED and a present-but-unfilled one produces a refusal.
 */

import { existsSync, lstatSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * The token the template puts on every line a human must replace.
 *
 * An HTML comment, so it renders as nothing and a consumer who leaves one in
 * sees a clean document — which is exactly why a machine has to be the thing
 * that notices. Distinctive enough that no prose contains it by accident.
 */
export const PLACEHOLDER_MARKER = "rungate:placeholder";

/**
 * ## Two accepted forms, and why that is not a weakening
 *
 * The template below writes `### Claim N — statement`. rungate's own
 * `SUCCESS.md` — hand-written in `22aa5b20`, four months before this
 * validator, and the ONLY real instance of the document this file validates —
 * writes `1. **statement**` with an indented `Check:` underneath.
 *
 * The first draft of this parser recognised only the template's form, and the
 * consequence was immediate: run against the document that defines the genre,
 * it reported *"SUCCESS.md defines no claims"*. A validator whose single
 * real-world example fails it is not strict, it is miscalibrated — and the
 * repair everybody actually reaches for is to stop running the validator.
 *
 * So both forms parse. This costs nothing in strictness, because **neither
 * form is what the check is about**: the refusals are placeholders left in,
 * claims with nothing that can falsify them, and a standing table that
 * disagrees with the claims. A document can satisfy either syntax and still
 * fail all three. Widening the syntax does not widen what passes.
 */
const CLAIM_FORMS: RegExp[] = [
  /** `### Claim N — statement`, the form the template writes. */
  /^###\s+Claim\s+(\d+)\s*[—–-]\s*(.*)$/,
  /** `N. **statement**`, the form rungate's own SUCCESS.md has always used. */
  /^(\d+)\.\s+\*\*(.+?)\*\*\s*$/,
];

/**
 * The falsifiability line. Its absence is the defect this file exists for.
 *
 * `Check:` is rungate's spelling of it and `**How it fails:**` is the
 * template's; they are one field asked two ways.
 *
 * **`**How to measure it:**` is deliberately NOT one of them.** It is the
 * other half of the template and it answers a different question — the
 * command that produces the observation, not the observation that would prove
 * the claim false. Admitting it here was the first draft, and it meant a
 * claim could satisfy the falsifiability rule while saying only how to look:
 * "run the suite" with nothing stating what a failure would look like is the
 * slogan this refusal exists to catch. An unfilled measurement line is still
 * caught, by the placeholder and TODO checks.
 */
const FALSIFIABILITY = /^(?:\*\*How it fails:\*\*|Check:)\s*(.*)$/;

/**
 * A standing-table row, keyed by the claim number in its first cell.
 *
 * `| 1 | untested |` (template) and `| 1 — gates can fail | Partial… |`
 * (rungate) both key on 1. A first cell that does not START with a number is
 * not a claim row and is skipped rather than refused — rungate's table has a
 * `| consumer list |` row, and the file carries two unrelated `| mutation |`
 * tables whose cells are prose.
 */
const STANDING_ROW = /^\|\s*(\d+)\s*(?:[—–-][^|]*)?\|/;

/**
 * Text that means the author stopped at the template.
 *
 * The first version was `/^(TODO\b|-+$|—$)/` — uppercase `TODO` only — and a
 * review walked straight through it: `todo`, `TBD`, `FIXME`, `???`, `xxx`,
 * `N/A` and a one-character `.` all scored zero violations as both the claim
 * statement AND its `How it fails`. A detector narrower than what it detects,
 * and the narrowing was a `[A-Z]`.
 *
 * The length floor catches the rest of the family without needing to
 * enumerate it. Ten characters is below any real claim and above every
 * placeholder anyone writes; a claim shorter than that is not a falsifiable
 * statement whatever words are in it.
 */
const UNFILLED = /^(TODO|TBD|FIXME|XXX|N\/?A)\b|^(\?+|-+|—|\.+)$/i;
const MIN_MEANINGFUL = 10;
function unfilled(text: string): boolean {
  const t = text.trim();
  return t.length < MIN_MEANINGFUL || UNFILLED.test(t);
}

export interface SuccessClaim {
  number: number;
  statement: string;
  /** The text after `**How it fails:**`, or null when the line is absent. */
  howItFails: string | null;
}

export interface SuccessDoc {
  claims: SuccessClaim[];
  /** Claim numbers the standing table names. */
  standingRows: number[];
  /** Lines still carrying the placeholder marker, by 1-based line number. */
  placeholderLines: number[];
}

/** Read the structure out of a SUCCESS.md. Pure; takes the text. */
export function parseSuccessDoc(text: string): SuccessDoc {
  const claims: SuccessClaim[] = [];
  const standingRows: number[] = [];
  const placeholderLines: number[] = [];
  const lines = text.split("\n");

  let current: SuccessClaim | null = null;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (line.includes(PLACEHOLDER_MARKER)) placeholderLines.push(i + 1);
    if (fenced) continue;

    let heading: RegExpExecArray | null = null;
    for (const form of CLAIM_FORMS) {
      heading = form.exec(line);
      if (heading) break;
    }
    if (heading) {
      current = { number: Number(heading[1]), statement: heading[2].trim(), howItFails: null };
      claims.push(current);
      continue;
    }
    const fails = FALSIFIABILITY.exec(line.trim());
    // Attributed to the claim it sits under. A `How it fails` before any
    // claim heading belongs to nothing and is not counted, which is right —
    // the template's own prose mentions the phrase above the first claim.
    // FIRST one wins, so a claim's refusal always quotes the line a reader
    // would look at rather than whichever duplicate came last.
    //
    // `current` is cleared at the next heading and the scan skips fenced
    // regions, both for the same reason: without them the first matching
    // line ANYWHERE below a claim satisfied it. A `Check:` six lines down
    // under `## Appendix` counted, and so did one inside a ```markdown block
    // — so a SUCCESS.md that documents its own format handed every claim
    // below the example a falsifiability line for free.
    if (fails && current && current.howItFails === null) {
      current.howItFails = fails[1].trim();
      continue;
    }
    // Any heading ends the previous claim's scope, so a falsifiability line
    // under a later section cannot be borrowed by an earlier claim.
    if (/^#{1,6}\s/.test(line)) current = null;
    const row = STANDING_ROW.exec(line.trim());
    if (row) standingRows.push(Number(row[1]));
  }
  return { claims, standingRows, placeholderLines };
}

/** What a reading of SUCCESS.md established, and what it could not. */
export interface SuccessVerdict {
  /** Refusals. Empty means the document is structurally sound. */
  violations: string[];
  /** Set when there is no document to read at all. Never a silent pass. */
  unmeasured: string | null;
}

/**
 * The ONE place that decides whether a SUCCESS.md is real (#485).
 *
 * Kept separate from the conformity test and from the CLI so there is a
 * single binding to mutate, and so every case can be driven without a
 * filesystem.
 */
export function successViolations(text: string | null, template?: string | null): SuccessVerdict {
  // Three states, not two. `undefined` means the caller is not asking for a
  // residue comparison at all — the parser's own unit tests, which have no
  // template and are not pretending to. `TEMPLATE_MISSING` (or an explicit
  // `null`, in case a future reader reintroduces one) means a template WAS
  // looked for and not found, and that is a refusal rather than a quiet skip.
  const templateAbsent = template === TEMPLATE_MISSING || template === null;
  const residueTemplate = templateAbsent ? undefined : template;
  if (text === null) {
    return {
      violations: [],
      unmeasured:
        `UNMEASURED: this project has no SUCCESS.md, so there is nothing stating what it is ` +
        `building or which claims would prove it works. That is not a failure and it is not ` +
        `clean either — nothing here can be measured against a target that was never written ` +
        `down. Run \`bunx rungate create-success\` to seed one.`,
    };
  }

  if (text === UNREADABLE) {
    return {
      violations: [
        `SUCCESS.md exists but could not be read as a file — it may be a directory, a ` +
          `device, or have permissions that deny reading. That is not the same as having ` +
          `no SUCCESS.md, and it is not clean: nothing could be measured.`,
      ],
      unmeasured: null,
    };
  }

  // The generator's seed, untouched, is UNMEASURED rather than a failure.
  //
  // The scaffold now seeds this file whether or not the project asked, so a
  // consumer who re-scaffolds to take an unrelated update would otherwise go
  // from a green suite to a hard FAIL over a document they never wrote, with
  // no way back — deleting it is undone by the next re-scaffold.
  //
  // And it is the honest verdict: a pristine seed carries exactly as much
  // information about this project as no file at all, which is the thing
  // `null` already reports as unmeasured. The refusal is aimed at a document
  // somebody STARTED and left half-written, because that is the state which
  // reads as considered and is not. Any edit at all moves it into that set.
  if (residueTemplate && isPristineSeed(text, residueTemplate)) {
    return {
      violations: [],
      unmeasured:
        `UNMEASURED: SUCCESS.md is the generator's template, unmodified, so this project ` +
        `has not yet stated what it is building or which claims would prove it works. ` +
        `Nothing here is failing — nothing has been claimed yet. Edit it and this check ` +
        `starts measuring; every placeholder you leave behind then becomes a refusal.`,
    };
  }

  const doc = parseSuccessDoc(text);
  const out: string[] = [];

  if (doc.placeholderLines.length > 0) {
    out.push(
      `SUCCESS.md still carries ${doc.placeholderLines.length} placeholder marker(s) from the ` +
        `generator, on line(s) ${doc.placeholderLines.join(", ")}. An unfilled template is ` +
        `indistinguishable from a considered one to everything except a reader, which is why ` +
        `this refuses rather than counting the file as present.`,
    );
  }

  // The residue check could not run. Reported rather than skipped: without
  // this branch an installation missing the template reverts to the pre-#502
  // behaviour exactly, and the document that scored 1 violation scores 0 with
  // `unmeasured` still null — indistinguishable from a clean document.
  if (templateAbsent) {
    out.push(
      `SUCCESS.md could not be compared against the generator's template — ` +
        `templates/SUCCESS-TEMPLATE.md is not in this rungate installation, so the check that ` +
        `catches a document still carrying the template's prose did not run. This is not a ` +
        `clean result: see test/package-closure.test.ts, which exists to stop exactly this.`,
    );
  }

  // The backstop the marker check turned out to need. Asked before the
  // per-claim rules so the loudest problem is reported first.
  if (residueTemplate) {
    const residue = templateResidue(text, residueTemplate);
    if (residue.length > 0) {
      out.push(
        `SUCCESS.md still contains ${residue.length} line(s) verbatim from the generator's ` +
          `template, so this document is partly unwritten: ` +
          residue.slice(0, 3).map(l => JSON.stringify(l.slice(0, 70))).join(", ") +
          `${residue.length > 3 ? `, and ${residue.length - 3} more` : ""}. ` +
          `Deleting the placeholder markers is not the same as replacing the text they mark.`,
      );
    }
  }

  if (doc.claims.length === 0) {
    out.push(
      `SUCCESS.md defines no claims. The file's whole purpose is the falsifiable statements ` +
        `that mean the project works. Declare one as "### Claim N — ..." or as a numbered ` +
        `"N. **...**" list item.`,
    );
  }

  for (const claim of doc.claims) {
    if (unfilled(claim.statement)) {
      out.push(`SUCCESS.md claim ${claim.number} has no statement — it still reads "${claim.statement}".`);
    }
    if (claim.howItFails === null) {
      out.push(
        `SUCCESS.md claim ${claim.number} has no "**How it fails:**" (or "Check:") line. A ` +
          `claim nothing can falsify is a slogan — make it measurable or delete it.`,
      );
    } else if (unfilled(claim.howItFails)) {
      out.push(
        `SUCCESS.md claim ${claim.number}'s "How it fails" is still the template's placeholder ` +
          `("${claim.howItFails}"), so nothing states what would prove the claim false.`,
      );
    }
  }

  // Both directions. A standing table listing a claim nobody defined is as
  // broken as a claim nobody tracks, and the second is the one that rots
  // quietly — a claim added and never given a row reads as met by omission.
  const defined = new Set(doc.claims.map(c => c.number));
  const tracked = new Set(doc.standingRows);
  for (const n of [...tracked].sort((a, b) => a - b)) {
    if (!defined.has(n)) {
      out.push(`SUCCESS.md's standing table has a row for claim ${n}, which no claim defines.`);
    }
  }
  for (const n of [...defined].sort((a, b) => a - b)) {
    if (!tracked.has(n)) {
      out.push(
        `SUCCESS.md claim ${n} has no row in the standing table, so nothing records where it ` +
          `actually stands. A claim with no standing reads as met by omission.`,
      );
    }
  }

  return { violations: out, unmeasured: null };
}

/**
 * Lines the project still shares, verbatim, with the template it came from.
 *
 * ## Why the placeholder markers were not enough
 *
 * The first version of this check rested entirely on `PLACEHOLDER_MARKER`,
 * and a security review found the hole by reading what the generator PRINTS:
 * `create-success` tells the user "Replace every line marked
 * `rungate:placeholder`". A user who does exactly that — deletes the five
 * marker lines, names the claims, writes a `How it fails` for each, and stops
 * — produced **seven surviving `TODO`s and zero violations**. `## The thing`
 * was still the template's instruction text, every `**How to measure it:**`
 * still read `TODO`, and `owner:`/`updated:` were still `TODO-OWNER` and
 * `TODO-DATE`.
 *
 * One `grep -v` cleared the entire guard. That is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — a detector narrower than
 * what it detects — and the narrowing was *instructed by our own output*.
 *
 * ## Why this shape rather than more rules
 *
 * Adding a rule per section (require a filled `## The thing`, require a
 * `**How to measure it:**`, ...) would be a list that has to stay in sync
 * with the template by hand, and a new template section would silently go
 * unchecked. This asks the question directly instead: **is this document
 * still, in part, the template?** It needs no per-section knowledge and a
 * new template section is covered the day it ships.
 *
 * Structural lines are excluded because they are SUPPOSED to match: headings,
 * table rows, frontmatter keys, and anything too short to be instruction
 * prose. Measured against the one real instance — rungate's own SUCCESS.md,
 * written four months before the template — the only overlap is
 * `doc-type: reference` and `status: active`, both frontmatter.
 */
export function templateResidue(text: string, template: string): string[] {
  const structural = (l: string) =>
    l.length <= 12
    || l.startsWith("#")
    || l.startsWith("|")
    || l.startsWith("---")
    || /^[a-z][a-z-]*:\s/.test(l);

  const mine = new Set(text.split("\n").map(l => l.trim()));
  const out: string[] = [];
  for (const raw of template.split("\n")) {
    const l = raw.trim();
    if (structural(l) || !mine.has(l)) continue;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/**
 * The installation is missing `templates/SUCCESS-TEMPLATE.md`.
 *
 * A distinct value rather than `null`, for the reason `UNREADABLE` is: the
 * residue check is the half of this validator that catches a document which
 * deleted the markers and kept the prose, and a falsy template silently
 * switched it off. Same document, same checker, template absent: **1
 * violation became 0, with nothing recorded.** That is the first shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — a read failure defaulting
 * to an empty violation list — and #484 is this repo's standing proof that
 * "`templates/` is in `files[]`, so it cannot happen" is a thing that has
 * already happened once while every check stayed green.
 *
 * `create-success` and `seedSuccessDoc` both name a missing template loudly.
 * This makes `successViolations` the third reader of that file rather than
 * the only one that shrugs.
 */
export const TEMPLATE_MISSING = "\u0000rungate:template-missing";

/**
 * The template the generator copies.
 *
 * Never returns `null` — an absent template is `TEMPLATE_MISSING`, which
 * `successViolations` refuses. Returning a falsy value here is what made the
 * residue check fail open, so the type no longer permits it.
 */
export function readSuccessTemplate(): string {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "SUCCESS-TEMPLATE.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : TEMPLATE_MISSING;
}

/** Read the project's SUCCESS.md, or null when there is none. */
export const UNREADABLE = "\u0000rungate:unreadable";

export function readSuccessDoc(root: string): string | null {
  const p = join(root, "SUCCESS.md");
  // `existsSync` is true for a DIRECTORY, and `readFileSync` then throws
  // EISDIR. The throw escaped `seedSuccessDoc` and aborted the whole scaffold
  // run mid-way — after some files were written and before others — which is
  // a worse outcome than any verdict this function can return.
  //
  // It returns a distinct UNREADABLE rather than `null`, because "the file is
  // there and I could not read it" and "there is no file" are different
  // answers and collapsing them is the SKIP-is-indistinguishable-from-success
  // shape. UNREADABLE refuses; absent is unmeasured.
  let stat;
  try {
    stat = lstatSync(p);
  } catch {
    return null;
  }
  if (!stat.isFile()) return UNREADABLE;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return UNREADABLE;
  }
}

/**
 * Fill the template's owner and date. ONE substitution, two callers.
 *
 * `create-success` did this and `seedSuccessDoc` wrote the template raw, so
 * the same logical seed produced different bytes depending on which path
 * created it — a scaffolded SUCCESS.md kept `owner: TODO-OWNER` and
 * `updated: TODO-DATE` forever, and nothing checked frontmatter.
 */
export function seedFromTemplate(template: string, owner: string, date: string): string {
  return template
    .replace("owner: TODO-OWNER", `owner: ${owner}`)
    .replace("updated: TODO-DATE", `updated: ${date}`);
}

/**
 * Is this document the generator's seed, untouched?
 *
 * Owner and date are normalised out, because those are the two things the
 * generator itself fills in — a seed with them substituted is still a seed.
 */
export function isPristineSeed(text: string, template: string): boolean {
  const norm = (t: string) =>
    t.replace(/^owner:.*$/m, "owner:").replace(/^updated:.*$/m, "updated:").trim();
  return norm(text) === norm(template);
}
