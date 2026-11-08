import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanTitle,
  extOf,
  isWantedEpisode,
  parseSimpleName,
  thunderEntry,
  thunderLanguage,
  thunderTrack,
  titleScore,
  titleVariants,
} from '../src/thunder.js';

test('parseSimpleName splits language / format / work / year', () => {
  assert.deepEqual(parseSimpleName('简体[SRT]沙丘2(2024)'), {
    language: '简体',
    ext: 'SRT',
    work: '沙丘2',
    year: 2024,
  });
  // 拆不出来时整串当作品名
  assert.equal(parseSimpleName('随便一个名字').work, '随便一个名字');
});

test('thunderLanguage maps the site tags onto Stremio lang codes', () => {
  assert.equal(thunderLanguage(['简体']).code, 'zh');
  assert.equal(thunderLanguage(['繁體']).code, 'zh-Hant');
  assert.equal(thunderLanguage(['繁体']).label, '繁体');
  assert.equal(thunderLanguage(['中英']).label, '中英双语');
  assert.equal(thunderLanguage(['简体', '英语']).label, '简体/英语');
  assert.equal(thunderLanguage(['English']).code, 'en');
});

// 迅雷的英文名查询会把整个系列拉回来：Dune: Part Two 拿到了 2021 年的沙丘。
test('titleScore drops results whose year disagrees', () => {
  const dune2021 = { name: 'Dune.2021.1080p.HDRip.X264.AC3-EVO.srt', simple_name: '繁体[SRT]沙丘(2021)' };
  assert.equal(titleScore(dune2021, 'Dune: Part Two', 2024), 0);

  const partTwo = {
    name: 'Dune.Part.Two.2024.1080p.WEB-DL.H264.AAC.srt',
    simple_name: '简体[SRT]沙丘2(2024)',
  };
  assert.ok(titleScore(partTwo, 'Dune: Part Two', 2024) > 1);
  // 名字里没写年份时只看片名（片名要完整出现）
  assert.ok(titleScore({ name: 'Dune.Part.Two.2024.srt' }, 'Dune Part Two', 2024) > 0);
  // 「Sia - The Greatest」这种：片名前面还有别的词，不是那部片
  assert.equal(titleScore({ name: 'Sia - The Greatest.SRT' }, 'The Greatest', 2026), 0);
});

test('titleScore needs every meaningful word of the title', () => {
  assert.equal(titleScore({ name: 'Dune.srt' }, 'Dune: Part Two', null), 0);
});

test('isWantedEpisode understands S01E01 / 1x01 / 第1集 and refuses ranges', () => {
  const want = { season: 2, episode: 3 };
  assert.ok(isWantedEpisode({ name: 'Show.S02E03.1080p.mkv.srt' }, want));
  assert.ok(isWantedEpisode({ name: '剧名 2x3.ass' }, want));
  assert.ok(isWantedEpisode({ name: '第3集.srt' }, want));
  assert.ok(!isWantedEpisode({ name: 'Show.S02E04.srt' }, want));
  assert.ok(!isWantedEpisode({ name: '2048.srt' }, { season: 2, episode: 0 }));
});

test('titleVariants adds the year and strips the subtitle colon', () => {
  const names = titleVariants('Dune: Part Two', 2024);
  assert.ok(names.includes('Dune: Part Two 2024'));
  assert.ok(names.includes('Dune Part Two'));
  assert.equal(cleanTitle('Stranger Things (2016)'), 'Stranger Things');
});

test('extOf prefers the item ext and falls back to the file name', () => {
  assert.equal(extOf({ ext: 'ass', name: 'x.srt' }), 'ass');
  assert.equal(extOf({ name: 'x.srt' }), 'srt');
  assert.equal(extOf({ name: 'x.WEBRip.srt', simple_name: '繁体[ASS]沙丘(2021)' }), 'srt');
  assert.equal(extOf({ ext: 'exe' }), 'srt');
});

test('thunderEntry + thunderTrack produce a SubHD-shaped track', () => {
  const item = {
    gcid: 'ABCDEF123456',
    url: 'https://subtitle.v.geilijiasu.com/AB/CD/ABCDEF123456.srt',
    ext: 'srt',
    name: 'Show.S02E03.1080p.chs.srt',
    simple_name: '简体[SRT]剧名(2024)',
    languages: ['简体'],
    duration: 1000,
  };
  const entry = thunderEntry(item, { title: '剧名', year: 2024, season: 2, episode: 3 });
  assert.equal(entry.source, 'thunder');
  assert.equal(entry.fileUrl, item.url);
  assert.equal(entry.episode, 3);

  const track = thunderTrack(entry, { baseUrl: 'http://addon.test', season: 2, episode: 3 });
  // 走自己的代理路由：base64url 里就是那条直链
  const encoded = track.url.split('/thunder/')[1].split('.')[0];
  assert.equal(Buffer.from(encoded, 'base64url').toString(), item.url);
  assert.match(track.label, /剧名/);
  assert.match(track.label, /S02E03/);
  assert.match(track.lang, /简体 · 迅雷 · SRT/);
  assert.match(track.id, /thunder-ABCDEF123456$/);
});
