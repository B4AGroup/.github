import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_EXCLUDED_REPOS,
  DEFAULT_DELAY_MS,
  DEFAULT_SETTLE_MS,
  EXEMPT_LABEL,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_RETRIES,
  RATE_LIMIT_FLOOR,
  RECHECK_LABEL,
  buildStepSummary,
  createClient,
  ensureLabel,
  fireRecheck,
  isGatedBase,
  listOpenPulls,
  listRepos,
  parseArgs,
  rateLimitPauseMs,
  resolveToken,
  retryDelayMs,
  runExemptLabel,
  runRecheck,
  selectRepos,
} from './lib.mjs';

const ORG = 'B4AGroup';
const API = 'https://api.github.com';
const OK_HEADERS = { 'x-ratelimit-remaining': '4500', 'x-ratelimit-reset': '1800000000' };

function repo(name, overrides = {}) {
  return { name, full_name: `${ORG}/${name}`, archived: false, disabled: false, default_branch: 'master', ...overrides };
}

function pull(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    base: { ref: 'master' },
    user: { login: 'dev-one' },
    labels: [],
    html_url: `https://github.com/${ORG}/x/pull/${number}`,
    ...overrides,
  };
}

/**
 * In-memory GitHub REST fake. `pulls` and `labels` are keyed by repo name.
 * `failures` maps a path prefix to an HTTP status to force errors.
 * Records every call as { method, path, body }.
 */
function fakeGitHub({ repos = [], pulls = {}, labels = {}, failures = {} } = {}) {
  const state = {
    labels: Object.fromEntries(Object.entries(labels).map(([name, list]) => [name, new Set(list)])),
    pulls: structuredClone(pulls),
  };
  const calls = [];
  const respond = (status, data = null) => ({ status, headers: OK_HEADERS, json: async () => data });
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    const path = u.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    const page = Number(u.searchParams.get('page') ?? '1');
    const forced = Object.entries(failures).find(([prefix]) => `${method} ${path}`.startsWith(prefix));
    if (forced) return respond(forced[1], { message: 'forced' });

    let match;
    if ((match = path.match(/^\/orgs\/([^/]+)\/repos$/)) && method === 'GET') {
      return respond(200, repos.slice((page - 1) * 100, page * 100));
    }
    if ((match = path.match(/^\/repos\/[^/]+\/([^/]+)\/pulls$/)) && method === 'GET') {
      return respond(200, (state.pulls[match[1]] ?? []).slice((page - 1) * 100, page * 100));
    }
    if ((match = path.match(/^\/repos\/[^/]+\/([^/]+)\/labels\/([^/]+)$/)) && method === 'GET') {
      const set = state.labels[match[1]] ?? new Set();
      return set.has(decodeURIComponent(match[2])) ? respond(200, { name: match[2] }) : respond(404, { message: 'Not Found' });
    }
    if ((match = path.match(/^\/repos\/[^/]+\/([^/]+)\/labels$/)) && method === 'POST') {
      state.labels[match[1]] ??= new Set();
      if (state.labels[match[1]].has(body.name)) return respond(422, { errors: [{ code: 'already_exists' }] });
      state.labels[match[1]].add(body.name);
      return respond(201, body);
    }
    if ((match = path.match(/^\/repos\/[^/]+\/([^/]+)\/issues\/(\d+)\/labels$/)) && method === 'POST') {
      const pr = (state.pulls[match[1]] ?? []).find((item) => item.number === Number(match[2]));
      if (!pr) return respond(404);
      for (const name of body.labels) if (!pr.labels.some((label) => label.name === name)) pr.labels.push({ name });
      return respond(200, pr.labels);
    }
    if ((match = path.match(/^\/repos\/[^/]+\/([^/]+)\/issues\/(\d+)\/labels\/([^/]+)$/)) && method === 'DELETE') {
      const pr = (state.pulls[match[1]] ?? []).find((item) => item.number === Number(match[2]));
      const name = decodeURIComponent(match[3]);
      if (!pr || !pr.labels.some((label) => label.name === name)) return respond(404, { message: 'Label does not exist' });
      pr.labels = pr.labels.filter((label) => label.name !== name);
      return respond(200, pr.labels);
    }
    return respond(500, { message: `unhandled ${method} ${path}` });
  };
  fetch.calls = calls;
  fetch.state = state;
  fetch.writes = () => calls.filter((call) => call.method !== 'GET');
  return fetch;
}

