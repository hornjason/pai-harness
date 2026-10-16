/**
 * Whether a release may be cut, and whether one actually was (#364).
 *
 * `rungate` has been published twice ever — `0.2.0` and `0.2.1`. `main` is
 * 741 commits past the second. A consumer installing from npm receives a
 * harness without any of the gate, collector or claim-audit work that
 * `SUCCESS.md` cites as evidence, which is why #366 made the file say so and
 * why this file exists to stop it drifting again.
 *
 * ## The failure this is built around
 *
 * The issue named it, and it is the shape `.claude/rules/checks-must-be-able-
 * to-fail.md` opens with:
 *
 *   > A publish job that exits 0 because npm rejected a duplicate version is
 *   > exactly the "could not measure reads as nothing wrong" shape, and it is
 *   > the most likely way this fix ships broken.
 *
 * A release pipeline has an unusually quiet way of doing nothing. The publish
 * step can be skipped by an `if:` that stopped matching, swallowed by a
 * `continue-on-error`, or rejected by the registry as a duplicate — and in
 * every case the job is green and the tag exists. Nothing downstream can tell
 * "we shipped 0.2.3" from "we tagged 0.2.3 and shipped nothing".
 *
 * ## Two readings, before and after
 *
 * So the guard is not one check but two, taken at different times, and
 * neither is sufficient alone:
 *
 * - **Preflight** — the tree's version must NOT be on the registry yet. This
 *   is what makes a duplicate publish a red run rather than a no-op.
 * - **Postflight** — after the publish step, the registry's `latest` must BE
 *   the tree's version. This is what makes a *skipped* publish a red run.
 *
 * Preflight alone passes a pipeline whose publish step never ran. Postflight
 * alone passes a pipeline that republished nothing because the version was
 * already there from last month. The pair is the same "two numbers, not one"
 * argument `lib/distribution-standing.ts` makes about `SUCCESS.md`, applied
 * to the act rather than to the record.
 */

/** What the registry currently holds for a package. */
export interface RegistryState {
  /** Every published version, in no particular order. */
  versions: string[];
  /** The `latest` dist-tag, or `null` for a package that has never shipped. */
  latest: string | null;
}

/**
 * Read the registry.
 *
 * The packument, not `/latest`: "has 0.2.2 ever been published" cannot be
 * answered by a dist-tag, because `latest` moves on and leaves older versions
 * installable behind it. `distributionViolations` asks a different question
 * and is right to use `/latest`; this one needs the whole list.
 *
 * Deliberately not the `npm` CLI — the registry's JSON endpoint needs no npm
 * on the path and no lockfile, so it measures the same thing on a laptop and
 * on CI.
 *
 * A 404 is a real answer: the package has never been published, so every
 * version is available. Any other failure THROWS rather than returning an
 * empty state, because an unreachable registry would otherwise read as "no
 * version conflicts" and wave a duplicate straight through.
 */
export const NPM_REGISTRY = "https://registry.npmjs.org";

export async function registryState(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
  base: string = NPM_REGISTRY,
): Promise<RegistryState> {
  const res = await fetchImpl(`${base}/${pkg}`);
  if (res.status === 404) return { versions: [], latest: null };
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const body = (await res.json()) as {
    versions?: Record<string, unknown>;
    "dist-tags"?: { latest?: unknown };
  };
  const versions = body.versions ? Object.keys(body.versions) : [];
  const latest = body["dist-tags"]?.latest;
  return { versions, latest: typeof latest === "string" ? latest : null };
}

