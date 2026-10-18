---
doc-type: research
governs: .github/workflows/
created: 2026-10-18
status: active
owner: jason
updated: 2026-10-18
---

# PR review + triage tooling: replacing Copilot as the review gate

## Why this exists

Copilot code review kept running out of credits. Everything below was verified
against vendor documentation on 2026-10-18. Anything not verified that day is
marked **unverified** and should not be acted on without checking.

## 1. What actually changed, and why the credits run out

Copilot moved off premium requests onto **GitHub AI Credits** on 2026-06-01.
1 AI credit = $0.01.

| Plan | Price | Credits/mo (base + flex) |
|---|---|---|
| Pro | $10 | $15 |
| Pro+ | $39 | $70 |
| Max | $100 | $200 |

A single code review costs, per GitHub's own docs:

| Effort | AI credits per review |
|---|---|
| Lite | $0.05 – $1 |
| Balanced (**default**) | $0.25 – $5 |

So Copilot Pro's $15/month buys **as few as 3 Balanced reviews** at the top of
that range. Three further facts compound it:

1. **There is no fallback any more.** GitHub: *"Fallback experiences will no
   longer be available."* Pre-June, exhausting your quota dropped you to a
   cheaper model. Now it stops.
2. **Code review bills a second meter.** Since 2026-06-01 it also consumes
   GitHub Actions minutes. Self-hosted runners consume no Actions minutes.
3. **Balanced is the default.** Effort resolution order is: level chosen at
   request → level previously used on that PR → requestor setting → repository
   setting → org setting → GitHub's default, which is Balanced.

**Immediate mitigation, no tool change:** set the repository default effort to
Lite. That is a 5–10× reduction on the credit meter.

