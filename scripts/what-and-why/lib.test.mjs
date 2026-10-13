import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_ACTIONS,
  COMMENT_MARKER,
  DEFAULT_ENFORCE_AFTER,
  MIN_TEXT_LENGTH,
  buildFailingComment,
  buildResolvedComment,
  decideSkip,
  evaluateBody,
  extractMeaningfulText,
  findSection,
  findStickyComment,
  hasMarker,
  isBotAuthor,
  isForkPullRequest,
  resolveMode,
  runCheck,
  syncStickyComment,
} from './lib.mjs';

const TEMPLATE_COMMENT = '<!-- Required. What does this PR change, and why is it needed? Two or three sentences in plain language: the problem or goal, and what this change does about it. The check fails while this section is empty or still a placeholder. -->';
const GOOD_TEXT = 'Adds retry to the renewal job because Pagar.me times out at night and renewals were silently lost.';
const REPO = 'B4AGroup/some-backend';
const COMMENTS_URL = `https://api.github.com/repos/${REPO}/issues/42/comments`;

function body(section) {
  return `## What and Why\n${TEMPLATE_COMMENT}\n${section}\n\n## Linear ticket\nB4A-1\n\n## Brain context\n- none relevant: ci only change here\n`;
}

function makePr(overrides = {}) {
  return {
    number: 42,
    body: body(GOOD_TEXT),
    user: { login: 'dev-one', type: 'User' },
    labels: [],
    base: { repo: { full_name: REPO } },
    head: { repo: { full_name: REPO, fork: false } },
    ...overrides,
  };
}

function forkPr(overrides = {}) {
  return makePr({ head: { repo: { full_name: 'someone/some-backend', fork: true } }, ...overrides });
}

/**
 * Fake GitHub API. `existing` is the list of comments on the PR.
 * Records every call as { method, url, body }.
 */
function fakeApi({ existing = [], listStatus = 200, createStatus = 201, updateStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const payload = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body: payload });
    if (method === 'GET' && url.startsWith(COMMENTS_URL)) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const slice = page === 1 ? existing : [];
      return { status: listStatus, json: async () => slice };
    }
    if (method === 'POST' && url === COMMENTS_URL) {
      return { status: createStatus, json: async () => ({ id: 900, html_url: 'https://github.com/c/900' }) };
    }
    if (method === 'PATCH' && url.includes('/issues/comments/')) {
      return { status: updateStatus, json: async () => ({ id: 7, html_url: 'https://github.com/c/7' }) };
    }
    return { status: 500, json: async () => ({}) };
  };
  fetch.calls = calls;
  return fetch;
}

function stickyComment(bodyText) {
  return { id: 7, body: bodyText, html_url: 'https://github.com/c/7' };
}

const env = { GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '123', GITHUB_SERVER_URL: 'https://github.com' };
const RUN_URL = `https://github.com/${REPO}/actions/runs/123`;
// Warn mode (before 2026-10-19 00:00 UTC-3) and blocking mode (after it).
const BEFORE = new Date('2026-10-13T15:00:00Z');
const AFTER = new Date('2026-10-20T15:00:00Z');

describe('isBotAuthor', () => {
  test('should match dependabot and renovate logins with and without the [bot] suffix', () => {
    assert.equal(isBotAuthor('dependabot[bot]'), true);
    assert.equal(isBotAuthor('renovate[bot]'), true);
    assert.equal(isBotAuthor('dependabot-preview[bot]'), true);
    assert.equal(isBotAuthor('dependabot'), true);
    assert.equal(isBotAuthor('Renovate'), true);
  });
  test('should not match humans, other bots or empty values', () => {
    assert.equal(isBotAuthor('dev-one'), false);
    assert.equal(isBotAuthor('github-actions[bot]'), false);
    assert.equal(isBotAuthor(''), false);
    assert.equal(isBotAuthor(undefined), false);
    assert.equal(isBotAuthor(null), false);
  });
});

