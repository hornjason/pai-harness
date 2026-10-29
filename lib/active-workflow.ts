/**
 * Which directories under the work dir hold a LIVE run (#1648).
 *
 * `hooks/VerifyPhaseLock.hook.ts` picks the most recently modified
 * `workflow-state.json` under `$RUNGATE_WORK_DIR` and refuses
 * `gh issue create` when its phase is `VERIFY`. It scans each entry and then
 * each entry's subdirectories, which is how a run nested one level deep is
 * found — and it is also how `.archive/<slug>/workflow-state.json` is found,
 * because `.archive` is just another directory to `readdirSync`.
 *
 * **Measured 2026-10-29 on this machine.** The newest state file anywhere
 * under `~/.rungate` was
 * `.archive/pai-harness-892/workflow-state.json`, modified 21 October, phase
 * `VERIFY`. Three live run directories existed and none of them was in
 * VERIFY: `pai-harness-169` DONE, `pai-harness-630` DONE, `pai-harness-65`
 * GOAL. So every `gh issue create` reaching Bash on this machine had been
 * refused for eight days on behalf of a run that finished, and the refusal
 * named a `verifyBlockers[]` array in a file nobody was writing to.
 *
 * That is the worst failure mode a workflow gate has. It does not look like a
 * bug — it looks like the gate working — and the documented way out is to
 * apply an override label, so the pressure it creates is to mislabel issues.
 * `lib/issue-create-override.ts` already records that happening once: #362,
 * #363 and #364 all wear `follow-up` and none of them is follow-up work.
 *
 * ## The rule, and why it is about the dot and not about `.archive`
 *
 * A run directory is named for the slug of the run — `pai-harness-892`,
 * `agentgrit-311`. Nothing names a run with a leading dot, and the work dir's
 * own bookkeeping is what uses them. So the predicate is "not hidden" rather
 * than "not `.archive`": a list of one name has to be extended by whoever adds
 * the second kind of bookkeeping directory, and they will not know to.
 *
 * ## It has to guard BOTH readings
 *
 * The hook reads twice — `<run>/workflow-state.json` and
 * `<run>/<sub>/workflow-state.json` — and the first version of this fix
 * filtered only the outer one. That leaves the same defect one level deeper:
 * a hidden bookkeeping directory INSIDE a live run is still read, and being
 * written last it still outranks the live run by mtime.
 *
 * One filtered reading beside one unfiltered reading of the same question is
 * the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`. No
 * behavioural case can tell them apart while the outer one is right, so the
 * end-to-end suite plants `<run>/.archive` directly and the mutation that
 * removes the inner guard reddens exactly that case and no other.
 */

/**
 * Does this entry under the work directory hold a run that is still going?
 *
 * Hidden entries are the work dir's own bookkeeping, not runs. `.archive` is
 * the one that exists today and the one that caused #1648.
 */
export function isRunDirectory(name: string): boolean {
  return !name.startsWith(".");
}
