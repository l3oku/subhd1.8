import assert from 'node:assert/strict';
import test from 'node:test';

import {
  neighborSids,
  orderEntriesByWorkPages,
  pickSeasonWork,
  splitWorksBySeason,
} from '../src/addon.js';
import { fileLanguages, pickArchiveFile, warmSubtitles } from '../src/subhd.js';

const files = [
  { name: 'Show.S01E01.zh.srt', data: Buffer.from('a') },
  { name: 'Show.S01E08.zh.ass', data: Buffer.from('b') },
  { name: 'Show.S01E08.zh.srt', data: Buffer.from('c') },
  { name: '说明.md', data: Buffer.from('d') },
];

test('pickArchiveFile prefers the requested episode and format', () => {
  assert.equal(pickArchiveFile(files, { target: 'srt', season: 1, episode: 8 }).name, 'Show.S01E08.zh.srt');
  assert.equal(pickArchiveFile(files, { target: 'ass', season: 1, episode: 8 }).name, 'Show.S01E08.zh.ass');
});

test('pickArchiveFile falls back to any subtitle file', () => {
  assert.equal(pickArchiveFile(files, { target: 'srt', season: 1, episode: 3 }).name, 'Show.S01E01.zh.srt');
  assert.equal(pickArchiveFile(files.slice(3), { target: 'srt' }).name, '说明.md');
});

// KKTV 的日剧包中文、日语各一份文件：点「繁中」不能给日语那份。
test('pickArchiveFile prefers the Chinese file in a multi-language pack', () => {
  const ja = { name: 'Yugure.S01E03.KKTV.ja.srt', data: Buffer.from('a') };
  const zh = { name: 'Yugure.S01E03.KKTV.zh-Hant.srt', data: Buffer.from('b') };

  assert.equal(
    pickArchiveFile([ja, zh], { target: 'srt', season: 1, episode: 3 }).name,
    'Yugure.S01E03.KKTV.zh-Hant.srt',
  );
  // 整包里没有中文（比如全是日语）时照旧给那一份，不能挑空
  assert.equal(pickArchiveFile([ja], { target: 'srt', season: 1, episode: 3 }).name, ja.name);
  assert.equal(pickArchiveFile([ja], { target: 'srt' }).name, ja.name);
});

// 站点把「简体 + 繁体」包成一条时（13 集 × 简繁各一份），简中、繁中要各自拿到对应的文件。
test('pickArchiveFile follows the language of the track being played', () => {
  const hans = { name: 'Prison.Break.S03E01.WEBRip.Netflix.zh-Hans.srt', data: Buffer.from('a') };
  const hant = { name: 'Prison.Break.S03E01.WEBRip.Netflix.zh-Hant.srt', data: Buffer.from('b') };

  assert.equal(
    pickArchiveFile([hans, hant], { target: 'srt', season: 3, episode: 1, lang: 'zh-Hans' }).name,
    hans.name,
  );
  assert.equal(
    pickArchiveFile([hans, hant], { target: 'srt', season: 3, episode: 1, lang: 'zh-Hant' }).name,
    hant.name,
  );
  // 站点标了简繁各一份、包里却只有简中：繁中那一行退回简中，总比给不出字幕强
  assert.equal(pickArchiveFile([hans], { target: 'srt', lang: 'zh-Hant' }).name, hans.name);
});

// `…繁体&英文.ass` + 一份没写语言的简体：繁中挑写明了的那份，简中挑剩下那份。
test('pickArchiveFile reads the 繁体&英文 style markers', () => {
  const hant = {
    name: 'Prison.Break.S03E01.1080p.BluRay.x264-SECTOR7 .繁体&英文.ass',
    data: Buffer.from('a'),
  };
  const hans = { name: 'Prison.Break.S03E01.1080p.BluRay.x264-SECTOR7.ass', data: Buffer.from('b') };

  assert.equal(
    pickArchiveFile([hans, hant], { target: 'ass', season: 3, episode: 1, lang: 'zh-Hant' }).name,
    hant.name,
  );
  assert.equal(
    pickArchiveFile([hant, hans], { target: 'ass', season: 3, episode: 1, lang: 'zh-Hans' }).name,
    hans.name,
  );
  // 不带语言时照旧中文优先
  assert.equal(pickArchiveFile([hans, hant], { target: 'ass', season: 3, episode: 1 }).name, hant.name);
});

// 站点标「繁体 + 日语」的日剧包：日语那一条要拿日语那份，不能永远给中文。
test('pickArchiveFile serves the Japanese file to the Japanese track', () => {
  const ja = { name: 'Yugure.S01E03.KKTV.ja.srt', data: Buffer.from('a') };
  const zh = { name: 'Yugure.S01E03.KKTV.zh-Hant.srt', data: Buffer.from('b') };

  assert.equal(pickArchiveFile([ja, zh], { target: 'srt', season: 1, episode: 3, lang: 'ja' }).name, ja.name);
  assert.equal(
    pickArchiveFile([ja, zh], { target: 'srt', season: 1, episode: 3, lang: 'zh-Hant' }).name,
    zh.name,
  );
});

