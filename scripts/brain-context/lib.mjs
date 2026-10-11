// Brain context PR gate: core logic.
// Dependency-free (Node 20+). Everything here is pure or takes its I/O
// (fetch, clock) as parameters so it can be unit-tested without the network.

export const BRAIN_REPO = 'B4AGroup/b4a-brain';
export const BRAIN_REPO_URL = `https://github.com/${BRAIN_REPO}`;
export const EXEMPT_LABEL = 'brain-context-exempt';
export const DEFAULT_ENFORCE_AFTER = '2026-10-19T00:00:00-03:00';
export const MIN_REASON_LENGTH = 15;
export const DEFAULT_API_URL = 'https://api.github.com';

const HEADING_RE = /^(#{2,3})\s*brain context\b.*$/im;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const BOT_AUTHOR_RE = /^(dependabot|renovate)(-preview)?(\[bot\])?$/i;
const NONE_RELEVANT_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__|`)?none relevant(?:\*\*|__|`)?\s*:\s*(.*)$/i;
const BRAIN_URL_RE = /https?:\/\/(?:www\.)?github\.com\/b4agroup\/b4a-brain(\/[^\s<>()[\]"']*)?/gi;
const PAGE_PATH_RE = /^\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*))?/i;

export function isBotAuthor(login) {
  return typeof login === 'string' && BOT_AUTHOR_RE.test(login.trim());
}

export function stripHtmlComments(text) {
  return String(text ?? '').replace(HTML_COMMENT_RE, '');
}

/**
 * Finds the "Brain context" section (h2 or h3) and returns its raw content up to
 * the next heading of the same or higher level.
 */
export function findBrainContextSection(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => HEADING_RE.test(line));
  if (start === -1) return { found: false, heading: null, content: '' };

  const heading = lines[start];
  const level = heading.match(/^#+/)[0].length;
  const content = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(ANY_HEADING_RE);
    if (match && match[1].length <= level) break;
    content.push(line);
  }
  return { found: true, heading: heading.trim(), content: content.join('\n') };
}

function trimTrailingPunctuation(url) {
  return url.replace(/[.,;:!?*_]+$/, '');
}

/**
 * Extracts every link to the brain repo from the section and classifies it.
 * Only /blob/<ref>/<path> and /tree/<ref>/<path> links count as pages.
 */