function harness(fake) {
  const sleeps = [];
  const logs = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const log = (line) => { logs.push(line); };
  const client = createClient({ token: 't', fetch: fake, sleep, log });
  return { client, sleep, log, sleeps, logs };
}

const baseOptions = {
  mode: 'recheck',
  apply: false,
  org: ORG,
  label: RECHECK_LABEL.name,
  repos: [],
  exclude: [],
  skipDrafts: false,
  delayMs: 7,
  settleMs: 3,
};

describe('parseArgs', () => {
  test('should default to a dry-run recheck of the whole org', () => {
    const result = parseArgs([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.options, {
      mode: 'recheck',
      apply: false,
      org: ORG,
      label: RECHECK_LABEL.name,
      repos: [],
      exclude: [],
      skipDrafts: false,
      delayMs: DEFAULT_DELAY_MS,
      settleMs: DEFAULT_SETTLE_MS,
    });
  });
  test('should read every flag, including repeated and comma-separated lists', () => {
    const result = parseArgs(['--apply', '--mode', 'exempt-label', '--org', 'Other', '--label', 'tmp', '--repo', 'a,b', '--repo', 'c', '--exclude', 'x', '--skip-drafts', '--delay-ms', '0', '--settle-ms', '10']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.options, {
      mode: 'exempt-label',
      apply: true,
      org: 'Other',
      label: 'tmp',
      repos: ['a', 'b', 'c'],
      exclude: ['x'],
      skipDrafts: true,
      delayMs: 0,
      settleMs: 10,
    });
  });
  test('should reject an unknown mode', () => {
    const result = parseArgs(['--mode', 'delete-everything']);
    assert.equal(result.ok, false);
    assert.match(result.error, /--mode must be one of recheck, exempt-label/);
  });
  test('should reject an unknown flag', () => {
    const result = parseArgs(['--force']);
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown argument "--force"/);
  });
  test('should reject non-numeric or negative durations', () => {
    assert.equal(parseArgs(['--delay-ms', 'abc']).ok, false);
    assert.equal(parseArgs(['--settle-ms', '-1']).ok, false);
    assert.equal(parseArgs(['--delay-ms']).ok, false);
  });
  test('should reject --org and --label without a value', () => {
    assert.match(parseArgs(['--org']).error, /--org needs a value/);
    assert.match(parseArgs(['--label', '--apply']).error, /--label needs a value/);
  });
  test('should return the help text on --help', () => {
    const result = parseArgs(['--help']);
    assert.equal(result.ok, true);
    assert.equal(result.help, true);
    assert.match(result.text, /--apply/);
    assert.match(result.text, /GITHUB_TOKEN do not\ntrigger other workflows/);
  });
});

describe('resolveToken', () => {
  test('should prefer GATE_RECHECK_TOKEN, then GH_TOKEN, then GITHUB_TOKEN', () => {
    assert.deepEqual(resolveToken({ GATE_RECHECK_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_TOKEN: 'c' }), { token: 'a', source: 'GATE_RECHECK_TOKEN' });
    assert.deepEqual(resolveToken({ GH_TOKEN: 'b', GITHUB_TOKEN: 'c' }), { token: 'b', source: 'GH_TOKEN' });
    assert.deepEqual(resolveToken({ GITHUB_TOKEN: ' c ' }), { token: 'c', source: 'GITHUB_TOKEN' });
  });
  test('should return null when every candidate is empty or missing', () => {
    assert.deepEqual(resolveToken({ GATE_RECHECK_TOKEN: '  ' }), { token: null, source: null });
    assert.deepEqual(resolveToken({}), { token: null, source: null });
  });
});

describe('retryDelayMs', () => {
  const now = 1_000_000_000_000;
  test('should honour retry-after on 429 and on 403', () => {
    assert.equal(retryDelayMs({ status: 429, headers: { 'retry-after': '5' } }, 0, now), 6000);
    assert.equal(retryDelayMs({ status: 403, headers: { 'retry-after': '2' } }, 0, now), 3000);
  });
  test('should wait until x-ratelimit-reset when the primary limit is exhausted', () => {
    const reset = String(Math.floor(now / 1000) + 30);
    assert.equal(retryDelayMs({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }, 0, now), 31000);
  });
  test('should fall back to 60s when a rate limit response has no timing header', () => {
    assert.equal(retryDelayMs({ status: 429, headers: {} }, 0, now), 60000);
  });
  test('should not retry a plain 403 (permission denied) or a 404', () => {
    assert.equal(retryDelayMs({ status: 403, headers: { 'x-ratelimit-remaining': '10' } }, 0, now), null);
    assert.equal(retryDelayMs({ status: 404, headers: {} }, 0, now), null);
    assert.equal(retryDelayMs({ status: 200, headers: {} }, 0, now), null);
  });
  test('should back off exponentially on 5xx', () => {
    assert.equal(retryDelayMs({ status: 502, headers: {} }, 0, now), 1000);
    assert.equal(retryDelayMs({ status: 502, headers: {} }, 2, now), 4000);
  });
  test('should clamp absurd waits and read Headers objects too', () => {
    const headers = new Headers({ 'retry-after': '99999' });
    assert.equal(retryDelayMs({ status: 429, headers }, 0, now), MAX_RATE_LIMIT_WAIT_MS);
  });
});