describe('findSection', () => {
  test('should find an h2 heading and stop at the next h2', () => {
    const section = findSection('## What and Why\nline a\nline b\n## Linear ticket\nx');
    assert.equal(section.found, true);
    assert.equal(section.heading, '## What and Why');
    assert.equal(section.content, 'line a\nline b');
  });
  test('should accept "What & Why", any casing and no space after the hashes', () => {
    assert.equal(findSection('###WHAT & WHY\nline\n### Other').content, 'line');
    assert.equal(findSection('## what and why\nline').content, 'line');
  });
  test('should keep deeper headings inside the section', () => {
    assert.equal(findSection('## What and Why\n#### sub\nline\n## Next').content, '#### sub\nline');
  });
  test('should not match h1 or h4 headings', () => {
    assert.equal(findSection('# What and Why\nx').found, false);
    assert.equal(findSection('#### What and Why\nx').found, false);
  });
  test('should not match a heading that merely starts with "what"', () => {
    assert.equal(findSection('## What changed\nx').found, false);
  });
  test('should handle CRLF line endings', () => {
    assert.equal(findSection('## What and Why\r\nline\r\n## Next\r\n').content, 'line');
  });
  test('should return not found for empty, null and undefined bodies', () => {
    assert.equal(findSection('').found, false);
    assert.equal(findSection(null).found, false);
    assert.equal(findSection(undefined).found, false);
  });
});

describe('extractMeaningfulText', () => {
  test('should drop HTML comments, list markers, emphasis and angle placeholders', () => {
    const text = extractMeaningfulText(`${TEMPLATE_COMMENT}\n- **Adds** retry <details here>\n1. because *timeouts*`);
    assert.equal(text, 'Adds retry because timeouts');
  });
  test('should return an empty string for comments and blank lines only', () => {
    assert.equal(extractMeaningfulText(`${TEMPLATE_COMMENT}\n\n- \n`), '');
  });
  test('should collapse whitespace across lines', () => {
    assert.equal(extractMeaningfulText('a   b\n\n   c'), 'a b c');
  });
  test('should handle null and undefined', () => {
    assert.equal(extractMeaningfulText(null), '');
    assert.equal(extractMeaningfulText(undefined), '');
  });
});

describe('evaluateBody', () => {
  test('should pass with real text', () => {
    const result = evaluateBody(body(GOOD_TEXT));
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.problems, []);
    assert.equal(result.text, GOOD_TEXT);
  });
  test('should pass with exactly the minimum length and fail one below it', () => {
    const exact = 'x'.repeat(MIN_TEXT_LENGTH);
    assert.equal(evaluateBody(body(exact)).ok, true);
    const short = evaluateBody(body('x'.repeat(MIN_TEXT_LENGTH - 1)));
    assert.equal(short.ok, false);
    assert.equal(short.kind, 'too-short');
    assert.deepEqual(short.problems, [
      `The "What and Why" section has ${MIN_TEXT_LENGTH - 1} characters of text; at least ${MIN_TEXT_LENGTH} are required.`,
    ]);
  });
  test('should fail when the heading is missing', () => {
    const result = evaluateBody('## Summary\nhello world, this is long enough');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'missing');
    assert.deepEqual(result.problems, ['The PR description has no "## What and Why" heading.']);
  });
  test('should fail on the untouched template (comment only)', () => {
    const result = evaluateBody(body(''));
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'empty');
    assert.deepEqual(result.problems, ['The "What and Why" section is empty (only the template comment or blank lines).']);
  });
  test('should fail when the section has only blank bullets', () => {
    assert.equal(evaluateBody(body('- \n- ')).kind, 'empty');
  });
  test('should fail on placeholder words', () => {
    for (const placeholder of ['TBD', 'todo', 'WIP', 'n/a', 'TODO: later', '...', '**TBD**']) {
      const result = evaluateBody(body(placeholder));
      assert.equal(result.ok, false, `expected "${placeholder}" to fail`);
      assert.equal(result.kind, 'placeholder', `expected "${placeholder}" to be a placeholder`);
    }
  });
  test('should fail on an angle-bracket placeholder only', () => {
    assert.equal(evaluateBody(body('<what and why>')).kind, 'empty');
  });
  test('should pass when real text sits next to a placeholder word', () => {
    assert.equal(evaluateBody(body('TODO list page now sorts by due date; QA asked for it')).ok, true);
  });
  test('should fail for an empty or null body', () => {
    assert.equal(evaluateBody('').ok, false);
    assert.equal(evaluateBody(null).ok, false);
    assert.equal(evaluateBody(undefined).ok, false);
  });
  test('should ignore text in other sections', () => {
    const result = evaluateBody(`## What and Why\n\n## Testing\n${GOOD_TEXT}`);
    assert.equal(result.kind, 'empty');
  });
});