// 文件名里什么都没写（整包只有一种语言的包都这样）时，按站点标签认那一份。
test('pickArchiveFile trusts the site tag when the file name stays silent', () => {
  const plain = { name: 'Movie.2024.1080p.WEB-DL.x264-GROUP.srt', data: Buffer.from('a') };
  assert.equal(pickArchiveFile([plain], { target: 'srt', lang: 'zh-Hans' }).name, plain.name);
  assert.equal(pickArchiveFile([plain], { target: 'srt' }).name, plain.name);
});

test('fileLanguages reads the markers subtitle packs actually use', () => {
  const tags = (name) => [...fileLanguages(name)].sort();

  assert.deepEqual(tags('Prison.Break.S03E01.WEBRip.Netflix.zh-Hant.srt'), ['zh-Hant']);
  assert.deepEqual(tags('Show.S01E01.zh-Hans.srt'), ['zh-Hans']);
  assert.deepEqual(tags('Show.S01E01.chs&eng.ass'), ['en', 'zh-Hans']);
  assert.deepEqual(tags('Show.S01E01.繁体&英文.ass'), ['en', 'zh-Hant']);
  assert.deepEqual(tags('Yugure.S01E01.KKTV.ja.srt'), ['ja']);
  assert.deepEqual(tags('Show.S01E01.zh.srt'), ['zh']);
  assert.deepEqual(tags('Movie.2024.1080p.BluRay.x264-GROUP.srt'), []);
  // 抢鲜版 TC、x264 这类发布名里的缩写不能当语言
  assert.deepEqual(tags('Movie.2024.TC.1080p.x264-SPARKS.srt'), []);
});

// 换字幕最常见的动作就是往下点一条：把下面那一两条先预热好，切过去就不用等下载。
test('neighborSids points at the rows right below the one being played', () => {
  const entries = [{ sid: 'a' }, { sid: 'b' }, { sid: 'c' }, { sid: 'd' }];

  assert.deepEqual(neighborSids(entries, 0, 2), ['b', 'c']);
  assert.deepEqual(neighborSids(entries, 2, 2), ['d']);
  assert.deepEqual(neighborSids(entries, 3, 2), []);
  assert.deepEqual(neighborSids(entries, 0, 0), []);
});

test('warmSubtitles ignores anything that is not a subtitle id', () => {
  assert.equal(warmSubtitles(['', 'not a sid!', '../../etc/passwd'], 2), undefined);
  assert.equal(warmSubtitles([], 2), undefined);
});

test('pickSeasonWork follows a work page link to the season being watched', () => {
  const work = {
    relatedWorks: [
      { workId: '1', name: '怪奇物语 第一季', season: 1 },
      { workId: '5', name: '怪奇物语 第五季', season: 5 },
      { workId: '99', name: '最后的冒险：《怪奇物语》第五季幕后', season: 5 },
    ],
  };

  assert.equal(pickSeasonWork(work, 5).workId, '5');
  assert.equal(pickSeasonWork(work, 1).workId, '1');
  assert.equal(pickSeasonWork(work, 3), null);
});

// 站点上的「默认排序」在作品页上，搜索结果只是按下载量排的 —— 要让两者顺序一致。
test('orderEntriesByWorkPages follows the work page order and appends the extras', () => {
  const works = [{ name: '指环王3：王者无敌', subtitles: [{ sid: 'b' }, { sid: 'a' }] }, null];
  const entries = [{ sid: 'a' }, { sid: 'c' }];
  const ordered = orderEntriesByWorkPages(works, entries);

  assert.deepEqual(
    ordered.map((entry) => entry.sid),
    ['b', 'a', 'c'],
  );
  assert.equal(ordered[0].workName, '指环王3：王者无敌');
});

// 《万物生灵》第二季在前两页搜索结果里完全不出现，不能被圣诞特别集这类条目挡住兜底逻辑。
test('splitWorksBySeason keeps unreadable names out of the season being watched', () => {
  const entries = [
    { workId: 's7', title: '万物生灵 第七季' },
    { workId: 's6', title: '万物生灵 第六季' },
    { workId: 'xmas', title: '万物生灵：2025圣诞特别集' },
    { workId: 's2', title: '万物生灵 第二季' },
    { workId: 's7', title: '万物生灵 第七季' },
    { workId: null, title: '没有作品页的条目' },
  ];

  assert.deepEqual(splitWorksBySeason(entries, 2), { matched: ['s2'], unknown: ['xmas'], others: ['s7', 's6'] });
  assert.deepEqual(splitWorksBySeason(entries, 7).matched, ['s7']);
  assert.deepEqual(splitWorksBySeason(entries, null).matched, ['s7', 's6', 'xmas', 's2']);
});
