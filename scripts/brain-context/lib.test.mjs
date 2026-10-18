import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_REPO_URL,
  DEFAULT_ENFORCE_AFTER,
  EXEMPT_LABEL,
  checkLinkExists,
  decideSkip,
  evaluateBody,
  extractBrainLinks,
  findBrainContextSection,
  findNoneRelevant,
  isBotAuthor,
  probeBrainAccess,
  resolveMode,
  runCheck,
  verifyLinks,
  verifySearchLog,
} from './lib.mjs';

const PAGE = `${BRAIN_REPO_URL}/blob/master/shared/org-conventions.md`;
const FOLDER = `${BRAIN_REPO_URL}/tree/master/B4A%20Connect/Connect`;
const TEMPLATE_COMMENT = "<!-- Pages from B4AGroup/b4a-brain you checked before coding (search with brain.search in the B4A MCP connector). One per line as links, or 'none relevant: <reason>'. -->";

const BEFORE = new Date('2026-10-15T12:00:00Z');
const AFTER = new Date('2026-10-20T12:00:00Z');

function body(section) {
  return `## Summary\nThings.\n\n## Brain context\n${TEMPLATE_COMMENT}\n${section}\n\n## Testing\nnode --test\n`;
}

function makePr(overrides = {}) {
  return {
    number: 42,
    body: body(`- ${PAGE}`),
    created_at: '2026-10-10T10:00:00Z',
    user: { login: 'dev-one', type: 'User' },
    labels: [],
    base: { repo: { full_name: 'B4AGroup/some-backend' } },
    ...overrides,
  };
}

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    for (const [pattern, status] of routes) {
      if (url.includes(pattern)) return { status };
    }
    return { status: 500 };
  };
  fetch.calls = calls;
  return fetch;
}

describe('isBotAuthor', () => {
  test('should match dependabot and renovate logins when they carry the [bot] suffix', () => {
    assert.equal(isBotAuthor('dependabot[bot]'), true);
    assert.equal(isBotAuthor('renovate[bot]'), true);
    assert.equal(isBotAuthor('dependabot-preview[bot]'), true);
  });
  test('should match plain dependabot and renovate logins', () => {
    assert.equal(isBotAuthor('dependabot'), true);
    assert.equal(isBotAuthor('Renovate'), true);
  });
  test('should not match humans or other bots', () => {
    assert.equal(isBotAuthor('dev-one'), false);
    assert.equal(isBotAuthor('github-actions[bot]'), false);
    assert.equal(isBotAuthor(''), false);
    assert.equal(isBotAuthor(undefined), false);
    assert.equal(isBotAuthor(null), false);
  });
});

describe('findBrainContextSection', () => {
  test('should find an h2 heading and stop at the next h2', () => {
    const section = findBrainContextSection('## Brain context\n- a\n- b\n## Testing\nx');
    assert.equal(section.found, true);
    assert.equal(section.heading, '## Brain context');
    assert.equal(section.content, '- a\n- b');
  });
  test('should find an h3 heading case-insensitively and without a space after the hashes', () => {
    const section = findBrainContextSection('###BRAIN CONTEXT\nline\n### Other');
    assert.equal(section.found, true);
    assert.equal(section.content, 'line');
  });
  test('should keep deeper headings inside the section', () => {
    const section = findBrainContextSection('## Brain context\n#### sub\nline\n## Next');
    assert.equal(section.content, '#### sub\nline');
  });
  test('should not match h1 or h4 headings', () => {
    assert.equal(findBrainContextSection('# Brain context\nx').found, false);
    assert.equal(findBrainContextSection('#### Brain context\nx').found, false);
  });
  test('should handle CRLF line endings', () => {
    const section = findBrainContextSection('## Brain context\r\n- a\r\n## Next\r\n');
    assert.equal(section.content, '- a');
  });
  test('should return not found for empty, null and undefined bodies', () => {
    assert.equal(findBrainContextSection('').found, false);
    assert.equal(findBrainContextSection(null).found, false);
    assert.equal(findBrainContextSection(undefined).found, false);
  });
});

