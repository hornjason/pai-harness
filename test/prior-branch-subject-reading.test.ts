import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { detectPriorBranch, isHarnessScratchRef } from '../lib/prior-branch'

/**
 * #900 — `detectPriorBranch` reads a prior branch two ways and only one of
 * them was ever executed.
 *
 *     .filter(c => refs(c.branch) || prose(c.subject))
 *
 * The `prose(c.subject)` half exists for a stated case: ship.js commits
 * `fix(#${ISSUE}): ${title}`, so a branch called `fix/strict-matchers` —
 * carrying no number in its NAME — is still findable through its tip subject.
 *
 * Nothing drove it. Measured during #887 as battery row M10: replacing
 * `issueProseReference`'s body with the far narrower `issueClosingReference`,
 * which cannot match `fix(#209):` at all and therefore destroys the subject
 * reading outright, was **1 red of 55** — and that one red was a pure
 * predicate case #887 had just added. No case built a repository with a
 * number-less branch name and a `fix(#N):` tip subject.
 *
 * So the reading was witnessed by a text probe (SC-870, a `contains` check on
 * the expression) and by a predicate unit test, and by nothing that executed
 * the behaviour the expression is there for. A literal match can see that the
 * expression is still written down. It cannot see that the binding still
 * WORKS.
 *
 * ## Two deciders, two inputs
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape: two deciders
 * answering one question about one input are behaviourally ONE decider, and a
 * mutation of either leaves the other holding the case up. Both readings are
 * real and both are wanted, so this file takes the other option — each gets an
 * input that only it can reach, written down as its own case saying which
 * decider it is for:
 *
 *   SUBJECT-ONLY  name has no number, tip subject is `fix(#N): …`
 *   REF-ONLY      name has the number, tip subject names no issue
 *
 * Delete the subject reading and only the first goes red; delete the ref
 * reading and only the second does. Neither mutation can hide behind the
 * other, which is the whole point of building two fixtures instead of one.
 */

const SUBJECT_ONLY_ISSUE = 4242
const REF_ONLY_ISSUE = 4243
const BODY_ONLY_ISSUE = 4244

let repo: string

/** Run git in the fixture, failing loudly — a fixture that half-built is not a fixture. */
function git(args: string[], cwd = repo): string {
  const got = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (got.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${got.stderr || got.stdout}`)
  }
  return got.stdout.trim()
}

/** A commit on a new branch, with the subject spelled exactly as given. */
function branchWithSubject(branch: string, subject: string, file: string) {
  git(['checkout', '-q', '-b', branch, 'main'])
  writeFileSync(join(repo, file), `${branch}\n`)
  git(['add', file])
  git(['commit', '-q', '-m', subject])
  git(['checkout', '-q', 'main'])
}

beforeAll(() => {
  // mkdtemp, never a fixed in-repo scratch dir, and never the real repository:
  // the sibling suite plants its branch in this checkout, which is shared with
  // every other worktree and with whatever else is running.
  repo = mkdtempSync(join(tmpdir(), 'rungate-900-'))
  git(['init', '-q', '--initial-branch=main'], repo)
  git(['config', 'user.email', 'fixture@example.invalid'])
  git(['config', 'user.name', 'fixture'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(['add', 'base.txt'])
  git(['commit', '-q', '-m', 'chore: base'])

  // SUBJECT-ONLY. The name is the real one from the call-site comment.
  branchWithSubject(
    'fix/strict-matchers',
    `fix(#${SUBJECT_ONLY_ISSUE}): narrow the matcher`,
    'matchers.txt',
  )

  // REF-ONLY. The subject names no issue at all, so only the name can match.
  branchWithSubject(`fix/${REF_ONLY_ISSUE}-named-branch`, 'chore: unrelated work', 'named.txt')

  // BODY-ONLY. The subject names nothing; the number is in the message BODY.
  // The reading is `%(contents:subject)` and must stay that way: a commit
  // body is prose, and prose citing an issue is not a claim to be working on
  // it — which is #887 exactly, arriving at the other reading.
  git(['checkout', '-q', '-b', 'chore/body-citation', 'main'])
  writeFileSync(join(repo, 'body.txt'), 'body\n')
  git(['add', 'body.txt'])
  git(['commit', '-q', '-m', 'chore: tidy up', '-m', `see #${BODY_ONLY_ISSUE} for the measurement`])
  git(['checkout', '-q', 'main'])

  // A harness scratch ref carrying the SAME subject as the subject-only
  // branch. #185 excluded these by name; widening to subjects must not
  // readmit them.
  //
  // DATED INTO THE FUTURE, and that is the whole of the case. The selector is
  // "most recent wins", and three commits made in the same second share a
  // committerdate, so the tie-break fell to for-each-ref's ordering —
  // `fix/…` sorts before `worktree-…`, and the right branch won for a reason
  // that has nothing to do with the exclusion. Measured: with equal dates,
  // deleting `isHarnessScratchRef` from `listCandidateRefs` was 0 red. The
  // fixture reached its assertion without the feature (#500). An hour ahead,
  // the scratch ref wins the tie-break whenever it is admitted at all, so the
  // only thing keeping it out of the result is the exclusion.
  const ahead = new Date(Date.now() + 3_600_000).toISOString()
  git(['checkout', '-q', '-b', 'worktree-wf_5e3ed885-98c-9', 'main'])
  writeFileSync(join(repo, 'scratch.txt'), 'scratch\n')
  git(['add', 'scratch.txt'])
  spawnSync('git', ['commit', '-q', '-m', `fix(#${SUBJECT_ONLY_ISSUE}): narrow the matcher`], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, GIT_COMMITTER_DATE: ahead, GIT_AUTHOR_DATE: ahead },
  })
  git(['checkout', '-q', 'main'])
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

