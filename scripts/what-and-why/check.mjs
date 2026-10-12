#!/usr/bin/env node
// Entry point for the "What and Why" PR gate (GitHub Actions).
// Reads the pull_request event payload, runs the check, keeps the sticky
// author-alert comment in sync, writes the job summary and workflow
// annotations, and exits 1 when the section is missing.

import { readFile, appendFile } from 'node:fs/promises';
import { runCheck } from './lib.mjs';

function escapeAnnotation(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function loadEvent(env) {
  if (!env.GITHUB_EVENT_PATH) {
    throw new Error('GITHUB_EVENT_PATH is not set; run this script inside GitHub Actions.');
  }
  return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
}

async function main() {
  const env = process.env;
  const event = await loadEvent(env);
  const result = await runCheck({ event, env });

  for (const annotation of result.annotations) {
    process.stdout.write(`::${annotation.level}::${escapeAnnotation(annotation.message)}\n`);
  }
  process.stdout.write(`\n${result.summary}`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, result.summary, 'utf8');
  }
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stdout.write(`::error::What and Why gate crashed: ${escapeAnnotation(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
