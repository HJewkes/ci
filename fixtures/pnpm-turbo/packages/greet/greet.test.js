import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from './index.js';

test('greets by name', () => {
  assert.equal(greet('ci'), 'hello, ci');
});
