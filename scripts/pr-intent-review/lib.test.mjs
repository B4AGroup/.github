import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_MARKER,
  DEFAULT_MAX_DIFF_CHARS,
  buildBrainQueries,
  buildDiff,
  buildPrompt,
  buildRecord,
  buildSummary,
  decideSkip,
  extractJsonObject,
  extractLinearId,
  findMissingConfig,
  findStickyComment,
  isBotAuthor,
  isGeneratedFile,
  mergeBrainHits,
  parseVerdict,
  parseWhatAndWhy,
  renderComment,
  truncateText,
} from './lib.mjs';

const FULL_ENV = {
  ANTHROPIC_API_KEY: 'a',
  LINEAR_API_KEY: 'l',
  B4A_MCP_TOKEN: 'm',
  B4A_MCP_URL: 'https://gateway.example/mcp',
  GITHUB_TOKEN: 'g',
};

function reviewedResult(overrides = {}) {
  return {
    status: 'reviewed',
    pr: { repo: 'B4AGroup/glam-frontend', number: 12, title: 'Fix checkout', author: 'dev-one', action: 'opened' },
    headSha: 'abcdef1234567890',
    model: 'claude-fable-5-1',
    linearId: 'B4A-123',
    linearIssue: { identifier: 'B4A-123' },
    whatAndWhy: { source: 'what-and-why' },
    brainQueries: ['glam-frontend Fix checkout'],
    brainHits: [{ path: 'glam/decisions.md', heading: 'Checkout', score: 0.7, url: 'https://github.com/B4AGroup/b4a-brain/blob/master/glam/decisions.md' }],
    diffStats: { files: 3, included: 2, skippedGenerated: ['package-lock.json'], truncatedFiles: [], omittedFiles: [], additions: 10, deletions: 2, truncated: false },
    verdict: {
      verdict: 'needs-attention',
      reasons: ['The diff also touches the login page, which the ticket does not mention.'],
      intent_justified: true,
      matches_ticket: true,
      fits_brain: null,
      diff_matches_intent: false,
    },
    notes: [],
    modelRaw: '{}',
    durationMs: 1200,
    ...overrides,
  };
}

describe('isBotAuthor', () => {
  test('should match dependabot and renovate logins with and without the [bot] suffix', () => {
    assert.equal(isBotAuthor('dependabot[bot]'), true);
    assert.equal(isBotAuthor('renovate'), true);
  });
  test('should not match humans, other bots or empty values', () => {
    assert.equal(isBotAuthor('dev-one'), false);
    assert.equal(isBotAuthor('github-actions[bot]'), false);
    assert.equal(isBotAuthor(''), false);
    assert.equal(isBotAuthor(null), false);
    assert.equal(isBotAuthor(undefined), false);
  });
});

describe('truncateText', () => {
  test('should return the text untouched when it fits', () => {
    assert.deepEqual(truncateText('abc', 5), { text: 'abc', truncated: false });
  });
  test('should cut and annotate when it exceeds the limit', () => {
    const result = truncateText('abcdefgh', 5);
    assert.equal(result.truncated, true);
    assert.equal(result.text, 'abcde\n…[truncated 3 chars]');
  });
  test('should treat null and undefined as empty', () => {
    assert.deepEqual(truncateText(null), { text: '', truncated: false });
    assert.deepEqual(truncateText(undefined), { text: '', truncated: false });
  });
});