export function extractBrainLinks(sectionText) {
  const text = stripHtmlComments(sectionText);
  const seen = new Set();
  const links = [];
  for (const match of text.matchAll(BRAIN_URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);

    const rest = url.replace(/^https?:\/\/(?:www\.)?github\.com\/b4agroup\/b4a-brain/i, '');
    const page = rest.match(PAGE_PATH_RE);
    if (!page) {
      links.push({ url, valid: false, problem: 'not a /blob/ or /tree/ page link' });
      continue;
    }
    const [, kind, ref, rawPath = ''] = page;
    const path = rawPath.replace(/\/+$/, '');
    if (!path) {
      links.push({ url, valid: false, problem: 'points at the repository root, not a page' });
      continue;
    }
    links.push({ url, valid: true, kind: kind.toLowerCase(), ref, path: safeDecode(path) });
  }
  return links;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Looks for a "none relevant: <reason>" line with a real reason. */
export function findNoneRelevant(sectionText) {
  const text = stripHtmlComments(sectionText);
  for (const line of text.split('\n')) {
    const match = line.match(NONE_RELEVANT_RE);
    if (!match) continue;
    const reason = match[1].trim();
    if (!reason || /^<[^>]*>$/.test(reason)) {
      return { present: true, reason, valid: false, problem: 'the reason is missing or still the placeholder' };
    }
    if (reason.length < MIN_REASON_LENGTH) {
      return {
        present: true,
        reason,
        valid: false,
        problem: `the reason has ${reason.length} characters; at least ${MIN_REASON_LENGTH} are required`,
      };
    }
    return { present: true, reason, valid: true };
  }
  return { present: false, reason: null, valid: false };
}

/**
 * Static evaluation of the PR body (no network).
 * ok === true when the section has at least one page link or a valid "none relevant" line.
 */
export function evaluateBody(body) {
  const section = findBrainContextSection(body);
  if (!section.found) {
    return {
      ok: false,
      section,
      links: [],
      noneRelevant: { present: false, reason: null, valid: false },
      problems: ['The PR description has no "## Brain context" heading.'],
    };
  }
  const links = extractBrainLinks(section.content);
  const noneRelevant = findNoneRelevant(section.content);
  const validLinks = links.filter((link) => link.valid);
  const problems = [];

  if (validLinks.length === 0 && !noneRelevant.valid) {
    if (links.length > 0) {
      for (const link of links) problems.push(`Link ${link.url} does not count: ${link.problem}.`);
    }
    if (noneRelevant.present) {
      problems.push(`"none relevant" line found but ${noneRelevant.problem}.`);
    }
    if (problems.length === 0) {
      problems.push('The "Brain context" section has no b4a-brain page link and no "none relevant: <reason>" line.');
    }
  }
  return { ok: problems.length === 0, section, links, noneRelevant, problems };
}

/** Decides whether the gate is skipped for this PR. */
export function decideSkip(pr) {
  const login = pr?.user?.login ?? '';
  if (isBotAuthor(login)) {
    return { skip: true, kind: 'bot', reason: `author \`${login}\` is a dependency bot` };
  }
  const baseRepo = pr?.base?.repo?.full_name ?? '';
  if (baseRepo.toLowerCase() === BRAIN_REPO.toLowerCase()) {
    return { skip: true, kind: 'brain-repo', reason: `pull request targets ${BRAIN_REPO} itself` };
  }
  const labels = (pr?.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name ?? ''));
  if (labels.some((name) => name.toLowerCase() === EXEMPT_LABEL)) {
    return { skip: true, kind: 'exempt-label', reason: `label \`${EXEMPT_LABEL}\` is present (lead override)` };
  }
  return { skip: false };
}