describe('rateLimitPauseMs', () => {
  const now = 1_000_000_000_000;
  const reset = String(Math.floor(now / 1000) + 10);
  test('should pause until reset when remaining is below the floor', () => {
    assert.equal(rateLimitPauseMs({ status: 200, headers: { 'x-ratelimit-remaining': String(RATE_LIMIT_FLOOR - 1), 'x-ratelimit-reset': reset } }, now), 11000);
  });
  test('should not pause at or above the floor, or without headers', () => {
    assert.equal(rateLimitPauseMs({ status: 200, headers: { 'x-ratelimit-remaining': String(RATE_LIMIT_FLOOR), 'x-ratelimit-reset': reset } }, now), 0);
    assert.equal(rateLimitPauseMs({ status: 200, headers: {} }, now), 0);
    assert.equal(rateLimitPauseMs({ status: 200, headers: { 'x-ratelimit-remaining': '1' } }, now), 0);
  });
});

describe('createClient', () => {
  test('should paginate until a short page', async () => {
    const repos = Array.from({ length: 150 }, (_, i) => repo(`r${String(i).padStart(3, '0')}`));
    const fake = fakeGitHub({ repos });
    const { client } = harness(fake);
    const result = await client.paginate(`/orgs/${ORG}/repos?type=all`);
    assert.equal(result.items.length, 150);
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[0].path, /\/orgs\/B4AGroup\/repos$/);
  });
  test('should retry a 429 after the announced delay and then succeed', async () => {
    let attempts = 0;
    const fetch = async () => {
      attempts += 1;
      if (attempts === 1) return { status: 429, headers: { 'retry-after': '1' }, json: async () => ({}) };
      return { status: 200, headers: OK_HEADERS, json: async () => ({ ok: true }) };
    };
    const sleeps = [];
    const client = createClient({ token: 't', fetch, sleep: async (ms) => { sleeps.push(ms); } });
    const result = await client.request('GET', '/x');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
    assert.deepEqual(sleeps, [2000]);
  });
  test('should give up after MAX_RETRIES on persistent 5xx and report the status', async () => {
    let attempts = 0;
    const fetch = async () => { attempts += 1; return { status: 503, headers: {}, json: async () => ({}) }; };
    const client = createClient({ token: 't', fetch, sleep: async () => {} });
    const result = await client.request('GET', '/x');
    assert.equal(result.status, 503);
    assert.equal(attempts, MAX_RETRIES + 1);
  });
  test('should pause proactively when the remaining budget is below the floor', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 5);
    const fetch = async () => ({ status: 200, headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': reset }, json: async () => [] });
    const sleeps = [];
    const client = createClient({ token: 't', fetch, sleep: async (ms) => { sleeps.push(ms); } });
    await client.request('GET', '/x');
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > 0 && sleeps[0] <= 7000, `unexpected pause ${sleeps[0]}`);
  });
  test('should send the bearer token and the API version header', async () => {
    let seen;
    const fetch = async (url, init) => { seen = { url, init }; return { status: 204, headers: OK_HEADERS, json: async () => null }; };
    const client = createClient({ token: 'secret', fetch, sleep: async () => {} });
    const result = await client.request('DELETE', '/x');
    assert.equal(result.status, 204);
    assert.equal(result.data, null);
    assert.equal(seen.url, `${API}/x`);
    assert.equal(seen.init.headers.Authorization, 'Bearer secret');
    assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  });
});