describe('extractBrainLinks', () => {
  test('should extract bare and markdown blob links with ref and decoded path', () => {
    const links = extractBrainLinks(`- ${PAGE}\n- [Connect](${FOLDER})`);
    assert.equal(links.length, 2);
    assert.deepEqual(links[0], { url: PAGE, valid: true, kind: 'blob', ref: 'master', path: 'shared/org-conventions.md' });
    assert.deepEqual(links[1], { url: FOLDER, valid: true, kind: 'tree', ref: 'master', path: 'B4A Connect/Connect' });
  });
  test('should strip fragments, trailing punctuation and deduplicate', () => {
    const links = extractBrainLinks(`${PAGE}#heading, and again ${PAGE}#heading.`);
    assert.equal(links.length, 1);
    assert.equal(links[0].path, 'shared/org-conventions.md');
  });
  test('should flag repo-root and non-page links as not counting', () => {
    const links = extractBrainLinks(`${BRAIN_REPO_URL}\n${BRAIN_REPO_URL}/tree/master\n${BRAIN_REPO_URL}/pull/5`);
    assert.equal(links.length, 3);
    assert.equal(links.every((link) => link.valid === false), true);
    assert.equal(links[1].problem, 'points at the repository root, not a page');
  });
  test('should ignore links inside HTML comments and links to other repos', () => {
    const links = extractBrainLinks(`<!-- ${PAGE} -->\nhttps://github.com/B4AGroup/other/blob/main/x.md`);
    assert.deepEqual(links, []);
  });
  test('should accept the org and repo names in any casing', () => {
    const links = extractBrainLinks('https://GITHUB.com/b4agroup/B4A-Brain/blob/main/README.md');
    assert.equal(links.length, 1);
    assert.equal(links[0].valid, true);
  });
});

describe('findNoneRelevant', () => {
  test('should accept a reason of at least 15 characters', () => {
    const result = findNoneRelevant('- none relevant: pure dependency bump, no product logic');
    assert.deepEqual(result, { present: true, reason: 'pure dependency bump, no product logic', valid: true });
  });
  test('should accept exactly 15 characters and reject 14', () => {
    assert.equal(findNoneRelevant('none relevant: 123456789012345').valid, true);
    const short = findNoneRelevant('none relevant: 12345678901234');
    assert.equal(short.valid, false);
    assert.equal(short.problem, 'the reason has 14 characters; at least 15 are required');
  });
  test('should reject the placeholder and an empty reason', () => {
    assert.equal(findNoneRelevant('none relevant: <reason>').valid, false);
    assert.equal(findNoneRelevant('none relevant:').valid, false);
    assert.equal(findNoneRelevant('none relevant:    ').valid, false);
  });
  test('should ignore the template comment', () => {
    assert.equal(findNoneRelevant(TEMPLATE_COMMENT).present, false);
  });
  test('should accept bold or case variations', () => {
    assert.equal(findNoneRelevant('**None relevant**: typo fix in a README file only').valid, true);
  });
});

describe('evaluateBody', () => {
  test('should pass with one valid page link', () => {
    const result = evaluateBody(body(`- ${PAGE}`));
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  });
  test('should pass with a valid none relevant reason', () => {
    const result = evaluateBody(body('- none relevant: pure CI tweak, no product behaviour touched'));
    assert.equal(result.ok, true);
  });
  test('should fail when the heading is missing', () => {
    const result = evaluateBody('## Summary\nhello');
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ['The PR description has no "## Brain context" heading.']);
  });
  test('should fail on the untouched template', () => {
    const result = evaluateBody(body('- '));
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      'The "Brain context" section has no b4a-brain page link and no "none relevant: <reason>" line.',
    ]);
  });
  test('should fail with a short reason and explain why', () => {
    const result = evaluateBody(body('none relevant: n/a'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      '"none relevant" line found but the reason has 3 characters; at least 15 are required.',
    ]);
  });
  test('should fail when the only link is the repository root', () => {
    const result = evaluateBody(body(`- ${BRAIN_REPO_URL}`));
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, [
      `Link ${BRAIN_REPO_URL} does not count: not a /blob/ or /tree/ page link.`,
    ]);
  });
  test('should pass when a valid link sits next to an invalid one', () => {
    const result = evaluateBody(body(`- ${BRAIN_REPO_URL}\n- ${PAGE}`));
    assert.equal(result.ok, true);
  });
  test('should fail for an empty or null body', () => {
    assert.equal(evaluateBody('').ok, false);
    assert.equal(evaluateBody(null).ok, false);
  });
});