describe('parseWhatAndWhy', () => {
  test('should find the What and Why section and stop at the next heading', () => {
    const result = parseWhatAndWhy('## What and Why\nWe need X because Y.\n\n## Testing\nnode --test');
    assert.deepEqual(result, { found: true, source: 'what-and-why', heading: '## What and Why', text: 'We need X because Y.' });
  });
  test('should accept "What & Why", h3 and mixed case', () => {
    assert.equal(parseWhatAndWhy('### what & WHY\ntext').text, 'text');
  });
  test('should ignore the template HTML comment', () => {
    const result = parseWhatAndWhy('## What and Why\n<!-- explain -->\n');
    assert.equal(result.found, false);
    assert.equal(result.source, 'what-and-why-empty');
  });
  test('should fall back to the Summary section when What and Why is absent', () => {
    const result = parseWhatAndWhy('## Summary\nShort reason.\n## Brain context\n- x');
    assert.equal(result.found, true);
    assert.equal(result.source, 'summary');
    assert.equal(result.text, 'Short reason.');
  });
  test('should prefer What and Why over Summary when both exist', () => {
    const result = parseWhatAndWhy('## Summary\nS\n## What and Why\nW');
    assert.equal(result.source, 'what-and-why');
    assert.equal(result.text, 'W');
  });
  test('should report missing for empty, null and undefined bodies', () => {
    for (const body of ['', null, undefined]) {
      const result = parseWhatAndWhy(body);
      assert.equal(result.found, false);
      assert.equal(result.source, 'missing');
    }
  });
  test('should handle CRLF line endings', () => {
    assert.equal(parseWhatAndWhy('## What and Why\r\nline\r\n## Next\r\n').text, 'line');
  });
});

describe('extractLinearId', () => {
  test('should take the ID from the branch name first', () => {
    assert.equal(extractLinearId('feat/b4a-123-checkout', 'B4A-999: title'), 'B4A-123');
  });
  test('should fall back to the title and normalise the prefix casing', () => {
    assert.equal(extractLinearId('feature/no-id', 'b4a-77: fix'), 'B4A-77');
  });
  test('should return null when neither has an ID', () => {
    assert.equal(extractLinearId('main', 'Fix typo'), null);
    assert.equal(extractLinearId(null, undefined), null);
  });
  test('should not match IDs glued to other letters', () => {
    assert.equal(extractLinearId('xb4a-12', 'AB4A-12'), null);
  });
});

describe('decideSkip', () => {
  test('should skip dependency bots', () => {
    const result = decideSkip({ user: { login: 'dependabot[bot]' }, base: { repo: { full_name: 'B4AGroup/x' } } });
    assert.equal(result.skip, true);
    assert.match(result.reason, /dependency bot/);
  });
  test('should skip PRs targeting b4a-brain in any casing', () => {
    const result = decideSkip({ user: { login: 'dev' }, base: { repo: { full_name: 'b4agroup/B4A-BRAIN' } } });
    assert.equal(result.skip, true);
    assert.match(result.reason, /b4a-brain itself/);
  });
  test('should not skip a human PR on another repo', () => {
    assert.deepEqual(decideSkip({ user: { login: 'dev' }, base: { repo: { full_name: 'B4AGroup/glam-frontend' } } }), { skip: false });
  });
  test('should not skip when the payload lacks user or base', () => {
    assert.deepEqual(decideSkip({}), { skip: false });
    assert.deepEqual(decideSkip(null), { skip: false });
  });
});

describe('findMissingConfig', () => {
  test('should return null when everything is set', () => {
    assert.equal(findMissingConfig(FULL_ENV), null);
  });
  test('should name the first missing secret', () => {
    assert.equal(findMissingConfig({ ...FULL_ENV, ANTHROPIC_API_KEY: '' }), 'secret ANTHROPIC_API_KEY is not configured');
    assert.equal(findMissingConfig({ ...FULL_ENV, LINEAR_API_KEY: '   ' }), 'secret LINEAR_API_KEY is not configured');
    assert.equal(findMissingConfig({ ...FULL_ENV, B4A_MCP_TOKEN: undefined }), 'secret B4A_MCP_TOKEN is not configured');
  });
  test('should name the missing variable and token with their kind', () => {
    assert.equal(findMissingConfig({ ...FULL_ENV, B4A_MCP_URL: '' }), 'variable B4A_MCP_URL is not configured');
    assert.equal(findMissingConfig({ ...FULL_ENV, GITHUB_TOKEN: '' }), 'token GITHUB_TOKEN is not configured');
  });
  test('should handle a null env', () => {
    assert.equal(findMissingConfig(null), 'secret ANTHROPIC_API_KEY is not configured');
  });
});

