import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, parseBudgetFlag } from './budget.js';

test('a call is allowed only if its worst case fits what is left', () => {
  const b = new Budget(1);
  assert.ok(b.allows(1));
  b.record(0.7);
  assert.ok(b.allows(0.3));
  assert.ok(!b.allows(0.31));
});

test('zero budget allows only free calls', () => {
  const b = new Budget(0);
  assert.ok(b.allows(0));
  assert.ok(!b.allows(0.001));
});

test('negative or non-numeric budgets are refused', () => {
  assert.throws(() => new Budget(-1));
  assert.throws(() => parseBudgetFlag(['--budget', 'lots'], 5), /--budget/);
  assert.equal(parseBudgetFlag([], 5), 5);
  assert.equal(parseBudgetFlag(['--budget', '2.5'], 5), 2.5);
});
