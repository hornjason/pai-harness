#!/usr/bin/env bun
/**
 * Adjudicate an AI review's findings payload (#675).
 *
 * Usage:
 *   bunx rungate ai-review-findings <path-to-findings.json>     # a consumer
 *   bun bin/rungate.ts ai-review-findings <path>                # this repo
 *
 * The reading, the severity table, the contradiction check and the exit code
 * all live in `lib/scaffold/ai-review-findings.ts` and none of them is
 * restated here. This file exists for ONE reason, and it is a reachability
 * problem rather than a logic one.
 *
 * ## Why a wrapper, when the module already has a `main`
 *
 * `lib/scaffold/ai-review-findings.ts` ends with
 * `if (import.meta.main) process.exit(main(process.argv.slice(2)))` and its
 * `main` is documented as "the CLI the generated workflow step runs". Two
 * things stop that being reachable from a scaffolded project:
 *
 * - **A consumer has no copy of rungate's sources at a path it can name.**
 *   The reader is inside the installed package, and the generated workflow
 *   cannot hardcode `node_modules/rungate/lib/scaffold/…` without becoming a
 *   second declaring position for a path the package controls.
 *   `lib/cli-commands.ts` is the one place that says where a command lives,
 *   and `test/cli-contract.test.ts` holds it to `package.json`'s `files`.
 * - **`import.meta.main` is FALSE under the dispatcher.** `bin/rungate.ts`
 *   rewrites `process.argv` and then `await import(script)` — the import IS
 *   the invocation — so a module guarded on `import.meta.main` loads, runs
 *   nothing, and the dispatcher exits 0. That is a subcommand that reports
 *   success having adjudicated nothing, which is the exact shape of defect
 *   #675 is about. This file calls `main` unconditionally, so there is no
 *   state in which it is dispatched and does not decide.
 *
 * The exit code is the module's, not this file's. `aiReviewExitCode` routes
 * every refusal through `AI_REVIEW_REQUIRED_EXIT` in
 * `lib/scaffold/ai-review-step.ts`, which is the one constant a mutant zeroes
 * — see `test/ai-review-exit-binding.test.ts`. A `process.exit(1)` written
 * here would be a second non-zero exit that the mutation cannot reach, and
 * the case would go green over a refusal that no longer came from the
 * constant.
 *
 * ## The one thing this file supplies rather than forwards (CRC-B4)
 *
 * `aiReviewJuryGate` — the verifier quorum that counts the ballot before a
 * finding is allowed to block. It is handed in here because the reader
 * cannot import it: three mutation batteries copy
 * `lib/scaffold/ai-review-findings.ts` into a scratch directory carrying
 * only its one dependency, and this gate pulls the finding arbiter and the
 * filing gate behind it. A mutant that died on module resolution would
 * report zero findings, which reads exactly like a guard behaving
 * differently.
 *
 * **The ballot directory binds HERE, out of the environment, and never as
 * a third positional.** `argumentsBeyondTheContract` refuses `argv[2]` and
 * up, and one invocation it catches is a changed-file path containing a
 * space that an unquoted expansion word-split in two (CF-6 in
 * `test/ai-review-changed-files-step.test.ts`). Widening the argv contract
 * by one slot to carry a ballot would make that refusal an accepted argv
 * whose second half is read as a directory, so the refusal keeps its full
 * width and the path arrives by a channel word-splitting cannot reach.
 *
 * With no `AI_REVIEW_BALLOT_DIR_ENV` set, the gate handed over is `null`
 * and the reader behaves exactly as it did before the group existed. There
 * is no third state: a ballot directory nothing can read is impossible
 * here rather than refused, because the reader never learns a path it has
 * no gate for. `test/ai-review-findings-command.test.ts` holds this file
 * to supplying the gate when the variable is set.
 */
import { aiReviewJuryGate } from "../lib/ai-review-jury";
import { main } from "../lib/scaffold/ai-review-findings";
import { AI_REVIEW_BALLOT_DIR_ENV } from "../lib/scaffold/ai-review-step";

const ballotDir = process.env[AI_REVIEW_BALLOT_DIR_ENV];

process.exit(
  main(
    process.argv.slice(2),
    ballotDir === undefined || ballotDir === ""
      ? null
      : blocking => aiReviewJuryGate(blocking, ballotDir),
  ),
);