describe('selectRepos', () => {
  const repos = [
    { name: 'app', fullName: `${ORG}/app`, archived: false, disabled: false },
    { name: 'old', fullName: `${ORG}/old`, archived: true, disabled: false },
    { name: 'b4a-brain', fullName: `${ORG}/b4a-brain`, archived: false, disabled: false },
    { name: 'off', fullName: `${ORG}/off`, archived: false, disabled: true },
    { name: 'api', fullName: `${ORG}/api`, archived: false, disabled: false },
  ];
  test('should skip archived, disabled and always-excluded repositories with a reason', () => {
    const { selected, skipped } = selectRepos(repos, {});
    assert.deepEqual(selected.map((item) => item.name), ['app', 'api']);
    assert.deepEqual(skipped, [
      { repo: `${ORG}/old`, reason: 'archived' },
      { repo: `${ORG}/b4a-brain`, reason: 'excluded' },
      { repo: `${ORG}/off`, reason: 'disabled' },
    ]);
    assert.deepEqual(ALWAYS_EXCLUDED_REPOS, ['b4a-brain']);
  });
  test('should honour --exclude case-insensitively', () => {
    const { selected, skipped } = selectRepos(repos, { exclude: ['APP'] });
    assert.deepEqual(selected.map((item) => item.name), ['api']);
    assert.ok(skipped.some((item) => item.repo === `${ORG}/app` && item.reason === 'excluded'));
  });
  test('should restrict to --repo and still refuse an archived or excluded one', () => {
    assert.deepEqual(selectRepos(repos, { repos: ['api'] }).selected.map((item) => item.name), ['api']);
    const forced = selectRepos(repos, { repos: ['old', 'b4a-brain'] });
    assert.deepEqual(forced.selected, []);
    assert.equal(forced.skipped.length, 2);
  });
  test('should return empty lists for no repositories', () => {
    assert.deepEqual(selectRepos([], {}), { selected: [], skipped: [] });
  });
});

describe('isGatedBase', () => {
  test('should accept the default branch and main/master/develop', () => {
    assert.equal(isGatedBase('trunk', 'trunk'), true);
    assert.equal(isGatedBase('main', 'trunk'), true);
    assert.equal(isGatedBase('master', 'main'), true);
    assert.equal(isGatedBase('develop', 'main'), true);
  });
  test('should reject feature branches, empty and null refs', () => {
    assert.equal(isGatedBase('feature/x', 'main'), false);
    assert.equal(isGatedBase('release/1.2', 'main'), false);
    assert.equal(isGatedBase('', 'main'), false);
    assert.equal(isGatedBase(null, 'main'), false);
    assert.equal(isGatedBase('Main', 'main'), false);
  });
});

describe('listRepos / listOpenPulls', () => {
  test('should map repositories and sort them by name', async () => {
    const fake = fakeGitHub({ repos: [repo('zeta', { default_branch: 'main' }), repo('alpha', { archived: true })] });
    const { client } = harness(fake);
    const result = await listRepos(client, ORG);
    assert.deepEqual(result.repos, [
      { name: 'alpha', fullName: `${ORG}/alpha`, archived: true, disabled: false, defaultBranch: 'master' },
      { name: 'zeta', fullName: `${ORG}/zeta`, archived: false, disabled: false, defaultBranch: 'main' },
    ]);
  });
  test('should report an error when the repository listing is denied', async () => {
    const fake = fakeGitHub({ failures: { [`GET /orgs/${ORG}/repos`]: 401 } });
    const { client } = harness(fake);
    const result = await listRepos(client, ORG);
    assert.match(result.error, /could not list repositories of B4AGroup: HTTP 401/);
    assert.deepEqual(result.repos, []);
  });
  test('should map pull requests with their labels and sort by number', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(9, { draft: true, labels: [{ name: 'bug' }] }), pull(2, { base: { ref: 'develop' } })] } });
    const { client } = harness(fake);
    const result = await listOpenPulls(client, `${ORG}/app`);
    assert.deepEqual(result.pulls.map((pr) => pr.number), [2, 9]);
    assert.deepEqual(result.pulls[1], {
      number: 9, title: 'PR 9', draft: true, baseRef: 'master', author: 'dev-one', labels: ['bug'], url: `https://github.com/${ORG}/x/pull/9`,
    });
  });
});

