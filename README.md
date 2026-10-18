# B4AGroup/.github

Organisation-wide defaults for B4AGroup repositories:

- `profile/README.md` — the public organisation profile.
- `.github/pull_request_template.md` — default pull request template for every repo that does not ship its own.
- `.github/workflows/*.yml` — reusable workflows (`workflow_call`) and org ruleset required workflows.
- `scripts/what-and-why/` — logic and unit tests for the What and Why gate (below).
- `scripts/brain-context/` — logic and unit tests for the Brain context gate (below).
- `scripts/gate-recheck/` — tool that re-runs both gates on every open PR of the org and creates the exempt label everywhere (below, "Gate re-check tool"), with the activation runbook for the ruleset.
- `scripts/pr-intent-review/` — logic and unit tests for the PR intent review (warn-only pilot, below).

This repository is public. Never commit secrets, tokens or internal hostnames here.

## What and Why gate

Every pull request in the organisation must say **what it changes and why it is needed**.
The gate is the workflow [`.github/workflows/what-and-why.yml`](.github/workflows/what-and-why.yml);
its logic is in [`scripts/what-and-why/`](scripts/what-and-why/) (Node 20, no dependencies).
It is warn-only until **2026-10-19 00:00 America/Sao_Paulo** and blocks automatically from then on (see "Timeline" below).

### What developers must do

1. Keep the `## What and Why` heading from the PR template (it is the first section) and write two or three sentences: the problem or goal, and what this change does about it.
2. At least 20 characters of real text are required. The template's HTML comment, blank bullets, `<angle placeholders>` and placeholder words such as `TBD`, `TODO`, `WIP` or `n/a` do not count.
3. If the check complains, edit the PR description. Editing re-runs the check (`edited` event); so does pushing a commit, changing labels or marking the PR ready for review.

Example that passes:

```markdown
## What and Why
Adds a retry to the renewal job. Pagar.me times out at night and renewals were silently lost (B4A-123).
```

Examples that fail: the untouched template (comment only), `TBD`, `n/a`, `<what and why>`, or a description without the heading.

### What the check does

- Finds the `## What and Why` (or `###`, or `What & Why`) heading in the PR body, ignoring HTML comments.
- Fails when the section is missing, empty, placeholder-only or shorter than 20 characters of real text. In blocking mode the job exits 1, which blocks the merge wherever the workflow is required; in warn mode it exits 0 (see "Timeline").
- Writes a job summary with the outcome, the mode, the text found, notes and a "how to fix" block, plus a warning (warn mode) or error (blocking mode) annotation on failure.

### Timeline

| Period | Behaviour |
| --- | --- |
| Until **2026-10-18** (23:59:59 UTC-3) | Warning only: a failing PR gets a warning annotation and the sticky author comment (which says until when the check is warn-only), and the job exits 0. |
| From **2026-10-19 00:00 UTC-3** | Blocking: a failing PR gets an error annotation and the sticky author comment, and the job exits 1, which blocks the merge wherever the workflow is required. |

The switch is the single constant `DEFAULT_ENFORCE_AFTER` (`2026-10-19T00:00:00-03:00`) in [`scripts/what-and-why/lib.mjs`](scripts/what-and-why/lib.mjs). Nothing needs to change on the date: the check flips to blocking by itself. The `ENFORCE_AFTER` env (ISO-8601) overrides it; it exists for the tests.

### Author alert (sticky comment)

When the check fails on any of the events the workflow triggers on (`opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`, `labeled`, `unlabeled`), in both modes, the workflow keeps **one** comment on the PR, identified by a hidden marker (`<!-- b4a-what-and-why -->`):

- First failure: posts the comment, which `@mentions` the PR author. GitHub notifies them (email, depending on their notification settings) because of the mention. In warn mode the comment states the date until which the check is warn-only.
- Later pushes, edits or label changes while still failing: updates that same comment in place. No new comment, no new notification.
- Once the section is filled: edits the comment into a short "resolved" note.
- Two runs can start within a second of each other (push + edit, or the label add + remove fired by the gate re-check tool) and both see "no comment yet". After posting, the run re-reads the comments and deletes every marker comment except the oldest, so the PR always ends up with exactly one.
- Fork PRs: the workflow token is read-only, so the comment is skipped (the job summary says so) but the check result still applies.
- If the comment API refuses (for example a repository that restricts `GITHUB_TOKEN`), the check result stands and a warning annotation explains that the alert could not be posted.

