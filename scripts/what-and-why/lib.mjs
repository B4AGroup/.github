// "What and Why" PR gate: core logic.
// Dependency-free (Node 20+). Everything here is pure or takes its I/O
// (fetch) as a parameter so it can be unit-tested without the network.

export const SECTION_TITLE = 'What and Why';
export const MIN_TEXT_LENGTH = 20;
export const COMMENT_MARKER = '<!-- b4a-what-and-why -->';
export const DEFAULT_API_URL = 'https://api.github.com';
export const COMMENT_ACTIONS = new Set(['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']);
// Single source of truth for the warn/block switch: 2026-10-19 00:00 America/Sao_Paulo.
// Before this instant a failing PR gets a warning (exit 0); from it on the job fails (exit 1).
// Override with the ENFORCE_AFTER env (ISO-8601) in tests.
export const DEFAULT_ENFORCE_AFTER = '2026-10-19T00:00:00-03:00';

const HEADING_RE = /^(#{2,3})\s*what\s*(?:and|&)\s*why\b.*$/im;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const BOT_AUTHOR_RE = /^(dependabot|renovate)(-preview)?(\[bot\])?$/i;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s*/;
const ANGLE_PLACEHOLDER_RE = /<[^<>\n]{1,80}>/g;
const EMPHASIS_RE = /[*_`~]+/g;
const PLACEHOLDER_WORDS = new Set(['tbd', 'todo', 'wip', 'n/a', 'na', 'none', 'nothing', 'tba', 'fixme', 'xxx', 'placeholder', 'pending', 'later']);

export function isBotAuthor(login) {
  return typeof login === 'string' && BOT_AUTHOR_RE.test(login.trim());
}

export function stripHtmlComments(text) {
  return String(text ?? '').replace(HTML_COMMENT_RE, '');
}

/**
 * Finds the "What and Why" section (h2 or h3; "What & Why" also counts) and
 * returns its raw content up to the next heading of the same or higher level.
 */
export function findSection(body) {
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

/**
 * Reduces the section to the text an author actually wrote: HTML comments,
 * list markers, emphasis and `<angle placeholders>` are removed, whitespace
 * is collapsed.
 */
export function extractMeaningfulText(sectionText) {
  const lines = stripHtmlComments(sectionText)
    .replace(ANGLE_PLACEHOLDER_RE, ' ')
    .split('\n')
    .map((line) => line.replace(LIST_MARKER_RE, '').replace(EMPHASIS_RE, '').trim())
    .filter(Boolean);
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function isPlaceholderOnly(text) {
  const words = text
    .toLowerCase()
    .replace(/\bn\/a\b/g, 'na')
    .split(/[\s,;:.!?()[\]{}/\\|-]+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) => PLACEHOLDER_WORDS.has(word) || /^\.+$/.test(word) || /^[?!]+$/.test(word));
}

/**
 * Static evaluation of the PR body (no network).
 * ok === true when the section exists and has real text about what and why.
 */
export function evaluateBody(body) {
  const section = findSection(body);
  if (!section.found) {
    return {
      ok: false,
      kind: 'missing',
      section,
      text: '',
      problems: [`The PR description has no "## ${SECTION_TITLE}" heading.`],
    };
  }
  const text = extractMeaningfulText(section.content);
  if (text.length === 0) {
    return {
      ok: false,
      kind: 'empty',
      section,
      text,
      problems: [`The "${SECTION_TITLE}" section is empty (only the template comment or blank lines).`],
    };
  }
  if (isPlaceholderOnly(text)) {
    return {
      ok: false,
      kind: 'placeholder',
      section,
      text,
      problems: [`The "${SECTION_TITLE}" section only has a placeholder ("${text}").`],
    };
  }
  if (text.length < MIN_TEXT_LENGTH) {
    return {
      ok: false,
      kind: 'too-short',
      section,
      text,
      problems: [`The "${SECTION_TITLE}" section has ${text.length} characters of text; at least ${MIN_TEXT_LENGTH} are required.`],
    };
  }
  return { ok: true, kind: 'ok', section, text, problems: [] };
}

/** Decides whether the gate is skipped for this PR. */
export function decideSkip(pr) {
  const login = pr?.user?.login ?? '';
  if (isBotAuthor(login)) {
    return { skip: true, kind: 'bot', reason: `author \`${login}\` is a dependency bot` };
  }
  return { skip: false };
}