describe('decideSkip', () => {
  test('should skip dependabot PRs', () => {
    const result = decideSkip(makePr({ user: { login: 'dependabot[bot]' } }));
    assert.equal(result.skip, true);
    assert.equal(result.kind, 'bot');
  });
  test('should skip PRs into b4a-brain regardless of casing', () => {
    const result = decideSkip(makePr({ base: { repo: { full_name: 'b4agroup/B4A-BRAIN' } } }));
    assert.equal(result.skip, true);
    assert.equal(result.kind, 'brain-repo');
  });
  test('should skip PRs carrying the exempt label', () => {
    const result = decideSkip(makePr({ labels: [{ name: 'bug' }, { name: EXEMPT_LABEL.toUpperCase() }] }));
    assert.equal(result.skip, true);
    assert.equal(result.kind, 'exempt-label');
  });
  test('should not skip a normal PR', () => {
    assert.deepEqual(decideSkip(makePr()), { skip: false });
  });
  test('should not skip when the payload has no user, labels or base', () => {
    assert.deepEqual(decideSkip({}), { skip: false });
  });
});

describe('resolveMode', () => {
  test('should use the default enforce date when the value is empty or undefined', () => {
    assert.equal(resolveMode(BEFORE, '').raw, DEFAULT_ENFORCE_AFTER);
    assert.equal(resolveMode(BEFORE, undefined).raw, DEFAULT_ENFORCE_AFTER);
  });
  test('should warn before the date and enforce from it on', () => {
    assert.equal(resolveMode(BEFORE, DEFAULT_ENFORCE_AFTER).enforcing, false);
    assert.equal(resolveMode(AFTER, DEFAULT_ENFORCE_AFTER).enforcing, true);
  });
  test('should flip exactly at the boundary (2026-10-19T00:00 in UTC-3 is 03:00Z)', () => {
    assert.equal(resolveMode(new Date('2026-10-19T02:59:59Z'), DEFAULT_ENFORCE_AFTER).enforcing, false);
    assert.equal(resolveMode(new Date('2026-10-19T03:00:00Z'), DEFAULT_ENFORCE_AFTER).enforcing, true);
  });
  test('should report an error for an invalid date', () => {
    const result = resolveMode(BEFORE, 'next week');
    assert.equal(result.error, 'ENFORCE_AFTER is not a valid ISO-8601 date: "next week"');
  });
});

describe('probeBrainAccess and checkLinkExists', () => {
  test('should report access when the repo endpoint answers 200', async () => {
    const fetch = fakeFetch([['/repos/B4AGroup/b4a-brain', 200]]);
    assert.deepEqual(await probeBrainAccess({ fetch, token: 't' }), { access: 'ok' });
  });
  test('should report denied on 401, 403 and 404', async () => {
    for (const status of [401, 403, 404]) {
      const fetch = fakeFetch([['/repos/B4AGroup/b4a-brain', status]]);
      assert.deepEqual(await probeBrainAccess({ fetch }), { access: 'denied', status });
    }
  });
  test('should report error on a 5xx or a thrown fetch', async () => {
    assert.equal((await probeBrainAccess({ fetch: fakeFetch([]) })).access, 'error');
    const boom = async () => { throw new Error('ECONNRESET'); };
    assert.deepEqual(await probeBrainAccess({ fetch: boom }), { access: 'error', message: 'ECONNRESET' });
  });
  test('should encode the contents path per segment and pass the ref', async () => {
    const fetch = fakeFetch([['/contents/', 200]]);
    const link = { url: FOLDER, valid: true, kind: 'tree', ref: 'feature-x', path: 'B4A Connect/Connect' };
    const result = await checkLinkExists(link, { fetch, token: 't' });
    assert.equal(result.exists, true);
    assert.equal(fetch.calls[0], 'https://api.github.com/repos/B4AGroup/b4a-brain/contents/B4A%20Connect/Connect?ref=feature-x');
  });
  test('should mark 404 as missing and other statuses as unverifiable', async () => {
    const link = { url: PAGE, valid: true, kind: 'blob', ref: 'master', path: 'x.md' };
    const missing = await checkLinkExists(link, { fetch: fakeFetch([['/contents/', 404]]) });
    assert.equal(missing.exists, false);
    const unknown = await checkLinkExists(link, { fetch: fakeFetch([['/contents/', 502]]) });
    assert.equal(unknown.exists, null);
    assert.equal(unknown.problem, 'could not verify (HTTP 502)');
  });
});

