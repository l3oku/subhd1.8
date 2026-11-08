import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import { caches, getSubtitleText } from '../src/subhd.js';

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

// 压缩包里的文件名照抄真实 SubHD 包，端到端跑一遍 getSubtitleText：预先把文件塞进
// fileCache 就不会碰网络（下载接口限流时也一样测得动）。
const SIMPLIFIED = '1\n00:00:01,000 --> 00:00:02,000\n这里的简体字幕\n';
const TRADITIONAL = '1\n00:00:01,000 --> 00:00:02,000\n這裡的繁體字幕\n';
const JAPANESE = '1\n00:00:01,000 --> 00:00:02,000\nここは日本語の字幕\n';

function seed(sid, files) {
  caches.fileCache.set(`file:${sid}`, { raw: buildZip(files), filename: `${sid}.zip` });
}

const netflixHans = '越狱.S03E04.第4集.WEBRip.Netflix.zh-Hans.srt';
const netflixHant = '越狱.S03E04.第4集.WEBRip.Netflix.zh-Hant.srt';

test('getSubtitleText serves the script the track asked for', async () => {
  seed('NETFLIX', [
    { name: netflixHans, content: SIMPLIFIED },
    { name: netflixHant, content: TRADITIONAL },
  ]);

  const hans = await getSubtitleText('NETFLIX', {
    targetExt: 'srt',
    season: 3,
    episode: 4,
    lang: 'zh-Hans',
  });
  const hant = await getSubtitleText('NETFLIX', {
    targetExt: 'srt',
    season: 3,
    episode: 4,
    lang: 'zh-Hant',
  });

  assert.equal(hans.sourceName, netflixHans);
  assert.equal(hans.text, SIMPLIFIED);
  assert.equal(hant.sourceName, netflixHant);
  assert.equal(hant.text, TRADITIONAL);
  // 同一条字幕、同一个压缩包，靠 lang 分出两份文件
  assert.notEqual(hans.text, hant.text);
});

test('getSubtitleText gives the unmarked file to the simplified track', async () => {
  const hantName = 'Prison.Break.S03E04.1080p.BluRay.x264-SECTOR7 .繁体&英文.srt';
  const plainName = 'Prison.Break.S03E04.1080p.BluRay.x264-SECTOR7.srt';
  seed('YYETS', [
    { name: hantName, content: TRADITIONAL },
    { name: plainName, content: SIMPLIFIED },
  ]);

  const hant = await getSubtitleText('YYETS', {
    targetExt: 'srt',
    season: 3,
    episode: 4,
    lang: 'zh-Hant',
  });
  const hans = await getSubtitleText('YYETS', {
    targetExt: 'srt',
    season: 3,
    episode: 4,
    lang: 'zh-Hans',
  });

  assert.equal(hant.sourceName, hantName);
  assert.equal(hant.text, TRADITIONAL);
  assert.equal(hans.sourceName, plainName);
  assert.equal(hans.text, SIMPLIFIED);
});

test('getSubtitleText hands the Japanese file to the Japanese track', async () => {
  const jaName = 'Yugure.ni.Te.wo.Tsunagu.S01E03.WEB-DL.KKTV.ja.srt';
  const hantName = 'Yugure.ni.Te.wo.Tsunagu.S01E03.WEB-DL.KKTV.zh-Hant.srt';
  seed('KKTV', [
    { name: jaName, content: JAPANESE },
    { name: hantName, content: TRADITIONAL },
  ]);

  const ja = await getSubtitleText('KKTV', {
    targetExt: 'srt',
    season: 1,
    episode: 3,
    lang: 'ja',
  });
  const hant = await getSubtitleText('KKTV', {
    targetExt: 'srt',
    season: 1,
    episode: 3,
    lang: 'zh-Hant',
  });

  assert.equal(ja.sourceName, jaName);
  assert.equal(ja.text, JAPANESE);
  assert.equal(ja.language, 'ja');
  assert.equal(hant.sourceName, hantName);
  assert.equal(hant.text, TRADITIONAL);
});
