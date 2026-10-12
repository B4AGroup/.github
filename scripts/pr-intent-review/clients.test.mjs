import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  callAnthropic,
  fetchLinearIssue,
  fetchPrFiles,
  parseBrainSearchResult,
  parseMcpBody,
  searchBrain,
  upsertStickyComment,
} from './clients.mjs';

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** A fetch stub that answers from a queue (or a function) and records calls. */
function fakeFetch(handler) {
  const calls = [];
  const queue = Array.isArray(handler) ? [...handler] : null;
  const fetch = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (queue) {
      if (queue.length === 0) throw new Error(`unexpected call ${call.method} ${url}`);
      const next = queue.shift();
      return typeof next === 'function' ? next(call) : next;
    }
    return handler(call);
  };
  fetch.calls = calls;
  return fetch;
}

describe('fetchLinearIssue', () => {
  const issuePayload = {
    data: {
      issue: {
        identifier: 'B4A-10', title: 'Child', description: 'desc', url: 'https://linear.app/b4a/issue/B4A-10',
        state: { name: 'In Progress' }, project: { name: 'Glam' }, labels: { nodes: [{ name: 'Bug' }, { name: null }] },
        parent: { identifier: 'B4A-9', title: 'Parent', description: null, url: 'u' },
      },
    },
  };

  test('should send the identifier as a variable with a raw personal key and map the issue', async () => {
    const fetch = fakeFetch([response(200, issuePayload)]);
    const issue = await fetchLinearIssue({ fetch, apiKey: 'lin_api_x', id: 'B4A-10' });
    assert.equal(fetch.calls[0].url, 'https://api.linear.app/graphql');
    assert.equal(fetch.calls[0].headers.Authorization, 'lin_api_x');
    assert.deepEqual(fetch.calls[0].body.variables, { id: 'B4A-10' });
    assert.match(fetch.calls[0].body.query, /^query PrIntentReview/);
    assert.deepEqual(issue, {
      identifier: 'B4A-10', title: 'Child', description: 'desc', url: 'https://linear.app/b4a/issue/B4A-10',
      state: 'In Progress', project: 'Glam', labels: ['Bug'],
      parent: { identifier: 'B4A-9', title: 'Parent', description: '', url: 'u' },
    });
  });
  test('should use the Bearer scheme for OAuth tokens', async () => {
    const fetch = fakeFetch([response(200, issuePayload)]);
    await fetchLinearIssue({ fetch, apiKey: 'lin_oauth_y', id: 'B4A-10' });
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer lin_oauth_y');
  });
  test('should return null when the issue is null or the error says not found', async () => {
    assert.equal(await fetchLinearIssue({ fetch: fakeFetch([response(200, { data: { issue: null } })]), apiKey: 'k', id: 'B4A-1' }), null);
    assert.equal(await fetchLinearIssue({ fetch: fakeFetch([response(200, { errors: [{ message: 'Entity not found: Issue' }] })]), apiKey: 'k', id: 'B4A-1' }), null);
  });
  test('should map a parentless issue with empty fields', async () => {
    const fetch = fakeFetch([response(200, { data: { issue: { identifier: 'B4A-2', title: null, description: null, state: null, project: null, labels: null, parent: null } } })]);
    const issue = await fetchLinearIssue({ fetch, apiKey: 'k', id: 'B4A-2' });
    assert.deepEqual(issue, { identifier: 'B4A-2', title: '', description: '', url: null, state: null, project: null, labels: [], parent: null });
  });
  test('should throw an ApiError without the key for 401, 5xx, GraphQL errors and network failures', async () => {
    await assert.rejects(fetchLinearIssue({ fetch: fakeFetch([response(401, {})]), apiKey: 'lin_api_secret', id: 'B4A-1' }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'Linear: the API key was rejected (HTTP 401)');
      return true;
    });
    await assert.rejects(fetchLinearIssue({ fetch: fakeFetch([response(502, 'bad gateway')]), apiKey: 'k', id: 'B4A-1' }), /Linear: unexpected HTTP 502/);
    await assert.rejects(fetchLinearIssue({ fetch: fakeFetch([response(200, { errors: [{ message: 'Rate limited' }] })]), apiKey: 'k', id: 'B4A-1' }), /Linear: GraphQL error: Rate limited/);
    await assert.rejects(fetchLinearIssue({ fetch: fakeFetch(() => { throw new Error('ECONNRESET'); }), apiKey: 'k', id: 'B4A-1' }), /Linear: request failed \(ECONNRESET\)/);
  });
  test('should report a timeout when the request is aborted', async () => {
    const fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await assert.rejects(fetchLinearIssue({ fetch, apiKey: 'k', id: 'B4A-1', timeoutMs: 5 }), /Linear: request failed \(timed out after 5 ms\)/);
  });
});

