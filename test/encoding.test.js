import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeSubtitleBuffer } from '../src/subhd.js';
import { decodeTextBuffer, scoreDecodedText } from '../src/subtitle-format.js';

const SRT_HEAD = '310d0a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300d0a';
const srt = (lineHex) => Buffer.from(`${SRT_HEAD}${lineHex}0d0a`, 'hex');

// 《绝命毒师》的繁中字幕：Big5 字节，之前会被 GB18030 解成「荡㏑瑀畍 ﹗臮」
const BIG5_LINE = 'b5b4a952ac72ae7620a457a975a65ec555';
// GBK / GB18030 的简体字幕
const GBK_LINE = 'c4e3bac3a3accac0bde7a1a3d5e2b2bfb5e7d3b0badcbac3bfb4';

test('Big5 subtitles are decoded as Big5 instead of GB18030', async () => {
  const result = await decodeTextBuffer(srt(BIG5_LINE));

  assert.equal(result.encoding, 'big5');
  assert.match(result.text, /絕命毒師 上季回顧/);
  assert.doesNotMatch(result.text, /荡㏑/);
});

test('GB18030 subtitles still win on their own bytes', async () => {
  const result = await decodeTextBuffer(srt(GBK_LINE));

  assert.equal(result.encoding, 'gb18030');
  assert.match(result.text, /你好，世界。这部电影很好看/);
});

test('utf-8 and plain ascii subtitles are left alone', async () => {
  const utf8 = Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n简体字幕\r\n', 'utf8');
  assert.equal((await decodeTextBuffer(utf8)).encoding, 'utf-8');
  assert.match((await decodeTextBuffer(utf8)).text, /简体字幕/);

  const ascii = Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello there\r\n', 'utf8');
  assert.equal((await decodeTextBuffer(ascii)).encoding, 'utf-8');
});

test('scoreDecodedText prefers real text over lookalike codepoints', () => {
  assert.ok(scoreDecodedText('絕命毒師 上季回顧') > scoreDecodedText('荡㏑瑀畍 ﹗臮'));
  assert.ok(scoreDecodedText('Hello world') > scoreDecodedText('H\ufffdo wor\ufffdd'));
});

test('decodeSubtitleBuffer keeps the utf-16 path and reports the picked encoding', async () => {
  const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\n繁体\r\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal((await decodeSubtitleBuffer(utf16)).encoding, 'utf-16le');
  assert.match((await decodeSubtitleBuffer(utf16)).text, /繁体/);

  const big5 = await decodeSubtitleBuffer(srt(BIG5_LINE));
  assert.equal(big5.encoding, 'big5');
  assert.match(big5.text, /絕命毒師/);
});
