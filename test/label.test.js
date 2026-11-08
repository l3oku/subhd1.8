import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clipMiddle,
  languageText,
  languageVariants,
  subtitleId,
  subtitleLabel,
  subtitleMeta,
} from '../src/addon.js';

test('languageText renders the site wording as a readable language name', () => {
  assert.equal(languageText({ languages: ['简体'] }), '简中');
  assert.equal(languageText({ languages: ['繁体'] }), '繁中');
  assert.equal(languageText({ languages: ['英语'] }), '英语');
  assert.equal(languageText({ languages: ['简体', '英语'] }), '简英');
  assert.equal(languageText({ languages: ['双语', '简体', '英语'] }), '简英双语');
  assert.equal(languageText({ languages: ['双语', '简体', '繁体'] }), '简繁双语');
  assert.equal(languageText({ languages: ['双语', '简体', '繁体', '英语'] }), '简繁英三语');
  // 整包只有日语时别自称「中文字幕」，那里根本没有中文
  assert.equal(languageText({ languages: ['日语'] }), '日语');
  assert.equal(languageText({ languages: ['繁体', '日语'] }), '繁中');
  assert.equal(languageText({ languages: [] }), '中文字幕');
});

test('subtitleLabel leads with the Chinese name and adds the subtitle name', () => {
  assert.equal(
    subtitleLabel({
      workName: '越狱 第一季 Prison Break',
      filename: 'Prison.Break.S01.1080p.BluRay.DTS.x264-ESiR',
      badge: '原创翻译',
      languages: ['双语', '简体', '英语'],
      formats: ['ASS'],
      downloads: 13073,
      seasonNumber: 1,
      episodeNumber: 4,
    }),
    '越狱 第一季 · 第4集 · Prison.Break.S01.1080p.BluRay.DTS.x264-ESiR',
  );
});

test('subtitleLabel falls back to S01E04 when the name carries no season', () => {
  assert.equal(subtitleLabel({ workName: '越狱', seasonNumber: 1, episodeNumber: 4 }), '越狱 · S01E04');
  assert.equal(subtitleLabel({ workName: '越狱', season: 1, episode: 4 }), '越狱 · S01E04');
});

// 同一集下十几条字幕只靠作品名分不出来：中文名后面要跟上站点上这条字幕自己的名字。
// 中文名里那截英文（「Prison Break」）没用，从出现拉丁字母的地方截掉。
test('subtitleLabel follows the Chinese name with the subtitle name', () => {
  assert.equal(
    subtitleLabel({
      workName: '佐杜洛夫斯基的沙丘',
      filename: '佐杜洛夫斯基的沙丘.Jodorowskys.Dune.2013-SONYHD.简繁双语特效',
    }),
    '佐杜洛夫斯基的沙丘 · Jodorowskys.Dune.2013-SONYHD.简繁双语特效',
  );
  // 整个作品名都是英文时不截，照旧显示
  assert.equal(subtitleLabel({ workName: 'Dune: Part Two' }), 'Dune: Part Two');
  assert.equal(subtitleLabel({ workName: '沙丘2 (2021)' }), '沙丘2 (2021)');
  // 「沙丘」对上「沙丘奇兵」是两部片子，不能当成同一个前缀裁掉
  assert.equal(
    subtitleLabel({ workName: '沙丘', filename: '沙丘奇兵.Dune.Warriors.1991.1080p.BluRay.x264-SADPANDA' }),
    '沙丘 · 沙丘奇兵.Dune.Warriors.1991.1080p.BluRay.x264-SADPANDA',
  );
});

// 特效、AI 校对、台词注释这些「特殊情况」标记统一放第二行，第一行只留名字。
test('the 特效 and AI markers live on the second row', () => {
  const ai = {
    workName: '沙丘',
    filename: 'Dune.2021.AI.2160p.WEB-DL',
    languages: ['简体'],
    formats: ['ASS'],
  };
  assert.equal(subtitleLabel(ai), '沙丘 · Dune.2021.AI.2160p.WEB-DL');
  assert.equal(subtitleMeta(ai), '简中 · AI · ASS · 2160p WEB-DL');

  const effects = {
    workName: '指环王3：王者无敌',
    title: 'ASS双语特效 全歌词 全演职员表',
    languages: ['简体'],
    formats: ['ASS'],
  };
  assert.equal(subtitleLabel(effects), '指环王3：王者无敌 · ASS双语特效 全歌词 全演职员表');
  assert.equal(subtitleMeta(effects), '简中 · 双语特效 · ASS');

  assert.equal(subtitleMeta({ languages: ['简体'], formats: ['SRT'], title: '台词注释版' }), '简中 · 注释 · SRT');
});

test('subtitleLabel falls back from title to release name to badge', () => {
  assert.equal(subtitleLabel({ title: '越狱 第一季' }), '越狱 第一季');
  assert.equal(
    subtitleLabel({ filename: 'Dune.2021.2160p.BluRay.x265-GROUP' }),
    'Dune.2021.2160p.BluRay.x265-GROUP',
  );
  assert.equal(subtitleLabel({ badge: '官方字幕' }), '官方字幕');
  assert.equal(subtitleLabel({}), 'SubHD');
  assert.equal(subtitleLabel({ title: '很长的名字'.repeat(40) }).length, 48);
});

