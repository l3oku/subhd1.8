import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManifest, subtitleTrack, tagTrack } from '../src/addon.js';
import { subtitleSources } from '../src/config.js';

test('all three sources are enabled by default', () => {
  assert.deepEqual(subtitleSources(), ['subhd', 'thunder', 'assrt']);
});

// Stremio 客户端（stremio-core → Manifest::is_resource_supported）是拿请求里的资源名
// 去 resources 里「精确匹配 name」的：有任何一个名字不是 "subtitles"，字幕列表就会是空的。
test('manifest exposes exactly one resource named "subtitles"', () => {
  const manifest = buildManifest('http://addon.test');
  const names = manifest.resources.map((entry) => (typeof entry === 'string' ? entry : entry.name));

  assert.deepEqual(names, ['catalog', 'subtitles']);
  const subtitles = manifest.resources.find((entry) => typeof entry === 'object');
  assert.deepEqual(subtitles.types, ['movie', 'series']);
  assert.deepEqual(subtitles.idPrefixes, ['tt']);
  // index 是给客户端排序「先问哪个插件」用的：三个来源都在这一个资源里，不需要它
  assert.equal(subtitles.index, undefined);
});

test('merging sources tags every track so the client can tell them apart', () => {
  const base = { id: '沙丘2 · 简体 · 713711', url: 'http://addon.test/sub/713711.srt', label: '沙丘2', lang: '简体' };
  const thunder = tagTrack(base, 'thunder');
  assert.equal(thunder.label, '迅雷 · 沙丘2');
  assert.match(thunder.id, /^迅雷 · /);
  assert.equal(thunder.url, base.url);
  assert.deepEqual(tagTrack(base, 'subhd').label, 'SubHD · 沙丘2');
  // 不认识的来源原样返回
  assert.equal(tagTrack(base, 'nope'), base);
});

test('manifest exposes search catalogs for every source and latest lists where they exist', () => {
  const ids = buildManifest('http://addon.test').catalogs.map((catalog) => catalog.id);
  assert.ok(ids.includes('subhd-movie-search'));
  assert.ok(ids.includes('thunder-movie-search'));
  assert.ok(ids.includes('thunder-series-search'));
  assert.ok(ids.includes('assrt-movie-latest'));
  assert.ok(ids.includes('assrt-series-latest'));
  // 迅雷没有「最新」接口：别给它挂一个永远空的目录
  assert.ok(!ids.includes('thunder-movie-latest'));
});

test('subtitleTrack sends non-SubHD sources through their own route', () => {
  const subhd = subtitleTrack(
    { sid: 'N2PUcz', languages: ['简体'], formats: ['SRT'], episode: 1, season: 1 },
    { season: 1, episode: 1, baseUrl: 'http://addon.test' },
  );
  assert.match(subhd.url, /^http:\/\/addon\.test\/sub\/N2PUcz\.srt\?s=1&e=1$/);

  const thunder = subtitleTrack(
    {
      source: 'thunder',
      sid: 'ABCDEF',
      fileUrl: 'https://subtitle.v.geilijiasu.com/AB/CD/ABCDEF.srt',
      languages: ['简体'],
      formats: ['SRT'],
      workName: '沙丘2',
      filename: 'Dune.Part.Two.2024.srt',
      url: 'http://addon.test/thunder/ABCDEF.srt',
    },
    { baseUrl: 'http://addon.test' },
  );
  assert.match(thunder.url, /^http:\/\/addon\.test\/thunder\//);
  assert.equal(thunder.url, 'http://addon.test/thunder/ABCDEF.srt');
});

test('subtitleTrack labels episodes and names for the new sources', () => {
  const track = subtitleTrack(
    {
      source: 'assrt',
      sourceName: '射手(伪)',
      sid: '713711',
      workName: '沙丘2 Dune: Part Two',
      filename: '沙丘2.1080p.ass',
      languages: ['中英双语'],
      formats: ['ASS'],
      episode: 2,
      season: 1,
      url: 'http://addon.test/assrt/713711.ass?lang=zh',
    },
    { season: 1, episode: 2, baseUrl: 'http://addon.test' },
  );
  assert.match(track.label, /沙丘2/);
  assert.match(track.label, /S01E02/);
  assert.match(track.lang, /中英双语/);
  assert.match(track.lang, /射手\(伪\)/);
});
