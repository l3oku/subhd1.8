import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasesFor } from '../src/aliases.js';
import { matchAssrtRow, parseAssrtSearch } from '../src/assrt.js';
import { selectThunderRows } from '../src/thunder.js';

const show = { titles: ['Friends'], aliases: ['老友记'], type: 'series', year: 1994, season: 2, episode: 4 };
const thunder = (key, name, title) => ({ name, simple_name: `简体[SRT]${title}`, url: `https://example.test/${key}` });

test('Thunder continues after a large nonempty wrong batch and ranks exact rows before verified packs', async () => {
  const wrong = Array.from({ length: 10 }, (_, n) => thunder(n, 'Friends.S02E03.srt', 'Friends'));
  const wrongTitle = thunder('different', 'Other.Show.S02E04.srt', 'Friends');
  const exact = thunder('exact', 'Friends.S02E04.srt', '无标题');
  const pack = thunder('pack', 'Friends.S02E01-E12.zip', '老友记 第二季');
  const queries = [];
  const picked = await selectThunderRows(['a', 'b', 'c'], show, async (q) => {
    queries.push(q);
    return q === 'a' ? [...wrong, wrongTitle] : q === 'b' ? [pack] : [exact, pack];
  });
  assert.deepEqual(queries, ['a', 'b', 'c']);
  assert.deepEqual(picked, [exact, pack]);
  assert.deepEqual(await selectThunderRows(['a'], show, async () => [...wrong, wrongTitle]), []);
  assert.deepEqual(await selectThunderRows(['a'], { ...show, episode: 13 }, async () => [pack]), []);
});

test('Thunder accepts a short exact filename but never bypasses clear movie conflicts', async () => {
  const want = { titles: ['Dune'], aliases: ['沙丘'], type: 'movie', year: 2021 };
  const valid = thunder('valid', '沙丘.srt', 'Dune (2021)');
  const bad = [thunder('old', '沙丘.1984.srt', 'Dune (2021)'), thunder('sequel', '沙丘2.srt', 'Dune'),
    thunder('series', 'Dune.S01E01.srt', 'Dune'), thunder('music', 'Dune.MV.srt', 'Dune')];
  assert.deepEqual(await selectThunderRows(['a'], want, async () => [...bad, valid]), [valid]);
});

test('ASSRT accepts either strong field, not release metadata alone, and detects cross-field conflicts', () => {
  assert.equal(matchAssrtRow({ title: '友人', filename: 'Friends.S02E04.zip' }, show)?.rank, 0);
  assert.equal(matchAssrtRow({ title: 'Friends / 老友记 第二季', filename: 'S02.1995.zip' }, show)?.rank, 3);
  assert.equal(matchAssrtRow({ title: 'Friends S01-S03 Complete', filename: '' }, show)?.rank, 3);
  assert.equal(matchAssrtRow({ title: 'Friends S03-S04 Complete', filename: '' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Friends Sex and Games', filename: 'Friends.S02E04.zip' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Other Show S02E04', filename: 'Friends.S02E04.zip' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Other Show', version: 'Friends.S02E04' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Friends 第二季合集', filename: 'Friends.S02E03.zip' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Friends S02E04 / Friends S01E04' }, show), null);
  assert.equal(matchAssrtRow({ title: 'Friends S02E04', version: 'Friends.S02E03' }, show), null);
});

test('ASSRT real 12 12 12 result title and download filename shapes', () => {
  const records = [
    ['803471', '12 12 12 S01E01/刑侦12/12.12.12.S01E01.1080p.WEB.h264-ETHEL', '12.12.12.S01E01.1080p.WEB.h264-ETHEL'],
    ['803476', '12 12 12 S01E02/刑侦12/12.12.12.S01E02.1080p.WEB.h264-ETHEL', '12.12.12.S01E02.1080p.WEB.h264-ETHEL'],
    ['803667', '刑侦12/12 12 12 S01E03 Einfach Obergeil 1080p ATVP WEB-DL DDP5 1 Atmos H 264-FLUX', '12 12 12 S01E03 Einfach Obergeil 1080p ATVP WEB-DL DDP5 1 Atmos H 264-FLUX'],
  ];
  const html = records.map(([id, title, version]) => `<div onmouseover="addclass(this,'subitem_hover')" class="subitem"><a class="introtitle" href="/xml/sub/803/${id}.xml" title="${title}"></a><span>版本：<b>${version}</b></span><a onclick="javascript:location.href='/download/${id}/${encodeURIComponent(version)}.zip'">下载</a></div>`).join('');
  const { items } = parseAssrtSearch(html);
  assert.equal(items.length, records.length);
  for (const episode of [1, 2, 3, 4]) {
    const want = { titles: ['12 12 12'], aliases: aliasesFor('12 12 12'), type: 'series', season: 1, episode, year: 2026 };
    assert.deepEqual(items.filter((item) => matchAssrtRow(item, want)).map(({ id }) => id), episode <= 3 ? [records[episode - 1][0]] : []);
  }
});
