import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '@fixture/greet';

test('resolves a workspace dependency', () => {
  assert.equal(greet('app'), 'hello, app');
});
