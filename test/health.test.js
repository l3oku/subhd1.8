import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSourceBlocked,
  noteSourceFailure,
  noteSourceSuccess,
  resetSourceHealth,
  sourcesHealth,
} from '../src/health.js';

test('一个来源连着失败两次后被冷落，冷却结束自动放回来', async () => {
  resetSourceHealth();
  assert.equal(isSourceBlocked('thunder'), false);

  noteSourceFailure('thunder', new Error('connect timeout'));
  // 第一次失败还给它机会
  assert.equal(isSourceBlocked('thunder'), false);

  noteSourceFailure('thunder', new Error('connect timeout'));
  assert.equal(isSourceBlocked('thunder'), true);
  assert.match(sourcesHealth().thunder.lastError, /timeout/);
  assert.ok(sourcesHealth().thunder.blockedForMs > 0);

  // 成功一次就清零
  noteSourceSuccess('thunder');
  assert.equal(isSourceBlocked('thunder'), false);
  assert.equal(sourcesHealth().thunder.failures, 0);
});

test('来源之间互不影响', () => {
  resetSourceHealth();
  noteSourceFailure('assrt', new Error('x'));
  noteSourceFailure('assrt', new Error('x'));
  assert.equal(isSourceBlocked('assrt'), true);
  assert.equal(isSourceBlocked('thunder'), false);
  assert.equal(isSourceBlocked('subhd'), false);
  resetSourceHealth();
});