describe('parseMcpBody', () => {
  test('should parse a plain JSON body', () => {
    assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json'), { jsonrpc: '2.0', id: 1, result: {} });
  });
  test('should take the last JSON data frame of an SSE body', () => {
    const sse = 'event: message\ndata: {"id":1,"result":"first"}\n\nevent: message\ndata: {"id":2,"result":"second"}\n\n';
    assert.deepEqual(parseMcpBody(sse, 'text/event-stream'), { id: 2, result: 'second' });
  });
  test('should detect SSE without a content type and skip non-JSON frames', () => {
    assert.deepEqual(parseMcpBody('data: ping\ndata: {"ok":true}\n'), { ok: true });
  });
  test('should return null for an empty body', () => {
    assert.equal(parseMcpBody(''), null);
    assert.equal(parseMcpBody(null), null);
  });
});

describe('parseBrainSearchResult', () => {
  const hits = [{ path: 'a.md', heading: 'h', score: 0.5, snippet: 's', url: 'u' }];
  test('should read hits from structuredContent first', () => {
    assert.deepEqual(parseBrainSearchResult({ result: { structuredContent: { hits }, content: [] } }), { hits });
  });
  test('should parse hits from the JSON text content part', () => {
    const result = parseBrainSearchResult({ result: { content: [{ type: 'text', text: JSON.stringify({ query: 'q', hits }) }] } });
    assert.deepEqual(result.hits, hits);
  });
  test('should return no hits when the content is not JSON or the result is missing', () => {
    assert.deepEqual(parseBrainSearchResult({ result: { content: [{ type: 'text', text: 'plain' }] } }), { hits: [] });
    assert.deepEqual(parseBrainSearchResult({}), { hits: [] });
    assert.deepEqual(parseBrainSearchResult(null), { hits: [] });
  });
  test('should throw when the tool reports isError', () => {
    assert.throws(() => parseBrainSearchResult({ result: { isError: true, content: [{ type: 'text', text: 'folder not allowed' }] } }), /brain\.search returned an error: folder not allowed/);
  });
});