/** Parses ENFORCE_AFTER (or the default) and tells whether failures block at `now`. */
export function resolveMode(now, enforceAfterRaw) {
  const raw = (enforceAfterRaw ?? '').trim() || DEFAULT_ENFORCE_AFTER;
  const enforceAfter = new Date(raw);
  if (Number.isNaN(enforceAfter.getTime())) {
    return { error: `ENFORCE_AFTER is not a valid ISO-8601 date: "${raw}"`, raw };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  return { enforcing: nowDate.getTime() >= enforceAfter.getTime(), enforceAfter, raw };
}

/** True when the head repository differs from the base (fork PR: GITHUB_TOKEN is read-only). */
export function isForkPullRequest(pr) {
  const head = pr?.head?.repo?.full_name;
  const base = pr?.base?.repo?.full_name;
  if (!head || !base) return Boolean(pr?.head?.repo?.fork);
  return head.toLowerCase() !== base.toLowerCase();
}

export function howToFix() {
  return [
    `How to fix: edit the PR description and, under the \`## ${SECTION_TITLE}\` heading, write what this PR changes and why it is needed.`,
    `At least ${MIN_TEXT_LENGTH} characters of real text are required; the template comment and placeholders such as \`TBD\` or \`<description>\` do not count.`,
    'Editing the description re-runs the check.',
  ].join('\n');
}

function runLink(runUrl) {
  return runUrl ? `[${SECTION_TITLE} check](${runUrl})` : `${SECTION_TITLE} check`;
}

/**
 * Comment posted while the section is missing. Mentions the author so GitHub notifies them.
 * `warnUntil` (ISO-8601 string) switches the text to warn mode: the check is not blocking yet.
 */
export function buildFailingComment({ author, problems, runUrl, warnUntil = null }) {
  const mention = author ? `@${author}, this` : 'This';
  const requirement = warnUntil
    ? [
      `${mention} pull request needs a filled **${SECTION_TITLE}** section in its description.`,
      '',
      `**Warning only until ${warnUntil}.** This check does not block the merge yet; from that instant on it fails the PR until the section is filled.`,
    ]
    : [`${mention} pull request needs a filled **${SECTION_TITLE}** section in its description before it can be merged.`];
  return [
    COMMENT_MARKER,
    `### ${SECTION_TITLE} is missing`,
    '',
    ...requirement,
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    howToFix(),
    '',
    `_This comment is maintained by the ${runLink(runUrl)}. It is updated in place on every push or edit and marked as resolved once the section is filled._`,
  ].join('\n');
}

/** Comment content once the section is filled. Replaces the failing text in place. */
export function buildResolvedComment({ runUrl }) {
  return [
    COMMENT_MARKER,
    `### ${SECTION_TITLE} — resolved`,
    '',
    `The **${SECTION_TITLE}** section is filled in. Thanks!`,
    '',
    `_Updated automatically by the ${runLink(runUrl)}._`,
  ].join('\n');
}

export function hasMarker(commentBody) {
  return typeof commentBody === 'string' && commentBody.includes(COMMENT_MARKER);
}

function normalizeBody(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'b4a-what-and-why-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Finds the sticky comment (by marker) among the PR's issue comments. */
export async function findStickyComment({ fetch, token, apiUrl = DEFAULT_API_URL, repo, number, maxPages = 10 }) {
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${apiUrl}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: githubHeaders(token) });
    if (res.status !== 200) {
      return { error: `could not list comments (HTTP ${res.status})`, comment: null };
    }
    const comments = (await readJson(res)) ?? [];
    const match = comments.find((comment) => hasMarker(comment?.body));
    if (match) return { comment: { id: match.id, body: match.body, url: match.html_url } };
    if (comments.length < 100) break;
  }
  return { comment: null };
}

async function createComment({ fetch, token, apiUrl, repo, number, body }) {
  const res = await fetch(`${apiUrl}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (res.status !== 201) return { error: `could not create the comment (HTTP ${res.status})` };
  const json = await readJson(res);
  return { url: json?.html_url ?? null };
}

async function updateComment({ fetch, token, apiUrl, repo, commentId, body }) {
  const res = await fetch(`${apiUrl}/repos/${repo}/issues/comments/${commentId}`, {
    method: 'PATCH',
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (res.status !== 200) return { error: `could not update the comment (HTTP ${res.status})` };
  const json = await readJson(res);
  return { url: json?.html_url ?? null };
}

/**
 * Keeps exactly one sticky comment per PR in sync with the check result.
 *   failing + no comment  -> create (mentions the author: one notification)
 *   failing + comment     -> update in place (no new notification)
 *   passing + comment     -> edit it into a resolved note
 *   passing + no comment  -> nothing
 * Fork PRs and missing tokens are skipped because the token cannot write.
 * Never throws: API problems come back as { action: 'error', note }.
 */
export async function syncStickyComment({ pr, failing, problems, runUrl, warnUntil = null, fetch, token, apiUrl = DEFAULT_API_URL }) {
  const repo = pr?.base?.repo?.full_name;
  const number = pr?.number;
  if (!repo || !number) {
    return { action: 'error', note: 'Comment skipped: the event payload has no base repository or PR number.' };
  }
  if (isForkPullRequest(pr)) {
    const head = pr?.head?.repo?.full_name ?? 'unknown';
    return {
      action: 'skipped-fork',
      note: `Comment skipped: head repository \`${head}\` is a fork, so the workflow token is read-only. The check result still applies.`,
    };
  }
  if (!token) {
    return { action: 'skipped-no-token', note: 'Comment skipped: no GITHUB_TOKEN available.' };
  }

  const io = { fetch, token, apiUrl, repo, number };
  let existing;
  try {
    existing = await findStickyComment(io);
  } catch (error) {
    return { action: 'error', note: `Comment skipped: ${error?.message ?? error}.` };
  }
  if (existing.error) return { action: 'error', note: `Comment skipped: ${existing.error}.` };

  const author = pr?.user?.login ?? null;
  const desired = failing ? buildFailingComment({ author, problems, runUrl, warnUntil }) : buildResolvedComment({ runUrl });

  try {
    if (!existing.comment) {
      if (!failing) return { action: 'none', note: null };
      const created = await createComment({ ...io, body: desired });
      if (created.error) return { action: 'error', note: `Comment skipped: ${created.error}.` };
      return {
        action: 'created',
        url: created.url,
        note: `Posted a comment mentioning @${author ?? 'the author'}${created.url ? ` (${created.url})` : ''}.`,
      };
    }

    if (normalizeBody(existing.comment.body) === normalizeBody(desired)) {
      return { action: 'unchanged', url: existing.comment.url, note: 'Existing comment is already up to date; nothing posted.' };
    }
    const updated = await updateComment({ ...io, commentId: existing.comment.id, body: desired });
    if (updated.error) return { action: 'error', note: `Comment skipped: ${updated.error}.` };
    const url = updated.url ?? existing.comment.url;
    return failing
      ? { action: 'updated', url, note: `Updated the existing comment in place (no new notification)${url ? ` (${url})` : ''}.` }
      : { action: 'resolved', url, note: `Edited the existing comment into a resolved note${url ? ` (${url})` : ''}.` };
  } catch (error) {
    return { action: 'error', note: `Comment skipped: ${error?.message ?? error}.` };
  }
}