describe('verifyLinks', () => {
  const links = [{ url: PAGE, valid: true, kind: 'blob', ref: 'master', path: 'shared/org-conventions.md' }];
  test('should fall back to format-only when the token cannot read the brain repo', async () => {
    const fetch = fakeFetch([['/repos/B4AGroup/b4a-brain', 404]]);
    const result = await verifyLinks(links, { fetch, token: 't' });
    assert.equal(result.mode, 'format-only');
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /cannot read B4AGroup\/b4a-brain \(HTTP 404\)/);
    assert.equal(fetch.calls.length, 1);
  });
  test('should resolve every valid link when access is granted', async () => {
    const fetch = fakeFetch([['/contents/', 200], ['/repos/B4AGroup/b4a-brain', 200]]);
    const result = await verifyLinks(links, { fetch, token: 't' });
    assert.equal(result.mode, 'resolved');
    assert.equal(result.links[0].exists, true);
  });
  test('should not call the network when there are no valid links', async () => {
    const fetch = fakeFetch([]);
    const result = await verifyLinks([{ url: BRAIN_REPO_URL, valid: false, problem: 'x' }], { fetch });
    assert.equal(result.mode, 'none');
    assert.equal(fetch.calls.length, 0);
  });
});

describe('verifySearchLog (Phase B hook)', () => {
  test('should do nothing when disabled', async () => {
    assert.deepEqual(await verifySearchLog({ enabled: false }), { checked: false, note: null });
  });
  test('should note the missing endpoint when enabled without one', async () => {
    const result = await verifySearchLog({ enabled: true, endpoint: '' });
    assert.equal(result.checked, false);
    assert.match(result.note, /SEARCH_LOG_ENDPOINT is not set/);
  });
  test('should note it is not implemented when enabled with an endpoint', async () => {
    const result = await verifySearchLog({ enabled: true, endpoint: 'https://example.invalid', author: 'a', windowStart: 's', windowEnd: 'e' });
    assert.equal(result.checked, false);
    assert.match(result.note, /not implemented yet/);
  });
});

