// End-to-end tests of the entry point: spawns check.mjs with a pull_request
// event file the way GitHub Actions does and asserts the exit code, the
// annotations and the job summary. The PR comes from a fork, so the comment
// sync is skipped and no network call is made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check.mjs');
const REPO = 'B4AGroup/some-backend';
const TEMPLATE_COMMENT = '<!-- Required. What does this PR change, and why is it needed? -->';
const GOOD_TEXT = 'Adds retry to the renewal job because Pagar.me times out at night and renewals were silently lost.';
const WARN_UNTIL = '2999-01-01T00:00:00Z';
const ENFORCED_SINCE = '2020-01-01T00:00:00Z';

function body(section) {
  return `## What and Why\n${TEMPLATE_COMMENT}\n${section}\n\n## Brain context\n- none relevant: ci only change here\n`;
}

function event(prBody, action = 'opened') {
  return {
    action,
    pull_request: {
      number: 42,
      body: prBody,
      user: { login: 'dev-one', type: 'User' },
      base: { repo: { full_name: REPO } },
      head: { repo: { full_name: 'someone/some-backend', fork: true } },
    },
  };
}

async function runCheckProcess({ payload, env = {}, withEventFile = true }) {
  const dir = await mkdtemp(join(tmpdir(), 'what-and-why-'));
  const eventPath = join(dir, 'event.json');
  const summaryPath = join(dir, 'summary.md');
  if (withEventFile) await writeFile(eventPath, JSON.stringify(payload), 'utf8');
  const childEnv = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'ghs_test',
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_STEP_SUMMARY: summaryPath,
    ...(withEventFile ? { GITHUB_EVENT_PATH: eventPath } : {}),
    ...env,
  };
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CHECK], { env: childEnv });
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

describe('check.mjs — warn mode (ENFORCE_AFTER in the future)', () => {
  const env = { ENFORCE_AFTER: WARN_UNTIL };

  test('should exit 0 with a warning annotation when the section is empty', async () => {
    const result = await runCheckProcess({ payload: event(body('')), env });
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /^::warning::What and Why check would fail: The "What and Why" section is empty/m);
    assert.doesNotMatch(result.stdout, /^::error::/m);
    assert.match(result.stdout, /warning \(not blocking yet\)/);
    assert.match(result.stdout, new RegExp(`This PR would be blocked from ${WARN_UNTIL}`));
    assert.match(result.stdout, /Comment skipped: head repository `someone\/some-backend` is a fork/);
  });

  test('should exit 0 with a warning annotation when the heading is missing', async () => {
    const result = await runCheckProcess({ payload: event('## Summary\nlong enough text here'), env });
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /^::warning::What and Why check would fail: The PR description has no "## What and Why" heading/m);
  });

  test('should exit 0 with no annotation when the section is filled', async () => {
    const result = await runCheckProcess({ payload: event(body(GOOD_TEXT)), env });
    assert.equal(result.code, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /^::(warning|error)::/m);
    assert.match(result.stdout, /What and Why gate — passed/);
    assert.match(result.stdout, new RegExp(`Mode: \\*\\*warning only\\*\\* until ${WARN_UNTIL}`));
  });

  test('should write the job summary to GITHUB_STEP_SUMMARY', async () => {
    const result = await runCheckProcess({ payload: event(body('')), env });
    assert.match(result.summary, /^## What and Why gate — warning \(not blocking yet\)/);
    assert.match(result.summary, new RegExp(`PR: ${REPO}#42 by \`dev-one\``));
  });
});

describe('check.mjs — blocking mode (ENFORCE_AFTER in the past)', () => {
  const env = { ENFORCE_AFTER: ENFORCED_SINCE };

  test('should exit 1 with an error annotation when the section is empty', async () => {
    const result = await runCheckProcess({ payload: event(body('')), env });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^::error::What and Why check failed: The "What and Why" section is empty/m);
    assert.doesNotMatch(result.stdout, /would be blocked/);
    assert.match(result.stdout, /What and Why gate — failed/);
    assert.match(result.stdout, new RegExp(`Mode: \\*\\*blocking\\*\\* \\(ENFORCE_AFTER=${ENFORCED_SINCE} has passed\\)`));
  });

  test('should exit 1 with an error annotation when the heading is missing', async () => {
    const result = await runCheckProcess({ payload: event('## Summary\nlong enough text here'), env });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^::error::What and Why check failed: The PR description has no "## What and Why" heading/m);
  });

  test('should exit 0 when the section is filled', async () => {
    const result = await runCheckProcess({ payload: event(body(GOOD_TEXT)), env });
    assert.equal(result.code, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /^::(warning|error)::/m);
    assert.match(result.stdout, /What and Why gate — passed/);
  });

  test('should write the failing job summary to GITHUB_STEP_SUMMARY', async () => {
    const result = await runCheckProcess({ payload: event(body('')), env });
    assert.match(result.summary, /^## What and Why gate — failed/);
    assert.match(result.summary, /### Problems/);
  });
});

describe('check.mjs — configuration errors', () => {
  test('should exit 1 on an invalid ENFORCE_AFTER', async () => {
    const result = await runCheckProcess({ payload: event(body(GOOD_TEXT)), env: { ENFORCE_AFTER: 'next week' } });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^::error::ENFORCE_AFTER is not a valid ISO-8601 date: "next week"/m);
  });

  test('should exit 1 and report a crash when GITHUB_EVENT_PATH is missing', async () => {
    const result = await runCheckProcess({ payload: null, withEventFile: false });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^::error::What and Why gate crashed: .*GITHUB_EVENT_PATH is not set/m);
  });

  test('should exit 1 when the event has no pull_request', async () => {
    const result = await runCheckProcess({ payload: { push: {} }, env: { ENFORCE_AFTER: WARN_UNTIL } });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^::error::No pull_request in the event payload/m);
  });
});