/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+build` — npm's shape, not a full semver parser. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Does `version` satisfy a `^x.y.z` range, by npm's rules? (#364)
 *
 * Exists because the scaffold pins consumers to a caret floored at the
 * harness's own minor, and whether that range can ever resolve decided
 * whether a release could be cut at all. A tree carrying an unpublished
 * minor emits a range nothing satisfies — `0.3.0` emits `^0.3.0` while the
 * registry's newest is `0.2.1` — and `release.yml` runs the suite before
 * publishing, so a check wanting the tree's version already on npm cannot
 * pass on the run that would put it there.
 *
 * The caret's 0.x behaviour is the whole point and is the part hand-rolled
 * comparisons get wrong: below 1.0.0 a caret is pinned to the MINOR, not the
 * major, so `^0.3.0` excludes `0.4.0`. Getting that backwards would make
 * this answer `true` for every bump and the guard would certify nothing.
 *
 * Deliberately narrow: `harnessDevDepRange` only ever emits `^x.y.0`, so
 * this handles carets and refuses anything else rather than pretending to be
 * a semver range parser.
 */
export function satisfiesCaret(version: string, range: string): boolean {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!r || !v) return false;
  const [rMaj, rMin, rPat] = r.slice(1, 4).map(Number);
  const [vMaj, vMin, vPat] = v.slice(1, 4).map(Number);

  // Lower bound: the version must be at or above the floor.
  const atOrAbove =
    vMaj > rMaj ||
    (vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPat >= rPat)));
  if (!atOrAbove) return false;

  // Upper bound, and the 0.x special case is the reason this function exists.
  if (rMaj > 0) return vMaj === rMaj;
  if (rMin > 0) return vMaj === 0 && vMin === rMin;
  return vMaj === 0 && vMin === 0 && vPat === rPat;
}

/**
 * The single place that decides whether a release may be cut. `null` allows.
 *
 * One exported function so there is one binding to mutate. `tag` is the git
 * ref the workflow fired on, with any `refs/tags/` prefix already stripped;
 * pass `null` for a run that is not tag-triggered.
 *
 * The tag comparison is here and not left to the workflow because a tag that
 * disagrees with `package.json` publishes the version in `package.json` while
 * every human reads the tag. That is not a release, it is two releases with
 * one set of notes.
 */
export function preflightRefusal(
  treeVersion: string,
  tag: string | null,
  state: RegistryState,
): string | null {
  if (!SEMVER.test(treeVersion)) {
    return `package.json version ${JSON.stringify(treeVersion)} is not a version npm will accept`;
  }
  if (tag !== null && tag !== `v${treeVersion}`) {
    return (
      `tag ${tag} does not name the version being published — package.json says ` +
      `${treeVersion}, so the tag would describe a release that is not the one cut`
    );
  }
  // `registryServes`, not a second `versions.includes` here (#445). Two
  // deciders answering the same question about the same input are
  // behaviourally one guard, and no behavioural test can tell them apart —
  // the fourth shape in .claude/rules/checks-must-be-able-to-fail.md.
  if (registryServes(state, treeVersion)) {
    return (
      `rungate@${treeVersion} is already on the registry — publishing it again is ` +
      `rejected by npm, and a job that treats that rejection as success reports a ` +
      `release nobody can install. Bump package.json.`
    );
  }
  return null;
}

/**
 * The ONE question the postflight answers: is the version on the registry?
 *
 * The `versions` list, not `dist-tags.latest` (#445). They are different
 * facts and #364 conflated them. A version that appears in `versions` has
 * been published — `npm install rungate@0.4.0` resolves — whatever `latest`
 * currently points at, because a dist-tag is a pointer that moves on its own
 * schedule and can be aimed anywhere. Reading `latest` to answer "did the
 * publish take effect" is reading a pointer to answer a question about the
 * thing pointed at.
 *
 * Exported as its own binding so there is exactly one place to mutate.
 * `preflightRefusal` asks the same predicate in the opposite direction — the
 * version must NOT be here before, and MUST be here after — which is the
 * whole of the two-readings design in one field.
 */
export function registryServes(state: RegistryState, version: string): boolean {
  return state.versions.includes(version);
}

/**
 * What the postflight established, and what it could not (#445).
 *
 * Three states, not two, because `v0.3.0` and `v0.4.0` both published
 * successfully and both were recorded as failures. The old shape had only
 * `refusal | null`, so a stale read had nowhere to go but into a refusal, and
 * the refusal it got said *the publish step did not take effect* — a cause
 * the guard had not established and could not establish from where it stood.
 */
export interface PostflightVerdict {
  /** `true` only when the registry serves the version being cut. */
  published: boolean;
  /**
   * Set when the release is published but `latest` still points elsewhere.
   * Reported, never decided on: a lagging dist-tag is propagation, and the
   * guard calling it a failed publish is the whole of #445.
   */
  note: string | null;
  /**
   * Set when the version is absent from the packument. Deliberately NOT a
   * finding — both explanations are named and neither is chosen. See
   * `.claude/rules/config-access.md`: a reading that could not be obtained is
   * UNMEASURED, and `0`, `{}`, `null` and `SKIP` are indistinguishable from
   * success while UNMEASURED is not.
   */
  unmeasured: string | null;
}

/** The command a human runs to settle what this guard cannot. */
export function confirmCommand(pkg: string, version: string): string {
  return `npm view ${pkg}@${version} version`;
}

/**
 * The single place that decides whether a release actually happened.
 *
 * Run AFTER the publish step, against a freshly read registry. This is the
 * half that cannot be satisfied by doing nothing: a skipped, swallowed or
 * silently-failed publish leaves the registry without the version.
 *
 * What it will not do is say WHY the version is missing. From one stale read
 * "the publish did not take effect" and "the packument has not propagated"
 * are the same observation, and #407 answered that by waiting longer, which
 * is a bigger guess rather than a different mechanism. This answers it by
 * declining to guess and naming the command that settles it.
 */
export function postflightVerdict(
  pkg: string,
  treeVersion: string,
  state: RegistryState,
  read: { attempts: number; waitedMs: number },
): PostflightVerdict {
  const seconds = Math.round(read.waitedMs / 1000);
  const reads = `${read.attempts} read${read.attempts === 1 ? "" : "s"} over ${seconds}s`;

  if (registryServes(state, treeVersion)) {
    return {
      published: true,
      note:
        state.latest === treeVersion
          ? null
          : `the registry serves ${pkg}@${treeVersion} while dist-tags.latest is ` +
            `${state.latest ?? "unset"} — the publish landed and the tag has not ` +
            `caught up. That is propagation and it is not a failed publish`,
      unmeasured: null,
    };
  }

  return {
    published: false,
    note: null,
    unmeasured:
      `UNMEASURED: ${pkg}@${treeVersion} is absent from the registry's packument ` +
      `after ${reads} (dist-tags.latest is ${state.latest ?? "unset"}). Two ` +
      `explanations fit this reading and nothing available here tells them apart: ` +
      `the publish did not take effect, or the packument has not propagated. ` +
      `The publish may well have succeeded. Settle it with ` +
      `\`${confirmCommand(pkg, treeVersion)}\` — if that prints ${treeVersion} the ` +
      `release landed and only this job's result is wrong; if it fails, the publish ` +
      `did not happen and the release must be cut again.`,
  };
}

