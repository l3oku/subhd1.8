import assert from 'node:assert/strict';
import test from 'node:test';

import { aliasesFor } from '../src/aliases.js';
import { checkIdentity, episodeInfo, episodeRank, seasonInfo, titleTokens } from '../src/match.js';
import { thunderHaystack } from '../src/thunder.js';

const series = (over = {}) => ({
  titles: ['Breaking Bad'],
  aliases: ['绝命毒师'],
  year: 2008,
  type: 'series',
  season: 1,
  episode: 1,
  ...over,
});

test('titleTokens drops stop words but keeps distinctive words', () => {
  assert.deepEqual(titleTokens('Dune: Part Two'), ['dune', 'two']);
  assert.deepEqual(titleTokens('Breaking Bad'), ['breaking', 'bad']);
  // 中文片名整串作为一个 token
  assert.deepEqual(titleTokens('绝命毒师'), ['绝命毒师']);
});

test('seasonInfo understands 第N季 / SNN / Season N', () => {
  assert.equal(seasonInfo('绝命毒师 第二季 Breaking Bad'), 2);
  assert.equal(seasonInfo('Breaking.Bad.S02.1080p'), 2);
  assert.equal(seasonInfo('The Office Season 5 1080p'), 5);
  // 集号里的 S01 不算季（S01E03 的季应该是 1，这里只测没写季的情况）
  assert.equal(seasonInfo('第3季'), 3);
  assert.equal(seasonInfo('随便一个名字'), null);
});

test('episodeInfo understands S01E02 / 1x02 / 第2集 and flags ranges as packs', () => {
  assert.deepEqual(episodeInfo('Show.S02E05.1080p'), { season: 2, episode: 5, pack: false });
  assert.deepEqual(episodeInfo('Show 2x05'), { season: 2, episode: 5, pack: false });
  assert.deepEqual(episodeInfo('第5集'), { season: null, episode: 5, pack: false });
  assert.equal(episodeInfo('Show.S01E01-08').pack, true);
  assert.equal(episodeInfo('全 9 集').pack, true);
  assert.equal(episodeInfo('Breaking.Bad.S01-05.BluRay').episode, null);
});

test('checkIdentity rejects a different film that shares a word', () => {
  // 《风骚律师》那版 S06E11 的发布名里夹着 Breaking.Bad，但标题说的是另一部片
  const saul = {
    headOnly: true,
    head: 'Better.Call.Saul.S06E11.双语特效字幕',
    haystack:
      'Better.Call.Saul.S06E11.双语特效字幕 Better.Call.Saul.S06E11. Breaking . Bad .1080p.AMZN.WEBRip',
  };
  assert.equal(checkIdentity(saul, series()).ok, false);
});

test('checkIdentity rejects a spin-off whose title starts with the name', () => {
  const spinOff = {
    headOnly: true,
    head: 'Friends Sex and Games S01E05/各取所需',
    haystack: 'Friends Sex and Games S01E05/各取所需 Friends.Sex.and.Games.S01E05.1080p.WEB.h264-EDITH',
  };
  assert.equal(checkIdentity(spinOff, { titles: ['Friends'], aliases: ['老友记'], year: 1994, type: 'series', season: 2, episode: 5 }).ok, false);
});

test('checkIdentity keeps the right season pack and drops other seasons', () => {
  // 同一部剧的整季包：片名和季号都对得上
  const seasonPack = {
    headOnly: true,
    head: '绝命毒师 第一季 Breaking Bad',
    haystack: '绝命毒师 第一季 Breaking Bad 绝命毒师 第一季. Breaking . Bad .S01.1080p.BluRay',
  };
  assert.equal(checkIdentity(seasonPack, series()).ok, true);

  const otherSeason = {
    headOnly: true,
    head: '绝命毒师 第二季 Breaking Bad (2009)',
    haystack: '绝命毒师 第二季 Breaking Bad (2009) 绝命毒师 第二季. Breaking . Bad .S02.1080p',
  };
  assert.equal(checkIdentity(otherSeason, series()).reason.startsWith('季号不符'), true);
});

