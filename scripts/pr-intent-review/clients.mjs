// PR intent reviewer: HTTP clients. Every function takes `fetch` so it can be
// unit-tested without the network. Errors are thrown as ApiError and turned into
// a "skipped: <reason>" outcome by review.mjs; secrets are never included in
// messages.

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const USER_AGENT = 'b4a-pr-intent-review';
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(service, message, { status } = {}) {
    super(`${service}: ${message}`);
    this.name = 'ApiError';
    this.service = service;
    this.status = status;
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 500) };
  }
}

async function request(fetch, service, url, init, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, { ...init, signal: controller?.signal });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : (error?.message ?? String(error));
    throw new ApiError(service, `request failed (${reason})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const LINEAR_ISSUE_QUERY = `query PrIntentReview($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    state { name }
    project { name }
    labels { nodes { name } }
    parent { identifier title description url }
  }
}`;

function linearAuthHeader(apiKey) {
  // Personal API keys are sent raw; OAuth access tokens need the Bearer scheme.
  return apiKey.startsWith('lin_oauth_') ? `Bearer ${apiKey}` : apiKey;
}

/**
 * Fetches a Linear issue (and its parent) by identifier. Read-only.
 * Returns null when the issue does not exist or is not visible to the key.
 */
export async function fetchLinearIssue({ fetch, apiKey, id, apiUrl = LINEAR_API_URL, timeoutMs }) {
  const res = await request(fetch, 'Linear', apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: linearAuthHeader(apiKey),
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query: LINEAR_ISSUE_QUERY, variables: { id } }),
  }, { timeoutMs });

  const payload = await readJson(res);
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('Linear', `the API key was rejected (HTTP ${res.status})`, { status: res.status });
  }
  if (res.status !== 200) {
    throw new ApiError('Linear', `unexpected HTTP ${res.status}`, { status: res.status });
  }
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (errors.length > 0) {
    const messages = errors.map((error) => String(error?.message ?? '')).join('; ');
    if (/not found|could not find|no such/i.test(messages)) return null;
    throw new ApiError('Linear', `GraphQL error: ${messages.slice(0, 200)}`);
  }
  const issue = payload?.data?.issue;
  if (!issue) return null;
  return {
    identifier: issue.identifier,
    title: issue.title ?? '',
    description: issue.description ?? '',
    url: issue.url ?? null,
    state: issue.state?.name ?? null,
    project: issue.project?.name ?? null,
    labels: (issue.labels?.nodes ?? []).map((label) => label?.name).filter(Boolean),
    parent: issue.parent
      ? {
          identifier: issue.parent.identifier,
          title: issue.parent.title ?? '',
          description: issue.parent.description ?? '',
          url: issue.parent.url ?? null,
        }
      : null,
  };
}

function mcpHeaders(token, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

/** Parses a Streamable HTTP response body: plain JSON or an SSE stream with JSON `data:` lines. */
export function parseMcpBody(text, contentType = '') {
  const body = String(text ?? '').trim();
  if (!body) return null;
  if (!/text\/event-stream/i.test(contentType) && !body.startsWith('event:') && !body.startsWith('data:')) {
    return JSON.parse(body);
  }
  let last = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      last = JSON.parse(data);
    } catch {
      // ignore non-JSON SSE frames
    }
  }
  return last;
}

async function mcpPost({ fetch, url, token, sessionId, body, timeoutMs }) {
  const res = await request(fetch, 'B4A MCP gateway', url, {
    method: 'POST',
    headers: mcpHeaders(token, sessionId),
    body: JSON.stringify(body),
  }, { timeoutMs });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('B4A MCP gateway', `the token was rejected (HTTP ${res.status})`, { status: res.status });
  }
  if (res.status >= 400) {
    throw new ApiError('B4A MCP gateway', `unexpected HTTP ${res.status}`, { status: res.status });
  }
  let payload = null;
  try {
    payload = parseMcpBody(text, res.headers?.get?.('content-type') ?? '');
  } catch {
    throw new ApiError('B4A MCP gateway', 'the response was not valid JSON');
  }
  if (payload?.error) {
    throw new ApiError('B4A MCP gateway', `JSON-RPC error ${payload.error.code ?? ''}: ${String(payload.error.message ?? '').slice(0, 200)}`);
  }
  return { payload, sessionId: res.headers?.get?.('mcp-session-id') ?? sessionId ?? null };
}

/** Extracts the brain.search result object from a tools/call response. */
export function parseBrainSearchResult(payload) {
  const result = payload?.result;
  if (!result) return { hits: [] };
  if (result.isError) {
    const text = (result.content ?? []).map((part) => part?.text ?? '').join(' ').slice(0, 200);
    throw new ApiError('B4A MCP gateway', `brain.search returned an error: ${text}`);
  }
  if (result.structuredContent && Array.isArray(result.structuredContent.hits)) return result.structuredContent;
  for (const part of result.content ?? []) {
    if (part?.type !== 'text') continue;
    try {
      const parsed = JSON.parse(part.text);
      if (parsed && Array.isArray(parsed.hits)) return parsed;
    } catch {
      // not JSON, keep looking
    }
  }
  return { hits: [] };
}

/**
 * Runs one or more brain.search queries through the B4A MCP gateway
 * (stateful Streamable HTTP: initialize -> tools/call* -> DELETE session).
 */
export async function searchBrain({ fetch, url, token, queries, k = 5, folder, timeoutMs }) {
  const init = await mcpPost({
    fetch, url, token, timeoutMs,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: USER_AGENT, version: '1.0.0' },
      },
    },
  });
  const sessionId = init.sessionId;
  if (!sessionId) throw new ApiError('B4A MCP gateway', 'initialize did not return an mcp-session-id');

  const results = [];
  try {
    await mcpPost({
      fetch, url, token, sessionId, timeoutMs,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    let id = 2;
    for (const query of queries) {
      const args = { query, k };
      if (folder) args.folder = folder;
      const { payload } = await mcpPost({
        fetch, url, token, sessionId, timeoutMs,
        body: { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'brain.search', arguments: args } },
      });
      results.push({ query, ...parseBrainSearchResult(payload) });
    }
  } finally {
    try {
      await fetch(url, { method: 'DELETE', headers: mcpHeaders(token, sessionId) });
    } catch {
      // best effort: the gateway reaps idle sessions anyway
    }
  }
  return results;
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubRequest({ fetch, token, apiUrl = DEFAULT_GITHUB_API_URL, path, method = 'GET', body, timeoutMs }) {
  const res = await request(fetch, 'GitHub', `${apiUrl}${path}`, {
    method,
    headers: { ...githubHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs });
  const payload = await readJson(res);
  if (res.status >= 400) {
    const message = payload?.message ? `: ${String(payload.message).slice(0, 160)}` : '';
    throw new ApiError('GitHub', `${method} ${path} -> HTTP ${res.status}${message}`, { status: res.status });
  }
  return payload;
}

/** Lists the PR files (with patches) — up to `maxPages` pages of 100. */
export async function fetchPrFiles({ fetch, token, apiUrl, repo, number, maxPages = 3, timeoutMs }) {
  const files = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await githubRequest({ fetch, token, apiUrl, timeoutMs, path: `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}` });
    if (!Array.isArray(batch)) break;
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

/** Creates or updates the single sticky comment. Returns 'created' | 'updated'. */
export async function upsertStickyComment({ fetch, token, apiUrl, repo, number, body, marker, timeoutMs }) {
  let existing = null;
  for (let page = 1; page <= 5 && !existing; page += 1) {
    const comments = await githubRequest({ fetch, token, apiUrl, timeoutMs, path: `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}` });
    if (!Array.isArray(comments)) break;
    existing = comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(marker)) ?? null;
    if (comments.length < 100) break;
  }
  if (existing) {
    await githubRequest({ fetch, token, apiUrl, timeoutMs, method: 'PATCH', path: `/repos/${repo}/issues/comments/${existing.id}`, body: { body } });
    return 'updated';
  }
  await githubRequest({ fetch, token, apiUrl, timeoutMs, method: 'POST', path: `/repos/${repo}/issues/${number}/comments`, body: { body } });
  return 'created';
}

/** Calls the Anthropic Messages API and returns the concatenated text answer. */
export async function callAnthropic({ fetch, apiKey, model, system, prompt, maxTokens = 1024, apiUrl = ANTHROPIC_API_URL, timeoutMs = 120_000 }) {
  const res = await request(fetch, 'Anthropic', apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { timeoutMs });

  const payload = await readJson(res);
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('Anthropic', `the API key was rejected (HTTP ${res.status})`, { status: res.status });
  }
  if (res.status !== 200) {
    const detail = payload?.error?.message ? `: ${String(payload.error.message).slice(0, 160)}` : '';
    throw new ApiError('Anthropic', `HTTP ${res.status}${detail}`, { status: res.status });
  }
  const text = (payload?.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) throw new ApiError('Anthropic', 'the response had no text content');
  return { text, usage: payload?.usage ?? null, stopReason: payload?.stop_reason ?? null };
}
