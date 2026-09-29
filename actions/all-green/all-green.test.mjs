import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  describeSource,
  evaluateResults,
  parseJobIds,
  parseList,
  parseNeeds,
  resolveSource,
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
    const { problems } = runWith({
      needs: {
        verify: ok,
        compat: ok,
        'repo-fixture-npm': ok,
        'repo-fixture-pnpm': ok,
        'repo-fixture-pnpm-turbo': ok,
        'repo-fixture-all-green': ok,
        'repo-fixture-release-tag': ok,
        'repo-fixture-release-changesets': ok,
      },
      workflowText: text,
    });
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

describe('workflow source resolution', () => {
  const runner = {
    GITHUB_REPOSITORY: 'HJewkes/demo',
    GITHUB_WORKFLOW_SHA: 'callersha',
    GITHUB_WORKFLOW_REF: 'HJewkes/demo/.github/workflows/ci.yml@refs/pull/7/merge',
  };
  const reusable = {
    JOB_WORKFLOW_REPOSITORY: 'HJewkes/ci',
    JOB_WORKFLOW_SHA: 'reusablesha',
    JOB_WORKFLOW_FILE_PATH: '.github/workflows/node.yml',
  };

  test('a job in a reusable workflow reads that workflow from its own repo and commit', () => {
    assert.deepEqual(resolveSource({ ...runner, ...reusable }), {
      repository: 'HJewkes/ci',
      ref: 'reusablesha',
      file: '.github/workflows/node.yml',
      origin: 'job.workflow_file_path',
    });
  });

  test('falls back to the caller when the runner does not set job.workflow_*', () => {
    assert.deepEqual(resolveSource({ ...runner, JOB_WORKFLOW_REPOSITORY: '', JOB_WORKFLOW_SHA: '' }), {
      repository: 'HJewkes/demo',
      ref: 'callersha',
      file: '.github/workflows/ci.yml',
      origin: 'GITHUB_WORKFLOW_REF',
    });
  });

  const partialSets = [
    ['JOB_WORKFLOW_FILE_PATH'],
    ['JOB_WORKFLOW_SHA'],
    ['JOB_WORKFLOW_REPOSITORY'],
    ['JOB_WORKFLOW_SHA', 'JOB_WORKFLOW_FILE_PATH'],
    ['JOB_WORKFLOW_REPOSITORY', 'JOB_WORKFLOW_FILE_PATH'],
    ['JOB_WORKFLOW_REPOSITORY', 'JOB_WORKFLOW_SHA'],
  ];
  for (const unset of partialSets) {
    test(`fails closed rather than fall back when only ${unset.join(' and ')} is unset`, () => {
      const env = { ...runner, ...reusable, ...Object.fromEntries(unset.map((name) => [name, ''])) };
      assert.throws(() => resolveSource(env), /set only some job\.workflow_\* values; missing job\.workflow_/);
    });
  }

  test('the partial-set error names each missing job.workflow_* value', () => {
    const env = { ...runner, ...reusable, JOB_WORKFLOW_SHA: '', JOB_WORKFLOW_FILE_PATH: '' };
    assert.throws(() => resolveSource(env), /missing job\.workflow_sha, job\.workflow_file_path$/);
  });

  test('the self-check fails closed too when job.workflow_file_path alone is missing', () => {
    const env = { ...reusable, JOB_WORKFLOW_FILE_PATH: '' };
    assert.throws(() => runWith({ needs: { verify: ok, 'repo-dag': ok }, ...env }), /missing job\.workflow_file_path/);
  });

  test('workflow-file overrides the path but keeps the job workflow repo and commit', () => {
    const source = resolveSource({ ...runner, ...reusable, WORKFLOW_FILE: '.github/workflows/std.yml' });
    assert.deepEqual(source, {
      repository: 'HJewkes/ci',
      ref: 'reusablesha',
      file: '.github/workflows/std.yml',
      origin: 'input workflow-file',
    });
  });

  test('fails when neither source yields a commit to check out', () => {
    assert.throws(() => resolveSource({ ...runner, GITHUB_WORKFLOW_SHA: '' }), /cannot resolve the workflow ref/);
  });

  test('fails on a value that would break the step output', () => {
    const file = '.github/workflows/a.yml\nref=main';
    assert.throws(() => resolveSource({ ...runner, WORKFLOW_FILE: file }), /cannot resolve the workflow file/);
  });

  test('the log line names the file, where the path came from, and the commit', () => {
    assert.equal(
      describeSource(resolveSource({ ...runner, ...reusable })),
      'all-green: reading .github/workflows/node.yml (from job.workflow_file_path) at HJewkes/ci@reusablesha',
    );
  });

  test('the self-check reads job.workflow_file_path, not the top-level caller', () => {
    const { reads } = runWith({ needs: { verify: ok, 'repo-dag': ok }, ...reusable });
    assert.deepEqual(reads, [join('/src', '.github/workflows/node.yml')]);
  });
});

describe('workflow path constraint', () => {
  const outsideWorkflows = /input workflow-file .* must be a relative path under \.github\/workflows\//;

  const escapes = [
    '../../etc/hosts',
    '/etc/hosts',
    '.github/workflows/../../package.json',
    '.github/workflows/..',
    '.github/workflows/sub/../ci.yml',
    '/.github/workflows/ci.yml',
    './.github/workflows/ci.yml',
    'README.md',
    '.github/actions/x.yml',
    '.github/workflows',
  ];
  for (const file of escapes) {
    test(`workflow-file "${file}" fails closed before any read`, () => {
      assert.throws(() => runWith({ needs: { verify: ok }, WORKFLOW_FILE: file }), outsideWorkflows);
    });
  }

  test('a job.workflow_file_path outside .github/workflows/ fails closed', () => {
    const env = { JOB_WORKFLOW_REPOSITORY: 'o/r', JOB_WORKFLOW_SHA: 's', JOB_WORKFLOW_FILE_PATH: '../x.yml' };
    assert.throws(() => runWith({ needs: { verify: ok }, ...env }), /job\.workflow_file_path "\.\.\/x\.yml" must be/);
  });
});