Sources: [premium requests](https://docs.github.com/en/copilot/concepts/billing/copilot-requests) ·
[usage-based billing announcement](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) ·
[plans & pricing](https://github.com/features/copilot/plans) ·
[code review docs](https://docs.github.com/en/copilot/concepts/agents/code-review)

## 2. The distinction that matters: advisory vs gate

Most "AI code review" products **cannot fail a PR**. They post comments. To be
a gate, a tool must emit a check run that can conclude as a failure and be
marked required in branch protection.

| Tool | Blocks a merge? | Evidence |
|---|---|---|
| GitHub Copilot code review | No — comments only | — |
| Anthropic Code Review (hosted) | **No, by design** | Docs: *"A review never approves or blocks the pull request"*; *"The check run doesn't conclude as a failure."* |
| CodeRabbit | Yes, via pre-merge checks in `error` mode + required status | [pre-merge checks](https://www.coderabbit.ai/blog/pre-merge-checks-built-in-and-custom-pr-enforced) |
| `anthropics/claude-code-action` | **Yes** — you own the workflow, so you own the exit code | [docs](https://code.claude.com/docs/en/github-actions) |
| Qodo PR-Agent (OSS, self-host) | Yes — you write the gating logic | unverified in detail |
| Robin Review | Non-blocking check by default | unverified |
| OrcaCode Review | Yes — P0/P1 fail the check | unverified |
| SonarCloud | Yes — Quality Gate status check | vendor docs, see §7 |
| Semgrep | Yes — policy engine blocks | vendor docs, see §7 |
| Codacy | Yes — required status check | unverified ($18/dev/mo, unverified) |
| Ellipsis | Yes — `request_changes` on fail | unverified |
| Sourcery | No — auto-approves only | unverified |
| Graphite Diamond | No — advisory | unverified |

## 3. The billing fact that decides this

From Anthropic's GitHub Actions docs, verbatim:

> **"If you authenticate with an OAuth token, runs use your Claude subscription
> instead of API billing."**

And from the authentication docs on `claude setup-token`:

> **"This token authenticates with your Claude subscription and requires a Pro,
> Max, Team, or Enterprise plan."**

The token is a one-year OAuth token, explicitly intended for *"CI pipelines and
scripts where browser login isn't available"*, stored as the
`CLAUDE_CODE_OAUTH_TOKEN` secret and passed as the `claude_code_oauth_token`
input.

**Precedence gotcha:** `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` in
Claude Code's credential order. If both are set in a workflow, the API key wins
silently and you get billed. Set only one.

**Bare mode gotcha:** `--bare` does not read `CLAUDE_CODE_OAUTH_TOKEN`.

### What this does NOT remove

It trades a **dollar credit pool** for a **subscription rate limit**. A CI job
consuming Max 5-hour windows competes with interactive sessions. This is a real
constraint, not a free lunch — but it fails differently: a rate limit recovers
on a clock, a credit pool does not recover until the 1st of the month.

## 3b. Third billing path: route through Vertex AI

If you have Claude model access on a Google Cloud org account, the action
routes inference through it and **needs no Anthropic API key and no Claude
subscription at all**. Set `use_vertex: "true"`.

Auth is Workload Identity Federation over the workflow's OIDC token, so no
static cloud credential is stored in the repo:

```yaml
- name: Authenticate to Google Cloud
  id: auth
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
    service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

- uses: anthropics/claude-code-action@v1
  with:
    github_token: ${{ steps.app-token.outputs.token }}
    use_vertex: "true"
    claude_args: '--model claude-sonnet-5'
  env:
    ANTHROPIC_VERTEX_PROJECT_ID: ${{ steps.auth.outputs.project_id }}
    CLOUD_ML_REGION: us-east5
```

GCP-side prerequisites: enable IAM Credentials, STS, and
`aiplatform.googleapis.com`; create a Workload Identity Pool with a GitHub OIDC
provider (issuer `https://token.actions.githubusercontent.com`) and an
attribute condition scoping it to the repo; create a service account holding
only `roles/aiplatform.user` and let the pool impersonate it. Secrets:
`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`.

**Why this is the strongest option when available:** inference bills to the GCP
project at Vertex rates. No credit pool that empties on the 1st, and no
competition with interactive Max rate-limit windows.

**Entitlement is already confirmed for local use.** Verified 2026-10-18 from the
live environment: `CLAUDE_CODE_USE_VERTEX=1`,
`ANTHROPIC_VERTEX_PROJECT_ID=itpc-gcp-global-revenue-claude`, `CLOUD_ML_REGION=us`,
set in `~/.claude/settings.json`. Claude Code runs on Red Hat's Vertex project
today.

**CI is a separate question, and the local credential does not carry over.**
`GOOGLE_APPLICATION_CREDENTIALS` points at an `authorized_user` ADC file — a
personal refresh token from `gcloud auth application-default login`, not a
service account key. It expires (it was already expired when checked) and must
not be used in CI. GitHub Actions needs either a Workload Identity Pool or a
service account key, and both require IAM rights on an IT-managed project.

**Measured end-to-end, 2026-10-18.** A `rawPredict` call to
`aiplatform.googleapis.com` / location `global` /
`publishers/anthropic/models/claude-opus-5` returned HTTP 200 and a model
response. Location `us` returns 501 UNIMPLEMENTED on the raw endpoint;
`us-east5` returns 429 (authorised, but the project's token-per-minute quota
was already exhausted by other users — worth knowing before pointing CI at it).

**IAM rights held on the project**, from `testIamPermissions`:

| Permission | Held |
|---|---|
| `aiplatform.endpoints.predict` | ✅ |
| `iam.serviceAccounts.create` | ✅ |
| `iam.serviceAccountKeys.create` | ✅ |
| `resourcemanager.projects.setIamPolicy` | ✅ |
| `serviceusage.services.enable` | ✅ |
| `iam.workloadIdentityPools.create` | ❌ **not held** |

`sts.googleapis.com` is also not enabled. So **the clean keyless WIF path is
blocked** without a request to the project owner. A service-account key is
permitted at the IAM layer, though an org policy
(`constraints/iam.disableServiceAccountKeyCreation`) may still refuse it at
creation time.

**The non-technical gatekeeper, and it is the deciding one:**
`hornjason/pai-harness` is a personal repository. Interactive use of Red Hat's
Claude project is sanctioned work; minting a long-lived corporate service
account key into a personal repo's secrets is not the same act, and the
`setIamPolicy` right that makes it possible is an argument for asking rather
than an argument for proceeding.

Note: the hosted Anthropic Code Review product is **still Team/Enterprise only
even for Vertex customers** — *"you need a Claude organization on one of these
plans even if your developers use Claude Code through Amazon Bedrock, Google
Cloud's Agent Platform, or Microsoft Foundry."* Vertex changes the billing path
for the action you build; it does not unlock the hosted product.

Source: [GitHub Actions with cloud providers](https://code.claude.com/docs/en/github-actions-cloud-providers)

## 3c. What carries over to GitLab, and what does not

The GCP side is shared. The CI side is not — and the GitLab integration is a
different shape of thing, not a port of the same action.

| Piece | GitHub | GitLab | Shared? |
|---|---|---|---|
| GCP project + Agent Platform API | ✅ | ✅ | **once** |
| Service account + `roles/aiplatform.user` | ✅ | ✅ | **once** |
| Model Garden access | ✅ | ✅ | **once** |
| Workload Identity **Pool** | ✅ | ✅ | **once** |
| WIF **provider** (OIDC issuer) | `token.actions.githubusercontent.com` | your GitLab instance URL | **no — one per platform** |
| Runner integration | `anthropics/claude-code-action@v1` | install CLI, run `claude -p` | **no** |
| Bot identity | GitHub App token | `CI_JOB_TOKEN` or PAT | **no** |
| `@claude` mention handling | built into the action | **build it yourself** — webhook on note events calling the pipeline trigger API | **no** |
| `CLAUDE.md` / review prompt | ✅ | ✅ | **once per repo** |

Two things to know before planning GitLab work:

1. **There is no GitLab equivalent of the action.** The documented pattern
   installs the CLI in the job (`curl -fsSL https://claude.ai/install.sh | bash`)
   and invokes `claude -p "..."`. The integration is **beta and maintained by
   GitLab**, not Anthropic.
2. **Self-managed GitLab may not federate.** `gitlab.cee.redhat.com` is
   internal. WIF requires Google to validate the OIDC token against the
   issuer; for an issuer Google cannot reach, the pool provider must be created
   with an uploaded JWK set rather than OIDC discovery. Verify this before
   committing to the WIF path for `project-ape`.

Sources: [GitLab CI/CD](https://code.claude.com/docs/en/gitlab-ci-cd) ·
[Vertex setup](https://code.claude.com/docs/en/google-vertex-ai)

### Region correction

`CLOUD_ML_REGION` accepts `global`, a multi-region (`us`, `eu`), or a region
(`us-east5`). Claude Code picks the right host for each form — multi-region
`us` resolves to `aiplatform.us.rep.googleapis.com`, which is why a raw call to
`aiplatform.googleapis.com/locations/us` returns 501 while Claude Code's own
`us` config works. For CI, prefer `global`: Anthropic's own 429 guidance is
*"Consider switching to `CLOUD_ML_REGION=global` for better availability."*

**Pin the model, or pay Opus rates.** Unpinned, the `opus` alias resolves to
Opus 5.5 and that is the billing rate. For review jobs set
`ANTHROPIC_MODEL` to a Sonnet ID.

## 4. Anthropic's hosted Code Review is ruled out

Two independent disqualifiers:

- **Team and Enterprise plans only.** A Max subscription does not qualify.
- **Cannot block.** By explicit design, as quoted above.

Source: [code-review docs](https://code.claude.com/docs/en/code-review)

## 5. The fail-open warning

A hosted review bot added to required status checks introduces exactly the
defect `.claude/rules/checks-must-be-able-to-fail.md` is about. Reported in the
wild against CodeRabbit: **a throttled reviewer reports green**, so the required
check is satisfied by a review that never happened.

Any gate built on a metered third-party reviewer must distinguish
*"reviewed, found nothing"* from *"did not review"* and refuse on the second.
`UNMEASURED` is not `PASS`. If the tool cannot express that distinction, it
cannot be a gate here.

## 6. Pricing of the hosted alternatives

Verified from vendor pages:

| Tool | Price | Free tier covers private repos? | Self-host | BYO key |
|---|---|---|---|---|
| CodeRabbit Essentials | $24/dev/mo annual, $30 monthly | **No** — free plan is public repos only | Enterprise only | not stated on pricing page |
| CodeRabbit Team | $48/dev/mo annual, $60 monthly | No | Enterprise only | — |
| CodeRabbit Advanced | $72/dev/mo annual | No | Enterprise only | — |

CodeRabbit add-ons: $0.25 per reviewed file, $0.40 per agent minute.
Source: [coderabbit.ai/pricing](https://www.coderabbit.ai/pricing)

Greptile (~$30/seat + credits), Qodo (~$30/mo + $0.012/credit) and cubic figures
circulating in comparison articles are **unverified** — they come from
third-party blogs, not vendor pages, and were not confirmed this session.

## 7. The free baseline that is already here

rungate's `gates.yml`, `ci.yml` and `issue-audit.yml` are deterministic gates
with zero marginal cost and no metering. They cannot be throttled, cannot run
out of credits, and cannot report green because a vendor rate-limited them.

An AI reviewer should sit *above* that floor, catching what a deterministic
check cannot express — not substitute for it.

Two SaaS SAST tools extend that floor to **private repos at $0**, and both post
real blocking status checks with no wrapper script:

- **Semgrep** — free for organisations with **10 or fewer monthly contributors**;
  a contributor is anyone with a commit to a scanned private repo in a rolling
  90-day window. Over the limit, scans stop (they do not report green — a
  stopped scan leaves a required check unreported, which fails closed).
  [pricing](https://semgrep.dev/pricing/)
- **SonarCloud** — free tier reported at up to 50k LOC / 5 users. **Not verified
  from the vendor page**; check before relying on it.

These are rule-based, not LLM review. They catch a different class of defect.
Running them does not remove the case for an AI reviewer; it lowers what the AI
reviewer has to be trusted for.

## 8. Issue triage

The scheduled `issue-audit.yml` pattern already in the repo — a cron workflow
running a Bun script against `gh` — is the cheapest credible triage mechanism
and costs only Actions minutes. The same `anthropics/claude-code-action` in
automation mode runs on a `schedule` trigger with a `prompt` input, so triage
can reuse the same OAuth token and the same billing path as review.

Note the trigger constraint: scheduled runs are attributed to a repository user,
and the action **rejects bot actors** unless listed in `allowed_bots`.

The action ships an official triage example at
`examples/issue-triage.yml` in the `anthropics/claude-code-action` repo.

Other options surfaced but **not verified from vendor pages**:

- **Gemini CLI GitHub Actions** — Google's free tier is the only genuinely
  zero-cost AI triage path reported. Worth verifying if credit cost is the
  binding constraint.
- **Dosu** — heavily adopted (LangChain, Apache projects) but **free for public
  OSS only**; private-repo pricing is unpublished. Does not fit this repo.
- **triagebot-action** (withastro) — MIT, reported to have cut Astro's open
  issues from 200+ to ~30.
- **Local-model triage actions** (`gutsy-triage`, `laya-triage`) — run a small
  model on the runner, so cost is Actions minutes only. Accuracy unverified.

Sweep, Linear and Jira/Rovo AI triage were not verified.

## 9. Recommendation

**Primary: `anthropics/claude-code-action` with `CLAUDE_CODE_OAUTH_TOKEN`, as a
workflow you own.**

- Runs on the existing Max subscription — no new metered credit pool
- You write the workflow, so you control the exit code and can make it a real
  required check rather than a comment bot
- Same mechanism covers scheduled issue triage
- Supports `--max-turns`, `--model`, and timeouts for cost control
- Fits the repo's SHA-pinning convention

**Its failure mode, named:** it consumes Max rate-limit windows shared with
interactive sessions. A busy PR day can throttle local work. Mitigate with
`--model claude-sonnet-5`, `--max-turns`, concurrency limits, and running only
on `opened`/`ready_for_review` rather than every `synchronize`.

**Fallback: CodeRabbit Essentials at $24/dev/mo annual** — flat per-seat, no
usage meter, real pre-merge checks. Rejected as primary because it is a second
subscription for a capability already paid for, and because its throttled-green
behaviour is a fail-open that would need wrapping anyway.

**Do first, regardless:** flip the Copilot repository effort level to Lite.

## 10. A contradicted claim, and why it was rejected

A research subagent reported, as its headline finding, that
`anthropics/claude-code-action` **cannot** use a Max subscription and
**requires** a separate API key — citing (a) that the README "doesn't mention"
OAuth, and (b) a Medium post asserting that subscription OAuth tokens have been
restricted to the CLI and claude.ai since January 2026 and that CI use violates
the Consumer ToS.

Rejected, on three first-party sources read the same day:

1. `code.claude.com/docs/en/github-actions` — *"If you authenticate with an
   OAuth token, runs use your Claude subscription instead of API billing."* The
   input table lists `claude_code_oauth_token`.
2. `code.claude.com/docs/en/authentication` — `claude setup-token` is documented
   *"For CI pipelines, scripts, or other environments where interactive browser
   login isn't available"*, and the token *"authenticates with your Claude
   subscription and requires a Pro, Max, Team, or Enterprise plan."*
3. The action's own `docs/usage.md` — `claude_code_oauth_token` is described as
   *"alternative to anthropic_api_key"*, and the required-auth footnote covers
   API key, OAuth token, and federation alike: you need **one** of them.

Also decisive: `/install-github-app` itself saves the credential as
`CLAUDE_CODE_OAUTH_TOKEN` when you choose the subscription path. Anthropic's own
installer sets up the thing the report said was prohibited.

The lesson is the one this repo already writes down — **argument from absence is
not evidence.** "The README doesn't mention it" is a statement about the README.

## 11. Not verified this session

- Greptile, Qodo Merge, cubic, Graphite Diamond, Codacy, Bito, Ellipsis,
  Sourcery, DeepSource, Korbit, Baz, Matter AI pricing and blocking capability
- Whether PR-Agent's OSS fork is actively maintained under community governance
- Dedicated issue-triage products
- Actions-minutes cost per Copilot review (GitHub publishes no figure; it is
  measurable by filtering billing usage by workflow path
  `dynamic/agents/copilot-pull-request-reviewer`)