describe('ensureLabel', () => {
  test('should report present without writing', async () => {
    const fake = fakeGitHub({ labels: { app: [RECHECK_LABEL.name] } });
    const { client } = harness(fake);
    assert.deepEqual(await ensureLabel(client, `${ORG}/app`, RECHECK_LABEL, { apply: true }), { state: 'present' });
    assert.equal(fake.writes().length, 0);
  });
  test('should only announce the creation in dry-run', async () => {
    const fake = fakeGitHub();
    const { client } = harness(fake);
    assert.deepEqual(await ensureLabel(client, `${ORG}/app`, RECHECK_LABEL, { apply: false }), { state: 'would-create' });
    assert.equal(fake.writes().length, 0);
  });
  test('should create the label with name, colour and description when applying', async () => {
    const fake = fakeGitHub();
    const { client } = harness(fake);
    assert.deepEqual(await ensureLabel(client, `${ORG}/app`, EXEMPT_LABEL, { apply: true }), { state: 'created' });
    const post = fake.writes()[0];
    assert.equal(post.path, `/repos/${ORG}/app/labels`);
    assert.deepEqual(post.body, { name: EXEMPT_LABEL.name, color: EXEMPT_LABEL.color, description: EXEMPT_LABEL.description });
  });
  test('should treat a 422 already_exists as present (another run created it first)', async () => {
    let gets = 0;
    const fetch = async (url, init = {}) => {
      if ((init.method ?? 'GET') === 'GET') { gets += 1; return { status: 404, headers: OK_HEADERS, json: async () => ({}) }; }
      return { status: 422, headers: OK_HEADERS, json: async () => ({}) };
    };
    const client = createClient({ token: 't', fetch, sleep: async () => {} });
    assert.deepEqual(await ensureLabel(client, `${ORG}/app`, RECHECK_LABEL, { apply: true }), { state: 'present' });
    assert.equal(gets, 1);
  });
  test('should report an error when the label cannot be read or created', async () => {
    const denied = fakeGitHub({ failures: { [`GET /repos/${ORG}/app/labels/`]: 403 } });
    const { client: c1 } = harness(denied);
    const read = await ensureLabel(c1, `${ORG}/app`, RECHECK_LABEL, { apply: true });
    assert.equal(read.state, 'error');
    assert.match(read.note, /HTTP 403/);
    const forbidden = fakeGitHub({ failures: { [`POST /repos/${ORG}/app/labels`]: 403 } });
    const { client: c2 } = harness(forbidden);
    const create = await ensureLabel(c2, `${ORG}/app`, RECHECK_LABEL, { apply: true });
    assert.equal(create.state, 'error');
    assert.match(create.note, /could not create label/);
  });
});

describe('fireRecheck', () => {
  const pr = () => ({ number: 5, labels: ['bug'] });
  test('should add then remove the label, pausing settle-ms between and delay-ms after', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(5, { labels: [{ name: 'bug' }] })] } });
    const { client, sleep, sleeps } = harness(fake);
    const result = await fireRecheck(client, `${ORG}/app`, pr(), 'gate-recheck', { settleMs: 3, delayMs: 7, sleep });
    assert.deepEqual(result, { events: ['labeled', 'unlabeled'] });
    assert.deepEqual(fake.writes().map((call) => `${call.method} ${call.path}`), [
      `POST /repos/${ORG}/app/issues/5/labels`,
      `DELETE /repos/${ORG}/app/issues/5/labels/gate-recheck`,
    ]);
    assert.deepEqual(fake.writes()[0].body, { labels: ['gate-recheck'] });
    assert.deepEqual(sleeps, [3, 7]);
    assert.deepEqual(fake.state.pulls.app[0].labels, [{ name: 'bug' }]);
  });
  test('should only remove the label when the PR already carries it', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(5, { labels: [{ name: 'gate-recheck' }] })] } });
    const { client, sleep, sleeps } = harness(fake);
    const result = await fireRecheck(client, `${ORG}/app`, { number: 5, labels: ['gate-recheck'] }, 'gate-recheck', { settleMs: 3, delayMs: 7, sleep });
    assert.deepEqual(result, { events: ['unlabeled'] });
    assert.equal(fake.writes().length, 1);
    assert.equal(fake.writes()[0].method, 'DELETE');
    assert.deepEqual(sleeps, [7]);
  });
  test('should stop with an error when adding fails and not attempt the removal', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(5)] }, failures: { [`POST /repos/${ORG}/app/issues/5/labels`]: 403 } });
    const { client, sleep } = harness(fake);
    const result = await fireRecheck(client, `${ORG}/app`, pr(), 'gate-recheck', { settleMs: 0, delayMs: 0, sleep });
    assert.deepEqual(result.events, []);
    assert.match(result.error, /could not add label to #5 \(HTTP 403\)/);
    assert.equal(fake.writes().filter((call) => call.method === 'DELETE').length, 0);
  });
  test('should accept a 404 on removal (someone removed it meanwhile) as done', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(5)] }, failures: { [`DELETE /repos/${ORG}/app/issues/5/labels/gate-recheck`]: 404 } });
    const { client, sleep } = harness(fake);
    const result = await fireRecheck(client, `${ORG}/app`, pr(), 'gate-recheck', { settleMs: 0, delayMs: 0, sleep });
    assert.deepEqual(result, { events: ['labeled', 'unlabeled'] });
  });
  test('should report an error on a failed removal', async () => {
    const fake = fakeGitHub({ pulls: { app: [pull(5)] }, failures: { [`DELETE /repos/${ORG}/app/issues/5/labels/gate-recheck`]: 500 } });
    const { client, sleep } = harness(fake);
    const result = await fireRecheck(client, `${ORG}/app`, pr(), 'gate-recheck', { settleMs: 0, delayMs: 0, sleep });
    assert.deepEqual(result.events, ['labeled']);
    assert.match(result.error, /could not remove label from #5 \(HTTP 500\)/);
  });
});