// 字幕名太长时别只留开头：结尾往往才是「字幕组 / 简体&英文 / 特效」。
test('a long subtitle name keeps its head and its tail', () => {
  assert.equal(clipMiddle('沙丘', 10), '沙丘');
  assert.equal(clipMiddle('万物生灵 第七季 All Creatures Great and Small', 20), '万物生灵 第七季 A…and Small');

  const label = subtitleLabel({
    workName: '万物生灵 第七季 All Creatures Great and Small '.repeat(3).trim(),
    filename: 'All.Creatures.Great.and.Small.S07E01.2160p.BluRay.REMUX.DTS-HD.MA.5.1.HEVC.10bit.简英双语特效.rar',
  });
  assert.ok(label.startsWith('万物生灵 第七季'));
  assert.ok(label.includes('All.Creatures.Great'), label);
  assert.ok(label.endsWith('简英双语特效'), label);
  assert.ok(label.includes('…'));
  assert.ok(label.length <= 132, label);
});

test('subtitleMeta carries the language, the group and the details that used to sit in the row', () => {
  assert.equal(
    subtitleMeta({
      languages: ['双语', '简体', '英语'],
      formats: ['ASS'],
      group: '远鉴字幕组',
      badge: '官方字幕',
      filename: 'Dune.2021.2160p.BluRay.x265-SWTYBLZ',
    }),
    '简英双语 · 远鉴字幕组 · ASS · 官方字幕 · 2160p BluRay',
  );
});

// 站点把整季包挂在「第1集」下面，不能被当成第 1 集
test('subtitleMeta marks a whole-season pack as 整季', () => {
  assert.equal(
    subtitleMeta({
      languages: ['双语', '简体'],
      formats: ['SRT'],
      group: 'YYeTs字幕组',
      episode: 1,
      seasonPack: true,
    }),
    '简中双语 · 整季 · YYeTs字幕组 · SRT',
  );
});

// 用户在截图里指出来的：带字幕组的那一条要落到第二排，第一排只留剧名和集号。
test('the subtitle group stays off the first row', () => {
  const entry = {
    workName: '越狱 第一季',
    group: 'YYeTs字幕组',
    languages: ['简体'],
    formats: ['ASS'],
  };
  assert.equal(subtitleLabel(entry), '越狱 第一季');
  assert.equal(subtitleMeta(entry), '简中 · YYeTs字幕组 · ASS');
});

test('subtitleMeta drops the useless badge but keeps a real one', () => {
  assert.equal(subtitleMeta({ languages: ['简体'], badge: '其他来源' }), '简中');
  assert.equal(subtitleMeta({ languages: ['简体'], badge: '精选推荐' }), '简中 · 精选推荐');
});

// 安卓/电视版 Stremio 把字幕轨道的 id 当标题显示，所以 id 里也要带上人话。
test('subtitleId leads with the readable name and keeps the sid searchable', () => {
  assert.equal(subtitleId({ sid: 'N2PUcz', workName: '沙丘' }), '沙丘 · 中文字幕 · N2PUcz');
});

test('subtitleId stays bounded and unique per subtitle', () => {
  const entry = { sid: 'abc123', title: '很长'.repeat(60) };
  const id = subtitleId(entry);
  assert.ok(id.length <= 60 + ' · 中文字幕 · abc123'.length);
  assert.ok(id.endsWith(' · abc123'));
  assert.notEqual(subtitleId({ ...entry, sid: 'def456' }), id);
});

// 同一条字幕按语言拆成好几条轨道，id 里不带语言就会撞车。
test('subtitleId keeps the language variants apart', () => {
  const ids = languageVariants({ sid: 'UKIN6L', workName: '越狱 第三季', languages: ['简体', '繁体'] })
    .map((variant) => subtitleId(variant.entry));

  assert.deepEqual(ids, ['越狱 第三季 · 简中 · UKIN6L', '越狱 第三季 · 繁中 · UKIN6L']);
});

// 站点标签说的是「这个包里有哪几种语言」，每种语言都该有一条轨道。
test('languageVariants lists every language the pack ships', () => {
  const simplified = languageVariants({ sid: 'UKIN6L', languages: ['简体', '繁体'] });
  assert.deepEqual(
    simplified.map((variant) => [variant.lang, languageText(variant.entry)]),
    [['zh-Hans', '简中'], ['zh-Hant', '繁中']],
  );

  const japanese = languageVariants({ sid: 'pQIBJk', languages: ['繁体', '日语'] });
  assert.deepEqual(
    japanese.map((variant) => [variant.lang, languageText(variant.entry)]),
    [['zh-Hant', '繁中'], ['ja', '日语']],
  );
});

// 「双语」= 一份文件里中英都有，外文不用再列一条（列了也是同一份文件）。
test('languageVariants does not split a bilingual file', () => {
  const variants = languageVariants({ sid: 'qTcrY3', languages: ['双语', '简体', '英语'] });
  assert.equal(variants.length, 1);
  assert.equal(variants[0].lang, 'zh-Hans');
  assert.equal(languageText(variants[0].entry), '简英双语');
});

// 简繁各一份、而且都带英文的包：两条轨道都要说清自己是哪一种。
test('languageVariants names the script on a bilingual pack', () => {
  const variants = languageVariants({ sid: 'LKla6p', languages: ['双语', '简体', '繁体'] });
  assert.deepEqual(
    variants.map((variant) => [variant.lang, languageText(variant.entry)]),
    [['zh-Hans', '简英双语'], ['zh-Hant', '繁英双语']],
  );
});

test('languageVariants falls back to one plain track', () => {
  const entry = { sid: 'abc123', languages: [] };
  assert.deepEqual(languageVariants(entry), [{ lang: null, entry }]);
});
