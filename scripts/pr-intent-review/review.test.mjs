import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describePr, runReview } from './review.mjs';
import { ApiError } from './clients.mjs';
import { SYSTEM_PROMPT } from './lib.mjs';

const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant',
  LINEAR_API_KEY: 'lin_api_k',
  B4A_MCP_TOKEN: 'gw_svc_t',
  B4A_MCP_URL: 'https://gateway.example/mcp',
  GITHUB_TOKEN: 'ghs',
};

const MODEL_ANSWER = JSON.stringify({
  verdict: 'pass',
  reasons: ['Intent, ticket and diff agree.'],
  intent_justified: true,
  matches_ticket: true,
  fits_brain: true,
  diff_matches_intent: true,
});

function makeEvent(overrides = {}) {
  return {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'B4A-123: keep the coupon on PIX checkout',
      body: '## What and Why\nCustomers lose the coupon when they pay with PIX. We now persist it.\n\n## Brain context\n- none relevant: pilot test only, no decision applies\n',
      user: { login: 'dev-one' },
      head: { ref: 'feat/b4a-123-pix-coupon', sha: 'abcdef1234567890' },
      base: { ref: 'main', repo: { full_name: 'B4AGroup/glam-frontend' } },
      ...overrides,
    },
  };
}

function makeClients(overrides = {}) {
  const calls = { linear: [], brain: [], files: [], anthropic: [] };
  const clients = {
    fetchLinearIssue: async (args) => {
      calls.linear.push(args);
      return { identifier: 'B4A-123', title: 'Coupon lost on PIX', description: 'Keep the coupon.', state: 'In Progress', project: 'Glam', labels: [], parent: null };
    },
    searchBrain: async (args) => {
      calls.brain.push(args);
      return [{ query: args.queries[0], hits: [{ path: 'glam/decisions.md', heading: 'PIX', score: 0.8, snippet: 'PIX keeps coupons', url: 'https://github.com/B4AGroup/b4a-brain/blob/master/glam/decisions.md' }] }];
    },
    fetchPrFiles: async (args) => {
      calls.files.push(args);
      return [{ filename: 'src/checkout.ts', status: 'modified', additions: 5, deletions: 1, patch: '+keepCoupon()' }, { filename: 'package-lock.json', patch: '+lock', additions: 1, deletions: 0 }];
    },
    callAnthropic: async (args) => {
      calls.anthropic.push(args);
      return { text: MODEL_ANSWER, usage: { input_tokens: 100, output_tokens: 20 }, stopReason: 'end_turn' };
    },
    ...overrides,
  };
  return { clients, calls };
}

const fetchStub = async () => { throw new Error('network must not be used in tests'); };

describe('describePr', () => {
  test('should map the payload fields and fall back to GITHUB_REPOSITORY', () => {
    const pr = describePr(makeEvent(), {});
    assert.deepEqual(pr, {
      repo: 'B4AGroup/glam-frontend', number: 42, title: 'B4A-123: keep the coupon on PIX checkout',
      body: makeEvent().pull_request.body, author: 'dev-one', branch: 'feat/b4a-123-pix-coupon', baseBranch: 'main',
      headSha: 'abcdef1234567890', action: 'opened',
    });
    assert.equal(describePr({ pull_request: {} }, { GITHUB_REPOSITORY: 'x/y' }).repo, 'x/y');
    assert.equal(describePr(null, {}).repo, 'unknown');
  });
});

