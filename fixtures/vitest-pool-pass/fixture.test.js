import assert from 'node:assert/strict';
import { test } from 'node:test';

test('fixture runs under the expected Node major', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 20);
});
