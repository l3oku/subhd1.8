import assert from 'node:assert/strict';
import test from 'node:test';

import { isImageEntry, preferredExt, subtitleMeta, subtitleTrack, usableEntry } from '../src/addon.js';
import {
  caches,
  getSubtitleBinary,
  getSubtitleText,
  noteOnly,
  noteSubtitle,
  pickImageSubtitleFile,
  shareNote,
} from '../src/subhd.js';

// 站点上的 SUP/PGS 是图形字幕（一帧帧图片）：Stremio 的文本渲染器画不出来，但 mpv
// 这类播放器能直接放，所以列表里也留着，只是要写明白，并且允许关掉。
test('usableEntry keeps image subtitles unless they are turned off', () => {
  assert.equal(usableEntry({ formats: ['SUP'] }), true);
  assert.equal(usableEntry({ formats: ['PGS'] }), true);
  assert.equal(usableEntry({ formats: ['SUP'] }, { includeImage: false }), false);
  // 包里同时有文本时按文本走，跟以前一样
  assert.equal(usableEntry({ formats: ['SRT', 'SUP'] }), true);
  assert.equal(usableEntry({ formats: ['SRT', 'SUP'] }, { includeImage: false }), true);
});

test('usableEntry still drops packs that cannot be one subtitle file', () => {
  // VobSub 要 .idx + .sub 一对，MKS 是 Matroska 容器，都拼不成一条字幕直链
  assert.equal(usableEntry({ formats: ['SUB', 'IDX'] }), false);
  assert.equal(usableEntry({ formats: ['MKS'] }), false);
  assert.equal(usableEntry({ formats: ['SUP', 'MKS'] }), false);
  assert.equal(usableEntry({ formats: [] }), true);
});

test('image entries are served as sup and marked on the row', () => {
  assert.equal(isImageEntry({ formats: ['SUP', 'PGS'] }), true);
  assert.equal(isImageEntry({ formats: ['SRT', 'SUP'] }), false);
  assert.equal(preferredExt({ formats: ['SUP'] }), 'sup');
  assert.equal(preferredExt({ formats: ['SRT', 'SUP'] }), 'srt');
  assert.equal(subtitleMeta({ languages: ['简体'], formats: ['SUP'] }), '简中 · SUP · 图形字幕');
});

test('pickImageSubtitleFile picks the sup and follows the language', () => {
  const files = [
    { name: 'Dune.2021.1080p.zh-Hans.sup', data: Buffer.from('a') },
    { name: 'Dune.2021.1080p.zh-Hant.sup', data: Buffer.from('b') },
    { name: 'Dune.2021.1080p.srt', data: Buffer.from('c') },
  ];

  assert.equal(pickImageSubtitleFile(files, { lang: 'zh-Hans' }).name, files[0].name);
  assert.equal(pickImageSubtitleFile(files, { lang: 'zh-Hant' }).name, files[1].name);
  // 文本轨道走的是另一条路，这里只认图形字幕，包里没有就返回 null
  assert.equal(pickImageSubtitleFile([files[2]]), null);
  assert.equal(pickImageSubtitleFile([]), null);
});

// 和语言那几组测试一样，预先把文件塞进 fileCache，端到端跑一遍也不用碰网络。
const PGS = Buffer.concat([Buffer.from('PG'), Buffer.alloc(64, 0x42)]);

test('getSubtitleBinary hands the sup file over untouched', async () => {
  caches.fileCache.set('file:SUPMOV', { raw: PGS, filename: 'Dune.2021.1080p.sup' });

  const result = await getSubtitleBinary('SUPMOV');
  assert.deepEqual(result.data, PGS);
  assert.equal(result.ext, 'sup');
  assert.equal(result.sourceName, 'Dune.2021.1080p.sup');
});

