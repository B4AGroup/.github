#!/usr/bin/env node
// Entry point for the PR intent reviewer (GitHub Actions, warn-only pilot).
// Reads the pull_request event, runs the review, posts/updates the sticky
// comment, writes the job summary and the JSON artifact. ALWAYS exits 0.

import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runReview } from './review.mjs';
import { COMMENT_MARKER, buildRecord, buildSummary, renderComment } from './lib.mjs';
import { upsertStickyComment } from './clients.mjs';

function escapeAnnotation(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function loadEvent(env) {
  if (!env.GITHUB_EVENT_PATH) {
    throw new Error('GITHUB_EVENT_PATH is not set; run this script inside GitHub Actions.');
  }
  return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
}

async function postComment(result, env) {
  if (result.silent) return 'not posted (silent skip)';
  if (!result.pr?.number || !env.GITHUB_TOKEN) {
    return 'not posted (no pull request number or GITHUB_TOKEN)';
  }
  try {
    const outcome = await upsertStickyComment({
      fetch: globalThis.fetch,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL,
      repo: result.pr.repo,
      number: result.pr.number,
      body: renderComment(result),
      marker: COMMENT_MARKER,
    });
    return outcome;
  } catch (error) {
    // Typical cause: a PR from a fork, where GITHUB_TOKEN is read-only.
    return `not posted (${error?.message ?? error})`;
  }
}

async function writeArtifact(record, env) {
  const dir = env.ARTIFACT_DIR || 'pr-intent-review-artifact';
  await mkdir(dir, { recursive: true });
  const name = `verdict-${record.repo?.replace('/', '__') ?? 'unknown'}-pr${record.pr ?? 'x'}-${(record.head_sha || 'nosha').slice(0, 7)}.json`;
  await writeFile(join(dir, name), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return join(dir, name);
}

async function main() {
  const env = process.env;
  const event = await loadEvent(env);
  const result = await runReview({ event, env });

  result.commentOutcome = await postComment(result, env);
  const record = buildRecord(result);
  const artifactPath = await writeArtifact(record, env);
  const summary = buildSummary(result);

  if (result.status === 'skipped') {
    process.stdout.write(`::notice::PR intent review skipped: ${escapeAnnotation(result.reason)}\n`);
  } else if (result.verdict.verdict !== 'pass') {
    process.stdout.write(`::warning::PR intent review: ${result.verdict.verdict} — ${escapeAnnotation(result.verdict.reasons[0])}\n`);
  }
  process.stdout.write(`\n${summary}\nArtifact: ${artifactPath}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
  process.exitCode = 0;
}

main().catch((error) => {
  // Warn-only: even an unexpected crash must not fail the job.
  process.stdout.write(`::warning::PR intent review crashed (ignored, warn-only): ${escapeAnnotation(error?.stack ?? error)}\n`);
  process.exitCode = 0;
});
