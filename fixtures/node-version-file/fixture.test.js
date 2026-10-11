import assert from 'node:assert/strict';
import { test } from 'node:test';

test('fixture runs on the Node major named in .node-version', () => {
  assert.equal(process.versions.node.split('.')[0], '24');
});