The comment needs `pull-requests: write` and `issues: write`. The workflow declares them in its `permissions` block; when calling it with `uses:` the caller must grant the same permissions (see below).

### Skips

The check passes without inspecting the body for PRs authored by `dependabot` or `renovate` (including the `[bot]` logins). There is no exemption label.

### Rollout (org owners)

1. **Default PR template.** Nothing to do: `.github/pull_request_template.md` in this repo already starts with `## What and Why`. Repos that keep their own template must add the section to it.
2. **Org ruleset.** Add the workflow to the same ruleset as the Brain context gate (or create a sibling one). *Organisation settings → Repository → Rulesets → `Brain context gate` → Edit*:
   - Under **Require workflows to pass before merging** → *Add workflow* → repository `B4AGroup/.github`, branch `main`, path `.github/workflows/what-and-why.yml`.
   - Keep the targets as they are (all repositories, default branch plus `main`, `master`, `develop`). `b4a-brain` may stay excluded or be included; the What and Why gate has no special case for it.
   - Enforcement: *Active*. The script itself is warn-only (exit 0) until 2026-10-19 00:00 UTC-3, so an *Active* ruleset does not block anyone before that date.
   - Bypass list: only the `release-bots` team (see "Activating the ruleset" below). Nothing else.
   - Right after switching to *Active*, run the gate re-check so PRs that were already open get a run of this workflow (see "Activating the ruleset").
3. **Workflow permissions.** The required workflow runs with the target repository's `GITHUB_TOKEN` and asks for `pull-requests: write` and `issues: write` in its `permissions` block. No change is needed for repositories using the default settings. If a repository has *Settings → Actions → General → Workflow permissions* locked down by a policy that forbids elevating permissions, the check still runs and fails correctly; only the comment is skipped (warning annotation).
4. **Calling it directly** (instead of, or in addition to, the ruleset) from a repo workflow:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled]
jobs:
  what-and-why:
    uses: B4AGroup/.github/.github/workflows/what-and-why.yml@main
    permissions:
      contents: read
      pull-requests: write
      issues: write
```

### Running the tests

```bash
node --test scripts/what-and-why/lib.test.mjs scripts/what-and-why/check.test.mjs
```

## Brain context gate

Every pull request in the organisation must say which pages of the knowledge base
([B4AGroup/b4a-brain](https://github.com/B4AGroup/b4a-brain)) were checked before coding.
The gate is the workflow [`.github/workflows/brain-context.yml`](.github/workflows/brain-context.yml);
its logic is in [`scripts/brain-context/`](scripts/brain-context/) (Node 20, no dependencies).

### What developers must do

1. Before coding, search the brain with `brain.search` in the B4A MCP connector (1–3 short queries about the product, repo or problem). If the connector is unavailable, browse the repo on GitHub.
2. In the PR description keep the `## Brain context` heading from the template and fill it with **one of**:
   - one link per line to the pages you read, as `https://github.com/B4AGroup/b4a-brain/blob/...` or `.../tree/...` URLs (links to the repo root, issues or PRs do not count), **or**
   - a line `none relevant: <reason>` where the reason has at least 15 characters (the placeholder `<reason>` does not count).
3. If the check complains, edit the PR description. Editing re-runs the check (`edited` event); so does pushing a commit, changing labels or marking the PR ready for review.

Example that passes:

```markdown
## Brain context
- https://github.com/B4AGroup/b4a-brain/blob/master/shared/org-conventions.md
- https://github.com/B4AGroup/b4a-brain/blob/master/bfluence/processes.md#schema-changes
```

Example that also passes:

```markdown
## Brain context
- none relevant: typo fix in a README, no product or deploy behaviour touched
```

Examples that fail: the untouched template (`- ` only), `none relevant: n/a`, a link to `https://github.com/B4AGroup/b4a-brain` with no page path, or a page link that does not exist in the brain (when the workflow has access to verify it — see below).

### What the check does

