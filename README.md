# B4AGroup/.github

Organisation-wide defaults for B4AGroup repositories:

- `profile/README.md` — the public organisation profile.
- `.github/pull_request_template.md` — default pull request template for every repo that does not ship its own.
- `.github/workflows/*.yml` — reusable workflows (`workflow_call`) and org ruleset required workflows.
- `scripts/what-and-why/` — logic and unit tests for the What and Why gate (below).
- `scripts/brain-context/` — logic and unit tests for the Brain context gate (below).

This repository is public. Never commit secrets, tokens or internal hostnames here.

## What and Why gate

Every pull request in the organisation must say **what it changes and why it is needed**.
The gate is the workflow [`.github/workflows/what-and-why.yml`](.github/workflows/what-and-why.yml);
its logic is in [`scripts/what-and-why/`](scripts/what-and-why/) (Node 20, no dependencies).
It blocks from day one: there is no warning period.

### What developers must do

1. Keep the `## What and Why` heading from the PR template (it is the first section) and write two or three sentences: the problem or goal, and what this change does about it.
2. At least 20 characters of real text are required. The template's HTML comment, blank bullets, `<angle placeholders>` and placeholder words such as `TBD`, `TODO`, `WIP` or `n/a` do not count.
3. If the check complains, edit the PR description. Editing re-runs the check (`edited` event); so does pushing a commit.

Example that passes:

```markdown
## What and Why
Adds a retry to the renewal job. Pagar.me times out at night and renewals were silently lost (B4A-123).
```

Examples that fail: the untouched template (comment only), `TBD`, `n/a`, `<what and why>`, or a description without the heading.

### What the check does

- Finds the `## What and Why` (or `###`, or `What & Why`) heading in the PR body, ignoring HTML comments.
- Fails when the section is missing, empty, placeholder-only or shorter than 20 characters of real text. The job exits 1, which blocks the merge wherever the workflow is required.
- Writes a job summary with the outcome, the text found, notes and a "how to fix" block, plus an error annotation on failure.

### Author alert (sticky comment)

When the check fails on `opened`, `edited`, `synchronize` or `reopened`, the workflow keeps **one** comment on the PR, identified by a hidden marker (`<!-- b4a-what-and-why -->`):

- First failure: posts the comment, which `@mentions` the PR author. GitHub notifies them (email, depending on their notification settings) because of the mention.
- Later pushes or edits while still failing: updates that same comment in place. No new comment, no new notification.
- Once the section is filled: edits the comment into a short "resolved" note.
- Fork PRs: the workflow token is read-only, so the comment is skipped (the job summary says so) but the check still fails.
- If the comment API refuses (for example a repository that restricts `GITHUB_TOKEN`), the check result stands and a warning annotation explains that the alert could not be posted.

The comment needs `pull-requests: write` and `issues: write`. The workflow declares them in its `permissions` block; when calling it with `uses:` the caller must grant the same permissions (see below).

### Skips

The check passes without inspecting the body for PRs authored by `dependabot` or `renovate` (including the `[bot]` logins). There is no exemption label.

### Rollout (org owners)

1. **Default PR template.** Nothing to do: `.github/pull_request_template.md` in this repo already starts with `## What and Why`. Repos that keep their own template must add the section to it.
2. **Org ruleset.** Add the workflow to the same ruleset as the Brain context gate (or create a sibling one). *Organisation settings → Repository → Rulesets → `Brain context gate` → Edit*:
   - Under **Require workflows to pass before merging** → *Add workflow* → repository `B4AGroup/.github`, branch `main`, path `.github/workflows/what-and-why.yml`.
   - Keep the targets as they are (all repositories, default branch plus `main`, `master`, `develop`). `b4a-brain` may stay excluded or be included; the What and Why gate has no special case for it.
   - Enforcement: *Active*. The gate is meant to block immediately; use *Evaluate* only if you want to watch the ruleset insights for a day first.
   - Bypass list: leave empty.
3. **Workflow permissions.** The required workflow runs with the target repository's `GITHUB_TOKEN` and asks for `pull-requests: write` and `issues: write` in its `permissions` block. No change is needed for repositories using the default settings. If a repository has *Settings → Actions → General → Workflow permissions* locked down by a policy that forbids elevating permissions, the check still runs and fails correctly; only the comment is skipped (warning annotation).
4. **Calling it directly** (instead of, or in addition to, the ruleset) from a repo workflow:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
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
node --test scripts/what-and-why/lib.test.mjs
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
