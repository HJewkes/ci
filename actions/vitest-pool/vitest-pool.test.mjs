import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { findConfigs, hasAllowComment, mask, run } from './vitest-pool.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'vitest-pool-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const messages = (root) => run(root).problems.map(({ message }) => message);

const twoProjects = `import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    maxWorkers: 4,
    projects: [
      { test: { name: 'threads', pool: 'threads', maxWorkers: 4 } },
      {
        test: {
          name: 'forks',
          // vitest-pool: forks sets process.env.TZ, which a worker thread ignores
          pool: 'forks',
          maxWorkers: 2,
        },
      },
    ],
  },
})
`;

describe('passing shapes', () => {
  test('two projects, threads capped and forks with a reason', () => {
    assert.deepEqual(messages(repo({ 'vitest.config.ts': twoProjects })), []);
  });

  test('root poolOptions cap plus extending projects, one forks with a reason', () => {
    const root = repo({
      'vitest.config.ts': `export default defineConfig({
  test: {
    poolOptions: { threads: { minThreads: 1, maxThreads: 4 }, forks: { maxForks: 1 } },
    projects: [
      { extends: true, test: { name: 'a', pool: 'threads' } },
      {
        extends: true,
        test: {
          name: 'b',
          pool: 'forks', // vitest-pool: forks stubs HOME
        },
      },
    ],
  },
})`,
    });
    assert.deepEqual(messages(root), []);
  });

  test('workspace file takes its cap from the sibling config', () => {
    const root = repo({
      'vitest.config.ts': `export default defineConfig({ test: { poolOptions: { threads: { maxThreads: 4 } } } })`,
      'vitest.workspace.ts': `export default defineWorkspace([
  { test: { name: 'unit', pool: 'threads' } },
  // vitest-pool: forks assigns process.env.HOME
  { test: { name: 'forks', pool: 'forks' } },
])`,
    });
    assert.deepEqual(messages(root), []);
  });

  test('a root pool of vmThreads with test.maxWorkers passes', () => {
    const root = repo({ 'vitest.config.mts': `export default { test: { pool: 'vmThreads', maxWorkers: 2 } }` });
    assert.deepEqual(messages(root), []);
  });

  test('a repo with no vitest config has nothing to fail', () => {
    assert.deepEqual(run(repo({ 'package.json': '{}' })), { files: [], problems: [] });
  });
});

describe('failing shapes', () => {
  test('pool unset at the root', () => {
    const root = repo({ 'vitest.config.ts': `export default defineConfig({ test: { globals: true } })` });
    assert.match(messages(root)[0], /root: pool is unset/);
  });

  test('forks without an allow comment', () => {
    const root = repo({
      'vitest.config.ts': `export default defineConfig({
  test: {
    // runs the real thing
    pool: 'forks',
  },
})`,
    });
    assert.match(messages(root)[0], /needs a "\/\/ vitest-pool: forks <reason>" comment/);
  });

  test('an allow comment without a reason does not count', () => {
    const root = repo({ 'vitest.config.ts': `export default { test: {\n  // vitest-pool: forks\n  pool: 'forks' } }` });
    assert.equal(messages(root).length, 1);
  });

  test('threads without a cap', () => {
    const root = repo({ 'vitest.config.ts': `export default { test: { pool: 'threads' } }` });
    assert.match(messages(root)[0], /no maxThreads or maxWorkers cap/);
  });

  test('a project without pool when the root sets none', () => {
    const root = repo({
      'vitest.config.ts': `export default { test: { maxWorkers: 4, projects: [
  { test: { name: 'a', pool: 'threads' } },
  { test: { name: 'b' } },
] } }`,
    });
    const found = run(root).problems;
    assert.equal(found.length, 1);
    assert.match(found[0].message, /project at line 3: pool is unset/);
    assert.equal(found[0].line, 3);
  });

  test('a workspace file whose project leaves pool unset', () => {
    const root = repo({ 'vitest.workspace.ts': `export default defineWorkspace([{ test: { name: 'a' } }])` });
    assert.match(messages(root)[0], /pool is unset/);
  });

  test('a pool that is not a string literal', () => {
    const root = repo({ 'vitest.config.ts': `export default { test: { pool: POOL, maxWorkers: 2 } }` });
    assert.match(messages(root)[0], /not a string literal/);
  });
});

describe('helpers', () => {
  test('mask blanks comments and strings but keeps offsets', () => {
    const text = `a // pool: 'x'\n"pool:" /* pool: */ b`;
    const masked = mask(text);
    assert.equal(masked.length, text.length);
    assert.ok(!masked.includes('pool'));
  });

  test('an allow comment must sit in the unbroken comment block above', () => {
    const lines = ['// vitest-pool: forks why', 'name: "x",', 'pool: "forks",'];
    assert.equal(hasAllowComment(lines, 3), false);
    assert.equal(hasAllowComment(['// vitest-pool: forks why', '// more', 'pool: "forks",'], 3), true);
  });

  test('discovery skips node_modules and .worktrees', () => {
    const root = repo({
      'vitest.config.ts': '',
      'pkg/vitest.workspace.mts': '',
      'node_modules/dep/vitest.config.ts': '',
      '.worktrees/wt/vitest.config.ts': '',
    });
    assert.deepEqual(findConfigs(root).map((f) => f.slice(root.length + 1)), ['pkg/vitest.workspace.mts', 'vitest.config.ts']);
  });
});
