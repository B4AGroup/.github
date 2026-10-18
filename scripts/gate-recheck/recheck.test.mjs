// End-to-end tests of the CLI: spawns recheck.mjs against a local HTTP fake of
// the GitHub API (GITHUB_API_URL) and asserts the exit code, the output and
// that a dry-run performs no write at all.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'recheck.mjs');

function makeFakeApi() {
  const requests = [];
  const state = { labels: new Set() };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1800000000' });
        res.end(data === null ? '' : JSON.stringify(data));
      };
      if (req.method === 'GET' && url.pathname === '/orgs/B4AGroup/repos') {
        return send(200, [
          { name: 'api', full_name: 'B4AGroup/api', archived: false, default_branch: 'main' },
          { name: 'b4a-brain', full_name: 'B4AGroup/b4a-brain', archived: false, default_branch: 'master' },
          { name: 'old', full_name: 'B4AGroup/old', archived: true, default_branch: 'master' },
        ]);
      }
      if (req.method === 'GET' && url.pathname === '/repos/B4AGroup/api/pulls') {
        return send(200, [
          { number: 1, title: 'One', draft: false, base: { ref: 'main' }, user: { login: 'ana' }, labels: [], html_url: 'https://github.com/B4AGroup/api/pull/1' },
          { number: 2, title: 'Two', draft: true, base: { ref: 'feature/z' }, user: { login: 'ana' }, labels: [], html_url: 'https://github.com/B4AGroup/api/pull/2' },
        ]);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/repos/B4AGroup/api/labels/')) {
        const name = decodeURIComponent(url.pathname.split('/').pop());
        return state.labels.has(name) ? send(200, { name }) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'POST' && url.pathname === '/repos/B4AGroup/api/labels') {
        state.labels.add(JSON.parse(raw).name);
        return send(201, {});
      }
      if (req.method === 'POST' && url.pathname === '/repos/B4AGroup/api/issues/1/labels') return send(200, []);
      if (req.method === 'DELETE' && url.pathname === '/repos/B4AGroup/api/issues/1/labels/gate-recheck') return send(200, []);
      return send(500, { message: `unhandled ${req.method} ${url.pathname}` });
    });
  });
  return { server, requests, state };
}

async function runCli(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-recheck-'));
  const summaryPath = join(dir, 'summary.md');
  const childEnv = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryPath, ...env };
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: childEnv });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', async (code) => {
        const summary = await readFile(summaryPath, 'utf8').catch(() => '');
        resolve({ code, stdout, stderr, summary });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('recheck.mjs', () => {
  const fake = makeFakeApi();
  let apiUrl;

  before(async () => {
    await new Promise((resolve) => { fake.server.listen(0, '127.0.0.1', resolve); });
    apiUrl = `http://127.0.0.1:${fake.server.address().port}`;
  });
  after(() => { fake.server.close(); });

  test('should exit 2 with the help text when no token is available', async () => {
    const result = await runCli([], { GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /No token found\. Set GATE_RECHECK_TOKEN/);
  });

  test('should exit 2 on a usage error and print the help', async () => {
    const result = await runCli(['--mode', 'nope'], { GATE_RECHECK_TOKEN: 't', GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--mode must be one of/);
    assert.match(result.stderr, /Usage: node scripts\/gate-recheck\/recheck\.mjs/);
  });

  test('should exit 0 and print the help on --help without needing a token', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^Usage:/);
  });

  test('should dry-run by default: list the plan, write nothing, write the step summary', async () => {
    fake.requests.length = 0;
    const result = await runCli([], { GATE_RECHECK_TOKEN: 't', GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Token source: GATE_RECHECK_TOKEN \(dry-run: only reads\)/);
    assert.match(result.stdout, /B4AGroup: 3 repositories, 1 selected, 2 skipped \(b4a-brain: excluded; old: archived\)/);
    assert.match(result.stdout, /\[dry-run\] would create label "gate-recheck"/);
    assert.match(result.stdout, /\[dry-run\] #1 "One" \(base main, ready, by ana\) -> would add \+ remove "gate-recheck"/);
    assert.doesNotMatch(result.stdout, /#2 "Two"/);
    assert.match(result.stdout, /Dry-run: nothing was written\. Re-run with --apply/);
    assert.equal(fake.requests.filter((request) => request.method !== 'GET').length, 0);
    assert.match(result.summary, /^## Gate re-check — recheck \(dry-run\)/);
    assert.match(result.summary, /\[B4AGroup\/api#1\]/);
  });

  test('should write with --apply and exit 0', async () => {
    fake.requests.length = 0;
    const result = await runCli(['--apply', '--delay-ms', '0', '--settle-ms', '0'], { GH_TOKEN: 't', GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Token source: GH_TOKEN$/m);
    assert.deepEqual(fake.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path}`), [
      'POST /repos/B4AGroup/api/labels',
      'POST /repos/B4AGroup/api/issues/1/labels',
      'DELETE /repos/B4AGroup/api/issues/1/labels/gate-recheck',
    ]);
    assert.match(result.stdout, /\[apply\] #1 "One" .* -> fired labeled \+ unlabeled/);
    assert.doesNotMatch(result.stdout, /Dry-run: nothing was written/);
  });

  test('should exit 1 when a repository fails and keep the summary', async () => {
    const result = await runCli(['--repo', 'ghost'], { GATE_RECHECK_TOKEN: 't', GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /ERROR repository "ghost" not found in B4AGroup/);
    assert.match(result.summary, /### Errors/);
  });

  test('should run the exempt-label mode in dry-run and write nothing', async () => {
    fake.requests.length = 0;
    const result = await runCli(['--mode', 'exempt-label'], { GATE_RECHECK_TOKEN: 't', GITHUB_API_URL: apiUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /B4AGroup\/api: \[dry-run\] would create label "brain-context-exempt"/);
    assert.equal(fake.requests.filter((request) => request.method !== 'GET').length, 0);
    assert.match(result.summary, /^## Gate re-check — exempt-label \(dry-run\)/);
  });
});
