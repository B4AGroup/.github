#!/usr/bin/env node
// Entry point of the gate re-check tool. See lib.mjs and README.md ("Gate re-check tool").
// Dry-run by default; --apply writes. Exit codes: 0 ok, 1 errors during the run, 2 usage/token problem.

import { appendFile } from 'node:fs/promises';
import {
  buildStepSummary,
  createClient,
  helpText,
  parseArgs,
  resolveToken,
  runExemptLabel,
  runRecheck,
} from './lib.mjs';

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${helpText()}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(parsed.text);
    return 0;
  }
  const { options } = parsed;

  const { token, source } = resolveToken(process.env);
  if (!token) {
    process.stderr.write('No token found. Set GATE_RECHECK_TOKEN (preferred), GH_TOKEN or GITHUB_TOKEN.\n');
    return 2;
  }
  log(`Token source: ${source}${options.apply ? '' : ' (dry-run: only reads)'}`);

  const client = createClient({ token, apiUrl: process.env.GITHUB_API_URL || undefined, log });
  const summary = options.mode === 'exempt-label'
    ? await runExemptLabel(options, { client, log })
    : await runRecheck(options, { client, log });

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, buildStepSummary(summary), 'utf8');
  }
  if (!options.apply) log('Dry-run: nothing was written. Re-run with --apply to perform the actions above.');
  return summary.errors.length > 0 ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`gate-recheck crashed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  },
);