describe('searchBrain', () => {
  const hitsFor = (query) => ({ hits: [{ path: `${query}.md`, heading: 'h', score: 0.9, snippet: 's', url: 'u' }] });
  const brainResponse = (id, query) => response(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(hitsFor(query)) }] } }, { 'mcp-session-id': 'sess-1' });

  test('should initialize, notify, call brain.search per query with the session id and close the session', async () => {
    const fetch = fakeFetch([
      response(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'gw' } } }, { 'mcp-session-id': 'sess-1' }),
      response(202, ''),
      brainResponse(2, 'q1'),
      brainResponse(3, 'q2'),
      response(200, ''),
    ]);
    const results = await searchBrain({ fetch, url: 'https://gw.example/mcp', token: 'gw_svc_t', queries: ['q1', 'q2'], k: 3, folder: 'glam' });

    const [init, initialized, call1, call2, close] = fetch.calls;
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer gw_svc_t');
    assert.equal(init.headers.Accept, 'application/json, text/event-stream');
    assert.equal(init.headers['mcp-session-id'], undefined);
    assert.equal(init.body.method, 'initialize');
    assert.equal(initialized.body.method, 'notifications/initialized');
    assert.equal(initialized.headers['mcp-session-id'], 'sess-1');
    assert.equal(call1.body.method, 'tools/call');
    assert.deepEqual(call1.body.params, { name: 'brain.search', arguments: { query: 'q1', k: 3, folder: 'glam' } });
    assert.equal(call2.body.id, 3);
    assert.equal(call2.headers['mcp-session-id'], 'sess-1');
    assert.equal(close.method, 'DELETE');
    assert.equal(close.headers['mcp-session-id'], 'sess-1');

    assert.equal(results.length, 2);
    assert.equal(results[0].query, 'q1');
    assert.equal(results[0].hits[0].path, 'q1.md');
    assert.equal(results[1].hits[0].path, 'q2.md');
  });
  test('should omit the folder argument when not given', async () => {
    const fetch = fakeFetch([
      response(200, { jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 's' }),
      response(202, ''),
      brainResponse(2, 'q'),
      response(200, ''),
    ]);
    await searchBrain({ fetch, url: 'u', token: 't', queries: ['q'] });
    assert.deepEqual(fetch.calls[2].body.params.arguments, { query: 'q', k: 5 });
  });
  test('should fail with a clear message when the token is rejected', async () => {
    const fetch = fakeFetch([response(401, { error: 'invalid_token' })]);
    await assert.rejects(searchBrain({ fetch, url: 'u', token: 'gw_svc_secret', queries: ['q'] }), (error) => {
      assert.equal(error.message, 'B4A MCP gateway: the token was rejected (HTTP 401)');
      return true;
    });
  });
  test('should fail when initialize returns no session id', async () => {
    const fetch = fakeFetch([response(200, { jsonrpc: '2.0', id: 1, result: {} })]);
    await assert.rejects(searchBrain({ fetch, url: 'u', token: 't', queries: ['q'] }), /initialize did not return an mcp-session-id/);
  });
  test('should surface JSON-RPC errors and still close the session', async () => {
    const fetch = fakeFetch([
      response(200, { jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 's' }),
      response(202, ''),
      response(200, { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool' } }),
      response(200, ''),
    ]);
    await assert.rejects(searchBrain({ fetch, url: 'u', token: 't', queries: ['q'] }), /JSON-RPC error -32602: Unknown tool/);
    assert.equal(fetch.calls.at(-1).method, 'DELETE');
  });
  test('should fail on HTTP 5xx and on a non-JSON body', async () => {
    await assert.rejects(searchBrain({ fetch: fakeFetch([response(503, 'down')]), url: 'u', token: 't', queries: ['q'] }), /unexpected HTTP 503/);
    await assert.rejects(searchBrain({ fetch: fakeFetch([response(200, '<html>', { 'content-type': 'text/html' })]), url: 'u', token: 't', queries: ['q'] }), /was not valid JSON/);
  });
  test('should ignore a failing DELETE', async () => {
    const fetch = fakeFetch([
      response(200, { jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 's' }),
      response(202, ''),
      brainResponse(2, 'q'),
      () => { throw new Error('boom'); },
    ]);
    const results = await searchBrain({ fetch, url: 'u', token: 't', queries: ['q'] });
    assert.equal(results.length, 1);
  });
});

describe('fetchPrFiles', () => {
  const files = (count, prefix) => Array.from({ length: count }, (_, index) => ({ filename: `${prefix}${index}.ts`, patch: '+x' }));

  test('should fetch one page when fewer than 100 files come back', async () => {
    const fetch = fakeFetch([response(200, files(2, 'a'))]);
    const result = await fetchPrFiles({ fetch, token: 'ghs', repo: 'o/r', number: 7 });
    assert.equal(result.length, 2);
    assert.equal(fetch.calls[0].url, 'https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=1');
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer ghs');
  });
  test('should follow pages up to the limit', async () => {
    const fetch = fakeFetch([response(200, files(100, 'a')), response(200, files(100, 'b')), response(200, files(100, 'c')), response(200, files(5, 'd'))]);
    const result = await fetchPrFiles({ fetch, token: 't', repo: 'o/r', number: 1, maxPages: 3 });
    assert.equal(result.length, 300);
    assert.equal(fetch.calls.length, 3);
  });
  test('should use a custom API URL and throw on errors with the GitHub message', async () => {
    const fetch = fakeFetch([response(404, { message: 'Not Found' })]);
    await assert.rejects(fetchPrFiles({ fetch, token: 't', apiUrl: 'https://ghe.example/api/v3', repo: 'o/r', number: 1 }), /GitHub: GET \/repos\/o\/r\/pulls\/1\/files.* -> HTTP 404: Not Found/);
    assert.ok(fetch.calls[0].url.startsWith('https://ghe.example/api/v3/'));
  });
  test('should return an empty list when the API answers with a non-array', async () => {
    assert.deepEqual(await fetchPrFiles({ fetch: fakeFetch([response(200, {})]), token: 't', repo: 'o/r', number: 1 }), []);
  });
});

