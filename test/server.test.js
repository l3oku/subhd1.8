import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { resolveTool } from '../src/binary.js';
import { REWRITE_PATH_PARAM, dispatch, resolvePathname } from '../src/server.js';
import { caches } from '../src/subhd.js';

let server;
let origin;

before(async () => {
  server = http.createServer((req, res) => {
    dispatch(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('serves the health endpoint', async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  // 「点了没反应」时要能从这里看出是不是站点按出口 IP 限流了
  assert.equal(body.rateLimit.cooldownMs, 0);
  assert.equal(typeof body.rateLimit.intervalMs, 'number');
});

test('serves a manifest with absolute urls', async () => {
  const response = await fetch(`${origin}/manifest.json`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.id, 'community.subhd');
  assert.equal(manifest.logo, `${origin}/assets/logo.svg`);
  assert.deepEqual(manifest.types, ['movie', 'series']);
});

test('serves the landing page', async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /manifest\.json/);
});

// 图形字幕没有文本可转：路由要把 .sup 原样发回去，别走文本解码那一条路。
test('serves an image subtitle track as raw pgs bytes', async () => {
  const sup = Buffer.concat([Buffer.from('PG'), Buffer.alloc(32, 0x07)]);
  caches.fileCache.set('file:SUPSRV', { raw: sup, filename: 'Dune.2021.sup' });

  const response = await fetch(`${origin}/sub/SUPSRV.sup`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/x-pgs');
  assert.equal(response.headers.get('x-subhd-image'), '1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), sup);
});

// 「假包」（包里只有一份网盘分享说明）没有图片字幕可发，但也不能回 415：Stremio 不显示
// 失败的响应体，用户只会觉得点了没反应。这时把说明当文本字幕发出去，链接才看得见。
test('serves the netdisk note as a text subtitle when there is no image subtitle', async () => {
  const note = Buffer.from(
    '链接: https://pan.baidu.com/s/1WM17aSh3J8fv3nK7HjOsjQ?pwd=fc9g 提取码: fc9g\n',
    'utf8',
  );
  caches.fileCache.set('file:SUPNOTE3', { raw: note, filename: '凤凰社特效字幕.txt' });

  const response = await fetch(`${origin}/sub/SUPNOTE3.sup`);
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /x-subrip/);
  assert.equal(response.headers.get('x-subhd-note'), '1');
  assert.match(await response.text(), /https:\/\/pan\.baidu\.com\/s\/1WM17aSh3J8fv3nK7HjOsjQ\?pwd=fc9g/);
});

// Vercel 对「攒好再一次性返回」的响应有 4.5MB 硬上限（413 FUNCTION_PAYLOAD_TOO_LARGE），
// 分块流出去的响应不算这个上限 —— 所以大文件这里必须是 chunked、没有 content-length。
test('streams a subtitle larger than the vercel payload limit', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
  caches.fileCache.set('file:SUPBIG', { raw: big, filename: 'Dune.2021.2160p.sup' });

  const response = await fetch(`${origin}/sub/SUPBIG.sup`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  assert.match(String(response.headers.get('transfer-encoding')), /chunked/);

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, big.length);
  assert.equal(body[0], 0x41);
});

test('streams the raw archive too', async () => {
  const pack = Buffer.alloc(5 * 1024 * 1024, 0x50);
  caches.fileCache.set('file:RAWSRV', { raw: pack, filename: 'Dune.2021.zip' });

  const response = await fetch(`${origin}/raw/RAWSRV`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  assert.match(String(response.headers.get('transfer-encoding')), /chunked/);
  assert.equal((await response.arrayBuffer()).byteLength, pack.length);
});

// 带特效的 ASS 也能长到几 MB，同样是「攒着发就 413」的那一类
test('streams a text subtitle that grew past the payload limit', async () => {
  const cue = `1\n00:00:01,000 --> 00:00:02,000\n${'你好'.repeat(800_000)}\n`;
  caches.fileCache.set('file:BIGTXT', { raw: Buffer.from(cue, 'utf8'), filename: 'Dune.2021.特效.ass' });

  const response = await fetch(`${origin}/sub/BIGTXT.srt`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  assert.match(String(response.headers.get('transfer-encoding')), /chunked/);
  assert.ok((await response.arrayBuffer()).byteLength > 4 * 1024 * 1024);
});

test('answers json 404 for unknown routes', async () => {
  const response = await fetch(`${origin}/definitely/not/here`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Not found');
});

test('honours the original path forwarded by the vercel rewrite', async () => {
  const response = await fetch(`${origin}/api/index?${REWRITE_PATH_PARAM}=/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('honours rewritten paths that carry extra segments', async () => {
  const response = await fetch(`${origin}/api/index?${REWRITE_PATH_PARAM}=/definitely/not/here`);
  assert.equal(response.status, 404);
});

test('resolvePathname prefers the real path when no rewrite happened', () => {
  const url = new URL('http://addon.test/subtitles/series/tt123:1:2.json?s=1&e=2');
  assert.equal(resolvePathname(url), '/subtitles/series/tt123:1:2.json');
  assert.equal(url.searchParams.get('s'), '1');
});

test('resolvePathname falls back to the rewritten path parameter', () => {
  const url = new URL(`http://addon.test/api/index?${REWRITE_PATH_PARAM}=/subtitles/movie/tt123.json`);
  assert.equal(resolvePathname(url), '/subtitles/movie/tt123.json');
  assert.equal(url.searchParams.has(REWRITE_PATH_PARAM), false);
});

test('resolveTool keeps PATH lookups on platforms without the bundled build', async () => {
  const tool = await resolveTool('7z');
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.match(tool, /7zzs?$/);
  } else {
    assert.equal(tool, '7z');
  }
});