test('checkIdentity uses the year to tell 沙丘 apart from 沙丘2', () => {
  const dune1 = { headOnly: true, head: '沙丘 Dune (2021)', haystack: '沙丘 Dune (2021) Dune.2021.1080p' };
  const dune2 = { headOnly: true, head: '沙丘2 Dune: Part Two (2024)', haystack: '沙丘2 Dune: Part Two (2024) Dune.Part.Two.2024.1080p' };
  const want = { titles: ['Dune: Part Two'], aliases: ['沙丘', '沙丘2'], year: 2024, type: 'movie' };
  assert.equal(checkIdentity(dune1, want).ok, false);
  assert.equal(checkIdentity(dune2, want).ok, true);
});

test('episodeRank orders exact episode → whole series → season pack, and drops other episodes', () => {
  const want = { season: 2, episode: 5 };
  assert.equal(episodeRank({ haystack: 'Show.S02E05.1080p' }, {}), 0);
  assert.equal(episodeRank({ haystack: 'Show.S02E05.1080p' }, want), 0);
  assert.equal(episodeRank({ haystack: 'Show 第二季 全24集' }, want), 3);
  assert.equal(episodeRank({ haystack: 'Show 整部剧' }, want), 2);
  assert.equal(episodeRank({ haystack: 'Show.S02E06.1080p' }, want), null);
});

test('aliasesFor finds Chinese titles, including the head of a subtitle', () => {
  const duneAliases = aliasesFor('Dune: Part Two');
  assert.ok(duneAliases.includes('沙丘2'));
  assert.ok(duneAliases.includes('沙丘'));
  // 港版 / 台版译名也要认：《星际穿越》在射手那边常写成「星際效應」
  assert.ok(aliasesFor('Interstellar').includes('星際效應'));
  assert.ok(aliasesFor('Breaking Bad').includes('绝命毒师'));
  assert.deepEqual(aliasesFor('A Film Nobody Has'), []);
});

// —— 「同名不同年 / 同名不同片」的真实案例（2026 年的《The Greatest》）——
const theGreatest = { titles: ['The Greatest'], aliases: [], year: 2026, type: 'series', season: 1, episode: 1 };

test('同名不同年的片子按年份挡掉（The Greatest 2026 vs 2024）', () => {
  // 迅雷那边有一堆 The Greatest (2024).ITALIAN / DANISH …，以前因为剧集放宽 ±6 年全放进来了
  for (const name of ['The Greatest (2024).ITALIAN.srt', 'The Greatest (2024)DANISH.srt', 'The Greatest 2024 1080p.mkv']) {
    assert.equal(checkIdentity({ haystack: name, fileName: name }, theGreatest).ok, false, name);
  }
  assert.equal(checkIdentity({ haystack: 'The Greatest (2026).srt', fileName: 'The Greatest (2026).srt' }, theGreatest).ok, true);
});

test('片名只是字符串的一部分时不算命中（Sia / Apple / SCTV）', () => {
  for (const name of [
    'Sia - The Greatest.SRT',
    'Apple - The Greatest.srt',
    'SCTV. The . Greatest .Show.Youve.Never.Heard.Of.srt',
    '50 of the greatest MOVIE QUOTES.ass',
    'Catherine+the+Great_+Russia’s+Greatest+Empress.srt',
  ]) {
    assert.equal(checkIdentity({ haystack: name, fileName: name }, theGreatest).ok, false, name);
  }
  // 真正的剧集条目要放行
  for (const name of ['The Greatest S01E01 Fools Gold 1080p AMZN WEB-DL', 'The.Greatest.2026.S01E01.1080p.mkv', 'The Greatest.srt']) {
    assert.equal(checkIdentity({ haystack: name, fileName: name }, theGreatest).ok, true, name);
  }
});

test('迅雷的 simple_name 不参与判定（否则搜什么都「对上」）', () => {
  const item = { simple_name: '简体[SRT]The Greatest', name: 'Sia - The Greatest.SRT' };
  const haystack = thunderHaystack(item);
  assert.equal(haystack, 'Sia - The Greatest.SRT');
  assert.equal(checkIdentity({ haystack, fileName: item.name }, theGreatest).ok, false);
});

test('英文名前面是中文译名时照常匹配（星期三.Wednesday）', () => {
  const want = { titles: ['Wednesday'], year: 2022, type: 'series', season: 2, episode: 8 };
  const head = '星期三.Wednesday.S02E08.This.Means.Woe.1080p.NF.WEB-DL';
  assert.equal(checkIdentity({ haystack: head, headOnly: true, head }, want).ok, true);
  assert.equal(checkIdentity({ haystack: 'MyFamilyPies.23.10.10.Megan.Vs.Wednesday' }, want).ok, false);
});