/** What a postflight poll saw, and how hard it had to look (#407, #445). */
export interface PostflightReading {
  /** The `latest` dist-tag on the final read. */
  latest: string | null;
  /** Reads performed. 1 means the registry had it immediately. */
  attempts: number;
  /** Time spent sleeping between reads, in ms. */
  waitedMs: number;
  /** What the final read established. */
  verdict: PostflightVerdict;
}

/**
 * The whole poll window, as ONE exported constant (#445 SC-4).
 *
 * #407 shipped the window as two numbers — ten attempts, three seconds apart
 * — so widening it meant reasoning about their product, and the next person
 * to widen it would raise whichever one they noticed. One constant, one edit,
 * and `POSTFLIGHT_DELAY_MS` below cannot change the window no matter what it
 * is set to. The positive control in `test/release-guard.test.ts` proves the
 * guard still refuses an absent version, so widening this cannot quietly turn
 * the check off.
 */
export const POSTFLIGHT_BUDGET_MS = 120_000;

/** How often to re-read inside the budget. A cadence, not a budget knob. */
export const POSTFLIGHT_DELAY_MS = 5_000;

/** Reads the budget buys at a given cadence. The first read costs no wait. */
export function postflightAttempts(budgetMs: number, delayMs: number): number {
  return Math.floor(budgetMs / delayMs) + 1;
}