describe('isGeneratedFile', () => {
  test('should flag lockfiles, minified bundles, binaries and build folders', () => {
    for (const name of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'app.min.js', 'logo.png', 'dist/index.js', 'x.snap', 'go.sum']) {
      assert.equal(isGeneratedFile(name), true, name);
    }
  });
  test('should not flag source files', () => {
    for (const name of ['src/index.ts', 'package.json', 'README.md', 'lockfile-notes.md', 'distribution.ts']) {
      assert.equal(isGeneratedFile(name), false, name);
    }
  });
});

describe('buildDiff', () => {
  const file = (filename, patch, extra = {}) => ({ filename, patch, status: 'modified', additions: 1, deletions: 1, ...extra });

  test('should include source files with a header and count additions and deletions', () => {
    const { text, stats } = buildDiff([file('src/a.ts', '+a', { additions: 3, deletions: 2 })]);
    assert.match(text, /^diff --git a\/src\/a\.ts b\/src\/a\.ts\n--- modified \(\+3 -2\)\n\+a\n$/);
    assert.equal(stats.included, 1);
    assert.equal(stats.files, 1);
    assert.equal(stats.additions, 3);
    assert.equal(stats.deletions, 2);
    assert.equal(stats.truncated, false);
  });
  test('should skip generated files but still count them', () => {
    const { text, stats } = buildDiff([file('package-lock.json', '+lock'), file('src/a.ts', '+a')]);
    assert.doesNotMatch(text, /lock/);
    assert.deepEqual(stats.skippedGenerated, ['package-lock.json']);
    assert.equal(stats.files, 2);
    assert.equal(stats.included, 1);
  });
  test('should truncate a single file above the per-file cap', () => {
    const { text, stats } = buildDiff([file('src/big.ts', 'x'.repeat(100))], { maxFileChars: 10 });
    assert.match(text, /x{10}\n…\[file truncated, 90 more chars\]/);
    assert.deepEqual(stats.truncatedFiles, ['src/big.ts']);
    assert.equal(stats.truncated, true);
  });
  test('should omit files once the total budget is used up', () => {
    const files = [file('src/a.ts', 'a'.repeat(50)), file('src/b.ts', 'b'.repeat(50)), file('src/c.ts', 'c')];
    const { stats } = buildDiff(files, { maxChars: 200, maxFileChars: 1000 });
    assert.equal(stats.included, 2);
    assert.ok(stats.truncatedFiles.includes('src/b.ts'));
    assert.deepEqual(stats.omittedFiles, ['src/c.ts']);
    assert.equal(stats.truncated, true);
  });
  test('should handle files without a textual patch', () => {
    const { text } = buildDiff([file('src/a.bin', undefined)]);
    assert.match(text, /\(no textual patch available\)/);
  });
  test('should handle empty, null and undefined inputs', () => {
    for (const input of [[], null, undefined]) {
      const { text, stats } = buildDiff(input);
      assert.equal(text, '');
      assert.equal(stats.files, 0);
    }
  });
  test('should use the default budget constant', () => {
    assert.equal(DEFAULT_MAX_DIFF_CHARS, 60000);
  });
});

describe('buildBrainQueries', () => {
  test('should build repo+title, ticket title and the first sentence of the intent', () => {
    const queries = buildBrainQueries({
      repo: 'B4AGroup/glam-frontend',
      title: 'Fix checkout coupon',
      linearIssue: { title: 'Coupon not applied on checkout' },
      whatAndWhy: { text: 'Customers lose the coupon when paying with PIX. We now keep it.' },
    });
    assert.deepEqual(queries, [
      'glam-frontend Fix checkout coupon',
      'Coupon not applied on checkout',
      'Customers lose the coupon when paying with PIX',
    ]);
  });
  test('should deduplicate and drop short queries', () => {
    const queries = buildBrainQueries({ repo: 'x/y', title: 'Fix', linearIssue: { title: 'y fix' }, whatAndWhy: { text: '' } });
    assert.deepEqual(queries, ['y Fix']);
  });
  test('should return an empty list when nothing usable is known', () => {
    assert.deepEqual(buildBrainQueries({ repo: '', title: '', linearIssue: null, whatAndWhy: null }), []);
  });
  test('should cap each query at 200 characters', () => {
    const queries = buildBrainQueries({ repo: 'a/b', title: 't'.repeat(500), linearIssue: null, whatAndWhy: null });
    assert.equal(queries[0].length, 200);
  });
});