function orgFixture() {
  return {
    repos: [
      repo('api', { default_branch: 'main' }),
      repo('app'),
      repo('b4a-brain'),
      repo('legacy', { archived: true }),
    ],
    pulls: {
      api: [pull(1, { base: { ref: 'main' } }), pull(2, { base: { ref: 'develop' }, draft: true }), pull(3, { base: { ref: 'feature/x' } })],
      app: [pull(10, { labels: [{ name: 'gate-recheck' }] }), pull(11, { base: { ref: 'release/2' } })],
      'b4a-brain': [pull(99)],
      legacy: [pull(7)],
    },
    labels: { app: ['gate-recheck'] },
  };
}

describe('runRecheck — dry-run (default)', () => {
  test('should list what it would touch and write nothing', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log, logs } = harness(fake);
    const summary = await runRecheck(baseOptions, { client, sleep, log });
    assert.equal(fake.writes().length, 0);
    assert.equal(summary.apply, false);
    assert.equal(summary.repos.scanned, 4);
    assert.equal(summary.repos.selected, 2);
    assert.deepEqual(summary.repos.skipped.map((item) => `${item.repo}:${item.reason}`), [`${ORG}/b4a-brain:excluded`, `${ORG}/legacy:archived`]);
    assert.deepEqual(summary.prs.planned.map((item) => `${item.repo}#${item.number}`), [`${ORG}/api#1`, `${ORG}/api#2`, `${ORG}/app#10`]);
    assert.equal(summary.prs.skippedBase, 2);
    assert.deepEqual(summary.labels.wouldCreate, [`${ORG}/api`]);
    assert.deepEqual(summary.labels.created, []);
    assert.deepEqual(summary.errors, []);
    assert.ok(logs.some((line) => /\[dry-run\] would create label "gate-recheck"/.test(line)));
    assert.ok(logs.some((line) => /\[dry-run\] #2 "PR 2" \(base develop, draft, by dev-one\) -> would add \+ remove "gate-recheck"/.test(line)));
    assert.ok(logs.at(-1).startsWith('Totals: 2 repo(s) scanned, 3 PR(s) would touch, 1 label(s) to create'));
  });
  test('should never list pull requests of skipped repositories', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    await runRecheck(baseOptions, { client, sleep, log });
    const pullListings = fake.calls.filter((call) => /\/pulls$/.test(call.path)).map((call) => call.path);
    assert.deepEqual(pullListings, [`/repos/${ORG}/api/pulls`, `/repos/${ORG}/app/pulls`]);
  });
  test('should leave drafts out with --skip-drafts and count them', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck({ ...baseOptions, skipDrafts: true }, { client, sleep, log });
    assert.deepEqual(summary.prs.planned.map((item) => item.number), [1, 10]);
    assert.equal(summary.prs.skippedDraft, 1);
  });
  test('should restrict to --repo and flag unknown names as errors', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck({ ...baseOptions, repos: ['app', 'ghost'] }, { client, sleep, log });
    assert.deepEqual(summary.prs.planned.map((item) => `${item.repo}#${item.number}`), [`${ORG}/app#10`]);
    assert.deepEqual(summary.errors, [`repository "ghost" not found in ${ORG}`]);
  });
  test('should stop with an error when the repository listing fails', async () => {
    const fake = fakeGitHub({ failures: { [`GET /orgs/${ORG}/repos`]: 403 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(baseOptions, { client, sleep, log });
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /could not list repositories/);
    assert.equal(summary.repos.scanned, 0);
  });
  test('should not need a label check when a repository has no gated PRs', async () => {
    const fake = fakeGitHub({ repos: [repo('quiet')], pulls: { quiet: [pull(1, { base: { ref: 'feature/y' } })] } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(baseOptions, { client, sleep, log });
    assert.equal(summary.prs.planned.length, 0);
    assert.equal(fake.calls.filter((call) => /\/labels/.test(call.path)).length, 0);
  });
});

describe('runRecheck — apply', () => {
  const apply = { ...baseOptions, apply: true };
  test('should create the missing label, then add and remove it on every gated PR', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log, sleeps } = harness(fake);
    const summary = await runRecheck(apply, { client, sleep, log });
    assert.deepEqual(summary.labels.created, [`${ORG}/api`]);
    assert.deepEqual(summary.prs.touched.map((item) => `${item.repo}#${item.number}:${item.events.join('+')}`), [
      `${ORG}/api#1:labeled+unlabeled`,
      `${ORG}/api#2:labeled+unlabeled`,
      `${ORG}/app#10:unlabeled`,
    ]);
    assert.deepEqual(fake.writes().map((call) => `${call.method} ${call.path}`), [
      `POST /repos/${ORG}/api/labels`,
      `POST /repos/${ORG}/api/issues/1/labels`,
      `DELETE /repos/${ORG}/api/issues/1/labels/gate-recheck`,
      `POST /repos/${ORG}/api/issues/2/labels`,
      `DELETE /repos/${ORG}/api/issues/2/labels/gate-recheck`,
      `DELETE /repos/${ORG}/app/issues/10/labels/gate-recheck`,
    ]);
    assert.deepEqual(sleeps, [7, 3, 7, 3, 7, 7]);
    assert.deepEqual(summary.errors, []);
    for (const prs of Object.values(fake.state.pulls)) {
      for (const pr of prs) assert.equal(pr.labels.some((label) => label.name === 'gate-recheck'), false, `#${pr.number} still labelled`);
    }
  });
  test('should never touch the excluded or archived repositories', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    await runRecheck(apply, { client, sleep, log });
    assert.equal(fake.writes().some((call) => /b4a-brain|legacy/.test(call.path)), false);
  });
  test('should record per-repository failures and keep going with the others', async () => {
    const fake = fakeGitHub({ ...orgFixture(), failures: { [`GET /repos/${ORG}/api/pulls`]: 403 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(apply, { client, sleep, log });
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /could not list pull requests of B4AGroup\/api: HTTP 403/);
    assert.deepEqual(summary.prs.touched.map((item) => item.number), [10]);
  });
  test('should skip the PRs of a repository whose label cannot be created', async () => {
    const fake = fakeGitHub({ ...orgFixture(), failures: { [`POST /repos/${ORG}/api/labels`]: 403 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(apply, { client, sleep, log });
    assert.match(summary.errors[0], /could not create label "gate-recheck" \(HTTP 403\)/);
    assert.equal(fake.writes().some((call) => call.path.includes('/api/issues/')), false);
    assert.deepEqual(summary.prs.touched.map((item) => item.number), [10]);
  });
  test('should record a failed PR and continue with the next one', async () => {
    const fake = fakeGitHub({ ...orgFixture(), failures: { [`POST /repos/${ORG}/api/issues/1/labels`]: 500 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(apply, { client, sleep, log });
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /could not add label to #1/);
    assert.deepEqual(summary.prs.touched.map((item) => item.number), [2, 10]);
  });
  test('should use a custom label name everywhere', async () => {
    const fake = fakeGitHub({ repos: [repo('api')], pulls: { api: [pull(1)] } });
    const { client, sleep, log } = harness(fake);
    await runRecheck({ ...apply, label: 'recheck-now' }, { client, sleep, log });
    assert.deepEqual(fake.writes().map((call) => call.path), [
      `/repos/${ORG}/api/labels`,
      `/repos/${ORG}/api/issues/1/labels`,
      `/repos/${ORG}/api/issues/1/labels/recheck-now`,
    ]);
    assert.equal(fake.writes()[0].body.name, 'recheck-now');
  });
  test('should survive an unexpected exception in one repository', async () => {
    const fixture = orgFixture();
    const inner = fakeGitHub(fixture);
    const fetch = async (url, init) => {
      if (url.includes('/repos/B4AGroup/api/pulls')) throw new Error('socket hang up');
      return inner(url, init);
    };
    fetch.calls = inner.calls;
    const client = createClient({ token: 't', fetch, sleep: async () => {} });
    const summary = await runRecheck(apply, { client, sleep: async () => {}, log: () => {} });
    assert.match(summary.errors[0], /B4AGroup\/api: socket hang up/);
    assert.deepEqual(summary.prs.touched.map((item) => item.number), [10]);
  });
});

describe('runExemptLabel', () => {
  test('should only report the repositories missing the label in dry-run', async () => {
    const fake = fakeGitHub({ ...orgFixture(), labels: { app: [EXEMPT_LABEL.name] } });
    const { client, sleep, log, logs } = harness(fake);
    const summary = await runExemptLabel({ ...baseOptions, mode: 'exempt-label' }, { client, sleep, log });
    assert.equal(fake.writes().length, 0);
    assert.deepEqual(summary.labels.wouldCreate, [`${ORG}/api`]);
    assert.deepEqual(summary.labels.present, [`${ORG}/app`]);
    assert.deepEqual(summary.repos.skipped.map((item) => item.reason), ['excluded', 'archived']);
    assert.ok(logs.at(-1).startsWith('Totals: 2 repo(s) scanned, 1 already had the label, 1 to create, 0 error(s).'));
  });
  test('should create the label where missing when applying and pause between writes', async () => {
    const fake = fakeGitHub({ ...orgFixture(), labels: { app: [EXEMPT_LABEL.name] } });
    const { client, sleep, log, sleeps } = harness(fake);
    const summary = await runExemptLabel({ ...baseOptions, mode: 'exempt-label', apply: true }, { client, sleep, log });
    assert.deepEqual(summary.labels.created, [`${ORG}/api`]);
    assert.deepEqual(fake.writes().map((call) => `${call.method} ${call.path}`), [`POST /repos/${ORG}/api/labels`]);
    assert.deepEqual(fake.writes()[0].body, { name: EXEMPT_LABEL.name, color: EXEMPT_LABEL.color, description: EXEMPT_LABEL.description });
    assert.deepEqual(sleeps, [7]);
  });
  test('should record a repository where the label API is denied and continue', async () => {
    const fake = fakeGitHub({ ...orgFixture(), failures: { [`GET /repos/${ORG}/api/labels/`]: 403 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runExemptLabel({ ...baseOptions, mode: 'exempt-label', apply: true }, { client, sleep, log });
    assert.equal(summary.errors.length, 1);
    assert.deepEqual(summary.labels.created, [`${ORG}/app`]);
  });
  test('should stop with an error when the repository listing fails', async () => {
    const fake = fakeGitHub({ failures: { [`GET /orgs/${ORG}/repos`]: 401 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runExemptLabel({ ...baseOptions, mode: 'exempt-label' }, { client, sleep, log });
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.repos.selected, 0);
  });
});

describe('buildStepSummary', () => {
  test('should render the planned PRs as a table in dry-run', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck(baseOptions, { client, sleep, log });
    const markdown = buildStepSummary(summary);
    assert.match(markdown, /^## Gate re-check — recheck \(dry-run\)/);
    assert.match(markdown, /\| \[B4AGroup\/api#2\]\(https:\/\/github.com\/B4AGroup\/x\/pull\/2\) \| develop \| yes \| dev-one \| would add \+ remove label \|/);
    assert.match(markdown, /### Skipped repositories\n- B4AGroup\/b4a-brain: excluded\n- B4AGroup\/legacy: archived/);
    assert.doesNotMatch(markdown, /### Errors/);
  });
  test('should render fired events and errors when applying', async () => {
    const fake = fakeGitHub({ ...orgFixture(), failures: { [`GET /repos/${ORG}/api/pulls`]: 403 } });
    const { client, sleep, log } = harness(fake);
    const summary = await runRecheck({ ...baseOptions, apply: true }, { client, sleep, log });
    const markdown = buildStepSummary(summary);
    assert.match(markdown, /\(apply\)/);
    assert.match(markdown, /\| \[B4AGroup\/app#10\]\(https:\/\/github.com\/B4AGroup\/x\/pull\/10\) \| master \| no \| dev-one \| unlabeled \|/);
    assert.match(markdown, /### Errors\n- could not list pull requests of B4AGroup\/api/);
  });
  test('should list the repositories for the exempt-label mode', async () => {
    const fake = fakeGitHub(orgFixture());
    const { client, sleep, log } = harness(fake);
    const summary = await runExemptLabel({ ...baseOptions, mode: 'exempt-label' }, { client, sleep, log });
    const markdown = buildStepSummary(summary);
    assert.match(markdown, /^## Gate re-check — exempt-label \(dry-run\)/);
    assert.match(markdown, /Would create in:\n- B4AGroup\/api\n- B4AGroup\/app/);
  });
});