- Finds the `## Brain context` (or `###`) heading in the PR body, ignoring HTML comments.
- Passes if the section has at least one `blob`/`tree` link to `B4AGroup/b4a-brain`, or a `none relevant:` line with a reason of 15+ characters.
- Tries to resolve each page link through the GitHub contents API. `b4a-brain` is private, so the default `GITHUB_TOKEN` of other repos cannot read it; in that case existence checks are skipped, only the URL format is validated, and the job summary says so. To enable real existence checks, provide the optional secret `BRAIN_CONTEXT_TOKEN` (a fine-grained token or GitHub App token with read access to `b4a-brain` contents) at the organisation level, or pass it via `secrets:` when calling the workflow.
- Writes a job summary with the outcome, the links found, notes and a "how to fix" block, plus a warning/error annotation on failure.

### Skips

The check passes without inspecting the body for:

- PRs authored by `dependabot` or `renovate` (including the `[bot]` logins);
- PRs whose base repository is `B4AGroup/b4a-brain` itself;
- PRs carrying the label **`brain-context-exempt`**. This is a lead override. It is recorded in the job summary and as a notice annotation so it stays auditable. Adding or removing the label re-runs the check immediately (`labeled`/`unlabeled` events).

### Timeline

| Period | Behaviour |
| --- | --- |
| Until **2026-10-18** (23:59:59 UTC-3) | Warning only: a failing PR gets a warning annotation and the job exits 0. |
| From **2026-10-19 00:00 UTC-3** | Blocking: a failing PR gets an error annotation and the job exits 1, which blocks the merge wherever the workflow is required. |

The switch is the `ENFORCE_AFTER` value (`2026-10-19T00:00:00-03:00`). It is the default of the `enforce_after` input and of the `ENFORCE_AFTER` env in the workflow; change both places to move the date for the whole org, or pass `enforce_after` when calling the workflow from a single repo.

Phase B (planned, disabled): verify that the author actually ran `brain.search` during the branch window against the B4A MCP gateway audit log. The hook is `verifySearchLog` in `scripts/brain-context/lib.mjs`, gated by `VERIFY_SEARCH_LOG=false` and an endpoint still to be provided.

### Admin setup (org owners)

1. **Default PR template.** Nothing to do: `.github/pull_request_template.md` in this repo is the org default for repos without their own template. Repos that keep their own template must add the `## Brain context` section to it.
2. **Org ruleset.** *Organisation settings → Repository → Rulesets → New branch ruleset*:
   - Name: `Brain context gate`. Enforcement: *Active* (or *Evaluate* first to watch the insights).
   - Target repositories: *All repositories*, then exclude `b4a-brain` (repository name pattern exclude).
   - Target branches: *Include default branch*, plus patterns `main`, `master`, `develop`.
   - Rules: tick **Require workflows to pass before merging** → *Add workflow* → repository `B4AGroup/.github`, branch `main`, path `.github/workflows/brain-context.yml`.
   - Bypass list: only the `release-bots` team (see "Activating the ruleset" below). For developers use the `brain-context-exempt` label instead, so overrides are logged.
   - Right after switching to *Active*, run the gate re-check so PRs that were already open get a run of this workflow (see "Activating the ruleset").
3. **Exempt label.** Create `brain-context-exempt` in every repo (`node scripts/gate-recheck/recheck.mjs --mode exempt-label --apply`, or the *Gate re-check* workflow with mode `exempt-label`; see "Gate re-check tool"), and add it to *Organisation settings → Repository → Repository defaults → Labels* so new repos get it.
4. **Optional token.** Add an org secret `BRAIN_CONTEXT_TOKEN` with read access to `b4a-brain` contents to turn on link existence checks. Without it the gate still runs with format-only validation.
5. **Calling it directly** (instead of, or in addition to, the ruleset) from a repo workflow:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled]
jobs:
  brain-context:
    uses: B4AGroup/.github/.github/workflows/brain-context.yml@main
    permissions:
      contents: read
      pull-requests: read
