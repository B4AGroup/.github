// PR intent reviewer: orchestration. Produces a result object that run.mjs turns
// into a sticky comment, a job summary and a JSON artifact. Never throws for an
// upstream problem: missing configuration or an API error becomes
// { status: 'skipped', reason }.

import {
  DEFAULT_MAX_DIFF_CHARS,
  DEFAULT_MAX_FILE_CHARS,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  buildBrainQueries,
  buildDiff,
  buildPrompt,
  decideSkip,
  extractLinearId,
  findMissingConfig,
  mergeBrainHits,
  parseVerdict,
  parseWhatAndWhy,
} from './lib.mjs';
import { callAnthropic, fetchLinearIssue, fetchPrFiles, searchBrain } from './clients.mjs';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function describePr(event, env = {}) {
  const pr = event?.pull_request ?? {};
  return {
    repo: pr.base?.repo?.full_name ?? env.GITHUB_REPOSITORY ?? 'unknown',
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    branch: pr.head?.ref ?? '',
    baseBranch: pr.base?.ref ?? '',
    headSha: pr.head?.sha ?? '',
    action: event?.action ?? null,
  };
}

/**
 * Runs the review. Returns a result object with status 'reviewed' | 'skipped'.
 * `clients` can be overridden in tests; by default the real HTTP clients run
 * through the provided `fetch`.
 */
export async function runReview({ event, env = {}, fetch = globalThis.fetch, now = () => Date.now(), clients = {} }) {
  const started = now();
  const io = {
    fetchLinearIssue: clients.fetchLinearIssue ?? fetchLinearIssue,
    searchBrain: clients.searchBrain ?? searchBrain,
    fetchPrFiles: clients.fetchPrFiles ?? fetchPrFiles,
    callAnthropic: clients.callAnthropic ?? callAnthropic,
  };
  const model = String(env.MODEL ?? '').trim() || DEFAULT_MODEL;
  const base = { pr: describePr(event, env), model, notes: [] };
  base.headSha = base.pr.headSha;
  const finish = (extra) => ({ ...base, ...extra, durationMs: now() - started });

  if (!event?.pull_request) {
    return finish({ status: 'skipped', reason: 'no pull_request in the event payload (this workflow must be called from a pull_request event)' });
  }
  // Bot and brain-repo skips are silent: summary + artifact only, no PR comment.
  const skip = decideSkip(event.pull_request);
  if (skip.skip) return finish({ status: 'skipped', reason: skip.reason, silent: true });

  const missing = findMissingConfig(env);
  if (missing) return finish({ status: 'skipped', reason: missing });

  const whatAndWhy = parseWhatAndWhy(base.pr.body);
  base.whatAndWhy = whatAndWhy;
  if (!whatAndWhy.found) {
    base.notes.push('The PR description has no "## What and Why" section (nor a filled "## Summary"). Add one so the intent can be judged.');
  } else if (whatAndWhy.source === 'summary') {
    base.notes.push('No "## What and Why" heading found; the "## Summary" section was used instead.');
  }

  const linearId = extractLinearId(base.pr.branch, base.pr.title);
  base.linearId = linearId;
  let linearIssue = null;
  if (!linearId) {
    base.notes.push('No Linear ID (B4A-<number>) in the branch name or PR title; ticket match not evaluated.');
  } else {
    try {
      linearIssue = await io.fetchLinearIssue({ fetch, apiKey: env.LINEAR_API_KEY, id: linearId });
    } catch (error) {
      return finish({ status: 'skipped', reason: error?.message ?? String(error) });
    }
    if (!linearIssue) base.notes.push(`Linear issue ${linearId} was not found or is not readable by the configured key.`);
  }
  base.linearIssue = linearIssue;

  const brainQueries = buildBrainQueries({ repo: base.pr.repo, title: base.pr.title, linearIssue, whatAndWhy });
  base.brainQueries = brainQueries;
  let brainHits = [];
  if (brainQueries.length > 0) {
    try {
      const results = await io.searchBrain({
        fetch,
        url: env.B4A_MCP_URL,
        token: env.B4A_MCP_TOKEN,
        queries: brainQueries,
        k: 5,
        folder: String(env.BRAIN_FOLDER ?? '').trim() || undefined,
      });
      brainHits = mergeBrainHits(results, 10);
    } catch (error) {
      return finish({ status: 'skipped', reason: error?.message ?? String(error) });
    }
  }
  base.brainHits = brainHits;

  let files;
  try {
    files = await io.fetchPrFiles({ fetch, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, repo: base.pr.repo, number: base.pr.number });
  } catch (error) {
    return finish({ status: 'skipped', reason: error?.message ?? String(error) });
  }
  const { text: diff, stats: diffStats } = buildDiff(files, {
    maxChars: positiveInt(env.MAX_DIFF_CHARS, DEFAULT_MAX_DIFF_CHARS),
    maxFileChars: positiveInt(env.MAX_FILE_CHARS, DEFAULT_MAX_FILE_CHARS),
  });
  base.diffStats = diffStats;
  if (diffStats.truncated) base.notes.push('The diff was truncated to fit the model budget; large files were cut or omitted.');

  const prompt = buildPrompt({ pr: base.pr, whatAndWhy, linearId, linearIssue, brainHits, diff, diffStats });
  let answer;
  try {
    answer = await io.callAnthropic({ fetch, apiKey: env.ANTHROPIC_API_KEY, model, system: SYSTEM_PROMPT, prompt });
  } catch (error) {
    return finish({ status: 'skipped', reason: error?.message ?? String(error) });
  }
  base.modelRaw = answer.text;
  base.usage = answer.usage;

  const parsed = parseVerdict(answer.text);
  if (!parsed.ok) return finish({ status: 'skipped', reason: `Anthropic: ${parsed.problem}` });

  return finish({ status: 'reviewed', verdict: parsed.verdict });
}
