import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceLoaders, subtitlesHandler } from '../src/addon.js';
import { config } from '../src/config.js';
import { resetSourceHealth } from '../src/health.js';

// 补等窗口：测试里把「第一个来源回来后再等多久」放长一点，免得被桩函数的时间差吃掉
const ORIGINAL_GRACE = config.sourceLateGraceMs;

// 三个来源都是网络调用：这里把它们整个换掉，只测「合并 + 超时 + 熔断」这层逻辑。
const original = { ...sourceLoaders };
const stubThunder = (impl) => {
  sourceLoaders.thunder = impl;
};
const stubAssrt = (impl) => {
  sourceLoaders.assrt = impl;
};

test.beforeEach(() => {
  resetSourceHealth();
  config.sourceLateGraceMs = 5000;
  // SubHD 也换掉：测试机可能连不上站点，不该影响别的来源
  sourceLoaders.subhd = async () => [];
});

test.afterEach(() => {
  Object.assign(sourceLoaders, original);
  config.sourceLateGraceMs = ORIGINAL_GRACE;
});

test('三个来源串在一个列表里，各自带来源前缀', async () => {
  stubThunder(async () => [
    { id: 't1', url: 'http://x/thunder/t1.srt', label: '沙丘2', lang: '简体' },
  ]);
  stubAssrt(async () => [{ id: 'a1', url: 'http://x/assrt/a1.srt', label: '沙丘2', lang: '中英双语' }]);

  const { subtitles } = await subtitlesHandler({ type: 'movie', id: 'tt15239678' }, 'http://x');
  const tags = subtitles.map((track) => track.label.split(' · ')[0]);
  // SubHD 会在测试里真的去请求站点（离线时为空），这里只断言新来源那两条
  assert.ok(tags.includes('迅雷'));
  assert.ok(tags.includes('射手(伪)'));
  const thunderTrack = subtitles.find((track) => track.label.startsWith('迅雷'));
  assert.equal(thunderTrack.url, 'http://x/thunder/t1.srt');
  assert.match(thunderTrack.id, /^迅雷 · /);
});

test('一个来源连不上时不影响其它来源，也不会把整个列表拖住', async () => {
  stubThunder(() => new Promise(() => {})); // 永远不返回（模拟 connect timeout）
  stubAssrt(async () => [{ id: 'a1', url: 'http://x/assrt/a1.srt', label: '沙丘2', lang: '中英双语' }]);

  const started = Date.now();
  const { subtitles } = await subtitlesHandler({ type: 'movie', id: 'tt99999999' }, 'http://x');
  const elapsed = Date.now() - started;

  // 迅雷那条先不等了，射手的照样出来
  assert.ok(subtitles.some((track) => track.label.startsWith('射手(伪)')));
  assert.ok(elapsed < 15000, `整个列表应该在超时之内返回（实际 ${elapsed}ms）`);
});

test('来源连续失败后会被跳过，不再每次都等', async () => {
  let calls = 0;
  stubThunder(async () => {
    calls += 1;
    throw new Error('connect timeout');
  });
  stubAssrt(async () => []);

  await subtitlesHandler({ type: 'movie', id: 'tt11111111' }, 'http://x');
  await subtitlesHandler({ type: 'movie', id: 'tt22222222' }, 'http://x');
  const callsAfterFailures = calls;
  await subtitlesHandler({ type: 'movie', id: 'tt33333333' }, 'http://x');

  assert.ok(callsAfterFailures >= 1);
  // 被冷落之后不再调用迅雷
  assert.equal(calls, callsAfterFailures);
});