```

### Running the tests

```bash
node --test scripts/brain-context/lib.test.mjs
```

## Activating the ruleset (org owners runbook)

The org ruleset **Brain context gate** requires both workflows above (`brain-context.yml` and `what-and-why.yml`) on every repository's default branch plus `main`, `master` and `develop`. Two things bit us when it was briefly *Active* on 2026-10-11; the runbook below exists so they do not happen again.

**Why pre-existing PRs get stuck.** A required workflow only runs when a `pull_request` event fires. PRs that were already open when the ruleset went live never had a run, so GitHub showed both checks as *Expected* and blocked the merge (b4a-prj-cs #749). Nothing re-runs them by itself: someone has to push, edit, relabel or re-open each PR. The gate re-check tool (next section) fires such an event on every open PR; both workflows listen to the same event types on purpose (`opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled`), so one label change re-runs both.

**Why the release bot needs a bypass.** At least 15 repositories call [`tag-release-changelog.yml`](.github/workflows/tag-release-changelog.yml) (or the `-java` variant) on push to `master`. That workflow commits `chore(release): vX.Y.Z [skip ci]` and pushes it **directly to `master`** with `secrets.BOT_ACCESS_TOKEN`, whose owner is the GitHub user `b4a-bot`. With the ruleset *Active* that push was rejected on 2026-10-11 in `bfluence-frontend` with `GH013: Changes must be made through a pull request`, so the release tag and changelog were not produced. Org rulesets can only bypass **roles, teams, GitHub Apps and deploy keys**, not individual users, so the bypass must be a team. Do not change `tag-release-changelog.yml` for this; the bypass is the fix.

### Steps

1. **Pre-flight (before touching the ruleset).**
   - `main` of this repo contains both workflows with identical `pull_request` trigger lists, and the tests are green (`node --test scripts/*/*.test.mjs`).
   - The `brain-context-exempt` label exists in every repo: run the gate re-check tool in mode `exempt-label` (dry-run first, then `--apply`).
   - A token for the re-check tool is in place (`GATE_RECHECK_TOKEN` or the App pair, see the next section), or you have a PAT at hand to run it locally.
2. **Bypass for the release bot.** First confirm `b4a-bot` is an **organisation member** (*Organisation → People*); outside collaborators cannot join teams, so an outside-collaborator bot would have to be invited as a member first. Then *Organisation → Teams → New team*: name `release-bots`, members **only `b4a-bot`** (the owner of `BOT_ACCESS_TOKEN`). No humans in it: a bypass with mode *Always* lets its members push to protected branches without a PR. Then *Organisation settings → Repository → Rulesets → Brain context gate → Bypass list → Add bypass → Teams → `release-bots`*, bypass mode **Always** (not *Pull requests only*: the release commit is a direct push). The team needs no repository permissions of its own; the bot already pushes with its token. If `BOT_ACCESS_TOKEN` is ever replaced by a GitHub App token, bypass that App instead and remove the team.
3. **Set the ruleset to Active.** Keep the targets (all repositories, `b4a-brain` excluded; default branch plus `main`, `master`, `develop`) and both required workflows (repository `B4AGroup/.github`, branch `main`).
4. **Run the gate re-check immediately.** *Actions → Gate re-check → Run workflow*, mode `recheck`, `apply` unticked: read the plan (which repos, which PRs, which labels would be created). Then run it again with `apply` ticked. Each PR gets the `gate-recheck` label added and removed; both required workflows run on each; authors of PRs with a missing *What and Why* section get the sticky comment. Until this step is done, every PR that was open before step 3 shows the two checks as *Expected* and cannot be merged.
5. **Verify.** Open two or three of the listed PRs (a draft, a ready one, one targeting `develop`): both checks appear and finished. Check the ruleset *Insights* for unexpected bypasses or failures.
6. **Watch the next release.** On the next merge to `master` in a repo that uses `tag-release-changelog.yml`, confirm the `chore(release)` push succeeded and the tag exists. If it fails with `GH013`, the bypass team is missing or its mode is not *Always*.

Rolling back is one click (*Enforcement → Disabled*); nothing in this repo needs to change for that.

## Gate re-check tool

[`scripts/gate-recheck/`](scripts/gate-recheck/) (Node 20, no dependencies) and the manual workflow [`.github/workflows/gate-recheck.yml`](.github/workflows/gate-recheck.yml).

### What it does

| Mode | Action |
| --- | --- |
| `recheck` (default) | Lists every open PR (drafts included) in the organisation whose base branch is the repository's default branch, `main`, `master` or `develop`. In each repository that has such PRs it creates the `gate-recheck` label if missing, then for each PR **adds and removes** that label. Each change is a `pull_request` event (`labeled`, then `unlabeled`), so both required workflows run. A PR that already carries the label only gets the removal. |
| `exempt-label` | Creates the `brain-context-exempt` label (colour and description included) in every repository that lacks it. |

In both modes:

- **Dry-run by default.** Without `--apply` the tool only reads and prints what it would touch (`[dry-run] B4AGroup/repo#12 "title" (base develop, draft, by ana) -> would add + remove "gate-recheck"`), plus totals. Nothing is written.
- **Skips** archived repositories, disabled repositories and `b4a-brain` (always), plus anything passed with `--exclude`. PRs whose base is another branch (feature, release, …) are counted but not touched.
- **Rate-limit friendly.** Pauses after every write (`--delay-ms`, default 1000) and between the label add and remove on one PR (`--settle-ms`, default 2000); retries `429`/`403` rate-limit answers after `Retry-After` or until `X-RateLimit-Reset`; pauses by itself when fewer than 25 requests remain; backs off on 5xx (3 retries). The workflow runs one re-check at a time (`concurrency`).
- **Keeps going.** A repository the token cannot read, or a PR that refuses a label, is recorded as an error and the run continues. Exit code `0` = no errors, `1` = some errors (listed at the end and in the job summary), `2` = usage or token problem.
- Writes a Markdown table to the job summary (`GITHUB_STEP_SUMMARY`) when run inside Actions.

### Running it locally

```bash
# plan only
GATE_RECHECK_TOKEN=<token> node scripts/gate-recheck/recheck.mjs
# one repository, drafts excluded
GATE_RECHECK_TOKEN=<token> node scripts/gate-recheck/recheck.mjs --repo bfluence-frontend --skip-drafts
# do it
GATE_RECHECK_TOKEN=<token> node scripts/gate-recheck/recheck.mjs --apply
# exempt label everywhere
GATE_RECHECK_TOKEN=<token> node scripts/gate-recheck/recheck.mjs --mode exempt-label --apply
node scripts/gate-recheck/recheck.mjs --help
```

The token is read from `GATE_RECHECK_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`; it is never printed. Pass it through the environment, not on the command line.

### Running it from Actions

*Actions → Gate re-check → Run workflow* with inputs `mode`, `apply` (unticked = dry-run), `repos` (optional comma-separated names) and `skip_drafts`. The job summary shows the plan or the result.

### Token: why not `GITHUB_TOKEN`

Events created with a workflow's own `GITHUB_TOKEN` **do not trigger other workflows** (GitHub prevents recursive runs), so a label added with it would not start the required checks. It also cannot see the other repositories of the organisation. The workflow therefore needs one of the following org secrets. **Neither is assumed to exist**: the job fails early with a message naming both options when none is configured.

| Option | Secrets | Notes |
| --- | --- | --- |
| GitHub App (preferred) | `GATE_RECHECK_APP_ID`, `GATE_RECHECK_APP_PRIVATE_KEY` | App installed on all org repositories with *Pull requests: write* and *Issues: write* (labels live in the issues API) plus *Metadata: read*. The workflow mints a one-hour installation token per run with `actions/create-github-app-token`. Events it creates trigger workflows normally. |
| Personal access token | `GATE_RECHECK_TOKEN` | Classic PAT with scope `repo`, or fine-grained PAT (resource owner `B4AGroup`, all repositories, *Pull requests: write*, *Issues: write*, *Metadata: read*). Prefer a bot account over a personal one so the label events are not attributed to a person. The existing `BOT_ACCESS_TOKEN` (b4a-bot) would work technically, but it is scoped to the release pipeline; use a separate secret so rotating one does not break the other. |

When both exist, the App token wins. Running the tool locally needs the same permissions on whatever token you export.

### Tests

```bash
node --test scripts/gate-recheck/lib.test.mjs scripts/gate-recheck/recheck.test.mjs scripts/gate-recheck/triggers.test.mjs
```

`lib.test.mjs` runs both modes against an in-memory GitHub fake (dry-run writes nothing, apply order, already-labelled PRs, skipped repos, per-repo failures, rate-limit retries). `recheck.test.mjs` spawns the CLI against a local HTTP fake. `triggers.test.mjs` fails if the two required workflows stop sharing the same `pull_request` trigger list.

## PR intent review (warn-only pilot)

An LLM reviewer that checks whether a pull request's **stated intent** is justified, matches its
**Linear ticket**, fits the **B4A Brain**, and whether the **diff** does what the intent says.
Approved by Jan as a one-week pilot: it is **advisory only and never blocks a merge**.

Workflow: [`.github/workflows/pr-intent-review.yml`](.github/workflows/pr-intent-review.yml) (`workflow_call` only).
Logic: [`scripts/pr-intent-review/`](scripts/pr-intent-review/) (Node 20, no dependencies).

### What it does on every PR (`opened`, `edited`, `synchronize`, `reopened`)

1. Parses the `## What and Why` section of the PR body (`## What & Why` and `###` also work; falls back to `## Summary` and says so).
2. Extracts the Linear ID (`B4A-<number>`) from the branch name, then the PR title, and fetches the issue title, description, state, project, labels and parent (the spec) through the Linear GraphQL API. Only a query is sent.
3. Searches the B4A Brain with the `brain.search` tool of the B4A MCP gateway (up to 3 short queries built from the repo + PR title, the ticket title and the first sentence of the intent; top 10 hits).
4. Fetches the PR diff through the GitHub API, skipping generated files (lockfiles, minified bundles, images, `dist/`…) and capping it at 8 000 characters per file and 60 000 in total.
5. Asks Anthropic (`claude-fable-5-1` by default) for strict JSON:
   `{ verdict: pass | needs-attention | fail, reasons[], intent_justified, matches_ticket, fits_brain, diff_matches_intent }`.
6. Posts **one sticky comment** on the PR (found again through the hidden marker `<!-- b4a-pr-intent-review -->` and updated in place), writes a job summary, and uploads the verdict as a JSON artifact (`pr-intent-review-pr<N>-run<attempt>`, kept 30 days) for the evaluation.

The job **always exits 0**. A missing secret or variable, an upstream API error, a timeout or a non-JSON
model answer produces a comment `skipped: <reason>` (and the same reason in the summary and artifact), never a failure.
PRs by `dependabot`/`renovate` and PRs targeting `B4AGroup/b4a-brain` are skipped silently (summary only, no comment).
`matches_ticket` is `n/a` when no ticket ID is present; `fits_brain` is `n/a` when the brain has no relevant hits.

### Required org secrets and variable (org owners)

All of them are read at run time only and never printed. Set them at the organisation level
(*Settings → Secrets and variables → Actions*) and grant access to the pilot repositories.

| Name | Kind | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret | Anthropic API key used for the review call. |
| `LINEAR_API_KEY` | secret | Linear API key (personal key of a dedicated bot user is recommended). The workflow only runs read queries. |
| `B4A_MCP_TOKEN` | secret | B4A MCP gateway service-account token (`gw_svc_…`) whose role allows `brain.search`. Create it in the gateway console (*service accounts*) and store it here only. |
| `B4A_MCP_URL` | **variable** | The MCP endpoint of the B4A MCP gateway (`https://<gateway host>/mcp`; see `shared/shared-apis.md` in the brain). A variable, not a secret, so it is never hard-coded in this public repo. |

If any of the four is missing the review is skipped with the name of the missing item, so a repo can
be onboarded before the secrets exist without breaking anything.

### Calling it from a pilot repo

Create `.github/workflows/pr-intent-review.yml` in the repository (identical for `glam-frontend`,
`admin-frontend` and `subscription-api`):

```yaml
name: PR intent review

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  pr-intent-review:
    uses: B4AGroup/.github/.github/workflows/pr-intent-review.yml@main
    permissions:
      contents: read
      pull-requests: write
      issues: write
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
      B4A_MCP_TOKEN: ${{ secrets.B4A_MCP_TOKEN }}
    # Optional inputs: model (default claude-fable-5-1), max_diff_chars (default 60000),
    # brain_folder (e.g. "bfluence" to restrict brain.search to one product folder).
```

`secrets: inherit` also works when the org secrets are visible to the repo. `B4A_MCP_URL` is read
from the `vars` context, so it only has to exist as an org (or repo) variable.
Pull requests from forks get a read-only `GITHUB_TOKEN`; the review still runs, the comment cannot
be posted, and the summary says so.

### Evaluating the pilot

Every run uploads `verdict-<owner>__<repo>-pr<N>-<sha>.json` with the verdict, the four booleans,
the reasons, the brain pages consulted, the diff statistics, the raw model answer and the skip reason
if any. Download the artifacts of the pilot repos after the week to compare verdicts with what the
human reviewers decided. Nothing in the artifact or the comment contains a secret value.

### Running the tests

```bash
node --test scripts/pr-intent-review/*.test.mjs
```