describe('decideSkip', () => {
  test('should skip dependabot and renovate PRs', () => {
    assert.equal(decideSkip(makePr({ user: { login: 'dependabot[bot]' } })).kind, 'bot');
    assert.equal(decideSkip(makePr({ user: { login: 'renovate[bot]' } })).kind, 'bot');
  });
  test('should not skip a normal PR or a payload without a user', () => {
    assert.deepEqual(decideSkip(makePr()), { skip: false });
    assert.deepEqual(decideSkip({}), { skip: false });
  });
});

describe('isForkPullRequest', () => {
  test('should be true when head and base repositories differ', () => {
    assert.equal(isForkPullRequest(forkPr()), true);
  });
  test('should be false for the same repository regardless of casing', () => {
    assert.equal(isForkPullRequest(makePr({ head: { repo: { full_name: REPO.toUpperCase() } } })), false);
  });
  test('should fall back to the fork flag when names are missing', () => {
    assert.equal(isForkPullRequest({ head: { repo: { fork: true } } }), true);
    assert.equal(isForkPullRequest({}), false);
  });
});

describe('resolveMode', () => {
  test('should use the default enforce date when the value is empty, blank or undefined', () => {
    assert.equal(resolveMode(BEFORE, '').raw, DEFAULT_ENFORCE_AFTER);
    assert.equal(resolveMode(BEFORE, '   ').raw, DEFAULT_ENFORCE_AFTER);
    assert.equal(resolveMode(BEFORE, undefined).raw, DEFAULT_ENFORCE_AFTER);
    assert.equal(resolveMode(BEFORE, null).raw, DEFAULT_ENFORCE_AFTER);
  });
  test('should warn before the default date and enforce from it on', () => {
    assert.equal(resolveMode(BEFORE, undefined).enforcing, false);
    assert.equal(resolveMode(AFTER, undefined).enforcing, true);
  });
  test('should flip exactly at the boundary (2026-10-19T00:00 America/Sao_Paulo is 03:00Z)', () => {
    assert.equal(resolveMode(new Date('2026-10-19T02:59:59.999Z'), undefined).enforcing, false);
    assert.equal(resolveMode(new Date('2026-10-19T03:00:00Z'), undefined).enforcing, true);
  });
  test('should honour an ENFORCE_AFTER override', () => {
    assert.equal(resolveMode(AFTER, '2030-01-01T00:00:00Z').enforcing, false);
    assert.equal(resolveMode(BEFORE, '2020-01-01T00:00:00Z').enforcing, true);
    assert.equal(resolveMode(BEFORE, '2030-01-01T00:00:00Z').raw, '2030-01-01T00:00:00Z');
  });
  test('should accept a numeric or string timestamp for now', () => {
    assert.equal(resolveMode(AFTER.getTime(), undefined).enforcing, true);
    assert.equal(resolveMode(BEFORE.toISOString(), undefined).enforcing, false);
  });
  test('should report an error for an invalid date', () => {
    const result = resolveMode(BEFORE, 'next week');
    assert.equal(result.error, 'ENFORCE_AFTER is not a valid ISO-8601 date: "next week"');
    assert.equal(result.enforcing, undefined);
  });
});

