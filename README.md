# B4AGroup/.github

Organisation-wide defaults for B4AGroup repositories:

- `profile/README.md` — the public organisation profile.
- `.github/pull_request_template.md` — default pull request template for every repo that does not ship its own.
- `.github/workflows/*.yml` — reusable workflows (`workflow_call`) and org ruleset required workflows.
- `scripts/brain-context/` — logic and unit tests for the Brain context gate (below).
- `scripts/pr-intent-review/` — logic and unit tests for the PR intent review (warn-only pilot, below).

This repository is public. Never commit secrets, tokens or internal hostnames here.

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
3. If the check complains, edit the PR description. Editing re-runs the check (`edited` event); so does pushing a commit or changing labels.

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
   - Bypass list: leave empty; use the `brain-context-exempt` label instead so overrides are logged.
3. **Exempt label.** Create `brain-context-exempt` in each repo where leads may need it, and add it to *Organisation settings → Repository → Repository defaults → Labels* so new repos get it.
4. **Optional token.** Add an org secret `BRAIN_CONTEXT_TOKEN` with read access to `b4a-brain` contents to turn on link existence checks. Without it the gate still runs with format-only validation.
5. **Calling it directly** (instead of, or in addition to, the ruleset) from a repo workflow:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, labeled, unlabeled]
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
6. Posts **one sticky comment** on the PR (found again through the hidden marker `<!-- pr-intent-review -->` and updated in place), writes a job summary, and uploads the verdict as a JSON artifact (`pr-intent-review-pr<N>-run<attempt>`, kept 30 days) for the evaluation.

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
