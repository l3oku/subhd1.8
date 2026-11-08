import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assToSrt,
  convertSubtitle,
  detectTextFormat,
  hasUtf16Bom,
  isProbablyBinary,
  parseSrt,
  srtToAss,
} from '../src/subtitle-format.js';

const here = dirname(fileURLToPath(import.meta.url));

const ASS_SAMPLE = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\an8}第一行\\N第二行
Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,双语台词
`;

const SRT_SAMPLE = `1
00:00:05,000 --> 00:00:07,500
第一行
第二行

2
00:00:08,000 --> 00:00:09,000
双语台词
`;

test('detectTextFormat recognises ass and srt', () => {
  assert.equal(detectTextFormat(ASS_SAMPLE), 'ass');
  assert.equal(detectTextFormat(SRT_SAMPLE), 'srt');
  assert.equal(detectTextFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi'), 'vtt');
});

test('assToSrt converts cues, strips tags and keeps order', () => {
  const srt = assToSrt(ASS_SAMPLE);
  const cues = parseSrt(srt);

  assert.equal(cues.length, 2);
  assert.equal(cues[0].content, '第一行\n第二行');
  assert.equal(cues[1].content, '双语台词');
  assert.match(srt, /00:00:05,000 --> 00:00:07,500/);
  assert.doesNotMatch(srt, /\{\\an8\}/);
});

test('srtToAss produces parseable ASS', () => {
  const ass = srtToAss(SRT_SAMPLE);
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /Dialogue: 0,0:00:05\.00,0:00:07\.50,Default,,0,0,0,,第一行\\N第二行/);
  assert.equal(detectTextFormat(ass), 'ass');
});

test('convertSubtitle is idempotent for matching formats', () => {
  assert.equal(convertSubtitle(SRT_SAMPLE, 'srt', 'srt'), SRT_SAMPLE);
  assert.match(convertSubtitle(SRT_SAMPLE, 'srt', 'ass'), /Dialogue:/);
  assert.equal(parseSrt(convertSubtitle(ASS_SAMPLE, 'ass', 'srt')).length, 2);
});

test('round trips a real SubHD subtitle file', () => {
  const raw = readFileSync(join(here, 'fixtures', 'sample-subtitle.srt'), 'utf8');
  const cues = parseSrt(raw);

  assert.ok(cues.length > 100);
  assert.equal(detectTextFormat(raw), 'srt');

  const ass = convertSubtitle(raw, 'srt', 'ass');
  assert.equal(detectTextFormat(ass), 'ass');

  const backToSrt = assToSrt(ass);
  assert.ok(parseSrt(backToSrt).length >= cues.length * 0.95);
});

test('binary sniffing separates text subtitles from image subtitles', () => {
  const sample = readFileSync(join(here, 'fixtures', 'sample-subtitle.srt'));
  assert.equal(isProbablyBinary(sample), false);
  assert.equal(isProbablyBinary(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n')), false);
  assert.equal(isProbablyBinary(Buffer.concat([Buffer.from('PG'), Buffer.alloc(64)])), true);

  assert.equal(hasUtf16Bom(Buffer.from([0xff, 0xfe, 0x31, 0x00])), true);
  assert.equal(hasUtf16Bom(Buffer.from('1\n00:00:01,000\n')), false);
});