/** Parses ENFORCE_AFTER and tells whether failures block at `now`. */
export function resolveMode(now, enforceAfterRaw) {
  const raw = (enforceAfterRaw ?? '').trim() || DEFAULT_ENFORCE_AFTER;
  const enforceAfter = new Date(raw);
  if (Number.isNaN(enforceAfter.getTime())) {
    return { error: `ENFORCE_AFTER is not a valid ISO-8601 date: "${raw}"`, raw };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  return { enforcing: nowDate.getTime() >= enforceAfter.getTime(), enforceAfter, raw };
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'b4a-brain-context-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Returns 'ok' when the token can read the brain repo, 'denied' when it cannot, 'error' otherwise. */
export async function probeBrainAccess({ fetch, token, apiUrl = DEFAULT_API_URL }) {
  try {
    const res = await fetch(`${apiUrl}/repos/${BRAIN_REPO}`, { headers: githubHeaders(token) });
    if (res.status === 200) return { access: 'ok' };
    if ([401, 403, 404].includes(res.status)) return { access: 'denied', status: res.status };
    return { access: 'error', status: res.status };
  } catch (error) {
    return { access: 'error', message: error?.message ?? String(error) };
  }
}

function encodePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** Resolves one page link through the contents API. */
export async function checkLinkExists(link, { fetch, token, apiUrl = DEFAULT_API_URL }) {
  const url = `${apiUrl}/repos/${BRAIN_REPO}/contents/${encodePath(link.path)}?ref=${encodeURIComponent(link.ref)}`;
  try {
    const res = await fetch(url, { headers: githubHeaders(token) });
    if (res.status === 200) return { ...link, exists: true };
    if (res.status === 404) return { ...link, exists: false, problem: `not found in ${BRAIN_REPO} at ref "${link.ref}"` };
    return { ...link, exists: null, problem: `could not verify (HTTP ${res.status})` };
  } catch (error) {
    return { ...link, exists: null, problem: `could not verify (${error?.message ?? error})` };
  }
}

/**
 * Verifies page links. When the token cannot read the brain repo, existence
 * checks are skipped and only the URL format is validated.
 */
export async function verifyLinks(links, io) {
  const valid = links.filter((link) => link.valid);
  if (valid.length === 0) return { mode: 'none', links, notes: [] };

  const probe = await probeBrainAccess(io);
  if (probe.access !== 'ok') {
    const detail = probe.access === 'denied'
      ? `the token cannot read ${BRAIN_REPO} (HTTP ${probe.status})`
      : `the GitHub API could not be reached (${probe.status ?? probe.message})`;
    return {
      mode: 'format-only',
      links,
      notes: [`Link existence checks skipped: ${detail}. Only the URL format was validated.`],
    };
  }

  const checked = [];
  for (const link of links) {
    checked.push(link.valid ? await checkLinkExists(link, io) : link);
  }
  return { mode: 'resolved', links: checked, notes: [] };
}

/**
 * TODO(Phase B): verify that the PR author ran `brain.search` through the B4A
 * MCP gateway during the branch window (from the branch's first commit, or the
 * PR creation, until now). This will query the gateway's audit log through an
 * endpoint that has not been provided yet. Keep disabled behind
 * VERIFY_SEARCH_LOG=false until the endpoint, its auth and the retention rules
 * are agreed. Must never receive or log secrets.
 */
export async function verifySearchLog({ enabled, endpoint, author, windowStart, windowEnd }) {
  if (!enabled) return { checked: false, note: null };
  if (!endpoint) {
    return {
      checked: false,
      note: 'VERIFY_SEARCH_LOG=true but SEARCH_LOG_ENDPOINT is not set; Phase B check skipped.',
    };
  }
  return {
    checked: false,
    note: `Phase B (search-log verification for ${author} between ${windowStart} and ${windowEnd}) is not implemented yet; skipped.`,
  };
}

function formatLinkLine(link) {
  if (!link.valid) return `- ${link.url} — does not count (${link.problem})`;
  if (link.exists === true) return `- ${link.url} — resolves`;
  if (link.exists === false) return `- ${link.url} — **does not resolve** (${link.problem})`;
  if (link.exists === null) return `- ${link.url} — ${link.problem}`;
  return `- ${link.url} — format ok`;
}

export function howToFix() {
  return [
    'How to fix: edit the PR description and, under the `## Brain context` heading, either',
    `- add one link per line to the b4a-brain pages you checked (${BRAIN_REPO_URL}/blob/... or /tree/...), found with \`brain.search\` in the B4A MCP connector, or`,
    `- write \`none relevant: <reason>\` with a reason of at least ${MIN_REASON_LENGTH} characters.`,
    `Leads can override by adding the \`${EXEMPT_LABEL}\` label (the override is recorded in the job summary).`,
  ].join('\n');
}

export function buildSummary(result) {
  const lines = [`## Brain context gate — ${result.title}`, ''];
  if (result.pr) {
    lines.push(`PR: ${result.pr.repo}#${result.pr.number} by \`${result.pr.author}\``);
  }
  if (result.modeLine) lines.push(result.modeLine);
  lines.push('');
  for (const line of result.lines ?? []) lines.push(line);
  if (result.links?.length) {
    lines.push('', '### Links', ...result.links.map(formatLinkLine));
  }
  if (result.noneRelevant?.valid) {
    lines.push('', `### None relevant`, `Reason given: ${result.noneRelevant.reason}`);
  }
  if (result.notes?.length) {
    lines.push('', '### Notes', ...result.notes.map((note) => `- ${note}`));
  }
  if (result.problems?.length) {
    lines.push('', '### Problems', ...result.problems.map((problem) => `- ${problem}`), '', howToFix());
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Runs the whole gate for a pull_request event payload.
 * Returns { status: 'pass' | 'skip' | 'warn' | 'fail' | 'error', exitCode, summary, annotations }.
 */
export async function runCheck({ event, env = {}, now = new Date(), fetch = globalThis.fetch }) {
  const pr = event?.pull_request;
  if (!pr) {
    const message = 'No pull_request in the event payload. This workflow must run on pull_request events.';
    return {
      status: 'error',
      exitCode: 1,
      annotations: [{ level: 'error', message }],
      summary: buildSummary({ title: 'configuration error', problems: [message] }),
    };
  }

  const prInfo = {
    repo: pr.base?.repo?.full_name ?? env.GITHUB_REPOSITORY ?? 'unknown',
    number: pr.number,
    author: pr.user?.login ?? 'unknown',
  };

  const mode = resolveMode(now, env.ENFORCE_AFTER);
  if (mode.error) {
    return {
      status: 'error',
      exitCode: 1,
      annotations: [{ level: 'error', message: mode.error }],
      summary: buildSummary({ title: 'configuration error', pr: prInfo, problems: [mode.error] }),
    };
  }
  const modeLine = mode.enforcing
    ? `Mode: **blocking** (ENFORCE_AFTER=${mode.raw} has passed).`
    : `Mode: **warning only** until ${mode.raw}; from then on this check blocks the merge.`;

  const skip = decideSkip(pr);
  if (skip.skip) {
    const line = skip.kind === 'exempt-label'
      ? `Lead override: ${skip.reason}. Check skipped and recorded here for audit.`
      : `Check skipped: ${skip.reason}.`;
    return {
      status: 'skip',
      exitCode: 0,
      annotations: skip.kind === 'exempt-label' ? [{ level: 'notice', message: line }] : [],
      summary: buildSummary({ title: 'skipped', pr: prInfo, modeLine, lines: [line] }),
    };
  }

  const evaluation = evaluateBody(pr.body);
  const problems = [...evaluation.problems];
  const notes = [];
  let links = evaluation.links;

  if (evaluation.ok && links.some((link) => link.valid)) {
    const verification = await verifyLinks(links, {
      fetch,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
    });
    links = verification.links;
    notes.push(...verification.notes);
    for (const link of links) {
      if (link.valid && link.exists === false) {
        problems.push(`Link ${link.url} does not resolve: ${link.problem}.`);
      }
    }
  }

  const searchLog = await verifySearchLog({
    enabled: String(env.VERIFY_SEARCH_LOG ?? 'false').toLowerCase() === 'true',
    endpoint: env.SEARCH_LOG_ENDPOINT,
    author: prInfo.author,
    windowStart: pr.created_at,
    windowEnd: now instanceof Date ? now.toISOString() : String(now),
  });
  if (searchLog.note) notes.push(searchLog.note);

  if (problems.length === 0) {
    return {
      status: 'pass',
      exitCode: 0,
      annotations: [],
      summary: buildSummary({
        title: 'passed',
        pr: prInfo,
        modeLine,
        lines: ['The "Brain context" section is filled in.'],
        links,
        noneRelevant: evaluation.noneRelevant,
        notes,
      }),
    };
  }

  const headline = `Brain context check ${mode.enforcing ? 'failed' : 'would fail'}: ${problems[0]}`;
  const message = `${headline}\n${howToFix()}`;
  const status = mode.enforcing ? 'fail' : 'warn';
  return {
    status,
    exitCode: mode.enforcing ? 1 : 0,
    annotations: [{ level: mode.enforcing ? 'error' : 'warning', message }],
    summary: buildSummary({
      title: mode.enforcing ? 'failed' : 'warning (not blocking yet)',
      pr: prInfo,
      modeLine,
      lines: mode.enforcing
        ? []
        : [`This PR would be blocked from ${mode.raw}. Fix it now to avoid surprises.`],
      links,
      noneRelevant: evaluation.noneRelevant,
      notes,
      problems,
    }),
  };
}