describe('runReview — happy path', () => {
  test('should review the PR, call every upstream once and return the verdict', async () => {
    const { clients, calls } = makeClients();
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients, now: (() => { let t = 1000; return () => (t += 250); })() });

    assert.equal(result.status, 'reviewed');
    assert.equal(result.verdict.verdict, 'pass');
    assert.deepEqual(result.verdict.reasons, ['Intent, ticket and diff agree.']);
    assert.equal(result.model, 'claude-fable-5-1');
    assert.equal(result.linearId, 'B4A-123');
    assert.equal(result.linearIssue.identifier, 'B4A-123');
    assert.equal(result.whatAndWhy.source, 'what-and-why');
    assert.deepEqual(result.notes, []);
    assert.equal(result.brainHits.length, 1);
    assert.equal(result.diffStats.included, 1);
    assert.deepEqual(result.diffStats.skippedGenerated, ['package-lock.json']);
    assert.equal(result.modelRaw, MODEL_ANSWER);
    assert.equal(result.headSha, 'abcdef1234567890');
    assert.equal(result.durationMs, 250);

    assert.equal(calls.linear.length, 1);
    assert.deepEqual({ apiKey: calls.linear[0].apiKey, id: calls.linear[0].id }, { apiKey: 'lin_api_k', id: 'B4A-123' });
    assert.equal(calls.brain.length, 1);
    assert.equal(calls.brain[0].url, ENV.B4A_MCP_URL);
    assert.equal(calls.brain[0].token, ENV.B4A_MCP_TOKEN);
    assert.deepEqual(calls.brain[0].queries, ['glam-frontend B4A-123: keep the coupon on PIX checkout', 'Coupon lost on PIX', 'Customers lose the coupon when they pay with PIX']);
    assert.equal(calls.brain[0].folder, undefined);
    assert.deepEqual({ repo: calls.files[0].repo, number: calls.files[0].number, token: calls.files[0].token }, { repo: 'B4AGroup/glam-frontend', number: 42, token: 'ghs' });
    assert.equal(calls.anthropic.length, 1);
    assert.equal(calls.anthropic[0].apiKey, 'sk-ant');
    assert.equal(calls.anthropic[0].system, SYSTEM_PROMPT);
    assert.match(calls.anthropic[0].prompt, /<<<WHAT AND WHY>>>/);
    assert.match(calls.anthropic[0].prompt, /B4A-123: Coupon lost on PIX/);
    assert.match(calls.anthropic[0].prompt, /\+keepCoupon\(\)/);
    assert.doesNotMatch(calls.anthropic[0].prompt, /\+lock/);
  });
  test('should honour MODEL, BRAIN_FOLDER and MAX_DIFF_CHARS from the env', async () => {
    const { clients, calls } = makeClients();
    const result = await runReview({ event: makeEvent(), env: { ...ENV, MODEL: 'claude-other', BRAIN_FOLDER: 'glam', MAX_DIFF_CHARS: '70' }, fetch: fetchStub, clients });
    assert.equal(result.model, 'claude-other');
    assert.equal(calls.anthropic[0].model, 'claude-other');
    assert.equal(calls.brain[0].folder, 'glam');
    assert.equal(result.diffStats.truncated, true);
    assert.ok(result.notes.some((note) => /truncated/.test(note)));
  });
  test('should ignore an invalid MAX_DIFF_CHARS and use the default', async () => {
    const { clients } = makeClients();
    const result = await runReview({ event: makeEvent(), env: { ...ENV, MAX_DIFF_CHARS: '-5' }, fetch: fetchStub, clients });
    assert.equal(result.diffStats.truncated, false);
  });
});

describe('runReview — degraded but still reviewed', () => {
  test('should continue without a ticket when no Linear ID is present and not call Linear', async () => {
    const { clients, calls } = makeClients();
    const event = makeEvent({ title: 'Small fix', head: { ref: 'fix/typo', sha: 's' } });
    const result = await runReview({ event, env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'reviewed');
    assert.equal(result.linearId, null);
    assert.equal(calls.linear.length, 0);
    assert.ok(result.notes.some((note) => /No Linear ID/.test(note)));
  });
  test('should continue when the Linear issue is not found and note it', async () => {
    const { clients } = makeClients({ fetchLinearIssue: async () => null });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'reviewed');
    assert.equal(result.linearIssue, null);
    assert.ok(result.notes.some((note) => /B4A-123 was not found/.test(note)));
  });
  test('should note a missing What and Why and still review', async () => {
    const { clients, calls } = makeClients();
    const result = await runReview({ event: makeEvent({ body: '## Testing\nnone' }), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'reviewed');
    assert.equal(result.whatAndWhy.found, false);
    assert.ok(result.notes.some((note) => /no "## What and Why" section/.test(note)));
    assert.match(calls.anthropic[0].prompt, /\(missing: the PR description has no "## What and Why" section\)/);
  });
  test('should note when the Summary section was used instead', async () => {
    const { clients } = makeClients();
    const result = await runReview({ event: makeEvent({ body: '## Summary\nBecause reasons that matter.' }), env: ENV, fetch: fetchStub, clients });
    assert.ok(result.notes.some((note) => /"## Summary" section was used instead/.test(note)));
  });
  test('should still review with zero brain hits', async () => {
    const { clients } = makeClients({ searchBrain: async () => [{ query: 'q', hits: [] }] });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'reviewed');
    assert.deepEqual(result.brainHits, []);
  });
  test('should not call the brain when no query can be built', async () => {
    const { clients, calls } = makeClients({ fetchLinearIssue: async () => null });
    const event = makeEvent({ title: '', body: '', head: { ref: 'b4a-1', sha: 's' }, base: { ref: 'main', repo: { full_name: '' } } });
    const result = await runReview({ event, env: { ...ENV, GITHUB_REPOSITORY: 'x' }, fetch: fetchStub, clients });
    assert.equal(result.status, 'reviewed');
    assert.equal(calls.brain.length, 0);
  });
});