describe('mergeBrainHits', () => {
  test('should deduplicate by path and heading keeping the best score, sorted descending', () => {
    const hits = mergeBrainHits([
      { hits: [{ path: 'a.md', heading: 'h', score: 0.4, snippet: 's', url: 'u' }, { path: 'b.md', heading: 'h', score: 0.9, snippet: 's', url: 'u' }] },
      { hits: [{ path: 'a.md', heading: 'h', score: 0.6, snippet: 's2', url: 'u' }] },
    ]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].path, 'b.md');
    assert.equal(hits[1].score, 0.6);
    assert.equal(hits[1].snippet, 's2');
  });
  test('should respect the limit and tolerate empty results', () => {
    const many = { hits: Array.from({ length: 15 }, (_, index) => ({ path: `${index}.md`, heading: 'h', score: index })) };
    assert.equal(mergeBrainHits([many], 10).length, 10);
    assert.deepEqual(mergeBrainHits([]), []);
    assert.deepEqual(mergeBrainHits(null), []);
    assert.deepEqual(mergeBrainHits([{ hits: null }, null]), []);
  });
});

describe('buildPrompt', () => {
  const pr = { repo: 'B4AGroup/glam-frontend', number: 1, title: 'T', branch: 'b', baseBranch: 'main', author: 'dev' };
  const stats = { files: 1, additions: 1, deletions: 0, skippedGenerated: [], truncatedFiles: [], omittedFiles: [] };

  test('should mark a missing What and Why and a missing ticket', () => {
    const prompt = buildPrompt({ pr, whatAndWhy: { found: false }, linearId: null, linearIssue: null, brainHits: [], diff: '', diffStats: stats });
    assert.match(prompt, /\(missing: the PR description has no "## What and Why" section\)/);
    assert.match(prompt, /no B4A-<number> found/);
    assert.match(prompt, /\(no hits\)/);
    assert.match(prompt, /\(empty diff\)/);
  });
  test('should include the ticket, its parent, the brain hits and the diff stats', () => {
    const prompt = buildPrompt({
      pr,
      whatAndWhy: { found: true, heading: '## What and Why', text: 'Because.' },
      linearId: 'B4A-5',
      linearIssue: { identifier: 'B4A-5', title: 'Child', description: 'd', state: 'In Progress', project: 'P', labels: ['Bug'], parent: { identifier: 'B4A-4', title: 'Parent', description: 'pd' } },
      brainHits: [{ path: 'p.md', heading: 'H', snippet: 'snip', score: 0.55 }],
      diff: 'diff --git a/x b/x',
      diffStats: { ...stats, truncatedFiles: ['x'], skippedGenerated: ['yarn.lock'] },
    });
    assert.match(prompt, /B4A-5: Child/);
    assert.match(prompt, /State: In Progress/);
    assert.match(prompt, /Labels: Bug/);
    assert.match(prompt, /Parent B4A-4: Parent\npd/);
    assert.match(prompt, /1\. \[p\.md — H\] \(score 0\.55\)\nsnip/);
    assert.match(prompt, /generated files skipped: yarn\.lock; truncated: x/);
    assert.match(prompt, /diff --git a\/x b\/x/);
  });
  test('should say when the ticket ID exists but the issue was not found', () => {
    const prompt = buildPrompt({ pr, whatAndWhy: { found: false }, linearId: 'B4A-9', linearIssue: null, brainHits: [], diff: '', diffStats: stats });
    assert.match(prompt, /B4A-9 \(not found in Linear or not readable\)/);
  });
});

