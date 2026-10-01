import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      { test: { name: 'unit', pool: 'threads' } },
      {
        test: {
          name: 'process',
          // vitest-pool: forks the tests change the process working directory
          pool: 'forks',
        },
      },
    ],
  },
});
