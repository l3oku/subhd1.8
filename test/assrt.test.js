import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assrtDownloadHref,
  assrtEpisodeRank,
  assrtLanguage,
  assrtTitleScore,
  parseAssrtDetail,
  parseAssrtListItem,
  parseAssrtSearch,
} from '../src/assrt.js';
import { extOfName, isSingleSubtitle, looksLikeErrorPage } from '../src/files.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const search = parseAssrtSearch(fixture('assrt-search-dune.html'));
const entry = search.items.find((item) => item.id === '713711');

test('parseAssrtSearch reads the result list', () => {
  assert.equal(search.total, 56);
  assert.equal(search.pages, 4);
  assert.equal(search.items.length, 15);

  assert.ok(entry, '应该能解析出 713711 这条');
  assert.equal(entry.title, '沙丘2 Dune: Part Two (2024)');
  assert.equal(entry.format, 'SSA');
  assert.equal(entry.languages, '英 简 双语');
  assert.equal(entry.source, '原创翻译');
  assert.match(entry.downloadHref, /^\/download\/713711\//);
  assert.match(entry.filename, /\.ass$/);
  assert.equal(entry.downloads, 515);
});

test('parseAssrtDetail reads format / language / filename / download href', () => {
  const detail = parseAssrtDetail(fixture('assrt-detail-713711.html'));
  assert.equal(detail.name, '沙丘2 Dune: Part Two (2024)');
  assert.equal(detail.format, 'SSA');
  assert.equal(detail.languages, '英 简 双语');
  assert.match(detail.filename, /\.ass$/);
  assert.match(detail.downloadHref, /^\/download\/713711\//);
});

test('assrtDownloadHref falls back to /download/<id>/<name>', () => {
  assert.equal(assrtDownloadHref({ id: '1', downloadHref: '/download/1/x.srt' }), '/download/1/x.srt');
  const guessed = assrtDownloadHref({ id: '42', filename: '沙丘2 2024.ass' });
  assert.match(guessed, /^\/download\/42\//);
  assert.match(decodeURIComponent(guessed), /沙丘2 2024\.ass$/);
});

test('assrtLanguage folds the site tags into one track per file', () => {
  assert.equal(assrtLanguage('英 简 双语').label, '中英双语');
  assert.equal(assrtLanguage('英 简 双语').code, 'zh');
  assert.equal(assrtLanguage('简').code, 'zh');
  assert.equal(assrtLanguage('繁').code, 'zh-Hant');
  assert.equal(assrtLanguage('英').code, 'en');
  // 双语包里再带日语：日语是另一份文件，单独一条
  assert.equal(assrtLanguage('简 繁 双语 日').label, '中英双语/日语');
});

test('assrtTitleScore prefers the right film of a series', () => {
  const partTwo = { title: '沙丘2 Dune: Part Two (2024)', version: 'Dune.Part.Two.2024' };
  const first = { title: '沙丘 Dune (2021)', version: 'Dune.2021' };
  assert.ok(assrtTitleScore(partTwo, 'Dune: Part Two', 2024) > assrtTitleScore(first, 'Dune: Part Two', 2024));
  assert.equal(assrtTitleScore({ title: '完全无关的片子' }, 'Dune', 2024), 0);
});

test('assrtEpisodeRank puts the matching episode before season packs', () => {
  const wanted = { season: 1, episode: 4 };
  assert.equal(assrtEpisodeRank({ title: 'Show S01E04' }, wanted), 0);
  assert.equal(assrtEpisodeRank({ title: 'Show 第一季 全8集' }, wanted), 1);
});

test('parseAssrtListItem pulls a usable title out of the latest-list names', () => {
  assert.deepEqual(parseAssrtListItem("Blake's 7 S2E06/布莱克七人帮S2E06/Blake's.7.S2E06.Trial.DVD.XviD"), {
    title: "Blake's 7",
    year: null,
    season: 2,
    episode: 6,
    full: "Blake's 7 S2E06/布莱克七人帮S2E06/Blake's.7.S2E06.Trial.DVD.XviD",
  });
  assert.equal(parseAssrtListItem('First Communion 2025/First.Communion.2025.1080p.WEBRip.x264-CBFM').title, 'First Communion');
  assert.equal(
    parseAssrtListItem('City of God: The Fight Rages On S02E01/上帝之城：斗争蔓延/City.of.God.S02E01.mkv').title,
    'City of God: The Fight Rages On',
  );
});

test('archives are not mistaken for single subtitle files', () => {
  assert.equal(extOfName('a.zip'), 'zip');
  assert.equal(isSingleSubtitle('沙丘2.1080p.rar'), false);
  assert.equal(isSingleSubtitle('沙丘2 (2024) 2160p AAC.ass.zip'), false);
  assert.equal(isSingleSubtitle('/download/713711/x.ass'), true);
  assert.equal(isSingleSubtitle('/download/693347/x.zip', 'srt'), false);
});

test('assrt error pages are detected instead of being served as a subtitle', () => {
  const xmlError = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/xslt/main.xsl"?><page pid="/errpage/40x">',
  );
  assert.equal(looksLikeErrorPage(xmlError), true);
  assert.equal(looksLikeErrorPage(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n')), false);
});
