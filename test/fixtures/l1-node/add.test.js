// A passing test suite the baseline run must pass. Gate 7 counts these cases
// and assertions, so a patch that deletes one of them is rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.js';

test('adds two positives', () => {
  assert.equal(add(1, 2), 3);
});

test('adds with zero', () => {
  assert.equal(add(5, 0), 5);
});

test('adds negatives', () => {
  assert.equal(add(-1, -1), -2);
});
