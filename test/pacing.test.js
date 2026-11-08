import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacing } from '../src/pacing.js';

// 没被限流过就别加戏：间隔就是配置里那个值
test('keeps the configured interval until the site pushes back', () => {
  const pace = createPacing({ intervalMs: 1500 });
  assert.equal(pace.current(0), 1500);
  assert.equal(pace.current(60 * 60 * 1000), 1500);
});

// 被限流一次就翻倍，再被拍再翻倍，但别超过上限 —— 上限是「还能忍」和「别撞死」的折中
test('doubles the interval on each rate limit hit and stops at the ceiling', () => {
  const pace = createPacing({ intervalMs: 1500, maxIntervalMs: 10_000 });
  assert.equal(pace.hit(0), true);
  assert.equal(pace.current(0), 3000);
  pace.hit(1);
  assert.equal(pace.current(1), 6000);
  pace.hit(2);
  assert.equal(pace.current(2), 10_000);
  // 已经顶到上限了，再被拍也不变：返回 false 让调用方别再刷同一条日志
  assert.equal(pace.hit(3), false);
  assert.equal(pace.current(3), 10_000);
});

// 15 分钟（memoryMs）没再被拍就减半往回收，慢慢回到默认值，而不是一直背着惩罚
test('halves the interval back towards the base after a quiet period', () => {
  const pace = createPacing({ intervalMs: 1000, maxIntervalMs: 60_000, memoryMs: 60_000 });
  pace.hit(0);
  pace.hit(1);
  assert.equal(pace.current(1), 4000);

  // 安静期没过完：不动
  assert.equal(pace.current(30_000), 4000);
  // 过了安静期：一次只回收一半，再多等一轮才到默认值
  assert.equal(pace.current(120_000), 2000);
  assert.equal(pace.current(240_000), 1000);
  assert.equal(pace.current(360_000), 1000);
});

// 配置成 0 表示不限速：但真被限流了还是得让出点时间，否则重试等于白拍一次
test('falls back to a one second gap when the configured interval is zero', () => {
  const pace = createPacing({ intervalMs: 0 });
  assert.equal(pace.current(0), 0);
  pace.hit(0);
  assert.equal(pace.current(0), 1000);
});