export function buildSummary(result) {
  const lines = [`## ${SECTION_TITLE} gate — ${result.title}`, ''];
  if (result.pr) {
    lines.push(`PR: ${result.pr.repo}#${result.pr.number} by \`${result.pr.author}\``);
  }
  if (result.modeLine) lines.push(result.modeLine);
  lines.push('');
  for (const line of result.lines ?? []) lines.push(line);
  if (result.text) {
    lines.push('', '### Section text', `> ${result.text}`);
  }
  if (result.notes?.length) {
    lines.push('', '### Notes', ...result.notes.map((note) => `- ${note}`));
  }
  if (result.problems?.length) {
    lines.push('', '### Problems', ...result.problems.map((problem) => `- ${problem}`), '', howToFix());
  }
  return `${lines.join('\n')}\n`;
}

function buildRunUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return null;
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/**
 * Runs the whole gate for a pull_request event payload.
 * Before ENFORCE_AFTER a missing section yields status 'warn' (exit 0); from then on 'fail' (exit 1).
 * Returns { status: 'pass' | 'skip' | 'warn' | 'fail' | 'error', exitCode, summary, annotations, comment }.
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
      comment: null,
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
      comment: null,
    };
  }
  const modeLine = mode.enforcing
    ? `Mode: **blocking** (ENFORCE_AFTER=${mode.raw} has passed).`
    : `Mode: **warning only** until ${mode.raw}; from then on this check blocks the merge.`;

  const skip = decideSkip(pr);
  if (skip.skip) {
    const line = `Check skipped: ${skip.reason}.`;
    return {
      status: 'skip',
      exitCode: 0,
      annotations: [],
      summary: buildSummary({ title: 'skipped', pr: prInfo, modeLine, lines: [line] }),
      comment: null,
    };
  }

  const evaluation = evaluateBody(pr.body);
  const notes = [];
  const annotations = [];
  let comment = null;

  if (COMMENT_ACTIONS.has(event.action)) {
    comment = await syncStickyComment({
      pr,
      failing: !evaluation.ok,
      problems: evaluation.problems,
      runUrl: buildRunUrl(env),
      warnUntil: mode.enforcing ? null : mode.raw,
      fetch,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
    });
    if (comment.note) notes.push(comment.note);
    if (comment.action === 'error') {
      annotations.push({ level: 'warning', message: `Author alert could not be posted. ${comment.note}` });
    }
  } else {
    notes.push(`Comment sync skipped for event action "${event.action ?? 'unknown'}".`);
  }

  if (evaluation.ok) {
    return {
      status: 'pass',
      exitCode: 0,
      annotations,
      summary: buildSummary({
        title: 'passed',
        pr: prInfo,
        modeLine,
        lines: [`The "${SECTION_TITLE}" section is filled in.`],
        text: evaluation.text,
        notes,
      }),
      comment,
    };
  }

  const headline = `${SECTION_TITLE} check ${mode.enforcing ? 'failed' : 'would fail'}: ${evaluation.problems[0]}`;
  annotations.unshift({ level: mode.enforcing ? 'error' : 'warning', message: `${headline}\n${howToFix()}` });
  return {
    status: mode.enforcing ? 'fail' : 'warn',
    exitCode: mode.enforcing ? 1 : 0,
    annotations,
    summary: buildSummary({
      title: mode.enforcing ? 'failed' : 'warning (not blocking yet)',
      pr: prInfo,
      modeLine,
      lines: mode.enforcing ? [] : [`This PR would be blocked from ${mode.raw}. Fix it now to avoid surprises.`],
      notes,
      problems: evaluation.problems,
    }),
    comment,
  };
}
