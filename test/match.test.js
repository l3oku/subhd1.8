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

test('迅雷 simple_name 里的中文片名参与判定（否则中文条目全丢）', () => {
  // 「The Odyssey」57 条里有 35 条文件名是全中文的（奥德赛.srt），站点在 simple_name 里
  // 写着「简体[SRT]奥德赛」—— 这截片名必须参与判定，不然全被当成「片名对不上」丢掉。
  const item = { simple_name: '简体[SRT]奥德赛', name: '奥德赛.srt' };
  const haystack = thunderHaystack(item);
  assert.match(haystack, /奥德赛/);
  assert.doesNotMatch(haystack, /简体|SRT/); // 语言/格式标记不参与
  assert.equal(
    checkIdentity({ haystack, fileName: item.name }, { titles: ['The Odyssey'], aliases: ['奥德赛'], year: 2026, type: 'movie' }).ok,
    true,
  );

  // 但光有 simple_name 也不能让别的片子过关：文件名以英文片名开头、后接别的词仍然要拒
  const other = { simple_name: '简体[SRT]The Greatest', name: 'Sia - The Greatest.SRT' };
  const want = { titles: ['The Greatest'], aliases: [], year: 2026, type: 'series' };
  assert.equal(checkIdentity({ haystack: thunderHaystack(other), fileName: other.name }, want).ok, false);
});

test('英文名前面是中文译名时照常匹配（星期三.Wednesday）', () => {
  const want = { titles: ['Wednesday'], year: 2022, type: 'series', season: 2, episode: 8 };
  const head = '星期三.Wednesday.S02E08.This.Means.Woe.1080p.NF.WEB-DL';
  assert.equal(checkIdentity({ haystack: head, headOnly: true, head }, want).ok, true);
  assert.equal(checkIdentity({ haystack: 'MyFamilyPies.23.10.10.Megan.Vs.Wednesday' }, want).ok, false);
});

test('回退搜到的结果必须对得上用户输入（不能拿 Cinemeta 猜的片糊弄）', async () => {
  const { englishFor } = await import('../src/aliases.js');
  // 译名表里有的：奥德赛 → the odyssey，可以换名搜
  assert.deepEqual(englishFor('奥德赛'), ['the odyssey']);
  // 译名表里没有的：不该凭空造出一个英文名
  assert.deepEqual(englishFor('校园'), []);
  assert.deepEqual(englishFor('校园接送恋曲'), []);
});

test('中文片名搜不到时可以用英文名回退，但只在译名表收录时', async () => {
  const { thunderSearchFallback } = await import('../src/thunder.js');
  // 「校园」译名表没收录、Cinemeta 又会把它认成《小小的我》—— 以前会直接返回《小小的我》的字幕
  const campus = await thunderSearchFallback('校园');
  assert.equal(campus.length, 0);
});

// —— 「迅雷模糊搜索」的真实案例 ——
test('模糊搜索里只有真正对得上的那条要留下', () => {
  // 搜「黑暗召唤师在地下恋爱中」返回 18 条：17 条是《恋爱中的女人》《召唤师技能推荐》之类的垃圾
  const want = { titles: ['黑暗召唤师在地下恋爱中'], aliases: [], year: null, type: 'series', season: 1, episode: 3 };
  const keep = '黑暗召唤师在地下恋爱中第3集.ass';
  const drop = [
    '恋爱中的女人.ass',
    '5出装和召唤师技能推荐.ass',
    '恋爱中的死神 2008.srt',
    '离婚律师恋爱中.srt',
    '恋爱中的莎士比亚.srt',
  ];
  assert.equal(checkIdentity({ haystack: keep, fileName: keep }, want).ok, true);
  for (const name of drop) {
    assert.equal(checkIdentity({ haystack: name, fileName: name }, want).ok, false, name);
  }
});

test('短片名只能整串出现，并且靠年份区分同名续集', () => {
  const campus = { titles: ['校园'], aliases: [], year: null, type: 'series' };
  assert.equal(checkIdentity({ haystack: '校园接送恋曲 第1集.srt', fileName: '校园接送恋曲 第1集.srt' }, campus).ok, true);
  assert.equal(checkIdentity({ haystack: '小小的我.srt', fileName: '小小的我.srt' }, campus).ok, false);

  // 沙丘 2021 vs 沙丘奇兵 1990：名字开头一样，靠年份分开
  const dune = { titles: ['沙丘'], aliases: ['dune'], year: 2021, type: 'movie' };
  assert.equal(checkIdentity({ haystack: '沙丘奇兵 Dune Warriors (1990).srt', fileName: '沙丘奇兵 Dune Warriors (1990).srt' }, dune).ok, false);
  assert.equal(checkIdentity({ haystack: '沙丘.Dune.2021.srt', fileName: '沙丘.Dune.2021.srt' }, dune).ok, true);
});