test('getSubtitleBinary refuses a pack that carries no image subtitle', async () => {
  caches.fileCache.set('file:SUPTXT', { raw: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n'), filename: 'Dune.srt' });

  await assert.rejects(() => getSubtitleBinary('SUPTXT'), /不是图形字幕/);
});

// 站上有一类「假字幕包」：包里只有一份网盘分享说明。挑不出字幕是必然的，但把说明里的
// 链接带出来，用户才知道该去哪拿 —— 只说「包里没有 .sup」等于什么都没说。
const PAN_NOTE =
  '通过网盘分享的文件：哈利·波特5：凤凰社字幕文件(匹配02.18.13).7z\n' +
  '链接: https://pan.baidu.com/s/1WM17aSh3J8fv3nK7HjOsjQ?pwd=fc9g 提取码: fc9g\n';

test('shareNote digs the share link out of a note-only pack', () => {
  assert.equal(
    shareNote([{ name: '说明.txt', data: Buffer.from(PAN_NOTE, 'utf8') }]),
    'https://pan.baidu.com/s/1WM17aSh3J8fv3nK7HjOsjQ?pwd=fc9g',
  );
  assert.equal(shareNote([{ name: 'movie.sup', data: Buffer.from('PG') }]), null);
  assert.equal(shareNote([]), null);
  assert.equal(shareNote(undefined), null);
});

test('noteOnly only fires when the pack has nothing but the note', () => {
  const note = Buffer.from(PAN_NOTE, 'utf8');

  assert.equal(noteOnly([{ name: '说明.txt', data: note }]), 'https://pan.baidu.com/s/1WM17aSh3J8fv3nK7HjOsjQ?pwd=fc9g');
  // 真字幕包里顺手夹一份说明很正常，别把它当成假包
  assert.equal(noteOnly([{ name: 'movie.srt', data: Buffer.from('1\n') }, { name: '说明.txt', data: note }]), null);
  assert.equal(noteOnly([{ name: '说明.txt', data: Buffer.from('没有链接的说明') }]), null);
  assert.equal(noteOnly([]), null);
});

test('the note is served as a subtitle that stays on screen', () => {
  const text = noteSubtitle('https://pan.baidu.com/s/x');
  assert.match(text, /^1\n00:00:00,000 --> 99:59:59,000\n/);
  assert.match(text, /https:\/\/pan\.baidu\.com\/s\/x/);
});

// Stremio 不显示失败的响应体：报 415 用户只会觉得「点了没反应」。所以假包按文本字幕发出去，
// 链接直接写在画面里，同时记下 sid，下次列字幕就能在第二行提示（见 subtitleTrack）。
test('getSubtitleBinary turns a note-only pack into a link subtitle', async () => {
  caches.fileCache.set('file:SUPNOTE', {
    raw: Buffer.from(PAN_NOTE, 'utf8'),
    filename: '凤凰社特效字幕.txt',
  });

  const result = await getSubtitleBinary('SUPNOTE');
  assert.equal(result.note, true);
  assert.equal(result.ext, 'srt');
  assert.match(result.text, /https:\/\/pan\.baidu\.com\/s\/1WM17aSh3J8fv3nK7HjOsjQ\?pwd=fc9g/);
  // 顺手记住，列表才提示得出来
  assert.equal(caches.noteCache.get('note:SUPNOTE'), 'https://pan.baidu.com/s/1WM17aSh3J8fv3nK7HjOsjQ?pwd=fc9g');
});

test('getSubtitleText serves the note instead of the raw txt', async () => {
  caches.fileCache.set('file:SUPNOTE2', {
    raw: Buffer.from(PAN_NOTE, 'utf8'),
    filename: '说明.txt',
  });

  const result = await getSubtitleText('SUPNOTE2');
  assert.equal(result.note, true);
  assert.equal(result.ext, 'srt');
  assert.match(result.text, /去这里拿：\nhttps:\/\/pan\.baidu\.com\/s\//);
});

test('a known stub pack is listed as a note track', () => {
  caches.noteCache.set('note:Aep3Ts', 'https://pan.baidu.com/s/abc', 5000);

  const track = subtitleTrack(
    { sid: 'Aep3Ts', formats: ['SUP'], languages: ['简体'], title: '哈利波特与凤凰社' },
    { baseUrl: 'https://subhd.vercel.app' },
  );
  // 后缀换成 srt：点开才会被当成文本字幕，播放器才画得出链接
  assert.equal(track.url, 'https://subhd.vercel.app/sub/Aep3Ts.srt');
  assert.equal(track.lang, '只有网盘分享链接：https://pan.baidu.com/s/abc');

  const normal = subtitleTrack(
    { sid: 'FpP3pG', formats: ['SUP'], languages: ['简体'], title: '哈利波特与凤凰社' },
    { baseUrl: 'https://subhd.vercel.app' },
  );
  assert.equal(normal.url, 'https://subhd.vercel.app/sub/FpP3pG.sup');
});
