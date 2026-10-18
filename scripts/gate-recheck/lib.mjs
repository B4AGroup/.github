// Gate re-check tool: core logic.
// Dependency-free (Node 20+). All I/O (fetch, sleep, log) is injected so the
// logic can be unit-tested without the network.
//
// Two modes:
//   recheck       — for every open PR in the org whose base is the default
//                   branch, main, master or develop, add and then remove the
//                   `gate-recheck` label. Each label change is a pull_request
//                   event (labeled / unlabeled), which re-runs both ruleset
//                   required workflows (brain-context.yml, what-and-why.yml).
//   exempt-label  — create the `brain-context-exempt` label in every repo
//                   that lacks it.
// Both modes are dry-run unless --apply is given.

export const DEFAULT_ORG = 'B4AGroup';
export const DEFAULT_API_URL = 'https://api.github.com';
export const GATED_BRANCHES = ['main', 'master', 'develop'];
export const ALWAYS_EXCLUDED_REPOS = ['b4a-brain'];
export const MODES = ['recheck', 'exempt-label'];
export const DEFAULT_DELAY_MS = 1000;
export const DEFAULT_SETTLE_MS = 2000;
export const RATE_LIMIT_FLOOR = 25;
export const MAX_RETRIES = 3;
export const MAX_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;
export const MAX_PAGES = 100;

export const RECHECK_LABEL = {
  name: 'gate-recheck',
  color: 'ededed',
  description: 'Temporary. Added and removed by scripts/gate-recheck (B4AGroup/.github) to re-run the Brain context and What and Why checks. Safe to delete.',
};

export const EXEMPT_LABEL = {
  name: 'brain-context-exempt',
  color: 'd93f0b',
  description: 'Lead override: skips the Brain context gate for this PR. The override is recorded in the job summary.',
};

const HELP = `Usage: node scripts/gate-recheck/recheck.mjs [options]

Re-runs the ruleset required workflows (Brain context, What and Why) on every
open pull request of the organisation, or creates the brain-context-exempt
label everywhere. Dry-run by default: nothing is written unless --apply is set.

Options:
  --mode <recheck|exempt-label>  What to do (default: recheck).
  --apply                        Actually write. Without it the tool only prints what it would touch.
  --org <name>                   GitHub organisation (default: ${DEFAULT_ORG}).
  --label <name>                 Name of the temporary re-check label (default: ${RECHECK_LABEL.name}).
  --repo <name[,name]>           Only these repositories (repeatable). Default: every non-archived repo.
  --exclude <name[,name]>        Skip these repositories (repeatable). ${ALWAYS_EXCLUDED_REPOS.join(', ')} and archived repos are always skipped.
  --skip-drafts                  Do not touch draft pull requests (default: drafts are included).
  --delay-ms <n>                 Pause after every write (default: ${DEFAULT_DELAY_MS}).
  --settle-ms <n>                Pause between adding and removing the label on one PR (default: ${DEFAULT_SETTLE_MS}).
  --help                         Show this text.

Token: read from GATE_RECHECK_TOKEN, then GH_TOKEN, then GITHUB_TOKEN. It needs
read access to the repositories and, with --apply, write access to issues/pull
requests (labels). Events created with a workflow's own GITHUB_TOKEN do not
trigger other workflows, so use a PAT or a GitHub App token for --apply.
`;

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNonNegativeInt(flag, raw) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return { error: `${flag} needs a non-negative integer, got "${raw ?? ''}"` };
  }
  return { value: Number(raw) };
}

/** Parses CLI arguments. Returns { ok: true, options } or { ok: false, error } ({ ok: true, help: true } for --help). */
export function parseArgs(argv) {
  const options = {
    mode: 'recheck',
    apply: false,
    org: DEFAULT_ORG,
    label: RECHECK_LABEL.name,
    repos: [],
    exclude: [],
    skipDrafts: false,
    delayMs: DEFAULT_DELAY_MS,
    settleMs: DEFAULT_SETTLE_MS,
  };
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    const takeValue = () => {
      const value = args.shift();
      return value === undefined || value.startsWith('--') ? undefined : value;
    };
    switch (flag) {
      case '--help':
      case '-h':
        return { ok: true, help: true, text: HELP };
      case '--apply':
        options.apply = true;
        break;
      case '--skip-drafts':
        options.skipDrafts = true;
        break;
      case '--mode': {
        const value = takeValue();
        if (!MODES.includes(value)) return { ok: false, error: `--mode must be one of ${MODES.join(', ')}, got "${value ?? ''}"` };
        options.mode = value;
        break;
      }
      case '--org': {
        const value = takeValue();
        if (!value) return { ok: false, error: '--org needs a value' };
        options.org = value;
        break;
      }
      case '--label': {
        const value = takeValue();
        if (!value) return { ok: false, error: '--label needs a value' };
        options.label = value;
        break;
      }
      case '--repo':
        options.repos.push(...splitList(takeValue()));
        break;
      case '--exclude':
        options.exclude.push(...splitList(takeValue()));
        break;
      case '--delay-ms':
      case '--settle-ms': {
        const parsed = parseNonNegativeInt(flag, takeValue());
        if (parsed.error) return { ok: false, error: parsed.error };
        options[flag === '--delay-ms' ? 'delayMs' : 'settleMs'] = parsed.value;
        break;
      }
      default:
        return { ok: false, error: `Unknown argument "${flag}". Use --help.` };
    }
  }
  return { ok: true, options };
}

