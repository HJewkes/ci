import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateResults,
  parseJobIds,
  parseList,
  parseNeeds,
  run,
  workflowPathFromRef,
} from './all-green.mjs';

const ok = { result: 'success', outputs: {} };
const skipped = { result: 'skipped', outputs: {} };

const workflow = `name: CI
on:
  pull_request:
jobs:
  # the fast gate
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          jobs:
          echo "not a job"

  "repo-dag":
    runs-on: ubuntu-latest
  check:
    if: always()
    needs: [verify, repo-dag]
    runs-on: ubuntu-latest
`;

function runWith({ needs, workflowText = workflow, ...env }) {
  const baseEnv = {
    NEEDS_JSON: JSON.stringify(needs),
    GITHUB_JOB: 'check',
    GITHUB_WORKFLOW_REF: 'HJewkes/demo/.github/workflows/ci.yml@refs/pull/7/merge',
    WORKFLOW_ROOT: '/src',
  };
  const reads = [];
  const problems = run({ ...baseEnv, ...env }, (file) => {
    reads.push(file);
    return workflowText;
  });
  return { problems, reads };
}

describe('result evaluation', () => {
  test('passes when every needed job succeeded', () => {
    assert.deepEqual(evaluateResults({ a: ok, b: ok }, []), []);
  });

  test('fails on failure, cancelled and unknown results', () => {
    const needs = { a: { result: 'failure' }, b: { result: 'cancelled' }, c: {} };
    assert.equal(evaluateResults(needs, []).length, 3);
  });

  test('fails on a skipped job that is not allowed to skip', () => {
    assert.deepEqual(evaluateResults({ docs: skipped }, []), ['job "docs" concluded "skipped"']);
  });

  test('passes on a skipped job listed in allow-skipped', () => {
    assert.deepEqual(evaluateResults({ docs: skipped, verify: ok }, ['docs']), []);
  });

  test('allow-skipped never excuses a failure', () => {
    assert.equal(evaluateResults({ docs: { result: 'failure' } }, ['docs']).length, 1);
  });

  test('fails when allow-skipped names a job outside needs, so typos surface', () => {
    assert.match(evaluateResults({ docs: skipped }, ['dcos', 'docs'])[0], /"dcos", which is not in needs/);
  });

  test('fails when needs is empty', () => {
    assert.match(evaluateResults({}, [])[0], /needs is empty/);
  });
});

describe('input parsing', () => {
  test('allow-skipped accepts commas, spaces and newlines', () => {
    assert.deepEqual(parseList(' docs, visual\nrepo-x '), ['docs', 'visual', 'repo-x']);
  });

  test('rejects needs that is not a JSON object', () => {
    assert.throws(() => parseNeeds('not json'), /not JSON/);
    assert.throws(() => parseNeeds('["a"]'), /JSON object/);
  });

  test('derives the workflow path from GITHUB_WORKFLOW_REF', () => {
    const ref = 'HJewkes/ci/.github/workflows/ci.yml@refs/heads/main';
    assert.equal(workflowPathFromRef(ref), '.github/workflows/ci.yml');
  });

  test('rejects a missing GITHUB_WORKFLOW_REF', () => {
    assert.throws(() => workflowPathFromRef(undefined), /cannot derive the workflow file/);
  });
});

describe('job id parsing', () => {
  test('reads top-level job ids and ignores nested keys, comments and block scalars', () => {
    assert.deepEqual(parseJobIds(workflow), ['verify', 'repo-dag', 'check']);
  });

  test('stops at the next top-level key', () => {
    assert.deepEqual(parseJobIds('jobs:\n  a:\n    x: 1\nenv:\n  B: 2\n'), ['a']);
  });

  test('fails on flow-style jobs rather than guessing', () => {
    assert.throws(() => parseJobIds('jobs: { a: { runs-on: x } }\n'), /no top-level block-style/);
  });

  test('fails on a line it cannot read as a job id', () => {
    assert.throws(() => parseJobIds('jobs:\n  - a\n'), /cannot read job id/);
  });

  test('this repo\'s own check job covers every other job in ci.yml', () => {
    const text = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const { problems } = runWith({ needs: { verify: ok, compat: ok }, workflowText: text });
    assert.deepEqual(problems, []);
  });
});

describe('needs self-check', () => {
  test('passes when needs names every other job', () => {
    const { problems, reads } = runWith({ needs: { verify: ok, 'repo-dag': ok } });
    assert.deepEqual(problems, []);
    assert.deepEqual(reads, [join('/src', '.github/workflows/ci.yml')]);
  });

  test('fails when a job in the workflow is missing from needs', () => {
    const { problems } = runWith({ needs: { verify: ok } });
    assert.deepEqual(problems, [
      'job "repo-dag" in .github/workflows/ci.yml is missing from check.needs, so it gates nothing',
    ]);
  });

  test('fails when the calling job is not in the workflow file it read', () => {
    const { problems } = runWith({ needs: { verify: ok, 'repo-dag': ok }, GITHUB_JOB: 'gate' });
    assert.match(problems[0], /job "gate" is not in .github\/workflows\/ci.yml/);
  });

  test('workflow-file overrides GITHUB_WORKFLOW_REF', () => {
    const { reads } = runWith({ needs: { verify: ok, 'repo-dag': ok }, WORKFLOW_FILE: '.github/workflows/std.yml' });
    assert.deepEqual(reads, [join('/src', '.github/workflows/std.yml')]);
  });

  test('reports result failures and uncovered jobs together', () => {
    const { problems } = runWith({ needs: { verify: { result: 'failure' } } });
    assert.equal(problems.length, 2);
  });
});