describe('comment builders', () => {
  test('should start with the marker and mention the author in the failing comment', () => {
    const text = buildFailingComment({ author: 'dev-one', problems: ['p1'], runUrl: RUN_URL });
    assert.equal(text.startsWith(COMMENT_MARKER), true);
    assert.match(text, /@dev-one, this pull request needs/);
    assert.match(text, /- p1/);
    assert.match(text, new RegExp(`\\(${RUN_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)`));
  });
  test('should say "before it can be merged" and not mention a warn date in blocking mode', () => {
    const text = buildFailingComment({ author: 'dev-one', problems: ['p1'], runUrl: RUN_URL });
    assert.match(text, /before it can be merged/);
    assert.doesNotMatch(text, /Warning only until/);
    assert.doesNotMatch(text, /2026-10-19/);
  });
  test('should mention the warn-until date and the author in warn mode', () => {
    const text = buildFailingComment({ author: 'dev-one', problems: ['p1'], runUrl: RUN_URL, warnUntil: DEFAULT_ENFORCE_AFTER });
    assert.equal(text.startsWith(COMMENT_MARKER), true);
    assert.match(text, /@dev-one, this pull request needs a filled \*\*What and Why\*\* section/);
    assert.match(text, /\*\*Warning only until 2026-10-19T00:00:00-03:00\.\*\* This check does not block the merge yet/);
    assert.doesNotMatch(text, /before it can be merged/);
    assert.match(text, /- p1/);
  });
  test('should produce different text for warn and blocking mode so the comment is updated on the switch', () => {
    const args = { author: 'dev-one', problems: ['p1'], runUrl: RUN_URL };
    assert.notEqual(buildFailingComment({ ...args, warnUntil: DEFAULT_ENFORCE_AFTER }), buildFailingComment(args));
  });
  test('should not mention anyone when the author is unknown and still work without a run URL', () => {
    const text = buildFailingComment({ author: null, problems: [], runUrl: null });
    assert.doesNotMatch(text, /@/);
    assert.match(text, /This pull request needs/);
  });
  test('should build a resolved comment with the same marker and no mention', () => {
    const text = buildResolvedComment({ runUrl: RUN_URL });
    assert.equal(text.startsWith(COMMENT_MARKER), true);
    assert.match(text, /resolved/);
    assert.doesNotMatch(text, /@/);
  });
  test('hasMarker should only accept strings containing the marker', () => {
    assert.equal(hasMarker(`${COMMENT_MARKER}\nx`), true);
    assert.equal(hasMarker('hello'), false);
    assert.equal(hasMarker(null), false);
  });
});

describe('findStickyComment', () => {
  const io = { token: 't', repo: REPO, number: 42 };
  test('should return the first comment carrying the marker', async () => {
    const fetch = fakeApi({ existing: [{ id: 1, body: 'hi' }, stickyComment(`${COMMENT_MARKER}\nold`)] });
    const result = await findStickyComment({ ...io, fetch });
    assert.deepEqual(result, { comment: { id: 7, body: `${COMMENT_MARKER}\nold`, url: 'https://github.com/c/7' } });
  });
  test('should return null when no comment has the marker', async () => {
    const fetch = fakeApi({ existing: [{ id: 1, body: 'hi' }] });
    assert.deepEqual(await findStickyComment({ ...io, fetch }), { comment: null });
    assert.equal(fetch.calls.length, 1);
  });
  test('should report an error on a non-200 listing', async () => {
    const fetch = fakeApi({ listStatus: 403 });
    const result = await findStickyComment({ ...io, fetch });
    assert.equal(result.comment, null);
    assert.equal(result.error, 'could not list comments (HTTP 403)');
  });
  test('should request the next page when a page is full', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' }));
    const fetch = fakeApi({ existing: full });
    await findStickyComment({ ...io, fetch });
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1].url, /page=2/);
  });
});