describe('runCheck', () => {
  const denied = () => fakeFetch([['/repos/B4AGroup/b4a-brain', 404]]);

  test('should pass with a page link and note format-only validation when access is denied', async () => {
    const result = await runCheck({ event: { pull_request: makePr() }, env: {}, now: BEFORE, fetch: denied() });
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.annotations, []);
    assert.match(result.summary, /Link existence checks skipped/);
    assert.match(result.summary, /format ok/);
  });

  test('should pass and show resolved links when access is granted', async () => {
    const fetch = fakeFetch([['/contents/', 200], ['/repos/B4AGroup/b4a-brain', 200]]);
    const result = await runCheck({ event: { pull_request: makePr() }, env: { GITHUB_TOKEN: 't' }, now: AFTER, fetch });
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /— resolves/);
    assert.match(result.summary, /Mode: \*\*blocking\*\*/);
  });

  test('should warn with exit 0 before ENFORCE_AFTER when the section is empty', async () => {
    const pr = makePr({ body: body('- ') });
    const result = await runCheck({ event: { pull_request: pr }, env: {}, now: BEFORE, fetch: denied() });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].level, 'warning');
    assert.match(result.annotations[0].message, /^Brain context check would fail: /);
    assert.match(result.annotations[0].message, /How to fix/);
    assert.match(result.summary, /warning \(not blocking yet\)/);
  });

  test('should fail with exit 1 after ENFORCE_AFTER when the section is empty', async () => {
    const pr = makePr({ body: body('- ') });
    const result = await runCheck({ event: { pull_request: pr }, env: {}, now: AFTER, fetch: denied() });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.equal(result.annotations[0].level, 'error');
    assert.match(result.annotations[0].message, /^Brain context check failed: /);
    assert.match(result.summary, /brain-context-exempt/);
  });

  test('should honour a custom ENFORCE_AFTER from the environment', async () => {
    const pr = makePr({ body: body('- ') });
    const env = { ENFORCE_AFTER: '2030-01-01T00:00:00Z' };
    const result = await runCheck({ event: { pull_request: pr }, env, now: AFTER, fetch: denied() });
    assert.equal(result.status, 'warn');
    assert.match(result.summary, /until 2030-01-01T00:00:00Z/);
  });

  test('should fail after ENFORCE_AFTER when a link is confirmed missing', async () => {
    const fetch = fakeFetch([['/contents/', 404], ['/repos/B4AGroup/b4a-brain', 200]]);
    const result = await runCheck({ event: { pull_request: makePr() }, env: { GITHUB_TOKEN: 't' }, now: AFTER, fetch });
    assert.equal(result.status, 'fail');
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /does not resolve/);
  });

  test('should only warn before ENFORCE_AFTER when a link is confirmed missing', async () => {
    const fetch = fakeFetch([['/contents/', 404], ['/repos/B4AGroup/b4a-brain', 200]]);
    const result = await runCheck({ event: { pull_request: makePr() }, env: { GITHUB_TOKEN: 't' }, now: BEFORE, fetch });
    assert.equal(result.status, 'warn');
    assert.equal(result.exitCode, 0);
  });

  test('should pass without touching the network when a link cannot be verified (5xx)', async () => {
    const fetch = fakeFetch([['/contents/', 503], ['/repos/B4AGroup/b4a-brain', 200]]);
    const result = await runCheck({ event: { pull_request: makePr() }, env: { GITHUB_TOKEN: 't' }, now: AFTER, fetch });
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /could not verify \(HTTP 503\)/);
  });

  test('should pass with a none relevant reason and show it in the summary', async () => {
    const pr = makePr({ body: body('none relevant: only bumps the CI runner image version') });
    const fetch = fakeFetch([]);
    const result = await runCheck({ event: { pull_request: pr }, env: {}, now: AFTER, fetch });
    assert.equal(result.status, 'pass');
    assert.equal(fetch.calls.length, 0);
    assert.match(result.summary, /Reason given: only bumps the CI runner image version/);
  });

  test('should skip bots, the brain repo and the exempt label even after ENFORCE_AFTER', async () => {
    const cases = [
      [makePr({ body: '', user: { login: 'renovate[bot]' } }), /dependency bot/],
      [makePr({ body: '', base: { repo: { full_name: 'B4AGroup/b4a-brain' } } }), /targets B4AGroup\/b4a-brain itself/],
      [makePr({ body: '', labels: [{ name: EXEMPT_LABEL }] }), /Lead override/],
    ];
    for (const [pr, expected] of cases) {
      const result = await runCheck({ event: { pull_request: pr }, env: {}, now: AFTER, fetch: fakeFetch([]) });
      assert.equal(result.status, 'skip');
      assert.equal(result.exitCode, 0);
      assert.match(result.summary, expected);
    }
  });

  test('should emit a notice annotation for the exempt label so the override is visible', async () => {
    const pr = makePr({ body: '', labels: [{ name: EXEMPT_LABEL }] });
    const result = await runCheck({ event: { pull_request: pr }, env: {}, now: AFTER, fetch: fakeFetch([]) });
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].level, 'notice');
  });

  test('should judge the labels currently on the PR, not the label of a labeled/unlabeled event', async () => {
    const exempt = { name: EXEMPT_LABEL };
    const added = { action: 'labeled', label: exempt, pull_request: makePr({ body: '', labels: [exempt] }) };
    const removed = { action: 'unlabeled', label: exempt, pull_request: makePr({ body: '', labels: [] }) };
    assert.equal((await runCheck({ event: added, env: {}, now: AFTER, fetch: fakeFetch([]) })).status, 'skip');
    assert.equal((await runCheck({ event: removed, env: {}, now: AFTER, fetch: fakeFetch([]) })).status, 'fail');
  });

  test('should give the same verdict for every pull_request type the workflow triggers on', async () => {
    const types = ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled'];
    for (const action of types) {
      const failing = await runCheck({ event: { action, pull_request: makePr({ body: body('- ') }) }, env: {}, now: AFTER, fetch: fakeFetch([]) });
      assert.equal(failing.status, 'fail', `expected fail on ${action}`);
      const passing = await runCheck({ event: { action, pull_request: makePr() }, env: {}, now: AFTER, fetch: denied() });
      assert.equal(passing.status, 'pass', `expected pass on ${action}`);
    }
  });

  test('should treat a null body as missing section', async () => {
    const pr = makePr({ body: null });
    const result = await runCheck({ event: { pull_request: pr }, env: {}, now: AFTER, fetch: fakeFetch([]) });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no "## Brain context" heading/);
  });

  test('should error with exit 1 when the event has no pull_request', async () => {
    const result = await runCheck({ event: { push: {} }, env: {}, now: BEFORE, fetch: fakeFetch([]) });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
    assert.equal(result.annotations[0].level, 'error');
  });

  test('should error with exit 1 on an invalid ENFORCE_AFTER even before the date', async () => {
    const result = await runCheck({ event: { pull_request: makePr() }, env: { ENFORCE_AFTER: 'soon' }, now: BEFORE, fetch: fakeFetch([]) });
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, 1);
  });

  test('should add the Phase B note when VERIFY_SEARCH_LOG=true without changing the outcome', async () => {
    const env = { VERIFY_SEARCH_LOG: 'true' };
    const result = await runCheck({ event: { pull_request: makePr() }, env, now: AFTER, fetch: denied() });
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /Phase B check skipped/);
  });
});