describe('upsertStickyComment', () => {
  const marker = '<!-- pr-intent-review -->';

  test('should create a new comment when none carries the marker', async () => {
    const fetch = fakeFetch([response(200, [{ id: 1, body: 'unrelated' }]), response(201, { id: 2 })]);
    const outcome = await upsertStickyComment({ fetch, token: 't', repo: 'o/r', number: 3, body: `${marker}\nnew`, marker });
    assert.equal(outcome, 'created');
    assert.equal(fetch.calls[1].method, 'POST');
    assert.equal(fetch.calls[1].url, 'https://api.github.com/repos/o/r/issues/3/comments');
    assert.deepEqual(fetch.calls[1].body, { body: `${marker}\nnew` });
  });
  test('should update the existing comment when the marker is found', async () => {
    const fetch = fakeFetch([response(200, [{ id: 9, body: `${marker}\nold` }]), response(200, { id: 9 })]);
    const outcome = await upsertStickyComment({ fetch, token: 't', repo: 'o/r', number: 3, body: 'updated', marker });
    assert.equal(outcome, 'updated');
    assert.equal(fetch.calls[1].method, 'PATCH');
    assert.equal(fetch.calls[1].url, 'https://api.github.com/repos/o/r/issues/comments/9');
  });
  test('should page through comments to find the marker', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: index, body: 'x' }));
    const fetch = fakeFetch([response(200, page), response(200, [{ id: 500, body: marker }]), response(200, {})]);
    assert.equal(await upsertStickyComment({ fetch, token: 't', repo: 'o/r', number: 3, body: 'b', marker }), 'updated');
    assert.equal(fetch.calls[2].url, 'https://api.github.com/repos/o/r/issues/comments/500');
  });
  test('should throw an ApiError on a forbidden write (fork PR)', async () => {
    const fetch = fakeFetch([response(200, []), response(403, { message: 'Resource not accessible by integration' })]);
    await assert.rejects(upsertStickyComment({ fetch, token: 't', repo: 'o/r', number: 3, body: 'b', marker }), /GitHub: POST .* -> HTTP 403: Resource not accessible by integration/);
  });
});

describe('callAnthropic', () => {
  test('should send the model, system prompt and message and return the text', async () => {
    const fetch = fakeFetch([response(200, { content: [{ type: 'text', text: '{"verdict":"pass"}' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' })]);
    const result = await callAnthropic({ fetch, apiKey: 'sk-ant', model: 'claude-fable-5-1', system: 'sys', prompt: 'hello' });
    const call = fetch.calls[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-ant');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.body.model, 'claude-fable-5-1');
    assert.equal(call.body.system, 'sys');
    assert.equal(call.body.temperature, 0);
    assert.equal(call.body.max_tokens, 1024);
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(result, { text: '{"verdict":"pass"}', usage: { input_tokens: 10, output_tokens: 5 }, stopReason: 'end_turn' });
  });
  test('should join several text parts and ignore non-text parts', async () => {
    const fetch = fakeFetch([response(200, { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] })]);
    const result = await callAnthropic({ fetch, apiKey: 'k', model: 'm', system: 's', prompt: 'p' });
    assert.equal(result.text, 'a\nb');
  });
  test('should throw without leaking the key on 401, on other errors with the API message, and on empty content', async () => {
    await assert.rejects(callAnthropic({ fetch: fakeFetch([response(401, { error: { message: 'invalid x-api-key' } })]), apiKey: 'sk-ant-secret', model: 'm', system: 's', prompt: 'p' }), (error) => {
      assert.equal(error.message, 'Anthropic: the API key was rejected (HTTP 401)');
      return true;
    });
    await assert.rejects(callAnthropic({ fetch: fakeFetch([response(529, { error: { message: 'Overloaded' } })]), apiKey: 'k', model: 'm', system: 's', prompt: 'p' }), /Anthropic: HTTP 529: Overloaded/);
    await assert.rejects(callAnthropic({ fetch: fakeFetch([response(200, { content: [] })]), apiKey: 'k', model: 'm', system: 's', prompt: 'p' }), /the response had no text content/);
  });
});