/**
 * Poll the registry until it serves `treeVersion`, or give up and refuse (#407).
 *
 * `v0.3.0` published cleanly and the release job still went red: the
 * postflight read `registry.npmjs.org/rungate` about a second after `npm
 * publish` returned, and that document is CDN-fronted and eventually
 * consistent, so it was still serving `0.2.1`. The publish was fine. The check
 * was wrong.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is about checks that cannot
 * fail. This is the inverse and it costs the same thing, because the message
 * is wrong either way — and a red job over a green release is how a gate
 * teaches people to stop reading it.
 *
 * ## The bound is the point
 *
 * Retrying until it goes green would turn this into the defect in the other
 * direction. The loop is bounded, a version that never appears is never
 * reported as published, and the reading says how many times it looked and
 * for how long — so a reader can tell a bounded search from an impatient one
 * without the guard having to interpret the number for them.
 *
 * ## What it stopped claiming (#445)
 *
 * Exhausting the budget used to produce a refusal naming a cause. It now
 * produces `verdict.unmeasured`, which names both causes and neither. See
 * `postflightVerdict`.
 *
 * ## Why an intermediate throw retries and the last one does not
 *
 * A transient network error is exactly what polling is for, so a read that
 * throws with attempts remaining is retried. The FINAL one rethrows, because
 * `registryState` throws rather than returning an empty state precisely so
 * that "could not measure" cannot read as "nothing wrong" — and swallowing
 * the last throw here would put that fail-open back.
 *
 * `sleep` is injectable so the exhaustion case can be driven in a test without
 * spending 30 seconds of wall clock on it.
 */
export async function awaitRegistryServes(
  pkg: string,
  treeVersion: string,
  opts: {
    fetchImpl?: typeof fetch;
    base?: string;
    budgetMs?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PostflightReading> {
  const budgetMs = opts.budgetMs ?? POSTFLIGHT_BUDGET_MS;
  const delayMs = opts.delayMs ?? POSTFLIGHT_DELAY_MS;
  // An unbounded budget is the defect in the other direction — a poll that
  // retries until it goes green cannot fail — and a zero delay divides the
  // budget by nothing and never terminates.
  if (!Number.isFinite(budgetMs) || budgetMs < 0 || !Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error(
      `postflight needs a finite non-negative budget and a positive delay, got ` +
        `${opts.budgetMs} / ${opts.delayMs}`,
    );
  }
  const attempts = postflightAttempts(budgetMs, delayMs);
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));

  let waitedMs = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const last = attempt === attempts;
    let state: RegistryState;
    try {
      state = await registryState(pkg, opts.fetchImpl ?? fetch, opts.base);
    } catch (e) {
      // A transient error is exactly what polling is for. The FINAL one
      // rethrows, because `registryState` throws rather than returning an
      // empty state precisely so that "could not measure" cannot read as
      // "nothing wrong", and swallowing it here would put that back.
      if (last) throw e;
      await sleep(delayMs);
      waitedMs += delayMs;
      continue;
    }

    const verdict = postflightVerdict(pkg, treeVersion, state, { attempts: attempt, waitedMs });
    if (verdict.published || last) {
      return { latest: state.latest, attempts: attempt, waitedMs, verdict };
    }
    await sleep(delayMs);
    waitedMs += delayMs;
  }

  /* c8 ignore next */
  throw new Error("unreachable: the loop returns on its last attempt");
}

/**
 * What `npm publish` said about its own result (#472).
 *
 * The postflight has refused three consecutive successful releases — 0.3.0,
 * 0.4.0, 0.4.1 — and the last missed by 48 seconds. #407 answered that by
 * widening the budget and #445 by fixing the wording, and both left the same
 * mechanism in place: a blind poll of an eventually-consistent document,
 * guessing at how long propagation takes.
 *
 * The evidence was already on the page. The publish step's own output says:
 *
 * ```
 * npm notice Your package is being processed and may take a few minutes to become available.
 * + rungate@0.4.1
 * ```
 *
 * So the registry is not silent about the asynchrony — it states it, in the
 * step immediately above the one guessing at it, and it issues a RECEIPT. That
 * receipt is written synchronously at publish time and the packument is not,
 * which is the entire reason the two readings disagree.
 */
