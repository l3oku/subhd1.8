import assert from 'node:assert/strict';
import test from 'node:test';

// Configure the local HTTP stub before loading either provider.
process.env.ASSRT_TOKEN = '';
process.env.THUNDER_PROXY_URL = '';
process.env.THUNDER_API_BASE = 'https://thunder.test';
process.env.ASSRT_DOMAINS = 'assrt.test';
const { thunderSubtitles } = await import('../src/thunder.js');
const { assrtSubtitles } = await import('../src/assrt.js');

function stub(t, { name, year, rows, queriedRows = () => rows }) {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'v3-cinemeta.strem.io') {
      return Response.json({ meta: { name, releaseInfo: String(year) } });
    }
    if (url.hostname === 'thunder.test') {
      const records = queriedRows(url.searchParams.get('name'));
      return Response.json({ code: 0, data: records.map(({ id, title, version, filename, work }) => ({
        gcid: String(id), name: filename || `${version || title}.srt`, url: `https://cdn.test/${id}.srt`,
        simple_name: `简体[SRT]${work || title}`, languages: ['简体'], ext: 'srt',
      })) });
    }
    if (url.hostname === 'assrt.test' && url.pathname === '/sub/') {
      return new Response(rows.map(({ id, title, version = '', filename = '' }) => `
        <div onmouseover="addclass(this,'subitem_hover')">
          <a class="introtitle" href="/xml/sub/0/${id}.xml" title="${title}"></a>
          <span>版本：<b>${version}</b></span><span>格式：SRT</span><span>语言：简</span>
          ${filename ? `<a href="/download/${id}/${filename}">下载</a>` : ''}
        </div>`).join(''));
    }
    assert.fail(`unexpected request: ${url}`);
  });
}

const baseUrl = 'https://addon.test';
const ids = (tracks) => tracks.map(({ id }) => Number(id.split('-').at(-1))).sort((a, b) => a - b);

for (const [source, list] of [['Thunder', thunderSubtitles], ['ASSRT', assrtSubtitles]]) {
  test(`${source}: returns no tracks when every hit fails identity`, async (t) => {
    stub(t, { name: 'The Greatest', year: 2026, rows: [
      { id: 1, title: 'The Greatest (2024)', version: 'The.Greatest.2024', work: 'The Greatest (2026)' },
      { id: 2, title: 'The Greatest S01E01', version: 'The.Greatest.S01E01' },
      { id: 3, title: 'The Greatest Tomb on Earth', version: 'The.Greatest.Tomb.on.Earth.2026' },
      { id: 4, title: 'Sia - The Greatest', version: 'Sia.The.Greatest.2026' },
    ] });
    assert.deepEqual(await list({ type: 'movie', id: 'tt900001', baseUrl }), []);
  });

  test(`${source}: keeps English and Chinese alias tracks, rejects title and episode conflicts`, async (t) => {
    stub(t, { name: 'Prison Break', year: 2005, rows: [
      { id: 10, title: 'Prison Break S01E01', version: 'Prison.Break.S01E01.1080p' },
      { id: 11, title: '越狱第1集', version: '越狱第1集', work: '越狱(2005)' },
      { id: 12, title: 'Other Show S01E01', version: 'Other.Show.S01E01', work: 'Prison Break (2005)' },
      { id: 13, title: 'Prison Break S01E01', version: 'Prison.Break.S01E02', filename: 'Prison.Break.S01E02.srt' },
      { id: 14, title: 'Prison Break 2x01', version: 'Prison.Break.2x01' },
      { id: 15, title: 'Prison Break S01 Complete', version: 'Prison.Break.S01.Complete' },
      { id: 16, title: 'Wrong Show / Prison Break S01E01', version: 'Prison.Break.S01E01', filename: 'Wrong.Show.S01E01.srt' },
      { id: 17, title: '越狱1', version: '越狱1' },
      { id: 18, title: '越狱2', version: '越狱2' },
      { id: 19, title: 'Prison Break (2005) S01E01', version: 'Prison.Break.2002.S01E01' },
    ] });
    const tracks = await list({ type: 'series', id: 'tt900002:1:1', baseUrl });
    assert.deepEqual(ids(tracks), [10, 11, 15, 17]);
    const chinese = tracks.find(({ id }) => id.endsWith('-11'));
    assert.match(chinese.label, /越狱/);
    assert.match(chinese.url, /^https:\/\/addon\.test\//);
  });
}

test('Thunder: query choice counts screened hits and screens refinement', async (t) => {
  const wrong = Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, title: 'Friends S02E01' }));
  const good = { id: 42, title: 'Friends S01E01', work: '老友记(1994)' };
  const queries = [];
  stub(t, { name: 'Friends', year: 1994, queriedRows(query) {
    queries.push(query);
    if (query === 'Friends') return [good];
    return wrong;
  } });
  const tracks = await thunderSubtitles({ type: 'series', id: 'tt900003:1:1', baseUrl });
  assert.deepEqual(ids(tracks), [42]);
  assert.ok(queries.includes('Friends'));
  assert.ok(queries.includes('老友记 S01E01'));
});