describe('runReview — skipped outcomes (never throw)', () => {
  test('should skip when the event has no pull_request', async () => {
    const result = await runReview({ event: { action: 'push' }, env: ENV, fetch: fetchStub, clients: makeClients().clients });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /no pull_request in the event payload/);
  });
  test('should skip dependency bots and the brain repo before touching any secret', async () => {
    const { clients, calls } = makeClients();
    const bot = await runReview({ event: makeEvent({ user: { login: 'renovate[bot]' } }), env: {}, fetch: fetchStub, clients });
    assert.equal(bot.status, 'skipped');
    assert.match(bot.reason, /dependency bot/);
    assert.equal(bot.silent, true);
    const brain = await runReview({ event: makeEvent({ base: { ref: 'master', repo: { full_name: 'B4AGroup/b4a-brain' } } }), env: {}, fetch: fetchStub, clients });
    assert.match(brain.reason, /b4a-brain itself/);
    assert.equal(brain.silent, true);
    assert.equal(calls.linear.length + calls.brain.length + calls.files.length + calls.anthropic.length, 0);
  });
  test('should skip with the missing secret or variable name', async () => {
    const { clients, calls } = makeClients();
    for (const [name, expected] of [
      ['ANTHROPIC_API_KEY', 'secret ANTHROPIC_API_KEY is not configured'],
      ['LINEAR_API_KEY', 'secret LINEAR_API_KEY is not configured'],
      ['B4A_MCP_TOKEN', 'secret B4A_MCP_TOKEN is not configured'],
      ['B4A_MCP_URL', 'variable B4A_MCP_URL is not configured'],
    ]) {
      const result = await runReview({ event: makeEvent(), env: { ...ENV, [name]: '' }, fetch: fetchStub, clients });
      assert.equal(result.status, 'skipped', name);
      assert.equal(result.reason, expected);
      assert.equal(result.silent, undefined, 'config skips are commented on the PR');
    }
    assert.equal(calls.anthropic.length, 0);
  });
  test('should skip when Linear fails', async () => {
    const { clients, calls } = makeClients({ fetchLinearIssue: async () => { throw new ApiError('Linear', 'the API key was rejected (HTTP 401)'); } });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Linear: the API key was rejected (HTTP 401)');
    assert.equal(calls.anthropic.length, 0);
  });
  test('should skip when the brain gateway fails', async () => {
    const { clients } = makeClients({ searchBrain: async () => { throw new ApiError('B4A MCP gateway', 'unexpected HTTP 503'); } });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'B4A MCP gateway: unexpected HTTP 503');
  });
  test('should skip when the diff cannot be fetched', async () => {
    const { clients } = makeClients({ fetchPrFiles: async () => { throw new ApiError('GitHub', 'GET x -> HTTP 500'); } });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'GitHub: GET x -> HTTP 500');
  });
  test('should skip when Anthropic fails or times out', async () => {
    const { clients } = makeClients({ callAnthropic: async () => { throw new ApiError('Anthropic', 'request failed (timed out after 120000 ms)'); } });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Anthropic: request failed (timed out after 120000 ms)');
  });
  test('should skip when the model answer is not the expected JSON and keep the raw text', async () => {
    const { clients } = makeClients({ callAnthropic: async () => ({ text: 'I think it looks fine.', usage: null, stopReason: 'end_turn' }) });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Anthropic: the model did not return a JSON object');
    assert.equal(result.modelRaw, 'I think it looks fine.');
  });
  test('should turn a non-ApiError exception into a skipped reason too', async () => {
    const { clients } = makeClients({ callAnthropic: async () => { throw new TypeError('fetch failed'); } });
    const result = await runReview({ event: makeEvent(), env: ENV, fetch: fetchStub, clients });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'fetch failed');
  });
});