export interface PublishReceipt {
  /** The version on npm's `+ pkg@version` line, or null if there is no such line. */
  version: string | null;
  /** npm's own statement that the registry read will lag behind this publish. */
  propagationWarned: boolean;
  /** Bytes of log read, so an empty file is distinguishable from a missing line. */
  bytes: number;
}

/** Regex-safe form of a package name, which may contain `@`, `/`, `.` and `-`. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

/**
 * Read npm's receipt out of the publish step's captured output.
 *
 * The `+ name@version` line is npm's statement that the registry ACCEPTED the
 * publish. Anchored to the start of a line so a version named in prose — and
 * `npm notice` prints the name and version several times — cannot be mistaken
 * for the receipt.
 */
export function parsePublishReceipt(pkg: string, log: string): PublishReceipt {
  // ANSI is STRIPPED first. npm colourises `+ pkg@version` whenever it
  // believes it is on a TTY, and `FORCE_COLOR` is set by plenty of CI images
  // — with colour the anchor never matches, the guard finds no receipt and
  // REFUSES a release that published perfectly. Fail-closed, but it is #472's
  // own symptom arriving through the fix for #472. Found by the security
  // review of the first commit.
  const plain = log.replace(/\u001b\[[0-9;]*m/g, "");
  // Leading whitespace is tolerated and TRAILING content is not: an indent
  // comes from a log wrapper, whereas text after the version is a different
  // statement — `+ rungate@0.4.1 (dry-run)` must not read as a publish.
  const m = plain.match(new RegExp(`^[ \\t]*\\+\\s*${escapeForRegex(pkg)}@(\\S+)[ \\t]*$`, "m"));
  return {
    version: m ? m[1] : null,
    propagationWarned: /being processed and may take/i.test(plain),
    bytes: log.length,
  };
}

/** What the postflight concluded, and which exit code says so. */
export interface PostflightDecision {
  /** `confirmed` exits 0, `refused` exits REFUSE_EXIT, `unmeasured` exits UNMEASURED_EXIT. */
  outcome: "confirmed" | "refused" | "unmeasured";
  /** The whole message, already worded for the reader of a failed release job. */
  message: string;
}

/**
 * The ONE binding that decides whether a release happened (#472).
 *
 * Two questions were being asked as one, and only the second of them is slow:
 *
 * | Question | Answerable | Evidence |
 * |---|---|---|
 * | did npm ACCEPT this publish? | synchronously, at publish time | the `+ pkg@version` receipt |
 * | does the registry SERVE it? | eventually, minutes later | the packument |
 *
 * The postflight exists to catch a pipeline that quietly did nothing — a
 * skipped `if:`, a swallowed error, a duplicate npm rejected. **The receipt
 * catches all three and catches them immediately**: a skipped step produces no
 * output, a swallowed error produces no `+` line, and a rejected duplicate
 * makes npm exit non-zero with an E403 and no receipt. It is a strictly better
 * detector for the thing the check is for, and it does not need a budget.
 *
 * So propagation stops being fatal — but ONLY when the receipt corroborates
 * it. With a receipt naming this version, an exhausted budget is a known
 * propagation delay and the job passes with the delay stated out loud. With
 * NO receipt available, exhaustion is still `unmeasured` and still stops the
 * job, which is #445's behaviour unchanged. That fall-back is what keeps this
 * able to fail if the log capture is ever removed from the workflow.
 *
 * **Two deciders, and each has an input only it can reach**
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). The receipt
 * is the only thing that can see a publish npm rejected while the registry
 * still serves a previous version; the packument read is the only thing that
 * can see a receipt for a version the registry never accepted. Neither
 * subsumes the other, and the test gives each a case the other passes.
 */
export function postflightDecision(
  pkg: string,
  treeVersion: string,
  reading: PostflightReading,
  receipt: PublishReceipt | null,
): PostflightDecision {
  // The receipt is checked FIRST and refuses on its own, before the registry
  // is consulted at all. A publish step that reported no success is an
  // ESTABLISHED failure, not an ambiguous reading — and checking it after the
  // registry would let a packument that happens to serve the version (because
  // it was published last month) wave through a step that did nothing today.
  if (receipt !== null) {
    if (receipt.version === null) {
      return {
        outcome: "refused",
        message:
          `the publish step produced no receipt. npm prints \`+ ${pkg}@${treeVersion}\` ` +
          `on a successful publish and the captured output (${receipt.bytes} bytes) has ` +
          `no such line, so the registry did not accept a publish in this job. A skipped ` +
          `step, a swallowed error and a duplicate version npm rejected all look like ` +
          `this, and all three are a release that did not happen.`,
      };
    }
    if (receipt.version !== treeVersion) {
      return {
        outcome: "refused",
        message:
          `the publish step published ${pkg}@${receipt.version}, but this tree is ` +
          `${treeVersion}. The receipt and package.json must name the same version or ` +
          `the tag describes something that was never shipped.`,
      };
    }
  }

  if (reading.verdict.published) {
    return {
      outcome: "confirmed",
      message:
        `the registry serves ${pkg}@${treeVersion} ` +
        `(read ${reading.attempts} time${reading.attempts === 1 ? "" : "s"}, ` +
        `waited ${Math.round(reading.waitedMs / 1000)}s)` +
        (reading.verdict.note ? `\npostflight note: ${reading.verdict.note}` : ""),
    };
  }

  // Absent from the packument. With a receipt this is no longer ambiguous:
  // npm said it accepted the publish, and said in the same breath that the
  // registry would lag. Passing here is a fail-open and it is deliberate, so
  // it is LOUD — `.claude/rules/config-access.md` permits the tradeoff and
  // forbids the silent version.
  // BOTH halves are required, and the second is the one the security review
  // of the first commit found inert. `propagationWarned` was parsed, carried
  // and printed while deciding nothing: a receipt alone waived the registry
  // read whether or not npm had said the registry would lag. That made the
  // live pipeline unable to fail here at all — the workflow always passes
  // `--publish-log`, so every real release took this branch — which is the
  // defect `.claude/rules/checks-must-be-able-to-fail.md` is about, inside
  // the commit whose subject is that defect.
  //
  // Requiring npm's own statement keeps the waiver tied to evidence. If npm
  // stops printing it the release goes UNMEASURED and someone reads this
  // comment, which is the fail-closed direction a release gate owes.
  if (receipt !== null && receipt.version === treeVersion && receipt.propagationWarned) {
    return {
      outcome: "confirmed",
      message:
        `PROPAGATION PENDING — npm accepted ${pkg}@${treeVersion} and the registry is ` +
        `not serving it yet after ${reading.attempts} read` +
        `${reading.attempts === 1 ? "" : "s"} over ${Math.round(reading.waitedMs / 1000)}s. ` +
        `This is NOT a confirmed read of the registry; it is the publish receipt plus ` +
        `npm's own statement that the packument lags. The release is treated as landed ` +
        `because the receipt is written synchronously and the packument is not. ` +
        `Verify with \`${confirmCommand(pkg, treeVersion)}\`.`,
    };
  }

  // A receipt with no lag warning is NOT waived. npm accepted something and
  // did not say the registry would be slow, so the absence is unexplained and
  // the guard says so rather than picking the convenient reading.
  if (receipt !== null && receipt.version === treeVersion) {
    return {
      outcome: "unmeasured",
      message:
        `UNMEASURED: npm printed a receipt for ${pkg}@${treeVersion} but did NOT print its ` +
        `"being processed and may take a few minutes" notice, and the registry is still not ` +
        `serving the version after ${reading.attempts} read` +
        `${reading.attempts === 1 ? "" : "s"} over ${Math.round(reading.waitedMs / 1000)}s. ` +
        `A receipt waives the registry read only when npm itself says the read will lag. ` +
        `Settle it with \`${confirmCommand(pkg, treeVersion)}\`.`,
    };
  }

  return { outcome: "unmeasured", message: reading.verdict.unmeasured ?? "no reading was taken" };
}
