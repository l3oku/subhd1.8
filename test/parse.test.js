import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  episodeFromName,
  parseDetailPage,
  detectEpisodeInText,
  parseChineseNumber,
  parseSearchPage,
  parseVideoId,
  parseWorkPage,
  seasonFromName,
} from '../src/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('parseSearchPage extracts subtitle entries from a keyword search', () => {
  const result = parseSearchPage(fixture('search-sand-dune.html'));

  assert.equal(result.page, 1);
  assert.ok(result.total > 0);
  assert.equal(result.entries.length, 20);
  assert.equal(new Set(result.entries.map((entry) => entry.sid)).size, 20);

  const first = result.entries[0];
  assert.equal(first.sid, 'gb6JIH');
  assert.equal(first.workId, '24312655');
  assert.equal(first.title, '佐杜洛夫斯基的沙丘');
  assert.deepEqual(first.formats, ['SUP']);
  assert.deepEqual(first.languages, ['双语', '简体', '繁体', '英语']);
  assert.equal(first.badge, '其他来源');
  assert.equal(first.uploader, 'SubKing');
  assert.equal(first.poster, 'https://img.subhd.me/poster/douban/24312655_600.webp');
});

test('parseSearchPage works for IMDb id searches', () => {
  const result = parseSearchPage(fixture('search-imdb-tt4574334.html'));
  const workIds = [...new Set(result.entries.map((entry) => entry.workId))];

  assert.deepEqual(workIds, ['26359270', '35774681']);
  assert.ok(result.entries.every((entry) => entry.workId && entry.poster));
  assert.ok(result.entries.some((entry) => entry.title.includes('怪奇物语')));
});

test('parseSearchPage handles the latest feeds', () => {
  const result = parseSearchPage(fixture('feed-movie.html'));
  assert.equal(result.entries.length, 20);
  assert.ok(result.entries.every((entry) => entry.sid));
});

test('parseWorkPage extracts metadata and episode aware subtitles', () => {
  const work = parseWorkPage(fixture('work-26359270.html'));

  assert.equal(work.workId, '26359270');
  assert.equal(work.imdbId, 'tt4574334');
  assert.equal(work.doubanId, '26359270');
  assert.equal(work.year, 2016);
  assert.equal(work.type, 'series');
  assert.equal(work.typeLabel, '电视');
  assert.ok(work.poster.startsWith('https://img.subhd.me/'));
  assert.ok(work.genres.includes('恐怖'));
  assert.equal(work.subtitles.length, 100);

  const episodeEight = work.subtitles.filter((entry) => entry.episode === 8);
  assert.ok(episodeEight.length > 5);
  assert.ok(episodeEight.every((entry) => entry.sid));
  assert.ok(work.subtitles.every((entry) => entry.season === null));
});

test('parseVideoId understands Stremio ids', () => {
  assert.deepEqual(parseVideoId('tt4574334'), { imdbId: 'tt4574334', season: null, episode: null });
  assert.deepEqual(parseVideoId('tt4574334:1:8'), { imdbId: 'tt4574334', season: 1, episode: 8 });
  assert.deepEqual(parseVideoId('tt4574334:8'), { imdbId: 'tt4574334', season: null, episode: 8 });
});

test('detectEpisodeInText matches common release naming', () => {
  assert.equal(detectEpisodeInText('Stranger.Things.S01E08.720p.WEBRip', 1, 8), true);
  assert.equal(detectEpisodeInText('Stranger.Things.S01E10.720p', 1, 1), false);
  assert.equal(detectEpisodeInText('怪奇物语 第8集', null, 8), true);
  assert.equal(detectEpisodeInText('1x08 - The Bathtub', 1, 8), true);
});

test('parseChineseNumber reads season markers', () => {
  assert.equal(parseChineseNumber('一'), 1);
  assert.equal(parseChineseNumber('五'), 5);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('十二'), 12);
  assert.equal(parseChineseNumber('3'), 3);
});

test('parseDetailPage extracts subtitle level metadata', () => {
  const detail = parseDetailPage(fixture('detail-N2PUcz.html'));

  assert.equal(detail.workId, '37647331');
  assert.equal(detail.imdbId, 'tt38061210');
  assert.equal(detail.type, 'movie');
  assert.equal(detail.year, 2026);
  assert.equal(detail.edition, 'Why.Did.I.Get.Married.Again.2026.WEB-DL.1080p');
  assert.equal(detail.badge, '官方字幕');
  assert.deepEqual(detail.languages, ['繁体']);
  assert.deepEqual(detail.formats, ['SRT']);
  assert.equal(detail.sizeText, '128k');
  assert.equal(detail.uploader, 'cooee');
  assert.ok(detail.downloads > 0);
});

test('parseWorkPage links to the other seasons of the same show', () => {
  const work = parseWorkPage(fixture('work-26359270.html'));
  const seasons = work.relatedWorks.filter((item) => item.season);

  assert.deepEqual([...new Set(seasons.map((item) => item.season))], [1, 2, 3, 4, 5]);
  assert.equal(seasons.find((item) => item.season === 5).workId, '35774681');
  assert.ok(work.relatedWorks.some((item) => item.name === '怪奇背后' && item.season === null));
});

test('seasonFromName and episodeFromName read the site naming', () => {
  assert.equal(seasonFromName('绝命毒师 第五季'), 5);
  assert.equal(seasonFromName('越狱 第1季 / 越狱风云 第1季（台）'), 1);
  assert.equal(seasonFromName('Dune 2021'), null);

  assert.equal(episodeFromName('Prison.Break.S03E03.1080p.BluRay'), 3);
  assert.equal(episodeFromName('Stranger.Things.S01E08.720p.WEBRip'), 8);

  // 合集和范围没有唯一集号，交给解压时按集挑文件
  assert.equal(episodeFromName('Breaking.Bad.S05.1080p.BluRay.x264'), null);
  assert.equal(episodeFromName('Breaking.Bad.S05E01-08.720p.WEB-DL'), null);
  assert.equal(episodeFromName('越狱 第3季 / 越狱风云 第3季（台）（网飞官方字幕）全13集'), null);
});