export function helpText() {
  return HELP;
}

/** Picks the token from the environment without printing it. */
export function resolveToken(env) {
  for (const name of ['GATE_RECHECK_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = (env[name] ?? '').trim();
    if (value) return { token: value, source: name };
  }
  return { token: null, source: null };
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'b4a-gate-recheck',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function header(res, name) {
  const headers = res?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function clampWait(ms) {
  return Math.max(0, Math.min(ms, MAX_RATE_LIMIT_WAIT_MS));
}

/** Milliseconds to wait before retrying `res`, or null when the response should not be retried. */
export function retryDelayMs(res, attempt, now = Date.now()) {
  const retryAfter = header(res, 'retry-after');
  const remaining = header(res, 'x-ratelimit-remaining');
  const reset = header(res, 'x-ratelimit-reset');
  const rateLimited = res.status === 429 || (res.status === 403 && (retryAfter !== null || remaining === '0'));
  if (rateLimited) {
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) return clampWait(Number(retryAfter) * 1000 + 1000);
    if (reset !== null && /^\d+$/.test(reset)) return clampWait(Number(reset) * 1000 - now + 1000);
    return clampWait(60 * 1000);
  }
  if (res.status >= 500) return clampWait(1000 * 2 ** attempt);
  return null;
}

/** Proactive pause when the primary rate limit is nearly exhausted. Returns the wait in ms (0 when none). */
export function rateLimitPauseMs(res, now = Date.now()) {
  const remaining = header(res, 'x-ratelimit-remaining');
  const reset = header(res, 'x-ratelimit-reset');
  if (remaining === null || !/^\d+$/.test(remaining) || Number(remaining) >= RATE_LIMIT_FLOOR) return 0;
  if (reset === null || !/^\d+$/.test(reset)) return 0;
  return clampWait(Number(reset) * 1000 - now + 1000);
}

/**
 * Minimal GitHub REST client: retries on rate limits and 5xx, pauses before
 * the primary limit runs out, paginates. Never throws on HTTP status codes;
 * callers inspect `status`.
 */
export function createClient({ token, apiUrl = DEFAULT_API_URL, fetch = globalThis.fetch, sleep = defaultSleep, log = () => {}, now = Date.now }) {
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: githubHeaders(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const wait = retryDelayMs(res, attempt, now());
      if (wait === null || attempt >= MAX_RETRIES) {
        const pause = rateLimitPauseMs(res, now());
        if (pause > 0) {
          log(`  rate limit nearly exhausted; pausing ${Math.ceil(pause / 1000)}s`);
          await sleep(pause);
        }
        return { status: res.status, data: res.status === 204 ? null : await readJson(res) };
      }
      log(`  ${method} ${path} -> HTTP ${res.status}; retrying in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  async function paginate(path) {
    const items = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await request('GET', `${path}${separator}per_page=100&page=${page}`);
      if (res.status !== 200) return { status: res.status, items, error: `HTTP ${res.status} on GET ${path}` };
      const batch = Array.isArray(res.data) ? res.data : [];
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return { status: 200, items };
  }

  return { request, paginate };
}

export async function listRepos(client, org) {
  const res = await client.paginate(`/orgs/${encodeURIComponent(org)}/repos?type=all&sort=full_name`);
  if (res.error) return { error: `could not list repositories of ${org}: ${res.error}`, repos: [] };
  const repos = res.items.map((repo) => ({
    name: repo.name,
    fullName: repo.full_name,
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    defaultBranch: repo.default_branch ?? 'main',
  }));
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { repos };
}

/** Applies the always-excluded list, --exclude, --repo and the archived/disabled filters. */
export function selectRepos(repos, { repos: only = [], exclude = [] } = {}) {
  const onlySet = new Set(only.map((name) => name.toLowerCase()));
  const excludeSet = new Set([...ALWAYS_EXCLUDED_REPOS, ...exclude].map((name) => name.toLowerCase()));
  const selected = [];
  const skipped = [];
  for (const repo of repos) {
    const key = repo.name.toLowerCase();
    if (onlySet.size > 0 && !onlySet.has(key)) continue;
    if (excludeSet.has(key)) skipped.push({ repo: repo.fullName, reason: 'excluded' });
    else if (repo.archived) skipped.push({ repo: repo.fullName, reason: 'archived' });
    else if (repo.disabled) skipped.push({ repo: repo.fullName, reason: 'disabled' });
    else selected.push(repo);
  }
  return { selected, skipped };
}

export function isGatedBase(baseRef, defaultBranch) {
  if (!baseRef) return false;
  return baseRef === defaultBranch || GATED_BRANCHES.includes(baseRef);
}

export async function listOpenPulls(client, fullName) {
  const res = await client.paginate(`/repos/${fullName}/pulls?state=open`);
  if (res.error) return { error: `could not list pull requests of ${fullName}: ${res.error}`, pulls: [] };
  const pulls = res.items.map((pr) => ({
    number: pr.number,
    title: pr.title ?? '',
    draft: Boolean(pr.draft),
    baseRef: pr.base?.ref ?? '',
    author: pr.user?.login ?? 'unknown',
    labels: (pr.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name ?? '')),
    url: pr.html_url ?? '',
  }));
  pulls.sort((a, b) => a.number - b.number);
  return { pulls };
}

/**
 * Makes sure `label` exists in the repo. Dry-run reports what would be created.
 * Returns { state: 'present' | 'created' | 'would-create' | 'error', note? }.
 */
export async function ensureLabel(client, fullName, label, { apply }) {
  const existing = await client.request('GET', `/repos/${fullName}/labels/${encodeURIComponent(label.name)}`);
  if (existing.status === 200) return { state: 'present' };
  if (existing.status !== 404) return { state: 'error', note: `could not read label "${label.name}" (HTTP ${existing.status})` };
  if (!apply) return { state: 'would-create' };
  const created = await client.request('POST', `/repos/${fullName}/labels`, {
    name: label.name,
    color: label.color,
    description: label.description,
  });
  if (created.status === 201) return { state: 'created' };
  // 422 "already_exists" means another run created it between our GET and POST.
  if (created.status === 422) return { state: 'present' };
  return { state: 'error', note: `could not create label "${label.name}" (HTTP ${created.status})` };
}

/**
 * Fires pull_request events on one PR by adding then removing `labelName`.
 * A PR that already carries the label only gets the removal (one event).
 * Returns { events: ['labeled', 'unlabeled'] | ['unlabeled'], error? }.
 */
export async function fireRecheck(client, fullName, pr, labelName, { settleMs, delayMs, sleep }) {
  const issuePath = `/repos/${fullName}/issues/${pr.number}/labels`;
  const events = [];
  if (!pr.labels.includes(labelName)) {
    const added = await client.request('POST', issuePath, { labels: [labelName] });
    if (added.status !== 200) return { events, error: `could not add label to #${pr.number} (HTTP ${added.status})` };
    events.push('labeled');
    await sleep(settleMs);
  }
  const removed = await client.request('DELETE', `${issuePath}/${encodeURIComponent(labelName)}`);
  if (removed.status !== 200 && removed.status !== 404) {
    return { events, error: `could not remove label from #${pr.number} (HTTP ${removed.status})` };
  }
  events.push('unlabeled');
  await sleep(delayMs);
  return { events };
}

function describePr(pr) {
  const flags = [`base ${pr.baseRef}`, pr.draft ? 'draft' : 'ready', `by ${pr.author}`];
  return `#${pr.number} "${pr.title}" (${flags.join(', ')})`;
}

function tag(apply) {
  return apply ? '[apply]' : '[dry-run]';
}

async function recheckRepo(repo, options, deps, summary) {
  const { client, log, sleep } = deps;
  const listed = await listOpenPulls(client, repo.fullName);
  if (listed.error) {
    summary.errors.push(listed.error);
    log(`${repo.fullName}: ERROR ${listed.error}`);
    return;
  }
  const gated = [];
  let skippedBase = 0;
  let skippedDraft = 0;
  for (const pr of listed.pulls) {
    if (!isGatedBase(pr.baseRef, repo.defaultBranch)) skippedBase += 1;
    else if (options.skipDrafts && pr.draft) skippedDraft += 1;
    else gated.push(pr);
  }
  summary.prs.skippedBase += skippedBase;
  summary.prs.skippedDraft += skippedDraft;
  log(`${repo.fullName} (default ${repo.defaultBranch}): ${listed.pulls.length} open PR(s), ${gated.length} on gated branches`
    + (skippedBase ? `, ${skippedBase} on other branches` : '')
    + (skippedDraft ? `, ${skippedDraft} draft(s) skipped` : ''));
  if (gated.length === 0) return;

  const label = { ...RECHECK_LABEL, name: options.label };
  const ensured = await ensureLabel(client, repo.fullName, label, options);
  if (ensured.state === 'error') {
    summary.errors.push(`${repo.fullName}: ${ensured.note}`);
    log(`  ERROR ${ensured.note}; skipping ${gated.length} PR(s)`);
    return;
  }
  if (ensured.state !== 'present') {
    summary.labels[ensured.state === 'created' ? 'created' : 'wouldCreate'].push(repo.fullName);
    log(`  ${tag(options.apply)} ${ensured.state === 'created' ? 'created' : 'would create'} label "${label.name}"`);
    if (ensured.state === 'created') await sleep(options.delayMs);
  }

  for (const pr of gated) {
    const entry = { repo: repo.fullName, number: pr.number, url: pr.url, draft: pr.draft, baseRef: pr.baseRef, author: pr.author };
    if (!options.apply) {
      summary.prs.planned.push(entry);
      log(`  ${tag(false)} ${describePr(pr)} -> would add + remove "${label.name}"`);
      continue;
    }
    const fired = await fireRecheck(client, repo.fullName, pr, label.name, { ...options, sleep });
    if (fired.error) {
      summary.errors.push(`${repo.fullName}: ${fired.error}`);
      log(`  ERROR ${describePr(pr)}: ${fired.error}`);
      continue;
    }
    summary.prs.touched.push({ ...entry, events: fired.events });
    log(`  ${tag(true)} ${describePr(pr)} -> fired ${fired.events.join(' + ')}`);
  }
}

function newSummary(mode, options) {
  return {
    mode,
    apply: options.apply,
    org: options.org,
    repos: { scanned: 0, selected: 0, skipped: [] },
    labels: { created: [], wouldCreate: [], present: [] },
    prs: { planned: [], touched: [], skippedBase: 0, skippedDraft: 0 },
    errors: [],
  };
}

async function selectOrgRepos(options, deps, summary) {
  const listed = await listRepos(deps.client, options.org);
  if (listed.error) {
    summary.errors.push(listed.error);
    deps.log(`ERROR ${listed.error}`);
    return null;
  }
  const { selected, skipped } = selectRepos(listed.repos, options);
  summary.repos.scanned = listed.repos.length;
  summary.repos.selected = selected.length;
  summary.repos.skipped = skipped;
  deps.log(`${options.org}: ${listed.repos.length} repositories, ${selected.length} selected, ${skipped.length} skipped`
    + (skipped.length ? ` (${skipped.map((item) => `${item.repo.split('/')[1]}: ${item.reason}`).join('; ')})` : ''));
  if (options.repos.length > 0) {
    const known = new Set(listed.repos.map((repo) => repo.name.toLowerCase()));
    for (const name of options.repos) {
      if (!known.has(name.toLowerCase())) {
        summary.errors.push(`repository "${name}" not found in ${options.org}`);
        deps.log(`ERROR repository "${name}" not found in ${options.org}`);
      }
    }
  }
  return selected;
}

/** Mode `recheck`. Returns the summary; errors are collected, never thrown. */
export async function runRecheck(options, deps) {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const context = { ...deps, log, sleep };
  const summary = newSummary('recheck', options);
  log(`Mode: recheck ${tag(options.apply)} — label "${options.label}", drafts ${options.skipDrafts ? 'skipped' : 'included'}`);
  const selected = await selectOrgRepos(options, context, summary);
  if (!selected) return summary;
  for (const repo of selected) {
    try {
      await recheckRepo(repo, options, context, summary);
    } catch (error) {
      summary.errors.push(`${repo.fullName}: ${error?.message ?? error}`);
      log(`${repo.fullName}: ERROR ${error?.message ?? error}`);
    }
  }
  log(formatRecheckTotals(summary));
  return summary;
}

/** Mode `exempt-label`. Returns the summary; errors are collected, never thrown. */
export async function runExemptLabel(options, deps) {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const context = { ...deps, log, sleep };
  const summary = newSummary('exempt-label', options);
  log(`Mode: exempt-label ${tag(options.apply)} — label "${EXEMPT_LABEL.name}"`);
  const selected = await selectOrgRepos(options, context, summary);
  if (!selected) return summary;
  for (const repo of selected) {
    try {
      const ensured = await ensureLabel(context.client, repo.fullName, EXEMPT_LABEL, options);
      if (ensured.state === 'error') {
        summary.errors.push(`${repo.fullName}: ${ensured.note}`);
        log(`${repo.fullName}: ERROR ${ensured.note}`);
        continue;
      }
      if (ensured.state === 'present') {
        summary.labels.present.push(repo.fullName);
        log(`${repo.fullName}: label present`);
        continue;
      }
      summary.labels[ensured.state === 'created' ? 'created' : 'wouldCreate'].push(repo.fullName);
      log(`${repo.fullName}: ${tag(options.apply)} ${ensured.state === 'created' ? 'created' : 'would create'} label "${EXEMPT_LABEL.name}"`);
      if (ensured.state === 'created') await sleep(options.delayMs);
    } catch (error) {
      summary.errors.push(`${repo.fullName}: ${error?.message ?? error}`);
      log(`${repo.fullName}: ERROR ${error?.message ?? error}`);
    }
  }
  log(formatExemptTotals(summary));
  return summary;
}

function formatRecheckTotals(summary) {
  const verb = summary.apply ? 'touched' : 'would touch';
  const count = summary.apply ? summary.prs.touched.length : summary.prs.planned.length;
  const labels = summary.apply ? summary.labels.created.length : summary.labels.wouldCreate.length;
  return `Totals: ${summary.repos.selected} repo(s) scanned, ${count} PR(s) ${verb}, ${labels} label(s) ${summary.apply ? 'created' : 'to create'}, `
    + `${summary.prs.skippedBase} PR(s) on non-gated branches, ${summary.prs.skippedDraft} draft(s) skipped, ${summary.errors.length} error(s).`;
}

function formatExemptTotals(summary) {
  const labels = summary.apply ? summary.labels.created.length : summary.labels.wouldCreate.length;
  return `Totals: ${summary.repos.selected} repo(s) scanned, ${summary.labels.present.length} already had the label, `
    + `${labels} ${summary.apply ? 'created' : 'to create'}, ${summary.errors.length} error(s).`;
}

/** Markdown for GITHUB_STEP_SUMMARY. */
export function buildStepSummary(summary) {
  const lines = [`## Gate re-check — ${summary.mode} (${summary.apply ? 'apply' : 'dry-run'})`, ''];
  lines.push(`Organisation: \`${summary.org}\``);
  lines.push(`Repositories: ${summary.repos.scanned} found, ${summary.repos.selected} selected, ${summary.repos.skipped.length} skipped`);
  lines.push('');
  if (summary.mode === 'recheck') {
    lines.push(formatRecheckTotals(summary), '');
    const rows = summary.apply ? summary.prs.touched : summary.prs.planned;
    if (rows.length) {
      lines.push('| PR | Base | Draft | Author | Result |', '| --- | --- | --- | --- | --- |');
      for (const row of rows) {
        const link = row.url ? `[${row.repo}#${row.number}](${row.url})` : `${row.repo}#${row.number}`;
        lines.push(`| ${link} | ${row.baseRef} | ${row.draft ? 'yes' : 'no'} | ${row.author} | ${row.events ? row.events.join(' + ') : 'would add + remove label'} |`);
      }
      lines.push('');
    }
  } else {
    lines.push(formatExemptTotals(summary), '');
    const rows = summary.apply ? summary.labels.created : summary.labels.wouldCreate;
    if (rows.length) {
      lines.push(`${summary.apply ? 'Created' : 'Would create'} in:`, ...rows.map((repo) => `- ${repo}`), '');
    }
  }
  if (summary.repos.skipped.length) {
    lines.push('### Skipped repositories', ...summary.repos.skipped.map((item) => `- ${item.repo}: ${item.reason}`), '');
  }
  if (summary.errors.length) {
    lines.push('### Errors', ...summary.errors.map((error) => `- ${error}`), '');
  }
  return `${lines.join('\n')}\n`;
}