const find = (issueNumber: number) =>
  detectPriorBranch({ issueNumber, projectRoot: repo, runTests: false })

describe('#900: the subject reading is executed, not merely written down', () => {
  test('AC-0: the fixture really is the shape these cases claim', () => {
    // Without this the two cases below could pass against a repository that
    // does not hold what they describe — a fixture is an input and an
    // unverified input is not evidence. Both directions of each name.
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n')
    expect(branches).toContain('fix/strict-matchers')
    expect(branches).toContain(`fix/${REF_ONLY_ISSUE}-named-branch`)

    expect(
      'fix/strict-matchers'.includes(String(SUBJECT_ONLY_ISSUE)),
      'the subject-only branch NAME carries the number, so the ref reading could find it',
    ).toBe(false)
    expect(
      git(['log', '-1', '--format=%s', `fix/${REF_ONLY_ISSUE}-named-branch`]),
      'the ref-only branch SUBJECT names an issue, so the subject reading could find it',
    ).not.toContain('#')
  })

  test('AC-1: SUBJECT-ONLY — a branch whose name carries no number is found', () => {
    // The case #887's row M10 proved did not exist. This is the one the
    // subject reading is FOR, and the only one that goes red when it is
    // deleted.
    return find(SUBJECT_ONLY_ISSUE).then(got => {
      expect(got, 'a branch findable only by its tip subject was not found').not.toBeNull()
      expect(got?.branch).toBe('fix/strict-matchers')
    })
  })

  test('AC-2: REF-ONLY — a branch whose subject names nothing is found by name', () => {
    // The mirror. Without it, deleting the REF reading would be caught by
    // nothing here, and the two readings would be one decider wearing two
    // names as far as this file could tell.
    return find(REF_ONLY_ISSUE).then(got => {
      expect(got, 'a branch findable only by its name was not found').not.toBeNull()
      expect(got?.branch).toBe(`fix/${REF_ONLY_ISSUE}-named-branch`)
    })
  })

  test('AC-3: a harness scratch ref is not readmitted by the subject reading', () => {
    // The scratch branch carries the SAME subject as the subject-only branch,
    // so a subject reading applied before the #185 exclusion would match it.
    // It must lose to the real branch rather than merely be absent — which is
    // why the assertion names the winner instead of asserting non-null.
    expect(isHarnessScratchRef('worktree-wf_5e3ed885-98c-9')).toBe(true)
    return find(SUBJECT_ONLY_ISSUE).then(got => {
      // Non-null FIRST. `expect(undefined).not.toMatch(/^worktree-/)` is
      // satisfied by finding nothing at all, so a detector that returned null
      // for everything would pass this case — the scratch ref is excluded and
      // so is the branch we want (#518: establish presence before comparing).
      expect(got, 'nothing was found, so the exclusion was not what this witnessed').not.toBeNull()
      expect(got?.branch, 'a scratch ref was returned as prior work').not.toMatch(/^worktree-/)
    })
  })

  test('AC-5: a number in the commit BODY is a citation, not a claim', () => {
    // The reading is `%(contents:subject)`, and this is the case that says
    // so. Widening it to `%(contents)` makes every commit whose message
    // mentions an issue into that issue's prior work — #887's defect,
    // arriving at the reading #887 deliberately left alone.
    //
    // Added because the battery row for that widening had no distinguishing
    // input without it: no other fixture here has a multi-line message, so
    // the mutant and the original agreed on every input the suite had. A row
    // like that is the code run twice, not a mutation.
    expect(
      git(['log', '-1', '--format=%b', 'chore/body-citation']),
      'the fixture no longer carries the number in its body',
    ).toContain(`#${BODY_ONLY_ISSUE}`)
    expect(
      git(['log', '-1', '--format=%s', 'chore/body-citation']),
      'the number leaked into the subject, so this fixture proves nothing',
    ).not.toContain('#')
    return find(BODY_ONLY_ISSUE).then(got => {
      expect(got, 'a body citation was read as prior work').toBeNull()
    })
  })

  test('AC-4: an issue with neither reading matching is still null', () => {
    // The control. Both cases above are satisfied by a detector that returns
    // the first branch it sees, and this is what rules that out.
    return find(999_999).then(got => expect(got).toBeNull())
  })
})