describe('extractJsonObject', () => {
  test('should parse plain JSON', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });
  test('should strip code fences', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  });
  test('should find the object inside surrounding prose', () => {
    assert.deepEqual(extractJsonObject('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  });
  test('should return null for non-JSON, empty and null input', () => {
    assert.equal(extractJsonObject('nope'), null);
    assert.equal(extractJsonObject(''), null);
    assert.equal(extractJsonObject(null), null);
    assert.equal(extractJsonObject('{broken'), null);
  });
});

describe('parseVerdict', () => {
  test('should accept a well-formed answer', () => {
    const result = parseVerdict('{"verdict":"pass","reasons":["ok"],"intent_justified":true,"matches_ticket":true,"fits_brain":null,"diff_matches_intent":true}');
    assert.equal(result.ok, true);
    assert.deepEqual(result.verdict, { verdict: 'pass', reasons: ['ok'], intent_justified: true, matches_ticket: true, fits_brain: null, diff_matches_intent: true });
  });
  test('should normalise verdict spelling and string booleans', () => {
    const result = parseVerdict('{"verdict":"Needs Attention","reasons":"one reason","intent_justified":"yes","matches_ticket":"unknown","fits_brain":"no","diff_matches_intent":"false"}');
    assert.equal(result.ok, true);
    assert.equal(result.verdict.verdict, 'needs-attention');
    assert.deepEqual(result.verdict.reasons, ['one reason']);
    assert.equal(result.verdict.intent_justified, true);
    assert.equal(result.verdict.matches_ticket, null);
    assert.equal(result.verdict.fits_brain, false);
    assert.equal(result.verdict.diff_matches_intent, false);
  });
  test('should default missing booleans (false for required, null for nullable)', () => {
    const result = parseVerdict('{"verdict":"fail","reasons":["x"]}');
    assert.equal(result.verdict.intent_justified, false);
    assert.equal(result.verdict.matches_ticket, null);
    assert.equal(result.verdict.fits_brain, null);
    assert.equal(result.verdict.diff_matches_intent, false);
  });
  test('should cap reasons at 8 and drop empty ones', () => {
    const reasons = JSON.stringify(['', ' ', ...Array.from({ length: 10 }, (_, index) => `r${index}`)]);
    const result = parseVerdict(`{"verdict":"pass","reasons":${reasons}}`);
    assert.equal(result.verdict.reasons.length, 8);
    assert.equal(result.verdict.reasons[0], 'r0');
  });
  test('should reject non-JSON, arrays, unknown verdicts and missing reasons', () => {
    assert.deepEqual(parseVerdict('nothing'), { ok: false, problem: 'the model did not return a JSON object' });
    assert.deepEqual(parseVerdict('[1]'), { ok: false, problem: 'the model did not return a JSON object' });
    assert.deepEqual(parseVerdict('{"verdict":"maybe","reasons":["x"]}'), { ok: false, problem: 'the model returned an unknown verdict "maybe"' });
    assert.deepEqual(parseVerdict('{"verdict":"pass","reasons":[]}'), { ok: false, problem: 'the model returned no reasons' });
  });
});

describe('renderComment', () => {
  test('should start with the marker and show the verdict table and reasons', () => {
    const comment = renderComment(reviewedResult());
    assert.ok(comment.startsWith(`${COMMENT_MARKER}\n### PR intent review (pilot, warn-only)`));
    assert.match(comment, /\*\*Verdict: NEEDS ATTENTION\*\*/);
    assert.match(comment, /\| Intent justified \| yes \|/);
    assert.match(comment, /\| Matches ticket B4A-123 \| yes \|/);
    assert.match(comment, /\| Fits brain \| n\/a \|/);
    assert.match(comment, /\| Diff matches intent \| \*\*no\*\* \|/);
    assert.match(comment, /- The diff also touches the login page/);
    assert.match(comment, /never blocks a merge .*model: claude-fable-5-1 · commit: abcdef1 · brain hits: 1 · diff: 2\/3 files/);
  });
  test('should render notes when present and mark truncated diffs', () => {
    const result = reviewedResult({ notes: ['note one'], diffStats: { ...reviewedResult().diffStats, truncated: true } });
    const comment = renderComment(result);
    assert.match(comment, /\*\*Notes\*\*\n- note one/);
    assert.match(comment, /\(truncated\)/);
  });
  test('should render the skipped form with the reason', () => {
    const comment = renderComment({ status: 'skipped', reason: 'secret ANTHROPIC_API_KEY is not configured', pr: {}, notes: [] });
    assert.ok(comment.startsWith(COMMENT_MARKER));
    assert.match(comment, /\*\*skipped:\*\* secret ANTHROPIC_API_KEY is not configured/);
    assert.doesNotMatch(comment, /Verdict:/);
  });
  test('should label FAIL as advisory', () => {
    const result = reviewedResult({ verdict: { ...reviewedResult().verdict, verdict: 'fail' } });
    assert.match(renderComment(result), /\*\*Verdict: FAIL \(advisory\)\*\*/);
  });
});

describe('buildSummary', () => {
  test('should include the PR line, the verdict and the brain pages consulted', () => {
    const summary = buildSummary({ ...reviewedResult(), commentOutcome: 'created' });
    assert.match(summary, /^## PR intent review — NEEDS ATTENTION\n\nPR: B4AGroup\/glam-frontend#12 by `dev-one`/);
    assert.match(summary, /### Brain pages consulted\n- \[glam\/decisions\.md — Checkout\]\(https:\/\/github\.com/);
    assert.match(summary, /Comment: created/);
    assert.doesNotMatch(summary, /pr-intent-review -->/);
  });
  test('should render the skipped form', () => {
    const summary = buildSummary({ status: 'skipped', reason: 'why', pr: { repo: 'a/b', number: 1, author: 'x' }, commentOutcome: 'not posted (403)' });
    assert.match(summary, /^## PR intent review — skipped/);
    assert.match(summary, /Reason: why/);
    assert.match(summary, /Comment: not posted \(403\)/);
  });
});

describe('findStickyComment', () => {
  test('should find the comment carrying the marker', () => {
    const comments = [{ id: 1, body: 'hello' }, { id: 2, body: `${COMMENT_MARKER}\nold` }];
    assert.equal(findStickyComment(comments).id, 2);
  });
  test('should return null when absent or on bad input', () => {
    assert.equal(findStickyComment([{ id: 1, body: 'x' }, { id: 2 }]), null);
    assert.equal(findStickyComment([]), null);
    assert.equal(findStickyComment(null), null);
  });
});

describe('buildRecord', () => {
  test('should capture the evaluation fields for a reviewed PR', () => {
    const record = buildRecord({ ...reviewedResult(), commentOutcome: 'updated' }, { now: new Date('2026-10-12T20:00:00Z') });
    assert.equal(record.schema, 1);
    assert.equal(record.recorded_at, '2026-10-12T20:00:00.000Z');
    assert.equal(record.repo, 'B4AGroup/glam-frontend');
    assert.equal(record.pr, 12);
    assert.equal(record.status, 'reviewed');
    assert.equal(record.skipped_reason, null);
    assert.equal(record.linear_id, 'B4A-123');
    assert.equal(record.linear_found, true);
    assert.deepEqual(record.brain_hits, [{ path: 'glam/decisions.md', heading: 'Checkout', score: 0.7 }]);
    assert.equal(record.verdict.verdict, 'needs-attention');
    assert.equal(record.comment_outcome, 'updated');
    assert.equal(record.duration_ms, 1200);
  });
  test('should capture a skipped outcome and distinguish no-ticket from ticket-not-found', () => {
    const skipped = buildRecord({ status: 'skipped', reason: 'r', pr: { repo: 'a/b', number: 2 }, linearId: null });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.skipped_reason, 'r');
    assert.equal(skipped.linear_found, null);
    assert.equal(skipped.verdict, null);
    const notFound = buildRecord({ status: 'reviewed', pr: {}, linearId: 'B4A-1', linearIssue: null, verdict: {} });
    assert.equal(notFound.linear_found, false);
  });
  test('should never contain secret-looking fields', () => {
    const json = JSON.stringify(buildRecord(reviewedResult()));
    assert.doesNotMatch(json, /api_key|token|authorization/i);
  });
});
