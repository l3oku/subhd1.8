import assert from 'node:assert/strict';
import test from 'node:test';

import { TtlCache } from '../src/cache.js';

test('TtlCache stores, expires and deletes entries', async () => {
  const cache = new TtlCache({ ttlMs: 20 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cache.get('a'), undefined);
});

test('TtlCache deduplicates in flight producers', async () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  let calls = 0;
  const producer = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'value';
  };

  const [first, second] = await Promise.all([
    cache.wrap('key', producer),
    cache.wrap('key', producer),
  ]);

  assert.equal(first, 'value');
  assert.equal(second, 'value');
  assert.equal(calls, 1);
});

test('TtlCache evicts by byte budget', () => {
  const cache = new TtlCache({
    ttlMs: 1000,
    maxBytes: 100,
    sizeOf: (value) => value.length,
  });

  cache.set('a', Buffer.alloc(60));
  cache.set('b', Buffer.alloc(60));

  assert.equal(cache.get('a'), undefined);
  assert.ok(cache.get('b'));
  assert.ok(cache.bytes <= 100);
});
