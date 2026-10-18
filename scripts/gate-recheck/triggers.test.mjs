// Guards the contract the re-check tool depends on: both ruleset required
// workflows must trigger on the same pull_request types, and those types must
// include labeled/unlabeled (what the tool fires) and every type the What and
// Why comment sync handles.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMENT_ACTIONS } from '../what-and-why/lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED_TYPES = ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled'];

async function pullRequestTypes(workflowFile) {
  const text = await readFile(join(ROOT, '.github', 'workflows', workflowFile), 'utf8');
  const match = text.match(/^on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[([^\]]+)\]/m);
  assert.ok(match, `${workflowFile} has no "on.pull_request.types" list`);
  return match[1].split(',').map((item) => item.trim()).filter(Boolean).sort();
}

describe('required workflow triggers', () => {
  test('should trigger brain-context.yml and what-and-why.yml on the same pull_request types', async () => {
    const [brain, whatAndWhy] = await Promise.all([pullRequestTypes('brain-context.yml'), pullRequestTypes('what-and-why.yml')]);
    assert.deepEqual(brain, whatAndWhy);
  });

  test('should include every type the re-check tool and the author alert rely on', async () => {
    const types = await pullRequestTypes('brain-context.yml');
    assert.deepEqual(types, [...REQUIRED_TYPES].sort());
    assert.deepEqual([...COMMENT_ACTIONS].sort(), types);
  });
});
