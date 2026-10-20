/**
 * The one extension point a consumer has INSIDE a rungate-managed CI job
 * (#529).
 *
 * `resolveManagedWrite` preserves whole JOBS a consumer adds and refuses
 * rather than dropping one, so the ownership boundary has always been
 * job-level. That boundary cannot express "run this before the suite": jobs
 * do not share a filesystem, so a consumer-owned job cannot seed the tree the
 * test job tests. The only thing left is to edit the managed job, which works
 * until the next re-scaffold.
 *
 * The repository that filed #529 carries the scar in its own `ci.yml` — a
 * comment above an edited `- run:` line explaining that a re-scaffold will
 * revert it. **A consumer documenting that their own edit will be reverted is
 * the feature request.**
 *
 * ## What this is, in one sentence
 *
 * The generated job always runs `scripts/ci-setup.sh` when the tree has one.
 * Rungate owns 100% of the YAML; the consumer owns a file rungate never reads,
 * never writes and never mentions in an ownership table.
 *
 * ## Why the step is emitted unconditionally, not "when the file exists"
 *
 * The obvious shape is a generation-time `existsSync` — emit the step for
 * trees that have the script, omit it for trees that do not. It produces a
 * tidier file and it is the wrong decision, because **generation happens once
 * and the tree keeps moving.** A consumer who adds `scripts/ci-setup.sh` the
 * week after scaffolding gets a file with no extension point in it, their
 * script never runs, and nothing anywhere says so: a green CI run over a tree
 * that was never set up (`.claude/rules/config-access.md`, *Silent Default
 * Substitution*). The existence question belongs at the moment the answer is
 * used, which is run time.
 *
 * ## Why both arms print
 *
 * `0`, `{}`, `SKIP` and silence are indistinguishable from success. A step
 * that quietly does nothing when the file is absent cannot be told from one
 * that ran a script which happened to do nothing, and an operator debugging a
 * tree that was not seeded has no line to search for. Both branches name the
 * path and say which happened.
 *
 * ## Why `-f` and `bash`, not `-x`
 *
 * The executable bit is one byte of filesystem state that git preserves and
 * most editors, `cp`, and every zip-based download do not. `[ -x ]` turns a
 * missing mode bit into a silently skipped setup — #492's one-byte row, with
 * the guard on the other side. `-f` plus an explicit interpreter has no mode
 * bit in it. A consumer who needs another language execs it from the script.
 *
 * ## Why it is a NAMED step with a block scalar, and not `- run:`
 *
 * `testCommandsNamedByCiWorkflow` reads the suite job's **first** `- run:`
 * line that is not known setup, and calls it the project's test command. A
 * setup step written `- run: bash scripts/ci-setup.sh` would be read as the
 * test command by every position check in the tree, and #621's agreement
 * binding would report the project's test command three different ways. A
 * `- name:` step with a `run: |` body is invisible to that regex, which is
 * why every other multi-line step in the generated files is already written
 * that way. `test/ci-setup-step.test.ts` holds that, rather than this comment.
 *
 * ## Failure is terminal, deliberately
 *
 * No `|| true`. A setup script that fails has left the tree in a state the
 * suite was not written against, and a green suite over it is the least
 * useful thing CI can produce.
 */

/**
 * The conventional path. One declaration: the generator, the prose and every
 * test read this, so a rename cannot half-apply.
 */
export const CI_SETUP_SCRIPT = "scripts/ci-setup.sh";

/**
 * The step, indented for the `steps:` list of a generated job.
 *
 * Returns the leading newline too, so a call site concatenates it the way the
 * typecheck and global-tools steps beside it are concatenated.
 */
export function ciSetupStep(): string {
  return `
      - name: Consumer setup (${CI_SETUP_SCRIPT}, optional)
        run: |
          # rungate's one extension point inside this managed job (#529).
          # The script is yours; this file is not. Re-scaffolding rewrites the
          # YAML around this step and never touches ${CI_SETUP_SCRIPT}.
          # Both branches print: a step that is silent when the file is absent
          # cannot be told from one that ran and did nothing.
          if [ -f ${CI_SETUP_SCRIPT} ]; then
            echo "rungate: running ${CI_SETUP_SCRIPT} before the suite (#529)"
            bash ${CI_SETUP_SCRIPT}
          else
            echo "rungate: no ${CI_SETUP_SCRIPT} in this tree, so no consumer setup ran (#529)"
          fi`;
}