describe('syncStickyComment', () => {
  const base = { runUrl: RUN_URL, token: 't', problems: ['The PR description has no "## What and Why" heading.'] };

  test('should create a mentioning comment when failing and none exists', async () => {
    const fetch = fakeApi();
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'created');
    assert.equal(result.url, 'https://github.com/c/900');
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.match(post.body.body, /@dev-one/);
    assert.equal(post.body.body.startsWith(COMMENT_MARKER), true);
  });
  test('should update in place when failing and a comment exists (no new comment)', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nstale text`)] });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'updated');
    assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 0);
    const patch = fetch.calls.find((call) => call.method === 'PATCH');
    assert.match(patch.url, /\/issues\/comments\/7$/);
    assert.match(patch.body.body, /@dev-one/);
  });
  test('should not write when the existing comment already has the desired text', async () => {
    const desired = buildFailingComment({ author: 'dev-one', problems: base.problems, runUrl: RUN_URL });
    const fetch = fakeApi({ existing: [stickyComment(desired.replace(/\n/g, '\r\n'))] });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'unchanged');
    assert.equal(fetch.calls.length, 1);
  });
  test('should post the warn-mode text when warnUntil is given', async () => {
    const fetch = fakeApi();
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, warnUntil: DEFAULT_ENFORCE_AFTER, fetch });
    assert.equal(result.action, 'created');
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.match(post.body.body, /@dev-one/);
    assert.match(post.body.body, /Warning only until 2026-10-19T00:00:00-03:00/);
  });
  test('should update the warn-mode comment in place when the mode switches to blocking', async () => {
    const warnText = buildFailingComment({ author: 'dev-one', problems: base.problems, runUrl: RUN_URL, warnUntil: DEFAULT_ENFORCE_AFTER });
    const fetch = fakeApi({ existing: [stickyComment(warnText)] });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'updated');
    const patch = fetch.calls.find((call) => call.method === 'PATCH');
    assert.doesNotMatch(patch.body.body, /Warning only until/);
    assert.match(patch.body.body, /before it can be merged/);
  });
  test('should edit the comment into a resolved note when passing', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nfailing text`)] });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: false, fetch });
    assert.equal(result.action, 'resolved');
    const patch = fetch.calls.find((call) => call.method === 'PATCH');
    assert.match(patch.body.body, /resolved/);
    assert.doesNotMatch(patch.body.body, /@dev-one/);
  });
  test('should do nothing when passing and no comment exists', async () => {
    const fetch = fakeApi();
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: false, fetch });
    assert.equal(result.action, 'none');
    assert.equal(fetch.calls.length, 1);
  });
  test('should skip fork PRs without calling the API', async () => {
    const fetch = fakeApi();
    const result = await syncStickyComment({ ...base, pr: forkPr(), failing: true, fetch });
    assert.equal(result.action, 'skipped-fork');
    assert.match(result.note, /someone\/some-backend/);
    assert.equal(fetch.calls.length, 0);
  });
  test('should skip when there is no token', async () => {
    const fetch = fakeApi();
    const result = await syncStickyComment({ ...base, token: '', pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'skipped-no-token');
    assert.equal(fetch.calls.length, 0);
  });
  test('should report an error when the comment cannot be created (HTTP 403)', async () => {
    const fetch = fakeApi({ createStatus: 403 });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'error');
    assert.match(result.note, /HTTP 403/);
  });
  test('should report an error when the comment cannot be updated', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nold`)], updateStatus: 500 });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'error');
    assert.match(result.note, /could not update the comment \(HTTP 500\)/);
  });
  test('should report an error when the listing fails', async () => {
    const fetch = fakeApi({ listStatus: 404 });
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch });
    assert.equal(result.action, 'error');
    assert.match(result.note, /could not list comments \(HTTP 404\)/);
  });
  test('should not throw when fetch throws', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    const result = await syncStickyComment({ ...base, pr: makePr(), failing: true, fetch: boom });
    assert.equal(result.action, 'error');
    assert.match(result.note, /ECONNRESET/);
  });
  test('should report an error when the payload has no repo or number', async () => {
    const result = await syncStickyComment({ ...base, pr: { number: 1 }, failing: true, fetch: fakeApi() });
    assert.equal(result.action, 'error');
  });
});

describe('runCheck — blocking mode (from 2026-10-19 00:00 UTC-3)', () => {
  const run = (event, options = {}) => runCheck({ event, env, now: AFTER, fetch: fakeApi(), ...options });

  test('should pass with exit 0 and no comment when the section is filled on a fresh PR', async () => {
    const fetch = fakeApi();
    const result = await run({ action: 'opened', pull_request: makePr() }, { fetch });
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.annotations, []);
    assert.equal(result.comment.action, 'none');
    assert.match(result.summary, /passed/);
    assert.match(result.summary, /Mode: \*\*blocking\*\*/);
    assert.match(result.summary, /### Section text/);
  });

  test('should fail with exit 1 and post a mentioning comment when the section is empty on opened', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].level, 'error');
    assert.match(result.annotations[0].message, /^What and Why check failed: /);
    assert.equal(result.comment.action, 'created');
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.match(post.body.body, /before it can be merged/);
    assert.doesNotMatch(post.body.body, /Warning only until/);
    assert.match(result.summary, /Posted a comment mentioning @dev-one/);
    assert.match(result.summary, /### Problems/);
    assert.doesNotMatch(result.summary, /would be blocked/);
  });

  test('should fail with exit 1 when the section is missing (no heading)', async () => {
    const result = await run({ action: 'opened', pull_request: makePr({ body: '## Summary\nlong enough text here' }) });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /no "## What and Why" heading/);
  });

  test('should fail exactly at the switch instant (2026-10-19T03:00:00Z)', async () => {
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { now: new Date('2026-10-19T03:00:00Z') });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
  });

  test('should block before the default date when ENFORCE_AFTER is overridden to the past', async () => {
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { now: BEFORE, env: { ...env, ENFORCE_AFTER: '2020-01-01T00:00:00Z' } });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /ENFORCE_AFTER=2020-01-01T00:00:00Z has passed/);
  });

  test('should update the existing comment instead of posting again on synchronize', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nold`)] });
    const pr = makePr({ body: body('TBD') });
    const result = await run({ action: 'synchronize', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.comment.action, 'updated');
    assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 0);
  });

  test('should resolve the comment when the section gets filled on edited', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nold`)] });
    const result = await run({ action: 'edited', pull_request: makePr() }, { fetch });
    assert.equal(result.status, 'pass');
    assert.equal(result.comment.action, 'resolved');
    assert.match(result.summary, /Edited the existing comment into a resolved note/);
  });

  test('should sync the comment on ready_for_review', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'ready_for_review', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.comment.action, 'created');
    assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 1);
  });

  test('should still fail on a fork PR but skip the comment', async () => {
    const fetch = fakeApi();
    const pr = forkPr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.equal(result.comment.action, 'skipped-fork');
    assert.equal(fetch.calls.length, 0);
    assert.match(result.summary, /Comment skipped: head repository/);
  });

  test('should keep failing and add a warning annotation when the comment API denies writes', async () => {
    const fetch = fakeApi({ createStatus: 403 });
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.equal(result.annotations.length, 2);
    assert.equal(result.annotations[0].level, 'error');
    assert.equal(result.annotations[1].level, 'warning');
    assert.match(result.annotations[1].message, /Author alert could not be posted/);
  });

  test('should skip bots with exit 0 and never touch the API', async () => {
    const fetch = fakeApi();
    for (const login of ['dependabot[bot]', 'renovate[bot]']) {
      const pr = makePr({ body: '', user: { login } });
      const result = await run({ action: 'opened', pull_request: pr }, { fetch });
      assert.equal(result.status, 'skip');
      assert.equal(result.exitCode, 0);
      assert.equal(result.comment, null);
      assert.match(result.summary, /dependency bot/);
    }
    assert.equal(fetch.calls.length, 0);
  });

  test('should treat a null body as a missing section', async () => {
    const result = await run({ action: 'opened', pull_request: makePr({ body: null }) });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no "## What and Why" heading/);
  });

  test('should not sync the comment for actions outside the comment list', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'labeled', pull_request: pr }, { fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.comment, null);
    assert.equal(fetch.calls.length, 0);
    assert.match(result.summary, /Comment sync skipped for event action "labeled"/);
  });

  test('should include the run URL in the posted comment when the env provides it', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    await run({ action: 'opened', pull_request: pr }, { fetch });
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.match(post.body.body, new RegExp(RUN_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  });

  test('should error with exit 1 when the event has no pull_request', async () => {
    const result = await run({ push: {} });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(result.annotations[0].level, 'error');
  });

  test('should error with exit 1 on an invalid ENFORCE_AFTER and not touch the API', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch, env: { ...env, ENFORCE_AFTER: 'soon' } });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(result.comment, null);
    assert.equal(fetch.calls.length, 0);
    assert.match(result.annotations[0].message, /ENFORCE_AFTER is not a valid ISO-8601 date: "soon"/);
  });
});

describe('runCheck — warn mode (before 2026-10-19 00:00 UTC-3)', () => {
  const run = (event, options = {}) => runCheck({ event, env, now: BEFORE, fetch: fakeApi(), ...options });

  test('should pass with exit 0 when the section is filled and state the warn-only mode', async () => {
    const result = await run({ action: 'opened', pull_request: makePr() });
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.annotations, []);
    assert.equal(result.summary.includes(`Mode: **warning only** until ${DEFAULT_ENFORCE_AFTER}; from then on this check blocks the merge.`), true);
  });

  test('should warn with exit 0 and still post the mentioning comment when the section is empty on opened', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].level, 'warning');
    assert.match(result.annotations[0].message, /^What and Why check would fail: The "What and Why" section is empty/);
    assert.equal(result.comment.action, 'created');
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.equal(post.body.body.startsWith(COMMENT_MARKER), true);
    assert.match(post.body.body, /@dev-one/);
    assert.match(post.body.body, /Warning only until 2026-10-19T00:00:00-03:00/);
    assert.match(result.summary, /warning \(not blocking yet\)/);
    assert.match(result.summary, /This PR would be blocked from 2026-10-19T00:00:00-03:00/);
    assert.match(result.summary, /### Problems/);
  });

  test('should warn with exit 0 when the section is missing (no heading)', async () => {
    const fetch = fakeApi();
    const result = await run({ action: 'opened', pull_request: makePr({ body: '## Summary\nlong enough text here' }) }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.comment.action, 'created');
    assert.match(result.summary, /no "## What and Why" heading/);
  });

  test('should warn with exit 0 for a null body, placeholders and too-short text', async () => {
    for (const prBody of [null, body('TBD'), body('x'.repeat(MIN_TEXT_LENGTH - 1))]) {
      const result = await run({ action: 'opened', pull_request: makePr({ body: prBody }) });
      assert.equal(result.status, 'warn', `expected warn for body ${JSON.stringify(prBody)}`);
      assert.equal(result.exitCode, 0);
    }
  });

  test('should still warn one millisecond before the switch instant', async () => {
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { now: new Date('2026-10-19T02:59:59.999Z') });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
  });

  test('should warn after the default date when ENFORCE_AFTER is overridden to the future', async () => {
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'synchronize', pull_request: pr }, { now: AFTER, env: { ...env, ENFORCE_AFTER: '2999-01-01T00:00:00Z' } });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /until 2999-01-01T00:00:00Z/);
  });

  test('should put the overridden ENFORCE_AFTER into the comment text', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    await run({ action: 'opened', pull_request: pr }, { fetch, env: { ...env, ENFORCE_AFTER: '2999-01-01T00:00:00Z' } });
    const post = fetch.calls.find((call) => call.method === 'POST');
    assert.match(post.body.body, /Warning only until 2999-01-01T00:00:00Z/);
  });

  test('should update the existing comment in place on synchronize while warning', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nold`)] });
    const pr = makePr({ body: body('TBD') });
    const result = await run({ action: 'synchronize', pull_request: pr }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.comment.action, 'updated');
    assert.equal(fetch.calls.filter((call) => call.method === 'POST').length, 0);
    const patch = fetch.calls.find((call) => call.method === 'PATCH');
    assert.match(patch.body.body, /Warning only until 2026-10-19T00:00:00-03:00/);
  });

  test('should resolve the comment when the section gets filled while warning', async () => {
    const fetch = fakeApi({ existing: [stickyComment(`${COMMENT_MARKER}\nold`)] });
    const result = await run({ action: 'edited', pull_request: makePr() }, { fetch });
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.equal(result.comment.action, 'resolved');
  });

  test('should sync the comment on ready_for_review while warning', async () => {
    const fetch = fakeApi();
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'ready_for_review', pull_request: pr }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.comment.action, 'created');
  });

  test('should warn on a fork PR with exit 0 and skip the comment', async () => {
    const fetch = fakeApi();
    const pr = forkPr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.comment.action, 'skipped-fork');
    assert.equal(fetch.calls.length, 0);
  });

  test('should keep exit 0 and add a second warning annotation when the comment API denies writes', async () => {
    const fetch = fakeApi({ createStatus: 403 });
    const pr = makePr({ body: body('') });
    const result = await run({ action: 'opened', pull_request: pr }, { fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.annotations.length, 2);
    assert.equal(result.annotations[0].level, 'warning');
    assert.match(result.annotations[0].message, /would fail/);
    assert.equal(result.annotations[1].level, 'warning');
    assert.match(result.annotations[1].message, /Author alert could not be posted/);
  });

  test('should skip bots with exit 0 and never touch the API', async () => {
    const fetch = fakeApi();
    const result = await run({ action: 'opened', pull_request: makePr({ body: '', user: { login: 'dependabot[bot]' } }) }, { fetch });
    assert.equal(result.status, 'skip');
    assert.equal(result.exitCode, 0);
    assert.equal(fetch.calls.length, 0);
  });

  test('should still error with exit 1 on an invalid ENFORCE_AFTER before the date', async () => {
    const result = await run({ action: 'opened', pull_request: makePr() }, { env: { ...env, ENFORCE_AFTER: 'soon' } });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
  });
});

describe('COMMENT_ACTIONS', () => {
  test('should include every pull_request type the workflow triggers on', () => {
    assert.deepEqual([...COMMENT_ACTIONS].sort(), ['edited', 'opened', 'ready_for_review', 'reopened', 'synchronize']);
  });
});
